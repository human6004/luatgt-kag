import { Notice } from './server/shared'
import { useInspection } from './server/KagManagement'
import { loadSampleInspection } from './server/kag-inspection'
import { useState } from 'react'
import { useAdmin } from '../admin/store'
import { Badge, Button, Card, Field, Page, Td, Th, Toggle, inputCls } from '../admin/ui'

/* Mirrors benchmark/README.md: 150 câu, 7 nhóm, 3 hệ thống */
const demoCategories: [string, string, number][] = [
  ['definition', 'Định nghĩa', 20],
  ['obligation', 'Nghĩa vụ', 25],
  ['sanction_numeric', 'Chế tài định lượng', 25],
  ['effectiveness_metadata', 'Hiệu lực văn bản', 20],
  ['inter_document', 'Liên văn bản', 20],
  ['multi_hop', 'Đa bước', 25],
  ['unanswerable', 'Không trả lời được', 15],
]
const systems = ['kag', 'hybridrag', 'nativerag'] as const
type Sys = (typeof systems)[number]
const sysName: Record<Sys, string> = { kag: 'KAG', hybridrag: 'HybridRAG', nativerag: 'NativeRAG' }

const demoMetrics: { key: string; label: string; v: Record<Sys, number> }[] = [
  { key: 'recall@5', label: 'Retrieval recall@5', v: { kag: 0.82, hybridrag: 0.74, nativerag: 0.61 } },
  { key: 'mrr', label: 'MRR', v: { kag: 0.69, hybridrag: 0.63, nativerag: 0.52 } },
  { key: 'cite_p', label: 'Citation precision', v: { kag: 0.77, hybridrag: 0.66, nativerag: 0.48 } },
  { key: 'cite_r', label: 'Citation recall', v: { kag: 0.71, hybridrag: 0.62, nativerag: 0.44 } },
  { key: 'answer', label: 'Answer correctness', v: { kag: 0.74, hybridrag: 0.68, nativerag: 0.57 } },
  { key: 'ground', label: 'Groundedness', v: { kag: 0.86, hybridrag: 0.79, nativerag: 0.65 } },
  { key: 'abst', label: 'Abstention F1', v: { kag: 0.8, hybridrag: 0.6, nativerag: 0.47 } },
]
const perCat: Record<string, Record<Sys, number>> = {
  definition: { kag: 0.65, hybridrag: 0.72, nativerag: 0.6 },
  obligation: { kag: 0.8, hybridrag: 0.7, nativerag: 0.58 },
  sanction_numeric: { kag: 0.68, hybridrag: 0.62, nativerag: 0.5 },
  effectiveness_metadata: { kag: 0.88, hybridrag: 0.7, nativerag: 0.55 },
  inter_document: { kag: 0.78, hybridrag: 0.6, nativerag: 0.45 },
  multi_hop: { kag: 0.72, hybridrag: 0.55, nativerag: 0.4 },
  unanswerable: { kag: 0.8, hybridrag: 0.6, nativerag: 0.47 },
}

const smoke = [
  { id: 'C1', type: 'control D2.1', target: 'Điều 28 / 80%', must: true, ok: true },
  { id: 'C2', type: 'control D2.1', target: 'Điều 16 / 100%, 200%, 300%', must: true, ok: true },
  { id: 'C3', type: 'control belongsTo', target: 'article:…:26 (top-1)', must: true, ok: true },
  { id: 'C4', type: 'probe multi-hop', target: 'article:…:30', must: false, ok: false },
  { id: 'B12', type: 'control D2.1 phụ', target: 'Điều 38 / 15%', must: false, ok: true },
  { id: 'B82', type: 'fact thời hạn', target: '24 giờ / Điều 10', must: false, ok: true },
  { id: 'B94', type: 'fact thời hạn', target: '60 ngày / Điều 19', must: false, ok: true },
  { id: 'B127', type: 'fact hiệu lực', target: '19/8/2026', must: false, ok: true },
]

const pct = (n: number) => (n * 100).toFixed(1) + '%'

function MetricBar({ value, best }: { value: number | null; best: boolean }) {
  if(value===null)return <span className="text-xs text-muted">Chưa đo</span>
  return (
    <div className="flex items-center gap-2" title={pct(value)}>
      <span className="h-2 flex-1 rounded-r bg-line/50">
        <span className={`block h-full rounded-r ${best ? 'bg-accent-strong' : 'bg-accent'}`} style={{ width: `${value * 100}%` }} />
      </span>
      <span className={`w-12 text-right text-[12px] tabular-nums ${best ? 'font-semibold text-navy' : 'text-text-secondary'}`}>{pct(value)}</span>
    </div>
  )
}

export default function AdminBenchmark() {
  const data=useInspection(loadSampleInspection)
  const [dataset,setDataset]=useState('')
  const catalog=data.value?.datasets, row=catalog?.datasets.find(r=>r.id===dataset)||catalog?.datasets[0]
  const actualCategories:[string,string,number][]=Object.entries(row?.metadata?.category_counts||{}).map(([k,n])=>[k,k,n])
  const categories=actualCategories.length?actualCategories:demoCategories
  const runs=row?.smoke?.runs
  const measured=Object.entries(runs||{}).flatMap(([mode,run])=>run?Object.entries(run.metrics).map(([name,m])=>({key:`${mode}.${name}`,label:`${mode} · ${name}`,v:{kag:m.value,hybridrag:null,nativerag:null} as Record<Sys,number|null>})):[])
  const metrics=[...measured,...demoMetrics.map(m=>({...m,key:'demo.'+m.key,label:m.label+' · so sánh Demo',v:{...m.v,kag:null} as Record<Sys,number|null>}))]
  const { runTask, jobs, notify } = useAdmin()
  const [enabled, setEnabled] = useState<Record<Sys, boolean>>({ kag: true, hybridrag: true, nativerag: true })
  const [k, setK] = useState('1,3,5,10')
  const [budget, setBudget] = useState(2000)
  const [bootstrap, setBootstrap] = useState(true)
  const [hasResult, setHasResult] = useState(true)
  const [cat, setCat] = useState('all')
  const [smokeState, setSmokeState] = useState<'idle' | 'run' | 'done'>('done')
  const [smokeIdx, setSmokeIdx] = useState(8)
  const running = jobs.some((j) => j.taskId === 'benchmark' && j.status === 'running')
  const shown = systems.filter((s) => enabled[s])

  function runBenchmark() {
    setHasResult(false)
    runTask('benchmark', {
      label: `--dataset benchmark/work/final_150_corpus_verified.json --k ${k} --budgets ${budget} --judge null${bootstrap ? '' : ' --no-bootstrap'} [${shown.join(',')}]`,
      onDone: () => { setHasResult(true); notify('Demo: mô phỏng hoàn tất; không ghi report hoặc chạy benchmark server') },
    })
  }

  function runSmoke() {
    setSmokeState('run')
    setSmokeIdx(0)
    let i = 0
    const t = window.setInterval(() => {
      i++
      setSmokeIdx(i)
      if (i >= smoke.length) {
        window.clearInterval(t)
        setSmokeState('done')
        notify('Demo: mô phỏng smoke hoàn tất; chưa kiểm chứng control thật')
      }
    }, 600)
  }

  const rowsFor = (s:Sys) => s==='kag'?null:(perCat[cat]?.[s]??null)

  return (
    <Page
      title="Benchmark"
      subtitle="KAG dùng artifact thực đo từ backend. HybridRAG/NativeRAG và tác vụ chạy chưa có API: Demo riêng."
      actions={<Button variant="dark" disabled={running || !shown.length} onClick={runBenchmark}>{running ? 'Đang mô phỏng…' : '▶ Chạy & đánh giá · Demo'}</Button>}
    >
      <Notice {...data} retry={data.reload}/><p className="mb-5 text-sm text-muted">API chỉ đọc kết quả và catalog; nút Chạy mô phỏng, không chạy benchmark server hoặc tạo metrics KAG.</p>
      <div className="grid gap-5 xl:grid-cols-[300px_minmax(0,1fr)]">
        <div className="space-y-5">
          <Card title="Thiết lập · Demo">
            <div className="px-5 pb-5 space-y-4">
              <div>
                <span className="block text-xs font-medium text-text-secondary mb-2">Hệ thống</span>
                <div className="space-y-2">
                  {systems.map((s) => (
                    <label key={s} className="flex items-center justify-between text-[13px] text-navy">
                      <span>{sysName[s]}{s!=='kag'&&' · Demo'} <span className="font-mono text-[11px] text-muted">--system {s}</span></span>
                      <Toggle checked={enabled[s]} onChange={(v) => setEnabled({ ...enabled, [s]: v })} label={sysName[s]} />
                    </label>
                  ))}
                </div>
              </div>
              <Field label="--k" hint="Nên gồm 5 để đủ hàng headline"><input className={inputCls} value={k} onChange={(e) => setK(e.target.value)} /></Field>
              <Field label="--budgets (token context)"><input type="number" className={inputCls} value={budget} onChange={(e) => setBudget(Number(e.target.value))} /></Field>
              <label className="flex items-center justify-between text-[13px] text-navy">Bootstrap CI <Toggle checked={bootstrap} onChange={setBootstrap} label="Bootstrap" /></label>
              <p className="text-[11.5px] leading-relaxed text-muted">Citations chỉ parse từ nội dung answer bằng citation_parser — không copy từ retrieved_contexts.</p>
            </div>
          </Card>

          <Card title={actualCategories.length?"Bộ câu hỏi":"Nhóm mẫu · Demo"} right={<span className="text-[11.5px] text-muted">{row?.record_count??"—"} câu</span>}>
            <div className="px-5 mb-4"><select aria-label="Dataset" className={inputCls} value={row?.id||''} onChange={e=>{setDataset(e.target.value);setCat('all')}}>{catalog?.datasets.map(r=><option key={r.id}>{r.id}</option>)}</select><p className="mt-2 text-xs text-muted">{row?.dataset_status||"Chưa có catalog"} · {row?.dataset_eligibility}</p></div>
            <ul className="px-5 pb-5 space-y-1.5">
              {categories.map(([id, name, n]) => (
                <li key={id} className="grid grid-cols-[minmax(0,1fr)_80px_24px] items-center gap-2 text-[12.5px]" title={`${id}: ${n} câu`}>
                  <span className="truncate text-text-secondary">{name}</span>
                  <span className="h-2 rounded-r bg-line/50"><span className="block h-full rounded-r bg-accent" style={{ width: `${(n / 25) * 100}%` }} /></span>
                  <span className="text-right tabular-nums text-navy">{n}</span>
                </li>
              ))}
            </ul>
          </Card>
        </div>

        <div className="space-y-5 min-w-0">
          <Card
            title="Kết quả đánh giá"
            flush
            right={
              <select className="rounded-lg border border-line bg-transparent px-2 py-1 text-[12px] text-navy" value={cat} onChange={(e) => setCat(e.target.value)} aria-label="Nhóm câu hỏi">
                <option value="all">Tất cả metric</option>
                {categories.map(([id, name]) => <option key={id} value={id}>Answer · {name}</option>)}
              </select>
            }
          >
            {!hasResult ? (
              <div className="px-5 py-6 text-sm text-muted">{running ? 'Đang mô phỏng Demo… xem log ở trang Pipeline.' : 'Chưa có kết quả.'}</div>
            ) : !shown.length ? (
              <div className="px-5 py-6 text-sm text-muted">Bật ít nhất một hệ thống.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[620px]">
                  <thead className="border-y border-line">
                    <tr><Th>Metric</Th>{shown.map((s) => <Th key={s}>{sysName[s]}{s!=='kag'&&' · Demo'}</Th>)}</tr>
                  </thead>
                  <tbody>
                    {cat === 'all'
                      ? metrics.map((m) => {
                          const best = Math.max(...shown.map(s=>m.v[s]??-1))
                          return (
                            <tr key={m.key} className="border-b border-line/60 last:border-0">
                              <Td className="whitespace-nowrap text-navy">{m.label}</Td>
                              {shown.map((s) => <Td key={s}><MetricBar value={m.v[s]} best={m.v[s] === best} /></Td>)}
                            </tr>
                          )
                        })
                      : (
                        <tr>
                          <Td className="text-navy">{categories.find((c) => c[0] === cat)?.[1]??cat}</Td>
                          {shown.map((s) => <Td key={s}><MetricBar value={rowsFor(s)!} best={rowsFor(s) === Math.max(...shown.map(x=>rowsFor(x)??-1))} /></Td>)}
                        </tr>
                      )}
                  </tbody>
                </table>
                <p className="px-5 py-3 text-[11.5px] text-muted border-t border-line">Giá trị đậm = tốt nhất trong hàng. KAG: metrics thực đo hoặc Chưa đo; không có fallback. Cột Demo là số liệu mẫu, không chứng minh chất lượng hệ thống.</p>
              </div>
            )}
          </Card>

          <Card title="Artifact KAG · API thật"><div className="px-5 pb-5 text-xs space-y-2 break-words">
          {data.value&&<details><summary>Danh tính graph và cấu hình quan sát</summary><p>Fingerprint: {data.value.graph_fingerprint}</p><p>Source catalog SHA-256: {data.value.source_catalog_sha256}</p><p>Model: {data.value.providers.configured_chat_model??'Chưa cấu hình'} · upstream chưa xác minh</p></details>}
          {row&&<><p>{row.dataset_hash} · eligible {row.eligible_count} · ineligible {row.ineligible_count}</p><p>{row.eligibility_scope} · {row.reason}</p><p>Review: {row.smoke?.review_status??'Chưa có'} · official {String(row.official_benchmark)} · state {row.smoke?.state??'NOT_RUN'}</p>
          {Object.entries(runs||{}).map(([mode,run])=><details key={mode}><summary>{mode}: {run?.status??'NOT_RUN'}</summary>{run?<><p>Requested {run.requested_count} · Attempted {run.attempted_count} · Failed {run.failed_count} · Ineligible {run.ineligible_count}</p><p>{run.started_at} → {run.finished_at}</p><p>Latency mean: {run.latency_ms.all_attempted.mean??'Chưa đo'} ms</p><pre className="whitespace-pre-wrap break-all">{JSON.stringify(run.configuration,null,2)}</pre>{Object.entries(run.metrics).map(([name,m])=><p key={name}>{name}: {m.value??'UNAVAILABLE / NOT_APPLICABLE'} · Scored {m.scored_count}/{m.eligible_count} · Failed {m.failed_count} · Excluded {m.excluded_count}</p>)}</>:<p>Chưa có execution artifact hợp lệ; metrics chưa đo.</p>}</details>)}
          <details><summary>Gold thiếu trong SAMPLE</summary>{Object.entries(row.missing_gold).map(([k,ids])=><p key={k}>{k}: {ids.join(', ')||'Không có'}</p>)}</details></>}
          <p>Production WRITE bị chặn. Catalog và artifact không chứng minh kỳ benchmark chính thức hoặc human review đã đạt.</p>
          </div></Card>
          <Card
            title="Smoke test (8 câu) · Demo"
            flush
            right={<Button size="sm" variant="primary" disabled={smokeState === 'run'} onClick={runSmoke}>{smokeState === 'run' ? `Đang chạy ${smokeIdx}/8…` : '▶ Chạy smoke · Demo'}</Button>}
          >
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px]">
                <thead className="border-y border-line"><tr><Th>ID</Th><Th>Loại</Th><Th>Mục tiêu</Th><Th>Kết quả</Th></tr></thead>
                <tbody>
                  {smoke.map((s, i) => (
                    <tr key={s.id} className="border-b border-line/60 last:border-0">
                      <Td className="font-mono text-xs text-navy">{s.id}{s.must && <span className="ml-1 text-accent-strong" title="Bắt buộc">*</span>}</Td>
                      <Td className="text-muted">{s.type}</Td>
                      <Td className="text-text-secondary">{s.target}</Td>
                      <Td>
                        {i >= smokeIdx ? <Badge>{smokeState === 'run' && i === smokeIdx ? 'Đang chạy' : 'Chờ'}</Badge> : s.ok ? <Badge tone="green">✓ Evidence đúng</Badge> : <Badge tone="red">✗ Miss</Badge>}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="px-5 py-3 text-[11.5px] text-muted border-t border-line">* control bắt buộc. Demo trong trình duyệt; không gọi provider hoặc đọc graph. Không xác nhận smoke test thật.</p>
            </div>
          </Card>
        </div>
      </div>
    </Page>
  )
}
