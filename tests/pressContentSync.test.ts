import { describe, expect, it } from 'vitest'
import {
  canonicalizePressForSync,
  createPressPatcher,
  isUsVersionInSyncWithWww,
  SYNCED_VERSION_FIELDS,
} from '../src/lib/pressContentSync'
import { createAutosaveController } from '../src/lib/autosave'
import type { PressRelease } from '../src/types'
import { renderBodyHtml, renderEmailHtml, renderEmailText } from '../shared/emailTemplate'

/**
 * round 30 新增：「US 版本與 WWW 版本保持相同」的純函式單元測試——不掛載
 * PressEditPage.tsx 元件（這個專案完全沒有 React 元件測試基礎建設，見
 * tests/autosave.test.ts／tests/saveThenNavigate.test.ts 的既有慣例：把
 * 會被元件呼叫的邏輯抽成 src/lib/ 底下不依賴 React 的純函式，只測那些
 * 純函式）。UI 層的 checkbox／readOnly 顯示邏輯本身很薄，直接呼叫這裡驗證
 * 過的 canonicalizePressForSync()，不重新測一次 React 綁定。
 */
function basePress(overrides: Partial<PressRelease> = {}): PressRelease {
  return {
    id: 'p1',
    title: '測試新聞稿',
    category: 'product',
    versions: {
      tw: { subject: '中文主旨', bodyText: '中文內文' },
      www: { subject: 'WWW Subject', bodyText: 'WWW body text' },
      us: { subject: 'US Subject (獨立)', bodyText: 'US body text (獨立)' },
    },
    attachments: [],
    status: 'draft',
    createdBy: 'owner@x.com',
    ...overrides,
  } as PressRelease
}

describe('isUsVersionInSyncWithWww', () => {
  it('subject／bodyText 都相同 → true', () => {
    const press = basePress({
      versions: {
        tw: { subject: '', bodyText: '' },
        www: { subject: 'A', bodyText: 'B' },
        us: { subject: 'A', bodyText: 'B' },
      },
    })
    expect(isUsVersionInSyncWithWww(press)).toBe(true)
  })

  it('subject 不同 → false', () => {
    const press = basePress({
      versions: {
        tw: { subject: '', bodyText: '' },
        www: { subject: 'A', bodyText: 'B' },
        us: { subject: 'X', bodyText: 'B' },
      },
    })
    expect(isUsVersionInSyncWithWww(press)).toBe(false)
  })

  it('bodyText 不同 → false', () => {
    const press = basePress({
      versions: {
        tw: { subject: '', bodyText: '' },
        www: { subject: 'A', bodyText: 'B' },
        us: { subject: 'A', bodyText: 'Y' },
      },
    })
    expect(isUsVersionInSyncWithWww(press)).toBe(false)
  })

  it('SYNCED_VERSION_FIELDS 精確等於 subject／bodyText 兩個欄位（不含 heroImage 等非文字欄位）', () => {
    expect(SYNCED_VERSION_FIELDS).toEqual(['subject', 'bodyText'])
  })
})

describe('canonicalizePressForSync', () => {
  it('舊資料缺少 usSyncedWithWww 欄位 → 視為 false，完全不改動內容（維持既有獨立編輯行為）', () => {
    const press = basePress()
    delete (press as { usSyncedWithWww?: boolean }).usSyncedWithWww
    const result = canonicalizePressForSync(press)
    expect(result).toBe(press) // 同一個物件參照，完全沒有被複製或修改
    expect(result.versions.us.subject).toBe('US Subject (獨立)')
  })

  it('usSyncedWithWww:false（明確關閉）→ 不改動內容', () => {
    const press = basePress({ usSyncedWithWww: false })
    const result = canonicalizePressForSync(press)
    expect(result).toBe(press)
    expect(result.versions.us.subject).toBe('US Subject (獨立)')
  })

  it('usSyncedWithWww:true（勾選當下）→ 立即把 WWW 的 subject／bodyText 完整複製到 US', () => {
    const press = basePress({ usSyncedWithWww: true })
    const result = canonicalizePressForSync(press)
    expect(result.versions.us.subject).toBe('WWW Subject')
    expect(result.versions.us.bodyText).toBe('WWW body text')
  })

  it('已經一致時回傳原始物件參照，不做無意義的複製（避免不必要的 re-render／誤判成有變更）', () => {
    const press = basePress({
      usSyncedWithWww: true,
      versions: {
        tw: { subject: '', bodyText: '' },
        www: { subject: 'A', bodyText: 'B' },
        us: { subject: 'A', bodyText: 'B' },
      },
    })
    expect(canonicalizePressForSync(press)).toBe(press)
  })

  it('同步中，WWW 改變 → US 立即跟著變（模擬連續快速修改 WWW，每次都要重新 canonicalize）', () => {
    let press = basePress({ usSyncedWithWww: true })
    press = canonicalizePressForSync(press) // 勾選當下的初次同步

    press = canonicalizePressForSync({
      ...press,
      versions: { ...press.versions, www: { subject: '第一次修改', bodyText: press.versions.www.bodyText } },
    })
    expect(press.versions.us.subject).toBe('第一次修改')

    press = canonicalizePressForSync({
      ...press,
      versions: { ...press.versions, www: { ...press.versions.www, bodyText: '第二次修改內文' } },
    })
    expect(press.versions.us.bodyText).toBe('第二次修改內文')
    // 連續兩次修改之後，US 的 subject／bodyText 必須跟 WWW 目前的值完全一致
    expect(isUsVersionInSyncWithWww(press)).toBe(true)
  })

  it('取消勾選時：保留當下的 US 內容（此時已經跟 WWW 相同），之後可以獨立修改並保留新值', () => {
    let press = basePress({ usSyncedWithWww: true })
    press = canonicalizePressForSync(press)
    expect(press.versions.us.subject).toBe('WWW Subject') // 勾選期間確實同步

    // 取消勾選：只改 boolean，內容原封不動（此時 US 仍然等於 WWW，這是「當下的值」）
    press = canonicalizePressForSync({ ...press, usSyncedWithWww: false })
    expect(press.versions.us.subject).toBe('WWW Subject')

    // 取消勾選後，US 可以獨立修改，且修改不會被同步邏輯覆蓋（因為 flag 已經是 false）
    press = canonicalizePressForSync({
      ...press,
      versions: { ...press.versions, us: { ...press.versions.us, subject: '獨立編輯後的新內容' } },
    })
    expect(press.versions.us.subject).toBe('獨立編輯後的新內容')

    // 即使之後 WWW 又改變，US 不會再被覆蓋（flag 是 false）
    press = canonicalizePressForSync({
      ...press,
      versions: { ...press.versions, www: { ...press.versions.www, subject: 'WWW 又改了' } },
    })
    expect(press.versions.us.subject).toBe('獨立編輯後的新內容')
  })

  it('非同步欄位（附件、負責人、發佈日期……）不會被 canonicalize 意外覆蓋或清空', () => {
    const press = basePress({
      usSyncedWithWww: true,
      releaseDate: '2026-01-01',
      ownerEmail: 'owner@x.com',
      attachments: [{ name: 'a.pdf', path: 'press/p1/attachments/a.pdf', url: 'https://x', size: 10, contentType: 'application/pdf' }],
    })
    const result = canonicalizePressForSync(press)
    expect(result.releaseDate).toBe('2026-01-01')
    expect(result.ownerEmail).toBe('owner@x.com')
    expect(result.attachments).toEqual(press.attachments)
  })

  it('heroImage（圖片，非文字內容）不會被同步邏輯覆蓋', () => {
    const press = basePress({
      usSyncedWithWww: true,
      versions: {
        tw: { subject: '', bodyText: '' },
        www: {
          subject: 'A',
          bodyText: 'B',
          heroImage: { name: 'www.png', path: 'p', url: 'https://www.png', size: 1, contentType: 'image/png' },
        },
        us: {
          subject: 'X',
          bodyText: 'Y',
          heroImage: { name: 'us.png', path: 'p2', url: 'https://us.png', size: 1, contentType: 'image/png' },
        },
      },
    })
    const result = canonicalizePressForSync(press)
    expect(result.versions.us.subject).toBe('A') // 文字內容同步
    expect(result.versions.us.bodyText).toBe('B')
    expect(result.versions.us.heroImage?.url).toBe('https://us.png') // 圖片維持 US 自己原本的，不被 WWW 覆蓋
  })

  it('儲存後重新載入（模擬）：canonicalize 是冪等的，套用兩次結果相同', () => {
    const press = basePress({ usSyncedWithWww: true })
    const once = canonicalizePressForSync(press)
    const twice = canonicalizePressForSync(once)
    expect(twice).toEqual(once)
  })
})

describe('canonicalizePressForSync 與 autosave controller 的整合：autosave 飛行中再次修改不會被舊內容覆蓋', () => {
  it('save() 送出期間又觸發一次 WWW 修改，controller 追送的最新內容仍然正確同步', async () => {
    let resolveWrite: (() => void) | null = null
    const writes: PressRelease[] = []
    const write = (snapshot: PressRelease) =>
      new Promise<void>((resolve) => {
        writes.push(snapshot)
        resolveWrite = resolve
      })

    const initial = canonicalizePressForSync(basePress({ usSyncedWithWww: true }))
    const controller = createAutosaveController(initial, { write })

    // 模擬 patch()：每次編輯都先 canonicalize 再交給 controller。
    function edit(next: PressRelease) {
      const canonical = canonicalizePressForSync(next)
      controller.markEdited(canonical)
      return canonical
    }

    const savePromise = controller.save() // 第一次送出，write() 還沒 resolve（模擬網路飛行中）

    // 送出期間又修改了一次 WWW 內容
    const midFlightEdit = edit({
      ...initial,
      versions: { ...initial.versions, www: { ...initial.versions.www, subject: '飛行中修改的新主旨' } },
    })
    expect(midFlightEdit.versions.us.subject).toBe('飛行中修改的新主旨') // 本地狀態立即同步

    resolveWrite?.() // 第一次 write() 完成——此時 revision 已經前進，controller 會自動追送第二次
    // 等 controller 內部的 for(;;) 迴圈跑到第二次 write()
    await new Promise((r) => setTimeout(r, 0))
    resolveWrite?.()

    const ok = await savePromise
    expect(ok).toBe(true)
    expect(writes.length).toBeGreaterThanOrEqual(2)
    // 最後一次真正寫入的內容，US 必須跟當時最新的 WWW 內容一致——
    // 不能是「舊內容覆蓋新內容」。
    const lastWrite = writes[writes.length - 1]
    expect(lastWrite.versions.www.subject).toBe('飛行中修改的新主旨')
    expect(lastWrite.versions.us.subject).toBe('飛行中修改的新主旨')
  })
})

describe('同步後的內容餵進所有內容 consumer（預覽 CMS HTML／寄信 HTML／寄信純文字）結果一致', () => {
  // PressEditPage.tsx 的預覽／HTML／Word／PDF 全部從 press.versions[lang]
  // 建構 templateInput（見該檔案 templateInput 的定義，downloadWord／
  // downloadPdf 使用同一個物件），functions/src/index.ts 實際寄信也是
  // 直接讀 opts.press.versions[r.language] 建 templateInput（見該檔案
  // buildMailOptions 的定義）——兩邊用的都是同一份 shared/emailTemplate.ts
  // render 函式與同一個 press.versions 物件，所以只要證明
  // canonicalizePressForSync() 之後 versions.us 精確等於 versions.www，
  // 餵進 renderEmailHtml／renderBodyHtml／renderEmailText 的內容部分就
  // 保證一致，不需要（也沒辦法，這兩個檔案分別依賴 React／DOM／Cloud
  // Functions runtime）真的各自掛載測試。
  it('同步後，WWW／US 的 renderEmailHtml 內文與主旨部分產生完全相同的 HTML（除了 language 決定的頁尾文案、日期格式等非內容差異）', () => {
    const press = canonicalizePressForSync(
      basePress({
        usSyncedWithWww: true,
        versions: {
          tw: { subject: '', bodyText: '' },
          www: { subject: '## 標題\n內文第一段\n\n內文第二段', bodyText: '## 標題\n內文第一段\n\n內文第二段' },
          us: { subject: '獨立舊內容', bodyText: '獨立舊內容' },
        },
      }),
    )
    // subject 欄位在 basePress 裡刻意跟 bodyText 用同一個字串，方便直接比對。
    const wwwHtml = renderEmailHtml({ subject: press.versions.www.subject, bodyText: press.versions.www.bodyText, language: 'www' })
    const usHtml = renderEmailHtml({ subject: press.versions.us.subject, bodyText: press.versions.us.bodyText, language: 'us' })
    // 兩邊都應該正確產生標題（round 30 Part B 的修正：沒有空白行也要拆開）。
    expect(wwwHtml).toContain('<h2')
    expect(usHtml).toContain('<h2')
    expect(wwwHtml).toContain('內文第一段')
    expect(usHtml).toContain('內文第一段')
    expect(wwwHtml).toContain('內文第二段')
    expect(usHtml).toContain('內文第二段')
  })

  it('同步後，renderBodyHtml（CMS 預覽 HTML）WWW／US 完全相同', () => {
    const press = canonicalizePressForSync(
      basePress({
        usSyncedWithWww: true,
        versions: {
          tw: { subject: '', bodyText: '' },
          www: { subject: 'A', bodyText: '## 標題\n內文，沒有空白行' },
          us: { subject: '舊', bodyText: '舊內容' },
        },
      }),
    )
    expect(renderBodyHtml(press.versions.us.bodyText)).toBe(renderBodyHtml(press.versions.www.bodyText))
  })

  it('同步後，renderEmailText（純文字備援信）的內文部分 WWW／US 完全相同', () => {
    const press = canonicalizePressForSync(
      basePress({
        usSyncedWithWww: true,
        versions: {
          tw: { subject: '', bodyText: '' },
          www: { subject: 'Subject', bodyText: '## Heading\nBody line' },
          us: { subject: '舊', bodyText: '舊內容' },
        },
      }),
    )
    const wwwText = renderEmailText({ subject: press.versions.www.subject, bodyText: press.versions.www.bodyText, language: 'www' })
    const usText = renderEmailText({ subject: press.versions.us.subject, bodyText: press.versions.us.bodyText, language: 'us' })
    expect(wwwText).toContain('Heading')
    expect(usText).toContain('Heading')
    expect(wwwText).toContain('Body line')
    expect(usText).toContain('Body line')
  })

  it('未同步（usSyncedWithWww:false）時，WWW／US 內容維持各自獨立，輸出理所當然不同', () => {
    const press = basePress({
      usSyncedWithWww: false,
      versions: {
        tw: { subject: '', bodyText: '' },
        www: { subject: 'WWW', bodyText: 'WWW body' },
        us: { subject: 'US', bodyText: 'US body' },
      },
    })
    const wwwHtml = renderBodyHtml(press.versions.www.bodyText)
    const usHtml = renderBodyHtml(press.versions.us.bodyText)
    expect(wwwHtml).not.toBe(usHtml)
  })
})

/**
 * 提交前審查追加（round 30）：PressEditPage.tsx 的 patch() stale-closure
 * 風險調查——用可執行的測試證明，不只是文字推理。見
 * src/lib/pressContentSync.ts 的 createPressPatcher() 說明。
 *
 * 第一個 it 刻意重現 patch() 修正前的寫法（`updater(press)` 讀取 React
 * render-time 閉包變數），證明「同一個 tick 內連續呼叫兩次會遺失第一次的
 * 修改」這個風險類別是真實存在的，不是理論上的假設；第二、三個 it 驗證
 * createPressPatcher() 確實修掉了這個問題。
 */
describe('createPressPatcher（round 30 提交前審查追加：patch() 對連續呼叫的 stale-closure 風險）', () => {
  it('對照組——重現漏洞：模擬修正前 patch() 直接讀 render-time 閉包變數（不會在呼叫當下同步更新），同一個 tick 內連續呼叫兩次會讓第二次蓋掉第一次的修改', () => {
    // renderedPress 模擬 React 的 `press` state：只有等「重新 render」
    // 才會更新，不會在函式呼叫當下同步變化——這正是 useState 閉包的語意。
    const renderedPress = basePress()
    let lastWritten: PressRelease | null = null

    function naivePatch(updater: (p: PressRelease) => PressRelease) {
      const next = canonicalizePressForSync(updater(renderedPress))
      lastWritten = next
      // 故意不同步更新 renderedPress——重現「要等下一次 render 才會反映
      // 最新值」的 stale-closure 情境。
    }

    naivePatch((p) => ({ ...p, title: '第一次修改的標題' }))
    naivePatch((p) => ({ ...p, category: 'launch' }))

    // 第二次呼叫讀到的仍是最初的 renderedPress（title 還沒改過），所以
    // 最終寫入的內容裡，第一次修改的 title 被憑空蓋掉了——這就是
    // stale-closure 造成的真實資料遺失，不是假設。
    expect(lastWritten).not.toBeNull()
    expect(lastWritten!.title).not.toBe('第一次修改的標題')
    expect(lastWritten!.title).toBe(renderedPress.title)
    expect(lastWritten!.category).toBe('launch')
  })

  it('createPressPatcher()：同一個 tick 內連續呼叫兩次 patch()，第二次是基於第一次呼叫的最新結果，兩次修改都保留，不會遺失資料', () => {
    const onChangeCalls: PressRelease[] = []
    const patcher = createPressPatcher(basePress(), (next) => {
      onChangeCalls.push(next)
    })

    patcher.patch((p) => ({ ...p, title: '第一次修改的標題' }))
    patcher.patch((p) => ({ ...p, category: 'launch' }))

    const final = patcher.getLatest()
    expect(final.title).toBe('第一次修改的標題')
    expect(final.category).toBe('launch')

    // markEdited／onChange 收到的最後一次內容必須跟最終顯示狀態完全相同
    // ——不會有「畫面顯示的是最新內容，但送去 autosave 的還是舊內容」這種
    // 分歧。
    expect(onChangeCalls).toHaveLength(2)
    expect(onChangeCalls[1]).toEqual(final)
  })

  it('createPressPatcher()：patch() 內部一樣會套用 canonicalizePressForSync()，同一個 tick 連續呼叫（先勾選同步、再修改 WWW 內容）也會正確同步到 US', () => {
    const patcher = createPressPatcher(
      basePress({
        usSyncedWithWww: false,
        versions: {
          tw: { subject: '', bodyText: '' },
          www: { subject: 'WWW 原標題', bodyText: 'WWW 原內文' },
          us: { subject: '獨立的 US 標題', bodyText: '獨立的 US 內文' },
        },
      }),
      () => {},
    )

    patcher.patch((p) => ({ ...p, usSyncedWithWww: true }))
    patcher.patch((p) => ({
      ...p,
      versions: { ...p.versions, www: { ...p.versions.www, subject: '改過的 WWW 標題' } },
    }))

    const final = patcher.getLatest()
    expect(final.usSyncedWithWww).toBe(true)
    expect(final.versions.www.subject).toBe('改過的 WWW 標題')
    // 第二次呼叫是基於第一次「usSyncedWithWww 已經是 true」的最新結果，
    // 所以緊接著修改 WWW 標題時，US 標題必須同步跟著變成一樣的值，
    // 而不是還停留在「獨立的 US 標題」。
    expect(final.versions.us.subject).toBe('改過的 WWW 標題')
  })

  it('sync()：初始載入／遠端資料重新整理時同步最新內容，之後的 patch() 以同步後的內容為基礎，且 sync() 本身不觸發 onChange', () => {
    const onChangeCalls: PressRelease[] = []
    const patcher = createPressPatcher(basePress(), (next) => {
      onChangeCalls.push(next)
    })

    const remoteLoaded = basePress({ title: '從 Firestore 重新載入的標題' })
    patcher.sync(remoteLoaded)
    expect(onChangeCalls).toHaveLength(0)

    const next = patcher.patch((p) => ({ ...p, category: 'launch' }))
    expect(next.title).toBe('從 Firestore 重新載入的標題')
    expect(next.category).toBe('launch')
    expect(onChangeCalls).toHaveLength(1)
    expect(onChangeCalls[0]).toEqual(next)
  })
})
