import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing'
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, it } from 'vitest'
import {
  deleteObject,
  ref,
  uploadBytes,
  type FirebaseStorage,
} from 'firebase/storage'

/**
 * Storage 安全規則測試。
 *
 * 一律透過 `npm run test:rules` 執行（用 firebase emulators:exec 包住模擬
 * 器，本身需要 Java）。刻意不做「模擬器沒開就 skip」的探測 —— 那樣 CI
 * 忘記啟動模擬器時會被悄悄吞成一片綠燈，看起來像測試通過，實際上什麼都
 * 沒驗證到。模擬器沒連上，initializeTestEnvironment() 會直接拋錯、
 * 整組測試顯示失敗，這才是我們要的行為；一般的單元測試（`npm test` /
 * `npm run test:unit`）已經用獨立的 vitest.config.ts 排除這個檔案，
 * 沒裝 Java 的機器一樣能跑。
 */
const HOST = '127.0.0.1'
const PORT = 9199

describe('storage.rules', () => {
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
