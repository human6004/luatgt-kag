import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, useLocation, useSearchParams } from 'react-router-dom'
import { Badge, Button, Card, Field, Modal, Page, Td, Th, inputCls } from '../admin/ui'
import { ApiError } from '../api'
import { Notice, useData } from './server/shared'
import type { SchemaResponse } from './server/KagSchemaPage'
import { BuilderControls, BuilderGraph, useInspection } from './server/KagManagement'
import {
  builderNeo4jLink,
  builderStateLabel,
  changeChatRetrieval,
  changeLLMModel,
  changeServing,
  loadBuilderConfiguration,
  loadBuilderInputs,
  loadBuilderProjects,
  loadBuilderStatus,
  loadChatRetrieval,
  loadGraphProject,
  loadKagConfiguration,
  loadLLMCredentials,
  loadServing,
  runGraphRetrieval,
  saveLLMCredentials,
  servingReasons,
  type BuilderConfiguration,
  type ChatRetrievalValues,
  type GraphRetrieval,
  type ServingPreview,
} from './server/kag-inspection'

const modelErrors: Record<string, string> = {
  TEST_REQUIRED: 'Cần kiểm thử thành công bản đã lưu trước khi áp dụng.',
  TEST_IN_PROGRESS: 'Kiểm thử chưa hoàn tất. Tải lại trước khi thử tiếp.',
  RELEASE_UNAVAILABLE: 'Chưa chọn đồ thị phục vụ. Sang Bước ③ chọn phiên đã xác minh rồi xem trước và xác nhận.',
  RELEASE_MISMATCH: 'Model hoặc địa chỉ kết nối không tương thích với dữ liệu đang phục vụ.',
  VECTOR_IDENTITY_MISMATCH: 'Embedding không khớp model và chỉ mục đã dùng để dựng đồ thị.',
  ACTIVE_CONFIG_INVALID: 'Cấu hình đang áp dụng không còn hợp lệ. Kiểm tra dữ liệu và quyền kết nối.',
  PROXY_POLICY_UNVERIFIED: 'Chưa xác định được giới hạn lượt gọi qua proxy. Cần quản trị triển khai kiểm tra trước khi thử kết nối.',
  BLOCKED: 'Địa chỉ kết nối chưa được hệ thống cho phép. Cần quản trị triển khai cấp quyền.',
  AUTH_FAILED: 'Provider từ chối API key hoặc quyền truy cập.',
  MODEL_NOT_FOUND: 'Provider không tìm thấy model.',
  RATE_LIMITED: 'Provider giới hạn lượt gọi. Chờ trước khi kiểm thử lại.',
  PROVIDER_ERROR: 'Provider trả lỗi dịch vụ.',
  MODEL_MISMATCH: 'Model trong response không khớp model đã lưu.',
  DIMENSION_MISMATCH: 'Số chiều vector không hợp lệ hoặc vượt giới hạn kiểm thử.',
  INVALID_RESPONSE: 'Provider trả dữ liệu không hợp lệ.',
  TIMEOUT: 'Request hết thời gian; không tự thử lại.',
  NETWORK_ERROR: 'Không kết nối được provider qua gateway.',
}

export default function AdminChatbot() {
  const [parameters, setParameters] = useSearchParams()
  const rawStep = parameters.get('step')
  const step: '1' | '2' | '3' = rawStep === '2' ? '2' : rawStep === '3' ? '3' : '1'
  const verifyRun = parameters.get('verify_run') ?? ''
  const projectId = parameters.get('project_id') ?? ''
  const requestedRun = parameters.get('run_id') ?? ''
  const requestedTab = parameters.get('tab')
  const tab: 'overview' | 'trial' | 'chat' = requestedTab === 'trial' || requestedTab === 'chat' ? requestedTab : 'overview'

  const config = useInspection(loadKagConfiguration)
  const schema = useData<SchemaResponse>('/admin/kag/schema')
  const builderInputs = useInspection(loadBuilderInputs)
  const builderStatus = useInspection(loadBuilderStatus)
  const builderConfig = useInspection(loadBuilderConfiguration)
  const catalog = useInspection(loadBuilderProjects)
  const retrieval = useInspection(loadChatRetrieval)
  const models = useInspection(loadLLMCredentials)
  const serving = useInspection(loadServing)

  function goStep(nextStep: '1' | '2' | '3', extra?: Record<string, string | null>) {
    const next = new URLSearchParams(parameters)
    next.set('step', nextStep)
    next.delete('verify_run')
    if (nextStep !== '2') next.delete('bstep')
    if (extra) {
      for (const [k, v] of Object.entries(extra)) {
        if (v === null || v === '') next.delete(k)
        else next.set(k, v)
      }
    }
    setParameters(next)
  }

  // Step 1 & Step 3 retrieval/model state (from AdminConfig)
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
  const [copying, setCopying] = useState(false)
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState('')

  useEffect(() => {
    if (retrieval.value?.saved) setDraft({ ...retrieval.value.saved })
  }, [retrieval.value])

  const retrievalState = retrieval.value
  const dirtyRetrieval = !!draft && !!retrievalState?.saved && (draft.top_k !== retrievalState.saved.top_k || draft.expand !== retrievalState.saved.expand)
  const unsaved = modelsDirty.chat || modelsDirty.embedding || dirtyRetrieval
  const validRetrieval = !!draft && Number.isInteger(draft.top_k) && draft.top_k >= 1 && draft.top_k <= 10

  // Step 3 serving state (from AdminGraph)
  const project = catalog.value?.projects.find(row => String(row.project_id) === projectId)
  const runs = serving.value?.runs.filter(row => row.project_id === project?.project_id) ?? []
  const active = serving.value?.active
  const activeRun = serving.value?.runs.find(r => active && r.run_id === active.run_id && r.project_id === active.project_id)
  const runId = requestedRun || (active?.project_id === project?.project_id ? active?.run_id : runs.length === 1 ? runs[0].run_id : '') || ''
  const run = runs.find(row => row.run_id === runId)
  const using = !!run && active?.project_id === project?.project_id && active?.run_id === runId
  const modelPath = `/admin/chatbot?step=1${projectId ? `&project_id=${encodeURIComponent(projectId)}` : ''}${runId ? `&run_id=${encodeURIComponent(runId)}` : ''}&tab=${tab}`

  const [servingPreview, setServingPreview] = useState<ServingPreview | null>(null)
  const [servingBusy, setServingBusy] = useState(false)
  const [servingError, setServingError] = useState('')
  const [servingMessage, setServingMessage] = useState('')
  const servingPending = useRef(false)

  useEffect(() => {
    setServingPreview(null)
    setServingError('')
    setServingMessage('')
  }, [projectId, runId])

  async function handleServingChange(action: 'preview' | 'activate') {
    if (!project || !run || servingPending.current) return
    servingPending.current = true
    setServingBusy(true)
    setServingError('')
    setServingMessage('')
    try {
      const result = await changeServing(action, project.project_id, run.run_id, servingPreview?.preview_id)
      if (action === 'preview') setServingPreview(result)
      else {
        setServingPreview(null)
        setServingMessage('Đã dùng đồ thị này cho các câu hỏi mới.')
        serving.reload()
        config.reload()
      }
    } catch (failure) {
      setServingPreview(null)
      setServingError(failure instanceof ApiError ? failure.message : 'Chưa xác nhận được kết quả. Đang đọc lại trạng thái; kiểm trước khi thử tiếp.')
      serving.reload()
    } finally {
      servingPending.current = false
      setServingBusy(false)
    }
  }

  function reloadAll() {
    if (unsaved || serving.loading || servingBusy) return
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
    builderInputs.reload()
    builderStatus.reload()
    builderConfig.reload()
    catalog.reload()
    retrieval.reload()
    models.reload()
    serving.reload()
  }

  async function saveModels(event: FormEvent<HTMLFormElement>, role: 'chat' | 'embedding') {
    event.preventDefault()
    if (!models.value?.save_allowed) return
    const form = event.currentTarget, fields = new FormData(form)
    const key = String(fields.get(`${role}_api_key`) ?? '')
    const input = {
      provider: 'openai-compatible' as const,
      base_url: String(fields.get(`${role}_base_url`) ?? ''),
      model: String(fields.get(`${role}_model`) ?? ''),
      ...(key ? { api_key: key } : {}),
    }
    // Keys stay in the password input and submit scope, never in React state, URL, or snapshots.
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
    } finally {
      setModelsSaving(false)
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
      serving.reload()
    } catch (error) {
      setModelsError(error instanceof ApiError ? error.message : 'Không thực hiện được thao tác. Tải lại trạng thái trước khi thử tiếp.')
    } finally {
      setModelRunning(false)
    }
  }

  async function updateRetrieval(action: 'save' | 'apply' | 'restore', revision: number, values?: ChatRetrievalValues) {
    setChanging(true)
    setChangeError('')
    setChangeMessage('')
    setConfirmation(null)
    setCopied(false)
    try {
      await changeChatRetrieval(action, revision, values)
      setChangeMessage(
        action === 'save'
          ? 'Đã lưu bền vững; chưa tự áp dụng.'
          : action === 'apply'
            ? 'Đã áp dụng vào cấu hình runtime.'
            : 'Đã khôi phục bản trước vào cấu hình đã lưu và runtime.',
      )
      retrieval.reload()
    } catch (error) {
      setChangeError(error instanceof ApiError ? error.message : 'Không cập nhật được cấu hình. Hãy tải lại trạng thái trước khi thử lại.')
    } finally {
      setChanging(false)
    }
  }

  const value = config.value, solver = value?.solver
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
    : ''
  const modelState = { CONFIGURED: 'Đã cấu hình', NOT_CONFIGURED: 'Chưa cấu hình', INCOMPLETE: 'Cấu hình chưa đầy đủ', INVALID: 'Cấu hình không hợp lệ' }
  const releaseState = { NOT_CONFIGURED: 'Chưa cấu hình', LOADED: 'Đã nạp artifact', UNAVAILABLE: 'Chưa nạp được artifact' }

  async function copySnapshot() {
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

  // Step completion indicators
  const chatTested = models.value?.roles.chat.test?.status === 'PASS' || models.value?.roles.chat.status === 'APPLIED'
  const embTested = models.value?.roles.embedding.test?.status === 'PASS' || models.value?.roles.embedding.status === 'APPLIED'
  const step1Done = !!chatTested && !!embTested
  const allRuns = serving.value?.runs ?? []
  const step2Done = allRuns.length > 0 || builderStatus.value?.state === 'COMPLETE'
  const step3Done = !!active && serving.value?.runtime_ready === true && (serving.value?.chat_blockers.length ?? 0) === 0

  const stepMeta: { id: '1' | '2' | '3'; title: string; done: boolean; summary: string }[] = [
    {
      id: '1',
      title: '① API key & model',
      done: step1Done,
      summary: step1Done
        ? 'Chat & Embedding đã kiểm tra'
        : models.value?.saved
          ? 'Cần kiểm tra kết nối model'
          : 'Nhập API key & chọn model',
    },
    {
      id: '2',
      title: '② Dựng đồ thị',
      done: step2Done,
      summary: allRuns.length > 0
        ? `Đã có ${allRuns.length} phiên hoàn tất`
        : builderStatus.value
          ? builderStateLabel(builderStatus.value.state)
          : 'Chuẩn bị & dựng graph',
    },
    {
      id: '3',
      title: '③ Dùng cho Chat',
      done: step3Done,
      summary: step3Done
        ? `Đang phục vụ: ${active!.project_name}`
        : active
          ? 'Còn điều kiện cần xử lý'
          : 'Chọn đồ thị cho Chat',
    },
  ]

  const activeChatModel = models.value?.roles.chat.active?.model ?? value?.models.chat.model ?? 'Chưa áp dụng'
  const activeEmbModel = models.value?.roles.embedding.active?.model ?? value?.models.embedding.model ?? 'Chưa áp dụng'

  return (
    <Page
      title="Chatbot"
      subtitle="Thiết lập theo 3 bước: nhập API key & model → dựng đồ thị tri thức → chọn đồ thị dùng cho Chat."
      actions={
        <div className="flex flex-wrap items-center gap-3">
          <Button
            disabled={unsaved || serving.loading || config.loading || schema.loading || builderInputs.loading || retrieval.loading || models.loading || modelsSaving || modelRunning || copying || changing || servingBusy}
            title={unsaved ? 'Lưu thay đổi trên form trước khi tải lại.' : undefined}
            onClick={reloadAll}
          >
            Tải lại
          </Button>
          <Link to="/chat" className="text-xs font-medium text-accent-strong hover:underline">
            Mở trang Hỏi luật ↗
          </Link>
        </div>
      }
    >
      {unsaved && <p className="mb-4 text-sm text-muted">Có thay đổi chưa lưu. Lưu trước khi tải lại để giữ dữ liệu đang nhập.</p>}

      {/* Fixed Serving Summary Banner */}
      <Card className="p-4 mb-5">
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
          <div className="space-y-1 min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold text-navy">Trạng thái phục vụ Chat:</span>
              {serving.loading ? (
                <Badge tone="gray">Đang đọc…</Badge>
              ) : step3Done ? (
                <Badge tone="green">Sẵn sàng</Badge>
              ) : (
                <Badge tone="amber">Chưa sẵn sàng</Badge>
              )}
              <span className="text-text-secondary break-words">
                {active
                  ? `${active.project_name}${activeRun ? ` (${activeRun.nodes.toLocaleString('vi-VN')} nội dung · ${activeRun.edges.toLocaleString('vi-VN')} quan hệ)` : ` · ${active.run_id}`}`
                  : serving.error
                    ? (value?.project.release_id ? `Bản nạp: ${value.project.release_id}` : 'Cần đăng nhập OpenSPG để đọc danh sách project')
                    : 'Chưa chọn đồ thị phục vụ'}
              </span>
            </div>
            <p className="text-xs text-muted break-words">
              Chat model: <strong className="text-navy font-medium">{activeChatModel}</strong> · Embedding model: <strong className="text-navy font-medium">{activeEmbModel}</strong>
            </p>
          </div>
          {builderConfig.value?.links?.openspg && (
            <a className="underline text-xs text-accent-strong shrink-0" target="_blank" rel="noreferrer" href={builderConfig.value.links.openspg}>
              Mở OpenSPG ↗
            </a>
          )}
        </div>
        {serving.error && <div className="mt-2"><Notice error={serving.error} retry={serving.reload} /></div>}
      </Card>

      {/* Fixed 3-Step Stepper Bar */}
      <nav aria-label="Quy trình 3 bước thiết lập Chatbot" className="grid gap-3 sm:grid-cols-3 mb-6">
        {stepMeta.map(s => {
          const current = step === s.id
          return (
            <button
              key={s.id}
              type="button"
              aria-current={current ? 'step' : undefined}
              onClick={() => goStep(s.id)}
              className={`text-left rounded-2xl border p-4 transition-colors cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-strong ${
                current ? 'border-navy bg-selected shadow-xs' : 'border-line bg-surface hover:bg-selected/50'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-semibold text-navy">{s.title}</span>
                <Badge tone={s.done ? 'green' : current ? 'gold' : 'gray'}>
                  {s.done ? '✓ Đã đạt' : current ? 'Đang mở' : 'Chưa xong'}
                </Badge>
              </div>
              <p className="mt-1.5 text-xs text-muted truncate">{s.summary}</p>
            </button>
          )
        })}
      </nav>

      {/* STEP 1: API key & model */}
      {step === '1' && (
        <div className="space-y-5">
          <Card
            title="Bước ① — Kết nối API key & Model"
            right={
              <Button variant="primary" size="sm" onClick={() => goStep('2')}>
                Tiếp tục: ② Dựng đồ thị →
              </Button>
            }
          >
            <div className="px-5 pb-5 text-sm space-y-4">
              <Notice {...models} retry={models.reload} />
              {models.value && (
                <>
                  {models.value.error_code && (
                    <p role="alert" className="text-red-700">
                      Không đọc hoặc ghi được credentials đã lưu. Cần kiểm tra file và quyền phía triển khai.
                    </p>
                  )}
                  <p className="text-muted">
                    Chat trả lời câu hỏi; Embedding tạo vector tìm nguồn liên quan. Hai kết nối lưu, kiểm tra và áp dụng riêng.
                  </p>
                  {!models.value.save_allowed && !models.value.error_code && (
                    <p>Chưa được phép lưu. Cần quản trị triển khai kiểm tra quyền và phiên bản cấu hình.</p>
                  )}
                  <div className="grid gap-6 md:grid-cols-2">
                    {(['embedding', 'chat'] as const).map(role => (
                      <form
                        key={`${role}-${models.value?.roles[role].saved_revision}`}
                        onSubmit={event => void saveModels(event, role)}
                        onChange={() => {
                          setModelsDirty(current => ({ ...current, [role]: true }))
                          setModelsMessage('')
                        }}
                        autoComplete="off"
                        className="min-w-0 space-y-3 rounded-xl border border-line bg-bg/50 p-4"
                      >
                        <fieldset disabled={modelsSaving || modelRunning || models.loading || !models.value?.save_allowed} className="min-w-0 space-y-3">
                          <legend className="font-semibold text-navy mb-2">
                            {role === 'embedding' ? '1A. Embedding model (cần trước khi Dựng đồ thị)' : '1B. Chat model (cần trước khi Dùng cho Chat)'}
                          </legend>
                          <div className="space-y-1 text-xs">
                            <p>
                              Bản lưu: <strong>{models.value?.[role] ? 'Đã lưu' : 'Chưa lưu model'}</strong>.
                              {modelsDirty[role] && ' Có thay đổi chưa lưu.'}
                            </p>
                            <p>
                              Kiểm tra kết nối:{' '}
                              <strong>
                                {models.value?.roles[role].test?.status === 'PASS'
                                  ? 'Thành công'
                                  : models.value?.roles[role].test?.status === 'FAIL'
                                    ? 'Lỗi kết nối'
                                    : models.value?.roles[role].test?.status === 'BLOCKED'
                                      ? 'Chưa thể kiểm tra'
                                      : 'Chưa kiểm tra'}
                              </strong>
                            </p>
                            <p>
                              Áp dụng cho Chat:{' '}
                              <strong>{models.value?.roles[role].status === 'APPLIED' ? 'Đang dùng' : 'Chưa áp dụng'}</strong>
                            </p>
                            {models.value?.roles[role].active && models.value.roles[role].status !== 'APPLIED' && (
                              <p className="text-muted break-words">Đang dùng bản trước: {models.value.roles[role].active?.model}.</p>
                            )}
                          </div>
                          <Field label="Giao thức API">
                            <select name={`${role}_provider`} className={inputCls} defaultValue="openai-compatible">
                              <option value="openai-compatible">OpenAI-compatible</option>
                            </select>
                          </Field>
                          <Field label="Địa chỉ kết nối (Base URL)">
                            <input name={`${role}_base_url`} type="url" required maxLength={2048} className={inputCls} defaultValue={models.value?.[role]?.base_url ?? ''} />
                          </Field>
                          <Field label="Tên model">
                            <input name={`${role}_model`} required maxLength={200} className={inputCls} defaultValue={models.value?.[role]?.model ?? ''} />
                          </Field>
                          <Field
                            label="API key"
                            hint={
                              models.value?.[role]?.key_configured
                                ? 'Đã lưu key; giá trị được ẩn. Để trống để giữ key, nhập key mới rồi Lưu để thay thế.'
                                : 'Chưa thiết lập. Lần lưu đầu cần nhập key.'
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
                            <Button type="submit" variant="dark" disabled={!modelsDirty[role] || modelsSaving || models.loading || !models.value?.save_allowed}>
                              Lưu {role === 'chat' ? 'Chat' : 'Embedding'}
                            </Button>
                            {modelsDirty[role] && (
                              <Button
                                type="button"
                                onClick={event => {
                                  event.currentTarget.form?.reset()
                                  setModelsDirty(current => ({ ...current, [role]: false }))
                                  setModelsError('')
                                }}
                              >
                                Hủy thay đổi
                              </Button>
                            )}
                          </div>
                        </fieldset>
                        {modelsDirty[role] && <p className="text-xs text-muted">Thay đổi chưa lưu. Cần lưu trước khi kiểm thử.</p>}
                        <div className="flex flex-wrap gap-2 pt-1">
                          <Button
                            type="button"
                            disabled={modelsDirty[role] || modelsSaving || modelRunning || !models.value?.roles[role].actions.test}
                            onClick={() => {
                              if (models.value) setModelAction({ role, action: 'test', revision: models.value.revision })
                            }}
                          >
                            Kiểm tra {role === 'chat' ? 'Chat' : 'Embedding'}
                          </Button>
                          <Button
                            type="button"
                            disabled={modelsDirty[role] || modelsSaving || modelRunning || !models.value?.roles[role].actions.apply}
                            onClick={() => {
                              if (models.value) setModelAction({ role, action: 'apply', revision: models.value.revision })
                            }}
                          >
                            Áp dụng {role === 'chat' ? 'Chat' : 'Embedding'}
                          </Button>
                        </div>
                        {models.value?.roles[role].test?.code && models.value.roles[role].test?.code !== models.value.roles[role].blocker && (
                          <p className="text-xs break-words text-amber-800">{modelErrors[models.value.roles[role].test!.code!]}</p>
                        )}
                        {models.value?.roles[role].blocker && (
                          <p role="status" className="text-xs break-words text-muted">
                            {modelErrors[models.value.roles[role].blocker!]}
                          </p>
                        )}
                      </form>
                    ))}
                  </div>
                  <p className="text-xs text-muted">
                    Kiểm tra kết nối gửi tối đa 1 request thật và có thể phát sinh phí; chỉ gửi sau xác nhận. Builder ở Bước ② dùng Embedding đã lưu và kiểm tra thành công (không cần chờ Áp dụng cho Chat).
                  </p>
                </>
              )}
              {modelsMessage && <p role="status" className="text-emerald-700">{modelsMessage}</p>}
              {modelsError && <p role="alert" className="text-red-700">{modelsError}</p>}
              {modelRunning && <p role="status">Đang kiểm tra hoặc áp dụng model…</p>}
              <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-line">
                {projectId ? (
                  <Button variant="outline" onClick={() => goStep('3')}>
                    ← Quay lại đồ thị đang chọn (Bước ③)
                  </Button>
                ) : <span />}
                <Button variant="primary" onClick={() => goStep('2')}>
                  Tiếp tục: ② Dựng đồ thị →
                </Button>
              </div>
            </div>
          </Card>
        </div>
      )}

      {/* STEP 2: Dựng đồ thị */}
      {step === '2' && (
        <Card
          title="Bước ② — Dựng đồ thị tri thức từ dữ liệu đi kèm"
          right={
            <div className="flex flex-wrap items-center gap-3">
              <Link to="/admin/sources" className="text-xs underline text-muted hover:text-navy">
                Xem dữ liệu nguồn KAG
              </Link>
              <Button variant="outline" size="sm" onClick={() => goStep('3')}>
                Sang Bước ③ Dùng cho Chat →
              </Button>
            </div>
          }
        >
          <div className="px-5 pb-5">
            {verifyRun ? <BuilderGraph runId={verifyRun} /> : <BuilderControls />}
          </div>
        </Card>
      )}

      {/* STEP 3: Dùng cho Chat + Tùy chọn tìm kiếm + Chi tiết kỹ thuật */}
      {step === '3' && (
        <div className="space-y-5">
          <Card
            title="Bước ③ — Chọn đồ thị & Bật phục vụ Chat"
            right={
              <Button variant="outline" size="sm" onClick={() => goStep('2')}>
                + Dựng phiên mới (Bước ②)
              </Button>
            }
          >
            <div className="px-5 pb-5 text-sm space-y-4">
              <Notice {...catalog} retry={catalog.reload} />
              {catalog.value?.state === 'FORBIDDEN' && (
                <p role="alert">Đăng nhập OpenSPG bằng cùng địa chỉ máy chủ, kiểm quyền sở hữu project rồi bấm Tải lại.</p>
              )}
              {catalog.value?.state === 'EMPTY' && (
                <p>Chưa có project trong OpenSPG. Tạo Knowledge Base trong OpenSPG rồi chuyển sang Bước ② để dựng đồ thị.</p>
              )}

              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Project đang xem">
                  <select
                    className={inputCls}
                    value={projectId}
                    disabled={servingBusy || catalog.loading || catalog.value?.state !== 'AVAILABLE'}
                    onChange={event => goStep('3', { project_id: event.target.value || null, run_id: null })}
                  >
                    <option value="">Chọn project</option>
                    {projectId && !project && (
                      <option value={projectId}>{catalog.loading ? 'Đang đọc project…' : 'Project không còn trong danh sách'}</option>
                    )}
                    {catalog.value?.projects.map(row => (
                      <option key={row.project_id} value={row.project_id}>
                        {row.project_name} · #{row.project_id}
                      </option>
                    ))}
                  </select>
                </Field>
                {project && (
                  <Field label="Phiên dựng">
                    <select
                      className={inputCls}
                      value={runId}
                      disabled={servingBusy || serving.loading}
                      onChange={event => goStep('3', { project_id: projectId, run_id: event.target.value || null, tab })}
                    >
                      <option value="">Chọn phiên dựng</option>
                      {runs.map(row => (
                        <option key={row.run_id} value={row.run_id}>
                          {row.partial ? 'Một phần dữ liệu' : 'Toàn bộ dữ liệu'} · {row.nodes.toLocaleString('vi-VN')} nội dung · {row.run_id}
                        </option>
                      ))}
                    </select>
                  </Field>
                )}
              </div>

              {projectId && !project && !catalog.loading && (
                <p role="alert" className="text-red-700">
                  Project đã bị xóa, mất quyền hoặc phiên OpenSPG hết hạn. Đăng nhập lại rồi tải lại danh sách.
                </p>
              )}

              {project && (
                <>
                  {project.state === 'CONNECTION_NOT_CONFIGURED' && (
                    <p role="alert">Project chưa có kết nối nơi lưu graph. Kiểm cấu hình trong OpenSPG.</p>
                  )}
                  <nav aria-label="Công việc với đồ thị" className="flex flex-wrap gap-2 border-b border-line pb-3">
                    {([
                      ['chat', 'Dùng cho Chat'],
                      ['overview', 'Số liệu đồ thị'],
                      ['trial', 'Thử truy xuất'],
                    ] as const).map(([key, label]) => (
                      <Button
                        key={key}
                        variant={tab === key ? 'dark' : 'outline'}
                        disabled={servingBusy}
                        aria-current={tab === key ? 'page' : undefined}
                        onClick={() => goStep('3', { project_id: projectId, run_id: runId || null, tab: key })}
                      >
                        {label}
                      </Button>
                    ))}
                  </nav>

                  <div hidden={tab !== 'overview'}>
                    {project.state !== 'CONNECTION_NOT_CONFIGURED' && (
                      <SelectedGraph key={projectId} projectId={project.project_id} links={builderConfig.value?.links} />
                    )}
                  </div>

                  {!run && tab !== 'overview' && (
                    <p>
                      Chọn phiên dựng hoàn tất để tiếp tục.{' '}
                      {runs.length === 0 && (
                        <button type="button" className="underline text-accent-strong" onClick={() => goStep('2', { project_id: String(project.project_id) })}>
                          Mở Bước ② Dựng đồ thị cho project này
                        </button>
                      )}
                    </p>
                  )}

                  {run && (
                    <>
                      <p className="text-sm">
                        {run.partial ? 'Một phần dữ liệu' : 'Toàn bộ dữ liệu của phiên'} · {run.nodes.toLocaleString('vi-VN')} nội dung ·{' '}
                        {run.edges.toLocaleString('vi-VN')} quan hệ. {using && <strong className="text-emerald-700">Đang dùng cho Chat.</strong>}
                      </p>
                      <div hidden={tab !== 'trial'}>
                        <TrialGraph key={`${projectId}-${runId}`} projectId={project.project_id} runId={runId} modelPath={modelPath} />
                      </div>
                      <div hidden={tab !== 'chat'} className="space-y-4 text-sm">
                        <p>Chat dùng model phù hợp và bản nguồn đi cùng đồ thị. Không cần nhập lại nguồn vào Nội dung luật.</p>
                        <p className="text-muted">Hệ thống kiểm tương thích model & nguồn trước khi bạn xác nhận kích hoạt.</p>
                        {using &&
                          serving.value?.chat_blockers.map(code => (
                            <p key={code} className="text-amber-800">
                              {servingReasons[code] ?? 'Chưa thể dùng Chat. Xem Chi tiết kỹ thuật.'}
                            </p>
                          ))}
                        <div className="flex flex-wrap items-center gap-3">
                          <Button variant="primary" disabled={servingBusy || serving.loading || serving.value?.busy} onClick={() => void handleServingChange('preview')}>
                            {servingBusy ? 'Đang kiểm tương thích…' : 'Dùng cho Chat'}
                          </Button>
                          <Button variant="outline" onClick={() => goStep('1')}>
                            Chỉnh model (Bước ①)
                          </Button>
                          {using && (
                            <Link className="underline text-accent-strong font-medium" to="/chat">
                              Mở trang Hỏi luật ↗
                            </Link>
                          )}
                        </div>
                        <details>
                          <summary className="cursor-pointer underline text-muted">Chi tiết kỹ thuật phiên</summary>
                          <p className="break-all mt-2 text-xs">
                            Phiên: {run.run_id} · namespace {run.namespace} · model {run.model_identity} · {run.dimension} chiều.
                          </p>
                          <p className="text-xs mt-1">
                            Mã điều kiện: {serving.value?.chat_blockers.join(', ') || 'Không có trong trạng thái đang đọc'}.
                          </p>
                        </details>
                      </div>
                    </>
                  )}
                </>
              )}
              {servingError && <p role="alert" className="text-red-700">{servingError}</p>}
              {servingMessage && (
                <p role="status" className="text-emerald-700">
                  {servingMessage}{' '}
                  <Link className="underline" to="/chat">
                    Mở Chat ↗
                  </Link>
                </p>
              )}
            </div>
          </Card>

          {/* Search & Retrieval Options */}
          <Card title="Tùy chọn tìm kiếm khi trả lời Chat">
            <div className="px-5 pb-5 text-sm space-y-3">
              <p>Chọn số nguồn cần tìm và tìm thêm nội dung qua các quan hệ trong đồ thị.</p>
              <p className="text-muted">Câu trả lời cần trích dẫn nguồn. Không đủ căn cứ để trả lời thì hệ thống dừng trả lời.</p>
              <Notice {...retrieval} retry={retrieval.reload} />
              {retrievalState && (
                <>
                  {retrievalState.error_code && (
                    <p role="alert" className="text-red-700">
                      {retrievalState.error_code === 'CONFIG_INVALID'
                        ? 'Cấu hình đã lưu không hợp lệ. Cần kiểm tra phía triển khai.'
                        : 'Không đọc hoặc ghi được cấu hình đã lưu. Cần kiểm tra quyền truy cập.'}
                    </p>
                  )}
                  {retrievalState.active && (
                    <p>
                      Đang áp dụng: {retrievalState.active.top_k} kết quả nguồn; tìm thêm nội dung liên quan{' '}
                      {retrievalState.active.expand ? 'bật' : 'tắt'}.
                    </p>
                  )}
                  {retrievalState.saved && (
                    <p>
                      {retrievalState.persisted ? 'Đã lưu' : 'Mặc định chưa lưu'}: {retrievalState.saved.top_k} kết quả nguồn; tìm thêm nội dung liên quan{' '}
                      {retrievalState.saved.expand ? 'bật' : 'tắt'}.{retrievalState.pending && ' Chờ áp dụng.'}
                    </p>
                  )}
                  {!retrievalState.runtime_idle && <p>Hệ thống đang bận hoặc chưa thể đổi cấu hình an toàn. Thử áp dụng hoặc khôi phục sau.</p>}
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
                            onChange={event => setDraft({ ...draft, top_k: Number(event.target.value) })}
                          />
                        </Field>
                        <label className="flex items-center gap-2 min-h-10">
                          <input
                            type="checkbox"
                            checked={draft.expand}
                            disabled={changing || !retrievalState.actions.save}
                            onChange={event => setDraft({ ...draft, expand: event.target.checked })}
                          />{' '}
                          Tìm thêm nội dung liên quan
                        </label>
                      </div>
                      {!validRetrieval && <p role="alert" className="text-red-700">Số kết quả nguồn phải là số nguyên từ 1 đến 10.</p>}
                      <div className="flex flex-wrap gap-2">
                        <Button
                          disabled={changing || retrieval.loading || !retrievalState.actions.save || !dirtyRetrieval || !validRetrieval}
                          onClick={() => void updateRetrieval('save', retrievalState.revision, draft)}
                        >
                          Lưu
                        </Button>
                        <Button
                          disabled={changing || retrieval.loading || dirtyRetrieval || !retrievalState.actions.apply}
                          onClick={() => setConfirmation({ action: 'apply', revision: retrievalState.revision, values: retrievalState.saved! })}
                        >
                          Áp dụng
                        </Button>
                        <Button
                          disabled={changing || retrieval.loading || dirtyRetrieval || !retrievalState.actions.restore}
                          onClick={() => setConfirmation({ action: 'restore', revision: retrievalState.revision, values: retrievalState.previous! })}
                        >
                          Khôi phục
                        </Button>
                        {dirtyRetrieval && (
                          <Button disabled={changing || retrieval.loading} onClick={() => setDraft({ ...retrievalState.saved! })}>
                            Hủy thay đổi
                          </Button>
                        )}
                      </div>
                      {dirtyRetrieval && <p className="text-muted">Thay đổi trên form chưa lưu. Lưu trước khi áp dụng hoặc khôi phục.</p>}
                    </>
                  )}
                </>
              )}
              {changing && <p role="status">Đang cập nhật cấu hình…</p>}
              {changeMessage && <p role="status" className="text-emerald-700">{changeMessage}</p>}
              {changeError && <p role="alert" className="text-red-700">{changeError}</p>}
            </div>
          </Card>

          {/* Technical details & Snapshot */}
          <details className="text-sm rounded-2xl border border-line bg-surface p-5">
            <summary className="cursor-pointer underline font-semibold text-navy">Chi tiết kỹ thuật & Snapshot cấu hình</summary>
            <div className="mt-4 space-y-5">
              <Notice {...config} retry={config.reload} />
              <section className="space-y-2">
                <h3 className="font-semibold">Dữ liệu và schema</h3>
                {active && (
                  <p className="break-all">
                    Project ID {active.project_id} · namespace {active.namespace} · database ID {active.database_id} · run {active.run_id} · release{' '}
                    {active.release_id}
                  </p>
                )}
                {serving.value && (
                  <p>Mã điều kiện Chat: {serving.value.chat_blockers.join(', ') || 'Không có trong catalog'}.</p>
                )}
                <Notice {...schema} retry={schema.reload} />
                {schema.value && (
                  <dl className="space-y-1 break-all text-xs">
                    <div><dt className="text-muted">Namespace schema mẫu đóng gói</dt><dd>{schema.value.identity.namespace}</dd></div>
                    <div><dt className="text-muted">SHA-256 schema</dt><dd>{schema.value.identity.schema_sha256}</dd></div>
                    <div><dt className="text-muted">SHA-256 contract</dt><dd>{schema.value.identity.contract_sha256}</dd></div>
                  </dl>
                )}
                {value && (
                  <p className="break-all text-xs">
                    Runtime khởi động: release {value.project.release_id ?? 'chưa cấu hình'} · {releaseState[value.project.release_state]}.
                  </p>
                )}
                <Link className="underline inline-block text-xs" to="/admin/schema">
                  Xem schema và tải contract
                </Link>
              </section>
              <section className="space-y-2">
                <h3 className="font-semibold">Model: kiểm tra, bản đang áp dụng và runtime khởi động</h3>
                {(['chat', 'embedding'] as const).map(role => (
                  <div key={role} className="space-y-1 break-words text-xs">
                    <h4 className="font-semibold">{role === 'chat' ? 'Chat' : 'Embedding'}</h4>
                    {models.value && (
                      <>
                        <p>
                          Revision đã lưu: {models.value.roles[role].saved_revision ?? 'chưa lưu'} · đang áp dụng:{' '}
                          {models.value.roles[role].active_revision ?? 'chưa áp dụng'}.
                        </p>
                        {models.value.roles[role].test && (
                          <p>
                            Test: {models.value.roles[role].test?.status} · revision {models.value.roles[role].test?.revision} ·{' '}
                            {models.value.roles[role].test?.client_attempts} request · model phản hồi{' '}
                            {models.value.roles[role].test?.observed_model ?? 'chưa đo'} · dimension{' '}
                            {models.value.roles[role].test?.dimension ?? 'chưa đo'} · mã {models.value.roles[role].test?.code ?? 'không có'}.
                          </p>
                        )}
                      </>
                    )}
                    {value && (
                      <p className="break-all">
                        Lúc khởi động: {modelState[value.models[role].state]} · {value.models[role].model ?? 'chưa có model'} ·{' '}
                        {value.models[role].endpoint ?? 'chưa có endpoint'}.
                      </p>
                    )}
                  </div>
                ))}
              </section>
              {solver && (
                <section className="space-y-2 text-xs">
                  <h3 className="font-semibold text-sm">Solver và giới hạn tìm kiếm</h3>
                  <dl className="grid gap-2 sm:grid-cols-2">
                    {[
                      ['Pipeline', solver.pipeline],
                      ['Planner', solver.planner],
                      ['top_k mặc định source', solver.top_k],
                      ['Số vòng lặp tối đa', solver.max_iteration],
                      ['Evidence tối đa (ký tự)', solver.max_evidence_chars],
                      ['Search-k mỗi chỉ mục', solver.search_k],
                      ['expand mặc định source', solver.expand ? 'Bật' : 'Tắt'],
                      ['Giới hạn cạnh mở rộng', solver.expansion_limit],
                      ['Số chiều vector runtime yêu cầu', solver.required_vector_dimensions],
                    ].map(([label, text]) => (
                      <div key={String(label)}>
                        <dt className="text-muted">{label}</dt>
                        <dd className="break-all">{text}</dd>
                      </div>
                    ))}
                  </dl>
                </section>
              )}
              <details>
                <summary className="cursor-pointer underline text-xs">Snapshot cấu hình đã lọc</summary>
                {snapshot ? (
                  <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-all text-xs">{snapshot}</pre>
                ) : (
                  <p className="mt-3 text-xs">Chưa có snapshot.</p>
                )}
              </details>
              <Button
                size="sm"
                disabled={!value || copying || config.loading || schema.loading || builderInputs.loading || retrieval.loading || models.loading || modelsSaving || modelRunning || changing}
                onClick={() => void copySnapshot()}
              >
                {copying ? 'Đang sao chép…' : 'Sao chép snapshot'}
              </Button>
              {copied && <p role="status" className="text-xs text-emerald-700">Đã sao chép snapshot cấu hình.</p>}
              {copyError && <p role="alert" className="text-xs text-red-700">{copyError}</p>}
            </div>
          </details>
        </div>
      )}

      {/* ALWAYS VISIBLE: Danh sách đồ thị đã dựng */}
      <Card
        title={`Danh sách đồ thị đã dựng (${serving.value ? allRuns.length : '—'})`}
        className="mt-6"
        right={
          step !== '2' && (
            <Button size="sm" variant="outline" onClick={() => goStep('2')}>
              + Dựng đồ thị mới
            </Button>
          )
        }
      >
        {allRuns.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px]">
              <thead className="border-y border-line">
                <tr>
                  <Th>Project / Database</Th>
                  <Th>Phiên dựng</Th>
                  <Th>Số lượng đã xác minh</Th>
                  <Th>Trạng thái</Th>
                  <Th className="text-right">Thao tác</Th>
                </tr>
              </thead>
              <tbody>
                {allRuns.map(r => {
                  const isCurrentServing = active?.project_id === r.project_id && active?.run_id === r.run_id
                  const isSelected = step === '3' && String(r.project_id) === projectId && r.run_id === runId
                  return (
                    <tr key={`${r.project_id}-${r.run_id}`} className={`border-b border-line/60 last:border-0 ${isSelected ? 'bg-selected/50' : ''}`}>
                      <Td>
                        <strong className="text-navy">{r.project_name}</strong>
                        <span className="block text-xs text-muted">#{r.project_id} · {r.database}</span>
                      </Td>
                      <Td className="font-mono text-xs text-text-secondary break-all">
                        {r.run_id}
                        <span className="block font-sans text-muted mt-0.5">{r.partial ? 'Một phần corpus' : 'Toàn bộ corpus'}</span>
                      </Td>
                      <Td className="text-xs tabular-nums text-text-secondary">
                        {r.nodes.toLocaleString('vi-VN')} nội dung · {r.edges.toLocaleString('vi-VN')} quan hệ · {r.vectors.toLocaleString('vi-VN')} vector
                      </Td>
                      <Td>
                        {isCurrentServing ? <Badge tone="green">Đang dùng cho Chat</Badge> : <Badge tone="gray">Đã xác minh</Badge>}
                      </Td>
                      <Td className="text-right whitespace-nowrap">
                        <span className="inline-flex gap-1.5">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => goStep('3', { project_id: String(r.project_id), run_id: r.run_id, tab: 'overview' })}
                          >
                            Xem
                          </Button>
                          <Button
                            size="sm"
                            variant={isCurrentServing ? 'outline' : 'primary'}
                            onClick={() => goStep('3', { project_id: String(r.project_id), run_id: r.run_id, tab: 'chat' })}
                          >
                            {isCurrentServing ? 'Đang chọn' : 'Dùng cho Chat →'}
                          </Button>
                        </span>
                      </Td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="px-5 pb-5 text-sm text-muted">
            {serving.loading
              ? 'Đang đọc danh sách đồ thị đã dựng…'
              : serving.error
                ? 'Đăng nhập OpenSPG rồi bấm Tải lại để hiển thị danh sách project và phiên dựng thuộc quyền sở hữu.'
                : 'Chưa có phiên dựng hoàn tất nào. Hoàn thành Bước ① và Bước ② để tạo đồ thị đầu tiên.'}
          </div>
        )}
      </Card>

      {/* Modals: Serving activation, Retrieval apply/restore, Model test/apply */}
      {servingPreview && (
        <Modal open title="Dùng đồ thị cho Chat" onClose={() => { if (!servingBusy) setServingPreview(null) }}>
          <div className="space-y-4 text-sm">
            <p>
              Chuyển từ <strong>{servingPreview.previous?.project_name ?? 'chưa chọn'}</strong> sang <strong>{servingPreview.project_name}</strong>.
            </p>
            <p>
              {servingPreview.partial ? 'Một phần dữ liệu' : 'Toàn bộ dữ liệu của phiên'}: {servingPreview.counts.nodes.toLocaleString('vi-VN')} nội dung,{' '}
              {servingPreview.counts.edges.toLocaleString('vi-VN')} quan hệ.
            </p>
            <p>
              Chat: {servingPreview.chat?.model ?? 'Chưa cấu hình'}. Embedding: {servingPreview.embedding.model}.
            </p>
            {servingPreview.chat_blockers.map(code => (
              <p role="status" key={code} className="text-amber-800">
                {servingReasons[code] ?? 'Chưa thể áp dụng; xem Chi tiết kỹ thuật.'}
              </p>
            ))}
            <p>Các câu hỏi mới dùng đồ thị này. Lịch sử giữ nguồn cũ. Thao tác không gọi model.</p>
            <details>
              <summary className="underline cursor-pointer">Chi tiết kỹ thuật</summary>
              <pre className="text-xs whitespace-pre-wrap break-all mt-2">{JSON.stringify(servingPreview, null, 2)}</pre>
            </details>
            <div className="flex flex-wrap gap-4 items-center">
              <Button variant="primary" disabled={servingBusy || !servingPreview.chat_ready} onClick={() => void handleServingChange('activate')}>
                {servingBusy ? 'Đang áp dụng…' : 'Xác nhận dùng cho Chat'}
              </Button>
              {!servingPreview.chat_ready && (
                <Button variant="outline" onClick={() => { setServingPreview(null); goStep('1') }}>
                  Chỉnh model ở Bước ①
                </Button>
              )}
            </div>
          </div>
        </Modal>
      )}

      <Modal
        open={confirmation !== null}
        title={confirmation?.action === 'restore' ? 'Khôi phục cấu hình trước' : 'Áp dụng cấu hình đã lưu'}
        onClose={() => setConfirmation(null)}
        footer={
          <>
            <Button onClick={() => setConfirmation(null)}>Hủy</Button>
            <Button variant="primary" onClick={() => { if (confirmation) void updateRetrieval(confirmation.action, confirmation.revision) }}>
              Xác nhận
            </Button>
          </>
        }
      >
        {confirmation && (
          <p>
            Đặt {confirmation.values.top_k} kết quả nguồn; tìm thêm nội dung liên quan {confirmation.values.expand ? 'bật' : 'tắt'} cho các câu hỏi Chat tiếp theo.{' '}
            {confirmation.action === 'restore' && 'Bản đã lưu cũng được thay bằng bản khôi phục.'} Câu hỏi đang xử lý không bị thay đổi.
          </p>
        )}
      </Modal>

      <Modal
        open={modelAction !== null}
        title={modelAction?.action === 'test' ? 'Kiểm thử provider thực' : 'Áp dụng model phục vụ'}
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
            {modelAction.role === 'chat' ? 'Chat' : 'Embedding'}:{' '}
            {modelAction.action === 'test'
              ? 'gửi tối đa một yêu cầu tới model, có thể phát sinh phí. Không tự thử lại hoặc đổi bản đang áp dụng.'
              : 'áp dụng bản đã kiểm tra cho các câu hỏi tiếp theo khi tương thích với dữ liệu. Giữ bản đang áp dụng nếu thao tác thất bại; không dựng lại đồ thị.'}
          </p>
        )}
      </Modal>
    </Page>
  )
}

function TrialGraph({ projectId, runId, modelPath }: { projectId: number; runId: string; modelPath: string }) {
  const location = useLocation(), saved = location.state?.trialDraft
  const draft = saved?.projectId === projectId && saved?.runId === runId ? saved : undefined
  const [question, setQuestion] = useState(typeof draft?.question === 'string' ? draft.question.slice(0, 4000) : '')
  const [topK, setTopK] = useState(Number.isInteger(draft?.topK) && draft.topK >= 1 && draft.topK <= 10 ? draft.topK : 5)
  const [expand, setExpand] = useState(draft?.expand === true)
  const [result, setResult] = useState<GraphRetrieval>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const pending = useRef(false)
  async function retrieve() {
    if (pending.current || !question.trim()) return
    pending.current = true
    setBusy(true)
    setError('')
    setResult(undefined)
    try {
      setResult(await runGraphRetrieval(projectId, runId, question, topK, expand))
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Chưa thử được đồ thị. Kiểm model và kết nối.')
    } finally {
      pending.current = false
      setBusy(false)
    }
  }
  return (
    <section className="space-y-4 text-sm">
      <p>Tìm nguồn trong đồ thị đang xem; không tạo câu trả lời và không đổi đồ thị Chat. Gửi câu thử có thể tính phí Embedding.</p>
      <form className="space-y-4" onSubmit={event => { event.preventDefault(); void retrieve() }}>
        <Field label="Câu hỏi thử">
          <textarea className={inputCls} maxLength={4000} required rows={3} value={question} onChange={event => setQuestion(event.target.value)} />
        </Field>
        <div className="flex flex-wrap gap-4 items-end">
          <Field label="Số kết quả nguồn">
            <input className={inputCls} type="number" min={1} max={10} value={topK} onChange={event => setTopK(Number(event.target.value))} />
          </Field>
          <label className="flex gap-2 items-center min-h-10">
            <input type="checkbox" checked={expand} onChange={event => setExpand(event.target.checked)} />
            Tìm thêm nội dung liên quan
          </label>
        </div>
        <Button type="submit" disabled={busy || !question.trim() || !Number.isInteger(topK) || topK < 1 || topK > 10}>
          {busy ? 'Đang tìm nguồn…' : 'Thử truy xuất'}
        </Button>
      </form>
      {error && <p role="alert">{error}</p>}
      <Link className="underline inline-block" to={modelPath} state={{ trialDraft: { projectId, runId, question, topK, expand } }}>
        Chỉnh model (Bước ①)
      </Link>
      {result && (
        <>
          <p role="status">Tìm thấy {result.items.length} kết quả trong đồ thị đang chọn.</p>
          {result.items.map(item => (
            <article key={`${item.entity_type}-${item.entity_id}`} className="border-t border-line py-4 space-y-3">
              <h3 className="font-semibold break-words">{item.doc_id} · {item.unit_id ?? item.sign_id ?? 'Văn bản'}</h3>
              {Object.entries(item.source_texts).map(([field, text]) => (
                <p key={field} className="whitespace-pre-wrap break-words">{text}</p>
              ))}
              <details>
                <summary className="underline cursor-pointer">Chi tiết kỹ thuật và quan hệ</summary>
                <pre className="whitespace-pre-wrap break-all text-xs mt-3">{JSON.stringify(item, null, 2)}</pre>
              </details>
            </article>
          ))}
        </>
      )}
    </section>
  )
}

function SelectedGraph({ projectId, links }: { projectId: number; links: BuilderConfiguration['links'] }) {
  const load = useCallback((signal?: AbortSignal) => loadGraphProject(projectId, signal), [projectId])
  const data = useInspection(load), value = data.value, neo4j = value && builderNeo4jLink(links, value.target.database)
  return (
    <section className="space-y-4 text-sm">
      <Notice {...data} retry={data.reload} />
      {value && (
        <>
          <h3 className="font-semibold text-lg break-words">{value.target.project_name}</h3>
          <dl className="grid grid-cols-3 gap-3">
            {([
              ['Nội dung', value.counts.nodes],
              ['Quan hệ', value.counts.edges],
              ['Vector', value.counts.vectors],
            ] as const).map(([label, count]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd className="text-xl font-semibold">{count.toLocaleString('vi-VN')}</dd>
              </div>
            ))}
          </dl>
          <p className="text-muted">Đọc từ nơi lưu lúc {new Date(value.measured_at).toLocaleString('vi-VN')}. Số liệu có thể thay đổi khi đang dựng.</p>
          <details>
            <summary className="underline cursor-pointer">Chi tiết kỹ thuật</summary>
            <div className="mt-3 space-y-3">
              <p className="break-all">
                Project #{value.target.project_id} · database {value.target.database} · namespace {value.target.namespace} · {value.database_id}
              </p>
              {neo4j && (
                <a className="underline" target="_blank" rel="noreferrer" href={neo4j}>
                  Mở Neo4j
                </a>
              )}
              <pre className="whitespace-pre-wrap break-all text-xs">{JSON.stringify({ labels: value.labels, relations: value.relations, indexes: value.indexes }, null, 2)}</pre>
            </div>
          </details>
        </>
      )}
      <Button disabled={data.loading} onClick={data.reload}>
        Tải lại số liệu
      </Button>
    </section>
  )
}
