import { useState } from "react";
import { Link } from "react-router-dom";

export type ChapterStatus = "not_started" | "in_progress" | "completed";

export interface ChapterItem {
  id: number;
  title: string;
  subtitle: string;
  desc: string;
  totalQuestions: number;
  studiedQuestions: number;
  criticalQuestions: number;
  status: ChapterStatus;
  lastStudiedDate?: string;
  completedDate?: string;
}

const initialChapters: ChapterItem[] = [
  {
    id: 1,
    title: "Chương I: Khái niệm và quy tắc giao thông đường bộ",
    subtitle: "Nền tảng lý thuyết bắt buộc",
    desc: "Bao gồm các khái niệm định nghĩa: dải phân cách, làn đường, khổ giới hạn, quy tắc vượt xe, nhường đường, chuyển hướng và tốc độ quy định.",
    totalQuestions: 166,
    studiedQuestions: 166,
    criticalQuestions: 45,
    status: "completed",
    completedDate: "28/09/2026",
    lastStudiedDate: "28/09/2026",
  },
  {
    id: 2,
    title: "Chương II: Nghiệp vụ vận tải & Đạo đức người lái xe",
    subtitle: "Văn hóa giao thông & Trách nhiệm xã hội",
    desc: "Quy định trách nhiệm của người lái xe, nghiệp vụ vận tải hàng hóa và hành khách, kỹ năng xử lý tình huống khẩn cấp và sơ cấp cứu nạn nhân.",
    totalQuestions: 57,
    studiedQuestions: 45,
    criticalQuestions: 12,
    status: "in_progress",
    lastStudiedDate: "30/09/2026",
  },
  {
    id: 3,
    title: "Chương III: Kỹ thuật lái xe ô tô an toàn",
    subtitle: "Thao tác điều khiển trên nhiều địa hình",
    desc: "Thao tác lái xe cơ bản, khởi hành xe ngang dốc, phanh khẩn cấp, lái xe đường đèo dốc quanh co, thời tiết sương mù và trơn trượt.",
    totalQuestions: 85,
    studiedQuestions: 38,
    criticalQuestions: 20,
    status: "in_progress",
    lastStudiedDate: "01/10/2026",
  },
  {
    id: 4,
    title: "Chương IV: Cấu tạo và sửa chữa xe cơ giới thông thường",
    subtitle: "Kiến thức kỹ thuật máy & an toàn kỹ thuật",
    desc: "Cấu tạo động cơ, hệ thống truyền lực, phanh, lái, lốp xe và các hư hỏng thông thường trên đường cùng phương pháp khắc phục an toàn.",
    totalQuestions: 48,
    studiedQuestions: 0,
    criticalQuestions: 8,
    status: "not_started",
  },
  {
    id: 5,
    title: "Chương V: Hệ thống biển báo hiệu đường bộ",
    subtitle: "Nhận diện và phân tích biển báo",
    desc: "Quy chuẩn hệ thống biển báo cấm, biển nguy hiểm, biển hiệu lệnh, biển chỉ dẫn, biển phụ và vạch kẻ đường theo QCVN 41:2019/BGTVT.",
    totalQuestions: 182,
    studiedQuestions: 75,
    criticalQuestions: 25,
    status: "in_progress",
    lastStudiedDate: "29/09/2026",
  },
  {
    id: 6,
    title: "Chương VI: Giải các thế sa hình và kỹ năng xử lý",
    subtitle: "Quy tắc nhường đường tại nơi giao nhau",
    desc: "Phân tích các thế sa hình theo thứ tự ưu tiên: Xe ưu tiên - Đường ưu tiên - Bên phải không vướng - Hướng rẽ ưu tiên.",
    totalQuestions: 114,
    studiedQuestions: 0,
    criticalQuestions: 30,
    status: "not_started",
  },
];

export default function ChapterStudyPage() {
  const [chapters, setChapters] = useState<ChapterItem[]>(initialChapters);
  const [filterStatus, setFilterStatus] = useState<string>("all");
  const [selectedProgressChapterId, setSelectedProgressChapterId] =
    useState<number>(
      initialChapters.find((chapter) => chapter.status === "in_progress")?.id ??
        initialChapters[0].id,
    );
  const [activePracticeModal, setActivePracticeModal] =
    useState<ChapterItem | null>(null);

  // Calculating overall progress
  const totalAllQuestions = chapters.reduce(
    (acc, c) => acc + c.totalQuestions,
    0,
  );
  const totalStudied = chapters.reduce((acc, c) => acc + c.studiedQuestions, 0);
  const overallPercentage = Math.round(
    (totalStudied / totalAllQuestions) * 100,
  );
  const completedChaptersCount = chapters.filter(
    (c) => c.status === "completed",
  ).length;
  const selectedProgressChapter =
    chapters.find((chapter) => chapter.id === selectedProgressChapterId) ??
    chapters[0];
  const selectedProgressPercentage = Math.round(
    (selectedProgressChapter.studiedQuestions /
      selectedProgressChapter.totalQuestions) *
      100,
  );
  const selectedProgressRemaining =
    selectedProgressChapter.totalQuestions -
    selectedProgressChapter.studiedQuestions;

  const filteredChapters = chapters.filter((c) => {
    if (filterStatus === "all") return true;
    return c.status === filterStatus;
  });

  // Quick action: continue learning simulation
  const handleQuickAdvance = (chapterId: number) => {
    setChapters((prev) =>
      prev.map((c) => {
        if (c.id === chapterId) {
          const nextStudied = Math.min(
            c.totalQuestions,
            c.studiedQuestions + 10,
          );
          const isDone = nextStudied === c.totalQuestions;
          return {
            ...c,
            studiedQuestions: nextStudied,
            status: isDone ? "completed" : "in_progress",
            lastStudiedDate: "Hôm nay, vừa xong",
            completedDate: isDone ? "Hôm nay" : c.completedDate,
          };
        }
        return c;
      }),
    );
  };

  return (
    <div className="min-h-full pb-16 px-6 sm:px-8 max-w-7xl mx-auto pt-6">
      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center gap-2 text-xs text-muted mb-2 font-mono">
          <span>LuậtGT</span>
          <span>/</span>
          <span className="text-navy font-sans font-medium">
            Lộ trình ôn thi 600 câu hỏi sát hạch
          </span>
        </div>
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h1 className="font-sans font-semibold text-2xl sm:text-3xl text-navy tracking-normal">
              Ôn thi lý thuyết theo chương
            </h1>
            <p className="text-muted text-sm mt-1">
              Phân loại 6 chương chuẩn Tổng cục Đường bộ Việt Nam kèm 60 câu
              điểm liệt bắt buộc
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Link
              to="/exam"
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold text-navy bg-surface border border-line hover:bg-bg transition-colors"
            >
              <span>Vào phòng thi thử</span>
              <svg
                className="w-3.5 h-3.5 text-accent-strong"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2"
                  d="M14 5l7 7m0 0l-7 7m7-7H3"
                />
              </svg>
            </Link>
          </div>
        </div>
      </div>

      {/* Main 2-Column Layout */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
        {/* Left Column: Chapters List (Col span 7 or 8) */}
        <div className="lg:col-span-7 xl:col-span-8 space-y-4">
          {/* Filter Pills */}
          <div className="flex items-center justify-between bg-surface p-3.5 rounded-2xl border border-line">
            <div className="flex items-center gap-1.5 overflow-x-auto text-xs">
              {[
                { key: "all", label: "Tất cả chương" },
                { key: "in_progress", label: "Đang học" },
                { key: "completed", label: "Đã hoàn thành" },
                { key: "not_started", label: "Chưa học" },
              ].map((item) => (
                <button
                  key={item.key}
                  onClick={() => setFilterStatus(item.key)}
                  className={`px-3 py-1.5 rounded-lg font-medium transition-colors whitespace-nowrap ${
                    filterStatus === item.key
                      ? "bg-navy text-white shadow-2xs"
                      : "text-text-secondary hover:bg-selected"
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </div>
            <span className="text-xs text-muted hidden sm:block shrink-0 pl-2">
              {filteredChapters.length} chương
            </span>
          </div>

          {/* Chapter Cards */}
          <div className="space-y-4">
            {filteredChapters.map((chapter) => {
              const pct = Math.round(
                (chapter.studiedQuestions / chapter.totalQuestions) * 100,
              );
              const remaining =
                chapter.totalQuestions - chapter.studiedQuestions;

              return (
                <div
                  key={chapter.id}
                  className="bg-surface rounded-2xl border border-line hover:border-accent/60 p-5 sm:p-6 shadow-2xs hover:shadow-xs transition-all flex flex-col justify-between"
                >
                  <div>
                    {/* Header: Title + Status Badge */}
                    <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3 mb-2">
                      <div>
                        <div className="flex items-center gap-2 mb-1">
                          <span className="px-2 py-0.5 rounded text-[11px] font-mono font-semibold bg-bg border border-line text-text-secondary">
                            Chương {chapter.id}
                          </span>
                          <span className="text-xs font-medium text-accent-strong">
                            {chapter.subtitle}
                          </span>
                        </div>
                        <h3 className="font-sans text-lg sm:text-[19px] font-semibold text-navy">
                          {chapter.title}
                        </h3>
                      </div>

                      {/* Status Tag */}
                      <div className="shrink-0">
                        {chapter.status === "completed" && (
                          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-[#ecfdf5] text-[#059669]">
                            <svg
                              className="w-3.5 h-3.5"
                              fill="none"
                              stroke="currentColor"
                              viewBox="0 0 24 24"
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth="2.5"
                                d="M5 13l4 4L19 7"
                              />
                            </svg>
                            Hoàn thành
                          </span>
                        )}
                        {chapter.status === "in_progress" && (
                          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-surface text-accent-strong">
                            <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse"></span>
                            Đang học ({pct}%)
                          </span>
                        )}
                        {chapter.status === "not_started" && (
                          <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-bg text-muted border border-line">
                            Chưa học
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Description */}
                    <p className="text-xs sm:text-sm text-text-secondary leading-relaxed mb-4">
                      {chapter.desc}
                    </p>

                    {/* Metrics row */}
                    <div className="flex flex-wrap items-center gap-4 text-xs text-muted py-2 border-y border-selected mb-4">
                      <span className="flex items-center gap-1.5">
                        <svg
                          className="w-4 h-4 text-muted"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth="2"
                            d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                          />
                        </svg>
                        Tổng:{" "}
                        <strong className="text-navy">
                          {chapter.totalQuestions} câu hỏi
                        </strong>
                      </span>
                      <span className="flex items-center gap-1.5 text-[#b91c1c]">
                        <svg
                          className="w-4 h-4 text-[#ef4444]"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth="2"
                            d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                          />
                        </svg>
                        Gồm{" "}
                        <strong className="text-[#b91c1c]">
                          {chapter.criticalQuestions} câu điểm liệt
                        </strong>
                      </span>
                      {chapter.status === "in_progress" && (
                        <span className="text-accent-strong font-medium">
                          Còn {remaining} câu chưa học
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Actions & Progress line */}
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-1">
                    <div className="text-xs text-muted">
                      {chapter.status === "completed" && (
                        <span className="text-[#059669] font-medium">
                          Đã ôn toàn bộ câu hỏi chương này
                        </span>
                      )}
                      {chapter.status === "in_progress" && (
                        <span>Học gần nhất: {chapter.lastStudiedDate}</span>
                      )}
                      {chapter.status === "not_started" && (
                        <span>Chưa ghi nhận lượt trả lời</span>
                      )}
                    </div>

                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => handleQuickAdvance(chapter.id)}
                        title="Mô phỏng trả lời đúng thêm 10 câu hỏi để cập nhật tiến độ"
                        className="px-3 py-2 rounded-xl text-xs font-medium text-text-secondary bg-bg hover:bg-selected border border-line transition-colors"
                      >
                        +10 câu ôn tập
                      </button>

                      {chapter.status === "not_started" ? (
                        <button
                          onClick={() => setActivePracticeModal(chapter)}
                          className="inline-flex items-center gap-1.5 px-5 py-2 rounded-xl text-xs font-semibold text-navy transition-all shadow-xs"
                          style={{ background: "var(--color-accent)" }}
                        >
                          <svg
                            className="w-3.5 h-3.5"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth="2.5"
                              d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"
                            />
                          </svg>
                          Bắt đầu học
                        </button>
                      ) : (
                        <button
                          onClick={() => setActivePracticeModal(chapter)}
                          className="inline-flex items-center gap-1.5 px-5 py-2 rounded-xl text-xs font-semibold text-white transition-all shadow-xs"
                          style={{ background: "var(--color-navy)" }}
                        >
                          <span>
                            {chapter.status === "completed"
                              ? "Ôn tập lại"
                              : "Tiếp tục học"}
                          </span>
                          <svg
                            className="w-3.5 h-3.5 text-progress"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth="2"
                              d="M9 5l7 7-7 7"
                            />
                          </svg>
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Right Column: Tiến độ của tôi (Sticky sidebar layout) */}
        <div className="lg:col-span-5 xl:col-span-4 sticky top-6 space-y-6">
          <div className="bg-surface rounded-2xl border border-line shadow-xs p-6 space-y-6">
            {/* Widget Title */}
            <div className="flex items-center justify-between border-b border-selected pb-4">
              <div className="flex items-center gap-2">
                <span className="w-3 h-3 rounded-full bg-accent"></span>
                <h2 className="font-sans text-lg font-bold text-navy">
                  Tiến độ của tôi
                </h2>
              </div>
              <span className="text-xs px-2.5 py-0.5 rounded-full bg-selected text-accent-strong font-medium font-mono">
                Hạng B
              </span>
            </div>

            {/* Overall Percentage Card */}
            <div className="bg-bg rounded-xl p-5 border border-line">
              <div className="flex items-baseline justify-between mb-2">
                <span className="text-xs font-semibold uppercase tracking-wider text-muted">
                  Tổng tiến độ hoàn thành
                </span>
                <span className="font-sans text-3xl font-bold text-navy">
                  {overallPercentage}%
                </span>
              </div>

              {/* Thanh progress màu xanh pastel */}
              <div className="w-full bg-line h-3.5 rounded-full overflow-hidden p-0.5">
                <div
                  className="h-full rounded-full bg-progress transition-all duration-500 ease-out"
                  style={{
                    width: `${overallPercentage}%`,
                  }}
                />
              </div>

              <div className="flex flex-wrap justify-between items-center gap-x-3 gap-y-1 text-xs text-muted mt-2.5">
                <span>
                  Đã học: <strong className="text-navy">{totalStudied}</strong>{" "}
                  / {totalAllQuestions} câu
                </span>
                <span>
                  Hoàn tất:{" "}
                  <strong className="text-navy">
                    {completedChaptersCount}
                  </strong>{" "}
                  / {chapters.length} chương
                </span>
              </div>
            </div>

            {/* Tiến độ từng chương */}
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
                  value={selectedProgressChapterId}
                  onChange={(event) =>
                    setSelectedProgressChapterId(Number(event.target.value))
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
                    {selectedProgressChapter.subtitle}
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
                      {selectedProgressChapter.studiedQuestions}
                    </strong>{" "}
                    / {selectedProgressChapter.totalQuestions} câu
                  </span>
                  <span>Còn {selectedProgressRemaining} câu</span>
                </div>
                <p className="text-[11px] text-muted leading-relaxed">
                  {selectedProgressChapter.status === "completed"
                    ? `Đã hoàn thành${selectedProgressChapter.completedDate ? ` ngày ${selectedProgressChapter.completedDate}` : ""}`
                    : selectedProgressChapter.lastStudiedDate
                      ? `Học gần nhất ${selectedProgressChapter.lastStudiedDate}`
                      : "Chưa bắt đầu học"}
                </p>
              </div>
            </div>

            {/* Quick Practice Suggestion */}
            <div className="bg-selected/70 rounded-xl p-4 border border-line space-y-2">
              <div className="flex items-center gap-2 text-xs font-semibold text-accent-strong">
                <svg
                  className="w-4 h-4"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="2"
                    d="M13 10V3L4 14h7v7l9-11h-7z"
                  />
                </svg>
                <span>Gợi ý học tập thông minh</span>
              </div>
              <p className="text-xs text-text-secondary leading-relaxed">
                Bạn đã hoàn thành Chương I xuất sắc. Hãy tập trung 12 câu điểm
                liệt của Chương II để đảm bảo không bị điểm liệt khi vào phòng
                thi thật!
              </p>
              <button
                onClick={() => {
                  const ch2 = chapters.find((c) => c.id === 2);
                  if (ch2) setActivePracticeModal(ch2);
                }}
                className="w-full mt-1 py-1.5 rounded-lg text-xs font-semibold text-navy text-center transition-colors shadow-2xs"
                style={{ background: "var(--color-accent)" }}
              >
                Ôn ngay câu điểm liệt Chương II
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Modal học tập chương mô phỏng câu hỏi */}
      {activePracticeModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-navy/40 backdrop-blur-xs">
          <div className="bg-bg w-full max-w-xl rounded-2xl border border-line shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150">
            <div className="flex items-center justify-between px-6 py-4 border-b border-line bg-surface">
              <div>
                <span className="text-[11px] font-mono font-bold text-accent-strong">
                  Chương {activePracticeModal.id} • Hạng B
                </span>
                <h3 className="font-sans text-lg font-semibold text-navy">
                  {activePracticeModal.title}
                </h3>
              </div>
              <button
                onClick={() => setActivePracticeModal(null)}
                className="p-1 rounded-lg text-muted hover:bg-selected hover:text-navy"
              >
                <svg
                  className="w-5 h-5"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="2"
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            </div>

            <div className="p-6 space-y-4">
              <div className="p-4 bg-surface rounded-xl border border-line space-y-2">
                <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-[#fee2e2] text-[#b91c1c]">
                  Câu hỏi điểm liệt mẫu
                </span>
                <p className="text-sm font-medium text-navy">
                  Hành vi điều khiển xe cơ giới chạy quá tốc độ quy định, giành
                  đường, vượt ẩu có bị nghiêm cấm hay không?
                </p>
                <div className="space-y-1.5 pt-2 text-xs">
                  <div className="p-2.5 rounded-lg border border-[#10b981] bg-[#ecfdf5] text-[#065f46] font-medium flex items-center justify-between">
                    <span>1. Bị nghiêm cấm hoàn toàn</span>
                    <span className="text-[11px] font-semibold">
                      &#10003; Đáp án đúng
                    </span>
                  </div>
                  <div className="p-2.5 rounded-lg border border-line bg-bg text-text-secondary">
                    <span>2. Bị nghiêm cấm tùy từng trường hợp</span>
                  </div>
                  <div className="p-2.5 rounded-lg border border-line bg-bg text-text-secondary">
                    <span>3. Không bị nghiêm cấm nếu đoạn đường vắng</span>
                  </div>
                </div>
              </div>

              <div className="p-3.5 bg-selected rounded-xl text-xs text-text-secondary flex items-center justify-between">
                <span>
                  Tiến độ chương này:{" "}
                  <strong>{activePracticeModal.studiedQuestions}</strong> /{" "}
                  {activePracticeModal.totalQuestions} câu
                </span>
                <span className="text-accent-strong font-semibold">
                  {Math.round(
                    (activePracticeModal.studiedQuestions /
                      activePracticeModal.totalQuestions) *
                      100,
                  )}
                  %
                </span>
              </div>
            </div>

            <div className="flex items-center justify-between px-6 py-3.5 bg-sidebar border-t border-line">
              <Link
                to="/chat"
                state={{
                  initialQuery: `Giải thích chi tiết các quy tắc giao thông trong ${activePracticeModal.title}`,
                }}
                className="text-xs text-navy hover:text-accent-strong font-medium"
              >
                Hỏi Chatbot KAG giải thích
              </Link>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    handleQuickAdvance(activePracticeModal.id);
                    setActivePracticeModal(null);
                  }}
                  className="px-4 py-2 rounded-xl text-xs font-semibold text-navy bg-accent hover:bg-accent-hover transition-colors shadow-2xs"
                >
                  Ghi nhận hoàn thành lượt học
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
