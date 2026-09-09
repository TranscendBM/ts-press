import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing'
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest'
import {
  deleteObject,
  getMetadata,
  ref,
  uploadBytes,
  type FirebaseStorage,
} from 'firebase/storage'
import { doc, setDoc } from 'firebase/firestore'

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
 *
 * storage.rules 現在會用 firestore.get() 讀 (default) Firestore 資料庫的
 * users／settings/permissions，所以這裡要同時啟動 firestore 與 storage
 * 兩個模擬器、共用同一個 projectId，測試前用 withSecurityRulesDisabled()
 * 把白名單與權限矩陣資料寫進 Firestore，Storage 規則才讀得到。
 *
 * ⚠️ 這個 projectId 必須跟 package.json 的 `test:rules` 腳本裡
 * `firebase emulators:exec --project <id>` 的 <id> 完全一致 —— 實測發現
 * Storage 模擬器的 firestore.get() 跨服務呼叫，是解析到「啟動整個模擬器
 * session 時的 --project」那個專案的 Firestore 資料，而不是這個檔案自己
 * 呼叫 initializeTestEnvironment() 時宣告的 projectId（這點跟 Firestore
 * 規則測試本身可以每個 describe 各自用不同 projectId、互不影響完全不同，
 * 純 Firestore 操作沒有這個限制，只有 Storage→Firestore 的跨服務讀取有）。
 * 兩邊不一致的話，Storage 規則會讀到一個沒有任何白名單資料的空專案，
 * 所有寫入都會被 fail closed 擋成 unauthorized，看起來像規則寫錯，
 * 其實是專案 ID 對不上。
 */
const PROJECT_ID = 'ts-press-rules-ci'
const FIRESTORE_HOST = '127.0.0.1'
const FIRESTORE_PORT = 8080
const STORAGE_HOST = '127.0.0.1'
const STORAGE_PORT = 9199

describe('storage.rules（即時套用 Firestore 的 editPress／admin 權限）', () => {
  let env: RulesTestEnvironment

  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
  const meta = { contentType: 'image/png' }

  beforeAll(async () => {
    env = await initializeTestEnvironment({
      projectId: PROJECT_ID,
      firestore: {
        rules: readFileSync('firestore.rules', 'utf8'),
        host: FIRESTORE_HOST,
        port: FIRESTORE_PORT,
      },
      storage: {
        rules: readFileSync('storage.rules', 'utf8'),
        host: STORAGE_HOST,
        port: STORAGE_PORT,
      },
    })
  })

  afterAll(async () => env?.cleanup())

  // 每個案例都從乾淨的白名單開始
  beforeEach(async () => {
    await env.clearFirestore()
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore()
      await setDoc(doc(db, 'users', 'admin@x.com'), {
        email: 'admin@x.com',
        role: 'admin',
        active: true,
      })
      await setDoc(doc(db, 'users', 'spec@x.com'), {
        email: 'spec@x.com',
        role: 'specialist',
        active: true,
      })
      await setDoc(doc(db, 'users', 'inactive@x.com'), {
        email: 'inactive@x.com',
        role: 'specialist',
        active: false,
      })
      await setDoc(doc(db, 'users', 'badtype@x.com'), {
        // role 型別錯誤，模擬資料損毀
        email: 'badtype@x.com',
        role: 123,
        active: true,
      })
    })
  })

  function storageAs(email: string, verified = true): FirebaseStorage {
    return env
      .authenticatedContext(email, { email, email_verified: verified })
      .storage()
  }
  const outsiderStorage = () =>
    env
      .authenticatedContext('nobody-uid', {
        email: 'nobody@x.com',
        email_verified: true,
      })
      .storage()
  const anonStorage = () => env.unauthenticatedContext().storage()

  async function setOverrides(roles: Record<string, unknown>) {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'settings', 'permissions'), { roles })
    })
  }

  async function seedFileBypassingRules(path: string) {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await uploadBytes(ref(ctx.storage(), path), png, meta)
    })
  }

  describe('新聞稿附件與 hero 圖片（依即時 editPress 權限）', () => {
    const attachPath = 'press/p1/attachments/a.png'
    const heroPath = 'press/p1/hero/a.png'

    it('admin（預設 editPress=true）可以上傳、覆寫、刪除', async () => {
      await assertSucceeds(uploadBytes(ref(storageAs('admin@x.com'), attachPath), png, meta))
      await assertSucceeds(uploadBytes(ref(storageAs('admin@x.com'), attachPath), png, meta)) // 覆寫
      await assertSucceeds(deleteObject(ref(storageAs('admin@x.com'), attachPath)))
    })

    it('specialist（預設 editPress=true）可以上傳、覆寫、刪除 hero 圖片', async () => {
      await assertSucceeds(uploadBytes(ref(storageAs('spec@x.com'), heroPath), png, meta))
      await assertSucceeds(uploadBytes(ref(storageAs('spec@x.com'), heroPath), png, meta))
      await assertSucceeds(deleteObject(ref(storageAs('spec@x.com'), heroPath)))
    })

    it('editPress=false 時，即使帳號仍在白名單，上傳／覆寫／刪除全部拒絕', async () => {
      await setOverrides({ specialist: { editPress: false } })
      await assertFails(uploadBytes(ref(storageAs('spec@x.com'), attachPath), png, meta))
      await seedFileBypassingRules(attachPath)
      await assertFails(uploadBytes(ref(storageAs('spec@x.com'), attachPath), png, meta)) // 覆寫
      await assertFails(deleteObject(ref(storageAs('spec@x.com'), attachPath)))
    })

    it('權限撤銷後立即拒絕，不必等重新登入或 token 刷新', async () => {
      // 一開始有權限
      await assertSucceeds(uploadBytes(ref(storageAs('spec@x.com'), attachPath), png, meta))
      // 管理員即時撤銷（同一個 authenticatedContext，模擬同一個舊 token 繼續用）
      await setOverrides({ specialist: { editPress: false } })
      await assertFails(uploadBytes(ref(storageAs('spec@x.com'), attachPath), png, meta))
    })

    it('有 editPress 仍要符合檔案型別／大小限制', async () => {
      await assertFails(
        uploadBytes(ref(storageAs('admin@x.com'), attachPath), png, {
          contentType: 'application/x-msdownload',
        }),
      )
      const big = new Uint8Array(11 * 1024 * 1024)
      await assertFails(uploadBytes(ref(storageAs('admin@x.com'), attachPath), big, meta))
    })

    it('無登入一律拒絕', async () => {
      await assertFails(uploadBytes(ref(anonStorage(), attachPath), png, meta))
    })

    it('信箱未驗證一律拒絕', async () => {
      await assertFails(
        uploadBytes(ref(storageAs('spec@x.com', false), attachPath), png, meta),
      )
    })

    it('不在白名單（沒有 users 文件）一律拒絕', async () => {
      await assertFails(uploadBytes(ref(outsiderStorage(), attachPath), png, meta))
    })

    it('帳號 inactive 一律拒絕', async () => {
      await assertFails(uploadBytes(ref(storageAs('inactive@x.com'), attachPath), png, meta))
    })

    it('role 欄位型別錯誤一律拒絕（fail closed）', async () => {
      await assertFails(uploadBytes(ref(storageAs('badtype@x.com'), attachPath), png, meta))
    })

    it('settings/permissions 格式被竄改成畸形時，連 admin 的預設權限都不給（fail closed）', async () => {
      await env.withSecurityRulesDisabled(async (ctx) => {
        await setDoc(doc(ctx.firestore(), 'settings', 'permissions'), {
          roles: 'everything',
        })
      })
      await assertFails(uploadBytes(ref(storageAs('admin@x.com'), attachPath), png, meta))
    })

    it('讀取只要在白名單即可，不需要 editPress', async () => {
      await setOverrides({ specialist: { editPress: false } })
      await seedFileBypassingRules(attachPath)
      await assertSucceeds(getMetadata(ref(storageAs('spec@x.com'), attachPath)))
    })
  })

  describe('branding（維持 admin-only）', () => {
    const path = 'branding/logo.png'

    it('admin 可以建立與刪除', async () => {
      await assertSucceeds(uploadBytes(ref(storageAs('admin@x.com'), path), png, meta))
      await assertSucceeds(deleteObject(ref(storageAs('admin@x.com'), path)))
    })

    it('specialist 不能建立，即使 editPress=true', async () => {
      await assertFails(uploadBytes(ref(storageAs('spec@x.com'), path), png, meta))
    })

    it('specialist 不能刪除', async () => {
      await seedFileBypassingRules(path)
      await assertFails(deleteObject(ref(storageAs('spec@x.com'), path)))
    })

    it('specialist 仍可讀取（介面要顯示 logo）', async () => {
      await seedFileBypassingRules(path)
      await assertSucceeds(getMetadata(ref(storageAs('spec@x.com'), path)))
    })

    it('未登入不能建立', async () => {
      await assertFails(uploadBytes(ref(anonStorage(), path), png, meta))
    })
  })

  describe('未定義的路徑', () => {
    it('一律拒絕', async () => {
      await assertFails(
        uploadBytes(ref(storageAs('admin@x.com'), 'random/other.png'), png, meta),
      )
    })
  })
})
