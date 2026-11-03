import { api,send,type ContentRecord } from '../api'
import { Asset,Notice,useData,useTask } from './server/shared'
import { useMemo, useState } from 'react'
import { useAdmin, type QBankItem } from '../admin/store'
import { Badge, Button, Card, Field, Modal, NavLinkButton, Page, Td, Th, Toggle, inputCls } from '../admin/ui'
import { type QuestionSet } from './server/QuestionBankSettings'

const chapters = ['Khái niệm và quy tắc', 'Văn hoá giao thông', 'Kỹ thuật lái xe', 'Cấu tạo sửa chữa', 'Biển báo đường bộ', 'Sa hình']
const blank = (): QBankItem => ({ id: '', chapter: chapters[0], question: '', options: ['', '', ''], answer: 0, critical: false, explanation: '', source: '' })

export default function AdminQuestions() {
  const {notify}=useAdmin(),task=useTask(),data=useData<ContentRecord[]>('/admin/questions')
  const [demoQuestions,setQbank]=useState<QBankItem[]>([])
  const qbank:QBankItem[]=[...(data.value||[]).map(r=>({id:r.id,chapter:chapters[Number(r.data.chapter)-1]||String(r.data.chapter),question:String(r.data.text||''),options:r.data.options as string[],answer:Number(r.data.correctAnswer),critical:r.data.critical===true,explanation:String(r.data.explanation||''),source:String(r.data.source||'')})),...demoQuestions]
  const sets=useData<QuestionSet[]>('/admin/questions/sets')
  const [questionSetId,setQuestionSetId]=useState('')
  const [externalId,setExternalId]=useState(''),[reviewed,setReviewed]=useState(false),[imageRequired,setImageRequired]=useState(false)
  const [history,setHistory]=useState<unknown>(),[checked,setChecked]=useState<Set<string>>(new Set())
  function edit(x:QBankItem){task.clearError();const r=data.value?.find(r=>r.id===x.id);setQuestionSetId(String(r?.data.questionSetId||''));setExternalId(String(r?.data.sourceExternalId||r?.externalId||''));setReviewed(r?.data.reviewed===true);setImageRequired(r?.data.imageRequired===true);setHistory(undefined);setEditing({...x,options:[...x.options]})}

  const [q, setQ] = useState('')
  const [chapter, setChapter] = useState('all')
  const [onlyCritical, setOnlyCritical] = useState(false)
  const [editing, setEditing] = useState<QBankItem | null>(null)
  const [generating, setGenerating] = useState(false)
  const record=data.value?.find(r=>r.id===editing?.id)

  const shown = useMemo(
    () => qbank.filter((x) => (chapter === 'all' || x.chapter === chapter) && (!onlyCritical || x.critical) && x.question.toLowerCase().includes(q.toLowerCase())),
    [qbank, chapter, onlyCritical, q]
  )

  function save() {
    if(!editing||task.busy||!editing.question.trim())return
    if(!record&&!questionSetId){notify('Chọn bộ câu hỏi trước khi thêm câu mới');return}
    if(editing.id.startsWith('g')){setQbank(xs=>xs.map(x=>x.id===editing.id?editing:x));setEditing(null);notify('Demo: đã sửa câu hỏi mẫu');return}
    void task.run(async()=>{
      const payload={...record?.data,...(questionSetId?{questionSetId}:{}),externalId:record?.externalId||externalId,text:editing.question,chapter:chapters.indexOf(editing.chapter)+1,options:editing.options,correctAnswer:editing.answer,critical:editing.critical,source:editing.source,explanation:editing.explanation,reviewed,imageRequired}
      if(record)await api(`/admin/content/${record.id}`,send('PUT',{version:record.version,data:payload}))
      else await api('/admin/imports/questions/confirm',send('POST',{rows:[payload],updateExisting:false,questionSetId}))
      data.reload();setEditing(null);notify('Đã lưu bản nháp; chưa xuất bản')
    })
  }
  function publish(id:string,published:boolean){const r=data.value?.find(r=>r.id===id);if(!r)return;void task.run(async()=>{await api(`/admin/content/${id}/publication`,send('POST',{version:r.version,published}));data.reload();notify('Đã cập nhật xuất bản')})}
  function generate() {
    setGenerating(true)
    window.setTimeout(() => {
      const gen: QBankItem[] = [
        { id: 'g' + Date.now(), chapter: 'Khái niệm và quy tắc', question: 'Xe mô tô vượt đèn đỏ bị trừ bao nhiêu điểm GPLX?', options: ['2 điểm', '4 điểm', '6 điểm'], answer: 1, critical: false, explanation: 'Sinh tự động từ NĐ 168/2024, Điều 7.', source: 'NĐ 168/2024 (KAG)' },
        { id: 'g' + Date.now() + 1, chapter: 'Khái niệm và quy tắc', question: 'Hành vi điều khiển xe khi có nồng độ cồn bị xử lý thế nào?', options: ['Nhắc nhở', 'Phạt tiền và tước GPLX', 'Chỉ phạt tiền'], answer: 1, critical: true, explanation: 'Sinh tự động từ đồ thị tri thức.', source: 'NĐ 168/2024 (KAG)' },
      ]
      setQbank((xs) => [...gen, ...xs])
      setGenerating(false)
      notify('Demo: sinh 2 câu hỏi mẫu; không gọi KAG hoặc lưu backend')
    }, 1400)
  }

  function exportJson() {
    const blob = new Blob([JSON.stringify((data.value||[]).map(r=>({...r.data,id:r.externalId,externalId:r.externalId})), null, 2)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = 'ngan-hang-cau-hoi.json'
    a.click()
    URL.revokeObjectURL(a.href)
    notify('Đã xuất câu hỏi server; câu Demo không nằm trong tệp nhập lại')
  }

  return (
    <Page
      title="Ngân hàng câu hỏi"
      subtitle={`${data.value?qbank.length:'—'} câu · ${data.value?qbank.filter((x) => x.critical).length:'—'} câu điểm liệt`}
      actions={
        <>
          <NavLinkButton to="/admin/imports?type=questions">Nhập hàng loạt</NavLinkButton><Button onClick={exportJson}>Xuất JSON</Button>
          <Button onClick={generate} disabled={generating}>{generating ? 'Đang sinh…' : '✻ Sinh câu hỏi từ KAG · Demo'}</Button>
          <Button variant="primary" onClick={() => {sets.reload();edit(blank());setExternalId('')}}>+ Thêm câu hỏi</Button>
        </>
      }
    >
      <Notice {...data} retry={data.reload}/><Notice error={task.error}/><p className="mb-4 text-xs text-muted">Danh sách, thêm/sửa, ảnh và xuất bản dùng API thật. Sinh và xóa câu hỏi: Demo, không xóa bản ghi server.</p>
      <div className="mb-4 space-y-3">
        <input aria-label="Tìm câu hỏi" className={`${inputCls} w-full`} placeholder="Tìm câu hỏi…" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="flex flex-wrap items-center gap-3">
          <select className={`${inputCls} w-full max-w-[220px]`} value={chapter} onChange={(e) => setChapter(e.target.value)} aria-label="Chương">
            <option value="all">Tất cả chương</option>
            {chapters.map((c) => <option key={c}>{c}</option>)}
          </select>
          <label className="flex items-center gap-2 text-[13px] text-text-secondary">
            <Toggle checked={onlyCritical} onChange={setOnlyCritical} label="Chỉ câu điểm liệt" /> Chỉ câu điểm liệt
          </label>
        </div>
      </div>

      <Card className="overflow-x-auto">
        <table className="w-full min-w-[720px]">
          <thead className="border-b border-line">
            <tr><Th className="w-12">#</Th><Th>Câu hỏi</Th><Th>Chương</Th><Th>Nguồn</Th><Th className="text-right">Thao tác</Th></tr>
          </thead>
          <tbody>
            {shown.map((x, i) => (
              <tr key={x.id} className="border-b border-line/60 last:border-0 hover:bg-bg">
                <Td className="text-muted font-mono text-xs">{i + 1}</Td>
                <Td className="text-navy">
                  <label className="flex items-start gap-2">{data.value?.some(r=>r.id===x.id)&&<input type="checkbox" checked={checked.has(x.id)} onChange={()=>setChecked(p=>{const n=new Set(p);n.has(x.id)?n.delete(x.id):n.add(x.id);return n})}/>}<span className="font-medium">{x.question}{x.id.startsWith('g')&&' · Demo'}</span></label>
                  {x.critical && <span className="ml-2"><Badge tone="red">Điểm liệt</Badge></span>}
                  <span className="block mt-0.5 text-[12px] text-muted">Đáp án: {x.options[x.answer]}</span>
                </Td>
                <Td className="text-muted whitespace-nowrap">{x.chapter}</Td>
                <Td className="text-muted">{x.source}</Td>
                <Td className="text-right whitespace-nowrap">
                  {data.value?.some(r=>r.id===x.id)&&<Button size="sm" disabled={task.busy} onClick={()=>publish(x.id,!data.value?.find(r=>r.id===x.id)?.published)}>{data.value?.find(r=>r.id===x.id)?.published?'Hủy xuất bản':'Xuất bản'}</Button>}
                  <Button size="sm" variant="ghost" onClick={() => edit(x)}>Sửa</Button>
                  <Button size="sm" variant="danger" onClick={() => { setQbank(xs=>xs.filter(y=>y.id!==x.id));notify('Demo: chỉ xóa câu hỏi sinh mẫu; không xóa câu hỏi server') }}>Xoá · Demo</Button>
                </Td>
              </tr>
            ))}
            {!shown.length && <tr><td colSpan={5} className="px-4 py-8 text-center text-sm text-muted">Không có câu hỏi phù hợp.</td></tr>}
          </tbody>
        </table>
      </Card>

      <div className="mt-4 flex flex-wrap gap-3"><Button disabled={task.busy||!checked.size} onClick={()=>void task.run(async()=>{await api('/admin/questions/publication-batch',send('POST',{rows:(data.value||[]).filter(r=>checked.has(r.id)).map(r=>({id:r.id,version:r.version})),reviewed:true,published:true}));setChecked(new Set());data.reload()})}>Duyệt và xuất bản các câu đã chọn</Button></div>
      <Modal
        open={!!editing}
        title={editing?.id ? 'Sửa câu hỏi' : 'Thêm câu hỏi'}
        onClose={() => setEditing(null)}
        footer={<><Button variant="ghost" onClick={() => setEditing(null)}>Huỷ</Button><Button variant="primary" onClick={save} disabled={task.busy||!editing?.question.trim()}>Lưu</Button></>}
      >
        <Notice error={task.error}/>
        {editing && (
          <div className="space-y-4">
            {!editing.id.startsWith('g')&&<Field label="Bộ câu hỏi"><select className={inputCls} aria-label="Bộ câu hỏi" value={questionSetId} onChange={e=>setQuestionSetId(e.target.value)}><option value="">Ngân hàng hiện có</option>{sets.value?.map(s=><option key={s.set_id} value={s.set_id}>{s.set_name}</option>)}</select></Field>}
          {!editing.id.startsWith('g')&&<Field label="Mã định danh nguồn"><input className={inputCls} readOnly={!!record?.data.sourceExternalId} value={externalId} onChange={e=>setExternalId(e.target.value)} /></Field>}
            <Field label="Nội dung câu hỏi">
              <textarea rows={2} className={inputCls} value={editing.question} onChange={(e) => setEditing({ ...editing, question: e.target.value })} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Chương">
                <select className={inputCls} value={editing.chapter} onChange={(e) => setEditing({ ...editing, chapter: e.target.value })}>
                  {chapters.map((c) => <option key={c}>{c}</option>)}
                </select>
              </Field>
              <Field label="Căn cứ">
                <input className={inputCls} value={editing.source} onChange={(e) => setEditing({ ...editing, source: e.target.value })} placeholder="NĐ 168/2024…" />
              </Field>
            </div>
            <div>
              <span className="block text-xs font-medium text-text-secondary mb-1.5">Phương án (chọn đáp án đúng)</span>
              <div className="space-y-2">
                {editing.options.map((o, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <input type="radio" name="ans" checked={editing.answer === i} onChange={() => setEditing({ ...editing, answer: i })} className="accent-[var(--color-accent-strong)]" aria-label={`Đáp án ${i + 1}`} />
                    <input className={inputCls} value={o} placeholder={`Phương án ${i + 1}`} onChange={(e) => setEditing({ ...editing, options: editing.options.map((v, k) => (k === i ? e.target.value : v)) })} />
                    {editing.options.length > 2 && (
                      <button className="text-muted hover:text-red-600 px-1" aria-label="Xoá phương án" onClick={() => setEditing({ ...editing, options: editing.options.filter((_, k) => k !== i), answer: 0 })}>✕</button>
                    )}
                  </div>
                ))}
              </div>
              {editing.options.length < 4 && (
                <button className="mt-2 text-xs font-medium text-accent-strong" onClick={() => setEditing({ ...editing, options: [...editing.options, ''] })}>+ Thêm phương án</button>
              )}
            </div>
            {!editing.id.startsWith('g')&&<><label className="block text-sm"><input type="checkbox" checked={reviewed} onChange={e=>setReviewed(e.target.checked)}/> Đã kiểm duyệt đáp án và nguồn</label><label className="block text-sm"><input type="checkbox" checked={imageRequired} onChange={e=>setImageRequired(e.target.checked)}/> Câu hỏi yêu cầu ảnh</label>{record&&<><p className="text-xs">{record.published?'Đã xuất bản':'Bản nháp'} · Version {record.version}</p>{!!record.data.imageKey&&<Asset id={record.id} path={`/admin/content/${record.id}/media`} alt="Ảnh câu hỏi"/>}<Field label="Ảnh nguồn"><input type="file" accept=".png,.jpg,.jpeg" disabled={task.busy} onChange={e=>{const file=e.target.files?.[0];if(!file)return;void task.run(async()=>{const body=new FormData();body.append('file',file);await api(`/admin/content/${record.id}/media`,{method:'POST',body});data.reload()})}}/></Field><Button disabled={task.busy} onClick={()=>void task.run(async()=>setHistory(await api(`/admin/content/${record.id}/history`)))}>Lịch sử chỉnh sửa</Button>{history!==undefined&&<pre className="text-xs whitespace-pre-wrap break-all">{JSON.stringify(history,null,2)}</pre>}</>}</>}
            <Field label="Giải thích">
              <textarea rows={2} className={inputCls} value={editing.explanation} onChange={(e) => setEditing({ ...editing, explanation: e.target.value })} />
            </Field>
            <label className="flex items-center gap-2 text-[13px] text-navy">
              <Toggle checked={editing.critical} onChange={(v) => setEditing({ ...editing, critical: v })} label="Câu điểm liệt" /> Câu điểm liệt
            </label>
          </div>
        )}
      </Modal>
    </Page>
  )
}
