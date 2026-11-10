import {
  api,
  apiResponse,
  send,
  ApiError,
  type ContentRecord,
} from "../../api.ts";

type Citation = {
  doc_id: string;
  unit_id: string | null;
  sign_id?: string | null;
  quote: string;
  source?: {
    contract_version: string;
    release_id: string;
    source_snapshot_id: string;
    entity_type: string;
    entity_id: string;
    text: string;
    metadata: Record<string, unknown>;
    document_metadata: Record<string, unknown>;
  };
};
type ChatRecord = {
  id: string;
  conversationId?: string;
  question: string;
  answer: string;
  state: string;
  citations: Citation[];
};
type ChatState = {
  rows: ChatRecord[];
  loading: boolean;
  error: string;
  busy: boolean;
  stopping: boolean;
  currentId?: string;
  requestError: string;
  observed:
    | "idle"
    | "answered"
    | "clarify"
    | "abstained"
    | "unavailable"
    | "offline"
    | "error"
    | "cancelled";
};
const unavailableMessage =
  "Dịch vụ tra cứu pháp luật hiện đang gặp sự cố hoặc chưa sẵn sàng. Vui lòng thử lại sau.";

function record(value: unknown): value is ChatRecord {
  if (!value || typeof value !== "object") return false;
  const row = value as ChatRecord;
  return (
    typeof row.id === "string" &&
    !!row.id &&
    (row.conversationId === undefined ||
      (typeof row.conversationId === "string" && !!row.conversationId)) &&
    typeof row.question === "string" &&
    typeof row.answer === "string" &&
    typeof row.state === "string" &&
    Array.isArray(row.citations)
  );
}

export function chatView(row: ChatRecord) {
  const empty = { answer: "", citations: [] as Citation[] };
  if (row.state === "CLARIFY")
    return {
      status: "Cần làm rõ câu hỏi",
      ...empty,
      answer: row.answer.trim().length <= 500 ? row.answer : "",
    };
  if (row.state === "KAG_ABSTAINED")
    return {
      status:
        "Hiện tôi chưa tìm được đủ căn cứ pháp lý được xác minh để trả lời chính xác câu hỏi này.",
      ...empty,
    };
  if (row.state === "UNAVAILABLE")
    return { status: unavailableMessage, ...empty };
  if (row.state === "CANCELLED") return { status: "Đã dừng trả lời", ...empty };
  if (row.state === "PROCESSING") return { status: "Đang trả lời…", ...empty };
  const citationsValid =
    row.citations.length > 0 &&
    row.citations.length <= 20 &&
    row.citations.every(
      (c) =>
        c &&
        typeof c.doc_id === "string" &&
        !!c.doc_id.trim() &&
        typeof c.quote === "string" &&
        !!c.quote.trim() &&
        (c.source
          ? snapshotMatches(c)
          : typeof c.unit_id === "string" && !!c.unit_id.trim()),
    );
  if (row.state !== "ANSWERED" || !row.answer.trim() || !citationsValid)
    return { status: "Chưa có câu trả lời đủ căn cứ.", ...empty };
  return { status: "Đã trả lời", answer: row.answer, citations: row.citations };
}

export function citationAnswerPrefix(
  answer: string,
  citations: Pick<Citation, "quote">[],
) {
  if (!citations.length) return undefined;
  // KAG appends the verified quotes in citation order, separated by blank lines.
  const quotedBody = citations.map((citation) => citation.quote).join("\n\n");
  if (!answer.endsWith(quotedBody)) return undefined;
  const prefix = answer.slice(0, answer.length - quotedBody.length);
  return !prefix || prefix.endsWith("\n") ? prefix : undefined;
}

export async function loadCitationSource(citation: Citation) {
  if (citation.source) {
    if (!snapshotMatches(citation))
      throw new ApiError("Source snapshot mismatch", 502);
    const {
      metadata,
      document_metadata: doc,
      entity_type: kind,
    } = citation.source;
    let unitType = kind.endsWith(".LegalUnit")
      ? String(metadata.unit_type ?? "Đơn vị pháp lý")
      : "Văn bản";
    if (kind.endsWith(".TrafficSign")) {
      const labels: Record<string, string> = {
        family: "Nhóm biển báo",
        variant: "Biến thể biển báo",
        standalone: "Biển báo",
      };
      unitType = labels[String(metadata.record_type)] ?? "Biển báo";
      if (
        metadata.record_type === "variant" &&
        ["family_shared", "contextual"].includes(
          String(metadata.description_scope),
        )
      )
        unitType += ", quy định chung";
      if (typeof metadata.qcvn === "string" && metadata.qcvn)
        unitType += ` (${metadata.qcvn})`;
    }
    return {
      title: String(doc.title ?? citation.doc_id),
      number: String(
        (typeof doc.official_so_hieu === "string" &&
          doc.official_so_hieu.trim()) ||
          doc.so_hieu ||
          citation.doc_id,
      ),
      unitType,
      text: citation.source.text,
    };
  }
  const [documents, units] = await Promise.all([
    api<ContentRecord[]>("/documents"),
    api<ContentRecord[]>(`/units?docId=${encodeURIComponent(citation.doc_id)}`),
  ]);
  if (!Array.isArray(documents) || !Array.isArray(units))
    throw new ApiError("Invalid source", 502);
  const doc = documents.find((d) => d.externalId === citation.doc_id),
    unit = units.find((u) => u.externalId === citation.unit_id);
  if (
    !doc?.data ||
    !unit?.data ||
    unit.data.doc_id !== citation.doc_id ||
    typeof unit.data.text !== "string" ||
    !citation.quote.trim() ||
    !unit.data.text.includes(citation.quote) ||
    typeof doc.data.title !== "string" ||
    typeof doc.data.so_hieu !== "string" ||
    typeof unit.data.unit_type !== "string"
  )
    throw new ApiError("Source not available", 502);
  return {
    title: doc.data.title,
    number:
      (typeof doc.data.official_so_hieu === "string" &&
        doc.data.official_so_hieu.trim()) ||
      doc.data.so_hieu,
    unitType: unit.data.unit_type,
    text: unit.data.text,
  };
}

function snapshotMatches(citation: Citation) {
  const source = citation.source;
  if (
    !source ||
    source.contract_version !== "graph-source-v1" ||
    typeof source.release_id !== "string" ||
    !source.release_id ||
    typeof source.source_snapshot_id !== "string" ||
    !source.source_snapshot_id ||
    typeof source.entity_type !== "string" ||
    typeof source.entity_id !== "string" ||
    source.text !== citation.quote ||
    !source.metadata ||
    !source.document_metadata ||
    source.document_metadata.id !== citation.doc_id ||
    source.metadata.id !== source.entity_id
  )
    return false;
  return source.entity_type.endsWith(".LegalDocument")
    ? source.entity_id === citation.doc_id
    : source.entity_type.endsWith(".LegalUnit")
      ? source.entity_id === citation.unit_id &&
        source.metadata.doc_id === citation.doc_id
      : source.entity_type.endsWith(".TrafficSign") &&
        source.entity_id === citation.sign_id &&
        source.metadata.doc_id === citation.doc_id;
}

export function createChat() {
  let state: ChatState = {
    rows: [],
    loading: true,
    error: "",
    busy: false,
    stopping: false,
    requestError: "",
    observed: "idle",
  };
  const listeners = new Set<() => void>();
  let history: Promise<void> | undefined;
  type Pending = {
    controller: AbortController;
    id?: string;
    stopRequested: boolean;
    stopTask?: Promise<void>;
    terminal?: ChatRecord;
    disposed: boolean;
  };
  let current: Pending | undefined;
  function update(change: Partial<ChatState>) {
    state = { ...state, ...change };
    listeners.forEach((listener) => listener());
  }
  function receive(row: ChatRecord, operation: Pending) {
    if (current !== operation) return;
    const view = chatView(row);
    if (row.state === "ANSWERED" && !view.answer)
      throw new ApiError("Invalid chat response", 502);
    update({
      rows: [row, ...state.rows.filter((old) => old.id !== row.id)],
      currentId: row.conversationId ?? row.id,
      ...(row.state === "PROCESSING"
        ? {}
        : {
            observed:
              row.state === "CLARIFY"
                ? "clarify"
                : view.answer
                  ? "answered"
                  : row.state === "KAG_ABSTAINED"
                    ? "abstained"
                    : row.state === "CANCELLED"
                      ? "cancelled"
                      : "unavailable",
            requestError: row.state === "UNAVAILABLE" ? unavailableMessage : "",
          }),
    });
  }
  async function stop(operation: Pending) {
    if (current !== operation || !operation.id || operation.stopTask)
      return operation.stopTask;
    operation.stopTask = (async () => {
      try {
        const row = await api<unknown>(`/chat/${operation.id}/stop`, {
          ...send("POST"),
          signal: operation.controller.signal,
        });
        if (current !== operation || operation.terminal) return;
        if (
          !record(row) ||
          row.id !== operation.id ||
          ![
            "CANCELLED",
            "ANSWERED",
            "CLARIFY",
            "KAG_ABSTAINED",
            "UNAVAILABLE",
          ].includes(row.state)
        )
          throw new ApiError("Stop not confirmed", 502);
        receive(row, operation);
        operation.terminal = row;
        operation.controller.abort();
      } catch {
        if (current === operation && !operation.terminal)
          update({
            stopping: false,
            requestError:
              "Chưa xác nhận được việc dừng. Kiểm tra kết nối và tải lại lịch sử.",
          });
        operation.stopTask = undefined;
      }
    })();
    return operation.stopTask;
  }
  function load(): Promise<void> {
    if (history) return history;
    update({ loading: true, error: "" });
    history = api<unknown>("/chat")
      .then((rows) => {
        if (!Array.isArray(rows) || !rows.every(record))
          throw new ApiError("Invalid history", 502);
        update({ rows });
      })
      .catch((error) => {
        const status = error instanceof ApiError ? error.status : -1;
        update({
          error:
            status === 0
              ? "Không kết nối được backend. Hãy thử lại."
              : status === 401
                ? "Phiên đã hết hạn. Vui lòng đăng nhập lại."
                : "Không tải được lịch sử. Hãy thử lại.",
          ...(status === 401 ? { rows: [] } : {}),
        });
      })
      .finally(() => {
        history = undefined;
        update({ loading: false });
      });
    return history;
  }
  async function submit(message: string, conversationId?: string) {
    if (state.busy || state.loading || !message.trim() || message.length > 4000)
      return false;
    update({
      busy: true,
      stopping: false,
      currentId: undefined,
      observed: "idle",
      requestError: "",
    });
    const operation: Pending = {
      controller: new AbortController(),
      stopRequested: false,
      disposed: false,
    };
    current = operation;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await apiResponse("/chat/stream", {
        ...send("POST", { message, conversationId }),
        signal: operation.controller.signal,
      });
      if (!response.ok) throw new ApiError("Chat unavailable", response.status);
      if (
        !response.headers
          .get("Content-Type")
          ?.toLowerCase()
          .startsWith("text/event-stream") ||
        !response.body
      )
        throw new ApiError("Invalid chat response", 502);
      reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8", { fatal: true });
      let buffer = "",
        event = "",
        payload = "",
        bytes = 0;
      while (current === operation) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } catch {
          throw new ApiError("Chat connection lost", 0);
        }
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 512 * 1024)
          throw new ApiError("Chat response too large", 502);
        try {
          buffer += decoder.decode(chunk.value, { stream: true });
        } catch {
          throw new ApiError("Invalid chat encoding", 502);
        }
        let end: number;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, end).replace(/\r$/, "");
          buffer = buffer.slice(end + 1);
          if (line.startsWith(":")) continue;
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:"))
            payload += line.slice(5).trimStart();
          else if (line === "" && payload) {
            let row: unknown;
            try {
              row = JSON.parse(payload);
            } catch {
              throw new ApiError("Invalid chat JSON", 502);
            }
            if (
              !record(row) ||
              row.question !== message ||
              (operation.id && row.id !== operation.id) ||
              (conversationId && row.conversationId !== conversationId)
            )
              throw new ApiError("Invalid chat response", 502);
            if (
              event === "started" &&
              !operation.id &&
              row.state === "PROCESSING"
            ) {
              operation.id = row.id;
              receive(row, operation);
              if (operation.stopRequested) void stop(operation);
            } else if (
              operation.id &&
              ((event === "done" &&
                ["ANSWERED", "CLARIFY", "KAG_ABSTAINED", "CANCELLED"].includes(
                  row.state,
                )) ||
                (event === "error" && row.state === "UNAVAILABLE"))
            ) {
              if (!operation.terminal) {
                receive(row, operation);
                operation.terminal = row;
              }
              return operation.terminal.state !== "CANCELLED";
            } else throw new ApiError("Invalid chat event", 502);
            event = "";
            payload = "";
          } else if (line !== "") throw new ApiError("Invalid chat event", 502);
        }
      }
      if (operation.terminal) return operation.terminal.state !== "CANCELLED";
      throw new ApiError("Incomplete chat response", 502);
    } catch (error) {
      if (operation.disposed || current !== operation) return false;
      if (operation.terminal) return operation.terminal.state !== "CANCELLED";
      const status = error instanceof ApiError ? error.status : -1;
      const unavailable = status >= 500 && status <= 599;
      update({
        observed: unavailable
          ? "unavailable"
          : status === 0
            ? "offline"
            : "error",
        requestError: unavailable
          ? unavailableMessage
          : status === 429
            ? "KAG đang bận. Chờ lượt trước kết thúc rồi kiểm tra lịch sử."
            : status === 0
              ? "Mất kết nối backend. Tải lại lịch sử để kiểm tra kết quả trước khi gửi lại."
              : status === 401
                ? "Phiên đã hết hạn. Vui lòng đăng nhập lại."
                : status === 403
                  ? "Bạn không có quyền gửi câu hỏi."
                  : status === 422 || status === 400
                    ? "Câu hỏi không hợp lệ. Hãy kiểm tra nội dung."
                    : "Không gửi được câu hỏi. Hãy thử lại.",
        ...(status === 401 ? { rows: [] } : {}),
      });
      // Read persisted outcome once after processing errors; never resend inference.
      if (unavailable) await load();
      return false;
    } finally {
      operation.controller.abort();
      await reader?.cancel().catch(() => {});
      if (current === operation) {
        current = undefined;
        update({ busy: false, stopping: false });
      }
    }
  }
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    load,
    submit,
    cancel: async () => {
      if (current) {
        current.stopRequested = true;
        update({ stopping: true, requestError: "" });
        await stop(current);
      }
    },
    dispose: () => {
      if (current) {
        current.disposed = true;
        current.controller.abort();
        current = undefined;
        update({ busy: false, stopping: false });
      }
    },
  };
}
