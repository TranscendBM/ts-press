import { useEffect, useState } from 'react'
import { doc, onSnapshot, serverTimestamp, setDoc } from 'firebase/firestore'
import { RotateCcw, ShieldCheck } from 'lucide-react'
import { db } from '../lib/firebase'
import { Button } from './ui'
import {
  ADMIN_ONLY_PERMISSIONS,
  DEFAULT_PERMISSIONS,
  PERMISSIONS,
  PERMISSION_LABELS,
  ROLES,
  ROLE_DESCRIPTIONS,
  ROLE_LABELS,
  resolvePermissions,
  type Permission,
  type PermissionMatrix,
  type Role,
} from '../../shared/permissions'

/**
 * 角色權限矩陣。管理員可以逐項調整，存進 settings/permissions。
 *
 * 「管理使用者」「系統與寄信設定」兩項固定只有管理員擁有、不開放調整 ——
 * 否則可能把提權的能力交給其他角色。
 */
export default function RolePermissionsCard() {
  const [matrix, setMatrix] = useState<PermissionMatrix>(
    resolvePermissions(undefined),
  )
  const [saved, setSaved] = useState<PermissionMatrix>(
    resolvePermissions(undefined),
  )
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')

  useEffect(() => {
    return onSnapshot(doc(db, 'settings', 'permissions'), (snap) => {
      const next = resolvePermissions(snap.data()?.roles)
      setMatrix(next)
      setSaved(next)
    })
  }, [])

  function toggle(role: Role, permission: Permission) {
    if (ADMIN_ONLY_PERMISSIONS.includes(permission)) return
    setMatrix((prev) => ({
      ...prev,
      [role]: { ...prev[role], [permission]: !prev[role][permission] },
    }))
  }

  async function save() {
    setSaving(true)
    setMessage('')
    try {
      await setDoc(
        doc(db, 'settings', 'permissions'),
        { roles: matrix, updatedAt: serverTimestamp() },
        { merge: true },
      )
      setMessage('已儲存。使用者重新整理後生效。')
    } catch {
      setMessage('儲存失敗，請稍後再試。')
    } finally {
      setSaving(false)
    }
  }

  const dirty = JSON.stringify(matrix) !== JSON.stringify(saved)

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-6">
      <div className="mb-1 flex items-center gap-2">
        <ShieldCheck className="size-4 text-slate-400" />
        <h2 className="text-sm font-semibold text-slate-800">角色權限</h2>
      </div>
      <p className="mb-5 text-xs text-slate-400">
        調整每個角色能做什麼。灰色的項目固定只有管理員擁有，不開放調整。
      </p>

      <div className="overflow-x-auto">
        <table className="w-full min-w-2xl text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-xs text-slate-500">
              <th className="px-3 py-3 text-left font-medium">權限</th>
              {ROLES.map((r) => (
                <th key={r} className="px-3 py-3 text-center font-medium">
                  <div className="text-slate-800">{ROLE_LABELS[r]}</div>
                  <div className="mt-0.5 text-[11px] font-normal text-slate-400">
                    {ROLE_DESCRIPTIONS[r]}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {PERMISSIONS.map((p) => {
              const locked = ADMIN_ONLY_PERMISSIONS.includes(p)
              return (
                <tr key={p} className={locked ? 'bg-slate-50/60' : ''}>
                  <td className="px-3 py-2.5 text-slate-700">
                    {PERMISSION_LABELS[p]}
                    {locked && (
                      <span className="ml-2 text-xs text-slate-400">
                        （僅管理員）
                      </span>
                    )}
                  </td>
                  {ROLES.map((r) => (
                    <td key={r} className="px-3 py-2.5 text-center">
                      <input
                        type="checkbox"
                        checked={matrix[r][p]}
                        disabled={locked}
                        onChange={() => toggle(r, p)}
                        className="size-4 rounded border-slate-300 disabled:opacity-40"
                      />
                    </td>
                  ))}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {message && (
        <div className="mt-5 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800">
          {message}
        </div>
      )}

      <div className="mt-5 flex gap-2">
        <Button variant="primary" onClick={save} disabled={saving || !dirty}>
          {saving ? '儲存中…' : '儲存權限'}
        </Button>
        <Button
          onClick={() => setMatrix(resolvePermissions(undefined))}
          disabled={
            JSON.stringify(matrix) === JSON.stringify(DEFAULT_PERMISSIONS)
          }
        >
          <RotateCcw className="size-4" />
          還原預設
        </Button>
      </div>

      <p className="mt-3 text-xs text-slate-400">
        權限的實際攔截在後端進行，即使有人繞過畫面也擋得住。
      </p>
    </div>
  )
}
