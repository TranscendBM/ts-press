/**
 * round 20 新增（Finding 2）：drain audit 掃描期間的一致性快照／穩定性協定。
 *
 * ⚠️ 背景（round 19 遺留的 P1 缺口）：舊版 audit-campaign-drain.mjs 對
 * `campaigns` collection 做一次 `.get()`，然後對「每一份」campaign 各自
 * 再對它的 `recipients` 子集合做一次獨立的 `.get()`——這兩次讀取之間完全
 * 沒有任何一致性保證。可重現的競態：
 *   1. audit 讀到 campaign（此時還沒有 activeAttemptId）
 *   2. sendCampaign／retryCampaign 這時取得了 processing lease
 *   3. audit 才讀 recipients，讀到的是還沒被這個新 lease 認領前的
 *      queued／舊狀態
 *   4. audit 用「步驟 1 的舊 campaign 快照」+「步驟 3 的 recipients」一起
 *      分類，兩者根本不是同一個時間點的資料，可能把明明已經有人在處理
 *      的 campaign 判成 SAFE
 *   5. 部署 runbook 唯一依賴的這次稽核，就這樣漏掉了一個正在進行中的
 *      lease。
 * 前端把「稽核／部署」按鈕鎖住不算數——任何有權限的人都可以直接呼叫
 * callable，一個已經在飛行中的 request 也可能在稽核跑完之後才真正拿到
 * lease，前端的鎖跟伺服器端的資料完全是兩件事。
 *
 * 這個檔案提供的是「完全跟 Firestore Admin SDK 解耦」的純編排邏輯，透過
 * 注入的 `deps` 物件存取資料，方便用 fake（不連線任何真正的 Firestore／
 * emulator）做確定性單元測試。真正連線 Firestore 的實作在
 * audit-campaign-drain.mjs 的 main() 裡組裝 `deps`，呼叫這裡的
 * runDrainAuditScan()。
 *
 * ## 機制與保證
 *
 * 對每一份 campaign：
 *   1. `before = deps.readCampaignStabilityFields(id)`——一次輕量、非
 *      transaction 的讀取，只拿 fencing 相關欄位
 *     （updateTime／leaseGeneration／activeAttemptId／
 *      resolutionLeaseAttemptId）。
 *   2. `atomic = deps.readCampaignAndRecipientsAtomic(id)`——一個 Firestore
 *      read-only transaction，在**同一次**交易裡同時讀 campaign 文件與
 *      它的 recipients 查詢。Firestore transaction 的保證是：交易內的
 *      所有讀取都反映交易開始那一刻的同一個一致快照——這就是這裡拿掉
 *     「非原子快照」問題的核心：campaign 欄位與 recipients 一定是同一個
 *      時間點的資料，不可能出現本檔案開頭描述的競態。
 *   3. `after = deps.readCampaignStabilityFields(id)`——交易結束後再讀一次
 *      同樣的 fencing 欄位。
 *   4. 比較 before／atomic 交易內讀到的 stability 欄位／after 三者是否
 *      完全相同。因為 `leaseGeneration` 是單調遞增的 fencing token（任何
 *      一次成功 acquire 都會讓它往前推進，見 shared/campaignSend.ts），
 *     「三者一致」代表：從 before 讀取的那一刻到 after 讀取的那一刻之間，
 *      沒有任何一次 lease acquire 發生過——也就是說，transaction 內部讀到
 *      的那個快照，落在一段「已確認沒有 lease 被取得」的時間窗內，可以
 *      信任它反映的是穩定狀態，不是被競態卡在中間的暫態。
 *      若三者有任何不同，代表這段窗口內確實發生了變化，這份 campaign 這
 *      一輪判定為不穩定。
 *
 * 掃描開始時記錄一次 `campaigns` collection 的完整 id 清單，掃描完所有
 * 已知 campaign 後再查一次同樣的清單——多出來的 id（幽靈 campaign：掃描
 * 開始後才建立）一律讓這一輪視為不穩定。
 *
 * 任何一份 campaign 不穩定、任何一份在窗口內被刪除、或偵測到幽靈
 * campaign，整輪掃描都視為不穩定，捨棄這一輪已經算出來的所有分類結果，
 * 重新整輪再來一次（bounded retry，預設 {@link DEFAULT_MAX_SCAN_ATTEMPTS}
 * 次）。重試預算內回到穩定狀態才回傳分類結果；用盡重試預算仍然不穩定，
 * 回傳 `stable:false`，呼叫端必須整體 fail closed（exit code 1，不得宣稱
 * 任何一份 campaign 是 SAFE）。
 *
 * ## 這個協定「沒有」保證什麼（誠實列出限制，不能過度宣稱）
 *
 * - 這不是整個 `campaigns` collection 的單一全域一致快照——每一份
 *   campaign 各自有自己獨立的穩定性窗口，不同 campaign 的窗口彼此不是
 *   同一個時間點。這對「逐份判斷這份 campaign 能不能安全部署」這個目的
 *   來說已經足夠（分類本來就是逐份獨立的），但不能拿來回答「整個資料庫
 *   在某個瞬間的全貌」這種問題。
 * - `before`／`after` 讀取跟 transaction 之間仍然有極短暫的間隔（三次
 *   個別的網路往返），理論上不是單一原子操作；`leaseGeneration` 的
 *   單調遞增特性讓「在這個間隔內取得 lease 又剛好被重設回原值」在正常
 *   使用下不可能發生，但如果有人在這個間隔內手動竄改 Firestore 資料
 *  （不透過本系統的 acquire 邏輯），理論上仍然可能構造出「三次讀取剛好
 *   都相同、但中間其實發生過寫入」的極端案例。這是本協定在 Firestore
 *   現有能力下無法完全排除的殘餘風險，見部署 runbook 與本輪報告第 9 節。
 * - 這個協定偵測「掃描期間發生了變化」，但**不會**、也不能阻止「稽核
 *   跑完、印出報告、操作員讀報告、操作員真的執行 `firebase deploy`」這
 *   段之後的時間裡才發生的變化——這正是為什麼 runbook 必須要求一個
 *   伺服器端強制的維護窗（例如：部署前用 Firestore 安全規則或一個獨立的
 *   「維護旗標」欄位擋掉所有 callable 對 campaigns/recipients 的寫入），
 *   而不能只依賴「稽核當下看起來是 SAFE」。單純一次非原子掃描完全無法
 *   證明「全部 SAFE」，這個協定把它加強成「掃描當下，逐份 campaign 都有
 *   已確認穩定的原子快照」，但仍然不是、也不能取代伺服器端強制的維護窗。
 */

/** 一輪掃描不穩定時，整個掃描最多重試幾次（含第一次）。 */
export const DEFAULT_MAX_SCAN_ATTEMPTS = 3

function stabilityFieldsEqual(a, b) {
  if (!a || !b) return false
  return (
    a.updateTimeMs === b.updateTimeMs &&
    a.leaseGeneration === b.leaseGeneration &&
    a.activeAttemptId === b.activeAttemptId &&
    a.resolutionLeaseAttemptId === b.resolutionLeaseAttemptId
  )
}

/**
 * @param {object} deps
 * @param {() => Promise<{id: string}[]>} deps.listCampaigns
 * @param {(id: string) => Promise<{updateTimeMs: number, leaseGeneration: unknown, activeAttemptId: unknown, resolutionLeaseAttemptId: unknown} | null>} deps.readCampaignStabilityFields
 * @param {(id: string) => Promise<{campaign: object, recipients: object[], stability: {updateTimeMs: number, leaseGeneration: unknown, activeAttemptId: unknown, resolutionLeaseAttemptId: unknown}} | null>} deps.readCampaignAndRecipientsAtomic
 * @param {(input: object, nowMs: number) => object} classify 對應 shared/campaignSend.ts 的 classifyCampaignForDrainAudit
 * @param {number} nowMs
 * @param {{maxAttempts?: number}} [options]
 */
export async function runDrainAuditScan(deps, classify, nowMs, options = {}) {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_SCAN_ATTEMPTS
  const attempts = []

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const initialCampaigns = await deps.listCampaigns()
    const initialIds = new Set(initialCampaigns.map((c) => c.id))

    const results = []
    const unstableCampaignIds = []
    const deletedCampaignIds = []

    for (const { id } of initialCampaigns) {
      const before = await deps.readCampaignStabilityFields(id)
      if (before === null) {
        deletedCampaignIds.push(id)
        continue
      }
      const atomic = await deps.readCampaignAndRecipientsAtomic(id)
      if (atomic === null) {
        deletedCampaignIds.push(id)
        continue
      }
      const after = await deps.readCampaignStabilityFields(id)
      if (after === null) {
        deletedCampaignIds.push(id)
        continue
      }
      if (!stabilityFieldsEqual(before, atomic.stability) || !stabilityFieldsEqual(before, after)) {
        unstableCampaignIds.push(id)
        continue
      }
      results.push(
        classify({ campaignId: id, ...atomic.campaign, recipients: atomic.recipients }, nowMs),
      )
    }

    const finalCampaigns = await deps.listCampaigns()
    const phantomIds = finalCampaigns.map((c) => c.id).filter((c) => !initialIds.has(c))

    const stable =
      unstableCampaignIds.length === 0 && deletedCampaignIds.length === 0 && phantomIds.length === 0

    attempts.push({
      attempt,
      unstableCampaignIds,
      deletedCampaignIds,
      phantomIds,
      resultCount: results.length,
    })

    if (stable) {
      return { stable: true, attemptsUsed: attempt, attempts, results }
    }
  }

  return { stable: false, attemptsUsed: maxAttempts, attempts, results: [] }
}
