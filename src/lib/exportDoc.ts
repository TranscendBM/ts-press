import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  Footer,
  Header,
  HeadingLevel,
  ImageRun,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  Tab,
  TabStopType,
  TextRun,
  WidthType,
} from 'docx'
import {
  BRAND_COLOR,
  DEFAULT_ABOUT,
  escapeHtml,
  formatReleaseDate,
  safeUrl,
  splitLinks,
  splitMarkdownBlocks,
  type TemplateInput,
} from '../../shared/emailTemplate'
import {
  readImageInfo,
  scaleToWidth,
  type ImageInfo,
} from '../../shared/imageSize'

/**
 * 新聞稿的下載功能。
 *
 * Word：產生真正的 .docx。先前試過「HTML 存成 .doc」的老做法，
 * 但 macOS 版 Word 會驗證副檔名與內容是否相符而拒絕開啟。
 *
 * PDF：開一個乾淨的列印頁面並叫出列印對話框，由使用者選「儲存為 PDF」。
 * 瀏覽器自己的排版引擎對中文字型的處理遠優於前端 PDF 套件。
 */

const BRAND_HEX = BRAND_COLOR.replace('#', '')

/**
 * Word / PDF 用的深色（紅色）logo。
 * 信件是紅底所以用白色版，但文件是白底，必須換成紅色版才看得見。
 */
const DOC_LOGO = new URL('/logo-dark.png', window.location.origin).href

/**
 * logo 與頁首底線之間的距離（點）。
 *
 * OOXML 的框線間距是從「文字基線」量起，而內嵌圖片會超出基線之下，
 * 所以這個值要比實際想要的間距再大一些才夠。
 */
const BORDER_SPACE_PT = 18

/**
 * 頁首額外增加的高度（0.5cm）。
 * docx 的行距單位是 twip（1/20 點）：0.5 ÷ 2.54 × 72 × 20 ≒ 283。
 * 這段空白加在底線之下、仍屬頁首範圍，同時把頁面上邊界一起加大，
 * 否則內文起始位置不變、頁首長高後會壓到正文。
 */
const HEADER_EXTRA_TWIPS = 283

/**
 * 版面尺寸（twip）。刻意寫死 A4 而不用套件預設 ——
 * 右靠定位點要算得準就必須知道實際的可用寬度，
 * 用 TabStopPosition.MAX（9026）會短少約 880 twip 而切不齊右邊界。
 */
const PAGE_WIDTH = 11906
const PAGE_HEIGHT = 16838
const MARGIN_X = 1000
/** 內容區寬度，也就是右邊界的位置。 */
const RIGHT_EDGE = PAGE_WIDTH - MARGIN_X * 2

/** 字級（docx 的 size 單位是半點，所以是點數 × 2）。 */
const SIZE_TITLE = 36 // 18pt
const SIZE_BODY = 24 // 12pt
const SIZE_HEADER_LABEL = 20 // 10pt

/** 頁首 logo 寬度（點）。原本 120，依需求放大 1.15 倍。 */
const LOGO_WIDTH = Math.round(120 * 1.15)

/**
 * 中文用微軟正黑體、英文用 Arial。
 * Word 是靠 eastAsia 與 ascii 兩個屬性分別指定中西文字型，
 * 只給一個字串會讓中文也套用 Arial 而變成系統替代字型。
 */
const FONTS = {
  ascii: 'Arial',
  hAnsi: 'Arial',
  eastAsia: '微軟正黑體',
  cs: 'Arial',
}

function saveBlob(blob: Blob, filename: string) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = filename
  a.click()
  URL.revokeObjectURL(a.href)
}

interface LoadedImage {
  data: ArrayBuffer
  info: ImageInfo
}

/**
 * 抓圖片並解析尺寸。
 *
 * 尺寸完全從檔頭位元組解析，不用 createImageBitmap / img.decode() ——
 * 那兩者在部分瀏覽器會靜默失敗或永不 resolve，前者讓 Word 少掉所有圖片、
 * 後者直接讓匯出整個卡住。另加逾時保護，網路異常時最多略過圖片而非中斷。
 */
async function loadImage(url: string): Promise<LoadedImage | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) })
    if (!res.ok) return null
    const data = await res.arrayBuffer()
    const info = readImageInfo(data)
    return info ? { data, info } : null
  } catch {
    return null
  }
}

/** 把一行文字拆成一般文字與可點網址，網址輸出成真正的超連結。 */
function bodyRuns(line: string): (TextRun | ExternalHyperlink)[] {
  return splitLinks(line).map((seg) =>
    seg.url
      ? new ExternalHyperlink({
          link: seg.url,
          children: [
            new TextRun({
              text: seg.text,
              size: SIZE_BODY,
              font: FONTS,
              color: BRAND_HEX,
              underline: {},
            }),
          ],
        })
      : new TextRun({ text: seg.text, size: SIZE_BODY, font: FONTS }),
  )
}

/** round 34 新增：表格儲存格統一用這組髮絲線邊框，呼應信件/PDF 的 `#E6E8EC`。 */
const TABLE_CELL_BORDER = { style: BorderStyle.SINGLE, size: 4, color: 'E6E8EC' }
const TABLE_CELL_BORDERS = {
  top: TABLE_CELL_BORDER,
  bottom: TABLE_CELL_BORDER,
  left: TABLE_CELL_BORDER,
  right: TABLE_CELL_BORDER,
}

/**
 * round 34 新增：把一個 table 區塊（見 shared/emailTemplate.ts 的
 * splitMarkdownBlocks()）轉成 docx 的 Table——第一列固定當表頭（品牌色
 * 底、白字），呼應信件/PDF 的表格樣式，欄寬平均分配。
 */
function renderTableDocx(rows: string[][]): Table {
  const [header, ...body] = rows
  const columnCount = header?.length ?? 1
  const columnWidth = Math.floor(100 / Math.max(columnCount, 1))

  function cell(text: string, isHeader: boolean): TableCell {
    return new TableCell({
      children: [
        new Paragraph({
          children: [
            new TextRun({
              text,
              size: SIZE_HEADER_LABEL,
              font: FONTS,
              bold: isHeader,
              color: isHeader ? 'FFFFFF' : '2B2F36',
            }),
          ],
        }),
      ],
      shading: isHeader ? { fill: BRAND_HEX } : undefined,
      borders: TABLE_CELL_BORDERS,
      width: { size: columnWidth, type: WidthType.PERCENTAGE },
    })
  }

  const headerRow = new TableRow({
    children: (header ?? []).map((text) => cell(text, true)),
  })
  const bodyRows = body.map(
    (row) => new TableRow({ children: row.map((text) => cell(text, false)) }),
  )

  return new Table({
    rows: [headerRow, ...bodyRows],
    width: { size: 100, type: WidthType.PERCENTAGE },
  })
}

function textParagraph(text: string, opts: { spacing?: number } = {}) {
  // 段落內的單行斷行（使用者按 Enter 但沒空行）也要保留 ——
  // 網頁與 PDF 是把 \n 轉成 <br>，Word 則用一個空的 break TextRun 換行，
  // 否則同段落的多行會全部黏成一行。網址則拆出來變成超連結。
  const lines = text.split(/\r?\n/)
  const children: (TextRun | ExternalHyperlink)[] = []
  lines.forEach((line, i) => {
    if (i > 0) children.push(new TextRun({ break: 1 }))
    children.push(...bodyRuns(line))
  })
  return new Paragraph({
    spacing: { after: opts.spacing ?? 200, line: 300 },
    children,
  })
}

export async function downloadWord(input: TemplateInput, filename: string) {
  const children: (Paragraph | Table)[] = []

  // 標題。主旨可含手動斷行（使用者在輸入框按 Enter），每段一個 TextRun，
  // 第二段起用 break 換行，讓 Word 呈現多行標題。
  children.push(
    new Paragraph({
      heading: HeadingLevel.HEADING_1,
      alignment: AlignmentType.CENTER,
      spacing: { after: 120 },
      children: input.subject.split(/\r?\n/).map(
        (line, i) =>
          new TextRun({
            text: line,
            break: i > 0 ? 1 : undefined,
            bold: true,
            size: SIZE_TITLE,
            font: FONTS,
            color: '12161C',
          }),
      ),
    }),
  )

  // 發佈日期
  const dateLine = formatReleaseDate(input.releaseDate, input.language)
  if (dateLine) {
    children.push(
      new Paragraph({
        spacing: { after: 320 },
        border: {
          bottom: { style: BorderStyle.SINGLE, size: 6, color: 'E6E8EC' },
        },
        children: [
          new TextRun({
            text: dateLine,
            size: 20,
            color: '8A919E',
            font: FONTS,
          }),
        ],
      }),
    )
  }

  // 內文區塊切分（標題／段落）跟信件、CMS HTML 共用同一套邏輯，見
  // shared/emailTemplate.ts 的 splitMarkdownBlocks() 說明——不在這裡
  // 重刻一份會漂移的規則。
  const blocks = splitMarkdownBlocks(input.bodyText)

  const image = input.heroImageUrl ? await loadImage(input.heroImageUrl) : null

  blocks.forEach((block, idx) => {
    if (block.type === 'heading') {
      children.push(
        new Paragraph({
          spacing: { before: 320, after: 160 },
          children: [
            new TextRun({
              text: block.text,
              bold: true,
              size: 26,
              color: BRAND_HEX,
              font: FONTS,
            }),
          ],
        }),
      )
    } else if (block.type === 'table') {
      children.push(renderTableDocx(block.rows))
      // Word 表格後面沒有段落間距的概念，補一個空段落，避免表格跟下一個
      // 區塊黏在一起。
      children.push(new Paragraph({ spacing: { after: 160 }, children: [] }))
    } else {
      children.push(textParagraph(block.text))
    }

    // 圖片放在導言之後，與信件版面一致
    if (idx === 0 && image) {
      children.push(
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { before: 120, after: 320 },
          children: [
            new ImageRun({
              type: image.info.format,
              data: image.data,
              transformation: scaleToWidth(image.info, 260),
            }),
          ],
        }),
      )
    }
  })

  // 新聞聯絡人
  const c = input.contact
  if (c?.name) {
    children.push(
      new Paragraph({
        spacing: { before: 480, after: 120 },
        border: {
          top: { style: BorderStyle.SINGLE, size: 6, color: 'E6E8EC' },
        },
        children: [
          new TextRun({
            text: input.language === 'tw' ? '新聞聯絡人' : 'Press Contact',
            bold: true,
            size: 22,
            color: BRAND_HEX,
            font: FONTS,
          }),
        ],
      }),
    )
    const lines = [
      [c.name, c.company].filter(Boolean).join(' · '),
      c.email,
      c.phone,
    ].filter(Boolean)
    for (const line of lines) {
      const isEmail = !!c.email && line === c.email
      children.push(
        new Paragraph({
          spacing: { after: 60 },
          children: [
            isEmail
              ? new ExternalHyperlink({
                  link: `mailto:${c.email}`,
                  children: [
                    new TextRun({
                      text: line,
                      size: 20,
                      color: BRAND_HEX,
                      underline: {},
                      font: FONTS,
                    }),
                  ],
                })
              : new TextRun({ text: line, size: 20, color: '4A505C', font: FONTS }),
          ],
        }),
      )
    }
  }

  // 公司簡介
  const about = input.about?.trim() || DEFAULT_ABOUT[input.language].text
  const aboutLink = input.aboutLink?.trim() || DEFAULT_ABOUT[input.language].link
  children.push(
    new Paragraph({
      spacing: { before: 480, after: 100 },
      children: [
        new TextRun({
          text: input.language === 'tw' ? '關於創見資訊' : 'About Transcend',
          bold: true,
          size: 20,
          color: '4A505C',
          font: FONTS,
        }),
      ],
    }),
    new Paragraph({
      spacing: { line: 280 },
      children: [
        new TextRun({ text: `${about} `, size: 18, color: '8A919E', font: FONTS }),
        new ExternalHyperlink({
          link: aboutLink,
          children: [
            new TextRun({
              text: aboutLink,
              size: 18,
              color: BRAND_HEX,
              underline: {},
              font: FONTS,
            }),
          ],
        }),
      ],
    }),
  )

  // 頁首：白底 + 紅色 logo。
  // 不用品牌色底 —— 轉存 PDF 時瀏覽器預設不列印背景色，
  // 白色 logo 會直接融進白底而看不見。紅色 logo 配白底則兩者都正常。
  const logo = await loadImage(DOC_LOGO)
  const headerLabel = input.language === 'tw' ? '新聞稿' : 'Press Release'
  const headerChildren = [
    new Paragraph({
      spacing: { before: 40, after: HEADER_EXTRA_TWIPS },
      border: {
        bottom: {
          style: BorderStyle.SINGLE,
          size: 12,
          color: BRAND_HEX,
          // docx 的框線間距單位是點：0.3cm ≒ 8.5pt
          space: BORDER_SPACE_PT,
        },
      },
      // 靠右的定位點讓「新聞稿」與 logo 排在同一行的兩端
      tabStops: [{ type: TabStopType.RIGHT, position: RIGHT_EDGE }],
      children: [
        logo
          ? new ImageRun({
              type: logo.info.format,
              data: logo.data,
              transformation: scaleToWidth(logo.info, LOGO_WIDTH),
            })
          : new TextRun({
              text: 'TRANSCEND',
              bold: true,
              color: BRAND_HEX,
              size: 24,
              font: FONTS,
            }),
        new TextRun({
          children: [new Tab(), headerLabel],
          color: '8A919E',
          size: SIZE_HEADER_LABEL,
          font: FONTS,
        }),
      ],
    }),
  ]

  const doc = new Document({
    creator: 'Transcend Press Center',
    title: input.subject,
    sections: [
      {
        properties: {
          page: {
            size: { width: PAGE_WIDTH, height: PAGE_HEIGHT },
            // 上邊界跟著頁首一起加高，內文才不會被壓到
            margin: {
              top: 1200 + HEADER_EXTRA_TWIPS,
              bottom: 1200,
              left: MARGIN_X,
              right: MARGIN_X,
            },
          },
        },
        headers: { default: new Header({ children: headerChildren }) },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                spacing: { before: 80 },
                border: {
                  top: { style: BorderStyle.SINGLE, size: 6, color: BRAND_HEX },
                },
                children: [
                  new TextRun({
                    text: '© Transcend Information, Inc. All Rights Reserved.',
                    color: '8A919E',
                    size: 15,
                    font: FONTS,
                  }),
                ],
              }),
            ],
          }),
        },
        children,
      },
    ],
  })

  saveBlob(await Packer.toBlob(doc), `${filename}.docx`)
}

/**
 * round 34 新增：下載一份「匯入用」Word 範本，示範標題／小標題／表格要
 * 怎麼打才能被 src/lib/wordImport.ts 的 parseWordDocument() 正確辨識。
 *
 * 刻意不重用 downloadWord() 的內文小標題樣式——那裡只是手動加粗上色的一
 * 般段落，不是 Word 真正的段落樣式，mammoth 只能可靠辨識段落樣式（標題
 * 1／標題 2），辨識不了「剛好是粗體＋某個顏色」這種純視覺特徵。這裡改用
 * 真正的 HeadingLevel.HEADING_1／HEADING_2，讓範本的段落樣式跟匯入端的
 * 辨識規則對得上。
 */
export async function downloadWordTemplate(language: TemplateInput['language']) {
  const isTw = language === 'tw'

  const instructions = isTw
    ? [
        '這是「匯入 Word」功能的格式範本，請直接在這份文件裡修改內容，存檔後用編輯頁的「匯入 Word」按鈕上傳。',
        '規則：文件裡第一個「標題 1」或「標題 2」樣式的段落會變成新聞稿標題，之後的「標題 1」或「標題 2」樣式段落都會變成內文小標題。',
        '一般段落請用 Word 的「內文」樣式，不要套用任何標題樣式。',
        '表格請用 Word 的「插入 > 表格」建立，匯入時會自動轉換成內文裡的表格；請勿合併儲存格。',
        '目前不支援匯入圖片，請先匯入文字，再用編輯頁的「上傳圖片」補上首圖。',
      ]
    : [
        'This is the format template for the "Import Word" feature. Edit this document directly, save it, then upload it with the "Import Word" button on the edit page.',
        'Rule: the first paragraph styled "Heading 1" or "Heading 2" becomes the press release title; any later "Heading 1" or "Heading 2" paragraph becomes a sub-heading in the body.',
        'Use the "Normal" style for regular paragraphs — do not apply any heading style.',
        'Build tables with Word\'s Insert > Table; they will be converted automatically. Do not merge cells.',
        'Images are not supported yet — import the text first, then add a hero image separately on the edit page.',
      ]

  const children: (Paragraph | Table)[] = []

  for (const line of instructions) {
    children.push(
      new Paragraph({
        spacing: { after: 120 },
        children: [
          new TextRun({ text: line, size: 18, italics: true, color: '8A919E', font: FONTS }),
        ],
      }),
    )
  }

  children.push(
    new Paragraph({
      spacing: { before: 200, after: 320 },
      border: { top: { style: BorderStyle.SINGLE, size: 6, color: 'E6E8EC' } },
      children: [],
    }),
  )

  children.push(
    new Paragraph({
      heading: HeadingLevel.HEADING_1,
      alignment: AlignmentType.CENTER,
      spacing: { after: 240 },
      children: [
        new TextRun({
          text: isTw ? '＜在這裡輸入新聞稿標題＞' : '<Enter the press release title here>',
          bold: true,
          size: SIZE_TITLE,
          font: FONTS,
          color: '12161C',
        }),
      ],
    }),
  )

  children.push(
    textParagraph(
      isTw
        ? '這是一般段落，直接打字即可，不需要套用任何標題樣式。段落之間請按 Enter 空一行分隔。'
        : 'This is a regular paragraph — just type normally, no heading style needed. Leave a blank line between paragraphs.',
    ),
  )

  children.push(
    new Paragraph({
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 240, after: 160 },
      children: [
        new TextRun({
          text: isTw ? '＜小標題範例＞' : '<Sub-heading example>',
          bold: true,
          size: 26,
          color: BRAND_HEX,
          font: FONTS,
        }),
      ],
    }),
  )

  children.push(
    textParagraph(
      isTw
        ? '小標題底下接一般段落，一樣不需要套用標題樣式。'
        : 'A sub-heading is followed by regular paragraphs, again without any heading style.',
    ),
  )

  children.push(
    new Paragraph({
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 240, after: 160 },
      children: [
        new TextRun({
          text: isTw ? '＜表格範例＞' : '<Table example>',
          bold: true,
          size: 26,
          color: BRAND_HEX,
          font: FONTS,
        }),
      ],
    }),
  )

  children.push(
    renderTableDocx([
      isTw ? ['項目', 'Q1', 'Q2'] : ['Item', 'Q1', 'Q2'],
      isTw ? ['營收（百萬元）', '100', '120'] : ['Revenue (M)', '100', '120'],
      isTw ? ['年增率', '5%', '8%'] : ['YoY growth', '5%', '8%'],
    ]),
  )
  children.push(new Paragraph({ spacing: { after: 160 }, children: [] }))

  const doc = new Document({
    creator: 'Transcend Press Center',
    title: isTw ? '新聞稿匯入範本' : 'Press release import template',
    sections: [
      {
        properties: {
          page: {
            size: { width: PAGE_WIDTH, height: PAGE_HEIGHT },
            margin: { top: 1200, bottom: 1200, left: MARGIN_X, right: MARGIN_X },
          },
        },
        children,
      },
    ],
  })

  saveBlob(
    await Packer.toBlob(doc),
    isTw ? '新聞稿匯入範本.docx' : 'press-release-import-template.docx',
  )
}

/**
 * 把純文字轉成 HTML，並把網址包成明確的 <a>。
 *
 * 一定要自己輸出 <a>：若留純文字，Chrome 列印成 PDF 時會「自動偵測網址並加連結」，
 * 而它的自動偵測會把 transcend-info.com 的連字號吃掉、連到錯誤網址。
 * 先輸出成正式連結，Chrome 就不會再自作主張。
 */
function linkifyHtml(text: string): string {
  return splitLinks(text)
    .map((seg) => {
      const safe = escapeHtml(seg.text)
      if (!seg.url) return safe
      const href = safeUrl(seg.url)
      return href ? `<a href="${href}">${safe}</a>` : safe
    })
    .join('')
}

/** round 34 新增：把一個 table 區塊轉成 PDF 用的 `<table>` HTML，樣式跟 `<style>` 裡的 table/th/td 規則搭配。 */
function renderTableHtmlForPdf(rows: string[][]): string {
  const [header, ...body] = rows
  const headerRow = `<tr>${(header ?? []).map((cell) => `<th>${escapeHtml(cell)}</th>`).join('')}</tr>`
  const bodyRows = body
    .map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`)
    .join('')
  return `<table>${headerRow}${bodyRows}</table>`
}

/**
 * PDF 走瀏覽器列印。刻意不重用信件樣板 ——
 * 信件是紅底白 logo，而瀏覽器列印預設不輸出背景色，
 * logo 會融進白底消失。這裡改用與 Word 一致的白底紅 logo 版面。
 */
export function downloadPdf(input: TemplateInput, filename: string) {
  const win = window.open('', '_blank')
  if (!win) {
    alert('瀏覽器阻擋了彈出視窗，請允許後再試一次。')
    return
  }

  const font =
    input.language === 'tw'
      ? "'Helvetica Neue',Helvetica,Arial,'Microsoft JhengHei','Noto Sans TC',sans-serif"
      : "'Helvetica Neue',Helvetica,Arial,sans-serif"

  // 內文區塊切分（標題／段落／表格）跟信件、CMS HTML、Word 共用同一套
  // 邏輯，見 shared/emailTemplate.ts 的 splitMarkdownBlocks() 說明。
  const blocks = splitMarkdownBlocks(input.bodyText).map((block) => {
    if (block.type === 'heading') return `<h2>${escapeHtml(block.text)}</h2>`
    if (block.type === 'table') return renderTableHtmlForPdf(block.rows)
    return `<p>${linkifyHtml(block.text).replace(/\n/g, '<br>')}</p>`
  })

  const heroSrc = safeUrl(input.heroImageUrl)
  if (heroSrc) {
    blocks.splice(1, 0, `<p class="pic"><img src="${heroSrc}" alt=""></p>`)
  }

  const c = input.contact
  const contactBlock = c?.name
    ? `<section class="contact">
         <h3>${input.language === 'tw' ? '新聞聯絡人' : 'Press Contact'}</h3>
         <p>${escapeHtml([c.name, c.company].filter(Boolean).join(' · '))}</p>
         ${c.email ? `<p><a href="${safeUrl(`mailto:${c.email}`)}">${escapeHtml(c.email)}</a></p>` : ''}
         ${c.phone ? `<p>${escapeHtml(c.phone)}</p>` : ''}
       </section>`
    : ''

  const about = input.about?.trim() || DEFAULT_ABOUT[input.language].text
  const aboutLink = input.aboutLink?.trim() || DEFAULT_ABOUT[input.language].link
  const dateLine = formatReleaseDate(input.releaseDate, input.language)

  win.document.write(`<!doctype html>
<html lang="${input.language === 'tw' ? 'zh-Hant' : 'en'}">
<head>
<meta charset="utf-8">
<title>${escapeHtml(filename)}</title>
<style>
  @page { margin: 16mm; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: ${font}; color: #2b2f36; font-size: 11pt; line-height: 1.75; }
  header { display: flex; align-items: center; justify-content: space-between;
           border-bottom: 2px solid ${BRAND_COLOR}; padding-bottom: 10px; margin-bottom: 24px; }
  header img { height: 26px; width: auto; }
  header span { font-size: 9pt; color: #8a919e; }
  h1 { font-size: 18pt; line-height: 1.4; color: #12161c; margin: 0 0 6px; text-align: center; }
  .date { font-size: 9pt; color: #8a919e; margin: 0 0 22px; }
  h2 { font-size: 12pt; color: ${BRAND_COLOR}; margin: 22px 0 8px; }
  p { margin: 0 0 12px; }
  a { color: ${BRAND_COLOR}; text-decoration: underline; word-break: break-all; }
  .pic { text-align: center; margin: 16px 0 20px; }
  .pic img { max-width: 280px; height: auto; }
  table { border-collapse: collapse; width: 100%; margin: 0 0 16px; }
  th, td { border: 1px solid #e6e8ec; padding: 6px 10px; font-size: 10pt; text-align: left; }
  th { background-color: ${BRAND_COLOR}; color: #ffffff; font-weight: 600; }
  .contact { margin-top: 28px; padding-top: 14px; border-top: 1px solid #e6e8ec; }
  .contact h3 { font-size: 10pt; color: ${BRAND_COLOR}; margin: 0 0 6px; }
  .contact p { margin: 0; font-size: 10pt; color: #4a505c; }
  footer { margin-top: 28px; padding-top: 10px; border-top: 1px solid ${BRAND_COLOR};
           font-size: 8.5pt; color: #8a919e; }
  footer p { margin: 0 0 3px; }
</style>
<script>
  window.addEventListener('load', function () {
    // 等圖片載完再列印，否則 PDF 會缺圖
    setTimeout(function () { window.print() }, 500)
  })
</script>
</head>
<body>
  <header>
    <img src="${DOC_LOGO}" alt="TRANSCEND">
    <span>${input.language === 'tw' ? '新聞稿' : 'Press Release'}</span>
  </header>
  <h1>${escapeHtml(input.subject).replace(/\r?\n/g, '<br>')}</h1>
  ${dateLine ? `<p class="date">${escapeHtml(dateLine)}</p>` : ''}
  ${blocks.join('')}
  ${contactBlock}
  <footer>
    <p>${escapeHtml(input.language === 'tw' ? '關於創見資訊' : 'About Transcend')}：${escapeHtml(about)} <a href="${safeUrl(aboutLink)}">${escapeHtml(aboutLink)}</a></p>
    <p>&copy; Transcend Information, Inc. All Rights Reserved.</p>
  </footer>
</body>
</html>`)
  win.document.close()
}
