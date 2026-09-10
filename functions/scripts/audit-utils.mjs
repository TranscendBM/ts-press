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
