import { useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useAdmin } from '../admin/store'
import { apiResponse } from '../api'
import { Badge, Button, Card, Page, Td, Th, inputCls } from '../admin/ui'
import { useInspection } from './server/KagManagement'
import { loadBenchmarkDatasets, loadSampleInspection } from './server/kag-inspection'
import { Notice } from './server/shared'

const pct = (n: number) => (n * 100).toFixed(1) + '%'

function MetricBar({ value }: { value: number | null }) {
  if (value === null) return <span className="text-xs text-muted">Chưa đo</span>
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
  const datasetData = useInspection(loadBenchmarkDatasets)
  const fileInput = useRef<HTMLInputElement>(null)
  const [importName, setImportName] = useState('')
  const [busy, setBusy] = useState(false)
  const [importErrors, setImportErrors] = useState<{ index: number; field: string; code: string; message: string }[]>([])

  const catalog = data.value?.datasets
  const datasets = datasetData.value?.datasets ?? catalog?.datasets ?? []
  const requestedDataset = params.get('dataset') ?? ''
  const selected = datasets.find((r) => r.id === requestedDataset) || datasets[0]
  const row = catalog?.datasets.find((r) => r.id === selected?.id)
  const categories: [string, number][] = Object.entries(row?.metadata?.category_counts || {})
  const maxCatCount = Math.max(1, ...categories.map(([, n]) => n))

  const rawCat = params.get('cat') ?? 'all'
  const cat = rawCat === 'all' || categories.some(([id]) => id === rawCat) ? rawCat : 'all'

  const runs = row?.smoke?.runs
  const measured = Object.entries(runs || {}).flatMap(([mode, run]) =>
    run
      ? Object.entries(run.metrics).map(([name, m]) => ({
          key: `${mode}.${name}`,
          label: `${mode} · ${name}`,
          value: m.value,
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
      actions={
        <Button variant="dark" onClick={() => notify('Chức năng đang phát triển')}>
          ▶ Chạy & đánh giá <Badge tone="gray">Đang phát triển</Badge>
        </Button>
      }
    >
      <Notice {...data} retry={data.reload} />
      <Notice {...datasetData} retry={datasetData.reload} />

      <div className="grid gap-5 xl:grid-cols-[320px_minmax(0,1fr)]">
        <div className="space-y-5">
          <Card title="Bộ câu hỏi chuẩn" right={<span className="text-[11.5px] text-muted">{selected?.record_count ?? '—'} câu</span>}>
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
                    onChange={(e) => setImportName(e.target.value)} placeholder="bo-cau-hoi-01" />
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
            {cat !== 'all' ? (
              <div className="px-5 pb-5 text-sm text-muted">
                Nhóm <strong className="text-navy">{cat}</strong> ({categories.find(([id]) => id === cat)?.[1] ?? 0} câu): artifact hiện chỉ tổng hợp theo toàn bộ tập câu hỏi, chưa tách metric từng nhóm.
              </div>
            ) : measured.length ? (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[480px]">
                  <thead className="border-y border-line">
                    <tr>
                      <Th>Metric</Th>
                      <Th>KAG (thực đo)</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {measured.map((m) => (
                      <tr key={m.key} className="border-b border-line/60 last:border-0">
                        <Td className="whitespace-nowrap text-navy">{m.label}</Td>
                        <Td>
                          <MetricBar value={m.value} />
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="px-5 pb-5 text-sm text-muted">Chưa có execution artifact hợp lệ cho bộ câu hỏi này; các chỉ số chưa đo.</p>
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
                          <p>Latency mean: {run.latency_ms.all_attempted.mean ?? 'Chưa đo'} ms</p>
                          <pre className="whitespace-pre-wrap break-all">{JSON.stringify(run.configuration, null, 2)}</pre>
                          {Object.entries(run.metrics).map(([name, m]) => (
                            <p key={name}>
                              {name}: {m.value ?? 'UNAVAILABLE / NOT_APPLICABLE'} · Scored {m.scored_count}/{m.eligible_count} · Failed{' '}
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
