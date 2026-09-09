import { initializeApp } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { FieldValue, getFirestore, Timestamp } from 'firebase-admin/firestore'
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
import { randomUUID } from 'node:crypto'
import { SECTIGO_INTERMEDIATE_CA } from './smtpCa'
import {
  renderEmailHtml,
  renderEmailText,
  subjectSingleLine,
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
  expandInternalCopies,
  isAllowedAttachmentPath,
  isAllowedPressFilePath,
  parseEmailList,
  type AppRole,
} from './policy.generated'
import {
  CLEANUP_LEASE_MS,
  collectPressFilePaths,
  deletePressReleaseWithCleanup,
  hasExceededCleanupAttempts,
  isCleanupItemClaimable,
  MAX_CLEANUP_ATTEMPTS,
} from './pressCleanup.generated'
import {
  acquireCampaignLeaseTx,
  acquireResolutionLeaseTx,
  areAllRecipientStatusesKnown,
  beginDeliveryAttemptTx,
  CAMPAIGN_FUNCTION_TIMEOUT_MS,
  CAMPAIGN_LEASE_MS,
  claimRecipientTx,
  classifyCampaignForDrainAudit,
  commitRecipientResultTx,
  computeAuthoritativeRecipientTotals,
  createOrJoinCampaignTx,
  finalizeCampaignWithPressReleaseTx,
  isValidIdempotencyKey,
  markCampaignFailedTx,
  MAX_RECIPIENT_ATTEMPTS,
  processOneRecipient,
  readFirstValidMs,
  reclaimAbandonedSetupTx,
  reclaimExpiredDeliveryAttemptTx,
  reconcileCampaignDelivery,
  releaseCampaignProcessingLeaseTx,
  repairCampaignPressReleaseSyncTx,
  RECIPIENT_LEASE_MS,
  RECIPIENTS_SETUP_STALE_MS,
  RESOLUTION_LEASE_MS,
  resolveCampaignResume,
  resolveDeliveryUnknownTx,
  runSendPhase,
  SEND_BATCH_LIMIT,
  selectRecipientsToProcess,
  sendMailWithWallClockDeadline,
  SMTP_CONNECTION_TIMEOUT_MS,
  SMTP_GREETING_TIMEOUT_MS,
  SMTP_SEND_WALL_CLOCK_TIMEOUT_MS,
  SMTP_SOCKET_TIMEOUT_MS,
  type AcquireLeaseDecision,
  type AcquireResolutionLeaseDecision,
  type CampaignFinalizeStatus,
  type CampaignStatus,
  type DeliveryUnknownResolutionAction,
  type DocSnapshotLike,
  type DocTx,
  type ExistingCampaignFields,
  type FailureOwnership,
  type FinalizeCampaignWithPressReleaseDecision,
  type ReconcileCampaignDeliveryDeps,
} from './campaignSend.generated'

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
  /** 「寄測試信給我」時，除了登入者本人，還會一併寄達的信箱。 */
  testRecipients: string[]
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
    testRecipients: parseEmailList(d.testRecipients),
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

/**
 * 依設定建立 SMTP 連線。587 走 STARTTLS 並強制加密。
 *
 * 明確設定 connectionTimeout／greetingTimeout／socketTimeout —— 不設的話
 * Nodemailer 的 socketTimeout 預設是 10 分鐘，遠大於收件人處理租約
 * RECIPIENT_LEASE_MS，代表 sendMail() 理論上可以卡住將近 10 分鐘才被
 * Nodemailer 自己判定逾時，但另一個 invocation 在 RECIPIENT_LEASE_MS
 * 過後就會認定上一個 invocation 死了並重新認領同一位收件人，兩邊同時
 * 呼叫 sendMail() 造成可避免的重複寄送。這三個逾時常數與
 * RECIPIENT_LEASE_MS 的關係定義在 shared/campaignSend.ts，兩邊必須一起看。
 */
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
    connectionTimeout: SMTP_CONNECTION_TIMEOUT_MS,
    greetingTimeout: SMTP_GREETING_TIMEOUT_MS,
    socketTimeout: SMTP_SOCKET_TIMEOUT_MS,
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

/**
 * 名單對應的語言版本，內部副本要依所屬名單決定寄哪個版本。
 * 必須與前端 src/constants.ts 的 LIST_DEFAULT_LANGUAGE 一致。
 */
const LIST_LANGUAGE: Record<string, Language> = {
  tw_pr: 'tw',
  tw_ir: 'tw',
  global_pr: 'www',
  us_pr: 'us',
}

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
  /**
   * 前端在同一次「發送」互動中固定不變的識別碼（例如確認視窗開啟時產生一次
   * UUID，重試沿用同一個）。有帶且格式正確時，campaign 文件 ID 就直接用
   * 這個值 —— 同一個 idempotencyKey 重複呼叫不會建立第二個 campaign，
   * 也不會重寄已經成功的收件人（見下方 sendPendingRecipients）。
   * 沒帶就沿用原本的自動 ID 行為，不保證重試安全。
   */
  idempotencyKey?: string
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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

interface RecipientDoc {
  email: string
  name: string
  outlet: string
  language: Language
  status: 'queued' | 'claimed' | 'sending' | 'sent' | 'failed' | 'exhausted' | 'delivery_unknown'
  attemptId?: string | null
  attemptCount?: number
  leaseExpiresAtMs?: number | null
  /** 相容欄位：round 4 之前寫入的舊文件用 Timestamp，見 readFirstValidMs 的說明。 */
  leaseExpiresAt?: FirebaseFirestore.Timestamp
}

interface CampaignPress {
  title: string
  category: string
  releaseDate?: string
  versions: Record<Language, Version>
}

interface CampaignEmailSettings {
  logoUrl?: string
  contacts?: Record<Language, PressContact>
  about?: Record<Language, { text?: string; link?: string }>
}

// =============================================================================
// campaign 寄送：部署安全程序（round 12 新增，round 13 修正，Finding 3／5）
// =============================================================================
//
// ⚠️ 部署新版本的 functions 程式碼時，Cloud Functions（2nd gen／Cloud Run
// 架構）不會立刻終止舊 revision 上已經在執行中的 invocation——已經在跑的
// sendCampaign／retryCampaign 會被允許繼續執行到自己的 timeoutSeconds 上限
//（CAMPAIGN_FUNCTION_TIMEOUT_MS，540 秒）才會被強制終止；只有「之後才發起
// 的新請求」會被路由到新 revision。這代表部署後最長 540 秒內，舊版本與新
// 版本的程式碼可能同時對同一份 Firestore 資料寫入。
//
// 這個檔案（以及 shared/campaignSend.ts）裡任何形式的「migration-safe
// marker」（例如 recipient.attemptCountPending）只能安全處理「部署前已經
// 寫入、之後由新程式讀到」這種靜態情況——它們**不能**單方面阻止一個仍在
// 執行中的舊 binary 對同一份文件寫入，因為舊 binary 根本不認識這些新欄位
//（`update()` 是部分寫入，不會清掉新版本留下的欄位）。
//
// ⚠️ round 13 修正（Finding 2）、round 14 補充（Finding 4）：程式碼層面的
// claimGeneration 交叉驗證（見 decideBeginDeliveryAttempt 的說明）
// **不足以**擋下所有雙重計數風險——完整重現（tests/campaignConcurrency.test.ts
// 的 round 13 Finding 2 測試）證明：一個舊 invocation 在 claim 當下寫入的
// attemptCount 累加（它自己從未真正呼叫過 begin／SMTP）會永久留在這個
// 欄位裡，之後任何合法的新 invocation 算出來的 attemptCount 都會把這個
// 「幽靈 attempt」算進去——claimGeneration 只能擋下「舊身分被拿來繼續
// 呼叫 begin」，無法分辨 attemptCount 目前的值裡有多少是真正的 SMTP
// attempt。**這不只是稽核數字比較大而已**：hasExceededMaxAttempts() 會把
// 幽靈計數當真，直接後果是收件人可能比實際情況更早被判定 exhausted、
// 永久停止自動重試。這是程式碼層面無法單方面消除的操作限制，**下面的
// drain 程序是部署的必要條件，不是建議事項**，只有確實執行才能真正避免。
//
// ⚠️ round 13 修正（Finding 3）：這裡過去只檢查 `status === 'sending'`——
// 但 retryCampaign 取得處理租約時，campaign 可能仍然是 `status:'partial'`
//（沒有被改回 'sending'），同樣帶著有效的 activeAttemptId，只檢查
// status==='sending' 會漏掉這種真正在寄送中的 campaign。另外，過去這裡
// 曾經寫「理論上 sweepExpiredDeliveryAttempts 的排程會處理」——**這是
// 錯的，這個專案沒有任何 `onSchedule` 排程**：sweepExpiredDeliveryAttempts()
// 只會在既有的 sendPendingRecipients／retryCampaign 流程重新計算 totals
// 時才被呼叫（見 computeCampaignTotals 的說明），不會自己定時執行。一個
// 過期的 sending 收件人，如果剛好卡在一個沒有任何人再去 retryCampaign
// 的 campaign 裡，會永遠停在 sending，不會有任何自動化流程把它轉成
// delivery_unknown。
//
// 涉及 recipient／campaign fencing 邏輯（shared/campaignSend.ts 裡任何
// claim／begin／commit／finalize／markFailed／resolve 相關函式）的變更，
// 正式部署必須依照以下順序。步驟 2（部署前）與步驟 5（部署後）使用**完全
// 相同**的判斷標準，定義如下：
//
// 【淨空判斷標準】對每一份 campaign 文件：
//   (0) round 16 新增，round 17 修正（Finding 1）：若 status 已經是終止
//       狀態（completed／failed／needs_review，isTerminalCampaignStatus）
//       ——**只**跳過 (e) 的 setup-phase schema 驗證，**不**跳過
//       (a)(b)(c)(d)。round 16 版本這裡曾經整個短路直接判 SAFE，是錯的：
//       needs_review 仍然可以被 resolveDeliveryUnknown 操作
//      （acquireResolutionLeaseTx 明確允許對 needs_review 核發 resolution
//       租約），一個正在進行人工 resolution 的 needs_review campaign 會被
//       誤判成可以部署；completed／failed 理論上不該再有任何 active
//       lease／recipient，但不能假設一定不會，必須實際檢查——見
//       shared/campaignSend.ts 的 classifyCampaignForDrainAudit 說明。
//       跳過 (e) 的理由：這套 lease 機制第一次部署前建立的歷史 campaign
//       完全沒有 recipientsReady 欄位，(e) 的完整判斷式會把每一份缺少
//       這個欄位的舊文件都判成 INDETERMINATE，即使它早就已經
//       completed／failed——但 setup phase 這個概念對已經 terminal 的
//       campaign 本身沒有意義，只有這一項可以安全略過。
//   (a) 若 activeAttemptId 欄位存在（不論 status 是什麼值）：解析
//       activeLeaseExpiresAtMs（含舊格式 activeLeaseExpiresAt 相容讀取，
//       見 readFirstValidMs）。
//       - 無法解析（缺失／格式錯誤）→ INDETERMINATE：fail closed，視為
//         「可能仍在使用中」，不得部署，交給人工檢查這份文件的實際狀態
//        （可能是資料損毀，需要先修好，不能猜測）。
//       - 尚未過期 → ACTIVE：不得部署，等待它自然完成或過期。
//       - 已過期 → STALE：這個 campaign 目前沒有人合法持有處理租約，
//         但**還不能立刻視為淨空**，必須接著檢查 (c)。
//   (b) 若 resolutionLeaseAttemptId 欄位存在：套用跟 (a) 完全相同的判斷
//      （解析 resolutionLeaseExpiresAtMs，INDETERMINATE／ACTIVE／STALE
//       三種結果，處理方式相同）。
//   (c) 用 collection-group 查詢（或既有的管理工具）檢查這份 campaign 底下
//       的 recipients 子集合，找出 status 為 'claimed' 或 'sending' 的
//       文件：
//       - claimed 且租約已過期：SAFE——這代表 SMTP 根本還沒被呼叫過，
//         可以安全地被之後合法的 claim 重新認領，不是部署的阻礙。
//       - sending 且租約已過期：UNKNOWN——delivery 狀態不明，**不能**
//         直接假設可以重新寄送。這個專案沒有排程會自動把它轉成
//         delivery_unknown（見上面的說明）。⚠️ 絕對不要用 retryCampaign
//         當作「純粹校正狀態」的工具——retryCampaign 是完整的正常寄送
//         流程（會載入新聞稿／附件、建立並驗證 SMTP transporter、呼叫
//         sendPendingRecipients 認領並寄送 queued／failed／過期 claimed
//         的收件人），只是「順便」在收尾時內建呼叫
//         sweepExpiredDeliveryAttempts；呼叫它可能會真的寄出其他收件人
//         的信，違反 maintenance pause。正確做法是呼叫下面這支只校正
//         狀態、絕對不寄信的 admin-only callable：
//         `reconcileCampaignDeliveryStatus`（見該函式與
//         shared/campaignSend.ts 的 reconcileCampaignDelivery 說明；它
//         的依賴介面裡結構上就不存在任何 SMTP 相關能力，也不會認領
//         queued／failed／claimed 收件人）。呼叫成功後，過期的 sending
//         會被轉成 delivery_unknown，campaign 落在 needs_review，才能
//         視為這個 campaign 淨空——之後仍需要透過 resolveDeliveryUnknown
//         人工處理，不會自動消失。
//       - claimed／sending 且租約仍然有效：ACTIVE，不得部署。
//   (d) round 16 新增（Finding 2）：檢查 leaseGeneration——(a)(b) 只看
//       activeAttemptId／resolutionLeaseAttemptId 本身的過期與否，完全沒
//       檢查它們共用的 fencing generation 是否本身處於合法狀態。判斷式跟
//       shared/campaignSend.ts 的 classifyLeaseGenerationForDrainAudit
//       逐字相同：
//       - leaseGeneration 格式錯誤（不是合法的非負 safe integer）：
//         INDETERMINATE：fail closed，不論有沒有 owner。
//       - activeAttemptId 或 resolutionLeaseAttemptId 任一存在，但
//         leaseGeneration 缺失或是 0（baseline）：INDETERMINATE：這是
//         不可能的組合，任何一次成功 acquire 都會把它寫到 >=1。
//       - leaseGeneration 已經到達 Number.MAX_SAFE_INTEGER：round 18
//         修正（Finding 3）——不再無條件判成 EXHAUSTED。先套用
//         isGenerationExhaustionHarmless()（見 shared/campaignSend.ts）：
//         只有同時符合「status 是 completed 或 failed（不含
//         needs_review）」「processing／resolution 租約都是 absent（完全
//         沒有 owner）」「沒有任何 active／unknown／indeterminate 的收件
//         人」，才確定這份 campaign 未來不會再需要任何流程 acquire 它，
//         這種情況下折算成 SAFE（`leaseGeneration` 欄位本身仍誠實回報
//        'exhausted'，`leaseGenerationExhaustionHarmless` 回報 true，供
//         audit 輸出／人工複核）。任何一項不成立（尤其 needs_review——
//         可能還有 delivery_unknown 收件人需要 resolveDeliveryUnknown 的
//         resolution acquire）→ EXHAUSTED，繼續阻擋部署。這是一條可稽核、
//         以現有欄位計算出來的規則，不是操作員手動維護的 allowlist。
//         在正常使用下 MAX_SAFE_INTEGER 不可能被自然到達（需要幾千兆次
//         合法的 acquire），應該視為資料損毀或人為植入的測試資料。**絕對
//         不要**人工把 leaseGeneration 重設成較小的值——這會破壞 fencing
//         token「單調遞增」的核心不變量，可能讓一個曾經合法持有過舊
//         generation、但流程本身尚未真正結束的呼叫（例如卡在重試佇列
//         裡）在重設之後意外重新符合一個被重複使用的 generation 值，
//         重新取得已經失效的 fencing 身分——這正是這整套機制原本要防止
//         的事，見 audit-campaign-drain.mjs 印出的完整說明。若判定
//         EXHAUSTED 仍然阻擋部署（harmless 條件不成立），正確處理方式是
//         人工 escalation（不透過任何自動化工具）：先確認阻擋原因（哪個
//         owner／收件人訊號還在），若確認寄送工作尚未完成，改為建立一份
//         新的 campaign 文件處理剩餘收件人，不再對這份耗盡的文件寫入
//         任何東西。
//       - 其餘情況（沒有 owner 時 baseline 合法，或有 owner 時
//        （>=1 且未耗盡）：ok，不影響部署。
//   (e) round 15 新增，round 16 修正（Finding 1）：檢查是否還在「建立
//       收件人清單」的 setup 階段——campaign 剛建立時 recipientsReady 還是
//       false、也還沒有人取得處理租約，這段期間可能有舊 revision 的
//       createRecipientsForCampaign 仍在實際寫入 recipients 子集合，
//       (a)(b)(c) 三項全都看不到這個活動（沒有 activeAttemptId、也還沒
//       有任何 claimed／sending 的收件人文件）。判斷式跟
//       shared/campaignSend.ts 的 classifySetupPhaseForDrainAudit 逐字
//       相同（這兩處必須永遠一致，不能各自維護一份公式）：
//       - recipientsReady === true：not-setup-phase——不是 setup 階段，
//         交給 (a)(b)(c)(d) 判斷（不論 activeAttemptId 是否存在，這是
//         唯一合法允許 activeAttemptId 同時存在的狀態：setup 已完成、
//         目前正在被處理）。
//       - recipientsReady === false 且 activeAttemptId 是合法的非空字串：
//         INDETERMINATE：round 16 修正（Finding 1）——這是不可能的組合，
//         不能假設一定會被 (a) 的 processing lease 判斷擋住（那個租約
//         可能已經過期而變成 severity SAFE 的 STALE），必須在這裡直接
//         fail closed。round 15 版本這裡寫的是「activeAttemptId 存在就
//         直接 not-setup-phase」，是錯的，已經修正。
//       - recipientsReady 既不是 true 也不是 false（缺失／格式錯誤）：
//         INDETERMINATE：fail closed，**不論** activeAttemptId 是否
//         存在——round 16 修正（Finding 1）：round 15 版本會被
//         activeAttemptId 的存在攔在前面、完全不會走到這個檢查。
//       - activeAttemptId、createdByAttemptId 是否「合法存在」的定義：
//         必須是非空字串——數字、物件、空字串都不算合法存在（round 16
//         修正，Finding 1 項目 3）。
//       - status !== 'sending'：INDETERMINATE：fail closed（setup 階段
//         的 campaign 理應是 status:'sending'，不一致代表資料有問題，
//         不能假設是「setup 已完成」）。
//       - createdByAttemptId 不是合法的非空字串：INDETERMINATE：fail
//         closed（沒有這個欄位就無法判斷是哪個 revision 在建立這份
//         campaign，也就無法判斷它是否仍在合理時限內）。
//       - startedAtMs（含舊格式 startedAt 相容讀取）無法解析：
//         INDETERMINATE：fail closed。
//       - 距今未超過 RECIPIENTS_SETUP_STALE_MS：ACTIVE，不得部署——setup
//         很可能仍在進行中。
//       - 已超過 RECIPIENTS_SETUP_STALE_MS：UNKNOWN，**不得**視為
//         SAFE——只代表「setup 逾時了」，不代表沒有舊 revision 卡住還在
//         寫入；必須先透過 reclaimAbandonedSetupTx 認領或人工確認實際
//         狀態，才能繼續部署。
//
// 【稽核指令】對所有 campaign 套用【淨空判斷標準】，唯一推薦的指令
//（round 16 修正，Finding 6：不要直接執行 node scripts/audit-campaign-drain.mjs，
// 那樣容易忘記先手動 build 而用到過期的分類邏輯——這個 npm script 會自動
// 先 build）：
//
//   cd functions && npm run audit:drain -- --project <firebase-project-id>
//
// ============================================================================
// 【Bootstrap】round 16 新增（Finding 3）：第一次部署這整套 lease／
// reconciliation 機制時的特殊情況
// ============================================================================
//
// ⚠️ 這一段只在以下情況適用：production 尚未部署過任何一版包含
// reconcileCampaignDeliveryStatus／repairCampaignPressReleaseSync 這兩支
// admin-only callable 的程式碼（也就是本 PR 本身第一次要部署的那一刻）。
// 之後每一次的部署都直接跳到下面的【正式部署程序】即可，不需要再看這段。
//
// 問題本身：如果部署前的稽核（步驟 2）發現有 campaign 落在 UNKNOWN
//（sending 收件人的租約過期、delivery 狀態不明），淨空判斷標準要求先呼叫
// reconcileCampaignDeliveryStatus 校正——但這支 callable 正是這次要部署的
// 東西，還沒存在於 production；而 runbook 本身又明確禁止在還有非 SAFE
// campaign 時部署（步驟 2）。前端也還沒有任何呼叫這兩支 callable 的入口。
// 三者放在一起就是一個死結：沒有東西可以在不違反任一條規則的情況下把
// UNKNOWN 的 campaign 變成 SAFE。
//
// 解法：完全不透過 Cloud Functions 部署、也不透過 onCall HTTPS 介面，直接
// 用維運人員自己的 Firebase Admin 憑證，在本機／CI 執行環境呼叫跟
// production 完全相同的 shared/campaignSend.ts 協調函式——見新增的
// functions/scripts/ops-campaign-repair.mjs（跟 audit-campaign-drain.mjs
// 用同一招：import 編譯後的 functions/lib/campaignSend.generated.js，不是
// 另外複製一份邏輯）。這條路徑完全不需要部署任何 Cloud Function，所以不
// 存在「先有雞還是先有蛋」的問題。
//
// Bootstrap 步驟：
// B1. 確認本機／CI 執行環境已經有權限存取目標 Firebase project 的
//     Firestore（`gcloud auth application-default login`，或設定
//     `GOOGLE_APPLICATION_CREDENTIALS` 指向一組具備該專案 Firestore 存取
//     權限的 service account 金鑰）——這一步不是這個 PR 的一部分，是每個
//     維運人員既有的本機設定，跟平常執行 audit-campaign-drain.mjs 需要的
//     權限完全相同。
// B2. `cd functions && npm run build` 確保編譯輸出是最新的。
// B3. `npm run audit:drain -- --project <id>` 找出所有非 SAFE 的
//     campaign，記下每一份的 campaignId 與分類。
// B4. 對每一份分類是 UNKNOWN 的 campaign（sending 收件人租約過期，需要
//     校正），依序執行：
//       npm run ops:campaign-repair -- --project <id> --campaign <campaignId> --action reconcile
//    （不加 --confirm 會先印出 dry-run 預覽——round 17 修正（Finding 6）：
//     這個預覽現在會實際查詢收件人、套用跟 audit:drain 完全相同的
//     classifyCampaignForDrainAudit() 分類規則，並用 decideCampaignStatus()
//     算出推估的最終狀態；確認沒問題後加上
//    `--confirm <同一個 campaignId>` 重新執行才會真的寫入——`--confirm`
//     必須帶上跟 `--campaign` 完全相同的值，避免誤操作到錯誤的
//     campaign。）這條路徑呼叫的
//     reconcileCampaignDelivery()／其依賴介面結構上不存在任何 SMTP 相關
//     能力，不會、也不能寄出任何郵件，只會把過期的 sending 轉成
//     delivery_unknown、重新計算 totals、收尾（可能落在 needs_review，
//     那是正常結果，仍需要之後的人工 delivery_unknown 處理）。
// B5. round 17 修正、round 18 修正（Finding 3）：對每一份分類是
//     EXHAUSTED 的 campaign（leaseGeneration 已達 Number.MAX_SAFE_INTEGER，
//     在正常使用下不可能自然發生，應視為資料損毀或測試資料）——先確認
//     它是不是已經被 classifyCampaignForDrainAudit() 自動判定為「exhausted
//     但無害」（`leaseGenerationExhaustionHarmless:true`，見上方 (d) 的
//     說明）：這種情況下分類本身就已經是 SAFE，不會出現在非 SAFE 清單裡，
//     不需要任何動作，只是稽核輸出的【已知例外】區塊會列出它供留存記錄。
//     如果它仍然被分類成 EXHAUSTED（代表 harmless 條件不成立——status 是
//     needs_review，或仍有 owner／active／unknown／indeterminate 收件人）
//     ——**不要**重設 leaseGeneration 欄位，不論用什麼工具，也不論看起來
//     多安全。這不是 ops-campaign-repair.mjs 的功能範圍：那支工具結構上
//     不提供、也永遠不會提供「直接覆寫 leaseGeneration」的操作，因為沒有
//     辦法在分散式環境下完整證明「不會有任何卡在重試佇列裡、尚未真正
//     結束的舊 invocation 之後重新符合被重複使用的 generation 值」——這
//     正是 generation 機制本身要防止的事，重設等於繞過它自己。
//     正確處理方式（人工 escalation，不透過任何自動化工具）：先查稽核
//     輸出裡這份 campaign 的 processing／resolution lease／收件人分類，
//     確認阻擋原因是什麼；若確認寄送工作尚未完成，建立一份新的 campaign
//     文件處理剩餘收件人（新文件的 leaseGeneration 從全新的 baseline
//     開始，不會繼承已經耗盡的計數），並且不再對耗盡的那份文件做任何
//     寫入。
// B6. 對每一份 status 已經是終止狀態、但需要補新聞稿同步的 campaign
//    （通常是部署前用非原子方式寫入、恰好卡在中間態的既有資料——見下面
//     Finding 4 的說明），執行：
//       npm run ops:campaign-repair -- --project <id> --campaign <campaignId> --action repair-press-release
//    （同樣預設 dry-run，需要 `--confirm <同一個 campaignId>` 才會真的
//     寫入。）
// B7. 重新執行 `npm run audit:drain -- --project <id>`，確認全部 campaign
//     都是 SAFE。
// B8. 全部 SAFE 之後，才進入下面的【正式部署程序】步驟 1——這時候才是
//     第一次真正部署 reconcileCampaignDeliveryStatus／
//     repairCampaignPressReleaseSync／新版 sendCampaign／retryCampaign。
//
// ⚠️ 這條 Bootstrap 路徑本身不需要暫停前端——它完全不會跟任何正在執行中
// 的 sendCampaign／retryCampaign invocation 競爭（reconcileCampaignDelivery
// 自己會先透過 acquireCampaignLeaseTx 取得處理租約，跟任何真正在寄送中的
// invocation 互斥；如果租約被別人持有，會直接回報 held-by-other，不會
// 強行接手）。但如果 B3 的稽核結果顯示有 campaign 是 ACTIVE（租約仍然
// 有效），仍然必須照下面步驟 1 暫停、等待它自然完成或過期，不能用
// ops-campaign-repair.mjs 或任何其他工具強行介入一個真正還在合法進行中
// 的寄送。
//
// ============================================================================
// 【正式部署程序】每一次涉及 recipient／campaign fencing 邏輯的變更都適用
// ============================================================================
//
// 1. 暫停視窗：round 20 修正（Finding 2，P1）——**只暫停前端不夠**。前端
//    按鈕鎖住只是防止「正常操作流程」發出新請求，不是伺服器端的強制
//    邊界：任何有權限的使用者仍然可以直接呼叫 sendCampaign／
//    retryCampaign／resolveDeliveryUnknown 這些 callable（例如自己重放一
//    個舊的 request、用 curl／Postman 之類的工具直接打 callable
//    endpoint），一個在暫停前就已經送出、仍在飛行中的 request 也可能在
//    稽核跑完「之後」才真正拿到 lease——稽核工具本身的一致性快照協定
//   （見 scripts/audit-scan.mjs）只能證明「掃描當下」campaign 是穩定的，
//    無法、也不試圖證明「稽核跑完到真正執行 firebase deploy 之間」沒有
//    新的請求進來。正確做法是同時具備：
//    (a) 前端暫停新的正式／測試發送與人工 delivery_unknown 處理（維持
//        原有的使用者體驗，避免誤觸）；
//    (b) 伺服器端強制的維護旗標——這些 callable 一開始就先檢查一個獨立的
//        維護狀態文件／設定（不是靠 campaign 本身的欄位），維護模式開啟時
//        直接拒絕請求，不進入任何 acquire lease 的邏輯。這道檢查必須在
//        admin SDK／Cloud Functions 這一層執行，不能只放在前端，才能真正
//        擋下「有權限但繞過前端」的呼叫與飛行中的舊 request。
//    本輪（round 20）只新增稽核工具本身「掃描期間資料變動即 fail closed」
//    的偵測能力（見下方步驟 2），**沒有**實作 (b) 的伺服器端維護旗標——
//    這是目前程式碼裡仍然缺少、但 runbook 明確要求補上的部分，見本輪報告
//    第 9 節「未解決風險」。在補上 (b) 之前，這段暫停視窗的保證僅止於
//   「正常操作流程不會發出新請求」，不是「伺服器保證沒有任何請求會被接受」。
// 2. 確認淨空：執行上面的【稽核指令】。round 20 修正（Finding 2）：稽核
//    工具本身現在會對每一份 campaign 用 read-only transaction 同時讀
//    campaign 文件與其 recipients 查詢（保證兩者是同一個時間點的快照），
//    並在 transaction 前後各補一次輕量的 fencing 欄位重讀，確認掃描期間
//    沒有發生 lease acquire；掃描前後各查一次完整 campaign id 清單，偵測
//    幽靈 campaign。任何不穩定訊號都會讓整輪掃描自動重試（預設 3 次），
//    重試預算用盡仍不穩定時，稽核工具會直接 exit code 1、**不會**印出
//    任何「SAFE」結論——這種情況代表資料庫目前持續在變動，必須先排除
//    持續寫入的來源（通常代表步驟 1 的暫停視窗還不完整），不能重跑幾次
//    稽核工具就當作「大概率沒問題」。
//    任何一份文件落在 INDETERMINATE／ACTIVE／UNKNOWN／EXHAUSTED，都不得
//    部署；
//    - ACTIVE：等待它自然完成或過期，不強行介入。
//    - UNKNOWN：呼叫 reconcileCampaignDeliveryStatus（production 已部署
//      過的情況——這是一般情況）；如果這是第一次部署（production 還沒有
//      這支 callable），見上面的【Bootstrap】章節。⚠️ 絕對不要用
//      retryCampaign 校正狀態——retryCampaign 是完整的正常寄送流程，見
//      (c) 的說明，用它會真的寄出其他收件人的信，違反暫停視窗。
//    - EXHAUSTED：round 18 修正（Finding 3）——先確認 harmless 條件是否
//      成立（見上面 (d)）；不成立才需要人工 escalation（絕對不要重設
//      leaseGeneration，見 Bootstrap B5 的完整說明）。
//    - INDETERMINATE：人工檢查該份文件的實際資料，找出不一致的根因後
//      再決定下一步，不能猜測。round 20 新增（Finding 1）：`status`
//      欄位本身不是 sending／partial／completed／failed／needs_review
//      五個已知合法值之一時，稽核輸出會明確印出
//     「campaign.status missing or invalid」——這種情況下不要嘗試用任何
//      既有工具「猜」這份文件應該是什麼狀態，必須先確認資料是怎麼變成
//      這樣的（程式邏輯寫入的，還是人工／其他工具誤寫的）。
//    重複執行【稽核指令】直到全部 campaign 都是 SAFE 為止。
// 3. 部署 functions（`firebase deploy --only functions`）。**不要**同時
//    部署 functions 與開放前端操作——前端在這個視窗內應該仍然維持暫停
//    狀態（步驟 1），即使 functions 已經部署完成。
// 4. Drain 等待：部署完成後，至少等待 CAMPAIGN_LEASE_MS（660 秒／11
//    分鐘＝CAMPAIGN_FUNCTION_TIMEOUT_MS 540 秒＋120 秒緩衝）才視為所有舊
//    revision 的 in-flight invocation 都已經結束或被強制終止。
// 5. 驗證淨空：再次執行【稽核指令】（跟步驟 2 完全相同的判斷方式）——這是
//    部署後的第一次真正驗證，不能只是「看起來沒問題」就跳過。
// 6. 才重新開放前端操作、恢復正式／測試發送與人工 resolution。
// 7. round 16 新增（Finding 4，選用的收尾清理）：如果 Bootstrap 或這次
//    部署之前累積了任何「campaign 已終止但新聞稿未同步」的既有資料
//   （通常在第一次啟用 finalizeCampaignWithPressReleaseTx 之前才可能發生
//    ——見該函式的說明，這一輪起 campaign finalize 與新聞稿同步已經是
//    同一個 transaction，不會再產生新的不同步資料），可以用
//    repairCampaignPressReleaseSync（部署後）或 ops-campaign-repair.mjs
//   （不需要等部署）逐一修復；這一步不影響淨空判斷，可以在方便的時間點
//    另外處理，不需要卡在這次部署視窗內完成。
//
// 這個程序沒有辦法被自動化成一個部署腳本內的單一步驟，因為它本質上需要
// 「等待外部系統狀態」與「人工確認」——刻意保留為文件化的操作程序，而不是
// 假裝可以用程式碼本身完全消除風險。

interface CampaignTotals {
  recipients: number
  sent: number
  failed: number
  exhausted: number
  /** sendMail 逾時或「已接受但寫回失敗」，delivery 是否送達無法確認的人數。 */
  deliveryUnknown: number
}

/**
 * 把 Admin SDK 的 transaction + 文件參照包成 shared/campaignSend.ts 認得的
 * DocTx 形狀，讓下面所有 *Tx 協調函式呼叫的都是同一份跟測試共用的邏輯，
 * 而不是在這裡另外手刻一份看起來很像、但可能會漂移的版本。
 */
function docTx(
  tx: FirebaseFirestore.Transaction,
  ref: FirebaseFirestore.DocumentReference,
): DocTx {
  return {
    async get(): Promise<DocSnapshotLike> {
      const snap = await tx.get(ref)
      return {
        exists: snap.exists,
        data: snap.exists ? (snap.data() as Record<string, unknown>) : undefined,
      }
    },
    set(data) {
      tx.set(ref, data)
    },
    update(data) {
      tx.update(ref, data)
    },
  }
}

/**
 * 嘗試把某個 campaign 的「處理租約」搶到自己的 attemptId 上。
 *
 * 目的：sendCampaign 與 retryCampaign 都可能因為使用者重複點擊、或多個
 * 分頁／多人同時對同一個 campaign 操作而併發呼叫。就算每位收件人已經有
 * 自己的認領機制，兩個 invocation 同時跑完整個處理流程仍然可能在最後
 * finalizeCampaign 時互相覆蓋對方的統計結果（見 finalizeCampaignTx 的
 * 說明）。這裡在「真正開始處理收件人（包含載入附件、驗證 SMTP）之前」，
 * 先確保自己是唯一持有租約的 invocation；租約還沒過期又不是自己持有，
 * 就直接放棄這次呼叫，不去動任何收件人，也不改動 campaign 的狀態
 * ——沒有拿到租約就不是任何東西的擁有者，沒有資格宣稱任何失敗。
 */
async function acquireCampaignLease(
  campaignRef: FirebaseFirestore.DocumentReference,
  attemptId: string,
): Promise<AcquireLeaseDecision> {
  return db.runTransaction((tx) =>
    acquireCampaignLeaseTx(
      docTx(tx, campaignRef),
      attemptId,
      Date.now(),
      CAMPAIGN_LEASE_MS,
      // round 10 新增（Finding 2）：acquired 時順手清掉已經證明失效的
      // resolution 租約殘留欄位——見 acquireCampaignLeaseTx 的說明，只有
      // 判定 acquired 才會呼叫這個 callback，這代表 isCampaignLeaseHeldByOther()
      // 剛剛才確認過 resolution 租約不是仍然有效持有中。
      () => ({
        updatedAt: FieldValue.serverTimestamp(),
        resolutionLeaseAttemptId: FieldValue.delete(),
        resolutionLeaseExpiresAtMs: FieldValue.delete(),
      }),
    ),
  )
}

/**
 * 依寄送結果收尾：更新 campaign 狀態，並釋放處理租約，任何情況都不會停在
 * sending，也不會讓已經完成的 campaign 繼續佔著租約擋下下一次「繼續寄送」。
 *
 * - nonTerminalCount > 0（還有 queued／failed／租用中的人沒到終止狀態）
 *   → partial，可以呼叫 retryCampaign 接著寄
 * - 全部到達終止狀態、通通沒成功 → failed
 * - 其餘（至少一封成功，或原本就沒有收件人）→ completed
 *
 * 只有仍持有 campaign 租約（activeAttemptId 是自己、租約未過期、且
 * fencing generation 相符——見 shared/campaignSend.ts 的
 * decideFinalizeCampaign／readLeaseGeneration 說明，round 10 起不再只看
 * activeAttemptId 字串）的 invocation 才能寫入這次的結果；寫入時一併刪掉
 * activeAttemptId／activeLeaseExpiresAtMs 釋放租約，改記到 lastAttemptId
 * 留作診斷（不隨租約一起消失）。若租約已經被別人取代，回傳 'superseded'，
 * 呼叫端不應該再依這次的結果做任何
 * 後續動作（例如標記新聞稿已發送），也不會、不能去動別人持有的租約。
 *
 * round 16 修正（Finding 4）：新聞稿的 status／sentAt 同步不再是 finalize
 * 成功之後「另外」的一次獨立寫入——見 shared/campaignSend.ts 的
 * finalizeCampaignWithPressReleaseTx，兩者現在是同一個 transaction，
 * campaign 是否真的變成 terminal 與新聞稿是否同步不會再脫鉤。isTest／
 * pressReleaseId 都是從 campaign 文件本身讀出來的（不是呼叫端傳入的
 * request 參數），確保跟文件的真實狀態一致。
 */
async function finalizeCampaign(
  campaignRef: FirebaseFirestore.DocumentReference,
  attemptId: string,
  generation: number,
  totals: CampaignTotals,
  nonTerminalCount: number,
  /**
   * 選填的診斷訊息，寫進 lastError（例如「中斷後用真實狀態重新收尾」的
   * 原因）。只有 decision 真的有 patch 要寫（也就是確認仍持有租約）時才會
   * 一起寫入，不會在 superseded／not-found 時憑空產生欄位。
   */
  diagnosticMessage?: string,
): Promise<CampaignFinalizeStatus> {
  const decision: FinalizeCampaignWithPressReleaseDecision = await db.runTransaction((tx) =>
    finalizeCampaignWithPressReleaseTx(
      docTx(tx, campaignRef),
      (pressReleaseId) => docTx(tx, db.collection('pressReleases').doc(pressReleaseId)),
      attemptId,
      generation,
      Date.now(),
      totals,
      nonTerminalCount,
      (d) => ({
        activeAttemptId: FieldValue.delete(),
        activeLeaseExpiresAtMs: FieldValue.delete(),
        updatedAt: FieldValue.serverTimestamp(),
        ...(d.outcome === 'completed' || d.outcome === 'failed' || d.outcome === 'needs_review'
          ? { completedAt: FieldValue.serverTimestamp() }
          : {}),
        ...(diagnosticMessage ? { lastError: diagnosticMessage } : {}),
      }),
      // sentAt 供「發送排程」看板顯示實際發送時間，對照計畫日期
      () => ({ status: 'sent', sentAt: FieldValue.serverTimestamp() }),
      // round 18 新增（Finding 1）：blocked 時的安全釋放欄位——跟上面
      // releaseLeaseFields 的租約釋放部分完全一樣，但不帶 completedAt／
      // lastError（campaign 沒有變成 terminal，不該有這些欄位）。
      () => ({
        activeAttemptId: FieldValue.delete(),
        activeLeaseExpiresAtMs: FieldValue.delete(),
        updatedAt: FieldValue.serverTimestamp(),
      }),
    ),
  )
  if (decision.outcome === 'blocked') {
    // round 18 修正（Finding 1）：campaign 完全沒有變成 terminal——只是
    // 安全釋放了這次的處理租約（如果仍然合法持有的話）。呼叫端
    //（sendCampaign／retryCampaign）必須把這個結果轉譯成明確的
    // failed-precondition／internal 錯誤，不能假裝寄送已經完成。
    logger.error('campaign finalize：新聞稿同步中繼資料無法安全判斷，campaign 保持非終止狀態，已安全釋放租約', {
      path: campaignRef.path,
      attemptId,
      reason: decision.reason,
      leaseReleased: decision.releaseDecision.outcome === 'released',
    })
    return decision.reason === 'invalid-campaign-metadata'
      ? 'blocked-invalid-campaign-metadata'
      : 'blocked-press-release-not-found'
  }
  if (decision.finalize.outcome === 'superseded') {
    logger.warn('campaign 租約已被其他 invocation 取代，放棄寫入最終狀態', {
      path: campaignRef.path,
      attemptId,
    })
  }
  return decision.finalize.outcome
}

/**
 * 任何未預期的例外都要讓 campaign 落在 failed，不能永遠停在 sending。
 *
 * ownership 一律要明確表明身分（setup 或 lease）並帶著自己的 attemptId——
 * 不再接受「不驗證身分、無條件覆蓋」的旁路。這是為了防止一個沒有取得
 * 處理租約的 invocation（例如 SMTP 驗證失敗得比別人快的那個），把另一個
 * 正在正常處理中的 campaign 標成失敗。kind:'lease' 失敗時一併釋放租約
 * （這個階段一定是先前已經成功 acquireCampaignLease 過，才會走到需要
 * 標記失敗的地方），kind:'setup' 沒有租約可釋放。
 */
async function markCampaignFailed(
  campaignRef: FirebaseFirestore.DocumentReference,
  ownership: FailureOwnership,
  err: unknown,
) {
  const message = (err as Error)?.message ?? '未知錯誤'
  try {
    const decision = await db.runTransaction((tx) =>
      markCampaignFailedTx(docTx(tx, campaignRef), ownership, Date.now(), message, () => ({
        updatedAt: FieldValue.serverTimestamp(),
        completedAt: FieldValue.serverTimestamp(),
        ...(ownership.kind === 'lease'
          ? {
              activeAttemptId: FieldValue.delete(),
              activeLeaseExpiresAtMs: FieldValue.delete(),
            }
          : {}),
      })),
    )
    if (!decision.applied) {
      logger.warn('campaign 擁有權已改變，放棄標記失敗', {
        path: campaignRef.path,
        ownership,
      })
    }
  } catch (updateErr) {
    // 連這次更新都失敗就只能記 log；campaign 可能停在 sending，
    // 但 lastError 至少有機會在下次成功的更新時被看到。
    logger.error('標記 campaign 失敗狀態時也失敗了', { updateErr })
  }
}

/**
 * 回收「建立收件人清單過程中斷」的幽靈狀態，不需要任何 attemptId 身分
 * （setup owner 已經死了，不會有人能證明自己是它），安全性來自在同一個
 * transaction 裡重新驗證一次「現在」是否仍然符合「建立中且中斷太久」，
 * 而不是相信呼叫端稍早讀到的、可能已經過期的判斷。
 *
 * 回傳真正的 transaction outcome（'marked-failed' | 'not-abandoned' |
 * 'indeterminate' | 'not-found'）——呼叫端必須依真實結果回報，不能假設
 * 呼叫這支就等於「已經標記失敗」：呼叫前的判斷（例如 resolveCampaignResume）
 * 跟這個 transaction 真正執行的當下之間有時間差，原本的 setup owner 有
 * 可能剛好就在這中間把 recipientsReady 寫完了、或已經有人取得處理租約
 *（都會是 'not-abandoned'）；'indeterminate' 則是 startedAt 新舊欄位都
 * 無法解析出有效時間戳，無法判斷是否真的逾時（見 decideReclaimAbandonedSetup
 * 的說明），需要人工檢查 Firestore 資料，不能自動判定。
 */
async function reclaimAbandonedSetup(
  campaignRef: FirebaseFirestore.DocumentReference,
  errorMessage: string,
): Promise<'marked-failed' | 'not-abandoned' | 'indeterminate' | 'not-found'> {
  const decision = await db.runTransaction((tx) =>
    reclaimAbandonedSetupTx(
      docTx(tx, campaignRef),
      Date.now(),
      RECIPIENTS_SETUP_STALE_MS,
      errorMessage,
      () => ({
        updatedAt: FieldValue.serverTimestamp(),
        completedAt: FieldValue.serverTimestamp(),
      }),
    ),
  )
  if (decision.outcome !== 'marked-failed') {
    logger.info('回收幽靈 campaign 失敗（可能已經被其他請求處理掉了，或無法自動判斷）', {
      path: campaignRef.path,
      outcome: decision.outcome,
    })
  }
  return decision.outcome
}

/**
 * 呼叫 reclaimAbandonedSetup() 之後，依真實的 transaction outcome 決定要
 * 拋出什麼錯誤——不能假設呼叫前讀到的「已經中斷太久」判斷，在 transaction
 * 真正執行的當下依然成立。這支函式一定會拋出，用在 sendCampaign 的兩個
 * 「輸入的 idempotencyKey 對應到一個幽靈 campaign」情境：不管哪種
 * outcome，這次呼叫本身都沒有寄出任何東西，不會有正常的回傳值。
 */
async function throwForAbandonedReclaim(
  campaignRef: FirebaseFirestore.DocumentReference,
): Promise<never> {
  const outcome = await reclaimAbandonedSetup(
    campaignRef,
    '建立收件人清單的過程中斷（可能是逾時或崩潰）',
  )
  if (outcome === 'marked-failed') {
    throw new HttpsError(
      'failed-precondition',
      '上一次嘗試在準備收件人清單時中斷，這筆發送已標記為失敗，請重新整理頁面再次發送。',
    )
  }
  if (outcome === 'not-found') {
    throw new HttpsError('not-found', '找不到這筆發送紀錄。')
  }
  if (outcome === 'indeterminate') {
    throw new HttpsError(
      'failed-precondition',
      '這筆發送的建立時間資料異常，無法自動判斷是否已經中斷，請聯絡工程人員檢查 Firestore 資料。',
    )
  }
  // not-abandoned：setup owner 其實還活著（剛好在這之間完成了
  // recipientsReady），或狀態已經被其他請求改變——不能謊稱已經標記失敗。
  throw new HttpsError(
    'unavailable',
    '這次發送的狀態剛剛有更新，請重新整理頁面再試一次。',
  )
}

/**
 * round 8 新增（Finding 4）：`resolveCampaignResume()` 判定
 * `kind:'inconsistent'`——recipientsReady 還是 false，但 campaign 文件上
 * 已經有 activeAttemptId，違反了「setup 階段不該有處理租約」的不變量。
 * 跟 indeterminate 用同樣的處理方式：不猜測、不嘗試自動修正，直接拒絕並
 * 要求人工檢查資料，因為我們沒辦法安全判斷這到底是「另一個 invocation
 * 已經合法跳過 setup、正在正常處理中」還是「資料本身已經壞掉」。
 */
function throwInconsistentRecipientsSetup(): never {
  throw new HttpsError(
    'failed-precondition',
    '這筆發送的狀態資料不一致（收件人清單尚未就緒，但已有處理中的 attemptId），請聯絡工程人員檢查 Firestore 資料，不建議自動重試。',
  )
}

/**
 * 寄送一個 campaign 底下所有還沒到達終止狀態（sent／exhausted／
 * delivery_unknown）的收件人。sendCampaign（第一次建立）與 retryCampaign
 *（接續未完成的）共用同一份邏輯 —— 兩者的差異只在於「要不要先建立收件人
 * 紀錄」，實際寄送的規則必須一致，否則兩條路徑各自處理容易產生「這裡防過
 * 的競態那裡沒防到」的落差。
 *
 * round 9 修正（Finding 5）：單一收件人「認領 → 進入 delivery attempt →
 * 呼叫 SMTP → 寫回對應結果」這整段控制流程已經抽到
 * shared/campaignSend.ts 的 processOneRecipient()，production 與測試呼叫
 * 的是同一份函式——round 8 的報告承認這段迴圈本身從未被直接測試過，
 * round 9 的 Finding 1（begin 缺少 lease 驗證）正是在這段沒被直接測試過
 * 的控制流程裡發生的。這裡只負責選批（selectRecipientsToProcess）、把
 * Admin SDK／Nodemailer 的真實實作接成 processOneRecipient 需要的 deps，
 * 以及批次層級的控制（逾時後提前停批）。
 *
 * 一次最多實際處理 SEND_BATCH_LIMIT 位，其餘留在原本的狀態；回傳的
 * nonTerminalCount 是「寄送完成後，重新查一次目前還有幾位沒到終止狀態」，
 * 用來決定 campaign 最終狀態，跟選批時的 remainingAfterBatchLimit
 * 是兩個不同的數字（見 shared/campaignSend.ts 的說明）。delivery_unknown
 * 不算在 nonTerminalCount 裡（它沒有自動化工作可做），但會單獨計入
 * totals.deliveryUnknown，讓 campaign 最終狀態可能落在 needs_review。
 */
async function sendPendingRecipients(opts: {
  campaignRef: FirebaseFirestore.DocumentReference
  attemptId: string
  generation: number
  press: CampaignPress
  emailSettings: CampaignEmailSettings
  settings: SmtpSettings
  transporter: nodemailer.Transporter
  attachments: Awaited<ReturnType<typeof loadAttachments>>
  isTest: boolean
}): Promise<{ totals: CampaignTotals; nonTerminalCount: number }> {
  const beforeSnap = await opts.campaignRef.collection('recipients').get()
  // 純決策邏輯（誰要處理、上限怎麼切、lease 是否過期）抽在
  // selectRecipientsToProcess，這裡只負責照著清單實際去做。
  const { toProcess: toProcessIds } = selectRecipientsToProcess(
    beforeSnap.docs.map((d) => {
      const data = d.data() as RecipientDoc
      return {
        id: d.id,
        status: data.status,
        // 相容讀取：舊文件的租約是 Timestamp 型別的 leaseExpiresAt。
        leaseExpiresAtMs: readFirstValidMs(data.leaseExpiresAtMs, data.leaseExpiresAt),
        attemptCount: data.attemptCount ?? 0,
      }
    }),
    SEND_BATCH_LIMIT,
    Date.now(),
  )
  const byId = new Map(beforeSnap.docs.map((d) => [d.id, d]))
  const toProcess = toProcessIds
    .map((id) => byId.get(id))
    .filter((d): d is FirebaseFirestore.QueryDocumentSnapshot => !!d)

  // 一旦 sendMail 觸發 wall-clock 逾時，底層連線池的狀態就不再可信
  //（見 sendMailWithWallClockDeadline 的說明：close() 不保證真的中止傳輸
  // 中的訊息）——停止這一批剩餘的收件人，交給下一次 retryCampaign 用
  // 全新的 transporter 接續，不要在一個狀態不可信的連線上繼續嘗試。
  let stopBatchEarly = false

  for (const recDoc of toProcess) {
    if (stopBatchEarly) break

    const outcome = await processOneRecipient<nodemailer.SendMailOptions>({
      // round 11 修正（Finding 1）：claim 現在需要同時讀 recipient 與
      // campaign 兩份文件——雖然還沒呼叫 SMTP，但 claim 仍會改變
      // resolveDeliveryUnknown 正在保護的 authoritative recipient
      // distribution，見 shared/campaignSend.ts 的 decideRecipientClaim 說明。
      // round 12 修正（Finding 2）：claim 階段不再寫 lastAttemptAt——它跟
      // attemptCount／deliveryStartedAtMs 一樣，代表「真正跨過 SMTP 前
      // 最後閘門」的時間，claim 只是搶下這位收件人、還沒有這個保證，見
      // decideBeginDeliveryAttempt 的說明。
      claim: () =>
        db.runTransaction((tx) =>
          claimRecipientTx(
            docTx(tx, recDoc.ref),
            docTx(tx, opts.campaignRef),
            opts.attemptId,
            opts.generation,
            Date.now(),
            RECIPIENT_LEASE_MS,
          ),
        ),
      // round 9 新增（Finding 1）：claimed → sending 這一步現在同時驗證
      // recipient claimed lease 與 campaign 處理租約仍然有效、都還是自己
      // 持有，才允許往下呼叫 sendMail——見 shared/campaignSend.ts 的
      // decideBeginDeliveryAttempt 說明。round 10 新增：一併驗證 fencing
      // generation（見該函式的說明）。round 12 修正（Finding 2）：
      // lastAttemptAt 移到這裡才寫，跟 attemptCount／deliveryStartedAtMs
      // 用同一個時間點，三者語意一致。
      beginDelivery: () =>
        db.runTransaction((tx) =>
          beginDeliveryAttemptTx(
            docTx(tx, recDoc.ref),
            docTx(tx, opts.campaignRef),
            opts.attemptId,
            opts.generation,
            Date.now(),
            RECIPIENT_LEASE_MS,
            () => ({ lastAttemptAt: FieldValue.serverTimestamp() }),
          ),
        ),
      buildMailOptions: (claimedData) => {
        const r = claimedData as unknown as RecipientDoc
        const version = opts.press.versions[r.language]
        const templateInput = {
          subject: version.subject ?? '',
          bodyText: version.bodyText ?? '',
          heroImageUrl: version.heroImage?.url,
          recipientName: r.name,
          language: r.language,
          releaseDate: opts.press.releaseDate,
          logoUrl: opts.emailSettings.logoUrl,
          contact: opts.emailSettings.contacts?.[r.language],
          about: opts.emailSettings.about?.[r.language]?.text,
          aboutLink: opts.emailSettings.about?.[r.language]?.link,
        }
        return {
          to: r.name ? `"${r.name.replace(/"/g, '')}" <${r.email}>` : r.email,
          from: `"${SENDER_NAME_BY_LANG[r.language]}" <${opts.settings.fromEmail}>`,
          replyTo: opts.settings.replyTo,
          // 郵件主旨標頭不能含換行，主旨的手動斷行只在信件內文/Word/PDF 呈現
          subject: `${opts.isTest ? '[測試] ' : ''}${subjectSingleLine(version.subject ?? '')}`,
          // 測試信加上標頭，萬一誤轉寄也看得出不是正式發稿
          headers: opts.isTest ? { 'X-Press-Center-Test': 'true' } : undefined,
          text: renderEmailText(templateInput),
          html: renderEmailHtml(templateInput),
          attachments: opts.attachments,
        }
      },
      // sendMailWithWallClockDeadline 只是讓我們停止等待，不是 sendMail
      // 本身的硬性中止，也不保證不會跟接手的下一個 invocation 重疊——見
      // shared/campaignSend.ts 裡 SMTP_SEND_WALL_CLOCK_TIMEOUT_MS 的說明。
      sendMail: (mailOptions) =>
        sendMailWithWallClockDeadline(
          opts.transporter,
          mailOptions,
          SMTP_SEND_WALL_CLOCK_TIMEOUT_MS,
        ),
      // round 10 修正（Finding 1）：commitRecipientResultTx 現在需要同時
      // 讀 recipient 與 campaign 兩份文件，做完整的 fencing 驗證（status
      // 仍是 sending、attemptId 相符、兩層 lease 都未過期、generation 相符
      // ——見 decideCommitRecipientResult 的完整說明），不再只驗證
      // attemptId 字串。
      commitSent: () =>
        db.runTransaction((tx) =>
          commitRecipientResultTx(
            docTx(tx, recDoc.ref),
            docTx(tx, opts.campaignRef),
            opts.attemptId,
            opts.generation,
            Date.now(),
            { status: 'sent' },
          ),
        ),
      commitDeliveryUnknown: async (message) => {
        try {
          return await db.runTransaction((tx) =>
            commitRecipientResultTx(
              docTx(tx, recDoc.ref),
              docTx(tx, opts.campaignRef),
              opts.attemptId,
              opts.generation,
              Date.now(),
              { status: 'delivery_unknown', lastError: message },
            ),
          )
        } catch (err) {
          // 連補救寫入都失敗——收件人可能停在 sending，直到租約過期才會被
          // sweepExpiredDeliveryAttempts() 回收。這是殘留風險，只能記錄，
          // 不能假裝已經處理好，也不能讓這個失敗變成另一個要處理的例外
          // ——這一批本來就已經要停止了。
          logger.error(
            '補救寫入 delivery_unknown 也失敗，收件人狀態可能停在 sending 直到租約過期',
            { path: recDoc.ref.path, attemptId: opts.attemptId, err },
          )
          return { applied: false }
        }
      },
      commitFailedOrExhausted: (status, detail) =>
        db.runTransaction((tx) =>
          commitRecipientResultTx(
            docTx(tx, recDoc.ref),
            docTx(tx, opts.campaignRef),
            opts.attemptId,
            opts.generation,
            Date.now(),
            { status, lastError: detail },
          ),
        ),
      maxAttempts: MAX_RECIPIENT_ATTEMPTS,
      sleep,
      logWarn: (message, meta) =>
        logger.warn(message, { path: recDoc.ref.path, attemptId: opts.attemptId, ...meta }),
      logError: (message, meta) =>
        logger.error(message, { path: recDoc.ref.path, attemptId: opts.attemptId, ...meta }),
    })

    if (outcome.kind === 'timeout') {
      logger.warn(
        '本批提前結束；delivery_unknown 的收件人不會被一般 retryCampaign 自動認領，需要人工檢查',
        { campaignPath: opts.campaignRef.path },
      )
      stopBatchEarly = true
    }
  }

  // 處理完後重新查一次算總數，而不是自己累計 ——
  // 這樣不論是全新寄送還是接續之前的進度，統計永遠反映資料庫的真實狀態。
  return computeCampaignTotals(opts.campaignRef, opts.attemptId, opts.generation)
}

/**
 * 把已經過期的 delivery-attempted（'sending'）收件人原子轉成
 * delivery_unknown——見 shared/campaignSend.ts 的 RecipientStatus／
 * isRecipientClaimable／reclaimExpiredDeliveryAttemptTx 的說明：一旦進入
 * 'sending' 就代表 SMTP 可能已經開始，租約過期不代表可以像 'claimed' 一樣
 * 安全重新認領，只能轉成需要人工檢查的 delivery_unknown。
 *
 * round 9 修正（Finding 3）：leaseExpiresAtMs 無法解析時，現在也會保守地
 * 轉成 delivery_unknown（不再是 indeterminate、完全不動它）——過去的
 * indeterminate 會讓收件人永遠卡在 sending，campaign 永遠卡在 partial，
 * 卻沒有任何自動化工作真的在進行，是另一個操作死路（見
 * decideReclaimExpiredDeliveryAttempt 的說明）。
 *
 * round 9 新增（Finding 3 item 5）；round 10 新增 generation 檢查
 *（Finding 1／Finding 2）：一併傳入 callerAttemptId／callerGeneration
 *（呼叫這支的 invocation 自己的處理租約身分）——只有這個 invocation
 * 目前仍合法持有 campaign 處理租約、且 generation 相符時才會真的動手，
 * 避免一個自己都已經失去處理租約的 invocation（或處理租約其實已經被
 * resolution 取代）誤傷另一個正在合法接手處理的 invocation。
 *
 * 逐一收件人各自用自己的 transaction 處理（不是一次大交易全部改完）——
 * 這裡本來就沒有「全部一起成功或全部一起失敗」的需求，每位收件人是否
 * 真的過期、現在的 status 是否仍是 sending，都要在各自的 transaction 內
 * 即時重新驗證，不能只憑這裡查詢當下看到的快照就假設還成立。
 */
async function sweepExpiredDeliveryAttempts(
  campaignRef: FirebaseFirestore.DocumentReference,
  callerAttemptId: string,
  callerGeneration: number,
): Promise<void> {
  const snap = await campaignRef.collection('recipients').where('status', '==', 'sending').get()
  if (snap.empty) return
  const nowMs = Date.now()
  for (const doc of snap.docs) {
    const decision = await db.runTransaction((tx) =>
      reclaimExpiredDeliveryAttemptTx(
        docTx(tx, doc.ref),
        docTx(tx, campaignRef),
        callerAttemptId,
        callerGeneration,
        nowMs,
        '寄送租約已過期，SMTP 可能已經開始但無法確認結果，需要人工檢查',
        () => ({ updatedAt: FieldValue.serverTimestamp() }),
      ),
    )
    if (decision.outcome === 'caller-lost-campaign-lease') {
      logger.warn(
        '回收過期 delivery attempt 時，這個 invocation 已經不再合法持有 campaign 處理租約，放棄回收，交給實際持有租約的 invocation 處理',
        { path: doc.ref.path, campaignPath: campaignRef.path, callerAttemptId },
      )
      break
    }
  }
}

/**
 * 直接查詢 Firestore 現在的真實狀態，算出 totals／nonTerminalCount。
 *
 * 兩個呼叫端：
 * 1. sendPendingRecipients() 正常跑完一批之後（見上）。
 * 2. runSendPhaseAfterLeaseAcquired() 在「已經開始處理收件人之後才發生
 *    全域例外」時，用來重新確認真實進度，而不是武斷假設全部失敗
 *   （Finding 1）——不論是哪一種呼叫情境，都不依賴任何記憶體中累計的
 *    計數，只看 Firestore 這一刻的真實資料，這樣才能正確反映「已經
 *    sent 的人必須保留，還沒完成的人才會被算進 nonTerminalCount」。
 *
 * attemptId 是呼叫端目前這個 invocation 自己的處理租約 attemptId，轉交給
 * sweepExpiredDeliveryAttempts() 做租約擁有權驗證（見上方說明）。
 *
 * ⚠️ 算 totals／nonTerminalCount 的公式抽到 shared/campaignSend.ts 的
 * computeAuthoritativeRecipientTotals()，跟 resolveDeliveryUnknown 用的
 * 是同一份邏輯——這裡刻意用 countNonTerminalRecipients()（該函式內部呼叫），
 * 不是 selectRecipientsToProcess()——後者回答的是「這次選批時漏掉多少人」，
 * 跟「現在還有沒有人沒完成」是不同問題，過去曾經誤用同一個欄位，導致
 * 90 sent + 10 failed 被誤判成 completed。
 */
async function computeCampaignTotals(
  campaignRef: FirebaseFirestore.DocumentReference,
  attemptId: string,
  generation: number,
): Promise<{ totals: CampaignTotals; nonTerminalCount: number }> {
  // round 8 新增（Finding 1）：每次計算 totals 之前，先把已經過期的
  // delivery-attempted（'sending'）收件人原子轉成 delivery_unknown——不論
  // 這次呼叫是正常批次跑完後的收尾，還是 runSendPhase 中斷後的 recovery，
  // 都要讓這裡查到的分佈正確反映「已經沒有自動化工作在進行的
  // delivery-attempted」，campaign 才會正確落在 needs_review，而不是卡在
  // partial 卻沒有任何自動化工作真的在跑。
  await sweepExpiredDeliveryAttempts(campaignRef, attemptId, generation)
  const snap = await campaignRef.collection('recipients').get()
  return computeAuthoritativeRecipientTotals(
    snap.docs.map((d) => ({ status: (d.data() as RecipientDoc).status })),
  )
}

/**
 * 已經成功取得 campaign 處理租約之後，接手完成整個寄送流程。
 *
 * 這裡只是薄薄的一層 wrapper：核心的 orchestration（attemptedSend 分岔、
 * 中斷後 recovery、transporter 何時該 close…，完整說明見 shared/campaignSend.ts
 * 的 runSendPhase()）已經在 round 7 抽到 shared/campaignSend.ts，因為那段
 * 邏輯本身完全不需要碰 Firestore／Nodemailer／firebase-functions 的具體
 * 型別——把它留在這裡（因為頂層 initializeApp() 沒辦法被測試匯入）會讓
 * 「這裡最深層的失敗處理分支到底對不對」永遠沒有自動化測試覆蓋
 *（round 6 報告就承認了這個缺口）。現在 production 與測試呼叫的是同一份
 * runSendPhase()，這裡只負責把 Admin SDK／Nodemailer 相關的真實實作接成
 * SendPhaseDeps，並在最外層把 runSendPhase() 重新拋出的**原始**例外分類
 * 包裝成 HttpsError——HttpsError 是 firebase-functions 專屬的類別，
 * shared/campaignSend.ts 刻意不 import 它（見 runSendPhase 的說明），
 * 這一層分類邏輯只能留在這裡：保留原本的 code/message 直接重新拋出，
 * 其他例外才包成 'internal'，避免所有錯誤都變成同一種模糊訊息。
 */
async function runSendPhaseAfterLeaseAcquired(opts: {
  campaignRef: FirebaseFirestore.DocumentReference
  attemptId: string
  generation: number
  pressReleaseId: string
  isTest: boolean
  loadSendInputs: () => Promise<{
    press: CampaignPress & {
      attachments?: { name: string; path: string; contentType?: string }[]
    }
    emailSettings: CampaignEmailSettings
  }>
}): Promise<{ status: CampaignFinalizeStatus }> {
  try {
    return await runSendPhase<
      CampaignPress & { attachments?: { name: string; path: string; contentType?: string }[] },
      CampaignEmailSettings,
      Awaited<ReturnType<typeof loadAttachments>>,
      SmtpSettings,
      nodemailer.Transporter
    >({
      loadSendInputs: opts.loadSendInputs,
      loadAttachments: (press) => loadAttachments(press.attachments, opts.pressReleaseId),
      readSmtpSettings: async () => readSmtpSettings(),
      createTransport: async (settings) => createTransport(settings, await readSmtpPassword()),
      verifyTransport: async (transporter) => {
        try {
          await transporter.verify()
        } catch (err) {
          throw new HttpsError(
            'unavailable',
            `SMTP 伺服器連線失敗：${(err as Error).message}`,
          )
        }
      },
      sendPending: (input) =>
        sendPendingRecipients({
          campaignRef: opts.campaignRef,
          attemptId: opts.attemptId,
          generation: opts.generation,
          press: input.press,
          emailSettings: input.emailSettings,
          settings: input.settings,
          transporter: input.transporter,
          attachments: input.attachments,
          isTest: opts.isTest,
        }),
      computeTotals: () => computeCampaignTotals(opts.campaignRef, opts.attemptId, opts.generation),
      finalize: (totals, nonTerminalCount, diagnosticMessage) =>
        finalizeCampaign(
          opts.campaignRef,
          opts.attemptId,
          opts.generation,
          totals,
          nonTerminalCount,
          diagnosticMessage,
        ),
      markFailed: (err) =>
        markCampaignFailed(
          opts.campaignRef,
          { kind: 'lease', attemptId: opts.attemptId, generation: opts.generation },
          err,
        ),
      closeTransport: (transporter) => transporter.close(),
      logError: (message, meta) => logger.error(message, meta),
      now: () => Date.now(),
    })
  } catch (err) {
    if (err instanceof HttpsError) throw err
    throw new HttpsError(
      'internal',
      `寄送過程發生錯誤，已停止：${(err as Error).message}`,
    )
  }
}

interface RecipientPlan {
  effectiveLists: string[]
  recipients: Contact[]
}

/**
 * 驗證輸入並展開收件人清單。純粹讀取＋計算，不寫入任何 Firestore 文件。
 *
 * 必須在原子建立 campaign 文件之前完成 —— 這樣「沒選名單」「名單是空的」
 * 「測試名單沒有成員」「語言版本沒填完」這類預期會發生的輸入錯誤，才不會
 * 在文件已經建立、狀態卡在 sending 之後才被發現，留下一個永遠不會被處理、
 * 還會污染這個 idempotencyKey 的幽靈 campaign（同一個 key 之後的正常請求
 * 會一直看到這份半吊子的文件）。
 */
async function buildRecipientPlan(opts: {
  mode: SendMode
  targetLists: string[] | undefined
  press: { versions: Record<Language, Version> }
  emailSettings: { internalCopies?: Record<string, string> }
  user: AuthorizedUser
}): Promise<RecipientPlan> {
  let effectiveLists: string[] = []

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

  // 已填寫（主旨＋內文都有）的語言版本。兩種測試模式都據此決定要寄哪幾版。
  const filledLangs = LANGUAGES.filter((l) => {
    const v = opts.press.versions?.[l]
    return !!(v?.subject?.trim() && v?.bodyText?.trim())
  })

  if (opts.mode === 'self') {
    if (filledLangs.length === 0) {
      throw new HttpsError('failed-precondition', '沒有任何已填寫的語言版本。')
    }
    // 測試信收件人：登入者本人 + 後台「測試信收件人」設定的信箱，去重
    const extras = parseEmailList(
      (await db.doc('settings/smtp').get()).data()?.testRecipients,
    )
    const seen = new Set<string>()
    const emails: string[] = []
    for (const e of [opts.user.email, ...extras]) {
      const key = e.toLowerCase()
      if (!seen.has(key)) {
        seen.add(key)
        emails.push(e)
      }
    }
    // 每個已填語言版本 × 每個收件人各寄一封
    recipients = filledLangs.flatMap((l) =>
      emails.map((email, idx) => ({
        id: `self_${l}_${idx}`,
        name: opts.user.displayName ?? '',
        email,
        outlet: '（測試信）',
        language: l,
      })),
    )
  } else if (opts.mode === 'testList') {
    effectiveLists = [TEST_LIST_ID]
    const members = await expandLists(effectiveLists)
    if (members.length === 0) {
      throw new HttpsError(
        'failed-precondition',
        '測試名單沒有任何聯絡人，請先到媒體名單把同仁加進「測試名單」。',
      )
    }
    if (filledLangs.length === 0) {
      throw new HttpsError('failed-precondition', '沒有任何已填寫的語言版本。')
    }
    // 測試名單每位成員都收到「所有已填寫的語言版本」，
    // 不看成員自己的語言設定 —— 這樣一次就能核對 tw／www／us 三版。
    recipients = members.flatMap((m) =>
      filledLangs.map((l) => ({ ...m, id: `${m.id}_${l}`, language: l })),
    )
  } else {
    // 正式發送：測試名單一律排除，避免內部信箱混進真實發稿
    effectiveLists = (opts.targetLists ?? []).filter((l) => l !== TEST_LIST_ID)
    if (effectiveLists.length === 0) {
      throw new HttpsError('invalid-argument', '請至少勾選一個媒體名單。')
    }
    recipients = await expandLists(effectiveLists)
    if (recipients.length === 0) {
      throw new HttpsError('failed-precondition', '勾選的名單沒有任何收件人。')
    }

    // 內部副本：正式發送時，把設定裡對應名單的公司同事一併寄送。
    // 每人只收一份 —— 跨名單、與媒體收件人重複都在 expandInternalCopies 去重。
    const copies = expandInternalCopies(
      opts.emailSettings.internalCopies,
      effectiveLists,
      recipients.map((r) => r.email),
    )
    copies.forEach(({ email, list }, i) => {
      const lang = LIST_LANGUAGE[list]
      if (!lang) return
      recipients.push({
        id: `internal_${i}`,
        name: '',
        email,
        outlet: '（內部副本）',
        language: lang,
      })
    })
  }

  if (opts.mode !== 'self') {
    // 有人要收的語言版本一定要填完，否則整批擋下
    const missing = LANGUAGES.filter(
      (l) =>
        recipients.some((r) => r.language === l) &&
        !(
          opts.press.versions?.[l]?.subject?.trim() &&
          opts.press.versions?.[l]?.bodyText?.trim()
        ),
    )
    if (missing.length > 0) {
      throw new HttpsError(
        'failed-precondition',
        `以下語言版本尚未填寫完整：${missing.join('、')}`,
      )
    }
  }

  return { effectiveLists, recipients }
}

// ExistingCampaignFields／ResumeResolution／resolveResume 的判斷邏輯
// （含 legacy startedAt 相容讀取）現在都在 shared/campaignSend.ts 的
// resolveCampaignResume()——這裡原本是私有函式，但它完全不碰 Firestore，
// 唯一依賴是呼叫端自己傳的 nowMs，移到 shared 才能讓測試直接呼叫
// production 實際在跑的這份轉換邏輯（而不是重新手刻一份看起來很像、
// 卻可能忘記同步更新的版本）。sendCampaign／retryCampaign 都呼叫
// resolveCampaignResume(existing, request, Date.now())。

export const sendCampaign = onCall<SendRequest>(
  { secrets: [SMTP_PASS], timeoutSeconds: CAMPAIGN_FUNCTION_TIMEOUT_MS / 1000, memory: '512MiB' },
  async (request) => {
    const { pressReleaseId, targetLists, mode, idempotencyKey } =
      request.data ?? {}
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
        internalCopies?: Record<string, string>
      })

    // 有帶合法的 idempotencyKey 就直接當 campaign 文件 ID —— 同一個 key
    // 重複呼叫（手動重試、網路重送）都會落在同一份文件上，不會建第二個。
    const campaignRef = isValidIdempotencyKey(idempotencyKey)
      ? db.collection('campaigns').doc(idempotencyKey)
      : db.collection('campaigns').doc()

    // 這次呼叫（invocation）的唯一識別碼，用來認領收件人與 campaign 的處理租約，
    // 也是「建立收件人清單」這個設定階段的擁有者身分（createdByAttemptId）。
    const attemptId = randomUUID()

    let effectiveLists: string[] = []
    let recipientsCount = 0

    // 先非交易地看一眼現況 —— 只是用來判斷「要不要花時間展開收件人清單」的
    // 優化，不是正確性的依據。就算這裡看到不存在、實際上已經有人正在建立
    // （race），下面的原子交易 createOrJoinCampaignTx 仍然會正確地讓其中
    // 一方變成 loser、改用贏家的結果，不會建出兩份文件。
    const earlySnap = await campaignRef.get()

    if (earlySnap.exists) {
      const resolution = resolveCampaignResume(
        earlySnap.data() as ExistingCampaignFields,
        { pressReleaseId, mode },
        Date.now(),
      )
      switch (resolution.kind) {
        case 'reject':
          throw new HttpsError('invalid-argument', resolution.reason)
        case 'existing-result':
          return {
            campaignId: campaignRef.id,
            recipients: resolution.recipients,
            status: resolution.status,
          }
        case 'wait':
          throw new HttpsError(
            'unavailable',
            '這次發送正在準備收件人清單，請稍後再試一次（畫面重新整理後再按一次發送）。',
          )
        case 'abandoned':
          // 建立收件人清單的過程中斷太久（例如上一個 invocation 逾時或崩潰），
          // 判定已死。不需要、也不可能驗證自己是設定階段的擁有者
          // （那個 invocation 真的死了，沒人能合法冒充它），改用會在同一個
          // transaction 裡即時重新確認「現在」仍然是幽靈狀態的專用回收函式，
          // 並依真實的 transaction outcome 回報，不假設一定是 marked-failed。
          await throwForAbandonedReclaim(campaignRef)
          break
        case 'indeterminate':
          // startedAt 新舊欄位都無法解析出有效時間戳，無法判斷是否真的
          // 中斷太久——不能像過去那樣猜測，直接拒絕並要求人工檢查。
          throw new HttpsError(
            'failed-precondition',
            '這筆發送的建立時間資料異常，無法自動判斷是否已經中斷，請聯絡工程人員檢查 Firestore 資料。',
          )
        case 'inconsistent':
          // round 8 新增（Finding 4）：recipientsReady 還是 false，但已經有
          // activeAttemptId——違反不變量，不能猜測是 abandoned 還是仍在
          // 合法處理中，直接拒絕並要求人工檢查資料，不繼續往下判斷。
          throwInconsistentRecipientsSetup()
          break
        case 'resume':
          effectiveLists = resolution.effectiveLists
          recipientsCount = resolution.recipientsCount
          break
      }
    } else {
      // 全新建立：先完成所有沒有副作用的驗證與收件人展開，確定會成功了
      // 才去原子建立 campaign 文件（Finding 4）——輸入錯誤（沒選名單、
      // 名單是空的、語言版本沒填完…）在這裡就會直接拋錯，不會留下任何
      // Firestore 文件。
      const plan = await buildRecipientPlan({
        mode,
        targetLists,
        press,
        emailSettings,
        user,
      })
      effectiveLists = plan.effectiveLists

      const createResult = await db.runTransaction((tx) =>
        createOrJoinCampaignTx(docTx(tx, campaignRef), attemptId, {
          pressReleaseId,
          pressTitle: press.title,
          category: press.category,
          mode,
          isTest,
          sentBy: user.email,
          sentAt: FieldValue.serverTimestamp(),
          startedAtMs: Date.now(),
          status: 'sending',
          recipientsReady: false,
          targetLists: effectiveLists,
          totals: {
            recipients: plan.recipients.length,
            sent: 0,
            failed: 0,
            exhausted: 0,
            deliveryUnknown: 0,
          },
        }),
      )

      if (!createResult.created) {
        // 輸給另一個帶著同一個 idempotencyKey 的併發請求：直接採用贏家
        // 已經寫入的結果，不能自己另外重建一份收件人清單。
        const resolution = resolveCampaignResume(
          createResult.existingData as ExistingCampaignFields,
          { pressReleaseId, mode },
          Date.now(),
        )
        switch (resolution.kind) {
          case 'reject':
            throw new HttpsError('invalid-argument', resolution.reason)
          case 'existing-result':
            return {
              campaignId: campaignRef.id,
              recipients: resolution.recipients,
              status: resolution.status,
            }
          case 'wait':
            throw new HttpsError(
              'unavailable',
              '這次發送正在準備收件人清單，請稍後再試一次（畫面重新整理後再按一次發送）。',
            )
          case 'abandoned':
            await throwForAbandonedReclaim(campaignRef)
            break
          case 'indeterminate':
            throw new HttpsError(
              'failed-precondition',
              '這筆發送的建立時間資料異常，無法自動判斷是否已經中斷，請聯絡工程人員檢查 Firestore 資料。',
            )
          case 'inconsistent':
            throwInconsistentRecipientsSetup()
            break
          case 'resume':
            effectiveLists = resolution.effectiveLists
            recipientsCount = resolution.recipientsCount
            break
        }
      } else {
        // 贏得了原子建立：換自己實際寫入收件人子集合。
        // Firestore batch 一次上限 500 筆，收件人多時要分批 commit。
        try {
          for (const group of chunk(plan.recipients)) {
            const batch = db.batch()
            for (const r of group) {
              batch.set(campaignRef.collection('recipients').doc(r.id), {
                contactId: r.id,
                email: r.email,
                name: r.name,
                outlet: r.outlet ?? '',
                language: r.language,
                status: 'queued',
                attemptCount: 0,
              })
            }
            await batch.commit()
          }
          // 收件人清單完整寫入後才翻成 true —— 這之前若有第二個帶著同一個
          // idempotencyKey 的請求進來，decideCampaignResume 會判斷成
          // wait-recipients-setup，不會提早開始寄、漏掉還沒寫完的收件人。
          await campaignRef.update({ recipientsReady: true })
        } catch (err) {
          // 不能讓 campaign 永遠停在 sending，否則畫面會一直轉圈。
          // 只有這次建立的擁有者（createdByAttemptId 是自己）能標記這個
          // 失敗，避免其他無關的 invocation 冒充。
          logger.error('建立收件人紀錄失敗', err)
          await markCampaignFailed(campaignRef, { kind: 'setup', attemptId }, err)
          throw new HttpsError(
            'internal',
            '建立收件人紀錄失敗，尚未寄出任何信件，請稍後再試。',
          )
        }
        recipientsCount = plan.recipients.length
      }
    }

    // 收件人清單已經就緒（不管是這次建立、resume，還是接手贏家的結果），
    // 才嘗試取得處理租約——這一步之後才會做任何可能導致「標記失敗」的動作
    // （附件載入、Secret 讀取、SMTP verify、實際寄送），所以要先在同一個
    // transaction 內原子重新驗證 campaign 現在是不是真的還處於 sending／
    // partial、不是別人正在持有的租約，也不是已經被別人 finalize 成
    // completed／failed 的終止狀態（Finding 2 的 TOCTOU：上面 resolveResume
    // 讀到的 sending／partial，跟這裡的 transaction 之間有時間差，campaign
    // 有可能在這段期間已經被另一個 invocation finalize 掉）。
    const leaseDecision = await acquireCampaignLease(campaignRef, attemptId)
    if (leaseDecision.outcome === 'terminal') {
      // 已經是 completed／failed／needs_review，不該再假裝這次呼叫還能做
      // 什麼；直接回報目前的真實狀態，不當成一般的「被佔用中」處理。
      const currentSnap = await campaignRef.get()
      const currentData = currentSnap.data() as { status?: string; totals?: { recipients?: number } } | undefined
      return {
        campaignId: campaignRef.id,
        recipients: currentData?.totals?.recipients ?? recipientsCount,
        status: (currentData?.status as 'completed' | 'failed' | 'needs_review') ?? 'failed',
      }
    }
    if (leaseDecision.outcome === 'not-ready') {
      throw new HttpsError(
        'unavailable',
        '這次發送正在準備收件人清單，請稍後再試一次。',
      )
    }
    if (leaseDecision.outcome === 'not-found') {
      throw new HttpsError('not-found', '找不到這筆發送紀錄。')
    }
    if (leaseDecision.outcome === 'held-by-other') {
      throw new HttpsError(
        'aborted',
        '這筆發送目前正由另一個請求處理中，請稍後再查看發送紀錄。',
      )
    }
    // round 13 新增（Finding 1）：campaign.leaseGeneration 欄位格式錯誤，
    // 或已經到達 Number.MAX_SAFE_INTEGER 無法再安全遞增——理論上不該發生，
    // 但這代表 fencing 本身已經無法被信任，必須讓人工介入檢查資料，
    // 不能悄悄核發一個看似正常的租約。
    if (leaseDecision.outcome === 'invalid-generation' || leaseDecision.outcome === 'generation-exhausted') {
      logger.error('acquireCampaignLease：campaign.leaseGeneration 異常，拒絕核發租約', {
        campaignPath: campaignRef.path,
        outcome: leaseDecision.outcome,
      })
      throw new HttpsError(
        'internal',
        '這筆發送的內部狀態異常，無法安全處理，請聯絡工程人員檢查 Firestore 資料。',
      )
    }

    // leaseDecision.outcome === 'acquired'：接手完成整個寄送流程；讀新聞稿
    // 附件、SMTP 設定與密碼、建立 transporter、verify、實際寄送、finalize
    // 全部包在 runSendPhaseAfterLeaseAcquired 內部同一個 try/catch/finally
    // 裡（Finding 3）——sendCampaign 這裡已經有 press／emailSettings，
    // loadSendInputs 直接回傳既有值，不必重讀。
    const { status } = await runSendPhaseAfterLeaseAcquired({
      campaignRef,
      attemptId,
      generation: leaseDecision.generation,
      pressReleaseId,
      isTest,
      loadSendInputs: async () => ({ press, emailSettings }),
    })

    if (status === 'superseded' || status === 'not-found') {
      // 租約在處理過程中被別的 invocation 取代（或文件已經不存在），
      // 這次的結果不具權威性；回傳目前資料庫的真實狀態。round 16 修正
      // （Finding 4）：新聞稿是否同步已經收在 finalizeCampaign() 內部
      // 同一個 transaction，這裡不需要（也不會）再另外判斷一次。
      const currentSnap = await campaignRef.get()
      const currentStatus = (currentSnap.data()?.status as CampaignStatus) ?? 'partial'
      return { campaignId: campaignRef.id, recipients: recipientsCount, status: currentStatus }
    }
    // round 18 新增（Finding 1 項目 4）：campaign 因為新聞稿同步中繼資料
    // 無法安全判斷而被阻擋——沒有真的變成 terminal，不能假裝寄送已經
    // 完成。明確回報 failed-precondition，讓呼叫端知道需要先修好 campaign
    // 文件本身的資料，這封信本身已經真的寄出去了，不需要（也不能）重寄，
    // 只需要修好資料後重新呼叫 sendCampaign／retryCampaign 讓它用
    // authoritative totals 完成收尾。
    if (status === 'blocked-invalid-campaign-metadata' || status === 'blocked-press-release-not-found') {
      throw new HttpsError(
        'failed-precondition',
        status === 'blocked-invalid-campaign-metadata'
          ? '這筆發送的 mode／isTest／totals.sent 欄位無法安全判斷，寄送內容已經送出但尚未收尾，' +
            '請聯絡工程人員檢查這份 campaign 文件本身的資料，修好之後重新呼叫即可正確完成，不會重複寄送。'
          : '這筆發送已經確認需要同步新聞稿，但找不到對應的新聞稿或其 ID 有誤，寄送內容已經送出但尚未收尾，' +
            '請確認新聞稿存在後重新呼叫即可正確完成，不會重複寄送。',
      )
    }

    return { campaignId: campaignRef.id, recipients: recipientsCount, status }
  },
)

/**
 * 接續一個尚未完成（partial 或卡在 sending）的 campaign，
 * 只處理還沒確認寄出的收件人 —— 已經是 sent 的一律跳過，不會重複寄送。
 *
 * 用途：sendCampaign 因為撞到 SEND_BATCH_LIMIT 而提早停下（partial），
 * 或某次呼叫中途中斷、卡在 sending 太久，都可以呼叫這支繼續寄完。
 */
export const retryCampaign = onCall<{ campaignId: string }>(
  { secrets: [SMTP_PASS], timeoutSeconds: CAMPAIGN_FUNCTION_TIMEOUT_MS / 1000, memory: '512MiB' },
  async (request) => {
    const campaignId = request.data?.campaignId
    if (!campaignId || typeof campaignId !== 'string' || campaignId.includes('/')) {
      throw new HttpsError('invalid-argument', 'campaign ID 不正確。')
    }

    const campaignRef = db.collection('campaigns').doc(campaignId)
    const snap = await campaignRef.get()
    if (!snap.exists) {
      throw new HttpsError('not-found', '找不到這筆發送紀錄。')
    }
    const campaign = snap.data() as {
      pressReleaseId: string
      mode: SendMode
      isTest: boolean
      status: string
      recipientsReady?: boolean
      startedAtMs?: number
      /** 相容欄位：round 4 之前寫入的舊文件用 Timestamp，見 readFirstValidMs 的說明。 */
      startedAt?: FirebaseFirestore.Timestamp
      activeAttemptId?: string | null
    }

    // 與 sendCampaign 相同的權限分野：正式發送要 sendReal，測試類要 sendTest
    await requirePermission(
      request.auth,
      campaign.mode === 'real' ? 'sendReal' : 'sendTest',
    )

    // 與 sendCampaign 共用同一套決策邏輯：這裡的 pressReleaseId／mode 一定
    // 跟文件本身相符（不是使用者傳入的），所以不會走到 reject／create 分支，
    // 只是借用同一份判斷來處理「已跑完」「收件人清單還在建立中」的情況。
    //
    // ⚠️ startedAt（legacy）一定要跟 startedAtMs 一起傳給
    // resolveCampaignResume()。過去這裡漏掉了 startedAt，只傳
    // startedAtMs——round 4 之前建立、只有 startedAt（Timestamp）沒有
    // startedAtMs 的舊 campaign，resolveCampaignResume() 內部算出來的
    // startedAtMs 會是 null，decideCampaignResume() 進而把 `nowMs - 0`
    // 這種巨大差值誤判成「早就超過 RECIPIENTS_SETUP_STALE_MS」，即使那份
    // 舊 campaign 的收件人清單才剛開始建立，也會被立刻判定成 abandoned。
    const resolution = resolveCampaignResume(
      {
        pressReleaseId: campaign.pressReleaseId,
        mode: campaign.mode,
        status: campaign.status,
        recipientsReady: campaign.recipientsReady,
        startedAtMs: campaign.startedAtMs,
        startedAt: campaign.startedAt,
        // round 8 新增（Finding 4）：見 sendCampaign 的說明——一定要傳，
        // 否則 recipientsReady:false 又已經有 activeAttemptId 這種違反
        // 不變量的資料，resolveCampaignResume() 沒辦法在這一層就發現。
        activeAttemptId: campaign.activeAttemptId,
      },
      { pressReleaseId: campaign.pressReleaseId, mode: campaign.mode },
      Date.now(),
    )
    if (resolution.kind === 'existing-result') {
      return { ok: true, status: resolution.status }
    }
    if (resolution.kind === 'wait') {
      throw new HttpsError(
        'unavailable',
        '收件人清單還在建立中，請稍後再試一次。',
      )
    }
    if (resolution.kind === 'abandoned') {
      // 設定階段的擁有者已死，沒有人能合法冒充它；改用即時重新驗證
      // 「現在」是否仍是幽靈狀態的專用回收函式，不驗證 attemptId，並依
      // 真實的 transaction outcome 回報，不能假設一定是 marked-failed
      // （Finding 6：呼叫前讀到的判斷跟 transaction 真正執行的當下之間
      // 有時間差，原本的 setup owner 有可能剛好就在這中間完成了
      // recipientsReady）。
      const outcome = await reclaimAbandonedSetup(
        campaignRef,
        '建立收件人清單的過程中斷（可能是逾時或崩潰）',
      )
      if (outcome === 'marked-failed') {
        return { ok: true, status: 'failed' as const }
      }
      if (outcome === 'not-found') {
        throw new HttpsError('not-found', '找不到這筆發送紀錄。')
      }
      if (outcome === 'indeterminate') {
        throw new HttpsError(
          'failed-precondition',
          '這筆發送的建立時間資料異常，無法自動判斷是否已經中斷，請聯絡工程人員檢查 Firestore 資料。',
        )
      }
      throw new HttpsError(
        'unavailable',
        '這次發送的狀態剛剛有更新，請重新整理頁面再試一次。',
      )
    }
    if (resolution.kind === 'indeterminate') {
      throw new HttpsError(
        'failed-precondition',
        '這筆發送的建立時間資料異常，無法自動判斷是否已經中斷，請聯絡工程人員檢查 Firestore 資料。',
      )
    }
    if (resolution.kind === 'inconsistent') {
      // round 8 新增（Finding 4）：見 sendCampaign 的說明。
      throwInconsistentRecipientsSetup()
    }
    // resolution.kind === 'resume'（reject 不會發生：pressReleaseId／mode 一定相符）

    // 跟 sendCampaign 一樣：先取得處理租約，才做任何可能導致「標記失敗」的
    // 動作（新聞稿是否還存在、SMTP verify）——這樣就算後面任何一步失敗，
    // markCampaignFailed 用的都是這次已經合法拿到的租約身分，不會誤傷另一個
    // 已經持有租約、正在實際寄送中的 invocation（Finding 3）。同一個
    // transaction 內也會原子重新驗證 status／recipientsReady，terminal
    // campaign 不會被核發租約（Finding 2 的 TOCTOU）。
    const attemptId = randomUUID()
    const leaseDecision = await acquireCampaignLease(campaignRef, attemptId)
    if (leaseDecision.outcome === 'terminal') {
      const currentSnap = await campaignRef.get()
      const currentStatus =
        (currentSnap.data()?.status as 'completed' | 'failed' | 'needs_review') ?? 'failed'
      return { ok: true, status: currentStatus }
    }
    if (leaseDecision.outcome === 'not-ready') {
      throw new HttpsError(
        'unavailable',
        '收件人清單還在建立中，請稍後再試一次。',
      )
    }
    if (leaseDecision.outcome === 'not-found') {
      throw new HttpsError('not-found', '找不到這筆發送紀錄。')
    }
    if (leaseDecision.outcome === 'held-by-other') {
      throw new HttpsError(
        'aborted',
        '這筆發送目前正由另一個請求處理中，請稍後再查看發送紀錄。',
      )
    }
    // round 13 新增（Finding 1）：見 sendCampaign 對稱的檢查說明。
    if (leaseDecision.outcome === 'invalid-generation' || leaseDecision.outcome === 'generation-exhausted') {
      logger.error('acquireCampaignLease：campaign.leaseGeneration 異常，拒絕核發租約', {
        campaignPath: campaignRef.path,
        outcome: leaseDecision.outcome,
      })
      throw new HttpsError(
        'internal',
        '這筆發送的內部狀態異常，無法安全處理，請聯絡工程人員檢查 Firestore 資料。',
      )
    }

    // leaseDecision.outcome === 'acquired'：接手完成整個寄送流程；讀新聞稿／
    // email 設定／載入附件／讀 SMTP 設定與密碼／建立 transporter／verify／
    // 實際寄送／finalize 全部包在 runSendPhaseAfterLeaseAcquired 內部同一個
    // try/catch/finally 裡（Finding 3）——retryCampaign 這裡還沒讀過新聞稿，
    // loadSendInputs 在租約已經取得之後才真正去讀，任何失敗（含新聞稿已被
    // 刪除）都會被同一個 catch 接住、用這次的租約身分標記失敗並釋放租約。
    const { status } = await runSendPhaseAfterLeaseAcquired({
      campaignRef,
      attemptId,
      generation: leaseDecision.generation,
      pressReleaseId: campaign.pressReleaseId,
      isTest: campaign.isTest,
      loadSendInputs: async () => {
        const pressSnap = await db
          .collection('pressReleases')
          .doc(campaign.pressReleaseId)
          .get()
        if (!pressSnap.exists) {
          throw new HttpsError('not-found', '找不到這篇新聞稿，無法繼續寄送。')
        }
        const press = pressSnap.data() as {
          title: string
          category: string
          releaseDate?: string
          versions: Record<Language, Version>
          attachments?: { name: string; path: string; contentType?: string }[]
        }
        const emailSettings =
          (await db.doc('settings/email').get()).data() ??
          ({} as {
            logoUrl?: string
            contacts?: Record<Language, PressContact>
            about?: Record<Language, { text?: string; link?: string }>
          })
        return { press, emailSettings }
      },
    })

    if (status === 'superseded' || status === 'not-found') {
      // round 16 修正（Finding 4）：新聞稿是否同步已經收在
      // finalizeCampaign() 內部同一個 transaction，這裡不需要（也不會）
      // 再另外判斷一次。
      const currentSnap = await campaignRef.get()
      const currentStatus = (currentSnap.data()?.status as CampaignStatus) ?? 'partial'
      return { ok: true, status: currentStatus }
    }
    // round 18 新增（Finding 1 項目 4）：見 sendCampaign 同樣的說明——
    // campaign 因為新聞稿同步中繼資料無法安全判斷而被阻擋，沒有變成
    // terminal，不能假裝重試已經完成。
    if (status === 'blocked-invalid-campaign-metadata' || status === 'blocked-press-release-not-found') {
      throw new HttpsError(
        'failed-precondition',
        status === 'blocked-invalid-campaign-metadata'
          ? '這筆發送的 mode／isTest／totals.sent 欄位無法安全判斷，寄送內容已經送出但尚未收尾，' +
            '請聯絡工程人員檢查這份 campaign 文件本身的資料，修好之後重新呼叫即可正確完成，不會重複寄送。'
          : '這筆發送已經確認需要同步新聞稿，但找不到對應的新聞稿或其 ID 有誤，寄送內容已經送出但尚未收尾，' +
            '請確認新聞稿存在後重新呼叫即可正確完成，不會重複寄送。',
      )
    }

    return { ok: true, status }
  },
)

/**
 * 嘗試取得 campaign 的 resolution 租約（round 9 新增，見
 * shared/campaignSend.ts 的說明：跟處理租約互斥，保護「查詢真實收件人
 * 分佈＋寫入 resolution 結果」這段操作不被一般寄送或另一個 resolution
 * 打斷）。
 */
async function acquireResolutionLease(
  campaignRef: FirebaseFirestore.DocumentReference,
  attemptId: string,
): Promise<AcquireResolutionLeaseDecision> {
  return db.runTransaction((tx) =>
    acquireResolutionLeaseTx(
      docTx(tx, campaignRef),
      attemptId,
      Date.now(),
      RESOLUTION_LEASE_MS,
      // round 10 新增（Finding 2）：對稱於 acquireCampaignLease，acquired
      // 時順手清掉已經證明失效的處理租約殘留欄位。
      () => ({
        updatedAt: FieldValue.serverTimestamp(),
        activeAttemptId: FieldValue.delete(),
        activeLeaseExpiresAtMs: FieldValue.delete(),
      }),
    ),
  )
}

/**
 * best-effort 釋放 resolution 租約：只在「取得租約之後、resolveDeliveryUnknownTx
 * 那個 transaction 本身還沒跑到（或跑到一半意外拋錯）」這種意外情況才會
 * 用到——正常路徑（不論哪一種 outcome）都已經在 resolveDeliveryUnknownTx
 * 自己的 transaction 裡釋放了。失敗只記錄，租約本身時長很短
 *（RESOLUTION_LEASE_MS），最壞情況就是自然過期，不值得讓這裡的釋放失敗
 * 蓋過原本要往外拋的錯誤。
 */
async function releaseResolutionLeaseBestEffort(
  campaignRef: FirebaseFirestore.DocumentReference,
  attemptId: string,
): Promise<void> {
  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(campaignRef)
      if (snap.exists && snap.data()?.resolutionLeaseAttemptId === attemptId) {
        tx.update(campaignRef, {
          resolutionLeaseAttemptId: FieldValue.delete(),
          resolutionLeaseExpiresAtMs: FieldValue.delete(),
          updatedAt: FieldValue.serverTimestamp(),
        })
      }
    })
  } catch (err) {
    logger.error('釋放 resolution 租約失敗（best-effort，租約會在時限後自然過期）', {
      campaignPath: campaignRef.path,
      attemptId,
      err,
    })
  }
}

/**
 * round 8 新增、round 9 修正（Finding 2／Finding 4）：needs_review 是
 * terminal，一般 retryCampaign 拿不到處理租約；delivery_unknown 的收件人
 * 也永遠不會被一般認領流程碰到（isRecipientClaimable 永遠回傳 false）——
 * 沒有任何一般流程能讓一個卡在 needs_review 的 campaign 離開這個狀態，
 * 必須有一條獨立、需要 admin 身分、而且會留下稽核紀錄的人工處理路徑。
 *
 * 兩種動作：
 * - mark_delivered：人工已經確認這位收件人其實收到了信，轉成 sent。
 * - force_retry：人工明確承擔「可能重複寄送」的風險，轉成 failed（一般
 *   認領流程就會處理它），前端必須有明確的二次確認與警告文字，這裡不重複
 *   驗證使用者是否已經在前端確認過——後端只負責「這個動作本身合法」。
 *
 * ⚠️ round 9 修正（Finding 2）：不再信任 campaign.totals 這個可能已經跟
 * recipients 子集合真實狀態脫鉤的快取值——先取得 resolution 租約（擋下
 * 一般寄送與其他 resolution），在租約保護下非交易地查一次真實的收件人
 * 分佈，再把這份 authoritative totals 交給 resolveDeliveryUnknownTx 在
 * transaction 內重新驗證租約、寫入結果、釋放租約。
 *
 * ⚠️ round 9 新增（Finding 4）：resolutionId 是前端產生的 idempotency
 * key，同一次操作重送（網路重試）會被視為 idempotent success；如果收件人
 * 已經被別的操作（不同 resolutionId，或同 resolutionId 卻帶不同
 * action／reason）處理掉，回報 conflict，不能靜默當成功。
 *
 * 核心的分岔邏輯都在 shared/campaignSend.ts 的
 * decideResolveDeliveryUnknown()／resolveDeliveryUnknownTx()，這裡只負責：
 * requireAdmin 身分驗證、輸入格式驗證、resolution 租約的取得與釋放、
 * authoritative 查詢、把 Admin SDK 的 transaction 接成該函式需要的
 * DocTx，以及把 transaction 真實的 outcome 分類成 HttpsError 或正常回應。
 */
export const resolveDeliveryUnknown = onCall<{
  campaignId: string
  recipientId: string
  action: DeliveryUnknownResolutionAction
  reason: string
  resolutionId: string
}>(async (request) => {
  const user = await requireAdmin(request.auth)

  const { campaignId, recipientId, action, reason, resolutionId } = request.data ?? {}
  if (!campaignId || typeof campaignId !== 'string' || campaignId.includes('/')) {
    throw new HttpsError('invalid-argument', 'campaign ID 不正確。')
  }
  if (!recipientId || typeof recipientId !== 'string' || recipientId.includes('/')) {
    throw new HttpsError('invalid-argument', '收件人 ID 不正確。')
  }
  if (action !== 'mark_delivered' && action !== 'force_retry') {
    throw new HttpsError('invalid-argument', '動作參數不正確。')
  }
  const resolutionReason = typeof reason === 'string' ? reason.trim() : ''
  if (!resolutionReason || resolutionReason.length > 2000) {
    throw new HttpsError(
      'invalid-argument',
      '請填寫處理原因（不可空白，長度上限 2000 字），供稽核使用。',
    )
  }
  if (!isValidIdempotencyKey(resolutionId)) {
    throw new HttpsError(
      'invalid-argument',
      'resolutionId 格式不正確（必須是 8～64 碼英數字、底線或連字號）。',
    )
  }

  const campaignRef = db.collection('campaigns').doc(campaignId)
  const recipientRef = campaignRef.collection('recipients').doc(recipientId)
  // 這個 invocation 自己的租約鎖 token——跟 resolutionId（代表「這一次
  // 人類操作意圖」，重送不變）是完全不同的概念，每次呼叫都換新的。
  const leaseAttemptId = randomUUID()

  const leaseDecision = await acquireResolutionLease(campaignRef, leaseAttemptId)
  if (leaseDecision.outcome === 'not-found') {
    throw new HttpsError('not-found', '找不到這筆發送紀錄。')
  }
  // round 11 新增（Finding 3）：campaign 還在建立收件人清單，或已經是
  // completed／failed／未知狀態，不可能還有合法待處理的 delivery_unknown
  // ——見 shared/campaignSend.ts 的 decideAcquireResolutionLease 說明，
  // 用 failed-precondition 而不是 internal，讓前端知道這是「這個操作在
  // 目前狀態下本來就不合法」，不是意外的伺服器錯誤。
  if (leaseDecision.outcome === 'not-ready') {
    throw new HttpsError('failed-precondition', '這筆發送的收件人清單尚未建立完成，無法進行人工處理。')
  }
  if (leaseDecision.outcome === 'invalid-status') {
    throw new HttpsError(
      'failed-precondition',
      '這筆發送目前的狀態不可能還有待人工處理的收件人。',
    )
  }
  if (leaseDecision.outcome === 'processing-lease-active') {
    throw new HttpsError('aborted', '這筆發送目前正在寄送中，請稍後再試一次。')
  }
  if (leaseDecision.outcome === 'resolution-lease-held') {
    throw new HttpsError('aborted', '另一位管理員正在處理這筆發送，請稍後再試一次。')
  }
  // round 13 新增（Finding 1）：見 acquireCampaignLease 對稱的檢查說明。
  if (leaseDecision.outcome === 'invalid-generation' || leaseDecision.outcome === 'generation-exhausted') {
    logger.error('acquireResolutionLease：campaign.leaseGeneration 異常，拒絕核發租約', {
      campaignPath: campaignRef.path,
      outcome: leaseDecision.outcome,
    })
    throw new HttpsError(
      'internal',
      '這筆發送的內部狀態異常，無法安全處理，請聯絡工程人員檢查 Firestore 資料。',
    )
  }
  const resolutionGeneration = leaseDecision.generation

  try {
    const recipientsSnap = await campaignRef.collection('recipients').get()
    const { totals: authoritativeTotals, nonTerminalCount: authoritativeNonTerminalCount } =
      computeAuthoritativeRecipientTotals(
        recipientsSnap.docs.map((d) => ({ status: (d.data() as RecipientDoc).status })),
      )

    const eventRef = campaignRef.collection('resolutionEvents').doc(resolutionId)
    const decision = await db.runTransaction((tx) =>
      resolveDeliveryUnknownTx(
        docTx(tx, recipientRef),
        docTx(tx, campaignRef),
        docTx(tx, eventRef),
        recipientId,
        authoritativeTotals,
        authoritativeNonTerminalCount,
        { resolvedBy: user.email, resolutionId, resolutionAction: action, resolutionReason },
        leaseAttemptId,
        resolutionGeneration,
        Date.now(),
        () => ({ resolvedAt: FieldValue.serverTimestamp() }),
        (d) => ({
          updatedAt: FieldValue.serverTimestamp(),
          resolutionLeaseAttemptId: FieldValue.delete(),
          resolutionLeaseExpiresAtMs: FieldValue.delete(),
          // partial（force_retry 且產生了新的非終止收件人）代表 campaign
          // 重新變成「可以繼續處理」，不再是收尾完成的狀態，completedAt 要
          // 清掉；其餘（mark_delivered，或 force_retry 剛好讓所有收件人都
          // 到達終止狀態）都是收尾完成，更新成這次 resolution 真正發生的
          // 時間。
          ...(d.outcome === 'resolved'
            ? d.campaignPatch.status === 'partial'
              ? { completedAt: FieldValue.delete() }
              : { completedAt: FieldValue.serverTimestamp() }
            : {}),
        }),
        () => ({ resolvedAt: FieldValue.serverTimestamp() }),
      ),
    )

    if (decision.outcome === 'campaign-not-found') {
      throw new HttpsError('not-found', '找不到這筆發送紀錄。')
    }
    if (decision.outcome === 'resolution-lease-lost') {
      throw new HttpsError(
        'aborted',
        '處理過程中租約已經失效，請重新整理頁面再試一次。',
      )
    }
    if (decision.outcome === 'recipient-not-found') {
      throw new HttpsError('not-found', '找不到這位收件人。')
    }
    if (decision.outcome === 'invalid-authoritative-totals') {
      logger.error('resolveDeliveryUnknown：authoritative totals 驗證失敗，拒絕寫入', {
        campaignId,
        recipientId,
        action,
        authoritativeTotals,
        authoritativeNonTerminalCount,
      })
      throw new HttpsError(
        'internal',
        '目前的收件人統計資料異常，無法安全處理，請聯絡工程人員檢查 Firestore 資料。',
      )
    }
    if (decision.outcome === 'idempotent-replay') {
      // 同一個 resolutionId、同樣的 action／reason 重送（例如網路重試）
      // ——回傳當初已經套用的結果，不重複扣減 totals。
      logger.info('delivery_unknown resolution 重送，回傳原始結果（idempotent）', {
        campaignId,
        recipientId,
        resolutionId,
        action,
        resolvedBy: user.email,
      })
      return {
        ok: true,
        applied: false,
        idempotent: true,
        recipientStatus: decision.recipientStatus,
        resolvedBy: decision.resolvedBy,
        resolutionAction: decision.resolutionAction,
        resolutionReason: decision.resolutionReason,
      }
    }
    if (decision.outcome === 'conflict') {
      // Finding 4：這不是同一個請求的重送，而是另一個操作（可能是不同
      // 管理員、也可能是同一個 resolutionId 卻帶著不同 payload 重送）已經
      // 先處理掉了——不能靜默回報成功，必須讓呼叫端知道實際發生了什麼。
      logger.warn('delivery_unknown resolution 衝突：收件人已被其他操作處理', {
        campaignId,
        recipientId,
        resolutionId,
        action,
        resolvedBy: user.email,
        conflictingRecipientStatus: decision.recipientStatus,
        conflictingResolvedBy: decision.resolvedBy,
        conflictingAction: decision.resolutionAction,
      })
      const actionLabel =
        decision.resolutionAction === 'mark_delivered'
          ? '標記已送達'
          : decision.resolutionAction === 'force_retry'
            ? '強制重寄'
            : '其他方式'
      throw new HttpsError(
        'aborted',
        `這位收件人已經由${decision.resolvedBy ?? '其他人'}以「${actionLabel}」處理過，請重新整理頁面查看最新狀態，不要重複處理。`,
      )
    }

    logger.warn('管理員手動處理 delivery_unknown 收件人', {
      campaignId,
      recipientId,
      resolutionId,
      action,
      resolvedBy: user.email,
      reason: resolutionReason,
    })
    return {
      ok: true,
      applied: true,
      idempotent: false,
      recipientStatus: decision.recipientPatch.status as 'sent' | 'failed',
      campaignStatus: decision.campaignPatch.status as CampaignStatus | 'partial',
    }
  } catch (err) {
    if (err instanceof HttpsError) throw err
    // 意外例外（查詢或 transaction 本身失敗）——resolveDeliveryUnknownTx
    // 沒有機會自己釋放租約，這裡 best-effort 補一次，避免不必要地卡住其他
    // 人到租約自然過期為止。
    await releaseResolutionLeaseBestEffort(campaignRef, leaseAttemptId)
    throw new HttpsError('internal', `處理失敗：${(err as Error)?.message ?? '未知錯誤'}`)
  }
})

/**
 * round 14 新增（Finding 2）：只校正狀態、絕對不寄信的維運工具——把部署
 * 前／中發現的過期 sending 收件人轉成 delivery_unknown，並用重新查詢到的
 * 真實分佈更新 campaign totals／status。**不會**呼叫 sendMail、不會建立
 * SMTP transporter、不會讀 SMTP 密碼、不會認領 queued／failed／claimed
 * 收件人，也不會呼叫 sendPendingRecipients——這些能力完全不在
 * ReconcileCampaignDeliveryDeps 這個介面裡，結構上就不可能被誤用。
 *
 * 唯一用途：取代過去 runbook 誤建議的「受控觸發 retryCampaign」——那是
 * 完整的正常寄送流程，會真的寄信；這支只做狀態校正，見
 * shared/campaignSend.ts 的 reconcileCampaignDelivery 說明。
 */
/**
 * round 18 新增（Finding 2 項目 5／6／7）：reconciliation 只是「校正卡住的
 * sending 收件人」的工具，只有 classifyCampaignForDrainAudit() 判定
 * UNKNOWN（sending 收件人 lease 過期、其餘一切健康）時才是正確的使用
 * 情境。ACTIVE（真的還在合法處理中）、INDETERMINATE（資料本身有問題，
 * 需要先人工查清楚，不能假設 reconciliation 能修好）、EXHAUSTED
 *（reconciliation 自己的 acquireLease 也會被 generation-exhausted 擋
 * 下）、SAFE（沒有東西需要校正）都不是 reconciliation 該處理的情境。
 *
 * 這裡跟 ops-campaign-repair.mjs 的 loadClassification() 用同一套
 * field-mask 查詢＋classifyCampaignForDrainAudit()，是同一份純函式的
 * 兩份呼叫端（不是兩份分類邏輯）——避免 CLI 的 runbook 建議跟 production
 * 實際允許的範圍漂移。
 *
 * ⚠️ 這只是一道快速失敗、改善錯誤訊息用的前置檢查，**不是**唯一的安全
 * 機制——這次讀到的分類在檢查完之後、真正執行 reconciliation 之前的
 * 極短時間內仍可能過期（TOCTOU）。真正的安全保證來自
 * reconcileCampaignDelivery() 自己在取得租約「之後」立刻重新讀取全部
 * 收件人狀態的驗證（見 shared/campaignSend.ts 的
 * areAllRecipientStatusesKnown 說明）——這裡的前置檢查失敗只會擋下明顯
 * 不該嘗試的呼叫，就算這裡誤判通過，後面仍然會被攔下來，不會產生部分
 * 寫入。
 */
async function classifyCampaignForReconciliationGate(campaignRef: FirebaseFirestore.DocumentReference) {
  // ⚠️ DocumentReference 本身沒有 .select()（那是 Query／CollectionReference
  // 的方法）——這是伺服器端內部的前置檢查，資料完全不會回傳給前端，不像
  // audit-campaign-drain.mjs 那樣需要用 field mask 避免下載無關欄位，這裡
  // 直接整份讀取即可。
  const snap = await campaignRef.get()
  if (!snap.exists) return null
  const data = snap.data() as Record<string, unknown>
  const recipientsSnap = await campaignRef
    .collection('recipients')
    .select('status', 'leaseExpiresAtMs', 'leaseExpiresAt')
    .get()
  const recipients = recipientsSnap.docs.map((d) => {
    const r = d.data()
    return { status: r.status, leaseExpiresAtMs: r.leaseExpiresAtMs, leaseExpiresAtLegacy: r.leaseExpiresAt }
  })
  return classifyCampaignForDrainAudit(
    {
      campaignId: campaignRef.id,
      status: data.status,
      recipientsReady: data.recipientsReady,
      activeAttemptId: data.activeAttemptId,
      activeLeaseExpiresAtMs: data.activeLeaseExpiresAtMs,
      activeLeaseExpiresAtLegacy: data.activeLeaseExpiresAt,
      resolutionLeaseAttemptId: data.resolutionLeaseAttemptId,
      resolutionLeaseExpiresAtMs: data.resolutionLeaseExpiresAtMs,
      leaseGeneration: data.leaseGeneration,
      createdByAttemptId: data.createdByAttemptId,
      startedAtMs: data.startedAtMs,
      startedAtLegacy: data.startedAt,
      recipients,
    },
    Date.now(),
  )
}

export const reconcileCampaignDeliveryStatus = onCall<{ campaignId: string }>(async (request) => {
  await requireAdmin(request.auth)

  const { campaignId } = request.data ?? {}
  if (!campaignId || typeof campaignId !== 'string' || campaignId.includes('/')) {
    throw new HttpsError('invalid-argument', 'campaign ID 不正確。')
  }

  const campaignRef = db.collection('campaigns').doc(campaignId)

  // round 18 新增（Finding 2 項目 6）：production callable 自己也要執行
  // 分類前置檢查，不能只靠 CLI／runbook 的人工紀律。
  const gateClassification = await classifyCampaignForReconciliationGate(campaignRef)
  if (gateClassification && gateClassification.classification !== 'UNKNOWN') {
    throw new HttpsError(
      'failed-precondition',
      `這筆發送目前的稽核分類是 ${gateClassification.classification}，不是 reconciliation 該處理的情境` +
        '（reconciliation 只用來校正 UNKNOWN：sending 收件人租約過期，其餘健康）。' +
        'ACTIVE 請等待自然完成；INDETERMINATE 需要先人工檢查資料；EXHAUSTED 需要人工 escalation；' +
        'SAFE 代表沒有東西需要校正。',
    )
  }

  const reconciliationAttemptId = randomUUID()
  // reconcileCampaignDelivery() 保證 acquireLease() 一定會先被呼叫、且
  // 成功之後才會呼叫其他任何 deps——這裡用一個閉包捕捉的變數把 acquire
  // 拿到的 generation 帶給下面的 reclaimExpiredDeliveryAttempt／finalize／
  // releaseLeaseBestEffort，不需要另外改介面把 generation 傳來傳去。
  let acquiredGeneration = -1

  const deps: ReconcileCampaignDeliveryDeps = {
    acquireLease: async () => {
      const decision = await acquireCampaignLease(campaignRef, reconciliationAttemptId)
      if (decision.outcome === 'acquired') acquiredGeneration = decision.generation
      return decision
    },
    // round 18 新增（Finding 2）：取得租約之後第一件事——讀「全部」收件人
    // 的 status（field mask，不含 email／姓名等 PII），交給
    // reconcileCampaignDelivery() 內部的 areAllRecipientStatusesKnown()
    // 驗證。
    listAllRecipientStatuses: async () => {
      const snap = await campaignRef.collection('recipients').select('status').get()
      return snap.docs.map((d) => ({ status: d.data().status }))
    },
    listSendingRecipientIds: async () => {
      const snap = await campaignRef.collection('recipients').where('status', '==', 'sending').get()
      return snap.docs.map((d) => d.id)
    },
    reclaimExpiredDeliveryAttempt: (recipientId) =>
      db.runTransaction((tx) =>
        reclaimExpiredDeliveryAttemptTx(
          docTx(tx, campaignRef.collection('recipients').doc(recipientId)),
          docTx(tx, campaignRef),
          reconciliationAttemptId,
          acquiredGeneration,
          Date.now(),
          '維運人員手動校正：寄送租約已過期，SMTP 可能已經開始但無法確認結果，需要人工檢查',
          () => ({ updatedAt: FieldValue.serverTimestamp() }),
        ),
      ),
    // round 19 新增（Finding 3）：這是 finalize() 之前最後一次讀取
    // recipient 狀態——跟稍早 listAllRecipientStatuses() 的驗證讀取是
    // 兩次獨立的 Firestore 查詢，中間夾著整個 reclaim 迴圈，這裡再驗證一
    // 次「當下」讀到的資料，不假設兩次讀取之間必然一致（見
    // shared/campaignSend.ts 的 ReconcileCampaignDeliveryDeps.computeAuthoritativeTotals
    // 說明，含所有已知會寫入 recipient.status 的 production 路徑與各自的
    // transaction fencing 證據）。
    computeAuthoritativeTotals: async () => {
      const snap = await campaignRef.collection('recipients').get()
      const statuses = snap.docs.map((d) => ({ status: (d.data() as RecipientDoc).status }))
      if (!areAllRecipientStatusesKnown(statuses)) {
        logger.warn(
          'reconcileCampaignDeliveryStatus：重新查詢 authoritative totals 時發現無法辨識的收件人狀態',
          { campaignPath: campaignRef.path },
        )
        return { outcome: 'invalid-recipient-state' as const }
      }
      return {
        outcome: 'ok' as const,
        ...computeAuthoritativeRecipientTotals(statuses as { status: RecipientDoc['status'] }[]),
      }
    },
    // round 15 修正（Finding 5）：跟 finalizeCampaign()（sendCampaign／
    // retryCampaign 用的正常收尾）套用完全相同的 completedAt 語意——
    // completed／failed／needs_review 才設定 completedAt；round 14 版本
    // 只刪租約、完全不碰 completedAt，會讓這幾種終止狀態缺少 completedAt。
    // 另外新增 partial 時明確清掉 completedAt（round 14／正常 finalize
    // 都沒有這一步）：這個 campaign 理論上不該在持有處理租約時就已經有
    // completedAt（那只會在先前的 terminal 收尾才會被設定，terminal 又
    // 不可能再被重新 acquire），但這裡仍然明確處理，不依賴「不可能發生」
    // 的假設，避免任何殘留的 terminal 時間戳誤導讀者。
    //
    // round 16 修正（Finding 4）：跟 finalizeCampaign() 一樣改用
    // finalizeCampaignWithPressReleaseTx——新聞稿的 status／sentAt 同步
    // 現在跟 campaign finalize 是同一個 transaction，不再是校正成功之後
    // 才另外做的一次獨立寫入（round 15 版本正是這樣，也是 Finding 4 的
    // 原始問題來源）。deps.finalize 的回傳型別維持 FinalizeDecision 不變
    // （reconcileCampaignDelivery() 的 orchestration 邏輯不需要知道新聞稿
    // 有沒有被同步），這裡只回傳 `.finalize` 那一半。
    finalize: async (totals, nonTerminalCount) => {
      const decision = await db.runTransaction((tx) =>
        finalizeCampaignWithPressReleaseTx(
          docTx(tx, campaignRef),
          (pressReleaseId) => docTx(tx, db.collection('pressReleases').doc(pressReleaseId)),
          reconciliationAttemptId,
          acquiredGeneration,
          Date.now(),
          totals,
          nonTerminalCount,
          (d) => ({
            activeAttemptId: FieldValue.delete(),
            activeLeaseExpiresAtMs: FieldValue.delete(),
            updatedAt: FieldValue.serverTimestamp(),
            ...(d.outcome === 'completed' || d.outcome === 'failed' || d.outcome === 'needs_review'
              ? { completedAt: FieldValue.serverTimestamp() }
              : d.outcome === 'partial'
                ? { completedAt: FieldValue.delete() }
                : {}),
          }),
          () => ({ status: 'sent', sentAt: FieldValue.serverTimestamp() }),
          // round 18 新增（Finding 1）：blocked 時的安全釋放欄位。
          () => ({
            activeAttemptId: FieldValue.delete(),
            activeLeaseExpiresAtMs: FieldValue.delete(),
            updatedAt: FieldValue.serverTimestamp(),
          }),
        ),
      )
      if (decision.outcome === 'blocked') {
        // round 18 修正（Finding 1）：campaign 完全沒有變成 terminal——
        // reconcileCampaignDelivery() 的 orchestration 邏輯會把這個結果
        // 轉譯成獨立的 outcome:'blocked'，不會被誤判成 reconciled。
        logger.error('reconcileCampaignDeliveryStatus：新聞稿同步中繼資料無法安全判斷，校正被阻擋', {
          campaignPath: campaignRef.path,
          reason: decision.reason,
        })
        return decision
      }
      if (decision.pressReleaseUpdated) {
        logger.info('reconcileCampaignDeliveryStatus：同步更新了新聞稿的已發送狀態', {
          campaignPath: campaignRef.path,
        })
      }
      return decision.finalize
    },
    // round 15 新增（Finding 2）：取得租約後若發生未預期例外，安全釋放
    // 這次持有的租約——只在確認自己仍然合法持有時才會真的清掉欄位，見
    // releaseCampaignProcessingLeaseTx 的說明。只清租約欄位，不碰
    // status／totals／completedAt／recipient。
    releaseLeaseBestEffort: async () => {
      await db.runTransaction((tx) =>
        releaseCampaignProcessingLeaseTx(
          docTx(tx, campaignRef),
          reconciliationAttemptId,
          acquiredGeneration,
          () => ({
            activeAttemptId: FieldValue.delete(),
            activeLeaseExpiresAtMs: FieldValue.delete(),
            updatedAt: FieldValue.serverTimestamp(),
          }),
        ),
      )
    },
    logWarn: (message, meta) => logger.warn(message, { campaignPath: campaignRef.path, ...meta }),
    logError: (message, meta) => logger.error(message, { campaignPath: campaignRef.path, ...meta }),
  }

  try {
    const result = await reconcileCampaignDelivery(deps)
    if (result.outcome === 'not-found') {
      throw new HttpsError('not-found', '找不到這筆發送紀錄。')
    }
    if (result.outcome === 'terminal') {
      throw new HttpsError('failed-precondition', '這筆發送已經是最終狀態，不需要校正。')
    }
    if (result.outcome === 'not-ready') {
      throw new HttpsError('failed-precondition', '這筆發送的收件人清單尚未建立完成，無法校正。')
    }
    if (result.outcome === 'held-by-other') {
      throw new HttpsError('aborted', '這筆發送目前正在被其他操作處理中，請稍後再試一次。')
    }
    // round 15 新增（Finding 1）：finalize 沒有真正寫入（租約在極短的
    // race window 內被別人取代）——這次校正沒有生效，不能回傳 ok:true，
    // 用 aborted 讓呼叫端知道可以重試。
    if (result.outcome === 'superseded') {
      throw new HttpsError('aborted', '校正過程中租約已被其他操作取代，請重新整理後再試一次。')
    }
    if (result.outcome === 'invalid-generation' || result.outcome === 'generation-exhausted') {
      logger.error('reconcileCampaignDeliveryStatus：campaign.leaseGeneration 異常，拒絕校正', {
        campaignPath: campaignRef.path,
        outcome: result.outcome,
      })
      throw new HttpsError('internal', '這筆發送的內部狀態異常，請聯絡工程人員檢查 Firestore 資料。')
    }
    // round 18 新增（Finding 2）；round 19 修正（Finding 4，報告用詞精確
    // 化）：取得租約之後讀到至少一位收件人的 status 無法辨識——沒有
    // reclaim、沒有 finalize、沒有修改任何收件人，campaign 的 terminal
    // 欄位（status／totals／completedAt）也完全不會被寫入。但這次「取得
    // 租約」本身（acquireLease）已經寫入了 campaign 的租約欄位
    //（activeAttemptId／leaseGeneration／activeLeaseExpiresAtMs），隨後
    // 的 best-effort 釋放也是另一次寫入同一組租約欄位——準確的說法是
    //「零 recipient mutation、零 terminal 狀態寫入，但租約的取得／釋放
    // 仍會各寫一次 campaign 文件」，不是字面上的「完全沒有寫入」。這不是
    //「校正失敗」，是「資料本身不可信，拒絕校正」，需要工程人員直接檢查
    // Firestore 資料，不能重試就自動解決。
    if (result.outcome === 'invalid-recipient-state') {
      logger.error('reconcileCampaignDeliveryStatus：發現無法辨識的收件人狀態，拒絕校正', {
        campaignPath: campaignRef.path,
      })
      throw new HttpsError(
        'internal',
        '這筆發送的收件人資料中，至少有一位的狀態無法辨識，為安全起見拒絕校正，' +
          '請工程人員直接檢查 Firestore 的 recipients 子集合。',
      )
    }
    // round 18 新增（Finding 1）：新聞稿同步中繼資料無法安全判斷、或已經
    // 確認需要同步卻找不到新聞稿——campaign 完全沒有變成 terminal，只有
    // 這次的處理租約被安全釋放。明確回報 failed-precondition，不能假裝
    // 校正已經完成。
    if (result.outcome === 'blocked') {
      throw new HttpsError(
        'failed-precondition',
        result.reason === 'invalid-campaign-metadata'
          ? '這筆發送的 mode／isTest／totals.sent 欄位無法安全判斷，為安全起見拒絕校正，' +
            '請聯絡工程人員檢查這份 campaign 文件本身的資料，修好之後可以重新校正。'
          : '這筆發送已經確認需要同步新聞稿，但找不到對應的新聞稿或其 ID 有誤，為安全起見拒絕校正，' +
            '請確認新聞稿存在後重新校正。',
      )
    }
    // result.outcome === 'reconciled'：finalize 真的寫入了合法的
    // CampaignStatus，才會走到這裡。round 16 修正（Finding 4）：新聞稿的
    // status／sentAt 同步已經在上面 deps.finalize 呼叫
    // finalizeCampaignWithPressReleaseTx 時，跟 campaign finalize 一起在
    // 同一個 transaction 裡完成，這裡不需要（也不能再）另外補一次獨立的
    // pressReleases.update()——那正是 round 15 版本的問題所在：兩次分開
    // 的寫入之間存在「campaign 已經 terminal、新聞稿卻沒同步」的窗口。

    logger.info('reconcileCampaignDeliveryStatus 完成', {
      campaignPath: campaignRef.path,
      reclaimedCount: result.reclaimedCount,
      finalStatus: result.finalStatus,
    })
    return {
      ok: true,
      reclaimedCount: result.reclaimedCount,
      totals: result.totals,
      finalStatus: result.finalStatus,
    }
  } catch (err) {
    if (err instanceof HttpsError) throw err
    logger.error('reconcileCampaignDeliveryStatus 發生未預期錯誤', {
      campaignPath: campaignRef.path,
      error: (err as Error)?.message,
    })
    throw new HttpsError('internal', `校正失敗：${(err as Error)?.message ?? '未知錯誤'}`)
  }
})

/**
 * round 16 新增（Finding 4）：修復「campaign 已經是終止狀態，但對應的
 * 新聞稿沒有同步 status／sentAt」的既有資料——只在確認 campaign 已經是
 * completed／failed／needs_review 時才會考慮寫入，不會、也不能碰
 * recipient／SMTP／處理租約，結構上不存在任何寄信能力（見
 * shared/campaignSend.ts 的 repairCampaignPressReleaseSyncTx／
 * decidePressReleaseSyncRepair 說明）。
 *
 * 用途：
 * 1. 這個 PR 部署之前，Firestore 裡可能已經存在用「先 finalize、再另外
 *    update 新聞稿」這種非原子做法留下的、真的卡住的歷史資料。
 * 2. 這一輪起 finalizeCampaign()／reconciliation 都已經改成同一個
 *    transaction（見 finalizeCampaignWithPressReleaseTx），理論上不會再
 *    產生新的不同步資料，這支工具是防禦性的最後一道手段，也是部署
 *    runbook 的 bootstrap 流程需要的工具之一（見檔案上方 runbook 說明）。
 *
 * 冪等：新聞稿已經是 status:'sent' 時回傳 'already-synced'，不重複寫入，
 * 可以安全地對同一個 campaignId 重複呼叫。
 */
export const repairCampaignPressReleaseSync = onCall<{ campaignId: string }>(async (request) => {
  await requireAdmin(request.auth)

  const { campaignId } = request.data ?? {}
  if (!campaignId || typeof campaignId !== 'string' || campaignId.includes('/')) {
    throw new HttpsError('invalid-argument', 'campaign ID 不正確。')
  }

  const campaignRef = db.collection('campaigns').doc(campaignId)

  try {
    const decision = await db.runTransaction((tx) =>
      repairCampaignPressReleaseSyncTx(
        docTx(tx, campaignRef),
        (pressReleaseId) => docTx(tx, db.collection('pressReleases').doc(pressReleaseId)),
        // round 18 修正（Finding 5）：sentAt 必須是可追溯的 campaign 完成
        // 時間（campaign.completedAt），不能用修復當下的 serverTimestamp()
        // 冒充——如果修復發生在完成好幾天之後，用「現在」當作 sentAt 會
        // 誤導看報表的人。
        // round 19 修正（Finding 2）：decidePressReleaseSyncRepair() 現在
        // 回傳的是驗證過的毫秒數（authoritativeCompletedAtMs），不是原始
        // unknown 值——這裡必須自己用 Timestamp.fromMillis() 正規化成真正
        // 的 Firestore Timestamp 才能寫入 sentAt，不能把數字原樣寫進去
        //（PressRelease.sentAt 的型別是 Timestamp，前端排序／格式化都假設
        // 它有 .toMillis()／.toDate()，寫入純數字會讓排序悄悄變成 0、
        // 顯示變成「—」）。
        (authoritativeCompletedAtMs) => ({
          status: 'sent',
          sentAt: Timestamp.fromMillis(authoritativeCompletedAtMs),
        }),
        // round 20 新增（Finding 3）：alreadySynced／completedAt 合理性
        // 判斷改用明確傳入的 nowMs（不再是純函式內部讀 Date.now()）——見
        // shared/campaignSend.ts 的 isPlausibleCompletedAtMs／
        // isCanonicalSentAt 說明。這裡跟 ops-campaign-repair.mjs 用同一份
        // Date.now() 呼叫方式，但真正的判斷邏輯完全來自共用的
        // decidePressReleaseSyncRepair()，不會漂移。
        Date.now(),
      ),
    )

    if (decision.outcome === 'campaign-not-found') {
      throw new HttpsError('not-found', '找不到這筆發送紀錄。')
    }
    if (decision.outcome === 'not-terminal') {
      throw new HttpsError(
        'failed-precondition',
        '這筆發送還沒有到達最終狀態，不需要（也不能）用這個工具修復。',
      )
    }
    // round 17 新增（Finding 4）：mode／isTest／totals.sent／
    // pressReleaseId 之中有欄位無法安全判斷——不是「不需要同步」，是資料
    // 本身需要人工檢查，用獨立的錯誤訊息跟 test-campaign／
    // no-sent-recipients 等正常跳過區分開來。
    if (decision.outcome === 'invalid-campaign-metadata') {
      logger.warn('repairCampaignPressReleaseSync：新聞稿同步中繼資料無法安全判斷', {
        campaignPath: campaignRef.path,
      })
      throw new HttpsError(
        'failed-precondition',
        '這筆發送的 mode／isTest／totals.sent／pressReleaseId 其中有欄位缺失、型別錯誤或互相矛盾，' +
          '無法安全判斷是否該同步新聞稿，請先人工檢查這份 campaign 文件本身的資料。',
      )
    }
    // round 18 新增（Finding 6）：pressReleaseId 缺失、或指向的新聞稿文件
    // 不存在——都不是可以悄悄回報「ok:true」的正常情況，需要維運人員
    // 明確知道發生了什麼事，才能判斷是新聞稿被合法刪除、還是資料本身
    // 損毀。
    if (decision.outcome === 'missing-press-release-id') {
      throw new HttpsError(
        'failed-precondition',
        '這筆發送已經確認是需要同步新聞稿的正式發送，但 campaign 文件裡沒有 pressReleaseId，' +
          '這通常代表資料本身有問題，請人工檢查。',
      )
    }
    if (decision.outcome === 'press-release-not-found') {
      throw new HttpsError(
        'failed-precondition',
        '這筆發送已經確認需要同步新聞稿，但找不到 pressReleaseId 對應的新聞稿文件（可能已經被刪除）。' +
          '如果新聞稿是被合法刪除，這份 campaign 就沒有新聞稿可以同步；如果不是預期中的刪除，請人工檢查。',
      )
    }
    // round 18 新增（Finding 5）：找不到可信的完成時間，不會用修復當下的
    // 時間冒充，需要人工判斷 campaign.completedAt 為什麼缺失。
    if (decision.outcome === 'missing-authoritative-sent-time') {
      logger.warn('repairCampaignPressReleaseSync：找不到可信的完成時間（completedAt），拒絕寫入', {
        campaignPath: campaignRef.path,
      })
      throw new HttpsError(
        'failed-precondition',
        '這筆發送已經確認需要同步新聞稿，但 campaign 文件缺少可信的完成時間（completedAt），' +
          '為了避免用修復當下的時間冒充實際寄送時間，拒絕寫入，請人工檢查這份 campaign 文件。',
      )
    }

    logger.info('repairCampaignPressReleaseSync 完成', {
      campaignPath: campaignRef.path,
      outcome: decision.outcome,
    })
    return { ok: true, outcome: decision.outcome }
  } catch (err) {
    if (err instanceof HttpsError) throw err
    logger.error('repairCampaignPressReleaseSync 發生未預期錯誤', {
      campaignPath: campaignRef.path,
      error: (err as Error)?.message,
    })
    throw new HttpsError('internal', `修復失敗：${(err as Error)?.message ?? '未知錯誤'}`)
  }
})

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
  /** 「寄測試信給我」的額外收件人（除登入者外），逗號／換行分隔。 */
  testRecipients?: string
  /** 留空代表不更動現有密碼。 */
  password?: string
}

/** 後台儲存寄信設定。密碼只進 Secret Manager，不寫 Firestore。 */
export const updateSmtpSettings = onCall<SmtpSettingsRequest>(
  async (request) => {
    const admin = await requireAdmin(request.auth)
    const { host, port, user, fromEmail, replyTo, testRecipients, password } =
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
        // 正規化後存回：只留合法信箱、去重
        testRecipients: parseEmailList(testRecipients).join(', '),
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
 * 刪除新聞稿，並負責清掉它引用的 Storage 檔案（附件與各語言版本的 hero 圖）。
 *
 * 一律「先刪 Firestore 文件、確認成功後才刪 Storage 檔案」——
 * 前端過去是自己先刪 Storage 再刪 Firestore 文件，一旦後者失敗，文件會留著
 * 但引用的檔案已經不存在，記者收到的附件連結、後台下載連結都會壞掉。
 * 顛倒過來後，最壞情況只是留下孤兒檔案（不影響任何功能），而且清理失敗的
 * 檔案會記進 storageCleanupQueue，之後可以查詢、重試，不會無聲消失。
 */
export const deletePressRelease = onCall<{ pressReleaseId: string }>(
  { timeoutSeconds: 120 },
  async (request) => {
    const user = await requirePermission(request.auth, 'editPress')
    const pressReleaseId = request.data?.pressReleaseId
    if (
      !pressReleaseId ||
      typeof pressReleaseId !== 'string' ||
      pressReleaseId.includes('/')
    ) {
      throw new HttpsError('invalid-argument', '新聞稿 ID 不正確。')
    }

    const pressRef = db.collection('pressReleases').doc(pressReleaseId)
    const snap = await pressRef.get()
    if (!snap.exists) {
      // 已經被刪過了：視為成功（重試時不該因為「已經達成目標狀態」而報錯）
      return {
        ok: true,
        documentDeleted: true,
        filesRemoved: [] as string[],
        cleanupQueued: [] as string[],
        cleanupQueueWriteFailed: [] as string[],
      }
    }

    const press = snap.data() as {
      attachments?: { path?: string }[]
      versions?: Record<string, { heroImage?: { path?: string } } | undefined>
    }

    // 只清除確實屬於這篇新聞稿目錄底下的路徑 —— 就算文件內容被竄改過，
    // 也不會誤刪或誤查其他新聞稿的檔案。
    const candidatePaths = collectPressFilePaths(press)
    const paths = candidatePaths.filter(
      (p) =>
        isAllowedPressFilePath(p, pressReleaseId, 'attachments') ||
        isAllowedPressFilePath(p, pressReleaseId, 'hero'),
    )
    if (paths.length !== candidatePaths.length) {
      logger.warn('新聞稿文件內含不合法的檔案路徑，已略過', {
        pressReleaseId,
        candidatePaths,
      })
    }

    const bucket = getStorage().bucket()

    try {
      const result = await deletePressReleaseWithCleanup(paths, {
        deleteDoc: async () => {
          await pressRef.delete()
        },
        deleteFile: async (path) => {
          try {
            await bucket.file(path).delete()
          } catch (err) {
            // 檔案本來就不存在代表目標狀態已經達成，不算失敗
            if ((err as { code?: number }).code === 404) return
            throw err
          }
        },
        queueRetry: async (path, errorMessage) => {
          await db.collection('storageCleanupQueue').add({
            path,
            pressReleaseId,
            lastError: errorMessage,
            attempts: 0,
            status: 'pending',
            createdAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
          })
        },
      })
      if (result.cleanupQueueWriteFailed.length > 0) {
        // 文件已經刪除成功，但這些路徑連「記錄下來供之後重試」都失敗了 ——
        // 不能默默吞掉，這裡至少留一筆 log 讓人工可以查 Storage 手動處理。
        logger.error('部分孤兒檔案連清理佇列都寫入失敗，需要人工排查', {
          pressReleaseId,
          paths: result.cleanupQueueWriteFailed,
        })
      }
      logger.info('已刪除新聞稿', {
        pressReleaseId,
        by: user.email,
        filesRemoved: result.filesRemoved.length,
        cleanupQueued: result.cleanupQueued.length,
        cleanupQueueWriteFailed: result.cleanupQueueWriteFailed.length,
      })
      return { ok: true, ...result }
    } catch (err) {
      // 這裡失敗一定是 deleteDoc() 本身失敗 —— 檔案完全沒有被動過，
      // 文件也還在，資料狀態維持一致，可以直接請使用者重試。
      // （deleteFile／queueRetry 的失敗都在 deletePressReleaseWithCleanup 內部
      // 處理掉了，不會流到這裡，所以這個 catch 不會誤報文件其實已經刪除的情況。）
      logger.error('刪除新聞稿失敗', { pressReleaseId, err })
      throw new HttpsError(
        'internal',
        `刪除新聞稿失敗：${(err as Error).message}`,
      )
    }
  },
)

/**
 * 處理 storageCleanupQueue 裡待清理的孤兒檔案。
 *
 * deletePressRelease 刪除失敗的 Storage 檔案會先進這個佇列，但寫進去之後
 * 從來沒有任何東西真的去消化它 —— 孤兒檔案永遠留在 bucket 裡，佔用空間
 * 且沒人知道。這支是最小可行的處理器：不引入 Cloud Scheduler（會需要
 * 額外的部署設定與費用，且無法在這個環境驗證），改成 admin-only 的
 * callable，管理員可以隨時手動觸發批次處理，之後若要接排程只需要另外
 * 掛一個 Cloud Scheduler 定期呼叫這支同一個 callable 即可，邏輯不必重寫。
 *
 * 每個項目在真正嘗試刪除前，都先用 transaction 原子性地認領（租約機制與
 * sendPendingRecipients 的收件人認領完全同一套邏輯），避免兩個管理員或
 * 兩次呼叫同時處理同一個項目。
 */
export const processStorageCleanupQueue = onCall<{ limit?: number }>(
  { timeoutSeconds: 120 },
  async (request) => {
    await requireAdmin(request.auth)
    const limit = Math.min(Math.max(Number(request.data?.limit) || 50, 1), 200)
    const attemptId = randomUUID()
    const bucket = getStorage().bucket()

    // 抓比 limit 多一些候選項目，因為有些可能正被別的 processor 租用中而不可認領
    const candidateSnap = await db
      .collection('storageCleanupQueue')
      .where('status', 'in', ['pending', 'processing'])
      .limit(limit * 3)
      .get()

    let succeeded = 0
    let failed = 0
    let exhausted = 0
    let processed = 0

    for (const itemDoc of candidateSnap.docs) {
      if (processed >= limit) break

      const claimed = await db.runTransaction(async (tx) => {
        const fresh = await tx.get(itemDoc.ref)
        if (!fresh.exists) return null
        const data = fresh.data() as {
          status: 'pending' | 'processing' | 'done' | 'failed'
          leaseExpiresAt?: FirebaseFirestore.Timestamp
          attempts?: number
          path: string
        }
        const claimable = isCleanupItemClaimable(
          {
            status: data.status,
            leaseExpiresAtMs: data.leaseExpiresAt?.toMillis?.() ?? null,
          },
          Date.now(),
        )
        if (!claimable) return null
        const attempts = (data.attempts ?? 0) + 1
        tx.update(itemDoc.ref, {
          status: 'processing',
          attemptId,
          attempts,
          leaseExpiresAt: Timestamp.fromMillis(Date.now() + CLEANUP_LEASE_MS),
          updatedAt: FieldValue.serverTimestamp(),
        })
        return { path: data.path, attempts }
      })
      if (!claimed) continue
      processed += 1

      try {
        try {
          await bucket.file(claimed.path).delete()
        } catch (err) {
          // 檔案本來就不存在代表目標狀態已經達成，視為成功
          if ((err as { code?: number }).code !== 404) throw err
        }
        await commitCleanupResult(itemDoc.ref, attemptId, {
          status: 'done',
          updatedAt: FieldValue.serverTimestamp(),
          completedAt: FieldValue.serverTimestamp(),
        })
        succeeded += 1
      } catch (err) {
        const message = (err as Error)?.message ?? '未知錯誤'
        const isExhausted = hasExceededCleanupAttempts(
          claimed.attempts,
          MAX_CLEANUP_ATTEMPTS,
        )
        logger.error('清理孤兒檔案失敗', {
          path: claimed.path,
          attempts: claimed.attempts,
          exhausted: isExhausted,
          message,
        })
        await commitCleanupResult(itemDoc.ref, attemptId, {
          status: isExhausted ? 'failed' : 'pending',
          lastError: message,
          updatedAt: FieldValue.serverTimestamp(),
          ...(isExhausted ? { completedAt: FieldValue.serverTimestamp() } : {}),
        })
        if (isExhausted) exhausted += 1
        else failed += 1
      }
    }

    return {
      processed,
      succeeded,
      failed,
      exhausted,
      remainingCandidates: candidateSnap.size - processed,
    }
  },
)

/**
 * storageCleanupQueue 項目的處理結果只能由「仍持有該 attemptId」的呼叫寫入 ——
 * 與 commitRecipientResult 同樣的理由：避免逾時／崩潰的 processor 之後
 * 才完成，把另一個已經接手的 processor 的結果蓋掉。
 */
async function commitCleanupResult(
  ref: FirebaseFirestore.DocumentReference,
  attemptId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  await db.runTransaction(async (tx) => {
    const fresh = await tx.get(ref)
    if (!fresh.exists) return
    if (fresh.data()?.attemptId !== attemptId) {
      logger.warn('清理項目已被其他 processor 接手，放棄寫入結果', {
        path: ref.path,
        attemptId,
      })
      return
    }
    tx.update(ref, patch)
  })
}

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
