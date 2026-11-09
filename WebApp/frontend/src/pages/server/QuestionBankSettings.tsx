import { useState } from "react"

import { api, send } from "../../api"

import {
  Button,
  Card,
  EditIconButton,
  Field,
  FilterTabs,
  Modal,
  Page,
  Td,
  Th,
  inputCls,
} from "../../admin/ui"

import { Notice, useData, useTask } from "./shared"
import ChapterSettings from "./ChapterSettings"

export type QuestionSet = {
  set_id: string

  set_code: string

  set_name: string

  release_code: string

  question_count: number

  rule_count: number
}

export type ExamRule = {
  rule_id: string

  set_id: string

  set_name: string

  class_code: string

  total_questions: number

  duration_minutes: number

  minimum_correct: number

  valid_from: string

  valid_to: string | null

  critical_slots: number

  fail_on_critical: boolean

  attempt_count: number

  quotas: { chapter: number; question_quota: number }[]
}

type RuleForm = {
  setId: string
  license: string
  validFrom: string
  validTo: string
  totalQuestions: string
  durationMinutes: string
  minimumCorrect: string
  criticalSlots: string
  failOnCritical: boolean
  quotas: {chapter: number; value: string}[]
}

const emptyRule = (): RuleForm => ({ setId: "", license: "", validFrom: "", validTo: "", totalQuestions: "", durationMinutes: "", minimumCorrect: "", criticalSlots: "", failOnCritical: true, quotas: Array.from({length:6},(_,i)=>({chapter:i+1,value:""})) })

export default function QuestionBankSettings() {
  const [tab,setTab]=useState('sets')
  const sets = useData<QuestionSet[]>("/admin/questions/sets"),
    rules = useData<ExamRule[]>("/admin/questions/rules"),
    task = useTask()

  const [dialog, setDialog] = useState<"set" | "rule" | null>(null)

  const [editingSet, setEditingSet] = useState<QuestionSet | null>(null)

  const [editingRule, setEditingRule] = useState<ExamRule | null>(null)

  const [pendingDelete, setPendingDelete] = useState<{ kind: "set" | "rule"; id: string; label: string } | null>(null)

  const [endingRule, setEndingRule] = useState<ExamRule | null>(null)

  const [endDate, setEndDate] = useState("")

  const [set, setSet] = useState({
    releaseCode: "",

    releaseTitle: "",

    setCode: "",

    setName: "",

    issuedOn: "",

    effectiveFrom: "",

    effectiveTo: "",

    sourceUrl: "",
  })

  const [rule, setRule] = useState<RuleForm>({
    setId: "",

    license: "",

    validFrom: "",

    validTo: "",

    totalQuestions: "",

    durationMinutes: "",

    minimumCorrect: "",

    criticalSlots: "",

    failOnCritical: true,

    quotas: Array.from({length:6},(_,i)=>({chapter:i+1,value:""})),
  })

  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
  const nextDay = (date: string) => new Date(Date.parse(`${date}T00:00:00Z`) + 86400000).toISOString().slice(0, 10)
  const earliestEnd = endingRule ? nextDay(today > endingRule.valid_from ? today : endingRule.valid_from) : ''
  const allocation = rule.quotas.reduce((sum, value) => sum + Number(value.value || 0), 0) + Number(rule.criticalSlots || 0)
  const allocationComplete = [...rule.quotas.map(q=>q.value), rule.criticalSlots, rule.totalQuestions].every(value => value !== '')
  const allocationMismatch = allocationComplete && allocation !== Number(rule.totalQuestions)

  return (
    <Page
      title="Quản lý ngân hàng câu hỏi"
      subtitle="Quản lý bộ nhận dữ liệu và cấu hình đề thi theo từng hạng giấy phép lái xe."
    >
      <div className="space-y-6">
        <FilterTabs label="Quản lý ngân hàng câu hỏi" value={tab} onChange={value=>{task.clearError();setTab(value)}} items={[{value:'sets',label:'Bộ câu hỏi'},{value:'chapters',label:'Chương'},{value:'rules',label:'Quy tắc đề thi'}]}/>
        {tab==='chapters'&&<><Notice {...sets} retry={sets.reload}/><ChapterSettings sets={sets.value||[]}/></>}
        <Notice error={!dialog && !endingRule && !pendingDelete ? task.error : undefined} />
        {tab==='sets'&&<section aria-labelledby="created-sets-heading" className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 id="created-sets-heading" className="text-lg font-semibold text-navy">Bộ đã tạo</h2>
            <Button variant="primary" disabled={task.busy} onClick={() => { task.clearError(); setEditingSet(null); setSet({ releaseCode: "", releaseTitle: "", setCode: "", setName: "", issuedOn: "", effectiveFrom: "", effectiveTo: "", sourceUrl: "" }); setDialog("set") }}>Thêm bộ câu hỏi</Button>
          </div>
          <Notice {...sets} retry={sets.reload}/>
          {sets.value && <Card className="overflow-hidden"><div className="overflow-x-auto">
<table className="w-full min-w-[480px]">
                    <thead className="bg-sidebar">
                      <tr>
                        <Th>Mã đợt ban hành</Th>
                        <Th>Mã bộ</Th>
                        <Th>Tên bộ</Th>
                        <Th className="text-right">Thao tác</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {sets.value.map((s) => (
                        <tr key={s.set_id} className="border-t border-line">
                          <Td>{s.release_code}</Td>
                          <Td>{s.set_code}</Td>
                          <Td>{s.set_name}</Td>
                          <Td className="text-right">
                            <div className="flex flex-wrap items-center justify-end gap-2">
                              <EditIconButton label="Chỉnh sửa bộ câu hỏi" disabled={task.busy} onClick={() => {
                                task.clearError()
                                setEditingSet(s)
                                setSet({ releaseCode: s.release_code, releaseTitle: "", setCode: s.set_code, setName: s.set_name, issuedOn: "", effectiveFrom: "", effectiveTo: "", sourceUrl: "" })
                                setDialog("set")
                              }} />
                              <Button size="sm" variant="danger" aria-label="Xóa bộ câu hỏi" disabled={task.busy || s.question_count > 0 || s.rule_count > 0} title={s.question_count > 0 || s.rule_count > 0 ? `Đã có ${s.question_count} câu hỏi · ${s.rule_count} quy tắc; không thể xóa.` : "Xóa bộ câu hỏi"} onClick={() => { task.clearError(); setPendingDelete({ kind: "set", id: s.set_id, label: `${s.release_code} / ${s.set_code}` }) }}><svg aria-hidden="true" className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/></svg></Button>
                            </div>
                          </Td>
                        </tr>
                      ))}
                      {!sets.value.length && (
                        <tr>
                          <td
                            colSpan={4}
                            className="px-4 py-6 text-center text-sm text-muted"
                          >
                            Chưa có bộ câu hỏi. Bấm “Thêm bộ câu hỏi” để tạo bộ
                            mới.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
          </div></Card>}
        </section>}
        {tab==='rules'&&<section aria-labelledby="created-rules-heading" className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 id="created-rules-heading" className="text-lg font-semibold text-navy">Quy tắc đã tạo</h2>
            <Button variant="primary" disabled={task.busy || sets.loading || !sets.value?.length} onClick={() => { task.clearError(); setEditingRule(null); setRule(emptyRule()); setDialog("rule") }}>Thêm quy tắc đề thi</Button>
          </div>
          <p className="text-xs leading-6 text-muted">Giữ quy tắc cũ để chấm bài thi đã lưu. Khi thay đổi, thêm quy tắc cho thời kỳ mới; khoảng hiệu lực trong cùng bộ và hạng không được chồng nhau.</p>
          <Notice {...rules} retry={rules.reload}/>
          {rules.value && <Card className="overflow-hidden"><div className="overflow-x-auto">
<table className="w-full min-w-[800px]">
                    <thead className="bg-sidebar">
                      <tr>
                        <Th>Bộ / Hạng</Th>
                        <Th>Cấu hình đề</Th>
                        <Th>Điểm liệt</Th>
                        <Th>Hiệu lực</Th>
                        <Th className="text-right">Thao tác</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {rules.value.map((r) => (
                        <tr key={r.rule_id} className="border-t border-line">
                          <Td>
                            <p className="font-medium text-navy">
                              {r.set_name}
                            </p>
                            <p className="mt-1 text-xs text-muted">
                              Hạng {r.class_code}
                            </p>
                          </Td>
                          <Td>
                            <p>
                              {r.total_questions} câu · {r.duration_minutes}{" "}
                              phút
                            </p>
                            <p className="mt-1 text-xs text-muted">
                              Đạt từ {r.minimum_correct} câu đúng
                            </p>
                          </Td>
                          <Td>
                            <p>{r.critical_slots} câu</p>
                            <p className="mt-1 text-xs text-muted">
                              {r.fail_on_critical
                                ? "Sai câu liệt: trượt"
                                : "Không tự động trượt"}
                            </p>
                          </Td>
                          <Td>
                            <p>{r.valid_from}</p>
                            <p className="mt-1 text-xs text-muted">
                              Đến {r.valid_to || "chưa giới hạn"}
                            </p>
                          </Td>
                          <Td className="text-right">
                            <div className="flex flex-wrap items-center justify-end gap-2">
                              <EditIconButton label="Chỉnh sửa quy tắc" disabled={task.busy || r.attempt_count > 0} title={r.attempt_count > 0 ? "Đã có bài thi nên khóa sửa để giữ lịch sử" : "Chỉnh sửa quy tắc"} onClick={() => {
                                task.clearError()
                                setEditingRule(r)
                                setRule({
                                  setId: r.set_id,
                                  license: r.class_code,
                                  validFrom: r.valid_from,
                                  validTo: r.valid_to || "",
                                  totalQuestions: String(r.total_questions),
                                  durationMinutes: String(r.duration_minutes),
                                  minimumCorrect: String(r.minimum_correct),
                                  criticalSlots: String(r.critical_slots),
                                  failOnCritical: r.fail_on_critical,
                                  quotas: r.quotas.map(q=>({chapter:q.chapter,value:String(q.question_quota)})),
                                })
                                setDialog("rule")
                              }} />
                              <Button size="sm" disabled={task.busy || (!!r.valid_to && r.valid_to < nextDay(today > r.valid_from ? today : r.valid_from))} onClick={() => {
                                task.clearError()
                                setEndDate("")
                                setEndingRule(r)
                              }}>Kết thúc hiệu lực</Button>
                              <Button size="sm" variant="danger" aria-label="Xóa quy tắc" disabled={task.busy || r.attempt_count > 0} title={r.attempt_count > 0 ? "Đã có bài thi nên không thể xóa" : "Xóa quy tắc"} onClick={() => { task.clearError(); setPendingDelete({ kind: "rule", id: r.rule_id, label: `${r.set_name} · Hạng ${r.class_code}` }) }}><svg aria-hidden="true" className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/></svg></Button>
                            </div>
                            {r.attempt_count > 0 && <p className="mt-1 text-xs text-muted">Đã có {r.attempt_count} bài thi; khóa sửa/xóa để giữ lịch sử.</p>}
                          </Td>
                        </tr>
                      ))}
                      {!rules.value.length && (
                        <tr>
                          <td
                            colSpan={5}
                            className="px-4 py-6 text-center text-sm text-muted"
                          >
                            Chưa có quy tắc đề thi. Tạo bộ câu hỏi trước, sau đó
                            thêm quy tắc áp dụng.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
          </div></Card>}
        </section>}
      </div>
      <Modal
        open={dialog === "set"}
        title={editingSet ? "Chỉnh sửa bộ câu hỏi" : "Thêm bộ câu hỏi"}
        onClose={() => {
          if (!task.busy) { setDialog(null); setEditingSet(null) }
        }}
        footer={
          <>
            <Button disabled={task.busy} onClick={() => { setDialog(null); setEditingSet(null) }}>
              Hủy
            </Button>
            <Button
              type="submit"
              form="create-question-set"
              variant="primary"
              disabled={task.busy}
            >
              {editingSet ? "Lưu thay đổi" : "Tạo bộ câu hỏi"}
            </Button>
          </>
        }
      >
        <Notice error={task.error} />
        <p className="mb-5 text-sm text-muted">
          Tạo bộ riêng cho 250 và 600 câu trước khi nhập dữ liệu. Các trường có
          dấu * là bắt buộc.
        </p>
        {editingSet && <p className="mb-4 text-xs text-muted">Mã đợt ban hành dùng chung cho các bộ cùng đợt.</p>}
        <form
          id="create-question-set"
          onSubmit={(e) => {
            e.preventDefault()

            void task.run(async () => {
              const body = editingSet ? { releaseCode: set.releaseCode, setCode: set.setCode, setName: set.setName } : Object.fromEntries(Object.entries(set).filter(([, v]) => v !== ""))
              await api(editingSet ? `/admin/questions/sets/${editingSet.set_id}` : "/admin/questions/sets", send(editingSet ? "PUT" : "POST", body))

              sets.reload()
              setSet(current => ({ ...current, releaseCode: '', releaseTitle: '', setCode: '', setName: '', issuedOn: '', effectiveFrom: '', effectiveTo: '', sourceUrl: '' }))
              setEditingSet(null)
              setDialog(null)
            })
          }}
        >
          <fieldset disabled={task.busy} className="min-w-0 space-y-5">
            <div className="grid gap-4 sm:grid-cols-2">
              {Object.entries(editingSet ? {
                releaseCode: "Mã đợt ban hành",
                setCode: "Mã bộ",
                setName: "Tên bộ",
              } : {
                releaseCode: "Mã đợt ban hành",
                releaseTitle: "Tên đợt ban hành",
                setCode: "Mã bộ",
                setName: "Tên bộ",
              }).map(([key, label]) => (
                <Field key={key} label={label} required>
                  <input
                    required
                    className={inputCls}
                    aria-label={label}
                    value={set[(key as keyof typeof set)]}
                    onChange={(e) =>
                      setSet((s) => ({ ...s, [key]: e.target.value }))
                    }
                  />
                </Field>
              ))}
            </div>
            {!editingSet && <fieldset className="min-w-0 border-t border-line pt-4">
              <legend className="pr-3 text-sm font-medium text-navy">
                Nguồn và hiệu lực
              </legend>
              <div className="grid gap-4 sm:grid-cols-2">
                {Object.entries({
                  issuedOn: "Ngày ban hành",
                  effectiveFrom: "Ngày hiệu lực",
                  effectiveTo: "Ngày hết hiệu lực",
                }).map(([key, label]) => (
                  <Field key={key} label={label} hint="Không bắt buộc">
                    <input
                      type="date"
                      className={inputCls}
                      aria-label={label}
                      value={set[(key as keyof typeof set)]}
                      onChange={(e) =>
                        setSet((s) => ({ ...s, [key]: e.target.value }))
                      }
                    />
                  </Field>
                ))}
                <div className="sm:col-span-2">
                  <Field
                    label="Nguồn bộ câu hỏi"
                    hint="Đường dẫn hoặc thông tin nguồn đã đối chiếu."
                  >
                    <input
                      className={inputCls}
                      aria-label="Nguồn bộ câu hỏi"
                      value={set.sourceUrl}
                      onChange={(e) =>
                        setSet((s) => ({ ...s, sourceUrl: e.target.value }))
                      }
                    />
                  </Field>
                </div>
              </div>
            </fieldset>}
          </fieldset>
        </form>
      </Modal>
      <Modal
        open={dialog === "rule"}
        title={editingRule ? "Chỉnh sửa quy tắc đề thi" : "Thêm quy tắc đề thi"}
        onClose={() => {
          if (!task.busy) { setDialog(null); setEditingRule(null) }
        }}
        footer={
          <>
            <Button disabled={task.busy} onClick={() => { setDialog(null); setEditingRule(null) }}>
              Hủy
            </Button>
            <Button
              type="submit"
              form="create-exam-rule"
              variant="primary"
              disabled={task.busy || sets.loading || !sets.value?.length || allocationMismatch}
            >
              {editingRule ? "Lưu thay đổi" : "Thêm quy tắc đề"}
            </Button>
          </>
        }
      >
        <Notice error={task.error} />
        <p className="mb-5 text-sm text-muted">
          {editingRule ? "Chỉ sửa quy tắc chưa có bài thi. Bộ và hạng áp dụng được giữ nguyên." : "Nhập cấu hình theo nguồn đã kiểm duyệt. Chỉ tiêu chương tính câu thường; câu điểm liệt tính riêng."} Các trường có dấu * là bắt buộc.
        </p>
        <form
          id="create-exam-rule"
          onSubmit={(e) => {
            e.preventDefault()
            if (allocationMismatch) return

            void task.run(async () => {
              const body = {
                  ...rule,
                  validTo: rule.validTo || null,

                  totalQuestions: Number(rule.totalQuestions),
                  durationMinutes: Number(rule.durationMinutes),

                  minimumCorrect: Number(rule.minimumCorrect),
                  criticalSlots: Number(rule.criticalSlots),
                  quotas: rule.quotas.map(q=>({chapter:q.chapter,question_quota:Number(q.value)})),
              }
              await api(editingRule ? `/admin/questions/rules/${editingRule.rule_id}` : "/admin/questions/rules", send(editingRule ? "PUT" : "POST", body))

              rules.reload()
              setRule(emptyRule())
              setEditingRule(null)
              setDialog(null)
            })
          }}
        >
          <fieldset
            disabled={task.busy || sets.loading || !sets.value?.length}
            className="min-w-0 space-y-5"
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Bộ áp dụng" required>
                <select
                  required
                  className={inputCls}
                  aria-label="Bộ áp dụng"
                  disabled={!!editingRule}
                  value={rule.setId}
                  onChange={(e) =>
                    setRule((r) => ({ ...r, setId: e.target.value }))
                  }
                >
                  <option value="">Chọn bộ câu hỏi</option>
                  {sets.value?.map((s) => (
                    <option key={s.set_id} value={s.set_id}>
                      {s.release_code} / {s.set_name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Hạng GPLX" required>
                <input
                  required
                  className={inputCls}
                  aria-label="Hạng GPLX"
                  disabled={!!editingRule}
                  placeholder="Ví dụ: A1, A, B"
                  value={rule.license}
                  onChange={(e) =>
                    setRule((r) => ({
                      ...r,
                      license: e.target.value.toUpperCase(),
                    }))
                  }
                />
              </Field>
              <Field label="Áp dụng từ" required>
                <input
                  required
                  type="date"
                  className={inputCls}
                  aria-label="Áp dụng từ"
                  value={rule.validFrom}
                  onChange={(e) =>
                    setRule((r) => ({ ...r, validFrom: e.target.value }))
                  }
                />
              </Field>
              <Field
                label="Áp dụng đến"
                hint="Không gồm ngày này. Để trống nếu chưa giới hạn."
              >
                <input
                  type="date"
                  className={inputCls}
                  aria-label="Áp dụng đến"
                  value={rule.validTo}
                  onChange={(e) =>
                    setRule((r) => ({ ...r, validTo: e.target.value }))
                  }
                />
              </Field>
            </div>
            <fieldset className="min-w-0 border-t border-line pt-4">
              <legend className="pr-3 text-sm font-medium text-navy">
                Cấu hình bài thi
              </legend>
              <div className="grid gap-4 sm:grid-cols-2">
                {Object.entries({
                  totalQuestions: "Tổng số câu",
                  durationMinutes: "Thời gian (phút)",
                  minimumCorrect: "Số câu đúng tối thiểu",
                  criticalSlots: "Số câu điểm liệt",
                }).map(([key, label]) => (
                  <Field key={key} label={label} required>
                    <input
                      required
                      type="number"
                      min={key === "criticalSlots" ? 0 : 1}
                      max={key === "durationMinutes" ? 240 : key === "minimumCorrect" || key === "criticalSlots" ? Number(rule.totalQuestions) || 200 : 200}
                      step="1"
                      className={inputCls}
                      aria-label={label}
                      value={rule[(key as "totalQuestions")]}
                      onChange={(e) =>
                        setRule((r) => ({ ...r, [key]: e.target.value }))
                      }
                    />
                  </Field>
                ))}
              </div>
            </fieldset>
            <fieldset className="min-w-0 border-t border-line pt-4">
              <legend className="pr-3 text-sm font-medium text-navy">
                Phân bổ câu thường theo chương
              </legend>
              <div className="mb-3 flex justify-end">
                <button type="button" aria-label="Thêm chương" title="Thêm chương" disabled={task.busy||rule.quotas.length>=32767}
                  className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-navy hover:bg-selected disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-accent-strong"
                  onClick={()=>setRule(r=>{
                    const used=new Set(r.quotas.map(q=>q.chapter));let chapter=1;while(used.has(chapter))chapter++;
                    return {...r,quotas:[...r.quotas,{chapter,value:""}].sort((a,b)=>a.chapter-b.chapter)};
                  })}>
                  <svg aria-hidden="true" className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M12 5v14M5 12h14"/></svg>
                </button>
              </div>
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
                {rule.quotas.map((quota, i) => (
                  <Field key={quota.chapter} label={`Chương ${quota.chapter}`} required>
                    <input
                      required
                      type="number"
                      min="0"
                      max={Number(rule.totalQuestions) || 200}
                      step="1"
                      className={inputCls}
                      aria-label={`Số câu thường chương ${quota.chapter}`}
                      value={quota.value}
                      onChange={(e) =>
                        setRule((r) => ({
                          ...r,
                          quotas: r.quotas.map((v, j) =>
                            j === i ? {...v,value:e.target.value} : v,
                          ),
                        }))
                      }
                    />
                    <button type="button" aria-label={`Xóa phân bổ chương ${quota.chapter}`} title={`Xóa phân bổ chương ${quota.chapter}`} disabled={task.busy}
                      className="mt-1 inline-flex h-8 w-8 items-center justify-center rounded-lg text-red-700 hover:bg-red-50 disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-accent-strong"
                      onClick={()=>setRule(r=>({...r,quotas:r.quotas.filter(q=>q.chapter!==quota.chapter)}))}>
                      <svg aria-hidden="true" className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/></svg>
                    </button>
                  </Field>
                ))}
              </div>
            </fieldset>
            <p role="status" className={`text-sm ${allocationMismatch ? 'text-red-700' : 'text-muted'}`}>
              Tổng phân bổ: {allocation} / {rule.totalQuestions || '—'} câu (gồm câu điểm liệt).
              {allocationMismatch && ' Tổng phân bổ phải bằng tổng số câu của đề.'}
            </p>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="accent-[var(--color-accent-strong)]"
                checked={rule.failOnCritical}
                onChange={(e) =>
                  setRule((r) => ({ ...r, failOnCritical: e.target.checked }))
                }
              />
              Trượt khi sai câu điểm liệt
            </label>
          </fieldset>
        </form>
      </Modal>
      <Modal
        open={!!endingRule}
        title="Kết thúc hiệu lực quy tắc"
        onClose={() => {
          if (!task.busy) setEndingRule(null)
        }}
        footer={
          <>
            <Button disabled={task.busy} onClick={() => setEndingRule(null)}>
              Hủy
            </Button>
            <Button
              type="submit"
              form="end-exam-rule"
              disabled={task.busy || !endDate}
            >
              Kết thúc hiệu lực
            </Button>
          </>
        }
      >
        <Notice error={task.error} />
        {endingRule && (
          <form
            id="end-exam-rule"
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault()

              void task.run(async () => {
                await api(
                  `/admin/questions/rules/${endingRule.rule_id}/end`,
                  send("POST", { validTo: endDate }),
                )

                rules.reload()

                setEndingRule(null)
              })
            }}
          >
            <p className="text-sm text-muted">
              {endingRule.set_name} · Hạng {endingRule.class_code}
            </p>
            <Field
              label="Ngày kết thúc"
              required
              hint="Quy tắc không còn áp dụng từ ngày này. Bài thi đã lưu vẫn giữ quy tắc cũ."
            >
              <input
                required
                type="date"
                className={inputCls}
                aria-label="Ngày kết thúc quy tắc"
                min={earliestEnd}
                max={endingRule.valid_to || undefined}
                disabled={task.busy}
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
              />
            </Field>
          </form>
        )}
      </Modal>
      <Modal
        open={!!pendingDelete}
        title={pendingDelete?.kind === "set" ? "Xóa bộ câu hỏi" : "Xóa quy tắc đề thi"}
        onClose={() => { if (!task.busy) setPendingDelete(null) }}
        footer={
          <>
            <Button disabled={task.busy} onClick={() => setPendingDelete(null)}>Hủy</Button>
            <Button variant="danger" disabled={task.busy} onClick={() => {
              if (!pendingDelete) return
              void task.run(async () => {
                await api(pendingDelete.kind === "set" ? `/admin/questions/sets/${pendingDelete.id}` : `/admin/questions/rules/${pendingDelete.id}`, send("DELETE"))
                if (pendingDelete.kind === "set") sets.reload()
                else rules.reload()
                setPendingDelete(null)
              })
            }}>Xóa</Button>
          </>
        }
      >
        <Notice error={task.error} />
        <p className="text-sm text-muted">Bạn sắp xóa “{pendingDelete?.label}”. Chỉ mục chưa được dùng mới có thể xóa; câu hỏi hoặc bài thi đã lưu sẽ được giữ nguyên.</p>
      </Modal>
    </Page>
  )
}
