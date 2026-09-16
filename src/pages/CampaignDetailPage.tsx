import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { collection, doc, onSnapshot } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { AlertOctagon, AlertTriangle, ArrowLeft, RefreshCw } from 'lucide-react'
import { db, functions } from '../lib/firebase'
import { useAuth } from '../lib/AuthContext'
import PageHeader from '../components/PageHeader'
import { Badge, Button, Modal, TextArea } from '../components/ui'
import { CATEGORY_LABELS, LIST_LABELS } from '../constants'
import type { Campaign, CampaignRecipient, RecipientStatus } from '../types'
import { formatDate } from '../lib/helpers'
import {
  isResolutionEligibleCampaign,
  isRetriableCampaignStatus,
  type DeliveryUnknownResolutionAction,
} from '../../shared/campaignSend'

const STATUS_LABELS: Record<RecipientStatus, string> = {
  queued: '待送出',
  // claimed（round 8）：已經被搶下準備處理，但還沒真正呼叫 SMTP——跟
  // sending 用同一個藍色調，畫面上不特別區分「準備中」跟「寄送中」，
  // 兩者對使用者來說都是「正在處理，還沒有結果」。
  claimed: '準備寄送中',
  sending: '寄送中',
  sent: '已送出',
  failed: '失敗，待重試',
  exhausted: '永久失敗',
  // 送達與否無法確認，不是「失敗」——不可以顯示成跟 failed/exhausted 一樣的
  // 措辭，否則會讓人誤以為系統已經確定沒送到，見 shared/campaignSend.ts
  // 裡 RecipientStatus 的說明。
  delivery_unknown: '送達狀態不明',
}

const STATUS_TONES: Record<
  RecipientStatus,
  'slate' | 'blue' | 'green' | 'amber' | 'red'
> = {
  queued: 'slate',
  claimed: 'blue',
  sending: 'blue',
  sent: 'green',
  failed: 'amber',
  exhausted: 'red',
  // 刻意不用 red（那是「確定失敗」的顏色）：delivery_unknown 很可能其實
  // 已經送達，只是我們不知道，用 amber 呼應「需要人工檢查」而不是「已失敗」。
  delivery_unknown: 'amber',
}

const CAMPAIGN_STATUS_LABELS: Record<Campaign['status'], string> = {
  sending: '寄送中',
  partial: '尚未寄完',
  completed: '已完成',
  failed: '失敗',
  needs_review: '需人工檢查',
}

const CAMPAIGN_STATUS_TONES: Record<
  Campaign['status'],
  'slate' | 'blue' | 'green' | 'amber' | 'red'
> = {
  sending: 'blue',
  partial: 'amber',
  completed: 'green',
  failed: 'red',
  needs_review: 'amber',
}

// 逾時保留餘裕：與後端 timeoutSeconds 一致，避免大量收件人時被用戶端提早判斷逾時
const CALLABLE_TIMEOUT_MS = 540_000

const retryCampaignFn = httpsCallable<
  { campaignId: string },
  { ok: boolean; status: Campaign['status'] }
>(functions, 'retryCampaign', { timeout: CALLABLE_TIMEOUT_MS })

/**
 * round 8 新增（Finding 2）：delivery_unknown 唯一合法的人工處理入口——
 * 前端不能直接寫 recipients／campaign 文件（Firestore rules 本來就一律
 * 擋掉，見 firestore.rules 的 campaigns/{id}/recipients 規則），一定要透過
 * 這支 Cloud Function，讓 admin 身分驗證、totals／status 重算、稽核欄位
 * 都在同一個 transaction 內完成。
 */
const resolveDeliveryUnknownFn = httpsCallable<
  {
    campaignId: string
    recipientId: string
    action: DeliveryUnknownResolutionAction
    reason: string
    /** round 9 新增（Finding 4）：idempotency key，同一次操作重送要帶同一個值。 */
    resolutionId: string
  },
  {
    ok: boolean
    applied: boolean
    /** true 代表這是同一個 resolutionId 的重送，後端沒有重複套用，只是
     *  回傳當初已經套用的結果——跟「操作衝突」（會直接拋錯，不會回傳
     *  ok:true）不同，不需要特別提示使用者。 */
    idempotent?: boolean
    recipientStatus?: 'sent' | 'failed'
    campaignStatus?: string
  }
>(functions, 'resolveDeliveryUnknown')

const FORCE_RETRY_CONFIRM_PHRASE = '強制重寄'

export default function CampaignDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { can, isAdmin } = useAuth()
  const [campaign, setCampaign] = useState<Campaign | null>(null)
  const [recipients, setRecipients] = useState<CampaignRecipient[]>([])
  const [retrying, setRetrying] = useState(false)
  const [retryError, setRetryError] = useState('')

  const [resolveTarget, setResolveTarget] = useState<{
    recipient: CampaignRecipient
    action: DeliveryUnknownResolutionAction
  } | null>(null)
  // round 9 新增（Finding 4）：每次開啟 modal（=每一次新的操作意圖）產生
  // 一個新的 resolutionId；同一次 submit 若因為網路問題重試，會沿用同一個
  // 值，讓後端能分辨「同一個請求重送」跟「另一個獨立的操作」。
  const [resolutionId, setResolutionId] = useState('')
  const [resolveReason, setResolveReason] = useState('')
  const [resolveConfirmText, setResolveConfirmText] = useState('')
  const [resolving, setResolving] = useState(false)
  const [resolveError, setResolveError] = useState('')

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

  const t = campaign.totals ?? { recipients: 0, sent: 0, failed: 0, exhausted: 0 }
  // 唯一權威判斷來自 shared/campaignSend.ts，不在這裡另外手刻一份可能
  // 漂移的 `status === 'partial' || status === 'sending'`——sending／
  // partial 都代表還有收件人沒確認寄出，sending 若卡在這個狀態，通常是
  // 上一次呼叫中途中斷（例如逾時），可以安全地再呼叫一次繼續寄；
  // needs_review 雖然也不是乾淨的結局，但一般的「繼續寄送」對它無事可做
  //（delivery_unknown 不會被自動認領），不屬於 needsRetry。
  const needsRetry = isRetriableCampaignStatus(campaign.status)
  const needsReview = campaign.status === 'needs_review'
  const canRetry = campaign.mode === 'real' ? can('sendReal') : can('sendTest')
  // round 11 新增（Finding 3）：跟後端 decideAcquireResolutionLease 用同一份
  // 權威判斷（isResolutionEligibleCampaign）——避免在收件人清單還沒建立
  // 完成、或 campaign 已經 completed／failed 之後（totals 快取還沒跟上、
  // 或畫面暫時顯示舊資料）繼續顯示一個後端一定會拒絕的「人工處理」按鈕。
  const resolutionEligible = isResolutionEligibleCampaign(
    campaign.status,
    campaign.recipientsReady,
  )

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

  function openResolveModal(
    recipient: CampaignRecipient,
    action: DeliveryUnknownResolutionAction,
  ) {
    setResolveTarget({ recipient, action })
    setResolutionId(crypto.randomUUID())
    setResolveReason('')
    setResolveConfirmText('')
    setResolveError('')
  }

  function closeResolveModal() {
    if (resolving) return
    setResolveTarget(null)
  }

  async function submitResolve() {
    if (!id || !resolveTarget) return
    const reason = resolveReason.trim()
    if (!reason) {
      setResolveError('請填寫處理原因，供稽核使用。')
      return
    }
    if (
      resolveTarget.action === 'force_retry' &&
      resolveConfirmText.trim() !== FORCE_RETRY_CONFIRM_PHRASE
    ) {
      setResolveError(`請在下方輸入「${FORCE_RETRY_CONFIRM_PHRASE}」以確認你已經瞭解風險。`)
      return
    }
    setResolving(true)
    setResolveError('')
    try {
      await resolveDeliveryUnknownFn({
        campaignId: id,
        recipientId: resolveTarget.recipient.contactId,
        action: resolveTarget.action,
        reason,
        resolutionId,
      })
      setResolveTarget(null)
    } catch (err) {
      setResolveError(
        (err as { message?: string }).message ?? '處理失敗，請稍後再試。',
      )
    } finally {
      setResolving(false)
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

      <div className="space-y-6 p-4 sm:p-6 lg:p-8">
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
              ? '，可以按上方按鈕繼續寄送剩下的部分。系統會略過已記錄為成功的收件人；若寄出後系統在寫入狀態前中斷，仍存在極低機率重複寄送。'
              : '，請有發送權限的人繼續完成寄送。'}
          </div>
        )}

        {needsReview && (
          <div className="flex items-start gap-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-800">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <div>
              這批有 {t.deliveryUnknown ?? 0} 位收件人的送達狀態無法確認
              （下方標示為「送達狀態不明」）——通常是寄送過程中連線逾時，
              系統無法判斷伺服器最終有沒有收下這封信。為了避免重複寄送，
              系統**不會**自動重試這些收件人，一般的「繼續寄送」按鈕對這批
              也不會出現。請人工核對這幾位是否已經收到，
              {isAdmin
                ? '確認結果後可以直接在下方名單裡標記「已送達」或「強制重寄」。'
                : '若確認需要補寄，請洽管理員在下方名單裡處理，不要透過一般發送流程重寄整批名單。'}
            </div>
          </div>
        )}

        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
          <Stat label="收件人" value={String(t.recipients)} />
          <Stat label="成功送出" value={String(t.sent)} />
          <Stat label="待重試" value={String(t.failed ?? 0)} />
          <Stat label="永久失敗" value={String(t.exhausted ?? 0)} />
          <Stat label="送達狀態不明" value={String(t.deliveryUnknown ?? 0)} />
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

        {/* round 31：手機（<md）改成卡片列表，保留狀態與人工處理操作；
            md 以上維持原本的 table。 */}
        <div className="space-y-2 md:hidden">
          {recipients.map((r) => (
            <div
              key={r.email}
              className="rounded-xl border border-slate-200 bg-white p-4"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-medium break-words text-slate-900">
                    {r.name}
                  </div>
                  <div className="text-xs break-all text-slate-500">{r.email}</div>
                </div>
                <Badge tone={STATUS_TONES[r.status]}>{STATUS_LABELS[r.status]}</Badge>
              </div>
              <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-slate-500">
                <div>
                  <dt className="text-slate-400">媒體</dt>
                  <dd className="break-words text-slate-700">{r.outlet}</dd>
                </div>
                <div>
                  <dt className="text-slate-400">語言</dt>
                  <dd className="text-slate-700">{r.language}</dd>
                </div>
                <div>
                  <dt className="text-slate-400">嘗試次數</dt>
                  <dd className="text-slate-700">
                    {r.attemptCount ?? (r.status === 'sent' ? 1 : 0)}
                  </dd>
                </div>
              </dl>
              {r.lastError && (
                <div className="mt-2 text-xs break-words text-red-500">{r.lastError}</div>
              )}
              {r.status === 'delivery_unknown' && isAdmin && resolutionEligible && (
                <div className="mt-2 flex gap-4 text-xs">
                  <button
                    onClick={() => openResolveModal(r, 'mark_delivered')}
                    className="font-medium text-emerald-700 hover:underline"
                  >
                    標記已送達
                  </button>
                  <button
                    onClick={() => openResolveModal(r, 'force_retry')}
                    className="font-medium text-red-700 hover:underline"
                  >
                    強制重寄
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="hidden overflow-x-auto rounded-xl border border-slate-200 bg-white md:block">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs text-slate-500">
              <tr>
                <th className="px-4 py-3 font-medium">姓名</th>
                <th className="px-4 py-3 font-medium">Email</th>
                <th className="px-4 py-3 font-medium">媒體</th>
                <th className="px-4 py-3 font-medium">語言</th>
                <th className="px-4 py-3 font-medium">嘗試次數</th>
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
                  <td className="px-4 py-3 text-slate-500">
                    {r.attemptCount ?? (r.status === 'sent' ? 1 : 0)}
                  </td>
                  <td className="px-4 py-3">
                    <Badge tone={STATUS_TONES[r.status]}>
                      {STATUS_LABELS[r.status]}
                    </Badge>
                    {r.lastError && (
                      <div className="mt-1 text-xs text-red-500">{r.lastError}</div>
                    )}
                    {r.status === 'delivery_unknown' && isAdmin && resolutionEligible && (
                      <div className="mt-1.5 flex gap-3 text-xs">
                        <button
                          onClick={() => openResolveModal(r, 'mark_delivered')}
                          className="font-medium text-emerald-700 hover:underline"
                        >
                          標記已送達
                        </button>
                        <button
                          onClick={() => openResolveModal(r, 'force_retry')}
                          className="font-medium text-red-700 hover:underline"
                        >
                          強制重寄
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <Modal
        open={resolveTarget !== null}
        onClose={closeResolveModal}
        title={
          resolveTarget?.action === 'force_retry'
            ? '強制重寄（可能重複寄送）'
            : '標記已送達'
        }
        footer={
          <>
            <Button onClick={closeResolveModal} disabled={resolving}>
              取消
            </Button>
            <Button
              variant={resolveTarget?.action === 'force_retry' ? 'danger' : 'primary'}
              onClick={submitResolve}
              disabled={
                resolving ||
                (resolveTarget?.action === 'force_retry' &&
                  resolveConfirmText.trim() !== FORCE_RETRY_CONFIRM_PHRASE)
              }
            >
              {resolving
                ? '處理中…'
                : resolveTarget?.action === 'force_retry'
                  ? '確認強制重寄'
                  : '確認標記已送達'}
            </Button>
          </>
        }
      >
        {resolveTarget && (
          <div className="space-y-4">
            <div className="rounded-lg bg-slate-50 p-3 text-sm text-slate-700">
              收件人：{resolveTarget.recipient.name}（{resolveTarget.recipient.email}）
            </div>

            {resolveTarget.action === 'force_retry' ? (
              <div className="flex items-start gap-2 rounded-lg bg-red-50 p-3 text-sm text-red-800">
                <AlertOctagon className="mt-0.5 size-4 shrink-0" />
                <div>
                  這位收件人的送達狀態原本無法確認——SMTP
                  伺服器有可能其實已經收下這封信，只是我們沒能拿到確認結果。
                  <strong>強制重寄有可能讓對方收到兩封重複的信</strong>
                  ，請先盡可能透過其他管道（例如直接詢問對方）確認過確實沒收到，
                  再執行這個動作。這個動作無法復原。
                </div>
              </div>
            ) : (
              <div className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800">
                請先確認已經透過其他管道（例如對方回覆、事後查證）核實這位收件人
                確實收到這封信，再標記為已送達。這個動作無法復原。
              </div>
            )}

            <label className="block">
              <span className="mb-1.5 block text-sm font-medium text-slate-700">
                處理原因（必填，供稽核使用）
              </span>
              <TextArea
                value={resolveReason}
                onChange={(e) => setResolveReason(e.target.value)}
                rows={3}
                placeholder="例如：已致電確認記者已收到這封信"
                className="w-full"
              />
            </label>

            {resolveTarget.action === 'force_retry' && (
              <label className="block">
                <span className="mb-1.5 block text-sm font-medium text-slate-700">
                  請輸入「{FORCE_RETRY_CONFIRM_PHRASE}」以確認你瞭解可能重複寄送的風險
                </span>
                <input
                  value={resolveConfirmText}
                  onChange={(e) => setResolveConfirmText(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
                  placeholder={FORCE_RETRY_CONFIRM_PHRASE}
                />
              </label>
            )}

            {resolveError && (
              <div className="rounded-lg bg-red-50 p-3 text-sm text-red-700">
                {resolveError}
              </div>
            )}
          </div>
        )}
      </Modal>
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
