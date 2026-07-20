import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  serverTimestamp,
} from 'firebase/firestore'
import { CalendarDays, Gift, Plus, Trash2, Users } from 'lucide-react'
import { db } from '../lib/firebase'
import { useAuth } from '../lib/AuthContext'
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
  EVENT_TYPES,
  EVENT_TYPE_LABELS,
  GIFT_TYPES,
  type EventType,
} from '../constants'
import type { MediaEvent } from '../types'
import { todayIso } from '../lib/helpers'

export default function EventsPage() {
  const [events, setEvents] = useState<MediaEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [yearFilter, setYearFilter] = useState<number | 'all'>('all')
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [draft, setDraft] = useState({
    name: '',
    type: 'meal' as EventType,
    date: todayIso(),
    note: '',
  })
  const navigate = useNavigate()
  const { appUser } = useAuth()

  useEffect(() => {
    return onSnapshot(collection(db, 'mediaEvents'), (snap) => {
      const rows = snap.docs.map(
        (d) => ({ id: d.id, ...d.data() }) as MediaEvent,
      )
      // 依日期新到舊
      rows.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))
      setEvents(rows)
      setLoading(false)
    })
  }, [])

  const years = useMemo(
    () =>
      Array.from(new Set(events.map((e) => e.year).filter(Boolean))).sort(
        (a, b) => b - a,
      ),
    [events],
  )

  const visible = useMemo(
    () =>
      yearFilter === 'all'
        ? events
        : events.filter((e) => e.year === yearFilter),
    [events, yearFilter],
  )

  async function create() {
    if (!draft.name.trim() || !draft.date) return
    setSaving(true)
    try {
      const ref = await addDoc(collection(db, 'mediaEvents'), {
        name: draft.name.trim(),
        type: draft.type,
        date: draft.date,
        year: Number(draft.date.slice(0, 4)),
        note: draft.note.trim(),
        createdBy: appUser?.email ?? '',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      })
      setOpen(false)
      setDraft({ name: '', type: 'meal', date: todayIso(), note: '' })
      navigate(`/events/${ref.id}`)
    } finally {
      setSaving(false)
    }
  }

  async function remove(e: React.MouseEvent, item: MediaEvent) {
    e.stopPropagation()
    if (!confirm(`確定要刪除「${item.name}」嗎？參加紀錄也會一併刪除。`)) return
    await deleteDoc(doc(db, 'mediaEvents', item.id))
  }

  return (
    <>
      <PageHeader
        title="媒體關係"
        description="記錄餐敘、茶會與年節禮品的往來，每位媒體都能單獨備註。"
        actions={
          <Button variant="primary" onClick={() => setOpen(true)}>
            <Plus className="size-4" />
            新增活動
          </Button>
        }
      />

      <div className="p-8">
        <div className="mb-5 w-40">
          <Select
            value={String(yearFilter)}
            onChange={(e) =>
              setYearFilter(
                e.target.value === 'all' ? 'all' : Number(e.target.value),
              )
            }
          >
            <option value="all">全部年份</option>
            {years.map((y) => (
              <option key={y} value={y}>
                {y} 年
              </option>
            ))}
          </Select>
        </div>

        {loading ? (
          <p className="py-16 text-center text-sm text-slate-400">載入中…</p>
        ) : visible.length === 0 ? (
          <EmptyState
            title="還沒有活動紀錄"
            description="建立第一場餐敘或年節送禮，接著就能勾選每位媒體。"
            action={
              <Button variant="primary" onClick={() => setOpen(true)}>
                <Plus className="size-4" />
                新增活動
              </Button>
            }
          />
        ) : (
          <div className="grid gap-3">
            {visible.map((item) => {
              const isGift = GIFT_TYPES.includes(item.type)
              return (
                <div
                  key={item.id}
                  onClick={() => navigate(`/events/${item.id}`)}
                  className="flex cursor-pointer items-center gap-4 rounded-xl border border-slate-200 bg-white p-4 transition hover:border-brand-200 hover:shadow-sm"
                >
                  <div
                    className={`flex size-10 shrink-0 items-center justify-center rounded-lg ${
                      isGift
                        ? 'bg-amber-50 text-amber-600'
                        : 'bg-brand-50 text-brand-600'
                    }`}
                  >
                    {isGift ? (
                      <Gift className="size-5" />
                    ) : (
                      <Users className="size-5" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium text-slate-900">
                      {item.name}
                    </div>
                    <div className="mt-1 flex items-center gap-2 text-xs text-slate-400">
                      <Badge tone={isGift ? 'amber' : 'blue'}>
                        {EVENT_TYPE_LABELS[item.type]}
                      </Badge>
                      <span className="flex items-center gap-1">
                        <CalendarDays className="size-3.5" />
                        {item.date}
                      </span>
                      {item.note && (
                        <span className="truncate">· {item.note}</span>
                      )}
                    </div>
                  </div>
                  <button
                    onClick={(e) => remove(e, item)}
                    title="刪除"
                    className="rounded-lg p-2 text-slate-300 transition hover:bg-red-50 hover:text-red-600"
                  >
                    <Trash2 className="size-4" />
                  </button>
                </div>
              )
            })}
          </div>
        )}
      </div>

      <Modal
        open={open}
        title="新增活動"
        onClose={() => setOpen(false)}
        footer={
          <>
            <Button onClick={() => setOpen(false)}>取消</Button>
            <Button
              variant="primary"
              onClick={create}
              disabled={saving || !draft.name.trim()}
            >
              {saving ? '建立中…' : '建立並選擇名單'}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="活動名稱">
            <TextInput
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder="2026 中秋禮品"
            />
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label="類型">
              <Select
                value={draft.type}
                onChange={(e) =>
                  setDraft({ ...draft, type: e.target.value as EventType })
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
                value={draft.date}
                onChange={(e) => setDraft({ ...draft, date: e.target.value })}
              />
            </Field>
          </div>
          <Field label="備註">
            <TextArea
              rows={2}
              value={draft.note}
              onChange={(e) => setDraft({ ...draft, note: e.target.value })}
              placeholder="地點、預算、主辦人…"
            />
          </Field>
        </div>
      </Modal>
    </>
  )
}
