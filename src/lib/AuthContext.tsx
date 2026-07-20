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
import { ALLOWED_DOMAIN } from '../constants'
import type { AppUser } from '../types'

/**
 * 登入失敗的原因，用來在登入頁顯示對應說明：
 * - wrong-domain：不是公司帳號
 * - not-whitelisted：是公司帳號但沒有被加進 users 白名單（或被停用）
 */
export type AuthDenial = 'wrong-domain' | 'not-whitelisted' | null

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

      const email = user.email ?? ''
      if (!email.toLowerCase().endsWith(`@${ALLOWED_DOMAIN}`)) {
        setDenial('wrong-domain')
        await signOut(auth)
        setLoading(false)
        return
      }

      // 白名單文件的 id 就是 email
      const snap = await getDoc(doc(db, 'users', email.toLowerCase()))
      const data = snap.exists() ? (snap.data() as AppUser) : null

      if (!data || data.active === false) {
        setDenial('not-whitelisted')
        await signOut(auth)
        setLoading(false)
        return
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
        // hd 只是提示 Google 優先顯示公司帳號，實際仍以上面的網域檢查為準
        googleProvider.setCustomParameters({
          prompt: 'select_account',
          hd: ALLOWED_DOMAIN,
        })
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
