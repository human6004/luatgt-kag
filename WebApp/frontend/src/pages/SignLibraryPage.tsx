import { type ContentRecord } from "../api";
import { inputCls } from "../admin/ui";
import { Asset, Notice, useData } from "./shared/shared";
import { useEffect, useState, useMemo } from "react";
import { Link, useSearchParams } from "react-router-dom";

export type SignCategory = string;

export interface SignItem {
  id: string;
  code: string;
  name: string;
  category: SignCategory;
  categoryLabel: string;
  shortDesc: string;
  meaning: string;
  hasImage: boolean;
  source?: Record<string, unknown>;
}

function isChildOf(sign: SignItem, parent: SignItem) {
  if (sign.id === parent.id || sign.source?.qcvn !== parent.source?.qcvn) return false;
  const codes = parent.source?.children_codes;
  return (
    sign.source?.parent_code === parent.code || (Array.isArray(codes) && codes.includes(sign.code))
  );
}

export default function SignLibraryPage() {
  const [params, setParams] = useSearchParams();
  const data = useData<ContentRecord[]>("/signs");

  const signs: SignItem[] = useMemo(
    () =>
      (data.value || []).map((r) => ({
        id: r.id,
        code: String(r.data.code || r.externalId || ""),
        name: String(r.data.name || ""),
        category: String(r.data.group || ""),
        categoryLabel: String(r.data.group || ""),
        shortDesc: String(r.data.meaning || ""),
        meaning: String(r.data.meaning || ""),
        hasImage:
          r.data.image_status === "verified" && Boolean(r.data.imageKey || r.data.hasDatasetImage),
        source: r.data,
      })),
    [data.value],
  );

  const categories = [
    { key: "all", label: "Tất cả nhóm biển" },
    ...Array.from(new Set(signs.map((s) => s.category).filter(Boolean))).map((v) => ({
      key: v,
      label: v,
    })),
  ];

  const urlQ = params.get("q") ?? "";
  const [searchQuery, setSearchQuery] = useState(urlQ);
  const activeCategory: SignCategory = params.get("cat") ?? "all";
  const signParam = params.get("sign") ?? "";
  const selectedSign = signParam
    ? (signs.find((s) => s.code === signParam || s.id === signParam) ?? null)
    : null;
  const selectedChildren = selectedSign
    ? signs.filter((sign) => isChildOf(sign, selectedSign))
    : [];

  useEffect(() => {
    setSearchQuery(urlQ);
  }, [urlQ]);

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

  const filteredSigns = useMemo(() => {
    const query = searchQuery.toLowerCase().trim();
    const matchingParents = query ? signs.filter((sign) => sign.code.toLowerCase() === query) : [];
    const matchingSigns = signs.filter((sign) => {
      if (activeCategory !== "all" && sign.category !== activeCategory) {
        return false;
      }
      if (!query) return true;
      const searchTarget = (
        sign.code +
        " " +
        sign.name +
        " " +
        sign.shortDesc +
        " " +
        sign.meaning
      ).toLowerCase();
      return (
        searchTarget.includes(query) ||
        String(sign.source?.parent_code ?? "").toLowerCase() === query ||
        matchingParents.some((parent) => isChildOf(sign, parent))
      );
    });
    return signs.filter(
      (sign) =>
        !signs.some((parent) => isChildOf(sign, parent)) &&
        (matchingSigns.includes(sign) || matchingSigns.some((child) => isChildOf(child, sign))),
    );
  }, [searchQuery, activeCategory, signs]);

  return (
    <div className="min-h-full pb-16 px-6 sm:px-8 max-w-7xl mx-auto pt-6">
      <Notice {...data} retry={data.reload} />
      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center gap-2 text-xs text-muted mb-2 font-mono">
          <span>LuậtGT</span>
          <span>/</span>
          <span className="text-navy font-sans font-medium">Hệ thống biển báo hiệu đường bộ</span>
        </div>
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h1 className="font-sans font-semibold text-2xl sm:text-3xl text-navy tracking-normal">
              Thư viện biển báo giao thông Việt Nam
            </h1>
          </div>
        </div>
      </div>

      {/* Search & Category Filter */}
      <div className="mb-6 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 md:grid-cols-[minmax(0,1fr)_minmax(12rem,18rem)_auto]">
        <div className="relative col-span-2 md:col-span-1">
          <input
            type="text"
            aria-label="Tìm biển báo"
            value={searchQuery}
            onChange={(e) => {
              const v = e.target.value;
              setSearchQuery(v);
              updateUrl({ q: v || null }, true);
            }}
            placeholder="Tìm biển báo, mã, nội dung…"
            className={`${inputCls} pr-10`}
          />
          {searchQuery && (
            <button
              type="button"
              aria-label="Xóa từ khóa tìm biển báo"
              onClick={() => {
                setSearchQuery("");
                updateUrl({ q: null }, true);
              }}
              className="absolute inset-y-0 right-0 flex w-10 items-center justify-center rounded-r-md text-muted hover:text-navy focus-visible:outline-2 focus-visible:outline-accent-strong"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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

        <select
          aria-label="Phân loại biển báo"
          value={activeCategory}
          onChange={(event) =>
            updateUrl({
              cat: event.target.value === "all" ? null : event.target.value,
              sign: null,
            })
          }
          className={inputCls}
        >
          {categories.map((category) => (
            <option key={category.key} value={category.key}>
              {category.label}
            </option>
          ))}
        </select>
        <span
          role="status"
          aria-label={`${data.value ? filteredSigns.length : "—"} biển báo`}
          className="shrink-0 text-sm tabular-nums text-muted"
        >
          {data.value ? filteredSigns.length : "—"}
        </span>
      </div>

      {/* Grid of Signs */}
      {filteredSigns.length === 0 ? (
        !data.loading && !data.error && (
          <div className="bg-surface rounded-2xl border border-dashed border-line p-12 text-center">
            <p className="font-sans text-lg text-navy">Không tìm thấy biển báo nào</p>
            <p className="text-sm text-muted mt-1">Vui lòng thử tìm kiếm với từ khóa khác.</p>
          </div>
        )
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-4">
          {filteredSigns.map((sign) => {
            const children = signs.filter((child) => isChildOf(child, sign));
            return (
              <div
                key={sign.id}
                onClick={() => updateUrl({ sign: sign.id })}
                className="min-w-0 break-words bg-surface rounded-lg border border-line hover:border-accent p-5 cursor-pointer transition-colors group flex flex-col justify-between"
              >
                <div>
                  {children.length > 0 ? (
                    <ul className="mb-4 grid grid-cols-2 gap-3">
                      {children.map((child) => (
                        <li key={child.id} className="min-w-0">
                          <button
                            type="button"
                            aria-label={`Xem chi tiết ${child.code} · ${child.name}`}
                            className="flex w-full flex-col items-center gap-2 rounded-md p-2 text-xs text-navy hover:bg-hover focus-visible:outline-2 focus-visible:outline-accent-strong"
                            onClick={(event) => {
                              event.stopPropagation();
                              updateUrl({ sign: child.id });
                            }}
                          >
                            <span className="flex h-28 w-full items-center justify-center">
                              {child.hasImage ? (
                                <Asset
                                  id={child.id}
                                  alt={child.name}
                                  className="h-full w-full object-contain"
                                />
                              ) : (
                                <span className="text-muted">Chưa có ảnh nguồn</span>
                              )}
                            </span>
                            <span className="font-medium">{child.code}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <div className="h-40 w-full max-w-60 mx-auto mb-4 flex items-center justify-center">
                      {sign.hasImage ? (
                        <Asset id={sign.id} alt={sign.name} className="h-full w-full object-contain" />
                      ) : (
                        <p className="text-center text-xs text-muted">
                          {sign.source?.record_type === "family" ? "Nhóm biển" : "Chưa có ảnh nguồn"}
                        </p>
                      )}
                    </div>
                  )}

                  <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                    <span className="px-2 py-0.5 rounded-md text-[11px] font-mono font-semibold bg-navy text-white">
                      {sign.code}
                    </span>
                    <span className="text-[11px] font-medium text-muted">{sign.categoryLabel}</span>
                  </div>

                  <h3 className="font-sans text-[17px] font-semibold text-navy group-hover:text-accent-strong transition-colors leading-snug mb-2">
                    {sign.name}
                  </h3>

                  <p className="text-xs text-muted line-clamp-2 leading-relaxed">{sign.shortDesc}</p>
                </div>

                <div className="mt-4 pt-3 border-t border-selected flex flex-wrap items-center justify-between gap-2 text-[11px] leading-5 text-muted">
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      updateUrl({ sign: sign.id });
                    }}
                    className="text-accent-strong font-medium inline-flex items-center gap-0.5 focus-visible:outline-2 focus-visible:outline-accent-strong"
                  >
                    Xem chi tiết &rarr;
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Modal Chi tiết Biển Báo */}
      {selectedSign && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-navy/40"
          onClick={(event) => {
            if (event.target === event.currentTarget) updateUrl({ sign: null });
          }}
        >
          <div className="bg-surface w-full max-w-3xl rounded-xl border border-line shadow-md overflow-hidden">
            <div className="flex items-start justify-between gap-3 px-6 py-4 border-b border-line bg-surface">
              <div className="min-w-0 flex flex-wrap items-center gap-3">
                <span className="px-2.5 py-1 rounded-lg text-xs font-mono font-bold bg-navy text-white">
                  {selectedSign.code}
                </span>
                <div className="min-w-0">
                  <h3 className="break-words font-sans text-lg font-semibold text-navy">
                    {selectedSign.name}
                  </h3>
                  <p className="text-[11px] text-muted">
                    {selectedSign.categoryLabel}
                  </p>
                </div>
              </div>
              <button
                type="button"
                aria-label="Đóng chi tiết biển báo"
                onClick={() => updateUrl({ sign: null })}
                className="shrink-0 p-1 rounded-lg text-muted hover:bg-selected hover:text-navy transition-colors"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="2"
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            </div>

            <div className="p-6 max-h-[75vh] overflow-y-auto space-y-6">
              <div className="flex flex-col sm:flex-row gap-5 items-start">
                {selectedSign.hasImage && (
                  <div className="h-48 w-full max-w-72 shrink-0 mx-auto sm:mx-0 sm:h-56 sm:w-56 lg:h-64 lg:w-64 flex items-center justify-center">
                    <Asset
                      id={selectedSign.id}
                      alt={selectedSign.name}
                      className="h-full w-full object-contain"
                    />
                  </div>
                )}
                <div className="min-w-0 flex-1 space-y-2">
                  <h4 className="text-xs uppercase tracking-wider font-semibold text-muted">
                    Ý nghĩa biển báo
                  </h4>
                  <p className="text-sm text-navy leading-relaxed">{selectedSign.meaning}</p>
                  {!selectedSign.hasImage && selectedSign.source?.record_type !== "family" && (
                    <p className="text-xs text-muted">Chưa có ảnh nguồn</p>
                  )}
                </div>
              </div>

              {selectedChildren.length > 0 && (
                <section className="border-t border-line pt-5">
                  <h4 className="text-sm font-semibold text-navy">Biển con liên quan</h4>
                  <ul className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
                    {selectedChildren.map((child) => (
                      <li key={child.id}>
                        <button
                          type="button"
                          className="flex h-full w-full flex-col items-center gap-3 rounded-xl p-3 text-center text-sm text-navy transition-colors hover:bg-sidebar focus-visible:outline-2 focus-visible:outline-accent-strong"
                          onClick={() => updateUrl({ sign: child.id })}
                        >
                          <span className="flex h-40 w-full items-center justify-center">
                            {child.hasImage ? (
                              <Asset
                                id={child.id}
                                alt={child.name}
                                className="h-full w-full object-contain"
                              />
                            ) : (
                              <span className="text-xs text-muted">Chưa có ảnh nguồn</span>
                            )}
                          </span>
                          <span className="font-semibold">{child.code}</span>
                          <span>{child.name}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 px-6 py-3.5 bg-surface border-t border-line">
              <Link
                to="/chat"
                state={{
                  initialQuery: `Giải thích chi tiết quy chuẩn và tình huống thực tế của biển báo ${selectedSign.code} (${selectedSign.name})`,
                }}
                className="text-xs text-navy hover:text-accent-strong font-medium inline-flex items-center gap-1.5"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="2"
                    d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
                  />
                </svg>
                Hỏi trợ lý KAG về biển này
              </Link>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
