import { useState } from "react"

import { Link, Navigate, useSearchParams } from "react-router-dom"

import { api, send, media, type ContentRecord } from "../../api"

import { Page, Button, Card, FilterTabs, Modal, Th, Td } from "../../admin/ui"

import { useData, useTask, Notice, Asset, inputClass, download } from "./shared"

type Kind = "questions" | "signs" | "documents" | "units"

const titles: Record<Kind, string> = {
  questions: "Ngân hàng câu hỏi",
  signs: "Biển báo",
  documents: "Văn bản pháp luật",
  units: "Đơn vị pháp lý",
}

const fields: Record<Kind, string[]> = {
  questions: ["externalId", "text", "chapter", "source", "explanation"],
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
  text: "Câu hỏi",
  chapter: "Chương (1–6)",
  source: "Nguồn",
  explanation: "Giải thích",
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

export function ContentManager({ kind }: { kind: Kind }) {
  const resource = kind === "units" ? "/admin/units" : "/admin/content"

  const data = useData<ContentRecord[]>(`/admin/${kind}`),
    task = useTask(),
    [query, setQuery] = useState(""),
    [selected, setSelected] = useState<ContentRecord | null>(null),
    [form, setForm] = useState<Record<string, unknown>>({}),
    [checked, setChecked] = useState<Set<string>>(new Set()),
    [history, setHistory] = useState<{
      version: number
      changedAt: string
      data: string
    }[]>([]),
    [message, setMessage] = useState(""),
    [state, setState] = useState("")

  const rows = (data.value || []).filter(
    (r) =>
      `${r.externalId} ${r.data.name || r.data.title || r.data.text || ""}`
        .toLowerCase()
        .includes(query.toLowerCase()) &&
      (!state || (state === "published" ? r.published : !r.published)),
  )

  function edit(row: ContentRecord) {
    task.clearError()
    setSelected(row)
    setForm({ ...row.data })
    setHistory([])
    setMessage("")
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

  async function save() {
    if (!selected) return
    const next = await api<ContentRecord>(
      `${resource}/${selected.id}`,
      send("PUT", { version: selected.version, data: form }),
    )
    edit(next)
    data.reload()
    setMessage("Đã lưu bản nháp.")
  }

  return (
    <Page
      title={titles[kind]}
      actions={
        <>
          <Link
            to={`/admin/imports?type=${kind}`}
            className="underline underline-offset-4 text-sm"
          >
            Nhập hàng loạt
          </Link>
          <Button
            disabled={task.busy}
            onClick={() => {
              task.clearError()
              setMessage('')
              setSelected({
                id: "",
                externalId: "",
                version: 0,
                published: false,
                data: {},
              })
              setForm(
                kind === "questions"
                  ? {
                      chapter: 1,
                      options: ["", ""],
                      correctAnswer: null,
                      critical: null,
                      reviewed: false,
                    }
                  : { reviewed: false },
              )
              setHistory([])
            }}
          >
            Thêm mới
          </Button>
        </>
      }
    >
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
          <Card key={label} className="p-5">
            <p className="text-xs text-muted">{label}</p>
            <p className="text-3xl font-semibold mt-3">{value ?? "—"}</p>
          </Card>
        ))}
      </div>
      <input
        aria-label="Tìm nội dung"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Tìm theo mã hoặc nội dung"
        className={`${inputClass} mb-3`}
      />
      <FilterTabs label="Lọc trạng thái xuất bản" value={state} onChange={setState} className="mb-4"
        items={[{value: '', label: 'Tất cả'}, {value: 'published', label: 'Đã xuất bản'}, {value: 'draft', label: 'Bản nháp'}]}/>
      {kind === "questions" && (
        <div className="flex flex-wrap items-center gap-3 my-4">
          <Button onClick={() => setChecked(new Set(rows.map((r) => r.id)))}>
            Chọn {rows.length} câu đang hiển thị
          </Button>
          <Button onClick={() => setChecked(new Set())}>Bỏ chọn</Button>
          <Button
            disabled={task.busy || !checked.size}
            onClick={() =>
              task.run(async () => {
                if (
                  !window.confirm(
                    `Xác nhận đã đối chiếu đáp án, câu điểm liệt và hình của ${checked.size} câu được chọn trước khi xuất bản?`,
                  )
                )
                  return
                await api(
                  "/admin/questions/publication-batch",
                  send("POST", {
                    rows: (data.value || [])
                      .filter((r) => checked.has(r.id))
                      .map((r) => ({ id: r.id, version: r.version })),
                    reviewed: true,
                    published: true,
                  }),
                )
                setChecked(new Set())
                data.reload()
                setMessage("Đã kiểm duyệt và xuất bản các câu được chọn.")
              })
            }
          >
            Duyệt & xuất bản ({checked.size})
          </Button>
        </div>
      )}
      <Table>
        <thead>
          <tr>
            {kind === "questions" && <Th>Chọn</Th>}
            <Th>Mã</Th>
            <Th>Nội dung</Th>
            <Th>Trạng thái</Th>
            <Th>Thao tác</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              {kind === "questions" && (
                <Td>
                  <input
                    type="checkbox"
                    aria-label={`Chọn ${r.externalId}`}
                    checked={checked.has(r.id)}
                    onChange={(e) =>
                      setChecked((prev) => {
                        const next = new Set(prev)
                        e.target.checked ? next.add(r.id) : next.delete(r.id)
                        return next
                      })
                    }
                  />
                </Td>
              )}
              <Td>{r.externalId}</Td>
              <Td>
                <p className="max-w-xl">
                  {String(r.data.text || r.data.title || r.data.name)}
                </p>
                {kind === "questions" && (
                  <p className="text-xs text-muted mt-1">
                    Chương {String(r.data.chapter)}
                    {r.data.critical === true ? " · Điểm liệt" : ""} · Đáp án{" "}
                    {typeof r.data.correctAnswer === "number"
                      ? r.data.correctAnswer + 1
                      : "chưa xác nhận"}
                    {r.data.imageRequired && !r.data.imageKey
                      ? " · Thiếu ảnh"
                      : ""}
                  </p>
                )}
              </Td>
              <Td>{r.published ? "Đã xuất bản" : "Bản nháp"}</Td>
              <Td>
                <Button size="sm" onClick={() => edit(r)}>
                  Chỉnh sửa
                </Button>
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
      {selected && (
        <Modal open={!!selected} title={`${selected.id ? 'Chỉnh sửa' : 'Thêm'} ${kind === 'signs' ? 'biển báo' : kind === 'units' ? 'đơn vị pháp lý' : kind === 'documents' ? 'văn bản' : 'câu hỏi'}`}
          onClose={() => { if (!task.busy) setSelected(null) }}
          footer={<><Button disabled={task.busy} onClick={() => setSelected(null)}>Đóng</Button><Button disabled={task.busy} type="submit" form="content-editor" variant="dark">Lưu bản nháp</Button></>}>
          <Notice error={task.error}/>
          {message && <p role="status" className="mb-4 text-sm text-emerald-700">{message}</p>}
          <form id="content-editor"
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
                  const rows = await api<ContentRecord[]>(`/admin/${kind}`)
                  const created = rows.find(
                    (r) => r.externalId === form.externalId,
                  )
                  if (created) edit(created)
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
                  ["text", "meaning", "explanation"].includes(key)
                    ? "sm:col-span-2"
                    : ""
                }`}
              >
                {kind === "units" && key === "text"
                  ? "Nội dung pháp lý"
                  : labels[key]}
                {["text", "meaning", "explanation"].includes(key) ? (
                  <textarea
                    rows={3}
                    value={String(form[key] || "")}
                    onChange={(e) => field(key, e.target.value)}
                    className={`${inputClass} mt-2`}
                  />
                ) : (
                  <input
                    readOnly={
                      !!selected.id &&
                      ((key === "externalId" && kind !== "questions") ||
                        (key === "doc_id" && kind === "units"))
                    }
                    min={key === "order" ? 0 : undefined}
                    step={["chapter", "order"].includes(key) ? 1 : undefined}
                    type={
                      ["chapter", "order"].includes(key)
                        ? "number"
                        : key.startsWith("ngay_")
                          ? "date"
                          : "text"
                    }
                    value={String(form[key] ?? "")}
                    onChange={(e) =>
                      field(
                        key,
                        ["chapter", "order"].includes(key)
                          ? Number(e.target.value)
                          : (key.startsWith("ngay_") || key === "parent_id") &&
                              !e.target.value
                            ? null
                            : e.target.value,
                      )
                    }
                    className={`${inputClass} mt-2`}
                  />
                )}
              </label>
            ))}
            {kind === "signs" && <>{["children_codes","note"].map(key=><label key={key} className="sm:col-span-2 text-sm">{key==="children_codes"?"Mã biển con (mỗi dòng một mã)":"Ghi chú (mỗi dòng một ghi chú)"}<textarea className={inputClass} rows={3} value={Array.isArray(form[key])?(form[key] as string[]).join('\n'):''} onChange={e=>field(key,e.target.value.split('\n').map(v=>v.trim()).filter(Boolean))}/></label>)}<label className="text-sm"><input type="checkbox" checked={form.image_required===true} onChange={e=>field('image_required',e.target.checked)}/> Nguồn yêu cầu ảnh biển báo</label></>}
            {kind === "questions" && (
              <>
                <label className="sm:col-span-2 text-sm">
                  Các phương án, mỗi dòng một phương án
                  <textarea
                    rows={4}
                    value={(form.options as string[] || []).join("\n")}
                    onChange={(e) =>
                      field("options", e.target.value.split("\n"))
                    }
                    className={`${inputClass} mt-2`}
                  />
                </label>
                <label className="text-sm">
                  Đáp án đúng
                  <select
                    value={
                      form.correctAnswer == null
                        ? ""
                        : String(form.correctAnswer)
                    }
                    onChange={(e) =>
                      field(
                        "correctAnswer",
                        e.target.value === "" ? null : Number(e.target.value),
                      )
                    }
                    className={`${inputClass} mt-2`}
                  >
                    <option value="">Chưa xác nhận</option>
                    {(form.options as string[] || []).map((_, i) => (
                      <option key={i} value={i}>
                        Phương án {i + 1}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="text-sm">
                  Câu điểm liệt
                  <select
                    value={form.critical == null ? "" : String(form.critical)}
                    onChange={(e) =>
                      field(
                        "critical",
                        e.target.value === ""
                          ? null
                          : e.target.value === "true",
                      )
                    }
                    className={`${inputClass} mt-2`}
                  >
                    <option value="">Chưa xác nhận</option>
                    <option value="true">Có</option>
                    <option value="false">Không</option>
                  </select>
                </label>
                <label className="text-sm">
                  <input
                    type="checkbox"
                    checked={!!form.imageRequired}
                    onChange={(e) => field("imageRequired", e.target.checked)}
                  />{" "}
                  Câu hỏi cần hình minh họa
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
            <div className="mt-5 space-y-4">
              <p className="text-xs text-muted">
                Phiên bản {selected.version} ·{" "}
                {selected.published ? "Đã xuất bản" : "Bản nháp"}
              </p>
              {kind !== "documents" && !!selected.data.imageKey && (
                <Asset id={selected.id} alt="Ảnh nguồn đã lưu" />
              )}
              {kind !== "units" && (
                <label className="block text-sm">
                  {kind === "documents" ? "Tài liệu PDF nguồn" : "Ảnh PNG/JPEG"}
                  <input
                    aria-label="Tải tệp nguồn"
                    type="file"
                    accept={kind === "documents" ? ".pdf" : ".png,.jpg,.jpeg"}
                    disabled={task.busy}
                    onChange={(e) => {
                      const file = e.target.files?.[0]
                      if (!file) return
                      task.run(async () => {
                        const body = new FormData()
                        body.append("file", file)
                        edit(
                          await api(`/admin/content/${selected.id}/media`, {
                            method: "POST",
                            body,
                          }),
                        )
                        data.reload()
                      })
                    }}
                    className="block mt-2"
                  />
                </label>
              )}
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={task.busy}
                  onClick={() =>
                    task.run(async () => {
                      await save()
                      const current = await api<ContentRecord[]>(
                        `/admin/${kind}`,
                      )
                      const record = current.find((r) => r.id === selected.id)!
                      edit(
                        await api(
                          `${resource}/${record.id}/publication`,
                          send("POST", {
                            version: record.version,
                            published: !selected.published,
                          }),
                        ),
                      )
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
                {kind !== "units" && (
                  <Button
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
      {kind === "documents" && <Relations documents={data.value || []} />}
    </Page>
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
        <Button disabled={task.busy} onClick={() => {
          task.clearError(); setPredecessor(''); setSuccessor(''); setType('REPLACES'); setDate(''); setNote(''); setRelationId(''); setRelationVersion(0); setEditing(true)
        }}>Thêm quan hệ</Button>
      </div>
      <Notice {...data} retry={data.reload} />
      <Notice error={!editing ? task.error : undefined} />
      {data.value && <Card><div className="px-5">
      {!data.value.length && <p className="py-6 text-center text-sm text-muted">Chưa có quan hệ văn bản.</p>}
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
      </div></Card>}
      <Modal open={editing} title={relationId ? 'Chỉnh sửa quan hệ văn bản' : 'Thêm quan hệ văn bản'} onClose={() => { if (!task.busy) setEditing(false) }}
        footer={<><Button disabled={task.busy} onClick={() => setEditing(false)}>Hủy</Button><Button type="submit" form="law-relation-editor" disabled={task.busy}>Lưu quan hệ</Button></>}>
      <Notice error={task.error}/>
      <form id="law-relation-editor"
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
              className={`${inputClass} mt-2`}
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
            className={`${inputClass} mt-2`}
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
            className={`${inputClass} mt-2`}
          />
        </label>
        <label className="sm:col-span-2 text-sm">
          Phạm vi/căn cứ
          <input
            required
            maxLength={1000}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            className={`${inputClass} mt-2`}
          />
        </label>
      </form>
      </Modal>
    </section>
  )
}

export function Imports() {
  const [params] = useSearchParams()
  const requested = params.get("type")
  const kind = requested === "signs" || requested === "documents" || requested === "units" ? requested : "questions"
  return <Navigate to={`/admin/imports?type=${kind}`} replace/>
}
