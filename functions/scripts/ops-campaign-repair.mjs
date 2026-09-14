#!/usr/bin/env node
/**
 * 維運用「單一 campaign」修復 CLI（round 16 新增，Finding 3／Finding 4；
 * round 17 修正，Finding 2／Finding 3／Finding 6）。
 *
 * 用途：在 reconcileCampaignDeliveryStatus／repairCampaignPressReleaseSync
 * 這兩支 admin-only callable 部署到 production 之前，或不想／不能透過
 * onCall HTTPS 介面呼叫時，提供一條完全繞開 Cloud Functions 部署、但邏輯上
 * 跟 production 100% 相同的操作路徑——見 functions/src/index.ts 頂部部署
 * runbook 的【Bootstrap】章節。
 *
 * 這不是重新發明一套邏輯：跟 audit-campaign-drain.mjs 用同一招——直接
 * import 編譯後的 functions/lib/campaignSend.generated.js，呼叫跟
 * production／單元測試完全相同的 reconcileCampaignDelivery／
 * repairCampaignPressReleaseSyncTx／classifyCampaignForDrainAudit。唯一
 * 「另外寫」的部分是把這些函式接到 Admin SDK Firestore transaction 上的
 * 接線（deps wiring）——這跟 functions/src/index.ts 裡對應 callable 的接線
 * 是同一份邏輯的兩份抄本，但接線本身很薄、機械化、容易人工核對是否一致，
 * 跟核心的 fencing／決策邏輯（唯一容易出錯、唯一需要測試覆蓋的部分）完全
 * 不是同一回事——後者從頭到尾只有 shared/campaignSend.ts 這一份，不會漂移。
 *
 * ⚠️ 安全設計：
 * - 必須明確指定 --project 與 --campaign，一次只處理一份 campaign，沒有
 *   任何「處理全部」的模式——不希望這支工具被拿來當成自動化批次處理，
 *   每一次修復都應該是人工看過稽核結果、確認範圍之後才執行。
 * - 預設 dry-run：只印出「現在的狀態」與「如果執行會發生什麼」，不寫入
 *   任何東西。真的要寫入必須額外加 `--confirm <campaign-id>`——round 17
 *   修正（Finding 6）：`--confirm` 不再是一個不需要值的旗標，必須帶一個
 *   跟 `--campaign` 完全相同的值，避免「多打一個 --confirm」意外對錯誤的
 *   campaign 造成寫入。
 * - round 17 修正（Finding 6）：dry-run 不再只印 campaign 頂層欄位——會
 *   實際查詢收件人（field-mask，不含 email／姓名／收件人 ID）、套用跟
 *   confirm 時完全相同的 classifyCampaignForDrainAudit() 分類規則、並用
 *   decideCampaignStatus() 算出一個推估的最終狀態。
 * - 結構上不存在任何 SMTP／寄信能力——這支腳本從頭到尾沒有 import
 *   nodemailer、沒有讀取 SMTP secret，import 的
 *   reconcileCampaignDelivery／repairCampaignPressReleaseSyncTx 本身的
 *   依賴介面（ReconcileCampaignDeliveryDeps 等）結構上也不存在任何寄信
 *   相關方法——見 shared/campaignSend.ts 的說明。
 * - 跟 audit-campaign-drain.mjs 一樣，執行前會驗證編譯產物是否可能過期
 *  （verifyBuildFreshness），過期就直接拒絕執行。
 * - round 17 新增（Finding 3）：這支工具結構上不提供、也永遠不會提供
 *  「直接覆寫 leaseGeneration」的操作——EXHAUSTED（leaseGeneration 已達
 *   Number.MAX_SAFE_INTEGER）永遠需要人工 escalation，見
 *   audit-campaign-drain.mjs 與 functions/src/index.ts 頂部 runbook 的
 *   完整說明，這裡不重複。
 * - round 17 新增（Finding 2）：這支檔案被其他模組 import 時（例如測試）
 *   絕對不會執行 main()——見檔案最後的 direct-execution guard；
 *   verifyBuildFreshness 從完全無副作用的 audit-utils.mjs 匯入，不再
 *   import audit-campaign-drain.mjs 本身（那支檔案自己的 main() 曾經在
 *   被 import 時意外一起執行）。
 *
 * 用法（唯一推薦入口——跟 audit-campaign-drain.mjs 一樣，這個 npm script
 * 會先自動 npm run build 再執行，不需要自己記得先手動 build）：
 *   cd functions && npm run ops:campaign-repair -- --project <id> --campaign <id> \
 *     --action reconcile                     # 或 --action repair-press-release
 *                                             # 或 --action repair-status
 *     [--confirm <同一個 campaign-id>]        # 不加這個旗標只會 dry-run，不寫入
 *
 * round 26 新增：--action repair-status——跟 reconcile／repair-press-release
 * 是完全獨立的第三種動作，範圍刻意縮得很窄：只校正 campaign 頂層的
 * status／totals，讓它們跟 recipients 子集合真實的分佈一致（目前唯一支援
 * completed → partial 這一種 transition——見 shared/campaignSend.ts 的
 * decideCampaignStatusRepair() 完整說明）。不取得任何處理／resolution
 * 租約、不改動任何 recipient 文件、不重試、不寄信。這是為了修一筆真實
 * 稽核發現的資料：campaign 是 completed，但 recipients 真實分佈是
 * sent:113／failed:3——reconcile 用不上（見下面 runReconcile() 的說明：
 * INDETERMINATE 不是 UNKNOWN，而且 completed 本身就是 terminal，
 * decideAcquireCampaignLease() 會直接拒絕核發租約）。
 *
 * exit code：
 *   0 — 執行成功（dry-run 或真的 confirm 寫入都算），詳見輸出內容。
 *   1 — 執行完成，但結果本身代表「還是不能視為已解決」（例如 reconcile
 *       之後 campaign 落在 needs_review，仍需要 resolveDeliveryUnknown
 *       人工處理）。
 *   2 — 執行本身失敗（缺少或不合法的參數、找不到編譯輸出、編譯產物可能
 *       過期、Firestore 連線失敗…）。
 */
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isDirectExecution, verifyBuildFreshness, getDocumentByIdWithFieldMask } from './audit-utils.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const compiledClassifierPath = join(here, '..', 'lib', 'campaignSend.generated.js')

const KNOWN_FLAGS = new Set(['--project', '--campaign', '--action', '--confirm'])

/** round 17 新增（Finding 6）：dry-run／confirm 都用這份 field mask 讀 campaign
 *  頂層欄位——跟 audit-campaign-drain.mjs 的 CAMPAIGN_FIELDS 幾乎相同，
 *  額外多了 pressReleaseId／isTest／mode（reconcile 的推估與
 *  repair-press-release 動作都需要）。round 25：抽成具名常數，方便
 *  emulator 測試斷言「敏感測試欄位確實沒被讀到」時直接引用同一份清單。 */
export const CAMPAIGN_REPAIR_CLASSIFICATION_FIELDS = [
  'status',
  'recipientsReady',
  'activeAttemptId',
  'activeLeaseExpiresAtMs',
  'activeLeaseExpiresAt',
  'resolutionLeaseAttemptId',
  'resolutionLeaseExpiresAtMs',
  'leaseGeneration',
  'createdByAttemptId',
  'startedAtMs',
  'startedAt',
  'pressReleaseId',
  'isTest',
  'mode',
  // round 27 新增（Finding 1）：這裡也會呼叫
  // classifyCampaignForDrainAudit()（見下方 createClassificationLoader()），
  // SAFE_WITH_WARNING 的「歷史 completed campaign」例外需要證明這三個欄位
  // 完全不存在——跟 audit-campaign-drain.mjs 的 CAMPAIGN_FIELDS 同一個理由，
  // 見 shared/campaignSend.ts 的 isLegacyCompletedPartialMismatchSafe()。
  // 少了這三個欄位，這裡跟 audit:drain 對同一份 campaign 可能算出不同的
  // classification（field mask 沒請求到的欄位一律讀成 undefined，會被誤判
  // 成「真的缺席」），這是本輪需求文件明確要求的一致性。
  'createdAt',
  'updatedAt',
  'completedAt',
]

/** round 26 新增：--action repair-status 的 dry-run／confirm 都用這份
 *  field mask 讀 campaign 頂層欄位——只包含 decideCampaignStatusRepair()
 *  的 eligibility 檢查與 dry-run 輸出實際需要的欄位，不含
 *  email／subject／pressReleaseId 等這個動作用不到的內容（這個動作結構上
 *  不碰 pressReleases，也不需要判斷 sendKind）。`totals` 選整個巢狀欄位
 *  （Firestore field mask 對巢狀 map 欄位一次選整個 map）。 */
export const CAMPAIGN_STATUS_REPAIR_FIELDS = [
  'status',
  'recipientsReady',
  'activeAttemptId',
  'resolutionLeaseAttemptId',
  'createdByAttemptId',
  'leaseGeneration',
  'totals',
]

/**
 * round 26 新增：跟 createClassificationLoader() 同一種理由抽出來的工廠
 * 函式——輸入這份 campaign 的 DocumentReference，以及 FieldPath／
 * decideCampaignStatusRepair（呼叫端提供，production 從動態載入的編譯產物
 * 拿，emulator 整合測試可以直接從 shared/campaignSend.ts 拿同一份純函式），
 * 回傳一個 `loadCampaignStatusRepairDecision()` 函式：用跟 --confirm 完全
 * 相同的 field mask 讀 campaign（不含這個動作用不到的欄位），只選收件人的
 * status（不含 email／姓名等 PII），呼叫 decideCampaignStatusRepair()。
 * main() 的 runRepairStatus() 呼叫這個工廠函式取得 dry-run 用的
 * loader，不再自己內聯定義——這樣 emulator 整合測試才能呼叫「跟
 * production 100% 相同」的 dry-run 讀取路徑。
 *
 * @param {FirebaseFirestore.DocumentReference} campaignRef
 * @param {{FieldPath: {documentId(): FirebaseFirestore.FieldPath}, decideCampaignStatusRepair: Function}} deps
 */
export function createCampaignStatusRepairLoader(campaignRef, { FieldPath, decideCampaignStatusRepair }) {
  const campaignId = campaignRef.id
  return async function loadCampaignStatusRepairDecision() {
    const snap = await getDocumentByIdWithFieldMask(
      campaignRef.parent,
      campaignId,
      CAMPAIGN_STATUS_REPAIR_FIELDS,
      FieldPath,
    )
    const campaignSnapLike = snap ? { exists: true, data: snap.data() } : { exists: false, data: undefined }
    // 只選 status——不讀 email／姓名等 PII，跟 reconcile 的
    // listAllRecipientStatuses 用同一個欄位遮罩習慣。
    const recipientsSnap = await campaignRef.collection('recipients').select('status').get()
    const recipients = recipientsSnap.docs.map((d) => ({ status: d.data().status }))
    return decideCampaignStatusRepair(campaignSnapLike, recipients)
  }
}

/**
 * round 25 新增：把 main() 原本內聯的 loadClassification() 抽成模組頂層
 * export 的工廠函式——輸入這份 campaign 的 DocumentReference，以及
 * FieldPath／classifyCampaignForDrainAudit（呼叫端負責提供，production 從
 * 動態載入的編譯產物拿，測試可以直接從 shared/campaignSend.ts 拿），回傳
 * 一個 `loadClassification(nowMs)` 函式。main() 底下改成呼叫這個工廠函式，
 * 不再自己內聯定義——這樣 emulator 整合測試才能呼叫「跟 production 100%
 * 相同」的這份程式碼（含 round 25 修正的 getDocumentByIdWithFieldMask()
 * 查詢邏輯），不必在測試檔案裡另外重新刻一份「看起來很像」的查詢邏輯。
 *
 * @param {FirebaseFirestore.DocumentReference} campaignRef
 * @param {{FieldPath: {documentId(): FirebaseFirestore.FieldPath}, classifyCampaignForDrainAudit: Function}} deps
 */
export function createClassificationLoader(campaignRef, { FieldPath, classifyCampaignForDrainAudit }) {
  const campaignId = campaignRef.id

  /** round 17 新增（Finding 6）：用跟 audit-campaign-drain.mjs 完全相同的
   *  field-mask 讀取這份 campaign 與它的收件人（不含 email／姓名／收件人
   *  ID），交給 classifyCampaignForDrainAudit() 分類——dry-run 與真的
   *  執行前都呼叫這個函式，兩者看到的是同一套規則。 */
  return async function loadClassification(nowMs) {
    // round 25 修正：campaignRef 是 DocumentReference，沒有 .select()——見
    // audit-utils.mjs 的 getDocumentByIdWithFieldMask() 說明（跟
    // audit-campaign-drain.mjs 的 readCampaignStabilityFields() 同一個 bug、
    // 同一個修法）。campaignRef.parent 就是 db.collection('campaigns')，
    // field mask（CAMPAIGN_REPAIR_CLASSIFICATION_FIELDS）維持完全不變。
    const snap = await getDocumentByIdWithFieldMask(
      campaignRef.parent,
      campaignId,
      CAMPAIGN_REPAIR_CLASSIFICATION_FIELDS,
      FieldPath,
    )
    if (!snap) return { exists: false }
    const data = snap.data()
    const recipientsSnap = await campaignRef
      .collection('recipients')
      .select('status', 'leaseExpiresAtMs', 'leaseExpiresAt')
      .get()
    const recipients = recipientsSnap.docs.map((d) => {
      const r = d.data()
      return { status: r.status, leaseExpiresAtMs: r.leaseExpiresAtMs, leaseExpiresAtLegacy: r.leaseExpiresAt }
    })
    const classification = classifyCampaignForDrainAudit(
      {
        campaignId,
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
        // round 27 修正（提交前審查 Finding 1）：見 audit-campaign-drain.mjs
        // 對應位置的說明——SAFE_WITH_WARNING 的 legacy 例外需要原始物件本身
        // 才能用 isFieldAbsent()／hasOwnProperty 判斷欄位是否完全不存在。
        campaignRawData: data,
        recipients,
      },
      nowMs,
    )
    return { exists: true, data, recipients, classification }
  }
}

/**
 * round 17 修正（Finding 6）：比 round 16 版本嚴格得多——
 * - 拒絕未知參數（不在 KNOWN_FLAGS 裡的任何 `--xxx`）。
 * - 每個旗標都要求緊接著一個值，且那個值不能是另一個看起來像旗標的
 *   字串（`--project --campaign xyz` 這種漏打值的情況會被擋下，不會把
 *   `--campaign` 這個字串本身誤當成 project id）。
 * - `--confirm` 現在需要一個值（預期跟 `--campaign` 相同），不再是單純的
 *   布林旗標。
 * 回傳 `{ error: string }`（參數本身就不合法）或成功時的
 * `{ project, campaign, action, confirmCampaignId }`（`confirmCampaignId`
 * 沒有出現 `--confirm` 時是 `undefined`）。
 */
export function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    if (!KNOWN_FLAGS.has(flag)) {
      return { error: `未知的參數：${flag}` }
    }
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) {
      return { error: `${flag} 缺少值` }
    }
    if (flag === '--project') args.project = value
    else if (flag === '--campaign') args.campaign = value
    else if (flag === '--action') args.action = value
    else if (flag === '--confirm') args.confirmCampaignId = value
    i += 1
  }
  return args
}

/** round 17 新增（Finding 6）：campaign ID 不能是空字串／只有空白／包含
 *  `/`（Firestore 文件 ID 裡的 `/` 會被誤解成路徑分隔符），跟
 *  reconcileCampaignDeliveryStatus callable 用同一個標準。 */
function isValidCampaignId(id) {
  return typeof id === 'string' && id.trim().length > 0 && !/[\s/]/.test(id)
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2))
  if (parsed.error) {
    console.error(parsed.error)
    process.exitCode = 2
    return
  }
  const { project, campaign, action, confirmCampaignId } = parsed

  if (!project) {
    console.error('缺少 --project <firebase-project-id>——這支腳本不會使用任何預設專案。')
    process.exitCode = 2
    return
  }
  if (!isValidCampaignId(campaign)) {
    console.error('缺少或不合法的 --campaign <campaign-id>——不能是空字串、空白，或包含 "/"。')
    process.exitCode = 2
    return
  }
  if (action !== 'reconcile' && action !== 'repair-press-release' && action !== 'repair-status') {
    console.error("缺少或不合法的 --action——必須是 'reconcile'、'repair-press-release' 或 'repair-status'。")
    process.exitCode = 2
    return
  }
  // round 17 修正（Finding 6）：--confirm 必須綁定跟 --campaign 完全相同
  // 的值才會真的寫入；出現但不相符一律視為不安全，直接拒絕（而不是
  // 靜默退回 dry-run，那樣可能讓操作人員誤以為已經執行了寫入）。
  const confirmProvided = confirmCampaignId !== undefined
  if (confirmProvided && confirmCampaignId !== campaign) {
    console.error(
      `--confirm 的值（${confirmCampaignId}）跟 --campaign 的值（${campaign}）不相符——` +
        '為了避免誤操作到錯誤的 campaign，--confirm 必須明確帶上跟 --campaign 完全相同的 campaign ID。',
    )
    process.exitCode = 2
    return
  }
  const confirm = confirmProvided

  const freshness = verifyBuildFreshness()
  if (!freshness.fresh) {
    console.error(`編譯產物無法證明是最新的，拒絕執行：\n${freshness.reason}`)
    process.exitCode = 2
    return
  }

  const {
    reconcileCampaignDelivery,
    acquireCampaignLeaseTx,
    reclaimExpiredDeliveryAttemptTx,
    computeAuthoritativeRecipientTotals,
    areAllRecipientStatusesKnown,
    finalizeCampaignWithPressReleaseTx,
    releaseCampaignProcessingLeaseTx,
    repairCampaignPressReleaseSyncTx,
    decidePressReleaseSyncRepair,
    classifyCampaignForDrainAudit,
    classifyRecipientForDrainAudit,
    decideCampaignStatus,
    // round 26 新增：--action repair-status 用的純函式與 Tx 協調層——見
    // shared/campaignSend.ts 的 decideCampaignStatusRepair／
    // repairCampaignStatusTx 完整說明。
    decideCampaignStatusRepair,
    repairCampaignStatusTx,
    CAMPAIGN_LEASE_MS,
    // Windows 修正：見 audit-campaign-drain.mjs 對應位置的說明──
    // compiledClassifierPath 是原始檔案系統路徑，動態載入需要合法的
    // file URL 才能在 Windows 上正確載入，否則 `C:` 會被誤認成不支援的
    // URL scheme。只有這裡轉成 file URL，其餘檔案系統操作（verifyBuildFreshness
    // 等）仍然用原本的 path。（這裡的註解措辭刻意避開「動態載入」加括號的
    // 寫法與完整 `scheme://` 字串──這支檔案會被 tests/opsCampaignRepair.test.ts
    // 用 ESM import 匯入，Vite 的 SSR 轉換用輕量 lexer 掃描 import 語法，
    // 已經實測過純文字註解裡出現看起來像動態載入呼叫或完整 URL 的字樣時，
    // 會誤判成真正的語法而讓整個檔案轉譯失敗，見本輪報告的說明。）
  } = await import(pathToFileURL(compiledClassifierPath).href)

  const { initializeApp } = await import('firebase-admin/app')
  const { getFirestore, FieldValue, Timestamp, FieldPath } = await import('firebase-admin/firestore')

  initializeApp({ projectId: project })
  const db = getFirestore()

  console.log(
    `專案 ${project} | campaign ${campaign} | action=${action} | ` +
      (confirm ? '⚠️ 將會真的寫入（--confirm 已綁定此 campaign）' : '唯讀 dry-run（未加 --confirm，不會寫入）'),
  )

  /** Admin SDK transaction + 文件參照包成 shared/campaignSend.ts 認得的
   *  DocTx 形狀——跟 functions/src/index.ts 的 docTx() 是同一份邏輯的
   *  另一份抄本，這裡刻意保持完全一致，方便人工核對。 */
  function docTx(tx, ref) {
    return {
      async get() {
        const snap = await tx.get(ref)
        return { exists: snap.exists, data: snap.exists ? snap.data() : undefined }
      },
      set(data) {
        tx.set(ref, data)
      },
      update(data) {
        tx.update(ref, data)
      },
    }
  }

  const campaignRef = db.collection('campaigns').doc(campaign)

  // round 25 修正：loadClassification 已經抽成模組頂層 export 的
  // createClassificationLoader()——內容跟原本內聯在這裡的版本完全一樣
  // （含 round 25 對 field-mask 查詢的修正），只是移到頂層讓 emulator
  // 整合測試可以直接 import 呼叫同一份程式碼。
  const loadClassification = createClassificationLoader(campaignRef, {
    FieldPath,
    classifyCampaignForDrainAudit,
  })

  /** round 17 新增（Finding 6）：用 decideCampaignStatus()（跟 production
   *  finalize 用的是同一份公式）算出「如果現在執行 reconcile，最終狀態
   *  大概會是什麼」——把每一位 sending 且租約已過期的收件人（drain
   *  classifier 判定為 'unknown'）當成 reclaimExpiredDeliveryAttemptTx
   *  會把它轉成的 delivery_unknown，其餘收件人維持原本的 status，再套用
   *  computeAuthoritativeRecipientTotals()。這只是**推估**——dry-run 與
   *  真正執行之間 Firestore 資料可能改變，這裡明確標示為推估值，不是
   *  保證值。 */
  function projectReconcileOutcome(recipients, nowMs) {
    const projected = recipients.map((r) => {
      const cls = classifyRecipientForDrainAudit(r, nowMs)
      if (r.status === 'sending' && cls === 'unknown') return { status: 'delivery_unknown' }
      return { status: r.status }
    })
    const { totals, nonTerminalCount } = computeAuthoritativeRecipientTotals(projected)
    const projectedStatus = decideCampaignStatus(totals, nonTerminalCount)
    return { totals, nonTerminalCount, projectedStatus }
  }

  if (action === 'reconcile') {
    await runReconcile()
  } else if (action === 'repair-press-release') {
    await runRepairPressRelease()
  } else {
    await runRepairStatus()
  }

  async function runReconcile() {
    const nowMs = Date.now()
    const loaded = await loadClassification(nowMs)
    if (!loaded.exists) {
      console.log('campaign 不存在，沒有東西可以校正。')
      process.exitCode = 2
      return
    }

    // round 17 修正（Finding 6）：dry-run 用跟 confirm 相同的分類規則與
    // 收件人查詢，不再只印頂層欄位。
    console.log('目前的稽核分類（跟 npm run audit:drain 使用同一套規則）：')
    console.log({
      classification: loaded.classification.classification,
      setupPhase: loaded.classification.setupPhase,
      processingLease: loaded.classification.processingLease,
      resolutionLease: loaded.classification.resolutionLease,
      leaseGeneration: loaded.classification.leaseGeneration,
      recipientCount: loaded.classification.recipientCount,
      activeRecipientCount: loaded.classification.activeRecipientCount,
      indeterminateRecipientCount: loaded.classification.indeterminateRecipientCount,
      unknownRecipientCount: loaded.classification.unknownRecipientCount,
    })

    const projection = projectReconcileOutcome(loaded.recipients, nowMs)
    console.log('如果現在執行 reconcile，推估結果（不是保證值，dry-run 與實際執行之間資料可能改變）：')
    console.log({
      projectedFinalStatus: projection.projectedStatus,
      projectedTotals: projection.totals,
      projectedNonTerminalCount: projection.nonTerminalCount,
      willBeReclaimedToDeliveryUnknown: loaded.classification.unknownRecipientCount,
      stillActiveLeases: loaded.classification.activeRecipientCount,
      cannotDetermine: loaded.classification.indeterminateRecipientCount,
    })
    if (loaded.classification.indeterminateRecipientCount > 0) {
      console.log(
        '⚠️ 有收件人的狀態無法判定（indeterminate）——reconcile 不會處理這些人，' +
          '最終結果可能跟上面的推估不同，執行後請重新查稽核結果確認。',
      )
    }

    // round 26 修正（Part 1）：reconciliation 只是「校正卡住的 sending
    // 收件人」的工具，只有分類恰好是 UNKNOWN 時才是正確的使用情境——
    // ACTIVE（真的還在合法處理中）、INDETERMINATE（資料本身有問題，需要
    // 先人工查清楚）、EXHAUSTED（acquireLease 自己也會被
    // generation-exhausted 擋下）、SAFE（沒有東西需要校正）全部不合格。
    // `confirmEligible` 是唯一權威來源——dry-run 的訊息與下面真正執行
    // --confirm 時的前置檢查共用同一個布林值，不會有兩處各自判斷、可能
    // 漂移的風險。
    //
    // ⚠️ round 26 修正的核心：過去不論 confirmEligible 是不是 true，只要
    // `!confirm` 就無條件印出「加上 --confirm 重新執行才會真的呼叫
    // reconcileCampaignDelivery()」——即使分類是 INDETERMINATE（本來就會
    // 被下面擋下），這句話仍然暗示「加 --confirm 就會成功」，讓維運人員
    // 誤以為這是一條可行的修復路徑。現在改成：不合格時，dry-run 也直接印出
    // 「真的加上 --confirm 會被拒絕」的具體原因，不再印出那句暗示會成功的
    // 通用訊息——這是純粹的輸出文字修正，reconcile 本身的 eligibility 判斷
    // 邏輯（`classification !== 'UNKNOWN'` 這個條件本身）完全沒有改變。
    const confirmEligible = loaded.classification.classification === 'UNKNOWN'
    const confirmIneligibleReason =
      `目前的稽核分類是 ${loaded.classification.classification}，不是 reconciliation 該處理的情境` +
      '（reconciliation 只用來校正 UNKNOWN：sending 收件人租約過期，其餘健康）。' +
      'ACTIVE 請等待自然完成；INDETERMINATE 需要先人工檢查資料，不是加 --confirm 就能執行；' +
      'EXHAUSTED 需要人工 escalation（見 audit-campaign-drain.mjs 的說明）；' +
      'SAFE 代表沒有東西需要校正——不論哪一種，加 --confirm 都會被拒絕，不會真的執行。'

    if (!confirm) {
      if (confirmEligible) {
        console.log(
          `加上 --confirm ${campaign} 重新執行才會真的呼叫 reconcileCampaignDelivery()——` +
            '這會嘗試取得處理租約、把過期的 sending 收件人轉成 delivery_unknown、' +
            '重新計算 totals 並收尾，全程不會呼叫 SMTP。',
        )
      } else {
        console.log(`⚠️ 這份 campaign 目前不符合 --confirm 的執行條件，即使加上 --confirm 也會被拒絕：${confirmIneligibleReason}`)
      }
      return
    }

    if (!confirmEligible) {
      console.error(`拒絕執行：${confirmIneligibleReason}`)
      process.exitCode = 2
      return
    }

    // round 17 修正（Finding 6 項目 6）：即使 dry-run 剛剛才查過一次，
    // 這裡仍然重新走一次完整的 acquireCampaignLeaseTx／
    // reclaimExpiredDeliveryAttemptTx／finalizeCampaignWithPressReleaseTx
    // ——每一個都在自己的 Firestore transaction 裡重新驗證 fencing
    // generation／owner，不會相信 dry-run 當下讀到的舊資料。
    const reconciliationAttemptId = randomUUID()
    let acquiredGeneration = -1

    const deps = {
      acquireLease: async () => {
        const decision = await db.runTransaction((tx) =>
          acquireCampaignLeaseTx(
            docTx(tx, campaignRef),
            reconciliationAttemptId,
            Date.now(),
            CAMPAIGN_LEASE_MS,
            () => ({
              updatedAt: FieldValue.serverTimestamp(),
              resolutionLeaseAttemptId: FieldValue.delete(),
              resolutionLeaseExpiresAtMs: FieldValue.delete(),
            }),
          ),
        )
        if (decision.outcome === 'acquired') acquiredGeneration = decision.generation
        return decision
      },
      // round 18 新增（Finding 2）：取得租約之後第一件事——讀「全部」收件
      // 人的 status（field mask，不含 email／姓名等 PII），交給
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
            '維運人員透過 ops-campaign-repair.mjs 手動校正（bootstrap，reconcileCampaignDeliveryStatus 尚未部署）',
            () => ({ updatedAt: FieldValue.serverTimestamp() }),
          ),
        ),
      // round 19 新增（Finding 3）：finalize 之前最後一次讀取，再驗證一次
      // 全部收件人狀態合法——見 shared/campaignSend.ts 的
      // ReconcileCampaignDeliveryDeps.computeAuthoritativeTotals 說明。
      computeAuthoritativeTotals: async () => {
        const snap = await campaignRef.collection('recipients').get()
        const statuses = snap.docs.map((d) => ({ status: d.data().status }))
        if (!areAllRecipientStatusesKnown(statuses)) {
          return { outcome: 'invalid-recipient-state' }
        }
        return { outcome: 'ok', ...computeAuthoritativeRecipientTotals(statuses) }
      },
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
          console.error(
            `拒絕收尾：新聞稿同步中繼資料無法安全判斷（reason=${decision.reason}）——` +
              'campaign 沒有變成 terminal，只是安全釋放了這次的處理租約。請檢查這份 campaign 文件本身的資料。',
          )
          return decision
        }
        if (decision.pressReleaseUpdated) {
          console.log('（同步更新了對應新聞稿的已發送狀態）')
        }
        return decision.finalize
      },
      releaseLeaseBestEffort: async () => {
        await db.runTransaction((tx) =>
          releaseCampaignProcessingLeaseTx(docTx(tx, campaignRef), reconciliationAttemptId, acquiredGeneration, () => ({
            activeAttemptId: FieldValue.delete(),
            activeLeaseExpiresAtMs: FieldValue.delete(),
            updatedAt: FieldValue.serverTimestamp(),
          })),
        )
      },
      logWarn: (message, meta) => console.warn(message, meta ?? {}),
      logError: (message, meta) => console.error(message, meta ?? {}),
    }

    const result = await reconcileCampaignDelivery(deps)
    console.log('reconcileCampaignDelivery 結果：', result)

    if (result.outcome === 'reconciled') {
      console.log(`完成，finalStatus=${result.finalStatus}，reclaimedCount=${result.reclaimedCount}`)
      if (result.finalStatus === 'needs_review') {
        console.log('落在 needs_review：仍需要透過人工 delivery_unknown 處理流程解決，不會自動消失。')
        process.exitCode = 1
      }
      return
    }
    // round 18 新增（Finding 2）；round 19 修正（Finding 3／4）：即使上面
    // 的分類前置檢查通過，reconcileCampaignDelivery() 自己在取得租約之後
    // （以及 finalize 之前最後一次重新查詢時）都會再驗證一次全部收件人
    // 狀態，仍然可能發現不可信的資料（TOCTOU——檢查完之後、真正執行之前
    // 的極短時間內被改壞）。⚠️ round 19 修正（Finding 4，報告用詞精確
    // 化）：準確的說法是「零 recipient mutation、零 campaign 終止狀態
    //（status／totals／completedAt）寫入」，不是「沒有任何寫入發生」——
    // 取得租約（acquireLease）與 best-effort 釋放都各自寫過一次 campaign
    // 的租約欄位。
    if (result.outcome === 'invalid-recipient-state') {
      console.error(
        '拒絕校正：重新讀取時發現至少一位收件人的狀態無法辨識（可能是取得租約之後，或計算 ' +
          'authoritative totals 之前才被改壞）。沒有任何 recipient 被修改，也沒有寫入任何 campaign ' +
          '終止狀態（reclaim／finalize 都沒有真正完成）；但這次取得與釋放處理租約仍會各寫一次 ' +
          'campaign 的租約欄位。請直接檢查 Firestore 的 recipients 子集合。',
      )
      process.exitCode = 1
      return
    }
    // round 18 新增（Finding 1）：新聞稿同步中繼資料無法安全判斷，或已經
    // 確認需要同步卻找不到新聞稿——campaign 完全沒有變成 terminal，只有
    // 這次的處理租約被安全釋放。
    if (result.outcome === 'blocked') {
      console.error(
        `拒絕校正：新聞稿同步中繼資料無法安全判斷（reason=${result.reason}）。` +
          'campaign 維持原本的非終止狀態，只有這次的處理租約被安全釋放，請檢查這份 campaign 文件本身的資料後再重試。',
      )
      process.exitCode = 1
      return
    }
    // not-found／terminal／not-ready／held-by-other／superseded／
    // invalid-generation／generation-exhausted：都代表這次沒有真的完成
    // 校正，不是「已解決」。
    process.exitCode = 1
  }

  async function runRepairPressRelease() {
    if (!confirm) {
      const snap = await campaignRef.get()
      if (!snap.exists) {
        console.log('campaign 不存在。')
        process.exitCode = 2
        return
      }
      const pressReleaseId = snap.data()?.pressReleaseId
      const pressReleaseSnap =
        typeof pressReleaseId === 'string' && pressReleaseId
          ? await db.collection('pressReleases').doc(pressReleaseId).get()
          : null
      // round 20 修正（Finding 3）：跟 functions/src/index.ts 的
      // repairCampaignPressReleaseSync 用同一個 Date.now() 呼叫方式——真正
      // 的判斷邏輯（alreadySynced／completedAt 合理性）完全來自共用的
      // decidePressReleaseSyncRepair()，兩邊不會漂移。
      const decision = decidePressReleaseSyncRepair(
        { exists: snap.exists, data: snap.data() },
        pressReleaseSnap ? { exists: pressReleaseSnap.exists, data: pressReleaseSnap.data() } : null,
        Date.now(),
      )
      console.log('dry-run：如果現在執行，decidePressReleaseSyncRepair() 會回報：', decision)
      if (decision.shouldWrite) {
        console.log(`加上 --confirm ${campaign} 重新執行才會真的把新聞稿標記成已發送。`)
      }
      return
    }

    // round 18 修正（Finding 5）：不可以用「修復發生的當下時間」冒充
    // campaign 完成時間——sentAt 必須來自 campaign 本身可信的完成時間
    // （decidePressReleaseSyncRepair 會透過 authoritativeCompletedAtMs 把
    // campaign.completedAt 換算成的毫秒數傳進來；如果沒有可信時間，
    // decision.shouldWrite 會是 false，這個 callback 根本不會被呼叫）。
    // round 19 修正（Finding 2）：收到的是驗證過的毫秒數，不是原始
    // unknown 值，必須自己用 Timestamp.fromMillis() 正規化成真正的
    // Firestore Timestamp 才能寫入 sentAt——PressRelease.sentAt 的型別是
    // Timestamp，寫入純數字會讓前端排序／格式化悄悄失效（見
    // shared/campaignSend.ts canonical schema 的說明）。
    const decision = await db.runTransaction((tx) =>
      repairCampaignPressReleaseSyncTx(
        docTx(tx, campaignRef),
        (pressReleaseId) => docTx(tx, db.collection('pressReleases').doc(pressReleaseId)),
        (authoritativeCompletedAtMs) => ({
          status: 'sent',
          sentAt: Timestamp.fromMillis(authoritativeCompletedAtMs),
        }),
        Date.now(),
      ),
    )
    console.log('repairCampaignPressReleaseSyncTx 結果：', decision)
    if (decision.outcome !== 'synced' && decision.outcome !== 'already-synced') {
      process.exitCode = 1
    }
    // round 18 新增（Finding 6）：pressReleaseId 缺失、新聞稿文件不存在、
    // 或找不到可信的完成時間——都不是單純「跳過」，給出明確訊息方便維運
    // 人員判斷下一步，而不是只看 exit code。
    if (decision.outcome === 'missing-press-release-id') {
      console.log('這筆發送需要同步新聞稿，但 campaign 缺少 pressReleaseId，可能是資料損毀，請人工檢查。')
    } else if (decision.outcome === 'press-release-not-found') {
      console.log(
        '這筆發送需要同步新聞稿，但找不到 pressReleaseId 對應的新聞稿文件（可能已被合法刪除），請人工確認。',
      )
    } else if (decision.outcome === 'missing-authoritative-sent-time') {
      console.log(
        'campaign 缺少可信的完成時間（completedAt），為避免用修復當下時間冒充寄送時間，已拒絕寫入，請人工檢查。',
      )
    }
  }

  /**
   * round 26 新增：--action repair-status——只校正 campaign 頂層
   * status／totals，讓它們跟 recipients 子集合真實的分佈一致，目前只支援
   * completed → partial 這一種 transition（見 shared/campaignSend.ts 的
   * decideCampaignStatusRepair() 完整說明；為什麼 reconcile 用不上這個
   * 情境見本檔案上方 usage 說明與本輪報告）。
   *
   * dry-run 與 --confirm 都呼叫同一份 decideCampaignStatusRepair()／
   * repairCampaignStatusTx()——dry-run 用一次非交易讀取（field mask，只讀
   * decideCampaignStatusRepair() 需要的欄位，recipients 只選 status，不含
   * email／姓名等 PII）；--confirm 在單一 Firestore transaction 內重新讀取
   * 一次全新的資料，重新跑一次全部 eligibility 檢查，只有仍然合格才寫入
   * ——TOCTOU（dry-run 之後、confirm 之前，或 transaction 因為 optimistic
   * concurrency 重試之間）任何變化都會被這次重新驗證抓到，不會有部分寫入。
   */
  async function runRepairStatus() {
    // round 26 修正：dry-run 讀取路徑抽成模組頂層 export 的
    // createCampaignStatusRepairLoader()——內容跟原本內聯在這裡的版本完全
    // 一樣，只是移到頂層讓 emulator 整合測試可以直接 import 呼叫同一份
    // 程式碼（跟 loadClassification／createClassificationLoader 同一種
    // 理由，見該處的說明）。
    const loadCampaignStatusRepairDecision = createCampaignStatusRepairLoader(campaignRef, {
      FieldPath,
      decideCampaignStatusRepair,
    })
    const decision = await loadCampaignStatusRepairDecision()
    if (decision.outcome === 'campaign-not-found') {
      console.log('campaign 不存在，沒有東西可以修復。')
      process.exitCode = 2
      return
    }
    console.log('repair-status 判斷結果（dry-run 與 --confirm 的前置檢查都呼叫同一份 decideCampaignStatusRepair()）：')
    console.log({
      currentStatus: decision.currentStatus,
      currentTotals: decision.currentTotals,
      authoritativeStatus: decision.authoritativeStatus,
      authoritativeTotals: decision.authoritativeTotals,
      nonTerminalCount: decision.nonTerminalCount,
      eligible: decision.outcome === 'eligible',
      outcome: decision.outcome,
      reason: decision.reason,
    })
    if (decision.outcome === 'eligible') {
      console.log('如果加上 --confirm，會寫入下列 patch（實際值以 --confirm 當下重新驗證的結果為準）：', decision.patch)
    }

    if (!confirm) {
      if (decision.outcome === 'eligible') {
        console.log(`加上 --confirm ${campaign} 重新執行才會真的寫入上面的 patch——不會動任何 recipient 文件，也不會寄信。`)
      } else if (decision.outcome === 'already-consistent') {
        console.log('狀態已經跟真實收件人分佈一致，沒有東西需要修復，不需要（也不應該）加 --confirm。')
      } else {
        console.log(`⚠️ 這份 campaign 目前不符合 repair-status 的執行條件，即使加上 --confirm 也會被拒絕：${decision.reason}`)
      }
      return
    }

    const result = await db.runTransaction((tx) =>
      repairCampaignStatusTx(
        docTx(tx, campaignRef),
        async () => {
          const snap = await tx.get(campaignRef.collection('recipients').select('status'))
          return snap.docs.map((d) => ({ status: d.data().status }))
        },
        () => ({
          updatedAt: FieldValue.serverTimestamp(),
          completedAt: FieldValue.delete(),
        }),
      ),
    )
    console.log('repairCampaignStatusTx 結果：', result)
    if (result.outcome === 'eligible') {
      console.log(`完成，status 已從 ${result.currentStatus} 修正為 ${result.authoritativeStatus}。`)
    } else if (result.outcome === 'already-consistent') {
      console.log('重新驗證時發現狀態已經一致（可能是重複執行，或另一個流程已經處理過），沒有寫入任何東西，屬於安全的 no-op。')
    } else {
      console.error(`拒絕修復（重新驗證時發現不再合格）：${result.reason}`)
      process.exitCode = 1
    }
  }
}

// round 17 新增（Finding 2）：direct-execution guard——只有這支檔案被當成
// 程式進入點直接執行時才會呼叫 main()。被其他模組 import 時（例如測試想
// 拿 parseArgs）絕對不會執行到這裡，也絕對不會連帶啟動
// audit-campaign-drain.mjs 的 main()（因為已經不再 import 那支檔案本身）。
if (isDirectExecution(import.meta.url)) {
  main().catch((err) => {
    console.error('執行失敗：', err)
    process.exitCode = 2
  })
}
