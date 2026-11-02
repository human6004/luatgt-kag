import { createContext, useCallback, useContext, useRef, useState } from 'react'

export type DocStatus = 'Chờ xử lý' | 'Đang xử lý' | 'Chờ duyệt' | 'Đã lập chỉ mục' | 'Lưu trữ' | 'Lỗi'
export interface LegalDoc {
  id: string
  name: string
  type: 'Luật' | 'Nghị định' | 'Thông tư' | 'Quyết định'
  effective: string
  status: DocStatus
  chunks: number
  entities: number
  step: number
  updated: string
}

export type JobStatus = 'queued' | 'running' | 'success' | 'failed' | 'cancelled'
export interface Job {
  id: string
  taskId: string
  title: string
  command: string
  status: JobStatus
  progress: number
  logs: string[]
  startedAt: string
  duration?: number
}

export interface QBankItem {
  id: string
  chapter: string
  question: string
  options: string[]
  answer: number
  critical: boolean
  explanation: string
  source: string
}

export interface ChatLog {
  id: string
  user: string
  question: string
  answer: string
  latency: number
  feedback: 'up' | 'down' | null
  status: 'Đã trả lời' | 'Không có căn cứ' | 'Phản hồi sai' | 'Văn bản hết hiệu lực'
  resolved: boolean
  time: string
}

export interface AppUser {
  id: string
  name: string
  email: string
  role: 'Người học' | 'Biên tập viên' | 'Cảnh sát' | 'Quản trị viên'
  licenseClass: string
  questions: number
  active: boolean
  joined: string
}

interface TaskDef {
  id: string
  title: string
  command: string
  steps: string[]
}

const tasks: TaskDef[] = [
  {
    id: 'docker-build', title: 'Build image riêng', command: 'deploy/build.sh',
    steps: ['Đọc deploy/.env', 'Build kag-legal-mysql (FROM openspg-mysql)', 'Build kag-legal-neo4j + restore-entrypoint', 'Build kag-legal-minio', 'Build kag-legal-server + start.sh', 'Build kag-legal-app (python:3.10-slim)', 'Build kag-legal-web (node → nginx)', 'Gắn tag ${TAG} ✓'],
  },
  {
    id: 'docker-pack', title: 'Đóng gói để chia sẻ', command: 'deploy/pack.sh',
    steps: ['docker compose config --images', 'docker save | gzip → images/kag-legal.tar.gz', 'Chép docker-compose.yml, env.example, install.sh/.ps1', 'Kèm dumps/legal.dump', 'Bỏ khối build: khỏi compose', 'Sinh SHA256SUMS', 'Ghi dist/kag-legal-bundle.tar.gz ✓'],
  },
  {
    id: 'eval', title: 'Chạy bộ câu hỏi kiểm thử', command: 'python solver/eval.py',
    steps: ['Tải bộ câu hỏi', 'Khởi tạo solver pipeline', 'Truy vấn KAG (thread_num)', 'Chuẩn hoá NFC & markdown', 'Tính hit_rate / hit_all', 'Ghi runs/benchmark.txt'],
  },
  {
    id: 'benchmark', title: 'So sánh KAG vs HybridRAG', command: 'python -m benchmark.evaluator.evaluate',
    steps: ['Load final_150_corpus_verified.json (150 câu)', 'Runner kag_runner → benchmark/runs/kag.json', 'Runner hybridrag_runner → hybridrag.json', 'Runner nativerag_runner → nativerag.json', 'citation_parser: parse citations từ answer', 'retrieval / citation / answer / grounding / abstention metrics', 'Bootstrap CI & aggregate', 'Ghi report.json'],
  },
]

const now = () => new Date().toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' })

const seedDocs: LegalDoc[] = [
  { id: 'd1', name: 'Nghị định 168/2024/NĐ-CP', type: 'Nghị định', effective: '01/01/2025', status: 'Đã lập chỉ mục', chunks: 412, entities: 2381, step: 5, updated: '28/09 14:02' },
  { id: 'd2', name: 'Luật Trật tự, an toàn giao thông đường bộ 2024', type: 'Luật', effective: '01/01/2025', status: 'Đã lập chỉ mục', chunks: 296, entities: 1740, step: 5, updated: '27/09 09:15' },
  { id: 'd3', name: 'Thông tư 35/2024/TT-BGTVT (sát hạch GPLX)', type: 'Thông tư', effective: '01/01/2025', status: 'Chờ duyệt', chunks: 188, entities: 902, step: 3, updated: '30/09 16:40' },
  { id: 'd4', name: 'Nghị định 100/2019/NĐ-CP', type: 'Nghị định', effective: 'Hết hiệu lực', status: 'Lưu trữ', chunks: 350, entities: 2011, step: 5, updated: '02/01 08:00' },
]

interface Store {
  docs: LegalDoc[]
  setDocs: React.Dispatch<React.SetStateAction<LegalDoc[]>>
  jobs: Job[]
  runTask: (taskId: string, opts?: { label?: string; onDone?: () => void }) => string
  toast: string | null
  notify: (msg: string) => void
}

const Ctx = createContext<Store | null>(null)

export function AdminProvider({ children }: { children: React.ReactNode }) {
  const [docs, setDocs] = useState(seedDocs)
  const [jobs, setJobs] = useState<Job[]>([
    { id: 'j0', taskId: 'eval', title: 'Chạy bộ câu hỏi kiểm thử', command: 'python solver/eval.py', status: 'success', progress: 100, logs: ['hit@20 = 0.861 (143/166)'], startedAt: '29/09 22:10', duration: 412 },
  ])
  const [toast, setToast] = useState<string | null>(null)
  const timers = useRef<Record<string, number>>({})
  const toastTimer = useRef<number | undefined>(undefined)

  const notify = useCallback((msg: string) => {
    setToast(msg)
    window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), 2600)
  }, [])

  const runTask: Store['runTask'] = useCallback((taskId, opts) => {
    const def = tasks.find((t) => t.id === taskId)!
    const id = 'j' + Date.now()
    const start = Date.now()
    const command = opts?.label ? `${def.command} ${opts.label}` : def.command
    setJobs((js) => [{ id, taskId, title: def.title, command, status: 'running', progress: 0, logs: [`$ ${command}`], startedAt: now() }, ...js])
    let i = 0
    timers.current[id] = window.setInterval(() => {
      const line = def.steps[i]
      i++
      const done = i >= def.steps.length
      setJobs((js) =>
        js.map((j) => {
          if (j.id !== id || j.status !== 'running') return j
          const ts = new Date().toLocaleTimeString('vi-VN')
          return {
            ...j,
            progress: Math.round((i / def.steps.length) * 100),
            logs: [...j.logs, `[${ts}] ${line}`, ...(done ? [`✓ Hoàn tất trong ${Math.round((Date.now() - start) / 1000)}s`] : [])],
            status: done ? 'success' : 'running',
            duration: done ? Math.round((Date.now() - start) / 1000) : undefined,
          }
        })
      )
      if (done) {
        window.clearInterval(timers.current[id])
        opts?.onDone?.()
      }
    }, 700)
    return id
  }, [])

  return (
    <Ctx.Provider value={{ docs, setDocs, jobs, runTask, toast, notify }}>
      {children}
    </Ctx.Provider>
  )
}

export function useAdmin() {
  const c = useContext(Ctx)
  if (!c) throw new Error('useAdmin outside AdminProvider')
  return c
}
