import { describe, expect, it } from 'vitest'
import {
  ADMIN_ONLY_PERMISSIONS,
  DEFAULT_PERMISSIONS,
  PERMISSIONS,
  hasPermission,
  normalizeRole,
  resolvePermissions,
  validateUserDoc,
} from '../shared/permissions'

describe('normalizeRole', () => {
  it('舊的 editor 對應到行銷專員', () => {
    expect(normalizeRole('editor')).toBe('specialist')
  })

  it('現行角色原樣回傳', () => {
    expect(normalizeRole('admin')).toBe('admin')
    expect(normalizeRole('manager')).toBe('manager')
    expect(normalizeRole('specialist')).toBe('specialist')
  })

  it('未知或空值回傳 undefined', () => {
    expect(normalizeRole('superuser')).toBeUndefined()
    expect(normalizeRole(undefined)).toBeUndefined()
    expect(normalizeRole('')).toBeUndefined()
  })
})

describe('預設權限', () => {
  it('行銷專員完全不能發送，連測試信也不行', () => {
    expect(hasPermission('specialist', 'sendTest')).toBe(false)
    expect(hasPermission('specialist', 'sendReal')).toBe(false)
  })

  it('舊的 editor 帳號套用行銷專員的權限', () => {
    expect(hasPermission('editor', 'sendTest')).toBe(false)
    expect(hasPermission('editor', 'sendReal')).toBe(false)
    expect(hasPermission('editor', 'manageContacts')).toBe(true)
  })

  it('行銷專員可以開稿件、下載、維護名單與媒體關係', () => {
    for (const p of ['viewPress', 'editPress', 'downloadPress', 'manageContacts', 'manageEvents'] as const) {
      expect(hasPermission('specialist', p), p).toBe(true)
    }
  })

  it('主管可以正式發送但不能改系統設定', () => {
    expect(hasPermission('manager', 'sendReal')).toBe(true)
    expect(hasPermission('manager', 'manageSettings')).toBe(false)
    expect(hasPermission('manager', 'manageUsers')).toBe(false)
  })

  it('管理員擁有全部權限', () => {
    for (const p of PERMISSIONS) {
      expect(hasPermission('admin', p), p).toBe(true)
    }
  })

  it('未知角色一律沒有權限', () => {
    for (const p of PERMISSIONS) {
      expect(hasPermission('hacker', p), p).toBe(false)
      expect(hasPermission(undefined, p), p).toBe(false)
    }
  })
})

describe('resolvePermissions 覆寫', () => {
  it('後台可以放行行銷專員寄測試信', () => {
    const m = resolvePermissions({ specialist: { sendTest: true } })
    expect(m.specialist.sendTest).toBe(true)
    // 其他項目維持預設
    expect(m.specialist.sendReal).toBe(false)
  })

  it('缺漏的欄位退回預設值', () => {
    const m = resolvePermissions({ manager: {} })
    expect(m.manager).toEqual(DEFAULT_PERMISSIONS.manager)
  })

  it('非布林值的覆寫會被忽略', () => {
    const m = resolvePermissions({
      specialist: { sendReal: 'yes' as unknown as boolean },
    })
    expect(m.specialist.sendReal).toBe(false)
  })

  it('admin 專屬權限不可被授予其他角色', () => {
    const m = resolvePermissions({
      specialist: { manageUsers: true, manageSettings: true },
      manager: { manageUsers: true },
    })
    for (const p of ADMIN_ONLY_PERMISSIONS) {
      expect(m.specialist[p], p).toBe(false)
      expect(m.manager[p], p).toBe(false)
      expect(m.admin[p], p).toBe(true)
    }
  })

  it('admin 專屬權限也不能從 admin 身上移除', () => {
    const m = resolvePermissions({ admin: { manageSettings: false } })
    expect(m.admin.manageSettings).toBe(true)
  })

  it('未知角色的覆寫不影響現行角色', () => {
    const m = resolvePermissions({ ghost: { sendReal: true } })
    expect(m).toEqual(resolvePermissions(undefined))
  })
})

describe('validateUserDoc', () => {
  const ok = { email: 'a@b.com', role: 'manager', active: true }

  it('合法文件沒有問題', () => {
    expect(validateUserDoc(ok)).toEqual([])
  })

  it('active 為字串時回報型別問題', () => {
    const issues = validateUserDoc({ ...ok, active: 'true' })
    expect(issues).toHaveLength(1)
    expect(issues[0].field).toBe('active')
    expect(issues[0].actual).toContain('string')
  })

  it('缺少 active 欄位會被標示', () => {
    const issues = validateUserDoc({ email: 'a@b.com', role: 'admin' })
    expect(issues.map((i) => i.field)).toContain('active')
    expect(issues[0].actual).toBe('（缺少欄位）')
  })

  it('舊的 editor 標示為需要遷移而非完全錯誤', () => {
    const issues = validateUserDoc({ ...ok, role: 'editor' })
    expect(issues).toHaveLength(1)
    expect(issues[0].message).toContain('舊代號')
    expect(issues[0].message).toContain('行銷專員')
  })

  it('未知 role 回報允許值', () => {
    const issues = validateUserDoc({ ...ok, role: 'superuser' })
    expect(issues[0].message).toContain('specialist')
  })

  it('email 缺失或非字串會被標示', () => {
    expect(validateUserDoc({ role: 'admin', active: true })[0].field).toBe(
      'email',
    )
    expect(
      validateUserDoc({ email: 123, role: 'admin', active: true })[0].field,
    ).toBe('email')
  })

  it('多個問題會一次列出', () => {
    expect(validateUserDoc({ role: 'x', active: 'y' })).toHaveLength(3)
  })
})
