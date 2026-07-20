import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  ImageRun,
  Packer,
  Paragraph,
  TextRun,
} from 'docx'
import {
  BRAND_COLOR,
  DEFAULT_ABOUT,
  formatReleaseDate,
  renderEmailHtml,
  type TemplateInput,
} from './emailTemplate'

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

function saveBlob(blob: Blob, filename: string) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = filename
  a.click()
  URL.revokeObjectURL(a.href)
}

/** 抓內文圖片並取得尺寸。跨網域被擋時回傳 null，不影響其他內容。 */
async function loadImage(
  url: string,
): Promise<{ data: ArrayBuffer; width: number; height: number } | null> {
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    const data = await res.arrayBuffer()
    const bitmap = await createImageBitmap(new Blob([data]))
    // 統一縮到 260px 寬，與信件版面一致
    const width = 260
    const height = Math.round((bitmap.height / bitmap.width) * width)
    bitmap.close()
    return { data, width, height }
  } catch {
    return null
  }
}

function textParagraph(text: string, opts: { spacing?: number } = {}) {
  return new Paragraph({
    spacing: { after: opts.spacing ?? 200, line: 300 },
    children: [new TextRun({ text, size: 22, font: 'Arial' })],
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
          size: 34,
          font: 'Arial',
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
            font: 'Arial',
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
              font: 'Arial',
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
              type: 'png',
              data: image.data,
              transformation: { width: image.width, height: image.height },
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
            font: 'Arial',
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
            new TextRun({ text: line, size: 20, color: '4A505C', font: 'Arial' }),
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
          font: 'Arial',
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
          font: 'Arial',
        }),
      ],
    }),
  )

  const doc = new Document({
    creator: 'Transcend Press Center',
    title: input.subject,
    sections: [
      {
        properties: {
          page: { margin: { top: 1000, bottom: 1000, left: 1000, right: 1000 } },
        },
        children,
      },
    ],
  })

  saveBlob(await Packer.toBlob(doc), `${filename}.docx`)
}

export function downloadPdf(input: TemplateInput, filename: string) {
  const html = renderEmailHtml({ ...input, recipientName: '' })
  const win = window.open('', '_blank')
  if (!win) {
    alert('瀏覽器阻擋了彈出視窗，請允許後再試一次。')
    return
  }
  win.document.write(
    html.replace(
      '</head>',
      `<style>
         @page { margin: 15mm; }
         @media print { body { background: #fff !important; } }
       </style>
       <script>
         document.title = ${JSON.stringify(filename)};
         window.addEventListener('load', function () {
           // 等圖片載完再列印，否則 PDF 會缺圖
           setTimeout(function () { window.print(); }, 400);
         });
       </script>
       </head>`,
    ),
  )
  win.document.close()
}
