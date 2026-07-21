/**
 * 授權與附件的判斷邏輯。
 *
 * 刻意獨立成沒有任何 SDK 相依的純函式，理由有二：
 * 1. Cloud Functions 的 index.ts 在載入時就會 initializeApp()，測試無法直接匯入
 * 2. 同一份規則要同時給 Functions 與測試使用，避免兩邊各寫一套而分歧
 */

export type AppRole = 'admin' | 'manager' | 'editor'

export interface UserDoc {
  role?: string
  active?: unknown
}

export type AccessVerdict = { ok: true } | { ok: false; reason: string }

/**
 * 與 firestore.rules 的 isWhitelisted() 條件一致：
 * 信箱已驗證、users 文件存在、且 active === true。
 *
 * 用嚴格比對而非 `active !== false`，否則舊資料缺欄位就會被當成啟用。
 */
export function evaluateAccess(input: {
  email?: string
  emailVerified?: boolean
  userDoc?: UserDoc
  needsSendRole: boolean
}): AccessVerdict {
  if (!input.email) return { ok: false, reason: '請先登入。' }
  if (input.emailVerified !== true) {
    return { ok: false, reason: 'Google 帳號的信箱尚未通過驗證。' }
  }
  const doc = input.userDoc
  if (!doc || doc.active !== true) {
    return { ok: false, reason: '這個帳號未被授權使用本系統。' }
  }
  if (input.needsSendRole && doc.role !== 'admin' && doc.role !== 'manager') {
    return { ok: false, reason: '你的角色沒有正式發送權限。' }
  }
  return { ok: true }
}

/** 後端對附件的硬性上限，不採信前端或 Firestore 記錄的數值。 */
export const ATTACHMENT_LIMITS = {
  maxCount: 10,
  maxFileBytes: 10 * 1024 * 1024,
  maxTotalBytes: 15 * 1024 * 1024,
}

/**
 * 驗證附件路徑只落在該篇新聞稿的 attachments 目錄底下。
 *
 * Firestore 的 path 欄位是前端寫入的。若不檢查，被竄改的文件就能讓
 * Functions（Admin SDK 不受 Storage 規則限制）讀走 bucket 內任何檔案。
 */
export function isAllowedAttachmentPath(
  path: string | undefined,
  pressReleaseId: string,
): boolean {
  if (!path || typeof path !== 'string' || !pressReleaseId) return false
  if (pressReleaseId.includes('/') || pressReleaseId.includes('..')) return false
  // 路徑穿越、絕對路徑、跨 bucket 前綴、空位元組、反斜線一律拒絕
  if (path.includes('..') || path.startsWith('/') || path.includes('://')) {
    return false
  }
  if (path.includes('\0') || path.includes('\\')) return false
  const prefix = `press/${pressReleaseId}/attachments/`
  if (!path.startsWith(prefix)) return false
  // 前綴之後必須有檔名，且不得再有目錄階層
  const rest = path.slice(prefix.length)
  return rest.length > 0 && !rest.includes('/')
}

/**
 * Firestore 的 batch 一次最多 500 筆。留餘裕避免其他寫入把額度用滿。
 */
export const BATCH_SIZE = 450

export function chunk<T>(items: T[], size = BATCH_SIZE): T[][] {
  if (!Number.isInteger(size) || size <= 0) {
    throw new Error('chunk size must be a positive integer')
  }
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size))
  }
  return out
}
