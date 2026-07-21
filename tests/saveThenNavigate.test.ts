import { describe, expect, it, vi } from 'vitest'
import { saveThenNavigate } from '../src/lib/saveThenNavigate'

describe('saveThenNavigate', () => {
  it('儲存失敗時不得導航', async () => {
    const navigate = vi.fn()
    const save = vi.fn(async () => false)

    const ok = await saveThenNavigate({ dirty: true, save, navigate })

    expect(ok).toBe(false)
    expect(save).toHaveBeenCalledOnce()
    expect(navigate).not.toHaveBeenCalled()
  })

  it('儲存成功才導航', async () => {
    const navigate = vi.fn()
    const save = vi.fn(async () => true)

    const ok = await saveThenNavigate({ dirty: true, save, navigate })

    expect(ok).toBe(true)
    expect(navigate).toHaveBeenCalledOnce()
  })

  it('沒有未存變更時直接導航，不重複儲存', async () => {
    const navigate = vi.fn()
    const save = vi.fn(async () => true)

    const ok = await saveThenNavigate({ dirty: false, save, navigate })

    expect(ok).toBe(true)
    expect(save).not.toHaveBeenCalled()
    expect(navigate).toHaveBeenCalledOnce()
  })

  it('save 拋出例外時不導航', async () => {
    const navigate = vi.fn()
    const save = vi.fn(async () => {
      throw new Error('firestore unavailable')
    })

    await expect(
      saveThenNavigate({ dirty: true, save, navigate }),
    ).rejects.toThrow('firestore unavailable')
    expect(navigate).not.toHaveBeenCalled()
  })
})
