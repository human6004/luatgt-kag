import { useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { Button, Card, Field, Modal, Page, inputCls } from '../admin/ui'
import { ApiError } from '../api'
import { Notice, useData } from './server/shared'
import type { SchemaResponse } from './server/KagSchemaPage'
import { useInspection } from './server/KagManagement'
import { changeLLMModel, changeChatRetrieval, loadChatRetrieval, loadBuilderInputs, loadKagConfiguration, loadLLMCredentials, saveLLMCredentials, type ChatRetrievalValues } from './server/kag-inspection'

const modelErrors: Record<string, string> = {
  TEST_REQUIRED: 'Cần kiểm thử thành công bản đã lưu trước khi áp dụng.', TEST_IN_PROGRESS: 'Kiểm thử chưa hoàn tất. Tải lại trước khi thử tiếp.',
  RELEASE_UNAVAILABLE: 'Chưa có serving release hợp lệ. Cần cấu hình release đã kiểm chứng.',
  RELEASE_MISMATCH: 'Model/endpoint không khớp policy hoặc proof của serving release.', VECTOR_IDENTITY_MISMATCH: 'Embedding không khớp identity, index hoặc provenance của release.',
  ACTIVE_CONFIG_INVALID: 'Bản active không còn hợp lệ. Serving tạm unavailable; cần kiểm tra release/policy.',
  PROXY_POLICY_UNVERIFIED: 'Proxy chưa có policy kiểm thử được duyệt. Cần route tắt retry/fallback hoặc operator chấp nhận các lượt gọi nội bộ.',
  BLOCKED: 'Endpoint chưa được deployment cho phép qua gateway. Cần đăng ký đích hợp lệ.',
  AUTH_FAILED: 'Provider từ chối API key hoặc quyền truy cập.', MODEL_NOT_FOUND: 'Provider không tìm thấy model.',
  RATE_LIMITED: 'Provider giới hạn lượt gọi. Chờ trước khi kiểm thử lại.', PROVIDER_ERROR: 'Provider trả lỗi dịch vụ.',
  MODEL_MISMATCH: 'Model trong response không khớp model đã lưu.', DIMENSION_MISMATCH: 'Số chiều vector không hợp lệ hoặc vượt giới hạn kiểm thử.',
  INVALID_RESPONSE: 'Provider trả dữ liệu không hợp lệ.', TIMEOUT: 'Request hết thời gian; không tự thử lại.', NETWORK_ERROR: 'Không kết nối được provider qua gateway.',
}

export default function AdminConfig() {
  const config = useInspection(loadKagConfiguration)
  const schema = useData<SchemaResponse>('/admin/kag/schema')
  const builder = useInspection(loadBuilderInputs)
  const retrieval = useInspection(loadChatRetrieval)
  const models = useInspection(loadLLMCredentials)
  const [modelsDirty, setModelsDirty] = useState({ chat: false, embedding: false })
  const [modelsSaving, setModelsSaving] = useState(false)
  const [modelsMessage, setModelsMessage] = useState('')
  const [modelsError, setModelsError] = useState('')
  const [modelAction, setModelAction] = useState<{ role: 'chat' | 'embedding'; action: 'test' | 'apply'; revision: number } | null>(null)
  const [modelRunning, setModelRunning] = useState(false)
  const [draft, setDraft] = useState<ChatRetrievalValues>()
  const [changing, setChanging] = useState(false)
  const [changeError, setChangeError] = useState('')
  const [changeMessage, setChangeMessage] = useState('')
  const [confirmation, setConfirmation] = useState<{ action: 'apply' | 'restore'; revision: number; values: ChatRetrievalValues } | null>(null)
  useEffect(() => { if (retrieval.value?.saved) setDraft({ ...retrieval.value.saved }) }, [retrieval.value])
  const retrievalState = retrieval.value
  const dirty = !!draft && !!retrievalState?.saved && (draft.top_k !== retrievalState.saved.top_k || draft.expand !== retrievalState.saved.expand)
  const valid = !!draft && Number.isInteger(draft.top_k) && draft.top_k >= 1 && draft.top_k <= 10
  const [copying, setCopying] = useState(false)
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState('')
  const value = config.value, solver = value?.solver
  const snapshot = value ? JSON.stringify({ ...value, schema_contract: schema.value ? {
    namespace: schema.value.identity.namespace, schema_sha256: schema.value.identity.schema_sha256,
    contract_sha256: schema.value.identity.contract_sha256,
  } : null, builder_target: builder.value?.target ?? null, chat_retrieval: retrievalState ?? null, saved_models: models.value ?? null }, null, 2) : ''
  const modelState = { CONFIGURED: 'Đã cấu hình', NOT_CONFIGURED: 'Chưa cấu hình', INCOMPLETE: 'Cấu hình chưa đầy đủ', INVALID: 'Cấu hình không hợp lệ' }
  const releaseState = { NOT_CONFIGURED: 'Chưa cấu hình', LOADED: 'Đã nạp artifact', UNAVAILABLE: 'Chưa nạp được artifact' }

  function reload() {
    setCopied(false)
    setCopyError('')
    setChangeError('')
    setChangeMessage('')
    setConfirmation(null)
    setModelsDirty({ chat: false, embedding: false })
    setModelsMessage('')
    setModelsError('')
    config.reload()
    schema.reload()
    builder.reload()
    retrieval.reload()
    models.reload()
  }
  async function saveModels(event: FormEvent<HTMLFormElement>, role: 'chat' | 'embedding') {
    event.preventDefault()
    if (!models.value?.save_allowed) return
    const form = event.currentTarget, fields = new FormData(form)
    const key = String(fields.get(`${role}_api_key`) ?? '')
    const input = { provider: 'openai-compatible' as const, base_url: String(fields.get(`${role}_base_url`) ?? ''), model: String(fields.get(`${role}_model`) ?? ''), ...(key ? { api_key: key } : {}) }
    // Keys stay in the password input and submit scope, never in React state or snapshots.
    setModelsSaving(true)
    setModelsError('')
    setModelsMessage('')
    setCopied(false)
    try {
      const saved = await saveLLMCredentials(models.value.revision, role, input)
      models.setValue(saved)
      form.querySelectorAll<HTMLInputElement>('input[type=password]').forEach(field => { field.value = '' })
      setModelsMessage(`${key ? 'API key đã lưu thành công' : 'Đã lưu cấu hình'} (${role === 'chat' ? 'Chat' : 'Embedding'}, revision ${saved.revision}). Chưa Test, chưa Apply.`)
      setModelsDirty(current => ({ ...current, [role]: false }))
    } catch (error) {
      setModelsError(error instanceof ApiError ? error.message : 'Không lưu được cấu hình model. Hãy tải lại trước khi thử lại.')
    } finally { setModelsSaving(false) }
  }
  async function change(action: 'save' | 'apply' | 'restore', revision: number, values?: ChatRetrievalValues) {
    setChanging(true)
    setChangeError('')
    setChangeMessage('')
    setConfirmation(null)
    setCopied(false)
    try {
      await changeChatRetrieval(action, revision, values)
      setChangeMessage(action === 'save' ? 'Đã lưu bền vững; chưa tự áp dụng.' : action === 'apply' ? 'Đã áp dụng vào cấu hình runtime.' : 'Đã khôi phục bản trước vào cấu hình đã lưu và runtime.')
      retrieval.reload()
    } catch (error) {
      setChangeError(error instanceof ApiError ? error.message : 'Không cập nhật được cấu hình. Hãy tải lại trạng thái trước khi thử lại.')
    } finally {
      setChanging(false)
    }
  }
  async function runModelAction() {
    if (!modelAction) return
    const { role, action, revision } = modelAction
    setModelAction(null)
    setModelRunning(true)
    setModelsError('')
    setModelsMessage('')
    try {
      const result = await changeLLMModel(role, action, revision)
      models.setValue(result)
      const row = result.roles[role]
      setModelsMessage(action === 'test' ? `${role === 'chat' ? 'Chat' : 'Embedding'}: ${row.test?.status ?? 'BLOCKED'}, revision ${row.saved_revision}.` : `${role === 'chat' ? 'Chat' : 'Embedding'}: ${row.status}.`)
    } catch (error) {
      setModelsError(error instanceof ApiError ? error.message : 'Không thực hiện được thao tác. Tải lại trạng thái trước khi thử tiếp.')
    } finally { setModelRunning(false) }
  }
  async function copy() {
    setCopying(true)
    setCopied(false)
    setCopyError('')
    try {
      if (!snapshot || !navigator.clipboard?.writeText) throw new Error()
      await navigator.clipboard.writeText(snapshot)
      setCopied(true)
    } catch {
      setCopyError('Không sao chép được. Hãy cấp quyền clipboard rồi thử lại.')
    } finally {
      setCopying(false)
    }
  }

  return (
    <Page title="Cấu hình" subtitle="Cấu hình đã nạp và giới hạn của phiên bản KAG đang triển khai."
      actions={<Button disabled={config.loading || schema.loading || builder.loading || retrieval.loading || models.loading || modelsSaving || modelRunning || copying || changing} onClick={reload}>Tải lại</Button>}>
      <div className="grid gap-5 lg:grid-cols-2 items-start">
        <Card title="Dự án & Schema">
          <div className="px-5 pb-5 text-sm space-y-3">
            <Notice {...schema} />
            {schema.value && <>
              <p>Namespace: <span className="font-semibold break-all">{schema.value.identity.namespace}</span></p>
              <p className="text-muted">Schema/contract đóng gói trong backend; không xác nhận schema trên graph đang chạy.</p>
              <details><summary className="cursor-pointer underline">Danh tính schema & contract</summary>
                <dl className="mt-3 space-y-2 break-all">
                  <div><dt className="text-muted">SHA-256 schema</dt><dd>{schema.value.identity.schema_sha256}</dd></div>
                  <div><dt className="text-muted">SHA-256 contract</dt><dd>{schema.value.identity.contract_sha256}</dd></div>
                </dl>
              </details>
            </>}
            {value && <div className="break-all"><p>Release: {value.project.release_id ?? 'Chưa cấu hình'}</p><p>Artifact: {releaseState[value.project.release_state]}</p></div>}
            <details><summary className="cursor-pointer underline">Đích cấu hình Builder</summary>
              <Notice {...builder} />
              {builder.value && <div className="mt-3 space-y-2 break-words">
                <p>{builder.value.configuration === 'CONFIGURED' ? 'Đã đọc cấu hình SAMPLE' : builder.value.configuration === 'INVALID' ? 'Cấu hình không hợp lệ' : 'Chưa cấu hình'}</p>
                {builder.value.target && <p>Project {builder.value.target.project_id}, database {builder.value.target.database}, namespace {builder.value.target.namespace}</p>}
                <p className="text-muted">Đích Builder độc lập với release phục vụ truy vấn. Xem điều kiện Build tại Pipeline.</p>
              </div>}
            </details>
            <Link className="underline inline-block" to="/admin/schema">Xem schema & tải contract</Link>
          </div>
        </Card>

        <Card title="Models & Providers">
          <div className="px-5 pb-5 text-sm space-y-4">
            <Notice {...config} />
            <Notice {...models} />
            {models.value && <>
              {models.value.error_code && <p role="alert" className="text-red-700">Không đọc hoặc ghi được credentials đã lưu. Cần kiểm tra file và quyền phía triển khai.</p>}
              <p className="text-muted">Chat và Embedding lưu độc lập. Provider/proxy do Base URL quyết định; EvelProxy không bắt buộc.</p>
              {!models.value.save_allowed && !models.value.error_code && <p>Lưu bị chặn: chưa có quyền credentials-write hoặc revision đã hết giới hạn.</p>}
              <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
                {(['chat', 'embedding'] as const).map(role => <form key={`${role}-${models.value?.roles[role].saved_revision}`} onSubmit={event => void saveModels(event, role)} onChange={() => { setModelsDirty(current => ({ ...current, [role]: true })); setModelsMessage('') }} autoComplete="off" className="min-w-0 space-y-3">
                  <fieldset disabled={modelsSaving || modelRunning || models.loading || !models.value?.save_allowed} className="min-w-0 space-y-3">
                    <legend className="font-semibold mb-2">{role === 'chat' ? 'Chat model' : 'Embedding model'}</legend>
                    <p>{modelsDirty[role] ? 'Chưa lưu thay đổi' : `${models.value?.roles[role].status} — bản lưu ${models.value?.roles[role].saved_revision ?? 'chưa có'}`}</p>
                    <Field label="Provider / API type" hint="Hiện hỗ trợ giao thức OpenAI-compatible."><select name={`${role}_provider`} className={inputCls} defaultValue="openai-compatible"><option value="openai-compatible">OpenAI-compatible</option></select></Field>
                    <Field label="Base URL"><input name={`${role}_base_url`} type="url" required maxLength={2048} className={inputCls} defaultValue={models.value?.[role]?.base_url ?? ''} /></Field>
                    <Field label="Tên model"><input name={`${role}_model`} required maxLength={200} className={inputCls} defaultValue={models.value?.[role]?.model ?? ''} /></Field>
                    <Field label="API key" hint={models.value?.[role]?.key_configured ? 'Đã lưu key; giá trị được ẩn. Để trống để giữ key, nhập key mới rồi Lưu để thay thế.' : 'Chưa thiết lập. Lần lưu đầu cần nhập key.'}>
                      <input name={`${role}_api_key`} type="password" autoComplete="new-password" maxLength={4096} required={!models.value?.[role]?.key_configured} className={inputCls} />
                    </Field>
                    <Button type="submit" disabled={!modelsDirty[role] || modelsSaving || models.loading || !models.value?.save_allowed}>Lưu {role === 'chat' ? 'Chat' : 'Embedding'}</Button>
                  </fieldset>
                  {modelsDirty[role] && <p className="text-muted">Thay đổi chưa lưu. Cần lưu trước khi kiểm thử.</p>}
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" disabled={modelsDirty[role] || modelsSaving || modelRunning || !models.value?.roles[role].actions.test} onClick={() => { if (models.value) setModelAction({ role, action: 'test', revision: models.value.revision }) }}>Kiểm tra {role === 'chat' ? 'Chat' : 'Embedding'}</Button>
                    <Button type="button" disabled={modelsDirty[role] || modelsSaving || modelRunning || !models.value?.roles[role].actions.apply} onClick={() => { if (models.value) setModelAction({ role, action: 'apply', revision: models.value.revision }) }}>Áp dụng {role === 'chat' ? 'Chat' : 'Embedding'}</Button>
                  </div>
                  {models.value?.roles[role].test && <p>Test: {models.value.roles[role].test?.status === 'PASS' ? 'TESTED' : models.value.roles[role].test?.status}, revision {models.value.roles[role].test?.revision}; {models.value.roles[role].test?.client_attempts} request từ KAG, không tự retry.</p>}
                  {models.value?.roles[role].test?.observed_model && <p className="break-words">Model phản hồi: {models.value.roles[role].test?.observed_model}. Proxy/provider có thể thử lại nội bộ theo policy đã duyệt.</p>}
                  {models.value?.roles[role].test?.code && models.value.roles[role].test?.code !== models.value.roles[role].blocker && <p className="break-words">Test {models.value.roles[role].test?.code}: {modelErrors[models.value.roles[role].test!.code!]}</p>}
                  {role === 'embedding' && <p>Dimensions thực đo: {models.value?.roles[role].test?.dimension ?? 'chưa đo'}. Apply cần khớp identity và số chiều của graph/release.</p>}
                  {models.value?.roles[role].blocker && <p role="status" className="break-words">{models.value.roles[role].blocker}: {modelErrors[models.value.roles[role].blocker!]}</p>}
                  <p>Active serving: revision {models.value?.roles[role].active_revision ?? 'chưa áp dụng'}.</p>
                  {models.value?.roles[role].active && <p className="break-all">{models.value.roles[role].active?.model} · {models.value.roles[role].active?.base_url}</p>}
                </form>)}
              </div>
              <p className="text-muted">Test có thể phát sinh phí, chỉ chạy sau xác nhận; không đổi active. Apply chỉ đổi consumer khi runtime rảnh và release tương thích.</p>
              <p>{models.value.build_config.state === 'SEPARATE' ? 'Builder dùng Embedding đã lưu và kiểm tra. Cấu hình đích, chuẩn bị nguồn và dựng graph tại ' : 'Worker hiện tại chưa hỗ trợ cấu hình Builder qua WebApp. Kiểm tra khả năng tại '}<Link className="underline" to="/admin/pipeline">Dựng đồ thị</Link>. Không hỗ trợ OpenIE tùy ý.</p>
            </>}
            {modelsMessage && <p role="status">{modelsMessage}</p>}
            {modelsError && <p role="alert" className="text-red-700">{modelsError}</p>}
            {modelRunning && <p role="status">Đang thực hiện Test/Apply…</p>}
            {value && <>
              <p className="font-semibold">Cấu hình runtime lúc khởi động (chỉ đọc)</p>
              <div className="grid gap-4 sm:grid-cols-2">
                {(['chat', 'embedding'] as const).map(role => <section key={role} className="min-w-0 space-y-2" aria-label={role === 'chat' ? 'Chat model' : 'Embedding model'}>
                  <h3 className="font-semibold">{role === 'chat' ? 'Chat' : 'Embedding'}</h3>
                  <p>{modelState[value.models[role].state]}</p>
                  <dl className="space-y-2 break-words">
                    <div><dt className="text-muted">Model cấu hình</dt><dd className="break-all">{value.models[role].model ?? 'Chưa có giá trị hợp lệ'}</dd></div>
                    <div><dt className="text-muted">Endpoint (host)</dt><dd className="break-all">{value.models[role].endpoint ?? 'Chưa có giá trị hợp lệ'}</dd></div>
                  </dl>
                </section>)}
              </div>
              {solver && <p>Vector: runtime yêu cầu {solver.required_vector_dimensions} chiều; chưa đo provider.</p>}
              <p className="text-muted">Nguồn: cấu hình lúc khởi động KAG API. Endpoint chỉ hiển thị host. Danh tính provider chưa xác minh; đã cấu hình không có nghĩa kết nối thành công.</p>
            </>}
          </div>
        </Card>

        <Card title="Solver & Retrieval">
          <div className="px-5 pb-5 text-sm space-y-3">
            {!value ? <p className="text-muted">{config.loading ? 'Đang tải cấu hình…' : 'Chưa đọc được cấu hình KAG.'}</p> : solver ? <>
              <dl className="space-y-2">
                <div><dt className="text-muted">Pipeline</dt><dd className="break-all">{solver.pipeline}</dd></div>
                <div><dt className="text-muted">Top-k mặc định trong source</dt><dd>{solver.top_k}</dd></div>
              </dl>
              <p>Evidence và trích dẫn bắt buộc. Thiếu căn cứ thì abstain.</p>
              <details><summary className="cursor-pointer underline">Giới hạn nâng cao</summary>
                <dl className="mt-3 grid gap-3 sm:grid-cols-2">
                  {[
                    ['Planner', solver.planner], ['Số vòng lặp tối đa', solver.max_iteration],
                    ['Evidence tối đa (ký tự)', solver.max_evidence_chars], ['Search-k mỗi chỉ mục', solver.search_k],
                    ['Mở rộng graph mặc định', solver.expand ? 'Bật' : 'Tắt'], ['Giới hạn cạnh mở rộng', solver.expansion_limit],
                  ].map(([label, text]) => <div key={label}><dt className="text-muted">{label}</dt><dd className="break-all">{text}</dd></div>)}
                </dl>
              </details>
              <p className="text-muted">Nguồn: mặc định constructor trong source đang triển khai. Không xác nhận pipeline đang trả lời được.</p>
            </> : <p>Chưa đọc được mặc định solver từ runtime. Không dùng giá trị thay thế.</p>}
          </div>
        </Card>

        <Card title="Mặc định Retrieval cho Chat">
          <div className="px-5 pb-5 text-sm space-y-3">
            <Notice {...retrieval} />
            {retrievalState && <>
              {retrievalState.error_code && <p role="alert" className="text-red-700">{retrievalState.error_code === 'CONFIG_INVALID' ? 'Cấu hình đã lưu không hợp lệ. Cần kiểm tra phía triển khai.' : 'Không đọc hoặc ghi được cấu hình đã lưu. Cần kiểm tra quyền truy cập.'}</p>}
              {retrievalState.active && <p>Đang áp dụng: top_k {retrievalState.active.top_k}, expand {retrievalState.active.expand ? 'bật' : 'tắt'}.</p>}
              {!retrievalState.error_code && <p>{retrievalState.pending ? 'Đã lưu; chờ áp dụng.' : retrievalState.persisted ? 'Cấu hình đã lưu khớp cấu hình runtime.' : 'Đang dùng mặc định source; chưa lưu tùy chỉnh.'}</p>}
              {!retrievalState.runtime_idle && <p>Runtime đang bận hoặc chưa an toàn. Áp dụng và khôi phục tạm bị chặn.</p>}
              {draft && retrievalState.saved && <>
                <div className="grid gap-4 sm:grid-cols-2 items-end">
                  <Field label="top_k (1–10)"><input type="number" min={1} max={10} step={1} className={inputCls} value={draft.top_k} disabled={changing || !retrievalState.actions.save} onChange={event => setDraft({ ...draft, top_k: Number(event.target.value) })} /></Field>
                  <label className="flex items-center gap-2 min-h-10"><input type="checkbox" checked={draft.expand} disabled={changing || !retrievalState.actions.save} onChange={event => setDraft({ ...draft, expand: event.target.checked })} /> Mở rộng graph context (expand)</label>
                </div>
                {!valid && <p role="alert" className="text-red-700">top_k phải là số nguyên từ 1 đến 10.</p>}
                <div className="flex flex-wrap gap-2">
                  <Button disabled={changing || retrieval.loading || !retrievalState.actions.save || !dirty || !valid} onClick={() => void change('save', retrievalState.revision, draft)}>Lưu</Button>
                  <Button disabled={changing || retrieval.loading || dirty || !retrievalState.actions.apply} onClick={() => setConfirmation({ action: 'apply', revision: retrievalState.revision, values: retrievalState.saved! })}>Áp dụng</Button>
                  <Button disabled={changing || retrieval.loading || dirty || !retrievalState.actions.restore} onClick={() => setConfirmation({ action: 'restore', revision: retrievalState.revision, values: retrievalState.previous! })}>Khôi phục</Button>
                </div>
                {dirty && <p className="text-muted">Thay đổi trên form chưa lưu. Lưu trước khi áp dụng hoặc khôi phục.</p>}
              </>}
              <details><summary className="cursor-pointer underline">Cấu hình đã lưu & bản trước</summary><div className="mt-2 space-y-2">
                <p>Đã lưu: {retrievalState.saved ? `top_k ${retrievalState.saved.top_k}, expand ${retrievalState.saved.expand ? 'bật' : 'tắt'}` : 'Chưa đọc được'}</p>
                <p>Bản trước: {retrievalState.previous ? `top_k ${retrievalState.previous.top_k}, expand ${retrievalState.previous.expand ? 'bật' : 'tắt'}` : 'Chưa có'}</p>
              </div></details>
            </>}
            {changing && <p role="status">Đang cập nhật cấu hình…</p>}
            {changeMessage && <p role="status">{changeMessage}</p>}
            {changeError && <p role="alert" className="text-red-700">{changeError}</p>}
            <p className="text-muted">Chỉ dùng cho Retrieval trong Chat. Tham số từng request tại Hạ tầng không thay đổi. Sau restart, dùng lại bản đang áp dụng; bản chỉ Lưu vẫn chờ.</p>
            <p>{value?.project.release_state !== 'LOADED' ? 'Chưa thể kiểm chứng truy vấn thực tế vì thiếu graph/release.' : 'Áp dụng cấu hình không xác nhận truy vấn graph hoặc chất lượng trả lời.'}</p>
          </div>
        </Card>

        <Card title="Thông tin cấu hình & thao tác liên quan">
          <div className="px-5 pb-5 text-sm space-y-3">
            <p>Model đã lưu và active phục vụ độc lập. Embedding cần khớp vector identity và release; Apply lỗi giữ bản active trước.</p>
            <p className="text-muted">Schema, cấu hình runtime và giới hạn nâng cao chỉ đọc. Tải lại không nạp lại environment.</p>
            <nav aria-label="Thao tác liên quan" className="flex flex-wrap gap-x-4 gap-y-3">
              <Link className="underline" to="/admin/pipeline">Pipeline</Link>
              <Link className="underline" to="/admin/infrastructure">Hạ tầng & Retrieval</Link>
              <Link className="underline" to="/admin/benchmark">Benchmark</Link>
            </nav>
            <details><summary className="cursor-pointer underline">Snapshot cấu hình đã lọc</summary>
              {snapshot ? <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-all text-xs">{snapshot}</pre> : <p className="mt-3">Chưa có snapshot.</p>}
              {value && (!schema.value || !builder.value) && <p className="mt-2 text-muted">Snapshot chưa có đủ schema hoặc đích Builder; nguồn chưa đọc được ghi null.</p>}
            </details>
            <Button disabled={!value || copying || config.loading || schema.loading || builder.loading || retrieval.loading || models.loading || modelsSaving || modelRunning || changing} onClick={() => void copy()}>{copying ? 'Đang sao chép…' : 'Sao chép snapshot'}</Button>
            {copied && <p role="status">Đã sao chép snapshot cấu hình.</p>}
            {copyError && <p role="alert" className="text-red-700">{copyError}</p>}
          </div>
        </Card>
      </div>
      <Modal open={confirmation !== null} title={confirmation?.action === 'restore' ? 'Khôi phục cấu hình trước' : 'Áp dụng cấu hình đã lưu'} onClose={() => setConfirmation(null)}
        footer={<><Button onClick={() => setConfirmation(null)}>Hủy</Button><Button variant="primary" onClick={() => { if (confirmation) void change(confirmation.action, confirmation.revision) }}>Xác nhận</Button></>}>
        {confirmation && <p>Đặt top_k {confirmation.values.top_k}, expand {confirmation.values.expand ? 'bật' : 'tắt'} cho các request Chat tiếp theo. {confirmation.action === 'restore' && 'Bản đã lưu cũng được thay bằng bản khôi phục.'} Request đang chạy sẽ không bị thay đổi.</p>}
      </Modal>
      <Modal open={modelAction !== null} title={modelAction?.action === 'test' ? 'Kiểm thử provider thực' : 'Áp dụng model phục vụ'} onClose={() => setModelAction(null)}
        footer={<><Button onClick={() => setModelAction(null)}>Hủy</Button><Button variant="primary" onClick={() => void runModelAction()}>Xác nhận</Button></>}>
        {modelAction && <p>{modelAction.role === 'chat' ? 'Chat' : 'Embedding'}, revision {modelAction.revision}: {modelAction.action === 'test' ? 'gửi tối đa một request inference ngắn, có thể phát sinh phí. Không tự retry/fallback hoặc thay active.' : 'áp dụng bản đã Test cho serving khi release và policy hợp lệ. Không rebuild hoặc ghi graph.'}</p>}
      </Modal>
    </Page>
  )
}
