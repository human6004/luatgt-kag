import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Link, useLocation, useSearchParams } from 'react-router-dom'
import { Button, Card, Field, Modal, Td, Th, inputCls } from '../../admin/ui'
import { Notice } from './shared'
import {
  inspectionError, loadBuilderStatus, runBuilderAction, builderStateLabel, loadBuilderInputs,
  loadBuilderConfiguration, checkBuilderReadiness, loadBuilderProjects, builderNeo4jLink,
  previewBuilderSelection, loadBuilderPackages, packageReason, loadServing, changeServing,
  loadBuilderPackageExport, exportBuilderPackage, loadGraphProject, runGraphRetrieval,
  selectionVectorCount, startBuilderGraph,
  loadBuilderClear, clearBuilderData,
} from './kag-inspection'
import type { BuilderStatus, BuilderConfiguration, BuilderSelection, SelectionRequest,
  BuilderProjects, BuilderPackages, BuilderPackageExport, ServingCatalog, ServingPreview, GraphRetrieval, BuilderClear, GraphProject } from './kag-inspection'
import { servingReasons } from './kag-inspection'

export function useInspection<T>(load: (signal?: AbortSignal) => Promise<T>) {
  const [value, setValue] = useState<T>(),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [version, setVersion] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError("")
    setValue(undefined)
    load(controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setValue(result)
      })
      .catch((failure) => {
        if (!controller.signal.aborted) setError(inspectionError(failure))
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [load, version])
  return { value, setValue, error, loading, reload: () => setVersion((v) => v + 1) }
}

function builderIssue(code: string | null) {
  if (code?.startsWith('PACKAGE_')) return packageReason(code)
  const messages: Record<string, string> = {
    CONFIG: 'Kiểm tra đích lưu và cấu hình Embedding, lưu lại cấu hình dựng rồi kiểm tra sẵn sàng.',
    INDEX: 'Thiếu hoặc sai chỉ mục vector. Về Cấu hình → Xem thay đổi để kiểm schema/index; index không tương thích cần project riêng hoặc quản trị di chuyển có chủ đích.',
    SCHEMA: 'Schema đích thiếu hoặc khác cấu trúc LuậtGT. Về Cấu hình → Xem thay đổi trước khi chuẩn bị cấu trúc.',
    SCHEMA_CUSTOM: 'Có định nghĩa tùy chỉnh, khác mẫu mặc định hoặc phụ thuộc/index chưa rõ. Đã chặn xóa; xem danh sách xung đột. Chọn project riêng hoặc nhờ quản trị xử lý có chủ đích.',
    SCHEMA_DATA: 'Database đã có dữ liệu. Sync schema native có thể dựng lại index nên thao tác tự động bị chặn. Chọn project riêng hoặc di chuyển có chủ đích.',
    SCHEMA_REINDEX: 'Schema còn thiếu nhưng đã có chỉ mục nội dung đúng. Sync native có thể dựng lại các chỉ mục này; cần quản trị xử lý có chủ đích.',
    STRUCTURE_STALE: 'Bản xem trước đã cũ. Bấm Xem thay đổi, đọc lại tác động rồi xác nhận lại.',
    STRUCTURE_INTERRUPTED: 'Worker đã khởi động lại khi chuẩn bị cấu trúc. Kết quả chưa xác định. Bấm Xem thay đổi để đọc lại; không tự gửi lại apply.',
    CLEAR_SHARED: 'Database đang dùng chung với project khác hoặc chưa chứng minh được đích riêng. Không thể xóa bằng Builder.',
    CLEAR_SERVING: 'Đồ thị vừa được dùng lại cho Chat. Tải lại rồi xác nhận xóa lại.',
    CLEAR_STALE: 'Đích, dữ liệu, cấu trúc hoặc quyền xóa đã đổi. Xem trước lại và kiểm tác động trước khi xác nhận.',
    CLEAR_UNCERTAIN: 'Chưa xác định giao dịch xóa đã kết thúc. Khóa được giữ; nhờ quản trị đối soát trước khi thử lại. Không tự xóa khóa.',
    TARGET_MODEL: 'Vector hiện có không khớp model hoặc thiếu lịch sử xác minh. Chọn project rỗng, hoặc dùng đúng model và lịch sử phiên đã dựng đích này; không chỉ dựa vào số chiều.',
    FORBIDDEN: 'Đăng nhập lại OpenSPG, kiểm quyền sở hữu project rồi tải lại danh sách.',
    NOT_FOUND: 'Project đã bị xóa hoặc không còn thuộc quyền sở hữu. Tải lại danh sách và chọn lại.',
    CONNECTION_NOT_CONFIGURED: 'graph_store đã đổi hoặc chưa thuộc kết nối deployment cấp. Quản trị cần kiểm cấu hình hạ tầng.',
    SERVING_PROTECTED: 'Database này đang dành cho Chat. Chọn project trên database khác.',
    LOCK: 'Đồ thị đang dựng hoặc có thao tác khác. Dừng dựng trước rồi tải lại.',
    UNCERTAIN_WRITE: 'Lần ghi trước bị gián đoạn, chưa xác định đã ghi xong. Cần kiểm tra trước khi tiếp tục.',
    LOCK_MOUNT: 'Chưa có volume khóa dùng chung hợp lệ. Kiểm tra cài đặt Worker rồi thử lại.',
    INTEGRITY: 'Dữ liệu hoặc điểm lưu không khớp. Giữ nguyên phiên và kiểm tra phiên bản nguồn, cấu hình và đích lưu.',
    PLAN: 'Nguồn hoặc phạm vi không khớp gói vector/kế hoạch. Chọn đúng phiên bản dữ liệu và phạm vi của gói rồi chuẩn bị lại.',
    PROVENANCE: 'Nguồn gốc vector không khớp model, số chiều hoặc dữ liệu. Kiểm tra gói đã chọn; không thể bỏ qua phép kiểm này.',
    VECTORS: 'Chưa đủ vector khớp dữ liệu. Nếu dùng gói, kiểm tra nguồn/phạm vi rồi Kiểm tra và chuẩn bị lại; chế độ này không gọi API để bù vector.',
    PROVIDER_BUDGET: 'Đã chạm giới hạn request của phiên. Không thể làm mới hạn mức bằng Tiếp tục.',
    INTERRUPTED: 'Điểm dừng đã được lưu. Kiểm tra sẵn sàng rồi tiếp tục đúng phiên.',
    RUNTIME: 'Dịch vụ dựng gặp lỗi. Giữ nguyên phiên và kiểm tra Worker trước khi xử lý.',
    SCOPE: 'Đích hoặc quyền ghi chưa hợp lệ. Kiểm tra cấu hình deployment và danh tính database.',
  }
  return code ? messages[code] ?? 'Điều kiện dựng chưa đạt. Kiểm tra cấu hình và chi tiết kỹ thuật trước khi thử lại.' : ''
}
type LibraryRun = ServingCatalog['runs'][number]

export function GraphLibrary({ searchOptions }: { searchOptions: ReactNode }) {
  const [parameters, setParameters] = useSearchParams()
  const [catalog, setCatalog] = useState<BuilderProjects>()
  const [serving, setServing] = useState<ServingCatalog>()
  const [config, setConfig] = useState<BuilderConfiguration>()
  const [status, setStatus] = useState<BuilderStatus>()
  const [packages, setPackages] = useState<BuilderPackages>()
  const [exportState, setExportState] = useState<BuilderPackageExport>()
  const [clearState, setClearState] = useState<BuilderClear>(), [clearConfirmation, setClearConfirmation] = useState<GraphProject>()
  const [error, setError] = useState(''), [detailError, setDetailError] = useState('')
  const [readError, setReadError] = useState('')
  const [busy, setBusy] = useState(false), [version, setVersion] = useState(0)
  const [mode, setMode] = useState<'build' | 'import' | null>(null)
  const [projectId, setProjectId] = useState(''), [scope, setScope] = useState('ALL'), [percent, setPercent] = useState('10')
  const [packageName, setPackageName] = useState(''), [selection, setSelection] = useState<BuilderSelection>()
  const [planSha256, setPlanSha256] = useState(''), [sourceLoading, setSourceLoading] = useState(false)
  const [progress, setProgress] = useState(''), [preview, setPreview] = useState<ServingPreview>()
  const [view, setView] = useState<LibraryRun>()
  const acting = useRef(false), choosing = useRef(0)
  const selectedPackage = packages?.packages.find(row => row.name === packageName)
  const requestedScope: SelectionRequest = mode === 'import'
    ? selectedPackage?.manifest?.selection === null ? { mode: 'ALL', value: null }
      : { mode: 'COUNT', value: Number(selectedPackage?.manifest?.selection?.value) }
    : scope === 'ALL' ? { mode: 'ALL', value: null } : { mode: 'PERCENT', value: Number(percent) }
  const requestKey = JSON.stringify(requestedScope)
  const building = status && ['RUNNING', 'STOPPING', 'STOPPED'].includes(status.state)
  const clearing = clearState && ['APPLYING','PARTIAL','INTERRUPTED'].includes(clearState.state)
  useEffect(() => {
    if (busy) return
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>
    async function refresh() {
      try {
        const [projects, serving, config, status, exported, cleared] = await Promise.all([
          loadBuilderProjects(controller.signal), loadServing(controller.signal), loadBuilderConfiguration(controller.signal),
          loadBuilderStatus(controller.signal), loadBuilderPackageExport(controller.signal), loadBuilderClear(controller.signal),
        ])
        if (controller.signal.aborted) return
        setCatalog(projects); setServing(serving); setConfig(config); setStatus(status); setExportState(exported)
        setClearState(cleared)
        setReadError('')
      } catch (failure) {
        if (!controller.signal.aborted) { setReadError('Chưa đọc được thư viện đồ thị. Tải lại hoặc đăng nhập OpenSPG rồi thử tiếp.'); setDetailError(inspectionError(failure)) }
      } finally { if (!controller.signal.aborted) timer = setTimeout(refresh, 3000) }
    }
    void refresh()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [busy, version])
  useEffect(() => {
    if (!mode) return
    const controller = new AbortController()
    loadBuilderPackages(controller.signal).then(value => { if (!controller.signal.aborted) setPackages(value) })
      .catch(failure => { if (!controller.signal.aborted) { setError('Không đọc được danh sách gói. Tải lại sau khi chuẩn bị dữ liệu nguồn.'); setDetailError(inspectionError(failure)) } })
    return () => controller.abort()
  }, [mode, version])
  useEffect(() => {
    const id = ++choosing.current
    setSelection(undefined); setSourceLoading(false)
    if (!mode || !config || mode === 'import' && !selectedPackage?.compatible) return
    if (requestedScope.mode !== 'ALL' && (!Number.isInteger(requestedScope.value) || requestedScope.value! < 1 || requestedScope.value! > (requestedScope.mode === 'PERCENT' ? 100 : 2147483647))) return
    setSourceLoading(true)
    async function readSelection() {
      try {
        const inputs = await loadBuilderInputs()
        if (inputs.source_validation.state !== 'VALID') throw new Error('Nguồn chưa sẵn sàng')
        const value = await previewBuilderSelection(config!.revision, requestedScope)
        if (id === choosing.current) { setSelection(value); setPlanSha256(inputs.source_validation.plan_sha256!); setError(''); setDetailError('') }
      } catch (failure) {
        if (id === choosing.current) { setError('Chưa đọc được phạm vi dữ liệu. Kiểm tra dữ liệu nguồn rồi tải lại.'); setDetailError(inspectionError(failure)) }
      } finally { if (id === choosing.current) setSourceLoading(false) }
    }
    void readSelection()
    return () => { choosing.current++ }
  }, [mode, config?.revision, requestKey, selectedPackage?.sha256, version])
  const refresh = () => setVersion(value => value + 1)
  async function act(operation: () => Promise<unknown>) {
    if (acting.current) return
    acting.current = true; setBusy(true); setError(''); setDetailError('')
    try { await operation() }
    catch (failure) { setError('Thao tác chưa hoàn tất. Tải lại trạng thái trước khi thử tiếp.'); setDetailError(inspectionError(failure)) }
    finally { acting.current = false; setBusy(false); refresh() }
  }
  function openFlow(next: 'build' | 'import') {
    setMode(next); setProgress(''); setProjectId(''); setPackageName(''); setScope('ALL'); setSelection(undefined)
  }
  async function begin() {
    if (!mode || !selection || !projectId || sourceLoading || mode === 'import' && (!selectedPackage?.compatible || !selectedPackage.sha256)) return
    const vectorPackage = mode === 'import' ? { name: selectedPackage!.name, sha256: selectedPackage!.sha256! } : undefined
    await act(async () => {
      setStatus(await startBuilderGraph({ projectId: Number(projectId), selection, planSha256, vectorPackage }, setProgress))
      setMode(null); setProgress('')
    })
  }
  async function resume() {
    if (!status?.run_id || !config) return
    await act(async () => {
      let checked = await checkBuilderReadiness()
      while (checked.readiness.state === 'CHECKING') { await new Promise(resolve => setTimeout(resolve, 1500)); checked = await loadBuilderConfiguration() }
      if (checked.readiness.state !== 'READY' || checked.target?.project_id !== status.target?.project_id || checked.revision !== config.revision) throw new Error('Cấu hình đã đổi')
      setStatus(await runBuilderAction('resume', status.run_id!, checked.revision))
    })
  }
  const clearReport = catalog?.projects.some(row => row.project_id === clearState?.report?.target.project_id) ? clearState?.report : null
  const rows = (serving?.runs ?? []).filter((row, index, all) => all.findIndex(other => other.database === row.database) === index && !(clearState?.state === 'COMPLETE' && clearReport?.database_id && clearReport.target.database === row.database))
  async function showClear(projectId: number) {
    await act(async () => { setClearConfirmation(await loadGraphProject(projectId)) })
  }
  async function confirmClear() {
    if (!clearConfirmation) return
    await act(async () => {
      setClearState(await clearBuilderData(clearConfirmation.target.project_id,clearConfirmation.database_id))
      setClearConfirmation(undefined)
    })
  }
  useEffect(() => {
    const requested = parameters.get('project_id')
    if (requested && !view) {
      const row = rows.find(row => String(row.project_id) === requested && (!parameters.get('run_id') || row.run_id === parameters.get('run_id')))
      if (row) setView(row)
    }
  }, [parameters, serving])
  function closeView() { setView(undefined); const next = new URLSearchParams(parameters); ['project_id','run_id','verify_run','bstep'].forEach(key => next.delete(key)); setParameters(next, { replace: true }) }
  return <section id="graph-library" className="space-y-5 mt-6" aria-label="Đồ thị">
    <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-xl font-semibold">Đồ thị</h2><div className="flex flex-wrap gap-3">
      <Button variant="primary" disabled={busy || !!building || !!clearing || !!readError || !config} onClick={() => openFlow('build')}>+ Dựng đồ thị mới</Button>
      <Button disabled={busy || !!building || !!clearing || !!readError || !config} onClick={() => openFlow('import')}>+ Nhập từ gói</Button>
      <Button disabled={busy} onClick={refresh}>Tải lại danh sách</Button>
    </div></div>
    <Card title={serving?.active ? `Đang dùng cho Chat: ${serving.active.project_name}` : 'Chưa chọn đồ thị'} right={<Button onClick={() => document.getElementById('graph-table')?.focus()}>Chọn đồ thị</Button>}>
      <div className="px-5 pb-5 text-sm space-y-3"><p>{serving?.active && serving.runtime_ready && !serving.chat_blockers.length ? 'Chat đang dùng đồ thị này để tìm căn cứ trả lời.' : 'Chọn đồ thị sẵn sàng để Chat tìm căn cứ trả lời.'}</p>
        {serving?.chat_blockers.filter(code => code !== 'GRAPH_REQUIRED').map(code => <p key={code}>{servingReasons[code] ?? 'Đồ thị chưa sẵn sàng. Mở Xem để kiểm tra.'}</p>)}
        <details><summary className="underline cursor-pointer">Tùy chọn tìm kiếm</summary><div className="mt-4">{searchOptions}</div></details>
      </div>
    </Card>
    {(error || readError) && <div role="alert" className="text-sm space-y-2"><p>{error || readError}</p><details><summary className="underline cursor-pointer">Chi tiết kỹ thuật</summary><pre className="whitespace-pre-wrap break-all">{detailError}</pre></details></div>}
    <div id="graph-table" tabIndex={-1} className="overflow-x-auto rounded-2xl border border-line bg-surface">
      <table className="w-full text-sm" aria-label="Thư viện đồ thị"><thead><tr>{['Tên','Phạm vi','Nội dung','Liên kết','Vector','Trạng thái','Thao tác'].map(label => <Th key={label}>{label}</Th>)}</tr></thead><tbody>
        {building && <tr><Td>{catalog?.projects.find(row => row.project_id === status.target?.project_id)?.project_name ?? 'Đồ thị đang dựng'}</Td><Td>{status.contract_version !== 'builder-control-v1' && status.binding?.node_limit ? 'Một phần' : 'Toàn bộ'}</Td><td colSpan={3} className="px-5 py-3"><p>{builderStateLabel(status.state)}</p>{status.progress && <p>{status.progress.done.toLocaleString('vi-VN')}/{status.progress.total.toLocaleString('vi-VN')}</p>}</td><Td>{status.state === 'STOPPED' ? 'Đã dừng' : 'Đang dựng'}</Td><Td><div className="flex gap-2">
          <Button disabled={busy || !status.actions.stop} onClick={() => void act(async () => setStatus(await runBuilderAction('stop', status.run_id!)))}>Dừng</Button>
          <Button disabled={busy || !status.actions.resume} onClick={() => void resume()}>Tiếp tục</Button>
          {status.state === 'STOPPED' && status.target && <Button disabled={busy || !!clearing} onClick={() => void showClear(status.target!.project_id)}>Xóa</Button>}</div></Td></tr>}
        {rows.map(row => <tr key={`${row.project_id}:${row.run_id}`} className="border-t border-line"><Td>{row.project_name}</Td><Td>{row.partial ? 'Một phần' : 'Toàn bộ'}</Td><Td>{row.nodes.toLocaleString('vi-VN')}</Td><Td>{row.edges.toLocaleString('vi-VN')}</Td><Td>{row.vectors.toLocaleString('vi-VN')}</Td><Td>{serving?.active?.database === row.database ? 'Đang dùng cho Chat' : 'Đã dựng'}</Td><Td><div className="flex flex-wrap gap-2">
          <Button variant="primary" disabled={busy || serving?.busy || serving?.active?.database === row.database || !!clearing && clearReport?.target.database === row.database} onClick={() => void act(async () => setPreview(await changeServing('preview', row.project_id, row.run_id)))}>Dùng cho Chat</Button>
          <Button disabled={busy || exportState?.state === 'RUNNING'} onClick={() => void act(async () => setExportState(await exportBuilderPackage(row.project_id, row.run_id)))}>Xuất gói</Button>
          <Button disabled={busy} onClick={() => setView(row)}>Xem</Button>
          <Button disabled={busy || !!clearing && clearReport?.target.database !== row.database || clearState?.state === 'APPLYING' || status?.target?.project_id === row.project_id && ['RUNNING','STOPPING'].includes(status.state)} title={status?.target?.project_id === row.project_id && ['RUNNING','STOPPING'].includes(status.state) ? 'Dừng dựng trước' : clearing && clearReport?.target.database !== row.database ? 'Hoàn tất xóa đồ thị trước' : undefined} onClick={() => void showClear(row.project_id)}>Xóa</Button>
        </div></Td></tr>)}
        {clearing && clearReport && !rows.some(row => row.database === clearReport.target.database) && <tr className="border-t border-line"><Td>{clearReport.target.project_name}</Td><Td>Đang xóa dữ liệu</Td><Td>{clearReport.counts.nodes.toLocaleString('vi-VN')}</Td><Td>{clearReport.counts.edges.toLocaleString('vi-VN')}</Td><Td>—</Td><Td>{clearState?.state === 'APPLYING' ? 'Đang xóa' : 'Chưa xóa xong'}</Td><Td><Button disabled={busy || clearState?.state === 'APPLYING'} onClick={() => void showClear(clearReport.target.project_id)}>Xóa tiếp</Button></Td></tr>}
        {!rows.length && !building && <tr><td colSpan={7} className="px-5 py-3">{serving ? 'Chưa có đồ thị đã dựng. Dựng mới hoặc nhập từ gói để bắt đầu.' : 'Đang đọc danh sách đồ thị…'}</td></tr>}
      </tbody></table>
    </div>
    {status && (building || status.state === 'BLOCKED') && <div className="text-sm space-y-2">{status.contract_version !== 'builder-control-v1' && status.stages.map(stage => <p key={stage.name}>{({ preflight:'Kiểm tra điều kiện',plan:'Chuẩn bị dữ liệu',vectorize:'Tạo vector','export-artifact':'Lưu vector','write-nodes':'Ghi nội dung','verify-nodes':'Kiểm nội dung','write-edges':'Ghi liên kết',verify:'Xác minh đồ thị',release:'Lưu kết quả' } as Record<string,string>)[stage.name]}: {({PENDING:'Chưa thực hiện',RUNNING:'Đang xử lý',COMPLETE:'Hoàn tất',STOPPED:'Đã dừng',BLOCKED:'Cần xử lý'})[stage.state]} {stage.done !== null ? `${stage.done}/${stage.total}` : ''}</p>)}
      {status.error_code && <p role="alert">{builderIssue(status.error_code)}</p>}<details><summary className="underline cursor-pointer">Chi tiết kỹ thuật</summary><pre className="whitespace-pre-wrap break-all">{JSON.stringify(status,null,2)}</pre></details></div>}
    {exportState?.state === 'RUNNING' && <p role="status">Đang xuất gói…</p>}
    {exportState?.state === 'COMPLETE' && <p role="status" className="text-sm break-words">Đã xuất {exportState.name}. Lấy tệp tại {exportState.directory} để chép sang máy khác.</p>}
    {exportState?.state === 'FAILED' && <p role="alert">Xuất gói chưa hoàn tất. {packageReason(exportState.code ?? '')}</p>}
    {clearReport && clearState && clearState.state !== 'NOT_RUN' && <div className="text-sm space-y-2" role="status"><p>{clearState.state === 'COMPLETE' ? 'Đã xóa đồ thị. Có thể tái sử dụng đích trống trong OpenSPG.' : `Đã xóa ${clearState.deleted.nodes.toLocaleString('vi-VN')} nội dung và ${clearState.deleted.edges.toLocaleString('vi-VN')} liên kết; ${clearState.state === 'APPLYING' ? 'đang tiếp tục.' : 'chưa hoàn tất, tải lại để kiểm tra.'}`}</p>{clearState.code && <p>{['SCOPE','CLEAR_SERVING'].includes(clearState.code) ? 'Đồ thị vừa được dùng lại cho Chat. Tải lại rồi xác nhận xóa lại.' : builderIssue(clearState.code)}</p>}<details><summary className="underline cursor-pointer">Chi tiết kỹ thuật</summary><pre className="whitespace-pre-wrap break-all">{JSON.stringify(clearState,null,2)}</pre></details></div>}
    <Modal open={mode !== null} title={mode === 'import' ? 'Nhập từ gói' : 'Dựng đồ thị mới'} onClose={() => { if (!busy) setMode(null) }} footer={<><Button disabled={busy} onClick={() => setMode(null)}>Hủy</Button><Button variant="primary" disabled={busy || !projectId || !selection || sourceLoading || !!building || mode === 'import' && !selectedPackage?.compatible} onClick={() => void begin()}>{mode === 'import' ? 'Xác nhận nhập' : 'Xác nhận dựng'}</Button></>}>
      <div className="space-y-4 text-sm">
        <p>Tạo một đồ thị trống trong OpenSPG, sau đó tải lại danh sách để chọn.</p>
        <div className="flex gap-3">{config?.links?.openspg && <a className="underline" target="_blank" rel="noreferrer" href={config.links.openspg}>Mở OpenSPG</a>}<Button disabled={busy} onClick={refresh}>Tải lại danh sách</Button></div>
        <Field label="Đồ thị trống"><select className={inputCls} value={projectId} disabled={busy} onChange={event => setProjectId(event.target.value)}><option value="">Chọn đồ thị</option>{catalog?.projects.filter(row => row.state === 'AVAILABLE').map(row => <option key={row.project_id} value={row.project_id}>{row.project_name}</option>)}</select></Field>
        {mode === 'import' ? <><p>Chép ZIP vào thư mục {packages?.directory ?? 'graph-packages'} rồi tải lại.</p><Field label="Gói đồ thị"><select className={inputCls} value={packageName} disabled={busy} onChange={event => setPackageName(event.target.value)}><option value="">Chọn gói</option>{packages?.packages.map(row => <option key={row.name} value={row.name} disabled={!row.compatible}>{row.compatible ? '✓' : '✗'} {row.name}</option>)}</select></Field>
          {packages?.packages.filter(row => !row.compatible).map(row => <p key={row.name}>{row.name}: {packageReason(row.reason)}</p>)}
          {selectedPackage?.manifest && <p>Phạm vi từ gói: {selectedPackage.manifest.selection === null ? 'toàn bộ' : 'một phần'} · {selectedPackage.manifest.nodes.toLocaleString('vi-VN')} nội dung. Nhập vào đồ thị trống đã có không gọi embedding.</p>}</>
          : <><Field label="Phạm vi"><select className={inputCls} value={scope} disabled={busy} onChange={event => setScope(event.target.value)}><option value="ALL">Toàn bộ dữ liệu</option><option value="PERCENT">Một phần dữ liệu</option></select></Field>{scope === 'PERCENT' && <Field label="Tỷ lệ dữ liệu (%)"><input className={inputCls} type="number" min={1} max={100} value={percent} disabled={busy} onChange={event => setPercent(event.target.value)} /></Field>}{scope === 'PERCENT' && <p>Bản thử {percent}%</p>}</>}
        {sourceLoading ? <p>Đang đọc phạm vi…</p> : selection && <p>{selection.summary.nodes.toLocaleString('vi-VN')} nội dung · {selection.summary.edges.toLocaleString('vi-VN')} liên kết.{mode === 'build' && ` Cần tạo khoảng ${selectionVectorCount(selection.summary).toLocaleString('vi-VN')} vector.`}</p>}
        {mode === 'build' && <p>Tạo vector có thể phát sinh phí embedding. Dựng xong chưa tự dùng cho Chat.</p>}
        {!selection && !sourceLoading && <Button disabled={busy} onClick={() => void act(async () => {
          let value=await loadBuilderInputs(undefined,true)
          while(value.source_validation.state==='CHECKING'){await new Promise(resolve=>setTimeout(resolve,1500));value=await loadBuilderInputs()}
          if(value.source_validation.state!=='VALID')throw new Error('Nguồn chưa sẵn sàng')
        })}>Chuẩn bị dữ liệu nguồn</Button>}
        {progress && <p role="status">{progress}</p>}{error && <p role="alert">{error}</p>}
      </div>
    </Modal>
    {preview && <Modal open title="Dùng đồ thị cho Chat" onClose={() => { if (!busy) setPreview(undefined) }} footer={<><Button disabled={busy} onClick={() => setPreview(undefined)}>Hủy</Button><Button variant="primary" disabled={busy || !preview.chat_ready} onClick={() => void act(async () => { await changeServing('activate',preview.project_id,preview.run_id,preview.preview_id);setPreview(undefined) })}>Xác nhận dùng cho Chat</Button></>}>
      <div className="space-y-3 text-sm"><p>Chuyển từ {preview.previous?.project_name ?? 'chưa chọn'} sang {preview.project_name}.</p><p>{preview.counts.nodes.toLocaleString('vi-VN')} nội dung · {preview.counts.edges.toLocaleString('vi-VN')} liên kết.</p>{preview.chat_blockers.map(code => <p key={code}>{servingReasons[code] ?? 'Chưa thể dùng đồ thị. Kiểm tra model và dữ liệu.'}</p>)}<details><summary className="underline cursor-pointer">Chi tiết kỹ thuật</summary><pre className="whitespace-pre-wrap break-all">{JSON.stringify(preview,null,2)}</pre></details>{error && <p role="alert">{error}</p>}</div>
    </Modal>}
    {view && <Modal open title={view.project_name} onClose={closeView}><div className="space-y-5"><SelectedGraph projectId={view.project_id} links={config?.links} /><details><summary className="underline cursor-pointer">Thử tìm kiếm</summary><div className="mt-4"><TrialGraph projectId={view.project_id} runId={view.run_id} modelPath="/admin/chatbot?step=1" /></div></details><details><summary className="underline cursor-pointer">Chi tiết kỹ thuật phiên</summary><pre className="whitespace-pre-wrap break-all text-xs">{JSON.stringify(view,null,2)}</pre></details></div></Modal>}
    {clearConfirmation && <Modal open title="Xóa đồ thị" onClose={() => { if (!busy) setClearConfirmation(undefined) }} footer={<><Button disabled={busy} onClick={() => setClearConfirmation(undefined)}>Hủy</Button><Button variant="primary" disabled={busy} onClick={() => void confirmClear()}>Xác nhận xóa</Button></>}><div className="space-y-3 text-sm"><p>Xóa đồ thị {clearConfirmation.target.project_name}, gồm {clearConfirmation.counts.nodes.toLocaleString('vi-VN')} nội dung. Không thể hoàn tác.</p>{serving?.active && (serving.active.database_id === clearConfirmation.database_id || serving.active.database === clearConfirmation.target.database) && <p>Chat tạm ngưng trả lời cho tới khi chọn đồ thị khác</p>}{error && <p role="alert">{error}</p>}</div></Modal>}
  </section>
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
        Chỉnh model
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
              ['Liên kết', value.counts.edges],
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
