/**
 * 「活動維運維護模式」的純判斷邏輯（伺服器端強制的維護旗標）。
 *
 * 背景：functions/src/index.ts 頂部的部署 runbook（【正式部署程序】步驟 1）
 * 早就指出——只暫停前端不夠，任何有權限的使用者仍然可以直接呼叫
 * sendCampaign／retryCampaign／resolveDeliveryUnknown 這些 callable（自己
 * 重放舊 request、用 curl/Postman 直接打 callable endpoint），一個在暫停前
 * 就已經送出、仍在飛行中的 request 也可能在稽核跑完「之後」才真正拿到
 * lease。正確做法需要同時具備：(a) 前端暫停（既有機制，避免誤觸）、
 * (b) 伺服器端強制的維護旗標——這些 callable 一開始就先檢查一個獨立的
 * 維護狀態文件，維護模式開啟時直接拒絕請求，不進入任何 acquire lease／
 * SMTP／Storage 的邏輯。這支檔案就是 (b) 的純邏輯部分。
 *
 * 跟 shared/permissions.ts 的 checkPermission() 同一種設計原則：**任何
 * 不確定都不得放行**——讀取失敗、文件不存在、欄位缺漏或型別不對，一律視為
 * 「維護中」（fail closed），不會因為讀不到旗標就預設「正常運作」。這是
 * 刻意的不對稱：權限檢查讀不到時退回預設矩陣（最小權限，不代表放行），
 * 但這裡的「預設」本身就是阻擋——維護旗標存在的唯一目的就是「必要時能夠
 * 確實擋下所有六個 callable」，任何無法確定旗標真正意圖的情況都不該被
 * 解讀成「維護旗標沒開」。
 *
 * 這支檔案不 import firebase-admin，也不知道 Firestore 文件實際長什麼樣
 * ——呼叫端（functions/src/index.ts 的 readMaintenanceFlag()／
 * functions/scripts/ops-maintenance.mjs）負責把 Admin SDK 的讀取結果轉成
 * 這裡定義的形狀，這裡只負責「看到這個形狀之後該怎麼判斷」，方便單元測試
 * 完全不連線 Firestore 就能覆蓋每一種讀取結果。
 */

/** 維護旗標所在的文件路徑——單一旗標控制全部六個受管制的 callable，不是
 *  每個 callable 各自一個旗標，避免維運人員需要分別檢查／切換好幾個開關。 */
export const MAINTENANCE_DOC_PATH = 'system/runtime'

/** 旗標欄位名稱。 */
export const MAINTENANCE_PAUSED_FIELD = 'campaignOperationsPaused'

/**
 * 這份文件裡 `campaignOperationsPaused` 欄位實際觀察到的「形狀」——不是
 * 「目前是否暫停」的最終判斷（那是 isCampaignOperationsPaused() 的職責），
 * 只是先把「讀到的原始值長什麼樣子」分類清楚，讓後續判斷（是否阻擋請求、
 * CLI 要不要允許覆寫）可以各自套用自己的規則，不必重複解析原始值。
 *
 * - 'missing'：文件不存在，或文件存在但完全沒有這個欄位。
 * - 'true' / 'false'：欄位存在，且值恰好是布林 true／false。
 * - 'malformed'：欄位存在，但值不是嚴格的 true／false（null、字串、數字、
 *   物件、陣列……）——代表資料可能是被其他管道（手動改 Console、舊版
 *   程式）寫壞的，不能猜測維運人員原本想表達哪一種意圖。
 */
export type MaintenanceFlagShape = 'missing' | 'true' | 'false' | 'malformed'

/**
 * 判斷 `campaignOperationsPaused` 欄位的形狀。
 *
 * `rawValue` 只有在 `exists` 為 true 時才有意義；文件不存在時呼叫端應該
 * 傳 `undefined`，這裡一律先檢查 `!exists` 短路成 'missing'，不會去看
 * `rawValue` 的內容（避免呼叫端不小心傳了奇怪的值卻被忽略掉的假象）。
 *
 * 只有嚴格的 `=== true` / `=== false` 會被視為明確意圖；其他任何值
 * （包含 `undefined`——文件存在，但這個欄位本身是「own-property 顯式設成
 * undefined」，或者根本沒有這個鍵，這兩種情況在 JS 物件讀取的當下無法
 * 區分，Firestore 本身也不可能儲存字面上的 `undefined` 值，所以呼叫端拿到
 * 的 `rawValue === undefined` 實務上只會來自「文件存在但沒有這個欄位」，
 * 這裡同樣分類成 'malformed'——欄位存在於查詢結果的鍵集合裡卻沒有明確的
 * true/false 意圖，一律 fail closed 而不是當作 'missing'）都視為 'malformed'。
 */
export function classifyMaintenanceFlagShape(
  exists: boolean,
  rawValue: unknown,
): MaintenanceFlagShape {
  if (!exists) return 'missing'
  if (rawValue === true) return 'true'
  if (rawValue === false) return 'false'
  return 'malformed'
}

/**
 * 讀取維護旗標文件的結果——刻意跟 shared/permissions.ts 的
 * PermissionsSnapshot 用同一種「read-error 由呼叫端 catch 之後轉成明確的
 * kind，不是讓例外往上炸」的介面設計，方便測試逐一覆蓋每一種讀取結果。
 */
export type MaintenanceFlagReadOutcome =
  | { kind: 'read-error' }
  | { kind: 'read-ok'; exists: boolean; rawValue: unknown }

/**
 * 判斷目前是否應該擋下活動操作（六個受管制 callable 的唯一判斷依據）。
 *
 * Fail-closed 語意——任何不確定都視為「暫停中」：
 * - `read-error`（Firestore 讀取本身失敗，例如逾時、權限問題、服務中斷）
 *   → true（擋下）。這裡的取捨刻意跟 checkPermission() 的 read-error
 *   不同：權限讀取失敗時退回「拒絕這個操作」，維護旗標讀取失敗時同樣是
 *   「拒絕這個操作」——兩者殊途同歸，都是「讀不到就不放行」，不會有任何
 *   一種讀取失敗的組合意外變成「照常放行」。
 * - `read-ok` 且形狀是 'missing' 或 'false' → false（放行）——這是唯一
 *   允許通過的兩種情況：從未設定過（尚未啟用這個機制）、或明確設為
 *   false（維運人員主動關閉維護模式）。
 * - `read-ok` 且形狀是 'true' → true（擋下）——明確的維護意圖。
 * - `read-ok` 且形狀是 'malformed' → true（擋下）——資料可能已經損毀，
 *   不能假設維運人員原本想表達「放行」。
 */
export function isCampaignOperationsPaused(read: MaintenanceFlagReadOutcome): boolean {
  if (read.kind === 'read-error') return true
  const shape = classifyMaintenanceFlagShape(read.exists, read.rawValue)
  if (shape === 'missing' || shape === 'false') return false
  return true // 'true' 或 'malformed'
}

/**
 * 拋給呼叫端（六個受管制 callable 一律用 HttpsError('failed-precondition', ...)）
 * 的訊息——刻意通用、不含任何內部細節：不提操作人員、不提任何 campaign
 * ID、不解釋維護旗標本身怎麼運作。這份訊息會直接顯示給任何有權限呼叫這些
 * callable 的使用者（不只是 admin），維護狀態本身不是機密，但實作細節
 * （文件路徑、欄位名稱、判斷規則）沒有必要透過錯誤訊息外流。
 */
export const MAINTENANCE_PAUSED_MESSAGE =
  '系統目前正在進行維護，暫時無法執行這項操作，請稍後再試。若持續發生，請聯絡系統管理員。'

/** ops-maintenance.mjs CLI 支援的兩種動作。 */
export type MaintenanceCliAction = 'enable' | 'disable'

/**
 * CLI 對「要不要寫入、寫入什麼」的純判斷結果：
 * - 'write'：目前狀態跟目標狀態不同，需要真的寫入 `nextPaused`。
 * - 'noop'：目前狀態已經等於目標狀態，安全地什麼都不做（冪等）。
 * - 'malformed-refuse'：目前的值本身就不合法，拒絕自動覆寫——維運人員
 *   必須先人工檢查這份文件，CLI 不會替他們「猜」malformed 的值原本代表
 *   true 還是 false。
 */
export type MaintenanceCliDecision =
  | { outcome: 'write'; nextPaused: boolean }
  | { outcome: 'noop'; currentPaused: boolean }
  | { outcome: 'malformed-refuse' }

/**
 * ops-maintenance.mjs 的 enable/disable 動作在（Firestore transaction 內）
 * 重新讀到目前形狀之後，呼叫這裡決定該怎麼寫。
 *
 * 刻意不接受 `MaintenanceFlagReadOutcome`（那是「要不要擋下請求」用的
 * fail-closed 判斷），CLI 的寫入決策需要先知道「目前到底是哪一種形狀」
 * 才能分辨「已經是 true，enable 是 no-op」跟「malformed，enable 必須拒絕」
 * ——這兩種情況對 isCampaignOperationsPaused() 來說結果相同（都會擋下
 * 請求），但對 CLI 來說是完全不同的處置方式，所以這裡直接吃
 * MaintenanceFlagShape，不透過 isCampaignOperationsPaused() 那層再判斷一次。
 */
export function decideMaintenanceCliWrite(
  shape: MaintenanceFlagShape,
  action: MaintenanceCliAction,
): MaintenanceCliDecision {
  if (shape === 'malformed') return { outcome: 'malformed-refuse' }
  const currentPaused = shape === 'true'
  const nextPaused = action === 'enable'
  if (currentPaused === nextPaused) return { outcome: 'noop', currentPaused }
  return { outcome: 'write', nextPaused }
}
