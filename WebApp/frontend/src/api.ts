export const tokenKey = 'luatgt-access-token'
export class ApiError extends Error {
  status: number
  constructor(message: string, status = 0) { super(message); this.name = 'ApiError'; this.status = status }
}
export async function apiResponse(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  const token = sessionStorage.getItem(tokenKey)
  if (token) headers.set('Authorization', `Bearer ${token}`)
  if (init.body && !(init.body instanceof FormData)) headers.set('Content-Type', 'application/json')
  let response: Response
  try { response = await fetch(`/api${path}`, { ...init, headers }) } catch { throw new ApiError('Không kết nối được backend. Vui lòng kiểm tra dịch vụ và thử lại.') }
  if (response.status === 401 && !path.startsWith('/auth/login')) {
    sessionStorage.removeItem(tokenKey); window.dispatchEvent(new Event('luatgt-session-expired'))
    throw new ApiError('Phiên đã hết hạn. Vui lòng đăng nhập lại.', 401)
  }
  return response
}
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await apiResponse(path, init)
  let text: string
  try { text = await response.text() } catch { throw new ApiError('Không đọc được phản hồi backend. Vui lòng thử lại.', response.status) }
  let data: unknown
  try { data = text ? JSON.parse(text) : undefined } catch { throw new ApiError('Backend chưa khả dụng hoặc phản hồi không hợp lệ.', response.status) }
  if (!response.ok) {
    throw new ApiError((data as { message?: string })?.message || (response.status === 401 ? 'Email hoặc mật khẩu không đúng.' : `Yêu cầu thất bại (${response.status}).`), response.status)
  }
  return data as T
}
export const send = (method: string, body?: unknown): RequestInit => ({ method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
export type ContentRecord = { id: string; externalId: string; published: boolean; version: number; data: Record<string, unknown> }
export async function media(id: string, path?: string): Promise<string> {
  const response = await fetch(`/api${path || `/content/${id}/media`}`, { headers: { Authorization: `Bearer ${sessionStorage.getItem(tokenKey) || ''}` } })
  if (!response.ok) throw new Error('Không tải được ảnh/tài liệu nguồn.')
  return URL.createObjectURL(await response.blob())
}
