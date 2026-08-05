/** 語言版本：一篇新聞稿固定產出這三個版本。 */
export const LANGUAGES = ['tw', 'www', 'us'] as const
export type Language = (typeof LANGUAGES)[number]

export const LANGUAGE_LABELS: Record<Language, string> = {
  tw: '繁體中文 (tw)',
  www: '英文 / 全球 (www)',
  us: '英文 / 美國 (us)',
}

/** 媒體名單。發送時由使用者手動勾選。 */
export const LISTS = ['tw_pr', 'tw_ir', 'global_pr', 'us_pr', 'test'] as const
export type ListId = (typeof LISTS)[number]

export const LIST_LABELS: Record<ListId, string> = {
  tw_pr: '台灣 PR',
  tw_ir: '台灣 IR',
  global_pr: 'Global PR',
  us_pr: '美國 PR',
  test: '測試名單',
}

/** 名單預設對應的語言版本，新增聯絡人時作為預設值。 */
export const LIST_DEFAULT_LANGUAGE: Record<ListId, Language> = {
  tw_pr: 'tw',
  tw_ir: 'tw',
  global_pr: 'www',
  us_pr: 'us',
  test: 'tw',
}

/** 內部測試用，不是真的媒體，介面上要標示清楚避免誤發。 */
export const INTERNAL_LISTS: ListId[] = ['test']

/** 可設定「內部副本」的名單：正式發送時一併知會公司同事。排除測試名單。 */
export const COPYABLE_LISTS: ListId[] = LISTS.filter(
  (l) => !INTERNAL_LISTS.includes(l),
)

/** 新聞稿分類。 */
export const CATEGORIES = [
  'brand',
  'revenue',
  'consumer',
  'industrial',
  'exhibition',
] as const
export type Category = (typeof CATEGORIES)[number]

export const CATEGORY_LABELS: Record<Category, string> = {
  brand: '品牌',
  revenue: '營收',
  consumer: '商規產品',
  industrial: '工規產品',
  exhibition: '秀展',
}

/** 媒體屬性分類，用於台灣媒體名單的分組與重要性排序。 */
export const MEDIA_TYPES = [
  'paper',
  'tv',
  'magazine',
  'finance',
  'tech',
  'online',
  'other',
] as const
export type MediaType = (typeof MEDIA_TYPES)[number]

export const MEDIA_TYPE_LABELS: Record<MediaType, string> = {
  paper: '傳統媒體',
  tv: '電視媒體',
  magazine: '雜誌',
  finance: '財經媒體',
  tech: '科技媒體',
  online: '網路媒體',
  other: '未分類',
}

/** 各分類的顯示順序，數字小的排前面。 */
export const MEDIA_TYPE_ORDER: Record<MediaType, number> = {
  paper: 1,
  tv: 2,
  magazine: 3,
  finance: 4,
  tech: 5,
  online: 6,
  other: 9,
}

/**
 * 台灣媒體的建議分類與重要性順序（由行銷部提供）。
 * rank 是跨分類的全域排序，數字越小越重要。
 * 後台的「套用建議分類」會依媒體名稱比對後套用，之後仍可個別調整。
 */
export const MEDIA_TIER_MAP: Record<string, { type: MediaType; rank: number }> =
  {
    // 1. 傳統媒體（報紙、通訊社）
    中央社: { type: 'paper', rank: 1 },
    經濟日報: { type: 'paper', rank: 2 },
    聯合報: { type: 'paper', rank: 3 },
    自由時報: { type: 'paper', rank: 4 },
    中國時報: { type: 'paper', rank: 5 },
    '英文台北時報(TaipeiTimes)': { type: 'paper', rank: 6 },

    // 2. 電視媒體
    TVBS: { type: 'tv', rank: 11 },
    非凡財經: { type: 'tv', rank: 12 },
    東森財經: { type: 'tv', rank: 13 },
    東森財經新聞台: { type: 'tv', rank: 14 },

    // 3. 雜誌
    天下雜誌: { type: 'magazine', rank: 21 },
    遠見: { type: 'magazine', rank: 22 },
    鏡週刊: { type: 'magazine', rank: 23 },
    財訊: { type: 'magazine', rank: 24 },
    財訊雙周刊: { type: 'magazine', rank: 25 },
    理財周刊: { type: 'magazine', rank: 26 },

    // 4. 財經媒體
    鉅亨網: { type: 'finance', rank: 31 },
    '精實財經MoneyDJ': { type: 'finance', rank: 32 },
    優分析: { type: 'finance', rank: 33 },
    時報資訊: { type: 'finance', rank: 34 },

    // 5. 科技媒體
    '電子時報DigitalTimes': { type: 'tech', rank: 41 },
    '集邦科技(Trendforce)': { type: 'tech', rank: 42 },
    科技新報: { type: 'tech', rank: 43 },
    EETimes: { type: 'tech', rank: 44 },
    PCDIY: { type: 'tech', rank: 45 },
    'ioioTIMES科技世代': { type: 'tech', rank: 46 },

    // 6. 網路媒體
    ETtoday: { type: 'online', rank: 51 },
    風傳媒: { type: 'online', rank: 52 },
    壹蘋新聞網: { type: 'online', rank: 53 },
    NOWnews: { type: 'online', rank: 54 },
    FTNN鋒燦傳媒: { type: 'online', rank: 55 },
    知新聞: { type: 'online', rank: 56 },
    鏡報新聞網: { type: 'online', rank: 57 },
  }

/** 比對媒體名稱時忽略空白與大小寫，避免「PCDIY」與「PCDIY!」對不上。 */
export function lookupMediaTier(outlet: string) {
  const key = (outlet ?? '').replace(/[\s!！]/g, '')
  if (MEDIA_TIER_MAP[key]) return MEDIA_TIER_MAP[key]
  const lower = key.toLowerCase()
  const hit = Object.keys(MEDIA_TIER_MAP).find(
    (k) => k.toLowerCase() === lower,
  )
  return hit ? MEDIA_TIER_MAP[hit] : null
}

/** 媒體關係經營的活動類型。 */
export const EVENT_TYPES = [
  'meal',
  'gift_seasonal',
  'gift_other',
  'other',
] as const
export type EventType = (typeof EVENT_TYPES)[number]

export const EVENT_TYPE_LABELS: Record<EventType, string> = {
  meal: '媒體餐敘',
  gift_seasonal: '年節禮品',
  gift_other: '其他禮品',
  other: '其他活動',
}

/**
 * 已停用的類型對應到現行類型。
 * 端午與中秋合併成「年節禮品」，媒體茶會歸入「其他活動」。
 * 既有紀錄不必改資料庫，讀取時轉換即可。
 */
const LEGACY_EVENT_TYPES: Record<string, EventType> = {
  gift_dragonboat: 'gift_seasonal',
  gift_midautumn: 'gift_seasonal',
  tea: 'other',
}

/** 把資料庫裡的類型轉成現行類型，未知值一律視為「其他活動」。 */
export function normalizeEventType(type: string | undefined): EventType {
  if (EVENT_TYPES.includes(type as EventType)) return type as EventType
  return LEGACY_EVENT_TYPES[type ?? ''] ?? 'other'
}

export function eventTypeLabel(type: string | undefined): string {
  return EVENT_TYPE_LABELS[normalizeEventType(type)]
}

/** 送禮類活動用「贈送」而非「出席」，介面文案要跟著換。 */
export const GIFT_TYPES: EventType[] = ['gift_seasonal', 'gift_other']

export function isGiftType(type: string | undefined): boolean {
  return GIFT_TYPES.includes(normalizeEventType(type))
}

// 角色與權限統一由 shared/permissions 定義，這裡轉出方便既有引用
export {
  ROLES,
  ROLE_LABELS,
  ROLE_DESCRIPTIONS,
  PERMISSIONS,
  PERMISSION_LABELS,
  normalizeRole,
  type Role,
  type Permission,
} from '../shared/permissions'

/**
 * 記者按「回信」時會進的信箱。實際寄件帳號設定在 Cloud Functions 的
 * SMTP_USER 密鑰，這裡只用於介面顯示。
 */
export const REPLY_TO_EMAIL = 'press_center@transcend-info.com'

/**
 * 登入不限網域（公司信箱用 mail2000，沒有對應的 Google 帳號），
 * 改由 users 白名單決定誰進得來，個人 Google 帳號也可以。
 */

/** 附件總大小上限（10MB），超過會被多數郵件伺服器退回。 */
export const MAX_ATTACHMENT_TOTAL_BYTES = 10 * 1024 * 1024
