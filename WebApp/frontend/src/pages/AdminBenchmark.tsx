import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useAdmin } from '../admin/store'
import { Badge, Button, Card, Page, Td, Th, inputCls } from '../admin/ui'
import { useInspection } from './server/KagManagement'
import { loadSampleInspection } from './server/kag-inspection'
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

  const catalog = data.value?.datasets
  const requestedDataset = params.get('dataset') ?? ''
  const row = catalog?.datasets.find((r) => r.id === requestedDataset) || catalog?.datasets[0]
  const categories: [string, number][] = Object.entries(row?.metadata?.category_counts || {})
  const maxCatCount = Math.max(1, ...categories.map(([, n]) => n))

  const rawCat = params.get('cat') ?? 'all'
  const cat = rawCat === 'all' || categories.some(([id]) => id === rawCat) ? rawCat : 'all'

  const runs = row?.smoke?.runs
  const measured = Object.entries(runs || {}).flatMap(([mode, run]) =>
    run
      ? Object.entries(cat === 'all' ? run.by_category ?? { 'Tất cả': run.metrics } : { [cat]: run.by_category?.[cat] || {} })
          .flatMap(([group, metrics]) => Object.entries(metrics).map(([name, m]) => ({
            ...parseMetric(mode, name),
            key: `${mode}.${group}.${name}`,
            name,
            value: m.value,
            group,
            n: group === 'Tất cả' ? run.requested_count : row?.metadata?.category_counts[group] ?? 0,
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

  return (
    <Page
      title="Benchmark"
      subtitle="Đọc catalog bộ câu hỏi và artifact đánh giá thực tế của KAG từ backend."
      actions={
        <Button variant="dark" onClick={() => notify('Chức năng đang phát triển')}>
          ▶ Chạy & đánh giá <Badge tone="gray">Đang phát triển</Badge>
        </Button>
      }
    >
      <Notice {...data} retry={data.reload} />

      <div className="grid gap-5 xl:grid-cols-[320px_minmax(0,1fr)]">
        <div className="space-y-5">
          <Card title="Bộ câu hỏi chuẩn" right={<span className="text-[11.5px] text-muted">{row?.record_count ?? '—'} câu</span>}>
            <div className="px-5 mb-4">
              <select
                aria-label="Dataset"
                className={inputCls}
                value={row?.id || ''}
                onChange={(e) => updateUrl({ dataset: e.target.value, cat: null })}
              >
                {catalog?.datasets.map((r) => (
                  <option key={r.id}>{r.id}</option>
                ))}
              </select>
              <p className="mt-2 text-xs text-muted">
                {row ? `${row.dataset_status} · ${row.dataset_eligibility}` : 'Chưa có catalog bộ câu hỏi'}
              </p>
            </div>
            {categories.length ? (
              <ul className="px-5 pb-5 space-y-1.5">
                {categories.map(([id, n]) => (
                  <li
                    key={id}
                    className={`grid grid-cols-[minmax(0,1fr)_80px_28px] items-center gap-2 text-[12.5px] cursor-pointer rounded px-1 py-0.5 ${
                      cat === id ? 'bg-selected font-medium text-navy' : 'text-text-secondary hover:bg-bg'
                    }`}
                    onClick={() => updateUrl({ cat: cat === id ? null : id })}
                    title={`${id}: ${n} câu`}
                  >
                    <span className="truncate">{id}</span>
                    <span className="h-2 rounded-r bg-line/50">
                      <span className="block h-full rounded-r bg-accent" style={{ width: `${(n / maxCatCount) * 100}%` }} />
                    </span>
                    <span className="text-right tabular-nums text-navy">{n}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-5 pb-5 text-xs text-muted">Chưa đọc được phân bố nhóm câu hỏi.</p>
            )}
          </Card>

          <Card title="Thiết lập & So sánh HybridRAG · NativeRAG" right={<Badge tone="gray">Đang phát triển</Badge>}>
            <div className="px-5 pb-5 space-y-3 text-xs text-muted">
              <p>Cấu hình tham số chạy benchmark trực tiếp từ WebApp và đối chiếu KAG với HybridRAG / NativeRAG.</p>
              <Button size="sm" onClick={() => notify('Chức năng đang phát triển')}>
                Cấu hình so sánh <Badge tone="gray">Đang phát triển</Badge>
              </Button>
            </div>
          </Card>
        </div>

        <div className="space-y-5 min-w-0">
          <Card
            title={cat === 'all' ? 'Kết quả đo KAG' : `${cat} · ${row?.metadata?.category_counts[cat] ?? '—'} câu${measured.length ? ` · ${countRange('scored')} đã chấm · ${countRange('excluded')} bị loại` : ' · Chưa đo'}`}
            right={
              <select
                className="rounded-lg border border-line bg-transparent px-2 py-1 text-[12px] text-navy"
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
                            <Th className="w-1/2 sm:w-auto !px-2">Metric</Th>
                            <Th className="w-[26%] sm:w-[22%] !px-2">Điểm</Th>
                            <Th className="w-[24%] sm:w-[14%] !px-2">Đã chấm</Th>
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
                              <Td className="!px-2"><MetricBar value={m.value} kind={metricKinds[m.name] ?? (rankingMetric.test(m.name) ? 'ratio' : 'count')} /></Td>
                              <Td className="!px-2">{m.scored}</Td>
                            </tr>
                          ))}
                        </tbody>
                      </table>}
                    </section>
                  )
                })}
              </div>
            ) : (
              <p className="px-5 pb-5 text-sm text-muted">{cat === 'all' ? 'Chưa có execution artifact hợp lệ cho bộ câu hỏi này; các chỉ số chưa đo.' : `Nhóm ${cat} (${row?.metadata?.category_counts[cat] ?? 0} câu): Chưa đo.`}</p>
            )}
          </Card>

          <Card title="Artifact KAG · API thật">
            <div className="px-5 pb-5 text-xs space-y-2 break-words">
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
                  {Object.entries(runs || {}).map(([mode, run]) => (
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
                              {name}: {m.value ?? 'Chưa đo'} · Scored {m.scored_count}/{m.eligible_count} · Failed{' '}
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
          </Card>

          <Card
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
        </div>
      </div>
    </Page>
  )
}
