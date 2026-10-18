import { Notice } from './server/shared'
import { BuilderGraph, useInspection } from './server/KagManagement'
import { useSearchParams } from 'react-router-dom'
import { loadSampleInspection } from './server/kag-inspection'
import { useMemo, useState } from 'react'
import { useAdmin } from '../admin/store'
import { Badge, Button, Card, Page, Progress, Terminal, inputCls } from '../admin/ui'

/* Fingerprint & schema mirror docs/HANDOFF.md of kag-legal-assistant */
const namespaces = [
  { id: 'legalfinalcand', ns: 'LegalFinalCand', project: 4, nodes: 15888, rels: 32655, note: 'Final candidate' },
  { id: 'legalfullcand', ns: 'LegalFullCand', project: 3, nodes: 14061, rels: 29376, note: 'Full candidate' },
  { id: 'legal', ns: 'Legal', project: 1, nodes: 7624, rels: 26029, note: 'Production cũ' },
  { id: 'legalc3test', ns: 'LegalC3Test', project: 2, nodes: 93, rels: 245, note: 'Thử nghiệm' },
]
const reference = { nodes: 15888, rels: 32655, chunks: 1795, docs: 23 }

const demoLabels: [string, number][] = [
  ['Obligation', 3861], ['LegalTerm', 3417], ['RegulatedEntity', 2132], ['Chunk', 1795], ['Article', 1349],
  ['Authority', 1342], ['ProhibitedAct', 983], ['Sanction', 588], ['LegalDocument', 336], ['Others', 85],
]
const demoRelations: [string, number][] = [
  ['source', 18480], ['basedOn', 3306], ['obliges', 2779], ['boundEntity', 1519], ['forAct', 1412], ['belongsTo', 1286],
  ['appliesTo', 894], ['prohibits', 874], ['imposes', 542], ['defines', 382], ['definedIn', 295], ['enforcedBy', 254],
  ['OfficialName', 206], ['amends', 168], ['prohibitedBy', 130], ['sanctionedBy', 84], ['implementsDoc', 30], ['supersedes', 7], ['supersededBy', 7],
]

const demoNodes = [
  { id: 'article:168-2024-ND-CP:7', label: 'Article', name: 'Điều 7. Xử phạt người điều khiển xe mô tô, xe gắn máy', edges: [['belongsTo', 'LegalDocument', 'Nghị định 168/2024/NĐ-CP'], ['source', 'Chunk', 'chunk e192bb…'], ['imposes', 'Sanction', 'Phạt tiền 4–6 triệu đồng'], ['prohibits', 'ProhibitedAct', 'Không chấp hành hiệu lệnh đèn tín hiệu']] },
  { id: 'doc:168-2024-ND-CP', label: 'LegalDocument', name: 'Nghị định 168/2024/NĐ-CP', edges: [['supersedes', 'LegalDocument', 'Nghị định 100/2019/NĐ-CP'], ['basedOn', 'LegalDocument', 'Luật TTATGT đường bộ 2024'], ['OfficialName', 'LegalTerm', 'Nghị định quy định xử phạt VPHC về TTATGT']] },
  { id: 'sanction:tru-diem-gplx', label: 'Sanction', name: 'Trừ điểm giấy phép lái xe', edges: [['sanctionedBy', 'Article', 'Điều 7 Khoản 13'], ['appliesTo', 'RegulatedEntity', 'Người điều khiển xe mô tô'], ['enforcedBy', 'Authority', 'Cảnh sát giao thông']] },
]

function Bars({ data, unit }: { data: [string, number][]; unit: string }) {
  const max = Math.max(...data.map((d) => d[1]))
  return (
    <ul className="space-y-1.5" role="list">
      {data.map(([k, v]) => (
        <li key={k} className="group grid grid-cols-[120px_minmax(0,1fr)_56px] items-center gap-3" title={`${k}: ${v.toLocaleString('vi-VN')} ${unit}`}>
          <span className="truncate font-mono text-[11.5px] text-text-secondary">{k}</span>
          <span className="h-3.5 rounded-r bg-line/40">
            <span className="block h-full rounded-r bg-accent group-hover:bg-accent-strong transition-colors" style={{ width: `${Math.max((v / max) * 100, 0.6)}%` }} />
          </span>
          <span className="text-right text-[12px] tabular-nums text-navy">{v.toLocaleString('vi-VN')}</span>
        </li>
      ))}
    </ul>
  )
}

export default function AdminGraph() {
  const [parameters] = useSearchParams()
  const runId = parameters.get('run_id')
  return runId !== null ? <BuilderGraph runId={runId} /> : <GraphOverview />
}

function GraphOverview() {
  const { runTask, notify, jobs } = useAdmin()
  const data=useInspection(loadSampleInspection), sample=data.value
  const [nsId, setNsId] = useState('live')
  const live=nsId==='live'
  const [verified, setVerified] = useState<null | 'run' | 'ok'>(null)
  const [search, setSearch] = useState('')
  const [nodeId, setNodeId] = useState('')
  const [cypher, setCypher] = useState("MATCH (a:`LegalFinalCand.Article`)-[:belongsTo]->(d) RETURN d.name, count(a) ORDER BY count(a) DESC LIMIT 5")
  const [cypherOut, setCypherOut] = useState<string[]>([])
  const [restoreFile, setRestoreFile] = useState<string | null>(null)
  const [shaOk, setShaOk] = useState<boolean | null>(null)
  const ns = live ? {id:sample?.backend.database||'Chưa đọc được backend',ns:sample?.backend.namespace||'VietRoadTraffic',nodes:sample?.counts.nodes??0,rels:sample?.counts.edges??0,note:'Graph SAMPLE thật · chỉ đọc'} : namespaces.find(n=>n.id===nsId)!
  const summarize=(values:string[]):[string,number][]=>Object.entries(values.reduce<Record<string,number>>((acc,k)=>({...acc,[k]:(acc[k]||0)+1}),{}))
  const labels=live?summarize(sample?.nodes.map(n=>n.entity_type)||[]):demoLabels
  const relations=live?summarize(sample?.edges.map(e=>e.predicate)||[]):demoRelations
  const sampleNodes=live?(sample?.nodes.map(n=>({id:JSON.stringify([n.entity_type,n.entity_id]),label:n.entity_type,name:String(n.properties.title||n.properties.ten||n.entity_id),edges:sample.edges.filter(e=>JSON.stringify(e.from)===JSON.stringify([n.entity_type,n.entity_id])||JSON.stringify(e.to)===JSON.stringify([n.entity_type,n.entity_id])).map(e=>{const other=JSON.stringify(e.from)===JSON.stringify([n.entity_type,n.entity_id])?e.to:e.from;return [e.predicate,other[0],other[1]]})}))||[]):demoNodes
  const node=sampleNodes.find(n=>n.id===nodeId)||sampleNodes[0]
  const sourceNode=live?sample?.nodes.find(n=>JSON.stringify([n.entity_type,n.entity_id])===node?.id):undefined
  const found=sampleNodes.filter(n=>(n.id+n.name).toLowerCase().includes(search.toLowerCase()))
  const busy=(t:string)=>jobs.some(j=>j.taskId===t&&j.status==='running')
  const fp=live?[{k:'Nodes',v:sample?.counts.nodes,ref:0},{k:'Relations',v:sample?.counts.edges,ref:0},{k:'Vectors',v:sample?.counts.vectors,ref:0},{k:'Văn bản',v:sample?.nodes.filter(n=>n.entity_type.endsWith('.LegalDocument')).length,ref:0}]:[
    {k:'Nodes',v:ns.nodes,ref:reference.nodes},{k:'Relations',v:ns.rels,ref:reference.rels},{k:'Chunks',v:ns.id==='legalfinalcand'?1795:Math.round(ns.nodes*.11),ref:reference.chunks},{k:'Văn bản',v:ns.id==='legalfinalcand'?23:ns.id==='legalc3test'?2:21,ref:reference.docs},
  ]

  return (
    <Page
      title="Đồ thị tri thức"
      subtitle="Fingerprint, schema, tra cứu nút và sao lưu / khôi phục graph Neo4j của OpenSPG."
      actions={
        <select className={`${inputCls} w-auto`} value={nsId} onChange={(e) => { setNsId(e.target.value); setVerified(null); setNodeId('') }} aria-label="Namespace">
          <option value="live">VietRoadTraffic · SAMPLE thật</option>
          {namespaces.map((n) => <option key={n.id} value={n.id}>{n.ns} · project {n.project} · Demo</option>)}
        </select>
      }
    >
      {live?<Notice {...data} retry={data.reload}/>:<p className="mb-5 text-sm text-muted">Demo namespace · dữ liệu mẫu, không truy cập graph này.</p>}
      <Card className="p-5 mb-5">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted">Fingerprint · database {ns.id}</p>
            <p className="text-[13px] text-text-secondary mt-0.5">{ns.note} {live ? (sample?"· fingerprint xác minh bởi backend":"· chưa xác minh fingerprint") : "· Demo so với số liệu mẫu"}</p>
          </div>
          <div className="flex items-center gap-2">
            {live && sample && <Badge tone="green">Fingerprint SAMPLE đã đọc</Badge>}
            {!live && verified === 'ok' && (fp.every((f) => f.v === f.ref) ? <Badge tone="green">Khớp fingerprint</Badge> : <Badge tone="amber">Lệch fingerprint</Badge>)}
            <Button size="sm" variant="dark" disabled={live?data.loading:verified==='run'} onClick={() => {if(live){data.reload();return}setVerified('run');window.setTimeout(()=>setVerified('ok'),1200)}}>
              {verified === 'run' ? 'Đang đếm…' : 'Xác minh fingerprint'}
            </Button>
          </div>
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {fp.map((f) => (
            <div key={f.k} className="rounded-xl border border-line bg-bg px-4 py-3">
              <p className="text-xs text-muted">{f.k}</p>
              <p className="text-2xl font-semibold tabular-nums text-navy">{f.v?.toLocaleString('vi-VN')??'—'}</p>
              {!live && verified === 'ok' && (
                <p className={`text-[11.5px] ${f.v === f.ref ? 'text-emerald-700' : 'text-amber-700'}`}>
                  {f.v === f.ref ? '✓ khớp chuẩn' : `chuẩn ${f.ref.toLocaleString('vi-VN')}`}
                </p>
              )}
            </div>
          ))}
        </div>
      </Card>

      {live&&sample&&<details className="mb-5 text-xs break-all"><summary>Danh tính và nguồn graph SAMPLE</summary><p>Database ID: {sample.backend.database_id} · Server ID: {sample.backend.server_id}</p><p>Fingerprint: {sample.graph_fingerprint}</p><p>Release: {sample.release_id} · {sample.verified_at}</p></details>}
      <div className="grid gap-5 lg:grid-cols-2 mb-5">
        <Card title="Số nút theo nhãn" right={<span className="text-[11.5px] text-muted">{live&&!sample?'—':labels.length} nhãn</span>}>
          <div className="px-5 pb-5"><Bars data={labels} unit="nút" /></div>
        </Card>
        <Card title="Số cạnh theo quan hệ" right={<span className="text-[11.5px] text-muted">{live&&!sample?'—':relations.length} loại</span>}>
          <div className="px-5 pb-5 max-h-[360px] overflow-y-auto"><Bars data={relations} unit="cạnh" /></div>
        </Card>
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] mb-5">
        <Card title="Tra cứu nút">
          <div className="px-5 pb-5">
            <input className={inputCls} placeholder="Tìm id hoặc tên nút, VD: article:168-2024-ND-CP:7" value={search} onChange={(e) => setSearch(e.target.value)} />
            <div className="mt-2 flex flex-wrap gap-1.5">
              {found.map((n) => (
                <button key={n.id} onClick={() => setNodeId(n.id)} className={`rounded-full border px-2.5 py-1 font-mono text-[11px] transition-colors ${n.id === nodeId ? 'border-accent bg-selected text-accent-strong' : 'border-line text-text-secondary hover:bg-selected'}`}>
                  {n.id}
                </button>
              ))}
            </div>
            {node ? <div className="mt-4 rounded-xl border border-line bg-bg p-4">
              <div className="flex items-center gap-2"><Badge tone="gold">{node.label}</Badge><span className="font-mono text-[11px] text-muted">{node.id}</span></div>
              <p className="mt-2 text-[14px] font-semibold text-navy">{node.name}</p>
              {sourceNode&&<div className="mt-3 text-xs"><dl>{Object.entries(sourceNode.properties).map(([k,v])=><div key={k} className="py-1 break-words"><dt>{k}</dt><dd className="whitespace-pre-wrap">{typeof v==='string'?v:JSON.stringify(v)}</dd></div>)}</dl><h3 className="font-semibold mt-2">Nguồn đã xác minh</h3>{sourceNode.sources.map(s=><details key={s.evidence_id} className="mt-2 break-all"><summary>{s.field} · Evidence {s.evidence_id}</summary><p>SHA-256 nguồn: {s.source_sha256}</p></details>)}</div>}
              <ul className="mt-3 space-y-2">
                {node.edges.map(([rel, lbl, target]) => (
                  <li key={rel+lbl+target} className="flex items-center gap-2 text-[12.5px]">
                    <span className="shrink-0 rounded-md bg-navy px-1.5 py-0.5 font-mono text-[10.5px] text-bg">─{rel}→</span>
                    <span className="shrink-0 text-[11px] text-muted">{lbl}</span>
                    {live?<button className="underline truncate text-left text-navy" onClick={()=>setNodeId(JSON.stringify([lbl,target]))}>{target}</button>:<span className="truncate text-navy">{target}</span>}
                  </li>
                ))}
              </ul>
            </div> : <p className="mt-4 text-sm text-muted">Chưa có node từ backend hoặc không tìm thấy.</p>}
          </div>
        </Card>

        <Card title="Cypher console · Demo" right={<span className="text-[11.5px] text-muted">chỉ đọc</span>}>
          <div className="px-5 pb-5">
            <p className="mb-3 text-xs text-muted">Demo: chưa có API Cypher; kết quả dưới đây là mẫu, không truy vấn database.</p>
            <textarea rows={3} className={`${inputCls} font-mono text-[12px]`} value={cypher} onChange={(e) => setCypher(e.target.value)} />
            <div className="mt-2 flex items-center gap-2">
              <Button
                size="sm"
                variant="dark"
                onClick={() => {
                  if (/\b(CREATE|MERGE|DELETE|SET|REMOVE|DROP)\b/i.test(cypher)) {
                    setCypherOut(['✗ Truy vấn ghi bị chặn — console ở chế độ chỉ đọc để bảo vệ graph production.'])
                    return
                  }
                  setCypherOut([`$ cypher-shell -d ${ns.id}`, 'Demo: d.name                             | count(a)', '─────────────────────────────────────────┼─────────', 'Luật TTATGT đường bộ 2024                |      89', 'Nghị định 168/2024/NĐ-CP                 |      54', 'Thông tư 35/2024/TT-BGTVT                |      41', 'Nghị định 160/2024/NĐ-CP                 |      38', 'QCVN 41:2024/BGTVT                       |      22', '✓ 5 dòng · 38 ms'])
                }}
              >
                ▶ Chạy truy vấn
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setCypher('MATCH (n) RETURN labels(n)[1] AS label, count(*) ORDER BY count(*) DESC')}>Mẫu: đếm nhãn</Button>
            </div>
            {cypherOut.length > 0 && <Terminal lines={cypherOut} className="mt-3 max-h-56" />}
          </div>
        </Card>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Xuất graph (máy nguồn) · Demo">
          <div className="px-5 pb-5 space-y-3 text-[13px] text-text-secondary">
            <p className="text-xs text-muted">Demo: mô phỏng; không xuất, kiểm checksum thật hoặc khôi phục database.</p>
            <p>Dump portable <span className="font-mono text-navy">dist/{live?'legalfinalcand':ns.id}.dump</span> kèm tệp <span className="font-mono text-navy">.sha256</span>. Dump ~1.31 GiB, không đưa vào git.</p>
            {busy('export') && <Progress value={jobs.find((j) => j.taskId === 'export' && j.status === 'running')!.progress} />}
            <Button variant="primary" disabled={busy('export')} onClick={() => runTask('export', { label: `Demo -Database ${live?'legalfinalcand':ns.id}`, onDone: () => notify('Demo: mô phỏng xuất dump + .sha256; không tạo tệp') })}>
              {busy('export') ? 'Đang xuất…' : 'Xuất dump + sha256'}
            </Button>
          </div>
        </Card>
        <Card title="Khôi phục graph (máy nhận) · Demo">
          <div className="px-5 pb-5 space-y-3 text-[13px] text-text-secondary">
            <p className="text-xs text-muted">Demo: mô phỏng; không xuất, kiểm checksum thật hoặc khôi phục database.</p>
            <label className="flex cursor-pointer items-center justify-between gap-3 rounded-xl border-2 border-dashed border-line bg-bg px-4 py-3 hover:border-progress">
              <span className="truncate">{restoreFile ?? 'Chọn tệp .dump (kèm .sha256)'}</span>
              <span className="text-xs font-semibold text-accent-strong">Duyệt…</span>
              <input type="file" accept=".dump,.sha256" multiple className="hidden" onChange={(e) => { const f = e.target.files?.[0]; setRestoreFile(f ? f.name : null); setShaOk(null) }} />
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <Button disabled={!restoreFile} onClick={() => { setShaOk(null); window.setTimeout(() => setShaOk(true), 900) }}>Kiểm tra sha256</Button>
              {shaOk && <Badge tone="green">Checksum mẫu · Demo</Badge>}
              <Button variant="dark" disabled={!shaOk || busy('restore')} onClick={() => runTask('restore', { onDone: () => notify('Demo: mô phỏng khôi phục; database không thay đổi') })}>
                {busy('restore') ? 'Đang khôi phục…' : 'Khôi phục vào legalfinalcand'}
              </Button>
            </div>
            <p className="text-[11.5px] text-muted">Database luôn phải là <span className="font-mono">legalfinalcand</span>; thiếu .sha256 sẽ không phát hiện được dump hỏng.</p>
          </div>
        </Card>
      </div>
    </Page>
  )
}
