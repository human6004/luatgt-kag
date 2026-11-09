import { Relations } from "./server/AdminPages";
import { api, send, type ContentRecord } from "../api";
import { Notice, useData, useTask, download } from "./server/shared";
import { runRetrieval, inspectionError } from "./server/kag-inspection";
import { useRef, useState } from "react";
import { useAdmin, type DocStatus, type LegalDoc } from "../admin/store";
import {
  Badge,
  Button,
  Card,
  EditIconButton,
  FilterTabs,
  Field,
  Modal,
  NavLinkButton,
  Page,
  Td,
  Th,
  inputCls,
  type Tone,
} from "../admin/ui";

const statusTone: Record<DocStatus, Tone> = {
  "Chờ xử lý": "gray",
  "Đang xử lý": "gold",
  "Chờ duyệt": "amber",
  "Đã lập chỉ mục": "green",
  "Lưu trữ": "gray",
  Lỗi: "red",
};

export default function AdminKnowledge() {
  const { notify } = useAdmin(),
    task = useTask(),
    data = useData<ContentRecord[]>("/admin/documents");
  const units = useData<ContentRecord[]>("/admin/units");
  const docs: LegalDoc[] = (data.value || []).map((r) => ({
    id: r.id,
    name: String(r.data.title || ""),
    type: String(r.data.type || "") as LegalDoc["type"],
    effective: String(r.data.ngay_hieu_luc || "Chưa có thông tin"),
    status: r.published ? "Đã lập chỉ mục" : "Chờ duyệt",
    chunks:
      units.value?.filter((u) => u.data.doc_id === r.externalId).length || 0,
    entities: 0,
    step: 0,
    updated: "—",
  }));
  const [metadataId, setMetadataId] = useState("");
  const savedMetadata = useRef<ContentRecord | null>(null),
    pendingCreation = useRef("");
  const [metadata, setMetadata] = useState<Record<string, unknown> | null>(
      null,
    ),
    [history, setHistory] = useState<unknown>();
  const [queryError, setQueryError] = useState("");
  const [uploadFiles, setUploadFiles] = useState<File[]>([]);

  const [dragOver, setDragOver] = useState(false);
  const [selectedId, setSelectedId] = useState<string>("");
  const [filter, setFilter] = useState<"all" | DocStatus>("all");
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<null | {
    lf: string[];
    nodes: string[];
    answer: string;
  }>(null);
  const [querying, setQuerying] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const selected = docs.find((d) => d.id === selectedId) || docs[0];
  const record = data.value?.find((r) => r.id === selected?.id);
  const shown =
    filter === "all" ? docs : docs.filter((d) => d.status === filter);

  function approve(d: LegalDoc) {
    const r = data.value?.find((r) => r.id === d.id);
    if (!r) return;
    void task.run(async () => {
      await api(
        `/admin/content/${r.id}/publication`,
        send("POST", { version: r.version, published: true }),
      );
      data.reload();
      notify("Đã xuất bản văn bản");
    });
  }
  async function testQuery() {
    if (!query.trim() || querying) return;
    setQuerying(true);
    setResult(null);
    setQueryError("");
    try {
      const r = await runRetrieval(query, 3, true);
      setResult({
        lf: ["Chưa có API logical form; không tạo logical form giả"],
        nodes: r.items.map((i) => i.entity_id),
        answer: r.items.length
          ? r.items
              .map((i) =>
                Object.values(i.source_texts).filter(Boolean).join("\n"),
              )
              .join("\n\n")
          : "Không tìm thấy evidence. Không có kết luận pháp luật.",
      });
    } catch (e) {
      setQueryError(inspectionError(e));
    } finally {
      setQuerying(false);
    }
  }
  const metadataRecord =
    savedMetadata.current?.id === metadataId
      ? savedMetadata.current
      : data.value?.find((r) => r.id === metadataId);
  function save() {
    if (!metadata || task.busy) return;
    void task.run(async () => {
      let saved: ContentRecord;
      if (metadataRecord && metadata.externalId === metadataRecord.externalId) {
        saved = await api<ContentRecord>(
          `/admin/content/${metadataRecord.id}`,
          send("PUT", { version: metadataRecord.version, data: metadata }),
        );
      } else {
        if (pendingCreation.current !== String(metadata.externalId)) {
          await api(
            "/admin/imports/documents/confirm",
            send("POST", { rows: [metadata], updateExisting: false }),
          );
          pendingCreation.current = String(metadata.externalId);
        }
        const rs = await api<ContentRecord[]>("/admin/documents");
        const added = rs.find((r) => r.externalId === metadata.externalId);
        if (!added)
          throw new Error(
            "Chưa đọc được văn bản vừa nhập; tải lại danh mục trước khi thử lại",
          );
        saved = added;
      }
      savedMetadata.current = saved;
      setMetadataId(saved.id);
      data.reload();
      if (uploadFiles.length) {
        const body = new FormData();
        body.append("file", uploadFiles[0]);
        await api(`/admin/content/${saved.id}/media`, { method: "POST", body });
      }
      pendingCreation.current = "";
      savedMetadata.current = null;
      setUploadFiles([]);
      setMetadata(null);
      data.reload();
      notify("Đã lưu nháp và tệp nguồn; chưa xuất bản");
    });
  }
  function filesSelected(files: File[]) {
    if (!files.length) return;
    setUploadFiles(files.slice(0, 1));
    setMetadataId("");
    setMetadata({
      externalId: "",
      title: files[0].name,
      so_hieu: "",
      source: "",
      ngay_hieu_luc: "",
      reviewed: false,
    });
    notify("Nhập metadata nguồn trước khi lưu; chỉ tải một tệp mỗi văn bản");
  }

  return (
    <Page
      title="Văn bản & tri thức KAG"
      subtitle={`${data.value ? docs.length : "—"} văn bản · số thực thể mỗi văn bản chưa có API`}
      actions={
        <>
          <NavLinkButton to="/admin/imports?type=documents">
            Nhập danh mục
          </NavLinkButton>
          <Button
            onClick={() => {
              task.clearError();
              setMetadataId("");
              setUploadFiles([]);
              setMetadata({
                externalId: "",
                title: "",
                so_hieu: "",
                source: "",
                ngay_hieu_luc: "",
                reviewed: false,
              });
            }}
          >
            + Văn bản
          </Button>
          <Button variant="primary" onClick={() => fileRef.current?.click()}>
            Tải văn bản lên
          </Button>
          <input
            ref={fileRef}
            type="file"
            multiple
            accept=".pdf,.doc,.docx,.md"
            className="hidden"
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              if (files.length) filesSelected(files);
              e.target.value = "";
            }}
          />
        </>
      }
    >
      <Notice {...data} retry={data.reload} />
      <Notice {...units} retry={units.reload} />
      <Notice error={task.error} />
      <p className="mb-4 text-xs text-muted">
        Danh mục, metadata, tệp nguồn và xuất bản dùng API thật. Tự trích xuất
        từ tệp, lưu trữ và xóa chưa có API. Trạng thái xuất bản không chứng minh
        đã lập chỉ mục graph.
      </p>
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-4 min-w-0">
          <FilterTabs
            label="Lọc trạng thái văn bản"
            value={filter}
            onChange={setFilter}
            items={(
              [
                "all",
                "Đã lập chỉ mục",
                "Chờ duyệt",
                "Đang xử lý",
                "Lưu trữ",
              ] as const
            ).map((value) => ({
              value,
              label: value === "all" ? "Tất cả" : value,
            }))}
          />

          <div className="space-y-3 lg:hidden">
            {shown.map((d) => (
              <Card
                key={d.id}
                className={d.id === selectedId ? "bg-selected/50" : ""}
              >
                <div className="space-y-3 p-4">
                  <button
                    type="button"
                    onClick={() => setSelectedId(d.id)}
                    aria-pressed={d.id === selectedId}
                    className="w-full break-words text-left font-medium text-navy focus-visible:outline-2 focus-visible:outline-accent-strong"
                  >
                    {d.name}
                    <span className="mt-1 block text-xs font-normal text-muted">
                      {units.value ? d.chunks : "—"} đơn vị nguồn · thực thể chưa đo
                    </span>
                  </button>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-2 border-t border-line pt-3 text-sm">
                    <p><span className="block text-xs text-muted">Loại</span>{d.type || "Chưa có loại"}</p>
                    <p><span className="block text-xs text-muted">Hiệu lực</span>{d.effective}</p>
                    <p className="col-span-2"><span className="block text-xs text-muted">Trạng thái</span><span className="mt-1 inline-block"><Badge tone={statusTone[d.status]}>{d.status === "Đã lập chỉ mục" ? "Đã xuất bản" : d.status}</Badge></span></p>
                  </div>
                  <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line pt-3">
                    {d.status === "Chờ duyệt" && <Button size="sm" variant="primary" onClick={() => approve(d)}>Duyệt</Button>}
                    <EditIconButton
                      label="Sửa metadata"
                      onClick={() => {
                        const r = data.value?.find((r) => r.id === d.id);
                        setUploadFiles([]);
                        setHistory(undefined);
                        if (r) {
                          task.clearError();
                          setMetadataId(r.id);
                          setSelectedId(r.id);
                          setMetadata({ ...r.data, externalId: r.externalId });
                        }
                      }}
                    />
                    <Button size="sm" onClick={() => {
                      const r = data.value?.find((r) => r.id === d.id);
                      if (r) void task.run(async () => {
                        await api(`/admin/content/${r.id}/publication`, send("POST", { version: r.version, published: false }));
                        data.reload();
                      });
                    }}>Hủy xuất bản</Button>
                  </div>
                </div>
              </Card>
            ))}
            {data.value && !shown.length && (
              <p className="rounded-xl border border-line bg-surface p-5 text-center text-sm text-muted">
                Không có văn bản.
              </p>
            )}
          </div>
          <Card className="hidden overflow-x-auto lg:block">
            <table className="w-full min-w-[640px]">
              <thead className="border-b border-line">
                <tr>
                  <Th>Văn bản</Th>
                  <Th>Loại</Th>
                  <Th>Hiệu lực</Th>
                  <Th>Trạng thái</Th>
                  <Th className="text-right">Thao tác</Th>
                </tr>
              </thead>
              <tbody>
                {shown.map((d) => (
                  <tr
                    key={d.id}
                    className={`border-b border-line/60 last:border-0 transition-colors ${d.id === selectedId ? "bg-selected/60" : "hover:bg-bg"}`}
                  >
                    <Td className="min-w-[200px] font-medium text-navy">
                      <button
                        type="button"
                        onClick={() => setSelectedId(d.id)}
                        aria-pressed={d.id === selectedId}
                        className="w-full text-left focus-visible:outline-2 focus-visible:outline-accent-strong"
                      >
                        {d.name}
                        <span className="block text-[11.5px] font-normal text-muted">
                          {units.value ? d.chunks : "—"} đơn vị nguồn · thực thể
                          chưa đo
                        </span>
                      </button>
                    </Td>
                    <Td className="min-w-28 text-muted">
                      {d.type || "Chưa có loại"}
                    </Td>
                    <Td className="min-w-36 text-muted">{d.effective}</Td>
                    <Td className="min-w-32">
                      <Badge tone={statusTone[d.status]}>
                        {d.status === "Đã lập chỉ mục"
                          ? "Đã xuất bản"
                          : d.status}
                      </Badge>
                    </Td>
                    <Td className="text-right">
                      <span className="inline-flex w-56 flex-wrap justify-end gap-2">
                        {d.status === "Chờ duyệt" && (
                          <Button
                            size="sm"
                            variant="primary"
                            onClick={() => approve(d)}
                          >
                            Duyệt
                          </Button>
                        )}
                        <EditIconButton
                          label="Sửa metadata"
                          onClick={() => {
                            const r = data.value?.find((r) => r.id === d.id);
                            setUploadFiles([]);
                            setHistory(undefined);
                            if (r) {
                              task.clearError();
                              setMetadataId(r.id);
                              setSelectedId(r.id);
                              setMetadata({
                                ...r.data,
                                externalId: r.externalId,
                              });
                            }
                          }}
                        />
                        <Button
                          size="sm"
                          onClick={() => {
                            const r = data.value?.find((r) => r.id === d.id);
                            if (r)
                              void task.run(async () => {
                                await api(
                                  `/admin/content/${r.id}/publication`,
                                  send("POST", {
                                    version: r.version,
                                    published: false,
                                  }),
                                );
                                data.reload();
                              });
                          }}
                        >
                          Hủy xuất bản
                        </Button>
                      </span>
                    </Td>
                  </tr>
                ))}
                {!shown.length && (
                  <tr>
                    <td
                      colSpan={5}
                      className="px-4 py-8 text-center text-sm text-muted"
                    >
                      Không có văn bản.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </Card>

          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              const files = Array.from(e.dataTransfer.files);
              if (files.length) filesSelected(files);
            }}
            onClick={() => fileRef.current?.click()}
            className={`rounded-2xl border-2 border-dashed flex flex-col items-center justify-center gap-1 py-8 transition-colors cursor-pointer ${
              dragOver
                ? "border-accent bg-selected/50"
                : "border-line bg-surface hover:border-progress"
            }`}
          >
            <span className="text-2xl text-accent-strong" aria-hidden>
              ⇪
            </span>
            <span className="text-sm font-medium text-navy">
              Kéo thả PDF / DOCX / MD vào đây
            </span>
            <span className="text-xs text-muted">
              Tải tệp nguồn vào bản nháp. Tự trích xuất: Demo, chưa có API.
            </span>
          </div>
        </div>

        <div className="space-y-4">
          <Card title="Pipeline xử lý">
            <div className="space-y-3 px-5 pb-5">
              <p className="text-sm text-muted">
                Theo dõi tiến trình xử lý thật trong Pipeline.
              </p>
              <NavLinkButton to="/admin/pipeline">Mở Pipeline →</NavLinkButton>
            </div>
          </Card>

          <Card title="Thử truy vấn · Retrieval thật">
            <div className="px-5 pb-5">
              <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start">
                <input
                  className={`${inputCls} flex-1`}
                  aria-label="Nội dung thử truy vấn"
                  placeholder="VD: vượt đèn đỏ xe máy"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && testQuery()}
                />
                <Button
                  className="w-full shrink-0 whitespace-nowrap sm:w-auto"
                  variant="dark"
                  onClick={testQuery}
                  disabled={!query.trim() || querying}
                >
                  Chạy
                </Button>
              </div>
              <Notice error={queryError} />
              <div className="mt-3 rounded-xl bg-bg border border-line p-3 min-h-24 text-xs leading-relaxed">
                {querying && (
                  <p className="text-muted animate-pulse">
                    Đang truy xuất evidence…
                  </p>
                )}
                {!querying && !result && (
                  <p className="text-muted">
                    Retrieval trả evidence và node thực; chưa có API logical
                    form hoặc Solver cho ADMIN.
                  </p>
                )}
                {result && (
                  <div className="space-y-3">
                    <div>
                      <p className="mb-1 font-semibold text-navy">
                        Logical form
                      </p>
                      {result.lf.map((l) => (
                        <p
                          key={l}
                          className="font-mono text-[11px] text-text-secondary"
                        >
                          {l}
                        </p>
                      ))}
                    </div>
                    <div>
                      <p className="mb-1 font-semibold text-navy">Nút đồ thị</p>
                      <div className="flex flex-wrap gap-1">
                        {result.nodes.map((n) => (
                          <Badge key={n} tone="gold">
                            {n}
                          </Badge>
                        ))}
                      </div>
                    </div>
                    <div>
                      <p className="mb-1 font-semibold text-navy">
                        Evidence truy xuất
                      </p>
                      <p className="text-text-secondary">{result.answer}</p>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </Card>
        </div>
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-3 text-xs text-muted">
        <NavLinkButton to="/admin/units">
          Đơn vị pháp lý &amp; quan hệ nguồn
        </NavLinkButton>
      </div>
      <Relations documents={data.value || []} />
      <Modal
        open={!!metadata}
        title="Metadata và tệp nguồn"
        onClose={() => setMetadata(null)}
        footer={
          <>
            <Button onClick={() => setMetadata(null)}>Đóng</Button>
            <Button disabled={task.busy} onClick={save} variant="primary">
              Lưu bản nháp
            </Button>
          </>
        }
      >
        <Notice error={task.error} />
        {metadata && (
          <div className="space-y-3">
            {[
              "externalId",
              "title",
              "so_hieu",
              "source",
              "ngay_hieu_luc",
              "ngay_het_hieu_luc",
            ].map((k) => (
              <Field key={k} label={k} required={!metadataRecord && ["externalId", "title"].includes(k)}>
                <input
                  required={!metadataRecord && ["externalId", "title"].includes(k)}
                  className={inputCls}
                  value={String(metadata[k] || "")}
                  disabled={k === "externalId" && !!metadataRecord}
                  onChange={(e) => {
                    const aliases: Record<string, string> = {
                      externalId: "doc_id",
                      source: "source_url",
                      ngay_hieu_luc: "effective_from",
                      ngay_het_hieu_luc: "effective_to",
                    };
                    setMetadata((p) => ({
                      ...p,
                      [k]: e.target.value,
                      ...(aliases[k] ? { [aliases[k]]: e.target.value } : {}),
                    }));
                  }}
                />
              </Field>
            ))}
            <label className="text-sm">
              <input
                type="checkbox"
                checked={metadata.reviewed === true}
                onChange={(e) =>
                  setMetadata((p) => ({ ...p, reviewed: e.target.checked }))
                }
              />{" "}
              Đã kiểm duyệt nguồn
            </label>
            <Field label="Tệp nguồn">
              <input
                type="file"
                accept=".pdf,.doc,.docx,.md"
                onChange={(e) =>
                  setUploadFiles(Array.from(e.target.files || []).slice(0, 1))
                }
              />
            </Field>
            <p>{uploadFiles[0]?.name || "Chưa chọn tệp mới"}</p>
            {metadataRecord && (
              <>
                <Button
                  onClick={() =>
                    void task.run(async () => download(metadataRecord.id))
                  }
                >
                  Tải tệp nguồn
                </Button>
                <Button
                  onClick={() =>
                    void task.run(async () =>
                      setHistory(
                        await api(
                          `/admin/content/${metadataRecord.id}/history`,
                        ),
                      ),
                    )
                  }
                >
                  Lịch sử chỉnh sửa
                </Button>
                {history !== undefined && (
                  <pre className="text-xs whitespace-pre-wrap break-all">
                    {JSON.stringify(history, null, 2)}
                  </pre>
                )}
              </>
            )}
          </div>
        )}
      </Modal>
    </Page>
  );
}
