import { createContext, useCallback, useContext, useRef, useState } from 'react'

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

interface Store {
  jobs: Job[]
  runTask: (taskId: string, opts?: { label?: string; onDone?: () => void }) => string
  toast: string | null
  notify: (msg: string) => void
}

const Ctx = createContext<Store | null>(null)

export function AdminProvider({ children }: { children: React.ReactNode }) {
  const [jobs, setJobs] = useState<Job[]>([])
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
    <Ctx.Provider value={{ jobs, runTask, toast, notify }}>
      {children}
    </Ctx.Provider>
  )
}

export function useAdmin() {
  const c = useContext(Ctx)
  if (!c) throw new Error('useAdmin outside AdminProvider')
  return c
}
