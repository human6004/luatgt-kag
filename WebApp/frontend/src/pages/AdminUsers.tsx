import { api, send } from "../api";
import { useData, useTask, Notice } from "./server/shared";
import { useState } from "react";
import { useAdmin, type AppUser } from "../admin/store";
import {
  Badge,
  Card,
  Page,
  Td,
  Th,
  Toggle,
  inputCls,
} from "../admin/ui";

const roles: AppUser["role"][] = ["Người học", "Cảnh sát", "Quản trị viên"];
const serverRoles: Record<string, string> = {
  "Người học": "USER",
  "Cảnh sát": "POLICE",
};

export default function AdminUsers() {
  const { notify } = useAdmin(),
    task = useTask();
  const data =
    useData<
      {
        id: string;
        name: string;
        email: string;
        role: string;
        enabled: boolean;
      }[]
    >("/admin/users");
  const users = (data.value || []).map((r) => ({
      id: r.id,
      name: r.name,
      email: r.email,
      role: (r.role === "ADMIN"
        ? "Quản trị viên"
        : r.role === "POLICE"
          ? "Cảnh sát"
          : "Người học") as AppUser["role"],
      active: r.enabled,
      licenseClass: "—",
      questions: null,
      joined: "—",
    }));

  const [q, setQ] = useState("");
  const [role, setRole] = useState("all");
  const shown = users.filter(
    (u) =>
      (role === "all" || u.role === role) &&
      (u.name + u.email).toLowerCase().includes(q.toLowerCase()),
  );
  const patch = (id: string, p: Partial<AppUser>) => {
    if (p.role === "Quản trị viên") return;
    if (p.role || p.active !== undefined)
      void task.run(async () => {
        await api(
          `/admin/users/${id}`,
          send("PATCH", {
            ...(p.active !== undefined ? { enabled: p.active } : {}),
            ...(p.role ? { role: serverRoles[p.role] } : {}),
          }),
        );
        data.reload();
        notify(
          p.role
            ? "Đã cập nhật vai trò tài khoản"
            : "Đã lưu trạng thái tài khoản",
        );
      });
  };

  return (
    <Page
      title="Người dùng"
      subtitle={`${users.length} tài khoản · ${users.filter((u) => u.active).length} đang hoạt động`}
    >
      <Notice {...data} retry={data.reload} />
      <Notice error={task.error} />
      <p className="mb-5 text-xs text-muted">
        Danh sách, vai trò và trạng thái tài khoản dùng API thật. Mời, đặt lại
        mật khẩu và xóa chưa có API. Hạng ôn, lượt hỏi, ngày tham gia chưa được
        API cung cấp.
      </p>
      <div className="grid gap-3 sm:grid-cols-3 mb-5">
        {roles.map((r) => (
          <Card key={r} className="px-5 py-4">
            <p className="text-xs text-muted">{r}</p>
            <p className="mt-1 text-2xl font-semibold text-navy">
              {users.filter((u) => u.role === r).length}
            </p>
          </Card>
        ))}
      </div>
      <div className="mb-4 space-y-3">
        <input
          aria-label="Tìm người dùng"
          className={`${inputCls} w-full`}
          placeholder="Tìm tên, email…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <div>
          <select
            className={`${inputCls} w-full max-w-[200px]`}
            value={role}
            onChange={(e) => setRole(e.target.value)}
            aria-label="Vai trò"
          >
            <option value="all">Tất cả vai trò</option>
            {roles.map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
        </div>
      </div>
      <div className="space-y-3 lg:hidden">
        {shown.map((u) => (
          <Card key={u.id} className={!u.active ? "opacity-60" : ""}>
            <div className="space-y-4 p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-center gap-3">
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-selected text-xs font-bold text-accent-strong">
                    {u.name
                      .split(" ")
                      .map((word) => word[0])
                      .slice(-2)
                      .join("")}
                  </span>
                  <span className="min-w-0">
                    <span className="block break-words font-medium text-navy">
                      {u.name}
                    </span>
                    <span className="block break-all text-xs text-muted">
                      {u.email}
                    </span>
                  </span>
                </div>
                <Badge tone={u.active ? "green" : "gray"}>
                  {u.active ? "Đang hoạt động" : "Đã khóa"}
                </Badge>
              </div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                <label className="min-w-0 space-y-1">
                  <span className="block text-xs text-muted">Vai trò</span>
                  <select
                    className="w-full rounded-lg border border-line bg-transparent px-2 py-1.5 text-sm text-navy"
                    value={u.role}
                    disabled={task.busy || u.role === "Quản trị viên"}
                    onChange={(e) =>
                      patch(u.id, { role: e.target.value as AppUser["role"] })
                    }
                    aria-label={`Vai trò của ${u.name}`}
                  >
                    {roles.map((r) => (
                      <option key={r}>{r}</option>
                    ))}
                  </select>
                  <span className="block text-[11px] text-muted">
                    Quyền thật: {u.role}
                  </span>
                </label>
                <p>
                  <span className="block text-xs text-muted">Hạng ôn</span>
                  <span className="mt-1 inline-block"><Badge tone="gold">{u.licenseClass}</Badge></span>
                </p>
                <p>
                  <span className="block text-xs text-muted">Lượt hỏi</span>
                  {u.questions ?? "—"}
                </p>
                <p>
                  <span className="block text-xs text-muted">Tham gia</span>
                  {u.joined}
                </p>
                <div className="col-span-2 border-t border-line pt-3">
                  <Toggle
                    checked={u.active}
                    disabled={task.busy || u.role === "Quản trị viên"}
                    onChange={(v) => patch(u.id, { active: v })}
                    label="Kích hoạt"
                  />
                </div>
              </div>
            </div>
          </Card>
        ))}
        {data.value && !shown.length && (
          <p className="rounded-xl border border-line bg-surface p-5 text-center text-sm text-muted">
            Không có người dùng phù hợp.
          </p>
        )}
      </div>
      <Card className="hidden overflow-x-auto lg:block">
        <table className="w-full min-w-[760px]">
          <thead className="border-b border-line">
            <tr>
              <Th>Người dùng</Th>
              <Th>Vai trò</Th>
              <Th>Hạng ôn</Th>
              <Th>Lượt hỏi</Th>
              <Th>Tham gia</Th>
              <Th>Hoạt động</Th>
            </tr>
          </thead>
          <tbody>
            {shown.map((u) => (
              <tr
                key={u.id}
                className={`border-b border-line/60 last:border-0 ${u.active ? "" : "opacity-60"}`}
              >
                <Td>
                  <div className="flex items-center gap-3">
                    <span className="w-8 h-8 rounded-full grid place-items-center bg-selected text-accent-strong text-xs font-bold">
                      {u.name
                        .split(" ")
                        .map((w) => w[0])
                        .slice(-2)
                        .join("")}
                    </span>
                    <span>
                      <span className="block font-medium text-navy">
                        {u.name}
                      </span>
                      <span className="block text-[12px] text-muted">
                        {u.email}
                      </span>
                    </span>
                  </div>
                </Td>
                <Td>
                  <select
                    className="rounded-lg border border-line bg-transparent px-2 py-1 text-[12.5px] text-navy"
                    value={u.role}
                    disabled={
                      task.busy || u.role === "Quản trị viên"
                    }
                    onChange={(e) =>
                      patch(u.id, { role: e.target.value as AppUser["role"] })
                    }
                    aria-label="Vai trò"
                  >
                    {roles.map((r) => (
                      <option key={r}>{r}</option>
                    ))}
                  </select>
                  <p className="mt-1 text-[11px] text-muted">
                    Quyền thật: {u.role}
                  </p>
                </Td>
                <Td>
                  <Badge tone="gold">{u.licenseClass}</Badge>
                </Td>
                <Td className="text-text-secondary">{u.questions ?? "—"}</Td>
                <Td className="text-muted">{u.joined}</Td>
                <Td>
                  <Toggle
                    checked={u.active}
                    disabled={
                      task.busy || u.role === "Quản trị viên"
                    }
                    onChange={(v) => patch(u.id, { active: v })}
                    label="Kích hoạt"
                  />
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

    </Page>
  );
}
