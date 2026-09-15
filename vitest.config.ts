import { defineConfig } from 'vitest/config'

/**
 * 純單元測試：不需要 Firebase 模擬器，任何機器（含沒裝 Java 的）都能跑。
 * Rules 測試需要真正連模擬器，故意獨立成 vitest.rules.config.ts + `npm run
 * test:rules` —— 不能讓「模擬器沒開」被 `npm test` 悄悄吞成一片綠燈。
 */
export default defineConfig({
  test: {
    environment: 'node',
    // functions 與前端共用同一份設定，兩邊的純邏輯都在這裡驗證
    include: ['tests/**/*.test.ts'],
    exclude: [
      'tests/firestoreRules.test.ts',
      'tests/storageRules.test.ts',
      'tests/campaignConcurrency.test.ts',
      'tests/cleanupQueueConcurrency.test.ts',
      // round 25 新增：需要真正的 Firestore emulator，見 vitest.rules.config.ts。
      'tests/campaignFieldMaskEmulator.test.ts',
      // round 26 新增：同上，--action repair-status 的 emulator 整合測試。
      'tests/campaignStatusRepairEmulator.test.ts',
      // round 28 新增：system/runtime 維護旗標的 emulator 整合測試——
      // Admin SDK 讀寫本身、ops-maintenance.mjs 的 transaction、以及六個
      // 受管制 callable 的維護模式攔截，皆需要真正的 Firestore emulator。
      'tests/systemRuntimeAdminEmulator.test.ts',
      'tests/opsMaintenanceEmulator.test.ts',
      'tests/maintenanceCallableGate.test.ts',
      // round 29 新增：sendSelfTestEmail callable 的 emulator 整合測試——
      // 需要真正的 Firestore emulator（冷卻 transaction），見
      // vitest.rules.config.ts。
      'tests/sendSelfTestEmailCallable.test.ts',
    ],
    server: {
      deps: {
        // round 26：實測確認必要——目前這個版本的 Vite／Vitest 對
        // functions/scripts/ 底下這幾支 .mjs CLI（ops-campaign-repair.mjs／
        // audit-campaign-drain.mjs）裡「參數是執行期才算出來、無法靜態
        // 分析」的 `import()`（見各檔案裡
        // `pathToFileURL(compiledClassifierPath).href` 那一行）的 SSR 轉換
        // 目前測試環境需要這個設定：拿掉這行後重跑 `npm run test:unit`，
        // `tests/opsCampaignRepair.test.ts`（會 import ops-campaign-repair.mjs
        // 取得 `parseArgs`）直接 `SyntaxError: Invalid or unexpected token`
        // （939/946 通過，1 個檔案失敗、0 個測試執行——完整錯誤摘要見本輪
        // 報告）。純 Node ESM `import()` 從頭到尾正常運作（`node --check`
        // 通過，直接用 node 執行也正常），只有 Vite 的 SSR 轉換受影響。把
        // 這個目錄底下的檔案標成 externalized，讓 Vitest 直接交給 Node
        // 原生的 ESM loader 處理、完全略過 Vite 的轉換／打包，從根本避開
        // 這個問題——實測比在呼叫點加 `/* @vite-ignore */` pragma 更可靠
        // （後者單獨使用時不足以修好，同樣實測過）。
        external: [/functions[\\/]scripts[\\/]/],
      },
    },
  },
})
