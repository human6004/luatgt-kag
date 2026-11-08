import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useAdmin } from '../admin/store'
import { apiResponse } from '../api'
import { Badge, Button, Card, Page, Td, Th, inputCls } from '../admin/ui'
import { useInspection } from './server/KagManagement'
import { benchmarkCategories, inspectionError, loadBenchmarkCategoryCounts, loadBenchmarkDatasets, loadSampleInspection, loadServing, loadBenchmarkRun, startBenchmarkRun, stopBenchmarkRun } from './server/kag-inspection'
import type { BenchmarkJob, BenchmarkMode, SmokeRun } from './server/kag-inspection'
import { Notice } from './server/shared'

const pct = (n: number) => (n * 100).toLocaleString('vi-VN', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + '%'

// Units follow the producers in kag/evaluation/metrics.py; unavailable-only diagnostics stay raw.
const metricKinds: Record<string, 'ratio' | 'count'> = {
  returned_top_k_MRR: 'ratio',
  'document.returned_top_k_MRR': 'ratio',
  'unit.returned_top_k_MRR': 'ratio',
  'sign.returned_top_k_MRR': 'ratio',
  'source_span.returned_top_k_MRR': 'ratio',
  'source_span.evidence_recall': 'ratio',
  'source_span.evidence_recall_required': 'ratio',
  'source_span.context_precision': 'ratio',
  citation_source_precision: 'ratio',
  citation_source_recall: 'ratio',
  citation_exact_precision: 'ratio',
  citation_exact_recall: 'ratio',
  citation_doc_accuracy: 'ratio',
  citation_unit_accuracy: 'ratio',
  citation_sign_accuracy: 'ratio',
  abstention_accuracy: 'ratio',
  correct_abstention: 'ratio',
  false_answer_rate: 'ratio',
  wrong_abstention_rate: 'ratio',
  marker_coverage: 'ratio',
  markers_all: 'ratio',
  answer_correctness: 'ratio',
  exact_eligible_citation_count: 'count',
  exact_excluded_citation_count: 'count',
  required_source_count: 'count',
  acceptable_source_count: 'count',
  citation_article_accuracy: 'count',
  grounding: 'count',
}
// ranking_metrics emits Hit/Recall/MRR@k; source_span_metrics emits only Hit/Recall@k.
const rankingMetric = /^(?:(?:document|unit|sign)\.)?(?:Hit|Recall|MRR)@\d+$|^source_span\.(?:Hit|Recall)@\d+$/

const displayName: Record<string, string> = {
  returned_top_k_MRR: 'MRR (toàn kết quả)',
  citation_source_precision: 'Chính xác nguồn trích dẫn',
  citation_source_recall: 'Phủ nguồn trích dẫn',
  citation_exact_precision: 'Chính xác trích dẫn chính xác',
  citation_exact_recall: 'Phủ trích dẫn chính xác',
  abstention_accuracy: 'Chính xác từ chối trả lời',
  correct_abstention: 'Từ chối đúng',
  false_answer_rate: 'Trả lời khi nên từ chối',
  wrong_abstention_rate: 'Từ chối khi nên trả lời',
  marker_coverage: 'Độ phủ từ khoá',
  markers_all: 'Tất cả từ khoá',
  answer_correctness: 'Độ chính xác câu trả lời',
  citation_doc_accuracy: 'Độ chính xác văn bản',
  citation_unit_accuracy: 'Độ chính xác đơn vị',
  citation_sign_accuracy: 'Độ chính xác biển báo',
  evidence_recall: 'Phủ căn cứ',
  evidence_recall_required: 'Phủ căn cứ bắt buộc',
  context_precision: 'Chính xác ngữ cảnh',
}
const channels = ['document', 'sign', 'unit', 'source_span', '']
const families = ['Hit', 'Recall', 'MRR', 'returned_top_k']

function parseMetric(mode: string, name: string) {
  const channel = channels.find((c) => c && name.startsWith(`${c}.`)) || ''
  const metric = channel ? name.slice(channel.length + 1) : name
  const ranking = /^(Hit|Recall|MRR)@(\d+)$/.exec(metric)
  const family = ranking?.[1] ?? (metric === 'returned_top_k_MRR' ? 'returned_top_k' : metric)
  return { mode, channel, family, k: ranking ? Number(ranking[2]) : 0, label: ranking ? metric : Object.prototype.hasOwnProperty.call(displayName, metric) ? displayName[metric] : name }
}

function MetricBar({ value, kind = 'count' }: { value: number | null; kind?: 'ratio' | 'count' | 'latency' }) {
  if (value === null) return <span className="text-xs text-muted">Chưa đo</span>
  if (kind !== 'ratio') return <span className="tabular-nums">{kind === 'latency' ? `${Math.round(value)} ms` : value}</span>
  return (
    <div className="flex items-center gap-2" title={pct(value)}>
      <span className="h-2 flex-1 rounded-r bg-line/50">
        <span className="block h-full rounded-r bg-accent-strong" style={{ width: `${Math.min(100, Math.max(0, value * 100))}%` }} />
      </span>
      <span className="w-12 text-right text-[12px] tabular-nums font-semibold text-navy">{pct(value)}</span>
    </div>
  )
}

export default function AdminBenchmark() {
  const [params, setParams] = useSearchParams()
  const { notify } = useAdmin()
  const data = useInspection(loadSampleInspection)
  // Store departures from the default so async data also opens only the first channel.
  const [toggledChannels, setToggledChannels] = useState<Set<string>>(() => new Set())
  const datasetData = useInspection(loadBenchmarkDatasets)
  const serving = useInspection(loadServing)
  const [graphKey, setGraphKey] = useState('')
  const [mode, setMode] = useState<BenchmarkMode>('BOTH')
  const [limit, setLimit] = useState('')
  const [job, setJob] = useState<BenchmarkJob | null>(null)
  const [jobError, setJobError] = useState('')
  const [runBusy, setRunBusy] = useState(false)
  const [stopRequested, setStopRequested] = useState(false)
  const [pollVersion, setPollVersion] = useState(0)
  const [now, setNow] = useState(Date.now())
  const [distribution, setDistribution] = useState<{ id: string; hash: string | null; counts: Record<string, number> } | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const [importName, setImportName] = useState('')
  const [busy, setBusy] = useState(false)
  const [importErrors, setImportErrors] = useState<{ index: number; field: string; code: string; message: string }[]>([])

  const catalog = data.value?.datasets
  const datasets = datasetData.value?.datasets ?? []
  const requestedDataset = params.get('dataset') ?? ''
  const selected = datasets.find((r) => r.id === requestedDataset) || datasets[0]
  const row = catalog?.datasets.find((r) => r.id === selected?.id)
  const jobId = params.get('job') ?? ''
  const currentJob = job?.run_id_job === jobId ? job : null
  const selectedJob = currentJob?.dataset_id === selected?.id ? currentJob : null
  const graphRuns = serving.value?.runs ?? []
  const graph = graphRuns.find((r) => `${r.project_id}/${r.run_id}` === graphKey) ?? graphRuns[0]
  const fullJobCounts = selectedJob?.dataset_hash === selected?.dataset_hash && Object.values(selectedJob?.category_counts ?? {}).reduce((a, b) => a + b, 0) === selected?.record_count ? selectedJob?.category_counts : undefined
  const categoryCounts = fullJobCounts ?? (distribution?.id === selected?.id && distribution?.hash === selected?.dataset_hash ? distribution?.counts : undefined)
  const categories: [string, number][] = categoryCounts ? benchmarkCategories.map(category => [category, categoryCounts[category] ?? 0]) : []
  const maxCatCount = Math.max(1, ...categories.map(([, n]) => n))
  const progressMode = selectedJob?.mode === 'BOTH' ? 'G1' : selectedJob?.mode
  const evaluatedCount = progressMode && selectedJob ? selectedJob.progress[progressMode]?.total : undefined

  useEffect(() => {
    setDistribution(null)
    if (!selected) return
    const controller = new AbortController()
    void loadBenchmarkCategoryCounts(selected.id, controller.signal).then(counts => {
      if (!controller.signal.aborted && Object.values(counts).reduce((a, b) => a + b, 0) === selected.record_count) setDistribution({ id: selected.id, hash: selected.dataset_hash, counts })
    }).catch(() => { /* Optional distribution; benchmark controls remain available. */ })
    return () => controller.abort()
  }, [selected?.id, selected?.dataset_hash, selected?.record_count])

  useEffect(() => {
    setJob((previous) => previous?.run_id_job === jobId ? previous : null)
    setJobError('')
    setStopRequested(false)
    if (!jobId) return
    const controller = new AbortController()
    let pending = false
    let timer: ReturnType<typeof setInterval> | undefined
    async function poll() {
      if (pending || controller.signal.aborted) return
      pending = true
      try {
        const value = await loadBenchmarkRun(jobId, controller.signal)
        if (!controller.signal.aborted) {
          setJob((previous) => previous?.run_id_job === jobId && previous.state !== 'RUNNING' ? previous : value)
          setJobError('')
          setNow(Date.now())
          if (value.state === 'RUNNING' && timer === undefined) timer = setInterval(() => { void poll() }, 2000)
          else if (value.state !== 'RUNNING') clearInterval(timer)
        }
      } catch (error) {
        if (!controller.signal.aborted) setJobError(inspectionError(error))
      } finally { pending = false }
    }
    void poll()
    return () => { controller.abort(); clearInterval(timer) }
  }, [jobId, pollVersion])

  const rawCat = params.get('cat') ?? 'all'
  const cat = rawCat === 'all' || categories.some(([id]) => id === rawCat) ? rawCat : 'all'

  const runs: Record<string, Pick<SmokeRun, 'metrics' | 'by_category' | 'requested_count'> | null> | undefined = selectedJob ? Object.fromEntries(Object.entries(selectedJob.metrics ?? {}).map(([mode, metrics]) => [mode, {
    metrics: metrics.overall, by_category: metrics.by_category, requested_count: metrics.requested_count,
  }])) : row?.smoke?.runs
  const measured = Object.entries(runs || {}).flatMap(([mode, run]) =>
    run
      ? Object.entries(cat === 'all' ? { ...(run.by_category ?? {}), 'Tất cả': run.metrics } : { [cat]: run.by_category?.[cat] || {} })
          .flatMap(([group, metrics]) => Object.entries(metrics).map(([name, m]) => ({
            ...parseMetric(mode, name),
            key: `${mode}.${group}.${name}`,
            name,
            value: m.value,
            group,
            n: group === 'Tất cả' ? run.requested_count : m.eligible_count + m.excluded_count,
            scored: m.scored_count,
            excluded: m.excluded_count,
          })))
      : [],
  ).sort((a, b) => a.mode.localeCompare(b.mode)
    || channels.indexOf(a.channel) - channels.indexOf(b.channel)
    || (families.includes(a.family) ? families.indexOf(a.family) : families.length) - (families.includes(b.family) ? families.indexOf(b.family) : families.length)
    || a.family.localeCompare(b.family) || a.k - b.k || a.group.localeCompare(b.group))
  const metricGroups: { key: string; mode: string; channel: string; metrics: typeof measured }[] = []
  for (const metric of measured) {
    const key = `${metric.mode}.${metric.channel}`
    if (metricGroups.at(-1)?.key !== key) metricGroups.push({ key, mode: metric.mode, channel: metric.channel, metrics: [] })
    metricGroups.at(-1)!.metrics.push(metric)
  }
  function countRange(field: 'scored' | 'excluded') {
    const values = measured.map((m) => m[field])
    const min = Math.min(...values), max = Math.max(...values)
    return min === max ? String(min) : `${min}–${max}`
  }

  function updateUrl(patch: Record<string, string | null>) {
    setParams((prev) => {
      const next = new URLSearchParams(prev)
      for (const [k, v] of Object.entries(patch)) {
        if (v === null || v === '') next.delete(k)
        else next.set(k, v)
      }
      return next
    })
  }

  async function runBenchmark() {
    const count = limit.trim() === '' ? null : Number(limit)
    if (!selected || !graph || count !== null && (!/^\d+$/.test(limit.trim()) || !Number.isSafeInteger(count) || count < 1 || count > (selected.record_count ?? 0))) {
      notify('Chọn bộ câu hỏi, đồ thị và số câu từ 1 đến số câu trong bộ; để trống để chạy toàn bộ.')
      return
    }
    setRunBusy(true)
    try {
      const result = await startBenchmarkRun({ dataset_id: selected.id, project_id: graph.project_id, run_id: graph.run_id, mode, limit: count })
      updateUrl({ job: result.run_id_job, dataset: selected.id, cat: null })
    } catch (error) { notify(inspectionError(error)) }
    finally { setRunBusy(false) }
  }

  async function stopBenchmark() {
    if (!currentJob || currentJob.state !== 'RUNNING') return
    setRunBusy(true)
    try {
      const result = await stopBenchmarkRun(currentJob.run_id_job)
      setJob((previous) => previous?.run_id_job === result.run_id_job && previous.state !== 'RUNNING' ? previous : result)
      setStopRequested(true)
      setJobError('')
    } catch (error) { notify(inspectionError(error)) }
    finally { setRunBusy(false) }
  }

  async function download(path: string, filename: string) {
    setBusy(true)
    try {
      const response = await apiResponse(path)
      if (!response.ok) throw new Error(`Không tải được file (${response.status}).`)
      const url = URL.createObjectURL(await response.blob())
      const link = document.createElement('a')
      link.href = url
      link.download = filename
      link.click()
      URL.revokeObjectURL(url)
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Không tải được file.')
    } finally { setBusy(false) }
  }

  async function importFile(file: File) {
    const name = importName.trim()
    setImportErrors([])
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name) || name.includes('..') || name === '.') {
      notify('Tên bộ câu hỏi cần 1–64 chữ, số, _, -, dấu chấm; không nhận ..')
      return
    }
    if (!file.name.toLowerCase().endsWith('.json') || file.size > 8 * 1024 * 1024) {
      notify('Chọn file .json không quá 8 MiB.')
      return
    }
    setBusy(true)
    try {
      const response = await apiResponse(`/admin/kag/benchmark/datasets?name=${encodeURIComponent(name)}`, { method: 'POST', body: await file.text() })
      if (response.status === 422) {
        const errors: unknown = await response.json()
        if (!Array.isArray(errors) || !errors.every((e) => e && Number.isSafeInteger(e.index) && e.index >= 0 && ['field', 'code', 'message'].every((k) => typeof e[k] === 'string'))) {
          throw new Error('Phản hồi lỗi import không hợp lệ.')
        }
        setImportErrors(errors)
        notify('File có lỗi; chưa lưu bộ câu hỏi.')
        return
      }
      if (!response.ok) throw new Error(response.status === 409 ? 'Tên bộ câu hỏi đã tồn tại.' : `Import thất bại (${response.status}).`)
      const result: { id: string; record_count: number } = await response.json()
      setImportErrors([])
      notify(`Đã import ${result.record_count} câu.`)
      updateUrl({ dataset: result.id, cat: null })
      datasetData.reload()
      data.reload()
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Import thất bại.')
    } finally { setBusy(false) }
  }

  return (
    <Page
      title="Benchmark"
      subtitle="Đọc catalog bộ câu hỏi và artifact đánh giá thực tế của KAG từ backend."
    >
      <Notice {...datasetData} retry={datasetData.reload} />
      <Notice {...serving} retry={serving.reload} />

      <Card title="Chạy benchmark" className="mb-6">
        <div className="px-5 pb-5 space-y-3 text-sm">
          <div className="grid gap-3 lg:grid-cols-3">
            <label>Đồ thị đã PASS
              <select aria-label="Đồ thị benchmark" className={`${inputCls} mt-1`} value={graph ? `${graph.project_id}/${graph.run_id}` : ''} disabled={runBusy || currentJob?.state === 'RUNNING'} onChange={(e) => setGraphKey(e.target.value)}>
                {!graph && <option value="">Chưa có đồ thị đã PASS</option>}
                {graphRuns.map((r) => <option key={`${r.project_id}/${r.run_id}`} value={`${r.project_id}/${r.run_id}`}>{r.project_name} · {r.run_id}</option>)}
              </select>
            </label>
            <label>Mode
              <select aria-label="Mode benchmark" className={`${inputCls} mt-1`} value={mode} disabled={runBusy || currentJob?.state === 'RUNNING'} onChange={(e) => setMode(e.target.value as BenchmarkMode)}>
                <option value="G1">G1 · Truy xuất</option><option value="G2">G2 · Trả lời</option><option value="BOTH">G1 + G2</option>
              </select>
            </label>
            <label>Số câu · để trống = toàn bộ
              <input aria-label="Số câu benchmark" type="number" min={1} max={selected?.record_count ?? undefined} step={1} className={`${inputCls} mt-1`} value={limit} disabled={runBusy || currentJob?.state === 'RUNNING'} onChange={(e) => setLimit(e.target.value)} placeholder="Toàn bộ" />
            </label>
          </div>
          {(selectedJob?.dataset_status ?? selected?.dataset_status) === 'PROVISIONAL' && <p className="text-amber-700">Bộ chưa cố định — số liệu tạm, không so sánh được giữa các lần chạy.</p>}
          {selectedJob?.dataset_status === 'FROZEN' && <p className="break-all text-xs">FROZEN · dataset_hash: {selectedJob.dataset_hash} · frozen_at: {selectedJob.frozen_at}</p>}
          <p className="text-xs text-amber-700">GraphLock giữ suốt lượt chạy; không thể xóa hoặc dựng lại đồ thị đến khi lượt chạy kết thúc hoặc dừng.</p>
          <div className="flex flex-wrap gap-2">
            <Button variant="dark" disabled={runBusy || !!jobId && !currentJob || currentJob?.state === 'RUNNING' || !graph || serving.value?.busy || !selected?.record_count || !selected.dataset_hash || !['PROVISIONAL', 'FROZEN'].includes(selected.dataset_status ?? '')} onClick={runBenchmark}>Chạy benchmark</Button>
            {currentJob?.state === 'RUNNING' && <Button disabled={runBusy || stopRequested} onClick={stopBenchmark}>Dừng benchmark</Button>}
            {jobId && <Button size="sm" onClick={() => updateUrl({ job: null })} disabled={runBusy || currentJob?.state === 'RUNNING'}>Đóng lượt chạy</Button>}
          </div>
          {jobError && <div role="alert" className="text-red-700">{jobError} <Button size="sm" onClick={() => setPollVersion((v) => v + 1)}>Thử lại trạng thái</Button></div>}
          {jobId && !currentJob && !jobError && <p role="status">Đang tải trạng thái lượt chạy…</p>}
          {currentJob && <div role="status" className="space-y-1 text-xs">
            <p className="break-all">{currentJob.state} · {currentJob.dataset_id} · {currentJob.project_id}/{currentJob.run_id}</p>
            {Object.entries(currentJob.progress).map(([m, p]) => <div key={m}>
              <div className="grid grid-cols-[1.5rem_minmax(0,1fr)_auto] items-center gap-2">
                <span>{m}</span>
                <div role="progressbar" aria-label={`Tiến độ ${m}`} aria-valuemin={0} aria-valuemax={p.total} aria-valuenow={p.done} aria-valuetext={`${p.done}/${p.total} câu`} className="h-2 rounded-r bg-line/50">
                  <div className={`h-full rounded-r ${currentJob.state === 'FAILED' ? 'bg-red-600' : 'bg-accent-strong'}`} style={{ width: `${Math.min(100, Math.max(0, p.total ? p.done / p.total * 100 : 0))}%` }} />
                </div>
                <span className="tabular-nums">{p.done}/{p.total} câu</span>
              </div>
              {currentJob.state === 'STOPPED' && <p className="text-amber-700">Đã dừng ở {p.done}/{p.total}</p>}
            </div>)}
            <p>{currentJob.state === 'RUNNING' ? 'Thời gian đã chạy' : currentJob.state === 'COMPLETE' ? 'Tổng thời gian' : 'Thời gian'}: {Math.max(0, Math.floor(((currentJob.finished_at ? Date.parse(currentJob.finished_at) : now) - Date.parse(currentJob.started_at)) / 1000))} giây</p>
            {stopRequested && currentJob.state === 'RUNNING' && <p>Đã yêu cầu dừng; chờ câu đang xử lý kết thúc.</p>}
            {currentJob.state === 'STOPPED' && <p className="text-amber-700">Đã dừng — kết quả một phần, chưa đánh giá toàn bộ tập đã chọn.</p>}
            {currentJob.state === 'FAILED' && <p className="text-red-700">Lượt chạy thất bại · {currentJob.code}</p>}
          </div>}
        </div>
      </Card>

      <div className="grid items-start gap-6 xl:grid-cols-[360px_minmax(0,1fr)]">
        <div className="min-w-0">
          <Card title="Bộ câu hỏi chuẩn" className="[&>header]:min-h-10" right={<span className="text-[11.5px] text-muted">{selected?.record_count ?? '—'} câu</span>}>
            <div className="px-5 mb-4">
              <select
                aria-label="Dataset"
                className={inputCls}
                value={selected?.id || ''}
                onChange={(e) => updateUrl({ dataset: e.target.value, cat: null })}
              >
                {datasets.map((r) => (
                  <option key={r.id}>{r.id}</option>
                ))}
              </select>
              <p className="mt-2 text-xs text-muted">
                {selected ? `${selected.dataset_status} · ${selected.dataset_eligibility}` : 'Chưa có catalog bộ câu hỏi'}
              </p>
              <div className="mt-3 space-y-2">
                <label className="block text-xs text-muted">
                  Tên bộ câu hỏi mới
                  <input className={`${inputCls} mt-1`} value={importName} maxLength={64} disabled={busy}
                    onChange={(e) => { setImportName(e.target.value); setImportErrors([]) }} placeholder="bo-cau-hoi-01" />
                </label>
                <input ref={fileInput} type="file" accept=".json,application/json" className="hidden" disabled={busy}
                  onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ''; if (file) void importFile(file) }} />
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" disabled={busy} onClick={() => void download('/admin/kag/benchmark/template', 'benchmark-template.json')}>Tải file mẫu</Button>
                  <Button size="sm" disabled={busy || !importName.trim()} onClick={() => fileInput.current?.click()}>Import</Button>
                  {selected && <Button size="sm" disabled={busy} onClick={() => void download(`/admin/kag/benchmark/datasets/${selected.id.split('/').map(encodeURIComponent).join('/')}/export`, `${selected.id.includes('/') ? selected.id.split('/')[0] : selected.id.replace(/\.jsonl$/, '')}.json`)}>Export</Button>}
                </div>
                {importErrors.length > 0 && <ul role="alert" className="max-h-60 overflow-y-auto space-y-1 text-xs text-red-700 break-words">
                  {importErrors.map((error, index) => <li key={index}>Câu {error.index + 1} · {error.field || 'record'} · {error.message}</li>)}
                </ul>}
              </div>
            </div>
            {evaluatedCount !== undefined && selected?.record_count && evaluatedCount < selected.record_count ? <p className="px-5 pb-2 text-xs text-muted">{evaluatedCount}/{selected.record_count} câu được đánh giá</p> : null}
            {categories.length ? (
              <ul className="px-5 pb-5 space-y-1.5">
                {categories.map(([id, n]) => (
                  <li
                    key={id}
                    className={`grid grid-cols-[minmax(0,1fr)_64px_24px] items-center gap-2 text-[12.5px] cursor-pointer rounded px-1 py-1 ${
                      cat === id ? 'bg-selected font-medium text-navy' : 'text-text-secondary hover:bg-bg'
                    }`}
                    onClick={() => updateUrl({ cat: cat === id ? null : id })}
                    title={`${id}: ${n} câu`}
                  >
                    <span className="min-w-0 break-words">{id}</span>
                    <span className="h-2 rounded-r bg-line/50">
                      <span className="block h-full rounded-r bg-accent" style={{ width: `${(n / maxCatCount) * 100}%` }} />
                    </span>
                    <span className="text-right tabular-nums text-navy">{n}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-5 pb-5 text-xs text-muted">Chưa có phân bố</p>
            )}
          </Card>
        </div>

        <div className="space-y-6 min-w-0">
          <Card
            className="[&>header]:min-h-10"
            title={cat === 'all' ? 'Kết quả đo KAG' : `${cat} · ${categoryCounts?.[cat] ?? '—'} câu${measured.length ? ` · ${countRange('scored')} đã chấm · ${countRange('excluded')} bị loại` : ' · Chưa đo'}`}
            right={
              <select
                className={`${inputCls} sm:w-52`}
                value={cat}
                onChange={(e) => updateUrl({ cat: e.target.value === 'all' ? null : e.target.value })}
                aria-label="Nhóm câu hỏi"
              >
                <option value="all">Tất cả nhóm</option>
                {categories.map(([id]) => (
                  <option key={id} value={id}>
                    Nhóm · {id}
                  </option>
                ))}
              </select>
            }
          >
            {measured.length ? (
              <div role="region" aria-label="Bảng kết quả benchmark">
                {cat !== 'all' && <p className="px-3 pb-3 text-xs text-muted">Đã chấm / bị loại theo metric; khoảng số thể hiện các metric có số câu khác nhau.</p>}
                {metricGroups.map((group, index) => {
                  const open = (index === 0) !== toggledChannels.has(group.key)
                  return (
                    <section key={group.key} className="border-t border-line">
                      <button type="button" className="w-full px-3 py-3 text-left text-sm font-semibold text-navy hover:bg-selected focus-visible:outline-2 focus-visible:outline-accent-strong"
                        aria-label={`${group.mode} · ${group.channel || 'Chung'}`} aria-expanded={open}
                        onClick={() => setToggledChannels((prev) => {
                          const next = new Set(prev)
                          if (next.has(group.key)) next.delete(group.key)
                          else next.add(group.key)
                          return next
                        })}>
                        {open ? '▼' : '▶'} {group.mode} · {group.channel || 'Chung'}
                      </button>
                      {open && <table className="w-full table-fixed" aria-label={`${group.mode} · ${group.channel || 'Chung'}`}>
                        <thead className="border-y border-line">
                          <tr>
                            {cat === 'all' ? <><Th className="hidden sm:table-cell sm:w-[15%] !px-2">Nhóm</Th><Th className="hidden sm:table-cell sm:w-[7%] !px-2">n</Th></> : <Th className="hidden sm:table-cell sm:w-[12%] !px-2">Mode</Th>}
                            <Th className="hidden sm:table-cell sm:w-[16%] !px-2">Channel</Th>
                            <Th className="w-[40%] sm:w-auto !px-2">Metric</Th>
                            <Th className="w-[24%] sm:w-[22%] !px-2">Điểm</Th>
                            <Th className="w-[20%] sm:w-[12%] !px-2">Đã chấm</Th>
                            <Th className="w-[16%] sm:w-[10%] !px-2">Bị loại</Th>
                          </tr>
                        </thead>
                        <tbody>
                          {group.metrics.map((m) => (
                            <tr key={m.key} className="border-b border-line/60 last:border-0">
                              {cat === 'all' ? <><Td className="hidden sm:table-cell !px-2">{m.group}</Td><Td className="hidden sm:table-cell !px-2">{m.n ?? '—'}</Td></> : <Td className="hidden sm:table-cell !px-2">{m.mode}</Td>}
                              <Td className="hidden sm:table-cell !px-2">{m.channel || 'Chung'}</Td>
                              <Td className="!px-2 text-navy [overflow-wrap:anywhere]">
                                <span title={m.name}>{m.label}</span>
                                {cat === 'all' && <span className="block text-xs text-muted sm:hidden">{m.group} · {m.n ?? '—'} câu</span>}
                              </Td>
                              <Td className="!px-2">{m.name === 'answer_correctness' && m.value === null ? <span className="text-xs text-muted">Chưa có giám khảo</span> : <MetricBar value={m.value} kind={metricKinds[m.name] ?? (rankingMetric.test(m.name) ? 'ratio' : 'count')} />}</Td>
                              <Td className="!px-2">{m.scored}</Td>
                              <Td className="!px-2">{m.excluded}</Td>
                            </tr>
                          ))}
                        </tbody>
                      </table>}
                    </section>
                  )
                })}
              </div>
            ) : (
              <div className="flex min-h-48 flex-col items-center justify-center gap-2 px-5 pb-6 text-center">
                <p className="text-sm font-medium text-navy">Chưa có kết quả đánh giá</p>
                <p className="max-w-md text-sm text-muted">{cat === 'all' ? 'Chưa có execution artifact hợp lệ cho bộ câu hỏi này; các chỉ số chưa đo.' : `Nhóm ${cat} (${categoryCounts?.[cat] ?? 0} câu): Chưa đo.`}</p>
              </div>
            )}
          </Card>

          {(selectedJob || data.value || row) && <Card title="Artifact KAG · API thật">
            <div className="px-5 pb-5 text-xs space-y-2 break-words">
              {selectedJob && <>
                <p>Job: {selectedJob.run_id_job} · Fingerprint: {selectedJob.graph_fingerprint}</p>
                <p>Dataset hash: {selectedJob.dataset_hash} · {selectedJob.dataset_status} · frozen_at: {selectedJob.frozen_at ?? '—'}</p>
                <p>Provider requests · embedding: {selectedJob.provider_requests.embedding} · chat: {selectedJob.provider_requests.chat}</p>
                {Object.entries(selectedJob.metrics ?? {}).map(([m, metrics]) => <div key={m} className="space-y-1">
                  <p>{m} · Đã xử lý: {metrics.requested_count} · Không đủ điều kiện: {metrics.ineligible_count} · Lỗi: {metrics.failed_count}</p>
                  <p>Latency mean: <MetricBar value={metrics.latency_ms.all_attempted.mean} kind="latency" /></p>
                  <p>Failure rate: <MetricBar value={metrics.failure_rate.value} kind="ratio" /></p>
                </div>)}
              </>}
              {data.value && (
                <details>
                  <summary className="cursor-pointer underline">Danh tính graph và cấu hình quan sát</summary>
                  <p className="mt-1">Fingerprint: {data.value.graph_fingerprint}</p>
                  <p>Source catalog SHA-256: {data.value.source_catalog_sha256}</p>
                  <p>Model: {data.value.providers.configured_chat_model ?? 'Chưa cấu hình'} · upstream chưa xác minh</p>
                </details>
              )}
              {row && (
                <>
                  <p>
                    {row.dataset_hash} · eligible {row.eligible_count} · ineligible {row.ineligible_count}
                  </p>
                  <p>
                    {row.eligibility_scope} · {row.reason}
                  </p>
                  <p>
                    Review: {row.smoke?.review_status ?? 'Chưa có'} · official {String(row.official_benchmark)} · state{' '}
                    {row.smoke?.state ?? 'NOT_RUN'}
                  </p>
                  {Object.entries(row.smoke?.runs || {}).map(([mode, run]) => (
                    <details key={mode}>
                      <summary className="cursor-pointer underline">
                        {mode}: {run?.status ?? 'NOT_RUN'}
                      </summary>
                      {run ? (
                        <div className="mt-1 space-y-1">
                          <p>
                            Requested {run.requested_count} · Attempted {run.attempted_count} · Failed {run.failed_count} · Ineligible{' '}
                            {run.ineligible_count}
                          </p>
                          <p>
                            {run.started_at} → {run.finished_at}
                          </p>
                          <p>Latency mean: <MetricBar value={run.latency_ms.all_attempted.mean} kind="latency" /></p>
                          <pre className="whitespace-pre-wrap break-all">{JSON.stringify(run.configuration, null, 2)}</pre>
                          {Object.entries(run.metrics).map(([name, m]) => (
                            <p key={name}>
                              {name}: {m.value ?? (name === 'answer_correctness' ? 'Chưa có giám khảo' : 'Chưa đo')} · Scored {m.scored_count}/{m.eligible_count} · Failed{' '}
                              {m.failed_count} · Excluded {m.excluded_count}
                            </p>
                          ))}
                        </div>
                      ) : (
                        <p className="mt-1">Chưa có execution artifact hợp lệ; metrics chưa đo.</p>
                      )}
                    </details>
                  ))}
                  <details>
                    <summary className="cursor-pointer underline">Gold thiếu trong SAMPLE</summary>
                    {Object.entries(row.missing_gold).map(([k, ids]) => (
                      <p key={k} className="mt-1">
                        {k}: {ids.join(', ') || 'Không có'}
                      </p>
                    ))}
                  </details>
                </>
              )}
            </div>
          </Card>}
        </div>
      </div>

      <Card
        className="mt-6"
        title="Smoke test kiểm tra nhanh"
        right={
          <Button size="sm" variant="primary" onClick={() => notify('Chức năng đang phát triển')}>
            ▶ Chạy smoke <Badge tone="gray">Đang phát triển</Badge>
          </Button>
        }
      >
        <div className="px-5 pb-5 flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
          <span>Chạy nhanh bộ câu hỏi đối chứng trên đồ thị đang phục vụ.</span>
          <Badge tone="gray">Đang phát triển</Badge>
        </div>
      </Card>
    </Page>
  )
}
