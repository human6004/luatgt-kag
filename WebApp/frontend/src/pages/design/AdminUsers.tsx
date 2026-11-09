import { useState } from "react";
import { useAdmin, type AppUser } from "../../admin/store";
import {
  Badge,
  Button,
  Card,
  Field,
  Modal,
  Page,
  Td,
  Th,
  Toggle,
  inputCls,
} from "../../admin/ui";

const roles: AppUser["role"][] = [
  "Người học",
  "Biên tập viên",
  "Quản trị viên",
];

export default function AdminUsers() {
  const { users, setUsers, notify } = useAdmin();
  const [q, setQ] = useState("");
  const [role, setRole] = useState("all");
  const [inviteOpen, setInviteOpen] = useState(false);
  const [draft, setDraft] = useState({
    name: "",
    email: "",
    role: roles[0] as AppUser["role"],
  });
  const shown = users.filter(
    (u) =>
      (role === "all" || u.role === role) &&
      (u.name + u.email).toLowerCase().includes(q.toLowerCase()),
  );
  const patch = (id: string, p: Partial<AppUser>) =>
    setUsers((us) => us.map((u) => (u.id === id ? { ...u, ...p } : u)));

  return (
    <Page
      title="Người dùng"
      subtitle={`${users.length} tài khoản · ${users.filter((u) => u.active).length} đang hoạt động`}
      actions={
        <Button variant="primary" onClick={() => setInviteOpen(true)}>
          + Mời người dùng
        </Button>
      }
    >
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
      <div className="flex flex-wrap gap-3 mb-4">
        <input
          className={`${inputCls} max-w-xs`}
          placeholder="Tìm tên, email…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <select
          className={`${inputCls} max-w-[200px]`}
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
      <Card className="overflow-x-auto">
        <table className="w-full min-w-[760px]">
          <thead className="border-b border-line">
            <tr>
              <Th>Người dùng</Th>
              <Th>Vai trò</Th>
              <Th>Hạng ôn</Th>
              <Th>Lượt hỏi</Th>
              <Th>Tham gia</Th>
              <Th>Hoạt động</Th>
              <Th />
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
                    onChange={(e) => {
                      patch(u.id, { role: e.target.value as AppUser["role"] });
                      notify("Đã đổi vai trò");
                    }}
                    aria-label="Vai trò"
                  >
                    {roles.map((r) => (
                      <option key={r}>{r}</option>
                    ))}
                  </select>
                </Td>
                <Td>
                  <Badge tone="gold">{u.licenseClass}</Badge>
                </Td>
                <Td className="text-text-secondary">{u.questions}</Td>
                <Td className="text-muted">{u.joined}</Td>
                <Td>
                  <Toggle
                    checked={u.active}
                    onChange={(v) => {
                      patch(u.id, { active: v });
                      notify(v ? "Đã mở khoá tài khoản" : "Đã khoá tài khoản");
                    }}
                    label="Kích hoạt"
                  />
                </Td>
                <Td className="text-right whitespace-nowrap">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      notify(`Đã gửi email đặt lại mật khẩu tới ${u.email}`)
                    }
                  >
                    Đặt lại MK
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={() => {
                      setUsers((us) => us.filter((x) => x.id !== u.id));
                      notify("Đã xoá tài khoản");
                    }}
                  >
                    Xoá
                  </Button>
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Modal
        open={inviteOpen}
        title="Mời người dùng"
        onClose={() => setInviteOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setInviteOpen(false)}>
              Huỷ
            </Button>
            <Button
              variant="primary"
              disabled={!draft.name.trim() || !/\S+@\S+/.test(draft.email)}
              onClick={() => {
                setUsers((us) => [
                  {
                    id: "u" + Date.now(),
                    ...draft,
                    licenseClass: "B",
                    questions: 0,
                    active: true,
                    joined: new Date().toLocaleDateString("vi-VN"),
                  },
                  ...us,
                ]);
                setDraft({ name: "", email: "", role: roles[0] });
                setInviteOpen(false);
                notify("Đã gửi lời mời");
              }}
            >
              Gửi lời mời
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="Họ tên">
            <input
              className={inputCls}
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              autoFocus
            />
          </Field>
          <Field label="Email">
            <input
              type="email"
              className={inputCls}
              value={draft.email}
              onChange={(e) => setDraft({ ...draft, email: e.target.value })}
            />
          </Field>
          <Field label="Vai trò">
            <select
              className={inputCls}
              value={draft.role}
              onChange={(e) =>
                setDraft({ ...draft, role: e.target.value as AppUser["role"] })
              }
            >
              {roles.map((r) => (
                <option key={r}>{r}</option>
              ))}
            </select>
          </Field>
        </div>
      </Modal>
    </Page>
  );
}
