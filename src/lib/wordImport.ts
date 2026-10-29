import mammoth from 'mammoth'

/**
 * round 34 新增：把使用者上傳的 .docx 轉成編輯頁可以吃的 subject／bodyText。
 *
 * 用 mammoth 把 docx 轉成語意化 HTML（Word 的「標題 1/2/3」段落樣式會變成
 * <h1>/<h2>/<h3>，表格變成 <table>），不自訂 styleMap——搭配
 * downloadWordTemplate()（src/lib/exportDoc.ts）刻意產生的範本，預設規則
 * 就足夠辨識。表格輸出的 pipe 語法跟 shared/emailTemplate.ts 的
 * splitMarkdownBlocks() 是同一套格式，不在這裡另外重刻切分規則。
 */

export interface ParsedWordDocument {
  subject: string
  bodyText: string
  warnings: string[]
}

const HEADING_TAGS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6'])

function cellsOf(row: Element): string[] {
  return Array.from(row.querySelectorAll('td, th')).map((cell) =>
    (cell.textContent ?? '').replace(/\s+/g, ' ').trim(),
  )
}

function tableToPipeSyntax(table: Element): string | null {
  const rows = Array.from(table.querySelectorAll('tr'))
  if (rows.length === 0) return null

  const header = cellsOf(rows[0])
  if (header.length === 0) return null

  const lines = [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
  ]
  for (const row of rows.slice(1)) {
    const cells = cellsOf(row)
    if (cells.length === 0) continue
    lines.push(`| ${cells.join(' | ')} |`)
  }
  return lines.join('\n')
}

/**
 * 純邏輯的 HTML → ParsedWordDocument 轉換，跟「呼叫 mammoth 做 docx →
 * HTML 轉換」這一步分開匯出——方便測試直接餵手刻的 HTML 驗證 DOM 節點
 * 判斷邏輯本身，不需要每個案例都去產生一份真正的 .docx fixture（清單、
 * 內嵌圖片這類結構很難用 docx 套件的高階 API 可靠產生）。
 */
export function parseWordHtml(html: string): ParsedWordDocument {
  const dom = new DOMParser().parseFromString(html, 'text/html')

  let subject = ''
  const paragraphs: string[] = []
  const warnings: string[] = []
  let sawImage = false
  let sawList = false

  for (const node of Array.from(dom.body.children)) {
    if (HEADING_TAGS.has(node.tagName)) {
      const text = (node.textContent ?? '').trim()
      if (!text) continue
      if (!subject) {
        subject = text
      } else {
        paragraphs.push(`## ${text}`)
      }
      continue
    }

    if (node.tagName === 'TABLE') {
      const table = tableToPipeSyntax(node)
      if (table) paragraphs.push(table)
      continue
    }

    if (node.tagName === 'P') {
      if (node.querySelector('img')) sawImage = true
      const text = (node.textContent ?? '').trim()
      if (text) paragraphs.push(text)
      continue
    }

    if (node.tagName === 'UL' || node.tagName === 'OL') {
      sawList = true
      const items = Array.from(node.querySelectorAll('li'))
        .map((li) => (li.textContent ?? '').trim())
        .filter(Boolean)
      if (items.length > 0) paragraphs.push(items.join('\n'))
      continue
    }

    if (node.querySelector('img')) sawImage = true
    const text = (node.textContent ?? '').trim()
    if (text) paragraphs.push(text)
  }

  if (dom.body.querySelector('img')) sawImage = true

  if (sawImage) {
    warnings.push('偵測到圖片，Word 匯入不會處理圖片，請另外用「上傳圖片」加入。')
  }
  if (sawList) {
    warnings.push('偵測到清單（項目符號／編號），已簡化為純文字段落。')
  }

  return {
    subject,
    bodyText: paragraphs.join('\n\n'),
    warnings,
  }
}

export async function parseWordDocument(arrayBuffer: ArrayBuffer): Promise<ParsedWordDocument> {
  const { value: html } = await mammoth.convertToHtml({ arrayBuffer })
  return parseWordHtml(html)
}
