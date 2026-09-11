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
    ],
  },
})
