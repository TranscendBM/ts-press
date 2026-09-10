import {
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  collection,
  deleteDoc,
  deleteField,
  doc,
  getDoc,
  getDocs,
  runTransaction,
  serverTimestamp,
  setDoc,
  Timestamp,
  type DocumentReference,
  type Firestore,
  type Transaction,
} from 'firebase/firestore'
import {
  acquireCampaignLeaseTx,
  acquireResolutionLeaseTx,
  beginDeliveryAttemptTx,
  claimRecipientTx,
  commitRecipientResultTx,
  computeAuthoritativeRecipientTotals,
  coordinateResolveDeliveryUnknown,
  createOrJoinCampaignTx,
  type DeliveryUnknownResolutionAction,
  finalizeCampaignTx,
  finalizeCampaignWithPressReleaseTx,
  markCampaignFailedTx,
  reclaimExpiredDeliveryAttemptTx,
  releaseCampaignProcessingLeaseTx,
  repairCampaignPressReleaseSyncTx,
  RESOLUTION_LEASE_MS,
  resolveDeliveryUnknownTx,
  type DocSnapshotLike,
  type DocTx,
  type RecipientStatus,
} from '../shared/campaignSend'

/**
 * 併發整合測試：直接呼叫 shared/campaignSend.ts 裡「production 實際在跑」
 * 的 Tx 協調函式（acquireCampaignLeaseTx／claimRecipientTx／
 * finalizeCampaignTx／markCampaignFailedTx／createOrJoinCampaignTx…），
 * 只是把它們的 DocTx 介面接到 Firestore 用戶端 SDK 的 runTransaction()
 * 上，對著真正的模擬器驗證 Firestore 的樂觀並行控制在這些函式上確實
 * 撐得住兩個 invocation 同時競爭的情境。
 *
 * ⚠️ 刻意不在這裡手寫一份「看起來很像」的 tryCreate／tryClaim —— 那樣測的
 * 是這個測試檔自己重新實作的邏輯，不是 functions/src/index.ts 實際呼叫的
 * 程式碼，兩者一旦漂移，測試綠燈不代表 production 是對的。
 * functions/src/index.ts 因為頂層 initializeApp() 沒辦法安全匯入，所以
 * production（Admin SDK）與這裡（Client SDK）各自把自己的 transaction
 * 包成同一份 DocTx 介面，呼叫的是 shared/campaignSend.ts 同一份協調函式。
 *
 * 一律透過 `npm run test:rules` 執行，需要 Firebase 模擬器（Java）。
 */
const HOST = '127.0.0.1'
const PORT = 8080
const CAMPAIGN_LEASE_MS = 480_000
const RECIPIENT_LEASE_MS = 60_000

describe('campaign／recipient 併發競爭（對著真正的 Firestore 驗證 shared Tx 協調函式）', () => {
  let env: RulesTestEnvironment
  let db: Firestore

  beforeAll(async () => {
    env = await initializeTestEnvironment({
      projectId: 'ts-press-campaign-concurrency',
      firestore: {
        rules:
          'rules_version = "2"; service cloud.firestore { match /databases/{db}/documents { match /{document=**} { allow read, write: if true; } } }',
        host: HOST,
        port: PORT,
      },
    })
  })

  afterAll(async () => env?.cleanup())

  beforeEach(async () => {
    await env.clearFirestore()
    db = env.unauthenticatedContext().firestore()
  })

  /** 跟 functions/src/index.ts 的 docTx() 完全對應的用戶端 SDK 版本。 */
  function clientDocTx(tx: Transaction, ref: DocumentReference): DocTx {
    return {
      async get(): Promise<DocSnapshotLike> {
        const snap = await tx.get(ref)
        return {
          exists: snap.exists(),
          data: snap.exists() ? (snap.data() as Record<string, unknown>) : undefined,
        }
      },
      set(data) {
        tx.set(ref, data)
      },
      update(data) {
        tx.update(ref, data)
      },
    }
  }

  async function acquireLease(campaignRef: DocumentReference, attemptId: string) {
    return runTransaction(db, (tx) =>
      acquireCampaignLeaseTx(
        clientDocTx(tx, campaignRef),
        attemptId,
        Date.now(),
        CAMPAIGN_LEASE_MS,
        () => ({ updatedAt: serverTimestamp() }),
      ),
    )
  }

  /** round 10 新增：從一個 acquireLease／acquireResolutionLease 的結果裡
   *  安全地取出 generation，outcome 不是 'acquired' 時直接讓測試失敗，
   *  不要讓一個沒有 generation 的呼叫悄悄用 undefined 往下傳。 */
  function expectGeneration(decision: { outcome: string; generation?: number }): number {
    if (decision.outcome !== 'acquired' || typeof decision.generation !== 'number') {
      throw new Error(`預期已經成功取得租約（acquired），實際是 ${decision.outcome}`)
    }
    return decision.generation
  }

  async function finalize(
    campaignRef: DocumentReference,
    attemptId: string,
    generation: number,
    totals: {
      recipients: number
      sent: number
      failed: number
      exhausted: number
      deliveryUnknown: number
    },
    nonTerminalCount: number,
  ) {
    return runTransaction(db, (tx) =>
      finalizeCampaignTx(
        clientDocTx(tx, campaignRef),
        attemptId,
        generation,
        Date.now(),
        totals,
        nonTerminalCount,
        (d) => ({
          activeAttemptId: deleteField(),
          activeLeaseExpiresAtMs: deleteField(),
          updatedAt: serverTimestamp(),
          ...(d.outcome === 'completed' || d.outcome === 'failed'
            ? { completedAt: serverTimestamp() }
            : {}),
        }),
      ),
    )
  }

  /** round 16 新增（Finding 4）：campaign finalize 與新聞稿同步收在同一個
   *  transaction——見 shared/campaignSend.ts 的
   *  finalizeCampaignWithPressReleaseTx 說明。這裡跟 production
   *  （functions/src/index.ts 的 finalizeCampaign()）用同一份邏輯，只是
   *  接到 Client SDK 的 transaction 上，驗證 Firestore 真的能在同一個
   *  transaction 內原子寫入兩份不同集合的文件。 */
  async function finalizeWithPressRelease(
    campaignRef: DocumentReference,
    pressReleaseRef: DocumentReference,
    attemptId: string,
    generation: number,
    totals: {
      recipients: number
      sent: number
      failed: number
      exhausted: number
      deliveryUnknown: number
    },
    nonTerminalCount: number,
  ) {
    return runTransaction(db, (tx) =>
      finalizeCampaignWithPressReleaseTx(
        clientDocTx(tx, campaignRef),
        () => clientDocTx(tx, pressReleaseRef),
        attemptId,
        generation,
        Date.now(),
        totals,
        nonTerminalCount,
        (d) => ({
          activeAttemptId: deleteField(),
          activeLeaseExpiresAtMs: deleteField(),
          updatedAt: serverTimestamp(),
          ...(d.outcome === 'completed' || d.outcome === 'failed' || d.outcome === 'needs_review'
            ? { completedAt: serverTimestamp() }
            : {}),
        }),
        () => ({ status: 'sent', sentAt: serverTimestamp() }),
        // round 18 新增（Finding 1）：blocked 時的安全釋放欄位。
        () => ({
          activeAttemptId: deleteField(),
          activeLeaseExpiresAtMs: deleteField(),
          updatedAt: serverTimestamp(),
        }),
      ),
    )
  }

  /** round 16 新增（Finding 4）：修復既有的「campaign 已終止但新聞稿未
   *  同步」資料——見 shared/campaignSend.ts 的
   *  repairCampaignPressReleaseSyncTx 說明。
   *
   *  round 18 修正（Finding 5）：不可以用「修復發生的當下時間」冒充
   *  campaign 完成時間——sentAt 必須直接用 decidePressReleaseSyncRepair
   *  帶出來的完成時間，跟 functions/src/index.ts、ops-campaign-repair.mjs
   *  的正式寫法一致。
   *
   *  round 19 修正（Finding 2）：decidePressReleaseSyncRepair() 現在回傳
   *  的是驗證過的毫秒數（authoritativeCompletedAtMs），不是原始 unknown
   *  值——這裡必須用 client SDK 的 Timestamp.fromMillis() 正規化成真正的
   *  Timestamp 才能寫入 sentAt，不能把數字原樣寫進去（PressRelease.sentAt
   *  的型別是 Timestamp，寫入純數字會讓前端排序／格式化悄悄失效）。 */
  async function repairPressReleaseSync(
    campaignRef: DocumentReference,
    pressReleaseRef: DocumentReference,
  ) {
    return runTransaction(db, (tx) =>
      repairCampaignPressReleaseSyncTx(
        clientDocTx(tx, campaignRef),
        () => clientDocTx(tx, pressReleaseRef),
        (authoritativeCompletedAtMs) => ({
          status: 'sent',
          sentAt: Timestamp.fromMillis(authoritativeCompletedAtMs),
        }),
        // round 20 新增（Finding 3）：nowMs 現在是明確傳入的參數。
        Date.now(),
      ),
    )
  }

  /** round 15 新增（Finding 2）：安全的「只釋放租約」primitive——校正
   *  （reconciliation）失敗時用它清理，不能經過 finalizeCampaignTx（那會
   *  寫 status／totals／completedAt，reconciliation 例外時根本沒有可信的
   *  totals 可以寫）。 */
  async function releaseLease(
    campaignRef: DocumentReference,
    attemptId: string,
    generation: number,
  ) {
    return runTransaction(db, (tx) =>
      releaseCampaignProcessingLeaseTx(
        clientDocTx(tx, campaignRef),
        attemptId,
        generation,
        () => ({
          activeAttemptId: deleteField(),
          activeLeaseExpiresAtMs: deleteField(),
          updatedAt: serverTimestamp(),
        }),
      ),
    )
  }

  async function markFailed(
    campaignRef: DocumentReference,
    ownership:
      | { kind: 'setup'; attemptId: string }
      | { kind: 'lease'; attemptId: string; generation: number },
    message: string,
  ) {
    return runTransaction(db, (tx) =>
      markCampaignFailedTx(
        clientDocTx(tx, campaignRef),
        ownership,
        Date.now(),
        message,
        () => ({
          updatedAt: serverTimestamp(),
          completedAt: serverTimestamp(),
          ...(ownership.kind === 'lease'
            ? { activeAttemptId: deleteField(), activeLeaseExpiresAtMs: deleteField() }
            : {}),
        }),
      ),
    )
  }

  /** round 11 修正（Finding 1）：claimRecipientTx 現在同時讀寫 recipient 與
   *  campaign 兩份文件、並要求 generation 相符（見 shared/campaignSend.ts
   *  的 decideRecipientClaim 說明），呼叫端必須傳入 campaignRef。 */
  // round 12 修正（Finding 2）：claim 階段不再寫 lastAttemptAt——它跟
  // attemptCount／deliveryStartedAtMs 一樣代表「真正跨過 SMTP 前最後閘門」
  // 的時間，claim 只是搶下這位收件人，還沒有這個保證，見
  // decideBeginDeliveryAttempt 的說明；lastAttemptAt 現在跟
  // beginDeliveryAttempt() 的 buildExtra 一起寫。
  async function claim(
    recipientRef: DocumentReference,
    campaignRef: DocumentReference,
    attemptId: string,
    generation: number,
  ) {
    return runTransaction(db, (tx) =>
      claimRecipientTx(
        clientDocTx(tx, recipientRef),
        clientDocTx(tx, campaignRef),
        attemptId,
        generation,
        Date.now(),
        RECIPIENT_LEASE_MS,
      ),
    )
  }

  /** round 10 全面修正（Finding 1）：commitRecipientResultTx 現在同時讀寫
   *  recipient 與 campaign 兩份文件、並要求 generation 相符（見
   *  shared/campaignSend.ts 的 decideCommitRecipientResult 說明），呼叫端
   *  必須傳入 campaignRef 與呼叫當下持有的 generation。 */
  async function commitResult(
    recipientRef: DocumentReference,
    campaignRef: DocumentReference,
    attemptId: string,
    generation: number,
    patch: Record<string, unknown>,
  ) {
    return runTransaction(db, (tx) =>
      commitRecipientResultTx(
        clientDocTx(tx, recipientRef),
        clientDocTx(tx, campaignRef),
        attemptId,
        generation,
        Date.now(),
        patch,
      ),
    )
  }

  /** round 8 新增、round 9 修正（Finding 1）、round 10 修正（Finding 2）：
   *  真正呼叫 SMTP 前的最後一道原子閘門——現在需要同時驗證 recipient
   *  claimed lease、campaign 處理租約、以及 fencing generation。 */
  async function beginDeliveryAttempt(
    recipientRef: DocumentReference,
    campaignRef: DocumentReference,
    attemptId: string,
    generation: number,
    nowMs: number = Date.now(),
    recipientLeaseMs: number = RECIPIENT_LEASE_MS,
  ) {
    return runTransaction(db, (tx) =>
      beginDeliveryAttemptTx(
        clientDocTx(tx, recipientRef),
        clientDocTx(tx, campaignRef),
        attemptId,
        generation,
        nowMs,
        recipientLeaseMs,
        () => ({ lastAttemptAt: serverTimestamp() }),
      ),
    )
  }

  /** round 8 新增、round 9 修正（Finding 1／Finding 3）、round 10 修正
   *  （Finding 1／Finding 2）：把過期的 delivery attempt 轉成
   *  delivery_unknown——現在需要 callerAttemptId／callerGeneration 驗證
   *  呼叫者自己仍合法持有 campaign 處理租約。 */
  async function reclaimExpiredDeliveryAttempt(
    recipientRef: DocumentReference,
    campaignRef: DocumentReference,
    callerAttemptId: string,
    callerGeneration: number,
    nowMs: number,
    errorMessage: string,
  ) {
    return runTransaction(db, (tx) =>
      reclaimExpiredDeliveryAttemptTx(
        clientDocTx(tx, recipientRef),
        clientDocTx(tx, campaignRef),
        callerAttemptId,
        callerGeneration,
        nowMs,
        errorMessage,
        () => ({ updatedAt: serverTimestamp() }),
      ),
    )
  }

  /** round 9 新增（Finding 2）：resolution 租約的取得。 */
  async function acquireResolutionLease(campaignRef: DocumentReference, attemptId: string) {
    return runTransaction(db, (tx) =>
      acquireResolutionLeaseTx(
        clientDocTx(tx, campaignRef),
        attemptId,
        Date.now(),
        RESOLUTION_LEASE_MS,
        () => ({ updatedAt: serverTimestamp() }),
      ),
    )
  }

  /**
   * round 8 新增、round 9 大幅修正（Finding 2／Finding 4）、round 10 再次
   * 大幅修正（Finding 1／2／3）：delivery_unknown 的人工 resolution。
   *
   * ⚠️ round 21 修正（CI Finding 1）：過去這裡自己重新實作「取得 resolution
   * 租約 → 查詢真實分佈 → transaction」這三段式流程，跟
   * functions/src/index.ts 的 resolveDeliveryUnknown callable 各自維護一份
   * 「看起來很像」的 orchestration——這正是本檔案開頭說明刻意要避免的事：
   * 兩邊一旦漂移，測試綠燈不代表 production 是對的。而且舊版直接呼叫
   * acquireResolutionLease，campaign 一旦已經因為前一次 resolve 變成
   * completed／failed，這裡就會在 acquire 這一步直接被 invalid-status 擋
   * 下，永遠讀不到本該可讀的 idempotent-replay／conflict（CI 失敗 1～3的
   * 根本原因）。現在改成呼叫 shared/campaignSend.ts 的
   * coordinateResolveDeliveryUnknown()——production 的 resolveDeliveryUnknown
   * callable 呼叫的正是同一支函式，只是 refs.runTransaction／
   * queryAuthoritativeRecipients 這裡接的是 Client SDK，production 接的是
   * Admin SDK。recipientId 直接取 recipientRef.id，不需要呼叫端另外傳——
   * 這樣既有呼叫這支函式的地方完全不用改參數列。
   */
  async function resolveDeliveryUnknown(
    recipientRef: DocumentReference,
    campaignRef: DocumentReference,
    audit: {
      resolvedBy: string
      resolutionId: string
      resolutionAction: DeliveryUnknownResolutionAction
      resolutionReason: string
    },
    leaseAttemptId: string,
  ) {
    const eventRef = doc(campaignRef, 'resolutionEvents', audit.resolutionId)
    return coordinateResolveDeliveryUnknown(
      {
        runTransaction: (work) =>
          runTransaction(db, (tx) =>
            work((target) => {
              const ref =
                target === 'recipient' ? recipientRef : target === 'campaign' ? campaignRef : eventRef
              return clientDocTx(tx, ref)
            }),
          ),
        queryAuthoritativeRecipients: async () => {
          const snap = await getDocs(collection(campaignRef, 'recipients'))
          return snap.docs.map((d) => ({ status: d.data().status as RecipientStatus }))
        },
      },
      recipientRef.id,
      audit,
      leaseAttemptId,
      Date.now(),
      RESOLUTION_LEASE_MS,
      () => ({ updatedAt: serverTimestamp() }),
      () => ({ resolvedAt: serverTimestamp() }),
      (d) => ({
        updatedAt: serverTimestamp(),
        resolutionLeaseAttemptId: deleteField(),
        resolutionLeaseExpiresAtMs: deleteField(),
        ...(d.outcome === 'resolved'
          ? d.campaignPatch.status === 'partial'
            ? { completedAt: deleteField() }
            : { completedAt: serverTimestamp() }
          : {}),
      }),
      () => ({ resolvedAt: serverTimestamp() }),
    )
  }

  async function seedSendingCampaign(id: string) {
    const ref = doc(db, 'campaigns', id)
    await setDoc(ref, { status: 'sending', recipientsReady: true })
    return ref
  }

  /** production 的 sendPendingRecipients 用「同一個」attemptId 同時當
   *  campaign 處理租約的持有者、以及每一位收件人的認領者——很多測試需要
   *  先建立這個前提（真正呼叫 acquireLease）才是在測 production 實際會
   *  走的狀態組合，所以抽成共用 helper，回傳呼叫後續 claim／begin／
   *  commit／finalize 都需要的 generation。 */
  async function seedCampaignWithActiveLease(
    id: string,
    attemptId: string,
  ): Promise<{ campaignRef: DocumentReference; generation: number }> {
    const campaignRef = await seedSendingCampaign(id)
    const acquired = await acquireLease(campaignRef, attemptId)
    expect(acquired.outcome).toBe('acquired')
    return { campaignRef, generation: expectGeneration(acquired) }
  }

  /**
   * 跟 functions/src/index.ts 的 computeCampaignTotals() 對應的用戶端 SDK
   * 版本——直接查 Firestore 現在的真實狀態，不依賴任何記憶體中算到一半的
   * 計數。round 6 的 runSendPhaseAfterLeaseAcquired() 在「已經開始處理
   * 收件人之後才發生的全域例外」，就是用同一種手法重新確認真實進度，
   * 而不是武斷假設全部失敗（Finding 1）。round 9：算法本身抽到
   * shared/campaignSend.ts 的 computeAuthoritativeRecipientTotals()，這裡
   * 只負責查詢，跟 resolveDeliveryUnknown 的 authoritative 查詢是同一份
   * 公式。
   */
  async function computeTotals(campaignRef: DocumentReference) {
    const snap = await getDocs(collection(campaignRef, 'recipients'))
    return computeAuthoritativeRecipientTotals(
      snap.docs.map((d) => ({ status: d.data().status as RecipientStatus })),
    )
  }

  describe('campaign 原子建立（createOrJoinCampaignTx，對應 sendCampaign 的建立階段）', () => {
    it('兩個帶著同一個 idempotencyKey 的首次請求同時建立，只有一個真正建立成功，輸家採用贏家的結果', async () => {
      const campaignRef = doc(db, 'campaigns', 'same-key-123')

      const [r1, r2] = await Promise.all([
        runTransaction(db, (tx) =>
          createOrJoinCampaignTx(clientDocTx(tx, campaignRef), 'attempt-A', {
            status: 'sending',
            recipientsReady: false,
            marker: 'attempt-A',
          }),
        ),
        runTransaction(db, (tx) =>
          createOrJoinCampaignTx(clientDocTx(tx, campaignRef), 'attempt-B', {
            status: 'sending',
            recipientsReady: false,
            marker: 'attempt-B',
          }),
        ),
      ])

      // 剛好只有一個 created:true（誰先誰後不保證，但不會兩個都是 true）
      const createdCount = [r1, r2].filter((r) => r.created).length
      expect(createdCount).toBe(1)

      // 輸家讀到的 existingData 一定是贏家寫入的內容，不是自己原本想寫的值
      const winner = r1.created ? r1 : r2
      const loser = r1.created ? r2 : r1
      expect(loser.created).toBe(false)
      expect(loser.existingData?.marker).toBe(
        winner === r1 ? 'attempt-A' : 'attempt-B',
      )

      const finalSnap = await getDoc(campaignRef)
      expect(finalSnap.data()?.createdByAttemptId).toBe(loser.existingData?.marker)
    })

    it('循序呼叫第二次會看到已存在，不會覆蓋第一次的內容', async () => {
      const campaignRef = doc(db, 'campaigns', 'sequential-key')
      const r1 = await runTransaction(db, (tx) =>
        createOrJoinCampaignTx(clientDocTx(tx, campaignRef), 'first', {
          status: 'sending',
          recipientsReady: false,
          marker: 'first',
        }),
      )
      const r2 = await runTransaction(db, (tx) =>
        createOrJoinCampaignTx(clientDocTx(tx, campaignRef), 'second', {
          status: 'sending',
          recipientsReady: false,
          marker: 'second',
        }),
      )

      expect(r1.created).toBe(true)
      expect(r2.created).toBe(false)
      expect(r2.existingData?.marker).toBe('first')
    })

    it('建立者的收件人批次寫入失敗後，只有建立者（setup owner）能標記失敗；非建立者不能', async () => {
      const campaignRef = doc(db, 'campaigns', 'setup-failure')
      const created = await runTransaction(db, (tx) =>
        createOrJoinCampaignTx(clientDocTx(tx, campaignRef), 'creator-A', {
          status: 'sending',
          recipientsReady: false,
        }),
      )
      expect(created.created).toBe(true)

      // 非建立者（例如另一個攔截到同一個 idempotencyKey、卻不是原始建立者
      // 的呼叫）不能把還在設定階段的 campaign 標記失敗。
      const nonCreatorAttempt = await markFailed(
        campaignRef,
        { kind: 'setup', attemptId: 'not-the-creator' },
        '冒充建立者的失敗標記',
      )
      expect(nonCreatorAttempt.applied).toBe(false)
      const afterNonCreator = await getDoc(campaignRef)
      expect(afterNonCreator.data()?.status).toBe('sending')
      expect(afterNonCreator.data()?.lastError).toBeUndefined()

      // 建立者自己（batch write 失敗後）可以合法標記失敗
      const creatorAttempt = await markFailed(
        campaignRef,
        { kind: 'setup', attemptId: 'creator-A' },
        '建立收件人紀錄失敗',
      )
      expect(creatorAttempt.applied).toBe(true)
      const afterCreator = await getDoc(campaignRef)
      expect(afterCreator.data()?.status).toBe('failed')
      expect(afterCreator.data()?.lastError).toBe('建立收件人紀錄失敗')
    })

    it('setup 的 ambiguous write 情境（recipientsReady 其實已經寫成功、另一個 invocation 已經取得處理租約）不能覆蓋正在寄送的 invocation', async () => {
      // 情境（Finding 1）：createdByAttemptId 相符的舊 setup owner 以為
      // batch write 失敗了（例如回應在網路上遺失），但 recipientsReady:true
      // 其實已經成功寫入；另一個 invocation 已經看到 recipientsReady:true、
      // 呼叫 acquireCampaignLeaseTx 拿到了處理租約、正在實際寄送。這時候
      // 舊 setup owner 才姍姍來遲地呼叫 markCampaignFailedTx({kind:'setup'})，
      // 光憑 createdByAttemptId 相符是不夠的，必須被拒絕。
      const campaignRef = doc(db, 'campaigns', 'setup-ambiguous-write')
      const created = await runTransaction(db, (tx) =>
        createOrJoinCampaignTx(clientDocTx(tx, campaignRef), 'creator-A', {
          status: 'sending',
          recipientsReady: false,
        }),
      )
      expect(created.created).toBe(true)

      // recipientsReady 其實已經成功寫入（batch write 早就 commit 了）
      await runTransaction(db, async (tx) => {
        const snap = await tx.get(campaignRef)
        tx.update(campaignRef, { ...snap.data(), recipientsReady: true })
      })

      // 另一個 invocation（可能是重試、也可能是别的請求）看到
      // recipientsReady:true，正常取得處理租約，開始實際寄送
      const takeover = await acquireLease(campaignRef, 'taken-over-by')
      expect(takeover.outcome).toBe('acquired')

      // 舊 setup owner 現在才想標記失敗——createdByAttemptId 仍然相符，
      // 但 recipientsReady 已經不是 false、而且已經有有效的處理租約，
      // 必須被拒絕，不能覆蓋正在寄送中的 campaign。
      const staleSetupFailure = await markFailed(
        campaignRef,
        { kind: 'setup', attemptId: 'creator-A' },
        '舊 setup owner 誤以為 batch write 失敗',
      )
      expect(staleSetupFailure.applied).toBe(false)

      const finalSnap = await getDoc(campaignRef)
      expect(finalSnap.data()?.status).toBe('sending') // 沒有被覆蓋成 failed
      expect(finalSnap.data()?.lastError).toBeUndefined()
      expect(finalSnap.data()?.activeAttemptId).toBe('taken-over-by') // 接手者的租約完好無缺
    })
  })

  describe('campaign 處理租約：取得、finalize 釋放、markFailed 釋放（Finding 2／Finding 3）', () => {
    it('A 取得租約後，B 在租約有效期間無法取得（held-by-other）', async () => {
      const ref = await seedSendingCampaign('lease-basic')
      const a = await acquireLease(ref, 'attempt-A')
      expect(a.outcome).toBe('acquired')

      const b = await acquireLease(ref, 'attempt-B')
      expect(b.outcome).toBe('held-by-other')

      const snap = await getDoc(ref)
      expect(snap.data()?.activeAttemptId).toBe('attempt-A')
    })

    it('A finalize 成 partial 之後立刻釋放租約，B 馬上就能取得（不必等 8 分鐘租期過期）', async () => {
      const ref = await seedSendingCampaign('lease-partial-release')
      const a = await acquireLease(ref, 'attempt-A')
      expect(a.outcome).toBe('acquired')

      const finalizeResult = await finalize(
        ref,
        'attempt-A',
        expectGeneration(a),
        { recipients: 100, sent: 90, failed: 10, exhausted: 0, deliveryUnknown: 0 },
        // 10 位 failed 還沒到終止狀態 → nonTerminalCount > 0 → partial
        10,
      )
      expect(finalizeResult.outcome).toBe('partial')

      const afterFinalize = await getDoc(ref)
      expect(afterFinalize.data()?.status).toBe('partial')
      expect(afterFinalize.data()?.activeAttemptId).toBeUndefined()
      expect(afterFinalize.data()?.activeLeaseExpiresAtMs).toBeUndefined()

      // 租約已經釋放，B 立即可以取得，不需要等 CAMPAIGN_LEASE_MS 過期
      const b = await acquireLease(ref, 'attempt-B')
      expect(b.outcome).toBe('acquired')
    })

    it('A finalize 成 completed／failed 時，租約同樣立刻釋放', async () => {
      const completedRef = await seedSendingCampaign('lease-completed-release')
      const completedLease = await acquireLease(completedRef, 'attempt-A')
      const completedResult = await finalize(
        completedRef,
        'attempt-A',
        expectGeneration(completedLease),
        { recipients: 10, sent: 10, failed: 0, exhausted: 0, deliveryUnknown: 0 },
        0,
      )
      expect(completedResult.outcome).toBe('completed')
      const afterCompleted = await getDoc(completedRef)
      expect(afterCompleted.data()?.activeAttemptId).toBeUndefined()

      const failedRef = await seedSendingCampaign('lease-failed-release')
      const failedLease = await acquireLease(failedRef, 'attempt-A')
      const failedResult = await finalize(
        failedRef,
        'attempt-A',
        expectGeneration(failedLease),
        { recipients: 10, sent: 0, failed: 0, exhausted: 10, deliveryUnknown: 0 },
        0,
      )
      expect(failedResult.outcome).toBe('failed')
      const afterFailed = await getDoc(failedRef)
      expect(afterFailed.data()?.activeAttemptId).toBeUndefined()
    })

    it('租約過期後被 B 取代，A 事後才跑完的 finalize（superseded）不能清掉 B 的租約', async () => {
      const ref = doc(db, 'campaigns', 'superseded-cannot-clear')
      // 直接寫入一個「A 的租約已經過期」的狀態，模擬 A 卡住很久之後才想
      // finalize——round 14 修正（Finding 1）：activeAttemptId 存在時，
      // leaseGeneration 也必須是合法的一致狀態（>=1），否則
      // acquireCampaignLeaseTx 本身就會因為「activeAttemptId 存在但
      // generation 缺失」這個不一致組合直接拒絕（invalid-generation），
      // 這裡明確給 A 一個合法的既有 generation（1），才能真的測到
      // 「B 接手、A 事後才 finalize」這個情境本身。
      await setDoc(ref, {
        status: 'sending',
        recipientsReady: true,
        activeAttemptId: 'attempt-A',
        activeLeaseExpiresAtMs: Date.now() - 1000, // 已過期
        leaseGeneration: 1,
      })

      // B 認為 A 已死，正常取得租約並開始處理
      const b = await acquireLease(ref, 'attempt-B')
      expect(b.outcome).toBe('acquired')

      // A 這時候才姍姍來遲地想 finalize —— 必須被拒絕（superseded），
      // 不能把 B 剛拿到的租約蓋掉（activeAttemptId 已經不符，generation
      // 也已經被 B 的 acquire 往前推進，兩層防線都會擋下）。A 帶著自己
      // 記得的（seed 進去的）generation=1。
      const staleFinalize = await finalize(
        ref,
        'attempt-A',
        1,
        { recipients: 5, sent: 5, failed: 0, exhausted: 0, deliveryUnknown: 0 },
        0,
      )
      expect(staleFinalize.outcome).toBe('superseded')

      const afterStale = await getDoc(ref)
      expect(afterStale.data()?.activeAttemptId).toBe('attempt-B')
      expect(afterStale.data()?.status).toBe('sending')
    })

    it('例外發生後用 markCampaignFailedTx（lease 身分）清理，欄位確實被清空，但 failed 是 terminal，之後任何人都不能再取得租約', async () => {
      // ⚠️ 這個測試過去斷言「標記失敗後下一個 attempt 可以 acquire」，
      // 跟「failed 是 terminal，永遠不可再取得租約」的設計互相矛盾——
      // markCampaignFailedTx 清空 activeAttemptId／activeLeaseExpiresAtMs
      // 只是為了診斷資料乾淨，不代表這個 campaign 可以被當成「可以重新
      // 啟動的暫時失敗」。要重新寄送必須是一次新的 sendCampaign 呼叫，
      // 不能靠「租約剛好被清空」這種方式讓一個已經蓋棺論定的 campaign
      // 復活（見 decideAcquireCampaignLease 的說明）。
      const ref = await seedSendingCampaign('lease-cleanup-after-exception')
      const a = await acquireLease(ref, 'attempt-A')

      const failResult = await markFailed(
        ref,
        { kind: 'lease', attemptId: 'attempt-A', generation: expectGeneration(a) },
        '寄送過程發生未預期錯誤',
      )
      expect(failResult.applied).toBe(true)

      const afterFail = await getDoc(ref)
      expect(afterFail.data()?.status).toBe('failed')
      expect(afterFail.data()?.activeAttemptId).toBeUndefined()
      expect(afterFail.data()?.activeLeaseExpiresAtMs).toBeUndefined()

      // 租約欄位確實清空了，但 status 已經是 failed（terminal），
      // 之後任何 attempt 嘗試取得租約都必須被拒絕。
      const c = await acquireLease(ref, 'attempt-C')
      expect(c.outcome).toBe('terminal')
    })

    it('round 15 新增（Finding 2）：releaseCampaignProcessingLeaseTx 只清租約欄位，不動 status／totals，讓下一個 attempt 立刻能取得租約', async () => {
      const ref = await seedSendingCampaign('release-lease-basic')
      const a = await acquireLease(ref, 'attempt-A')
      const generation = expectGeneration(a)

      const releaseResult = await releaseLease(ref, 'attempt-A', generation)
      expect(releaseResult.outcome).toBe('released')

      const afterRelease = await getDoc(ref)
      // 還是 sending——沒有被誤判成任何終止狀態，也沒有寫 totals／completedAt。
      expect(afterRelease.data()?.status).toBe('sending')
      expect(afterRelease.data()?.activeAttemptId).toBeUndefined()
      expect(afterRelease.data()?.activeLeaseExpiresAtMs).toBeUndefined()
      expect(afterRelease.data()?.completedAt).toBeUndefined()
      expect(afterRelease.data()?.totals).toBeUndefined()

      const b = await acquireLease(ref, 'attempt-B')
      expect(b.outcome).toBe('acquired')
    })

    it('round 15 新增（Finding 2，核心迴歸案例）：A 的租約已經過期、B 已經正常取得新租約之後，A 才姍姍來遲想釋放——不能清掉 B 剛拿到的租約', async () => {
      const ref = doc(db, 'campaigns', 'release-lease-cannot-clear-new-owner')
      // A 曾經合法持有 generation=1 的租約，但已經過期。
      await setDoc(ref, {
        status: 'sending',
        recipientsReady: true,
        activeAttemptId: 'attempt-A',
        activeLeaseExpiresAtMs: Date.now() - 1000,
        leaseGeneration: 1,
      })

      // B 認為 A 已死，正常取得租約——generation 被推進到 2。
      const b = await acquireLease(ref, 'attempt-B')
      expect(b.outcome).toBe('acquired')
      const bGeneration = expectGeneration(b)
      expect(bGeneration).toBeGreaterThan(1)

      // A 這時候才想釋放自己記得的 generation=1 租約——必須被拒絕
      // （not-owner：activeAttemptId 已經不是 'attempt-A'，generation 也已
      // 經被 B 的 acquire 往前推進），不能把 B 正在使用的租約清掉。
      const staleRelease = await releaseLease(ref, 'attempt-A', 1)
      expect(staleRelease.outcome).toBe('not-owner')

      const afterStaleRelease = await getDoc(ref)
      expect(afterStaleRelease.data()?.activeAttemptId).toBe('attempt-B')
      expect(afterStaleRelease.data()?.leaseGeneration).toBe(bGeneration)

      // B 自己稍後用正確的 attemptId／generation 釋放，才會真的成功。
      const bRelease = await releaseLease(ref, 'attempt-B', bGeneration)
      expect(bRelease.outcome).toBe('released')
      const afterBRelease = await getDoc(ref)
      expect(afterBRelease.data()?.activeAttemptId).toBeUndefined()
    })

    it('round 15 新增（Finding 2）：campaign 不存在時回傳 not-found，而不是拋例外', async () => {
      const ref = doc(db, 'campaigns', 'release-lease-missing-campaign')
      const result = await releaseLease(ref, 'attempt-A', 1)
      expect(result.outcome).toBe('not-found')
    })

    it('round 15 新增（Finding 2）：attemptId 相符但呼叫端帶的 generation 跟目前持有的不一致時，拒絕釋放（not-owner）', async () => {
      const ref = await seedSendingCampaign('release-lease-wrong-generation')
      const a = await acquireLease(ref, 'attempt-A')
      const generation = expectGeneration(a)

      const wrongGenerationRelease = await releaseLease(ref, 'attempt-A', generation + 1)
      expect(wrongGenerationRelease.outcome).toBe('not-owner')

      const afterWrong = await getDoc(ref)
      // 租約完全沒被動到。
      expect(afterWrong.data()?.activeAttemptId).toBe('attempt-A')
    })
  })

  describe('round 16 新增（Finding 4）：campaign finalize 與新聞稿同步在同一個 transaction 內原子寫入（真實 Firestore）', () => {
    async function seedSendingCampaignWithPressRelease(id: string, pressReleaseId: string) {
      const campaignRef = doc(db, 'campaigns', id)
      await setDoc(campaignRef, {
        status: 'sending',
        recipientsReady: true,
        mode: 'real',
        isTest: false,
        pressReleaseId,
      })
      const pressReleaseRef = doc(db, 'pressReleases', pressReleaseId)
      await setDoc(pressReleaseRef, { status: 'draft' })
      return { campaignRef, pressReleaseRef }
    }

    it('finalize 成 completed、totals.sent>0 → campaign 與新聞稿在同一次呼叫內一起寫入', async () => {
      const { campaignRef, pressReleaseRef } = await seedSendingCampaignWithPressRelease(
        'pr-sync-atomic-completed',
        'pr-atomic-1',
      )
      const a = await acquireLease(campaignRef, 'attempt-A')
      const generation = expectGeneration(a)

      const decision = await finalizeWithPressRelease(
        campaignRef,
        pressReleaseRef,
        'attempt-A',
        generation,
        { recipients: 10, sent: 10, failed: 0, exhausted: 0, deliveryUnknown: 0 },
        0,
      )
      expect(decision.outcome).toBe('finalized')
      if (decision.outcome === 'finalized') {
        expect(decision.finalize.outcome).toBe('completed')
        expect(decision.pressReleaseUpdated).toBe(true)
      }

      const campaignSnap = await getDoc(campaignRef)
      expect(campaignSnap.data()?.status).toBe('completed')
      const pressReleaseSnap = await getDoc(pressReleaseRef)
      expect(pressReleaseSnap.data()?.status).toBe('sent')
    })

    // round 18 核心迴歸（Finding 1／Finding 6）：新聞稿被刪除時，round 17
    // 版本會讓 campaign 照樣 finalize（只是不同步）——round 18 起改成
    // 阻擋：已經確認需要同步（real、totals.sent>0、outcome!==partial），
    // 但找不到新聞稿，不能讓 campaign 帶著「應該同步卻沒有同步」的
    // terminal 狀態，維持非終止狀態，只安全釋放這次的處理租約。
    it('round 18 迴歸（Finding 1／6）：新聞稿在 finalize 之前就被刪除 → campaign 不會變成 terminal，只安全釋放租約', async () => {
      const { campaignRef, pressReleaseRef } = await seedSendingCampaignWithPressRelease(
        'pr-sync-atomic-deleted',
        'pr-atomic-deleted',
      )
      const a = await acquireLease(campaignRef, 'attempt-A')
      const generation = expectGeneration(a)

      // 模擬新聞稿在 campaign 還在寄送時被刪除——runTransaction 之外直接
      // 刪除，campaign finalize 的 transaction 稍後才會讀到它不存在。
      await deleteDoc(pressReleaseRef)

      const decision = await finalizeWithPressRelease(
        campaignRef,
        pressReleaseRef,
        'attempt-A',
        generation,
        { recipients: 10, sent: 10, failed: 0, exhausted: 0, deliveryUnknown: 0 },
        0,
      )
      expect(decision.outcome).toBe('blocked')
      if (decision.outcome === 'blocked') {
        expect(decision.reason).toBe('press-release-not-found')
        expect(decision.releaseDecision.outcome).toBe('released')
      }

      const campaignSnap = await getDoc(campaignRef)
      // campaign 完全沒有變成 terminal，維持原本的 sending，只有租約欄位
      // 被清掉。
      expect(campaignSnap.data()?.status).toBe('sending')
      expect(campaignSnap.data()?.activeAttemptId).toBeUndefined()
      expect(campaignSnap.data()?.completedAt).toBeUndefined()

      // 修好資料（新聞稿補回來）之後，重新走一次流程應該能正常 finalize，
      // 不需要重寄任何收件人（totals 是外部傳入的真實查詢結果，這裡直接
      // 重用同一份 totals 即可證明冪等）。
      await setDoc(pressReleaseRef, { status: 'draft' })
      const b = await acquireLease(campaignRef, 'attempt-B')
      const generationB = expectGeneration(b)
      const retryDecision = await finalizeWithPressRelease(
        campaignRef,
        pressReleaseRef,
        'attempt-B',
        generationB,
        { recipients: 10, sent: 10, failed: 0, exhausted: 0, deliveryUnknown: 0 },
        0,
      )
      expect(retryDecision.outcome).toBe('finalized')
      if (retryDecision.outcome === 'finalized') {
        expect(retryDecision.finalize.outcome).toBe('completed')
        expect(retryDecision.pressReleaseUpdated).toBe(true)
      }
    })

    it('outcome 是 partial（還有 nonTerminalCount）→ 新聞稿不會被更新，即使 totals.sent>0', async () => {
      const { campaignRef, pressReleaseRef } = await seedSendingCampaignWithPressRelease(
        'pr-sync-atomic-partial',
        'pr-atomic-partial',
      )
      const a = await acquireLease(campaignRef, 'attempt-A')
      const generation = expectGeneration(a)

      const decision = await finalizeWithPressRelease(
        campaignRef,
        pressReleaseRef,
        'attempt-A',
        generation,
        { recipients: 10, sent: 5, failed: 0, exhausted: 0, deliveryUnknown: 0 },
        5, // 還有 5 位沒完成 → partial
      )
      expect(decision.outcome).toBe('finalized')
      if (decision.outcome === 'finalized') {
        expect(decision.finalize.outcome).toBe('partial')
        expect(decision.pressReleaseUpdated).toBe(false)
      }

      const pressReleaseSnap = await getDoc(pressReleaseRef)
      expect(pressReleaseSnap.data()?.status).toBe('draft')
    })

    // round 18 核心迴歸（Finding 1）：isTest 缺失，只有 mode——不猜測，
    // 不能讓 campaign 帶著無法確認的中繼資料變成 terminal。
    it('round 18 迴歸（Finding 1）：campaign 只有 mode 沒有 isTest → campaign 不會變成 terminal，只安全釋放租約（真實 Firestore）', async () => {
      const campaignRef = doc(db, 'campaigns', 'pr-sync-invalid-metadata')
      await setDoc(campaignRef, {
        status: 'sending',
        recipientsReady: true,
        mode: 'real',
        // isTest 刻意缺失
        pressReleaseId: 'pr-invalid-metadata',
      })
      const pressReleaseRef = doc(db, 'pressReleases', 'pr-invalid-metadata')
      await setDoc(pressReleaseRef, { status: 'draft' })
      const a = await acquireLease(campaignRef, 'attempt-A')
      const generation = expectGeneration(a)

      const decision = await finalizeWithPressRelease(
        campaignRef,
        pressReleaseRef,
        'attempt-A',
        generation,
        { recipients: 10, sent: 10, failed: 0, exhausted: 0, deliveryUnknown: 0 },
        0,
      )
      expect(decision.outcome).toBe('blocked')
      if (decision.outcome === 'blocked') {
        expect(decision.reason).toBe('invalid-campaign-metadata')
      }

      const campaignSnap = await getDoc(campaignRef)
      expect(campaignSnap.data()?.status).toBe('sending') // 沒有變成 terminal
      const pressReleaseSnap = await getDoc(pressReleaseRef)
      expect(pressReleaseSnap.data()?.status).toBe('draft') // 完全沒被寫入
    })
  })

  describe('round 16 新增（Finding 4）：repairCampaignPressReleaseSyncTx 修復既有的不同步資料（真實 Firestore）', () => {
    it('campaign 已經是 completed、totals.sent>0、新聞稿還沒同步 → 修復成功，只動新聞稿，不動 campaign', async () => {
      const campaignRef = doc(db, 'campaigns', 'pr-repair-completed')
      await setDoc(campaignRef, {
        status: 'completed',
        mode: 'real',
        isTest: false,
        totals: { sent: 5 },
        pressReleaseId: 'pr-repair-1',
        completedAt: serverTimestamp(),
      })
      const pressReleaseRef = doc(db, 'pressReleases', 'pr-repair-1')
      await setDoc(pressReleaseRef, { status: 'draft' })

      const decision = await repairPressReleaseSync(campaignRef, pressReleaseRef)
      expect(decision.outcome).toBe('synced')

      const pressReleaseSnap = await getDoc(pressReleaseRef)
      expect(pressReleaseSnap.data()?.status).toBe('sent')
      const campaignSnap = await getDoc(campaignRef)
      expect(campaignSnap.data()?.status).toBe('completed') // 完全沒被動到
    })

    it('campaign 還在 sending（非終止）→ not-terminal，不會修改新聞稿', async () => {
      const campaignRef = doc(db, 'campaigns', 'pr-repair-not-terminal')
      await setDoc(campaignRef, {
        status: 'sending',
        mode: 'real',
        isTest: false,
        totals: { sent: 5 },
        pressReleaseId: 'pr-repair-2',
      })
      const pressReleaseRef = doc(db, 'pressReleases', 'pr-repair-2')
      await setDoc(pressReleaseRef, { status: 'draft' })

      const decision = await repairPressReleaseSync(campaignRef, pressReleaseRef)
      expect(decision.outcome).toBe('not-terminal')

      const pressReleaseSnap = await getDoc(pressReleaseRef)
      expect(pressReleaseSnap.data()?.status).toBe('draft')
    })

    it('重複呼叫已經修復過的 campaign → already-synced，冪等，不重複寫入', async () => {
      const campaignRef = doc(db, 'campaigns', 'pr-repair-idempotent')
      await setDoc(campaignRef, {
        status: 'completed',
        mode: 'real',
        isTest: false,
        totals: { sent: 5 },
        pressReleaseId: 'pr-repair-3',
        completedAt: serverTimestamp(),
      })
      const pressReleaseRef = doc(db, 'pressReleases', 'pr-repair-3')
      await setDoc(pressReleaseRef, { status: 'draft' })

      const first = await repairPressReleaseSync(campaignRef, pressReleaseRef)
      expect(first.outcome).toBe('synced')
      const second = await repairPressReleaseSync(campaignRef, pressReleaseRef)
      expect(second.outcome).toBe('already-synced')
    })

    // round 17 核心迴歸案例（Finding 5）：status:'sent' 但 sentAt 缺失——
    // 舊版只檢查 status，會把這種資料誤判成 already-synced 永遠不修。
    it('round 17 迴歸（Finding 5）：新聞稿 status 已經是 sent 但 sentAt 缺失 → 不是 already-synced，會重新寫入補上 sentAt（真實 Firestore）', async () => {
      const campaignRef = doc(db, 'campaigns', 'pr-repair-missing-sentat')
      await setDoc(campaignRef, {
        status: 'completed',
        mode: 'real',
        isTest: false,
        totals: { sent: 5 },
        pressReleaseId: 'pr-repair-missing-sentat',
        completedAt: serverTimestamp(),
      })
      const pressReleaseRef = doc(db, 'pressReleases', 'pr-repair-missing-sentat')
      await setDoc(pressReleaseRef, { status: 'sent' }) // 沒有 sentAt

      const decision = await repairPressReleaseSync(campaignRef, pressReleaseRef)
      expect(decision.outcome).toBe('synced')
      expect(decision.shouldWrite).toBe(true)

      const pressReleaseSnap = await getDoc(pressReleaseRef)
      expect(pressReleaseSnap.data()?.sentAt).toBeDefined()
    })

    // round 18 新增（Finding 5 項目 3）：campaign 沒有可信的 completedAt——
    // 不可以悄悄用修復當下的時間頂替，必須回報
    // missing-authoritative-sent-time，且完全不寫入新聞稿文件。
    it('round 18 新增（Finding 5）：campaign 缺少 completedAt → missing-authoritative-sent-time，不會寫入新聞稿（真實 Firestore）', async () => {
      const campaignRef = doc(db, 'campaigns', 'pr-repair-missing-completedat')
      await setDoc(campaignRef, {
        status: 'completed',
        mode: 'real',
        isTest: false,
        totals: { sent: 5 },
        pressReleaseId: 'pr-repair-missing-completedat',
        // 沒有 completedAt
      })
      const pressReleaseRef = doc(db, 'pressReleases', 'pr-repair-missing-completedat')
      await setDoc(pressReleaseRef, { status: 'draft' })

      const decision = await repairPressReleaseSync(campaignRef, pressReleaseRef)
      expect(decision.outcome).toBe('missing-authoritative-sent-time')
      expect(decision.shouldWrite).toBe(false)

      const pressReleaseSnap = await getDoc(pressReleaseRef)
      expect(pressReleaseSnap.data()?.status).toBe('draft') // 完全沒被寫入
    })
  })

  describe('acquireCampaignLeaseTx 的 terminal／not-ready 檢查（Finding 2：TOCTOU）', () => {
    it('status:completed 的 campaign 永遠不可取得租約，即使沒有任何 active lease 欄位', async () => {
      const ref = doc(db, 'campaigns', 'terminal-completed')
      await setDoc(ref, { status: 'completed', recipientsReady: true })

      const decision = await acquireLease(ref, 'attempt-A')
      expect(decision.outcome).toBe('terminal')

      const snap = await getDoc(ref)
      expect(snap.data()?.activeAttemptId).toBeUndefined()
    })

    it('status:failed 的 campaign 永遠不可取得租約', async () => {
      const ref = doc(db, 'campaigns', 'terminal-failed')
      await setDoc(ref, { status: 'failed', recipientsReady: true })

      const decision = await acquireLease(ref, 'attempt-A')
      expect(decision.outcome).toBe('terminal')
    })

    it('recipientsReady 還是 false（setup 尚未完成）→ not-ready，不核發租約', async () => {
      const ref = doc(db, 'campaigns', 'not-ready-setup')
      await setDoc(ref, { status: 'sending', recipientsReady: false })

      const decision = await acquireLease(ref, 'attempt-A')
      expect(decision.outcome).toBe('not-ready')
    })

    it('TOCTOU：A finalize 成 completed 並釋放租約之後，B 才進入 acquire transaction，必須拿到 terminal，不能誤判成 acquired', async () => {
      // 模擬 B 在呼叫 acquireCampaignLease 之前，先用一次非交易讀取
      // （例如 sendCampaign／retryCampaign 裡的 resolveResume）看到的是
      // sending／partial；但實際輪到 acquire 的 transaction 執行時，
      // campaign 已經被 A finalize 成 completed 並釋放了租約。
      const ref = await seedSendingCampaign('toctou-terminal')
      const a = await acquireLease(ref, 'attempt-A')
      expect(a.outcome).toBe('acquired')
      const finalizeResult = await finalize(
        ref,
        'attempt-A',
        expectGeneration(a),
        { recipients: 5, sent: 5, failed: 0, exhausted: 0, deliveryUnknown: 0 },
        0,
      )
      expect(finalizeResult.outcome).toBe('completed')

      // B 「稍早」讀到的狀態（未使用，僅表達情境）是 sending；
      // 這裡直接呼叫 acquire，驗證 transaction 內重新讀到的是最新狀態。
      const b = await acquireLease(ref, 'attempt-B')
      expect(b.outcome).toBe('terminal')

      const snap = await getDoc(ref)
      expect(snap.data()?.status).toBe('completed')
      expect(snap.data()?.activeAttemptId).toBeUndefined()
    })
  })

  describe('markCampaignFailedTx 的擁有權驗證（Finding 3：不能再用 null 無條件覆蓋）', () => {
    it('A 持有有效租約時，B 的 verify／setup 失敗絕對不能把 A 正在處理的 campaign 標記失敗', async () => {
      const ref = doc(db, 'campaigns', 'owner-guard')
      await setDoc(ref, { status: 'sending', recipientsReady: true })
      const a = await acquireLease(ref, 'attempt-A')
      expect(a.outcome).toBe('acquired')

      // B 從沒拿到租約（比如 B 的 SMTP verify 比 A 更早失敗），
      // 嘗試用自己的 attemptId 標記失敗必須被拒絕——B 從未真正 acquire
      // 過，這裡的 generation 值不影響結果（attemptId 不符這一關就先擋下）。
      const bAttempt = await markFailed(
        ref,
        { kind: 'lease', attemptId: 'attempt-B', generation: 0 },
        'B 的 SMTP 驗證失敗',
      )
      expect(bAttempt.applied).toBe(false)

      const afterB = await getDoc(ref)
      expect(afterB.data()?.status).toBe('sending')
      expect(afterB.data()?.lastError).toBeUndefined()
      expect(afterB.data()?.activeAttemptId).toBe('attempt-A')
    })

    it('A 的租約過期後，B 可以正常接手（acquire 成功）', async () => {
      const ref = doc(db, 'campaigns', 'owner-guard-expired')
      await setDoc(ref, {
        status: 'sending',
        recipientsReady: true,
        activeAttemptId: 'attempt-A',
        activeLeaseExpiresAtMs: Date.now() - 1000,
        leaseGeneration: 1, // round 14（Finding 1）：activeAttemptId 存在時必須有合法的 generation
      })

      const b = await acquireLease(ref, 'attempt-B')
      expect(b.outcome).toBe('acquired')
    })

    it('B 接手之後，A 遲來的失敗回報不能覆蓋 B 正在處理中的狀態', async () => {
      const ref = doc(db, 'campaigns', 'owner-guard-late-error')
      await setDoc(ref, {
        status: 'sending',
        recipientsReady: true,
        activeAttemptId: 'attempt-A',
        activeLeaseExpiresAtMs: Date.now() - 1000,
        leaseGeneration: 1, // round 14（Finding 1）：activeAttemptId 存在時必須有合法的 generation
      })
      const b = await acquireLease(ref, 'attempt-B')
      expect(b.outcome).toBe('acquired')

      // A 這時候才發現自己失敗了（其實它早就被判定死掉、租約被 B 接手），
      // 拿著自己（過期前）的 attemptId 想標記失敗——A 的租約是直接用
      // setDoc 種進去的（從未呼叫 acquireLease），generation 值不影響
      // 結果，activeAttemptId 已經不符這一關就先擋下。
      const aLateFailure = await markFailed(
        ref,
        { kind: 'lease', attemptId: 'attempt-A', generation: 0 },
        'A 遲來的錯誤',
      )
      expect(aLateFailure.applied).toBe(false)

      const afterLate = await getDoc(ref)
      expect(afterLate.data()?.status).toBe('sending') // 沒有被 A 蓋成 failed
      expect(afterLate.data()?.activeAttemptId).toBe('attempt-B') // B 的租約完好無缺
    })

    it('租約擁有者自己失敗時，可以安全地標記失敗並釋放租約', async () => {
      const ref = doc(db, 'campaigns', 'owner-guard-self-failure')
      await setDoc(ref, { status: 'sending', recipientsReady: true })
      const a = await acquireLease(ref, 'attempt-A')

      const selfFailure = await markFailed(
        ref,
        { kind: 'lease', attemptId: 'attempt-A', generation: expectGeneration(a) },
        'A 自己的 SMTP 驗證失敗',
      )
      expect(selfFailure.applied).toBe(true)

      const after = await getDoc(ref)
      expect(after.data()?.status).toBe('failed')
      expect(after.data()?.lastError).toBe('A 自己的 SMTP 驗證失敗')
      expect(after.data()?.activeAttemptId).toBeUndefined()
    })
  })

  describe('收件人認領（claimRecipientTx，對應 sendPendingRecipients 的認領階段；round 11 起需要真正的 campaign 處理租約——見 Finding 1）', () => {
    // round 11 修正（Finding 1）：claim 現在需要同時驗證 campaign 處理
    // 租約仍屬於自己、且 generation 相符，這裡的測試不能再用一個完全
    // 不存在的 campaign 文件當背景——必須先用 seedCampaignWithActiveLease()
    // 建立一個真正持有處理租約的 campaign，才是在測 production 實際會走
    // 的狀態組合。
    it('同一個合法持有處理租約的 attemptId，對同一位 queued 收件人同時發出兩次 claim（例如批次邏輯意外重複呼叫）→ Firestore transaction 保證只有一次真正生效', async () => {
      const { campaignRef, generation } = await seedCampaignWithActiveLease('claim-race-r1', 'attempt-A')
      const recipientRef = doc(campaignRef, 'recipients', 'r1')
      await setDoc(recipientRef, { status: 'queued', email: 'a@x.com', attemptCount: 0 })

      const [r1, r2] = await Promise.all([
        claim(recipientRef, campaignRef, 'attempt-A', generation),
        claim(recipientRef, campaignRef, 'attempt-A', generation),
      ])

      const claimedCount = [r1, r2].filter((r) => r.claimable).length
      expect(claimedCount).toBe(1)

      const finalSnap = await getDoc(recipientRef)
      expect(finalSnap.data()?.status).toBe('claimed')
      expect(finalSnap.data()?.attemptId).toBe('attempt-A')
    })

    it('租約未過期的 claimed 收件人，另一個 invocation 無法認領（避免重複寄送）', async () => {
      const { campaignRef, generation } = await seedCampaignWithActiveLease('claim-race-r2', 'attempt-A')
      const recipientRef = doc(campaignRef, 'recipients', 'r2')
      await setDoc(recipientRef, {
        status: 'claimed',
        attemptId: 'attempt-A',
        leaseExpiresAtMs: Date.now() + RECIPIENT_LEASE_MS,
        attemptCount: 0,
        attemptCountPending: true,
      })

      const result = await claim(recipientRef, campaignRef, 'attempt-A', generation)

      expect(result.claimable).toBe(false)
      const finalSnap = await getDoc(recipientRef)
      expect(finalSnap.data()?.attemptId).toBe('attempt-A')
    })

    it('已經 sent 的收件人，任何 invocation 都不能再認領', async () => {
      const { campaignRef, generation } = await seedCampaignWithActiveLease('claim-race-r3', 'attempt-A')
      const recipientRef = doc(campaignRef, 'recipients', 'r3')
      await setDoc(recipientRef, { status: 'sent', attemptId: 'attempt-A' })

      const [r1, r2] = await Promise.all([
        claim(recipientRef, campaignRef, 'attempt-A', generation),
        claim(recipientRef, campaignRef, 'attempt-A', generation),
      ])

      expect(r1.claimable).toBe(false)
      expect(r2.claimable).toBe(false)
    })

    // round 10 修正：這個測試過去直接把收件人種成 status:'sending' 再呼叫
    // claim()，斷言 claimable:true——但這跟 isRecipientClaimable() 的實際
    // 定義矛盾（sending 永遠不可被一般認領流程重新認領，不論 lease 是否
    // 過期，見該函式的說明），這個斷言在目前的程式碼下必然是錯的，只是
    // 這個測試檔需要真正的 Firestore 模擬器才能執行，一直沒有機會被跑到、
    // 也就沒有機會被抓出來。改成真正符合現行狀態機的「殭屍完成」情境：
    // A 認領、開始 delivery attempt 後卡住（recipient lease 過期）；
    // campaign 處理租約也被 B 接手（generation 往前推進）；B 正常認領、
    // 寄送、寫回結果；A 姍姍來遲的 commit 必須被拒絕——不只因為
    // attemptId 不符，即使 attemptId 還沒被任何人動過，generation 不符
    // 這一關也會單獨擋下它（Finding 1／Finding 2 的核心情境）。
    it('殭屍完成（zombie completion）：campaign 處理租約被 B 接手後，A 遲來的寄送結果不能覆蓋 B 的紀錄', async () => {
      const campaignRef = await seedSendingCampaign('zombie-completion')
      const recipientRef = doc(campaignRef, 'recipients', 'r4')
      await setDoc(recipientRef, { status: 'queued', attemptCount: 0 })

      const leaseA = await acquireLease(campaignRef, 'attempt-A')
      const genA = expectGeneration(leaseA)
      await claim(
        recipientRef,
        campaignRef,
        'attempt-A',
        genA,
      )
      await beginDeliveryAttempt(recipientRef, campaignRef, 'attempt-A', genA)
      // A 卡住：recipient lease 過期，但 A 完全不知道，之後才想寫回結果。
      await setDoc(recipientRef, { leaseExpiresAtMs: Date.now() - 1000 }, { merge: true })

      // campaign 處理租約也過期，B 正常接手（generation 往前推進）。
      await setDoc(campaignRef, { activeLeaseExpiresAtMs: Date.now() - 1000 }, { merge: true })
      const leaseB = await acquireLease(campaignRef, 'attempt-B')
      const genB = expectGeneration(leaseB)
      expect(genB).toBeGreaterThan(genA)

      // sweep 把過期的 sending 轉成 delivery_unknown（B 是現在合法的處理租約持有者）。
      const sweep = await reclaimExpiredDeliveryAttempt(
        recipientRef,
        campaignRef,
        'attempt-B',
        genB,
        Date.now(),
        'sweep',
      )
      expect(sweep.outcome).toBe('marked-unknown')

      // B 之後用人工 resolution 或一般流程都可以處理這位收件人；這裡直接
      // 驗證重點：A 姍姍來遲的 commit（attemptId 已經被 sweep 清掉，
      // generation 也已經是舊的）必須被拒絕。
      const aLateCommit = await commitResult(recipientRef, campaignRef, 'attempt-A', genA, {
        status: 'sent',
      })
      expect(aLateCommit.applied).toBe(false)

      const finalSnap = await getDoc(recipientRef)
      expect(finalSnap.data()?.status).toBe('delivery_unknown') // B 的 sweep 結果沒有被 A 蓋掉
    })
  })

  describe('Finding 1（round 6）：寄送途中發生全域錯誤，campaign 不會被永久標成 terminal failed', () => {
    // 這裡驗證的是 functions/src/index.ts 的
    // runSendPhaseAfterLeaseAcquired() 依賴的狀態機保證：一旦已經開始
    // 處理收件人（可能已經有人真的寄出成功），中斷後改用
    // computeCampaignTotals() 重新查真實狀態、交給 finalizeCampaignTx()
    // 用正常公式收尾——而不是無條件呼叫 markCampaignFailedTx() 寫成
    // terminal failed。runSendPhaseAfterLeaseAcquired() 本身因為
    // initializeApp() 沒辦法被測試匯入，但它呼叫的 finalizeCampaignTx／
    // acquireCampaignLeaseTx／claimRecipientTx 都是同一份 production
    // 邏輯，這裡直接呼叫這些函式，重現「中斷後重新收尾」這個序列，
    // 對著真正的 Firestore 驗證整個狀態機的行為，不是另外手刻一份。

    it('部分收件人已經 sent，中斷後用真實狀態重新收尾 → partial（不是 failed），已 sent 的人保留，campaign 之後還能被 retryCampaign 接手', async () => {
      const campaignRef = await seedSendingCampaign('interrupted-partial')
      const attemptId = 'attempt-A'
      const acquired = await acquireLease(campaignRef, attemptId)
      expect(acquired.outcome).toBe('acquired')
      const generation = expectGeneration(acquired)

      // 模擬 sendPendingRecipients() 已經處理過一部分：2 位 sent、
      // 1 位還 queued（例如全域例外剛好在處理到第 3 位之前發生）。
      await setDoc(doc(campaignRef, 'recipients', 'r1'), { status: 'sent', email: 'a@x.com' })
      await setDoc(doc(campaignRef, 'recipients', 'r2'), { status: 'sent', email: 'b@x.com' })
      await setDoc(doc(campaignRef, 'recipients', 'r3'), {
        status: 'queued',
        email: 'c@x.com',
        attemptCount: 0,
      })

      // runSendPhaseAfterLeaseAcquired() 的 catch 區塊：attemptedSend 已經
      // 是 true，所以不呼叫 markFailed，改成重新查真實狀態、finalize。
      const { totals, nonTerminalCount } = await computeTotals(campaignRef)
      expect(totals).toEqual({ recipients: 3, sent: 2, failed: 0, exhausted: 0, deliveryUnknown: 0 })
      expect(nonTerminalCount).toBe(1) // r3 還沒到終止狀態

      const result = await finalize(campaignRef, attemptId, generation, totals, nonTerminalCount)
      expect(result.outcome).toBe('partial') // 不是 failed！

      const afterFinalize = await getDoc(campaignRef)
      expect(afterFinalize.data()?.status).toBe('partial')
      expect(afterFinalize.data()?.activeAttemptId).toBeUndefined() // 租約已釋放

      // 已經 sent 的兩位保持不變
      const r1 = await getDoc(doc(campaignRef, 'recipients', 'r1'))
      const r2 = await getDoc(doc(campaignRef, 'recipients', 'r2'))
      expect(r1.data()?.status).toBe('sent')
      expect(r2.data()?.status).toBe('sent')

      // partial 不是 terminal，retryCampaign 可以立刻重新取得租約接手
      const retryAcquired = await acquireLease(campaignRef, 'attempt-B')
      expect(retryAcquired.outcome).toBe('acquired')
    })

    it('retry 接手後只會認領還沒到終止狀態的收件人，已經 sent 的人不會被重新認領', async () => {
      const campaignRef = await seedSendingCampaign('interrupted-retry-skips-sent')
      await setDoc(doc(campaignRef, 'recipients', 'r1'), { status: 'sent' })
      await setDoc(doc(campaignRef, 'recipients', 'r2'), { status: 'queued', attemptCount: 0 })

      // 中斷、重新收尾成 partial（同上一個測試的序列）
      const attemptA = 'attempt-A'
      const leaseA = await acquireLease(campaignRef, attemptA)
      const { totals, nonTerminalCount } = await computeTotals(campaignRef)
      await finalize(campaignRef, attemptA, expectGeneration(leaseA), totals, nonTerminalCount)

      // retryCampaign：新的 attemptId 取得租約，只認領 r2
      const attemptB = 'attempt-B'
      const retryAcquired = await acquireLease(campaignRef, attemptB)
      expect(retryAcquired.outcome).toBe('acquired')
      const genB = expectGeneration(retryAcquired)

      const r1Claim = await claim(doc(campaignRef, 'recipients', 'r1'), campaignRef, attemptB, genB)
      expect(r1Claim.claimable).toBe(false) // 已經 sent，永遠不會被重新認領

      const r2Claim = await claim(doc(campaignRef, 'recipients', 'r2'), campaignRef, attemptB, genB)
      expect(r2Claim.claimable).toBe(true) // 還沒到終止狀態，可以接續

      const r1After = await getDoc(doc(campaignRef, 'recipients', 'r1'))
      expect(r1After.data()?.status).toBe('sent') // 沒有被動過
    })

    it('preflight 失敗（attemptedSend 還是 false，確定零封寄出）：markCampaignFailedTx 用 lease 身分安全標記成 failed', async () => {
      // 對應 runSendPhaseAfterLeaseAcquired() 裡 loadSendInputs／
      // loadAttachments／讀 SMTP 設定或密碼／建立 transporter／verify
      // 任何一步失敗、sendPendingRecipients() 根本還沒被呼叫的情境——
      // 這時候可以安全確定零封寄出，用 markCampaignFailedTx({kind:'lease'})
      // 直接標記失敗是正確的，不需要、也不能假裝有收件人進度需要保留。
      const campaignRef = await seedSendingCampaign('preflight-failure')
      await setDoc(doc(campaignRef, 'recipients', 'r1'), { status: 'queued', attemptCount: 0 })
      const attemptId = 'attempt-A'
      const lease = await acquireLease(campaignRef, attemptId)

      const failResult = await markFailed(
        campaignRef,
        { kind: 'lease', attemptId, generation: expectGeneration(lease) },
        'SMTP 伺服器連線失敗：ECONNREFUSED',
      )
      expect(failResult.applied).toBe(true)

      const after = await getDoc(campaignRef)
      expect(after.data()?.status).toBe('failed')
      expect(after.data()?.lastError).toBe('SMTP 伺服器連線失敗：ECONNREFUSED')

      // 收件人完全沒被動過（連 sending 都沒進入過）
      const r1 = await getDoc(doc(campaignRef, 'recipients', 'r1'))
      expect(r1.data()?.status).toBe('queued')

      // failed 是 terminal，之後任何人都不能再取得租約重新寄送
      const reacquire = await acquireLease(campaignRef, 'attempt-B')
      expect(reacquire.outcome).toBe('terminal')
    })

    it('中斷後重新收尾：全部收件人剛好都已經到終止狀態、但沒人成功 → failed 是「真正發生的事實」，不是武斷寫入的', async () => {
      const campaignRef = await seedSendingCampaign('interrupted-genuinely-all-failed')
      await setDoc(doc(campaignRef, 'recipients', 'r1'), { status: 'exhausted' })
      await setDoc(doc(campaignRef, 'recipients', 'r2'), { status: 'exhausted' })

      const attemptId = 'attempt-A'
      const lease = await acquireLease(campaignRef, attemptId)
      const { totals, nonTerminalCount } = await computeTotals(campaignRef)
      expect(nonTerminalCount).toBe(0)

      const result = await finalize(campaignRef, attemptId, expectGeneration(lease), totals, nonTerminalCount)
      expect(result.outcome).toBe('failed') // 全部到終止狀態、沒人成功——這是事實，不是猜測

      // 這個 failed 是正常公式算出來的，一樣是 terminal
      const reacquire = await acquireLease(campaignRef, 'attempt-B')
      expect(reacquire.outcome).toBe('terminal')
    })

    it('terminal completed 不會被重新取得租約、不會被重新寄送', async () => {
      const campaignRef = await seedSendingCampaign('terminal-completed-no-resend')
      await setDoc(doc(campaignRef, 'recipients', 'r1'), { status: 'sent' })

      const attemptId = 'attempt-A'
      const lease = await acquireLease(campaignRef, attemptId)
      const { totals, nonTerminalCount } = await computeTotals(campaignRef)
      const result = await finalize(campaignRef, attemptId, expectGeneration(lease), totals, nonTerminalCount)
      expect(result.outcome).toBe('completed')

      const reacquire = await acquireLease(campaignRef, 'attempt-B')
      expect(reacquire.outcome).toBe('terminal')

      // 就算有人手動把 recipient 狀態改回 queued（不應該發生，但防禦性驗證）
      // terminal campaign 依然拿不到租約，不會被重新寄送
      await setDoc(doc(campaignRef, 'recipients', 'r1'), { status: 'queued' }, { merge: true })
      const reacquireAgain = await acquireLease(campaignRef, 'attempt-C')
      expect(reacquireAgain.outcome).toBe('terminal')
    })

    it('terminal exhausted（全部人永久失敗）不會被重新取得租約、不會被重新寄送', async () => {
      const campaignRef = await seedSendingCampaign('terminal-exhausted-no-resend')
      await setDoc(doc(campaignRef, 'recipients', 'r1'), { status: 'exhausted' })

      const attemptId = 'attempt-A'
      const lease = await acquireLease(campaignRef, attemptId)
      const { totals, nonTerminalCount } = await computeTotals(campaignRef)
      const result = await finalize(campaignRef, attemptId, expectGeneration(lease), totals, nonTerminalCount)
      expect(result.outcome).toBe('failed') // recipients>0 且 sent===0 → failed

      const reacquire = await acquireLease(campaignRef, 'attempt-B')
      expect(reacquire.outcome).toBe('terminal')
    })
  })

  describe('round 8／round 9（Finding 1／Finding 3）：claimed → sending 的原子閘門，過期 delivery attempt 不會被重新認領', () => {
    // production 的 sendPendingRecipients 用「同一個」attemptId 同時當
    // campaign 處理租約的持有者、以及每一位收件人的認領者——這裡的測試
    // 一律先用共用的 seedCampaignWithActiveLease()（見檔案上方）建立這個
    // 前提，再呼叫 claim／beginDeliveryAttempt，這樣才是真的在測
    // production 實際會走的狀態組合。

    it('claimed 過期後可以被重新認領（還沒呼叫過 SMTP，上一個 invocation 很可能死掉了）', async () => {
      const { campaignRef, generation } = await seedCampaignWithActiveLease(
        'claimed-expired-reclaim',
        'attempt-A',
      )
      const recipientRef = doc(campaignRef, 'recipients', 'r1')
      await setDoc(recipientRef, { status: 'queued', attemptCount: 0 })

      const first = await claim(
        recipientRef,
        campaignRef,
        'attempt-A',
        generation,
      )
      expect(first.claimable).toBe(true)
      // 強制把租約改成已過期，模擬「認領後、真正呼叫 SMTP 前就死掉」
      await setDoc(recipientRef, { leaseExpiresAtMs: Date.now() - 1 }, { merge: true })

      const second = await claim(
        recipientRef,
        campaignRef,
        'attempt-A',
        generation,
      )
      expect(second.claimable).toBe(true)
      const snap = await getDoc(recipientRef)
      expect(snap.data()?.status).toBe('claimed')
    })

    it('claimed lease 有效、attemptId 相符、campaign 處理租約仍屬於自己 → begin 成功轉成 sending，並把 lease 刷新成 now + RECIPIENT_LEASE_MS', async () => {
      const { campaignRef, generation } = await seedCampaignWithActiveLease(
        'begin-delivery-attempt',
        'attempt-A',
      )
      const recipientRef = doc(campaignRef, 'recipients', 'r1')
      await setDoc(recipientRef, { status: 'queued', attemptCount: 0 })

      const claimed = await claim(
        recipientRef,
        campaignRef,
        'attempt-A',
        generation,
      )
      expect(claimed.claimable).toBe(true)

      const beforeBegin = Date.now()
      const begin = await beginDeliveryAttempt(recipientRef, campaignRef, 'attempt-A', generation)
      expect(begin.applied).toBe(true)
      const snap = await getDoc(recipientRef)
      expect(snap.data()?.status).toBe('sending')
      // 刷新後的 lease 從 begin 當下重新起算一整段 RECIPIENT_LEASE_MS，
      // 不是延續 claim 時剩下的餘額。
      expect(snap.data()?.leaseExpiresAtMs).toBeGreaterThanOrEqual(
        beforeBegin + RECIPIENT_LEASE_MS - 5000,
      )
      expect(snap.data()?.deliveryStartedAtMs).toBeGreaterThanOrEqual(beforeBegin - 1000)
    })

    // round 9 核心修正（Finding 1）：claim 到 begin 之間如果 invocation 暫停
    // 到 claimed lease 過期，即使沒有其他人搶走 attemptId 字串，也不能
    // 呼叫 sendMail。
    it('claimed lease 已經過期（invocation 暫停太久才恢復）→ begin 回報 applied:false，即使 attemptId 字串完全沒被別人動過', async () => {
      const { campaignRef, generation } = await seedCampaignWithActiveLease(
        'begin-claimed-lease-expired',
        'attempt-A',
      )
      const recipientRef = doc(campaignRef, 'recipients', 'r1')
      await setDoc(recipientRef, { status: 'queued', attemptCount: 0 })

      await claim(
        recipientRef,
        campaignRef,
        'attempt-A',
        generation,
      )
      // 模擬 invocation 暫停到 claimed lease 過期才恢復執行——沒有任何
      // 其他 invocation 介入，attemptId 字串完全沒變。
      await setDoc(recipientRef, { leaseExpiresAtMs: Date.now() - 1 }, { merge: true })

      const begin = await beginDeliveryAttempt(recipientRef, campaignRef, 'attempt-A', generation)
      expect(begin).toEqual({ applied: false, reason: 'claimed-lease-expired' })
      const snap = await getDoc(recipientRef)
      expect(snap.data()?.status).toBe('claimed') // 沒有被誤判成 sending
    })

    it('claimed lease 欄位缺失（missing）→ begin 回報 applied:false，fail closed', async () => {
      const { campaignRef, generation } = await seedCampaignWithActiveLease(
        'begin-claimed-lease-missing',
        'attempt-A',
      )
      const recipientRef = doc(campaignRef, 'recipients', 'r1')
      // 直接寫成「已認領但沒有 leaseExpiresAtMs」的畸形狀態（理論上不該
      // 發生，防禦性測試）。
      await setDoc(recipientRef, { status: 'claimed', attemptId: 'attempt-A', attemptCount: 1 })

      const begin = await beginDeliveryAttempt(recipientRef, campaignRef, 'attempt-A', generation)
      expect(begin).toEqual({ applied: false, reason: 'claimed-lease-unparseable' })
    })

    it('ownership 在認領後、真正寄送前被搶走（recipient 層級）→ beginDeliveryAttemptTx 回報 applied:false，呼叫端絕對不能呼叫 sendMail', async () => {
      const { campaignRef, generation } = await seedCampaignWithActiveLease(
        'begin-delivery-attempt-race',
        'attempt-A',
      )
      const recipientRef = doc(campaignRef, 'recipients', 'r1')
      await setDoc(recipientRef, { status: 'queued', attemptCount: 0 })

      const claimed = await claim(
        recipientRef,
        campaignRef,
        'attempt-A',
        generation,
      )
      expect(claimed.claimable).toBe(true)
      // 模擬另一個（同一個 campaign attemptId 底下的）認領動作在 attempt-A
      // 準備呼叫 SMTP 之前，已經把這位收件人的租約改成過期，並重新認領走
      // ——用一個不同的收件人層級 attemptId 模擬「已經被別人動過」。
      await setDoc(recipientRef, { leaseExpiresAtMs: Date.now() - 1 }, { merge: true })
      const stolen = await claim(
        recipientRef,
        campaignRef,
        'attempt-A',
        generation,
      )
      expect(stolen.claimable).toBe(true)

      // 原本第一次認領記錄的 attemptId 已經不重要——這裡直接模擬「有其他
      // 呼叫端用不同 attemptId 呼叫 begin」的情境。
      const begin = await beginDeliveryAttempt(
        recipientRef,
        campaignRef,
        'someone-elses-attempt',
        generation,
      )
      expect(begin).toEqual({ applied: false, reason: 'attempt-id-mismatch' })
      const snap = await getDoc(recipientRef)
      expect(snap.data()?.status).toBe('claimed')
    })

    // round 9 新增（Finding 1 item 6／7）：campaign 處理租約已經被另一個
    // invocation 接手，舊 invocation 不能只靠 recipient 自己的 attemptId
    // 還沒被動過，就繼續呼叫 SMTP。
    it('campaign 處理租約已經被另一個 invocation 接手（activeAttemptId 改變）→ begin 回報 applied:false，即使 recipient 層級的 attemptId 完全沒變', async () => {
      const { campaignRef, generation } = await seedCampaignWithActiveLease(
        'begin-campaign-lease-stolen',
        'attempt-A',
      )
      const recipientRef = doc(campaignRef, 'recipients', 'r1')
      await setDoc(recipientRef, { status: 'queued', attemptCount: 0 })
      await claim(
        recipientRef,
        campaignRef,
        'attempt-A',
        generation,
      )

      // 模擬 campaign 處理租約過期，被另一個 invocation（attempt-B）接手。
      await setDoc(
        campaignRef,
        { activeLeaseExpiresAtMs: Date.now() - 1 },
        { merge: true },
      )
      const takeover = await acquireLease(campaignRef, 'attempt-B')
      expect(takeover.outcome).toBe('acquired')

      // 原本的 attempt-A 才慢慢執行到 begin 這一步——這時候它已經不再
      // 合法持有 campaign 處理租約了，即使 recipient 文件上的 attemptId
      // 字串仍然是 attempt-A（沒有人動過它），它自己記得的 generation 也
      // 已經是舊的。
      const begin = await beginDeliveryAttempt(recipientRef, campaignRef, 'attempt-A', generation)
      expect(begin).toEqual({ applied: false, reason: 'campaign-ownership-lost' })
      const snap = await getDoc(recipientRef)
      expect(snap.data()?.status).toBe('claimed') // 沒有被誤判成 sending
    })

    it('campaign 處理租約已經過期（即使 activeAttemptId 字串還沒被改寫、還沒有人接手）→ begin 回報 applied:false', async () => {
      const { campaignRef, generation } = await seedCampaignWithActiveLease(
        'begin-campaign-lease-expired',
        'attempt-A',
      )
      const recipientRef = doc(campaignRef, 'recipients', 'r1')
      await setDoc(recipientRef, { status: 'queued', attemptCount: 0 })
      await claim(
        recipientRef,
        campaignRef,
        'attempt-A',
        generation,
      )

      await setDoc(campaignRef, { activeLeaseExpiresAtMs: Date.now() - 1 }, { merge: true })

      const begin = await beginDeliveryAttempt(recipientRef, campaignRef, 'attempt-A', generation)
      expect(begin).toEqual({ applied: false, reason: 'campaign-lease-expired' })
    })

    it('sending 且租期已過 → claimRecipientTx 仍然拒絕認領（核心修正：不能假設 SMTP 一定還沒開始）', async () => {
      const { campaignRef, generation } = await seedCampaignWithActiveLease(
        'sending-expired-no-reclaim',
        'attempt-A',
      )
      const recipientRef = doc(campaignRef, 'recipients', 'r1')
      await setDoc(recipientRef, { status: 'queued', attemptCount: 0 })

      const claimed = await claim(
        recipientRef,
        campaignRef,
        'attempt-A',
        generation,
      )
      expect(claimed.claimable).toBe(true)
      const begin = await beginDeliveryAttempt(recipientRef, campaignRef, 'attempt-A', generation)
      expect(begin.applied).toBe(true)
      // 租約過期，模擬 SMTP 呼叫後 process 被中止、沒能寫回結果
      await setDoc(recipientRef, { leaseExpiresAtMs: Date.now() - 1 }, { merge: true })

      const reclaim = await claim(
        recipientRef,
        campaignRef,
        'attempt-A',
        generation,
      )
      expect(reclaim.claimable).toBe(false)
      const snap = await getDoc(recipientRef)
      expect(snap.data()?.status).toBe('sending')
    })

    it('reclaimExpiredDeliveryAttemptTx 把過期的 sending 原子轉成 delivery_unknown（sweeper 仍合法持有 campaign 處理租約）', async () => {
      const { campaignRef, generation } = await seedCampaignWithActiveLease(
        'reclaim-expired-delivery-attempt',
        'attempt-A',
      )
      const recipientRef = doc(campaignRef, 'recipients', 'r1')
      await setDoc(recipientRef, { status: 'queued', attemptCount: 0 })
      await claim(
        recipientRef,
        campaignRef,
        'attempt-A',
        generation,
      )
      await beginDeliveryAttempt(recipientRef, campaignRef, 'attempt-A', generation)
      await setDoc(recipientRef, { leaseExpiresAtMs: Date.now() - 1 }, { merge: true })

      const decision = await reclaimExpiredDeliveryAttempt(
        recipientRef,
        campaignRef,
        'attempt-A',
        generation,
        Date.now(),
        '寄送租約已過期，SMTP 可能已經開始但無法確認結果',
      )
      expect(decision.outcome).toBe('marked-unknown')
      const snap = await getDoc(recipientRef)
      expect(snap.data()?.status).toBe('delivery_unknown')

      // 一旦是 delivery_unknown，任何後續認領都必須被拒絕
      const afterReclaim = await claim(
        recipientRef,
        campaignRef,
        'attempt-A',
        generation,
      )
      expect(afterReclaim.claimable).toBe(false)
    })

    it('reclaimExpiredDeliveryAttemptTx 不會動還沒過期的 sending（可能還在合法處理中）', async () => {
      const { campaignRef, generation } = await seedCampaignWithActiveLease(
        'reclaim-not-expired',
        'attempt-A',
      )
      const recipientRef = doc(campaignRef, 'recipients', 'r1')
      await setDoc(recipientRef, { status: 'queued', attemptCount: 0 })
      await claim(
        recipientRef,
        campaignRef,
        'attempt-A',
        generation,
      )
      await beginDeliveryAttempt(recipientRef, campaignRef, 'attempt-A', generation)

      const decision = await reclaimExpiredDeliveryAttempt(
        recipientRef,
        campaignRef,
        'attempt-A',
        generation,
        Date.now(),
        'x',
      )
      expect(decision.outcome).toBe('not-expired')
      const snap = await getDoc(recipientRef)
      expect(snap.data()?.status).toBe('sending')
    })

    // round 9 新增（Finding 3）：leaseExpiresAtMs 無法解析時，現在也會被
    // 保守地掃進 delivery_unknown，不再是「indeterminate、永遠不動它」。
    it('sending 且 leaseExpiresAtMs 完全無法解析 → 保守轉成 delivery_unknown（不再永遠卡在 sending）', async () => {
      const { campaignRef, generation } = await seedCampaignWithActiveLease(
        'reclaim-malformed-lease',
        'attempt-A',
      )
      const recipientRef = doc(campaignRef, 'recipients', 'r1')
      // 直接寫成「sending 但沒有 leaseExpiresAtMs」的畸形狀態。
      await setDoc(recipientRef, { status: 'sending', attemptId: 'attempt-A', attemptCount: 1 })

      const decision = await reclaimExpiredDeliveryAttempt(
        recipientRef,
        campaignRef,
        'attempt-A',
        generation,
        Date.now(),
        '寄送租約已過期',
      )
      expect(decision.outcome).toBe('marked-unknown')
      const snap = await getDoc(recipientRef)
      expect(snap.data()?.status).toBe('delivery_unknown')
    })

    // round 9 新增（Finding 3 item 5）：sweeper 自己已經失去 campaign 處理
    // 租約時，不能繼續回收，避免誤傷正在合法接手處理的新 invocation。
    it('sweeper 自己已經失去 campaign 處理租約（被另一個 invocation 接手）→ 不會回收，不誤傷新 invocation 正在合法進行的處理', async () => {
      const { campaignRef, generation } = await seedCampaignWithActiveLease(
        'reclaim-caller-lost-lease',
        'attempt-A',
      )
      const recipientRef = doc(campaignRef, 'recipients', 'r1')
      await setDoc(recipientRef, { status: 'queued', attemptCount: 0 })
      await claim(
        recipientRef,
        campaignRef,
        'attempt-A',
        generation,
      )
      await beginDeliveryAttempt(recipientRef, campaignRef, 'attempt-A', generation)
      await setDoc(recipientRef, { leaseExpiresAtMs: Date.now() - 1 }, { merge: true })

      // campaign 處理租約過期，被新的 invocation（attempt-B）接手。
      await setDoc(campaignRef, { activeLeaseExpiresAtMs: Date.now() - 1 }, { merge: true })
      const takeover = await acquireLease(campaignRef, 'attempt-B')
      expect(takeover.outcome).toBe('acquired')

      // 舊的 sweeper（attempt-A）才慢慢執行到這一步——帶著自己（舊）的
      // generation，caller-lost-campaign-lease 這一關會被 activeAttemptId
      // 不符先擋下，即使沒有這一層，generation 不符也會擋下（雙重防線）。
      const decision = await reclaimExpiredDeliveryAttempt(
        recipientRef,
        campaignRef,
        'attempt-A',
        generation,
        Date.now(),
        'x',
      )
      expect(decision.outcome).toBe('caller-lost-campaign-lease')
      // 收件人狀態完全沒被動過。
      const snap = await getDoc(recipientRef)
      expect(snap.data()?.status).toBe('sending')
    })

    it('Function 模擬 crash 後（sending 過期、沒人來得及寫回結果），sweep 之後配合 decideCampaignStatus 會落在 needs_review，其他 queued 收件人仍可正常處理', async () => {
      const { campaignRef, generation } = await seedCampaignWithActiveLease(
        'crash-then-needs-review',
        'attempt-crashed',
      )
      const stuckRef = doc(campaignRef, 'recipients', 'stuck')
      const okRef = doc(campaignRef, 'recipients', 'ok')
      await setDoc(stuckRef, { status: 'queued', attemptCount: 0 })
      await setDoc(okRef, { status: 'queued', attemptCount: 0 })

      // stuck：認領、beginDeliveryAttempt，之後「crash」——沒有任何後續寫入
      await claim(
        stuckRef,
        campaignRef,
        'attempt-crashed',
        generation,
      )
      await beginDeliveryAttempt(stuckRef, campaignRef, 'attempt-crashed', generation)
      await setDoc(stuckRef, { leaseExpiresAtMs: Date.now() - 1 }, { merge: true })

      // ok：同一個 invocation（同一個 campaign attemptId）正常處理完成
      const claimedOk = await claim(
        okRef,
        campaignRef,
        'attempt-crashed',
        generation,
      )
      expect(claimedOk.claimable).toBe(true)
      await beginDeliveryAttempt(okRef, campaignRef, 'attempt-crashed', generation)
      await commitResult(okRef, campaignRef, 'attempt-crashed', generation, { status: 'sent' })

      // sweep：對應 functions/src/index.ts 的 sweepExpiredDeliveryAttempts()
      const sweepDecision = await reclaimExpiredDeliveryAttempt(
        stuckRef,
        campaignRef,
        'attempt-crashed',
        generation,
        Date.now(),
        '寄送租約已過期，SMTP 可能已經開始但無法確認結果',
      )
      expect(sweepDecision.outcome).toBe('marked-unknown')

      // sweep 之後 other 仍然可以正常被 claim（沒有互相干擾）
      const otherStillQueued = doc(campaignRef, 'recipients', 'another')
      await setDoc(otherStillQueued, { status: 'queued', attemptCount: 0 })
      const claimAnother = await claim(
        otherStillQueued,
        campaignRef,
        'attempt-crashed',
        generation,
      )
      expect(claimAnother.claimable).toBe(true)
    })
  })

  describe('round 8／round 9（Finding 2／Finding 4）：resolveDeliveryUnknown 的人工 resolution（真實 Firestore transaction concurrency）', () => {
    let nextLeaseAttemptId = 0
    /** 每個 resolveDeliveryUnknown 呼叫需要自己的鎖 token（跟 resolutionId 不同概念，見 shared/campaignSend.ts 的說明）。 */
    function newLeaseAttemptId() {
      nextLeaseAttemptId += 1
      return `lease-attempt-${nextLeaseAttemptId}`
    }

    /**
     * round 9：故意讓 seed 進去的 campaign.totals 可以跟真實的 recipients
     * 子集合不一致（甚至完全不給）——這正是 Finding 2 要驗證的：
     * decideResolveDeliveryUnknown 不再信任這個欄位，authoritative totals
     * 一律從真實查詢來，即使 campaign.totals 是空的、錯的、缺欄位的，
     * resolution 的結果都要正確。
     */
    async function seedNeedsReviewCampaign(id: string, staleTotals?: Record<string, unknown>) {
      const ref = doc(db, 'campaigns', id)
      await setDoc(ref, {
        status: 'needs_review',
        recipientsReady: true,
        ...(staleTotals ? { totals: staleTotals } : {}),
      })
      return ref
    }

    it('admin mark_delivered：delivery_unknown → sent，campaign totals／status 依照真實 recipients 分佈重算', async () => {
      const campaignRef = await seedNeedsReviewCampaign('resolve-mark-delivered')
      const recipientRef = doc(campaignRef, 'recipients', 'r1')
      await setDoc(recipientRef, { status: 'delivery_unknown', attemptId: 'orig' })

      const decision = await resolveDeliveryUnknown(
        recipientRef,
        campaignRef,
        {
          resolvedBy: 'admin@x.com',
          resolutionId: 'res-001',
          resolutionAction: 'mark_delivered',
          resolutionReason: '已電話確認',
        },
        newLeaseAttemptId(),
      )
      expect(decision.outcome).toBe('resolved')

      const recipientSnap = await getDoc(recipientRef)
      expect(recipientSnap.data()?.status).toBe('sent')
      expect(recipientSnap.data()?.resolvedBy).toBe('admin@x.com')
      expect(recipientSnap.data()?.resolutionId).toBe('res-001')

      const campaignSnap = await getDoc(campaignRef)
      expect(campaignSnap.data()?.status).toBe('completed')
      expect(campaignSnap.data()?.totals.sent).toBe(1)
      expect(campaignSnap.data()?.totals.deliveryUnknown).toBe(0)
      // resolution 租約已經釋放，不會卡住後續的一般寄送或另一次 resolution
      expect(campaignSnap.data()?.resolutionLeaseAttemptId).toBeUndefined()
    })

    // round 9 核心情境（Finding 2）：campaign.totals 完全沒寫（或跟真實
    // 狀態不同步），resolution 仍然必須正確——因為它現在查真實的
    // recipients 子集合，不是讀 campaign.totals。
    it('campaign.totals 完全缺失（例如上一輪 finalize 前 crash）→ resolution 仍然依照真實 recipients 分佈正確運作', async () => {
      const campaignRef = await seedNeedsReviewCampaign('resolve-missing-totals') // 沒有 totals 欄位
      const r1 = doc(campaignRef, 'recipients', 'r1')
      const r2 = doc(campaignRef, 'recipients', 'r2')
      await setDoc(r1, { status: 'sent' })
      await setDoc(r2, { status: 'delivery_unknown', attemptId: 'orig' })

      const decision = await resolveDeliveryUnknown(
        r2,
        campaignRef,
        {
          resolvedBy: 'admin@x.com',
          resolutionId: 'res-002',
          resolutionAction: 'mark_delivered',
          resolutionReason: '已電話確認',
        },
        newLeaseAttemptId(),
      )
      expect(decision.outcome).toBe('resolved')
      const campaignSnap = await getDoc(campaignRef)
      expect(campaignSnap.data()?.status).toBe('completed')
      expect(campaignSnap.data()?.totals).toEqual({
        recipients: 2,
        sent: 2,
        failed: 0,
        exhausted: 0,
        deliveryUnknown: 0,
      })
    })

    // round 9 核心情境（Finding 2 的原始舉例）：recipient 已經真的是
    // delivery_unknown，但 campaign.totals.deliveryUnknown 因為上一輪
    // crash 還停在 0——舊版邏輯會把 0 減成 -1，新版必須正確處理。
    it('recipient 真的是 delivery_unknown，但 campaign.totals.deliveryUnknown 是 0（過期快取）→ 不會產生負數，authoritative 查詢會蓋掉這個錯誤的快取值', async () => {
      const campaignRef = await seedNeedsReviewCampaign('resolve-stale-zero', {
        recipients: 1,
        sent: 0,
        failed: 0,
        exhausted: 0,
        deliveryUnknown: 0, // 跟真實狀態不一致的過期快取
      })
      const recipientRef = doc(campaignRef, 'recipients', 'r1')
      await setDoc(recipientRef, { status: 'delivery_unknown', attemptId: 'orig' })

      const decision = await resolveDeliveryUnknown(
        recipientRef,
        campaignRef,
        {
          resolvedBy: 'admin@x.com',
          resolutionId: 'res-003',
          resolutionAction: 'mark_delivered',
          resolutionReason: '已電話確認',
        },
        newLeaseAttemptId(),
      )
      expect(decision.outcome).toBe('resolved')
      const campaignSnap = await getDoc(campaignRef)
      const totals = campaignSnap.data()?.totals as { sent: number; deliveryUnknown: number }
      expect(totals.deliveryUnknown).toBeGreaterThanOrEqual(0)
      expect(totals.deliveryUnknown).toBe(0)
      expect(totals.sent).toBe(1)
    })

    // round 12 修正（Finding 1）：這個測試過去直接用一個手寫的假 generation
    // （1）呼叫 claim，斷言 claimable:true，理由寫著「claimRecipientTx 本身
    // 不驗證 campaign 層級的東西」——這跟 round 11 的核心修正完全相反：
    // claimRecipientTx 現在必須驗證合法的 campaign 處理租約才能認領。
    // resolution 完成後 campaign 完全沒有 activeAttemptId（resolution 從不
    // 取得處理租約），所以在沒有人先呼叫 acquireCampaignLeaseTx 之前，
    // claim 必須被拒絕（campaign-ownership-lost）；要讓 claim 成功，必須
    // 先走 production 實際會走的路徑——像 retryCampaign 一樣，先用
    // acquireCampaignLeaseTx 正常取得處理租約，再用它回傳的真實 generation
    // 呼叫 claim，不能手寫假的 generation 值。
    it('admin force_retry：delivery_unknown → failed，campaign 變成 partial——沒有合法 processing lease 時 claim 被拒絕；用 acquireCampaignLeaseTx 取得真實租約後，這位收件人才能被重新認領', async () => {
      const campaignRef = await seedNeedsReviewCampaign('resolve-force-retry')
      const recipientRef = doc(campaignRef, 'recipients', 'r1')
      await setDoc(recipientRef, { status: 'delivery_unknown', attemptId: 'orig' })

      const decision = await resolveDeliveryUnknown(
        recipientRef,
        campaignRef,
        {
          resolvedBy: 'admin@x.com',
          resolutionId: 'res-004',
          resolutionAction: 'force_retry',
          resolutionReason: '承擔重複風險，客戶要求',
        },
        newLeaseAttemptId(),
      )
      expect(decision.outcome).toBe('resolved')

      const campaignSnap = await getDoc(campaignRef)
      expect(campaignSnap.data()?.status).toBe('partial')
      expect(campaignSnap.data()?.activeAttemptId).toBeUndefined()

      // 還沒有人取得處理租約——claim 必須被拒絕，明確的 reason 是
      // campaign-ownership-lost（campaign 存在，但 activeAttemptId 不是
      // 呼叫端）。
      const claimWithoutLease = await claim(recipientRef, campaignRef, 'attempt-retry', 1)
      expect(claimWithoutLease.claimable).toBe(false)
      expect(claimWithoutLease.reason).toBe('campaign-ownership-lost')

      // retryCampaign 的正常流程：先用 production 共用的
      // acquireCampaignLeaseTx 正常取得處理租約，拿到真實的 generation。
      const lease = await acquireLease(campaignRef, 'attempt-retry')
      expect(lease.outcome).toBe('acquired')
      const generation = expectGeneration(lease)

      const claimAfter = await claim(recipientRef, campaignRef, 'attempt-retry', generation)
      expect(claimAfter.claimable).toBe(true)
    })

    // round 9（Finding 4）：idempotent 重送——同一個 resolutionId、同樣的
    // action／reason——回傳原始結果，不重複扣減 totals。
    it('idempotent：同一個 resolutionId、同樣的 action／reason 重送 → idempotent-replay，不重複扣減 totals', async () => {
      const campaignRef = await seedNeedsReviewCampaign('resolve-idempotent')
      const recipientRef = doc(campaignRef, 'recipients', 'r1')
      await setDoc(recipientRef, { status: 'delivery_unknown', attemptId: 'orig' })

      const audit = {
        resolvedBy: 'admin@x.com',
        resolutionId: 'res-idempotent-001',
        resolutionAction: 'mark_delivered' as const,
        resolutionReason: '已電話確認',
      }
      const first = await resolveDeliveryUnknown(recipientRef, campaignRef, audit, newLeaseAttemptId())
      expect(first.outcome).toBe('resolved')

      const second = await resolveDeliveryUnknown(recipientRef, campaignRef, audit, newLeaseAttemptId())
      expect(second.outcome).toBe('idempotent-replay')
      if (second.outcome === 'idempotent-replay') {
        expect(second.recipientStatus).toBe('sent')
        expect(second.resolvedBy).toBe('admin@x.com')
      }

      // totals 沒有被重複扣減：只有一次 sent，不是兩次
      const campaignSnap = await getDoc(campaignRef)
      expect(campaignSnap.data()?.totals.sent).toBe(1)
      expect(campaignSnap.data()?.totals.deliveryUnknown).toBe(0)

      // round 21 新增（CI Finding 1 / 必要測試 1）：這個 campaign 在 first
      // resolve 之後已經是 terminal（completed）——第二次 idempotent-replay
      // 必須完全是 preflight 的 fast path 產生的結果，不能重新 acquire
      // 租約、不能再動 recipient、不能再建立第二份事件（zero writes）。
      expect(campaignSnap.data()?.status).toBe('completed')
      expect(campaignSnap.data()?.resolutionLeaseAttemptId).toBeUndefined()
      const recipientSnap = await getDoc(recipientRef)
      expect(recipientSnap.data()?.resolutionId).toBe('res-idempotent-001')
      const events = await getDocs(collection(campaignRef, 'resolutionEvents'))
      expect(events.size).toBe(1)
    })

    // round 21 新增（CI Finding 1 / 必要測試 2）：同一個 resolutionId、
    // 但這次帶著不同的 payload（不同 resolvedBy／action／reason）重送——
    // 不能被誤判成 idempotent replay，必須是 conflict；而且因為
    // resolutionEvents/{resolutionId} 已經存在，不論 recipient 現在是什麼
    // 狀態都必須 conflict（見 decideResolveDeliveryUnknownPreflight 的
    // 判斷順序：event 存在時先看 payload 是否相同，不看 recipient 狀態）。
    it('terminal campaign 上，同一個 resolutionId 但 payload 不同 → conflict（不是 idempotent-replay），zero writes', async () => {
      const campaignRef = await seedNeedsReviewCampaign('resolve-same-id-diff-payload')
      const recipientRef = doc(campaignRef, 'recipients', 'r1')
      await setDoc(recipientRef, { status: 'delivery_unknown', attemptId: 'orig' })

      const sharedResolutionId = 'res-same-id-diff-payload'
      const first = await resolveDeliveryUnknown(
        recipientRef,
        campaignRef,
        {
          resolvedBy: 'admin-a@x.com',
          resolutionId: sharedResolutionId,
          resolutionAction: 'mark_delivered',
          resolutionReason: 'A 確認',
        },
        newLeaseAttemptId(),
      )
      expect(first.outcome).toBe('resolved')

      const campaignAfterFirst = await getDoc(campaignRef)
      expect(campaignAfterFirst.data()?.status).toBe('completed')

      // 同一個 resolutionId，但 action／reason／resolvedBy 都跟第一次不同。
      const second = await resolveDeliveryUnknown(
        recipientRef,
        campaignRef,
        {
          resolvedBy: 'admin-b@x.com',
          resolutionId: sharedResolutionId,
          resolutionAction: 'force_retry',
          resolutionReason: '跟第一次不一樣的理由',
        },
        newLeaseAttemptId(),
      )
      expect(second.outcome).toBe('conflict')
      if (second.outcome === 'conflict') {
        expect(second.resolvedBy).toBe('admin-a@x.com')
        expect(second.resolutionAction).toBe('mark_delivered')
      }

      // zero writes：totals／status／resolutionEvents 都跟第一次結束時完全
      // 一樣，第二次呼叫沒有留下任何痕跡。
      const campaignSnap = await getDoc(campaignRef)
      expect(campaignSnap.data()?.totals).toEqual(campaignAfterFirst.data()?.totals)
      expect(campaignSnap.data()?.status).toBe('completed')
      const events = await getDocs(collection(campaignRef, 'resolutionEvents'))
      expect(events.size).toBe(1)
    })

    // round 9（Finding 4）：不同 resolutionId（或同 resolutionId 但不同
    // payload）→ conflict，附上實際的處理紀錄，不能靜默當成功。
    it('不同 resolutionId 的操作已經處理過同一位收件人 → conflict，附上實際處理人與 action，不是靜默成功', async () => {
      const campaignRef = await seedNeedsReviewCampaign('resolve-conflict')
      const recipientRef = doc(campaignRef, 'recipients', 'r1')
      await setDoc(recipientRef, { status: 'delivery_unknown', attemptId: 'orig' })

      const first = await resolveDeliveryUnknown(
        recipientRef,
        campaignRef,
        {
          resolvedBy: 'admin-a@x.com',
          resolutionId: 'res-a',
          resolutionAction: 'mark_delivered',
          resolutionReason: 'A 確認',
        },
        newLeaseAttemptId(),
      )
      expect(first.outcome).toBe('resolved')

      // admin B 之後才送出、帶著完全不同的 resolutionId（terminal campaign，
      // 見 round 21 新增 / 必要測試 3：不同 resolutionId、recipient 已經被
      // 處理過 → conflict，zero writes）。
      const second = await resolveDeliveryUnknown(
        recipientRef,
        campaignRef,
        {
          resolvedBy: 'admin-b@x.com',
          resolutionId: 'res-b',
          resolutionAction: 'force_retry',
          resolutionReason: 'B 確認',
        },
        newLeaseAttemptId(),
      )
      expect(second.outcome).toBe('conflict')
      if (second.outcome === 'conflict') {
        expect(second.resolvedBy).toBe('admin-a@x.com')
        expect(second.resolutionAction).toBe('mark_delivered')
      }

      // 只有第一次真的套用，totals 不會被算兩次；resolutionEvents 也只有
      // 第一次那一份，'res-b' 從沒被建立過（zero writes）。
      const campaignSnap = await getDoc(campaignRef)
      const totals = campaignSnap.data()?.totals as {
        sent: number
        failed: number
        deliveryUnknown: number
      }
      expect(totals.deliveryUnknown).toBe(0)
      expect(totals.sent + totals.failed).toBe(1)
      const events = await getDocs(collection(campaignRef, 'resolutionEvents'))
      expect(events.docs.map((d) => d.id)).toEqual(['res-a'])
    })

    // round 21 新增（CI Finding 4 / 必要測試 4）：resolutionEvents/{resolutionId}
    // 這份文件如果被外部工具或資料損毀直接寫壞（缺欄位、型別不對），
    // decideResolveDeliveryUnknownPreflight 必須 fail closed，回傳明確的
    // invalid-ledger-event，絕對不能誤判成 idempotent-replay 或忽略它、
    // 讓 recipient 被重新 resolve 一次。
    it('resolutionEvents 帳本文件損毀（缺必要欄位）→ invalid-ledger-event，fail closed，zero writes', async () => {
      const campaignRef = await seedNeedsReviewCampaign('resolve-corrupt-ledger')
      const recipientRef = doc(campaignRef, 'recipients', 'r1')
      await setDoc(recipientRef, { status: 'delivery_unknown', attemptId: 'orig' })

      const resolutionId = 'res-corrupt-ledger'
      // 直接寫一份缺少 resolutionAction／resolvedBy 等必要欄位的壞文件，
      // 繞過 resolveDeliveryUnknownTx 本來只會呼叫一次的 eventDoc.set()——
      // 模擬資料損毀／外部工具誤寫的情境。
      const eventRef = doc(campaignRef, 'resolutionEvents', resolutionId)
      await setDoc(eventRef, { recipientId: 'r1', beforeStatus: 'delivery_unknown' })

      const decision = await resolveDeliveryUnknown(
        recipientRef,
        campaignRef,
        {
          resolvedBy: 'admin@x.com',
          resolutionId,
          resolutionAction: 'mark_delivered',
          resolutionReason: '不應該真的套用',
        },
        newLeaseAttemptId(),
      )
      expect(decision.outcome).toBe('invalid-ledger-event')

      // zero writes：recipient／campaign 完全沒被動過，租約也沒被 acquire。
      const recipientSnap = await getDoc(recipientRef)
      expect(recipientSnap.data()?.status).toBe('delivery_unknown')
      expect(recipientSnap.data()?.resolvedBy).toBeUndefined()
      const campaignSnap = await getDoc(campaignRef)
      expect(campaignSnap.data()?.status).toBe('needs_review')
      expect(campaignSnap.data()?.resolutionLeaseAttemptId).toBeUndefined()
      expect(campaignSnap.data()?.totals).toBeUndefined()
    })

    it('兩個管理員同時對同一位收件人送出不同的 resolution → 只有一個真正生效（resolved），輸家收到真實已套用的結果（conflict），totals 不會被算兩次', async () => {
      const campaignRef = await seedNeedsReviewCampaign('resolve-concurrent')
      const recipientRef = doc(campaignRef, 'recipients', 'r1')
      await setDoc(recipientRef, { status: 'delivery_unknown', attemptId: 'orig' })

      const [r1, r2] = await Promise.all([
        resolveDeliveryUnknown(
          recipientRef,
          campaignRef,
          {
            resolvedBy: 'admin-a@x.com',
            resolutionId: 'res-concurrent-a',
            resolutionAction: 'mark_delivered',
            resolutionReason: 'A 確認',
          },
          newLeaseAttemptId(),
        ),
        resolveDeliveryUnknown(
          recipientRef,
          campaignRef,
          {
            resolvedBy: 'admin-b@x.com',
            resolutionId: 'res-concurrent-b',
            resolutionAction: 'force_retry',
            resolutionReason: 'B 確認',
          },
          newLeaseAttemptId(),
        ),
      ])
      // resolution 租約本身也是互斥的：兩個併發呼叫裡，其中一個會在
      // acquireResolutionLease 這一步就被擋下（resolution-lease-held），
      // 不會兩個都真的走到查詢＋transaction 那一步。
      const outcomes = [r1.outcome, r2.outcome].sort()
      expect(outcomes[1]).toBe('resolved')
      expect(['conflict', 'resolution-lease-held']).toContain(outcomes[0])

      // 不論哪一個贏，totals.deliveryUnknown 都只會被扣一次，sent+failed 加總只有 1
      const campaignSnap = await getDoc(campaignRef)
      const totals = campaignSnap.data()?.totals as {
        sent: number
        failed: number
        deliveryUnknown: number
      }
      expect(totals.deliveryUnknown).toBe(0)
      expect(totals.sent + totals.failed).toBe(1)
    })

    it('非 delivery_unknown 的收件人（例如已經是 sent，且沒有任何 resolution 紀錄）不可被 resolve → conflict', async () => {
      const campaignRef = await seedNeedsReviewCampaign('resolve-not-unknown', {
        recipients: 1,
        sent: 1,
        failed: 0,
        exhausted: 0,
        deliveryUnknown: 0,
      })
      const recipientRef = doc(campaignRef, 'recipients', 'r1')
      await setDoc(recipientRef, { status: 'sent' })

      const decision = await resolveDeliveryUnknown(
        recipientRef,
        campaignRef,
        {
          resolvedBy: 'admin@x.com',
          resolutionId: 'res-005',
          resolutionAction: 'mark_delivered',
          resolutionReason: 'x',
        },
        newLeaseAttemptId(),
      )
      expect(decision.outcome).toBe('conflict')
    })

    // round 9（Finding 2）：mutual exclusion 現在發生在 resolution 租約，
    // 不是舊版直接檢查 activeAttemptId。
    it('campaign 目前有其他仍然有效的處理租約（一般寄送正在跑）→ 取得 resolution 租約這一步就被擋下，不能跟正在跑的批次互相覆蓋 totals', async () => {
      const campaignRef = await seedNeedsReviewCampaign('resolve-lease-held')
      await setDoc(
        campaignRef,
        { activeAttemptId: 'someone-processing', activeLeaseExpiresAtMs: Date.now() + 60_000 },
        { merge: true },
      )
      const recipientRef = doc(campaignRef, 'recipients', 'r1')
      await setDoc(recipientRef, { status: 'delivery_unknown', attemptId: 'orig' })

      const decision = await resolveDeliveryUnknown(
        recipientRef,
        campaignRef,
        {
          resolvedBy: 'admin@x.com',
          resolutionId: 'res-006',
          resolutionAction: 'mark_delivered',
          resolutionReason: 'x',
        },
        newLeaseAttemptId(),
      )
      expect(decision.outcome).toBe('processing-lease-active')
      // 完全沒有寫入
      const recipientSnap = await getDoc(recipientRef)
      expect(recipientSnap.data()?.status).toBe('delivery_unknown')
    })

    // round 9 新增：反過來也要成立——resolution 進行中時，一般的
    // acquireCampaignLeaseTx（sendCampaign／retryCampaign 用的）也必須被擋下。
    it('resolution 租約進行中時，一般 acquireCampaignLeaseTx（等同 retryCampaign）會被擋下，兩者互斥', async () => {
      const campaignRef = await seedNeedsReviewCampaign('resolve-blocks-processing')
      await setDoc(campaignRef, { status: 'partial' }, { merge: true })
      const leaseAttemptId = newLeaseAttemptId()
      const acquired = await acquireResolutionLease(campaignRef, leaseAttemptId)
      expect(acquired.outcome).toBe('acquired')

      const processingAttempt = await acquireLease(campaignRef, 'retry-attempt')
      expect(processingAttempt.outcome).toBe('held-by-other')
    })

    it('最後一個 delivery_unknown 被處理完後，campaign 正確離開 needs_review', async () => {
      const campaignRef = await seedNeedsReviewCampaign('resolve-last-unknown')
      const r1 = doc(campaignRef, 'recipients', 'r1')
      const rUnknown = doc(campaignRef, 'recipients', 'r-unknown')
      await setDoc(r1, { status: 'sent' })
      await setDoc(rUnknown, { status: 'delivery_unknown', attemptId: 'orig' })

      const decision = await resolveDeliveryUnknown(
        rUnknown,
        campaignRef,
        {
          resolvedBy: 'admin@x.com',
          resolutionId: 'res-007',
          resolutionAction: 'mark_delivered',
          resolutionReason: 'x',
        },
        newLeaseAttemptId(),
      )
      expect(decision.outcome).toBe('resolved')
      const campaignSnap = await getDoc(campaignRef)
      expect(campaignSnap.data()?.status).toBe('completed')
      expect(campaignSnap.data()?.status).not.toBe('needs_review')
    })

    // Finding 2 必要測試：mark_delivered／force_retry 後 totals 必須等於
    // 真實 recipient 分佈——用多位收件人組成的真實分佈直接驗證，不是只驗證
    // 「有變動」。
    it('mark_delivered 後，campaign totals 精確等於真實 recipients 分佈（多位收件人混合狀態）', async () => {
      const campaignRef = await seedNeedsReviewCampaign('resolve-exact-totals-mark')
      await setDoc(doc(campaignRef, 'recipients', 'a'), { status: 'sent' })
      await setDoc(doc(campaignRef, 'recipients', 'b'), { status: 'failed' })
      await setDoc(doc(campaignRef, 'recipients', 'c'), { status: 'exhausted' })
      const target = doc(campaignRef, 'recipients', 'd')
      await setDoc(target, { status: 'delivery_unknown', attemptId: 'orig' })

      await resolveDeliveryUnknown(
        target,
        campaignRef,
        {
          resolvedBy: 'admin@x.com',
          resolutionId: 'res-exact-mark',
          resolutionAction: 'mark_delivered',
          resolutionReason: 'x',
        },
        newLeaseAttemptId(),
      )

      const campaignSnap = await getDoc(campaignRef)
      expect(campaignSnap.data()?.totals).toEqual({
        recipients: 4,
        sent: 2,
        failed: 1,
        exhausted: 1,
        deliveryUnknown: 0,
      })
      // round 21 修正（CI 失敗 #4，stale test）：failed **不是**終止狀態——
      // countNonTerminalRecipients() 明確只排除 sent／exhausted／
      // delivery_unknown，failed 仍然算在 nonTerminalCount 裡，因為
      // retryCampaign 還能重新認領它繼續處理。這裡的分佈是
      // sent:2, failed:1, exhausted:1, deliveryUnknown:0，nonTerminalCount
      // 因此是 1（那位 failed 的收件人），decideCampaignStatus() 看到
      // nonTerminalCount>0 一律回傳 'partial'，不會是 'completed'——舊測試
      // 誤以為「所有人都到達某種最終狀態」等於「completed」，混淆了
      // 「這位收件人不會再被動」跟「這個 campaign 已經收尾完成」兩件事。
      expect(campaignSnap.data()?.status).toBe('partial')
    })

    it('force_retry 後，campaign totals 精確等於真實 recipients 分佈', async () => {
      const campaignRef = await seedNeedsReviewCampaign('resolve-exact-totals-force')
      await setDoc(doc(campaignRef, 'recipients', 'a'), { status: 'sent' })
      await setDoc(doc(campaignRef, 'recipients', 'b'), { status: 'sent' })
      const target = doc(campaignRef, 'recipients', 'c')
      await setDoc(target, { status: 'delivery_unknown', attemptId: 'orig' })

      await resolveDeliveryUnknown(
        target,
        campaignRef,
        {
          resolvedBy: 'admin@x.com',
          resolutionId: 'res-exact-force',
          resolutionAction: 'force_retry',
          resolutionReason: 'x',
        },
        newLeaseAttemptId(),
      )

      const campaignSnap = await getDoc(campaignRef)
      expect(campaignSnap.data()?.totals).toEqual({
        recipients: 3,
        sent: 2,
        failed: 1,
        exhausted: 0,
        deliveryUnknown: 0,
      })
      expect(campaignSnap.data()?.status).toBe('partial') // failed 是非終止，可以被 retryCampaign 接手
    })
  })

  describe('round 10（Finding 1／2／3）：新增的併發驗證——遲到的舊 commit、resolution fencing、resolutionEvents 的 race safety', () => {
    // Finding 1：sweep 把 sending 轉成 delivery_unknown 之後，attemptId／
    // leaseExpiresAtMs 都已經被清掉，任何姍姍來遲的舊 commit（不論想寫
    // sent 還是 failed）都必須被拒絕，delivery_unknown 不能被悄悄蓋掉。
    it('sweep 之後，姍姍來遲的舊 commit（status: sent）必須被拒絕，不能覆寫 delivery_unknown', async () => {
      const { campaignRef, generation } = await seedCampaignWithActiveLease(
        'finding1-sweep-then-late-sent-commit',
        'attempt-A',
      )
      const recipientRef = doc(campaignRef, 'recipients', 'r1')
      await setDoc(recipientRef, { status: 'queued', attemptCount: 0 })
      await claim(
        recipientRef,
        campaignRef,
        'attempt-A',
        generation,
      )
      await beginDeliveryAttempt(recipientRef, campaignRef, 'attempt-A', generation)
      await setDoc(recipientRef, { leaseExpiresAtMs: Date.now() - 1 }, { merge: true })

      const sweep = await reclaimExpiredDeliveryAttempt(
        recipientRef,
        campaignRef,
        'attempt-A',
        generation,
        Date.now(),
        'sweep',
      )
      expect(sweep.outcome).toBe('marked-unknown')

      // SMTP 其實真的成功了，姍姍來遲的 commit 想把結果寫回 sent。
      const lateCommit = await commitResult(recipientRef, campaignRef, 'attempt-A', generation, {
        status: 'sent',
      })
      expect(lateCommit.applied).toBe(false)

      const snap = await getDoc(recipientRef)
      expect(snap.data()?.status).toBe('delivery_unknown')
    })

    it('sweep 之後，姍姍來遲的舊 commit（status: failed）同樣必須被拒絕', async () => {
      const { campaignRef, generation } = await seedCampaignWithActiveLease(
        'finding1-sweep-then-late-failed-commit',
        'attempt-A',
      )
      const recipientRef = doc(campaignRef, 'recipients', 'r1')
      await setDoc(recipientRef, { status: 'queued', attemptCount: 0 })
      await claim(
        recipientRef,
        campaignRef,
        'attempt-A',
        generation,
      )
      await beginDeliveryAttempt(recipientRef, campaignRef, 'attempt-A', generation)
      await setDoc(recipientRef, { leaseExpiresAtMs: Date.now() - 1 }, { merge: true })

      const sweep = await reclaimExpiredDeliveryAttempt(
        recipientRef,
        campaignRef,
        'attempt-A',
        generation,
        Date.now(),
        'sweep',
      )
      expect(sweep.outcome).toBe('marked-unknown')

      const lateCommit = await commitResult(recipientRef, campaignRef, 'attempt-A', generation, {
        status: 'failed',
        lastError: 'A 遲來的錯誤回報',
      })
      expect(lateCommit.applied).toBe(false)

      // round 21 修正（CI 失敗 #5，stale test）：sweep 呼叫時明確傳入
      // errorMessage="sweep"，decideReclaimExpiredDeliveryAttempt 的 patch
      // 會把它寫進 lastError（見 shared/campaignSend.ts 該函式）——sweep
      // 之後 recipient 已經不再持有 attemptId／lease，任何遲到的舊 commit
      // （不論想寫的是自己的 lastError「A 遲來的錯誤回報」還是別的）都必須
      // 被拒絕、完全不能生效，所以 lastError 應該仍然停留在 sweep 當時寫入
      // 的 'sweep'，而不是變成 undefined（舊測試的期望）或被遲到 commit 的
      // 'A 遲來的錯誤回報' 蓋掉（兩者都代表遲到的 commit 錯誤地生效了）。
      const snap = await getDoc(recipientRef)
      expect(snap.data()?.status).toBe('delivery_unknown')
      expect(snap.data()?.lastError).toBe('sweep')
      expect(snap.data()?.lastError).not.toBe('A 遲來的錯誤回報')
      // sweep 清掉的 attemptId／lease 欄位也必須維持在安全的 post-sweep
      // 狀態，沒有被遲到的 commit 動過。
      expect(snap.data()?.attemptId ?? null).toBeNull()
      expect(snap.data()?.leaseExpiresAtMs ?? null).toBeNull()
    })

    it('mark_delivered resolution 之後，姍姍來遲的舊 SMTP commit 不可覆寫人工決定的結果', async () => {
      const { campaignRef, generation } = await seedCampaignWithActiveLease(
        'finding1-mark-delivered-then-late-commit',
        'attempt-A',
      )
      const recipientRef = doc(campaignRef, 'recipients', 'r1')
      await setDoc(recipientRef, { status: 'queued', attemptCount: 0 })
      await claim(
        recipientRef,
        campaignRef,
        'attempt-A',
        generation,
      )
      await beginDeliveryAttempt(recipientRef, campaignRef, 'attempt-A', generation)
      await setDoc(recipientRef, { leaseExpiresAtMs: Date.now() - 1 }, { merge: true })
      const sweep = await reclaimExpiredDeliveryAttempt(
        recipientRef,
        campaignRef,
        'attempt-A',
        generation,
        Date.now(),
        'sweep',
      )
      expect(sweep.outcome).toBe('marked-unknown')
      // 正常收尾（finalize）釋放處理租約，讓 resolution 租約可以合法取得。
      const { totals, nonTerminalCount } = await computeTotals(campaignRef)
      await finalize(campaignRef, 'attempt-A', generation, totals, nonTerminalCount)

      const resolveResult = await resolveDeliveryUnknown(
        recipientRef,
        campaignRef,
        {
          resolvedBy: 'admin@x.com',
          resolutionId: 'res-finding1-mark-delivered',
          resolutionAction: 'mark_delivered',
          resolutionReason: '已電話確認',
        },
        'lease-finding1-mark-delivered',
      )
      expect(resolveResult.outcome).toBe('resolved')

      // 舊的 attempt-A 姍姍來遲，attemptId 早就被清掉、campaign 也已經
      // finalize 過（activeAttemptId 不再是它），必須被拒絕。
      const lateCommit = await commitResult(recipientRef, campaignRef, 'attempt-A', generation, {
        status: 'sent',
      })
      expect(lateCommit.applied).toBe(false)

      const snap = await getDoc(recipientRef)
      expect(snap.data()?.resolutionAction).toBe('mark_delivered')
      expect(snap.data()?.status).toBe('sent')
    })

    it('force_retry resolution 之後，姍姍來遲的舊 SMTP commit 不可覆寫人工決定的結果', async () => {
      const { campaignRef, generation } = await seedCampaignWithActiveLease(
        'finding1-force-retry-then-late-commit',
        'attempt-A',
      )
      const recipientRef = doc(campaignRef, 'recipients', 'r1')
      await setDoc(recipientRef, { status: 'queued', attemptCount: 0 })
      await claim(
        recipientRef,
        campaignRef,
        'attempt-A',
        generation,
      )
      await beginDeliveryAttempt(recipientRef, campaignRef, 'attempt-A', generation)
      await setDoc(recipientRef, { leaseExpiresAtMs: Date.now() - 1 }, { merge: true })
      const sweep = await reclaimExpiredDeliveryAttempt(
        recipientRef,
        campaignRef,
        'attempt-A',
        generation,
        Date.now(),
        'sweep',
      )
      expect(sweep.outcome).toBe('marked-unknown')
      const { totals, nonTerminalCount } = await computeTotals(campaignRef)
      await finalize(campaignRef, 'attempt-A', generation, totals, nonTerminalCount)

      const resolveResult = await resolveDeliveryUnknown(
        recipientRef,
        campaignRef,
        {
          resolvedBy: 'admin@x.com',
          resolutionId: 'res-finding1-force-retry',
          resolutionAction: 'force_retry',
          resolutionReason: '承擔重複風險',
        },
        'lease-finding1-force-retry',
      )
      expect(resolveResult.outcome).toBe('resolved')

      const lateCommit = await commitResult(recipientRef, campaignRef, 'attempt-A', generation, {
        status: 'sent',
      })
      expect(lateCommit.applied).toBe(false)

      const snap = await getDoc(recipientRef)
      expect(snap.data()?.resolutionAction).toBe('force_retry')
      expect(snap.data()?.status).toBe('failed')
    })

    it('campaign 處理租約已經過期時，即使 recipient 這一層完全正常，也不能 commit', async () => {
      const { campaignRef, generation } = await seedCampaignWithActiveLease(
        'finding1-campaign-lease-expired-commit',
        'attempt-A',
      )
      const recipientRef = doc(campaignRef, 'recipients', 'r1')
      await setDoc(recipientRef, { status: 'queued', attemptCount: 0 })
      await claim(
        recipientRef,
        campaignRef,
        'attempt-A',
        generation,
      )
      await beginDeliveryAttempt(recipientRef, campaignRef, 'attempt-A', generation)

      await setDoc(campaignRef, { activeLeaseExpiresAtMs: Date.now() - 1 }, { merge: true })

      const commit = await commitResult(recipientRef, campaignRef, 'attempt-A', generation, {
        status: 'sent',
      })
      expect(commit).toEqual({ applied: false, reason: 'campaign-lease-expired' })
    })

    it('campaign 處理租約已經被另一個 invocation 接手 → 舊 invocation 的 commit 必須被拒絕', async () => {
      const { campaignRef, generation } = await seedCampaignWithActiveLease(
        'finding1-campaign-ownership-lost-commit',
        'attempt-A',
      )
      const recipientRef = doc(campaignRef, 'recipients', 'r1')
      await setDoc(recipientRef, { status: 'queued', attemptCount: 0 })
      await claim(
        recipientRef,
        campaignRef,
        'attempt-A',
        generation,
      )
      await beginDeliveryAttempt(recipientRef, campaignRef, 'attempt-A', generation)

      await setDoc(campaignRef, { activeLeaseExpiresAtMs: Date.now() - 1 }, { merge: true })
      const takeover = await acquireLease(campaignRef, 'attempt-B')
      expect(takeover.outcome).toBe('acquired')

      const commit = await commitResult(recipientRef, campaignRef, 'attempt-A', generation, {
        status: 'sent',
      })
      expect(commit).toEqual({ applied: false, reason: 'campaign-ownership-lost' })
    })

    // Finding 2 核心：generation 是唯一同時涵蓋「新的 processing invocation
    // 接手」與「resolution 正在進行中」兩種情況的欄位——即使 activeAttemptId
    // 字串、兩層租約時間都完全沒被動過，只要 generation 不符，commit 一樣
    // 必須被拒絕。這裡直接種出這個精確組合，單獨驗證這一關本身。
    it('campaign.leaseGeneration 已經被推進過（不論是新的 processing invocation 還是 resolution 取得過），即使 activeAttemptId／租約時間本身完全沒被動過，commit 也必須被拒絕', async () => {
      const campaignRef = doc(db, 'campaigns', 'finding2-generation-mismatch-commit')
      const recipientRef = doc(campaignRef, 'recipients', 'r1')
      const future = Date.now() + 60_000
      await setDoc(campaignRef, {
        status: 'sending',
        recipientsReady: true,
        activeAttemptId: 'attempt-A',
        activeLeaseExpiresAtMs: future,
        leaseGeneration: 5, // 已經被別的 acquire（不論 processing 或 resolution）推進過
      })
      await setDoc(recipientRef, {
        status: 'sending',
        attemptId: 'attempt-A',
        leaseExpiresAtMs: future,
        attemptCount: 1,
      })

      // attempt-A 自己記得的 generation 是它當初 acquire 時拿到的值（3），
      // 跟 campaign 現在的 5 不同。
      const commit = await commitResult(recipientRef, campaignRef, 'attempt-A', 3, {
        status: 'sent',
      })
      expect(commit).toEqual({ applied: false, reason: 'campaign-generation-mismatch' })
    })

    // Finding 3（真實 Firestore transaction）：完整走一輪「force_retry →
    // 一般流程重新認領、寄送、又逾時 → sweep → 第二次進入 delivery_unknown」
    // 的真實序列，證明 R1 遲到的重放不會被誤判成對第二輪的新授權，必須用
    // 全新的 R2 才能真正處理第二輪；resolutionEvents 保留兩輪完整歷史。
    it('R1 用於第一輪 force_retry，收件人第二輪又進入 delivery_unknown 後，R1 遲到的重放只會被當成對第一輪的 idempotent 回放，不會套用在第二輪；必須用新的 R2 才能處理第二輪，resolutionEvents 保留兩輪完整歷史', async () => {
      const campaignRef = doc(db, 'campaigns', 'finding3-multi-cycle')
      await setDoc(campaignRef, { status: 'needs_review', recipientsReady: true })
      const recipientRef = doc(campaignRef, 'recipients', 'r1')
      await setDoc(recipientRef, { status: 'delivery_unknown', attemptId: 'orig-1' })

      // 第一輪：R1 force_retry。
      const first = await resolveDeliveryUnknown(
        recipientRef,
        campaignRef,
        {
          resolvedBy: 'admin@x.com',
          resolutionId: 'R1',
          resolutionAction: 'force_retry',
          resolutionReason: '第一輪確認',
        },
        'lease-cycle-1',
      )
      expect(first.outcome).toBe('resolved')

      // 第一輪之後 recipient 變成 failed，真實走一般流程重新認領、寄送、
      // 又逾時，第二輪再次進入 delivery_unknown。
      const cycle2Lease = await acquireLease(campaignRef, 'attempt-retry')
      const gen2 = expectGeneration(cycle2Lease)
      const claimed = await claim(
        recipientRef,
        campaignRef,
        'attempt-retry',
        gen2,
      )
      expect(claimed.claimable).toBe(true)
      const begin = await beginDeliveryAttempt(recipientRef, campaignRef, 'attempt-retry', gen2)
      expect(begin.applied).toBe(true)
      await setDoc(recipientRef, { leaseExpiresAtMs: Date.now() - 1 }, { merge: true })
      const sweep = await reclaimExpiredDeliveryAttempt(
        recipientRef,
        campaignRef,
        'attempt-retry',
        gen2,
        Date.now(),
        '第二輪逾時',
      )
      expect(sweep.outcome).toBe('marked-unknown')
      const { totals: totals2, nonTerminalCount: nonTerminal2 } = await computeTotals(campaignRef)
      const finalize2 = await finalize(campaignRef, 'attempt-retry', gen2, totals2, nonTerminal2)
      expect(finalize2.outcome).toBe('needs_review') // 又卡在 delivery_unknown

      // R1 遲到的重放請求抵達——這個 resolutionId 早就被用過（第一輪的
      // event 仍然存在），必須被當成對第一輪的 idempotent 回放，不能被
      // 誤判成對「現在」這個第二輪 delivery_unknown 的新授權。
      const r1Replay = await resolveDeliveryUnknown(
        recipientRef,
        campaignRef,
        {
          resolvedBy: 'admin@x.com',
          resolutionId: 'R1',
          resolutionAction: 'force_retry',
          resolutionReason: '第一輪確認',
        },
        'lease-cycle-1-replay',
      )
      expect(r1Replay.outcome).toBe('idempotent-replay')

      // 收件人「現在」（第二輪）仍然停留在 delivery_unknown，完全沒有被
      // R1 的重放動過。
      const afterReplay = await getDoc(recipientRef)
      expect(afterReplay.data()?.status).toBe('delivery_unknown')

      // 必須用一個全新的 resolutionId（R2）才能真正處理第二輪。
      const second = await resolveDeliveryUnknown(
        recipientRef,
        campaignRef,
        {
          resolvedBy: 'admin@x.com',
          resolutionId: 'R2',
          resolutionAction: 'mark_delivered',
          resolutionReason: '第二輪確認',
        },
        'lease-cycle-2',
      )
      expect(second.outcome).toBe('resolved')
      const finalSnap = await getDoc(recipientRef)
      expect(finalSnap.data()?.status).toBe('sent')

      // resolutionEvents 保留兩輪完整歷史，各自只有一份、彼此互不覆蓋。
      const events = await getDocs(collection(campaignRef, 'resolutionEvents'))
      expect(events.docs.map((d) => d.id).sort()).toEqual(['R1', 'R2'])
    })

    // Finding 3：兩個請求帶著「完全相同」的 resolutionId 同時送出（例如
    // 使用者連點兩次、或前端重試造成的重複請求）——resolutionEvents 這份
    // immutable 文件只會被建立一次，不會有兩個都真正 resolve。
    it('兩個請求帶著同一個 resolutionId 同時送出（例如重複點擊）→ 只有一次真正 resolve，resolutionEvents 只有一份紀錄', async () => {
      const campaignRef = doc(db, 'campaigns', 'finding3-concurrent-same-id')
      await setDoc(campaignRef, { status: 'needs_review', recipientsReady: true })
      const recipientRef = doc(campaignRef, 'recipients', 'r1')
      await setDoc(recipientRef, { status: 'delivery_unknown', attemptId: 'orig' })

      const audit = {
        resolvedBy: 'admin@x.com',
        resolutionId: 'res-race-same-id',
        resolutionAction: 'mark_delivered' as const,
        resolutionReason: '兩個分頁同時送出同一次操作',
      }
      const [r1, r2] = await Promise.all([
        resolveDeliveryUnknown(recipientRef, campaignRef, audit, 'lease-race-a'),
        resolveDeliveryUnknown(recipientRef, campaignRef, audit, 'lease-race-b'),
      ])
      const outcomes = [r1.outcome, r2.outcome].sort()
      // 兩者用完全相同的 payload：贏得 resolution 租約的那個會 resolved；
      // 沒搶到租約的那個要嘛在 acquire 階段就被擋下（resolution-lease-held），
      // 要嘛剛好排到租約釋放後才執行、看到 event 已存在而回報
      // idempotent-replay——兩種都安全，唯獨「兩個都 resolved」不能接受。
      expect(outcomes).not.toEqual(['resolved', 'resolved'])
      expect(outcomes[1]).toBe('resolved')
      expect(['idempotent-replay', 'resolution-lease-held']).toContain(outcomes[0])

      const events = await getDocs(collection(campaignRef, 'resolutionEvents'))
      expect(events.size).toBe(1)
    })
  })

  describe('round 11（Finding 1）：claimRecipientTx 的 campaign fencing——resolution 的 authoritative query 不能再被舊 invocation 的 claim 穿插', () => {
    // 完整重現使用者回報的時序：舊 invocation A 曾以 generation=1 持有處理
    // 租約，租約過期後 resolution 取得租約（generation 推進為 2）、查詢到
    // 一份 authoritative totals；A 在這之後才呼叫 claim——如果 claim 不讀
    // campaign，就會在 resolution 的 transaction 尚未寫入前，悄悄把 r1
    // 從 failed 改成 claimed，讓 resolution 隨後寫入的 totals 跟
    // recipients 子集合的真實狀態脫鉤。
    it('resolution 已取得 generation=2 並完成 authoritative query 後，舊 generation=1 的 claim 無法把 failed 改成 claimed；recipient 狀態／attemptCount 均不變；resolution 寫回後 totals 與重新查詢完全一致', async () => {
      const campaignRef = doc(db, 'campaigns', 'finding1-claim-vs-resolution')
      await setDoc(campaignRef, {
        status: 'needs_review',
        recipientsReady: true,
        activeAttemptId: 'attempt-A',
        activeLeaseExpiresAtMs: Date.now() - 1000, // A 的租約已經過期
        leaseGeneration: 1,
      })
      const recipientRef = doc(campaignRef, 'recipients', 'r1')
      await setDoc(recipientRef, { status: 'failed', attemptCount: 1 })
      const unknownRef = doc(campaignRef, 'recipients', 'r2')
      await setDoc(unknownRef, { status: 'delivery_unknown', attemptId: 'orig' })

      // resolution 取得租約，generation 往前推進為 2。
      const leaseResult = await acquireResolutionLease(campaignRef, 'resolution-attempt-1')
      expect(leaseResult.outcome).toBe('acquired')
      expect(leaseResult).toMatchObject({ generation: 2 })

      // resolution 查詢當下真實的收件人分佈（在自己的 transaction 之前）。
      const { totals, nonTerminalCount } = await computeTotals(campaignRef)

      // A 在這之後才呼叫 claim，帶著自己（舊）的 generation=1。
      //
      // round 21 修正（CI 失敗 #6，stale test，非 production bug）：這個
      // fixture 同時讓兩個 reject 條件成立——(a) campaign.activeLeaseExpiresAtMs
      // 已經過期（seed 時特意設成 Date.now()-1000），(b) resolution 已經把
      // leaseGeneration 從 1 推進到 2，A 帶著舊的 generation=1 送出。
      // decideRecipientClaim（shared/campaignSend.ts）的檢查順序固定是
      // ownership → lease-active → generation，租約過期的檢查排在
      // generation 之前，所以先命中的一定是 campaign-lease-expired，不會
      // 走到 campaign-generation-mismatch 那個分支——這不是需要修的
      // production bug，只是舊測試期望了一個跟現有 precedence 不符的字串。
      // 是否應該把 generation 檢查移到 lease-active 之前？沒有理由這麼做：
      // 兩個檢查都是 fail closed，最終結果（claimable:false、recipient
      // 完全不被動）完全相同，調換順序不會改變安全性，只會讓 reason 字串
      // 換一個，卻要冒著打亂其他依賴這個順序／這個字串的呼叫端與測試的
      // 風險（見下面 tests/campaignSend.test.ts 新增的 generation-mismatch
      // 獨立案例，那裡才是真正測「generation 不符、但租約仍然有效」這個
      // 條件的地方，不會跟 lease-expired 混在一起）。
      const staleClaim = await claim(recipientRef, campaignRef, 'attempt-A', 1)
      expect(staleClaim.claimable).toBe(false)
      expect(staleClaim.reason).toBe('campaign-lease-expired')

      const afterStaleClaim = await getDoc(recipientRef)
      expect(afterStaleClaim.data()?.status).toBe('failed')
      expect(afterStaleClaim.data()?.attemptCount).toBe(1)

      // resolution 的 transaction 隨後正常寫入剛才查到的 totals。
      const eventRef = doc(campaignRef, 'resolutionEvents', 'res-finding1')
      const resolveResult = await runTransaction(db, (tx) =>
        resolveDeliveryUnknownTx(
          clientDocTx(tx, unknownRef),
          clientDocTx(tx, campaignRef),
          clientDocTx(tx, eventRef),
          unknownRef.id,
          totals,
          nonTerminalCount,
          {
            resolvedBy: 'admin@x.com',
            resolutionId: 'res-finding1',
            resolutionAction: 'mark_delivered',
            resolutionReason: '已電話確認',
          },
          'resolution-attempt-1',
          leaseResult.outcome === 'acquired' ? leaseResult.generation : -1,
          Date.now(),
        ),
      )
      expect(resolveResult.outcome).toBe('resolved')

      // campaign.totals 跟重新查詢 recipients 算出的結果完全一致——沒有
      // 被 A 的 stale claim 弄髒（因為它根本沒有機會寫入）。
      const campaignSnap = await getDoc(campaignRef)
      const { totals: reQueried } = await computeTotals(campaignRef)
      expect(campaignSnap.data()?.totals).toEqual(reQueried)
      expect(reQueried).toEqual({ recipients: 2, sent: 1, failed: 1, exhausted: 0, deliveryUnknown: 0 })
    })

    // 在這個情境下 claim 的 campaign 處理租約本來就已經過期，所以不論
    // Firestore 內部怎麼排序這兩個 transaction，claim 都不可能合法成功——
    // 這裡直接驗證這個不變量：只要 resolution 已經 acquired，claim 就不可能
    // 也 claimable，不會出現「兩者都成功」的情況。
    it('claim 與 resolution acquisition 同時競爭時，不會出現「resolution 成功且 stale claim 也成功」', async () => {
      const campaignRef = doc(db, 'campaigns', 'finding1-claim-vs-resolution-race')
      await setDoc(campaignRef, {
        status: 'needs_review',
        recipientsReady: true,
        activeAttemptId: 'attempt-A',
        activeLeaseExpiresAtMs: Date.now() - 1000,
        leaseGeneration: 1,
      })
      const recipientRef = doc(campaignRef, 'recipients', 'r1')
      await setDoc(recipientRef, { status: 'failed', attemptCount: 1 })

      const [resolutionResult, claimResult] = await Promise.all([
        acquireResolutionLease(campaignRef, 'resolution-attempt-race'),
        claim(recipientRef, campaignRef, 'attempt-A', 1),
      ])

      expect(resolutionResult.outcome).toBe('acquired')
      expect(claimResult.claimable).toBe(false)
    })

    it('合法且仍持有 campaign 處理租約／generation 的 claim 仍可正常成功（fencing 只擋下真正過期／被取代的，不是全面擋下）', async () => {
      const { campaignRef, generation } = await seedCampaignWithActiveLease(
        'finding1-claim-still-works',
        'attempt-A',
      )
      const recipientRef = doc(campaignRef, 'recipients', 'r1')
      await setDoc(recipientRef, { status: 'queued', attemptCount: 0 })
      const result = await claim(recipientRef, campaignRef, 'attempt-A', generation)
      expect(result.claimable).toBe(true)
    })
  })

  describe('round 11（Finding 2）／round 12（Finding 2）：attemptCount／lastAttemptAt 延後到 begin 才寫入，migration-safe（真實 Firestore）', () => {
    it('claim 成功、begin 因 campaign generation 改變而失敗 → attemptCount／lastAttemptAt／deliveryStartedAtMs 三者都不表示新 attempt，recipient 卡在 claimed（不是誤判成 sending）', async () => {
      const { campaignRef, generation } = await seedCampaignWithActiveLease(
        'finding2-begin-fail-no-count',
        'attempt-A',
      )
      const recipientRef = doc(campaignRef, 'recipients', 'r1')
      await setDoc(recipientRef, { status: 'queued', attemptCount: 0 })
      const claimed = await claim(recipientRef, campaignRef, 'attempt-A', generation)
      expect(claimed.claimable).toBe(true)

      // round 12（Finding 2）：claim 本身不再寫 lastAttemptAt。
      const afterClaimOnly = await getDoc(recipientRef)
      expect(afterClaimOnly.data()?.lastAttemptAt).toBeUndefined()
      expect(afterClaimOnly.data()?.deliveryStartedAtMs).toBeUndefined()

      // resolution 介入，generation 往前推進，但這個 invocation 完全不
      // 知道，繼續用自己原本的（舊）generation 呼叫 begin。
      await setDoc(campaignRef, { activeLeaseExpiresAtMs: Date.now() - 1 }, { merge: true })
      const takeover = await acquireResolutionLease(campaignRef, 'resolution-x')
      expect(takeover.outcome).toBe('acquired')

      const begin = await beginDeliveryAttempt(recipientRef, campaignRef, 'attempt-A', generation)
      expect(begin.applied).toBe(false)

      const snap = await getDoc(recipientRef)
      expect(snap.data()?.attemptCount ?? 0).toBe(0)
      expect(snap.data()?.status).toBe('claimed')
      // begin 失敗——lastAttemptAt／deliveryStartedAtMs 仍然完全不存在，
      // 不能宣稱發生過一次真正的 SMTP attempt。
      expect(snap.data()?.lastAttemptAt).toBeUndefined()
      expect(snap.data()?.deliveryStartedAtMs).toBeUndefined()
    })

    it('多次 pre-SMTP claim 成功但 begin 失敗，attemptCount 永遠是 0，不會提早消耗重試額度', async () => {
      const { campaignRef, generation } = await seedCampaignWithActiveLease(
        'finding2-repeated-begin-fail',
        'attempt-A',
      )
      const recipientRef = doc(campaignRef, 'recipients', 'r1')
      await setDoc(recipientRef, { status: 'queued', attemptCount: 0 })

      for (let i = 0; i < 5; i += 1) {
        // 每一輪重設回 queued，模擬重新可被認領；claim 用正確的
        // generation（成功），begin 故意用錯的 generation（一定失敗）。
        await setDoc(
          recipientRef,
          { status: 'queued', attemptId: null, leaseExpiresAtMs: null },
          { merge: true },
        )
        const claimed = await claim(recipientRef, campaignRef, 'attempt-A', generation)
        expect(claimed.claimable).toBe(true)
        const begin = await beginDeliveryAttempt(
          recipientRef,
          campaignRef,
          'attempt-A',
          generation + 999, // 故意錯的 generation，begin 一定失敗
        )
        expect(begin.applied).toBe(false)
      }
      const snap = await getDoc(recipientRef)
      expect(snap.data()?.attemptCount ?? 0).toBe(0)
    })

    it('新版本 claim（attemptCountPending:true）→ begin 成功時 attemptCount 從 0 累加為 1，恰好一次；lastAttemptAt／deliveryStartedAtMs 也是在這一刻才第一次出現', async () => {
      const { campaignRef, generation } = await seedCampaignWithActiveLease(
        'finding2-begin-increments-once',
        'attempt-A',
      )
      const recipientRef = doc(campaignRef, 'recipients', 'r1')
      await setDoc(recipientRef, { status: 'queued', attemptCount: 0 })

      const claimed = await claim(recipientRef, campaignRef, 'attempt-A', generation)
      expect(claimed.claimable).toBe(true)
      const afterClaim = await getDoc(recipientRef)
      expect(afterClaim.data()?.attemptCount ?? 0).toBe(0) // claim 本身不累加
      expect(afterClaim.data()?.attemptCountPending).toBe(true)
      // round 12（Finding 2）：claim 完全不寫 lastAttemptAt。
      expect(afterClaim.data()?.lastAttemptAt).toBeUndefined()

      const beforeBegin = Date.now()
      const begin = await beginDeliveryAttempt(recipientRef, campaignRef, 'attempt-A', generation)
      expect(begin.applied).toBe(true)
      if (begin.applied) {
        expect(begin.attemptCount).toBe(1)
      }
      const afterBegin = await getDoc(recipientRef)
      expect(afterBegin.data()?.attemptCount).toBe(1)
      expect(afterBegin.data()?.attemptCountPending).toBe(false)
      // lastAttemptAt／deliveryStartedAtMs 現在才第一次出現，跟 attemptCount
      // 累加是同一次 transaction、同一個時間點。
      expect(afterBegin.data()?.lastAttemptAt).toBeTruthy()
      expect(afterBegin.data()?.deliveryStartedAtMs).toBeGreaterThanOrEqual(beforeBegin - 1000)
    })

    // migration-safe：模擬部署切換當下卡住的 legacy claimed 文件——舊版本
    // 在 claim 當下就已經直接把 attemptCount 累加寫進去（沒有
    // attemptCountPending 這個欄位），新版本的 begin 絕對不能再對它加一次。
    it('legacy claimed 文件（沒有 attemptCountPending 欄位，模擬部署切換前就已經被舊版本 claim 過）→ begin 成功時不會重複累加 attemptCount', async () => {
      const { campaignRef, generation } = await seedCampaignWithActiveLease(
        'finding2-legacy-claimed-no-double-count',
        'attempt-A',
      )
      const recipientRef = doc(campaignRef, 'recipients', 'r1')
      await setDoc(recipientRef, {
        status: 'claimed',
        attemptId: 'attempt-A',
        leaseExpiresAtMs: Date.now() + RECIPIENT_LEASE_MS,
        attemptCount: 1, // 舊版本 claim 當下已經累加過
        // 沒有 attemptCountPending 欄位
      })

      const begin = await beginDeliveryAttempt(recipientRef, campaignRef, 'attempt-A', generation)
      expect(begin.applied).toBe(true)
      if (begin.applied) {
        expect(begin.attemptCount).toBe(1) // 不是 2——沒有被重複累加
      }
      const snap = await getDoc(recipientRef)
      expect(snap.data()?.attemptCount).toBe(1)
      expect(snap.data()?.status).toBe('sending')
    })
  })

  describe('round 12（Finding 3／4）：attemptCount／claimGeneration 的 runtime 型別驗證（真實 Firestore）', () => {
    it('attemptCount 被寫成字串（畸形資料）→ begin 拒絕，reason: invalid-attempt-count，不呼叫 SMTP', async () => {
      const { campaignRef, generation } = await seedCampaignWithActiveLease(
        'finding3-malformed-attempt-count',
        'attempt-A',
      )
      const recipientRef = doc(campaignRef, 'recipients', 'r1')
      await setDoc(recipientRef, {
        status: 'claimed',
        attemptId: 'attempt-A',
        leaseExpiresAtMs: Date.now() + RECIPIENT_LEASE_MS,
        attemptCountPending: true,
        claimGeneration: generation,
        attemptCount: '2', // 畸形資料：字串而非數字
      })

      const begin = await beginDeliveryAttempt(recipientRef, campaignRef, 'attempt-A', generation)
      expect(begin).toEqual({ applied: false, reason: 'invalid-attempt-count' })
      const snap = await getDoc(recipientRef)
      expect(snap.data()?.status).toBe('claimed') // 完全沒有被誤判成 sending
    })

    it('attemptCountPending 被寫成字串 "true"（畸形資料）→ begin 拒絕，reason: invalid-attempt-count-pending', async () => {
      const { campaignRef, generation } = await seedCampaignWithActiveLease(
        'finding3-malformed-pending',
        'attempt-A',
      )
      const recipientRef = doc(campaignRef, 'recipients', 'r1')
      await setDoc(recipientRef, {
        status: 'claimed',
        attemptId: 'attempt-A',
        leaseExpiresAtMs: Date.now() + RECIPIENT_LEASE_MS,
        attemptCountPending: 'true',
        claimGeneration: generation,
        attemptCount: 1,
      })

      const begin = await beginDeliveryAttempt(recipientRef, campaignRef, 'attempt-A', generation)
      expect(begin).toEqual({ applied: false, reason: 'invalid-attempt-count-pending' })
    })

    it('claimGeneration 缺失但 attemptCountPending:true（新版本 claim 理論上不該漏寫）→ begin 拒絕，reason: claim-generation-invalid', async () => {
      const { campaignRef, generation } = await seedCampaignWithActiveLease(
        'finding4-missing-claim-generation',
        'attempt-A',
      )
      const recipientRef = doc(campaignRef, 'recipients', 'r1')
      await setDoc(recipientRef, {
        status: 'claimed',
        attemptId: 'attempt-A',
        leaseExpiresAtMs: Date.now() + RECIPIENT_LEASE_MS,
        attemptCountPending: true,
        attemptCount: 0,
        // 沒有 claimGeneration 欄位
      })

      const begin = await beginDeliveryAttempt(recipientRef, campaignRef, 'attempt-A', generation)
      expect(begin).toEqual({ applied: false, reason: 'claim-generation-invalid' })
    })

    // round 10 遺留（不是最新的 attemptCountPending 概念，但已經在寫
    // claimGeneration）：只缺 attemptCountPending 這一個欄位，claimGeneration
    // 存在且相符——這代表「上一個 revision 已經是 round 10，不是更早的
    // 版本」，必須正常運作，不能因為多了一項嚴格驗證就連這個合法情況也擋下。
    it('round 10 遺留文件（沒有 attemptCountPending，但 claimGeneration 存在且相符）→ 正常 applied，不重複累加', async () => {
      const { campaignRef, generation } = await seedCampaignWithActiveLease(
        'finding5-round10-legacy',
        'attempt-A',
      )
      const recipientRef = doc(campaignRef, 'recipients', 'r1')
      await setDoc(recipientRef, {
        status: 'claimed',
        attemptId: 'attempt-A',
        leaseExpiresAtMs: Date.now() + RECIPIENT_LEASE_MS,
        claimGeneration: generation, // round 10 code 已經在寫這個欄位
        attemptCount: 1,
        // 沒有 attemptCountPending——round 10 code 還不認識這個欄位
      })

      const begin = await beginDeliveryAttempt(recipientRef, campaignRef, 'attempt-A', generation)
      expect(begin.applied).toBe(true)
      if (begin.applied) {
        expect(begin.attemptCount).toBe(1) // 沿用既有值，沒有重複累加
      }
    })

    // ⚠️ round 13 修正（Finding 2）：round 12 的「Finding 5 重現」測試有
    // 兩個不真實的假設——(1) 新舊 invocation 用同一個 attemptId
    //（`attempt-A`）：實際上每個 invocation 都用 randomUUID()，舊、新
    // revision 的 attemptId 必然不同；(2) 用 `newGeneration - 1` 湊出舊
    // generation：seed 出來的第一次 acquire 通常從 1 開始，減 1 得到 0，
    // 不是真實的 acquisition 順序（真實情境裡，較舊的 invocation 一定是
    // 先 acquire、生成較小的 generation，之後才有新的 invocation
    // acquire 出更大的 generation）。這兩個簡化讓那個測試只能證明「人為
    // 把同一 attemptId 搭配不同 claimGeneration 會被拒絕」，沒有辦法證明
    // 新舊 revision 完整生命週期的安全性。
    //
    // 這裡改用 production 共用的 acquireCampaignLeaseTx／claimRecipientTx／
    // beginDeliveryAttemptTx，完整重現三個獨立 invocation（O／N／P，各自
    // 不同的 attemptId）、三個真實遞增的 generation（1／2／3）交錯的完整
    // 時序，誠實驗證最終結果——不迴避「答案可能不好看」。
    it('Finding 2 完整重現：三個獨立 invocation（真實 attemptId、真實遞增 generation）交錯——claimGeneration 能擋下「用舊身分繼續 begin」，但擋不住舊 invocation 的 claim-time increment 污染最終 attemptCount', async () => {
      const campaignRef = doc(db, 'campaigns', 'finding2-real-mixed-revision')
      await setDoc(campaignRef, { status: 'sending', recipientsReady: true })
      const recipientRef = doc(campaignRef, 'recipients', 'r1')
      await setDoc(recipientRef, { status: 'queued', attemptCount: 0 })

      // 1. 舊 invocation O 先合法 acquire：attemptId=old-A，generation=1。
      const oLease = await acquireLease(campaignRef, 'old-A')
      expect(oLease.outcome).toBe('acquired')
      const oGeneration = expectGeneration(oLease)
      expect(oGeneration).toBe(1)

      // 2. O 的 campaign 處理租約過期（O 卡住很久，或還在 SMTP 驗證階段）。
      await setDoc(campaignRef, { activeLeaseExpiresAtMs: Date.now() - 1 }, { merge: true })

      // 3. 新 invocation N 合法 acquire：attemptId=new-B，generation=2。
      const nLease = await acquireLease(campaignRef, 'new-B')
      expect(nLease.outcome).toBe('acquired')
      const nGeneration = expectGeneration(nLease)
      expect(nGeneration).toBe(2)

      // 4. N claim recipient：attemptId=new-B，claimGeneration=2，
      //    attemptCountPending=true。
      const nClaim = await claim(recipientRef, campaignRef, 'new-B', nGeneration)
      expect(nClaim.claimable).toBe(true)

      // 5. 模擬仍在執行的 Round 10 舊 claim（O 自己）：它完全不知道
      //    campaign 處理租約早就被 N 接手、也不認識 attemptCountPending
      //    這個欄位——round 10 的 claimRecipientTx 不讀 campaign，只看
      //    recipient 本身是否 claimable，直接用自己的 attemptId／
      //    generation 覆寫：attemptId=old-A、claimGeneration=1（O 自己
      //    真實的 generation，不是湊出來的）、attemptCount 從 0 累加成 1。
      //    因為舊版本的 update() 不知道 attemptCountPending 這個欄位，
      //    它會原封不動地留著 N 剛才設的 true。
      await setDoc(
        recipientRef,
        {
          status: 'claimed',
          attemptId: 'old-A',
          claimGeneration: oGeneration,
          leaseExpiresAtMs: Date.now() + RECIPIENT_LEASE_MS,
          attemptCount: 1, // 舊邏輯：((0) ?? 0) + 1——O 從未真正呼叫過 SMTP
        },
        { merge: true },
      )
      const afterOldClaim = await getDoc(recipientRef)
      expect(afterOldClaim.data()?.attemptCountPending).toBe(true) // N 寫的值，O 沒有清掉

      // 6. N 立即呼叫 begin（用自己的 attemptId=new-B）——recipient.attemptId
      //    現在是 old-A（被 O 覆寫掉了），必須先被 attempt-id-mismatch
      //    擋下，不是 claim-generation-mismatch：decideBeginDeliveryAttempt
      //    對 recipient.attemptId 的檢查發生在任何 campaign／generation
      //    檢查之前。
      const nBegin = await beginDeliveryAttempt(recipientRef, campaignRef, 'new-B', nGeneration)
      expect(nBegin).toEqual({ applied: false, reason: 'attempt-id-mismatch' })

      // 7. 等 old-A 寫入的 recipient claim lease 過期。
      await setDoc(recipientRef, { leaseExpiresAtMs: Date.now() - 1 }, { merge: true })

      // 8. 新 invocation P 再合法 acquire——先讓 N 的 campaign 處理租約也
      //    過期，才符合真實情境（不能讓兩個 processing invocation 同時
      //    持有租約）。
      await setDoc(campaignRef, { activeLeaseExpiresAtMs: Date.now() - 1 }, { merge: true })
      const pLease = await acquireLease(campaignRef, 'new-P')
      expect(pLease.outcome).toBe('acquired')
      const pGeneration = expectGeneration(pLease)
      expect(pGeneration).toBe(3)

      // 9. P 重新 claim，寫入自己的 attemptId／claimGeneration=3，
      //    pending=true。
      const pClaim = await claim(recipientRef, campaignRef, 'new-P', pGeneration)
      expect(pClaim.claimable).toBe(true)

      // 10. P begin——這是整個時序裡唯一一次真正跨過 begin、真正要呼叫
      //     SMTP 的 attempt。
      const pBegin = await beginDeliveryAttempt(recipientRef, campaignRef, 'new-P', pGeneration)
      expect(pBegin.applied).toBe(true)

      const finalSnap = await getDoc(recipientRef)
      // ⚠️ 誠實的結論，撤回 round 12 的說法：即使 claimGeneration 交叉
      // 驗證正確擋下了步驟 6「用 O 的身分繼續 begin」的嘗試，最終
      // attemptCount 仍然是 2——來自 O 在步驟 5 的 claim-time increment
      //（O 從未真正呼叫過 begin／SMTP），加上 P 在步驟 10 真正的一次
      // begin。claimGeneration 只能阻止「舊 invocation 的身分被用來跨過
      // 這次 begin 的閘門」，沒有辦法、也不可能辨識「O 留下的
      // attemptCount=1 是不是真的代表一次 SMTP attempt」——這是 Finding 2
      // 指出的真實落差：**必須撤回**「Finding 4 的 claimGeneration 已經
      // 擋下 Finding 5 具體雙重計數情境」這個結論。claimGeneration 只是
      // 有限的縱深防禦（擋下「舊身分繼續 begin」），不能判斷舊 revision
      // 留下的 attemptCount 是否代表真實 SMTP attempt；也不能安全地自動
      // 扣回 attemptCount，因為舊 invocation 也可能真的已經呼叫過 SMTP。
      // 這是只有安全 drain 部署程序（見 functions/src/index.ts 的
      // runbook）才能完全避免的風險，不是程式碼層面可以單方面消除的。
      if (pBegin.applied) {
        expect(pBegin.attemptCount).toBe(2) // 不是 1——這就是問題所在
      }
      expect(finalSnap.data()?.attemptCount).toBe(2)
      expect(finalSnap.data()?.status).toBe('sending')
    })
  })

  describe('round 11（Finding 3）：resolution 租約的 campaign eligibility（真實 Firestore）', () => {
    it('recipientsReady:false（還在建立收件人清單）→ not-ready，不會取得租約', async () => {
      const campaignRef = doc(db, 'campaigns', 'finding3-setup-not-ready')
      await setDoc(campaignRef, { status: 'sending', recipientsReady: false })
      const decision = await acquireResolutionLease(campaignRef, 'admin-attempt')
      expect(decision.outcome).toBe('not-ready')
      const snap = await getDoc(campaignRef)
      expect(snap.data()?.resolutionLeaseAttemptId).toBeUndefined()
    })

    it('status: completed（即使 recipientsReady:true）→ invalid-status', async () => {
      const campaignRef = doc(db, 'campaigns', 'finding3-completed')
      await setDoc(campaignRef, { status: 'completed', recipientsReady: true })
      const decision = await acquireResolutionLease(campaignRef, 'admin-attempt')
      expect(decision.outcome).toBe('invalid-status')
    })

    it('status: failed → invalid-status', async () => {
      const campaignRef = doc(db, 'campaigns', 'finding3-failed')
      await setDoc(campaignRef, { status: 'failed', recipientsReady: true })
      const decision = await acquireResolutionLease(campaignRef, 'admin-attempt')
      expect(decision.outcome).toBe('invalid-status')
    })

    it('未知／缺失的 status（理論上不該發生，防禦性測試）→ invalid-status，fail closed', async () => {
      const campaignRef = doc(db, 'campaigns', 'finding3-unknown-status')
      await setDoc(campaignRef, { status: 'some-corrupted-value', recipientsReady: true })
      const decision = await acquireResolutionLease(campaignRef, 'admin-attempt')
      expect(decision.outcome).toBe('invalid-status')
    })

    it('合法狀態（sending／partial／needs_review）且 recipientsReady:true → 可以正常取得 resolution 租約', async () => {
      for (const status of ['sending', 'partial', 'needs_review']) {
        const campaignRef = doc(db, 'campaigns', `finding3-eligible-${status}`)
        await setDoc(campaignRef, { status, recipientsReady: true })
        const decision = await acquireResolutionLease(campaignRef, 'admin-attempt')
        expect(decision.outcome).toBe('acquired')
      }
    })
  })
})
