import LogoMark from "../components/LogoMark"
import { AccountMenu, useAuth } from "../auth"
import { canAccessAdminPage } from "../auth-policy"
import { Link, NavLink, Outlet, useNavigate, useLocation } from "react-router-dom"

const topItems: [string, string][] = [
  ["/admin/dashboard", "Tổng quan"],
  ["/admin/chatbot", "Chatbot"],
  ["/admin/content", "Nội dung luật"],
  ["/admin/questions", "Câu hỏi thi"],
  ["/admin/users", "Người dùng"],
]

const advancedItems: [string, string][] = [
  ["/admin/infrastructure", "Kết nối & chẩn đoán"],
  ["/admin/sources", "Dữ liệu nguồn KAG"],
  ["/admin/schema", "Schema"],
  ["/admin/docker", "Đóng gói Docker"],
  ["/admin/benchmark", "Benchmark"],
]

const menuLinkClass = (active: boolean) =>
  `flex min-h-11 items-center border-l-2 px-3 py-2.5 text-[13px] leading-5 break-words transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-strong ${active ? 'border-accent-strong bg-selected text-navy font-semibold' : 'border-transparent text-text-secondary hover:bg-selected/60 hover:text-navy'}`

export default function AdminLayout() {
  const navigate = useNavigate(),
    location = useLocation()
  const { session } = useAuth()
  const visibleTop = topItems
    .filter(([path]) => session && canAccessAdminPage(session.role, path))
    .map(([path, label]) =>
      session?.role === "police" && path === "/admin/users"
        ? ["/admin/users?tab=logs", "Nhật ký chat", path] as const
        : [path, label, path] as const,
    )
  const visibleAdvanced = advancedItems.filter(([path]) => session && canAccessAdminPage(session.role, path))
  const advancedActive = visibleAdvanced.some(([path]) => path === location.pathname)

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
          {visibleTop.map(([to, label, basePath]) => (
            <div key={basePath} className="border-b border-line/60 py-1.5 last:border-0">
              <NavLink
                to={to}
                className={() => `${menuLinkClass(location.pathname === basePath)} text-[13.5px] font-semibold`}
              >
                {label}
              </NavLink>
            </div>
          ))}
          {visibleAdvanced.length > 0 && (
            <details key={`advanced-${advancedActive}`} open={advancedActive} className="group border-b border-line/60 py-1.5 last:border-0">
              <summary className={`flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 border-l-2 border-transparent px-3 py-2.5 text-[13.5px] leading-5 font-semibold transition-colors hover:bg-selected/60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-strong [&::-webkit-details-marker]:hidden ${advancedActive ? 'text-accent-strong' : 'text-navy'}`}>
                <span className="min-w-0 break-words">Nâng cao</span>
                <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" className="h-3.5 w-3.5 shrink-0 text-muted transition-transform motion-reduce:transition-none group-open:rotate-180">
                  <path d="m5 7.5 5 5 5-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </summary>
              <div className="ml-3 mb-1 mt-1 space-y-0.5">
                {visibleAdvanced.map(([to, label]) => (
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
          )}
        </nav>
        <div className="px-4 py-2 border-t border-line/60">
          <Link to="/chat" className="flex items-center justify-between rounded-lg px-3 py-2 text-xs font-medium text-text-secondary hover:bg-selected/60 hover:text-navy transition-colors">
            <span>Mở trang Hỏi luật</span>
            <span aria-hidden="true">↗</span>
          </Link>
        </div>
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
            {visibleTop.map(([, label, basePath]) => (
              <option key={basePath} value={basePath}>{label}</option>
            ))}
            {visibleAdvanced.length > 0 && (
              <optgroup label="Nâng cao">
                {visibleAdvanced.map(([path, label]) => <option key={path} value={path}>{label}</option>)}
              </optgroup>
            )}
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
