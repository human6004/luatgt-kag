import { api, send, type ContentRecord } from '../api'
import { useAdmin } from '../admin/store'
import { Asset, Notice, useData, useTask } from './server/shared'
import { Badge, Button } from '../admin/ui'
import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'

export type ChapterStatus = 'not_started' | 'in_progress' | 'completed'

export interface ChapterItem {
  id: number
  title: string
  subtitle: string
  desc: string
  totalQuestions: number
  studiedQuestions: number
  criticalQuestions: number
  status: ChapterStatus
  lastStudiedDate?: string
  completedDate?: string
}

const initialChapters: ChapterItem[] = [
  {
    id: 1,
    title: 'Chương I: Khái niệm và quy tắc giao thông đường bộ',
    subtitle: 'Nền tảng lý thuyết bắt buộc',
    desc: 'Bao gồm các khái niệm định nghĩa: dải phân cách, làn đường, khổ giới hạn, quy tắc vượt xe, nhường đường, chuyển hướng và tốc độ quy định.',
    totalQuestions: 0,
    studiedQuestions: 0,
    criticalQuestions: 0,
    status: 'not_started',
  },
  {
    id: 2,
    title: 'Chương II: Nghiệp vụ vận tải & Đạo đức người lái xe',
    subtitle: 'Văn hóa giao thông & Trách nhiệm xã hội',
    desc: 'Quy định trách nhiệm của người lái xe, nghiệp vụ vận tải hàng hóa và hành khách, kỹ năng xử lý tình huống khẩn cấp và sơ cấp cứu nạn nhân.',
    totalQuestions: 0,
    studiedQuestions: 0,
    criticalQuestions: 0,
    status: 'not_started',
  },
  {
    id: 3,
    title: 'Chương III: Kỹ thuật lái xe ô tô an toàn',
    subtitle: 'Thao tác điều khiển trên nhiều địa hình',
    desc: 'Thao tác lái xe cơ bản, khởi hành xe ngang dốc, phanh khẩn cấp, lái xe đường đèo dốc quanh co, thời tiết sương mù và trơn trượt.',
    totalQuestions: 0,
    studiedQuestions: 0,
    criticalQuestions: 0,
    status: 'not_started',
  },
  {
    id: 4,
    title: 'Chương IV: Cấu tạo và sửa chữa xe cơ giới thông thường',
    subtitle: 'Kiến thức kỹ thuật máy & an toàn kỹ thuật',
    desc: 'Cấu tạo động cơ, hệ thống truyền lực, phanh, lái, lốp xe và các hư hỏng thông thường trên đường cùng phương pháp khắc phục an toàn.',
    totalQuestions: 0,
    studiedQuestions: 0,
    criticalQuestions: 0,
    status: 'not_started',
  },
  {
    id: 5,
    title: 'Chương V: Hệ thống biển báo hiệu đường bộ',
    subtitle: 'Nhận diện và phân tích biển báo',
    desc: 'Quy chuẩn hệ thống biển báo cấm, biển nguy hiểm, biển hiệu lệnh, biển chỉ dẫn, biển phụ và vạch kẻ đường theo QCVN 41:2019/BGTVT.',
    totalQuestions: 0,
    studiedQuestions: 0,
    criticalQuestions: 0,
    status: 'not_started',
  },
  {
    id: 6,
    title: 'Chương VI: Giải các thế sa hình và kỹ năng xử lý',
    subtitle: 'Quy tắc nhường đường tại nơi giao nhau',
    desc: 'Phân tích các thế sa hình theo thứ tự ưu tiên: Xe ưu tiên - Đường ưu tiên - Bên phải không vướng - Hướng rẽ ưu tiên.',
    totalQuestions: 0,
    studiedQuestions: 0,
    criticalQuestions: 0,
    status: 'not_started',
  },
]

export default function ChapterStudyPage() {
  const [params, setParams] = useSearchParams()
  const { notify } = useAdmin()
  const questions = useData<ContentRecord[]>('/questions')
  const progress = useData<{ chapter: number; practiced: number; correct: number; attempts: number }[]>('/progress')
  const task = useTask()

  const [practiceIndex, setPracticeIndex] = useState(0)
  const [answer, setAnswer] = useState<{ correct: boolean; correctAnswer: number; critical: boolean; explanation: string } | null>(null)

  const chapters: ChapterItem[] = initialChapters.map((c) => {
    const total = questions.value?.filter((q) => Number(q.data.chapter) === c.id).length || 0
    const practiced = progress.value?.find((p) => p.chapter === c.id)?.practiced || 0
    return {
      ...c,
      totalQuestions: total,
      studiedQuestions: practiced,
      criticalQuestions: questions.value?.filter((q) => Number(q.data.chapter) === c.id && q.data.critical === true).length || 0,
      status: total > 0 && practiced >= total ? 'completed' : practiced > 0 ? 'in_progress' : 'not_started',
    }
  })
  const ready = !!questions.value && !!progress.value && !questions.error && !progress.error

  const rawFilter = params.get('filter')
  const filterStatus = rawFilter === 'in_progress' || rawFilter === 'completed' || rawFilter === 'not_started' ? rawFilter : 'all'

  const rawChapter = Number(params.get('chapter') ?? '')
  const selectedProgressChapterId =
    Number.isInteger(rawChapter) && rawChapter >= 1 && rawChapter <= 6 ? rawChapter : 1

  const rawPractice = Number(params.get('practice') ?? '')
  const activePracticeModal =
    Number.isInteger(rawPractice) && rawPractice >= 1 && rawPractice <= 6
      ? chapters.find((c) => c.id === rawPractice) ?? null
      : null

  useEffect(() => {
    setPracticeIndex(0)
    setAnswer(null)
  }, [rawPractice])

  function updateUrl(patch: Record<string, string | null>) {
    setParams((prev) => {
      const next = new URLSearchParams(prev)
      for (const [k, v] of Object.entries(patch)) {
        if (v === null || v === '') next.delete(k)
        else next.set(k, v)
      }
      return next
    })
  }

  const currentPractice = chapters.find((c) => c.id === activePracticeModal?.id)
  const practiceQuestions = questions.value?.filter((q) => Number(q.data.chapter) === activePracticeModal?.id) || []
  const question = practiceQuestions[practiceIndex]

  const totalAllQuestions = chapters.reduce((acc, c) => acc + c.totalQuestions, 0)
  const totalStudied = chapters.reduce((acc, c) => acc + c.studiedQuestions, 0)
  const overallPercentage = Math.round((totalStudied / (totalAllQuestions || 1)) * 100)
  const completedChaptersCount = chapters.filter((c) => c.status === 'completed').length
  const selectedProgressChapter = chapters.find((chapter) => chapter.id === selectedProgressChapterId) ?? chapters[0]
  const selectedProgressPercentage = Math.round(
    (selectedProgressChapter.studiedQuestions / (selectedProgressChapter.totalQuestions || 1)) * 100,
  )
  const selectedProgressRemaining = selectedProgressChapter.totalQuestions - selectedProgressChapter.studiedQuestions

  const filteredChapters = chapters.filter((c) => {
    if (filterStatus === 'all') return true
    return c.status === filterStatus
  })

  function openPractice(c: ChapterItem) {
    setPracticeIndex(0)
    setAnswer(null)
    updateUrl({ practice: String(c.id) })
  }

  function closePractice() {
    updateUrl({ practice: null })
  }

  return (
    <div className="min-h-full pb-16 px-6 sm:px-8 max-w-7xl mx-auto pt-6">
      <Notice {...questions} empty={questions.value?.length === 0} retry={questions.reload} />
      <Notice {...progress} retry={progress.reload} />
      <Notice error={task.error} />

      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center gap-2 text-xs text-muted mb-2 font-mono">
          <span>LuậtGT</span>
          <span>/</span>
          <span className="text-navy font-sans font-medium">Lộ trình ôn thi theo ngân hàng đã xuất bản</span>
        </div>
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h1 className="font-sans font-semibold text-2xl sm:text-3xl text-navy tracking-normal">
              Ôn thi lý thuyết theo chương
            </h1>
            <p className="text-muted text-sm mt-1">
              6 chương · câu hỏi đã xuất bản và tiến độ do server cung cấp
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Link
              to="/exam"
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold text-navy bg-surface border border-line hover:bg-bg transition-colors"
            >
              <span>Vào phòng thi thử</span>
              <svg className="w-3.5 h-3.5 text-accent-strong" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M14 5l7 7m0 0l-7 7m7-7H3"/></svg>
            </Link>
          </div>
        </div>
      </div>

      {/* Main 2-Column Layout */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-8 items-start">
        {/* Left Column: Chapters List */}
        <div className="min-w-0 xl:col-span-8 space-y-4">
          <div className="flex items-center justify-between bg-surface p-3.5 rounded-2xl border border-line">
            <div className="flex items-center gap-1.5 overflow-x-auto text-xs">
              {[
                { key: 'all', label: 'Tất cả chương' },
                { key: 'in_progress', label: 'Đang học' },
                { key: 'completed', label: 'Đã hoàn thành' },
                { key: 'not_started', label: 'Chưa học' },
              ].map((item) => (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => updateUrl({ filter: item.key === 'all' ? null : item.key })}
                  className={`px-3 py-1.5 rounded-lg font-medium transition-colors whitespace-nowrap ${
                    filterStatus === item.key ? 'bg-navy text-white shadow-2xs' : 'text-text-secondary hover:bg-selected'
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </div>
            <span className="text-xs text-muted hidden sm:block shrink-0 pl-2">{filteredChapters.length} chương</span>
          </div>

          <div className="space-y-4">
            {filteredChapters.map((chapter) => {
              const pct = Math.round((chapter.studiedQuestions / (chapter.totalQuestions || 1)) * 100)
              const remaining = chapter.totalQuestions - chapter.studiedQuestions

              return (
                <div
                  key={chapter.id}
                  className="bg-surface rounded-2xl border border-line hover:border-accent/60 p-5 sm:p-6 shadow-2xs hover:shadow-xs transition-all flex flex-col justify-between"
                >
                  <div>
                    <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3 mb-2">
                      <div>
                        <div className="flex items-center gap-2 mb-1">
                          <span className="px-2 py-0.5 rounded text-[11px] font-mono font-semibold bg-bg border border-line text-text-secondary">
                            Chương {chapter.id}
                          </span>
                          <span className="text-xs font-medium text-accent-strong">{chapter.subtitle}</span>
                        </div>
                        <h3 className="font-sans text-lg sm:text-[19px] font-semibold text-navy">{chapter.title}</h3>
                      </div>

                      <div className="shrink-0">
                        {chapter.status === 'completed' && (
                          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-[#ecfdf5] text-[#059669]">
                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M5 13l4 4L19 7"/></svg>
                            Hoàn thành
                          </span>
                        )}
                        {chapter.status === 'in_progress' && (
                          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-surface text-accent-strong">
                            <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse"></span>
                            Đang học ({ready ? pct : '—'}%)
                          </span>
                        )}
                        {chapter.status === 'not_started' && (
                          <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-bg text-muted border border-line">
                            {ready ? 'Chưa học' : 'Chưa đọc được tiến độ'}
                          </span>
                        )}
                      </div>
                    </div>

                    <p className="text-xs sm:text-sm text-text-secondary leading-relaxed mb-4">{chapter.desc}</p>

                    <div className="flex flex-wrap items-center gap-4 text-xs text-muted py-2 border-y border-selected mb-4">
                      <span className="flex items-center gap-1.5">
                        <svg className="w-4 h-4 text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>
                        Tổng: <strong className="text-navy">{questions.value ? chapter.totalQuestions : '—'} câu hỏi</strong>
                      </span>
                      {chapter.status === 'in_progress' && (
                        <span className="text-accent-strong font-medium">Còn {remaining} câu chưa học</span>
                      )}
                    </div>
                  </div>

                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-1">
                    <div className="text-xs text-muted">
                      {chapter.status === 'completed' && (
                        <span className="text-[#059669] font-medium">Đã ôn toàn bộ câu hỏi chương này</span>
                      )}
                      {chapter.status === 'in_progress' && <span>Lượt trả lời đã ghi nhận trên server</span>}
                      {chapter.status === 'not_started' && (
                        <span>{ready ? 'Chưa ghi nhận lượt trả lời' : 'Chưa đọc được tiến độ'}</span>
                      )}
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => notify('Chức năng đang phát triển')}
                        className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium text-text-secondary bg-bg hover:bg-selected border border-line transition-colors"
                      >
                        +10 câu <Badge tone="gray">Đang phát triển</Badge>
                      </button>

                      {chapter.status === 'not_started' ? (
                        <button
                          type="button"
                          onClick={() => openPractice(chapter)}
                          className="inline-flex items-center gap-1.5 px-5 py-2 rounded-xl text-xs font-semibold text-navy transition-all shadow-xs"
                          style={{ background: 'var(--color-accent)' }}
                        >
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"/></svg>
                          Bắt đầu học
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => openPractice(chapter)}
                          className="inline-flex items-center gap-1.5 px-5 py-2 rounded-xl text-xs font-semibold text-white transition-all shadow-xs"
                          style={{ background: 'var(--color-navy)' }}
                        >
                          <span>{chapter.status === 'completed' ? 'Ôn tập lại' : 'Tiếp tục học'}</span>
                          <svg className="w-3.5 h-3.5 text-progress" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5l7 7-7 7"/></svg>
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        {/* Right Column: Tiến độ của tôi */}
        <div className="min-w-0 xl:col-span-4 xl:sticky xl:top-6 space-y-6">
          <div className="bg-surface rounded-2xl border border-line shadow-xs p-6 space-y-6">
            <div className="flex items-center justify-between border-b border-selected pb-4">
              <div className="flex items-center gap-2">
                <span className="w-3 h-3 rounded-full bg-accent"></span>
                <h2 className="font-sans text-lg font-bold text-navy">Tiến độ của tôi</h2>
              </div>
              <span className="text-xs px-2.5 py-0.5 rounded-full bg-selected text-accent-strong font-medium font-mono">
                Hạng B
              </span>
            </div>

            <div className="bg-bg rounded-xl p-5 border border-line">
              <div className="flex items-baseline justify-between mb-2">
                <span className="text-xs font-semibold uppercase tracking-wider text-muted">
                  Tổng tiến độ hoàn thành
                </span>
                <span className="font-sans text-3xl font-bold text-navy">{ready ? overallPercentage : '—'}%</span>
              </div>

              <div className="w-full bg-line h-3.5 rounded-full overflow-hidden p-0.5">
                <div
                  className="h-full rounded-full bg-progress transition-all duration-500 ease-out"
                  style={{ width: `${ready ? overallPercentage : 0}%` }}
                />
              </div>

              <div className="flex flex-wrap justify-between items-center gap-x-3 gap-y-1 text-xs text-muted mt-2.5">
                <span>
                  Đã học: <strong className="text-navy">{ready ? totalStudied : '—'}</strong> / {ready ? totalAllQuestions : '—'} câu
                </span>
                <span>
                  Hoàn tất: <strong className="text-navy">{ready ? completedChaptersCount : '—'}</strong> / {chapters.length} chương
                </span>
              </div>
            </div>

            <div className="space-y-4">
              <label htmlFor="chapter-progress-selection" className="block text-xs font-semibold uppercase tracking-wider text-muted">
                Tiến độ chi tiết từng chương
              </label>
              <div className="relative">
                <select
                  id="chapter-progress-selection"
                  value={selectedProgressChapterId}
                  onChange={(event) => updateUrl({ chapter: event.target.value === '1' ? null : event.target.value })}
                  className="w-full min-w-0 appearance-none rounded-xl border border-line bg-bg py-3 pl-3 pr-9 text-xs font-medium text-navy cursor-pointer outline-none transition-colors hover:border-accent focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/25"
                >
                  {chapters.map((chapter) => (
                    <option key={chapter.id} value={chapter.id}>
                      {chapter.title}
                    </option>
                  ))}
                </select>
                <svg className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-accent-strong" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" d="m6 9 6 6 6-6" />
                </svg>
              </div>

              <div className="rounded-xl border border-line bg-bg p-4 space-y-3" aria-live="polite" aria-atomic="true">
                <div className="flex items-start justify-between gap-3">
                  <span className="text-xs font-medium leading-relaxed text-navy">{selectedProgressChapter.subtitle}</span>
                  <span className="shrink-0 font-mono text-sm font-bold text-accent-strong">{selectedProgressPercentage}%</span>
                </div>
                <div
                  className="w-full bg-selected h-2 rounded-full overflow-hidden"
                  role="progressbar"
                  aria-label={`Tiến độ ${selectedProgressChapter.title}`}
                  aria-valuenow={selectedProgressPercentage}
                  aria-valuemin={0}
                  aria-valuemax={100}
                >
                  <div
                    className="h-full rounded-full bg-progress transition-all duration-300"
                    style={{ width: `${selectedProgressPercentage}%` }}
                  />
                </div>
                <div className="flex justify-between gap-2 text-[11px] text-muted">
                  <span>
                    Đã học: <strong className="text-navy">{ready ? selectedProgressChapter.studiedQuestions : '—'}</strong> /{' '}
                    {ready ? selectedProgressChapter.totalQuestions : '—'} câu
                  </span>
                  <span>Còn {selectedProgressRemaining} câu</span>
                </div>
              </div>
            </div>

            {/* Quick Practice Suggestion */}
            <div className="bg-selected/70 rounded-xl p-4 border border-line space-y-2">
              <div className="flex items-center justify-between gap-2 text-xs font-semibold text-accent-strong">
                <span className="inline-flex items-center gap-2">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>
                  <span>Gợi ý học tập thông minh</span>
                </span>
                <Badge tone="gray">Đang phát triển</Badge>
              </div>
              <p className="text-xs text-text-secondary leading-relaxed">
                Phân tích câu hay sai và gợi ý lộ trình ôn tập cá nhân hóa.
              </p>
              <button
                type="button"
                onClick={() => notify('Chức năng đang phát triển')}
                className="w-full mt-1 py-1.5 rounded-lg text-xs font-semibold text-navy text-center transition-colors shadow-2xs"
                style={{ background: 'var(--color-accent)' }}
              >
                Nhận gợi ý ôn tập · Đang phát triển
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Modal học tập chương */}
      {activePracticeModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-navy/40 backdrop-blur-xs">
          <div className="bg-bg w-full max-w-xl rounded-2xl border border-line shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150">
            <div className="flex items-start justify-between gap-3 px-6 py-4 border-b border-line bg-surface">
              <div className="min-w-0 break-words">
                <span className="text-[11px] font-mono font-bold text-accent-strong">
                  Chương {activePracticeModal.id} • Hạng B
                </span>
                <h3 className="font-sans text-lg font-semibold text-navy">{activePracticeModal.title}</h3>
              </div>
              <button
                type="button"
                aria-label="Đóng hộp thoại ôn tập"
                onClick={closePractice}
                className="shrink-0 p-1 rounded-lg text-muted hover:bg-selected hover:text-navy"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12"/></svg>
              </button>
            </div>

            <div className="p-6 space-y-4 max-h-[65vh] overflow-y-auto">
              <div className="p-4 bg-surface rounded-xl border border-line space-y-2">
                {question ? (
                  <>
                    <p className="text-xs text-muted">
                      Câu {practiceIndex + 1}/{practiceQuestions.length}
                    </p>
                    <p className="text-sm font-medium text-navy">{String(question.data.text)}</p>
                    {!!question.data.imageKey && <Asset id={question.id} alt="Ảnh câu hỏi" />}
                    <div className="space-y-1.5 pt-2">
                      {(question.data.options as string[]).map((o, i) => (
                        <Button
                          key={i}
                          disabled={task.busy || !!answer}
                          className="w-full justify-start text-left whitespace-normal"
                          onClick={() =>
                            void task.run(async () => {
                              setAnswer(await api(`/study/${question.id}/answer`, send('POST', { selected: i })))
                              progress.reload()
                            })
                          }
                        >
                          {i + 1}. {o}
                        </Button>
                      ))}
                    </div>
                    {answer && (
                      <div role="status" className="text-sm">
                        <p>
                          {answer.correct ? 'Đúng' : 'Sai'} · Đáp án {answer.correctAnswer + 1}
                          {answer.critical ? ' · Điểm liệt' : ''}
                        </p>
                        <p>{answer.explanation}</p>
                      </div>
                    )}
                  </>
                ) : (
                  <p>Chưa có câu hỏi đã xuất bản cho chương này.</p>
                )}
              </div>
              <div className="p-3.5 bg-selected rounded-xl text-xs text-text-secondary flex items-center justify-between">
                <span>
                  Tiến độ chương này: <strong>{currentPractice?.studiedQuestions ?? 0}</strong> /{' '}
                  {currentPractice?.totalQuestions ?? 0} câu
                </span>
                <span className="text-accent-strong font-semibold">
                  {Math.round(((currentPractice?.studiedQuestions ?? 0) / ((currentPractice?.totalQuestions ?? 0) || 1)) * 100)}%
                </span>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 px-6 py-3.5 bg-sidebar border-t border-line">
              <Link
                to="/chat"
                state={{ initialQuery: `Giải thích chi tiết các quy tắc giao thông trong ${activePracticeModal.title}` }}
                className="text-xs text-navy hover:text-accent-strong font-medium"
              >
                Hỏi Chatbot KAG giải thích
              </Link>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setAnswer(null)
                    setPracticeIndex((i) => (practiceQuestions.length ? (i + 1) % practiceQuestions.length : 0))
                  }}
                  className="px-4 py-2 rounded-xl text-xs font-semibold text-navy bg-accent hover:bg-accent-hover transition-colors shadow-2xs"
                >
                  Câu tiếp theo
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
