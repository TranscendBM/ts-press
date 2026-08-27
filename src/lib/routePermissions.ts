import type { Permission } from '../constants'

/**
 * 每個受保護路由需要的權限，依「導覽優先順序」排列。
 *
 * 這份清單同時餵給側邊導覽（Layout）與路由守門（RequirePermission）：
 * 前者決定選單顯示什麼，後者在使用者直接輸入無權限的網址時，
 * 決定要導去清單中第一個他還有權限的頁面，還是顯示 403。
 * 兩處共用同一份順序，才不會「選單看不到，但網址打進去卻可以進」。
 */
export const ROUTE_PERMISSIONS: { to: string; need: Permission }[] = [
  { to: '/press', need: 'viewPress' },
  { to: '/schedule', need: 'viewPress' },
  { to: '/contacts', need: 'manageContacts' },
  { to: '/events', need: 'manageEvents' },
  { to: '/send', need: 'sendTest' },
  { to: '/campaigns', need: 'viewCampaigns' },
  { to: '/settings', need: 'manageSettings' },
]
