#!/usr/bin/env node
/**
 * 維運用「活動操作維護模式」開關 CLI（round 28 新增）。
 *
 * 用途：讀取／切換 Firestore 文件 system/runtime 的
 * campaignOperationsPaused 欄位——這是 sendCampaign／retryCampaign／
 * resolveDeliveryUnknown／reconcileCampaignDeliveryStatus／
 * testSmtpConnection／processStorageCleanupQueue 這六個 callable 在通過
 * 既有的權限檢查之後、在做任何其他事情之前都會檢查的旗標（見
 * shared/maintenance.ts 的完整判斷邏輯，以及 functions/src/index.ts 頂部
 * 部署 runbook【正式部署程序】步驟 1(b) 的說明）。這份文件的
 * firestore.rules 對任何 client 角色（含 admin）一律拒絕讀寫，唯一的讀寫
 * 管道是 Cloud Functions 的 Admin SDK——這支 CLI 就是那個管道。
 *
 * ⚠️ 安全設計（跟 ops-campaign-repair.mjs 同一套慣例，見該檔案開頭）：
 * - 必須明確指定 --project，這支腳本不會使用任何預設或隱含的專案 ID。
 * - --action 必須是 status／enable／disable 三者之一，沒有其他模式。
 * - enable／disable 都需要額外的 --confirm <跟 --action 完全相同的值>
 *   才會真的寫入——跟 ops-campaign-repair.mjs 的 --confirm <campaign-id>
 *   同一個理由：避免「多打一個 --confirm」意外把系統切到錯的狀態。
 *   status 不需要、也不接受 --confirm 的驗證（不寫入，本來就安全）。
 * - enable／disable 在單一 Firestore transaction 內做「讀取現在的形狀 →
 *   決定要不要寫、寫什麼」，不相信呼叫前任何已經讀過的舊快照——跟
 *   repair-status 的 TOCTOU 防護同一個理由。
 * - 現在的值如果是 malformed（不是嚴格的 true／false），一律拒絕自動
 *   覆寫，需要人工檢查這份文件（見 shared/maintenance.ts 的
 *   decideMaintenanceCliWrite() 說明）——CLI 不會替維運人員「猜」malformed
 *   的值原本代表 true 還是 false。
 * - 執行前會用 verifyBuildFreshness() 驗證編譯產物是否可能過期，過期就
 *   直接拒絕執行——跟 audit-campaign-drain.mjs／ops-campaign-repair.mjs
 *   同一套防呆，只是這裡驗證的是 shared/maintenance.ts 而不是
 *   shared/campaignSend.ts（見下方 verifyBuildFreshness() 呼叫處）。
 * - 這支檔案被其他模組 import 時（例如測試想拿 parseArgs／validateAction）
 *   絕對不會執行 main()——見檔案最後的 direct-execution guard。
 * - 不會、也不應該自動觸發任何部署或稽核（audit:drain／firebase deploy
 *   等）——切旗標跟部署／稽核是兩個獨立、需要人工依序執行的步驟，見
 *   functions/src/index.ts 頂部 runbook 的完整流程。
 * - 這支腳本結構上不存在任何寄信能力，也不會碰 campaigns／recipients／
 *   storageCleanupQueue 等其他集合——只讀寫 system/runtime 這一份文件。
 *
 * 用法（唯一推薦入口——這個 npm script 會先自動 npm run build 再執行）：
 *   cd functions && npm run ops:maintenance -- --project <id> --action status
 *   cd functions && npm run ops:maintenance -- --project <id> --action enable  --confirm enable
 *   cd functions && npm run ops:maintenance -- --project <id> --action disable --confirm disable
 *
 * exit code：
 *   0 — 執行成功：status 查詢完成、enable/disable 真的寫入、或
 *       enable/disable 發現已經是目標狀態的安全 no-op。
 *   1 — 執行完成，但目前的值是 malformed，拒絕自動覆寫（需要人工檢查）。
 *   2 — 執行本身失敗（缺少或不合法的參數、--confirm 不相符、找不到編譯
 *       輸出、編譯產物可能過期、Firestore 連線失敗……）。
 */
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isDirectExecution, verifyBuildFreshness } from './audit-utils.mjs'

const here = dirname(fileURLToPath(import.meta.url))

// round 28 新增：verifyBuildFreshness() 預設驗證的是 shared/campaignSend.ts
// 那一組路徑（見 audit-utils.mjs 的具名匯出常數）——這支 CLI 依賴的是
// shared/maintenance.ts，所以這裡另外算出自己的三個路徑，透過
// verifyBuildFreshness() 接受的選項覆寫預設值，而不是重新刻一份新鮮度
// 驗證邏輯（新鮮度比對本身跟依賴哪一份 shared 檔案無關，值得共用）。
const maintenanceSharedSourcePath = join(here, '..', '..', 'shared', 'maintenance.ts')
const maintenanceGeneratedSourcePath = join(here, '..', 'src', 'maintenance.generated.ts')
const maintenanceCompiledPath = join(here, '..', 'lib', 'maintenance.generated.js')

const KNOWN_FLAGS = new Set(['--project', '--action', '--confirm'])

/**
 * 跟 ops-campaign-repair.mjs 的 parseArgs() 同一套契約：拒絕未知參數、
 * 每個旗標都要求緊接一個不像旗標的值。回傳 `{ error: string }` 或成功時的
 * `{ project, action, confirm }`（沒出現的旗標對應到 `undefined`）。
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
    else if (flag === '--action') args.action = value
    else if (flag === '--confirm') args.confirm = value
    i += 1
  }
  return args
}

/**
 * round 28 新增：跟 ops-campaign-repair.mjs 的
 * createCampaignStatusRepairLoader() 同一種理由抽出來的工廠函式——把
 * enable／disable 真正的 Firestore transaction 邏輯獨立成模組頂層 export
 * 的函式，main() 呼叫它，不再自己內聯定義一份。這樣 emulator 整合測試
 * （tests/opsMaintenanceEmulator.test.ts）可以直接 import 呼叫「跟
 * production 100% 相同」的這段程式碼，不必在測試檔案裡另外重新刻一份
 * 「看起來很像」的 transaction 邏輯（那樣兩邊一旦漂移，測試綠燈不代表
 * production 是對的）。
 *
 * 在單一 transaction 內：重新讀取（`tx.get`，不相信呼叫前任何已經讀過的
 * 舊快照）→ 分類目前形狀 → 呼叫 decideMaintenanceCliWrite() 決定要不要寫、
 * 寫什麼 → 只有 outcome 是 'write' 時才呼叫 `tx.set`。'noop' 與
 * 'malformed-refuse' 都結構上不會呼叫 `tx.set`，不是「呼叫了但被忽略」。
 *
 * @param {FirebaseFirestore.Firestore} db
 * @param {FirebaseFirestore.DocumentReference} docRef
 * @param {'enable'|'disable'} action
 * @param {{classifyMaintenanceFlagShape: Function, decideMaintenanceCliWrite: Function, MAINTENANCE_PAUSED_FIELD: string, FieldValue: {serverTimestamp(): unknown}}} deps
 */
export async function runMaintenanceCliWrite(db, docRef, action, deps) {
  const { classifyMaintenanceFlagShape, decideMaintenanceCliWrite, MAINTENANCE_PAUSED_FIELD, FieldValue } = deps
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(docRef)
    const rawValue = snap.exists ? snap.data()?.[MAINTENANCE_PAUSED_FIELD] : undefined
    const shape = classifyMaintenanceFlagShape(snap.exists, rawValue)
    const decision = decideMaintenanceCliWrite(shape, action)
    if (decision.outcome === 'write') {
      tx.set(
        docRef,
        { [MAINTENANCE_PAUSED_FIELD]: decision.nextPaused, updatedAt: FieldValue.serverTimestamp() },
        { merge: true },
      )
    }
    // 'noop' 與 'malformed-refuse' 都刻意不呼叫 tx.set——結構上就不可能
    // 在這兩種結果下寫入任何東西，不是「呼叫了但被忽略」。
    return { shape, decision }
  })
}

/**
 * 純函式：驗證 --action 本身是否合法，以及（enable／disable 時）--confirm
 * 是否存在且跟 --action 完全相符。刻意獨立於 main()、不接觸任何
 * Firestore／網路呼叫——單元測試可以直接呼叫這個函式，具體證明「確認
 * 失敗一定會在任何 initializeApp／getFirestore／runTransaction 呼叫之前
 * return」，不必 mock 整個 Admin SDK。
 *
 * 回傳 `{ error: string }` 或 `{ ok: true }`。
 */
export function validateAction(action, confirmValue) {
  if (action !== 'status' && action !== 'enable' && action !== 'disable') {
    return { error: "缺少或不合法的 --action——必須是 'status'、'enable' 或 'disable'。" }
  }
  if (action === 'status') {
    return { ok: true }
  }
  if (confirmValue === undefined) {
    return {
      error:
        `--action ${action} 需要額外帶上 --confirm ${action} 才會真的執行——` +
        '避免忘記加 --confirm 卻誤以為已經切換成功，也避免這個安全機制形同虛設。',
    }
  }
  if (confirmValue !== action) {
    return {
      error:
        `--confirm 的值（${confirmValue}）跟 --action 的值（${action}）不相符——` +
        '為了避免誤操作，--confirm 必須明確帶上跟 --action 完全相同的值。',
    }
  }
  return { ok: true }
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2))
  if (parsed.error) {
    console.error(parsed.error)
    process.exitCode = 2
    return
  }
  const { project, action, confirm } = parsed

  if (!project) {
    console.error('缺少 --project <firebase-project-id>——這支腳本不會使用任何預設專案。')
    process.exitCode = 2
    return
  }

  const validation = validateAction(action, confirm)
  if (validation.error) {
    console.error(validation.error)
    process.exitCode = 2
    return
  }

  const freshness = verifyBuildFreshness({
    sharedSourcePath: maintenanceSharedSourcePath,
    generatedSourcePath: maintenanceGeneratedSourcePath,
    compiledPath: maintenanceCompiledPath,
  })
  if (!freshness.fresh) {
    console.error(`編譯產物無法證明是最新的，拒絕執行：\n${freshness.reason}`)
    process.exitCode = 2
    return
  }

  // Windows 修正：maintenanceCompiledPath 是原始檔案系統路徑（`C:\...`），
  // Node 的 ESM 動態載入要求絕對路徑必須是合法的 file 開頭的 URL，否則
  // 會把 `C:` 誤認成不支援的 URL scheme 而丟出
  // ERR_UNSUPPORTED_ESM_URL_SCHEME——只有這裡（真的要動態載入的那一刻）需要
  // 轉成 file URL，前面 verifyBuildFreshness() 等檔案系統操作仍然用原本的
  // filesystem path，不受影響。pathToFileURL 是 Node 官方 API，正確處理
  // Windows 磁碟機代號、空白、Unicode 等需要跳脫的字元，不要自己手刻字串
  // 拼接或反斜線取代。
  //
  // （這段註解刻意不把「動態載入」跟後面的括號寫在一起、也不用完整的
  // `scheme://` 寫法——Vite 的 SSR 模組轉換用輕量 lexer 掃描 import 語法，
  // 曾經觀察到純文字註解裡出現看起來像動態載入呼叫或完整 URL 的字樣時，
  // 會誤判成真正的語法而讓整個檔案轉譯失敗；這裡只是註解措辭上的迴避，
  // 不影響下面實際程式碼的行為，見 audit-campaign-drain.mjs 同一處的說明。）
  const { classifyMaintenanceFlagShape, decideMaintenanceCliWrite, MAINTENANCE_DOC_PATH, MAINTENANCE_PAUSED_FIELD } =
    await import(pathToFileURL(maintenanceCompiledPath).href)

  const { initializeApp } = await import('firebase-admin/app')
  const { getFirestore, FieldValue } = await import('firebase-admin/firestore')

  initializeApp({ projectId: project })
  const db = getFirestore()
  const docRef = db.doc(MAINTENANCE_DOC_PATH)

  if (action === 'status') {
    const snap = await docRef.get()
    const rawValue = snap.exists ? snap.data()?.[MAINTENANCE_PAUSED_FIELD] : undefined
    const shape = classifyMaintenanceFlagShape(snap.exists, rawValue)
    console.log(`專案 ${project} | ${MAINTENANCE_DOC_PATH} 目前狀態（shape=${shape}）：`)
    if (shape === 'true') {
      console.log('  campaignOperationsPaused = true —— 維護中，六個受管制的 callable 會直接拒絕新請求。')
    } else if (shape === 'false') {
      console.log('  campaignOperationsPaused = false —— 未暫停，六個受管制的 callable 正常運作。')
    } else if (shape === 'missing') {
      console.log('  文件不存在，或欄位缺漏 —— 視同未暫停（fail-open 只發生在「從未設定過」這一種情況）。')
    } else {
      console.log(
        '  ⚠️ malformed —— 欄位存在但不是合法的布林值。六個受管制的 callable 會 fail closed，' +
          '視為維護中而拒絕所有新請求；這支 CLI 的 enable/disable 也會拒絕自動覆寫這個值。' +
          '需要人工檢查這份文件的實際內容後再決定下一步。',
      )
    }
    return
  }

  console.log(
    `專案 ${project} | action=${action} | --confirm 已核對（${confirm}）—— ` +
      '將在單一 transaction 內重新讀取目前狀態，只有仍然合格才會寫入。',
  )

  const result = await runMaintenanceCliWrite(db, docRef, action, {
    classifyMaintenanceFlagShape,
    decideMaintenanceCliWrite,
    MAINTENANCE_PAUSED_FIELD,
    FieldValue,
  })

  if (result.decision.outcome === 'write') {
    console.log(`完成：campaignOperationsPaused 已寫入為 ${result.decision.nextPaused}。`)
  } else if (result.decision.outcome === 'noop') {
    console.log(
      `已經是目標狀態（campaignOperationsPaused = ${result.decision.currentPaused}）—— ` +
        '這次呼叫是安全的 no-op，沒有寫入任何東西。',
    )
  } else {
    console.error(
      '拒絕執行：重新讀取時發現目前的值是 malformed（不是合法的布林值），不會自動覆寫。' +
        '請先人工檢查 system/runtime 這份文件的實際內容，確認應該是 true 還是 false 之後，' +
        '再考慮是否要用其他方式手動修正。',
    )
    process.exitCode = 1
  }
}

// round 28 新增：direct-execution guard——只有這支檔案被當成程式進入點
// 直接執行時才會呼叫 main()。被其他模組 import 時（例如測試想拿
// parseArgs／validateAction）絕對不會執行到這裡，也不會意外連線 Firestore。
if (isDirectExecution(import.meta.url)) {
  main().catch((err) => {
    console.error('執行失敗：', err)
    process.exitCode = 2
  })
}
