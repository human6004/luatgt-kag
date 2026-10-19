import { useEffect, useRef } from 'react'

export function Page({ title, subtitle, actions, children }: { title: string; subtitle?: string; actions?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="px-5 md:px-8 py-7 min-h-full bg-bg">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-6">
        <div className="min-w-0 max-w-full break-words">
          <h1 className="text-2xl font-semibold text-navy">{title}</h1>
          {subtitle && <p className="mt-1 text-[13px] text-muted">{subtitle}</p>}
        </div>
        {actions && <div className="flex max-w-full flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children}
    </div>
  )
}

export function Card({ title, right, className = '', children }: { title?: string; right?: React.ReactNode; className?: string; children: React.ReactNode }) {
  return (
    <section className={`min-w-0 [overflow-wrap:anywhere] bg-surface rounded-2xl border border-line shadow-[0_1px_2px_rgba(53,45,36,0.04)] ${className}`}>
      {title && (
        <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-5 pt-4 pb-3">
          <h2 className="min-w-0 break-words text-sm leading-6 font-semibold text-navy">{title}</h2>
          {right && <div className="flex max-w-full flex-wrap items-center gap-2">{right}</div>}
        </header>
      )}
      {children}
    </section>
  )
}

type BtnVariant = 'primary' | 'dark' | 'ghost' | 'outline' | 'danger'
const btn: Record<BtnVariant, string> = {
  primary: 'bg-accent text-navy hover:bg-accent-hover',
  dark: 'bg-navy text-bg hover:bg-navy-light',
  ghost: 'text-navy underline underline-offset-4 decoration-navy/40 hover:bg-selected hover:decoration-navy',
  outline: 'border border-navy/35 bg-selected text-navy hover:border-navy/60 hover:bg-line',
  danger: 'text-red-700 underline underline-offset-4 decoration-red-700/40 hover:bg-red-50 hover:decoration-red-700',
}
export function Button({ variant = 'outline', size = 'md', className = '', ...p }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant; size?: 'sm' | 'md' }) {
  return (
    <button
      {...p}
      className={`inline-flex max-w-full items-center justify-center gap-1.5 rounded-md text-center leading-5 font-semibold cursor-pointer transition-colors disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-strong focus-visible:ring-offset-2 ${
        size === 'sm' ? 'min-h-8 px-3 py-1.5 text-xs' : 'min-h-10 px-4 py-2 text-[13px]'
      } ${btn[variant]} ${className}`}
    />
  )
}

const tones = {
  green: 'text-emerald-700',
  amber: 'text-amber-700',
  red: 'text-red-700',
  gray: 'text-text-secondary',
  gold: 'text-accent-strong',
}
export type Tone = keyof typeof tones
export function Badge({ tone = 'gray', children }: { tone?: Tone; children: React.ReactNode }) {
  return (
    <span className={`inline-block whitespace-nowrap text-xs font-medium ${tones[tone]}`}>
      {children}
    </span>
  )
}

export function Modal({ open, title, onClose, children, footer }: { open: boolean; title: string; onClose: () => void; children: React.ReactNode; footer?: React.ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    if (!open || !dialog.current) return
    const element = dialog.current, previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    element.showModal()
    return () => { element.close(); if (previous?.isConnected) previous.focus() }
  }, [open])
  if (!open) return null
  return (
    <dialog ref={dialog} aria-label={title} className="fixed inset-0 m-0 w-screen h-screen max-w-none max-h-none border-0 grid place-items-center p-4 bg-navy/30 backdrop-blur-[2px] backdrop:bg-transparent text-inherit" onCancel={event => { event.preventDefault(); onClose() }} onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
      <div className="w-full max-w-lg max-h-[90vh] flex flex-col rounded-2xl bg-bg border border-line shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-line">
          <h3 className="min-w-0 break-words text-[15px] leading-6 font-semibold text-navy">{title}</h3>
          <button onClick={onClose} aria-label="Đóng" className="shrink-0 p-1.5 rounded-lg text-muted hover:bg-selected hover:text-navy">✕</button>
        </div>
        <div className="min-w-0 p-5 overflow-y-auto [overflow-wrap:anywhere]">{children}</div>
        {footer && <div className="flex flex-wrap items-center justify-end gap-2 px-5 py-3 border-t border-line">{footer}</div>}
      </div>
    </dialog>
  )
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block min-w-0">
      <span className="block text-xs font-medium text-text-secondary mb-1.5">{label}</span>
      {children}
      {hint && <span className="block mt-1 text-[11.5px] text-muted">{hint}</span>}
    </label>
  )
}

export const inputCls = 'w-full min-w-0 rounded-xl border border-line bg-white/70 px-3 py-2 text-[13.5px] leading-6 text-navy outline-none placeholder:text-muted/70 focus:border-accent focus:ring-4 focus:ring-accent/10 transition'

export function Th({ children, className = '' }: { children?: React.ReactNode; className?: string }) {
  return <th className={`text-left align-top px-4 py-2.5 text-[11.5px] leading-5 font-medium uppercase tracking-wide text-muted ${className}`}>{children}</th>
}
export function Td({ children, className = '' }: { children?: React.ReactNode; className?: string }) {
  return <td className={`align-top px-4 py-3 text-[13.5px] leading-6 ${className}`}>{children}</td>
}

export function Progress({ value, tone = 'accent' }: { value: number; tone?: 'accent' | 'green' | 'red' }) {
  const c = tone === 'green' ? 'bg-emerald-500' : tone === 'red' ? 'bg-red-400' : 'bg-accent'
  return (
    <div className="h-1.5 w-full rounded-full bg-line overflow-hidden">
      <div className={`h-full ${c} transition-[width] duration-500`} style={{ width: `${value}%` }} />
    </div>
  )
}

export function Terminal({ lines, className = '' }: { lines: string[]; className?: string }) {
  return (
    <pre className={`rounded-xl bg-[#2a241d] text-[#f3e7c7] font-mono text-[11.5px] leading-relaxed p-4 overflow-auto whitespace-pre-wrap ${className}`}>
      {lines.map((l, i) => (
        <div key={i} className={l.startsWith('$') ? 'text-accent' : l.startsWith('✓') ? 'text-emerald-300' : l.startsWith('✗') ? 'text-red-300' : ''}>{l}</div>
      ))}
    </pre>
  )
}

export function Toggle({ checked, onChange, label, disabled = false }: { checked: boolean; onChange: (v: boolean) => void; label?: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative shrink-0 w-9 h-5 rounded-full transition-colors ${checked ? 'bg-accent' : 'bg-line'}`}
    >
      <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-4' : ''}`} />
    </button>
  )
}
