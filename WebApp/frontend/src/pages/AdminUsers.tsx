import { api, send } from '../api'
import { useData, useTask, Notice } from './server/shared'
import { useState } from 'react'
import { useAdmin, type AppUser } from '../admin/store'
import { Badge, Button, Card, Field, Modal, Page, Td, Th, Toggle, inputCls } from '../admin/ui'

const roles: AppUser['role'][] = ['Người học', 'Cảnh sát', 'Quản trị viên']
const serverRoles: Record<string, string> = { 'Người học': 'USER', 'Cảnh sát': 'POLICE' }

export default function AdminUsers() {
  const {notify}=useAdmin(), task=useTask()
  const data=useData<{id:string;name:string;email:string;role:string;enabled:boolean}[]>('/admin/users')
  const [demoUsers,setUsers]=useState<AppUser[]>([])
  const users=(data.value||[]).map(r=>({id:r.id,name:r.name,email:r.email,role:(r.role==='ADMIN'?'Quản trị viên':r.role==='POLICE'?'Cảnh sát':'Người học') as AppUser['role'],active:r.enabled,licenseClass:'—',questions:null,joined:'—',demo:false})).concat([])
  const shownUsers=[...users,...demoUsers.map(u=>({...u,demo:true,questions:u.questions as number|null}))]

  const [q, setQ] = useState('')
  const [role, setRole] = useState('all')
  const [inviteOpen, setInviteOpen] = useState(false)
  const [draft, setDraft] = useState({ name: '', email: '', role: roles[0] as AppUser['role'] })
  const shown = shownUsers.filter((u) => (role === 'all' || u.role === role) && (u.name + u.email).toLowerCase().includes(q.toLowerCase()))
  const patch=(id:string,p:Partial<AppUser>)=>{
    if(demoUsers.some(u=>u.id===id)){setUsers(us=>us.map(u=>u.id===id?{...u,...p}:u));notify('Demo: đã cập nhật tài khoản mô phỏng');return}
    if(p.role==='Quản trị viên')return
    if(p.role||p.active!==undefined)void task.run(async()=>{await api(`/admin/users/${id}`,send('PATCH',{...(p.active!==undefined?{enabled:p.active}:{}),...(p.role?{role:serverRoles[p.role]}:{})}));data.reload();notify(p.role?'Đã cập nhật vai trò tài khoản':'Đã lưu trạng thái tài khoản')})
  }


  return (
    <Page
      title="Người dùng"
      subtitle={`${users.length} tài khoản · ${users.filter((u) => u.active).length} đang hoạt động`}
      actions={<Button variant="primary" onClick={() => setInviteOpen(true)}>+ Mời người dùng · Demo</Button>}
    >
      <Notice {...data} retry={data.reload}/><Notice error={task.error}/><p className="mb-5 text-xs text-muted">Danh sách, vai trò và trạng thái tài khoản dùng API thật. Mời, đặt lại mật khẩu và xóa chưa có API. Hạng ôn, lượt hỏi, ngày tham gia chưa được API cung cấp.</p>
      <div className="grid gap-3 sm:grid-cols-3 mb-5">
        {roles.map((r) => (
          <Card key={r} className="px-5 py-4">
            <p className="text-xs text-muted">{r}</p>
            <p className="mt-1 text-2xl font-semibold text-navy">{users.filter((u) => u.role === r).length}</p>
          </Card>
        ))}
      </div>
      <div className="mb-4 space-y-3">
        <input aria-label="Tìm người dùng" className={`${inputCls} w-full`} placeholder="Tìm tên, email…" value={q} onChange={(e) => setQ(e.target.value)} />
        <div>
          <select className={`${inputCls} w-full max-w-[200px]`} value={role} onChange={(e) => setRole(e.target.value)} aria-label="Vai trò">
            <option value="all">Tất cả vai trò</option>
            {roles.map((r) => <option key={r}>{r}</option>)}
          </select>
        </div>
      </div>
      <Card className="overflow-x-auto">
        <table className="w-full min-w-[760px]">
          <thead className="border-b border-line">
            <tr><Th>Người dùng</Th><Th>Vai trò</Th><Th>Hạng ôn</Th><Th>Lượt hỏi</Th><Th>Tham gia</Th><Th>Hoạt động</Th><Th /></tr>
          </thead>
          <tbody>
            {shown.map((u) => (
              <tr key={u.id} className={`border-b border-line/60 last:border-0 ${u.active ? '' : 'opacity-60'}`}>
                <Td>
                  <div className="flex items-center gap-3">
                    <span className="w-8 h-8 rounded-full grid place-items-center bg-selected text-accent-strong text-xs font-bold">
                      {u.name.split(' ').map((w) => w[0]).slice(-2).join('')}
                    </span>
                    <span>
                      <span className="block font-medium text-navy">{u.name}{u.demo&&' · Demo'}</span>
                      <span className="block text-[12px] text-muted">{u.email}</span>
                    </span>
                  </div>
                </Td>
                <Td>
                  <select className="rounded-lg border border-line bg-transparent px-2 py-1 text-[12.5px] text-navy" value={u.role} disabled={task.busy||(!u.demo&&u.role==='Quản trị viên')} onChange={(e) => patch(u.id, { role: e.target.value as AppUser['role'] })} aria-label="Vai trò">
                    {roles.map((r) => <option key={r}>{r}</option>)}
                  </select><p className="mt-1 text-[11px] text-muted">{u.demo?'Demo':`Quyền thật: ${u.role}`}</p>
                </Td>
                <Td><Badge tone="gold">{u.licenseClass}</Badge></Td>
                <Td className="text-text-secondary">{u.questions??'—'}</Td>
                <Td className="text-muted">{u.joined}</Td>
                <Td><Toggle checked={u.active} disabled={task.busy||(!u.demo&&u.role==='Quản trị viên')} onChange={(v) => patch(u.id, {active:v})} label="Kích hoạt" /></Td>
                <Td className="text-right whitespace-nowrap">
                  <Button size="sm" variant="ghost" onClick={() => notify(`Demo: mô phỏng đặt lại mật khẩu ${u.email}; không gửi email`)}>Đặt lại MK · Demo</Button>
                  <Button size="sm" variant="danger" onClick={() => { setUsers((us) => us.filter((x) => x.id !== u.id)); notify('Demo: chỉ xóa tài khoản mô phỏng; không xóa tài khoản server') }}>Xoá · Demo</Button>
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Modal
        open={inviteOpen}
        title="Mời người dùng · Demo"
        onClose={() => setInviteOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setInviteOpen(false)}>Huỷ</Button>
            <Button
              variant="primary"
              disabled={!draft.name.trim() || !/\S+@\S+/.test(draft.email)}
              onClick={() => {
                setUsers((us) => [{ id: 'u' + Date.now(), ...draft, licenseClass: 'B', questions: 0, active: true, joined: new Date().toLocaleDateString('vi-VN') }, ...us])
                setDraft({ name: '', email: '', role: roles[0] })
                setInviteOpen(false)
                notify('Demo: tạo tài khoản mô phỏng trong trình duyệt; không gửi lời mời')
              }}
            >
              Gửi lời mời · Demo
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="Họ tên"><input className={inputCls} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} autoFocus /></Field>
          <Field label="Email"><input type="email" className={inputCls} value={draft.email} onChange={(e) => setDraft({ ...draft, email: e.target.value })} /></Field>
          <Field label="Vai trò">
            <select className={inputCls} value={draft.role} onChange={(e) => setDraft({ ...draft, role: e.target.value as AppUser['role'] })}>
              {roles.map((r) => <option key={r}>{r}</option>)}
            </select>
          </Field>
        </div>
      </Modal>
    </Page>
  )
}
