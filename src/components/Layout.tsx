import { NavLink, Outlet } from 'react-router-dom'
import {
  BarChart3,
  FileText,
  HeartHandshake,
  LogOut,
  Send,
  Settings,
  Users,
} from 'lucide-react'
import { useAuth } from '../lib/AuthContext'
import { useBranding } from '../lib/useBranding'
import { ROLE_LABELS, normalizeRole, type Permission } from '../constants'

const NAV = [
  { to: '/press', label: '新聞稿', icon: FileText, need: 'viewPress' },
  { to: '/contacts', label: '媒體名單', icon: Users, need: 'manageContacts' },
  {
    to: '/events',
    label: '媒體關係',
    icon: HeartHandshake,
    need: 'manageEvents',
  },
  { to: '/send', label: '發送', icon: Send, need: 'sendTest' },
  {
    to: '/campaigns',
    label: '發送紀錄',
    icon: BarChart3,
    need: 'viewCampaigns',
  },
] as const satisfies readonly { need: Permission; [k: string]: unknown }[]

export default function Layout() {
  const { appUser, logout, isAdmin, can } = useAuth()
  const { logoUrl: uiLogoUrl } = useBranding()

  return (
    <div className="flex min-h-screen">
      <aside className="flex w-60 shrink-0 flex-col border-r border-slate-200 bg-white">
        <div className="border-b border-slate-200 px-5 py-5">
          {uiLogoUrl && (
            <img
              src={uiLogoUrl}
              alt="Transcend"
              className="mb-3 h-6 w-auto"
              onError={(e) => {
                e.currentTarget.style.display = 'none'
              }}
            />
          )}
          <div className="text-base font-semibold text-slate-900">
            新聞稿發送系統
          </div>
          <div className="mt-0.5 text-xs text-slate-400">Press Center</div>
        </div>

        <nav className="flex-1 space-y-1 p-3">
          {NAV.filter((item) => can(item.need)).map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                `flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition ${
                  isActive
                    ? 'bg-brand-50 text-brand-700'
                    : 'text-slate-600 hover:bg-slate-50'
                }`
              }
            >
              <Icon className="size-4.5" />
              {label}
            </NavLink>
          ))}
          {isAdmin && (
            <NavLink
              to="/settings"
              className={({ isActive }) =>
                `flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition ${
                  isActive
                    ? 'bg-brand-50 text-brand-700'
                    : 'text-slate-600 hover:bg-slate-50'
                }`
              }
            >
              <Settings className="size-4.5" />
              系統設定
            </NavLink>
          )}
        </nav>

        <div className="border-t border-slate-200 p-4">
          <div className="truncate text-sm font-medium text-slate-800">
            {appUser?.displayName || appUser?.email}
          </div>
          <div className="mt-0.5 text-xs text-slate-400">
            {appUser?.role ? (ROLE_LABELS[normalizeRole(appUser.role)!] ?? '') : ''}
          </div>
          <button
            onClick={logout}
            className="mt-3 flex items-center gap-2 text-xs text-slate-500 transition hover:text-slate-800"
          >
            <LogOut className="size-3.5" />
            登出
          </button>
        </div>
      </aside>

      <main className="flex-1 overflow-x-hidden">
        <Outlet />
      </main>
    </div>
  )
}
