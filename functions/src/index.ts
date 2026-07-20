import { initializeApp } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { FieldValue, getFirestore, Timestamp } from 'firebase-admin/firestore'
import { getStorage } from 'firebase-admin/storage'
import { onCall, onRequest, HttpsError } from 'firebase-functions/v2/https'
import { onDocumentWritten } from 'firebase-functions/v2/firestore'
import { defineSecret } from 'firebase-functions/params'
import { setGlobalOptions } from 'firebase-functions/v2'
import * as functionsV1 from 'firebase-functions/v1'
import * as logger from 'firebase-functions/logger'
import sgMail from '@sendgrid/mail'
import { EventWebhook, EventWebhookHeader } from '@sendgrid/eventwebhook'
import { renderEmailHtml, renderEmailText } from './emailTemplate'

initializeApp()
setGlobalOptions({ region: 'asia-east1', maxInstances: 5 })

const SENDGRID_API_KEY = defineSecret('SENDGRID_API_KEY')
const SENDGRID_WEBHOOK_KEY = defineSecret('SENDGRID_WEBHOOK_KEY')

const db = getFirestore()

const SENDER_EMAIL = 'press_center@transcend-info.com'
const SENDER_NAME_BY_LANG = {
  tw: '創見資訊 新聞中心',
  www: 'Transcend Press Center',
  us: 'Transcend Press Center',
} as const

const LANGUAGES = ['tw', 'www', 'us'] as const
type Language = (typeof LANGUAGES)[number]

interface Version {
  subject?: string
  bodyText?: string
  heroImage?: { url?: string }
}

interface Contact {
  id: string
  name: string
  email: string
  outlet?: string
  lists?: string[]
  language: Language
  active?: boolean
}

interface SendRequest {
  pressReleaseId: string
  targetLists: string[]
  isTest: boolean
}

/** 確認呼叫者在白名單內；正式發送另外要求 admin / manager。 */
async function authorize(email: string | undefined, needsSendRole: boolean) {
  if (!email) {
    throw new HttpsError('permission-denied', '請先登入。')
  }
  const snap = await db.collection('users').doc(email.toLowerCase()).get()
  const user = snap.data()
  if (!snap.exists || user?.active === false) {
    throw new HttpsError('permission-denied', '這個帳號未被授權使用本系統。')
  }
  if (needsSendRole && user?.role !== 'admin' && user?.role !== 'manager') {
    throw new HttpsError('permission-denied', '你的角色沒有正式發送權限。')
  }
  return { email: email.toLowerCase(), ...user } as {
    email: string
    displayName?: string
    role?: string
  }
}

/** 從 Storage 抓附件並轉成 SendGrid 需要的 base64 格式。 */
async function loadAttachments(
  files: { name: string; path: string; contentType?: string }[],
) {
  const bucket = getStorage().bucket()
  const out = []
  for (const f of files ?? []) {
    try {
      const [buf] = await bucket.file(f.path).download()
      out.push({
        content: buf.toString('base64'),
        filename: f.name,
        type: f.contentType || 'application/octet-stream',
        disposition: 'attachment' as const,
      })
    } catch (err) {
      logger.error('附件下載失敗', { path: f.path, err })
      throw new HttpsError('internal', `附件「${f.name}」讀取失敗，請重新上傳。`)
    }
  }
  return out
}

/** 小量併發，避免一次打爆 SendGrid。 */
async function pooled<T>(
  items: T[],
  size: number,
  worker: (item: T) => Promise<void>,
) {
  for (let i = 0; i < items.length; i += size) {
    await Promise.all(items.slice(i, i + size).map(worker))
  }
}

export const sendCampaign = onCall<SendRequest>(
  { secrets: [SENDGRID_API_KEY], timeoutSeconds: 540, memory: '512MiB' },
  async (request) => {
    const { pressReleaseId, targetLists, isTest } = request.data ?? {}
    if (!pressReleaseId) {
      throw new HttpsError('invalid-argument', '缺少新聞稿 ID。')
    }

    const user = await authorize(request.auth?.token?.email, !isTest)

    const pressSnap = await db
      .collection('pressReleases')
      .doc(pressReleaseId)
      .get()
    if (!pressSnap.exists) {
      throw new HttpsError('not-found', '找不到這篇新聞稿。')
    }
    const press = pressSnap.data() as {
      title: string
      category: string
      versions: Record<Language, Version>
      attachments?: { name: string; path: string; contentType?: string }[]
    }

    // 收件人：測試信寄給自己，正式發送依勾選名單展開並以 email 去重
    let recipients: Contact[] = []
    if (isTest) {
      const langs = LANGUAGES.filter((l) => {
        const v = press.versions?.[l]
        return v?.subject?.trim() && v?.bodyText?.trim()
      })
      if (langs.length === 0) {
        throw new HttpsError('failed-precondition', '沒有任何已填寫的語言版本。')
      }
      recipients = langs.map((l) => ({
        id: `test_${l}`,
        name: user.displayName ?? '',
        email: user.email,
        outlet: '（測試信）',
        language: l,
      }))
    } else {
      if (!targetLists || targetLists.length === 0) {
        throw new HttpsError('invalid-argument', '請至少勾選一個名單。')
      }
      const contactsSnap = await db.collection('mediaContacts').get()
      const byEmail = new Map<string, Contact>()
      for (const doc of contactsSnap.docs) {
        const c = { id: doc.id, ...doc.data() } as Contact
        if (c.active === false) continue
        if (!(c.lists ?? []).some((l) => targetLists.includes(l))) continue
        if (!byEmail.has(c.email)) byEmail.set(c.email, c)
      }
      recipients = Array.from(byEmail.values())
      if (recipients.length === 0) {
        throw new HttpsError('failed-precondition', '勾選的名單沒有任何收件人。')
      }
      // 有人要收的語言版本一定要填完，否則整批擋下
      const missing = LANGUAGES.filter(
        (l) =>
          recipients.some((r) => r.language === l) &&
          !(
            press.versions?.[l]?.subject?.trim() &&
            press.versions?.[l]?.bodyText?.trim()
          ),
      )
      if (missing.length > 0) {
        throw new HttpsError(
          'failed-precondition',
          `以下語言版本尚未填寫完整：${missing.join('、')}`,
        )
      }
    }

    const attachments = await loadAttachments(press.attachments ?? [])

    // 先建立紀錄，讓前端可以即時看到進度
    const campaignRef = db.collection('campaigns').doc()
    await campaignRef.set({
      pressReleaseId,
      pressTitle: press.title,
      category: press.category,
      targetLists: isTest ? [] : targetLists,
      isTest: !!isTest,
      sentBy: user.email,
      sentAt: FieldValue.serverTimestamp(),
      status: 'sending',
      totals: {
        recipients: recipients.length,
        sent: 0,
        failed: 0,
        opened: 0,
        clicked: 0,
        bounced: 0,
      },
    })

    const batch = db.batch()
    for (const r of recipients) {
      batch.set(campaignRef.collection('recipients').doc(r.id), {
        contactId: r.id,
        email: r.email,
        name: r.name,
        outlet: r.outlet ?? '',
        language: r.language,
        status: 'queued',
      })
    }
    await batch.commit()

    sgMail.setApiKey(SENDGRID_API_KEY.value())

    let sent = 0
    let failed = 0

    await pooled(recipients, 5, async (r) => {
      const version = press.versions[r.language]
      const templateInput = {
        subject: version.subject ?? '',
        bodyText: version.bodyText ?? '',
        heroImageUrl: version.heroImage?.url,
        recipientName: r.name,
        language: r.language,
      }
      try {
        await sgMail.send({
          to: { email: r.email, name: r.name || undefined },
          from: {
            email: SENDER_EMAIL,
            name: SENDER_NAME_BY_LANG[r.language],
          },
          replyTo: SENDER_EMAIL,
          subject: `${isTest ? '[測試] ' : ''}${version.subject}`,
          text: renderEmailText(templateInput),
          html: renderEmailHtml(templateInput),
          attachments,
          // webhook 回傳事件時用這兩個欄位對回收件人
          customArgs: {
            campaignId: campaignRef.id,
            recipientId: r.id,
          },
          trackingSettings: {
            openTracking: { enable: true },
            clickTracking: { enable: true, enableText: false },
          },
          mailSettings: {
            // 新聞稿是一人一封，關閉 SendGrid 的沙盒模式
            sandboxMode: { enable: false },
          },
        })
        sent += 1
        await campaignRef
          .collection('recipients')
          .doc(r.id)
          .update({ status: 'sent' })
      } catch (err) {
        failed += 1
        const detail =
          (err as { response?: { body?: { errors?: { message: string }[] } } })
            .response?.body?.errors?.[0]?.message ?? '寄送失敗'
        logger.error('寄送失敗', { email: r.email, detail })
        await campaignRef
          .collection('recipients')
          .doc(r.id)
          .update({ status: 'failed', error: detail })
      }
    })

    await campaignRef.update({
      status: failed === recipients.length ? 'failed' : 'completed',
      'totals.sent': sent,
      'totals.failed': failed,
    })

    if (!isTest && sent > 0) {
      await db
        .collection('pressReleases')
        .doc(pressReleaseId)
        .update({ status: 'sent' })
    }

    return { campaignId: campaignRef.id, recipients: recipients.length }
  },
)

/** 狀態只能往前推進，避免 delivered 事件蓋掉先前的 opened。 */
const STATUS_RANK: Record<string, number> = {
  queued: 0,
  sent: 1,
  delivered: 2,
  opened: 3,
  clicked: 4,
  bounced: 5,
  failed: 5,
}

const EVENT_TO_STATUS: Record<string, string> = {
  delivered: 'delivered',
  open: 'opened',
  click: 'clicked',
  bounce: 'bounced',
  dropped: 'failed',
  deferred: 'sent',
  spamreport: 'bounced',
}

export const sendgridWebhook = onRequest(
  { secrets: [SENDGRID_WEBHOOK_KEY], cors: false },
  async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).send('Method Not Allowed')
      return
    }

    // 驗證簽章，確認事件確實來自 SendGrid
    try {
      const ew = new EventWebhook()
      const key = ew.convertPublicKeyToECDSA(SENDGRID_WEBHOOK_KEY.value())
      const valid = ew.verifySignature(
        key,
        req.rawBody,
        req.get(EventWebhookHeader.SIGNATURE()) as string,
        req.get(EventWebhookHeader.TIMESTAMP()) as string,
      )
      if (!valid) {
        logger.warn('webhook 簽章驗證失敗')
        res.status(403).send('Forbidden')
        return
      }
    } catch (err) {
      logger.error('webhook 簽章驗證錯誤', err)
      res.status(403).send('Forbidden')
      return
    }

    const events = (Array.isArray(req.body) ? req.body : []) as {
      event: string
      campaignId?: string
      recipientId?: string
      timestamp?: number
    }[]

    for (const ev of events) {
      const nextStatus = EVENT_TO_STATUS[ev.event]
      if (!nextStatus || !ev.campaignId || !ev.recipientId) continue

      const campaignRef = db.collection('campaigns').doc(ev.campaignId)
      const recipientRef = campaignRef
        .collection('recipients')
        .doc(ev.recipientId)

      try {
        await db.runTransaction(async (tx) => {
          const snap = await tx.get(recipientRef)
          if (!snap.exists) return
          const current = (snap.data()?.status as string) ?? 'queued'
          if (STATUS_RANK[nextStatus] <= STATUS_RANK[current]) return

          const when = ev.timestamp
            ? Timestamp.fromMillis(ev.timestamp * 1000)
            : Timestamp.now()

          const patch: Record<string, unknown> = { status: nextStatus }
          if (nextStatus === 'opened') patch.openedAt = when
          if (nextStatus === 'clicked') patch.clickedAt = when
          tx.update(recipientRef, patch)

          // 每位收件人只計一次；點擊同時也算一次開信
          if (nextStatus === 'opened') {
            tx.update(campaignRef, { 'totals.opened': FieldValue.increment(1) })
          } else if (nextStatus === 'clicked') {
            tx.update(campaignRef, {
              'totals.clicked': FieldValue.increment(1),
              ...(STATUS_RANK[current] < STATUS_RANK.opened
                ? { 'totals.opened': FieldValue.increment(1) }
                : {}),
            })
          } else if (nextStatus === 'bounced') {
            tx.update(campaignRef, { 'totals.bounced': FieldValue.increment(1) })
          }
        })
      } catch (err) {
        logger.error('webhook 事件處理失敗', { ev, err })
      }
    }

    res.status(200).send('ok')
  },
)

/**
 * Storage 安全規則讀不到 Firestore，只能看 token 裡的 custom claim，
 * 所以要把 users 白名單同步成 `pressCenter` claim。
 * 兩個時間點都要處理：白名單異動時、以及使用者第一次登入建立帳號時。
 */
async function applyClaim(email: string, allowed: boolean) {
  try {
    const user = await getAuth().getUserByEmail(email)
    const current = user.customClaims ?? {}
    if (!!current.pressCenter === allowed) return
    await getAuth().setCustomUserClaims(user.uid, {
      ...current,
      pressCenter: allowed,
    })
    logger.info('已更新 pressCenter claim', { email, allowed })
  } catch (err) {
    // 使用者還沒登入過就沒有 Auth 帳號，等他首次登入時由 onUserCreated 補上
    if ((err as { code?: string }).code !== 'auth/user-not-found') {
      logger.error('更新 claim 失敗', { email, err })
    }
  }
}

/** 白名單新增 / 停用 / 刪除時，同步調整 claim。 */
export const syncUserClaims = onDocumentWritten(
  'users/{email}',
  async (event) => {
    const email = event.params.email.toLowerCase()
    const after = event.data?.after?.data()
    await applyClaim(email, !!after && after.active !== false)
  },
)

/** 使用者首次登入建立 Auth 帳號時，依白名單決定要不要給 claim。 */
export const onUserCreated = functionsV1
  .region('asia-east1')
  .auth.user()
  .onCreate(async (user) => {
    const email = (user.email ?? '').toLowerCase()
    if (!email) return
    const snap = await db.collection('users').doc(email).get()
    const allowed = snap.exists && snap.data()?.active !== false
    await applyClaim(email, allowed)
  })
