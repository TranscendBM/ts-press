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
import { SecretManagerServiceClient } from '@google-cloud/secret-manager'
import nodemailer from 'nodemailer'
import * as tls from 'node:tls'
import { SECTIGO_INTERMEDIATE_CA } from './smtpCa'
import {
  renderEmailHtml,
  renderEmailText,
  type PressContact,
} from './emailTemplate.generated'
import {
  checkPermission,
  describeDecision,
  normalizeRole,
  type Permission,
  type PermissionsReader,
  type PermissionsSnapshot,
} from './permissions.generated'
import {
  ATTACHMENT_LIMITS,
  BATCH_SIZE,
  chunk,
  evaluateAccess,
  isAllowedAttachmentPath,
  type AppRole,
} from './policy.generated'

interface AuthorizedUser {
  email: string
  displayName?: string
  role?: AppRole
}

type CallableAuth =
  | { token?: { email?: string; email_verified?: boolean } }
  | undefined

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

/**
 * 這個宣告的用途不是取值，而是讓 Firebase 在部署時自動把
 * secretAccessor 權限授予 Functions 的執行服務帳號。
 * 實際讀取仍走底下的 client 並取 latest 版本，這樣後台改密碼才會立即生效
 * （宣告注入的環境變數是部署當下的版本，會過期）。
 */
const SMTP_PASS = defineSecret(SMTP_SECRET_ID)

const secretClient = new SecretManagerServiceClient()

interface SmtpSettings {
  host: string
  port: number
  /** SMTP 認證用的帳號，必須是可登入的個人帳號。 */
  user: string
  /**
   * 信件 From 標頭要顯示的地址。可以與認證帳號不同（Mail2000 的「代理寄件」），
   * 前提是 IT 已授權該認證帳號使用這個地址，否則伺服器會拒收。
   */
  fromEmail: string
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
    fromEmail: d.fromEmail || d.user,
    replyTo: d.replyTo || d.fromEmail || d.user,
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
    const e = err as { code?: number; message?: string }
    // 7 = PERMISSION_DENIED、5 = NOT_FOUND。兩者原因完全不同，不能混為一談。
    if (e.code === 7) {
      throw new HttpsError(
        'internal',
        'Cloud Functions 沒有讀取密鑰的權限。請到 Google Cloud Console → IAM，' +
          '為 Functions 的執行服務帳號加上「Secret Manager 密鑰存取者」角色。',
      )
    }
    throw new HttpsError(
      'failed-precondition',
      '尚未設定寄信密碼，請到「系統設定 → 寄信設定」填寫。',
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
    tls: {
      servername: settings.host,
      // 伺服器沒送中介憑證，補上後才拼得出信任鏈。
      // 維持完整驗證，不用 rejectUnauthorized:false —— 那會讓帳密暴露在中間人攻擊下。
      ca: [...tls.rootCertificates, SECTIGO_INTERMEDIATE_CA],
    },
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

/**
 * 三種發送模式。刻意用獨立的 mode 而不是一個 isTest 布林值 ——
 * 正式發送與測試發送在後端就是不同分支，減少誤發的可能。
 *
 * - self：只寄給操作者本人，已填寫的每個語言版本各一封
 * - testList：寄給「測試名單」裡的內部同仁，流程與正式發送相同
 * - real：正式發送給勾選的媒體名單，需要 admin / manager 權限
 */
type SendMode = 'self' | 'testList' | 'real'

/** 測試名單只能由測試模式觸發，正式發送一律排除。 */
const TEST_LIST_ID = 'test'

interface SendRequest {
  pressReleaseId: string
  targetLists?: string[]
  mode: SendMode
}

/**
 * 所有 callable 共用的授權檢查。Admin SDK 會略過 Firestore 規則，
 * 所以這裡必須自行做完整判斷，否則規則擋得住的情境會從 Functions 繞過去。
 */
async function authorize(
  auth: CallableAuth,
  needsSendRole: boolean,
): Promise<AuthorizedUser> {
  const email = auth?.token?.email?.toLowerCase()
  const snap = email ? await db.collection('users').doc(email).get() : undefined
  const verdict = evaluateAccess({
    email,
    emailVerified: auth?.token?.email_verified,
    userDoc: snap?.exists
      ? (snap.data() as { role?: string; active?: unknown })
      : undefined,
    needsSendRole,
  })
  if (!verdict.ok) throw new HttpsError('permission-denied', verdict.reason)
  return { ...(snap?.data() ?? {}), email: email as string } as AuthorizedUser
}

/**
 * 正式環境的權限讀取器。
 *
 * 只負責取資料，把「讀不到怎麼辦」的決策留給 checkPermission ——
 * 這樣測試才能注入各種失敗情境而不必碰到真正的 Firestore。
 */
const firestorePermissionsReader: PermissionsReader = async () => {
  const snap = await db.doc('settings/permissions').get()
  const result: PermissionsSnapshot = snap.exists
    ? { exists: true, roles: snap.data()?.roles }
    : { exists: false }
  return result
}

/**
 * 依權限矩陣把關。前端會隱藏沒有權限的按鈕，
 * 但真正的攔截一定要在這裡 —— 前端可被繞過。
 *
 * 注意：permission 由呼叫端在程式碼中寫死，絕不採用 client 傳入的值。
 */
async function requirePermission(
  auth: CallableAuth,
  permission: Permission,
  read: PermissionsReader = firestorePermissionsReader,
): Promise<AuthorizedUser> {
  const user = await authorize(auth, false)
  const decision = await checkPermission(user.role, permission, read)
  if (!decision.allowed) {
    logger.warn('權限不足', {
      email: user.email,
      role: user.role,
      permission,
      reason: decision.reason,
    })
    throw new HttpsError(
      decision.reason === 'read-error' ? 'unavailable' : 'permission-denied',
      describeDecision(decision, permission),
    )
  }
  return user
}

/** 只有 admin 能修改系統設定。 */
async function requireAdmin(auth: CallableAuth): Promise<AuthorizedUser> {
  const user = await authorize(auth, false)
  if (normalizeRole(user.role) !== 'admin') {
    throw new HttpsError('permission-denied', '只有管理員可以執行這個動作。')
  }
  return user
}

/**
 * 從 Storage 抓附件。大小與類型一律以 Storage metadata 為準，
 * 並先確認總量再下載，避免把過大的檔案全載進記憶體導致 Function 被中止。
 */
async function loadAttachments(
  files: { name?: string; path?: string }[] | undefined,
  pressReleaseId: string,
) {
  const list = files ?? []
  if (list.length === 0) return []
  if (list.length > ATTACHMENT_LIMITS.maxCount) {
    throw new HttpsError(
      'failed-precondition',
      `附件最多 ${ATTACHMENT_LIMITS.maxCount} 個，目前有 ${list.length} 個。`,
    )
  }

  const bucket = getStorage().bucket()
  const mb = (n: number) => n / 1024 / 1024

  // 第一輪只讀 metadata，確認路徑合法與總大小
  const checked: {
    path: string
    filename: string
    contentType: string
  }[] = []
  let total = 0
  for (const f of list) {
    if (!isAllowedAttachmentPath(f.path, pressReleaseId)) {
      logger.error('附件路徑不在允許範圍', { path: f.path, pressReleaseId })
      throw new HttpsError(
        'permission-denied',
        '附件路徑不合法，請重新上傳附件。',
      )
    }
    const file = bucket.file(f.path as string)
    let meta
    try {
      ;[meta] = await file.getMetadata()
    } catch (err) {
      logger.error('讀取附件 metadata 失敗', { path: f.path, err })
      throw new HttpsError(
        'failed-precondition',
        `附件「${f.name ?? f.path}」已不存在，請重新上傳。`,
      )
    }
    const size = Number(meta.size ?? 0)
    if (!Number.isFinite(size) || size <= 0) {
      throw new HttpsError('failed-precondition', '附件內容為空，請重新上傳。')
    }
    if (size > ATTACHMENT_LIMITS.maxFileBytes) {
      throw new HttpsError(
        'failed-precondition',
        `附件「${f.name ?? ''}」超過單檔 ${mb(ATTACHMENT_LIMITS.maxFileBytes)}MB 上限。`,
      )
    }
    total += size
    if (total > ATTACHMENT_LIMITS.maxTotalBytes) {
      throw new HttpsError(
        'failed-precondition',
        `附件總大小超過 ${mb(ATTACHMENT_LIMITS.maxTotalBytes)}MB 上限。`,
      )
    }
    checked.push({
      path: f.path as string,
      // 檔名只取最後一段，避免路徑字元被塞進郵件標頭
      filename: (f.name ?? f.path ?? 'attachment').split('/').pop() as string,
      contentType: meta.contentType ?? 'application/octet-stream',
    })
  }

  const out = []
  for (const c of checked) {
    try {
      const [buf] = await bucket.file(c.path).download()
      out.push({ filename: c.filename, content: buf, contentType: c.contentType })
    } catch (err) {
      logger.error('附件下載失敗', { path: c.path, err })
      throw new HttpsError(
        'internal',
        `附件「${c.filename}」讀取失敗，請重新上傳。`,
      )
    }
  }
  return out
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export const sendCampaign = onCall<SendRequest>(
  { secrets: [SMTP_PASS], timeoutSeconds: 540, memory: '512MiB' },
  async (request) => {
    const { pressReleaseId, targetLists, mode } = request.data ?? {}
    if (!pressReleaseId) {
      throw new HttpsError('invalid-argument', '缺少新聞稿 ID。')
    }
    if (mode !== 'self' && mode !== 'testList' && mode !== 'real') {
      throw new HttpsError('invalid-argument', '發送模式不正確。')
    }
    const isTest = mode !== 'real'

    // 測試信與正式發送是兩種不同權限：行銷專員兩者皆無
    const user = await requirePermission(
      request.auth,
      mode === 'real' ? 'sendReal' : 'sendTest',
    )

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
      releaseDate?: string
      versions: Record<Language, Version>
      attachments?: { name: string; path: string; contentType?: string }[]
    }

    // 頁首 logo 與各語言的新聞聯絡人
    const emailSettings =
      (await db.doc('settings/email').get()).data() ??
      ({} as {
        logoUrl?: string
        contacts?: Record<Language, PressContact>
        about?: Record<Language, { text?: string; link?: string }>
      })

    /** 依名單展開收件人，同一個 email 只留一份。 */
    async function expandLists(lists: string[]): Promise<Contact[]> {
      const contactsSnap = await db.collection('mediaContacts').get()
      const byEmail = new Map<string, Contact>()
      for (const doc of contactsSnap.docs) {
        const c = { id: doc.id, ...doc.data() } as Contact
        if (c.active === false) continue
        if (!(c.lists ?? []).some((l) => lists.includes(l))) continue
        if (!byEmail.has(c.email)) byEmail.set(c.email, c)
      }
      return Array.from(byEmail.values())
    }

    let recipients: Contact[] = []
    let effectiveLists: string[] = []

    if (mode === 'self') {
      const langs = LANGUAGES.filter((l) => {
        const v = press.versions?.[l]
        return v?.subject?.trim() && v?.bodyText?.trim()
      })
      if (langs.length === 0) {
        throw new HttpsError('failed-precondition', '沒有任何已填寫的語言版本。')
      }
      recipients = langs.map((l) => ({
        id: `self_${l}`,
        name: user.displayName ?? '',
        email: user.email,
        outlet: '（測試信）',
        language: l,
      }))
    } else if (mode === 'testList') {
      effectiveLists = [TEST_LIST_ID]
      recipients = await expandLists(effectiveLists)
      if (recipients.length === 0) {
        throw new HttpsError(
          'failed-precondition',
          '測試名單沒有任何聯絡人，請先到媒體名單把同仁加進「測試名單」。',
        )
      }
    } else {
      // 正式發送：測試名單一律排除，避免內部信箱混進真實發稿
      effectiveLists = (targetLists ?? []).filter((l) => l !== TEST_LIST_ID)
      if (effectiveLists.length === 0) {
        throw new HttpsError('invalid-argument', '請至少勾選一個媒體名單。')
      }
      recipients = await expandLists(effectiveLists)
      if (recipients.length === 0) {
        throw new HttpsError('failed-precondition', '勾選的名單沒有任何收件人。')
      }
    }

    if (mode !== 'self') {
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

    const attachments = await loadAttachments(press.attachments, pressReleaseId)

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
      targetLists: effectiveLists,
      mode,
      isTest,
      sentBy: user.email,
      sentAt: FieldValue.serverTimestamp(),
      status: 'sending',
      totals: { recipients: recipients.length, sent: 0, failed: 0 },
    })

    // Firestore batch 一次上限 500 筆，收件人多時要分批
    try {
      for (const group of chunk(recipients)) {
        const batch = db.batch()
        for (const r of group) {
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
      }
    } catch (err) {
      // 不能讓 campaign 永遠停在 sending，否則畫面會一直轉圈
      logger.error('建立收件人紀錄失敗', err)
      await campaignRef.update({
        status: 'failed',
        error: `建立收件人紀錄失敗：${(err as Error).message}`,
      })
      throw new HttpsError(
        'internal',
        '建立收件人紀錄失敗，尚未寄出任何信件，請稍後再試。',
      )
    }

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
        releaseDate: press.releaseDate,
        logoUrl: emailSettings.logoUrl,
        contact: emailSettings.contacts?.[r.language],
        about: emailSettings.about?.[r.language]?.text,
        aboutLink: emailSettings.about?.[r.language]?.link,
      }
      try {
        await transporter.sendMail({
          to: r.name ? `"${r.name.replace(/"/g, '')}" <${r.email}>` : r.email,
          from: `"${SENDER_NAME_BY_LANG[r.language]}" <${settings.fromEmail}>`,
          replyTo: settings.replyTo,
          subject: `${isTest ? '[測試] ' : ''}${version.subject}`,
          // 測試信加上標頭，萬一誤轉寄也看得出不是正式發稿
          headers: isTest ? { 'X-Press-Center-Test': 'true' } : undefined,
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
  fromEmail: string
  replyTo: string
  /** 留空代表不更動現有密碼。 */
  password?: string
}

/** 後台儲存寄信設定。密碼只進 Secret Manager，不寫 Firestore。 */
export const updateSmtpSettings = onCall<SmtpSettingsRequest>(
  async (request) => {
    const admin = await requireAdmin(request.auth)
    const { host, port, user, fromEmail, replyTo, password } =
      request.data ?? {}

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
        fromEmail: (fromEmail || '').trim() || user.trim(),
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
  { secrets: [SMTP_PASS], timeoutSeconds: 120 },
  async (request) => {
    const admin = await requireAdmin(request.auth)
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
          from: `"創見資訊 新聞中心" <${settings.fromEmail}>`,
          replyTo: settings.replyTo,
          subject: '[測試] 新聞稿發送系統連線測試',
          text: [
            '連線成功，這封信就是系統實際寄出的樣子。',
            '',
            `主機：${settings.host}:${settings.port}`,
            `認證帳號：${settings.user}`,
            `寄件地址：${settings.fromEmail}`,
            `回覆至：${settings.replyTo}`,
            '',
            '請確認這封信的「寄件者」顯示是否正確，',
            '以及按下回覆時收件地址是否為預期的信箱。',
          ].join('\n'),
        })
      } catch (err) {
        return {
          ok: false,
          message: `連線成功但寄信失敗：${describeSmtpError((err as Error).message)}`,
        }
      } finally {
        transporter.close()
      }
      return {
        ok: true,
        message: `已寄一封測試信到 ${admin.email}，請確認寄件者顯示為 ${settings.fromEmail}。`,
      }
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
  if (m.includes('550') || m.includes('sender') || m.includes('not allowed')) {
    return `伺服器拒絕這個寄件地址 —— 認證帳號可能沒有被授權以該地址寄信，請確認 IT 是否已開放代理寄件權限。（${message}）`
  }
  return message
}

/**
 * Storage 安全規則讀不到 Firestore，只能看 token 裡的 custom claim，
 * 所以要把 users 白名單同步成 `pressCenter` claim。
 * 兩個時間點都要處理：白名單異動時、以及使用者第一次登入建立帳號時。
 */
async function applyClaim(
  email: string,
  allowed: boolean,
  role?: string,
) {
  try {
    const user = await getAuth().getUserByEmail(email)
    const current = user.customClaims ?? {}
    const nextRole = allowed ? (role ?? null) : null
    // Storage 規則看的是 token 裡的 role，所以白名單改角色時要同步過來
    if (!!current.pressCenter === allowed && (current.role ?? null) === nextRole) {
      return
    }
    await getAuth().setCustomUserClaims(user.uid, {
      ...current,
      pressCenter: allowed,
      role: nextRole,
    })
    logger.info('已更新 pressCenter / role claim', { email, allowed, role: nextRole })
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
    // 與 evaluateAccess 一致：必須明確 active === true 才算啟用
    await applyClaim(email, after?.active === true, normalizeRole(after?.role))
  },
)

function snap_or_undefined(snap: FirebaseFirestore.DocumentSnapshot) {
  return snap.exists ? (snap.data() as { active?: unknown; role?: string }) : undefined
}

/** 使用者首次登入建立 Auth 帳號時，依白名單決定要不要給 claim。 */
export const onUserCreated = functionsV1
  .region('asia-east1')
  .auth.user()
  .onCreate(async (user) => {
    const email = (user.email ?? '').toLowerCase()
    if (!email) return
    const data = snap_or_undefined(await db.collection('users').doc(email).get())
    await applyClaim(email, data?.active === true, normalizeRole(data?.role))
  })

/**
 * 刪除活動並清掉底下的 participants 子集合。
 *
 * 前端只刪父文件的話，子集合會變成孤兒資料 —— Firestore 不會連帶刪除，
 * 這些紀錄會永遠留在資料庫裡佔空間，而且日後若建了同 id 的活動還會冒出來。
 */
export const deleteMediaEvent = onCall<{ eventId: string }>(
  { timeoutSeconds: 120 },
  async (request) => {
    await requirePermission(request.auth, 'manageEvents')
    const eventId = request.data?.eventId
    if (!eventId || typeof eventId !== 'string' || eventId.includes('/')) {
      throw new HttpsError('invalid-argument', '活動 ID 不正確。')
    }

    const eventRef = db.collection('mediaEvents').doc(eventId)
    if (!(await eventRef.get()).exists) {
      throw new HttpsError('not-found', '找不到這場活動。')
    }

    let removed = 0
    try {
      // 分批刪，避免子集合筆數多時超過單一 batch 的上限
      for (;;) {
        const snap = await eventRef
          .collection('participants')
          .limit(BATCH_SIZE)
          .get()
        if (snap.empty) break
        const batch = db.batch()
        for (const d of snap.docs) batch.delete(d.ref)
        await batch.commit()
        removed += snap.size
        if (snap.size < BATCH_SIZE) break
      }
      // 子集合清空後才刪父文件，中途失敗仍看得到活動、可以重試
      await eventRef.delete()
    } catch (err) {
      logger.error('刪除活動失敗', { eventId, err })
      throw new HttpsError(
        'internal',
        `刪除活動失敗：${(err as Error).message}`,
      )
    }

    return { ok: true, participantsRemoved: removed }
  },
)

/**
 * 補發目前登入者的 custom claim。
 *
 * pressCenter / role 這兩個 claim 是由白名單異動或首次登入時寫入的。
 * 之後若新增了 claim（例如 Storage 規則開始檢查 role），既有使用者的
 * token 裡不會有，功能會莫名失效。前端在偵測到 claim 與白名單不一致時
 * 呼叫這支，補完後強制刷新 token 即可，不必請每個人重新登入。
 */
export const refreshMyClaims = onCall(async (request) => {
  const user = await authorize(request.auth, false)
  await applyClaim(user.email, true, normalizeRole(user.role))
  return { ok: true, role: user.role ?? null }
})
