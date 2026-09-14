import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createEmulatorFirestoreApp,
  deleteEmulatorFirestoreApp,
  FieldPath,
} from '../functions/scripts/emulator-test-support.mjs'
import { getDocumentByIdWithFieldMask } from '../functions/scripts/audit-utils.mjs'
import { createDrainAuditDeps, STABILITY_FIELDS } from '../functions/scripts/audit-campaign-drain.mjs'
import { runDrainAuditScan } from '../functions/scripts/audit-scan.mjs'
import {
  createClassificationLoader,
  CAMPAIGN_REPAIR_CLASSIFICATION_FIELDS,
} from '../functions/scripts/ops-campaign-repair.mjs'
import { classifyCampaignForDrainAudit } from '../shared/campaignSend'

/**
 * round 25 新增：修正「Firebase Admin SDK 的 DocumentReference 沒有
 * .select()」這個 bug 的真實 Firestore emulator 整合測試。
 *
 * ⚠️ 背景：audit-campaign-drain.mjs 的 readCampaignStabilityFields()、
 * ops-campaign-repair.mjs 的 loadClassification() 過去都對
 * `campaigns.doc(id)`（DocumentReference）呼叫 `.select()`——只有
 * Query／CollectionReference 才有這個方法，只要真的連線到 Firestore（不是
 * 先前那種只用 fake 物件的單元測試）就會丟出
 * `TypeError: ... .select is not a function`。round 25 把兩處都改成用
 * `FieldPath.documentId()` 的 Query（見 audit-utils.mjs 的
 * getDocumentByIdWithFieldMask()），field mask（要選哪些欄位）完全不變。
 *
 * 這裡刻意不呼叫兩支 CLI 的 main()（那需要先通過 verifyBuildFreshness()、
 * 動態載入 functions/lib 底下的編譯產物、處理 --project 等參數驗證，
 * 詳見本輪報告的取捨說明）——改成呼叫 round 25 抽出來的、main() 實際使用的
 * 同一份工廠函式：
 *   - audit-campaign-drain.mjs 的 createDrainAuditDeps(db, {FieldPath})
 *     （main() 現在也是呼叫這個函式取得 deps，不再自己內聯定義）
 *   - ops-campaign-repair.mjs 的 createClassificationLoader(campaignRef,
 *     {FieldPath, classifyCampaignForDrainAudit})（main() 現在也是呼叫這個
 *     函式取得 loadClassification，不再自己內聯定義）
 * 這是「跟 production 100% 相同的程式碼」，不是在測試檔案裡重新刻一份
 * 「看起來很像」的查詢邏輯。
 *
 * ⚠️ 只連線本機 Firestore emulator（127.0.0.1:8080，跟 firebase.json 與
 * 其他 test:rules 測試檔一致），project id 一律用假的 `ts-press-*` 測試
 * id，不是正式的 `ts-press`——見 functions/scripts/emulator-test-support.mjs
 * 的說明與防呆。
 */
const HOST = '127.0.0.1'
const PORT = 8080

beforeAll(() => {
  process.env.FIRESTORE_EMULATOR_HOST = `${HOST}:${PORT}`
})

describe('round 25 修正：audit-campaign-drain.mjs 的 readCampaignStabilityFields（createDrainAuditDeps，真實 emulator）', () => {
  let app: unknown
  let db: FirebaseFirestore.Firestore

  beforeAll(() => {
    ;({ app, db } = createEmulatorFirestoreApp('ts-press-audit-fieldmask-stability'))
  })
  afterAll(async () => deleteEmulatorFirestoreApp(app))

  it('修正前的呼叫方式（DocumentReference.select()）在真實 Admin SDK 上確實會丟出 TypeError——證明這份報告描述的 bug 是真的，不是憑空想像', () => {
    const docRef = db.collection('campaigns').doc('does-not-matter')
    // @ts-expect-error round 25 修正前的錯誤呼叫方式：DocumentReference 沒有 .select()。
    expect(typeof docRef.select).toBe('undefined')
    expect(() => {
      // @ts-expect-error 同上，刻意呼叫一個不存在的方法來重現修正前的 TypeError。
      docRef.select('status')
    }).toThrow(TypeError)
  })

  it('修正後：對存在的 campaign 正常運作，不拋出任何錯誤，且只讀到 STABILITY_FIELDS 遮罩內的欄位——敏感測試欄位（contactEmail）確實沒被讀到', async () => {
    const id = `stability-${randomUUID()}`
    const campaigns = db.collection('campaigns')
    await campaigns.doc(id).set({
      status: 'sending',
      recipientsReady: true,
      leaseGeneration: 7,
      activeAttemptId: 'attempt-xyz',
      resolutionLeaseAttemptId: null,
      // 模擬個資／無關內容：刻意不在 STABILITY_FIELDS 裡，field mask
      // 應該讓這個欄位完全不會被伺服器端回傳。
      contactEmail: 'should-not-be-read@example.com',
    })

    // 先直接驗證 field mask 真正生效的那一層（getDocumentByIdWithFieldMask）。
    const rawSnap = await getDocumentByIdWithFieldMask(campaigns, id, STABILITY_FIELDS, FieldPath)
    expect(rawSnap).not.toBeNull()
    const rawData = rawSnap!.data()!
    expect(rawData).not.toHaveProperty('contactEmail')
    // status 存在於文件裡，但不在 STABILITY_FIELDS 裡，同樣不該被讀到——
    // 證明這不只是「剛好沒選到敏感欄位」，而是真正的伺服器端欄位遮罩。
    expect(rawData).not.toHaveProperty('status')
    for (const key of Object.keys(rawData)) {
      expect(STABILITY_FIELDS).toContain(key)
    }

    // 再驗證 runDrainAuditScan() 實際會呼叫的同一份 deps.readCampaignStabilityFields()。
    const deps = createDrainAuditDeps(db, { FieldPath })
    const result = await deps.readCampaignStabilityFields(id)
    expect(result).not.toBeNull()
    expect(result).toMatchObject({
      leaseGeneration: 7,
      activeAttemptId: 'attempt-xyz',
      resolutionLeaseAttemptId: null,
    })
    expect(typeof result!.updateTimeMs).toBe('number')
    expect(result).not.toHaveProperty('contactEmail')
  })

  it('修正後：對不存在的 campaign 回傳 null（維持既有的「查無此文件」約定，不是拋例外）', async () => {
    const deps = createDrainAuditDeps(db, { FieldPath })
    const result = await deps.readCampaignStabilityFields(`missing-${randomUUID()}`)
    expect(result).toBeNull()
  })
})

describe('round 25 修正：runDrainAuditScan 端對端（用 createDrainAuditDeps 接到真實 emulator，證明修正後整個 drain audit 流程仍然能跑到正確的分類結果）', () => {
  let app: unknown
  let db: FirebaseFirestore.Firestore

  beforeAll(() => {
    ;({ app, db } = createEmulatorFirestoreApp('ts-press-audit-fieldmask-fullscan'))
  })
  afterAll(async () => deleteEmulatorFirestoreApp(app))

  it('一份乾淨的 completed campaign（無收件人、無租約）→ 掃描穩定成功（stable:true），分類為 SAFE，且不會因為 readCampaignStabilityFields 拋錯而整個掃描失敗', async () => {
    const id = `full-safe-${randomUUID()}`
    await db
      .collection('campaigns')
      .doc(id)
      .set({
        status: 'completed',
        recipientsReady: true,
        contactEmail: 'should-not-be-read-either@example.com',
      })

    const deps = createDrainAuditDeps(db, { FieldPath })
    const nowMs = Date.now()
    const scan = await runDrainAuditScan(deps, classifyCampaignForDrainAudit, nowMs)

    expect(scan.stable).toBe(true)
    const ours = scan.results.find((r) => r.campaignId === id)
    expect(ours).toBeDefined()
    expect(ours!.classification).toBe('SAFE')
    expect(ours!.recipientCount).toBe(0)
  })
})

describe('round 25 修正：ops-campaign-repair.mjs 的 loadClassification（createClassificationLoader，真實 emulator，dry-run 讀取路徑）', () => {
  let app: unknown
  let db: FirebaseFirestore.Firestore

  beforeAll(() => {
    ;({ app, db } = createEmulatorFirestoreApp('ts-press-repair-fieldmask-dryrun'))
  })
  afterAll(async () => deleteEmulatorFirestoreApp(app))

  it('修正後：對存在的 campaign 正常運作，不拋出 .select is not a function，只讀到 field mask 內的欄位（敏感測試欄位沒被讀到），分類完成得到合理結果', async () => {
    const id = `repair-${randomUUID()}`
    const campaignRef = db.collection('campaigns').doc(id)
    await campaignRef.set({
      status: 'completed',
      recipientsReady: true,
      mode: 'real',
      isTest: false,
      pressReleaseId: 'pr-1',
      contactEmail: 'should-not-be-read@example.com',
    })
    await campaignRef.collection('recipients').doc('r1').set({ status: 'sent' })
    await campaignRef.collection('recipients').doc('r2').set({ status: 'sent' })

    const loadClassification = createClassificationLoader(campaignRef, {
      FieldPath,
      classifyCampaignForDrainAudit,
    })

    const loaded = await loadClassification(Date.now())
    expect(loaded.exists).toBe(true)
    expect(loaded.data).not.toHaveProperty('contactEmail')
    for (const key of Object.keys(loaded.data!)) {
      expect(CAMPAIGN_REPAIR_CLASSIFICATION_FIELDS).toContain(key)
    }
    expect(loaded.classification!.classification).toBe('SAFE')
  })

  it('修正後：對不存在的 campaign 回傳 { exists: false }（維持既有約定，main() 的 runReconcile／runRepairPressRelease 都依賴這個 shape）', async () => {
    const campaignRef = db.collection('campaigns').doc(`missing-${randomUUID()}`)
    const loadClassification = createClassificationLoader(campaignRef, {
      FieldPath,
      classifyCampaignForDrainAudit,
    })
    const loaded = await loadClassification(Date.now())
    expect(loaded).toEqual({ exists: false })
  })

  it('dry-run（loadClassification）是純讀取——呼叫前後 campaign 與 recipients 文件的內容完全沒有被寫入，證明 dry-run 真的是唯讀', async () => {
    const id = `repair-dryrun-${randomUUID()}`
    const campaignRef = db.collection('campaigns').doc(id)
    await campaignRef.set({
      status: 'sending',
      recipientsReady: true,
      mode: 'real',
      isTest: false,
      activeAttemptId: 'attempt-in-flight',
      leaseGeneration: 3,
    })
    await campaignRef.collection('recipients').doc('r1').set({ status: 'claimed' })

    async function snapshotAll() {
      const campaignSnap = await campaignRef.get()
      const recipientsSnap = await campaignRef.collection('recipients').get()
      return {
        campaign: campaignSnap.data(),
        recipients: Object.fromEntries(recipientsSnap.docs.map((d) => [d.id, d.data()])),
      }
    }

    const before = await snapshotAll()

    const loadClassification = createClassificationLoader(campaignRef, {
      FieldPath,
      classifyCampaignForDrainAudit,
    })
    const loaded = await loadClassification(Date.now())
    expect(loaded.exists).toBe(true)
    // 這份 campaign 還在 sending、帶著一個 active 的處理租約，不是 SAFE——
    // 確認分類邏輯真的有完整跑過一遍，不是提早因為例外或空資料短路。
    expect(loaded.classification!.classification).not.toBe('SAFE')

    const after = await snapshotAll()
    // 逐欄位比對：campaign 文件、recipients 子集合都跟呼叫前完全一樣——
    // loadClassification()／getDocumentByIdWithFieldMask() 全程只呼叫
    // .get()，沒有任何 .set()／.update()／transaction 寫入路徑。
    expect(after).toEqual(before)
  })
})

/**
 * round 27 新增（Finding 1）：SAFE_WITH_WARNING 的「歷史 completed
 * campaign」例外——用真實 Firestore emulator 驗證，走跟 production 100%
 * 相同的程式碼路徑：createDrainAuditDeps()（含 CAMPAIGN_FIELDS field
 * mask）＋ runDrainAuditScan()（含穩定快照協定）＋
 * classifyCampaignForDrainAudit()（見 shared/campaignSend.ts 的
 * isLegacyCompletedPartialMismatchSafe()）。
 *
 * ⚠️ 這裡驗證的核心是 Part 2 的完整性：`recipientsReady`／`createdAt`／
 * `updatedAt`／`completedAt` 這三個欄位如果真的完全不存在於文件裡，且
 * field mask（CAMPAIGN_FIELDS）有把它們納入查詢，稽核工具讀到的值必須是
 * 「真的缺席」（undefined），不是被 field mask 篩掉才看起來像缺席——只有
 * 這樣，isLegacyCompletedPartialMismatchSafe() 的絕對缺席判斷才有意義。
 *
 * campaignId／收件人人數全部是合成值，跟真實 production 資料無關。
 */
describe('round 27 新增：SAFE_WITH_WARNING 的 legacy completed campaign 例外（createDrainAuditDeps + runDrainAuditScan，真實 emulator）', () => {
  let app: unknown
  let db: FirebaseFirestore.Firestore

  beforeAll(() => {
    ;({ app, db } = createEmulatorFirestoreApp('ts-press-audit-safe-with-warning'))
  })
  afterAll(async () => deleteEmulatorFirestoreApp(app))

  it('legacy 形狀（recipientsReady／createdAt／updatedAt／completedAt 完全不存在於文件裡，無任何 owner，收件人只有 sent／failed）→ 掃描穩定成功，分類為 SAFE_WITH_WARNING', async () => {
    const id = `legacy-safe-with-warning-${randomUUID()}`
    const campaignRef = db.collection('campaigns').doc(id)
    // 刻意只寫入 status 與 leaseGeneration（模擬這套 lease 機制部署之前的
    // 舊 schema）——recipientsReady／createdAt／updatedAt／completedAt／
    // activeAttemptId／resolutionLeaseAttemptId／createdByAttemptId 全部
    // 不設定，文件裡真的沒有這些鍵，不是設成 null／false。
    await campaignRef.set({
      status: 'completed',
      leaseGeneration: 0,
      contactEmail: 'should-not-be-read@example.com',
    })
    await campaignRef.collection('recipients').doc('r1').set({ status: 'sent' })
    await campaignRef.collection('recipients').doc('r2').set({ status: 'sent' })
    await campaignRef.collection('recipients').doc('r3').set({ status: 'failed' })

    const deps = createDrainAuditDeps(db, { FieldPath })
    const nowMs = Date.now()
    const scan = await runDrainAuditScan(deps, classifyCampaignForDrainAudit, nowMs)

    expect(scan.stable).toBe(true)
    const ours = scan.results.find((r) => r.campaignId === id)
    expect(ours).toBeDefined()
    expect(ours!.classification).toBe('SAFE_WITH_WARNING')
    expect(ours!.legacyCompletedPartialMismatchWaived).toBe(true)
    expect(ours!.recipientDistributionConsistent).toBe(false)
  })

  it('姊妹案例：recipientsReady 明確寫成 false（不是缺席）→ 不會被當成 legacy 例外，維持 INDETERMINATE，不是 SAFE_WITH_WARNING', async () => {
    const id = `legacy-recipients-ready-false-${randomUUID()}`
    const campaignRef = db.collection('campaigns').doc(id)
    await campaignRef.set({
      status: 'completed',
      recipientsReady: false,
      leaseGeneration: 0,
    })
    await campaignRef.collection('recipients').doc('r1').set({ status: 'sent' })
    await campaignRef.collection('recipients').doc('r2').set({ status: 'failed' })

    const deps = createDrainAuditDeps(db, { FieldPath })
    const nowMs = Date.now()
    const scan = await runDrainAuditScan(deps, classifyCampaignForDrainAudit, nowMs)

    expect(scan.stable).toBe(true)
    const ours = scan.results.find((r) => r.campaignId === id)
    expect(ours).toBeDefined()
    expect(ours!.classification).not.toBe('SAFE_WITH_WARNING')
    expect(ours!.classification).toBe('INDETERMINATE')
    expect(ours!.legacyCompletedPartialMismatchWaived).toBe(false)
  })
})
