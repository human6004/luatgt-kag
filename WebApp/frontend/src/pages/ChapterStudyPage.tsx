import type { ContentRecord } from "../api";
import { Notice, useData } from "./shared/shared";
import { Button, FilterTabs, NavLinkButton } from "../admin/ui";
import { Navigate, useNavigate, useSearchParams } from "react-router-dom";
import type { QuestionSet } from "./shared/QuestionBankSettings";

export type ChapterStatus = "not_started" | "in_progress" | "completed";

export interface ChapterItem {
  id: number;
  title: string;
  totalQuestions: number;
  studiedQuestions: number;
  status: ChapterStatus;
}

export default function ChapterStudyPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const sets = useData<QuestionSet[]>("/question-sets");
  const setId = params.get("set") || "";
  const selectedSet = setId || sets.value?.[0]?.set_id || "";
  const suffix = selectedSet
    ? "?questionSetId=" + encodeURIComponent(selectedSet)
    : "";
  const questions = useData<ContentRecord[]>("/questions" + suffix);
  const progress = useData<
    { chapter: number; practiced: number; correct: number; attempts: number }[]
  >("/progress" + suffix);
  const chapterIds = [
    ...new Set((questions.value || []).map((q) => Number(q.data.chapter))),
  ]
    .filter((id) => Number.isInteger(id) && id > 0)
    .sort((a, b) => a - b);
  const chapters: ChapterItem[] = chapterIds.map((id) => {
    const total = questions.value!.filter(
      (q) => Number(q.data.chapter) === id,
    ).length;
    const practiced =
      progress.value?.find((p) => p.chapter === id)?.practiced || 0;
    return {
      id,
      title: `Chương ${id}`,
      totalQuestions: total,
      studiedQuestions: practiced,
      status:
        practiced >= total
          ? "completed"
          : practiced > 0
            ? "in_progress"
            : "not_started",
    };
  });
  const ready =
    !!sets.value &&
    !!questions.value &&
    !!progress.value &&
    !questions.error &&
    !progress.error;

  const filterStatus = params.get("filter") ?? "all";
  const rawChapter = Number(params.get("chapter"));
  const selectedProgressChapterId =
    Number.isInteger(rawChapter) && rawChapter > 0 ? rawChapter : 1;
  const rawPractice = Number(params.get("practice"));

  function updateUrl(patch: Record<string, string | null>) {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      for (const [k, v] of Object.entries(patch)) {
        if (v === null || v === "") next.delete(k);
        else next.set(k, v);
      }
      return next;
    });
  }

  const totalAllQuestions = chapters.reduce(
    (acc, c) => acc + c.totalQuestions,
    0,
  );
  const totalStudied = chapters.reduce((acc, c) => acc + c.studiedQuestions, 0);
  const overallPercentage = Math.round(
    (totalStudied / (totalAllQuestions || 1)) * 100,
  );
  const completedChaptersCount = chapters.filter(
    (c) => c.status === "completed",
  ).length;
  const selectedProgressChapter =
    chapters.find((chapter) => chapter.id === selectedProgressChapterId) ??
    chapters[0];
  const selectedProgressPercentage = Math.round(
    ((selectedProgressChapter?.studiedQuestions || 0) /
      (selectedProgressChapter?.totalQuestions || 1)) *
      100,
  );
  const selectedProgressRemaining =
    (selectedProgressChapter?.totalQuestions || 0) -
    (selectedProgressChapter?.studiedQuestions || 0);

  const filteredChapters = chapters.filter((c) => {
    if (filterStatus === "all") return true;
    return c.status === filterStatus;
  });

  function practicePath(chapterId: number) {
    return (
      "/on-thi/luyen-tap/" +
      chapterId +
      "?questionSetId=" +
      encodeURIComponent(selectedSet)
    );
  }

  if (selectedSet && chapters.some((chapter) => chapter.id === rawPractice)) {
    return <Navigate replace to={practicePath(rawPractice)} />;
  }

  return (
    <div className="min-h-full pb-16 px-6 sm:px-8 max-w-7xl mx-auto pt-6">
      <Notice {...sets} retry={sets.reload} />
      <Notice {...questions} retry={questions.reload} />
      <Notice {...progress} retry={progress.reload} />
      {/* Header */}
      <div className="mb-6">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted font-mono">
            <span>LuậtGT</span>
            <span>/</span>
            <span className="text-navy font-sans font-medium">
              Lộ trình ôn thi theo ngân hàng đã xuất bản
            </span>
          </div>
          <label className="flex min-w-0 max-w-full items-center gap-3 text-sm sm:ml-auto">
            Bộ câu hỏi{" "}
            <select
              aria-label="Bộ câu hỏi ôn tập"
              className="min-w-0 max-w-full sm:max-w-xs border border-line bg-surface rounded-md p-2"
              value={selectedSet}
              onChange={(e) => {
                updateUrl({ set: e.target.value || null, practice: null });
              }}
            >
              {sets.value?.map((set) => (
                <option key={set.set_id} value={set.set_id}>
                  {set.set_name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h1 className="font-sans font-semibold text-2xl sm:text-3xl text-navy tracking-normal">
              Ôn thi lý thuyết
            </h1>
          </div>
          <div className="flex items-center gap-2">
            <NavLinkButton to="/exam">Vào phòng thi thử</NavLinkButton>
          </div>
        </div>
      </div>

      {/* Main 2-Column Layout */}
      {chapters.length > 0 ? (
        <div className="grid grid-cols-1 xl:grid-cols-12 gap-8 items-start">
          {/* Left Column: Chapters List */}
          <div className="min-w-0 xl:col-span-8 space-y-4">
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2">
              <FilterTabs
                label="Lọc trạng thái học"
                value={filterStatus}
                onChange={(v) => updateUrl({ filter: v === "all" ? null : v })}
                items={[
                  { value: "all", label: "Tất cả chương" },
                  { value: "in_progress", label: "Đang học" },
                  { value: "completed", label: "Đã hoàn thành" },
                  { value: "not_started", label: "Chưa học" },
                ]}
              />
              <span className="text-xs text-muted hidden sm:block shrink-0 pl-2">
                {filteredChapters.length} chương
              </span>
            </div>

            {/* Chapter Cards */}
            <div className="space-y-4">
              {filteredChapters.map((chapter) => {
                const pct = Math.round(
                  (chapter.studiedQuestions / (chapter.totalQuestions || 1)) *
                    100,
                );

                return (
                  <section
                    key={chapter.id}
                    className="min-w-0 rounded-2xl border border-line bg-surface p-4 sm:p-5 space-y-3"
                  >
                    <h2 className="text-base sm:text-lg font-semibold leading-6 text-navy">
                      {chapter.title}
                    </h2>
                    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-3">
                      <p className="min-w-0 text-xs leading-5 text-muted">
                        {questions.value ? chapter.totalQuestions : "—"} câu hỏi
                        {ready && chapter.totalQuestions > 0 && (
                          <>
                            <span className="mx-2" aria-hidden="true">
                              ·
                            </span>
                            {chapter.status === "completed"
                              ? "Đã hoàn thành"
                              : chapter.status === "in_progress"
                                ? `${chapter.studiedQuestions}/${chapter.totalQuestions} câu đã ôn (${pct}%)`
                                : "Chưa học"}
                          </>
                        )}
                        {ready && chapter.totalQuestions === 0 && (
                          <span className="block">
                            Chưa có câu hỏi để luyện tập.
                          </span>
                        )}
                      </p>
                      <Button
                        size="sm"
                        variant={
                          chapter.status === "not_started" ? "primary" : "dark"
                        }
                        className="w-full sm:w-auto"
                        disabled={!ready || chapter.totalQuestions === 0}
                        onClick={() => navigate(practicePath(chapter.id))}
                      >
                        {chapter.status === "completed"
                          ? "Ôn tập lại"
                          : chapter.status === "in_progress"
                            ? "Tiếp tục học"
                            : "Bắt đầu học"}
                      </Button>
                    </div>
                  </section>
                );
              })}
            </div>
          </div>

          {/* Right Column: Tiến độ của tôi */}
          <div className="min-w-0 xl:col-span-4 xl:sticky xl:top-6 space-y-6">
            <div className="bg-surface rounded-2xl border border-line shadow-xs p-6 space-y-6">
              <div className="flex items-center justify-between border-b border-selected pb-4">
                <div className="flex items-center gap-2">
                  <span className="w-3 h-3 rounded-full bg-accent"></span>
                  <h2 className="font-sans text-lg font-bold text-navy">
                    Tiến độ của tôi
                  </h2>
                </div>
                <span className="text-xs px-2.5 py-0.5 rounded-full bg-selected text-accent-strong font-medium font-mono">
                  Bộ đã chọn
                </span>
              </div>

              <div className="bg-bg rounded-xl p-5 border border-line">
                <div className="flex items-baseline justify-between mb-2">
                  <span className="text-xs font-semibold uppercase tracking-wider text-muted">
                    Tổng tiến độ hoàn thành
                  </span>
                  <span className="font-sans text-3xl font-bold text-navy">
                    {ready ? overallPercentage : "—"}%
                  </span>
                </div>

                <div className="w-full bg-line h-3.5 rounded-full overflow-hidden p-0.5">
                  <div
                    className="h-full rounded-full bg-progress transition-all duration-500 ease-out"
                    style={{
                      width: `${ready ? overallPercentage : "—"}%`,
                    }}
                  />
                </div>

                <div className="flex flex-wrap justify-between items-center gap-x-3 gap-y-1 text-xs text-muted mt-2.5">
                  <span>
                    Đã học:{" "}
                    <strong className="text-navy">
                      {ready ? totalStudied : "—"}
                    </strong>{" "}
                    / {ready ? totalAllQuestions : "—"} câu
                  </span>
                  <span>
                    Hoàn tất:{" "}
                    <strong className="text-navy">
                      {ready ? completedChaptersCount : "—"}
                    </strong>{" "}
                    / {chapters.length} chương
                  </span>
                </div>
              </div>

              <div className="space-y-4">
                <label
                  htmlFor="chapter-progress-selection"
                  className="block text-xs font-semibold uppercase tracking-wider text-muted"
                >
                  Tiến độ chi tiết từng chương
                </label>
                <div className="relative">
                  <select
                    id="chapter-progress-selection"
                    value={selectedProgressChapter.id}
                    onChange={(event) =>
                      updateUrl({
                        chapter:
                          event.target.value === "1"
                            ? null
                            : event.target.value,
                      })
                    }
                    className="w-full min-w-0 appearance-none rounded-xl border border-line bg-bg py-3 pl-3 pr-9 text-xs font-medium text-navy cursor-pointer outline-none transition-colors hover:border-accent focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/25"
                  >
                    {chapters.map((chapter) => (
                      <option key={chapter.id} value={chapter.id}>
                        {chapter.title}
                      </option>
                    ))}
                  </select>
                  <svg
                    className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-accent-strong"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth="1.8"
                      d="m6 9 6 6 6-6"
                    />
                  </svg>
                </div>

                <div
                  className="rounded-xl border border-line bg-bg p-4 space-y-3"
                  aria-live="polite"
                  aria-atomic="true"
                >
                  <div className="flex items-start justify-between gap-3">
                    <span className="text-xs font-medium leading-relaxed text-navy">
                      {selectedProgressChapter.title}
                    </span>
                    <span className="shrink-0 font-mono text-sm font-bold text-accent-strong">
                      {selectedProgressPercentage}%
                    </span>
                  </div>
                  <div
                    className="w-full bg-selected h-2 rounded-full overflow-hidden"
                    role="progressbar"
                    aria-label={`Tiến độ ${selectedProgressChapter.title}`}
                    aria-valuenow={selectedProgressPercentage}
                    aria-valuemin={0}
                    aria-valuemax={100}
                  >
                    <div
                      className="h-full rounded-full bg-progress transition-all duration-300"
                      style={{ width: `${selectedProgressPercentage}%` }}
                    />
                  </div>
                  <div className="flex justify-between gap-2 text-[11px] text-muted">
                    <span>
                      Đã học:{" "}
                      <strong className="text-navy">
                        {ready ? selectedProgressChapter.studiedQuestions : "—"}
                      </strong>{" "}
                      / {ready ? selectedProgressChapter.totalQuestions : "—"}{" "}
                      câu
                    </span>
                    <span>Còn {selectedProgressRemaining} câu</span>
                  </div>
                  <p className="text-[11px] text-muted leading-relaxed">
                    {selectedProgressChapter.status === "completed"
                      ? "Đã hoàn thành"
                      : selectedProgressChapter.status === "in_progress"
                        ? "Đang ôn tập"
                        : "Chưa bắt đầu học"}
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : (
        !questions.loading &&
        !questions.error &&
        !sets.loading &&
        !sets.error && (
          <section className="rounded-2xl border border-line bg-surface p-6 text-center">
            <h2 className="text-base font-semibold text-navy">
              Chưa có nội dung ôn tập
            </h2>
            <p className="mt-2 text-sm text-muted">
              {selectedSet
                ? "Bộ này chưa có câu hỏi đã xuất bản. Nội dung sẽ xuất hiện sau khi người quản lý nhập và duyệt câu hỏi."
                : "Chưa có bộ câu hỏi để ôn tập. Vui lòng quay lại sau."}
            </p>
          </section>
        )
      )}
    </div>
  );
}
