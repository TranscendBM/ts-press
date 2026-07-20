import { useEffect, useState } from 'react'
import { doc, onSnapshot } from 'firebase/firestore'
import { db } from './firebase'

export interface Branding {
  /** 系統介面用的 logo（深色，配白底）。 */
  uiLogoUrl?: string
}

/** 專案內建的深色 logo，後台沒另外設定時使用。 */
export const DEFAULT_UI_LOGO = '/logo-dark.png'

/**
 * 讀取介面 logo。settings/branding 是公開可讀的，
 * 因為登入頁在通過驗證前就要顯示 logo。
 */
export function useBranding(): Branding {
  const [branding, setBranding] = useState<Branding>({})

  useEffect(() => {
    return onSnapshot(
      doc(db, 'settings', 'branding'),
      (snap) => setBranding((snap.data() as Branding) ?? {}),
      // 讀取失敗就退回內建 logo，不需要打斷使用者
      () => setBranding({}),
    )
  }, [])

  return { uiLogoUrl: branding.uiLogoUrl?.trim() || DEFAULT_UI_LOGO }
}
