import { BrowserRouter, Routes, Route } from 'react-router-dom'
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
import Users from './pages/AdminUsers'
import Logs from './pages/AdminChatLogs'
import Knowledge from './pages/AdminKnowledge'
import Questions from './pages/AdminQuestions'
import Imports from './pages/AdminImports'
import Graph from './pages/AdminGraph'
import Sources from './pages/AdminSources'
import Pipeline from './pages/AdminPipeline'
import Benchmark from './pages/AdminBenchmark'
import Docker from './pages/AdminDocker'
import Config from './pages/AdminConfig'
import { ContentManager, Imports as ContentImports } from './pages/server/AdminPages'
import { Infrastructure } from './pages/server/OperationsPages'
import KagSchemaPage from './pages/server/KagSchemaPage'

function Toast() {
  const {toast}=useAdmin()
  return toast?<p role="status" className="fixed bottom-16 left-1/2 -translate-x-1/2 z-[70] max-w-[90vw] rounded-xl bg-navy text-bg px-4 py-2 text-[13px] shadow-lg">{toast}</p>:null
}
export default function App(){
  return <BrowserRouter><AuthProvider><AdminProvider><Routes>
    <Route path="/" element={<SessionHome/>}/><Route path="/login" element={<LoginPage/>}/>
    <Route element={<RequireRole roles={['user','admin','police']}/>}><Route element={<UserLayout/>}>
      <Route path="/chat" element={<Chat/>}/>
    </Route></Route>
    <Route element={<RequireRole roles={['user']}/>}><Route element={<UserLayout/>}>
      <Route path="/bien-bao" element={<Signs/>}/>
      <Route path="/on-thi" element={<Study/>}/><Route path="/tien-do" element={<Study/>}/><Route path="/exam" element={<Exam/>}/>
    </Route></Route>
    <Route element={<RequireRole roles={['admin','police']}/>}>
      <Route path="/admin" element={<SessionHome/>}/><Route element={<AdminLayout/>}>
      <Route path="/admin/dashboard" element={<Dashboard/>}/><Route path="/admin/knowledge" element={<Knowledge/>}/>
      <Route path="/admin/questions" element={<Questions/>}/><Route path="/admin/imports" element={<Imports/>}/>
      <Route path="/admin/users" element={<Users/>}/><Route path="/admin/chatlogs" element={<Logs/>}/>
      <Route path="/admin/graph" element={<Graph/>}/><Route path="/admin/pipeline" element={<Pipeline/>}/><Route path="/admin/benchmark" element={<Benchmark/>}/>
      <Route path="/admin/sources" element={<Sources/>}/>
      <Route path="/admin/docker" element={<Docker/>}/><Route path="/admin/config" element={<Config/>}/>
      <Route path="/admin/documents" element={<ContentManager key="documents" kind="documents"/>}/><Route path="/admin/units" element={<ContentManager key="units" kind="units"/>}/><Route path="/admin/signs" element={<ContentManager key="signs" kind="signs"/>}/>
      <Route path="/admin/content-imports" element={<ContentImports/>}/>
      <Route path="/admin/infrastructure" element={<Infrastructure/>}/><Route path="/admin/schema" element={<KagSchemaPage/>}/>
      </Route>
    </Route>
    <Route path="*" element={<SessionHome/>}/>
  </Routes><Toast/></AdminProvider></AuthProvider></BrowserRouter>
}
