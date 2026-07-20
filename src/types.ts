import type { Timestamp } from 'firebase/firestore'
import type { Category, Language, ListId, Role } from './constants'

/** 白名單使用者，文件 id 就是 email。 */
export interface AppUser {
  email: string
  displayName: string
  role: Role
  active: boolean
  createdAt?: Timestamp
}

/** 媒體聯絡人。 */
export interface MediaContact {
  id: string
  name: string
  email: string
  outlet: string
  title: string
  phone: string
  note: string
  /** 可同時屬於多個名單。 */
  lists: ListId[]
  /** 這位聯絡人要收到哪個語言版本。 */
  language: Language
  active: boolean
  createdAt?: Timestamp
  updatedAt?: Timestamp
}

/**
 * 單一語言版本的稿件內容。
 * 內文以純文字撰寫，寄出時由 email 樣板套上排版樣式。
 */
export interface PressVersion {
  subject: string
  bodyText: string
  /** 內嵌在內文的那張圖。 */
  heroImage?: StoredFile
}

export interface StoredFile {
  name: string
  path: string
  url: string
  size: number
  contentType: string
}

export interface PressRelease {
  id: string
  title: string
  category: Category
  versions: Record<Language, PressVersion>
  /** 附件為三個版本共用。 */
  attachments: StoredFile[]
  status: 'draft' | 'sent'
  createdBy: string
  createdAt?: Timestamp
  updatedAt?: Timestamp
}

export type RecipientStatus =
  | 'queued'
  | 'sent'
  | 'delivered'
  | 'opened'
  | 'clicked'
  | 'bounced'
  | 'failed'

export interface CampaignRecipient {
  contactId: string
  email: string
  name: string
  outlet: string
  language: Language
  status: RecipientStatus
  openedAt?: Timestamp
  clickedAt?: Timestamp
  error?: string
}

export interface Campaign {
  id: string
  pressReleaseId: string
  pressTitle: string
  category: Category
  targetLists: ListId[]
  isTest: boolean
  sentBy: string
  sentAt?: Timestamp
  status: 'sending' | 'completed' | 'failed'
  totals: {
    recipients: number
    sent: number
    failed: number
    opened: number
    clicked: number
    bounced: number
  }
}
