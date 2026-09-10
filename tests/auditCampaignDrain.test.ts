import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { verifyBuildFreshness, getDocumentByIdWithFieldMask } from '../functions/scripts/audit-utils.mjs'
import { runDrainAuditScan, DEFAULT_MAX_SCAN_ATTEMPTS } from '../functions/scripts/audit-scan.mjs'
import { classifyCampaignForDrainAudit, type CampaignDrainAuditInput } from '../shared/campaignSend'

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
})
