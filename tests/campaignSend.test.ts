import { describe, expect, it } from 'vitest'
import {
  decideCampaignResume,
  decideCampaignStatus,
  isValidIdempotencyKey,
  selectRecipientsToProcess,
} from '../shared/campaignSend'

describe('isValidIdempotencyKey', () => {
  it('接受典型的 UUID 或 8~64 碼英數字/連字號/底線', () => {
    expect(isValidIdempotencyKey('a1b2c3d4-e5f6-47a8-9b0c-1234567890ab')).toBe(
      true,
    )
    expect(isValidIdempotencyKey('abcdefgh')).toBe(true)
  })

  it('拒絕過短、非字串、或含不安全字元的值', () => {
    expect(isValidIdempotencyKey('short')).toBe(false)
    expect(isValidIdempotencyKey(undefined)).toBe(false)
    expect(isValidIdempotencyKey(123)).toBe(false)
    expect(isValidIdempotencyKey('has/slash-1234')).toBe(false)
    expect(isValidIdempotencyKey('has spaces here')).toBe(false)
    expect(isValidIdempotencyKey('a'.repeat(65))).toBe(false)
  })
})

describe('decideCampaignResume', () => {
  const req = { pressReleaseId: 'p1', mode: 'real' }

  it('沒有既有文件 → create（同一請求呼叫兩次的第一次）', () => {
    expect(decideCampaignResume(undefined, req)).toEqual({ action: 'create' })
  })

  it('既有文件屬於同一篇稿件、同一個模式、還在進行中 → resume（第二次呼叫不會重建）', () => {
    expect(
      decideCampaignResume(
        { pressReleaseId: 'p1', mode: 'real', status: 'sending' },
        req,
      ),
    ).toEqual({ action: 'resume' })
    expect(
      decideCampaignResume(
        { pressReleaseId: 'p1', mode: 'real', status: 'partial' },
        req,
      ),
    ).toEqual({ action: 'resume' })
  })

  it('既有文件已經跑完（成功或失敗）→ 回傳既有結果，不重跑', () => {
    expect(
      decideCampaignResume(
        { pressReleaseId: 'p1', mode: 'real', status: 'completed' },
        req,
      ),
    ).toEqual({ action: 'return-existing-result' })
    expect(
      decideCampaignResume(
        { pressReleaseId: 'p1', mode: 'real', status: 'failed' },
        req,
      ),
    ).toEqual({ action: 'return-existing-result' })
  })

  it('同一個 key 被用在不同新聞稿或不同模式 → 拒絕', () => {
    const r1 = decideCampaignResume(
      { pressReleaseId: 'OTHER', mode: 'real', status: 'sending' },
      req,
    )
    expect(r1.action).toBe('reject')
    const r2 = decideCampaignResume(
      { pressReleaseId: 'p1', mode: 'testList', status: 'sending' },
      req,
    )
    expect(r2.action).toBe('reject')
  })
})

describe('decideCampaignStatus', () => {
  it('remaining > 0 → partial，不論成敗', () => {
    expect(
      decideCampaignStatus({ recipients: 10, sent: 5, failed: 0 }, 5),
    ).toBe('partial')
    expect(
      decideCampaignStatus({ recipients: 10, sent: 0, failed: 5 }, 5),
    ).toBe('partial')
  })

  it('全部處理完、全部失敗 → failed', () => {
    expect(
      decideCampaignStatus({ recipients: 3, sent: 0, failed: 3 }, 0),
    ).toBe('failed')
  })

  it('全部處理完、至少一封成功 → completed', () => {
    expect(
      decideCampaignStatus({ recipients: 3, sent: 2, failed: 1 }, 0),
    ).toBe('completed')
    expect(
      decideCampaignStatus({ recipients: 3, sent: 3, failed: 0 }, 0),
    ).toBe('completed')
  })

  it('沒有任何收件人也算 completed（不會被 0/0 誤判成 failed）', () => {
    expect(
      decideCampaignStatus({ recipients: 0, sent: 0, failed: 0 }, 0),
    ).toBe('completed')
  })
})

describe('selectRecipientsToProcess', () => {
  it('已經是 sent 的一律跳過（同一請求呼叫兩次不會重複寄送）', () => {
    const recipients = [
      { id: 'a', status: 'sent' as const },
      { id: 'b', status: 'queued' as const },
      { id: 'c', status: 'sent' as const },
    ]
    const { toProcess, remaining } = selectRecipientsToProcess(recipients, 10)
    expect(toProcess).toEqual(['b'])
    expect(remaining).toBe(0)
  })

  it('sending／failed／queued 都視為需要（重新）處理', () => {
    const recipients = [
      { id: 'a', status: 'queued' as const },
      { id: 'b', status: 'sending' as const },
      { id: 'c', status: 'failed' as const },
    ]
    const { toProcess } = selectRecipientsToProcess(recipients, 10)
    expect(toProcess).toEqual(['a', 'b', 'c'])
  })

  it('超過上限只取前 limit 位，其餘算進 remaining（大於單批上限時正確切批）', () => {
    const recipients = Array.from({ length: 1200 }, (_, i) => ({
      id: `r${i}`,
      status: 'queued' as const,
    }))
    const { toProcess, remaining } = selectRecipientsToProcess(recipients, 300)
    expect(toProcess).toHaveLength(300)
    expect(remaining).toBe(900)
  })

  it('沒有需要處理的人時回傳空陣列', () => {
    const recipients = [{ id: 'a', status: 'sent' as const }]
    expect(selectRecipientsToProcess(recipients, 300)).toEqual({
      toProcess: [],
      remaining: 0,
    })
  })

  it('同一個 id 重複出現只算一次（防呆）', () => {
    const recipients = [
      { id: 'a', status: 'queued' as const },
      { id: 'a', status: 'queued' as const },
    ]
    const { toProcess } = selectRecipientsToProcess(recipients, 300)
    expect(toProcess).toEqual(['a'])
  })
})
