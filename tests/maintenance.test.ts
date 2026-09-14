import { describe, expect, it } from 'vitest'
import {
  classifyMaintenanceFlagShape,
  decideMaintenanceCliWrite,
  isCampaignOperationsPaused,
  MAINTENANCE_DOC_PATH,
  MAINTENANCE_PAUSED_FIELD,
  MAINTENANCE_PAUSED_MESSAGE,
} from '../shared/maintenance'

/**
 * round 28 新增：shared/maintenance.ts 的純函式單元測試——不連線
 * Firestore，覆蓋 classifyMaintenanceFlagShape／isCampaignOperationsPaused／
 * decideMaintenanceCliWrite 的每一種分支。真正的 Firestore 讀寫（Admin SDK
 * 讀取、六個受管制 callable 的攔截行為、ops-maintenance.mjs 的
 * transaction）分別在 tests/systemRuntimeAdminEmulator.test.ts、
 * tests/maintenanceCallableGate.test.ts、tests/opsMaintenanceEmulator.test.ts
 * 用真實 emulator 驗證，不在這裡重複。
 */
describe('shared/maintenance.ts 常數', () => {
  it('文件路徑與欄位名稱', () => {
    expect(MAINTENANCE_DOC_PATH).toBe('system/runtime')
    expect(MAINTENANCE_PAUSED_FIELD).toBe('campaignOperationsPaused')
  })

  it('MAINTENANCE_PAUSED_MESSAGE 是通用訊息，不含內部細節', () => {
    expect(typeof MAINTENANCE_PAUSED_MESSAGE).toBe('string')
    expect(MAINTENANCE_PAUSED_MESSAGE.length).toBeGreaterThan(0)
    // 不能包含文件路徑／欄位名稱／任何看起來像 ID 的內部細節
    expect(MAINTENANCE_PAUSED_MESSAGE).not.toContain(MAINTENANCE_DOC_PATH)
    expect(MAINTENANCE_PAUSED_MESSAGE).not.toContain(MAINTENANCE_PAUSED_FIELD)
  })
})

describe('classifyMaintenanceFlagShape', () => {
  it('文件不存在 → missing（不論 rawValue 傳了什麼，都不應該影響結果）', () => {
    expect(classifyMaintenanceFlagShape(false, undefined)).toBe('missing')
    expect(classifyMaintenanceFlagShape(false, true)).toBe('missing')
    expect(classifyMaintenanceFlagShape(false, 'whatever')).toBe('missing')
  })

  it('文件存在，欄位是 true → true', () => {
    expect(classifyMaintenanceFlagShape(true, true)).toBe('true')
  })

  it('文件存在，欄位是 false → false', () => {
    expect(classifyMaintenanceFlagShape(true, false)).toBe('false')
  })

  it('文件存在，欄位是 null → malformed', () => {
    expect(classifyMaintenanceFlagShape(true, null)).toBe('malformed')
  })

  it('文件存在，欄位是非空字串 → malformed', () => {
    expect(classifyMaintenanceFlagShape(true, 'true')).toBe('malformed')
    expect(classifyMaintenanceFlagShape(true, 'yes')).toBe('malformed')
  })

  it('文件存在，欄位是數字 → malformed', () => {
    expect(classifyMaintenanceFlagShape(true, 1)).toBe('malformed')
    expect(classifyMaintenanceFlagShape(true, 0)).toBe('malformed')
  })

  it('文件存在，欄位是純物件 → malformed', () => {
    expect(classifyMaintenanceFlagShape(true, {})).toBe('malformed')
    expect(classifyMaintenanceFlagShape(true, { paused: true })).toBe('malformed')
  })

  it('文件存在，欄位是陣列 → malformed', () => {
    expect(classifyMaintenanceFlagShape(true, [])).toBe('malformed')
    expect(classifyMaintenanceFlagShape(true, [true])).toBe('malformed')
  })

  it('文件存在，但欄位本身是 undefined（own-property 顯式設成 undefined，或欄位鍵不存在——這兩種情況在 JS 物件讀取當下無法區分）→ malformed，不是 missing。' +
    '⚠️ 這裡只能證明「exists=true 且 rawValue===undefined」這個組合會被分類成 malformed；' +
    'Firestore 本身不可能儲存字面上的 undefined 值，所以呼叫端實務上只會在「文件存在但沒有這個欄位」時' +
    '傳入這個組合，這支函式本身無法、也不需要區分兩者——這是刻意的 fail-closed 設計，不是遺漏。', () => {
    expect(classifyMaintenanceFlagShape(true, undefined)).toBe('malformed')
  })
})

describe('isCampaignOperationsPaused（fail-closed 語意）', () => {
  it('read-error → true（擋下）', () => {
    expect(isCampaignOperationsPaused({ kind: 'read-error' })).toBe(true)
  })

  it('read-ok + 文件不存在 → false（放行）', () => {
    expect(isCampaignOperationsPaused({ kind: 'read-ok', exists: false, rawValue: undefined })).toBe(false)
  })

  it('read-ok + false → false（放行）', () => {
    expect(isCampaignOperationsPaused({ kind: 'read-ok', exists: true, rawValue: false })).toBe(false)
  })

  it('read-ok + true → true（擋下）', () => {
    expect(isCampaignOperationsPaused({ kind: 'read-ok', exists: true, rawValue: true })).toBe(true)
  })

  it('read-ok + malformed（null／字串／數字／物件）→ 一律 true（擋下）', () => {
    expect(isCampaignOperationsPaused({ kind: 'read-ok', exists: true, rawValue: null })).toBe(true)
    expect(isCampaignOperationsPaused({ kind: 'read-ok', exists: true, rawValue: 'true' })).toBe(true)
    expect(isCampaignOperationsPaused({ kind: 'read-ok', exists: true, rawValue: 1 })).toBe(true)
    expect(isCampaignOperationsPaused({ kind: 'read-ok', exists: true, rawValue: {} })).toBe(true)
  })
})

describe('decideMaintenanceCliWrite', () => {
  it('enable：目前 missing → write, nextPaused:true', () => {
    expect(decideMaintenanceCliWrite('missing', 'enable')).toEqual({ outcome: 'write', nextPaused: true })
  })

  it('enable：目前 false → write, nextPaused:true', () => {
    expect(decideMaintenanceCliWrite('false', 'enable')).toEqual({ outcome: 'write', nextPaused: true })
  })

  it('enable：目前 true → noop, currentPaused:true', () => {
    expect(decideMaintenanceCliWrite('true', 'enable')).toEqual({ outcome: 'noop', currentPaused: true })
  })

  it('disable：目前 true → write, nextPaused:false', () => {
    expect(decideMaintenanceCliWrite('true', 'disable')).toEqual({ outcome: 'write', nextPaused: false })
  })

  it('disable：目前 missing → noop, currentPaused:false', () => {
    expect(decideMaintenanceCliWrite('missing', 'disable')).toEqual({ outcome: 'noop', currentPaused: false })
  })

  it('disable：目前 false → noop, currentPaused:false', () => {
    expect(decideMaintenanceCliWrite('false', 'disable')).toEqual({ outcome: 'noop', currentPaused: false })
  })

  it('malformed + enable → malformed-refuse（絕不自動覆寫）', () => {
    expect(decideMaintenanceCliWrite('malformed', 'enable')).toEqual({ outcome: 'malformed-refuse' })
  })

  it('malformed + disable → malformed-refuse（絕不自動覆寫）', () => {
    expect(decideMaintenanceCliWrite('malformed', 'disable')).toEqual({ outcome: 'malformed-refuse' })
  })
})
