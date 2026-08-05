import { describe, expect, it } from 'vitest'
import {
  ATTACHMENT_LIMITS,
  BATCH_SIZE,
  chunk,
  evaluateAccess,
  expandInternalCopies,
  isAllowedAttachmentPath,
  parseEmailList,
} from '../shared/policy'

describe('evaluateAccess', () => {
  const verified = { email: 'a@b.com', emailVerified: true }

  it('拒絕未登入', () => {
    const r = evaluateAccess({ needsSendRole: false })
    expect(r.ok).toBe(false)
  })

  it('拒絕信箱未驗證的帳號', () => {
    const r = evaluateAccess({
      email: 'a@b.com',
      emailVerified: false,
      userDoc: { role: 'admin', active: true },
      needsSendRole: false,
    })
    expect(r).toEqual({ ok: false, reason: 'Google 帳號的信箱尚未通過驗證。' })
  })

  it('emailVerified 未提供時視同未驗證', () => {
    const r = evaluateAccess({
      email: 'a@b.com',
      userDoc: { role: 'admin', active: true },
      needsSendRole: false,
    })
    expect(r.ok).toBe(false)
  })

  it('拒絕不在白名單的帳號', () => {
    const r = evaluateAccess({ ...verified, needsSendRole: false })
    expect(r.ok).toBe(false)
  })

  it('active 缺失視為未啟用', () => {
    const r = evaluateAccess({
      ...verified,
      userDoc: { role: 'admin' },
      needsSendRole: false,
    })
    expect(r.ok).toBe(false)
  })

  it('active 為 false 視為未啟用', () => {
    const r = evaluateAccess({
      ...verified,
      userDoc: { role: 'admin', active: false },
      needsSendRole: false,
    })
    expect(r.ok).toBe(false)
  })

  it('active 為字串 "true" 不算啟用', () => {
    const r = evaluateAccess({
      ...verified,
      userDoc: { role: 'admin', active: 'true' },
      needsSendRole: false,
    })
    expect(r.ok).toBe(false)
  })

  it('editor 可以使用系統但不能正式發送', () => {
    const doc = { role: 'editor', active: true }
    expect(evaluateAccess({ ...verified, userDoc: doc, needsSendRole: false }).ok).toBe(true)
    expect(evaluateAccess({ ...verified, userDoc: doc, needsSendRole: true }).ok).toBe(false)
  })

  it('admin 與 manager 可以正式發送', () => {
    for (const role of ['admin', 'manager']) {
      const r = evaluateAccess({
        ...verified,
        userDoc: { role, active: true },
        needsSendRole: true,
      })
      expect(r.ok, role).toBe(true)
    }
  })

  it('沒有 role 欄位時不得正式發送', () => {
    const r = evaluateAccess({
      ...verified,
      userDoc: { active: true },
      needsSendRole: true,
    })
    expect(r.ok).toBe(false)
  })
})

describe('isAllowedAttachmentPath', () => {
  const id = 'abc123'

  it('接受正確的附件路徑', () => {
    expect(isAllowedAttachmentPath(`press/${id}/attachments/a.pdf`, id)).toBe(true)
    expect(
      isAllowedAttachmentPath(`press/${id}/attachments/1700000000_圖片.png`, id),
    ).toBe(true)
  })

  it('拒絕其他新聞稿的附件', () => {
    expect(isAllowedAttachmentPath('press/other/attachments/a.pdf', id)).toBe(false)
  })

  it('拒絕同一篇稿件但不同子目錄', () => {
    expect(isAllowedAttachmentPath(`press/${id}/hero/a.png`, id)).toBe(false)
  })

  it('拒絕路徑穿越', () => {
    expect(
      isAllowedAttachmentPath(`press/${id}/attachments/../../secret.txt`, id),
    ).toBe(false)
    expect(isAllowedAttachmentPath(`../press/${id}/attachments/a.pdf`, id)).toBe(false)
  })

  it('拒絕再往下的目錄階層', () => {
    expect(isAllowedAttachmentPath(`press/${id}/attachments/sub/a.pdf`, id)).toBe(false)
  })

  it('拒絕絕對路徑與其他 bucket', () => {
    expect(isAllowedAttachmentPath(`/press/${id}/attachments/a.pdf`, id)).toBe(false)
    expect(
      isAllowedAttachmentPath(`gs://other-bucket/press/${id}/attachments/a.pdf`, id),
    ).toBe(false)
    expect(
      isAllowedAttachmentPath(`https://evil.com/press/${id}/attachments/a.pdf`, id),
    ).toBe(false)
  })

  it('拒絕空位元組與反斜線', () => {
    expect(isAllowedAttachmentPath(`press/${id}/attachments/a\0.pdf`, id)).toBe(false)
    expect(isAllowedAttachmentPath(`press\\${id}\\attachments\\a.pdf`, id)).toBe(false)
  })

  it('拒絕空值與缺少檔名', () => {
    expect(isAllowedAttachmentPath(undefined, id)).toBe(false)
    expect(isAllowedAttachmentPath('', id)).toBe(false)
    expect(isAllowedAttachmentPath(`press/${id}/attachments/`, id)).toBe(false)
  })

  it('pressReleaseId 本身含有路徑字元時一律拒絕', () => {
    expect(isAllowedAttachmentPath('press/a/b/attachments/x.pdf', 'a/b')).toBe(false)
  })

  it('上限設定合理', () => {
    expect(ATTACHMENT_LIMITS.maxFileBytes).toBeLessThanOrEqual(
      ATTACHMENT_LIMITS.maxTotalBytes,
    )
    expect(ATTACHMENT_LIMITS.maxCount).toBeGreaterThan(0)
  })
})

describe('chunk', () => {
  it('批次大小不超過 Firestore 的 500 筆上限', () => {
    expect(BATCH_SIZE).toBeLessThanOrEqual(500)
    expect(BATCH_SIZE).toBeGreaterThan(0)
  })

  it('600 位收件人會分成兩批且不漏人', () => {
    const items = Array.from({ length: 600 }, (_, i) => i)
    const groups = chunk(items)
    expect(groups).toHaveLength(2)
    expect(groups[0]).toHaveLength(BATCH_SIZE)
    expect(groups.flat()).toEqual(items)
  })

  it('剛好 450 筆只有一批', () => {
    expect(chunk(Array.from({ length: 450 }, (_, i) => i))).toHaveLength(1)
  })

  it('1200 筆分成三批', () => {
    const groups = chunk(Array.from({ length: 1200 }, (_, i) => i))
    expect(groups).toHaveLength(3)
    expect(groups.every((g) => g.length <= 500)).toBe(true)
  })

  it('空陣列不產生批次', () => {
    expect(chunk([])).toEqual([])
  })

  it('批次大小不合法時丟錯', () => {
    expect(() => chunk([1, 2], 0)).toThrow()
    expect(() => chunk([1, 2], -1)).toThrow()
  })
})

describe('parseEmailList', () => {
  it('逗號/分號/換行分隔都能解析', () => {
    expect(parseEmailList('a@x.com, b@x.com; c@x.com\nd@x.com')).toEqual([
      'a@x.com',
      'b@x.com',
      'c@x.com',
      'd@x.com',
    ])
  })

  it('以小寫比對去重，保留原始大小寫', () => {
    expect(parseEmailList('Elvis@x.com, elvis@x.com')).toEqual(['Elvis@x.com'])
  })

  it('略過格式不合法的字串', () => {
    expect(parseEmailList('good@x.com, 壞的, no-at, @x.com, a@b')).toEqual([
      'good@x.com',
    ])
  })

  it('空值與非字串回傳空陣列', () => {
    expect(parseEmailList('')).toEqual([])
    expect(parseEmailList(undefined)).toEqual([])
    expect(parseEmailList(null)).toEqual([])
    expect(parseEmailList(123)).toEqual([])
  })
})

describe('expandInternalCopies', () => {
  const copies = {
    global_pr: 'alice@x.com, bob@x.com',
    us_pr: 'carol@x.com',
    tw_pr: 'dave@x.com',
  }

  it('只展開有選取的名單', () => {
    expect(expandInternalCopies(copies, ['global_pr'])).toEqual([
      { email: 'alice@x.com', list: 'global_pr' },
      { email: 'bob@x.com', list: 'global_pr' },
    ])
  })

  it('保留每個信箱來自哪個名單', () => {
    const r = expandInternalCopies(copies, ['global_pr', 'us_pr'])
    expect(r).toContainEqual({ email: 'carol@x.com', list: 'us_pr' })
    expect(r).toHaveLength(3)
  })

  it('排除已是媒體收件人的信箱（大小寫不敏感）', () => {
    const r = expandInternalCopies(copies, ['global_pr'], ['ALICE@x.com'])
    expect(r).toEqual([{ email: 'bob@x.com', list: 'global_pr' }])
  })

  it('同一人同時在多個選取名單只留一份（第一個名單勝出）', () => {
    const dup = { global_pr: 'sam@x.com', us_pr: 'sam@x.com' }
    expect(expandInternalCopies(dup, ['global_pr', 'us_pr'])).toEqual([
      { email: 'sam@x.com', list: 'global_pr' },
    ])
  })

  it('名單沒設定或設定不合法時略過', () => {
    expect(expandInternalCopies({ global_pr: '亂打, no-at' }, ['global_pr'])).toEqual(
      [],
    )
    expect(expandInternalCopies(undefined, ['global_pr'])).toEqual([])
    expect(expandInternalCopies(copies, [])).toEqual([])
  })
})
