import { describe, expect, it, vi } from 'vitest'
import {
  collectPressFilePaths,
  deletePressReleaseWithCleanup,
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
      removed: ['press/p1/attachments/a.pdf', 'press/p1/hero/tw.png'],
      queued: [],
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
      removed: ['press/p1/hero/tw.png'],
      queued: ['press/p1/attachments/a.pdf'],
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
    expect(result).toEqual({ removed: [], queued: [] })
  })
})
