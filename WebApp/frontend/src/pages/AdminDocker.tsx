import { Link } from 'react-router-dom'
import { Notice,useData } from './server/shared'
import { useMemo, useState } from 'react'
import JSZip from 'jszip'
import { useAdmin } from '../admin/store'
import { defaultDockerCfg, generateFiles, serviceList, type DockerCfg } from '../admin/docker'
import { Badge, Button, Card, Field, Page, Progress, Terminal, Toggle, inputCls } from '../admin/ui'

const compare = [
  ['Image', 'spg-registry…/openspg-*:latest (kéo từ Aliyun)', 'kag-legal-*:TAG — build một lần, chia sẻ bằng tệp'],
  ['Mật khẩu', 'Viết cứng trong compose (openspg, neo4j@openspg)', 'Đọc từ .env, mỗi máy tự đổi'],
  ['Dữ liệu', 'Không có volume cho MySQL/MinIO', 'Volume có tên, không mất khi xoá container'],
  ['Thứ tự khởi động', 'depends_on — server có thể chạy trước khi DB sẵn sàng', 'healthcheck + service_healthy'],
  ['Đồ thị', 'Phải chạy restore-final-graph.ps1 thủ công', 'Neo4j tự nạp dumps/legal.dump lần đầu'],
  ['Ứng dụng', 'Chỉ có OpenSPG', 'Kèm API trợ lý + giao diện web (tuỳ chọn)'],
]

export default function AdminDocker() {
  const infrastructure=useData<Record<string,string>>('/admin/infrastructure')
  const { jobs, runTask, notify } = useAdmin()
  const [cfg, setCfg] = useState<DockerCfg>(defaultDockerCfg)
  const files = useMemo(() => generateFiles(cfg), [cfg])
  const names = Object.keys(files).filter((f) => !f.endsWith('.gitkeep'))
  const [active, setActive] = useState('deploy/docker-compose.yml')
  const [jobId, setJobId] = useState<string | null>(null)
  const job = jobs.find((j) => j.id === jobId)
  const set = <K extends keyof DockerCfg>(k: K, v: DockerCfg[K]) => setCfg((c) => ({ ...c, [k]: v }))
  const num = (k: keyof DockerCfg) => (e: React.ChangeEvent<HTMLInputElement>) => set(k, Number(e.target.value) as never)
  const weakPw = [cfg.mysqlPassword, cfg.neo4jPassword, cfg.minioPassword].some((p) => p.length < 8 || /^doi-mat-khau|openspg/.test(p))
  const services = serviceList(cfg)

  async function downloadZip() {
    const zip = new JSZip()
    Object.entries(files).forEach(([p, c]) => zip.file(p, c, p.endsWith('.sh') ? { unixPermissions: '755' } : undefined))
    const blob = await zip.generateAsync({ type: 'blob', platform: 'UNIX' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${cfg.prefix}-deploy-${cfg.tag}.zip`
    a.click()
    notify('Demo: đã tải mẫu deploy ZIP từ trình duyệt; chưa triển khai')
  }

  const run = (t: 'docker-build' | 'docker-pack') =>
    setJobId(runTask(t, { label: `TAG=${cfg.tag}`, onDone: () => notify(t === 'docker-build' ? 'Demo: mô phỏng build image; không chạy Docker' : 'Demo: mô phỏng đóng gói; không tạo bundle thật') }))

  return (
    <Page
      title="Đóng gói Docker"
      subtitle="Trạng thái dịch vụ từ API thật. Form đóng gói: Demo; không build hoặc thay đổi Docker Engine."
      actions={
        <>
          <Button variant="ghost" onClick={() => setCfg(defaultDockerCfg)}>Mặc định</Button>
          <Button onClick={() => navigator.clipboard.writeText(files[active]).then(() => notify('Đã sao chép'))}>Sao chép tệp</Button>
          <Button variant="primary" onClick={downloadZip}>Tải deploy/ (.zip)</Button>
        </>
      }
    >
      <Notice {...infrastructure} retry={infrastructure.reload}/><Card title="Trạng thái dịch vụ · API thật" className="mb-5"><div className="px-5 pb-5 text-sm">{Object.entries(infrastructure.value||{}).map(([k,v])=><p key={k} className="flex justify-between border-b border-line py-2"><span>{k}</span><span>{v}</span></p>)}<Link to="/admin/infrastructure" className="underline underline-offset-4 inline-block mt-3">Kết nối KAG & truy xuất evidence</Link></div></Card><p className="mb-4 text-xs text-muted">Phần đóng gói bên dưới: Demo. Tải ZIP chỉ tạo tệp trong trình duyệt; nút Build/Pack chỉ mô phỏng, không chạy Docker và không dùng dữ liệu luatgt.</p>
      <ol className="mb-5 grid gap-2 sm:grid-cols-4">
        {[
          ['1', 'Cấu hình', 'Tên, cổng, mật khẩu, bộ nhớ'],
          ['2', 'Build', `${services.length} image ${cfg.prefix}-*`],
          ['3', 'Đóng gói', 'docker save → 1 tệp .tar.gz'],
          ['4', 'Chia sẻ', 'Bạn bè chạy install.sh, không cần tải lẻ'],
        ].map(([n, t, d]) => (
          <li key={n} className="flex gap-3 rounded-2xl border border-line bg-surface px-4 py-3">
            <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-navy text-[12px] font-bold text-accent">{n}</span>
            <span><span className="block text-[13px] font-semibold text-navy">{t}</span><span className="block text-[11.5px] text-muted">{d}</span></span>
          </li>
        ))}
      </ol>

      <div className="grid gap-5 xl:grid-cols-[400px_minmax(0,1fr)]">
        <div className="space-y-5">
          <Card title="Định danh image">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 px-5 pb-5">
              <Field label="Tiền tố"><input className={inputCls} value={cfg.prefix} onChange={(e) => set('prefix', e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))} /></Field>
              <Field label="Phiên bản (TAG)"><input className={inputCls} value={cfg.tag} onChange={(e) => set('tag', e.target.value)} /></Field>
              <Field label="Registry riêng" hint="Để trống nếu chỉ chia sẻ bằng tệp"><input className={inputCls} placeholder="ghcr.io/ban/" value={cfg.registry} onChange={(e) => set('registry', e.target.value)} /></Field>
              <Field label="Tag OpenSPG gốc" hint="Ghim phiên bản, tránh :latest"><input className={inputCls} value={cfg.upstreamTag} onChange={(e) => set('upstreamTag', e.target.value)} /></Field>
            </div>
          </Card>

          <Card title="Bảo mật" right={weakPw ? <Badge tone="amber">Mật khẩu yếu</Badge> : <Badge tone="green">OK</Badge>}>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 px-5 pb-5">
              <Field label="MySQL root"><input className={inputCls} value={cfg.mysqlPassword} onChange={(e) => set('mysqlPassword', e.target.value)} /></Field>
              <Field label="Neo4j"><input className={inputCls} value={cfg.neo4jPassword} onChange={(e) => set('neo4jPassword', e.target.value)} /></Field>
              <Field label="MinIO user"><input className={inputCls} value={cfg.minioUser} onChange={(e) => set('minioUser', e.target.value)} /></Field>
              <Field label="MinIO password"><input className={inputCls} value={cfg.minioPassword} onChange={(e) => set('minioPassword', e.target.value)} /></Field>
              <label className="sm:col-span-2 flex flex-wrap items-center gap-2 text-[13px] text-text-secondary">
                <Toggle checked={cfg.exposeDbPorts} onChange={(v) => set('exposeDbPorts', v)} label="Mở cổng DB" /> Mở cổng DB ra mạng LAN <span className="text-muted">(mặc định chỉ 127.0.0.1)</span>
              </label>
            </div>
          </Card>

          <Card title="Thành phần">
            <div className="space-y-3 px-5 pb-5 text-[13px] text-text-secondary">
              <label className="flex items-center gap-2"><Toggle checked={cfg.includeApp} onChange={(v) => set('includeApp', v)} label="API" /> API trợ lý pháp luật (Python KAG)</label>
              <label className="flex items-center gap-2"><Toggle checked={cfg.includeWeb} onChange={(v) => set('includeWeb', v)} label="Web" /> Giao diện web (nginx)</label>
              <label className="flex items-center gap-2"><Toggle checked={cfg.bundleDump} onChange={(v) => set('bundleDump', v)} label="Dump" /> Kèm dữ liệu đồ thị (legal.dump ~1,3 GiB)</label>
            </div>
          </Card>

          <Card title="Cổng & tài nguyên">
            <div className="grid grid-cols-1 sm:grid-cols-2 2xl:grid-cols-3 gap-3 px-5 pb-5">
              <Field label="OpenSPG"><input type="number" className={inputCls} value={cfg.portServer} onChange={num('portServer')} /></Field>
              <Field label="Neo4j HTTP"><input type="number" className={inputCls} value={cfg.portNeo4jHttp} onChange={num('portNeo4jHttp')} /></Field>
              <Field label="Neo4j Bolt"><input type="number" className={inputCls} value={cfg.portNeo4jBolt} onChange={num('portNeo4jBolt')} /></Field>
              <Field label="MySQL"><input type="number" className={inputCls} value={cfg.portMysql} onChange={num('portMysql')} /></Field>
              {cfg.includeApp && <Field label="API"><input type="number" className={inputCls} value={cfg.portApp} onChange={num('portApp')} /></Field>}
              {cfg.includeWeb && <Field label="Web"><input type="number" className={inputCls} value={cfg.portWeb} onChange={num('portWeb')} /></Field>}
              <Field label="Server Xmx (MB)"><input type="number" step={512} className={inputCls} value={cfg.serverHeapMax} onChange={num('serverHeapMax')} /></Field>
              <Field label="Neo4j heap (GB)"><input type="number" className={inputCls} value={cfg.neo4jHeapMax} onChange={num('neo4jHeapMax')} /></Field>
              <Field label="Múi giờ"><input className={inputCls} value={cfg.tz} onChange={(e) => set('tz', e.target.value)} /></Field>
            </div>
            <p className="px-5 pb-4 -mt-2 text-[11.5px] text-muted">RAM tối thiểu ước tính: <b className="text-navy">{Math.ceil(cfg.serverHeapMax / 1024 + cfg.neo4jHeapMax + cfg.neo4jPagecache + 1.5)} GB</b></p>
          </Card>
        </div>

        <div className="min-w-0 space-y-5">
          <Card className="overflow-hidden">
            <div className="flex gap-1 overflow-x-auto border-b border-line px-3 pt-3">
              {names.map((n) => (
                <button key={n} onClick={() => setActive(n)} className={`whitespace-nowrap rounded-t-lg px-3 py-1.5 font-mono text-[11.5px] ${n === active ? 'bg-[#2a241d] text-[#f3e7c7]' : 'text-muted hover:text-navy'}`}>
                  {n.replace('deploy/', '')}
                </button>
              ))}
            </div>
            <Terminal lines={(files[active] ?? '').split('\n')} className="h-[460px] rounded-none" />
          </Card>

          <Card title="Chạy trên máy chủ" right={job?.status === 'running' && <span className="text-xs text-muted">{job.progress}%</span>}>
            <div className="px-5 pb-5">
              <div className="flex flex-wrap gap-2">
                <Button variant="dark" onClick={() => run('docker-build')}>▶ Build image · Demo</Button>
                <Button variant="primary" onClick={() => run('docker-pack')}>▶ Đóng gói để chia sẻ</Button>
              </div>
              {job && (
                <>
                  <Progress value={job.progress} tone={job.status === 'success' ? 'green' : 'accent'} />
                  <Terminal lines={job.logs} className="mt-3 h-48" />
                </>
              )}
              <p className="mt-3 text-[11.5px] text-muted">Máy bạn bè: giải nén <code className="font-mono">{cfg.prefix}-bundle-{cfg.tag}.tar.gz</code> → <code className="font-mono">./install.sh</code> (Windows: <code className="font-mono">install.ps1</code>).</p>
            </div>
          </Card>

          <Card title="So với compose gốc của OpenSPG" flush>
            <div className="overflow-x-auto pb-4">
              <table className="w-full min-w-[560px] text-[12.5px]">
                <thead><tr className="bg-sidebar text-left text-muted"><th className="px-5 py-2 font-medium">Hạng mục</th><th className="px-5 py-2 font-medium">docker-compose-west.yml</th><th className="px-5 py-2 font-medium">deploy/ của mình</th></tr></thead>
                <tbody>
                  {compare.map(([k, a, b]) => (
                    <tr key={k} className="border-t border-line/60 align-top">
                      <td className="px-5 py-2 font-medium text-navy">{k}</td>
                      <td className="px-5 py-2 text-muted">{a}</td>
                      <td className="px-5 py-2 text-text-secondary">{b}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      </div>
    </Page>
  )
}
