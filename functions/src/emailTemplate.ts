/**
 * 新聞稿 email 樣板。
 *
 * 版型沿用行銷部既有的 PR 範本：800px 表格、#960014 品牌色、
 * 開頭段落與 260px 圖片並排、頁尾放新聞聯絡人與公司簡介。
 *
 * 使用者只輸入純文字，這裡負責套上排版樣式。內文支援一種標記：
 * 以 `## ` 開頭的行會變成小標題（對應原範本的 h2）。
 *
 * ⚠️ 這支檔案與 functions/src/emailTemplate.ts 內容相同，
 * 前端用來預覽、Cloud Function 用來實際產生寄出的 HTML，兩邊要一起改。
 *
 * ⚠️ 排版一律用表格，不要用 CSS float / flex / grid ——
 * Outlook 桌面版使用 Word 排版引擎，那些都不支援。
 */

export const BRAND_COLOR = '#960014'

export interface PressContact {
  name: string
  company: string
  email: string
  phone: string
}

export interface TemplateInput {
  subject: string
  bodyText: string
  /** 內文右側的圖片，建議寬 260px。 */
  heroImageUrl?: string
  /** 收件人姓名，用於信件開頭稱謂；留空則用通用稱謂。 */
  recipientName?: string
  language: 'tw' | 'www' | 'us'
  /** 新聞稿發佈日期，格式 yyyy-mm-dd。 */
  releaseDate?: string
  /** 頁首 logo，建議透明背景 PNG。 */
  logoUrl?: string
  /** 該語言版本的新聞聯絡人。 */
  contact?: PressContact
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
    aboutTitle: '創見資訊簡介',
    about:
      '創見資訊於1989年在台灣成立，是全球領先的記憶體儲存品牌，致力於提供多元、高品質的產品，涵蓋記憶體模組、內接式固態硬碟、行動固態硬碟、外接式硬碟、行車記錄器、密錄器、記憶卡、隨身碟、讀卡機及嵌入式解決方案。除台北總部外，創見於洛杉磯、馬里蘭、漢堡、鹿特丹、倫敦、東京、首爾、上海、北京、深圳與香港等地設有據點。以持續創新與自我超越為核心價值，創見透過專業研發與優質服務，滿足高科技市場多變的需求，與消費者共同創造更美好的數位生活。',
    aboutLink: 'https://tw.transcend-info.com',
    unsubscribe:
      '感謝您一直以來對創見的支持，並同意接收創見發送的新聞稿電子訊息。若您希望停止接收此訊息，敬請聯絡 ',
    unsubscribeSuffix: ' 取消訂閱。',
  },
  www: {
    greeting: (name: string) => `Dear ${name},`,
    fallbackGreeting: 'Dear Editor,',
    contactTitle: 'Press Contact',
    aboutTitle: 'About Transcend',
    about:
      'Transcend Information, founded in 1989 in Taiwan, is a globally leading brand in memory storage solutions. Transcend offers a diverse range of high-quality products, including memory modules, internal SSDs, portable SSDs, external hard drives, dashcams, body cameras, memory cards, USB flash drives, card readers, and embedded solutions. In addition to its headquarters in Taipei, Transcend has offices in Los Angeles, Maryland, Hamburg, Rotterdam, London, Tokyo, Seoul, Shanghai, Beijing, Shenzhen, and Hong Kong. Guided by continuous innovation and a commitment to self-transcendence, Transcend leverages professional research and development alongside quality services to meet the ever-evolving demands of the high-tech market, striving to enhance everyday digital life.',
    aboutLink: 'https://www.transcend-info.com',
    unsubscribe:
      'This email has been sent as you have previously consented to receive updates and information from Transcend. If you would now like to stop receiving these updates or information, please contact ',
    unsubscribeSuffix: ' to unsubscribe.',
  },
  us: {
    greeting: (name: string) => `Dear ${name},`,
    fallbackGreeting: 'Dear Editor,',
    contactTitle: 'Press Contact',
    aboutTitle: 'About Transcend',
    about:
      'Transcend Information, founded in 1989 in Taiwan, is a globally leading brand in memory storage solutions. Transcend offers a diverse range of high-quality products, including memory modules, internal SSDs, portable SSDs, external hard drives, dashcams, body cameras, memory cards, USB flash drives, card readers, and embedded solutions. In addition to its headquarters in Taipei, Transcend has offices in Los Angeles, Maryland, Hamburg, Rotterdam, London, Tokyo, Seoul, Shanghai, Beijing, Shenzhen, and Hong Kong. Guided by continuous innovation and a commitment to self-transcendence, Transcend leverages professional research and development alongside quality services to meet the ever-evolving demands of the high-tech market, striving to enhance everyday digital life.',
    aboutLink: 'https://www.transcend-info.com',
    unsubscribe:
      'This email has been sent as you have previously consented to receive updates and information from Transcend. If you would now like to stop receiving these updates or information, please contact ',
    unsubscribeSuffix: ' to unsubscribe.',
  },
} as const

const FONT_TW =
  "'Microsoft JhengHei', 微軟正黑體, Arial, 'Helvetica Neue', Helvetica, sans-serif"
const FONT_EN = "Arial, 'Helvetica Neue', Helvetica, sans-serif"

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
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
  if (language === 'tw') return `新聞發佈：${y}年${month}月${day}日`
  return `${MONTHS_EN[month - 1]} ${day}, ${y}`
}

const linkify = (s: string) =>
  s.replace(
    /(https?:\/\/[^\s<]+)/g,
    `<a href="$1" style="color:${BRAND_COLOR};text-decoration:underline;">$1</a>`,
  )

function paragraph(block: string, font: string): string {
  return `<p style="margin:0 0 24px;font-size:12pt;line-height:1.5em;color:#222;font-family:${font};text-align:left;">${linkify(
    escapeHtml(block),
  ).replace(/\n/g, '<br>')}</p>`
}

function heading(text: string, font: string): string {
  return `<h2 style="margin:0 0 12px;font-size:13.5pt;line-height:1.4;color:#222;font-family:${font};">${escapeHtml(
    text,
  )}</h2>`
}

/**
 * 把純文字切成區塊。空行分段；以 `## ` 開頭的行視為小標題。
 * 回傳已渲染的 HTML 陣列，方便呼叫端把第一段獨立拉出來與圖片並排。
 */
export function renderBlocks(text: string, font: string): string[] {
  return text
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean)
    .map((block) =>
      block.startsWith('## ')
        ? heading(block.slice(3).trim(), font)
        : paragraph(block, font),
    )
}

export function renderEmailHtml(input: TemplateInput): string {
  const copy = COPY[input.language]
  const font = input.language === 'tw' ? FONT_TW : FONT_EN
  const greeting = input.recipientName?.trim()
    ? copy.greeting(escapeHtml(input.recipientName.trim()))
    : copy.fallbackGreeting

  const blocks = renderBlocks(input.bodyText, font)
  const [firstBlock, ...restBlocks] = blocks
  const dateLine = formatReleaseDate(input.releaseDate, input.language)

  // 開頭段落與圖片並排。用兩欄表格而非 CSS float —— Outlook 不支援 float。
  const intro = input.heroImageUrl
    ? `<tr>
         <td width="520" valign="top" style="padding-right:20px;">
           ${dateLine ? dateRow(dateLine, font) : ''}
           ${firstBlock ?? ''}
         </td>
         <td width="260" valign="top" align="center">
           <img src="${input.heroImageUrl}" alt="" width="260"
                style="display:block;width:260px;max-width:260px;height:auto;border:0;">
         </td>
       </tr>`
    : `<tr><td colspan="2" valign="top">
         ${dateLine ? dateRow(dateLine, font) : ''}
         ${firstBlock ?? ''}
       </td></tr>`

  const contact = input.contact
  const contactBlock = contact?.name
    ? `<tr>
        <td style="padding:30px 0;border-top:1px solid #999;border-bottom:1px solid #999;">
          <h3 style="margin:0 0 16px;font-size:13.5pt;color:${BRAND_COLOR};font-family:${font};">${escapeHtml(
            copy.contactTitle,
          )}</h3>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr>
              <td width="240" valign="top" style="font-size:12pt;line-height:1.5em;color:#222;font-family:${font};">
                ${escapeHtml(contact.name)}${
                  contact.company ? `<br>${escapeHtml(contact.company)}` : ''
                }
              </td>
              <td valign="top" style="font-size:12pt;line-height:1.5em;color:#222;font-family:${font};">
                ${
                  contact.email
                    ? `<a href="mailto:${escapeHtml(contact.email)}" style="color:${BRAND_COLOR};">${escapeHtml(
                        contact.email,
                      )}</a><br>`
                    : ''
                }
                ${contact.phone ? escapeHtml(contact.phone) : ''}
              </td>
            </tr>
          </table>
        </td>
      </tr>`
    : ''

  const unsubscribeEmail = contact?.email || 'pr@transcend-info.com'

  return `<!doctype html>
<html lang="${input.language === 'tw' ? 'zh-Hant' : 'en'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(input.subject)}</title>
</head>
<body style="margin:0;padding:0;background-color:#ffffff;">
<table role="presentation" width="800" border="0" align="center" cellpadding="0" cellspacing="0"
       style="width:800px;max-width:100%;margin:0 auto;font-family:${font};">
  <tbody>

    <!-- 頁首：品牌色底 + logo -->
    <tr>
      <td style="background-color:${BRAND_COLOR};padding:18px 30px;" height="75">
        ${
          input.logoUrl
            ? `<img src="${input.logoUrl}" alt="TRANSCEND" height="32"
                    style="display:block;height:32px;width:auto;border:0;">`
            : `<span style="color:#ffffff;font-size:20px;font-weight:bold;letter-spacing:1px;font-family:${FONT_EN};">TRANSCEND</span>`
        }
      </td>
    </tr>

    <!-- 標題 -->
    <tr>
      <td align="center" style="padding:0 30px;">
        <h1 style="margin:30px auto;font-size:${
          input.language === 'tw' ? '21pt' : '18pt'
        };line-height:1.35;text-align:center;color:#222;font-family:${font};">
          ${escapeHtml(input.subject)}
        </h1>
      </td>
    </tr>

    <!-- 稱謂 -->
    <tr>
      <td style="padding:0 30px;">
        <p style="margin:0 0 20px;font-size:12pt;line-height:1.5em;color:#222;font-family:${font};">${greeting}</p>
      </td>
    </tr>

    <!-- 開頭段落 + 圖片 -->
    <tr>
      <td style="padding:0 30px;">
        <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0">
          <tbody>${intro}</tbody>
        </table>
      </td>
    </tr>

    <!-- 其餘內文 -->
    <tr>
      <td style="padding:0 30px;">${restBlocks.join('')}</td>
    </tr>

    <!-- 新聞聯絡人 -->
    <tr>
      <td style="padding:0 30px;">
        <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0">
          <tbody>${contactBlock}</tbody>
        </table>
      </td>
    </tr>

    <!-- 公司簡介 -->
    <tr>
      <td style="padding:30px;">
        <h3 style="margin:0 0 16px;font-size:13.5pt;color:${BRAND_COLOR};font-family:${font};">${escapeHtml(
          copy.aboutTitle,
        )}</h3>
        <p style="margin:0;font-size:13px;line-height:1.6em;color:#444;text-align:justify;font-family:${font};">
          ${escapeHtml(copy.about)}
          <a href="${copy.aboutLink}" style="color:${BRAND_COLOR};">${copy.aboutLink}</a>
        </p>
      </td>
    </tr>

    <!-- 版權列 -->
    <tr>
      <td style="padding:6px 30px;background-color:${BRAND_COLOR};color:#ffffff;font-size:10px;font-family:${FONT_EN};">
        &copy; Transcend Information, Inc. All Rights Reserved.
      </td>
    </tr>

    <!-- 退訂說明 -->
    <tr>
      <td style="padding:20px 30px 30px;">
        <p style="margin:0;color:#999;font-size:9.5pt;line-height:1.2em;font-family:${font};">
          ${escapeHtml(copy.unsubscribe)}<a href="mailto:${escapeHtml(
            unsubscribeEmail,
          )}" style="color:#999;">${escapeHtml(unsubscribeEmail)}</a>${escapeHtml(
            copy.unsubscribeSuffix,
          )}
        </p>
      </td>
    </tr>

  </tbody>
</table>
</body>
</html>`
}

function dateRow(dateLine: string, font: string): string {
  return `<p style="margin:0 0 16px;font-size:9pt;color:#666;font-family:${font};">${escapeHtml(
    dateLine,
  )}</p>`
}

/** 純文字備援版本，給不顯示 HTML 的信箱使用。 */
export function renderEmailText(input: TemplateInput): string {
  const copy = COPY[input.language]
  const greeting = input.recipientName?.trim()
    ? copy.greeting(input.recipientName.trim())
    : copy.fallbackGreeting
  const dateLine = formatReleaseDate(input.releaseDate, input.language)
  const c = input.contact

  return [
    input.subject,
    dateLine,
    '',
    greeting,
    '',
    input.bodyText.replace(/^## /gm, '').trim(),
    '',
    '---',
    copy.contactTitle,
    c?.name ?? '',
    c?.company ?? '',
    c?.email ?? '',
    c?.phone ?? '',
  ]
    .filter((line) => line !== undefined)
    .join('\n')
}
