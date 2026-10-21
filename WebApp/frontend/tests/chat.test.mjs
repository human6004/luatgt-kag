import assert from 'node:assert/strict'
import { test, beforeEach } from 'node:test'
import { createChat, chatView, loadCitationSource } from '../src/pages/server/chat-state.ts'
import { tokenKey } from '../src/api.ts'

const citation = { doc_id: 'fixture-doc', unit_id: 'fixture-unit', quote: 'TEST ONLY — trích đoạn kiểm thử.\nKhông phải căn cứ pháp luật.' }
const answered = { id: 'fixture-chat', question: 'Câu hỏi tiếng Việt\nDòng thứ hai', answer: 'TEST ONLY — nội dung từ HTTP fixture.', citations: [citation], state: 'ANSWERED', createdAt: '2026-10-10T00:00:00Z' }
const unavailable = { ...answered, answer: '', citations: [], state: 'UNAVAILABLE' }
test('graph snapshot citations keep their original source after graph changes without MySQL reads', async () => {
  for (const [kind,id,unit,sign] of [['LegalDocument','fixture-doc',null,null],['LegalUnit','fixture-unit','fixture-unit',null],['TrafficSign','sign-1',null,'sign-1']]) {
    const source={contract_version:'graph-source-v1',release_id:'graph-A',source_snapshot_id:'source-A',entity_type:`RoadAlpha.${kind}`,entity_id:id,
      text:citation.quote,metadata:{id,doc_id:'fixture-doc',unit_type:'Dieu',ten:'Biển báo'},document_metadata:{id:'fixture-doc',title:'Nguồn A',so_hieu:'A'}}
    const row={...citation,unit_id:unit,sign_id:sign,source}
    assert.equal(chatView({...answered,citations:[row]}).answer,answered.answer)
    const result=await loadCitationSource(row)
    assert.equal(result.title,'Nguồn A');assert.equal(result.text,citation.quote)
    await assert.rejects(loadCitationSource({...row,quote:'Nguồn B'}))
    assert.equal(chatView({...answered,citations:[{...row,source:{...source,entity_type:17}}]}).answer,'')
  }
})
const abstained = { ...unavailable, id: 'fixture-abstained', state: 'KAG_ABSTAINED' }
const abstainedMessage = 'Hiện tôi chưa tìm được đủ căn cứ pháp lý được xác minh để trả lời chính xác câu hỏi này.'
const unavailableMessage = 'Dịch vụ tra cứu pháp luật hiện đang gặp sự cố hoặc chưa sẵn sàng. Vui lòng thử lại sau.'
let requests, tokens, expired
const response = (body, status = 200) => new Response(JSON.stringify(body), { status })
beforeEach(() => {
  requests = []; tokens = new Map([[tokenKey, 'webapp-jwt-fixture']]); expired = false
  globalThis.sessionStorage = { getItem: key => tokens.get(key), removeItem: key => tokens.delete(key) }
  globalThis.window = { dispatchEvent: event => { expired = event.type === 'luatgt-session-expired' } }
})
function wire(handler) {
  globalThis.fetch = async (url, options) => {
    requests.push({ url, ...options })
    assert.equal(url, options.method === 'POST' ? '/api/chat/stream?progress=true' : '/api/chat')
    assert.equal(options.headers.get('Authorization'), 'Bearer webapp-jwt-fixture')
    const response = await handler(options.method || 'GET')
    if (options.method !== 'POST' || !response.ok) return response
    const row = await response.json(), question = JSON.parse(options.body).message
    const initial = { ...row, question, state: 'PROCESSING', answer: '', citations: [] }
    return new Response(`event: started\ndata: ${JSON.stringify(initial)}\n\nevent: ${row.state === 'UNAVAILABLE' ? 'error' : 'done'}\ndata: ${JSON.stringify({ ...row, question })}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } })
  }
}
async function loaded(handler = () => response([])) { wire(handler); const chat = createChat(); await chat.load(); return chat }

test('history loads once for concurrent mounts and preserves backend rows', async () => {
  let finish; wire(() => new Promise(resolve => { finish = resolve }))
  const chat = createChat(), first = chat.load(), second = chat.load()
  assert.equal(requests.length, 1); assert.equal(chat.getSnapshot().loading, true)
  finish(response([answered])); await Promise.all([first, second])
  assert.deepEqual(chat.getSnapshot().rows, [answered]); assert.equal(chat.getSnapshot().loading, false)
  assert.equal(chat.getSnapshot().observed, 'idle')
})
test('empty history is successful without fabricating a conversation', async () => {
  const chat = await loaded(); assert.deepEqual(chat.getSnapshot().rows, []); assert.equal(chat.getSnapshot().error, '')
})
test('history network error is visible and can be retried', async () => {
  const chat = await loaded(() => { throw new Error('offline') })
  assert.match(chat.getSnapshot().error, /Không kết nối/); assert.equal(chat.getSnapshot().loading, false)
  wire(() => response([unavailable])); await chat.load(); assert.deepEqual(chat.getSnapshot().rows, [unavailable]); assert.equal(chat.getSnapshot().error, '')
})
test('POST uses only WebApp JWT and message, preserves Vietnamese, and avoids history refetch', async () => {
  const chat = await loaded(method => response(method === 'POST' ? answered : []))
  assert.equal(await chat.submit(answered.question), true)
  assert.equal(requests.length, 2); assert.deepEqual(JSON.parse(requests[1].body), { message: answered.question })
  assert.deepEqual(chat.getSnapshot().rows, [answered]); assert.equal(chat.getSnapshot().observed, 'answered')
  assert.deepEqual(chatView(chat.getSnapshot().rows[0]), { status: 'Đã trả lời', answer: answered.answer, citations: [citation] })
})
test('503 refreshes persisted UNAVAILABLE once and never exposes backend error details', async () => {
  let gets = 0
  const chat = await loaded(method => method === 'POST' ? response({ message: 'KAG-secret-fixture /private/credentials' }, 503) : response(++gets === 1 ? [] : [unavailable]))
  assert.equal(await chat.submit(answered.question), false)
  assert.equal(requests.length, 3); assert.deepEqual(chat.getSnapshot().rows, [unavailable])
  assert.equal(chat.getSnapshot().observed, 'unavailable'); assert.equal(chat.getSnapshot().requestError, unavailableMessage)
  assert.doesNotMatch(chat.getSnapshot().requestError, /KAG-secret-fixture|private/)
  assert.deepEqual(chatView(unavailable), { status: unavailableMessage, answer: '', citations: [] })
  assert.equal(tokens.has(tokenKey), true); assert.equal(expired, false)
})
test('offline POST retains history and emits no answer or automatic retry', async () => {
  const chat = await loaded(method => { if (method === 'POST') throw new Error('offline'); return response([unavailable]) })
  assert.equal(await chat.submit(answered.question), false); assert.equal(requests.length, 2)
  assert.deepEqual(chat.getSnapshot().rows, [unavailable]); assert.equal(chat.getSnapshot().observed, 'offline'); assert.match(chat.getSnapshot().requestError, /Mất kết nối.*Tải lại lịch sử/)
})
test('expired JWT clears session and chat without refreshing unauthenticated history', async () => {
  const chat = await loaded(method => response(method === 'POST' ? { message: 'Unauthorized' } : [unavailable], method === 'POST' ? 401 : 200))
  assert.equal(await chat.submit(answered.question), false)
  assert.equal(requests.length, 2); assert.equal(expired, true); assert.equal(tokens.has(tokenKey), false)
  assert.deepEqual(chat.getSnapshot().rows, []); assert.match(chat.getSnapshot().requestError, /đăng nhập/); assert.equal(chat.getSnapshot().observed, 'error')
})
test('rapid double submit sends only one POST', async () => {
  let finish; const chat = await loaded(method => method === 'POST' ? new Promise(resolve => { finish = resolve }) : response([]))
  const first = chat.submit(answered.question); assert.equal(chat.getSnapshot().busy, true)
  assert.equal(await chat.submit('Không gửi lần hai'), false); assert.equal(requests.length, 2)
  finish(response(answered)); assert.equal(await first, true); assert.equal(chat.getSnapshot().busy, false)
})
test('blank, over-limit, and submit during initial history load never send POST', async () => {
  const chat = await loaded(); await chat.submit(' \n '); await chat.submit('a'.repeat(4001)); assert.equal(requests.length, 1)
  let finish; wire(() => new Promise(resolve => { finish = resolve })); const other = createChat(), loading = other.load()
  assert.equal(await other.submit('Không gửi khi tải lịch sử'), false); assert.equal(requests.length, 2)
  finish(response([])); await loading
})
test('4000 UTF-16 characters and multiline text reach backend unchanged', async () => {
  const question = 'Đ\n'.repeat(2000), row = { ...answered, question }
  const chat = await loaded(method => response(method === 'POST' ? row : []))
  assert.equal(await chat.submit(question), true); assert.equal(JSON.parse(requests[1].body).message, question)
})
test('UNAVAILABLE suppresses even stray answer and citations', () => {
  const view = chatView({ ...answered, state: 'UNAVAILABLE' }); assert.equal(view.answer, ''); assert.deepEqual(view.citations, [])
})
test('verified backend abstention is a completed business outcome without answer, retries or scope guesses', async () => {
  const row = { ...abstained, question: 'Câu hỏi ngoài chuyên môn chưa có reason đáng tin cậy', answer: 'stray answer', citations: [citation] }
  const chat = await loaded(method => response(method === 'POST' ? row : [unavailable]))
  assert.equal(await chat.submit(row.question), true); assert.equal(requests.length, 2)
  assert.equal(chat.getSnapshot().observed, 'abstained'); assert.equal(chat.getSnapshot().requestError, '')
  assert.deepEqual(chatView(chat.getSnapshot().rows[0]), { status: abstainedMessage, answer: '', citations: [] })
  assert.doesNotMatch(chatView(row).status, /ngoài phạm vi|chỉ hỗ trợ|sự cố/)
  assert.equal(chat.getSnapshot().busy, false)
})
test('reload preserves abstention and old answered, unavailable and processing rows without reclassification', async () => {
  const rows = [abstained, answered, { ...unavailable, question: 'Không đủ căn cứ nhưng record cũ UNAVAILABLE' }, { ...unavailable, state: 'PROCESSING' }]
  const chat = await loaded(() => response(rows)); assert.deepEqual(chat.getSnapshot().rows, rows)
  assert.equal(chatView(chat.getSnapshot().rows[0]).status, abstainedMessage)
  assert.equal(chatView(chat.getSnapshot().rows[1]).answer, answered.answer)
  assert.equal(chatView(chat.getSnapshot().rows[2]).status, unavailableMessage)
  assert.match(chatView(chat.getSnapshot().rows[3]).status, /Đang trả lời/)
  assert.equal(chat.getSnapshot().observed, 'idle'); assert.equal(requests.length, 1)
})
test('raw or malformed 503 cannot make the browser classify native abstention', async () => {
  for (const body of [{ error: { code: 'KAG_ABSTAINED', retryable: false }, native_state: 'abstained' }, {}, { message: 'private-token' }]) {
    const chat = await loaded(method => response(method === 'POST' ? body : [], method === 'POST' ? 503 : 200))
    assert.equal(await chat.submit('Căn cứ?'), false)
    assert.equal(chat.getSnapshot().observed, 'unavailable'); assert.equal(chat.getSnapshot().requestError, unavailableMessage)
    assert.deepEqual(chat.getSnapshot().rows, []); assert.doesNotMatch(chat.getSnapshot().requestError, /private-token/)
  }
})
test('missing citation fields or unknown state do not become verified answers', () => {
  for (const row of [{ ...answered, citations: [] }, { ...answered, citations: [{ doc_id: 'fixture-doc' }] }, { ...answered, state: 'UNKNOWN' }]) {
    const view = chatView(row); assert.equal(view.answer, ''); assert.deepEqual(view.citations, []); assert.notEqual(view.status, 'Đã trả lời')
  }
  assert.match(chatView({ ...unavailable, state: 'PROCESSING' }).status, /Đang trả lời/)
})
test('invalid history body fails closed without showing backend content', async () => {
  const chat = await loaded(() => response({ answer: 'not a history list' })); assert.deepEqual(chat.getSnapshot().rows, []); assert.ok(chat.getSnapshot().error)
})
test('invalid POST body does not clear draft or become a successful answer', async () => {
  const chat = await loaded(method => response(method === 'POST' ? { answer: 'not a chat record' } : []))
  assert.equal(await chat.submit(answered.question), false); assert.deepEqual(chat.getSnapshot().rows, []); assert.equal(chat.getSnapshot().observed, 'unavailable')
  assert.equal(chat.getSnapshot().requestError, unavailableMessage); assert.equal(requests.length, 3)
})

for (const [status, expected] of [[403, /không có quyền/], [422, /không hợp lệ/]]) {
  test(`POST ${status} remains an error without exposing reflected credentials or retrying`, async () => {
    const chat = await loaded(method => response(method === 'POST' ? { message: 'KAG-secret-fixture /private/credentials' } : [], method === 'POST' ? status : 200))
    assert.equal(await chat.submit(answered.question), false); assert.equal(requests.length, 2)
    assert.deepEqual(chat.getSnapshot().rows, []); assert.equal(chat.getSnapshot().observed, 'error')
    assert.match(chat.getSnapshot().requestError, expected); assert.doesNotMatch(chat.getSnapshot().requestError, /KAG-secret-fixture|private/)
    assert.equal(tokens.has(tokenKey), true)
  })
}
test('GET 401 clears the session without inferring KAG readiness', async () => {
  const chat = await loaded(() => new Response('Unauthorized', { status: 401 }))
  assert.equal(expired, true); assert.equal(tokens.has(tokenKey), false)
  assert.deepEqual(chat.getSnapshot().rows, []); assert.match(chat.getSnapshot().error, /đăng nhập/)
  assert.equal(chat.getSnapshot().observed, 'idle')
})
test('HTTP success with UNAVAILABLE does not promote it to ANSWERED or show stray citations', async () => {
  const row = { ...answered, state: 'UNAVAILABLE' }
  const chat = await loaded(method => response(method === 'POST' ? row : []))
  assert.equal(await chat.submit(answered.question), true); assert.equal(requests.length, 2)
  assert.equal(chat.getSnapshot().observed, 'unavailable'); assert.equal(chat.getSnapshot().rows[0].state, 'UNAVAILABLE')
  assert.equal(chatView(row).answer, ''); assert.deepEqual(chatView(row).citations, [])
})

test('explicit stop is confirmed by the server and survives history reload', async () => {
  const chat = await loaded()
  const stopped = { ...unavailable, state: 'CANCELLED' }
  globalThis.fetch = async (url, options) => {
    requests.push({ url, ...options })
    if (url === `/api/chat/${answered.id}/stop`) return response(stopped)
    assert.equal(url, '/api/chat/stream?progress=true')
    const body = new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(`event: started\ndata: ${JSON.stringify({ ...unavailable, state: 'PROCESSING' })}\n\n`))
      options.signal.addEventListener('abort', () => controller.error(new Error('aborted')), { once: true })
    } })
    return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } })
  }
  const pending = chat.submit(answered.question)
  await new Promise(resolve => setTimeout(resolve, 0))
  await chat.cancel()
  assert.equal(await pending, false)
  assert.equal(requests.length, 3); assert.equal(chat.getSnapshot().busy, false)
  assert.deepEqual(chat.getSnapshot().rows, [stopped]); assert.equal(chat.getSnapshot().observed, 'cancelled')
  assert.equal(chatView(stopped).status, 'Đã dừng trả lời')
  wire(() => response([stopped])); await chat.load()
  assert.deepEqual(chat.getSnapshot().rows, [stopped]); assert.equal(requests.length, 4)
})

test('429 shows a busy error without inference retry', async () => {
  for (const [status, expected] of [[429, /đang bận/]]) {
    const chat = await loaded(method => response(method === 'POST' ? { message: 'private-key' } : [], method === 'POST' ? status : 200))
    const count = requests.length
    assert.equal(await chat.submit(answered.question), false)
    assert.equal(requests.length, count + 1); assert.match(chat.getSnapshot().requestError, expected)
    assert.doesNotMatch(chat.getSnapshot().requestError, /private-key/)
  }
})
test('processing failures and timeouts display unavailable and reload saved history once without inference retry', async () => {
  for (const status of [500, 502, 504]) {
    const chat = await loaded(method => response(method === 'POST' ? { message: 'private-key' } : [unavailable], method === 'POST' ? status : 200))
    const count = requests.length
    assert.equal(await chat.submit('Căn cứ?'), false)
    assert.equal(requests.length, count + 2); assert.equal(requests.at(-1).method || 'GET', 'GET')
    assert.equal(chat.getSnapshot().observed, 'unavailable'); assert.equal(chat.getSnapshot().requestError, unavailableMessage)
    assert.deepEqual(chat.getSnapshot().rows, [unavailable]); assert.doesNotMatch(chat.getSnapshot().requestError, /private-key/)
  }
})

test('citation details use exact authorized IDs and fail closed on missing source or changed quote', async () => {
  const doc = { externalId: citation.doc_id, data: { title: 'TEST ONLY title', so_hieu: 'TEST ONLY number' } }
  const unit = { externalId: citation.unit_id, data: { doc_id: citation.doc_id, unit_type: 'TEST ONLY', text: citation.quote } }
  globalThis.fetch = async (url, options) => {
    assert.equal(options.headers.get('Authorization'), 'Bearer webapp-jwt-fixture')
    assert.ok(['/api/documents', '/api/units?docId=fixture-doc'].includes(url))
    return response(url.includes('units') ? [unit] : [doc])
  }
  assert.deepEqual(await loadCitationSource(citation), { title: doc.data.title, number: doc.data.so_hieu, unitType: unit.data.unit_type, text: citation.quote })
  for (const bad of [{ ...citation, unit_id: 'missing' }, { ...citation, quote: 'not in source' }]) await assert.rejects(loadCitationSource(bad))
})
