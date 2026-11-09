export const chapterNames = ['Khái niệm và quy tắc', 'Văn hóa giao thông', 'Kỹ thuật lái xe', 'Cấu tạo và sửa chữa', 'Biển báo', 'Sa hình']
export function normalizeImport(kind: string, value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const row = { ...value } as Record<string, unknown>
  if (kind === 'units') row.externalId ??= row.unit_id ?? row.id
  else if (kind === 'documents') row.externalId ??= row.doc_id ?? row.id
  else row.externalId ??= row.sign_id ?? row.id ?? row.code ?? row.ma_bien
  if (kind === 'units' && typeof row.order === 'string' && /^\d+$/.test(row.order)) row.order = Number(row.order)
  if (kind === 'units' && row.parent_id === '') delete row.parent_id
  if (kind === 'questions') {
    row.text ??= row.question
    const csv = !Array.isArray(row.options)
    if (csv) {
      const options = [row.option1, row.option2, row.option3, row.option4].map(v => String(v ?? '').trim())
      while (options.length && !options[options.length - 1]) options.pop()
      row.options = options
    }
    if (row.correctAnswer === undefined) row.correctAnswer = row.answer === undefined || row.answer === '' ? null : Number(row.answer) - (csv ? 1 : 0)
    if (typeof row.chapter === 'string') row.chapter = /^\d+$/.test(row.chapter) ? Number(row.chapter) : chapterNames.includes(row.chapter) ? chapterNames.indexOf(row.chapter) + 1 : row.chapter
    if (['true', 'false', '1', '0'].includes(String(row.critical).toLowerCase())) row.critical = ['true', '1'].includes(String(row.critical).toLowerCase())
    delete row.answer
  }
  if (kind === 'documents') { row.title ??= row.name; row.ngay_hieu_luc ??= row.effective_from ?? row.effectiveFrom ?? row.effective }
  for (const field of ['ngay_hieu_luc', 'ngay_het_hieu_luc']) if (row[field] instanceof Date) row[field] = (row[field] as Date).toISOString().slice(0, 10)
  return row
}
