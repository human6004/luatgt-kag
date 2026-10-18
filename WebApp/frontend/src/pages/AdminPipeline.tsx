import { BuilderControls } from './server/KagManagement'
import type { JobStatus } from '../admin/store'
import { Page, type Tone } from '../admin/ui'

export const jobTone: Record<JobStatus, [Tone, string]> = {
  queued: ['gray', 'Chờ'], running: ['gold', 'Đang chạy'], success: ['green', 'Thành công'],
  failed: ['red', 'Lỗi'], cancelled: ['gray', 'Đã huỷ'],
}

export default function AdminPipeline() {
  return <Page title="Dựng đồ thị" subtitle="Dựng đồ thị từ dữ liệu đi kèm ứng dụng."><BuilderControls /></Page>
}
