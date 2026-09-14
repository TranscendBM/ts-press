import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { verifyBuildFreshness, getDocumentByIdWithFieldMask } from '../functions/scripts/audit-utils.mjs'
import { runDrainAuditScan, DEFAULT_MAX_SCAN_ATTEMPTS } from '../functions/scripts/audit-scan.mjs'
import {
  summarizeDrainAuditResults,
  LEGACY_COMPLETED_PARTIAL_WARNING_REASON,
  CAMPAIGN_FIELDS,
} from '../functions/scripts/audit-campaign-drain.mjs'
import { CAMPAIGN_REPAIR_CLASSIFICATION_FIELDS } from '../functions/scripts/ops-campaign-repair.mjs'
import {
  classifyCampaignForDrainAudit,
  type CampaignDrainAuditInput,
  type RecipientDrainSample,
} from '../shared/campaignSend'

/**
 * round 25 新增：getDocumentByIdWithFieldMask() 的純函式行為（不連線任何
 * 真正的 Firestore／emulator，用 fake collectionRef 模擬 query 結果）——
 * 這個 helper 是 round 25 修正「DocumentReference 沒有 .select()」這個 bug
 * 的核心（見 audit-campaign-drain.mjs 的 readCampaignStabilityFields()、
 * ops-campaign-repair.mjs 的 createClassificationLoader()，兩者現在都呼叫
 * 這裡同一份函式）。
 *
 * ⚠️「查到超過 1 筆時 fail closed」這個分支，在真正的 Firestore 裡幾乎不可能
 * 自然發生（同一個 collection 裡文件 ID 本身就是唯一的，用
 * FieldPath.documentId() 精確比對正常只會查到 0 或 1 筆）——所以這裡用
 * fake collectionRef 直接模擬「查詢層回傳了超過 1 筆」這個不應該發生的
 * 狀況，驗證 helper 本身確實會 fail closed（throw），而不是靜默取
 * docs[0]。這是測 helper 這一層的防呆邏輯本身，不是在測 Firestore。
 */
describe('getDocumentByIdWithFieldMask（round 25 新增：DocumentReference 沒有 .select() 的修法）', () => {
  const fakeFieldPath = { documentId: () => 'FieldPath.documentId()-sentinel' }

  function makeFakeCollectionRef(queryResult: {
    empty: boolean
    size: number
    docs: Array<{ id: string; data: () => Record<string, unknown> }>
  }) {
    const calls: { where?: unknown[]; select?: unknown[] } = {}
    return {
      path: 'fake-collection',
      where(field: unknown, op: unknown, value: unknown) {
        calls.where = [field, op, value]
        return {
          select(...fields: string[]) {
            calls.select = fields
            return {
              async get() {
                return queryResult
              },
            }
          },
        }
      },
      __calls: calls,
    }
  }

  it('查無此文件（empty）→ 回傳 null', async () => {
    const ref = makeFakeCollectionRef({ empty: true, size: 0, docs: [] })
    const result = await getDocumentByIdWithFieldMask(ref, 'missing-id', ['a', 'b'], fakeFieldPath)
    expect(result).toBeNull()
  })

  it('正常情況（剛好 1 筆）→ 回傳那一筆 QueryDocumentSnapshot，且用 FieldPath.documentId() 精確比對、field mask 完整傳遞', async () => {
    const doc = { id: 'the-doc', data: () => ({ a: 1 }) }
    const ref = makeFakeCollectionRef({ empty: false, size: 1, docs: [doc] })
    const result = await getDocumentByIdWithFieldMask(ref, 'the-doc', ['a', 'b'], fakeFieldPath)
    expect(result).toBe(doc)
    expect(ref.__calls.where).toEqual(['FieldPath.documentId()-sentinel', '==', 'the-doc'])
    expect(ref.__calls.select).toEqual(['a', 'b'])
  })

  it('查到超過 1 筆（理論上不應該發生）→ fail closed，throw，不會靜默取 docs[0]', async () => {
    const ref = makeFakeCollectionRef({
      empty: false,
      size: 2,
      docs: [
        { id: 'dup-1', data: () => ({}) },
        { id: 'dup-2', data: () => ({}) },
      ],
    })
    await expect(getDocumentByIdWithFieldMask(ref, 'dup', ['a'], fakeFieldPath)).rejects.toThrow(/2 筆/)
  })
})

/**
 * round 16 新增（Finding 6）：verifyBuildFreshness() 的純檔案系統層級
 * 測試——完全不連線 Firebase，只驗證「編譯產物是否可能過期」這件事本身
 * 判斷得對不對。用真實的暫存檔案（不是 mock fs），因為這支函式本身就是
 * 直接讀寫真實檔案系統，mock 掉反而測不到真正的行為。
 */
describe('verifyBuildFreshness（round 16 新增，Finding 6：偵測 stale/missing 的編譯產物）', () => {
  let dir: string

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  function setup() {
    dir = mkdtempSync(join(tmpdir(), 'audit-drain-freshness-'))
    const sharedSourcePath = join(dir, 'campaignSend.ts')
    const generatedSourcePath = join(dir, 'campaignSend.generated.ts')
    const compiledPath = join(dir, 'campaignSend.generated.js')
    return { sharedSourcePath, generatedSourcePath, compiledPath }
  }

  const BANNER = '// 自動產生，請勿直接修改。\n// 來源：shared/campaignSend.ts\n\n'

  it('三份檔案都存在、內容同步、compiled mtime 不早於 generated → fresh:true', () => {
    const { sharedSourcePath, generatedSourcePath, compiledPath } = setup()
    const sourceContent = 'export const x = 1\n'
    writeFileSync(sharedSourcePath, sourceContent)
    writeFileSync(generatedSourcePath, BANNER + sourceContent)
    writeFileSync(compiledPath, 'exports.x = 1\n')

    const now = Date.now() / 1000
    utimesSync(generatedSourcePath, now, now)
    utimesSync(compiledPath, now + 10, now + 10) // compiled 比 generated 新

    expect(verifyBuildFreshness({ sharedSourcePath, generatedSourcePath, compiledPath })).toEqual({
      fresh: true,
    })
  })

  it('shared 原始碼不存在 → fresh:false', () => {
    const { sharedSourcePath, generatedSourcePath, compiledPath } = setup()
    writeFileSync(generatedSourcePath, BANNER + 'export const x = 1\n')
    writeFileSync(compiledPath, 'exports.x = 1\n')

    const result = verifyBuildFreshness({ sharedSourcePath, generatedSourcePath, compiledPath })
    expect(result.fresh).toBe(false)
    expect(result.reason).toContain(sharedSourcePath)
  })

  it('同步後的 generated.ts 不存在（從未跑過 sync-shared.mjs）→ fresh:false，訊息提示要跑 npm run build', () => {
    const { sharedSourcePath, generatedSourcePath, compiledPath } = setup()
    writeFileSync(sharedSourcePath, 'export const x = 1\n')
    writeFileSync(compiledPath, 'exports.x = 1\n')

    const result = verifyBuildFreshness({ sharedSourcePath, generatedSourcePath, compiledPath })
    expect(result.fresh).toBe(false)
    expect(result.reason).toContain('npm run build')
  })

  it('編譯產物不存在（從未跑過 tsc）→ fresh:false', () => {
    const { sharedSourcePath, generatedSourcePath, compiledPath } = setup()
    const sourceContent = 'export const x = 1\n'
    writeFileSync(sharedSourcePath, sourceContent)
    writeFileSync(generatedSourcePath, BANNER + sourceContent)

    const result = verifyBuildFreshness({ sharedSourcePath, generatedSourcePath, compiledPath })
    expect(result.fresh).toBe(false)
    expect(result.reason).toContain(compiledPath)
  })

  it('generated.ts 的內容跟目前的 shared 原始碼不一致（改了原始碼但沒重新 sync）→ fresh:false', () => {
    const { sharedSourcePath, generatedSourcePath, compiledPath } = setup()
    writeFileSync(sharedSourcePath, 'export const x = 2 // 剛剛改過\n')
    writeFileSync(generatedSourcePath, BANNER + 'export const x = 1 // 舊版本\n')
    writeFileSync(compiledPath, 'exports.x = 1\n')

    const result = verifyBuildFreshness({ sharedSourcePath, generatedSourcePath, compiledPath })
    expect(result.fresh).toBe(false)
    expect(result.reason).toContain('npm run build')
  })

  it('內容同步，但 compiled mtime 早於 generated（sync 了但沒真的重新 tsc）→ fresh:false', () => {
    const { sharedSourcePath, generatedSourcePath, compiledPath } = setup()
    const sourceContent = 'export const x = 1\n'
    writeFileSync(sharedSourcePath, sourceContent)
    writeFileSync(generatedSourcePath, BANNER + sourceContent)
    writeFileSync(compiledPath, 'exports.x = 1\n')

    const now = Date.now() / 1000
    utimesSync(compiledPath, now - 100, now - 100) // compiled 比 generated 舊
    utimesSync(generatedSourcePath, now, now)

    const result = verifyBuildFreshness({ sharedSourcePath, generatedSourcePath, compiledPath })
    expect(result.fresh).toBe(false)
    expect(result.reason).toContain('npm run build')
  })

  it('shared 原始碼是空檔案（防禦性：避免空字串的 endsWith 恆真造成誤判 fresh）→ fresh:false', () => {
    const { sharedSourcePath, generatedSourcePath, compiledPath } = setup()
    writeFileSync(sharedSourcePath, '')
    writeFileSync(generatedSourcePath, BANNER)
    writeFileSync(compiledPath, '')

    const result = verifyBuildFreshness({ sharedSourcePath, generatedSourcePath, compiledPath })
    expect(result.fresh).toBe(false)
  })
})

/**
 * round 20 新增（Finding 2，P1）：runDrainAuditScan() 的一致性快照／穩定性
 * 協定——完全用注入的 fake deps 模擬 Firestore 行為（不連線任何真正的
 * Firestore／emulator），對應 scripts/audit-scan.mjs 檔案開頭列出的每一種
 * 競態情境。fake deps 用一個簡單的、按呼叫次序推進的「劇本」模型：每個
 * campaign 有一個 stability 欄位的時間序列，第幾次被讀到就回傳序列裡的
 * 第幾筆——藉此精確重現「兩次讀取之間發生了變化」的時序，不必真的並行
 * 執行任何非同步程式碼。
 */
describe('runDrainAuditScan（round 20 新增，Finding 2：掃描期間一致性快照／穩定性協定）', () => {
  const NOW_MS = 1_700_000_000_000

  /** 一份 campaign 的 fake 資料來源：stabilitySequence 依序對應
   *  「before 讀取」「atomic transaction 內讀取」「after 讀取」……每多呼叫
   *  一次 readCampaignStabilityFields 或 readCampaignAndRecipientsAtomic
   *  就往後推進一格，序列用完後停在最後一筆（模擬「後來就穩定下來了」，
   *  用於測試 bounded retry 最終成功的情境）。`null` 代表這次讀取時文件
   *  已經不存在（模擬刪除）。 */
  function makeCampaignScript(
    id: string,
    stabilitySequence: Array<
      | { updateTimeMs: number; leaseGeneration: number | null; activeAttemptId: string | null; resolutionLeaseAttemptId: string | null }
      | null
    >,
    campaignFields: Record<string, unknown> = { status: 'completed', recipientsReady: true },
    recipients: CampaignDrainAuditInput['recipients'] = [],
  ) {
    let cursor = 0
    function next() {
      const value = stabilitySequence[Math.min(cursor, stabilitySequence.length - 1)]
      cursor += 1
      return value
    }
    return {
      id,
      readStability: async () => next(),
      readAtomic: async () => {
        const stability = next()
        if (stability === null) return null
        return { campaign: { campaignId: id, ...campaignFields }, recipients, stability }
      },
    }
  }

  function buildDeps(scripts: ReturnType<typeof makeCampaignScript>[], extraFinalIds: string[] = []) {
    const byId = new Map(scripts.map((s) => [s.id, s]))
    return {
      async listCampaigns() {
        return [...scripts.map((s) => ({ id: s.id })), ...extraFinalIds.map((id) => ({ id }))].filter(
          (v, i, arr) => arr.findIndex((x) => x.id === v.id) === i,
        )
      },
      async readCampaignStabilityFields(id: string) {
        const s = byId.get(id)
        return s ? s.readStability() : null
      },
      async readCampaignAndRecipientsAtomic(id: string) {
        const s = byId.get(id)
        return s ? s.readAtomic() : null
      },
    }
  }

  // listCampaigns() 在 runDrainAuditScan 內被呼叫兩次（掃描前／掃描後）；
  // 上面的 buildDeps 用「掃描前固定回傳已知 campaign」＋「額外的幽靈 id
  // 只在之後才出現」比較繁瑣，這裡改用呼叫計數器精準控制第幾次呼叫回傳
  // 什麼，模擬「幽靈 campaign 在掃描期間才建立」。
  function buildDepsWithPhantom(
    scripts: ReturnType<typeof makeCampaignScript>[],
    phantomIdsAfterFirstList: string[],
  ) {
    const byId = new Map(scripts.map((s) => [s.id, s]))
    let listCalls = 0
    return {
      async listCampaigns() {
        listCalls += 1
        const base = scripts.map((s) => ({ id: s.id }))
        return listCalls === 1 ? base : [...base, ...phantomIdsAfterFirstList.map((id) => ({ id }))]
      },
      async readCampaignStabilityFields(id: string) {
        const s = byId.get(id)
        return s ? s.readStability() : null
      },
      async readCampaignAndRecipientsAtomic(id: string) {
        const s = byId.get(id)
        return s ? s.readAtomic() : null
      },
    }
  }

  const stableFields = (leaseGeneration: number | null = null, owner: string | null = null) => ({
    updateTimeMs: 1000,
    leaseGeneration,
    activeAttemptId: owner,
    resolutionLeaseAttemptId: null,
  })

  it('穩定快照（before／atomic／after 三者完全一致）→ stable:true，一次嘗試就成功，分類結果正確（SAFE）', async () => {
    const script = makeCampaignScript('c1', [stableFields(), stableFields(), stableFields()])
    const deps = buildDeps([script])
    const result = await runDrainAuditScan(deps, classifyCampaignForDrainAudit, NOW_MS)
    expect(result.stable).toBe(true)
    expect(result.attemptsUsed).toBe(1)
    expect(result.results).toHaveLength(1)
    expect(result.results[0].classification).toBe('SAFE')
  })

  it('campaign 在第一次讀取之後才取得 processing lease（before 讀到 absent，transaction 內讀到 present）→ 這一輪不穩定，重試後（lease 狀態穩定下來）成功', async () => {
    // 序列：before=absent、atomic=present（剛好在這之間取得了 lease）、
    // after=present——第一次嘗試 before≠atomic，不穩定；重試時
    // stabilitySequence 已經用完，停在最後一筆（present），三次讀取都一致
    // → 第二次嘗試穩定。
    const script = makeCampaignScript('c1', [
      stableFields(1, null), // before（第一次嘗試）：absent
      stableFields(2, 'attempt-x'), // atomic（第一次嘗試）：剛取得 lease
      stableFields(2, 'attempt-x'), // after（第一次嘗試）
    ])
    const deps = buildDeps([script])
    const result = await runDrainAuditScan(deps, classifyCampaignForDrainAudit, NOW_MS)
    expect(result.attempts[0].unstableCampaignIds).toEqual(['c1'])
    expect(result.stable).toBe(true)
    expect(result.attemptsUsed).toBe(2)
  })

  it('leaseGeneration／owner 在 transaction 讀完之後（after 重讀時）發生變化 → 這一輪不穩定', async () => {
    const script = makeCampaignScript('c1', [
      stableFields(1, null), // before
      stableFields(1, null), // atomic（跟 before 一致）
      stableFields(2, 'attempt-y'), // after：變了
    ])
    const deps = buildDeps([script])
    const result = await runDrainAuditScan(deps, classifyCampaignForDrainAudit, NOW_MS, {
      maxAttempts: 1,
    })
    expect(result.stable).toBe(false)
    expect(result.attempts[0].unstableCampaignIds).toEqual(['c1'])
  })

  it('掃描期間有新的 campaign 被建立（幽靈 campaign，只出現在掃描後的第二次 listCampaigns）→ 這一輪不穩定', async () => {
    const script = makeCampaignScript('c1', [stableFields(), stableFields(), stableFields()])
    const deps = buildDepsWithPhantom([script], ['phantom-c2'])
    const result = await runDrainAuditScan(deps, classifyCampaignForDrainAudit, NOW_MS, {
      maxAttempts: 1,
    })
    expect(result.stable).toBe(false)
    expect(result.attempts[0].phantomIds).toEqual(['phantom-c2'])
  })

  it('campaign 在掃描期間被刪除（before 讀取時已經不存在）→ 這一輪不穩定，列在 deletedCampaignIds', async () => {
    const script = makeCampaignScript('c1', [null])
    const deps = buildDeps([script])
    const result = await runDrainAuditScan(deps, classifyCampaignForDrainAudit, NOW_MS, {
      maxAttempts: 1,
    })
    expect(result.stable).toBe(false)
    expect(result.attempts[0].deletedCampaignIds).toEqual(['c1'])
    expect(result.results).toEqual([])
  })

  it('campaign 在 transaction 讀取時才發現已被刪除（before 存在，atomic 回傳 null）→ 這一輪不穩定，列在 deletedCampaignIds', async () => {
    const script = makeCampaignScript('c1', [stableFields(), null])
    const deps = buildDeps([script])
    const result = await runDrainAuditScan(deps, classifyCampaignForDrainAudit, NOW_MS, {
      maxAttempts: 1,
    })
    expect(result.stable).toBe(false)
    expect(result.attempts[0].deletedCampaignIds).toEqual(['c1'])
  })

  it('持續不穩定（每一輪、每一次讀取都不一樣）超過重試預算 → 整體 stable:false，fail closed，不回傳任何分類結果', async () => {
    // 用一個「每次呼叫都回傳遞增 updateTimeMs」的腳本模擬永不停止的變動：
    // stabilitySequence 只給有限筆，用完就停在最後一筆——為了讓每一輪都
    // 不穩定，這裡改用會無限遞增的自訂 deps（不透過 makeCampaignScript）。
    let counter = 0
    const deps = {
      async listCampaigns() {
        return [{ id: 'c1' }]
      },
      async readCampaignStabilityFields() {
        counter += 1
        return stableFields(counter, null)
      },
      async readCampaignAndRecipientsAtomic() {
        counter += 1
        return { campaign: { campaignId: 'c1', status: 'completed' }, recipients: [], stability: stableFields(counter, null) }
      },
    }
    const result = await runDrainAuditScan(deps, classifyCampaignForDrainAudit, NOW_MS, {
      maxAttempts: 3,
    })
    expect(result.stable).toBe(false)
    expect(result.attemptsUsed).toBe(3)
    expect(result.attempts).toHaveLength(3)
    for (const a of result.attempts) {
      expect(a.unstableCampaignIds).toEqual(['c1'])
    }
    expect(result.results).toEqual([])
  })

  it('預設的重試上限是 DEFAULT_MAX_SCAN_ATTEMPTS（不用明確傳 options 也適用）', async () => {
    let counter = 0
    const deps = {
      async listCampaigns() {
        return [{ id: 'c1' }]
      },
      async readCampaignStabilityFields() {
        counter += 1
        return stableFields(counter, null)
      },
      async readCampaignAndRecipientsAtomic() {
        counter += 1
        return { campaign: { campaignId: 'c1', status: 'completed' }, recipients: [], stability: stableFields(counter, null) }
      },
    }
    const result = await runDrainAuditScan(deps, classifyCampaignForDrainAudit, NOW_MS)
    expect(result.attemptsUsed).toBe(DEFAULT_MAX_SCAN_ATTEMPTS)
    expect(result.stable).toBe(false)
  })

  it('多份 campaign 混合：一份穩定、一份不穩定 → 整輪仍然視為不穩定（不能因為其他份都沒事就放行整體 SAFE 結論）', async () => {
    const stableScript = makeCampaignScript('c-stable', [stableFields(), stableFields(), stableFields()])
    const unstableScript = makeCampaignScript('c-unstable', [
      stableFields(1, null),
      stableFields(2, 'someone'),
      stableFields(2, 'someone'),
    ])
    const deps = buildDeps([stableScript, unstableScript])
    const result = await runDrainAuditScan(deps, classifyCampaignForDrainAudit, NOW_MS, {
      maxAttempts: 1,
    })
    expect(result.stable).toBe(false)
    expect(result.attempts[0].unstableCampaignIds).toEqual(['c-unstable'])
  })

  // round 27 新增（Finding 1）：一份符合 legacy 例外形狀的 completed
  // campaign（跟 tests/campaignSend.test.ts 的 SAFE_WITH_WARNING 矩陣用
  // 同一種合成資料慣例，跟真實資料的 campaignId／人數完全不同），在完整
  // 掃描協定裡也確實會被分類成 SAFE_WITH_WARNING——證明 round 20 新增的
  // 穩定快照協定（見 audit-scan.mjs）跟這裡新增的分類邏輯正確接軌，
  // SAFE_WITH_WARNING 不會被穩定性檢查誤傷，也不會繞過它。
  it('legacy 形狀的 completed campaign，在穩定的掃描窗口內 → stable:true，分類為 SAFE_WITH_WARNING', async () => {
    const legacyRecipients: CampaignDrainAuditInput['recipients'] = [
      { status: 'sent', leaseExpiresAtMs: undefined, leaseExpiresAtLegacy: undefined },
      { status: 'sent', leaseExpiresAtMs: undefined, leaseExpiresAtLegacy: undefined },
      { status: 'failed', leaseExpiresAtMs: undefined, leaseExpiresAtLegacy: undefined },
    ]
    const script = makeCampaignScript(
      'synthetic-scan-legacy',
      [stableFields(), stableFields(), stableFields()],
      // round 27 提交前審查修正：campaignRawData:{} 是一個真正「什麼欄位
      // 都沒有」的原始物件，讓 isFieldAbsent()／hasOwnProperty 判斷
      // recipientsReady／createdAt／updatedAt／completedAt 完全不存在——
      // 不能只靠「這個 JS 測試物件沒設這幾個 key」，round 27 提交前審查已
      // 改成必須看 campaignRawData 本身。
      { status: 'completed', campaignRawData: {} },
      legacyRecipients,
    )
    const deps = buildDeps([script])
    const result = await runDrainAuditScan(deps, classifyCampaignForDrainAudit, NOW_MS)
    expect(result.stable).toBe(true)
    expect(result.results).toHaveLength(1)
    expect(result.results[0].classification).toBe('SAFE_WITH_WARNING')
  })

  // 提交前審查 Finding 2（額外組合測試）：同一份 legacy 形狀的 campaign，
  // 但這次讓 before／atomic／after 三次讀取本身不一致（掃描期間有人取得了
  // 處理租約）——證明「這份 campaign 的內容長得像 legacy 例外」完全不影響
  // 外層的穩定快照協定：協定本身在 classify() 被呼叫之前就已經判定不穩定，
  // 重試預算用盡後 stable:false、results 是空陣列，不會有任何分類結果
  // （更不可能是 SAFE_WITH_WARNING）流出去。這對應 isLegacyCompletedPartialMismatchSafe()
  // 文件裡條件 21「快照穩定性由呼叫端負責，這個函式本身不參與、也不能參與」
  // 的實際證明。
  it('legacy 形狀的 completed campaign，但快照本身持續不穩定 → stable:false，不回傳任何分類結果（不會是 SAFE_WITH_WARNING，也不是任何其他分類）', async () => {
    const legacyRecipients: CampaignDrainAuditInput['recipients'] = [
      { status: 'sent', leaseExpiresAtMs: undefined, leaseExpiresAtLegacy: undefined },
      { status: 'failed', leaseExpiresAtMs: undefined, leaseExpiresAtLegacy: undefined },
    ]
    // 每一輪重試都讀到不同的 leaseGeneration，永遠不會穩定下來。
    let counter = 0
    const script = {
      id: 'synthetic-scan-legacy-unstable',
      readStability: async () => {
        counter += 1
        return { updateTimeMs: counter, leaseGeneration: null, activeAttemptId: null, resolutionLeaseAttemptId: null }
      },
      readAtomic: async () => {
        counter += 1
        return {
          campaign: {
            campaignId: 'synthetic-scan-legacy-unstable',
            status: 'completed',
            campaignRawData: {},
          },
          recipients: legacyRecipients,
          stability: {
            updateTimeMs: counter,
            leaseGeneration: null,
            activeAttemptId: null,
            resolutionLeaseAttemptId: null,
          },
        }
      },
    }
    const deps = buildDeps([script])
    const result = await runDrainAuditScan(deps, classifyCampaignForDrainAudit, NOW_MS)
    expect(result.stable).toBe(false)
    expect(result.results).toEqual([])
  })
})

describe('summarizeDrainAuditResults（round 27 新增，Finding 1：CLI 彙總邏輯——SAFE 與 SAFE_WITH_WARNING 必須分開計數，且兩者都不阻擋部署）', () => {
  const NOW_MS = 1_700_000_000_000

  /** 用真正的 classifyCampaignForDrainAudit() 產生結果（不是手刻假物件），
   *  確保這裡測的是跟 production 100% 相同的 CampaignDrainAuditResult
   *  形狀。campaignId／收件人數量全部是合成值。 */
  function classify(overrides: Partial<CampaignDrainAuditInput> = {}) {
    const base: CampaignDrainAuditInput = {
      campaignId: 'synthetic-summary-campaign',
      status: 'sending',
      recipientsReady: true,
      activeAttemptId: undefined,
      activeLeaseExpiresAtMs: undefined,
      activeLeaseExpiresAtLegacy: undefined,
      resolutionLeaseAttemptId: undefined,
      resolutionLeaseExpiresAtMs: undefined,
      leaseGeneration: 1,
      createdByAttemptId: undefined,
      startedAtMs: undefined,
      startedAtLegacy: undefined,
      // 提交前審查 Finding 1：不提供 campaignRawData——這個 describe 區塊的
      // 「一般」情境（status:'sending'）不需要 legacy 例外，legacyWarningResult()
      // 才會另外提供一個真正「什麼欄位都沒有」的 campaignRawData。
      recipients: [],
      ...overrides,
    }
    return classifyCampaignForDrainAudit(base, NOW_MS)
  }

  function legacyWarningResult(campaignId: string) {
    const recipients: RecipientDrainSample[] = [
      { status: 'sent', leaseExpiresAtMs: undefined, leaseExpiresAtLegacy: undefined },
      { status: 'failed', leaseExpiresAtMs: undefined, leaseExpiresAtLegacy: undefined },
    ]
    return classify({
      campaignId,
      status: 'completed',
      recipientsReady: undefined,
      // 提交前審查 Finding 1：campaignRawData:{} 是真正「什麼欄位都沒有」
      // 的原始物件——hasOwnProperty 對 recipientsReady／createdAt／
      // updatedAt／completedAt 都回傳 false，才符合 isFieldAbsent() 判斷
      // 的「完全缺席」語意，不是只靠這個 JS 測試物件沒設這幾個 key。
      campaignRawData: {},
      leaseGeneration: undefined,
      recipients,
    })
  }

  it('SAFE 與 SAFE_WITH_WARNING 分開計數，不會互相併吞', () => {
    const safe = classify({ campaignId: 'c-safe' })
    const warning = legacyWarningResult('c-warning')
    expect(safe.classification).toBe('SAFE')
    expect(warning.classification).toBe('SAFE_WITH_WARNING')

    const { counts } = summarizeDrainAuditResults([safe, warning])
    expect(counts.SAFE).toBe(1)
    expect(counts.SAFE_WITH_WARNING).toBe(1)
    expect(counts.ACTIVE).toBe(0)
    expect(counts.UNKNOWN).toBe(0)
    expect(counts.INDETERMINATE).toBe(0)
    expect(counts.EXHAUSTED).toBe(0)
  })

  it('純 SAFE、純 SAFE_WITH_WARNING、兩者混合 → exitCode 都是 0，blocking 清單都是空的', () => {
    const safe1 = classify({ campaignId: 'c-safe-1' })
    const safe2 = classify({ campaignId: 'c-safe-2' })
    const warning1 = legacyWarningResult('c-warning-1')
    const warning2 = legacyWarningResult('c-warning-2')

    for (const batch of [[safe1, safe2], [warning1, warning2], [safe1, warning1, safe2, warning2]]) {
      const summary = summarizeDrainAuditResults(batch)
      expect(summary.exitCode).toBe(0)
      expect(summary.blocking).toEqual([])
    }
  })

  it('一份 SAFE_WITH_WARNING 加上一份阻擋部署的 campaign（同一輪）→ exitCode 是 1，blocking 只包含真正阻擋的那一份', () => {
    const warning = legacyWarningResult('c-warning')
    const active = classify({
      campaignId: 'c-active',
      status: 'sending',
      recipientsReady: true,
      activeAttemptId: 'someone',
      activeLeaseExpiresAtMs: NOW_MS + 60_000,
    })
    expect(active.classification).toBe('ACTIVE')

    const summary = summarizeDrainAuditResults([warning, active])
    expect(summary.exitCode).toBe(1)
    expect(summary.blocking).toHaveLength(1)
    expect(summary.blocking[0].campaignId).toBe('c-active')
    expect(summary.warnings).toHaveLength(1)
    expect(summary.warnings[0].campaignId).toBe('c-warning')
  })

  it('SAFE_WITH_WARNING 的原因說明字串存在、非空，且明確提到不要 backfill recipientsReady、不要執行 repair-status——供 CLI 輸出使用', () => {
    expect(typeof LEGACY_COMPLETED_PARTIAL_WARNING_REASON).toBe('string')
    expect(LEGACY_COMPLETED_PARTIAL_WARNING_REASON.length).toBeGreaterThan(0)
    expect(LEGACY_COMPLETED_PARTIAL_WARNING_REASON).toContain('recipientsReady')
    expect(LEGACY_COMPLETED_PARTIAL_WARNING_REASON).toContain('repair-status')
  })

  it('回傳的結果物件裡完全沒有收件人 email／姓名等個資欄位——這份彙總只處理 classifyCampaignForDrainAudit() 已經過 field mask 遮罩的結果，不會、也不能引入 PII', () => {
    const warning = legacyWarningResult('c-warning')
    const summary = summarizeDrainAuditResults([warning])
    const serialized = JSON.stringify(summary)
    expect(serialized).not.toMatch(/email/i)
    expect(serialized).not.toMatch(/@.+\..+/) // 沒有任何看起來像 email 地址的字串
    expect(serialized).not.toContain('name')
  })

  // round 27 新增：連線／掃描不穩定時的 exit code 2 行為屬於 main() 本身
  // （scan.stable===false 時直接 process.exitCode=1？不——見 main() 原始碼：
  // 這裡刻意重新確認一次，避免文件跟程式碼漂移）。main() 在 !scan.stable
  // 時會在呼叫 summarizeDrainAuditResults() 之前就 return，這是既有（round
  // 20）行為，這一輪完全沒有修改那一段，這裡只用程式碼本身的結構性事實
  // （guard clause 先 return）佐證，不去重新實作一份 main() 的 mock——那樣
  // 反而會製造一份容易漂移的複製品。exit code 2 的情境（缺 --project、
  // 編譯產物過期、Firestore 連線失敗）完全不涉及 summarizeDrainAuditResults()，
  // 本輪也沒有改動那幾段程式碼。
  it('（文件性測試）scan 不穩定時 main() 在呼叫 summarizeDrainAuditResults() 之前就已經 return——這裡驗證的是 summarizeDrainAuditResults() 本身不會被空陣列以外的任何隱含假設絆倒，避免未來重構不小心讓它在不穩定掃描時被誤呼叫', () => {
    const summary = summarizeDrainAuditResults([])
    expect(summary).toEqual({
      counts: { SAFE: 0, SAFE_WITH_WARNING: 0, ACTIVE: 0, UNKNOWN: 0, INDETERMINATE: 0, EXHAUSTED: 0 },
      blocking: [],
      warnings: [],
      exitCode: 0,
    })
  })
})

describe('field mask 完整性（round 27 提交前審查 Finding 3）：SAFE_WITH_WARNING 的 legacy 例外需要的四個欄位必須真的被查詢——直接檢查 production 的 field-mask 常數本身，不在測試裡另外複製一份欄位清單', () => {
  const REQUIRED_LEGACY_FIELDS = ['recipientsReady', 'createdAt', 'updatedAt', 'completedAt']

  it('audit-campaign-drain.mjs 的 CAMPAIGN_FIELDS（唯一 export 的 field-mask 常數，main() 與 createDrainAuditDeps() 都用同一份）包含全部四個欄位', () => {
    for (const field of REQUIRED_LEGACY_FIELDS) {
      expect(CAMPAIGN_FIELDS).toContain(field)
    }
  })

  it('ops-campaign-repair.mjs 的 CAMPAIGN_REPAIR_CLASSIFICATION_FIELDS（reconcile／repair-press-release 的 dry-run／confirm 共用的 field-mask 常數）也包含全部四個欄位——避免它跟 audit:drain 對同一份 campaign 算出不同的 classification', () => {
    for (const field of REQUIRED_LEGACY_FIELDS) {
      expect(CAMPAIGN_REPAIR_CLASSIFICATION_FIELDS).toContain(field)
    }
  })
})
