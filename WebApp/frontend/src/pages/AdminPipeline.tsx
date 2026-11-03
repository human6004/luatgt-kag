import { BuilderControls } from './server/KagManagement'
import type { JobStatus } from '../admin/store'
import { Page, type Tone } from '../admin/ui'
import { Link, useSearchParams } from 'react-router-dom'

export const jobTone: Record<JobStatus, [Tone, string]> = {
  queued: ['gray', 'Chờ'], running: ['gold', 'Đang chạy'], success: ['green', 'Thành công'],
  failed: ['red', 'Lỗi'], cancelled: ['gray', 'Đã huỷ'],
}

export default function AdminPipeline() {
  const [parameters]=useSearchParams(),projectId=parameters.get('project_id')
  return <Page title="Dựng đồ thị" subtitle="Dựng đồ thị từ dữ liệu đi kèm ứng dụng." actions={<Link className="underline text-sm" to={`/admin/graph${projectId ? `?project_id=${encodeURIComponent(projectId)}` : ''}`}>Về Đồ thị của tôi</Link>}><BuilderControls /></Page>
}
