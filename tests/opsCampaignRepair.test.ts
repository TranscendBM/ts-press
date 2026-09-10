import { describe, expect, it } from 'vitest'
import { parseArgs } from '../functions/scripts/ops-campaign-repair.mjs'

/**
 * round 16 新增（Finding 3）、round 17 修正（Finding 6）：
 * ops-campaign-repair.mjs 的參數解析純函式測試——不連線 Firebase，只驗證
 * CLI 介面本身的行為。這支工具的核心業務邏輯（reconcile／
 * repair-press-release）直接重用 shared/campaignSend.ts 已經測過的
 * reconcileCampaignDelivery／repairCampaignPressReleaseSyncTx，不重複
 * 測試那一層；這裡只測 CLI 自己新增的部分。
 *
 * round 17 修正：parseArgs() 的契約整個改變了——不再接受未知參數、每個
 * 旗標都要求緊接一個值，`--confirm` 也從布林旗標改成需要帶值（預期跟
 * `--campaign` 相同）。
 */
describe('ops-campaign-repair.mjs 的 parseArgs（round 16 新增，round 17 修正 Finding 6）', () => {
  it('沒有任何參數 → 回傳空物件（沒有 project／campaign／action／confirmCampaignId，也沒有 error）', () => {
    expect(parseArgs([])).toEqual({})
  })

  it('解析 --project／--campaign／--action', () => {
    expect(parseArgs(['--project', 'my-proj', '--campaign', 'c1', '--action', 'reconcile'])).toEqual({
      project: 'my-proj',
      campaign: 'c1',
      action: 'reconcile',
    })
  })

  it('round 17 修正：--confirm 現在需要一個值，回傳在 confirmCampaignId', () => {
    expect(
      parseArgs([
        '--project',
        'p',
        '--campaign',
        'c',
        '--action',
        'repair-press-release',
        '--confirm',
        'c',
      ]),
    ).toEqual({
      project: 'p',
      campaign: 'c',
      action: 'repair-press-release',
      confirmCampaignId: 'c',
    })
  })

  it('參數順序不影響解析結果', () => {
    expect(
      parseArgs([
        '--confirm',
        'c1',
        '--action',
        'reconcile',
        '--campaign',
        'c1',
        '--project',
        'p1',
      ]),
    ).toEqual({
      project: 'p1',
      campaign: 'c1',
      action: 'reconcile',
      confirmCampaignId: 'c1',
    })
  })

  it('round 17 新增：未知參數回傳 error，不會被靜默忽略', () => {
    const result = parseArgs(['--project', 'p', '--bogus', 'x'])
    expect(result.error).toBeDefined()
    expect(result.error).toContain('--bogus')
  })

  it('round 17 新增：旗標缺少值（下一個 token 是另一個旗標，或已經是最後一個參數）回傳 error', () => {
    expect(parseArgs(['--project']).error).toBeDefined()
    expect(parseArgs(['--project', '--campaign', 'c1']).error).toBeDefined()
  })

  it('round 17 新增：--confirm 沒有帶值時回傳 error（不再是單純布林旗標）', () => {
    const result = parseArgs(['--project', 'p', '--campaign', 'c', '--action', 'reconcile', '--confirm'])
    expect(result.error).toBeDefined()
  })
})
