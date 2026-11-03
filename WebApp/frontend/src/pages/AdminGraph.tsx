import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useLocation, useSearchParams } from 'react-router-dom'
import { Button, Field, Modal, Page, inputCls } from '../admin/ui'
import { ApiError } from '../api'
import { Notice } from './server/shared'
import { BuilderGraph, useInspection } from './server/KagManagement'
import { builderNeo4jLink, loadBuilderConfiguration, loadBuilderProjects, loadGraphProject, loadServing, changeServing, servingReasons, runGraphRetrieval } from './server/kag-inspection'
import type { BuilderConfiguration, ServingPreview, GraphRetrieval } from './server/kag-inspection'

export default function AdminGraph() {
  const [parameters, setParameters] = useSearchParams()
  const catalog = useInspection(loadBuilderProjects), configuration = useInspection(loadBuilderConfiguration), serving = useInspection(loadServing)
  const projectId = parameters.get('project_id') ?? '', requestedRun = parameters.get('run_id') ?? '', requestedTab = parameters.get('tab')
  const tab = requestedTab === 'trial' || requestedTab === 'chat' ? requestedTab : 'overview'
  const project = catalog.value?.projects.find(row => String(row.project_id) === projectId)
  const runs = serving.value?.runs.filter(row => row.project_id === project?.project_id) ?? [], active = serving.value?.active
  const runId = requestedRun || (active?.project_id === project?.project_id ? active?.run_id : runs.length === 1 ? runs[0].run_id : '') || ''
  const run = runs.find(row => row.run_id === runId), using = !!run && active?.project_id === project?.project_id && active?.run_id === runId
  const context = `/admin/graph?project_id=${projectId}${runId ? `&run_id=${encodeURIComponent(runId)}` : ''}`
  const modelPath = `/admin/config?returnTo=${encodeURIComponent(context + '&tab=' + tab)}`
  const [preview, setPreview] = useState<ServingPreview | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('')
  const pending = useRef(false)
  useEffect(() => { setPreview(null); setError(''); setMessage('') }, [projectId, runId])
  async function change(action: 'preview' | 'activate') {
    if (!project || !run || pending.current) return
    pending.current = true; setBusy(true); setError(''); setMessage('')
    try {
      const result = await changeServing(action, project.project_id, run.run_id, preview?.preview_id)
      if (action === 'preview') setPreview(result)
      else { setPreview(null); setMessage('Đã dùng đồ thị này cho các câu hỏi mới.'); serving.reload() }
    } catch (failure) {
      setPreview(null); setError(failure instanceof ApiError ? failure.message : 'Chưa xác nhận được kết quả. Đang đọc lại trạng thái; kiểm trước khi thử tiếp.'); serving.reload()
    } finally { pending.current = false; setBusy(false) }
  }
  if (requestedRun && !projectId) return <><Link className="underline" to="/admin/graph">Về Đồ thị của tôi</Link><BuilderGraph runId={requestedRun} /></>
  return <Page title="Đồ thị của tôi" subtitle="Chọn đồ thị để xem, thử truy xuất hoặc dùng cho Chat."
    actions={<div className="flex flex-wrap gap-3 items-center"><Button disabled={catalog.loading || busy} onClick={() => { catalog.reload(); serving.reload(); configuration.reload() }}>Tải lại</Button><Link className="underline text-sm" to={`/admin/pipeline${project ? `?project_id=${project.project_id}` : ''}`}>Dựng mới</Link></div>}>
    <Notice {...catalog} retry={catalog.reload} /><Notice {...serving} retry={serving.reload} />
    <p className="mb-5 text-sm">Chat đang dùng: {serving.loading ? 'Đang đọc trạng thái…' : serving.error ? 'Chưa đọc được trạng thái' : active ? active.project_name : 'Chưa chọn đồ thị'}. Xem hoặc thử đồ thị khác giữ nguyên lựa chọn này.</p>
    {catalog.value?.state === 'FORBIDDEN' && <p role="alert" className="mb-4">Đăng nhập OpenSPG bằng cùng địa chỉ máy chủ, kiểm quyền sở hữu project rồi tải lại.</p>}
    {catalog.value?.state === 'EMPTY' && <p className="mb-4">Chưa có project. Tạo project trong OpenSPG rồi bấm Dựng mới.</p>}
    {configuration.value?.links && <a className="underline inline-block mb-4 text-sm" target="_blank" rel="noreferrer" href={configuration.value.links.openspg}>Mở OpenSPG</a>}
    <div className="grid gap-4 sm:grid-cols-2 mb-5">
      <Field label="Project đang xem"><select className={inputCls} value={projectId} disabled={busy || catalog.loading || catalog.value?.state !== 'AVAILABLE'} onChange={event => setParameters(event.target.value ? { project_id: event.target.value } : {})}>
        <option value="">Chọn project</option>{projectId && !project && <option value={projectId}>{catalog.loading ? 'Đang đọc project…' : 'Project không còn trong danh sách'}</option>}
        {catalog.value?.projects.map(row => <option key={row.project_id} value={row.project_id}>{row.project_name} · #{row.project_id}</option>)}
      </select></Field>
      {project && <Field label="Phiên dựng"><select className={inputCls} value={runId} disabled={busy || serving.loading} onChange={event => setParameters({ project_id: projectId, ...(event.target.value ? { run_id: event.target.value } : {}), tab })}>
        <option value="">Chọn phiên dựng</option>{runs.map(row => <option key={row.run_id} value={row.run_id}>{row.partial ? 'Một phần dữ liệu' : 'Toàn bộ dữ liệu'} · {row.nodes.toLocaleString('vi-VN')} nội dung · {row.run_id}</option>)}
      </select></Field>}
    </div>
    {projectId && !project && !catalog.loading && <p role="alert">Project đã bị xóa, mất quyền hoặc phiên OpenSPG hết hạn. Đăng nhập lại rồi tải lại danh sách.</p>}
    {project && <>
      {project.state === 'CONNECTION_NOT_CONFIGURED' && <p role="alert">Project chưa có kết nối nơi lưu graph. Kiểm cấu hình trong OpenSPG.</p>}
      <nav aria-label="Công việc với đồ thị" className="flex flex-wrap gap-2 border-b border-line pb-3 mb-5">
        {([['overview','Tổng quan'],['trial','Thử truy xuất'],['chat','Dùng cho Chat']] as const).map(([key,label]) => <Button key={key} disabled={busy} aria-current={tab === key ? 'page' : undefined} onClick={() => setParameters({ project_id: projectId, ...(runId ? { run_id: runId } : {}), tab: key })}>{label}</Button>)}
      </nav>
      <div hidden={tab !== 'overview'}>{project.state !== 'CONNECTION_NOT_CONFIGURED' && <SelectedGraph key={projectId} projectId={project.project_id} links={configuration.value?.links} />}</div>
      {!run && tab !== 'overview' && <p>Chọn phiên dựng hoàn tất để tiếp tục. {runs.length === 0 && <Link className="underline" to={`/admin/pipeline?project_id=${project.project_id}`}>Mở Builder</Link>}</p>}
      {run && <>
        <p className="my-4 text-sm">{run.partial ? 'Một phần dữ liệu' : 'Toàn bộ dữ liệu của phiên'} · {run.nodes.toLocaleString('vi-VN')} nội dung · {run.edges.toLocaleString('vi-VN')} quan hệ. {using && <strong>Đang dùng cho Chat.</strong>}</p>
        <div hidden={tab !== 'trial'}><TrialGraph key={`${projectId}-${runId}`} projectId={project.project_id} runId={runId} modelPath={modelPath} /></div>
        <div hidden={tab !== 'chat'} className="space-y-4 text-sm">
          <p>Chat dùng model phù hợp và bản nguồn đi cùng đồ thị. Không cần nhập lại nguồn vào Quản lý nội dung.</p>
          <p>Thử truy xuất là tùy chọn. Hệ thống kiểm tương thích trước khi bạn xác nhận.</p>
          {using && serving.value?.chat_blockers.map(code => <p key={code}>{servingReasons[code] ?? 'Chưa thể dùng Chat. Xem Chi tiết kỹ thuật.'}</p>)}
          <div className="flex flex-wrap items-center gap-4"><Button disabled={busy || serving.loading || serving.value?.busy} onClick={() => void change('preview')}>{busy ? 'Đang kiểm tương thích…' : 'Dùng cho Chat'}</Button><Link className="underline" to={modelPath}>Chỉnh model</Link>{using && <Link className="underline" to="/chat">Mở Chat</Link>}</div>
          <details><summary className="cursor-pointer underline">Chi tiết kỹ thuật</summary><p className="break-all mt-3">Phiên: {run.run_id} · namespace {run.namespace} · model {run.model_identity} · {run.dimension} chiều.</p><p>Mã điều kiện: {serving.value?.chat_blockers.join(', ') || 'Không có trong trạng thái đang đọc'}.</p></details>
        </div>
      </>}
    </>}
    {error && <p role="alert" className="mt-4">{error}</p>}{message && <p role="status" className="mt-4">{message} <Link className="underline" to="/chat">Mở Chat</Link></p>}
    {preview && <Modal open title="Dùng đồ thị cho Chat" onClose={() => { if (!busy) setPreview(null) }}><div className="space-y-4 text-sm">
      <p>Chuyển từ <strong>{preview.previous?.project_name ?? 'chưa chọn'}</strong> sang <strong>{preview.project_name}</strong>.</p>
      <p>{preview.partial ? 'Một phần dữ liệu' : 'Toàn bộ dữ liệu của phiên'}: {preview.counts.nodes.toLocaleString('vi-VN')} nội dung, {preview.counts.edges.toLocaleString('vi-VN')} quan hệ.</p>
      <p>Chat: {preview.chat?.model ?? 'Chưa cấu hình'}. Embedding: {preview.embedding.model}.</p>
      {preview.chat_blockers.map(code => <p role="status" key={code}>{servingReasons[code] ?? 'Chưa thể áp dụng; xem Chi tiết kỹ thuật.'}</p>)}
      <p>Các câu hỏi mới dùng đồ thị này. Lịch sử giữ nguồn cũ. Thao tác không gọi model.</p>
      <details><summary className="underline cursor-pointer">Chi tiết kỹ thuật</summary><pre className="text-xs whitespace-pre-wrap break-all mt-2">{JSON.stringify(preview,null,2)}</pre></details>
      <div className="flex flex-wrap gap-4 items-center"><Button disabled={busy || !preview.chat_ready} onClick={() => void change('activate')}>{busy ? 'Đang áp dụng…' : 'Xác nhận dùng cho Chat'}</Button>{!preview.chat_ready && <Link className="underline" to={modelPath}>Chỉnh model</Link>}</div>
    </div></Modal>}
  </Page>
}

function TrialGraph({ projectId, runId, modelPath }: { projectId: number; runId: string; modelPath: string }) {
  const location = useLocation(), saved = location.state?.trialDraft
  const draft = saved?.projectId === projectId && saved?.runId === runId ? saved : undefined
  const [question,setQuestion] = useState(typeof draft?.question === 'string' ? draft.question.slice(0,4000) : ''), [topK,setTopK] = useState(Number.isInteger(draft?.topK) && draft.topK >= 1 && draft.topK <= 10 ? draft.topK : 5), [expand,setExpand] = useState(draft?.expand === true)
  const [result,setResult] = useState<GraphRetrieval>(), [busy,setBusy] = useState(false), [error,setError] = useState('')
  const pending=useRef(false)
  async function retrieve() {
    if(pending.current || !question.trim())return
    pending.current=true;setBusy(true);setError('');setResult(undefined)
    try {setResult(await runGraphRetrieval(projectId,runId,question,topK,expand))}
    catch(failure){setError(failure instanceof Error ? failure.message : 'Chưa thử được đồ thị. Kiểm model và kết nối.')}
    finally{pending.current=false;setBusy(false)}
  }
  return <section className="space-y-4 text-sm">
    <p>Tìm nguồn trong đồ thị đang xem; không tạo câu trả lời và không đổi đồ thị Chat. Gửi câu thử có thể tính phí Embedding.</p>
    <form className="space-y-4" onSubmit={event=>{event.preventDefault();void retrieve()}}>
      <Field label="Câu hỏi thử"><textarea className={inputCls} maxLength={4000} required rows={3} value={question} onChange={event=>setQuestion(event.target.value)} /></Field>
      <div className="flex flex-wrap gap-4 items-end"><Field label="Số kết quả nguồn"><input className={inputCls} type="number" min={1} max={10} value={topK} onChange={event=>setTopK(Number(event.target.value))}/></Field><label className="flex gap-2 items-center min-h-10"><input type="checkbox" checked={expand} onChange={event=>setExpand(event.target.checked)}/>Tìm thêm nội dung liên quan</label></div>
      <Button type="submit" disabled={busy || !question.trim() || !Number.isInteger(topK) || topK<1 || topK>10}>{busy?'Đang tìm nguồn…':'Thử truy xuất'}</Button>
    </form>
    {error && <p role="alert">{error}</p>}
    <Link className="underline inline-block" to={modelPath} state={{trialDraft:{projectId,runId,question,topK,expand}}}>Chỉnh model</Link>
    {result && <><p role="status">Tìm thấy {result.items.length} kết quả trong đồ thị đang chọn.</p>{result.items.map(item=><article key={`${item.entity_type}-${item.entity_id}`} className="border-t border-line py-4 space-y-3"><h3 className="font-semibold break-words">{item.doc_id} · {item.unit_id ?? item.sign_id ?? 'Văn bản'}</h3>{Object.entries(item.source_texts).map(([field,text])=><p key={field} className="whitespace-pre-wrap break-words">{text}</p>)}<details><summary className="underline cursor-pointer">Chi tiết kỹ thuật và quan hệ</summary><pre className="whitespace-pre-wrap break-all text-xs mt-3">{JSON.stringify(item,null,2)}</pre></details></article>)}</>}
  </section>
}

function SelectedGraph({ projectId, links }: { projectId: number; links: BuilderConfiguration['links'] }) {
  const load=useCallback((signal?:AbortSignal)=>loadGraphProject(projectId,signal),[projectId])
  const data=useInspection(load),value=data.value,neo4j=value && builderNeo4jLink(links,value.target.database)
  return <section className="space-y-4 text-sm"><Notice {...data} retry={data.reload}/>
    {value && <><h2 className="font-semibold text-lg break-words">{value.target.project_name}</h2><dl className="grid grid-cols-3 gap-3">{([['Nội dung',value.counts.nodes],['Quan hệ',value.counts.edges],['Vector',value.counts.vectors]] as const).map(([label,count])=><div key={label}><dt>{label}</dt><dd className="text-xl font-semibold">{count.toLocaleString('vi-VN')}</dd></div>)}</dl><p className="text-muted">Đọc từ nơi lưu lúc {new Date(value.measured_at).toLocaleString('vi-VN')}. Số liệu có thể thay đổi khi đang dựng.</p>
      <details><summary className="underline cursor-pointer">Chi tiết kỹ thuật</summary><div className="mt-3 space-y-3"><p className="break-all">Project #{value.target.project_id} · database {value.target.database} · namespace {value.target.namespace} · {value.database_id}</p>{neo4j && <a className="underline" target="_blank" rel="noreferrer" href={neo4j}>Mở Neo4j</a>}<pre className="whitespace-pre-wrap break-all text-xs">{JSON.stringify({labels:value.labels,relations:value.relations,indexes:value.indexes},null,2)}</pre></div></details></>}
    <Button disabled={data.loading} onClick={data.reload}>Tải lại số liệu</Button>
  </section>
}
