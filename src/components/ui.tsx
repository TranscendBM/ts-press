import type { ReactNode } from 'react'
import { X } from 'lucide-react'

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost'

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-brand-600 text-white hover:bg-brand-700 disabled:bg-brand-600/50',
  secondary:
    'border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 disabled:opacity-50',
  danger: 'bg-red-600 text-white hover:bg-red-700 disabled:bg-red-600/50',
  ghost: 'text-slate-600 hover:bg-slate-100 disabled:opacity-50',
}

export function Button({
  variant = 'secondary',
  className = '',
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant
}) {
  return (
    <button
      {...props}
      className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition disabled:cursor-not-allowed ${VARIANTS[variant]} ${className}`}
    />
  )
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: ReactNode
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium text-slate-700">
        {label}
      </span>
      {/* 表單欄位裡的控制項一律撐滿，篩選列等自由擺放的控制項則自行指定寬度 */}
      <span className="block [&_input:not([type=checkbox])]:w-full [&_select]:w-full [&_textarea]:w-full">
        {children}
      </span>
      {hint && <span className="mt-1 block text-xs text-slate-400">{hint}</span>}
    </label>
  )
}

/**
 * 表單控制項的共用樣式。寬度刻意不寫在這裡 ——
 * 若在此加上 w-full，呼叫端傳入的 w-44 之類會因為同層級同權重而失效，
 * 實際結果取決於產生的 CSS 順序，很難預期。寬度一律由呼叫端決定。
 */
const CONTROL =
  'rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-brand-500 focus:ring-2 focus:ring-brand-100'

export function TextInput(
  props: React.InputHTMLAttributes<HTMLInputElement> & { className?: string },
) {
  const { className = '', ...rest } = props
  return <input {...rest} className={`${CONTROL} ${className}`} />
}

export function TextArea(
  props: React.TextareaHTMLAttributes<HTMLTextAreaElement> & {
    className?: string
  },
) {
  const { className = '', ...rest } = props
  return <textarea {...rest} className={`${CONTROL} ${className}`} />
}

export function Select(
  props: React.SelectHTMLAttributes<HTMLSelectElement> & { className?: string },
) {
  const { className = '', ...rest } = props
  return <select {...rest} className={`${CONTROL} ${className}`} />
}

export function Badge({
  children,
  tone = 'slate',
}: {
  children: ReactNode
  tone?: 'slate' | 'blue' | 'green' | 'amber' | 'red'
}) {
  const tones = {
    slate: 'bg-slate-100 text-slate-600',
    blue: 'bg-brand-50 text-brand-700',
    green: 'bg-emerald-50 text-emerald-700',
    amber: 'bg-amber-50 text-amber-700',
    red: 'bg-red-50 text-red-700',
  }
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${tones[tone]}`}
    >
      {children}
    </span>
  )
}

export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
  wide,
}: {
  open: boolean
  title: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  wide?: boolean
}) {
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-3 sm:p-6">
      {/*
       * round 31：改成 flex-col + max-h，讓標題列與底部操作列固定，只有
       * 中間內容區在內容過長時自己捲動——修改前是整個 overlay 用
       * overflow-y-auto，內容一長，標題跟底部確認／取消按鈕會直接被捲出
       * 畫面外，手機上尤其容易發生（見 CSV 匯入、預覽 iframe 等長內容
       * modal）。
       */}
      <div
        className={`flex max-h-[calc(100vh-1.5rem)] w-full flex-col rounded-2xl bg-white shadow-2xl sm:max-h-[85vh] ${wide ? 'max-w-3xl' : 'max-w-lg'}`}
      >
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-slate-200 px-4 py-4 sm:px-6">
          <h2 className="min-w-0 break-words text-base font-semibold text-slate-900">
            {title}
          </h2>
          <button
            onClick={onClose}
            aria-label="關閉"
            className="flex size-10 shrink-0 items-center justify-center rounded-lg text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
          >
            <X className="size-5" />
          </button>
        </div>
        <div className="overflow-y-auto px-4 py-5 sm:px-6">{children}</div>
        {footer && (
          <div className="flex shrink-0 flex-col gap-2 border-t border-slate-200 px-4 py-4 sm:flex-row sm:justify-end sm:px-6 [&>button]:w-full sm:[&>button]:w-auto">
            {footer}
          </div>
        )}
      </div>
    </div>
  )
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string
  description?: string
  action?: ReactNode
}) {
  return (
    <div className="rounded-xl border border-dashed border-slate-300 bg-white px-6 py-16 text-center">
      <p className="text-sm font-medium text-slate-700">{title}</p>
      {description && (
        <p className="mt-1 text-sm text-slate-400">{description}</p>
      )}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  )
}
