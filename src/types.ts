import type { Timestamp } from 'firebase/firestore'
import type {
  Category,
  EventType,
  Language,
  ListId,
  MediaType,
  Role,
} from './constants'
import type {
  CampaignStatus as CampaignOutcomeStatus,
  RecipientStatus as SharedRecipientStatus,
} from '../shared/campaignSend'

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
  /**
   * 備用信箱。有些記者同時給了公司與個人信箱，
   * 記在同一筆資料裡，避免建成兩筆造成名單重複。
   */
  altEmail?: string
  outlet: string
  title: string
  phone: string
  note: string
  /** 媒體屬性分類，用於分組顯示。 */
  mediaType?: MediaType
  /** 重要性排序，數字越小越前面。未設定為 null，排在最後。 */
  rank?: number | null
  /** 標記為重要窗口。排序時一律排在最前面，優先於 rank。 */
  starred?: boolean
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

/** 信件頁尾的公司簡介，每個語言版本可各自維護。 */
export interface AboutBlock {
  text: string
  link: string
}

export interface EmailSettings {
  /** 頁首 logo，建議透明背景 PNG。 */
  logoUrl?: string
  contacts?: Record<Language, PressContact>
  about?: Record<Language, AboutBlock>
  /**
   * 內部副本收件人：正式發送某個媒體名單時，一併寄一份給這些公司同事。
   * 依名單分別設定，每個值是逗號／換行分隔的信箱字串。
   * 同事只會收到一份（跨名單、與媒體重複都會自動去重）。
   */
  internalCopies?: Partial<Record<ListId, string>>
}

export interface PressRelease {
  id: string
  title: string
  category: Category
  /** 新聞稿發佈日期，格式 yyyy-mm-dd，顯示在標題下方（給記者看，印在信上）。 */
  releaseDate?: string
  /**
   * 內部規劃的計畫發送日期，格式 yyyy-mm-dd。只用於「發送排程」看板，
   * 不會出現在信件內容裡，與 releaseDate 分開。
   */
  scheduledDate?: string
  /** 負責人（白名單使用者的 email 與顯示名稱，指派時一併記下）。 */
  ownerEmail?: string
  ownerName?: string
  versions: Record<Language, PressVersion>
  /** 附件為三個版本共用。 */
  attachments: StoredFile[]
  status: 'draft' | 'sent'
  /** 封存後移到列表下方，不影響已發送的紀錄。 */
  archived?: boolean
  /** 實際完成正式發送的時間，由 Cloud Function 在發送後標記。 */
  sentAt?: Timestamp
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

/**
 * 直接沿用 shared/campaignSend.ts 的 RecipientStatus，不在前端另外維護
 * 一份可能漂移的字面量聯集——那裡才是狀態機的唯一權威定義（見
 * isTerminalCampaignStatus／isRetriableCampaignStatus 的說明）。
 *
 * claimed（round 8 新增）：已被某次呼叫原子性地搶下，但**還沒**真正呼叫
 * SMTP（正常情況下很短暫）。若卡在這個狀態代表該次呼叫在真正寄送之前就
 * 中斷了，租約過期後可以安全地重新認領——這個狀態還沒有任何送達相關的
 * 副作用發生。
 * sending：已經即將或已經呼叫過 sendMail，可能已經有 SMTP delivery
 * side effect 發生。⚠️ 跟 claimed 不同，**租約過期不代表可以安全重新
 * 認領**——沒有任何有限的 lease 時間能證明 SMTP 最終真的沒有送達（round 7
 * Finding 1 的教訓：過去 sending 過期就直接可重新認領，會讓「SMTP 已接受
 * 但寫回結果失敗」的收件人被另一個 invocation 重複寄送）。過期的 sending
 * 只能被系統自動轉成 delivery_unknown，交給人工處理，不會回到一般認領
 * 流程。
 * exhausted：重試次數已達上限，永久失敗，不會再被任何呼叫認領。
 * delivery_unknown：sendMail 逾時、「SMTP 已接受但寫回 Firestore 失敗」，
 * 或過期的 sending 被系統自動回收——送達與否無法確認，永久排除在自動
 * 認領／重試之外，只能透過 resolveDeliveryUnknown（admin-only callable，
 * 見 CampaignDetailPage.tsx）人工判斷標記已送達，或承擔風險強制重寄。
 */
export type RecipientStatus = SharedRecipientStatus

export interface CampaignRecipient {
  contactId: string
  email: string
  name: string
  outlet: string
  language: Language
  status: RecipientStatus
  /** 已經嘗試寄送過幾次（含目前這次）。 */
  attemptCount?: number
  /** 目前認領這位收件人的 invocation。用來判斷寄送結果是否可以寫入。 */
  attemptId?: string | null
  /** 目前認領的租約到期時間（epoch ms）。claimed 過期可以安全重新認領；
   *  sending 過期不行，見 RecipientStatus 的說明。 */
  leaseExpiresAtMs?: number | null
  /** round 10 新增（Finding 1／Finding 2）：認領當下 campaign 的 fencing
   *  generation，供 commitRecipientResultTx 之後重新核對用，見
   *  shared/campaignSend.ts 的 readLeaseGeneration 說明。 */
  claimGeneration?: number
  /** round 9 新增（Finding 1）：真正開始呼叫 SMTP 的時間（epoch ms），
   *  由 beginDeliveryAttemptTx 寫入，跟 attemptCount 記錄的「認領」時間
   *  分開，供診斷用。 */
  deliveryStartedAtMs?: number | null
  /** round 10 新增（Finding 1）：被 sweepExpiredDeliveryAttempts() 轉成
   *  delivery_unknown 之前的 attemptId，供稽核；轉換的同時 attemptId 本身
   *  會被清成 null，避免遲到的舊 SMTP commit 用「attemptId 相符」覆寫。 */
  deliveryUnknownOriginalAttemptId?: string | null
  /** 最近一次嘗試寄送的時間。 */
  lastAttemptAt?: Timestamp
  /** 最近一次失敗（含永久失敗）的錯誤訊息。 */
  lastError?: string
  /**
   * round 8 新增（Finding 2）；round 9 修正（Finding 4 新增 resolutionId）：
   * 這幾個欄位只有透過 resolveDeliveryUnknown 人工處理過 delivery_unknown
   * 之後才會出現，供稽核使用。round 10 起，這幾個欄位本身**不再**是
   * idempotency／conflict 判斷的依據（見 campaigns/{id}/resolutionEvents
   * 這個 immutable ledger 的說明——同一位收件人可能不只一次進入
   * delivery_unknown，這裡的欄位只反映「最近一次」的人工處理，不能代表
   * 完整的處理歷史）。
   */
  resolvedBy?: string
  resolvedAt?: Timestamp
  /** 前端產生的 idempotency key，用來分辨「同一個請求重送」跟「另一個
   *  獨立的 resolution」，見 CampaignDetailPage.tsx 的說明。 */
  resolutionId?: string
  resolutionAction?: 'mark_delivered' | 'force_retry'
  resolutionReason?: string
  /** 被人工處理前，最後一次認領這位收件人的 attemptId（若有；round 10
   *  起，resolve 的同時 attemptId 本身也會被清成 null，理由同上）。 */
  resolutionOriginalAttemptId?: string | null
}

/**
 * round 10 新增（Finding 3）：一次 delivery_unknown 人工 resolution 的
 * immutable 稽核紀錄，存在 campaigns/{campaignId}/resolutionEvents/{resolutionId}
 * ——只由後端在 transaction 內建立一次，之後永遠不會再被修改，Firestore
 * rules 對 client 一律 `allow write: if false`。存在的理由見
 * shared/campaignSend.ts 的 ResolutionEventRecord 說明：一位收件人可能
 * 不只一次進入 delivery_unknown，用這個 ledger（而不是 recipient 文件上
 * 會被覆寫的欄位）才能保證同一個 resolutionId 永遠不會被套用第二次。
 */
export interface ResolutionEvent {
  recipientId: string
  resolutionAction: 'mark_delivered' | 'force_retry'
  resolutionReason: string
  resolvedBy: string
  resolvedAt?: Timestamp
  fencingGeneration: number
  beforeStatus: 'delivery_unknown'
  afterStatus: 'sent' | 'failed'
}

export interface Campaign {
  id: string
  pressReleaseId: string
  pressTitle: string
  category: Category
  targetLists: ListId[]
  mode?: 'self' | 'testList' | 'real'
  isTest: boolean
  sentBy: string
  sentAt?: Timestamp
  /** 這次呼叫開始處理的時間（epoch ms）。 */
  startedAtMs?: number
  /** 到達 completed／failed 這類終止狀態的時間；partial／sending 時不會有值。 */
  completedAt?: Timestamp
  updatedAt?: Timestamp
  /**
   * 'sending' 是唯一不在 shared/campaignSend.ts CampaignStatus 裡的值
   *（那裡只代表 decideCampaignStatus() 算出來的「收尾結果」，'sending'
   * 是初始值／中斷後保留的現況，不是一種收尾結果）；其餘四種都直接沿用
   * shared 的定義，不在前端另外維護：
   * - partial：這次呼叫因為單批上限（SEND_BATCH_LIMIT）而提早停止，或還有
   *   收件人待重試（failed／queued）尚未用完重試次數，可以呼叫
   *   retryCampaign 接著寄完。只要還有人可能重試，就不會提早變成
   *   completed／failed／needs_review。
   * - needs_review：所有能自動處理的收件人都到達終止狀態了，但其中有
   *   delivery_unknown（送達無法確認）——不能自動判定成功或失敗，需要
   *   人工檢查。一般的「繼續寄送」對它無事可做，見
   *   isRetriableCampaignStatus() 的說明。
   *
   * isTerminalCampaignStatus()／isRetriableCampaignStatus()（shared/campaignSend.ts）
   * 是這個狀態機「該不該顯示繼續寄送按鈕」的唯一權威判斷，頁面不要自己
   * 用 `status === 'partial' || status === 'sending'` 這種方式重新判斷。
   */
  status: 'sending' | CampaignOutcomeStatus
  lastError?: string
  /** 收件人子集合是否已經完整寫入；建立中（false）代表另一個 invocation 可能還在寫。 */
  recipientsReady?: boolean
  /** 建立這份 campaign 文件（設定階段）的 attemptId，只有它能標記設定階段的失敗。 */
  createdByAttemptId?: string
  /** 目前持有處理租約（正在寄送）的 attemptId；完成或失敗時會被清掉。 */
  activeAttemptId?: string | null
  /** 處理租約的到期時間（epoch ms）；完成或失敗時會被清掉。 */
  activeLeaseExpiresAtMs?: number | null
  /** round 9 新增（Finding 2）：resolveDeliveryUnknown 進行中持有的
   *  resolution 租約，跟處理租約互斥；resolution 結束時會被清掉。 */
  resolutionLeaseAttemptId?: string | null
  resolutionLeaseExpiresAtMs?: number | null
  /** round 10 新增（Finding 1／Finding 2）：processing 租約與 resolution
   *  租約共用的單調遞增 fencing generation，每次任何一種租約被成功取得
   *  都會遞增一次；**不會**隨租約釋放而清掉，見
   *  shared/campaignSend.ts 的 readLeaseGeneration 說明。 */
  leaseGeneration?: number
  /** 最近一次（不論是否仍在進行中）處理過這個 campaign 的 attemptId，供診斷用，不隨租約清除。 */
  lastAttemptId?: string
  totals: {
    recipients: number
    sent: number
    /** 目前失敗但還可能重試（attemptCount 未達上限）。 */
    failed: number
    /** 永久失敗：重試次數已達上限，不會再自動或手動重試。 */
    exhausted?: number
    /** 送達與否無法確認（sendMail 逾時，或已接受但寫回失敗），不會被自動重試。 */
    deliveryUnknown?: number
  }
}
