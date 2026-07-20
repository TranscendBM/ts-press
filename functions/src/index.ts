import { initializeApp } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { FieldValue, getFirestore } from 'firebase-admin/firestore'
import { getStorage } from 'firebase-admin/storage'
import { onCall, HttpsError } from 'firebase-functions/v2/https'
import { onDocumentWritten } from 'firebase-functions/v2/firestore'
import { setGlobalOptions } from 'firebase-functions/v2'
import * as functionsV1 from 'firebase-functions/v1'
import * as logger from 'firebase-functions/logger'
import { SecretManagerServiceClient } from '@google-cloud/secret-manager'
import nodemailer from 'nodemailer'
import { renderEmailHtml, renderEmailText } from './emailTemplate'

initializeApp()
setGlobalOptions({ region: 'asia-east1', maxInstances: 5 })

const db = getFirestore()

/**
 * SMTP 設定分兩處存放：
 * - 主機／埠／帳號／Reply-To 這些非機密欄位放 Firestore 的 settings/smtp，後台可直接編輯
 * - 密碼只進 Secret Manager，永遠不寫入 Firestore、也不會回傳到前端
 *
 * 密碼在執行期讀取 latest 版本，所以後台改完立刻生效，不必重新部署。
 */
const SMTP_SECRET_ID = 'SMTP_PASS'
const PROJECT_ID =
  process.env.GCLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT ?? ''

const secretClient = new SecretManagerServiceClient()

interface SmtpSettings {
  host: string
  port: number
  user: string
  replyTo: string
}

async function readSmtpSettings(): Promise<SmtpSettings> {
  const snap = await db.doc('settings/smtp').get()
  const d = snap.data()
  if (!d?.host || !d?.user) {
    throw new HttpsError(
      'failed-precondition',
      '尚未設定寄信伺服器，請先到「系統設定 → 寄信設定」填寫。',
    )
  }
  return {
    host: d.host,
    port: Number(d.port) || 587,
    user: d.user,
    replyTo: d.replyTo || d.user,
  }
}

async function readSmtpPassword(): Promise<string> {
  try {
    const [version] = await secretClient.accessSecretVersion({
      name: `projects/${PROJECT_ID}/secrets/${SMTP_SECRET_ID}/versions/latest`,
    })
    const pass = version.payload?.data?.toString()
    if (!pass) throw new Error('empty')
    return pass
  } catch (err) {
    logger.error('讀取 SMTP 密碼失敗', err)
    throw new HttpsError(
      'failed-precondition',
      '尚未設定寄信密碼，請先到「系統設定 → 寄信設定」填寫。',
    )
  }
}

/** 依設定建立 SMTP 連線。587 走 STARTTLS 並強制加密。 */
async function createTransport(settings: SmtpSettings, password: string) {
  return nodemailer.createTransport({
    host: settings.host,
    port: settings.port,
    secure: settings.port === 465,
    // 沒有 TLS 的話 AUTH LOGIN 的帳密等同明文傳送
    requireTLS: settings.port !== 465,
    auth: { user: settings.user, pass: password },
    // 連線重複使用，避免每封信都重新握手被伺服器當成異常流量
    pool: true,
    maxConnections: 1,
    maxMessages: 50,
  })
}

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
  { timeoutSeconds: 540, memory: '512MiB' },
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

    const settings = await readSmtpSettings()
    const transporter = await createTransport(settings, await readSmtpPassword())

    try {
      await transporter.verify()
    } catch (err) {
      logger.error('SMTP 連線失敗', err)
      throw new HttpsError(
        'unavailable',
        `SMTP 伺服器連線失敗：${(err as Error).message}`,
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
          // 寄件地址必須與認證帳號一致，否則 mail2000 會拒收
          from: `"${SENDER_NAME_BY_LANG[r.language]}" <${settings.user}>`,
          replyTo: settings.replyTo,
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

/** 只有 admin 能碰寄信設定。 */
async function requireAdmin(email: string | undefined) {
  const user = await authorize(email, false)
  if (user.role !== 'admin') {
    throw new HttpsError('permission-denied', '只有管理員可以修改寄信設定。')
  }
  return user
}

/** 把新密碼寫成 Secret Manager 的新版本，必要時先建立 secret。 */
async function writeSmtpPassword(password: string) {
  const parent = `projects/${PROJECT_ID}`
  const name = `${parent}/secrets/${SMTP_SECRET_ID}`
  try {
    await secretClient.getSecret({ name })
  } catch {
    await secretClient.createSecret({
      parent,
      secretId: SMTP_SECRET_ID,
      secret: { replication: { automatic: {} } },
    })
  }
  await secretClient.addSecretVersion({
    parent: name,
    payload: { data: Buffer.from(password, 'utf8') },
  })
}

interface SmtpSettingsRequest {
  host: string
  port: number
  user: string
  replyTo: string
  /** 留空代表不更動現有密碼。 */
  password?: string
}

/** 後台儲存寄信設定。密碼只進 Secret Manager，不寫 Firestore。 */
export const updateSmtpSettings = onCall<SmtpSettingsRequest>(
  async (request) => {
    const admin = await requireAdmin(request.auth?.token?.email)
    const { host, port, user, replyTo, password } = request.data ?? {}

    if (!host?.trim() || !user?.trim()) {
      throw new HttpsError('invalid-argument', '主機與帳號為必填。')
    }
    const portNum = Number(port) || 587
    if (portNum === 25) {
      throw new HttpsError(
        'invalid-argument',
        'Google Cloud 封鎖對外的 port 25，請改用 587 或 465。',
      )
    }

    if (password) {
      try {
        await writeSmtpPassword(password)
      } catch (err) {
        logger.error('寫入密碼失敗', err)
        throw new HttpsError(
          'internal',
          '密碼寫入 Secret Manager 失敗，可能是服務帳號缺少權限。請查看 Functions 記錄。',
        )
      }
    }

    await db.doc('settings/smtp').set(
      {
        host: host.trim(),
        port: portNum,
        user: user.trim(),
        replyTo: (replyTo || '').trim() || user.trim(),
        updatedAt: FieldValue.serverTimestamp(),
        updatedBy: admin.email,
        ...(password ? { passwordUpdatedAt: FieldValue.serverTimestamp() } : {}),
      },
      { merge: true },
    )

    return { ok: true }
  },
)

/** 測試 SMTP 連線與帳密，成功時可順便寄一封信給操作者。 */
export const testSmtpConnection = onCall<{ sendTestEmail?: boolean }>(
  { timeoutSeconds: 120 },
  async (request) => {
    const admin = await requireAdmin(request.auth?.token?.email)
    const settings = await readSmtpSettings()
    const transporter = await createTransport(settings, await readSmtpPassword())

    try {
      await transporter.verify()
    } catch (err) {
      const message = (err as Error).message
      logger.warn('SMTP 測試失敗', { message })
      return { ok: false, message: describeSmtpError(message) }
    }

    if (request.data?.sendTestEmail) {
      try {
        await transporter.sendMail({
          to: admin.email,
          from: `"創見資訊 新聞中心" <${settings.user}>`,
          replyTo: settings.replyTo,
          subject: '[測試] 新聞稿發送系統連線測試',
          text: `連線成功。\n\n主機：${settings.host}:${settings.port}\n帳號：${settings.user}\n回覆至：${settings.replyTo}`,
        })
      } catch (err) {
        return {
          ok: false,
          message: `連線成功但寄信失敗：${(err as Error).message}`,
        }
      } finally {
        transporter.close()
      }
      return { ok: true, message: `連線成功，已寄一封測試信到 ${admin.email}。` }
    }

    transporter.close()
    return { ok: true, message: '連線與帳密驗證成功。' }
  },
)

/** 把 SMTP 的錯誤訊息翻成看得懂的說明。 */
function describeSmtpError(message: string): string {
  const m = message.toLowerCase()
  if (m.includes('auth') || m.includes('535') || m.includes('credentials')) {
    return `帳號或密碼錯誤（${message}）`
  }
  if (m.includes('timeout') || m.includes('etimedout')) {
    return `連線逾時 —— 很可能是防火牆擋住了從外部連入的連線，需請 IT 開放。（${message}）`
  }
  if (m.includes('econnrefused')) {
    return `伺服器拒絕連線，請確認主機與連接埠是否正確。（${message}）`
  }
  if (m.includes('certificate') || m.includes('self signed')) {
    return `TLS 憑證驗證失敗（${message}）`
  }
  return message
}

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
