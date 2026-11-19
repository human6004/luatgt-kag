import { useLocation, useSearchParams } from "react-router-dom";
import { api, send as request } from "../api";
import { Notice, useTask } from "./shared/shared";
import {
  citationAnswerPrefix,
  createChat,
  chatView,
  loadCitationSource,
} from "./shared/chat-state";
import LogoMark from "../components/LogoMark";
import { Button, LoadingIndicator, Modal, inputCls } from "../admin/ui";
import { Fragment, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

interface LegalReference {
  title: string;
  clause: string;
  label: string;
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
  copy: "M9 9h10v10H9zM5 15V5h10",
  up: "M7 10v10M7 10l4-6a2 2 0 0 1 3 2l-1 4h5a2 2 0 0 1 2 2l-2 6a2 2 0 0 1-2 2H7",
  retry: "M4 12a8 8 0 1 0 3-6.2M4 4v4h4",
  close: "M6 6l12 12M18 6 6 18",
  dots: "M5 12h.01M12 12h.01M19 12h.01",
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
  const [menuId, setMenuId] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menuId) return;
    function closeOutside(event: PointerEvent) {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target)) setMenuId(null);
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        menuRef.current?.querySelector<HTMLButtonElement>("[aria-expanded]")?.focus();
        setMenuId(null);
      }
    }
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [menuId]);
  const lastSubmittedId = useRef<string | undefined>(undefined);

  const [input, setInput] = useState("");
  const [query, setQuery] = useState(urlQ);
  const [showList, setShowList] = useState(() => window.innerWidth >= 768);

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
    if (data.currentId && data.currentId !== lastSubmittedId.current) {
      lastSubmittedId.current = data.currentId;
      if (data.currentId !== activeId) updateUrl({ c: data.currentId, cite: null });
    }
  }, [data.currentId]);

  useEffect(() => {
    const q = location.state?.initialQuery;
    if (typeof q === "string") setInput(q);
  }, [location.state]);

  const thinking = data.busy;
  const blocked = data.busy || data.loading || data.loadingMore || task.busy;
  const endRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const citationTriggerRef = useRef<HTMLButtonElement | null>(null);
  const citationCloseRef = useRef<HTMLButtonElement>(null);

  const active = sessions.find((s) => s.id === activeId) ?? null;
  const messages = active?.messages ?? [];
  const citationTurn = citeMatch?.[1] ?? activeId;
  const selectedReference =
    citeIndex !== null
      ? messages.find((message) => message.role === "bot" && message.turnId === citationTurn)
          ?.citations?.[citeIndex]
      : undefined;
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
    if (thinking) return;
    updateUrl({ c: null, cite: null });
    setInput("");
  }

  async function send(text = input) {
    if (blocked || (activeId && !active) || !text.trim()) return;
    if (await chat.submit(text, active?.id)) {
      setInput("");
      if (window.innerWidth < 768) setShowList(false);
    }
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

  function messageAction(action: string, message: Message, question: string) {
    if (action === "Sao chép") {
      void navigator.clipboard
        .writeText(message.text)
        .then(() => setNotice("Đã sao chép"))
        .catch(() => setNotice("Không sao chép được"));
      return;
    }
    if (action === "Tạo lại") {
      setInput(question);
      setNotice("Câu hỏi đã đưa vào ô nhập. Gửi để tạo lượt hỏi mới.");
      return;
    }
    if (active) {
      void task.run(async () => {
        await api(
          `/chat/${message.turnId}/feedback`,
          request("POST", { feedback: action === "Hữu ích" ? "HELPFUL" : action, note: "" }),
        );
        setNotice("Đã lưu phản hồi");
      });
    }
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
                disabled={thinking}
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
                disabled={blocked}
                menuOpen={menuId === session.id}
                menuRef={menuId === session.id ? menuRef : undefined}
                onToggleMenu={() => {
                  task.clearError();
                  setMenuId((current) => (current === session.id ? null : session.id));
                }}
                onRename={() => {
                  setMenuId(null);
                  task.clearError();
                  setTitle(session.title.slice(0, 200));
                  setRenaming(session);
                }}
                onDelete={() => {
                  setMenuId(null);
                  task.clearError();
                  setDeleting(session);
                }}
                onClick={() => {
                  setMenuId(null);
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
              disabled={blocked || !deleting}
              onClick={() => void task.run(async () => {
                if (!deleting) return;
                const id = deleting.id;
                await chat.removeConversation(id);
                if (activeId === id) {
                  updateUrl({ c: null, cite: null });
                  setInput("");
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
          <Notice error={data.requestError || (!deleting && !renaming ? task.error : undefined)} />
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
                    <div key={i} className="group">
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
                      {m.citations && m.citations.length > 0 && (
                        <div className="mt-3 flex flex-wrap gap-2">
                          {m.citations.map((citation, referenceIndex) => {
                            const isSelected =
                              citationTurn === m.turnId && citeIndex === referenceIndex;
                            return (
                              <button
                                key={`${citation.title}-${citation.clause}-${referenceIndex}`}
                                type="button"
                                onClick={(event) =>
                                  openCitation(m.turnId, referenceIndex, event.currentTarget)
                                }
                                aria-controls={isSelected ? "legal-citation-panel" : undefined}
                                aria-expanded={isSelected}
                                className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 font-medium text-left text-xs text-accent-strong transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
                                  isSelected
                                    ? "border-accent bg-selected"
                                    : "border-line bg-surface hover:border-accent/60 hover:bg-selected"
                                }`}
                              >
                                <span className="shrink-0 font-semibold">
                                  [{referenceIndex + 1}]
                                </span>
                                <span>{citation.label}</span>
                              </button>
                            );
                          })}
                        </div>
                      )}
                      <div className="mt-4 pt-3 border-t border-dashed border-line flex flex-wrap items-center gap-1 text-muted opacity-70 group-hover:opacity-100 transition-opacity">
                        {[
                          { d: ic.copy, t: "Sao chép" },
                          { d: ic.up, t: "Hữu ích" },
                          { d: ic.retry, t: "Tạo lại" },
                          { d: ic.up, t: "WRONG", label: "Câu trả lời sai" },
                          { d: ic.up, t: "NO_BASIS", label: "Thiếu căn cứ" },
                          {
                            d: ic.up,
                            t: "OUTDATED",
                            label: "Thông tin lỗi thời",
                          },
                        ].map((a) => (
                          <button
                            type="button"
                            disabled={blocked}
                            onClick={() => messageAction(a.t, m, messages[i - 1].text)}
                            key={a.t}
                            aria-label={a.label ?? a.t}
                            title={a.label ?? a.t}
                            className="p-1.5 rounded-md hover:bg-selected hover:text-navy"
                          >
                            <Icon d={a.d} className="w-3.5 h-3.5" />
                          </button>
                        ))}
                      </div>
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
        <aside
          id="legal-citation-panel"
          aria-label="Nguồn trích dẫn"
          className="absolute inset-y-0 right-0 z-20 w-80 max-w-full shrink-0 border-l border-line bg-sidebar flex flex-col shadow-lg lg:static lg:shadow-none"
        >
          <div className="h-14 shrink-0 flex items-center justify-between gap-2 px-4 text-[13px] font-semibold text-navy border-b border-line">
            <span>Nguồn trích dẫn</span>
            <button
              ref={citationCloseRef}
              type="button"
              onClick={() => {
                updateUrl({ cite: null });
                citationTriggerRef.current?.focus();
              }}
              aria-label="Đóng nguồn trích dẫn"
              className="p-2 rounded-lg text-muted hover:bg-selected hover:text-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              <Icon d={ic.close} />
            </button>
          </div>
          <CitationSource key={`${citationTurn}:${citeIndex}`} reference={selectedReference} />
        </aside>
      )}
    </div>
  );
}

function CitationSource({ reference }: { reference: LegalReference }) {
  const { raw: citation } = reference;
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{
    citation: typeof citation;
    source?: Awaited<ReturnType<typeof loadCitationSource>>;
  }>();
  const scrollRef = useRef<HTMLDivElement>(null);
  const markRef = useRef<HTMLElement>(null);
  const loaded = result?.citation === citation ? result : undefined;
  const source = loaded?.source;

  useEffect(() => {
    let cancelled = false;
    loadCitationSource(citation).then(
      (source) => {
        if (!cancelled) setResult({ citation, source });
      },
      () => {
        if (!cancelled) setResult({ citation });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [citation, attempt]);

  useEffect(() => {
    const container = scrollRef.current;
    const mark = markRef.current;
    if (!source || !container || !mark) return;
    container.scrollTo({
      top:
        container.scrollTop +
        mark.getBoundingClientRect().top -
        container.getBoundingClientRect().top -
        container.clientHeight / 3,
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "instant"
        : "smooth",
    });
  }, [source]);

  const text = source?.text ?? citation.quote;
  const start = source ? text.indexOf(citation.quote) : -1;
  return (
    <div ref={scrollRef} className="p-4 overflow-y-auto" aria-live="polite">
      <div className="rounded-xl border border-line bg-surface p-4 shadow-2xs">
        <div className="mb-3 flex items-center gap-2 text-[11px] font-medium uppercase tracking-wider text-muted">
          <Icon d={ic.book} className="w-3.5 h-3.5" />
          Căn cứ pháp lý
        </div>
        <h2 className="mb-3 break-words text-[15px] font-semibold leading-relaxed text-navy">
          {source?.title ?? reference.title}
        </h2>
        <p className="break-words text-xs leading-relaxed text-muted">
          {[source?.number, source?.unitType, reference.clause].filter(Boolean).join(" · ")}
        </p>
        <blockquote className="mt-3 whitespace-pre-wrap break-words text-sm leading-relaxed">
          {start < 0 ? (
            text
          ) : (
            <>
              {text.slice(0, start)}
              <mark
                ref={markRef}
                className="rounded-sm bg-amber-200 text-navy [box-decoration-break:clone]"
              >
                {citation.quote}
              </mark>
              {text.slice(start + citation.quote.length)}
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
    </div>
  );
}

function SessionItem({
  s,
  active,
  onClick,
  disabled,
  menuOpen,
  menuRef,
  onToggleMenu,
  onRename,
  onDelete,
}: {
  s: Session;
  active: boolean;
  onClick: () => void;
  disabled: boolean;
  menuOpen: boolean;
  menuRef?: React.RefObject<HTMLDivElement | null>;
  onToggleMenu: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  return (
    <div className={`relative flex items-center rounded-lg ${active ? "bg-selected" : "hover:bg-selected"}`}>
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
      <div ref={menuRef} className="relative shrink-0">
        <button
          type="button"
          disabled={disabled}
          onClick={onToggleMenu}
          title="Tùy chọn cuộc trò chuyện"
          aria-label={`Tùy chọn cuộc trò chuyện ${s.title}`}
          aria-expanded={menuOpen}
          className="mr-1 grid h-8 w-8 place-items-center rounded-md text-muted hover:bg-hover hover:text-navy disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-accent-strong"
        >
          <Icon d={ic.dots} />
        </button>
        {menuOpen && (
          <div className="absolute right-1 top-full z-30 w-40 rounded-md border border-control bg-surface p-1 shadow-md">
            <button type="button" disabled={disabled} onClick={onRename} className="block w-full rounded px-3 py-2 text-left text-sm text-navy hover:bg-hover focus-visible:outline-2 focus-visible:outline-accent-strong disabled:opacity-40">
              Đổi tên
            </button>
            <button type="button" disabled={disabled} onClick={onDelete} className="block w-full rounded px-3 py-2 text-left text-sm text-red-700 hover:bg-red-50 focus-visible:outline-2 focus-visible:outline-accent-strong disabled:opacity-40">
              Xóa
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
