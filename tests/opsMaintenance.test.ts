import { describe, expect, it } from 'vitest'
import { parseArgs, validateAction } from '../functions/scripts/ops-maintenance.mjs'

/**
 * round 28 新增：ops-maintenance.mjs 的參數解析／驗證純函式測試——不連線
 * Firebase，只驗證 CLI 介面本身的行為，跟 tests/opsCampaignRepair.test.ts
 * 同一種取捨（核心業務邏輯已經在 tests/maintenance.test.ts 覆蓋
 * decideMaintenanceCliWrite／classifyMaintenanceFlagShape，這裡只測 CLI
 * 自己新增的部分）。
 *
 * 「缺少／不符的 --confirm 一定會在任何 Firestore 呼叫之前 return」這件事
 * 用 parseArgs()＋validateAction() 這兩個純函式來證明：main() 對這兩個函式
 * 的呼叫結構上都在 initializeApp／getFirestore／runTransaction 之前（見
 * ops-maintenance.mjs 本身的程式碼），只要這兩個純函式在該回傳 error 時
 * 確實回傳 error，main() 就一定會在那之後立刻 return，不可能繼續往下走到
 * 任何網路呼叫——這是跟 tests/opsCampaignRepair.test.ts 完全相同的策略，
 * 不需要另外 mock 整個 Admin SDK 才能證明這個保證。
 */
describe('ops-maintenance.mjs 的 parseArgs', () => {
  it('沒有任何參數 → 回傳空物件（沒有 project／action／confirm，也沒有 error）', () => {
    expect(parseArgs([])).toEqual({})
  })

  it('解析 --project／--action／--confirm', () => {
    expect(parseArgs(['--project', 'p', '--action', 'enable', '--confirm', 'enable'])).toEqual({
      project: 'p',
      action: 'enable',
      confirm: 'enable',
    })
  })

  it('參數順序不影響解析結果', () => {
    expect(parseArgs(['--confirm', 'disable', '--action', 'disable', '--project', 'p'])).toEqual({
      project: 'p',
      action: 'disable',
      confirm: 'disable',
    })
  })

  it('status 不需要 --confirm 也能正確解析', () => {
    expect(parseArgs(['--project', 'p', '--action', 'status'])).toEqual({
      project: 'p',
      action: 'status',
    })
  })

  it('未知參數回傳 error，不會被靜默忽略', () => {
    const result = parseArgs(['--project', 'p', '--bogus', 'x'])
    expect(result.error).toBeDefined()
    expect(result.error).toContain('--bogus')
  })

  it('旗標缺少值（下一個 token 是另一個旗標，或已經是最後一個參數）回傳 error', () => {
    expect(parseArgs(['--project']).error).toBeDefined()
    expect(parseArgs(['--project', '--action', 'status']).error).toBeDefined()
  })
})

describe('ops-maintenance.mjs 的 validateAction', () => {
  it('action 不是 status／enable／disable 之一 → error', () => {
    expect(validateAction('bogus', undefined).error).toBeDefined()
    expect(validateAction(undefined, undefined).error).toBeDefined()
  })

  it('status 不需要 confirm，一律 ok', () => {
    expect(validateAction('status', undefined)).toEqual({ ok: true })
    // 即使不小心帶了 confirm 也不影響 status（status 本身不檢查 confirm 的值）。
    expect(validateAction('status', 'enable')).toEqual({ ok: true })
  })

  it('enable／disable 缺少 confirm → error（視為不相符，不會靜默退回唯讀）', () => {
    expect(validateAction('enable', undefined).error).toBeDefined()
    expect(validateAction('disable', undefined).error).toBeDefined()
  })

  it('enable／disable 的 confirm 值跟 action 不相符 → error', () => {
    expect(validateAction('enable', 'disable').error).toBeDefined()
    expect(validateAction('disable', 'enable').error).toBeDefined()
    expect(validateAction('enable', 'yes').error).toBeDefined()
  })

  it('enable／disable 的 confirm 值跟 action 完全相符 → ok', () => {
    expect(validateAction('enable', 'enable')).toEqual({ ok: true })
    expect(validateAction('disable', 'disable')).toEqual({ ok: true })
  })
})
