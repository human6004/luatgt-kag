import { useNavigate } from "react-router-dom";
import { useAdmin } from "../../admin/store";
import { Badge, Button, Card, Page, Progress } from "../../admin/ui";
import { jobTone } from "../AdminPipeline";

export default function AdminDashboard() {
  const { logs, setLogs, docs, jobs, runTask, lastEval, notify } = useAdmin();
  const nav = useNavigate();
  const issues = logs.filter((l) => l.status !== "Đã trả lời" && !l.resolved);
  const rated = logs.filter((l) => l.feedback);
  const helpful = rated.length
    ? Math.round(
        (rated.filter((l) => l.feedback === "up").length / rated.length) * 100,
      )
    : 0;
  const avgLatency = (
    logs.reduce((a, l) => a + l.latency, 0) / logs.length
  ).toFixed(1);
  const evalJob = jobs.find(
    (j) => j.taskId === "eval" && j.status === "running",
  );
  const indexed = docs.filter((d) => d.status === "Đã lập chỉ mục").length;

  const stats = [
    {
      label: "Lượt hỏi gần đây",
      value: logs.length,
      sub: "+12% so với tuần trước",
    },
    {
      label: "Tỷ lệ phản hồi hữu ích",
      value: helpful + "%",
      sub: `${rated.length} lượt đánh giá`,
    },
    {
      label: "Câu chưa trả lời được",
      value: issues.length,
      sub: "cần bổ sung tri thức",
      warn: issues.length > 0,
    },
    {
      label: "Độ trễ trung bình",
      value: avgLatency + " s",
      sub: "mục tiêu < 3 s",
    },
  ];

  const actionFor = (status: string) =>
    status === "Không có căn cứ"
      ? "Bổ sung"
      : status === "Phản hồi sai"
        ? "Xem xét"
        : "Cập nhật";

  return (
    <Page
      title="Tổng quan hệ thống"
      subtitle="Tình trạng trợ lý, đồ thị tri thức và chất lượng câu trả lời."
    >
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4 mb-5">
        {stats.map((s) => (
          <Card key={s.label} className="p-5">
            <p className="text-xs text-muted mb-2">{s.label}</p>
            <p
              className={`text-3xl font-semibold tracking-tight ${s.warn ? "text-accent-strong" : "text-navy"}`}
            >
              {s.value}
            </p>
            <p className="mt-1 text-[11.5px] text-muted">{s.sub}</p>
          </Card>
        ))}
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
        <Card
          title="Câu hỏi cần bổ sung tri thức"
          right={
            <button
              onClick={() => nav("/admin/chatlogs")}
              className="text-xs font-medium text-accent-strong hover:underline"
            >
              Xem nhật ký →
            </button>
          }
        >
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px]">
              <thead>
                <tr className="text-[11.5px] uppercase tracking-wide text-muted border-y border-line">
                  <th className="text-left px-5 py-2.5 font-medium">
                    Câu hỏi người dùng
                  </th>
                  <th className="text-left px-5 py-2.5 font-medium">Lý do</th>
                  <th className="text-right px-5 py-2.5 font-medium">
                    Thao tác
                  </th>
                </tr>
              </thead>
              <tbody>
                {issues.map((row) => (
                  <tr
                    key={row.id}
                    className="border-b border-line/60 last:border-0"
                  >
                    <td className="px-5 py-3 text-[13.5px] text-navy">
                      {row.question}
                    </td>
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
                      <div className="flex items-center justify-end gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            nav(
                              row.status === "Phản hồi sai"
                                ? "/admin/chatlogs"
                                : "/admin/knowledge",
                            )
                          }
                        >
                          {actionFor(row.status)}
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="w-8 px-0"
                          title="Đánh dấu đã xử lý"
                          aria-label={`Đánh dấu đã xử lý: ${row.question}`}
                          onClick={() => {
                            setLogs((ls) =>
                              ls.map((l) =>
                                l.id === row.id ? { ...l, resolved: true } : l,
                              ),
                            );
                            notify("Đã đánh dấu đã xử lý");
                          }}
                        >
                          ✓
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
                {!issues.length && (
                  <tr>
                    <td
                      colSpan={3}
                      className="px-5 py-8 text-center text-sm text-muted"
                    >
                      Tuyệt vời — không còn câu nào tồn đọng.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>

        <div className="space-y-5">
          <Card title="Tình trạng pipeline KAG">
            <div className="px-5 pb-5 space-y-3">
              <Row label="Dịch vụ KAG">
                <Badge tone="green">Hoạt động</Badge>
              </Row>
              <Row label="Đồ thị tri thức">
                <Badge tone="green">{indexed} văn bản</Badge>
              </Row>
              <Row label="Bộ câu hỏi kiểm thử">
                {lastEval ? (
                  <span className="text-[13px] font-semibold text-navy">
                    hit@20 {lastEval.hit.toFixed(3)}
                  </span>
                ) : (
                  <Badge>Chưa chạy</Badge>
                )}
              </Row>
              {lastEval && (
                <p className="text-[11.5px] text-muted -mt-1 text-right">
                  lần cuối {lastEval.time}
                </p>
              )}
              {evalJob && (
                <div>
                  <Progress value={evalJob.progress} />
                  <p className="mt-1 text-[11.5px] text-muted">
                    Đang chạy… {evalJob.progress}%
                  </p>
                </div>
              )}
              <Button
                variant="dark"
                className="w-full py-2.5"
                disabled={!!evalJob}
                onClick={() =>
                  runTask("eval", {
                    onDone: () => notify("Đã chạy xong bộ kiểm thử"),
                  })
                }
              >
                {evalJob ? "Đang chạy bộ kiểm thử…" : "Chạy bộ kiểm thử"}
              </Button>
            </div>
          </Card>

          <Card
            title="Tác vụ gần đây"
            right={
              <button
                onClick={() => nav("/admin/pipeline")}
                className="text-xs font-medium text-accent-strong hover:underline"
              >
                Pipeline →
              </button>
            }
          >
            <ul className="px-5 pb-4 space-y-2.5">
              {jobs.slice(0, 4).map((j) => (
                <li
                  key={j.id}
                  className="flex items-center justify-between gap-2"
                >
                  <span className="min-w-0 truncate text-[13px] text-text-secondary">
                    {j.title}
                  </span>
                  <Badge tone={jobTone[j.status][0]}>
                    {jobTone[j.status][1]}
                  </Badge>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </div>
    </Page>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-[13px] text-text-secondary">{label}</span>
      {children}
    </div>
  );
}
