/**
 * 刪除新聞稿時，Firestore 文件與 Storage 檔案的一致性處理，
 * 以及 storageCleanupQueue 的處理邏輯。
 *
 * 抽成不依賴 Admin SDK 的純函式，理由與 shared/policy.ts 相同：Functions 的
 * index.ts 一載入就會 initializeApp()，測試沒辦法直接匯入，所以把「決定要
 * 刪什麼、用什麼順序刪、失敗了怎麼辦、佇列項目該不該被認領」這些邏輯抽
 * 出來，用注入的 callback 或假資料模擬 Firestore／Storage 的各種失敗情境，
 * 不必真的連線。
 *
 * 核心原則：**永遠先確認 Firestore 已經不再引用某個檔案，才去刪那個檔案**。
 * 反過來做（先刪 Storage 再刪 Firestore 文件）如果中途失敗，文件會留著、
 * 但引用的檔案已經被刪除 —— 記者收到的附件連結、後台的下載連結都會壞掉。
 * 顛倒過來的最壞情況只是留下沒人引用的孤兒檔案，白佔空間但不影響功能，
 * 而且可以之後再補刪（見下方 storageCleanupQueue 相關函式）。
 */

export interface PressFileRef {
  path?: string
}

export interface PressReleaseFileShape {
  attachments?: PressFileRef[]
  versions?: Record<string, { heroImage?: PressFileRef } | undefined>
}

/** 從新聞稿文件內容收集所有應該一併清除的 Storage 路徑，過濾掉沒有 path 的項目。 */
export function collectPressFilePaths(press: PressReleaseFileShape): string[] {
  const paths: string[] = []
  for (const a of press.attachments ?? []) {
    if (a.path) paths.push(a.path)
  }
  for (const v of Object.values(press.versions ?? {})) {
    if (v?.heroImage?.path) paths.push(v.heroImage.path)
  }
  return paths
}

export interface PressCleanupCallbacks {
  /** 刪除 Firestore 文件本身。 */
  deleteDoc: () => Promise<void>
  /** 刪除單一 Storage 檔案。實作應把「檔案本來就不存在」視為成功。 */
  deleteFile: (path: string) => Promise<void>
  /** deleteFile 失敗時，把這個路徑記錄下來供之後重試。可能自己也會失敗。 */
  queueRetry: (path: string, errorMessage: string) => Promise<void>
}

export interface PressCleanupResult {
  /** Firestore 文件是否已經刪除成功。deleteDoc() 失敗時這個函式會直接拋錯，不會回傳。 */
  documentDeleted: true
  /** 成功刪除的 Storage 檔案路徑。 */
  filesRemoved: string[]
  /** 刪除失敗、但已經成功記進重試佇列的路徑。 */
  cleanupQueued: string[]
  /**
   * 刪除失敗、而且連記進重試佇列都失敗的路徑 —— 這些會變成沒有任何追蹤
   * 紀錄的孤兒檔案，必須讓呼叫端知道並記錄下來（例如寫 log 供人工排查），
   * 不能被當成「一切正常」默默吞掉。
   */
  cleanupQueueWriteFailed: string[]
}

/**
 * 依「Firestore 文件優先」的順序執行刪除。
 *
 * 若 deleteDoc() 失敗（拋出例外），整個流程中止並往外拋 —— 不會嘗試刪除
 * 任何 Storage 檔案，因為文件都還在引用它們，這時舊檔案仍然完好可用。
 *
 * deleteDoc() 成功後才逐一刪除 Storage 檔案；某個檔案刪除失敗不會中止
 * 其他檔案的處理，而是呼叫 queueRetry() 記錄下來。
 *
 * ⚠️ queueRetry() 本身也可能失敗（例如 Firestore 忽然打不通）。這裡刻意
 * 把它包在自己的 try/catch 裡、不讓它的例外往外傳 —— 否則呼叫端會誤以為
 * 整個 deletePressReleaseWithCleanup() 失敗，進而回報「刪除新聞稿失敗」，
 * 但實際上 Firestore 文件早就刪除成功了，只是「記錄清理失敗」這個動作
 * 本身沒做成。回傳的 cleanupQueueWriteFailed 讓呼叫端可以誠實回報：
 * 文件真的刪了、部分檔案真的孤兒了、而且這些孤兒連追蹤紀錄都沒有。
 */
export async function deletePressReleaseWithCleanup(
  paths: string[],
  cb: PressCleanupCallbacks,
): Promise<PressCleanupResult> {
  await cb.deleteDoc()

  const filesRemoved: string[] = []
  const cleanupQueued: string[] = []
  const cleanupQueueWriteFailed: string[] = []
  for (const path of paths) {
    try {
      await cb.deleteFile(path)
      filesRemoved.push(path)
    } catch (err) {
      const message = (err as { message?: string })?.message ?? '未知錯誤'
      try {
        await cb.queueRetry(path, message)
        cleanupQueued.push(path)
      } catch {
        cleanupQueueWriteFailed.push(path)
      }
    }
  }
  return { documentDeleted: true, filesRemoved, cleanupQueued, cleanupQueueWriteFailed }
}

// ---------------------------------------------------------------------------
// storageCleanupQueue 處理器：認領與重試上限的純決策邏輯
// ---------------------------------------------------------------------------

/** 單一清理項目最多重試幾次（含第一次），超過就標成 failed、不再重試。 */
export const MAX_CLEANUP_ATTEMPTS = 5

/**
 * 處理中租期。Storage 刪除一個檔案通常在幾百毫秒內完成，抓 2 分鐘是為了
 * 在「processor 本身逾時或崩潰」時，讓下一輪處理能在合理時間內安全接手，
 * 不必無限期等待一個可能已經死掉的租約。
 */
export const CLEANUP_LEASE_MS = 120_000

export type CleanupQueueStatus = 'pending' | 'processing' | 'done' | 'failed'

export interface CleanupQueueItemState {
  status: CleanupQueueStatus
  leaseExpiresAtMs?: number | null
}

/**
 * 判斷某個清理項目這次是否可以被（重新）認領。
 * - done／failed：終止狀態，不再處理
 * - pending：可以認領
 * - processing：只有租期已過期（代表上一個 processor 可能已經死掉）才能認領，
 *   避免兩個 processor 同時處理同一個項目。
 */
export function isCleanupItemClaimable(
  item: CleanupQueueItemState,
  nowMs: number,
): boolean {
  if (item.status === 'done' || item.status === 'failed') return false
  if (item.status === 'processing') {
    return !(typeof item.leaseExpiresAtMs === 'number' && item.leaseExpiresAtMs > nowMs)
  }
  return true
}

/** 這次清理失敗後，attempts 是否已經到上限，該轉成永久失敗（failed）。 */
export function hasExceededCleanupAttempts(
  attempts: number,
  max: number = MAX_CLEANUP_ATTEMPTS,
): boolean {
  return attempts >= max
}
