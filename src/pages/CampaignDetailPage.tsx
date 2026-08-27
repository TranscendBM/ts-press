import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { collection, doc, onSnapshot } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { ArrowLeft, RefreshCw } from 'lucide-react'
import { db, functions } from '../lib/firebase'
import { useAuth } from '../lib/AuthContext'
import PageHeader from '../components/PageHeader'
import { Badge, Button } from '../components/ui'
import { CATEGORY_LABELS, LIST_LABELS } from '../constants'
import type { Campaign, CampaignRecipient, RecipientStatus } from '../types'
import { formatDate } from '../lib/helpers'

const STATUS_LABELS: Record<RecipientStatus, string> = {
  queued: '待送出',
  sending: '寄送中',
  sent: '已送出',
  failed: '失敗',
}

const STATUS_TONES: Record<
  RecipientStatus,
  'slate' | 'blue' | 'green' | 'amber' | 'red'
> = {
  queued: 'slate',
  sending: 'blue',
  sent: 'green',
  failed: 'red',
}

const CAMPAIGN_STATUS_LABELS: Record<Campaign['status'], string> = {
  sending: '寄送中',
  partial: '尚未寄完',
  completed: '已完成',
  failed: '失敗',
}

const CAMPAIGN_STATUS_TONES: Record<
  Campaign['status'],
  'slate' | 'blue' | 'green' | 'amber' | 'red'
> = {
  sending: 'blue',
  partial: 'amber',
  completed: 'green',
  failed: 'red',
}

// 逾時保留餘裕：與後端 timeoutSeconds 一致，避免大量收件人時被用戶端提早判斷逾時
const CALLABLE_TIMEOUT_MS = 540_000

const retryCampaignFn = httpsCallable<
  { campaignId: string },
  { ok: boolean; status: Campaign['status'] }
>(functions, 'retryCampaign', { timeout: CALLABLE_TIMEOUT_MS })

export default function CampaignDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { can } = useAuth()
  const [campaign, setCampaign] = useState<Campaign | null>(null)
  const [recipients, setRecipients] = useState<CampaignRecipient[]>([])
  const [retrying, setRetrying] = useState(false)
  const [retryError, setRetryError] = useState('')

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
  // sending／partial 都代表還有收件人沒確認寄出：sending 若卡在這個狀態，
  // 通常是上一次呼叫中途中斷（例如逾時），可以安全地再呼叫一次繼續寄。
  const needsRetry = campaign.status === 'partial' || campaign.status === 'sending'
  const canRetry = campaign.mode === 'real' ? can('sendReal') : can('sendTest')

  async function retry() {
    if (!id) return
    setRetrying(true)
    setRetryError('')
    try {
      await retryCampaignFn({ campaignId: id })
    } catch (err) {
      setRetryError(
        (err as { message?: string }).message ?? '重試失敗，請稍後再試。',
      )
    } finally {
      setRetrying(false)
    }
  }

  return (
    <>
      <PageHeader
        title={campaign.pressTitle}
        description={`${CATEGORY_LABELS[campaign.category]} · 由 ${campaign.sentBy} 於 ${formatDate(campaign.sentAt)} 發送`}
        actions={
          <>
            {needsRetry && canRetry && (
              <Button variant="primary" onClick={retry} disabled={retrying}>
                <RefreshCw className="size-4" />
                {retrying ? '寄送中…' : '繼續寄送未完成的收件人'}
              </Button>
            )}
            <Button onClick={() => navigate('/campaigns')}>
              <ArrowLeft className="size-4" />
              返回
            </Button>
          </>
        }
      />

      <div className="space-y-6 p-8">
        {retryError && (
          <div className="rounded-lg bg-red-50 p-3 text-sm text-red-700">
            {retryError}
          </div>
        )}

        {needsRetry && (
          <div className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800">
            這批還有收件人尚未確認寄出（
            <Badge tone={CAMPAIGN_STATUS_TONES[campaign.status]}>
              {CAMPAIGN_STATUS_LABELS[campaign.status]}
            </Badge>
            ）
            {canRetry
              ? '，可以按上方按鈕繼續寄送剩下的部分，已成功送出的不會重複收到。'
              : '，請有發送權限的人繼續完成寄送。'}
          </div>
        )}

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
