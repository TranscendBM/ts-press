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
    contactTitle: '新聞聯絡人',
    aboutTitle: '關於創見資訊',
    about:
      '創見資訊於 1989 年在台灣成立，是全球領先的記憶體儲存品牌，產品涵蓋記憶體模組、固態硬碟、外接式硬碟、行車記錄器、密錄器、記憶卡、隨身碟、讀卡機及嵌入式解決方案。除台北總部外，於洛杉磯、漢堡、東京、上海等地設有據點。',
    aboutLink: 'https://tw.transcend-info.com',
    unsubscribe: '若不希望再收到創見的新聞稿，請來信 ',
    unsubscribeSuffix: ' 取消訂閱。',
  },
  www: {
    contactTitle: 'Press Contact',
    aboutTitle: 'About Transcend',
    about:
      'Transcend Information, founded in 1989 in Taiwan, is a globally leading brand in memory storage solutions, offering memory modules, SSDs, external drives, dashcams, body cameras, memory cards, USB drives, card readers, and embedded solutions. Beyond its Taipei headquarters, Transcend has offices in Los Angeles, Hamburg, Tokyo, Shanghai, and more.',
    aboutLink: 'https://www.transcend-info.com',
    unsubscribe: 'To stop receiving press releases from Transcend, please contact ',
    unsubscribeSuffix: '.',
  },
  us: {
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
 * 把純文字切成「一般文字」與「網址」交錯的片段，供 Word / PDF 產生真正的超連結。
 *
 * 只認 http/https 絕對網址。網址尾端常見的標點（句號、逗號、右括號、中文標點）
 * 會被排除在連結外 —— 否則「…/ssd。」的句號會被一起吃進網址而失效。
 */
export function splitLinks(text: string): { text: string; url?: string }[] {
  const re = /(https?:\/\/[^\s<]+)/g
  const out: { text: string; url?: string }[] = []
  let last = 0
  for (const m of text.matchAll(re)) {
    let url = m[0]
    const start = m.index ?? 0
    const trail = url.match(/[).,;:!?、。」』）】]+$/)
    if (trail) url = url.slice(0, url.length - trail[0].length)
    if (start > last) out.push({ text: text.slice(last, start) })
    out.push({ text: url, url })
    last = start + url.length
  }
  if (last < text.length) out.push({ text: text.slice(last) })
  return out
}

/**
 * round 30 新增：內文的「共用」區塊切分邏輯——標題（`## ` 開頭的行）與
 * 段落（其餘文字，空行分段）的判斷從這裡開始，是唯一的權威來源。
 * `renderBlocks()`／`renderBodyHtml()`（本檔案）與
 * `src/lib/exportDoc.ts` 的 Word／PDF 產生邏輯都改呼叫這裡，不再各自
 * 重刻一份幾乎一樣、但容易漂移的切分規則。
 *
 * ⚠️ 修正的根因（round 30 提交前調查）：舊版邏輯是「先用兩個以上換行
 * （`\n{2,}`，也就是空行）切成區塊，再判斷『整個區塊』是不是以 `## `
 * 開頭」——這代表 `## 標題\n下一段內文`（中間只有一個換行、沒有空行）
 * 會被視為『同一個區塊』，而這整個區塊（含標題與下一段的所有文字）都會
 * 被當成標題文字的一部分，不會產生獨立的段落。這裡改成逐行掃描：
 * 只要偵測到一行是 `## ` 開頭（且不在 fenced code block 內），就立刻
 * 把它切成獨立的標題區塊，不管前後有沒有空行，下一行自動從新的段落
 * 開始累積——這樣「標題後緊接著一行內文、中間沒有空行」也能正確拆成
 * 「一個標題 + 一個獨立段落」。
 *
 * 逐行掃描規則：
 * - 空白行（trim 後是空字串）→ 段落之間的分隔，不會產生任何區塊本身，
 *   只是把目前正在累積的段落區塊收尾（沒有累積中的內容就不做任何事，
 *   避免連續空行產生空區塊）。
 * - 開頭是 `## ` 的行（且不在 fenced code block 內）→ 先把目前正在累積
 *   的段落區塊收尾，再單獨產生一個標題區塊（`## ` 之後、trim 過的文字），
 *   不會吃掉下一行。「## 」必須出現在整行的最開頭（`startsWith('## ')`，
 *   跟修正前的判斷條件完全相同），一般句子中間出現的 `##`
 *  （例如「5 ## 3」）不會被誤判成標題。
 * - 以三個反引號（` ``` `）開頭的行 → 切換「是否在 fenced code block
 *   內」的狀態，這一行本身原樣保留在目前段落裡（不特別渲染成程式碼
 *   區塊——這支解析器本來就沒有這個概念，這裡只確保 fenced code block
 *   「裡面」的任何一行，即使剛好以 `## ` 開頭，也不會被誤判成標題）。
 * - 其他任何一行 → 併入目前正在累積的段落（用 `\n` 銜接，讓呼叫端
 *   可以再轉成 `<br>` 或 Word 的換行符號，保留使用者手動按 Enter 的
 *   單行斷行）。
 *
 * 刻意不修改使用者存在 Firestore 的原始 bodyText——這裡回傳的是解析後的
 * 結構化區塊陣列，不是就地改寫字串本身，符合「不做非必要 normalization」
 * 的原則（見 round 30 的完整討論）。
 *
 * 提交前審查追加說明——未閉合 fenced code block 的語意（刻意行為，不是
 * bug）：一行 ``` 開頭的行會切換 inFence 狀態；如果內文到結尾都沒有再出現
 * 對應的收尾 ``` ，inFence 會一路維持 true 直到掃描結束，中間所有行
 * （包含看起來像標題的 `## ` 開頭的行）都會被當成程式碼內容的一部分，
 * 不會被判斷成獨立段落或標題。這是照著 Markdown 慣例走的：未閉合的
 * fenced code block 視為一路延伸到檔案結尾，不會有「自動補上收尾、後面
 * 的內容恢復成一般 Markdown」這種行為，也不會嘗試用其他規則猜測使用者
 * 是不是忘了打收尾 ``` 。之所以在這裡明講，是因為這是加入 fence 感知
 * 之後才出現的全新邊界情況（round 30 之前的版本完全沒有 fence 概念，
 * 不存在「fence 沒收尾」這種狀態），必須明確記錄下來、避免日後被誤認為
 * 需要修的 bug 而改掉。
 *
 * 支援範圍的判斷：只認得行首三個反引號（` ``` `，可帶語言標籤，例如
 * ` ```ts `）；不支援 ` ~~~ ` fence、不支援用縮排 4 個空白代表程式碼
 * 區塊。這不是遺漏，是刻意維持的範圍——全專案（email／Word／PDF／前端
 * 預覽）目前沒有任何一個輸出端曾經支援過完整 CommonMark 的 fence 語法
 * （搜尋整個 repo 找不到任何處理 `~~~` 的程式碼），round 30 之前也完全
 * 沒有 fence 的概念，所以這裡沒有「要跟既有行為對齊」的相容性負擔，只
 * 需要滿足「行首 ``` 判定為 code fence」這個單一規則就好，沒有必要為了
 * 假設性的未來需求擴大解析範圍。
 */
export type MarkdownBlock = { type: 'heading'; text: string } | { type: 'paragraph'; text: string }

export function splitMarkdownBlocks(text: string): MarkdownBlock[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const blocks: MarkdownBlock[] = []
  let paragraphLines: string[] = []
  let inFence = false

  function flushParagraph() {
    if (paragraphLines.length === 0) return
    const joined = paragraphLines.join('\n').trim()
    if (joined) blocks.push({ type: 'paragraph', text: joined })
    paragraphLines = []
  }

  for (const rawLine of lines) {
    if (rawLine.startsWith('```')) {
      inFence = !inFence
      paragraphLines.push(rawLine)
      continue
    }
    if (inFence) {
      paragraphLines.push(rawLine)
      continue
    }
    if (rawLine.trim() === '') {
      flushParagraph()
      continue
    }
    if (rawLine.startsWith('## ')) {
      flushParagraph()
      blocks.push({ type: 'heading', text: rawLine.slice(3).trim() })
      continue
    }
    paragraphLines.push(rawLine)
  }
  flushParagraph()

  return blocks
}

/**
 * 把純文字切成區塊。空行分段；以 `## ` 開頭的行視為小標題（見上方
 * splitMarkdownBlocks() 的完整說明——這裡只負責把區塊轉成信件用的
 * HTML，不重複切分邏輯）。
 * 回傳陣列而非字串，方便呼叫端把圖片插在第一段之後。
 */
export function renderBlocks(text: string, font: string): string[] {
  return splitMarkdownBlocks(text).map((block) =>
    block.type === 'heading'
      ? `<h2 style="margin:28px 0 12px;font-size:16px;line-height:1.5;font-weight:600;color:${BRAND_COLOR};font-family:${font};">${escapeHtml(
          block.text,
        )}</h2>`
      : `<p style="margin:0 0 16px;font-size:16px;line-height:1.8;color:#2b2f36;font-family:${font};">${linkify(
          escapeHtml(block.text),
        ).replace(/\n/g, '<br>')}</p>`,
  )
}

/** 把一段純文字轉成乾淨的行內 HTML：跳脫文字、網址包成不含樣式的 <a>。 */
function bodyInlineHtml(text: string): string {
  return splitLinks(text)
    .map((seg) => {
      const safe = escapeHtml(seg.text)
      if (!seg.url) return safe
      const href = safeUrl(seg.url)
      return href ? `<a href="${href}">${safe}</a>` : safe
    })
    .join('')
    .replace(/\n/g, '<br>')
}

/**
 * 把新聞稿內文轉成「乾淨、無行內樣式」的語意 HTML，供貼進外部 CMS 後台。
 *
 * 段落 → <p>；以「## 」開頭的行 → <h4>；網址 → <a>。
 * 刻意不加任何 style（跟寄信用的 renderBlocks 不同）—— CMS 有自己的樣式，
 * 帶樣式進去反而會打架。
 */
export function renderBodyHtml(bodyText: string): string {
  return splitMarkdownBlocks(bodyText)
    .map((block) =>
      block.type === 'heading' ? `<h4>${escapeHtml(block.text)}</h4>` : `<p>${bodyInlineHtml(block.text)}</p>`,
    )
    .join('\n')
}

export function renderEmailHtml(input: TemplateInput): string {
  const copy = COPY[input.language]
  const font = input.language === 'tw' ? FONT_TW : FONT_EN

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

      <!-- 內文 -->
      <tr><td style="padding:24px 32px 0;">${body}</td></tr>

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
  const c = input.contact

  return [
    input.subject,
    formatReleaseDate(input.releaseDate, input.language),
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
