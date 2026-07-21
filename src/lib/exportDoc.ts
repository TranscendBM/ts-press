import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  Header,
  HeadingLevel,
  ImageRun,
  Packer,
  Paragraph,
  Tab,
  TabStopType,
  TextRun,
} from 'docx'
import {
  BRAND_COLOR,
  DEFAULT_ABOUT,
  escapeHtml,
  formatReleaseDate,
  safeUrl,
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

function textParagraph(text: string, opts: { spacing?: number } = {}) {
  return new Paragraph({
    spacing: { after: opts.spacing ?? 200, line: 300 },
    children: [new TextRun({ text, size: SIZE_BODY, font: FONTS })],
  })
}

export async function downloadWord(input: TemplateInput, filename: string) {
  const children: Paragraph[] = []

  // 標題
  children.push(
    new Paragraph({
      heading: HeadingLevel.HEADING_1,
      spacing: { after: 120 },
      children: [
        new TextRun({
          text: input.subject,
          bold: true,
          size: SIZE_TITLE,
          font: FONTS,
          color: '12161C',
        }),
      ],
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

  // 內文。「## 」開頭的行是小標題。
  const blocks = input.bodyText
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean)

  const image = input.heroImageUrl ? await loadImage(input.heroImageUrl) : null

  blocks.forEach((block, idx) => {
    if (block.startsWith('## ')) {
      children.push(
        new Paragraph({
          spacing: { before: 320, after: 160 },
          children: [
            new TextRun({
              text: block.slice(3).trim(),
              bold: true,
              size: 26,
              color: BRAND_HEX,
              font: FONTS,
            }),
          ],
        }),
      )
    } else {
      children.push(textParagraph(block))
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
      children.push(
        new Paragraph({
          spacing: { after: 60 },
          children: [
            new TextRun({ text: line, size: 20, color: '4A505C', font: FONTS }),
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
        new TextRun({
          text: `${about} ${aboutLink}`,
          size: 18,
          color: '8A919E',
          font: FONTS,
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

  const blocks = input.bodyText
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean)
    .map((b) =>
      b.startsWith('## ')
        ? `<h2>${escapeHtml(b.slice(3).trim())}</h2>`
        : `<p>${escapeHtml(b).replace(/\n/g, '<br>')}</p>`,
    )

  const heroSrc = safeUrl(input.heroImageUrl)
  if (heroSrc) {
    blocks.splice(1, 0, `<p class="pic"><img src="${heroSrc}" alt=""></p>`)
  }

  const c = input.contact
  const contactBlock = c?.name
    ? `<section class="contact">
         <h3>${input.language === 'tw' ? '新聞聯絡人' : 'Press Contact'}</h3>
         <p>${escapeHtml([c.name, c.company].filter(Boolean).join(' · '))}</p>
         ${c.email ? `<p>${escapeHtml(c.email)}</p>` : ''}
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
  h1 { font-size: 18pt; line-height: 1.4; color: #12161c; margin: 0 0 6px; }
  .date { font-size: 9pt; color: #8a919e; margin: 0 0 22px; }
  h2 { font-size: 12pt; color: ${BRAND_COLOR}; margin: 22px 0 8px; }
  p { margin: 0 0 12px; }
  .pic { text-align: center; margin: 16px 0 20px; }
  .pic img { max-width: 280px; height: auto; }
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
  <h1>${escapeHtml(input.subject)}</h1>
  ${dateLine ? `<p class="date">${escapeHtml(dateLine)}</p>` : ''}
  ${blocks.join('')}
  ${contactBlock}
  <footer>
    <p>${escapeHtml(input.language === 'tw' ? '關於創見資訊' : 'About Transcend')}：${escapeHtml(about)} ${escapeHtml(aboutLink)}</p>
    <p>&copy; Transcend Information, Inc. All Rights Reserved.</p>
  </footer>
</body>
</html>`)
  win.document.close()
}
