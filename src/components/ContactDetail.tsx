import { useEffect, useState } from 'react'
import { collection, getDocs } from 'firebase/firestore'
import { CalendarDays, Gift, Mail, Phone, Star, Users } from 'lucide-react'
import { db } from '../lib/firebase'
import { Badge, Button, Modal } from './ui'
import {
  EVENT_TYPE_LABELS,
  GIFT_TYPES,
  LIST_LABELS,
  MEDIA_TYPE_LABELS,
} from '../constants'
import type { EventParticipant, MediaContact, MediaEvent } from '../types'

interface HistoryRow {
  event: MediaEvent
  record: EventParticipant
}

/**
 * 單一聯絡人的完整資料。表格為了好讀只顯示重點欄位，
 * Email、電話與往來紀錄都在這裡看。
 */
export default function ContactDetail({
  contact,
  onClose,
  onEdit,
}: {
  contact: MediaContact | null
  onClose: () => void
  onEdit: (c: MediaContact) => void
}) {
  const [history, setHistory] = useState<HistoryRow[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!contact) return
    setLoading(true)
    // 活動數量不多，直接逐場查這位聯絡人的紀錄即可
    getDocs(collection(db, 'mediaEvents'))
      .then(async (snap) => {
        const rows: HistoryRow[] = []
        await Promise.all(
          snap.docs.map(async (d) => {
            const partSnap = await getDocs(
              collection(db, 'mediaEvents', d.id, 'participants'),
            )
            const hit = partSnap.docs.find((p) => p.id === contact.id)
            const record = hit?.data() as EventParticipant | undefined
            if (record?.attended || record?.note) {
              rows.push({
                event: { id: d.id, ...d.data() } as MediaEvent,
                record,
              })
            }
          }),
        )
        rows.sort((a, b) => (b.event.date ?? '').localeCompare(a.event.date ?? ''))
        setHistory(rows)
      })
      .finally(() => setLoading(false))
  }, [contact])

  if (!contact) return null

  return (
    <Modal
      open
      wide
      title={contact.name || contact.outlet || '聯絡人'}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>關閉</Button>
          <Button
            variant="primary"
            onClick={() => {
              onClose()
              onEdit(contact)
            }}
          >
            編輯資料
          </Button>
        </>
      }
    >
      <div className="space-y-6">
        <div className="flex flex-wrap items-center gap-2">
          {contact.starred && (
            <Star className="size-5 text-amber-400" fill="currentColor" />
          )}
          <span className="text-lg font-semibold text-slate-900">
            {contact.outlet || '—'}
          </span>
          {contact.title && (
            <span className="text-sm text-slate-500">{contact.title}</span>
          )}
          {contact.mediaType && contact.mediaType !== 'other' && (
            <Badge>{MEDIA_TYPE_LABELS[contact.mediaType]}</Badge>
          )}
          {contact.rank != null && (
            <Badge tone="blue">重要性 {contact.rank}</Badge>
          )}
          {contact.active === false && <Badge tone="red">停用</Badge>}
        </div>

        <dl className="grid gap-3 sm:grid-cols-2">
          <Row icon={<Mail className="size-4" />} label="Email">
            <a
              href={`mailto:${contact.email}`}
              className="text-brand-700 hover:underline"
            >
              {contact.email}
            </a>
          </Row>
          <Row icon={<Mail className="size-4" />} label="備用 Email">
            {contact.altEmail ? (
              <a
                href={`mailto:${contact.altEmail}`}
                className="text-brand-700 hover:underline"
              >
                {contact.altEmail}
              </a>
            ) : (
              <span className="text-slate-400">—</span>
            )}
          </Row>
          <Row icon={<Phone className="size-4" />} label="電話">
            {contact.phone || <span className="text-slate-400">—</span>}
          </Row>
          <Row icon={<Users className="size-4" />} label="所屬名單">
            <div className="flex flex-wrap gap-1">
              {(contact.lists ?? []).length > 0 ? (
                (contact.lists ?? []).map((l) => (
                  <Badge key={l} tone="blue">
                    {LIST_LABELS[l]}
                  </Badge>
                ))
              ) : (
                <span className="text-slate-400">—</span>
              )}
            </div>
          </Row>
        </dl>

        {contact.note && (
          <div className="rounded-lg bg-slate-50 p-3 text-sm text-slate-600">
            {contact.note}
          </div>
        )}

        <div>
          <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold tracking-wide text-slate-500 uppercase">
            <CalendarDays className="size-3.5" />
            往來紀錄
          </h3>
          {loading ? (
            <p className="py-6 text-center text-sm text-slate-400">載入中…</p>
          ) : history.length === 0 ? (
            <p className="rounded-lg border border-dashed border-slate-300 py-6 text-center text-sm text-slate-400">
              還沒有活動或送禮紀錄
            </p>
          ) : (
            <div className="divide-y divide-slate-100 rounded-lg border border-slate-200">
              {history.map(({ event, record }) => (
                <div key={event.id} className="flex items-start gap-3 p-3">
                  <div
                    className={`mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md ${
                      GIFT_TYPES.includes(event.type)
                        ? 'bg-amber-50 text-amber-600'
                        : 'bg-brand-50 text-brand-600'
                    }`}
                  >
                    {GIFT_TYPES.includes(event.type) ? (
                      <Gift className="size-4" />
                    ) : (
                      <Users className="size-4" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-slate-800">
                      {event.name}
                    </div>
                    <div className="mt-0.5 text-xs text-slate-400">
                      {EVENT_TYPE_LABELS[event.type]} · {event.date}
                      {record.attended ? ' · 已標記' : ''}
                    </div>
                    {record.note && (
                      <div className="mt-1 text-xs text-slate-600">
                        {record.note}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </Modal>
  )
}

function Row({
  icon,
  label,
  children,
}: {
  icon: React.ReactNode
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="rounded-lg border border-slate-200 p-3">
      <dt className="mb-1 flex items-center gap-1.5 text-xs text-slate-400">
        {icon}
        {label}
      </dt>
      <dd className="text-sm break-all text-slate-800">{children}</dd>
    </div>
  )
}
