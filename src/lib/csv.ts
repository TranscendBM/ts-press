import {
  LANGUAGES,
  LISTS,
  LIST_DEFAULT_LANGUAGE,
  LIST_LABELS,
  type Language,
  type ListId,
} from '../constants'
import type { MediaContact } from '../types'

export const CSV_HEADERS = [
  '姓名',
  'Email',
  '媒體',
  '職稱',
  '名單',
  '語言',
  '備註',
] as const

/** 使用者可能輸入的各種名單寫法 → ListId。 */
const LIST_ALIASES: Record<string, ListId> = {}
for (const id of LISTS) {
  LIST_ALIASES[id] = id
  // 「台灣 PR」「台灣PR」都要能對上
  LIST_ALIASES[LIST_LABELS[id].replace(/\s/g, '')] = id
}
Object.assign(LIST_ALIASES, {
  tw: 'tw_pr',
  twpr: 'tw_pr',
  twir: 'tw_ir',
  globalpr: 'global_pr',
  global: 'global_pr',
  uspr: 'us_pr',
  us: 'us_pr',
} satisfies Record<string, ListId>)

function normalizeList(raw: string): ListId | null {
  const key = raw.trim().replace(/\s/g, '')
  return LIST_ALIASES[key] ?? LIST_ALIASES[key.toLowerCase()] ?? null
}

/** 解析一行 CSV，處理雙引號包住的欄位與跳脫的 ""。 */
function splitCsvLine(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"'
          i++
        } else {
          quoted = false
        }
      } else {
        cur += ch
      }
    } else if (ch === '"') {
      quoted = true
    } else if (ch === ',') {
      out.push(cur)
      cur = ''
    } else {
      cur += ch
    }
  }
  out.push(cur)
  return out.map((s) => s.trim())
}

export interface ParsedCsv {
  rows: Omit<MediaContact, 'id' | 'active' | 'createdAt' | 'updatedAt'>[]
  errors: string[]
}

export function parseContactsCsv(text: string): ParsedCsv {
  const rows: ParsedCsv['rows'] = []
  const errors: string[] = []
  const seen = new Set<string>()

  const lines = text
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '')

  if (lines.length === 0) return { rows, errors }

  // 第一列若看起來像標題就跳過
  const first = splitCsvLine(lines[0])
  const hasHeader = /email/i.test(first.join(','))
  const body = hasHeader ? lines.slice(1) : lines

  body.forEach((line, idx) => {
    const lineNo = idx + (hasHeader ? 2 : 1)
    const [name, email, outlet, title, listRaw, langRaw, note] =
      splitCsvLine(line)

    if (!email) {
      errors.push(`第 ${lineNo} 行：缺少 Email，已略過`)
      return
    }
    const mail = email.toLowerCase()
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail)) {
      errors.push(`第 ${lineNo} 行：Email 格式不正確（${email}），已略過`)
      return
    }
    if (seen.has(mail)) {
      errors.push(`第 ${lineNo} 行：CSV 內 Email 重複（${mail}），已略過`)
      return
    }
    seen.add(mail)

    const lists: ListId[] = []
    for (const part of (listRaw ?? '').split(/[;、,|/]/)) {
      if (!part.trim()) continue
      const id = normalizeList(part)
      if (id) {
        if (!lists.includes(id)) lists.push(id)
      } else {
        errors.push(`第 ${lineNo} 行：無法辨識的名單「${part.trim()}」`)
      }
    }

    const langKey = (langRaw ?? '').trim().toLowerCase()
    const language: Language = LANGUAGES.includes(langKey as Language)
      ? (langKey as Language)
      : lists.length > 0
        ? LIST_DEFAULT_LANGUAGE[lists[0]]
        : 'tw'

    rows.push({
      name: (name ?? '').trim() || mail,
      email: mail,
      outlet: (outlet ?? '').trim(),
      title: (title ?? '').trim(),
      note: (note ?? '').trim(),
      lists,
      language,
    })
  })

  return { rows, errors }
}

function escapeCell(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
}

export function contactsToCsv(contacts: MediaContact[]): string {
  const lines = [CSV_HEADERS.join(',')]
  for (const c of contacts) {
    lines.push(
      [
        c.name,
        c.email,
        c.outlet ?? '',
        c.title ?? '',
        (c.lists ?? []).map((l) => LIST_LABELS[l]).join(';'),
        c.language,
        c.note ?? '',
      ]
        .map((v) => escapeCell(String(v ?? '')))
        .join(','),
    )
  }
  return lines.join('\n')
}
