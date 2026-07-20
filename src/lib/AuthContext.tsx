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
import { auth, db, googleProvider } from './firebase'
import type { AppUser } from '../types'

/**
 * 登入被拒的原因。任何 Google 帳號都能按登入，
 * 但只有被加進 users 白名單（且未停用）的 email 才進得來。
 */
export type AuthDenial = 'not-whitelisted' | null

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

      // 白名單文件的 id 就是 email
      const snap = await getDoc(doc(db, 'users', email))
      const data = snap.exists() ? (snap.data() as AppUser) : null

      if (!data || data.active === false) {
        setDenial('not-whitelisted')
        await signOut(auth)
        setLoading(false)
        return
      }

      // 後端 trigger 會依白名單寫入 pressCenter custom claim，
      // 首次登入時 token 還沒有它，強制刷新一次才能通過 Storage 規則。
      try {
        await user.getIdToken(true)
      } catch {
        // 刷新失敗不擋登入，最多是這次 session 無法上傳檔案
      }

      setDenial(null)
      setFirebaseUser(user)
      setAppUser({ ...data, email: email.toLowerCase() })
      setLoading(false)
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
