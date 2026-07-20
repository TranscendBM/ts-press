import { useEffect, useState } from 'react'
import {
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  serverTimestamp,
  setDoc,
} from 'firebase/firestore'
import { Plus, Trash2 } from 'lucide-react'
import { db } from '../lib/firebase'
import { useAuth } from '../lib/AuthContext'
import PageHeader from '../components/PageHeader'
import { Badge, Button, Field, Modal, Select, TextInput } from '../components/ui'
import SmtpSettingsCard from '../components/SmtpSettingsCard'
import PressContactsCard from '../components/PressContactsCard'
import { ROLES, ROLE_LABELS, type Role } from '../constants'
import type { AppUser } from '../types'

export default function SettingsPage() {
  const { appUser, isAdmin } = useAuth()
  const [users, setUsers] = useState<AppUser[]>([])
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState({
    email: '',
    displayName: '',
    role: 'editor' as Role,
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    return onSnapshot(collection(db, 'users'), (snap) => {
      setUsers(snap.docs.map((d) => d.data() as AppUser))
    })
  }, [])

  if (!isAdmin) {
    return (
      <p className="p-16 text-center text-sm text-slate-400">
        只有管理員可以管理使用者。
      </p>
    )
  }

  async function save() {
    const email = draft.email.trim().toLowerCase()
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      setError('請輸入正確的 Email 格式。')
      return
    }
    setSaving(true)
    setError('')
    try {
      await setDoc(
        doc(db, 'users', email),
        {
          email,
          displayName: draft.displayName.trim() || email.split('@')[0],
          role: draft.role,
          active: true,
          createdAt: serverTimestamp(),
        },
        { merge: true },
      )
      setOpen(false)
      setDraft({ email: '', displayName: '', role: 'editor' })
    } finally {
      setSaving(false)
    }
  }

  // 把自己降級或停用會當場鎖死自己，且只能到 Firestore Console 手動救回來
  function isSelf(u: AppUser) {
    return u.email === appUser?.email
  }

  async function changeRole(u: AppUser, role: Role) {
    if (isSelf(u) && role !== 'admin') {
      alert('不能把自己降級，否則會失去管理權限而無法復原。請改由其他管理員操作。')
      return
    }
    await setDoc(doc(db, 'users', u.email), { role }, { merge: true })
  }

  async function toggleActive(u: AppUser) {
    if (isSelf(u) && u.active) {
      alert('不能停用自己的帳號，停用後會立刻登出且無法自行復原。')
      return
    }
    await setDoc(doc(db, 'users', u.email), { active: !u.active }, { merge: true })
  }

  async function remove(u: AppUser) {
    if (u.email === appUser?.email) {
      alert('不能刪除自己。')
      return
    }
    if (!confirm(`確定要移除 ${u.email} 的存取權限嗎？`)) return
    await deleteDoc(doc(db, 'users', u.email))
  }

  return (
    <>
      <PageHeader
        title="系統設定"
        description="寄信伺服器與使用者權限。只有管理員看得到這一頁。"
        actions={
          <Button variant="primary" onClick={() => setOpen(true)}>
            <Plus className="size-4" />
            新增使用者
          </Button>
        }
      />

      <div className="space-y-6 p-8">
        <PressContactsCard />
        <SmtpSettingsCard />

        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
          <div className="border-b border-slate-200 px-4 py-3">
            <h2 className="text-sm font-semibold text-slate-800">使用者</h2>
          </div>
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs text-slate-500">
              <tr>
                <th className="px-4 py-3 font-medium">名稱</th>
                <th className="px-4 py-3 font-medium">Email</th>
                <th className="px-4 py-3 font-medium">角色</th>
                <th className="px-4 py-3 font-medium">可發送</th>
                <th className="px-4 py-3 font-medium">狀態</th>
                <th className="px-4 py-3 text-right font-medium">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {users.map((u) => (
                <tr key={u.email} className={u.active ? '' : 'opacity-50'}>
                  <td className="px-4 py-3 font-medium text-slate-900">
                    {u.displayName}
                    {isSelf(u) && (
                      <span className="ml-2 text-xs font-normal text-slate-400">
                        （你自己）
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-slate-600">{u.email}</td>
                  <td className="px-4 py-3">
                    <Select
                      value={u.role}
                      onChange={(e) => changeRole(u, e.target.value as Role)}
                      disabled={isSelf(u)}
                      title={isSelf(u) ? '不能變更自己的角色' : undefined}
                      className="w-32 disabled:bg-slate-50 disabled:text-slate-400"
                    >
                      {ROLES.map((r) => (
                        <option key={r} value={r}>
                          {ROLE_LABELS[r]}
                        </option>
                      ))}
                    </Select>
                  </td>
                  <td className="px-4 py-3">
                    {u.role === 'editor' ? (
                      <span className="text-slate-400">否</span>
                    ) : (
                      <Badge tone="green">是</Badge>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <button
                      onClick={() => toggleActive(u)}
                      disabled={isSelf(u) && u.active}
                      title={
                        isSelf(u) && u.active ? '不能停用自己的帳號' : undefined
                      }
                      className="text-xs text-slate-500 underline-offset-2 hover:underline disabled:cursor-not-allowed disabled:no-underline disabled:opacity-50"
                    >
                      {u.active ? '啟用中' : '已停用'}
                    </button>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => remove(u)}
                      className="rounded-lg p-1.5 text-slate-300 transition hover:bg-red-50 hover:text-red-600"
                      title="移除"
                    >
                      <Trash2 className="size-4" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <Modal
        open={open}
        title="新增使用者"
        onClose={() => setOpen(false)}
        footer={
          <>
            <Button onClick={() => setOpen(false)}>取消</Button>
            <Button
              variant="primary"
              onClick={save}
              disabled={saving || !draft.email.trim()}
            >
              {saving ? '新增中…' : '新增'}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {error && (
            <div className="rounded-lg bg-red-50 p-3 text-sm text-red-700">
              {error}
            </div>
          )}
          <Field
            label="Google 帳號 Email"
            hint="要跟對方登入時使用的 Google 帳號完全一致。"
          >
            <TextInput
              value={draft.email}
              onChange={(e) => setDraft({ ...draft, email: e.target.value })}
              placeholder="someone@gmail.com"
            />
          </Field>
          <Field label="顯示名稱">
            <TextInput
              value={draft.displayName}
              onChange={(e) =>
                setDraft({ ...draft, displayName: e.target.value })
              }
            />
          </Field>
          <Field label="角色" hint="管理員與主管可以按下正式發送；編輯只能發測試信。">
            <Select
              value={draft.role}
              onChange={(e) =>
                setDraft({ ...draft, role: e.target.value as Role })
              }
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABELS[r]}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </Modal>
    </>
  )
}
