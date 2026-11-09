export type Role = "user" | "police" | "admin"
export type ServerRole = "USER" | "POLICE" | "ADMIN"
export type Session = { email: string; name: string; role: Role }
export const homeFor = (role: Role) => role === "admin" ? "/admin/dashboard" : role === "police" ? "/admin/content" : "/chat"

export function roleFor(value: unknown): Role {
  if (value === "ADMIN") return "admin"
  if (value === "POLICE") return "police"
  if (value === "USER") return "user"
  throw new Error("Vai trò tài khoản không hợp lệ.")
}

const policePages = [
  "/admin/content", "/admin/questions", "/admin/users",
  // Legacy paths allowed through RequireRole so Route redirects carry police to the new paths:
  "/admin/knowledge", "/admin/documents", "/admin/units", "/admin/signs",
  "/admin/imports", "/admin/content-imports", "/admin/question-bank-settings",
]
export const canAccessAdminPage = (role: Role, pathname: string) =>
  role === "admin" || role === "police" && (pathname === "/admin" || policePages.includes(pathname.replace(/\/+$/, "")))
