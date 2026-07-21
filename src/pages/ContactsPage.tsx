import { useEffect, useMemo, useState } from 'react'
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  serverTimestamp,
  updateDoc,
} from 'firebase/firestore'
import {
  ChevronDown,
  ListOrdered,
  Star,
  Merge,
  ChevronUp,
  ChevronsUpDown,
  Download,
  Pencil,
  Plus,
  Search,
  Trash2,
  Upload,
} from 'lucide-react'
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
  MEDIA_TYPES,
  MEDIA_TYPE_LABELS,
  lookupMediaTier,
  type Language,
  type ListId,
  type MediaType,
} from '../constants'
import type { MediaContact } from '../types'
import { contactsToCsv, parseContactsCsv } from '../lib/csv'
import ContactDetail from '../components/ContactDetail'
import { compareContacts } from '../lib/sortContacts'

type SortKey = 'rank' | 'outlet' | 'name' | 'title' | 'email' | 'language'

const BLANK: Omit<MediaContact, 'id'> = {
  name: '',
  email: '',
  altEmail: '',
  outlet: '',
  title: '',
  phone: '',
  note: '',
  mediaType: 'other',
  rank: null,
  starred: false,
  lists: [],
  language: 'tw',
  active: true,
}

export default function ContactsPage() {
  const [contacts, setContacts] = useState<MediaContact[]>([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<ListId | 'all'>('all')
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<{ key: SortKey; asc: boolean }>({
    key: 'rank',
    asc: true,
  })
  const [applying, setApplying] = useState(false)
  const [editing, setEditing] = useState<MediaContact | null>(null)
  const [draft, setDraft] = useState(BLANK)
  const [saving, setSaving] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [detail, setDetail] = useState<MediaContact | null>(null)
  const [merging, setMerging] = useState(false)

  useEffect(() => {
    // 不在查詢端排序：Firestore 的 orderBy 會排除缺少該欄位的文件，排序改在前端做
    return onSnapshot(collection(db, 'mediaContacts'), (snap) => {
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
    const rows = contacts.filter((c) => {
      if (tab !== 'all' && !(c.lists ?? []).includes(tab)) return false
      if (!kw) return true
      return [c.name, c.email, c.altEmail, c.outlet, c.title, c.phone]
        .some((v) => (v ?? '').toLowerCase().includes(kw))
    })

    const dir = sort.asc ? 1 : -1
    return rows.sort((a, b) => {
      if (sort.key === 'rank') {
        // 重要窗口最前、其次 rank；未設定 rank 的一律墊底
        return compareContacts(a, b) * dir
      }
      const av = (a[sort.key] ?? '') as string
      const bv = (b[sort.key] ?? '') as string
      // 中文用 localeCompare 才會照筆劃/拼音排，不然會變成 Unicode 碼順序
      return av.localeCompare(bv, 'zh-Hant') * dir
    })
  }, [contacts, tab, search, sort])

  /** 依建議分類表比對媒體名稱，套用分類與重要性。已設定的會被覆蓋。 */
  async function applySuggestedTiers() {
    const targets = contacts.filter((c) => lookupMediaTier(c.outlet))
    const unmatched = contacts.filter(
      (c) => c.outlet && !lookupMediaTier(c.outlet),
    )
    const msg =
      `將依建議分類表更新 ${targets.length} 位聯絡人的媒體類型與重要性。` +
      (unmatched.length > 0
        ? `\n\n有 ${unmatched.length} 位的媒體不在分類表中，會維持原狀：\n` +
          Array.from(new Set(unmatched.map((c) => c.outlet))).join('、')
        : '')
    if (!confirm(msg)) return

    setApplying(true)
    try {
      for (const c of targets) {
        const tier = lookupMediaTier(c.outlet)!
        await updateDoc(doc(db, 'mediaContacts', c.id), {
          mediaType: tier.type,
          rank: tier.rank,
          updatedAt: serverTimestamp(),
        })
      }
      setSort({ key: 'rank', asc: true })
    } finally {
      setApplying(false)
    }
  }

  /**
   * 合併重複聯絡人：同一位記者若被建成多筆（例如公司信箱與個人信箱各一筆），
   * 保留啟用中的那筆為主，其餘的信箱移到備用 Email 後刪除。
   */
  async function mergeDuplicates() {
    const groups = new Map<string, MediaContact[]>()
    for (const c of contacts) {
      if (!c.name?.trim() || !c.outlet?.trim()) continue
      const key = `${c.outlet.trim()}|${c.name.trim()}`
      groups.set(key, [...(groups.get(key) ?? []), c])
    }
    const dupes = Array.from(groups.values()).filter((g) => g.length > 1)
    if (dupes.length === 0) {
      alert('沒有找到重複的聯絡人（以「媒體 + 姓名」判斷）。')
      return
    }

    const preview = dupes
      .map((g) => {
        const primary = g.find((c) => c.active !== false) ?? g[0]
        const others = g.filter((c) => c.id !== primary.id)
        return `${primary.outlet} ${primary.name}\n  保留：${primary.email}\n  併入備用：${others.map((o) => o.email).join('、')}`
      })
      .join('\n\n')

    if (!confirm(`找到 ${dupes.length} 組重複，將合併如下：\n\n${preview}`)) return

    setMerging(true)
    try {
      for (const g of dupes) {
        const primary = g.find((c) => c.active !== false) ?? g[0]
        const others = g.filter((c) => c.id !== primary.id)
        const alt =
          primary.altEmail?.trim() || others.map((o) => o.email).join(', ')
        await updateDoc(doc(db, 'mediaContacts', primary.id), {
          altEmail: alt,
          updatedAt: serverTimestamp(),
        })
        for (const o of others) {
          await deleteDoc(doc(db, 'mediaContacts', o.id))
        }
      }
    } finally {
      setMerging(false)
    }
  }

  async function toggleStar(e: React.MouseEvent, c: MediaContact) {
    e.stopPropagation()
    await updateDoc(doc(db, 'mediaContacts', c.id), {
      starred: !c.starred,
      updatedAt: serverTimestamp(),
    })
  }

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
        // Firestore 不接受 undefined，沒填的重要性一律存成 null
        rank: draft.rank ?? null,
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
            <Button onClick={applySuggestedTiers} disabled={applying}>
              <ListOrdered className="size-4" />
              {applying ? '套用中…' : '套用建議分類'}
            </Button>
            <Button onClick={mergeDuplicates} disabled={merging}>
              <Merge className="size-4" />
              {merging ? '合併中…' : '合併重複'}
            </Button>
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
          <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs text-slate-500">
                <tr>
                  <Th className="w-10">{null}</Th>
                  <SortTh sortKey="rank" sort={sort} setSort={setSort}>
                    重要性
                  </SortTh>
                  <SortTh sortKey="outlet" sort={sort} setSort={setSort}>
                    媒體
                  </SortTh>
                  <Th>類型</Th>
                  <SortTh sortKey="name" sort={sort} setSort={setSort}>
                    姓名
                  </SortTh>
                  <SortTh sortKey="title" sort={sort} setSort={setSort}>
                    職稱
                  </SortTh>
                  <Th>所屬名單</Th>
                  <SortTh sortKey="language" sort={sort} setSort={setSort}>
                    語言
                  </SortTh>
                  <Th className="w-24 text-right">操作</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {visible.map((c) => (
                  <tr
                    key={c.id}
                    onClick={() => setDetail(c)}
                    className={`cursor-pointer transition hover:bg-slate-50 ${
                      c.active === false ? 'opacity-45' : ''
                    }`}
                  >
                    <Td
                      className="pr-0 text-center"
                      onClick={(e) => toggleStar(e, c)}
                    >
                      <button
                        title={c.starred ? '取消重要窗口' : '標記為重要窗口'}
                        className={`rounded p-1 transition ${
                          c.starred
                            ? 'text-amber-400 hover:text-amber-500'
                            : 'text-slate-200 hover:text-slate-400'
                        }`}
                      >
                        <Star
                          className="size-4"
                          fill={c.starred ? 'currentColor' : 'none'}
                        />
                      </button>
                    </Td>
                    <Td className="text-center text-slate-400">
                      {c.rank ?? '—'}
                    </Td>
                    <Td>
                      <span className="font-medium text-slate-900">
                        {c.outlet || '—'}
                      </span>
                      {c.active === false && (
                        <span className="ml-2 text-xs text-slate-400">
                          （停用）
                        </span>
                      )}
                    </Td>
                    <Td>
                      {c.mediaType && c.mediaType !== 'other' ? (
                        <Badge>{MEDIA_TYPE_LABELS[c.mediaType]}</Badge>
                      ) : (
                        <span className="text-slate-300">—</span>
                      )}
                    </Td>
                    <Td
                      className="text-slate-700"
                      onClick={(e) => {
                        e.stopPropagation()
                        openEdit(c)
                      }}
                    >
                      <span
                        className="cursor-text rounded px-1.5 py-1 -mx-1.5 transition hover:bg-brand-50 hover:text-brand-700"
                        title="點擊編輯這位聯絡人"
                      >
                        {c.name || (
                          <span className="text-slate-400">（未填姓名）</span>
                        )}
                      </span>
                    </Td>
                    <Td className="text-slate-500">{c.title || '—'}</Td>

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
                    <Td
                      className="text-right"
                      onClick={(e) => e.stopPropagation()}
                    >
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

      <ContactDetail
        contact={detail}
        onClose={() => setDetail(null)}
        onEdit={openEdit}
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
          <Field
            label="備用 Email"
            hint="記者的第二信箱。發稿時不會另外寄一封，僅供查詢。"
          >
            <TextInput
              type="email"
              value={draft.altEmail ?? ''}
              onChange={(e) => setDraft({ ...draft, altEmail: e.target.value })}
              placeholder="選填"
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
          <Field label="電話">
            <TextInput
              value={draft.phone}
              onChange={(e) => setDraft({ ...draft, phone: e.target.value })}
              placeholder="0912-345-678"
            />
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <Field label="媒體類型">
            <Select
              value={draft.mediaType ?? 'other'}
              onChange={(e) =>
                setDraft({ ...draft, mediaType: e.target.value as MediaType })
              }
            >
              {MEDIA_TYPES.map((t) => (
                <option key={t} value={t}>
                  {MEDIA_TYPE_LABELS[t]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="重要性排序" hint="數字越小越前面，留空則排在最後。">
            <TextInput
              type="number"
              value={draft.rank ?? ''}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  rank: e.target.value === '' ? undefined : Number(e.target.value),
                })
              }
              placeholder="例如 1"
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
          <code className="block">姓名,Email,媒體,職稱,電話,名單,語言,備註,啟用</code>
          <p className="mt-2">
            欄位順序不拘，系統會依標題列自動對應，用不到的欄位可以省略。
            「名單」欄可用分號分隔多個，例如
            <code className="mx-1">台灣PR;測試名單</code>。
            「啟用」欄留空視為啟用，填<code className="mx-1">否</code>則匯入後不會收信。
            Email 重複時只會把名單聯集進既有資料，不會覆蓋。
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

/** 可點擊排序的表頭。再點一次切換升冪／降冪。 */
function SortTh({
  sortKey,
  sort,
  setSort,
  children,
}: {
  sortKey: SortKey
  sort: { key: SortKey; asc: boolean }
  setSort: (s: { key: SortKey; asc: boolean }) => void
  children: React.ReactNode
}) {
  const active = sort.key === sortKey
  return (
    <th className="px-4 py-3 font-medium">
      <button
        onClick={() =>
          setSort({ key: sortKey, asc: active ? !sort.asc : true })
        }
        className={`flex items-center gap-1 transition hover:text-slate-800 ${
          active ? 'text-slate-800' : ''
        }`}
      >
        {children}
        {active ? (
          sort.asc ? (
            <ChevronUp className="size-3.5" />
          ) : (
            <ChevronDown className="size-3.5" />
          )
        ) : (
          <ChevronsUpDown className="size-3.5 opacity-30" />
        )}
      </button>
    </th>
  )
}

function Td({
  children,
  className = '',
  onClick,
}: {
  children: React.ReactNode
  className?: string
  onClick?: React.MouseEventHandler<HTMLTableCellElement>
}) {
  return (
    <td className={`px-4 py-3 align-middle ${className}`} onClick={onClick}>
      {children}
    </td>
  )
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
          : 'text-brand-600 hover:bg-brand-50 hover:text-brand-700'
      }`}
    >
      {children}
    </button>
  )
}
