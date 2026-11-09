import { type ContentRecord } from '../api'
import { FilterTabs } from '../admin/ui'
import { Asset, Notice, useData } from './shared/shared'
import { useEffect, useState, useMemo } from 'react'
import { Link, useSearchParams } from 'react-router-dom'

export type SignCategory = string;

export interface SignItem {
  id: string;
  code: string;
  name: string;
  category: SignCategory;
  categoryLabel: string;
  shortDesc: string;
  meaning: string;
  applicableCases: string;
  relatedViolations: {
    title: string
    fineRange: string
    demerit?: string
    clause: string
  }[]
  hasImage: boolean
  source?: Record<string, unknown>
}

export default function SignLibraryPage() {
  const [params, setParams] = useSearchParams()
  const data = useData<ContentRecord[]>('/signs')

  const signs: SignItem[] = useMemo(
    () =>
      (data.value || []).map((r) => ({
        id: r.id,
        code: String(r.data.code || r.externalId || ''),
        name: String(r.data.name || ''),
        category: String(r.data.group || ''),
        categoryLabel: String(r.data.group || ''),
        shortDesc: String(r.data.meaning || ''),
        meaning: String(r.data.meaning || ''),
        applicableCases: String(r.data.applicableCases || 'Chưa có thông tin từ backend'),
        relatedViolations: [],
        hasImage: r.data.image_status === 'verified' && Boolean(r.data.imageKey || r.data.hasDatasetImage),
        source: r.data,
      })),
    [data.value],
  )

  const categories = [
    { key: 'all', label: 'Tất cả' },
    ...Array.from(new Set(signs.map((s) => s.category).filter(Boolean))).map((v) => ({ key: v, label: v })),
  ]

  const urlQ = params.get('q') ?? ''
  const [searchQuery, setSearchQuery] = useState(urlQ)
  const activeCategory: SignCategory = params.get('cat') ?? 'all'
  const signParam = params.get('sign') ?? ''
  const selectedSign = signParam ? signs.find((s) => s.code === signParam || s.id === signParam) ?? null : null

  useEffect(() => {
    setSearchQuery(urlQ)
  }, [urlQ])

  function updateUrl(patch: Record<string, string | null>, replace = false) {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        for (const [k, v] of Object.entries(patch)) {
          if (v === null || v === '') next.delete(k)
          else next.set(k, v)
        }
        return next
      },
      { replace },
    )
  }

  const filteredSigns = useMemo(() => {
    return signs.filter((sign) => {
      if (activeCategory !== 'all' && sign.category !== activeCategory) {
        return false
      }
      if (!searchQuery.trim()) return true
      const query = searchQuery.toLowerCase().trim()
      const searchTarget = (sign.code + ' ' + sign.name + ' ' + sign.shortDesc + ' ' + sign.meaning).toLowerCase()
      return searchTarget.includes(query)
    })
  }, [searchQuery, activeCategory, signs])

  return (
    <div className="min-h-full pb-16 px-6 sm:px-8 max-w-7xl mx-auto pt-6">
      <Notice {...data} retry={data.reload} />
      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center gap-2 text-xs text-muted mb-2 font-mono">
          <span>LuậtGT</span>
          <span>/</span>
          <span className="text-navy font-sans font-medium">
            Hệ thống biển báo hiệu đường bộ
          </span>
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
      <div className="bg-surface rounded-2xl border border-line shadow-xs p-5 mb-8 space-y-4">
        <div className="relative">
          <input
            type="text"
            aria-label="Tìm biển báo"
            value={searchQuery}
            onChange={(e) => {
              const v = e.target.value
              setSearchQuery(v)
              updateUrl({ q: v || null }, true)
            }}
            placeholder="Tìm theo mã biển (VD: P.102, W.201, R.301) hoặc tên biển báo..."
            className="w-full bg-bg border border-line rounded-xl pl-10 pr-4 py-3 text-sm text-navy placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent transition-all"
          />
          <div className="absolute inset-y-0 left-0 flex items-center pl-3.5 pointer-events-none text-muted">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          </div>
          {searchQuery && (
            <button
              type="button"
              onClick={() => {
                setSearchQuery('')
                updateUrl({ q: null }, true)
              }}
              className="absolute inset-y-0 right-0 pr-3 flex items-center text-muted hover:text-navy"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>

        <FilterTabs
          label="Phân loại biển báo"
          value={activeCategory}
          onChange={(key) => updateUrl({ cat: key === 'all' ? null : key, sign: null })}
          items={categories.map((category) => ({ value: category.key, label: category.label }))}
        />
      </div>

      {/* Grid of Signs */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2 px-1">
        <span className="text-sm font-medium text-navy">
          Hiển thị <span className="font-mono text-accent-strong font-semibold">{data.value ? filteredSigns.length : '—'}</span> biển báo
        </span>
      </div>

      {filteredSigns.length === 0 ? (
        <div className="bg-surface rounded-2xl border border-dashed border-line p-12 text-center">
          <p className="font-sans text-lg text-navy">
            Không tìm thấy biển báo nào
          </p>
          <p className="text-sm text-muted mt-1">
            Vui lòng thử tìm kiếm với từ khóa khác.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-4">
          {filteredSigns.map((sign) => (
            <div
              key={sign.id}
              onClick={() => updateUrl({ sign: sign.code || sign.id })}
              className="min-w-0 break-words bg-surface rounded-2xl border border-line hover:border-accent p-5 cursor-pointer shadow-2xs hover:shadow-md transition-all group flex flex-col justify-between"
            >
              <div>
                <div className="w-24 h-24 mx-auto mb-4 p-2 bg-bg rounded-xl border border-selected flex items-center justify-center group-hover:scale-105 transition-transform">
                  {sign.hasImage ? (
                    <Asset id={sign.id} alt={sign.name} className="h-full w-full object-contain" />
                  ) : (
                    <p className="text-center text-xs text-muted">Chưa có ảnh nguồn</p>
                  )}
                </div>

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
                <span className="text-accent-strong font-semibold group-hover:translate-x-0.5 transition-transform inline-flex items-center gap-0.5">
                  Xem chi tiết &rarr;
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Modal Chi tiết Biển Báo */}
      {selectedSign && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-navy/40 backdrop-blur-xs">
          <div className="bg-bg w-full max-w-2xl rounded-2xl border border-line shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150">
            <div className="flex items-start justify-between gap-3 px-6 py-4 border-b border-line bg-surface">
              <div className="min-w-0 flex flex-wrap items-center gap-3">
                <span className="px-2.5 py-1 rounded-lg text-xs font-mono font-bold bg-navy text-white">
                  {selectedSign.code}
                </span>
                <div className="min-w-0">
                  <h3 className="break-words font-sans text-lg font-semibold text-navy">{selectedSign.name}</h3>
                  <p className="text-[11px] text-muted">{selectedSign.categoryLabel} · dữ liệu backend</p>
                </div>
              </div>
              <button
                type="button"
                aria-label="Đóng chi tiết biển báo"
                onClick={() => updateUrl({ sign: null })}
                className="shrink-0 p-1 rounded-lg text-muted hover:bg-selected hover:text-navy transition-colors"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="p-6 max-h-[75vh] overflow-y-auto space-y-6">
              <div className="flex flex-col sm:flex-row gap-5 items-start bg-surface p-4 rounded-xl border border-line">
                <div className="w-28 h-28 shrink-0 mx-auto sm:mx-0 p-3 bg-bg rounded-xl border border-selected flex items-center justify-center">
                  {selectedSign.hasImage ? (
                    <Asset id={selectedSign.id} alt={selectedSign.name} className="h-full w-full object-contain" />
                  ) : (
                    <p className="text-center text-xs text-muted">Chưa có ảnh nguồn</p>
                  )}
                </div>
                <div className="space-y-2">
                  <h4 className="text-xs uppercase tracking-wider font-semibold text-muted">Ý nghĩa biển báo</h4>
                  <p className="text-sm text-navy leading-relaxed">{selectedSign.meaning}</p>
                </div>
              </div>

              <dl className="text-xs space-y-2">
                {[
                  'qcvn',
                  'so_hieu',
                  'doc_id',
                  'unit_id',
                  'ngay_hieu_luc',
                  'ngay_het_hieu_luc',
                  'bien_phu_variant',
                  'record_type',
                  'parent_code',
                  'children_codes',
                  'description_scope',
                  'note',
                ].map((k) => (
                  <div key={k}>
                    <dt>{k}</dt>
                    <dd className="break-words">{String(selectedSign.source?.[k] || 'Chưa có thông tin')}</dd>
                  </div>
                ))}
              </dl>

              <div className="bg-surface p-4 rounded-xl border border-line space-y-1.5">
                <h4 className="text-xs uppercase tracking-wider font-semibold text-muted">
                  Trường hợp áp dụng & Vị trí đặt biển
                </h4>
                <p className="text-xs sm:text-sm text-text-secondary leading-relaxed">{selectedSign.applicableCases}</p>
              </div>

              <div className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h4 className="text-xs uppercase tracking-wider font-semibold text-navy flex items-center gap-1.5">
                    <svg className="w-4 h-4 text-accent-strong" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth="2"
                        d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                      />
                    </svg>
                    Lỗi vi phạm liên quan & Mức phạt (NĐ 168/2024)
                  </h4>
                </div>

                {selectedSign.relatedViolations.length === 0 ? (
                  <div className="p-4 bg-surface rounded-xl border border-line text-xs text-muted">
                    Chưa có dữ liệu liên kết mức phạt cho biển này. Không suy ra
                    không có vi phạm.
                  </div>
                ) : (
                  <div className="space-y-2.5">
                    {selectedSign.relatedViolations.map((v, idx) => (
                      <div
                        key={idx}
                        className="bg-surface p-4 rounded-xl border border-line space-y-2"
                      >
                        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                          <p className="text-xs font-semibold text-navy">{v.title}</p>
                          <span className="text-sm font-bold text-accent-strong font-sans shrink-0">{v.fineRange}</span>
                        </div>
                        <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-selected text-xs text-muted">
                          {v.demerit && (
                            <span className="px-2 py-0.5 rounded bg-[#fee2e2] text-[#b91c1c] text-[11px] font-medium">
                              {v.demerit}
                            </span>
                          )}
                          <span className="font-mono text-[11px]">
                            {v.clause}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 px-6 py-3.5 bg-sidebar border-t border-line">
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
                Hỏi Chatbot KAG về biển này
              </Link>
              <button
                type="button"
                onClick={() => updateUrl({ sign: null })}
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
