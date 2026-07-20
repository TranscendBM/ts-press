import type { Timestamp } from 'firebase/firestore'
import type {
  Category,
  EventType,
  Language,
  ListId,
  Role,
} from './constants'

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

/** 每個語言版本各自的新聞聯絡人，存在 settings/email。 */
export interface PressContact {
  name: string
  company: string
  email: string
  phone: string
}

export interface EmailSettings {
  /** 頁首 logo，建議透明背景 PNG。 */
  logoUrl?: string
  contacts?: Record<Language, PressContact>
}

export interface PressRelease {
  id: string
  title: string
  category: Category
  /** 新聞稿發佈日期，格式 yyyy-mm-dd，顯示在標題下方。 */
  releaseDate?: string
  versions: Record<Language, PressVersion>
  /** 附件為三個版本共用。 */
  attachments: StoredFile[]
  status: 'draft' | 'sent'
  /** 封存後移到列表下方，不影響已發送的紀錄。 */
  archived?: boolean
  createdBy: string
  createdAt?: Timestamp
  updatedAt?: Timestamp
}

/**
 * 走 mail2000 SMTP 寄送，只能知道伺服器有沒有收下這封信，
 * 沒有開信 / 點擊 / 退信回報。
 */
/**
 * 媒體關係經營的活動：餐敘、茶會、年節禮品等。
 * 每位媒體的參加／贈送紀錄放在 participants 子集合，文件 id 就是 contactId。
 */
export interface MediaEvent {
  id: string
  name: string
  type: EventType
  /** 活動日期，格式 yyyy-mm-dd。 */
  date: string
  /** 由 date 推導，用於依年份分組。 */
  year: number
  note: string
  createdBy: string
  createdAt?: Timestamp
  updatedAt?: Timestamp
}

/** 某位媒體在某場活動的紀錄。 */
export interface EventParticipant {
  contactId: string
  /** 出席（餐敘／茶會）或已致贈（禮品）。 */
  attended: boolean
  note: string
  updatedAt?: Timestamp
}

export type RecipientStatus = 'queued' | 'sent' | 'failed'

export interface CampaignRecipient {
  contactId: string
  email: string
  name: string
  outlet: string
  language: Language
  status: RecipientStatus
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
  }
}
