import { useEffect, useState, type FormEvent } from 'react'
import { Link, useLocation, useSearchParams } from 'react-router-dom'
import { Button, Card, Field, Modal, Page, inputCls } from '../admin/ui'
import { ApiError } from '../api'
import { Notice, useData } from './server/shared'
import type { SchemaResponse } from './server/KagSchemaPage'
import { useInspection } from './server/KagManagement'
import { changeLLMModel, changeChatRetrieval, loadChatRetrieval, loadBuilderInputs, loadKagConfiguration, loadLLMCredentials, saveLLMCredentials, loadServing, servingReasons, type ChatRetrievalValues } from './server/kag-inspection'

const modelErrors: Record<string, string> = {
  TEST_REQUIRED: 'Cần kiểm thử thành công bản đã lưu trước khi áp dụng.', TEST_IN_PROGRESS: 'Kiểm thử chưa hoàn tất. Tải lại trước khi thử tiếp.',
  RELEASE_UNAVAILABLE: 'Chưa chọn đồ thị phục vụ. Mở Đồ thị của tôi, chọn phiên đã xác minh rồi xem trước và xác nhận.',
  RELEASE_MISMATCH: 'Model hoặc địa chỉ kết nối không tương thích với dữ liệu đang phục vụ.', VECTOR_IDENTITY_MISMATCH: 'Embedding không khớp model và chỉ mục đã dùng để dựng đồ thị.',
  ACTIVE_CONFIG_INVALID: 'Cấu hình đang áp dụng không còn hợp lệ. Kiểm tra dữ liệu và quyền kết nối.',
  PROXY_POLICY_UNVERIFIED: 'Chưa xác định được giới hạn lượt gọi qua proxy. Cần quản trị triển khai kiểm tra trước khi thử kết nối.',
  BLOCKED: 'Địa chỉ kết nối chưa được hệ thống cho phép. Cần quản trị triển khai cấp quyền.',
  AUTH_FAILED: 'Provider từ chối API key hoặc quyền truy cập.', MODEL_NOT_FOUND: 'Provider không tìm thấy model.',
  RATE_LIMITED: 'Provider giới hạn lượt gọi. Chờ trước khi kiểm thử lại.', PROVIDER_ERROR: 'Provider trả lỗi dịch vụ.',
  MODEL_MISMATCH: 'Model trong response không khớp model đã lưu.', DIMENSION_MISMATCH: 'Số chiều vector không hợp lệ hoặc vượt giới hạn kiểm thử.',
  INVALID_RESPONSE: 'Provider trả dữ liệu không hợp lệ.', TIMEOUT: 'Request hết thời gian; không tự thử lại.', NETWORK_ERROR: 'Không kết nối được provider qua gateway.',
}

export default function AdminConfig() {
  const location = useLocation()
  const [parameters]=useSearchParams(),requestedReturn=parameters.get('returnTo') ?? ''
  const returnTo=/^\/admin\/graph(?:\?|$)/.test(requestedReturn)?requestedReturn:''
  const config = useInspection(loadKagConfiguration)
  const schema = useData<SchemaResponse>('/admin/kag/schema')
  const builder = useInspection(loadBuilderInputs)
  const retrieval = useInspection(loadChatRetrieval)
  const models = useInspection(loadLLMCredentials)
  const serving = useInspection(loadServing)
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
  const unsaved = modelsDirty.chat || modelsDirty.embedding || dirty
  const valid = !!draft && Number.isInteger(draft.top_k) && draft.top_k >= 1 && draft.top_k <= 10
  const [copying, setCopying] = useState(false)
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState('')
  const value = config.value, solver = value?.solver
  const active = serving.value?.active
  const activeRun = serving.value?.runs.find(run => active && run.run_id === active.run_id && run.project_id === active.project_id && run.database === active.database && run.namespace === active.namespace)
  const graphPath = active ? `/admin/graph?project_id=${active.project_id}` : '/admin/graph'
  const snapshot = value ? JSON.stringify({ ...value, schema_contract: schema.value ? {
    namespace: schema.value.identity.namespace, schema_sha256: schema.value.identity.schema_sha256,
    contract_sha256: schema.value.identity.contract_sha256,
  } : null, builder_target: builder.value?.target ?? null, chat_retrieval: retrievalState ?? null, saved_models: models.value ?? null }, null, 2) : ''
  const modelState = { CONFIGURED: 'Đã cấu hình', NOT_CONFIGURED: 'Chưa cấu hình', INCOMPLETE: 'Cấu hình chưa đầy đủ', INVALID: 'Cấu hình không hợp lệ' }
  const releaseState = { NOT_CONFIGURED: 'Chưa cấu hình', LOADED: 'Đã nạp artifact', UNAVAILABLE: 'Chưa nạp được artifact' }

  function reload() {
    if (unsaved || serving.loading) return
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
    serving.reload()
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
      setModelsMessage(`${key ? 'API key đã lưu thành công' : 'Đã lưu cấu hình'} (${role === 'chat' ? 'Chat' : 'Embedding'}). Cần kiểm tra trước khi áp dụng.`)
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
      setModelsMessage(`Đã cập nhật trạng thái ${action === 'test' ? 'kiểm tra' : 'áp dụng'} ${role === 'chat' ? 'Chat' : 'Embedding'}. Xem kết quả bên dưới.`)
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
    <Page title="Model & tìm kiếm" subtitle="Lưu kết nối, kiểm tra khi cần, rồi áp dụng cho đồ thị tương thích."
      actions={<div className="flex flex-wrap items-center gap-4">{returnTo && <Link className="underline text-sm" to={returnTo} state={location.state}>Về đồ thị đang chọn</Link>}<Button disabled={unsaved || serving.loading || config.loading || schema.loading || builder.loading || retrieval.loading || models.loading || modelsSaving || modelRunning || copying || changing} title={unsaved ? 'Lưu thay đổi trên form trước khi tải lại.' : undefined} onClick={reload}>Tải lại</Button></div>}>
      {unsaved && <p className="mb-4 text-sm text-muted">Có thay đổi chưa lưu. Lưu trước khi tải lại để giữ dữ liệu đang nhập.</p>}
      <div className="space-y-5">
        <Card title="Dữ liệu dùng để trả lời">
          <div className="px-5 pb-5 text-sm space-y-3">
            {serving.loading ? <p role="status" className="text-muted">Đang tải dữ liệu phục vụ…</p> : <Notice error={serving.error} retry={serving.reload} />}
            {serving.value && <>
              <p className="break-words">{active ? `Đang phục vụ: ${active.project_name} · database ${active.database}` : 'Chưa chọn đồ thị phục vụ.'}</p>
              {active && <p>{activeRun && typeof activeRun.partial === 'boolean' ? `Phạm vi: ${activeRun.partial ? 'Một phần corpus' : 'Toàn corpus theo phiên dựng'} · ${activeRun.nodes} nút · ${activeRun.edges} quan hệ.` : 'Phạm vi dữ liệu: chưa xác định được từ phiên dựng hiện có.'}</p>}
              <p>{serving.value.runtime_ready ? 'Đã nạp cấu hình phục vụ. Chưa kiểm tra khả năng truy xuất và Chat.' : 'Chưa nạp được cấu hình phục vụ. Kiểm tra đồ thị và kết nối model.'}</p>
              {serving.value.chat_blockers.map(code => <p key={code}>{servingReasons[code] ?? 'Còn điều kiện cần xử lý. Xem mã trong Chi tiết kỹ thuật.'}</p>)}
            </>}
            <nav aria-label="Bước xử lý dữ liệu" className="flex flex-wrap gap-x-4 gap-y-3">
              <Link className="underline" to={returnTo || graphPath}>Chọn đồ thị để dùng cho Chat</Link>
            </nav>
            <p>Đồ thị dựng từ dataset dùng bản nguồn đi cùng phiên dựng. Không cần nhập lại vào Quản lý nội dung.</p>
          </div>
        </Card>

        <Card title="Kết nối model">
          <div className="px-5 pb-5 text-sm space-y-4">
            <Notice {...models} />
            {models.value && <>
              {models.value.error_code && <p role="alert" className="text-red-700">Không đọc hoặc ghi được credentials đã lưu. Cần kiểm tra file và quyền phía triển khai.</p>}
              <p className="text-muted">Chat trả lời câu hỏi; Embedding tìm nguồn liên quan. Hai kết nối lưu và áp dụng riêng.</p>
              {!models.value.save_allowed && !models.value.error_code && <p>Chưa được phép lưu. Cần quản trị triển khai kiểm tra quyền và phiên bản cấu hình.</p>}
              <div className="grid gap-6 md:grid-cols-2">
                {(['chat', 'embedding'] as const).map(role => <form key={`${role}-${models.value?.roles[role].saved_revision}`} onSubmit={event => void saveModels(event, role)} onChange={() => { setModelsDirty(current => ({ ...current, [role]: true })); setModelsMessage('') }} autoComplete="off" className="min-w-0 space-y-3">
                  <fieldset disabled={modelsSaving || modelRunning || models.loading || !models.value?.save_allowed} className="min-w-0 space-y-3">
                    <legend className="font-semibold mb-2">{role === 'chat' ? 'Chat model' : 'Embedding model'}</legend>
                    <div className="space-y-1">
                      <p>Bản lưu: {models.value?.[role] ? 'Đã lưu' : 'Chưa lưu model'}.{modelsDirty[role] && ' Có thay đổi chưa lưu.'}</p>
                      <p>Kết nối bản đã lưu: {models.value?.roles[role].test?.status === 'PASS' ? 'Đã kiểm tra thành công.' : models.value?.roles[role].test?.status === 'FAIL' ? 'Lỗi kết nối.' : models.value?.roles[role].test?.status === 'BLOCKED' ? 'Chưa thể kiểm tra; xem điều kiện bên dưới.' : 'Chưa kiểm tra.'}</p>
                      <p>Áp dụng bản đã lưu: {models.value?.roles[role].status === 'APPLIED' ? 'Đang áp dụng.' : 'Chưa áp dụng.'}</p>
                      {models.value?.roles[role].active && models.value.roles[role].status !== 'APPLIED' && <p className="text-muted break-words">Đang dùng bản trước: {models.value.roles[role].active?.model}.</p>}
                    </div>
                    <Field label="Giao thức API"><select name={`${role}_provider`} className={inputCls} defaultValue="openai-compatible"><option value="openai-compatible">OpenAI-compatible</option></select></Field>
                    <Field label="Địa chỉ kết nối (Base URL)"><input name={`${role}_base_url`} type="url" required maxLength={2048} className={inputCls} defaultValue={models.value?.[role]?.base_url ?? ''} /></Field>
                    <Field label="Tên model"><input name={`${role}_model`} required maxLength={200} className={inputCls} defaultValue={models.value?.[role]?.model ?? ''} /></Field>
                    <Field label="API key" hint={models.value?.[role]?.key_configured ? 'Đã lưu key; giá trị được ẩn. Để trống để giữ key, nhập key mới rồi Lưu để thay thế.' : 'Chưa thiết lập. Lần lưu đầu cần nhập key.'}>
                      <input name={`${role}_api_key`} type="password" autoComplete="new-password" maxLength={4096} required={!models.value?.[role]?.key_configured} className={inputCls} />
                    </Field>
                    <div className="flex flex-wrap gap-2">
                      <Button type="submit" disabled={!modelsDirty[role] || modelsSaving || models.loading || !models.value?.save_allowed}>Lưu {role === 'chat' ? 'Chat' : 'Embedding'}</Button>
                      {modelsDirty[role] && <Button type="button" onClick={event => { event.currentTarget.form?.reset(); setModelsDirty(current => ({ ...current, [role]: false })); setModelsError('') }}>Hủy thay đổi</Button>}
                    </div>
                  </fieldset>
                  {modelsDirty[role] && <p className="text-muted">Thay đổi chưa lưu. Cần lưu trước khi kiểm thử.</p>}
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" disabled={modelsDirty[role] || modelsSaving || modelRunning || !models.value?.roles[role].actions.test} onClick={() => { if (models.value) setModelAction({ role, action: 'test', revision: models.value.revision }) }}>Kiểm tra {role === 'chat' ? 'Chat' : 'Embedding'}</Button>
                    <Button type="button" disabled={modelsDirty[role] || modelsSaving || modelRunning || !models.value?.roles[role].actions.apply} onClick={() => { if (models.value) setModelAction({ role, action: 'apply', revision: models.value.revision }) }}>Áp dụng {role === 'chat' ? 'Chat' : 'Embedding'}</Button>
                  </div>
                  {models.value?.roles[role].test?.code && models.value.roles[role].test?.code !== models.value.roles[role].blocker && <p className="break-words">{modelErrors[models.value.roles[role].test!.code!]}</p>}
                  {models.value?.roles[role].blocker && <p role="status" className="break-words">{modelErrors[models.value.roles[role].blocker!]}</p>}
                </form>)}
              </div>
              <p className="text-muted">Kiểm tra kết nối có thể phát sinh phí; chỉ gửi sau xác nhận. Áp dụng khi hệ thống rảnh và model tương thích với dữ liệu.</p>
              <p>Chuẩn bị nguồn và cấu hình dựng đồ thị tại <Link className="underline" to="/admin/pipeline">Dựng đồ thị</Link>.</p>
            </>}
            {modelsMessage && <p role="status">{modelsMessage}</p>}
            {modelsError && <p role="alert" className="text-red-700">{modelsError}</p>}
            {modelRunning && <p role="status">Đang kiểm tra hoặc áp dụng model…</p>}
          </div>
        </Card>

        <Card title="Tùy chọn tìm kiếm">
          <div className="px-5 pb-5 text-sm space-y-3">
            <p>Chọn số nguồn cần tìm và tìm thêm nội dung qua các quan hệ trong đồ thị.</p>
            <p className="text-muted">Câu trả lời cần trích dẫn nguồn. Không đủ căn cứ để trả lời thì hệ thống dừng trả lời.</p>
            <Notice {...retrieval} />
            {retrievalState && <>
              {retrievalState.error_code && <p role="alert" className="text-red-700">{retrievalState.error_code === 'CONFIG_INVALID' ? 'Cấu hình đã lưu không hợp lệ. Cần kiểm tra phía triển khai.' : 'Không đọc hoặc ghi được cấu hình đã lưu. Cần kiểm tra quyền truy cập.'}</p>}
              {retrievalState.active && <p>Đang áp dụng: {retrievalState.active.top_k} kết quả nguồn; tìm thêm nội dung liên quan {retrievalState.active.expand ? 'bật' : 'tắt'}.</p>}
              {retrievalState.saved && <p>{retrievalState.persisted ? 'Đã lưu' : 'Mặc định chưa lưu'}: {retrievalState.saved.top_k} kết quả nguồn; tìm thêm nội dung liên quan {retrievalState.saved.expand ? 'bật' : 'tắt'}.{retrievalState.pending && ' Chờ áp dụng.'}</p>}
              {!retrievalState.runtime_idle && <p>Hệ thống đang bận hoặc chưa thể đổi cấu hình an toàn. Thử áp dụng hoặc khôi phục sau.</p>}
              {draft && retrievalState.saved && <>
                <div className="grid gap-4 sm:grid-cols-2 items-end">
                  <Field label="Số kết quả nguồn (1–10)"><input type="number" min={1} max={10} step={1} className={inputCls} value={draft.top_k} disabled={changing || !retrievalState.actions.save} onChange={event => setDraft({ ...draft, top_k: Number(event.target.value) })} /></Field>
                  <label className="flex items-center gap-2 min-h-10"><input type="checkbox" checked={draft.expand} disabled={changing || !retrievalState.actions.save} onChange={event => setDraft({ ...draft, expand: event.target.checked })} /> Tìm thêm nội dung liên quan</label>
                </div>
                {!valid && <p role="alert" className="text-red-700">Số kết quả nguồn phải là số nguyên từ 1 đến 10.</p>}
                <div className="flex flex-wrap gap-2">
                  <Button disabled={changing || retrieval.loading || !retrievalState.actions.save || !dirty || !valid} onClick={() => void change('save', retrievalState.revision, draft)}>Lưu</Button>
                  <Button disabled={changing || retrieval.loading || dirty || !retrievalState.actions.apply} onClick={() => setConfirmation({ action: 'apply', revision: retrievalState.revision, values: retrievalState.saved! })}>Áp dụng</Button>
                  <Button disabled={changing || retrieval.loading || dirty || !retrievalState.actions.restore} onClick={() => setConfirmation({ action: 'restore', revision: retrievalState.revision, values: retrievalState.previous! })}>Khôi phục</Button>
                  {dirty && <Button disabled={changing || retrieval.loading} onClick={() => setDraft({ ...retrievalState.saved! })}>Hủy thay đổi</Button>}
                </div>
                {dirty && <p className="text-muted">Thay đổi trên form chưa lưu. Lưu trước khi áp dụng hoặc khôi phục.</p>}
              </>}
            </>}
            {changing && <p role="status">Đang cập nhật cấu hình…</p>}
            {changeMessage && <p role="status">{changeMessage}</p>}
            {changeError && <p role="alert" className="text-red-700">{changeError}</p>}
            <p className="text-muted">Lưu giữ bản tùy chỉnh; Áp dụng dùng cho các câu hỏi tiếp theo. Sau khởi động lại, bản đang áp dụng vẫn được giữ.</p>
          </div>
        </Card>

        <details className="text-sm">
          <summary className="cursor-pointer underline font-semibold">Chi tiết kỹ thuật</summary>
          <div className="mt-4 space-y-5">
            <Notice {...config} />
            <section className="space-y-3">
              <h2 className="font-semibold">Dữ liệu và schema</h2>
              {active && <p className="break-all">Project ID {active.project_id} · namespace {active.namespace} · database ID {active.database_id} · run {active.run_id} · release {active.release_id}</p>}
              {serving.value && <p>Mã điều kiện Chat: {serving.value.chat_blockers.join(', ') || 'Không có trong catalog'}. Catalog không thay thế kiểm tra truy xuất.</p>}
              <Notice {...schema} />
              {schema.value && <dl className="space-y-2 break-all">
                <div><dt className="text-muted">Namespace schema mẫu đóng gói</dt><dd>{schema.value.identity.namespace}</dd></div>
                <div><dt className="text-muted">SHA-256 schema</dt><dd>{schema.value.identity.schema_sha256}</dd></div>
                <div><dt className="text-muted">SHA-256 contract</dt><dd>{schema.value.identity.contract_sha256}</dd></div>
              </dl>}
              <p className="text-muted">Schema mẫu đóng gói không xác nhận schema trên đồ thị đang phục vụ.</p>
              {value && <p className="break-all">Runtime khởi động: release {value.project.release_id ?? 'chưa cấu hình'} · {releaseState[value.project.release_state]}.</p>}
              <Link className="underline inline-block" to="/admin/schema">Xem schema và tải contract</Link>
              <Notice {...builder} />
              {builder.value && <>
                <p>Đích Builder: {builder.value.configuration === 'CONFIGURED' ? 'Đã đọc cấu hình' : builder.value.configuration === 'INVALID' ? 'Cấu hình không hợp lệ' : 'Chưa cấu hình'}.</p>
                {builder.value.target && <p className="break-words">Project {builder.value.target.project_id} · database {builder.value.target.database} · namespace {builder.value.target.namespace}.</p>}
                <p className="text-muted">Đích Builder độc lập với đồ thị phục vụ truy vấn.</p>
              </>}
            </section>
            <section className="space-y-3">
              <h2 className="font-semibold">Model: kiểm tra, bản đang áp dụng và runtime khởi động</h2>
              {(['chat', 'embedding'] as const).map(role => <div key={role} className="space-y-2 break-words">
                <h3 className="font-semibold">{role === 'chat' ? 'Chat' : 'Embedding'}</h3>
                {models.value && <>
                  <p>Revision đã lưu: {models.value.roles[role].saved_revision ?? 'chưa lưu'} · đang áp dụng: {models.value.roles[role].active_revision ?? 'chưa áp dụng'}.</p>
                  {models.value.roles[role].test && <p>Test: {models.value.roles[role].test?.status} · revision {models.value.roles[role].test?.revision} · {models.value.roles[role].test?.client_attempts} request từ KAG · model phản hồi {models.value.roles[role].test?.observed_model ?? 'chưa đo'} · dimension {models.value.roles[role].test?.dimension ?? 'chưa đo'} · mã {models.value.roles[role].test?.code ?? 'không có'}.</p>}
                  {models.value.roles[role].blocker && <p>Mã điều kiện: {models.value.roles[role].blocker}.</p>}
                  {models.value.roles[role].active && <p className="break-all">Đang áp dụng: {models.value.roles[role].active?.model} · {models.value.roles[role].active?.base_url}.</p>}
                </>}
                {value && <p className="break-all">Lúc khởi động: {modelState[value.models[role].state]} · {value.models[role].model ?? 'chưa có model'} · {value.models[role].endpoint ?? 'chưa có endpoint'}.</p>}
              </div>)}
              <p className="text-muted">KAG không tự retry; proxy/provider có thể thử lại nội bộ theo policy đã duyệt. Cấu hình khởi động chưa xác minh danh tính provider.</p>
              {models.value && <p>{models.value.build_config.state === 'SEPARATE' ? 'Builder dùng Embedding đã lưu và kiểm tra qua cấu hình riêng.' : 'Worker chưa hỗ trợ cấu hình Builder qua WebApp.'} Không hỗ trợ OpenIE tùy ý.</p>}
            </section>
            <section className="space-y-3">
              <h2 className="font-semibold">Solver và giới hạn tìm kiếm</h2>
              {solver ? <>
                <dl className="grid gap-3 sm:grid-cols-2">
                  {[
                    ['Pipeline', solver.pipeline], ['Planner', solver.planner], ['top_k mặc định source', solver.top_k],
                    ['Số vòng lặp tối đa', solver.max_iteration], ['Evidence tối đa (ký tự)', solver.max_evidence_chars],
                    ['Search-k mỗi chỉ mục', solver.search_k], ['expand mặc định source', solver.expand ? 'Bật' : 'Tắt'],
                    ['Giới hạn cạnh mở rộng', solver.expansion_limit], ['Số chiều vector runtime yêu cầu', solver.required_vector_dimensions],
                  ].map(([label, text]) => <div key={label}><dt className="text-muted">{label}</dt><dd className="break-all">{text}</dd></div>)}
                </dl>
                <p className="text-muted">Mặc định trong source đang triển khai; không xác nhận truy vấn thực tế hoặc model provider.</p>
              </> : <p>Chưa đọc được mặc định solver từ runtime.</p>}
              {retrievalState && <p>Retrieval revision {retrievalState.revision}. Bản trước: {retrievalState.previous ? `top_k ${retrievalState.previous.top_k}, expand ${retrievalState.previous.expand ? 'bật' : 'tắt'}` : 'chưa có'}. Tham số từng request tại Hạ tầng không thay đổi.</p>}
            </section>
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
        </details>
      </div>
      <Modal open={confirmation !== null} title={confirmation?.action === 'restore' ? 'Khôi phục cấu hình trước' : 'Áp dụng cấu hình đã lưu'} onClose={() => setConfirmation(null)}
        footer={<><Button onClick={() => setConfirmation(null)}>Hủy</Button><Button variant="primary" onClick={() => { if (confirmation) void change(confirmation.action, confirmation.revision) }}>Xác nhận</Button></>}>
        {confirmation && <p>Đặt {confirmation.values.top_k} kết quả nguồn; tìm thêm nội dung liên quan {confirmation.values.expand ? 'bật' : 'tắt'} cho các câu hỏi Chat tiếp theo. {confirmation.action === 'restore' && 'Bản đã lưu cũng được thay bằng bản khôi phục.'} Câu hỏi đang xử lý không bị thay đổi.</p>}
      </Modal>
      <Modal open={modelAction !== null} title={modelAction?.action === 'test' ? 'Kiểm thử provider thực' : 'Áp dụng model phục vụ'} onClose={() => setModelAction(null)}
        footer={<><Button onClick={() => setModelAction(null)}>Hủy</Button><Button variant="primary" onClick={() => void runModelAction()}>Xác nhận</Button></>}>
        {modelAction && <p>{modelAction.role === 'chat' ? 'Chat' : 'Embedding'}: {modelAction.action === 'test' ? 'gửi tối đa một yêu cầu tới model, có thể phát sinh phí. Không tự thử lại hoặc đổi bản đang áp dụng.' : 'áp dụng bản đã kiểm tra cho các câu hỏi tiếp theo khi tương thích với dữ liệu. Giữ bản đang áp dụng nếu thao tác thất bại; không dựng lại đồ thị.'}</p>}
      </Modal>
    </Page>
  )
}
