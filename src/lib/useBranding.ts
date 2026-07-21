import { useEffect, useState } from 'react'
import { doc, onSnapshot } from 'firebase/firestore'
import { db } from './firebase'

export interface Branding {
  /** 系統介面用的 logo（深色，配白底）。欄位名需與安全規則的白名單一致。 */
  logoUrl?: string
}

/** 專案內建的深色 logo，後台沒另外設定時使用。 */
export const DEFAULT_UI_LOGO = '/logo-dark.png'

/**
 * 讀取介面 logo。
 *
 * ⚠️ settings/branding 是**完全公開**的文件 —— 未登入者也讀得到，
 * 因為登入頁在通過驗證前就要顯示 logo。
 * 因此該文件不得存放任何機密或內部設定（密碼、金鑰、內部主機位址等）。
 * 安全規則已把可寫入的欄位限制為 logoUrl 與 updatedAt。
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

  return { logoUrl: branding.logoUrl?.trim() || DEFAULT_UI_LOGO }
}
