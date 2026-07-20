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
  '電話',
  '名單',
  '語言',
  '備註',
  '啟用',
] as const

/** 標題列可能出現的各種寫法 → 內部欄位名。 */
const COLUMN_ALIASES: Record<string, keyof ParsedRow> = {
  姓名: 'name',
  名字: 'name',
  聯絡人: 'name',
  name: 'name',
  email: 'email',
  信箱: 'email',
  電子郵件: 'email',
  媒體: 'outlet',
  媒體名稱: 'outlet',
  outlet: 'outlet',
  職稱: 'title',
  title: 'title',
  電話: 'phone',
  手機: 'phone',
  phone: 'phone',
  名單: 'lists',
  分類: 'lists',
  lists: 'lists',
  語言: 'language',
  language: 'language',
  備註: 'note',
  note: 'note',
  啟用: 'active',
  active: 'active',
}

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
  測試: 'test',
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

type ParsedRow = Omit<MediaContact, 'id' | 'createdAt' | 'updatedAt'>

export interface ParsedCsv {
  rows: ParsedRow[]
  errors: string[]
}

/** 沒有標題列時的預設欄位順序。 */
const DEFAULT_ORDER: (keyof ParsedRow)[] = [
  'name',
  'email',
  'outlet',
  'title',
  'phone',
  'lists',
  'language',
  'note',
  'active',
]

function buildColumnMap(header: string[]): Partial<
  Record<keyof ParsedRow, number>
> | null {
  const map: Partial<Record<keyof ParsedRow, number>> = {}
  let matched = 0
  header.forEach((cell, idx) => {
    const key = cell.trim().replace(/\s/g, '').toLowerCase()
    const field =
      COLUMN_ALIASES[cell.trim().replace(/\s/g, '')] ?? COLUMN_ALIASES[key]
    // 同名欄位只取第一個，例如「Email」與「Email 2」只會對到前者
    if (field && map[field] === undefined) {
      map[field] = idx
      matched += 1
    }
  })
  // 至少要認得出 Email 才算是標題列
  return matched >= 2 && map.email !== undefined ? map : null
}

export function parseContactsCsv(text: string): ParsedCsv {
  const rows: ParsedRow[] = []
  const errors: string[] = []
  const seen = new Set<string>()

  const lines = text
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '' && l.replace(/,/g, '').trim() !== '')

  if (lines.length === 0) return { rows, errors }

  const columnMap = buildColumnMap(splitCsvLine(lines[0]))
  const body = columnMap ? lines.slice(1) : lines
  const map =
    columnMap ??
    (Object.fromEntries(DEFAULT_ORDER.map((f, i) => [f, i])) as Record<
      keyof ParsedRow,
      number
    >)

  body.forEach((line, idx) => {
    const lineNo = idx + (columnMap ? 2 : 1)
    const cells = splitCsvLine(line)
    const get = (field: keyof ParsedRow) => {
      const at = map[field]
      return at === undefined ? '' : (cells[at] ?? '').trim()
    }

    const email = get('email').toLowerCase()
    if (!email) {
      errors.push(`第 ${lineNo} 行：缺少 Email，已略過`)
      return
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      errors.push(`第 ${lineNo} 行：Email 格式不正確（${email}），已略過`)
      return
    }
    if (seen.has(email)) {
      errors.push(`第 ${lineNo} 行：CSV 內 Email 重複（${email}），已略過`)
      return
    }
    seen.add(email)

    const lists: ListId[] = []
    for (const part of get('lists').split(/[;、,|/]/)) {
      if (!part.trim()) continue
      const id = normalizeList(part)
      if (id) {
        if (!lists.includes(id)) lists.push(id)
      } else {
        errors.push(`第 ${lineNo} 行：無法辨識的名單「${part.trim()}」`)
      }
    }

    const langKey = get('language').toLowerCase()
    const language: Language = LANGUAGES.includes(langKey as Language)
      ? (langKey as Language)
      : lists.length > 0
        ? LIST_DEFAULT_LANGUAGE[lists[0]]
        : 'tw'

    // 「啟用」欄留空視為啟用，只有明確填否定值才停用
    const activeRaw = get('active').toLowerCase()
    const active = !['否', 'false', 'no', '0', '停用', 'n'].includes(activeRaw)

    rows.push({
      name: get('name'),
      email,
      outlet: get('outlet'),
      title: get('title'),
      phone: get('phone'),
      note: get('note'),
      lists,
      language,
      active,
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
        c.phone ?? '',
        (c.lists ?? []).map((l) => LIST_LABELS[l]).join(';'),
        c.language,
        c.note ?? '',
        c.active === false ? '否' : '是',
      ]
        .map((v) => escapeCell(String(v ?? '')))
        .join(','),
    )
  }
  return lines.join('\n')
}
