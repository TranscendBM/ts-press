/**
 * 新聞稿 email 樣板。
 *
 * 使用者只輸入純文字，這裡負責套上排版樣式。內文支援一種標記：
 * 以 `## ` 開頭的行會變成小標題。
 *
 * ⚠️ 這支檔案與 functions/src/emailTemplate.ts 內容相同，
 * 前端用來預覽、Cloud Function 用來實際產生寄出的 HTML，兩邊要一起改。
 *
 * ⚠️ 排版一律用表格與行內樣式，不要用 CSS float / flex / grid ——
 * Outlook 桌面版使用 Word 排版引擎，那些都不支援。
 */

export const BRAND_COLOR = '#960014'

/**
 * 信件頁首的白色 logo，配紅底使用。
 * 必須是絕對網址而且是 PNG —— 信件裡不能用相對路徑，
 * 而 Outlook 桌面版完全不支援 SVG。
 */
export const DEFAULT_EMAIL_LOGO = 'https://ts-press.web.app/logo-white.png'

export interface PressContact {
  name: string
  company: string
  email: string
  phone: string
}

export interface TemplateInput {
  subject: string
  bodyText: string
  /** 內文圖片，實際尺寸約 260px 寬。 */
  heroImageUrl?: string
  /** 收件人姓名，用於信件開頭稱謂；留空則用通用稱謂。 */
  recipientName?: string
  language: 'tw' | 'www' | 'us'
  /** 新聞稿發佈日期，格式 yyyy-mm-dd。 */
  releaseDate?: string
  /** 頁首 logo，建議白色、透明背景 PNG。 */
  logoUrl?: string
  /** 該語言版本的新聞聯絡人。 */
  contact?: PressContact
  /** 公司簡介。留空則用內建的預設文字。 */
  about?: string
  /** 公司簡介末尾的網址。留空則用內建預設。 */
  aboutLink?: string
}

const MONTHS_EN = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

const COPY = {
  tw: {
    greeting: (name: string) => `${name} 您好：`,
    fallbackGreeting: '媒體先進 您好：',
    contactTitle: '新聞聯絡人',
    aboutTitle: '關於創見資訊',
    about:
      '創見資訊於 1989 年在台灣成立，是全球領先的記憶體儲存品牌，產品涵蓋記憶體模組、固態硬碟、外接式硬碟、行車記錄器、密錄器、記憶卡、隨身碟、讀卡機及嵌入式解決方案。除台北總部外，於洛杉磯、漢堡、東京、上海等地設有據點。',
    aboutLink: 'https://tw.transcend-info.com',
    unsubscribe: '若不希望再收到創見的新聞稿，請來信 ',
    unsubscribeSuffix: ' 取消訂閱。',
  },
  www: {
    greeting: (name: string) => `Dear ${name},`,
    fallbackGreeting: 'Hello,',
    contactTitle: 'Press Contact',
    aboutTitle: 'About Transcend',
    about:
      'Transcend Information, founded in 1989 in Taiwan, is a globally leading brand in memory storage solutions, offering memory modules, SSDs, external drives, dashcams, body cameras, memory cards, USB drives, card readers, and embedded solutions. Beyond its Taipei headquarters, Transcend has offices in Los Angeles, Hamburg, Tokyo, Shanghai, and more.',
    aboutLink: 'https://www.transcend-info.com',
    unsubscribe: 'To stop receiving press releases from Transcend, please contact ',
    unsubscribeSuffix: '.',
  },
  us: {
    greeting: (name: string) => `Dear ${name},`,
    fallbackGreeting: 'Hello,',
    contactTitle: 'Press Contact',
    aboutTitle: 'About Transcend',
    about:
      'Transcend Information, founded in 1989 in Taiwan, is a globally leading brand in memory storage solutions, offering memory modules, SSDs, external drives, dashcams, body cameras, memory cards, USB drives, card readers, and embedded solutions. Beyond its Taipei headquarters, Transcend has offices in Los Angeles, Hamburg, Tokyo, Shanghai, and more.',
    aboutLink: 'https://www.transcend-info.com',
    unsubscribe: 'To stop receiving press releases from Transcend, please contact ',
    unsubscribeSuffix: '.',
  },
} as const

/**
 * 繁體中文版一律優先套用微軟正黑體。
 * 字型名稱同時列出英文與中文 —— 部分系統（尤其中文版 Windows 與
 * 舊版 Outlook）只認得其中一種寫法，兩個都寫才不會退回預設字型。
 */
const FONT_TW =
  "'Microsoft JhengHei',微軟正黑體,'PingFang TC','Helvetica Neue',Helvetica,Arial,sans-serif"
const FONT_EN = "Arial,'Helvetica Neue',Helvetica,sans-serif"

/** 後台「關於創見」欄位留空時使用的預設文字，也用來預先填入編輯欄位。 */
export const DEFAULT_ABOUT: Record<
  TemplateInput['language'],
  { text: string; link: string }
> = {
  tw: { text: COPY.tw.about, link: COPY.tw.aboutLink },
  www: { text: COPY.www.about, link: COPY.www.aboutLink },
  us: { text: COPY.us.about, link: COPY.us.aboutLink },
}

/**
 * 只允許 http/https/mailto 的絕對網址，其餘（javascript:、data: 等）一律丟掉。
 * 這些值來自後台設定與使用者輸入，直接塞進 href/src 會變成注入點。
 */
export function safeUrl(url: string | undefined): string {
  const raw = (url ?? '').trim()
  if (!raw) return ''
  if (!/^(https?:|mailto:)/i.test(raw)) return ''
  // 引號與角括號會提前結束屬性，一律編碼
  return raw.replace(/&/g, '&amp;').replace(/"/g, '%22').replace(/</g, '%3C').replace(/>/g, '%3E')
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * 主旨允許使用者手動斷行（在輸入框按 Enter）。
 * 但**郵件主旨標頭與 <title> 不能含換行**（違反 RFC，會被伺服器改寫或截斷），
 * 所以這裡把所有換行壓成單一空格。信件內文的大標題、Word、PDF 則保留斷行。
 */
export function subjectSingleLine(subject: string): string {
  return subject.replace(/\s*\r?\n\s*/g, ' ').trim()
}

/** 信件內文大標題用：跳脫後把換行轉成 <br>，保留使用者的斷行。 */
export function subjectMultiline(subject: string): string {
  return escapeHtml(subject).replace(/\r?\n/g, '<br>')
}

/** 依語言格式化發佈日期。tw 用「2026年6月24日」，英文用「June 24, 2026」。 */
export function formatReleaseDate(
  iso: string | undefined,
  language: TemplateInput['language'],
): string {
  if (!iso) return ''
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim())
  if (!m) return iso
  const [, y, mo, d] = m
  const month = Number(mo)
  const day = Number(d)
  if (language === 'tw') return `${y} 年 ${month} 月 ${day} 日`
  return `${MONTHS_EN[month - 1]} ${day}, ${y}`
}

const linkify = (s: string) =>
  s.replace(/(https?:\/\/[^\s<]+)/g, (match) => {
    const href = safeUrl(match)
    if (!href) return match
    return `<a href="${href}" style="color:${BRAND_COLOR};text-decoration:underline;">${match}</a>`
  })

/**
 * 把純文字切成區塊。空行分段；以 `## ` 開頭的行視為小標題。
 * 回傳陣列而非字串，方便呼叫端把圖片插在第一段之後。
 */
export function renderBlocks(text: string, font: string): string[] {
  return text
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean)
    .map((block) =>
      block.startsWith('## ')
        ? `<h2 style="margin:28px 0 12px;font-size:16px;line-height:1.5;font-weight:600;color:${BRAND_COLOR};font-family:${font};">${escapeHtml(
            block.slice(3).trim(),
          )}</h2>`
        : `<p style="margin:0 0 16px;font-size:15px;line-height:1.8;color:#2b2f36;font-family:${font};">${linkify(
            escapeHtml(block),
          ).replace(/\n/g, '<br>')}</p>`,
    )
}

export function renderEmailHtml(input: TemplateInput): string {
  const copy = COPY[input.language]
  const font = input.language === 'tw' ? FONT_TW : FONT_EN
  const greeting = input.recipientName?.trim()
    ? copy.greeting(escapeHtml(input.recipientName.trim()))
    : copy.fallbackGreeting

  const blocks = renderBlocks(input.bodyText, font)
  const dateLine = formatReleaseDate(input.releaseDate, input.language)
  // 後台沒填就用內建預設，確保信件永遠有公司簡介
  const aboutText = input.about?.trim() || copy.about
  const aboutLink = input.aboutLink?.trim() || copy.aboutLink
  const logoUrl = input.logoUrl?.trim() || DEFAULT_EMAIL_LOGO

  // 圖片置中插在開頭段落之後：讀者先讀完導言、正要往下時看到產品圖。
  // 不用兩欄並排 —— 260px 圖擠在 600px 版面裡會讓文字欄只剩 320px，
  // 而且兩欄表格在手機上不會自動堆疊。
  const heroSrc = safeUrl(input.heroImageUrl)
  const image = heroSrc
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 24px;">
         <tr><td align="center">
           <img src="${heroSrc}" alt="" width="260"
                style="display:block;width:260px;max-width:100%;height:auto;border:0;border-radius:4px;">
         </td></tr>
       </table>`
    : ''

  const [lead, ...rest] = blocks
  const body = [lead ?? '', image, ...rest].join('')

  const c = input.contact
  const contactBlock = c?.name
    ? `<div style="margin-top:28px;padding-top:20px;border-top:1px solid #e6e8ec;">
         <p style="margin:0 0 8px;font-size:13px;font-weight:600;color:${BRAND_COLOR};font-family:${font};">${escapeHtml(
           copy.contactTitle,
         )}</p>
         <p style="margin:0;font-size:13px;line-height:1.7;color:#4a505c;font-family:${font};">
           ${escapeHtml(c.name)}${c.company ? ` · ${escapeHtml(c.company)}` : ''}<br>
           ${
             c.email
               ? `<a href="${safeUrl(`mailto:${c.email}`)}" style="color:${BRAND_COLOR};text-decoration:none;">${escapeHtml(
                   c.email,
                 )}</a>`
               : ''
           }${c.phone ? `<br>${escapeHtml(c.phone)}` : ''}
         </p>
       </div>`
    : ''

  const unsubscribeEmail = c?.email || 'pr@transcend-info.com'

  return `<!doctype html>
<html lang="${input.language === 'tw' ? 'zh-Hant' : 'en'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(subjectSingleLine(input.subject))}</title>
</head>
<body style="margin:0;padding:0;background-color:#f4f5f7;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
       style="background-color:#f4f5f7;padding:24px 12px;">
  <tr><td align="center">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"
           style="width:600px;max-width:100%;background-color:#ffffff;border-radius:8px;overflow:hidden;">

      <!-- 頁首 -->
      <tr><td style="background-color:${BRAND_COLOR};padding:18px 32px;">
        <img src="${safeUrl(logoUrl)}" alt="TRANSCEND" height="26"
             style="display:block;height:26px;width:auto;border:0;">
      </td></tr>

      <!-- 標題與發佈日期 -->
      <tr><td style="padding:32px 32px 0;">
        <h1 style="margin:0;font-size:22px;line-height:1.45;font-weight:600;color:#12161c;font-family:${font};text-align:center;">
          ${subjectMultiline(input.subject)}
        </h1>
        ${
          dateLine
            ? `<p style="margin:10px 0 0;font-size:13px;color:#8a919e;font-family:${font};">${escapeHtml(
                dateLine,
              )}</p>`
            : ''
        }
        <div style="margin:20px 0 0;height:1px;background-color:#e6e8ec;font-size:0;line-height:0;">&nbsp;</div>
      </td></tr>

      <!-- 稱謂 -->
      <tr><td style="padding:20px 32px 0;">
        <p style="margin:0 0 16px;font-size:15px;line-height:1.8;color:#2b2f36;font-family:${font};">${greeting}</p>
      </td></tr>

      <!-- 內文 -->
      <tr><td style="padding:0 32px;">${body}</td></tr>

      <!-- 新聞聯絡人 -->
      <tr><td style="padding:0 32px 28px;">${contactBlock}</td></tr>

      <!-- 公司簡介 -->
      <tr><td style="padding:20px 32px;background-color:#fafbfc;border-top:1px solid #e6e8ec;">
        <p style="margin:0 0 6px;font-size:12px;font-weight:600;color:#4a505c;font-family:${font};">${escapeHtml(
          copy.aboutTitle,
        )}</p>
        <p style="margin:0;font-size:12px;line-height:1.7;color:#8a919e;font-family:${font};">
          ${escapeHtml(aboutText).replace(/\n/g, '<br>')}
          <a href="${safeUrl(aboutLink)}" style="color:${BRAND_COLOR};text-decoration:none;">${escapeHtml(
            aboutLink,
          )}</a>
        </p>
      </td></tr>

      <!-- 版權與退訂 -->
      <tr><td style="padding:12px 32px;background-color:${BRAND_COLOR};">
        <p style="margin:0;font-size:11px;line-height:1.6;color:#ffffff;font-family:${FONT_EN};">
          &copy; Transcend Information, Inc. All Rights Reserved.
        </p>
        <p style="margin:4px 0 0;font-size:11px;line-height:1.6;color:rgba(255,255,255,0.75);font-family:${font};">
          ${escapeHtml(copy.unsubscribe)}<a href="${safeUrl(`mailto:${unsubscribeEmail}`)}" style="color:#ffffff;text-decoration:underline;">${escapeHtml(
            unsubscribeEmail,
          )}</a>${escapeHtml(copy.unsubscribeSuffix)}
        </p>
      </td></tr>

    </table>
  </td></tr>
</table>
</body>
</html>`
}

/** 純文字備援版本，給不顯示 HTML 的信箱使用。 */
export function renderEmailText(input: TemplateInput): string {
  const copy = COPY[input.language]
  const greeting = input.recipientName?.trim()
    ? copy.greeting(input.recipientName.trim())
    : copy.fallbackGreeting
  const c = input.contact

  return [
    input.subject,
    formatReleaseDate(input.releaseDate, input.language),
    '',
    greeting,
    '',
    input.bodyText.replace(/^## /gm, '').trim(),
    '',
    '---',
    copy.contactTitle,
    c?.name,
    c?.company,
    c?.email,
    c?.phone,
  ]
    .filter((line) => line)
    .join('\n')
}
