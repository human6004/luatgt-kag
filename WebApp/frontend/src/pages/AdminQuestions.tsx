import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api, send, type ContentRecord } from '../api'
import { useAdmin } from '../admin/store'
import { Badge, Button, Card, Field, Modal, Page, Td, Th, Toggle, inputCls } from '../admin/ui'
import { ImportPanel } from './shared/AdminPages'
import QuestionBankSettings, { type QuestionSet } from './shared/QuestionBankSettings'
import { Asset, Notice, useData, useTask, saveBlob } from './shared/shared'
import { chapterNames as chapters } from './shared/import-normalization'

interface QuestionItem {
  id: string
  externalId: string
  published: boolean
  chapter: string
  question: string
  options: string[]
  answer: number
  critical: boolean
  explanation: string
  source: string
}

const blank = (): QuestionItem => ({
  id: '',
  externalId: '',
  published: false,
  chapter: chapters[0],
  question: '',
  options: ['', '', ''],
  answer: 0,
  critical: false,
  explanation: '',
  source: '',
})

export default function AdminQuestions() {
  const [params, setParams] = useSearchParams()
  const { notify } = useAdmin()
  const task = useTask()
  const data = useData<ContentRecord[]>('/admin/questions')
  const sets = useData<QuestionSet[]>('/admin/questions/sets')

  const tab: 'questions' | 'sets' = params.get('tab') === 'sets' ? 'sets' : 'questions'
  const urlQ = params.get('q') ?? ''
  const [q, setQ] = useState(urlQ)
  const chapter = params.get('chapter') ?? 'all'
  const onlyCritical = params.get('critical') === '1'
  const rawStatus = params.get('status')
  const statusFilter = rawStatus === 'published' || rawStatus === 'draft' ? rawStatus : 'all'
  const showImport = params.get('import') === '1'
  const editId = params.get('id') ?? ''

  useEffect(() => {
    setQ(urlQ)
  }, [urlQ])

  const qbank: QuestionItem[] = useMemo(
    () =>
      (data.value || []).map((r) => ({
        id: r.id,
        externalId: r.externalId,
        published: r.published,
        chapter: chapters[Number(r.data.chapter) - 1] || String(r.data.chapter || chapters[0]),
        question: String(r.data.text || ''),
        options: Array.isArray(r.data.options) ? (r.data.options as string[]) : ['', ''],
        answer: Number(r.data.correctAnswer ?? 0),
        critical: r.data.critical === true,
        explanation: String(r.data.explanation || ''),
        source: String(r.data.source || ''),
      })),
    [data.value],
  )

  const [questionSetId, setQuestionSetId] = useState('')
  const [externalId, setExternalId] = useState('')
  const [reviewed, setReviewed] = useState(false)
  const [imageRequired, setImageRequired] = useState(false)
  const [history, setHistory] = useState<unknown>()
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [editing, setEditing] = useState<QuestionItem | null>(null)

  const record = data.value?.find((r) => r.id === editing?.id)

  function updateUrl(patch: Record<string, string | null>, replace = false) {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        for (const [k, v] of Object.entries(patch)) {
          if (v === null || v === '') next.delete(k)
          else next.set(k, v)
        }
        return next
      },
      { replace },
    )
  }

  function switchTab(nextTab: 'questions' | 'sets') {
    const next = new URLSearchParams()
    if (nextTab === 'sets') next.set('tab', 'sets')
    setParams(next)
  }

  function applyEditing(item: QuestionItem | null, rec?: ContentRecord) {
    task.clearError()
    if (!item) {
      setEditing(null)
      return
    }
    setQuestionSetId(String(rec?.data.questionSetId || ''))
    setExternalId(String(rec?.data.sourceExternalId || rec?.externalId || item.externalId || ''))
    setReviewed(rec?.data.reviewed === true)
    setImageRequired(rec?.data.imageRequired === true)
    setHistory(undefined)
    setEditing({ ...item, options: [...item.options] })
  }

  useEffect(() => {
    if (tab !== 'questions' || !editId) {
      if (editing !== null) applyEditing(null)
      return
    }
    if (editId === 'new') {
      if (!editing || editing.id !== '') applyEditing(blank())
      return
    }
    if (!data.value) return
    const target = qbank.find((x) => x.id === editId || x.externalId === editId)
    if (target && editing?.id !== target.id) {
      const rec = data.value.find((r) => r.id === target.id)
      applyEditing(target, rec)
    }
  }, [tab, editId, data.value, qbank])

  const shown = useMemo(
    () =>
      qbank.filter(
        (x) =>
          (chapter === 'all' || x.chapter === chapter) &&
          (!onlyCritical || x.critical) &&
          (statusFilter === 'all' || (statusFilter === 'published' ? x.published : !x.published)) &&
          `${x.externalId} ${x.question} ${x.source}`.toLowerCase().includes(q.toLowerCase()),
      ),
    [qbank, chapter, onlyCritical, statusFilter, q],
  )

  function openEdit(item: QuestionItem) {
    if (!item.id) sets.reload()
    const rec = data.value?.find((r) => r.id === item.id)
    applyEditing(item, rec)
    updateUrl({ id: item.id || 'new' })
  }

  function closeEdit() {
    applyEditing(null)
    updateUrl({ id: null })
  }

  function save() {
    if (!editing || task.busy || !editing.question.trim()) return
    if (!record && !questionSetId) {
      notify('Chọn bộ câu hỏi trước khi thêm câu mới')
      return
    }
    void task.run(async () => {
      const payload = {
        ...record?.data,
        ...(questionSetId ? { questionSetId } : {}),
        externalId: record?.externalId || externalId,
        text: editing.question,
        chapter: chapters.indexOf(editing.chapter) + 1,
        options: editing.options,
        correctAnswer: editing.answer,
        critical: editing.critical,
        source: editing.source,
        explanation: editing.explanation,
        reviewed,
        imageRequired,
      }
      if (record) await api(`/admin/content/${record.id}`, send('PUT', { version: record.version, data: payload }))
      else await api('/admin/imports/questions/confirm', send('POST', { rows: [payload], updateExisting: false, questionSetId }))
      data.reload()
      applyEditing(null)
      updateUrl({ id: null }, true)
      notify('Đã lưu bản nháp; chưa xuất bản')
    })
  }

  function publish(id: string, published: boolean) {
    const r = data.value?.find((row) => row.id === id)
    if (!r) return
    void task.run(async () => {
      await api(`/admin/content/${id}/publication`, send('POST', { version: r.version, published }))
      data.reload()
      notify('Đã cập nhật xuất bản')
    })
  }

  function exportJson() {
    const blob = new Blob(
      [JSON.stringify((data.value || []).map((r) => ({ ...r.data, id: r.externalId, externalId: r.externalId })), null, 2)],
      { type: 'application/json' },
    )
    saveBlob(blob, 'ngan-hang-cau-hoi.json')
    notify('Đã xuất câu hỏi ra tệp JSON')
  }

  return (
    <Page
      title="Câu hỏi thi"
      subtitle={
        tab === 'sets'
          ? 'Quản lý bộ nhận dữ liệu và cấu hình đề thi theo từng hạng giấy phép lái xe.'
          : `${data.value ? qbank.length : '—'} câu · ${data.value ? qbank.filter((x) => x.critical).length : '—'} câu điểm liệt`
      }
      actions={
        tab === 'questions' ? (
          <>
            <Button variant={showImport ? 'dark' : 'outline'} onClick={() => updateUrl({ import: showImport ? null : '1' })}>
              {showImport ? 'Đóng nhập hàng loạt' : 'Nhập CSV/JSON & ZIP ảnh'}
            </Button>
            <Button onClick={exportJson}>Xuất JSON</Button>
            <Button variant="primary" onClick={() => openEdit(blank())}>
              + Thêm câu hỏi
            </Button>
          </>
        ) : undefined
      }
    >
      <div className="flex flex-wrap gap-6 border-b border-line mb-6" role="tablist" aria-label="Quản lý câu hỏi và bộ đề">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'questions'}
          onClick={() => switchTab('questions')}
          className={`pb-3 text-sm cursor-pointer border-b-2 transition-colors ${
            tab === 'questions' ? 'border-navy text-navy font-semibold' : 'border-transparent text-muted hover:text-navy'
          }`}
        >
          Ngân hàng câu hỏi ({data.value ? qbank.length : '—'})
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'sets'}
          onClick={() => switchTab('sets')}
          className={`pb-3 text-sm cursor-pointer border-b-2 transition-colors ${
            tab === 'sets' ? 'border-navy text-navy font-semibold' : 'border-transparent text-muted hover:text-navy'
          }`}
        >
          Bộ câu hỏi & Quy tắc thi ({sets.value ? sets.value.length : '—'})
        </button>
      </div>

      {tab === 'sets' ? (
        <QuestionBankSettings embedded />
      ) : (
        <>
          <Notice {...data} retry={data.reload} />
          <Notice error={task.error} />

          {showImport && (
            <ImportPanel
              kind="questions"
              onImported={() => {
                data.reload()
                sets.reload()
              }}
              onClose={() => updateUrl({ import: null })}
            />
          )}

          <div className="flex flex-wrap items-center gap-3 mb-4">
            <input
              aria-label="Tìm câu hỏi"
              className={`${inputCls} max-w-xs`}
              placeholder="Tìm câu hỏi, mã, nguồn…"
              value={q}
              onChange={(e) => {
                const v = e.target.value
                setQ(v)
                updateUrl({ q: v || null }, true)
              }}
            />
            <select
              className={`${inputCls} max-w-[220px]`}
              value={chapter}
              onChange={(e) => updateUrl({ chapter: e.target.value === 'all' ? null : e.target.value })}
              aria-label="Chương"
            >
              <option value="all">Tất cả chương</option>
              {chapters.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
            <select
              className={`${inputCls} max-w-[180px]`}
              value={statusFilter}
              onChange={(e) => updateUrl({ status: e.target.value === 'all' ? null : e.target.value })}
              aria-label="Trạng thái xuất bản"
            >
              <option value="all">Mọi trạng thái</option>
              <option value="published">Đã xuất bản</option>
              <option value="draft">Bản nháp</option>
            </select>
            <label className="flex items-center gap-2 text-[13px] text-text-secondary">
              <Toggle
                checked={onlyCritical}
                onChange={(v) => updateUrl({ critical: v ? '1' : null })}
                label="Chỉ câu điểm liệt"
              />{' '}
              Chỉ câu điểm liệt
            </label>
          </div>

          <Card className="overflow-x-auto">
            <table className="w-full min-w-[720px]">
              <thead className="border-b border-line">
                <tr>
                  <Th className="w-12">#</Th>
                  <Th>Câu hỏi</Th>
                  <Th>Chương</Th>
                  <Th>Nguồn</Th>
                  <Th>Trạng thái</Th>
                  <Th className="text-right">Thao tác</Th>
                </tr>
              </thead>
              <tbody>
                {shown.map((x, i) => (
                  <tr key={x.id} className="border-b border-line/60 last:border-0 hover:bg-bg">
                    <Td className="text-muted font-mono text-xs">{i + 1}</Td>
                    <Td className="text-navy">
                      <label className="flex items-start gap-2">
                        <input
                          type="checkbox"
                          checked={checked.has(x.id)}
                          onChange={() =>
                            setChecked((p) => {
                              const n = new Set(p)
                              n.has(x.id) ? n.delete(x.id) : n.add(x.id)
                              return n
                            })
                          }
                        />
                        <span className="font-medium">{x.question}</span>
                      </label>
                      {x.critical && (
                        <span className="ml-2">
                          <Badge tone="red">Điểm liệt</Badge>
                        </span>
                      )}
                      <span className="block mt-0.5 text-[12px] text-muted">Đáp án: {x.options[x.answer]}</span>
                    </Td>
                    <Td className="text-muted whitespace-nowrap">{x.chapter}</Td>
                    <Td className="text-muted">{x.source}</Td>
                    <Td>
                      <Badge tone={x.published ? 'green' : 'amber'}>{x.published ? 'Đã xuất bản' : 'Bản nháp'}</Badge>
                    </Td>
                    <Td className="text-right whitespace-nowrap">
                      <span className="inline-flex flex-wrap justify-end gap-1.5">
                        <Button size="sm" disabled={task.busy} onClick={() => publish(x.id, !x.published)}>
                          {x.published ? 'Hủy xuất bản' : 'Xuất bản'}
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => openEdit(x)}>
                          Sửa
                        </Button>
                      </span>
                    </Td>
                  </tr>
                ))}
                {!shown.length && (
                  <tr>
                    <td colSpan={6} className="px-4 py-8 text-center text-[13.5px] text-muted">
                      Không có câu hỏi phù hợp.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </Card>

          <div className="mt-4 flex flex-wrap gap-3">
            <Button
              disabled={task.busy || !checked.size}
              onClick={() =>
                void task.run(async () => {
                  await api(
                    '/admin/questions/publication-batch',
                    send('POST', {
                      rows: (data.value || [])
                        .filter((r) => checked.has(r.id))
                        .map((r) => ({ id: r.id, version: r.version })),
                      reviewed: true,
                      published: true,
                    }),
                  )
                  setChecked(new Set())
                  data.reload()
                })
              }
            >
              Duyệt và xuất bản các câu đã chọn ({checked.size})
            </Button>
          </div>

          <Modal
            open={!!editing}
            title={editing?.id ? 'Sửa câu hỏi' : 'Thêm câu hỏi'}
            onClose={closeEdit}
            footer={
              <>
                <Button variant="ghost" onClick={closeEdit}>
                  Huỷ
                </Button>
                <Button variant="primary" onClick={save} disabled={task.busy || !editing?.question.trim()}>
                  Lưu
                </Button>
              </>
            }
          >
            <Notice error={task.error} />
            {editing && (
              <div className="space-y-4">
                <Field label="Bộ câu hỏi">
                  <select
                    className={inputCls}
                    aria-label="Bộ câu hỏi"
                    value={questionSetId}
                    onChange={(e) => setQuestionSetId(e.target.value)}
                  >
                    <option value="">Ngân hàng hiện có</option>
                    {sets.value?.map((s) => (
                      <option key={s.set_id} value={s.set_id}>
                        {s.set_name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Mã định danh nguồn">
                  <input
                    className={inputCls}
                    readOnly={!!record?.data.sourceExternalId}
                    value={externalId}
                    onChange={(e) => setExternalId(e.target.value)}
                  />
                </Field>
                <Field label="Nội dung câu hỏi">
                  <textarea
                    rows={2}
                    className={inputCls}
                    value={editing.question}
                    onChange={(e) => setEditing({ ...editing, question: e.target.value })}
                  />
                </Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Chương">
                    <select
                      className={inputCls}
                      value={editing.chapter}
                      onChange={(e) => setEditing({ ...editing, chapter: e.target.value })}
                    >
                      {chapters.map((c) => (
                        <option key={c}>{c}</option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Căn cứ">
                    <input
                      className={inputCls}
                      value={editing.source}
                      onChange={(e) => setEditing({ ...editing, source: e.target.value })}
                      placeholder="NĐ 168/2024…"
                    />
                  </Field>
                </div>
                <div>
                  <span className="block text-xs font-medium text-text-secondary mb-1.5">Phương án (chọn đáp án đúng)</span>
                  <div className="space-y-2">
                    {editing.options.map((o, i) => (
                      <div key={i} className="flex items-center gap-2">
                        <input
                          type="radio"
                          name="ans"
                          checked={editing.answer === i}
                          onChange={() => setEditing({ ...editing, answer: i })}
                          className="accent-[var(--color-accent-strong)]"
                          aria-label={`Đáp án ${i + 1}`}
                        />
                        <input
                          className={inputCls}
                          value={o}
                          placeholder={`Phương án ${i + 1}`}
                          onChange={(e) =>
                            setEditing({
                              ...editing,
                              options: editing.options.map((v, k) => (k === i ? e.target.value : v)),
                            })
                          }
                        />
                        {editing.options.length > 2 && (
                          <button
                            type="button"
                            className="text-muted hover:text-red-600 px-1"
                            aria-label="Xoá phương án"
                            onClick={() =>
                              setEditing({
                                ...editing,
                                options: editing.options.filter((_, k) => k !== i),
                                answer: 0,
                              })
                            }
                          >
                            ✕
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                  {editing.options.length < 4 && (
                    <button
                      type="button"
                      className="mt-2 text-xs font-medium text-accent-strong"
                      onClick={() => setEditing({ ...editing, options: [...editing.options, ''] })}
                    >
                      + Thêm phương án
                    </button>
                  )}
                </div>
                <label className="block text-sm">
                  <input type="checkbox" checked={reviewed} onChange={(e) => setReviewed(e.target.checked)} /> Đã kiểm duyệt đáp án và nguồn
                </label>
                <label className="block text-sm">
                  <input type="checkbox" checked={imageRequired} onChange={(e) => setImageRequired(e.target.checked)} /> Câu hỏi yêu cầu ảnh
                </label>
                {record && (
                  <>
                    <p className="text-xs">
                      {record.published ? 'Đã xuất bản' : 'Bản nháp'} · Version {record.version}
                    </p>
                    {!!record.data.imageKey && <Asset id={record.id} path={`/admin/content/${record.id}/media`} alt="Ảnh câu hỏi" />}
                    <Field label="Ảnh nguồn">
                      <input
                        type="file"
                        accept=".png,.jpg,.jpeg"
                        disabled={task.busy}
                        onChange={(e) => {
                          const file = e.target.files?.[0]
                          if (!file) return
                          void task.run(async () => {
                            const body = new FormData()
                            body.append('file', file)
                            await api(`/admin/content/${record.id}/media`, { method: 'POST', body })
                            data.reload()
                          })
                        }}
                      />
                    </Field>
                    <Button
                      disabled={task.busy}
                      onClick={() => void task.run(async () => setHistory(await api(`/admin/content/${record.id}/history`)))}
                    >
                      Lịch sử chỉnh sửa
                    </Button>
                    {history !== undefined && <pre className="text-xs whitespace-pre-wrap break-all">{JSON.stringify(history, null, 2)}</pre>}
                  </>
                )}
                <Field label="Giải thích">
                  <textarea
                    rows={2}
                    className={inputCls}
                    value={editing.explanation}
                    onChange={(e) => setEditing({ ...editing, explanation: e.target.value })}
                  />
                </Field>
                <label className="flex items-center gap-2 text-[13px] text-navy">
                  <Toggle checked={editing.critical} onChange={(v) => setEditing({ ...editing, critical: v })} label="Câu điểm liệt" /> Câu điểm liệt
                </label>
              </div>
            )}
          </Modal>
        </>
      )}
    </Page>
  )
}
