import { defineConfig } from 'vitest/config'

/**
 * 需要真正連上 Firebase 模擬器的測試：Firestore／Storage 規則，以及
 * 依賴 Firestore transaction 語意的併發整合測試。
 *
 * 一律透過 `npm run test:rules` 執行（用 `firebase emulators:exec` 包住），
 * 不要直接跑 `vitest run --config vitest.rules.config.ts` —— 模擬器沒啟動時
 * 會直接連線失敗，測試結果是「失敗」而不是「悄悄跳過」，這是刻意的：
 * CI 或本機忘記啟動模擬器時，這裡要紅燈，不能被誤判成通過。
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'tests/firestoreRules.test.ts',
      'tests/storageRules.test.ts',
      'tests/campaignConcurrency.test.ts',
      'tests/cleanupQueueConcurrency.test.ts',
      // round 25 新增：audit-campaign-drain.mjs／ops-campaign-repair.mjs 的
      // DocumentReference.select() bug 修正——用真實 Firestore emulator
      // 驗證，需要 firebase-admin（只裝在 functions/node_modules，見
      // functions/scripts/emulator-test-support.mjs 的說明），必須跟其他
      // 這裡的檔案一樣透過 `npm run test:rules` 執行。
      'tests/campaignFieldMaskEmulator.test.ts',
      // round 26 新增：--action repair-status（decideCampaignStatusRepair／
      // repairCampaignStatusTx）的真實 Firestore transaction 整合測試，
      // 同樣需要 firebase-admin，同樣的理由必須透過 `npm run test:rules` 執行。
      'tests/campaignStatusRepairEmulator.test.ts',
      // round 28 新增：system/runtime 維護旗標——Admin SDK 讀寫繞過規則的
      // 具體示範、ops-maintenance.mjs 的 transaction 行為、六個受管制
      // callable 的維護模式攔截，皆需要真正的 Firestore emulator，同樣的
      // 理由必須透過 `npm run test:rules` 執行。
      'tests/systemRuntimeAdminEmulator.test.ts',
      'tests/opsMaintenanceEmulator.test.ts',
      'tests/maintenanceCallableGate.test.ts',
      // round 29 新增：sendSelfTestEmail callable——冷卻 transaction 需要
      // 真正的 Firestore emulator，同樣的理由必須透過 `npm run test:rules` 執行
      // （SMTP／Secret Manager 全程 mock，見該檔案開頭的說明，不會有任何
      // 真正的網路呼叫）。
      'tests/sendSelfTestEmailCallable.test.ts',
    ],
    // 這幾個檔案各自對本機模擬器呼叫 initializeTestEnvironment() 部署自己
    // 的一套 Storage 規則。Storage 模擬器（不像 Firestore）在多個測試檔
    // 並行部署規則時觀察到會互相干擾（其中一個檔案的規則暫時蓋掉另一個），
    // 導致本來該過的案例出現 storage/unauthorized。強制檔案之間循序執行
    // 可以避開這個模擬器本身的競態，不影響測試內容的正確性。
    fileParallelism: false,
    server: {
      deps: {
        // round 26：跟 vitest.config.ts 同一個理由與同一份設定，實測必要——
        // 見該檔案裡這個設定完整的說明。
        external: [/functions[\\/]scripts[\\/]/],
      },
    },
  },
})
