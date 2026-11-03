export type Role = "user" | "police" | "admin"
export type ServerRole = "USER" | "POLICE" | "ADMIN"
export type Session = { email: string; name: string; role: Role }
export const homeFor = (role: Role) => role === "admin" ? "/admin/dashboard" : role === "police" ? "/admin/questions" : "/chat"

export function roleFor(value: unknown): Role {
  if (value === "ADMIN") return "admin"
  if (value === "POLICE") return "police"
  if (value === "USER") return "user"
  throw new Error("Vai trò tài khoản không hợp lệ.")
}

const policePages = [
  "/admin/knowledge", "/admin/units", "/admin/questions", "/admin/question-bank-settings", "/admin/signs",
  "/admin/imports", "/admin/content-imports", "/admin/chatlogs",
]
export const canAccessAdminPage = (role: Role, pathname: string) =>
  role === "admin" || role === "police" && (pathname === "/admin" || policePages.includes(pathname.replace(/\/+$/, "")))
