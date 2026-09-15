/**
 * 「寄測試信給自己」（sendSelfTestEmail callable）的純判斷邏輯。
 *
 * 背景：`testSmtpConnection`（見 functions/src/index.ts）只有 admin 能呼叫，
 * 目的是驗證「系統本身的 SMTP 設定」是否正確。這支檔案支援的是另一個完全
 * 獨立的需求——任何一個已登入、帳號啟用中的一般團隊成員，想確認「自己這個
 * 信箱能不能收到這套系統寄出的信」，不需要、也不應該要求對方是 admin。
 * 兩者刻意分成兩個 callable、两套判斷邏輯，不共用同一個權限層。
 *
 * 這支檔案不 import firebase-admin，也不知道 Firestore 文件實際長什麼樣、
 * 也不知道 Cloud Functions 的 request 物件長什麼樣——跟 shared/maintenance.ts
 * 同一種設計原則：呼叫端（functions/src/index.ts）負責把 Admin SDK 讀到的
 * 值、request 帶來的資訊轉成這裡定義的形狀，這裡只負責「看到這個形狀之後
 * 該怎麼判斷」，方便單元測試完全不連線 Firestore、不建立任何 SMTP 連線就能
 * 覆蓋每一種情況。
 */

/**
 * 同一位使用者兩次「寄測試信給自己」之間至少要間隔多久（毫秒）。
 *
 * 60 秒——刻意選一個很短、之後隨時可以調整的數字。這不是安全邊界，只是
 * 「不要讓人手指按太快、幾秒內連點好幾次」的防呆節流。真正想濫用寄信
 * 額度的人，等 60 秒再點一次一樣可以繼續寄，這裡完全沒打算阻止那種情境
 * ——見 decideSelfTestEmailCooldown() 的說明。
 */
export const SELF_TEST_EMAIL_COOLDOWN_MS = 60_000

/**
 * 冷卻判斷的結果：
 * - 'claim'：距離上次寄送已經超過（或從未寄送過），這次呼叫可以繼續寄信，
 *   呼叫端應該立刻（在同一個 transaction 裡）把「現在」記成新的上次寄送
 *   時間，佔用這次額度。
 * - 'cooldown'：還在冷卻中，這次呼叫應該被拒絕，`retryAfterMs` 是還要
 *   等多久（毫秒）才能再試一次。
 */
export type SelfTestEmailCooldownDecision =
  | { outcome: 'claim' }
  | { outcome: 'cooldown'; retryAfterMs: number }

/**
 * 判斷這次「寄測試信給自己」是否還在冷卻中。
 *
 * @param rawLastSentAtMs 呼叫端從 Firestore 讀到的「上次寄送時間」原始值
 *   （通常是某個 cooldown 文件的 `lastSentAtMs` 欄位）——刻意收 `unknown`，
 *   不假設呼叫端已經驗證過型別。
 * @param nowMs 目前時間（毫秒），由呼叫端傳入而不是這裡自己呼叫
 *   `Date.now()`，方便測試用固定時間覆蓋每一種邊界情況。這是呼叫端內部
 *   決定的值（`Date.now()` 的結果），不是外部輸入，所以格式錯誤代表呼叫端
 *   本身有 bug——見下方「內部契約」的說明，跟 `rawLastSentAtMs`（外部、可能
 *   已經壞掉的 Firestore 資料）處理方式不同。
 * @param cooldownMs 冷卻視窗長度（毫秒），通常就是 SELF_TEST_EMAIL_COOLDOWN_MS，
 *   獨立成參數方便測試用不同長度覆蓋，同樣是內部契約，不是外部輸入。
 *
 * ⚠️ 內部契約（提交前審查新增）：`nowMs`／`cooldownMs` 是呼叫端自己決定的
 * 值，不是「可能已經壞掉的外部資料」——如果這兩個參數本身不是合法的非負
 * safe integer（`cooldownMs` 還必須 > 0），代表呼叫端程式碼本身有 bug，
 * 這裡直接丟出程式錯誤（`throw new Error`），不是 fail open 也不是 fail
 * closed——那兩種語意都是「資料可能有問題，但程式邏輯本身是對的」的處理
 * 方式，不適用在「呼叫這個函式的程式碼本身就寫錯了」的情況。
 *
 * ⚠️ Fail-OPEN（只適用於 `rawLastSentAtMs` 這個外部輸入），刻意跟
 * shared/maintenance.ts 的 isCampaignOperationsPaused() fail-closed 語意
 * 相反：只要 `rawLastSentAtMs` 不是一個「非負 safe integer」（涵蓋
 * `undefined`、`null`、字串、物件、`NaN`、負數、非整數、超過
 * `Number.MAX_SAFE_INTEGER` 的數字……），一律視為「從未寄送過」而放行
 * （'claim'）。這是刻意的不對稱，不是遺漏：
 *
 * - 維護旗標的「預設」本身就是要能確實擋下六個受管制的 callable，任何
 *   無法確定的情況都不該被解讀成「旗標沒開」，所以那裡選擇 fail closed。
 * - 這裡完全是另一種取捨。這只是一個「不要讓人手指按太快」的低風險防呆
 *   節流，不是安全邊界（見 SELF_TEST_EMAIL_COOLDOWN_MS 的說明）。如果某個
 *   Firestore 文件的 `lastSentAtMs` 欄位不知道為什麼壞掉了（人工改過、
 *   舊版程式寫壞、型別跑掉），fail closed 的後果會是「一個原本合法的使用者
 *   從此永遠按不了『寄測試信給自己』這顆按鈕，除非有人手動修 Firestore」
 *   ——這比「冷卻視窗偶爾提早重置一次，讓人可以早一點再寄一封測試信給
 *   自己」糟糕得多。兩種錶盤壞掉的後果不對等，所以這裡選擇對使用者更寬容
 *   的一邊。
 *
 * ⚠️ 未來時間戳記（提交前審查發現、修正）：`rawLastSentAtMs` 本身是合法的
 * 非負 safe integer，但晚於 `nowMs`（例如 Cloud Functions 多個 instance
 * 之間時鐘輕微飄移，或未來某次重構不小心把時區/單位搞錯）——這種情況
 * **不能**被歸類成「畸形」（因為它本身是一個合法數字，不該套用上面的
 * fail-open），但也**不能**直接拿 `cooldownMs - (nowMs - rawLastSentAtMs)`
 * 這個算式計算，因為 `nowMs - rawLastSentAtMs` 會是負數，算出來的
 * `retryAfterMs` 會隨著「未來」多遠而無上限暴增，實質上等於把使用者鎖住到
 * 那個未來時間點再加一整個冷卻視窗——這正是上面 fail-open 設計拚命要避免
 * 的「永久鎖住合法使用者」的另一種偽裝方式，只是觸發路徑不同。
 * 因此：偵測到 `rawLastSentAtMs > nowMs` 時，一律視為「還在冷卻中」，但
 * `retryAfterMs` 明確 clamp 成 `cooldownMs` 本身（不是任何更大的值）——
 * 效果等同於「當作剛剛才寄過」，使用者最多再等一個完整冷卻視窗就能重試，
 * 不會被離譜地鎖住。
 *
 * `rawLastSentAtMs` 是合法、且不晚於 `nowMs` 的數字時：
 * - `nowMs - rawLastSentAtMs >= cooldownMs` → 'claim'（剛好等於邊界也算
 *   通過，不用「超過」才行）。
 * - 否則 → 'cooldown'，`retryAfterMs` 是 `cooldownMs - (nowMs - rawLastSentAtMs)`
 *   （必然介於 1 與 `cooldownMs` 之間：`elapsedMs` 是 `[0, cooldownMs)`
 *   之間的整數，因為前一個分支已經排除了 `>= cooldownMs` 的情況）。
 */
export function decideSelfTestEmailCooldown(
  rawLastSentAtMs: unknown,
  nowMs: number,
  cooldownMs: number,
): SelfTestEmailCooldownDecision {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new Error('decideSelfTestEmailCooldown: nowMs 必須是非負 safe integer（呼叫端內部契約錯誤）')
  }
  if (!Number.isSafeInteger(cooldownMs) || cooldownMs <= 0) {
    throw new Error('decideSelfTestEmailCooldown: cooldownMs 必須是正的 safe integer（呼叫端內部契約錯誤）')
  }

  const isValidTimestamp =
    typeof rawLastSentAtMs === 'number' &&
    Number.isSafeInteger(rawLastSentAtMs) &&
    rawLastSentAtMs >= 0

  if (!isValidTimestamp) return { outcome: 'claim' }

  if (rawLastSentAtMs > nowMs) {
    return { outcome: 'cooldown', retryAfterMs: cooldownMs }
  }

  const elapsedMs = nowMs - rawLastSentAtMs
  if (elapsedMs >= cooldownMs) return { outcome: 'claim' }
  return { outcome: 'cooldown', retryAfterMs: cooldownMs - elapsedMs }
}

/**
 * 把信箱遮罩成適合顯示在畫面上的形式，避免完整信箱被隨意看到／截圖外流。
 *
 * 規則：以 `@` 切成 local-part 與網域兩段；沒有 `@`、或 local-part 是空字串
 * 時，直接回傳 `'***'`（沒有足夠資訊可以有意義地遮罩）。否則保留 local-part
 * 第一個字元，其餘字元（至少一個）全部換成 `*`，網域維持原樣。
 *
 * 範例：
 * - `'alice@example.com'` → `'a****@example.com'`（local-part 是
 *   `'alice'`，5 個字元，保留 `'a'`，剩下 4 個換成 `'*'`）
 * - `'a@example.com'` → `'a*@example.com'`（local-part 只有 1 個字元，
 *   仍然至少遮罩 1 個 `*`，不會變成 `'a@example.com'` 完全沒遮罩）
 * - `'no-at-sign'` → `'***'`（沒有 `@`）
 */
export function maskEmailForDisplay(email: string): string {
  const atIndex = email.indexOf('@')
  if (atIndex <= 0) return '***'

  const localPart = email.slice(0, atIndex)
  const domain = email.slice(atIndex + 1)
  const masked = localPart[0] + '*'.repeat(Math.max(localPart.length - 1, 1))
  return `${masked}@${domain}`
}

/**
 * 提交前審查新增：寄信前最後一道收件人驗證——刻意獨立於全站共用的
 * authorize()（不修改 authorize() 本身，也不重複它已經做過的
 * active／emailVerified 判斷，那些仍然是 authorize() 的職責）。
 *
 * 這是「已經知道是誰了，寄信前最後再確認一次」的防禦性二次檢查（belt and
 * suspenders，跟這個專案其他地方——例如 shared/campaignSend.ts 的
 * isGenerationExhaustionHarmless()——同一種設計哲學）：即使
 * `candidateEmail`（呼叫端從 `request.auth.token.email` 重新、獨立取出並
 * 轉小寫的值）理論上永遠等於 `canonicalEmail`（authorize() 已經回傳、
 * 經過白名單比對的值），仍然明確驗證兩者一致，而不是假設兩者一定相同——
 * 避免未來任何重構不小心讓這兩個值的來源分岔時，錯誤地把信寄到一個沒有
 * 重新驗證過的地址。
 *
 * 驗證項目（任何一項不成立都回傳 `ok:false`，呼叫端必須 fail closed，
 * 在佔用冷卻額度、讀取 Secret Manager、建立 SMTP 連線之前就拒絕）：
 * - 非空字串
 * - 沒有前後空白（`candidateEmail === candidateEmail.trim()`）——不做
 *   「自動 trim 之後再比對」這種寬容處理，前後空白本身就代表這個值的
 *   來源可疑，直接拒絕比默默修正更安全。
 * - 不含 `\r`／`\n`（防止任何理論上的 SMTP header injection 風險，即使
 *   目前的 sendMail() 呼叫本來就沒有把這個值放進任何自訂 header）。
 * - 符合基本的 email 格式（`local@domain.tld`，沒有空白、沒有連續 `@`）
 *   ——這不是完整的 RFC 5322 驗證，只是排除明顯不是 email 的字串。
 * - 與 `canonicalEmail`（authorize() 回傳的值）完全相同。
 */
export type SelfTestEmailRecipientValidation =
  | { ok: true; email: string }
  | { ok: false; reason: 'empty' | 'whitespace' | 'control-characters' | 'invalid-format' | 'mismatch' }

const SELF_TEST_EMAIL_RECIPIENT_FORMAT = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function validateSelfTestEmailRecipient(
  candidateEmail: string,
  canonicalEmail: string,
): SelfTestEmailRecipientValidation {
  if (!candidateEmail) return { ok: false, reason: 'empty' }
  if (candidateEmail !== candidateEmail.trim()) return { ok: false, reason: 'whitespace' }
  if (/[\r\n]/.test(candidateEmail)) return { ok: false, reason: 'control-characters' }
  if (!SELF_TEST_EMAIL_RECIPIENT_FORMAT.test(candidateEmail)) return { ok: false, reason: 'invalid-format' }
  if (candidateEmail !== canonicalEmail) return { ok: false, reason: 'mismatch' }
  return { ok: true, email: candidateEmail }
}

/**
 * 提交前審查新增：sendSelfTestEmail 專用的 SMTP 錯誤分類——刻意跟
 * functions/src/index.ts 既有的 describeSmtpError() 完全分開、不重用。
 *
 * describeSmtpError() 原本只給 admin-only 的 testSmtpConnection 用，每一
 * 個分支都會把原始 `err.message`（可能含真實 host/IP/port/帳號/SMTP
 * 伺服器回應內容）原封不動嵌進回傳字串——這件事對「只有 admin 看得到」
 * 這個受眾來說是可以接受的取捨，但 sendSelfTestEmail 開放給任何 active
 * 一般成員呼叫，繼續沿用同一套邏輯等於把原本只給 admin 看的基礎設施細節
 * 曝露給更大、更低權限的受眾。
 *
 * 這裡完全不檢查、不比對、不內嵌 `err` 的 `message`／`stack` 文字內容——
 * 只看錯誤物件「結構化」的 `code`（nodemailer 對 SMTP 傳輸錯誤設的分類
 * 代碼，例如 `EAUTH`／`ECONNECTION`／`ETIMEDOUT`／`ESOCKET`／`EENVELOPE`）
 * 與 `responseCode`（SMTP 伺服器回應的數字狀態碼），回傳固定的、完全不含
 * 任何動態內容的中文訊息。即使攻擊者能夠操控 SMTP 伺服器的回應文字內容，
 * 也沒有任何管道能透過這個函式把自訂字串反映回前端。
 */
export type SelfTestEmailSendErrorReason = 'auth' | 'connection' | 'rejected' | 'unknown'

/**
 * 未知錯誤的固定文案——精確等於這個字串，不得附加任何動態內容。
 */
export const SELF_TEST_EMAIL_UNKNOWN_SEND_ERROR_MESSAGE = '測試信寄送失敗，請稍後再試或聯絡管理員'

const SELF_TEST_EMAIL_SEND_ERROR_MESSAGES: Record<SelfTestEmailSendErrorReason, string> = {
  auth: '測試信寄送失敗：寄信伺服器驗證失敗，請聯絡管理員確認寄信設定。',
  connection: '測試信寄送失敗：目前無法連線到寄信伺服器，請稍後再試或聯絡管理員。',
  rejected: '測試信寄送失敗：寄信伺服器拒絕了這封信，請聯絡管理員確認寄信設定。',
  unknown: SELF_TEST_EMAIL_UNKNOWN_SEND_ERROR_MESSAGE,
}

export function classifySelfTestEmailSendError(err: unknown): SelfTestEmailSendErrorReason {
  const code = typeof (err as { code?: unknown })?.code === 'string' ? (err as { code: string }).code : undefined
  const responseCode =
    typeof (err as { responseCode?: unknown })?.responseCode === 'number'
      ? (err as { responseCode: number }).responseCode
      : undefined

  if (code === 'EAUTH') return 'auth'
  if (code === 'ECONNECTION' || code === 'ETIMEDOUT' || code === 'ESOCKET' || code === 'ECONNREFUSED') {
    return 'connection'
  }
  if (code === 'EENVELOPE' || code === 'EMESSAGE' || (typeof responseCode === 'number' && responseCode >= 500)) {
    return 'rejected'
  }
  return 'unknown'
}

/**
 * 回傳給 sendSelfTestEmailHandler 呼叫端使用的固定訊息——只呼叫
 * classifySelfTestEmailSendError() 分類，再從固定表格取值，絕對不會出現
 * `err.message`／`err.stack` 本身。
 */
export function describeSelfTestEmailSendError(err: unknown): string {
  return SELF_TEST_EMAIL_SEND_ERROR_MESSAGES[classifySelfTestEmailSendError(err)]
}
