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
import { doc, getDoc } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { auth, db, functions, googleProvider } from './firebase'
import type { AppUser } from '../types'

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
async function syncClaimsIfStale(user: User, expectedRole: string | undefined) {
  try {
    const token = await user.getIdTokenResult()
    if (token.claims.pressCenter === true && token.claims.role === expectedRole) {
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
  canSend: boolean
  isAdmin: boolean
}

const AuthContext = createContext<AuthState | undefined>(undefined)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [firebaseUser, setFirebaseUser] = useState<User | null>(null)
  const [appUser, setAppUser] = useState<AppUser | null>(null)
  const [loading, setLoading] = useState(true)
  const [denial, setDenial] = useState<AuthDenial>(null)

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
      // 只有 admin 與 manager 能按下正式發送
      canSend: appUser?.role === 'admin' || appUser?.role === 'manager',
      isAdmin: appUser?.role === 'admin',
    }),
    [firebaseUser, appUser, loading, denial],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth 必須在 AuthProvider 內使用')
  return ctx
}
