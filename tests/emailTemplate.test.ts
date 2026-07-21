import { describe, expect, it } from 'vitest'
import {
  DEFAULT_EMAIL_LOGO,
  escapeHtml,
  renderEmailHtml,
  safeUrl,
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

  it('收件人姓名會被跳脫', () => {
    const html = renderEmailHtml({ ...base, recipientName: '"><script>x' })
    expect(html).not.toContain('"><script>')
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
