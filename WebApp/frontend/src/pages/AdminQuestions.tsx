import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, send, type ContentRecord } from "../api";
import { useAdmin } from "../admin/store";
import {
  Badge,
  Button,
  Card,
  ContentStats,
  EditIconButton,
  Field,
  FilePicker,
  Modal,
  Page,
  SelectionBar,
  Td,
  Th,
  Toggle,
  inputCls,
} from "../admin/ui";
import { ImportPanel } from "./shared/AdminPages";
import QuestionBankSettings, {
  type QuestionBankTab,
  type QuestionSet,
} from "./shared/QuestionBankSettings";
import { Asset, Notice, useData, useTask, saveBlob } from "./shared/shared";
import { chapterNames as chapters } from "./shared/import-normalization";
import { publicationBatchBody } from "./shared/question-publication";

interface QuestionItem {
  id: string;
  externalId: string;
  published: boolean;
  chapter: string;
  question: string;
  options: string[];
  answer: number;
  critical: boolean;
  explanation: string;
  source: string;
}

const blank = (): QuestionItem => ({
  id: "",
  externalId: "",
  published: false,
  chapter: chapters[0],
  question: "",
  options: ["", "", ""],
  answer: 0,
  critical: false,
  explanation: "",
  source: "",
});

export default function AdminQuestions() {
  const [params, setParams] = useSearchParams();
  const { notify } = useAdmin();
  const task = useTask();
  const data = useData<ContentRecord[]>("/admin/questions");
  const sets = useData<QuestionSet[]>("/admin/questions/sets");

  const rawTab = params.get("tab");
  const tab: "questions" | QuestionBankTab =
    rawTab === "sets" || rawTab === "chapters" || rawTab === "rules" ? rawTab : "questions";
  const urlQ = params.get("q") ?? "";
  const [q, setQ] = useState(urlQ);
  const chapter = params.get("chapter") ?? "all";
  const onlyCritical = params.get("critical") === "1";
  const rawStatus = params.get("status");
  const statusFilter = rawStatus === "published" || rawStatus === "draft" ? rawStatus : "all";
  const showImport = params.get("import") === "1";
  const editId = params.get("id") ?? "";

  useEffect(() => {
    setQ(urlQ);
  }, [urlQ]);

  const qbank: QuestionItem[] = useMemo(
    () =>
      (data.value || []).map((r) => ({
        id: r.id,
        externalId: r.externalId,
        published: r.published,
        chapter: chapters[Number(r.data.chapter) - 1] || String(r.data.chapter || chapters[0]),
        question: String(r.data.text || ""),
        options: Array.isArray(r.data.options) ? (r.data.options as string[]) : ["", ""],
        answer: Number(r.data.correctAnswer ?? 0),
        critical: r.data.critical === true,
        explanation: String(r.data.explanation || ""),
        source: String(r.data.source || ""),
      })),
    [data.value],
  );

  const [questionSetId, setQuestionSetId] = useState("");
  const [externalId, setExternalId] = useState("");
  const [reviewed, setReviewed] = useState(false);
  const [imageRequired, setImageRequired] = useState(false);
  const [history, setHistory] = useState<unknown>();
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<QuestionItem | null>(null);

  const record = data.value?.find((r) => r.id === editing?.id);

  function updateUrl(patch: Record<string, string | null>, replace = false) {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const [k, v] of Object.entries(patch)) {
          if (v === null || v === "") next.delete(k);
          else next.set(k, v);
        }
        return next;
      },
      { replace },
    );
  }

  function switchTab(nextTab: "questions" | QuestionBankTab) {
    const next = new URLSearchParams();
    if (nextTab !== "questions") next.set("tab", nextTab);
    setParams(next);
  }

  function applyEditing(item: QuestionItem | null, rec?: ContentRecord) {
    task.clearError();
    if (!item) {
      setEditing(null);
      return;
    }
    setQuestionSetId(String(rec?.data.questionSetId || ""));
    setExternalId(String(rec?.data.sourceExternalId || rec?.externalId || item.externalId || ""));
    setReviewed(rec?.data.reviewed === true);
    setImageRequired(rec?.data.imageRequired === true);
    setHistory(undefined);
    setEditing({ ...item, options: [...item.options] });
  }

  useEffect(() => {
    if (tab !== "questions" || !editId) {
      if (editing !== null) applyEditing(null);
      return;
    }
    if (editId === "new") {
      if (!editing || editing.id !== "") applyEditing(blank());
      return;
    }
    if (!data.value) return;
    const target = qbank.find((x) => x.id === editId || x.externalId === editId);
    if (target && editing?.id !== target.id) {
      const rec = data.value.find((r) => r.id === target.id);
      applyEditing(target, rec);
    }
  }, [tab, editId, data.value, qbank]);

  const shown = useMemo(
    () =>
      qbank.filter(
        (x) =>
          (chapter === "all" || x.chapter === chapter) &&
          (!onlyCritical || x.critical) &&
          (statusFilter === "all" || (statusFilter === "published" ? x.published : !x.published)) &&
          `${x.externalId} ${x.question} ${x.source}`.toLowerCase().includes(q.toLowerCase()),
      ),
    [qbank, chapter, onlyCritical, statusFilter, q],
  );
  const drafts = shown.filter((row) => !row.published);
  const chosen = drafts.filter((row) => checked.has(row.id));
  const allChecked = drafts.length > 0 && chosen.length === drafts.length;
  useEffect(() => {
    setChecked(new Set());
  }, [q, chapter, onlyCritical, statusFilter]);

  function openEdit(item: QuestionItem) {
    if (!item.id) sets.reload();
    const rec = data.value?.find((r) => r.id === item.id);
    applyEditing(item, rec);
    updateUrl({ id: item.id || "new" });
  }

  function closeEdit() {
    applyEditing(null);
    updateUrl({ id: null });
  }

  function save() {
    if (!editing || task.busy || !editing.question.trim()) return;
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
        chapter: chapters.indexOf(editing.chapter) + 1,
        options: editing.options,
        correctAnswer: editing.answer,
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
          send("POST", { rows: [payload], updateExisting: false, questionSetId }),
        );
      data.reload();
      applyEditing(null);
      updateUrl({ id: null }, true);
      notify("Đã lưu bản nháp; chưa xuất bản");
    });
  }

  function publish(id: string, published: boolean) {
    const r = data.value?.find((row) => row.id === id);
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
    saveBlob(blob, "ngan-hang-cau-hoi.json");
    notify("Đã xuất câu hỏi ra tệp JSON");
  }

  return (
    <Page
      title="Quản lý đề thi GPLX"
      // subtitle={
      //   tab !== "questions"
      //     ? "Quản lý bộ nhận dữ liệu và cấu hình đề thi theo từng hạng giấy phép lái xe."
      //     : undefined
      // }
      actions={
        tab === "questions" ? (
          <>
            <Button
              variant={showImport ? "dark" : "outline"}
              onClick={() => updateUrl({ import: showImport ? null : "1" })}
            >
              {showImport ? "Đóng nhập hàng loạt" : "Nhập CSV/JSON & ZIP ảnh"}
            </Button>
            <Button onClick={exportJson}>Xuất JSON</Button>
            <Button variant="primary" onClick={() => openEdit(blank())}>
              + Thêm câu hỏi
            </Button>
          </>
        ) : undefined
      }
    >
      <div
        className="mb-6 flex min-w-0 max-w-full items-center gap-5 overflow-x-auto border-b border-line"
        role="tablist"
        aria-label="Quản lý câu hỏi và bộ đề"
      >
        {(
          [
            { value: "questions", label: `Ngân hàng câu hỏi (${data.value ? qbank.length : "—"})` },
            { value: "sets", label: `Bộ câu hỏi (${sets.value ? sets.value.length : "—"})` },
            { value: "chapters", label: "Chương" },
            { value: "rules", label: "Quy tắc đề thi" },
          ] as const
        ).map(({ value, label }) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={tab === value}
            onClick={() => switchTab(value)}
            className={`min-h-10 shrink-0 whitespace-nowrap border-b-2 py-2 text-sm font-medium transition-colors cursor-pointer focus-visible:outline-2 focus-visible:outline-accent-strong ${tab === value
              ? "border-navy text-navy font-semibold"
              : "border-transparent text-muted hover:text-navy"
              }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab !== "questions" ? (
        <QuestionBankSettings embedded tab={tab} onTabChange={switchTab} />
      ) : (
        <>
          <Notice {...data} retry={data.reload} />
          <Notice error={task.error} />

          {showImport && (
            <ImportPanel
              kind="questions"
              onImported={() => {
                data.reload();
                sets.reload();
              }}
              onClose={() => updateUrl({ import: null })}
            />
          )}

          <ContentStats
            total={data.value?.length}
            published={data.value?.filter((row) => row.published).length}
          />

          <div className="grid gap-3 mb-4 sm:grid-cols-2 xl:grid-cols-[minmax(16rem,1fr)_14rem_12rem_auto] xl:items-center">
            <input
              aria-label="Tìm câu hỏi"
              className={inputCls}
              placeholder="Tìm câu hỏi, mã, nguồn…"
              value={q}
              onChange={(e) => {
                const v = e.target.value;
                setQ(v);
                updateUrl({ q: v || null }, true);
              }}
            />
            <select
              className={inputCls}
              value={chapter}
              onChange={(e) =>
                updateUrl({ chapter: e.target.value === "all" ? null : e.target.value })
              }
              aria-label="Chương"
            >
              <option value="all">Tất cả chương</option>
              {chapters.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
            <select
              className={inputCls}
              value={statusFilter}
              onChange={(e) =>
                updateUrl({ status: e.target.value === "all" ? null : e.target.value })
              }
              aria-label="Trạng thái xuất bản"
            >
              <option value="all">Mọi trạng thái</option>
              <option value="published">Đã xuất bản</option>
              <option value="draft">Bản nháp</option>
            </select>
            <label className="flex items-center gap-2 text-[13px] text-text-secondary">
              <Toggle
                checked={onlyCritical}
                onChange={(v) => updateUrl({ critical: v ? "1" : null })}
                label="Chỉ câu điểm liệt"
              />{" "}
              Chỉ câu điểm liệt
            </label>
          </div>

          <SelectionBar selected={chosen.length} total={drafts.length}>
            <Button
              variant="primary"
              disabled={task.busy || data.loading || !chosen.length || chosen.length > 600}
              onClick={() =>
                void task.run(async () => {
                  await api(
                    "/admin/questions/publication-batch",
                    send("POST", publicationBatchBody(
                      (data.value || []).filter((row) => chosen.some((item) => item.id === row.id)),
                    )),
                  );
                  setChecked(new Set());
                  data.reload();
                })
              }
            >
              Duyệt và xuất bản các câu đã chọn
            </Button>
            {chosen.length > 600 && (
              <p className="w-full text-xs text-muted">Mỗi lần xuất bản tối đa 600 bản ghi.</p>
            )}
          </SelectionBar>

          <Card className="overflow-x-auto">
            <table className="w-full min-w-[960px]">
              <thead className="border-b border-line">
                <tr>
                  <Th className="w-12">
                    <input
                      type="checkbox"
                      aria-label="Chọn tất cả câu hỏi bản nháp đang lọc"
                      checked={allChecked}
                      className="h-4 w-4 accent-accent-strong"
                      ref={(input) => { if (input) input.indeterminate = chosen.length > 0 && !allChecked; }}
                      disabled={task.busy || data.loading || !drafts.length}
                      onChange={(event) => setChecked(new Set(event.target.checked ? drafts.map((row) => row.id) : []))}
                    />
                  </Th>
                  <Th className="w-12">#</Th>
                  <Th>Câu hỏi</Th>
                  <Th>Chương</Th>
                  <Th className="w-48">Nguồn</Th>
                  <Th className="w-32">Trạng thái</Th>
                  <Th className="text-right">Thao tác</Th>
                </tr>
              </thead>
              <tbody>
                {shown.map((x, i) => (
                  <tr key={x.id} className="border-b border-line/60 last:border-0 hover:bg-hover">
                    <Td>
                      {!x.published && (
                        <input
                          type="checkbox"
                          aria-label={`Chọn câu hỏi ${x.externalId}`}
                          checked={checked.has(x.id)}
                          className="h-4 w-4 accent-accent-strong"
                          disabled={task.busy || data.loading}
                          onChange={(event) => {
                            const selected = event.target.checked;
                            setChecked((previous) => {
                              const next = new Set(previous);
                              if (selected) next.add(x.id);
                              else next.delete(x.id);
                              return next;
                            });
                          }}
                        />
                      )}
                    </Td>
                    <Td className="text-muted font-mono text-xs">{i + 1}</Td>
                    <Td className="text-navy">
                      <span className="font-medium">{x.question}</span>
                      {x.critical && (
                        <span className="ml-2">
                          <Badge tone="red">Điểm liệt</Badge>
                        </span>
                      )}
                    </Td>
                    <Td className="text-muted whitespace-nowrap">{x.chapter}</Td>
                    <Td className="text-muted">
                      <span className="block max-w-48 truncate" title={x.source}>
                        {x.source}
                      </span>
                    </Td>
                    <Td>
                      <Badge tone={x.published ? "green" : "gray"}>
                        {x.published ? "Đã xuất bản" : "Bản nháp"}
                      </Badge>
                    </Td>
                    <Td className="text-right whitespace-nowrap">
                      <span className="inline-flex items-center justify-end gap-2">
                        <EditIconButton onClick={() => openEdit(x)} />
                        <Button
                          size="sm"
                          disabled={task.busy}
                          onClick={() => publish(x.id, !x.published)}
                        >
                          {x.published ? "Hủy xuất bản" : "Xuất bản"}
                        </Button>
                      </span>
                    </Td>
                  </tr>
                ))}
                {!shown.length && (
                  <tr>
                    <td colSpan={7} className="px-4 py-8 text-center text-[13.5px] text-muted">
                      Không có câu hỏi phù hợp.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </Card>

          <Modal
            open={!!editing}
            title={editing?.id ? "Sửa câu hỏi" : "Thêm câu hỏi"}
            onClose={closeEdit}
            footer={
              <>
                <Button variant="ghost" onClick={closeEdit}>
                  Huỷ
                </Button>
                <Button
                  variant="primary"
                  onClick={save}
                  disabled={task.busy || !editing?.question.trim()}
                >
                  Lưu
                </Button>
              </>
            }
          >
            <Notice error={task.error} />
            {editing && (
              <div className="space-y-4">
                <Field label="Bộ câu hỏi">
                  <select
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
                <Field label="Mã định danh nguồn">
                  <input
                    className={inputCls}
                    readOnly={!!record?.data.sourceExternalId}
                    value={externalId}
                    onChange={(e) => setExternalId(e.target.value)}
                  />
                </Field>
                <Field label="Nội dung câu hỏi">
                  <textarea
                    rows={2}
                    className={inputCls}
                    value={editing.question}
                    onChange={(e) => setEditing({ ...editing, question: e.target.value })}
                  />
                </Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Chương">
                    <select
                      className={inputCls}
                      value={editing.chapter}
                      onChange={(e) => setEditing({ ...editing, chapter: e.target.value })}
                    >
                      {chapters.map((c) => (
                        <option key={c}>{c}</option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Căn cứ">
                    <input
                      className={inputCls}
                      value={editing.source}
                      onChange={(e) => setEditing({ ...editing, source: e.target.value })}
                      placeholder="NĐ 168/2024…"
                    />
                  </Field>
                </div>
                <div>
                  <span className="block text-xs font-medium text-text-secondary mb-1.5">
                    Phương án (chọn đáp án đúng)
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
                            type="button"
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
                      type="button"
                      className="mt-2 text-xs font-medium text-accent-strong"
                      onClick={() => setEditing({ ...editing, options: [...editing.options, ""] })}
                    >
                      + Thêm phương án
                    </button>
                  )}
                </div>
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
                {record && (
                  <>
                    <p className="text-xs">
                      {record.published ? "Đã xuất bản" : "Bản nháp"} · phiên bản {record.version}
                    </p>
                    {!!record.data.imageKey && (
                      <Asset
                        id={record.id}
                        path={`/admin/content/${record.id}/media`}
                        alt="Ảnh câu hỏi"
                      />
                    )}
                    <FilePicker
                      title="Tải ảnh câu hỏi"
                      hint="PNG hoặc JPEG · Tối đa 5 MB"
                      accept=".png,.jpg,.jpeg"
                      disabled={task.busy}
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (!file) return;
                        void task.run(async () => {
                          const body = new FormData();
                          body.append("file", file);
                          await api(`/admin/content/${record.id}/media`, { method: "POST", body });
                          data.reload();
                        });
                      }}
                    />
                    <Button
                      disabled={task.busy}
                      onClick={() =>
                        void task.run(async () =>
                          setHistory(await api(`/admin/content/${record.id}/history`)),
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
                <Field label="Giải thích">
                  <textarea
                    rows={2}
                    className={inputCls}
                    value={editing.explanation}
                    onChange={(e) => setEditing({ ...editing, explanation: e.target.value })}
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
        </>
      )}
    </Page>
  );
}
