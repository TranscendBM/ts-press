import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { collection, onSnapshot } from 'firebase/firestore'
import { AlertTriangle, CalendarClock, CalendarX2, Send } from 'lucide-react'
import { db } from '../lib/firebase'
import PageHeader from '../components/PageHeader'
import { Badge, EmptyState } from '../components/ui'
import { CATEGORY_LABELS, LANGUAGES } from '../constants'
import type { PressRelease } from '../types'
import { formatDate, todayIso } from '../lib/helpers'

/** 以本地日期計算距離 yyyy-mm-dd 還有幾天（負數代表已過）。 */
function daysUntil(dateStr: string): number {
  const d = new Date(`${dateStr}T00:00:00`).getTime()
  const today = new Date(`${todayIso()}T00:00:00`).getTime()
  return Math.round((d - today) / 86_400_000)
}

function relativeLabel(dateStr: string): string {
  const n = daysUntil(dateStr)
  if (n === 0) return '今天'
  if (n === 1) return '明天'
  if (n > 1) return `還有 ${n} 天`
  if (n === -1) return '昨天'
  return `逾期 ${-n} 天`
}

export default function SchedulePage() {
  const [items, setItems] = useState<PressRelease[]>([])
  const [loading, setLoading] = useState(true)
  const navigate = useNavigate()

  useEffect(() => {
    return onSnapshot(collection(db, 'pressReleases'), (snap) => {
      setItems(snap.docs.map((d) => ({ id: d.id, ...d.data() }) as PressRelease))
      setLoading(false)
    })
  }, [])

  const groups = useMemo(() => {
    const active = items.filter((i) => !i.archived && i.status !== 'sent')
    const byDateAsc = (a: PressRelease, b: PressRelease) =>
      (a.scheduledDate ?? '').localeCompare(b.scheduledDate ?? '')
    const today = todayIso()

    const overdue = active
      .filter((i) => i.scheduledDate && i.scheduledDate < today)
      .sort(byDateAsc)
    const upcoming = active
      .filter((i) => i.scheduledDate && i.scheduledDate >= today)
      .sort(byDateAsc)
    const undated = active
      .filter((i) => !i.scheduledDate)
      .sort(
        (a, b) => (b.updatedAt?.toMillis?.() ?? 0) - (a.updatedAt?.toMillis?.() ?? 0),
      )
    const sent = items
      .filter((i) => !i.archived && i.status === 'sent')
      .sort(
        (a, b) =>
          (b.sentAt?.toMillis?.() ?? 0) - (a.sentAt?.toMillis?.() ?? 0),
      )
    return { overdue, upcoming, undated, sent }
  }, [items])

  function row(item: PressRelease, opts: { tone?: 'overdue' } = {}) {
    const filled = LANGUAGES.filter(
      (l) => item.versions?.[l]?.subject?.trim(),
    ).length
    return (
      <div
        key={item.id}
        onClick={() => navigate(`/press/${item.id}`)}
        className={`flex cursor-pointer items-center gap-4 rounded-xl border bg-white p-4 transition hover:shadow-sm ${
          opts.tone === 'overdue'
            ? 'border-red-200 hover:border-red-300'
            : 'border-slate-200 hover:border-brand-200'
        }`}
      >
        {/* 日期欄 */}
        <div className="w-24 shrink-0 text-center">
          {item.scheduledDate ? (
            <>
              <div
                className={`text-sm font-semibold ${
                  opts.tone === 'overdue' ? 'text-red-600' : 'text-slate-800'
                }`}
              >
                {item.scheduledDate.slice(5)}
              </div>
              <div
                className={`text-xs ${
                  opts.tone === 'overdue' ? 'text-red-500' : 'text-slate-400'
                }`}
              >
                {relativeLabel(item.scheduledDate)}
              </div>
            </>
          ) : (
            <div className="text-xs text-slate-300">未排定</div>
          )}
        </div>

        <div className="min-w-0 flex-1">
          <div className="truncate font-medium text-slate-900">{item.title}</div>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-400">
            <Badge>{CATEGORY_LABELS[item.category]}</Badge>
            {item.ownerName && <span>負責人 {item.ownerName}</span>}
            <span>·</span>
            <span>已填 {filled}/3 個語言版本</span>
            {item.status === 'sent' && item.sentAt && (
              <>
                <span>·</span>
                <span>實際發送 {formatDate(item.sentAt)}</span>
              </>
            )}
          </div>
        </div>

        {item.status === 'sent' ? (
          <Badge tone="green">已發送</Badge>
        ) : (
          <button
            onClick={(e) => {
              e.stopPropagation()
              navigate(`/send?press=${item.id}`)
            }}
            className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600 transition hover:border-brand-300 hover:text-brand-700"
          >
            <Send className="size-3.5" />
            前往發送
          </button>
        )}
      </div>
    )
  }

  const nothing =
    groups.overdue.length === 0 &&
    groups.upcoming.length === 0 &&
    groups.undated.length === 0 &&
    groups.sent.length === 0

  return (
    <>
      <PageHeader
        title="發送排程"
        description="全隊共用的新聞稿發送時程，即時同步。實際寄送仍需由人手動發送。"
      />

      <div className="p-4 sm:p-6 lg:p-8">
        {loading ? (
          <p className="py-16 text-center text-sm text-slate-400">載入中…</p>
        ) : nothing ? (
          <EmptyState
            title="還沒有任何排程"
            description="到新聞稿編輯頁填「計畫發送日期」，就會出現在這裡。"
          />
        ) : (
          <div className="space-y-8">
            {groups.overdue.length > 0 && (
              <section>
                <h2 className="mb-3 flex items-center gap-1.5 text-xs font-semibold tracking-wide text-red-600 uppercase">
                  <AlertTriangle className="size-3.5" />
                  逾期未發（{groups.overdue.length}）
                </h2>
                <div className="grid gap-3">
                  {groups.overdue.map((i) => row(i, { tone: 'overdue' }))}
                </div>
              </section>
            )}

            <section>
              <h2 className="mb-3 flex items-center gap-1.5 text-xs font-semibold tracking-wide text-slate-500 uppercase">
                <CalendarClock className="size-3.5" />
                即將發送（{groups.upcoming.length}）
              </h2>
              {groups.upcoming.length === 0 ? (
                <p className="rounded-xl border border-dashed border-slate-300 bg-white py-8 text-center text-sm text-slate-400">
                  目前沒有排定日期的新聞稿
                </p>
              ) : (
                <div className="grid gap-3">{groups.upcoming.map((i) => row(i))}</div>
              )}
            </section>

            {groups.undated.length > 0 && (
              <section>
                <h2 className="mb-3 flex items-center gap-1.5 text-xs font-semibold tracking-wide text-slate-400 uppercase">
                  <CalendarX2 className="size-3.5" />
                  尚未排定日期（{groups.undated.length}）
                </h2>
                <div className="grid gap-3">{groups.undated.map((i) => row(i))}</div>
              </section>
            )}

            {groups.sent.length > 0 && (
              <section>
                <h2 className="mb-3 flex items-center gap-1.5 text-xs font-semibold tracking-wide text-slate-500 uppercase">
                  <Send className="size-3.5" />
                  已發送（{groups.sent.length}）
                </h2>
                <div className="grid gap-3">{groups.sent.map((i) => row(i))}</div>
              </section>
            )}
          </div>
        )}
      </div>
    </>
  )
}
