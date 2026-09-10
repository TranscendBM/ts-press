import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)

const AUDIT_SCRIPT = fileURLToPath(
  new URL('../functions/scripts/audit-campaign-drain.mjs', import.meta.url),
)
const OPS_SCRIPT = fileURLToPath(new URL('../functions/scripts/ops-campaign-repair.mjs', import.meta.url))

/**
 * round 17 新增（Finding 2）：用真正的子行程（child_process）直接執行這兩支
 * CLI，證明：
 * - 各自直接執行時只印出自己的一次錯誤訊息、只有一個 exit code 2，
 *   不會互相汙染（round 16 版本 ops-campaign-repair.mjs import
 *   audit-campaign-drain.mjs 時，那支檔案自己的 main() 會意外一起執行，
 *   造成兩份不同的「缺少 project」錯誤同時出現，已用無參數重現過）。
 * - 完全不連線 Firebase（無參數時在連線之前就已經因為缺少 --project
 *   直接失敗，不會呼叫 initializeApp()）。
 *
 * ⚠️ 這裡刻意不帶任何 --project，確保不會意外對真實 Firebase project
 * 做任何事情——這正是本輪禁止事項之一。
 */
describe('CLI direct execution（round 17 新增，Finding 2）', () => {
  it('audit-campaign-drain.mjs 無參數直接執行 → 只印一次「缺少 project」錯誤，exit code 2，不含 ops CLI 的錯誤訊息', async () => {
    await expect(execFileAsync('node', [AUDIT_SCRIPT])).rejects.toMatchObject({
      code: 2,
    })
    const result = await execFileAsync('node', [AUDIT_SCRIPT]).catch((e) => e)
    const stderr = String(result.stderr ?? '')
    const projectErrorCount = (stderr.match(/缺少 Firebase project ID/g) ?? []).length
    expect(projectErrorCount).toBe(1)
    expect(stderr).not.toContain('缺少 --campaign')
    expect(stderr).not.toContain('缺少或不合法的 --action')
  })

  it('ops-campaign-repair.mjs 無參數直接執行 → 只印一次自己的「缺少 project」錯誤，exit code 2，不含 audit CLI 的輸出', async () => {
    const result = await execFileAsync('node', [OPS_SCRIPT]).catch((e) => e)
    expect(result.code).toBe(2)
    const stderr = String(result.stderr ?? '')
    const projectErrorCount = (stderr.match(/缺少 --project/g) ?? []).length
    expect(projectErrorCount).toBe(1)
    // round 16 的核心迴歸案例：audit-campaign-drain.mjs 的稽核輸出（唯讀
    // 稽核：專案...）不應該出現在 ops CLI 的輸出裡。
    expect(String(result.stdout ?? '')).not.toContain('唯讀稽核')
    expect(stderr).not.toContain('缺少 Firebase project ID')
  })

  it('ops-campaign-repair.mjs 帶 --project 但缺 --campaign → 只有 ops CLI 自己的錯誤，仍然 exit 2，且不會啟動 audit 的 main()', async () => {
    const result = await execFileAsync('node', [OPS_SCRIPT, '--project', 'fake-project']).catch(
      (e) => e,
    )
    expect(result.code).toBe(2)
    const stderr = String(result.stderr ?? '')
    expect(stderr).toContain('--campaign')
    expect(String(result.stdout ?? '')).not.toContain('唯讀稽核')
  })

  it('ops-campaign-repair.mjs 拒絕未知參數', async () => {
    const result = await execFileAsync('node', [
      OPS_SCRIPT,
      '--project',
      'p',
      '--campaign',
      'c1',
      '--action',
      'reconcile',
      '--bogus-flag',
      'x',
    ]).catch((e) => e)
    expect(result.code).toBe(2)
    expect(String(result.stderr ?? '')).toContain('未知的參數')
  })

  it('ops-campaign-repair.mjs 拒絕含 "/" 或空白的 --campaign', async () => {
    for (const badId of ['a/b', 'has space', '', '   ']) {
      const result = await execFileAsync('node', [
        OPS_SCRIPT,
        '--project',
        'p',
        '--campaign',
        badId,
        '--action',
        'reconcile',
      ]).catch((e) => e)
      expect(result.code).toBe(2)
    }
  })

  it('ops-campaign-repair.mjs 的 --confirm 值跟 --campaign 不相符時拒絕執行（不會靜默退回 dry-run）', async () => {
    const result = await execFileAsync('node', [
      OPS_SCRIPT,
      '--project',
      'p',
      '--campaign',
      'c1',
      '--action',
      'reconcile',
      '--confirm',
      'c2',
    ]).catch((e) => e)
    expect(result.code).toBe(2)
    expect(String(result.stderr ?? '')).toContain('不相符')
  })
})
