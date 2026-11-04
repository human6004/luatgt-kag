import { api, send, ApiError } from '../../api.ts'

export type ServingSelection = { release_id: string; project_id: number; project_name: string; database: string; database_id: string; namespace: string; run_id: string; preview_id: string }
export type ServingRun = { run_id: string; project_id: number; project_name: string; database: string; namespace: string; nodes: number; edges: number; vectors: number; dimension: number; model_identity: string; partial: boolean }
export type ServingOperation = { contract_version: 'builder-serving-operation-v1'; state: 'NOT_RUN' | 'PREPARING' | 'COMPLETE' | 'FAILED' | 'INTERRUPTED'; project_id: number | null; run_id: string | null; code: string | null; result: ServingPreview | null }
export type ServingCatalog = { contract_version: 'builder-serving-v1'; active: ServingSelection | null; busy: boolean; runs: ServingRun[]; runtime_ready: boolean; chat_blockers: string[]; operation?: ServingOperation | null }
export type ServingPreview = { release_id: string; project_id: number; project_name: string; database: string; database_id: string; namespace: string; run_id: string; preview_id: string; counts: { nodes: number; edges: number; vectors: number }; dimension: number; partial: boolean; embedding: { base_url: string; model: string }; chat: { base_url: string; model: string } | null; previous: ServingSelection | null; chat_ready: boolean; chat_blockers: string[]; preparation_required?: boolean; status?: 'ACTIVE' }
function validateServingOperation(value: ServingOperation): ServingOperation {
  if (!shape(value,['contract_version','state','project_id','run_id','code','result']) || value.contract_version !== 'builder-serving-operation-v1' || !['NOT_RUN','PREPARING','COMPLETE','FAILED','INTERRUPTED'].includes(value.state) ||
    (value.state === 'NOT_RUN' ? value.project_id !== null || value.run_id !== null : !Number.isInteger(value.project_id) || value.project_id! < 1 || typeof value.run_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.run_id)) ||
    (['FAILED','INTERRUPTED'].includes(value.state) ? typeof value.code !== 'string' || !/^[A-Z_]{1,64}$/.test(value.code) : value.code !== null) ||
    (value.state === 'COMPLETE' ? value.result?.status !== 'ACTIVE' || value.result.project_id !== value.project_id || value.result.run_id !== value.run_id || !/^[0-9a-f]{64}$/.test(value.result.preview_id) : value.result !== null)) throw new ApiError('Trạng thái chuẩn bị đồ thị không hợp lệ',502)
  return value
}
export const servingReasons: Record<string, string> = {
  GRAPH_REQUIRED: 'Chọn một đồ thị rồi bấm Dùng cho Chat.',
  SOURCE_MISSING: 'Bản nguồn của đồ thị chưa đầy đủ. Chọn lại phiên dựng và kiểm tra nguồn đi kèm.',
  SOURCE_NOT_PUBLISHED: 'Nguồn còn là bản nháp. Kiểm duyệt và xuất bản văn bản, đơn vị pháp lý tương ứng.',
  SOURCE_TEXT_MISMATCH: 'Nội dung hoặc ngày hiệu lực khác nguồn dựng đồ thị. Kiểm tra và nhập lại đúng nguồn.',
  SOURCE_NOT_EFFECTIVE: 'Nguồn chưa có hiệu lực, đã hết hiệu lực hoặc đã bị thay thế; chưa đủ điều kiện Chat.',
  CHAT_MODEL_REQUIRED: 'Chưa có model Chat đã kiểm tra. Lưu và kiểm tra tại Model & API key rồi thử lại.',
  CHAT_MODEL_NOT_APPLIED: 'Model Chat chưa áp dụng cho đồ thị này. Bấm Dùng cho Chat rồi xác nhận để dùng.',
}
export async function loadServing(signal?: AbortSignal): Promise<ServingCatalog> {
  const value = await api<ServingCatalog>('/admin/kag/serving', { signal, cache: 'no-store' })
  if (value.contract_version !== 'builder-serving-v1' || !Array.isArray(value.runs) || !Array.isArray(value.chat_blockers) ||
    typeof value.busy !== 'boolean' || typeof value.runtime_ready !== 'boolean' || value.runs.some(row => !Number.isInteger(row.project_id) ||
      typeof row.run_id !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(row.namespace) ||
      [row.nodes, row.edges, row.vectors, row.dimension].some(n => !Number.isInteger(n) || n < 0))) throw new ApiError('Trạng thái đồ thị phục vụ không hợp lệ', 502)
  if (value.operation != null) validateServingOperation(value.operation)
  return value
}
export type PackageModel = { provider: string; model: string; dimension: number }
export type VectorPackageManifest = { format_version: 'luatgt-vector-package-v1'; plan_sha256: string; selection: Record<string, unknown> | null; model_identity: PackageModel; nodes: number; edges: number; vectors: number; fingerprint: string; application_version: string }
export type VectorPackageReference = { name: string; sha256: string }
export type BuilderPackages = { contract_version: 'builder-packages-v1'; directory: string; current_model: PackageModel | null; packages: { name: string; sha256: string | null; size: number; compatible: boolean; reason: string; manifest: VectorPackageManifest | null }[] }
export type BuilderPackageExport = { contract_version: 'builder-package-export-v1'; state: 'NOT_RUN' | 'RUNNING' | 'COMPLETE' | 'FAILED'; name: string | null; size: number | null; code: string | null; directory: string }
const packageName = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.zip$/.test(value)
const listedPackageName = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 255 && !/[\/\\\x00-\x1f\x7f]/.test(value)
export function packageReason(code: string) {
  const reasons: Record<string, string> = {
    PACKAGE_READY: 'Tương thích để nhập', COMPATIBLE: 'Tương thích để nhập',
    PACKAGE_NAME: 'Đổi tên ZIP: chỉ dùng chữ/số ASCII, dấu chấm, gạch ngang hoặc gạch dưới; tối đa 124 ký tự.',
    PACKAGE_PLAN: 'Gói dùng phiên bản dữ liệu khác. Cài đúng dữ liệu nguồn rồi tải lại.',
    PACKAGE_MODEL: 'Model của gói không khớp cấu hình hiện tại. Lưu và kiểm tra đúng Embedding rồi tải lại.', MODEL_MISMATCH: 'Model của gói không khớp cấu hình hiện tại.',
    PACKAGE_SOURCE: 'Chưa đọc được dữ liệu nguồn. Tải lại trước khi chọn gói.',
    PACKAGE_SELECTION: 'Phạm vi dữ liệu không khớp gói. Chọn lại gói hoặc kiểm tra dữ liệu nguồn.',
    PACKAGE_CHANGED: 'Tệp ZIP đã thay đổi. Tải lại danh sách rồi chọn lại.',
    PACKAGE_PATH: 'Thư mục hoặc tệp ZIP không hợp lệ; không dùng liên kết tượng trưng.',
    PACKAGE_SIZE: 'ZIP vượt giới hạn kích thước hoặc số lượng đã khai báo.',
    PACKAGE_MANIFEST: 'Thông tin mô tả gói không hợp lệ.',
    PACKAGE_FILES: 'ZIP chứa tệp thiếu, thừa hoặc đường dẫn không hợp lệ.',
    PACKAGE_INVALID: 'ZIP hoặc dữ liệu vector không hợp lệ.',
    PACKAGE_INTEGRITY: 'Nội dung gói không khớp dữ liệu nguồn đã chốt.',
    PACKAGE_PROVENANCE: 'Thiếu hoặc sai thông tin nguồn của vector.',
    PACKAGE_VECTORS: 'Vector thiếu, sai kích thước hoặc không hợp lệ.',
    PACKAGE_UNAVAILABLE: 'Không đọc được ZIP. Kiểm tra quyền đọc và chép lại tệp.',
  }
  return reasons[code] ?? 'Chưa thể dùng gói. Kiểm tra cấu hình rồi tải lại.'
}
const packageModel = (value: PackageModel) => shape(value, ['provider', 'model', 'dimension']) && typeof value.provider === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value.provider) &&
  typeof value.model === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/:-]{0,199}$/.test(value.model) && count(value.dimension, 65536) && value.dimension > 0
const packageReference = (value: VectorPackageReference) => shape(value, ['name', 'sha256']) && packageName(value.name) && hash(value.sha256)
const packageDirectory = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\x00-\x1f\x7f]/.test(value)
export async function loadBuilderPackages(signal?: AbortSignal): Promise<BuilderPackages> {
  const value = await api<BuilderPackages>('/admin/kag/builder/packages', { signal, cache: 'no-store' })
  const invalid = () => { throw new ApiError('Danh sách gói vector không hợp lệ', 502) }
  if (!shape(value, ['contract_version', 'directory', 'current_model', 'packages']) || value.contract_version !== 'builder-packages-v1' || !packageDirectory(value.directory) ||
    value.current_model !== null && !packageModel(value.current_model) || !Array.isArray(value.packages) || value.packages.length > 10000) invalid()
  const names = new Set<string>()
  for (const row of value.packages) {
    if (!shape(row, ['name', 'sha256', 'size', 'compatible', 'reason', 'manifest']) || !listedPackageName(row.name) || names.has(row.name) ||
      row.sha256 !== null && !hash(row.sha256) || !count(row.size, Number.MAX_SAFE_INTEGER) || typeof row.compatible !== 'boolean' ||
      typeof row.reason !== 'string' || row.reason.length > 1024 || row.compatible && (!packageName(row.name) || row.size > 32 * 1024 ** 3 || !row.sha256 || !row.manifest || !value.current_model)) invalid()
    const m = row.manifest
    if (m !== null && (!shape(m, ['format_version', 'plan_sha256', 'selection', 'model_identity', 'nodes', 'edges', 'vectors', 'fingerprint', 'application_version']) ||
      m.format_version !== 'luatgt-vector-package-v1' || !hash(m.plan_sha256) || !hash(m.fingerprint) || !packageModel(m.model_identity) ||
      m.selection !== null && (typeof m.selection !== 'object' || Array.isArray(m.selection)) || [m.nodes, m.edges, m.vectors].some(n => !count(n, Number.MAX_SAFE_INTEGER)) ||
      typeof m.application_version !== 'string' || !m.application_version || m.application_version.length > 255)) invalid()
    if (row.compatible && m && ['provider', 'model', 'dimension'].some(key => m.model_identity[key as keyof PackageModel] !== value.current_model![key as keyof PackageModel])) invalid()
    names.add(row.name)
  }
  return value
}
function validatePackageExport(value: BuilderPackageExport) {
  if (!shape(value, ['contract_version', 'state', 'name', 'size', 'code', 'directory']) || value.contract_version !== 'builder-package-export-v1' ||
    !['NOT_RUN', 'RUNNING', 'COMPLETE', 'FAILED'].includes(value.state) || !packageDirectory(value.directory) || value.name !== null && !packageName(value.name) ||
    value.size !== null && !count(value.size, Number.MAX_SAFE_INTEGER) || value.code !== null && (typeof value.code !== 'string' || !/^[A-Z0-9_]{1,64}$/.test(value.code)) ||
    value.state === 'COMPLETE' && (value.name === null || value.size === null || value.size > 32 * 1024 ** 3 || value.code !== null)) throw new ApiError('Trạng thái xuất gói không hợp lệ', 502)
  return value
}
export async function loadBuilderPackageExport(signal?: AbortSignal): Promise<BuilderPackageExport> {
  return validatePackageExport(await api<BuilderPackageExport>('/admin/kag/builder/packages/export', { signal, cache: 'no-store' }))
}
export async function exportBuilderPackage(project_id: number, run_id: string): Promise<BuilderPackageExport> {
  if (!count(project_id, 2147483647) || project_id < 1 || typeof run_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(run_id)) throw new ApiError('Project hoặc phiên xuất không hợp lệ', 400)
  return validatePackageExport(await api<BuilderPackageExport>('/admin/kag/builder/packages/export', send('POST', { project_id, run_id })))
}
export function changeServing(action: 'preview', project_id: number, run_id: string): Promise<ServingPreview>
export function changeServing(action: 'activate', project_id: number, run_id: string, preview_id: string): Promise<ServingPreview | ServingOperation>
export async function changeServing(action: 'preview' | 'activate', project_id: number, run_id: string, preview_id?: string): Promise<ServingPreview | ServingOperation> {
  const raw = await api<ServingPreview | ServingOperation>(`/admin/kag/serving/${action}`, send('POST', { project_id, run_id, ...(action === 'activate' ? { preview_id } : {}) }))
  if ('contract_version' in raw && raw.contract_version === 'builder-serving-operation-v1') {
    const operation=validateServingOperation(raw)
    if (action !== 'activate' || operation.project_id !== project_id || operation.run_id !== run_id || operation.state !== 'PREPARING') throw new ApiError('Thao tác không thuộc đồ thị đang chọn',502)
    return operation
  }
  const value=raw as ServingPreview
  if (value.project_id !== project_id || value.run_id !== run_id || !/^[0-9a-f]{64}$/.test(value.preview_id) ||
    !Array.isArray(value.chat_blockers) || action === 'activate' && value.status !== 'ACTIVE') throw new ApiError('Chưa xác nhận được kết quả; tải lại trạng thái trước khi thao tác tiếp', 502)
  return value
}

export type KagCheck = { state: 'ALIVE' | 'READY' | 'NOT_READY' | 'UNAVAILABLE' | 'NOT_CONFIGURED' | 'RELEASE_UNAVAILABLE'; httpStatus: number; code?: string; evidence?: Record<string, unknown> }
export type KagStatus = Record<'liveness' | 'queryReadiness' | 'retrievalReadiness' | 'vectorRetrievalReadiness' | 'release', KagCheck>
export type Retrieval = { contract_version: string; request_id: string; release_id: string; source_snapshot_id: string; schema_contract: Record<string, string>; items: { entity_type: string; entity_id: string; doc_id: string | null; unit_id: string | null; sign_id: string | null; source_texts: Record<string, string | null>; score: number | null; vector_sources: unknown[]; graph_context: unknown[] }[] }
export type PipelineStatus = { contract_version: string; phase: 'idle' | 'running' | 'draining' | 'closed' | 'unavailable'; active_requests: number | null; draining: boolean | null; closed: boolean | null; progress: null; execution_allowed: false; operational_proof: 'DENY'; production_write: 'BLOCKED'; provider_egress: 'DENY' }
export type KagConfiguration = {
  contract_version: 'kag-config-v1'
  project: { source: 'startup_environment'; release_id: string | null; release_state: 'NOT_CONFIGURED' | 'LOADED' | 'UNAVAILABLE' }
  models: { source: 'startup_environment'; identity_verified: false; chat: ModelConfiguration; embedding: ModelConfiguration }
  solver: null | { source: 'source_defaults'; pipeline: 'KAGIterativePipeline'; planner: 'KAGIterativePlanner'; top_k: number; expand: boolean; max_evidence_chars: number; max_iteration: number; search_k: number; expansion_limit: number; required_vector_dimensions: number }
}
type ModelConfiguration = { state: 'CONFIGURED' | 'NOT_CONFIGURED' | 'INCOMPLETE' | 'INVALID'; model: string | null; endpoint: string | null }
export type LLMInput = { provider: 'openai-compatible'; base_url: string; model: string; api_key?: string }
type LLMMetadata = Omit<LLMInput, 'api_key'> & { key_configured: true }
export type LLMCredentials = {
  contract_version: 'llm-credentials-v3'; revision: number; saved: boolean
  chat: LLMMetadata | null; embedding: LLMMetadata | null
  applied: boolean; connection_tested: boolean; save_allowed: boolean
  error_code: 'CONFIG_INVALID' | 'CONFIG_STORAGE_UNAVAILABLE' | null
  roles: Record<'chat' | 'embedding', {
    saved_revision: number | null; active_revision: number | null; active: LLMMetadata | null
    test: null | { revision: number; status: 'PASS' | 'FAIL' | 'BLOCKED'; code: string | null; dimension: number | null; observed_model: string | null; client_attempts: number; output_chars: number; tested_at: string }
    status: 'NOT_CONFIGURED' | 'SAVED' | 'PENDING_APPLY' | 'APPLIED' | 'BLOCKED'; blocker: string | null
    actions: { test: boolean; apply: boolean }
  }>
  build_config: { state: 'SEPARATE'; reason: 'BUILDER_CONFIGURATION_API' } | { state: 'NOT_SUPPORTED'; reason: 'BUILDER_REPLAY_ONLY' }
}
function llmInput(value: LLMInput) {
  if (!value || value.provider !== 'openai-compatible' || typeof value.model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/:-]{0,199}$/.test(value.model) ||
    typeof value.base_url !== 'string' || value.base_url.length > 2048 || /[\s\x00-\x1f\x7f]/.test(value.base_url)) return false
  try {
    const url = new URL(value.base_url)
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash || url.port === '0') return false
  } catch { return false }
  return value.api_key === undefined || typeof value.api_key === 'string' && /^[!-~]{1,4096}$/.test(value.api_key)
}
function validateLLMCredentials(value: LLMCredentials) {
  const invalid = () => { throw new ApiError('Metadata cấu hình model không hợp lệ', 502) }
  if (!shape(value, ['contract_version', 'revision', 'saved', 'chat', 'embedding', 'applied', 'connection_tested', 'save_allowed', 'error_code', 'roles', 'build_config']) ||
    value.contract_version !== 'llm-credentials-v3' || !count(value.revision, 2147483647) || typeof value.saved !== 'boolean' ||
    typeof value.save_allowed !== 'boolean' || typeof value.applied !== 'boolean' || typeof value.connection_tested !== 'boolean' ||
    !shape(value.roles, ['chat', 'embedding']) || !shape(value.build_config, ['state', 'reason']) ||
    !(value.build_config.state === 'SEPARATE' && value.build_config.reason === 'BUILDER_CONFIGURATION_API' ||
      value.build_config.state === 'NOT_SUPPORTED' && value.build_config.reason === 'BUILDER_REPLAY_ONLY') ||
    value.error_code !== null && !['CONFIG_INVALID', 'CONFIG_STORAGE_UNAVAILABLE'].includes(value.error_code)) invalid()
  for (const role of ['chat', 'embedding'] as const) {
    const model = value[role]
    if (model !== null && (!shape(model, ['provider', 'base_url', 'model', 'key_configured']) || !llmInput(model) || model.key_configured !== true)) invalid()
    const row = value.roles[role], test = row?.test
    if (!shape(row, ['saved_revision', 'test', 'active_revision', 'active', 'status', 'blocker', 'actions']) ||
      (row.saved_revision === null) !== (model === null) || row.saved_revision !== null && (!count(row.saved_revision, value.revision) || row.saved_revision < 1) ||
      row.active_revision !== null && (!count(row.active_revision, value.revision) || row.active_revision < 1) ||
      row.active !== null && (!shape(row.active, ['provider', 'base_url', 'model', 'key_configured']) || !llmInput(row.active) || row.active.key_configured !== true) ||
      !['NOT_CONFIGURED', 'SAVED', 'PENDING_APPLY', 'APPLIED', 'BLOCKED'].includes(row.status) ||
      row.blocker !== null && !modelErrorCodes.includes(row.blocker) || !shape(row.actions, ['test', 'apply']) ||
      typeof row.actions.test !== 'boolean' || typeof row.actions.apply !== 'boolean') invalid()
    if (test !== null && (!shape(test, ['revision', 'status', 'code', 'dimension', 'observed_model', 'client_attempts', 'output_chars', 'tested_at']) ||
      test.revision !== row.saved_revision || !['PASS', 'FAIL', 'BLOCKED'].includes(test.status) ||
      test.code !== null && !modelErrorCodes.includes(test.code) || (test.status === 'PASS') !== (test.code === null) ||
      !count(test.client_attempts, 1) || !count(test.output_chars, 262144) || test.dimension !== null && !count(test.dimension, 262144) ||
      test.observed_model !== null && (typeof test.observed_model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/:-]{0,199}$/.test(test.observed_model)) || typeof test.tested_at !== 'string' ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\+00:00$/.test(test.tested_at) ||
      test.status === 'PASS' && (test.client_attempts !== 1 || (role === 'embedding' ? test.dimension === null || test.dimension < 1 || test.dimension > 65536 : test.output_chars < 1)))) invalid()
    if (row.status === 'APPLIED' && (row.active_revision !== row.saved_revision || JSON.stringify(row.active) !== JSON.stringify(model))) invalid()
  }
  if (value.saved ? value.revision < 1 || value.chat === null && value.embedding === null : value.revision !== 0 || value.chat !== null || value.embedding !== null) invalid()
  if ((value.error_code !== null || value.revision === 2147483647) && value.save_allowed) invalid()
  if (value.applied !== Object.values(value.roles).some(row => row.status === 'APPLIED') ||
    value.connection_tested !== Object.values(value.roles).some(row => row.test?.status === 'PASS')) invalid()
  return value
}
const modelErrorCodes = ['TEST_REQUIRED', 'TEST_IN_PROGRESS', 'RELEASE_UNAVAILABLE', 'RELEASE_MISMATCH', 'VECTOR_IDENTITY_MISMATCH',
  'ACTIVE_CONFIG_INVALID', 'PROXY_POLICY_UNVERIFIED', 'BLOCKED', 'AUTH_FAILED', 'MODEL_NOT_FOUND', 'RATE_LIMITED', 'PROVIDER_ERROR',
  'MODEL_MISMATCH', 'DIMENSION_MISMATCH', 'INVALID_RESPONSE', 'TIMEOUT', 'NETWORK_ERROR']
export async function loadLLMCredentials(signal?: AbortSignal): Promise<LLMCredentials> {
  return validateLLMCredentials(await api<LLMCredentials>('/admin/kag/config/models', { signal, cache: 'no-store' }))
}
export async function saveLLMCredentials(revision: number, role: 'chat' | 'embedding', input: LLMInput): Promise<LLMCredentials> {
  if (!count(revision, 2147483646) || !['chat', 'embedding'].includes(role) || !llmInput(input)) throw new ApiError('Provider, model, Base URL hoặc API key không hợp lệ', 400)
  return validateLLMCredentials(await api<LLMCredentials>('/admin/kag/config/models', send('POST', { revision, [role]: input })))
}
export async function changeLLMModel(role: 'chat' | 'embedding', action: 'test' | 'apply', revision: number): Promise<LLMCredentials> {
  if (!count(revision, 2147483646) || !['chat', 'embedding'].includes(role) || !['test', 'apply'].includes(action)) throw new ApiError('Thao tác model không hợp lệ', 400)
  return validateLLMCredentials(await api<LLMCredentials>(`/admin/kag/config/models/${role}/${action}`, send('POST', { revision })))
}
export type ChatRetrievalValues = { top_k: number; expand: boolean }
export type ChatRetrievalConfiguration = {
  contract_version: 'chat-retrieval-v1'; revision: number
  saved: ChatRetrievalValues | null; active: ChatRetrievalValues | null; previous: ChatRetrievalValues | null
  persisted: boolean; pending: boolean; runtime_idle: boolean
  actions: { save: boolean; apply: boolean; restore: boolean }
  error_code: 'CONFIG_INVALID' | 'CONFIG_STORAGE_UNAVAILABLE' | null
}
function retrievalValues(value: unknown): value is ChatRetrievalValues {
  const v = value as ChatRetrievalValues
  return shape(v, ['top_k', 'expand']) && Number.isInteger(v.top_k) && v.top_k >= 1 && v.top_k <= 10 && typeof v.expand === 'boolean'
}
function validateChatRetrieval(value: ChatRetrievalConfiguration) {
  const invalid = () => { throw new ApiError('Cấu hình Retrieval cho Chat không hợp lệ', 502) }
  if (!shape(value, ['contract_version', 'revision', 'saved', 'active', 'previous', 'persisted', 'pending', 'runtime_idle', 'actions', 'error_code']) ||
    value.contract_version !== 'chat-retrieval-v1' || !count(value.revision, 2147483647) || !shape(value.actions, ['save', 'apply', 'restore']) ||
    typeof value.persisted !== 'boolean' || typeof value.pending !== 'boolean' || typeof value.runtime_idle !== 'boolean' ||
    value.error_code !== null && !['CONFIG_INVALID', 'CONFIG_STORAGE_UNAVAILABLE'].includes(value.error_code) ||
    (value.active === null ? value.saved !== null || value.previous !== null || value.error_code === null : !retrievalValues(value.active) || !retrievalValues(value.saved) || value.previous !== null && !retrievalValues(value.previous)) ||
    value.pending !== (value.active?.top_k !== value.saved?.top_k || value.active?.expand !== value.saved?.expand)) invalid()
  const available = value.active !== null && value.error_code === null && value.revision < 2147483647
  if (value.actions.save !== available || value.actions.apply !== (available && value.runtime_idle && value.pending) || value.actions.restore !== (available && value.runtime_idle && value.previous !== null)) invalid()
  return value
}
export async function loadChatRetrieval(signal?: AbortSignal): Promise<ChatRetrievalConfiguration> {
  return validateChatRetrieval(await api<ChatRetrievalConfiguration>('/admin/kag/config/retrieval', { signal, cache: 'no-store' }))
}
export async function changeChatRetrieval(action: 'save' | 'apply' | 'restore', revision: number, values?: ChatRetrievalValues): Promise<ChatRetrievalConfiguration> {
  if (!['save', 'apply', 'restore'].includes(action) || !count(revision, 2147483646) || (action === 'save' ? !retrievalValues(values) : values !== undefined)) throw new ApiError('Giá trị Retrieval không hợp lệ', 400)
  return validateChatRetrieval(await api<ChatRetrievalConfiguration>(`/admin/kag/config/retrieval/${action}`, send('POST', { revision, ...(values ? { values } : {}) })))
}
export async function loadKagConfiguration(signal?: AbortSignal): Promise<KagConfiguration> {
  const value = await api<KagConfiguration>('/admin/kag/config', { signal, cache: 'no-store' })
  const invalid = () => { throw new ApiError('Thông tin cấu hình KAG không hợp lệ', 502) }
  const optionalText = (v: unknown, pattern: RegExp) => v === null || typeof v === 'string' && pattern.test(v)
  if (!shape(value, ['contract_version', 'project', 'models', 'solver']) || value.contract_version !== 'kag-config-v1' ||
    !shape(value.project, ['source', 'release_id', 'release_state']) || value.project.source !== 'startup_environment' ||
    !['NOT_CONFIGURED', 'LOADED', 'UNAVAILABLE'].includes(value.project.release_state) ||
    !optionalText(value.project.release_id, /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/) || value.project.release_state === 'LOADED' && value.project.release_id === null ||
    !shape(value.models, ['source', 'identity_verified', 'chat', 'embedding']) || value.models.source !== 'startup_environment' || value.models.identity_verified !== false) invalid()
  for (const role of ['chat', 'embedding'] as const) {
    const model = value.models[role]
    if (!shape(model, ['state', 'model', 'endpoint']) || !['CONFIGURED', 'NOT_CONFIGURED', 'INCOMPLETE', 'INVALID'].includes(model.state) ||
      !optionalText(model.model, /^[A-Za-z0-9][A-Za-z0-9._/:-]{0,199}$/) || !optionalText(model.endpoint, /^https?:\/\/[A-Za-z0-9.\[\]:-]{1,260}$/) ||
      model.state === 'CONFIGURED' && (model.model === null || model.endpoint === null) ||
      model.state === 'NOT_CONFIGURED' && (model.model !== null || model.endpoint !== null)) invalid()
  }
  const solver = value.solver
  if (solver !== null && (!shape(solver, ['source', 'pipeline', 'planner', 'top_k', 'expand', 'max_evidence_chars', 'max_iteration', 'search_k', 'expansion_limit', 'required_vector_dimensions']) ||
    solver.source !== 'source_defaults' || solver.pipeline !== 'KAGIterativePipeline' || solver.planner !== 'KAGIterativePlanner' || typeof solver.expand !== 'boolean' ||
    [solver.top_k, solver.max_evidence_chars, solver.max_iteration, solver.search_k, solver.expansion_limit, solver.required_vector_dimensions].some(n => !count(n) || n < 1) || solver.top_k > solver.search_k)) invalid()
  return value
}
export type BuilderState = 'IDLE' | 'RUNNING' | 'STOPPING' | 'STOPPED' | 'COMPLETE' | 'BLOCKED' | 'ABANDONED' | 'CLEARED'
export const builderStages = ['preflight', 'plan', 'vectorize', 'export-artifact', 'write-nodes', 'verify-nodes', 'write-edges', 'verify', 'release'] as const
export type BuilderStage = typeof builderStages[number]
export type BuilderStatus = { state: BuilderState; run_id: string | null; target: { project_id: number; database: string; namespace: string } | null; progress: { stage: string; done: number; total: number } | null; error_code: string | null; actions: { build: boolean; stop: boolean; resume: boolean; abandon?: boolean; delete: false }; delete_reason: string | null; production_write: 'BLOCKED' | 'CONFIGURED' } & (
  { contract_version: 'builder-control-v1' } | {
    contract_version: 'builder-control-v2' | 'builder-control-v3'
    stages: { name: BuilderStage; state: 'PENDING' | 'RUNNING' | 'COMPLETE' | 'STOPPED' | 'BLOCKED'; done: number | null; total: number | null; error_code: string | null }[]
    timing: { started_at: string; updated_at: string } | null
    binding: { run_id: string; scope: 'FRESH_SAMPLE' | 'PRODUCTION'; plan_sha256: string; config_sha256: string; model_identity: string; database_id: string; project_id: number; database: string; namespace: string; node_limit?: number | null } | null
    result: { nodes: number; edges: number; vectors: number; dimension: number; indexes: 4; fingerprint: string; verified_at: string; chat_activation: 'SEPARATE' } | null
  })
export function builderStateLabel(state: BuilderState) {
  return { IDLE: 'Chưa dựng', RUNNING: 'Đang dựng đồ thị', STOPPING: 'Đang dừng an toàn', STOPPED: 'Đã dừng an toàn', COMPLETE: 'Đã xác minh đồ thị', BLOCKED: 'Cần xử lý', ABANDONED: 'Đã bỏ phiên · graph được giữ', CLEARED: 'Dữ liệu đã được yêu cầu xóa · phiên cũ chỉ là lịch sử' }[state]
}
function validateBuilder(value: BuilderStatus): BuilderStatus {
  const extended = value?.contract_version === 'builder-control-v3', detail = extended || value?.contract_version === 'builder-control-v2'
  if (!shape(value, ['contract_version', 'state', 'run_id', 'target', 'progress', 'error_code', 'actions', 'delete_reason', 'production_write', ...(detail ? ['stages', 'timing', 'binding', 'result'] : [])]) ||
    !['builder-control-v1', 'builder-control-v2', 'builder-control-v3'].includes(value.contract_version) || !['IDLE', 'RUNNING', 'STOPPING', 'STOPPED', 'COMPLETE', 'BLOCKED', ...(extended ? ['ABANDONED','CLEARED'] : [])].includes(value.state) || !['BLOCKED', 'CONFIGURED'].includes(value.production_write) || value.delete_reason !== null && (typeof value.delete_reason !== 'string' || !/^[A-Z_]{1,64}$/.test(value.delete_reason)) ||
    !value.actions || Object.keys(value.actions).sort().join() !== ['build', 'stop', 'resume', 'delete', ...(extended ? ['abandon'] : [])].sort().join() ||
    typeof value.actions.build !== 'boolean' || typeof value.actions.resume !== 'boolean' ||
    (detail ? value.actions.build && !['IDLE', 'COMPLETE', ...(extended ? ['ABANDONED','CLEARED'] : [])].includes(value.state) || value.actions.resume && value.state !== 'STOPPED' : value.actions.build !== ['IDLE', 'COMPLETE'].includes(value.state) || value.actions.resume !== (value.state === 'STOPPED')) ||
    extended && value.actions.abandon !== (value.state === 'STOPPED') ||
    value.actions.stop !== (value.state === 'RUNNING') || value.actions.delete !== false ||
    (value.run_id === null ? !['IDLE', 'BLOCKED'].includes(value.state) : typeof value.run_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.run_id))) throw new ApiError('Trạng thái Builder không hợp lệ', 502)
  const target = value.target, progress = value.progress
  if (target === null ? value.state !== 'BLOCKED' : !target || Object.keys(target).sort().join() !== ['project_id', 'database', 'namespace'].sort().join() || !Number.isInteger(target.project_id) || target.project_id < 1 || !(value.production_write === 'CONFIGURED' ? /^[a-z][a-z0-9.-]{0,62}$/ : /^(?:neo4j|vietroadtraffic|freshsample[a-z0-9]{8,40})$/).test(target.database) || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(target.namespace)) throw new ApiError('Cấu hình đích Builder không hợp lệ', 502)
  if (progress !== null && (!progress || Object.keys(progress).sort().join() !== ['stage', 'done', 'total'].sort().join() || !['preflight', 'plan', 'vectorize', 'export-artifact', 'write-nodes', 'verify-nodes', 'write-edges', 'verify', 'release'].includes(progress.stage) || !Number.isSafeInteger(progress.done) || !Number.isSafeInteger(progress.total) || progress.done < 0 || progress.total < progress.done)) throw new ApiError('Tiến độ Builder không hợp lệ', 502)
  if (value.error_code !== null && (typeof value.error_code !== 'string' || !/^[A-Z_]{1,32}$/.test(value.error_code))) throw new ApiError('Lỗi Builder không hợp lệ', 502)
  if (value.contract_version !== 'builder-control-v1') {
    const invalid = () => { throw new ApiError('Kết quả Builder không hợp lệ', 502) }
    const { stages, binding, timing, result } = value
    const timestamp = (text: unknown) => typeof text === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(text) && Number.isFinite(Date.parse(text))
    if (!Array.isArray(stages) || stages.length !== (binding === null ? 0 : builderStages.length)) invalid()
    for (const [index, row] of stages.entries()) {
      if (!shape(row, ['name', 'state', 'done', 'total', 'error_code']) || row.name !== builderStages[index] ||
        !['PENDING', 'RUNNING', 'COMPLETE', 'STOPPED', 'BLOCKED'].includes(row.state) ||
        (row.state === 'PENDING' ? row.done !== null || row.total !== null : !count(row.done) || !count(row.total) || row.done! > row.total!) ||
        row.state === 'COMPLETE' && row.done !== row.total || row.error_code !== null && (typeof row.error_code !== 'string' || !/^[A-Z_]{1,32}$/.test(row.error_code))) invalid()
    }
    if (binding === null) {
      if (timing !== null || result !== null || value.state === 'COMPLETE') invalid()
    } else {
      if (!shape(binding, ['run_id', 'scope', 'plan_sha256', 'config_sha256', 'model_identity', 'database_id', 'project_id', 'database', 'namespace', ...('node_limit' in binding ? ['node_limit'] : [])]) || binding.run_id !== value.run_id ||
        'node_limit' in binding && (binding.node_limit !== null && (!count(binding.node_limit) || binding.node_limit < 3 || binding.node_limit > 2147483647) || binding.scope !== 'PRODUCTION') ||
        !['FRESH_SAMPLE', 'PRODUCTION'].includes(binding.scope) || !hash(binding.plan_sha256) || !hash(binding.config_sha256) ||
        typeof binding.database_id !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(binding.database_id) ||
        !target || binding.project_id !== target.project_id || binding.database !== target.database || binding.namespace !== target.namespace ||
        (binding.scope === 'PRODUCTION') !== (value.production_write === 'CONFIGURED')) invalid()
      try {
        const split = binding.model_identity.lastIndexOf('|'), url = new URL(binding.model_identity.slice(0, split))
        if (split < 1 || !/^[A-Za-z0-9][A-Za-z0-9._/:-]{0,199}$/.test(binding.model_identity.slice(split + 1)) || !['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) invalid()
      } catch { invalid() }
      if (!shape(timing, ['started_at', 'updated_at']) || !timestamp(timing!.started_at) || !timestamp(timing!.updated_at)) invalid()
      if (result === null) {
        if (value.state === 'COMPLETE') invalid()
      } else if (value.state !== 'COMPLETE' || !shape(result, ['nodes', 'edges', 'vectors', 'dimension', 'indexes', 'fingerprint', 'verified_at', 'chat_activation']) ||
        !count(result.nodes) || !count(result.edges) || !count(result.vectors) || !count(result.dimension) || result.dimension < 1 || result.dimension > 65536 || result.indexes !== 4 || !hash(result.fingerprint) || !timestamp(result.verified_at) || result.chat_activation !== 'SEPARATE' || stages.some(row => row.state !== 'COMPLETE')) invalid()
    }
  }
  return value
}
export async function loadBuilderStatus(signal?: AbortSignal): Promise<BuilderStatus> {
  return validateBuilder(await api<BuilderStatus>('/admin/kag/builder/status', { signal, cache: 'no-store' }))
}
export type BuilderConfiguration = {
  contract_version: 'builder-configuration-v1' | 'builder-configuration-v2' | 'builder-configuration-v3' | 'builder-configuration-v4' | 'builder-configuration-v5'; revision: number; saved: boolean; error_code: 'CONFIG' | null
  vector_package?: VectorPackageReference | null
  target: { project_id: number; project_name: string; database: string; namespace: string } | null
  embedding: { provider: 'openai-compatible'; base_url: string; model: string; revision: number; key_configured: boolean; tested: boolean; dimension: number | null } | null
  batch_size: number; request_limit: number | null
  selection?: { node_limit: number | null; nodes: number | null; edges: number | null; request?: SelectionRequest; summary?: SelectionSummary | null }
  links?: { openspg: string; neo4j: string; bolt: string } | null
  readiness: { state: 'NOT_RUN' | 'CHECKING' | 'READY' | 'BLOCKED'; checks: { name: 'source' | 'embedding' | 'target' | 'lock'; state: 'READY' | 'BLOCKED' | 'NOT_CHECKED'; code: string | null; owner?: { run_id: string; project_id: number } }[]; checked_at: string | null }
}
export type BuilderConfigurationChange = Pick<BuilderConfiguration, 'revision' | 'batch_size' | 'request_limit' | 'vector_package'> & { embedding_revision: number; node_limit?: number | null; project_id?: number; selection_preview_id?: string }
export type SelectionRequest = { mode: 'ALL' | 'COUNT' | 'PERCENT'; value: number | null }
export type SelectionSummary = { nodes: number; edges: number; node_counts: Record<string, number>; edge_counts: Record<string, number>; excluded_edges: number }
export type BuilderSelection = { contract_version: 'builder-selection-v1'; revision: number; preview_id: string; node_limit: number | null; request: SelectionRequest; summary: SelectionSummary }
function validSelectionRequest(request: SelectionRequest) {
  return shape(request, ['mode', 'value']) && ['ALL', 'COUNT', 'PERCENT'].includes(request.mode) &&
    (request.mode === 'ALL' ? request.value === null : count(request.value) && request.value! >= (request.mode === 'COUNT' ? 3 : 1) && request.value! <= (request.mode === 'COUNT' ? 2147483647 : 100))
}
function validSelectionSummary(summary: SelectionSummary) {
  return shape(summary, ['nodes', 'edges', 'node_counts', 'edge_counts', 'excluded_edges']) && count(summary.nodes) && count(summary.edges) && count(summary.excluded_edges) &&
    (['node_counts', 'edge_counts'] as const).every(name => {
      const counts = summary[name]
      return !!counts && typeof counts === 'object' && !Array.isArray(counts) && Object.keys(counts).length <= 512 &&
        Object.entries(counts).every(([key, value]) => /^[A-Za-z][A-Za-z0-9_.]{0,255}$/.test(key) && count(value)) &&
        Object.values(counts).reduce((a, b) => a + b, 0) === summary[name === 'node_counts' ? 'nodes' : 'edges']
    })
}
export async function previewBuilderSelection(revision: number, request: SelectionRequest): Promise<BuilderSelection> {
  const value = await api<BuilderSelection>('/admin/kag/builder/selection', send('POST', { revision, ...request }))
  if (!shape(value, ['contract_version', 'revision', 'preview_id', 'node_limit', 'request', 'summary']) || value.contract_version !== 'builder-selection-v1' || value.revision !== revision || !hash(value.preview_id) ||
    !validSelectionRequest(value.request) || !validSelectionSummary(value.summary) || value.request.mode !== request.mode || value.request.value !== request.value ||
    (value.request.mode === 'ALL' ? value.node_limit !== null : !count(value.node_limit) || value.node_limit! < 3 || value.node_limit !== value.summary.nodes)) throw new ApiError('Bản xem trước phạm vi không hợp lệ', 502)
  return value
}
export type BuilderStructure = {
  contract_version: 'builder-structure-v1'; state: 'NOT_RUN' | 'PREVIEW' | 'APPLYING' | 'COMPLETE' | 'PARTIAL' | 'INTERRUPTED' | 'BLOCKED'
  revision: number; preview_id: string | null; checked_at: string | null; can_apply: boolean; code: string | null
  report: { target: NonNullable<BuilderConfiguration['target']>; database_id: string; dimension: number; counts: { nodes: number; edges: number }
    changes: { kind: 'type' | 'property' | 'relation'; action: 'ADD' | 'UPDATE' | 'REMOVE' | 'KEEP'; name: string }[]
    indexes: { label: string; property: string; action: 'ADD' | 'KEEP' | 'REBUILD' | 'BLOCKED' }[]; conflicts: string[]; native_rebuild: string[]; code: string | null
    build_ready?: boolean; default_types?: string[]
    index_changes?: { name: string; type: string; labels: string[]; properties: string[]; action: 'ADD' | 'KEEP' | 'REMOVE' | 'REBUILD' | 'BLOCKED' }[] } | null
}
function validateBuilderStructure(value: BuilderStructure) {
  const invalid = () => { throw new ApiError('Trạng thái chuẩn bị cấu trúc không hợp lệ', 502) }
  const code = (v: unknown) => v === null || typeof v === 'string' && /^[A-Z_]{1,32}$/.test(v)
  if (!shape(value, ['contract_version', 'state', 'revision', 'preview_id', 'checked_at', 'can_apply', 'report', 'code']) ||
    value.contract_version !== 'builder-structure-v1' || !['NOT_RUN', 'PREVIEW', 'APPLYING', 'COMPLETE', 'PARTIAL', 'INTERRUPTED', 'BLOCKED'].includes(value.state) ||
    !count(value.revision) || value.revision > 2147483647 || value.preview_id !== null && !hash(value.preview_id) || typeof value.can_apply !== 'boolean' || !code(value.code) ||
    value.checked_at !== null && (typeof value.checked_at !== 'string' || !Number.isFinite(Date.parse(value.checked_at)))) invalid()
  const r = value.report
  if (r !== null) {
    const extended = 'build_ready' in r
    if (!shape(r, ['target', 'database_id', 'dimension', 'counts', 'changes', 'indexes', 'conflicts', 'code', 'native_rebuild', ...(extended ? ['build_ready', 'default_types', 'index_changes'] : [])]) ||
      !shape(r.target, ['project_id', 'project_name', 'namespace', 'database']) || !count(r.target.project_id) || r.target.project_id < 1 ||
      typeof r.target.project_name !== 'string' || r.target.project_name.length > 255 || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(r.target.namespace) || !/^[a-z][a-z0-9.-]{0,62}$/.test(r.target.database) ||
      typeof r.database_id !== 'string' || !r.database_id || r.database_id.length > 255 || !count(r.dimension) || r.dimension < 1 || r.dimension > 65536 ||
      !shape(r.counts, ['nodes', 'edges']) || !count(r.counts.nodes) || !count(r.counts.edges) || !code(r.code) ||
      !Array.isArray(r.changes) || r.changes.length > 512 || r.changes.some(row => !shape(row, ['kind', 'action', 'name']) || !['type', 'property', 'relation'].includes(row.kind) || !['ADD', 'UPDATE', 'REMOVE', 'KEEP'].includes(row.action) || !/^[A-Za-z][A-Za-z0-9_.]{0,255}$/.test(row.name)) ||
      !Array.isArray(r.indexes) || r.indexes.length !== 4 || r.indexes.some(row => !shape(row, ['label', 'property', 'action']) || !/^[A-Za-z][A-Za-z0-9_]{0,63}\.(LegalDocument|LegalUnit|TrafficSign)$/.test(row.label) || !['_title_vector', '_text_vector', '_ten_vector', '_mo_ta_vector'].includes(row.property) || !['ADD', 'KEEP', 'REBUILD', 'BLOCKED'].includes(row.action)) ||
      [r.conflicts, r.native_rebuild].some(rows => !Array.isArray(rows) || rows.length > 2048 || rows.some(text => typeof text !== 'string' || text.length > 512))) invalid()
    if (extended && (typeof r.build_ready !== 'boolean' || !Array.isArray(r.default_types) || r.default_types.length > 18 || r.default_types.some(name => typeof name !== 'string' || !/^[A-Za-z][A-Za-z0-9_.]{0,255}$/.test(name)) ||
      !Array.isArray(r.index_changes) || r.index_changes.length > 2048 || r.index_changes.some(row => !shape(row, ['name', 'type', 'labels', 'properties', 'action']) ||
        typeof row.name !== 'string' || !row.name || row.name.length > 512 || typeof row.type !== 'string' || !/^[A-Z_]{1,32}$/.test(row.type) ||
        !['ADD', 'KEEP', 'REMOVE', 'REBUILD', 'BLOCKED'].includes(row.action) || [row.labels, row.properties].some(items => !Array.isArray(items) || items.length > 512 || items.some(item => typeof item !== 'string' || item.length > 512))))) invalid()
  }
  if (value.can_apply && (value.state !== 'PREVIEW' || !r || r.code !== null)) invalid()
  if (value.state === 'COMPLETE' && (!r || r.code !== null || r.changes.some(row => row.action !== 'KEEP') || r.indexes.some(row => row.action !== 'KEEP') || r.default_types?.length || r.index_changes?.some(row => row.action !== 'KEEP'))) invalid()
  return value
}
export async function loadBuilderStructure(signal?: AbortSignal): Promise<BuilderStructure> {
  return validateBuilderStructure(await api<BuilderStructure>('/admin/kag/builder/structure', { signal, cache: 'no-store' }))
}
export async function prepareBuilderStructure(action: 'preview' | 'apply', project_id: number, revision: number, preview_id?: string): Promise<BuilderStructure> {
  return validateBuilderStructure(await api<BuilderStructure>('/admin/kag/builder/structure/' + action, send('POST', { project_id, revision, ...(action === 'apply' ? { preview_id } : {}) })))
}
export type BuilderClear = {
  contract_version: 'builder-clear-v1'; state: 'NOT_RUN' | 'PREVIEW' | 'APPLYING' | 'COMPLETE' | 'PARTIAL' | 'INTERRUPTED' | 'BLOCKED'
  revision: number; preview_id: string | null; checked_at: string | null; code: string | null; deleted: { nodes: number; edges: number }
  report: { target: NonNullable<BuilderConfiguration['target']>; database_id: string; counts: { nodes: number; edges: number }; batch_size: 500 } | null
}
function validateBuilderClear(value: BuilderClear) {
  const invalid = () => { throw new ApiError('Trạng thái xóa dữ liệu không hợp lệ', 502) }
  if (!shape(value, ['contract_version','state','revision','preview_id','checked_at','code','deleted','report']) || value.contract_version !== 'builder-clear-v1' ||
    !['NOT_RUN','PREVIEW','APPLYING','COMPLETE','PARTIAL','INTERRUPTED','BLOCKED'].includes(value.state) || !count(value.revision) || value.revision > 2147483647 ||
    value.preview_id !== null && !hash(value.preview_id) || value.code !== null && (typeof value.code !== 'string' || !/^[A-Z_]{1,32}$/.test(value.code)) ||
    value.checked_at !== null && (typeof value.checked_at !== 'string' || !Number.isFinite(Date.parse(value.checked_at))) ||
    !shape(value.deleted, ['nodes','edges']) || !count(value.deleted.nodes) || !count(value.deleted.edges)) invalid()
  const report = value.report
  if (report === null) {
    if (['PREVIEW','APPLYING','COMPLETE','PARTIAL'].includes(value.state)) invalid()
  } else if (!shape(report, ['target','database_id','counts','batch_size']) || report.batch_size !== 500 || !/^[A-Za-z0-9._:-]{1,128}$/.test(report.database_id) ||
    !shape(report.target, ['project_id','project_name','namespace','database']) || !count(report.target.project_id) || report.target.project_id < 1 ||
    typeof report.target.project_name !== 'string' || !report.target.project_name.trim() || report.target.project_name.length > 255 ||
    !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(report.target.namespace) || !/^[a-z][a-z0-9.-]{0,62}$/.test(report.target.database) ||
    !shape(report.counts, ['nodes','edges']) || !count(report.counts.nodes) || !count(report.counts.edges)) invalid()
  return value
}
export async function loadBuilderClear(signal?: AbortSignal): Promise<BuilderClear> {
  return validateBuilderClear(await api<BuilderClear>('/admin/kag/builder/clear', { signal, cache: 'no-store' }))
}
export async function clearBuilderData(project_id: number, database_id: string): Promise<BuilderClear> {
  if (!count(project_id,2147483647) || project_id < 1 || !/^[A-Za-z0-9._:-]{1,128}$/.test(database_id)) throw new ApiError('Đích đồ thị không hợp lệ. Tải lại danh sách.',400)
  return validateBuilderClear(await api<BuilderClear>('/admin/kag/builder/clear/apply', send('POST', { project_id, database_id })))
}
function validateBuilderConfiguration(value: BuilderConfiguration): BuilderConfiguration {
  const invalid = () => { throw new ApiError('Cấu hình Builder không hợp lệ', 502) }
  const packaged = value.contract_version === 'builder-configuration-v5', extended = packaged || value.contract_version === 'builder-configuration-v4', projects = extended || value.contract_version === 'builder-configuration-v3', selected = projects || value.contract_version === 'builder-configuration-v2'
  if (!shape(value, ['contract_version', 'revision', 'saved', 'error_code', 'target', 'embedding', 'batch_size', 'request_limit', 'readiness', ...(selected ? ['selection'] : []), ...(projects ? ['links'] : []), ...(packaged ? ['vector_package'] : [])]) ||
    !['builder-configuration-v1', 'builder-configuration-v2', 'builder-configuration-v3', 'builder-configuration-v4', 'builder-configuration-v5'].includes(value.contract_version) || !count(value.revision) || value.revision > 2147483647 || typeof value.saved !== 'boolean' || value.saved !== (value.revision > 0) ||
    ![null, 'CONFIG'].includes(value.error_code) || !count(value.batch_size) || value.batch_size < 1 || value.batch_size > 4096 ||
    value.request_limit !== null && (!count(value.request_limit) || value.request_limit < 1 || value.request_limit > 1000000) || packaged && value.vector_package !== null && !packageReference(value.vector_package!)) invalid()
  if (selected) {
    const selection = value.selection
    if (!shape(selection, ['node_limit', 'nodes', 'edges', ...(extended ? ['request', 'summary'] : [])]) || selection!.node_limit !== null && (!count(selection!.node_limit) || selection!.node_limit! < 3 || selection!.node_limit! > (extended ? 2147483647 : 128)) ||
      selection!.nodes !== null && !count(selection!.nodes) || selection!.edges !== null && !count(selection!.edges) ||
      selection!.node_limit !== null && (selection!.nodes === null || selection!.nodes < 1 || selection!.nodes > selection!.node_limit || selection!.edges === null || selection!.edges < 1 || selection!.edges > (extended ? 2147483647 : 256))) invalid()
    if (extended && (!validSelectionRequest(selection!.request!) || selection!.summary !== null && (!validSelectionSummary(selection!.summary!) || selection!.summary!.nodes !== selection!.nodes || selection!.summary!.edges !== selection!.edges))) invalid()
  }
  const target = value.target, embedding = value.embedding, ready = value.readiness
  if (target !== null && (!shape(target, ['project_id', 'project_name', 'database', 'namespace']) || !count(target.project_id) || target.project_id < 1 ||
    typeof target.project_name !== 'string' || !target.project_name.trim() || target.project_name.length > 255 || !/^[a-z][a-z0-9.-]{0,62}$/.test(target.database) || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(target.namespace))) invalid()
  if (projects && value.links !== null) {
    if (!shape(value.links, ['openspg', 'neo4j', 'bolt'])) invalid()
    for (const [name, text] of Object.entries(value.links!)) {
      try {
        const url = new URL(text)
        if (!(name === 'bolt' ? ['bolt:', 'neo4j:', 'bolt+s:', 'neo4j+s:'] : ['http:', 'https:']).includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) invalid()
      } catch { invalid() }
    }
  }
  if (embedding !== null) {
    if (!shape(embedding, ['provider', 'base_url', 'model', 'revision', 'key_configured', 'tested', 'dimension']) || embedding.provider !== 'openai-compatible' ||
      !count(embedding.revision) || embedding.revision < 1 || typeof embedding.key_configured !== 'boolean' || typeof embedding.tested !== 'boolean' ||
      typeof embedding.model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/:-]{0,199}$/.test(embedding.model) ||
      embedding.dimension !== null && (!count(embedding.dimension) || embedding.dimension < 1 || embedding.dimension > 65536)) invalid()
    try {
      const url = new URL(embedding.base_url)
      if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) invalid()
    } catch { invalid() }
  }
  if (!shape(ready, ['state', 'checks', 'checked_at']) || !['NOT_RUN', 'CHECKING', 'READY', 'BLOCKED'].includes(ready.state) ||
    !Array.isArray(ready.checks) || ready.checks.length > 4 || ready.checked_at !== null && (typeof ready.checked_at !== 'string' || !Number.isFinite(Date.parse(ready.checked_at)))) invalid()
  const names = new Set<string>()
  for (const row of ready.checks) {
    if (!shape(row, row.owner === undefined ? ['name', 'state', 'code'] : ['name', 'state', 'code', 'owner']) || !['source', 'embedding', 'target', 'lock'].includes(row.name) || names.has(row.name) ||
      !['READY', 'BLOCKED', 'NOT_CHECKED'].includes(row.state) || row.state === 'NOT_CHECKED' && !['WAIT_SOURCE', 'WAIT_EMBEDDING', 'WAIT_TARGET'].includes(row.code ?? '') ||
      (row.state === 'READY' ? row.code !== null : typeof row.code !== 'string' || !/^[A-Z_]{1,32}$/.test(row.code))) invalid()
    if (row.owner !== undefined && (row.name !== 'lock' || row.state !== 'BLOCKED' || !['LOCK', 'UNCERTAIN_WRITE'].includes(row.code ?? '') ||
      !shape(row.owner, ['run_id', 'project_id']) || typeof row.owner.run_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(row.owner.run_id) ||
      !count(row.owner.project_id) || row.owner.project_id < 1 || row.owner.project_id > 2147483647)) invalid()
    names.add(row.name)
  }
  if (ready.state === 'READY' && (names.size !== 4 || ready.checks.some(row => row.state !== 'READY') || !value.saved || !target || !embedding?.tested || !count(embedding.dimension) || embedding.dimension! < 1 || embedding.dimension! > 65536)) invalid()
  return value
}
export async function loadBuilderConfiguration(signal?: AbortSignal): Promise<BuilderConfiguration> {
  return validateBuilderConfiguration(await api<BuilderConfiguration>('/admin/kag/builder/configuration', { signal, cache: 'no-store' }))
}
export async function saveBuilderConfiguration(change: BuilderConfigurationChange): Promise<BuilderConfiguration> {
  return validateBuilderConfiguration(await api<BuilderConfiguration>('/admin/kag/builder/configuration', send('POST', change)))
}
export async function checkBuilderReadiness(): Promise<BuilderConfiguration> {
  return validateBuilderConfiguration(await api<BuilderConfiguration>('/admin/kag/builder/preflight', { method: 'POST' }))
}
export function selectionVectorCount(summary: SelectionSummary): number {
  return Object.entries(summary.node_counts).reduce((total, [name, count]) =>
    total + count * (name.split('.').pop() === 'TrafficSign' ? 2 : ['LegalDocument', 'LegalUnit'].includes(name.split('.').pop()!) ? 1 : 0), 0)
}
export async function startBuilderGraph(options: {
  projectId: number; selection: BuilderSelection; planSha256: string; vectorPackage?: VectorPackageReference
}, onProgress: (step: string) => void): Promise<BuilderStatus> {
  onProgress('Kiểm tra đồ thị trống')
  const graph = await loadGraphProject(options.projectId)
  if (graph.counts.nodes || graph.counts.edges) throw new ApiError('Đồ thị còn dữ liệu. Chọn đồ thị trống khác.', 409)
  let config = await loadBuilderConfiguration()
  if (config.revision !== options.selection.revision || !config.embedding?.tested) throw new ApiError('Cấu hình đã đổi. Tải lại rồi xác nhận lại.', 409)
  onProgress('Chuẩn bị cấu trúc')
  let structure = await prepareBuilderStructure('preview', options.projectId, config.revision)
  if (!structure.report || structure.code || structure.report.code || structure.report.counts.nodes || structure.report.counts.edges) {
    throw new ApiError('Chưa chuẩn bị được cấu trúc. Xem chi tiết rồi chọn đồ thị trống phù hợp.', 409)
  }
  if (structure.can_apply) {
    structure = await prepareBuilderStructure('apply', options.projectId, config.revision, structure.preview_id!)
    while (structure.state === 'APPLYING') {
      await new Promise(resolve => setTimeout(resolve, 1500))
      structure = await loadBuilderStructure()
    }
    if (structure.state !== 'COMPLETE' || structure.report?.target.project_id !== options.projectId) throw new ApiError('Chuẩn bị cấu trúc chưa hoàn tất. Tải lại trạng thái trước khi thử tiếp.', 409)
  } else if (!structure.report.build_ready) throw new ApiError('Cấu trúc chưa sẵn sàng. Mở chi tiết để kiểm tra.', 409)
  onProgress('Lưu phạm vi và cấu hình')
  const selected = await previewBuilderSelection(config.revision, options.selection.request)
  if (JSON.stringify(selected.summary) !== JSON.stringify(options.selection.summary)) throw new ApiError('Dữ liệu hoặc phạm vi đã đổi. Tải lại rồi xác nhận lại.', 409)
  config = await saveBuilderConfiguration({ revision: config.revision, embedding_revision: config.embedding!.revision,
    project_id: options.projectId, batch_size: config.batch_size, request_limit: config.request_limit,
    selection_preview_id: selected.preview_id, vector_package: options.vectorPackage ?? null })
  const savedRevision = config.revision
  onProgress(options.vectorPackage ? 'Kiểm tra và nhập gói' : 'Kiểm tra dữ liệu nguồn')
  let inputs = await loadBuilderInputs(undefined, true)
  while (inputs.source_validation.state === 'CHECKING') {
    await new Promise(resolve => setTimeout(resolve, 1500))
    inputs = await loadBuilderInputs()
  }
  if (inputs.source_validation.state !== 'VALID' || inputs.source_validation.plan_sha256 !== options.planSha256) throw new ApiError('Nguồn hoặc gói không khớp. Tải lại dữ liệu rồi xác nhận lại.', 409)
  onProgress('Kiểm tra sẵn sàng')
  config = await checkBuilderReadiness()
  while (config.readiness.state === 'CHECKING') {
    await new Promise(resolve => setTimeout(resolve, 1500))
    config = await loadBuilderConfiguration()
  }
  if (config.readiness.state !== 'READY' || config.target?.project_id !== options.projectId || config.revision !== savedRevision) throw new ApiError('Đồ thị chưa sẵn sàng hoặc cấu hình đã đổi. Tải lại trước khi thử tiếp.', 409)
  onProgress('Bắt đầu dựng đồ thị')
  return runBuilderAction('build', `build-${crypto.randomUUID()}`, config.revision)
}
export type BuilderProjects = {
  contract_version: 'builder-projects-v1'
  state: 'AVAILABLE' | 'EMPTY' | 'FORBIDDEN' | 'NOT_CONFIGURED' | 'UNAVAILABLE'
  projects: { project_id: number; project_name: string; namespace: string; database: string | null; state: 'AVAILABLE' | 'CONNECTION_NOT_CONFIGURED' | 'SERVING_PROTECTED' }[]
}
export async function loadBuilderProjects(signal?: AbortSignal): Promise<BuilderProjects> {
  return validateBuilderProjects(await api<BuilderProjects>('/admin/kag/builder/projects', { signal, cache: 'no-store' }))
}
export async function createBuilderProject(name: string): Promise<number> {
  if (!name.trim() || name.length > 255 || /[\x00-\x1f\x7f-\x9f]/.test(name)) throw new ApiError('Nhập tên đồ thị, tối đa 255 ký tự', 400)
  const value = validateBuilderProjects(await api<BuilderProjects>('/admin/kag/builder/projects', { method: 'POST', body: JSON.stringify({ name: name.trim() }) }))
  if (value.projects.length !== 1 || value.projects[0].state !== 'AVAILABLE' || value.projects[0].project_name !== name.trim()) throw new ApiError('Chưa xác định đồ thị đã tạo. Tải lại danh sách trước khi thử tiếp.', 502)
  return value.projects[0].project_id
}
function validateBuilderProjects(value: BuilderProjects): BuilderProjects {
  const invalid = () => { throw new ApiError('Danh sách project không hợp lệ', 502) }
  if (!shape(value, ['contract_version', 'state', 'projects']) || value.contract_version !== 'builder-projects-v1' ||
    !['AVAILABLE', 'EMPTY', 'FORBIDDEN', 'NOT_CONFIGURED', 'UNAVAILABLE'].includes(value.state) || !Array.isArray(value.projects) || value.projects.length > 10000) invalid()
  const ids = new Set<number>()
  for (const row of value.projects) {
    if (!shape(row, ['project_id', 'project_name', 'namespace', 'database', 'state']) || !count(row.project_id) || row.project_id < 1 || row.project_id > 2147483647 || ids.has(row.project_id) ||
      typeof row.project_name !== 'string' || !row.project_name.trim() || row.project_name.length > 255 || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(row.namespace) ||
      row.database !== null && !/^[a-z][a-z0-9.-]{0,62}$/.test(row.database) || !['AVAILABLE', 'CONNECTION_NOT_CONFIGURED', 'SERVING_PROTECTED'].includes(row.state) || row.state === 'AVAILABLE' && row.database === null) invalid()
    ids.add(row.project_id)
  }
  if ((value.state === 'AVAILABLE') !== (value.projects.length > 0)) invalid()
  return value
}
export function builderNeo4jLink(links: BuilderConfiguration['links'], database: string | undefined): string | undefined {
  if (!links || !database || !/^[a-z][a-z0-9.-]{0,62}$/.test(database)) return
  const url = new URL(links.neo4j)
  url.searchParams.set('connectURL', links.bolt)
  url.searchParams.set('db', database)
  return url.toString()
}
export type GraphProject = {
  contract_version: 'graph-project-v1'; target: NonNullable<BuilderConfiguration['target']>; database_id: string
  measured_from: string; measured_at: string; counts: { nodes: number; edges: number; vectors: number }
  labels: { name: string; count: number }[]; relations: { name: string; count: number }[]
  indexes: { name: string; state: string; type: string; labels: string[]; properties: string[]; dimension: number | null }[]
  vector_count_kind: 'NONEMPTY'
}
export async function loadGraphProject(projectId: number, signal?: AbortSignal): Promise<GraphProject> {
  if (!Number.isSafeInteger(projectId) || projectId < 1 || projectId > 2147483647) throw new ApiError('ID project không hợp lệ', 400)
  const value = await api<GraphProject>('/admin/kag/graph/' + projectId, { signal, cache: 'no-store' })
  const invalid = () => { throw new ApiError('Số liệu graph không hợp lệ', 502) }
  const text = (v: unknown, max = 512): v is string => typeof v === 'string' && !!v.trim() && v.length <= max
  if (!shape(value, ['contract_version','target','database_id','measured_from','measured_at','counts','labels','relations','indexes','vector_count_kind']) ||
    value.contract_version !== 'graph-project-v1' || value.vector_count_kind !== 'NONEMPTY' || !text(value.database_id, 255) ||
    !shape(value.target, ['project_id','project_name','namespace','database']) || value.target.project_id !== projectId || !text(value.target.project_name, 255) ||
    !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value.target.namespace) || !/^[a-z][a-z0-9.-]{0,62}$/.test(value.target.database) ||
    [value.measured_from,value.measured_at].some(v => !text(v, 64) || !Number.isFinite(Date.parse(v))) ||
    !shape(value.counts, ['nodes','edges','vectors']) || Object.values(value.counts).some(v => !count(v))) invalid()
  for (const rows of [value.labels, value.relations]) {
    if (!Array.isArray(rows) || rows.length > 2048 || rows.some(row => !shape(row, ['name','count']) || !text(row.name) || !count(row.count)) ||
      new Set(rows.map(row => row.name)).size !== rows.length) invalid()
  }
  if (!Array.isArray(value.indexes) || value.indexes.length > 2048 || value.indexes.some(row =>
    !shape(row, ['name','state','type','labels','properties','dimension']) || !text(row.name) || !text(row.state, 32) || !text(row.type, 32) ||
    [row.labels,row.properties].some(rows => !Array.isArray(rows) || rows.length > 512 || rows.some(v => !text(v))) ||
    row.dimension !== null && (!count(row.dimension) || row.dimension < 1 || row.dimension > 65536))) invalid()
  return value
}
export const builderInputLabels = {
  c3_manifest: 'Manifest nguồn graph',
  sample_manifest: 'Manifest SAMPLE',
  vector_artifact: 'Vector có sẵn',
  provenance: 'Nguồn gốc vector',
  chunk_manifest: 'Manifest phân đoạn',
  source_checkpoint: 'Checkpoint nguồn',
  selection: 'Phạm vi nguồn đã chốt',
  graph_package: 'Gói vector đã chọn',
}
export type BuilderInputs = {
  contract_version: 'builder-inputs-v1' | 'builder-inputs-v2' | 'builder-inputs-v3'
  configuration: 'NOT_CONFIGURED' | 'INVALID' | 'CONFIGURED'
  error_code: 'CONFIG' | null
  scope: 'FRESH_SAMPLE' | 'PRODUCTION' | null
  target: BuilderStatus['target']
  inputs: { name: keyof typeof builderInputLabels; sha256: string; state: 'NOT_CHECKED' | 'MATCHED' | 'MISSING' | 'INVALID' | 'UNAVAILABLE' }[]
  preflight: 'NOT_RUN'
  source_validation: { state: 'NOT_RUN' | 'CHECKING' | 'VALID' | 'INVALID' | 'UNAVAILABLE'; error_code: 'INTEGRITY' | 'RUNTIME' | null; plan_sha256: string | null; nodes: number | null; edges: number | null; summary?: SelectionSummary | null }
}
export async function loadBuilderInputs(signal?: AbortSignal, check = false): Promise<BuilderInputs> {
  const value = await api<BuilderInputs>('/admin/kag/builder/inputs', { signal, method: check ? 'POST' : 'GET', cache: 'no-store' })
  const invalid = () => { throw new ApiError('Thông tin đầu vào Builder không hợp lệ', 502) }
  if (!shape(value, ['contract_version', 'configuration', 'error_code', 'scope', 'target', 'inputs', 'preflight', 'source_validation']) || !['builder-inputs-v1', 'builder-inputs-v2', 'builder-inputs-v3'].includes(value.contract_version) ||
    !['NOT_CONFIGURED', 'INVALID', 'CONFIGURED'].includes(value.configuration) || value.preflight !== 'NOT_RUN' ||
    (value.configuration === 'INVALID' ? value.error_code !== 'CONFIG' : value.error_code !== null)) invalid()
  const configured = value.configuration === 'CONFIGURED', target = value.target
  if (configured ? !shape(target, ['project_id', 'database', 'namespace']) || !Number.isInteger(target!.project_id) || target!.project_id < 1 ||
    !(value.scope === 'PRODUCTION' ? /^[a-z][a-z0-9.-]{0,62}$/ : /^(?:neo4j|vietroadtraffic|freshsample[a-z0-9]{8,40})$/).test(target!.database) || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(target!.namespace) || !['FRESH_SAMPLE', 'PRODUCTION'].includes(value.scope!)
    : target !== null || value.scope !== null) invalid()
  if (!Array.isArray(value.inputs) || (configured ? value.inputs.length < 1 || value.inputs.length > Object.keys(builderInputLabels).length || value.scope === 'FRESH_SAMPLE' && value.inputs.length !== 6 : value.inputs.length !== 0)) invalid()
  const names = new Set<string>()
  for (const input of value.inputs) {
    if (!shape(input, ['name', 'sha256', 'state']) || !Object.prototype.hasOwnProperty.call(builderInputLabels, input.name) || names.has(input.name) ||
      !hash(input.sha256) || !['NOT_CHECKED', 'MATCHED', 'MISSING', 'INVALID', 'UNAVAILABLE'].includes(input.state)) invalid()
    names.add(input.name)
  }
  if (configured && !names.has('c3_manifest')) invalid()
  const source = value.source_validation
  const sourceErrors: Record<string, string> = { INVALID: 'INTEGRITY', UNAVAILABLE: 'RUNTIME' }
  const extended = value.contract_version === 'builder-inputs-v3'
  if (!shape(source, ['state', 'error_code', 'plan_sha256', 'nodes', 'edges', ...(extended ? ['summary'] : [])]) || !['NOT_RUN', 'CHECKING', 'VALID', 'INVALID', 'UNAVAILABLE'].includes(source.state) ||
    source.error_code !== (sourceErrors[source.state] ?? null) ||
    (source.state === 'VALID' ? value.contract_version === 'builder-inputs-v1' && !configured || !hash(source.plan_sha256) || !count(source.nodes) || !count(source.edges) : source.plan_sha256 !== null || source.nodes !== null || source.edges !== null)) invalid()
  if (extended && (source.state === 'VALID' ? !validSelectionSummary(source.summary!) || source.summary!.nodes !== source.nodes || source.summary!.edges !== source.edges : source.summary !== null)) invalid()
  return value
}
export async function runBuilderAction(action: 'build' | 'stop' | 'resume' | 'abandon', run_id: string, revision?: number): Promise<BuilderStatus> {
  if (!['build', 'stop', 'resume', 'abandon'].includes(action) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(run_id)) throw new ApiError('Yêu cầu Builder không hợp lệ', 422)
  if (revision !== undefined && (!count(revision) || revision < 1 || revision > 2147483647)) throw new ApiError('Revision Builder không hợp lệ', 422)
  const result = validateBuilder(await api<BuilderStatus>(`/admin/kag/builder/${action}`, { ...send('POST', { run_id }), ...(revision === undefined ? {} : { headers: { 'If-Match': `"${revision}"` } }) }))
  if (result.run_id !== run_id) throw new ApiError('Run Builder không khớp', 502)
  return result
}
export type BenchmarkDatasets = { contract_version: string; state: 'AVAILABLE' | 'NOT_CONFIGURED' | 'UNAVAILABLE' | 'LIMIT_EXCEEDED'; datasets: { id: string; dataset_status: 'FROZEN' | 'PROVISIONAL' | null; dataset_eligibility: 'ELIGIBLE' | 'BLOCKED'; reason: string | null; dataset_hash: string | null; record_count: number | null; official_benchmark: boolean }[]; execution_allowed: false; execution_blockers: string[]; metrics: null }
const states = ['ALIVE', 'READY', 'NOT_READY', 'UNAVAILABLE', 'NOT_CONFIGURED', 'RELEASE_UNAVAILABLE']
export function inspectionError(error: unknown) {
  const status = error instanceof ApiError ? error.status : -1
  if (status === 504 || error instanceof Error && /\bQUERY_TIMEOUT\b/.test(error.message)) return 'Chưa kiểm tra xong. Hãy thử lại; chưa có kết luận về đồ thị hoặc model.'
  if (status === 502 && error instanceof ApiError && error.message === 'Danh sách nguồn vượt giới hạn 32 MiB; chưa thể xem hoặc nhập qua màn này') return error.message
  if (status === 409 && error instanceof ApiError && error.message === 'Đăng nhập lại OpenSPG và kiểm quyền sở hữu project') return error.message
  return status === 401 ? 'Phiên đã hết hạn. Vui lòng đăng nhập lại.' : status === 403 ? 'Chỉ ADMIN được sử dụng chức năng này.' : status === 422 || status === 400 ? 'Yêu cầu truy xuất không hợp lệ.' : status === 0 ? 'Không kết nối được backend. Hãy thử lại.' : status === 503 ? 'Truy xuất KAG chưa khả dụng hoặc thiếu cấu hình dịch vụ.' : 'Phản hồi KAG chưa đủ bằng chứng hoặc không hợp lệ.'
}
export async function loadKagStatus(signal?: AbortSignal): Promise<KagStatus> {
  const result = await api<KagStatus>('/admin/kag/status', { signal })
  if (!result || Object.keys(result).sort().join() !== ['liveness', 'queryReadiness', 'retrievalReadiness', 'vectorRetrievalReadiness', 'release'].sort().join()) throw new ApiError('Invalid KAG status', 502)
  for (const [key, check] of Object.entries(result)) {
    if (!check || !states.includes(check.state) || !Number.isInteger(check.httpStatus)) throw new ApiError('Invalid KAG status', 502)
    if (check.state === 'ALIVE' && key !== 'liveness') throw new ApiError('Liveness is not readiness', 502)
    if (check.state === 'READY') {
      if (key === 'liveness') throw new ApiError('Liveness is not readiness', 502)
      const evidence = check.evidence
      const verified = key === 'release' ? evidence?.backend_identity_verified === true && evidence?.source_identity_verified === true && evidence?.query_ready === true : key === 'vectorRetrievalReadiness' ? evidence?.status === 'ready' && evidence?.capability === 'retrieve-vector' && evidence?.release_kind === 'SAMPLE' && evidence?.provider_transport === 'not_probed' && evidence?.production_write === 'blocked' : evidence?.status === 'ready' && evidence?.capability === (key === 'queryReadiness' ? 'query-v1' : 'retrieve') && ['auth', 'runtime', 'sources', 'admission'].every(field => (evidence?.checks as Record<string, string>)?.[field] === 'pass')
      if (check.httpStatus !== 200 || !verified) throw new ApiError('Unverified readiness', 502)
    }
  }
  return result
}
export async function runRetrieval(message: string, top_k: number, expand: boolean): Promise<Retrieval> {
  if (!message.trim() || message.length > 4000 || !Number.isInteger(top_k) || top_k < 1 || top_k > 10 || typeof expand !== 'boolean') throw new ApiError('Invalid request', 422)
  const value = await api<Retrieval>('/admin/kag/retrieve', send('POST', { message, top_k, expand }))
  if (!value || Object.keys(value).sort().join() !== ['contract_version', 'request_id', 'release_id', 'source_snapshot_id', 'schema_contract', 'items'].sort().join() || value.contract_version !== 'h1-read-v1.1' ||
    typeof value.request_id !== 'string' || typeof value.release_id !== 'string' || !value.release_id || typeof value.source_snapshot_id !== 'string' || !value.source_snapshot_id || !value.schema_contract ||
    !Array.isArray(value.items) || value.items.length > 110) throw new ApiError('Invalid retrieval', 502)
  validateRetrievalItems(value.items)
  return value
}
function validateRetrievalItems(items: Retrieval['items']) {
  for (const item of items) {
    if (!item || Object.keys(item).sort().join() !== ['entity_type', 'entity_id', 'doc_id', 'unit_id', 'sign_id', 'source_texts', 'score', 'vector_sources', 'graph_context'].sort().join() ||
      typeof item.entity_type !== 'string' || !item.entity_type || typeof item.entity_id !== 'string' || !item.entity_id || !item.source_texts || typeof item.source_texts !== 'object' || Array.isArray(item.source_texts) ||
      Object.values(item.source_texts).some(text => text !== null && typeof text !== 'string') || !Array.isArray(item.vector_sources) || !Array.isArray(item.graph_context) ||
      (item.score !== null && (!Number.isFinite(item.score) || item.score < 0 || item.score > 1))) throw new ApiError('Invalid evidence', 502)
  }
}
export type GraphRetrieval = { contract_version: 'builder-retrieval-v1'; project_id: number; run_id: string; schema_contract: Record<string, string>; model_identity: string; dimension: number; graph_fingerprint: string; items: Retrieval['items'] }
export async function runGraphRetrieval(projectId: number, runId: string, message: string, top_k: number, expand: boolean): Promise<GraphRetrieval> {
  if (!Number.isInteger(projectId) || projectId < 1 || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId) || !message.trim() || message.length > 4000 || !Number.isInteger(top_k) || top_k < 1 || top_k > 10 || typeof expand !== 'boolean') throw new ApiError('Chọn đồ thị và nhập câu hỏi hợp lệ', 422)
  const value = await api<GraphRetrieval>(`/admin/kag/graph/${projectId}/${encodeURIComponent(runId)}/retrieve`, send('POST', { message, top_k, expand }))
  if (value.contract_version !== 'builder-retrieval-v1' || value.project_id !== projectId || value.run_id !== runId || !value.schema_contract ||
    !Number.isInteger(value.dimension) || value.dimension < 1 || typeof value.model_identity !== 'string' || !/^[0-9a-f]{64}$/.test(value.graph_fingerprint) || !Array.isArray(value.items) || value.items.length > 110) throw new ApiError('Kết quả không thuộc đồ thị đang thử', 502)
  validateRetrievalItems(value.items)
  return value
}
export type DatasetPage = { contract_version: 'builder-dataset-v1'; dataset: string; group: string; source: string; offset: number; limit: number; total: number; items: Record<string, unknown>[] }
export type GraphSources = { contract_version: 'builder-sources-v1'; target: { project_id: number }; run_id: string; documents: { source_id: string; import_data: Record<string, unknown> }[]; units: { source_id: string; import_data: Record<string, unknown> }[] }
export async function loadGraphSources(projectId: number, runId: string, signal?: AbortSignal): Promise<GraphSources> {
  if (!Number.isSafeInteger(projectId) || projectId < 1 || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)) throw new ApiError('Chọn đồ thị hợp lệ', 422)
  const value = await api<GraphSources>(`/admin/kag/sources/${projectId}/${encodeURIComponent(runId)}`, { signal, cache: 'no-store' })
  if (value?.contract_version !== 'builder-sources-v1' || value.target?.project_id !== projectId || value.run_id !== runId ||
    [value.documents, value.units].some(rows => !Array.isArray(rows) || rows.some(row => !row || typeof row.source_id !== 'string' || !row.import_data || typeof row.import_data !== 'object' || Array.isArray(row.import_data)))) throw new ApiError('Nguồn không thuộc lần dựng đang xem', 502)
  return value
}
export async function loadDataset(group: string, offset = 0, signal?: AbortSignal): Promise<DatasetPage> {
  if (!['documents','units','signs','penalties','relations','xrefs'].includes(group) || !Number.isSafeInteger(offset) || offset < 0) throw new ApiError('Loại nguồn hoặc trang không hợp lệ',400)
  const value=await api<DatasetPage>(`/admin/kag/dataset/${group}?offset=${offset}&limit=25`,{signal,cache:'no-store'})
  if (value.contract_version!=='builder-dataset-v1' || value.group!==group || value.offset!==offset || value.limit!==25 ||
    typeof value.dataset!=='string' || typeof value.source!=='string' || !Number.isSafeInteger(value.total) || value.total<0 ||
    !Array.isArray(value.items) || value.items.length!==Math.min(25,Math.max(0,value.total-offset)) || value.items.some(row=>!row || typeof row!=='object' || Array.isArray(row))) throw new ApiError('Chưa đọc được trang dữ liệu nguồn',502)
  return value
}
export async function loadPipelineStatus(signal?: AbortSignal): Promise<PipelineStatus> {
  const value = await api<PipelineStatus>('/admin/kag/pipeline', { signal })
  if (!value || Object.keys(value).sort().join() !== ['contract_version', 'phase', 'active_requests', 'draining', 'closed', 'progress', 'execution_allowed', 'operational_proof', 'production_write', 'provider_egress'].sort().join() || value.contract_version !== 'h1-inspect-v1.0' || value.progress !== null || value.execution_allowed !== false || value.operational_proof !== 'DENY' || value.production_write !== 'BLOCKED' || value.provider_egress !== 'DENY') throw new ApiError('Invalid pipeline proof', 502)
  if (value.phase === 'unavailable') {
    if (value.active_requests !== null || value.closed !== null || value.draining !== null) throw new ApiError('Invalid unavailable runtime', 502)
  } else {
    if (![0, 1].includes(value.active_requests as number) || typeof value.closed !== 'boolean' || typeof value.draining !== 'boolean' || value.phase !== (value.closed ? 'closed' : value.draining ? 'draining' : value.active_requests === 1 ? 'running' : 'idle')) throw new ApiError('Invalid runtime state', 502)
  }
  return value
}
export async function loadBenchmarkDatasets(signal?: AbortSignal): Promise<BenchmarkDatasets> {
  const value = await api<BenchmarkDatasets>('/admin/kag/benchmark/datasets', { signal })
  return validateBenchmark(value)
}
function validateBenchmark(value: BenchmarkDatasets, sample = false): BenchmarkDatasets {
  if (!value || Object.keys(value).sort().join() !== ['contract_version', 'state', 'datasets', 'execution_allowed', 'execution_blockers', 'metrics'].sort().join() || value.contract_version !== 'h1-inspect-v1.0' || value.execution_allowed !== false || value.metrics !== null || !Array.isArray(value.execution_blockers) || value.execution_blockers.join() !== 'OPERATIONAL_PROOF_REQUIRED,BENCHMARK_EXECUTION_NOT_AUTHORIZED' || !['AVAILABLE', 'NOT_CONFIGURED', 'UNAVAILABLE', 'LIMIT_EXCEEDED'].includes(value.state) || !Array.isArray(value.datasets) || value.datasets.length > 20 || (value.state !== 'AVAILABLE' && value.datasets.length)) throw new ApiError('Invalid benchmark proof', 502)
  const seen = new Set<string>()
  for (const row of value.datasets) {
    if (!row || Object.keys(row).sort().join() !== ['id', 'dataset_status', 'dataset_eligibility', 'reason', 'dataset_hash', 'record_count', 'official_benchmark', ...(sample ? ['eligible_count','ineligible_count','invalid_count','gold_count','missing_gold','eligibility_scope', ...('smoke' in row ? ['smoke'] : []), ...('metadata' in row ? ['metadata'] : [])] : [])].sort().join() || typeof row.id !== 'string' || !/^[A-Za-z0-9_.-]{1,128}(?:\/eval_questions\.jsonl)?$/.test(row.id) || row.id.startsWith('../') || seen.has(row.id) || !['ELIGIBLE', 'BLOCKED'].includes(row.dataset_eligibility) || typeof row.official_benchmark !== 'boolean' ||
      (row.dataset_status !== null && !['FROZEN', 'PROVISIONAL'].includes(row.dataset_status)) || (row.dataset_hash !== null && (typeof row.dataset_hash !== 'string' || !/^[0-9a-f]{64}$/.test(row.dataset_hash))) || (row.record_count !== null && (!Number.isInteger(row.record_count) || row.record_count < (sample ? 0 : 1))) || (row.official_benchmark && row.dataset_status !== 'FROZEN') ||
      (row.dataset_eligibility === 'BLOCKED' && !['PROVISIONAL_DATASET', 'NO_GOLD', 'INVALID_DATASET', 'DATASET_TOO_LARGE', ...(sample ? ['NO_ELIGIBLE_QUESTIONS'] : [])].includes(row.reason as string)) ||
      (row.dataset_eligibility === 'ELIGIBLE' && (row.dataset_status !== 'FROZEN' || !row.dataset_hash || !Number.isInteger(row.record_count) || (row.record_count as number) < 1 || row.reason !== null))) throw new ApiError('Invalid dataset proof', 502)
    seen.add(row.id)
  }
  return value
}

export type SampleNode = { entity_type: string; entity_id: string; properties: Record<string, unknown>; sources: { evidence_id: string; field: string; source_sha256: string }[] }
export type SampleEdge = { from: [string, string]; predicate: string; to: [string, string]; properties: Record<string, unknown> }
type BenchmarkConfig = { protocol_version: '1.0'; eval_version: '1.0'; metric_policy_version: '1.0' | '1.1'; ks: number[]; top_k: number; expand: false; rank_semantics: 'channel_projected_returned_top_k'; identity_catalog_hash: string | null; release_id: string | null; judge_config: null | { name: string; version: string; model: string; prompt_version: string; temperature: number; seed: number | null; calibrated: boolean } }
type SmokeRun = { configuration?: BenchmarkConfig; status: 'COMPLETE'; started_at: string; finished_at: string; requested_count: number; attempted_count: number; failed_count: number; ineligible_count: number; metrics: Record<string, { value: number | null; scored_count: number; eligible_count: number; excluded_count: number; failed_count: number; status_counts: Record<'OK' | 'NOT_APPLICABLE' | 'UNAVAILABLE' | 'UNKNOWN', number> }>; latency_ms: Record<'successful' | 'all_attempted', { count: number; min: number | null; mean: number | null; median: number | null; p95: number | null; max: number | null }> }
type Smoke = { state: 'NOT_RUN' | 'AVAILABLE' | 'INVALID_RECEIPT'; review_status: 'PROVISIONAL' | 'FROZEN' | 'NOT_ATTESTED'; g1_eligible_count: number; graph_fingerprint: string; official_benchmark: boolean; runs: Record<'G1' | 'G2', SmokeRun | null> }
type Coverage = BenchmarkDatasets['datasets'][number] & { metadata?: { dataset_version: string | null; category_counts: Record<string, number>; generation_method: string | null }; eligible_count: number; ineligible_count: number; invalid_count: number | null; gold_count: number | null; missing_gold: Record<'document' | 'unit' | 'sign', string[]>; eligibility_scope: 'G1_RETRIEVAL_GOLD_COVERAGE'; smoke?: Smoke }
export type SampleInspection = {
  contract_version: 'h1-sample-inspection-1.0'; release_id: string; release_kind: 'SAMPLE'; source_snapshot_id: string; source_catalog_sha256: string; schema_contract: Record<string, string>; graph_fingerprint: string;
  backend: { database: string; namespace: string; database_id: string; server_id: string; read_only: true; verified: true };
  counts: { nodes: number; edges: number; vectors: number }; nodes: SampleNode[]; edges: SampleEdge[]; verified_at: string; execution_allowed: false; production_write: 'BLOCKED';
  sample_receipt: { stage: 'GRAPH_VERIFIED'; sealed_at: string; receipt_sha256: string; build_run_id: null; progress: null };
  datasets: Omit<BenchmarkDatasets, 'datasets'> & { datasets: Coverage[] };
  providers: { state: 'OBSERVED' | 'NOT_CONFIGURED'; attempts: { embedding: number; chat: number } | null; receipt_window: { since: string; outcomes: Record<string, Record<string, number>>; recent: { kind: string; outcome: string; timestamp: string; attempt: number; request_id: string | null; provider_request_id: string | null; configured_model: string; source_component: string; latency_ms: number | null; status: number | null }[] } | null; configured_chat_model: string | null; configured_embedding_model: string | null; policy_response_version: string | null; exact_backend_identity_verified: false; upstream_attempts: null; proxy_retries: null }
}
const hash = (v: unknown) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v)
const count = (v: unknown, max = 1000000): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= max
const shape = (v: unknown, keys: string[]) => !!v && typeof v === 'object' && Object.keys(v).sort().join() === keys.sort().join()
function validateSmoke(smoke: Smoke, total: number | null, fingerprint: string) {
  const invalid = () => { throw new ApiError('Invalid smoke proof', 502) }
  if (!shape(smoke,['state','review_status','g1_eligible_count','graph_fingerprint','official_benchmark','runs']) || !['NOT_RUN','AVAILABLE','INVALID_RECEIPT'].includes(smoke.state) || !['PROVISIONAL','FROZEN','NOT_ATTESTED'].includes(smoke.review_status) || !count(smoke.g1_eligible_count,total ?? 0) || smoke.graph_fingerprint !== fingerprint || typeof smoke.official_benchmark !== 'boolean' || !shape(smoke.runs,['G1','G2'])) invalid()
  let hasRun = false
  for (const run of Object.values(smoke.runs)) {
    if (run === null) continue
    hasRun = true
    if (smoke.state !== 'AVAILABLE' || !['PROVISIONAL','FROZEN'].includes(smoke.review_status) || !shape(run,['status','started_at','finished_at','requested_count','attempted_count','failed_count','ineligible_count','metrics','latency_ms', ...('configuration' in run ? ['configuration'] : [])]) || run.status !== 'COMPLETE' || !count(run.requested_count) || run.requested_count < 1 || run.requested_count !== total || !count(run.attempted_count,total) || !count(run.failed_count,run.attempted_count) || !count(run.ineligible_count,total) || run.attempted_count + run.ineligible_count !== total || !Number.isFinite(Date.parse(run.started_at)) || !Number.isFinite(Date.parse(run.finished_at)) || Date.parse(run.finished_at) < Date.parse(run.started_at) || !run.metrics || Array.isArray(run.metrics) || Object.keys(run.metrics).length > 128 || !shape(run.latency_ms,['successful','all_attempted'])) invalid()
    if ('configuration' in run) {
      const c = run.configuration!
      if (!shape(c,['protocol_version','eval_version','metric_policy_version','ks','top_k','expand','rank_semantics','identity_catalog_hash','release_id','judge_config']) || c.protocol_version !== '1.0' || c.eval_version !== '1.0' || !['1.0','1.1'].includes(c.metric_policy_version) || !count(c.top_k,10) || c.top_k < 1 || !Array.isArray(c.ks) || !c.ks.length || c.ks.some((k,i) => !count(k,c.top_k) || k < 1 || i > 0 && k <= c.ks[i-1]) || c.expand !== false || c.rank_semantics !== 'channel_projected_returned_top_k' || c.identity_catalog_hash !== null && !hash(c.identity_catalog_hash) || c.release_id !== null && (typeof c.release_id !== 'string' || !c.release_id)) invalid()
      const j = c.judge_config
      if (j !== null && (!shape(j,['name','version','model','prompt_version','temperature','seed','calibrated']) || typeof j.name !== 'string' || !j.name.trim() || ![j.version,j.model,j.prompt_version].every(v=>typeof v==='string') || typeof j.temperature !== 'number' || !Number.isFinite(j.temperature) || typeof j.calibrated !== 'boolean' || j.seed !== null && !Number.isSafeInteger(j.seed))) invalid()
    }
    for (const metric of Object.values(run.metrics)) {
      if (!shape(metric,['value','scored_count','status_counts','eligible_count','excluded_count','failed_count']) || !shape(metric.status_counts,['OK','NOT_APPLICABLE','UNAVAILABLE','UNKNOWN']) || (metric.value !== null && (!Number.isFinite(metric.value) || metric.value < 0)) || ![metric.scored_count,metric.eligible_count,metric.excluded_count,metric.failed_count,...Object.values(metric.status_counts)].every(v => count(v,total ?? 0)) || Object.values(metric.status_counts).reduce((a,b) => a+b,0) !== total || metric.eligible_count + metric.excluded_count !== total || metric.scored_count !== metric.status_counts.OK || (metric.value === null) !== (metric.scored_count === 0)) invalid()
    }
    for (const latency of Object.values(run.latency_ms)) {
      if (!shape(latency,['count','min','mean','median','p95','max']) || !count(latency.count,total ?? 0) || [latency.min,latency.mean,latency.median,latency.p95,latency.max].some(v => latency.count === 0 ? v !== null : v === null || !Number.isFinite(v) || v < 0)) invalid()
    }
  }
  if ((smoke.state === 'AVAILABLE') !== hasRun) invalid()
}
export async function loadSampleInspection(signal?: AbortSignal): Promise<SampleInspection> {
  const value = await api<SampleInspection>('/admin/kag/sample', { signal })
  const invalid = () => { throw new ApiError('Unverified sample inspection', 502) }
  if (!shape(value, ['contract_version','release_id','release_kind','source_snapshot_id','source_catalog_sha256','schema_contract','graph_fingerprint','backend','counts','nodes','edges','verified_at','execution_allowed','production_write','sample_receipt','datasets','providers']) || value.contract_version !== 'h1-sample-inspection-1.0' || value.release_kind !== 'SAMPLE' || !value.release_id || !value.source_snapshot_id || !hash(value.graph_fingerprint) || !hash(value.source_catalog_sha256) || value.execution_allowed !== false || value.production_write !== 'BLOCKED' || !Number.isFinite(Date.parse(value.verified_at))) invalid()
  if (!shape(value.backend,['database','namespace','database_id','server_id','read_only','verified']) || value.backend.read_only !== true || value.backend.verified !== true || value.backend.database !== 'vietroadtraffic' || value.backend.namespace !== 'VietRoadTraffic' || !value.backend.database_id || !value.backend.server_id || !shape(value.schema_contract,['namespace','schema_sha256','contract_sha256']) || value.schema_contract.namespace !== 'VietRoadTraffic' || !hash(value.schema_contract.schema_sha256) || !hash(value.schema_contract.contract_sha256)) invalid()
  if (!shape(value.counts,['nodes','edges','vectors']) || !count(value.counts.nodes,32) || !value.counts.nodes || !count(value.counts.edges,22) || !count(value.counts.vectors,42) || !value.counts.vectors || !Array.isArray(value.nodes) || value.nodes.length !== value.counts.nodes || !Array.isArray(value.edges) || value.edges.length !== value.counts.edges) invalid()
  const nodes = new Set<string>(), sources = new Set<string>()
  for (const n of value.nodes) {
    if (!shape(n,['entity_type','entity_id','properties','sources']) || !['VietRoadTraffic.LegalDocument','VietRoadTraffic.LegalUnit','VietRoadTraffic.TrafficSign'].includes(n.entity_type) || typeof n.entity_id !== 'string' || !n.entity_id || !n.properties || n.properties.id !== n.entity_id || n.properties.name !== n.entity_id || nodes.has(JSON.stringify([n.entity_type,n.entity_id])) || !Array.isArray(n.sources) || !n.sources.length || n.sources.length > 2 || Object.keys(n.properties).some(k => k.endsWith('_vector') || ['password','credential','token'].includes(k))) invalid()
    nodes.add(JSON.stringify([n.entity_type,n.entity_id]))
    for (const s of n.sources) {
      if (!shape(s,['evidence_id','field','source_sha256']) || !hash(s.evidence_id) || !hash(s.source_sha256) || typeof s.field !== 'string' || !(s.field in n.properties) || sources.has(s.evidence_id)) invalid()
      sources.add(s.evidence_id)
    }
  }
  for (const e of value.edges) if (!shape(e,['from','predicate','to','properties']) || !Array.isArray(e.from) || e.from.length !== 2 || !Array.isArray(e.to) || e.to.length !== 2 || !nodes.has(JSON.stringify(e.from)) || !nodes.has(JSON.stringify(e.to)) || typeof e.predicate !== 'string' || !e.predicate || !e.properties || typeof e.properties !== 'object') invalid()
  if (!shape(value.sample_receipt,['stage','sealed_at','receipt_sha256','build_run_id','progress']) || value.sample_receipt.stage !== 'GRAPH_VERIFIED' || !hash(value.sample_receipt.receipt_sha256) || !Number.isFinite(Date.parse(value.sample_receipt.sealed_at)) || value.sample_receipt.build_run_id !== null || value.sample_receipt.progress !== null) invalid()
  validateBenchmark(value.datasets,true)
  for (const row of value.datasets.datasets) {
    if ('metadata' in row) {
      const m = row.metadata!, categories = ['definition','obligation','sanction_numeric','effectiveness_metadata','inter_document','multi_hop','unanswerable','traffic_sign']
      if (!shape(m,['dataset_version','category_counts','generation_method']) || m.dataset_version !== null && (typeof m.dataset_version !== 'string' || !m.dataset_version.trim() || m.dataset_version.length > 512) || !m.category_counts || Array.isArray(m.category_counts) || typeof m.category_counts !== 'object' || Object.entries(m.category_counts).some(([cat,n]) => !categories.includes(cat) || !count(n) || n < 1) || m.generation_method !== null && m.generation_method !== 'legacy-b2-evidence-first-adapted') invalid()
      const total = Object.values(m.category_counts).reduce((a,b) => a+b,0)
      if (row.record_count !== null && (total !== row.record_count - (row.invalid_count ?? 0) || (m.dataset_version === null) !== (total === 0))) invalid()
    }
    if (row.smoke) {
      validateSmoke(row.smoke,row.record_count,value.graph_fingerprint)
      if (row.smoke.official_benchmark !== row.official_benchmark || row.smoke.review_status !== 'NOT_ATTESTED' && row.smoke.review_status !== row.dataset_status) invalid()
      for (const run of Object.values(row.smoke.runs)) if (run?.configuration?.release_id !== undefined && run.configuration.release_id !== null && run.configuration.release_id !== value.release_id) invalid()
    }
    if (row.eligibility_scope !== 'G1_RETRIEVAL_GOLD_COVERAGE' || !count(row.eligible_count) || !count(row.ineligible_count) || !shape(row.missing_gold,['document','unit','sign']) || Object.values(row.missing_gold).some(ids => !Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !id)) || (row.record_count !== null && (!count(row.invalid_count) || !count(row.gold_count,row.record_count) || row.eligible_count + row.ineligible_count + (row.invalid_count as number) !== row.record_count))) invalid()
  }
  const p = value.providers
  if (!shape(p,['state','attempts','receipt_window','configured_chat_model','configured_embedding_model','policy_response_version','exact_backend_identity_verified','upstream_attempts','proxy_retries']) || !['OBSERVED','NOT_CONFIGURED'].includes(p.state) || p.exact_backend_identity_verified !== false || p.upstream_attempts !== null || p.proxy_retries !== null) invalid()
  if (p.state === 'NOT_CONFIGURED') { if (p.attempts !== null || p.receipt_window !== null) invalid() }
  else if (!p.attempts || !shape(p.attempts,['embedding','chat']) || !Object.values(p.attempts).every(v => count(v,Number.MAX_SAFE_INTEGER)) || [p.configured_chat_model,p.configured_embedding_model,...(p.policy_response_version === null ? [] : [p.policy_response_version])].some(v => typeof v !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/:-]{0,199}$/.test(v)) || !p.receipt_window || !shape(p.receipt_window,['since','outcomes','recent']) || !Array.isArray(p.receipt_window.recent) || p.receipt_window.recent.length > 50) invalid()
  return value
}
