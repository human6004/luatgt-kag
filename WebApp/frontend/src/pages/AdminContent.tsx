import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useAdmin } from '../admin/store'
import { Badge, Button, Page } from '../admin/ui'
import { ContentManager, ImportPanel, type ContentKind } from './server/AdminPages'

const tabs: readonly [ContentKind, string][] = [
  ['documents', 'Văn bản'],
  ['units', 'Điều khoản'],
  ['signs', 'Biển báo'],
]

export default function AdminContent() {
  const [params, setParams] = useSearchParams()
  const { notify } = useAdmin()
  const [refreshKey, setRefreshKey] = useState(0)

  const rawTab = params.get('tab')
  const tab: ContentKind = rawTab === 'units' || rawTab === 'signs' ? rawTab : 'documents'
  const showImport = params.get('import') === '1'

  function updateParams(patch: Record<string, string | null>) {
    setParams((prev) => {
      const next = new URLSearchParams(prev)
      for (const [k, v] of Object.entries(patch)) {
        if (v === null || v === '') next.delete(k)
        else next.set(k, v)
      }
      return next
    })
  }

  function switchTab(nextTab: ContentKind) {
    const next = new URLSearchParams()
    next.set('tab', nextTab)
    const projectId = params.get('project_id')
    const runId = params.get('run_id')
    if (projectId) next.set('project_id', projectId)
    if (runId) next.set('run_id', runId)
    setParams(next)
  }

  return (
    <Page
      title="Nội dung luật"
      subtitle="Quản lý văn bản pháp luật, điều khoản và biển báo; nhập hàng loạt và kiểm duyệt xuất bản tại một nơi."
      actions={
        <>
          {tab === 'documents' && (
            <Button onClick={() => notify('Chức năng đang phát triển')}>
              Dán đường dẫn <Badge tone="gray">Đang phát triển</Badge>
            </Button>
          )}
          <Button
            variant={showImport ? 'dark' : 'outline'}
            onClick={() => updateParams({ tab, import: showImport ? null : '1' })}
          >
            {showImport ? 'Đóng nhập hàng loạt' : 'Nhập hàng loạt'}
          </Button>
          <Button
            variant="primary"
            onClick={() => updateParams({ tab, import: null, id: 'new' })}
          >
            + Thêm mới
          </Button>
        </>
      }
    >
      <div className="flex flex-wrap gap-6 border-b border-line mb-6" role="tablist" aria-label="Loại nội dung luật">
        {tabs.map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            onClick={() => switchTab(key)}
            className={`pb-3 text-sm cursor-pointer border-b-2 transition-colors focus-visible:outline-2 focus-visible:outline-accent-strong ${
              tab === key ? 'border-navy text-navy font-semibold' : 'border-transparent text-muted hover:text-navy'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {showImport && (
        <ImportPanel
          kind={tab}
          onImported={() => setRefreshKey((k) => k + 1)}
          onClose={() => updateParams({ import: null })}
        />
      )}

      <ContentManager key={`${tab}-${refreshKey}`} kind={tab} />
    </Page>
  )
}
