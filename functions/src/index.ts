import { initializeApp } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { FieldValue, getFirestore } from 'firebase-admin/firestore'
import { getStorage } from 'firebase-admin/storage'
import { onCall, HttpsError } from 'firebase-functions/v2/https'
import { onDocumentWritten } from 'firebase-functions/v2/firestore'
import { defineSecret } from 'firebase-functions/params'
import { setGlobalOptions } from 'firebase-functions/v2'
import * as functionsV1 from 'firebase-functions/v1'
import * as logger from 'firebase-functions/logger'
import nodemailer from 'nodemailer'
import { renderEmailHtml, renderEmailText } from './emailTemplate'

initializeApp()
setGlobalOptions({ region: 'asia-east1', maxInstances: 5 })

// mail2000 的 SMTP 連線資訊，用 firebase functions:secrets:set 設定
const SMTP_HOST = defineSecret('SMTP_HOST')
const SMTP_PORT = defineSecret('SMTP_PORT')
const SMTP_USER = defineSecret('SMTP_USER')
const SMTP_PASS = defineSecret('SMTP_PASS')

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

/** 從 Storage 抓附件，轉成 nodemailer 需要的格式。 */
async function loadAttachments(
  files: { name: string; path: string; contentType?: string }[],
) {
  const bucket = getStorage().bucket()
  const out = []
  for (const f of files ?? []) {
    try {
      const [buf] = await bucket.file(f.path).download()
      out.push({
        filename: f.name,
        content: buf,
        contentType: f.contentType || 'application/octet-stream',
      })
    } catch (err) {
      logger.error('附件下載失敗', { path: f.path, err })
      throw new HttpsError('internal', `附件「${f.name}」讀取失敗，請重新上傳。`)
    }
  }
  return out
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export const sendCampaign = onCall<SendRequest>(
  {
    secrets: [SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS],
    timeoutSeconds: 540,
    memory: '512MiB',
  },
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

    const port = Number(SMTP_PORT.value()) || 587
    const transporter = nodemailer.createTransport({
      host: SMTP_HOST.value(),
      port,
      secure: port === 465,
      auth: { user: SMTP_USER.value(), pass: SMTP_PASS.value() },
      // 連線重複使用，避免每封信都重新握手被伺服器當成異常流量
      pool: true,
      maxConnections: 1,
      maxMessages: 50,
    })

    try {
      await transporter.verify()
    } catch (err) {
      logger.error('SMTP 連線失敗', err)
      throw new HttpsError(
        'unavailable',
        'SMTP 伺服器連線失敗，請確認 mail2000 設定與是否允許外部連線。',
      )
    }

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
      totals: { recipients: recipients.length, sent: 0, failed: 0 },
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

    let sent = 0
    let failed = 0

    // 逐封寄送並稍作間隔，避免 mail2000 判定為濫發而阻擋
    for (const r of recipients) {
      const version = press.versions[r.language]
      const templateInput = {
        subject: version.subject ?? '',
        bodyText: version.bodyText ?? '',
        heroImageUrl: version.heroImage?.url,
        recipientName: r.name,
        language: r.language,
      }
      try {
        await transporter.sendMail({
          to: r.name ? `"${r.name.replace(/"/g, '')}" <${r.email}>` : r.email,
          from: `"${SENDER_NAME_BY_LANG[r.language]}" <${SENDER_EMAIL}>`,
          replyTo: SENDER_EMAIL,
          subject: `${isTest ? '[測試] ' : ''}${version.subject}`,
          text: renderEmailText(templateInput),
          html: renderEmailHtml(templateInput),
          attachments,
        })
        sent += 1
        await campaignRef
          .collection('recipients')
          .doc(r.id)
          .update({ status: 'sent' })
      } catch (err) {
        failed += 1
        const detail = (err as { message?: string }).message ?? '寄送失敗'
        logger.error('寄送失敗', { email: r.email, detail })
        await campaignRef
          .collection('recipients')
          .doc(r.id)
          .update({ status: 'failed', error: detail })
      }
      await sleep(400)
    }

    transporter.close()

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
