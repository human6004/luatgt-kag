import { useEffect, useState } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { normalizeImport } from "./import-normalization"
import { api, send, type ContentRecord } from "../../api"
import { Button, Card, FilePicker, FilterTabs, Modal, Th, Td, inputCls } from "../../admin/ui"
import { useAdmin } from "../../admin/store"
import { csvSamples, parseCsv, tableObjects, type ImportKind } from "../../admin/import-data"
import { useData, useTask, Notice, Asset, download, saveBlob } from "./shared"
import type { QuestionSet } from "./QuestionBankSettings"

export type ContentKind = "signs" | "documents" | "units"

const titles: Record<ImportKind, string> = {
  questions: "Ngân hàng câu hỏi",
  signs: "Biển báo",
  documents: "Văn bản pháp luật",
  units: "Điều khoản / đơn vị pháp lý",
}

const fields: Record<ContentKind, string[]> = {
  signs: [
    "externalId",
    "code",
    "name",
    "group",
    "meaning",
    "doc_id",
    "unit_id",
    "qcvn",
    "so_hieu",
    "bien_phu_variant",
    "record_type",
    "parent_code",
    "description_scope",
    "ngay_hieu_luc",
    "ngay_het_hieu_luc",
  ],
  documents: [
    "externalId",
    "title",
    "so_hieu",
    "source",
    "ngay_hieu_luc",
    "ngay_het_hieu_luc",
  ],
  units: [
    "externalId",
    "doc_id",
    "parent_id",
    "unit_type",
    "so_hieu",
    "text",
    "order",
  ],
}

const labels: Record<string, string> = {
  externalId: "Mã định danh",
  text: "Nội dung",
  source: "Nguồn",
  code: "Mã biển",
  name: "Tên biển",
  group: "Nhóm biển",
  meaning: "Ý nghĩa",
  doc_id: "Mã văn bản nguồn",
  unit_id: "Điều/khoản/đơn vị nguồn",
  qcvn: "Quy chuẩn",
  so_hieu: "Số hiệu văn bản",
  bien_phu_variant: "Biến thể biển phụ",
  record_type: "Loại bản ghi biển báo",
  parent_code: "Mã biển cha",
  description_scope: "Phạm vi mô tả",
  ngay_hieu_luc: "Ngày hiệu lực",
  ngay_het_hieu_luc: "Ngày hết hiệu lực",
  title: "Tên văn bản",
  parent_id: "ID đơn vị cha (để trống nếu là gốc)",
  unit_type: "Loại đơn vị theo contract KAG",
  order: "Thứ tự trong nguồn",
}

function Table({ children }: { children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-2xl border border-line bg-surface mt-5">
      <table className="w-full text-sm">{children}</table>
    </div>
  )
}

function sourceGraphContext(parameters: URLSearchParams) {
  const projectId = parameters.get("project_id"), runId = parameters.get("run_id")
  return projectId && /^[1-9][0-9]{0,9}$/.test(projectId) && runId && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)
    ? `project_id=${projectId}&run_id=${encodeURIComponent(runId)}` : ""
}

export function ContentManager({ kind }: { kind: ContentKind }) {
  const resource = kind === "units" ? "/admin/units" : "/admin/content"
  const [parameters, setParameters] = useSearchParams()
  const graphContext = sourceGraphContext(parameters)

  const urlQuery = parameters.get("q") ?? parameters.get("source_id") ?? ""
  const rawStatus = parameters.get("status")
  const state = rawStatus === "published" || rawStatus === "draft" ? rawStatus : ""
  const signGroup = kind === "signs" ? parameters.get("group") ?? "" : ""
  const editId = parameters.get("id") ?? ""

  const data = useData<ContentRecord[]>(`/admin/${kind}`),
    task = useTask(),
    [query, setQuery] = useState(urlQuery),
    [selected, setSelected] = useState<ContentRecord | null>(null),
    [form, setForm] = useState<Record<string, unknown>>({}),
    [history, setHistory] = useState<{
      version: number
      changedAt: string
      data: string
    }[]>([]),
    [message, setMessage] = useState("")
  const [checked, setChecked] = useState<Set<string>>(() => new Set())
  const [batchError, setBatchError] = useState("")

  useEffect(() => {
    setQuery(urlQuery)
  }, [urlQuery])

  useEffect(() => {
    setChecked(new Set())
  }, [urlQuery, state, signGroup])

  function updateUrl(patch: Record<string, string | null>, replace = false) {
    setParameters(
      (prev) => {
        const next = new URLSearchParams(prev)
        if ("q" in patch) next.delete("source_id")
        for (const [k, v] of Object.entries(patch)) {
          if (v === null || v === "") next.delete(k)
          else next.set(k, v)
        }
        return next
      },
      { replace },
    )
  }

  function applySelection(row: ContentRecord | null) {
    setSelected(row)
    setForm(row ? (row.id ? { ...row.data } : { reviewed: false }) : {})
    setHistory([])
  }

  useEffect(() => {
    if (!editId) {
      if (selected !== null) applySelection(null)
      return
    }
    if (editId === "new") {
      if (!selected || selected.id !== "") {
        task.clearError()
        applySelection({ id: "", externalId: "", version: 0, published: false, data: {} })
        setMessage("")
      }
      return
    }
    if (!data.value) return
    const target = data.value.find((r) => r.id === editId || r.externalId === editId)
    if (target && selected?.id !== target.id) {
      task.clearError()
      applySelection(target)
      setMessage("")
    }
  }, [editId, data.value])

  const rows = (data.value || []).filter(
    (r) =>
      `${r.externalId} ${r.data.name || r.data.title || r.data.text || ""}${kind === "signs" ? ` ${r.data.code ?? ""} ${r.data.meaning ?? ""}` : ""}`
        .toLowerCase()
        .includes(query.toLowerCase()) &&
      (!state || (state === "published" ? r.published : !r.published)) &&
      (!signGroup || r.data.group === signGroup),
  )
  const signGroups = [...new Set((data.value ?? []).map((r) => String(r.data.group ?? "")).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, "vi"))
  const drafts = kind === "signs" ? rows.filter((r) => !r.published) : []
  const chosen = drafts.filter((r) => checked.has(r.id))
  const allChecked = drafts.length > 0 && chosen.length === drafts.length

  function openEdit(row: ContentRecord) {
    task.clearError()
    applySelection(row)
    setMessage("")
    updateUrl({ id: row.id })
  }

  function closeEdit() {
    if (task.busy) return
    task.clearError()
    applySelection(null)
    updateUrl({ id: null })
  }

  function field(key: string, value: unknown) {
    setForm((prev) => {
      const source =
        key === "externalId"
          ? ({
              documents: "doc_id",
              signs: "sign_id",
              units: "unit_id",
            } as Record<string, string>)[kind]
          : kind === "signs"
            ? ({
                code: "ma_bien",
                name: "ten",
                group: "nhom",
                meaning: "mo_ta",
              } as Record<string, string>)[key]
            : kind === "documents"
              ? ({
                  ngay_hieu_luc: "effective_from",
                  ngay_het_hieu_luc: "effective_to",
                  source: "source_url",
                } as Record<string, string>)[key]
              : undefined

      return { ...prev, [key]: value, ...(source ? { [source]: value } : {}) }
    })
  }

  async function save(showMessage = true) {
    if (!selected) return
    const next = await api<ContentRecord>(
      `${resource}/${selected.id}`,
      send("PUT", { version: selected.version, data: form }),
    )
    applySelection(next)
    data.reload()
    if (showMessage) setMessage("Đã lưu bản nháp.")
  }

  return (
    <div>
      {graphContext && (
        <p className="mb-4 text-sm">
          <Link className="underline" to={`/admin/chatbot?step=3&${graphContext}`}>
            Quay lại đồ thị và kiểm tra lại nguồn
          </Link>
          . Kiểm duyệt, xuất bản văn bản trước đơn vị; bản phục vụ chỉ đổi sau khi xem trước và xác nhận.
        </p>
      )}
      <Notice {...data} retry={data.reload} empty={!data.value?.length} />
      <Notice error={!selected ? task.error : undefined} />
      {message && (
        <p role="status" className="my-3 text-emerald-700">
          {message}
        </p>
      )}
      <div className="grid sm:grid-cols-3 gap-4 mb-5">
        {[
          ["Tổng nội dung", data.value?.length],
          ["Đã xuất bản", data.value?.filter((r) => r.published).length],
          ["Bản nháp", data.value?.filter((r) => !r.published).length],
        ].map(([label, value]) => (
          <Card key={String(label)} className="p-5">
            <p className="text-xs text-muted">{label}</p>
            <p className="text-3xl font-semibold mt-3">{value ?? "—"}</p>
          </Card>
        ))}
      </div>
      <div className={kind === "signs" ? "mb-4 grid gap-3 md:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,0.8fr)]" : "mb-3"}>
        <input
          aria-label="Tìm nội dung"
          value={query}
          onChange={(e) => {
            const v = e.target.value
            setQuery(v)
            updateUrl({ q: v || null }, true)
          }}
          placeholder={kind === "signs" ? "Tìm biển báo, mã, nội dung…" : "Tìm theo mã hoặc nội dung"}
          className={inputCls}
        />
        {kind === "signs" && (
          <>
            <select className={inputCls} aria-label="Nhóm biển báo" value={signGroup} onChange={(e) => updateUrl({ group: e.target.value })}>
              <option value="">Tất cả nhóm biển</option>
              {signGroups.map((group) => <option key={group}>{group}</option>)}
            </select>
            <select className={inputCls} aria-label="Trạng thái xuất bản" value={state} onChange={(e) => updateUrl({ status: e.target.value })}>
              <option value="">Mọi trạng thái</option>
              <option value="published">Đã xuất bản</option>
              <option value="draft">Bản nháp</option>
            </select>
          </>
        )}
      </div>
      {kind !== "signs" && <FilterTabs
        label="Lọc trạng thái xuất bản"
        value={state}
        onChange={(v) => updateUrl({ status: v || null })}
        className="mb-4"
        items={[
          { value: "", label: "Tất cả" },
          { value: "published", label: "Đã xuất bản" },
          { value: "draft", label: "Bản nháp" },
        ]}
      />}
      {kind === "signs" && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <span className="text-sm text-muted" role="status">Chọn {chosen.length} / {drafts.length} bản nháp</span>
          <Button
            variant="primary"
            disabled={task.busy || data.loading || !chosen.length || chosen.length > 600}
            onClick={() => void task.run(async () => {
              setMessage("")
              setBatchError("")
              try {
                await api("/admin/signs/publication-batch", send("POST", {
                  rows: chosen.map(({ id, version }) => ({ id, version })),
                  reviewed: true,
                  published: true,
                }))
              } catch (error) {
                setBatchError(error instanceof Error ? error.message : "Yêu cầu xuất bản thất bại.")
                return
              }
              setChecked(new Set())
              setMessage(`Đã xuất bản ${chosen.length} biển báo.`)
              data.reload()
            })}
          >
            Duyệt và xuất bản các biển đã chọn
          </Button>
          {chosen.length > 600 && <p className="w-full text-xs text-muted">Mỗi lần xuất bản tối đa 600 biển báo.</p>}
        </div>
      )}
      {kind === "signs" && batchError && (
        <section role="alert" className="mb-4 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          <h3 className="font-semibold">Đợt xuất bản chưa hoàn tất</h3>
          <ul className="mt-2 max-h-56 list-disc space-y-1 overflow-y-auto pl-5">
            {batchError.split("\n").map((line, index) => <li key={index}>{line}</li>)}
          </ul>
        </section>
      )}
      <Table>
        <thead>
          <tr>
            {kind === "signs" && <Th className="w-12">
              <input
                type="checkbox"
                aria-label="Chọn tất cả biển báo bản nháp đang lọc"
                checked={allChecked}
                disabled={task.busy || data.loading || !drafts.length}
                onChange={(e) => setChecked(new Set(e.target.checked ? drafts.map((r) => r.id) : []))}
              />
            </Th>}
            <Th>Mã</Th>
            <Th>Nội dung</Th>
            <Th>Trạng thái</Th>
            <Th className="text-right">Thao tác</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              {kind === "signs" && <Td>
                {!r.published && <input
                  type="checkbox"
                  aria-label={`Chọn biển ${r.data.code || r.externalId}`}
                  checked={checked.has(r.id)}
                  disabled={task.busy || data.loading}
                  onChange={(e) => {
                    const isChecked = e.target.checked
                    setChecked((prev) => {
                      const next = new Set(prev)
                      if (isChecked) next.add(r.id)
                      else next.delete(r.id)
                      return next
                    })
                  }}
                />}
              </Td>}
              <Td>{r.externalId}</Td>
              <Td>
                <p className="max-w-xl">
                  {String(r.data.text || r.data.title || r.data.name)}
                </p>
              </Td>
              <Td>{r.published ? "Đã xuất bản" : "Bản nháp"}</Td>
              <Td className="text-right whitespace-nowrap">
                <span className="inline-flex flex-wrap justify-end gap-1.5">
                  <Button size="sm" onClick={() => openEdit(r)}>
                    Chỉnh sửa
                  </Button>
                </span>
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
      {selected && (
        <Modal
          open={!!selected}
          title={`${selected.id ? "Chỉnh sửa" : "Thêm"} ${
            kind === "signs" ? "biển báo" : kind === "units" ? "đơn vị pháp lý" : "văn bản"
          }`}
          onClose={closeEdit}
          footer={
            <>
              <Button variant="ghost" disabled={task.busy} onClick={closeEdit}>
                Đóng
              </Button>
              <Button disabled={task.busy} type="submit" form="content-editor" variant={selected.id ? "outline" : "dark"}>
                Lưu bản nháp
              </Button>
              {selected.id && (
                <Button
                  variant={selected.published ? "danger" : "primary"}
                  disabled={task.busy}
                  onClick={() =>
                    task.run(async () => {
                      setMessage("")
                      await save(false)
                      const current = await api<ContentRecord[]>(
                        `/admin/${kind}`,
                      )
                      const record = current.find((r) => r.id === selected.id)!
                      const updated = await api<ContentRecord>(
                        `${resource}/${record.id}/publication`,
                        send("POST", {
                          version: record.version,
                          published: !selected.published,
                        }),
                      )
                      applySelection(updated)
                      data.reload()
                      setMessage(
                        selected.published
                          ? "Đã ngừng xuất bản."
                          : "Đã xuất bản.",
                      )
                    })
                  }
                >
                  {selected.published ? "Ngừng xuất bản" : "Xuất bản"}
                </Button>
              )}
            </>
          }
        >
          <Notice error={task.error} />
          {message && (
            <p role="status" className="mb-4 text-sm text-emerald-700">
              {message}
            </p>
          )}
          {kind === "signs" && selected.id && (
            <section className="rounded-xl border border-line bg-surface p-4">
              <h3 className="text-sm font-semibold text-navy">Xem trước ảnh biển báo</h3>
              {Boolean(selected.data.imageKey || selected.data.hasDatasetImage) ? (
                <Asset key={selected.version} id={selected.id} alt="Ảnh minh họa biển báo" className="mx-auto mt-3 max-h-40 max-w-full object-contain" />
              ) : (
                <p className="mt-1 text-xs text-muted">
                  {Array.isArray(selected.data.children_codes) && selected.data.children_codes.length
                    ? `Biển này chưa có ảnh riêng. Mở từng biển con để xem ảnh: ${selected.data.children_codes.join(", ")}.`
                    : "Chưa có ảnh cho biển này. Bạn có thể tải ảnh lên ở cuối biểu mẫu."}
                </p>
              )}
            </section>
          )}
          <form
            id="content-editor"
            onSubmit={(e) => {
              e.preventDefault()
              task.run(async () => {
                if (selected.id) await save()
                else {
                  const result = await api<{ inserted: number }>(
                    `/admin/imports/${kind}/confirm`,
                    send("POST", { rows: [form], updateExisting: false }),
                  )
                  if (result.inserted !== 1)
                    throw new Error(
                      "Mã đã tồn tại. Chọn bản ghi hiện có để chỉnh sửa.",
                    )
                  const allRows = await api<ContentRecord[]>(`/admin/${kind}`)
                  const created = allRows.find(
                    (r) => r.externalId === form.externalId,
                  )
                  if (created) {
                    applySelection(created)
                    updateUrl({ id: created.id }, true)
                  }
                  data.reload()
                  setMessage("Đã tạo bản nháp.")
                }
              })
            }}
            className="grid sm:grid-cols-2 gap-4 mt-5"
          >
            {fields[kind].map((key) => (
              <label
                key={key}
                className={`text-sm ${
                  ["text", "meaning"].includes(key)
                    ? "sm:col-span-2"
                    : ""
                }`}
              >
                {kind === "units" && key === "text"
                  ? "Nội dung pháp lý"
                  : kind === "signs" && key === "doc_id"
                    ? "Mã văn bản nguồn (không bắt buộc nhập)"
                    : labels[key]}
                {["text", "meaning"].includes(key) ||
                (kind === "signs" && ["name", "group"].includes(key)) ? (
                  <textarea
                    rows={["name", "group"].includes(key) ? 2 : 3}
                    value={String(form[key] || "")}
                    onChange={(e) => field(key, e.target.value)}
                    className={`${inputCls} mt-2`}
                  />
                ) : (
                  <input
                    readOnly={
                      !!selected.id &&
                      (key === "externalId" || (key === "doc_id" && kind === "units"))
                    }
                    min={key === "order" ? 0 : undefined}
                    step={key === "order" ? 1 : undefined}
                    type={
                      key === "order"
                        ? "number"
                        : key.startsWith("ngay_")
                          ? "date"
                          : "text"
                    }
                    value={String(form[key] ?? "")}
                    onChange={(e) =>
                      field(
                        key,
                        key === "order"
                          ? Number(e.target.value)
                          : (key.startsWith("ngay_") || key === "parent_id") &&
                              !e.target.value
                            ? null
                            : e.target.value,
                      )
                    }
                    className={`${inputCls} mt-2`}
                  />
                )}
              </label>
            ))}
            {kind === "signs" && (
              <>
                {["children_codes", "note"].map((key) => (
                  <label key={key} className="sm:col-span-2 text-sm">
                    {key === "children_codes"
                      ? "Mã biển con (mỗi dòng một mã)"
                      : "Ghi chú (mỗi dòng một ghi chú)"}
                    <textarea
                      className={inputCls}
                      rows={3}
                      value={
                        Array.isArray(form[key])
                          ? (form[key] as string[]).join("\n")
                          : ""
                      }
                      onChange={(e) =>
                        field(
                          key,
                          e.target.value
                            .split("\n")
                            .map((v) => v.trim())
                            .filter(Boolean),
                        )
                      }
                    />
                  </label>
                ))}
                <label className="text-sm">
                  <input
                    type="checkbox"
                    checked={form.image_required === true}
                    onChange={(e) => field("image_required", e.target.checked)}
                  />{" "}
                  Nguồn yêu cầu ảnh biển báo
                </label>
              </>
            )}
            <label className="text-sm">
              <input
                type="checkbox"
                checked={!!form.reviewed}
                onChange={(e) => field("reviewed", e.target.checked)}
              />{" "}
              Đã đối chiếu nội dung với nguồn
            </label>
          </form>
          {selected.id && (
            <div className="mt-5 space-y-4 rounded-xl border border-line bg-surface p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="rounded-full bg-sidebar px-2.5 py-1 text-xs font-medium text-navy">
                  {selected.published ? "Đã xuất bản" : "Bản nháp"}
                </span>
                <span className="text-xs text-muted">Phiên bản {selected.version}</span>
              </div>
              {kind !== "units" && (
                <div className="space-y-3 border-y border-line py-3">
                  <FilePicker
                    title={kind === "documents" ? "Tải tài liệu nguồn" : "Tải ảnh biển báo"}
                    hint={kind === "documents" ? "PDF · Tối đa 20 MB" : "PNG hoặc JPEG · Tối đa 5 MB"}
                    accept={kind === "documents" ? ".pdf" : ".png,.jpg,.jpeg"}
                    disabled={task.busy}
                    onChange={(e) => {
                      const file = e.target.files?.[0]
                      if (!file) return
                      task.run(async () => {
                        const body = new FormData()
                        body.append("file", file)
                        const updated = await api<ContentRecord>(`/admin/content/${selected.id}/media`, {
                          method: "POST",
                          body,
                        })
                        applySelection(updated)
                        data.reload()
                      })
                    }}
                  />
                </div>
              )}
              <div className="flex flex-wrap gap-2 empty:hidden">
                {kind !== "units" && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={task.busy}
                    onClick={() =>
                      task.run(async () =>
                        setHistory(
                          await api(`/admin/content/${selected.id}/history`),
                        ),
                      )
                    }
                  >
                    Lịch sử phiên bản
                  </Button>
                )}
                {!!selected.data.fileKey && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => task.run(async () => download(selected.id))}
                  >
                    Tải PDF nguồn
                  </Button>
                )}
              </div>
              {history.map((h) => (
                <div
                  key={`${h.version}-${h.changedAt}`}
                  className="border-b border-line py-3 text-sm"
                >
                  <p>
                    Phiên bản {h.version} ·{" "}
                    {new Date(h.changedAt).toLocaleString("vi-VN")}
                  </p>
                  <p className="mt-1 text-muted">
                    {String(
                      JSON.parse(h.data).text ||
                        JSON.parse(h.data).title ||
                        JSON.parse(h.data).name ||
                        "",
                    )}{" "}
                    · Nguồn:{" "}
                    {String(
                      JSON.parse(h.data).source ||
                        JSON.parse(h.data).so_hieu ||
                        "",
                    )}
                  </p>
                </div>
              ))}
            </div>
          )}
        </Modal>
      )}
      {kind === "documents" && (
        <Relations documents={data.value || []} />
      )}
    </div>
  )
}

export function Relations({ documents }: { documents: ContentRecord[] }) {
  const data = useData<{
      id: string
      predecessor: string
      successor: string
      type: string
      effectiveDate: string
      note: string
      version: number
    }[]>("/admin/law-relations"),
    task = useTask(),
    [predecessor, setPredecessor] = useState(""),
    [successor, setSuccessor] = useState(""),
    [type, setType] = useState("REPLACES"),
    [date, setDate] = useState(""),
    [note, setNote] = useState(""),
    [relationId, setRelationId] = useState(""),
    [relationVersion, setRelationVersion] = useState(0),
    [editing, setEditing] = useState(false)
  return (
    <section className="mt-8 space-y-3">
      <div className="flex flex-wrap justify-between items-center gap-3">
        <h2 className="font-semibold">Quan hệ sửa đổi / thay thế</h2>
        <Button
          disabled={task.busy}
          onClick={() => {
            task.clearError()
            setPredecessor("")
            setSuccessor("")
            setType("REPLACES")
            setDate("")
            setNote("")
            setRelationId("")
            setRelationVersion(0)
            setEditing(true)
          }}
        >
          Thêm quan hệ
        </Button>
      </div>
      <Notice {...data} retry={data.reload} />
      <Notice error={!editing ? task.error : undefined} />
      {data.value && (
        <Card>
          <div className="px-5">
            {!data.value.length && (
              <p className="py-6 text-center text-sm text-muted">
                Chưa có quan hệ văn bản.
              </p>
            )}
            {data.value.map((r) => (
              <p key={r.id} className="text-sm py-3 border-b border-line">
                {documents.find((d) => d.id === r.successor)?.externalId}{" "}
                {r.type === "REPLACES" ? "thay thế" : "sửa đổi"}{" "}
                {documents.find((d) => d.id === r.predecessor)?.externalId} ·{" "}
                {r.effectiveDate} · {r.note}{" "}
                <Button
                  size="sm"
                  onClick={() => {
                    task.clearError()
                    setEditing(true)
                    setPredecessor(r.predecessor)
                    setSuccessor(r.successor)
                    setType(r.type)
                    setDate(r.effectiveDate)
                    setNote(r.note)
                    setRelationId(r.id)
                    setRelationVersion(r.version)
                  }}
                >
                  Chỉnh sửa
                </Button>
              </p>
            ))}
          </div>
        </Card>
      )}
      <Modal
        open={editing}
        title={relationId ? "Chỉnh sửa quan hệ văn bản" : "Thêm quan hệ văn bản"}
        onClose={() => {
          if (!task.busy) setEditing(false)
        }}
        footer={
          <>
            <Button disabled={task.busy} onClick={() => setEditing(false)}>
              Hủy
            </Button>
            <Button type="submit" form="law-relation-editor" disabled={task.busy}>
              Lưu quan hệ
            </Button>
          </>
        }
      >
        <Notice error={task.error} />
        <form
          id="law-relation-editor"
          className="grid sm:grid-cols-2 gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            task.run(async () => {
              await api(
                relationId
                  ? "/admin/law-relations/" + relationId
                  : "/admin/law-relations",
                send(relationId ? "PUT" : "POST", {
                  predecessor,
                  successor,
                  type,
                  effectiveDate: date,
                  note,
                  version: relationVersion,
                }),
              )
              data.reload()
              setNote("")
              setRelationId("")
              setRelationVersion(0)
              setEditing(false)
            })
          }}
        >
          {[
            ["Văn bản cũ", predecessor, setPredecessor],
            ["Văn bản mới", successor, setSuccessor],
          ].map(([label, value, setter]) => (
            <label key={String(label)} className="text-sm">
              {String(label)}
              <select
                required
                value={String(value)}
                onChange={(e) => (setter as (s: string) => void)(e.target.value)}
                className={`${inputCls} mt-2`}
              >
                <option value="">Chọn văn bản</option>
                {documents.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.externalId} — {String(d.data.title)}
                  </option>
                ))}
              </select>
            </label>
          ))}
          <label className="text-sm">
            Quan hệ
            <select
              value={type}
              onChange={(e) => setType(e.target.value)}
              className={`${inputCls} mt-2`}
            >
              <option value="REPLACES">Thay thế</option>
              <option value="AMENDS">Sửa đổi</option>
            </select>
          </label>
          <label className="text-sm">
            Ngày bắt đầu quan hệ
            <input
              type="date"
              required
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className={`${inputCls} mt-2`}
            />
          </label>
          <label className="sm:col-span-2 text-sm">
            Phạm vi/căn cứ
            <input
              required
              maxLength={1000}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className={`${inputCls} mt-2`}
            />
          </label>
        </form>
      </Modal>
    </section>
  )
}

export function ImportPanel({
  kind,
  onImported,
  onClose,
}: {
  kind: ImportKind
  onImported?: () => void
  onClose?: () => void
}) {
  const [parameters] = useSearchParams()
  const graphContext = sourceGraphContext(parameters)
  const { notify } = useAdmin()
  const sets = useData<QuestionSet[]>("/admin/questions/sets")
  const [questionSetId, setQuestionSetId] = useState("")
  const selectedSet =
    questionSetId ||
    (sets.value?.length === 1 ? sets.value[0].set_id : "")
  const [rows, setRows] = useState<unknown[]>([]),
    [preview, setPreview] = useState<{
      row: number
      valid: boolean
      existing?: boolean
      data?: Record<string, unknown>
      message?: string
    }[]>([]),
    [update, setUpdate] = useState(false),
    [message, setMessage] = useState(""),
    [dataInputVersion, setDataInputVersion] = useState(0),
    [zipInputVersion, setZipInputVersion] = useState(0)
  const task = useTask()

  useEffect(() => {
    setRows([])
    setPreview([])
    setMessage("")
    setUpdate(false)
    setQuestionSetId("")
  }, [kind])

  function downloadSample() {
    saveBlob(
      new Blob(["\uFEFF" + csvSamples[kind]], { type: "text/csv;charset=utf-8" }),
      `${kind}-template.csv`,
    )
  }

  return (
    <Card
      title={`Nhập hàng loạt — ${titles[kind]}`}
      right={
        <>
          <Button size="sm" onClick={downloadSample}>
            Tải CSV mẫu
          </Button>
          {onClose && (
            <Button size="sm" variant="ghost" onClick={onClose}>
              Đóng
            </Button>
          )}
        </>
      }
      className="mb-6"
    >
      <div className="px-5 pb-5">
        {graphContext && (
          <p className="mb-3 text-sm">
            <Link className="underline" to={`/admin/chatbot?step=3&${graphContext}`}>
              Quay lại đồ thị và kiểm tra lại nguồn
            </Link>
            . Nhập vẫn là bản nháp; kiểm duyệt và xuất bản trước khi quay lại.
          </p>
        )}
        <p className="mb-4 rounded-lg border border-line bg-bg px-3 py-2 text-xs text-muted">
          Dữ liệu được kiểm tra trên máy chủ và lưu thành bản nháp; chỉ xuất bản sau khi duyệt.
        </p>
        {kind === "questions" && <Notice {...sets} retry={sets.reload} />}
        <Notice error={task.error} />
        {message && (
          <p role="status" className="my-3 text-sm text-emerald-700 whitespace-pre-line">
            {message}
          </p>
        )}
        <div className={`grid items-start gap-4 ${kind === "questions" || kind === "signs" ? "lg:grid-cols-2" : ""}`}>
          <section className="min-w-0 rounded-xl border border-line bg-white p-4 sm:p-5">
            <header className="mb-4 flex items-center gap-3 border-b border-line pb-3">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-selected text-xs font-semibold text-accent-strong">01</span>
              <div>
                <h3 className="text-sm font-semibold text-navy">Nhập tệp dữ liệu</h3>
                <p className="mt-0.5 text-xs text-muted">CSV, Excel (.xlsx) hoặc JSON</p>
              </div>
            </header>
            {kind === "questions" && (
              <div className="mb-4 space-y-2">
                <label className="block text-xs font-medium text-text-secondary">
                  Bộ câu hỏi nhận dữ liệu
                  <select
                    aria-label="Bộ câu hỏi nhận dữ liệu"
                    className={`${inputCls} mt-1.5 bg-bg text-sm`}
                    value={selectedSet}
                    onChange={(e) => {
                      const nextSet = e.target.value
                      setQuestionSetId(nextSet)
                      if (rows.length && nextSet) {
                        void task.run(async () => {
                          setPreview(
                            await api(
                              "/admin/imports/questions/preview",
                              send("POST", {
                                rows,
                                updateExisting: update,
                                questionSetId: nextSet,
                              }),
                            ),
                          )
                        })
                      }
                    }}
                  >
                    <option value="">Chọn bộ câu hỏi đã tạo</option>
                    {sets.value?.map((s) => (
                      <option key={s.set_id} value={s.set_id}>
                        {s.release_code} / {s.set_name}
                      </option>
                    ))}
                  </select>
                </label>
                <p className="text-xs text-muted">
                  Chưa có bộ?{" "}
                  <Link className="font-medium text-accent-strong underline underline-offset-2" to="/admin/questions?tab=sets">
                    Tạo bộ câu hỏi
                  </Link>
                </p>
              </div>
            )}
            <FilePicker
              key={`${kind}-${dataInputVersion}`}
              title="Chọn tệp dữ liệu"
              hint="CSV, Excel (.xlsx) hoặc JSON · Tối đa 10 MB"
              accept=".csv,.xlsx,.json"
              disabled={task.busy}
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (!file) return
                setRows([])
                setPreview([])
                task.run(async () => {
                  if (kind === "questions" && !selectedSet)
                    throw new Error("Chọn bộ câu hỏi trước khi tải tệp câu hỏi.")
                  if (file.size > 10 * 1024 * 1024)
                    throw new Error("Tệp dữ liệu tối đa 10 MB.")
                  let input: unknown
                  if (file.name.endsWith(".json"))
                    input = JSON.parse(await file.text())
                  else if (file.name.endsWith(".xlsx")) {
                    const { readSheet } = await import("read-excel-file/browser")
                    input = tableObjects(await readSheet(file))
                  } else input = tableObjects(parseCsv(await file.text()))
                  if (!Array.isArray(input))
                    throw new Error("Cần danh sách dữ liệu.")
                  input = input.map((row) => normalizeImport(kind, row))
                  setRows(input as unknown[])
                  setPreview(
                    await api(
                      `/admin/imports/${kind}/preview`,
                      send("POST", {
                        rows: input,
                        updateExisting: update,
                        ...(kind === "questions" ? { questionSetId: selectedSet } : {}),
                      }),
                    ),
                  )
                  setMessage("Đã kiểm tra tệp.")
                })
              }}
            />
            <label className="mt-3 flex cursor-pointer items-center gap-2 text-xs text-text-secondary">
              <input
                type="checkbox"
                className="mt-0.5 accent-accent-strong"
                checked={update}
                disabled={task.busy}
                onChange={(e) => {
                  const nextUpdate = e.target.checked
                  setUpdate(nextUpdate)
                  if (rows.length) {
                    task.run(async () => {
                      setPreview(
                        await api(
                          `/admin/imports/${kind}/preview`,
                          send("POST", {
                            rows,
                            updateExisting: nextUpdate,
                            ...(kind === "questions" ? { questionSetId: selectedSet } : {}),
                          }),
                        ),
                      )
                    })
                  }
                }}
              />
              <span>Cập nhật bản ghi trùng mã (chuyển về bản nháp)</span>
            </label>
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-3">
              <p className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted">
                <span><strong className="text-emerald-700">{preview.filter((r) => r.valid).length}</strong> hợp lệ</span>
                <span><strong className={preview.some((r) => !r.valid) ? "text-red-700" : "text-muted"}>{preview.filter((r) => !r.valid).length}</strong> lỗi</span>
                <span><strong className="text-navy">{preview.filter((r) => r.existing).length}</strong> đã có</span>
              </p>
              <Button
                variant="dark"
                size="sm"
                disabled={
                  task.busy ||
                  !rows.length ||
                  preview.some((r) => !r.valid) ||
                  (kind === "questions" && !selectedSet)
                }
                onClick={() =>
                  task.run(async () => {
                    const result = await api<{
                      inserted: number
                      updated: number
                      skipped: number
                    }>(
                      `/admin/imports/${kind}/confirm`,
                      send("POST", {
                        rows,
                        updateExisting: update,
                        ...(kind === "questions" ? { questionSetId: selectedSet } : {}),
                      }),
                    )
                    setRows([])
                    setPreview([])
                    setDataInputVersion((version) => version + 1)
                    setMessage(
                      `Đã thêm ${result.inserted}, cập nhật ${result.updated}, bỏ qua ${result.skipped} bản ghi.`,
                    )
                    notify("Đã nhập bản nháp; chưa xuất bản")
                    onImported?.()
                  })
                }
              >
                Nhập bản nháp
              </Button>
            </div>
          </section>
          {(kind === "questions" || kind === "signs") && (
            <section className="min-w-0 rounded-xl border border-line bg-white p-4 sm:p-5">
              <header className="mb-4 flex items-center gap-3 border-b border-line pb-3">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-selected text-xs font-semibold text-accent-strong">02</span>
                <div>
                  <h3 className="text-sm font-semibold text-navy">Ghép ảnh qua ZIP</h3>
                  <p className="mt-0.5 text-xs text-muted">Chọn tệp để tải lên và ghép ảnh</p>
                </div>
              </header>
              <p className="mb-4 text-xs leading-5 text-muted">
                Tên ảnh theo mã: {kind === "questions" ? "Q301.png" : "DP.127.png"}. ZIP tối đa 20 MB; ảnh PNG/JPEG tối đa 5 MB mỗi tệp.
              </p>
              <FilePicker
                key={`${kind}-${zipInputVersion}`}
                title="Chọn ZIP ảnh"
                hint="ZIP · Tối đa 20 MB mỗi tệp"
                accept=".zip"
                multiple
                disabled={task.busy}
                onChange={(e) => {
                  const files = Array.from(e.target.files || [])
                  if (!files.length) return
                  task.run(async () => {
                    if (kind === "questions" && !selectedSet)
                      throw new Error("Chọn bộ câu hỏi trước khi ghép ảnh câu hỏi.")
                    const messages = []
                    const zipUrl =
                      kind === "questions"
                        ? `/admin/questions/images-zip?questionSetId=${encodeURIComponent(selectedSet)}`
                        : `/admin/${kind}/images-zip`
                    for (const file of files) {
                      const body = new FormData()
                      body.append("file", file)
                      const result = await api<{
                        matched: string[]
                        unmatched: string[]
                      }>(zipUrl, { method: "POST", body })
                      messages.push(
                        `${file.name}: ghép ${result.matched.length} ảnh; chưa khớp ${result.unmatched.join(", ") || "không có"}`,
                      )
                    }
                    setZipInputVersion((version) => version + 1)
                    setMessage(messages.join("\n"))
                    onImported?.()
                  })
                }}
              />
            </section>
          )}
        </div>
        {preview.length > 0 && (
          <Table>
            <thead>
              <tr>
                <Th>Dòng</Th>
                <Th>Mã</Th>
                <Th>Nội dung</Th>
                <Th>Kiểm tra</Th>
              </tr>
            </thead>
            <tbody>
              {preview.map((r) => (
                <tr key={r.row}>
                  <Td>{r.row}</Td>
                  <Td>{String(r.data?.externalId || "")}</Td>
                  <Td>
                    {String(r.data?.text || r.data?.name || r.data?.title || "")}
                  </Td>
                  <Td>
                    {r.valid ? (r.existing ? "Đã tồn tại" : "Hợp lệ") : r.message}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </div>
    </Card>
  )
}
