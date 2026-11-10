import { useState } from "react";
import { api, send } from "../../api";
import {
  Button,
  Card,
  EditIconButton,
  Field,
  Modal,
  Td,
  Th,
  Toggle,
  inputCls,
} from "../../admin/ui";
import { Notice, useData, useTask } from "./shared";
import type { QuestionSet } from "./QuestionBankSettings";

type Chapter = {
  topic_id: string;
  chapter: number;
  topic_name: string;
  question_count: number;
  rule_count: number;
};

export default function ChapterSettings({ sets }: { sets: QuestionSet[] }) {
  const [setId, setSetId] = useState("");
  const selected = sets.find((s) => s.set_id === setId) || sets[0];
  return (
    <section aria-labelledby="chapter-settings-heading" className="space-y-4">
      <h2 id="chapter-settings-heading" className="text-lg font-semibold text-navy">
        Cấu hình chương
      </h2>
      <Field label="Bộ câu hỏi">
        <select
          className={`${inputCls} sm:max-w-sm`}
          value={selected?.set_id || ""}
          disabled={!sets.length}
          onChange={(e) => setSetId(e.target.value)}
        >
          {!sets.length && <option value="">Chưa có bộ câu hỏi</option>}
          {sets.map((s) => (
            <option key={s.set_id} value={s.set_id}>
              {s.release_code} / {s.set_name}
            </option>
          ))}
        </select>
      </Field>
      {selected ? (
        <ChapterList key={selected.set_id} set={selected} />
      ) : (
        <p className="text-sm text-muted">Tạo bộ câu hỏi trước khi cấu hình chương.</p>
      )}
    </section>
  );
}

function ChapterList({ set }: { set: QuestionSet }) {
  const path = `/admin/questions/sets/${set.set_id}/chapters`;
  const chapters = useData<Chapter[]>(path),
    task = useTask();
  const [form, setForm] = useState<{ id?: string; chapter: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState<Chapter | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [message, setMessage] = useState("");
  const trash = (
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
  );
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="min-w-0 text-sm text-muted">
          Tên chương dùng chung cho các bộ thuộc đợt {set.release_code}.
        </p>
        <Button
          variant="primary"
          disabled={chapters.loading || !!chapters.error || task.busy}
          onClick={() => {
            const used = new Set(chapters.value?.map((c) => c.chapter));
            let chapter = 1;
            while (used.has(chapter)) chapter++;
            task.clearError();
            setMessage("");
            setForm({ chapter: String(chapter), name: "" });
          }}
        >
          + Thêm chương
        </Button>
      </div>
      <Notice {...chapters} retry={chapters.reload} />
      {message && (
        <p role="status" className="text-sm text-green-700">
          {message}
        </p>
      )}
      {chapters.value && (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px]">
              <thead>
                <tr>
                  <Th>Chương</Th>
                  <Th>Tên chương</Th>
                  <Th>Câu hỏi</Th>
                  <Th>Quy tắc</Th>
                  <Th className="text-right">Thao tác</Th>
                </tr>
              </thead>
              <tbody>
                {chapters.value.map((c) => (
                  <tr key={c.topic_id} className="border-t border-line">
                    <Td>{c.chapter}</Td>
                    <Td>{c.topic_name}</Td>
                    <Td>{c.question_count}</Td>
                    <Td>{c.rule_count}</Td>
                    <Td className="text-right">
                      <div className="flex items-center justify-end gap-2">
                        <EditIconButton
                          label="Chỉnh sửa chương"
                          disabled={task.busy}
                          onClick={() => {
                            task.clearError();
                            setMessage("");
                            setForm({
                              id: c.topic_id,
                              chapter: String(c.chapter),
                              name: c.topic_name,
                            });
                          }}
                        />
                        <button
                          type="button"
                          aria-label={`Xóa chương ${c.chapter}`}
                          title={
                            c.question_count || c.rule_count
                              ? "Chương đang có câu hỏi hoặc quy tắc sử dụng"
                              : `Xóa chương ${c.chapter}`
                          }
                          disabled={task.busy || c.question_count > 0 || c.rule_count > 0}
                          className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-red-700 hover:bg-red-50 disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-accent-strong"
                          onClick={() => {
                            task.clearError();
                            setMessage("");
                            setConfirmed(false);
                            setDeleting(c);
                          }}
                        >
                          {trash}
                        </button>
                      </div>
                    </Td>
                  </tr>
                ))}
                {!chapters.value.length && (
                  <tr>
                    <td colSpan={5} className="p-6 text-center text-sm text-muted">
                      Chưa có chương. Bấm “Thêm chương” để cấu hình.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>
      )}
      <Modal
        open={!!form}
        title={form?.id ? "Chỉnh sửa chương" : "Thêm chương"}
        onClose={() => {
          if (!task.busy) setForm(null);
        }}
        footer={
          <>
            <Button disabled={task.busy} onClick={() => setForm(null)}>
              Hủy
            </Button>
            <Button
              variant="primary"
              type="submit"
              form="chapter-settings-form"
              disabled={task.busy}
            >
              {task.busy ? "Đang lưu…" : "Lưu"}
            </Button>
          </>
        }
      >
        <Notice error={task.error} />
        {form && (
          <form
            id="chapter-settings-form"
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              void task.run(async () => {
                await api(
                  path + (form.id ? "/" + form.id : ""),
                  send(form.id ? "PUT" : "POST", {
                    chapter: Number(form.chapter),
                    name: form.name.trim(),
                  }),
                );
                setMessage(form.id ? "Đã cập nhật tên chương." : "Đã thêm chương.");
                setForm(null);
                chapters.reload();
              });
            }}
          >
            <Field label="Số chương" required>
              <input
                required
                type="number"
                min="1"
                max="32767"
                step="1"
                disabled={!!form.id || task.busy}
                className={inputCls}
                value={form.chapter}
                onChange={(e) => setForm({ ...form, chapter: e.target.value })}
              />
            </Field>
            <Field label="Tên chương" required>
              <input
                required
                maxLength={500}
                disabled={task.busy}
                className={inputCls}
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </Field>
            {form.id && (
              <p className="text-xs text-muted">
                Giữ nguyên số chương để bảo toàn liên kết câu hỏi và quy tắc.
              </p>
            )}
          </form>
        )}
      </Modal>
      <Modal
        open={!!deleting}
        title="Xóa chương"
        onClose={() => {
          if (!task.busy) setDeleting(null);
        }}
        footer={
          <>
            <Button disabled={task.busy} onClick={() => setDeleting(null)}>
              Hủy
            </Button>
            <Button
              variant="danger"
              disabled={task.busy || !confirmed}
              onClick={() =>
                void task.run(async () => {
                  if (!deleting) return;
                  await api(path + "/" + deleting.topic_id, send("DELETE"));
                  setMessage(`Đã xóa chương ${deleting.chapter}.`);
                  setDeleting(null);
                  chapters.reload();
                })
              }
            >
              {task.busy ? "Đang xóa…" : "Xóa chương"}
            </Button>
          </>
        }
      >
        <p>
          Xóa chương {deleting?.chapter}: <strong>{deleting?.topic_name}</strong> khỏi đợt{" "}
          {set.release_code}? Thao tác không thể hoàn tác.
        </p>
        <div className="mt-4">
          <Toggle checked={confirmed} onChange={setConfirmed} label="Tôi xác nhận xóa chương này" />
        </div>
        <Notice error={task.error} />
      </Modal>
    </>
  );
}
