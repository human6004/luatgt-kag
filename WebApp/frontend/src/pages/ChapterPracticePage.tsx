import { useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { api, send, type ContentRecord } from '../api'
import { Button, NavLinkButton } from '../admin/ui'
import { Asset, Notice, useData, useTask } from './shared/shared'

type PracticeAnswer = { selected: number; correct: boolean; correctAnswer: number; critical: boolean; explanation: string }

export default function ChapterPracticePage() {
  const {chapterId}=useParams()
  const [params]=useSearchParams()
  const setId=params.get('questionSetId')||''
  return <ChapterPractice key={`${setId}-${chapterId}`} setId={setId} chapterId={Number(chapterId)}/>
}

function ChapterPractice({setId,chapterId}:{setId:string;chapterId:number}) {
  const questions=useData<ContentRecord[]>('/questions?questionSetId='+encodeURIComponent(setId))
  const task=useTask()
  const [index,setIndex]=useState(0)
  const [answers,setAnswers]=useState<Record<string,PracticeAnswer>>({})
  const practiceQuestions=(questions.value||[]).filter(q=>Number(q.data.chapter)===chapterId)
  const question=practiceQuestions[index]
  const answer=question?answers[question.id]:undefined
  const answered=practiceQuestions.filter(q=>answers[q.id]).length
  const correct=practiceQuestions.filter(q=>answers[q.id]?.correct).length
  const backTo='/on-thi?questionSetId='+encodeURIComponent(setId)

  function selectQuestion(next:number) {
    setIndex(next)
    task.clearError()
  }

  async function submitAnswer(selected:number) {
    if(!question||task.busy||answer)return
    await task.run(async()=>{
      const result=await api<Omit<PracticeAnswer,'selected'>>(`/study/${question.id}/answer`,send('POST',{selected,questionSetId:setId}))
      setAnswers(previous=>({...previous,[question.id]:{...result,selected}}))
    })
  }

  return <div className="mx-auto max-w-7xl px-5 py-6 pb-20 sm:px-8">
    <Link to={backTo} className="text-sm text-muted hover:text-navy">← Về danh sách chương</Link>
    <header className="mt-4 mb-6">
      <h1 className="text-2xl sm:text-3xl font-semibold text-navy">{String(question?.data.chapterName||`Chương ${chapterId}`)}</h1>
      <p className="mt-2 text-sm text-muted">Chọn một đáp án để kiểm tra kết quả và xem giải thích.</p>
    </header>
    <Notice {...questions} retry={questions.reload}/>
    {!setId ? <p role="alert">Vui lòng quay lại danh sách chương và chọn bộ câu hỏi.</p> : question ? <div className="chapter-practice-layout">
      <section className="min-w-0 space-y-5" aria-label="Câu hỏi luyện tập">
        <div className="rounded-2xl border border-line bg-surface p-5 sm:p-7">
          <p className="mb-3 text-sm font-medium text-accent-strong">Câu {index+1} / {practiceQuestions.length}</p>
          <h2 className="text-lg sm:text-xl font-semibold leading-relaxed text-navy">{String(question.data.text)}</h2>
          {!!question.data.imageKey&&<Asset key={question.id} id={question.id} path={`/question-sets/${setId}/questions/${question.id}/media`} alt={`Hình minh họa câu ${index+1}`}/>}
          <div className="mt-6 space-y-3" role="group" aria-label="Chọn đáp án">
            {(question.data.options as string[]).map((option,i)=>{
              const isCorrect=!!answer&&i===answer.correctAnswer
              const isWrong=!!answer&&i===answer.selected&&!answer.correct
              return <button key={i} type="button" disabled={task.busy||!!answer} aria-pressed={answer?.selected===i}
                onClick={()=>void submitAnswer(i)}
                style={{borderColor:isCorrect?'#16a34a':isWrong?'#dc2626':undefined}}
                className="flex w-full items-start gap-3 rounded-xl border-2 border-line bg-surface p-4 text-left text-sm sm:text-base leading-relaxed text-navy transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-strong disabled:cursor-default enabled:hover:border-accent">
                <span className="shrink-0 font-semibold">{String.fromCharCode(65+i)}.</span>
                <span className="min-w-0 flex-1 break-words">{option}</span>
                {(isCorrect||isWrong)&&<span className="shrink-0 font-bold" aria-label={isCorrect?'Đáp án đúng':'Bạn chọn sai'}>{isCorrect?'✓':'✕'}</span>}
              </button>
            })}
          </div>
          {task.busy&&<p role="status" className="mt-4 text-sm text-muted">Đang kiểm tra đáp án…</p>}
          <Notice error={task.error}/>
          {answer&&<div role="status" className="mt-5 space-y-2 border-t border-line pt-4 text-sm leading-relaxed">
            <p className="font-semibold text-navy">Đáp án đúng: {String.fromCharCode(65+answer.correctAnswer)}.{answer.critical?' Đây là câu điểm liệt.':''}</p>
            {answer.explanation&&<p className="whitespace-pre-line text-navy">{answer.explanation}</p>}
          </div>}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Button disabled={task.busy||index===0} onClick={()=>selectQuestion(index-1)}>← Câu trước</Button>
          {index<practiceQuestions.length-1 ? <Button variant="primary" disabled={task.busy} onClick={()=>selectQuestion(index+1)}>Câu tiếp theo →</Button> : <NavLinkButton to={backTo}>Về danh sách chương</NavLinkButton>}
        </div>
      </section>
      <aside className="min-w-0 space-y-4" aria-label="Điều hướng câu hỏi">
        <h2 className="text-base font-semibold text-navy">Danh sách câu hỏi</h2>
        <div className="rounded-2xl border border-line bg-surface p-5">
          <p className="mb-4 text-sm text-muted">Đã trả lời {answered} / {practiceQuestions.length} câu</p>
          <div className="grid grid-cols-5 gap-2">
            {practiceQuestions.map((q,i)=>{
              const result=answers[q.id]
              return <button key={q.id} type="button" disabled={task.busy} onClick={()=>selectQuestion(i)} aria-current={i===index?'step':undefined}
                aria-label={`Câu ${i+1}: ${result?(result.correct?'đã trả lời đúng':'đã trả lời sai'):'chưa trả lời'}`}
                style={{borderColor:result?(result.correct?'#16a34a':'#dc2626'):undefined}}
                className={`min-h-11 rounded-lg border border-line text-sm font-semibold text-navy focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-strong ${i===index?'bg-selected':'bg-surface'}`}>
                {i+1}
              </button>
            })}
          </div>
          <div className="mt-5 border-t border-line pt-4 text-xs leading-5 text-muted">
            Đúng (viền xanh) · Sai (viền đỏ) · Chưa trả lời (viền nhạt) · Đang xem (nền vàng)
          </div>
          {answered===practiceQuestions.length&&<p role="status" className="mt-4 text-sm font-medium text-navy">Đã hoàn thành lượt luyện tập: đúng {correct} / {practiceQuestions.length} câu.</p>}
        </div>
      </aside>
    </div> : !questions.loading&&!questions.error&&<p className="rounded-2xl border border-line bg-surface p-6 text-muted">Chưa có câu hỏi đã xuất bản cho chương này.</p>}
  </div>
}
