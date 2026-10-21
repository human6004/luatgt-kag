import { useLocation, useNavigate } from 'react-router-dom'
import { api, send as request } from '../api'
import { Notice, useTask } from './server/shared'
import { createChat, chatView, loadCitationSource } from './server/chat-state'
import LogoMark from '../components/LogoMark'
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'

interface LegalReference {
  title: string
  clause: string
  label: string
  raw: Parameters<typeof loadCitationSource>[0]
}

interface Message {
  role: 'user' | 'bot'
  text: string
  status?: string
  rich?: boolean
  citations?: LegalReference[]
}

interface Session {
  id: string
  title: string
  group: 'Hôm nay' | 'Hôm qua' | '7 ngày trước' | '30 ngày trước'
  pinned?: boolean
  messages: Message[]
}

const starters = [
  { label: 'Tra mức phạt', q: 'Xe máy không đội mũ bảo hiểm bị phạt bao nhiêu?' },
  { label: 'Nồng độ cồn', q: 'Ô tô vi phạm nồng độ cồn mức 1 bị xử lý thế nào?' },
  { label: 'Biển báo', q: 'Biển P.102 nghĩa là gì?' },
  { label: 'Ôn thi', q: 'Giải thích quy tắc nhường đường tại nơi giao nhau' },
]

const groups: Session['group'][] = ['Hôm nay', 'Hôm qua', '7 ngày trước', '30 ngày trước']

function Icon({ d, className = 'w-4 h-4' }: { d: string; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={d} />
    </svg>
  )
}

const ic = {
  plus: 'M12 5v14M5 12h14',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4',
  panel: 'M4 5h16v14H4zM9 5v14',
  book: 'M5 4h10a4 4 0 0 1 4 4v12H9a4 4 0 0 1-4-4zM5 16a4 4 0 0 1 4-4h10',
  send: 'M12 19V5M6 11l6-6 6 6',
  dots: 'M5 12h.01M12 12h.01M19 12h.01',
  pin: 'M9 4h6l-1 6 4 3H6l4-3zM12 13v7',
  copy: 'M9 9h10v10H9zM5 15V5h10',
  up: 'M7 10v10M7 10l4-6a2 2 0 0 1 3 2l-1 4h5a2 2 0 0 1 2 2l-2 6a2 2 0 0 1-2 2H7',
  retry: 'M4 12a8 8 0 1 0 3-6.2M4 4v4h4',
  clip: 'M20 12l-8 8a5 5 0 0 1-7-7l8-8a3 3 0 0 1 5 5l-8 8a1 1 0 0 1-2-2l7-7',
  close: 'M6 6l12 12M18 6 6 18',
}

function RichAnswer({text}:{text:string}) {
  return <div className="text-navy leading-[1.7]"><p className="font-sans text-[16px] whitespace-pre-wrap break-words mb-5">{text}</p>
    <div className="font-sans grid grid-cols-1 sm:grid-cols-3 gap-2 mb-5">{['Phạt tiền','Trừ điểm GPLX','Hình thức bổ sung'].map((label,i)=><div key={label} className={`relative overflow-hidden rounded-xl border px-4 py-3.5 ${i===0?'border-accent/50 bg-selected':'border-line bg-surface'}`}>
    {i===0&&<span className="absolute inset-y-0 left-0 w-[3px] bg-accent" aria-hidden/>}<p className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-muted mb-1.5">{label}</p><p className="text-[17px] font-semibold tracking-tight leading-tight">Chưa có dữ liệu cấu trúc</p><p className="mt-0.5 text-[11.5px] text-muted">Đọc câu trả lời và căn cứ; không suy đoán giá trị.</p></div>)}</div>
    <p className="mb-4 text-[15px] text-text-secondary border-l-2 border-line pl-4">Hiệu lực và ngoại lệ: xem căn cứ được backend trả về.</p>
  </div>
}

export default function ChatPage() {
  const [chat] = useState(createChat)
  const data = useSyncExternalStore(chat.subscribe, chat.getSnapshot), task = useTask()
  const nav = useNavigate(), location = useLocation()
  const [pinned, setPinned] = useState<Set<string>>(new Set())
  const [notice, setNotice] = useState('')
  const [source, setSource] = useState<Awaited<ReturnType<typeof loadCitationSource>>>()
  const [sourceError, setSourceError] = useState(''), [sourceBusy, setSourceBusy] = useState(false)
  const sourceRequest = useRef(0)
  const sessions: Session[] = data.rows.map(row => {
    const view = chatView(row)
    return { id: row.id, title: row.question, group: 'Hôm nay', pinned: pinned.has(row.id), messages: [
      { role: 'user', text: row.question },
      { role: 'bot', text: view.answer, status: view.status, rich: !!view.answer, citations: view.citations.map(c => ({title:c.doc_id, clause:c.unit_id ?? c.sign_id ?? '', label:`${c.doc_id}${c.unit_id || c.sign_id ? ` · ${c.unit_id ?? c.sign_id}` : ''}`, raw:c})) },
    ] }
  })
  // Backend stores one question per record and exposes no session date/grouping.
  useEffect(() => { void chat.load(); return () => chat.dispose() }, [chat])
  useEffect(() => { if (data.currentId) setActiveId(data.currentId) }, [data.currentId])
  useEffect(() => { const q=location.state?.initialQuery; if(typeof q==='string') setInput(q) }, [location.state])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [input, setInput] = useState('')
  const [query, setQuery] = useState('')
  const [showList, setShowList] = useState(() => window.innerWidth >= 768)
  const [selectedCitation, setSelectedCitation] = useState<{
    sessionId: string
    messageIndex: number
    referenceIndex: number
  } | null>(null)
  const thinking = data.busy
  const blocked = data.busy || data.loading || task.busy
  const endRef = useRef<HTMLDivElement>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const citationTriggerRef = useRef<HTMLButtonElement | null>(null)
  const citationCloseRef = useRef<HTMLButtonElement>(null)

  const active = sessions.find((s) => s.id === activeId) ?? null
  const messages = active?.messages ?? []
  const selectedReference = selectedCitation?.sessionId === activeId
    ? messages[selectedCitation.messageIndex]?.citations?.[selectedCitation.referenceIndex]
    : undefined

  const filtered = useMemo(
    () => sessions.filter((s) => s.title.toLowerCase().includes(query.toLowerCase())),
    [sessions, query]
  )

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length, thinking])

  useEffect(() => {
    setSelectedCitation(null)
  }, [activeId])

  useEffect(() => {
    if (!selectedCitation) return
    citationCloseRef.current?.focus()
    function handleEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setSelectedCitation(null)
        citationTriggerRef.current?.focus()
      }
    }
    document.addEventListener('keydown', handleEscape)
    return () => document.removeEventListener('keydown', handleEscape)
  }, [selectedCitation])

  useEffect(() => {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = Math.min(ta.scrollHeight, 200) + 'px'
  }, [input])

  function newChat() {
    setActiveId(null)
    setInput('')
  }

  async function send(text = input) {
    if (blocked || !text.trim()) return
    if (await chat.submit(text)) { setActiveId(chat.getSnapshot().rows[0]?.id ?? null); setInput(''); if(window.innerWidth<768) setShowList(false) }
  }
  async function readSource() {
    if (!selectedReference) return
    const id=++sourceRequest.current; setSourceBusy(true); setSourceError(''); setSource(undefined)
    try { const result=await loadCitationSource(selectedReference.raw); if(id===sourceRequest.current)setSource(result) }
    catch { if(id===sourceRequest.current)setSourceError('Chi tiết nguồn chưa khả dụng hoặc không khớp trích đoạn. Trích dẫn backend được giữ nguyên.') }
    finally { if(id===sourceRequest.current)setSourceBusy(false) }
  }
  function messageAction(action: string, text: string) {
    if(action==='Sao chép') { void navigator.clipboard.writeText(text).then(()=>setNotice('Đã sao chép')).catch(()=>setNotice('Không sao chép được')); return }
    if(action==='Tạo lại') { const q=active?.messages[0]?.text; if(q)setInput(q); setNotice('Câu hỏi đã đưa vào ô nhập. Gửi để tạo lượt hỏi mới.'); return }
    if(active) void task.run(async()=>{ await api(`/chat/${active.id}/feedback`,request('POST',{feedback:action==='Hữu ích'?'HELPFUL':action,note:''})); setNotice('Đã lưu phản hồi') })
  }
  function handleKey(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      send()
    }
  }

  const composer = (
    <div className="rounded-[20px] border border-line bg-white/70 shadow-[0_1px_2px_rgba(53,45,36,0.04),0_8px_28px_-8px_rgba(128,101,26,0.14)] focus-within:border-progress focus-within:shadow-[0_0_0_4px_rgba(216,184,78,0.14),0_8px_28px_-8px_rgba(128,101,26,0.18)] transition-all">
      <textarea
        ref={taRef}
        id="chat-question"
        aria-label="Câu hỏi luật giao thông"
        maxLength={4000}
        rows={1}
        className="block w-full min-h-[52px] resize-none overflow-y-auto bg-transparent px-4 pt-3.5 pb-1 text-[15px] leading-relaxed outline-none placeholder:text-muted/80 text-navy [scrollbar-width:thin]"
        placeholder={active ? 'Hỏi tiếp…' : 'Hỏi về luật giao thông hoặc thi bằng lái…'}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={handleKey}
      />
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 pb-3">
        <div className="flex items-center gap-1">
          <button onClick={() => setNotice("Demo: đính kèm ảnh chưa có API. Dùng thư viện biển báo để tra cứu.")} className="p-2 rounded-lg text-muted hover:bg-selected" title="Đính kèm ảnh biển báo · Demo">
            <Icon d={ic.clip} />
          </button>
          <span className="ml-1 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11.5px] font-medium text-text-secondary bg-sidebar border border-line">
            <span className="w-1.5 h-1.5 rounded-full bg-accent" aria-hidden />
            Hạng B
          </span>
        </div>
        {thinking && <button onClick={() => void chat.cancel()} disabled={data.stopping} className="border border-line rounded-lg px-3 py-2 text-xs disabled:opacity-50">{data.stopping ? 'Đang dừng…' : 'Dừng'}</button>}
        <button
          onClick={() => void send()}
          disabled={!input.trim() || blocked}
          className="w-9 h-9 grid place-items-center rounded-full bg-navy text-bg transition hover:bg-navy-light disabled:bg-line disabled:text-muted disabled:cursor-not-allowed shadow-xs"
          aria-label="Gửi"
        >
          <Icon d={ic.send} />
        </button>
      </div>
    </div>
  )

  return (
    <div className="relative flex h-full bg-bg">
      {/* Sessions */}
      {showList && (
        <aside aria-label="Lịch sử câu hỏi" className="absolute inset-y-0 left-0 z-10 w-64 max-w-full md:static shrink-0 flex flex-col border-r border-line bg-bg shadow-lg md:shadow-none">
          <div className="p-3 space-y-2">
            <button onClick={() => setShowList(false)} className="md:hidden w-full border border-line rounded-lg px-3 py-2">Đóng lịch sử</button>
            <Notice loading={data.loading} error={data.error} retry={chat.load} />
            <button disabled={thinking} onClick={chat.load} className="text-xs underline">Tải lại lịch sử</button>
            <button
              onClick={newChat}
              className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-navy hover:bg-selected transition-colors"
            >
              <span className="w-5 h-5 grid place-items-center rounded-full bg-accent text-navy">
                <Icon d={ic.plus} className="w-3.5 h-3.5" />
              </span>
              Cuộc trò chuyện mới
            </button>
            <label className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-line bg-surface text-muted">
              <Icon d={ic.search} className="w-3.5 h-3.5" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Tìm cuộc trò chuyện"
                className="flex-1 bg-transparent text-[13px] outline-none text-navy placeholder-muted"
              />
            </label>
          </div>

          <div className="flex-1 overflow-y-auto px-2 pb-4">
            {filtered.some((s) => s.pinned) && (
              <Section label="Đã ghim">
                {filtered.filter((s) => s.pinned).map((s) => (
                  <SessionItem key={s.id} s={s} active={s.id === activeId} onClick={() => { setActiveId(s.id); if(window.innerWidth<768)setShowList(false) }} onPin={() => setPinned(p=>{const n=new Set(p); n.has(s.id)?n.delete(s.id):n.add(s.id); return n})} />
                ))}
              </Section>
            )}
            {groups.map((g) => {
              const items = filtered.filter((s) => s.group === g && !s.pinned)
              if (!items.length) return null
              return (
                <Section key={g} label="Lịch sử backend · mỗi mục một lượt hỏi">
                  {items.map((s) => (
                    <SessionItem key={s.id} s={s} active={s.id === activeId} onClick={() => { setActiveId(s.id); if(window.innerWidth<768)setShowList(false) }} onPin={() => setPinned(p=>{const n=new Set(p); n.has(s.id)?n.delete(s.id):n.add(s.id); return n})} />
                  ))}
                </Section>
              )
            })}
            {!filtered.length && <p className="px-3 py-6 text-xs text-muted">Không tìm thấy cuộc trò chuyện.</p>}
          </div>
        </aside>
      )}

      {/* Conversation */}
      <div className="flex-1 flex flex-col min-w-0">
        <header className="h-14 shrink-0 flex items-center justify-between px-4 border-b border-line/70 bg-bg/85 backdrop-blur">
          <div className="flex items-center gap-2 min-w-0">
            <button
              onClick={() => setShowList((v) => !v)}
              className="p-2 rounded-lg text-muted hover:bg-selected"
              title={showList ? 'Ẩn danh sách' : 'Hiện danh sách'}
            >
              <Icon d={ic.panel} />
            </button>
            <h1 className="font-sans font-semibold text-[15px] text-navy truncate">{active?.title ?? 'Cuộc trò chuyện mới'}</h1>
          </div>
        </header>

        <div className="px-4"><Notice error={data.requestError || task.error} /><Notice error={data.error} retry={chat.load} />{notice && <p role="status" className="py-2 text-xs text-muted">{notice}</p>}</div>
        {!active ? (
          /* Empty state */
          <div className="flex-1 flex flex-col items-center justify-center px-4 pb-24">
            <div className="w-full max-w-2xl">
              <h2 className="font-sans font-semibold text-[34px] tracking-normal text-center text-navy mb-8">
                <span className="text-accent-strong">✻</span> Hôm nay bạn muốn tra cứu gì?
              </h2>
              {composer}
              <div className="mt-4 flex flex-wrap justify-center gap-2">
                {starters.map((s) => (
                  <button
                    key={s.label}
                    onClick={() => send(s.q)}
                    className="px-3 py-1.5 rounded-lg border border-line text-[13px] text-text-secondary hover:bg-selected transition-colors"
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <>
            <div className="flex-1 overflow-y-auto">
              <div className="mx-auto w-full max-w-2xl px-4 py-8 space-y-10">
                {messages.length === 0 && (
                  <p className="text-center text-sm text-muted py-12">Cuộc trò chuyện này chưa có tin nhắn.</p>
                )}
                {messages.map((m, i) =>
                  m.role === 'user' ? (
                    <div key={i} className="flex justify-end">
                      <div className="max-w-[78%] px-4 py-3 rounded-[20px] rounded-br-md bg-selected border border-accent/20 text-[15px] leading-relaxed text-navy">
                        {m.text}
                      </div>
                    </div>
                  ) : (
                    <div key={i} className="group">
                      <div className="mb-3 flex items-center gap-2 text-[12.5px] font-semibold text-navy">
                        <span className="w-7 h-7 grid place-items-center rounded-lg bg-surface border border-line shadow-2xs">
                          <LogoMark size={15} />
                        </span>
                        Trợ lý LuậtGT
                        <span className="font-normal text-muted">· trích từ {m.citations?.length ?? 0} văn bản</span>
                      </div>
                      <p role="status" className="text-xs text-muted">{m.status}</p>{m.rich?<RichAnswer text={m.text}/>:<p className="font-sans text-[16px] leading-[1.7] text-navy whitespace-pre-wrap break-words">{m.text}</p>}
                      {m.citations && m.citations.length > 0 && (
                        <div className="mt-3 flex flex-wrap gap-2">
                          {m.citations.map((citation, referenceIndex) => {
                            const isSelected = selectedCitation?.sessionId === activeId
                              && selectedCitation.messageIndex === i
                              && selectedCitation.referenceIndex === referenceIndex
                            return (
                              <button
                                key={`${citation.title}-${citation.clause}`}
                                type="button"
                                onClick={(event) => {
                                  if (!active) return
                                  citationTriggerRef.current = event.currentTarget
                                  sourceRequest.current++; setSource(undefined); setSourceError(''); setSourceBusy(false); setSelectedCitation({ sessionId: active.id, messageIndex: i, referenceIndex })
                                }}
                                aria-controls={isSelected ? 'legal-citation-panel' : undefined}
                                aria-expanded={isSelected}
                                className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 font-medium text-left text-xs text-accent-strong transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${isSelected ? 'border-accent bg-selected' : 'border-line bg-surface hover:border-accent/60 hover:bg-selected'}`}
                              >
                                <Icon d={ic.book} className="w-3.5 h-3.5 shrink-0" />
                                <span>{citation.label}</span>
                              </button>
                            )
                          })}
                        </div>
                      )}
                      <div className="mt-4 pt-3 border-t border-dashed border-line flex flex-wrap items-center gap-1 text-muted opacity-70 group-hover:opacity-100 transition-opacity">
                        {[
                          { d: ic.copy, t: 'Sao chép' },
                          { d: ic.up, t: 'Hữu ích' },
                          { d: ic.retry, t: 'Tạo lại' },
                          { d: ic.up, t: 'WRONG' },
                          { d: ic.up, t: 'NO_BASIS' },
                          { d: ic.up, t: 'OUTDATED' },
                        ].map((a) => (
                          <button disabled={blocked} onClick={() => messageAction(a.t,m.text)} key={a.t} aria-label={a.t} title={a.t} className="p-1.5 rounded-md hover:bg-selected hover:text-navy">
                            <Icon d={a.d} className="w-3.5 h-3.5" />
                          </button>
                        ))}
                        <button onClick={() => { setNotice("Demo: sinh câu luyện tập chưa có API. Trang ôn thi dùng câu hỏi đã xuất bản."); nav("/on-thi") }} title="Demo: chưa có API sinh câu" className="ml-auto inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-line text-xs font-medium text-accent-strong hover:bg-selected hover:border-accent/60">
                          <span aria-hidden>✻</span> Tạo 5 câu luyện tập
                        </button>
                      </div>
                    </div>
                  )
                )}
                {thinking && (
                  <div className="flex items-center gap-2 text-sm text-muted">
                    <span className="text-accent-strong animate-spin [animation-duration:2.4s]">✻</span>
                    Đang tra cứu văn bản…
                  </div>
                )}
                <div ref={endRef} />
              </div>
            </div>

            <div className="mx-auto w-full max-w-2xl px-4 pb-3">
              {composer}
              <p className="mt-2 text-center text-[11px] text-muted">
                Nội dung mang tính tham khảo, không thay thế tư vấn pháp lý chính thức.
              </p>
            </div>
          </>
        )}
      </div>

      {/* Legal refs */}
      {selectedReference && (
        <aside id="legal-citation-panel" aria-label="Nguồn trích dẫn" className="absolute inset-y-0 right-0 z-20 w-80 max-w-full shrink-0 border-l border-line bg-sidebar flex flex-col shadow-lg lg:static lg:shadow-none">
          <div className="h-14 shrink-0 flex items-center justify-between gap-2 px-4 text-[13px] font-semibold text-navy border-b border-line">
            <span>Nguồn trích dẫn</span>
            <button
              ref={citationCloseRef}
              type="button"
              onClick={() => {
                sourceRequest.current++; setSelectedCitation(null)
                citationTriggerRef.current?.focus()
              }}
              aria-label="Đóng nguồn trích dẫn"
              className="p-2 rounded-lg text-muted hover:bg-selected hover:text-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              <Icon d={ic.close} />
            </button>
          </div>
          <div className="p-4 overflow-y-auto" aria-live="polite">
            <div className="rounded-xl border border-line bg-surface p-4 shadow-2xs">
              <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wider text-muted mb-3">
                <Icon d={ic.book} className="w-3.5 h-3.5" />
                Căn cứ pháp lý
              </div>
              <h2 className="text-[15px] font-semibold leading-relaxed text-navy mb-3">{selectedReference.title}</h2>
              <p className="text-xs text-muted leading-relaxed">{selectedReference.clause}</p>
              <blockquote className="mt-3 text-sm whitespace-pre-wrap break-words">{selectedReference.raw.quote}</blockquote>
              <button disabled={sourceBusy} onClick={() => void readSource()} className="mt-3 border border-line rounded-lg px-3 py-2 text-xs">Đối chiếu chi tiết nguồn</button><Notice error={sourceError} />
              {source && <details open className="mt-3 text-xs"><summary>{source.title} · {source.number} · {source.unitType}</summary><p className="whitespace-pre-wrap mt-2">{source.text}</p><p>Trích đoạn khớp nguồn; không xác nhận hiệu lực hiện hành.</p></details>}
            </div>
          </div>
        </aside>
      )}
    </div>
  )
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mt-3">
      <p className="px-3 pb-1 text-[11px] font-medium text-muted">{label}</p>
      <div className="space-y-px">{children}</div>
    </div>
  )
}

function SessionItem({ s, active, onClick, onPin }: { s: Session; active: boolean; onClick: () => void; onPin: () => void }) {
  return (
    <div
      onClick={onClick}
      className={`group flex items-center gap-2 px-3 py-1.5 rounded-lg cursor-pointer text-[13px] transition-colors ${
        active ? 'bg-selected text-navy font-medium' : 'text-text-secondary hover:bg-selected'
      }`}
    >
      <span className="flex-1 truncate">{s.title}</span>
      <button
        onClick={(e) => {e.stopPropagation(); onPin()}}
        className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-muted hover:text-navy"
        aria-label="Ghim trong phiên giao diện"
      >
        <Icon d={ic.dots} />
      </button>
    </div>
  )
}
