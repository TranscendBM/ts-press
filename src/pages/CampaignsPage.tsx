import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { collection, limit, onSnapshot, orderBy, query } from 'firebase/firestore'
import { db } from '../lib/firebase'
import PageHeader from '../components/PageHeader'
import { Badge, EmptyState } from '../components/ui'
import { CATEGORY_LABELS, LIST_LABELS } from '../constants'
import type { Campaign } from '../types'
import { formatDate } from '../lib/helpers'

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
        description="每次發送的收件人、開信與點擊狀況。"
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

      <div className="p-8">
        {loading ? (
          <p className="py-16 text-center text-sm text-slate-400">載入中…</p>
        ) : visible.length === 0 ? (
          <EmptyState
            title="還沒有發送紀錄"
            description="發送新聞稿之後，這裡會顯示每一次的成效。"
          />
        ) : (
          <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs text-slate-500">
                <tr>
                  <th className="px-4 py-3 font-medium">新聞稿</th>
                  <th className="px-4 py-3 font-medium">名單</th>
                  <th className="px-4 py-3 font-medium">發送時間</th>
                  <th className="px-4 py-3 font-medium">收件人</th>
                  <th className="px-4 py-3 font-medium">開信率</th>
                  <th className="px-4 py-3 font-medium">點擊率</th>
                  <th className="px-4 py-3 font-medium">狀態</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {visible.map((c) => {
                  const total = c.totals?.recipients || 0
                  const rate = (n: number) =>
                    total === 0 ? '—' : `${Math.round((n / total) * 100)}%`
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
                        {rate(c.totals?.opened ?? 0)}
                      </td>
                      <td className="px-4 py-3 font-medium text-slate-800">
                        {rate(c.totals?.clicked ?? 0)}
                      </td>
                      <td className="px-4 py-3">
                        <Badge
                          tone={
                            c.status === 'completed'
                              ? 'green'
                              : c.status === 'failed'
                                ? 'red'
                                : 'amber'
                          }
                        >
                          {c.status === 'completed'
                            ? '已完成'
                            : c.status === 'failed'
                              ? '失敗'
                              : '發送中'}
                        </Badge>
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
