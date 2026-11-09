import { api, send, type ContentRecord } from "../api";
import { Notice, useData, Asset } from "./server/shared";
import { normalizeImport } from "./server/import-normalization";
import { useEffect, useMemo, useRef, useState } from "react";
import JSZip from "jszip";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useAdmin } from "../admin/store";
import {
  Button,
  Card,
  FilterTabs,
  Field,
  Modal,
  Page,
  Td,
  Th,
  inputCls,
} from "../admin/ui";
import {
  parseCsv,
  samples,
  tableObjects,
  type ImportKind as ContentImportKind,
  type PreviewRow,
  type SignRecord,
} from "../admin/demo-import-data";
import type { QuestionSet } from "./server/QuestionBankSettings";

type ImportKind = ContentImportKind | "units";
const titles: Record<ImportKind, string> = {
  signs: "Biển báo",
  questions: "Ngân hàng câu hỏi",
  documents: "Thông tin văn bản",
  units: "Đơn vị pháp lý",
};
const keyOfSign = (s: SignRecord) => s.code;
const maxFileSize = 20 * 1024 * 1024;

function readZipImage(entry: JSZip.JSZipObject): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    let size = 0;
    // JSZip exposes this method at runtime but omits it from JSZipObject's typings.
    const stream = (
      entry as JSZip.JSZipObject & {
        internalStream(type: "uint8array"): JSZip.JSZipStreamHelper<Uint8Array>;
      }
    ).internalStream("uint8array");
    stream
      .on("data", (chunk) => {
        size += chunk.length;
        if (size > 5 * 1024 * 1024) {
          stream.pause();
          reject(new Error(`Ảnh ${entry.name} vượt 5 MB sau giải nén.`));
          return;
        }
        chunks.push(new Uint8Array(chunk));
      })
      .on("error", reject)
      .on("end", () => resolve(new Blob(chunks)))
      .resume();
  });
}

export default function AdminImports() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const requestedKind = params.get("type");
  const kind: ImportKind =
    requestedKind === "questions" ||
    requestedKind === "documents" ||
    requestedKind === "units"
      ? requestedKind
      : "signs";
  const projectId = params.get("project_id") || "",
    runId = params.get("run_id") || "";
  const graphHref =
    /^[1-9][0-9]{0,9}$/.test(projectId) &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)
      ? `/admin/graph?project_id=${projectId}&run_id=${encodeURIComponent(runId)}`
      : "";
  const { notify } = useAdmin(),
    data = useData<ContentRecord[]>(`/admin/${kind}`);
  const sets = useData<QuestionSet[]>("/admin/questions/sets");
  const [questionSetId, setQuestionSetId] = useState("");
  const signs = (kind === "signs" ? data.value || [] : []).map((r) => ({
    code: String(r.data.code || r.externalId),
    name: String(r.data.name || ""),
    group: String(r.data.group || ""),
    meaning: String(r.data.meaning || ""),
    source: String(r.data.source || r.data.doc_id || ""),
    image: r.data.imageKey ? "server" : undefined,
    id: r.id,
  }));
  const [inputRows, setInputRows] = useState<unknown[]>([]),
    [zipFile, setZipFile] = useState<File>();
  const [serverPreview, setServerPreview] = useState<
    {
      row: number;
      valid: boolean;
      existing?: boolean;
      data?: Record<string, unknown>;
      message?: string;
    }[]
  >([]);

  const [rows, setRows] = useState<PreviewRow[]>([]);
  const [images, setImages] = useState<Record<string, string>>({});
  const [imagePreview, setImagePreview] = useState<string>();
  const [showQuestionPreview, setShowQuestionPreview] = useState(false);
  const [replacementReview, setReplacementReview] = useState<
    { record: ContentRecord; code: string }[]
  >([]);
  const [replaceSelected, setReplaceSelected] = useState<Set<string>>(
    new Set(),
  );
  const previewMatches =
    kind === "questions" && imagePreview
      ? (data.value || []).filter(
          (row) =>
            row.data.questionSetId === questionSetId &&
            String(
              row.data.sourceExternalId ?? row.externalId,
            ).toUpperCase() === imagePreview,
        )
      : [];
  const previewQuestion =
    previewMatches.length === 1 ? previewMatches[0].data : undefined;
  const previewOptions = Array.isArray(previewQuestion?.options)
    ? previewQuestion.options.map(String)
    : [];
  const zipInputRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [update, setUpdate] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [message, setMessage] = useState("");
  const existing =
    kind === "signs"
      ? signs.map(keyOfSign)
      : (data.value || []).map((r) => r.externalId);
  const existingKeys = new Set(existing.map((key) => key.toUpperCase()));
  const valid = rows.filter((row) => row.record);
  const duplicates = valid.filter((row) =>
    existingKeys.has(row.key.toUpperCase()),
  );
  const candidates = valid.filter(
    (row) => update || !existingKeys.has(row.key.toUpperCase()),
  );
  const unmatched = useMemo(
    () =>
      Object.keys(images).filter(
        (code) =>
          ![...signs.map(keyOfSign), ...valid.map((r) => r.key)].some(
            (key) => key.toUpperCase() === code,
          ),
      ),
    [images, signs, rows],
  );
  const imageMatches = signs.filter((sign) => images[sign.code.toUpperCase()]);

  function switchKind(next: ImportKind) {
    setParams((previous) => {
      const updated = new URLSearchParams(previous);
      updated.set("type", next);
      return updated;
    });
  }

  useEffect(() => {
    setRows([]);
    setInputRows([]);
    setServerPreview([]);
    setZipFile(undefined);
    setImages({});
    setError("");
    setMessage("");
    setFileName("");
    setConfirmed(false);
    setUpdate(false);
  }, [kind]);

  function downloadSample() {
    const sample =
      kind === "units"
        ? "unit_id,doc_id,parent_id,unit_type,so_hieu,text,order\n"
        : samples[kind];
    const url = URL.createObjectURL(
      new Blob(["\uFEFF" + sample], { type: "text/csv;charset=utf-8" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `${kind}-template.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  async function readData(file?: File) {
    if (!file) return;
    setRows([]);
    setInputRows([]);
    setServerPreview([]);
    setError("");
    setMessage("");
    setConfirmed(false);
    setFileName(file.name);
    setBusy(true);
    try {
      const limit = kind === "units" ? 10 : 20;
      if (file.size > limit * 1024 * 1024)
        throw new Error(`Tệp dữ liệu tối đa ${limit} MB.`);
      let input: unknown;
      if (/\.xlsx$/i.test(file.name)) {
        const { readSheet } = await import("read-excel-file/browser");
        input = tableObjects(await readSheet(file));
      } else if (/\.csv$/i.test(file.name))
        input = tableObjects(parseCsv(await file.text()));
      else if (/\.json$/i.test(file.name))
        input = JSON.parse(await file.text());
      else
        throw new Error(
          "Chọn CSV, Excel .xlsx hoặc JSON; tệp Excel .xls cần chuyển sang .xlsx.",
        );
      if (!Array.isArray(input)) throw new Error("Cần danh sách dữ liệu");
      const normalized = input.map((row) => normalizeImport(kind, row));
      setInputRows(normalized);
      if (kind === "questions" && !questionSetId)
        throw new Error(
          "Chọn bộ câu hỏi trước khi nhập để tách dữ liệu 250 và 600 câu.",
        );
      const preview = await api<typeof serverPreview>(
        `/admin/imports/${kind}/preview`,
        send("POST", {
          rows: normalized,
          updateExisting: update,
          ...(kind === "questions" ? { questionSetId } : {}),
        }),
      );
      if (!preview.length) throw new Error("Tệp không có dòng dữ liệu");
      setServerPreview(preview);
      setRows(
        preview.map((p) => ({
          line: p.row,
          key: String(p.data?.externalId || ""),
          title: String(p.data?.text || p.data?.name || p.data?.title || ""),
          record: p.valid
            ? (p.data as unknown as PreviewRow["record"])
            : undefined,
          errors: p.valid ? [] : [p.message || "Dòng không hợp lệ"],
        })),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Không đọc được tệp.");
    } finally {
      setBusy(false);
    }
  }

  async function readImages(file?: File) {
    if (!file) return;
    setImagePreview(undefined);
    setError("");
    setMessage("");
    setImages({});
    setZipFile(undefined);
    setConfirmed(false);
    setBusy(true);
    try {
      if (file.size > maxFileSize) throw new Error("ZIP ảnh tối đa 20 MB.");
      const zip = await JSZip.loadAsync(await file.arrayBuffer());
      const entries = Object.values(zip.files).filter(
        (entry) => !entry.dir && !entry.name.startsWith("__MACOSX/"),
      );
      if (entries.length > 1000) throw new Error("ZIP tối đa 1.000 tệp.");
      const next: Record<string, string> = {};
      let total = 0;
      for (const entry of entries) {
        if (!/\.(png|jpe?g|webp)$/i.test(entry.name))
          throw new Error(
            `Ảnh ${entry.name}: chỉ hỗ trợ PNG, JPEG, WebP. SVG cần được xử lý an toàn ở backend.`,
          );
        const code = entry.name
          .split("/")
          .pop()!
          .replace(/\.[^.]+$/, "")
          .toUpperCase();
        if (!/^[A-Z0-9._-]+$/.test(code) || next[code])
          throw new Error(`Tên ảnh không hợp lệ hoặc trùng mã: ${entry.name}`);
        const blob = await readZipImage(entry);
        total += blob.size;
        if (blob.size > 5 * 1024 * 1024 || total > 50 * 1024 * 1024)
          throw new Error(
            "Mỗi ảnh tối đa 5 MB, tổng ảnh giải nén tối đa 50 MB.",
          );
        const bitmap = await createImageBitmap(blob);
        if (bitmap.width > 4096 || bitmap.height > 4096) {
          bitmap.close();
          throw new Error(`Ảnh ${entry.name} vượt 4.096 pixel.`);
        }
        bitmap.close();
        next[code] = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(new Error("Không đọc được ảnh"));
          reader.readAsDataURL(blob);
        });
      }
      if (!Object.keys(next).length) throw new Error("ZIP không có ảnh.");
      setImages(next);
      setZipFile(file);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Không đọc được ZIP ảnh.");
    } finally {
      setBusy(false);
    }
  }

  async function confirmImport() {
    if (
      busy ||
      !inputRows.length ||
      serverPreview.length !== inputRows.length ||
      confirmed ||
      serverPreview.some((p) => !p.valid)
    )
      return;
    setBusy(true);
    setError("");
    try {
      const r = await api<{
        inserted: number;
        updated: number;
        skipped: number;
      }>(
        `/admin/imports/${kind}/confirm`,
        send("POST", {
          rows: inputRows,
          updateExisting: update,
          ...(kind === "questions" ? { questionSetId } : {}),
        }),
      );
      setConfirmed(true);
      const summary = `Đã thêm ${r.inserted}, cập nhật ${r.updated}, bỏ qua ${r.skipped} bản nháp.`;
      data.reload();
      notify(summary);
      if (kind === "questions" && (r.inserted > 0 || r.updated > 0))
        navigate("/admin/questions?status=draft");
      else setMessage(`${summary} Dữ liệu vẫn là bản nháp trên server.`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function clearZipSelection() {
    setReplacementReview([]);
    setReplaceSelected(new Set());
    setZipFile(undefined);
    setImages({});
    setImagePreview(undefined);
    if (zipInputRef.current) zipInputRef.current.value = "";
  }

  async function attachImages() {
    if (!zipFile || busy) return;
    setBusy(true);
    setError("");
    try {
      const current = await api<ContentRecord[]>(`/admin/${kind}`);
      const scoped = current.filter(
        (row) =>
          kind !== "questions" || row.data.questionSetId === questionSetId,
      );
      const conflicts = Object.keys(images).flatMap((code) => {
        const matches = scoped.filter(
          (row) =>
            String(
              kind === "questions"
                ? (row.data.sourceExternalId ?? row.externalId)
                : row.data.code,
            ).toUpperCase() === code,
        );
        return matches.length === 1 && matches[0].data.imageKey
          ? [{ record: matches[0], code }]
          : [];
      });
      setReplaceSelected(new Set());
      if (conflicts.length) setReplacementReview(conflicts);
      else await uploadImages({});
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function uploadImages(replacements: Record<string, number>) {
    if (!zipFile) return;
    setBusy(true);
    setError("");
    try {
      const body = new FormData();
      body.append("file", zipFile);
      body.append(
        "replacements",
        new Blob([JSON.stringify(replacements)], { type: "application/json" }),
      );
      const path =
        kind === "questions"
          ? `/admin/questions/images-zip?questionSetId=${encodeURIComponent(questionSetId)}`
          : "/admin/signs/images-zip";
      const result = await api<{
        matched: string[];
        unmatched: string[];
        kept: string[];
      }>(path, { method: "POST", body });
      setMessage(
        `Ghép ${result.matched.length} ảnh; giữ ảnh cũ: ${result.kept.length}; chưa khớp: ${result.unmatched.join(", ") || "Không có"}`,
      );
      clearZipSelection();
      data.reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Page
      title="Nhập dữ liệu"
      subtitle="Chọn loại dữ liệu, tải tệp và kiểm tra trước khi xác nhận nhập."
      actions={<Button onClick={downloadSample}>Tải CSV mẫu</Button>}
    >
      {graphHref && (
        <p className="mb-4 text-sm text-muted">
          <Link className="underline underline-offset-4" to={graphHref}>
            Quay lại đồ thị và kiểm tra lại nguồn
          </Link>
          . Dữ liệu nhập vẫn là bản nháp; kiểm duyệt và xuất bản trước khi quay
          lại.
        </p>
      )}
      <FilterTabs
        label="Loại dữ liệu"
        value={kind}
        onChange={switchKind}
        disabled={busy}
        className="mb-6"
        items={(Object.keys(titles) as ImportKind[]).map((value) => ({
          value,
          label: titles[value],
        }))}
      />
      {kind === "questions" && (
        <div className="mb-6 space-y-3">
          <Notice {...sets} retry={sets.reload} />
          <div className="flex flex-wrap items-end gap-3">
            <div className="w-full min-w-0 sm:flex-1 sm:max-w-xl">
              <Field label="Bộ câu hỏi nhận dữ liệu" required>
                <select
                  required
                  aria-label="Bộ câu hỏi nhận dữ liệu"
                  value={questionSetId}
                  disabled={
                    busy || sets.loading || !!sets.error || !sets.value?.length
                  }
                  className={inputCls}
                  onChange={(e) => {
                    setQuestionSetId(e.target.value);
                    setRows([]);
                    setInputRows([]);
                    setServerPreview([]);
                    setConfirmed(false);
                    setError("");
                    setMessage("");
                    setZipFile(undefined);
                    setImages({});
                  }}
                >
                  <option value="" disabled>
                    {sets.loading
                      ? "Đang tải bộ câu hỏi…"
                      : sets.error
                        ? "Không tải được bộ câu hỏi"
                        : !sets.value?.length
                          ? "Chưa có bộ câu hỏi"
                          : "Chọn bộ câu hỏi"}
                  </option>
                  {sets.value?.map((s) => (
                    <option key={s.set_id} value={s.set_id}>
                      {s.release_code} / {s.set_name}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <Link
              to="/admin/question-bank-settings"
              className="inline-flex min-h-10 items-center text-xs text-muted underline underline-offset-4 hover:text-navy"
            >
              Quản lý bộ
            </Link>
          </div>
          {!sets.loading && !sets.error && !sets.value?.length && (
            <p role="status" className="text-sm text-muted">
              Chưa tạo bộ nhận dữ liệu. Tạo bộ 250 hoặc 600 câu tại Quản lý ngân
              hàng câu hỏi, sau đó quay lại để nhập.
            </p>
          )}
        </div>
      )}
      <Notice {...data} retry={data.reload} />
      <p className="mb-5 text-sm text-muted">
        Dữ liệu nhập được lưu dưới dạng bản nháp. Kiểm duyệt trước khi xuất bản
        cho người dùng.
      </p>
      <div className="grid items-start gap-6 lg:grid-cols-2 mb-6">
        <section className="min-w-0 flex flex-col gap-3">
          <h2 className="text-lg font-semibold text-navy">
            {kind === "questions"
              ? "1. Nhập dữ liệu câu hỏi"
              : kind === "signs"
                ? "1. Nhập danh mục biển báo"
                : kind === "units"
                  ? "1. Nhập đơn vị pháp lý"
                  : "1. Nhập thông tin văn bản"}
          </h2>
          <Card>
            <div className="p-5 space-y-4">
              <Field
                label="CSV / Excel .xlsx / JSON"
                required
                hint={
                  kind === "questions" && !questionSetId
                    ? "Chọn bộ câu hỏi ở phía trên để bật chọn tệp."
                    : "Excel đọc sheet đầu tiên. Dòng đầu là tên cột theo CSV mẫu."
                }
              >
                <input
                  key={kind}
                  aria-label="Tệp dữ liệu"
                  type="file"
                  required
                  onClick={(e) => {
                    e.currentTarget.value = "";
                  }}
                  accept=".csv,.xlsx,.json"
                  disabled={busy || (kind === "questions" && !questionSetId)}
                  onChange={(e) => {
                    void readData(e.target.files?.[0]);
                  }}
                  className="block w-full text-sm disabled:cursor-not-allowed disabled:opacity-60 file:mr-3 file:rounded-md file:border file:border-navy/35 file:bg-selected file:px-3 file:py-2 file:cursor-pointer"
                />
              </Field>
              <p className="text-xs leading-6 text-muted">
                {kind === "signs"
                  ? "Cột: code, name, group, meaning, source. Mã biển là khóa để ghép ảnh."
                  : kind === "questions"
                    ? "Cột: id, chapter, question, option1…option4, answer, critical, explanation, source. CSV/Excel: answer từ 1. JSON dùng định dạng Xuất JSON: answer từ 0."
                    : kind === "units"
                      ? "Cột: unit_id, doc_id, parent_id, unit_type, so_hieu, text, order. Văn bản nguồn phải tồn tại; đơn vị cha phải thuộc cùng văn bản. Tệp tối đa 10 MB."
                      : "Cột: id, name, type, effective (YYYY-MM-DD). Chỉ nhập thông tin văn bản; tải nội dung PDF/DOCX ở Văn bản & tri thức KAG."}
              </p>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={update}
                  disabled={busy || confirmed}
                  onChange={(e) => {
                    setUpdate(e.target.checked);
                    setRows([]);
                    setInputRows([]);
                    setServerPreview([]);
                    setMessage(
                      "Chọn lại tệp để xem trước theo lựa chọn cập nhật mới",
                    );
                  }}
                  className="mt-1 accent-[var(--color-accent-strong)]"
                />
                Cập nhật bản ghi cùng mã và chuyển về nháp; giữ ảnh đã lưu. Mặc
                định bỏ qua.
              </label>
            </div>
          </Card>
        </section>
        {kind === "signs" ? (
          <section className="min-w-0 flex flex-col gap-3">
            <h2 className="text-lg font-semibold text-navy">
              2. Ghép ảnh theo mã biển
            </h2>
            <Card>
              <div className="p-5 space-y-4">
                <Field
                  label="ZIP ảnh PNG / JPEG / WebP"
                  hint="Ví dụ: images/P.102.png. Tên ảnh phải khớp mã biển, không phân biệt hoa/thường."
                >
                  <input
                    ref={zipInputRef}
                    aria-label="ZIP ảnh biển báo"
                    type="file"
                    onClick={(e) => {
                      e.currentTarget.value = "";
                    }}
                    accept=".zip"
                    disabled={busy}
                    onChange={(e) => {
                      void readImages(e.target.files?.[0]);
                    }}
                    className="block w-full text-sm file:mr-3 file:rounded-md file:border file:border-navy/35 file:bg-selected file:px-3 file:py-2 file:cursor-pointer"
                  />
                </Field>
                <p className="text-sm text-muted">
                  Có thể nhập danh mục trước, ghép ảnh sau. Biển thiếu ảnh vẫn
                  được lưu để bổ sung.
                </p>
                {Object.keys(images).length > 0 && (
                  <p className="text-sm">
                    {Object.keys(images).length} ảnh · {imageMatches.length}{" "}
                    khớp danh mục đã nhập · {unmatched.length} chưa có mã tương
                    ứng
                  </p>
                )}
                {unmatched.length > 0 && (
                  <p className="text-xs text-amber-700 break-words">
                    Chưa khớp: {unmatched.join(", ")}
                  </p>
                )}
                <div className="flex flex-wrap gap-3">
                  <Button
                    disabled={busy || !zipFile || !imageMatches.length}
                    onClick={attachImages}
                  >
                    Ghép ảnh vào danh mục đã nhập
                  </Button>
                  <Button
                    variant="outline"
                    disabled={busy || !zipFile}
                    onClick={() => {
                      clearZipSelection();
                      setError("");
                      setMessage("");
                    }}
                  >
                    Hủy chọn ZIP
                  </Button>
                </div>
              </div>
            </Card>
          </section>
        ) : kind === "questions" ? (
          <section className="min-w-0 flex flex-col gap-3">
            <h2 className="text-lg font-semibold text-navy">2. Ghép ZIP ảnh</h2>
            <Card>
              <div className="p-5 space-y-4">
                <Field
                  label="ZIP ảnh của bộ đã chọn"
                  hint={
                    !questionSetId
                      ? "Chọn bộ câu hỏi ở phía trên để bật chọn ZIP ảnh."
                      : undefined
                  }
                >
                  <input
                    ref={zipInputRef}
                    key={questionSetId}
                    type="file"
                    aria-label="ZIP ảnh câu hỏi"
                    accept=".zip"
                    disabled={busy || !questionSetId}
                    onClick={(e) => {
                      e.currentTarget.value = "";
                    }}
                    onChange={(e) => void readImages(e.target.files?.[0])}
                    className="block w-full text-sm disabled:cursor-not-allowed disabled:opacity-60 file:mr-3 file:rounded-md file:border file:border-navy/35 file:bg-selected file:px-3 file:py-2 file:cursor-pointer"
                  />
                </Field>
                <p className="text-xs leading-6 text-muted">
                  Nhập dữ liệu câu hỏi trước, sau đó ghép ảnh vào cùng bộ. Tên
                  ảnh phải khớp mã câu hỏi, ví dụ Q001.png.
                </p>
                {Object.keys(images).length > 0 && (
                  <>
                    <p role="status" className="text-sm text-muted">
                      Đã chọn {Object.keys(images).length} ảnh để ghép vào bộ.
                    </p>
                    <details open className="space-y-3">
                      <summary className="cursor-pointer text-sm font-medium text-navy">
                        Xem trước ảnh trong ZIP
                      </summary>
                      <p className="text-xs text-muted">
                        Bấm ảnh để phóng to và xem trước câu hỏi tương ứng. Ảnh
                        chỉ được lưu sau khi bấm ghép.
                      </p>
                      <div className="grid max-h-80 grid-cols-2 gap-3 overflow-y-auto p-1 sm:grid-cols-3">
                        {Object.entries(images).map(([code, src]) => (
                          <button
                            key={code}
                            type="button"
                            onClick={() => {
                              setShowQuestionPreview(false);
                              setImagePreview(code);
                            }}
                            aria-label={`Xem ảnh ${code}`}
                            className="min-w-0 rounded-xl border border-line bg-white p-2 text-center hover:border-accent focus-visible:outline-2 focus-visible:outline-accent-strong"
                          >
                            <img
                              src={src}
                              alt={`Ảnh câu hỏi ${code}`}
                              loading="lazy"
                              className="h-28 w-full object-contain"
                            />
                            <span className="mt-2 block break-words text-xs text-navy">
                              {code}
                            </span>
                          </button>
                        ))}
                      </div>
                    </details>
                  </>
                )}
                <div className="flex flex-wrap gap-3">
                  <Button
                    disabled={busy || !zipFile || !questionSetId}
                    onClick={attachImages}
                  >
                    Ghép ảnh vào bộ đã chọn
                  </Button>
                  <Button
                    variant="outline"
                    disabled={busy || !zipFile}
                    onClick={() => {
                      clearZipSelection();
                      setError("");
                      setMessage("");
                    }}
                  >
                    Hủy chọn ZIP
                  </Button>
                </div>
              </div>
            </Card>
          </section>
        ) : (
          <section className="min-w-0 flex flex-col gap-3">
            <h2 className="text-lg font-semibold text-navy">
              Chuẩn hóa và kiểm duyệt
            </h2>
            <Card>
              <div className="p-5 text-sm text-muted leading-7">
                Các dòng lỗi cần sửa trong tệp rồi tải lại. Trùng mã trong cùng
                tệp được đánh dấu lỗi. Dữ liệu nhập chưa được xác minh với nguồn
                chính thức. Trích PDF chưa có API: Demo. Kiểm duyệt và xuất bản
                dùng API thật tại trang quản lý nội dung.
              </div>
            </Card>
          </section>
        )}
      </div>
      {busy && (
        <p role="status" className="mb-4 text-sm">
          Đang đọc và kiểm tra tệp…
        </p>
      )}
      {error && (
        <p role="alert" className="mb-4 text-sm text-red-700">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="mb-4 text-sm text-emerald-700">
          {message}
        </p>
      )}
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-navy">Xem trước dữ liệu</h2>
          <span className="text-xs text-muted">
            {fileName || "Chưa chọn tệp"}
          </span>
        </div>
        <Card>
          {!rows.length ? (
            <p className="px-5 py-5 text-sm text-muted">
              Chọn tệp để xem các dòng hợp lệ, lỗi và mã trùng trước khi xác
              nhận.
            </p>
          ) : (
            <>
              <p className="px-5 py-4 text-sm text-muted">
                {rows.length} dòng · {valid.length} hợp lệ ·{" "}
                {rows.length - valid.length} lỗi · {duplicates.length} trùng
                danh mục
              </p>
              <div className="overflow-x-auto max-h-96">
                <table className="w-full min-w-[640px]">
                  <thead className="bg-sidebar">
                    <tr>
                      <Th>Dòng</Th>
                      <Th>Mã</Th>
                      <Th>Nội dung</Th>
                      {kind === "signs" && <Th>Ảnh</Th>}
                      <Th>Kết quả kiểm tra</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={row.line} className="border-t border-line">
                        <Td>{row.line}</Td>
                        <Td>{row.key || "—"}</Td>
                        <Td>{row.title || "—"}</Td>
                        {kind === "signs" && (
                          <Td>
                            {images[row.key.toUpperCase()] ? (
                              <img
                                src={images[row.key.toUpperCase()]}
                                alt={`Biển ${row.key}`}
                                className="w-12 h-12 object-contain"
                              />
                            ) : (
                              <span className="text-muted">
                                {signs.find(
                                  (s) => s.code === row.key.toUpperCase(),
                                )?.image
                                  ? "Giữ ảnh hiện có"
                                  : "Chưa có ảnh"}
                              </span>
                            )}
                          </Td>
                        )}
                        <Td>
                          <span
                            className={
                              row.errors.length
                                ? "text-red-700"
                                : "text-text-secondary"
                            }
                          >
                            {row.errors.length
                              ? row.errors.join("; ")
                              : existingKeys.has(row.key.toUpperCase())
                                ? update
                                  ? "Sẽ cập nhật"
                                  : "Bỏ qua mã đã có"
                                : "Sẽ thêm mới"}
                          </span>
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="p-5 flex flex-wrap items-center gap-4">
                <Button
                  variant="dark"
                  disabled={
                    busy ||
                    !!error ||
                    !inputRows.length ||
                    serverPreview.length !== inputRows.length ||
                    serverPreview.some((p) => !p.valid) ||
                    confirmed
                  }
                  onClick={confirmImport}
                >
                  {confirmed
                    ? "Đã nhập"
                    : `Xác nhận nhập ${candidates.length} dòng hợp lệ`}
                </Button>
                <span className="text-xs text-muted">
                  Dòng lỗi không được nhập.
                </span>
              </div>
            </>
          )}
        </Card>
      </section>
      {kind === "signs" && (
        <section className="mt-6 space-y-3">
          <h2 className="text-lg font-semibold text-navy">
            Danh mục biển báo đã nhập ({signs.length})
          </h2>
          <Card className="overflow-hidden">
            <div className="max-h-96 overflow-x-auto">
              <table className="w-full min-w-[600px]">
                <thead className="bg-sidebar">
                  <tr>
                    <Th>Ảnh</Th>
                    <Th>Mã / Tên</Th>
                    <Th>Nhóm</Th>
                    <Th>Ý nghĩa / Nguồn</Th>
                  </tr>
                </thead>
                <tbody>
                  {signs.map((sign) => (
                    <tr key={sign.code} className="border-t border-line">
                      <Td>
                        {sign.image ? (
                          <Asset
                            id={sign.id}
                            path={`/admin/content/${sign.id}/media`}
                            alt={sign.name}
                          />
                        ) : (
                          <span className="text-muted">Thiếu ảnh</span>
                        )}
                      </Td>
                      <Td>
                        <strong>{sign.code}</strong>
                        <p>{sign.name}</p>
                      </Td>
                      <Td>{sign.group}</Td>
                      <Td>
                        {sign.meaning}
                        <p className="mt-1 text-xs text-muted">{sign.source}</p>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!signs.length && (
                <p className="p-5 text-sm text-muted">
                  Chưa nhập biển báo. Có thể bắt đầu bằng danh mục chưa có ảnh.
                </p>
              )}
            </div>
          </Card>
        </section>
      )}
      {kind === "units" && (
        <Link className="mt-5 inline-block underline text-sm" to="/admin/units">
          Kiểm duyệt và quản lý đơn vị pháp lý
        </Link>
      )}
      <Modal
        open={replacementReview.length > 0}
        title="So sánh ảnh trước khi ghép"
        onClose={() => {
          if (!busy) setReplacementReview([]);
        }}
        footer={
          <>
            <Button disabled={busy} onClick={() => setReplacementReview([])}>
              Quay lại
            </Button>
            <Button
              variant="primary"
              disabled={busy}
              onClick={() =>
                void uploadImages(
                  Object.fromEntries(
                    replacementReview
                      .filter((item) => replaceSelected.has(item.record.id))
                      .map((item) => [item.record.id, item.record.version]),
                  ),
                )
              }
            >
              Ghép theo lựa chọn
            </Button>
          </>
        }
      >
        <Notice error={error} />
        <p className="mb-4 text-sm text-muted">
          Mặc định giữ ảnh cũ. Chọn từng ảnh muốn thay; những câu chưa có ảnh
          vẫn được ghép ảnh mới.
        </p>
        <p role="status" className="mb-4 text-sm">
          Thay {replaceSelected.size} ảnh · Giữ{" "}
          {replacementReview.length - replaceSelected.size} ảnh cũ
        </p>
        <fieldset disabled={busy} className="space-y-5">
          {replacementReview.map(({ record, code }) => (
            <section
              key={record.id}
              className="space-y-3 border-b border-line pb-4"
            >
              <p className="text-sm font-medium">
                {code} · {String(record.data.text || record.data.name || "")}
              </p>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <p className="mb-2 text-xs text-muted">Ảnh cũ</p>
                  <Asset
                    id={record.id}
                    path={`/admin/content/${record.id}/media`}
                    alt={`Ảnh cũ ${code}`}
                    className="h-44 w-full rounded-lg border border-line bg-white object-contain"
                  />
                </div>
                <div>
                  <p className="mb-2 text-xs text-muted">Ảnh mới từ ZIP</p>
                  <img
                    src={images[code]}
                    alt={`Ảnh mới ${code}`}
                    className="h-44 w-full rounded-lg border border-line bg-white object-contain"
                  />
                </div>
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={replaceSelected.has(record.id)}
                  onChange={(event) => {
                    const selected = event.target.checked;
                    setReplaceSelected((previous) => {
                      const next = new Set(previous);
                      if (selected) next.add(record.id);
                      else next.delete(record.id);
                      return next;
                    });
                  }}
                />
                Thay ảnh cũ bằng ảnh mới cho {code}
              </label>
            </section>
          ))}
        </fieldset>
      </Modal>
      <Modal
        open={!!imagePreview && !!images[imagePreview]}
        title={`${showQuestionPreview ? "Xem trước câu hỏi" : "Ảnh câu hỏi"} ${imagePreview || ""}`}
        onClose={() => setImagePreview(undefined)}
        footer={
          <>
            <Button onClick={() => setImagePreview(undefined)}>Đóng</Button>
            <Button
              disabled={data.loading || !!data.error || !previewQuestion}
              onClick={() => setShowQuestionPreview((value) => !value)}
            >
              {showQuestionPreview ? "Chỉ xem ảnh" : "Xem trước câu hỏi"}
            </Button>
          </>
        }
      >
        <Notice loading={data.loading} error={data.error} retry={data.reload} />
        {!data.loading && !data.error && !previewQuestion && (
          <p className="mb-3 text-sm text-muted">
            {previewMatches.length > 1
              ? "Có nhiều câu trùng mã trong bộ đã chọn; cần kiểm tra lại trước khi ghép."
              : "Chưa có câu hỏi khớp mã ảnh trong bộ đã chọn. Nhập câu hỏi trước để xem trước."}
          </p>
        )}
        {showQuestionPreview && previewQuestion && (
          <p className="mb-4 whitespace-pre-wrap font-medium">
            {String(previewQuestion.text || "")}
          </p>
        )}
        {imagePreview && images[imagePreview] && (
          <img
            src={images[imagePreview]}
            alt={`Ảnh câu hỏi ${imagePreview}`}
            className="max-h-[65dvh] w-full object-contain"
          />
        )}
        {showQuestionPreview && previewQuestion && (
          <div className="mt-4 space-y-3">
            <p className="text-xs text-muted">
              Xem thử với ảnh trong ZIP; ảnh này chưa được lưu vào câu hỏi.
            </p>
            <ol className="space-y-2">
              {previewOptions.map((option, index) => (
                <li
                  key={index}
                  className="rounded-xl border border-line bg-white p-3 text-sm"
                >
                  {index + 1}. {option}
                </li>
              ))}
            </ol>
            <details className="text-sm">
              <summary className="cursor-pointer font-medium">
                Xem đáp án và giải thích
              </summary>
              <div className="mt-2 space-y-2">
                <p>
                  {typeof previewQuestion.correctAnswer === "number" &&
                  Number.isInteger(previewQuestion.correctAnswer) &&
                  previewOptions[previewQuestion.correctAnswer]
                    ? `Đáp án đúng: ${previewQuestion.correctAnswer + 1}. ${previewOptions[previewQuestion.correctAnswer]}`
                    : "Chưa xác định đáp án đúng."}
                </p>
                {!!previewQuestion.explanation && (
                  <p className="whitespace-pre-wrap">
                    {String(previewQuestion.explanation)}
                  </p>
                )}
              </div>
            </details>
          </div>
        )}
      </Modal>
    </Page>
  );
}
