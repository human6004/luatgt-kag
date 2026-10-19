import { useEffect, useRef, useState } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { Page, Button, Card, Progress, Field, inputCls } from "../../admin/ui"
import { Notice, inputClass } from "./shared"
import {
  loadKagStatus,
  loadPipelineStatus,
  loadSampleInspection,
  inspectionError,
} from "./kag-inspection"
import {
  loadBuilderStatus,
  runBuilderAction,
  builderStateLabel,
  loadBuilderInputs, loadBuilderConfiguration, saveBuilderConfiguration, checkBuilderReadiness,
  loadBuilderProjects, builderNeo4jLink, loadBuilderStructure, prepareBuilderStructure,
  previewBuilderSelection,
  loadBuilderClear, clearBuilderData,
} from "./kag-inspection"
import type { BuilderStatus, BuilderConfiguration, BuilderInputs, BuilderStage, BuilderStructure, BuilderSelection, SelectionRequest, SelectionSummary, BuilderClear } from "./kag-inspection"
import { ApiError } from "../../api"

export function useInspection<T>(load: (signal?: AbortSignal) => Promise<T>) {
  const [value, setValue] = useState<T>(),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [version, setVersion] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError("")
    setValue(undefined)
    load(controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setValue(result)
      })
      .catch((failure) => {
        if (!controller.signal.aborted) setError(inspectionError(failure))
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [load, version])
  return { value, setValue, error, loading, reload: () => setVersion((v) => v + 1) }
}

async function loadOverview(signal?: AbortSignal) {
  const status = await loadKagStatus(signal)
  try {
    return {
      status,
      sample: await loadSampleInspection(signal),
      sampleError: "",
    }
  } catch (error) {
    return { status, sample: undefined, sampleError: inspectionError(error) }
  }
}

export function KagOverview() {
  const data = useInspection(loadOverview),
    status = { value: data.value?.status },
    sample = { value: data.value?.sample },
    providers = sample.value?.providers
  return (
    <section className="mt-8 border-t border-line pt-5 min-w-0">
      <div className="flex flex-wrap justify-between gap-3">
        <h2 className="font-semibold">Vận hành KAG SAMPLE</h2>
        <Button disabled={data.loading} onClick={data.reload}>
          Kiểm tra KAG
        </Button>
      </div>
      <Notice {...data} retry={data.reload} />
      <Notice error={data.value?.sampleError} retry={data.reload} />
      {status.value && (
        <dl className="mt-3 text-sm">
          {Object.entries({
            liveness: "API liveness",
            queryReadiness: "Query",
            retrievalReadiness: "Retrieval",
            vectorRetrievalReadiness: "Vector retrieval",
            release: "Release artifact",
          }).map(([key, label]) => {
            const check =
              status.value![(key as keyof NonNullable<typeof status.value>)]
            return (
              <div
                key={key}
                className="flex flex-wrap justify-between gap-3 border-b border-line py-2"
              >
                <dt>{label}</dt>
                <dd>
                  {check.state}
                  {check.code ? ` · ${check.code}` : ""}
                </dd>
              </div>
            )
          })}
        </dl>
      )}
      {sample.value && (
        <div className="mt-4 text-sm space-y-2 break-words">
          <p>Release SAMPLE: {sample.value.release_id}</p>
          <p>
            Backend đã xác minh: {sample.value.backend.database} ·{" "}
            {sample.value.backend.namespace} · READ-ONLY
          </p>
          <p>
            Graph: {sample.value.counts.nodes} node ·{" "}
            {sample.value.counts.edges} cạnh · {sample.value.counts.vectors}{" "}
            vector
          </p>
          <p>Kiểm tra lúc: {sample.value.verified_at}</p>
        </div>
      )}
      {providers && (
        <div className="mt-4 text-sm space-y-2">
          <p>
            Provider: {providers.state} · embedding{" "}
            {providers.attempts?.embedding ?? "Chưa đo"} · chat{" "}
            {providers.attempts?.chat ?? "Chưa đo"} request outbound trong
            ledger.
          </p>
          <p className="break-words">
            Model cấu hình: {providers.configured_chat_model ?? "Chưa cấu hình"}{" "}
            · {providers.configured_embedding_model ?? "Chưa cấu hình"}
          </p>
          <p>
            Upstream/proxy retry: chưa đo. Danh tính backend chính xác: NOT
            VERIFIED. Readiness không gọi provider.
          </p>
          <details>
            <summary className="cursor-pointer underline">
              Request và lỗi gần đây của process hiện tại
            </summary>
            <p className="mt-2">
              Từ: {providers.receipt_window?.since ?? "Chưa có cửa sổ quan sát"}
            </p>
            {providers.receipt_window?.recent.length ? (
              providers.receipt_window.recent.map((r, i) => (
                <p key={i} className="py-2 break-words border-b border-line">
                  {r.timestamp} · {r.kind} · {r.source_component} · {r.outcome}{" "}
                  · HTTP {r.status ?? "—"} · {r.latency_ms ?? "—"} ms · request{" "}
                  {r.request_id ?? "Không có"}
                </p>
              ))
            ) : (
              <p>
                Chưa có request trong cửa sổ này; không chứng minh provider hoạt
                động.
              </p>
            )}
          </details>
        </div>
      )}
      <p className="text-sm mt-4">
        Production WRITE: BLOCKED. Artifact, runtime capability và SAMPLE
        acceptance được kiểm tra riêng.
      </p>
      <Link to="/admin/docker" className="inline-block mt-3 underline">
        Kết nối dịch vụ và kiểm thử Retrieval
      </Link>
    </section>
  )
}

export function Graph() {
  const data = useInspection(loadSampleInspection),
    [query, setQuery] = useState(""),
    [selected, setSelected] = useState("")
  const sample = data.value,
    nodes =
      sample?.nodes.filter((n) =>
        `${n.entity_type} ${n.entity_id} ${n.properties.title ?? n.properties.ten ?? ""}`
          .toLowerCase()
          .includes(query.toLowerCase()),
      ) ?? []
  const node = sample?.nodes.find(
    (n) => JSON.stringify([n.entity_type, n.entity_id]) === selected,
  )
  const relations = node
    ? (sample?.edges.filter(
        (e) =>
          (e.from[0] === node.entity_type && e.from[1] === node.entity_id) ||
          (e.to[0] === node.entity_type && e.to[1] === node.entity_id),
      ) ?? [])
    : []
  return (
    <Page
      title="Đồ thị của tôi"
      subtitle="Đọc graph SAMPLE thực qua broker; kiểm tra fingerprint trước và sau. Không có quyền ghi."
      actions={
        <Button disabled={data.loading} onClick={data.reload}>
          Kiểm tra lại
        </Button>
      }
    >
      <Notice {...data} retry={data.reload} />
      {sample && (
        <>
          <div className="grid sm:grid-cols-3 gap-4 mb-5">
            {[
              ["Nodes", sample.counts.nodes],
              ["Quan hệ", sample.counts.edges],
              ["Vectors", sample.counts.vectors],
            ].map(([label, value]) => (
              <Card key={label} className="p-5">
                <p className="text-xs text-muted">{label}</p>
                <p className="text-3xl font-semibold mt-3">{value}</p>
              </Card>
            ))}
          </div>
          <div className="grid lg:grid-cols-2 gap-5 mb-5">
            {[
              ["Loại node", sample.nodes.map((n) => n.entity_type)],
              ["Loại quan hệ", sample.edges.map((e) => e.predicate)],
            ].map(([title, types]) => (
              <Card key={String(title)} title={String(title)}>
                <div className="px-5 pb-5 space-y-3">
                  {Object.entries(
                    (types as string[]).reduce<Record<string, number>>(
                      (counts, type) => {
                        counts[type] = (counts[type] || 0) + 1
                        return counts
                      },
                      {},
                    ),
                  ).map(([type, count]) => (
                    <div
                      key={type}
                      className="grid grid-cols-[minmax(0,1fr)_60px] gap-3 text-xs"
                    >
                      <div>
                        <p className="break-words mb-1">{type}</p>
                        <Progress
                          value={(count / (types as string[]).length) * 100}
                        />
                      </div>
                      <p className="text-right">{count}</p>
                    </div>
                  ))}
                </div>
              </Card>
            ))}
          </div>
          <div className="py-4 text-sm space-y-2 break-words">
            <p>
              {sample.counts.nodes} node · {sample.counts.edges} cạnh ·{" "}
              {sample.counts.vectors} vector · READ-ONLY
            </p>
            <p>
              {sample.backend.database} · {sample.backend.namespace} · backend
              đã xác minh lúc {sample.verified_at}
            </p>
            <p>
              Database ID: {sample.backend.database_id} · Server ID:{" "}
              {sample.backend.server_id}
            </p>
            <p className="break-all">Fingerprint: {sample.graph_fingerprint}</p>
            <p>Release: {sample.release_id}</p>
          </div>
          <label className="block text-sm">
            Tìm node theo mã hoặc tên
            <input
              className={`${inputClass} mt-2`}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <div className="grid lg:grid-cols-[minmax(0,1fr)_minmax(0,360px)] gap-5 mt-5 min-w-0">
            <div
              className="max-h-[600px] overflow-y-auto min-w-0 rounded-2xl border border-line bg-surface p-3"
              aria-label="Danh sách node"
            >
              {!nodes.length && <p>Không có node phù hợp.</p>}
              {nodes.map((n) => (
                <button
                  type="button"
                  key={JSON.stringify([n.entity_type, n.entity_id])}
                  aria-pressed={node === n}
                  onClick={() =>
                    setSelected(JSON.stringify([n.entity_type, n.entity_id]))
                  }
                  className="block text-left w-full border-b border-line py-3 px-2 hover:bg-surface-2 focus-visible:outline break-words"
                >
                  <span className="block text-xs text-muted">
                    {n.entity_type}
                  </span>
                  <span className="text-sm">{n.entity_id}</span>
                </button>
              ))}
            </div>
            <section
              className="min-w-0 rounded-2xl border border-line bg-surface p-5"
              aria-label="Chi tiết node"
            >
              {node ? (
                <>
                  <h2 className="font-semibold break-words">
                    {node.entity_id}
                  </h2>
                  <dl className="text-sm mt-3">
                    {Object.entries(node.properties).map(([key, value]) => (
                      <div key={key} className="py-2 border-b border-line">
                        <dt className="font-medium">{key}</dt>
                        <dd className="whitespace-pre-wrap break-words mt-1">
                          {typeof value === "string"
                            ? value
                            : JSON.stringify(value)}
                        </dd>
                      </div>
                    ))}
                  </dl>
                  <h3 className="font-semibold mt-5">Nguồn đã xác minh</h3>
                  {node.sources.map((s) => (
                    <details
                      key={s.evidence_id}
                      className="mt-3 text-xs break-all"
                    >
                      <summary className="cursor-pointer">
                        {s.field} · Evidence {s.evidence_id}
                      </summary>
                      <p className="mt-2">SHA-256 nguồn: {s.source_sha256}</p>
                    </details>
                  ))}
                  <h3 className="font-semibold mt-5">
                    Quan hệ ({relations.length})
                  </h3>
                  {relations.map((e, i) => {
                    const other =
                      e.from[0] === node.entity_type &&
                      e.from[1] === node.entity_id
                        ? e.to
                        : e.from
                    return (
                      <div key={i} className="text-sm mt-3 break-words">
                        <p>
                          {e.from[1]} → {e.predicate} → {e.to[1]}
                        </p>
                        <button
                          type="button"
                          className="underline mt-1"
                          onClick={() => setSelected(JSON.stringify(other))}
                        >
                          Mở {other[1]}
                        </button>
                        {Object.keys(e.properties).length > 0 && (
                          <pre className="whitespace-pre-wrap break-words text-xs">
                            {JSON.stringify(e.properties, null, 2)}
                          </pre>
                        )}
                      </div>
                    )
                  })}
                  {!relations.length && (
                    <p className="mt-2 text-sm">
                      Không có cạnh nối node này trong SAMPLE.
                    </p>
                  )}
                </>
              ) : (
                <p className="text-sm text-muted">
                  Chọn node để đọc thuộc tính, nguồn và điều hướng cạnh thực.
                </p>
              )}
            </section>
          </div>
        </>
      )}
    </Page>
  )
}

function builderIssue(code: string | null) {
  const messages: Record<string, string> = {
    CONFIG: 'Kiểm tra đích lưu và cấu hình Embedding, lưu lại cấu hình dựng rồi kiểm tra sẵn sàng.',
    INDEX: 'Thiếu hoặc sai chỉ mục vector. Về Cấu hình → Xem thay đổi để kiểm schema/index; index không tương thích cần project riêng hoặc quản trị di chuyển có chủ đích.',
    SCHEMA: 'Schema đích thiếu hoặc khác cấu trúc LuậtGT. Về Cấu hình → Xem thay đổi trước khi chuẩn bị cấu trúc.',
    SCHEMA_CUSTOM: 'Có định nghĩa tùy chỉnh, khác mẫu mặc định hoặc phụ thuộc/index chưa rõ. Đã chặn xóa; xem danh sách xung đột. Chọn project riêng hoặc nhờ quản trị xử lý có chủ đích.',
    SCHEMA_DATA: 'Database đã có dữ liệu. Sync schema native có thể dựng lại index nên thao tác tự động bị chặn. Chọn project riêng hoặc di chuyển có chủ đích.',
    SCHEMA_REINDEX: 'Schema còn thiếu nhưng đã có chỉ mục nội dung đúng. Sync native có thể dựng lại các chỉ mục này; cần quản trị xử lý có chủ đích.',
    STRUCTURE_STALE: 'Bản xem trước đã cũ. Bấm Xem thay đổi, đọc lại tác động rồi xác nhận lại.',
    STRUCTURE_INTERRUPTED: 'Worker đã khởi động lại khi chuẩn bị cấu trúc. Kết quả chưa xác định. Bấm Xem thay đổi để đọc lại; không tự gửi lại apply.',
    CLEAR_DENIED: 'Deployment chưa cấp quyền xóa cho đúng project và physical database này. Nhờ quản trị kiểm cấu hình KAG_BUILDER_CLEAR_TARGETS.',
    CLEAR_SHARED: 'Database đang dùng chung với project khác hoặc chưa chứng minh được đích riêng. Không thể xóa bằng Builder.',
    CLEAR_SERVING: 'Database đang được runtime hoặc release Chat tham chiếu. Thao tác xóa bị chặn.',
    CLEAR_STALE: 'Đích, dữ liệu, cấu trúc hoặc quyền xóa đã đổi. Xem trước lại và kiểm tác động trước khi xác nhận.',
    CLEAR_UNCERTAIN: 'Chưa xác định giao dịch xóa đã kết thúc. Khóa được giữ; nhờ quản trị đối soát trước khi thử lại. Không tự xóa khóa.',
    TARGET_MODEL: 'Vector hiện có không khớp model hoặc thiếu lịch sử xác minh. Chọn project rỗng, hoặc dùng đúng model và lịch sử phiên đã dựng đích này; không chỉ dựa vào số chiều.',
    FORBIDDEN: 'Đăng nhập lại OpenSPG, kiểm quyền sở hữu project rồi tải lại danh sách.',
    NOT_FOUND: 'Project đã bị xóa hoặc không còn thuộc quyền sở hữu. Tải lại danh sách và chọn lại.',
    CONNECTION_NOT_CONFIGURED: 'graph_store đã đổi hoặc chưa thuộc kết nối deployment cấp. Quản trị cần kiểm cấu hình hạ tầng.',
    SERVING_PROTECTED: 'Database này đang dành cho Chat. Chọn project trên database khác.',
    LOCK: 'Đích đang bị khóa hoặc lần ghi trước chưa rõ kết quả. Giữ nguyên khóa; nhờ quản trị kiểm tra trước khi tiếp tục.',
    LOCK_MOUNT: 'Chưa có volume khóa dùng chung hợp lệ. Kiểm tra cài đặt Worker rồi thử lại.',
    INTEGRITY: 'Dữ liệu hoặc điểm lưu không khớp. Giữ nguyên phiên và kiểm tra phiên bản nguồn, cấu hình và đích lưu.',
    VECTORS: 'Chưa tạo đủ vector. Kiểm tra model Embedding và lỗi dịch vụ trước khi xử lý phiên này.',
    PROVIDER_BUDGET: 'Đã chạm giới hạn request của phiên. Không thể làm mới hạn mức bằng Tiếp tục.',
    INTERRUPTED: 'Điểm dừng đã được lưu. Kiểm tra sẵn sàng rồi tiếp tục đúng phiên.',
    RUNTIME: 'Dịch vụ dựng gặp lỗi. Giữ nguyên phiên và kiểm tra Worker trước khi xử lý.',
    SCOPE: 'Đích hoặc quyền ghi chưa hợp lệ. Kiểm tra cấu hình deployment và danh tính database.',
  }
  return code ? messages[code] ?? 'Điều kiện dựng chưa đạt. Kiểm tra cấu hình và chi tiết kỹ thuật trước khi thử lại.' : ''
}
function builderTime(value: string) { return new Date(value).toLocaleString('vi-VN') }

function BuilderResult({ status, link = true, links }: { status: BuilderStatus; link?: boolean; links?: BuilderConfiguration['links'] }) {
  if (status.state === 'CLEARED') return <p>Dữ liệu đích đã được yêu cầu xóa. Kết quả phiên cũ chỉ là lịch sử, không chứng minh graph hiện tại. Xem kết quả xóa rồi cấu hình phiên mới.</p>
  if (status.state === 'ABANDONED') return <p>Đã bỏ phiên; graph và điểm lưu được giữ. Phiên này không thể tiếp tục và chưa có kết quả xác minh hoàn tất.</p>
  if (status.contract_version === 'builder-control-v1' || status.binding?.scope !== 'PRODUCTION' || status.state !== 'COMPLETE' || !status.result)
    return <p>Chưa có kết quả xác minh của phiên dựng dữ liệu ứng dụng.</p>
  const { binding, result } = status
  return <div className="space-y-4 text-sm">
    <p className="break-words">Đích đã xác minh: {binding.database} · project {binding.project_id}</p>
    <p>{binding.node_limit ? `Phạm vi giới hạn tối đa ${binding.node_limit} nội dung; chưa dựng và chưa xác minh toàn corpus.` : 'Phạm vi: toàn bộ corpus đã chốt cho phiên.'}</p>
    <dl className="grid grid-cols-3 gap-3">
      {([['Nội dung đã xác minh', result.nodes], ['Quan hệ đã xác minh', result.edges], ['Vector đã xác minh', result.vectors]] as const).map(([label, count]) =>
        <div key={label}><dt className="text-muted">{label}</dt><dd className="text-xl font-semibold tabular-nums mt-1">{count.toLocaleString('vi-VN')}</dd></div>)}
    </dl>
    <p>Xác minh lúc {builderTime(result.verified_at)} · {result.indexes} chỉ mục, {result.dimension} chiều.</p>
    <p>Build không tự kích hoạt Chat. Chọn phiên và dùng cho Chat tại Đồ thị của tôi.</p>
    {link && <Link className="underline inline-block" to={`/admin/graph?project_id=${binding.project_id}&run_id=${encodeURIComponent(binding.run_id)}`}>Xem đồ thị và kiểm tra để dùng cho Chat</Link>}
    {links && <a className="underline block" target="_blank" rel="noreferrer" href={builderNeo4jLink(links, binding.database)}>Mở Neo4j · {binding.database}</a>}
    <p>Nếu Browser chưa chọn đúng database, chạy <code>:use {binding.database}</code>.</p>
    <p>Xem tối đa 25 node hoặc quan hệ bằng truy vấn chỉ đọc:</p>
    <pre className="overflow-x-auto text-xs"><code>{'MATCH (n) RETURN n LIMIT 25;\nMATCH (a)-[r]->(b) RETURN a, r, b LIMIT 25;'}</code></pre>
    <p>Knowledge Model trong OpenSPG hiển thị cấu trúc. Neo4j Browser hiển thị dữ liệu sau Build.</p>
    <details><summary className="cursor-pointer underline">Chi tiết kỹ thuật kết quả</summary><dl className="mt-3 space-y-2 break-all">
      {Object.entries(binding).map(([name, value]) => <div key={name}><dt className="font-medium">{name}</dt><dd>{value}</dd></div>)}
      <div><dt className="font-medium">Fingerprint</dt><dd>{result.fingerprint}</dd></div>
    </dl></details>
  </div>
}

export function BuilderGraph({ runId }: { runId: string }) {
  const data = useInspection(loadBuilderStatus)
  const configuration = useInspection(loadBuilderConfiguration)
  return <Page title="Xác minh đồ thị" subtitle="Kết quả Worker đã xác minh cho phiên và đích dựng được yêu cầu."
    actions={<Link to="/admin/pipeline" className="underline text-sm">Về Dựng đồ thị</Link>}>
    <Notice {...data} retry={data.reload} />
    {data.value && (data.value.run_id !== runId ? <p role="alert">Phiên được yêu cầu không khớp kết quả hiện tại.</p> :
      <Card title="Kết quả xác minh"><div className="px-5 pb-5"><BuilderResult status={data.value} link={false} links={configuration.value?.links} /></div></Card>)}
    <p className="text-sm text-muted mt-4">Đây là kết quả lần xác minh đã lưu. Trang này không truy vấn lại toàn bộ graph.</p>
  </Page>
}

const builderRows: { label: string; stages: [BuilderStage, string, string][] }[] = [
  { label: 'Chuẩn bị dữ liệu', stages: [['preflight', 'Kiểm điều kiện', 'lần kiểm'], ['plan', 'Kế hoạch nguồn', 'kế hoạch']] },
  { label: 'Tạo vector', stages: [['vectorize', 'Tạo vector', 'nội dung'], ['export-artifact', 'Lưu vector', 'batch']] },
  { label: 'Ghi nội dung', stages: [['write-nodes', 'Ghi nội dung', 'nội dung'], ['verify-nodes', 'Kiểm nội dung', 'nội dung']] },
  { label: 'Ghi quan hệ', stages: [['write-edges', 'Ghi quan hệ', 'quan hệ']] },
  { label: 'Xác minh kết quả', stages: [['verify', 'Kiểm graph trong phạm vi phiên', 'lần kiểm'], ['release', 'Lưu kết quả', 'kết quả']] },
]
const stageLabels = { PENDING: 'Chưa thực hiện', RUNNING: 'Đang xử lý', COMPLETE: 'Đã đạt', STOPPED: 'Đã dừng', BLOCKED: 'Cần xử lý' }
type BuilderSnapshot = { inputs: BuilderInputs; config: BuilderConfiguration; status: BuilderStatus }
const sourceTypeLabels: Record<string, string> = { LegalDocument: 'Văn bản pháp luật', LegalUnit: 'Đơn vị nội dung', TrafficSign: 'Biển báo' }
function ScopeCounts({ summary }: { summary: SelectionSummary }) {
  return <div className="space-y-2"><dl className="grid gap-2 sm:grid-cols-3">{Object.entries(summary.node_counts).map(([name, count]) => <div key={name}><dt className="text-muted">{sourceTypeLabels[name] ?? name}</dt><dd className="font-medium tabular-nums">{count.toLocaleString('vi-VN')}</dd></div>)}</dl>
    <p>{summary.nodes.toLocaleString('vi-VN')} nội dung · {summary.edges.toLocaleString('vi-VN')} quan hệ · {summary.excluded_edges.toLocaleString('vi-VN')} quan hệ ngoài phạm vi.</p>
    <details><summary className="underline cursor-pointer">Số lượng theo quan hệ</summary><dl className="mt-2 space-y-1 break-words">{Object.entries(summary.edge_counts).map(([name, count]) => <div key={name}>{name}: {count.toLocaleString('vi-VN')}</div>)}</dl></details></div>
}

export function BuilderControls() {
  const [parameters]=useSearchParams()
  const [snapshot, setSnapshot] = useState<BuilderSnapshot>(), [connectionError, setConnectionError] = useState(''),
    [actionError, setActionError] = useState(''), [busy, setBusy] = useState(false), [version, setVersion] = useState(0),
    [selected, setSelected] = useState<number | null>(null), [batch, setBatch] = useState('64'), [limit, setLimit] = useState(''),
    [confirmation, setConfirmation] = useState<BuilderSnapshot>(), [nodeLimit, setNodeLimit] = useState(''),
    [scopeMode, setScopeMode] = useState<SelectionRequest['mode']>('ALL'), [scopePreview, setScopePreview] = useState<BuilderSelection>(),
    [receivedAt, setReceivedAt] = useState(''),
    [confirmAction, setConfirmAction] = useState<'build' | 'abandon'>('build'),
    [clearState, setClearState] = useState<BuilderClear>(), [clearConfirmation, setClearConfirmation] = useState<BuilderClear>(), [clearDatabase, setClearDatabase] = useState(''),
    [unlimited, setUnlimited] = useState(true), [projectId, setProjectId] = useState(''),
    [structure, setStructure] = useState<BuilderStructure>(), [structureConfirmation, setStructureConfirmation] = useState<BuilderStructure>()
  const catalog = useInspection(loadBuilderProjects)
  const acting = useRef(false), dialog = useRef<HTMLDialogElement>(null)
  const structureDialog = useRef<HTMLDialogElement>(null)
  const progressRegion = useRef<HTMLDivElement>(null)
  const clearDialog = useRef<HTMLDialogElement>(null)
  const inputs = snapshot?.inputs, config = snapshot?.config, status = snapshot?.status, source = inputs?.source_validation
  useEffect(() => {
    if (busy) return
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>
    async function refresh() {
      try {
        const [inputs, config, status, structure, clear] = await Promise.all([loadBuilderInputs(controller.signal), loadBuilderConfiguration(controller.signal), loadBuilderStatus(controller.signal), loadBuilderStructure(controller.signal), loadBuilderClear(controller.signal)])
        if (!controller.signal.aborted) { setSnapshot({ inputs, config, status }); setStructure(structure); setClearState(clear); setConnectionError(''); setReceivedAt(new Date().toISOString()) }
      } catch (failure) {
        if (!controller.signal.aborted) setConnectionError(inspectionError(failure))
      } finally { if (!controller.signal.aborted) timer = setTimeout(refresh, 3000) }
    }
    refresh()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [version, busy])
  useEffect(() => { if (config) { setBatch(String(config.batch_size)); setLimit(config.request_limit === null ? '' : String(config.request_limit)); setUnlimited(config.request_limit === null); const request = config.selection?.request ?? { mode: config.selection?.node_limit == null ? 'ALL' : 'COUNT', value: config.selection?.node_limit ?? null }; setScopeMode(request.mode); setNodeLimit(request.value == null ? '' : String(request.value)); setScopePreview(undefined); setProjectId(!status || ['RUNNING','STOPPING','STOPPED'].includes(status.state) ? String(config.target?.project_id ?? '') : parameters.get('project_id') ?? String(config.target?.project_id ?? '')) } }, [config?.revision])
  useEffect(() => {
    if (confirmation && !dialog.current?.open) dialog.current?.showModal()
    if (!confirmation && dialog.current?.open) dialog.current.close()
  }, [confirmation])
  useEffect(() => {
    if (structureConfirmation && !structureDialog.current?.open) structureDialog.current?.showModal()
    if (!structureConfirmation && structureDialog.current?.open) structureDialog.current.close()
  }, [structureConfirmation])
  useEffect(() => {
    if (clearConfirmation && !clearDialog.current?.open) { setClearDatabase(''); clearDialog.current?.showModal() }
    if (!clearConfirmation && clearDialog.current?.open) clearDialog.current.close()
  }, [clearConfirmation])
  const full = !!status && status.contract_version !== 'builder-control-v1' && status.production_write === 'CONFIGURED'
  const preparingStructure = structure?.state === 'APPLYING'
  const clearing = !!clearState && ['APPLYING','PARTIAL','INTERRUPTED'].includes(clearState.state)
  const active = clearing || preparingStructure || !!status && ['RUNNING', 'STOPPING', 'STOPPED'].includes(status.state)
  const sourceReady = source?.state === 'VALID', ready = config?.readiness.state === 'READY'
  const choice = catalog.value?.projects.find(row => String(row.project_id) === projectId)
  const scopeRequest: SelectionRequest = { mode: scopeMode, value: scopeMode === 'ALL' ? null : Number(nodeLimit) }
  const savedRequest = config?.selection?.request ?? { mode: config?.selection?.node_limit == null ? 'ALL' : 'COUNT', value: config?.selection?.node_limit ?? null }
  const dirty = !!config && (projectId !== String(config.target?.project_id ?? '') || batch !== String(config.batch_size) || unlimited !== (config.request_limit === null) || !unlimited && limit !== String(config.request_limit) || scopeRequest.mode !== savedRequest.mode || scopeRequest.value !== savedRequest.value)
  const previewMatches = sourceReady && scopePreview?.revision === config?.revision && scopePreview?.request.mode === scopeRequest.mode && scopePreview?.request.value === scopeRequest.value
  const modelReady = !!config?.embedding?.tested && config.embedding.key_configured && config.embedding.dimension !== null && config.embedding.dimension >= 1 && config.embedding.dimension <= 65536
  const disabled = busy || !!connectionError || !snapshot
  const recommended = preparingStructure ? 1 : status?.state === 'COMPLETE' && full ? 4 : active ? 3 : !sourceReady ? 0 : !config?.saved ? 1 : !ready ? 2 : 3
  const step = selected ?? recommended
  const canBuild = !disabled && !dirty && full && sourceReady && ready && status.actions.build
  const canAbandon = !disabled && !preparingStructure && status?.actions.abandon === true
  const validNumbers = /^\d+$/.test(batch) && Number(batch) >= 1 && Number(batch) <= 4096 &&
    (unlimited || /^\d+$/.test(limit) && Number(limit) >= 1 && Number(limit) <= 1000000) &&
    (scopeMode === 'ALL' || /^\d+$/.test(nodeLimit) && Number(nodeLimit) >= (scopeMode === 'COUNT' ? 3 : 1) && Number(nodeLimit) <= (scopeMode === 'COUNT' ? source?.nodes ?? 0 : 100))
  const confirmationKey = (value?: BuilderSnapshot) => JSON.stringify([value?.config.revision, value?.config.target, value?.config.embedding, value?.config.selection, value?.inputs.source_validation.plan_sha256,value?.status.run_id,value?.status.state])
  const structureMatches = !!structure?.report && structure.report.target.project_id === Number(projectId) && structure.revision === config?.revision
  const canPrepareStructure = !disabled && !active && structureMatches && structure?.can_apply === true && !!structure.report?.index_changes
  const canPreviewClear = !disabled && config?.saved && !dirty && !preparingStructure && clearState?.state !== 'APPLYING' && !!status && ['IDLE','COMPLETE','ABANDONED','CLEARED'].includes(status.state)
  const canApplyClear = canPreviewClear && clearState?.state === 'PREVIEW' && clearState.revision === config?.revision && clearState.report?.target.project_id === config?.target?.project_id
  async function changeClear(action: 'preview' | 'apply') {
    if (acting.current || !config || !canPreviewClear || action === 'apply' && (!canApplyClear || clearConfirmation?.preview_id !== clearState?.preview_id || clearDatabase !== clearState?.report?.target.database)) return
    acting.current = true; setBusy(true); setActionError(''); setClearConfirmation(undefined)
    try { setClearState(await clearBuilderData(action, config.revision, action === 'apply' ? clearState?.preview_id ?? undefined : undefined, action === 'apply' ? clearDatabase : undefined)) }
    catch (failure) { setActionError('Chưa xác định kết quả xóa. Tải lại trạng thái trước khi thử tiếp. ' + inspectionError(failure)) }
    finally { acting.current = false; setBusy(false); setVersion(value => value + 1) }
  }
  async function changeStructure(action: 'preview' | 'apply') {
    if (acting.current || !config || !choice || action === 'apply' && (!canPrepareStructure || structureConfirmation?.preview_id !== structure?.preview_id)) return
    acting.current = true; setBusy(true); setActionError(''); setStructureConfirmation(undefined)
    try { setStructure(await prepareBuilderStructure(action, choice.project_id, config.revision, action === 'apply' ? structure?.preview_id ?? undefined : undefined)) }
    catch (failure) { setActionError('Chưa xác định kết quả. Tải lại trạng thái để đọc kết quả server trước khi thử lại. ' + inspectionError(failure)) }
    finally { acting.current = false; setBusy(false); setVersion(value => value + 1) }
  }
  async function mutate(action: 'prepare' | 'preview' | 'save' | 'check' | 'build' | 'stop' | 'resume' | 'abandon') {
    if (acting.current || !snapshot) return
    if (action === 'build' && (!canBuild || confirmationKey(confirmation) !== confirmationKey(snapshot))) return
    if (action === 'abandon' && (!canAbandon || confirmationKey(confirmation) !== confirmationKey(snapshot))) return
    acting.current = true; setBusy(true); setActionError(''); setConfirmation(undefined)
    try {
      if (action === 'prepare') {
        const value = await loadBuilderInputs(undefined, true)
        setSnapshot(current => current && { ...current, inputs: value }); setSelected(null)
      } else if (action === 'preview' && config) {
        setScopePreview(await previewBuilderSelection(config.revision, scopeRequest))
      } else if (action === 'save' && config?.embedding && previewMatches) {
        const value = await saveBuilderConfiguration({ revision: config.revision, embedding_revision: config.embedding.revision, project_id: Number(projectId), batch_size: Number(batch), request_limit: unlimited ? null : Number(limit), selection_preview_id: scopePreview!.preview_id })
        setSnapshot(current => current && { ...current, config: value }); setSelected(2)
      } else if (action === 'check') {
        const value = await checkBuilderReadiness()
        setSnapshot(current => current && { ...current, config: value }); setSelected(null)
      } else if (action === 'build' || action === 'stop' || action === 'resume' || action === 'abandon') {
        const runId = action === 'build' ? `build-${crypto.randomUUID()}` : status?.run_id
        if (!runId) return
        const value = await runBuilderAction(action, runId, action === 'stop' ? undefined : config?.revision)
        setSnapshot(current => current && { ...current, status: value }); setSelected(action === 'abandon' ? 1 : 3)
        if (action === 'build' || action === 'resume') progressRegion.current?.focus()
      }
    } catch (failure) {
      setActionError(failure instanceof ApiError && failure.status === 409 ? 'Trạng thái hoặc cấu hình đã đổi. Tải lại, kiểm tra sẵn sàng rồi xác nhận lại.' :
        'Chưa xác định kết quả thao tác. Đợi trạng thái cập nhật; không gửi lại yêu cầu khi phiên đang chạy. ' + inspectionError(failure))
    } finally { acting.current = false; setBusy(false); setVersion(value => value + 1) }
  }
  const runModel = status && status.contract_version !== 'builder-control-v1' && status.binding ? status.binding.model_identity.split('|').at(-1) : config?.embedding?.model
  const headline = full && status?.run_id ? builderStateLabel(status.state) : ready && !dirty ? 'Sẵn sàng dựng đồ thị' : source?.state === 'CHECKING' ? 'Đang chuẩn bị dữ liệu' : 'Chuẩn bị dựng đồ thị'
  const steps = ['Dữ liệu', 'Cấu hình', 'Sẵn sàng', 'Đang dựng', 'Kết quả']
  const stepStates = [sourceReady ? 'Đã đạt' : source?.state === 'CHECKING' ? 'Đang xử lý' : ['INVALID', 'UNAVAILABLE'].includes(source?.state ?? '') ? 'Cần xử lý' : 'Chưa thực hiện',
    dirty ? 'Có thay đổi chưa lưu' : config?.saved ? 'Đã lưu' : 'Chưa lưu', dirty ? 'Cần lưu lại cấu hình' : ready ? 'Đã đạt' : config?.readiness.state === 'CHECKING' ? 'Đang kiểm tra' : config?.readiness.state === 'BLOCKED' ? 'Cần xử lý' : 'Chưa kiểm tra',
    status?.run_id && full ? builderStateLabel(status.state) : 'Chưa thực hiện', status?.state === 'COMPLETE' && full ? 'Đã xác minh' : 'Chưa có kết quả']
  const runDetail = status && status.contract_version !== 'builder-control-v1' ? status : undefined
  return <div className="space-y-5 min-w-0">
    <div className="flex flex-wrap justify-between items-start gap-3 text-sm">
      <div className="min-w-0"><p role="status" className="font-semibold">{headline}</p>
        {sourceReady && <p className="text-muted mt-1">Dự kiến: {(config?.selection?.nodes ?? source.nodes)?.toLocaleString('vi-VN')} nội dung · {(config?.selection?.edges ?? source.edges)?.toLocaleString('vi-VN')} quan hệ trong phạm vi {config?.selection?.node_limit ? 'giới hạn' : 'toàn bộ nguồn'}</p>}</div>
      <Button disabled={busy} onClick={() => setVersion(value => value + 1)}>Tải lại trạng thái</Button>
    </div>
    {connectionError && <p role="alert" className="border-l-2 border-amber-600 pl-3 text-sm">Đang kết nối lại. {snapshot ? `Giữ số liệu lúc ${builderTime(receivedAt)}. ` : ''}{connectionError}</p>}
    {actionError && <p role="alert" className="text-sm text-red-700">{actionError}</p>}
    {status?.state === 'ABANDONED' && <p role="status" className="text-sm">Phiên {status.run_id} đã bỏ, không thể tiếp tục. Graph, vectors, checkpoint và lịch sử được giữ. Bạn có thể cấu hình phiên mới.</p>}
    <nav aria-label="Các bước dựng đồ thị" className="grid grid-cols-2 sm:grid-cols-5 border-b border-line gap-1 pb-3">
      {steps.map((label, index) => <button key={label} type="button" aria-current={step === index ? 'step' : undefined} onClick={() => setSelected(index)}
        className={`text-left px-3 py-3 rounded-lg min-w-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-strong ${step === index ? 'bg-selected text-navy' : 'text-muted hover:bg-selected/50'}`}>
        <span className="block text-sm font-semibold">{index + 1}. {label}</span><span className="text-xs block mt-1">{stepStates[index]}</span>
      </button>)}
    </nav>
    <Card title={`${step + 1}. ${steps[step]}`}><div className="px-5 pb-5 space-y-4 text-sm">
      {step === 0 && <>
        <p>Nguồn: dữ liệu luật giao thông và schema đi kèm phiên bản ứng dụng.</p>
        <p className="text-muted">Chuẩn bị kế hoạch từ nguồn cố định trước khi cấu hình và ghi vào đích graph.</p>
        {sourceReady && source.summary && <ScopeCounts summary={source.summary} />}
        {source?.state === 'CHECKING' && <p>Đang chuẩn bị dữ liệu. Bạn có thể rời trang rồi quay lại theo dõi.</p>}
        {source?.state === 'INVALID' && <p role="alert">Nguồn dữ liệu không hợp lệ. Kiểm tra phiên bản dữ liệu đi kèm rồi chuẩn bị lại.</p>}
        {source?.state === 'UNAVAILABLE' && <p role="alert">Không đọc được nguồn. Kiểm tra quyền đọc và dung lượng state của Worker rồi thử lại.</p>}
        <Button disabled={disabled || source?.state === 'CHECKING' || !!status && ['RUNNING', 'STOPPING'].includes(status.state)} onClick={() => mutate('prepare')}>{status?.state === 'STOPPED' ? 'Kiểm tra lại dữ liệu' : 'Kiểm tra và chuẩn bị'}</Button>
        {sourceReady && <Button onClick={() => setSelected(1)}>Đến cấu hình</Button>}
      </>}
      {step === 1 && <>
        <h3 className="font-semibold">Nơi lưu</h3>
        <div className="flex flex-wrap items-end gap-3"><div className="flex-1 min-w-0"><Field label="Project OpenSPG" hint="Danh sách project bạn sở hữu trong phiên đăng nhập OpenSPG."><select className={inputCls} value={projectId} disabled={active || busy || catalog.loading} onChange={event => setProjectId(event.target.value)}>
          <option value="">Chọn project</option>
          {projectId && !choice && <option value={projectId}>Project đã lưu #{projectId} · chưa có trong danh sách</option>}
          {catalog.value?.projects.map(row => <option key={row.project_id} value={row.project_id} disabled={row.state !== 'AVAILABLE'}>{row.project_name}{catalog.value!.projects.some(other => other.project_id !== row.project_id && other.project_name === row.project_name) ? ` · #${row.project_id}` : ''} · {row.database ?? 'chưa có kết nối'}{row.state === 'SERVING_PROTECTED' ? ' · đang phục vụ' : row.state === 'CONNECTION_NOT_CONFIGURED' ? ' · chưa cấp kết nối' : ''}</option>)}
        </select></Field></div><Button disabled={catalog.loading || busy} onClick={catalog.reload}>Tải lại danh sách</Button></div>
        {catalog.error && <p role="alert">{catalog.error}</p>}
        {catalog.value?.state === 'EMPTY' && <p>Chưa có project bạn sở hữu. Tạo Knowledge Base trong OpenSPG rồi tải lại danh sách.</p>}
        {catalog.value?.state === 'FORBIDDEN' && <p role="alert">Cần đăng nhập OpenSPG bằng cùng địa chỉ máy chủ với LuậtGT, rồi tải lại. Tài khoản LuậtGT không tự cấp quyền project OpenSPG.</p>}
        {catalog.value?.state === 'NOT_CONFIGURED' && <p role="alert">Deployment chưa cấp kết nối OpenSPG/Neo4j cho Worker. Xem hướng dẫn Builder.</p>}
        {catalog.value?.state === 'UNAVAILABLE' && <p role="alert">Không đọc được catalog OpenSPG. Kiểm dịch vụ và quyền kết nối, rồi tải lại.</p>}
        {config?.links?.openspg && <a href={config.links.openspg} target="_blank" rel="noreferrer" className="underline inline-block">Mở OpenSPG</a>}
        {(choice ?? config?.target) && <><p className="break-words">Đích chọn: {(choice ?? config?.target)?.project_name} · database {(choice ?? config?.target)?.database}</p><details><summary className="underline cursor-pointer">Chi tiết project</summary><p className="break-words">ID {(choice ?? config?.target)?.project_id} · namespace {(choice ?? config?.target)?.namespace}</p></details></>}
        <section aria-label="Chuẩn bị cấu trúc LuậtGT" className="border-y border-line py-4 space-y-3 min-w-0">
          <details open={!(structureMatches && structure?.report?.build_ready && !structure.can_apply)}><summary className="underline cursor-pointer font-semibold">{structureMatches && structure?.report?.build_ready && !structure.can_apply ? 'Cấu trúc dữ liệu đã sẵn sàng · Xem chi tiết' : 'Chuẩn bị cấu trúc LuậtGT'}</summary><div className="space-y-3 mt-3">
          <p>Xem schema/index hiện có và thay đổi cần thiết. Chưa dựng graph, chưa tạo embeddings; thao tác không gọi model.</p>
          <Button disabled={disabled || active || choice?.state !== 'AVAILABLE'} onClick={() => changeStructure('preview')}>Xem thay đổi</Button>
          {active && <p>Phiên hoặc tác vụ chưa kết thúc. Chờ hoàn tất trước khi thay đổi cấu trúc.</p>}
          {!choice && <p>Chọn project có quyền sở hữu trước khi xem thay đổi.</p>}
          {preparingStructure && <p role="status">Đang chuẩn bị cấu trúc. Có thể tải lại trang để theo dõi; không gửi lại thao tác.</p>}
          {structureMatches && structure?.report && <>
            <p>Đã đọc lúc {structure.checked_at ? builderTime(structure.checked_at) : 'chưa xác định'}: {structure.report.counts.nodes} node · {structure.report.counts.edges} quan hệ trong database. {structure.report.dimension} chiều.</p>
            {!structure.report.counts.nodes && <p>Database rỗng là bình thường trước Build.</p>}
            <p>{structure.report.build_ready ? 'Hiện đủ cấu trúc để Build.' : 'Chưa xác minh đủ cấu trúc để Build.'} {(structure.report.default_types?.length ?? 0) > 0 ? ` Còn ${structure.report.default_types!.length} loại mặc định OpenSPG; chưa thay cấu trúc mặc định.` : structure.report.default_types ? ' Không còn loại mặc định OpenSPG được nhận diện.' : ' Bấm Xem thay đổi để cập nhật bản xem trước.'}</p>
            <p>Schema: {structure.report.changes.filter(row => row.action !== 'KEEP').length} mục thay đổi. Chỉ xóa định nghĩa khớp mẫu mặc định trên database rỗng sau xác nhận.</p>
            {structure.report.changes.length > 0 && <details><summary className="underline cursor-pointer">Chi tiết xóa / giữ / thêm schema</summary><ul className="list-disc pl-5 break-words">{structure.report.changes.map((row, index) => <li key={index}>{({ ADD: 'Thêm', UPDATE: 'Bổ sung', REMOVE: 'Xóa', KEEP: 'Giữ' })[row.action]} {({ type: 'loại', property: 'thuộc tính', relation: 'quan hệ' })[row.kind]}: {row.name}</li>)}</ul></details>}
            <ul className="list-disc pl-5 break-words">{structure.report.indexes.map(row => <li key={row.label + row.property}>{row.label}.{row.property}: {({ ADD: 'cần thêm', KEEP: 'đúng, giữ nguyên', REBUILD: 'đúng; native sync sẽ tạo lại trên database rỗng', BLOCKED: 'không tương thích hoặc chưa ONLINE' })[row.action]}</li>)}</ul>
            {structure.report.index_changes && <details><summary className="underline cursor-pointer">Tác động từng index</summary><ul className="list-disc pl-5 break-words">{structure.report.index_changes.map(row => <li key={row.name}>{({ ADD: 'Tạo mới', KEEP: 'Giữ', REMOVE: 'Xóa index mặc định', REBUILD: 'Tạo lại qua OpenSPG', BLOCKED: 'Chặn: chưa rõ tác động' })[row.action]}: {row.name} · {row.type} · {row.labels.join(', ') || 'hệ thống'} · {row.properties.join(', ')}</li>)}</ul></details>}
            {structure.report.native_rebuild.length > 0 && <details><summary className="underline cursor-pointer">Index hệ thống OpenSPG sẽ tạo lại trên database rỗng ({structure.report.native_rebuild.length})</summary><p className="break-words">{structure.report.native_rebuild.join(', ')}</p></details>}
            {structure.report.conflicts.length > 0 && <p className="break-words">Xung đột: {structure.report.conflicts.join(', ')}</p>}
            {structure.report.code && <p role="alert">{builderIssue(structure.report.code)}</p>}
            {structure.state === 'COMPLETE' && structure.report.index_changes && structure.report.build_ready && <p role="status">Đã đọc lại OpenSPG/Neo4j: cấu trúc LuậtGT đầy đủ, bốn index ONLINE; schema mặc định trong phạm vi xác nhận đã loại bỏ. Chưa Build, chưa embedding.</p>}
            {structure.state === 'PREVIEW' && structure.report.build_ready && !structure.report.code && !structure.can_apply && <p role="status">Đủ cấu trúc để Build; không còn thay đổi cần áp dụng. Lưu cấu hình và kiểm sẵn sàng.</p>}
            <p>Tên label cũ có thể còn trong sidebar Neo4j do metadata lịch sử; không đồng nghĩa còn schema hoặc dữ liệu. Thao tác này không xóa label tokens.</p>
            {structure.state === 'PARTIAL' && <p role="alert">Chưa hoàn tất. Phía trên là kết quả đọc lại; phần còn thiếu chưa được xác nhận. Không rollback nguyên tử. Xem thay đổi lại trước khi thử tiếp.</p>}
            {structure.can_apply && <Button disabled={!canPrepareStructure} onClick={() => setStructureConfirmation(structure)}>Chuẩn bị cấu trúc LuậtGT</Button>}
          </>}
          {structure?.code && <p role="alert">{builderIssue(structure.code)}</p>}
          </div></details>
        </section>
        {active && <p>Phiên chưa kết thúc: giữ nguyên cấu hình để tiếp tục đúng điểm lưu.</p>}
        <p className="text-muted">Cấu hình đã lưu áp dụng cho phiên dựng mới. Tiếp tục dựng giữ cấu hình và hạn mức của phiên cũ.</p>
        <form onSubmit={event => { event.preventDefault(); if (!disabled && validNumbers && previewMatches && modelReady && sourceReady && choice?.state === 'AVAILABLE' && !active) mutate('save') }} className="space-y-4">
          <fieldset disabled={active || busy} className="space-y-3"><legend className="font-semibold mb-2">Phạm vi dữ liệu</legend>
            <Field label="Dữ liệu sẽ dựng"><select className={inputCls} value={scopeMode === 'ALL' ? 'ALL' : 'PARTIAL'} onChange={event => { setScopeMode(event.target.value === 'ALL' ? 'ALL' : 'COUNT'); setScopePreview(undefined) }}><option value="ALL">Toàn bộ dữ liệu</option><option value="PARTIAL">Một phần dữ liệu</option></select></Field>
            {scopeMode !== 'ALL' && <div className="grid sm:grid-cols-2 gap-3"><Field label="Cách chọn"><select className={inputCls} value={scopeMode} onChange={event => { setScopeMode(event.target.value as 'COUNT' | 'PERCENT'); setNodeLimit(''); setScopePreview(undefined) }}><option value="COUNT">Số lượng nội dung</option><option value="PERCENT">Tỷ lệ nội dung (%)</option></select></Field>
              <Field label={scopeMode === 'COUNT' ? 'Số nội dung' : 'Tỷ lệ (%)'} hint={scopeMode === 'COUNT' ? `Từ 3 đến ${source?.nodes?.toLocaleString('vi-VN') ?? 'tổng nguồn'}.` : '1–100%. Số nội dung làm tròn lên; quá nhỏ sẽ bị từ chối.'}><input className={inputCls} type="number" min={scopeMode === 'COUNT' ? 3 : 1} max={scopeMode === 'COUNT' ? source?.nodes ?? undefined : 100} step={1} required value={nodeLimit} onChange={event => { setNodeLimit(event.target.value); setScopePreview(undefined) }} /></Field></div>}
            <p className="text-muted">Một phần: chọn cố định, ưu tiên nội dung ngắn, giữ văn bản nguồn, đơn vị cha và hai đầu quan hệ trong giới hạn. Không phải mẫu ngẫu nhiên hay đại diện thống kê. Mức quá nhỏ để giữ đủ nguồn và các loại sẽ bị từ chối.</p>
            <Button type="button" disabled={disabled || !validNumbers || !sourceReady} onClick={() => mutate('preview')}>Xem trước phạm vi</Button>
            {previewMatches && scopePreview && <div role="status" className="space-y-2"><p className="font-medium">{scopeMode === 'PERCENT' ? `${nodeLimit}% → ${scopePreview.summary.nodes.toLocaleString('vi-VN')} nội dung (làm tròn lên)` : scopeMode === 'ALL' ? 'Toàn bộ nguồn đã xác thực' : 'Phạm vi đã chọn'}</p><ScopeCounts summary={scopePreview.summary} /></div>}
            {!previewMatches && <p className="text-muted">Xem trước phạm vi trước khi lưu. Hạn mức request không thay đổi tập dữ liệu được chọn.</p>}
          </fieldset>
          <section className="space-y-2"><h3 className="font-semibold">Dịch vụ tạo vector</h3>
            {config?.embedding ? <><p className="break-words">Embedding: {config.embedding.model}</p><p>API key: {config.embedding.key_configured ? 'Đã lưu, được che' : 'Chưa lưu'} · {config.embedding.tested ? 'Đã kiểm kết nối' : 'Chưa kiểm kết nối'}</p></> : <p>Chưa lưu cấu hình Embedding.</p>}
            <Link className="underline inline-block" to="/admin/config">Cấu hình và kiểm kết nối Embedding</Link>
            <p className="text-muted">Kiểm model tại Cấu hình gửi request thật và có thể tính phí. Builder dùng Embedding đã lưu; không cần áp dụng cho Chat.</p>
          </section>
          <details><summary className="cursor-pointer underline">Cấu hình nâng cao</summary><div className="grid gap-4 sm:grid-cols-2 mt-4">
            <Field label="Kích thước batch" hint="1–4096 nội dung hoặc quan hệ xử lý mỗi batch."><input className={inputCls} type="number" min={1} max={4096} step={1} required value={batch} disabled={active || busy} onChange={event => setBatch(event.target.value)} /></Field>
            <div className="space-y-2">
              <Field label="Hạn mức request Embedding" hint="1–1.000.000 lần gửi request tạo vector cho cả phiên, gồm retry. Tiếp tục không đặt lại hạn mức."><input className={inputCls} type="number" min={1} max={1000000} step={1} required={!unlimited} value={limit} disabled={active || busy || unlimited} onChange={event => setLimit(event.target.value)} /></Field>
              <label className="flex items-center gap-2"><input type="checkbox" checked={unlimited} disabled={active || busy} onChange={event => setUnlimited(event.target.checked)} />Không giới hạn</label>
            </div>
            {config?.embedding && <p className="break-all sm:col-span-2 text-muted">Endpoint: {config.embedding.base_url} · {config.embedding.dimension ?? 'Chưa kiểm'} chiều</p>}
          </div></details>
          {!/^\d+$/.test(batch) || Number(batch) < 1 || Number(batch) > 4096 ? <p role="alert">Kích thước batch phải là số nguyên 1–4096.</p> : null}
          {!unlimited && (!/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > 1000000) && <p role="alert">Hạn mức request phải là số nguyên 1–1.000.000 hoặc chọn Không giới hạn.</p>}
          {scopeMode !== 'ALL' && !validNumbers && <p role="alert">Nhập số nguyên trong phạm vi cho phép, rồi xem trước.</p>}
          <Button type="submit" disabled={disabled || !validNumbers || !previewMatches || !modelReady || !sourceReady || choice?.state !== 'AVAILABLE' || active}>Lưu cấu hình dựng</Button>
          {(!sourceReady || !modelReady) && <p className="text-muted">Cần chuẩn bị dữ liệu và kiểm cấu hình Embedding trước khi lưu.</p>}
          {!choice && <p className="text-muted">Chọn project có quyền sở hữu và kết nối được deployment cấp.</p>}
          {choice && choice.state !== 'AVAILABLE' && <p role="alert">{builderIssue(choice.state)}</p>}
        </form>
      </>}
      {step === 2 && <>
        <p role="status" className="font-medium">{config?.readiness.state === 'CHECKING' ? 'Đang kiểm tra điều kiện dựng.' : ready && !dirty ? 'Đã đạt điều kiện. Bạn có thể sang bước dựng.' : config?.readiness.state === 'BLOCKED' ? 'Chưa thể dựng. Xử lý các mục bên dưới rồi kiểm tra lại.' : 'Chưa kiểm tra sẵn sàng.'}</p>
        <p>Kiểm nguồn, model đã lưu, danh tính đích, chỉ mục và khóa ghi. Thao tác này chỉ đọc, không gọi provider hoặc tạo graph.</p>
        <dl className="divide-y divide-line">{(['source', 'embedding', 'target', 'lock'] as const).map(name => {
          const row = config?.readiness.checks.find(value => value.name === name)
          return <div key={name} className="py-3"><div className="flex flex-wrap justify-between gap-2"><dt>{({ source: 'Dữ liệu', embedding: 'Embedding', target: 'Đích lưu và chỉ mục', lock: 'Quyền ghi và khóa' })[name]}</dt><dd>{row?.state === 'READY' ? 'Đã đạt' : row?.state === 'BLOCKED' ? 'Cần xử lý' : 'Chưa kiểm tra'}</dd></div>
            {row?.code && <p className="text-muted mt-1">{row.state === 'NOT_CHECKED' ? ({ WAIT_SOURCE: 'Chờ dữ liệu nguồn hợp lệ.', WAIT_EMBEDDING: 'Chờ cấu hình Embedding hợp lệ.', WAIT_TARGET: 'Chờ schema, chỉ mục và danh tính đích hợp lệ.' } as Record<string, string>)[row.code] : builderIssue(row.code)}</p>}
            {row?.state === 'BLOCKED' && (name === 'embedding' ? <Link className="underline inline-block mt-2" to="/admin/config">Mở cấu hình Embedding</Link> : name !== 'lock' ? <Button onClick={() => setSelected(name === 'source' ? 0 : 1)}>{name === 'source' ? 'Về Dữ liệu' : 'Về Cấu hình và cấu trúc'}</Button> :
              <p className="mt-2 break-words">{row.owner ? `Khóa do phiên ${row.owner.run_id} · project ${row.owner.project_id} giữ. ${status?.run_id === row.owner.run_id && status.target?.project_id === row.owner.project_id ? 'Trạng thái Worker: ' + builderStateLabel(status.state) + '.' : 'Worker này chưa xác minh trạng thái của phiên đó.'}` : 'Chưa đọc được danh tính phiên giữ khóa.'} Giữ nguyên khóa; kiểm trạng thái Worker, không xóa khóa để ép chạy.</p>)}
          </div>
        })}</dl>
        <p className="text-muted">Kết quả chỉ phản ánh thời điểm kiểm. Runner sẽ kiểm lại trước khi ghi.</p>
        <Button disabled={disabled || preparingStructure || !config?.saved || !sourceReady || dirty || config.readiness.state === 'CHECKING' || !!status && ['RUNNING', 'STOPPING'].includes(status.state)} onClick={() => mutate('check')}>Kiểm tra sẵn sàng</Button>
        {ready && !dirty && <Button onClick={() => setSelected(3)}>Đến bước dựng</Button>}
        {(!config?.saved || dirty) && <p>Lưu cấu hình dựng trước khi kiểm tra.</p>}
        {!sourceReady && <p>Chuẩn bị dữ liệu ở bước Dữ liệu trước khi kiểm tra.</p>}
        {preparingStructure && <p>Chờ chuẩn bị cấu trúc hoàn tất trước khi kiểm tra.</p>}
      </>}
      {step === 3 && <>
        <p className="break-words">Đích ghi: {status?.target?.database ?? config?.target?.database ?? 'Chưa cấu hình'} · model {runModel ?? 'Chưa cấu hình'}</p>
        {status?.state === 'COMPLETE' && full && <p>Phiên dựng đã kết thúc. Mở Kết quả để xem số liệu đã xác minh và đồ thị.</p>}
        {status?.error_code && <p role={status.state === 'STOPPED' ? 'status' : 'alert'}>{builderIssue(status.error_code)}</p>}
        {status?.state === 'STOPPING' && <p>Đợi batch và điểm lưu hoàn thành; không tắt Worker hoặc xóa khóa.</p>}
        <div className="flex flex-wrap gap-3">
          <Button variant="primary" disabled={!canBuild} onClick={() => { setConfirmAction('build'); setConfirmation(snapshot) }}>Bắt đầu dựng</Button>
          <Button disabled={disabled || !status?.actions.stop} onClick={() => mutate('stop')}>Dừng an toàn</Button>
          <Button disabled={disabled || !full || !status?.actions.resume || dirty} onClick={() => mutate('resume')}>Tiếp tục dựng</Button>
          {status?.actions.abandon !== undefined && <Button disabled={!canAbandon} onClick={() => { setConfirmAction('abandon'); setConfirmation(snapshot) }}>Bỏ phiên</Button>}
          {status?.state === 'COMPLETE' && full && <Button onClick={() => setSelected(4)}>Xem kết quả đã xác minh</Button>}
        </div>
        {!active && !canBuild && <p className="text-muted">Cần dữ liệu, cấu hình đã lưu và kết quả kiểm sẵn sàng hiện hành; Worker quyết định quyền bắt đầu.</p>}
        {status?.state === 'STOPPED' && !status.actions.resume && <p>Kiểm tra lại dữ liệu và sẵn sàng để tiếp tục phiên này.</p>}
        {status?.state === 'STOPPED' && <p>Bỏ phiên chấm dứt khả năng tiếp tục, giữ dữ liệu graph và điểm lưu. Xóa dữ liệu là thao tác riêng.</p>}
        {status && status.contract_version === 'builder-control-v1' && <p>Worker chưa cung cấp luồng dựng dữ liệu ứng dụng. Kiểm tra cấu hình hoặc cập nhật Worker.</p>}
      </>}
      {step === 4 && <>{status ? <BuilderResult status={status} links={config?.links} /> : <p>Chưa có kết quả.</p>}<Button onClick={() => setSelected(3)}>Về tiến trình phiên</Button></>}
    </div></Card>
    {step === 3 && <div ref={progressRegion} tabIndex={-1} aria-label="Theo dõi phiên dựng" className="focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-strong"><Card title="Tiến trình phiên dựng">
      <div className="px-5 pb-3 text-xs text-muted space-y-1">{runDetail?.timing ? <><p>Bắt đầu: {builderTime(runDetail.timing.started_at)}</p><p>Lần cập nhật từ Worker: {builderTime(runDetail.timing.updated_at)}</p></> : <p>Các công đoạn sẽ cập nhật từ điểm lưu của Worker khi phiên bắt đầu.</p>}</div>
      <div className="overflow-x-auto"><table aria-label="Tiến trình dựng đồ thị" className="w-full text-sm table-fixed"><thead><tr className="border-b border-line"><th className="text-left px-5 py-3 w-2/5">Công đoạn</th><th className="text-left px-3 py-3">Tiến trình đã ghi nhận</th></tr></thead><tbody>
        {builderRows.map(group => <tr key={group.label} className="border-b border-line last:border-0"><th scope="row" className="text-left align-top px-5 py-4 font-medium break-words">{group.label}</th><td className="align-top px-3 py-3 space-y-3 break-words">{group.stages.map(([name, label, unit]) => {
          const row = runDetail?.stages.find(value => value.name === name)
          return <div key={name} className={row?.state === 'RUNNING' ? 'font-semibold text-navy' : ''}><p>{label}: {row ? stageLabels[row.state] : 'Chưa thực hiện'}</p>{row?.done !== null && row?.done !== undefined && <><p className="text-xs text-muted tabular-nums">{row.done.toLocaleString('vi-VN')}/{row.total?.toLocaleString('vi-VN')} {unit}</p>{!!row.total && <progress aria-label={label} max={row.total} value={row.done} className="w-full h-2 accent-navy" />}</>}{row?.error_code && row.error_code !== status?.error_code && <p className="text-xs text-muted">{builderIssue(row.error_code)}</p>}</div>
        })}</td></tr>)}
      </tbody></table></div>
      {runDetail?.binding && <details className="px-5 py-4 text-xs"><summary className="cursor-pointer underline">Chi tiết kỹ thuật phiên</summary><dl className="mt-3 space-y-2 break-all">{Object.entries(runDetail.binding).map(([name, value]) => <div key={name}><dt className="font-medium">{name}</dt><dd>{value}</dd></div>)}</dl>{status?.error_code && <p className="mt-3">Mã lỗi: {status.error_code}</p>}</details>}
    </Card></div>}
    <details className="text-sm border-t border-line py-4 space-y-3"><summary className="font-semibold underline cursor-pointer">Xóa dữ liệu để dựng lại</summary><div className="space-y-3 mt-4">
      <p>Xóa toàn bộ node, vector nằm trên node và quan hệ trong database chuyên dụng đã được deployment cấp quyền. Không xóa theo riêng một run.</p>
      <p>Giữ project, database, tài khoản, credentials, schema, index và lịch sử/checkpoint. Điểm lưu cũ không còn được Resume; không có rollback nguyên tử hoặc khôi phục tự động.</p>
      <Button disabled={!canPreviewClear} onClick={() => changeClear('preview')}>Xem trước xóa dữ liệu</Button>
      {status?.state === 'STOPPED' && <p>Dừng đã hoàn tất. Bỏ phiên trước khi xem trước xóa.</p>}
      {clearState?.report && <div className="space-y-2 break-words"><p>Project {clearState.report.target.project_name} · database <strong>{clearState.report.target.database}</strong>.</p>
        <p>Toàn bộ database tại lần xem trước: {clearState.report.counts.nodes.toLocaleString('vi-VN')} node · {clearState.report.counts.edges.toLocaleString('vi-VN')} quan hệ. Batch xóa tối đa {clearState.report.batch_size} mục.</p>
        <details><summary className="underline cursor-pointer">Danh tính đích</summary><p>ID {clearState.report.target.project_id} · namespace {clearState.report.target.namespace} · physical database {clearState.report.database_id}</p></details></div>}
      {clearState && ['APPLYING','PARTIAL','INTERRUPTED','COMPLETE'].includes(clearState.state) && <p role="status">Đã nhận xác nhận xóa {clearState.deleted.nodes.toLocaleString('vi-VN')} node · {clearState.deleted.edges.toLocaleString('vi-VN')} quan hệ. {clearState.state === 'APPLYING' ? 'Đang xóa và xác minh; không tắt Worker.' : clearState.state === 'COMPLETE' ? 'Đã đọc lại: database rỗng, schema/index được giữ. Chuẩn bị cấu trúc, cấu hình và kiểm sẵn sàng cho phiên mới.' : 'Chưa hoàn tất. Các số trên chỉ gồm batch đã được xác nhận; chưa biết chắc phần còn lại. Xem trước lại để đọc hiện trạng.'}</p>}
      {clearState?.code && <p role="alert">{builderIssue(clearState.code)}</p>}
      {canApplyClear && <Button onClick={() => setClearConfirmation(clearState)}>Xóa dữ liệu đồ thị</Button>}
      {clearState?.state === 'COMPLETE' && <Button onClick={() => setSelected(1)}>Về cấu hình phiên mới</Button>}
    </div></details>
    <dialog ref={clearDialog} aria-labelledby="clear-confirm-title" onCancel={() => setClearConfirmation(undefined)} className="m-auto w-[calc(100%_-_2rem)] max-w-lg max-h-[90vh] overflow-auto rounded-2xl border border-line bg-bg p-5 text-sm text-navy backdrop:bg-navy/30">
      <form onSubmit={event => { event.preventDefault(); changeClear('apply') }} className="space-y-4">
        <h2 id="clear-confirm-title" className="text-lg font-semibold">Xác nhận xóa dữ liệu đồ thị</h2>
        <p className="break-words">Xóa toàn bộ {clearConfirmation?.report?.counts.nodes.toLocaleString('vi-VN')} node và {clearConfirmation?.report?.counts.edges.toLocaleString('vi-VN')} quan hệ trong project {clearConfirmation?.report?.target.project_name}, database <strong>{clearConfirmation?.report?.target.database}</strong>.</p>
        <p>Giữ schema/index và database. Phiên cũ chỉ là lịch sử, không thể Resume. Xóa theo batch, không có rollback nguyên tử. Không tự Build hay chuyển Chat.</p>
        <Field label="Nhập đúng tên database để xác nhận"><input className={inputCls} required value={clearDatabase} onChange={event => setClearDatabase(event.target.value)} autoComplete="off" /></Field>
        {(!canApplyClear || clearConfirmation?.preview_id !== clearState?.preview_id) && <p role="alert">Trạng thái đã thay đổi. Xem trước lại.</p>}
        <div className="flex flex-wrap justify-end gap-3"><Button type="button" onClick={() => setClearConfirmation(undefined)}>Quay lại</Button><Button type="submit" disabled={!canApplyClear || clearConfirmation?.preview_id !== clearState?.preview_id || clearDatabase !== clearState?.report?.target.database}>Xóa dữ liệu trong {clearConfirmation?.report?.target.database}</Button></div>
      </form>
    </dialog>
    <dialog ref={structureDialog} aria-labelledby="structure-confirm-title" onCancel={() => setStructureConfirmation(undefined)} className="m-auto w-[calc(100%_-_2rem)] max-w-lg max-h-[90vh] overflow-auto rounded-2xl border border-line bg-bg p-5 text-sm text-navy backdrop:bg-navy/30">
      <form className="space-y-4" onSubmit={event => { event.preventDefault(); changeStructure('apply') }}>
        <h2 id="structure-confirm-title" className="text-lg font-semibold">Xác nhận chuẩn bị cấu trúc LuậtGT</h2>
        <p className="break-words">Project {structureConfirmation?.report?.target.project_name} · #{structureConfirmation?.report?.target.project_id} · namespace {structureConfirmation?.report?.target.namespace} · database {structureConfirmation?.report?.target.database}.</p>
        <p>{structureConfirmation?.report?.counts.nodes} node · {structureConfirmation?.report?.counts.edges} quan hệ hiện có. Áp dụng {structureConfirmation?.report?.changes.filter(row => row.action !== 'KEEP').length} mục schema như bản xem trước.</p>
        <ul className="list-disc pl-5 break-words">{structureConfirmation?.report?.changes.filter(row => row.action === 'REMOVE').map(row => <li key={row.kind + row.name}>Xóa {row.kind === 'relation' ? 'quan hệ' : 'loại'} mặc định: {row.name}</li>)}</ul>
        <ul className="list-disc pl-5 break-words">{structureConfirmation?.report?.index_changes?.filter(row => row.action === 'REMOVE').map(row => <li key={row.name}>Xóa index mặc định: {row.name}</li>)}</ul>
        {(structureConfirmation?.report?.native_rebuild.length ?? 0) > 0 && <p>OpenSPG sẽ tạo lại {structureConfirmation?.report?.native_rebuild.length} index hệ thống trên database rỗng như bản xem trước.</p>}
        <p>Chưa Build, chưa tạo embeddings, không gọi model. Không có rollback nguyên tử; lỗi sẽ đọc lại và báo phần còn thiếu.</p>
        {(!canPrepareStructure || structureConfirmation?.preview_id !== structure?.preview_id) && <p role="alert">Đích hoặc bản xem trước đã đổi. Quay lại xem thay đổi.</p>}
        <div className="flex flex-wrap justify-end gap-3"><Button type="button" onClick={() => setStructureConfirmation(undefined)}>Quay lại</Button><Button type="submit" variant="primary" disabled={!canPrepareStructure || structureConfirmation?.preview_id !== structure?.preview_id}>Xác nhận chuẩn bị</Button></div>
      </form>
    </dialog>
    <dialog ref={dialog} aria-labelledby="builder-confirm-title" onCancel={() => setConfirmation(undefined)} className="m-auto w-[calc(100%_-_2rem)] max-w-lg max-h-[90vh] overflow-auto rounded-2xl border border-line bg-bg p-5 text-sm text-navy backdrop:bg-navy/30">
      <form onSubmit={event => { event.preventDefault(); mutate(confirmAction) }} className="space-y-4">
        <h2 id="builder-confirm-title" className="text-lg font-semibold">{confirmAction === 'abandon' ? 'Xác nhận bỏ phiên' : 'Xác nhận dựng đồ thị'}</h2>
        <p className="break-words">Project {confirmation?.config.target?.project_name} · database {confirmation?.config.target?.database}.</p>
        {confirmAction === 'abandon' ? <p className="break-words">Bỏ phiên {confirmation?.status.run_id}: không thể Resume. Giữ graph, vectors, checkpoint và lịch sử. Không xóa dữ liệu và không tự bắt đầu phiên mới.</p> : <>
        <p className="break-words">Embedding: {confirmation?.config.embedding?.model}.</p>
        <p>Dự kiến: {(confirmation?.config.selection?.nodes ?? confirmation?.inputs.source_validation.nodes)?.toLocaleString('vi-VN')} nội dung · {(confirmation?.config.selection?.edges ?? confirmation?.inputs.source_validation.edges)?.toLocaleString('vi-VN')} quan hệ. Phạm vi: {confirmation?.config.selection?.node_limit ? 'giới hạn, chưa phải toàn corpus' : 'toàn bộ corpus'}.</p>
        <p>Kích thước batch: {confirmation?.config.batch_size}. Hạn mức request Embedding: {confirmation?.config.request_limit ?? 'Không giới hạn'}.</p>
        <p>Embedding có thể tính phí. Graph mới chưa tự dùng cho Chat.</p>
        </>}
        <details><summary className="underline cursor-pointer">Chi tiết kỹ thuật xác nhận</summary><dl className="mt-2 space-y-1 break-all">
          <div><dt>Project ID</dt><dd>{confirmation?.config.target?.project_id}</dd></div>
          <div><dt>Namespace</dt><dd>{confirmation?.config.target?.namespace}</dd></div>
          <div><dt>Số chiều vector</dt><dd>{confirmation?.config.embedding?.dimension}</dd></div>
        </dl></details>
        {confirmationKey(confirmation) !== confirmationKey(snapshot) && <p role="alert">Cấu hình đã thay đổi. Đóng xác nhận và kiểm tra lại.</p>}
        <div className="flex flex-wrap gap-3 justify-end"><Button type="button" onClick={() => setConfirmation(undefined)}>Quay lại</Button><Button variant="primary" type="submit" disabled={!(confirmAction === 'abandon' ? canAbandon : canBuild) || confirmationKey(confirmation) !== confirmationKey(snapshot)}>{confirmAction === 'abandon' ? 'Xác nhận bỏ phiên' : 'Xác nhận bắt đầu'}</Button></div>
      </form>
    </dialog>
  </div>
}

export function Pipeline() {
  const data = useInspection(loadPipelineStatus),
    sample = useInspection(loadSampleInspection)
  return (
    <Page
      title="Pipeline & tác vụ"
      subtitle="Điều khiển Builder qua Worker nội bộ; runtime truy vấn và receipt SAMPLE hiển thị riêng."
      actions={
        <Button
          disabled={data.loading || sample.loading}
          onClick={() => {
            data.reload()
            sample.reload()
          }}
        >
          Kiểm tra lại
        </Button>
      }
    >
      <Notice {...data} retry={data.reload} />
      <Notice {...sample} retry={sample.reload} />
      {data.value && (
        <div className="grid sm:grid-cols-3 gap-4">
          {[
            ["Runtime truy vấn", data.value.phase.toUpperCase()],
            [
              "Request đang xử lý",
              data.value.active_requests ?? "Chưa xác minh",
            ],
            [
              "Query worker draining",
              data.value.draining === null
                ? "Chưa xác minh"
                : String(data.value.draining),
            ],
          ].map(([label, value]) => (
            <Card key={label} className="p-5">
              <p className="text-xs text-muted">{label}</p>
              <p className="font-semibold mt-3">{value}</p>
            </Card>
          ))}
        </div>
      )}
      <BuilderControls />
      {sample.value && (
        <section className="text-sm space-y-2 break-words">
          <h2 className="font-semibold">
            Receipt SAMPLE hoàn tất kiểm tra graph
          </h2>
          <p>Scope: SAMPLE · Stage: {sample.value.sample_receipt.stage}</p>
          <p>
            Đã xác minh {sample.value.counts.nodes} node,{" "}
            {sample.value.counts.edges} cạnh, {sample.value.counts.vectors}{" "}
            vector.
          </p>
          <p>Sealed: {sample.value.sample_receipt.sealed_at}</p>
          <p className="break-all">
            Receipt SHA-256: {sample.value.sample_receipt.receipt_sha256}
          </p>
          <p>
            Run ID / batch progress / thời gian build: UNSUPPORTED — receipt này
            không chứng minh các trường đó.
          </p>
        </section>
      )}
      <p className="mt-5 text-sm text-muted">
        Builder giữ policy và khóa của Runner; quyền ghi production chưa được
        cấp.
      </p>
    </Page>
  )
}

export function Benchmark() {
  const data = useInspection(loadSampleInspection),
    catalog = data.value?.datasets
  return (
    <Page
      title="Benchmark KAG"
      subtitle="Validation và độ phủ gold trên graph SAMPLE hiện tại. Metrics chỉ có sau evaluation hợp lệ."
      actions={
        <Button disabled={data.loading} onClick={data.reload}>
          Kiểm tra lại
        </Button>
      }
    >
      <Notice
        {...data}
        retry={data.reload}
        empty={catalog?.state === "AVAILABLE" && !catalog.datasets.length}
      />
      {catalog && (
        <>
          <p className="py-4">
            Catalog: {catalog.state} · Thực thi benchmark chính thức: BLOCKED
          </p>
          <p className="text-sm break-all">
            Graph fingerprint: {data.value?.graph_fingerprint}
          </p>
          <p className="text-sm break-all">
            Source catalog SHA-256: {data.value?.source_catalog_sha256}
          </p>
          <p className="text-sm">
            Model cấu hình:{" "}
            {data.value?.providers.configured_chat_model ?? "Chưa cấu hình"} ·
            Danh tính upstream: NOT VERIFIED
          </p>
          {catalog.datasets.map((row) => (
            <section
              key={row.id}
              className="my-5 p-5 rounded-2xl border border-line bg-surface text-sm space-y-2 break-words"
            >
              <h2 className="font-semibold">{row.id}</h2>
              {row.metadata && (
                <>
                  <p>
                    Dataset version: {row.metadata.dataset_version ?? "INVALID"}
                  </p>
                  <p>
                    Nhóm câu hỏi:{" "}
                    {Object.entries(row.metadata.category_counts)
                      .map(([category, count]) => `${category}: ${count}`)
                      .join(" · ") || "Chưa có schema hợp lệ"}
                  </p>
                  {row.metadata.generation_method && (
                    <p>
                      Phương pháp tạo: {row.metadata.generation_method} · Gold
                      cần human review
                    </p>
                  )}
                </>
              )}
              <p>
                Validation: {row.dataset_status ?? "INVALID"} ·{" "}
                {row.dataset_eligibility} ·{" "}
                {row.reason ?? "Có gold trong graph"}
              </p>
              <p>
                Tổng {row.record_count ?? "Chưa xác minh"} · Valid{" "}
                {row.record_count !== null && row.invalid_count !== null
                  ? row.record_count - row.invalid_count
                  : "Chưa xác minh"}{" "}
                · Invalid {row.invalid_count ?? "Chưa xác minh"} · Có gold{" "}
                {row.gold_count ?? "Chưa xác minh"}
              </p>
              <p>
                Eligible frozen {row.eligible_count} · Ineligible{" "}
                {row.ineligible_count} · Phạm vi: {row.eligibility_scope}; không
                chứng minh solver/effectivity.
              </p>
              <p className="break-all">
                Dataset SHA-256: {row.dataset_hash ?? "Chưa có dataset hợp lệ"}
              </p>
              {row.smoke && (
                <>
                  <p>
                    Review: {row.smoke.review_status} · Chưa có chứng nhận human
                    review · G1 eligible exploratory:{" "}
                    {row.smoke.g1_eligible_count}
                  </p>
                  <p>
                    Kết quả evaluation: {row.smoke.state} ·{" "}
                    {row.smoke.official_benchmark
                      ? "Dataset được chỉ định official trong frozen manifest; không chứng minh model correctness"
                      : "Không phải official benchmark"}
                  </p>
                  {row.smoke.state === "INVALID_RECEIPT" && (
                    <p role="alert">
                      Artifact không khớp dataset/graph/hash; metrics bị chặn.
                    </p>
                  )}
                  {Object.entries(row.smoke.runs).map(([mode, run]) => (
                    <div key={mode} className="space-y-1">
                      <h3 className="font-semibold">
                        {mode === "G1" ? "G1 Retrieval" : "G2 Solver"}:{" "}
                        {run?.status ?? "NOT_RUN"}
                      </h3>
                      {run ? (
                        <>
                          <p>
                            Requested {run.requested_count} · Attempted{" "}
                            {run.attempted_count} · Failed {run.failed_count} ·
                            Ineligible {run.ineligible_count}
                          </p>
                          <p>
                            {run.started_at} → {run.finished_at}
                          </p>
                          {run.configuration && (
                            <p>
                              Metric policy{" "}
                              {run.configuration.metric_policy_version} · Top k{" "}
                              {run.configuration.top_k} · Cutoffs{" "}
                              {run.configuration.ks.join(", ")} · Rank{" "}
                              {run.configuration.rank_semantics}
                            </p>
                          )}
                          {run.configuration?.metric_policy_version ===
                            "1.1" && (
                            <p>
                              source_span.* dùng rank trên toàn bộ items trả về;
                              document/unit/sign.* dùng rank theo channel.
                            </p>
                          )}
                          <p>
                            Latency mean (all attempted):{" "}
                            {run.latency_ms.all_attempted.mean?.toFixed(1) ??
                              "Chưa đo"}{" "}
                            ms
                          </p>
                          <details>
                            <summary className="cursor-pointer underline">
                              Metrics thực đo và mẫu số
                            </summary>
                            <dl>
                              {Object.entries(run.metrics).map(
                                ([name, metric]) => (
                                  <div key={name} className="py-1">
                                    <dt>{name}</dt>
                                    <dd>
                                      {metric.value ??
                                        "UNAVAILABLE / NOT_APPLICABLE"}{" "}
                                      · Scored {metric.scored_count}/
                                      {metric.eligible_count} · Failed{" "}
                                      {metric.failed_count} · Excluded{" "}
                                      {metric.excluded_count}
                                    </dd>
                                  </div>
                                ),
                              )}
                            </dl>
                          </details>
                        </>
                      ) : (
                        <p>
                          Chưa có execution artifact hợp lệ; metrics chưa đo.
                        </p>
                      )}
                    </div>
                  ))}
                </>
              )}
              <details>
                <summary className="cursor-pointer underline">
                  Gold thiếu trong SAMPLE
                </summary>
                {Object.entries(row.missing_gold).map(([kind, ids]) => (
                  <div key={kind} className="mt-2">
                    <p>
                      {kind}: {ids.length} ID
                    </p>
                    <ul className="ml-4 list-disc">
                      {ids.map((id) => (
                        <li key={id} className="break-words">
                          {id}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </details>
            </section>
          ))}
          <p className="mt-5 text-sm">
            SAMPLE smoke chỉ exploratory. Benchmark chính thức cần frozen
            manifest và review đủ điều kiện. Metrics null giữ nguyên; không suy
            thành PASS.
          </p>
        </>
      )}
    </Page>
  )
}
