import { useState } from 'react'
import { httpsCallable } from 'firebase/functions'
import { Mail } from 'lucide-react'
import { functions } from '../lib/firebase'
import { useAuth } from '../lib/AuthContext'
import { maskEmailForDisplay } from '../../shared/selfTestEmail'
import { MAINTENANCE_PAUSED_MESSAGE } from '../../shared/maintenance'

const sendSelfTestEmail = httpsCallable<unknown, { ok: boolean }>(
  functions,
  'sendSelfTestEmail',
)

const GENERIC_SEND_FAILURE_TEXT = '測試信寄送失敗，請稍後再試或聯絡管理員'

/**
 * 提交前審查新增：把後端拋回來的錯誤轉成固定文案，**絕不**直接顯示
 * `err.message`——即使目前後端（見 functions/src/index.ts 的
 * sendSelfTestEmailHandler／shared/selfTestEmail.ts 的
 * describeSelfTestEmailSendError()）已經確保 message 本身不含任何內部
 * 細節，前端仍然刻意不信任它、不顯示它，作為第二道防線：日後如果後端的
 * 錯誤訊息不小心改回會外洩內部細節的版本，這裡也不會把它顯示出來。
 *
 * 只依照 Firebase Functions 的錯誤 code（client SDK 格式是
 * `functions/<code>`，見 @firebase/functions 的 FunctionsErrorCode）分類，
 * 每一種分類都對應一句固定的中文文案：
 * - unauthenticated／permission-denied：登入狀態或帳號授權有問題。
 * - failed-precondition 且 message 精確等於 MAINTENANCE_PAUSED_MESSAGE：
 *   維護中——用「訊息完全相等」判斷是不是維護中，因為維護旗標的訊息本身
 *   是共用常數、公開且不敏感，這裡只是拿來當分類依據，不是顯示它。
 * - resource-exhausted：冷卻中——秒數從 `err.details.retryAfterSeconds`
 *  （結構化資料，不是從 message 文字解析）取得，套進固定樣板；沒有這個
 *   結構化欄位時退回不含秒數的固定文案。
 * - 其他任何情況（含 failed-precondition 但不是維護訊息的 SMTP 寄送失敗、
 *   internal、或完全沒預期到的 code）：一律用同一句通用文案。
 */
function describeSelfTestEmailError(err: unknown): string {
  const code = (err as { code?: string })?.code
  const message = (err as { message?: string })?.message

  if (code === 'functions/unauthenticated' || code === 'functions/permission-denied') {
    return '目前的登入狀態無法使用這個功能，請重新整理頁面或重新登入後再試一次。'
  }
  if (code === 'functions/failed-precondition' && message === MAINTENANCE_PAUSED_MESSAGE) {
    return '系統目前正在維護中，暫時無法寄送測試信，請稍後再試。'
  }
  if (code === 'functions/resource-exhausted') {
    const details = (err as { details?: unknown })?.details
    const retryAfterSeconds =
      details && typeof details === 'object' && 'retryAfterSeconds' in details
        ? (details as { retryAfterSeconds?: unknown }).retryAfterSeconds
        : undefined
    return typeof retryAfterSeconds === 'number'
      ? `請稍候 ${retryAfterSeconds} 秒再試一次，避免重複寄送。`
      : '請稍候片刻再試一次，避免重複寄送。'
  }
  return GENERIC_SEND_FAILURE_TEXT
}

/**
 * 讓任何一個已登入、帳號啟用中的團隊成員按一下就能寄一封測試信給自己，
 * 確認這個信箱能收到本系統寄出的郵件——對應後端的 sendSelfTestEmail
 * callable（見 functions/src/index.ts 的 sendSelfTestEmailHandler）。
 *
 * 刻意不呼叫時帶任何 payload（後端的型別是 `CallableRequest<unknown>`，
 * 收件人只可能是後端自己從 auth token 解出來的信箱），也完全不讀取
 * settings/smtp（不需要、也不應該在這裡顯示主機／帳號／密碼這些資訊）。
 *
 * 前端的 disable-while-loading 只是 UX 層的防呆，避免手指按太快連點兩次；
 * 真正的節流在後端（見 shared/selfTestEmail.ts 的
 * decideSelfTestEmailCooldown()），這裡不重新實作一份冷卻邏輯。
 */
export default function SelfTestEmailButton() {
  const { appUser } = useAuth()
  const [sending, setSending] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(
    null,
  )

  if (!appUser?.email) return null

  async function send() {
    setSending(true)
    setResult(null)
    try {
      await sendSelfTestEmail()
      setResult({ ok: true, text: '已寄出，請確認收件匣。' })
    } catch (err) {
      setResult({ ok: false, text: describeSelfTestEmailError(err) })
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="mt-3 border-t border-slate-100 pt-3">
      <button
        onClick={send}
        disabled={sending}
        className="flex w-full items-center gap-2 rounded-lg px-1 py-1.5 text-xs text-slate-500 transition hover:text-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
        title={`寄一封測試信到 ${maskEmailForDisplay(appUser.email)}，確認這個帳號能收到系統寄出的信`}
      >
        <Mail className="size-3.5 shrink-0" />
        <span className="truncate">
          {sending ? '寄送中…' : `寄測試信給自己（${maskEmailForDisplay(appUser.email)}）`}
        </span>
      </button>
      {result && (
        <p
          className={`mt-1 px-1 text-xs ${result.ok ? 'text-emerald-600' : 'text-red-600'}`}
        >
          {result.text}
        </p>
      )}
    </div>
  )
}
