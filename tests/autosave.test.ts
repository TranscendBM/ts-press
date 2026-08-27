import { describe, expect, it, vi } from 'vitest'
import { createAutosaveController } from '../src/lib/autosave'

/** 建立一個「手動控制何時完成」的 write()，方便精準模擬競態情境。 */
function deferredWrite<T>() {
  const calls: T[] = []
  let resolveCurrent: (() => void) | null = null
  let rejectCurrent: ((err: unknown) => void) | null = null
  const write = (snapshot: T) =>
    new Promise<void>((resolve, reject) => {
      calls.push(snapshot)
      resolveCurrent = resolve
      rejectCurrent = reject
    })
  return {
    write,
    calls,
    resolveLatest: () => resolveCurrent?.(),
    rejectLatest: (err: unknown) => rejectCurrent?.(err),
  }
}

describe('createAutosaveController', () => {
  it('save 期間沒有新的編輯 → dirty 清除', async () => {
    const onDirtyChange = vi.fn()
    const controller = createAutosaveController(
      { v: 1 },
      { write: async () => {}, onDirtyChange },
    )
    controller.markEdited({ v: 2 })
    expect(onDirtyChange).toHaveBeenLastCalledWith(true)

    const ok = await controller.save()

    expect(ok).toBe(true)
    expect(onDirtyChange).toHaveBeenLastCalledWith(false)
  })

  it('save 期間繼續輸入 → dirty 保留並自動再送一次，最終追上最新內容', async () => {
    const { write, calls, resolveLatest } = deferredWrite<{ v: number }>()
    const onDirtyChange = vi.fn()
    const controller = createAutosaveController({ v: 0 }, { write, onDirtyChange })

    controller.markEdited({ v: 1 })
    const savePromise = controller.save()

    // 第一次 request 已經送出（帶著 v:1），但還沒完成時使用者又編輯了
    expect(calls).toEqual([{ v: 1 }])
    controller.markEdited({ v: 2 })

    // 第一次 request 完成 → revision 已經變了，不能清 dirty，要立刻再送一次
    resolveLatest()
    await Promise.resolve()
    await Promise.resolve()
    expect(onDirtyChange).not.toHaveBeenLastCalledWith(false)
    expect(calls).toEqual([{ v: 1 }, { v: 2 }])

    // 第二次（也是最新一次）request 完成，這次才真的追上最新內容
    resolveLatest()
    const ok = await savePromise

    expect(ok).toBe(true)
    expect(onDirtyChange).toHaveBeenLastCalledWith(false)
    expect(calls).toEqual([{ v: 1 }, { v: 2 }])
  })

  it('第一個 request 晚於第二個完成也不會覆蓋新內容（一次只允許一個 request 飛行）', async () => {
    const { write, calls, resolveLatest } = deferredWrite<{ v: number }>()
    const controller = createAutosaveController({ v: 0 }, { write })

    controller.markEdited({ v: 1 })
    const p1 = controller.save()
    // save() 呼叫時已經有一次在飛行，這裡不會並行送出第二個 request
    controller.markEdited({ v: 2 })
    const p2 = controller.save()

    // 目前只送出過一次 request（v:1），v:2 還在排隊，不存在「兩個並行 request」
    expect(calls).toEqual([{ v: 1 }])

    resolveLatest() // 完成 v:1 → 發現已過期，立刻送出 v:2
    await Promise.resolve()
    await Promise.resolve()
    expect(calls).toEqual([{ v: 1 }, { v: 2 }])

    resolveLatest() // 完成 v:2 → 追上最新，兩個呼叫都拿到同一個結果
    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1).toBe(true)
    expect(r2).toBe(true)
    // 資料庫最終停在最新版本 v:2，不會被「較晚完成的舊版」蓋掉
    expect(calls.at(-1)).toEqual({ v: 2 })
  })

  it('儲存失敗 → dirty 保留，並回報錯誤', async () => {
    const onDirtyChange = vi.fn()
    const onError = vi.fn()
    const controller = createAutosaveController(
      { v: 1 },
      {
        write: async () => {
          throw new Error('offline')
        },
        onDirtyChange,
        onError,
      },
    )
    controller.markEdited({ v: 2 })

    const ok = await controller.save()

    expect(ok).toBe(false)
    expect(onError).toHaveBeenCalledOnce()
    // 失敗後不會呼叫 onDirtyChange(false)，dirty 維持 true
    expect(onDirtyChange).not.toHaveBeenCalledWith(false)
  })

  it('saving 狀態涵蓋整個追趕迴圈，結束後歸位', async () => {
    const { write, resolveLatest } = deferredWrite<{ v: number }>()
    const onSavingChange = vi.fn()
    const controller = createAutosaveController(
      { v: 1 },
      { write, onSavingChange },
    )
    controller.markEdited({ v: 2 })
    const p = controller.save()
    expect(onSavingChange).toHaveBeenLastCalledWith(true)
    resolveLatest()
    await p
    expect(onSavingChange).toHaveBeenLastCalledWith(false)
  })
})

describe('createAutosaveController + saveThenNavigate 整合：前往發送只有最新版成功儲存後才可導航', () => {
  it('導航前呼叫的 save() 涵蓋了呼叫當下最新的編輯', async () => {
    const { saveThenNavigate } = await import('../src/lib/saveThenNavigate')
    const { write, calls, resolveLatest } = deferredWrite<{ v: number }>()
    const controller = createAutosaveController({ v: 0 }, { write })
    const navigate = vi.fn()

    controller.markEdited({ v: 1 })
    const navigatePromise = saveThenNavigate({
      dirty: true,
      save: () => controller.save(),
      navigate,
    })

    // 導航流程呼叫 save() 期間使用者又編輯了一次
    controller.markEdited({ v: 2 })
    resolveLatest() // 完成 v:1（已過期）→ 內部自動再送 v:2
    await Promise.resolve()
    await Promise.resolve()
    expect(navigate).not.toHaveBeenCalled()
    resolveLatest() // 完成 v:2（最新）

    const ok = await navigatePromise

    expect(ok).toBe(true)
    expect(navigate).toHaveBeenCalledOnce()
    expect(calls.at(-1)).toEqual({ v: 2 })
  })

  it('save 失敗時不導航，讓使用者知道還有未儲存的內容', async () => {
    const { saveThenNavigate } = await import('../src/lib/saveThenNavigate')
    const controller = createAutosaveController(
      { v: 1 },
      {
        write: async () => {
          throw new Error('network down')
        },
      },
    )
    const navigate = vi.fn()
    controller.markEdited({ v: 2 })

    const ok = await saveThenNavigate({
      dirty: true,
      save: () => controller.save(),
      navigate,
    })

    expect(ok).toBe(false)
    expect(navigate).not.toHaveBeenCalled()
  })
})
