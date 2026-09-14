import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { CallableRequest } from 'firebase-functions/v2/https'
import { DocumentReference, getFirestore, getStorage } from '../functions/scripts/emulator-test-support.mjs'
import { MAINTENANCE_DOC_PATH, MAINTENANCE_PAUSED_FIELD, MAINTENANCE_PAUSED_MESSAGE } from '../shared/maintenance'

/**
 * round 28 新增：六個受管制 callable（sendCampaign／retryCampaign／
 * resolveDeliveryUnknown／reconcileCampaignDeliveryStatus／
 * testSmtpConnection／processStorageCleanupQueue）是否真的在
 * requirePermission／requireAdmin 之後、任何其他副作用之前呼叫
 * requireCampaignOperationsNotPaused()——不是重新測一次 shared/maintenance.ts
 * 的判斷邏輯（那是 tests/maintenance.test.ts 的職責，這裡完全不重複），而是
 * 具體證明 functions/src/index.ts 真的把它接上了六個 handler，接的位置也對。
 *
 * round 28 提交前審查新增：deletePressRelease 補進來的第七個受管制
 * callable（見 functions/src/index.ts 該處的說明——會刪除 sendCampaign
 * 可能正在讀取的新聞稿與附件，屬於維護模式原本要防的同一類部署期競態），
 * 以及 retryCampaign 的權限檢查排序修正（先驗證身分，再讀 campaign，
 * 避免完全未登入的呼叫者靠「campaign 存在與否」這兩種可分辨的錯誤探測
 * 任意 campaign ID）。
 *
 * 直接 import functions/src/index.ts 取得 round 28 抽出來的獨立具名
 * handler（sendCampaignHandler 等），用最小的 CallableRequest 呼叫它們本身
 * ——不透過 onCall() 的 HTTPS wrapper（不需要模擬真正的 HTTPS 呼叫、也不受
 * 它的 request 驗證框架限制，見這些 handler 定義處的說明）。
 *
 * ⚠️ 匯入順序是這個測試檔案能不能動的關鍵：
 * 1. 先設定 FIRESTORE_EMULATOR_HOST（讓 index.ts 頂層的 initializeApp()／
 *    getFirestore() 連到本機 emulator，不是正式的 Firestore）。
 * 2. `await import('../functions/src/index')`，讓它自己的頂層
 *    initializeApp() 先建立「預設」Admin App。
 * 3. 才呼叫 functions/scripts/emulator-test-support.mjs 這裡（不帶參數的）
 *    getFirestore()，拿到「同一個」預設 App 的 Firestore 實例——這樣測試
 *    種進去的資料，跟六個 handler 內部 `db.doc(...)` 讀到的是同一份 emulator
 *    狀態，不是另外建立一個具名 App 各自獨立的複本（那樣種的資料 handler
 *    永遠讀不到）。見 emulator-test-support.mjs 檔案開頭對這件事的說明。
 *
 * project id 用 `firebase emulators:exec --project ts-press-rules-ci`（見
 * package.json 的 test:rules）自動注入的 GCLOUD_PROJECT，不是正式的
 * `ts-press`；這裡不用另外指定。
 *
 * 一律透過 `npm run test:rules` 執行，需要 Firebase 模擬器（Java）。
 */
const HOST = '127.0.0.1'
const PORT = 8080
const STORAGE_PORT = 9199

const ADMIN_EMAIL = 'maintenance-gate-admin@x.com'
const RESUMABLE_CAMPAIGN_ID = 'maintenance-gate-resumable-campaign'
const NONEXISTENT_CAMPAIGN_ID = 'maintenance-gate-does-not-exist-campaign'

let db: FirebaseFirestore.Firestore
let sendCampaignHandler: (request: CallableRequest<unknown>) => Promise<unknown>
let retryCampaignHandler: (request: CallableRequest<unknown>) => Promise<unknown>
let resolveDeliveryUnknownHandler: (request: CallableRequest<unknown>) => Promise<unknown>
let reconcileCampaignDeliveryStatusHandler: (request: CallableRequest<unknown>) => Promise<unknown>
let testSmtpConnectionHandler: (request: CallableRequest<unknown>) => Promise<unknown>
let processStorageCleanupQueueHandler: (request: CallableRequest<unknown>) => Promise<unknown>
let deletePressReleaseHandler: (request: CallableRequest<unknown>) => Promise<unknown>

beforeAll(async () => {
  process.env.FIRESTORE_EMULATOR_HOST = `${HOST}:${PORT}`
  process.env.GCLOUD_PROJECT ??= 'ts-press-rules-ci'
  // round 28 提交前審查新增：deletePressReleaseHandler 真正成功刪除路徑的
  // emulator 測試需要 Storage 模擬器——`firebase-admin/storage` 認得的
  // 環境變數是 FIREBASE_STORAGE_EMULATOR_HOST（跟 Firestore 的
  // FIRESTORE_EMULATOR_HOST 是兩個獨立的環境變數），必須在頂層
  // initializeApp()／任何 getStorage() 呼叫之前設定好，才能讓
  // handler 內部與這支測試檔案自己種資料用的 getStorage().bucket() 都連到
  // 本機 Storage 模擬器（127.0.0.1:9199，跟 package.json 的 test:rules
  // 腳本 `--only firestore,storage` 啟動的埠一致），不是嘗試連正式 GCS。
  process.env.FIREBASE_STORAGE_EMULATOR_HOST ??= `${HOST}:${STORAGE_PORT}`
  // processStorageCleanupQueueHandler 通過 requireAdmin／
  // requireCampaignOperationsNotPaused() 這兩層檢查之後，第一個會碰到的
  // Storage 相關呼叫就是 `getStorage().bucket()`（不論佇列是否為空都會
  // 執行，這裡指的是 maintenance gate 之後、不是整個函式的第一行）——
  // bare `initializeApp()` 沒有帶 storageBucket，firebase-admin 會直接丟
  // storage/invalid-argument，連「查詢佇列」都到不了。這裡只是提供一個
  // 看起來合法的 bucket 名稱字串讓 `.bucket()` 能建構出物件，不代表真的
  // 會有任何網路呼叫——這個測試裡 storageCleanupQueue 集合是空的，
  // `bucket.file(...).delete()` 那一行永遠不會被執行到，所以這裡是不是
  // 一個真實存在的 bucket 完全不重要。
  process.env.FIREBASE_CONFIG ??= JSON.stringify({
    storageBucket: 'ts-press-maintenance-gate-test.appspot.com',
  })

  const indexModule = await import('../functions/src/index')
  sendCampaignHandler = indexModule.sendCampaignHandler
  retryCampaignHandler = indexModule.retryCampaignHandler
  resolveDeliveryUnknownHandler = indexModule.resolveDeliveryUnknownHandler
  reconcileCampaignDeliveryStatusHandler = indexModule.reconcileCampaignDeliveryStatusHandler
  testSmtpConnectionHandler = indexModule.testSmtpConnectionHandler
  processStorageCleanupQueueHandler = indexModule.processStorageCleanupQueueHandler
  deletePressReleaseHandler = indexModule.deletePressReleaseHandler

  db = getFirestore()

  // 六個 handler 共用的授權使用者：admin 角色在預設權限矩陣（settings/permissions
  // 文件不存在時套用 DEFAULT_PERMISSIONS）下擁有全部權限，一份 fixture 就能
  // 通過 requirePermission(sendReal/sendTest) 與 requireAdmin 兩種檢查，不必
  // 為每個 handler 各自準備不同角色。
  await db.collection('users').doc(ADMIN_EMAIL).set({
    email: ADMIN_EMAIL,
    role: 'admin',
    active: true,
  })

  // retryCampaign 專用：一筆已經是終止狀態（completed）的 campaign，
  // resolveCampaignResume() 會直接判定成 'existing-result' 並回傳，不會
  // acquire 任何租約、不會碰 SMTP——這樣「維護模式關閉時應該放行」的測試
  // 才能安全地讓 handler 真的跑到最後一行，而不必連線真正的 mail2000。
  await db.collection('campaigns').doc(RESUMABLE_CAMPAIGN_ID).set({
    pressReleaseId: 'maintenance-gate-press-release',
    mode: 'testList',
    isTest: true,
    status: 'completed',
    recipientsReady: true,
    activeAttemptId: null,
    totals: { recipients: 0 },
  })
})

afterAll(async () => {
  await db.doc(MAINTENANCE_DOC_PATH).delete()
})

// CallableRequest 的 `data` 是必要欄位，但這裡用得到的六個 handler 全部只讀
// `request.auth` 跟 `request.data`，不需要 onCall() 本來會附加的
// rawRequest／instanceIdToken 等欄位，用一個小 helper 把 auth 與 data 組起來
// 即可，不必假造一份完整的 CallableRequest。
function buildRequest(data: unknown): CallableRequest<any> {
  return {
    auth: { token: { email: ADMIN_EMAIL, email_verified: true } },
    data,
  } as unknown as CallableRequest<any>
}

async function setMaintenancePaused(paused: boolean | undefined) {
  if (paused === undefined) {
    // undefined 代表「文件不存在」（missing），不是「欄位存在但是 undefined」
    // ——Firestore 本來就不可能儲存字面上的 undefined，所以用 delete()
    // 讓文件整個不存在，才是真正對應 shared/maintenance.ts 的 'missing' 分支。
    await db.doc(MAINTENANCE_DOC_PATH).delete()
    return
  }
  await db.doc(MAINTENANCE_DOC_PATH).set({ [MAINTENANCE_PAUSED_FIELD]: paused })
}

/** 對「維護中」時應該擋下的斷言：failed-precondition + 通用訊息，且不外流任何內部細節。 */
async function expectBlockedByMaintenance(promise: Promise<unknown>) {
  await expect(promise).rejects.toMatchObject({
    code: 'failed-precondition',
    message: MAINTENANCE_PAUSED_MESSAGE,
  })
}

describe('六個受管制 callable 的維護模式攔截（真實 Firestore emulator，直接呼叫 production handler）', () => {
  describe('sendCampaign', () => {
    const data = { pressReleaseId: 'maintenance-gate-press-release', mode: 'self' }

    it('campaignOperationsPaused:true → 擋下，且不會走到任何新聞稿／campaign 讀寫（否則會是 not-found 而不是 failed-precondition）', async () => {
      await setMaintenancePaused(true)
      await expectBlockedByMaintenance(sendCampaignHandler(buildRequest(data)))
    })

    it('欄位是 missing（從未設定過）→ 放行，維護檢查本身不會擋下（後續因為新聞稿不存在而 not-found，證明真的跑過了維護檢查這一關）', async () => {
      await setMaintenancePaused(undefined)
      await expect(sendCampaignHandler(buildRequest(data))).rejects.not.toMatchObject({
        message: MAINTENANCE_PAUSED_MESSAGE,
      })
    })

    it('欄位是 malformed（例如字串）→ 一律 fail closed，視為維護中一併擋下', async () => {
      await db.doc(MAINTENANCE_DOC_PATH).set({ [MAINTENANCE_PAUSED_FIELD]: 'yes' })
      await expectBlockedByMaintenance(sendCampaignHandler(buildRequest(data)))
    })

    it('權限檢查在維護檢查之前：權限不足時就算維護模式也是開的，看到的仍然是 permission-denied，不是維護訊息', async () => {
      await setMaintenancePaused(true)
      const specialistEmail = 'maintenance-gate-specialist@x.com'
      await db.collection('users').doc(specialistEmail).set({
        email: specialistEmail,
        role: 'specialist',
        active: true,
      })
      const request = {
        auth: { token: { email: specialistEmail, email_verified: true } },
        data,
      } as unknown as CallableRequest<any>
      await expect(sendCampaignHandler(request)).rejects.toMatchObject({ code: 'permission-denied' })
    })
  })

  describe('retryCampaign', () => {
    const data = { campaignId: RESUMABLE_CAMPAIGN_ID }

    it('campaignOperationsPaused:true → 擋下，不會執行 resolveCampaignResume 之後的任何邏輯', async () => {
      await setMaintenancePaused(true)
      await expectBlockedByMaintenance(retryCampaignHandler(buildRequest(data)))
    })

    it('campaignOperationsPaused:false → 放行，跑到底（這筆 campaign 是 completed 終止狀態，resolveCampaignResume 直接回傳既有結果，不會 acquire 租約或連線 SMTP）', async () => {
      await setMaintenancePaused(false)
      await expect(retryCampaignHandler(buildRequest(data))).resolves.toMatchObject({
        ok: true,
        status: 'completed',
      })
    })

    // round 28 提交前審查新增：匿名（完全未登入）呼叫者不得靠「campaign
    // 存在與否」探測任意 campaign ID——不管 campaign 實際存不存在，都必須
    // 在讀取任何 Firestore 文件之前就被 authorize() 拒絕。maintenance flag
    // 目前是什麼狀態刻意不設定、不依賴——authorize() 這一關本來就排在
    // requireCampaignOperationsNotPaused() 之前，不管旗標是什麼值，未登入
    // 呼叫者永遠應該在讀到旗標之前就已經被拒絕。
    it('匿名請求、目標 campaign 存在：在讀取任何 Firestore 文件之前就被拒絕，讀取次數為 0', async () => {
      const getSpy = vi.spyOn(DocumentReference.prototype, 'get')
      try {
        const anonymousRequest = { auth: undefined, data } as unknown as CallableRequest<any>
        await expect(retryCampaignHandler(anonymousRequest)).rejects.toMatchObject({
          code: 'permission-denied',
        })
        expect(getSpy).not.toHaveBeenCalled()
      } finally {
        getSpy.mockRestore()
      }
    })

    it('匿名請求、目標 campaign 不存在：同樣在讀取任何 Firestore 文件之前就被拒絕（不是 not-found），讀取次數為 0——證明存在與不存在的 campaign 對匿名呼叫者完全無法分辨', async () => {
      const getSpy = vi.spyOn(DocumentReference.prototype, 'get')
      try {
        const anonymousRequest = {
          auth: undefined,
          data: { campaignId: NONEXISTENT_CAMPAIGN_ID },
        } as unknown as CallableRequest<any>
        await expect(retryCampaignHandler(anonymousRequest)).rejects.toMatchObject({
          code: 'permission-denied',
        })
        expect(getSpy).not.toHaveBeenCalled()
      } finally {
        getSpy.mockRestore()
      }
    })

    // round 28 提交前審查新增：campaign.mode／isTest 一致性驗證——重用
    // shared/campaignSend.ts 既有的 resolveCampaignSendKind()（
    // repairCampaignPressReleaseSyncTx 判斷「這是不是正式發送」用的同一個
    // 函式），不是另外刻一套 mode 語意。舊版的三元運算式在 mode 畸形時會
    // 隱含 fallback 到 sendTest，這裡證明改用 resolveCampaignSendKind() 之後
    // 不會再發生。
    describe('campaign.mode／isTest 一致性驗證', () => {
      const REAL_TERMINAL_CAMPAIGN_ID = 'maintenance-gate-real-terminal-campaign'
      const SEND_TEST_ONLY_EMAIL = 'maintenance-gate-sendtest-only-specialist@x.com'

      beforeAll(async () => {
        await db.collection('campaigns').doc(REAL_TERMINAL_CAMPAIGN_ID).set({
          pressReleaseId: 'maintenance-gate-press-release',
          mode: 'real',
          isTest: false,
          status: 'completed',
          recipientsReady: true,
          activeAttemptId: null,
          totals: { recipients: 0 },
        })

        // 動態權限覆寫：specialist 角色在預設矩陣（shared/permissions.ts
        // DEFAULT_PERMISSIONS）裡 sendTest／sendReal 都沒有——這裡只額外
        // 開放 sendTest，刻意不開放 sendReal，用來具體證明「就算某個角色
        // 被後台設定成擁有 sendTest，也不能靠這個權限通過需要 sendReal 的
        // 正式發送，更不能靠這個權限救回一份 mode 畸形、原本應該 fail
        // closed 的 campaign」。
        await db.doc('settings/permissions').set({
          roles: { specialist: { sendTest: true } },
        })
        await db.collection('users').doc(SEND_TEST_ONLY_EMAIL).set({
          email: SEND_TEST_ONLY_EMAIL,
          role: 'specialist',
          active: true,
        })
      })

      afterAll(async () => {
        // 清乾淨，避免這份覆寫影響檔案裡其他（之後才會執行的）describe
        // 區塊——雖然目前沒有其他區塊會用到 specialist 的 sendTest／
        // sendReal，仍然刻意清乾淨，不留隱性耦合。
        await db.doc('settings/permissions').delete()
      })

      function sendTestOnlyRequest(campaignId: string) {
        return {
          auth: { token: { email: SEND_TEST_ONLY_EMAIL, email_verified: true } },
          data: { campaignId },
        } as unknown as CallableRequest<any>
      }

      it('real 使用 sendReal：只有 sendTest、沒有 sendReal 的角色嘗試 mode:real 的 campaign → permission-denied（證明正式發送真的需要 sendReal，不會被 sendTest 頂替）', async () => {
        await setMaintenancePaused(false)
        await expect(retryCampaignHandler(sendTestOnlyRequest(REAL_TERMINAL_CAMPAIGN_ID))).rejects.toMatchObject({
          code: 'permission-denied',
        })
      })

      it('test 使用 sendTest：同一個只有 sendTest 的角色嘗試 mode:testList 的 campaign → 放行（不是 permission-denied），證明 sendTest 對 test-kind 已經足夠', async () => {
        await setMaintenancePaused(false)
        await expect(retryCampaignHandler(sendTestOnlyRequest(RESUMABLE_CAMPAIGN_ID))).resolves.toMatchObject({
          ok: true,
          status: 'completed',
        })
      })

      const MALFORMED_MODES: Array<{ label: string; campaignId: string; mode?: unknown }> = [
        { label: 'undefined（欄位完全缺失）', campaignId: 'maintenance-gate-malformed-mode-missing' },
        { label: 'null', campaignId: 'maintenance-gate-malformed-mode-null', mode: null },
        { label: '空字串', campaignId: 'maintenance-gate-malformed-mode-empty-string', mode: '' },
        { label: '任意字串', campaignId: 'maintenance-gate-malformed-mode-bogus-string', mode: 'bogus' },
        { label: '數字', campaignId: 'maintenance-gate-malformed-mode-number', mode: 123 },
        { label: '布林值', campaignId: 'maintenance-gate-malformed-mode-boolean', mode: true },
        { label: '物件', campaignId: 'maintenance-gate-malformed-mode-object', mode: { real: true } },
        { label: '陣列', campaignId: 'maintenance-gate-malformed-mode-array', mode: ['real'] },
      ]

      beforeAll(async () => {
        for (const { campaignId, mode } of MALFORMED_MODES) {
          const doc: Record<string, unknown> = {
            pressReleaseId: 'maintenance-gate-press-release',
            isTest: false,
            status: 'completed',
            recipientsReady: true,
            activeAttemptId: null,
            totals: { recipients: 0 },
          }
          // mode === undefined 時完全不寫入這個欄位（Firestore 本來就不可能
          // 儲存字面上的 undefined）——對應「欄位完全缺失」這個案例，不是
          // 「欄位存在但是 undefined」。
          if (mode !== undefined) doc.mode = mode
          await db.collection('campaigns').doc(campaignId).set(doc)
        }
      })

      it.each(MALFORMED_MODES)(
        'mode 是 $label → fail closed，failed-precondition，不會 fallback 到 sendTest',
        async ({ campaignId }) => {
          await setMaintenancePaused(false)
          await expect(retryCampaignHandler(buildRequest({ campaignId }))).rejects.toMatchObject({
            code: 'failed-precondition',
          })
        },
      )

      it('malformed mode 不會進 maintenance gate：即使維護模式是開的，看到的仍然是 mode 錯誤，不是維護訊息，且從未讀過 settings/permissions 或 system/runtime', async () => {
        await setMaintenancePaused(true)
        const getSpy = vi.spyOn(DocumentReference.prototype, 'get')
        try {
          await expect(
            retryCampaignHandler(buildRequest({ campaignId: 'maintenance-gate-malformed-mode-bogus-string' })),
          ).rejects.toMatchObject({ code: 'failed-precondition' })
          await expect(
            retryCampaignHandler(buildRequest({ campaignId: 'maintenance-gate-malformed-mode-bogus-string' })),
          ).rejects.not.toMatchObject({ message: MAINTENANCE_PAUSED_MESSAGE })

          const readPaths = getSpy.mock.contexts
            .map((ref: FirebaseFirestore.DocumentReference) => ref?.path)
            .filter(Boolean)
          // 兩次呼叫都只應該讀到 users/{email}（authorize）與
          // campaigns/{id}（讀 campaign 本身）——從未讀過
          // settings/permissions（enforcePermission 從未被呼叫）也從未讀過
          // system/runtime（maintenance gate 從未被呼叫），證明 mode 驗證
          // 確實排在兩者之前。
          expect(readPaths).not.toContain('settings/permissions')
          expect(readPaths).not.toContain(MAINTENANCE_DOC_PATH)
        } finally {
          getSpy.mockRestore()
        }
      })

      it('malformed mode 不會 acquire 租約或寫入資料：campaign 文件呼叫前後完全不變', async () => {
        const campaignId = 'maintenance-gate-malformed-mode-number'
        const ref = db.collection('campaigns').doc(campaignId)
        const before = await ref.get()

        await setMaintenancePaused(false)
        await expect(retryCampaignHandler(buildRequest({ campaignId }))).rejects.toMatchObject({
          code: 'failed-precondition',
        })

        const after = await ref.get()
        expect(after.updateTime?.isEqual(before.updateTime!)).toBe(true)
        expect(after.data()).toEqual(before.data())
      })

      it('動態權限不對稱：角色被設定成有 sendTest、沒有 sendReal 時，malformed mode 仍然不能通過（拿到的是 mode 錯誤，不是 permission-denied，也不是成功）', async () => {
        await setMaintenancePaused(false)
        await expect(
          retryCampaignHandler(sendTestOnlyRequest('maintenance-gate-malformed-mode-object')),
        ).rejects.toMatchObject({ code: 'failed-precondition' })
      })
    })
  })

  describe('resolveDeliveryUnknown', () => {
    it('campaignOperationsPaused:true → 擋下，緊接在 requireAdmin 之後（空的 request.data 本來會先撞到 campaign ID 格式檢查而是 invalid-argument，這裡卻是 failed-precondition，證明維護檢查排在更前面）', async () => {
      await setMaintenancePaused(true)
      await expectBlockedByMaintenance(resolveDeliveryUnknownHandler(buildRequest({})))
    })

    it('campaignOperationsPaused:false → 放行，改成撞到後面的輸入驗證（invalid-argument），不是維護訊息', async () => {
      await setMaintenancePaused(false)
      await expect(resolveDeliveryUnknownHandler(buildRequest({}))).rejects.toMatchObject({
        code: 'invalid-argument',
      })
    })
  })

  describe('reconcileCampaignDeliveryStatus', () => {
    it('campaignOperationsPaused:true → 擋下，同樣排在 requireAdmin 之後、任何唯讀分類檢查之前', async () => {
      await setMaintenancePaused(true)
      await expectBlockedByMaintenance(reconcileCampaignDeliveryStatusHandler(buildRequest({})))
    })

    it('campaignOperationsPaused:false → 放行，改成撞到 campaign ID 格式檢查（invalid-argument）', async () => {
      await setMaintenancePaused(false)
      await expect(reconcileCampaignDeliveryStatusHandler(buildRequest({}))).rejects.toMatchObject({
        code: 'invalid-argument',
      })
    })
  })

  describe('testSmtpConnection', () => {
    it('campaignOperationsPaused:true → 擋下，不會呼叫 readSmtpSettings()／建立任何 SMTP 連線', async () => {
      await setMaintenancePaused(true)
      await expectBlockedByMaintenance(testSmtpConnectionHandler(buildRequest({})))
    })

    it('campaignOperationsPaused:false → 放行，改成因為 settings/smtp 尚未設定而 failed-precondition，但訊息不是維護訊息（證明真的執行到 readSmtpSettings()，不是被維護檢查擋下）', async () => {
      await setMaintenancePaused(false)
      await expect(testSmtpConnectionHandler(buildRequest({}))).rejects.toMatchObject({
        code: 'failed-precondition',
      })
      await expect(testSmtpConnectionHandler(buildRequest({}))).rejects.not.toMatchObject({
        message: MAINTENANCE_PAUSED_MESSAGE,
      })
    })
  })

  describe('processStorageCleanupQueue', () => {
    it('campaignOperationsPaused:true → 擋下，不會查詢 storageCleanupQueue、也不會碰 Storage bucket', async () => {
      await setMaintenancePaused(true)
      await expectBlockedByMaintenance(processStorageCleanupQueueHandler(buildRequest({})))
    })

    it('campaignOperationsPaused:false → 放行，正常跑完（佇列是空的，回傳全部是 0）', async () => {
      await setMaintenancePaused(false)
      await expect(processStorageCleanupQueueHandler(buildRequest({}))).resolves.toMatchObject({
        succeeded: 0,
        failed: 0,
        exhausted: 0,
        processed: 0,
      })
    })
  })

  // round 28 提交前審查新增：deletePressRelease 補進受管制名單（見
  // functions/src/index.ts 該處的說明）——會刪除 sendCampaign 可能正在
  // 讀取的新聞稿與附件，測試方式跟上面六個 handler 同一套。
  describe('deletePressRelease', () => {
    const PRESS_RELEASE_ID = 'maintenance-gate-deletable-press-release'

    it('campaignOperationsPaused:true → 擋下，零新聞稿讀取、零文件刪除、零 Storage 操作、零 cleanup queue 寫入', async () => {
      // 先種一筆真的存在的新聞稿文件，之後才能具體證明「呼叫之後這份文件
      // 完全沒被動過」，而不是巧合地本來就不存在。
      await db.collection('pressReleases').doc(PRESS_RELEASE_ID).set({
        title: '維護模式測試新聞稿',
        category: 'general',
        versions: {},
        attachments: [{ name: 'a.pdf', path: `pressReleases/${PRESS_RELEASE_ID}/attachments/a.pdf` }],
      })
      const before = await db.collection('pressReleases').doc(PRESS_RELEASE_ID).get()

      await setMaintenancePaused(true)
      const getSpy = vi.spyOn(DocumentReference.prototype, 'get')
      try {
        await expectBlockedByMaintenance(
          deletePressReleaseHandler(buildRequest({ pressReleaseId: PRESS_RELEASE_ID })),
        )
        // 這裡不能斷言「完全零 Firestore 讀取」——buildRequest() 用的是
        // 已登入的 admin，authorize()／enforcePermission()（讀
        // users/{email} 與 settings/permissions）與
        // requireCampaignOperationsNotPaused()（讀 system/runtime）本身
        // 就會產生 3 次合法的 .get() 呼叫，這些是「驗證身分與維護狀態」
        // 需要的讀取，不是這裡要證明零副作用的目標。真正要證明的是：
        // 這份新聞稿文件本身完全沒被讀取過——用 mock.contexts 篩出呼叫
        // 當下的 `this`（也就是被呼叫 .get() 的那個 DocumentReference
        // 實例），確認沒有任何一次是指向 pressReleases/{PRESS_RELEASE_ID}
        // 這個路徑。
        const pressReleaseReads = getSpy.mock.contexts.filter(
          (ref: FirebaseFirestore.DocumentReference) => ref?.path === `pressReleases/${PRESS_RELEASE_ID}`,
        )
        expect(pressReleaseReads).toHaveLength(0)
      } finally {
        getSpy.mockRestore()
      }

      // 零文件刪除：新聞稿文件必須原封不動還在。
      const after = await db.collection('pressReleases').doc(PRESS_RELEASE_ID).get()
      expect(after.exists).toBe(true)
      expect(after.updateTime?.isEqual(before.updateTime!)).toBe(true)
      expect(after.data()).toEqual(before.data())

      // 零 Storage 初始化／刪除、零 cleanup queue 寫入：handler 連
      // pressRef.get() 都到不了，getStorage().bucket() 與
      // storageCleanupQueue.add() 這兩行在它之後，結構上不可能被執行到；
      // 用 cleanup queue 集合仍然是空的這件事具體驗證後半段的推論。
      const queueSnap = await db.collection('storageCleanupQueue').get()
      expect(queueSnap.empty).toBe(true)
    })

    it('欄位是 malformed（例如字串）→ 一律 fail closed，視為維護中一併擋下', async () => {
      await db.doc(MAINTENANCE_DOC_PATH).set({ [MAINTENANCE_PAUSED_FIELD]: 'yes' })
      await expectBlockedByMaintenance(
        deletePressReleaseHandler(buildRequest({ pressReleaseId: PRESS_RELEASE_ID })),
      )
    })

    it('欄位是 missing（從未設定過）→ 放行，維護檢查本身不會擋下（既有行為不受影響：目標新聞稿不存在時回傳 ok:true，不是維護訊息）', async () => {
      await setMaintenancePaused(undefined)
      await expect(
        deletePressReleaseHandler(buildRequest({ pressReleaseId: 'maintenance-gate-never-existed-press-release' })),
      ).resolves.toMatchObject({ ok: true, documentDeleted: true })
    })

    it('campaignOperationsPaused:false → 放行，既有行為不受影響（目標新聞稿不存在時回傳 ok:true）', async () => {
      await setMaintenancePaused(false)
      await expect(
        deletePressReleaseHandler(buildRequest({ pressReleaseId: 'maintenance-gate-never-existed-press-release-2' })),
      ).resolves.toMatchObject({ ok: true, documentDeleted: true })
    })

    it('權限檢查在維護檢查之前：帳號未啟用時就算維護模式也是開的，看到的仍然是 permission-denied，不是維護訊息（specialist／manager 角色在預設權限矩陣下都有 editPress，所以這裡用「帳號未啟用」而不是換角色來製造權限被拒的情境——evaluateAccess() 對 active!==true 一律拒絕，發生在 authorize() 內部，比 editPress 本身的權限矩陣判斷更早）', async () => {
      await setMaintenancePaused(true)
      const inactiveEmail = 'maintenance-gate-delete-inactive@x.com'
      await db.collection('users').doc(inactiveEmail).set({
        email: inactiveEmail,
        role: 'manager',
        active: false,
      })
      const request = {
        auth: { token: { email: inactiveEmail, email_verified: true } },
        data: { pressReleaseId: PRESS_RELEASE_ID },
      } as unknown as CallableRequest<any>
      await expect(deletePressReleaseHandler(request)).rejects.toMatchObject({ code: 'permission-denied' })
    })

    // round 28 提交前審查新增：真正的成功刪除路徑——之前的測試都只驗證
    // 「目標新聞稿不存在」的早期短路分支，從未驗證過真的有檔案、真的會
    // 呼叫 getStorage().bucket()／deleteDoc／deleteFile 的那條路徑。這裡用
    // 真實 Storage emulator 種兩個真的存在的檔案，呼叫 production 使用的
    // 同一個 deletePressReleaseHandler，逐一精確驗證結果——不用「filesRemoved
    // 或 cleanupQueued 任一成立」這種寬鬆斷言，而是分別斷言兩個陣列的
    // 精確內容。
    describe('真正的成功刪除路徑（真實 Firestore + Storage emulator）', () => {
      const PRESS_RELEASE_WITH_FILES_ID = 'maintenance-gate-press-release-with-real-files'
      // ⚠️ 前綴必須是 `press/{pressReleaseId}/{attachments|hero}/`——見
      // shared/policy.ts 的 isAllowedPressFilePath()，不是
      // `pressReleases/...`（那是 Firestore collection 名稱，跟 Storage
      // 路徑前綴是兩個獨立的命名空間，容易搞混）。用錯前綴的路徑會被
      // deletePressReleaseHandler 的路徑過濾邏輯直接略過，永遠不會被刪除，
      // 這個測試就會證明不了任何事。
      const ATTACHMENT_PATH = `press/${PRESS_RELEASE_WITH_FILES_ID}/attachments/doc.pdf`
      const HERO_PATH = `press/${PRESS_RELEASE_WITH_FILES_ID}/hero/cover.jpg`

      beforeAll(async () => {
        const bucket = getStorage().bucket()
        await bucket.file(ATTACHMENT_PATH).save(Buffer.from('fake pdf bytes for test'), {
          contentType: 'application/pdf',
        })
        await bucket.file(HERO_PATH).save(Buffer.from('fake jpg bytes for test'), {
          contentType: 'image/jpeg',
        })

        await db.collection('pressReleases').doc(PRESS_RELEASE_WITH_FILES_ID).set({
          title: '有真實檔案的測試新聞稿',
          category: 'general',
          versions: {
            zh: { heroImage: { path: HERO_PATH } },
          },
          attachments: [{ name: 'doc.pdf', path: ATTACHMENT_PATH, contentType: 'application/pdf' }],
        })
      })

      it('maintenance missing、真正呼叫 deletePressReleaseHandler：文件確實刪除、兩個檔案確實從 Storage 消失、filesRemoved 精確等於這兩個路徑、cleanupQueued 與 cleanupQueueWriteFailed 都是空陣列、storageCleanupQueue 沒有新增任何項目', async () => {
        await setMaintenancePaused(undefined)

        const queueBefore = await db.collection('storageCleanupQueue').get()

        const result = (await deletePressReleaseHandler(
          buildRequest({ pressReleaseId: PRESS_RELEASE_WITH_FILES_ID }),
        )) as {
          ok: boolean
          documentDeleted: boolean
          filesRemoved: string[]
          cleanupQueued: string[]
          cleanupQueueWriteFailed: string[]
        }

        // 精確斷言，不接受「任一陣列有內容就算過」這種寬鬆寫法：
        // filesRemoved 必須恰好是這兩個路徑（順序不保證，用排序後比較），
        // cleanupQueued／cleanupQueueWriteFailed 必須是真正的空陣列
        // （PressCleanupResult 的型別本來就是 string[]，不是布林值——
        // 「沒有任何項目」的精確斷言就是 toEqual([])）。
        expect(result.ok).toBe(true)
        expect(result.documentDeleted).toBe(true)
        expect([...result.filesRemoved].sort()).toEqual([ATTACHMENT_PATH, HERO_PATH].sort())
        expect(result.cleanupQueued).toEqual([])
        expect(result.cleanupQueueWriteFailed).toEqual([])

        // Firestore 文件確實不存在。
        const pressSnap = await db.collection('pressReleases').doc(PRESS_RELEASE_WITH_FILES_ID).get()
        expect(pressSnap.exists).toBe(false)

        // 兩個檔案確實從 Storage 消失（不是只信任回傳值，直接查 emulator
        // 本身的狀態）。
        const bucket = getStorage().bucket()
        const [attachmentExists] = await bucket.file(ATTACHMENT_PATH).exists()
        const [heroExists] = await bucket.file(HERO_PATH).exists()
        expect(attachmentExists).toBe(false)
        expect(heroExists).toBe(false)

        // storageCleanupQueue 沒有新增任何項目（呼叫前後筆數相同）——
        // 兩個檔案都刪除成功，理論上不會有任何東西被記進重試佇列。
        const queueAfter = await db.collection('storageCleanupQueue').get()
        expect(queueAfter.size).toBe(queueBefore.size)
      })

      // round 28 提交前審查新增：確認既有 shared/pressCleanup 測試是否已
      // 覆蓋 Storage delete 失敗後 queue 成功／queue write 也失敗——已覆蓋，
      // 見 tests/pressCleanup.test.ts:84（Storage 清理失敗時記錄下來供
      // 重試）與 tests/pressCleanup.test.ts:110（deleteFile 與 queueRetry
      // 都失敗時），兩者都是對 deletePressReleaseWithCleanup() 本身的
      // 依賴注入純函式測試，這裡不重複。
      //
      // 但「404 視為成功」這件事不屬於 deletePressReleaseWithCleanup()
      // 本身——那支純函式完全不知道 GCS 錯誤代碼，只會呼叫注入的
      // deleteFile() 並看它 resolve 還是 reject；真正判斷「錯誤代碼是
      // 404 就當作成功」的邏輯是 functions/src/index.ts 裡
      // deletePressReleaseHandler 自己傳給 deletePressReleaseWithCleanup()
      // 的 deleteFile callback 內聯寫的（`if (err.code === 404) return`），
      // 純函式測試接觸不到這段程式碼，且抽成獨立可測函式對這兩行邏輯來說
      // 是不必要的 production 重構。這裡改用真實 Storage emulator，直接讓
      // 新聞稿引用一個從未上傳過的路徑，觸發 production 這行程式碼真的執行
      // 到、真的收到 emulator 回傳的 404，而不是自己模擬一個假的 404 物件。
      it('新聞稿引用的 Storage 路徑本來就不存在（模擬孤兒參照）：404 視為成功，算進 filesRemoved，不進 cleanupQueued／cleanupQueueWriteFailed', async () => {
        const missingId = 'maintenance-gate-press-release-missing-file'
        const missingPath = `press/${missingId}/attachments/never-uploaded.pdf`
        await db.collection('pressReleases').doc(missingId).set({
          title: '引用了不存在檔案的測試新聞稿',
          category: 'general',
          versions: {},
          attachments: [{ name: 'never-uploaded.pdf', path: missingPath, contentType: 'application/pdf' }],
        })
        // 刻意不上傳這個路徑對應的檔案——emulator 對它的 .delete() 會回傳
        // 404，這正是這個測試要驗證的情境。

        await setMaintenancePaused(false)
        const queueBefore = await db.collection('storageCleanupQueue').get()

        const result = (await deletePressReleaseHandler(buildRequest({ pressReleaseId: missingId }))) as {
          ok: boolean
          documentDeleted: boolean
          filesRemoved: string[]
          cleanupQueued: string[]
          cleanupQueueWriteFailed: string[]
        }

        expect(result.ok).toBe(true)
        expect(result.documentDeleted).toBe(true)
        expect(result.filesRemoved).toEqual([missingPath])
        expect(result.cleanupQueued).toEqual([])
        expect(result.cleanupQueueWriteFailed).toEqual([])

        const queueAfter = await db.collection('storageCleanupQueue').get()
        expect(queueAfter.size).toBe(queueBefore.size)
      })
    })
  })
})
