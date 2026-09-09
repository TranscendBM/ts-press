import { describe, expect, it, vi } from 'vitest'
import {
  collectPressFilePaths,
  deletePressReleaseWithCleanup,
  hasExceededCleanupAttempts,
  isCleanupItemClaimable,
  MAX_CLEANUP_ATTEMPTS,
} from '../shared/pressCleanup'

describe('collectPressFilePaths', () => {
  it('收集附件與所有語言版本的 hero 圖片路徑', () => {
    const paths = collectPressFilePaths({
      attachments: [{ path: 'press/p1/attachments/a.pdf' }, { path: 'press/p1/attachments/b.pdf' }],
      versions: {
        tw: { heroImage: { path: 'press/p1/hero/tw.png' } },
        www: { heroImage: { path: 'press/p1/hero/www.png' } },
        us: undefined,
      },
    })
    expect(paths).toEqual([
      'press/p1/attachments/a.pdf',
      'press/p1/attachments/b.pdf',
      'press/p1/hero/tw.png',
      'press/p1/hero/www.png',
    ])
  })

  it('沒有附件或 hero 圖片時回傳空陣列', () => {
    expect(collectPressFilePaths({})).toEqual([])
    expect(collectPressFilePaths({ attachments: [], versions: {} })).toEqual([])
  })

  it('略過沒有 path 欄位的項目', () => {
    expect(
      collectPressFilePaths({
        attachments: [{}],
        versions: { tw: { heroImage: {} } },
      }),
    ).toEqual([])
  })
})

describe('deletePressReleaseWithCleanup', () => {
  it('正常情況：文件與所有檔案都成功刪除', async () => {
    const deleteDoc = vi.fn(async () => {})
    const deleteFile = vi.fn(async () => {})
    const queueRetry = vi.fn(async () => {})

    const result = await deletePressReleaseWithCleanup(
      ['press/p1/attachments/a.pdf', 'press/p1/hero/tw.png'],
      { deleteDoc, deleteFile, queueRetry },
    )

    expect(deleteDoc).toHaveBeenCalledOnce()
    expect(deleteFile).toHaveBeenCalledTimes(2)
    expect(queueRetry).not.toHaveBeenCalled()
    expect(result).toEqual({
      documentDeleted: true,
      filesRemoved: ['press/p1/attachments/a.pdf', 'press/p1/hero/tw.png'],
      cleanupQueued: [],
      cleanupQueueWriteFailed: [],
    })
  })

  it('Firestore 文件刪除失敗時：完全不會嘗試刪除任何 Storage 檔案（舊檔仍可用）', async () => {
    const deleteDoc = vi.fn(async () => {
      throw new Error('firestore unavailable')
    })
    const deleteFile = vi.fn(async () => {})
    const queueRetry = vi.fn(async () => {})

    await expect(
      deletePressReleaseWithCleanup(['press/p1/attachments/a.pdf'], {
        deleteDoc,
        deleteFile,
        queueRetry,
      }),
    ).rejects.toThrow('firestore unavailable')

    expect(deleteFile).not.toHaveBeenCalled()
    expect(queueRetry).not.toHaveBeenCalled()
  })

  it('Storage 清理失敗時：記錄下來供重試，且不影響其他檔案的清理（資料可重試）', async () => {
    const deleteDoc = vi.fn(async () => {})
    const deleteFile = vi
      .fn()
      .mockRejectedValueOnce(new Error('object locked'))
      .mockResolvedValueOnce(undefined)
    const queueRetry = vi.fn(async () => {})

    const result = await deletePressReleaseWithCleanup(
      ['press/p1/attachments/a.pdf', 'press/p1/hero/tw.png'],
      { deleteDoc, deleteFile, queueRetry },
    )

    expect(deleteFile).toHaveBeenCalledTimes(2)
    expect(queueRetry).toHaveBeenCalledExactlyOnceWith(
      'press/p1/attachments/a.pdf',
      'object locked',
    )
    expect(result).toEqual({
      documentDeleted: true,
      filesRemoved: ['press/p1/hero/tw.png'],
      cleanupQueued: ['press/p1/attachments/a.pdf'],
      cleanupQueueWriteFailed: [],
    })
  })

  it('deleteFile 與 queueRetry 都失敗時：文件仍視為刪除成功，不誤報成刪除失敗；孤兒檔案被明確列出', async () => {
    const deleteDoc = vi.fn(async () => {})
    const deleteFile = vi.fn(async () => {
      throw new Error('storage down')
    })
    const queueRetry = vi.fn(async () => {
      throw new Error('firestore also down')
    })

    // 不應該拋錯 —— deleteDoc() 本身成功了，整個流程的回傳值必須反映
    // 「文件已刪除、部分檔案清理失敗且連記錄都失敗」，而不是整體失敗。
    const result = await deletePressReleaseWithCleanup(
      ['press/p1/attachments/a.pdf'],
      { deleteDoc, deleteFile, queueRetry },
    )

    expect(result).toEqual({
      documentDeleted: true,
      filesRemoved: [],
      cleanupQueued: [],
      cleanupQueueWriteFailed: ['press/p1/attachments/a.pdf'],
    })
  })

  it('沒有任何檔案時只刪文件，不呼叫 deleteFile', async () => {
    const deleteDoc = vi.fn(async () => {})
    const deleteFile = vi.fn(async () => {})
    const result = await deletePressReleaseWithCleanup([], {
      deleteDoc,
      deleteFile,
      queueRetry: vi.fn(async () => {}),
    })
    expect(deleteFile).not.toHaveBeenCalled()
    expect(result.filesRemoved).toEqual([])
    expect(result.cleanupQueued).toEqual([])
  })
})

describe('isCleanupItemClaimable', () => {
  const T0 = 1_700_000_000_000

  it('done／failed 永遠不可認領', () => {
    expect(isCleanupItemClaimable({ status: 'done' }, T0)).toBe(false)
    expect(isCleanupItemClaimable({ status: 'failed' }, T0)).toBe(false)
  })

  it('pending 一律可以認領', () => {
    expect(isCleanupItemClaimable({ status: 'pending' }, T0)).toBe(true)
  })

  it('processing 且租期未過 → 不可認領（避免兩個 processor 併發處理同一項目）', () => {
    expect(
      isCleanupItemClaimable({ status: 'processing', leaseExpiresAtMs: T0 + 1000 }, T0),
    ).toBe(false)
  })

  it('processing 但租期已過 → 可以認領', () => {
    expect(
      isCleanupItemClaimable({ status: 'processing', leaseExpiresAtMs: T0 - 1 }, T0),
    ).toBe(true)
  })
})

describe('hasExceededCleanupAttempts', () => {
  it('未達上限 → false，達到或超過 → true（永久失敗有明確終止條件，不會無限循環）', () => {
    expect(hasExceededCleanupAttempts(MAX_CLEANUP_ATTEMPTS - 1)).toBe(false)
    expect(hasExceededCleanupAttempts(MAX_CLEANUP_ATTEMPTS)).toBe(true)
    expect(hasExceededCleanupAttempts(MAX_CLEANUP_ATTEMPTS + 1)).toBe(true)
  })

  it('可傳自訂上限', () => {
    expect(hasExceededCleanupAttempts(2, 2)).toBe(true)
    expect(hasExceededCleanupAttempts(1, 2)).toBe(false)
  })
})
