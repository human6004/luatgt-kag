import { useState, type FormEvent } from "react";
import { Link, Navigate, useSearchParams } from "react-router-dom";
import { AuthCheckNotice, useAuth } from "../auth";
import { homeFor } from "../auth-policy";
import LogoMark from "../components/LogoMark";
import { Button, RequiredMark } from "../admin/ui";

export default function LoginPage() {
  const { session, login, register } = useAuth();
  const [params, setParams] = useSearchParams();
  const registration = params.get("mode") === "register";
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  if (session) return <Navigate to={homeFor(session.role)} replace />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (registration) await register(name, email, password);
      else await login(email, password);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const input =
    "w-full rounded-lg border border-line bg-bg px-4 py-3 text-sm focus:outline-2 focus:outline-accent";

  return (
    <main className="min-h-dvh bg-bg lg:grid lg:grid-cols-2">
      <section className="bg-sidebar border-b lg:border-r border-line px-6 py-8 lg:p-16 flex flex-col justify-between">
        <Link
          to="/login"
          className="inline-flex items-center gap-3 text-2xl font-semibold"
        >
          <LogoMark size={30} />
          LuậtGT
        </Link>
        <div className="hidden lg:block max-w-lg py-20">
          <h1 className="text-5xl font-semibold leading-tight">
            An tâm trên
            <br />
            mọi hành trình.
          </h1>
          <p className="mt-6 text-sm leading-7 text-text-secondary">
            Tra cứu luật giao thông, tìm hiểu biển báo và ôn thi giấy phép lái
            xe.
          </p>
        </div>
        <p className="hidden lg:block text-xs text-muted">
          Trợ lý luật giao thông & ôn thi lái xe
        </p>
      </section>
      <section className="flex items-center justify-center px-6 py-12">
        <div className="w-full max-w-[400px]">
          <AuthCheckNotice />
          <h2 className="text-3xl font-semibold">
            {registration ? "Tạo tài khoản" : "Đăng nhập LuậtGT"}
          </h2>
          <form onSubmit={submit} className="mt-8 space-y-5">
            {registration && (
              <label className="block text-sm">
                Họ tên
                <RequiredMark />
                <input
                  autoComplete="name"
                  required
                  maxLength={100}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className={`${input} mt-2`}
                />
              </label>
            )}
            <label className="block text-sm">
              Email{registration && <RequiredMark />}
              <input
                type="email"
                autoComplete="username"
                required
                maxLength={254}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className={`${input} mt-2`}
              />
            </label>
            <div>
              <label htmlFor="auth-password" className="block text-sm">
                Mật khẩu{registration && <RequiredMark />}
              </label>
              <div className="relative mt-2">
                <input
                  id="auth-password"
                  type={show ? "text" : "password"}
                  autoComplete={
                    registration ? "new-password" : "current-password"
                  }
                  required
                  minLength={registration ? 12 : undefined}
                  maxLength={72}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className={`${input} pr-12`}
                />
                <button
                  type="button"
                  className="absolute right-2 top-1/2 grid h-10 w-10 -translate-y-1/2 place-items-center text-muted hover:text-navy focus-visible:outline-2 focus-visible:outline-accent"
                  aria-label={show ? "Ẩn mật khẩu" : "Hiện mật khẩu"}
                  aria-pressed={show}
                  title={show ? "Ẩn mật khẩu" : "Hiện mật khẩu"}
                  onClick={() => setShow((v) => !v)}
                >
                  <svg
                    className="h-5 w-5"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={1.8}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
                    <circle cx="12" cy="12" r="3" />
                    {show && <path d="M3 3l18 18" />}
                  </svg>
                </button>
              </div>
            </div>
            {registration && (
              <p className="text-xs text-muted">
                Mật khẩu từ 12 ký tự, tối đa 72 byte. Tài khoản mới dành cho
                người học.
              </p>
            )}
            {error && (
              <p role="alert" className="text-sm text-red-700">
                {error}
              </p>
            )}
            <Button
              type="submit"
              variant="dark"
              className="w-full"
              disabled={busy}
            >
              {busy
                ? "Đang xử lý…"
                : registration
                  ? "Tạo tài khoản"
                  : "Đăng nhập"}
            </Button>
          </form>
          <button
            type="button"
            className="mt-6 min-h-10 text-sm underline underline-offset-4"
            onClick={() => {
              setParams(
                (prev) => {
                  const next = new URLSearchParams(prev);
                  if (registration) next.delete("mode");
                  else next.set("mode", "register");
                  return next;
                },
                { replace: true },
              );
              setError("");
            }}
          >
            {registration
              ? "Đã có tài khoản? Đăng nhập"
              : "Chưa có tài khoản? Đăng ký"}
          </button>
        </div>
      </section>
    </main>
  );
}
