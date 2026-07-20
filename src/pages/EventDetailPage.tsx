import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  collection,
  doc,
  getDoc,
  onSnapshot,
  serverTimestamp,
  setDoc,
} from 'firebase/firestore'
import { ArrowLeft, Download, Search } from 'lucide-react'
import { db } from '../lib/firebase'
import PageHeader from '../components/PageHeader'
import { Button, Select, TextInput } from '../components/ui'
import {
  EVENT_TYPE_LABELS,
  GIFT_TYPES,
  LISTS,
  LIST_LABELS,
  type ListId,
} from '../constants'
import type { EventParticipant, MediaContact, MediaEvent } from '../types'

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
      .sort((a, b) =>
        (a.outlet ?? '').localeCompare(b.outlet ?? '', 'zh-Hant'),
      )
  }, [contacts, listFilter, search, onlyMarked, records])

  const markedCount = Object.values(records).filter((r) => r.attended).length

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
        description={`${EVENT_TYPE_LABELS[event.type]} · ${event.date} · 已標記 ${markedCount} 位`}
        actions={
          <>
            <Button onClick={() => navigate('/events')}>
              <ArrowLeft className="size-4" />
              返回
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

        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
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
        {contact.outlet || '—'}
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
