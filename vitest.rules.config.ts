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
    ],
    // 這幾個檔案各自對本機模擬器呼叫 initializeTestEnvironment() 部署自己
    // 的一套 Storage 規則。Storage 模擬器（不像 Firestore）在多個測試檔
    // 並行部署規則時觀察到會互相干擾（其中一個檔案的規則暫時蓋掉另一個），
    // 導致本來該過的案例出現 storage/unauthorized。強制檔案之間循序執行
    // 可以避開這個模擬器本身的競態，不影響測試內容的正確性。
    fileParallelism: false,
  },
})
