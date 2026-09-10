import { useState } from 'react'
import { httpsCallable } from 'firebase/functions'
import { Trash2 } from 'lucide-react'
import { functions } from '../lib/firebase'
import { Button } from './ui'

/**
 * 刪除新聞稿時，若 Storage 檔案清理失敗，會先記進 storageCleanupQueue
 * 稍後重試（見 deletePressRelease 的說明）。這裡是那個佇列唯一的消化端：
 * 管理員可以手動觸發批次處理，不必寫腳本或進 Console 手動查。
 */
const processStorageCleanupQueueFn = httpsCallable<
  { limit?: number },
  {
    processed: number
    succeeded: number
    failed: number
    exhausted: number
    remainingCandidates: number
  }
>(functions, 'processStorageCleanupQueue')

export default function StorageCleanupCard() {
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)

  async function run() {
    setRunning(true)
    setResult(null)
    try {
      const res = await processStorageCleanupQueueFn({ limit: 50 })
      const d = res.data
      setResult({
        ok: true,
        text: `處理了 ${d.processed} 筆：成功 ${d.succeeded}、待重試 ${d.failed}、永久失敗 ${d.exhausted}。${
          d.remainingCandidates > 0
            ? `還有約 ${d.remainingCandidates} 筆候選，可以再按一次繼續處理。`
            : '目前沒有更多待處理項目。'
        }`,
      })
    } catch (err) {
      setResult({
        ok: false,
        text: (err as { message?: string }).message ?? '處理失敗，請稍後再試。',
      })
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-6">
      <div className="mb-1 flex items-center gap-2">
        <Trash2 className="size-4 text-slate-400" />
        <h2 className="text-sm font-semibold text-slate-800">孤兒檔案清理</h2>
      </div>
      <p className="mb-5 text-xs text-slate-400">
        刪除新聞稿時，如果 Storage 檔案沒有立即刪除成功，會排進清理佇列稍後重試。
        按下方按鈕手動觸發一批處理；失敗的項目會自動重試，重試次數用完會標成永久失敗。
      </p>
      {result && (
        <div
          className={`mb-4 rounded-lg p-3 text-sm ${
            result.ok ? 'bg-emerald-50 text-emerald-800' : 'bg-red-50 text-red-700'
          }`}
        >
          {result.text}
        </div>
      )}
      <Button onClick={run} disabled={running}>
        <Trash2 className="size-4" />
        {running ? '處理中…' : '處理待清理項目'}
      </Button>
    </div>
  )
}
