import { useEffect, useMemo, useState } from 'react'
import { collection, getDocs } from 'firebase/firestore'
import { Check, Download, Star } from 'lucide-react'
import { db } from '../lib/firebase'
import PageHeader from '../components/PageHeader'
import { Badge, Button, Select } from '../components/ui'
import {
  EVENT_TYPES,
  EVENT_TYPE_LABELS,
  GIFT_TYPES,
  LISTS,
  LIST_LABELS,
  type EventType,
  type ListId,
} from '../constants'
import type { EventParticipant, MediaContact, MediaEvent } from '../types'
import { compareContacts } from '../lib/sortContacts'

type Records = Record<string, Record<string, EventParticipant>>

/**
 * 交叉檢視：把同一類型的歷次活動攤成矩陣，
 * 一眼看出「哪幾年的中秋禮品送給了誰」「誰每次餐敘都到」。
 */
export default function EventMatrixPage() {
  const [events, setEvents] = useState<MediaEvent[]>([])
  const [contacts, setContacts] = useState<MediaContact[]>([])
  const [records, setRecords] = useState<Records>({})
  const [loading, setLoading] = useState(true)
  const [type, setType] = useState<EventType | 'all'>('gift_midautumn')
  const [listFilter, setListFilter] = useState<ListId | 'all'>('tw_pr')
  const [onlyMarked, setOnlyMarked] = useState(false)

  useEffect(() => {
    async function load() {
      const [eSnap, cSnap] = await Promise.all([
        getDocs(collection(db, 'mediaEvents')),
        getDocs(collection(db, 'mediaContacts')),
      ])
      const evs = eSnap.docs.map(
        (d) => ({ id: d.id, ...d.data() }) as MediaEvent,
      )
      setEvents(evs)
      setContacts(
        cSnap.docs.map((d) => ({ id: d.id, ...d.data() }) as MediaContact),
      )

      // 一次把所有活動的參加紀錄抓回來，之後切換類型不必重查
      const all: Records = {}
      await Promise.all(
        evs.map(async (ev) => {
          const pSnap = await getDocs(
            collection(db, 'mediaEvents', ev.id, 'participants'),
          )
          all[ev.id] = Object.fromEntries(
            pSnap.docs.map((p) => [p.id, p.data() as EventParticipant]),
          )
        }),
      )
      setRecords(all)
      setLoading(false)
    }
    load()
  }, [])

  /** 欄：符合類型的活動，舊到新排列，方便看出時間推移。 */
  const columns = useMemo(
    () =>
      events
        .filter((e) => type === 'all' || e.type === type)
        .sort((a, b) => (a.date ?? '').localeCompare(b.date ?? '')),
    [events, type],
  )

  /** 列：符合名單的聯絡人，依重要性排序。 */
  const rows = useMemo(() => {
    const list = contacts.filter((c) => {
      if (listFilter !== 'all' && !(c.lists ?? []).includes(listFilter))
        return false
      if (onlyMarked) {
        return columns.some((ev) => records[ev.id]?.[c.id]?.attended)
      }
      return true
    })
    return list.sort(compareContacts)
  }, [contacts, listFilter, onlyMarked, columns, records])

  function countFor(eventId: string) {
    return rows.filter((c) => records[eventId]?.[c.id]?.attended).length
  }

  function exportCsv() {
    const header = ['媒體', '姓名', ...columns.map((e) => e.name), '合計']
    const lines = [header.join(',')]
    for (const c of rows) {
      const cells = columns.map((ev) =>
        records[ev.id]?.[c.id]?.attended ? 'V' : '',
      )
      const total = cells.filter(Boolean).length
      lines.push(
        [c.outlet, c.name, ...cells, String(total)]
          .map((v) => {
            const s = String(v ?? '')
            return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
          })
          .join(','),
      )
    }
    const blob = new Blob(['﻿' + lines.join('\n')], {
      type: 'text/csv;charset=utf-8;',
    })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `媒體關係交叉表_${type}.csv`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  const isGift = type !== 'all' && GIFT_TYPES.includes(type)

  return (
    <>
      <PageHeader
        title="交叉檢視"
        description="同一類型的歷次活動一次攤開，看出每位記者的往來狀況。"
        actions={
          <Button onClick={exportCsv} disabled={columns.length === 0}>
            <Download className="size-4" />
            匯出交叉表
          </Button>
        }
      />

      <div className="p-8">
        <div className="mb-5 flex flex-wrap items-center gap-3">
          <Select
            value={type}
            onChange={(e) => setType(e.target.value as EventType | 'all')}
            className="w-44"
          >
            <option value="all">全部類型</option>
            {EVENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {EVENT_TYPE_LABELS[t]}
              </option>
            ))}
          </Select>

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
            只看有紀錄的人
          </label>

          <span className="ml-auto text-sm text-slate-400">
            {rows.length} 位 · {columns.length} 場
          </span>
        </div>

        {loading ? (
          <p className="py-16 text-center text-sm text-slate-400">載入中…</p>
        ) : columns.length === 0 ? (
          <p className="rounded-xl border border-dashed border-slate-300 bg-white py-16 text-center text-sm text-slate-400">
            這個類型還沒有活動紀錄
          </p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs text-slate-500">
                <tr>
                  <th className="sticky left-0 z-10 bg-slate-50 px-4 py-3 text-left font-medium">
                    媒體 / 姓名
                  </th>
                  {columns.map((ev) => (
                    <th
                      key={ev.id}
                      className="px-3 py-3 text-center font-medium whitespace-nowrap"
                    >
                      <div className="text-slate-700">{ev.name}</div>
                      <div className="mt-0.5 font-normal text-slate-400">
                        {ev.date}
                      </div>
                      <div className="mt-1">
                        <Badge tone={isGift ? 'amber' : 'blue'}>
                          {countFor(ev.id)} 位
                        </Badge>
                      </div>
                    </th>
                  ))}
                  <th className="px-3 py-3 text-center font-medium">合計</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((c) => {
                  const marks = columns.map(
                    (ev) => !!records[ev.id]?.[c.id]?.attended,
                  )
                  const total = marks.filter(Boolean).length
                  return (
                    <tr key={c.id} className={total === 0 ? 'opacity-50' : ''}>
                      <td className="sticky left-0 z-10 bg-white px-4 py-2.5 whitespace-nowrap">
                        {c.starred && (
                          <Star
                            className="mr-1.5 inline-block size-3.5 text-amber-400"
                            fill="currentColor"
                          />
                        )}
                        <span className="font-medium text-slate-900">
                          {c.outlet || '—'}
                        </span>
                        <span className="ml-2 text-slate-500">{c.name}</span>
                      </td>
                      {columns.map((ev, i) => {
                        const rec = records[ev.id]?.[c.id]
                        return (
                          <td
                            key={ev.id}
                            className="px-3 py-2.5 text-center"
                            title={rec?.note || undefined}
                          >
                            {marks[i] ? (
                              <span className="inline-flex size-6 items-center justify-center rounded-full bg-emerald-50 text-emerald-600">
                                <Check className="size-4" />
                              </span>
                            ) : (
                              <span className="text-slate-200">—</span>
                            )}
                            {rec?.note && (
                              <div className="mt-0.5 truncate text-[11px] text-slate-400">
                                {rec.note}
                              </div>
                            )}
                          </td>
                        )
                      })}
                      <td className="px-3 py-2.5 text-center font-medium text-slate-700">
                        {total}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  )
}
