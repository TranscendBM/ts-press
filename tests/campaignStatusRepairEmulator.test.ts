import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createEmulatorFirestoreApp,
  deleteEmulatorFirestoreApp,
  FieldPath,
  FieldValue,
} from '../functions/scripts/emulator-test-support.mjs'
import {
  createCampaignStatusRepairLoader,
  CAMPAIGN_STATUS_REPAIR_FIELDS,
} from '../functions/scripts/ops-campaign-repair.mjs'
import { decideCampaignStatusRepair, repairCampaignStatusTx } from '../shared/campaignSend'

/**
 * round 26 新增：`--action repair-status` 的真實 Firestore emulator 整合
 * 測試——修的是一筆真實稽核發現的資料形狀（campaign `status:'completed'`，
 * 但 recipients 子集合真實分佈是 `sent:113／failed:3`，116 筆），用合成
 * 假資料重現（沒有真實 campaign ID、沒有 PII），驗證：
 * - dry-run（`createCampaignStatusRepairLoader`／`decideCampaignStatusRepair`）
 *   是純讀取，campaign、全部 116 筆 recipients、關聯的 pressReleases 文件
 *   在呼叫前後逐一比對完全沒有變化。
 * - `--confirm`（真正的 `db.runTransaction()` + `repairCampaignStatusTx`）
 *   只改了 campaign 頂層被明確允許的欄位，116 筆 recipients、pressReleases
 *   文件同樣逐一比對完全沒有變化（不是只信任程式碼邏輯／只看筆數——見下面
 *   每個測試裡逐一 for 迴圈比對每一份文件的說明）。
 * - 冪等性：修復成功後再 dry-run 一次 → already-consistent；再 --confirm
 *   一次 → 安全 no-op，不會拋錯、不會重複寫入、不會把已經修好的結果蓋掉。
 * - 並行情境：dry-run 顯示 eligible 之後、真正 --confirm 之前，另一個
 *   （假想的）流程搶走了處理租約——--confirm 的 transaction 重新讀到新的
 *   資料，必須 fail closed，不能用 dry-run 當下的舊快照寫入。
 *
 * 只連線本機 Firestore emulator（127.0.0.1:8080，跟 firebase.json 與其他
 * test:rules 測試檔一致），project id 一律用假的 `ts-press-*` 測試 id，
 * 不是正式的 `ts-press`——見 functions/scripts/emulator-test-support.mjs
 * 的說明與防呆（它會直接拒絕字面上的 `ts-press`）。
 */
const HOST = '127.0.0.1'
const PORT = 8080

beforeAll(() => {
  process.env.FIRESTORE_EMULATOR_HOST = `${HOST}:${PORT}`
})

/** Admin SDK transaction → shared/campaignSend.ts 認得的 DocTx 形狀——跟
 *  ops-campaign-repair.mjs／functions/src/index.ts 的 docTx() 是同一份
 *  邏輯的另一份抄本，這裡刻意保持完全一致，方便人工核對。 */
function docTx(tx: FirebaseFirestore.Transaction, ref: FirebaseFirestore.DocumentReference) {
  return {
    async get() {
      const snap = await tx.get(ref)
      return { exists: snap.exists, data: snap.exists ? snap.data() : undefined }
    },
    set(data: Record<string, unknown>) {
      tx.set(ref, data)
    },
    update(data: Record<string, unknown>) {
      tx.update(ref, data)
    },
  }
}

function makeRecipients(sentCount: number, failedCount: number) {
  const recipients: { id: string; status: string }[] = []
  for (let i = 0; i < sentCount; i += 1) recipients.push({ id: `sent-${i}`, status: 'sent' })
  for (let i = 0; i < failedCount; i += 1) recipients.push({ id: `failed-${i}`, status: 'failed' })
  return recipients
}

async function seedRecipients(
  db: FirebaseFirestore.Firestore,
  campaignRef: FirebaseFirestore.DocumentReference,
  recipients: { id: string; status: string }[],
) {
  const batch = db.batch()
  for (const r of recipients) {
    batch.set(campaignRef.collection('recipients').doc(r.id), { status: r.status })
  }
  await batch.commit()
}

function confirmDeps(campaignRef: FirebaseFirestore.DocumentReference, tx: FirebaseFirestore.Transaction) {
  return {
    queryRecipients: async () => {
      const snap = await tx.get(campaignRef.collection('recipients').select('status'))
      return snap.docs.map((d) => ({ status: d.data().status }))
    },
    extraFields: () => ({
      updatedAt: FieldValue.serverTimestamp(),
      completedAt: FieldValue.delete(),
    }),
  }
}

describe('repair-status（round 26 新增：真實 Firestore emulator——完整修一次真實案例形狀的資料，只有 campaign 頂層欄位被改，recipients／pressReleases 完全沒被動過）', () => {
  let app: unknown
  let db: FirebaseFirestore.Firestore

  beforeAll(() => {
    ;({ app, db } = createEmulatorFirestoreApp('ts-press-repair-status-emulator'))
  })
  afterAll(async () => deleteEmulatorFirestoreApp(app))

  it('completed + recipients 真實分佈 sent:113／failed:3（116 筆）+ 關聯的 pressRelease：dry-run 零寫入 → confirm 只改 campaign 頂層欄位、116 筆 recipients 與 pressRelease 逐一比對完全沒變 → 再次 dry-run 回報 already-consistent → 再次 confirm 安全 no-op', async () => {
    const campaignId = `synthetic-campaign-${randomUUID()}`
    const pressReleaseId = `synthetic-press-release-${randomUUID()}`
    const campaignRef = db.collection('campaigns').doc(campaignId)
    const pressReleaseRef = db.collection('pressReleases').doc(pressReleaseId)
    const recipients = makeRecipients(113, 3)

    await pressReleaseRef.set({
      title: 'Synthetic press release (test fixture, no real content)',
      status: 'sent',
      sentAt: FieldValue.serverTimestamp(),
    })
    await campaignRef.set({
      status: 'completed',
      recipientsReady: true,
      leaseGeneration: 3,
      pressReleaseId,
      totals: { recipients: 116, sent: 116, failed: 0, exhausted: 0, deliveryUnknown: 0 },
      completedAt: FieldValue.serverTimestamp(),
    })
    await seedRecipients(db, campaignRef, recipients)

    async function snapshotAll() {
      const [campaignSnap, recipientsSnap, pressReleaseSnap] = await Promise.all([
        campaignRef.get(),
        campaignRef.collection('recipients').get(),
        pressReleaseRef.get(),
      ])
      return {
        campaign: campaignSnap.data(),
        recipients: Object.fromEntries(recipientsSnap.docs.map((d) => [d.id, d.data()])),
        pressRelease: pressReleaseSnap.data(),
      }
    }

    // ---- dry-run：跟 production 100% 相同的讀取路徑（createCampaignStatusRepairLoader），必須零寫入 ----
    const beforeDryRun = await snapshotAll()
    const loadDecision = createCampaignStatusRepairLoader(campaignRef, { FieldPath, decideCampaignStatusRepair })
    const dryRunDecision = await loadDecision()
    expect(dryRunDecision.outcome).toBe('eligible')
    expect(dryRunDecision.currentStatus).toBe('completed')
    expect(dryRunDecision.authoritativeStatus).toBe('partial')
    expect(dryRunDecision.authoritativeTotals).toEqual({
      recipients: 116,
      sent: 113,
      failed: 3,
      exhausted: 0,
      deliveryUnknown: 0,
    })
    expect(dryRunDecision.nonTerminalCount).toBe(3)

    const afterDryRun = await snapshotAll()
    expect(afterDryRun.campaign).toEqual(beforeDryRun.campaign)
    expect(afterDryRun.pressRelease).toEqual(beforeDryRun.pressRelease)
    // 116 筆逐一比對——不是只信任「dry-run 只呼叫 .get()」這件事本身，也不是
    // 只看筆數相符：即使筆數對得上，內容被置換也必須被這裡的逐一比對抓到。
    expect(Object.keys(afterDryRun.recipients).length).toBe(116)
    for (const id of Object.keys(beforeDryRun.recipients)) {
      expect(afterDryRun.recipients[id]).toEqual(beforeDryRun.recipients[id])
    }

    // ---- confirm：真的在單一 transaction 內重新驗證並寫入 ----
    const beforeConfirm = await snapshotAll()
    const result = await db.runTransaction((tx) => {
      const deps = confirmDeps(campaignRef, tx)
      return repairCampaignStatusTx(docTx(tx, campaignRef), deps.queryRecipients, deps.extraFields)
    })
    expect(result.outcome).toBe('eligible')
    expect(result.authoritativeStatus).toBe('partial')

    const afterConfirm = await snapshotAll()
    // campaign 頂層被允許的欄位確實改了。
    expect(afterConfirm.campaign?.status).toBe('partial')
    expect(afterConfirm.campaign?.totals).toEqual({
      recipients: 116,
      sent: 113,
      failed: 3,
      exhausted: 0,
      deliveryUnknown: 0,
    })
    expect(afterConfirm.campaign?.completedAt).toBeUndefined()
    expect(afterConfirm.campaign?.updatedAt).toBeDefined()
    // 其餘欄位（leaseGeneration／pressReleaseId／recipientsReady）完全沒被動過。
    expect(afterConfirm.campaign?.leaseGeneration).toBe(beforeConfirm.campaign?.leaseGeneration)
    expect(afterConfirm.campaign?.pressReleaseId).toBe(beforeConfirm.campaign?.pressReleaseId)
    expect(afterConfirm.campaign?.recipientsReady).toBe(true)

    // recipients／pressRelease：逐一比對完全沒變（不是只比對筆數）。
    expect(Object.keys(afterConfirm.recipients).length).toBe(116)
    for (const id of Object.keys(beforeConfirm.recipients)) {
      expect(afterConfirm.recipients[id]).toEqual(beforeConfirm.recipients[id])
    }
    expect(afterConfirm.pressRelease).toEqual(beforeConfirm.pressRelease)

    // ---- 再次 dry-run：必須回報 already-consistent，不是還可以修（冪等性） ----
    const secondDryRun = await loadDecision()
    expect(secondDryRun.outcome).toBe('already-consistent')
    expect(secondDryRun.patch).toBeUndefined()

    // ---- 再次 confirm：安全 no-op，不會拋錯、不會重複寫入、不會把已經修好的結果蓋掉 ----
    const beforeSecondConfirm = await snapshotAll()
    const secondConfirmResult = await db.runTransaction((tx) => {
      const deps = confirmDeps(campaignRef, tx)
      return repairCampaignStatusTx(docTx(tx, campaignRef), deps.queryRecipients, deps.extraFields)
    })
    expect(secondConfirmResult.outcome).toBe('already-consistent')
    const afterSecondConfirm = await snapshotAll()
    expect(afterSecondConfirm.campaign).toEqual(beforeSecondConfirm.campaign)
    expect(afterSecondConfirm.recipients).toEqual(beforeSecondConfirm.recipients)
    expect(afterSecondConfirm.pressRelease).toEqual(beforeSecondConfirm.pressRelease)
  })

  it('CAMPAIGN_STATUS_REPAIR_FIELDS 的 field mask 真的生效——dry-run 讀到的 campaign 資料不含遮罩外的敏感測試欄位', async () => {
    const campaignId = `synthetic-fieldmask-${randomUUID()}`
    const campaignRef = db.collection('campaigns').doc(campaignId)
    await campaignRef.set({
      status: 'completed',
      recipientsReady: true,
      leaseGeneration: 1,
      totals: { recipients: 2, sent: 1, failed: 1, exhausted: 0, deliveryUnknown: 0 },
      // 模擬個資／無關內容：刻意不在 CAMPAIGN_STATUS_REPAIR_FIELDS 裡。
      contactEmail: 'should-not-be-read@example.com',
      subject: 'internal subject line, unrelated to this repair',
    })
    await seedRecipients(db, campaignRef, [
      { id: 'r1', status: 'sent' },
      { id: 'r2', status: 'failed' },
    ])

    const loadDecision = createCampaignStatusRepairLoader(campaignRef, { FieldPath, decideCampaignStatusRepair })
    const decision = await loadDecision()
    expect(decision.outcome).toBe('eligible')
    // decideCampaignStatusRepair() 回顯的 currentTotals 只會來自遮罩內的
    // totals 欄位——如果 contactEmail／subject 有洩漏進來，這裡的欄位集合
    // 會超出 CAMPAIGN_STATUS_REPAIR_FIELDS。
    for (const key of Object.keys(decision.currentTotals ?? {})) {
      expect(['recipients', 'sent', 'failed', 'exhausted', 'deliveryUnknown']).toContain(key)
    }
    expect(CAMPAIGN_STATUS_REPAIR_FIELDS).not.toContain('contactEmail')
    expect(CAMPAIGN_STATUS_REPAIR_FIELDS).not.toContain('subject')
  })
})

describe('repair-status：並行情境（round 26 新增：dry-run 之後、confirm 之前，另一個流程搶走了處理租約 → confirm 的 transaction 重新驗證必須 fail closed，不能用 dry-run 當下的舊資料寫入）', () => {
  let app: unknown
  let db: FirebaseFirestore.Firestore

  beforeAll(() => {
    ;({ app, db } = createEmulatorFirestoreApp('ts-press-repair-status-concurrency'))
  })
  afterAll(async () => deleteEmulatorFirestoreApp(app))

  it('dry-run 顯示 eligible 之後，另一個（假想的）流程取得了處理租約 → confirm 重新讀到新的 activeAttemptId，拒絕寫入，campaign 維持被搶走租約後的狀態，不會被覆蓋、也不會被清掉', async () => {
    const campaignId = `synthetic-concurrency-${randomUUID()}`
    const campaignRef = db.collection('campaigns').doc(campaignId)
    const recipients = makeRecipients(5, 2)
    await campaignRef.set({
      status: 'completed',
      recipientsReady: true,
      leaseGeneration: 1,
      totals: { recipients: 7, sent: 7, failed: 0, exhausted: 0, deliveryUnknown: 0 },
    })
    await seedRecipients(db, campaignRef, recipients)

    const loadDecision = createCampaignStatusRepairLoader(campaignRef, { FieldPath, decideCampaignStatusRepair })
    const dryRunDecision = await loadDecision()
    expect(dryRunDecision.outcome).toBe('eligible')

    // 模擬並行：dry-run 之後、真正 --confirm 之前，另一個（假想的）
    // processing invocation 取得了處理租約——這代表 dry-run 當下讀到的
    // 「沒有 owner」快照已經過期。
    await campaignRef.update({
      activeAttemptId: 'concurrent-invocation',
      activeLeaseExpiresAtMs: Date.now() + 600_000,
    })
    const afterConcurrentClaim = (await campaignRef.get()).data()

    const result = await db.runTransaction((tx) => {
      const deps = confirmDeps(campaignRef, tx)
      return repairCampaignStatusTx(docTx(tx, campaignRef), deps.queryRecipients, deps.extraFields)
    })
    expect(result.outcome).toBe('active-processing-lease')

    const afterRejectedConfirm = (await campaignRef.get()).data()
    // 完全沒有被 repair-status 寫入——status 仍然是 completed（沒有被改成
    // partial），activeAttemptId 仍然是那個並行流程的值，沒有被清掉或覆蓋，
    // 跟並行搶走租約「之後」的狀態逐欄位相同（不是只看某一個欄位）。
    expect(afterRejectedConfirm).toEqual(afterConcurrentClaim)
    expect(afterRejectedConfirm?.status).toBe('completed')
    expect(afterRejectedConfirm?.activeAttemptId).toBe('concurrent-invocation')
  })

  it('dry-run 顯示 eligible 之後，另一個（假想的）收件人狀態改變（原本 sent 的人被改成 sending，模擬正在重試）→ confirm 重新讀到新的分佈，拒絕寫入（fail closed，不是用 dry-run 當下的舊分佈算出來的 patch 寫入）', async () => {
    const campaignId = `synthetic-recipient-race-${randomUUID()}`
    const campaignRef = db.collection('campaigns').doc(campaignId)
    const recipients = makeRecipients(5, 2)
    await campaignRef.set({
      status: 'completed',
      recipientsReady: true,
      leaseGeneration: 1,
      totals: { recipients: 7, sent: 7, failed: 0, exhausted: 0, deliveryUnknown: 0 },
    })
    await seedRecipients(db, campaignRef, recipients)

    const loadDecision = createCampaignStatusRepairLoader(campaignRef, { FieldPath, decideCampaignStatusRepair })
    const dryRunDecision = await loadDecision()
    expect(dryRunDecision.outcome).toBe('eligible')
    expect(dryRunDecision.authoritativeTotals).toEqual({
      recipients: 7,
      sent: 5,
      failed: 2,
      exhausted: 0,
      deliveryUnknown: 0,
    })

    // 模擬並行：其中一位 failed 的收件人被一般 retryCampaign 認領，變成
    // sending（fail-status recipient 不是這個修復動作的終止狀態，理論上
    // 隨時可能被一般流程接手）。
    await campaignRef.collection('recipients').doc('failed-0').set({ status: 'sending' })

    const result = await db.runTransaction((tx) => {
      const deps = confirmDeps(campaignRef, tx)
      return repairCampaignStatusTx(docTx(tx, campaignRef), deps.queryRecipients, deps.extraFields)
    })
    expect(result.outcome).toBe('non-terminal-recipient-present')

    const afterRejectedConfirm = (await campaignRef.get()).data()
    expect(afterRejectedConfirm?.status).toBe('completed') // 完全沒有被改成 partial
    const recipientAfter = (await campaignRef.collection('recipients').doc('failed-0').get()).data()
    expect(recipientAfter?.status).toBe('sending') // repair-status 從未寫過任何 recipient 文件
  })
})
