import LogoMark from "../components/LogoMark"

import { AccountMenu, useAuth } from "../auth"
import { canAccessAdminPage } from "../auth-policy"

import { NavLink, Outlet, useNavigate, useLocation } from "react-router-dom"

const groups = [
  { label: "Tổng quan", items: [["/admin/dashboard", "Tổng quan"]] },
  { label: "Ngân hàng câu hỏi", items: [["/admin/questions", "Ngân hàng câu hỏi"], ["/admin/imports", "Nhập dữ liệu hàng loạt"]] },
  { label: "Ngân hàng biển báo", items: [["/admin/signs", "Biển báo"]] },
  { label: "Cấu hình server", items: [["/admin/infrastructure", "Hạ tầng & Retrieval"], ["/admin/pipeline", "Dựng đồ thị"], ["/admin/docker", "Đóng gói Docker"], ["/admin/config", "Cấu hình"]] },
  { label: "Đồ thị tri thức", items: [["/admin/knowledge", "Văn bản & tri thức KAG"], ["/admin/units", "Đơn vị pháp lý"], ["/admin/graph", "Đồ thị tri thức"], ["/admin/benchmark", "Benchmark"]] },
  { label: "Người dùng", items: [["/admin/users", "Người dùng"], ["/admin/chatlogs", "Nhật ký chat"]] },
]

const menuLinkClass = (active: boolean) =>
  `flex min-h-11 items-center border-l-2 px-3 py-2.5 text-[13px] leading-5 break-words transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-strong ${active ? 'border-accent-strong bg-selected text-navy font-semibold' : 'border-transparent text-text-secondary hover:bg-selected/60 hover:text-navy'}`

export default function AdminLayout() {
  const navigate = useNavigate(),
    location = useLocation()
  const { session } = useAuth()
  const visibleGroups = groups.map(group => ({ ...group, items: group.items.filter(([path]) => session && canAccessAdminPage(session.role, path)) })).filter(group => group.items.length)
  return (
    <div className="flex h-dvh overflow-hidden bg-bg">
      <aside className="hidden md:flex flex-col w-64 shrink-0 h-full border-r border-line bg-sidebar">
        <div className="px-5 pt-6 pb-1">
          <span className="flex items-center gap-2 font-sans font-semibold tracking-normal text-[22px] text-navy">
            <LogoMark size={18} />
            LuậtGT
          </span>
          <p className="pl-[26px] text-xs leading-5 text-muted mt-0.5">{session?.role === 'police' ? 'Quản lý nội dung' : 'Quản trị'}</p>
        </div>
        <nav aria-label="Điều hướng quản trị" className="flex-1 px-4 mt-6 pb-4 overflow-y-auto">
          {visibleGroups.map(group => {
            const active = group.items.some(([path]) => path === location.pathname)
            if (group.items.length === 1) {
              const [to, label] = group.items[0]
              return <div key={group.label} className="border-b border-line/60 py-2 last:border-0">
                <NavLink to={to} className={({ isActive }) => `${menuLinkClass(isActive)} text-[13.5px] font-semibold`}>
                  {group.label === 'Người dùng' ? label : group.label}
                </NavLink>
              </div>
            }
            return (
            <details key={`${group.label}-${active}`} open={active} className="group border-b border-line/60 py-2 last:border-0">
              <summary className={`flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 border-l-2 border-transparent px-3 py-2.5 text-[13.5px] leading-5 font-semibold transition-colors hover:bg-selected/60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-strong [&::-webkit-details-marker]:hidden ${active ? 'text-accent-strong' : 'text-navy'}`}>
                <span className="min-w-0 break-words">{group.label}</span>
                <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" className="h-3.5 w-3.5 shrink-0 text-muted transition-transform motion-reduce:transition-none group-open:rotate-180">
                  <path d="m5 7.5 5 5 5-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </summary>
              <div className="ml-3 mb-1 mt-1 space-y-0.5">
              {group.items.map(([to, label]) => (
                <NavLink
                  key={to}
                  to={to}
                  className={({ isActive }) => menuLinkClass(isActive)}
                >
                  {label}
                </NavLink>
              ))}
              </div>
            </details>
          )})}
        </nav>
        <AccountMenu />
      </aside>
      <div className="min-w-0 flex-1 flex flex-col">
        <div className="md:hidden flex items-center gap-3 p-3 border-b border-line">
          <LogoMark size={18} />
          <select
            aria-label="Điều hướng quản trị"
            value={location.pathname}
            onChange={(e) => navigate(e.target.value)}
            className="min-w-0 flex-1 bg-bg border border-line rounded-md px-2 py-2"
          >
            {visibleGroups.map(group => (
              <optgroup key={group.label} label={group.label}>
                {group.items.map(([path, label]) => <option key={path} value={path}>{label}</option>)}
              </optgroup>
            ))}
          </select>
          <AccountMenu collapsed />
        </div>
        <main className="min-w-0 flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
