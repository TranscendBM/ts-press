import { useEffect, useState } from 'react'
import { doc, onSnapshot } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { CheckCircle2, KeyRound, Send, XCircle } from 'lucide-react'
import { db, functions } from '../lib/firebase'
import { Button, Field, TextInput } from './ui'
import { formatDate } from '../lib/helpers'

const updateSmtpSettings = httpsCallable<
  {
    host: string
    port: number
    user: string
    fromEmail: string
    replyTo: string
    password?: string
  },
  { ok: boolean }
>(functions, 'updateSmtpSettings')

const testSmtpConnection = httpsCallable<
  { sendTestEmail?: boolean },
  { ok: boolean; message: string }
>(functions, 'testSmtpConnection')

interface StoredSettings {
  host?: string
  port?: number
  user?: string
  fromEmail?: string
  replyTo?: string
  updatedAt?: import('firebase/firestore').Timestamp
  updatedBy?: string
  passwordUpdatedAt?: import('firebase/firestore').Timestamp
}

export default function SmtpSettingsCard() {
  const [stored, setStored] = useState<StoredSettings | null>(null)
  const [form, setForm] = useState({
    host: '',
    port: '587',
    user: '',
    fromEmail: '',
    replyTo: '',
  })
  const [password, setPassword] = useState('')
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(
    null,
  )

  useEffect(() => {
    return onSnapshot(doc(db, 'settings', 'smtp'), (snap) => {
      const d = (snap.data() as StoredSettings) ?? {}
      setStored(d)
      setForm({
        host: d.host ?? '',
        port: String(d.port ?? 587),
        user: d.user ?? '',
        fromEmail: d.fromEmail ?? '',
        replyTo: d.replyTo ?? '',
      })
    })
  }, [])

  async function save() {
    setSaving(true)
    setResult(null)
    try {
      await updateSmtpSettings({
        host: form.host,
        port: Number(form.port) || 587,
        user: form.user,
        fromEmail: form.fromEmail,
        replyTo: form.replyTo,
        // 留空代表不更動現有密碼
        ...(password ? { password } : {}),
      })
      setPassword('')
      setResult({ ok: true, text: '設定已儲存。' })
    } catch (err) {
      setResult({
        ok: false,
        text: (err as { message?: string }).message ?? '儲存失敗。',
      })
    } finally {
      setSaving(false)
    }
  }

  async function test(sendTestEmail: boolean) {
    setTesting(true)
    setResult(null)
    try {
      const res = await testSmtpConnection({ sendTestEmail })
      setResult({ ok: res.data.ok, text: res.data.message })
    } catch (err) {
      setResult({
        ok: false,
        text: (err as { message?: string }).message ?? '測試失敗。',
      })
    } finally {
      setTesting(false)
    }
  }

  const hasPassword = !!stored?.passwordUpdatedAt
  const dirty =
    !!password ||
    form.host !== (stored?.host ?? '') ||
    form.user !== (stored?.user ?? '') ||
    form.fromEmail !== (stored?.fromEmail ?? '') ||
    form.replyTo !== (stored?.replyTo ?? '') ||
    Number(form.port) !== (stored?.port ?? 587)

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-6">
      <div className="mb-1 flex items-center gap-2">
        <KeyRound className="size-4 text-slate-400" />
        <h2 className="text-sm font-semibold text-slate-800">寄信設定</h2>
      </div>
      <p className="mb-5 text-xs text-slate-400">
        新聞稿透過公司 mail2000 寄出。密碼只會加密存放在 Google Secret
        Manager，不會寫入資料庫，也不會再顯示出來。
      </p>

      <div className="grid max-w-2xl gap-4 sm:grid-cols-2">
        <Field label="SMTP 主機">
          <TextInput
            value={form.host}
            onChange={(e) => setForm({ ...form, host: e.target.value })}
            placeholder="email.transcend-info.com"
          />
        </Field>
        <Field label="連接埠" hint="587（STARTTLS）或 465（SSL）。不能用 25。">
          <TextInput
            value={form.port}
            onChange={(e) => setForm({ ...form, port: e.target.value })}
            placeholder="587"
          />
        </Field>
        <Field label="認證帳號" hint="登入 SMTP 用，必須是可登入的個人帳號。">
          <TextInput
            value={form.user}
            onChange={(e) => setForm({ ...form, user: e.target.value })}
            placeholder="elvis_cheng@transcend-info.com"
          />
        </Field>
        <Field
          label="寄件地址"
          hint="記者看到的寄件人。可填群組信箱，前提是認證帳號有代理寄件權限。"
        >
          <TextInput
            value={form.fromEmail}
            onChange={(e) => setForm({ ...form, fromEmail: e.target.value })}
            placeholder="press_center@transcend-info.com"
          />
        </Field>
        <Field label="回覆至" hint="記者按回信時會進的信箱，留空則同寄件地址。">
          <TextInput
            value={form.replyTo}
            onChange={(e) => setForm({ ...form, replyTo: e.target.value })}
            placeholder="press_center@transcend-info.com"
          />
        </Field>
        <div className="sm:col-span-2">
          <Field
            label="密碼"
            hint={
              hasPassword
                ? `已設定，最後更新於 ${formatDate(stored?.passwordUpdatedAt)}。留空表示不更動。`
                : '尚未設定密碼。'
            }
          >
            <TextInput
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={hasPassword ? '••••••••（不更動請留空）' : '輸入密碼'}
              autoComplete="new-password"
            />
          </Field>
        </div>
      </div>

      {result && (
        <div
          className={`mt-5 flex max-w-2xl gap-2 rounded-lg p-3 text-sm ${
            result.ok
              ? 'bg-emerald-50 text-emerald-800'
              : 'bg-red-50 text-red-700'
          }`}
        >
          {result.ok ? (
            <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
          ) : (
            <XCircle className="mt-0.5 size-4 shrink-0" />
          )}
          <span>{result.text}</span>
        </div>
      )}

      <div className="mt-5 flex flex-wrap gap-2">
        <Button variant="primary" onClick={save} disabled={saving || !dirty}>
          {saving ? '儲存中…' : '儲存設定'}
        </Button>
        <Button onClick={() => test(false)} disabled={testing || dirty}>
          {testing ? '測試中…' : '測試連線'}
        </Button>
        <Button onClick={() => test(true)} disabled={testing || dirty}>
          <Send className="size-4" />
          測試連線並寄信給我
        </Button>
      </div>
      {dirty && (
        <p className="mt-2 text-xs text-amber-700">
          有未儲存的變更，請先儲存再測試。
        </p>
      )}
      {stored?.updatedBy && (
        <p className="mt-3 text-xs text-slate-400">
          最後由 {stored.updatedBy} 於 {formatDate(stored.updatedAt)} 更新
        </p>
      )}
    </div>
  )
}
