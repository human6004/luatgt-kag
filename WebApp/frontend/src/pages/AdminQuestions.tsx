import { api, send, type ContentRecord } from "../api";
import { Asset, Notice, useData, useTask } from "./server/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useAdmin, type QBankItem } from "../admin/store";
import {
  Badge,
  Button,
  Card,
  EditIconButton,
  Field,
  FilterTabs,
  Modal,
  NavLinkButton,
  Page,
  RequiredMark,
  Td,
  Th,
  Toggle,
  inputCls,
} from "../admin/ui";
import { type QuestionSet } from "./server/QuestionBankSettings";
import { publicationBatchBody } from "./server/question-publication";

const blank = (): QBankItem => ({
  id: "",
  chapter: "1",
  question: "",
  options: ["", "", ""],
  answer: 0,
  critical: false,
  explanation: "",
  source: "",
});
const iconButtonClass =
  "inline-flex h-9 w-9 items-center justify-center rounded-lg text-muted hover:bg-selected hover:text-navy disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-accent-strong";
type QuestionHistory = {
  version: number;
  changedAt: string;
  published: boolean;
  data: Record<string, unknown>;
};

export default function AdminQuestions() {
  const { notify } = useAdmin(),
    task = useTask(),
    data = useData<ContentRecord[]>("/admin/questions");
  const chapterLabels = new Map(
    (data.value || []).map((r) => [
      r.id,
      String(r.data.chapterName || `Chương ${r.data.chapter}`),
    ]),
  );
  function chapterFilterLabel(chapter: string) {
    const labels = new Set(
      (data.value || [])
        .filter((r) => String(r.data.chapter) === chapter)
        .map((r) => chapterLabels.get(r.id)),
    );
    return labels.size === 1 ? [...labels][0] : `Chương ${chapter}`;
  }
  const [searchParams, setSearchParams] = useSearchParams();
  const publication =
    searchParams.get("status") === "draft"
      ? "draft"
      : searchParams.get("status") === "published"
        ? "published"
        : "all";
  const qbank: QBankItem[] = (data.value || []).map((r) => ({
    id: r.id,
    chapter: String(r.data.chapter),
    question: String(r.data.text || ""),
    options: r.data.options as string[],
    answer: r.data.correctAnswer == null ? -1 : Number(r.data.correctAnswer),
    critical: r.data.critical === true,
    explanation: String(r.data.explanation || ""),
    source: String(r.data.source || ""),
  }));
  const sets = useData<QuestionSet[]>("/admin/questions/sets");
  const [questionSetId, setQuestionSetId] = useState("");
  const [externalId, setExternalId] = useState(""),
    [reviewed, setReviewed] = useState(false),
    [imageRequired, setImageRequired] = useState(false);
  const [history, setHistory] = useState<QuestionHistory[]>(),
    [checked, setChecked] = useState<Set<string>>(new Set());
  const imageInputRef = useRef<HTMLInputElement>(null);
  const [imageMessage, setImageMessage] = useState("");
  function edit(x: QBankItem) {
    task.clearError();
    const r = data.value?.find((r) => r.id === x.id);
    setQuestionSetId(String(r?.data.questionSetId || ""));
    setExternalId(String(r?.data.sourceExternalId || r?.externalId || ""));
    setReviewed(r?.data.reviewed === true);
    setImageRequired(r?.data.imageRequired === true);
    setHistory(undefined);
    setEditing({ ...x, options: [...x.options] });
  }

  const [q, setQ] = useState("");
  const [chapter, setChapter] = useState("all");
  const [onlyCritical, setOnlyCritical] = useState(false);
  const [reviewTooltipId, setReviewTooltipId] = useState<string | null>(null);
  const [editing, setEditing] = useState<QBankItem | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{
    id: string;
    text: string;
    version?: number;
  } | null>(null);
  const [deleteConfirmed, setDeleteConfirmed] = useState(false);
  const [deleteMessage, setDeleteMessage] = useState("");
  useEffect(() => {
    setDeleteConfirmed(false);
  }, [pendingDelete?.id]);
  const preview = qbank.find((row) => row.id === previewId);
  const previewRecord = data.value?.find((row) => row.id === previewId);
  const previewAnswer = previewRecord
    ? previewRecord.data.correctAnswer
    : preview?.answer;
  const [publishingCount, setPublishingCount] = useState(0);
  const [publicationMessage, setPublicationMessage] = useState("");
  const record = data.value?.find((r) => r.id === editing?.id);
  useEffect(() => {
    setImageMessage("");
  }, [editing?.id]);

  const publicationById = useMemo(
    () =>
      new Map<string, boolean>(
        (data.value || []).map((row): [string, boolean] => [
          row.id,
          row.published,
        ]),
      ),
    [data.value],
  );
  const sourceCodeById = useMemo(
    () =>
      new Map(
        (data.value || []).map((row): [string, string] => [
          row.id,
          String(row.data.sourceExternalId || row.externalId),
        ]),
      ),
    [data.value],
  );
  const checksById = useMemo(
    () =>
      new Map(
        (data.value || []).map((row) => {
          const value = row.data,
            issues: string[] = [];
          const options = Array.isArray(value.options) ? value.options : [];
          if (
            typeof value.correctAnswer !== "number" ||
            !Number.isInteger(value.correctAnswer) ||
            value.correctAnswer < 0 ||
            value.correctAnswer >= options.length
          )
            issues.push("Thiếu đáp án");
          if (typeof value.critical !== "boolean")
            issues.push("Chưa phân loại điểm liệt");
          if (typeof value.source !== "string" || !value.source.trim())
            issues.push("Thiếu nguồn");
          if (value.imageRequired === true && !value.imageKey)
            issues.push("Thiếu ảnh bắt buộc");
          return [
            row.id,
            { issues, reviewed: value.reviewed === true },
          ] as const;
        }),
      ),
    [data.value],
  );
  const shown = useMemo(
    () =>
      qbank.filter(
        (x) =>
          (publication === "all" ||
            publicationById.get(x.id) === (publication === "published")) &&
          (chapter === "all" || x.chapter === chapter) &&
          (!onlyCritical || x.critical) &&
          `${sourceCodeById.get(x.id) || ""} ${x.question}`
            .toLowerCase()
            .includes(q.trim().toLowerCase()),
      ),
    [
      qbank,
      publication,
      publicationById,
      sourceCodeById,
      chapter,
      onlyCritical,
      q,
    ],
  );
  const selectableIds = shown
    .filter((row) => publicationById.has(row.id))
    .map((row) => row.id);
  const allSelected =
    selectableIds.length > 0 && selectableIds.every((id) => checked.has(id));
  const someSelected = selectableIds.some((id) => checked.has(id));
  useEffect(() => {
    setChecked(new Set());
    setReviewTooltipId(null);
  }, [q, chapter, onlyCritical, publication]);

  function save() {
    if (!editing || task.busy || data.loading || !editing.question.trim())
      return;
    if (!record && !questionSetId) {
      notify("Chọn bộ câu hỏi trước khi thêm câu mới");
      return;
    }
    void task.run(async () => {
      const payload = {
        ...record?.data,
        ...(questionSetId ? { questionSetId } : {}),
        externalId: record?.externalId || externalId,
        text: editing.question,
        chapter: Number(editing.chapter),
        options: editing.options,
        correctAnswer: editing.answer < 0 ? null : editing.answer,
        critical: editing.critical,
        source: editing.source,
        explanation: editing.explanation,
        reviewed,
        imageRequired,
      };
      if (record)
        await api(
          `/admin/content/${record.id}`,
          send("PUT", { version: record.version, data: payload }),
        );
      else
        await api(
          "/admin/imports/questions/confirm",
          send("POST", {
            rows: [payload],
            updateExisting: false,
            questionSetId,
          }),
        );
      data.reload();
      setEditing(null);
      notify("Đã lưu bản nháp; chưa xuất bản");
    });
  }
  function publish(id: string, published: boolean) {
    const r = data.value?.find((r) => r.id === id);
    if (!r) return;
    void task.run(async () => {
      await api(
        `/admin/content/${id}/publication`,
        send("POST", { version: r.version, published }),
      );
      data.reload();
      notify("Đã cập nhật xuất bản");
    });
  }
  function deleteQuestion() {
    if (
      !pendingDelete ||
      !deleteConfirmed ||
      task.busy
    ) return;
    if (pendingDelete.version === undefined) {
      setDeleteMessage("Không thể xóa vì bản ghi thiếu phiên bản cập nhật.");
      return;
    }
    const target = pendingDelete;
    setDeleteMessage("");
    void task.run(async () => {
      await api(
        `/admin/questions/${target.id}?version=${target.version}`,
        send("DELETE"),
      );
      setChecked((previous) => {
        const next = new Set(previous);
        next.delete(target.id);
        return next;
      });
      setPendingDelete(null);
      data.reload();
      const message = `Đã xóa vĩnh viễn câu hỏi ${sourceCodeById.get(target.id) || ""} khỏi ngân hàng.`;
      setDeleteMessage(message);
      notify(message);
    });
  }
  function publishSelected() {
    if (task.busy) return;
    const selected = (data.value || []).filter((row) => checked.has(row.id));
    if (!selected.length) return;
    setPublicationMessage("");
    setPublishingCount(selected.length);
    void task.run(async () => {
      try {
        await api(
          "/admin/questions/publication-batch",
          send("POST", publicationBatchBody(selected)),
        );
        const message = `Đã duyệt và xuất bản thành công ${selected.length} câu hỏi.`;
        setPublicationMessage(message);
        notify(message);
        setChecked(new Set());
        data.reload();
      } finally {
        setPublishingCount(0);
      }
    });
  }

  function exportJson() {
    const blob = new Blob(
      [
        JSON.stringify(
          (data.value || []).map((r) => ({
            ...r.data,
            id: r.externalId,
            externalId: r.externalId,
          })),
          null,
          2,
        ),
      ],
      { type: "application/json" },
    );
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "ngan-hang-cau-hoi.json";
    a.click();
    URL.revokeObjectURL(a.href);
    notify("Đã xuất các câu hỏi server");
  }

  return (
    <Page
      title="Ngân hàng câu hỏi"
      actions={
        <>
          <NavLinkButton to="/admin/imports?type=questions">
            Nhập hàng loạt
          </NavLinkButton>
          <Button variant="primary" onClick={exportJson}>
            Xuất JSON
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              sets.reload();
              edit(blank());
              setExternalId("");
            }}
          >
            + Câu hỏi
          </Button>
        </>
      }
    >
      <Notice {...data} retry={data.reload} />
      <Notice error={task.error} />
      <div className="mb-4 space-y-3">
        <input
          aria-label="Tìm theo mã hoặc nội dung câu hỏi"
          className={`${inputCls} w-full`}
          placeholder="Tìm theo mã (Q345, 345) hoặc nội dung câu hỏi…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <FilterTabs
          label="Lọc trạng thái xuất bản"
          value={publication}
          onChange={(value) => {
            const next = new URLSearchParams(searchParams);
            if (value === "all") next.delete("status");
            else next.set("status", value);
            setSearchParams(next);
          }}
          items={[
            { value: "all", label: "Tất cả" },
            { value: "draft", label: "Bản nháp" },
            { value: "published", label: "Đã xuất bản" },
          ]}
        />
        <div className="flex flex-wrap items-center gap-3">
          <select
            className={`${inputCls} w-full max-w-[220px]`}
            value={chapter}
            onChange={(e) => setChapter(e.target.value)}
            aria-label="Chương"
          >
            <option value="all">Tất cả chương</option>
            {[...new Set(qbank.map((q) => q.chapter))]
              .sort((a, b) => Number(a) - Number(b))
              .map((c) => (
                <option key={c} value={c}>
                  {chapterFilterLabel(c)}
                </option>
              ))}
          </select>
          <label className="flex items-center gap-2 text-[13px] text-text-secondary">
            <Toggle
              checked={onlyCritical}
              onChange={setOnlyCritical}
              label="Chỉ câu điểm liệt"
            />{" "}
            Chỉ câu điểm liệt
          </label>
        </div>
      </div>

      {deleteMessage && (
        <p
          role="status"
          className="mb-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800"
        >
          {deleteMessage}
        </p>
      )}
      <div className="mb-3 flex flex-wrap items-center gap-3 text-sm">
        <span role="status">
          Chọn {checked.size} / {selectableIds.length}
        </span>
      </div>
      <div className="space-y-3 lg:hidden">
        <label className="flex min-h-11 items-center gap-3 rounded-xl border border-line bg-surface px-4 py-3 text-sm font-medium text-navy">
          <input
            type="checkbox"
            aria-label="Chọn tất cả câu hỏi trong kết quả đang lọc"
            checked={allSelected}
            disabled={task.busy || !selectableIds.length}
            ref={(node) => {
              if (node) node.indeterminate = someSelected && !allSelected;
            }}
            onChange={(event) =>
              setChecked(
                event.target.checked ? new Set(selectableIds) : new Set(),
              )
            }
          />
          Chọn tất cả câu hỏi phù hợp
        </label>
        {shown.map((x) => {
          const check = checksById.get(x.id);
          const mobileTooltipId = `mobile:${x.id}`;
          const record = data.value?.find((row) => row.id === x.id);
          return (
            <article
              key={x.id}
              className={`rounded-2xl border border-line bg-surface p-4 ${check?.issues.length ? "bg-gray-100" : ""}`}
            >
              <div className="flex items-start gap-3">
                {record && (
                  <input
                    type="checkbox"
                    aria-label={`Chọn câu ${sourceCodeById.get(x.id) || x.question}`}
                    disabled={task.busy}
                    checked={checked.has(x.id)}
                    onChange={() =>
                      setChecked((previous) => {
                        const next = new Set(previous);
                        next.has(x.id) ? next.delete(x.id) : next.add(x.id);
                        return next;
                      })
                    }
                  />
                )}
                <div className="min-w-0 flex-1">
                  <div className="mb-1 flex flex-wrap items-center gap-2">
                    {sourceCodeById.has(x.id) && (
                      <span className="font-mono text-xs text-muted">
                        {sourceCodeById.get(x.id)}
                      </span>
                    )}
                    {x.critical && <Badge tone="red">Điểm liệt</Badge>}
                  </div>
                  <p className="break-words font-medium leading-6 text-navy">
                    {x.question}
                  </p>
                </div>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-3 border-t border-line pt-3 text-sm">
                <p className="min-w-0 break-words">
                  <span className="mb-1 block text-xs text-muted">Chương</span>
                  {chapterLabels.get(x.id) || `Chương ${x.chapter}`}
                </p>
                <p className="min-w-0 break-words">
                  <span className="mb-1 block text-xs text-muted">Nguồn</span>
                  {x.source || "—"}
                </p>
                <div className="col-span-2">
                  <span className="mb-1 block text-xs text-muted">
                    Kiểm tra
                  </span>
                  {check ? (
                    check.issues.length ? (
                      <div className="text-sm text-red-700">
                        <p className="font-medium">✕ Cần xem lại</p>
                        <ul className="mt-1 list-inside list-disc text-xs text-muted">
                          {check.issues.map((issue) => (
                            <li key={issue}>{issue}</li>
                          ))}
                        </ul>
                      </div>
                    ) : (
                      <span className="relative inline-flex">
                        <button
                          type="button"
                          className="font-medium text-emerald-700 focus-visible:outline-2 focus-visible:outline-accent-strong"
                          aria-expanded={reviewTooltipId === mobileTooltipId}
                          aria-describedby={
                            reviewTooltipId === mobileTooltipId
                              ? `review-tooltip-${mobileTooltipId}`
                              : undefined
                          }
                          onClick={() =>
                            setReviewTooltipId((previous) =>
                              previous === mobileTooltipId
                                ? null
                                : mobileTooltipId,
                            )
                          }
                          onBlur={() => setReviewTooltipId(null)}
                          onKeyDown={(event) => {
                            if (event.key === "Escape")
                              setReviewTooltipId(null);
                          }}
                        >
                          ✓ Đủ dữ liệu
                        </button>
                        {reviewTooltipId === mobileTooltipId && (
                          <span
                            id={`review-tooltip-${mobileTooltipId}`}
                            role="tooltip"
                            className="absolute bottom-full left-0 z-20 mb-2 w-52 rounded-lg bg-navy px-3 py-2 text-xs font-normal text-white shadow-lg"
                          >
                            {check.reviewed
                              ? "Đã kiểm duyệt"
                              : "Chờ xác nhận kiểm duyệt"}
                          </span>
                        )}
                      </span>
                    )
                  ) : (
                    <span className="text-xs text-muted">—</span>
                  )}
                </div>
              </div>
              <div className="mt-3 flex flex-wrap items-center justify-end gap-1 border-t border-line pt-3">
                <button
                  type="button"
                  className={iconButtonClass}
                  title="Xem trước câu hỏi"
                  aria-label="Xem trước câu hỏi"
                  onClick={() => setPreviewId(x.id)}
                >
                  <svg
                    aria-hidden="true"
                    className="h-5 w-5"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                  >
                    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                </button>
                <EditIconButton
                  label="Sửa câu hỏi"
                  disabled={task.busy}
                  onClick={() => edit(x)}
                />
                <button
                  type="button"
                  className={`${iconButtonClass} text-red-700 hover:text-red-700 hover:bg-red-50`}
                  disabled={task.busy || publicationById.get(x.id) === true}
                  title={
                    publicationById.get(x.id)
                      ? "Hủy xuất bản trước khi xóa"
                      : "Xóa câu hỏi"
                  }
                  aria-label="Xóa câu hỏi"
                  onClick={() => {
                    setPendingDelete({
                      id: x.id,
                      text: x.question,
                      version: record?.version,
                    });
                    task.clearError();
                  }}
                >
                  <svg
                    aria-hidden="true"
                    className="h-5 w-5"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" />
                  </svg>
                </button>
                {record && (
                  <Button
                    size="sm"
                    disabled={task.busy}
                    onClick={() => publish(x.id, !record.published)}
                  >
                    {record.published ? "Hủy xuất bản" : "Xuất bản"}
                  </Button>
                )}
              </div>
            </article>
          );
        })}
        {!shown.length && (
          <p className="rounded-xl border border-line bg-surface p-6 text-center text-sm text-muted">
            Không có câu hỏi phù hợp.
          </p>
        )}
      </div>
      <Card className="hidden overflow-x-auto lg:block">
        <table className="question-bank-table">
          <thead className="border-b border-line">
            <tr>
              <Th className="question-select">
                <input
                  type="checkbox"
                  aria-label="Chọn tất cả câu hỏi trong kết quả đang lọc"
                  title="Chọn tất cả câu hỏi trong kết quả đang lọc"
                  checked={allSelected}
                  disabled={task.busy || !selectableIds.length}
                  ref={(node) => {
                    if (node) node.indeterminate = someSelected && !allSelected;
                  }}
                  onChange={(event) =>
                    setChecked(
                      event.target.checked ? new Set(selectableIds) : new Set(),
                    )
                  }
                />
              </Th>
              <Th>Câu hỏi</Th>
              <Th className="question-chapter">Chương</Th>
              <Th className="question-source">Nguồn</Th>
              <Th className="question-check text-right">Kiểm tra</Th>
              <Th className="question-actions text-right">Thao tác</Th>
            </tr>
          </thead>
          <tbody>
            {shown.map((x) => (
              <tr
                key={x.id}
                className={`border-b border-line/60 last:border-0 ${checksById.get(x.id)?.issues.length ? "bg-gray-100 hover:bg-gray-200/60" : "hover:bg-bg"}`}
              >
                <Td className="question-select">
                  {data.value?.some((r) => r.id === x.id) && (
                    <input
                      type="checkbox"
                      id={`question-select-${x.id}`}
                      aria-label={`Chọn câu ${sourceCodeById.get(x.id) || x.question}`}
                      disabled={task.busy}
                      checked={checked.has(x.id)}
                      onChange={() =>
                        setChecked((p) => {
                          const n = new Set(p);
                          n.has(x.id) ? n.delete(x.id) : n.add(x.id);
                          return n;
                        })
                      }
                    />
                  )}
                </Td>
                <Td className="text-navy">
                  <label
                    htmlFor={`question-select-${x.id}`}
                    className="flex items-baseline gap-3 cursor-pointer"
                  >
                    {sourceCodeById.has(x.id) && (
                      <span className="shrink-0 font-mono text-xs text-muted">
                        {sourceCodeById.get(x.id)}
                      </span>
                    )}
                    <span className="min-w-0">
                      {x.question}
                    </span>
                  </label>
                  {x.critical && (
                    <span className="ml-2">
                      <Badge tone="red">Điểm liệt</Badge>
                    </span>
                  )}
                </Td>
                <Td className="question-chapter text-muted">
                  <div>{chapterLabels.get(x.id) || `Chương ${x.chapter}`}</div>
                </Td>
                <Td className="question-source text-muted">
                  <div>{x.source}</div>
                </Td>
                <Td className="question-check text-right text-xs">
                  {checksById.get(x.id) ? (
                    checksById.get(x.id)!.issues.length ? (
                      <>
                        <span className="font-medium text-red-700">✕</span>
                        <ul className="mt-1 max-w-36 whitespace-normal space-y-1 text-xs text-muted">
                          {checksById.get(x.id)!.issues.map((issue) => (
                            <li key={issue}>{issue}</li>
                          ))}
                        </ul>
                      </>
                    ) : (
                      <span className="relative inline-flex">
                        <button
                          type="button"
                          className="rounded text-left font-medium text-emerald-700 cursor-pointer focus-visible:outline-2 focus-visible:outline-accent-strong"
                          aria-expanded={reviewTooltipId === x.id}
                          aria-describedby={
                            reviewTooltipId === x.id
                              ? `review-tooltip-${x.id}`
                              : undefined
                          }
                          onClick={() =>
                            setReviewTooltipId((previous) =>
                              previous === x.id ? null : x.id,
                            )
                          }
                          onBlur={() => setReviewTooltipId(null)}
                          onKeyDown={(event) => {
                            if (event.key === "Escape")
                              setReviewTooltipId(null);
                          }}
                        >
                          ✓
                        </button>
                        {reviewTooltipId === x.id && (
                          <span
                            id={`review-tooltip-${x.id}`}
                            role="tooltip"
                            className="absolute bottom-full left-0 z-20 mb-2 w-52 rounded-lg bg-navy px-3 py-2 text-xs font-normal text-white shadow-lg"
                          >
                            {checksById.get(x.id)!.reviewed
                              ? "Đã kiểm duyệt"
                              : "Chờ xác nhận kiểm duyệt"}
                          </span>
                        )}
                      </span>
                    )
                  ) : (
                    <span className="text-muted">—</span>
                  )}
                </Td>
                <Td className="question-actions text-right">
                  <div className="inline-flex flex-nowrap items-center justify-end gap-0.5 [&>button]:shrink-0 [&>button]:whitespace-nowrap">
                    <button
                      type="button"
                      className={iconButtonClass}
                      title="Xem trước câu hỏi"
                      aria-label="Xem trước câu hỏi"
                      onClick={() => setPreviewId(x.id)}
                    >
                      <svg
                        aria-hidden="true"
                        className="h-5 w-5"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.8"
                      >
                        <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
                        <circle cx="12" cy="12" r="3" />
                      </svg>
                    </button>
                    <EditIconButton
                      label="Sửa câu hỏi"
                      disabled={task.busy}
                      onClick={() => edit(x)}
                    />
                    <button
                      type="button"
                      className={`${iconButtonClass} text-red-700 hover:text-red-700 hover:bg-red-50`}
                      disabled={task.busy || publicationById.get(x.id) === true}
                      title={
                        publicationById.get(x.id)
                          ? "Hủy xuất bản trước khi xóa"
                          : "Xóa câu hỏi"
                      }
                      aria-label="Xóa câu hỏi"
                      onClick={() => {
                        task.clearError();
                        setPendingDelete({
                          id: x.id,
                          text: x.question,
                          version: data.value?.find((row) => row.id === x.id)
                            ?.version,
                        });
                      }}
                    >
                      <svg
                        aria-hidden="true"
                        className="h-5 w-5"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" />
                      </svg>
                    </button>
                    {data.value?.some((r) => r.id === x.id) && (
                      <Button
                        size="sm"
                        disabled={task.busy}
                        onClick={() =>
                          publish(
                            x.id,
                            !data.value?.find((r) => r.id === x.id)?.published,
                          )
                        }
                      >
                        {data.value?.find((r) => r.id === x.id)?.published
                          ? "Hủy xuất bản"
                          : "Xuất bản"}
                      </Button>
                    )}
                  </div>
                </Td>
              </tr>
            ))}
            {!shown.length && (
              <tr>
                <td
                  colSpan={6}
                  className="px-4 py-8 text-center text-sm text-muted"
                >
                  Không có câu hỏi phù hợp.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>

      <div className="mt-4 space-y-3" aria-busy={publishingCount > 0}>
        <Button disabled={task.busy || !checked.size} onClick={publishSelected}>
          {publishingCount > 0
            ? `Đang duyệt và xuất bản ${publishingCount} câu…`
            : `Duyệt và xuất bản các câu đã chọn${checked.size ? ` (${checked.size})` : ""}`}
        </Button>
        {publishingCount > 0 && (
          <p role="status" className="text-sm text-muted">
            Đang xử lý. Vui lòng chờ kết quả.
          </p>
        )}
        {publicationMessage && (
          <p role="status" className="text-sm text-emerald-700">
            {publicationMessage}
          </p>
        )}
        {!editing && <Notice error={task.error} />}
      </div>
      <Modal
        open={!!pendingDelete}
        title="Xác nhận xóa câu hỏi"
        onClose={() => {
          if (!task.busy) setPendingDelete(null);
        }}
        footer={
          <>
            <Button disabled={task.busy} onClick={() => setPendingDelete(null)}>
              Hủy
            </Button>
            <Button
              variant="danger"
              disabled={task.busy || !deleteConfirmed}
              onClick={deleteQuestion}
            >
              {task.busy ? "Đang xóa…" : "Xóa vĩnh viễn"}
            </Button>
          </>
        }
      >
        <Notice error={task.error} />
        <p className="mb-3 font-medium">{pendingDelete?.text}</p>
        <p className="text-sm text-muted">
          Câu hỏi và lịch sử chỉnh sửa của câu sẽ bị xóa vĩnh viễn. Câu đã có
          lịch sử luyện tập hoặc thi sẽ không được phép xóa.
        </p>
        <div className="mt-4 flex items-start gap-3 rounded-xl border border-line p-3">
          <Toggle
            checked={deleteConfirmed}
            onChange={setDeleteConfirmed}
            disabled={task.busy}
            label="Tôi xác nhận xóa vĩnh viễn câu hỏi này"
          />
          <span className="text-sm font-medium">
            Tôi xác nhận xóa vĩnh viễn câu hỏi này. Thao tác không thể hoàn tác.
          </span>
        </div>
        {task.busy && (
          <p role="status" className="mt-3 text-sm text-muted">
            Đang xóa câu hỏi, vui lòng chờ kết quả.
          </p>
        )}
      </Modal>
      <Modal
        open={!!preview}
        title="Xem trước câu hỏi"
        onClose={() => setPreviewId(null)}
        footer={<Button onClick={() => setPreviewId(null)}>Đóng</Button>}
      >
        {preview && (
          <div key={preview.id} className="space-y-4">
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
              <span>
                {chapterLabels.get(preview.id) || `Chương ${preview.chapter}`}
              </span>
              {preview.critical && <Badge tone="red">Điểm liệt</Badge>}
              {previewRecord && (
                <span>
                  {previewRecord.published ? "Đã xuất bản" : "Bản nháp"}
                </span>
              )}
            </div>
            <p className="whitespace-pre-wrap font-medium text-navy">
              {preview.question}
            </p>
            {previewRecord?.data.imageKey ? (
              <Asset
                id={preview.id}
                path={`/admin/content/${preview.id}/media`}
                alt="Ảnh đã ghép vào câu hỏi"
                className="max-h-96 w-full object-contain"
              />
            ) : (
              <p className="text-xs text-muted">Câu này chưa có ảnh đã ghép.</p>
            )}
            <fieldset className="space-y-2">
              <legend className="mb-2 text-sm text-muted">
                Chọn một đáp án để xem giao diện
              </legend>
              {preview.options.map((option, index) => (
                <label
                  key={index}
                  className="flex cursor-pointer items-start gap-3 rounded-xl border border-line bg-white px-3 py-3 text-sm has-checked:border-accent has-checked:bg-selected"
                >
                  <input
                    type="radio"
                    name="question-preview-answer"
                    value={index}
                    className="mt-1 shrink-0 accent-[var(--color-accent-strong)]"
                  />
                  <span>
                    {index + 1}. {option}
                  </span>
                </label>
              ))}
            </fieldset>
            <details className="border-t border-line pt-3 text-sm">
              <summary className="cursor-pointer font-medium">
                Xem đáp án và giải thích
              </summary>
              <div className="mt-3 space-y-2">
                <p>
                  {typeof previewAnswer === "number" &&
                  Number.isInteger(previewAnswer) &&
                  preview.options[previewAnswer]
                    ? `Đáp án đúng: ${previewAnswer + 1}. ${preview.options[previewAnswer]}`
                    : "Chưa xác định đáp án đúng."}
                </p>
                {preview.explanation && (
                  <p className="whitespace-pre-wrap">{preview.explanation}</p>
                )}
                {preview.source && (
                  <p className="text-xs text-muted">Nguồn: {preview.source}</p>
                )}
              </div>
            </details>
          </div>
        )}
      </Modal>
      <Modal
        open={!!editing}
        size="lg"
        title={editing?.id ? "Sửa câu hỏi" : "Thêm câu hỏi"}
        onClose={() => setEditing(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditing(null)}>
              Huỷ
            </Button>
            <Button
              variant="primary"
              onClick={save}
              disabled={task.busy || data.loading || !editing?.question.trim()}
            >
              Lưu
            </Button>
          </>
        }
      >
        <Notice error={task.error} loading={task.busy} />
        {editing && (
          <div className="space-y-4">
            <Field label="Bộ câu hỏi" required={!record}>
                <select
                  required={!record}
                  className={inputCls}
                  aria-label="Bộ câu hỏi"
                  value={questionSetId}
                  onChange={(e) => setQuestionSetId(e.target.value)}
                >
                  <option value="">Ngân hàng hiện có</option>
                  {sets.value?.map((s) => (
                    <option key={s.set_id} value={s.set_id}>
                      {s.set_name}
                    </option>
                  ))}
                </select>
            </Field>
            <Field label="Mã định danh nguồn" required={!record}>
                <input
                  required={!record}
                  className={inputCls}
                  readOnly={!!record?.data.sourceExternalId}
                  value={externalId}
                  onChange={(e) => setExternalId(e.target.value)}
                />
            </Field>
            <Field label="Nội dung câu hỏi" required>
              <textarea
                required
                rows={2}
                className={inputCls}
                value={editing.question}
                onChange={(e) =>
                  setEditing({ ...editing, question: e.target.value })
                }
              />
            </Field>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Chương" required>
                <input
                  type="number"
                  min="1"
                  max="32767"
                  step="1"
                  required
                  className={inputCls}
                  value={editing.chapter}
                  onChange={(e) =>
                    setEditing({ ...editing, chapter: e.target.value })
                  }
                />
              </Field>
              <Field label="Căn cứ">
                <input
                  className={inputCls}
                  value={editing.source}
                  onChange={(e) =>
                    setEditing({ ...editing, source: e.target.value })
                  }
                  placeholder="NĐ 168/2024…"
                />
              </Field>
            </div>
            <div>
              <span className="block text-xs font-medium text-text-secondary mb-1.5">
                Phương án (ít nhất 2, chọn đáp án đúng)<RequiredMark />
              </span>
              <div className="space-y-2">
                {editing.options.map((o, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="ans"
                      checked={editing.answer === i}
                      onChange={() => setEditing({ ...editing, answer: i })}
                      className="accent-[var(--color-accent-strong)]"
                      aria-label={`Đáp án ${i + 1}`}
                    />
                    <input
                      className={inputCls}
                      required
                      value={o}
                      placeholder={`Phương án ${i + 1}`}
                      onChange={(e) =>
                        setEditing({
                          ...editing,
                          options: editing.options.map((v, k) =>
                            k === i ? e.target.value : v,
                          ),
                        })
                      }
                    />
                    {editing.options.length > 2 && (
                      <button
                        className="text-muted hover:text-red-600 px-1"
                        aria-label="Xoá phương án"
                        onClick={() =>
                          setEditing({
                            ...editing,
                            options: editing.options.filter((_, k) => k !== i),
                            answer: 0,
                          })
                        }
                      >
                        ✕
                      </button>
                    )}
                  </div>
                ))}
              </div>
              {editing.options.length < 4 && (
                <button
                  className="mt-2 text-xs font-medium text-accent-strong"
                  onClick={() =>
                    setEditing({
                      ...editing,
                      options: [...editing.options, ""],
                    })
                  }
                >
                  + Thêm phương án
                </button>
              )}
            </div>
            <>
                <label className="block text-sm">
                  <input
                    type="checkbox"
                    checked={reviewed}
                    onChange={(e) => setReviewed(e.target.checked)}
                  />{" "}
                  Đã kiểm duyệt đáp án và nguồn
                </label>
                <label className="block text-sm">
                  <input
                    type="checkbox"
                    checked={imageRequired}
                    onChange={(e) => setImageRequired(e.target.checked)}
                  />{" "}
                  Câu hỏi yêu cầu ảnh
                </label>
                {record ? (
                  <>
                    <p className="text-xs">
                      {record.published ? "Đã xuất bản" : "Bản nháp"} · Phiên
                      bản {record.version}
                    </p>
                    {!!record.data.imageKey && (
                      <Asset
                        key={`${record.id}-${record.version}`}
                        id={record.id}
                        path={`/admin/content/${record.id}/media`}
                        alt="Ảnh câu hỏi"
                      />
                    )}
                    <div className="space-y-2">
                      <p className="text-sm font-medium">Ảnh câu hỏi</p>
                      <input
                        ref={imageInputRef}
                        type="file"
                        className="hidden"
                        accept=".png,.jpg,.jpeg"
                        aria-label="Chọn ảnh câu hỏi"
                        disabled={task.busy}
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          e.target.value = "";
                          if (!file) return;
                          setImageMessage("");
                          void task.run(async () => {
                            const body = new FormData();
                            body.append("file", file);
                            await api(`/admin/content/${record.id}/media`, {
                              method: "POST",
                              body,
                            });
                            setReviewed(false);
                            setHistory(undefined);
                            setImageMessage(
                              `Đã lưu ảnh ${file.name}. Câu hỏi chuyển về bản nháp, cần kiểm duyệt lại.`,
                            );
                            data.reload();
                          });
                        }}
                      />
                      <Button
                        disabled={task.busy}
                        onClick={() => imageInputRef.current?.click()}
                      >
                        {record.data.imageKey
                          ? "Chọn ảnh thay thế"
                          : "Chọn ảnh"}
                      </Button>
                      <p className="text-xs text-muted">
                        PNG/JPEG, tối đa 5 MB. Ảnh được lưu ngay khi chọn tệp.
                      </p>
                      {imageMessage && (
                        <p role="status" className="text-sm text-emerald-700">
                          {imageMessage}
                        </p>
                      )}
                    </div>
                    <Button
                      disabled={task.busy}
                      onClick={() =>
                        void task.run(async () => {
                          const entries = await api<
                            (Omit<QuestionHistory, "data"> & { data: string })[]
                          >(`/admin/content/${record.id}/history`);
                          setHistory(
                            entries.map((entry) => ({
                              ...entry,
                              data: JSON.parse(entry.data) as Record<
                                string,
                                unknown
                              >,
                            })),
                          );
                        })
                      }
                    >
                      Lịch sử chỉnh sửa
                    </Button>
                    {history !== undefined && (
                      <section
                        aria-label="Lịch sử chỉnh sửa"
                        className="space-y-3"
                      >
                        {!history.length && (
                          <p className="text-sm text-muted">
                            Chưa có lịch sử chỉnh sửa.
                          </p>
                        )}
                        {history.map((entry) => {
                          const options = Array.isArray(entry.data.options)
                            ? entry.data.options.map(String)
                            : [];
                          const answer = entry.data.correctAnswer;
                          return (
                            <details
                              key={`${entry.version}-${entry.changedAt}`}
                              className="rounded-xl border border-line bg-white p-4"
                            >
                              <summary className="cursor-pointer text-sm font-medium">
                                Phiên bản {entry.version} ·{" "}
                                {new Date(entry.changedAt).toLocaleString(
                                  "vi-VN",
                                )}{" "}
                                · {entry.published ? "Đã xuất bản" : "Bản nháp"}
                              </summary>
                              <div className="mt-3 space-y-2 text-sm">
                                <p className="whitespace-pre-wrap font-medium">
                                  {String(entry.data.text || "")}
                                </p>
                                <ol className="space-y-1">
                                  {options.map((option, index) => (
                                    <li key={index}>
                                      {index + 1}. {option}
                                      {answer === index ? " · Đáp án đúng" : ""}
                                    </li>
                                  ))}
                                </ol>
                                {!(
                                  typeof answer === "number" &&
                                  Number.isInteger(answer) &&
                                  options[answer]
                                ) && (
                                  <p className="text-amber-700">
                                    Chưa xác định đáp án đúng.
                                  </p>
                                )}
                                <p>
                                  Điểm liệt:{" "}
                                  {typeof entry.data.critical === "boolean"
                                    ? entry.data.critical
                                      ? "Có"
                                      : "Không"
                                    : "Chưa phân loại"}{" "}
                                  · Kiểm duyệt:{" "}
                                  {entry.data.reviewed === true
                                    ? "Đã duyệt"
                                    : "Chưa duyệt"}{" "}
                                  · Ảnh:{" "}
                                  {entry.data.imageKey ? "Có" : "Chưa có"}
                                </p>
                                <p>
                                  Nguồn:{" "}
                                  {String(entry.data.source || "Chưa có")}
                                </p>
                                {!!entry.data.explanation && (
                                  <p className="whitespace-pre-wrap">
                                    Giải thích: {String(entry.data.explanation)}
                                  </p>
                                )}
                              </div>
                            </details>
                          );
                        })}
                      </section>
                    )}
                  </>
                ) : (
                  <p className="text-xs text-muted">
                    Lưu câu hỏi trước để tải ảnh lên.
                  </p>
                )}
            </>
            <Field label="Giải thích">
              <textarea
                rows={2}
                className={inputCls}
                value={editing.explanation}
                onChange={(e) =>
                  setEditing({ ...editing, explanation: e.target.value })
                }
              />
            </Field>
            <label className="flex items-center gap-2 text-[13px] text-navy">
              <Toggle
                checked={editing.critical}
                onChange={(v) => setEditing({ ...editing, critical: v })}
                label="Câu điểm liệt"
              />{" "}
              Câu điểm liệt
            </label>
          </div>
        )}
      </Modal>
    </Page>
  );
}
