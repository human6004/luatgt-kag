import { api, send } from "../api";
import { useData, useTask, Notice } from "./server/shared";
import { useMemo, useState } from "react";
import { useAdmin, type ChatLog } from "../admin/store";
import {
  Badge,
  Button,
  Card,
  FilterTabs,
  NavLinkButton,
  Page,
  inputCls,
  type Tone,
} from "../admin/ui";

const statusTone: Record<ChatLog["status"], Tone> = {
  "Đã trả lời": "green",
  "Không có căn cứ": "amber",
  "Phản hồi sai": "red",
  "Văn bản hết hiệu lực": "gray",
};

export default function AdminChatLogs() {
  const { notify } = useAdmin(),
    task = useTask();
  type Record = {
    id: string;
    ownerId: string;
    question: string;
    answer: string | null;
    state: string;
    feedback: string | null;
    note: string | null;
    resolved: boolean;
    resolution: string | null;
    createdAt: string;
  };
  const data = useData<Record[]>("/admin/chatlogs?pending=false");
  const logs = (data.value || []).map((r) => ({
    ...r,
    user: r.ownerId,
    answer: r.answer || "",
    status:
      r.feedback === "WRONG"
        ? "Phản hồi sai"
        : r.feedback === "OUTDATED"
          ? "Văn bản hết hiệu lực"
          : r.feedback === "NO_BASIS" || r.state === "KAG_ABSTAINED"
            ? "Không có căn cứ"
            : r.state === "ANSWERED"
              ? "Đã trả lời"
              : r.state,
    feedback: r.feedback === "HELPFUL" ? "up" : r.feedback ? "down" : null,
    time: r.createdAt,
    latency: null,
  }));

  const [q, setQ] = useState("");
  const [tab, setTab] = useState<"all" | "issue" | "resolved">("all");
  const [sel, setSel] = useState<string | null>(null);
  const [note, setNote] = useState("");

  const shown = useMemo(
    () =>
      logs.filter((l) => {
        if (tab === "issue" && l.resolved) return false;
        if (tab === "resolved" && !l.resolved) return false;
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
    a.download = "phan-hoi-chat.csv";
    a.click();
  }

  return (
    <Page
      title="Phản hồi chat"
      subtitle="Chỉ hiển thị câu trả lời được người dùng báo sai, thiếu căn cứ hoặc lỗi thời. Lịch sử chat riêng không xuất hiện ở đây."
      actions={
        <Button
          disabled={data.loading || !!data.error || !data.value?.length}
          onClick={exportCsv}
        >
          Xuất CSV
        </Button>
      }
    >
      <Notice {...data} retry={data.reload} />
      <Notice error={task.error} />
      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0">
          <input
            aria-label="Tìm báo cáo"
            className={`${inputCls} mb-3 w-full`}
            placeholder="Tìm theo câu hỏi, người dùng…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <FilterTabs
            label="Lọc trạng thái báo cáo"
            value={tab}
            onChange={setTab}
            className="mb-4"
            items={[
              { value: "all", label: "Tất cả báo cáo" },
              {
                value: "issue",
                label: (
                  <>
                    Cần xử lý{" "}
                    <span className="ml-1 text-accent-strong">
                      {data.value
                        ? logs.filter((x) => !x.resolved).length
                        : "—"}
                    </span>
                  </>
                ),
              },
              { value: "resolved", label: "Đã xử lý" },
            ]}
          />
          <Card>
            <ul className="divide-y divide-line/70">
              {shown.map((l) => (
                <li key={l.id}>
                  <button
                    onClick={() => setSel(l.id)}
                    className={`w-full text-left px-5 py-3.5 transition-colors ${l.id === sel ? "bg-selected/60" : "hover:bg-bg"}`}
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <p className="min-w-0 flex-1 basis-48 break-words text-[13.5px] leading-6 font-medium text-navy">
                        {l.question}
                      </p>
                      <Badge
                        tone={
                          l.resolved && l.status !== "Đã trả lời"
                            ? "green"
                            : statusTone[l.status as ChatLog["status"]] ||
                              "gray"
                        }
                      >
                        {l.resolved && l.status !== "Đã trả lời"
                          ? "Đã xử lý"
                          : l.status}
                      </Badge>
                    </div>
                    <p className="mt-1 break-words text-[12px] leading-5 text-muted">
                      @{l.user} · {l.time} · {l.latency ?? "Chưa đo"}{" "}
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
                  {data.loading
                    ? "Đang tải báo cáo…"
                    : data.error
                      ? "Chưa tải được báo cáo. Vui lòng thử lại."
                      : "Không có báo cáo phù hợp."}
                </li>
              )}
            </ul>
          </Card>
        </div>

        <Card
          title="Chi tiết báo cáo"
          className="self-start xl:sticky xl:top-6"
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
                  ["Độ trễ", "Chưa đo"],
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
              {cur.note && (
                <p className="text-xs">Phản hồi người dùng: {cur.note}</p>
              )}
              {cur.resolution && (
                <p className="text-xs">Ghi chú xử lý: {cur.resolution}</p>
              )}
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
                    disabled={task.busy}
                    variant="primary"
                    onClick={() => {
                      void task.run(async () => {
                        await api(
                          `/admin/chatlogs/${cur.id}/resolve`,
                          send("POST", { note }),
                        );
                        setNote("");
                        data.reload();
                        notify("Đã đánh dấu đã xử lý");
                      });
                    }}
                  >
                    Đánh dấu đã xử lý
                  </Button>
                )}
                <NavLinkButton to="/admin/knowledge" size="sm">
                  Bổ sung văn bản
                </NavLinkButton>
                <Button
                  variant="ghost"
                  onClick={() =>
                    notify("Demo: mô phỏng chạy lại; không gọi KAG solver")
                  }
                >
                  Chạy lại · Demo
                </Button>
              </div>
            </div>
          ) : (
            <p className="px-5 pb-5 text-sm text-muted">Chọn một báo cáo.</p>
          )}
        </Card>
      </div>
    </Page>
  );
}
