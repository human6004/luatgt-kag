import { Notice, useData } from "./server/shared";
import { useState, useMemo } from "react";
import { Link } from "react-router-dom";

interface PenaltyItem {
  id: string;
  vehicle: string;
  vehicleLabel: string;
  violation: string;
  keywords: string[];
  circumstance: string;
  fineRange: string;
  supplementary: string;
  licenseRevocation: string;
  demeritPoints?: string;
  legalBasis: string;
  clause: string;
  effectiveDate: string;
  notes?: string;
}

export default function PenaltySearchPage() {
  const data =
    useData<{ id: string; data: Record<string, unknown> }[]>("/penalties");
  const mockPenalties: PenaltyItem[] = (data.value || []).map((r) => {
    const d = r.data,
      v = String(d.vehicle || "");
    return {
      id: r.id,
      vehicle: v,
      vehicleLabel: v,
      violation: String(d.behavior || ""),
      keywords: [],
      circumstance: String(d.circumstance || "Chưa có thông tin"),
      fineRange: `${Number(d.minFine).toLocaleString("vi-VN")} – ${Number(d.maxFine).toLocaleString("vi-VN")} đồng`,
      supplementary: String(d.additional || "Chưa có thông tin"),
      licenseRevocation: String(d.licenseRevocation || "Chưa có thông tin"),
      demeritPoints:
        Number(d.points) > 0 ? `Trừ ${d.points} điểm` : "Không trừ điểm",
      legalBasis: String(d.doc_id || "Nguồn backend"),
      clause: String(d.unit_id || ""),
      effectiveDate: String(d.ngay_hieu_luc || "Chưa có thông tin"),
      notes: String(d.notes || ""),
    };
  });
  const [vehicle, setVehicle] = useState<string>("all");
  const [violationText, setViolationText] = useState<string>("");
  const [circumstanceFilter, setCircumstanceFilter] = useState<string>("all");
  const [hasSearched, setHasSearched] = useState<boolean>(true);
  const [selectedDetail, setSelectedDetail] = useState<PenaltyItem | null>(
    null,
  );

  const commonKeywords = [
    { label: "Vượt đèn đỏ", query: "đèn đỏ" },
    { label: "Nồng độ cồn", query: "nồng độ cồn" },
    { label: "Quá tốc độ", query: "tốc độ" },
    { label: "Mũ bảo hiểm", query: "mũ bảo hiểm" },
    { label: "Ngược chiều", query: "ngược chiều" },
    { label: "Cao tốc", query: "cao tốc" },
  ];

  const filteredResults = useMemo(() => {
    if (!hasSearched) return [];
    return mockPenalties.filter((item) => {
      if (vehicle !== "all" && item.vehicle !== vehicle) {
        return false;
      }
      if (
        circumstanceFilter === "has_revocation" &&
        (!item.licenseRevocation || /Không|Chưa/.test(item.licenseRevocation))
      ) {
        return false;
      }
      if (
        circumstanceFilter === "has_demerit" &&
        (!item.demeritPoints || item.demeritPoints.includes("Không"))
      ) {
        return false;
      }
      if (violationText.trim() === "") return true;

      const query = violationText.toLowerCase().trim();
      const matchText = (
        item.violation +
        " " +
        item.circumstance +
        " " +
        item.legalBasis +
        " " +
        item.keywords.join(" ")
      ).toLowerCase();
      return matchText.includes(query);
    });
  }, [vehicle, violationText, circumstanceFilter, hasSearched, data.value]);

  const handleSearch = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    setHasSearched(true);
  };

  const handleReset = () => {
    setVehicle("all");
    setViolationText("");
    setCircumstanceFilter("all");
    setHasSearched(true);
  };

  return (
    <div className="min-h-full pb-16 px-6 sm:px-8 max-w-7xl mx-auto pt-6">
      <Notice {...data} retry={data.reload} />
      {/* Top Breadcrumb & Header */}
      <div className="mb-6">
        <div className="flex items-center gap-2 text-xs text-muted mb-2 font-mono">
          <span>LuậtGT</span>
          <span>/</span>
          <span className="text-navy font-sans font-medium">
            Hệ thống tra cứu mức xử phạt
          </span>
        </div>
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h1 className="font-sans font-semibold text-2xl sm:text-3xl text-navy tracking-normal">
              Tra cứu mức phạt vi phạm giao thông
            </h1>
            <p className="text-muted text-sm mt-1">
              Mức phạt theo dữ liệu được backend kiểm duyệt và xuất bản
            </p>
          </div>
          <div className="inline-flex items-center gap-2 self-start px-3 py-1.5 rounded-full text-xs font-medium bg-selected text-accent-strong border border-line">
            <span className="w-2 h-2 rounded-full bg-accent animate-pulse"></span>
            Nguồn backend
          </div>
        </div>
      </div>

      {/* Main Search Form Card */}
      <div className="bg-surface rounded-2xl border border-line shadow-xs p-6 mb-8">
        <form onSubmit={handleSearch} className="space-y-5">
          <div className="grid grid-cols-1 md:grid-cols-12 gap-4">
            {/* 1. Loại phương tiện */}
            <div className="md:col-span-3">
              <label className="block text-xs font-semibold uppercase tracking-wider text-muted mb-1.5">
                1. Loại phương tiện
              </label>
              <div className="relative">
                <select
                  value={vehicle}
                  onChange={(e) => setVehicle(e.target.value)}
                  className="w-full bg-bg border border-line rounded-xl px-3.5 py-2.5 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent appearance-none cursor-pointer transition-all"
                >
                  <option value="all">Tất cả phương tiện</option>
                  {[...new Set(mockPenalties.map((p) => p.vehicle))].map(
                    (v) => (
                      <option key={v} value={v}>
                        {v}
                      </option>
                    ),
                  )}
                </select>
                <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-3 text-muted">
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
                      d="M19 9l-7 7-7-7"
                    />
                  </svg>
                </div>
              </div>
            </div>

            {/* 2. Hành vi vi phạm */}
            <div className="md:col-span-6">
              <label className="block text-xs font-semibold uppercase tracking-wider text-muted mb-1.5">
                2. Hành vi vi phạm (từ khóa hoặc mô tả)
              </label>
              <div className="relative">
                <input
                  type="text"
                  value={violationText}
                  onChange={(e) => setViolationText(e.target.value)}
                  placeholder="Ví dụ: vượt đèn đỏ, nồng độ cồn, không đội nón, chạy quá tốc độ..."
                  className="w-full bg-bg border border-line rounded-xl pl-10 pr-4 py-2.5 text-sm text-navy placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent transition-all"
                />
                <div className="absolute inset-y-0 left-0 flex items-center pl-3.5 pointer-events-none text-muted">
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
                      d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                    />
                  </svg>
                </div>
                {violationText && (
                  <button
                    type="button"
                    onClick={() => setViolationText("")}
                    className="absolute inset-y-0 right-0 pr-3 flex items-center text-muted hover:text-navy"
                  >
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
                        d="M6 18L18 6M6 6l12 12"
                      />
                    </svg>
                  </button>
                )}
              </div>
            </div>

            {/* 3. Tình tiết liên quan */}
            <div className="md:col-span-3">
              <label className="block text-xs font-semibold uppercase tracking-wider text-muted mb-1.5">
                3. Tình tiết liên quan
              </label>
              <div className="relative">
                <select
                  value={circumstanceFilter}
                  onChange={(e) => setCircumstanceFilter(e.target.value)}
                  className="w-full bg-bg border border-line rounded-xl px-3.5 py-2.5 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent appearance-none cursor-pointer transition-all"
                >
                  <option value="all">Mọi tình tiết</option>
                  <option value="has_revocation">
                    Có tước giấy phép lái xe
                  </option>
                  <option value="has_demerit">Có cơ chế trừ điểm GPLX</option>
                </select>
                <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-3 text-muted">
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
                      d="M19 9l-7 7-7-7"
                    />
                  </svg>
                </div>
              </div>
            </div>
          </div>

          {/* Quick tags suggestion & Action buttons */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pt-1 border-t border-selected">
            <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
              <span className="font-medium text-navy">Từ khóa phổ biến:</span>
              {commonKeywords.map((kw) => (
                <button
                  key={kw.query}
                  type="button"
                  onClick={() => {
                    setViolationText(kw.query);
                    setHasSearched(true);
                  }}
                  className={`px-2.5 py-1 rounded-md transition-colors ${
                    violationText.includes(kw.query)
                      ? "bg-navy text-white shadow-2xs"
                      : "bg-bg hover:bg-selected text-text-secondary border border-line"
                  }`}
                >
                  {kw.label}
                </button>
              ))}
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={handleReset}
                className="px-4 py-2 rounded-xl text-xs font-medium text-text-secondary hover:bg-selected transition-colors"
              >
                Đặt lại
              </button>
              <button
                type="submit"
                className="inline-flex items-center gap-2 px-6 py-2.5 rounded-xl text-xs font-semibold text-navy shadow-xs hover:opacity-95 active:scale-[0.98] transition-all"
                style={{ background: "var(--color-accent)" }}
              >
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
                    d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                  />
                </svg>
                Tra cứu ngay
              </button>
            </div>
          </div>
        </form>
      </div>

      {/* Results Header */}
      <div className="flex items-center justify-between mb-4 px-1">
        <div className="flex items-center gap-2">
          <span className="font-medium text-sm text-navy">Kết quả tra cứu</span>
          <span className="px-2 py-0.5 rounded-full text-xs font-mono bg-line text-navy font-semibold">
            {filteredResults.length} hành vi
          </span>
        </div>
        <p className="text-xs text-muted hidden sm:block">
          Click &quot;Xem chi tiết&quot; để tra cứu toàn văn căn cứ pháp lý &
          đối thoại với AI
        </p>
      </div>

      {/* Results List */}
      {filteredResults.length === 0 ? (
        <div className="bg-surface rounded-2xl border border-dashed border-line p-12 text-center">
          <div className="w-12 h-12 rounded-full bg-selected text-accent-strong flex items-center justify-center mx-auto mb-3">
            <svg
              className="w-6 h-6"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2"
                d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
          </div>
          <h3 className="font-sans font-semibold text-lg text-navy mb-1">
            Không tìm thấy mức phạt phù hợp
          </h3>
          <p className="text-sm text-muted max-w-md mx-auto mb-4">
            Hãy thử tìm bằng từ khóa ngắn hơn (ví dụ: &ldquo;cồn&rdquo;,
            &ldquo;đèn đỏ&rdquo;, &ldquo;tốc độ&rdquo;) hoặc chọn loại phương
            tiện khác.
          </p>
          <button
            onClick={handleReset}
            className="px-4 py-2 rounded-xl text-xs font-semibold text-white bg-navy hover:bg-navy-light"
          >
            Xóa bộ lọc tìm kiếm
          </button>
        </div>
      ) : (
        <div className="space-y-4">
          {filteredResults.map((item) => (
            <div
              key={item.id}
              className="bg-surface rounded-2xl border border-line hover:border-accent/50 shadow-2xs hover:shadow-sm transition-all overflow-hidden"
            >
              <div className="p-5 sm:p-6">
                <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-4 mb-4">
                  <div className="space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="px-2.5 py-0.5 rounded-md text-[11px] font-medium bg-selected text-text-secondary">
                        {item.vehicleLabel}
                      </span>
                      {item.demeritPoints &&
                        !item.demeritPoints.includes("Không") && (
                          <span className="px-2.5 py-0.5 rounded-md text-[11px] font-medium bg-[#fee2e2] text-[#b91c1c]">
                            {item.demeritPoints}
                          </span>
                        )}
                    </div>
                    <h3 className="font-sans font-semibold text-lg sm:text-[19px] text-navy leading-snug">
                      {item.violation}
                    </h3>
                    <p className="text-xs sm:text-sm text-muted leading-relaxed">
                      <span className="font-medium text-text-secondary">
                        Tình tiết vi phạm:
                      </span>{" "}
                      {item.circumstance}
                    </p>
                  </div>

                  {/* Highlight Fine Box */}
                  <div className="lg:text-right shrink-0 bg-bg lg:bg-transparent p-3 lg:p-0 rounded-xl border lg:border-0 border-line">
                    <span className="block text-[11px] uppercase tracking-wider text-muted font-medium mb-0.5">
                      Mức phạt tiền
                    </span>
                    <span className="text-lg sm:text-xl font-bold text-accent-strong font-sans">
                      {item.fineRange}
                    </span>
                  </div>
                </div>

                {/* Spec Badges Grid */}
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-4 border-t border-selected">
                  {/* Hình thức bổ sung */}
                  <div className="bg-bg rounded-xl p-3 border border-line">
                    <span className="block text-[11px] uppercase tracking-wider text-muted mb-1">
                      Hình thức xử phạt bổ sung
                    </span>
                    <p className="text-xs font-medium text-navy leading-relaxed">
                      {item.supplementary}
                    </p>
                  </div>

                  {/* Tước GPLX */}
                  <div className="bg-bg rounded-xl p-3 border border-line">
                    <span className="block text-[11px] uppercase tracking-wider text-muted mb-1">
                      Thời gian tước GPLX
                    </span>
                    <p className="text-xs font-medium text-navy leading-relaxed">
                      {item.licenseRevocation}
                    </p>
                  </div>

                  {/* Căn cứ pháp lý */}
                  <div className="bg-bg rounded-xl p-3 border border-line flex flex-col justify-between">
                    <div>
                      <span className="block text-[11px] uppercase tracking-wider text-muted mb-1">
                        Căn cứ pháp lý
                      </span>
                      <p className="text-xs font-medium text-navy leading-relaxed">
                        {item.clause}
                      </p>
                    </div>
                    <span className="text-[10px] text-muted mt-1 font-mono">
                      {item.legalBasis}
                    </span>
                  </div>
                </div>

                {/* Footer Action */}
                <div className="mt-4 pt-3 flex items-center justify-between">
                  <div className="flex items-center gap-2 text-xs text-muted">
                    <svg
                      className="w-3.5 h-3.5 text-[#10b981]"
                      fill="currentColor"
                      viewBox="0 0 20 20"
                    >
                      <path
                        fillRule="evenodd"
                        d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
                        clipRule="evenodd"
                      />
                    </svg>
                    <span>Hiệu lực từ: {item.effectiveDate}</span>
                  </div>

                  <div className="flex items-center gap-3">
                    <Link
                      to="/chat"
                      state={{
                        initialQuery: `Hỏi về mức phạt lỗi: ${item.violation} (${item.vehicleLabel})`,
                      }}
                      className="text-xs text-muted hover:text-accent-strong font-medium hidden sm:inline-flex items-center gap-1"
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
                          strokeWidth="2"
                          d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
                        />
                      </svg>
                      Hỏi trợ lý AI
                    </Link>
                    <button
                      type="button"
                      onClick={() => setSelectedDetail(item)}
                      className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-semibold bg-bg hover:bg-selected text-navy border border-line transition-colors"
                    >
                      <span>Xem chi tiết</span>
                      <svg
                        className="w-3.5 h-3.5"
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
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Modal Xem chi tiết căn cứ pháp lý */}
      {selectedDetail && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-navy/40 backdrop-blur-xs">
          <div className="bg-bg w-full max-w-2xl rounded-2xl border border-line shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150">
            {/* Modal Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-line bg-surface">
              <div className="flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full bg-accent"></span>
                <h3 className="font-sans text-lg font-semibold text-navy">
                  Chi tiết khung hình phạt & Trích lục pháp lý
                </h3>
              </div>
              <button
                onClick={() => setSelectedDetail(null)}
                className="p-1 rounded-lg text-muted hover:bg-selected hover:text-navy transition-colors"
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

            {/* Modal Content */}
            <div className="p-6 max-h-[75vh] overflow-y-auto space-y-5">
              <div>
                <span className="text-xs uppercase tracking-wider text-muted font-semibold">
                  Hành vi áp dụng
                </span>
                <h4 className="font-sans font-semibold text-xl text-navy mt-1">
                  {selectedDetail.violation}
                </h4>
                <p className="text-xs text-text-secondary mt-1 bg-surface p-3 rounded-xl border border-line">
                  <strong className="text-navy">Phương tiện:</strong>{" "}
                  {selectedDetail.vehicleLabel} — {selectedDetail.circumstance}
                </p>
              </div>

              {/* 3 Metric Cards */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="bg-surface p-3.5 rounded-xl border border-line">
                  <span className="text-[11px] text-muted uppercase">
                    Tiền phạt
                  </span>
                  <p className="text-base font-bold text-accent-strong mt-0.5">
                    {selectedDetail.fineRange}
                  </p>
                </div>
                <div className="bg-surface p-3.5 rounded-xl border border-line">
                  <span className="text-[11px] text-muted uppercase">
                    Tước bằng lái
                  </span>
                  <p className="text-sm font-semibold text-navy mt-0.5">
                    {selectedDetail.licenseRevocation}
                  </p>
                </div>
                <div className="bg-surface p-3.5 rounded-xl border border-line">
                  <span className="text-[11px] text-muted uppercase">
                    Trừ điểm GPLX
                  </span>
                  <p className="text-sm font-semibold text-navy mt-0.5">
                    {selectedDetail.demeritPoints || "Không trừ"}
                  </p>
                </div>
              </div>

              {/* Legal Box */}
              <div className="bg-surface rounded-xl p-4 border border-line space-y-2">
                <div className="flex items-center justify-between text-xs font-semibold text-navy border-b border-selected pb-2">
                  <span className="flex items-center gap-1.5 text-accent-strong">
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
                        d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253"
                      />
                    </svg>
                    Căn cứ pháp lý chính thức
                  </span>
                  <span className="font-mono text-muted">
                    {selectedDetail.clause}
                  </span>
                </div>
                <p className="text-sm text-text-secondary leading-relaxed pt-1">
                  Quy định chi tiết tại{" "}
                  <strong className="text-navy">
                    {selectedDetail.legalBasis}
                  </strong>{" "}
                  ({selectedDetail.clause}). Có hiệu lực từ{" "}
                  {selectedDetail.effectiveDate}.
                </p>
                {selectedDetail.notes && (
                  <div className="p-3 bg-bg rounded-lg text-xs text-text-secondary border border-line mt-2">
                    <strong className="text-navy">Lưu ý thực tế: </strong>
                    {selectedDetail.notes}
                  </div>
                )}
              </div>
            </div>

            {/* Modal Footer */}
            <div className="flex items-center justify-end gap-3 px-6 py-3.5 bg-sidebar border-t border-line">
              <Link
                to="/chat"
                state={{
                  initialQuery: `Giải thích chi tiết về quy định: ${selectedDetail.violation} theo ${selectedDetail.legalBasis}`,
                }}
                className="px-4 py-2 rounded-xl text-xs font-semibold text-white bg-navy hover:bg-navy-light transition-colors"
              >
                Hỏi Chatbot KAG về điều này
              </Link>
              <button
                type="button"
                onClick={() => setSelectedDetail(null)}
                className="px-4 py-2 rounded-xl text-xs font-medium text-text-secondary bg-surface border border-line hover:bg-bg transition-colors"
              >
                Đóng
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
