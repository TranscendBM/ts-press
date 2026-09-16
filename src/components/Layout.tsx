import { useEffect, useState } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import {
  BarChart3,
  CalendarClock,
  FileText,
  HeartHandshake,
  LogOut,
  Menu,
  Send,
  Settings,
  Users,
  X,
} from 'lucide-react'
import { useAuth } from '../lib/AuthContext'
import { useBranding } from '../lib/useBranding'
import { ROLE_LABELS, normalizeRole } from '../constants'
import { ROUTE_PERMISSIONS } from '../lib/routePermissions'
import SelfTestEmailButton from './SelfTestEmailButton'

// 顯示用的標籤與圖示，權限與路徑則統一來自 ROUTE_PERMISSIONS ——
// 與路由守門共用同一份權限對照，避免「選單藏起來、網址卻進得去」的落差。
const NAV_META: Record<string, { label: string; icon: typeof FileText }> = {
  '/press': { label: '新聞稿', icon: FileText },
  '/schedule': { label: '發送排程', icon: CalendarClock },
  '/contacts': { label: '媒體名單', icon: Users },
  '/events': { label: '媒體關係', icon: HeartHandshake },
  '/send': { label: '發送', icon: Send },
  '/campaigns': { label: '發送紀錄', icon: BarChart3 },
}

const NAV = ROUTE_PERMISSIONS.filter((r) => NAV_META[r.to]).map((r) => ({
  ...r,
  ...NAV_META[r.to],
}))

export default function Layout() {
  const { appUser, logout, isAdmin, can } = useAuth()
  const { logoUrl: uiLogoUrl } = useBranding()
  // round 31 新增：手機／平板直向（<lg）把側邊導覽收成可開關的 drawer；
  // lg 以上維持原本「側邊欄恆常可見」的桌面行為，不需要開關狀態。
  const [navOpen, setNavOpen] = useState(false)
  const location = useLocation()

  // 切換路由後自動收起 drawer——否則手機上點完選單項目、換了頁面，選單
  // 還開著蓋住新頁面的內容，使用者得自己再點一次才能看到東西。
  useEffect(() => {
    setNavOpen(false)
  }, [location.pathname])

  // 提交前審查追加：只在 drawer 開啟時才註冊 Escape 監聽，關閉後立刻
  // 移除——避免每個 Layout render 都疊加一份 listener。依賴陣列只放
  // navOpen，effect 本身不需要在每次 render 都重新註冊。
  useEffect(() => {
    if (!navOpen) return
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setNavOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [navOpen])

  const navLinkClass = ({ isActive }: { isActive: boolean }) =>
    `flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition ${
      isActive
        ? 'bg-brand-50 text-brand-700'
        : 'text-slate-600 hover:bg-slate-50'
    }`

  return (
    <div className="flex min-h-screen">
      {/* 手機／平板 drawer 開啟時的背後遮罩，點擊可關閉；lg 以上恆不出現 */}
      {navOpen && (
        <div
          className="fixed inset-0 z-30 bg-slate-900/40 lg:hidden"
          onClick={() => setNavOpen(false)}
          aria-hidden="true"
        />
      )}

      <aside
        id="mobile-navigation"
        className={`fixed inset-y-0 left-0 z-40 flex w-72 max-w-[80vw] shrink-0 flex-col border-r border-slate-200 bg-white transition-transform duration-200 lg:static lg:z-auto lg:w-60 lg:max-w-none lg:translate-x-0 ${
          navOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex items-start justify-between gap-2 border-b border-slate-200 px-5 py-5">
          <div className="min-w-0">
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
          {/* 關閉鈕只在 drawer 模式（<lg）需要，桌面版側邊欄本來就恆常顯示 */}
          <button
            type="button"
            onClick={() => setNavOpen(false)}
            aria-label="關閉導覽選單"
            className="-mr-1 flex size-11 shrink-0 items-center justify-center rounded-lg text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 lg:hidden"
          >
            <X className="size-5" />
          </button>
        </div>

        <nav className="flex-1 space-y-1 overflow-y-auto p-3">
          {NAV.filter((item) => can(item.need)).map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={navLinkClass}
              onClick={() => setNavOpen(false)}
            >
              <Icon className="size-4.5 shrink-0" />
              {label}
            </NavLink>
          ))}
          {isAdmin && (
            <NavLink
              to="/settings"
              className={navLinkClass}
              onClick={() => setNavOpen(false)}
            >
              <Settings className="size-4.5 shrink-0" />
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
            className="mt-3 flex min-h-11 items-center gap-2 text-xs text-slate-500 transition hover:text-slate-800"
          >
            <LogOut className="size-3.5" />
            登出
          </button>

          {/* 任何 active 使用者都能看到、不受 RequirePermission 限制——刻意
              放在 Layout 這裡（每個已登入路由都會經過），不是某個特定頁面
              底下，理由見 functions/src/index.ts sendSelfTestEmailHandler
              上方的說明：這個功能本來就設計成給「任何」帳號使用，不能因為
              權限矩陣改動而讓某些角色找不到入口。 */}
          <SelfTestEmailButton />
        </div>
      </aside>

      {/* round 31 新增：aside 在 <lg 時是 fixed（脫離文件流），這個 wrapper
          在手機／平板下自然佔滿全寬；lg 以上 aside 變回 static、重新加入
          flex 排版，這個 wrapper 才會被擠到 aside 右邊，等同修改前的
          <main> 單獨作為 flex 子項的行為。 */}
      <div className="flex min-h-screen w-full flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-slate-200 bg-white px-4 lg:hidden">
          <button
            type="button"
            onClick={() => setNavOpen(true)}
            aria-label="開啟導覽選單"
            aria-expanded={navOpen}
            aria-controls="mobile-navigation"
            className="-ml-1 flex size-11 items-center justify-center rounded-lg text-slate-600 transition hover:bg-slate-100"
          >
            <Menu className="size-5" />
          </button>
          <span className="truncate text-sm font-semibold text-slate-900">
            新聞稿發送系統
          </span>
        </header>

        <main className="flex-1 overflow-x-hidden">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
