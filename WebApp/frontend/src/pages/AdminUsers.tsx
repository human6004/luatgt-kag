import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { api, send } from '../api'
import { useAuth } from '../auth'
import { useAdmin } from '../admin/store'
import { Badge, Button, Card, Page, Td, Th, Toggle, inputCls, type Tone } from '../admin/ui'
import { Notice, useData, useTask } from './server/shared'

type UserRoleLabel = 'Người học' | 'Cảnh sát' | 'Quản trị viên'
type UserRecord = { id: string; name: string; email: string; role: string; enabled: boolean }
type LogRecord = {
  id: string
  ownerId: string
  question: string
  answer: string | null
  state: string
  feedback: string | null
  note: string | null
  resolved: boolean
  resolution: string | null
  createdAt: string
}

const roles: UserRoleLabel[] = ['Người học', 'Cảnh sát', 'Quản trị viên']
const serverRoles: Record<string, string> = { 'Người học': 'USER', 'Cảnh sát': 'POLICE' }

const statusTone: Record<string, Tone> = {
  'Đã trả lời': 'green',
  'Không có căn cứ': 'amber',
  'Phản hồi sai': 'red',
  'Văn bản hết hiệu lực': 'gray',
}

export default function AdminUsers() {
  const { session } = useAuth()
  const isPolice = session?.role === 'police'
  const { notify } = useAdmin()
  const task = useTask()
  const nav = useNavigate()
  const [params, setParams] = useSearchParams()

  const tab: 'users' | 'logs' = isPolice || params.get('tab') === 'logs' ? 'logs' : 'users'
  const urlQ = params.get('q') ?? ''
  const [q, setQ] = useState(urlQ)
  const role = params.get('role') ?? 'all'
  const rawFilter = params.get('filter')
  const logFilter: 'all' | 'issue' | 'down' = rawFilter === 'issue' || rawFilter === 'down' ? rawFilter : 'all'
  const userFilter = params.get('user') ?? ''
  const selectedLogId = params.get('log') ?? ''

  useEffect(() => {
    setQ(urlQ)
  }, [urlQ])

  const [rawUsers, setRawUsers] = useState<UserRecord[] | undefined>(undefined)
  const [usersLoading, setUsersLoading] = useState(!isPolice)
  const [usersError, setUsersError] = useState('')
  const [usersVersion, setUsersVersion] = useState(0)

  useEffect(() => {
    if (isPolice) {
      setUsersLoading(false)
      return
    }
    const controller = new AbortController()
    setUsersLoading(true)
    setUsersError('')
    api<UserRecord[]>('/admin/users', { signal: controller.signal })
      .then((v) => {
        if (!controller.signal.aborted) setRawUsers(v)
      })
      .catch((e: Error) => {
        if (!controller.signal.aborted) setUsersError(e.message)
      })
      .finally(() => {
        if (!controller.signal.aborted) setUsersLoading(false)
      })
    return () => controller.abort()
  }, [isPolice, usersVersion])

  const reloadUsers = () => setUsersVersion((v) => v + 1)
  const logsData = useData<LogRecord[]>('/admin/chatlogs?pending=false')
  const [note, setNote] = useState('')

  const users = useMemo(
    () =>
      (rawUsers || []).map((r) => ({
        id: r.id,
        name: r.name,
        email: r.email,
        role: (r.role === 'ADMIN' ? 'Quản trị viên' : r.role === 'POLICE' ? 'Cảnh sát' : 'Người học') as UserRoleLabel,
        active: r.enabled,
      })),
    [rawUsers],
  )

  const userMap = useMemo(() => new Map(users.map((u) => [u.id, u])), [users])

  const logs = useMemo(
    () =>
      (logsData.value || []).map((r) => ({
        ...r,
        user: r.ownerId,
        answer: r.answer || '',
        status:
          r.feedback === 'WRONG'
            ? 'Phản hồi sai'
            : r.feedback === 'OUTDATED'
              ? 'Văn bản hết hiệu lực'
              : r.feedback === 'NO_BASIS' || r.state === 'KAG_ABSTAINED'
                ? 'Không có căn cứ'
                : r.state === 'ANSWERED'
                  ? 'Đã trả lời'
                  : r.state,
        feedback: r.feedback === 'HELPFUL' ? ('up' as const) : r.feedback ? ('down' as const) : null,
        time: r.createdAt,
      })),
    [logsData.value],
  )

  const logCountByUser = useMemo(() => {
    const counts = new Map<string, number>()
    for (const l of logs) counts.set(l.user, (counts.get(l.user) ?? 0) + 1)
    return counts
  }, [logs])

  const issueCount = useMemo(
    () => logs.filter((x) => x.status !== 'Đã trả lời' && !x.resolved).length,
    [logs],
  )

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

  function switchTab(nextTab: 'users' | 'logs') {
    const next = new URLSearchParams()
    next.set('tab', nextTab)
    setParams(next)
  }

  function jumpToUserLogs(userId: string) {
    const next = new URLSearchParams()
    next.set('tab', 'logs')
    next.set('user', userId)
    setParams(next)
  }

  const shownUsers = useMemo(
    () =>
      users.filter(
        (u) =>
          (role === 'all' || u.role === role) &&
          `${u.name} ${u.email}`.toLowerCase().includes(q.toLowerCase()),
      ),
    [users, role, q],
  )

  const shownLogs = useMemo(
    () =>
      logs.filter((l) => {
        if (userFilter && l.user !== userFilter) return false
        if (logFilter === 'issue' && (l.status === 'Đã trả lời' || l.resolved)) return false
        if (logFilter === 'down' && l.feedback !== 'down') return false
        const u = userMap.get(l.user)
        const haystack = `${l.question} ${l.user} ${u?.name || ''} ${u?.email || ''}`.toLowerCase()
        return haystack.includes(q.toLowerCase())
      }),
    [logs, userFilter, logFilter, q, userMap],
  )

  const cur = logs.find((l) => l.id === selectedLogId)
  const filteredUser = userFilter ? userMap.get(userFilter) : undefined

  function patchUser(id: string, p: { role?: UserRoleLabel; active?: boolean }) {
    if (p.role === 'Quản trị viên') return
    if (p.role || p.active !== undefined) {
      void task.run(async () => {
        await api(
          `/admin/users/${id}`,
          send('PATCH', {
            ...(p.active !== undefined ? { enabled: p.active } : {}),
            ...(p.role ? { role: serverRoles[p.role] } : {}),
          }),
        )
        reloadUsers()
        notify(p.role ? 'Đã cập nhật vai trò tài khoản' : 'Đã lưu trạng thái tài khoản')
      })
    }
  }

  function exportCsv() {
    const rows = [
      ['thời gian', 'người dùng', 'email', 'câu hỏi', 'trạng thái', 'phản hồi'],
      ...shownLogs.map((l) => {
        const u = userMap.get(l.user)
        return [l.time, u?.name || l.user, u?.email || '', l.question, l.status, l.feedback ?? '']
      }),
    ]
    const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n')
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob(['\uFEFF' + csv], { type: 'text/csv' }))
    a.download = 'nhat-ky-chat.csv'
    a.click()
  }

  function displayUser(ownerId: string) {
    const u = userMap.get(ownerId)
    return u ? `${u.name} (${u.email})` : `@${ownerId}`
  }

  return (
    <Page
      title={isPolice ? 'Nhật ký chat' : 'Người dùng & Nhật ký chat'}
      subtitle={
        tab === 'users'
          ? `${rawUsers ? users.length : '—'} tài khoản · ${rawUsers ? users.filter((u) => u.active).length : '—'} đang hoạt động`
          : 'Theo dõi câu hỏi, đánh giá phản hồi và chuyển câu chưa trả lời được sang bổ sung tri thức.'
      }
      actions={
        tab === 'users' ? (
          <Button variant="primary" onClick={() => notify('Chức năng đang phát triển')}>
            + Mời người dùng <Badge tone="gray">Đang phát triển</Badge>
          </Button>
        ) : (
          <Button onClick={exportCsv}>Xuất CSV</Button>
        )
      }
    >
      {!isPolice && (
        <div className="flex flex-wrap gap-6 border-b border-line mb-6" role="tablist" aria-label="Người dùng và nhật ký">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'users'}
            onClick={() => switchTab('users')}
            className={`pb-3 text-sm cursor-pointer border-b-2 transition-colors ${
              tab === 'users' ? 'border-navy text-navy font-semibold' : 'border-transparent text-muted hover:text-navy'
            }`}
          >
            Người dùng ({rawUsers ? users.length : '—'})
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'logs'}
            onClick={() => switchTab('logs')}
            className={`pb-3 text-sm cursor-pointer border-b-2 transition-colors ${
              tab === 'logs' ? 'border-navy text-navy font-semibold' : 'border-transparent text-muted hover:text-navy'
            }`}
          >
            Nhật ký chat
            {issueCount > 0 && <span className="ml-1.5 text-xs font-semibold text-accent-strong">· {issueCount} cần xử lý</span>}
          </button>
        </div>
      )}

      <Notice error={task.error} />

      {tab === 'users' ? (
        <>
          <Notice loading={usersLoading} error={usersError} retry={reloadUsers} />
          <div className="grid gap-3 sm:grid-cols-3 mb-5">
            {roles.map((r) => (
              <Card key={r} className="px-5 py-4">
                <p className="text-xs text-muted">{r}</p>
                <p className="mt-1 text-2xl font-semibold text-navy">{users.filter((u) => u.role === r).length}</p>
              </Card>
            ))}
          </div>
          <div className="flex flex-wrap gap-3 mb-4">
            <input
              className={`${inputCls} max-w-xs`}
              placeholder="Tìm tên, email…"
              value={q}
              onChange={(e) => {
                const v = e.target.value
                setQ(v)
                updateUrl({ q: v || null }, true)
              }}
            />
            <select
              className={`${inputCls} max-w-[200px]`}
              value={role}
              onChange={(e) => updateUrl({ role: e.target.value === 'all' ? null : e.target.value })}
              aria-label="Vai trò"
            >
              <option value="all">Tất cả vai trò</option>
              {roles.map((r) => (
                <option key={r}>{r}</option>
              ))}
            </select>
          </div>
          <Card className="overflow-x-auto">
            <table className="w-full min-w-[760px]">
              <thead className="border-b border-line">
                <tr>
                  <Th>Người dùng</Th>
                  <Th>Vai trò</Th>
                  <Th>Lượt hỏi</Th>
                  <Th>Hoạt động</Th>
                  <Th className="text-right">Thao tác</Th>
                </tr>
              </thead>
              <tbody>
                {shownUsers.map((u) => {
                  const chatCount = logCountByUser.get(u.id) ?? 0
                  return (
                    <tr key={u.id} className={`border-b border-line/60 last:border-0 ${u.active ? '' : 'opacity-60'}`}>
                      <Td>
                        <div className="flex items-center gap-3">
                          <span className="w-8 h-8 rounded-full grid place-items-center bg-selected text-accent-strong text-xs font-bold">
                            {u.name
                              .split(' ')
                              .map((w) => w[0])
                              .slice(-2)
                              .join('')}
                          </span>
                          <span>
                            <span className="block font-medium text-navy">{u.name}</span>
                            <span className="block text-[12px] text-muted">{u.email}</span>
                          </span>
                        </div>
                      </Td>
                      <Td>
                        <select
                          className="rounded-lg border border-line bg-transparent px-2 py-1 text-[12.5px] text-navy"
                          value={u.role}
                          disabled={task.busy || u.role === 'Quản trị viên'}
                          onChange={(e) => patchUser(u.id, { role: e.target.value as UserRoleLabel })}
                          aria-label="Vai trò"
                        >
                          {roles.map((r) => (
                            <option key={r}>{r}</option>
                          ))}
                        </select>
                      </Td>
                      <Td className="text-text-secondary">{logsData.value ? chatCount : '—'}</Td>
                      <Td>
                        <Toggle
                          checked={u.active}
                          disabled={task.busy || u.role === 'Quản trị viên'}
                          onChange={(v) => patchUser(u.id, { active: v })}
                          label="Kích hoạt"
                        />
                      </Td>
                      <Td className="text-right whitespace-nowrap">
                        <span className="inline-flex flex-wrap justify-end gap-1.5">
                          <Button size="sm" variant="outline" onClick={() => jumpToUserLogs(u.id)}>
                            Nhật ký ({logsData.value ? chatCount : '…'}) →
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => notify('Chức năng đang phát triển')}>
                            Đặt lại MK <Badge tone="gray">Đang phát triển</Badge>
                          </Button>
                          <Button size="sm" variant="danger" onClick={() => notify('Chức năng đang phát triển')}>
                            Xoá <Badge tone="gray">Đang phát triển</Badge>
                          </Button>
                        </span>
                      </Td>
                    </tr>
                  )
                })}
                {!shownUsers.length && (
                  <tr>
                    <td colSpan={5} className="px-4 py-8 text-center text-[13.5px] text-muted">
                      Không có tài khoản phù hợp.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </Card>
        </>
      ) : (
        <>
          <Notice {...logsData} retry={logsData.reload} />
          <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-3 mb-4">
                <div className="flex max-w-full flex-wrap rounded-xl border border-line bg-surface p-0.5">
                  {([
                    ['all', 'Tất cả'],
                    ['issue', 'Cần xử lý'],
                    ['down', 'Đánh giá 👎'],
                  ] as const).map(([k, l]) => (
                    <button
                      key={k}
                      type="button"
                      onClick={() => updateUrl({ filter: k === 'all' ? null : k })}
                      className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                        logFilter === k ? 'bg-selected text-navy' : 'text-muted hover:text-navy'
                      }`}
                    >
                      {l}
                      {k === 'issue' && <span className="ml-1 text-accent-strong">{issueCount}</span>}
                    </button>
                  ))}
                </div>
                <input
                  className={`${inputCls} max-w-xs`}
                  placeholder="Tìm câu hỏi, tên, email…"
                  value={q}
                  onChange={(e) => {
                    const v = e.target.value
                    setQ(v)
                    updateUrl({ q: v || null }, true)
                  }}
                />
                {userFilter && (
                  <span className="inline-flex items-center gap-2 rounded-full border border-navy/30 bg-selected px-3 py-1 text-xs text-navy">
                    <span>
                      Đang lọc: <strong>{filteredUser ? `${filteredUser.name} (${filteredUser.email})` : userFilter}</strong>
                    </span>
                    <button
                      type="button"
                      aria-label="Bỏ lọc người dùng"
                      onClick={() => updateUrl({ user: null, log: null })}
                      className="font-bold hover:text-red-700"
                    >
                      ✕
                    </button>
                  </span>
                )}
              </div>
              <Card>
                <ul className="divide-y divide-line/70">
                  {shownLogs.map((l) => (
                    <li key={l.id}>
                      <button
                        type="button"
                        onClick={() => {
                          setNote('')
                          updateUrl({ log: l.id })
                        }}
                        className={`w-full text-left px-5 py-3.5 transition-colors ${
                          l.id === selectedLogId ? 'bg-selected/60' : 'hover:bg-bg'
                        }`}
                      >
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <p className="min-w-0 flex-1 basis-48 break-words text-[13.5px] leading-6 font-medium text-navy">
                            {l.question}
                          </p>
                          <Badge tone={l.resolved && l.status !== 'Đã trả lời' ? 'green' : statusTone[l.status] || 'gray'}>
                            {l.resolved && l.status !== 'Đã trả lời' ? 'Đã xử lý' : l.status}
                          </Badge>
                        </div>
                        <p className="mt-1 break-words text-[12px] leading-5 text-muted">
                          {displayUser(l.user)} · {l.time}
                          {l.feedback === 'up' ? ' · 👍' : l.feedback === 'down' ? ' · 👎' : ''}
                        </p>
                      </button>
                    </li>
                  ))}
                  {!shownLogs.length && (
                    <li className="px-5 py-8 text-center text-sm text-muted">Không có bản ghi.</li>
                  )}
                </ul>
              </Card>
            </div>

            <Card title="Chi tiết hội thoại" className="self-start xl:sticky xl:top-6">
              {cur ? (
                <div className="px-5 pb-5 space-y-4">
                  <div className="flex justify-end">
                    <p className="max-w-[85%] rounded-2xl rounded-br-md bg-selected px-3.5 py-2.5 text-[13.5px] text-navy">
                      {cur.question}
                    </p>
                  </div>
                  <p className="text-[13.5px] leading-relaxed text-text-secondary border-l-2 border-line pl-3">
                    {cur.answer || '—'}
                  </p>
                  <dl className="grid grid-cols-3 gap-2 text-center">
                    {[
                      ['Độ trễ', 'Chưa đo'],
                      ['Phản hồi', cur.feedback === 'up' ? '👍' : cur.feedback === 'down' ? '👎' : '—'],
                      ['Người dùng', userMap.get(cur.user)?.email || '@' + cur.user],
                    ].map(([k, v]) => (
                      <div key={k} className="rounded-xl border border-line bg-bg py-2">
                        <dt className="text-[10.5px] uppercase tracking-wide text-muted">{k}</dt>
                        <dd className="text-[13px] font-semibold text-navy truncate px-1" title={String(v)}>
                          {v}
                        </dd>
                      </div>
                    ))}
                  </dl>
                  {cur.note && <p className="text-xs">Phản hồi người dùng: {cur.note}</p>}
                  {cur.resolution && <p className="text-xs">Ghi chú xử lý: {cur.resolution}</p>}
                  <textarea
                    rows={2}
                    className={inputCls}
                    placeholder="Ghi chú cho biên tập viên…"
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                  />
                  <div className="flex flex-wrap gap-2">
                    {!cur.resolved && (
                      <Button
                        disabled={task.busy}
                        variant="primary"
                        onClick={() => {
                          void task.run(async () => {
                            await api(`/admin/chatlogs/${cur.id}/resolve`, send('POST', { note }))
                            setNote('')
                            logsData.reload()
                            notify('Đã đánh dấu đã xử lý')
                          })
                        }}
                      >
                        Đánh dấu đã xử lý
                      </Button>
                    )}
                    <Button onClick={() => nav('/admin/content?tab=documents')}>Bổ sung văn bản</Button>
                    <Button variant="ghost" onClick={() => notify('Chức năng đang phát triển')}>
                      Chạy lại <Badge tone="gray">Đang phát triển</Badge>
                    </Button>
                  </div>
                </div>
              ) : (
                <p className="px-5 pb-5 text-sm text-muted">Chọn một hội thoại.</p>
              )}
            </Card>
          </div>
        </>
      )}
    </Page>
  )
}
