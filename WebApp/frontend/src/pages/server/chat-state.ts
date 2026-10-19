import { api, send, ApiError, type ContentRecord } from '../../api.ts'

type Citation = { doc_id: string; unit_id: string | null; sign_id?: string | null; quote: string; source?: {
  contract_version: string; release_id: string; source_snapshot_id: string; entity_type: string; entity_id: string;
  text: string; metadata: Record<string, unknown>; document_metadata: Record<string, unknown>
} }
type ChatRecord = { id: string; question: string; answer: string; state: string; citations: Citation[] }
type ChatState = { rows: ChatRecord[]; loading: boolean; error: string; busy: boolean; requestError: string; observed: 'idle' | 'answered' | 'abstained' | 'unavailable' | 'offline' | 'error' | 'cancelled' }
const unavailableMessage = 'Dịch vụ tra cứu pháp luật hiện đang gặp sự cố hoặc chưa sẵn sàng. Vui lòng thử lại sau.'

function record(value: unknown): value is ChatRecord {
  if (!value || typeof value !== 'object') return false
  const row = value as ChatRecord
  return typeof row.id === 'string' && !!row.id && typeof row.question === 'string' && typeof row.answer === 'string' && typeof row.state === 'string' && Array.isArray(row.citations)
}

export function chatView(row: ChatRecord) {
  const empty = { answer: '', citations: [] as Citation[] }
  if (row.state === 'KAG_ABSTAINED') return { status: 'Hiện tôi chưa tìm được đủ căn cứ pháp lý được xác minh để trả lời chính xác câu hỏi này.', ...empty }
  if (row.state === 'UNAVAILABLE') return { status: unavailableMessage, ...empty }
  if (row.state === 'PROCESSING') return { status: 'Đang xử lý — chưa có câu trả lời.', ...empty }
  const citationsValid = row.citations.length > 0 && row.citations.length <= 20 && row.citations.every(c => c &&
    typeof c.doc_id === 'string' && !!c.doc_id.trim() && typeof c.quote === 'string' && !!c.quote.trim() &&
    (c.source ? snapshotMatches(c) : typeof c.unit_id === 'string' && !!c.unit_id.trim()))
  if (row.state !== 'ANSWERED' || !row.answer.trim() || !citationsValid) return { status: 'Chưa có câu trả lời đủ căn cứ.', ...empty }
  return { status: 'Đã trả lời', answer: row.answer, citations: row.citations }
}

export async function loadCitationSource(citation: Citation) {
  if (citation.source) {
    if (!snapshotMatches(citation)) throw new ApiError('Source snapshot mismatch', 502)
    const { metadata, document_metadata: doc, entity_type: kind } = citation.source
    return { title: String(doc.title ?? citation.doc_id), number: String(doc.so_hieu ?? citation.doc_id),
      unitType: kind.endsWith('.LegalUnit') ? String(metadata.unit_type ?? 'Đơn vị pháp lý') : kind.endsWith('.TrafficSign') ? 'Biển báo' : 'Văn bản', text: citation.source.text }
  }
  const [documents, units] = await Promise.all([api<ContentRecord[]>('/documents'), api<ContentRecord[]>(`/units?docId=${encodeURIComponent(citation.doc_id)}`)])
  if (!Array.isArray(documents) || !Array.isArray(units)) throw new ApiError('Invalid source', 502)
  const doc = documents.find(d => d.externalId === citation.doc_id), unit = units.find(u => u.externalId === citation.unit_id)
  if (!doc?.data || !unit?.data || unit.data.doc_id !== citation.doc_id || typeof unit.data.text !== 'string' || !citation.quote.trim() || !unit.data.text.includes(citation.quote) || typeof doc.data.title !== 'string' || typeof doc.data.so_hieu !== 'string' || typeof unit.data.unit_type !== 'string') throw new ApiError('Source not available', 502)
  return { title: doc.data.title, number: doc.data.so_hieu, unitType: unit.data.unit_type, text: unit.data.text }
}

function snapshotMatches(citation: Citation) {
  const source = citation.source
  if (!source || source.contract_version !== 'graph-source-v1' || typeof source.release_id !== 'string' || !source.release_id ||
    typeof source.source_snapshot_id !== 'string' || !source.source_snapshot_id || typeof source.entity_type !== 'string' || typeof source.entity_id !== 'string' || source.text !== citation.quote ||
    !source.metadata || !source.document_metadata || source.document_metadata.id !== citation.doc_id || source.metadata.id !== source.entity_id) return false
  return source.entity_type.endsWith('.LegalDocument') ? source.entity_id === citation.doc_id :
    source.entity_type.endsWith('.LegalUnit') ? source.entity_id === citation.unit_id && source.metadata.doc_id === citation.doc_id :
    source.entity_type.endsWith('.TrafficSign') && source.entity_id === citation.sign_id && source.metadata.doc_id === citation.doc_id
}

export function createChat() {
  let state: ChatState = { rows: [], loading: true, error: '', busy: false, requestError: '', observed: 'idle' }
  const listeners = new Set<() => void>()
  let history: Promise<void> | undefined
  let controller: AbortController | undefined
  function update(change: Partial<ChatState>) { state = { ...state, ...change }; listeners.forEach(listener => listener()) }
  function load(): Promise<void> {
    if (history) return history
    update({ loading: true, error: '' })
    history = api<unknown>('/chat').then(rows => {
      if (!Array.isArray(rows) || !rows.every(record)) throw new ApiError('Invalid history', 502)
      update({ rows })
    }).catch(error => {
      const status = error instanceof ApiError ? error.status : -1
      update({ error: status === 0 ? 'Không kết nối được backend. Hãy thử lại.' : status === 401 ? 'Phiên đã hết hạn. Vui lòng đăng nhập lại.' : 'Không tải được lịch sử. Hãy thử lại.', ...(status === 401 ? { rows: [] } : {}) })
    }).finally(() => { history = undefined; update({ loading: false }) })
    return history
  }
  async function submit(message: string) {
    if (state.busy || state.loading || !message.trim() || message.length > 4000) return false
    update({ busy: true, requestError: '' })
    controller = new AbortController()
    try {
      const row = await api<unknown>('/chat', { ...send('POST', { message }), signal: controller.signal })
      if (controller.signal.aborted) throw new ApiError('Cancelled')
      if (!record(row)) throw new ApiError('Invalid chat response', 502)
      const view = chatView(row)
      update({ rows: [row, ...state.rows.filter(old => old.id !== row.id)].slice(0, 50), observed: view.answer ? 'answered' : row.state === 'KAG_ABSTAINED' ? 'abstained' : row.state === 'UNAVAILABLE' ? 'unavailable' : 'error' })
      return true
    } catch (error) {
      if (controller.signal.aborted) {
        update({ observed: 'cancelled', requestError: 'Đã dừng chờ phản hồi. Backend có thể đang hoàn tất; tải lại lịch sử để kiểm tra trước khi gửi lại.' })
        return false
      }
      const status = error instanceof ApiError ? error.status : -1
      const unavailable = status >= 500 && status <= 599
      update({ observed: unavailable ? 'unavailable' : status === 0 ? 'offline' : 'error', requestError: unavailable ? unavailableMessage : status === 429 ? 'KAG đang bận. Chờ request trước kết thúc rồi kiểm tra lịch sử.' : status === 0 ? 'Không kết nối được backend. Câu hỏi chưa được xác nhận; hãy thử lại.' : status === 401 ? 'Phiên đã hết hạn. Vui lòng đăng nhập lại.' : status === 403 ? 'Bạn không có quyền gửi câu hỏi.' : status === 422 || status === 400 ? 'Câu hỏi không hợp lệ. Hãy kiểm tra nội dung.' : 'Không gửi được câu hỏi. Hãy thử lại.', ...(status === 401 ? { rows: [] } : {}) })
      // Read persisted outcome once after processing errors; never resend inference.
      if (unavailable) await load()
      return false
    } finally { controller = undefined; update({ busy: false }) }
  }
  return { getSnapshot: () => state, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }, load, submit, cancel: () => controller?.abort() }
}
