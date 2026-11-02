import { BrowserRouter, Routes, Route, Navigate, useLocation, useSearchParams } from 'react-router-dom'
import { AdminProvider, useAdmin } from './admin/store'
import UserLayout from './layouts/UserLayout'
import AdminLayout from './layouts/AdminLayout'
import LoginPage from './pages/LoginPage'
import { AuthProvider, RequireRole, SessionHome, useAuth } from './auth'
import Chat from './pages/ChatPage'
import Study from './pages/ChapterStudyPage'
import Exam from './pages/ExamPage'
import Signs from './pages/SignLibraryPage'
import Dashboard from './pages/AdminDashboard'
import Users from './pages/AdminUsers'
import Logs from './pages/AdminChatLogs'
import Questions from './pages/AdminQuestions'
import Graph from './pages/AdminGraph'
import Sources from './pages/AdminSources'
import Pipeline from './pages/AdminPipeline'
import Benchmark from './pages/AdminBenchmark'
import Docker from './pages/AdminDocker'
import Config from './pages/AdminConfig'
import { ContentManager, Imports as ContentImports } from './pages/server/AdminPages'
import { BuilderGraph } from './pages/server/KagManagement'
import { Infrastructure } from './pages/server/OperationsPages'
import KagSchemaPage from './pages/server/KagSchemaPage'
import { Button } from './admin/ui'

function Toast() {
  const { toast } = useAdmin()
  return toast ? <p role="status" className="fixed bottom-16 left-1/2 -translate-x-1/2 z-[70] max-w-[90vw] rounded-xl bg-navy text-bg px-4 py-2 text-[13px] shadow-lg">{toast}</p> : null
}

function RedirectWithParams({ to, defaults = {}, mapKey = {} }: { to: string; defaults?: Record<string, string>; mapKey?: Record<string, string> }) {
  const { search } = useLocation()
  const incoming = new URLSearchParams(search)
  const next = new URLSearchParams(defaults)
  incoming.forEach((value, key) => {
    next.set(mapKey[key] ?? key, value)
  })
  const qs = next.toString()
  return <Navigate to={qs ? `${to}?${qs}` : to} replace />
}

function GraphRedirect() {
  const { search } = useLocation()
  const params = new URLSearchParams(search)
  const runId = params.get('run_id')
  const projectId = params.get('project_id')
  if (runId && !projectId) {
    return <Navigate to={`/admin/chatbot?step=2&verify_run=${encodeURIComponent(runId)}`} replace />
  }
  const next = new URLSearchParams({ step: '3' })
  params.forEach((value, key) => next.set(key, value))
  return <Navigate to={`/admin/chatbot?${next.toString()}`} replace />
}

function ImportsRedirect({ defaultType }: { defaultType: 'signs' | 'questions' }) {
  const { search } = useLocation()
  const params = new URLSearchParams(search)
  const rawType = params.get('type') ?? defaultType
  const next = new URLSearchParams()
  if (rawType === 'questions') {
    next.set('import', '1')
    params.forEach((v, k) => { if (k !== 'type') next.set(k, v) })
    return <Navigate to={`/admin/questions?${next.toString()}`} replace />
  }
  const tab = rawType === 'documents' || rawType === 'units' || rawType === 'signs' ? rawType : 'signs'
  next.set('tab', tab)
  next.set('import', '1')
  params.forEach((v, k) => { if (k !== 'type') next.set(k, v) })
  return <Navigate to={`/admin/content?${next.toString()}`} replace />
}

// Temporary Batch 2 wrappers (replaced by unified pages in Batches 3 & 4)
function ChatbotShell() {
  const [params, setParams] = useSearchParams()
  const step = params.get('step') === '2' ? '2' : params.get('step') === '3' ? '3' : '1'
  const verifyRun = params.get('verify_run')
  return (
    <div>
      <div className="px-6 sm:px-8 pt-6 max-w-6xl mx-auto">
        <nav aria-label="Các bước thiết lập Chatbot" className="flex flex-wrap gap-2 border-b border-line pb-3">
          {([['1', '① API key & model'], ['2', '② Dựng đồ thị'], ['3', '③ Dùng cho Chat']] as const).map(([s, label]) => (
            <Button key={s} variant={step === s ? 'dark' : 'outline'} onClick={() => setParams({ step: s })}>{label}</Button>
          ))}
        </nav>
      </div>
      {step === '1' ? <Config /> : step === '2' ? (verifyRun ? <BuilderGraph runId={verifyRun} /> : <Pipeline />) : <Graph />}
    </div>
  )
}

function ContentShell() {
  const [params, setParams] = useSearchParams()
  const rawTab = params.get('tab')
  const tab = rawTab === 'units' || rawTab === 'signs' ? rawTab : 'documents'
  const showImport = params.get('import') === '1'
  return (
    <div>
      <div className="px-6 sm:px-8 pt-6 max-w-6xl mx-auto flex flex-wrap items-center justify-between gap-2 border-b border-line pb-3">
        <nav aria-label="Loại nội dung luật" className="flex flex-wrap gap-2">
          {([['documents', 'Văn bản'], ['units', 'Điều khoản'], ['signs', 'Biển báo']] as const).map(([key, label]) => (
            <Button key={key} variant={tab === key ? 'dark' : 'outline'} onClick={() => setParams({ tab: key })}>{label}</Button>
          ))}
        </nav>
        <Button variant={showImport ? 'dark' : 'outline'} onClick={() => setParams(showImport ? { tab } : { tab, import: '1' })}>
          {showImport ? 'Đóng nhập hàng loạt' : 'Nhập hàng loạt'}
        </Button>
      </div>
      {showImport ? <ContentImports key={`imp-${tab}`} /> : <ContentManager key={tab} kind={tab} />}
    </div>
  )
}

function UsersShell() {
  const { session } = useAuth()
  const [params, setParams] = useSearchParams()
  const isPolice = session?.role === 'police'
  const tab = isPolice || params.get('tab') === 'logs' ? 'logs' : 'users'
  return (
    <div>
      {!isPolice && (
        <div className="px-6 sm:px-8 pt-6 max-w-6xl mx-auto">
          <nav aria-label="Quản lý người dùng và nhật ký" className="flex flex-wrap gap-2 border-b border-line pb-3">
            {([['users', 'Người dùng'], ['logs', 'Nhật ký chat']] as const).map(([key, label]) => (
              <Button key={key} variant={tab === key ? 'dark' : 'outline'} onClick={() => setParams({ tab: key })}>{label}</Button>
            ))}
          </nav>
        </div>
      )}
      {tab === 'logs' ? <Logs /> : <Users />}
    </div>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <AdminProvider>
          <Routes>
            <Route path="/" element={<SessionHome />} />
            <Route path="/login" element={<LoginPage />} />
            <Route element={<RequireRole roles={['user', 'admin', 'police']} />}>
              <Route element={<UserLayout />}>
                <Route path="/chat" element={<Chat />} />
              </Route>
            </Route>
            <Route element={<RequireRole roles={['user']} />}>
              <Route element={<UserLayout />}>
                <Route path="/bien-bao" element={<Signs />} />
                <Route path="/on-thi" element={<Study />} />
                <Route path="/tien-do" element={<RedirectWithParams to="/on-thi" />} />
                <Route path="/exam" element={<Exam />} />
              </Route>
            </Route>
            <Route element={<RequireRole roles={['admin', 'police']} />}>
              <Route path="/admin" element={<SessionHome />} />
              <Route element={<AdminLayout />}>
                <Route path="/admin/dashboard" element={<Dashboard />} />
                <Route path="/admin/chatbot" element={<ChatbotShell />} />
                <Route path="/admin/content" element={<ContentShell />} />
                <Route path="/admin/questions" element={<Questions />} />
                <Route path="/admin/users" element={<UsersShell />} />
                <Route path="/admin/infrastructure" element={<Infrastructure />} />
                <Route path="/admin/sources" element={<Sources />} />
                <Route path="/admin/schema" element={<KagSchemaPage />} />
                <Route path="/admin/docker" element={<Docker />} />
                <Route path="/admin/benchmark" element={<Benchmark />} />

                {/* Legacy route redirects (preserving query string) */}
                <Route path="/admin/config" element={<RedirectWithParams to="/admin/chatbot" defaults={{ step: '1' }} />} />
                <Route path="/admin/pipeline" element={<RedirectWithParams to="/admin/chatbot" defaults={{ step: '2' }} />} />
                <Route path="/admin/graph" element={<GraphRedirect />} />
                <Route path="/admin/knowledge" element={<RedirectWithParams to="/admin/content" defaults={{ tab: 'documents' }} />} />
                <Route path="/admin/documents" element={<RedirectWithParams to="/admin/content" defaults={{ tab: 'documents' }} mapKey={{ source_id: 'q' }} />} />
                <Route path="/admin/units" element={<RedirectWithParams to="/admin/content" defaults={{ tab: 'units' }} mapKey={{ source_id: 'q' }} />} />
                <Route path="/admin/signs" element={<RedirectWithParams to="/admin/content" defaults={{ tab: 'signs' }} mapKey={{ source_id: 'q' }} />} />
                <Route path="/admin/imports" element={<ImportsRedirect defaultType="signs" />} />
                <Route path="/admin/content-imports" element={<ImportsRedirect defaultType="questions" />} />
                <Route path="/admin/chatlogs" element={<RedirectWithParams to="/admin/users" defaults={{ tab: 'logs' }} />} />
              </Route>
            </Route>
            <Route path="*" element={<SessionHome />} />
          </Routes>
          <Toast />
        </AdminProvider>
      </AuthProvider>
    </BrowserRouter>
  )
}
