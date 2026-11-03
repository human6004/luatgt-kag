import { api,send } from '../api'
import { useData,useTask,Notice } from './server/shared'
import { useInspection } from './server/KagManagement'
import { loadKagStatus,loadBuilderStatus,loadSampleInspection } from './server/kag-inspection'
import { Link } from 'react-router-dom'
import { useAdmin } from '../admin/store'
import { Badge, Button, Card, NavLinkButton, Page, Progress } from '../admin/ui'
import { jobTone } from './AdminPipeline'

export default function AdminDashboard() {
  const {jobs,runTask,notify}=useAdmin(),task=useTask()
  const report=useData<Record<string,number>>('/admin/reports')
  const data=useData<{id:string;question:string;state:string;feedback:string|null;resolved:boolean}[]>('/admin/chatlogs?pending=false')
  const kag=useInspection(loadKagStatus), builder=useInspection(loadBuilderStatus), sample=useInspection(loadSampleInspection)
  const logs=(data.value||[]).map(r=>({...r,status:r.feedback==='WRONG'?'Phản hồi sai':r.feedback==='OUTDATED'?'Văn bản hết hiệu lực':r.state==='ANSWERED'&&r.feedback!=='NO_BASIS'?'Đã trả lời':r.state==='KAG_ABSTAINED'||r.feedback==='NO_BASIS'?'Không có căn cứ':r.state}))
  const issues=logs.filter(l=>!l.resolved)
  const evalJob=jobs.find(j=>j.taskId==='eval'&&j.status==='running')
  const stats=[
    {label:'Chat được báo cáo',value:report.value?.chatMessages??'—',sub:'Chỉ các phản hồi sai, thiếu căn cứ, lỗi thời'},
    {label:'Báo cáo đã xử lý',value:report.value?report.value.chatMessages-report.value.pendingChats:'—',sub:'Trong các báo cáo của người dùng'},
    {label:'Câu cần xử lý',value:report.value?.pendingChats??'—',sub:'Theo dữ liệu backend',warn:!!issues.length},
    {label:'Độ trễ trung bình',value:'Chưa đo',sub:'API chưa cung cấp thời gian xử lý'},
  ]
  const actionFor = (status: string) =>
    status === 'Không có căn cứ' ? 'Bổ sung' : status === 'Phản hồi sai' ? 'Xem xét' : 'Cập nhật'

  return (
    <Page title="Tổng quan hệ thống" subtitle="Tình trạng trợ lý, đồ thị tri thức và chất lượng câu trả lời.">
      <Notice {...report} retry={report.reload}/><Notice {...data} retry={data.reload}/><Notice error={task.error}/>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4 mb-5">
        {stats.map((s) => (
          <Card key={s.label} className="grid grid-rows-[auto_1fr_auto] gap-2 p-5">
            <p className="text-xs leading-5 text-muted">{s.label}</p>
            <p className={`self-center text-3xl leading-tight font-semibold tracking-tight tabular-nums ${s.warn ? 'text-accent-strong' : 'text-navy'}`}>{s.value}</p>
            <p className="text-[11.5px] leading-5 text-muted">{s.sub}</p>
          </Card>
        ))}
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
        <Card title="Câu hỏi cần bổ sung tri thức" flush right={<Link to="/admin/chatlogs" className="text-xs font-medium text-accent-strong underline underline-offset-4 hover:text-navy">Xem phản hồi →</Link>}>
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
                    <td className="px-5 py-3"><Badge tone={row.status === 'Phản hồi sai' ? 'red' : row.status === 'Không có căn cứ' ? 'amber' : 'gray'}>{row.status}</Badge></td>
                    <td className="px-5 py-3 text-right whitespace-nowrap">
                      <div className="inline-flex items-center gap-2">
                        <NavLinkButton size="sm" to={row.status === 'Phản hồi sai' ? '/admin/chatlogs' : '/admin/knowledge'}>{actionFor(row.status)}</NavLinkButton>
                        <Button size="sm" variant="outline" disabled={task.busy} title="Đánh dấu báo cáo đã xử lý" onClick={() => { void task.run(async()=>{await api(`/admin/chatlogs/${row.id}/resolve`,send('POST',{note:''}));data.reload();report.reload();notify('Đã đánh dấu đã xử lý')}) }}>Hoàn tất</Button>
                      </div>
                    </td>
                  </tr>
                ))}
                {!issues.length && <tr><td colSpan={3} className="px-5 py-8 text-center text-sm text-muted">{data.value?'Không có câu tồn đọng trong danh sách đã đọc.':'Chưa đọc được danh sách câu hỏi.'}</td></tr>}
              </tbody>
            </table>
          </div>
        </Card>

        <div className="space-y-5">
          <Card title="Tình trạng pipeline KAG">
            <div className="px-5 pb-5 space-y-3">
              <Row label="Dịch vụ KAG"><span className="text-xs">{kag.value?.queryReadiness.state??'Chưa đọc được trạng thái'}</span></Row>
              <Row label="Đồ thị tri thức"><span className="text-xs">{sample.value?`${sample.value.counts.nodes} node SAMPLE`:'Chưa đọc được graph'}</span></Row>
              <Row label="Bộ câu hỏi kiểm thử">
                <Link className="text-xs underline underline-offset-4 hover:text-navy" to="/admin/benchmark">Xem kết quả thực đo →</Link>
              </Row>
              <Notice {...kag} retry={kag.reload}/><Notice {...sample} retry={sample.reload}/>
              {evalJob && (
                <div>
                  <Progress value={evalJob.progress} />
                  <p className="mt-1 text-[11.5px] text-muted">Đang chạy… {evalJob.progress}%</p>
                </div>
              )}
              <Button variant="dark" className="w-full py-2.5" disabled={!!evalJob} onClick={() => runTask('eval', { onDone: () => notify('Demo: mô phỏng hoàn tất; chưa chạy kiểm thử server') })}>
                {evalJob ? 'Đang chạy bộ kiểm thử…' : 'Chạy bộ kiểm thử · Demo'}
              </Button>
            </div>
          </Card>

          <Card title="Tác vụ gần đây" right={<Link to="/admin/pipeline" className="text-xs font-medium text-accent-strong underline underline-offset-4 hover:text-navy">Pipeline →</Link>}>
            <ul className="px-5 pb-4 space-y-2.5"><li className="text-xs"><Notice {...builder} retry={builder.reload}/>{builder.value&&<>Builder thật: {builder.value.state} · {builder.value.run_id??'Chưa có run'}</>}</li>
              {jobs.slice(0, 4).map((j) => (
                <li key={j.id} className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate text-[13px] text-text-secondary">{j.title} · Demo</span>
                  <Badge tone={jobTone[j.status][0]}>{jobTone[j.status][1]}</Badge>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </div><details className="mt-5 text-xs"><summary>Số liệu nghiệp vụ từ server</summary>{Object.entries(report.value||{}).map(([k,v])=><p key={k}>{k}: {v}</p>)}</details>
    </Page>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-1 text-left sm:grid-cols-2 sm:gap-3">
      <span className="text-[13px] leading-5 text-text-secondary">{label}</span>
      <div className="min-w-0 break-words leading-5 sm:text-right">{children}</div>
    </div>
  )
}
