import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { collection, doc, onSnapshot } from 'firebase/firestore'
import { ArrowLeft } from 'lucide-react'
import { db } from '../lib/firebase'
import PageHeader from '../components/PageHeader'
import { Badge, Button } from '../components/ui'
import { CATEGORY_LABELS, LIST_LABELS } from '../constants'
import type { Campaign, CampaignRecipient, RecipientStatus } from '../types'
import { formatDate } from '../lib/helpers'

const STATUS_LABELS: Record<RecipientStatus, string> = {
  queued: '待送出',
  sent: '已送出',
  failed: '失敗',
}

const STATUS_TONES: Record<
  RecipientStatus,
  'slate' | 'blue' | 'green' | 'amber' | 'red'
> = {
  queued: 'slate',
  sent: 'green',
  failed: 'red',
}

export default function CampaignDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [campaign, setCampaign] = useState<Campaign | null>(null)
  const [recipients, setRecipients] = useState<CampaignRecipient[]>([])

  useEffect(() => {
    if (!id) return
    const unsubCampaign = onSnapshot(doc(db, 'campaigns', id), (snap) => {
      if (snap.exists())
        setCampaign({ id: snap.id, ...snap.data() } as Campaign)
    })
    const unsubRecipients = onSnapshot(
      collection(db, 'campaigns', id, 'recipients'),
      (snap) => {
        setRecipients(snap.docs.map((d) => d.data() as CampaignRecipient))
      },
    )
    return () => {
      unsubCampaign()
      unsubRecipients()
    }
  }, [id])

  if (!campaign) {
    return <p className="p-16 text-center text-sm text-slate-400">載入中…</p>
  }

  const t = campaign.totals ?? { recipients: 0, sent: 0, failed: 0 }

  return (
    <>
      <PageHeader
        title={campaign.pressTitle}
        description={`${CATEGORY_LABELS[campaign.category]} · 由 ${campaign.sentBy} 於 ${formatDate(campaign.sentAt)} 發送`}
        actions={
          <Button onClick={() => navigate('/campaigns')}>
            <ArrowLeft className="size-4" />
            返回
          </Button>
        }
      />

      <div className="space-y-6 p-8">
        <div className="grid grid-cols-3 gap-4">
          <Stat label="收件人" value={String(t.recipients)} />
          <Stat label="成功送出" value={String(t.sent)} />
          <Stat label="失敗" value={String(t.failed ?? 0)} />
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-5 text-sm">
          <span className="text-slate-500">發送名單：</span>
          <span className="text-slate-800">
            {(campaign.targetLists ?? []).map((l) => LIST_LABELS[l]).join('、') ||
              '—'}
          </span>
          {campaign.isTest && (
            <span className="ml-3">
              <Badge tone="amber">測試信</Badge>
            </span>
          )}
        </div>

        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs text-slate-500">
              <tr>
                <th className="px-4 py-3 font-medium">姓名</th>
                <th className="px-4 py-3 font-medium">Email</th>
                <th className="px-4 py-3 font-medium">媒體</th>
                <th className="px-4 py-3 font-medium">語言</th>
                <th className="px-4 py-3 font-medium">狀態</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {recipients.map((r) => (
                <tr key={r.email}>
                  <td className="px-4 py-3 text-slate-900">{r.name}</td>
                  <td className="px-4 py-3 text-slate-600">{r.email}</td>
                  <td className="px-4 py-3 text-slate-600">{r.outlet}</td>
                  <td className="px-4 py-3 text-slate-500">{r.language}</td>
                  <td className="px-4 py-3">
                    <Badge tone={STATUS_TONES[r.status]}>
                      {STATUS_LABELS[r.status]}
                    </Badge>
                    {r.error && (
                      <div className="mt-1 text-xs text-red-500">{r.error}</div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5">
      <div className="text-xs text-slate-400">{label}</div>
      <div className="mt-1 text-xl font-semibold text-slate-900">{value}</div>
    </div>
  )
}
