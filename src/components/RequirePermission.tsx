import type { ReactNode } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../lib/AuthContext'
import { ROUTE_PERMISSIONS } from '../lib/routePermissions'
import type { Permission } from '../constants'

/**
 * 路由層的權限守門。
 *
 * 側邊選單只隱藏沒權限的連結（can() 判斷），但這只是體驗 ——
 * 使用者仍可以直接在網址列輸入路徑，或用瀏覽器書籤/紀錄跳進來。
 * Firestore Rules 才是真正擋得住資料的關卡，但頁面層級（例如整個
 * 「媒體名單」頁）如果完全不擋，使用者還是會看到一個因為讀取被拒絕
 * 而爛掉、報錯的畫面，體驗很差。這裡在路由層先擋一次：
 * 沒有權限就導去他還有權限的第一個頁面，全都沒有就顯示 403。
 */
export default function RequirePermission({
  need,
  children,
}: {
  need: Permission
  children: ReactNode
}) {
  const { can, loading } = useAuth()

  // 權限矩陣（settings/permissions）第一次還沒讀到之前不要急著下判斷，
  // 否則會在資料到齊前把有權限的人也導走一次，畫面閃一下。
  if (loading) return null

  if (can(need)) return <>{children}</>

  const fallback = ROUTE_PERMISSIONS.find((r) => r.need !== need && can(r.need))
  if (fallback) return <Navigate to={fallback.to} replace />

  return <Forbidden />
}

function Forbidden() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-2 p-8 text-center">
      <p className="text-lg font-semibold text-slate-800">403 沒有存取權限</p>
      <p className="text-sm text-slate-500">
        你的角色目前沒有任何可用的功能，請聯絡管理員確認權限設定。
      </p>
    </div>
  )
}
