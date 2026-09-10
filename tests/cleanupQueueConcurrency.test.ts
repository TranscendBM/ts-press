import {
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  deleteObject,
  getBytes,
  ref,
  uploadBytes,
  type FirebaseStorage,
} from 'firebase/storage'
import {
  doc,
  getDoc,
  runTransaction,
  setDoc,
  type Firestore,
} from 'firebase/firestore'

/**
 * storageCleanupQueue 處理器的併發整合測試。
 *
 * 沒有直接 import functions/src/index.ts（initializeApp() 的老限制），
 * 這裡用 Firestore／Storage 用戶端 SDK 重現 processStorageCleanupQueue
 * 的核心行為，對著真正的模擬器驗證：
 * 1. 兩個 processor 同時認領同一個佇列項目，只有一個會成功（併發 worker）。
 * 2. 刪除一個已經不存在的檔案，Storage 回的是「找不到」而不是其他錯誤
 *    （404 視為成功的前提）。
 *
 * 一律透過 `npm run test:rules` 執行，需要 Firebase 模擬器（Java）。
 */
const FIRESTORE_HOST = '127.0.0.1'
const FIRESTORE_PORT = 8080
const STORAGE_HOST = '127.0.0.1'
const STORAGE_PORT = 9199
const LEASE_MS = 120_000

describe('storageCleanupQueue processor（併發與 404 處理）', () => {
  let env: RulesTestEnvironment
  let db: Firestore
  let storage: FirebaseStorage

  beforeAll(async () => {
    env = await initializeTestEnvironment({
      projectId: 'ts-press-cleanup-queue-concurrency',
      firestore: {
        rules:
          'rules_version = "2"; service cloud.firestore { match /databases/{d}/documents { match /{document=**} { allow read, write: if true; } } }',
        host: FIRESTORE_HOST,
        port: FIRESTORE_PORT,
      },
      storage: {
        rules:
          'rules_version = "2"; service firebase.storage { match /b/{bucket}/o { match /{allPaths=**} { allow read, write: if true; } } }',
        host: STORAGE_HOST,
        port: STORAGE_PORT,
      },
    })
  })

  afterAll(async () => env?.cleanup())

  beforeEach(async () => {
    await env.clearFirestore()
    db = env.unauthenticatedContext().firestore()
    storage = env.unauthenticatedContext().storage()
  })

  /** 與 functions/src/index.ts 的清理項目認領 transaction 邏輯完全相同的精簡版。 */
  async function tryClaim(itemRef: ReturnType<typeof doc>, attemptId: string) {
    return runTransaction(db, async (tx) => {
      const snap = await tx.get(itemRef)
      if (!snap.exists()) return { claimed: false }
      const data = snap.data()
      const nowMs = Date.now()
      const leaseExpiresAtMs = data.leaseExpiresAtMs ?? 0
      const claimable =
        data.status === 'pending' ||
        (data.status === 'processing' && leaseExpiresAtMs < nowMs)
      if (data.status === 'done' || data.status === 'failed' || !claimable) {
        return { claimed: false }
      }
      tx.update(itemRef, {
        status: 'processing',
        attemptId,
        leaseExpiresAtMs: nowMs + LEASE_MS,
      })
      return { claimed: true }
    })
  }

  it('兩個 processor 同時認領同一個 pending 項目，只有一個成功（避免重複處理同一個孤兒檔案）', async () => {
    const itemRef = doc(db, 'storageCleanupQueue', 'item1')
    await setDoc(itemRef, { status: 'pending', path: 'press/p1/attachments/a.pdf' })

    const [r1, r2] = await Promise.all([
      tryClaim(itemRef, 'worker-A'),
      tryClaim(itemRef, 'worker-B'),
    ])

    const claimedCount = [r1, r2].filter((r) => r.claimed).length
    expect(claimedCount).toBe(1)

    const finalSnap = await getDoc(itemRef)
    expect(['worker-A', 'worker-B']).toContain(finalSnap.data()?.attemptId)
  })

  it('租約未過期的 processing 項目，另一個 processor 無法認領', async () => {
    const itemRef = doc(db, 'storageCleanupQueue', 'item2')
    await setDoc(itemRef, {
      status: 'processing',
      attemptId: 'worker-A',
      leaseExpiresAtMs: Date.now() + LEASE_MS,
      path: 'press/p1/attachments/a.pdf',
    })

    const result = await tryClaim(itemRef, 'worker-B')

    expect(result.claimed).toBe(false)
    const finalSnap = await getDoc(itemRef)
    expect(finalSnap.data()?.attemptId).toBe('worker-A')
  })

  it('租約已過期的 processing 項目可以被接手（上一個 processor 可能已經死掉）', async () => {
    const itemRef = doc(db, 'storageCleanupQueue', 'item3')
    await setDoc(itemRef, {
      status: 'processing',
      attemptId: 'worker-A',
      leaseExpiresAtMs: Date.now() - 1,
      path: 'press/p1/attachments/a.pdf',
    })

    const result = await tryClaim(itemRef, 'worker-B')

    expect(result.claimed).toBe(true)
    const finalSnap = await getDoc(itemRef)
    expect(finalSnap.data()?.attemptId).toBe('worker-B')
  })

  it('刪除已經不存在的檔案會得到明確的「找不到」錯誤，而不是其他種類的失敗', async () => {
    // 這裡用用戶端 SDK 驗證 Storage 對「刪除不存在的物件」的一般行為 ——
    // 用戶端 SDK 的錯誤代碼是字串（'storage/object-not-found'），
    // functions/src/index.ts 實際用的是 Admin SDK（@google-cloud/storage），
    // 錯誤物件帶的是數字代碼 404（GCS Node.js client library 的慣例，
    // 對應 HTTP 404），兩者代碼格式不同、但都是同一件事：物件不存在。
    // 這裡驗證的是「不存在的物件會得到可辨識的『找不到』錯誤」這個前提
    // 成立，而不是逐位元組驗證 Admin SDK 的錯誤格式。
    const path = 'press/p1/attachments/never-existed.pdf'
    let code: string | number | undefined
    try {
      await deleteObject(ref(storage, path))
      throw new Error('預期應該要丟出 object-not-found，但沒有')
    } catch (err) {
      code = (err as { code?: string }).code
    }
    expect(code).toBe('storage/object-not-found')
  })

  it('先上傳再刪除，確認正常刪除流程本身沒問題（對照組）', async () => {
    const path = 'press/p1/attachments/exists.pdf'
    await uploadBytes(ref(storage, path), new Uint8Array([1, 2, 3]))
    await expect(getBytes(ref(storage, path))).resolves.toBeDefined()
    await deleteObject(ref(storage, path))
    await expect(getBytes(ref(storage, path))).rejects.toMatchObject({
      code: 'storage/object-not-found',
    })
  })
})
