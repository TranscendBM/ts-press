import { renderEmailHtml, type TemplateInput } from './emailTemplate'

/**
 * 新聞稿的下載功能。
 *
 * Word：輸出 Word 認得的 HTML 並存成 .doc。Word 開啟後排版、圖片、
 * 中文都正常，比用純前端組 .docx 可靠得多，也不必額外裝套件。
 *
 * PDF：開一個乾淨的列印頁面並叫出列印對話框，由使用者選「儲存為 PDF」。
 * 瀏覽器自己的排版引擎對中文字型的處理遠優於前端 PDF 套件。
 */

function buildDocumentHtml(input: TemplateInput): string {
  // 直接沿用信件樣板，確保下載的稿件與寄出的信長得一樣
  return renderEmailHtml({ ...input, recipientName: '' })
}

export function downloadWord(input: TemplateInput, filename: string) {
  const html = buildDocumentHtml(input)
  // Word 需要這段 XML namespace 宣告才會正確辨識為文件而非網頁
  const wordHtml = html.replace(
    '<html lang=',
    '<html xmlns:o="urn:schemas-microsoft-com:office:office" ' +
      'xmlns:w="urn:schemas-microsoft-com:office:word" ' +
      'xmlns="http://www.w3.org/TR/REC-html40" lang=',
  )

  const blob = new Blob(['﻿', wordHtml], {
    type: 'application/msword;charset=utf-8',
  })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `${filename}.doc`
  a.click()
  URL.revokeObjectURL(a.href)
}

export function downloadPdf(input: TemplateInput, filename: string) {
  const html = buildDocumentHtml(input)
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
