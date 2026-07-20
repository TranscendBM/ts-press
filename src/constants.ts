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

/** 媒體關係經營的活動類型。 */
export const EVENT_TYPES = [
  'meal',
  'tea',
  'gift_dragonboat',
  'gift_midautumn',
  'gift_other',
  'other',
] as const
export type EventType = (typeof EVENT_TYPES)[number]

export const EVENT_TYPE_LABELS: Record<EventType, string> = {
  meal: '媒體餐敘',
  tea: '媒體茶會',
  gift_dragonboat: '端午禮品',
  gift_midautumn: '中秋禮品',
  gift_other: '其他禮品',
  other: '其他活動',
}

/** 送禮類活動用「贈送」而非「出席」，介面文案要跟著換。 */
export const GIFT_TYPES: EventType[] = [
  'gift_dragonboat',
  'gift_midautumn',
  'gift_other',
]

/** 使用者角色。admin 與 manager 可按下正式發送。 */
export const ROLES = ['admin', 'manager', 'editor'] as const
export type Role = (typeof ROLES)[number]

export const ROLE_LABELS: Record<Role, string> = {
  admin: '管理員',
  manager: '主管',
  editor: '編輯',
}

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
