import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import {
  onAuthStateChanged,
  signInWithPopup,
  signOut,
  type User,
} from 'firebase/auth'
import { doc, getDoc, onSnapshot } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { auth, db, functions, googleProvider } from './firebase'
import type { AppUser } from '../types'
import {
  hasPermission,
  normalizeRole,
  type Permission,
  type RolePermissions,
} from '../../shared/permissions'

/**
 * 登入被拒的原因。任何 Google 帳號都能按登入，
 * 但只有被加進 users 白名單（且未停用）的 email 才進得來。
 */
export type AuthDenial = 'not-whitelisted' | 'lookup-failed' | null

const refreshMyClaims = httpsCallable<void, { ok: boolean; role: string | null }>(
  functions,
  'refreshMyClaims',
)

/** token 的 claim 與白名單不符時補發，並強制刷新 token。 */
async function syncClaimsIfStale(user: User, rawRole: string | undefined) {
  try {
    // 後端寫入 claim 時會做正規化，這裡也要正規化後再比對，
    // 否則舊的 editor 帳號永遠比不相等，每次登入都白跑一次補發。
    const expectedRole = normalizeRole(rawRole) ?? null
    const token = await user.getIdTokenResult()
    if (
      token.claims.pressCenter === true &&
      (token.claims.role ?? null) === expectedRole
    ) {
      return
    }
    await refreshMyClaims()
    await user.getIdToken(true)
  } catch (err) {
    // 補發失敗不該擋住登入，只是某些上傳功能可能暫時不能用
    console.warn('補發權限 claim 失敗', err)
  }
}

interface AuthState {
  firebaseUser: User | null
  appUser: AppUser | null
  loading: boolean
  denial: AuthDenial
  signIn: () => Promise<void>
  logout: () => Promise<void>
  /** 依權限矩陣判斷。前端只用來顯示，實際攔截在 Cloud Functions。 */
  can: (permission: Permission) => boolean
  isAdmin: boolean
}

const AuthContext = createContext<AuthState | undefined>(undefined)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [firebaseUser, setFirebaseUser] = useState<User | null>(null)
  const [appUser, setAppUser] = useState<AppUser | null>(null)
  const [loading, setLoading] = useState(true)
  const [denial, setDenial] = useState<AuthDenial>(null)
  // 管理員可在後台覆寫各角色權限，讀不到就沿用預設
  const [permissionOverrides, setPermissionOverrides] = useState<
    Record<string, Partial<RolePermissions>> | undefined
  >(undefined)

  useEffect(() => {
    if (!appUser) return
    return onSnapshot(
      doc(db, 'settings', 'permissions'),
      (snap) => setPermissionOverrides(snap.data()?.roles),
      () => setPermissionOverrides(undefined),
    )
  }, [appUser])

  useEffect(() => {
    return onAuthStateChanged(auth, async (user) => {
      if (!user) {
        setFirebaseUser(null)
        setAppUser(null)
        setLoading(false)
        return
      }

      const email = (user.email ?? '').toLowerCase()

      // 不在白名單時安全規則會回 permission-denied（不是空結果）。
      // 少了 try/catch 這裡會直接 throw，loading 永遠停在 true，
      // 使用者就卡在「載入中」而看不到任何說明。
      try {
        const snap = await getDoc(doc(db, 'users', email))
        const data = snap.exists() ? (snap.data() as AppUser) : null

        // 與後端 evaluateAccess 一致：必須明確 active === true
        if (!data || data.active !== true) {
          setDenial('not-whitelisted')
          await signOut(auth)
          return
        }

        setDenial(null)
        setFirebaseUser(user)
        setAppUser({ ...data, email })
        // Storage 規則看 token 裡的 pressCenter / role，白名單改了角色
        // 但 token 還沒更新時上傳會被擋。不一致就補發並刷新。
        await syncClaimsIfStale(user, data.role)
      } catch (err) {
        const code = (err as { code?: string }).code
        if (code === 'permission-denied') {
          setDenial('not-whitelisted')
        } else {
          console.error('讀取白名單失敗', err)
          setDenial('lookup-failed')
        }
        await signOut(auth).catch(() => {})
      } finally {
        // 不論成功或失敗都要收掉載入狀態
        setLoading(false)
      }
    })
  }, [])

  const value = useMemo<AuthState>(
    () => ({
      firebaseUser,
      appUser,
      loading,
      denial,
      signIn: async () => {
        setDenial(null)
        await signInWithPopup(auth, googleProvider)
      },
      logout: async () => {
        await signOut(auth)
        setDenial(null)
      },
      can: (permission: Permission) =>
        hasPermission(appUser?.role, permission, permissionOverrides),
      isAdmin: normalizeRole(appUser?.role) === 'admin',
    }),
    [firebaseUser, appUser, loading, denial, permissionOverrides],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth 必須在 AuthProvider 內使用')
  return ctx
}
