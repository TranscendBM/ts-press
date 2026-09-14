/**
 * sendCampaign／retryCampaign 的純決策邏輯。
 *
 * 跟 shared/policy.ts、shared/pressCleanup.ts 一樣的理由：Functions 的
 * index.ts 一載入就會 initializeApp()，測試沒辦法直接匯入，所以把「要不要
 * 重建收件人、要不要重跑、這次該處理誰、什麼時候該放棄重試、最後狀態該
 * 落在哪」這些純粹的判斷抽出來，用假資料就能測，不必連 Firestore 或真的
 * 寄信、也不必真的等 lease 過期。
 *
 * ⚠️ 重要限制：SMTP 沒有真正的 exactly-once 保證。
 * 如果 SMTP 伺服器已經接受了郵件（信已經送到記者的收件匣），但 Cloud
 * Function 在把 Firestore 的 recipient 狀態寫成 'sent' 之前就被中止
 * （逾時、崩潰、被平台強制回收），這裡設計的 lease／attemptId 機制只能
 * 保證「不會有兩個 invocation *同時* 對同一位收件人送出寄送請求」，
 * 沒辦法保證「絕對不會重複寄送」——因為外部世界（記者的信箱）已經發生的
 * 事實，我們的資料庫寫入永遠有可能追不上。這裡採取的策略是「保守偏向
 * 不重寄」：lease 時間抓得比實際寄送耗時寬裕很多（見 RECIPIENT_LEASE_MS
 * 的說明），讓「lease 過期代表對方真的死掉」這個假設在實務上盡量成立；
 * 萬一真的撞上極端情況（lease 快到期前才送出、送出後立刻被中止），
 * 寧可承擔「極低機率重複寄送一封」的風險，也不要因為過度保守而讓一篇
 * 稿子卡在 partial 永遠寄不完。這個 ambiguity 無法用程式碼完全消除，
 * 只能盡量縮小視窗，操作面請參考 campaigns/{id}/recipients 的
 * attemptCount／lastAttemptAt／lastError 欄位人工核對。
 */

/** 只接受一段安全的字元組合，避免被塞進奇怪的 Firestore 文件 ID。 */
export function isValidIdempotencyKey(key: unknown): key is string {
  return typeof key === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(key)
}

// ---------------------------------------------------------------------------
// 相容讀取：round 4 之前用 Firestore Timestamp，round 4 改成純數字毫秒
// ---------------------------------------------------------------------------
//
// campaign 的 startedAt／activeLeaseExpiresAt、收件人的 leaseExpiresAt，
// 原本都是 Firestore Timestamp；round 4 為了讓 Admin SDK（production）與
// 用戶端 SDK（測試）共用同一份協調邏輯，改成純數字毫秒（分別是
// startedAtMs／activeLeaseExpiresAtMs／leaseExpiresAtMs）。這個分支確實
// 已經部署過，不能假設現存的 Firestore 文件全部都已經是新格式——舊文件的
// Timestamp 欄位如果被當成「沒有這個欄位」處理，會讓一個其實還沒過期的
// 舊寄送 lease 被誤判成可以重新認領，造成重複寄送。這裡用 duck typing
//（`toMillis` 方法）辨認「類 Timestamp」的值，不 import 任何具體 SDK 的
// Timestamp 型別——Admin SDK 與用戶端 SDK 的 Timestamp 都提供 toMillis()，
// 讓這個純函式保持不依賴任何 SDK。

export interface TimestampLike {
  toMillis(): number
}

/** round 20 新增（Finding 3）：「這是不是一個真正的 Timestamp-like 物件」
 *  的唯一權威判斷——跟舊版的私有 `isTimestampLike` 是同一份實作，改成
 *  `export`，讓 `decidePressReleaseSyncRepair()` 之外的呼叫端（若未來需要）
 *  也能用同一份判斷，不必自己重寫一份「有 toMillis() 方法」的檢查。 */
export function isTimestampLike(value: unknown): value is TimestampLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { toMillis?: unknown }).toMillis === 'function'
  )
}

/**
 * 嘗試把單一個值讀成有效（finite）的毫秒數。
 *
 * - number：必須是 finite（拒絕 NaN／Infinity／-Infinity，那些不是合法的
 *   時間戳，讓它們流進 isLeaseActive／nowMs 減法運算只會產生垃圾結果）。
 * - Timestamp-like（有 toMillis() 方法）：呼叫 toMillis()，結果一樣要求
 *   finite；toMillis() 本身若拋錯（畸形物件），視為無效，不讓它中斷整個
 *   決策流程。
 * - 其他任何型別（字串、布林、格式錯誤的物件…）：無效。
 */
function tryReadMs(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null
  }
  if (isTimestampLike(value)) {
    try {
      const ms = value.toMillis()
      return typeof ms === 'number' && Number.isFinite(ms) ? ms : null
    } catch {
      return null
    }
  }
  return null
}

/**
 * 讀取一個可能是新格式（number，毫秒）或舊格式（Firestore Timestamp）的
 * 時間欄位，統一轉成毫秒；不是有效值就回傳 null。
 */
export function readMsCompat(value: unknown): number | null {
  return tryReadMs(value)
}

/**
 * 依序嘗試多個候選值（通常是「新格式欄位、舊格式欄位」），回傳第一個能
 * 解析出有效毫秒數的結果；全部都無效才回傳 null。
 *
 * ⚠️ 呼叫端不能寫成 `readMsCompat(data.fooMs ?? data.foo)`——`??` 只在左邊
 * 是 `null`／`undefined` 時才會退回右邊，如果 `data.fooMs` 存在但是「無效」
 * 的值（例如遷移過程中意外寫入的字串、NaN、Infinity，或格式錯誤的
 * 物件），`??` 不會退回 `data.foo`，即使那是完全有效的舊格式 Timestamp，
 * 也會被整個忽略，讓相容讀取失效、把一個其實還沒過期的舊 lease 誤判成
 * 不存在。這裡改成逐一嘗試每個候選值，只要有一個有效就用它，不管它是
 * 排在第幾個。
 */
export function readFirstValidMs(...candidates: unknown[]): number | null {
  for (const candidate of candidates) {
    const ms = tryReadMs(candidate)
    if (ms !== null) return ms
  }
  return null
}

// ---------------------------------------------------------------------------
// 時間相關常數
// ---------------------------------------------------------------------------

/**
 * sendCampaign／retryCampaign 這兩個 onCall 的 Function 逾時秒數上限。
 * 兩邊的 onCall 設定都必須直接引用這個常數（`timeoutSeconds:
 * CAMPAIGN_FUNCTION_TIMEOUT_MS / 1000`），不能各自寫死 540——否則未來
 * 兩處的 timeoutSeconds 可能各自被改動而不再一致，也會讓下面
 * CAMPAIGN_LEASE_MS 的「必須大於 Function 逾時」這個保證失去依據。
 */
export const CAMPAIGN_FUNCTION_TIMEOUT_MS = 540_000

/**
 * 整個 campaign 的處理租期。**必須大於** CAMPAIGN_FUNCTION_TIMEOUT_MS，
 * 並留一段 clock skew／收尾裕度——因為 Cloud Functions 平台是用
 * timeoutSeconds 強制終止 invocation，不是 invocation 自己算好時間提早
 * 收工。如果租期小於或接近 Function 真正會被砍斷的時間，第一個
 * invocation 在被平台強制中止前的最後幾十秒仍可能合法執行中，但租約已經
 * 自然過期，讓第二個 invocation 在它還「合法存活」時就搶到租約，兩個
 * invocation 同時處理同一個 campaign（過去 480_000 < 540_000 的 timeout
 * 就是這個可避免的並行視窗）。
 */
export const CAMPAIGN_LEASE_MS = CAMPAIGN_FUNCTION_TIMEOUT_MS + 120_000 // 660_000（11 分鐘）

/**
 * 建立 campaign 文件之後，多久沒把 recipientsReady 寫成 true 就視為
 *「建立收件人清單的過程中斷了」。這段時間內第二個呼叫只能等待，
 * 超過這個時間才能認定原本那次已經死掉。
 */
export const RECIPIENTS_SETUP_STALE_MS = 120_000

// ---------------------------------------------------------------------------
// SMTP 逾時常數：Nodemailer transport 設定與 RECIPIENT_LEASE_MS 的關係
// ---------------------------------------------------------------------------
//
// ⚠️ round 6／7 修正：Nodemailer 的 connectionTimeout／greetingTimeout／
// socketTimeout 都是「這個階段多久沒有任何動靜」的 inactivity 計時器，
// 不是整次 sendMail() 呼叫的 wall-clock 硬性上限。一個慢但持續有流量的
// 連線（伺服器回應很慢，但持續吐出 SMTP 協定的位元組，讓 inactivity
// 計時器不斷被重置）可以讓 sendMail() 實際耗費的時間遠超過這三個逾時的
// 總和，卻永遠不會觸發 Nodemailer 自己的任何逾時——如果只靠這三個設定
// 就宣稱「sendMail() 一定會在某個時間內結束」，這個保證是不成立的。
//
// functions/src/index.ts 的 sendMailWithWallClockDeadline() 用
// Promise.race() 搭配 setTimeout 對每次 sendMail() 呼叫施加一個獨立於
// Nodemailer 計時器的期限（SMTP_SEND_WALL_CLOCK_TIMEOUT_MS）——但這只是
// 讓「我們願意等多久」有個上限，**不是**底層 sendMail() 真正的硬性中止，
// 也**不保證**逾時後不會有另一個 invocation 對同一位收件人重疊寄送
// （Nodemailer 官方文件：pooled transport 的 close() 會等目前這個訊息
// 完成後才真正關閉連線，不是同步 abort）。逾時發生時，這位收件人會被標成
// delivery_unknown（見 RecipientStatus 的說明），永久排除在
// isRecipientClaimable() 的自動認領範圍之外，並停止這一批剩餘的收件人——
// 真正防止重複寄送的是「delivery_unknown 不會被自動重試」這個規則本身，
// 不是這個逾時常數。RECIPIENT_LEASE_MS 的安全下限只確保「一次合理的
// sendMail() 呼叫不會讓我們誤判成上一個 invocation 已死」，不是宣稱
// exactly-once。

/** 建立 TCP／TLS 連線的逾時上限（Nodemailer connectionTimeout）。 */
export const SMTP_CONNECTION_TIMEOUT_MS = 15_000
/** 連線建立後，等待伺服器送出 220 greeting 的逾時上限（Nodemailer greetingTimeout）。 */
export const SMTP_GREETING_TIMEOUT_MS = 15_000
/**
 * 連線建立後，允許的最長「無回應」（inactivity）時間（Nodemailer
 * socketTimeout）。這個計時器只在連線真的完全沒有任何資料流動時才會
 * 生效，用來讓「連線掛掉、伺服器完全沒回應」的情況能被 Nodemailer 提早
 * 偵測到並失敗；**不能**單獨依賴它保證整次 sendMail() 呼叫的總時間上限
 * ——見本區塊開頭的說明。
 */
export const SMTP_SOCKET_TIMEOUT_MS = 45_000

/**
 * 單一 sendMail() 呼叫「假設連線與 greeting 都要重新付出成本」時的參考
 * 估計，只作為 SMTP_SEND_WALL_CLOCK_TIMEOUT_MS 的計算基準，本身**不是**
 * 任何會被強制執行的保證——Nodemailer 不會替我們保證 sendMail() 一定在
 * 這個時間內結束或失敗，真正的強制執行來自 SMTP_SEND_WALL_CLOCK_TIMEOUT_MS。
 */
export const SMTP_MAX_SEND_ATTEMPT_MS =
  SMTP_CONNECTION_TIMEOUT_MS + SMTP_GREETING_TIMEOUT_MS + SMTP_SOCKET_TIMEOUT_MS

/**
 * 我們自己對「等待 sendMail() 回應」這件事施加的 wall-clock 上限，
 * 不是 Nodemailer 的任何一個逾時設定。
 *
 * ⚠️ round 7 修正過去的措辭：這不是 sendMail() 本身的硬性中止期限——
 * 超過這個時間，sendMailWithWallClockDeadline() 只會停止*等待*底層的
 * Promise，不代表底層的連線／傳輸真的被中止或取消（Nodemailer 官方文件：
 * pooled transport 的 close() 會等目前這個訊息完成後才真正關閉連線，
 * 不是同步 abort）。逾時之後我們完全不知道伺服器最終有沒有收下這封信。
 *
 * 這個常數真正的用途是：幫助分辨「sendMail 花的時間仍在合理範圍內、
 * RECIPIENT_LEASE_MS 應該還沒到期」跟「已經久到不能再樂觀假設」的界線，
 * 讓 sendPendingRecipients 知道什麼時候該放棄等待、把這位收件人標成
 * delivery_unknown（永久排除在一般自動認領之外，只能人工決定要不要冒著
 * 重複寄送的風險強制重寄）——不是宣稱「超過這個時間就保證沒有人會重複
 * 收到信」。真正防止「兩個 invocation 同時對同一人呼叫 sendMail」的，是
 * delivery_unknown 狀態本身，不是這個逾時常數。
 */
export const SMTP_SEND_WALL_CLOCK_TIMEOUT_MS = SMTP_MAX_SEND_ATTEMPT_MS

/** 寄送結果寫回 Firestore（commitRecipientResultTx，一次 transaction）預留的裕度。 */
export const RESULT_COMMIT_MARGIN_MS = 15_000

/**
 * 單一收件人的租期。**必須大於** SMTP_SEND_WALL_CLOCK_TIMEOUT_MS +
 * RESULT_COMMIT_MARGIN_MS——這是實際會被強制執行、我們自己保證的上界
 * （見 SMTP_SEND_WALL_CLOCK_TIMEOUT_MS 的說明），不是假設 Nodemailer
 * 自己的逾時設定就能保證 sendMail() 一定在多久之內結束。
 */
export const RECIPIENT_LEASE_MS = 105_000

/** 單一收件人最多重試幾次（含第一次），超過就標成 exhausted、不再重試。 */
export const MAX_RECIPIENT_ATTEMPTS = 5

/**
 * sendCampaign 單次呼叫最多實際寄出的封數。
 *
 * 每封信之間刻意間隔 400ms（避免被 mail2000 判定濫發），
 * 540 秒的 Function timeout 扣掉間隔與 SMTP 往返時間後，
 * 抓一個有安全餘裕的數字，避免逼近 timeout 而被中止在寄送到一半。
 * 超過上限的收件人會留在原本的狀態（queued／failed），
 * campaign 狀態標成 partial，由呼叫端另外呼叫 retryCampaign 接著寄完，
 * 而不是無限拉高 timeout 硬撐。
 */
export const SEND_BATCH_LIMIT = 300

// ---------------------------------------------------------------------------
// sendMail() 的 wall-clock 逾時保護（不依賴 Nodemailer 自己的計時器）
// ---------------------------------------------------------------------------

/**
 * 呼叫端（functions/src/index.ts 的 sendPendingRecipients）真正呼叫
 * Nodemailer 的 transporter，這裡只要求一個「有 sendMail／close 方法」的
 * duck-typed 介面——不 import nodemailer 的型別，讓這支函式保持不依賴任何
 * 特定 SDK，也才能在測試裡用一個完全可控制的假 transporter 驗證逾時、
 * 關閉、狀態行為，不需要真的連模擬器或真的寄信。
 */
export interface MailSenderLike {
  sendMail(mailOptions: unknown): Promise<unknown>
  close(): void
}

export type SendMailWithDeadlineResult =
  | { outcome: 'sent' }
  | { outcome: 'timeout'; message: string; closeError?: string }

/**
 * 讓呼叫端停止等待 sendMail()，不是讓底層寄送真的中止。
 *
 * ⚠️ round 7 修正過去的措辭：這裡的 Promise.race() + setTimeout **不是**
 * sendMail() 的硬性中止，也**不能**保證不會跟接手的下一個 invocation
 * 重疊寄送。Nodemailer 官方文件明確說明，pooled transport 的
 * `close()` 不會強制切斷正在傳輸中的訊息，該連線會等目前這個訊息完成後
 * 才真正關閉（https://nodemailer.com/smtp/pooled）——所以就算這裡呼叫了
 * `transporter.close()`，底層那個被 Promise.race() 放棄等待的
 * sendMail() 呼叫仍然可能在背景繼續執行到完成（不論最後是成功或失敗），
 * 我們完全無法得知結果、也無法確定伺服器有沒有真的收下這封信。
 *
 * 正因為「逾時」在這裡代表的是「delivery 真的不明」，不是「這次嘗試失敗，
 * 可以正常重試」，呼叫端（sendPendingRecipients）在收到
 * `{ outcome: 'timeout' }` 後，**不能**把這位收件人當成一般失敗（那樣
 * 會被 isRecipientClaimable() 判定成可以立即重新認領，讓另一個
 * invocation 對著同一個人再呼叫一次 sendMail，而背景那個逾時前的呼叫仍
 * 可能還在傳輸中）——必須寫成 `delivery_unknown`，永久排除在一般自動
 * 認領／重試之外，只能靠人工判斷是否要冒著重複寄送的風險強制重寄。
 *
 * 逾時發生時：
 * 1. 回傳 `{ outcome: 'timeout' }`（不是拋出例外）——呼叫端可以清楚分辨
 *    「sendMail 自己失敗」（一般的拒絕，繼續往外拋，交給既有的
 *    attemptCount／exhausted 重試邏輯）跟「我們主動放棄等待，delivery
 *    不明」這兩種完全不同的情況。
 * 2. 呼叫 `transporter.close()` 縮小「逾時後伺服器才真的把信送出去」的
 *    視窗（不能完全消除，見上）。`close()` 本身若拋錯，一律用 try/catch
 *    接住並記在 `closeError` 裡回傳——close 失敗**不能**改變這次仍然是
 *    `timeout` 的事實，更不能讓呼叫端誤以為「close 失敗了，所以剛才其實
 *    是普通的寄送失敗，可以繼續用這個 transporter」。
 * 3. 對底層那個被放棄等待的 sendMail() Promise 掛一個空的 `.catch()`——
 *    不論它最後多久之後才 resolve 或 reject，都不會產生 Node.js 的
 *    unhandled rejection；但完全不對那個遲來的結果採取任何行動，不會因為
 *    它事後「resolve 了」就回頭把 delivery_unknown 改寫成 sent。
 *
 * sendMail() 自己的失敗（非逾時，在期限內就直接 reject）會原樣往外拋，
 * 讓呼叫端既有的 try/catch／attemptCount／exhausted 邏輯處理，不在這裡
 * 分岔。
 */
export async function sendMailWithWallClockDeadline(
  transporter: MailSenderLike,
  mailOptions: unknown,
  timeoutMs: number,
): Promise<SendMailWithDeadlineResult> {
  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const sendMailPromise = Promise.resolve(transporter.sendMail(mailOptions))
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true
      reject(new Error(`sendMail 超過 ${timeoutMs}ms 的 wall-clock 上限——停止等待，delivery 狀態不明`))
    }, timeoutMs)
  })
  try {
    await Promise.race([sendMailPromise, deadline])
    return { outcome: 'sent' }
  } catch (err) {
    if (!timedOut) throw err
    // 底層 Promise 之後不管怎麼 settle 都不再處理，只確保不會變成
    // unhandled rejection。
    sendMailPromise.catch(() => {})
    let closeError: string | undefined
    try {
      transporter.close()
    } catch (closeErr) {
      closeError = (closeErr as Error)?.message ?? String(closeErr)
    }
    return { outcome: 'timeout', message: (err as Error).message, closeError }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// campaign 層級：建立 / 接續的判斷
// ---------------------------------------------------------------------------

export interface ExistingCampaignSummary {
  pressReleaseId?: string
  mode?: string
  status?: string
  /** 收件人子集合是否已經完整寫入。建立中（false）代表另一個 invocation 可能還在寫。 */
  recipientsReady?: boolean
  /** 建立這份 campaign 文件的時間（ms）。用來判斷 recipientsReady 卡住多久了。 */
  startedAtMs?: number | null
  /**
   * round 8 新增（Finding 4）：目前持有處理租約的 attemptId。在正確的不變量下，
   * recipientsReady 還是 false 時這個欄位必然不存在——acquireCampaignLeaseTx
   * 要求 recipientsReady===true 才會核發租約。如果兩者同時成立（false 又有
   * activeAttemptId），代表資料已經違反了應有的不變量，不能再假裝往下判斷
   * staleness，必須 fail closed。
   */
  activeAttemptId?: string | null
}

export type ResumeDecision =
  | { action: 'create' }
  | { action: 'return-existing-result' }
  | { action: 'resume' }
  | { action: 'wait-recipients-setup' }
  | { action: 'abandoned-recipients-setup' }
  | { action: 'indeterminate-recipients-setup' }
  | { action: 'inconsistent-recipients-setup' }
  | { action: 'reject'; reason: string }

/**
 * 依「是否已有同一個 idempotencyKey 對應的 campaign 文件」與這次請求的內容，
 * 決定 sendCampaign 該怎麼做：
 * - create：全新建立（沒有既有文件，或沒帶 idempotencyKey）
 * - return-existing-result：之前已經跑完（不論成敗），直接回傳當時結果，不重跑
 * - resume：之前跑到一半、收件人清單已經寫完，接續處理還沒確認寄出的收件人
 * - wait-recipients-setup：另一個 invocation 正在建立收件人清單（時間還不長），請稍後再試
 * - abandoned-recipients-setup：建立收件人清單的過程中斷太久，判定已死，需要人工處理
 * - indeterminate-recipients-setup：`startedAtMs` 無法解析（round 7 新增，
 *   見下方說明），無法判斷是「還在建立中」還是「已經中斷太久」，不能猜測
 * - inconsistent-recipients-setup：`activeAttemptId` 存在，但 recipientsReady
 *   還是 false（round 8 新增，見下方說明）——資料違反不變量，不能猜測是
 *   abandoned 還是仍在合法處理中
 * - reject：同一個 key 被用在不同的新聞稿或不同的發送模式，視為誤用
 */
export function decideCampaignResume(
  existing: ExistingCampaignSummary | undefined,
  request: { pressReleaseId: string; mode: string },
  nowMs: number,
): ResumeDecision {
  if (!existing) return { action: 'create' }
  if (
    existing.pressReleaseId !== request.pressReleaseId ||
    existing.mode !== request.mode
  ) {
    return {
      action: 'reject',
      reason:
        '這個發送識別碼已經用於另一次不同的發送，請重新整理頁面再試一次。',
    }
  }
  if (isTerminalCampaignStatus(existing.status)) {
    return { action: 'return-existing-result' }
  }
  if (existing.recipientsReady === false) {
    // round 8 修正（Finding 4）：過去這裡完全沒檢查 activeAttemptId，只在
    // 後面真正執行 reclaimAbandonedSetupTx 這個 transaction 時才會被擋下
    // （那裡本來就有 fail-closed 檢查）——但這代表這一層「早期、非交易」的
    // 判斷本身仍然可能誤判成 abandoned-recipients-setup，讓呼叫端走上
    // throwForAbandonedReclaim() 這條原本該保留給「setup owner 真的死了」
    // 的路徑，即使 transaction 最終會正確擋下、不會真的覆寫資料，回報給
    // 使用者的錯誤類型也會失真。跟 decideMarkCampaignFailed(kind:'setup')／
    // decideReclaimAbandonedSetup() 用同一個理由：recipientsReady 還是
    // false 時，activeAttemptId 這個欄位本來就不該存在，只要它存在就代表
    // 資料已經跳出了應有的不變量，必須在這裡就直接 fail closed，不能繼續
    // 往下判斷 staleness、更不能宣稱 abandoned。
    if (existing.activeAttemptId !== undefined && existing.activeAttemptId !== null) {
      return { action: 'inconsistent-recipients-setup' }
    }
    // round 7 修正：`existing.startedAtMs` 是 null 代表呼叫端（見
    // resolveCampaignResume）已經試過新舊兩種欄位格式都無法解析出有效的
    // 時間戳——不能像過去那樣退回 0（Unix epoch），那會讓 `nowMs - 0`
    // 這個巨大差值直接被誤判成「早就超過 RECIPIENTS_SETUP_STALE_MS」，
    // 把一個其實才剛開始建立、只是時間欄位資料有問題的 campaign 錯殺成
    // abandoned。無法判斷就是無法判斷，回報 indeterminate，交給人工檢查。
    if (existing.startedAtMs === null || existing.startedAtMs === undefined) {
      return { action: 'indeterminate-recipients-setup' }
    }
    if (nowMs - existing.startedAtMs > RECIPIENTS_SETUP_STALE_MS) {
      return { action: 'abandoned-recipients-setup' }
    }
    return { action: 'wait-recipients-setup' }
  }
  return { action: 'resume' }
}

// ---------------------------------------------------------------------------
// campaign 層級：resolveCampaignResume（把 decideCampaignResume 的結果轉成
// 呼叫端好處理的形狀，含 legacy startedAt 相容讀取）
// ---------------------------------------------------------------------------
//
// 這支過去是 functions/src/index.ts 裡的私有函式（resolveResume），只是
// decideCampaignResume() 外面包一層「把 action 轉成呼叫端好用的形狀」，
// 本身完全不碰 Firestore，唯一的隱藏依賴是呼叫端自己傳進來的 nowMs——
// 移進 shared/campaignSend.ts 才能讓測試直接呼叫「production 實際在跑」
// 的這份轉換邏輯（包含 legacy startedAt 相容讀取），而不是重新手刻一份
// 看起來很像的版本。sendCampaign／retryCampaign 都用得到——一個是
// 「原本就存在的既有 campaign」，一個是「原子建立時輸給併發請求，讀到
// 贏家寫入的文件」，兩種情況要走的判斷邏輯完全一樣。

export interface ExistingCampaignFields {
  pressReleaseId?: string
  mode?: string
  targetLists?: string[]
  status?: string
  recipientsReady?: boolean
  startedAtMs?: number
  /** 相容欄位：round 4 之前寫入的舊文件用 Timestamp，見 readFirstValidMs 的說明。 */
  startedAt?: unknown
  totals?: { recipients?: number }
  /** round 8 新增（Finding 4）：見 ExistingCampaignSummary.activeAttemptId 的說明。 */
  activeAttemptId?: string | null
}

export type ResumeResolution =
  | { kind: 'reject'; reason: string }
  | {
      kind: 'existing-result'
      recipients: number
      status: 'completed' | 'failed' | 'needs_review'
    }
  | { kind: 'wait' }
  | { kind: 'abandoned' }
  | { kind: 'indeterminate' }
  | { kind: 'inconsistent' }
  | { kind: 'resume'; effectiveLists: string[]; recipientsCount: number }

export function resolveCampaignResume(
  existing: ExistingCampaignFields,
  request: { pressReleaseId: string; mode: string },
  nowMs: number,
): ResumeResolution {
  const decision = decideCampaignResume(
    {
      pressReleaseId: existing.pressReleaseId,
      mode: existing.mode,
      status: existing.status,
      recipientsReady: existing.recipientsReady,
      // 相容讀取：舊文件的建立時間是 Timestamp 型別的 startedAt。呼叫端
      // 必須把 startedAtMs 與 startedAt 兩個欄位都傳進來——只傳
      // startedAtMs 的話，round 4 之前建立、只有 startedAt 沒有
      // startedAtMs 的舊 campaign 會被這裡算成 startedAtMs:null，
      // 導致下面 decideCampaignResume() 把 `nowMs - 0` 這種巨大差值
      // 誤判成「早就超過 RECIPIENTS_SETUP_STALE_MS」，即使那份舊
      // campaign 的收件人清單才剛開始建立也會被判定成 abandoned。
      startedAtMs: readFirstValidMs(existing.startedAtMs, existing.startedAt),
      // round 8 新增（Finding 4）：過去這裡完全沒有傳 activeAttemptId，讓
      // decideCampaignResume() 沒辦法在這一層就發現「recipientsReady 還是
      // false，但其實已經有人取得處理租約」這種違反不變量的資料，見上面
      // decideCampaignResume() 的說明。
      activeAttemptId: existing.activeAttemptId,
    },
    request,
    nowMs,
  )
  switch (decision.action) {
    case 'reject':
      return { kind: 'reject', reason: decision.reason }
    case 'return-existing-result':
      return {
        kind: 'existing-result',
        recipients: existing.totals?.recipients ?? 0,
        status: existing.status as 'completed' | 'failed' | 'needs_review',
      }
    case 'wait-recipients-setup':
      return { kind: 'wait' }
    case 'abandoned-recipients-setup':
      return { kind: 'abandoned' }
    case 'indeterminate-recipients-setup':
      return { kind: 'indeterminate' }
    case 'inconsistent-recipients-setup':
      return { kind: 'inconsistent' }
    case 'resume':
    case 'create':
      return {
        kind: 'resume',
        effectiveLists: existing.targetLists ?? [],
        recipientsCount: existing.totals?.recipients ?? 0,
      }
  }
}

// ---------------------------------------------------------------------------
// campaign 層級：處理租期（防止兩個 invocation 同時處理同一個 campaign）
// ---------------------------------------------------------------------------

export interface CampaignLeaseState {
  activeAttemptId?: string | null
  activeLeaseExpiresAtMs?: number | null
}

export function isLeaseActive(
  leaseExpiresAtMs: number | null | undefined,
  nowMs: number,
): boolean {
  return typeof leaseExpiresAtMs === 'number' && leaseExpiresAtMs > nowMs
}

/**
 * 這個 campaign 目前是否已經被「另一個」還沒過期租期的 attemptId 佔用中。
 *
 * ⚠️ round 8 修正（Finding 4）：過去用 `isLeaseActive(state.activeLeaseExpiresAtMs, nowMs)`
 * 判斷租約是否還有效——但 `isLeaseActive` 對 `null`／`undefined`／格式錯誤
 * 的 expiry 一律回傳 `false`（見 isLeaseActive 的實作），這代表「有其他人
 * 的 activeAttemptId，但 expiry 欄位遺失或無法解析」會被判定成「沒有生效
 * 中的租約」，跟「租約真的已經過期」混為一談，讓一個其實還可能活著、只是
 * 資料有問題的租約被當成可以核發新租約——這是 fail-open，不是 fail-closed。
 * 正確的作法：只要有其他人的 activeAttemptId，就必須「能證明」租約已經
 * 安全失效（expiry 是合法數字**而且**已經過去）才能核發新租約；無法解析
 * expiry 時，不能假設「沒填 = 沒有效」，一律當成仍被持有，寧可讓這個
 * campaign 卡住等人工處理，也不要冒著兩個 invocation 同時處理同一個
 * campaign 的風險。
 */
export function isCampaignLeaseHeldByOther(
  state: CampaignLeaseState,
  attemptId: string,
  nowMs: number,
): boolean {
  if (!state.activeAttemptId || state.activeAttemptId === attemptId) return false
  if (state.activeLeaseExpiresAtMs === null || state.activeLeaseExpiresAtMs === undefined) {
    return true
  }
  return isLeaseActive(state.activeLeaseExpiresAtMs, nowMs)
}

/**
 * round 10 新增（Finding 1／Finding 2）：campaign 文件上的單調遞增
 * fencing generation——processing 租約與 resolution 租約**共用同一個**
 * 計數器，每次任何一種租約被成功取得（acquireCampaignLeaseTx／
 * acquireResolutionLeaseTx）都會遞增一次，並把新值原子寫回。
 *
 * 為什麼不能只靠 activeAttemptId／resolutionLeaseAttemptId 字串比對：
 * - Round 9 的 resolution 租約只在「取得新租約」這一步檢查
 *   isCampaignLeaseHeldByOther()，藉此擋下新的 processing／resolution
 *   acquire。但一個**已經在執行中**的舊 processing invocation，並不會在
 *   resolution 取得租約的當下自動知道自己已經被排除——它接下來呼叫的
 *   commitRecipientResultTx／finalizeCampaignTx／markCampaignFailedTx
 *   如果只驗證 activeAttemptId 字串是否相符，會發現「相符」（resolution
 *   從不改動 activeAttemptId，只改動 resolutionLeaseAttemptId），因而誤判
 *   自己仍然安全，繼續寫入——這正是 Round 10 Finding 2 的核心問題。
 * - 用一個雙方共用的 generation，任何一次成功的 acquire（不論是哪一種
 *   租約）都會讓 generation 往前推進；每一個之後的 mutation（commit／
 *   begin／sweep／finalize／markFailed／resolve）都必須攜帶自己 acquire
 *   當下記錄的 generation，並在寫入前重新比對「現在」的 generation 是否
 *   仍然相同。只要**任何**新的租約（不論種類）被取得，generation 就會
 *   往前推進，讓所有攜帶舊 generation 的操作在同一個檢查裡自動失效——
 *   不必再各自枚舉「還要另外檢查有沒有 resolution 租約」這種容易遺漏的
 *   旁支條件。
 * - 完全沒有這個欄位時視為 0（全新 campaign 從未被任何人取得過租約）。
 *
 * ⚠️ round 13 修正（Finding 1）：round 10～12 版本用
 * `typeof value === 'number' && Number.isFinite(value) && value >= 0`
 * 判斷合法性，回傳值永遠是 `number`——這裡有兩個問題：(1) 沒有檢查
 * `Number.isSafeInteger`，`1.5`／大於 `Number.MAX_SAFE_INTEGER` 的數字都
 * 會被當成合法值放行，`+1` 之後可能因為 IEEE-754 浮點數精度不再嚴格
 * 遞增（超過 2^53 之後，`n+1 === n` 可能成立）；(2) 「欄位存在但格式
 * 錯誤」（字串、NaN、負數…）跟「欄位完全不存在」被合併成同一個結果
 * （都回傳 0）——這是 fail-open：如果 leaseGeneration 因為某種資料損毀
 * 意外被寫成非法值，呼叫端只要剛好持有 generation=0（例如從未真正
 * acquire 過的呼叫端、或本身的 generation 參數也被同樣的方式錯誤地解析
 * 成 0），比較式就會意外判定成「相符」，讓一個不該通過 fencing 的呼叫
 * 通過。
 *
 * 修正後回傳 `number | null`：`null` 專門代表「欄位存在，但不是合法的
 * 非負 safe integer」——呼叫端必須把 `null` 當成無法驗證、一律 fail
 * closed，不能繼續當數字比較（`null !== 任何呼叫端的 generation`，包含
 * `0`，這樣才不會讓一個格式錯誤的欄位意外通過比對）。只有欄位完全缺失
 *（`undefined`）才是唯一合法回退成 `0` 的情況。
 */
export function readLeaseGeneration(value: unknown): number | null {
  if (value === undefined) return 0
  if (typeof value !== 'number') return null
  if (!Number.isSafeInteger(value) || value < 0) return null
  return value
}

/**
 * round 13 新增（Finding 1）：驗證「呼叫端自己聲稱持有」的 generation
 * 參數本身是不是合法的非負 safe integer——`readLeaseGeneration()` 只負責
 * 解析『從 Firestore 讀出來的』campaign 文件欄位，呼叫端傳進來的
 * `generation`／`callerGeneration`／`resolutionGeneration` 等參數雖然在
 * TypeScript 型別上是 `number`，但執行期不保證真的合法（理論上不該發生，
 * 但這裡不假設）——所有需要比對 generation 的協調函式都必須先驗證這一項，
 * 才能安全地拿去跟 `readLeaseGeneration()` 的結果比較。 */
export function isValidGeneration(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}

/**
 * round 14 新增（Finding 1）：round 13 把 `readLeaseGeneration()`／
 * `isValidGeneration()` 同時用在兩種完全不同的語意上，兩者的合法值域
 * 其實不一樣：
 * - acquisition（decideAcquireCampaignLease／decideAcquireResolutionLease）
 *   在還沒有人合法持有租約時，`0`（不論是欄位缺失還是明確寫成 0）是唯一
 *   合法的「起始值」——下一次成功 acquire 會把它變成 1。
 * - mutation／held-lease 驗證（claim／begin／commit／sweep／finalize／
 *   markFailed／resolve）驗證的是「我現在還合法持有這個租約嗎」——任何
 *   一次成功的 acquire 回傳的 generation 都**至少是 1**（見
 *   decideAcquireCampaignLease／decideAcquireResolutionLease 的 `+1`）。
 *   round 13 讓這兩種語意共用同一組 0 起跳的驗證，造成一個具體可重現的
 *   缺口：
 *
 *     campaign = { activeAttemptId: 'A', activeLeaseExpiresAtMs: future }
 *     // leaseGeneration 缺失
 *     caller attemptId = 'A'
 *     caller generation = 0
 *
 *   `readLeaseGeneration(undefined) === 0`、`isValidGeneration(0) ===
 *   true`，兩者剛好相等，claim／begin／commit 就會誤判成「fencing
 *   通過」——即使這個 campaign 文件已經處於「activeAttemptId 存在，但
 *   leaseGeneration 缺失」這種不一致狀態（正常流程下，這兩個欄位永遠是
 *   同一次 acquire 的同一個 patch 原子寫入，不可能只有一個存在）。
 *
 *   這裡新增專門給 mutation／held-lease 驗證用的版本：`0` 與缺失都視為
 *   「無法證明目前合法持有」，一律 fail closed，不能被當成有效的 fencing
 *   token。
 */
export function readHeldLeaseGeneration(value: unknown): number | null {
  const parsed = readLeaseGeneration(value)
  if (parsed === null || parsed < 1) return null
  return parsed
}

/** round 14 新增（Finding 1）：驗證呼叫端聲稱「目前持有」的 generation——
 *  必須是 `>=1` 的 safe integer（`0` 只能是 acquisition 之前的起始值，
 *  不可能是任何合法 acquire 之後拿到的值）。所有驗證「我是否仍合法持有
 *  這個租約」的 mutation 函式都必須用這個版本，不能用 isValidGeneration()
 *（那個允許 0，是給 acquisition 情境用的）。 */
export function isValidHeldGeneration(value: number): boolean {
  return isValidGeneration(value) && value >= 1
}

/**
 * round 14 新增（Finding 1）：acquisition 專用的一致性檢查——如果
 * campaign 文件顯示「曾經有人合法持有過 processing 或 resolution 租約」
 *（activeAttemptId 或 resolutionLeaseAttemptId 任一存在），那麼
 * leaseGeneration 理論上不可能是 baseline 0（缺失或明確是 0），因為這
 * 兩者永遠是同一次成功 acquire 的同一個 patch 原子寫入。如果真的觀察到
 * 這種組合，代表資料已經跳出了正常的不變量（可能是資料損毀，或極罕見的
 * 手動編輯）——不能靜默把它當成「全新、從未被任何人 acquire 過的
 * campaign」處理，必須交給人工檢查，見 decideAcquireCampaignLease／
 * decideAcquireResolutionLease 呼叫這個函式的地方。
 */
function hasInconsistentLeaseGenerationBaseline(
  data: Record<string, unknown>,
  currentGeneration: number,
): boolean {
  if (currentGeneration !== 0) return false
  const hasProcessingAttemptId = data.activeAttemptId !== undefined && data.activeAttemptId !== null
  const hasResolutionAttemptId =
    data.resolutionLeaseAttemptId !== undefined && data.resolutionLeaseAttemptId !== null
  return hasProcessingAttemptId || hasResolutionAttemptId
}

// ---------------------------------------------------------------------------
// 收件人層級：認領（claim）與重試上限
// ---------------------------------------------------------------------------

/**
 * round 8 修正（Finding 1）：`sending`（現在代表「即將或已經呼叫過
 * sendMail」）過去跟「已經認領、但還沒真正呼叫 SMTP」共用同一個狀態，
 * 兩者被同一條「lease 過期就可以重新認領」的規則覆蓋。問題是：一旦真正
 * 呼叫過 sendMail，我們就再也無法確定「lease 過期」代表的是「上一個
 * invocation 真的死了」還是「SMTP 其實已經接受，只是寫回 Firestore（或
 * 之後的補救寫入）也失敗了，process 也剛好在這之間被中止」——後者一旦被
 * 重新認領，就會讓另一個 invocation 對同一人再呼叫一次 sendMail，而背景
 * 那個沒有機會寫回結果的呼叫，SMTP 端可能早就已經送出去了（Round 8
 * Finding 1 的原始情境）。
 *
 * 因此把「已認領但尚未開始 SMTP」與「已經進入或完成 SMTP delivery
 * attempt」拆成兩個不同的狀態：
 * - claimed：已經被原子性地搶下、記了 attemptId／lease，但**還沒**呼叫
 *   sendMail。這個階段 lease 過期只代表「上一個 invocation 大概率是還沒
 *   開始寄就死掉了」，可以安全地重新認領——跟過去的 sending 語意一致。
 * - sending：已經由 beginDeliveryAttemptTx 原子轉入，代表「即將呼叫
 *   sendMail，或已經呼叫過」。lease 過期之後**不得**被一般認領流程重新
 *   認領——只能由 reclaimExpiredDeliveryAttemptTx 原子轉成
 *   delivery_unknown，交給人工處理，理由跟 delivery_unknown 本身完全
 *   一樣：沒有任何有限的 lease 時間能證明 SMTP 最終真的沒有送達。
 */
export type RecipientStatus =
  | 'queued'
  | 'claimed'
  | 'sending'
  | 'sent'
  | 'failed'
  | 'exhausted'
  | 'delivery_unknown'

export interface RecipientLeaseState {
  status: RecipientStatus
  leaseExpiresAtMs?: number | null
  attemptCount?: number
}

/**
 * 判斷某位收件人這次是否可以被（重新）認領去嘗試寄送。
 * - sent／exhausted：終止狀態，永遠不可再認領——我們確定結果了。
 * - delivery_unknown：終止狀態，永遠不可再被這個函式認領——我們確定自己
 *   不知道結果，不能讓一般自動流程去賭它到底有沒有寄到（見
 *   RecipientStatus 的說明）。要重寄只能透過獨立的人工強制操作，不是這裡。
 * - queued／failed：可以認領。
 * - claimed：只有 lease 已過期（代表上一個 invocation 很可能在真正呼叫
 *   SMTP 之前就已經死掉）才能認領；還在租期內視為「另一個 invocation
 *   正在準備處理」，必須跳過。
 * - sending：round 8 修正（Finding 1）——**永遠**不可被這個函式認領，
 *   不論 lease 是否過期。一旦進入這個狀態就代表 SMTP 可能已經開始，
 *   任何一個有限的 lease 時間都無法證明它「已經安全失效」（見上方
 *   RecipientStatus 的說明）。過期的 sending 只能透過
 *   reclaimExpiredDeliveryAttemptTx 轉成 delivery_unknown，不會、也不能
 *   回到一般認領流程。
 */
export function isRecipientClaimable(
  r: RecipientLeaseState,
  nowMs: number,
): boolean {
  if (r.status === 'sent' || r.status === 'exhausted' || r.status === 'delivery_unknown') {
    return false
  }
  if (r.status === 'sending') return false
  if (r.status === 'claimed') return !isLeaseActive(r.leaseExpiresAtMs, nowMs)
  return true
}

/**
 * 這次寄送失敗後，attemptCount 是否已經到上限，該轉成永久失敗（exhausted）。
 *
 * ⚠️ round 14 新增（Finding 4）：這裡傳進來的 attemptCount 完全信任
 * `begin.attemptCount`（見 processOneRecipient 的說明）——如果部署重疊
 * 視窗期間，一個舊 revision 在 claim 當下寫入過「幽靈」計數（見
 * reconcileCampaignDelivery 上方 Finding 5／2 的完整說明），這個數字會
 * 比真正發生過的 SMTP attempt 次數更高。這不只是「稽核數字不好看」——
 * 直接後果是這位收件人可能**提早被判定 exhausted**，比實際情況更早
 * 永久停止自動重試，即使它真正遭遇失敗的次數還沒到
 * MAX_RECIPIENT_ATTEMPTS。目前沒有安全的方式自動扣回這個幽靈計數（無法
 * 確認舊 invocation 是否真的已經呼叫過 SMTP），這是只能靠部署 runbook
 * 的 drain 程序避免的操作限制，不是這支函式本身的邏輯錯誤。
 */
export function hasExceededMaxAttempts(
  attemptCount: number,
  max: number = MAX_RECIPIENT_ATTEMPTS,
): boolean {
  return attemptCount >= max
}

export interface RecipientForSelection extends RecipientLeaseState {
  id: string
}

/**
 * 從收件人清單中選出這次呼叫要（重新）嘗試寄送的對象。
 *
 * ⚠️ 這裡回傳的 remainingAfterBatchLimit 只回答「這次選批時，有多少
 * *現在就可以認領* 的人因為單批上限（SEND_BATCH_LIMIT）沒被排進 toProcess」
 * ——它跟「處理完這批之後，campaign 還有沒有沒完成的人」是兩個完全不同的
 * 問題，**不能共用同一個欄位**。過去的 bug 正是把這裡的 remaining 拿去
 * 決定 campaign 最終狀態：處理完一批之後如果全部人都被排進 toProcess
 * （因為總數小於 SEND_BATCH_LIMIT），這裡算出來的 remaining 就會是 0，
 * 即使那些人送出後其實變成 failed（還沒到重試上限、還沒到終止狀態），
 * 也會被誤判成「沒有人剩下了」而讓 campaign 提早變成 completed。
 *
 * 「處理完之後 campaign 還有沒有未完成的人」請用 countNonTerminalRecipients()
 * 在寄送迴圈跑完、狀態都更新之後重新查一次，不要用這裡的
 * remainingAfterBatchLimit 頂替。
 */
export function selectRecipientsToProcess(
  recipients: RecipientForSelection[],
  limit: number,
  nowMs: number,
): { toProcess: string[]; remainingAfterBatchLimit: number } {
  const seen = new Set<string>()
  const claimable: string[] = []
  for (const r of recipients) {
    if (seen.has(r.id)) continue
    seen.add(r.id)
    if (r.status === 'sent' || r.status === 'exhausted' || r.status === 'delivery_unknown') {
      continue
    }
    if (isRecipientClaimable(r, nowMs)) claimable.push(r.id)
  }
  const toProcess = claimable.slice(0, Math.max(0, limit))
  return {
    toProcess,
    remainingAfterBatchLimit: claimable.length - toProcess.length,
  }
}

export interface RecipientTerminalState {
  status: RecipientStatus
}

/**
 * 計算目前有多少收件人「還有自動處理的工作要做」（queued／failed／還沒
 * 過期的 sending）。
 *
 * 這是 decideCampaignStatus() 唯一該用的「還有沒有人沒完成」依據 ——
 * 在寄送迴圈跑完、所有狀態都寫回 Firestore 之後，重新查一次目前的真實
 * 分佈來算，不依賴選批時的 claimable 判斷（那個只回答「現在能不能認領」，
 * 跟「有沒有到終止狀態」是不同問題：queued、failed、還沒過期的 sending
 * 都算「沒完成」，即使它們這一刻可能因為租約而暫時不可認領）。
 *
 * ⚠️ round 7：delivery_unknown 刻意**不算**在非終止狀態裡——它不是
 * sent／exhausted 那種「已經有明確結果」的終止，但它也**沒有任何自動
 * 處理的工作可做**（isRecipientClaimable 對它永遠回傳 false），繼續把它
 * 算進 nonTerminalCount 只會讓 campaign 永遠卡在 partial、看起來像
 * 還在等一個永遠不會發生的自動重試。decideCampaignStatus() 改用另一個
 * 獨立的 deliveryUnknown 計數決定要不要標成 needs_review。
 */
export function countNonTerminalRecipients(
  recipients: RecipientTerminalState[],
): number {
  let count = 0
  for (const r of recipients) {
    if (r.status !== 'sent' && r.status !== 'exhausted' && r.status !== 'delivery_unknown') {
      count += 1
    }
  }
  return count
}

// ---------------------------------------------------------------------------
// campaign 最終狀態
// ---------------------------------------------------------------------------

/**
 * needs_review（round 7 新增）：所有能自動處理的收件人都已經到達終止
 * 狀態（沒有人還在 queued／failed／有效的 sending），但其中有一位以上是
 * delivery_unknown——不能假裝「completed」（不確定是不是真的全部送達），
 * 也不能假裝「failed」（很可能其實大多數都成功了，只是有幾封不確定），
 * 必須是一個獨立、誠實的狀態，讓後台清楚知道「這個 campaign 沒有自動化
 * 工作可做了，但需要人工檢查 delivery_unknown 的收件人」。
 */
export type CampaignStatus = 'partial' | 'completed' | 'failed' | 'needs_review'

/** round 18 新增（Finding 1）：`SendPhaseDeps.finalize()` 與
 *  `finalizeCampaign()`（functions/src/index.ts）等呼叫端可能回傳的完整
 *  結果集合——除了原本的 `CampaignStatus`／`'superseded'`／`'not-found'`，
 *  新增兩個「campaign 被安全阻擋、沒有變成 terminal」的結果，對應
 *  `FinalizeCampaignWithPressReleaseDecision` 的 `outcome:'blocked'`：
 *  `'blocked-invalid-campaign-metadata'`（mode／isTest／totals.sent 無法
 *  安全判斷）、`'blocked-press-release-not-found'`（已確認需要同步，但
 *  pressReleaseId／新聞稿文件有問題）。呼叫端看到這兩個值時，campaign
 *  文件本身**沒有**變成 terminal，維持原本的非終止狀態，只有這次持有的
 *  處理租約被安全釋放（如果仍然合法持有的話）；不能把它們當成
 *  'completed'／'failed' 之類的成功結果處理。 */
export type CampaignFinalizeStatus =
  | CampaignStatus
  | 'superseded'
  | 'not-found'
  | 'blocked-invalid-campaign-metadata'
  | 'blocked-press-release-not-found'

/**
 * 依「寄送完成後」的統計數字，決定 campaign 的最終狀態。
 *
 * nonTerminalCount（來自 countNonTerminalRecipients()，不是選批用的
 * remainingAfterBatchLimit）> 0 時永遠是 partial，不論這一輪本身成功或
 * 失敗 —— 只要還有 queued／failed／sending 的人沒到終止狀態，就不能
 * 提早蓋棺論定。
 *
 * nonTerminalCount === 0（所有自動化工作都做完了）之後，才看
 * totals.deliveryUnknown：> 0 就是 needs_review——這個優先順序刻意排在
 * completed／failed 的判斷之前，因為只要有任何一位收件人的送達狀態不
 * 確定，就不能誠實地說「completed」或「failed」，必須先讓人工檢查過。
 */
export function decideCampaignStatus(
  totals: { recipients: number; sent: number; deliveryUnknown: number },
  nonTerminalCount: number,
): CampaignStatus {
  if (nonTerminalCount > 0) return 'partial'
  if (totals.deliveryUnknown > 0) return 'needs_review'
  if (totals.recipients > 0 && totals.sent === 0) return 'failed'
  return 'completed'
}

/**
 * campaign 狀態機的唯一權威定義：哪些是 terminal（蓋棺論定、永遠不可再
 * 取得處理租約、不可再被 retryCampaign 接續）、哪些是可以繼續處理的。
 *
 * - terminal：'completed'、'failed'、'needs_review'。前兩者只有全部收件人
 *   都到達終止狀態（sent 或 exhausted）之後，經由 decideCampaignStatus()
 *   的正常公式「自然算出」才算數——不能因為寄送過程中發生某個全域例外，
 *   就武斷把還沒真正跑完的 campaign 直接寫成這兩種狀態之一（見
 *   runSendPhase() 的說明：已經開始處理收件人之後才發生的例外，必須先用
 *   Firestore 的真實狀態重新計算 totals／nonTerminalCount，交給這裡的
 *   正常公式判斷，不能直接假設「失敗」）。needs_review 是 terminal 是
 *   因為它同樣代表「沒有自動化工作可做了」——delivery_unknown 的收件人
 *   永遠不會被自動認領，一般 retryCampaign 對它無事可做；要處理
 *   needs_review 的 campaign，只能透過獨立的人工強制重寄操作，不是重新
 *   取得處理租約走一般寄送流程。
 * - 可繼續處理：'sending'（初始值，或中斷後保留的現況）、'partial'
 *   （明確表示還有人沒到終止狀態，可以呼叫 retryCampaign 接續，只會認領
 *   還沒到終止狀態的收件人，不會動已經 sent 或 delivery_unknown 的）。
 *
 * decideAcquireCampaignLease()、functions/src/index.ts、前端
 * CampaignDetailPage.tsx 的 needsRetry 判斷都必須以這裡的定義為準，
 * 三處不能各自维护一份可能漂移的邏輯。
 */
export function isTerminalCampaignStatus(status: string | undefined): boolean {
  return status === 'completed' || status === 'failed' || status === 'needs_review'
}

/**
 * round 20 新增（Finding 1）：`campaign.status` 是否是五個已知合法值之一
 * —— 這是判斷「這個 campaign 的狀態欄位本身能不能被信任」的唯一權威來源，
 * 供 `classifyCampaignForDrainAudit()` 使用，避免各呼叫端各自寫一份寬鬆
 * 程度不一的判斷。
 *
 * ⚠️ 背景（round 19 遺留缺口）：過去 `classifyCampaignForDrainAudit()` 只用
 * `typeof input.status === 'string'` 決定要不要把值當成合法狀態使用，任何
 * 非字串型別（`undefined`／`null`／數字／物件…）都會被悄悄改成
 * `undefined`，然後單純依賴 `isTerminalCampaignStatus(undefined)===false`
 * 讓後續判斷走「非 terminal」分支——但「非 terminal」分支
 *（`classifySetupPhaseForDrainAudit`／`auditRecipientDistribution`）本身
 * 完全不會因為「status 到底合不合法」而改變結果：只要
 * `recipientsReady===true`，`classifySetupPhaseForDrainAudit` 會直接短路
 * 回傳 `'not-setup-phase'`，`auditRecipientDistribution` 對非 terminal
 * 一律回傳 `consistent:true`——兩者都完全沒有檢查 status 欄位本身的合法性。
 * 結果是：`status` 缺失、是 `null`、是空字串、是任意亂打的字串（例如
 * 'in_progress'）、是數字或物件，只要搭配 `recipientsReady:true`、沒有
 * owner、`leaseGeneration` 合法、收件人本身沒有 lease 問題，整份 campaign
 * 就會被判成 SAFE——即使這份文件的狀態欄位根本無法辨識，稽核結果卻完全
 * 沒有反映這件事。
 *
 * 修正方式：新增這個獨立的合法性判斷，且它的結果**直接**餵進
 * `classifyCampaignForDrainAudit()` 的整體 severity 計算（見該函式內的
 * `statusValiditySeverity`），不透過 setupPhase 或 recipient distribution
 * 間接體現——不合法時一律至少是 INDETERMINATE，不論其餘欄位看起來多正常。
 *
 * 只接受下列五個字串，其餘一律視為不合法（`undefined`、`null`、空字串、
 * 任意亂打的字串、數字、布林、物件、陣列全部包含在「不合法」裡）：
 * `'sending'`、`'partial'`、`'completed'`、`'failed'`、`'needs_review'`。
 */
export type KnownCampaignStatus = 'sending' | 'partial' | 'completed' | 'failed' | 'needs_review'

const KNOWN_CAMPAIGN_STATUSES: ReadonlySet<string> = new Set<KnownCampaignStatus>([
  'sending',
  'partial',
  'completed',
  'failed',
  'needs_review',
])

export function isKnownCampaignStatus(status: unknown): status is KnownCampaignStatus {
  return typeof status === 'string' && KNOWN_CAMPAIGN_STATUSES.has(status)
}

/**
 * 前端「要不要顯示一般繼續寄送按鈕」的唯一權威判斷，跟
 * isTerminalCampaignStatus() 互補但不是簡單的相反——sending／partial 才
 * 需要（也才可能真的有用）呼叫 retryCampaign；needs_review 雖然不是
 * completed／failed 那種「全部成功或全部失敗」的乾淨結局，但它一樣沒有
 * 自動化工作可做（delivery_unknown 不會被一般 retry 認領），顯示一般的
 * 「繼續寄送」按鈕只會誤導使用者以為按下去會有用。
 */
export function isRetriableCampaignStatus(status: string | undefined): boolean {
  return status === 'sending' || status === 'partial'
}

/**
 * round 11 新增（Finding 3）：一個 campaign 的狀態是否「仍可能合法持有
 * 尚未處理的 delivery_unknown 收件人」——這是 decideAcquireResolutionLease()
 * 判斷是否允許取得 resolution 租約的唯一權威依據，前端「人工處理」按鈕的
 * 顯示條件也必須套用同一份定義，不能各自維護一份可能漂移的邏輯（跟
 * isTerminalCampaignStatus／isRetriableCampaignStatus 的用途相同）。
 *
 * - sending／partial：nonTerminalCount 可能 >0（campaign 還沒被 finalize
 *   過，或還有其他收件人在等自動重試），但 delivery_unknown 完全不算進
 *   nonTerminalCount（見 countNonTerminalRecipients 的說明），所以即使
 *   status 停在 sending／partial，也可能已經有 delivery_unknown 的收件人
 *   在等人工處理。
 * - needs_review：nonTerminalCount===0 且 totals.deliveryUnknown>0 時的
 *   正常結果，是最常見的情境。
 * - completed／failed：只有 totals.deliveryUnknown===0 時才可能到達，
 *   不可能還有需要人工處理的收件人，必須拒絕。
 * - 任何其他（未知）狀態、或還在建立收件人清單階段（見下方
 *   recipientsReady 的檢查）：fail closed，一律拒絕。
 */
export function isResolutionEligibleCampaignStatus(status: string | undefined): boolean {
  return status === 'sending' || status === 'partial' || status === 'needs_review'
}

/** 完整版本：一併驗證 recipientsReady——還在建立收件人清單階段
 *（recipientsReady !== true）的 campaign，不可能有任何 recipients 子集合
 *  文件可以人工處理，必須拒絕。 */
export function isResolutionEligibleCampaign(
  status: string | undefined,
  recipientsReady: unknown,
): boolean {
  return recipientsReady === true && isResolutionEligibleCampaignStatus(status)
}

// =============================================================================
// 可注入的 Firestore transaction 協調層
// =============================================================================
//
// 上面都是純粹的「給定資料，判斷該怎麼做」的函式，不碰任何 I/O。這裡往上
// 加一層薄的協調邏輯（讀一次文件 → 呼叫上面的純判斷 → 視結果決定要不要寫），
// 讓 production 程式碼（functions/src/index.ts，用 Admin SDK 的
// db.runTransaction()）與測試（對模擬器，用用戶端 SDK 的 runTransaction()）
// 呼叫的是同一份協調函式，差別只在各自把自己 SDK 的 tx.get/set/update
// 包成下面的 DocTx 形狀。這樣測試驗證的就是「production 實際在跑的邏輯」，
// 不是另外手寫一份看起來很像、但可能會漂移的複製品。
//
// Firestore 的 Timestamp／FieldValue.delete() 這類寫入用的特殊值在 Admin SDK
// 與用戶端 SDK 是不同的類別，沒辦法共用同一個實例。這裡的協調函式因此只碰
// 「業務欄位」（狀態、attemptId、租約用的純數字毫秒時間戳），任何需要用到
// server timestamp 或刪除欄位的部分，一律讓呼叫端用自己 SDK 的方式組成
// extra 物件、透過 callback 或參數合併進最終寫入的 patch —— 這一層完全不需
// 要知道底下接的是哪個 SDK。

export interface DocSnapshotLike {
  exists: boolean
  data: Record<string, unknown> | undefined
}

/** 呼叫端把自己 SDK 的 transaction 包成這個形狀，協調函式只透過這個介面操作 Firestore。 */
export interface DocTx {
  get(): Promise<DocSnapshotLike>
  set(data: Record<string, unknown>): void
  update(data: Record<string, unknown>): void
}

// ---------------------------------------------------------------------------
// campaign 處理租約：取得
// ---------------------------------------------------------------------------

export type AcquireLeaseDecision =
  | { outcome: 'acquired'; patch: Record<string, unknown>; generation: number }
  | { outcome: 'held-by-other' }
  | { outcome: 'terminal' }
  | { outcome: 'not-ready' }
  | { outcome: 'not-found' }
  /** round 13 新增（Finding 1）：campaign.leaseGeneration 欄位存在，但不是
   *  合法的非負 safe integer——fail closed，不核發租約、不寫入任何欄位。 */
  | { outcome: 'invalid-generation' }
  /** round 13 新增（Finding 1）：campaign.leaseGeneration 已經是
   *  Number.MAX_SAFE_INTEGER，再 +1 會超出 IEEE-754 的安全整數範圍、可能
   *  不再嚴格遞增——fail closed，不核發租約。這在實務上幾乎不可能發生
   *  （需要同一個 campaign 被 acquire 超過 2^53 次），但 fencing 的正確性
   *  依賴嚴格單調遞增，這裡不賭它「應該不會發生」。 */
  | { outcome: 'generation-exhausted' }

/**
 * 取得租約前，必須在同一個 transaction 內原子重新驗證 status／
 * recipientsReady，不能只檢查有沒有人持有租約。
 *
 * 呼叫端（sendCampaign／retryCampaign）在呼叫這支之前，通常已經用一次
 * 非交易讀取（例如 resolveResume）確認過 campaign 是 sending／partial，
 * 但那次讀取跟這個 transaction 之間有時間差——campaign 有可能在這段
 * 期間被另一個 invocation finalize 成 completed／failed 並釋放租約。
 * 如果這裡只檢查「租約沒被別人持有」，就會對一個已經是終止狀態的
 * campaign 核發租約，讓它被重新當成還在進行中的東西處理（TOCTOU）。
 *
 * - completed／failed：terminal，永遠不可再取得租約，不論租約欄位是否
 *   已經被清空。failed／completed 不是「可以重新啟動的暫時失敗」，
 *   要重新寄送必須是一次新的 sendCampaign 呼叫（新的 campaign 或走
 *   retryCampaign 產生的 partial／sending 狀態），不能靠「租約剛好過期」
 *   這種競態偷偷讓一個已經蓋棺論定的 campaign 復活。
 * - recipientsReady !== true：not-ready，setup 階段還沒完成，不該有人
 *   拿著處理租約去 sendPendingRecipients（收件人清單可能還沒寫完）。
 * - status 不是 sending／partial（理論上不會發生，防禦性檢查）：同樣視為
 *   not-ready，不核發租約。
 */
export function decideAcquireCampaignLease(
  snap: DocSnapshotLike,
  attemptId: string,
  nowMs: number,
  leaseMs: number,
): AcquireLeaseDecision {
  if (!snap.exists || !snap.data) return { outcome: 'not-found' }
  const data = snap.data
  const status = data.status as string | undefined
  if (isTerminalCampaignStatus(status)) return { outcome: 'terminal' }
  if (data.recipientsReady !== true) return { outcome: 'not-ready' }
  if (status !== 'sending' && status !== 'partial') return { outcome: 'not-ready' }
  const heldByOther = isCampaignLeaseHeldByOther(
    {
      activeAttemptId: data.activeAttemptId as string | null | undefined,
      activeLeaseExpiresAtMs: readFirstValidMs(
        data.activeLeaseExpiresAtMs,
        data.activeLeaseExpiresAt,
      ),
    },
    attemptId,
    nowMs,
  )
  if (heldByOther) return { outcome: 'held-by-other' }
  // round 9 新增（Finding 2）：resolveDeliveryUnknown 進行中時也必須擋下
  // 一般寄送，理由是它需要先拿到「查詢當下的真實收件人分佈」才能安全地
  // 增減 totals（見 decideResolveDeliveryUnknown 的說明）——如果一般寄送
  // 在它查詢之後、寫入之前插進來改了收件人狀態，query 到的分佈就已經過期，
  // 又會回到 Round 8 那個「totals 跟真實狀態脫鉤」的問題。resolution lease
  // 用跟處理租約完全相同的 isCampaignLeaseHeldByOther() 判斷是否仍然有效。
  const resolutionHeldByOther = isCampaignLeaseHeldByOther(
    {
      activeAttemptId: data.resolutionLeaseAttemptId as string | null | undefined,
      activeLeaseExpiresAtMs: readFirstValidMs(data.resolutionLeaseExpiresAtMs, undefined),
    },
    attemptId,
    nowMs,
  )
  if (resolutionHeldByOther) return { outcome: 'held-by-other' }
  // round 10 新增（Finding 1／Finding 2）：每次成功取得處理租約都讓
  // fencing generation 往前推進一次——見 readLeaseGeneration 的說明。
  // 這個 invocation 接下來所有 recipient claim／begin／commit，以及自己
  // 的 finalize／markFailed，都必須攜帶這裡回傳的 generation，任何後續
  // 的重新取得（不論是另一個 processing invocation，還是一次
  // resolveDeliveryUnknown）都會讓 generation 繼續往前推進，讓這個
  // invocation 手上的舊 generation 自動失效。
  //
  // round 13 修正（Finding 1）：readLeaseGeneration() 現在回傳
  // number | null——null 代表欄位存在但格式錯誤，這裡必須 fail closed，
  // 不能把它當成 0 繼續 +1（那樣一個格式錯誤的欄位反而會被「修好」，
  // 悄悄核發一個看似正常的租約，掩蓋了資料已經損毀的事實）。同時防止
  // 加一之後超出安全整數範圍。
  const currentGeneration = readLeaseGeneration(data.leaseGeneration)
  if (currentGeneration === null) return { outcome: 'invalid-generation' }
  // round 14 新增（Finding 1）：activeAttemptId／resolutionLeaseAttemptId
  // 任一存在，卻是 baseline 0（缺失或明確是 0）——不是可以靜默當成全新
  // campaign 的狀態，見 hasInconsistentLeaseGenerationBaseline 的說明。
  if (hasInconsistentLeaseGenerationBaseline(data, currentGeneration)) {
    return { outcome: 'invalid-generation' }
  }
  if (currentGeneration >= Number.MAX_SAFE_INTEGER) return { outcome: 'generation-exhausted' }
  const generation = currentGeneration + 1
  return {
    outcome: 'acquired',
    generation,
    patch: {
      activeAttemptId: attemptId,
      activeLeaseExpiresAtMs: nowMs + leaseMs,
      lastAttemptId: attemptId,
      leaseGeneration: generation,
    },
  }
}

/**
 * 嘗試取得 campaign 的處理租約。呼叫端可用 buildExtra 在真正寫入前補上
 * 自己 SDK 需要的額外欄位（例如 updatedAt 的 server timestamp）——round 10
 * 新增：這裡也是清掉「已經證明失效」的 resolution 租約殘留欄位的好時機
 * （只有在這個函式判定 acquired 時才會呼叫 buildExtra，這代表
 * isCampaignLeaseHeldByOther() 剛剛才確認過 resolution 租約不是仍然有效
 * 持有中——不論它是完全沒設過，還是已經過期，這時候清掉都是安全的，不會
 * 誤刪一個仍然有效的租約）。
 */
export async function acquireCampaignLeaseTx(
  doc: DocTx,
  attemptId: string,
  nowMs: number,
  leaseMs: number,
  buildExtra: (decision: AcquireLeaseDecision) => Record<string, unknown> = () => ({}),
): Promise<AcquireLeaseDecision> {
  const snap = await doc.get()
  const decision = decideAcquireCampaignLease(snap, attemptId, nowMs, leaseMs)
  if (decision.outcome === 'acquired') {
    doc.update({ ...decision.patch, ...buildExtra(decision) })
  }
  return decision
}

// ---------------------------------------------------------------------------
// 收件人：認領
// ---------------------------------------------------------------------------

export type ClaimRejectReason =
  | 'campaign-not-found'
  | 'campaign-ownership-lost'
  | 'campaign-lease-unparseable'
  | 'campaign-lease-expired'
  | 'campaign-generation-mismatch'
  /** round 13 新增（Finding 1）：campaign.leaseGeneration 存在但格式錯誤，
   *  或呼叫端自己傳入的 generation 參數本身不合法——兩者都無法安全比對，
   *  fail closed。 */
  | 'campaign-generation-invalid'

export interface ClaimDecision {
  claimable: boolean
  /** claimable:false 時，若原因跟 campaign fencing 有關，這裡會是明確的
   *  原因（不是 recipient 本身當下就不可認領的一般情況）——見
   *  decideRecipientClaim 的說明。 */
  reason?: ClaimRejectReason
  data?: Record<string, unknown>
  patch?: Record<string, unknown>
}

/**
 * 認領只是把狀態搶成 `claimed`（round 8 修正，Finding 1）——**不是**
 * 「即將呼叫 SMTP」，那一步交給下面的 beginDeliveryAttemptTx，必須在真正
 * 呼叫 sendMail 之前另外用一次 transaction 原子轉換。這裡只負責「這位
 * 收件人這次由我處理」，還沒有任何 SMTP 相關的副作用發生，所以
 * claimed 的 lease 過期後可以被安全地重新認領（見 isRecipientClaimable
 * 的說明）。
 *
 * ⚠️ round 11 修正（Finding 1）：round 10 的說明曾經寫「這裡不需要另外讀
 * campaign 文件」——這個判斷已被證明不成立。claim 雖然還沒呼叫 SMTP，
 * 但它確實會改變 resolveDeliveryUnknown 正在保護的「authoritative
 * recipient distribution」：把一位收件人從 failed 改成 claimed，就已經讓
 * resolution 稍早查到的統計數字過期。可重現的時序是：舊 invocation A 的
 * campaign 處理租約過期後，resolution R 取得租約（generation 往前推進）、
 * 查詢到一份 authoritative totals；A 在這之後才呼叫 claimRecipientTx——
 * 如果 claim 完全不讀 campaign，就會在 R 的 transaction 尚未寫入前，悄悄
 * 把某位收件人改成 claimed，讓 R 隨後寫入的 totals 跟 recipients 子集合
 * 的真實狀態脫鉤。因此 claim 現在也必須跟 begin／commit 一樣，在同一個
 * transaction 內同時讀 recipient 與 campaign，原子驗證：
 * - campaign 存在；
 * - campaign.activeAttemptId === 呼叫端的 attemptId；
 * - campaign 的處理租約可解析且尚未過期；
 * - campaign.leaseGeneration === 呼叫端持有的 generation（見
 *   readLeaseGeneration 的說明——這一項同時涵蓋「有沒有新的 processing
 *   invocation 接手」與「有沒有 resolution 正在進行中」兩種情況）。
 * 任一條件不成立都完全不修改 recipient，也不會累加 attemptCount，並回傳
 * 明確的 reason（不是模糊的 claimable:false）。因為 claim 現在也會讀
 * campaign 文件，resolution 取得租約時對 campaign 的寫入，會讓同時進行中
 * 的 claim transaction 因為 Firestore 的樂觀並行控制而衝突、被迫重試——
 * 重試之後這裡的 generation 比對就會直接擋下它，不必只靠記憶體裡的
 * generation 判斷。
 *
 * round 10 新增（Finding 1／Finding 2）：一併記下呼叫端目前持有的
 * campaign 處理租約 generation（claimGeneration），供之後
 * commitRecipientResultTx 在寫入結果前重新核對「現在」的 campaign
 * generation 是否仍然相同（見該函式的說明）。
 *
 * round 11 修正（Finding 2）：claim 階段不再累加 attemptCount——claimed
 * 明確代表「還沒呼叫過 SMTP」，如果在這裡就消耗一次重試額度，之後
 * beginDeliveryAttemptTx 因為任何原因（generation 改變、campaign lease
 * 過期…）失敗，這次根本沒有真正發生過 SMTP delivery attempt，卻永久少了
 * 一次重試機會。改成只標記 `attemptCountPending: true`，真正的累加交給
 * decideBeginDeliveryAttempt 在 claimed 原子轉成 sending 的那一刻才執行
 * （見該函式的說明，含向後相容的 migration 判斷）。
 */
export function decideRecipientClaim(
  recipientSnap: DocSnapshotLike,
  campaignSnap: DocSnapshotLike,
  attemptId: string,
  generation: number,
  nowMs: number,
  leaseMs: number,
): ClaimDecision {
  if (!recipientSnap.exists || !recipientSnap.data) return { claimable: false }
  const data = recipientSnap.data
  const claimable = isRecipientClaimable(
    {
      status: data.status as RecipientStatus,
      // 相容讀取：舊文件用 Timestamp 型別的 leaseExpiresAt，見檔案開頭
      // readMsCompat 的說明——不能把舊格式的有效租約當成不存在而立即重寄。
      leaseExpiresAtMs: readFirstValidMs(data.leaseExpiresAtMs, data.leaseExpiresAt),
    },
    nowMs,
  )
  if (!claimable) return { claimable: false, data }

  if (!campaignSnap.exists || !campaignSnap.data) {
    return { claimable: false, reason: 'campaign-not-found', data }
  }
  const campaignData = campaignSnap.data
  if (campaignData.activeAttemptId !== attemptId) {
    return { claimable: false, reason: 'campaign-ownership-lost', data }
  }
  const campaignLeaseMs = readFirstValidMs(
    campaignData.activeLeaseExpiresAtMs,
    campaignData.activeLeaseExpiresAt,
  )
  if (campaignLeaseMs === null) {
    return { claimable: false, reason: 'campaign-lease-unparseable', data }
  }
  if (!isLeaseActive(campaignLeaseMs, nowMs)) {
    return { claimable: false, reason: 'campaign-lease-expired', data }
  }
  // round 13 修正（Finding 1）：先驗證呼叫端自己的 generation 合法，再
  // 解析 campaign 的欄位——null（格式錯誤）一律 fail closed，不能被當成
  // 0 繼續比較（見 readLeaseGeneration／isValidGeneration 的說明）。
  if (!isValidHeldGeneration(generation)) {
    return { claimable: false, reason: 'campaign-generation-invalid', data }
  }
  const campaignGeneration = readHeldLeaseGeneration(campaignData.leaseGeneration)
  if (campaignGeneration === null) {
    return { claimable: false, reason: 'campaign-generation-invalid', data }
  }
  if (campaignGeneration !== generation) {
    return { claimable: false, reason: 'campaign-generation-mismatch', data }
  }

  return {
    claimable: true,
    data,
    patch: {
      status: 'claimed',
      attemptId,
      claimGeneration: generation,
      leaseExpiresAtMs: nowMs + leaseMs,
      // round 11 修正（Finding 2）：attemptCount 不在這裡累加，見上方說明。
      attemptCountPending: true,
    },
  }
}

/**
 * 嘗試認領一位收件人（轉成 claimed）；claimable 時才會真的寫入。
 *
 * round 11 修正（Finding 1）：現在需要同時讀取 recipient 與 campaign 兩份
 * 文件才能做出決定（見 decideRecipientClaim 的說明），呼叫端必須把兩者
 * 都包成 DocTx 傳進來——跟 beginDeliveryAttemptTx／commitRecipientResultTx
 * 用同一種「一次 transaction 操作兩份文件」的手法。
 */
export async function claimRecipientTx(
  recipientDoc: DocTx,
  campaignDoc: DocTx,
  attemptId: string,
  generation: number,
  nowMs: number,
  leaseMs: number,
  buildExtra: (decision: ClaimDecision) => Record<string, unknown> = () => ({}),
): Promise<ClaimDecision> {
  const recipientSnap = await recipientDoc.get()
  const campaignSnap = await campaignDoc.get()
  const decision = decideRecipientClaim(recipientSnap, campaignSnap, attemptId, generation, nowMs, leaseMs)
  if (decision.claimable && decision.patch) {
    recipientDoc.update({ ...decision.patch, ...buildExtra(decision) })
  }
  return decision
}

// ---------------------------------------------------------------------------
// 收件人：claimed → sending（真正呼叫 sendMail 前的最後一道原子閘門）
// ---------------------------------------------------------------------------

export type BeginDeliveryAttemptRejectReason =
  | 'recipient-not-found'
  | 'not-claimed'
  | 'attempt-id-mismatch'
  | 'claimed-lease-unparseable'
  | 'claimed-lease-expired'
  | 'campaign-not-found'
  | 'campaign-ownership-lost'
  | 'campaign-lease-unparseable'
  | 'campaign-lease-expired'
  | 'campaign-generation-mismatch'
  /** round 12 新增（Finding 3）：recipient.attemptCount 存在，但不是非負
   *  safe integer（NaN／負數／非整數／字串／超出
   *  Number.MAX_SAFE_INTEGER…），或即將累加就會超出 MAX_SAFE_INTEGER。 */
  | 'invalid-attempt-count'
  /** round 12 新增（Finding 3）：recipient.attemptCountPending 存在，但
   *  不是 true／false（例如字串 "true"、數字、物件）。 */
  | 'invalid-attempt-count-pending'
  /** round 12 新增（Finding 4）：recipient.claimGeneration 存在，但不是
   *  非負 safe integer。 */
  | 'claim-generation-invalid'
  /** round 12 新增（Finding 4）：recipient.claimGeneration 是合法值，但
   *  跟呼叫端目前持有的 generation 不相符。 */
  | 'claim-generation-mismatch'
  /** round 13 新增（Finding 1）：campaign.leaseGeneration 存在但格式錯誤，
   *  或呼叫端自己傳入的 generation 參數本身不合法。 */
  | 'campaign-generation-invalid'

export type BeginDeliveryAttemptDecision =
  | { applied: false; reason: BeginDeliveryAttemptRejectReason }
  | { applied: true; patch: Record<string, unknown>; attemptCount: number }

/**
 * round 8 新增、round 9 修正（Finding 1）：真正呼叫 sendMail 之前，必須
 * 先用這支把狀態從 claimed 原子轉成 sending，且**只有轉換成功才可以呼叫
 * SMTP**——這是整個狀態機唯一真正防止「兩個 invocation 都以為自己可以
 * 安全呼叫 sendMail」的閘門。
 *
 * ⚠️ round 9 修正過去的漏洞：過去只檢查 status==='claimed' 且 attemptId
 * 相符，**沒有檢查 claimed 的 lease 是否仍然有效**。claim 到 begin 之間
 * 如果 invocation 暫停、event loop 被長時間阻塞、或單純執行得比預期慢，
 * claimed 的 lease 可能早就過期——過期代表「這個 lease 已經不再是任何人
 * 的合法憑證」，即使 attemptId 字串本身還是相符的舊值，也不能拿它當成
 * 「現在仍然安全」的證明去呼叫 SMTP。這裡新增：
 * 1. claimed lease（新舊格式都試過）必須能解析出有限的毫秒數，且必須
 *    仍未過期（nowMs 仍在 lease 內）——無法解析或已過期都 fail closed。
 * 2. 同一個 transaction 內一併重新驗證 campaign 的處理租約
 *   （activeAttemptId）仍然屬於這個 invocation，且尚未過期——避免一個
 *    已經失去 campaign 處理租約（可能已被另一個 invocation 接手）的舊
 *    invocation，僅僅因為這位收件人的 recipient-level attemptId 還沒被
 *    別人動過，就繼續呼叫 SMTP。這兩層擁有權（campaign 處理租約、
 *    recipient claimed lease）必須同時成立才能開始寄送，不能只看其中一層。
 *
 * 成功轉成 sending 時，一併重新設定：
 * - leaseExpiresAtMs = nowMs + recipientLeaseMs（從「即將呼叫 SMTP 的這一
 *   刻」重新起算滿滿一段 RECIPIENT_LEASE_MS，而不是延續 claim 時剩下的
 *   餘額——這樣才能保證 SMTP_SEND_WALL_CLOCK_TIMEOUT_MS +
 *   RESULT_COMMIT_MARGIN_MS 的安全餘裕在「真正開始寄送」的當下重新成立，
 *   不會被 claim 到 begin 之間消耗掉的時間吃掉）。
 * - deliveryStartedAtMs = nowMs（供稽核／診斷：這位收件人「真正開始寄送」
 *   的時間）。round 11 修正：attemptCount 現在也是在這一刻才累加（不再是
 *   claim 時），兩者記錄的是同一個時間點，不再像 round 10 為止那樣分開。
 *
 * ⚠️ round 10 新增（Finding 1／Finding 2）：光是 activeAttemptId 相符、
 * 租約時間也還沒過期，**不足以**證明現在真的可以安全繼續——如果這中間
 * 曾經有一次 resolveDeliveryUnknown 取得過 resolution 租約（它從不改動
 * activeAttemptId，只改動 resolutionLeaseAttemptId），沿用舊的兩個檢查
 * 會判斷成「仍然安全」，但這個 campaign 實際上已經被 resolution 標記為
 * 獨佔中。這裡額外要求 campaign 的 leaseGeneration 必須跟這個 invocation
 * 當初 acquireCampaignLeaseTx 拿到的 generation 完全相同——只要中間有
 * 任何一次新的租約（不論 processing 或 resolution）被取得，generation
 * 就會往前推進，讓這裡的比對自然失敗，不必額外檢查「有沒有 resolution
 * 租約」這種容易遺漏的旁支條件。見 readLeaseGeneration 的完整說明。
 *
 * ⚠️ round 11 新增（Finding 2）：attemptCount 代表「真正發生過的 SMTP
 * delivery attempt」次數，只有在這裡（claimed 原子轉成 sending、真正要
 * 呼叫 sendMail 前的最後一刻）才會累加——claim 階段不算數，因為 claim 到
 * 這裡之間任何原因導致 begin 失敗（generation 改變、campaign lease
 * 過期…），都代表這次根本沒有真正嘗試過 SMTP，不該消耗掉一次重試額度
 *（見 decideRecipientClaim 的說明）。
 *
 * migration-safe 判斷：這個修正部署之前，claim 當下就已經直接把
 * attemptCount 累加寫進 recipient 文件（沒有 `attemptCountPending` 這個
 * 欄位）。部署切換的當下，可能有 recipient 文件卡在「已經被舊版本 claim
 *（attemptCount 已經算過一次），但還沒 begin」的狀態，這裡不能再對它加一
 * 次，否則同一次 SMTP attempt 被算成兩次。判斷依據是 recipient 文件上是否
 * 有 `attemptCountPending === true`：
 * - true（新版本 claim 寫入的）：這次的 attemptCount 還沒被算過，這裡
 *   原子累加一次，並把 pending 標記清掉。
 * - 不是 true（沒有這個欄位，或值不是 true——舊版本 claim 寫入的文件，
 *   或理論上不會發生的其他情況）：attemptCount 已經在 claim 當下算過
 *  （或無法確認有沒有算過），這裡不重複累加，寧可低估也不要讓收件人
 *   提早被判定 exhausted。
 *
 * ⚠️ round 12 修正、round 13 再次修正並撤回部分結論（Finding 5／
 * Finding 2）：round 11 的「migration-safe」說明只涵蓋「部署前已經寫入、
 * 之後由新程式讀到」這一種情況（靜態的 at-rest 資料），**沒有**涵蓋
 * 「舊 Cloud Functions revision 仍在執行、跟新 revision 同時對同一份
 * Firestore 資料寫入」這種動態情況——這才是部署當下真正的風險視窗
 *（Cloud Functions 2nd gen 部署新版本後，已經在執行中的舊 invocation
 * 仍會被允許跑到自己的 timeoutSeconds 上限，`sendCampaign`／
 * `retryCampaign` 是 CAMPAIGN_FUNCTION_TIMEOUT_MS＝540 秒）。單一個
 * boolean marker（attemptCountPending）本身**無法**阻止一個仍在執行的舊
 * binary 寫入：舊版本的 claim 不認識這個欄位，`update()` 是部分寫入，不會
 * 清掉新版本留下的 `attemptCountPending:true`，舊 claim 自己會直接累加
 * attemptCount。
 *
 * round 12 曾經主張「下面的 claimGeneration 驗證（Finding 4）能擋下
 * Finding 5 描述的具體雙重計數情境」——**這個結論已經被 round 13 的完整
 * 三個獨立 invocation（真實 attemptId、真實遞增 generation）重現測試
 * 推翻，必須撤回**：claimGeneration 交叉驗證確實能擋下「舊 invocation
 * 覆寫 recipient 之後，新 invocation 立即用自己的身分呼叫 begin」——但
 * 這個情況會先被更早的 `recipient.attemptId` 檢查擋下（attempt-id-
 * mismatch），根本輪不到 claimGeneration 這一關。真正的問題是：舊
 * invocation 在 claim 當下寫入的 `attemptCount+1`（它自己從未真正呼叫過
 * begin／SMTP）會**永久留在**這個欄位裡，之後任何合法的新 invocation
 *（例如重新認領、真正呼叫 begin 的第三個 invocation）算出來的
 * attemptCount，都會把這個「幽靈 attempt」也算進去——完整重現顯示：只有
 * 一次真正發生過的 begin，最終 attemptCount 卻是 2。claimGeneration
 * 沒有辦法、也不可能分辨「這個 attemptCount 的當前值，有多少是真正的
 * SMTP attempt、有多少是舊 revision 的 claim-time 幽靈計數」——這兩者在
 * Firestore 裡看起來完全一樣，都只是一個數字。
 *
 * ⚠️ round 14 新增（Finding 4）：這不只是「稽核數字比較大、不好看」而
 * 已——`hasExceededMaxAttempts()` 會把這個幽靈計數當真，直接後果是這位
 * 收件人可能**提早被判定 exhausted、永久停止自動重試**，即使它真正遭遇
 * 失敗的次數還沒到 MAX_RECIPIENT_ATTEMPTS。前端「嘗試次數」欄位顯示的也
 * 會是這個高估值，讓人誤以為系統已經真的試過那麼多次。這是部署重疊
 * 視窗會造成的實際功能性影響，不是單純的美觀問題。
 *
 * 程式碼**不會**嘗試「安全地」自動扣回這個幽靈計數，因為程式碼同樣無法
 * 分辨：那個舊 invocation 有沒有可能其實已經真的呼叫過 SMTP（只是它自己
 * 的 begin 呼叫因為某種原因沒有被這裡的測試觀察到，例如它剛好在正確的
 * 時間窗內合法完成了 begin，只是這個時序恰好沒被覆寫掉）——貿然扣回
 * 可能反而低估真實的 attempt 次數，讓 exhausted 判斷失準的方向反過來。
 * 這是**程式碼層面無法單方面消除的操作限制**，claimGeneration 只是有限
 * 的縱深防禦（它確實正確擋下了「舊身分繼續 begin」這一步，只是不足以
 * 保證 attemptCount 本身的精確度），正式、可驗證的防線是遵守一次安全
 * 部署的 drain 程序（見 functions/src/index.ts 頂部的部署 runbook
 * 說明）：暫停新的發送與人工 resolution → 確認淨空（不只 status:'sending'，
 * 任何帶有效 activeAttemptId／resolutionLeaseAttemptId 的 campaign 都要
 * 檢查，見 runbook 的完整判斷標準）→ 部署 → 等待至少 CAMPAIGN_LEASE_MS
 *（660 秒／11 分鐘，即 CAMPAIGN_FUNCTION_TIMEOUT_MS 540 秒 + 120 秒
 * 緩衝）→ 再次確認淨空 → 才重新開放。
 *
 * ⚠️ round 12 新增（Finding 3）：round 11 版本用 `(data.attemptCount as
 * number | undefined) ?? 0` 與 `data.attemptCountPending === true` 直接
 * 轉型，TypeScript 的轉型不會驗證 Firestore 實際存的資料——`attemptCount`
 * 若被寫成 NaN／負數／非整數／字串，或 `attemptCountPending` 被寫成
 * `"true"`／`1`／物件，都會產生錯誤的重試計數語意（字串可能被串接、NaN
 * 讓上限比較永遠是 false、任何不是 `true` 的 pending 值都會被誤判成
 * 「已經算過」而永久低估重試次數）。這裡改用 parseAttemptCount／
 * parseAttemptCountPending 明確驗證：
 * - attemptCount 完全缺失（undefined）→ 合法的 legacy schema（從未被
 *   嘗試過的全新收件人），可以安全回退成 0。
 * - attemptCount 存在但不是「非負 safe integer」→ fail closed，回傳
 *   invalid-attempt-count，不得呼叫 SMTP。
 * - attemptCountPending 只接受 true／false／undefined 三種值，其他一律
 *   fail closed，回傳 invalid-attempt-count-pending。
 *
 * ⚠️ round 12 新增（Finding 4）：`claimGeneration` 過去只是寫入、從未被
 * 這裡讀取或驗證，註解卻宣稱它是供之後核對用——現在真的驗證它：
 * - attemptCountPending===true（新版本 claim）：claimGeneration 必須存在
 *   且是合法的非負 safe integer，並與呼叫端目前持有的 generation 完全
 *   相符，否則 fail closed（不合法回傳 claim-generation-invalid，值不符
 *   回傳 claim-generation-mismatch）。
 * - legacy 文件（attemptCountPending 缺失）：claimGeneration 缺失是合法
 *   的（舊版本 claim 從不寫這個欄位）；但如果這個欄位意外存在，仍然要
 *   套用跟上面完全相同的驗證，不能因為文件是 legacy 就放棄驗證一個
 *   剛好存在的欄位。
 */
// round 13 修正（Finding 1）：改用 Number.isSafeInteger——round 12 版本
// 只檢查 Number.isInteger，1.5 會被 isInteger 判定為 false 沒錯（isInteger
// 本身沒有這個問題），但 isInteger 對超出 2^53 的大數仍然回傳 true（例如
// 2**60 是 IEEE-754 可以精確表示成「整數形狀」的浮點數，isInteger 判定
// 為合法整數，但已經超出安全範圍，+1 之後可能不再嚴格遞增）——
// isSafeInteger 才會正確拒絕這種情況。
function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/**
 * round 13 修正（Finding 4）：attemptCount 缺失是否可以回退成 0，過去對
 * 所有 claimed 文件一視同仁，沒有結合 attemptCountPending 的狀態一起判斷
 * ——這裡改成依三種狀態分別驗證：
 *
 * - pending==='pending'（新版本 claim，還沒真正嘗試過）：缺失
 *  （undefined）可以安全視為 0——這是可證明的合法情境，claim 從不寫
 *   attemptCount，一個從未進入過 begin 的全新 queued 收件人，attemptCount
 *   本來就不會被寫過。若欄位存在，接受任何合法的非負 safe integer
 *  （包含 0：例如手動測試資料，或欄位存在但恰好是 0）。
 * - pending==='legacy'（attemptCountPending 缺失，舊版本 claim 寫入的
 *   文件）：舊版本的 claim 在把 status 轉成 claimed 的同一次寫入裡，
 *   一定會把 attemptCount 累加成至少 1（見 round 10 以前
 *   `((data.attemptCount as number) ?? 0) + 1` 的行為）——status 是
 *   claimed 卻缺少這個欄位、或欄位是 0，都不符合舊版本本身的不變量，
 *   不是可證明的 legacy schema，必須 fail closed，不能默默當成 0。
 * - pending==='counted'（attemptCountPending===false）：這代表這份文件
 *   已經被記錄成「算過一次」，同樣不可能同時缺少或是 0 這個計數本身，
 *   套用跟 legacy 完全相同的驗證。
 */
function parseAttemptCount(
  value: unknown,
  pendingState: AttemptCountPendingState,
): number | null {
  if (value === undefined) {
    return pendingState === 'pending' ? 0 : null
  }
  if (!isSafeNonNegativeInteger(value)) return null
  if (pendingState !== 'pending' && value < 1) return null
  return value
}

type AttemptCountPendingState = 'pending' | 'counted' | 'legacy'

function parseAttemptCountPending(value: unknown): AttemptCountPendingState | null {
  if (value === true) return 'pending'
  if (value === false) return 'counted'
  if (value === undefined) return 'legacy'
  return null
}

// round 14 修正（Finding 1）：claimGeneration 是 claim 當下記錄的「呼叫端
// 目前持有的 held generation」，跟 campaign.leaseGeneration 一樣，任何
// 合法值都必須 >=1（0 只可能是 acquisition 之前的起始值，claim 本身要求
// 呼叫端的 generation 先通過 isValidHeldGeneration 才能寫入，見
// decideRecipientClaim 的說明）——0 不是可以被信任的合法 legacy token。
function parseClaimGeneration(value: unknown): number | null {
  if (!isSafeNonNegativeInteger(value)) return null
  if (value < 1) return null
  return value
}

export function decideBeginDeliveryAttempt(
  recipientSnap: DocSnapshotLike,
  campaignSnap: DocSnapshotLike,
  attemptId: string,
  generation: number,
  nowMs: number,
  recipientLeaseMs: number,
): BeginDeliveryAttemptDecision {
  if (!recipientSnap.exists || !recipientSnap.data) {
    return { applied: false, reason: 'recipient-not-found' }
  }
  const data = recipientSnap.data
  if (data.status !== 'claimed') return { applied: false, reason: 'not-claimed' }
  if (data.attemptId !== attemptId) return { applied: false, reason: 'attempt-id-mismatch' }

  const claimedLeaseMs = readFirstValidMs(data.leaseExpiresAtMs, data.leaseExpiresAt)
  if (claimedLeaseMs === null) {
    return { applied: false, reason: 'claimed-lease-unparseable' }
  }
  if (!isLeaseActive(claimedLeaseMs, nowMs)) {
    return { applied: false, reason: 'claimed-lease-expired' }
  }

  if (!campaignSnap.exists || !campaignSnap.data) {
    return { applied: false, reason: 'campaign-not-found' }
  }
  const campaignData = campaignSnap.data
  if (campaignData.activeAttemptId !== attemptId) {
    return { applied: false, reason: 'campaign-ownership-lost' }
  }
  const campaignLeaseMs = readFirstValidMs(
    campaignData.activeLeaseExpiresAtMs,
    campaignData.activeLeaseExpiresAt,
  )
  if (campaignLeaseMs === null) {
    return { applied: false, reason: 'campaign-lease-unparseable' }
  }
  if (!isLeaseActive(campaignLeaseMs, nowMs)) {
    return { applied: false, reason: 'campaign-lease-expired' }
  }
  // round 13 修正（Finding 1）：null（格式錯誤）必須 fail closed，不能被
  // 當成 0 繼續比較——見 readLeaseGeneration／isValidGeneration 的說明。
  if (!isValidHeldGeneration(generation)) {
    return { applied: false, reason: 'campaign-generation-invalid' }
  }
  const campaignGeneration = readHeldLeaseGeneration(campaignData.leaseGeneration)
  if (campaignGeneration === null) {
    return { applied: false, reason: 'campaign-generation-invalid' }
  }
  if (campaignGeneration !== generation) {
    return { applied: false, reason: 'campaign-generation-mismatch' }
  }

  const pendingState = parseAttemptCountPending(data.attemptCountPending)
  if (pendingState === null) {
    return { applied: false, reason: 'invalid-attempt-count-pending' }
  }

  // Finding 4：claimGeneration 必須存在（新版本 claim）或缺失（legacy）；
  // 只要它存在，不論新舊都要驗證合法性與是否與呼叫端相符。
  if (pendingState === 'pending' || data.claimGeneration !== undefined) {
    const claimGeneration = parseClaimGeneration(data.claimGeneration)
    if (claimGeneration === null) {
      return { applied: false, reason: 'claim-generation-invalid' }
    }
    if (claimGeneration !== generation) {
      return { applied: false, reason: 'claim-generation-mismatch' }
    }
  }

  const currentAttemptCount = parseAttemptCount(data.attemptCount, pendingState)
  if (currentAttemptCount === null) {
    return { applied: false, reason: 'invalid-attempt-count' }
  }
  const shouldIncrement = pendingState === 'pending'
  if (shouldIncrement && currentAttemptCount >= Number.MAX_SAFE_INTEGER) {
    return { applied: false, reason: 'invalid-attempt-count' }
  }
  const attemptCount = shouldIncrement ? currentAttemptCount + 1 : currentAttemptCount

  return {
    applied: true,
    attemptCount,
    patch: {
      status: 'sending',
      leaseExpiresAtMs: nowMs + recipientLeaseMs,
      deliveryStartedAtMs: nowMs,
      ...(shouldIncrement ? { attemptCount, attemptCountPending: false } : {}),
    },
  }
}

/**
 * round 9 修正：現在需要同時讀取 recipient 與 campaign 兩份文件才能做出
 * 決定（見 decideBeginDeliveryAttempt 的說明），呼叫端必須把兩者都包成
 * DocTx 傳進來——跟 resolveDeliveryUnknownTx 用同一種「一次 transaction
 * 操作兩份文件」的手法。
 */
export async function beginDeliveryAttemptTx(
  recipientDoc: DocTx,
  campaignDoc: DocTx,
  attemptId: string,
  generation: number,
  nowMs: number,
  recipientLeaseMs: number,
  buildExtra: (decision: BeginDeliveryAttemptDecision) => Record<string, unknown> = () => ({}),
): Promise<BeginDeliveryAttemptDecision> {
  const recipientSnap = await recipientDoc.get()
  const campaignSnap = await campaignDoc.get()
  const decision = decideBeginDeliveryAttempt(
    recipientSnap,
    campaignSnap,
    attemptId,
    generation,
    nowMs,
    recipientLeaseMs,
  )
  if (decision.applied) {
    recipientDoc.update({ ...decision.patch, ...buildExtra(decision) })
  }
  return decision
}

// ---------------------------------------------------------------------------
// 收件人：回收過期的 delivery attempt（sending → delivery_unknown）
// ---------------------------------------------------------------------------

export interface ReclaimExpiredDeliveryAttemptDecision {
  outcome:
    | 'marked-unknown'
    | 'not-expired'
    | 'not-found'
    | 'caller-lost-campaign-lease'
  patch?: Record<string, unknown>
}

/**
 * round 8 新增、round 9 修正（Finding 1／Finding 3）：過期的 `sending`
 *（已經進入或完成 SMTP delivery attempt）不能像 `claimed` 一樣被一般
 * 認領流程重新認領（見 isRecipientClaimable 的說明），但也不能就這樣
 * 永遠卡在 sending——那會讓 campaign 永遠卡在 partial，卻沒有任何
 * 自動化工作真的在進行。這支函式是唯一能把過期的 sending 移出「沒有
 * 自動化工作可做，也沒有被算進 needs_review」這個死角的路徑：原子轉成
 * delivery_unknown，跟 sendMailWithWallClockDeadline 逾時、或
 * commitSentResultOrMarkUnknown 補救失敗時走的是同一個終止狀態，交給
 * 人工判斷。
 *
 * ⚠️ round 9 修正（Finding 3）：round 8 版本對「leaseExpiresAtMs 無法
 * 解析」回傳 indeterminate、完全不動它——結果是 recipient 永遠卡在
 * sending、被 countNonTerminalRecipients() 算成非終止、campaign 永遠卡在
 * partial，UI 卻照樣顯示「可以繼續寄送」，而 retryCampaign 每次都只會
 * 再次認為它是 sending 而跳過，形成另一個操作死路。改成保守地把它也
 * 轉成 delivery_unknown（跟「真的已過期」走同一個結果），把原始無法解析
 * 的值記進 lastError 供稽核（見 rawLeaseValueForAudit）——這是 Finding 3
 * 明確列出的兩個選項之一（「保守轉成 delivery_unknown」），理由是
 * needs_review／resolveDeliveryUnknown 這整套人工處理流程已經存在，不需要
 * 再新增一個第三種終止狀態；「不確定 lease 是否過期」本來就跟「確定 lease
 * 過期」一樣，都無法排除 SMTP 可能已經開始的疑慮，兩者交給人工判斷的
 * 迫切程度是一樣的。
 *
 * ⚠️ round 9 新增（Finding 3 item 5）：呼叫端（sweepExpiredDeliveryAttempts）
 * 執行這個回收動作時，必須是「目前仍合法持有這個 campaign 處理租約的
 * invocation」——不能讓一個自己都已經失去 campaign 處理租約的 invocation
 * （例如租約過期後被另一個 invocation 接手，新 invocation 可能正在
 * 合法地繼續等待同一位收件人的 SMTP 結果）繼續把它標成 delivery_unknown，
 * 那樣反而會誤傷新 invocation 正在合法進行中的寄送。callerAttemptId 由
 * 呼叫端傳入（sweep 當下這個 invocation 自己的 attemptId），必須跟
 * campaign 文件的 activeAttemptId 相符、且租約未過期，否則回傳
 * caller-lost-campaign-lease，完全不動這位收件人。
 *
 * 不驗證 recipient 自己的 attemptId：這支的用途正是回收「原本的
 * invocation 已經死掉、沒有人能再合法證明自己是它」的情況，安全性來自
 * 在同一個 transaction 裡即時重新驗證「現在」status 仍然是 sending、
 * 且（透過 callerAttemptId／callerGeneration）呼叫端自己仍合法持有
 * campaign 處理租約，不是相信呼叫端稍早查詢時看到的狀態。
 *
 * ⚠️ round 10 新增（Finding 1／Finding 2）：
 * 1. callerGeneration 必須跟 campaign 目前的 leaseGeneration 相同——理由
 *    跟 decideBeginDeliveryAttempt 一致：只驗證 activeAttemptId 字串與
 *    租約時間，無法偵測「中間曾經有一次 resolution 租約被取得」，見
 *    readLeaseGeneration 的說明。
 * 2. 轉成 delivery_unknown 的同時，**必須**清掉這位收件人的 attemptId／
 *    leaseExpiresAtMs（改成 null），並把原本的 attemptId 保存進
 *    deliveryUnknownOriginalAttemptId 供稽核（Finding 1 情境 A）：
 *    如果只改 status，舊的 attemptId 仍然原封不動地留在文件上，一旦
 *    「A 呼叫 SMTP → 暫停 → sweep 把它標成 delivery_unknown → A 的舊
 *    commit 終於執行」這個時序發生，commitRecipientResultTx 光靠
 *    「attemptId 是否相符」這一個條件就會誤判成「還是我」，把
 *    delivery_unknown 覆寫回 sent／failed。清掉 attemptId 之後，任何
 *    帶著舊 attemptId 的遲到 commit，在最基本的 attemptId 比對這一關
 *    就會直接失敗，不必依賴 generation 或其他更複雜的檢查才能擋下來。
 */
export function decideReclaimExpiredDeliveryAttempt(
  recipientSnap: DocSnapshotLike,
  campaignSnap: DocSnapshotLike,
  callerAttemptId: string,
  callerGeneration: number,
  nowMs: number,
  errorMessage: string,
): ReclaimExpiredDeliveryAttemptDecision {
  if (!recipientSnap.exists || !recipientSnap.data) return { outcome: 'not-found' }
  const data = recipientSnap.data
  if (data.status !== 'sending') return { outcome: 'not-expired' }

  const leaseExpiresAtMs = readFirstValidMs(data.leaseExpiresAtMs, data.leaseExpiresAt)
  const leaseTrulyExpired = leaseExpiresAtMs !== null && !isLeaseActive(leaseExpiresAtMs, nowMs)
  const leaseUnparseable = leaseExpiresAtMs === null
  if (!leaseTrulyExpired && !leaseUnparseable) {
    // 能解析出來、而且還沒過期：可能還在合法處理中，不能動它。
    return { outcome: 'not-expired' }
  }

  if (!campaignSnap.exists || !campaignSnap.data) {
    return { outcome: 'caller-lost-campaign-lease' }
  }
  const campaignData = campaignSnap.data
  if (campaignData.activeAttemptId !== callerAttemptId) {
    return { outcome: 'caller-lost-campaign-lease' }
  }
  const campaignLeaseMs = readFirstValidMs(
    campaignData.activeLeaseExpiresAtMs,
    campaignData.activeLeaseExpiresAt,
  )
  if (campaignLeaseMs === null || !isLeaseActive(campaignLeaseMs, nowMs)) {
    return { outcome: 'caller-lost-campaign-lease' }
  }
  // round 13 修正（Finding 1）：callerGeneration 本身、以及 campaign 的
  // leaseGeneration 都必須是合法值才能比較；任一方 malformed 一律視為
  // caller-lost-campaign-lease（fail closed，不回收，不誤傷任何人）。
  if (!isValidHeldGeneration(callerGeneration)) {
    return { outcome: 'caller-lost-campaign-lease' }
  }
  const campaignGeneration = readHeldLeaseGeneration(campaignData.leaseGeneration)
  if (campaignGeneration === null || campaignGeneration !== callerGeneration) {
    return { outcome: 'caller-lost-campaign-lease' }
  }

  return {
    outcome: 'marked-unknown',
    patch: {
      status: 'delivery_unknown',
      lastError: leaseUnparseable
        ? `${errorMessage}（原始 leaseExpiresAtMs 無法解析：${JSON.stringify(data.leaseExpiresAtMs ?? data.leaseExpiresAt ?? null)}）`
        : errorMessage,
      deliveryUnknownOriginalAttemptId: (data.attemptId as string | null | undefined) ?? null,
      attemptId: null,
      leaseExpiresAtMs: null,
    },
  }
}

/**
 * round 9 修正：現在需要同時讀取 recipient 與 campaign 兩份文件（見
 * decideReclaimExpiredDeliveryAttempt 的說明）。
 */
export async function reclaimExpiredDeliveryAttemptTx(
  recipientDoc: DocTx,
  campaignDoc: DocTx,
  callerAttemptId: string,
  callerGeneration: number,
  nowMs: number,
  errorMessage: string,
  buildExtra: (
    decision: ReclaimExpiredDeliveryAttemptDecision,
  ) => Record<string, unknown> = () => ({}),
): Promise<ReclaimExpiredDeliveryAttemptDecision> {
  const recipientSnap = await recipientDoc.get()
  const campaignSnap = await campaignDoc.get()
  const decision = decideReclaimExpiredDeliveryAttempt(
    recipientSnap,
    campaignSnap,
    callerAttemptId,
    callerGeneration,
    nowMs,
    errorMessage,
  )
  if (decision.outcome === 'marked-unknown' && decision.patch) {
    recipientDoc.update({ ...decision.patch, ...buildExtra(decision) })
  }
  return decision
}

// ---------------------------------------------------------------------------
// 收件人：寫入寄送結果（round 10 起：完整的 recipient／campaign 雙層
// fencing，不只是 attemptId 字串比對——見 decideCommitRecipientResult）
// ---------------------------------------------------------------------------

export type CommitRecipientResultRejectReason =
  | 'recipient-not-found'
  | 'not-sending'
  | 'attempt-id-mismatch'
  | 'recipient-lease-unparseable'
  | 'recipient-lease-expired'
  | 'campaign-not-found'
  | 'campaign-ownership-lost'
  | 'campaign-lease-unparseable'
  | 'campaign-lease-expired'
  | 'campaign-generation-mismatch'
  /** round 13 新增（Finding 1）：campaign.leaseGeneration 存在但格式錯誤，
   *  或呼叫端自己傳入的 generation 參數本身不合法。 */
  | 'campaign-generation-invalid'

export type CommitResultDecision =
  | { applied: false; reason?: CommitRecipientResultRejectReason }
  | { applied: true }

/**
 * round 10 全面重寫（Finding 1）：過去只檢查 `snap.data.attemptId ===
 * attemptId` 這一個條件——這個檢查完全沒有考慮到「sweep 已經把這位收件人
 * 轉成 delivery_unknown」或「admin 已經用 resolveDeliveryUnknown 人工
 * 處理過」這兩種情況都**沒有清除舊的 attemptId 之前**（round 9 為止）。
 * 一旦這兩種回收路徑清掉 attemptId 之前，一個延遲很久才執行完 sendMail、
 * 姍姍來遲的舊 commit，光靠 attemptId 相符就能把 sweep／人工判斷的結果
 * 整個覆寫掉（Round 10 Finding 1 情境 A／B）。
 *
 * round 10 之後，sweep（reclaimExpiredDeliveryAttemptTx）與人工 resolution
 * （resolveDeliveryUnknownTx）都會在轉換的同時清掉 attemptId／
 * leaseExpiresAtMs，所以光是「attemptId 相符」這一個條件本身就已經能擋下
 * 大部分遲到的舊 commit。但這裡仍然重新驗證完整的一組條件，不只依賴這一個
 * 副作用（防禦性設計，也符合 Finding 1 item 2 的要求）：
 *
 * - recipient.status === 'sending'——不是 sending 就代表這位收件人已經
 *   離開了「正在等待這次 SMTP 結果」的狀態（可能被 sweep 轉成
 *   delivery_unknown、被人工 resolution 處理、甚至理論上不該發生但也要
 *   防的其他狀態），不能再寫入。
 * - recipient.attemptId === attemptId——沿用原本的 ownership token 比對。
 * - recipient 的 delivery lease（leaseExpiresAtMs）尚未過期——即使
 *   attemptId 還沒被任何回收路徑清掉（例如 sweep 還沒跑到這位收件人），
 *   只要這個 invocation 自己記錄的租約時間已經過去，就不能再信任自己
 *   仍然是安全的唯一寫入者。
 * - campaign.activeAttemptId === attemptId——處理租約仍然登記在自己名下。
 * - campaign 處理租約本身尚未過期。
 * - campaign.leaseGeneration === generation——見 readLeaseGeneration 的
 *   說明：這一個條件同時涵蓋「有沒有新的 processing invocation 接手」跟
 *   「有沒有 resolution 正在進行中」兩種情況，不必再各自檢查
 *   resolutionLeaseAttemptId 是否存在。
 *
 * 任何一項不成立都 applied:false，完全不寫入。
 */
export function decideCommitRecipientResult(
  recipientSnap: DocSnapshotLike,
  campaignSnap: DocSnapshotLike,
  attemptId: string,
  generation: number,
  nowMs: number,
): CommitResultDecision {
  if (!recipientSnap.exists || !recipientSnap.data) {
    return { applied: false, reason: 'recipient-not-found' }
  }
  const data = recipientSnap.data
  if (data.status !== 'sending') return { applied: false, reason: 'not-sending' }
  if (data.attemptId !== attemptId) return { applied: false, reason: 'attempt-id-mismatch' }

  const recipientLeaseMs = readFirstValidMs(data.leaseExpiresAtMs, data.leaseExpiresAt)
  if (recipientLeaseMs === null) {
    return { applied: false, reason: 'recipient-lease-unparseable' }
  }
  if (!isLeaseActive(recipientLeaseMs, nowMs)) {
    return { applied: false, reason: 'recipient-lease-expired' }
  }

  if (!campaignSnap.exists || !campaignSnap.data) {
    return { applied: false, reason: 'campaign-not-found' }
  }
  const campaignData = campaignSnap.data
  if (campaignData.activeAttemptId !== attemptId) {
    return { applied: false, reason: 'campaign-ownership-lost' }
  }
  const campaignLeaseMs = readFirstValidMs(
    campaignData.activeLeaseExpiresAtMs,
    campaignData.activeLeaseExpiresAt,
  )
  if (campaignLeaseMs === null) {
    return { applied: false, reason: 'campaign-lease-unparseable' }
  }
  if (!isLeaseActive(campaignLeaseMs, nowMs)) {
    return { applied: false, reason: 'campaign-lease-expired' }
  }
  // round 13 修正（Finding 1）：null（格式錯誤）必須 fail closed。
  if (!isValidHeldGeneration(generation)) {
    return { applied: false, reason: 'campaign-generation-invalid' }
  }
  const campaignGeneration = readHeldLeaseGeneration(campaignData.leaseGeneration)
  if (campaignGeneration === null) {
    return { applied: false, reason: 'campaign-generation-invalid' }
  }
  if (campaignGeneration !== generation) {
    return { applied: false, reason: 'campaign-generation-mismatch' }
  }

  return { applied: true }
}

/**
 * 寫入收件人的寄送結果（sent／failed／exhausted）。round 10 修正
 * （Finding 1）：現在需要同時讀取 recipient 與 campaign 兩份文件才能做出
 * 完整的 fencing 判斷（見 decideCommitRecipientResult 的說明），呼叫端
 * 必須把兩者都包成 DocTx 傳進來。
 */
export async function commitRecipientResultTx(
  recipientDoc: DocTx,
  campaignDoc: DocTx,
  attemptId: string,
  generation: number,
  nowMs: number,
  patch: Record<string, unknown>,
): Promise<CommitResultDecision> {
  const recipientSnap = await recipientDoc.get()
  const campaignSnap = await campaignDoc.get()
  const decision = decideCommitRecipientResult(recipientSnap, campaignSnap, attemptId, generation, nowMs)
  if (decision.applied) {
    recipientDoc.update(patch)
  }
  return decision
}

// ---------------------------------------------------------------------------
// 收件人：sendMail 成功之後的結果寫入（可注入依賴，直接可測——Finding 2）
// ---------------------------------------------------------------------------

export interface CommitSentResultDeps {
  /** 嘗試把這位收件人寫成 status:'sent'。 */
  commitSent(): Promise<CommitResultDecision>
  /** 補救寫入 delivery_unknown（只有在 commitSent() 本身拋錯時才會呼叫）。 */
  commitDeliveryUnknown(message: string): Promise<CommitResultDecision>
  logWarn(message: string, meta?: Record<string, unknown>): void
  logError(message: string, meta?: Record<string, unknown>): void
}

/**
 * SMTP 已經接受這封信之後，接下來只剩「把結果寫回 Firestore」這一步，
 * 這一步的失敗跟「sendMail 本身失敗」是完全不同性質的問題（Finding 2）：
 *
 * - 如果讓呼叫端的 catch 把這裡的失敗也當成寄送失敗處理，會把「已經送出
 *   去的信」標成 failed／exhausted，一般 retryCampaign 之後可能對同一個
 *   人再寄一次——這才是真正可以避免、也必須避免的重複寄送。
 * - 正確的處理是：先試著寫 sent；如果這次寫入本身拋錯（例如 Firestore
 *   暫時不可用），改寫 delivery_unknown（我們不知道 Firestore 最後有沒有
 *   成功記下 sent，但確定 SMTP 已經收下這封信，不能讓一般流程再次嘗試
 *   寄送）。
 * - commitSent() 回傳 `applied:false` **不是**錯誤，不會走進
 *   delivery_unknown 分支——只記錄，不做任何進一步動作。⚠️ round 10
 *   修正過去的措辭：這裡過去說「代表另一個 invocation 已經接手這位收件人」
 *   ——commitSent() 底層呼叫的是 commitRecipientResultTx()，round 10 之後
 *   applied:false 可能的原因不只「被另一個 invocation 接手」，還包含
 *   「sweep 已經把這位收件人轉成 delivery_unknown」「admin 已經用
 *   resolveDeliveryUnknown 人工處理過」「campaign 處理租約已經過期或被
 *   generation 更新的操作取代」（見 decideCommitRecipientResult 的完整
 *   說明）。不論哪一種，結論都一樣：這次寫入已經不需要、也不應該再由這裡
 *   補上，只記錄即可，不需要在這裡逐一分辨原因（decision.reason 有更細的
 *   分類，供想要記錄的呼叫端使用）。
 * - 如果連補救寫入 delivery_unknown 都失敗，不再嘗試第三次——只記錄，
 *   不要讓補救動作的失敗掩蓋了「SMTP 其實已經成功」這個更重要的事實。
 *   收件人這時候的 Firestore 狀態會停在 sending，直到
 *   sweepExpiredDeliveryAttempts() 把它轉成 delivery_unknown 為止——
 *   ⚠️ round 10 修正過去的措辭：round 8 之前這裡寫「等收件人租約過期後
 *   才可能被重新認領」，但 sending 狀態的收件人**永遠不會**被一般認領
 *   流程重新認領（見 isRecipientClaimable 的說明），只會被 sweep 轉成
 *   delivery_unknown，兩者是完全不同的結果。這是殘留風險，見檔頭關於
 *   SMTP exactly-once 的說明。
 */
export async function commitSentResultOrMarkUnknown(deps: CommitSentResultDeps): Promise<void> {
  try {
    const decision = await deps.commitSent()
    if (!decision.applied) {
      deps.logWarn(
        'sendMail 成功，但寫回 sent 時已經不是自己持有這位收件人（可能已被其他 invocation 接手），不再處理',
      )
    }
  } catch (err) {
    deps.logError(
      'sendMail 成功，但寫回 Firestore 失敗，改標記 delivery_unknown，避免被一般 retry 自動重寄',
      { error: (err as Error)?.message },
    )
    try {
      const decision = await deps.commitDeliveryUnknown(
        `SMTP 已接受但寫回 sent 狀態失敗：${(err as Error)?.message ?? '未知錯誤'}`,
      )
      if (!decision.applied) {
        deps.logWarn('標記 delivery_unknown 時已經不是自己持有這位收件人，不再處理')
      }
    } catch (recoveryErr) {
      deps.logError(
        '補救寫入 delivery_unknown 也失敗，收件人狀態可能停在 sending 直到租約過期',
        { error: (recoveryErr as Error)?.message },
      )
    }
  }
}

// ---------------------------------------------------------------------------
// 收件人：單一收件人的完整處理流程（可注入依賴，直接可測——round 9 Finding 5）
// ---------------------------------------------------------------------------

export interface ProcessRecipientDeps<MailOptions> {
  /** 認領這位收件人（queued／failed／過期的 claimed → claimed）。 */
  claim(): Promise<ClaimDecision>
  /** 真正呼叫 sendMail 前的最後一道原子閘門（claimed → sending）。 */
  beginDelivery(): Promise<BeginDeliveryAttemptDecision>
  /** 用認領到的收件人資料組出這封信的內容；只有 beginDelivery applied 才會呼叫。 */
  buildMailOptions(claimedData: Record<string, unknown>): MailOptions
  /** 實際呼叫 SMTP（帶 wall-clock 逾時保護）。 */
  sendMail(mailOptions: MailOptions): Promise<SendMailWithDeadlineResult>
  /** sendMail 成功後寫回 sent（本身失敗時退成 delivery_unknown，見 commitSentResultOrMarkUnknown）。 */
  commitSent(): Promise<CommitResultDecision>
  /** sendMail 逾時，或 commitSent 本身拋錯時，寫回 delivery_unknown。 */
  commitDeliveryUnknown(message: string): Promise<CommitResultDecision>
  /** sendMail 在期限內就直接失敗（真正的錯誤）時，寫回 failed／exhausted。 */
  commitFailedOrExhausted(
    status: 'failed' | 'exhausted',
    detail: string | undefined,
  ): Promise<CommitResultDecision>
  /** 單一收件人最多重試次數；預設 MAX_RECIPIENT_ATTEMPTS。 */
  maxAttempts?: number
  /** 每封信之間的間隔（避免被 SMTP 伺服器判定濫發）；send／error 之後才會呼叫，timeout 不會。 */
  sleep(ms: number): Promise<void>
  logWarn(message: string, meta?: Record<string, unknown>): void
  logError(message: string, meta?: Record<string, unknown>): void
}

export type ProcessRecipientOutcome =
  | { kind: 'not-claimed' }
  | { kind: 'begin-failed'; reason: BeginDeliveryAttemptRejectReason }
  | { kind: 'sent' }
  | { kind: 'timeout' }
  | { kind: 'failed' }
  | { kind: 'exhausted' }

/**
 * 完整處理「一位收件人」：認領 → 進入 delivery attempt → 呼叫 SMTP →
 * 依結果寫回對應狀態。這是 round 6～9 幾輪修正過的核心安全邏輯所在——
 * round 8 的報告承認 functions/src/index.ts 的 sendPendingRecipients()
 * 這段迴圈本身從未被直接測試過，只測了它依賴的各個底層 Tx／decide 函式；
 * round 9 的 Finding 1（begin 缺少 lease 驗證）正是在這段沒被直接測試過
 * 的控制流程裡發生的。抽成這裡的 processOneRecipient()，讓 production
 *（functions/src/index.ts 的 sendPendingRecipients）與測試呼叫的是同一份
 * 函式，不是另外手刻一份看起來很像、可能漂移的測試版流程。
 *
 * ⚠️ 呼叫順序本身就是安全性的一部分：claim → beginDelivery → sendMail →
 * 對應的 commit，任何一步失敗（not claimable／begin 沒 applied）都必須
 * 完全跳過後面所有步驟，絕對不能呼叫 sendMail——這正是這支函式存在的
 * 理由，不能只靠人工推論「應該」是這個順序。
 */
export async function processOneRecipient<MailOptions>(
  deps: ProcessRecipientDeps<MailOptions>,
): Promise<ProcessRecipientOutcome> {
  const claim = await deps.claim()
  if (!claim.claimable || !claim.data) {
    return { kind: 'not-claimed' }
  }

  const begin = await deps.beginDelivery()
  if (!begin.applied) {
    deps.logWarn(
      '認領後、實際呼叫 SMTP 前 ownership 已經改變或 lease 已過期，跳過這位收件人，不呼叫 sendMail',
      { reason: begin.reason },
    )
    return { kind: 'begin-failed', reason: begin.reason }
  }

  const mailOptions = deps.buildMailOptions(claim.data)

  let sendOutcome: 'sent' | 'timeout' | 'error'
  let detail: string | undefined
  try {
    // sendMailWithWallClockDeadline 只是讓我們停止等待，不是 sendMail
    // 本身的硬性中止，也不保證不會跟接手的下一個 invocation 重疊——見
    // SMTP_SEND_WALL_CLOCK_TIMEOUT_MS 與 sendMailWithWallClockDeadline
    // 的完整說明。
    const result = await deps.sendMail(mailOptions)
    if (result.outcome === 'sent') {
      sendOutcome = 'sent'
    } else {
      sendOutcome = 'timeout'
      detail = result.closeError
        ? `${result.message}（關閉連線時也發生錯誤：${result.closeError}）`
        : result.message
    }
  } catch (err) {
    sendOutcome = 'error'
    detail = (err as { message?: string })?.message ?? '寄送失敗'
  }

  if (sendOutcome === 'sent') {
    // SMTP 已經接受，從這裡開始的任何失敗都不能被重新分類成「寄送失敗」。
    await commitSentResultOrMarkUnknown({
      commitSent: deps.commitSent,
      commitDeliveryUnknown: deps.commitDeliveryUnknown,
      logWarn: deps.logWarn,
      logError: deps.logError,
    })
    await deps.sleep(400)
    return { kind: 'sent' }
  }

  if (sendOutcome === 'timeout') {
    // 逾時之後底層連線池的狀態就不再可信，呼叫端（processBatch）必須停止
    // 這一批剩餘的收件人，交給下一次 retryCampaign 用全新的 transporter
    // 接續——這裡不 sleep，直接把結果交回去讓呼叫端決定要不要停批。
    deps.logError('sendMail 超過 wall-clock 上限，delivery 狀態不明', { detail })
    const decision = await deps.commitDeliveryUnknown(detail ?? '寄送逾時')
    if (!decision.applied) {
      deps.logWarn('標記 delivery_unknown 時已經不是自己持有這位收件人，不再處理')
    }
    return { kind: 'timeout' }
  }

  // sendOutcome === 'error'：sendMail 在期限內就直接失敗（真正的錯誤），
  // 才走 attemptCount／exhausted 的一般重試邏輯——這是唯一還會產生
  // failed／exhausted 的路徑。
  //
  // round 11 修正（Finding 2）：attemptCount 改用 begin（而不是 claim）
  // 回傳的權威值——只有真正走到這裡（sendMail 已經被呼叫過、且在期限內
  // 直接失敗）才代表這次 SMTP delivery attempt 真的發生過，begin.attemptCount
  // 正是 decideBeginDeliveryAttempt 在轉成 sending 那一刻原子算出的次數
  //（見該函式的說明），不會把「claim 成功但 begin 失敗」這種根本沒呼叫過
  // SMTP 的情況也算進重試額度。
  deps.logError('寄送失敗', { detail, attemptCount: begin.attemptCount })
  const exhausted = hasExceededMaxAttempts(
    begin.attemptCount,
    deps.maxAttempts ?? MAX_RECIPIENT_ATTEMPTS,
  )
  const failDecision = await deps.commitFailedOrExhausted(
    exhausted ? 'exhausted' : 'failed',
    detail,
  )
  if (!failDecision.applied) {
    deps.logWarn('寫回失敗結果時已經不是自己持有這位收件人，不再處理')
  }
  // 逐封稍作間隔，避免 mail2000 判定為濫發而阻擋
  await deps.sleep(400)
  return { kind: exhausted ? 'exhausted' : 'failed' }
}

// ---------------------------------------------------------------------------
// campaign：收尾（finalize）並釋放租約
// ---------------------------------------------------------------------------

export interface CampaignTotalsForFinalize {
  recipients: number
  sent: number
  failed: number
  exhausted: number
  /** sendMail 逾時或「已接受但寫回失敗」，delivery 是否送達無法確認的人數。 */
  deliveryUnknown: number
}

export interface FinalizeDecision {
  outcome: CampaignStatus | 'superseded' | 'not-found'
  patch?: Record<string, unknown>
}

/**
 * 只有目前仍持有 campaign 處理租約才能寫入最終狀態；寫入的同時一併釋放
 * 租約（讓下一次呼叫，例如 partial 之後管理員立刻按「繼續寄送」，能馬上
 * 取得租約，不必等 CAMPAIGN_LEASE_MS 過期）。診斷用的 lastAttemptId 則
 * 保留下來，不隨租約一起清掉。
 *
 * ⚠️ round 10 修正（Finding 2）：過去只驗證 `activeAttemptId === attemptId`
 * 這一個字串條件——但這**不足以**證明現在真的還安全：如果這中間曾經有
 * 一次 resolveDeliveryUnknown 取得過 resolution 租約（它從不改動
 * activeAttemptId），或者這個 invocation 自己的處理租約其實已經過期只是
 * 剛好還沒被任何人接手，光看 activeAttemptId 字串相符會誤判成「仍然
 * 安全」，讓一個實際上已經被 fencing 排除在外的舊 invocation 寫入最終
 * 狀態、蓋掉 resolution 或新 invocation 的結果。這裡額外要求：
 * - campaign 的處理租約本身尚未過期。
 * - campaign.leaseGeneration 跟這個 invocation 當初 acquireCampaignLeaseTx
 *   拿到的 generation 完全相同（見 readLeaseGeneration 的說明，這一個
 *   條件同時涵蓋「有沒有新的 processing invocation 接手」與「有沒有
 *   resolution 正在進行中」）。
 * 任何一項不成立都視為 superseded，不寫入——語意上跟「被別的 invocation
 * 取代」是同一件事：這次的權威性已經不在，不該再對外宣稱任何結果。
 *
 * releaseLeaseFields 由呼叫端提供 —— 不同 SDK 的「刪除欄位」語法不同
 * （Admin SDK 的 FieldValue.delete() vs 用戶端 SDK 的 deleteField()），
 * 這裡不猜測，只負責把呼叫端給的內容跟業務 patch 合併後一起寫入。
 */
export function decideFinalizeCampaign(
  snap: DocSnapshotLike,
  attemptId: string,
  generation: number,
  nowMs: number,
  totals: CampaignTotalsForFinalize,
  nonTerminalCount: number,
): FinalizeDecision {
  const outcome = decideCampaignStatus(totals, nonTerminalCount)
  if (!snap.exists || !snap.data) return { outcome: 'not-found' }
  const data = snap.data
  if (data.activeAttemptId !== attemptId) {
    return { outcome: 'superseded' }
  }
  const leaseMs = readFirstValidMs(data.activeLeaseExpiresAtMs, data.activeLeaseExpiresAt)
  if (leaseMs === null || !isLeaseActive(leaseMs, nowMs)) {
    return { outcome: 'superseded' }
  }
  // round 13 修正（Finding 1）、round 14 修正（Finding 1：held generation
  // 必須 >=1）：generation 或 campaign 的 leaseGeneration 任一方
  // malformed，或不是合法的「已持有」值（>=1），都視為 superseded（fail
  // closed，不寫入）——見 isValidHeldGeneration／readHeldLeaseGeneration
  // 的說明。
  if (!isValidHeldGeneration(generation)) {
    return { outcome: 'superseded' }
  }
  const currentGeneration = readHeldLeaseGeneration(data.leaseGeneration)
  if (currentGeneration === null || currentGeneration !== generation) {
    return { outcome: 'superseded' }
  }
  return {
    outcome,
    patch: {
      status: outcome,
      'totals.recipients': totals.recipients,
      'totals.sent': totals.sent,
      'totals.failed': totals.failed,
      'totals.exhausted': totals.exhausted,
      'totals.deliveryUnknown': totals.deliveryUnknown,
      lastAttemptId: attemptId,
    },
  }
}

export async function finalizeCampaignTx(
  doc: DocTx,
  attemptId: string,
  generation: number,
  nowMs: number,
  totals: CampaignTotalsForFinalize,
  nonTerminalCount: number,
  releaseLeaseFields: (decision: FinalizeDecision) => Record<string, unknown>,
): Promise<FinalizeDecision> {
  const snap = await doc.get()
  const decision = decideFinalizeCampaign(snap, attemptId, generation, nowMs, totals, nonTerminalCount)
  if (decision.patch) {
    doc.update({ ...decision.patch, ...releaseLeaseFields(decision) })
  }
  return decision
}

// ---------------------------------------------------------------------------
// campaign finalize ＋新聞稿同步：同一個 transaction（round 16 新增，
// Finding 4）
// ---------------------------------------------------------------------------
//
// ⚠️ round 15 及之前：finalizeCampaign()（sendCampaign／retryCampaign 用的
// 正常收尾）與 reconciliation 都是「先 finalize campaign（自己的
// transaction），成功之後才另外做一次 pressReleases/{id}.update(...)」——
// 兩次獨立的寫入。如果第一次成功、第二次失敗：campaign 已經是 terminal
// （沒有任何自動化流程會再回頭處理它，acquireCampaignLeaseTx／
// acquireResolutionLeaseTx 都會直接拒絕 terminal 的 campaign），但新聞稿
// 的 status／sentAt 永遠不會被補上——這個問題在 sendCampaign／
// retryCampaign／reconciliation 三個呼叫端都存在，不是 reconciliation
// 特有的。
//
// 修法：把「campaign finalize」與「新聞稿同步」收斂成一個 Firestore
// transaction 裡的原子操作——要嘛兩個寫入一起成功，要嘛（transaction 失敗
// 時）兩個都不會發生，campaign 也不會變成 terminal，呼叫端可以安全地整個
// 重新呼叫一次（finalize 本身已經是 fencing 保護的冪等操作，重試安全）。
// Firestore transaction 要求所有 get() 必須在任何 write 之前完成，所以這裡
// 不能沿用 finalizeCampaignTx() 內部「get 完立刻可能 update」的封裝，改成
// 攤平的流程：先讀 campaign，從 campaign 文件本身讀出 pressReleaseId／
// isTest（不依賴呼叫端另外傳入、可能跟文件本身不同步的值），視情況再讀
// 新聞稿文件，兩邊都讀完才開始寫。

/**
 * round 18 修正（Finding 1）：round 17 版本不論 `pressReleaseSyncMetadata`
 * 是不是 `'invalid'`，只要 `decideFinalizeCampaign()` 本身算出有 patch 要
 * 寫，`finalizeCampaignWithPressReleaseTx()` 就會照樣把 campaign 寫成
 * terminal——等於「不確定新聞稿有沒有同步」跟「確定 campaign 已經
 * 結案」同時發生，而且一旦 campaign 變成 terminal，`isTerminalCampaignStatus`
 * 會讓所有 acquire 路徑（一般寄送／重試／reconciliation）永遠拒絕再次
 * 處理這份文件，新聞稿就再也沒有機會被自動補上，只剩下手動的
 * repairCampaignPressReleaseSync。這違反了「無法安全判定是否同步，就
 * 不能先把 campaign 變成 terminal」的要求。
 *
 * 現在改成明確的 discriminated union：
 * - `'finalized'`：campaign 的 terminal 決策確實被套用（或者本來就沒有
 *   東西要寫——not-found／superseded／partial／確認不需要同步）,
 *  `pressReleaseUpdated` 說明新聞稿是否也被同步寫入。
 * - `'blocked'`：**不會**寫入 campaign 的 terminal patch，也就是這份
 *   campaign 會維持原本的非終止狀態不變——只有在確認自己仍然合法持有
 *   處理租約時，才會安全釋放它（`releaseDecision`，用跟
 *  `releaseCampaignProcessingLeaseTx` 完全相同的擁有權驗證，只是共用同一
 *   個已經讀過的 campaign snapshot，不需要再讀一次）。呼叫端（見
 *  `functions/src/index.ts` 的 `finalizeCampaign()`／reconciliation）必須
 *   把這個 outcome 轉譯成明確的、不會被誤認成「已完成」的錯誤，讓使用者
 *   或維運人員知道需要先修好 campaign 文件本身的中繼資料，才能重新嘗試
 *  （見 decideFinalizeCampaignWithPressRelease 的完整規則說明）。
 */
export type FinalizeCampaignWithPressReleaseDecision =
  | {
      outcome: 'finalized'
      finalize: FinalizeDecision
      /** 這次是否真的寫入了新聞稿的 status／sentAt——false 涵蓋所有「不
       *  需要同步」的合法情況（campaign 沒有 patch 要寫、是測試信、
       *  outcome 是 partial、totals.sent===0），呼叫端不需要再自己重新
       *  判斷一次條件。`outcome:'finalized'` 保證這裡列的都是可以安全
       *  判斷、不需要 fail closed 的情況——真正無法判斷的情況一律走
       * `outcome:'blocked'`，不會出現在這裡。 */
      pressReleaseUpdated: boolean
    }
  | {
      outcome: 'blocked'
      /** 'invalid-campaign-metadata'：mode／isTest 互相矛盾或型別錯誤，
       *  或 totals.sent 不是合法的非負 safe integer——無法確認這是不是
       *  需要同步新聞稿的正式發送。
       *  'press-release-not-found'：已經確認是正式發送、totals.sent>0，
       *  但 pressReleaseId 缺失／格式錯誤，或指向的新聞稿文件不存在。 */
      reason: 'invalid-campaign-metadata' | 'press-release-not-found'
      releaseDecision: ReleaseCampaignProcessingLeaseDecision
    }

/** round 17 新增（Finding 4 項目 1／2／3）：campaign 的「這是正式發送還是
 *  測試信」判斷，不再只看 `isTest` 單一欄位——production 從一開始就把
 *  `mode`（'self'／'testList'／'real'）與 `isTest`（`mode !== 'real'`）
 *  同一次寫入同一份 patch（見 functions/src/index.ts 的 sendCampaign／
 *  retryCampaign），兩者理論上永遠一致；只看 `isTest === true` 這一個
 *  條件，會讓 `isTest` 缺失、型別錯誤、或 `mode` 與 `isTest` 互相矛盾的
 *  文件全部被當成「不是測試」（`isTest === true` 為 false 的所有情況都
 *  被當成正式），可能把測試信誤判成正式發送，進而把正式新聞稿標成已發送
 *  ——這正是 Finding 4 的核心問題。
 *
 * - `mode` 是 `'real'`／`'self'`／`'testList'` 三者之一，且 `isTest` 是
 *   合法的布林值，且兩者相符（`isTest === (mode !== 'real')`）：回傳
 *  `'real'`（`mode:'real'` 對應 `isTest:false`）或 `'test'`（`mode:'self'`
 *   ／`'testList'` 對應 `isTest:true`）。
 * - 其餘所有情況（`mode` 缺失／不是三者之一、`isTest` 缺失／不是布林值、
 *   兩者不相符）：一律 `'invalid'`——刻意不嘗試「只用其中一個欄位猜」，
 *   即使只缺一個欄位、另一個欄位本身合法也一樣。這是刻意選擇的保守
 *   相容策略（Finding 4 項目 4）：猜錯成 `'real'` 的後果是把測試信寄出
 *   的新聞稿誤標成已發送，猜錯成 `'test'` 的後果只是這次不同步、之後可以
 *   用 repairCampaignPressReleaseSync 補——兩者風險不對稱，所以任何無法
 *   同時確認兩個欄位一致的情況，一律不猜、直接 fail closed。 */
export type CampaignSendKind = 'real' | 'test' | 'invalid'

export function resolveCampaignSendKind(data: Record<string, unknown> | undefined): CampaignSendKind {
  const mode = data?.mode
  const isTest = data?.isTest
  const hasValidMode = mode === 'real' || mode === 'self' || mode === 'testList'
  const hasValidIsTest = typeof isTest === 'boolean'
  if (!hasValidMode || !hasValidIsTest) return 'invalid'
  const expectedIsTest = mode !== 'real'
  if (isTest !== expectedIsTest) return 'invalid'
  return mode === 'real' ? 'real' : 'test'
}

/** round 17 新增（Finding 4 項目 6）：totals.sent 必須是合法、非負的 safe
 *  integer——Infinity／NaN／負數／字串都不能觸發新聞稿同步。 */
function isValidSentCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** round 17 新增（Finding 4 項目 7）：合法的 Firestore 文件 ID——非空字串，
 *  trim 之後仍非空，且不含任何空白字元或 `/`（`/` 在文件 ID 裡不只是「格式
 *  怪」，Admin／Client SDK 的 `collection(...).doc(id)` 會把含 `/` 的 id
 *  當成相對路徑解析，可能指向完全不同、非預期的文件位置——呼叫端在把
 *  pressReleaseId 交給 `.doc()` 之前，必須先用這個函式驗證過，不能只在
 *  最終的同步決策裡才檢查）。這裡 export 出去，讓
 *  finalizeCampaignWithPressReleaseTx／ops-campaign-repair.mjs 等呼叫端
 *  在真的呼叫 `getPressReleaseDoc()` 之前也能用同一份驗證邏輯先過濾，不
 *  重新手刻一份。 */
export function isValidDocumentId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && !/[\s/]/.test(value)
}

/**
 * 決定「campaign finalize 之後，是否也應該同步新聞稿的 status／sentAt」，
 * 以及——round 18 修正（Finding 1）——當這個問題本身無法安全回答時，
 * 明確拒絕讓 campaign 變成 terminal，而不是照樣寫入再回報一個「可能不準」
 * 的同步狀態。
 *
 * 判斷順序（每一步都是「確定可以安全處理」才會往下一步；任何一步不確定
 * 就地 fail closed，回傳 `outcome:'blocked'`）：
 * 1. `decideFinalizeCampaign()` 本身沒有 patch 要寫（not-found／
 *    superseded）→ `finalized`，`pressReleaseUpdated:false`（沒有東西要
 *    同步，也沒有東西被寫入）。
 * 2. outcome 是 `'partial'`（campaign 還沒有真的終止）→ `finalized`，
 *   `pressReleaseUpdated:false`——不論 sendKind／pressReleaseId 是什麼，
 *    partial 本來就不會同步（Finding 1 項目 6）。
 * 3. `totals.sent` 是合法值且確認等於 `0`（不論 sendKind 是什麼）→
 *   `finalized`，`pressReleaseUpdated:false`——沒有任何一封信真的送出，
 *    沒有東西可以同步，這是完全確定的安全情況（Finding 1 項目 6）。
 * 4. 走到這裡代表：outcome 不是 partial，且（`totals.sent` 本身格式錯誤，
 *    或已確認 `totals.sent > 0`）——這才是真正「可能需要同步」的情境，
 *    必須先確定是不是正式發送：
 *    - `totals.sent` 格式錯誤，或 `resolveCampaignSendKind()` 回傳
 *     `'invalid'`（mode／isTest 缺失、型別錯誤、或互相矛盾）→ **不確定
 *      這是不是需要同步的正式發送**，`outcome:'blocked'`，
 *     `reason:'invalid-campaign-metadata'`。
 *    - `sendKind === 'test'` → 確認是測試信，永遠不同步 →`finalized`，
 *     `pressReleaseUpdated:false`。
 * 5. 走到這裡代表：確認是 `sendKind==='real'` 且 `totals.sent>0` 且
 *    outcome 不是 partial——這是真的需要同步新聞稿的情況，檢查
 *    pressReleaseId／新聞稿文件本身：
 *    - `pressReleaseId` 缺失或格式錯誤 → 對一份確認是正式發送、
 *      totals.sent>0 的 campaign 而言，`pressReleaseId` 理論上一定存在
 *     （sendCampaign 建立時強制要求，見 functions/src/index.ts），缺失
 *      本身就是資料損毀 → `outcome:'blocked'`，
 *     `reason:'press-release-not-found'`。
 *    - `pressReleaseId` 格式合法，但 `pressReleaseSnap` 不存在（新聞稿
 *      文件被刪除，或還沒真的讀取）→ 同樣 `outcome:'blocked'`，
 *     `reason:'press-release-not-found'`——見 Finding 6 的完整說明：這裡
 *      刻意選擇「不讓 campaign 獨立完成」，而不是「允許完成但標記
 *     `not-applicable`」，因為此時已經確認這是一筆有收件人真的收到信、
 *      理應同步新聞稿的正式發送，讓 campaign 卡在非終止狀態、releaseLease
 *      並要求重跑，比讓它永遠帶著「應該同步卻沒有同步」的 terminal
 *      狀態更安全（重跑不會重寄 sent 的收件人，見 Finding 1 項目 5）。
 *    - 都通過 → `finalized`，`pressReleaseUpdated:true`。
 *
 * `outcome:'blocked'` 時額外算出 `releaseDecision`（用跟
 * `releaseCampaignProcessingLeaseTx` 完全相同的擁有權驗證，共用同一個
 * 已經讀過的 `campaignSnap`，不需要再讀一次）——只有在確認自己仍然合法
 * 持有處理租約時，呼叫端才會真的釋放它。
 *
 * mode／isTest／pressReleaseId 一律從 campaign 文件本身讀出，不接受呼叫端
 * 另外傳入——這是唯一的權威來源，也避免呼叫端不小心傳入一個跟文件本身
 * 不同步的值。
 */
export function decideFinalizeCampaignWithPressRelease(
  campaignSnap: DocSnapshotLike,
  pressReleaseSnap: DocSnapshotLike | null,
  attemptId: string,
  generation: number,
  nowMs: number,
  totals: CampaignTotalsForFinalize,
  nonTerminalCount: number,
): FinalizeCampaignWithPressReleaseDecision {
  const finalize = decideFinalizeCampaign(
    campaignSnap,
    attemptId,
    generation,
    nowMs,
    totals,
    nonTerminalCount,
  )
  if (!finalize.patch) {
    return { outcome: 'finalized', finalize, pressReleaseUpdated: false }
  }

  const sentIsValid = isValidSentCount(totals.sent)

  if (finalize.outcome === 'partial' || (sentIsValid && totals.sent === 0)) {
    return { outcome: 'finalized', finalize, pressReleaseUpdated: false }
  }

  const campaignData = campaignSnap.data
  const sendKind = resolveCampaignSendKind(campaignData)

  if (!sentIsValid || sendKind === 'invalid') {
    return {
      outcome: 'blocked',
      reason: 'invalid-campaign-metadata',
      releaseDecision: decideReleaseCampaignProcessingLease(campaignSnap, attemptId, generation),
    }
  }

  if (sendKind === 'test') {
    return { outcome: 'finalized', finalize, pressReleaseUpdated: false }
  }

  const rawPressReleaseId = campaignData?.pressReleaseId
  const pressReleaseIdValid = isValidDocumentId(rawPressReleaseId)
  if (!pressReleaseIdValid || !pressReleaseSnap?.exists) {
    return {
      outcome: 'blocked',
      reason: 'press-release-not-found',
      releaseDecision: decideReleaseCampaignProcessingLease(campaignSnap, attemptId, generation),
    }
  }

  return { outcome: 'finalized', finalize, pressReleaseUpdated: true }
}

/**
 * campaignDoc／getPressReleaseDoc 都是呼叫端提供的 DocTx——`getPressReleaseDoc`
 * 是一個 factory（不是直接傳一個現成的 DocTx），因為 pressReleaseId 要等
 * 讀到 campaign 文件之後才知道，呼叫端必須等這支函式內部讀完 campaign 才能
 * 用正確的 ref 建立第二個 DocTx；這支函式只會在真的需要讀新聞稿時才呼叫
 * 這個 factory 一次，不需要時完全不會呼叫（也就不會多一次不必要的讀取）。
 *
 * releaseLeaseFields／pressReleaseFields 都是 SDK 專屬的 sentinel
 * callback，跟 finalizeCampaignTx 的 releaseLeaseFields 同一個理由——這裡
 * 不猜測底下是哪個 SDK。
 *
 * round 18 新增（Finding 1）：`blockedReleaseFields` 只在
 * `decideFinalizeCampaignWithPressRelease()` 回傳 `outcome:'blocked'`、且
 * 確認仍合法持有租約（`releaseDecision.outcome==='released'`）時才會被
 * 呼叫——回傳型別收斂成 `ReleaseCampaignProcessingLeaseFields`（只有
 * `activeAttemptId`／`activeLeaseExpiresAtMs`／`updatedAt` 三個鍵），跟
 * `releaseCampaignProcessingLeaseTx()` 用同一份白名單寫入方式，即使呼叫端
 * 不小心多塞欄位也不會被寫進去（見該函式的 Finding 5 說明）。這個路徑
 * **不會**寫入 campaign 的 terminal patch，campaign 會維持原本的非終止
 * 狀態不變。
 */
export async function finalizeCampaignWithPressReleaseTx(
  campaignDoc: DocTx,
  getPressReleaseDoc: (pressReleaseId: string) => DocTx,
  attemptId: string,
  generation: number,
  nowMs: number,
  totals: CampaignTotalsForFinalize,
  nonTerminalCount: number,
  releaseLeaseFields: (decision: FinalizeDecision) => Record<string, unknown>,
  pressReleaseFields: () => Record<string, unknown>,
  blockedReleaseFields: () => ReleaseCampaignProcessingLeaseFields,
): Promise<FinalizeCampaignWithPressReleaseDecision> {
  const campaignSnap = await campaignDoc.get()
  // 先算一次「不看新聞稿」的初判，只為了判斷等一下要不要讀新聞稿——這裡
  // 還不寫入任何東西，Firestore 的讀寫順序限制只要求「所有 get() 在任何
  // update()／set() 之前」，多算一次純函式沒有這個限制。這個初判傳入
  // `pressReleaseSnap: null`，所以任何「已經確認需要同步」的情境在這裡
  // 都會先落在 `outcome:'blocked', reason:'press-release-not-found'`
  //（因為 `pressReleaseSnap?.exists` 在 null 時恆為 false）——用這個訊號
  // 判斷「需不需要真的去讀新聞稿」，不需要另外重新展開一次判斷條件。
  const preliminary = decideFinalizeCampaignWithPressRelease(
    campaignSnap,
    null,
    attemptId,
    generation,
    nowMs,
    totals,
    nonTerminalCount,
  )
  const campaignData = campaignSnap.data
  const rawPressReleaseId = campaignData?.pressReleaseId
  // round 17 修正（Finding 4）：只有格式合法（非空、無空白、不含 '/'）的
  // pressReleaseId 才會被拿去呼叫 getPressReleaseDoc()——一個含 '/' 的
  // 字串交給 Firestore 的 `.doc()` 可能被解析成完全不同的文件位置，不能
  // 先讀了才發現格式有問題。
  const pressReleaseId = isValidDocumentId(rawPressReleaseId) ? rawPressReleaseId : null
  const needsPressReleaseRead =
    preliminary.outcome === 'blocked' &&
    preliminary.reason === 'press-release-not-found' &&
    pressReleaseId !== null

  const pressReleaseDoc = needsPressReleaseRead ? getPressReleaseDoc(pressReleaseId) : null
  const pressReleaseSnap = pressReleaseDoc ? await pressReleaseDoc.get() : null

  const decision = decideFinalizeCampaignWithPressRelease(
    campaignSnap,
    pressReleaseSnap,
    attemptId,
    generation,
    nowMs,
    totals,
    nonTerminalCount,
  )

  // 到這裡兩邊該讀的都讀完了，才開始寫。
  if (decision.outcome === 'finalized') {
    // campaign 與新聞稿要嘛一起寫入，要嘛（transaction 失敗時）都不寫，
    // 不會有「campaign 已經 terminal，新聞稿沒同步」的中間態。
    if (decision.finalize.patch) {
      campaignDoc.update({ ...decision.finalize.patch, ...releaseLeaseFields(decision.finalize) })
    }
    if (decision.pressReleaseUpdated && pressReleaseDoc) {
      pressReleaseDoc.update(pressReleaseFields())
    }
  } else {
    // round 18 新增（Finding 1）：blocked——完全不寫 campaign 的 terminal
    // patch，只在確認仍合法持有租約時，用白名單寫入安全釋放它。
    if (decision.releaseDecision.outcome === 'released') {
      const fields = blockedReleaseFields()
      campaignDoc.update({
        activeAttemptId: fields.activeAttemptId,
        activeLeaseExpiresAtMs: fields.activeLeaseExpiresAtMs,
        updatedAt: fields.updatedAt,
      })
    }
  }
  return decision
}

// ---------------------------------------------------------------------------
// 新聞稿同步 repair（round 16 新增，Finding 4）
// ---------------------------------------------------------------------------
//
// finalizeCampaignWithPressReleaseTx 從這一輪起把 campaign finalize 與新聞稿
// 同步收在同一個 transaction，理論上不會再出現「campaign 已經 terminal、
// 新聞稿沒同步」的中間態——但這支修復工具仍然需要，理由：
// (1) 這個 PR 部署之前，Firestore 裡可能已經存在用「先 finalize、再另外
//     update 新聞稿」這種非原子做法留下的、真的卡住的歷史資料（round 15
//     及更早的 reconciliation、以及 sendCampaign／retryCampaign 從第一天
//     就有的既有缺口）。
// (2) 作為防禦性的最後一道手段：任何未預期的情況讓 campaign 已經是
//     terminal，但新聞稿還是沒同步，都需要一個安全、冪等、不會寄信的
//     方法補上這一步，不必（也不能）重新走一次完整寄送流程。
//
// 安全性設計：
// - 只在 campaign 確認已經是終止狀態（isTerminalCampaignStatus）時才會
//   考慮寫入——terminal 是這整套 lease 機制裡唯一「保證不會再有任何
//   automatic 流程回頭寫這份文件」的狀態，repair 只能在這個前提下才安全，
//   否則會跟一個仍在進行中的 sendCampaign／retryCampaign／reconciliation
//   互相競爭。
// - isTest campaign 永遠不寫（Finding 4 項目 5）。round 17 修正
//   （Finding 4）：不再只看 `isTest === true`，改用
//   resolveCampaignSendKind()——`mode`／`isTest` 兩者中任一缺失、型別
//   錯誤、或彼此矛盾，一律回傳 'invalid-campaign-metadata'，不猜測。
// - totals.sent === 0 時不寫（沒有任何東西可以同步）；totals.sent 本身
//   不是合法的非負 safe integer（round 17 新增，Finding 4 項目 6）一律
//   'invalid-campaign-metadata'。
// - pressReleaseId 存在但格式錯誤（round 17 新增，Finding 4 項目 7）一律
//  'invalid-campaign-metadata'；完全缺失才是 'missing-press-release-id'。
// - 新聞稿必須同時符合 `status==='sent'` **且** `sentAt` 是可解析的合法
//   時間戳，才視為 'already-synced'（round 17 修正，Finding 5：舊版只看
//   status，會讓 status:'sent' 但 sentAt 缺失／格式錯誤的歷史資料被誤判
//   成「已經同步過」，永遠不會被修好）；只要其中一項不成立就會重新寫入
//  （`shouldWrite:true`，outcome 仍是 'synced'）。
// - round 18 修正（Finding 5）：寫入的 `sentAt` 不再是「修復當下的時間」
//  （`FieldValue.serverTimestamp()`）——sentAt 在 UI 上被當成「campaign
//   完成的時間」（不是任何單一收件人 SMTP 實際送達的時間，見下方
//  `authoritativeCompletedAtMs` 的說明），如果修復發生在完成好幾天之後，
//   用修復當下的時間冒充會誤導看報表的人。改成優先使用
//  `campaign.completedAt`（campaign finalize 時就已經設定、可追溯的完成
//   時間，見 finalizeCampaignWithPressReleaseTx／finalizeCampaign() 的
//   completedAt 語意）；如果 completedAt 缺失、無法解析、或雖然能解析出
//   數字但不是一個站得住腳的日曆時間（負值、0、或超出合理範圍——檢查過，
//   這是目前唯一夠可信、語意明確對應「完成時間」的欄位——`startedAtMs`／
//  `startedAt` 是建立時間，不是完成時間，拿來冒充 sentAt 一樣會誤導；
//  `updatedAt` 在正常寫入路徑上會被很多不相關的操作更新，同樣不可信），
//   一律拒絕寫入、回傳明確的 `'missing-authoritative-sent-time'`，不會
//   無聲地用任何猜測值頂替。
// - round 19 修正（Finding 2）：round 18 版本回傳的
//  `authoritativeCompletedAt` 是「原始未驗證的 unknown 值」（`completedAt`
//   欄位本身，可能是 Firestore Timestamp、也可能是相容格式的純數字），
//   呼叫端被要求「原封不動」寫進 `sentAt`——如果 `completedAt` 剛好是一個
//  （`readMsCompat()` 能接受的）純數字毫秒時間戳，呼叫端字面上遵照指示
//   原樣寫入，就會把一個 JS number 寫進 Firestore 的 `sentAt` 欄位，但
//  `src/types.ts` 的 `PressRelease.sentAt` 宣告是 Firestore `Timestamp`，
//   前端排序（`PressListPage.tsx` 的 `sentAt?.toMillis?.()`）與顯示
//  （`formatDate()` 的 `ts?.toDate`）都假設它一定有 `.toMillis()`／
//  `.toDate()`，一個純數字完全沒有這兩個方法，會悄悄排序成 0、顯示成
//  「—」。修正方式：這裡的純邏輯層只回傳**驗證過的毫秒數**
//  （`authoritativeCompletedAtMs: number`），不再回傳原始 unknown 值——
//   呼叫端（functions/src/index.ts、ops-campaign-repair.mjs）收到的是一個
//   保證是 finite、正數、落在合理範圍內的數字，必須自己用 Admin SDK 的
//  `Timestamp.fromMillis()` 正規化成真正的 Timestamp 才能寫入
//  `sentAt`——型別本身（`number`，不是 `unknown`）就讓「原封不動寫入一個
//   可能不是 Timestamp 的值」變成不可能的操作，不需要再靠文件描述的
//   紀律。
// - 這支工具的介面完全不接受、也不可能接觸 SMTP 設定、recipient claim、
//   或任何寄信相關能力（Finding 4 項目 7）——呼叫端（見
//   functions/src/index.ts 的 repairCampaignPressReleaseSync）的 deps
//   介面結構上就不存在這些方法。

export type PressReleaseSyncRepairOutcome =
  | 'campaign-not-found'
  | 'not-terminal'
  | 'test-campaign'
  | 'no-sent-recipients'
  | 'missing-press-release-id'
  | 'press-release-not-found'
  | 'already-synced'
  | 'synced'
  /** round 17 新增（Finding 4）：mode／isTest 矛盾或型別錯誤、
   *  totals.sent 不是合法的非負 safe integer、或 pressReleaseId 存在但
   *  格式錯誤——這幾種情況都無法安全判斷，一律拒絕寫入，需要人工檢查
   *  這份 campaign 文件本身的資料完整性，不是單純「這次不用同步」。 */
  | 'invalid-campaign-metadata'
  /** round 18 新增（Finding 5）：campaign 已經確認需要同步（terminal、
   *  正式發送、totals.sent>0、新聞稿存在且尚未同步），但找不到任何可信
   *  的完成時間（`completedAt` 缺失或無法解析）——拒絕寫入，不會用
   *  修復當下的時間冒充實際寄送時間。 */
  | 'missing-authoritative-sent-time'

export interface PressReleaseSyncRepairDecision {
  outcome: PressReleaseSyncRepairOutcome
  /** 只有 outcome==='synced' 才是 true——呼叫端要寫入的實際欄位值交給
   *  呼叫端自己的 SDK sentinel（pressReleaseFields），這裡只回答「該不該
   *  寫」。 */
  shouldWrite: boolean
  /** round 19 修正（Finding 2）：只有 `shouldWrite:true` 時才會有值——
   *  這是驗證過的**毫秒數**（canonical schema，不是原始 unknown 值），
   *  同時通過 `readMsCompat()`（finite）與 `isPlausibleCompletedAtMs()`
   *（正數、未超出合理上限）兩層檢查。呼叫端必須用自己 SDK 的
   *  `Timestamp.fromMillis(authoritativeCompletedAtMs)` 正規化成真正的
   *  Timestamp 再寫進新聞稿的 `sentAt`——`sentAt` 的型別是 Firestore
   *  Timestamp（見 `src/types.ts` 的 `PressRelease.sentAt`），前端排序與
   *  `formatDate()` 都假設它有 `.toMillis()`／`.toDate()`，寫入一個純數字
   *  會讓排序悄悄變成 0、顯示變成「—」。 */
  authoritativeCompletedAtMs?: number
}

/**
 * round 19 新增（Finding 2）；round 20 修正（Finding 3，P2）：「completedAt
 * （或已經寫入 `sentAt` 的值）是不是一個站得住腳的日曆時間」。
 *
 * ⚠️ round 19 版本的殘餘缺口：只要求 `>0` 且不晚於西元 3000 年，這兩個
 * 邊界都太寬鬆，實務上完全擋不住兩種常見的損毀資料：
 * - 「秒數被誤當毫秒」：例如把 Unix 時間戳 `1_700_000_000`（秒，對應
 *   2023 年）直接當成毫秒寫入，會解析成 1970-01-20——一個明顯荒謬的
 *  「完成時間」，但 `>0` 一樣會通過。程式碼裡的舊註解聲稱這裡會排除這種
 *   情況，但實作其實從未真的檢查過，round 20 補上。
 * - 「明顯未來的完成時間」：西元 3000 年的上限形同虛設，任何被寫壞、
 *   意外多打幾個零的數字幾乎都能通過。
 *
 * 修正方式：
 * - 下界改成這個專案 git 歷史最早的 commit（2026-07-20）往前抓一個整月的
 *  「這個系統不可能有任何合法資料早於這個時間點」——`PLAUSIBLE_COMPLETED_AT_MIN_MS`
 *   （2026-07-01T00:00:00Z）。任何秒數被誤當毫秒的值（範圍大約落在
 *   1970 年附近）都會被這個下界擋下，不需要額外猜測「典型的秒數量級」。
 * - 上界改成 `nowMs` 加上一段刻意設得很小的 clock skew 容忍
 *  （`PLAUSIBLE_COMPLETED_AT_CLOCK_SKEW_MS`，5 分鐘）——campaign 的
 *  `completedAt` 是伺服器自己寫入的時間，不該比「現在」晚太多；给
 *   5 分鐘完全是為了容忍多台機器之間些微的時鐘漂移，不是要接受「未來的
 *   完成時間」這個概念本身。
 *
 * 這兩個常數與這支函式是**唯一權威來源**——functions/src/index.ts 的
 * repairCampaignPressReleaseSync callable 與
 * functions/scripts/ops-campaign-repair.mjs 的 CLI 都透過
 * `decidePressReleaseSyncRepair()` 間接呼叫這裡，不允許任何一邊自己另外
 * 寫一份判斷式（round 20 修正，Finding 3：避免兩邊漂移）。
 */
export const PLAUSIBLE_COMPLETED_AT_MIN_MS = Date.UTC(2026, 6, 1) // 西元 2026-07-01T00:00:00Z
export const PLAUSIBLE_COMPLETED_AT_CLOCK_SKEW_MS = 5 * 60_000 // 5 分鐘
export function isPlausibleCompletedAtMs(ms: number, nowMs: number): boolean {
  if (!Number.isFinite(ms) || !Number.isFinite(nowMs)) return false
  if (ms < PLAUSIBLE_COMPLETED_AT_MIN_MS) return false
  if (ms > nowMs + PLAUSIBLE_COMPLETED_AT_CLOCK_SKEW_MS) return false
  return true
}

/**
 * round 20 新增（Finding 3）：`pressRelease.sentAt` 是否是一個「已經完成
 * canonical Timestamp 遷移」、可以信任的值——`alreadySynced` 判斷的唯一
 * 權威來源。
 *
 * ⚠️ round 19 遺留的殘餘風險（round 20 修正的核心）：舊版的 `alreadySynced`
 * 只要求 `status==='sent' && readMsCompat(sentAt)!==null`——但
 * `readMsCompat()` 本來就同時接受「新格式（number，毫秒）」與「舊格式
 *（Timestamp-like）」兩種輸入（這是它存在的目的，見檔案上方說明），所以
 * 一筆 `sentAt` 是**純數字**（canonical-Timestamp 遷移原本應該淘汰的資料
 * 型態）的歷史文件，一樣會被判成「已經同步過」而永久跳過修復——這正是
 * canonical 遷移沒有真正關閉的缺口：`repairCampaignPressReleaseSync`／
 * ops-campaign-repair.mjs 永遠不會touches 這種資料，只能手動遷移。
 *
 * 修正方式：改成要求 `sentAt` 必須通過 `isTimestampLike()`（真正的
 * Timestamp-like 物件，不是純數字）**且** `readMsCompat()` 解析出的毫秒數
 * 通過 `isPlausibleCompletedAtMs()`（見上方：排除秒數誤當毫秒、明顯未來
 * 的值、NaN／Infinity）。任何不滿足的情況——純數字、負值、秒數誤當毫秒、
 * 未來時間、NaN／Infinity、`toMillis()` 拋錯的畸形物件——都會讓
 * `alreadySynced` 為 false，落入下面既有的 `synced` 分支，用
 * `campaign.completedAt` 重新算出正確的 `authoritativeCompletedAtMs` 並
 * 用 `Timestamp.fromMillis()` 覆寫回去，直接修復歷史上的純數字 `sentAt`
 * ——不再是「只能人工遷移」的殘餘風險，見本輪報告第 5 節。
 */
function isCanonicalSentAt(value: unknown, nowMs: number): boolean {
  if (!isTimestampLike(value)) return false
  const ms = readMsCompat(value)
  return ms !== null && isPlausibleCompletedAtMs(ms, nowMs)
}

export function decidePressReleaseSyncRepair(
  campaignSnap: DocSnapshotLike,
  pressReleaseSnap: DocSnapshotLike | null,
  nowMs: number,
): PressReleaseSyncRepairDecision {
  if (!campaignSnap.exists || !campaignSnap.data) {
    return { outcome: 'campaign-not-found', shouldWrite: false }
  }
  const data = campaignSnap.data
  const status = data.status as string | undefined
  if (!isTerminalCampaignStatus(status)) {
    return { outcome: 'not-terminal', shouldWrite: false }
  }
  const sendKind = resolveCampaignSendKind(data)
  if (sendKind === 'invalid') {
    return { outcome: 'invalid-campaign-metadata', shouldWrite: false }
  }
  if (sendKind === 'test') {
    return { outcome: 'test-campaign', shouldWrite: false }
  }
  const totals = data.totals as { sent?: unknown } | undefined
  if (!isValidSentCount(totals?.sent)) {
    return { outcome: 'invalid-campaign-metadata', shouldWrite: false }
  }
  if (!(totals.sent > 0)) {
    return { outcome: 'no-sent-recipients', shouldWrite: false }
  }
  const rawPressReleaseId = data.pressReleaseId
  const pressReleaseIdAbsent = rawPressReleaseId === undefined || rawPressReleaseId === null
  if (pressReleaseIdAbsent) {
    return { outcome: 'missing-press-release-id', shouldWrite: false }
  }
  if (!isValidDocumentId(rawPressReleaseId)) {
    return { outcome: 'invalid-campaign-metadata', shouldWrite: false }
  }
  if (!pressReleaseSnap || !pressReleaseSnap.exists || !pressReleaseSnap.data) {
    return { outcome: 'press-release-not-found', shouldWrite: false }
  }
  const alreadySynced =
    pressReleaseSnap.data.status === 'sent' && isCanonicalSentAt(pressReleaseSnap.data.sentAt, nowMs)
  if (alreadySynced) {
    return { outcome: 'already-synced', shouldWrite: false }
  }
  const completedAt = data.completedAt
  const completedAtMs = readMsCompat(completedAt)
  if (completedAtMs === null || !isPlausibleCompletedAtMs(completedAtMs, nowMs)) {
    return { outcome: 'missing-authoritative-sent-time', shouldWrite: false }
  }
  return { outcome: 'synced', shouldWrite: true, authoritativeCompletedAtMs: completedAtMs }
}

/**
 * getPressReleaseDoc 只有在 campaign 文件裡確實有一個格式合法的
 * pressReleaseId（見 isValidDocumentId：非空、無空白、不含 '/'）時才會被
 * 呼叫——campaign 不存在／沒有 pressReleaseId／pressReleaseId 格式錯誤時
 * 完全不會去讀新聞稿集合，避免把一個含 '/' 的字串交給 `.doc()` 解析成
 * 非預期的文件位置。
 *
 * round 19 修正（Finding 2）：`pressReleaseFields` 現在接受**驗證過的
 * 毫秒數**（`authoritativeCompletedAtMs: number`，不是原始 unknown
 * 值）——呼叫端必須用自己 SDK 的 `Timestamp.fromMillis(...)` 正規化成真正
 * 的 Timestamp，組出 `{status:'sent', sentAt:<Timestamp>}`，不能自己塞入
 * serverTimestamp()／目前時間，也不能把這個數字原封不動寫進去（那會寫出
 * 一個沒有 `.toMillis()`／`.toDate()` 的欄位，見上方 canonical schema 的
 * 說明）。只有 `decision.shouldWrite` 為 true 時才會呼叫這個 callback，
 * 這時候 `decision.authoritativeCompletedAtMs` 保證有值。
 */
export async function repairCampaignPressReleaseSyncTx(
  campaignDoc: DocTx,
  getPressReleaseDoc: (pressReleaseId: string) => DocTx,
  pressReleaseFields: (authoritativeCompletedAtMs: number) => Record<string, unknown>,
  nowMs: number,
): Promise<PressReleaseSyncRepairDecision> {
  const campaignSnap = await campaignDoc.get()
  const rawPressReleaseId = campaignSnap.data?.pressReleaseId
  const pressReleaseId = isValidDocumentId(rawPressReleaseId) ? rawPressReleaseId : null
  const pressReleaseDoc = pressReleaseId ? getPressReleaseDoc(pressReleaseId) : null
  const pressReleaseSnap = pressReleaseDoc ? await pressReleaseDoc.get() : null
  const decision = decidePressReleaseSyncRepair(campaignSnap, pressReleaseSnap, nowMs)
  if (decision.shouldWrite && pressReleaseDoc && decision.authoritativeCompletedAtMs !== undefined) {
    pressReleaseDoc.update(pressReleaseFields(decision.authoritativeCompletedAtMs))
  }
  return decision
}

// ---------------------------------------------------------------------------
// campaign：安全釋放處理租約（round 15 新增，Finding 2）
// ---------------------------------------------------------------------------
//
// ⚠️ round 14 的 reconcileCampaignDelivery() 文件曾經寫「沒有安全的『只
// 釋放、不改狀態』原語」，所以取得租約後任何未預期例外都只能讓租約自然
// 過期（CAMPAIGN_LEASE_MS，660 秒）——這會讓寄送與再次校正被卡住將近 11
// 分鐘。這裡補上這個原語：跟 finalizeCampaignTx／markCampaignFailedTx 用
// 完全相同的擁有權驗證（activeAttemptId 相符、held generation 合法且
// 相符），但**只**清掉租約欄位，不碰 status／totals／completedAt／
// recipient——安全性來自「只有真的還是自己持有時才會寫」，不安全的情況
// （租約已經被別人取代、或本來就不是自己的）一律不寫，不會誤刪別人的
// 租約。

export type ReleaseCampaignProcessingLeaseDecision =
  | { outcome: 'released' }
  | { outcome: 'not-found' }
  /** campaign 存在，但 activeAttemptId 不是呼叫端、或 generation 不合法／
   *  不相符——代表這個租約已經不是（或從來不是）呼叫端的，什麼都不寫，
   *  避免清掉別人的租約。 */
  | { outcome: 'not-owner' }

export function decideReleaseCampaignProcessingLease(
  snap: DocSnapshotLike,
  attemptId: string,
  generation: number,
): ReleaseCampaignProcessingLeaseDecision {
  if (!snap.exists || !snap.data) return { outcome: 'not-found' }
  const data = snap.data
  if (data.activeAttemptId !== attemptId) return { outcome: 'not-owner' }
  if (!isValidHeldGeneration(generation)) return { outcome: 'not-owner' }
  const currentGeneration = readHeldLeaseGeneration(data.leaseGeneration)
  if (currentGeneration === null || currentGeneration !== generation) {
    return { outcome: 'not-owner' }
  }
  return { outcome: 'released' }
}

/**
 * round 16 修正（Finding 5）：呼叫端提供的欄位收斂成一個具名介面，只列出
 * 這支 primitive 允許寫入的三個欄位——不再是 `Record<string, unknown>`。
 * 每個欄位的值仍然由呼叫端提供（SDK 專屬的刪除／serverTimestamp 語法：
 * Admin SDK 的 `FieldValue.delete()`／`FieldValue.serverTimestamp()` vs
 * 用戶端 SDK 的 `deleteField()`／`serverTimestamp()`），這裡不猜測值本身
 * 是什麼，只固定「能寫哪些鍵」。
 */
export interface ReleaseCampaignProcessingLeaseFields {
  activeAttemptId: unknown
  activeLeaseExpiresAtMs: unknown
  updatedAt: unknown
}

/**
 * best-effort 安全釋放：只在「確認自己仍然合法持有」時才清掉租約欄位。
 *
 * ⚠️ round 16 修正（Finding 5）：round 15 版本讓 `releaseLeaseFields`
 * 回傳任意 `Record<string, unknown>`，直接整包交給 `doc.update()`——這只是
 * 「介面設計上不鼓勵」多塞欄位，並沒有真的擋下來，呼叫端的 callback 一旦
 * 手滑多回傳 `status`／`totals`／`completedAt`，這支號稱「只清租約」的
 * primitive 就會真的把它們寫進去，跟它自己的文件說明互相矛盾。現在改成：
 * callback 回傳型別收斂成 `ReleaseCampaignProcessingLeaseFields`（只有
 * `activeAttemptId`／`activeLeaseExpiresAtMs`／`updatedAt` 三個鍵），而且
 * 這裡在執行期用白名單明確逐一取出這三個欄位組成 `doc.update()` 的 patch
 * ——即使呼叫端想繞過 TypeScript（例如用 `as any` 硬塞多餘欄位），執行期
 * 的白名單仍然會把多出來的鍵丟掉，不會被寫入 Firestore。
 */
export async function releaseCampaignProcessingLeaseTx(
  doc: DocTx,
  attemptId: string,
  generation: number,
  releaseLeaseFields: () => ReleaseCampaignProcessingLeaseFields,
): Promise<ReleaseCampaignProcessingLeaseDecision> {
  const snap = await doc.get()
  const decision = decideReleaseCampaignProcessingLease(snap, attemptId, generation)
  if (decision.outcome === 'released') {
    const fields = releaseLeaseFields()
    // 白名單：只挑這三個鍵，不把 callback 回傳物件本身（可能被呼叫端塞了
    // 其他欄位）整包傳給 doc.update()。
    doc.update({
      activeAttemptId: fields.activeAttemptId,
      activeLeaseExpiresAtMs: fields.activeLeaseExpiresAtMs,
      updatedAt: fields.updatedAt,
    })
  }
  return decision
}

// ---------------------------------------------------------------------------
// campaign：標記失敗（setup 或處理租約兩種身分，都要釋放各自持有的資源）
// ---------------------------------------------------------------------------

/**
 * 標記失敗時要用哪個身分驗證所有權：
 * - setup：建立收件人清單階段的擁有者（createdByAttemptId），這個階段
 *   還沒取得處理租約，不會有 activeAttemptId 需要釋放。
 * - lease：已經取得處理租約後才失敗（例如 SMTP 驗證失敗、寄送過程未預期
 *   例外），要用 activeAttemptId 驗證身分，成功寫入時一併釋放租約。
 *
 * 刻意不再接受「不驗證身分」的旁路（過去的設計曾經用 attemptId=null 代表
 * 「可以無條件覆蓋」，導致沒有持有租約的 invocation 能把正在寄送的
 * campaign 標成 failed）——任何呼叫端都必須明確表明自己是哪種身分、
 * 帶著自己的 attemptId，沒有例外。
 */
export type FailureOwnership =
  | { kind: 'setup'; attemptId: string }
  | { kind: 'lease'; attemptId: string; generation: number }

export interface MarkFailedDecision {
  applied: boolean
  patch?: Record<string, unknown>
}

/**
 * kind:'lease'：round 10 修正（Finding 2）——過去只驗證 activeAttemptId
 * 字串相符，理由是「這個階段一定是先前已經成功拿到處理租約才會走到」。
 * 但這個推論忽略了：拿到租約**之後**，中間仍然可能發生「租約自然過期」
 * 或「resolveDeliveryUnknown 取得了 resolution 租約」——這兩種情況下
 * activeAttemptId 字串都還是原封不動（resolution 從不改動它），只驗證
 * 字串相符會誤判成「仍然安全」，讓一個已經被排除在外的舊 invocation 把
 * campaign 標成 failed，蓋掉 resolution 或新 invocation 正在進行的工作。
 * 現在額外要求處理租約本身尚未過期，且 leaseGeneration 跟這個 invocation
 * 當初取得租約時記錄的 generation 相同（見 readLeaseGeneration 的說明）。
 *
 * kind:'setup' 光是 createdByAttemptId 相符**不足以**證明「現在」仍在
 * setup 階段：可能發生「recipientsReady:true 的寫入其實已經成功，但
 * client 因為回應遺失而還是進了 catch」，甚至「另一個 invocation 已經
 * 看到 recipientsReady:true、取得了處理租約、正在實際寄送」——這種情況下
 * 舊的 setup owner（createdByAttemptId 仍然相符）如果只驗證這一個欄位，
 * 就能把一個已經進入寄送階段、正在被別人處理的 campaign 覆蓋成 failed。
 * 因此 kind:'setup' 必須在同一個 transaction 內額外原子重新驗證：
 * - status 仍是 'sending'（不是 partial／completed／failed）
 * - recipientsReady 仍是 false（收件人子集合真的還沒寫完）
 * - 完全沒有 activeAttemptId 欄位（不論是誰、也不論租期是否已過期或
 *   expiry 本身能不能被解析）
 *
 * ⚠️ 最後一項刻意用「activeAttemptId 有沒有存在」判斷，不是「租約有沒有
 * 過期」——在正確的不變量下，recipientsReady 還是 false 時，
 * acquireCampaignLeaseTx 必然回傳 not-ready、絕不會寫入 activeAttemptId，
 * 所以只要 activeAttemptId 這個欄位存在，就代表資料已經跳過了應有的
 * 不變量（可能是 legacy 資料、也可能是 bug），這時候唯一安全的做法是
 * fail closed、拒絕覆寫，不是去嘗試解析 expiry 猜測「這個租約現在還算
 * 不算有效」。過去的寫法（`isLeaseActive(readMsCompat(...))`）在 expiry
 * 欄位遺失或格式錯誤時會把 `hasActiveLease` 判斷成 false，讓 setup owner
 * 照樣覆寫——這是 fail-open，不是 fail-closed，已經修正。
 * 這個規則同時涵蓋「activeAttemptId 剛好等於自己」的情況：一旦任何人
 * （包含 setup owner 自己）已經進到取得處理租約的階段，後續要標記失敗
 * 就必須改用 kind:'lease'，不能再用 kind:'setup'。
 */
export function decideMarkCampaignFailed(
  snap: DocSnapshotLike,
  ownership: FailureOwnership,
  nowMs: number,
  errorMessage: string,
): MarkFailedDecision {
  if (!snap.exists || !snap.data) return { applied: false }
  const data = snap.data
  if (ownership.kind === 'lease') {
    if (data.activeAttemptId !== ownership.attemptId) return { applied: false }
    const leaseMs = readFirstValidMs(data.activeLeaseExpiresAtMs, data.activeLeaseExpiresAt)
    if (leaseMs === null || !isLeaseActive(leaseMs, nowMs)) return { applied: false }
    // round 13 修正（Finding 1）：任一方 malformed 都 fail closed。
    if (!isValidHeldGeneration(ownership.generation)) return { applied: false }
    const currentGeneration = readHeldLeaseGeneration(data.leaseGeneration)
    if (currentGeneration === null || currentGeneration !== ownership.generation) {
      return { applied: false }
    }
  } else {
    if (data.createdByAttemptId !== ownership.attemptId) return { applied: false }
    if (data.status !== 'sending') return { applied: false }
    if (data.recipientsReady !== false) return { applied: false }
    if (data.activeAttemptId !== undefined && data.activeAttemptId !== null) {
      return { applied: false }
    }
  }
  return {
    applied: true,
    patch: {
      status: 'failed',
      lastError: errorMessage,
      lastAttemptId: ownership.attemptId,
    },
  }
}

export async function markCampaignFailedTx(
  doc: DocTx,
  ownership: FailureOwnership,
  nowMs: number,
  errorMessage: string,
  buildExtra: (decision: MarkFailedDecision) => Record<string, unknown> = () => ({}),
): Promise<MarkFailedDecision> {
  const snap = await doc.get()
  const decision = decideMarkCampaignFailed(snap, ownership, nowMs, errorMessage)
  if (decision.applied && decision.patch) {
    doc.update({ ...decision.patch, ...buildExtra(decision) })
  }
  return decision
}

// ---------------------------------------------------------------------------
// campaign：回收「建立收件人清單過程中斷」的幽靈狀態
// ---------------------------------------------------------------------------
//
// 這是唯一不需要驗證 attemptId 身分就能把 campaign 標成 failed 的路徑，
// 理由跟 markCampaignFailedTx 的「一律要有身分」原則並不衝突：setup owner
// 一旦真的死掉（逾時、崩潰），永遠不會再回來把自己標成失敗，這個 campaign
// 就會卡住到天荒地老、沒有任何人有「合法身分」能處理它。這裡改成不看身分，
// 而是在同一個 transaction 裡重新驗證一次「現在」是不是真的還處於
// 「建立中且已經中斷太久」的狀態（不是相信呼叫端之前讀到的、可能已經過期
// 的判斷）——安全性來自這個即時重新檢查，不是來自 attemptId。
//
// ⚠️ round 7 修正：這個即時重新檢查過去只看 recipientsReady／status／
// startedAt 三者，沒有檢查 activeAttemptId——如果 campaign 其實已經跳過
// setup、被別的 invocation 拿到處理租約（activeAttemptId 存在），這裡仍然
// 可能把它標成 failed，繞過了 decideMarkCampaignFailed(kind:'setup') 早就
// 有的「activeAttemptId 存在就 fail closed」規則，形同一條旁路。這裡補上
// 同樣的 fail-closed 檢查。

export interface ReclaimAbandonedSetupDecision {
  outcome: 'marked-failed' | 'not-abandoned' | 'indeterminate' | 'not-found'
  patch?: Record<string, unknown>
}

/**
 * 只有以下條件**同時**成立才會回傳 marked-failed：
 * - recipientsReady === false（收件人清單真的還沒寫完）
 * - status === 'sending'（還沒被任何人 finalize）
 * - 完全沒有 activeAttemptId 欄位——理由跟 decideMarkCampaignFailed 的
 *   kind:'setup' 分支一致：recipientsReady 還是 false 時，
 *   acquireCampaignLeaseTx 不可能寫入 activeAttemptId，只要它存在就代表
 *   資料已經跳出了應有的不變量，必須 fail closed，不管租約過期與否、
 *   expiry 能不能解析。
 * - startedAt（新舊格式都試過）能被解析出有效毫秒數，**而且**真的超過
 *   staleMs——無法解析時回傳 indeterminate，不能像過去那樣退回 0
 *  （Unix epoch）當作「早就超過門檻」的依據，那是用猜的、不是真的知道。
 */
export function decideReclaimAbandonedSetup(
  snap: DocSnapshotLike,
  nowMs: number,
  staleMs: number,
  errorMessage: string,
): ReclaimAbandonedSetupDecision {
  if (!snap.exists || !snap.data) return { outcome: 'not-found' }
  const data = snap.data

  // fail closed：activeAttemptId 存在就代表已經有人取得處理租約，不可能
  // 還是「setup 中斷的幽靈狀態」，不論這個租約是否已經過期。
  if (data.activeAttemptId !== undefined && data.activeAttemptId !== null) {
    return { outcome: 'not-abandoned' }
  }
  if (data.recipientsReady !== false || data.status !== 'sending') {
    return { outcome: 'not-abandoned' }
  }

  // 相容讀取：舊文件的建立時間是 Timestamp 型別的 startedAt。
  const startedAtMs = readFirstValidMs(data.startedAtMs, data.startedAt)
  if (startedAtMs === null) {
    return { outcome: 'indeterminate' }
  }
  if (nowMs - startedAtMs <= staleMs) {
    return { outcome: 'not-abandoned' }
  }
  return {
    outcome: 'marked-failed',
    patch: { status: 'failed', lastError: errorMessage },
  }
}

export async function reclaimAbandonedSetupTx(
  doc: DocTx,
  nowMs: number,
  staleMs: number,
  errorMessage: string,
  buildExtra: (decision: ReclaimAbandonedSetupDecision) => Record<string, unknown> = () =>
    ({}),
): Promise<ReclaimAbandonedSetupDecision> {
  const snap = await doc.get()
  const decision = decideReclaimAbandonedSetup(snap, nowMs, staleMs, errorMessage)
  if (decision.outcome === 'marked-failed' && decision.patch) {
    doc.update({ ...decision.patch, ...buildExtra(decision) })
  }
  return decision
}

// ---------------------------------------------------------------------------
// campaign：resolution 租約（round 9 新增，Finding 2；round 10 修正見下）
// ---------------------------------------------------------------------------
//
// resolveDeliveryUnknown 需要「查詢當下真實的收件人分佈」才能安全地增減
// campaign totals（見下方 decideResolveDeliveryUnknown 的說明），但這個
// 查詢本身跟寫入結果的 transaction 是兩個分開的步驟——中間如果有一般寄送
// （sendPendingRecipients）或另一個 resolution 插進來改動收件人，查到的
// 分佈就已經過期。resolution 租約是專門為了獨佔這段「查詢＋寫入」而設計的
// 第二種 campaign 層級租約，跟處理租約（activeAttemptId）互斥、也跟其他
// resolution 互斥：
// - decideAcquireCampaignLease() 已經修改成會檢查 resolution 租約，一般
//   寄送在 resolution 進行中時會被擋下（held-by-other）。
// - 這裡的 decideAcquireResolutionLease() 對稱地檢查處理租約，resolution
//   在一般寄送進行中時也會被擋下。
// 兩種租約用同一個 isCampaignLeaseHeldByOther() 判斷是否仍然有效，只是
// 各自讀寫不同的欄位（activeAttemptId／activeLeaseExpiresAtMs vs
// resolutionLeaseAttemptId／resolutionLeaseExpiresAtMs）。
//
// ⚠️ round 10 修正（Finding 2）：以上「acquire 階段互斥」只能擋下**新的**
// acquire 請求，沒辦法讓一個**已經在 acquire 之後執行中**的舊 invocation
// 自動知道自己該停手——它接下來呼叫的 commitRecipientResultTx／
// finalizeCampaignTx／markCampaignFailedTx 如果只驗證 activeAttemptId 字串
// 是否相符，會發現「相符」（resolution 從不改動 activeAttemptId），因而
// 誤判自己仍然安全、繼續寫入。真正完整的互斥來自 readLeaseGeneration()
// 說明的 fencing generation：processing 與 resolution 共用同一個計數器，
// 任何一次成功的 acquire（不論種類）都會讓它往前推進，所有之後的
// mutation 都必須攜帶自己 acquire 當下的 generation 並在寫入前重新比對。
// acquire 階段的 held-by-other 檢查仍然有用（避免兩個「正要」acquire 的
// 請求同時搶到），但**不能單獨**當作完整的互斥保證。

/** resolution 租約的建議時長：只需要涵蓋「一次非交易查詢＋一次 transaction」，
 *  不需要跟 CAMPAIGN_LEASE_MS 一樣長。 */
export const RESOLUTION_LEASE_MS = 60_000

export type AcquireResolutionLeaseDecision =
  | { outcome: 'acquired'; patch: Record<string, unknown>; generation: number }
  | { outcome: 'processing-lease-active' }
  | { outcome: 'resolution-lease-held' }
  | { outcome: 'not-ready' }
  | { outcome: 'invalid-status' }
  | { outcome: 'not-found' }
  /** round 13 新增（Finding 1）：見 AcquireLeaseDecision 的說明——
   *  campaign.leaseGeneration 存在但格式錯誤，fail closed。 */
  | { outcome: 'invalid-generation' }
  /** round 13 新增（Finding 1）：campaign.leaseGeneration 已達
   *  Number.MAX_SAFE_INTEGER，fail closed。 */
  | { outcome: 'generation-exhausted' }

/**
 * round 10 修正（Finding 2）：成功取得 resolution 租約時，一併把
 * leaseGeneration 往前推進一次——這個 invocation（即使它從不持有處理
 * 租約，只持有 resolution 租約）接下來呼叫 resolveDeliveryUnknownTx 時，
 * 必須攜帶這裡回傳的 generation，讓「resolution 進行中」這件事能被所有
 * processing 端的 mutation（commit／begin／sweep／finalize／markFailed）
 * 用同一個欄位偵測到，不必各自另外檢查 resolutionLeaseAttemptId 是否
 * 存在。見 readLeaseGeneration 的完整說明。
 *
 * ⚠️ round 11 新增（Finding 3）：過去只檢查 processing／resolution 兩種
 * 租約是否互斥，完全沒有驗證這個 campaign 本身「現在」是不是一個合理可以
 * 人工處理 delivery_unknown 的對象——這代表 admin callable 理論上可以對
 * 一個還在建立收件人清單（recipientsReady:false）的 campaign，或已經
 * completed／failed（不可能還有 delivery_unknown 待處理）的 campaign
 * 取得 resolution 租約、推進 generation。前者更嚴重：setup 階段的
 * mutation（reclaimAbandonedSetupTx、createOrJoinCampaignTx 的收尾）完全
 * 不知道 resolution fencing 存在、也不驗證 leaseGeneration，讓 resolution
 * 有機會跟 setup 交錯。這裡新增 fail-closed 檢查，見
 * isResolutionEligibleCampaignStatus／isResolutionEligibleCampaign 的說明；
 * 不合格時回傳明確的 not-ready／invalid-status，讓呼叫端能回報
 * failed-precondition 而不是含糊的內部錯誤。
 */
export function decideAcquireResolutionLease(
  snap: DocSnapshotLike,
  attemptId: string,
  nowMs: number,
  leaseMs: number,
): AcquireResolutionLeaseDecision {
  if (!snap.exists || !snap.data) return { outcome: 'not-found' }
  const data = snap.data

  if (data.recipientsReady !== true) return { outcome: 'not-ready' }
  if (!isResolutionEligibleCampaignStatus(data.status as string | undefined)) {
    return { outcome: 'invalid-status' }
  }

  const processingHeld = isCampaignLeaseHeldByOther(
    {
      activeAttemptId: data.activeAttemptId as string | null | undefined,
      activeLeaseExpiresAtMs: readFirstValidMs(
        data.activeLeaseExpiresAtMs,
        data.activeLeaseExpiresAt,
      ),
    },
    NEVER_A_LEASE_HOLDER,
    nowMs,
  )
  if (processingHeld) return { outcome: 'processing-lease-active' }

  const resolutionHeld = isCampaignLeaseHeldByOther(
    {
      activeAttemptId: data.resolutionLeaseAttemptId as string | null | undefined,
      activeLeaseExpiresAtMs: readFirstValidMs(data.resolutionLeaseExpiresAtMs, undefined),
    },
    attemptId,
    nowMs,
  )
  if (resolutionHeld) return { outcome: 'resolution-lease-held' }

  // round 13 修正（Finding 1）：同 decideAcquireCampaignLease——null 必須
  // fail closed，不能當成 0 繼續 +1；同時防止超出安全整數範圍。round 14
  // 新增：activeAttemptId／resolutionLeaseAttemptId 任一存在卻是
  // baseline 0，同樣不可靜默當成全新 campaign。
  const currentGeneration = readLeaseGeneration(data.leaseGeneration)
  if (currentGeneration === null) return { outcome: 'invalid-generation' }
  if (hasInconsistentLeaseGenerationBaseline(data, currentGeneration)) {
    return { outcome: 'invalid-generation' }
  }
  if (currentGeneration >= Number.MAX_SAFE_INTEGER) return { outcome: 'generation-exhausted' }
  const generation = currentGeneration + 1
  return {
    outcome: 'acquired',
    generation,
    patch: {
      resolutionLeaseAttemptId: attemptId,
      resolutionLeaseExpiresAtMs: nowMs + leaseMs,
      leaseGeneration: generation,
    },
  }
}

export async function acquireResolutionLeaseTx(
  doc: DocTx,
  attemptId: string,
  nowMs: number,
  leaseMs: number,
  buildExtra: (decision: AcquireResolutionLeaseDecision) => Record<string, unknown> = () => ({}),
): Promise<AcquireResolutionLeaseDecision> {
  const snap = await doc.get()
  const decision = decideAcquireResolutionLease(snap, attemptId, nowMs, leaseMs)
  if (decision.outcome === 'acquired') {
    doc.update({ ...decision.patch, ...buildExtra(decision) })
  }
  return decision
}

/** isCampaignLeaseHeldByOther 需要一個「自己的 attemptId」；用在自己從不
 *  持有那一種租約的檢查上時，用一個不可能出現在真實 attemptId（UUID）裡的
 *  固定字串，確保只要對應欄位有任何其他人的值就一律視為 held。 */
const NEVER_A_LEASE_HOLDER = '__never-a-lease-holder__'

// ---------------------------------------------------------------------------
// 收件人：把一批收件人的真實狀態算成 authoritative totals（round 9 新增，Finding 2）
// ---------------------------------------------------------------------------

export interface RecipientStatusForTotals {
  status: RecipientStatus
}

/**
 * 從「查詢當下真實讀到的收件人清單」算出 totals／nonTerminalCount——跟
 * functions/src/index.ts 的 computeCampaignTotals() 是同一份邏輯，抽成
 * 這裡讓兩邊（正常收尾與人工 resolution）共用同一個公式，不會各自維護一份
 * 可能漂移的複製品。
 */
export function computeAuthoritativeRecipientTotals(
  recipients: RecipientStatusForTotals[],
): { totals: CampaignTotalsForFinalize; nonTerminalCount: number } {
  let sent = 0
  let failed = 0
  let exhausted = 0
  let deliveryUnknown = 0
  for (const r of recipients) {
    if (r.status === 'sent') sent += 1
    else if (r.status === 'failed') failed += 1
    else if (r.status === 'exhausted') exhausted += 1
    else if (r.status === 'delivery_unknown') deliveryUnknown += 1
  }
  return {
    totals: { recipients: recipients.length, sent, failed, exhausted, deliveryUnknown },
    nonTerminalCount: countNonTerminalRecipients(recipients),
  }
}

/**
 * Finding 2 item 7／round 10 Finding 4 的最後一道防線：即使呼叫端聲稱這是
 * 查詢當下的真實分佈，寫入前還是驗證完整的分類不變量，不合理就 fail
 * closed，不寫出負數、超出範圍、或彼此矛盾的 totals。這只是防線，不是
 * 完整修復——真正的修復是 resolution 租約 + 真實查詢（見上方的說明），
 * 這裡只是再加一層，避免任何算術錯誤或呼叫端的 bug 意外寫出壞資料。
 *
 * ⚠️ round 10 修正（Finding 4）：過去只驗證「finite 整數、不為負、已分類
 * 的人數總和不超過 recipients、nonTerminalCount 不超過 recipients」——
 * 這幾個條件各自看起來合理，但沒有驗證 nonTerminalCount 跟其他欄位之間
 * **完整**的關係，讓「形狀看似合法，但彼此矛盾」的 totals 有機會通過
 * 驗證、算出錯誤的 campaign 狀態。例如 `{recipients:10, sent:5,
 * exhausted:0, deliveryUnknown:1}` 搭配 `nonTerminalCount:0`——單看
 * `sumOfKnown(6) <= recipients(10)` 與 `nonTerminalCount(0) <=
 * recipients(10)` 都成立，但根據 countNonTerminalRecipients() 的定義
 *（queued／claimed／sending／failed 才算非終止，sent／exhausted／
 * delivery_unknown 不算），真正的 nonTerminalCount 應該是
 * `10-5-0-1=4`，不是 0——如果真的用 0 算 decideCampaignStatus()，會
 * 誤判成「沒有人沒完成」而提早收尾。現在額外要求：
 * - nonTerminalCount 必須**精確等於** recipients-sent-exhausted-deliveryUnknown
 *  （這一個等式本身就是 countNonTerminalRecipients() 排除集合的代數
 *   表達，兩處定義一旦分岔，這裡的測試就會失敗——見對應測試的說明）。
 * - failed 必須是 nonTerminalCount 的子集合（failed <= nonTerminalCount）
 *  ——雖然在上面的等式成立之後這在數學上已經隱含成立，這裡仍然明確列出
 *   做為防線，避免只看單一計算路徑時遺漏。
 */
export function isValidAuthoritativeTotalsShape(
  totals: CampaignTotalsForFinalize,
  nonTerminalCount: number,
): boolean {
  const fields = [
    totals.recipients,
    totals.sent,
    totals.failed,
    totals.exhausted,
    totals.deliveryUnknown,
    nonTerminalCount,
  ]
  if (!fields.every((n) => Number.isInteger(n) && n >= 0)) return false
  const sumOfKnown = totals.sent + totals.failed + totals.exhausted + totals.deliveryUnknown
  if (sumOfKnown > totals.recipients) return false
  if (nonTerminalCount > totals.recipients) return false
  if (totals.failed > nonTerminalCount) return false
  const expectedNonTerminal = totals.recipients - totals.sent - totals.exhausted - totals.deliveryUnknown
  if (nonTerminalCount !== expectedNonTerminal) return false
  return true
}

// ---------------------------------------------------------------------------
// 收件人：delivery_unknown 的人工 resolution（round 8 新增；round 9 修正
// Finding 2／Finding 4：不再信任可能過期的 campaign.totals，改用 resolution
// 租約保護下查詢到的真實分佈；round 10 修正 Finding 1／2／3：resolution
// 也要重新驗證 fencing generation、resolve 時清除 recipient 的舊
// attemptId／lease，並改用 immutable 的 resolutionEvents ledger 判斷
// idempotent／conflict——不再只看 recipient 這個「可變」文件目前的狀態）
// ---------------------------------------------------------------------------
//
// needs_review 是 terminal（isTerminalCampaignStatus），一般的 retryCampaign
// 拿不到處理租約；delivery_unknown 的收件人也永遠不會被一般認領流程碰到
// （isRecipientClaimable 永遠回傳 false）。這代表沒有任何一般流程能讓一個
// 卡在 needs_review 的 campaign 離開這個狀態——必須有一條獨立、明確要求
// admin 身分、而且會留下稽核紀錄的人工 resolution 路徑，不能讓工程人員
// 直接改 Firestore 資料了事（那樣 campaign 的 totals／status 會跟收件人的
// 真實狀態脫鉤，見下面的說明）。

export type DeliveryUnknownResolutionAction = 'mark_delivered' | 'force_retry'

export interface ResolveDeliveryUnknownAudit {
  resolvedBy: string
  /** 呼叫端（前端）產生的 idempotency key，同一次使用者操作重送時必須帶
   *  同一個值——用來區分「同一個請求重送」跟「另一個獨立的 resolution」。
   *  跟 recipient/campaign 的處理租約 attemptId 是完全不同的概念：這個
   *  值代表的是「這一次人類的操作意圖」，attemptId 代表的是「這一次
   *  function invocation 的鎖」，重送時 attemptId 會換新的，resolutionId
   *  不會。
   *
   *  ⚠️ round 10 修正（Finding 3）：一位收件人可能不只一次進入
   *  delivery_unknown（例如 force_retry 之後正常重試又再次逾時），這個
   *  值必須真正**全域唯一**（不能只在單一次 delivery_unknown 週期內唯一）
   *  ——見下方 resolutionEvents ledger 的說明，這是它必須是 immutable
   *  文件 ID 的原因。 */
  resolutionId: string
  resolutionAction: DeliveryUnknownResolutionAction
  resolutionReason: string
}

/**
 * round 10 新增（Finding 3）：一次 resolution 的 immutable 稽核紀錄，寫進
 * campaigns/{campaignId}/resolutionEvents/{resolutionId}，只有 Admin SDK
 * 能寫（Firestore rules 對 client 一律 allow write: if false），寫入後
 * 永遠不會再被修改或刪除。
 *
 * 這個 ledger 存在的唯一理由：round 9 的 idempotency／conflict 判斷是靠
 * recipient 文件上「目前」是否還是 delivery_unknown、以及上面殘留的
 * resolutionId／resolutionAction／resolutionReason 欄位——但這些欄位會被
 * 之後的正常寄送流程覆蓋（force_retry 之後 recipient 變成 failed，之後
 * 被一般 retryCampaign 認領、寄送、可能再次逾時變回 delivery_unknown），
 * 讓同一個 resolutionId 有機會在完全不同的一次 delivery attempt 上被
 * 誤判成「這次 delivery_unknown 的 idempotent 重送」而重新套用（Round 10
 * Finding 3 的原始情境）。改成「resolutionId 這個字串本身是否已經被用過」
 * 才是唯一的真相來源，不再依賴 recipient 這個會被之後的正常流程覆寫的
 * 可變文件——只要 resolutionEvents/{resolutionId} 這份文件存在過，這個
 * resolutionId 就永遠不能再被套用第二次，不論 recipient 後來變成什麼
 * 狀態、又進出 delivery_unknown 幾次。
 */
export interface ResolutionEventRecord {
  recipientId: string
  resolutionAction: DeliveryUnknownResolutionAction
  resolutionReason: string
  resolvedBy: string
  /** 這次 resolution 執行當下的 fencing generation，供稽核／除錯用。 */
  fencingGeneration: number
  /** resolve 之前這位收件人的狀態——目前這支函式只在 status ===
   *  'delivery_unknown' 時才會建立事件，所以永遠是 'delivery_unknown'，
   *  仍然明確記錄下來，避免未來擴充時被誤用。 */
  beforeStatus: 'delivery_unknown'
  afterStatus: 'sent' | 'failed'
}

/**
 * round 21 新增（CI Finding 4）：讀回 resolutionEvents/{resolutionId} 時
 * 過去直接對 eventSnap.data 的每個欄位做 `as` type cast，完全沒有驗證
 * 實際存到 Firestore 裡的內容真的符合 ResolutionEventRecord 的形狀——
 * 一份損毀／被外部工具直接寫壞的 ledger 文件會被無條件當成合法的
 * idempotent-replay 或 conflict 依據。這支函式是唯一的讀回驗證入口，
 * 供 decideResolveDeliveryUnknown 與新的 decideResolveDeliveryUnknownPreflight
 * 共用，確保兩處判斷完全一致；驗證失敗一律 fail closed，回傳 null，呼叫端
 * 必須回報明確的 invalid-ledger-event，絕不能把它當成 idempotent-replay。
 */
export function parseResolutionEventRecord(
  data: Record<string, unknown> | undefined,
): ResolutionEventRecord | null {
  if (!data) return null
  if (typeof data.recipientId !== 'string' || data.recipientId.trim().length === 0) return null
  if (data.resolutionAction !== 'mark_delivered' && data.resolutionAction !== 'force_retry') {
    return null
  }
  if (typeof data.resolutionReason !== 'string' || data.resolutionReason.trim().length === 0) {
    return null
  }
  if (typeof data.resolvedBy !== 'string' || data.resolvedBy.trim().length === 0) return null
  if (data.beforeStatus !== 'delivery_unknown') return null
  if (data.afterStatus !== 'sent' && data.afterStatus !== 'failed') return null
  if (!isSafeNonNegativeInteger(data.fencingGeneration) || (data.fencingGeneration as number) < 1) {
    return null
  }
  return {
    recipientId: data.recipientId,
    resolutionAction: data.resolutionAction,
    resolutionReason: data.resolutionReason,
    resolvedBy: data.resolvedBy,
    beforeStatus: 'delivery_unknown',
    afterStatus: data.afterStatus,
    fencingGeneration: data.fencingGeneration as number,
  }
}

export type ResolveDeliveryUnknownDecision =
  | { outcome: 'campaign-not-found' }
  | { outcome: 'recipient-not-found' }
  /** 呼叫這支的 invocation 已經不再持有 resolution 租約（理論上不該發生：
   *  租約時長只需要涵蓋一次查詢＋一次 transaction，這裡是防禦性檢查）。 */
  | { outcome: 'resolution-lease-lost' }
  /** round 21 新增（CI Finding 4）：resolutionEvents/{resolutionId} 這份
   *  文件存在，但內容無法通過 parseResolutionEventRecord 驗證——fail
   *  closed，絕不能當成 idempotent-replay 或忽略它繼續往下 resolve。 */
  | { outcome: 'invalid-ledger-event' }
  /** authoritativeTotals／authoritativeNonTerminalCount 的形狀不合理，
   *  或跟這位收件人「本身就是 delivery_unknown」矛盾——fail closed。 */
  | { outcome: 'invalid-authoritative-totals' }
  /** resolutionEvents/{resolutionId} 已經存在，且 payload（收件人、
   *  action、reason、resolvedBy）完全相同——idempotent success，回傳
   *  當初已經套用的結果，不重複扣減 totals、不重複建立事件。 */
  | {
      outcome: 'idempotent-replay'
      recipientStatus: 'sent' | 'failed'
      resolvedBy: string
      resolutionAction: DeliveryUnknownResolutionAction
      resolutionReason: string
    }
  /** 這個 resolutionId 沒辦法被套用在這次要求上——可能是：
   *  (a) resolutionEvents/{resolutionId} 已經存在，但 payload 不同
   *     （同一個 resolutionId 被重複使用在不同的 delivery_unknown 週期，
   *      或帶著不同的 action／reason 重送——不能假裝是同一個請求）；
   *  (b) 這個 resolutionId 從沒被用過，但收件人現在已經不是
   *     delivery_unknown（被另一個 resolutionId 的操作處理掉了）。
   *  不論哪一種都不能靜默當成功，必須讓呼叫端知道實際發生了什麼。 */
  | {
      outcome: 'conflict'
      recipientStatus: RecipientStatus
      resolvedBy?: string
      resolutionAction?: DeliveryUnknownResolutionAction
      resolutionReason?: string
    }
  | {
      outcome: 'resolved'
      recipientPatch: Record<string, unknown>
      campaignPatch: Record<string, unknown>
      eventPatch: ResolutionEventRecord
    }

/**
 * 決定一次 delivery_unknown resolution 該怎麼做。
 *
 * ⚠️ round 9 修正（Finding 2）：round 8 版本直接信任 campaign.totals 本身
 * 保持準確、用公式反推 nonTerminalCount。這個假設不成立——recipient 的
 * 寫入與 campaign 的 totals 更新是不同的 transaction，中間可以 crash 或
 * 查詢失敗，讓 campaign.totals 暫時（甚至長期）落後於 recipients 子集合
 * 的真實狀態。round 9 改成呼叫端必須先取得 resolution 租約，在租約保護下
 * 非交易地查詢一次真實的收件人分佈，把結果（authoritativeTotals／
 * authoritativeNonTerminalCount）傳進來。
 *
 * ⚠️ round 10 修正（Finding 2 item 6）：resolution 租約的重新驗證現在
 * 也包含 fencing generation——resolutionGeneration 必須跟 campaign 目前
 * 記錄的 leaseGeneration 相同，見 readLeaseGeneration 的說明。
 *
 * ⚠️ round 10 修正（Finding 3）：idempotent／conflict 判斷完全改成先看
 * eventSnap（resolutionEvents/{resolutionId} 這份 immutable 文件）是否
 * 存在，不再看 recipient 目前的可變狀態——見 ResolutionEventRecord 的
 * 說明。判斷順序：
 * 1. event 已存在、payload 相同 → idempotent-replay。
 * 2. event 已存在、payload 不同 → conflict（不論 recipient 現在是什麼
 *    狀態，這個 resolutionId 都不能被重新套用）。
 * 3. event 不存在，但 recipient 現在不是 delivery_unknown → conflict
 *   （被另一個 resolutionId 處理掉了）。
 * 4. event 不存在，recipient 現在確實是 delivery_unknown → 可以繼續往下
 *    驗證 authoritativeTotals 並執行 resolve，同時建立這個事件。
 *
 * ⚠️ round 10 修正（Finding 1 item 5）：resolve 成功時，除了記錄
 * resolutionOriginalAttemptId 供稽核，也要把 recipient 的 attemptId／
 * leaseExpiresAtMs 清掉（改成 null）——理由跟 sweep 清除的理由一致（見
 * decideReclaimExpiredDeliveryAttempt 的說明）：避免任何遲到的舊 SMTP
 * commit 之後又用「attemptId 相符」蓋掉這次人工決定的結果。
 *
 * ⚠️ round 10 修正（Finding 4 item 6）：resolve 前用
 * isValidAuthoritativeTotalsShape() 驗證輸入，resolve 後算出來的
 * newTotals／newNonTerminalCount 也會再驗證一次才真正回傳 resolved——
 * 雙重防線，避免任何算術路徑上的疏漏意外寫出矛盾的新 totals。
 */
export function decideResolveDeliveryUnknown(
  recipientSnap: DocSnapshotLike,
  campaignSnap: DocSnapshotLike,
  eventSnap: DocSnapshotLike,
  recipientId: string,
  authoritativeTotals: CampaignTotalsForFinalize,
  authoritativeNonTerminalCount: number,
  audit: ResolveDeliveryUnknownAudit,
  resolutionLeaseAttemptId: string,
  resolutionGeneration: number,
  nowMs: number,
): ResolveDeliveryUnknownDecision {
  if (!campaignSnap.exists || !campaignSnap.data) return { outcome: 'campaign-not-found' }
  const campaignData = campaignSnap.data

  if (campaignData.resolutionLeaseAttemptId !== resolutionLeaseAttemptId) {
    return { outcome: 'resolution-lease-lost' }
  }
  const resolutionLeaseMs = readFirstValidMs(campaignData.resolutionLeaseExpiresAtMs, undefined)
  if (resolutionLeaseMs === null || !isLeaseActive(resolutionLeaseMs, nowMs)) {
    return { outcome: 'resolution-lease-lost' }
  }
  // round 13 修正（Finding 1）：任一方 malformed 都 fail closed。
  if (!isValidHeldGeneration(resolutionGeneration)) {
    return { outcome: 'resolution-lease-lost' }
  }
  const currentGeneration = readHeldLeaseGeneration(campaignData.leaseGeneration)
  if (currentGeneration === null || currentGeneration !== resolutionGeneration) {
    return { outcome: 'resolution-lease-lost' }
  }

  if (!recipientSnap.exists || !recipientSnap.data) return { outcome: 'recipient-not-found' }
  const recipientData = recipientSnap.data

  // Finding 3：先看 immutable event ledger，不看 recipient 目前的可變狀態。
  // round 21 修正（CI Finding 4）：不再對 eventSnap.data 的欄位做未經驗證的
  // `as` cast——先用 parseResolutionEventRecord 完整驗證形狀，驗證失敗
  // （損毀的 ledger 文件）一律 fail closed，絕不能當成 idempotent-replay。
  if (eventSnap.exists && eventSnap.data) {
    const event = parseResolutionEventRecord(eventSnap.data)
    if (!event) {
      return { outcome: 'invalid-ledger-event' }
    }
    const sameRequest =
      event.recipientId === recipientId &&
      event.resolutionAction === audit.resolutionAction &&
      event.resolutionReason === audit.resolutionReason &&
      event.resolvedBy === audit.resolvedBy
    if (sameRequest) {
      return {
        outcome: 'idempotent-replay',
        recipientStatus: event.afterStatus,
        resolvedBy: event.resolvedBy,
        resolutionAction: event.resolutionAction,
        resolutionReason: event.resolutionReason,
      }
    }
    return {
      outcome: 'conflict',
      recipientStatus: recipientData.status as RecipientStatus,
      resolvedBy: event.resolvedBy,
      resolutionAction: event.resolutionAction,
      resolutionReason: event.resolutionReason,
    }
  }

  if (recipientData.status !== 'delivery_unknown') {
    // 這個 resolutionId 從沒被用過（上面 eventSnap 不存在），但收件人已經
    // 不是 delivery_unknown——代表被另一個 resolutionId 的操作處理掉了。
    return {
      outcome: 'conflict',
      recipientStatus: recipientData.status as RecipientStatus,
      resolvedBy: recipientData.resolvedBy as string | undefined,
      resolutionAction: recipientData.resolutionAction as DeliveryUnknownResolutionAction | undefined,
      resolutionReason: recipientData.resolutionReason as string | undefined,
    }
  }

  if (!isValidAuthoritativeTotalsShape(authoritativeTotals, authoritativeNonTerminalCount)) {
    return { outcome: 'invalid-authoritative-totals' }
  }
  if (authoritativeTotals.deliveryUnknown < 1) {
    // 這位收件人本身就是 delivery_unknown，真實分佈裡至少要算進這一位；
    // 是 0 代表傳進來的分佈跟這位收件人的真實狀態自相矛盾。
    return { outcome: 'invalid-authoritative-totals' }
  }

  let newTotals: CampaignTotalsForFinalize
  let newNonTerminalCount: number
  let newRecipientStatus: 'sent' | 'failed'
  if (audit.resolutionAction === 'mark_delivered') {
    newTotals = {
      ...authoritativeTotals,
      sent: authoritativeTotals.sent + 1,
      deliveryUnknown: authoritativeTotals.deliveryUnknown - 1,
    }
    newNonTerminalCount = authoritativeNonTerminalCount
    newRecipientStatus = 'sent'
  } else {
    newTotals = {
      ...authoritativeTotals,
      failed: authoritativeTotals.failed + 1,
      deliveryUnknown: authoritativeTotals.deliveryUnknown - 1,
    }
    newNonTerminalCount = authoritativeNonTerminalCount + 1
    newRecipientStatus = 'failed'
  }
  // Finding 4 item 6：寫回前再驗證一次算出來的新 totals 本身也合理。
  if (!isValidAuthoritativeTotalsShape(newTotals, newNonTerminalCount)) {
    return { outcome: 'invalid-authoritative-totals' }
  }
  const newCampaignStatus = decideCampaignStatus(newTotals, newNonTerminalCount)

  return {
    outcome: 'resolved',
    recipientPatch: {
      status: newRecipientStatus,
      resolvedBy: audit.resolvedBy,
      resolutionId: audit.resolutionId,
      resolutionAction: audit.resolutionAction,
      resolutionReason: audit.resolutionReason,
      resolutionOriginalAttemptId: (recipientData.attemptId as string | null | undefined) ?? null,
      // Finding 1 item 5：清掉舊 attemptId／lease，避免遲到的舊 SMTP
      // commit 之後用「attemptId 相符」蓋掉這次人工決定的結果。
      attemptId: null,
      leaseExpiresAtMs: null,
    },
    campaignPatch: {
      status: newCampaignStatus,
      'totals.recipients': newTotals.recipients,
      'totals.sent': newTotals.sent,
      'totals.failed': newTotals.failed,
      'totals.exhausted': newTotals.exhausted,
      'totals.deliveryUnknown': newTotals.deliveryUnknown,
    },
    eventPatch: {
      recipientId,
      resolutionAction: audit.resolutionAction,
      resolutionReason: audit.resolutionReason,
      resolvedBy: audit.resolvedBy,
      fencingGeneration: resolutionGeneration,
      beforeStatus: 'delivery_unknown',
      afterStatus: newRecipientStatus,
    },
  }
}

/**
 * 執行一次 delivery_unknown resolution：在同一個 transaction 內同時讀取
 * 收件人、campaign、resolutionEvents/{resolutionId} 三份文件、決定該怎麼
 * 做；只要呼叫這支的 invocation 曾經合法取得 resolution 租約（不論最後
 * 決定是 resolved 或其他任何 outcome），這個 transaction 都會一併釋放
 * 租約——不留給租約自然過期，避免不必要地擋住其他人。只有
 * campaign-not-found／resolution-lease-lost 這兩種情況代表我們一開始就
 * 沒有可以釋放的東西。
 *
 * round 10 新增：resolved 時額外 `eventDoc.set()` 寫入 immutable 的
 * resolutionEvents/{resolutionId}——用 `set()` 不用 `update()`，因為這是
 * 第一次、也是唯一一次寫入這份文件（Firestore rules 禁止任何後續的
 * client 端 create／update／delete，見 firestore.rules）。
 */
export async function resolveDeliveryUnknownTx(
  recipientDoc: DocTx,
  campaignDoc: DocTx,
  eventDoc: DocTx,
  recipientId: string,
  authoritativeTotals: CampaignTotalsForFinalize,
  authoritativeNonTerminalCount: number,
  audit: ResolveDeliveryUnknownAudit,
  resolutionLeaseAttemptId: string,
  resolutionGeneration: number,
  nowMs: number,
  buildRecipientExtra: (
    decision: ResolveDeliveryUnknownDecision,
  ) => Record<string, unknown> = () => ({}),
  buildCampaignExtra: (
    decision: ResolveDeliveryUnknownDecision,
  ) => Record<string, unknown> = () => ({}),
  buildEventExtra: (
    decision: ResolveDeliveryUnknownDecision,
  ) => Record<string, unknown> = () => ({}),
): Promise<ResolveDeliveryUnknownDecision> {
  const recipientSnap = await recipientDoc.get()
  const campaignSnap = await campaignDoc.get()
  const eventSnap = await eventDoc.get()
  const decision = decideResolveDeliveryUnknown(
    recipientSnap,
    campaignSnap,
    eventSnap,
    recipientId,
    authoritativeTotals,
    authoritativeNonTerminalCount,
    audit,
    resolutionLeaseAttemptId,
    resolutionGeneration,
    nowMs,
  )
  if (decision.outcome === 'resolved') {
    recipientDoc.update({ ...decision.recipientPatch, ...buildRecipientExtra(decision) })
    campaignDoc.update({ ...decision.campaignPatch, ...buildCampaignExtra(decision) })
    eventDoc.set({ ...decision.eventPatch, ...buildEventExtra(decision) })
  } else if (decision.outcome !== 'campaign-not-found' && decision.outcome !== 'resolution-lease-lost') {
    // 這個 invocation 曾經合法持有 resolution 租約，即使這次沒有真的
    // resolve 任何東西（idempotent-replay／conflict／recipient-not-found／
    // invalid-authoritative-totals），還是要主動釋放，不留給它自然過期。
    campaignDoc.update({ ...buildCampaignExtra(decision) })
  }
  return decision
}

// ---------------------------------------------------------------------------
// round 21 新增（CI Finding 1）：resolveDeliveryUnknown 的 replay／conflict
// preflight——修正「acquireResolutionLeaseTx 在 campaign 已經 completed／
// failed 之後一律回傳 invalid-status，導致 idempotent-replay／conflict 永遠
// 讀不到」的問題。
//
// 根本原因：decideAcquireResolutionLease 只檢查 campaign 本身的狀態／租約／
// generation，完全不知道 resolutionEvents/{resolutionId} 或 recipient 現在
// 是什麼狀態；decideResolveDeliveryUnknown 才會讀 event／recipient，但它只
// 在成功取得 resolution 租約「之後」才會被呼叫到。當第一次 resolve 已經把
// campaign 帶進 completed／failed（terminal，不再 isResolutionEligible）之
// 後，第二次同 resolutionId 的重送、或另一個 resolutionId 針對同一位已經
// 被處理掉的收件人送出的請求，會在 acquire 這一步就被擋下、回傳
// invalid-status——呼叫端沒有機會知道「其實是重送」或「其實已經被別人處理
// 過」，這違反 ResolutionEventRecord／decideResolveDeliveryUnknown 上方
// 記載的 idempotent-replay／conflict 契約。
//
// 修正方式：新增一個純讀取、不取任何租約、不做任何寫入的 preflight——直接
// 把 decideResolveDeliveryUnknown 判斷 event／recipient 的那段邏輯獨立出來，
// 在嘗試 acquire resolution 租約「之前」先跑一次。只要 preflight 判斷出
// idempotent-replay／conflict／invalid-ledger-event／recipient-not-found，
// 就不需要（也不應該）再去 acquire 租約——這些結果在 campaign 是否 terminal
// 之下都必須可讀到，但也都絕對不能反過來重新 acquire 租約、動 recipient、
// 動 campaign totals／status、或建立第二個事件。只有 preflight 判斷「event
// 不存在、recipient 現在確實還是 delivery_unknown」（'proceed'）時，才會
// 繼續往下 acquire 租約、查詢 authoritative totals、進最終的
// resolveDeliveryUnknownTx transaction。
//
// ⚠️ preflight 是 fast-path，不是最終的權威判斷——它讀完到最終 transaction
// 真正提交之間仍然有競態窗口（另一個 invocation 可能在這之間搶到租約、完成
// resolve）。所以：
// - acquireResolutionLeaseTx／resolveDeliveryUnknownTx 完全不變，仍然在自己
//   的 transaction 裡重新讀一次 lease／generation／event／recipient 並重新
//   判斷——preflight 的結果絕不取代它們的重新驗證。
// - coordinateResolveDeliveryUnknown（見下方）處理了 preflight 說可以
//   proceed、但實際 acquire 租約時才發現 campaign 已經變成 invalid-status
//   的競態：這代表兩次 preflight 讀取之間，campaign 被另一個 invocation
//   推進到了 terminal 狀態，所以會再跑一次 preflight 取得權威原因（多半是
//   idempotent-replay／conflict），而不是把原始的 invalid-status 直接丟給
//   使用者。
// ---------------------------------------------------------------------------

export type ResolveDeliveryUnknownPreflightDecision =
  | { outcome: 'campaign-not-found' }
  | { outcome: 'recipient-not-found' }
  | { outcome: 'invalid-ledger-event' }
  | {
      outcome: 'idempotent-replay'
      recipientStatus: 'sent' | 'failed'
      resolvedBy: string
      resolutionAction: DeliveryUnknownResolutionAction
      resolutionReason: string
    }
  | {
      outcome: 'conflict'
      recipientStatus: RecipientStatus
      resolvedBy?: string
      resolutionAction?: DeliveryUnknownResolutionAction
      resolutionReason?: string
    }
  /** event 不存在，recipient 現在確實還是 delivery_unknown——可以（也應該）
   *  繼續往下嘗試 acquire resolution 租約，不能在這裡直接當成任何一種
   *  「已經有結果」的 outcome。呼叫端不應該把這個值原樣回傳給使用者。 */
  | { outcome: 'proceed' }

/**
 * 純函式、唯讀：不取租約、不寫入任何東西。判斷順序跟
 * decideResolveDeliveryUnknown 裡 event／recipient 那段完全一致（共用同一個
 * parseResolutionEventRecord），刻意保持這兩處判斷不會分岔。
 */
export function decideResolveDeliveryUnknownPreflight(
  recipientSnap: DocSnapshotLike,
  campaignSnap: DocSnapshotLike,
  eventSnap: DocSnapshotLike,
  recipientId: string,
  audit: ResolveDeliveryUnknownAudit,
): ResolveDeliveryUnknownPreflightDecision {
  if (!campaignSnap.exists || !campaignSnap.data) return { outcome: 'campaign-not-found' }
  if (!recipientSnap.exists || !recipientSnap.data) return { outcome: 'recipient-not-found' }
  const recipientData = recipientSnap.data

  if (eventSnap.exists && eventSnap.data) {
    const event = parseResolutionEventRecord(eventSnap.data)
    if (!event) return { outcome: 'invalid-ledger-event' }
    const sameRequest =
      event.recipientId === recipientId &&
      event.resolutionAction === audit.resolutionAction &&
      event.resolutionReason === audit.resolutionReason &&
      event.resolvedBy === audit.resolvedBy
    if (sameRequest) {
      return {
        outcome: 'idempotent-replay',
        recipientStatus: event.afterStatus,
        resolvedBy: event.resolvedBy,
        resolutionAction: event.resolutionAction,
        resolutionReason: event.resolutionReason,
      }
    }
    return {
      outcome: 'conflict',
      recipientStatus: recipientData.status as RecipientStatus,
      resolvedBy: event.resolvedBy,
      resolutionAction: event.resolutionAction,
      resolutionReason: event.resolutionReason,
    }
  }

  if (recipientData.status !== 'delivery_unknown') {
    return {
      outcome: 'conflict',
      recipientStatus: recipientData.status as RecipientStatus,
      resolvedBy: recipientData.resolvedBy as string | undefined,
      resolutionAction: recipientData.resolutionAction as DeliveryUnknownResolutionAction | undefined,
      resolutionReason: recipientData.resolutionReason as string | undefined,
    }
  }

  return { outcome: 'proceed' }
}

/** 把 preflight 包成跟其他 *Tx 函式一致的介面（唯讀，不會呼叫 set／update）。
 *  刻意設計成可以在自己單獨的 transaction／單獨的一組 .get() 裡執行，
 *  不要求跟 acquireResolutionLeaseTx 或 resolveDeliveryUnknownTx 共用同一個
 *  transaction——preflight 本來就只是 fast path，不需要跟它們的原子性綁在
 *  一起（也綁不了：它必須在 acquire 租約「之前」跑）。 */
export async function resolveDeliveryUnknownPreflightTx(
  recipientDoc: DocTx,
  campaignDoc: DocTx,
  eventDoc: DocTx,
  recipientId: string,
  audit: ResolveDeliveryUnknownAudit,
): Promise<ResolveDeliveryUnknownPreflightDecision> {
  const recipientSnap = await recipientDoc.get()
  const campaignSnap = await campaignDoc.get()
  const eventSnap = await eventDoc.get()
  return decideResolveDeliveryUnknownPreflight(recipientSnap, campaignSnap, eventSnap, recipientId, audit)
}

/** coordinateResolveDeliveryUnknown 對外回傳的結果——刻意排除 preflight 的
 *  'proceed'：那只是內部控制流程，絕不應該被當成最終結果回傳給呼叫端。 */
export type CoordinateResolveDeliveryUnknownResult =
  | Exclude<ResolveDeliveryUnknownPreflightDecision, { outcome: 'proceed' }>
  | Exclude<AcquireResolutionLeaseDecision, { outcome: 'acquired' }>
  | ResolveDeliveryUnknownDecision

export interface CoordinateResolveDeliveryUnknownRefs {
  /** 建一個新的 transaction，在裡面透過 mk('recipient'|'campaign'|'event')
   *  取得對應文件的 DocTx。production 用 db.runTransaction + docTx()；
   *  emulator 測試用 firebase/firestore 的 runTransaction + 對應的
   *  clientDocTx()——兩邊只是 wiring 不同，實際跑的判斷邏輯（本檔案）完全
   *  相同，這正是這支協調函式存在的目的：production callable 與 emulator
   *  測試不能再各自維護一份可能漂移的 orchestration 複製品。 */
  runTransaction<T>(
    work: (mk: (target: 'recipient' | 'campaign' | 'event') => DocTx) => Promise<T>,
  ): Promise<T>
  /** 在 resolution 租約保護下（呼叫方必須確認已經成功 acquire 之後才會呼叫
   *  這裡），非交易地查出目前真實的收件人狀態分佈，供
   *  computeAuthoritativeRecipientTotals 使用。 */
  queryAuthoritativeRecipients(): Promise<RecipientStatusForTotals[]>
}

/**
 * round 21 新增（CI Finding 1）：resolveDeliveryUnknown 唯一的協調流程，
 * production（functions/src/index.ts 的 resolveDeliveryUnknown callable）
 * 與 emulator 測試（tests/campaignConcurrency.test.ts 的本地 helper）都必須
 * 呼叫這支，不能各自重新實作一份可能漂移的版本（見上方 refs 參數的說明）。
 *
 * 步驟：
 * 1. preflight（唯讀，不取租約）——event 已存在或 recipient 已經不是
 *    delivery_unknown，直接回傳 idempotent-replay／conflict／
 *    invalid-ledger-event／recipient-not-found／campaign-not-found，
 *    完全不去 acquire 租約。
 * 2. 只有 preflight 回傳 'proceed' 才 acquire resolution 租約。
 *    - 如果這裡回傳 invalid-status：代表 preflight 讀完之後、acquire 之前，
 *      另一個 invocation 已經搶先完成了 resolve、把 campaign 帶進
 *      terminal 狀態——重新跑一次 preflight 取得權威原因（多半會是
 *      idempotent-replay／conflict），不能把原始 invalid-status 直接丟給
 *      使用者（那就是這次修正要解決的原始問題）。如果重新 preflight 仍然是
 *      'proceed'，代表真的是其他原因（例如 campaign 資料本身壞了），原樣
 *      回傳 invalid-status。
 *    - acquire 失敗的其他 outcome（not-found／not-ready／
 *      processing-lease-active／resolution-lease-held／invalid-generation／
 *      generation-exhausted）原樣回傳，不需要特別處理。
 * 3. acquire 成功後，查詢 authoritative totals、進最終的
 *    resolveDeliveryUnknownTx transaction——這一步完全不變，仍然會自己重新
 *    驗證 lease／generation／event／recipient（見該函式的說明），preflight
 *    的結果不能、也沒有取代這裡的重新驗證。
 *
 * ⚠️ round 23 修正（P2）：`nowMs` 從單一數字改成 `() => number` 的 clock
 * function。round 21 引入這支協調函式之前，acquire 與最終 transaction
 * 各自在自己執行的當下呼叫一次 `Date.now()`；round 21 把兩邊改成共用
 * callable 頂層算好、只算一次的同一個數字，結果最終 transaction（在
 * `refs.queryAuthoritativeRecipients()`——一次可能耗時、非交易的 Firestore
 * 查詢——跑完之後才執行）拿到的「現在」永遠等於（甚至早於）acquire 當下的
 * 時間，structurally 不可能觀察到「query 拖太久、租約在等待期間真的過期」
 * 這件事：`resolveDeliveryUnknownTx` 裡的租約到期檢查（比較
 * `resolutionLeaseExpiresAtMs` 與 `nowMs`）永遠是拿一個偏舊、偏早的快照去比
 * ——查詢真的拖過期限也看不出來。現在改回讓每個 transaction 在自己實際執行
 * 的那一刻呼叫 `nowMs()`：acquire 的 transaction 呼叫一次，最終
 * transaction 另外、獨立呼叫一次，兩者之間隔著那段可能很慢的查詢，任何
 * 真實流逝的時間都會被兩次各自新讀的呼叫如實反映。這是額外一層防護，不是
 * 取代 leaseGeneration／resolutionGeneration 的 fencing 檢查——generation
 * fencing 仍然是主要的互斥保證，clock 只是讓「租約已過期」這個判斷本身不再
 * 結構性地失明。
 */
export async function coordinateResolveDeliveryUnknown(
  refs: CoordinateResolveDeliveryUnknownRefs,
  recipientId: string,
  audit: ResolveDeliveryUnknownAudit,
  resolutionLeaseAttemptId: string,
  /** round 23 修正：注入的 clock，不是預先算好的數字——見上方函式說明。
   *  呼叫端必須傳一個每次呼叫都重新讀取即時時間的函式（production 是
   *  `() => Date.now()`），不能傳一個提早算好、閉包住的常數。 */
  nowMs: () => number,
  leaseMs: number,
  buildLeaseExtra: (decision: AcquireResolutionLeaseDecision) => Record<string, unknown> = () => ({}),
  buildRecipientExtra: (
    decision: ResolveDeliveryUnknownDecision,
  ) => Record<string, unknown> = () => ({}),
  buildCampaignExtra: (
    decision: ResolveDeliveryUnknownDecision,
  ) => Record<string, unknown> = () => ({}),
  buildEventExtra: (decision: ResolveDeliveryUnknownDecision) => Record<string, unknown> = () => ({}),
): Promise<CoordinateResolveDeliveryUnknownResult> {
  const runPreflight = () =>
    refs.runTransaction((mk) =>
      resolveDeliveryUnknownPreflightTx(mk('recipient'), mk('campaign'), mk('event'), recipientId, audit),
    )

  const preflight = await runPreflight()
  if (preflight.outcome !== 'proceed') return preflight

  const leaseDecision = await refs.runTransaction((mk) =>
    acquireResolutionLeaseTx(mk('campaign'), resolutionLeaseAttemptId, nowMs(), leaseMs, buildLeaseExtra),
  )
  if (leaseDecision.outcome === 'invalid-status') {
    // 競態：preflight 讀完之後、acquire 之前，另一個 invocation 已經把
    // campaign 帶進了 terminal 狀態——重新問一次權威原因，不要把
    // invalid-status 原樣丟出去（那正是這次要修的問題）。
    const recheck = await runPreflight()
    if (recheck.outcome !== 'proceed') return recheck
    return leaseDecision
  }
  if (leaseDecision.outcome !== 'acquired') return leaseDecision

  const recipients = await refs.queryAuthoritativeRecipients()
  const { totals, nonTerminalCount } = computeAuthoritativeRecipientTotals(recipients)

  return refs.runTransaction((mk) =>
    resolveDeliveryUnknownTx(
      mk('recipient'),
      mk('campaign'),
      mk('event'),
      recipientId,
      totals,
      nonTerminalCount,
      audit,
      resolutionLeaseAttemptId,
      leaseDecision.generation,
      nowMs(),
      buildRecipientExtra,
      buildCampaignExtra,
      buildEventExtra,
    ),
  )
}

// ---------------------------------------------------------------------------
// campaign：原子建立（收件人清單已經驗證完成、準備好之後才呼叫）
// ---------------------------------------------------------------------------

export interface CreateOrJoinResult {
  created: boolean
  existingData?: Record<string, unknown>
}

/**
 * 原子性地「不存在才建立」。呼叫端必須先完成所有不具寄送副作用的驗證
 * （展開收件人、檢查語言版本完整性等）、組好 initialData 之後才呼叫這支——
 * 不能在驗證前就呼叫，否則可預期的輸入錯誤（沒選名單、名單是空的、缺語言
 * 版本…）會在文件已經建立之後才被發現，留下永遠不會被處理的幽靈 campaign
 * 並且污染這個 idempotencyKey（之後同一個 key 的正常請求會一直看到這個
 * 半吊子的文件）。
 *
 * 兩個帶著同一個 idempotencyKey 的請求同時呼叫，Firestore 對衝突中的
 * transaction 會自動偵測並重試落敗的一方，落敗的一方會讀到贏家寫入的
 * existingData —— 呼叫端此時必須直接採用贏家的結果（走 decideCampaignResume
 * 的 resume／wait／abandoned 分支），不能自己重新建立收件人。
 */
export async function createOrJoinCampaignTx(
  doc: DocTx,
  attemptId: string,
  initialData: Record<string, unknown>,
): Promise<CreateOrJoinResult> {
  const snap = await doc.get()
  if (snap.exists) {
    return { created: false, existingData: snap.data }
  }
  doc.set({ ...initialData, createdByAttemptId: attemptId })
  return { created: true }
}

// =============================================================================
// campaign：取得處理租約之後的整段寄送流程（可注入依賴，直接可測）
// =============================================================================
//
// round 4 的教訓：這段流程（讀寄信需要的資料、載入附件、讀 SMTP 設定與
// 密碼、建立 transporter、verify、實際寄送、finalize、任何一步失敗時的
// 收尾）曾經只活在 functions/src/index.ts 的 runSendPhaseAfterLeaseAcquired()
// 裡，因為頂層 initializeApp() 的關係沒辦法被測試匯入，round 6 的報告也
// 老實承認了這個最深層的 recovery 分支完全沒有自動化測試覆蓋，
// tests/campaignConcurrency.test.ts 只測了它依賴的底層狀態機片段
//（finalizeCampaignTx／markCampaignFailedTx…），沒有真正執行過這段
// orchestration 本身的控制流程（attemptedSend 分岔、recovery 失敗時
// 保留原始錯誤、transporter 何時該 close…）。
//
// round 7 把這段流程本身抽成 runSendPhase()：每一個步驟都透過 deps 注入，
// 這支函式完全不 import 任何 Firestore／Nodemailer／firebase-functions
// 的型別或模組（連 HttpsError 都不在這裡處理——那是 Firebase Functions
// 專屬的類別，只有 functions/package.json 裝了這個套件，這裡 import 會讓
// 根目錄的測試在沒有這個套件的情況下無法執行；HttpsError 的分類與包裝
// 交給 functions/src/index.ts 的薄 wrapper 在呼叫這支函式的外層處理）。
// production（functions/src/index.ts 的 runSendPhaseAfterLeaseAcquired）
// 與測試呼叫的是同一份函式，差別只在測試傳進去的 deps 是完全可控制的假
// 實作，不需要連模擬器，也不需要真的寄信。

export interface SendPhaseDeps<Press, EmailSettings, Attachments, Settings, Transporter> {
  /** 讀新聞稿、email 設定等寄信需要的資料。 */
  loadSendInputs(): Promise<{ press: Press; emailSettings: EmailSettings }>
  /** 載入附件。 */
  loadAttachments(press: Press): Promise<Attachments>
  /** 讀 SMTP 主機／帳密等設定（含 Secret Manager 密碼）。 */
  readSmtpSettings(): Promise<Settings>
  /** 依設定建立 transporter。 */
  createTransport(settings: Settings): Promise<Transporter>
  /** 驗證 SMTP 連線（transporter.verify()）。 */
  verifyTransport(transporter: Transporter): Promise<void>
  /** 實際寄送這一批收件人，回傳寄送完之後的真實 totals／nonTerminalCount。 */
  sendPending(input: {
    press: Press
    emailSettings: EmailSettings
    settings: Settings
    transporter: Transporter
    attachments: Attachments
  }): Promise<{ totals: CampaignTotalsForFinalize; nonTerminalCount: number }>
  /** 不依賴任何記憶體中的計數，直接查 Firestore 現在的真實狀態重新算一次。 */
  computeTotals(): Promise<{ totals: CampaignTotalsForFinalize; nonTerminalCount: number }>
  /** 收尾並釋放租約；diagnosticMessage 只在中斷後的 recovery 路徑才會給。
   *  round 18 修正（Finding 1）：回傳型別擴充成 CampaignFinalizeStatus——
   *  campaign 可能因為新聞稿同步中繼資料無法安全判斷而被阻擋，不會變成
   *  terminal，見該型別的說明。 */
  finalize(
    totals: CampaignTotalsForFinalize,
    nonTerminalCount: number,
    diagnosticMessage?: string,
  ): Promise<CampaignFinalizeStatus>
  /** 確定零封寄出（attemptedSend 還是 false）時，安全地標記失敗並釋放租約。 */
  markFailed(err: unknown): Promise<void>
  /** 關閉 transporter（只有真的建立成功才會被呼叫）。 */
  closeTransport(transporter: Transporter): void
  /** 記錄錯誤，不影響控制流程。 */
  logError(message: string, meta?: Record<string, unknown>): void
  /** 目前時間，只用於 log 的診斷欄位，不影響任何判斷邏輯。 */
  now(): number
}

export interface SendPhaseResult {
  status: CampaignFinalizeStatus
}

/**
 * 已經成功取得 campaign 處理租約之後，接手完成整個寄送流程。
 *
 * ⚠️ 例外處理刻意分成兩種情況（見 round 1 的原始問題）：
 *
 * 1. attemptedSend 還是 false（loadSendInputs／loadAttachments／讀 SMTP
 *    設定或密碼／建立 transporter／verify 這幾步任何一步失敗）——這個
 *    階段還沒開始呼叫 sendPending()，確定連一封信都還沒嘗試寄送，可以
 *    安全地呼叫 deps.markFailed() 寫成 terminal failed，不會有任何收件人
 *    被誤傷。
 *
 * 2. attemptedSend 已經是 true（sendPending() 已經開始跑，可能已經有部分
 *    收件人真的寄出成功）——這時候絕對不能直接假設「全部失敗」而寫成
 *    terminal failed：已經 sent 的人必須保留，還沒到終止狀態的人也還要
 *    能被 retryCampaign 接續。做法是不依賴任何在記憶體裡算到一半的計數，
 *    改用 deps.computeTotals() 重新查一次 Firestore 的真實狀態，交給
 *    deps.finalize()（跟正常收尾走同一套 decideCampaignStatus 公式）
 *    判斷：還有未完成的人 → partial（可以 retry，只會認領還沒到終止狀態
 *    的收件人）；剛好全部人都已經到終止狀態但沒人成功 → failed 才是
 *    「真正發生的事實」，不是武斷寫入的。如果連這次「重新確認進度」都
 *    失敗（例如 Firestore 本身暫時不可用），不會再嘗試任何寫入、也不會
 *    用 terminal failed 蓋過去——campaign 就留在目前的狀態（通常仍是
 *    sending，不是 terminal），租約到期後可以被 retryCampaign 重新接手。
 *
 * 不論哪種情況，這支函式最後都會把**原始**例外原封不動地重新拋出——不
 * 包裝、不替換成別的錯誤物件，讓呼叫端（functions/src/index.ts）自己決定
 * 要怎麼分類、包裝成什麼樣的錯誤回應給使用者。這是刻意的設計：這裡是
 * SDK-agnostic 的協調邏輯，不應該知道「HttpsError」這個 Firebase
 * Functions 專屬的概念，也不應該讓「補救寫入失敗」這件事蓋掉原始錯誤的
 * 真正原因。
 *
 * ⚠️ 這裡處理的仍然只是「Firestore 裡的狀態該怎麼收尾」，不是 SMTP
 * exactly-once：如果 sendMail 其實已經成功、只是 Function 在寫回 Firestore
 * 之前被中止，這個 ambiguity 本來就無法用狀態機消除，見檔頭的說明。
 */
export async function runSendPhase<Press, EmailSettings, Attachments, Settings, Transporter>(
  deps: SendPhaseDeps<Press, EmailSettings, Attachments, Settings, Transporter>,
): Promise<SendPhaseResult> {
  let transporter: Transporter | undefined
  let attemptedSend = false
  try {
    const { press, emailSettings } = await deps.loadSendInputs()
    const attachments = await deps.loadAttachments(press)
    const settings = await deps.readSmtpSettings()
    transporter = await deps.createTransport(settings)
    await deps.verifyTransport(transporter)

    attemptedSend = true
    const { totals, nonTerminalCount } = await deps.sendPending({
      press,
      emailSettings,
      settings,
      transporter,
      attachments,
    })
    const status = await deps.finalize(totals, nonTerminalCount)
    return { status }
  } catch (err) {
    deps.logError('取得處理租約後的寄送流程發生錯誤', {
      attemptedSend,
      nowMs: deps.now(),
      error: (err as Error)?.message,
    })

    if (!attemptedSend) {
      // 還沒開始處理任何收件人，確定零封寄出，可以安全標記為 failed。
      // markFailed 本身也可能失敗（例如寫入 Firestore 時斷線）——不能讓
      // 那個新錯誤取代原始錯誤，否則下面 throw err 丟出的就不是真正的
      // 根因，呼叫端也拿不到原始的 HttpsError code/message。
      try {
        await deps.markFailed(err)
      } catch (markFailedErr) {
        deps.logError('標記 campaign 為 failed 時也失敗了，保留原始錯誤，不覆寫', {
          markFailedError: (markFailedErr as Error)?.message,
        })
      }
    } else {
      // 已經開始處理收件人，不能武斷假設全部失敗——用真實資料重新收尾。
      try {
        const { totals, nonTerminalCount } = await deps.computeTotals()
        await deps.finalize(
          totals,
          nonTerminalCount,
          `寄送過程中發生未預期錯誤而中斷：${(err as Error)?.message ?? '未知錯誤'}`,
        )
      } catch (recoveryErr) {
        // 連重新確認進度都做不到——不要因為這次補救寫入失敗，就讓原始
        // 錯誤被蓋掉，也不要武斷把 campaign 寫成 terminal failed。保留
        // 現況（通常仍是可以重試的 sending），下面照樣把原始 err 往外拋。
        deps.logError(
          '中斷後嘗試用真實狀態重新收尾也失敗，保留 campaign 現況，不覆寫狀態',
          { recoveryError: (recoveryErr as Error)?.message },
        )
      }
    }

    throw err
  } finally {
    // round 8 修正（Finding 3）：finally 裡拋出的例外會直接取代 try/catch
    // 決定好要回傳或拋出的東西——包括上面 catch 區塊最後重新拋出的
    // **原始** err。如果 closeTransport 本身拋錯（例如 timeout 已經呼叫過
    // 一次 close，這裡是同一個 transporter 的第二次 close），沒有
    // try/catch 包住的話，一個成功寄完的結果會被憑空改判成整個 callable
    // 失敗，一個真正的 SMTP／Firestore 錯誤也會被這個無關的 close 錯誤
    // 取代掉。close 在這裡永遠只能是 best-effort：失敗就記錄，不能讓它
    // 覆蓋已經決定好的成功結果，也不能覆蓋原始例外。
    if (transporter !== undefined) {
      try {
        deps.closeTransport(transporter)
      } catch (closeErr) {
        deps.logError('關閉 transporter 失敗（best-effort，不影響寄送結果或原始錯誤）', {
          error: (closeErr as Error)?.message,
        })
      }
    }
  }
}

// ---------------------------------------------------------------------------
// campaign：no-send reconciliation（round 14 新增，Finding 2）
// ---------------------------------------------------------------------------
//
// ⚠️ 部署 runbook（見 functions/src/index.ts 頂部）過去建議「受控觸發一次
// retryCampaign」把過期的 sending 收件人轉成 delivery_unknown——這是錯的：
// retryCampaign 是完整的正常寄送流程（載入新聞稿／附件、建立並驗證 SMTP
// transporter、呼叫 sendPendingRecipients 認領並寄送 queued／failed／過期
// claimed 的收件人），不是純粹的狀態校正。維運人員如果只是想把卡住的
// sending 收件人轉成 delivery_unknown，呼叫 retryCampaign 可能同時真的寄出
// 其他收件人的信，違反 maintenance pause 的初衷。
//
// 這裡改成獨立的 no-send 校正流程：只做狀態校正，**絕對不**建立 SMTP
// transporter、不讀 SMTP 密碼、不呼叫 sendMail、不認領 queued／failed／
// claimed 收件人、不呼叫 sendPendingRecipients——這些依賴完全不在
// ReconcileCampaignDeliveryDeps 的介面裡，結構上就不可能被誤用。

export type ReconcileCampaignDeliveryOutcome =
  | { outcome: 'not-found' }
  | { outcome: 'terminal' }
  | { outcome: 'not-ready' }
  | { outcome: 'held-by-other' }
  | { outcome: 'invalid-generation' }
  | { outcome: 'generation-exhausted' }
  /** round 15 新增（Finding 1）：finalize 階段發現這個租約已經不再是
   *  這次 invocation 的（理論上不該發生——reclaim／finalize 全程都在同一
   *  次取得的租約保護下執行，但兩者是各自獨立的 transaction，中間仍有
   *  極短的 race window）。finalize 沒有寫入任何 totals／status，這次
   *  校正**沒有真正生效**，不能回報 reconciled。 */
  | { outcome: 'superseded' }
  /** round 18 新增（Finding 2）：取得處理租約之後，讀到至少一位收件人的
   *  status 缺失、型別錯誤、或不是已知的 RecipientStatus 字串——資料本身
   *  已經不可信，不能假設「這位反正跟我要處理的無關」就略過。整個校正
   *  流程立刻中止，不 reclaim、不 finalize、不修改任何收件人，只會
   *  best-effort 釋放這次取得的處理租約。 */
  | { outcome: 'invalid-recipient-state' }
  /** round 18 新增（Finding 1）：finalize 階段判定新聞稿同步中繼資料無法
   *  安全判斷，或已確認需要同步卻找不到新聞稿——campaign **沒有**變成
   *  terminal，只有這次持有的處理租約被安全釋放（finalize 本身已經處理
   *  好，這裡不需要再呼叫 releaseLeaseBestEffort）。呼叫端必須把這個
   *  outcome 轉譯成明確的錯誤，不能假裝校正已經完成。 */
  | { outcome: 'blocked'; reason: 'invalid-campaign-metadata' | 'press-release-not-found' }
  | {
      outcome: 'reconciled'
      /** 這次校正把多少位過期／無法解析 lease 的 sending 收件人轉成
       *  delivery_unknown。 */
      reclaimedCount: number
      totals: CampaignTotalsForFinalize
      nonTerminalCount: number
      /** round 15 修正（Finding 1）：只有 finalize 真的寫入合法 campaign
       *  status 時才會走到這個分支——這裡收斂成 CampaignStatus，不再是
       *  FinalizeDecision['outcome']（那個型別還包含 superseded／
       *  not-found，這兩種已經被上面獨立的 outcome 攔截，不可能出現在
       *  這裡）。 */
      finalStatus: CampaignStatus
    }

export interface ReconcileCampaignDeliveryDeps {
  /** 安全取得 processing 租約——跟正常寄送用同一種租約（acquireCampaignLeaseTx），
   *  不需要另一種租約型別；重點是這支協調函式完全不會用這個租約去呼叫
   *  SMTP，只用來做狀態校正時的互斥。 */
  acquireLease(): Promise<AcquireLeaseDecision>
  /**
   * round 18 新增（Finding 2）：取得處理租約之後，第一件事就是讀「全部」
   * 收件人的 status（不是只有目前 status==='sending' 的）——只需要 status
   * 欄位，不需要 email／姓名等 PII，用來在做任何 reclaim／finalize 之前
   * 先確認資料本身可信。跟 audit-campaign-drain.mjs／
   * classifyRecipientForDrainAudit 共用同一份 isKnownRecipientStatus()
   * 判斷已知合法值，不能各自維護一份容易漂移的複製品。
   */
  listAllRecipientStatuses(): Promise<{ status: unknown }[]>
  /** 列出目前 status 為 'sending' 的收件人 id——不分是否過期，交給
   *  reclaimExpiredDeliveryAttempt 在 transaction 內自己判斷；claimed／
   *  queued／failed 完全不在這支函式的處理範圍內，連讀取都不需要。只有
   *  在 listAllRecipientStatuses() 確認全部收件人狀態合法之後才會被
   *  呼叫。 */
  listSendingRecipientIds(): Promise<string[]>
  /** 對單一收件人執行 reclaimExpiredDeliveryAttemptTx（過期或無法解析的
   *  sending → delivery_unknown；仍在合法租期內的完全不動）。 */
  reclaimExpiredDeliveryAttempt(
    recipientId: string,
  ): Promise<ReclaimExpiredDeliveryAttemptDecision>
  /**
   * 重新查詢真實的 recipient 分佈（跟 resolveDeliveryUnknown／
   * computeCampaignTotals 用同一份 computeAuthoritativeRecipientTotals
   * 公式）。
   *
   * round 19 新增（Finding 3）：這是整個校正流程裡「最後一次」讀取
   * recipient 狀態、也是直接餵給 finalize() 的那一次查詢——跟稍早
   * listAllRecipientStatuses() 的驗證讀取是**兩次獨立的 Firestore
   * 查詢**，中間夾著整個 reclaim 迴圈（可能耗時，視收件人數量而定）。
   * 雖然本系統目前所有會寫入 recipient.status 的 production 路徑
   *（claimRecipientTx／beginDeliveryAttemptTx／commitRecipientResultTx／
   * reclaimExpiredDeliveryAttemptTx／resolveDeliveryUnknownTx）都會在同一
   * 個 transaction 內原子驗證呼叫端持有的 campaign activeAttemptId／
   * leaseGeneration 與目前 Firestore 的值相符，而 reconciliation 自己
   * 一旦透過 acquireLease() 拿到租約，會讓 leaseGeneration 往前推進、
   * 佔用 activeAttemptId，理論上會讓任何「更早」取得舊 generation 的
   * invocation 之後的寫入都被這些 transaction 自己的 fencing 檔下（見
   * reconcileCampaignDelivery 上方對這份 fencing 證據的完整說明）——這仍然
   * 只是「本系統目前程式碼路徑」提供的保證，不是 Firestore 本身的形式化
   * 保證：不能排除未來新增的程式碼、一次性的資料修復腳本、或人工在
   * Firestore Console 直接編輯，繞過這一整套 fencing 邏輯直接寫入
   * recipient.status。這支函式因此改成回傳一個明確的 outcome：如果這次
   * 讀到的「當下」資料裡仍然有任何一位收件人的 status 不是已知合法值，
   * 回報 `invalid-recipient-state`，不會回傳可能已經跟現實脫鉤的 totals，
   * 呼叫端（reconcileCampaignDelivery）必須直接中止、不呼叫 finalize()。
   */
  computeAuthoritativeTotals(): Promise<
    | {
        outcome: 'ok'
        totals: CampaignTotalsForFinalize
        nonTerminalCount: number
      }
    | { outcome: 'invalid-recipient-state' }
  >
  /** 用重新查到的 totals 收尾並釋放租約——沿用既有的
   *  finalizeCampaignWithPressReleaseTx，不重新發明一套寫入邏輯。round 18
   *  修正（Finding 1）：回傳型別多了 `{outcome:'blocked', reason}`——
   *  新聞稿同步中繼資料無法安全判斷時，finalize 本身就不會寫入 campaign
   *  的 terminal patch（只會安全釋放租約），呼叫端不需要再自己額外處理
   *  釋放。 */
  finalize(
    totals: CampaignTotalsForFinalize,
    nonTerminalCount: number,
  ): Promise<
    FinalizeDecision | { outcome: 'blocked'; reason: 'invalid-campaign-metadata' | 'press-release-not-found' }
  >
  /**
   * round 15 新增（Finding 2）：安全釋放這次取得的處理租約（見
   * releaseCampaignProcessingLeaseTx 的說明）——**只**在取得租約「之後」
   * 發生未預期例外，或（round 18 新增，Finding 2）發現收件人狀態不可信
   *（invalid-recipient-state）時才會被呼叫，best-effort，呼叫端必須確保
   * 失敗時只記錄不拋出（見下方 reconcileCampaignDelivery 的說明）。
   * finalize 成功、not-found、superseded，或確認已經失去租約
   *（held-by-other）的路徑都**不會**呼叫這個 dep——那些情況下如果還嘗試
   * 釋放，可能會誤刪一個已經合法轉移給別人的租約。
   */
  releaseLeaseBestEffort(): Promise<void>
  logWarn(message: string, meta?: Record<string, unknown>): void
  logError(message: string, meta?: Record<string, unknown>): void
}

/** round 18 新增（Finding 2）：reconciliation 在取得處理租約之後、做任何
 *  reclaim／finalize 之前，必須先確認「全部」收件人（不是只有目前
 *  status==='sending' 的）的 status 欄位都是已知合法值——沒有這一步，
 *  malformed／unknown 的收件人狀態會被 reconciliation 完全忽略：既不會
 *  被 reclaim（因為根本不是 'sending'，不會出現在
 *  listSendingRecipientIds() 裡），也會在
 *  computeAuthoritativeRecipientTotals() 裡被排除在已知分類之外（那支
 *  函式本身對未知 status 目前也只是不計入任何已知分類，不會報錯），讓
 *  finalize 用一份不完整、可能誤導的分佈把 campaign 收尾。這支函式跟
 *  classifyRecipientForDrainAudit／audit-campaign-drain.mjs 共用同一份
 *  isKnownRecipientStatus() 判斷，不能讓 production 的驗證標準跟 audit
 *  漂移。 */
export function areAllRecipientStatusesKnown(recipients: { status: unknown }[]): boolean {
  return recipients.every((r) => isKnownRecipientStatus(r.status))
}

/**
 * 只校正狀態、絕對不寄信的 reconciliation 流程（round 14 新增，
 * Finding 2；round 15 修正 Finding 1／2；round 18 修正 Finding 2；round 19
 * 修正 Finding 3／4）：
 * 1. 安全取得 processing 租約（沒取得就直接回報對應的 outcome——這一步
 *    本身失敗代表連租約都沒取得，不會寫入任何東西；但**成功**取得租約
 *    這一步本身就是一次 campaign 文件的寫入，見下方步驟 2／4 的說明）。
 * 2. round 18 新增：讀取「全部」收件人的 status，確認都是已知合法值——
 *    只要有一位不合法，立刻中止（不 reclaim、不 finalize、不修改任何
 *    收件人），best-effort 釋放這次取得的租約，回報
 *   'invalid-recipient-state'。⚠️ round 19 修正（Finding 4，報告用詞精確
 *    化）：準確的說法是「零 recipient mutation、零 terminal 狀態寫入」，
 *    不是「完全沒有寫入」——步驟 1 的 acquireLease 與這裡的
 *    releaseLeaseBestEffort 都會各寫一次 campaign 的租約欄位。
 * 3. 對每一位目前 status 是 'sending' 的收件人呼叫
 *    reclaimExpiredDeliveryAttemptTx——只有真的過期或 lease 無法解析的
 *    才會被轉成 delivery_unknown，仍在合法租期內的完全不會被動到。
 * 4. round 19 修正（Finding 3）：重新查真實的 recipient 分佈——這是
 *    finalize() 之前**最後一次**讀取，即使步驟 2 已經驗證過，這裡仍然
 *    再驗證一次「當下」讀到的資料：任何一位收件人變成不可信的 status，
 *    一樣立刻中止、best-effort 釋放租約，不呼叫 finalize()（見
 *    computeAuthoritativeTotals() 上方對這個檢查為什麼必要的完整說明）。
 * 5. 用共用的 finalize 邏輯更新 totals／status，同時釋放這次取得的租約
 *   （finalizeCampaignTx 本身就會在寫入最終狀態的同時釋放租約）。
 *
 * ⚠️ round 15 修正（Finding 1）：round 14 版本無條件把 finalize 的結果包
 * 成 `outcome: 'reconciled'`——如果 finalize 回傳 `superseded`（租約在
 * 極短的 race window 內被別人取代）或 `not-found`（campaign 在校正過程中
 * 消失），**根本沒有真正寫入任何東西**，卻仍然對外宣稱「校正成功」。這裡
 * 改成先檢查 finalize 的實際結果，只有真的寫入合法 CampaignStatus 才回報
 * reconciled；superseded／not-found 都是獨立、明確的非成功 outcome。
 *
 * ⚠️ round 15 修正（Finding 2）：round 14 版本刻意不嘗試釋放租約（當時
 * 認為沒有安全的「只釋放、不改狀態」原語），任何未預期例外都只能讓租約
 * 自然過期（CAMPAIGN_LEASE_MS，660 秒），會卡住寄送與再次校正將近 11
 * 分鐘。現在有了 releaseCampaignProcessingLeaseTx 這個安全原語（只在確認
 * 仍是自己持有時才清欄位），這裡在取得租約「之後」的任何未預期例外都會
 * 先嘗試 best-effort 釋放，再把原始例外原封不動往外拋——釋放本身失敗只
 * 記錄，不能取代原始錯誤（見下面 catch 區塊）。這仍然**不是**「標記
 * campaign 失敗」：一次校正失敗不代表 campaign 本身失敗，不會、也不能
 * 武斷覆寫成 terminal failed。
 */
export async function reconcileCampaignDelivery(
  deps: ReconcileCampaignDeliveryDeps,
): Promise<ReconcileCampaignDeliveryOutcome> {
  const lease = await deps.acquireLease()
  if (lease.outcome !== 'acquired') {
    return { outcome: lease.outcome }
  }

  try {
    // round 18 新增（Finding 2）：在做任何 reclaim／finalize 之前，先確認
    // 全部收件人的 status 都是已知合法值——這一步刻意跟下面的
    // listSendingRecipientIds() 分開查，因為必須在任何寫入發生「之前」
    // 就攔下來，不能讓 reclaim 迴圈先跑過一輪才發現資料不可信。
    const allStatuses = await deps.listAllRecipientStatuses()
    if (!areAllRecipientStatusesKnown(allStatuses)) {
      // round 19 修正（Finding 4，報告用詞精確化）：這裡「拒絕校正」指的
      // 是零 recipient mutation、零 campaign terminal 狀態（status／
      // totals／completedAt）寫入——不是完全沒有寫入：上面 acquireLease()
      // 已經寫過一次 campaign 的租約欄位，下面的 releaseLeaseBestEffort()
      // 會再寫一次（best-effort 釋放）。呼叫端不應該把這個 outcome 理解成
      // 「這次呼叫對 Firestore 完全沒有任何影響」。
      deps.logWarn(
        'reconcileCampaignDelivery：發現無法辨識的收件人狀態，拒絕校正' +
          '（零 recipient mutation、零 terminal 狀態寫入，但租約欄位仍會被取得／釋放各寫一次）',
        { recipientCount: allStatuses.length },
      )
      try {
        await deps.releaseLeaseBestEffort()
      } catch (releaseErr) {
        deps.logError('reconcileCampaignDelivery：釋放租約失敗（best-effort，不影響原始結果）', {
          error: (releaseErr as Error)?.message,
        })
      }
      return { outcome: 'invalid-recipient-state' }
    }

    const sendingIds = await deps.listSendingRecipientIds()
    let reclaimedCount = 0
    for (const recipientId of sendingIds) {
      const decision = await deps.reclaimExpiredDeliveryAttempt(recipientId)
      if (decision.outcome === 'marked-unknown') {
        reclaimedCount += 1
      } else if (decision.outcome === 'caller-lost-campaign-lease') {
        // 租約在校正過程中被別人取代（理論上不該發生，因為這整個流程都
        // 在同一次取得的租約保護下執行，但這裡不假設）——立刻停止，不
        // 繼續處理剩下的收件人，也不要再往下寫 totals（那些數字可能已經
        // 過期）。這是「確認已經失去租約」的情況，不能再嘗試釋放（那個
        // 租約現在是別人的），直接回報。
        deps.logWarn('reconcileCampaignDelivery：校正過程中失去 campaign 處理租約，提前中止', {
          recipientId,
          reclaimedCount,
        })
        return { outcome: 'held-by-other' }
      }
      // 'not-expired'／'not-found'：這位收件人不需要（或已經不需要）校正，
      // 繼續處理下一位。
    }

    // round 19 新增（Finding 3）：這是 finalize() 之前「最後一次」讀取
    // recipient 狀態——即使稍早 listAllRecipientStatuses() 驗證通過，這裡
    // 仍然重新驗證一次「當下」讀到的資料，不假設兩次讀取之間必然一致（見
    // computeAuthoritativeTotals() 上方的完整說明）。只要有任何一位收件人
    // 的 status 變成不可信，立刻中止、best-effort 釋放租約，不呼叫
    // finalize()——這個時間點為止，唯一發生過的寫入是上面 reclaim 迴圈
    // 本身（每一筆都是個別、已經被自己的 transaction fencing 保護過的
    // 合法轉換），不會有任何 campaign 終止狀態或收件人被這裡的中止動作
    // 波及。
    const authoritative = await deps.computeAuthoritativeTotals()
    if (authoritative.outcome === 'invalid-recipient-state') {
      deps.logWarn(
        'reconcileCampaignDelivery：重新查詢 authoritative totals 時發現無法辨識的收件人狀態' +
          '（可能是稍早驗證通過之後才發生的變更），拒絕收尾，不寫入任何 campaign 終止狀態',
        { reclaimedCount },
      )
      try {
        await deps.releaseLeaseBestEffort()
      } catch (releaseErr) {
        deps.logError('reconcileCampaignDelivery：釋放租約失敗（best-effort，不影響原始結果）', {
          error: (releaseErr as Error)?.message,
        })
      }
      return { outcome: 'invalid-recipient-state' }
    }
    const { totals, nonTerminalCount } = authoritative
    const finalizeResult = await deps.finalize(totals, nonTerminalCount)
    if (finalizeResult.outcome === 'not-found') {
      // campaign 在校正過程中消失，沒有東西可以、也不需要釋放。
      return { outcome: 'not-found' }
    }
    if (finalizeResult.outcome === 'superseded') {
      // finalize 自己判定「不再是這次 invocation 的租約」——它沒有寫入
      // 任何東西；租約可能已經被別人合法接手，這裡不能再嘗試釋放（會
      // 誤刪別人的）。
      return { outcome: 'superseded' }
    }
    // round 18 新增（Finding 1）：finalize 判定新聞稿同步中繼資料無法
    // 安全判斷、或找不到新聞稿——campaign 沒有變成 terminal，finalize 自己
    // 已經處理好安全釋放租約（見 finalizeCampaignWithPressReleaseTx 的
    //  blocked 分支），這裡不需要再呼叫 releaseLeaseBestEffort。
    if (finalizeResult.outcome === 'blocked') {
      deps.logWarn('reconcileCampaignDelivery：新聞稿同步中繼資料無法安全判斷，校正被阻擋，campaign 維持非終止狀態', {
        reason: finalizeResult.reason,
      })
      return { outcome: 'blocked', reason: finalizeResult.reason }
    }
    // finalize 成功寫入最終狀態，它自己的 patch 就已經釋放了租約。
    return {
      outcome: 'reconciled',
      reclaimedCount,
      totals,
      nonTerminalCount,
      finalStatus: finalizeResult.outcome,
    }
  } catch (err) {
    deps.logError('reconcileCampaignDelivery 發生未預期錯誤，嘗試安全釋放租約', {
      error: (err as Error)?.message,
    })
    try {
      await deps.releaseLeaseBestEffort()
    } catch (releaseErr) {
      // best-effort：釋放失敗只記錄，不能取代原始錯誤，也不能吞掉它。
      deps.logError('reconcileCampaignDelivery：釋放租約失敗（best-effort，不影響原始錯誤）', {
        error: (releaseErr as Error)?.message,
      })
    }
    throw err
  }
}

// ---------------------------------------------------------------------------
// 部署 drain audit：純分類邏輯（round 14 新增，Finding 3）
// ---------------------------------------------------------------------------
//
// 這裡的分類公式必須跟 functions/src/index.ts 頂部的部署 runbook【淨空
// 判斷標準】逐字對應——刻意抽成這裡的純函式，讓 functions/scripts/
// audit-campaign-drain.mjs（唯讀稽核工具）與這裡的單元測試共用同一份
// 邏輯，不要各自維護一份容易漂移的複製品。

/** 單一租約（processing 或 resolution）的分類。 */
export type LeaseAuditClassification = 'absent' | 'active' | 'indeterminate' | 'stale'

/** round 18 新增（Finding 4）：owner attemptId 是否「合法存在」的唯一
 *  權威判斷——processing lease、resolution lease、lease generation 三個
 *  分類器都必須用這同一份 parser，不能各自寫一份容易漂移、寬鬆程度不一的
 *  判斷。
 *
 * - 完全缺失（`undefined`／`null`）→ 'absent'：從未被任何人持有過，或
 *   已經被正常釋放（`FieldValue.delete()` 之後讀回來就是這個狀態）。
 * - 是字串，且 trim 之後仍非空 → 'present'：合法存在一個 owner。
 * - 其餘所有情況（空字串、只有空白、數字、布林、物件、陣列…）→
 *  'malformed'：這是 round 18 修正的核心——這些值都不是
 *   `undefined`／`null`，舊版的 `attemptId !== undefined && attemptId
 *   !== null` 判斷會把它們全部當成「存在」，配合租約已過期（'stale'，
 *   severity SAFE）與 `leaseGeneration >= 1`，可能讓一份實際上資料損毀
 *   的文件被誤判成 SAFE。'malformed' 既不是 'absent'（不能假設沒人
 *   持有過），也不能被當成合法的 'present'（不能假設它是一個真正的
 *   attemptId），必須讓呼叫端 fail closed。 */
export type LeaseOwnerPresence = 'absent' | 'present' | 'malformed'

export function parseLeaseOwner(value: unknown): LeaseOwnerPresence {
  if (value === undefined || value === null) return 'absent'
  if (typeof value === 'string' && value.trim().length > 0) return 'present'
  return 'malformed'
}

/**
 * 分類一個租約目前的狀態：
 * - owner 完全缺失 → 'absent'（從未被任何人持有過，或已經被正常釋放）。
 * - owner 存在但格式錯誤（round 18 修正，Finding 4：例如空字串、只有
 *   空白、數字、物件）→ 'indeterminate'：fail closed，不能被 stale 的
 *   expiry 洗成 SAFE。
 * - owner 合法存在，但 expiry 無法解析（缺失或格式錯誤）→
 *   'indeterminate'——fail closed，不能猜測「應該已經過期」。
 * - owner 合法存在，expiry 尚未過期 → 'active'。
 * - owner 合法存在，expiry 已過期 → 'stale'。
 */
export function classifyLeaseForAudit(
  attemptId: unknown,
  expiresAtMs: unknown,
  expiresAtLegacy: unknown,
  nowMs: number,
): LeaseAuditClassification {
  const owner = parseLeaseOwner(attemptId)
  if (owner === 'absent') return 'absent'
  if (owner === 'malformed') return 'indeterminate'
  const parsedMs = readFirstValidMs(expiresAtMs, expiresAtLegacy)
  if (parsedMs === null) return 'indeterminate'
  return isLeaseActive(parsedMs, nowMs) ? 'active' : 'stale'
}

/**
 * round 16 新增（Finding 2）：round 14／15 的 drain audit 完全沒有讀取或
 * 分類 `campaign.leaseGeneration`——這個欄位是 processing 租約與
 * resolution 租約**共用**的 fencing token（見檔案上方
 * readLeaseGeneration／isValidHeldGeneration 的完整說明：任何一次成功
 * acquire，不論是哪一種租約，都會讓它往前推進）。沒有檢查它，會漏掉三種
 * production 端 acquireCampaignLeaseTx／acquireResolutionLeaseTx 會直接
 * 拒絕、audit 卻可能誤判成 SAFE 的狀況：
 * - `activeAttemptId`／`resolutionLeaseAttemptId` 任一存在，但
 *   `leaseGeneration` 缺失、是 `0`、或不是合法的 safe integer——租約過期
 *   後，processing／resolution lease 分類會回傳 'stale'（severity SAFE），
 *   完全不會反映「這個 campaign 的 fencing 欄位本身處於不一致狀態」。
 * - `leaseGeneration` 本身是格式錯誤的值（字串、負數、非整數、超出
 *   `Number.isSafeInteger` 範圍）——不論有沒有 owner，都代表資料已經
 *   損毀，不能被忽略。
 * - `leaseGeneration` 已經到達 `Number.MAX_SAFE_INTEGER`——
 *   `decideAcquireCampaignLease`／`decideAcquireResolutionLease` 之後任何
 *   一次 acquire 都會回傳 `generation-exhausted`，這個 campaign 事實上已經
 *   無法再被任何合法流程（包含 reconciliation 自己的 acquireLease）恢復，
 *   需要人工修復 `leaseGeneration` 欄位本身，不是「等待」或「reconcile」
 *   能解決的，必須用獨立於 INDETERMINATE 的分類明確標示出來，讓 runbook
 *   能給出正確的修復指引（見 functions/src/index.ts 頂部 runbook 的
 *   對應章節），不能被 fold 進普通的「資料看起來壞掉」訊息裡。
 *
 * 分類規則：
 * - `readLeaseGeneration(leaseGeneration)` 解析失敗（欄位存在但不是合法
 *   非負 safe integer）→ 'indeterminate'：不論是否有 owner，都 fail
 *   closed。
 * - 解析出來的值 `>= Number.MAX_SAFE_INTEGER` → 'exhausted'：不論是否有
 *   owner，下一次 acquire 一定會被 production 拒絕。
 * - 有 owner（`processingAttemptId` 或 `resolutionAttemptId` 任一存在）
 *   但解析出來的值 `< 1`（缺失或明確是 `0`，也就是 baseline）→
 *  'indeterminate'：這是不可能的組合——任何一次成功 acquire 都會把
 *   generation 寫到 >=1，見 `hasInconsistentLeaseGenerationBaseline` 的
 *   說明。
 * - 沒有 owner 時，baseline（缺失或 `0`）是唯一合法值 → 'ok'。
 * - 有 owner 且解析出來的值 `>= 1` 且未到達上限 → 'ok'。
 *
 * round 18 修正（Finding 4）：owner 存在性改用 parseLeaseOwner()——跟
 * classifyLeaseForAudit 共用同一份 parser，不再各自寫一份寬鬆程度不同的
 * 判斷。owner 欄位「存在但格式錯誤」（malformed）本身就是需要 fail
 * closed 的資料問題，不能被忽略或誤判成「沒有 owner」。
 */
export type LeaseGenerationClassification = 'ok' | 'indeterminate' | 'exhausted'

export function classifyLeaseGenerationForDrainAudit(
  processingAttemptId: unknown,
  resolutionAttemptId: unknown,
  leaseGeneration: unknown,
): LeaseGenerationClassification {
  const parsed = readLeaseGeneration(leaseGeneration)
  if (parsed === null) return 'indeterminate'
  if (parsed >= Number.MAX_SAFE_INTEGER) return 'exhausted'
  const processingOwner = parseLeaseOwner(processingAttemptId)
  const resolutionOwner = parseLeaseOwner(resolutionAttemptId)
  if (processingOwner === 'malformed' || resolutionOwner === 'malformed') return 'indeterminate'
  const hasOwner = processingOwner === 'present' || resolutionOwner === 'present'
  if (hasOwner && parsed < 1) return 'indeterminate'
  return 'ok'
}

/** 單一 recipient 目前的分類。 */
export type RecipientDrainClassification = 'safe' | 'active' | 'indeterminate' | 'unknown'

/** round 15 修正（Finding 4）：status 改成 unknown——過去這裡的型別直接
 *  寫死 `'claimed' | 'sending'`，配合呼叫端只查詢
 *  `where('status', 'in', ['claimed', 'sending'])`，會讓任何未知、缺失、
 *  或被寫成非字串的 status 完全不會出現在稽核結果裡，可能把已經損毀的
 *  資料誤判成 SAFE。見 classifyRecipientForDrainAudit 的完整說明。 */
export interface RecipientDrainSample {
  status: unknown
  leaseExpiresAtMs: unknown
  leaseExpiresAtLegacy: unknown
}

const KNOWN_RECIPIENT_STATUSES: ReadonlySet<string> = new Set([
  'queued',
  'claimed',
  'sending',
  'sent',
  'failed',
  'exhausted',
  'delivery_unknown',
])

/** round 18 新增（Finding 2）：判斷一個值是不是已知合法的
 *  RecipientStatus 字串——classifyRecipientForDrainAudit 與
 *  reconciliation 的 areAllRecipientStatusesKnown() 共用同一份判斷，
 *  不能各自維護一份容易漂移的複製品（見 reconcileCampaignDelivery 的
 *  說明：這正是 audit 與 production 之間過去唯一的差異來源）。 */
export function isKnownRecipientStatus(value: unknown): value is RecipientStatus {
  return typeof value === 'string' && KNOWN_RECIPIENT_STATUSES.has(value)
}

/**
 * round 15 修正（Finding 4）：status 不再假設一定是 'claimed' 或
 * 'sending'——呼叫端現在會把「所有」收件人（不再只查 claimed／sending）
 * 都送進來，任何未知、缺失、或非字串的 status 都必須先被這裡攔下來，
 * 一律 fail closed 成 'indeterminate'，不能被沉默地跳過。
 *
 * - status 不是已知的 RecipientStatus 字串之一 → 'indeterminate'（資料
 *   本身已經不可信，不能假設它是安全的終止狀態，也不能假設它需要
 *   reconciliation）。
 * - status 是已知的終止狀態（queued／sent／failed／exhausted／
 *   delivery_unknown）→ 'safe'（這幾種狀態完全不影響部署淨空判斷；
 *   queued 從未被 claim 過，其餘都已經是最終結果）。
 * - status 是 'claimed' 或 'sending'，套用跟 round 14 相同的 lease 分類：
 *   - lease 無法解析（缺失／格式錯誤）：claimed → 'safe'（SMTP 根本還沒
 *     被呼叫過）；sending → 'unknown'（delivery 狀態不明）。
 *   - lease 尚未過期 → 'active'（可能還在合法處理中）。
 *   - lease 已過期：claimed → 'safe'；sending → 'unknown'。
 */
export function classifyRecipientForDrainAudit(
  sample: RecipientDrainSample,
  nowMs: number,
): RecipientDrainClassification {
  const status = sample.status
  if (!isKnownRecipientStatus(status)) {
    return 'indeterminate'
  }
  if (status !== 'claimed' && status !== 'sending') {
    return 'safe'
  }
  const parsedMs = readFirstValidMs(sample.leaseExpiresAtMs, sample.leaseExpiresAtLegacy)
  if (parsedMs === null) {
    return status === 'claimed' ? 'safe' : 'unknown'
  }
  if (isLeaseActive(parsedMs, nowMs)) return 'active'
  return status === 'claimed' ? 'safe' : 'unknown'
}

/** round 16 新增（Finding 1）：只有非空字串才算「這個欄位合法存在一個
 *  attemptId」——`0`、`{}`、`''` 這類值雖然不是 `undefined`／`null`，但也
 *  不是任何 acquire 邏輯會寫入的合法 attemptId 格式，不能被當成「有人
 *  合法持有」的證據，否則會被拿來當作跳過 fail-closed 檢查的漏洞。 */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/**
 * round 15 新增（Finding 3）、round 16 修正（Finding 1）：建立收件人清單
 * 階段（setup phase）的分類——campaign 剛建立、`recipientsReady` 還是
 * `false`、還沒有人取得 `activeAttemptId` 時，舊 revision 可能仍在寫入
 * recipients 子集合，這時完全沒有 processing lease、也可能還沒有任何
 * claimed／sending 收件人——round 14 的 audit 完全沒有檢查這個階段，會把
 * 它誤判成 SAFE。
 *
 * ⚠️ round 16 修正（Finding 1）：round 15 版本有一個 fail-open 缺口——
 * 只要 `activeAttemptId` 存在（不論 `recipientsReady` 是什麼值）就直接
 * 回傳 `not-setup-phase`，理由是「這個不一致已經會被 processing lease
 * 分類捕捉到」。但 processing lease 分類（`classifyLeaseForAudit`）對
 * 「租約已過期」只會回傳 `stale`，`stale` 的 severity 是 SAFE——如果剛好
 * 沒有任何 claimed／sending 收件人，整份 campaign 就會被判成 SAFE，即使
 * `recipientsReady:false` 加上 `activeAttemptId` 存在本身就是一個不可能
 * 的組合（`acquireCampaignLeaseTx` 要求 `recipientsReady===true` 才會
 * 核發租約，理論上這兩者不該同時出現）。這裡不再假設「別的規則會接住」，
 * 這個不一致本身就必須在這裡直接 fail closed。
 *
 * 判斷依據跟 decideReclaimAbandonedSetup() 的不變量完全對應：
 * - `recipientsReady === true`：不是 setup 階段，交給其他規則判斷，回傳
 *  'not-setup-phase'（不論 activeAttemptId 是什麼——這是唯一合法允許
 *   activeAttemptId 同時存在的狀態：setup 已完成、目前正在被處理）。
 * - `recipientsReady === false` 且 `activeAttemptId` 是合法的非空字串：
 *   'indeterminate'——round 16 修正的核心：這是不可能的組合，不能假設
 *   「一定會被 processing lease 擋住」，必須自己 fail closed。
 * - `recipientsReady` 既不是 `true` 也不是 `false`（缺失、或被寫成其他
 *   型別）→ 'indeterminate'：不是可證明的合法狀態，**不論**
 *   `activeAttemptId` 是否存在——round 15 版本這裡的判斷順序反過來，
 *   讓「activeAttemptId 存在」意外地讓一個 malformed 的 `recipientsReady`
 *   被放行成 `not-setup-phase`。
 * - `status` 不是 `'sending'` → 'indeterminate'：`recipientsReady===false`
 *   只可能與 `status==='sending'` 合法共存（其餘狀態都必須先通過
 *   `recipientsReady===true` 的 acquire 才能到達，見
 *   `decideReclaimAbandonedSetup` 的說明），這個組合本身已經跳出不變量，
 *   而且沒有 `activeAttemptId` 可以讓其他規則捕捉到，必須自己 fail closed。
 * - `createdByAttemptId` 不是合法的非空字串 → 'indeterminate'：建立者
 *   身分本身不明。
 * - `startedAtMs`／`startedAt`（新舊格式）無法解析 → 'indeterminate'：
 *   無法證明這個 setup 是不是已經超過門檻，不能猜測。
 * - 還沒超過 `RECIPIENTS_SETUP_STALE_MS` → 'active'：setup 很可能還在
 *   合法進行中。
 * - 已經超過門檻 → 'unknown'：**不是** SAFE——沒有排程會自動回收（見
 *   decideReclaimAbandonedSetup／reclaimAbandonedSetupTx），舊 revision
 *   仍可能正在寫入，必須先呼叫 reclaimAbandonedSetupTx 或走人工確認，
 *   才能視為淨空。
 */
export type SetupPhaseClassification = 'not-setup-phase' | 'active' | 'indeterminate' | 'unknown'

export interface SetupPhaseAuditInput {
  status: unknown
  recipientsReady: unknown
  activeAttemptId: unknown
  createdByAttemptId: unknown
  startedAtMs: unknown
  startedAtLegacy: unknown
}

export function classifySetupPhaseForDrainAudit(
  input: SetupPhaseAuditInput,
  nowMs: number,
  staleMs: number = RECIPIENTS_SETUP_STALE_MS,
): SetupPhaseClassification {
  if (input.recipientsReady === true) return 'not-setup-phase'

  if (input.recipientsReady !== false) {
    // round 16 修正（Finding 1 項目 2）：recipientsReady 缺失或型別錯誤時
    // 一律 fail closed，即使 activeAttemptId 存在也一樣——不能讓
    // activeAttemptId 的存在意外「赦免」一個本身就無法驗證的欄位。
    return 'indeterminate'
  }

  // 到這裡 recipientsReady 確定是明確的 false。
  if (isNonEmptyString(input.activeAttemptId)) {
    // round 16 修正（Finding 1 項目 1）：recipientsReady:false 加上一個
    // 合法的 activeAttemptId 同時存在——這是不可能的組合，不能假設一定會
    // 被 processing lease 分類擋住（lease 可能已過期而變成 severity SAFE
    // 的 stale），必須在這裡直接 fail closed。
    return 'indeterminate'
  }

  if (input.status !== 'sending') return 'indeterminate'

  if (!isNonEmptyString(input.createdByAttemptId)) return 'indeterminate'

  const startedAtMs = readFirstValidMs(input.startedAtMs, input.startedAtLegacy)
  if (startedAtMs === null) return 'indeterminate'

  if (nowMs - startedAtMs <= staleMs) return 'active'
  return 'unknown'
}

/** 整份 campaign 文件的最終分類——跟 runbook【淨空判斷標準】的優先順序
 *  完全對應：INDETERMINATE 最嚴重（無法驗證，一律 fail closed）> ACTIVE
 *（確定還在使用中，等待）> UNKNOWN（delivery 狀態不明，需要
 *  reconciliation）> SAFE（可以安全部署）。 */
/** round 16 修正（Finding 2）：新增 'EXHAUSTED'——`leaseGeneration` 已經
 *  到達 `Number.MAX_SAFE_INTEGER` 時，不能被 fold 進普通的 'INDETERMINATE'
 *  裡：INDETERMINATE 代表「資料看起來有問題，需要人工檢查釐清實際狀態」，
 *  但 EXHAUSTED 是已經確定、無法用等待或 reconciliation 解決的狀態
 *（reconciliation 自己的 acquireLease 也會被同一個 generation-exhausted
 *  擋下），需要獨立的分類讓 runbook 能給出正確（也是唯一可行）的修復
 *  指引：直接人工重設 `leaseGeneration`，不是「檢查資料是不是壞的」。 */
/** round 27 新增（Finding 1）：新增 'SAFE_WITH_WARNING'——語意上「不阻擋
 *  部署」（跟 SAFE 一樣，`isDrainAuditBlocking()` 不會把它算進阻擋清單），
 *  但**不能**被沒收進 SAFE 的計數或輸出裡：它代表「已知、範圍極窄、經過
 *  逐項驗證的歷史資料落差」，不是「完全乾淨」。唯一目前會產生這個分類的
 *  情境見 isLegacyCompletedPartialMismatchSafe() 的完整說明：這套 lease
 *  機制部署之前建立的歷史 completed campaign，`recipientsReady`／
 *  `createdAt`／`updatedAt`／`completedAt` 四個欄位全部完全缺失，沒有任何
 *  owner／lease，收件人真實分佈也完全乾淨，唯一的異常訊號是宣稱的
 *  completed 跟真實分佈重新算出來的 partial 不一致——round 26 已經確認
 * 「把 status 改成 partial」本身不安全（會重新開放 retryCampaign 認領那些
 *  failed 收件人），所以這裡改成讓稽核工具自己認得出這個已知形狀，不去動
 *  任何資料。CLI 必須把它跟 SAFE 分開列出計數與明確的原因說明——見
 *  functions/scripts/audit-campaign-drain.mjs 的 summarizeDrainAuditResults()。 */
export type CampaignDrainClassification =
  | 'SAFE'
  | 'SAFE_WITH_WARNING'
  | 'ACTIVE'
  | 'INDETERMINATE'
  | 'UNKNOWN'
  | 'EXHAUSTED'

/** round 27 新增（Finding 1）：判斷一個 `CampaignDrainClassification` 是否
 *  阻擋部署——SAFE／SAFE_WITH_WARNING 都不阻擋，其餘三種都阻擋。所有需要
 *  判斷「能不能部署」的呼叫端（CLI 彙總、未來任何自動化 gate）都應該呼叫
 *  這裡，不要各自寫一份 `!== 'SAFE'` 的比較——那樣的比較在新增
 *  SAFE_WITH_WARNING 之後就是錯的（會把它也算成阻擋）。 */
export function isDrainAuditBlocking(classification: CampaignDrainClassification): boolean {
  return classification !== 'SAFE' && classification !== 'SAFE_WITH_WARNING'
}

export interface CampaignDrainAuditInput {
  campaignId: string
  status: unknown
  recipientsReady: unknown
  activeAttemptId: unknown
  activeLeaseExpiresAtMs: unknown
  activeLeaseExpiresAtLegacy: unknown
  resolutionLeaseAttemptId: unknown
  resolutionLeaseExpiresAtMs: unknown
  /** round 16 新增（Finding 2）：processing／resolution 租約共用的 fencing
   *  generation——見 classifyLeaseGenerationForDrainAudit 的說明。 */
  leaseGeneration: unknown
  createdByAttemptId: unknown
  startedAtMs: unknown
  startedAtLegacy: unknown
  /** round 27 新增（Finding 1），round 27 提交前審查修正：判斷「legacy
   *  歷史 completed campaign」例外（見 isLegacyCompletedPartialMismatchSafe()
   *  的完整說明）需要用 `isFieldAbsent()`（`hasOwnProperty` 包裝）證明
   *  `recipientsReady`／`createdAt`／`updatedAt`／`completedAt` 四個欄位
   *  「完全不存在」——這無法只從個別欄位的 `unknown` 值判斷（`value ===
   *  undefined` 沒辦法區分「欄位不存在」跟「欄位存在、值恰好是
   *  undefined」），必須拿到 field-masked 查詢讀回來的原始物件本身。⚠️
   *  呼叫端必須確保自己的 field mask（例如 audit-campaign-drain.mjs 的
   *  CAMPAIGN_FIELDS、ops-campaign-repair.mjs 的
   *  CAMPAIGN_REPAIR_CLASSIFICATION_FIELDS）有包含這四個欄位——field mask
   *  沒有請求的欄位，讀回來的物件上根本不會有這個 key，會被誤判成「文件裡
   *  真的不存在這個欄位」，讓這裡的絕對缺席判斷失去意義。不提供這個欄位
   *  （`undefined`）時，legacy 例外一律 fail closed，不嘗試用其他方式猜測。 */
  campaignRawData?: Record<string, unknown>
  /** round 15 修正（Finding 4）：現在應該送入「全部」收件人，不再只是
   *  claimed／sending 的抽樣——見 classifyRecipientForDrainAudit 的說明。 */
  recipients: RecipientDrainSample[]
}

export interface CampaignDrainAuditResult {
  campaignId: string
  status: string
  /** round 20 新增（Finding 1）：`campaign.status` 是不是 `isKnownCampaignStatus()`
   *  認可的五個合法值之一。這個欄位獨立影響整體 severity（見
   *  `classifyCampaignForDrainAudit()` 內的 `statusValiditySeverity`），
   *  不透過 setupPhase 或 recipientDistributionConsistent 間接體現——
   *  false 時，即使其餘欄位看起來都正常，classification 也至少會是
   *  INDETERMINATE。CLI 應該用這個欄位明確印出「campaign.status missing
   *  or invalid」，不能只顯示一般的 INDETERMINATE 訊息。 */
  campaignStatusValid: boolean
  setupPhase: SetupPhaseClassification
  processingLease: LeaseAuditClassification
  resolutionLease: LeaseAuditClassification
  leaseGeneration: LeaseGenerationClassification
  /** round 18 新增（Finding 3）：只有 `leaseGeneration==='exhausted'` 且
   *  這份 campaign 確定不會再需要任何流程 acquire 它時才是 true——見
   *  isGenerationExhaustionHarmless 的說明。`leaseGeneration` 欄位本身
   *  永遠誠實回報實際狀態，這個欄位單純用來說明「這次 exhausted 有沒有
   *  被折算成不阻擋部署」，供 audit 輸出／人工複核使用。`leaseGeneration`
   *  不是 'exhausted' 時這個欄位固定是 false。 */
  leaseGenerationExhaustionHarmless: boolean
  recipientCount: number
  activeRecipientCount: number
  indeterminateRecipientCount: number
  unknownRecipientCount: number
  /** round 19 新增（Finding 1）：terminal campaign（completed／failed／
   *  needs_review）逐一計算 recipients 各個已知 status 的實際筆數，加上
   *  malformed（不是任何已知 RecipientStatus 的筆數）——供 CLI 輸出，讓
   *  操作員能直接看到「campaign 宣稱的狀態」跟「recipient 子集合的真實
   *  分佈」是不是吻合，不必自己另外查 Firestore。非 terminal（sending／
   *  partial）的 campaign 這裡仍然照實際資料算出來，只是不會被拿去跟
   *  decideCampaignStatus() 的結果比較（見 recipientDistributionConsistent
   *  的說明）。 */
  recipientStatusCounts: RecipientStatusCounts
  /** round 19 新增（Finding 1）：terminal campaign 用實際收件人分佈重新
   *  跑一次 decideCampaignStatus()（跟正式收尾用的是同一份公式），是否
   *  跟 campaign.status 本身完全一致——見 auditRecipientDistribution 的
   *  說明。sending／partial（非 terminal）這裡固定是 true：那兩種狀態
   *  本來就預期還有非終止的收件人，不適用這個不變量。 */
  recipientDistributionConsistent: boolean
  /** round 27 新增（Finding 1）：只有這份 campaign 真的符合
   *  isLegacyCompletedPartialMismatchSafe() 逐項驗證過的「歷史 completed
   *  campaign」形狀，且這個落差本身就是唯一異常訊號時才是 true——這種情況
   *  下 `classification` 會是 `'SAFE_WITH_WARNING'`，不是原本的
   *  `'INDETERMINATE'`。這個欄位單純用來說明「這次 completed／partial 落差
   *  有沒有被折算成不阻擋部署」，供 CLI 輸出／人工複核使用，跟
   *  `leaseGenerationExhaustionHarmless` 是同一種設計：分類欄位本身
   *  仍然可以直接看出結果，這裡額外提供「為什麼」的可稽核依據。恆為
   *  false，除非上述條件全部成立。 */
  legacyCompletedPartialMismatchWaived: boolean
  classification: CampaignDrainClassification
}

/** round 27 新增（Finding 1）：`SAFE_WITH_WARNING` 刻意**不**放進這張嚴重度
 *  對照表——它不是由 setupPhase／lease／recipient／distribution 這幾個
 *  子訊號的嚴重度直接算出來的，而是在下面 `classifyCampaignForDrainAudit()`
 *  算出 pre-downgrade 的五種分類之一（一定會是 `INDETERMINATE`）之後，另外
 *  用 `isLegacyCompletedPartialMismatchSafe()` 逐項驗證過才會覆寫成
 *  `SAFE_WITH_WARNING`，不透過這張表參與嚴重度排序。 */
type PreDowngradeClassification = Exclude<CampaignDrainClassification, 'SAFE_WITH_WARNING'>

const DRAIN_SEVERITY: Record<PreDowngradeClassification, number> = {
  SAFE: 0,
  UNKNOWN: 1,
  ACTIVE: 2,
  INDETERMINATE: 3,
  EXHAUSTED: 4,
}

/** 把 recipient／lease／setup phase／lease generation 分類結果映射到跟
 *  campaign 層級同一個嚴重度尺度上，用來取「目前觀察到的所有東西裡最
 *  嚴重的那一個」。 */
function severityOf(
  classification:
    | LeaseAuditClassification
    | RecipientDrainClassification
    | SetupPhaseClassification
    | LeaseGenerationClassification,
): number {
  if (classification === 'exhausted') return DRAIN_SEVERITY.EXHAUSTED
  if (classification === 'indeterminate') return DRAIN_SEVERITY.INDETERMINATE
  if (classification === 'active') return DRAIN_SEVERITY.ACTIVE
  if (classification === 'unknown') return DRAIN_SEVERITY.UNKNOWN
  // 'absent'／'stale'／'safe'／'not-setup-phase'／'ok' 都不會單獨造成阻擋。
  return DRAIN_SEVERITY.SAFE
}

/** round 19 新增（Finding 1）：逐一統計 recipients 裡每一種已知 status
 *  的筆數，加上 malformed（不是任何已知 RecipientStatus 字串的筆數）——
 *  純粹的計數，不做任何分類判斷，供 auditRecipientDistribution() 與 CLI
 *  輸出共用。 */
export interface RecipientStatusCounts {
  queued: number
  claimed: number
  sending: number
  sent: number
  failed: number
  exhausted: number
  delivery_unknown: number
  malformed: number
}

function countRecipientStatusesForAudit(recipients: RecipientDrainSample[]): RecipientStatusCounts {
  const counts: RecipientStatusCounts = {
    queued: 0,
    claimed: 0,
    sending: 0,
    sent: 0,
    failed: 0,
    exhausted: 0,
    delivery_unknown: 0,
    malformed: 0,
  }
  for (const r of recipients) {
    if (isKnownRecipientStatus(r.status)) counts[r.status] += 1
    else counts.malformed += 1
  }
  return counts
}

/**
 * round 19 新增（Finding 1）：terminal campaign 的「宣稱狀態」跟「recipient
 * 子集合的真實分佈」是否吻合——這是 P1 修正的核心。
 *
 * ⚠️ 背景（round 19 Finding 1 的原始問題）：`classifyRecipientForDrainAudit()`
 * 把 `queued`／`failed` 都歸類成 `'safe'`（它們本身不是需要人工關注的
 * lease 訊號），這對「這個 recipient 本身有沒有卡住的 lease」這個問題是
 * 正確答案，但 `countNonTerminalRecipients()`（decideCampaignStatus() 唯一
 * 權威的「還有沒有人沒完成」依據）明確把 `queued`／`claimed`／`sending`／
 * `failed` 都算成非終止——兩者標準不同、用途也不同，過去
 * `classifyCampaignForDrainAudit()`／`isGenerationExhaustionHarmless()`
 * 只用前者判斷，導致一份 `status:'completed'` 但 recipients 子集合其實還
 * 有 `queued`／`failed`（不變量早已被打破：completed 只有在
 * `nonTerminalCount===0` 時才可能被正常公式算出來）的 campaign，仍然可能
 * 被判成 SAFE，甚至讓 leaseGenerationExhaustionHarmless 誤判成 true。
 *
 * 修正方式：terminal campaign（completed／failed／needs_review）用「真實
 * 收件人分佈」重新跑一次跟正式收尾完全相同的公式
 *（`computeAuthoritativeRecipientTotals` + `decideCampaignStatus`），比對
 * 結果是否跟 `campaign.status` 完全一致：
 * - 任何一位 recipient 的 status 不是已知合法值（malformed）→ 直接視為
 *   不一致（資料本身已經不可信，不能假設「反正跟終止狀態無關」而略過）。
 * - 全部合法時，`decideCampaignStatus(authoritativeTotals, nonTerminalCount)`
 *   必須等於 `campaign.status`——這一個等式天然涵蓋所有 Finding 1 列出的
 *   矩陣情境：
 *   - completed／failed 裡出現 queued／claimed／sending／failed（多餘的）
 *     → 真實算出來的 nonTerminalCount>0 → 公式回傳 'partial'，跟宣稱的
 *     'completed'／'failed' 不符 → 不一致。
 *   - completed／failed 裡出現 delivery_unknown → 公式回傳
 *     'needs_review'，同樣不符 → 不一致。
 *   - failed 但零收件人（`totals.recipients===0`）→ 公式定義
 *    `recipients>0 && sent===0` 才會是 'failed'；零收件人時公式回傳
 *    'completed' → 不一致，failed 本身就不該在零收件人時出現。
 *   - completed／failed 只有 sent／exhausted 的合法組合、或 needs_review
 *     搭配 nonTerminalCount===0 且 deliveryUnknown>0 → 公式算出來的結果
 *     剛好等於宣稱的狀態 → 一致，這是唯一合法的情境。
 * - `sending`／`partial`（非 terminal）：不受這個不變量約束（它們本來就
 *   預期還有非終止的收件人），固定回傳一致，交給既有的其他分類規則
 *  （setup phase／lease／recipient-level）判斷。
 *
 * 這個檢查刻意跟現有的 `classifyRecipientForDrainAudit()` 逐位分類完全
 * 獨立、互不取代——後者仍然負責偵測「單一 recipient 本身有沒有卡住的
 * lease」，這裡負責偵測「整體分佈有沒有跟宣稱的狀態互相矛盾」，兩種問題
 * 過去被誤以為是同一件事，這正是 Finding 1 的根因。
 */
export interface RecipientDistributionAudit {
  consistent: boolean
  statusCounts: RecipientStatusCounts
  /** round 27 新增（Finding 1）：terminal campaign 用真實收件人分佈重新算
   *  出來的權威狀態——`isLegacyCompletedPartialMismatchSafe()` 需要確認這個
   *  值「剛好」是 `'partial'`（不只是「跟 campaign.status 不一致」，兩者
   *  在一般情況下等價，但明確存這個值可以避免呼叫端重新呼叫一次
   *  `decideCampaignStatus()`，維持「同一個計算只做一次」的慣例）。非
   *  terminal（sending／partial）或收件人本身有 malformed 值時固定是
   *  `undefined`——這兩種情況本來就不受這個不變量約束／無法信任算出來的
   *  結果，見上方對應分支的說明。 */
  expectedStatus: CampaignStatus | undefined
}

function auditRecipientDistribution(
  status: string | undefined,
  terminal: boolean,
  recipients: RecipientDrainSample[],
): RecipientDistributionAudit {
  const statusCounts = countRecipientStatusesForAudit(recipients)
  if (!terminal) {
    return { consistent: true, statusCounts, expectedStatus: undefined }
  }
  if (statusCounts.malformed > 0) {
    return { consistent: false, statusCounts, expectedStatus: undefined }
  }
  const known: RecipientStatusForTotals[] = recipients.map((r) => ({
    status: r.status as RecipientStatus,
  }))
  const { totals, nonTerminalCount } = computeAuthoritativeRecipientTotals(known)
  const expectedStatus = decideCampaignStatus(totals, nonTerminalCount)
  return { consistent: expectedStatus === status, statusCounts, expectedStatus }
}

/**
 * round 18 新增（Finding 3）：判斷「即使 leaseGeneration 已經耗盡，這份
 * campaign 是否確定不會再需要任何流程去 acquire 它」——只有同時符合以下
 * 全部條件才是 true：
 * - status 是 'completed' 或 'failed'（**不含** 'needs_review'——後者
 *   可能還有 delivery_unknown 收件人需要 resolveDeliveryUnknown 處理，
 *   那需要先 acquireResolutionLeaseTx 核發 resolution 租約，耗盡的
 *   generation 會讓這個流程永遠無法進行，必須繼續阻擋）。
 * - processing 租約與 resolution 租約都是 'absent'（完全沒有 owner——
 *   若 owner 欄位存在但格式錯誤，classifyLeaseForAudit 會回傳
 *  'indeterminate' 而不是 'absent'，這裡的檢查會自動連帶擋下）。
 * - 沒有任何 active／unknown／indeterminate 的收件人。
 *
 * 只有上述條件全部成立時，才能確定「這個 campaign 事實上已經完全結束，
 * 未來不會再有任何合法流程需要對它 acquire 租約」——這種情況下，
 * leaseGeneration 耗盡本身雖然仍然是異常的資料（不可能透過正常使用自然
 * 發生），但它不會再造成任何實際影響，不需要繼續阻擋部署。反之，只要
 * 有任何一項不成立，就代表這份 campaign 可能還需要被合法流程處理，
 * 耗盡的 generation 會讓那個流程永遠失敗，必須繼續阻擋。
 *
 * 這是一條可稽核、以現有欄位計算出來的規則，不是操作員手動維護的
 * allowlist——同一份規則同時套用在 audit 腳本與（如果 production 端未來
 * 需要用到）任何其他呼叫端，不會因為誰在跑而有不同標準。
 *
 * ⚠️ round 19 修正（Finding 1）：round 18 版本只檢查
 * active／unknown／indeterminate 這三種**逐位 recipient 的 lease 訊號**，
 * 完全沒有檢查「recipient 子集合的真實分佈，是不是真的能用
 * decideCampaignStatus() 的正式公式自然算出目前這個 status」——`queued`／
 * `failed` 被 `classifyRecipientForDrainAudit()` 歸類成 `'safe'`（對「這位
 * 收件人本身有沒有卡住的 lease」這個問題確實是安全的），但 `failed` 仍然
 * 可以被一般 retry 重新認領、`queued` 從未真正處理過，兩者都不是「這個
 * recipient 已經沒有任何後續」的終止結果，繼續把它們留在一份宣稱
 * completed／failed 的 campaign 裡，本身就是「campaign 狀態機不一致」——
 * 過去的測試甚至明確期待 `completed + [sent, failed, exhausted]` 搭配
 * generation exhausted 會被判成 harmless／SAFE，這正是這個缺口的具體案例
 *（`failed` recipient 不該被忽略）。新增 `distributionConsistent` 參數
 *（來自 `auditRecipientDistribution()`）補上這一塊：只有「真實分佈能自然
 * 推出目前的 status」時，才能確定這份 campaign 真的已經完全結束——這一個
 * 條件本身就完整涵蓋「nonTerminalCount===0」「deliveryUnknown===0」
 *（needs_review 本來就被本函式排除在 harmless 之外）「所有 recipient
 * status 合法」「decideCampaignStatus(...) === campaign.status」全部四項
 * 子條件，不需要在這裡重複逐一檢查。
 */
function isGenerationExhaustionHarmless(params: {
  status: string | undefined
  processingLease: LeaseAuditClassification
  resolutionLease: LeaseAuditClassification
  activeRecipientCount: number
  unknownRecipientCount: number
  indeterminateRecipientCount: number
  distributionConsistent: boolean
}): boolean {
  if (params.status !== 'completed' && params.status !== 'failed') return false
  if (params.processingLease !== 'absent') return false
  if (params.resolutionLease !== 'absent') return false
  if (params.activeRecipientCount > 0) return false
  if (params.unknownRecipientCount > 0) return false
  if (params.indeterminateRecipientCount > 0) return false
  if (!params.distributionConsistent) return false
  return true
}

/**
 * round 27 修正（提交前審查 Finding 1）：唯一權威的「這個欄位在原始物件上
 * 完全不存在」判斷——用 `Object.prototype.hasOwnProperty.call()`，不是
 * `value === undefined`。這兩者不一樣：一個物件可以「擁有」一個值剛好是
 * `undefined` 的自有屬性（例如 `{ recipientsReady: undefined }`，這在物件
 * 實字語法下會建立自有屬性，只是值是 undefined），這種情況下欄位其實
 * 「存在」（曾經被明確寫入或設定過），不能算「完全缺席」——只有
 * `hasOwnProperty` 回傳 false，才是真正的「這個 key 從來沒被寫進這個物件」。
 * Firestore 文件透過 `.select(...)` 欄位遮罩讀回來的物件正好符合這個語意：
 * 沒被遮罩選到、或文件本身真的沒有這個欄位，回傳物件上都不會有對應的 key。
 */
export function isFieldAbsent(data: Record<string, unknown>, field: string): boolean {
  return !Object.prototype.hasOwnProperty.call(data, field)
}

/**
 * round 27 新增（Finding 1）：判斷一份 campaign 是否符合這套 lease／
 * reconciliation 機制部署之前建立的「歷史 completed campaign」形狀——這種
 * 文件完全沒有 `recipientsReady`／`createdAt`／`updatedAt`／`completedAt`
 * 四個欄位（不是 `false`／`null`，是欄位本身完全不存在），也從未被任何
 * processing／resolution／setup 租約持有過，收件人真實分佈本身完全乾淨
 *（只有 `sent`／`failed`），唯一的異常訊號是宣稱的 `completed` 跟真實分佈
 * 重新算出來的 `partial` 不一致——這正是既有 `auditRecipientDistribution()`
 * 會標成 INDETERMINATE 的情境（見該函式的說明）。
 *
 * ⚠️ 背景（round 27，真實情境）：一次唯讀 drain audit 發現一份 production
 * campaign 正是這個形狀。round 26 新增的 `decideCampaignStatusRepair()`
 * 明確拒絕修改這份文件的 `status`（見該函式與本輪報告的完整說明）：雖然
 * 目前缺失的 `recipientsReady` 會讓 `decideAcquireCampaignLease()`（見
 * `shared/campaignSend.ts` 開頭的說明）擋下 `retryCampaign`、無法真的重寄
 * 任何東西，但如果未來有人把 `recipientsReady` 補回 `true`，
 * `status:'partial'` 會重新開放 `retryCampaign` 認領那幾筆 `failed`
 * 收件人，造成真正的重複寄送風險——這裡新增的是讓稽核工具「認得出」這個
 * 已知、範圍極窄的歷史形狀，不阻擋部署，但也不去修改任何資料，跟
 * repair-status 是兩件完全獨立的事。
 *
 * ⚠️ 這個降級刻意極度狹窄：以下每一項都是硬性條件，只要有一項不成立，就
 * 整個 fail closed，維持原本（呼叫端傳入的 pre-downgrade）的分類，不做任何
 * 「大致符合就放行」的寬鬆版本。逐項條件（跟本輪需求文件逐條對應）：
 * 1. `campaignStatusValid` 為 true。
 * 2. `status` 剛好是 `'completed'`。
 * 3／4. `recipientsReady`／`createdAt`／`updatedAt`／`completedAt` 這四個
 *    欄位在原始 Firestore 文件裡「完全不存在」——round 27 修正：不能只檢查
 *    `value === undefined`，那沒辦法區分「欄位真的不存在」跟「欄位存在、
 *    值剛好是 `false`／`null`／其他非 truthy 值」（在 JS 物件屬性存取的
 *    語意下兩者讀出來都可能造成混淆；更嚴重的是不能只看 `unknown` 值本身）
 *    ——一律改用 `isFieldAbsent()`（`Object.prototype.hasOwnProperty.call()`
 *    的包裝）直接對呼叫端傳入的 `campaignRawData`（field-masked 查詢讀回來
 *    的原始物件）判斷，這是唯一能正確區分「欄位不存在」與「欄位存在但值
 *    恰好讀成 undefined」的方式。`campaignRawData` 本身缺席（呼叫端沒有
 *    提供，例如舊測試沒有特地建構這個欄位）一律 fail closed，不嘗試用
 *    `unknown` 值本身去猜。
 * 5／6／8. processing／resolution 租約必須「乾淨地」回報 `'absent'`——不是
 *    `stale`／`active`／`indeterminate`。直接重用呼叫端已經算出來的分類
 *    結果，不是另外重新 parse 一次，維持「同一份判斷只寫一次」的慣例。
 * 7／8. setup owner（`createdByAttemptId`）必須「乾淨地」absent——terminal
 *    campaign 的 setupPhase 短路成 `'not-setup-phase'`，完全不會檢查這個
 *    欄位（見下方 `classifyCampaignForDrainAudit` terminal 分支的說明），
 *    這裡用跟 `decideCampaignStatusRepair()` 相同的 `parseLeaseOwner()`
 *    自己補上。
 * 9. `leaseGeneration` 本身必須是 `'ok'`（不是 `indeterminate`／
 *    `exhausted`），且解析出來的值必須「剛好」是合法的 no-owner baseline
 *   （`0`）——`classifyLeaseGenerationForDrainAudit()` 本身寬鬆許多（沒有
 *    owner 時，即使 `leaseGeneration` 是任意非 baseline 的正整數也會回傳
 *   `'ok'`，見該函式的說明），這裡的例外要求更嚴格：必須是「從未被任何人
 *    acquire 過」的真正起始狀態。
 * 10／11-15. 收件人分佈必須完全乾淨：沒有 `malformed`、沒有
 *    `queued`／`claimed`／`sending`／`delivery_unknown`，`exhausted` 也必須
 *    是 0（只允許 `sent`／`failed` 兩種）。逐項獨立檢查已知的統計數字，不
 *    只依賴下面的 `consistent`／`expectedStatus`，即使那個計算本身有 bug，
 *    這裡也要能各自擋下（跟 round 26 `decideCampaignStatusRepair()` 的
 *    `no-failed-recipients` 是同一種 defense-in-depth 哲學）。
 * 16／17. `failed > 0` 且 `sent > 0`。
 * 18. （由上面 11-15 的 `exhausted===0` 涵蓋，這裡不重複。）
 * 19／20. `auditRecipientDistribution()` 判定 `consistent:false`，且用真實
 *    分佈重新算出來的 `expectedStatus` 剛好是 `'partial'`——兩者一起確認，
 *    確保「不一致」的唯一原因就是 completed／partial 這組落差，不是其他
 *    任何原因（例如 malformed 收件人也會讓 `consistent:false`，但那時
 *    `expectedStatus` 是 `undefined`，不會等於 `'partial'`，一樣會被這裡
 *    擋下）。
 * 21. 呼叫端負責（`runDrainAuditScan()` 的穩定快照協定）——這個函式本身
 *    不需要、也不能參與快照穩定性的判斷，只在快照已經確認穩定之後才會被
 *    呼叫，見 `classifyCampaignForDrainAudit()` 與 `audit-scan.mjs` 的說明。
 * 22. 上面 1-20 逐項獨立檢查，加上呼叫端額外傳入的
 *    `activeRecipientCount`／`indeterminateRecipientCount`／
 *    `unknownRecipientCount` 全部為 0（跟 `isGenerationExhaustionHarmless()`
 *    用同一種 belt-and-suspenders 檢查）——任何一項不是 0，就代表還有其他
 *    異常訊號存在，必須維持原本更嚴重的分類，不能被這裡覆蓋。
 */
function isLegacyCompletedPartialMismatchSafe(params: {
  campaignStatusValid: boolean
  status: string | undefined
  /** round 27 修正：field-masked 查詢讀回來的原始 campaign 物件本身（不是
   *  個別欄位的 `unknown` 值）——只有這樣才能用 `isFieldAbsent()` 正確判斷
   *  「欄位完全不存在」，見上方函式說明條件 3／4。呼叫端沒有提供（例如
   *  舊測試沒有特地建構這個欄位）一律視為無法證明缺席，fail closed。 */
  campaignRawData: Record<string, unknown> | undefined
  processingLease: LeaseAuditClassification
  resolutionLease: LeaseAuditClassification
  createdByAttemptId: unknown
  leaseGenerationRaw: unknown
  leaseGeneration: LeaseGenerationClassification
  statusCounts: RecipientStatusCounts
  distributionConsistent: boolean
  expectedStatus: CampaignStatus | undefined
  activeRecipientCount: number
  indeterminateRecipientCount: number
  unknownRecipientCount: number
}): boolean {
  if (!params.campaignStatusValid) return false
  if (params.status !== 'completed') return false

  // 條件 3／4：沒有原始物件可查就無法證明「完全缺席」，fail closed。
  if (!params.campaignRawData) return false
  const raw = params.campaignRawData
  if (!isFieldAbsent(raw, 'recipientsReady')) return false
  if (!isFieldAbsent(raw, 'createdAt')) return false
  if (!isFieldAbsent(raw, 'updatedAt')) return false
  if (!isFieldAbsent(raw, 'completedAt')) return false

  // 條件 5／6／8：重用呼叫端已經算出來的 processing／resolution 租約分類。
  if (params.processingLease !== 'absent') return false
  if (params.resolutionLease !== 'absent') return false

  // 條件 7／8：setup owner 用跟 decideCampaignStatusRepair() 相同的 parser。
  if (parseLeaseOwner(params.createdByAttemptId) !== 'absent') return false

  // 條件 9：leaseGeneration 必須乾淨，且剛好是合法的 no-owner baseline。
  if (params.leaseGeneration !== 'ok') return false
  if (readLeaseGeneration(params.leaseGenerationRaw) !== 0) return false

  // 條件 10／11-18：收件人分佈逐項獨立檢查。
  const c = params.statusCounts
  if (c.malformed !== 0) return false
  if (c.queued !== 0) return false
  if (c.claimed !== 0) return false
  if (c.sending !== 0) return false
  if (c.delivery_unknown !== 0) return false
  if (c.exhausted !== 0) return false
  if (!(c.failed > 0)) return false
  if (!(c.sent > 0)) return false

  // 條件 19／20：不一致的唯一原因必須是 completed／partial 這組落差。
  if (params.distributionConsistent) return false
  if (params.expectedStatus !== 'partial') return false

  // 條件 22：沒有其他任何 recipient 層級的異常訊號殘留。
  if (params.activeRecipientCount !== 0) return false
  if (params.indeterminateRecipientCount !== 0) return false
  if (params.unknownRecipientCount !== 0) return false

  return true
}

/**
 * 對一份 campaign 文件（連同它全部收件人的分類用欄位抽樣）套用完整的
 * 淨空判斷標準，回傳單一分類——這是 functions/scripts/audit-campaign-drain.mjs
 * 與部署 runbook 判斷「能不能部署」的唯一權威來源。round 15 起也涵蓋
 * setup phase（Finding 3），round 16 起也涵蓋 lease generation（Finding 2）。
 *
 * round 17 修正（Finding 1）：round 16 版本在 status 是終止狀態時會整個
 * 短路直接回傳 SAFE，完全不檢查 lease／generation／recipient——這個假設
 * 是錯的：needs_review 仍然可以被 resolveDeliveryUnknown 操作
 *（acquireResolutionLeaseTx 明確允許對 needs_review 核發 resolution
 * 租約），一個正在進行人工 resolution 的 needs_review campaign 會被舊版
 * 誤判成 SAFE；completed／failed 理論上不該再有任何 active lease／
 * recipient，但不能假設一定不會，必須實際檢查。現在只保留「terminal 時
 * 跳過 setup-phase 的 schema 驗證」這一項（見下方 setupPhase 的計算），
 * 其餘 lease／generation／recipient 一律照實際資料判斷。
 *
 * round 18 修正（Finding 3）：leaseGeneration 是 'exhausted' 時，不再
 * 無條件把整份 campaign 判成 EXHAUSTED——見上方 isGenerationExhaustionHarmless
 * 的說明，completed／failed 且確定沒有任何 owner／active／unknown／
 * indeterminate 收件人時，這個 exhausted 訊號不會再造成任何實際影響，
 * 折算 severity 時視為 SAFE（`leaseGeneration` 欄位本身仍然誠實回報
 * 'exhausted'，只是不會讓它把整體 classification 拉到 EXHAUSTED）。
 *
 * round 19 修正（Finding 1）：新增 `auditRecipientDistribution()`——terminal
 * campaign 如果沒辦法用真實收件人分佈自然推出目前的 status（例如
 * completed 卻還有 queued／failed／delivery_unknown、或 failed 卻零收件人），
 * 一律讓整體 classification 至少是 INDETERMINATE，不論 leaseGeneration
 * 是不是耗盡——過去這個不一致只在 leaseGeneration 耗盡時才會被連帶注意到
 *（而且判斷本身也不完整，見 isGenerationExhaustionHarmless 的說明），一般
 * generation 值下完全沒有任何檢查會發現它，可能讓一份實際上還有未完成
 * 工作的 campaign 被判成 SAFE。
 */
export function classifyCampaignForDrainAudit(
  input: CampaignDrainAuditInput,
  nowMs: number,
): CampaignDrainAuditResult {
  // round 20 修正（Finding 1）：只有 isKnownCampaignStatus() 認可的五個
  // 合法值才會被當成 status 使用；其餘一律視為不合法，terminal 固定為
  // false（不影響正確性——status 不合法時整體 severity 已經被
  // statusValiditySeverity 獨立拉到 INDETERMINATE，見下方）。
  const campaignStatusValid = isKnownCampaignStatus(input.status)
  const status = campaignStatusValid ? (input.status as KnownCampaignStatus) : undefined
  const terminal = campaignStatusValid && isTerminalCampaignStatus(status)
  const statusValiditySeverity = campaignStatusValid
    ? DRAIN_SEVERITY.SAFE
    : DRAIN_SEVERITY.INDETERMINATE

  // round 17 修正（Finding 1）：terminal 只影響 setup-phase 的 schema
  // 驗證——這套 lease 機制部署之前建立的歷史 terminal campaign 完全沒有
  // recipientsReady 欄位，如果仍然套用 classifySetupPhaseForDrainAudit()
  // 的完整判斷式會被誤判成 indeterminate（該函式看到 recipientsReady 既
  // 不是 true 也不是 false 就 fail closed）；但 setup phase 這個概念本身
  // 對已經 terminal 的 campaign 沒有意義（不論新舊 schema，terminal 代表
  // 收件人清單建立與寄送流程早已結束）。這是唯一可以安全略過的部分——
  // lease／generation／recipient 完全不受影響，一律照下面的實際資料判斷。
  const setupPhase = terminal
    ? 'not-setup-phase'
    : classifySetupPhaseForDrainAudit(
        {
          status: input.status,
          recipientsReady: input.recipientsReady,
          activeAttemptId: input.activeAttemptId,
          createdByAttemptId: input.createdByAttemptId,
          startedAtMs: input.startedAtMs,
          startedAtLegacy: input.startedAtLegacy,
        },
        nowMs,
      )
  const processingLease = classifyLeaseForAudit(
    input.activeAttemptId,
    input.activeLeaseExpiresAtMs,
    input.activeLeaseExpiresAtLegacy,
    nowMs,
  )
  const resolutionLease = classifyLeaseForAudit(
    input.resolutionLeaseAttemptId,
    input.resolutionLeaseExpiresAtMs,
    undefined,
    nowMs,
  )
  const leaseGeneration = classifyLeaseGenerationForDrainAudit(
    input.activeAttemptId,
    input.resolutionLeaseAttemptId,
    input.leaseGeneration,
  )

  let activeRecipientCount = 0
  let indeterminateRecipientCount = 0
  let unknownRecipientCount = 0
  let worstRecipientSeverity = DRAIN_SEVERITY.SAFE
  for (const recipient of input.recipients) {
    const classification = classifyRecipientForDrainAudit(recipient, nowMs)
    if (classification === 'active') activeRecipientCount += 1
    else if (classification === 'indeterminate') indeterminateRecipientCount += 1
    else if (classification === 'unknown') unknownRecipientCount += 1
    worstRecipientSeverity = Math.max(worstRecipientSeverity, severityOf(classification))
  }

  // round 19 新增（Finding 1）：terminal campaign 的宣稱狀態是否跟真實
  // 收件人分佈吻合——見 auditRecipientDistribution() 的完整說明。
  const distributionAudit = auditRecipientDistribution(status, terminal, input.recipients)
  const distributionSeverity = distributionAudit.consistent
    ? DRAIN_SEVERITY.SAFE
    : DRAIN_SEVERITY.INDETERMINATE

  const leaseGenerationExhaustionHarmless =
    leaseGeneration === 'exhausted' &&
    isGenerationExhaustionHarmless({
      status,
      processingLease,
      resolutionLease,
      activeRecipientCount,
      unknownRecipientCount,
      indeterminateRecipientCount,
      distributionConsistent: distributionAudit.consistent,
    })
  const leaseGenerationSeverity = leaseGenerationExhaustionHarmless
    ? DRAIN_SEVERITY.SAFE
    : severityOf(leaseGeneration)

  const worstSeverity = Math.max(
    statusValiditySeverity,
    severityOf(setupPhase),
    severityOf(processingLease),
    severityOf(resolutionLease),
    leaseGenerationSeverity,
    worstRecipientSeverity,
    distributionSeverity,
  )
  const preDowngradeClassification = (
    Object.keys(DRAIN_SEVERITY) as PreDowngradeClassification[]
  ).find((key) => DRAIN_SEVERITY[key] === worstSeverity) as PreDowngradeClassification

  // round 27 新增（Finding 1）：只有 pre-downgrade 的結果本身就已經是
  // INDETERMINATE（代表沒有任何訊號比它更嚴重，見 isLegacyCompletedPartialMismatchSafe()
  // 文件開頭條件 20／22 的說明——EXHAUSTED 的嚴重度比 INDETERMINATE 高，
  // 一旦存在，pre-downgrade 分類本身就不會是 INDETERMINATE，這裡的檢查會
  // 自動排除它，不需要另外判斷 leaseGeneration！=='exhausted'）才會嘗試套用
  // 這個例外——這是跟既有 leaseGenerationExhaustionHarmless 相同的
  // belt-and-suspenders 寫法：即使 isLegacyCompletedPartialMismatchSafe()
  // 本身的判斷式有 bug，這裡的外層 gate 仍然能擋下「把 ACTIVE／
  // UNKNOWN／EXHAUSTED 誤降級成 SAFE_WITH_WARNING」這種更嚴重的錯誤。
  const legacyCompletedPartialMismatchWaived =
    preDowngradeClassification === 'INDETERMINATE' &&
    isLegacyCompletedPartialMismatchSafe({
      campaignStatusValid,
      status,
      campaignRawData: input.campaignRawData,
      processingLease,
      resolutionLease,
      createdByAttemptId: input.createdByAttemptId,
      leaseGenerationRaw: input.leaseGeneration,
      leaseGeneration,
      statusCounts: distributionAudit.statusCounts,
      distributionConsistent: distributionAudit.consistent,
      expectedStatus: distributionAudit.expectedStatus,
      activeRecipientCount,
      indeterminateRecipientCount,
      unknownRecipientCount,
    })

  const classification: CampaignDrainClassification = legacyCompletedPartialMismatchWaived
    ? 'SAFE_WITH_WARNING'
    : preDowngradeClassification

  return {
    campaignId: input.campaignId,
    status: status ?? String(input.status ?? '(missing)'),
    campaignStatusValid,
    setupPhase,
    processingLease,
    resolutionLease,
    leaseGeneration,
    leaseGenerationExhaustionHarmless,
    recipientCount: input.recipients.length,
    activeRecipientCount,
    indeterminateRecipientCount,
    unknownRecipientCount,
    recipientStatusCounts: distributionAudit.statusCounts,
    recipientDistributionConsistent: distributionAudit.consistent,
    legacyCompletedPartialMismatchWaived,
    classification,
  }
}

// ---------------------------------------------------------------------------
// campaign 頂層 status／totals 校正（round 26 新增）
// ---------------------------------------------------------------------------
//
// 背景：一次真實的（唯讀）drain audit 發現一份 production campaign 的
// `status:'completed'`，但它的 recipients 子集合真實分佈是
// `sent:113, failed:3`（116 筆）——`failed` 不是終止狀態
//（countNonTerminalRecipients 不排除它，retryCampaign 理論上還能認領它），
// 依 decideCampaignStatus() 的正常公式，這份 campaign 權威狀態應該是
// 'partial'，不是 'completed'。這正是 classifyCampaignForDrainAudit() 會
// 標成 INDETERMINATE 的「campaignStatus／recipientDistribution 不一致」。
//
// ⚠️ 既有的 reconcileCampaignDelivery（`--action reconcile`）無法修這筆資料，
// 有兩個各自獨立的原因：
// 1. ops-campaign-repair.mjs 的 runReconcile() 明確拒絕
//   `classification !== 'UNKNOWN'` 的 --confirm——這份 campaign 是
//    INDETERMINATE，不是 UNKNOWN，在嘗試取得任何租約之前就會被擋下。
// 2. 就算沒有這道前置檢查，decideAcquireCampaignLease() 本身也會對
//   `isTerminalCampaignStatus(status)` 為 true 的 campaign 直接回傳
//   `{outcome:'terminal'}`——'completed' 是 terminal 狀態，取得處理租約
//    這一步本身就會被拒絕。
//
// 這裡新增的 decideCampaignStatusRepair() 是一個完全獨立、範圍刻意縮得很窄
// 的修復動作：只校正 campaign 頂層的 status／totals，讓它們跟真實的
// recipient 分佈一致——不取得任何處理／resolution 租約、不改動任何
// recipient 文件、不重試、不寄信。這一輪只支援唯一一種 transition：
// `completed → partial`（目前唯一觀察到的真實落差形狀），刻意不做成
// 「任何 status 都能修」的通用工具——多做的每一種情境都是還沒被真實資料
// 驗證過、也還沒被明確要求的假設。
//
// 跟 decidePressReleaseSyncRepair／repairCampaignPressReleaseSyncTx 是同一種
// 分層：decideCampaignStatusRepair() 是純函式（給定 campaign 快照與收件人
// 分佈，回傳「能不能修、要修成什麼」），repairCampaignStatusTx() 是薄的
// Firestore transaction 協調層，只負責「讀新鮮資料 → 呼又純函式 → 合格才
// 寫入」，呼叫端（ops-campaign-repair.mjs／未來的測試）提供跟其他 *Tx
// 函式一致的 DocTx／callback 介面，不直接依賴任何具體 SDK。

/** 這個修復動作只讀取收件人的 status（不含 email／姓名等 PII），跟
 *  reconcile／drain audit 讀取收件人分佈時用的欄位遮罩是同一種精神。 */
export interface CampaignStatusRepairRecipientSample {
  status: unknown
}

/**
 * 每一種結果都對應到 eligibility 清單裡明確的一項，呼叫端可以直接依
 * `outcome` 判斷該印出哪一種訊息，不需要另外解析 `reason` 字串。
 *
 * - 'already-consistent'：status 已經跟真實分佈算出來的權威狀態相同——
 *   冪等的核心：重複執行 dry-run／confirm 都必須落在這裡，不能被誤判成
 *   還有東西可以修。
 * - 'eligible'：全部檢查通過，`patch` 帶著實際要寫入的欄位。
 * - 其餘每一種都是明確、各自獨立的擋下原因（fail closed），不是單一個
 *   籠統的「不合格」。
 */
export type CampaignStatusRepairOutcome =
  | 'campaign-not-found'
  | 'not-ready'
  | 'invalid-status'
  | 'active-processing-lease'
  | 'active-resolution-lease'
  | 'has-setup-owner'
  | 'invalid-lease-generation'
  | 'invalid-recipient-status'
  | 'non-terminal-recipient-present'
  | 'not-terminal-status'
  | 'unsupported-current-status'
  | 'unsupported-target-status'
  | 'no-failed-recipients'
  | 'already-consistent'
  | 'eligible'

export interface CampaignStatusRepairDecision {
  outcome: CampaignStatusRepairOutcome
  /** 人類可讀、可以直接印給維運人員看的具體原因——即使是 dry-run，也絕不
   *  印出「加 --confirm 就會執行」這種暗示會成功的籠統訊息（見本輪報告
   *  Part 1 的說明：那正是 reconcile 過去的問題）。 */
  reason: string
  currentStatus?: string
  /** campaign 文件裡目前的 totals 欄位（未經驗證，只是原樣回顯，方便
   *  dry-run 輸出跟 authoritativeTotals 並排比較）。 */
  currentTotals?: Record<string, unknown>
  authoritativeStatus?: CampaignStatus
  authoritativeTotals?: CampaignTotalsForFinalize
  nonTerminalCount?: number
  /** 只有 `outcome==='eligible'` 才會有值——`--confirm` 實際上會寫入的
   *  欄位，用跟 decideFinalizeCampaign() 一致的 dot-path 寫法
   *  （'totals.sent' 等），呼叫端合併自己 SDK 的 updatedAt／completedAt
   *  刪除欄位後直接 update()。 */
  patch?: Record<string, unknown>
}

/** 這個修復動作只允許存在 sent／failed／exhausted 這三種完全終止的收件人
 *  狀態——queued／claimed／sending 代表還在處理中，delivery_unknown 需要
 *  獨立的人工 resolution 流程，任何一種出現都代表這不是「單純的 status／
 *  totals 跟真實分佈脫鉤」，而是還有事情正在發生，必須 fail closed。 */
const STATUS_REPAIR_FORBIDDEN_RECIPIENT_STATUSES: ReadonlySet<string> = new Set([
  'queued',
  'claimed',
  'sending',
  'delivery_unknown',
])

export function decideCampaignStatusRepair(
  campaignSnap: DocSnapshotLike,
  recipients: CampaignStatusRepairRecipientSample[],
): CampaignStatusRepairDecision {
  if (!campaignSnap.exists || !campaignSnap.data) {
    return { outcome: 'campaign-not-found', reason: 'campaign 文件不存在，沒有東西可以修復。' }
  }
  const data = campaignSnap.data

  if (data.recipientsReady !== true) {
    return {
      outcome: 'not-ready',
      reason: 'recipientsReady 不是 true——收件人清單可能還在建立階段，不可修復。',
    }
  }

  if (!isKnownCampaignStatus(data.status)) {
    return {
      outcome: 'invalid-status',
      reason: `campaign.status（${JSON.stringify(data.status)}）不是已知合法的狀態值，無法安全判斷該怎麼修復。`,
    }
  }
  const currentStatus: KnownCampaignStatus = data.status

  // round 26：owner／租約欄位的存在性一律透過 parseLeaseOwner() 判斷——
  // 跟 classifyCampaignForDrainAudit() 用同一份 parser，格式錯誤（存在但
  // 不是合法非空字串）一律視為「不能證明是 absent」，fail closed。
  if (parseLeaseOwner(data.activeAttemptId) !== 'absent') {
    return {
      outcome: 'active-processing-lease',
      reason: 'activeAttemptId 存在——可能仍有處理程序持有處理租約，不可修復。',
      currentStatus,
    }
  }
  if (parseLeaseOwner(data.resolutionLeaseAttemptId) !== 'absent') {
    return {
      outcome: 'active-resolution-lease',
      reason: 'resolutionLeaseAttemptId 存在——可能有人工 resolution 正在進行，不可修復。',
      currentStatus,
    }
  }
  if (parseLeaseOwner(data.createdByAttemptId) !== 'absent') {
    return {
      outcome: 'has-setup-owner',
      reason: 'createdByAttemptId 存在——campaign 可能仍處於建立收件人清單階段，不可修復。',
      currentStatus,
    }
  }

  if (readLeaseGeneration(data.leaseGeneration) === null) {
    return {
      outcome: 'invalid-lease-generation',
      reason: 'leaseGeneration 不是合法的非負 safe integer，資料可能已經損毀，不可修復——這個修復動作' +
        '絕不寫入這個欄位，但要求它本身必須是合法值才能確定資料沒有損毀。',
      currentStatus,
    }
  }

  for (const r of recipients) {
    if (!isKnownRecipientStatus(r.status)) {
      return {
        outcome: 'invalid-recipient-status',
        reason: `發現至少一位收件人的狀態（${JSON.stringify(r.status)}）無法辨識——fail closed，不可修復。`,
        currentStatus,
      }
    }
  }
  if (recipients.some((r) => STATUS_REPAIR_FORBIDDEN_RECIPIENT_STATUSES.has(r.status as string))) {
    return {
      outcome: 'non-terminal-recipient-present',
      reason:
        '收件人分佈中存在 queued／claimed／sending／delivery_unknown——這些人可能仍在處理中，或需要獨立的' +
        '人工 resolution 流程，不是這個修復動作能安全處理的情境。',
      currentStatus,
    }
  }

  const known: RecipientStatusForTotals[] = recipients.map((r) => ({ status: r.status as RecipientStatus }))
  const { totals: authoritativeTotals, nonTerminalCount } = computeAuthoritativeRecipientTotals(known)
  const authoritativeStatus = decideCampaignStatus(authoritativeTotals, nonTerminalCount)
  const currentTotals = (data.totals ?? {}) as Record<string, unknown>
  const totalsMatch =
    currentTotals.recipients === authoritativeTotals.recipients &&
    currentTotals.sent === authoritativeTotals.sent &&
    currentTotals.failed === authoritativeTotals.failed &&
    currentTotals.exhausted === authoritativeTotals.exhausted &&
    currentTotals.deliveryUnknown === authoritativeTotals.deliveryUnknown

  // round 26 設計取捨（見本輪報告的說明）：這個「已一致」檢查刻意排在
  // terminal-status 檢查之前——修復成功之後 campaign.status 會變成
  // 'partial'（不是 terminal！），冪等性要求「repair 之後再 dry-run 一次」
  // 必須回報 already-consistent，而不是被 terminal-status 檢查擋下變成
  // 「blocked」。這裡的判斷順序才能讓兩份需求同時成立。
  if (currentStatus === authoritativeStatus) {
    return {
      outcome: 'already-consistent',
      reason: totalsMatch
        ? '目前的 status 與 totals 已經跟真實收件人分佈一致，沒有東西需要修復。'
        : 'status 已經跟真實分佈一致，但 totals 欄位本身跟真實分佈不完全相符——這不是本輪 repair-status ' +
          '支援的修復範圍（只處理 completed→partial 的 status 落差），需要人工檢查。',
      currentStatus,
      currentTotals,
      authoritativeStatus,
      authoritativeTotals,
      nonTerminalCount,
    }
  }

  if (!isTerminalCampaignStatus(currentStatus)) {
    return {
      outcome: 'not-terminal-status',
      reason: `目前的 status（${currentStatus}）不是 terminal 狀態——這個修復動作只處理已經蓋棺論定、卻跟真實分佈不一致的 campaign。`,
      currentStatus,
      currentTotals,
      authoritativeStatus,
      authoritativeTotals,
      nonTerminalCount,
    }
  }
  if (currentStatus !== 'completed') {
    return {
      outcome: 'unsupported-current-status',
      reason: `目前的 status（${currentStatus}）不是 'completed'——這一輪 repair-status 只支援 completed → partial 這一種 transition。`,
      currentStatus,
      currentTotals,
      authoritativeStatus,
      authoritativeTotals,
      nonTerminalCount,
    }
  }
  if (authoritativeStatus !== 'partial') {
    return {
      outcome: 'unsupported-target-status',
      reason: `真實分佈重新計算出的權威狀態是 '${authoritativeStatus}'，不是 'partial'——這一輪 repair-status 只支援 completed → partial 這一種 transition。`,
      currentStatus,
      currentTotals,
      authoritativeStatus,
      authoritativeTotals,
      nonTerminalCount,
    }
  }
  // 跟上面 authoritativeStatus!=='partial' 的檢查角度不同、刻意保留的第二道
  // 防線（見本輪需求說明）：只要 authoritativeStatus 真的是 'partial'，
  // 依 decideCampaignStatus() 的公式，failed>0 在數學上已經是必要條件
  //（禁止 queued／claimed／sending／delivery_unknown 之後，nonTerminalCount
  // 只可能來自 failed），這裡仍然明確檢查一次，避免上面任何一步的邏輯
  // 出錯時被另一步意外遮蓋。
  if (!(authoritativeTotals.failed > 0)) {
    return {
      outcome: 'no-failed-recipients',
      reason: 'authoritative totals 裡 failed 不是正數——這個修復動作只處理「completed 但實際上存在 failed 收件人」這種落差。',
      currentStatus,
      currentTotals,
      authoritativeStatus,
      authoritativeTotals,
      nonTerminalCount,
    }
  }

  return {
    outcome: 'eligible',
    reason: 'campaign.status 與真實收件人分佈不一致（completed → partial 的落差），可以安全修復。',
    currentStatus,
    currentTotals,
    authoritativeStatus,
    authoritativeTotals,
    nonTerminalCount,
    patch: {
      status: authoritativeStatus,
      'totals.recipients': authoritativeTotals.recipients,
      'totals.sent': authoritativeTotals.sent,
      'totals.failed': authoritativeTotals.failed,
      'totals.exhausted': authoritativeTotals.exhausted,
      'totals.deliveryUnknown': authoritativeTotals.deliveryUnknown,
    },
  }
}

/**
 * Firestore transaction 協調層——跟 repairCampaignPressReleaseSyncTx 同一種
 * 分層方式：
 * 1. 在同一個 transaction 內重新讀一次 campaign 文件（不信任 dry-run 當下
 *    的舊快照）。
 * 2. 呼叫 `queryAuthoritativeRecipients()`（呼叫端負責在同一個 transaction
 *    內只查詢 status 欄位，不讀 email／姓名等 PII，見
 *    ops-campaign-repair.mjs 的接線）。
 * 3. 呼叫 decideCampaignStatusRepair() 重新跑一次「全部」eligibility 檢查
 *    ——不重用呼叫端可能持有的任何舊決策，Firestore transaction 因為
 *    optimistic concurrency 重試時，這個函式本身會整個重新呼叫，天生保證
 *    每次重試都是從頭重新驗證。
 * 4. 只有 `outcome==='eligible'` 才會呼叫 `campaignDoc.update()`——`extraFields`
 *    由呼叫端提供，用來合併自己 SDK 的 `updatedAt`／`completedAt` 刪除欄位，
 *    這一層完全不知道底下接的是哪個 SDK。
 */
export async function repairCampaignStatusTx(
  campaignDoc: DocTx,
  queryAuthoritativeRecipients: () => Promise<CampaignStatusRepairRecipientSample[]>,
  extraFields: (decision: CampaignStatusRepairDecision) => Record<string, unknown>,
): Promise<CampaignStatusRepairDecision> {
  const campaignSnap = await campaignDoc.get()
  const recipients = await queryAuthoritativeRecipients()
  const decision = decideCampaignStatusRepair(campaignSnap, recipients)
  if (decision.outcome === 'eligible' && decision.patch) {
    campaignDoc.update({ ...decision.patch, ...extraFields(decision) })
  }
  return decision
}
