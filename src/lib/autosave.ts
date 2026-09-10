/**
 * 稿件自動儲存的版本控制器。
 *
 * 抽離成不依賴 React／Firestore 的純邏輯，原因：
 * 1. 可以直接用假的 write() 函式模擬「儲存中又有新編輯」「舊 request 晚於新
 *    request 完成」這類競態情境，不必真的連 Firestore 或掛載元件。
 * 2. save 完成後不能無條件把 dirty 清掉 —— 如果送出期間使用者又編輯了，
 *    這次寫入的已經是舊內容，必須維持 dirty 並再送一次，否則使用者會看到
 *    「已儲存」但實際上最新的內容從未寫入資料庫。
 *
 * 做法：每次編輯都算一次 revision；save() 一次只允許一個真正的網路 request
 * 在飛行 —— 呼叫時若已有一次在跑，就一起等同一條 chain 的最終結果，不會並行
 * 送出第二個 request。因為永遠只有一個 request 在飛行，也就不可能發生「先送
 * 出的舊 request 比後送出的新 request 晚完成」這種競態，送出永遠照時間順序
 * 一個接一個，順序自然正確。
 *
 * 送出時若又發生新編輯，就在同一個迴圈裡立刻用最新內容再送一次，直到某次送
 * 出期間都沒有新編輯發生為止，代表資料庫內容已經追上最新版本。
 */

export interface AutosaveCallbacks<T> {
  /** 實際寫入的動作（例如 Firestore updateDoc）。丟出例外代表這次寫入失敗。 */
  write: (snapshot: T) => Promise<void>
  onSavingChange?: (saving: boolean) => void
  onDirtyChange?: (dirty: boolean) => void
  onSaved?: (at: Date) => void
  onError?: (err: unknown) => void
}

export interface AutosaveController<T> {
  /** 記錄一次編輯，之後的 save() 會以這份內容為準。 */
  markEdited(next: T): void
  /**
   * 儲存目前最新內容。同一時間只會有一個真正的網路 request；
   * 呼叫時若已有一次在進行中，會一起等待同一條 chain 的最終結果。
   * 回傳 true 代表「呼叫當下的最新內容」已經確實寫入資料庫。
   */
  save(): Promise<boolean>
}

export function createAutosaveController<T>(
  initial: T,
  callbacks: AutosaveCallbacks<T>,
): AutosaveController<T> {
  let snapshot = initial
  let revision = 0
  let chain: Promise<boolean> | null = null

  function markEdited(next: T) {
    snapshot = next
    revision += 1
    callbacks.onDirtyChange?.(true)
  }

  async function runLoop(): Promise<boolean> {
    for (;;) {
      const revisionAtStart = revision
      const toWrite = snapshot
      callbacks.onSavingChange?.(true)
      try {
        await callbacks.write(toWrite)
      } catch (err) {
        callbacks.onError?.(err)
        callbacks.onSavingChange?.(false)
        return false
      }
      if (revision === revisionAtStart) {
        // 送出期間沒有新編輯，這次寫入的就是最新內容
        callbacks.onDirtyChange?.(false)
        callbacks.onSaved?.(new Date())
        callbacks.onSavingChange?.(false)
        return true
      }
      // 送出期間又有新編輯：剛寫入的內容已經過期，立刻用最新版再送一次
    }
  }

  function save(): Promise<boolean> {
    if (chain) return chain
    const p = runLoop().finally(() => {
      chain = null
    })
    chain = p
    return p
  }

  return { markEdited, save }
}
