import type { Timestamp } from 'firebase/firestore'
import { LANGUAGES, type Language } from '../constants'
import type { PressVersion } from '../types'

export function blankVersions(): Record<Language, PressVersion> {
  return Object.fromEntries(
    LANGUAGES.map((l) => [l, { subject: '', bodyText: '' }]),
  ) as Record<Language, PressVersion>
}

export function formatDate(ts?: Timestamp): string {
  if (!ts?.toDate) return '—'
  return ts.toDate().toLocaleString('zh-TW', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** 今天的 yyyy-mm-dd，用於新聞稿發佈日期預設值。 */
export function todayIso(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
