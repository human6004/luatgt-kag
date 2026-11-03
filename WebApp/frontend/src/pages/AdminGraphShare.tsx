import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Badge, Button, Card, Field, Page, inputCls } from '../admin/ui'
import { useInspection } from './server/KagManagement'
import { Notice } from './server/shared'
import { exportBuilderPackage, inspectionError, loadBuilderPackageExport, loadBuilderPackages, loadServing, packageReason, type BuilderPackageExport } from './server/kag-inspection'

export default function AdminGraphShare() {
  const serving = useInspection(loadServing), packages = useInspection(loadBuilderPackages)
  const [run, setRun] = useState(''), [exportState, setExportState] = useState<BuilderPackageExport>(),
    [error, setError] = useState(''), [actionError, setActionError] = useState(''), [posting, setPosting] = useState(false), [version, setVersion] = useState(0)
  const acting = useRef(false)
  useEffect(() => {
    if (posting) return
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>
    async function refresh() {
      try {
        const result = await loadBuilderPackageExport(controller.signal)
        if (controller.signal.aborted) return
        setExportState(result); setError('')
        if (result.state === 'RUNNING') timer = setTimeout(refresh, 2000)
      } catch (failure) { if (!controller.signal.aborted) setError(inspectionError(failure)) }
    }
    refresh()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [posting, version])
  useEffect(() => { if (exportState?.state === 'COMPLETE') packages.reload() }, [exportState?.state])
  const selected = serving.value?.runs.find(row => `${row.project_id}:${row.run_id}` === run)
  const disabled = posting || !exportState || exportState.state === 'RUNNING' || !!error || serving.loading || !!serving.error || serving.value?.busy || !selected
  async function startExport() {
    if (disabled || !selected || acting.current) return
    acting.current = true; setPosting(true); setActionError('')
    try { setExportState(await exportBuilderPackage(selected.project_id, selected.run_id)) }
    catch (failure) { setActionError(inspectionError(failure)) }
    finally { acting.current = false; setPosting(false) }
  }
  const current = packages.value?.current_model
  return <Page title="Chia sẻ đồ thị" subtitle="Xuất vector đã xác minh, chép gói sang máy khác rồi tự dựng vào project mới, trống.">
    <div className="grid gap-6 xl:grid-cols-2">
      <Card title="Xuất"><div className="px-5 pb-5 space-y-4 text-sm">
        <p>Chọn phiên dựng dữ liệu ứng dụng đã PASS thuộc project bạn sở hữu. Xuất không ghi graph và không gọi Embedding.</p>
        <Notice {...serving} retry={serving.reload} />
        <Field label="Phiên đã xác minh"><select className={inputCls} value={run} disabled={posting || exportState?.state === 'RUNNING' || serving.loading} onChange={event => setRun(event.target.value)}>
          <option value="">Chọn phiên</option>
          {serving.value?.runs.map(row => <option key={`${row.project_id}:${row.run_id}`} value={`${row.project_id}:${row.run_id}`}>{row.project_name} · {row.run_id} · {row.partial ? 'một phần' : 'toàn bộ'} · {row.nodes.toLocaleString('vi-VN')} nội dung</option>)}
        </select></Field>
        {serving.value && !serving.value.runs.length && <p>Chưa có phiên PASS có thể xuất.</p>}
        {selected && <p>{selected.nodes.toLocaleString('vi-VN')} nội dung · {selected.edges.toLocaleString('vi-VN')} quan hệ · {selected.vectors.toLocaleString('vi-VN')} vector · {selected.dimension} chiều.</p>}
        <div className="flex flex-wrap gap-3"><Button variant="primary" disabled={!!disabled} onClick={startExport}>Xuất gói</Button>
          <Button disabled={posting} onClick={() => { setVersion(v => v + 1); serving.reload() }}>Tải lại trạng thái xuất</Button></div>
        {error && <p role="alert">{error}</p>}
        {actionError && <p role="alert">{actionError}</p>}
        {exportState?.state === 'RUNNING' && <p role="status">Đang xuất gói. Có thể rời trang rồi quay lại theo dõi.</p>}
        {exportState?.state === 'FAILED' && <p role="alert">Xuất gói thất bại. {packageReason(exportState.code ?? 'UNKNOWN')}</p>}
        {exportState?.state === 'COMPLETE' && <div role="status" className="space-y-2"><p>Đã xuất: <strong>{exportState.name}</strong> · {exportState.size?.toLocaleString('vi-VN')} byte.</p><p>Chép tệp từ thư mục: <code className="break-all">{exportState.directory}</code></p></div>}
        <p className="text-muted">Gói chứa vector và nguồn cần để dựng lại; không chứa database, tài khoản hoặc lịch sử chat.</p>
      </div></Card>
      <Card title="Nhập" right={<Button disabled={packages.loading} onClick={packages.reload}>Tải lại</Button>}><div className="px-5 pb-5 space-y-4 text-sm">
        <p>Chép ZIP vào thư mục máy nhận: <code className="break-all">{packages.value?.directory ?? 'đang đọc cấu hình thư mục…'}</code>, rồi bấm Tải lại.</p>
        <Notice {...packages} retry={packages.reload} />
        <p>Máy hiện tại: {current ? `${current.provider} · ${current.model} · ${current.dimension} chiều` : 'chưa có Embedding đã kiểm tra.'}</p>
        {packages.value?.packages.length === 0 && <p>Chưa có gói ZIP trong thư mục.</p>}
        <ul className="space-y-4">{packages.value?.packages.map(row => <li key={row.name} className="border-t border-line pt-3 space-y-2">
          <p className="font-medium break-all">{row.name} <Badge tone={row.compatible ? 'green' : 'amber'}>{row.compatible ? '✓ Tương thích để nhập' : 'Chưa tương thích'}</Badge></p>
          <p>{row.size.toLocaleString('vi-VN')} byte · {packageReason(row.reason)}</p>
          {row.manifest && <><p>Gói yêu cầu: {row.manifest.model_identity.provider} · {row.manifest.model_identity.model} · {row.manifest.model_identity.dimension} chiều.</p>
            <p>{row.manifest.nodes.toLocaleString('vi-VN')} nội dung · {row.manifest.edges.toLocaleString('vi-VN')} quan hệ · {row.manifest.selection === null ? 'toàn bộ dữ liệu' : 'một phần dữ liệu; chọn đúng phạm vi của gói'}.</p></>}
        </li>)}</ul>
        <p>Danh sách và Lưu cấu hình chưa giải nén gói. Chọn nguồn vector ở Bước ②, lưu cấu hình rồi bấm Kiểm tra và chuẩn bị để nhập nền. Sau đó tự Dựng vào project mới, trống.</p>
        <p className="text-muted">✓ chỉ xác nhận tương thích để nhập. Builder vẫn kiểm nguồn, phạm vi, model và xác minh graph đích.</p>
        <Link className="underline inline-block" to="/admin/chatbot?step=2&bstep=1">Đến Bước ② · chọn nguồn vector →</Link>
      </div></Card>
    </div>
  </Page>
}
