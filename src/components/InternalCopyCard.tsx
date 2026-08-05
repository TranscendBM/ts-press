import { useEffect, useState } from 'react'
import { doc, onSnapshot, serverTimestamp, setDoc } from 'firebase/firestore'
import { Users } from 'lucide-react'
import { db } from '../lib/firebase'
import { Button, Field, TextArea } from './ui'
import {
  COPYABLE_LISTS,
  LANGUAGE_LABELS,
  LIST_DEFAULT_LANGUAGE,
  LIST_LABELS,
  type ListId,
} from '../constants'
import { parseEmailList } from '../../shared/policy'
import type { EmailSettings } from '../types'

type Copies = Partial<Record<ListId, string>>

function pick(saved: EmailSettings | null): Copies {
  const out: Copies = {}
  for (const l of COPYABLE_LISTS) out[l] = saved?.internalCopies?.[l] ?? ''
  return out
}

export default function InternalCopyCard() {
  const [saved, setSaved] = useState<EmailSettings | null>(null)
  const [copies, setCopies] = useState<Copies>(pick(null))
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')

  useEffect(() => {
    return onSnapshot(doc(db, 'settings', 'email'), (snap) => {
      const d = (snap.data() as EmailSettings) ?? {}
      setSaved(d)
      setCopies(pick(d))
    })
  }, [])

  async function save() {
    setSaving(true)
    setMessage('')
    try {
      // 存回時正規化：只留合法信箱、去重，順便清掉打錯的內容
      const normalized: Copies = {}
      for (const l of COPYABLE_LISTS) {
        normalized[l] = parseEmailList(copies[l]).join(', ')
      }
      await setDoc(
        doc(db, 'settings', 'email'),
        { internalCopies: normalized, updatedAt: serverTimestamp() },
        { merge: true },
      )
      setMessage('已儲存。')
    } catch {
      setMessage('儲存失敗，請稍後再試。')
    } finally {
      setSaving(false)
    }
  }

  const dirty = COPYABLE_LISTS.some(
    (l) => (copies[l] ?? '') !== (saved?.internalCopies?.[l] ?? ''),
  )

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-6">
      <div className="mb-1 flex items-center gap-2">
        <Users className="size-4 text-slate-400" />
        <h2 className="text-sm font-semibold text-slate-800">內部副本收件人</h2>
      </div>
      <p className="mb-5 text-xs text-slate-400">
        正式發送某個名單時，除了媒體記者，會再寄一份給這裡設定的公司同事（每人一份，
        與媒體重複或跨名單重複都會自動去除）。多個信箱請用逗號或換行分隔。留空表示不副本。
      </p>

      <div className="grid max-w-2xl gap-4">
        {COPYABLE_LISTS.map((l) => (
          <Field
            key={l}
            label={LIST_LABELS[l]}
            hint={`收到的是 ${LANGUAGE_LABELS[LIST_DEFAULT_LANGUAGE[l]]} 版本。`}
          >
            <TextArea
              rows={2}
              value={copies[l] ?? ''}
              onChange={(e) => setCopies({ ...copies, [l]: e.target.value })}
              placeholder="colleague@transcend-info.com"
            />
          </Field>
        ))}
      </div>

      {message && (
        <div className="mt-5 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800">
          {message}
        </div>
      )}

      <div className="mt-5">
        <Button variant="primary" onClick={save} disabled={saving || !dirty}>
          {saving ? '儲存中…' : '儲存'}
        </Button>
      </div>
    </div>
  )
}
