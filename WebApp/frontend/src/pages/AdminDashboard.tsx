import { api, send } from "../api";
import { useData, useTask, Notice } from "./shared/shared";
import { useInspection } from "./shared/KagManagement";
import {
  builderStateLabel,
  loadKagStatus,
  loadBuilderStatus,
  loadServing,
  type KagCheck,
} from "./shared/kag-inspection";
import { Link, useNavigate } from "react-router-dom";
import { useAdmin } from "../admin/store";
import { Badge, Button, Card, NavLinkButton, Page } from "../admin/ui";

const checkText = (check: KagCheck) =>
  check.httpStatus === 504 || check.code?.includes("TIMEOUT")
    ? "Chưa kiểm tra xong"
    : check.state === "ALIVE"
      ? "Kết nối được"
      : check.state === "READY"
        ? "Đạt kiểm tra điều kiện"
        : check.state === "NOT_CONFIGURED"
          ? "Chưa cấu hình"
          : check.state === "RELEASE_UNAVAILABLE"
            ? "Chưa có dữ liệu phục vụ"
            : check.state === "NOT_READY"
              ? "Còn điều kiện cần xử lý"
              : "Chưa khả dụng";

export default function AdminDashboard() {
  const { notify } = useAdmin(),
    nav = useNavigate(),
    task = useTask();
  const report = useData<Record<string, number>>("/admin/reports");
  const data = useData<
    { id: string; question: string; state: string; feedback: string | null; resolved: boolean }[]
  >("/admin/chatlogs?pending=false");
  const kag = useInspection(loadKagStatus),
    builder = useInspection(loadBuilderStatus),
    serving = useInspection(loadServing);

  const active = serving.value?.active;
  const activeRun = serving.value?.runs.find(
    (r) => r.project_id === active?.project_id && r.run_id === active?.run_id,
  );
  const runtimeReady = kag.value?.queryReadiness.state === "READY";
  const servingBlocked =
    !!serving.value &&
    (!active || !serving.value.runtime_ready || serving.value.chat_blockers.length > 0);
  const chatReady = runtimeReady && !servingBlocked;
  const rawReleaseId =
    kag.value?.queryReadiness.evidence?.release_id ?? kag.value?.release.evidence?.release_id;
  const releaseId = typeof rawReleaseId === "string" && rawReleaseId ? rawReleaseId : null;
  const shortReleaseId =
    releaseId && releaseId.length > 18 ? `${releaseId.slice(0, 16)}…` : releaseId;

  const graphTitle =
    serving.loading && kag.loading
      ? "—"
      : serving.value
        ? active
          ? active.project_name
          : "Chưa chọn"
        : (shortReleaseId ??
          (runtimeReady || kag.value?.release.state === "READY"
            ? "Đang phục vụ"
            : "Chưa có dữ liệu"));

  const graphSub = serving.value
    ? activeRun
      ? `${activeRun.nodes.toLocaleString("vi-VN")} nội dung · ${activeRun.edges.toLocaleString("vi-VN")} quan hệ`
      : active
        ? `Phiên ${active.run_id}`
        : "Chọn ở trang Chatbot (bước ③)"
    : serving.error && (shortReleaseId || runtimeReady || kag.value?.release.state === "READY")
      ? "Đang phục vụ · đăng nhập OpenSPG để xem tên project"
      : "Xem chi tiết ở trang Chatbot (bước ③)";

  const logs = (data.value || []).map((r) => ({
    ...r,
    status:
      r.feedback === "WRONG"
        ? "Phản hồi sai"
        : r.feedback === "OUTDATED"
          ? "Văn bản hết hiệu lực"
          : r.state === "ANSWERED" && r.feedback !== "NO_BASIS"
            ? "Đã trả lời"
            : r.state === "KAG_ABSTAINED" || r.feedback === "NO_BASIS"
              ? "Không có căn cứ"
              : r.state,
  }));
  const issues = logs.filter((l) => !l.resolved);

  const stats = [
    {
      label: "Trạng thái Chat",
      value: kag.loading
        ? "—"
        : kag.error
          ? "Chưa đọc được"
          : chatReady
            ? "Sẵn sàng"
            : "Chưa sẵn sàng",
      sub: kag.value ? checkText(kag.value.queryReadiness) : "Đang đọc trạng thái dịch vụ",
      warn: !kag.loading && !chatReady,
    },
    {
      label: "Đồ thị đang dùng",
      value: graphTitle,
      sub: graphSub,
      warn:
        !serving.loading &&
        !kag.loading &&
        ((!!serving.value && !active) ||
          (!serving.value &&
            !shortReleaseId &&
            !runtimeReady &&
            kag.value?.release.state !== "READY")),
    },
    {
      label: "Chat được báo cáo",
      value: report.value?.chatMessages ?? "—",
      sub: report.value
        ? `Đã xử lý: ${report.value.chatMessages - report.value.pendingChats}`
        : "Chỉ các phản hồi sai, thiếu căn cứ, lỗi thời",
    },
    {
      label: "Câu cần xử lý",
      value: report.value?.pendingChats ?? "—",
      sub: "Theo dữ liệu backend",
      warn: !!issues.length,
    },
  ];
  const actionFor = (status: string) =>
    status === "Không có căn cứ" ? "Bổ sung" : status === "Phản hồi sai" ? "Xem xét" : "Cập nhật";

  return (
    <Page
      title="Tổng quan hệ thống"
      subtitle="Tình trạng trợ lý, đồ thị tri thức đang phục vụ và câu hỏi cần xử lý."
      actions={
        <Link to="/chat" className="text-xs font-medium text-accent-strong hover:underline">
          Mở trang Hỏi luật ↗
        </Link>
      }
    >
      <Notice {...report} retry={report.reload} />
      <Notice {...data} retry={data.reload} />
      <Notice error={task.error} />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4 mb-5">
        {stats.map((s) => (
          <Card key={s.label} className="grid grid-rows-[auto_1fr_auto] gap-2 p-5">
            <p className="text-xs leading-5 text-muted">{s.label}</p>
            <p
              title={s.label === "Đồ thị đang dùng" ? (releaseId ?? String(s.value)) : undefined}
              className={`min-w-0 self-center text-2xl sm:text-3xl leading-tight font-semibold tracking-tight tabular-nums break-words ${s.warn ? "text-accent-strong" : "text-navy"}`}
            >
              {s.value}
            </p>
            <p className="text-[11.5px] leading-5 text-muted">{s.sub}</p>
          </Card>
        ))}
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
        <Card
          title="Câu hỏi cần bổ sung tri thức"
          flush
          right={
            <Link
              to="/admin/users?tab=logs"
              className="text-xs font-medium text-accent-strong underline underline-offset-4 hover:text-navy"
            >
              Xem nhật ký →
            </Link>
          }
        >
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px]">
              <thead>
                <tr className="text-[11.5px] uppercase tracking-wide text-muted border-y border-line">
                  <th className="text-left px-5 py-2.5 font-medium">Câu hỏi người dùng</th>
                  <th className="text-left px-5 py-2.5 font-medium">Lý do</th>
                  <th className="text-right px-5 py-2.5 font-medium">Thao tác</th>
                </tr>
              </thead>
              <tbody>
                {issues.map((row) => (
                  <tr key={row.id} className="border-b border-line/60 last:border-0">
                    <td className="px-5 py-3 text-[13.5px] text-navy">{row.question}</td>
                    <td className="px-5 py-3">
                      <Badge
                        tone={
                          row.status === "Phản hồi sai"
                            ? "red"
                            : row.status === "Không có căn cứ"
                              ? "amber"
                              : "gray"
                        }
                      >
                        {row.status}
                      </Badge>
                    </td>
                    <td className="px-5 py-3 text-right whitespace-nowrap">
                      <div className="inline-flex items-center gap-2">
                        <NavLinkButton
                          size="sm"
                          to={
                            row.status === "Phản hồi sai"
                              ? `/admin/users?tab=logs&log=${encodeURIComponent(row.id)}`
                              : "/admin/content?tab=documents"
                          }
                        >
                          {actionFor(row.status)}
                        </NavLinkButton>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={task.busy}
                          title="Đánh dấu báo cáo đã xử lý"
                          onClick={() => {
                            void task.run(async () => {
                              await api(
                                `/admin/chatlogs/${row.id}/resolve`,
                                send("POST", { note: "" }),
                              );
                              data.reload();
                              report.reload();
                              notify("Đã đánh dấu đã xử lý");
                            });
                          }}
                        >
                          Hoàn tất
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
                {!issues.length && (
                  <tr>
                    <td colSpan={3} className="px-5 py-8 text-center text-sm text-muted">
                      {data.value
                        ? "Không có câu tồn đọng trong danh sách đã đọc."
                        : "Chưa đọc được danh sách câu hỏi."}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>

        <div className="space-y-5">
          <Card
            title="Tình trạng Chatbot & KAG"
            right={
              <button
                onClick={() => nav("/admin/chatbot")}
                className="text-xs font-medium text-accent-strong hover:underline"
              >
                Chatbot →
              </button>
            }
          >
            <div className="px-5 pb-5 space-y-3">
              <Row label="Điều kiện Chat">
                <span className={`text-xs ${runtimeReady ? "text-emerald-700" : "text-amber-800"}`}>
                  {kag.value ? checkText(kag.value.queryReadiness) : "Chưa đọc được trạng thái"}
                </span>
              </Row>
              <Row label="Đồ thị đang phục vụ">
                <span className="text-xs">
                  {serving.loading
                    ? "Đang đọc…"
                    : serving.value
                      ? active
                        ? `${active.project_name}${activeRun ? ` (${activeRun.nodes.toLocaleString("vi-VN")} nội dung)` : ""}`
                        : "Chưa chọn đồ thị"
                      : (releaseId ?? "Chưa đọc được")}
                </span>
              </Row>
              <Row label="Chẩn đoán & kiểm thử">
                <span className="inline-flex flex-wrap justify-end gap-2 text-xs">
                  <button className="underline" onClick={() => nav("/admin/infrastructure")}>
                    Kết nối
                  </button>
                  <span>·</span>
                  <button className="underline" onClick={() => nav("/admin/benchmark")}>
                    Benchmark
                  </button>
                </span>
              </Row>
              <Notice {...kag} retry={kag.reload} />
              <Notice {...serving} retry={serving.reload} />
            </div>
          </Card>

          <Card
            title="Tiến trình dựng đồ thị"
            right={
              <button
                onClick={() => nav("/admin/chatbot?step=2")}
                className="text-xs font-medium text-accent-strong hover:underline"
              >
                Dựng đồ thị →
              </button>
            }
          >
            <div className="px-5 pb-4 text-xs space-y-2">
              <Notice {...builder} retry={builder.reload} />
              {builder.value && (
                <p className="text-text-secondary leading-5">
                  Trạng thái Builder:{" "}
                  <strong className="text-navy">{builderStateLabel(builder.value.state)}</strong>
                  {builder.value.run_id
                    ? ` · ${builder.value.run_id}`
                    : " · Chưa có phiên đang chạy"}
                </p>
              )}
            </div>
          </Card>
        </div>
      </div>
      <details className="mt-5 text-xs">
        <summary className="cursor-pointer underline text-muted">
          Số liệu nghiệp vụ từ server
        </summary>
        {Object.entries(report.value || {}).map(([k, v]) => (
          <p key={k} className="mt-1">
            {k}: {v}
          </p>
        ))}
      </details>
    </Page>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-1 text-left sm:grid-cols-2 sm:gap-3">
      <span className="text-[13px] leading-5 text-text-secondary">{label}</span>
      <div className="min-w-0 break-words leading-5 sm:text-right">{children}</div>
    </div>
  );
}
