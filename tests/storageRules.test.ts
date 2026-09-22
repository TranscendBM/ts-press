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
 * round 33 修正（緊急）：storage.rules 不再用 firestore.get() 跨服務讀
 * Firestore，改成只讀 request.auth.token 裡的 custom claims
 * （pressCenter／role，由 functions/src/index.ts 的 syncUserClaims／
 * onUserCreated／applyClaim() 維護）——見 storage.rules 檔案開頭的完整
 * 說明。這裡的 authenticatedContext() 第二個參數就是在模擬「使用者目前
 * 的 ID token 帶著哪些 claims」，不需要、也不應該再另外 seed Firestore
 * 的 users 文件才能讓 Storage 規則放行。
 *
 * Firestore 模擬器仍然一併啟動——一來 test:rules 這個 npm script本來就會
 * 同時起 firestore／storage 兩個模擬器（其他測試檔案要用），二來這裡
 * 還留了一個測試專門證明「settings/permissions 的覆寫矩陣不會影響
 * Storage 端判斷」這個刻意接受的已知取捨，需要能寫一份 Firestore 文件
 * 來對照。
 */
const PROJECT_ID = 'ts-press-rules-ci'
const FIRESTORE_HOST = '127.0.0.1'
const FIRESTORE_PORT = 8080
const STORAGE_HOST = '127.0.0.1'
const STORAGE_PORT = 9199

describe('storage.rules（改用 custom claims：pressCenter／role，不再跨服務讀 Firestore）', () => {
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

  /** claims 直接對應使用者目前的 ID token 內容，不再需要 Firestore 白名單文件。 */
  function storageAsClaims(
    email: string,
    claims: {
      email_verified?: boolean
      pressCenter?: boolean
      role?: unknown
    } = {},
  ): FirebaseStorage {
    return env
      .authenticatedContext(email, {
        email,
        email_verified: claims.email_verified ?? true,
        ...(claims.pressCenter !== undefined ? { pressCenter: claims.pressCenter } : {}),
        ...(claims.role !== undefined ? { role: claims.role } : {}),
      })
      .storage()
  }

  const storageAsAdmin = () =>
    storageAsClaims('admin@x.com', { pressCenter: true, role: 'admin' })
  const storageAsSpecialist = () =>
    storageAsClaims('spec@x.com', { pressCenter: true, role: 'specialist' })
  const storageAsManager = () =>
    storageAsClaims('manager@x.com', { pressCenter: true, role: 'manager' })

  const anonStorage = () => env.unauthenticatedContext().storage()

  async function seedFileBypassingRules(path: string) {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await uploadBytes(ref(ctx.storage(), path), png, meta)
    })
  }

  describe('新聞稿附件與 hero 圖片（依 pressCenter／role claims 判斷）', () => {
    const attachPath = 'press/p1/attachments/a.png'
    const heroPath = 'press/p1/hero/a.png'

    it('admin（pressCenter=true, role=admin）可以上傳、覆寫、刪除附件', async () => {
      await assertSucceeds(uploadBytes(ref(storageAsAdmin(), attachPath), png, meta))
      await assertSucceeds(uploadBytes(ref(storageAsAdmin(), attachPath), png, meta)) // 覆寫
      await assertSucceeds(deleteObject(ref(storageAsAdmin(), attachPath)))
    })

    it('specialist（pressCenter=true, role=specialist）可以上傳、覆寫、刪除 hero 圖片', async () => {
      await assertSucceeds(uploadBytes(ref(storageAsSpecialist(), heroPath), png, meta))
      await assertSucceeds(uploadBytes(ref(storageAsSpecialist(), heroPath), png, meta))
      await assertSucceeds(deleteObject(ref(storageAsSpecialist(), heroPath)))
    })

    it('manager（pressCenter=true, role=manager）可以上傳 hero 圖片', async () => {
      await assertSucceeds(uploadBytes(ref(storageAsManager(), heroPath), png, meta))
    })

    it('pressCenter 不是 true（缺失／false／型別錯誤）一律拒絕，即使 role 是合法角色', async () => {
      await assertFails(
        uploadBytes(ref(storageAsClaims('nopc@x.com', { role: 'admin' }), attachPath), png, meta),
      )
      await assertFails(
        uploadBytes(
          ref(storageAsClaims('falsepc@x.com', { pressCenter: false, role: 'admin' }), attachPath),
          png,
          meta,
        ),
      )
    })

    it('role claim 缺失或不是三個已知角色之一，fail closed 拒絕，即使 pressCenter=true', async () => {
      await assertFails(
        uploadBytes(
          ref(storageAsClaims('norole@x.com', { pressCenter: true }), attachPath),
          png,
          meta,
        ),
      )
      await assertFails(
        uploadBytes(
          ref(
            storageAsClaims('badrole@x.com', { pressCenter: true, role: 'superuser' }),
            attachPath,
          ),
          png,
          meta,
        ),
      )
    })

    it('舊代號 editor 視為 specialist，仍可上傳', async () => {
      await assertSucceeds(
        uploadBytes(
          ref(storageAsClaims('legacy@x.com', { pressCenter: true, role: 'editor' }), heroPath),
          png,
          meta,
        ),
      )
    })

    it('settings/permissions 的角色權限覆寫矩陣不影響 Storage 端判斷（已知取捨，claims 只帶 role，不帶覆寫後矩陣）', async () => {
      // 即使 Firestore 明確把 specialist 的 editPress 關掉，Storage 端
      // 完全不會讀到這份文件——見 storage.rules 開頭的【已知取捨】第 2 點。
      await env.withSecurityRulesDisabled(async (ctx) => {
        await setDoc(doc(ctx.firestore(), 'settings', 'permissions'), {
          roles: { specialist: { editPress: false } },
        })
      })
      await assertSucceeds(uploadBytes(ref(storageAsSpecialist(), attachPath), png, meta))
    })

    it('有 pressCenter／role 仍要符合檔案型別／大小限制', async () => {
      await assertFails(
        uploadBytes(ref(storageAsAdmin(), attachPath), png, {
          contentType: 'application/x-msdownload',
        }),
      )
      const big = new Uint8Array(11 * 1024 * 1024)
      await assertFails(uploadBytes(ref(storageAsAdmin(), attachPath), big, meta))
    })

    it('無登入一律拒絕', async () => {
      await assertFails(uploadBytes(ref(anonStorage(), attachPath), png, meta))
    })

    it('信箱未驗證一律拒絕，即使 pressCenter=true', async () => {
      await assertFails(
        uploadBytes(
          ref(
            storageAsClaims('unverified@x.com', {
              email_verified: false,
              pressCenter: true,
              role: 'specialist',
            }),
            attachPath,
          ),
          png,
          meta,
        ),
      )
    })

    it('讀取只要 pressCenter=true 即可，不需要 role 具備 editPress（甚至不需要合法 role）', async () => {
      await seedFileBypassingRules(attachPath)
      await assertSucceeds(
        getMetadata(ref(storageAsClaims('readonly@x.com', { pressCenter: true }), attachPath)),
      )
    })

    it('讀取沒有 pressCenter 仍然拒絕', async () => {
      await seedFileBypassingRules(attachPath)
      await assertFails(
        getMetadata(ref(storageAsClaims('nopc2@x.com', {}), attachPath)),
      )
    })
  })

  describe('branding（維持 admin-only）', () => {
    const path = 'branding/logo.png'

    it('admin 可以建立與刪除', async () => {
      await assertSucceeds(uploadBytes(ref(storageAsAdmin(), path), png, meta))
      await assertSucceeds(deleteObject(ref(storageAsAdmin(), path)))
    })

    it('specialist 不能建立，即使 pressCenter=true', async () => {
      await assertFails(uploadBytes(ref(storageAsSpecialist(), path), png, meta))
    })

    it('specialist 不能刪除', async () => {
      await seedFileBypassingRules(path)
      await assertFails(deleteObject(ref(storageAsSpecialist(), path)))
    })

    it('specialist 仍可讀取（介面要顯示 logo）', async () => {
      await seedFileBypassingRules(path)
      await assertSucceeds(getMetadata(ref(storageAsSpecialist(), path)))
    })

    it('未登入不能建立', async () => {
      await assertFails(uploadBytes(ref(anonStorage(), path), png, meta))
    })
  })

  describe('未定義的路徑', () => {
    it('一律拒絕', async () => {
      await assertFails(uploadBytes(ref(storageAsAdmin(), 'random/other.png'), png, meta))
    })
  })
})
