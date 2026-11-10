import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { Navigate, Outlet, useLocation } from "react-router-dom";
import {
  canAccessAdminPage,
  homeFor,
  roleFor,
  type Role,
  type ServerRole,
  type Session,
} from "./auth-policy";
import { ApiError, api, send, tokenKey } from "./api";
type User = { email: string; name: string; role: ServerRole };
const profile = (u: User): Session => ({
  email: u.email,
  name: u.name,
  role: roleFor(u.role),
});
const Context = createContext<{
  session: Session | null;
  ready: boolean;
  checkError: string;
  retryCheck: () => void;
  login: (email: string, password: string) => Promise<void>;
  register: (name: string, email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
} | null>(null);
export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null),
    [ready, setReady] = useState(false),
    [checkError, setCheckError] = useState(""),
    [checkAttempt, setCheckAttempt] = useState(0);
  useEffect(() => {
    let mounted = true;
    const expire = () => {
      sessionStorage.removeItem("luatgt-active-exam");
      setSession(null);
      setCheckError("");
    };
    window.addEventListener("luatgt-session-expired", expire);
    if (sessionStorage.getItem(tokenKey)) {
      setReady(false);
      setCheckError("");
      api<User>("/auth/me")
        .then((u) => {
          if (mounted) setSession(profile(u));
        })
        .catch((error: unknown) => {
          if (!mounted || (error instanceof ApiError && error.status === 401))
            return;
          setSession(null);
          setCheckError(
            error instanceof Error
              ? error.message
              : "Không thể xác minh phiên đăng nhập. Vui lòng thử lại.",
          );
        })
        .finally(() => {
          if (mounted) setReady(true);
        });
    } else {
      setSession(null);
      setReady(true);
    }
    return () => {
      mounted = false;
      window.removeEventListener("luatgt-session-expired", expire);
    };
  }, [checkAttempt]);
  const retryCheck = () => {
    setCheckError("");
    setReady(false);
    setCheckAttempt((attempt) => attempt + 1);
  };
  async function authenticate(path: string, body: unknown) {
    const r = await api<{ accessToken: string; user: User }>(
      path,
      send("POST", body),
    );
    const next = profile(r.user);
    sessionStorage.removeItem("luatgt-active-exam");
    sessionStorage.setItem(tokenKey, r.accessToken);
    setSession(next);
    setCheckError("");
  }
  const login = (email: string, password: string) =>
    authenticate("/auth/login", { email, password });
  const register = (name: string, email: string, password: string) =>
    authenticate("/auth/register", { name, email, password });
  async function logout() {
    await api("/auth/logout", send("POST"));
    sessionStorage.removeItem(tokenKey);
    sessionStorage.removeItem("luatgt-active-exam");
    setSession(null);
  }
  return (
    <Context.Provider
      value={{
        session,
        ready,
        checkError,
        retryCheck,
        login,
        register,
        logout,
      }}
    >
      {children}
    </Context.Provider>
  );
}
export function useAuth() {
  const auth = useContext(Context);
  if (!auth) throw new Error("AuthProvider required");
  return auth;
}
export function AuthCheckNotice() {
  const { checkError, retryCheck } = useAuth();
  if (!checkError) return null;
  return (
    <div
      role="alert"
      className="mx-auto max-w-xl rounded-xl border border-line bg-surface p-5 text-center"
    >
      <p className="text-sm text-red-700">{checkError}</p>
      <button
        type="button"
        onClick={retryCheck}
        className="mt-3 min-h-10 rounded-lg border border-navy/35 bg-selected px-4 py-2 text-sm font-semibold text-navy hover:bg-line focus-visible:outline-2 focus-visible:outline-accent-strong"
      >
        Thử lại kiểm tra phiên
      </button>
    </div>
  );
}
export function RequireRole({ roles }: { roles: Role[] }) {
  const { session, ready, checkError } = useAuth(),
    { pathname } = useLocation();
  if (!ready)
    return (
      <p className="p-8" role="status">
        Đang kiểm tra phiên đăng nhập…
      </p>
    );
  if (checkError) return <AuthCheckNotice />;
  if (!session) return <Navigate to="/login" replace />;
  const allowed =
    roles.includes(session.role) &&
    (!pathname.startsWith("/admin") ||
      canAccessAdminPage(session.role, pathname));
  return allowed ? <Outlet /> : <Navigate to={homeFor(session.role)} replace />;
}
export function SessionHome() {
  const { session, ready, checkError } = useAuth();
  return !ready ? (
    <p className="p-8" role="status">
      Đang kiểm tra phiên đăng nhập…
    </p>
  ) : checkError ? (
    <AuthCheckNotice />
  ) : (
    <Navigate to={session ? homeFor(session.role) : "/login"} replace />
  );
}
export function AccountMenu({ collapsed = false }: { collapsed?: boolean }) {
  const { session, logout } = useAuth();
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <div className="border-t border-line p-3">
      {!collapsed && (
        <div className="mb-2 text-xs text-muted">
          <p className="font-semibold text-navy">{session?.name}</p>
          <p className="truncate mt-1">{session?.email}</p>
        </div>
      )}
      <button
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError("");
          try {
            await logout();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
        aria-label="Đăng xuất"
        title="Đăng xuất"
        className="w-full rounded-md border border-navy/35 px-2 py-2 text-xs hover:bg-selected focus-visible:outline-2 focus-visible:outline-accent"
      >
        {collapsed ? "↪" : "Đăng xuất"}
      </button>
      {error && (
        <p role="alert" className="mt-2 text-xs text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}
