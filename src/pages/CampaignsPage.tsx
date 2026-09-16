import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { collection, limit, onSnapshot, orderBy, query } from 'firebase/firestore'
import { db } from '../lib/firebase'
import PageHeader from '../components/PageHeader'
import { Badge, EmptyState } from '../components/ui'
import { CATEGORY_LABELS, LIST_LABELS } from '../constants'
import type { Campaign } from '../types'
import { formatDate } from '../lib/helpers'

const STATUS_LABELS: Record<Campaign['status'], string> = {
  sending: '發送中',
  partial: '尚未寄完',
  completed: '已完成',
  failed: '失敗',
  needs_review: '需人工檢查',
}

const STATUS_TONES: Record<Campaign['status'], 'amber' | 'green' | 'red'> = {
  sending: 'amber',
  partial: 'amber',
  completed: 'green',
  failed: 'red',
  // 跟 CampaignDetailPage 一致：needs_review 不是「確定失敗」，用 amber
  // 呼應「需要人工檢查」，不要用 red 讓人誤以為是失敗。
  needs_review: 'amber',
}

export default function CampaignsPage() {
  const [items, setItems] = useState<Campaign[]>([])
  const [loading, setLoading] = useState(true)
  const [showTests, setShowTests] = useState(false)
  const navigate = useNavigate()

  useEffect(() => {
    const q = query(
      collection(db, 'campaigns'),
      orderBy('sentAt', 'desc'),
      limit(100),
    )
    return onSnapshot(q, (snap) => {
      setItems(snap.docs.map((d) => ({ id: d.id, ...d.data() }) as Campaign))
      setLoading(false)
    })
  }, [])

  const visible = showTests ? items : items.filter((c) => !c.isTest)

  return (
    <>
      <PageHeader
        title="發送紀錄"
        description="每次發送的收件人與送出結果。透過 mail2000 寄送，沒有開信與點擊追蹤。"
        actions={
          <label className="flex items-center gap-2 text-sm text-slate-600">
            <input
              type="checkbox"
              checked={showTests}
              onChange={(e) => setShowTests(e.target.checked)}
              className="size-4 rounded border-slate-300"
            />
            顯示測試信
          </label>
        }
      />

      <div className="p-4 sm:p-6 lg:p-8">
        {loading ? (
          <p className="py-16 text-center text-sm text-slate-400">載入中…</p>
        ) : visible.length === 0 ? (
          <EmptyState
            title="還沒有發送紀錄"
            description="發送新聞稿之後，這裡會顯示每一次的成效。"
          />
        ) : (
          <>
            {/* round 31：手機（<md）改成卡片列表，md 以上維持 table。 */}
            <div className="space-y-2 md:hidden">
              {visible.map((c) => {
                const total = c.totals?.recipients || 0
                const failed = (c.totals?.failed ?? 0) + (c.totals?.exhausted ?? 0)
                return (
                  <div
                    key={c.id}
                    onClick={() => navigate(`/campaigns/${c.id}`)}
                    className="cursor-pointer rounded-xl border border-slate-200 bg-white p-4 transition hover:border-brand-200"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="font-medium break-words text-slate-900">
                          {c.pressTitle}
                        </div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-2">
                          <span className="text-xs text-slate-400">
                            {CATEGORY_LABELS[c.category]}
                          </span>
                          {c.isTest && <Badge tone="amber">測試信</Badge>}
                        </div>
                      </div>
                      <Badge tone={STATUS_TONES[c.status]}>
                        {STATUS_LABELS[c.status]}
                      </Badge>
                    </div>
                    <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-slate-500">
                      <div>
                        <dt className="text-slate-400">名單</dt>
                        <dd className="break-words text-slate-700">
                          {(c.targetLists ?? []).map((l) => LIST_LABELS[l]).join('、') || '—'}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-slate-400">發送時間</dt>
                        <dd className="text-slate-700">{formatDate(c.sentAt)}</dd>
                      </div>
                      <div>
                        <dt className="text-slate-400">收件人</dt>
                        <dd className="text-slate-700">{total}</dd>
                      </div>
                      <div>
                        <dt className="text-slate-400">成功 / 失敗</dt>
                        <dd className="font-medium text-slate-800">
                          {c.totals?.sent ?? 0}
                          {failed > 0 && <span className="text-red-600"> / {failed}</span>}
                        </dd>
                      </div>
                    </dl>
                  </div>
                )
              })}
            </div>

          <div className="hidden overflow-x-auto rounded-xl border border-slate-200 bg-white md:block">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs text-slate-500">
                <tr>
                  <th className="px-4 py-3 font-medium">新聞稿</th>
                  <th className="px-4 py-3 font-medium">名單</th>
                  <th className="px-4 py-3 font-medium">發送時間</th>
                  <th className="px-4 py-3 font-medium">收件人</th>
                  <th className="px-4 py-3 font-medium">成功 / 失敗</th>
                  <th className="px-4 py-3 font-medium">狀態</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {visible.map((c) => {
                  const total = c.totals?.recipients || 0
                  // 待重試與永久失敗都算「還沒成功」，列表頁一眼看總數就好，
                  // 想細分兩者的比例要進發送紀錄詳情頁看。
                  const failed = (c.totals?.failed ?? 0) + (c.totals?.exhausted ?? 0)
                  return (
                    <tr
                      key={c.id}
                      onClick={() => navigate(`/campaigns/${c.id}`)}
                      className="cursor-pointer transition hover:bg-slate-50"
                    >
                      <td className="px-4 py-3">
                        <div className="font-medium text-slate-900">
                          {c.pressTitle}
                        </div>
                        <div className="mt-0.5 flex items-center gap-2">
                          <span className="text-xs text-slate-400">
                            {CATEGORY_LABELS[c.category]}
                          </span>
                          {c.isTest && <Badge tone="amber">測試信</Badge>}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-slate-600">
                        {(c.targetLists ?? [])
                          .map((l) => LIST_LABELS[l])
                          .join('、') || '—'}
                      </td>
                      <td className="px-4 py-3 text-slate-600">
                        {formatDate(c.sentAt)}
                      </td>
                      <td className="px-4 py-3 text-slate-600">{total}</td>
                      <td className="px-4 py-3 font-medium text-slate-800">
                        {c.totals?.sent ?? 0}
                        {failed > 0 && (
                          <span className="text-red-600"> / {failed}</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <Badge tone={STATUS_TONES[c.status]}>
                          {STATUS_LABELS[c.status]}
                        </Badge>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          </>
        )}
      </div>
    </>
  )
}
