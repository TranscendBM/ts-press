import { describe, expect, it, vi } from 'vitest'
import {
  checkPermission,
  describeDecision,
  isWellFormedRoles,
  type PermissionsReader,
} from '../shared/permissions'

/**
 * 這裡完全不碰網路或 Firestore —— reader 是注入的，
 * 才能穩定重現「讀取失敗」「資料畸形」這些真實環境難以觸發的情境。
 */
const missing: PermissionsReader = async () => ({ exists: false })

const withRoles = (roles: unknown): PermissionsReader => async () => ({
  exists: true,
  roles,
})

const throwing =
  (err: unknown): PermissionsReader =>
  async () => {
    throw err
  }

describe('checkPermission — 讀取失敗一律拒絕', () => {
  it('Firestore permission-denied → 拒絕', async () => {
    const err = Object.assign(new Error('Missing or insufficient permissions'), {
      code: 7,
    })
    const d = await checkPermission('admin', 'sendReal', throwing(err))
    expect(d).toEqual({ allowed: false, reason: 'read-error' })
  })

  it('Firestore unavailable → 拒絕', async () => {
    const err = Object.assign(new Error('service unavailable'), { code: 14 })
    const d = await checkPermission('manager', 'sendReal', throwing(err))
    expect(d).toEqual({ allowed: false, reason: 'read-error' })
  })

  it('逾時 → 拒絕', async () => {
    const d = await checkPermission(
      'manager',
      'sendReal',
      throwing(new DOMException('The operation timed out', 'TimeoutError')),
    )
    expect(d).toEqual({ allowed: false, reason: 'read-error' })
  })

  it('reader 回傳非預期形狀 → 拒絕', async () => {
    const bogus = (async () => null) as unknown as PermissionsReader
    const d = await checkPermission('admin', 'sendReal', bogus)
    expect(d).toEqual({ allowed: false, reason: 'invalid-document' })
  })

  it('即使是 admin，讀取失敗也不得放行', async () => {
    const d = await checkPermission(
      'admin',
      'manageSettings',
      throwing(new Error('boom')),
    )
    expect(d.allowed).toBe(false)
  })

  it('讀取失敗時不會退回預設矩陣', async () => {
    // manager 在預設矩陣中是可以正式發送的，讀取失敗仍必須拒絕
    const fallback = await checkPermission('manager', 'sendReal', missing)
    expect(fallback.allowed).toBe(true)

    const failed = await checkPermission(
      'manager',
      'sendReal',
      throwing(new Error('network')),
    )
    expect(failed.allowed).toBe(false)
  })
})

describe('checkPermission — 文件不存在時使用預設值', () => {
  it('未設定過時套用預設矩陣', async () => {
    expect((await checkPermission('manager', 'sendReal', missing)).allowed).toBe(
      true,
    )
    expect(
      (await checkPermission('specialist', 'sendReal', missing)).allowed,
    ).toBe(false)
    expect(
      (await checkPermission('specialist', 'sendTest', missing)).allowed,
    ).toBe(false)
  })

  it('預設值本身是最小權限：行銷專員不能發送', async () => {
    for (const p of ['sendTest', 'sendReal', 'manageUsers', 'manageSettings'] as const) {
      expect((await checkPermission('specialist', p, missing)).allowed, p).toBe(
        false,
      )
    }
  })
})

describe('checkPermission — 畸形資料一律拒絕', () => {
  const cases: [string, unknown][] = [
    ['roles 是字串', 'everything'],
    ['roles 是陣列', ['admin']],
    ['roles 是 null', null],
    ['roles 是數字', 42],
    ['未知角色', { superuser: { sendReal: true } }],
    ['舊代號當作 key', { editor: { sendReal: true } }],
    ['未知權限鍵', { manager: { hackAll: true } }],
    ['權限值是字串', { manager: { sendReal: 'true' } }],
    ['權限值是數字', { manager: { sendReal: 1 } }],
    ['權限值是 null', { manager: { sendReal: null } }],
    ['角色的值不是物件', { manager: 'all' }],
    ['角色的值是陣列', { manager: ['sendReal'] }],
  ]

  for (const [name, roles] of cases) {
    it(`${name} → 拒絕`, async () => {
      const d = await checkPermission('manager', 'sendReal', withRoles(roles))
      expect(d).toEqual({ allowed: false, reason: 'invalid-document' })
    })
  }

  it('畸形資料不會因為使用者是 admin 就放行', async () => {
    const d = await checkPermission(
      'admin',
      'sendReal',
      withRoles({ manager: { sendReal: 'true' } }),
    )
    expect(d.allowed).toBe(false)
  })
})

describe('checkPermission — 只有明確合法的 true 才允許', () => {
  it('明確為 false → 拒絕', async () => {
    const d = await checkPermission(
      'manager',
      'sendReal',
      withRoles({ manager: { sendReal: false } }),
    )
    expect(d).toEqual({ allowed: false, reason: 'denied' })
  })

  it('明確為 true → 允許', async () => {
    const d = await checkPermission(
      'specialist',
      'sendTest',
      withRoles({ specialist: { sendTest: true } }),
    )
    expect(d).toEqual({ allowed: true })
  })

  it('未列出的權限沿用預設，不會自動變成允許', async () => {
    const roles = { specialist: { sendTest: true } }
    expect(
      (await checkPermission('specialist', 'sendReal', withRoles(roles))).allowed,
    ).toBe(false)
  })

  it('未知角色 → 拒絕', async () => {
    expect(
      (await checkPermission('superuser', 'viewPress', missing)).allowed,
    ).toBe(false)
    expect((await checkPermission(undefined, 'viewPress', missing)).allowed).toBe(
      false,
    )
    expect((await checkPermission('', 'viewPress', missing)).allowed).toBe(false)
  })

  it('未知權限 → 拒絕，且不會去讀設定', async () => {
    const read = vi.fn(missing)
    const d = await checkPermission(
      'admin',
      'deleteEverything' as never,
      read as PermissionsReader,
    )
    expect(d.allowed).toBe(false)
    expect(read).not.toHaveBeenCalled()
  })

  it('admin 專屬權限無法透過覆寫授予他人', async () => {
    const d = await checkPermission(
      'manager',
      'manageSettings',
      withRoles({ manager: { manageSettings: true } }),
    )
    expect(d.allowed).toBe(false)
  })

  it('舊的 editor 帳號套用行銷專員權限', async () => {
    expect((await checkPermission('editor', 'sendTest', missing)).allowed).toBe(
      false,
    )
    expect(
      (await checkPermission('editor', 'manageContacts', missing)).allowed,
    ).toBe(true)
  })
})

describe('isWellFormedRoles', () => {
  it('接受合法結構與空物件', () => {
    expect(isWellFormedRoles({})).toBe(true)
    expect(isWellFormedRoles({ admin: {} })).toBe(true)
    expect(isWellFormedRoles({ manager: { sendReal: false } })).toBe(true)
  })

  it('拒絕非物件', () => {
    expect(isWellFormedRoles(undefined)).toBe(false)
    expect(isWellFormedRoles(null)).toBe(false)
    expect(isWellFormedRoles('x')).toBe(false)
    expect(isWellFormedRoles([])).toBe(false)
  })
})

describe('describeDecision', () => {
  it('讀取失敗與資料錯誤給不同說明', () => {
    expect(
      describeDecision({ allowed: false, reason: 'read-error' }, 'sendReal'),
    ).toContain('無法讀取權限設定')
    expect(
      describeDecision(
        { allowed: false, reason: 'invalid-document' },
        'sendReal',
      ),
    ).toContain('格式不正確')
    expect(
      describeDecision({ allowed: false, reason: 'denied' }, 'sendReal'),
    ).toContain('正式發送')
  })

  it('允許時沒有訊息', () => {
    expect(describeDecision({ allowed: true }, 'sendReal')).toBe('')
  })
})
