import { useState, useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'
import { Page,Button,Modal } from '../../admin/ui'
import { useData,Notice,inputClass } from './shared'
import { loadKagStatus, loadSampleInspection, runRetrieval, inspectionError, type KagCheck, type KagStatus, type Retrieval, type SampleInspection } from './kag-inspection'
export function Infrastructure() {
  const data=useData<Record<string,string>>('/admin/infrastructure'), [kag,setKag]=useState<KagStatus>(), [statusError,setStatusError]=useState(''), [statusBusy,setStatusBusy]=useState(true)
  const [message,setMessage]=useState(''), [topK,setTopK]=useState(3), [expand,setExpand]=useState(false), [result,setResult]=useState<Retrieval>(), [retrieveError,setRetrieveError]=useState(''), [busy,setBusy]=useState(false), pending=useRef(false)
  const [confirm,setConfirm]=useState(false), statusPending=useRef<AbortSignal|undefined>(undefined)
  const [elapsedMs,setElapsedMs]=useState<number>()
  const [sample,setSample]=useState<SampleInspection>(), [sampleError,setSampleError]=useState('')
  async function refreshStatus(signal?:AbortSignal) {
    if(statusPending.current&&!statusPending.current.aborted)return
    const requestSignal=signal??new AbortController().signal
    statusPending.current=requestSignal
    setStatusBusy(true); setStatusError(''); setKag(undefined); setSample(undefined); setSampleError('')
    try {
      const value=await loadKagStatus(requestSignal); if(!requestSignal.aborted)setKag(value)
      if(value.release.evidence?.release_kind==='SAMPLE') {
        try { const sampleValue=await loadSampleInspection(requestSignal); if(!requestSignal.aborted)setSample(sampleValue) }
        catch(error) { if(!requestSignal.aborted)setSampleError(inspectionError(error)) }
      }
    }
    catch(error) { if(!requestSignal.aborted)setStatusError(inspectionError(error)) }
    finally { if(statusPending.current===requestSignal)statusPending.current=undefined; if(!requestSignal.aborted)setStatusBusy(false) }
  }
  useEffect(()=>{const controller=new AbortController();void refreshStatus(controller.signal);return()=>controller.abort()},[])
  function refresh(){if(statusPending.current&&!statusPending.current.aborted||pending.current)return;data.reload();void refreshStatus()}
  async function retrieve(){
    if(pending.current)return
    pending.current=true;setConfirm(false);setBusy(true);setResult(undefined);setRetrieveError('');setElapsedMs(undefined)
    const started=performance.now()
    try{setResult(await runRetrieval(message,topK,expand))}
    catch(error){setRetrieveError(inspectionError(error))}
    finally{setElapsedMs(performance.now()-started);pending.current=false;setBusy(false)}
  }
  const checks:[keyof KagStatus,string][]=[['liveness','Kết nối API'],['retrievalReadiness','Khả năng truy xuất'],['queryReadiness','Điều kiện Chat']]
  const checkText=(check:KagCheck)=>check.httpStatus===504||check.code?.includes('TIMEOUT')?'Chưa kiểm tra xong':check.state==='ALIVE'?'Kết nối được':check.state==='READY'?'Đạt kiểm tra điều kiện':check.state==='NOT_CONFIGURED'?'Chưa cấu hình':check.state==='RELEASE_UNAVAILABLE'?'Chưa có dữ liệu phục vụ':check.state==='NOT_READY'?'Còn điều kiện cần xử lý':'Chưa khả dụng'
  return <Page title="Kết nối & chẩn đoán" subtitle="Kiểm kết nối dịch vụ và điều kiện dùng đồ thị hiện tại." actions={<Button disabled={data.loading||statusBusy||busy||confirm} onClick={refresh}>Kiểm tra lại</Button>}>
    <h2 className="font-semibold">Dịch vụ WebApp</h2><Notice {...data} empty={!!data.value&&!Object.keys(data.value).length} retry={data.reload}/>
    {Object.entries(data.value||{}).map(([name,state])=><div key={name} className="flex justify-between border-b border-line py-4"><p>{name}</p><p className={state==='UP'?'text-emerald-700':'text-red-700'}>{state==='UP'?'Kết nối được':'Chưa khả dụng'}</p></div>)}
    <h2 className="font-semibold mt-8">Trạng thái đồ thị phục vụ</h2>
    {statusBusy&&<p role="status" className="py-4 text-muted">Đang kiểm tra đồ thị…</p>}
    <Notice error={statusError} retry={()=>void refreshStatus()}/>
    {kag&&checks.map(([key,label])=>{const check=kag[key];return <section key={key} className="border-b border-line py-4"><div className="flex flex-wrap justify-between gap-3"><h3>{label}</h3><p className={check.state==='ALIVE'||check.state==='READY'?'text-emerald-700':'text-amber-800'}>{checkText(check)}</p></div>{(check.httpStatus===504||check.code?.includes('TIMEOUT'))&&<p className="text-sm text-muted mt-2">Chọn “Kiểm tra lại” để thử lại; chưa có kết luận về đồ thị hoặc model.</p>}</section>})}
    <p className="text-sm text-muted mt-4">Kết quả trên kiểm điều kiện dịch vụ. Chưa thử câu trả lời và trích dẫn thật.</p>
    <div className="flex flex-wrap gap-4 mt-3 text-sm"><Link className="underline" to="/admin/graph">Kiểm tra để dùng cho Chat</Link><Link className="underline" to="/admin/config">Cấu hình model</Link><Link className="underline" to="/chat">Hỏi luật</Link></div>
    {kag&&<details className="mt-4 text-sm"><summary className="cursor-pointer underline">Chi tiết kỹ thuật</summary><p className="mt-3 text-muted">Mục bản dữ liệu kiểm tệp cấu hình; không thay cho kiểm đồ thị hiện tại. Kiểm vector riêng có thể chỉ hỗ trợ dữ liệu mẫu.</p><pre className="mt-3 text-xs whitespace-pre-wrap break-words max-w-full">{JSON.stringify(kag,null,2)}</pre></details>}
    <details className="mt-8"><summary className="font-semibold underline cursor-pointer">Công cụ nâng cao: thử đồ thị Chat đang dùng</summary>
    <p className="text-sm mt-3">Để thử một đồ thị khác, mở <Link className="underline" to="/admin/graph">Đồ thị của tôi</Link>.</p>
    <p className="text-sm mt-3">Tìm nguồn liên quan bằng model Embedding; có thể phát sinh phí. Kết quả nguồn chưa phải câu trả lời luật.</p>
    <Notice error={sampleError}/>
    <form className="mt-4 space-y-4" onSubmit={e=>{e.preventDefault();if(!pending.current)setConfirm(true)}}>
      <label className="block text-sm">Nội dung truy xuất<textarea required maxLength={4000} rows={3} disabled={busy||confirm} value={message} onChange={e=>setMessage(e.target.value)} className={`${inputClass} mt-2`}/></label>
      <div className="flex flex-wrap items-end gap-4"><label className="text-sm min-w-0">Số kết quả nguồn (1–10)<input required type="number" min={1} max={10} step={1} disabled={busy||confirm} value={topK} onChange={e=>setTopK(Number(e.target.value))} className={`${inputClass} mt-2`}/></label><label className="text-sm"><input type="checkbox" disabled={busy||confirm} checked={expand} onChange={e=>setExpand(e.target.checked)}/> Tìm thêm nội dung liên quan</label><Button type="submit" disabled={busy||confirm||!message.trim()||!Number.isInteger(topK)||topK<1||topK>10}>{busy?'Đang truy xuất…':'Chạy thử truy xuất'}</Button></div>
      <p className="text-sm text-muted">Giới hạn số kết quả tìm kiếm; bật tìm thêm để lấy nội dung liên quan trong đồ thị.</p>
    </form>
    <Modal open={confirm} title="Xác nhận thử truy xuất" onClose={()=>{if(!pending.current)setConfirm(false)}} footer={<><Button onClick={()=>setConfirm(false)}>Hủy</Button><Button disabled={busy} onClick={()=>void retrieve()}>Xác nhận truy xuất</Button></>}><p className="text-sm">Thao tác gọi model Embedding và có thể phát sinh phí. Tiếp tục truy xuất nội dung vừa nhập?</p></Modal>
    {busy&&<p role="status" className="py-4 text-muted">Đang truy xuất nguồn…</p>}
    <Notice error={retrieveError}/>
    {retrieveError&&<p className="text-sm text-muted">Nội dung đã giữ lại. Chọn “Chạy thử truy xuất” để thử lại sau khi kiểm tra dịch vụ.</p>}
    {elapsedMs!==undefined&&<details className="mt-3 text-sm"><summary className="cursor-pointer underline">Chi tiết kỹ thuật lượt truy xuất</summary><p className="mt-3">Thời gian qua backend: {elapsedMs.toFixed(1)} ms; không phải thời gian riêng của Neo4j.</p>{result&&<pre className="mt-3 text-xs whitespace-pre-wrap break-words">{JSON.stringify({request_id:result.request_id,release_id:result.release_id,source_snapshot_id:result.source_snapshot_id,schema_contract:result.schema_contract},null,2)}</pre>}</details>}
    {result&&<section className="mt-5 min-w-0" aria-live="polite"><p className="text-sm">{result.items.length} kết quả nguồn.</p>{!result.items.length&&<p>Không tìm được nguồn phù hợp. Không đủ căn cứ để trả lời.</p>}{result.items.map((item,i)=>{
      const node=sample?.release_id===result.release_id&&sample.source_snapshot_id===result.source_snapshot_id?sample.nodes.find(n=>n.entity_type===item.entity_type&&n.entity_id===item.entity_id):undefined
      const doc=sample?.nodes.find(n=>n.entity_type==='VietRoadTraffic.LegalDocument'&&n.entity_id===item.doc_id)
      return <article key={i} className="py-4 border-b border-line text-sm space-y-2 min-w-0"><h3 className="font-semibold break-words">{doc?String(doc.properties.title??item.doc_id):item.doc_id??item.entity_id}</h3><p className="break-words">Đơn vị: {item.unit_id??item.sign_id??'Không có'}</p>{Object.entries(item.source_texts).map(([field,text])=><details key={field}><summary className="cursor-pointer underline">Nội dung nguồn: {field}</summary><blockquote className="mt-2 whitespace-pre-wrap break-words border-l border-line pl-3">{text??'Không có'}</blockquote></details>)}<details><summary className="cursor-pointer underline">Chi tiết kỹ thuật nguồn</summary><p className="mt-2 break-words">{item.entity_type} · {item.entity_id} · Điểm tương đồng: {item.score??'Không có'}</p>{node?node.sources.map(s=><p key={s.evidence_id} className="text-xs break-all">Evidence {s.field}: {s.evidence_id} · source SHA-256 {s.source_sha256}</p>):<p>Nguồn được API kiểm theo bản dữ liệu của lượt truy xuất; trang này không tải lại toàn bộ danh sách nguồn.</p>}<pre className="mt-2 text-xs whitespace-pre-wrap break-words">{JSON.stringify({vector_sources:item.vector_sources,graph_context:item.graph_context},null,2)}</pre></details></article>
    })}</section>}</details>
  </Page>
}
