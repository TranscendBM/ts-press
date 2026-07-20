import { useState } from 'react'
import { Mail, ShieldAlert } from 'lucide-react'
import { useAuth } from '../lib/AuthContext'

export default function LoginPage() {
  const { signIn, denial } = useAuth()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function handleSignIn() {
    setBusy(true)
    setError('')
    try {
      await signIn()
    } catch (err) {
      const code = (err as { code?: string }).code
      if (code !== 'auth/popup-closed-by-user') {
        setError('登入失敗，請再試一次。')
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-linear-to-br from-slate-100 to-brand-50 p-6">
      <div className="w-full max-w-md rounded-2xl bg-white p-10 shadow-xl shadow-slate-200/60">
        <div className="mb-8 flex flex-col items-center text-center">
          <div className="mb-4 flex size-14 items-center justify-center rounded-xl bg-brand-500 text-white">
            <Mail className="size-7" />
          </div>
          <h1 className="text-2xl font-semibold text-slate-900">
            新聞稿發送系統
          </h1>
          <p className="mt-2 text-sm text-slate-500">
            Transcend Press Center
          </p>
        </div>

        {denial === 'not-whitelisted' && (
          <Notice>
            這個帳號尚未被授權使用本系統，請聯絡管理員將你加入名單。
          </Notice>
        )}
        {error && <Notice>{error}</Notice>}

        <button
          onClick={handleSignIn}
          disabled={busy}
          className="flex w-full items-center justify-center gap-3 rounded-lg border border-slate-300 bg-white px-4 py-3 font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-60"
        >
          <GoogleMark />
          {busy ? '登入中…' : '使用 Google 帳號登入'}
        </button>

        <p className="mt-6 text-center text-xs text-slate-400">
          需由管理員將你的 Google 帳號加入名單才能使用。
        </p>
      </div>
    </div>
  )
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-5 flex gap-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
      <ShieldAlert className="mt-0.5 size-4 shrink-0" />
      <span>{children}</span>
    </div>
  )
}

function GoogleMark() {
  return (
    <svg className="size-5" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.5h6.4a5.5 5.5 0 0 1-2.4 3.6v3h3.9c2.3-2.1 3.6-5.2 3.6-8.8Z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.2 0 5.9-1.1 7.9-2.9l-3.9-3c-1.1.7-2.4 1.2-4 1.2-3.1 0-5.7-2.1-6.6-4.9H1.4v3.1A12 12 0 0 0 12 24Z"
      />
      <path
        fill="#FBBC05"
        d="M5.4 14.4a7.2 7.2 0 0 1 0-4.6V6.7H1.4a12 12 0 0 0 0 10.8l4-3.1Z"
      />
      <path
        fill="#EA4335"
        d="M12 4.8c1.8 0 3.3.6 4.6 1.8l3.4-3.4C17.9 1.2 15.2 0 12 0A12 12 0 0 0 1.4 6.7l4 3.1C6.3 6.9 8.9 4.8 12 4.8Z"
      />
    </svg>
  )
}
