import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    // functions 與前端共用同一份設定，兩邊的純邏輯都在這裡驗證
    include: ['tests/**/*.test.ts'],
  },
})
