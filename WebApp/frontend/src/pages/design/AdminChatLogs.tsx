import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAdmin, type ChatLog } from "../../admin/store";
import { Badge, Button, Card, Page, inputCls, type Tone } from "../../admin/ui";

const statusTone: Record<ChatLog["status"], Tone> = {
  "Đã trả lời": "green",
  "Không có căn cứ": "amber",
  "Phản hồi sai": "red",
  "Văn bản hết hiệu lực": "gray",
};

export default function AdminChatLogs() {
  const { logs, setLogs, notify } = useAdmin();
  const nav = useNavigate();
  const [q, setQ] = useState("");
  const [tab, setTab] = useState<"all" | "issue" | "down">("all");
  const [sel, setSel] = useState<string | null>(logs[1]?.id ?? null);
  const [note, setNote] = useState("");

  const shown = useMemo(
    () =>
      logs.filter((l) => {
        if (tab === "issue" && (l.status === "Đã trả lời" || l.resolved))
          return false;
        if (tab === "down" && l.feedback !== "down") return false;
        return (l.question + l.user).toLowerCase().includes(q.toLowerCase());
      }),
    [logs, tab, q],
  );
  const cur = logs.find((l) => l.id === sel);

  function exportCsv() {
    const rows = [
      [
        "thời gian",
        "người dùng",
        "câu hỏi",
        "trạng thái",
        "độ trễ",
        "phản hồi",
      ],
      ...logs.map((l) => [
        l.time,
        l.user,
        l.question,
        l.status,
        l.latency,
        l.feedback ?? "",
      ]),
    ];
    const csv = rows
      .map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(","))
      .join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv" }));
    a.download = "nhat-ky-chat.csv";
    a.click();
  }

  return (
    <Page
      title="Nhật ký chat"
      subtitle="Theo dõi câu hỏi, đánh giá phản hồi và chuyển câu chưa trả lời được sang bổ sung tri thức."
      actions={<Button onClick={exportCsv}>Xuất CSV</Button>}
    >
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3 mb-4">
            <div className="flex rounded-xl border border-line bg-surface p-0.5">
              {(
                [
                  ["all", "Tất cả"],
                  ["issue", "Cần xử lý"],
                  ["down", "Đánh giá 👎"],
                ] as const
              ).map(([k, l]) => (
                <button
                  key={k}
                  onClick={() => setTab(k)}
                  className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${tab === k ? "bg-selected text-navy" : "text-muted hover:text-navy"}`}
                >
                  {l}
                  {k === "issue" && (
                    <span className="ml-1 text-accent-strong">
                      {
                        logs.filter(
                          (x) => x.status !== "Đã trả lời" && !x.resolved,
                        ).length
                      }
                    </span>
                  )}
                </button>
              ))}
            </div>
            <input
              className={`${inputCls} max-w-xs`}
              placeholder="Tìm theo câu hỏi, người dùng…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <Card>
            <ul className="divide-y divide-line/70">
              {shown.map((l) => (
                <li key={l.id}>
                  <button
                    onClick={() => setSel(l.id)}
                    className={`w-full text-left px-5 py-3.5 transition-colors ${l.id === sel ? "bg-selected/60" : "hover:bg-bg"}`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <p className="text-[13.5px] font-medium text-navy">
                        {l.question}
                      </p>
                      <Badge
                        tone={
                          l.resolved && l.status !== "Đã trả lời"
                            ? "green"
                            : statusTone[l.status]
                        }
                      >
                        {l.resolved && l.status !== "Đã trả lời"
                          ? "Đã xử lý"
                          : l.status}
                      </Badge>
                    </div>
                    <p className="mt-1 text-[12px] text-muted">
                      @{l.user} · {l.time} · {l.latency}s{" "}
                      {l.feedback === "up"
                        ? "· 👍"
                        : l.feedback === "down"
                          ? "· 👎"
                          : ""}
                    </p>
                  </button>
                </li>
              ))}
              {!shown.length && (
                <li className="px-5 py-8 text-center text-sm text-muted">
                  Không có bản ghi.
                </li>
              )}
            </ul>
          </Card>
        </div>

        <Card
          title="Chi tiết hội thoại"
          className="self-start lg:sticky lg:top-6"
        >
          {cur ? (
            <div className="px-5 pb-5 space-y-4">
              <div className="flex justify-end">
                <p className="max-w-[85%] rounded-2xl rounded-br-md bg-selected px-3.5 py-2.5 text-[13.5px] text-navy">
                  {cur.question}
                </p>
              </div>
              <p className="text-[13.5px] leading-relaxed text-text-secondary border-l-2 border-line pl-3">
                {cur.answer}
              </p>
              <dl className="grid grid-cols-3 gap-2 text-center">
                {[
                  ["Độ trễ", cur.latency + "s"],
                  [
                    "Phản hồi",
                    cur.feedback === "up"
                      ? "👍"
                      : cur.feedback === "down"
                        ? "👎"
                        : "—",
                  ],
                  ["Người dùng", "@" + cur.user],
                ].map(([k, v]) => (
                  <div
                    key={k}
                    className="rounded-xl border border-line bg-bg py-2"
                  >
                    <dt className="text-[10.5px] uppercase tracking-wide text-muted">
                      {k}
                    </dt>
                    <dd className="text-[13px] font-semibold text-navy truncate px-1">
                      {v}
                    </dd>
                  </div>
                ))}
              </dl>
              <textarea
                rows={2}
                className={inputCls}
                placeholder="Ghi chú cho biên tập viên…"
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
              <div className="flex flex-wrap gap-2">
                {!cur.resolved && (
                  <Button
                    variant="primary"
                    onClick={() => {
                      setLogs((ls) =>
                        ls.map((l) =>
                          l.id === cur.id ? { ...l, resolved: true } : l,
                        ),
                      );
                      setNote("");
                      notify("Đã đánh dấu đã xử lý");
                    }}
                  >
                    Đánh dấu đã xử lý
                  </Button>
                )}
                <Button onClick={() => nav("/admin/knowledge")}>
                  Bổ sung văn bản
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => notify("Đã gửi lại câu hỏi tới KAG solver")}
                >
                  Chạy lại
                </Button>
              </div>
            </div>
          ) : (
            <p className="px-5 pb-5 text-sm text-muted">Chọn một hội thoại.</p>
          )}
        </Card>
      </div>
    </Page>
  );
}
