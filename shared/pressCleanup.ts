/**
 * 刪除新聞稿時，Firestore 文件與 Storage 檔案的一致性處理。
 *
 * 抽成不依賴 Admin SDK 的純函式，理由與 shared/policy.ts 相同：Functions 的
 * index.ts 一載入就會 initializeApp()，測試沒辦法直接匯入，所以把「決定要
 * 刪什麼、用什麼順序刪、失敗了怎麼辦」這些邏輯抽出來，用注入的 callback
 * 模擬 Firestore／Storage 的各種失敗情境，不必真的連線。
 *
 * 核心原則：**永遠先確認 Firestore 已經不再引用某個檔案，才去刪那個檔案**。
 * 反過來做（先刪 Storage 再刪 Firestore 文件）如果中途失敗，文件會留著、
 * 但引用的檔案已經被刪除 —— 記者收到的附件連結、後台的下載連結都會壞掉。
 * 顛倒過來的最壞情況只是留下沒人引用的孤兒檔案，白佔空間但不影響功能，
 * 而且可以之後再補刪。
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
  /** 刪除單一 Storage 檔案。 */
  deleteFile: (path: string) => Promise<void>
  /** deleteFile 失敗時，把這個路徑記錄下來供之後重試，而不是默默放棄。 */
  queueRetry: (path: string, errorMessage: string) => Promise<void>
}

export interface PressCleanupResult {
  removed: string[]
  queued: string[]
}

/**
 * 依「Firestore 文件優先」的順序執行刪除。
 *
 * 若 deleteDoc() 失敗（拋出例外），整個流程中止並往外拋 ——
 * 不會嘗試刪除任何 Storage 檔案，因為文件都還在引用它們。
 *
 * deleteDoc() 成功後才逐一刪除 Storage 檔案；某個檔案刪除失敗不會中止
 * 其他檔案的處理，而是呼叫 queueRetry() 記錄下來，讓失敗的清理工作
 * 之後可以重試，不會無聲無息地變成永遠找不到的孤兒檔案。
 */
export async function deletePressReleaseWithCleanup(
  paths: string[],
  cb: PressCleanupCallbacks,
): Promise<PressCleanupResult> {
  await cb.deleteDoc()

  const removed: string[] = []
  const queued: string[] = []
  for (const path of paths) {
    try {
      await cb.deleteFile(path)
      removed.push(path)
    } catch (err) {
      const message = (err as { message?: string })?.message ?? '未知錯誤'
      await cb.queueRetry(path, message)
      queued.push(path)
    }
  }
  return { removed, queued }
}
