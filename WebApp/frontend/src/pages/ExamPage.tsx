import { api, send } from '../api'
import { useAdmin } from '../admin/store'
import { Asset, Notice, useData, useTask } from './server/shared'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Badge, Button, Modal } from '../admin/ui'

/* ---------- Cấu trúc đề theo hạng (Thông tư 35/2024/TT-BGTVT, bộ 600 câu) ---------- */
type ClassId = 'A1' | 'A' | 'B1' | 'B' | 'C1' | 'C'
const CLASSES: Record<ClassId, { label: string; desc: string; total: number; minutes: number; pass: number }> = {
  A1: { label: 'A1', desc: 'Mô tô đến 125 cm³', total: 25, minutes: 19, pass: 21 },
  A: { label: 'A', desc: 'Mô tô trên 125 cm³', total: 25, minutes: 19, pass: 23 },
  B1: { label: 'B1', desc: 'Xe ba bánh', total: 25, minutes: 19, pass: 23 },
  B: { label: 'B', desc: 'Ô tô con đến 8 chỗ', total: 30, minutes: 20, pass: 27 },
  C1: { label: 'C1', desc: 'Tải 3,5 – 7,5 tấn', total: 35, minutes: 22, pass: 32 },
  C: { label: 'C · D · E', desc: 'Tải nặng, khách', total: 45, minutes: 26, pass: 41 },
}

interface Q {
  id: number
  chapter: string
  critical: boolean
  text: string
  options: string[]
  correct: number
  explain: string
  source: string
  questionId?: string
  imageKey?: string
}

interface HistoryItem {
  cls: ClassId
  label: string
  score: number
  total: number
  passed: boolean
  criticalFail: boolean
  at: string
}

type Phase = 'setup' | 'exam' | 'result'

type ServerExam = {
  id: string
  expiresAt: string
  serverTime: string
  questions: {
    questionId: string
    text: string
    options: string[]
    imageKey?: string
    correctAnswer?: number
    critical?: boolean
  }[]
  answers: Record<string, number>
  submittedAt: string | null
  score?: number
  passed?: boolean
  criticalFailed?: boolean
}

export default function ExamPage() {
  const [params, setParams] = useSearchParams()
  const { notify } = useAdmin()
  const task = useTask()
  const records = useData<{ id: string; startedAt: string; submittedAt: string | null; score: number | null; passed: boolean | null }[]>('/exams')

  const rawCls = params.get('cls')
  const cls: ClassId = rawCls && Object.prototype.hasOwnProperty.call(CLASSES, rawCls) ? (rawCls as ClassId) : 'B'

  const [server, setServer] = useState<ServerExam | null>(null)
  const [phase, setPhase] = useState<Phase>('setup')
  const [label, setLabel] = useState('')
  const [questions, setQuestions] = useState<Q[]>([])
  const [answers, setAnswers] = useState<Record<number, number>>({})
  const [flags, setFlags] = useState<Set<number>>(new Set())
  const [current, setCurrent] = useState(0)
  const [left, setLeft] = useState(0)
  const [confirm, setConfirm] = useState(false)

  function selectClass(nextCls: ClassId) {
    setParams((prev) => {
      const next = new URLSearchParams(prev)
      if (nextCls === 'B') next.delete('cls')
      else next.set('cls', nextCls)
      return next
    })
  }

  const history: HistoryItem[] = (records.value || [])
    .filter((r) => r.submittedAt)
    .map((r) => ({
      cls: 'B' as const,
      label: 'Đề ngẫu nhiên',
      score: r.score ?? 0,
      total: 30,
      passed: r.passed === true,
      criticalFail: false,
      at: new Date(r.startedAt).toLocaleString('vi-VN'),
    }))

  function accept(value: ServerExam) {
    setServer(value)
    sessionStorage.setItem('luatgt-active-exam', value.id)
    setQuestions(
      value.questions.map((q, i) => ({
        id: i + 1,
        questionId: q.questionId,
        text: q.text,
        options: q.options,
        correct: q.correctAnswer ?? -1,
        critical: q.critical === true,
        chapter: 'Bài thi sát hạch',
        explain: '',
        source: 'Ngân hàng câu hỏi đã xuất bản',
        imageKey: q.imageKey,
      })),
    )
    setAnswers(
      Object.fromEntries(
        value.questions.flatMap((q, i) => (value.answers[q.questionId] === undefined ? [] : [[i + 1, value.answers[q.questionId]]])),
      ),
    )
    setLeft(Math.max(0, Math.ceil((Date.parse(value.expiresAt) - Date.parse(value.serverTime)) / 1000)))
    setLabel('Đề ngẫu nhiên')
    setPhase(value.submittedAt ? 'result' : 'exam')
  }

  useEffect(() => {
    const id = sessionStorage.getItem('luatgt-active-exam')
    if (!id) return
    const controller = new AbortController()
    void task.run(async () => {
      const v = await api<ServerExam>(`/exams/${id}`, { signal: controller.signal })
      if (!controller.signal.aborted) accept(v)
    })
    return () => controller.abort()
  }, [])

  function startRandom() {
    if (task.busy) return
    if (cls !== 'B') {
      notify('Chức năng đang phát triển')
      return
    }
    void task.run(async () => {
      accept(await api<ServerExam>('/exams', send('POST')))
      setFlags(new Set())
      setCurrent(0)
    })
  }

  function choose(id: number, selected: number) {
    if (!server || task.busy || server.submittedAt || left <= 0) return
    const q = questions.find((item) => item.id === id)
    if (!q?.questionId) return
    void task.run(async () => {
      const v = await api<ServerExam>(`/exams/${server.id}/answers/${q.questionId}`, send('PUT', { selected }))
      accept(v)
    })
  }

  const result = useMemo(() => {
    const wrong = questions.filter((q) => answers[q.id] !== q.correct)
    const score = server?.score ?? 0
    const criticalFail = server?.criticalFailed === true
    return { wrong, score, criticalFail, passed: server?.passed === true }
  }, [questions, answers, server])

  const submit = useCallback(() => {
    if (task.busy || !server) return
    void task.run(async () => {
      accept(await api<ServerExam>(`/exams/${server.id}/submit`, send('POST')))
      setConfirm(false)
      records.reload()
    })
  }, [server, task.busy])

  // Đồng hồ — tự nộp khi hết giờ (giữ ngoài URL)
  useEffect(() => {
    if (phase !== 'exam') return
    const t = window.setInterval(() => setLeft((s) => Math.max(0, s - 1)), 1000)
    return () => window.clearInterval(t)
  }, [phase])

  useEffect(() => {
    if (phase === 'exam' && left === 0 && questions.length && !task.busy && !task.error) submit()
  }, [left, phase, questions.length, submit, task.busy, task.error])

  // Phím tắt
  useEffect(() => {
    if (phase !== 'exam' || confirm) return
    const q = questions[current]
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === 'INPUT') return
      const n = Number(e.key)
      if (n >= 1 && n <= q.options.length) choose(q.id, n - 1)
      else if (e.key === 'ArrowRight') setCurrent((c) => Math.min(questions.length - 1, c + 1))
      else if (e.key === 'ArrowLeft') setCurrent((c) => Math.max(0, c - 1))
      else if (e.key.toLowerCase() === 'f') toggleFlag(q.id)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [phase, confirm, current, questions, task.busy, server, left])

  const toggleFlag = (id: number) =>
    setFlags((f) => {
      const n = new Set(f)
      n.has(id) ? n.delete(id) : n.add(id)
      return n
    })

  if (phase === 'setup') {
    return (
      <>
        <div className="px-6 pt-3">
          <Notice error={task.error} />
          <Notice {...records} retry={records.reload} />
          {records.value
            ?.filter((r) => !r.submittedAt)
            .map((r) => (
              <Button
                key={r.id}
                disabled={task.busy}
                onClick={() =>
                  void task.run(async () => {
                    accept(await api<ServerExam>(`/exams/${r.id}`))
                    setCurrent(0)
                  })
                }
              >
                Tiếp tục bài thi {r.id}
              </Button>
            ))}
        </div>
        <Setup cls={cls} setCls={selectClass} startRandom={startRandom} notify={notify} history={history} />
      </>
    )
  }

  if (phase === 'result') {
    return (
      <Result
        cls="B"
        label={label}
        questions={questions}
        answers={answers}
        flags={flags}
        result={result}
        notify={notify}
        retry={() => {
          sessionStorage.removeItem('luatgt-active-exam')
          setPhase('setup')
          setServer(null)
        }}
      />
    )
  }

  const q = questions[current]
  const cfg = CLASSES.B
  const answered = Object.keys(answers).length
  const unanswered = questions.map((x, i) => (answers[x.id] === undefined ? i + 1 : 0)).filter(Boolean)
  const mm = String(Math.floor(left / 60)).padStart(2, '0')
  const ss = String(left % 60).padStart(2, '0')
  const urgent = left <= 60

  return (
    <div className="h-full overflow-y-auto bg-bg">
      <div className="px-6">
        <Notice error={task.error} />
      </div>
      <div className="mx-auto max-w-6xl px-4 sm:px-6 py-6 xl:grid xl:grid-cols-[minmax(0,1fr)_300px] xl:gap-6">
        <div className="min-w-0">
          <header className="flex flex-wrap items-end justify-between gap-3 mb-5">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-accent-strong">
                Thi thử hạng {cfg.label} · {label}
              </p>
              <h1 className="mt-1 text-2xl font-semibold tracking-tight text-navy">
                Câu {current + 1}
                <span className="text-muted font-normal"> / {questions.length}</span>
              </h1>
            </div>
            <div
              className={`xl:hidden rounded-xl border px-3 py-1.5 font-mono text-lg font-semibold tabular-nums ${
                urgent ? 'border-red-300 bg-red-50 text-red-700 animate-pulse' : 'border-line bg-surface text-navy'
              }`}
            >
              {mm}:{ss}
            </div>
          </header>

          <article className="rounded-2xl border border-line bg-surface p-5 sm:p-7 shadow-[0_1px_0_rgba(53,45,36,0.04)]">
            <div className="flex flex-wrap items-center gap-2 mb-4">
              <Badge tone="gray">{q.chapter}</Badge>
              {q.critical && <Badge tone="red">Câu điểm liệt</Badge>}
              <button
                type="button"
                onClick={() => toggleFlag(q.id)}
                className={`ml-auto rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                  flags.has(q.id) ? 'border-accent bg-selected text-accent-strong' : 'border-line text-muted hover:text-navy'
                }`}
              >
                {flags.has(q.id) ? '⚑ Đã đánh dấu' : '⚐ Đánh dấu xem lại'}
              </button>
            </div>
            <p className="text-[17px] leading-relaxed text-navy font-medium">{q.text}</p>
            {q.imageKey && server && (
              <Asset id={q.questionId!} path={`/exams/${server.id}/questions/${q.questionId}/media`} alt="Hình minh họa bài thi" />
            )}
            <div className="mt-6 space-y-2.5">
              {q.options.map((o, i) => {
                const sel = answers[q.id] === i
                return (
                  <button
                    key={i}
                    type="button"
                    disabled={task.busy || left <= 0}
                    onClick={() => choose(q.id, i)}
                    className={`group w-full flex items-center gap-4 rounded-xl border px-4 py-3.5 text-left transition-all ${
                      sel ? 'border-navy bg-navy text-bg' : 'border-line bg-bg hover:border-accent hover:bg-selected/50 text-navy'
                    }`}
                  >
                    <span
                      className={`grid h-7 w-7 shrink-0 place-items-center rounded-lg font-mono text-[13px] font-semibold ${
                        sel ? 'bg-accent text-navy' : 'bg-surface border border-line text-muted group-hover:text-navy'
                      }`}
                    >
                      {i + 1}
                    </span>
                    <span className="min-w-0 break-words text-[15px] leading-6">{o}</span>
                  </button>
                )
              })}
            </div>
          </article>

          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <Button variant="ghost" disabled={current === 0} onClick={() => setCurrent((c) => c - 1)}>
              ← Câu trước
            </Button>
            <span className="hidden sm:block text-[11.5px] text-muted">
              Phím <kbd className="font-mono">1–4</kbd> chọn · <kbd className="font-mono">←/→</kbd> chuyển ·{' '}
              <kbd className="font-mono">F</kbd> đánh dấu
            </span>
            {current < questions.length - 1 ? (
              <Button variant="dark" onClick={() => setCurrent((c) => c + 1)}>
                Câu tiếp →
              </Button>
            ) : (
              <Button variant="primary" onClick={() => setConfirm(true)}>
                Nộp bài
              </Button>
            )}
          </div>
        </div>

        <aside className="mt-6 xl:mt-0 xl:sticky xl:top-6 self-start space-y-4">
          <div className={`hidden xl:block rounded-2xl border p-5 text-center ${urgent ? 'border-red-300 bg-red-50' : 'border-line bg-surface'}`}>
            <p className="text-[11px] uppercase tracking-[0.14em] text-muted">Thời gian còn lại</p>
            <p className={`mt-1 font-mono text-4xl font-semibold tabular-nums ${urgent ? 'text-red-700 animate-pulse' : 'text-navy'}`}>
              {mm}:{ss}
            </p>
            <div className="mt-3 h-1 rounded-full bg-line overflow-hidden">
              <div className={`h-full ${urgent ? 'bg-red-500' : 'bg-accent'}`} style={{ width: `${(left / (cfg.minutes * 60)) * 100}%` }} />
            </div>
          </div>
          <div className="rounded-2xl border border-line bg-surface p-5">
            <div className="flex items-center justify-between text-[13px] mb-3">
              <span className="font-semibold text-navy">Bảng câu hỏi</span>
              <span className="text-muted">
                {answered}/{questions.length} đã làm
              </span>
            </div>
            <div className="grid grid-cols-8 sm:grid-cols-10 xl:grid-cols-6 gap-1.5">
              {questions.map((x, i) => {
                const done = answers[x.id] !== undefined
                return (
                  <button
                    key={x.id}
                    type="button"
                    onClick={() => setCurrent(i)}
                    className={`relative aspect-square rounded-lg text-[12px] font-semibold tabular-nums transition-colors ${
                      i === current ? 'ring-2 ring-accent ring-offset-1 ring-offset-surface' : ''
                    } ${done ? 'bg-navy text-bg' : 'bg-bg border border-line text-muted hover:text-navy'}`}
                    aria-label={`Câu ${i + 1}`}
                  >
                    {i + 1}
                    {flags.has(x.id) && <span className="absolute -top-1 -right-1 h-2.5 w-2.5 rounded-full bg-accent border-2 border-surface" />}
                  </button>
                )
              })}
            </div>
            <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted">
              <span className="flex items-center gap-1.5">
                <i className="h-2.5 w-2.5 rounded bg-navy" />
                Đã làm
              </span>
              <span className="flex items-center gap-1.5">
                <i className="h-2.5 w-2.5 rounded border border-line bg-bg" />
                Chưa làm
              </span>
              <span className="flex items-center gap-1.5">
                <i className="h-2.5 w-2.5 rounded-full bg-accent" />
                Đánh dấu
              </span>
            </div>
            <Button variant="primary" className="mt-5 w-full py-2.5" onClick={() => setConfirm(true)}>
              Nộp bài
            </Button>
          </div>
          <p className="px-1 text-[11.5px] leading-relaxed text-muted">
            Đạt khi đúng ≥ {cfg.pass}/{cfg.total} câu và <b className="text-navy">không sai câu điểm liệt</b>. Hết giờ hệ thống tự nộp bài.
          </p>
        </aside>
      </div>

      <Modal
        open={confirm}
        title="Nộp bài thi?"
        onClose={() => setConfirm(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(false)}>
              Làm tiếp
            </Button>
            <Button variant="primary" disabled={task.busy} onClick={submit}>
              Nộp bài
            </Button>
          </>
        }
      >
        {unanswered.length ? (
          <div className="space-y-3 text-[13.5px] text-text-secondary">
            <p>
              Bạn còn <b className="text-navy">{unanswered.length} câu chưa trả lời</b> — câu bỏ trống tính là sai.
            </p>
            <div className="flex flex-wrap gap-1.5">
              {unanswered.map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => {
                    setCurrent(n - 1)
                    setConfirm(false)
                  }}
                  className="rounded-md border border-line px-2 py-0.5 font-mono text-xs text-navy hover:bg-selected"
                >
                  {n}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <p className="text-[13.5px] text-text-secondary">
            Bạn đã trả lời đủ {questions.length} câu{flags.size ? `, còn ${flags.size} câu đang đánh dấu xem lại` : ''}.
          </p>
        )}
      </Modal>
    </div>
  )
}

/* ---------- Màn chọn đề ---------- */
function Setup({
  cls,
  setCls,
  startRandom,
  notify,
  history,
}: {
  cls: ClassId
  setCls: (c: ClassId) => void
  startRandom: () => void
  notify: (msg: string) => void
  history: HistoryItem[]
}) {
  const cfg = CLASSES[cls]
  const passRate = history.length ? Math.round((history.filter((h) => h.passed).length / history.length) * 100) : null
  const isDevClass = cls !== 'B'

  return (
    <div className="h-full overflow-y-auto bg-bg">
      <div className="mx-auto max-w-5xl px-4 sm:px-6 py-8">
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-accent-strong">Thi thử sát hạch lý thuyết</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight text-navy">Chọn hạng và đề thi</h1>
        <p className="mt-2 max-w-2xl text-[14px] text-text-secondary">
          Đề ngẫu nhiên hạng B rút từ ngân hàng câu hỏi đã xuất bản trên server.
        </p>

        <div className="mt-6 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5">
          {(Object.keys(CLASSES) as ClassId[]).map((k) => {
            const c = CLASSES[k]
            const on = k === cls
            return (
              <button
                key={k}
                type="button"
                onClick={() => setCls(k)}
                className={`rounded-2xl border p-4 text-left transition-all ${
                  on ? 'border-navy bg-navy text-bg shadow-lg shadow-navy/10' : 'border-line bg-surface hover:border-accent'
                }`}
              >
                <span className={`block text-2xl font-semibold ${on ? 'text-accent' : 'text-navy'}`}>{c.label}</span>
                {k !== 'B' && (
                  <span className={`block mt-0.5 text-[11px] font-medium ${on ? 'text-bg/80' : 'text-text-secondary'}`}>
                    Đang phát triển
                  </span>
                )}
                <span className={`block mt-1 text-[11.5px] ${on ? 'text-bg/70' : 'text-muted'}`}>{c.desc}</span>
              </button>
            )
          })}
        </div>

        <div className="mt-5 grid grid-cols-3 divide-x divide-line rounded-2xl border border-line bg-surface">
          {[
            [cfg.total, 'câu hỏi'],
            [cfg.minutes, 'phút'],
            [`${cfg.pass}/${cfg.total}`, 'điểm đạt'],
          ].map(([v, l]) => (
            <div key={String(l)} className="px-4 py-4 text-center">
              <p className="text-2xl font-semibold text-navy tabular-nums">{v}</p>
              <p className="text-[11.5px] text-muted">{l}</p>
            </div>
          ))}
        </div>

        <div className="mt-6 grid gap-4 md:grid-cols-3">
          <div className="rounded-2xl border border-line bg-surface p-5 flex flex-col">
            <div className="flex items-center justify-between gap-2">
              <h3 className="font-semibold text-navy">Đề ngẫu nhiên</h3>
              {isDevClass && <Badge tone="gray">Đang phát triển</Badge>}
            </div>
            <p className="mt-1 text-[12.5px] text-muted flex-1">
              {isDevClass
                ? `Đề sát hạch hạng ${cfg.label} đang phát triển.`
                : 'Rút ngẫu nhiên từ ngân hàng câu hỏi, giống máy sát hạch.'}
            </p>
            <Button variant={isDevClass ? 'outline' : 'primary'} className="mt-4" onClick={startRandom}>
              {isDevClass ? `Hạng ${cfg.label} · Đang phát triển` : 'Bắt đầu thi'}
            </Button>
          </div>

          <div className="rounded-2xl border border-line bg-surface p-5">
            <div className="flex items-center justify-between gap-2">
              <h3 className="font-semibold text-navy">Bộ đề cố định</h3>
              <Badge tone="gray">Đang phát triển</Badge>
            </div>
            <p className="mt-1 text-[12.5px] text-muted">Làm lần lượt để phủ hết ngân hàng câu.</p>
            <div className="mt-4 grid grid-cols-5 gap-1.5">
              {Array.from({ length: 10 }, (_, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => notify('Chức năng đang phát triển')}
                  className="rounded-lg border border-line bg-bg py-1.5 text-[13px] font-semibold text-navy hover:bg-selected hover:border-accent"
                >
                  {i + 1}
                </button>
              ))}
            </div>
          </div>

          <div className="rounded-2xl border border-line bg-surface p-5 flex flex-col">
            <div className="flex items-center justify-between gap-2">
              <h3 className="font-semibold text-navy">Ôn câu hay sai</h3>
              <Badge tone="gray">Đang phát triển</Badge>
            </div>
            <p className="mt-1 text-[12.5px] text-muted flex-1">Tổng hợp các câu từng trả lời sai qua các lần thi để luyện lại.</p>
            <Button className="mt-4" onClick={() => notify('Chức năng đang phát triển')}>
              Ôn câu sai <Badge tone="gray">Đang phát triển</Badge>
            </Button>
          </div>
        </div>

        <section className="mt-8">
          <div className="flex items-baseline justify-between mb-3">
            <h2 className="text-[15px] font-semibold text-navy">Lịch sử thi</h2>
            {passRate !== null && (
              <span className="text-[12.5px] text-muted">
                Tỷ lệ đạt <b className="text-navy">{passRate}%</b> · {history.length} lần
              </span>
            )}
          </div>
          {history.length ? (
            <ul className="rounded-2xl border border-line bg-surface divide-y divide-line">
              {history.map((h, i) => (
                <li key={i} className="flex items-center gap-4 px-5 py-3 text-[13px]">
                  <span className="w-10 font-semibold text-navy">{CLASSES[h.cls].label}</span>
                  <span className="flex-1 text-text-secondary">{h.label}</span>
                  <span className="tabular-nums text-navy font-medium">
                    {h.score}/{h.total}
                  </span>
                  <Badge tone={h.passed ? 'green' : 'red'}>{h.passed ? 'Đạt' : h.criticalFail ? 'Sai điểm liệt' : 'Trượt'}</Badge>
                  <span className="hidden sm:block w-28 text-right text-muted">{h.at}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="rounded-2xl border border-dashed border-line px-5 py-6 text-center text-[13px] text-muted">
              Chưa có lần thi nào.
            </p>
          )}
        </section>
      </div>
    </div>
  )
}

/* ---------- Màn kết quả & xem lại ---------- */
function Result({
  cls,
  label,
  questions,
  answers,
  flags,
  result,
  notify,
  retry,
}: {
  cls: ClassId
  label: string
  questions: Q[]
  answers: Record<number, number>
  flags: Set<number>
  result: { wrong: Q[]; score: number; criticalFail: boolean; passed: boolean }
  notify: (msg: string) => void
  retry: () => void
}) {
  const nav = useNavigate()
  const cfg = CLASSES[cls]
  const [filter, setFilter] = useState<'all' | 'wrong' | 'critical' | 'flag'>('wrong')
  const shown = questions
    .map((q, i) => ({ q, i }))
    .filter(
      ({ q }) =>
        filter === 'all' ||
        (filter === 'wrong' && answers[q.id] !== q.correct) ||
        (filter === 'critical' && q.critical) ||
        (filter === 'flag' && flags.has(q.id)),
    )

  return (
    <div className="h-full overflow-y-auto bg-bg">
      <div className="mx-auto max-w-4xl px-4 sm:px-6 py-8">
        <div className={`rounded-3xl border p-6 sm:p-8 ${result.passed ? 'border-green/30 bg-green/5' : 'border-red-200 bg-red-50/60'}`}>
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted">
            Kết quả · Hạng {cfg.label} · {label}
          </p>
          <div className="mt-2 flex flex-wrap items-end justify-between gap-4">
            <div>
              <h1 className={`text-5xl font-bold tracking-tight ${result.passed ? 'text-green' : 'text-red-700'}`}>
                {result.passed ? 'ĐẠT' : 'KHÔNG ĐẠT'}
              </h1>
              <p className="mt-2 text-[14px] text-text-secondary">
                {result.criticalFail ? (
                  <>
                    Bạn đã <b className="text-red-700">sai câu điểm liệt</b> — trượt dù đủ điểm.
                  </>
                ) : result.passed ? (
                  'Chúc mừng! Bạn đã vượt mức điểm đạt.'
                ) : (
                  `Cần thêm ${cfg.pass - result.score} câu đúng để đạt.`
                )}
              </p>
            </div>
            <p className="text-right">
              <span className="text-5xl font-semibold tabular-nums text-navy">{result.score}</span>
              <span className="text-xl text-muted">/{questions.length}</span>
              <span className="block text-[12px] text-muted">yêu cầu ≥ {cfg.pass}</span>
            </p>
          </div>
          <div className="mt-6 flex flex-wrap gap-2">
            <Button variant="dark" onClick={retry}>
              Thi đề khác
            </Button>
            {result.wrong.length > 0 && (
              <Button onClick={() => notify('Chức năng đang phát triển')}>
                Ôn câu sai <Badge tone="gray">Đang phát triển</Badge>
              </Button>
            )}
            <Button variant="ghost" onClick={() => nav('/chat')}>
              Hỏi trợ lý
            </Button>
          </div>
        </div>

        <section className="mt-6">
          <div className="flex flex-wrap items-center gap-1.5 mb-3">
            <h2 className="text-[14px] font-semibold text-navy mr-2">Xem lại bài</h2>
            {([
              ['wrong', `Sai (${result.wrong.length})`],
              ['critical', 'Điểm liệt'],
              ['flag', `Đánh dấu (${flags.size})`],
              ['all', 'Tất cả'],
            ] as const).map(([k, l]) => (
              <button
                key={k}
                type="button"
                onClick={() => setFilter(k)}
                className={`rounded-full border px-3 py-1 text-xs font-medium ${
                  filter === k ? 'border-navy bg-navy text-bg' : 'border-line text-text-secondary hover:bg-selected'
                }`}
              >
                {l}
              </button>
            ))}
          </div>
          <div className="space-y-3">
            {shown.map(({ q, i }) => {
              const a = answers[q.id]
              const ok = a === q.correct
              return (
                <article key={q.id} className={`rounded-2xl border bg-surface p-5 ${ok ? 'border-line' : 'border-red-200'}`}>
                  <div className="flex flex-wrap items-center gap-2 mb-2 text-[12px]">
                    <span className="font-mono font-semibold text-muted">Câu {i + 1}</span>
                    {q.critical && <Badge tone="red">Điểm liệt</Badge>}
                    <Badge tone={ok ? 'green' : a === undefined ? 'gray' : 'red'}>
                      {ok ? 'Đúng' : a === undefined ? 'Bỏ trống' : 'Sai'}
                    </Badge>
                  </div>
                  <p className="text-[14.5px] font-medium text-navy">{q.text}</p>
                  <ul className="mt-3 space-y-1.5">
                    {q.options.map((o, k) => (
                      <li
                        key={k}
                        className={`rounded-lg px-3 py-2 text-[13.5px] ${
                          k === q.correct
                            ? 'bg-green/10 text-green font-medium'
                            : k === a
                              ? 'bg-red-50 text-red-700 line-through'
                              : 'text-text-secondary'
                        }`}
                      >
                        {k + 1}. {o}
                        {k === q.correct ? ' ✓' : ''}
                      </li>
                    ))}
                  </ul>
                  <div className="mt-3 rounded-xl bg-sidebar px-4 py-3 text-[12.5px] text-text-secondary">
                    <span className="text-accent-strong font-medium">{q.source}</span>
                    <button type="button" onClick={() => nav('/chat')} className="ml-2 font-medium text-navy underline-offset-2 hover:underline">
                      Hỏi trợ lý →
                    </button>
                  </div>
                </article>
              )
            })}
            {!shown.length && (
              <p className="rounded-2xl border border-dashed border-line px-5 py-6 text-center text-[13px] text-muted">
                Không có câu nào trong mục này.
              </p>
            )}
          </div>
        </section>
      </div>
    </div>
  )
}
