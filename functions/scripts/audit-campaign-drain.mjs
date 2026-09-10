#!/usr/bin/env node
/**
 * 唯讀部署淨空稽核工具（round 14 新增，Finding 3）。
 *
 * 用途：列出所有「不是 SAFE」的 campaign，讓部署 runbook（見
 * functions/src/index.ts 頂部的【淨空判斷標準】）的步驟 2／5 可以真正被
 * 驗證，不必只靠人工在 Firestore Console 裡逐份檢查——那樣容易漏掉
 * status:'partial' 但仍帶 activeAttemptId 的 campaign、舊格式 Timestamp
 * lease、resolution lease、recipients 子集合裡的 claimed／sending。
 *
 * ⚠️ 唯讀，不會、也不能修改 Firestore 任何資料——這是這支腳本唯一支援的
 *   模式，沒有任何寫入路徑。
 * ⚠️ 必須用 --project 明確指定 Firebase project ID，不會使用任何隱含的
 *   預設值（不讀 .firebaserc、不讀 GOOGLE_APPLICATION_CREDENTIALS 裡的
 *   專案），避免不小心稽核到錯的專案。
 * ⚠️ round 16 修正（Finding 6）：唯一推薦的入口是
 *   `npm run audit:drain -- --project <id>`——這個 npm script 會先跑
 *   `npm run build`（sync-shared.mjs 同步＋tsc 編譯）才執行這支腳本，
 *   保證 import 的一定是最新的分類邏輯。不要直接文件化
 *  `node scripts/audit-campaign-drain.mjs`：那個命令仍然可以執行（見下方
 *   verifyBuildFreshness 的防呆），但容易被操作人員忘記先手動 build，
 *   round 15 及之前這裡的文件字面上就是在推薦這種容易踩雷的用法。
 * ⚠️ round 16 修正（Finding 6）：即使操作人員略過 `npm run audit:drain`、
 *   直接執行這支 .mjs（例如寫在別的自動化腳本裡），也不能靜默地用一份
 *   過期的編譯產物——見下方 verifyBuildFreshness()：(1) 比對
 *   shared/campaignSend.ts 與 functions/src/campaignSend.generated.ts
 *   的實際內容（sync-shared.mjs 的複製是逐字複製，見該檔案說明），只要
 *   有一點不同就代表 sync 沒有重新跑過；(2) 比對
 *   functions/lib/campaignSend.generated.js 的 mtime 是否不早於
 *   functions/src/campaignSend.generated.ts——只要任何一項無法證明「編譯
 *   產物確實反映目前的原始碼」，就直接 exit code 2，不嘗試用一份可能過期
 *   的分類邏輯稽核任何 campaign（過期的分類邏輯回報 SAFE 完全沒有意義，
 *   比不執行更危險——它會讓操作人員誤以為真的檢查過了）。
 * ⚠️ round 15 修正（Finding 4）：先前這裡宣稱「只讀取…lease 時間戳」，
 *   但 db.collection('campaigns').get() 與收件人查詢實際上會下載整份
 *   文件——未印出的欄位仍然被讀進了 client，這句宣稱並不準確。round 15
 *   起改用 Firestore .select(...) 欄位遮罩，讓 Firestore 伺服器端就只
 *   回傳分類需要的欄位：campaign 查詢不會下載新聞稿內容、sentBy 等無關
 *   欄位；收件人查詢不會下載 email、姓名等個資欄位。沒被 .select() 選到
 *   的欄位完全不會被傳輸或讀進這支腳本的記憶體，這才是真正「不讀 PII」。
 * ⚠️ round 15 修正（Finding 4）：先前只查詢 status in ['claimed',
 *   'sending'] 的收件人，任何 unknown／malformed 的 status 值都不會出現
 *   在抽樣裡，等於被稽核工具直接忽略、可能誤判成 SAFE。round 15 起改為
 *   抓「全部」收件人（欄位仍然用 .select() 遮罩），交給
 *   classifyRecipientForDrainAudit 去判斷每一筆的 status 是否可辨識。
 * ⚠️ round 16 修正（Finding 2）：新增 leaseGeneration 欄位遮罩與傳遞——
 *   見 shared/campaignSend.ts 的 classifyLeaseGenerationForDrainAudit
 *   說明。
 *
 * 用法（唯一推薦入口）：
 *   cd functions && npm run audit:drain -- --project <firebase-project-id>
 *
 * exit code：
 *   0 — 全部 campaign 都是 SAFE，可以安全部署。
 *   1 — 至少一份 campaign 不是 SAFE（ACTIVE／INDETERMINATE／UNKNOWN／
 *       EXHAUSTED），部署程序必須阻擋，見輸出裡每一份的分類與判斷依據。
 *   2 — 執行本身失敗（缺少 --project、找不到編譯輸出、編譯產物可能過期、
 *       Firestore 連線失敗…）——這個 exit code 不代表關於 campaign 狀態的
 *       任何結論，只代表這次稽核沒有真的跑完，不能被誤判成「SAFE」。
 *
 * ⚠️ 本輪（round 14／15／16／17／20）刻意不對任何 Firebase project 實際
 * 執行這支腳本——只新增檔案本身與純分類邏輯的單元測試（見
 * tests/campaignSend.test.ts、tests/auditCampaignDrain.test.ts，兩者都不
 * 連線 Firebase／emulator）。
 * ⚠️ round 17 修正（Finding 2）：`verifyBuildFreshness()` 已經搬到完全
 *   無副作用的 audit-utils.mjs——這裡只 import，不再自己定義。這支檔案
 *   底部的 main() 呼叫現在包在 direct-execution guard 裡（見檔案最後），
 *   被其他腳本 `import` 時絕對不會被意外執行；round 16 的版本沒有這道
 *   guard，ops-campaign-repair.mjs 為了拿 verifyBuildFreshness() 而
 *   import 這支檔案時，這裡的 main() 會連帶被跑，兩支 CLI 同時各自呼叫
 *   initializeApp()，可能互相覆蓋 process.exitCode（已用無參數重現）。
 * ⚠️ round 20 修正（Finding 2，P1）：round 14～19 的版本對 `campaigns`
 *   collection 做一次 `.get()`，然後對每一份 campaign 各自再對它的
 *   `recipients` 子集合做一次獨立、不相關的 `.get()`——這兩次讀取之間
 *   完全沒有一致性保證，可能讓一份「其實已經有人在處理」的 campaign 被
 *   誤判成 SAFE（完整的競態重現與修正說明見 scripts/audit-scan.mjs 檔案
 *   開頭）。現在改用 `runDrainAuditScan()`：對每一份 campaign 用
 *   read-only transaction 同時讀 campaign 文件與 recipients 查詢（保證
 *   兩者是同一個時間點的快照），並在 transaction 前後各補一次輕量的
 *   fencing 欄位重讀，確認「這段窗口內沒有發生任何 lease acquire」；
 *   掃描前後各查一次 campaign id 清單，偵測掃描期間新建立的幽靈
 *   campaign。任何不穩定訊號都會讓整輪掃描重來（bounded retry），重試
 *   預算用盡仍不穩定則直接 exit code 1、不宣稱任何 SAFE 結論。
 *   ⚠️ 這個機制仍然不是、也不能取代伺服器端強制的維護窗——見
 *   scripts/audit-scan.mjs 檔案開頭「這個協定『沒有』保證什麼」一節，以及
 *   下方【部署 runbook 補充】。
 */
import { pathToFileURL } from 'node:url'
import { isDirectExecution, verifyBuildFreshness, compiledClassifierPath } from './audit-utils.mjs'
import { runDrainAuditScan, DEFAULT_MAX_SCAN_ATTEMPTS } from './audit-scan.mjs'

function parseArgs(argv) {
  let project
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--project') {
      project = argv[i + 1]
      i += 1
    }
  }
  return { project }
}

async function main() {
  const { project } = parseArgs(process.argv.slice(2))
  if (!project) {
    console.error(
      '缺少 Firebase project ID——請用 --project <id> 明確指定，這支腳本不會使用任何預設專案。',
    )
    process.exitCode = 2
    return
  }

  const freshness = verifyBuildFreshness()
  if (!freshness.fresh) {
    console.error(`編譯產物無法證明是最新的，拒絕執行稽核：\n${freshness.reason}`)
    console.error('建議一律使用 `npm run audit:drain -- --project <id>`——那個入口會自動先 build。')
    process.exitCode = 2
    return
  }

  // Windows 修正：compiledClassifierPath 是原始檔案系統路徑（`C:\...`），
  // Node 的 ESM 動態載入要求絕對路徑必須是合法的 file 開頭的 URL，否則
  // 會把 `C:` 誤認成不支援的 URL scheme 而丟出
  // ERR_UNSUPPORTED_ESM_URL_SCHEME——只有這裡（真的要動態載入的那一刻）需要
  // 轉成 file URL，verifyBuildFreshness() 等其餘檔案系統操作仍然用原本的
  // filesystem path，不受影響。pathToFileURL 是 Node 官方 API，正確處理
  // Windows 磁碟機代號、空白、Unicode、`#`、`%` 等需要跳脫的字元，不要自己
  // 手刻字串拼接或反斜線取代。
  //
  // （這段註解刻意不把「動態載入」跟後面的括號寫在一起、也不用完整的
  // `scheme://` 寫法──Vite 的 SSR 模組轉換用輕量 lexer 掃描 import 語法，
  // 曾經觀察到純文字註解裡出現看起來像動態載入呼叫或完整 URL 的字樣時，
  // 會誤判成真正的語法而讓整個檔案轉譯失敗；這裡只是註解措辭上的迴避，
  // 不影響下面實際程式碼的行為。）
  const { classifyCampaignForDrainAudit } = await import(pathToFileURL(compiledClassifierPath).href)

  const { initializeApp } = await import('firebase-admin/app')
  const { getFirestore, FieldPath } = await import('firebase-admin/firestore')

  initializeApp({ projectId: project })
  const db = getFirestore()
  const campaigns = db.collection('campaigns')

  console.log(`唯讀稽核：專案 ${project}（不會修改任何 Firestore 資料）`)

  const CAMPAIGN_FIELDS = [
    'status',
    'recipientsReady',
    'activeAttemptId',
    'activeLeaseExpiresAtMs',
    'activeLeaseExpiresAt',
    'resolutionLeaseAttemptId',
    'resolutionLeaseExpiresAtMs',
    'leaseGeneration',
    'createdByAttemptId',
    'startedAtMs',
    'startedAt',
  ]
  const STABILITY_FIELDS = ['leaseGeneration', 'activeAttemptId', 'resolutionLeaseAttemptId']

  function stabilityFromSnap(snap) {
    const data = snap.data()
    return {
      updateTimeMs: snap.updateTime.toMillis(),
      leaseGeneration: data.leaseGeneration ?? null,
      activeAttemptId: data.activeAttemptId ?? null,
      resolutionLeaseAttemptId: data.resolutionLeaseAttemptId ?? null,
    }
  }

  // round 20 新增（Finding 2）：真正連線 Firestore 的 deps 實作——純編排
  // 邏輯在 scripts/audit-scan.mjs（見該檔案開頭的完整說明），這裡只負責
  // 把每一個 deps 方法接到實際的 Firestore Admin SDK 呼叫。
  const deps = {
    async listCampaigns() {
      // 只要 id，不下載任何欄位——用來偵測掃描期間新建立的幽靈 campaign。
      const snap = await campaigns.select().get()
      return snap.docs.map((d) => ({ id: d.id }))
    },
    async readCampaignStabilityFields(id) {
      const snap = await campaigns.doc(id).select(...STABILITY_FIELDS).get()
      if (!snap.exists) return null
      return stabilityFromSnap(snap)
    },
    async readCampaignAndRecipientsAtomic(id) {
      // Finding 2 的核心：campaign 文件與它的 recipients 查詢在同一個
      // read-only transaction 裡一起讀，Firestore 保證兩者反映同一個時間
      // 點的快照，不會再出現「campaign 快照」跟「recipients 快照」其實
      // 來自不同時間點的競態。用 FieldPath.documentId() 的 Query（而不是
      // 直接 tx.get(DocumentReference)）是為了保留 .select(...) 欄位遮罩
      // ——維持 round 15（Finding 4）「稽核工具不下載無關欄位」的保證。
      return db.runTransaction(
        async (tx) => {
          const campaignQuerySnap = await tx.get(
            campaigns.where(FieldPath.documentId(), '==', id).select(...CAMPAIGN_FIELDS),
          )
          if (campaignQuerySnap.empty) return null
          const campaignSnap = campaignQuerySnap.docs[0]
          const data = campaignSnap.data()

          const recipientsSnap = await tx.get(
            campaigns.doc(id).collection('recipients').select('status', 'leaseExpiresAtMs', 'leaseExpiresAt'),
          )
          const recipients = recipientsSnap.docs.map((d) => {
            const r = d.data()
            return {
              status: r.status,
              leaseExpiresAtMs: r.leaseExpiresAtMs,
              leaseExpiresAtLegacy: r.leaseExpiresAt,
            }
          })

          return {
            campaign: {
              status: data.status,
              recipientsReady: data.recipientsReady,
              activeAttemptId: data.activeAttemptId,
              activeLeaseExpiresAtMs: data.activeLeaseExpiresAtMs,
              activeLeaseExpiresAtLegacy: data.activeLeaseExpiresAt,
              resolutionLeaseAttemptId: data.resolutionLeaseAttemptId,
              resolutionLeaseExpiresAtMs: data.resolutionLeaseExpiresAtMs,
              leaseGeneration: data.leaseGeneration,
              createdByAttemptId: data.createdByAttemptId,
              startedAtMs: data.startedAtMs,
              startedAtLegacy: data.startedAt,
            },
            recipients,
            stability: stabilityFromSnap(campaignSnap),
          }
        },
        { readOnly: true },
      )
    },
  }

  const nowMs = Date.now()
  const scan = await runDrainAuditScan(deps, classifyCampaignForDrainAudit, nowMs)

  if (!scan.stable) {
    console.error(
      `稽核在 ${scan.attemptsUsed} 次嘗試（重試上限 ${DEFAULT_MAX_SCAN_ATTEMPTS}）內都無法取得穩定快照——` +
        '掃描期間持續有 campaign 正在被寫入、被刪除，或有新的 campaign 被建立。',
    )
    for (const a of scan.attempts) {
      const parts = []
      if (a.unstableCampaignIds.length > 0) parts.push(`不穩定=[${a.unstableCampaignIds.join(', ')}]`)
      if (a.deletedCampaignIds.length > 0) parts.push(`掃描期間消失=[${a.deletedCampaignIds.join(', ')}]`)
      if (a.phantomIds.length > 0) parts.push(`幽靈 campaign=[${a.phantomIds.join(', ')}]`)
      console.error(`  第 ${a.attempt} 次嘗試：${parts.length > 0 ? parts.join('；') : '（無明細）'}`)
    }
    console.error(
      '這不是「稽核工具本身失敗」，而是資料庫目前處於持續變動的狀態，無法在掃描期間內取得任何' +
        '可信任的快照。不能假設「重試次數用盡代表大概率是 SAFE」——正確做法是先確保部署前的維護窗' +
        '（見本檔案頂端與 functions/src/index.ts 的部署 runbook：伺服器端強制擋掉所有寫入，不只是' +
        '前端按鈕鎖住），排除持續寫入的來源後再重新執行本稽核。',
    )
    process.exitCode = 1
    return
  }

  if (scan.attemptsUsed > 1) {
    console.log(
      `（第 1 次嘗試偵測到掃描期間資料變動，已自動重試，第 ${scan.attemptsUsed} 次嘗試取得穩定快照。）`,
    )
  }

  const results = scan.results
  const nonSafe = results.filter((r) => r.classification !== 'SAFE')

  console.log(`共檢查 ${results.length} 份 campaign，${nonSafe.length} 份不是 SAFE。`)
  if (nonSafe.length > 0) {
    console.log('')
    console.log('非 SAFE 的 campaign：')
    for (const r of nonSafe) {
      console.log(
        `- ${r.campaignId} | status=${r.status} | 分類=${r.classification} | ` +
          `setup phase=${r.setupPhase} | ` +
          `processing lease=${r.processingLease} | resolution lease=${r.resolutionLease} | ` +
          `lease generation=${r.leaseGeneration} | ` +
          `收件人數=${r.recipientCount} ` +
          `(active=${r.activeRecipientCount} / indeterminate=${r.indeterminateRecipientCount} / unknown=${r.unknownRecipientCount})`,
      )
      // round 20 新增（Finding 1）：campaign.status 本身不是
      // isKnownCampaignStatus() 認可的五個合法值之一時，明確印出這一行，
      // 不能只靠籠統的 INDETERMINATE 分類讓操作員自己猜原因——見
      // shared/campaignSend.ts 的 isKnownCampaignStatus() 說明。
      if (!r.campaignStatusValid) {
        console.log(
          `  ⚠️ ${r.campaignId}: campaign.status missing or invalid（實際值：${r.status}）——` +
            '不是 sending／partial／completed／failed／needs_review 五個已知合法值之一，' +
            '這個欄位本身無法信任，需要人工檢查這份文件的完整內容，不能假設安全。',
        )
      }
      // round 19 新增（Finding 1）：只要 campaign 的宣稱狀態跟真實收件人
      // 分佈對不上（decideCampaignStatus() 用真實分佈重新算出來的結果跟
      // campaign.status 不一致），就在這裡明確列出各個 status 的實際筆數，
      // 讓操作員不必自己另外去 Firestore 查——這是 classification 至少是
      // INDETERMINATE 的直接原因之一，不能只看上面那一行的彙總數字。
      if (!r.recipientDistributionConsistent) {
        const c = r.recipientStatusCounts
        console.log(
          `  ⚠️ ${r.campaignId} 的 status（${r.status}）跟收件人子集合的真實分佈不一致——` +
            '用真實分佈重新套用 decideCampaignStatus() 算出來的結果跟宣稱的 status 對不上，' +
            '代表 campaign 文件本身可能是資料損毀，或收尾邏輯有 bug，需要人工檢查，不能假設安全。' +
            `\n     收件人狀態分佈：queued=${c.queued} claimed=${c.claimed} sending=${c.sending} ` +
            `sent=${c.sent} failed=${c.failed} exhausted=${c.exhausted} ` +
            `delivery_unknown=${c.delivery_unknown} malformed=${c.malformed}`,
        )
      }
      if (r.leaseGeneration === 'exhausted') {
        // round 18 修正（Finding 3）；round 19 修正（Finding 1）：只有走到
        // 這裡（分類仍然是非 SAFE）的 exhausted 才需要這段警告——
        // classifyCampaignForDrainAudit() 已經會把「completed／failed、
        // 無 owner、無 active／unknown／indeterminate 收件人、且真實收件人
        // 分佈能自然推出目前 status」的 exhausted 自動折算成 SAFE（見下面的
        // 【已知例外】區塊），不會出現在這裡。能走到這裡代表 harmless 的
        // 條件沒有全部成立——不能假設這份 campaign 已經真的做完了。
        console.log(
          `  ⚠️ ${r.campaignId} 的 leaseGeneration 已經到達 Number.MAX_SAFE_INTEGER，` +
            '而且不符合「確定無害」的條件（見下方 leaseGenerationExhaustionHarmless=false：' +
            '狀態不是 completed／failed，仍有 owner／active／unknown／indeterminate 的訊號，' +
            '或收件人真實分佈跟宣稱的 status 對不上——見上方的分佈明細）。' +
            '在正常使用下這個值不可能被自然到達，應該視為資料損毀或人為植入的測試資料。' +
            '任何後續的 acquireCampaignLeaseTx／acquireResolutionLeaseTx（含 reconciliation 自己的 ' +
            'acquireLease）都會永久回傳 generation-exhausted，這份 campaign 文件從此無法再被本系統 ' +
            '任何流程（一般寄送、重試、reconciliation、resolution）合法取得租約。' +
            '\n     ⚠️ 不要人工在 Firestore Console 把 leaseGeneration 重設成較小的值——這會破壞 ' +
            'fencing token「單調遞增」的核心不變量：任何一個曾經合法持有過舊 generation、但流程本身 ' +
            '（例如卡在重試佇列、逾時後才真正送達的 request）尚未真正結束的呼叫，都可能在重設之後 ' +
            '意外重新「符合」一個被重複使用的 generation 值，讓已經失效的身分重新獲得 fencing 通過權，' +
            '這正是這一整套 generation 機制原本要防止的事。' +
            '\n     必須交由人工 escalation 判斷（不透過這支腳本或 ops-campaign-repair.mjs 自動處理）：' +
            '先確認上面列出的 owner／收件人訊號分別代表什麼（是不是真的還在進行中），' +
            '若確認寄送工作尚未完成，正確做法是另外建立一份新的 campaign 文件處理剩餘收件人，' +
            '並且不再對這份耗盡的文件做任何寫入。',
        )
      }
    }
    console.log('')
  }

  // round 18 新增（Finding 3）：即使不阻擋部署，也要讓「exhausted 但已確認
  // 無害」的 campaign 在輸出裡可見——這是可稽核、由現有欄位自動計算出來的
  // 結果（見 shared/campaignSend.ts 的 isGenerationExhaustionHarmless()），
  // 不是操作員口頭確認的例外，但仍然值得留下記錄，避免看起來像是稽核工具
  // 忽略了這個異常資料。
  const harmlessExhausted = results.filter((r) => r.leaseGenerationExhaustionHarmless)
  if (harmlessExhausted.length > 0) {
    console.log(
      `【已知例外】${harmlessExhausted.length} 份 campaign 的 leaseGeneration 已耗盡，` +
        '但已確認 completed／failed、無任何 owner／active／unknown／indeterminate 收件人、' +
        '且收件人真實分佈能自然推出目前的 status（round 19 新增，Finding 1），' +
        '不會再需要任何流程 acquire，判定為 SAFE，不阻擋部署：',
    )
    for (const r of harmlessExhausted) {
      console.log(`  - ${r.campaignId} | status=${r.status}`)
    }
    console.log('')
  }

  if (nonSafe.length > 0) {
    console.error(
      '部署必須阻擋：以上非 SAFE 的 campaign 需要先處理（見 functions/src/index.ts 頂部的部署 runbook）。',
    )
    process.exitCode = 1
    return
  }

  console.log('全部 campaign 都是 SAFE，可以安全部署。')
  process.exitCode = 0
}

// round 17 新增（Finding 2）：direct-execution guard——只有這支檔案被當成
// 程式進入點直接執行時才會呼叫 main()。被其他模組 import 時（例如
// ops-campaign-repair.mjs 想拿同目錄的共用 utils）絕對不會執行到這裡。
if (isDirectExecution(import.meta.url)) {
  main().catch((err) => {
    console.error('稽核執行失敗：', err)
    process.exitCode = 2
  })
}
