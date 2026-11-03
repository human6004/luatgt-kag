import { useCallback } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Button, Field, Page, inputCls } from '../admin/ui'
import { Notice } from './server/shared'
import { useInspection } from './server/KagManagement'
import { loadDataset } from './server/kag-inspection'

const groups: Record<string,string>={documents:'Văn bản',units:'Đơn vị pháp lý',signs:'Biển báo',penalties:'Mức xử phạt',relations:'Quan hệ văn bản',xrefs:'Dẫn chiếu'}
export default function AdminSources() {
  const [parameters,setParameters]=useSearchParams()
  const requested=parameters.get('group') ?? 'documents',group=Object.prototype.hasOwnProperty.call(groups,requested)?requested:'documents'
  const rawPage=Number(parameters.get('page') ?? '0'),page=Number.isSafeInteger(rawPage)&&rawPage>=0&&rawPage<=85899345?rawPage:0
  const load=useCallback((signal?:AbortSignal)=>loadDataset(group,page*25,signal),[group,page]),data=useInspection(load),value=data.value
  function select(nextGroup:string,nextPage=0){setParameters({group:nextGroup,...(nextPage?{page:String(nextPage)}:{})})}
  return <Page title="Dữ liệu nguồn" subtitle="Bộ dữ liệu LuậtGT đi kèm ứng dụng. Xem nội dung và cấu trúc trước khi dựng đồ thị."
    actions={<div className="flex flex-wrap gap-3 items-center"><Button disabled={data.loading} onClick={data.reload}>Tải lại</Button><Link className="underline text-sm" to="/admin/graph">Đồ thị của tôi</Link></div>}>
    <p className="text-sm mb-5">Đây là nguồn đã chuẩn bị cho Builder. Nguồn dùng trong Chat được giữ theo phiên dựng; cập nhật bộ dữ liệu này không thay nguồn của câu trả lời cũ.</p>
    <nav className="flex flex-wrap gap-4 text-sm mb-5"><Link className="underline" to="/admin/schema">Xem schema và quan hệ đồ thị</Link><Link className="underline" to="/admin/pipeline">Dựng đồ thị từ nguồn này</Link></nav>
    <div className="max-w-sm mb-5"><Field label="Loại dữ liệu"><select className={inputCls} value={group} onChange={event=>select(event.target.value)}>{Object.entries(groups).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></Field></div>
    <Notice {...data} retry={data.reload}/>
    {value && <div className="space-y-4 text-sm"><p>{groups[group]}: {value.total.toLocaleString('vi-VN')} bản ghi. Trang {page+1}/{Math.max(1,Math.ceil(value.total/25))}.</p>
      {value.items.length===0 && <p>Không có bản ghi ở trang này.</p>}
      {value.items.map((row,index)=>{
        const from=row.from_unit_id ?? row.from_so_hieu ?? row.from_doc_id,to=row.to_unit_id ?? row.to_so_hieu ?? row.to_doc_id
        const id=String(row.sign_id ?? row.penalty_id ?? row.unit_id ?? row.doc_id ?? (from ? `${from} → ${to ?? 'Chưa xác định'}` : page*25+index+1))
        const title=String(row.title ?? row.ten ?? row.name ?? row.dieu_title ?? row.unit_type ?? row.rel_type ?? row.type ?? '')
        const text=row.text ?? row.mo_ta ?? row.moTa ?? row.hanh_vi ?? row.evidence ?? row.quote ?? row.context
        const url=row.source_url ?? row.url
        return <article key={`${id}-${index}`} className="border-t border-line py-4 space-y-3"><h2 className="font-semibold break-words">{id}{title ? ` · ${title}` : ''}</h2>
          {typeof text==='string' && <details><summary className="underline cursor-pointer">Xem nội dung</summary><p className="mt-3 whitespace-pre-wrap break-words">{text}</p></details>}
          {typeof url==='string' && /^https?:\/\//.test(url) && <a className="underline inline-block" href={url} target="_blank" rel="noreferrer">Mở nguồn gốc</a>}
          <details><summary className="underline cursor-pointer">Thông tin nguồn</summary><dl className="mt-3 space-y-2">{Object.entries(row).filter(([key])=>!['text','mo_ta','moTa'].includes(key)).map(([key,item])=><div key={key} className="break-words"><dt className="text-muted">{key}</dt><dd>{typeof item==='object'?JSON.stringify(item):String(item??'Chưa có')}</dd></div>)}</dl></details>
        </article>
      })}
      <div className="flex flex-wrap gap-3"><Button disabled={data.loading || page===0} onClick={()=>select(group,page-1)}>Trang trước</Button><Button disabled={data.loading || (page+1)*25>=value.total} onClick={()=>select(group,page+1)}>Trang sau</Button></div>
      <details><summary className="underline cursor-pointer">Chi tiết kỹ thuật</summary><p className="mt-3 break-all">{value.dataset} · {value.source}. Số liệu đọc từ tệp nguồn, không phải số liệu graph.</p></details>
    </div>}
  </Page>
}
