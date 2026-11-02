import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { AdminProvider, useAdmin } from './admin/store'
import UserLayout from './layouts/UserLayout'
import AdminLayout from './layouts/AdminLayout'
import LoginPage from './pages/LoginPage'
import { AuthProvider, RequireRole, SessionHome } from './auth'
import Chat from './pages/ChatPage'
import Study from './pages/ChapterStudyPage'
import Exam from './pages/ExamPage'
import Signs from './pages/SignLibraryPage'
import Dashboard from './pages/AdminDashboard'
import Chatbot from './pages/AdminChatbot'
import Content from './pages/AdminContent'
import Users from './pages/AdminUsers'
import Questions from './pages/AdminQuestions'
import Sources from './pages/AdminSources'
import Benchmark from './pages/AdminBenchmark'
import Docker from './pages/AdminDocker'
import { Infrastructure } from './pages/server/OperationsPages'
import KagSchemaPage from './pages/server/KagSchemaPage'

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
                <Route path="/admin/chatbot" element={<Chatbot />} />
                <Route path="/admin/content" element={<Content />} />
                <Route path="/admin/questions" element={<Questions />} />
                <Route path="/admin/users" element={<Users />} />
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
