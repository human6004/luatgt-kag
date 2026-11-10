import LogoMark from "../components/LogoMark";

import { AccountMenu } from "../auth";

import { useState } from "react";

import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";

interface NavItem {
  to: string;

  label: string;

  shortLabel: string;

  icon: string;
}

const navItems: NavItem[] = [
  {
    to: "/chat",

    label: "Trò chuyện với trợ lý",

    shortLabel: "Chat AI",

    icon: "M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z",
  },

  {
    to: "/bien-bao",

    label: "Thư viện biển báo",

    shortLabel: "Biển báo",

    icon: "M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7",
  },

  {
    to: "/on-thi",

    label: "Ôn thi theo chương",

    shortLabel: "Ôn chương",

    icon: "M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253",
  },

  {
    to: "/exam",

    label: "Thi thử sát hạch",

    shortLabel: "Thi thử",

    icon: "M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4",
  },
];

export default function UserLayout() {
  const [isCollapsed, setIsCollapsed] = useState(false);

  const location = useLocation();

  const navigate = useNavigate();

  return (
    <div className="flex h-dvh overflow-hidden" style={{ background: "var(--color-bg)" }}>
      {/* Sidebar with collapse support */}
      <aside
        className={`hidden md:flex flex-col shrink-0 h-full border-r border-line transition-all duration-200 select-none ${
          isCollapsed ? "w-16" : "w-60"
        }`}
        style={{ background: "var(--color-sidebar)" }}
      >
        {/* Logo & Toggle Button */}
        <div
          className={`px-4 pt-5 pb-4 flex items-center ${
            isCollapsed ? "justify-center" : "justify-between"
          }`}
        >
          {!isCollapsed && (
            <span className="flex items-center gap-2 font-sans font-semibold text-[21px] tracking-normal text-navy">
              <LogoMark size={20} />
              LuậtGT
            </span>
          )}
          {isCollapsed && (
            <div className="w-8 h-8 rounded-lg bg-bg border border-line flex items-center justify-center">
              <LogoMark size={18} />
            </div>
          )}

          <button
            onClick={() => setIsCollapsed(!isCollapsed)}
            title={
              isCollapsed
                ? "Mở rộng thanh điều hướng"
                : "Thu gọn thanh điều hướng (tiết kiệm không gian)"
            }
            className={`p-1.5 rounded-lg text-muted hover:text-navy hover:bg-selected transition-colors ${
              isCollapsed ? "hidden" : "block"
            }`}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2"
                d="M11 19l-7-7 7-7m8 14l-7-7 7-7"
              />
            </svg>
          </button>
        </div>

        {/* Re-expand button when collapsed */}
        {isCollapsed && (
          <div className="px-2 pb-2 flex justify-center">
            <button
              onClick={() => setIsCollapsed(false)}
              title="Mở rộng menu"
              className="p-1.5 rounded-lg text-muted hover:text-navy hover:bg-selected transition-colors"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2"
                  d="M13 5l7 7-7 7M5 5l7 7-7 7"
                />
              </svg>
            </button>
          </div>
        )}

        {/* Nav Items */}
        <nav className="flex-1 px-2.5 space-y-1">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              title={isCollapsed ? item.label : undefined}
              className={({ isActive }) =>
                `flex items-center gap-3 px-3 py-2.5 rounded-xl text-[13px] font-medium transition-all group ${
                  isActive
                    ? "text-navy bg-selected font-semibold shadow-2xs"
                    : "text-text-secondary hover:bg-selected/70 hover:text-navy"
                } ${isCollapsed ? "justify-center px-0" : ""}`
              }
            >
              <svg
                className={`w-4 h-4 shrink-0 transition-colors ${
                  item.to === location.pathname
                    ? "text-accent-strong"
                    : "text-muted group-hover:text-navy"
                }`}
                fill="none"
                stroke="currentColor"
                strokeWidth={1.8}
                viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" d={item.icon} />
              </svg>

              {!isCollapsed && (
                <div className="flex-1 flex items-center justify-between truncate">
                  <span className="truncate">{item.label}</span>
                </div>
              )}
            </NavLink>
          ))}
        </nav>

        <AccountMenu collapsed={isCollapsed} />
      </aside>

      {/* Main Content Area */}
      <div className="min-w-0 flex-1 flex flex-col">
        <div className="md:hidden flex items-center gap-3 p-3 border-b border-line">
          <LogoMark size={18} />
          <select
            aria-label="Điều hướng người dùng"
            value={
              navItems.find(
                (item) =>
                  location.pathname === item.to || location.pathname.startsWith(item.to + "/"),
              )?.to ?? "/chat"
            }
            onChange={(event) => navigate(event.target.value)}
            className="min-w-0 flex-1 bg-bg border border-line rounded-md px-2 py-2"
          >
            {navItems.map((item) => (
              <option key={item.to} value={item.to}>
                {item.label}
              </option>
            ))}
          </select>
          <AccountMenu collapsed />
        </div>
        <main className="min-w-0 flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
