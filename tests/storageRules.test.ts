import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing'
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  deleteObject,
  ref,
  uploadBytes,
  type FirebaseStorage,
} from 'firebase/storage'

/**
 * Storage 安全規則測試。
 *
 * 需要 Firebase 模擬器（本身需要 Java）。啟動方式：
 *   npx firebase emulators:start --only storage
 * 模擬器沒開時整組跳過，讓一般的單元測試仍能在沒有 Java 的機器上執行。
 */
const HOST = '127.0.0.1'
const PORT = 9199

async function emulatorRunning() {
  try {
    // 只要連得上就代表模擬器在跑 —— Storage 模擬器的根路徑會回 501，
    // 用 status < 500 判斷會把它誤判成沒啟動而整組跳過。
    await fetch(`http://${HOST}:${PORT}/`, {
      signal: AbortSignal.timeout(3000),
    })
    return true
  } catch {
    return false
  }
}

const available = await emulatorRunning()

describe.skipIf(!available)('storage.rules', () => {
  let env: RulesTestEnvironment

  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
  const meta = { contentType: 'image/png' }

  beforeAll(async () => {
    env = await initializeTestEnvironment({
      projectId: 'ts-press-rules-test',
      storage: {
        rules: readFileSync('storage.rules', 'utf8'),
        host: HOST,
        port: PORT,
      },
    })
  })

  afterAll(async () => env?.cleanup())

  /** 已驗證信箱 + 白名單 claim 的一般使用者。 */
  function editor(): FirebaseStorage {
    return env
      .authenticatedContext('editor-uid', {
        email: 'editor@example.com',
        email_verified: true,
        pressCenter: true,
        role: 'editor',
      })
      .storage()
  }

  function admin(): FirebaseStorage {
    return env
      .authenticatedContext('admin-uid', {
        email: 'admin@example.com',
        email_verified: true,
        pressCenter: true,
        role: 'admin',
      })
      .storage()
  }

  /** 登入了但沒有白名單 claim。 */
  function outsider(): FirebaseStorage {
    return env
      .authenticatedContext('nobody-uid', {
        email: 'nobody@example.com',
        email_verified: true,
      })
      .storage()
  }

  describe('press 附件', () => {
    const path = 'press/p1/attachments/a.png'

    it('白名單使用者可以建立', async () => {
      await assertSucceeds(uploadBytes(ref(editor(), path), png, meta))
    })

    it('未授權者不能建立', async () => {
      await assertFails(uploadBytes(ref(outsider(), path), png, meta))
    })

    it('超過單檔上限會被拒絕', async () => {
      const big = new Uint8Array(11 * 1024 * 1024)
      await assertFails(uploadBytes(ref(editor(), path), big, meta))
    })

    it('不允許的 contentType 會被拒絕', async () => {
      await assertFails(
        uploadBytes(ref(editor(), path), png, {
          contentType: 'application/x-msdownload',
        }),
      )
    })

    it('白名單使用者可以刪除（delete 不檢查 request.resource）', async () => {
      await env.withSecurityRulesDisabled(async (ctx) => {
        await uploadBytes(ref(ctx.storage(), path), png, meta)
      })
      await assertSucceeds(deleteObject(ref(editor(), path)))
    })

    it('未授權者不能刪除', async () => {
      await env.withSecurityRulesDisabled(async (ctx) => {
        await uploadBytes(ref(ctx.storage(), path), png, meta)
      })
      await assertFails(deleteObject(ref(outsider(), path)))
    })
  })

  describe('branding', () => {
    const path = 'branding/logo.png'

    it('admin 可以建立與刪除', async () => {
      await assertSucceeds(uploadBytes(ref(admin(), path), png, meta))
      await assertSucceeds(deleteObject(ref(admin(), path)))
    })

    it('editor 不能建立', async () => {
      await assertFails(uploadBytes(ref(editor(), path), png, meta))
    })

    it('editor 不能刪除', async () => {
      await env.withSecurityRulesDisabled(async (ctx) => {
        await uploadBytes(ref(ctx.storage(), path), png, meta)
      })
      await assertFails(deleteObject(ref(editor(), path)))
    })

    it('editor 仍可讀取（介面要顯示 logo）', async () => {
      await env.withSecurityRulesDisabled(async (ctx) => {
        await uploadBytes(ref(ctx.storage(), path), png, meta)
      })
      // 讀取權限透過規則允許；這裡以能取得 metadata 代表通過
      await assertSucceeds(
        import('firebase/storage').then((m) =>
          m.getMetadata(ref(editor(), path)),
        ),
      )
    })
  })

  describe('未定義的路徑', () => {
    it('一律拒絕', async () => {
      await assertFails(
        uploadBytes(ref(editor(), 'random/other.png'), png, meta),
      )
    })
  })
})

// 沒有模擬器時留一筆說明，避免整個檔案看起來沒有任何測試
describe.skipIf(available)('storage.rules（略過）', () => {
  it('需要 Firebase 模擬器，請先執行 npx firebase emulators:start --only storage', () => {
    expect(available).toBe(false)
  })
})
