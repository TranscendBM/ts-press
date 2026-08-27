import { defineConfig } from 'vitest/config'

/**
 * Firestore／Storage 規則測試，需要真正連上 Firebase 模擬器。
 *
 * 一律透過 `npm run test:rules` 執行（用 `firebase emulators:exec` 包住），
 * 不要直接跑 `vitest run --config vitest.rules.config.ts` —— 模擬器沒啟動時
 * 會直接連線失敗，測試結果是「失敗」而不是「悄悄跳過」，這是刻意的：
 * CI 或本機忘記啟動模擬器時，這裡要紅燈，不能被誤判成通過。
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/firestoreRules.test.ts', 'tests/storageRules.test.ts'],
  },
})
