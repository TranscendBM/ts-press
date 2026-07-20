import { useEffect, useMemo, useState } from 'react'
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
} from 'firebase/firestore'
import { Download, Plus, Search, Trash2, Upload, Pencil } from 'lucide-react'
import { db } from '../lib/firebase'
import PageHeader from '../components/PageHeader'
import {
  Badge,
  Button,
  EmptyState,
  Field,
  Modal,
  Select,
  TextArea,
  TextInput,
} from '../components/ui'
import {
  LANGUAGES,
  LANGUAGE_LABELS,
  LISTS,
  LIST_DEFAULT_LANGUAGE,
  LIST_LABELS,
  type Language,
  type ListId,
} from '../constants'
import type { MediaContact } from '../types'
import { contactsToCsv, parseContactsCsv } from '../lib/csv'

const BLANK: Omit<MediaContact, 'id'> = {
  name: '',
  email: '',
  outlet: '',
  title: '',
  note: '',
  lists: [],
  language: 'tw',
  active: true,
}

export default function ContactsPage() {
  const [contacts, setContacts] = useState<MediaContact[]>([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<ListId | 'all'>('all')
  const [search, setSearch] = useState('')
  const [editing, setEditing] = useState<MediaContact | null>(null)
  const [draft, setDraft] = useState(BLANK)
  const [saving, setSaving] = useState(false)
  const [importOpen, setImportOpen] = useState(false)

  useEffect(() => {
    const q = query(collection(db, 'mediaContacts'), orderBy('name'))
    return onSnapshot(q, (snap) => {
      setContacts(
        snap.docs.map((d) => ({ id: d.id, ...d.data() }) as MediaContact),
      )
      setLoading(false)
    })
  }, [])

  const counts = useMemo(() => {
    const map = Object.fromEntries(LISTS.map((l) => [l, 0])) as Record<
      ListId,
      number
    >
    for (const c of contacts) {
      for (const l of c.lists ?? []) if (l in map) map[l] += 1
    }
    return map
  }, [contacts])

  const visible = useMemo(() => {
    const kw = search.trim().toLowerCase()
    return contacts.filter((c) => {
      if (tab !== 'all' && !(c.lists ?? []).includes(tab)) return false
      if (!kw) return true
      return [c.name, c.email, c.outlet, c.title]
        .filter(Boolean)
        .some((v) => v.toLowerCase().includes(kw))
    })
  }, [contacts, tab, search])

  function openNew() {
    setEditing(null)
    setDraft({
      ...BLANK,
      // 從目前分頁帶入預設名單與語言，少點點擊
      lists: tab === 'all' ? [] : [tab],
      language: tab === 'all' ? 'tw' : LIST_DEFAULT_LANGUAGE[tab],
    })
  }

  function openEdit(c: MediaContact) {
    setEditing(c)
    const { id: _id, ...rest } = c
    void _id
    setDraft({ ...BLANK, ...rest })
  }

  const modalOpen = editing !== null || draft !== BLANK

  async function save() {
    if (!draft.name.trim() || !draft.email.trim()) return
    setSaving(true)
    try {
      const payload = {
        ...draft,
        name: draft.name.trim(),
        email: draft.email.trim().toLowerCase(),
        updatedAt: serverTimestamp(),
      }
      if (editing) {
        await updateDoc(doc(db, 'mediaContacts', editing.id), payload)
      } else {
        await addDoc(collection(db, 'mediaContacts'), {
          ...payload,
          createdAt: serverTimestamp(),
        })
      }
      closeModal()
    } finally {
      setSaving(false)
    }
  }

  function closeModal() {
    setEditing(null)
    setDraft(BLANK)
  }

  async function remove(c: MediaContact) {
    if (!confirm(`確定要刪除「${c.name}」嗎？`)) return
    await deleteDoc(doc(db, 'mediaContacts', c.id))
  }

  function exportCsv() {
    const csv = contactsToCsv(visible)
    // 加 BOM 讓 Excel 正確辨識 UTF-8
    const blob = new Blob(['﻿' + csv], {
      type: 'text/csv;charset=utf-8;',
    })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `媒體名單_${tab}_${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  return (
    <>
      <PageHeader
        title="媒體名單"
        description={`共 ${contacts.length} 位聯絡人`}
        actions={
          <>
            <Button onClick={() => setImportOpen(true)}>
              <Upload className="size-4" />
              匯入 CSV
            </Button>
            <Button onClick={exportCsv}>
              <Download className="size-4" />
              匯出
            </Button>
            <Button variant="primary" onClick={openNew}>
              <Plus className="size-4" />
              新增聯絡人
            </Button>
          </>
        }
      />

      <div className="p-8">
        <div className="mb-5 flex flex-wrap items-center gap-3">
          <div className="flex flex-wrap gap-1 rounded-lg bg-slate-100 p-1">
            <TabButton active={tab === 'all'} onClick={() => setTab('all')}>
              全部 ({contacts.length})
            </TabButton>
            {LISTS.map((l) => (
              <TabButton
                key={l}
                active={tab === l}
                onClick={() => setTab(l)}
              >
                {LIST_LABELS[l]} ({counts[l]})
              </TabButton>
            ))}
          </div>

          <div className="relative ml-auto w-64">
            <Search className="absolute top-2.5 left-3 size-4 text-slate-400" />
            <TextInput
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜尋姓名、Email、媒體…"
              className="pl-9"
            />
          </div>
        </div>

        {loading ? (
          <p className="py-16 text-center text-sm text-slate-400">載入中…</p>
        ) : visible.length === 0 ? (
          <EmptyState
            title="沒有符合的聯絡人"
            description="新增聯絡人或調整搜尋條件。"
            action={
              <Button variant="primary" onClick={openNew}>
                <Plus className="size-4" />
                新增聯絡人
              </Button>
            }
          />
        ) : (
          <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs text-slate-500">
                <tr>
                  <Th>姓名</Th>
                  <Th>Email</Th>
                  <Th>媒體 / 職稱</Th>
                  <Th>所屬名單</Th>
                  <Th>語言</Th>
                  <Th className="w-24 text-right">操作</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {visible.map((c) => (
                  <tr
                    key={c.id}
                    className={c.active === false ? 'opacity-45' : ''}
                  >
                    <Td>
                      <span className="font-medium text-slate-900">
                        {c.name}
                      </span>
                      {c.active === false && (
                        <span className="ml-2 text-xs text-slate-400">
                          （停用）
                        </span>
                      )}
                    </Td>
                    <Td className="text-slate-600">{c.email}</Td>
                    <Td className="text-slate-600">
                      {c.outlet}
                      {c.title && (
                        <span className="text-slate-400"> · {c.title}</span>
                      )}
                    </Td>
                    <Td>
                      <div className="flex flex-wrap gap-1">
                        {(c.lists ?? []).map((l) => (
                          <Badge key={l} tone="blue">
                            {LIST_LABELS[l]}
                          </Badge>
                        ))}
                      </div>
                    </Td>
                    <Td className="text-slate-500">{c.language}</Td>
                    <Td className="text-right">
                      <div className="flex justify-end gap-1">
                        <IconBtn onClick={() => openEdit(c)} label="編輯">
                          <Pencil className="size-4" />
                        </IconBtn>
                        <IconBtn
                          onClick={() => remove(c)}
                          label="刪除"
                          danger
                        >
                          <Trash2 className="size-4" />
                        </IconBtn>
                      </div>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <ContactModal
        open={modalOpen}
        editing={editing}
        draft={draft}
        setDraft={setDraft}
        saving={saving}
        onSave={save}
        onClose={closeModal}
      />

      <ImportModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        existing={contacts}
      />
    </>
  )
}

function ContactModal({
  open,
  editing,
  draft,
  setDraft,
  saving,
  onSave,
  onClose,
}: {
  open: boolean
  editing: MediaContact | null
  draft: Omit<MediaContact, 'id'>
  setDraft: (d: Omit<MediaContact, 'id'>) => void
  saving: boolean
  onSave: () => void
  onClose: () => void
}) {
  function toggleList(l: ListId) {
    const has = draft.lists.includes(l)
    const lists = has
      ? draft.lists.filter((x) => x !== l)
      : [...draft.lists, l]
    // 勾第一個名單時，順手把語言帶成該名單的預設值
    const language =
      !has && draft.lists.length === 0 ? LIST_DEFAULT_LANGUAGE[l] : draft.language
    setDraft({ ...draft, lists, language })
  }

  return (
    <Modal
      open={open}
      title={editing ? '編輯聯絡人' : '新增聯絡人'}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button
            variant="primary"
            onClick={onSave}
            disabled={saving || !draft.name.trim() || !draft.email.trim()}
          >
            {saving ? '儲存中…' : '儲存'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <Field label="姓名 *">
            <TextInput
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder="王小明"
            />
          </Field>
          <Field label="Email *">
            <TextInput
              type="email"
              value={draft.email}
              onChange={(e) => setDraft({ ...draft, email: e.target.value })}
              placeholder="reporter@media.com"
            />
          </Field>
          <Field label="媒體名稱">
            <TextInput
              value={draft.outlet}
              onChange={(e) => setDraft({ ...draft, outlet: e.target.value })}
              placeholder="經濟日報"
            />
          </Field>
          <Field label="職稱">
            <TextInput
              value={draft.title}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              placeholder="記者"
            />
          </Field>
        </div>

        <Field label="所屬名單" hint="可複選；發送時依勾選的名單決定收件人。">
          <div className="flex flex-wrap gap-2">
            {LISTS.map((l) => {
              const on = draft.lists.includes(l)
              return (
                <button
                  key={l}
                  type="button"
                  onClick={() => toggleList(l)}
                  className={`rounded-lg border px-3 py-1.5 text-sm font-medium transition ${
                    on
                      ? 'border-brand-500 bg-brand-50 text-brand-700'
                      : 'border-slate-300 bg-white text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  {LIST_LABELS[l]}
                </button>
              )
            })}
          </div>
        </Field>

        <Field label="收信語言版本" hint="這位聯絡人會收到新聞稿的哪個版本。">
          <Select
            value={draft.language}
            onChange={(e) =>
              setDraft({ ...draft, language: e.target.value as Language })
            }
          >
            {LANGUAGES.map((l) => (
              <option key={l} value={l}>
                {LANGUAGE_LABELS[l]}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="備註">
          <TextArea
            rows={2}
            value={draft.note}
            onChange={(e) => setDraft({ ...draft, note: e.target.value })}
          />
        </Field>

        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={draft.active !== false}
            onChange={(e) => setDraft({ ...draft, active: e.target.checked })}
            className="size-4 rounded border-slate-300"
          />
          啟用（停用後不會收到新聞稿）
        </label>
      </div>
    </Modal>
  )
}

function ImportModal({
  open,
  onClose,
  existing,
}: {
  open: boolean
  onClose: () => void
  existing: MediaContact[]
}) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState('')

  const parsed = useMemo(() => (text ? parseContactsCsv(text) : null), [text])

  async function run() {
    if (!parsed || parsed.rows.length === 0) return
    setBusy(true)
    try {
      const byEmail = new Map(existing.map((c) => [c.email.toLowerCase(), c]))
      let added = 0
      let updated = 0
      for (const row of parsed.rows) {
        const hit = byEmail.get(row.email)
        if (hit) {
          // 已存在的 email 只把名單聯集起來，不覆蓋既有資料
          const lists = Array.from(new Set([...(hit.lists ?? []), ...row.lists]))
          await updateDoc(doc(db, 'mediaContacts', hit.id), {
            lists,
            updatedAt: serverTimestamp(),
          })
          updated += 1
        } else {
          await addDoc(collection(db, 'mediaContacts'), {
            ...row,
            active: true,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          })
          added += 1
        }
      }
      setResult(`匯入完成：新增 ${added} 筆，更新 ${updated} 筆。`)
      setText('')
    } finally {
      setBusy(false)
    }
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    if (f) setText(await f.text())
  }

  return (
    <Modal
      open={open}
      wide
      title="匯入媒體名單 CSV"
      onClose={() => {
        setText('')
        setResult('')
        onClose()
      }}
      footer={
        <>
          <Button onClick={onClose}>關閉</Button>
          <Button
            variant="primary"
            onClick={run}
            disabled={busy || !parsed || parsed.rows.length === 0}
          >
            {busy ? '匯入中…' : `匯入 ${parsed?.rows.length ?? 0} 筆`}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="rounded-lg bg-slate-50 p-3 text-xs text-slate-600">
          <p className="mb-1 font-medium text-slate-700">格式（第一列為標題）</p>
          <code className="block">姓名,Email,媒體,職稱,名單,語言,備註</code>
          <p className="mt-2">
            「名單」欄可用頓號或分號分隔多個，例如
            <code className="mx-1">台灣PR;GlobalPR</code>。 Email
            重複時只會把名單聯集進既有資料，不會覆蓋。
          </p>
        </div>

        <input
          type="file"
          accept=".csv,text/csv"
          onChange={onFile}
          className="block w-full text-sm text-slate-600 file:mr-3 file:rounded-lg file:border-0 file:bg-brand-50 file:px-4 file:py-2 file:text-sm file:font-medium file:text-brand-700"
        />

        <TextArea
          rows={8}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="或直接貼上 CSV 內容…"
          className="font-mono text-xs"
        />

        {parsed && parsed.errors.length > 0 && (
          <div className="rounded-lg bg-amber-50 p-3 text-xs text-amber-800">
            {parsed.errors.slice(0, 5).map((e, i) => (
              <div key={i}>{e}</div>
            ))}
            {parsed.errors.length > 5 && (
              <div>…另有 {parsed.errors.length - 5} 個問題</div>
            )}
          </div>
        )}

        {result && (
          <div className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800">
            {result}
          </div>
        )}
      </div>
    </Modal>
  )
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
        active
          ? 'bg-white text-slate-900 shadow-sm'
          : 'text-slate-500 hover:text-slate-800'
      }`}
    >
      {children}
    </button>
  )
}

function Th({
  children,
  className = '',
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <th className={`px-4 py-3 font-medium ${className}`}>{children}</th>
  )
}

function Td({
  children,
  className = '',
}: {
  children: React.ReactNode
  className?: string
}) {
  return <td className={`px-4 py-3 align-middle ${className}`}>{children}</td>
}

function IconBtn({
  children,
  onClick,
  label,
  danger,
}: {
  children: React.ReactNode
  onClick: () => void
  label: string
  danger?: boolean
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      className={`rounded-lg p-1.5 transition ${
        danger
          ? 'text-slate-400 hover:bg-red-50 hover:text-red-600'
          : 'text-slate-400 hover:bg-slate-100 hover:text-slate-700'
      }`}
    >
      {children}
    </button>
  )
}
