import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  collection,
  doc,
  getDoc,
  onSnapshot,
  serverTimestamp,
  setDoc,
  updateDoc,
} from 'firebase/firestore'
import { ArrowLeft, Download, Pencil, Search, Star } from 'lucide-react'
import { db } from '../lib/firebase'
import PageHeader from '../components/PageHeader'
import {
  Button,
  Field,
  Modal,
  Select,
  TextArea,
  TextInput,
} from '../components/ui'
import {
  EVENT_TYPES,
  EVENT_TYPE_LABELS,
  eventTypeLabel,
  GIFT_TYPES,
  LISTS,
  LIST_LABELS,
  type EventType,
  type ListId,
} from '../constants'
import type { EventParticipant, MediaContact, MediaEvent } from '../types'
import { compareContacts } from '../lib/sortContacts'

export default function EventDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()

  const [event, setEvent] = useState<MediaEvent | null>(null)
  const [contacts, setContacts] = useState<MediaContact[]>([])
  const [records, setRecords] = useState<Record<string, EventParticipant>>({})
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  // 台灣媒體是主要對象，預設就篩台灣 PR
  const [listFilter, setListFilter] = useState<ListId | 'all'>('tw_pr')
  const [onlyMarked, setOnlyMarked] = useState(false)
  const [editOpen, setEditOpen] = useState(false)
  const [savingEvent, setSavingEvent] = useState(false)
  const [form, setForm] = useState({
    name: '',
    type: 'meal' as EventType,
    date: '',
    note: '',
  })

  useEffect(() => {
    if (!id) return
    getDoc(doc(db, 'mediaEvents', id)).then((snap) => {
      if (snap.exists()) setEvent({ id: snap.id, ...snap.data() } as MediaEvent)
      setLoading(false)
    })
    const unsubContacts = onSnapshot(
      collection(db, 'mediaContacts'),
      (snap) => {
        setContacts(
          snap.docs.map((d) => ({ id: d.id, ...d.data() }) as MediaContact),
        )
      },
    )
    const unsubRecords = onSnapshot(
      collection(db, 'mediaEvents', id, 'participants'),
      (snap) => {
        const map: Record<string, EventParticipant> = {}
        for (const d of snap.docs) map[d.id] = d.data() as EventParticipant
        setRecords(map)
      },
    )
    return () => {
      unsubContacts()
      unsubRecords()
    }
  }, [id])

  const isGift = event ? GIFT_TYPES.includes(event.type) : false
  const actionLabel = isGift ? '已致贈' : '出席'

  const visible = useMemo(() => {
    const kw = search.trim().toLowerCase()
    return contacts
      .filter((c) => {
        if (listFilter !== 'all' && !(c.lists ?? []).includes(listFilter))
          return false
        if (onlyMarked && !records[c.id]?.attended) return false
        if (!kw) return true
        return [c.outlet, c.name, c.title]
          .filter(Boolean)
          .some((v) => v.toLowerCase().includes(kw))
      })
      .sort(compareContacts)
  }, [contacts, listFilter, search, onlyMarked, records])

  const markedCount = Object.values(records).filter((r) => r.attended).length

  function openEdit() {
    if (!event) return
    setForm({
      name: event.name,
      // 舊資料可能存著已移除的類型（例如媒體茶會），下拉沒有對應選項會顯示空白
      type: EVENT_TYPES.includes(event.type) ? event.type : 'other',
      date: event.date,
      note: event.note ?? '',
    })
    setEditOpen(true)
  }

  async function saveEvent() {
    if (!id || !form.name.trim() || !form.date) return
    setSavingEvent(true)
    try {
      await updateDoc(doc(db, 'mediaEvents', id), {
        name: form.name.trim(),
        type: form.type,
        date: form.date,
        // year 是由日期推導的欄位，改日期時要一起更新，否則年份篩選會對不上
        year: Number(form.date.slice(0, 4)),
        note: form.note.trim(),
        updatedAt: serverTimestamp(),
      })
      setEvent((prev) =>
        prev
          ? {
              ...prev,
              name: form.name.trim(),
              type: form.type,
              date: form.date,
              year: Number(form.date.slice(0, 4)),
              note: form.note.trim(),
            }
          : prev,
      )
      setEditOpen(false)
    } finally {
      setSavingEvent(false)
    }
  }

  async function save(contactId: string, patch: Partial<EventParticipant>) {
    if (!id) return
    const current = records[contactId] ?? { attended: false, note: '' }
    await setDoc(
      doc(db, 'mediaEvents', id, 'participants', contactId),
      {
        contactId,
        attended: current.attended,
        note: current.note ?? '',
        ...patch,
        updatedAt: serverTimestamp(),
      },
      { merge: true },
    )
  }

  function exportCsv() {
    const rows = [['媒體', '姓名', '職稱', actionLabel, '備註'].join(',')]
    for (const c of visible) {
      const r = records[c.id]
      rows.push(
        [c.outlet, c.name, c.title, r?.attended ? 'V' : '', r?.note ?? '']
          .map((v) => {
            const s = String(v ?? '')
            return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
          })
          .join(','),
      )
    }
    const blob = new Blob(['﻿' + rows.join('\n')], {
      type: 'text/csv;charset=utf-8;',
    })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${event?.name ?? '活動'}_名單.csv`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  if (loading) {
    return <p className="p-16 text-center text-sm text-slate-400">載入中…</p>
  }
  if (!event) {
    return <p className="p-16 text-center text-sm text-slate-400">找不到這場活動。</p>
  }

  return (
    <>
      <PageHeader
        title={event.name}
        description={`${eventTypeLabel(event.type)} · ${event.date} · 已標記 ${markedCount} 位`}
        actions={
          <>
            <Button onClick={() => navigate('/events')}>
              <ArrowLeft className="size-4" />
              返回
            </Button>
            <Button onClick={openEdit}>
              <Pencil className="size-4" />
              編輯活動
            </Button>
            <Button onClick={exportCsv}>
              <Download className="size-4" />
              匯出名單
            </Button>
          </>
        }
      />

      <div className="p-8">
        <div className="mb-5 flex flex-wrap items-center gap-3">
          <Select
            value={listFilter}
            onChange={(e) => setListFilter(e.target.value as ListId | 'all')}
            className="w-40"
          >
            <option value="all">全部名單</option>
            {LISTS.map((l) => (
              <option key={l} value={l}>
                {LIST_LABELS[l]}
              </option>
            ))}
          </Select>

          <label className="flex items-center gap-2 text-sm text-slate-600">
            <input
              type="checkbox"
              checked={onlyMarked}
              onChange={(e) => setOnlyMarked(e.target.checked)}
              className="size-4 rounded border-slate-300"
            />
            只看已標記
          </label>

          <div className="relative ml-auto w-64">
            <Search className="absolute top-2.5 left-3 size-4 text-slate-400" />
            <TextInput
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜尋媒體或姓名…"
              className="pl-9"
            />
          </div>
        </div>

        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs text-slate-500">
              <tr>
                <th className="w-20 px-4 py-3 text-center font-medium">
                  {actionLabel}
                </th>
                <th className="px-4 py-3 font-medium">媒體</th>
                <th className="px-4 py-3 font-medium">姓名 / 職稱</th>
                <th className="px-4 py-3 font-medium">備註</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {visible.map((c) => (
                <ParticipantRow
                  key={c.id}
                  contact={c}
                  record={records[c.id]}
                  onToggle={(v) => save(c.id, { attended: v })}
                  onNote={(v) => save(c.id, { note: v })}
                />
              ))}
            </tbody>
          </table>
          {visible.length === 0 && (
            <p className="py-12 text-center text-sm text-slate-400">
              沒有符合條件的媒體
            </p>
          )}
        </div>
      </div>

      <Modal
        open={editOpen}
        title="編輯活動"
        onClose={() => setEditOpen(false)}
        footer={
          <>
            <Button onClick={() => setEditOpen(false)}>取消</Button>
            <Button
              variant="primary"
              onClick={saveEvent}
              disabled={savingEvent || !form.name.trim() || !form.date}
            >
              {savingEvent ? '儲存中…' : '儲存'}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="活動名稱">
            <TextInput
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="2026 中秋禮品"
            />
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label="類型">
              <Select
                value={form.type}
                onChange={(e) =>
                  setForm({ ...form, type: e.target.value as EventType })
                }
              >
                {EVENT_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {EVENT_TYPE_LABELS[t]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="日期">
              <TextInput
                type="date"
                value={form.date}
                onChange={(e) => setForm({ ...form, date: e.target.value })}
              />
            </Field>
          </div>
          <Field label="備註">
            <TextArea
              rows={2}
              value={form.note}
              onChange={(e) => setForm({ ...form, note: e.target.value })}
              placeholder="地點、預算、主辦人…"
            />
          </Field>
        </div>
      </Modal>
    </>
  )
}

function ParticipantRow({
  contact,
  record,
  onToggle,
  onNote,
}: {
  contact: MediaContact
  record?: EventParticipant
  onToggle: (v: boolean) => void
  onNote: (v: string) => void
}) {
  const [note, setNote] = useState(record?.note ?? '')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 外部資料更新時同步，但不要打斷正在輸入的內容
  useEffect(() => {
    if (document.activeElement?.getAttribute('data-note') !== contact.id) {
      setNote(record?.note ?? '')
    }
  }, [record?.note, contact.id])

  // 備註邊打邊存，延遲 600ms 避免每個字都寫一次資料庫
  function change(v: string) {
    setNote(v)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => onNote(v), 600)
  }

  const marked = !!record?.attended

  return (
    <tr className={marked ? 'bg-emerald-50/40' : ''}>
      <td className="px-4 py-2.5 text-center">
        <input
          type="checkbox"
          checked={marked}
          onChange={(e) => onToggle(e.target.checked)}
          className="size-4.5 rounded border-slate-300"
        />
      </td>
      <td className="px-4 py-2.5 font-medium text-slate-900">
        <span className="inline-flex items-center gap-1.5">
          {contact.starred && (
            <Star
              className="size-3.5 shrink-0 text-amber-400"
              fill="currentColor"
            />
          )}
          {contact.outlet || '—'}
        </span>
      </td>
      <td className="px-4 py-2.5 text-slate-600">
        {contact.name || <span className="text-slate-400">（未填姓名）</span>}
        {contact.title && (
          <span className="text-slate-400"> · {contact.title}</span>
        )}
      </td>
      <td className="px-4 py-2">
        <input
          data-note={contact.id}
          value={note}
          onChange={(e) => change(e.target.value)}
          onBlur={() => {
            if (timer.current) clearTimeout(timer.current)
            onNote(note)
          }}
          placeholder="—"
          className="w-full rounded-md border border-transparent bg-transparent px-2 py-1 text-sm text-slate-700 outline-none transition placeholder:text-slate-300 hover:border-slate-200 focus:border-brand-500 focus:bg-white focus:ring-2 focus:ring-brand-100"
        />
      </td>
    </tr>
  )
}
