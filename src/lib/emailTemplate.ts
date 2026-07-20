/**
 * 新聞稿 email 樣板。
 *
 * 使用者只輸入純文字，這裡負責套上排版樣式。
 * 這支檔案與 functions/src/emailTemplate.ts 內容相同，
 * 前端用來預覽、Cloud Function 用來實際產生寄出的 HTML，兩邊要一起改。
 */

export interface TemplateInput {
  subject: string
  bodyText: string
  heroImageUrl?: string
  /** 收件人姓名，用於信件開頭稱謂；測試信可留空。 */
  recipientName?: string
  language: 'tw' | 'www' | 'us'
}

const COPY = {
  tw: {
    greeting: (name: string) => `${name} 您好：`,
    fallbackGreeting: '媒體先進 您好：',
    footerTitle: '創見資訊股份有限公司',
    footerNote: '本信件由創見資訊新聞中心發送。',
    contact: '媒體聯絡：press_center@transcend-info.com',
  },
  www: {
    greeting: (name: string) => `Dear ${name},`,
    fallbackGreeting: 'Dear Editor,',
    footerTitle: 'Transcend Information, Inc.',
    footerNote: 'This message was sent by the Transcend Press Center.',
    contact: 'Media contact: press_center@transcend-info.com',
  },
  us: {
    greeting: (name: string) => `Dear ${name},`,
    fallbackGreeting: 'Dear Editor,',
    footerTitle: 'Transcend Information, Inc.',
    footerNote: 'This message was sent by the Transcend Press Center.',
    contact: 'Media contact: press_center@transcend-info.com',
  },
} as const

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 把純文字轉成段落。空行分段，段落內的單行換行轉成 <br>。網址自動變連結。 */
export function textToParagraphs(text: string): string {
  const linkify = (s: string) =>
    s.replace(
      /(https?:\/\/[^\s<]+)/g,
      '<a href="$1" style="color:#1f57c9;text-decoration:underline;">$1</a>',
    )

  return text
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map(
      (block) =>
        `<p style="margin:0 0 16px;font-size:15px;line-height:1.8;color:#2b2f36;">${linkify(
          escapeHtml(block),
        ).replace(/\n/g, '<br>')}</p>`,
    )
    .join('')
}

export function renderEmailHtml(input: TemplateInput): string {
  const copy = COPY[input.language]
  const greeting = input.recipientName?.trim()
    ? copy.greeting(escapeHtml(input.recipientName.trim()))
    : copy.fallbackGreeting

  const hero = input.heroImageUrl
    ? `<tr><td style="padding:0 0 24px;">
         <img src="${input.heroImageUrl}" alt="" width="600"
              style="display:block;width:100%;max-width:600px;height:auto;border:0;border-radius:6px;">
       </td></tr>`
    : ''

  return `<!doctype html>
<html lang="${input.language === 'tw' ? 'zh-Hant' : 'en'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(input.subject)}</title>
</head>
<body style="margin:0;padding:0;background-color:#f4f5f7;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;padding:24px 12px;">
  <tr><td align="center">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0"
           style="width:600px;max-width:100%;background-color:#ffffff;border-radius:8px;overflow:hidden;font-family:'Helvetica Neue',Helvetica,Arial,'Noto Sans TC','Microsoft JhengHei',sans-serif;">

      <tr><td style="background-color:#17439c;padding:20px 32px;">
        <span style="color:#ffffff;font-size:16px;font-weight:600;letter-spacing:0.5px;">TRANSCEND</span>
        <span style="color:#b9d0ff;font-size:12px;margin-left:10px;">PRESS RELEASE</span>
      </td></tr>

      <tr><td style="padding:32px 32px 0;">
        <h1 style="margin:0 0 20px;font-size:22px;line-height:1.45;color:#12161c;font-weight:600;">
          ${escapeHtml(input.subject)}
        </h1>
        <p style="margin:0 0 20px;font-size:15px;line-height:1.8;color:#2b2f36;">${greeting}</p>
      </td></tr>

      <tr><td style="padding:0 32px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          ${hero}
        </table>
      </td></tr>

      <tr><td style="padding:0 32px 8px;">
        ${textToParagraphs(input.bodyText)}
      </td></tr>

      <tr><td style="padding:8px 32px 32px;">
        <div style="border-top:1px solid #e6e8ec;padding-top:20px;">
          <p style="margin:0 0 4px;font-size:13px;font-weight:600;color:#2b2f36;">${copy.footerTitle}</p>
          <p style="margin:0 0 4px;font-size:12px;line-height:1.7;color:#7a8190;">${copy.contact}</p>
          <p style="margin:0;font-size:12px;line-height:1.7;color:#9aa1ad;">${copy.footerNote}</p>
        </div>
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
  return [
    input.subject,
    '',
    greeting,
    '',
    input.bodyText.trim(),
    '',
    '---',
    copy.footerTitle,
    copy.contact,
  ].join('\n')
}
