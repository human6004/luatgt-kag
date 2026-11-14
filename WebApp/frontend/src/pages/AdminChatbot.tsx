import { useEffect, useState, type FormEvent } from "react";
import { Badge, Button, Card, Field, Modal, Page, inputCls } from "../admin/ui";
import { ApiError } from "../api";
import { Notice, useData } from "./shared/shared";
import type { SchemaResponse } from "./shared/KagSchemaPage";
import { GraphLibrary, useInspection } from "./shared/KagManagement";
import {
  changeChatRetrieval,
  changeLLMModel,
  loadBuilderConfiguration,
  loadBuilderInputs,
  loadChatRetrieval,
  loadKagConfiguration,
  loadLLMCredentials,
  loadServing,
  saveLLMCredentials,
  type ChatRetrievalValues,
} from "./shared/kag-inspection";

const modelErrors: Record<string, string> = {
  TEST_REQUIRED: "Cần kiểm thử thành công bản đã lưu trước khi áp dụng.",
  TEST_IN_PROGRESS: "Kiểm thử chưa hoàn tất. Tải lại trước khi thử tiếp.",
  RELEASE_UNAVAILABLE:
    "Chưa chọn đồ thị phục vụ. Chọn đồ thị đã dựng trong thư viện rồi xác nhận dùng cho Chat.",
  RELEASE_MISMATCH:
    "Embedding đang chọn khác embedding đã dựng đồ thị. Giữ nguyên địa chỉ kết nối và tên model thì chỉ cần đổi API key; đổi địa chỉ hoặc model thì phải dựng lại đồ thị.",
  VECTOR_IDENTITY_MISMATCH:
    "Model này khác đồ thị đang dùng cho Chat. Chọn đồ thị dựng bằng model này rồi bấm Dùng cho Chat; embedding sẽ được áp dụng cùng lúc.",
  ACTIVE_CONFIG_INVALID:
    "Cấu hình đang áp dụng không còn hợp lệ. Kiểm tra dữ liệu và quyền kết nối.",
  PROXY_POLICY_UNVERIFIED:
    "Chưa xác định được giới hạn lượt gọi qua proxy. Cần quản trị triển khai kiểm tra trước khi thử kết nối.",
  BLOCKED: "Địa chỉ kết nối chưa được hệ thống cho phép. Cần quản trị triển khai cấp quyền.",
  AUTH_FAILED: "Provider từ chối API key hoặc quyền truy cập.",
  MODEL_NOT_FOUND: "Provider không tìm thấy model.",
  RATE_LIMITED: "Provider giới hạn lượt gọi. Chờ trước khi kiểm thử lại.",
  PROVIDER_ERROR: "Provider trả lỗi dịch vụ.",
  MODEL_MISMATCH: "Model trong response không khớp model đã lưu.",
  DIMENSION_MISMATCH: "Số chiều vector không hợp lệ hoặc vượt giới hạn kiểm thử.",
  INVALID_RESPONSE: "Provider trả dữ liệu không hợp lệ.",
  TIMEOUT: "Request hết thời gian; không tự thử lại.",
  NETWORK_ERROR: "Không kết nối được provider qua gateway.",
};

export default function AdminChatbot() {
  const config = useInspection(loadKagConfiguration);
  const schema = useData<SchemaResponse>("/admin/kag/schema");
  const builderInputs = useInspection(loadBuilderInputs);
  const builderConfig = useInspection(loadBuilderConfiguration);
  const retrieval = useInspection(loadChatRetrieval);
  const models = useInspection(loadLLMCredentials);
  const serving = useInspection(loadServing);
  const activeRun = serving.value?.runs.find(
    (run) =>
      run.project_id === serving.value?.active?.project_id &&
      run.run_id === serving.value?.active?.run_id,
  );
  const embedding = models.value?.embedding;
  const embeddingDimension = models.value?.roles.embedding.test?.dimension;
  const embeddingMismatch = !!(
    activeRun &&
    embedding &&
    (activeRun.model_identity !== `${embedding.base_url.replace(/\/+$/, "")}|${embedding.model}` ||
      (embeddingDimension != null && activeRun.dimension !== embeddingDimension))
  );

  const [modelsDirty, setModelsDirty] = useState({ chat: false, embedding: false });
  const [modelsSaving, setModelsSaving] = useState(false);
  const [modelsMessage, setModelsMessage] = useState("");
  const [modelsError, setModelsError] = useState("");
  const [modelAction, setModelAction] = useState<{
    role: "chat" | "embedding";
    action: "test" | "apply";
    revision: number;
  } | null>(null);
  const [modelRunning, setModelRunning] = useState(false);
  const [draft, setDraft] = useState<ChatRetrievalValues>();
  const [changing, setChanging] = useState(false);
  const [changeError, setChangeError] = useState("");
  const [changeMessage, setChangeMessage] = useState("");
  const [confirmation, setConfirmation] = useState<{
    action: "apply" | "restore";
    revision: number;
    values: ChatRetrievalValues;
  } | null>(null);
  const [copying, setCopying] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState("");

  useEffect(() => {
    if (retrieval.value?.saved) setDraft({ ...retrieval.value.saved });
  }, [retrieval.value]);

  const retrievalState = retrieval.value;
  const dirtyRetrieval =
    !!draft &&
    !!retrievalState?.saved &&
    (draft.top_k !== retrievalState.saved.top_k || draft.expand !== retrievalState.saved.expand);
  const unsaved = modelsDirty.chat || modelsDirty.embedding || dirtyRetrieval;
  const validRetrieval =
    !!draft && Number.isInteger(draft.top_k) && draft.top_k >= 1 && draft.top_k <= 10;

  function reloadAll() {
    if (unsaved || serving.loading) return;
    setCopied(false);
    setCopyError("");
    setChangeError("");
    setChangeMessage("");
    setConfirmation(null);
    setModelsDirty({ chat: false, embedding: false });
    setModelsMessage("");
    setModelsError("");
    config.reload();
    schema.reload();
    builderInputs.reload();
    builderConfig.reload();
    retrieval.reload();
    models.reload();
    serving.reload();
  }

  async function saveModels(event: FormEvent<HTMLFormElement>, role: "chat" | "embedding") {
    event.preventDefault();
    if (!models.value?.save_allowed) return;
    const form = event.currentTarget,
      fields = new FormData(form);
    const key = String(fields.get(`${role}_api_key`) ?? "");
    const input = {
      provider: "openai-compatible" as const,
      base_url: String(fields.get(`${role}_base_url`) ?? ""),
      model: String(fields.get(`${role}_model`) ?? ""),
      ...(key ? { api_key: key } : {}),
    };
    // Keys stay in the password input and submit scope, never in React state, URL, or snapshots.
    setModelsSaving(true);
    setModelsError("");
    setModelsMessage("");
    setCopied(false);
    try {
      const saved = await saveLLMCredentials(models.value.revision, role, input);
      models.setValue(saved);
      form.querySelectorAll<HTMLInputElement>("input[type=password]").forEach((field) => {
        field.value = "";
      });
      setModelsMessage(
        `${key ? "API key đã lưu thành công" : "Đã lưu cấu hình"} (${role === "chat" ? "Chat" : "Embedding"}). Cần kiểm tra trước khi áp dụng.`,
      );
      setModelsDirty((current) => ({ ...current, [role]: false }));
    } catch (error) {
      setModelsError(
        error instanceof ApiError
          ? error.message
          : "Không lưu được cấu hình model. Hãy tải lại trước khi thử lại.",
      );
    } finally {
      setModelsSaving(false);
    }
  }

  async function runModelAction() {
    if (!modelAction) return;
    const { role, action, revision } = modelAction;
    setModelAction(null);
    setModelRunning(true);
    setModelsError("");
    setModelsMessage("");
    try {
      const result = await changeLLMModel(role, action, revision);
      models.setValue(result);
      setModelsMessage(
        `Đã cập nhật trạng thái ${action === "test" ? "kiểm tra" : "áp dụng"} ${role === "chat" ? "Chat" : "Embedding"}. Xem kết quả bên dưới.`,
      );
      serving.reload();
    } catch (error) {
      setModelsError(
        error instanceof ApiError
          ? error.message
          : "Không thực hiện được thao tác. Tải lại trạng thái trước khi thử tiếp.",
      );
    } finally {
      setModelRunning(false);
    }
  }

  async function updateRetrieval(
    action: "save" | "apply" | "restore",
    revision: number,
    values?: ChatRetrievalValues,
  ) {
    setChanging(true);
    setChangeError("");
    setChangeMessage("");
    setConfirmation(null);
    setCopied(false);
    try {
      await changeChatRetrieval(action, revision, values);
      setChangeMessage(
        action === "save"
          ? "Đã lưu bền vững; chưa tự áp dụng."
          : action === "apply"
            ? "Đã áp dụng vào cấu hình runtime."
            : "Đã khôi phục bản trước vào cấu hình đã lưu và runtime.",
      );
      retrieval.reload();
    } catch (error) {
      setChangeError(
        error instanceof ApiError
          ? error.message
          : "Không cập nhật được cấu hình. Hãy tải lại trạng thái trước khi thử lại.",
      );
    } finally {
      setChanging(false);
    }
  }

  const value = config.value;
  const snapshot = value
    ? JSON.stringify(
        {
          ...value,
          schema_contract: schema.value
            ? {
                namespace: schema.value.identity.namespace,
                schema_sha256: schema.value.identity.schema_sha256,
                contract_sha256: schema.value.identity.contract_sha256,
              }
            : null,
          builder_target: builderInputs.value?.target ?? null,
          chat_retrieval: retrievalState ?? null,
          saved_models: models.value ?? null,
        },
        null,
        2,
      )
    : "";

  async function copySnapshot() {
    setCopying(true);
    setCopied(false);
    setCopyError("");
    try {
      if (!snapshot || !navigator.clipboard?.writeText) throw new Error();
      await navigator.clipboard.writeText(snapshot);
      setCopied(true);
    } catch {
      setCopyError("Không sao chép được. Hãy cấp quyền clipboard rồi thử lại.");
    } finally {
      setCopying(false);
    }
  }

  return (
    <Page
      title="Chatbot"
      subtitle="Cấu hình model và quản lý đồ thị dùng cho Chat."
      actions={
        <Button disabled={unsaved || modelsSaving || modelRunning || changing} onClick={reloadAll}>
          Tải lại
        </Button>
      }
    >
      {unsaved && <p className="mb-4 text-sm">Có thay đổi chưa lưu. Lưu trước khi tải lại.</p>}
      <div className="space-y-5">
        <Card title="Model & API key">
          <div className="px-5 pb-5 text-sm space-y-4">
            <Notice {...models} retry={models.reload} />
            {models.value && (
              <>
                {models.value.error_code && (
                  <p role="alert" className="text-red-700">
                    Không đọc hoặc ghi được credentials đã lưu. Cần kiểm tra file và quyền phía
                    triển khai.
                  </p>
                )}
                <p className="text-muted">
                  Chat trả lời câu hỏi; Embedding tạo vector tìm nguồn liên quan. Hai kết nối lưu,
                  kiểm tra và áp dụng riêng.
                </p>
                {!models.value.save_allowed && !models.value.error_code && (
                  <p>
                    Chưa được phép lưu. Cần quản trị triển khai kiểm tra quyền và phiên bản cấu
                    hình.
                  </p>
                )}
                <div className="grid gap-6 md:grid-cols-2">
                  {(["embedding", "chat"] as const).map((role) => (
                    <form
                      key={`${role}-${models.value?.roles[role].saved_revision}`}
                      onSubmit={(event) => void saveModels(event, role)}
                      onChange={() => {
                        setModelsDirty((current) => ({ ...current, [role]: true }));
                        setModelsMessage("");
                      }}
                      autoComplete="off"
                      className="min-w-0 space-y-3 rounded-xl border border-line bg-bg/50 p-4"
                    >
                      <fieldset
                        disabled={
                          modelsSaving ||
                          modelRunning ||
                          models.loading ||
                          !models.value?.save_allowed
                        }
                        className="min-w-0 space-y-3"
                      >
                        <legend className="font-semibold text-navy mb-2">
                          {role === "embedding"
                            ? "1A. Embedding model (cần trước khi Dựng đồ thị)"
                            : "1B. Chat model (cần trước khi Dùng cho Chat)"}
                        </legend>
                        <div className="space-y-1 text-xs">
                          <p>
                            Bản lưu:{" "}
                            <strong>{models.value?.[role]?.model ?? "Chưa lưu model"}</strong>.
                            {modelsDirty[role] && " Có thay đổi chưa lưu."}
                          </p>
                          <p>
                            Kiểm tra kết nối:{" "}
                            <strong>
                              {models.value?.roles[role].test?.status === "PASS"
                                ? "Thành công"
                                : models.value?.roles[role].test?.status === "FAIL"
                                  ? "Lỗi kết nối"
                                  : models.value?.roles[role].test?.status === "BLOCKED"
                                    ? "Chưa thể kiểm tra"
                                    : "Chưa kiểm tra"}
                            </strong>
                          </p>
                          <p>
                            Áp dụng cho Chat:{" "}
                            <strong>
                              {models.value?.roles[role].status === "APPLIED"
                                ? "Đang dùng"
                                : "Chưa áp dụng"}
                            </strong>
                          </p>
                          {models.value?.roles[role].active &&
                            models.value.roles[role].status !== "APPLIED" && (
                              <p className="text-muted break-words">
                                Đang dùng bản trước: {models.value.roles[role].active?.model}.
                              </p>
                            )}
                        </div>
                        <Field label="Giao thức API">
                          <select
                            name={`${role}_provider`}
                            className={inputCls}
                            defaultValue="openai-compatible"
                          >
                            <option value="openai-compatible">OpenAI-compatible</option>
                          </select>
                        </Field>
                        <Field label="Địa chỉ kết nối (Base URL)">
                          <input
                            name={`${role}_base_url`}
                            type="url"
                            required
                            maxLength={2048}
                            className={inputCls}
                            defaultValue={models.value?.[role]?.base_url ?? ""}
                          />
                        </Field>
                        <Field label="Tên model">
                          <input
                            name={`${role}_model`}
                            required
                            maxLength={200}
                            className={inputCls}
                            defaultValue={models.value?.[role]?.model ?? ""}
                          />
                        </Field>
                        <Field
                          label="API key"
                          hint={
                            models.value?.[role]?.key_configured
                              ? "Đã lưu key; giá trị được ẩn. Để trống để giữ key, nhập key mới rồi Lưu để thay thế."
                              : "Chưa thiết lập. Lần lưu đầu cần nhập key."
                          }
                        >
                          <input
                            name={`${role}_api_key`}
                            type="password"
                            autoComplete="new-password"
                            maxLength={4096}
                            required={!models.value?.[role]?.key_configured}
                            className={inputCls}
                          />
                        </Field>
                        <div className="flex flex-wrap gap-2">
                          <Button
                            type="submit"
                            variant="dark"
                            disabled={
                              !modelsDirty[role] ||
                              modelsSaving ||
                              models.loading ||
                              !models.value?.save_allowed
                            }
                          >
                            Lưu {role === "chat" ? "Chat" : "Embedding"}
                          </Button>
                          {modelsDirty[role] && (
                            <Button
                              type="button"
                              onClick={(event) => {
                                event.currentTarget.form?.reset();
                                setModelsDirty((current) => ({ ...current, [role]: false }));
                                setModelsError("");
                              }}
                            >
                              Hủy thay đổi
                            </Button>
                          )}
                        </div>
                      </fieldset>
                      {modelsDirty[role] && (
                        <p className="text-xs text-muted">
                          Thay đổi chưa lưu. Cần lưu trước khi kiểm thử.
                        </p>
                      )}
                      <div className="flex flex-wrap gap-2 pt-1">
                        <Button
                          type="button"
                          disabled={
                            modelsDirty[role] ||
                            modelsSaving ||
                            modelRunning ||
                            !models.value?.roles[role].actions.test
                          }
                          onClick={() => {
                            if (models.value)
                              setModelAction({
                                role,
                                action: "test",
                                revision: models.value.revision,
                              });
                          }}
                        >
                          Kiểm tra {role === "chat" ? "Chat" : "Embedding"}
                        </Button>
                        <Button
                          type="button"
                          disabled={
                            modelsDirty[role] ||
                            modelsSaving ||
                            modelRunning ||
                            (role === "embedding" && embeddingMismatch) ||
                            !models.value?.roles[role].actions.apply
                          }
                          onClick={() => {
                            if (models.value)
                              setModelAction({
                                role,
                                action: "apply",
                                revision: models.value.revision,
                              });
                          }}
                        >
                          Áp dụng {role === "chat" ? "Chat" : "Embedding"}
                        </Button>
                      </div>
                      {models.value?.roles[role].test?.code &&
                        models.value.roles[role].test?.code !==
                          models.value.roles[role].blocker && (
                          <p className="text-xs break-words text-amber-800">
                            {modelErrors[models.value.roles[role].test!.code!]}
                          </p>
                        )}
                      {(models.value?.roles[role].blocker ||
                        (role === "embedding" && embeddingMismatch)) && (
                        <p role="status" className="text-xs break-words text-muted">
                          {
                            modelErrors[
                              role === "embedding" && embeddingMismatch
                                ? "VECTOR_IDENTITY_MISMATCH"
                                : models.value!.roles[role].blocker!
                            ]
                          }
                        </p>
                      )}
                    </form>
                  ))}
                </div>
                <p className="text-xs text-muted">
                  Kiểm tra kết nối gửi tối đa 1 request thật và có thể phát sinh phí; chỉ gửi sau
                  xác nhận. Khi dựng đồ thị, hệ thống dùng Embedding đã lưu và kiểm tra thành công
                  (không cần chờ Áp dụng cho Chat).
                </p>
                <p className="text-xs text-muted">
                  Embedding phải khớp đồ thị đang dùng. Hết hạn mức thì chỉ đổi API key, giữ nguyên
                  địa chỉ kết nối và tên model. Đổi địa chỉ hoặc model thì chọn đồ thị dựng bằng
                  model đó rồi bấm Dùng cho Chat.
                </p>
              </>
            )}
            {modelsMessage && (
              <p role="status" className="text-emerald-700">
                {modelsMessage}
              </p>
            )}
            {modelsError && (
              <p role="alert" className="text-red-700">
                {modelsError}
              </p>
            )}
            {modelRunning && <p role="status">Đang kiểm tra hoặc áp dụng model…</p>}
          </div>
        </Card>
      </div>
      <GraphLibrary
        onServingChange={serving.setValue}
        searchOptions={
          <Card title="Tùy chọn tìm kiếm khi trả lời Chat">
            <div className="px-5 pb-5 text-sm space-y-3">
              <p>Chọn số nguồn cần tìm và tìm thêm nội dung qua các quan hệ trong đồ thị.</p>
              <p className="text-muted">
                Câu trả lời cần trích dẫn nguồn. Không đủ căn cứ để trả lời thì hệ thống dừng trả
                lời.
              </p>
              <Notice {...retrieval} retry={retrieval.reload} />
              {retrievalState && (
                <>
                  {retrievalState.error_code && (
                    <p role="alert" className="text-red-700">
                      {retrievalState.error_code === "CONFIG_INVALID"
                        ? "Cấu hình đã lưu không hợp lệ. Cần kiểm tra phía triển khai."
                        : "Không đọc hoặc ghi được cấu hình đã lưu. Cần kiểm tra quyền truy cập."}
                    </p>
                  )}
                  {retrievalState.active && (
                    <p>
                      Đang áp dụng: {retrievalState.active.top_k} kết quả nguồn; tìm thêm nội dung
                      liên quan {retrievalState.active.expand ? "bật" : "tắt"}.
                    </p>
                  )}
                  {retrievalState.saved && (
                    <p>
                      {retrievalState.persisted ? "Đã lưu" : "Mặc định chưa lưu"}:{" "}
                      {retrievalState.saved.top_k} kết quả nguồn; tìm thêm nội dung liên quan{" "}
                      {retrievalState.saved.expand ? "bật" : "tắt"}.
                      {retrievalState.pending && " Chờ áp dụng."}
                    </p>
                  )}
                  {!retrievalState.runtime_idle && (
                    <p>
                      Hệ thống đang bận hoặc chưa thể đổi cấu hình an toàn. Thử áp dụng hoặc khôi
                      phục sau.
                    </p>
                  )}
                  {draft && retrievalState.saved && (
                    <>
                      <div className="grid gap-4 sm:grid-cols-2 items-end">
                        <Field label="Số kết quả nguồn (1–10)">
                          <input
                            type="number"
                            min={1}
                            max={10}
                            step={1}
                            className={inputCls}
                            value={draft.top_k}
                            disabled={changing || !retrievalState.actions.save}
                            onChange={(event) =>
                              setDraft({ ...draft, top_k: Number(event.target.value) })
                            }
                          />
                        </Field>
                        <label className="flex items-center gap-2 min-h-10">
                          <input
                            type="checkbox"
                            checked={draft.expand}
                            disabled={changing || !retrievalState.actions.save}
                            onChange={(event) =>
                              setDraft({ ...draft, expand: event.target.checked })
                            }
                          />{" "}
                          Tìm thêm nội dung liên quan
                        </label>
                      </div>
                      {!validRetrieval && (
                        <p role="alert" className="text-red-700">
                          Số kết quả nguồn phải là số nguyên từ 1 đến 10.
                        </p>
                      )}
                      <div className="flex flex-wrap gap-2">
                        <Button
                          disabled={
                            changing ||
                            retrieval.loading ||
                            !retrievalState.actions.save ||
                            !dirtyRetrieval ||
                            !validRetrieval
                          }
                          onClick={() =>
                            void updateRetrieval("save", retrievalState.revision, draft)
                          }
                        >
                          Lưu
                        </Button>
                        <Button
                          disabled={
                            changing ||
                            retrieval.loading ||
                            dirtyRetrieval ||
                            !retrievalState.actions.apply
                          }
                          onClick={() =>
                            setConfirmation({
                              action: "apply",
                              revision: retrievalState.revision,
                              values: retrievalState.saved!,
                            })
                          }
                        >
                          Áp dụng
                        </Button>
                        <Button
                          disabled={
                            changing ||
                            retrieval.loading ||
                            dirtyRetrieval ||
                            !retrievalState.actions.restore
                          }
                          onClick={() =>
                            setConfirmation({
                              action: "restore",
                              revision: retrievalState.revision,
                              values: retrievalState.previous!,
                            })
                          }
                        >
                          Khôi phục
                        </Button>
                        {dirtyRetrieval && (
                          <Button
                            disabled={changing || retrieval.loading}
                            onClick={() => setDraft({ ...retrievalState.saved! })}
                          >
                            Hủy thay đổi
                          </Button>
                        )}
                      </div>
                      {dirtyRetrieval && (
                        <p className="text-muted">
                          Thay đổi trên form chưa lưu. Lưu trước khi áp dụng hoặc khôi phục.
                        </p>
                      )}
                    </>
                  )}
                </>
              )}
              {changing && <p role="status">Đang cập nhật cấu hình…</p>}
              {changeMessage && (
                <p role="status" className="text-emerald-700">
                  {changeMessage}
                </p>
              )}
              {changeError && (
                <p role="alert" className="text-red-700">
                  {changeError}
                </p>
              )}
            </div>
          </Card>
        }
      />
      <details className="mt-5 text-sm">
        <summary className="underline cursor-pointer">Chi tiết kỹ thuật cấu hình</summary>
        <pre className="whitespace-pre-wrap break-all text-xs mt-3">{snapshot}</pre>
        <Button disabled={copying} onClick={() => void copySnapshot()}>
          Sao chép cấu hình
        </Button>
        {copied && <p>Đã sao chép.</p>}
        {copyError && <p role="alert">{copyError}</p>}
      </details>
      <Modal
        open={confirmation !== null}
        title={
          confirmation?.action === "restore"
            ? "Khôi phục cấu hình trước"
            : "Áp dụng cấu hình đã lưu"
        }
        onClose={() => setConfirmation(null)}
        footer={
          <>
            <Button onClick={() => setConfirmation(null)}>Hủy</Button>
            <Button
              variant="primary"
              onClick={() => {
                if (confirmation) void updateRetrieval(confirmation.action, confirmation.revision);
              }}
            >
              Xác nhận
            </Button>
          </>
        }
      >
        {confirmation && (
          <p>
            Đặt {confirmation.values.top_k} kết quả nguồn; tìm thêm nội dung liên quan{" "}
            {confirmation.values.expand ? "bật" : "tắt"} cho các câu hỏi Chat tiếp theo.{" "}
            {confirmation.action === "restore" && "Bản đã lưu cũng được thay bằng bản khôi phục."}{" "}
            Câu hỏi đang xử lý không bị thay đổi.
          </p>
        )}
      </Modal>

      <Modal
        open={modelAction !== null}
        title={modelAction?.action === "test" ? "Kiểm thử provider thực" : "Áp dụng model phục vụ"}
        onClose={() => setModelAction(null)}
        footer={
          <>
            <Button onClick={() => setModelAction(null)}>Hủy</Button>
            <Button variant="primary" onClick={() => void runModelAction()}>
              Xác nhận
            </Button>
          </>
        }
      >
        {modelAction && (
          <p>
            {modelAction.role === "chat" ? "Chat" : "Embedding"}:{" "}
            {modelAction.action === "test"
              ? "gửi tối đa một yêu cầu tới model, có thể phát sinh phí. Không tự thử lại hoặc đổi bản đang áp dụng."
              : "áp dụng bản đã kiểm tra cho các câu hỏi tiếp theo khi tương thích với dữ liệu. Giữ bản đang áp dụng nếu thao tác thất bại; không dựng lại đồ thị."}
          </p>
        )}
      </Modal>
    </Page>
  );
}
