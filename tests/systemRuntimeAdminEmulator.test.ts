import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createEmulatorFirestoreApp,
  deleteEmulatorFirestoreApp,
  FieldValue,
} from '../functions/scripts/emulator-test-support.mjs'
import { MAINTENANCE_DOC_PATH, MAINTENANCE_PAUSED_FIELD } from '../shared/maintenance'

/**
 * round 28 新增：具體示範 Cloud Functions 的 Admin SDK 對 system/runtime
 * 的讀寫完全不受 firestore.rules 裡 `allow read, write: if false` 影響——
 * 這是 Firestore 本身的設計（Admin SDK 走服務帳號信任路徑，完全略過安全
 * 規則引擎），不是這份規則檔案「碰巧沒擋到」。
 *
 * tests/firestoreRules.test.ts 的「firestore.rules — system/runtime」區塊
 * 已經證明「任何 client 角色（含 admin）都讀不到、寫不到」；這裡補上另一半
 * ——用跟 functions/src/index.ts 的 readMaintenanceFlag()／
 * functions/scripts/ops-maintenance.mjs 完全相同的存取方式（Admin SDK
 * Firestore 讀寫），對同一個 emulator 的 system/runtime 做讀寫，證明它們
 * 確實不受任何規則限制——不是拿一份自己另外刻的假設，而是真的連 emulator
 * 驗證。
 *
 * 只連線本機 Firestore emulator（127.0.0.1:8080，跟其他 test:rules 測試檔
 * 一致），project id 用假的 `ts-press-*-test` 測試 id，不是正式的
 * `ts-press`——見 functions/scripts/emulator-test-support.mjs 的說明與
 * 防呆（它會直接拒絕字面上的 `ts-press`）。
 */
const HOST = '127.0.0.1'
const PORT = 8080

beforeAll(() => {
  process.env.FIRESTORE_EMULATOR_HOST = `${HOST}:${PORT}`
})

describe('system/runtime：Admin SDK 讀寫完全不受 firestore.rules 影響（真實 emulator）', () => {
  let app: unknown
  let db: FirebaseFirestore.Firestore

  beforeAll(() => {
    ;({ app, db } = createEmulatorFirestoreApp('ts-press-system-runtime-admin-test'))
  })
  afterAll(async () => deleteEmulatorFirestoreApp(app))

  it('Admin SDK 可以在文件原本不存在時直接 set（.rules 對 client 是 allow write: if false，但這裡走的是完全不同的存取路徑）', async () => {
    const ref = db.doc(MAINTENANCE_DOC_PATH)
    const before = await ref.get()
    expect(before.exists).toBe(false)

    await ref.set({ [MAINTENANCE_PAUSED_FIELD]: true, updatedAt: FieldValue.serverTimestamp() })

    const after = await ref.get()
    expect(after.exists).toBe(true)
    expect(after.data()?.[MAINTENANCE_PAUSED_FIELD]).toBe(true)
  })

  it('Admin SDK 可以正常讀取／更新已存在的文件', async () => {
    const ref = db.doc(MAINTENANCE_DOC_PATH)
    await ref.set({ [MAINTENANCE_PAUSED_FIELD]: true })

    const readBack = await ref.get()
    expect(readBack.data()?.[MAINTENANCE_PAUSED_FIELD]).toBe(true)

    await ref.set({ [MAINTENANCE_PAUSED_FIELD]: false }, { merge: true })
    const afterDisable = await ref.get()
    expect(afterDisable.data()?.[MAINTENANCE_PAUSED_FIELD]).toBe(false)
  })
})
