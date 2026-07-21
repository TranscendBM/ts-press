/**
 * 角色與權限。
 *
 * 權限矩陣預設寫在這裡，但可由管理員在後台覆寫並存進 settings/permissions。
 * 前端用來決定顯示什麼、Cloud Functions 用來實際擋下操作 ——
 * 前端的隱藏只是體驗，真正的把關一律在後端。
 */

export const ROLES = ['admin', 'manager', 'specialist'] as const
export type Role = (typeof ROLES)[number]

export const ROLE_LABELS: Record<Role, string> = {
  admin: '管理員',
  manager: '主管',
  specialist: '行銷專員',
}

export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  admin: '系統管理者，可調整權限與寄信設定',
  manager: '可正式發送新聞稿',
  specialist: '維護名單與稿件，不能發送',
}

/** 已停用的角色代號對應到現行角色，既有資料不必改。 */
const LEGACY_ROLES: Record<string, Role> = { editor: 'specialist' }

export function normalizeRole(role: string | undefined): Role | undefined {
  if (!role) return undefined
  if ((ROLES as readonly string[]).includes(role)) return role as Role
  return LEGACY_ROLES[role]
}

export const PERMISSIONS = [
  'viewPress',
  'editPress',
  'downloadPress',
  'sendTest',
  'sendReal',
  'manageContacts',
  'manageEvents',
  'viewCampaigns',
  'manageUsers',
  'manageSettings',
] as const
export type Permission = (typeof PERMISSIONS)[number]

export const PERMISSION_LABELS: Record<Permission, string> = {
  viewPress: '檢視新聞稿',
  editPress: '編輯新聞稿',
  downloadPress: '下載 Word / PDF',
  sendTest: '寄送測試信',
  sendReal: '正式發送',
  manageContacts: '維護媒體名單',
  manageEvents: '維護媒體關係',
  viewCampaigns: '檢視發送紀錄',
  manageUsers: '管理使用者',
  manageSettings: '系統與寄信設定',
}

export type RolePermissions = Record<Permission, boolean>
export type PermissionMatrix = Record<Role, RolePermissions>

function build(granted: Permission[]): RolePermissions {
  return Object.fromEntries(
    PERMISSIONS.map((p) => [p, granted.includes(p)]),
  ) as RolePermissions
}

/**
 * 預設權限。行銷專員可以開稿件、下載檔案、維護名單與媒體關係，
 * 但完全不能發送 —— 連測試信都不行。
 */
export const DEFAULT_PERMISSIONS: PermissionMatrix = {
  admin: build([...PERMISSIONS]),
  manager: build([
    'viewPress',
    'editPress',
    'downloadPress',
    'sendTest',
    'sendReal',
    'manageContacts',
    'manageEvents',
    'viewCampaigns',
  ]),
  specialist: build([
    'viewPress',
    'editPress',
    'downloadPress',
    'manageContacts',
    'manageEvents',
    'viewCampaigns',
  ]),
}

/**
 * 這些權限只有 admin 能持有，後台介面不開放調整。
 * 否則管理員可能不小心把自己以外的角色提升到能改權限，形成提權漏洞。
 */
export const ADMIN_ONLY_PERMISSIONS: Permission[] = [
  'manageUsers',
  'manageSettings',
]

/**
 * 合併預設值與後台覆寫。任何缺漏欄位都退回預設，
 * 避免設定檔不完整就讓某個角色意外拿到或失去權限。
 */
export function resolvePermissions(
  overrides?: Partial<Record<string, Partial<RolePermissions>>>,
): PermissionMatrix {
  const out = {} as PermissionMatrix
  for (const role of ROLES) {
    const base = DEFAULT_PERMISSIONS[role]
    const patch = overrides?.[role] ?? {}
    const merged = { ...base } as RolePermissions
    for (const p of PERMISSIONS) {
      if (typeof patch[p] === 'boolean') merged[p] = patch[p]
      // admin 專屬權限一律不受覆寫影響
      if (ADMIN_ONLY_PERMISSIONS.includes(p)) merged[p] = role === 'admin'
    }
    out[role] = merged
  }
  return out
}

/** 判斷某個角色是否具備指定權限。角色無效時一律拒絕。 */
export function hasPermission(
  role: string | undefined,
  permission: Permission,
  overrides?: Partial<Record<string, Partial<RolePermissions>>>,
): boolean {
  const normalized = normalizeRole(role)
  if (!normalized) return false
  return resolvePermissions(overrides)[normalized][permission] === true
}

/** users 文件的資料問題。只用於回報，不自動修正。 */
export interface UserDocIssue {
  field: 'role' | 'active' | 'email'
  actual: string
  message: string
}

/**
 * 驗證一筆 users 文件是否符合現行結構。
 *
 * 與 firestore.rules 的 validUserDoc() 條件一致：
 * role 必須是現行三個值之一、active 必須是布林值、email 必須是字串。
 * 舊的 'editor' 會被標成需要遷移 —— 讀取時雖然還能對應到行銷專員，
 * 但已不允許再寫入，留著會在下次編輯該使用者時被規則擋下。
 */
export function validateUserDoc(d: {
  email?: unknown
  role?: unknown
  active?: unknown
}): UserDocIssue[] {
  const issues: UserDocIssue[] = []

  const describe = (v: unknown) =>
    v === undefined ? '（缺少欄位）' : `${JSON.stringify(v)}（${typeof v}）`

  if (typeof d.email !== 'string' || !d.email) {
    issues.push({
      field: 'email',
      actual: describe(d.email),
      message: 'email 必須是非空字串',
    })
  }

  if (typeof d.active !== 'boolean') {
    issues.push({
      field: 'active',
      actual: describe(d.active),
      message: 'active 必須是布林值 true / false，字串或缺漏都會被判定為未授權',
    })
  }

  if (typeof d.role !== 'string' || !(ROLES as readonly string[]).includes(d.role)) {
    const legacy = typeof d.role === 'string' && d.role in LEGACY_ROLES
    issues.push({
      field: 'role',
      actual: describe(d.role),
      message: legacy
        ? `'${d.role}' 是舊代號，目前仍可讀取（對應到${ROLE_LABELS[LEGACY_ROLES[d.role as string]]}），但無法再寫入，建議更新`
        : `role 必須是 ${ROLES.join(' / ')} 其中之一`,
    })
  }

  return issues
}
