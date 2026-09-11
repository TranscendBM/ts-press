/**
 * round 25 新增：純測試用的 Admin SDK／Firestore emulator 連線 helper——只給
 * `tests/` 底下的 emulator 整合測試（`npm run test:rules`）使用，不被
 * audit-campaign-drain.mjs／ops-campaign-repair.mjs 這兩支正式 CLI import，
 * 也不出現在任何正式的執行路徑上。
 *
 * ⚠️ 為什麼需要這個檔案：`firebase-admin` 只安裝在 functions/node_modules
 * （root 的 package.json 沒有這個 dependency，這是刻意的——正式的 web
 * app／根目錄工具不需要 Admin SDK）。root 底下的 tests/*.test.ts 如果直接
 * `import 'firebase-admin/...'`，Node 的 ESM bare specifier 解析會從
 * tests/ 往上找 node_modules，找不到會直接失敗。這支檔案實體放在
 * functions/scripts/ 底下，解析 bare specifier 時是以「發起 import 的
 * 檔案本身的路徑」往上找 node_modules，所以這裡 import 'firebase-admin/...'
 * 會正確解析到 functions/node_modules/firebase-admin——測試用的是跟
 * audit-campaign-drain.mjs／ops-campaign-repair.mjs 完全同一套 Admin SDK，
 * 不是另外裝一份可能版本不同的複本。
 *
 * ⚠️ 只連線本機 Firestore emulator：呼叫端必須先設定好
 * `FIRESTORE_EMULATOR_HOST` 環境變數（例如 `127.0.0.1:8080`，跟
 * firebase.json 裡 firestore emulator 的 port 一致）才呼叫
 * `createEmulatorFirestoreApp()`——這支函式本身不會替你設定這個環境變數，
 * 也不會用任何隱含的憑證或專案 ID，確保不可能不小心連到正式的 Firestore。
 * `projectId` 一律由呼叫端明確傳入，且不得是正式專案 id `ts-press`。
 */
import { deleteApp, initializeApp } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'

// round 26 新增：FieldValue／Timestamp 跟 FieldPath 一樣，都是測試需要組出
// 跟 production 相同的寫入內容（serverTimestamp()／delete()／
// Timestamp.fromMillis()）時才需要的 Admin SDK 匯出——原因跟上面說明
// FieldPath 時完全一樣：只有從這個檔案（實體放在 functions/scripts/ 底下）
// re-export，root 的 tests/*.test.ts 才能正確解析到
// functions/node_modules/firebase-admin，不必另外裝一份可能版本不同的複本。
export { FieldPath, FieldValue, Timestamp } from 'firebase-admin/firestore'

let appCounter = 0

/**
 * @param {string} projectId 不得是正式專案 id（`ts-press`）——僅供 emulator 測試使用的假 id。
 * @returns {{app: import('firebase-admin/app').App, db: FirebaseFirestore.Firestore}}
 */
export function createEmulatorFirestoreApp(projectId) {
  if (!process.env.FIRESTORE_EMULATOR_HOST) {
    throw new Error(
      'createEmulatorFirestoreApp: FIRESTORE_EMULATOR_HOST 尚未設定——呼叫端必須先指定本機 ' +
        'Firestore emulator 的位址，這支 helper 拒絕在沒有明確指向 emulator 的情況下初始化 Admin SDK，' +
        '避免不小心連到正式的 Firestore。',
    )
  }
  if (projectId === 'ts-press') {
    throw new Error('createEmulatorFirestoreApp: 不允許使用正式專案 id "ts-press"，請用假的測試 project id。')
  }
  appCounter += 1
  const app = initializeApp({ projectId }, `emulator-test-app-${projectId}-${appCounter}`)
  const db = getFirestore(app)
  return { app, db }
}

export async function deleteEmulatorFirestoreApp(app) {
  if (app) await deleteApp(app)
}
