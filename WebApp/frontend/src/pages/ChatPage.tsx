import { useLocation, useSearchParams } from "react-router-dom";
import { Notice, useTask } from "./shared/shared";
import {
  citationAnswerPrefix,
  citationOriginalUrl,
  createChat,
  chatView,
  loadCitationDocument,
  loadCitationSource,
} from "./shared/chat-state";
import LogoMark from "../components/LogoMark";
import { Button, LoadingIndicator, Modal, inputCls } from "../admin/ui";
import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type RefObject,
} from "react";

interface LegalReference {
  title: string;
  clause: string;
  label: string;
  originalUrl?: string;
  raw: Parameters<typeof loadCitationSource>[0];
}

interface Message {
  turnId: string;
  role: "user" | "bot";
  text: string;
  status?: string;
  mode?: string;
  understoodQuestion?: string;
  citations?: LegalReference[];
}

interface Session {
  id: string;
  title: string;
  messages: Message[];
}

function Icon({ d, className = "w-4 h-4" }: { d: string; className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d={d} />
    </svg>
  );
}

const ic = {
  plus: "M12 5v14M5 12h14",
  search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4",
  panel: "M4 5h16v14H4zM9 5v14",
  book: "M5 4h10a4 4 0 0 1 4 4v12H9a4 4 0 0 1-4-4zM5 16a4 4 0 0 1 4-4h10",
  send: "M12 19V5M6 11l6-6 6 6",
  dots: "M5 12h.01M12 12h.01M19 12h.01",
  retry: "M4 12a8 8 0 1 0 3-6.2M4 4v4h4",
  close: "M6 6l12 12M18 6 6 18",
};

export default function ChatPage() {
  const [chat] = useState(createChat);
  const data = useSyncExternalStore(chat.subscribe, chat.getSnapshot);
  const task = useTask();
  const location = useLocation();
  const [params, setParams] = useSearchParams();

  const activeId = params.get("c");
  const urlQ = params.get("q") ?? "";
  const rawCite = params.get("cite");
  const citeMatch = rawCite?.match(/^(?:([^:]+):)?(\d+)$/);
  const citeIndex = citeMatch ? Number(citeMatch[2]) : null;

  const [notice, setNotice] = useState("");
  const [deleting, setDeleting] = useState<Session | null>(null);
  const [renaming, setRenaming] = useState<Session | null>(null);
  const [title, setTitle] = useState("");
  const [blankChat, setBlankChat] = useState(0);
  const [startingDraft, setStartingDraft] = useState<string>();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const draftKey = activeId ?? `new:${blankChat}`;
  const input = drafts[draftKey] ?? "";
  const [query, setQuery] = useState(urlQ);
  const [showList, setShowList] = useState(() => window.innerWidth >= 768);
  const historyRef = useRef<HTMLElement>(null);

  function setInput(value: string) {
    setDrafts((previous) => ({ ...previous, [draftKey]: value }));
  }

  useEffect(() => {
    setQuery(urlQ);
  }, [urlQ]);

  function updateUrl(patch: Record<string, string | null>, replace = false) {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const [k, v] of Object.entries(patch)) {
          if (v === null || v === "") next.delete(k);
          else next.set(k, v);
        }
        return next;
      },
      { replace },
    );
  }

  const sessions = useMemo(() => {
    const byId = new Map<string, Session>();
    for (const row of data.rows) {
      const id = row.conversationId ?? row.id;
      let session = byId.get(id);
      if (!session) {
        session = {
          id,
          title: row.question,
          messages: [],
        };
        byId.set(id, session);
      }
      if (row.id === id) session.title = row.conversationTitle?.trim() || row.question;
      const view = chatView(row);
      session.messages.push(
        {
          turnId: row.id,
          role: "bot",
          mode: row.mode,
          understoodQuestion: row.understoodQuestion,
          text: view.answer,
          status: view.status,
          citations: view.citations.map((c) => ({
            title:
              typeof c.source?.document_metadata.title === "string" &&
              c.source.document_metadata.title.trim()
                ? c.source.document_metadata.title
                : c.doc_id,
            clause: c.unit_id ?? c.sign_id ?? "",
            label: `${c.doc_id}${c.unit_id || c.sign_id ? ` · ${c.unit_id ?? c.sign_id}` : ""}`,
            originalUrl: citationOriginalUrl(c),
            raw: c,
          })),
        },
        { turnId: row.id, role: "user", text: row.question },
      );
    }
    for (const session of byId.values()) session.messages.reverse();
    return [...byId.values()];
  }, [data.rows]);

  useEffect(() => {
    void chat.load(activeId ?? undefined);
    return () => chat.dispose();
  }, [chat]);

  useEffect(() => {
    if (!startingDraft || !data.currentId) return;
    if (!activeId && startingDraft === draftKey) updateUrl({ c: data.currentId, cite: null });
    setStartingDraft(undefined);
  }, [activeId, data.currentId, draftKey, startingDraft]);

  useEffect(() => {
    const q = location.state?.initialQuery;
    if (typeof q === "string") setInput(q);
  }, [location.state]);

  const requestHere =
    data.currentId === (activeId ?? undefined) && (activeId !== null || startingDraft === draftKey);
  const thinking = data.busy && requestHere;
  const historyBusy = data.loading || data.loadingMore || task.busy;
  const blocked = data.busy || historyBusy;
  const deleteBlocked = (id: string) => historyBusy || (data.busy && data.currentId === id);
  const endRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const citationTriggerRef = useRef<HTMLButtonElement | null>(null);
  const citationCloseRef = useRef<HTMLButtonElement>(null);

  const active = sessions.find((s) => s.id === activeId) ?? null;
  const messages = active?.messages ?? [];
  const citationTurn = citeMatch?.[1] ?? activeId;
  const references = messages.find((message) => message.role === "bot" && message.turnId === citationTurn)
    ?.citations;
  const selectedReference = citeIndex !== null ? references?.[citeIndex] : undefined;
  const selectedCitation = selectedReference?.raw;

  const filtered = useMemo(
    () => sessions.filter((s) => s.title.toLowerCase().includes(query.toLowerCase())),
    [sessions, query],
  );

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, thinking]);

  useEffect(() => {
    if (!selectedCitation) return;
    citationCloseRef.current?.focus();
    function handleEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        updateUrl({ cite: null });
        citationTriggerRef.current?.focus();
      }
    }
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [selectedCitation, activeId, citeIndex]);

  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
  }, [input]);

  function newChat() {
    setBlankChat((previous) => previous + 1);
    updateUrl({ c: null, cite: null });
  }

  function send() {
    if (blocked || (activeId && !active) || !input.trim() || input.length > 4000) return;
    setStartingDraft(activeId ? undefined : draftKey);
    if (window.innerWidth < 768) setShowList(false);
    void chat.submit(input, active?.id, (id) => {
      setDrafts((previous) => {
        const draft = previous[draftKey];
        if (draftKey === id && draft !== input) return previous;
        const next = { ...previous };
        delete next[draftKey];
        if (draft && draft !== input) next[id] = draft;
        return next;
      });
    });
  }

  function openCitation(turnId: string, index: number, trigger: HTMLButtonElement) {
    citationTriggerRef.current = trigger;
    if (turnId === citationTurn && index === citeIndex) citationCloseRef.current?.focus();
    else updateUrl({ cite: `${turnId}:${index}` });
  }

  function answerText(message: Message, text = message.text) {
    const citations = message.citations ?? [];
    const prefix = citationAnswerPrefix(
      text,
      citations.map((citation) => citation.raw),
    );
    if (prefix === undefined) {
      if (!citations.length || !/\[\d+\]/.test(text)) return text;
      return text.split(/(\[\d+\])/g).map((part, index) => {
        const reference = /^\[(\d+)\]$/.exec(part);
        const citationIndex = reference ? Number(reference[1]) - 1 : -1;
        const citation = citations[citationIndex];
        return citation ? (
          <button
            type="button"
            key={index}
            onClick={(event) => openCitation(message.turnId, citationIndex, event.currentTarget)}
            aria-label={"Trích dẫn " + (citationIndex + 1) + " – " + citation.label}
            className="mx-1 inline-block text-sm font-semibold text-accent-strong underline"
          >
            {part}
          </button>
        ) : part;
      });
    }
    return (
      <>
        {prefix}
        {citations.map((citation, index) => (
          <Fragment key={index}>
            {index > 0 && "\n\n"}
            {citation.raw.quote}
            <button
              type="button"
              onClick={(event) => openCitation(message.turnId, index, event.currentTarget)}
              aria-label={`Trích dẫn ${index + 1} – ${citation.label}`}
              aria-expanded={citationTurn === message.turnId && citeIndex === index}
              aria-controls={
                citationTurn === message.turnId && citeIndex === index
                  ? "legal-citation-panel"
                  : undefined
              }
              title={`${citation.title}\n${citation.raw.quote.slice(0, 180)}${citation.raw.quote.length > 180 ? "…" : ""}`}
              className={`mx-1 inline-block rounded px-1.5 py-0.5 align-super text-xs font-semibold leading-none hover:bg-accent hover:text-navy focus-visible:outline-2 focus-visible:outline-accent-strong ${
                citationTurn === message.turnId && citeIndex === index
                  ? "bg-accent text-navy"
                  : "bg-selected text-accent-strong"
              }`}
            >
              {index + 1}
            </button>
          </Fragment>
        ))}
      </>
    );
  }

  function answerBody(message: Message) {
    if (message.mode === "cases") {
      return message.text.split("\n\n").map((group, index) => {
        const headingEnd = group.indexOf("\n");
        if (headingEnd < 0) return <p key={index}>{answerText(message, group)}</p>;
        return (
          <section key={index}>
            <h3 className="font-semibold">{group.slice(0, headingEnd)}</h3>
            <p>{answerText(message, group.slice(headingEnd + 1))}</p>
          </section>
        );
      });
    }
    if (message.mode === "related") {
      const [sources, ...notes] = message.text.split("\n\n");
      return (
        <>
          <ul className="list-disc pl-5">
            {sources.split("\n").map((source, index) => (
              <li key={index}>{answerText(message, source)}</li>
            ))}
          </ul>
          {notes.map((note, index) => <p key={index}>{answerText(message, note)}</p>)}
        </>
      );
    }
    return <p>{answerText(message)}</p>;
  }

  function handleKey(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
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
        placeholder={active ? "Hỏi tiếp…" : "Hỏi về luật giao thông hoặc thi bằng lái…"}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={handleKey}
      />
      <div className="flex flex-wrap items-center justify-end gap-2 px-3 pb-3">
        {thinking && (
          <button
            type="button"
            onClick={() => void chat.cancel()}
            disabled={data.stopping}
            className="border border-line rounded-lg px-3 py-2 text-xs disabled:opacity-50"
          >
            {data.stopping ? "Đang dừng…" : "Dừng"}
          </button>
        )}
        <button
          type="button"
          onClick={() => void send()}
          disabled={!input.trim() || blocked || (!!activeId && !active)}
          className="w-9 h-9 grid place-items-center rounded-full bg-navy text-bg transition hover:bg-navy-light disabled:bg-line disabled:text-muted disabled:cursor-not-allowed shadow-xs"
          aria-label="Gửi"
        >
          <Icon d={ic.send} />
        </button>
      </div>
    </div>
  );

  return (
    <div className="relative flex h-full bg-surface">
      {/* Sessions */}
      {showList && (
        <aside
          ref={historyRef}
          aria-label="Lịch sử câu hỏi"
          className="absolute inset-y-0 left-0 z-10 w-64 max-w-full md:static shrink-0 flex flex-col border-r border-line bg-surface shadow-lg md:shadow-none"
        >
          <div className="p-3 space-y-2">
            <Notice
              loading={data.loading}
              error={data.error}
              retry={() => chat.load(activeId ?? undefined)}
            />
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setShowList(false)}
                aria-label="Ẩn lịch sử"
                title="Ẩn lịch sử"
                aria-expanded={true}
                className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-transparent text-navy cursor-pointer hover:bg-selected focus-visible:outline-2 focus-visible:outline-accent-strong"
              >
                <Icon d={ic.panel} className="w-4 h-4" />
              </button>
              <button
                type="button"
                disabled={blocked}
                onClick={() => void chat.load(activeId ?? undefined)}
                aria-label="Tải lại lịch sử"
                title="Tải lại lịch sử"
                className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-transparent text-navy cursor-pointer hover:bg-selected disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-accent-strong"
              >
                <Icon d={ic.retry} className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={newChat}
                aria-label="Cuộc trò chuyện mới"
                title="Cuộc trò chuyện mới"
                className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-transparent text-navy cursor-pointer hover:bg-selected focus-visible:outline-2 focus-visible:outline-accent-strong"
              >
                <Icon d={ic.plus} className="w-4 h-4" />
              </button>
            </div>
            <label className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-line bg-surface text-muted focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/30">
              <Icon d={ic.search} className="w-3.5 h-3.5" />
              <input
                aria-label="Tìm cuộc trò chuyện"
                value={query}
                onChange={(e) => {
                  const v = e.target.value;
                  setQuery(v);
                  updateUrl({ q: v || null }, true);
                }}
                placeholder="Tìm cuộc trò chuyện"
                className="min-w-0 flex-1 bg-transparent text-[13px] outline-none text-navy placeholder-muted"
              />
            </label>
          </div>

          <div className="flex-1 overflow-y-auto px-2 pb-24">
            {filtered.map((session) => (
              <SessionItem
                key={session.id}
                s={session}
                active={session.id === activeId}
                renameDisabled={blocked}
                deleteDisabled={deleteBlocked(session.id)}
                onRename={() => {
                  task.clearError();
                  setTitle(session.title.slice(0, 200));
                  setRenaming(session);
                }}
                onDelete={() => {
                  task.clearError();
                  setDeleting(session);
                }}
                onClick={() => {
                  updateUrl({ c: session.id, cite: null });
                  if (window.innerWidth < 768) setShowList(false);
                }}
              />
            ))}
            {!filtered.length && !data.error && !data.loading && (
              <p className="px-3 py-6 text-xs text-muted">
                {query ? "Không tìm thấy trong lịch sử đã tải." : "Chưa có cuộc trò chuyện."}
              </p>
            )}
            {query && data.nextCursor && (
              <p className="px-3 py-2 text-xs text-muted">
                Tìm trong lịch sử đã tải. Tải thêm để tìm các cuộc trò chuyện cũ.
              </p>
            )}
            <Notice error={data.moreError} />
            {data.nextCursor && (
              <button
                type="button"
                onClick={() => void chat.loadMore()}
                disabled={blocked}
                className="mt-2 w-full rounded-md px-3 py-2 text-[13px] text-text-secondary hover:bg-selected disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-accent-strong"
              >
                {data.loadingMore ? (
                  <LoadingIndicator label="Đang tải thêm lịch sử…" inline />
                ) : data.moreError ? (
                  "Thử tải thêm lại"
                ) : (
                  "Tải thêm"
                )}
              </button>
            )}
          </div>
        </aside>
      )}

      <Modal
        open={!!renaming}
        title="Đổi tên cuộc trò chuyện"
        onClose={() => {
          if (!task.busy) {
            task.clearError();
            setRenaming(null);
          }
        }}
        footer={
          <>
            <Button
              variant="ghost"
              disabled={task.busy}
              onClick={() => {
                task.clearError();
                setRenaming(null);
              }}
            >
              Hủy
            </Button>
            <Button variant="primary" type="submit" form="rename-conversation" disabled={blocked || !title.trim()}>
              Lưu tên
            </Button>
          </>
        }
      >
        <form
          id="rename-conversation"
          onSubmit={(event) => {
            event.preventDefault();
            if (blocked || !renaming) return;
            void task.run(async () => {
              await chat.renameConversation(renaming.id, title);
              setRenaming(null);
              setNotice("Đã đổi tên cuộc trò chuyện.");
            });
          }}
        >
          <label className="block space-y-2 text-sm">
            <span>Tên cuộc trò chuyện</span>
            <input
              className={inputCls}
              value={title}
              required
              maxLength={200}
              disabled={task.busy}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <Notice error={task.error} />
        </form>
      </Modal>
      <Modal
        open={!!deleting}
        title="Xóa cuộc trò chuyện?"
        onClose={() => {
          if (!task.busy) {
            task.clearError();
            setDeleting(null);
          }
        }}
        footer={
          <>
            <Button
              variant="ghost"
              disabled={task.busy}
              onClick={() => {
                task.clearError();
                setDeleting(null);
              }}
            >
              Hủy
            </Button>
            <Button
              variant="danger"
              disabled={!deleting || deleteBlocked(deleting.id)}
              onClick={() => void task.run(async () => {
                if (!deleting) return;
                const id = deleting.id;
                await chat.removeConversation(id);
                if (activeId === id) {
                  setInput("");
                  newChat();
                }
                setDeleting(null);
                setNotice("Đã xóa cuộc trò chuyện khỏi lịch sử.");
              })}
            >
              Xóa cuộc trò chuyện
            </Button>
          </>
        }
      >
        <p className="mb-3 break-words text-sm font-medium text-navy">{deleting?.title}</p>
        <p className="text-sm text-muted">
          Cuộc trò chuyện sẽ được gỡ khỏi lịch sử và không thể mở lại.
          Các phản hồi bạn đã báo cáo vẫn được giữ để quản trị xử lý.
        </p>
        <Notice error={task.error} />
      </Modal>

      {/* Conversation */}
      <div className="flex-1 flex flex-col min-w-0">
        <header className="h-14 shrink-0 flex items-center justify-between px-4 border-b border-line/70 bg-surface">
          <div className="flex items-center gap-2 min-w-0">
            {!showList && (
              <button
                type="button"
                onClick={() => setShowList(true)}
                className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-transparent text-muted cursor-pointer hover:bg-selected focus-visible:outline-2 focus-visible:outline-accent-strong"
                title="Hiện lịch sử"
                aria-label="Hiện lịch sử"
                aria-expanded={false}
              >
                <Icon d={ic.panel} />
              </button>
            )}
            <h1 className="font-sans font-semibold text-[15px] text-navy truncate">
              {active?.title ?? "Cuộc trò chuyện mới"}
            </h1>
          </div>
        </header>

        <div className="px-4">
          <Notice error={(requestHere && data.requestError) || (!deleting && !renaming ? task.error : undefined)} />
          <Notice error={data.error} retry={chat.load} />
          {notice && (
            <p role="status" className="py-2 text-xs text-muted">
              {notice}
            </p>
          )}
        </div>
        {!active ? (
          /* Empty state */
          <div className="flex-1 flex flex-col items-center justify-center px-4 pb-24">
            <div className="w-full max-w-2xl">
              <h2 className="flex items-center justify-center gap-3 font-sans font-semibold text-2xl sm:text-3xl tracking-normal text-center text-navy mb-8">
                <Icon d={ic.book} className="h-7 w-7 shrink-0 text-accent-strong" />
                Tra cứu luật giao thông
              </h2>
              {composer}
            </div>
          </div>
        ) : (
          <>
            <div className="flex-1 overflow-y-auto">
              <div className="mx-auto w-full max-w-2xl px-4 py-8 space-y-10">
                {messages.length === 0 && (
                  <p className="text-center text-sm text-muted py-12">
                    Cuộc trò chuyện này chưa có tin nhắn.
                  </p>
                )}
                {messages.map((m, i) =>
                  m.role === "user" ? (
                    <div key={i} className="flex justify-end">
                      <div className="max-w-[78%] px-4 py-3 rounded-[20px] rounded-br-md bg-selected border border-accent/20 text-[15px] leading-relaxed text-navy">
                        {m.text}
                      </div>
                    </div>
                  ) : (
                    <div key={i}>
                      <div className="mb-3 flex items-center gap-2 text-[12.5px] font-semibold text-navy">
                        <span className="w-7 h-7 grid place-items-center rounded-lg bg-surface border border-line shadow-2xs">
                          <LogoMark size={15} />
                        </span>
                        Trợ lý LuậtGT
                        {m.citations && m.citations.length > 0 && (
                          <span className="font-normal text-muted">
                            · {m.citations.length} trích dẫn
                          </span>
                        )}
                      </div>
                      <p role="status" className="text-xs text-muted">
                        {m.status}
                      </p>
                      {m.understoodQuestion && (
                        <p className="text-sm text-muted">Hiểu là: {m.understoodQuestion}</p>
                      )}
                      <div className="space-y-3 font-sans text-[16px] leading-[1.7] text-navy whitespace-pre-wrap break-words">
                        {answerBody(m)}
                      </div>
                      {m.citations && m.citations.length > 0 && /\[\d+\]/.test(m.text) && (
                        <details className="mt-3 text-sm text-navy">
                          <summary className="cursor-pointer font-medium">Nguyên văn trích dẫn</summary>
                          {m.citations.map((citation, index) => (
                            <blockquote key={index} className="mt-2 whitespace-pre-wrap border-l border-line pl-3">
                              <span className="font-medium">[{index + 1}] {citation.label}</span>
                              {"\n"}{citation.raw.quote}
                            </blockquote>
                          ))}
                        </details>
                      )}
                      {!!m.citations?.length && (
                        <div className="mt-3 flex flex-wrap gap-2">
                          {m.citations.map((citation, referenceIndex) => {
                            const isSelected =
                              citationTurn === m.turnId && citeIndex === referenceIndex;
                            return (
                              <div
                                key={`${citation.title}-${citation.clause}-${referenceIndex}`}
                                className="inline-flex max-w-full items-center gap-1"
                              >
                                <button
                                  type="button"
                                  onClick={(event) =>
                                    openCitation(m.turnId, referenceIndex, event.currentTarget)
                                  }
                                  aria-controls={isSelected ? "legal-citation-panel" : undefined}
                                  aria-expanded={isSelected}
                                  className={`inline-flex min-w-0 items-center gap-1.5 rounded-full border px-3 py-1.5 font-medium text-left text-xs text-accent-strong transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
                                    isSelected
                                      ? "border-accent bg-selected"
                                      : "border-line bg-surface hover:border-accent/60 hover:bg-selected"
                                  }`}
                                >
                                  <span className="shrink-0 font-semibold">
                                    [{referenceIndex + 1}]
                                  </span>
                                  <span className="[overflow-wrap:anywhere]">{citation.label}</span>
                                </button>
                                {citation.originalUrl && (
                                  <a
                                    href={citation.originalUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    aria-label={`Mở văn bản gốc: ${citation.title}, trích dẫn ${referenceIndex + 1}`}
                                    className="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-accent-strong hover:bg-selected hover:underline focus-visible:outline-2 focus-visible:outline-accent-strong"
                                  >
                                    Bản gốc <span aria-hidden="true">↗</span>
                                  </a>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  ),
                )}
                {thinking && (
                  <div className="flex items-center gap-2 text-sm text-muted">
                    <span className="text-accent-strong animate-spin [animation-duration:2.4s]">
                      ✻
                    </span>
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
        <CitationSource
          reference={selectedReference}
          citations={data.rows.find((row) => row.id === citationTurn)?.citations}
          historyRef={showList ? historyRef : undefined}
          closeRef={citationCloseRef}
          onClose={() => {
            updateUrl({ cite: null });
            citationTriggerRef.current?.focus();
          }}
        />
      )}
    </div>
  );
}

function reflowSourceText(text: string) {
  // Join likely PDF line wraps, keeping blank lines and the starts of legal list items.
  return text.replace(/([\p{L}\p{N},)])[ \t]*\n[ \t]*(?=\p{Ll}{2,}|\d+[ \t]+\p{Ll})/gu, "$1 ");
}

function formatSourceText(text: string) {
  return text.replace(/\n(?:[ \t]*\n){2,}/g, "\n\n")
    .split(/(^#{1,6}[ \t]+[^\n]+)/m)
    .map((part, index) => index % 2
      ? <strong key={index} className="font-semibold text-navy">{part.replace(/^#{1,6}[ \t]+/, "")}</strong>
      : reflowSourceText(part));
}

function CitationSource({ reference, citations, historyRef, closeRef, onClose }: {
  reference: LegalReference;
  citations?: LegalReference["raw"][];
  historyRef?: RefObject<HTMLElement | null>;
  closeRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
}) {
  const { raw: citation } = reference;
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{
    citation: typeof citation;
    source?: Awaited<ReturnType<typeof loadCitationSource>>;
    document?: Awaited<ReturnType<typeof loadCitationDocument>>;
  }>();
  const panelRef = useRef<HTMLElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const markRef = useRef<HTMLElement>(null);
  const drag = useRef<{ x: number; width: number; keepQuote: boolean } | null>(null);
  const keepQuote = useRef(false);
  const minWidth = 320;
  const maxReaderWidth = 680;
  const minChatWidth = 360;
  const [width, setWidth] = useState(440);
  const [availableWidth, setAvailableWidth] = useState(maxReaderWidth + minChatWidth);
  const docked = availableWidth >= minWidth + minChatWidth;
  const maxWidth = docked ? Math.min(maxReaderWidth, availableWidth - minChatWidth) : maxReaderWidth;
  const panelWidth = Math.min(width, maxWidth);
  const loaded = result?.citation === citation ? result : undefined;
  const source = loaded?.source;
  const originalUrl = reference.originalUrl ?? source?.originalUrl;
  const document = loaded?.document;

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    loadCitationSource(citation).then(
      async (source) => {
        if (cancelled) return;
        const document = await loadCitationDocument(citation, citations ?? [], controller.signal)
          .catch(() => undefined);
        if (!cancelled) setResult({ citation, source, document });
      },
      () => {
        if (!cancelled) setResult({ citation });
      },
    );
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [citation, citations, attempt]);

  useLayoutEffect(() => {
    const layout = panelRef.current?.parentElement;
    if (!layout) return;
    const history = historyRef?.current;
    const measure = () => setAvailableWidth(layout.clientWidth - (history?.offsetWidth ?? 0));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(layout);
    if (history) observer.observe(history);
    return () => observer.disconnect();
  }, [historyRef]);

  const scrollToQuote = useCallback((behavior?: ScrollBehavior) => {
    const container = scrollRef.current;
    const mark = markRef.current;
    if (!container || !mark) return;
    container.scrollTo({
      top: container.scrollTop + mark.getBoundingClientRect().top -
        container.getBoundingClientRect().top - container.clientHeight / 3,
      behavior: behavior ?? (window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth"),
    });
  }, []);

  useLayoutEffect(() => {
    if (!keepQuote.current) return;
    keepQuote.current = false;
    scrollToQuote("instant");
  }, [panelWidth, scrollToQuote]);

  useEffect(() => {
    if (!source || !markRef.current) return;
    let cancelled = false;
    // Font loading can shift a citation thousands of pixels down a long document.
    void globalThis.document.fonts.ready.then(() => {
      if (!cancelled) scrollToQuote();
    });
    return () => {
      cancelled = true;
    };
  }, [source, document, scrollToQuote]);

  function quoteInView() {
    const mark = markRef.current?.getBoundingClientRect();
    const viewport = scrollRef.current?.getBoundingClientRect();
    return !!(mark && viewport && mark.top < viewport.bottom && mark.bottom > viewport.top);
  }

  function resize(next: number, alignQuote: boolean) {
    const clamped = Math.max(minWidth, Math.min(maxWidth, Math.round(next)));
    if (clamped === panelWidth) return;
    keepQuote.current = alignQuote;
    setWidth(clamped);
  }

  const text = document?.text ?? source?.text ?? citation.quote;
  const start = document?.start ?? (source ? text.indexOf(citation.quote) : -1);
  const end = document?.end ?? start + citation.quote.length;
  const before = useMemo(
    () => formatSourceText((start < 0 ? text : text.slice(0, start)).replace(/^(?:[ \t]*\n)+/, "")),
    [text, start],
  );
  const after = useMemo(() => start >= 0 ? formatSourceText(text.slice(end)) : null, [text, start, end]);
  const metadata = source && citation.source?.metadata;
  const location = metadata && [
    ["Điều", metadata.dieu_number],
    ["Khoản", metadata.khoan_number],
    ["Điểm", metadata.diem_letter],
  ].filter(([, value]) => typeof value === "string" && value.trim())
    .map(([label, value]) => `${label} ${value}`).join(" · ");
  return (
    <aside
      ref={panelRef}
      id="legal-citation-panel"
      aria-label="Nguồn trích dẫn"
      style={{ "--citation-width": `${panelWidth}px` } as CSSProperties}
      className={`fixed inset-0 z-40 flex w-full shrink-0 flex-col bg-surface lg:w-[var(--citation-width)] lg:border-l lg:border-line ${
        docked ? "lg:relative lg:inset-auto" : "lg:absolute lg:left-auto lg:shadow-lg"
      }`}
    >
      <div
        role="separator"
        tabIndex={0}
        aria-label="Độ rộng khung nguồn"
        aria-orientation="vertical"
        aria-controls="legal-citation-content"
        aria-valuemin={minWidth}
        aria-valuemax={maxWidth}
        aria-valuenow={panelWidth}
        onPointerDown={(event) => {
          if (event.button !== 0 || !event.isPrimary) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { x: event.clientX, width: panelWidth, keepQuote: quoteInView() };
          event.currentTarget.focus({ preventScroll: true });
          event.preventDefault();
        }}
        onPointerMove={(event) => {
          const initial = drag.current;
          if (initial && event.currentTarget.hasPointerCapture(event.pointerId))
            resize(initial.width + initial.x - event.clientX, initial.keepQuote);
        }}
        onLostPointerCapture={() => { drag.current = null; }}
        onKeyDown={(event) => {
          const widths: Record<string, number> = {
            ArrowLeft: panelWidth + 32, ArrowRight: panelWidth - 32, Home: minWidth, End: maxWidth,
          };
          const next = widths[event.key];
          if (typeof next !== "number") return;
          event.preventDefault();
          resize(next, quoteInView());
        }}
        className="group absolute inset-y-0 -left-2 z-10 hidden w-4 touch-none cursor-col-resize select-none items-center justify-center focus-visible:outline-2 focus-visible:outline-accent-strong lg:flex"
      >
        <span aria-hidden="true" className="h-10 w-1 rounded-full bg-control group-hover:bg-accent-strong group-focus-visible:bg-accent-strong" />
      </div>
      <header className="shrink-0 border-b border-line px-5 pb-3 pt-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="mb-1 text-xs font-medium text-muted">Nguồn trích dẫn</p>
            <h2 className="break-words text-base font-semibold text-navy">{source?.number ?? citation.doc_id}</h2>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Đóng nguồn trích dẫn"
            className="shrink-0 rounded-lg p-2 text-muted hover:bg-selected hover:text-navy focus-visible:outline-2 focus-visible:outline-accent-strong"
          >
            <Icon d={ic.close} />
          </button>
        </div>
        <p className="mt-1.5 break-words text-sm leading-relaxed text-text-secondary">
          {source?.title ?? reference.title}
        </p>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          <span role="status" className="text-xs text-muted">
            {[document ? "Toàn văn" : loaded ? "Đoạn trích đã lưu" : "Đang tải nguồn…", location]
              .filter(Boolean).join(" · ")}
          </span>
          <div className="flex flex-wrap items-center gap-1">
            {originalUrl && (
              <a
                href={originalUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-md px-2 py-1 text-xs font-semibold text-accent-strong hover:bg-selected hover:underline focus-visible:outline-2 focus-visible:outline-accent-strong"
              >
                Mở văn bản gốc <span aria-hidden="true">↗</span>
              </a>
            )}
            {start >= 0 && (
              <button
                type="button"
                onClick={() => scrollToQuote()}
                className="rounded-md px-2 py-1 text-xs font-semibold text-accent-strong hover:bg-selected focus-visible:outline-2 focus-visible:outline-accent-strong"
              >
                Về đoạn trích
              </button>
            )}
          </div>
        </div>
      </header>
      <div id="legal-citation-content" ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4 lg:px-6">
        {source && !document && (
          <p className="mb-3 text-xs text-muted">
            Chưa định vị được trích dẫn trong toàn văn. Đang hiển thị đoạn nguồn đã lưu.
          </p>
        )}
        <blockquote className="whitespace-pre-wrap break-words text-[15px] leading-[1.75] text-text-secondary">
          {before}
          {start >= 0 && (
            <>
              <mark
                ref={markRef}
                className="rounded-sm bg-amber-200/85 text-navy [box-decoration-break:clone]"
              >
                {reflowSourceText(text.slice(start, end))}
              </mark>
              {after}
            </>
          )}
        </blockquote>
        {source && (
          <p className="mt-3 text-xs text-muted">
            Trích đoạn khớp nguồn; không xác nhận hiệu lực hiện hành.
          </p>
        )}
        <Notice
          loading={!loaded}
          error={
            loaded && !source
              ? "Chi tiết nguồn chưa khả dụng hoặc không khớp trích đoạn. Đang hiển thị trích đoạn đã lưu."
              : undefined
          }
          retry={() => {
            setResult(undefined);
            setAttempt(attempt + 1);
          }}
        />
      </div>
    </aside>
  );
}

function SessionItem({
  s,
  active,
  onClick,
  renameDisabled,
  deleteDisabled,
  onRename,
  onDelete,
}: {
  s: Session;
  active: boolean;
  onClick: () => void;
  renameDisabled: boolean;
  deleteDisabled: boolean;
  onRename: () => void;
  onDelete: () => void;
}) {
  const menuId = useId();
  const menuRef = useRef<HTMLDivElement>(null);
  const actionClass =
    "block w-full rounded px-3 py-2 text-left text-sm disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-accent-strong";
  return (
    <div className={`flex items-center rounded-lg ${active ? "bg-selected" : "hover:bg-selected"}`}>
      <button
        type="button"
        onClick={onClick}
        aria-current={active ? "true" : undefined}
        title={s.title}
        className={`block min-w-0 flex-1 truncate px-3 py-1.5 rounded-lg text-left text-[13px] transition-colors focus-visible:outline-2 focus-visible:outline-accent-strong ${
          active ? "text-navy font-medium" : "text-text-secondary"
        }`}
      >
        {s.title}
      </button>
      <button
        type="button"
        popoverTarget={menuId}
        title="Tùy chọn cuộc trò chuyện"
        aria-label={`Tùy chọn cuộc trò chuyện ${s.title}`}
        className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-muted hover:bg-hover hover:text-navy focus-visible:outline-2 focus-visible:outline-accent-strong"
      >
        <Icon d={ic.dots} />
      </button>
      <div
        ref={menuRef}
        id={menuId}
        popover="auto"
        className="inset-auto m-0 w-40 rounded-md border border-control bg-surface p-1 shadow-md [position-area:bottom_span-left] [position-try-fallbacks:flip-block] [position-visibility:anchors-visible]"
      >
        <button
          type="button"
          disabled={renameDisabled}
          onClick={() => {
            menuRef.current?.hidePopover();
            onRename();
          }}
          aria-label={`Đổi tên cuộc trò chuyện ${s.title}`}
          className={`${actionClass} text-navy hover:bg-hover`}
        >
          Đổi tên
        </button>
        <button
          type="button"
          disabled={deleteDisabled}
          onClick={() => {
            menuRef.current?.hidePopover();
            onDelete();
          }}
          aria-label={`Xóa cuộc trò chuyện ${s.title}`}
          className={`${actionClass} text-red-700 hover:bg-red-50`}
        >
          Xóa
        </button>
      </div>
    </div>
  );
}
