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
      ? Object.entries(cat === 'all' ? run.metrics : run.by_category?.[cat] || {}).map(([name, m]) => ({
          key: `${mode}.${name}`,
          label: `${mode} · ${name}`,
          name,
          value: m.value,
          group: cat === 'all' ? 'Tất cả' : cat,
          n: cat === 'all' ? run.requested_count : row?.metadata?.category_counts[cat],
          scored: m.scored_count,
          excluded: m.excluded_count,
        }))
      : [],
  )

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
            title="Kết quả đo KAG"
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
              <>
              <p className="px-4 pb-2 text-xs text-muted">Cuộn ngang để xem đủ 6 cột.</p>
              <div className="max-h-[70vh] overflow-x-scroll pb-2" role="region" aria-label="Bảng kết quả benchmark" tabIndex={0}>
                <table className="w-full min-w-[800px]">
                  <thead className="border-y border-line">
                    <tr>
                      <Th>Nhóm</Th>
                      <Th>n</Th>
                      <Th>Metric</Th>
                      <Th>KAG (thực đo)</Th>
                      <Th>Đã chấm</Th>
                      <Th>Bị loại</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {measured.map((m) => (
                      <tr key={m.key} className="border-b border-line/60 last:border-0">
                        <Td>{m.group}</Td>
                        <Td>{m.n ?? '—'}</Td>
                        <Td className="whitespace-nowrap text-navy">{m.label}</Td>
                        <Td className="min-w-40">
                          <MetricBar value={m.value} kind={metricKinds[m.name] ?? (rankingMetric.test(m.name) ? 'ratio' : 'count')} />
                        </Td>
                        <Td>{m.scored}</Td>
                        <Td>{m.excluded}</Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              </>
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
