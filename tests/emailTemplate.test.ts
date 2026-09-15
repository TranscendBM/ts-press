import { describe, expect, it } from 'vitest'
import {
  DEFAULT_EMAIL_LOGO,
  escapeHtml,
  subjectSingleLine,
  subjectMultiline,
  renderBodyHtml,
  renderEmailHtml,
  renderEmailText,
  safeUrl,
  splitLinks,
  splitMarkdownBlocks,
} from '../shared/emailTemplate'

const base = {
  subject: '測試主旨',
  bodyText: '第一段內容。',
  language: 'tw' as const,
}

describe('safeUrl', () => {
  it('允許 http/https/mailto', () => {
    expect(safeUrl('https://a.com/x.png')).toBe('https://a.com/x.png')
    expect(safeUrl('http://a.com')).toBe('http://a.com')
    expect(safeUrl('mailto:a@b.com')).toBe('mailto:a@b.com')
  })

  it('擋掉 javascript: 與 data:', () => {
    expect(safeUrl('javascript:alert(1)')).toBe('')
    expect(safeUrl('JavaScript:alert(1)')).toBe('')
    expect(safeUrl('data:text/html;base64,PHNjcmlwdD4=')).toBe('')
  })

  it('編碼會提前結束屬性的字元', () => {
    expect(safeUrl('https://a.com/"onerror="alert(1)')).not.toContain('"')
    expect(safeUrl('https://a.com/<script>')).not.toContain('<')
  })

  it('空值回傳空字串', () => {
    expect(safeUrl(undefined)).toBe('')
    expect(safeUrl('   ')).toBe('')
  })
})

describe('splitLinks', () => {
  it('把網址切出來、保留前後文字', () => {
    expect(splitLinks('詳見 https://a.com/x 頁面')).toEqual([
      { text: '詳見 ' },
      { text: 'https://a.com/x', url: 'https://a.com/x' },
      { text: ' 頁面' },
    ])
  })

  it('保留網址裡的連字號', () => {
    const r = splitLinks('https://tw.transcend-info.com/ssd')
    expect(r).toEqual([
      {
        text: 'https://tw.transcend-info.com/ssd',
        url: 'https://tw.transcend-info.com/ssd',
      },
    ])
  })

  it('尾端的中文句號與逗號不會被吃進網址', () => {
    expect(splitLinks('看 https://a.com/x。')).toEqual([
      { text: '看 ' },
      { text: 'https://a.com/x', url: 'https://a.com/x' },
      { text: '。' },
    ])
  })

  it('沒有網址時原樣回傳', () => {
    expect(splitLinks('純文字')).toEqual([{ text: '純文字' }])
    expect(splitLinks('')).toEqual([])
  })
})

describe('splitMarkdownBlocks（round 30 新增：## 標題後不需要空白行）', () => {
  it('LF：## 標題後緊接內文（沒有空白行）→ 一個獨立標題區塊 + 一個獨立段落區塊', () => {
    expect(splitMarkdownBlocks('## 標題\n下一段內文')).toEqual([
      { type: 'heading', text: '標題' },
      { type: 'paragraph', text: '下一段內文' },
    ])
  })

  it('有空白行時（既有行為）結果完全相同——修正前後語意一致', () => {
    expect(splitMarkdownBlocks('## 標題\n\n下一段內文')).toEqual([
      { type: 'heading', text: '標題' },
      { type: 'paragraph', text: '下一段內文' },
    ])
  })

  it('CRLF：## 標題\\r\\n下一段內文，沒有空白行 → 結果與 LF 版本相同', () => {
    expect(splitMarkdownBlocks('## 標題\r\n下一段內文')).toEqual([
      { type: 'heading', text: '標題' },
      { type: 'paragraph', text: '下一段內文' },
    ])
  })

  it('連續兩個標題，中間沒有空白行 → 兩個獨立的標題區塊，不會互相吃掉', () => {
    expect(splitMarkdownBlocks('## 第一段\n內文\n## 第二段\n內文')).toEqual([
      { type: 'heading', text: '第一段' },
      { type: 'paragraph', text: '內文' },
      { type: 'heading', text: '第二段' },
      { type: 'paragraph', text: '內文' },
    ])
  })

  it('連續兩個標題、中間完全沒有內文（標題緊接標題）→ 兩個獨立標題區塊', () => {
    expect(splitMarkdownBlocks('## 標題一\n## 標題二')).toEqual([
      { type: 'heading', text: '標題一' },
      { type: 'heading', text: '標題二' },
    ])
  })

  it('英文標題，沒有空白行 → 同樣正確拆開', () => {
    expect(splitMarkdownBlocks('## Announcement\nMore details here.')).toEqual([
      { type: 'heading', text: 'Announcement' },
      { type: 'paragraph', text: 'More details here.' },
    ])
  })

  it('標題後接一般段落，段落內容以清單符號開頭（純文字，本解析器不特別處理清單語法，整行當成段落文字）', () => {
    expect(splitMarkdownBlocks('## 重點\n- 第一點\n- 第二點')).toEqual([
      { type: 'heading', text: '重點' },
      { type: 'paragraph', text: '- 第一點\n- 第二點' },
    ])
  })

  it('標題後接引用（純文字，「> 」開頭的行不是這支解析器認得的語法，當成一般段落文字）', () => {
    expect(splitMarkdownBlocks('## 標題\n> 這是一段引用')).toEqual([
      { type: 'heading', text: '標題' },
      { type: 'paragraph', text: '> 這是一段引用' },
    ])
  })

  it('fenced code block 裡的 ## 不會被當成標題——即使前後都沒有空白行，整段（含 fence 標記本身）併成同一個段落區塊，符合「沒有空白行就不分段」的一致語意，重點是 fence 內的 ## 不會被切成獨立標題', () => {
    const input = '說明如下\n```\n## 這是程式碼裡的文字，不是標題\n```\n後續內文'
    expect(splitMarkdownBlocks(input)).toEqual([{ type: 'paragraph', text: input }])
  })

  it('fenced code block 前後有空白行時，才會正確分段——fence 內的 ## 仍然不會被當成標題', () => {
    expect(
      splitMarkdownBlocks('說明如下\n\n```\n## 這是程式碼裡的文字，不是標題\n```\n\n後續內文'),
    ).toEqual([
      { type: 'paragraph', text: '說明如下' },
      { type: 'paragraph', text: '```\n## 這是程式碼裡的文字，不是標題\n```' },
      { type: 'paragraph', text: '後續內文' },
    ])
  })

  it('fenced code block 前後各自獨立成段，區塊內容原樣保留（不改寫使用者原始文字）', () => {
    const input = '```\nconst x = 1\n## not a heading\n```'
    const blocks = splitMarkdownBlocks(input)
    expect(blocks).toEqual([{ type: 'paragraph', text: input }])
  })

  it('行中文字包含 ## 但不在行首 → 不會被誤判成標題', () => {
    expect(splitMarkdownBlocks('今天業績成長 5## 3 = 2 的說法並不正確')).toEqual([
      { type: 'paragraph', text: '今天業績成長 5## 3 = 2 的說法並不正確' },
    ])
  })

  it('## 沒有接空白（例如 "##標題"，不符合既有的 "## "＋空格慣例）→ 不會被當成標題，維持修正前的既有判斷條件', () => {
    expect(splitMarkdownBlocks('##標題\n內文')).toEqual([
      { type: 'paragraph', text: '##標題\n內文' },
    ])
  })

  it('多個空白行視為同一個分段邊界，不會產生空段落', () => {
    expect(splitMarkdownBlocks('第一段\n\n\n\n第二段')).toEqual([
      { type: 'paragraph', text: '第一段' },
      { type: 'paragraph', text: '第二段' },
    ])
  })

  it('段落內單行斷行（使用者按 Enter 但沒有空白行）保留在同一個段落區塊裡，用 \\n 銜接', () => {
    expect(splitMarkdownBlocks('第一行\n第二行\n第三行')).toEqual([
      { type: 'paragraph', text: '第一行\n第二行\n第三行' },
    ])
  })

  it('空字串 → 空陣列', () => {
    expect(splitMarkdownBlocks('')).toEqual([])
  })

  it('只有空白行 → 空陣列，不會產生空段落區塊', () => {
    expect(splitMarkdownBlocks('\n\n\n')).toEqual([])
  })

  // 提交前審查追加：未閉合 fence 的語意鎖定測試（見 splitMarkdownBlocks
  // 上方新增的「提交前審查追加說明」——這是刻意行為，不是 bug）。

  it('fence 收尾後緊接著標題，中間沒有空白行 → 收尾後的內容恢復成一般解析，標題照樣被獨立切出來', () => {
    expect(splitMarkdownBlocks('```\nconst x = 1\n```\n## 標題\n下一段內文')).toEqual([
      { type: 'paragraph', text: '```\nconst x = 1\n```' },
      { type: 'heading', text: '標題' },
      { type: 'paragraph', text: '下一段內文' },
    ])
  })

  it('fence 開頭帶語言標籤（例如 ```ts）一樣會觸發 fence 狀態切換，裡面的 ## 不會被當成標題', () => {
    const input = '```ts\nconst heading = "## not a heading"\n```'
    expect(splitMarkdownBlocks(input)).toEqual([{ type: 'paragraph', text: input }])
  })

  it('未閉合的 fence 會一路延伸到字串結尾：裡面所有的 ## 都維持是程式碼的一部分，不會被切成獨立標題，也不會因為缺少收尾而自動補上或恢復成一般解析', () => {
    const input = '前言\n```\nconst a = 1\n## 這行在未閉合的 fence 裡面\n## 這行也是\n最後一行也還在 fence 裡'
    // 前言跟 fence 開頭之間沒有空白行，所以會併入同一個段落區塊（跟既有的
    // 「fenced code block 裡的 ## 不會被當成標題」測試的行為一致）；重點是
    // 沒有收尾 ``` 時，後面所有內容（含看起來像標題的 ## 開頭行）都還是
    // 同一段落的一部分，不會有任何一個被獨立切成 heading 區塊。
    expect(splitMarkdownBlocks(input)).toEqual([{ type: 'paragraph', text: input }])
  })

  it('未閉合的 fence 前面若有空白行分隔，fence 開頭前的內容會先獨立成段，fence 本身連同後面一路延伸到結尾的內容合併成另一個段落', () => {
    const input =
      '前言\n\n```\nconst a = 1\n## 這行在未閉合的 fence 裡面\n## 這行也是\n最後一行也還在 fence 裡'
    expect(splitMarkdownBlocks(input)).toEqual([
      { type: 'paragraph', text: '前言' },
      {
        type: 'paragraph',
        text: '```\nconst a = 1\n## 這行在未閉合的 fence 裡面\n## 這行也是\n最後一行也還在 fence 裡',
      },
    ])
  })

  it('CRLF 換行的 fence 一樣能正確辨識收尾，裡面的 ## 不會被當成標題', () => {
    // fence 前後都沒有空白行分隔，所以（跟既有的「fenced code block 裡的
    // ## 不會被當成標題」測試一致）整段會合併成同一個段落區塊；重點是
    // CRLF 也能正確觸發 fence 開合狀態切換，讓 fence 內的 ## 不被誤判成
    // 標題。
    expect(splitMarkdownBlocks('```\r\n## not a heading\r\n```\r\n下一段')).toEqual([
      { type: 'paragraph', text: '```\n## not a heading\n```\n下一段' },
    ])
  })

  it('CRLF 換行、fence 收尾後有空白行分隔時，fence 區塊與後續內文正確拆成獨立段落', () => {
    expect(splitMarkdownBlocks('```\r\n## not a heading\r\n```\r\n\r\n下一段')).toEqual([
      { type: 'paragraph', text: '```\n## not a heading\n```' },
      { type: 'paragraph', text: '下一段' },
    ])
  })

  it('只支援行首三個反引號：`~~~` 不會觸發 fence 狀態切換，縮排過的 ``` 也不算 fence 開頭（維持既有解析範圍，不擴大支援 CommonMark 完整 fence 語法）', () => {
    expect(splitMarkdownBlocks('~~~\n## 這行不在任何 fence 裡\n~~~')).toEqual([
      { type: 'paragraph', text: '~~~' },
      { type: 'heading', text: '這行不在任何 fence 裡' },
      { type: 'paragraph', text: '~~~' },
    ])
    // flushParagraph() 對整段做 trim()，縮排的反引號單獨成一行（一個獨立
    // 段落）時前導空白會被 trim 掉，這裡驗證的重點不是空白有沒有保留，
    // 而是縮排過的 ``` 沒有觸發 fence 狀態切換——所以中間的 ## 依然被
    // 切成獨立的標題區塊，不是被 fence 吞掉的程式碼。
    expect(splitMarkdownBlocks('  ```\n## 縮排的反引號不算 fence 開頭\n  ```')).toEqual([
      { type: 'paragraph', text: '```' },
      { type: 'heading', text: '縮排的反引號不算 fence 開頭' },
      { type: 'paragraph', text: '```' },
    ])
  })
})

describe('renderBlocks／renderBodyHtml／renderEmailHtml：## 標題不需要空白行的語意在下游輸出一致（round 30）', () => {
  it('renderBodyHtml（CMS HTML）：沒有空白行時標題與段落正確拆開', () => {
    expect(renderBodyHtml('## 標題\n下一段內文')).toBe('<h4>標題</h4>\n<p>下一段內文</p>')
  })

  it('renderEmailHtml（實際寄出的信件 HTML）：沒有空白行時同樣正確產生獨立的 <h2> 與 <p>', () => {
    const html = renderEmailHtml({ ...base, bodyText: '## 小標\n內文，沒有空白行分隔' })
    expect(html).toContain('<h2')
    expect(html).toContain('小標')
    // 標題文字不應該把下一段內文吃進去——h2 標籤內只應該看到「小標」，
    // 不應該同時看到「內文，沒有空白行分隔」跟標題擠在同一個標籤裡。
    const h2Match = html.match(/<h2[^>]*>([^<]*)<\/h2>/)
    expect(h2Match?.[1]).toBe('小標')
    expect(html).toContain('內文，沒有空白行分隔')
  })

  it('fenced code block 內的 ## 在 renderBodyHtml／renderEmailHtml 都不會變成標題', () => {
    const bodyText = '```\n## not a heading\n```'
    expect(renderBodyHtml(bodyText)).not.toContain('<h4>')
    const html = renderEmailHtml({ ...base, bodyText })
    // base.bodyText 原本就不含標題，這裡確認新增的 fenced block 內容
    // 沒有多產生一個 <h2>。
    expect((html.match(/<h2/g) ?? []).length).toBe(0)
  })
})

describe('renderBodyHtml', () => {
  it('段落 <p>、小標 <h4>、連結 <a>，且不含行內樣式', () => {
    const html = renderBodyHtml(
      '## 展覽資訊\n\n第一段，詳見 https://tw.transcend-info.com/x 。\n\n第二段。',
    )
    expect(html).toContain('<h4>展覽資訊</h4>')
    expect(html).toContain('<p>')
    expect(html).toContain(
      '<a href="https://tw.transcend-info.com/x">https://tw.transcend-info.com/x</a>',
    )
    expect(html).not.toContain('style=')
  })

  it('段落內單行斷行轉成 <br>', () => {
    expect(renderBodyHtml('第一行\n第二行')).toBe('<p>第一行<br>第二行</p>')
  })

  it('會跳脫 HTML 特殊字元', () => {
    expect(renderBodyHtml('a < b & c')).toBe('<p>a &lt; b &amp; c</p>')
  })

  it('空內文回傳空字串', () => {
    expect(renderBodyHtml('')).toBe('')
  })
})

describe('renderEmailHtml', () => {
  it('沒設定 logo 時使用內建的預設值', () => {
    const html = renderEmailHtml(base)
    expect(html).toContain(DEFAULT_EMAIL_LOGO)
  })

  it('後台設定的 logo 會覆蓋預設值', () => {
    const html = renderEmailHtml({ ...base, logoUrl: 'https://x.com/l.png' })
    expect(html).toContain('https://x.com/l.png')
    expect(html).not.toContain(DEFAULT_EMAIL_LOGO)
  })

  it('logo 網址不合法時退回預設而非輸出空 src', () => {
    const html = renderEmailHtml({ ...base, logoUrl: 'javascript:alert(1)' })
    expect(html).not.toContain('javascript:')
  })

  it('主旨與內文的 HTML 會被跳脫', () => {
    const html = renderEmailHtml({
      ...base,
      subject: '<script>alert(1)</script>',
      bodyText: '<img src=x onerror=alert(1)>',
    })
    // 重點是不能出現「可執行的標籤」；跳脫後的文字仍含 onerror 字樣但無害
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).not.toContain('<img src=x')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
  })

  it('已移除稱謂，收件人姓名不再出現在信中', () => {
    const html = renderEmailHtml({ ...base, recipientName: 'Alice Wang' })
    expect(html).not.toContain('Alice Wang')
    expect(html).not.toContain('您好')
    const text = renderEmailText({ ...base, recipientName: 'Alice Wang' })
    expect(text).not.toContain('Alice Wang')
    expect(text).not.toContain('您好')
  })

  it('內文的 javascript: 不會變成連結', () => {
    const html = renderEmailHtml({
      ...base,
      bodyText: '請看 https://ok.com 與 javascript:alert(1)',
    })
    expect(html).toContain('href="https://ok.com"')
    expect(html).not.toContain('href="javascript:')
  })

  it('圖片網址不合法時不輸出 img', () => {
    const html = renderEmailHtml({
      ...base,
      heroImageUrl: 'javascript:alert(1)',
    })
    expect(html).not.toContain('javascript:')
  })

  it('「## 」開頭的行變成小標題', () => {
    const html = renderEmailHtml({ ...base, bodyText: '## 小標\n\n內文' })
    expect(html).toContain('<h2')
    expect(html).toContain('小標')
  })

  it('發佈日期依語言格式化', () => {
    expect(
      renderEmailHtml({ ...base, releaseDate: '2026-06-24' }),
    ).toContain('2026 年 6 月 24 日')
    expect(
      renderEmailHtml({ ...base, language: 'www', releaseDate: '2026-06-24' }),
    ).toContain('June 24, 2026')
  })
})

describe('escapeHtml', () => {
  it('跳脫五個危險字元', () => {
    expect(escapeHtml('<>&"')).toBe('&lt;&gt;&amp;&quot;')
  })
})

describe('主旨斷行', () => {
  it('subjectSingleLine 把換行壓成單一空格（郵件主旨標頭用）', () => {
    expect(subjectSingleLine('創見推出新產品，\n強化 AI 應用')).toBe(
      '創見推出新產品， 強化 AI 應用',
    )
    expect(subjectSingleLine('a\r\nb')).toBe('a b')
    expect(subjectSingleLine('  單行  ')).toBe('單行')
  })

  it('subjectMultiline 保留斷行為 <br> 並跳脫 HTML', () => {
    expect(subjectMultiline('第一行\n第二行')).toBe('第一行<br>第二行')
    expect(subjectMultiline('<b>x</b>\ny')).toBe('&lt;b&gt;x&lt;/b&gt;<br>y')
  })

  it('信件 <title> 不含換行，<h1> 保留斷行', () => {
    const html = renderEmailHtml({ ...base, subject: '標題上\n標題下' })
    expect(html).toContain('<title>標題上 標題下</title>')
    expect(html).toContain('標題上<br>標題下')
  })
})
