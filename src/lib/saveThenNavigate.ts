/**
 * 「先儲存再前往下一頁」的流程。
 *
 * 抽成獨立函式是因為原本的寫法 `if (dirty) await save(); navigate(...)`
 * 會在儲存失敗時照樣跳頁，使用者就帶著沒存進資料庫的內容去發送。
 * 這裡強制以 save() 的回傳值決定是否導航。
 */
export async function saveThenNavigate(opts: {
  dirty: boolean
  save: () => Promise<boolean>
  navigate: () => void
}): Promise<boolean> {
  if (opts.dirty) {
    const saved = await opts.save()
    if (!saved) return false
  }
  opts.navigate()
  return true
}
