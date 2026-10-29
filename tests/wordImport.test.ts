// @vitest-environment jsdom
//
// round 34 新增：parseWordHtml()／parseWordDocument() 內部用瀏覽器原生
// DOMParser 解析 HTML，純 Node 環境沒有這個全域物件，所以這個檔案單獨用
// jsdom 環境跑（其餘測試檔案維持專案預設的 node 環境，不受影響——見
// vitest.config.ts 開頭的說明）。
import { describe, expect, it } from 'vitest'
import { parseWordHtml } from '../src/lib/wordImport'

describe('parseWordHtml（round 34 新增：純邏輯的 DOM 節點判斷，直接餵 mammoth 輸出格式的 HTML）', () => {
  it('第一個標題節點變成 subject，之後的標題節點變成 ## 小標題', () => {
    const html = '<h1>主旨測試</h1><p>第一段內文</p><h2>小標題測試</h2><p>第二段內文</p>'
    const result = parseWordHtml(html)
    expect(result.subject).toBe('主旨測試')
    expect(result.bodyText).toBe('第一段內文\n\n## 小標題測試\n\n第二段內文')
    expect(result.warnings).toEqual([])
  })

  it('沒有任何標題節點時，subject 為空字串，段落仍照樣解析', () => {
    const result = parseWordHtml('<p>只有一般段落，沒有標題</p>')
    expect(result.subject).toBe('')
    expect(result.bodyText).toBe('只有一般段落，沒有標題')
  })

  it('多個 <h1> 只有第一個變成 subject，其餘一律變成 ## 小標題（不特別區分階層）', () => {
    const result = parseWordHtml('<h1>標題一</h1><h1>標題二</h1><h3>標題三</h3>')
    expect(result.subject).toBe('標題一')
    expect(result.bodyText).toBe('## 標題二\n\n## 標題三')
  })

  it('表格轉成 pipe table 語法，第一列當表頭、自動補上分隔列', () => {
    const html =
      '<h1>標題</h1><table><tr><td>項目</td><td>數量</td></tr><tr><td>蘋果</td><td>10</td></tr></table>'
    const result = parseWordHtml(html)
    expect(result.bodyText).toBe('| 項目 | 數量 |\n| --- | --- |\n| 蘋果 | 10 |')
    expect(result.warnings).toEqual([])
  })

  it('表格用 <th> 當表頭一樣能正確辨識', () => {
    const html = '<table><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr></table>'
    expect(parseWordHtml(html).bodyText).toBe('| a | b |\n| --- | --- |\n| 1 | 2 |')
  })

  it('偵測到 <ul> 清單時，攤平成純文字段落（每個項目一行）並加入清單警告', () => {
    const html = '<h1>標題</h1><ul><li>第一點</li><li>第二點</li></ul>'
    const result = parseWordHtml(html)
    expect(result.bodyText).toBe('第一點\n第二點')
    expect(result.warnings).toEqual(['偵測到清單（項目符號／編號），已簡化為純文字段落。'])
  })

  it('偵測到 <ol> 編號清單同樣加入清單警告', () => {
    const result = parseWordHtml('<ol><li>步驟一</li><li>步驟二</li></ol>')
    expect(result.warnings).toEqual(['偵測到清單（項目符號／編號），已簡化為純文字段落。'])
  })

  it('偵測到 <img> 時加入圖片警告，圖片本身被略過、不會出現在 bodyText 裡', () => {
    const html = '<h1>標題</h1><p>文字前</p><p><img src="data:image/png;base64,xx"></p><p>文字後</p>'
    const result = parseWordHtml(html)
    expect(result.warnings).toEqual(['偵測到圖片，Word 匯入不會處理圖片，請另外用「上傳圖片」加入。'])
    expect(result.bodyText).toBe('文字前\n\n文字後')
  })

  it('圖片與清單同時出現時，兩則警告都會加入', () => {
    const html = '<p><img src="x.png"></p><ul><li>項目</li></ul>'
    const result = parseWordHtml(html).warnings
    expect(result).toContain('偵測到圖片，Word 匯入不會處理圖片，請另外用「上傳圖片」加入。')
    expect(result).toContain('偵測到清單（項目符號／編號），已簡化為純文字段落。')
  })

  it('空白段落（例如 mammoth 保留的空行）不會產生空白區塊', () => {
    const result = parseWordHtml('<h1>標題</h1><p></p><p>正文</p><p>   </p>')
    expect(result.bodyText).toBe('正文')
  })
})

/**
 * 刻意不測試 parseWordDocument() 本身（mammoth.convertToHtml({ arrayBuffer })
 * 這一步）：mammoth 的 arrayBuffer 輸入只有在套件的 package.json "browser"
 * 欄位被解析套用時才會正確運作（見 node_modules/mammoth/browser/unzip.js
 * vs. lib/unzip.js 的差異）——真正的瀏覽器打包（Vite build／dev）一定會
 * 套用這個欄位，但 Vitest 底下用 Node 模組解析跑這個套件時不會，呼叫
 * `mammoth.convertToHtml({ arrayBuffer })` 會直接丟出
 * "Could not find file in options"，這是測試環境本身的解析落差，不是
 * production code 的錯誤。上面 parseWordHtml() 的完整測試已經涵蓋所有
 * DOM 節點判斷邏輯；parseWordDocument() 只是多包一層「呼叫 mammoth」，
 * 跟專案既有對 downloadWord()/downloadPdf() 的處理方式一致（見
 * PLAN 第五節）——改用 Browser pane 手動驗證實際匯入結果，不建立新的
 * 測試骨架硬要繞過這個環境限制。
 */
