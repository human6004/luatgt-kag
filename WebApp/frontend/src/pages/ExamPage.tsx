import { useEffect, useState } from "react"
import { useSearchParams } from "react-router-dom"

import { api, send } from "../api";

import {
  Button,
  Card,
  Field,
  Modal,
  NavLinkButton,
  Page,
  inputCls,
} from "../admin/ui";

import { Asset, Notice, useData, useTask } from "./shared/shared"

import type { ExamRule } from "./shared/QuestionBankSettings"

type Question = {
  questionId: string;
  text: string;
  chapter: number;
  options: string[];
  imageKey?: string;
  correctAnswer?: number;
  critical?: boolean;
  explanation?: string;
};

type Exam = {
  id: string;
  license: string;
  ruleset: string;
  expiresAt: string;
  serverTime: string;
  startedAt: string;
  questions: Question[];
  answers: Record<string, number>;
  submittedAt: string | null;
  score?: number;
  passed?: boolean;
  criticalFailed?: boolean;
  minimumCorrect?: number;
  durationMinutes?: number;
};

type History = {
  id: string;
  license: string;
  total: number;
  startedAt: string;
  submittedAt: string | null;
  score: number | null;
  passed: boolean | null;
  criticalFailed: boolean | null;
};

export default function ExamPage() {
  const [params, setParams] = useSearchParams()
  const rules = useData<ExamRule[]>("/exam-rules"),
    history = useData<History[]>("/exams"),
    task = useTask();

  const ruleParam = params.get("rule") || params.get("cls") || ""
  const [exam, setExam] = useState<Exam | null>(null),
    [current, setCurrent] = useState(0),
    [left, setLeft] = useState(0);

  const [flags, setFlags] = useState<Set<string>>(new Set()),
    [confirm, setConfirm] = useState(false),
    [wrongOnly, setWrongOnly] = useState(false);

  const selected =
    rules.value?.find(
      (r) =>
        r.rule_id === ruleParam ||
        r.class_code.toLowerCase() === ruleParam.toLowerCase(),
    ) ?? rules.value?.[0]

  function setRuleId(id: string) {
    setParams((prev) => {
      const next = new URLSearchParams(prev)
      next.delete("cls")
      if (!id) next.delete("rule")
      else next.set("rule", id)
      return next
    })
  }

  function accept(value: Exam) {
    setExam(value);
    sessionStorage.setItem("luatgt-active-exam", value.id);

    setLeft(
      Math.max(
        0,
        Math.ceil(
          (Date.parse(value.expiresAt) - Date.parse(value.serverTime)) / 1000,
        ),
      ),
    );
  }

  async function open(id: string) {
    accept(await api<Exam>(`/exams/${id}`));
    setCurrent(0);
    setFlags(new Set());
    setWrongOnly(false);
  }

  useEffect(() => {
    const id = sessionStorage.getItem("luatgt-active-exam");
    if (!id) return;
    const controller = new AbortController();
    void task.run(async () => {
      const value = await api<Exam>(`/exams/${id}`, {
        signal: controller.signal,
      });
      if (!controller.signal.aborted) accept(value);
    });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!exam || exam.submittedAt) return;
    const timer = window.setInterval(
      () => setLeft((v) => Math.max(0, v - 1)),
      1000,
    );
    return () => window.clearInterval(timer);
  }, [exam?.id, exam?.submittedAt]);

  async function submit() {
    if (!exam || task.busy) return;
    await task.run(async () => {
      accept(await api<Exam>(`/exams/${exam.id}/submit`, send("POST")));
      setConfirm(false);
      history.reload();
    });
  }

  useEffect(() => {
    if (exam && !exam.submittedAt && left === 0 && !task.busy && !task.error)
      void submit();
  }, [left, exam?.id, exam?.submittedAt, task.busy, task.error]);

  function choose(questionId: string, selected: number) {
    if (!exam || task.busy || exam.submittedAt || left <= 0) return;
    void task.run(async () =>
      accept(
        await api<Exam>(
          `/exams/${exam.id}/answers/${questionId}`,
          send("PUT", { selected }),
        ),
      ),
    );
  }

  function toggleFlag(id: string) {
    setFlags((before) => {
      const next = new Set(before);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  useEffect(() => {
    if (!exam || exam.submittedAt || confirm) return;

    const handler = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("input,select,textarea")) return;
      const question = exam.questions[current];
      const number = Number(e.key);
      if (number >= 1 && number <= question.options.length)
        choose(question.questionId, number - 1);
      else if (e.key === "ArrowRight")
        setCurrent((i) => Math.min(exam.questions.length - 1, i + 1));
      else if (e.key === "ArrowLeft") setCurrent((i) => Math.max(0, i - 1));
      else if (e.key.toLowerCase() === "f") toggleFlag(question.questionId);
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [exam, current, confirm, task.busy, left]);

  function close() {
    setExam(null);
    setConfirm(false);
    setWrongOnly(false);
    sessionStorage.removeItem("luatgt-active-exam");
    history.reload();
  }

  if (!exam)
    return (
      <Page
        title="Thi thử lý thuyết"
        subtitle="Chọn bộ câu hỏi và hạng giấy phép lái xe để luyện thi."
        actions={<NavLinkButton to="/on-thi">Ôn tập theo chương</NavLinkButton>}
      >
        <Notice {...rules} retry={rules.reload} />
        <Notice {...history} retry={history.reload} />
        <Notice error={task.error} />
        <div className="grid min-w-0 gap-6 lg:grid-cols-2 items-start">
          <Card title="Chọn bài thi">
            <div className="px-5 pb-5 space-y-5">
              {selected ? (
                <>
                  <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
                    <Field label="Bộ câu hỏi">
                      <select
                        aria-label="Bộ câu hỏi"
                        className={inputCls}
                        value={selected.set_id}
                        disabled={task.busy || rules.loading}
                        onChange={(e) =>
                          setRuleId(
                            rules.value?.find((r) => r.set_id === e.target.value)
                              ?.rule_id || "",
                          )
                        }
                      >
                        {Array.from(
                          new Map(
                            (rules.value || []).map((r) => [r.set_id, r.set_name]),
                          ),
                        ).map(([id, name]) => (
                          <option key={id} value={id}>
                            {name}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Hạng thi">
                      <select
                        aria-label="Hạng thi"
                        className={inputCls}
                        value={selected.rule_id}
                        disabled={task.busy || rules.loading}
                        onChange={(e) => setRuleId(e.target.value)}
                      >
                        {rules.value
                          ?.filter((r) => r.set_id === selected.set_id)
                          .map((r) => (
                            <option key={r.rule_id} value={r.rule_id}>
                              Hạng {r.class_code}
                            </option>
                          ))}
                      </select>
                    </Field>
                  </div>
                  <dl className="grid grid-cols-3 gap-3 border-y border-line py-4 text-sm">
                    <div>
                      <dt className="text-xs text-muted">Số câu</dt>
                      <dd className="mt-1 font-semibold text-navy">
                        {selected.total_questions} câu
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted">Thời gian</dt>
                      <dd className="mt-1 font-semibold text-navy">
                        {selected.duration_minutes} phút
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted">Điểm đạt</dt>
                      <dd className="mt-1 font-semibold text-navy">
                        {selected.minimum_correct}/{selected.total_questions}
                      </dd>
                    </div>
                  </dl>
                  {selected.fail_on_critical && (
                    <p className="text-sm text-muted">
                      Không sai hoặc bỏ trống câu điểm liệt.
                    </p>
                  )}
                  <Button
                    variant="primary"
                    className="w-full sm:w-auto"
                    disabled={task.busy || rules.loading}
                    onClick={() =>
                      void task.run(async () => {
                        accept(
                          await api<Exam>(
                            "/exams",
                            send("POST", { ruleId: selected.rule_id }),
                          ),
                        )
                        setCurrent(0)
                        setFlags(new Set())
                      })
                    }
                  >
                    {task.busy ? "Đang tạo bài thi…" : "Bắt đầu thi"}
                  </Button>
                </>
              ) : !rules.loading && !rules.error ? (
                <div className="space-y-3">
                  <p className="font-medium text-navy">
                    Chưa có đề thi đang áp dụng
                  </p>
                  <p className="text-sm leading-6 text-muted">
                    Người quản lý cần cấu hình đề thi và xuất bản đủ câu hỏi. Bạn
                    không cần tự thiết lập quy tắc.
                  </p>
                </div>
              ) : (
                <p className="text-sm text-muted">
                  {rules.loading
                    ? "Đang tải danh sách bài thi…"
                    : "Chưa tải được danh sách bài thi. Vui lòng thử lại."}
                </p>
              )}
            </div>
          </Card>
          <Card title="Lịch sử thi">
            <div className="px-5 pb-5 space-y-3">
              {history.value?.map((h) => (
                <div
                  key={h.id}
                  className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-3"
                >
                  <span>
                    Hạng {h.license} ·{" "}
                    {new Date(h.startedAt).toLocaleString("vi-VN")} ·{" "}
                    {h.submittedAt
                      ? `${h.score}/${h.total} · ${
                          h.passed ? "Đạt" : "Không đạt"
                        }${h.criticalFailed ? " · Sai câu điểm liệt" : ""}`
                      : "Chưa nộp"}
                  </span>
                  <Button
                    disabled={task.busy}
                    onClick={() => void task.run(() => open(h.id))}
                  >
                    {h.submittedAt ? "Xem bài" : "Tiếp tục"}
                  </Button>
                </div>
              ))}
              {history.value?.length === 0 && (
                <p className="text-muted">Chưa có bài thi.</p>
              )}
            </div>
          </Card>
        </div>
      </Page>
    );

  if (exam.submittedAt) {
    const questions = exam.questions.filter(
      (q) => !wrongOnly || exam.answers[q.questionId] !== q.correctAnswer,
    );

    return (
      <Page
        title={exam.passed ? "Kết quả: Đạt" : "Kết quả: Không đạt"}
        subtitle={`Hạng ${exam.license} · ${exam.score}/${exam.questions.length} câu đúng`}
        actions={<Button onClick={close}>Chọn đề khác</Button>}
      >
        <Notice error={task.error} />
        {exam.criticalFailed && (
          <p className="mb-4 text-red-700">
            Có câu điểm liệt trả lời sai hoặc bỏ trống.
          </p>
        )}
        <label className="block mb-5 text-sm">
          <input
            type="checkbox"
            checked={wrongOnly}
            onChange={(e) => setWrongOnly(e.target.checked)}
          />{" "}
          Chỉ xem câu sai hoặc bỏ trống
        </label>
        <div className="space-y-4">
          {questions.map((q) => (
            <Card
              key={q.questionId}
              title={`Chương ${q.chapter}${
                q.critical ? " · Câu điểm liệt" : ""
              }`}
            >
              <div className="p-5 space-y-3">
                <p className="font-medium">{q.text}</p>
                {q.imageKey && (
                  <Asset
                    id={q.questionId}
                    path={`/exams/${exam.id}/questions/${q.questionId}/media`}
                    alt="Ảnh câu hỏi"
                  />
                )}
                <ol className="space-y-2">
                  {q.options.map((label, i) => (
                    <li
                      key={i}
                      className={
                        i === q.correctAnswer
                          ? "font-semibold text-emerald-700"
                          : ""
                      }
                    >
                      {i + 1}. {label}
                      {i === q.correctAnswer ? " · Đáp án đúng" : ""}
                      {exam.answers[q.questionId] === i ? " · Bạn chọn" : ""}
                    </li>
                  ))}
                </ol>
                {exam.answers[q.questionId] === undefined && (
                  <p className="text-red-700">Bạn chưa trả lời câu này.</p>
                )}
                {q.explanation && <p>{q.explanation}</p>}
              </div>
            </Card>
          ))}
        </div>
      </Page>
    );
  }

  const q = exam.questions[current],
    answered = Object.keys(exam.answers).length;

  return (
    <Page
      title={`Thi thử hạng ${exam.license}`}
      subtitle={`Câu ${current + 1}/${exam.questions.length} · Đã trả lời ${answered}`}
    >
      <Notice error={task.error} />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_280px]">
        <div>
          <Card title={`Chương ${q.chapter}`}>
            <div className="p-5 space-y-4">
              <p className="text-lg font-medium">{q.text}</p>
              {q.imageKey && (
                <Asset
                  id={q.questionId}
                  path={`/exams/${exam.id}/questions/${q.questionId}/media`}
                  alt="Ảnh câu hỏi"
                />
              )}
              {q.options.map((label, i) => (
                <Button
                  key={i}
                  aria-pressed={exam.answers[q.questionId] === i}
                  variant={
                    exam.answers[q.questionId] === i ? "dark" : "outline"
                  }
                  className="w-full justify-start text-left"
                  disabled={task.busy || left <= 0}
                  onClick={() => choose(q.questionId, i)}
                >
                  {i + 1}. {label}
                </Button>
              ))}
              <Button
                aria-pressed={flags.has(q.questionId)}
                onClick={() => toggleFlag(q.questionId)}
              >
                {flags.has(q.questionId) ? "Bỏ đánh dấu" : "Đánh dấu xem lại"}
              </Button>
            </div>
          </Card>
          <div className="mt-4 flex justify-between gap-3">
            <Button
              disabled={current === 0}
              onClick={() => setCurrent((i) => i - 1)}
            >
              Câu trước
            </Button>
            <Button
              disabled={current === exam.questions.length - 1}
              onClick={() => setCurrent((i) => i + 1)}
            >
              Câu tiếp
            </Button>
          </div>
        </div>
        <aside className="space-y-4">
          <p
            role="timer"
            aria-label="Thời gian còn lại"
            className={`font-mono text-4xl ${
              left <= 60 ? "text-red-700" : "text-navy"
            }`}
          >
            {String(Math.floor(left / 60)).padStart(2, "0")}:
            {String(left % 60).padStart(2, "0")}
          </p>
          <div className="grid grid-cols-6 gap-2">
            {exam.questions.map((question, i) => (
              <Button
                key={question.questionId}
                aria-label={`Câu ${i + 1}${
                  flags.has(question.questionId) ? ", đánh dấu" : ""
                }`}
                aria-current={i === current ? "step" : undefined}
                variant={
                  exam.answers[question.questionId] === undefined
                    ? "outline"
                    : "dark"
                }
                onClick={() => setCurrent(i)}
              >
                {i + 1}
                {flags.has(question.questionId) ? " *" : ""}
              </Button>
            ))}
          </div>
          <Button
            variant="primary"
            disabled={task.busy}
            onClick={() => setConfirm(true)}
          >
            Nộp bài
          </Button>
        </aside>
      </div>
      <Modal
        open={confirm}
        title="Nộp bài thi?"
        onClose={() => setConfirm(false)}
        footer={
          <>
            <Button onClick={() => setConfirm(false)}>Làm tiếp</Button>
            <Button disabled={task.busy} onClick={() => void submit()}>
              Nộp bài
            </Button>
          </>
        }
      >
        <p>
          Còn {exam.questions.length - answered} câu chưa trả lời. Câu bỏ trống
          được tính là sai.
        </p>
      </Modal>
    </Page>
  );
}
