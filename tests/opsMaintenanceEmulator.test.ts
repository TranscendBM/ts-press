import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createEmulatorFirestoreApp,
  deleteEmulatorFirestoreApp,
  FieldValue,
} from '../functions/scripts/emulator-test-support.mjs'
import { runMaintenanceCliWrite } from '../functions/scripts/ops-maintenance.mjs'
import {
  classifyMaintenanceFlagShape,
  decideMaintenanceCliWrite,
  MAINTENANCE_DOC_PATH,
  MAINTENANCE_PAUSED_FIELD,
} from '../shared/maintenance'

/**
 * round 28 新增：`ops-maintenance.mjs` 的 `runMaintenanceCliWrite()`——
 * main() 實際呼叫的同一份 transaction 邏輯——用真實 Firestore emulator
 * 驗證，跟 tests/campaignStatusRepairEmulator.test.ts 同一種取捨：不呼叫
 * main()（那需要先通過 verifyBuildFreshness()、動態載入編譯產物、處理
 * --project 等參數驗證），改成直接呼叫 main() 用的同一個工廠函式，這是
 * 「跟 production 100% 相同的程式碼」，不是重新刻一份「看起來很像」的
 * transaction 邏輯。
 *
 * 「零寫入」的驗證方式跟 campaignStatusRepairEmulator.test.ts 一致：比對
 * 呼叫前後的文件快照（`updateTime`／內容）是否完全相同，而不是只信任
 * 程式碼邏輯本身。
 *
 * 只連線本機 Firestore emulator（127.0.0.1:8080），project id 一律用假的
 * `ts-press-*-test`，不是正式的 `ts-press`——見
 * functions/scripts/emulator-test-support.mjs 的說明與防呆。
 */
const HOST = '127.0.0.1'
const PORT = 8080

beforeAll(() => {
  process.env.FIRESTORE_EMULATOR_HOST = `${HOST}:${PORT}`
})

function deps() {
  return { classifyMaintenanceFlagShape, decideMaintenanceCliWrite, MAINTENANCE_PAUSED_FIELD, FieldValue }
}

describe('ops-maintenance.mjs runMaintenanceCliWrite（真實 Firestore emulator）', () => {
  let app: unknown
  let db: FirebaseFirestore.Firestore

  beforeAll(() => {
    ;({ app, db } = createEmulatorFirestoreApp('ts-press-ops-maintenance-test'))
  })
  afterAll(async () => deleteEmulatorFirestoreApp(app))

  it('enable：文件原本不存在 → 建立文件，campaignOperationsPaused:true，帶 updatedAt timestamp', async () => {
    const docRef = db.doc(`${MAINTENANCE_DOC_PATH}-enable-missing`)
    const before = await docRef.get()
    expect(before.exists).toBe(false)

    const result = await runMaintenanceCliWrite(db, docRef, 'enable', deps())
    expect(result.shape).toBe('missing')
    expect(result.decision).toEqual({ outcome: 'write', nextPaused: true })

    const after = await docRef.get()
    expect(after.exists).toBe(true)
    expect(after.data()?.[MAINTENANCE_PAUSED_FIELD]).toBe(true)
    expect(after.data()?.updatedAt).toBeDefined()
  })

  it('enable：已經是 true → noop，零寫入（updateTime 呼叫前後完全相同）', async () => {
    const docRef = db.doc(`${MAINTENANCE_DOC_PATH}-enable-already-true`)
    await docRef.set({ [MAINTENANCE_PAUSED_FIELD]: true })
    const before = await docRef.get()

    const result = await runMaintenanceCliWrite(db, docRef, 'enable', deps())
    expect(result.decision).toEqual({ outcome: 'noop', currentPaused: true })

    const after = await docRef.get()
    expect(after.updateTime.isEqual(before.updateTime)).toBe(true)
    expect(after.data()).toEqual(before.data())
  })

  it('disable：文件原本不存在（missing 視同 false）→ noop，零寫入', async () => {
    const docRef = db.doc(`${MAINTENANCE_DOC_PATH}-disable-missing`)
    const before = await docRef.get()
    expect(before.exists).toBe(false)

    const result = await runMaintenanceCliWrite(db, docRef, 'disable', deps())
    expect(result.decision).toEqual({ outcome: 'noop', currentPaused: false })

    const after = await docRef.get()
    expect(after.exists).toBe(false)
  })

  it('disable：目前是 true → 寫入 campaignOperationsPaused:false，帶 updatedAt', async () => {
    const docRef = db.doc(`${MAINTENANCE_DOC_PATH}-disable-from-true`)
    await docRef.set({ [MAINTENANCE_PAUSED_FIELD]: true, unrelatedField: 'kept' })

    const result = await runMaintenanceCliWrite(db, docRef, 'disable', deps())
    expect(result.decision).toEqual({ outcome: 'write', nextPaused: false })

    const after = await docRef.get()
    expect(after.data()?.[MAINTENANCE_PAUSED_FIELD]).toBe(false)
    expect(after.data()?.updatedAt).toBeDefined()
    // merge:true 寫入，不相關的既有欄位應該維持不變。
    expect(after.data()?.unrelatedField).toBe('kept')
  })

  it('disable：已經是 false → noop，零寫入', async () => {
    const docRef = db.doc(`${MAINTENANCE_DOC_PATH}-disable-already-false`)
    await docRef.set({ [MAINTENANCE_PAUSED_FIELD]: false })
    const before = await docRef.get()

    const result = await runMaintenanceCliWrite(db, docRef, 'disable', deps())
    expect(result.decision).toEqual({ outcome: 'noop', currentPaused: false })

    const after = await docRef.get()
    expect(after.updateTime.isEqual(before.updateTime)).toBe(true)
  })

  it('malformed 既有值（例如字串 "yes"）→ enable 拒絕，零寫入（updateTime 不變）', async () => {
    const docRef = db.doc(`${MAINTENANCE_DOC_PATH}-malformed-enable`)
    await docRef.set({ [MAINTENANCE_PAUSED_FIELD]: 'yes' })
    const before = await docRef.get()

    const result = await runMaintenanceCliWrite(db, docRef, 'enable', deps())
    expect(result.shape).toBe('malformed')
    expect(result.decision).toEqual({ outcome: 'malformed-refuse' })

    const after = await docRef.get()
    expect(after.updateTime.isEqual(before.updateTime)).toBe(true)
    expect(after.data()?.[MAINTENANCE_PAUSED_FIELD]).toBe('yes')
  })

  it('malformed 既有值（例如字串 "yes"）→ disable 同樣拒絕，零寫入', async () => {
    const docRef = db.doc(`${MAINTENANCE_DOC_PATH}-malformed-disable`)
    await docRef.set({ [MAINTENANCE_PAUSED_FIELD]: 'yes' })
    const before = await docRef.get()

    const result = await runMaintenanceCliWrite(db, docRef, 'disable', deps())
    expect(result.decision).toEqual({ outcome: 'malformed-refuse' })

    const after = await docRef.get()
    expect(after.updateTime.isEqual(before.updateTime)).toBe(true)
  })

  it('malformed 既有值（數字）同樣拒絕，零寫入——main() 據此把 process.exitCode 設成 1（見 ops-maintenance.mjs 的 malformed-refuse 分支，這裡只驗證 decision 本身）', async () => {
    const docRef = db.doc(`${MAINTENANCE_DOC_PATH}-malformed-number`)
    await docRef.set({ [MAINTENANCE_PAUSED_FIELD]: 1 })
    const before = await docRef.get()

    const result = await runMaintenanceCliWrite(db, docRef, 'enable', deps())
    expect(result.decision.outcome).toBe('malformed-refuse')

    const after = await docRef.get()
    expect(after.updateTime.isEqual(before.updateTime)).toBe(true)
  })
})
