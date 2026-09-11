/**
 * round 17 新增（Finding 2）：完全無副作用的共用 utils——`verifyBuildFreshness()`
 * 與相關路徑常數，被 audit-campaign-drain.mjs 與 ops-campaign-repair.mjs
 * 兩支 CLI 共用。
 *
 * ⚠️ 這個檔案唯一的職責就是「被 import」，不能有任何 top-level 的執行
 * 副作用（不呼叫任何 main()、不初始化 Firebase、不印出任何東西、不設定
 * process.exitCode）——round 16 的版本讓 ops-campaign-repair.mjs 為了拿
 * verifyBuildFreshness() 而 `import` audit-campaign-drain.mjs，結果連
 * audit-campaign-drain.mjs 底部無條件執行的 main() 也一起被跑了：
 * ops CLI 執行時，audit 稽核會在背景「順便」對整個專案跑一次，兩支腳本
 * 各自呼叫 initializeApp()，可能互相覆蓋 process.exitCode。抽成這個沒有
 * 任何執行邏輯、只有函式定義與常數的檔案，讓「被 import」在結構上就不可能
 * 產生任何副作用，不必只靠 direct-execution guard 這一道防線。
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

export const sharedSourcePath = join(here, '..', '..', 'shared', 'campaignSend.ts')
export const generatedSourcePath = join(here, '..', 'src', 'campaignSend.generated.ts')
export const compiledClassifierPath = join(here, '..', 'lib', 'campaignSend.generated.js')

/**
 * 在真的 import 編譯產物之前，先盡力證明「這份編譯產物確實反映目前的
 * shared/campaignSend.ts 原始碼」——沒辦法 100% 保證（例如 tsc 有自己的
 * incremental cache 邏輯，這裡只能用 mtime 這種外部可觀察的訊號去逼近），
 * 但至少能擋下最常見、最危險的疏失：改了 shared/campaignSend.ts 之後
 * 忘記重新 build。
 *
 * 回傳 `{ fresh: true }` 或 `{ fresh: false, reason: string }`——呼叫端
 * 看到 `fresh:false` 必須直接 exit code 2，不能嘗試用可能過期的分類邏輯
 * 稽核或修復任何東西。
 */
export function verifyBuildFreshness({
  sharedSourcePath: sharedPath = sharedSourcePath,
  generatedSourcePath: generatedPath = generatedSourcePath,
  compiledPath = compiledClassifierPath,
} = {}) {
  if (!existsSync(sharedPath)) {
    return { fresh: false, reason: `找不到原始碼來源：${sharedPath}` }
  }
  if (!existsSync(generatedPath)) {
    return {
      fresh: false,
      reason:
        `找不到同步後的檔案：${generatedPath}——請先執行 \`npm run build\`` +
        '（會先跑 scripts/sync-shared.mjs 同步 shared/ 底下的原始碼）。',
    }
  }
  if (!existsSync(compiledPath)) {
    return {
      fresh: false,
      reason:
        `找不到編譯後的分類邏輯：${compiledPath}——請先執行 \`npm run build\`` +
        '（tsc 編譯 functions/src 底下的 TypeScript）。',
    }
  }

  // 第一層：sync-shared.mjs 是逐字複製（banner + 原始內容），比對內容本身
  // 而不是 mtime——即使檔案系統的時間戳因為 git checkout／CI 環境而不可信，
  // 內容比對仍然準確。
  const sharedContent = readFileSync(sharedPath, 'utf8')
  const generatedContent = readFileSync(generatedPath, 'utf8')
  if (!generatedContent.endsWith(sharedContent) || sharedContent.length === 0) {
    return {
      fresh: false,
      reason:
        `${generatedPath} 的內容跟 ${sharedPath} 目前的原始碼不一致——` +
        '請先執行 `npm run build`（或至少 `node scripts/sync-shared.mjs`）重新同步，' +
        '否則這次稽核用的分類邏輯可能不是 shared/campaignSend.ts 目前的版本。',
    }
  }

  // 第二層：tsc 編譯輸出的 mtime 必須不早於它的輸入（同步後的 .ts）——
  // 這是盡力而為的訊號，不是完全嚴謹的證明，但足以擋下「改完程式碼、
  // 也跑過 sync-shared.mjs，卻忘記真的執行 tsc」這種情況。
  const generatedMtime = statSync(generatedPath).mtimeMs
  const compiledMtime = statSync(compiledPath).mtimeMs
  if (compiledMtime < generatedMtime) {
    return {
      fresh: false,
      reason:
        `${compiledPath} 的修改時間早於 ${generatedPath}——編譯產物可能是用` +
        '舊版原始碼產生的，請先執行 `npm run build` 重新編譯。',
    }
  }

  return { fresh: true }
}

/**
 * round 17 新增（Finding 2）：可靠的 ESM direct-execution guard——用
 * `fileURLToPath(import.meta.url)` 跟 `process.argv[1]` 比較實際檔案
 * 路徑（不是用 `file://` 字串拼接比較，那在 Windows 路徑分隔符號下不可靠）。
 * 只有「這個檔案被當成程式進入點直接執行」時才是 true；被其他模組
 * `import` 時 `process.argv[1]` 是啟動那支腳本的路徑，不會相符，所以恆為
 * false——確保任何模組只要是「被 import」就絕對不會意外執行自己的
 * main()。
 */
export function isDirectExecution(moduleUrl) {
  return Boolean(process.argv[1]) && fileURLToPath(moduleUrl) === process.argv[1]
}

/**
 * round 25 新增：Firebase Admin SDK 的 `DocumentReference` 沒有 `.select()`
 * ——只有 `Query`／`CollectionReference` 才有。之前 audit-campaign-drain.mjs
 * 的 `readCampaignStabilityFields()` 與 ops-campaign-repair.mjs 的
 * `loadClassification()` 都誤對 `campaigns.doc(id)`（`DocumentReference`）
 * 呼叫 `.select()`，只要真的連線到 Firestore（emulator 或正式環境）就會丟出
 * `TypeError: ... .select is not a function`——先前只用 fake 做單元測試，
 * 從沒真的連過 Firestore，所以這個 bug 一直沒被抓到。
 *
 * 這個 helper 把「用 `FieldPath.documentId()` 查單一文件＋保留欄位遮罩」的
 * 正確寫法（跟這支檔案原本就有、沒有這個 bug 的
 * `readCampaignAndRecipientsAtomic()` 用的是同一招）抽出來，讓
 * audit-campaign-drain.mjs 與 ops-campaign-repair.mjs 呼叫同一份邏輯，不必
 * 各自複製一份查詢寫法（也不會有第三個地方悄悄漂移出另一份 `.doc().select()`
 * 的錯誤用法）。
 *
 * 不是 `DocumentReference.get()`（那樣會下載整份文件，違反 field-mask 想
 * 避免讀到 PII／無關內容的設計）；也不是 `.doc(id).select()`（那是這次要
 * 修的 bug）——而是把 `.doc(id)` 換成「對整個 collection 做一次以文件 ID
 * 精確比對的 Query」，Query 才有 `.select()`。
 *
 * 用文件 ID 精確查詢正常情況下只會得到 0 或 1 筆。如果不明原因查到超過 1
 * 筆（理論上不應該發生），fail closed：直接 throw，不會靜默地只取
 * `docs[0]` 當作沒事發生。
 *
 * 純函式、無副作用——不 import firebase-admin，也不初始化任何東西；
 * `collectionRef`／`FieldPath` 都由呼叫端傳入，這個檔案本身仍然維持「只能
 * 被 import，沒有任何 top-level 執行副作用」的約束。
 *
 * @param {FirebaseFirestore.CollectionReference} collectionRef
 * @param {string} documentId
 * @param {string[]} fields
 * @param {{documentId(): FirebaseFirestore.FieldPath}} FieldPath firebase-admin/firestore 的 FieldPath
 * @returns {Promise<FirebaseFirestore.QueryDocumentSnapshot | null>} 查無此文件回傳 null
 */
export async function getDocumentByIdWithFieldMask(collectionRef, documentId, fields, FieldPath) {
  const querySnap = await collectionRef
    .where(FieldPath.documentId(), '==', documentId)
    .select(...fields)
    .get()
  if (querySnap.empty) return null
  if (querySnap.size > 1) {
    throw new Error(
      `getDocumentByIdWithFieldMask: 用文件 ID 精確查詢卻查到 ${querySnap.size} 筆` +
        `（collection=${collectionRef.path}, documentId=${documentId}）——這不應該發生，` +
        'fail closed，拒絕回傳任何一筆，避免誤用到錯的文件資料。',
    )
  }
  return querySnap.docs[0]
}
