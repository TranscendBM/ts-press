import { describe, expect, it, vi } from 'vitest'
import {
  CAMPAIGN_FUNCTION_TIMEOUT_MS,
  CAMPAIGN_LEASE_MS,
  type CampaignDrainAuditInput,
  type CampaignDrainClassification,
  type CampaignTotalsForFinalize,
  classifyCampaignForDrainAudit,
  isDrainAuditBlocking,
  classifyLeaseForAudit,
  classifyLeaseGenerationForDrainAudit,
  classifyRecipientForDrainAudit,
  parseLeaseOwner,
  classifySetupPhaseForDrainAudit,
  type RecipientDrainSample,
  type SetupPhaseAuditInput,
  type CommitSentResultDeps,
  commitSentResultOrMarkUnknown,
  countNonTerminalRecipients,
  decideAcquireCampaignLease,
  decideAcquireResolutionLease,
  decideBeginDeliveryAttempt,
  decideCampaignResume,
  decideCampaignStatus,
  decideCampaignStatusRepair,
  repairCampaignStatusTx,
  decideCommitRecipientResult,
  type DeliveryUnknownResolutionAction,
  decideFinalizeCampaign,
  decideFinalizeCampaignWithPressRelease,
  decideMarkCampaignFailed,
  decidePressReleaseSyncRepair,
  decideReclaimAbandonedSetup,
  decideReclaimExpiredDeliveryAttempt,
  decideRecipientClaim,
  decideResolveDeliveryUnknown,
  decideResolveDeliveryUnknownPreflight,
  coordinateResolveDeliveryUnknown,
  type CoordinateResolveDeliveryUnknownRefs,
  parseResolutionEventRecord,
  type ResolveDeliveryUnknownPreflightDecision,
  finalizeCampaignWithPressReleaseTx,
  hasExceededMaxAttempts,
  isCampaignLeaseHeldByOther,
  isLeaseActive,
  isRecipientClaimable,
  isRetriableCampaignStatus,
  isTerminalCampaignStatus,
  isKnownCampaignStatus,
  type KnownCampaignStatus,
  isTimestampLike,
  isPlausibleCompletedAtMs,
  PLAUSIBLE_COMPLETED_AT_MIN_MS,
  PLAUSIBLE_COMPLETED_AT_CLOCK_SKEW_MS,
  isValidAuthoritativeTotalsShape,
  isValidGeneration,
  isValidIdempotencyKey,
  MAX_RECIPIENT_ATTEMPTS,
  processOneRecipient,
  type ProcessRecipientDeps,
  readFirstValidMs,
  readLeaseGeneration,
  readMsCompat,
  reconcileCampaignDelivery,
  type ReconcileCampaignDeliveryDeps,
  type RecipientStatusForTotals,
  decideReleaseCampaignProcessingLease,
  RECIPIENT_LEASE_MS,
  RECIPIENTS_SETUP_STALE_MS,
  releaseCampaignProcessingLeaseTx,
  repairCampaignPressReleaseSyncTx,
  RESOLUTION_LEASE_MS,
  resolveCampaignResume,
  type ResolveDeliveryUnknownAudit,
  RESULT_COMMIT_MARGIN_MS,
  runSendPhase,
  SEND_BATCH_LIMIT,
  selectRecipientsToProcess,
  sendMailWithWallClockDeadline,
  type SendPhaseDeps,
  SMTP_CONNECTION_TIMEOUT_MS,
  SMTP_GREETING_TIMEOUT_MS,
  SMTP_MAX_SEND_ATTEMPT_MS,
  SMTP_SEND_WALL_CLOCK_TIMEOUT_MS,
  SMTP_SOCKET_TIMEOUT_MS,
  type DocSnapshotLike,
  type DocTx,
  type MailSenderLike,
} from '../shared/campaignSend'

const missing: DocSnapshotLike = { exists: false, data: undefined }
const snapOf = (data: Record<string, unknown>): DocSnapshotLike => ({
  exists: true,
  data,
})

/** round 16 新增：輕量的記憶體內 DocTx 假物件，讓 *Tx 協調函式（不只是
 *  純粹的 decide* 函式）也能在不連 Firestore emulator 的情況下被單元
 *  測試——特別是 Finding 5 需要證明「呼叫端透過 callback 塞進來的多餘
 *  欄位，實際上不會被寫進 update() 的 payload」，這件事純粹用
 *  decide* 函式測不出來，必須測到真的呼叫 update() 那一層。 */
function fakeDocTx(initial: Record<string, unknown> | undefined): DocTx & {
  updates: Record<string, unknown>[]
  current: () => Record<string, unknown> | undefined
} {
  let data = initial ? { ...initial } : undefined
  const updates: Record<string, unknown>[] = []
  return {
    async get() {
      return { exists: data !== undefined, data: data ? { ...data } : undefined }
    },
    set(d) {
      data = { ...d }
      updates.push(d)
    },
    update(d) {
      data = { ...(data ?? {}), ...d }
      updates.push(d)
    },
    updates,
    current: () => data,
  }
}

const T0 = 1_700_000_000_000 // 任意固定時間點，讓 lease 過期判斷可預期

describe('SEND_BATCH_LIMIT', () => {
  it('留有安全餘裕（400ms 間隔 × 上限仍遠低於 Function timeout）', () => {
    expect(SEND_BATCH_LIMIT).toBeGreaterThan(0)
    expect(SEND_BATCH_LIMIT * 0.4 * 1000).toBeLessThan(CAMPAIGN_FUNCTION_TIMEOUT_MS)
  })
})

describe('readMsCompat（新格式 number／舊格式 Timestamp-like 相容讀取）', () => {
  it('number → 原樣回傳', () => {
    expect(readMsCompat(12345)).toBe(12345)
  })

  it('0 是合法的毫秒值，不能被當成 falsy 漏掉', () => {
    expect(readMsCompat(0)).toBe(0)
  })

  it('Timestamp-like（具有 toMillis()）→ 呼叫 toMillis() 取得毫秒', () => {
    expect(readMsCompat({ toMillis: () => 98765 })).toBe(98765)
  })

  it('undefined／null／缺欄位 → null（真的沒有這個欄位，不是 0 也不是舊格式）', () => {
    expect(readMsCompat(undefined)).toBeNull()
    expect(readMsCompat(null)).toBeNull()
  })

  it('既不是 number 也沒有 toMillis 方法的值 → null（防禦性處理畸形資料）', () => {
    expect(readMsCompat('not-a-timestamp')).toBeNull()
    expect(readMsCompat({})).toBeNull()
  })

  it('NaN／Infinity／-Infinity 不是合法的時間戳 → null（不能讓它們流進 isLeaseActive 的減法運算）', () => {
    expect(readMsCompat(NaN)).toBeNull()
    expect(readMsCompat(Infinity)).toBeNull()
    expect(readMsCompat(-Infinity)).toBeNull()
  })

  it('Timestamp-like 的 toMillis() 回傳 NaN/Infinity → null', () => {
    expect(readMsCompat({ toMillis: () => NaN })).toBeNull()
    expect(readMsCompat({ toMillis: () => Infinity })).toBeNull()
  })

  it('Timestamp-like 的 toMillis() 呼叫時拋錯 → null，不會讓例外往外傳、中斷呼叫端的決策', () => {
    expect(
      readMsCompat({
        toMillis: () => {
          throw new Error('畸形的 Timestamp 物件')
        },
      }),
    ).toBeNull()
  })
})

describe('readFirstValidMs（依序嘗試多個候選值，取第一個有效的）', () => {
  it('新欄位有效 → 直接用新欄位，不看舊欄位', () => {
    expect(readFirstValidMs(100, 200)).toBe(100)
  })

  it('新欄位不存在（undefined）→ 退回舊欄位', () => {
    expect(readFirstValidMs(undefined, 200)).toBe(200)
  })

  it('新欄位是無效值（字串）、舊欄位是有效的 Timestamp-like → 用舊欄位，不能被 `??` 的語意誤導成「新欄位存在就不看舊欄位」', () => {
    // 這正是 finding 3A 的核心情境：`readMsCompat(a ?? b)` 在 a 存在但無效時
    // 完全不會退回 b；readFirstValidMs 必須逐一嘗試，找到第一個真正有效的。
    expect(readFirstValidMs('not-a-timestamp', { toMillis: () => 200 })).toBe(200)
  })

  it('新欄位是 NaN、舊欄位有效 → 用舊欄位', () => {
    expect(readFirstValidMs(NaN, 200)).toBe(200)
  })

  it('新欄位是 Infinity、舊欄位有效 → 用舊欄位', () => {
    expect(readFirstValidMs(Infinity, 200)).toBe(200)
  })

  it('新欄位的 toMillis() 拋錯、舊欄位有效 → 用舊欄位', () => {
    const throwing = {
      toMillis: () => {
        throw new Error('畸形')
      },
    }
    expect(readFirstValidMs(throwing, 200)).toBe(200)
  })

  it('新舊都無效 → null', () => {
    expect(readFirstValidMs('bad', NaN, undefined, {})).toBeNull()
  })

  it('0 是合法值，不會被略過改用後面的候選', () => {
    expect(readFirstValidMs(0, 999)).toBe(0)
  })
})

describe('isTerminalCampaignStatus（campaign 狀態機的唯一權威定義）', () => {
  it('completed／failed 是 terminal', () => {
    expect(isTerminalCampaignStatus('completed')).toBe(true)
    expect(isTerminalCampaignStatus('failed')).toBe(true)
  })

  it('needs_review 是 terminal（round 7：delivery_unknown 不會被自動重試，沒有自動化工作可做了）', () => {
    expect(isTerminalCampaignStatus('needs_review')).toBe(true)
  })

  it('sending／partial 不是 terminal（可以繼續處理／retry）', () => {
    expect(isTerminalCampaignStatus('sending')).toBe(false)
    expect(isTerminalCampaignStatus('partial')).toBe(false)
  })

  it('undefined／未知字串 不是 terminal（防禦性預設為可處理，不是誤判成蓋棺論定）', () => {
    expect(isTerminalCampaignStatus(undefined)).toBe(false)
    expect(isTerminalCampaignStatus('some-unexpected-value')).toBe(false)
  })
})

describe('isRetriableCampaignStatus（前端「要不要顯示一般繼續寄送按鈕」的唯一權威判斷）', () => {
  it('sending／partial 才需要顯示一般繼續寄送按鈕', () => {
    expect(isRetriableCampaignStatus('sending')).toBe(true)
    expect(isRetriableCampaignStatus('partial')).toBe(true)
  })

  it('completed／failed／needs_review 都不該顯示——needs_review 雖然不是乾淨的結局，但一般 retry 對它無事可做', () => {
    expect(isRetriableCampaignStatus('completed')).toBe(false)
    expect(isRetriableCampaignStatus('failed')).toBe(false)
    expect(isRetriableCampaignStatus('needs_review')).toBe(false)
  })

  it('undefined／未知字串 不是 retriable', () => {
    expect(isRetriableCampaignStatus(undefined)).toBe(false)
    expect(isRetriableCampaignStatus('some-unexpected-value')).toBe(false)
  })
})

describe('CAMPAIGN_LEASE_MS 與 CAMPAIGN_FUNCTION_TIMEOUT_MS 的關係', () => {
  it('CAMPAIGN_LEASE_MS 必須大於 CAMPAIGN_FUNCTION_TIMEOUT_MS，否則平台強制終止 invocation 前租約可能已經自然過期', () => {
    expect(CAMPAIGN_LEASE_MS).toBeGreaterThan(CAMPAIGN_FUNCTION_TIMEOUT_MS)
  })

  it('至少留 60 秒 clock skew／收尾裕度，不是壓線通過', () => {
    expect(CAMPAIGN_LEASE_MS - CAMPAIGN_FUNCTION_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000)
  })
})

describe('RECIPIENT_LEASE_MS 與 SMTP 逾時常數的關係', () => {
  // round 6 修正：真正的保證來自 SMTP_SEND_WALL_CLOCK_TIMEOUT_MS（我們自己
  // 用 sendMailWithWallClockDeadline 強制執行的期限），不是 Nodemailer 的
  // connectionTimeout／greetingTimeout／socketTimeout——那三個只在連線
  // 完全沒有任何動靜時才會生效，不保證 sendMail() 的總耗時上限。
  it('RECIPIENT_LEASE_MS 必須大於 SMTP_SEND_WALL_CLOCK_TIMEOUT_MS + RESULT_COMMIT_MARGIN_MS——這是我們自己強制執行、真正會生效的上界', () => {
    expect(RECIPIENT_LEASE_MS).toBeGreaterThan(
      SMTP_SEND_WALL_CLOCK_TIMEOUT_MS + RESULT_COMMIT_MARGIN_MS,
    )
  })

  it('SMTP_SEND_WALL_CLOCK_TIMEOUT_MS 目前等於 SMTP_MAX_SEND_ATTEMPT_MS（沿用同一個估計值當作 wall-clock 期限，但語意上是我們自己強制執行的，不是 Nodemailer 保證的）', () => {
    expect(SMTP_SEND_WALL_CLOCK_TIMEOUT_MS).toBe(SMTP_MAX_SEND_ATTEMPT_MS)
  })

  it('SMTP_MAX_SEND_ATTEMPT_MS 就是三個 Nodemailer 逾時常數的總和（避免日後只改其中一個卻忘記更新這個關係）', () => {
    expect(SMTP_MAX_SEND_ATTEMPT_MS).toBe(
      SMTP_CONNECTION_TIMEOUT_MS + SMTP_GREETING_TIMEOUT_MS + SMTP_SOCKET_TIMEOUT_MS,
    )
  })

  it('RECIPIENT_LEASE_MS 遠小於 CAMPAIGN_LEASE_MS（收件人層級的租約本來就該比整個 campaign 的處理租約短很多）', () => {
    expect(RECIPIENT_LEASE_MS).toBeLessThan(CAMPAIGN_LEASE_MS / 2)
  })
})

describe('sendMailWithWallClockDeadline（用可控制的 fake transporter 驗證超時／關閉／狀態行為，不是只驗證常數算術關係）', () => {
  function fakeTransporter(sendMail: MailSenderLike['sendMail']) {
    const close = vi.fn()
    return { sendMail, close, transporter: { sendMail, close } as MailSenderLike }
  }

  it('sendMail 在期限內完成 → outcome:sent，不會呼叫 close()', async () => {
    const { close, transporter } = fakeTransporter(async () => 'ok')
    const result = await sendMailWithWallClockDeadline(transporter, {}, 1000)
    expect(result).toEqual({ outcome: 'sent' })
    expect(close).not.toHaveBeenCalled()
  })

  it('sendMail 自己失敗（非逾時）→ 原樣往外拋，不會被吞成 timeout，也不會呼叫 close()（讓既有的 attemptCount／exhausted 邏輯處理，不切斷整個連線池）', async () => {
    const { close, transporter } = fakeTransporter(async () => {
      throw new Error('535 Authentication failed')
    })
    await expect(sendMailWithWallClockDeadline(transporter, {}, 1000)).rejects.toThrow(
      '535 Authentication failed',
    )
    expect(close).not.toHaveBeenCalled()
  })

  it('sendMail 卡住超過 wall-clock 期限（永遠不 resolve/reject）→ outcome:timeout，主動呼叫 close()，且不需要真的等待 timeoutMs（用 fake timers 快轉）', async () => {
    vi.useFakeTimers()
    try {
      // 永遠不 resolve、也不 reject 的 sendMail，模擬「連線持續有一點動靜，
      // 但實際上卡住不會真的完成」的慢連線情境——這正是 Nodemailer 的
      // socketTimeout（inactivity timer）不會幫我們解決的情況。
      const hangingSendMail: MailSenderLike['sendMail'] = () => new Promise(() => {})
      const { close, transporter } = fakeTransporter(hangingSendMail)

      const resultPromise = sendMailWithWallClockDeadline(transporter, {}, 5000)
      // 快轉到剛好超過期限，不需要真的等 5 秒
      await vi.advanceTimersByTimeAsync(5001)
      const result = await resultPromise

      expect(result.outcome).toBe('timeout')
      if (result.outcome === 'timeout') {
        expect(result.message).toContain('5000ms')
      }
      expect(close).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('sendMail 在期限「之前」完成，就算稍後才被 await 到，也不該被誤判成 timeout', async () => {
    vi.useFakeTimers()
    try {
      const { close, transporter } = fakeTransporter(
        () => new Promise((resolve) => setTimeout(() => resolve('ok'), 100)),
      )
      const resultPromise = sendMailWithWallClockDeadline(transporter, {}, 5000)
      await vi.advanceTimersByTimeAsync(100)
      const result = await resultPromise
      expect(result).toEqual({ outcome: 'sent' })
      expect(close).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  // Finding 1（round 7）：round 6 版本的註解宣稱 Promise.race() 加上
  // transporter.close() 是 sendMail 的硬性中止；Nodemailer 官方文件
  // （https://nodemailer.com/smtp/pooled）明確說 pooled transport 的
  // close() 不會強制切斷正在傳輸中的訊息，該連線會等目前這個訊息完成後
  // 才真正關閉。以下測試驗證「底層 sendMail 逾時後才真的 settle」不會
  // 讓 process 產生 unhandled rejection，也不會讓已經回報的 timeout 結果
  // 被事後改寫。

  it('transporter.close() 自己拋錯 → 仍然回傳 outcome:timeout，錯誤記在 closeError，不會把 timeout 誤判成一般寄送失敗', async () => {
    vi.useFakeTimers()
    try {
      const hangingSendMail: MailSenderLike['sendMail'] = () => new Promise(() => {})
      const close = vi.fn(() => {
        throw new Error('連線池已經在關閉中')
      })
      const transporter: MailSenderLike = { sendMail: hangingSendMail, close }

      const resultPromise = sendMailWithWallClockDeadline(transporter, {}, 1000)
      await vi.advanceTimersByTimeAsync(1001)
      const result = await resultPromise

      expect(result.outcome).toBe('timeout')
      if (result.outcome === 'timeout') {
        expect(result.closeError).toBe('連線池已經在關閉中')
      }
      expect(close).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('底層 sendMail 在 timeout 之後才 resolve → 不會產生 unhandled rejection，也不會回頭把結果改寫成 sent', async () => {
    vi.useFakeTimers()
    const unhandled: unknown[] = []
    const onUnhandledRejection = (reason: unknown) => unhandled.push(reason)
    process.on('unhandledRejection', onUnhandledRejection)
    try {
      let resolveLate: ((value: string) => void) | undefined
      const lateSendMail: MailSenderLike['sendMail'] = () =>
        new Promise((resolve) => {
          resolveLate = resolve
        })
      const { close, transporter } = fakeTransporter(lateSendMail)

      const resultPromise = sendMailWithWallClockDeadline(transporter, {}, 1000)
      await vi.advanceTimersByTimeAsync(1001)
      const result = await resultPromise
      expect(result.outcome).toBe('timeout')
      expect(close).toHaveBeenCalledTimes(1)

      // 模擬伺服器其實有收下這封信，只是回應比我們願意等待的時間還晚——
      // 這裡故意不對 result 做任何事，因為呼叫端這時候已經把這位收件人
      // 標成 delivery_unknown 了，不能因為底層事後才 resolve 就回頭改寫。
      resolveLate?.('ok, but too late')
      await vi.advanceTimersByTimeAsync(0)
      await Promise.resolve()
      await Promise.resolve()

      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandledRejection)
      vi.useRealTimers()
    }
  })

  it('底層 sendMail 在 timeout 之後才 reject → 不會產生 unhandled rejection', async () => {
    vi.useFakeTimers()
    const unhandled: unknown[] = []
    const onUnhandledRejection = (reason: unknown) => unhandled.push(reason)
    process.on('unhandledRejection', onUnhandledRejection)
    try {
      let rejectLate: ((err: Error) => void) | undefined
      const lateSendMail: MailSenderLike['sendMail'] = () =>
        new Promise((_resolve, reject) => {
          rejectLate = reject
        })
      const { close, transporter } = fakeTransporter(lateSendMail)

      const resultPromise = sendMailWithWallClockDeadline(transporter, {}, 1000)
      await vi.advanceTimersByTimeAsync(1001)
      const result = await resultPromise
      expect(result.outcome).toBe('timeout')
      expect(close).toHaveBeenCalledTimes(1)

      rejectLate?.(new Error('伺服器最後還是拒收了'))
      await vi.advanceTimersByTimeAsync(0)
      await Promise.resolve()
      await Promise.resolve()

      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandledRejection)
      vi.useRealTimers()
    }
  })
})

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
    expect(decideCampaignResume(undefined, req, T0)).toEqual({ action: 'create' })
  })

  it('既有文件收件人已就緒、還在進行中 → resume（第二次呼叫不會重建）', () => {
    expect(
      decideCampaignResume(
        { pressReleaseId: 'p1', mode: 'real', status: 'sending', recipientsReady: true },
        req,
        T0,
      ),
    ).toEqual({ action: 'resume' })
    expect(
      decideCampaignResume(
        { pressReleaseId: 'p1', mode: 'real', status: 'partial', recipientsReady: true },
        req,
        T0,
      ),
    ).toEqual({ action: 'resume' })
  })

  it('既有文件已經跑完（成功或失敗）→ 回傳既有結果，不重跑', () => {
    expect(
      decideCampaignResume(
        { pressReleaseId: 'p1', mode: 'real', status: 'completed', recipientsReady: true },
        req,
        T0,
      ),
    ).toEqual({ action: 'return-existing-result' })
    expect(
      decideCampaignResume(
        { pressReleaseId: 'p1', mode: 'real', status: 'failed', recipientsReady: true },
        req,
        T0,
      ),
    ).toEqual({ action: 'return-existing-result' })
  })

  it('收件人清單還在建立中（未逾時）→ 等待，不搶著建立第二份', () => {
    const decision = decideCampaignResume(
      {
        pressReleaseId: 'p1',
        mode: 'real',
        status: 'sending',
        recipientsReady: false,
        startedAtMs: T0,
      },
      req,
      T0 + 10_000,
    )
    expect(decision).toEqual({ action: 'wait-recipients-setup' })
  })

  it('收件人清單建立中斷太久（超過 RECIPIENTS_SETUP_STALE_MS）→ 判定已死', () => {
    const decision = decideCampaignResume(
      {
        pressReleaseId: 'p1',
        mode: 'real',
        status: 'sending',
        recipientsReady: false,
        startedAtMs: T0,
      },
      req,
      T0 + RECIPIENTS_SETUP_STALE_MS + 1,
    )
    expect(decision).toEqual({ action: 'abandoned-recipients-setup' })
  })

  it('needs_review 也是既有結果之一，跟 completed／failed 一樣直接回傳，不重跑', () => {
    expect(
      decideCampaignResume(
        { pressReleaseId: 'p1', mode: 'real', status: 'needs_review', recipientsReady: true },
        req,
        T0,
      ),
    ).toEqual({ action: 'return-existing-result' })
  })

  // Finding 3（round 7）：startedAtMs 是 null（呼叫端已經試過新舊兩種
  // 欄位格式都無法解析）不能像過去那樣退回 0（Unix epoch），那會讓
  // `nowMs - 0` 這種巨大差值直接被誤判成「早就超過門檻」。
  it('startedAtMs 是 null（新舊欄位都無法解析）→ indeterminate，不會被誤判成 abandoned', () => {
    const decision = decideCampaignResume(
      {
        pressReleaseId: 'p1',
        mode: 'real',
        status: 'sending',
        recipientsReady: false,
        startedAtMs: null,
      },
      req,
      T0 + 1, // 才過 1 毫秒，如果真的被當成 startedAtMs:0，nowMs - 0 會是巨大的數字
    )
    expect(decision).toEqual({ action: 'indeterminate-recipients-setup' })
  })

  // Finding 4（round 8）：過去這裡完全沒檢查 activeAttemptId，只有真正執行
  // reclaimAbandonedSetupTx 這個 transaction 時才會被擋下——但這代表這一層
  // 「早期、非交易」的判斷本身仍然可能誤判成 abandoned-recipients-setup，
  // 即使資料已經違反了「recipientsReady 還是 false 時不該有 activeAttemptId」
  // 這個不變量。這裡必須在早期判斷這一層就直接 fail closed。
  it('recipientsReady 還是 false，但已經有 activeAttemptId（違反不變量）→ inconsistent，即使 startedAt 已經逾時也不能宣稱 abandoned', () => {
    const decision = decideCampaignResume(
      {
        pressReleaseId: 'p1',
        mode: 'real',
        status: 'sending',
        recipientsReady: false,
        startedAtMs: T0,
        activeAttemptId: 'someone',
      },
      req,
      T0 + RECIPIENTS_SETUP_STALE_MS + 1,
    )
    expect(decision).toEqual({ action: 'inconsistent-recipients-setup' })
  })

  it('recipientsReady 還是 false，且 activeAttemptId 是 null／undefined（正常不變量）→ 照舊走 staleness 判斷，不受影響', () => {
    const decision = decideCampaignResume(
      {
        pressReleaseId: 'p1',
        mode: 'real',
        status: 'sending',
        recipientsReady: false,
        startedAtMs: T0,
        activeAttemptId: null,
      },
      req,
      T0 + 10_000,
    )
    expect(decision).toEqual({ action: 'wait-recipients-setup' })
  })

  it('同一個 key 被用在不同新聞稿或不同模式 → 拒絕', () => {
    const r1 = decideCampaignResume(
      { pressReleaseId: 'OTHER', mode: 'real', status: 'sending', recipientsReady: true },
      req,
      T0,
    )
    expect(r1.action).toBe('reject')
    const r2 = decideCampaignResume(
      { pressReleaseId: 'p1', mode: 'testList', status: 'sending', recipientsReady: true },
      req,
      T0,
    )
    expect(r2.action).toBe('reject')
  })
})

describe('resolveCampaignResume（sendCampaign／retryCampaign 實際呼叫的整合層，含 legacy startedAt 相容讀取）', () => {
  const req = { pressReleaseId: 'p1', mode: 'real' }

  it('全新格式（只有 startedAtMs）：收件人清單建立中、未逾時 → wait', () => {
    const resolution = resolveCampaignResume(
      {
        pressReleaseId: 'p1',
        mode: 'real',
        status: 'sending',
        recipientsReady: false,
        startedAtMs: T0,
      },
      req,
      T0 + 10_000,
    )
    expect(resolution).toEqual({ kind: 'wait' })
  })

  // Finding 3B（round 6）：retryCampaign 過去只把 campaign.startedAtMs 傳給
  // resolveResume()，沒有一併傳 campaign.startedAt（legacy Timestamp）。
  // round 4 之前建立、只有 startedAt 沒有 startedAtMs 的舊 campaign，
  // 會被誤判成 startedAtMs:null，`nowMs - 0` 巨大差值直接判定成
  // abandoned，即使那份舊 campaign 的收件人清單剛開始建立幾秒鐘也一樣。
  // 這裡直接測 resolveCampaignResume()（sendCampaign／retryCampaign 實際
  // 呼叫的同一份函式），只給 legacy startedAt（Timestamp-like），不給
  // startedAtMs，驗證修正後的行為。
  it('只有 legacy startedAt（Timestamp-like）、剛建立沒多久 → wait，不是 abandoned（過去的 bug：漏傳 startedAt 會誤判成 abandoned）', () => {
    const legacyStartedAt = { toMillis: () => T0 }
    const resolution = resolveCampaignResume(
      {
        pressReleaseId: 'p1',
        mode: 'real',
        status: 'sending',
        recipientsReady: false,
        // 故意不給 startedAtMs，模擬只有 legacy 欄位的舊文件
        startedAt: legacyStartedAt,
      },
      req,
      T0 + 10_000, // 才過 10 秒，遠低於 RECIPIENTS_SETUP_STALE_MS
    )
    expect(resolution).toEqual({ kind: 'wait' })
  })

  it('只有 legacy startedAt（Timestamp-like）、真的中斷超過門檻 → abandoned，可以 reclaim', () => {
    const legacyStartedAt = { toMillis: () => T0 }
    const resolution = resolveCampaignResume(
      {
        pressReleaseId: 'p1',
        mode: 'real',
        status: 'sending',
        recipientsReady: false,
        startedAt: legacyStartedAt,
      },
      req,
      T0 + RECIPIENTS_SETUP_STALE_MS + 1,
    )
    expect(resolution).toEqual({ kind: 'abandoned' })
  })

  it('startedAtMs 是無效值（例如遷移過程中意外寫入的字串）、legacy startedAt 有效 → 仍然正確用 legacy 值判斷成 wait，不是 abandoned', () => {
    const resolution = resolveCampaignResume(
      {
        pressReleaseId: 'p1',
        mode: 'real',
        status: 'sending',
        recipientsReady: false,
        startedAtMs: 'not-a-number' as unknown as number,
        startedAt: { toMillis: () => T0 },
      },
      req,
      T0 + 10_000,
    )
    expect(resolution).toEqual({ kind: 'wait' })
  })

  it('startedAtMs／startedAt 新舊欄位都無法解析 → indeterminate，不會被誤判成 abandoned（Finding 3）', () => {
    const resolution = resolveCampaignResume(
      {
        pressReleaseId: 'p1',
        mode: 'real',
        status: 'sending',
        recipientsReady: false,
        startedAtMs: 'not-a-number' as unknown as number,
        startedAt: {},
      },
      req,
      T0 + 1,
    )
    expect(resolution).toEqual({ kind: 'indeterminate' })
  })

  // Finding 4（round 8）：retryCampaign／sendCampaign 過去都沒有把
  // campaign.activeAttemptId 傳給 resolveCampaignResume()，這裡直接測
  // production 實際呼叫的同一份整合函式，驗證修正後 activeAttemptId 真的
  // 會被讀到並產生 fail-closed 的 inconsistent 結果，即使 startedAt 已經
  // 逾時、看起來很像 abandoned 也一樣。
  it('activeAttemptId 存在但 recipientsReady 還是 false → inconsistent，不會被誤判成 abandoned', () => {
    const resolution = resolveCampaignResume(
      {
        pressReleaseId: 'p1',
        mode: 'real',
        status: 'sending',
        recipientsReady: false,
        startedAtMs: T0,
        activeAttemptId: 'someone',
      },
      req,
      T0 + RECIPIENTS_SETUP_STALE_MS + 1,
    )
    expect(resolution).toEqual({ kind: 'inconsistent' })
  })

  it('resume：回傳既有的 targetLists／totals，不重新展開收件人', () => {
    const resolution = resolveCampaignResume(
      {
        pressReleaseId: 'p1',
        mode: 'real',
        status: 'partial',
        recipientsReady: true,
        targetLists: ['tw_pr'],
        totals: { recipients: 42 },
      },
      req,
      T0,
    )
    expect(resolution).toEqual({
      kind: 'resume',
      effectiveLists: ['tw_pr'],
      recipientsCount: 42,
    })
  })

  it('existing-result：已跑完的 campaign 直接回傳當時結果', () => {
    const resolution = resolveCampaignResume(
      {
        pressReleaseId: 'p1',
        mode: 'real',
        status: 'completed',
        recipientsReady: true,
        totals: { recipients: 10 },
      },
      req,
      T0,
    )
    expect(resolution).toEqual({ kind: 'existing-result', recipients: 10, status: 'completed' })
  })

  it('reject：同一個 key 用在不同新聞稿', () => {
    const resolution = resolveCampaignResume(
      { pressReleaseId: 'OTHER', mode: 'real', status: 'sending', recipientsReady: true },
      req,
      T0,
    )
    expect(resolution.kind).toBe('reject')
  })
})

describe('isLeaseActive', () => {
  it('未過期時為 true', () => {
    expect(isLeaseActive(T0 + 1000, T0)).toBe(true)
  })
  it('已過期或為 null/undefined 時為 false', () => {
    expect(isLeaseActive(T0 - 1, T0)).toBe(false)
    expect(isLeaseActive(null, T0)).toBe(false)
    expect(isLeaseActive(undefined, T0)).toBe(false)
  })
})

describe('isCampaignLeaseHeldByOther', () => {
  it('沒有 activeAttemptId → 沒被佔用', () => {
    expect(isCampaignLeaseHeldByOther({}, 'me', T0)).toBe(false)
  })

  it('activeAttemptId 是自己 → 不算被別人佔用', () => {
    expect(
      isCampaignLeaseHeldByOther(
        { activeAttemptId: 'me', activeLeaseExpiresAtMs: T0 + 1000 },
        'me',
        T0,
      ),
    ).toBe(false)
  })

  it('activeAttemptId 是別人且租期未過 → 被佔用（兩個 invocation 競爭同一個 campaign）', () => {
    expect(
      isCampaignLeaseHeldByOther(
        { activeAttemptId: 'other', activeLeaseExpiresAtMs: T0 + 1000 },
        'me',
        T0,
      ),
    ).toBe(true)
  })

  it('activeAttemptId 是別人但租期已過 → 不算被佔用，可以接手', () => {
    expect(
      isCampaignLeaseHeldByOther(
        { activeAttemptId: 'other', activeLeaseExpiresAtMs: T0 - 1 },
        'me',
        T0,
      ),
    ).toBe(false)
  })

  // round 8（Finding 4）：過去用 isLeaseActive(undefined/null, nowMs) 判斷，
  // 對無法解析的 expiry 一律回傳 false，等於「沒填 = 沒有效」，讓一個其實
  // 還可能活著、只是租約時間欄位遺失或格式錯誤的租約被當成可以核發新租約
  // ——這是 fail-open。修正後：有其他人的 activeAttemptId，但無法解析出
  // 有效的 expiry，一律當成仍被持有，不核發新租約。
  it('activeAttemptId 是別人，但 activeLeaseExpiresAtMs 缺欄位（undefined）→ 視為仍被佔用（fail closed，不能假設已失效）', () => {
    expect(
      isCampaignLeaseHeldByOther({ activeAttemptId: 'other' }, 'me', T0),
    ).toBe(true)
  })

  it('activeAttemptId 是別人，但 activeLeaseExpiresAtMs 是 null（相容讀取解析失敗）→ 視為仍被佔用', () => {
    expect(
      isCampaignLeaseHeldByOther(
        { activeAttemptId: 'other', activeLeaseExpiresAtMs: null },
        'me',
        T0,
      ),
    ).toBe(true)
  })
})

describe('isRecipientClaimable', () => {
  it('sent／exhausted 永遠不可認領', () => {
    expect(isRecipientClaimable({ status: 'sent' }, T0)).toBe(false)
    expect(isRecipientClaimable({ status: 'exhausted' }, T0)).toBe(false)
  })

  it('queued／failed 一律可以認領', () => {
    expect(isRecipientClaimable({ status: 'queued' }, T0)).toBe(true)
    expect(isRecipientClaimable({ status: 'failed' }, T0)).toBe(true)
  })

  it('claimed 且租期未過 → 不可認領（另一個 invocation 正在準備處理，避免重複寄送）', () => {
    expect(
      isRecipientClaimable({ status: 'claimed', leaseExpiresAtMs: T0 + 1000 }, T0),
    ).toBe(false)
  })

  it('claimed 但租期已過 → 可以認領（上一個 invocation 很可能在真正呼叫 SMTP 前就已經死掉）', () => {
    expect(
      isRecipientClaimable({ status: 'claimed', leaseExpiresAtMs: T0 - 1 }, T0),
    ).toBe(true)
  })

  // Finding 1（round 8）：sending 現在代表「即將或已經呼叫過 sendMail」，
  // 一旦進入這個狀態就永遠不可被這個函式認領，不論 lease 是否過期——跟
  // claimed（還沒呼叫過 SMTP）是完全不同的規則。這正是 round 8 要修的
  // 核心問題：過期的 sending 不能直接被重新認領，只能透過
  // reclaimExpiredDeliveryAttemptTx 原子轉成 delivery_unknown。
  it('sending 且租期未過 → 不可認領（另一個 invocation 正在寄送中，避免重複寄送）', () => {
    expect(
      isRecipientClaimable({ status: 'sending', leaseExpiresAtMs: T0 + 1000 }, T0),
    ).toBe(false)
  })

  it('sending 且租期已過 → 仍然不可認領（SMTP 可能已經開始，沒有任何有限的 lease 能證明它已安全失效）', () => {
    expect(
      isRecipientClaimable({ status: 'sending', leaseExpiresAtMs: T0 - 1 }, T0),
    ).toBe(false)
    // 完全沒有 leaseExpiresAtMs（理論上不該發生，防禦性檢查）也一樣：
    // 不能因為讀不到租約時間就當作可以安全重新認領。
    expect(isRecipientClaimable({ status: 'sending' }, T0)).toBe(false)
  })

  // Finding 1（round 7）：delivery_unknown 必須永遠不可認領，不管有沒有
  // 附帶租約欄位——一般 retryCampaign 不能自動重試「送達與否不確定」的
  // 收件人，否則背景那個逾時前的 sendMail 仍可能在跑，會跟新的重試重疊。
  it('delivery_unknown 永遠不可認領，不管 leaseExpiresAtMs 是什麼', () => {
    expect(isRecipientClaimable({ status: 'delivery_unknown' }, T0)).toBe(false)
    expect(
      isRecipientClaimable({ status: 'delivery_unknown', leaseExpiresAtMs: T0 - 1 }, T0),
    ).toBe(false)
    expect(
      isRecipientClaimable({ status: 'delivery_unknown', leaseExpiresAtMs: T0 + 1000 }, T0),
    ).toBe(false)
  })
})

describe('hasExceededMaxAttempts', () => {
  it('未達上限 → false', () => {
    expect(hasExceededMaxAttempts(1)).toBe(false)
    expect(hasExceededMaxAttempts(MAX_RECIPIENT_ATTEMPTS - 1)).toBe(false)
  })
  it('達到或超過上限 → true', () => {
    expect(hasExceededMaxAttempts(MAX_RECIPIENT_ATTEMPTS)).toBe(true)
    expect(hasExceededMaxAttempts(MAX_RECIPIENT_ATTEMPTS + 1)).toBe(true)
  })
  it('可傳自訂上限', () => {
    expect(hasExceededMaxAttempts(2, 2)).toBe(true)
    expect(hasExceededMaxAttempts(1, 2)).toBe(false)
  })

  // round 14 新增（Finding 4）：這支函式本身無法分辨傳進來的 attemptCount
  // 裡有多少是真正的 SMTP attempt、有多少是部署重疊視窗期間舊 revision
  // 留下的「幽靈」計數——這個測試直接證明：在 MAX_RECIPIENT_ATTEMPTS 的
  // 邊界上，只要 attemptCount 因為幽靈計數多算一次，這位收件人就會比真實
  // 情況更早被判定 exhausted，即使真正遭遇失敗的次數還沒到上限。
  it('Finding 4：ghost count 讓收件人在邊界上提早被判定 exhausted，即使真正的 SMTP attempt 次數還沒到上限', () => {
    const realAttempts = MAX_RECIPIENT_ATTEMPTS - 1 // 真正發生過的 SMTP attempt 次數，還沒到上限
    expect(hasExceededMaxAttempts(realAttempts)).toBe(false) // 如果沒有幽靈計數，這位收件人「應該」還能再重試一次

    const withOneGhostCount = realAttempts + 1 // 混入一次舊 revision 的幽靈計數（見 reconcileCampaignDelivery 上方的完整說明）
    expect(hasExceededMaxAttempts(withOneGhostCount)).toBe(true) // 卻已經被判定 exhausted——提早停止自動重試，不是只有數字好看
  })
})

describe('selectRecipientsToProcess（選批：這次要實際嘗試認領誰）', () => {
  it('已經是 sent 的一律跳過（同一請求呼叫兩次不會重複寄送）', () => {
    const recipients = [
      { id: 'a', status: 'sent' as const },
      { id: 'b', status: 'queued' as const },
      { id: 'c', status: 'sent' as const },
    ]
    const { toProcess, remainingAfterBatchLimit } = selectRecipientsToProcess(
      recipients,
      10,
      T0,
    )
    expect(toProcess).toEqual(['b'])
    expect(remainingAfterBatchLimit).toBe(0)
  })

  it('exhausted 也永遠跳過，不再重試', () => {
    const recipients = [
      { id: 'a', status: 'exhausted' as const },
      { id: 'b', status: 'queued' as const },
    ]
    const { toProcess, remainingAfterBatchLimit } = selectRecipientsToProcess(
      recipients,
      10,
      T0,
    )
    expect(toProcess).toEqual(['b'])
    expect(remainingAfterBatchLimit).toBe(0)
  })

  it('delivery_unknown 永遠跳過，不會被一般 retry 自動認領（Finding 1）', () => {
    const recipients = [
      { id: 'a', status: 'delivery_unknown' as const },
      { id: 'b', status: 'queued' as const },
    ]
    const { toProcess, remainingAfterBatchLimit } = selectRecipientsToProcess(
      recipients,
      10,
      T0,
    )
    expect(toProcess).toEqual(['b'])
    expect(remainingAfterBatchLimit).toBe(0)
  })

  it('queued／failed 都視為需要（重新）處理', () => {
    const recipients = [
      { id: 'a', status: 'queued' as const },
      { id: 'b', status: 'failed' as const },
    ]
    const { toProcess } = selectRecipientsToProcess(recipients, 10, T0)
    expect(toProcess).toEqual(['a', 'b'])
  })

  it('sending 且租期未過的人不會被選中，也不計入 remainingAfterBatchLimit（不可認領跟「批次排不下」是不同原因）', () => {
    const recipients = [
      { id: 'a', status: 'sending' as const, leaseExpiresAtMs: T0 + 30_000 },
      { id: 'b', status: 'queued' as const },
    ]
    const { toProcess, remainingAfterBatchLimit } = selectRecipientsToProcess(
      recipients,
      10,
      T0,
    )
    expect(toProcess).toEqual(['b'])
    expect(remainingAfterBatchLimit).toBe(0) // a 不是因為批次上限被排除，是根本不可認領
  })

  it('90 成功 + 10 failed（都在上限內）→ 這次全部 10 個 failed 都排進 toProcess，remainingAfterBatchLimit 為 0', () => {
    // 這個案例只驗證「選批」本身的行為：10 個 failed 都在 SEND_BATCH_LIMIT 內，
    // 所以全部排進這一批。這不代表 campaign 已經完成 —— 那要看送出結果之後
    // countNonTerminalRecipients() 的數字，見下面對應的 describe block。
    const recipients = [
      ...Array.from({ length: 90 }, (_, i) => ({ id: `s${i}`, status: 'sent' as const })),
      ...Array.from({ length: 10 }, (_, i) => ({ id: `f${i}`, status: 'failed' as const })),
    ]
    const { toProcess, remainingAfterBatchLimit } = selectRecipientsToProcess(
      recipients,
      300,
      T0,
    )
    expect(toProcess).toHaveLength(10)
    expect(remainingAfterBatchLimit).toBe(0)
  })

  it('超過上限只取前 limit 位，其餘算進 remainingAfterBatchLimit（大於單批上限時正確切批）', () => {
    const recipients = Array.from({ length: 1200 }, (_, i) => ({
      id: `r${i}`,
      status: 'queued' as const,
    }))
    const { toProcess, remainingAfterBatchLimit } = selectRecipientsToProcess(
      recipients,
      300,
      T0,
    )
    expect(toProcess).toHaveLength(300)
    expect(remainingAfterBatchLimit).toBe(900)
  })

  it('沒有需要處理的人時回傳空陣列', () => {
    const recipients = [{ id: 'a', status: 'sent' as const }]
    expect(selectRecipientsToProcess(recipients, 300, T0)).toEqual({
      toProcess: [],
      remainingAfterBatchLimit: 0,
    })
  })

  it('同一個 id 重複出現只算一次（防呆）', () => {
    const recipients = [
      { id: 'a', status: 'queued' as const },
      { id: 'a', status: 'queued' as const },
    ]
    const { toProcess } = selectRecipientsToProcess(recipients, 300, T0)
    expect(toProcess).toEqual(['a'])
  })
})

describe('countNonTerminalRecipients（寄送完成後：還有誰沒到終止狀態）', () => {
  it('90 sent + 10 failed（還沒到重試上限）→ 10 個沒完成', () => {
    const recipients = [
      ...Array.from({ length: 90 }, () => ({ status: 'sent' as const })),
      ...Array.from({ length: 10 }, () => ({ status: 'failed' as const })),
    ]
    expect(countNonTerminalRecipients(recipients)).toBe(10)
  })

  it('因為批次上限沒排到的 queued 仍算沒完成', () => {
    const recipients = [
      { status: 'sent' as const },
      { status: 'queued' as const },
      { status: 'queued' as const },
    ]
    expect(countNonTerminalRecipients(recipients)).toBe(2)
  })

  it('租約未過期的 sending 仍算沒完成', () => {
    const recipients = [{ status: 'sent' as const }, { status: 'sending' as const }]
    expect(countNonTerminalRecipients(recipients)).toBe(1)
  })

  it('全部 sent → 0 個沒完成', () => {
    const recipients = Array.from({ length: 5 }, () => ({ status: 'sent' as const }))
    expect(countNonTerminalRecipients(recipients)).toBe(0)
  })

  it('全部 exhausted → 0 個沒完成（重試次數用完，不再被視為待處理）', () => {
    const recipients = Array.from({ length: 5 }, () => ({ status: 'exhausted' as const }))
    expect(countNonTerminalRecipients(recipients)).toBe(0)
  })

  it('重試成功後：原本的 10 個 failed 全變 sent → 0 個沒完成', () => {
    const recipients = Array.from({ length: 100 }, () => ({ status: 'sent' as const }))
    expect(countNonTerminalRecipients(recipients)).toBe(0)
  })

  it('failed 達重試上限後轉 exhausted → 不再算沒完成', () => {
    const recipients = [
      ...Array.from({ length: 90 }, () => ({ status: 'sent' as const })),
      ...Array.from({ length: 10 }, () => ({ status: 'exhausted' as const })),
    ]
    expect(countNonTerminalRecipients(recipients)).toBe(0)
  })

  it('delivery_unknown 不算沒完成（round 7：它沒有自動化工作可做，繼續算進去只會讓 campaign 永遠卡在 partial）', () => {
    const recipients = [
      { status: 'sent' as const },
      { status: 'delivery_unknown' as const },
      { status: 'delivery_unknown' as const },
    ]
    expect(countNonTerminalRecipients(recipients)).toBe(0)
  })

  it('delivery_unknown 與還在等待的 queued 混合 → 只有 queued 算沒完成', () => {
    const recipients = [
      { status: 'delivery_unknown' as const },
      { status: 'queued' as const },
    ]
    expect(countNonTerminalRecipients(recipients)).toBe(1)
  })
})

describe('decideCampaignStatus（依 countNonTerminalRecipients 的結果決定最終狀態）', () => {
  it('90 sent + 10 failed（還可重試）→ nonTerminalCount=10 → partial，不是 completed', () => {
    const recipients = [
      ...Array.from({ length: 90 }, () => ({ status: 'sent' as const })),
      ...Array.from({ length: 10 }, () => ({ status: 'failed' as const })),
    ]
    const nonTerminal = countNonTerminalRecipients(recipients)
    expect(
      decideCampaignStatus({ recipients: 100, sent: 90, deliveryUnknown: 0 }, nonTerminal),
    ).toBe('partial')
  })

  it('因批次上限被排除的 queued 仍在 → partial', () => {
    const recipients = [{ status: 'sent' as const }, { status: 'queued' as const }]
    const nonTerminal = countNonTerminalRecipients(recipients)
    expect(
      decideCampaignStatus({ recipients: 2, sent: 1, deliveryUnknown: 0 }, nonTerminal),
    ).toBe('partial')
  })

  it('還有租約未過期的 sending → partial', () => {
    const recipients = [{ status: 'sent' as const }, { status: 'sending' as const }]
    const nonTerminal = countNonTerminalRecipients(recipients)
    expect(
      decideCampaignStatus({ recipients: 2, sent: 1, deliveryUnknown: 0 }, nonTerminal),
    ).toBe('partial')
  })

  it('10 個 failed 重試成功後全變 sent → completed（不再是 partial）', () => {
    const recipients = Array.from({ length: 100 }, () => ({ status: 'sent' as const }))
    const nonTerminal = countNonTerminalRecipients(recipients)
    expect(
      decideCampaignStatus({ recipients: 100, sent: 100, deliveryUnknown: 0 }, nonTerminal),
    ).toBe('completed')
  })

  it('全部 sent 才 completed', () => {
    const recipients = Array.from({ length: 3 }, () => ({ status: 'sent' as const }))
    const nonTerminal = countNonTerminalRecipients(recipients)
    expect(
      decideCampaignStatus({ recipients: 3, sent: 3, deliveryUnknown: 0 }, nonTerminal),
    ).toBe('completed')
  })

  it('全部 exhausted（重試上限用完、沒有任何成功）才 failed', () => {
    const recipients = Array.from({ length: 5 }, () => ({ status: 'exhausted' as const }))
    const nonTerminal = countNonTerminalRecipients(recipients)
    expect(
      decideCampaignStatus({ recipients: 5, sent: 0, deliveryUnknown: 0 }, nonTerminal),
    ).toBe('failed')
  })

  it('sent 與 exhausted 混合到達終止狀態、至少一封成功 → completed', () => {
    const recipients = [
      ...Array.from({ length: 2 }, () => ({ status: 'sent' as const })),
      ...Array.from({ length: 3 }, () => ({ status: 'exhausted' as const })),
    ]
    const nonTerminal = countNonTerminalRecipients(recipients)
    expect(
      decideCampaignStatus({ recipients: 5, sent: 2, deliveryUnknown: 0 }, nonTerminal),
    ).toBe('completed')
  })

  it('沒有任何收件人也算 completed（不會被 0/0 誤判成 failed）', () => {
    expect(decideCampaignStatus({ recipients: 0, sent: 0, deliveryUnknown: 0 }, 0)).toBe(
      'completed',
    )
  })

  // round 7（Finding 1）：needs_review 的優先順序排在 completed／failed
  // 判斷之前——只要有任何一位收件人的送達狀態不確定，就不能誠實地說
  // 「completed」或「failed」。
  describe('needs_review：所有自動化工作都做完了，但有 delivery_unknown', () => {
    it('90 sent + 10 delivery_unknown（沒有人還在等待）→ needs_review，不是 completed', () => {
      const recipients = [
        ...Array.from({ length: 90 }, () => ({ status: 'sent' as const })),
        ...Array.from({ length: 10 }, () => ({ status: 'delivery_unknown' as const })),
      ]
      const nonTerminal = countNonTerminalRecipients(recipients)
      expect(nonTerminal).toBe(0) // 沒有自動化工作可做了
      expect(
        decideCampaignStatus({ recipients: 100, sent: 90, deliveryUnknown: 10 }, nonTerminal),
      ).toBe('needs_review')
    })

    it('全部 exhausted + 有 delivery_unknown、完全沒人成功 → 仍然是 needs_review，不是 failed（可能其中幾封其實有送達）', () => {
      const recipients = [
        ...Array.from({ length: 5 }, () => ({ status: 'exhausted' as const })),
        { status: 'delivery_unknown' as const },
      ]
      const nonTerminal = countNonTerminalRecipients(recipients)
      expect(
        decideCampaignStatus({ recipients: 6, sent: 0, deliveryUnknown: 1 }, nonTerminal),
      ).toBe('needs_review')
    })

    it('還有 queued／failed 沒處理完時，即使已經有 delivery_unknown，仍然優先回報 partial（自動化工作還沒做完）', () => {
      const recipients = [
        { status: 'delivery_unknown' as const },
        { status: 'queued' as const },
      ]
      const nonTerminal = countNonTerminalRecipients(recipients)
      expect(nonTerminal).toBe(1)
      expect(
        decideCampaignStatus({ recipients: 2, sent: 0, deliveryUnknown: 1 }, nonTerminal),
      ).toBe('partial')
    })

    it('deliveryUnknown:0 時完全不受影響，跟過去的行為一致', () => {
      const recipients = Array.from({ length: 5 }, () => ({ status: 'sent' as const }))
      const nonTerminal = countNonTerminalRecipients(recipients)
      expect(
        decideCampaignStatus({ recipients: 5, sent: 5, deliveryUnknown: 0 }, nonTerminal),
      ).toBe('completed')
    })
  })
})

// round 13 新增（Finding 1）：readLeaseGeneration／isValidGeneration 是
// 整套 fencing generation 機制唯一的解析／驗證入口，過去只用
// `Number.isFinite` 加上 `value >= 0`——沒有 safe-integer 檢查，且「格式
// 錯誤」跟「完全缺失」被合併成同一個回傳值（0），是 fail-open。
describe('readLeaseGeneration（Finding 1：safe integer 解析，格式錯誤與缺失必須分開）', () => {
  it('完全缺失（undefined）→ 0（唯一合法回退情境：全新 campaign 從未被任何人取得過租約）', () => {
    expect(readLeaseGeneration(undefined)).toBe(0)
  })

  it.each([
    ['1.5（非整數）', 1.5],
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['-Infinity', -Infinity],
    ['負數', -1],
    ['字串', '3'],
    ['布林值', true],
    ['null', null],
    ['物件', {}],
    ['超出 MAX_SAFE_INTEGER', Number.MAX_SAFE_INTEGER + 1],
  ])('欄位存在但格式錯誤（%s）→ null，不能被當成 0', (_label, badValue) => {
    expect(readLeaseGeneration(badValue)).toBeNull()
  })

  it.each([
    [0, 0],
    [1, 1],
    [Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER - 1],
    [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
  ])('合法值 %d → 原樣回傳', (input, expected) => {
    expect(readLeaseGeneration(input)).toBe(expected)
  })
})

describe('isValidGeneration（Finding 1：驗證呼叫端自己聲稱持有的 generation 參數）', () => {
  it.each([
    [0, true],
    [1, true],
    [Number.MAX_SAFE_INTEGER, true],
    [1.5, false],
    [-1, false],
    [NaN, false],
    [Infinity, false],
    [Number.MAX_SAFE_INTEGER + 1, false],
  ])('isValidGeneration(%s) → %s', (value, expected) => {
    expect(isValidGeneration(value)).toBe(expected)
  })
})

describe('decideAcquireCampaignLease', () => {
  const ready = { recipientsReady: true, status: 'sending' as const }

  it('文件不存在 → not-found', () => {
    expect(decideAcquireCampaignLease(missing, 'me', 0, 1000)).toEqual({
      outcome: 'not-found',
    })
  })

  it('沒有人持有租約 → acquired，並回傳要寫入的 patch（round 10：全新 campaign 從 generation 0 起算，acquire 後變成 1）', () => {
    const decision = decideAcquireCampaignLease(snapOf({ ...ready }), 'me', 1000, 500)
    expect(decision.outcome).toBe('acquired')
    expect(decision).toEqual({
      outcome: 'acquired',
      generation: 1,
      patch: {
        activeAttemptId: 'me',
        activeLeaseExpiresAtMs: 1500,
        lastAttemptId: 'me',
        leaseGeneration: 1,
      },
    })
  })

  // round 10 新增（Finding 1／Finding 2）：generation 必須單調遞增，
  // 不因為過去的租約已被別人持有過而重置。
  it('round 10：generation 從既有值繼續遞增，不論是誰的租約', () => {
    const decision = decideAcquireCampaignLease(
      snapOf({ ...ready, activeAttemptId: 'other', activeLeaseExpiresAtMs: 500, leaseGeneration: 7 }),
      'me',
      1000,
      500,
    )
    expect(decision.outcome).toBe('acquired')
    if (decision.outcome === 'acquired') {
      expect(decision.generation).toBe(8)
      expect(decision.patch.leaseGeneration).toBe(8)
    }
  })

  // round 13 新增（Finding 1）：leaseGeneration 欄位格式錯誤時，過去會被
  // readLeaseGeneration 靜默重設成 0、+1 之後核發 generation:1 的租約——
  // 這是 fail-open（用一個看似正常的新租約掩蓋了資料已經損毀的事實）。
  // 現在必須直接拒絕，不核發任何租約，也絕對不能把 generation 重設成 1。
  it.each([
    ['1.5（非整數）', 1.5],
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['負數', -1],
    ['字串', '3'],
    ['超出 MAX_SAFE_INTEGER', Number.MAX_SAFE_INTEGER + 1],
  ])('leaseGeneration 格式錯誤（%s）→ invalid-generation，不核發租約，不會被重設成 1', (_label, badValue) => {
    const decision = decideAcquireCampaignLease(
      snapOf({ ...ready, leaseGeneration: badValue }),
      'me',
      1000,
      500,
    )
    expect(decision).toEqual({ outcome: 'invalid-generation' })
  })

  it('leaseGeneration 已經是 Number.MAX_SAFE_INTEGER → generation-exhausted，不核發租約（防止 +1 後精度不再嚴格遞增）', () => {
    const decision = decideAcquireCampaignLease(
      snapOf({ ...ready, leaseGeneration: Number.MAX_SAFE_INTEGER }),
      'me',
      1000,
      500,
    )
    expect(decision).toEqual({ outcome: 'generation-exhausted' })
  })

  it('leaseGeneration 是 Number.MAX_SAFE_INTEGER - 1（還沒到上限）→ 正常 acquired，遞增到 MAX_SAFE_INTEGER', () => {
    const decision = decideAcquireCampaignLease(
      snapOf({ ...ready, leaseGeneration: Number.MAX_SAFE_INTEGER - 1 }),
      'me',
      1000,
      500,
    )
    expect(decision.outcome).toBe('acquired')
    if (decision.outcome === 'acquired') {
      expect(decision.generation).toBe(Number.MAX_SAFE_INTEGER)
    }
  })

  it('別人持有未過期租約 → held-by-other，不回傳 patch', () => {
    const decision = decideAcquireCampaignLease(
      snapOf({ ...ready, activeAttemptId: 'other', activeLeaseExpiresAtMs: 2000 }),
      'me',
      1000,
      500,
    )
    expect(decision).toEqual({ outcome: 'held-by-other' })
  })

  it('別人持有的租約已過期 → acquired（可以接手）', () => {
    const decision = decideAcquireCampaignLease(
      snapOf({ ...ready, activeAttemptId: 'other', activeLeaseExpiresAtMs: 500, leaseGeneration: 3 }),
      'me',
      1000,
      500,
    )
    expect(decision.outcome).toBe('acquired')
  })

  it('自己已經持有租約 → acquired（同一 invocation 續租）', () => {
    const decision = decideAcquireCampaignLease(
      snapOf({ ...ready, activeAttemptId: 'me', activeLeaseExpiresAtMs: 2000, leaseGeneration: 3 }),
      'me',
      1000,
      500,
    )
    expect(decision.outcome).toBe('acquired')
  })

  // round 14 新增（Finding 1）：activeAttemptId 存在但 leaseGeneration
  // 缺失／0——這是不一致的狀態（正常流程下兩者永遠是同一次 acquire 原子
  // 寫入），不可靜默當成全新 campaign，必須 invalid-generation。
  it('activeAttemptId 存在但 leaseGeneration 缺失（不一致的資料狀態）→ invalid-generation，不可靜默當成全新 campaign', () => {
    const decision = decideAcquireCampaignLease(
      snapOf({ ...ready, activeAttemptId: 'other', activeLeaseExpiresAtMs: 500 }),
      'me',
      1000,
      500,
    )
    expect(decision).toEqual({ outcome: 'invalid-generation' })
  })

  it('activeAttemptId 存在但 leaseGeneration 明確是 0（同樣不一致）→ invalid-generation', () => {
    const decision = decideAcquireCampaignLease(
      snapOf({ ...ready, activeAttemptId: 'other', activeLeaseExpiresAtMs: 500, leaseGeneration: 0 }),
      'me',
      1000,
      500,
    )
    expect(decision).toEqual({ outcome: 'invalid-generation' })
  })

  it('真正首次、完全沒有任何租約欄位的全新 campaign → 仍能從 0 取得 generation=1（不受一致性檢查影響）', () => {
    const decision = decideAcquireCampaignLease(snapOf({ ...ready }), 'me', 1000, 500)
    expect(decision.outcome).toBe('acquired')
    if (decision.outcome === 'acquired') {
      expect(decision.generation).toBe(1)
    }
  })

  it('status:sending 且 recipientsReady:true → acquired', () => {
    expect(
      decideAcquireCampaignLease(
        snapOf({ recipientsReady: true, status: 'sending' }),
        'me',
        1000,
        500,
      ).outcome,
    ).toBe('acquired')
  })

  it('status:partial 且 recipientsReady:true → acquired（retryCampaign 接續 partial）', () => {
    expect(
      decideAcquireCampaignLease(
        snapOf({ recipientsReady: true, status: 'partial' }),
        'me',
        1000,
        500,
      ).outcome,
    ).toBe('acquired')
  })

  it('status:completed → terminal，永遠不可取得租約，不管租約欄位是什麼', () => {
    expect(
      decideAcquireCampaignLease(
        snapOf({ recipientsReady: true, status: 'completed' }),
        'me',
        1000,
        500,
      ).outcome,
    ).toBe('terminal')
  })

  it('status:failed → terminal，即使 activeAttemptId 已經被清空（finalize 有釋放租約）也一樣', () => {
    const decision = decideAcquireCampaignLease(
      snapOf({ recipientsReady: true, status: 'failed' }),
      'me',
      1000,
      500,
    )
    expect(decision).toEqual({ outcome: 'terminal' })
  })

  it('status:needs_review → terminal（round 7：沒有自動化工作可做，一般 retryCampaign 不能重新取得租約）', () => {
    const decision = decideAcquireCampaignLease(
      snapOf({ recipientsReady: true, status: 'needs_review' }),
      'me',
      1000,
      500,
    )
    expect(decision).toEqual({ outcome: 'terminal' })
  })

  it('recipientsReady 不是 true（建立中）→ not-ready，不看租約', () => {
    expect(
      decideAcquireCampaignLease(
        snapOf({ recipientsReady: false, status: 'sending' }),
        'me',
        1000,
        500,
      ).outcome,
    ).toBe('not-ready')
  })

  it('recipientsReady 缺欄位（視同尚未就緒）→ not-ready', () => {
    expect(
      decideAcquireCampaignLease(snapOf({ status: 'sending' }), 'me', 1000, 500).outcome,
    ).toBe('not-ready')
  })

  it('TOCTOU：呼叫前的非交易讀取看到 sending，但 transaction 內文件其實已經被別人 finalize 成 completed → terminal，不會被誤判成一般的 held-by-other／acquired', () => {
    // 模擬 sendCampaign／retryCampaign 先用 resolveResume 做過一次非交易讀取
    // 判斷是 sending，但實際進這個 transaction 時讀到的是「這段時間內已經
    // 被 finalizeCampaignTx 寫成 completed、並釋放租約」的最新狀態
    //（finalize 已經釋放租約，這裡沒有 activeAttemptId 欄位）。
    const actualTransactionSnap = snapOf({ status: 'completed', recipientsReady: true })
    expect(decideAcquireCampaignLease(actualTransactionSnap, 'me', 1000, 500)).toEqual({
      outcome: 'terminal',
    })
  })

  it('相容讀取：activeLeaseExpiresAt 是舊格式 Timestamp-like 且未過期 → held-by-other', () => {
    const decision = decideAcquireCampaignLease(
      snapOf({
        ...ready,
        activeAttemptId: 'other',
        activeLeaseExpiresAt: { toMillis: () => 2000 },
      }),
      'me',
      1000,
      500,
    )
    expect(decision).toEqual({ outcome: 'held-by-other' })
  })

  it('相容讀取：activeLeaseExpiresAt 是舊格式 Timestamp-like 但已過期 → acquired', () => {
    const decision = decideAcquireCampaignLease(
      snapOf({
        ...ready,
        activeAttemptId: 'other',
        activeLeaseExpiresAt: { toMillis: () => 500 },
        leaseGeneration: 3,
      }),
      'me',
      1000,
      500,
    )
    expect(decision.outcome).toBe('acquired')
  })
})

describe('decideRecipientClaim（round 11 修正，Finding 1／2：campaign fencing + attemptCount 延後到 begin 才累加）', () => {
  const GEN = 5
  const activeCampaign = snapOf({
    activeAttemptId: 'me',
    activeLeaseExpiresAtMs: 1000 + 600_000,
    leaseGeneration: GEN,
  })

  it('recipient 文件不存在 → 不可認領（不讀 campaign）', () => {
    expect(decideRecipientClaim(missing, activeCampaign, 'me', GEN, 0, 1000)).toEqual({
      claimable: false,
    })
  })

  it('queued → 可以認領，寫入 claimed（round 8：不是 sending，還沒呼叫過 SMTP），round 10：記下 claimGeneration，round 11：attemptCount 不在這裡累加，只標記 attemptCountPending', () => {
    const decision = decideRecipientClaim(
      snapOf({ status: 'queued' }),
      activeCampaign,
      'me',
      GEN,
      1000,
      500,
    )
    expect(decision.claimable).toBe(true)
    expect(decision.patch).toEqual({
      status: 'claimed',
      attemptId: 'me',
      claimGeneration: GEN,
      leaseExpiresAtMs: 1500,
      attemptCountPending: true,
    })
  })

  it('sent → 不可認領（同一請求呼叫兩次不會重複寄送），不讀 campaign', () => {
    expect(
      decideRecipientClaim(snapOf({ status: 'sent' }), activeCampaign, 'me', GEN, 1000, 500)
        .claimable,
    ).toBe(false)
  })

  it('claimed 且租期未過 → 不可認領', () => {
    expect(
      decideRecipientClaim(
        snapOf({ status: 'claimed', leaseExpiresAtMs: 2000 }),
        activeCampaign,
        'me',
        GEN,
        1000,
        500,
      ).claimable,
    ).toBe(false)
  })

  it('claimed 且租期已過 → 可以認領', () => {
    const decision = decideRecipientClaim(
      snapOf({ status: 'claimed', leaseExpiresAtMs: 500, attemptCount: 2 }),
      activeCampaign,
      'me',
      GEN,
      1000,
      500,
    )
    expect(decision.claimable).toBe(true)
  })

  // round 8（Finding 1）：sending（已經進入或完成 SMTP delivery attempt）
  // 即使租期已過，也絕對不可以被 claimRecipientTx 重新認領——這正是這一輪
  // 要修的核心問題，只用租期已過來判斷「上一個 invocation 死了」不足以
  // 排除「SMTP 其實已經成功，只是寫回結果失敗」的可能。
  it('sending 且租期已過 → 仍然不可認領（不能假設 SMTP 一定還沒開始）', () => {
    expect(
      decideRecipientClaim(
        snapOf({ status: 'sending', leaseExpiresAtMs: 500, attemptCount: 2 }),
        activeCampaign,
        'me',
        GEN,
        1000,
        500,
      ).claimable,
    ).toBe(false)
  })

  it('相容讀取：舊格式 Timestamp-like 的 leaseExpiresAt 未過期 → 不可認領（不能把舊 active lease 當成不存在而立即重寄）', () => {
    const decision = decideRecipientClaim(
      snapOf({ status: 'claimed', leaseExpiresAt: { toMillis: () => 2000 } }),
      activeCampaign,
      'me',
      GEN,
      1000,
      500,
    )
    expect(decision.claimable).toBe(false)
  })

  it('相容讀取：舊格式 Timestamp-like 的 leaseExpiresAt 已過期 → 可以認領（claimed）', () => {
    const decision = decideRecipientClaim(
      snapOf({ status: 'claimed', leaseExpiresAt: { toMillis: () => 500 }, attemptCount: 1 }),
      activeCampaign,
      'me',
      GEN,
      1000,
      500,
    )
    expect(decision.claimable).toBe(true)
  })

  // round 11 新增（Finding 1）：可重現的時序——舊 invocation A 的 campaign
  // 處理租約過期後，resolution 取得租約、generation 往前推進；A 在這之後
  // 才呼叫 claim，即使收件人本身完全符合認領條件，也必須被 campaign
  // fencing 擋下，不能悄悄把 failed 改成 claimed。
  describe('campaign fencing（Finding 1 核心情境）', () => {
    const claimableRecipient = snapOf({ status: 'failed', attemptCount: 1 })

    it('campaign 文件不存在 → 不可認領，明確 reason: campaign-not-found', () => {
      const decision = decideRecipientClaim(claimableRecipient, missing, 'me', GEN, 1000, 500)
      expect(decision).toEqual({ claimable: false, reason: 'campaign-not-found', data: claimableRecipient.data })
    })

    it('campaign.activeAttemptId 不是自己（例如已經被另一個 invocation 接手）→ 不可認領，reason: campaign-ownership-lost', () => {
      const decision = decideRecipientClaim(
        claimableRecipient,
        snapOf({ activeAttemptId: 'someone-else', activeLeaseExpiresAtMs: 999_999, leaseGeneration: GEN }),
        'me',
        GEN,
        1000,
        500,
      )
      expect(decision.claimable).toBe(false)
      expect(decision.reason).toBe('campaign-ownership-lost')
    })

    it('campaign 處理租約已過期（即使 activeAttemptId 字串還是自己）→ 不可認領，reason: campaign-lease-expired', () => {
      const decision = decideRecipientClaim(
        claimableRecipient,
        snapOf({ activeAttemptId: 'me', activeLeaseExpiresAtMs: 500, leaseGeneration: GEN }),
        'me',
        GEN,
        1000,
        500,
      )
      expect(decision.claimable).toBe(false)
      expect(decision.reason).toBe('campaign-lease-expired')
    })

    it('campaign 處理租約時間無法解析 → 不可認領，reason: campaign-lease-unparseable', () => {
      const decision = decideRecipientClaim(
        claimableRecipient,
        snapOf({ activeAttemptId: 'me', leaseGeneration: GEN }),
        'me',
        GEN,
        1000,
        500,
      )
      expect(decision.claimable).toBe(false)
      expect(decision.reason).toBe('campaign-lease-unparseable')
    })

    // Finding 1 的原始情境：resolution 已經取得租約、generation 已經往前
    // 推進，即使 activeAttemptId 字串與租約時間都還沒被 resolution 動過
    // （resolution 從不改動這兩個欄位），generation 不符這一關也必須擋下。
    it('campaign.leaseGeneration 已經被推進（例如 resolution 已取得租約）→ 不可認領，reason: campaign-generation-mismatch', () => {
      const decision = decideRecipientClaim(
        claimableRecipient,
        snapOf({ activeAttemptId: 'me', activeLeaseExpiresAtMs: 999_999, leaseGeneration: GEN + 1 }),
        'me',
        GEN,
        1000,
        500,
      )
      expect(decision.claimable).toBe(false)
      expect(decision.reason).toBe('campaign-generation-mismatch')
    })

    it('campaign fencing 全部通過 → 可以認領', () => {
      const decision = decideRecipientClaim(claimableRecipient, activeCampaign, 'me', GEN, 1000, 500)
      expect(decision.claimable).toBe(true)
    })

    // round 13 新增（Finding 1）：leaseGeneration 欄位格式錯誤時必須
    // fail closed，reason 是明確的 campaign-generation-invalid，不是
    // campaign-generation-mismatch（那個 reason 代表「兩邊都合法、只是
    // 剛好不同」，跟「根本無法驗證」是不同性質的問題）。
    it.each([
      ['1.5（非整數）', 1.5],
      ['NaN', NaN],
      ['字串', '3'],
      ['超出 MAX_SAFE_INTEGER', Number.MAX_SAFE_INTEGER + 1],
    ])('campaign.leaseGeneration 格式錯誤（%s）→ 不可認領，reason: campaign-generation-invalid', (_label, badValue) => {
      const decision = decideRecipientClaim(
        claimableRecipient,
        snapOf({ activeAttemptId: 'me', activeLeaseExpiresAtMs: 999_999, leaseGeneration: badValue }),
        'me',
        GEN,
        1000,
        500,
      )
      expect(decision.claimable).toBe(false)
      expect(decision.reason).toBe('campaign-generation-invalid')
    })

    // Finding 1 明確要求的情境：malformed campaign generation 經過
    // 「reset 成 0」之後，絕對不能剛好跟一個持有 generation=0 的呼叫端
    // （例如從未真正 acquire 過、或自己的 generation 參數本身也被同樣
    // 方式錯誤解析成 0）意外比對成功。
    it('campaign.leaseGeneration 格式錯誤，即使呼叫端的 generation 剛好是 0，也不可以被誤判成相符', () => {
      const decision = decideRecipientClaim(
        claimableRecipient,
        snapOf({ activeAttemptId: 'me', activeLeaseExpiresAtMs: 999_999, leaseGeneration: 'corrupted' }),
        'me',
        0,
        1000,
        500,
      )
      expect(decision.claimable).toBe(false)
      expect(decision.reason).toBe('campaign-generation-invalid')
    })

    // round 14 新增（Finding 1 核心可重現情境）：campaign.leaseGeneration
    // 完全缺失（不是格式錯誤，是欄位真的不存在），呼叫端的 generation 剛好
    // 是 0——round 13 為止，readLeaseGeneration(undefined)===0 且
    // isValidGeneration(0)===true，兩者會被誤判成相符，讓 claim 通過。
    // 現在必須用 held-generation 版本擋下：0／缺失都不是合法的「已持有」
    // generation。
    it('campaign.leaseGeneration 完全缺失（不是格式錯誤）、呼叫端 generation 剛好是 0 → 不可認領，reason: campaign-generation-invalid（Finding 1 核心情境）', () => {
      const decision = decideRecipientClaim(
        claimableRecipient,
        snapOf({ activeAttemptId: 'me', activeLeaseExpiresAtMs: 999_999 }), // 沒有 leaseGeneration 欄位
        'me',
        0,
        1000,
        500,
      )
      expect(decision.claimable).toBe(false)
      expect(decision.reason).toBe('campaign-generation-invalid')
    })

    it('campaign.leaseGeneration 明確是 0（不是缺失）、呼叫端 generation 也是 0 → 同樣不可認領', () => {
      const decision = decideRecipientClaim(
        claimableRecipient,
        snapOf({ activeAttemptId: 'me', activeLeaseExpiresAtMs: 999_999, leaseGeneration: 0 }),
        'me',
        0,
        1000,
        500,
      )
      expect(decision.claimable).toBe(false)
      expect(decision.reason).toBe('campaign-generation-invalid')
    })

    it('呼叫端自己的 generation 參數不合法（理論上不該發生，防禦性測試）→ 不可認領，reason: campaign-generation-invalid', () => {
      const decision = decideRecipientClaim(claimableRecipient, activeCampaign, 'me', -1, 1000, 500)
      expect(decision.claimable).toBe(false)
      expect(decision.reason).toBe('campaign-generation-invalid')
    })
  })
})

describe('decideBeginDeliveryAttempt（round 8 新增、round 9／10 修正，Finding 1／Finding 2：真正呼叫 sendMail 前的最後一道原子閘門）', () => {
  const RECIPIENT_LEASE_MS_FOR_TEST = 105_000
  const GEN = 3
  const activeCampaign = snapOf({
    activeAttemptId: 'me',
    activeLeaseExpiresAtMs: T0 + 600_000,
    leaseGeneration: GEN,
  })

  it('recipient 文件不存在 → 不 applied', () => {
    expect(
      decideBeginDeliveryAttempt(
        missing,
        activeCampaign,
        'me',
        GEN,
        T0,
        RECIPIENT_LEASE_MS_FOR_TEST,
      ),
    ).toEqual({ applied: false, reason: 'recipient-not-found' })
  })

  it('claimed lease 有效、attemptId 相符、campaign 處理租約仍屬於自己且 generation 相符、attemptCountPending:true 且 claimGeneration 相符（round 11：新版本 claim 寫入的） → applied，轉成 sending、刷新 lease／記錄 deliveryStartedAtMs，attemptCount 從 0 累加為 1', () => {
    const decision = decideBeginDeliveryAttempt(
      snapOf({
        status: 'claimed',
        attemptId: 'me',
        leaseExpiresAtMs: T0 + 50_000,
        attemptCountPending: true,
        claimGeneration: GEN,
      }),
      activeCampaign,
      'me',
      GEN,
      T0,
      RECIPIENT_LEASE_MS_FOR_TEST,
    )
    expect(decision).toEqual({
      applied: true,
      attemptCount: 1,
      patch: {
        status: 'sending',
        leaseExpiresAtMs: T0 + RECIPIENT_LEASE_MS_FOR_TEST,
        deliveryStartedAtMs: T0,
        attemptCount: 1,
        attemptCountPending: false,
      },
    })
  })

  // round 11 新增（Finding 2）：attemptCount 現在只在這裡（真正轉成
  // sending 的那一刻）累加，不是 claim 時；沿用既有值累加，不是每次都歸零。
  it('attemptCountPending:true 且既有 attemptCount 是 2（第三次真正嘗試）→ 累加為 3', () => {
    const decision = decideBeginDeliveryAttempt(
      snapOf({
        status: 'claimed',
        attemptId: 'me',
        leaseExpiresAtMs: T0 + 50_000,
        attemptCountPending: true,
        attemptCount: 2,
        claimGeneration: GEN,
      }),
      activeCampaign,
      'me',
      GEN,
      T0,
      RECIPIENT_LEASE_MS_FOR_TEST,
    )
    expect(decision).toEqual({
      applied: true,
      attemptCount: 3,
      patch: {
        status: 'sending',
        leaseExpiresAtMs: T0 + RECIPIENT_LEASE_MS_FOR_TEST,
        deliveryStartedAtMs: T0,
        attemptCount: 3,
        attemptCountPending: false,
      },
    })
  })

  // round 11 新增（Finding 2）：migration-safe 判斷——這個修正部署之前，
  // claim 當下就已經直接把 attemptCount 累加寫進 recipient 文件（沒有
  // attemptCountPending 這個欄位）。部署切換的當下，可能有 recipient
  // 文件卡在「已經被舊版本 claim（attemptCount 已經算過一次），但還沒
  // begin」的狀態——這裡絕對不能再對它加一次，否則同一次 SMTP attempt
  // 被算成兩次，讓收件人比 MAX_RECIPIENT_ATTEMPTS 更早被判定 exhausted。
  it('legacy claimed 文件（沒有 attemptCountPending 欄位，舊版本 claim 已經算過一次）→ applied，但 attemptCount 不會再被累加，沿用既有值', () => {
    const decision = decideBeginDeliveryAttempt(
      snapOf({
        status: 'claimed',
        attemptId: 'me',
        leaseExpiresAtMs: T0 + 50_000,
        // 沒有 attemptCountPending 欄位——舊版本 claim 寫入的文件
        attemptCount: 2,
      }),
      activeCampaign,
      'me',
      GEN,
      T0,
      RECIPIENT_LEASE_MS_FOR_TEST,
    )
    expect(decision).toEqual({
      applied: true,
      attemptCount: 2, // 不是 3——沒有被重複累加
      patch: {
        status: 'sending',
        leaseExpiresAtMs: T0 + RECIPIENT_LEASE_MS_FOR_TEST,
        deliveryStartedAtMs: T0,
        // patch 完全不包含 attemptCount／attemptCountPending 鍵——不需要
        // 改寫，也不會誤把 attemptCountPending 寫成 false（該欄位本來就
        // 不存在，維持原樣即可）。
      },
    })
  })

  it('legacy claimed 文件、attemptCountPending 欄位值不是 true（例如意外殘留 false）→ 同樣視為已經算過，不重複累加', () => {
    const decision = decideBeginDeliveryAttempt(
      snapOf({
        status: 'claimed',
        attemptId: 'me',
        leaseExpiresAtMs: T0 + 50_000,
        attemptCountPending: false,
        attemptCount: 5,
      }),
      activeCampaign,
      'me',
      GEN,
      T0,
      RECIPIENT_LEASE_MS_FOR_TEST,
    )
    expect(decision.applied).toBe(true)
    if (decision.applied) {
      expect(decision.attemptCount).toBe(5)
      expect(decision.patch.attemptCount).toBeUndefined()
    }
  })

  it('沒有既有 attemptCount 欄位（理論上不該發生，防禦性測試）且 attemptCountPending:true → 從 0 累加為 1，不是 NaN', () => {
    const decision = decideBeginDeliveryAttempt(
      snapOf({
        status: 'claimed',
        attemptId: 'me',
        leaseExpiresAtMs: T0 + 50_000,
        attemptCountPending: true,
        claimGeneration: GEN,
      }),
      activeCampaign,
      'me',
      GEN,
      T0,
      RECIPIENT_LEASE_MS_FOR_TEST,
    )
    expect(decision.applied).toBe(true)
    if (decision.applied) {
      expect(decision.attemptCount).toBe(1)
    }
  })

  it('attemptId 不相符（ownership 在認領後、寄送前這短暫窗口內已經改變）→ 不 applied，呼叫端不得呼叫 sendMail', () => {
    const decision = decideBeginDeliveryAttempt(
      snapOf({ status: 'claimed', attemptId: 'someone-else', leaseExpiresAtMs: T0 + 50_000 }),
      activeCampaign,
      'me',
      GEN,
      T0,
      RECIPIENT_LEASE_MS_FOR_TEST,
    )
    expect(decision).toEqual({ applied: false, reason: 'attempt-id-mismatch' })
  })

  it('狀態已經不是 claimed（例如已經被其他呼叫轉成 sending 或更後面）→ 不 applied', () => {
    const decision = decideBeginDeliveryAttempt(
      snapOf({ status: 'sending', attemptId: 'me', leaseExpiresAtMs: T0 + 50_000 }),
      activeCampaign,
      'me',
      GEN,
      T0,
      RECIPIENT_LEASE_MS_FOR_TEST,
    )
    expect(decision).toEqual({ applied: false, reason: 'not-claimed' })
  })

  // round 9 新增（Finding 1 核心修正）：claim 到 begin 之間 invocation 可能
  // 暫停很久，claimed 的 lease 過期後，即使 attemptId 字串還是相符的舊值，
  // 也不能拿它當成「現在仍然安全」的證明去呼叫 SMTP。
  it('claimed lease 已過期 → 不 applied，即使 attemptId 相符，sendMail 也絕對不能被呼叫', () => {
    const decision = decideBeginDeliveryAttempt(
      snapOf({ status: 'claimed', attemptId: 'me', leaseExpiresAtMs: T0 - 1 }),
      activeCampaign,
      'me',
      GEN,
      T0,
      RECIPIENT_LEASE_MS_FOR_TEST,
    )
    expect(decision).toEqual({ applied: false, reason: 'claimed-lease-expired' })
  })

  it('claimed lease 完全無法解析（missing／NaN／Infinity）→ 不 applied，fail closed', () => {
    expect(
      decideBeginDeliveryAttempt(
        snapOf({ status: 'claimed', attemptId: 'me' }),
        activeCampaign,
        'me',
        GEN,
        T0,
        RECIPIENT_LEASE_MS_FOR_TEST,
      ),
    ).toEqual({ applied: false, reason: 'claimed-lease-unparseable' })
    expect(
      decideBeginDeliveryAttempt(
        snapOf({ status: 'claimed', attemptId: 'me', leaseExpiresAtMs: NaN }),
        activeCampaign,
        'me',
        GEN,
        T0,
        RECIPIENT_LEASE_MS_FOR_TEST,
      ),
    ).toEqual({ applied: false, reason: 'claimed-lease-unparseable' })
    expect(
      decideBeginDeliveryAttempt(
        snapOf({ status: 'claimed', attemptId: 'me', leaseExpiresAtMs: Infinity }),
        activeCampaign,
        'me',
        GEN,
        T0,
        RECIPIENT_LEASE_MS_FOR_TEST,
      ),
    ).toEqual({ applied: false, reason: 'claimed-lease-unparseable' })
  })

  it('campaign 文件不存在 → 不 applied', () => {
    const decision = decideBeginDeliveryAttempt(
      snapOf({ status: 'claimed', attemptId: 'me', leaseExpiresAtMs: T0 + 50_000 }),
      missing,
      'me',
      GEN,
      T0,
      RECIPIENT_LEASE_MS_FOR_TEST,
    )
    expect(decision).toEqual({ applied: false, reason: 'campaign-not-found' })
  })

  // round 9 新增（Finding 1 item 6／7）：campaign 處理租約已經被另一個
  // invocation 接手（activeAttemptId 已經改變），舊 invocation 不能只靠
  // recipient 自己的 attemptId 還沒被動過，就繼續呼叫 SMTP。
  it('campaign activeAttemptId 已經改變（處理租約被另一個 invocation 接手）→ 不 applied', () => {
    const decision = decideBeginDeliveryAttempt(
      snapOf({ status: 'claimed', attemptId: 'me', leaseExpiresAtMs: T0 + 50_000 }),
      snapOf({ activeAttemptId: 'someone-else', activeLeaseExpiresAtMs: T0 + 600_000 }),
      'me',
      GEN,
      T0,
      RECIPIENT_LEASE_MS_FOR_TEST,
    )
    expect(decision).toEqual({ applied: false, reason: 'campaign-ownership-lost' })
  })

  it('campaign 處理租約已經過期（即使 activeAttemptId 字串還沒被改寫）→ 不 applied', () => {
    const decision = decideBeginDeliveryAttempt(
      snapOf({ status: 'claimed', attemptId: 'me', leaseExpiresAtMs: T0 + 50_000 }),
      snapOf({ activeAttemptId: 'me', activeLeaseExpiresAtMs: T0 - 1 }),
      'me',
      GEN,
      T0,
      RECIPIENT_LEASE_MS_FOR_TEST,
    )
    expect(decision).toEqual({ applied: false, reason: 'campaign-lease-expired' })
  })

  // round 10 新增（Finding 1／Finding 2）：activeAttemptId 仍相符、租約也
  // 還沒過期，但中間曾經有一次 resolution 租約被取得（generation 因此
  // 往前推進）——沿用舊的兩個檢查會誤判成安全，這裡必須被 generation
  // 比對擋下來。
  it('campaign leaseGeneration 已經推進（曾經有 resolution 租約被取得）→ 不 applied，即使 activeAttemptId 與租約時間都還「看起來」安全', () => {
    const decision = decideBeginDeliveryAttempt(
      snapOf({ status: 'claimed', attemptId: 'me', leaseExpiresAtMs: T0 + 50_000 }),
      snapOf({ activeAttemptId: 'me', activeLeaseExpiresAtMs: T0 + 600_000, leaseGeneration: GEN + 1 }),
      'me',
      GEN,
      T0,
      RECIPIENT_LEASE_MS_FOR_TEST,
    )
    expect(decision).toEqual({ applied: false, reason: 'campaign-generation-mismatch' })
  })

  // round 13 新增（Finding 1）：campaign.leaseGeneration 格式錯誤時必須
  // fail closed，reason 是明確的 campaign-generation-invalid。
  it.each([
    ['1.5（非整數）', 1.5],
    ['字串', '3'],
    ['超出 MAX_SAFE_INTEGER', Number.MAX_SAFE_INTEGER + 1],
  ])('campaign.leaseGeneration 格式錯誤（%s）→ 不 applied，reason: campaign-generation-invalid', (_label, badValue) => {
    const decision = decideBeginDeliveryAttempt(
      snapOf({ status: 'claimed', attemptId: 'me', leaseExpiresAtMs: T0 + 50_000 }),
      snapOf({ activeAttemptId: 'me', activeLeaseExpiresAtMs: T0 + 600_000, leaseGeneration: badValue }),
      'me',
      GEN,
      T0,
      RECIPIENT_LEASE_MS_FOR_TEST,
    )
    expect(decision).toEqual({ applied: false, reason: 'campaign-generation-invalid' })
  })

  it('campaign.leaseGeneration 格式錯誤，即使呼叫端的 generation 剛好是 0，也不可以被誤判成相符', () => {
    const decision = decideBeginDeliveryAttempt(
      snapOf({ status: 'claimed', attemptId: 'me', leaseExpiresAtMs: T0 + 50_000 }),
      snapOf({ activeAttemptId: 'me', activeLeaseExpiresAtMs: T0 + 600_000, leaseGeneration: 'corrupted' }),
      'me',
      0,
      T0,
      RECIPIENT_LEASE_MS_FOR_TEST,
    )
    expect(decision).toEqual({ applied: false, reason: 'campaign-generation-invalid' })
  })

  // round 14 新增（Finding 1 核心可重現情境）：campaign.leaseGeneration
  // 完全缺失（不是格式錯誤），呼叫端的 generation 剛好是 0。
  it('campaign.leaseGeneration 完全缺失、呼叫端 generation 剛好是 0 → 不 applied（Finding 1 核心情境）', () => {
    const decision = decideBeginDeliveryAttempt(
      snapOf({ status: 'claimed', attemptId: 'me', leaseExpiresAtMs: T0 + 50_000 }),
      snapOf({ activeAttemptId: 'me', activeLeaseExpiresAtMs: T0 + 600_000 }), // 沒有 leaseGeneration
      'me',
      0,
      T0,
      RECIPIENT_LEASE_MS_FOR_TEST,
    )
    expect(decision).toEqual({ applied: false, reason: 'campaign-generation-invalid' })
  })

  // round 12 新增（Finding 3）：attemptCount／attemptCountPending 的
  // runtime 型別驗證——TypeScript 轉型不會驗證 Firestore 實際存的資料，
  // 任何格式錯誤的值都必須 fail closed，不能默默當成 0 或「已經算過」。
  describe('attemptCount／attemptCountPending 的 runtime 型別驗證（Finding 3，fail closed）', () => {
    const base = { status: 'claimed' as const, attemptId: 'me', leaseExpiresAtMs: T0 + 50_000 }

    it.each([
      ['NaN', NaN],
      ['負數', -1],
      ['非整數', 1.5],
      ['字串', '2'],
      ['Infinity', Infinity],
      ['-Infinity', -Infinity],
      ['布林值', true],
      ['null', null],
      ['物件', {}],
    ])('attemptCount 是 %s → invalid-attempt-count，不得呼叫 SMTP', (_label, badValue) => {
      const decision = decideBeginDeliveryAttempt(
        snapOf({ ...base, attemptCountPending: true, claimGeneration: GEN, attemptCount: badValue }),
        activeCampaign,
        'me',
        GEN,
        T0,
        RECIPIENT_LEASE_MS_FOR_TEST,
      )
      expect(decision).toEqual({ applied: false, reason: 'invalid-attempt-count' })
    })

    it('attemptCount 完全缺失（undefined）→ 合法的 legacy schema，回退成 0，正常 applied', () => {
      const decision = decideBeginDeliveryAttempt(
        snapOf({ ...base, attemptCountPending: true, claimGeneration: GEN }),
        activeCampaign,
        'me',
        GEN,
        T0,
        RECIPIENT_LEASE_MS_FOR_TEST,
      )
      expect(decision.applied).toBe(true)
      if (decision.applied) expect(decision.attemptCount).toBe(1)
    })

    it('attemptCount 已經是 Number.MAX_SAFE_INTEGER 且需要累加 → invalid-attempt-count，防止超出 safe integer 範圍', () => {
      const decision = decideBeginDeliveryAttempt(
        snapOf({
          ...base,
          attemptCountPending: true,
          claimGeneration: GEN,
          attemptCount: Number.MAX_SAFE_INTEGER,
        }),
        activeCampaign,
        'me',
        GEN,
        T0,
        RECIPIENT_LEASE_MS_FOR_TEST,
      )
      expect(decision).toEqual({ applied: false, reason: 'invalid-attempt-count' })
    })

    it('attemptCount 是 Number.MAX_SAFE_INTEGER 但不需要累加（legacy，不是 pending）→ 正常 applied，沿用原值', () => {
      const decision = decideBeginDeliveryAttempt(
        snapOf({ ...base, attemptCount: Number.MAX_SAFE_INTEGER }),
        activeCampaign,
        'me',
        GEN,
        T0,
        RECIPIENT_LEASE_MS_FOR_TEST,
      )
      expect(decision.applied).toBe(true)
      if (decision.applied) expect(decision.attemptCount).toBe(Number.MAX_SAFE_INTEGER)
    })

    it.each([
      ['字串 "true"', 'true'],
      ['數字 1', 1],
      ['物件', {}],
      ['null', null],
    ])('attemptCountPending 是 %s（不是 true／false／undefined）→ invalid-attempt-count-pending', (_label, badValue) => {
      const decision = decideBeginDeliveryAttempt(
        snapOf({ ...base, attemptCountPending: badValue, attemptCount: 1 }),
        activeCampaign,
        'me',
        GEN,
        T0,
        RECIPIENT_LEASE_MS_FOR_TEST,
      )
      expect(decision).toEqual({ applied: false, reason: 'invalid-attempt-count-pending' })
    })
  })

  // round 13 新增（Finding 4）：attemptCount 缺失是否可以回退成 0，必須
  // 結合 attemptCountPending 的狀態一起判斷——round 12 版本對所有 claimed
  // 文件一視同仁地把 undefined 回退成 0，這裡改成完整的組合狀態表：
  // pending／counted 狀態下，attemptCount 缺失或是 0 都不是可證明的合法
  // legacy schema（舊版本 claim 寫入 claimed 狀態時一定會把 attemptCount
  // 累加成至少 1），必須 fail closed，不能沿用 round 12 的無條件回退。
  describe('attemptCount 缺失／0 的回退規則，必須結合 attemptCountPending 狀態（Finding 4 組合表）', () => {
    const base = { status: 'claimed' as const, attemptId: 'me', leaseExpiresAtMs: T0 + 50_000 }

    it('pending=true、attemptCount 缺失 → 合法，回退成 0（唯一可證明的合法情境：全新 queued 收件人從未嘗試過）', () => {
      const decision = decideBeginDeliveryAttempt(
        snapOf({ ...base, attemptCountPending: true, claimGeneration: GEN }),
        activeCampaign,
        'me',
        GEN,
        T0,
        RECIPIENT_LEASE_MS_FOR_TEST,
      )
      expect(decision.applied).toBe(true)
      if (decision.applied) expect(decision.attemptCount).toBe(1) // 0 累加為 1
    })

    it('pending=true、attemptCount 是 0（欄位存在但值是 0）→ 合法，等同缺失', () => {
      const decision = decideBeginDeliveryAttempt(
        snapOf({ ...base, attemptCountPending: true, claimGeneration: GEN, attemptCount: 0 }),
        activeCampaign,
        'me',
        GEN,
        T0,
        RECIPIENT_LEASE_MS_FOR_TEST,
      )
      expect(decision.applied).toBe(true)
      if (decision.applied) expect(decision.attemptCount).toBe(1)
    })

    it('pending=true、attemptCount 是合法的既有值（例如 3，第 4 次真正嘗試）→ 合法，累加為 4', () => {
      const decision = decideBeginDeliveryAttempt(
        snapOf({ ...base, attemptCountPending: true, claimGeneration: GEN, attemptCount: 3 }),
        activeCampaign,
        'me',
        GEN,
        T0,
        RECIPIENT_LEASE_MS_FOR_TEST,
      )
      expect(decision.applied).toBe(true)
      if (decision.applied) expect(decision.attemptCount).toBe(4)
    })

    // legacy（attemptCountPending 缺失）：舊版本 claim 寫入 claimed 狀態
    // 時一定會把 attemptCount 累加成至少 1——缺失或 0 都不是可證明的合法
    // legacy schema。
    it('legacy（attemptCountPending 缺失）、attemptCount 也缺失 → invalid-attempt-count，fail closed（不是可證明的 legacy schema）', () => {
      const decision = decideBeginDeliveryAttempt(
        snapOf({ ...base }),
        activeCampaign,
        'me',
        GEN,
        T0,
        RECIPIENT_LEASE_MS_FOR_TEST,
      )
      expect(decision).toEqual({ applied: false, reason: 'invalid-attempt-count' })
    })

    it('legacy、attemptCount 是 0 → invalid-attempt-count，fail closed（claimed 狀態不可能是舊版本 claim 寫出的 0）', () => {
      const decision = decideBeginDeliveryAttempt(
        snapOf({ ...base, attemptCount: 0 }),
        activeCampaign,
        'me',
        GEN,
        T0,
        RECIPIENT_LEASE_MS_FOR_TEST,
      )
      expect(decision).toEqual({ applied: false, reason: 'invalid-attempt-count' })
    })

    it('legacy、attemptCount 是合法的 >=1 值（例如 2）→ 合法，applied，不重複累加', () => {
      const decision = decideBeginDeliveryAttempt(
        snapOf({ ...base, attemptCount: 2 }),
        activeCampaign,
        'me',
        GEN,
        T0,
        RECIPIENT_LEASE_MS_FOR_TEST,
      )
      expect(decision.applied).toBe(true)
      if (decision.applied) expect(decision.attemptCount).toBe(2)
    })

    // counted（attemptCountPending===false）：理論上只有在文件已經轉成
    // sending 之後才會出現（見 decideBeginDeliveryAttempt 的說明，這個組合
    // 只有在 status 仍是 claimed 的防禦性／畸形資料情境下才會被測到），但
    // 一樣套用「必須存在且 >=1」的規則。
    it('counted（attemptCountPending===false）、attemptCount 缺失 → invalid-attempt-count，fail closed', () => {
      const decision = decideBeginDeliveryAttempt(
        snapOf({ ...base, attemptCountPending: false }),
        activeCampaign,
        'me',
        GEN,
        T0,
        RECIPIENT_LEASE_MS_FOR_TEST,
      )
      expect(decision).toEqual({ applied: false, reason: 'invalid-attempt-count' })
    })

    it('counted、attemptCount 是 0 → invalid-attempt-count，fail closed', () => {
      const decision = decideBeginDeliveryAttempt(
        snapOf({ ...base, attemptCountPending: false, attemptCount: 0 }),
        activeCampaign,
        'me',
        GEN,
        T0,
        RECIPIENT_LEASE_MS_FOR_TEST,
      )
      expect(decision).toEqual({ applied: false, reason: 'invalid-attempt-count' })
    })

    it('counted、attemptCount 是合法的 >=1 值 → 合法，applied，不重複累加', () => {
      const decision = decideBeginDeliveryAttempt(
        snapOf({ ...base, attemptCountPending: false, attemptCount: 5 }),
        activeCampaign,
        'me',
        GEN,
        T0,
        RECIPIENT_LEASE_MS_FOR_TEST,
      )
      expect(decision.applied).toBe(true)
      if (decision.applied) expect(decision.attemptCount).toBe(5)
    })
  })

  // round 12 新增（Finding 4）：claimGeneration 過去只是寫入、從未被驗證
  // ——現在真的核對它，跟 campaign.leaseGeneration 是完全獨立的第二道
  // fencing 檢查。
  describe('claimGeneration 的驗證（Finding 4）', () => {
    const base = { status: 'claimed' as const, attemptId: 'me', leaseExpiresAtMs: T0 + 50_000 }

    it('attemptCountPending:true（新版本 claim）但 claimGeneration 缺失 → claim-generation-invalid，fail closed', () => {
      const decision = decideBeginDeliveryAttempt(
        snapOf({ ...base, attemptCountPending: true, attemptCount: 0 }),
        activeCampaign,
        'me',
        GEN,
        T0,
        RECIPIENT_LEASE_MS_FOR_TEST,
      )
      expect(decision).toEqual({ applied: false, reason: 'claim-generation-invalid' })
    })

    it.each([
      ['字串', '3'],
      ['負數', -1],
      ['非整數', 1.5],
      ['NaN', NaN],
    ])('attemptCountPending:true 但 claimGeneration 格式不對（%s）→ claim-generation-invalid', (_label, badValue) => {
      const decision = decideBeginDeliveryAttempt(
        snapOf({ ...base, attemptCountPending: true, attemptCount: 0, claimGeneration: badValue }),
        activeCampaign,
        'me',
        GEN,
        T0,
        RECIPIENT_LEASE_MS_FOR_TEST,
      )
      expect(decision).toEqual({ applied: false, reason: 'claim-generation-invalid' })
    })

    it('attemptCountPending:true，claimGeneration 是合法值但跟呼叫端的 generation 不符 → claim-generation-mismatch', () => {
      const decision = decideBeginDeliveryAttempt(
        snapOf({ ...base, attemptCountPending: true, attemptCount: 0, claimGeneration: GEN + 1 }),
        activeCampaign,
        'me',
        GEN,
        T0,
        RECIPIENT_LEASE_MS_FOR_TEST,
      )
      expect(decision).toEqual({ applied: false, reason: 'claim-generation-mismatch' })
    })

    it('legacy 文件（attemptCountPending 缺失）且 claimGeneration 也缺失 → 合法，正常 applied（舊版本 claim 從不寫這個欄位）', () => {
      const decision = decideBeginDeliveryAttempt(
        snapOf({ ...base, attemptCount: 2 }),
        activeCampaign,
        'me',
        GEN,
        T0,
        RECIPIENT_LEASE_MS_FOR_TEST,
      )
      expect(decision.applied).toBe(true)
    })

    it('legacy 文件（attemptCountPending 缺失）但 claimGeneration 意外存在且不符 → 仍然要 fail closed，不能因為是 legacy 就跳過驗證', () => {
      const decision = decideBeginDeliveryAttempt(
        snapOf({ ...base, attemptCount: 2, claimGeneration: GEN + 1 }),
        activeCampaign,
        'me',
        GEN,
        T0,
        RECIPIENT_LEASE_MS_FOR_TEST,
      )
      expect(decision).toEqual({ applied: false, reason: 'claim-generation-mismatch' })
    })

    it('legacy 文件、claimGeneration 意外存在但格式不對 → claim-generation-invalid', () => {
      const decision = decideBeginDeliveryAttempt(
        snapOf({ ...base, attemptCount: 2, claimGeneration: 'not-a-number' }),
        activeCampaign,
        'me',
        GEN,
        T0,
        RECIPIENT_LEASE_MS_FOR_TEST,
      )
      expect(decision).toEqual({ applied: false, reason: 'claim-generation-invalid' })
    })

    it('legacy 文件、claimGeneration 意外存在且相符 → 正常 applied', () => {
      const decision = decideBeginDeliveryAttempt(
        snapOf({ ...base, attemptCount: 2, claimGeneration: GEN }),
        activeCampaign,
        'me',
        GEN,
        T0,
        RECIPIENT_LEASE_MS_FOR_TEST,
      )
      expect(decision.applied).toBe(true)
    })
  })

  it('刷新後的 sending lease 必須大於 SMTP wall-clock deadline + commit margin（不然又會重演 claim-to-begin 吃掉安全餘裕的問題）', () => {
    expect(RECIPIENT_LEASE_MS).toBeGreaterThan(
      SMTP_SEND_WALL_CLOCK_TIMEOUT_MS + RESULT_COMMIT_MARGIN_MS,
    )
  })

  // round 9：模擬「舊 invocation 暫停到 claimed lease 過期才恢復執行」——
  // 用真實常數（RECIPIENT_LEASE_MS）驗證，不是縮寫的測試用數字。
  it('舊 invocation 暫停到 claimed lease 過期才恢復，仍然不 applied，不會呼叫 sendMail', () => {
    const claimedAtMs = T0
    const resumedAtMs = T0 + RECIPIENT_LEASE_MS + 1 // 暫停超過整個 lease 時長才恢復
    const decision = decideBeginDeliveryAttempt(
      snapOf({
        status: 'claimed',
        attemptId: 'me',
        leaseExpiresAtMs: claimedAtMs + RECIPIENT_LEASE_MS,
      }),
      snapOf({
        activeAttemptId: 'me',
        activeLeaseExpiresAtMs: resumedAtMs + 600_000,
        leaseGeneration: GEN,
      }),
      'me',
      GEN,
      resumedAtMs,
      RECIPIENT_LEASE_MS,
    )
    expect(decision.applied).toBe(false)
  })
})

describe('decideReclaimExpiredDeliveryAttempt（round 8 新增、round 9／10 修正，Finding 1／Finding 3：過期的 delivery attempt 只能轉成 delivery_unknown，不能重新認領）', () => {
  const GEN = 4
  const activeCampaign = snapOf({
    activeAttemptId: 'sweeper',
    activeLeaseExpiresAtMs: T0 + 600_000,
    leaseGeneration: GEN,
  })

  it('recipient 文件不存在 → not-found', () => {
    expect(
      decideReclaimExpiredDeliveryAttempt(missing, activeCampaign, 'sweeper', GEN, T0, 'x')
        .outcome,
    ).toBe('not-found')
  })

  it('狀態不是 sending → not-expired，不動它', () => {
    expect(
      decideReclaimExpiredDeliveryAttempt(
        snapOf({ status: 'claimed' }),
        activeCampaign,
        'sweeper',
        GEN,
        T0,
        'x',
      ).outcome,
    ).toBe('not-expired')
    expect(
      decideReclaimExpiredDeliveryAttempt(
        snapOf({ status: 'queued' }),
        activeCampaign,
        'sweeper',
        GEN,
        T0,
        'x',
      ).outcome,
    ).toBe('not-expired')
  })

  it('sending 但租期還沒過 → not-expired，不動它（可能還在合法處理中）', () => {
    const decision = decideReclaimExpiredDeliveryAttempt(
      snapOf({ status: 'sending', leaseExpiresAtMs: T0 + 1000 }),
      activeCampaign,
      'sweeper',
      GEN,
      T0,
      'x',
    )
    expect(decision.outcome).toBe('not-expired')
  })

  it('sending 且租期已過、sweeper 仍合法持有 campaign 處理租約 → marked-unknown，轉成 delivery_unknown、記錄原因，並清掉 attemptId／lease（保存進 deliveryUnknownOriginalAttemptId）', () => {
    const decision = decideReclaimExpiredDeliveryAttempt(
      snapOf({ status: 'sending', leaseExpiresAtMs: T0 - 1, attemptId: 'stale-attempt' }),
      activeCampaign,
      'sweeper',
      GEN,
      T0,
      '寄送租約已過期，SMTP 可能已經開始但無法確認結果',
    )
    expect(decision).toEqual({
      outcome: 'marked-unknown',
      patch: {
        status: 'delivery_unknown',
        lastError: '寄送租約已過期，SMTP 可能已經開始但無法確認結果',
        deliveryUnknownOriginalAttemptId: 'stale-attempt',
        attemptId: null,
        leaseExpiresAtMs: null,
      },
    })
  })

  // round 9 修正（Finding 3）：過去無法解析回傳 indeterminate、完全不動
  // 它，讓 recipient 永遠卡在 sending、campaign 永遠卡在 partial 卻沒有
  // 任何自動化工作真的在進行——現在保守地也轉成 delivery_unknown，並把
  // 原始無法解析的值記進 lastError 供稽核。
  it('sending 但 leaseExpiresAtMs 完全無法解析 → 保守轉成 marked-unknown（不再是 indeterminate），原始值記進 lastError', () => {
    const decision = decideReclaimExpiredDeliveryAttempt(
      snapOf({ status: 'sending', leaseExpiresAtMs: 'not-a-number' }),
      activeCampaign,
      'sweeper',
      GEN,
      T0,
      '寄送租約已過期',
    )
    expect(decision.outcome).toBe('marked-unknown')
    expect(decision.patch?.status).toBe('delivery_unknown')
    expect(decision.patch?.lastError).toContain('寄送租約已過期')
    expect(decision.patch?.lastError).toContain('not-a-number')
  })

  it('相容讀取：舊格式 Timestamp-like 的 leaseExpiresAt 已過期 → marked-unknown', () => {
    const decision = decideReclaimExpiredDeliveryAttempt(
      snapOf({ status: 'sending', leaseExpiresAt: { toMillis: () => T0 - 1 } }),
      activeCampaign,
      'sweeper',
      GEN,
      T0,
      'x',
    )
    expect(decision.outcome).toBe('marked-unknown')
  })

  // round 9 新增（Finding 3 item 5）：呼叫者自己已經不再合法持有 campaign
  // 處理租約時，不能繼續回收，避免誤傷另一個正在合法接手處理的 invocation。
  it('sweeper 自己已經失去 campaign 處理租約（activeAttemptId 已改變）→ caller-lost-campaign-lease，完全不動這位收件人', () => {
    const decision = decideReclaimExpiredDeliveryAttempt(
      snapOf({ status: 'sending', leaseExpiresAtMs: T0 - 1 }),
      snapOf({ activeAttemptId: 'someone-else', activeLeaseExpiresAtMs: T0 + 600_000 }),
      'sweeper',
      GEN,
      T0,
      'x',
    )
    expect(decision).toEqual({ outcome: 'caller-lost-campaign-lease' })
  })

  it('sweeper 自己的 campaign 處理租約已經過期（即使 activeAttemptId 還沒被改寫）→ caller-lost-campaign-lease', () => {
    const decision = decideReclaimExpiredDeliveryAttempt(
      snapOf({ status: 'sending', leaseExpiresAtMs: T0 - 1 }),
      snapOf({ activeAttemptId: 'sweeper', activeLeaseExpiresAtMs: T0 - 1 }),
      'sweeper',
      GEN,
      T0,
      'x',
    )
    expect(decision).toEqual({ outcome: 'caller-lost-campaign-lease' })
  })

  // round 10 新增（Finding 1／Finding 2）：sweeper 自己的 attemptId 與
  // 租約時間都還「看起來」有效，但中間曾經有一次 resolution 租約被取得
  // （generation 因此往前推進）——一樣要被擋下。
  it('sweeper 自己的 generation 已經落後（曾經有 resolution 租約被取得）→ caller-lost-campaign-lease', () => {
    const decision = decideReclaimExpiredDeliveryAttempt(
      snapOf({ status: 'sending', leaseExpiresAtMs: T0 - 1 }),
      snapOf({ activeAttemptId: 'sweeper', activeLeaseExpiresAtMs: T0 + 600_000, leaseGeneration: GEN + 1 }),
      'sweeper',
      GEN,
      T0,
      'x',
    )
    expect(decision).toEqual({ outcome: 'caller-lost-campaign-lease' })
  })

  it('campaign 文件不存在 → caller-lost-campaign-lease（沒有東西可以驗證 ownership，保守不動）', () => {
    const decision = decideReclaimExpiredDeliveryAttempt(
      snapOf({ status: 'sending', leaseExpiresAtMs: T0 - 1 }),
      missing,
      'sweeper',
      GEN,
      T0,
      'x',
    )
    expect(decision).toEqual({ outcome: 'caller-lost-campaign-lease' })
  })

  // round 13 新增（Finding 1）：campaign.leaseGeneration 格式錯誤時必須
  // fail closed（跟「caller-lost-campaign-lease」是同一個結果，因為這支
  // 函式本來就沒有更細的 outcome 可以區分）。
  it('campaign.leaseGeneration 格式錯誤 → caller-lost-campaign-lease，不回收', () => {
    const decision = decideReclaimExpiredDeliveryAttempt(
      snapOf({ status: 'sending', leaseExpiresAtMs: T0 - 1 }),
      snapOf({ activeAttemptId: 'sweeper', activeLeaseExpiresAtMs: T0 + 600_000, leaseGeneration: 'corrupted' }),
      'sweeper',
      GEN,
      T0,
      'x',
    )
    expect(decision).toEqual({ outcome: 'caller-lost-campaign-lease' })
  })

  it('callerGeneration 剛好是 0 時，campaign.leaseGeneration 格式錯誤也不可以被誤判成相符', () => {
    const decision = decideReclaimExpiredDeliveryAttempt(
      snapOf({ status: 'sending', leaseExpiresAtMs: T0 - 1 }),
      snapOf({ activeAttemptId: 'sweeper', activeLeaseExpiresAtMs: T0 + 600_000, leaseGeneration: NaN }),
      'sweeper',
      0,
      T0,
      'x',
    )
    expect(decision).toEqual({ outcome: 'caller-lost-campaign-lease' })
  })

  // round 14 新增（Finding 1 核心可重現情境）：campaign.leaseGeneration
  // 完全缺失（不是格式錯誤），callerGeneration 剛好是 0。
  it('campaign.leaseGeneration 完全缺失、callerGeneration 剛好是 0 → caller-lost-campaign-lease（Finding 1 核心情境）', () => {
    const decision = decideReclaimExpiredDeliveryAttempt(
      snapOf({ status: 'sending', leaseExpiresAtMs: T0 - 1 }),
      snapOf({ activeAttemptId: 'sweeper', activeLeaseExpiresAtMs: T0 + 600_000 }), // 沒有 leaseGeneration
      'sweeper',
      0,
      T0,
      'x',
    )
    expect(decision).toEqual({ outcome: 'caller-lost-campaign-lease' })
  })
})

describe('decideCommitRecipientResult（round 10 全面重寫，Finding 1：完整的 recipient／campaign fencing）', () => {
  const GEN = 6
  const activeCampaign = snapOf({
    activeAttemptId: 'me',
    activeLeaseExpiresAtMs: T0 + 600_000,
    leaseGeneration: GEN,
  })
  const sendingRecipient = (overrides: Record<string, unknown> = {}) =>
    snapOf({ status: 'sending', attemptId: 'me', leaseExpiresAtMs: T0 + 50_000, ...overrides })

  it('recipient 是 sending、attemptId 相符、兩層 lease 都未過期、generation 相符 → applied', () => {
    expect(
      decideCommitRecipientResult(sendingRecipient(), activeCampaign, 'me', GEN, T0),
    ).toEqual({ applied: true })
  })

  it('recipient 文件不存在 → 不寫入', () => {
    expect(decideCommitRecipientResult(missing, activeCampaign, 'me', GEN, T0)).toEqual({
      applied: false,
      reason: 'recipient-not-found',
    })
  })

  // round 10 核心修正（Finding 1 情境 A／B）：recipient 已經不是
  // sending（被 sweep 轉成 delivery_unknown，或被人工 resolution 處理過）
  // ——即使 attemptId 欄位還沒被清掉（理論上不該發生，round 10 之後兩條
  // 回收路徑都會清掉），status 本身已經不是 sending 這一關就先擋下來。
  it('recipient status 已經不是 sending（例如已經被 sweep／人工 resolution 處理過）→ 不寫入，即使 attemptId 還相符', () => {
    expect(
      decideCommitRecipientResult(
        sendingRecipient({ status: 'delivery_unknown' }),
        activeCampaign,
        'me',
        GEN,
        T0,
      ),
    ).toEqual({ applied: false, reason: 'not-sending' })
  })

  it('recipient attemptId 不符（已被其他 invocation 接手）→ 不寫入', () => {
    expect(
      decideCommitRecipientResult(
        sendingRecipient({ attemptId: 'other' }),
        activeCampaign,
        'me',
        GEN,
        T0,
      ),
    ).toEqual({ applied: false, reason: 'attempt-id-mismatch' })
  })

  it('recipient 自己的 delivery lease 已經過期 → 不寫入，即使 attemptId 還相符', () => {
    expect(
      decideCommitRecipientResult(
        sendingRecipient({ leaseExpiresAtMs: T0 - 1 }),
        activeCampaign,
        'me',
        GEN,
        T0,
      ),
    ).toEqual({ applied: false, reason: 'recipient-lease-expired' })
  })

  it('recipient 自己的 delivery lease 無法解析 → 不寫入，fail closed', () => {
    expect(
      decideCommitRecipientResult(
        sendingRecipient({ leaseExpiresAtMs: undefined }),
        activeCampaign,
        'me',
        GEN,
        T0,
      ),
    ).toEqual({ applied: false, reason: 'recipient-lease-unparseable' })
  })

  it('campaign 文件不存在 → 不寫入', () => {
    expect(
      decideCommitRecipientResult(sendingRecipient(), missing, 'me', GEN, T0),
    ).toEqual({ applied: false, reason: 'campaign-not-found' })
  })

  it('campaign activeAttemptId 已經改變（處理租約被另一個 invocation 接手）→ 不寫入', () => {
    expect(
      decideCommitRecipientResult(
        sendingRecipient(),
        snapOf({ activeAttemptId: 'someone-else', activeLeaseExpiresAtMs: T0 + 600_000, leaseGeneration: GEN }),
        'me',
        GEN,
        T0,
      ),
    ).toEqual({ applied: false, reason: 'campaign-ownership-lost' })
  })

  it('campaign 處理租約已經過期（即使 activeAttemptId 字串還沒被改寫）→ 不寫入', () => {
    expect(
      decideCommitRecipientResult(
        sendingRecipient(),
        snapOf({ activeAttemptId: 'me', activeLeaseExpiresAtMs: T0 - 1, leaseGeneration: GEN }),
        'me',
        GEN,
        T0,
      ),
    ).toEqual({ applied: false, reason: 'campaign-lease-expired' })
  })

  // round 10 核心修正（Finding 1／Finding 2）：這一項是唯一能偵測「中間
  // 曾經有一次 resolution 租約被取得」的檢查——resolution 從不改動
  // activeAttemptId，所以光看 activeAttemptId／租約時間會誤判成安全。
  it('campaign leaseGeneration 已經推進（曾經有 resolution 租約被取得，或另一個 processing invocation 接手過）→ 不寫入', () => {
    expect(
      decideCommitRecipientResult(
        sendingRecipient(),
        snapOf({ activeAttemptId: 'me', activeLeaseExpiresAtMs: T0 + 600_000, leaseGeneration: GEN + 1 }),
        'me',
        GEN,
        T0,
      ),
    ).toEqual({ applied: false, reason: 'campaign-generation-mismatch' })
  })

  // round 13 新增（Finding 1）：campaign.leaseGeneration 格式錯誤時必須
  // fail closed，reason 是明確的 campaign-generation-invalid。
  it('campaign.leaseGeneration 格式錯誤 → 不寫入，reason: campaign-generation-invalid', () => {
    expect(
      decideCommitRecipientResult(
        sendingRecipient(),
        snapOf({ activeAttemptId: 'me', activeLeaseExpiresAtMs: T0 + 600_000, leaseGeneration: 'corrupted' }),
        'me',
        GEN,
        T0,
      ),
    ).toEqual({ applied: false, reason: 'campaign-generation-invalid' })
  })

  it('campaign.leaseGeneration 格式錯誤，即使呼叫端的 generation 剛好是 0，也不可以被誤判成相符', () => {
    expect(
      decideCommitRecipientResult(
        sendingRecipient(),
        snapOf({ activeAttemptId: 'me', activeLeaseExpiresAtMs: T0 + 600_000, leaseGeneration: NaN }),
        'me',
        0,
        T0,
      ),
    ).toEqual({ applied: false, reason: 'campaign-generation-invalid' })
  })

  // round 14 新增（Finding 1 核心可重現情境）：campaign.leaseGeneration
  // 完全缺失（不是格式錯誤），呼叫端的 generation 剛好是 0。
  it('campaign.leaseGeneration 完全缺失、呼叫端 generation 剛好是 0 → 不寫入（Finding 1 核心情境）', () => {
    expect(
      decideCommitRecipientResult(
        sendingRecipient(),
        snapOf({ activeAttemptId: 'me', activeLeaseExpiresAtMs: T0 + 600_000 }), // 沒有 leaseGeneration
        'me',
        0,
        T0,
      ),
    ).toEqual({ applied: false, reason: 'campaign-generation-invalid' })
  })

  // Finding 1 必要情境：新 claim 產生新 attemptId 後，舊 attempt 永遠不可寫。
  it('新的 claim 已經用新 attemptId 認領這位收件人 → 舊 attemptId 的 commit 永遠不可寫', () => {
    // 模擬：recipient 已經被新的 claim 覆寫成別的 attemptId（不論目前是
    // claimed 還是 sending，只要不是舊 attemptId 自己，都不該通過）。
    expect(
      decideCommitRecipientResult(
        sendingRecipient({ attemptId: 'brand-new-attempt' }),
        activeCampaign,
        'stale-old-attempt',
        GEN,
        T0,
      ),
    ).toEqual({ applied: false, reason: 'attempt-id-mismatch' })
  })
})

describe('decideFinalizeCampaign（round 10 修正，Finding 2：不再只驗證 activeAttemptId 字串）', () => {
  const GEN = 9
  const NOW = 1_000_000
  const totals: CampaignTotalsForFinalize = {
    recipients: 10,
    sent: 9,
    failed: 1,
    exhausted: 0,
    deliveryUnknown: 0,
  }
  const activeSnap = (overrides: Record<string, unknown> = {}) =>
    snapOf({
      activeAttemptId: 'me',
      activeLeaseExpiresAtMs: NOW + 600_000,
      leaseGeneration: GEN,
      ...overrides,
    })

  it('仍持有租約（未過期、generation 相符）→ 寫入最終狀態', () => {
    const decision = decideFinalizeCampaign(activeSnap(), 'me', GEN, NOW, totals, 1)
    expect(decision.outcome).toBe('partial')
    expect(decision.patch).toMatchObject({ status: 'partial', lastAttemptId: 'me' })
  })

  it('租約已被別人取代（activeAttemptId 不符）→ superseded，不回傳 patch（不能覆蓋別人的結果）', () => {
    const decision = decideFinalizeCampaign(
      activeSnap({ activeAttemptId: 'other' }),
      'me',
      GEN,
      NOW,
      totals,
      0,
    )
    expect(decision).toEqual({ outcome: 'superseded' })
  })

  // round 10 新增：即使 activeAttemptId 字串還相符，租約本身若已過期，
  // 或 generation 已經被別人（含 resolution）推進，也一律 superseded。
  it('activeAttemptId 相符，但處理租約本身已過期 → superseded', () => {
    const decision = decideFinalizeCampaign(
      activeSnap({ activeLeaseExpiresAtMs: NOW - 1 }),
      'me',
      GEN,
      NOW,
      totals,
      0,
    )
    expect(decision).toEqual({ outcome: 'superseded' })
  })

  it('activeAttemptId 相符、租約也還沒過期，但 leaseGeneration 已經推進（曾經有 resolution 租約被取得）→ superseded', () => {
    const decision = decideFinalizeCampaign(
      activeSnap({ leaseGeneration: GEN + 1 }),
      'me',
      GEN,
      NOW,
      totals,
      0,
    )
    expect(decision).toEqual({ outcome: 'superseded' })
  })

  it('文件不存在 → not-found，仍回報計算出的狀態供呼叫端記錄', () => {
    const decision = decideFinalizeCampaign(missing, 'me', GEN, NOW, totals, 0)
    expect(decision.outcome).toBe('not-found')
    expect(decision.patch).toBeUndefined()
  })

  it('nonTerminalCount 為 0 且全部成功 → completed', () => {
    const decision = decideFinalizeCampaign(
      activeSnap(),
      'me',
      GEN,
      NOW,
      { recipients: 5, sent: 5, failed: 0, exhausted: 0, deliveryUnknown: 0 },
      0,
    )
    expect(decision.outcome).toBe('completed')
  })

  it('deliveryUnknown > 0、其餘都到終止狀態 → needs_review，patch 裡的 totals.deliveryUnknown 正確寫入', () => {
    const decision = decideFinalizeCampaign(
      activeSnap(),
      'me',
      GEN,
      NOW,
      { recipients: 10, sent: 8, failed: 0, exhausted: 0, deliveryUnknown: 2 },
      0,
    )
    expect(decision.outcome).toBe('needs_review')
    expect(decision.patch).toMatchObject({
      status: 'needs_review',
      'totals.deliveryUnknown': 2,
      'totals.sent': 8,
    })
  })

  // round 13 新增（Finding 1）：campaign.leaseGeneration 格式錯誤時必須
  // fail closed（同樣折進 superseded，這支函式沒有更細的 outcome）。
  it('campaign.leaseGeneration 格式錯誤 → superseded，不寫入', () => {
    const decision = decideFinalizeCampaign(
      activeSnap({ leaseGeneration: 'corrupted' }),
      'me',
      GEN,
      NOW,
      totals,
      0,
    )
    expect(decision).toEqual({ outcome: 'superseded' })
  })

  it('呼叫端 generation 剛好是 0，campaign.leaseGeneration 格式錯誤也不可以被誤判成相符', () => {
    const decision = decideFinalizeCampaign(
      activeSnap({ leaseGeneration: NaN }),
      'me',
      0,
      NOW,
      totals,
      0,
    )
    expect(decision).toEqual({ outcome: 'superseded' })
  })

  // round 14 新增（Finding 1 核心可重現情境）：campaign.leaseGeneration
  // 完全缺失（不是格式錯誤），呼叫端的 generation 剛好是 0。
  it('campaign.leaseGeneration 完全缺失、呼叫端 generation 剛好是 0 → superseded（Finding 1 核心情境）', () => {
    const decision = decideFinalizeCampaign(
      activeSnap({ leaseGeneration: undefined }),
      'me',
      0,
      NOW,
      totals,
      0,
    )
    expect(decision).toEqual({ outcome: 'superseded' })
  })
})

describe('decideFinalizeCampaignWithPressRelease（round 16 新增，Finding 4；round 18 修正 Finding 1：campaign finalize 與新聞稿同步的合併決策，無法安全判斷時不得讓 campaign 變成 terminal）', () => {
  const GEN = 9
  const NOW = 1_000_000
  const totalsWithSent: CampaignTotalsForFinalize = {
    recipients: 10,
    sent: 9,
    failed: 1,
    exhausted: 0,
    deliveryUnknown: 0,
  }
  const totalsNoSent: CampaignTotalsForFinalize = {
    recipients: 10,
    sent: 0,
    failed: 10,
    exhausted: 0,
    deliveryUnknown: 0,
  }
  const campaignSnap = (overrides: Record<string, unknown> = {}) =>
    snapOf({
      activeAttemptId: 'me',
      activeLeaseExpiresAtMs: NOW + 600_000,
      leaseGeneration: GEN,
      pressReleaseId: 'pr1',
      // mode／isTest 都必須存在且一致才會被當成正式發送——見
      // resolveCampaignSendKind()。
      mode: 'real',
      isTest: false,
      ...overrides,
    })
  const pressReleaseSnap = snapOf({ status: 'draft', sentAt: undefined })

  it('finalize 沒有 patch（superseded）→ outcome:finalized，pressReleaseUpdated 一律 false，不論 totals 或 pressReleaseSnap 是什麼', () => {
    const decision = decideFinalizeCampaignWithPressRelease(
      campaignSnap({ activeAttemptId: 'other' }),
      pressReleaseSnap,
      'me',
      GEN,
      NOW,
      totalsWithSent,
      0,
    )
    expect(decision.outcome).toBe('finalized')
    if (decision.outcome === 'finalized') {
      expect(decision.finalize).toEqual({ outcome: 'superseded' })
      expect(decision.pressReleaseUpdated).toBe(false)
    }
  })

  it('finalize 是 completed，totals.sent>0，新聞稿存在，不是測試信 → outcome:finalized，pressReleaseUpdated:true', () => {
    const decision = decideFinalizeCampaignWithPressRelease(
      campaignSnap(),
      pressReleaseSnap,
      'me',
      GEN,
      NOW,
      totalsWithSent,
      0,
    )
    expect(decision.outcome).toBe('finalized')
    if (decision.outcome === 'finalized') {
      expect(decision.finalize.outcome).toBe('completed')
      expect(decision.pressReleaseUpdated).toBe(true)
    }
  })

  it('outcome 是 partial → outcome:finalized，pressReleaseUpdated:false，即使 totals.sent>0（還沒真正收尾，不能提早標記已發送）——不論 mode／isTest／pressReleaseId 是什麼都一樣（Finding 1 項目 6）', () => {
    const decision = decideFinalizeCampaignWithPressRelease(
      campaignSnap({ mode: undefined, isTest: undefined, pressReleaseId: undefined }),
      pressReleaseSnap,
      'me',
      GEN,
      NOW,
      totalsWithSent,
      1, // nonTerminalCount > 0 → partial
    )
    expect(decision.outcome).toBe('finalized')
    if (decision.outcome === 'finalized') {
      expect(decision.finalize.outcome).toBe('partial')
      expect(decision.pressReleaseUpdated).toBe(false)
    }
  })

  it('totals.sent === 0（確認值，不是格式錯誤）→ outcome:finalized，pressReleaseUpdated:false——不論 mode／isTest 是什麼都一樣（Finding 1 項目 6）', () => {
    const decision = decideFinalizeCampaignWithPressRelease(
      campaignSnap({ mode: undefined, isTest: undefined }),
      pressReleaseSnap,
      'me',
      GEN,
      NOW,
      totalsNoSent,
      0,
    )
    expect(decision.outcome).toBe('finalized')
    if (decision.outcome === 'finalized') {
      expect(decision.finalize.outcome).toBe('failed')
      expect(decision.pressReleaseUpdated).toBe(false)
    }
  })

  it('campaign.isTest === true（且 mode 一致）→ outcome:finalized，pressReleaseUpdated:false，不論新聞稿狀態（Finding 4 項目 5：測試信不得修改新聞稿）', () => {
    const decision = decideFinalizeCampaignWithPressRelease(
      campaignSnap({ isTest: true, mode: 'self' }),
      pressReleaseSnap,
      'me',
      GEN,
      NOW,
      totalsWithSent,
      0,
    )
    expect(decision.outcome).toBe('finalized')
    if (decision.outcome === 'finalized') expect(decision.pressReleaseUpdated).toBe(false)
  })

  it('needs_review 結果（totals.deliveryUnknown>0）也算是需要同步的終止結果', () => {
    const totalsWithUnknown: CampaignTotalsForFinalize = {
      recipients: 10,
      sent: 5,
      failed: 0,
      exhausted: 0,
      deliveryUnknown: 5,
    }
    const decision = decideFinalizeCampaignWithPressRelease(
      campaignSnap(),
      pressReleaseSnap,
      'me',
      GEN,
      NOW,
      totalsWithUnknown,
      0,
    )
    expect(decision.outcome).toBe('finalized')
    if (decision.outcome === 'finalized') {
      expect(decision.finalize.outcome).toBe('needs_review')
      expect(decision.pressReleaseUpdated).toBe(true)
    }
  })

  // round 18 核心迴歸案例（Finding 1）：這是本輪要修的核心問題——
  // metadata 無法安全判斷、或已確認需要同步卻找不到新聞稿時，
  // campaign 完全不能變成 terminal。
  describe('round 18 核心迴歸（Finding 1）：無法安全判斷時 outcome:blocked，不含 finalize.patch，campaign 不會變成 terminal', () => {
    it('mode/isTest 缺失（invalid），totals.sent>0，outcome 本應是 completed → outcome:blocked，reason:invalid-campaign-metadata', () => {
      const decision = decideFinalizeCampaignWithPressRelease(
        campaignSnap({ mode: undefined, isTest: undefined }),
        pressReleaseSnap,
        'me',
        GEN,
        NOW,
        totalsWithSent,
        0,
      )
      expect(decision.outcome).toBe('blocked')
      if (decision.outcome === 'blocked') {
        expect(decision.reason).toBe('invalid-campaign-metadata')
        expect(decision.releaseDecision.outcome).toBe('released')
      }
    })

    it('mode/isTest 互相矛盾，totals.sent>0 → outcome:blocked，reason:invalid-campaign-metadata', () => {
      const decision = decideFinalizeCampaignWithPressRelease(
        campaignSnap({ mode: 'real', isTest: true }),
        pressReleaseSnap,
        'me',
        GEN,
        NOW,
        totalsWithSent,
        0,
      )
      expect(decision.outcome).toBe('blocked')
      if (decision.outcome === 'blocked') expect(decision.reason).toBe('invalid-campaign-metadata')
    })

    it.each([NaN, Infinity, -Infinity, -1, 1.5, '5', null, undefined])(
      'totals.sent=%s（格式錯誤，不是確認的 0）→ outcome:blocked，reason:invalid-campaign-metadata',
      (sent) => {
        const decision = decideFinalizeCampaignWithPressRelease(
          campaignSnap(),
          pressReleaseSnap,
          'me',
          GEN,
          NOW,
          { recipients: 10, sent: sent as unknown as number, failed: 0, exhausted: 0, deliveryUnknown: 0 },
          0,
        )
        expect(decision.outcome).toBe('blocked')
        if (decision.outcome === 'blocked') expect(decision.reason).toBe('invalid-campaign-metadata')
      },
    )

    it('確認是正式發送、totals.sent>0，但 pressReleaseId 缺失 → outcome:blocked，reason:press-release-not-found（對正式發送而言缺失本身就是資料損毀）', () => {
      const decision = decideFinalizeCampaignWithPressRelease(
        campaignSnap({ pressReleaseId: undefined }),
        pressReleaseSnap,
        'me',
        GEN,
        NOW,
        totalsWithSent,
        0,
      )
      expect(decision.outcome).toBe('blocked')
      if (decision.outcome === 'blocked') expect(decision.reason).toBe('press-release-not-found')
    })

    it("pressReleaseId 含 '/'（格式錯誤）→ outcome:blocked，reason:press-release-not-found", () => {
      const decision = decideFinalizeCampaignWithPressRelease(
        campaignSnap({ pressReleaseId: 'a/b' }),
        pressReleaseSnap,
        'me',
        GEN,
        NOW,
        totalsWithSent,
        0,
      )
      expect(decision.outcome).toBe('blocked')
      if (decision.outcome === 'blocked') expect(decision.reason).toBe('press-release-not-found')
    })

    it('pressReleaseId 合法，但對應新聞稿文件不存在（pressReleaseSnap 是 null 或 exists:false）→ outcome:blocked，reason:press-release-not-found，不會讓 campaign 獨立完成（Finding 6）', () => {
      const decisionNull = decideFinalizeCampaignWithPressRelease(
        campaignSnap(),
        null,
        'me',
        GEN,
        NOW,
        totalsWithSent,
        0,
      )
      expect(decisionNull.outcome).toBe('blocked')
      if (decisionNull.outcome === 'blocked') expect(decisionNull.reason).toBe('press-release-not-found')

      const decisionNotExists = decideFinalizeCampaignWithPressRelease(
        campaignSnap(),
        { exists: false, data: undefined },
        'me',
        GEN,
        NOW,
        totalsWithSent,
        0,
      )
      expect(decisionNotExists.outcome).toBe('blocked')
    })

    it('blocked 時，仍然合法持有租約（attemptId／generation 都相符）→ releaseDecision.outcome:released——這是結構性保證：只有 decideFinalizeCampaign 本身確認 patch 存在（attemptId／generation／expiry 全部合法）才會走到 blocked 的評估，而 decideReleaseCampaignProcessingLease 的擁有權檢查（attemptId／generation）是前者的子集，不可能出現「finalize 判定有 patch，但 release 判定不是自己」的組合', () => {
      const decision = decideFinalizeCampaignWithPressRelease(
        campaignSnap({ mode: undefined, isTest: undefined }),
        pressReleaseSnap,
        'me',
        GEN,
        NOW,
        totalsWithSent,
        0,
      )
      expect(decision.outcome).toBe('blocked')
      if (decision.outcome === 'blocked') {
        expect(decision.releaseDecision.outcome).toBe('released')
      }
    })
  })
})

describe('finalizeCampaignWithPressReleaseTx（round 16 新增，Finding 4；round 18 修正 Finding 1：campaign 與新聞稿在同一個 transaction 內原子寫入，無法安全判斷時不寫入 campaign 的 terminal patch）', () => {
  const GEN = 9
  const NOW = 1_000_000
  const totalsWithSent: CampaignTotalsForFinalize = {
    recipients: 10,
    sent: 9,
    failed: 1,
    exhausted: 0,
    deliveryUnknown: 0,
  }
  const releaseLeaseFields = (d: { outcome: string }) => ({
    activeAttemptId: '__deleted__',
    activeLeaseExpiresAtMs: '__deleted__',
    updatedAt: '__server_ts__',
    ...(d.outcome === 'completed' ? { completedAt: '__server_ts__' } : {}),
  })
  const pressReleaseFields = () => ({ status: 'sent', sentAt: '__server_ts__' })
  const blockedReleaseFields = () => ({
    activeAttemptId: '__deleted__',
    activeLeaseExpiresAtMs: '__deleted__',
    updatedAt: '__server_ts__',
  })

  it('campaign 與新聞稿一起寫入：campaign 的 patch／租約釋放欄位，以及新聞稿的 status／sentAt 都確實被 update() 呼叫', async () => {
    const campaignDoc = fakeDocTx({
      activeAttemptId: 'me',
      activeLeaseExpiresAtMs: NOW + 600_000,
      leaseGeneration: GEN,
      pressReleaseId: 'pr1',
      mode: 'real',
      isTest: false,
    })
    const pressReleaseDoc = fakeDocTx({ status: 'draft' })
    const decision = await finalizeCampaignWithPressReleaseTx(
      campaignDoc,
      () => pressReleaseDoc,
      'me',
      GEN,
      NOW,
      totalsWithSent,
      0,
      releaseLeaseFields,
      pressReleaseFields,
      blockedReleaseFields,
    )
    expect(decision.outcome).toBe('finalized')
    if (decision.outcome === 'finalized') {
      expect(decision.finalize.outcome).toBe('completed')
      expect(decision.pressReleaseUpdated).toBe(true)
    }
    expect(campaignDoc.updates.length).toBe(1)
    expect(campaignDoc.current()?.status).toBe('completed')
    expect(pressReleaseDoc.updates.length).toBe(1)
    expect(pressReleaseDoc.current()?.status).toBe('sent')
  })

  it('新聞稿不存在時：campaign 不會寫入 terminal patch，只會安全釋放租約——維持原本非終止狀態', async () => {
    const campaignDoc = fakeDocTx({
      status: 'sending',
      activeAttemptId: 'me',
      activeLeaseExpiresAtMs: NOW + 600_000,
      leaseGeneration: GEN,
      pressReleaseId: 'pr-deleted',
      mode: 'real',
      isTest: false,
    })
    const pressReleaseDoc = fakeDocTx(undefined) // 不存在
    const decision = await finalizeCampaignWithPressReleaseTx(
      campaignDoc,
      () => pressReleaseDoc,
      'me',
      GEN,
      NOW,
      totalsWithSent,
      0,
      releaseLeaseFields,
      pressReleaseFields,
      blockedReleaseFields,
    )
    expect(decision.outcome).toBe('blocked')
    if (decision.outcome === 'blocked') expect(decision.reason).toBe('press-release-not-found')
    // campaign 完全沒有變成 terminal——status 保持原樣，只有租約欄位被清掉。
    expect(campaignDoc.current()?.status).toBe('sending')
    expect(campaignDoc.current()?.activeAttemptId).toBe('__deleted__')
    expect(campaignDoc.current()?.completedAt).toBeUndefined()
    expect(pressReleaseDoc.updates.length).toBe(0) // 新聞稿完全沒被寫
  })

  it('superseded 時完全不會呼叫 getPressReleaseDoc（不需要讀新聞稿，不會多一次不必要的讀取），也不會呼叫 blockedReleaseFields', async () => {
    const campaignDoc = fakeDocTx({
      activeAttemptId: 'other',
      activeLeaseExpiresAtMs: NOW + 600_000,
      leaseGeneration: GEN,
      pressReleaseId: 'pr1',
      mode: 'real',
      isTest: false,
    })
    const getPressReleaseDoc = vi.fn(() => fakeDocTx({ status: 'draft' }))
    const blockedFieldsSpy = vi.fn(blockedReleaseFields)
    const decision = await finalizeCampaignWithPressReleaseTx(
      campaignDoc,
      getPressReleaseDoc,
      'me',
      GEN,
      NOW,
      totalsWithSent,
      0,
      releaseLeaseFields,
      pressReleaseFields,
      blockedFieldsSpy,
    )
    expect(decision.outcome).toBe('finalized')
    if (decision.outcome === 'finalized') {
      expect(decision.finalize.outcome).toBe('superseded')
      expect(decision.pressReleaseUpdated).toBe(false)
    }
    expect(getPressReleaseDoc).not.toHaveBeenCalled()
    expect(blockedFieldsSpy).not.toHaveBeenCalled()
    expect(campaignDoc.updates.length).toBe(0)
  })

  it('isTest:true（mode 一致）時不會呼叫 getPressReleaseDoc，也不會寫入新聞稿——campaign 正常 finalize', async () => {
    const campaignDoc = fakeDocTx({
      activeAttemptId: 'me',
      activeLeaseExpiresAtMs: NOW + 600_000,
      leaseGeneration: GEN,
      pressReleaseId: 'pr1',
      mode: 'self',
      isTest: true,
    })
    const getPressReleaseDoc = vi.fn(() => fakeDocTx({ status: 'draft' }))
    const decision = await finalizeCampaignWithPressReleaseTx(
      campaignDoc,
      getPressReleaseDoc,
      'me',
      GEN,
      NOW,
      totalsWithSent,
      0,
      releaseLeaseFields,
      pressReleaseFields,
      blockedReleaseFields,
    )
    expect(decision.outcome).toBe('finalized')
    if (decision.outcome === 'finalized') expect(decision.pressReleaseUpdated).toBe(false)
    expect(getPressReleaseDoc).not.toHaveBeenCalled()
    expect(campaignDoc.updates.length).toBe(1) // campaign 本身仍然正常 finalize
  })

  it('round 18 核心迴歸（Finding 1）：mode/isTest 缺失時，campaign 完全不會被寫入 terminal patch，也不會呼叫 pressReleaseFields——campaign 與新聞稿兩邊都不寫', async () => {
    const campaignDoc = fakeDocTx({
      status: 'sending',
      activeAttemptId: 'me',
      activeLeaseExpiresAtMs: NOW + 600_000,
      leaseGeneration: GEN,
      pressReleaseId: 'pr1',
      // mode／isTest 刻意缺失
    })
    const pressReleaseDoc = fakeDocTx({ status: 'draft' })
    const pressReleaseFieldsSpy = vi.fn(pressReleaseFields)
    const decision = await finalizeCampaignWithPressReleaseTx(
      campaignDoc,
      () => pressReleaseDoc,
      'me',
      GEN,
      NOW,
      totalsWithSent,
      0,
      releaseLeaseFields,
      pressReleaseFieldsSpy,
      blockedReleaseFields,
    )
    expect(decision.outcome).toBe('blocked')
    if (decision.outcome === 'blocked') expect(decision.reason).toBe('invalid-campaign-metadata')
    expect(campaignDoc.current()?.status).toBe('sending')
    expect(campaignDoc.current()?.completedAt).toBeUndefined()
    expect(pressReleaseFieldsSpy).not.toHaveBeenCalled()
    expect(pressReleaseDoc.updates.length).toBe(0)
  })

  it('round 18 迴歸（Finding 1 項目 3）：blocked 時只清租約欄位，不寫入 status／totals／completedAt／lastError 等任何 campaign 本身的欄位', async () => {
    const campaignDoc = fakeDocTx({
      status: 'sending',
      totals: { recipients: 0, sent: 0, failed: 0, exhausted: 0, deliveryUnknown: 0 },
      activeAttemptId: 'me',
      activeLeaseExpiresAtMs: NOW + 600_000,
      leaseGeneration: GEN,
      pressReleaseId: 'pr1',
      mode: 'real',
      isTest: false,
    })
    const decision = await finalizeCampaignWithPressReleaseTx(
      campaignDoc,
      () => fakeDocTx(undefined),
      'me',
      GEN,
      NOW,
      totalsWithSent,
      0,
      releaseLeaseFields,
      pressReleaseFields,
      blockedReleaseFields,
    )
    expect(decision.outcome).toBe('blocked')
    expect(campaignDoc.updates.length).toBe(1)
    expect(campaignDoc.updates[0]).toEqual({
      activeAttemptId: '__deleted__',
      activeLeaseExpiresAtMs: '__deleted__',
      updatedAt: '__server_ts__',
    })
    // 底層文件的 status／totals 完全沒被動到。
    expect(campaignDoc.current()?.status).toBe('sending')
    expect(campaignDoc.current()?.totals).toEqual({
      recipients: 0,
      sent: 0,
      failed: 0,
      exhausted: 0,
      deliveryUnknown: 0,
    })
  })
})

describe('decidePressReleaseSyncRepair（round 16 新增，Finding 4；round 18 修正，Finding 5；round 20 修正，Finding 3：sentAt 必須是真正的 canonical Timestamp，純數字不算已同步，completedAt／sentAt 的合理性改用 nowMs 與新的上下界）', () => {
  // round 20 修正（Finding 3）：isPlausibleCompletedAtMs() 的下界現在是
  // 這個專案 git 歷史最早的 commit（2026-07-20）往前抓的整月
  // （2026-07-01），過去測試沿用的 1_700_000_000_000（西元 2023 年，遠早於
  // 這個下界）已經不再是合理的 fixture，改用落在新範圍內的常數。
  const NOW_MS = Date.UTC(2026, 7, 15) // 2026-08-15T00:00:00Z
  const VALID_COMPLETED_AT_MS = Date.UTC(2026, 7, 1) // 2026-08-01T00:00:00Z，早於 NOW_MS

  // round 18 修正（Finding 5）：terminalCampaign 預設帶一個合法的
  // completedAt，代表「這是一筆已經有可信完成時間的正常歷史資料」；
  // 需要測試 completedAt 缺失／格式錯誤的案例時才會用 overrides 覆蓋掉。
  const terminalCampaign = (overrides: Record<string, unknown> = {}) =>
    snapOf({
      status: 'completed',
      mode: 'real',
      isTest: false,
      totals: { sent: 5 },
      pressReleaseId: 'pr1',
      completedAt: VALID_COMPLETED_AT_MS,
      ...overrides,
    })
  const draftPressRelease = snapOf({ status: 'draft' })
  const fakeTimestamp = (ms: number) => ({ toMillis: () => ms })
  // round 17 修正（Finding 5）；round 20 修正（Finding 3）：真正符合「已
  // 同步」invariant 的新聞稿必須同時有合法的 status **與真正的 canonical
  // Timestamp**（不是純數字）——見下方 isCanonicalSentAt() 的說明。
  const sentPressRelease = snapOf({ status: 'sent', sentAt: fakeTimestamp(VALID_COMPLETED_AT_MS) })

  it('campaign 不存在 → campaign-not-found，shouldWrite:false', () => {
    expect(decidePressReleaseSyncRepair(missing, draftPressRelease, NOW_MS)).toEqual({
      outcome: 'campaign-not-found',
      shouldWrite: false,
    })
  })

  it.each(['sending', 'partial'])(
    'campaign status:%s（非終止）→ not-terminal，絕不能在還在寄送中時修改新聞稿',
    (status) => {
      expect(
        decidePressReleaseSyncRepair(terminalCampaign({ status }), draftPressRelease, NOW_MS),
      ).toEqual({ outcome: 'not-terminal', shouldWrite: false })
    },
  )

  it('campaign.isTest === true（mode 一致）→ test-campaign，永遠不寫（Finding 4 項目 5）', () => {
    expect(
      decidePressReleaseSyncRepair(
        terminalCampaign({ isTest: true, mode: 'self' }),
        draftPressRelease,
        NOW_MS,
      ),
    ).toEqual({ outcome: 'test-campaign', shouldWrite: false })
  })

  it('totals.sent === 0 → no-sent-recipients，沒有東西可以同步', () => {
    expect(
      decidePressReleaseSyncRepair(
        terminalCampaign({ totals: { sent: 0 } }),
        draftPressRelease,
        NOW_MS,
      ),
    ).toEqual({ outcome: 'no-sent-recipients', shouldWrite: false })
  })

  it('pressReleaseId 缺失／空字串 → missing-press-release-id', () => {
    expect(
      decidePressReleaseSyncRepair(
        terminalCampaign({ pressReleaseId: undefined }),
        draftPressRelease,
        NOW_MS,
      ),
    ).toEqual({ outcome: 'missing-press-release-id', shouldWrite: false })
  })

  it('新聞稿不存在（pressReleaseSnap 是 null 或 exists:false）→ press-release-not-found', () => {
    expect(decidePressReleaseSyncRepair(terminalCampaign(), null, NOW_MS)).toEqual({
      outcome: 'press-release-not-found',
      shouldWrite: false,
    })
    expect(
      decidePressReleaseSyncRepair(
        terminalCampaign(),
        { exists: false, data: undefined },
        NOW_MS,
      ),
    ).toEqual({ outcome: 'press-release-not-found', shouldWrite: false })
  })

  it('新聞稿已經是 status:sent 且 sentAt 是真正的 canonical Timestamp（合理值）→ already-synced（冪等，不重複寫入，可安全重複呼叫）', () => {
    expect(decidePressReleaseSyncRepair(terminalCampaign(), sentPressRelease, NOW_MS)).toEqual({
      outcome: 'already-synced',
      shouldWrite: false,
    })
  })

  it('terminal、非測試、totals.sent>0、新聞稿存在且尚未同步、completedAt 合法 → synced，shouldWrite:true，並且把 completedAt 換算成毫秒數帶出來當作 authoritativeCompletedAtMs（round 19 修正，Finding 2：canonical schema，不是原始 unknown 值）', () => {
    expect(decidePressReleaseSyncRepair(terminalCampaign(), draftPressRelease, NOW_MS)).toEqual({
      outcome: 'synced',
      shouldWrite: true,
      authoritativeCompletedAtMs: VALID_COMPLETED_AT_MS,
    })
  })

  it.each(['failed', 'needs_review'])('status:%s 也是合法的終止狀態，可以修復', (status) => {
    expect(
      decidePressReleaseSyncRepair(terminalCampaign({ status }), draftPressRelease, NOW_MS),
    ).toEqual({
      outcome: 'synced',
      shouldWrite: true,
      authoritativeCompletedAtMs: VALID_COMPLETED_AT_MS,
    })
  })

  // round 20 新增（Finding 3，P2 核心）：sentAt 是**純數字**（canonical
  // 遷移原本應該淘汰的資料型態）——即使 status 是 sent 且能被
  // readMsCompat() 解析成合理的毫秒數，也絕不能視為「已同步」，必須落入
  // synced 分支重新寫入一個真正的 Timestamp，這樣修復工具才真的能自動
  // 修好歷史上的純數字 sentAt，不再是「只能人工遷移」的殘餘風險。
  it('round 20 新增（Finding 3）：sentAt 是純數字（不是 Timestamp-like）→ 不是 already-synced，會用 completedAt 重新算出 synced', () => {
    const numericSentAtPressRelease = snapOf({ status: 'sent', sentAt: VALID_COMPLETED_AT_MS })
    expect(
      decidePressReleaseSyncRepair(terminalCampaign(), numericSentAtPressRelease, NOW_MS),
    ).toEqual({
      outcome: 'synced',
      shouldWrite: true,
      authoritativeCompletedAtMs: VALID_COMPLETED_AT_MS,
    })
  })

  // round 20 新增（Finding 3）：sentAt 是 Timestamp-like，但換算出來的毫秒
  // 數是「秒數被誤當毫秒」的典型案例（例如 1_700_000_000，對應 2023 年的
  // 秒數，當成毫秒解析會落在 1970 年）——遠早於下界，不能視為已同步。
  it('round 20 新增（Finding 3）：sentAt 是 Timestamp-like，但值是「秒數被誤當毫秒」→ 不是 already-synced，會重新寫入', () => {
    const secondsAsMsPressRelease = snapOf({ status: 'sent', sentAt: fakeTimestamp(1_700_000_000) })
    const decision = decidePressReleaseSyncRepair(terminalCampaign(), secondsAsMsPressRelease, NOW_MS)
    expect(decision.outcome).toBe('synced')
    expect(decision.shouldWrite).toBe(true)
  })

  // round 20 新增（Finding 3）：sentAt 是 Timestamp-like，但值是明顯的未來
  // 時間（超出 nowMs + clock skew 容忍）→ 不是 already-synced。
  it('round 20 新增（Finding 3）：sentAt 是 Timestamp-like，但值是明顯的未來時間 → 不是 already-synced，會重新寫入', () => {
    const futurePressRelease = snapOf({
      status: 'sent',
      sentAt: fakeTimestamp(NOW_MS + 365 * 24 * 60 * 60 * 1000),
    })
    const decision = decidePressReleaseSyncRepair(terminalCampaign(), futurePressRelease, NOW_MS)
    expect(decision.outcome).toBe('synced')
    expect(decision.shouldWrite).toBe(true)
  })

  // round 20 新增（Finding 3）：sentAt 是 Timestamp-like，toMillis() 回傳
  // NaN／Infinity（畸形資料）→ 不是 already-synced。
  it('round 20 新增（Finding 3）：sentAt 的 toMillis() 回傳 NaN／Infinity → 不是 already-synced，會重新寫入', () => {
    for (const value of [NaN, Infinity, -Infinity]) {
      const malformedPressRelease = snapOf({ status: 'sent', sentAt: fakeTimestamp(value) })
      const decision = decidePressReleaseSyncRepair(terminalCampaign(), malformedPressRelease, NOW_MS)
      expect(decision.outcome).toBe('synced')
      expect(decision.shouldWrite).toBe(true)
    }
  })

  // round 20 新增（Finding 3）：clock skew 邊界——剛好等於容忍上限（5 分鐘）
  // 仍然合理；超過 1 毫秒就不合理。用在 completedAt 上驗證邊界本身抓對。
  it('round 20 新增（Finding 3）：completedAt 剛好等於 nowMs + clock skew 容忍上限 → 仍然合理（synced）', () => {
    const boundaryMs = NOW_MS + 5 * 60_000
    expect(
      decidePressReleaseSyncRepair(
        terminalCampaign({ completedAt: boundaryMs }),
        draftPressRelease,
        NOW_MS,
      ),
    ).toEqual({ outcome: 'synced', shouldWrite: true, authoritativeCompletedAtMs: boundaryMs })
  })

  it('round 20 新增（Finding 3）：completedAt 超過 nowMs + clock skew 容忍上限（多 1 毫秒）→ missing-authoritative-sent-time', () => {
    const justOverMs = NOW_MS + 5 * 60_000 + 1
    expect(
      decidePressReleaseSyncRepair(
        terminalCampaign({ completedAt: justOverMs }),
        draftPressRelease,
        NOW_MS,
      ),
    ).toEqual({ outcome: 'missing-authoritative-sent-time', shouldWrite: false })
  })

  // round 18 新增（Finding 5）：completedAt 缺失或格式錯誤時，絕不能悄悄
  // 用修復當下的時間頂替——必須回報 missing-authoritative-sent-time，
  // shouldWrite:false，讓呼叫端拒絕寫入並要求人工檢查。
  it('completedAt 缺失（undefined）→ missing-authoritative-sent-time，shouldWrite:false', () => {
    expect(
      decidePressReleaseSyncRepair(
        terminalCampaign({ completedAt: undefined }),
        draftPressRelease,
        NOW_MS,
      ),
    ).toEqual({ outcome: 'missing-authoritative-sent-time', shouldWrite: false })
  })

  it('completedAt 是 null → missing-authoritative-sent-time', () => {
    expect(
      decidePressReleaseSyncRepair(
        terminalCampaign({ completedAt: null }),
        draftPressRelease,
        NOW_MS,
      ),
    ).toEqual({ outcome: 'missing-authoritative-sent-time', shouldWrite: false })
  })

  it('completedAt 格式錯誤（無法解析成時間）→ missing-authoritative-sent-time，不會假裝有合法時間', () => {
    expect(
      decidePressReleaseSyncRepair(
        terminalCampaign({ completedAt: 'not-a-timestamp' }),
        draftPressRelease,
        NOW_MS,
      ),
    ).toEqual({ outcome: 'missing-authoritative-sent-time', shouldWrite: false })
  })

  // round 18 迴歸（Finding 5 項目 5）；round 20 更新（Finding 3：nowMs 現在
  // 是明確傳入的參數，不再讀 Date.now()）：即使修復發生在寄送完成好幾天
  // 之後（「現在」跟 completedAt 差很多），輸出的 authoritativeCompletedAtMs
  // 永遠是 campaign.completedAt 換算出來的毫秒數，不會被「現在是什麼時候」
  // 污染——同時也要落在合理的 clock skew 範圍內（不能真的差太多天，那樣
  // completedAt 反而會因為「太舊」以外的理由被判不合理，這裡刻意只差幾
  // 分鐘來驗證「不是用 nowMs 頂替 completedAt」這件事本身，不是在測試
  // 上下界)。
  it('round 18 迴歸（Finding 5）：修復發生在寄送完成一段時間之後，authoritativeCompletedAtMs 仍然是當初的 completedAt，不是修復當下的時間', () => {
    const sentAtCompletion = VALID_COMPLETED_AT_MS
    const repairHappensLater = NOW_MS
    expect(
      decidePressReleaseSyncRepair(
        terminalCampaign({ completedAt: sentAtCompletion }),
        draftPressRelease,
        repairHappensLater,
      ),
    ).toEqual({
      outcome: 'synced',
      shouldWrite: true,
      authoritativeCompletedAtMs: sentAtCompletion,
    })
  })

  // round 19 新增（Finding 2）：completedAt 雖然能被 readMsCompat() 解析成
  // finite 數字，但不是一個站得住腳的日曆時間（負值、0、或超出合理上限）
  // → 仍然必須是 missing-authoritative-sent-time，不能因為「數字合法」就
  // 放行——避免秒數被誤當毫秒、或雜訊值被當成可信的完成時間寫進 sentAt。
  it.each([
    ['負值', -1],
    ['0', 0],
    ['遠早於下界（西元 2020 年）', Date.UTC(2020, 0, 1)],
    ['超出合理上限（遠遠晚於 nowMs）', 40_000_000_000_000],
  ])('completedAt 雖然是 finite 數字，但不合理（%s）→ missing-authoritative-sent-time', (_label, value) => {
    expect(
      decidePressReleaseSyncRepair(
        terminalCampaign({ completedAt: value }),
        draftPressRelease,
        NOW_MS,
      ),
    ).toEqual({ outcome: 'missing-authoritative-sent-time', shouldWrite: false })
  })

  it('completedAt 是 NaN／Infinity → missing-authoritative-sent-time（readMsCompat 本身就會拒絕）', () => {
    for (const value of [NaN, Infinity, -Infinity]) {
      expect(
        decidePressReleaseSyncRepair(
          terminalCampaign({ completedAt: value }),
          draftPressRelease,
          NOW_MS,
        ),
      ).toEqual({ outcome: 'missing-authoritative-sent-time', shouldWrite: false })
    }
  })

  // round 19 新增（Finding 2）：completedAt 是 Timestamp-like（Firestore
  // Timestamp 正常寫入之後讀回來的形狀）時，authoritativeCompletedAtMs
  // 必須是 toMillis() 換算出來的毫秒數，不是原始 Timestamp 物件本身——這是
  // canonical schema 的核心：purely 的邏輯層只回傳 number，呼叫端拿到這個
  // number 之後才用自己 SDK 的 Timestamp.fromMillis() 正規化。
  it('completedAt 是 Timestamp-like 物件 → authoritativeCompletedAtMs 是 toMillis() 換算出來的毫秒數', () => {
    const ms = VALID_COMPLETED_AT_MS
    expect(
      decidePressReleaseSyncRepair(
        terminalCampaign({ completedAt: { toMillis: () => ms } }),
        draftPressRelease,
        NOW_MS,
      ),
    ).toEqual({ outcome: 'synced', shouldWrite: true, authoritativeCompletedAtMs: ms })
  })
})

describe('isPlausibleCompletedAtMs（round 20 修正，Finding 3：直接單元測試新的上下界與 clock skew）', () => {
  const NOW_MS = Date.UTC(2026, 7, 15)

  it('落在下界與 nowMs+skew 之間 → true', () => {
    expect(isPlausibleCompletedAtMs(Date.UTC(2026, 7, 1), NOW_MS)).toBe(true)
  })
  it('剛好等於下界 → true', () => {
    expect(isPlausibleCompletedAtMs(PLAUSIBLE_COMPLETED_AT_MIN_MS, NOW_MS)).toBe(true)
  })
  it('剛好早於下界 1 毫秒 → false（秒數誤當毫秒的典型案例也會落在這裡）', () => {
    expect(isPlausibleCompletedAtMs(PLAUSIBLE_COMPLETED_AT_MIN_MS - 1, NOW_MS)).toBe(false)
    expect(isPlausibleCompletedAtMs(1_700_000_000, NOW_MS)).toBe(false) // 秒數被誤當毫秒
  })
  it('剛好等於 nowMs + clock skew 容忍上限 → true', () => {
    expect(isPlausibleCompletedAtMs(NOW_MS + PLAUSIBLE_COMPLETED_AT_CLOCK_SKEW_MS, NOW_MS)).toBe(true)
  })
  it('超過 nowMs + clock skew 容忍上限 1 毫秒 → false', () => {
    expect(
      isPlausibleCompletedAtMs(NOW_MS + PLAUSIBLE_COMPLETED_AT_CLOCK_SKEW_MS + 1, NOW_MS),
    ).toBe(false)
  })
  it('明顯的未來時間（超出 skew 很多）→ false', () => {
    expect(isPlausibleCompletedAtMs(NOW_MS + 365 * 24 * 60 * 60 * 1000, NOW_MS)).toBe(false)
  })
  it('NaN／Infinity／-Infinity → false', () => {
    for (const value of [NaN, Infinity, -Infinity]) {
      expect(isPlausibleCompletedAtMs(value, NOW_MS)).toBe(false)
    }
  })
  it('nowMs 本身不是 finite → false（防禦性：不假設呼叫端一定傳對）', () => {
    expect(isPlausibleCompletedAtMs(NOW_MS, NaN)).toBe(false)
  })
})

describe('isTimestampLike（round 20 新增，export 出來的判斷）', () => {
  it('有 toMillis() 方法的物件 → true', () => {
    expect(isTimestampLike({ toMillis: () => 1 })).toBe(true)
  })
  it.each([
    ['純數字', 1_700_000_000_000],
    ['字串', 'not-a-timestamp'],
    ['null', null],
    ['undefined', undefined],
    ['沒有 toMillis 的物件', {}],
  ])('%s → false', (_label, value) => {
    expect(isTimestampLike(value)).toBe(false)
  })
})

describe('repairCampaignPressReleaseSyncTx（round 16 新增，Finding 4；round 17 修正，Finding 4／5；round 18 修正，Finding 5；round 19 修正，Finding 2；round 20 修正，Finding 3：sentAt 必須是驗證過的毫秒數換算成的真正 Timestamp，純數字 sentAt 現在會被自動修復，不能用修復當下時間冒充）', () => {
  // round 19 修正（Finding 2）：pressReleaseFields 現在收到的是驗證過的
  // 毫秒數（authoritativeCompletedAtMs），不是原始 unknown 值——這裡刻意
  // 用 Timestamp.fromMillis 的等價 fake（把毫秒數包成一個有 toMillis() 的
  // 物件）模擬 Admin SDK 正式寫法，讓測試能驗證到「最終確實產生一個具備
  // toMillis()／toDate() 的 canonical Timestamp」，不是只驗證回傳的數字。
  const fakeTimestampFromMillis = (ms: number) => ({
    toMillis: () => ms,
    toDate: () => new Date(ms),
  })
  const pressReleaseFields = (authoritativeCompletedAtMs: number) => ({
    status: 'sent',
    sentAt: fakeTimestampFromMillis(authoritativeCompletedAtMs),
  })
  // round 20 修正（Finding 3）：沿用跟上面 decidePressReleaseSyncRepair
  // describe 區塊一致的新範圍常數。
  const NOW_MS = Date.UTC(2026, 7, 15)
  const COMPLETED_AT = Date.UTC(2026, 7, 1)

  it('terminal、totals.sent>0、新聞稿還沒同步、completedAt 合法 → 真的呼叫 update()，寫入的 sentAt 是 campaign.completedAt 本身，不是修復當下的時間', async () => {
    const campaignDoc = fakeDocTx({
      status: 'completed',
      mode: 'real',
      isTest: false,
      totals: { sent: 5 },
      pressReleaseId: 'pr1',
      completedAt: COMPLETED_AT,
    })
    const pressReleaseDoc = fakeDocTx({ status: 'draft' })
    const decision = await repairCampaignPressReleaseSyncTx(
      campaignDoc,
      () => pressReleaseDoc,
      pressReleaseFields,
      NOW_MS,
    )
    expect(decision.outcome).toBe('synced')
    expect(pressReleaseDoc.updates.length).toBe(1)
    expect(pressReleaseDoc.current()?.status).toBe('sent')
    // round 18 核心斷言（Finding 5）；round 19 修正（Finding 2）：寫入的
    // sentAt 換算出來的毫秒數就是 completedAt，不是「呼叫當下」的值；而且
    // 它是一個具備 toMillis()／toDate() 的 canonical Timestamp（不是裸的
    // number），前端排序／formatDate() 才不會悄悄失效。
    const sentAt = pressReleaseDoc.current()?.sentAt as { toMillis(): number } | undefined
    expect(sentAt?.toMillis()).toBe(COMPLETED_AT)
    expect(campaignDoc.updates.length).toBe(0) // 這支工具絕不寫 campaign 本身
  })

  it('已經同步過（status:sent 且 sentAt 是真正的 canonical Timestamp）→ already-synced，不重複寫入（冪等，可以安全重複呼叫同一個 campaignId）', async () => {
    const campaignDoc = fakeDocTx({
      status: 'completed',
      mode: 'real',
      isTest: false,
      totals: { sent: 5 },
      pressReleaseId: 'pr1',
      completedAt: COMPLETED_AT,
    })
    const pressReleaseDoc = fakeDocTx({ status: 'sent', sentAt: fakeTimestampFromMillis(COMPLETED_AT) })
    const decision = await repairCampaignPressReleaseSyncTx(
      campaignDoc,
      () => pressReleaseDoc,
      pressReleaseFields,
      NOW_MS,
    )
    expect(decision.outcome).toBe('already-synced')
    expect(pressReleaseDoc.updates.length).toBe(0)
  })

  // round 20 新增（Finding 3，P2 核心）：sentAt 是既有資料裡的**純數字**
  // （canonical 遷移之前留下的舊格式）——這是「修復工具能不能真的自動
  // 修好歷史上的純數字 sentAt」這個問題的直接端對端驗證：不再只是
  // decidePressReleaseSyncRepair() 回報 synced，這裡進一步斷言
  // update() 真的被呼叫、寫入的是一個真正的 canonical Timestamp。
  it('round 20 新增（Finding 3）：sentAt 是既有的純數字（不是 Timestamp）→ 不是 already-synced，真的呼叫 update() 寫入一個真正的 Timestamp，直接修好歷史資料', async () => {
    const campaignDoc = fakeDocTx({
      status: 'completed',
      mode: 'real',
      isTest: false,
      totals: { sent: 5 },
      pressReleaseId: 'pr1',
      completedAt: COMPLETED_AT,
    })
    const pressReleaseDoc = fakeDocTx({ status: 'sent', sentAt: 1_700_000_000_000 }) // 舊格式純數字
    const decision = await repairCampaignPressReleaseSyncTx(
      campaignDoc,
      () => pressReleaseDoc,
      pressReleaseFields,
      NOW_MS,
    )
    expect(decision.outcome).toBe('synced')
    expect(decision.shouldWrite).toBe(true)
    expect(pressReleaseDoc.updates.length).toBe(1)
    const sentAt = pressReleaseDoc.current()?.sentAt as { toMillis(): number } | undefined
    expect(sentAt?.toMillis()).toBe(COMPLETED_AT)
  })

  // round 17 核心迴歸案例（Finding 5）：status:'sent' 但 sentAt 缺失——
  // 舊版只檢查 status，會把這種永遠沒有 sentAt 的歷史資料誤判成
  // already-synced，永遠不會被修好。
  it('round 17 迴歸（Finding 5）：新聞稿 status 已經是 sent，但 sentAt 缺失 → 不是 already-synced，會重新寫入補上 sentAt（值來自 completedAt）', async () => {
    const campaignDoc = fakeDocTx({
      status: 'completed',
      mode: 'real',
      isTest: false,
      totals: { sent: 5 },
      pressReleaseId: 'pr1',
      completedAt: COMPLETED_AT,
    })
    const pressReleaseDoc = fakeDocTx({ status: 'sent' }) // 沒有 sentAt
    const decision = await repairCampaignPressReleaseSyncTx(
      campaignDoc,
      () => pressReleaseDoc,
      pressReleaseFields,
      NOW_MS,
    )
    expect(decision.outcome).toBe('synced')
    expect(decision.shouldWrite).toBe(true)
    expect(pressReleaseDoc.updates.length).toBe(1)
    const writtenSentAt = pressReleaseDoc.current()?.sentAt as { toMillis(): number } | undefined
    expect(writtenSentAt?.toMillis()).toBe(COMPLETED_AT)
  })

  it('round 17 迴歸（Finding 5）：新聞稿 status 已經是 sent，但 sentAt 格式錯誤（無法解析）→ 不是 already-synced，會重新寫入', async () => {
    const campaignDoc = fakeDocTx({
      status: 'completed',
      mode: 'real',
      isTest: false,
      totals: { sent: 5 },
      pressReleaseId: 'pr1',
      completedAt: COMPLETED_AT,
    })
    const pressReleaseDoc = fakeDocTx({ status: 'sent', sentAt: 'not-a-timestamp' })
    const decision = await repairCampaignPressReleaseSyncTx(
      campaignDoc,
      () => pressReleaseDoc,
      pressReleaseFields,
      NOW_MS,
    )
    expect(decision.outcome).toBe('synced')
    expect(decision.shouldWrite).toBe(true)
  })

  // round 18 新增（Finding 5 項目 3）：campaign 沒有可信的 completedAt——
  // 絕不能悄悄用「現在」頂替，必須回報 missing-authoritative-sent-time，
  // 而且完全不寫入新聞稿文件。
  it('round 18 新增（Finding 5）：campaign.completedAt 缺失 → missing-authoritative-sent-time，不會呼叫 update()', async () => {
    const campaignDoc = fakeDocTx({
      status: 'completed',
      mode: 'real',
      isTest: false,
      totals: { sent: 5 },
      pressReleaseId: 'pr1',
      // 沒有 completedAt
    })
    const pressReleaseDoc = fakeDocTx({ status: 'draft' })
    const decision = await repairCampaignPressReleaseSyncTx(
      campaignDoc,
      () => pressReleaseDoc,
      pressReleaseFields,
      NOW_MS,
    )
    expect(decision.outcome).toBe('missing-authoritative-sent-time')
    expect(decision.shouldWrite).toBe(false)
    expect(pressReleaseDoc.updates.length).toBe(0)
  })

  // round 18 迴歸（Finding 5 項目 5）；round 20 更新（Finding 3：nowMs 現在
  // 是明確傳入的參數，不再靠 mock Date.now）：即使修復發生在寄送完成一段
  // 時間之後（呼叫端傳入的 nowMs 比 completedAt 晚），寫入新聞稿的 sentAt
  // 仍然是當初的 completedAt，不是 nowMs。
  it('round 18 迴歸（Finding 5）：修復發生在寄送完成一段時間之後，寫入的 sentAt 仍然是當初的 completedAt，不是修復當下時間', async () => {
    const campaignDoc = fakeDocTx({
      status: 'completed',
      mode: 'real',
      isTest: false,
      totals: { sent: 5 },
      pressReleaseId: 'pr1',
      completedAt: COMPLETED_AT,
    })
    const pressReleaseDoc = fakeDocTx({ status: 'draft' })
    const repairHappensLater = NOW_MS
    const decision = await repairCampaignPressReleaseSyncTx(
      campaignDoc,
      () => pressReleaseDoc,
      pressReleaseFields,
      repairHappensLater,
    )
    expect(decision.outcome).toBe('synced')
    const sentAt = pressReleaseDoc.current()?.sentAt as { toMillis(): number }
    expect(sentAt.toMillis()).toBe(COMPLETED_AT)
    expect(sentAt.toMillis()).not.toBe(repairHappensLater)
  })

  it('campaign 沒有 pressReleaseId → 完全不會呼叫 getPressReleaseDoc', async () => {
    const campaignDoc = fakeDocTx({
      status: 'completed',
      mode: 'real',
      isTest: false,
      totals: { sent: 5 },
    })
    const getPressReleaseDoc = vi.fn(() => fakeDocTx({ status: 'draft' }))
    const decision = await repairCampaignPressReleaseSyncTx(
      campaignDoc,
      getPressReleaseDoc,
      pressReleaseFields,
      NOW_MS,
    )
    expect(decision.outcome).toBe('missing-press-release-id')
    expect(getPressReleaseDoc).not.toHaveBeenCalled()
  })

  it('round 17 新增（Finding 4 項目 7）：pressReleaseId 存在但含 "/" → invalid-campaign-metadata，不會呼叫 getPressReleaseDoc（避免被 Firestore .doc() 誤解成路徑）', async () => {
    const campaignDoc = fakeDocTx({
      status: 'completed',
      mode: 'real',
      isTest: false,
      totals: { sent: 5 },
      pressReleaseId: 'a/b',
    })
    const getPressReleaseDoc = vi.fn(() => fakeDocTx({ status: 'draft' }))
    const decision = await repairCampaignPressReleaseSyncTx(
      campaignDoc,
      getPressReleaseDoc,
      pressReleaseFields,
      NOW_MS,
    )
    expect(decision.outcome).toBe('invalid-campaign-metadata')
    expect(getPressReleaseDoc).not.toHaveBeenCalled()
  })

  it('round 17 新增（Finding 4 項目 6）：totals.sent 是字串／NaN／負數 → invalid-campaign-metadata', async () => {
    for (const sent of ['5', NaN, -1, Infinity]) {
      const campaignDoc = fakeDocTx({
        status: 'completed',
        mode: 'real',
        isTest: false,
        totals: { sent },
        pressReleaseId: 'pr1',
      })
      const decision = await repairCampaignPressReleaseSyncTx(
        campaignDoc,
        () => fakeDocTx({ status: 'draft' }),
        pressReleaseFields,
        NOW_MS,
      )
      expect(decision.outcome).toBe('invalid-campaign-metadata')
    }
  })

  it('round 17 新增（Finding 4 項目 1／2）：mode:"real" 但 isTest 缺失 → invalid-campaign-metadata（不猜測）', async () => {
    const campaignDoc = fakeDocTx({
      status: 'completed',
      mode: 'real',
      totals: { sent: 5 },
      pressReleaseId: 'pr1',
    })
    const decision = await repairCampaignPressReleaseSyncTx(
      campaignDoc,
      () => fakeDocTx({ status: 'draft' }),
      pressReleaseFields,
      NOW_MS,
    )
    expect(decision.outcome).toBe('invalid-campaign-metadata')
  })

  it('round 17 新增（Finding 4 項目 1）：mode:"real" 但 isTest:true（互相矛盾）→ invalid-campaign-metadata', async () => {
    const campaignDoc = fakeDocTx({
      status: 'completed',
      mode: 'real',
      isTest: true,
      totals: { sent: 5 },
      pressReleaseId: 'pr1',
    })
    const decision = await repairCampaignPressReleaseSyncTx(
      campaignDoc,
      () => fakeDocTx({ status: 'draft' }),
      pressReleaseFields,
      NOW_MS,
    )
    expect(decision.outcome).toBe('invalid-campaign-metadata')
  })

  it('round 17 新增（Finding 4 項目 3）：mode:"testList" 但 isTest 缺失 → invalid-campaign-metadata', async () => {
    const campaignDoc = fakeDocTx({
      status: 'completed',
      mode: 'testList',
      totals: { sent: 5 },
      pressReleaseId: 'pr1',
    })
    const decision = await repairCampaignPressReleaseSyncTx(
      campaignDoc,
      () => fakeDocTx({ status: 'draft' }),
      pressReleaseFields,
      NOW_MS,
    )
    expect(decision.outcome).toBe('invalid-campaign-metadata')
  })

  it('campaign 還在 sending → not-terminal，不會呼叫 update()，即使新聞稿存在且未同步', async () => {
    const campaignDoc = fakeDocTx({
      status: 'sending',
      mode: 'real',
      isTest: false,
      totals: { sent: 5 },
      pressReleaseId: 'pr1',
    })
    const pressReleaseDoc = fakeDocTx({ status: 'draft' })
    const decision = await repairCampaignPressReleaseSyncTx(
      campaignDoc,
      () => pressReleaseDoc,
      pressReleaseFields,
      NOW_MS,
    )
    expect(decision.outcome).toBe('not-terminal')
    expect(pressReleaseDoc.updates.length).toBe(0)
  })

  it('isTest campaign（mode 一致）→ test-campaign，永遠不寫（Finding 4 項目 5）', async () => {
    const campaignDoc = fakeDocTx({
      status: 'completed',
      mode: 'self',
      isTest: true,
      totals: { sent: 5 },
      pressReleaseId: 'pr1',
    })
    const pressReleaseDoc = fakeDocTx({ status: 'draft' })
    const decision = await repairCampaignPressReleaseSyncTx(
      campaignDoc,
      () => pressReleaseDoc,
      pressReleaseFields,
      NOW_MS,
    )
    expect(decision.outcome).toBe('test-campaign')
    expect(pressReleaseDoc.updates.length).toBe(0)
  })
})

describe('decideMarkCampaignFailed', () => {
  const nowMs = 1000

  it('setup 身分、createdByAttemptId 相符、status 仍是 sending、recipientsReady 仍是 false → applied（正常 setup owner 標記失敗）', () => {
    const decision = decideMarkCampaignFailed(
      snapOf({ createdByAttemptId: 'creator', status: 'sending', recipientsReady: false }),
      { kind: 'setup', attemptId: 'creator' },
      nowMs,
      'boom',
    )
    expect(decision.applied).toBe(true)
    expect(decision.patch).toMatchObject({ status: 'failed', lastError: 'boom' })
  })

  it('setup 身分但 createdByAttemptId 不符 → 不寫入（非建立者不能標記 setup 失敗）', () => {
    const decision = decideMarkCampaignFailed(
      snapOf({ createdByAttemptId: 'creator', status: 'sending', recipientsReady: false }),
      { kind: 'setup', attemptId: 'someone-else' },
      nowMs,
      'boom',
    )
    expect(decision.applied).toBe(false)
  })

  it('setup 身分、createdByAttemptId 相符，但 recipientsReady 已經是 true → 不寫入（即使身分相符也不可覆蓋已進入寄送階段的 campaign）', () => {
    // 情境：recipientsReady:true 的寫入其實已經成功，但 client 因為回應
    // 遺失才誤以為失敗，帶著同一個 attemptId 又呼叫了一次標記失敗。
    const decision = decideMarkCampaignFailed(
      snapOf({ createdByAttemptId: 'creator', status: 'sending', recipientsReady: true }),
      { kind: 'setup', attemptId: 'creator' },
      nowMs,
      'boom',
    )
    expect(decision.applied).toBe(false)
  })

  it('setup 身分、createdByAttemptId 相符，但 status 已經不是 sending（例如已經 partial）→ 不寫入', () => {
    const decision = decideMarkCampaignFailed(
      snapOf({ createdByAttemptId: 'creator', status: 'partial', recipientsReady: true }),
      { kind: 'setup', attemptId: 'creator' },
      nowMs,
      'boom',
    )
    expect(decision.applied).toBe(false)
  })

  it('setup 身分、createdByAttemptId 相符、status／recipientsReady 都還像 setup 中，但另一個 attempt 已經持有有效的處理租約 → 不寫入（不能覆蓋正在寄送的 invocation）', () => {
    // 這是 finding 1 的核心情境：另一個 invocation 已經看到
    // recipientsReady:true、取得了處理租約、正在實際寄送，只是這次讀到的
    // recipientsReady 欄位還沒反映出來（極端的讀取交錯）——只要偵測到
    // activeAttemptId 欄位存在，就必須拒絕，不管租約是不是自己的。
    const decision = decideMarkCampaignFailed(
      snapOf({
        createdByAttemptId: 'creator',
        status: 'sending',
        recipientsReady: false,
        activeAttemptId: 'someone-taking-over',
        activeLeaseExpiresAtMs: nowMs + 1,
      }),
      { kind: 'setup', attemptId: 'creator' },
      nowMs,
      'boom',
    )
    expect(decision.applied).toBe(false)
  })

  // Finding 2（round 6）：fail closed，不能只靠 expiry 推測 ownership。
  // 只要 activeAttemptId 這個欄位存在，不論租約是否已經過期、expiry
  // 欄位遺失或格式壞掉，一律拒絕——因為在正確的不變量下，recipientsReady
  // 還是 false 時，acquireCampaignLeaseTx 根本不可能寫入 activeAttemptId，
  // 所以只要它存在，就代表資料已經跳出了應有的不變量，安全的作法只有
  // fail closed，不是嘗試解析 expiry 猜「這個租約現在還算不算數」。
  describe('fail closed：activeAttemptId 存在時一律拒絕 setup 身分覆寫，不管 expiry 是什麼', () => {
    it('activeAttemptId 存在、租約已經過期（expiry 是有效數字但小於 nowMs）→ 仍然拒絕', () => {
      const decision = decideMarkCampaignFailed(
        snapOf({
          createdByAttemptId: 'creator',
          status: 'sending',
          recipientsReady: false,
          activeAttemptId: 'someone-taking-over',
          activeLeaseExpiresAtMs: nowMs - 1,
        }),
        { kind: 'setup', attemptId: 'creator' },
        nowMs,
        'boom',
      )
      expect(decision.applied).toBe(false)
    })

    it('activeAttemptId 存在、expiry 欄位完全遺失（undefined）→ 拒絕（不是 fail open 成 applied:true）', () => {
      const decision = decideMarkCampaignFailed(
        snapOf({
          createdByAttemptId: 'creator',
          status: 'sending',
          recipientsReady: false,
          activeAttemptId: 'someone-taking-over',
          // 沒有 activeLeaseExpiresAtMs／activeLeaseExpiresAt 欄位
        }),
        { kind: 'setup', attemptId: 'creator' },
        nowMs,
        'boom',
      )
      expect(decision.applied).toBe(false)
    })

    it('activeAttemptId 存在、expiry 欄位格式壞掉（字串、NaN、Infinity、畸形物件）→ 一律拒絕', () => {
      const malformedValues: unknown[] = [
        'not-a-timestamp',
        NaN,
        Infinity,
        {},
        { toMillis: 'not-a-function' },
      ]
      for (const malformed of malformedValues) {
        const decision = decideMarkCampaignFailed(
          snapOf({
            createdByAttemptId: 'creator',
            status: 'sending',
            recipientsReady: false,
            activeAttemptId: 'someone-taking-over',
            activeLeaseExpiresAtMs: malformed,
          }),
          { kind: 'setup', attemptId: 'creator' },
          nowMs,
          'boom',
        )
        expect(decision.applied).toBe(false)
      }
    })

    it('activeAttemptId 存在、租約是舊格式 Timestamp-like 且已過期 → 仍然拒絕', () => {
      const decision = decideMarkCampaignFailed(
        snapOf({
          createdByAttemptId: 'creator',
          status: 'sending',
          recipientsReady: false,
          activeAttemptId: 'someone-taking-over',
          activeLeaseExpiresAt: { toMillis: () => nowMs - 1 },
        }),
        { kind: 'setup', attemptId: 'creator' },
        nowMs,
        'boom',
      )
      expect(decision.applied).toBe(false)
    })

    it('activeAttemptId 剛好等於自己（setup owner 自己已經晉升成 lease owner）→ 仍然拒絕，該用 kind:\'lease\' 才對', () => {
      const decision = decideMarkCampaignFailed(
        snapOf({
          createdByAttemptId: 'creator',
          status: 'sending',
          recipientsReady: false,
          activeAttemptId: 'creator',
          activeLeaseExpiresAtMs: nowMs + 1,
        }),
        { kind: 'setup', attemptId: 'creator' },
        nowMs,
        'boom',
      )
      expect(decision.applied).toBe(false)
    })

    it('完全沒有 activeAttemptId 欄位（真正還在 setup 階段）→ 才允許 applied:true', () => {
      const decision = decideMarkCampaignFailed(
        snapOf({ createdByAttemptId: 'creator', status: 'sending', recipientsReady: false }),
        { kind: 'setup', attemptId: 'creator' },
        nowMs,
        'boom',
      )
      expect(decision.applied).toBe(true)
    })

    it('recipientsReady 已經是 true 時，即使完全沒有 activeAttemptId，也永遠不能被 setup failure 覆寫', () => {
      const decision = decideMarkCampaignFailed(
        snapOf({ createdByAttemptId: 'creator', status: 'sending', recipientsReady: true }),
        { kind: 'setup', attemptId: 'creator' },
        nowMs,
        'boom',
      )
      expect(decision.applied).toBe(false)
    })
  })

  it('相容讀取：舊格式 Timestamp-like 的 activeLeaseExpiresAt 未過期 → 不寫入', () => {
    const decision = decideMarkCampaignFailed(
      snapOf({
        createdByAttemptId: 'creator',
        status: 'sending',
        recipientsReady: false,
        activeAttemptId: 'someone-taking-over',
        activeLeaseExpiresAt: { toMillis: () => nowMs + 1 },
      }),
      { kind: 'setup', attemptId: 'creator' },
      nowMs,
      'boom',
    )
    expect(decision.applied).toBe(false)
  })

  it('lease 身分、activeAttemptId 相符、租約未過期、generation 相符 → applied', () => {
    const decision = decideMarkCampaignFailed(
      snapOf({ activeAttemptId: 'owner', activeLeaseExpiresAtMs: nowMs + 1000, leaseGeneration: 2 }),
      { kind: 'lease', attemptId: 'owner', generation: 2 },
      nowMs,
      'boom',
    )
    expect(decision.applied).toBe(true)
  })

  it('lease 身分但 activeAttemptId 不符（A 正在處理，B 想標記失敗）→ 不寫入', () => {
    const decision = decideMarkCampaignFailed(
      snapOf({ activeAttemptId: 'A', activeLeaseExpiresAtMs: nowMs + 1000, leaseGeneration: 2 }),
      { kind: 'lease', attemptId: 'B', generation: 2 },
      nowMs,
      'B 的 SMTP 驗證失敗',
    )
    expect(decision.applied).toBe(false)
  })

  // round 10 新增（Finding 2）：activeAttemptId 相符，但租約本身已過期，
  // 或 generation 已經被別人（含 resolution）推進——都不能再標記失敗。
  it('lease 身分、activeAttemptId 相符，但租約本身已過期 → 不寫入', () => {
    const decision = decideMarkCampaignFailed(
      snapOf({ activeAttemptId: 'owner', activeLeaseExpiresAtMs: nowMs - 1, leaseGeneration: 2 }),
      { kind: 'lease', attemptId: 'owner', generation: 2 },
      nowMs,
      'boom',
    )
    expect(decision.applied).toBe(false)
  })

  it('lease 身分、activeAttemptId 相符、租約未過期，但 leaseGeneration 已經推進 → 不寫入', () => {
    const decision = decideMarkCampaignFailed(
      snapOf({ activeAttemptId: 'owner', activeLeaseExpiresAtMs: nowMs + 1000, leaseGeneration: 3 }),
      { kind: 'lease', attemptId: 'owner', generation: 2 },
      nowMs,
      'boom',
    )
    expect(decision.applied).toBe(false)
  })

  it('文件不存在 → 不寫入', () => {
    expect(
      decideMarkCampaignFailed(missing, { kind: 'lease', attemptId: 'x', generation: 1 }, nowMs, 'boom')
        .applied,
    ).toBe(false)
  })

  // round 13 新增（Finding 1）：campaign.leaseGeneration 格式錯誤時必須
  // fail closed。
  it('lease 身分、campaign.leaseGeneration 格式錯誤 → 不寫入', () => {
    const decision = decideMarkCampaignFailed(
      snapOf({ activeAttemptId: 'owner', activeLeaseExpiresAtMs: nowMs + 1000, leaseGeneration: 'corrupted' }),
      { kind: 'lease', attemptId: 'owner', generation: 2 },
      nowMs,
      'boom',
    )
    expect(decision.applied).toBe(false)
  })

  it('lease 身分、ownership.generation 剛好是 0，campaign.leaseGeneration 格式錯誤也不可以被誤判成相符', () => {
    const decision = decideMarkCampaignFailed(
      snapOf({ activeAttemptId: 'owner', activeLeaseExpiresAtMs: nowMs + 1000, leaseGeneration: NaN }),
      { kind: 'lease', attemptId: 'owner', generation: 0 },
      nowMs,
      'boom',
    )
    expect(decision.applied).toBe(false)
  })

  // round 14 新增（Finding 1 核心可重現情境）：campaign.leaseGeneration
  // 完全缺失（不是格式錯誤），ownership.generation 剛好是 0。
  it('lease 身分、campaign.leaseGeneration 完全缺失、ownership.generation 剛好是 0 → 不寫入（Finding 1 核心情境）', () => {
    const decision = decideMarkCampaignFailed(
      snapOf({ activeAttemptId: 'owner', activeLeaseExpiresAtMs: nowMs + 1000 }), // 沒有 leaseGeneration
      { kind: 'lease', attemptId: 'owner', generation: 0 },
      nowMs,
      'boom',
    )
    expect(decision.applied).toBe(false)
  })
})

describe('decideReclaimAbandonedSetup', () => {
  const STALE = 120_000

  it('仍在建立中且尚未逾時 → not-abandoned（不能搶著建立第二份）', () => {
    const decision = decideReclaimAbandonedSetup(
      snapOf({ recipientsReady: false, status: 'sending', startedAtMs: 1000 }),
      1000 + STALE - 1,
      STALE,
      'boom',
    )
    expect(decision.outcome).toBe('not-abandoned')
  })

  it('建立中斷超過門檻 → marked-failed，不需要任何 attemptId 身分', () => {
    const decision = decideReclaimAbandonedSetup(
      snapOf({ recipientsReady: false, status: 'sending', startedAtMs: 1000 }),
      1000 + STALE + 1,
      STALE,
      '建立收件人清單的過程中斷',
    )
    expect(decision.outcome).toBe('marked-failed')
    expect(decision.patch).toMatchObject({ status: 'failed' })
  })

  it('recipientsReady 已經是 true（不是建立中斷，是正常進行）→ not-abandoned', () => {
    const decision = decideReclaimAbandonedSetup(
      snapOf({ recipientsReady: true, status: 'sending', startedAtMs: 1000 }),
      1000 + STALE + 1,
      STALE,
      'boom',
    )
    expect(decision.outcome).toBe('not-abandoned')
  })

  it('已經是終止狀態（completed/failed）→ not-abandoned', () => {
    const decision = decideReclaimAbandonedSetup(
      snapOf({ recipientsReady: false, status: 'completed', startedAtMs: 1000 }),
      1000 + STALE + 1,
      STALE,
      'boom',
    )
    expect(decision.outcome).toBe('not-abandoned')
  })

  it('文件不存在 → not-found', () => {
    expect(decideReclaimAbandonedSetup(missing, 999999, STALE, 'boom').outcome).toBe(
      'not-found',
    )
  })

  it('相容讀取：舊格式 Timestamp-like 的 startedAt 也能正確判斷是否逾時', () => {
    const decision = decideReclaimAbandonedSetup(
      snapOf({
        recipientsReady: false,
        status: 'sending',
        startedAt: { toMillis: () => 1000 },
      }),
      1000 + STALE + 1,
      STALE,
      'boom',
    )
    expect(decision.outcome).toBe('marked-failed')
  })

  // Finding 3（round 7）：這條「不需要 attemptId 身分」的旁路過去沒有檢查
  // activeAttemptId，形同繞過 decideMarkCampaignFailed(kind:'setup') 早就
  // 有的 fail-closed 規則。以下測試對應 finding 列出的每一項情境。
  describe('fail closed：activeAttemptId 存在時一律不可 reclaim，不管租約狀態', () => {
    it('activeAttemptId + 有效未過期的租約 → not-abandoned，不可 reclaim', () => {
      const decision = decideReclaimAbandonedSetup(
        snapOf({
          recipientsReady: false,
          status: 'sending',
          startedAtMs: 1000,
          activeAttemptId: 'someone-taking-over',
          activeLeaseExpiresAtMs: 1000 + STALE + 1,
        }),
        1000 + STALE + 2,
        STALE,
        'boom',
      )
      expect(decision).toEqual({ outcome: 'not-abandoned' })
    })

    it('activeAttemptId + 已過期的租約 → 仍然 not-abandoned，不可自動 reclaim', () => {
      const decision = decideReclaimAbandonedSetup(
        snapOf({
          recipientsReady: false,
          status: 'sending',
          startedAtMs: 1000,
          activeAttemptId: 'someone-taking-over',
          activeLeaseExpiresAtMs: 1000 + STALE - 1, // 已過期
        }),
        1000 + STALE + 2,
        STALE,
        'boom',
      )
      expect(decision).toEqual({ outcome: 'not-abandoned' })
    })

    it('activeAttemptId + expiry 欄位遺失或格式錯誤 → 仍然 not-abandoned，不可 reclaim', () => {
      for (const malformedExpiry of [undefined, 'not-a-timestamp', NaN, {}]) {
        const decision = decideReclaimAbandonedSetup(
          snapOf({
            recipientsReady: false,
            status: 'sending',
            startedAtMs: 1000,
            activeAttemptId: 'someone-taking-over',
            activeLeaseExpiresAtMs: malformedExpiry,
          }),
          1000 + STALE + 2,
          STALE,
          'boom',
        )
        expect(decision).toEqual({ outcome: 'not-abandoned' })
      }
    })
  })

  describe('indeterminate：startedAt 新舊欄位都無法解析時不能猜測，不可自動 reclaim', () => {
    it('startedAtMs／startedAt 都缺欄位 → indeterminate，不會退回 0（Unix epoch）當作早就逾時', () => {
      const decision = decideReclaimAbandonedSetup(
        snapOf({ recipientsReady: false, status: 'sending' }),
        999_999_999, // 如果被當成 startedAtMs:0，這個 nowMs 會讓它判定成早就逾時
        STALE,
        'boom',
      )
      expect(decision).toEqual({ outcome: 'indeterminate' })
    })

    it('startedAtMs／startedAt 都是格式錯誤的值 → indeterminate', () => {
      const decision = decideReclaimAbandonedSetup(
        snapOf({
          recipientsReady: false,
          status: 'sending',
          startedAtMs: 'not-a-number',
          startedAt: { toMillis: () => NaN },
        }),
        999_999_999,
        STALE,
        'boom',
      )
      expect(decision).toEqual({ outcome: 'indeterminate' })
    })
  })

  it('沒有 activeAttemptId、有效 startedAt 但還沒逾時 → not-abandoned（wait，不是 reclaim）', () => {
    const decision = decideReclaimAbandonedSetup(
      snapOf({ recipientsReady: false, status: 'sending', startedAtMs: 1000 }),
      1000 + STALE - 1,
      STALE,
      'boom',
    )
    expect(decision.outcome).toBe('not-abandoned')
  })

  it('沒有 activeAttemptId、有效 startedAt 且真的已經逾時 → 才可以 marked-failed', () => {
    const decision = decideReclaimAbandonedSetup(
      snapOf({ recipientsReady: false, status: 'sending', startedAtMs: 1000 }),
      1000 + STALE + 1,
      STALE,
      'boom',
    )
    expect(decision.outcome).toBe('marked-failed')
  })

  it('transaction 前後狀態改變（呼叫前讀到 abandoned，transaction 內其實 recipientsReady 已經變 true）不會覆蓋新狀態', () => {
    // 這裡直接模擬 transaction 讀到的「當下」快照已經是 recipientsReady:true
    // ——decideReclaimAbandonedSetup 只看傳進來的 snap，不看呼叫前的任何
    // 判斷，這正是它「安全性來自即時重新檢查」的核心保證。
    const decision = decideReclaimAbandonedSetup(
      snapOf({ recipientsReady: true, status: 'sending', startedAtMs: 1000 }),
      1000 + STALE + 1,
      STALE,
      'boom',
    )
    expect(decision.outcome).toBe('not-abandoned')
  })
})

describe('commitSentResultOrMarkUnknown（Finding 2：SMTP 成功之後，Firestore 寫入失敗不能被誤判成寄送失敗）', () => {
  function fakeDeps(overrides: Partial<CommitSentResultDeps> = {}): CommitSentResultDeps {
    return {
      commitSent: vi.fn(async () => ({ applied: true })),
      commitDeliveryUnknown: vi.fn(async () => ({ applied: true })),
      logWarn: vi.fn(),
      logError: vi.fn(),
      ...overrides,
    }
  }

  it('sent commit 成功 → 只呼叫 commitSent，不呼叫 commitDeliveryUnknown，不記錄任何錯誤（維持原本的正常流程）', async () => {
    const deps = fakeDeps()
    await commitSentResultOrMarkUnknown(deps)
    expect(deps.commitSent).toHaveBeenCalledTimes(1)
    expect(deps.commitDeliveryUnknown).not.toHaveBeenCalled()
    expect(deps.logError).not.toHaveBeenCalled()
    expect(deps.logWarn).not.toHaveBeenCalled()
  })

  it('sent commit 回傳 applied:false（ownership 已改變）→ 只記警告，不呼叫 commitDeliveryUnknown、不當成普通成功也不當成失敗', async () => {
    const deps = fakeDeps({ commitSent: vi.fn(async () => ({ applied: false })) })
    await commitSentResultOrMarkUnknown(deps)
    expect(deps.commitDeliveryUnknown).not.toHaveBeenCalled()
    expect(deps.logWarn).toHaveBeenCalledTimes(1)
    expect(deps.logError).not.toHaveBeenCalled()
  })

  it('sendMail 已經成功，但 commitSent() 本身拋錯 → 改標記 delivery_unknown，不會被誤判成寄送失敗、不會被自動重試', async () => {
    const deps = fakeDeps({
      commitSent: vi.fn(async () => {
        throw new Error('Firestore 暫時不可用')
      }),
    })
    await commitSentResultOrMarkUnknown(deps)
    expect(deps.commitDeliveryUnknown).toHaveBeenCalledTimes(1)
    expect(deps.commitDeliveryUnknown).toHaveBeenCalledWith(
      expect.stringContaining('Firestore 暫時不可用'),
    )
    expect(deps.logError).toHaveBeenCalledTimes(1)
  })

  it('commitSent() 拋錯、補救的 commitDeliveryUnknown() 也拋錯 → 不會讓收件人立即可重寄（兩次都只記錄，不重新拋出；原始原因不被第二個錯誤蓋掉）', async () => {
    const deps = fakeDeps({
      commitSent: vi.fn(async () => {
        throw new Error('SMTP 已送出，但 Firestore 寫入失敗')
      }),
      commitDeliveryUnknown: vi.fn(async () => {
        throw new Error('補救寫入也失敗')
      }),
    })
    await expect(commitSentResultOrMarkUnknown(deps)).resolves.toBeUndefined()
    expect(deps.logError).toHaveBeenCalledTimes(2)
    // 第一次記錄的是「SMTP 成功、Firestore 寫入失敗」這個原始原因，
    // 不會被第二次補救失敗的訊息取代或蓋掉。
    expect((deps.logError as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain(
      'sendMail 成功',
    )
    expect((deps.logError as ReturnType<typeof vi.fn>).mock.calls[1][0]).toContain(
      '補救寫入',
    )
  })

  it('commitDeliveryUnknown() 回傳 applied:false → 記警告，不拋錯', async () => {
    const deps = fakeDeps({
      commitSent: vi.fn(async () => {
        throw new Error('寫入失敗')
      }),
      commitDeliveryUnknown: vi.fn(async () => ({ applied: false })),
    })
    await commitSentResultOrMarkUnknown(deps)
    expect(deps.logWarn).toHaveBeenCalledTimes(1)
  })
})

describe('runSendPhase（取得處理租約之後的整段流程；Finding 4：直接測試 production 實際呼叫的 orchestration，不是重新手刻一份測試版流程）', () => {
  type Deps = SendPhaseDeps<
    Record<string, unknown>,
    Record<string, unknown>,
    unknown[],
    Record<string, unknown>,
    { name: string }
  >

  function fakeDeps(overrides: Partial<Deps> = {}): Deps {
    return {
      loadSendInputs: vi.fn(async () => ({ press: {}, emailSettings: {} })),
      loadAttachments: vi.fn(async () => []),
      readSmtpSettings: vi.fn(async () => ({})),
      createTransport: vi.fn(async () => ({ name: 'fake-transporter' })),
      verifyTransport: vi.fn(async () => {}),
      sendPending: vi.fn(async () => ({
        totals: { recipients: 10, sent: 10, failed: 0, exhausted: 0, deliveryUnknown: 0 },
        nonTerminalCount: 0,
      })),
      computeTotals: vi.fn(async () => ({
        totals: { recipients: 10, sent: 5, failed: 0, exhausted: 0, deliveryUnknown: 0 },
        nonTerminalCount: 5,
      })),
      finalize: vi.fn(async () => 'completed' as const),
      markFailed: vi.fn(async () => {}),
      closeTransport: vi.fn(),
      logError: vi.fn(),
      now: () => 12345,
      ...overrides,
    }
  }

  it('正常流程：全部成功 → 回傳 finalize 的結果，closeTransport 有被呼叫一次，markFailed 完全不會被呼叫', async () => {
    const deps = fakeDeps()
    const result = await runSendPhase(deps)
    expect(result).toEqual({ status: 'completed' })
    expect(deps.closeTransport).toHaveBeenCalledTimes(1)
    expect(deps.markFailed).not.toHaveBeenCalled()
  })

  it('preflight failure（loadAttachments 失敗，attemptedSend 還是 false）→ 呼叫 markFailed，不呼叫 computeTotals／sendPending，原始錯誤原封不動拋出', async () => {
    const originalErr = new Error('附件讀取失敗')
    const deps = fakeDeps({
      loadAttachments: vi.fn(async () => {
        throw originalErr
      }),
    })
    await expect(runSendPhase(deps)).rejects.toBe(originalErr)
    expect(deps.markFailed).toHaveBeenCalledTimes(1)
    expect(deps.markFailed).toHaveBeenCalledWith(originalErr)
    expect(deps.computeTotals).not.toHaveBeenCalled()
    expect(deps.sendPending).not.toHaveBeenCalled()
  })

  it('preflight failure 且 markFailed 自己也失敗 → 仍然保留原始錯誤，不會被 markFailed 的錯誤取代', async () => {
    const originalErr = new Error('SMTP 連線失敗')
    const deps = fakeDeps({
      verifyTransport: vi.fn(async () => {
        throw originalErr
      }),
      markFailed: vi.fn(async () => {
        throw new Error('markFailed 自己也失敗了')
      }),
    })
    await expect(runSendPhase(deps)).rejects.toBe(originalErr)
  })

  it('preflight 階段在 transporter 建立之前就失敗 → closeTransport 不會被呼叫（transporter 根本還沒建立）', async () => {
    const deps = fakeDeps({
      readSmtpSettings: vi.fn(async () => {
        throw new Error('讀取 SMTP 設定失敗')
      }),
    })
    await expect(runSendPhase(deps)).rejects.toThrow('讀取 SMTP 設定失敗')
    expect(deps.closeTransport).not.toHaveBeenCalled()
  })

  it('preflight 階段在 loadSendInputs 就失敗（連 press 都沒讀到）→ closeTransport 不會被呼叫，markFailed 仍然被呼叫', async () => {
    const originalErr = new Error('讀取新聞稿失敗')
    const deps = fakeDeps({
      loadSendInputs: vi.fn(async () => {
        throw originalErr
      }),
    })
    await expect(runSendPhase(deps)).rejects.toBe(originalErr)
    expect(deps.closeTransport).not.toHaveBeenCalled()
    expect(deps.markFailed).toHaveBeenCalledWith(originalErr)
  })

  it('部分寄送後全域錯誤（finalize 第一次呼叫失敗，attemptedSend 已經是 true）→ 改用 computeTotals 重新收尾成功（partial），不呼叫 markFailed，原始錯誤仍然往外拋', async () => {
    const originalErr = new Error('finalize transaction 失敗')
    let finalizeCallCount = 0
    const recoveredTotals = {
      recipients: 10,
      sent: 6,
      failed: 4,
      exhausted: 0,
      deliveryUnknown: 0,
    }
    const deps = fakeDeps({
      finalize: vi.fn(async () => {
        finalizeCallCount += 1
        if (finalizeCallCount === 1) throw originalErr
        return 'partial' as const
      }),
      computeTotals: vi.fn(async () => ({ totals: recoveredTotals, nonTerminalCount: 4 })),
    })
    await expect(runSendPhase(deps)).rejects.toBe(originalErr)
    expect(deps.markFailed).not.toHaveBeenCalled()
    expect(deps.computeTotals).toHaveBeenCalledTimes(1)
    expect(deps.finalize).toHaveBeenCalledTimes(2)
    // 第二次呼叫（recovery）用的是 computeTotals 重新查出來的真實資料，
    // 並且帶著描述中斷原因的診斷訊息。
    expect(deps.finalize).toHaveBeenNthCalledWith(
      2,
      recoveredTotals,
      4,
      expect.stringContaining('finalize transaction 失敗'),
    )
  })

  it('sendPending 本身拋錯（attemptedSend 已經是 true）→ 同樣走 recovery（computeTotals + finalize），不會呼叫 markFailed', async () => {
    const originalErr = new Error('Firestore 忽然打不通')
    const deps = fakeDeps({
      sendPending: vi.fn(async () => {
        throw originalErr
      }),
    })
    await expect(runSendPhase(deps)).rejects.toBe(originalErr)
    expect(deps.markFailed).not.toHaveBeenCalled()
    expect(deps.computeTotals).toHaveBeenCalledTimes(1)
    expect(deps.finalize).toHaveBeenCalledTimes(1) // 只有 recovery 這一次；try 區塊沒機會呼叫到 finalize
  })

  it('compute totals 失敗（recovery 本身失敗）→ 不會呼叫 markFailed（不寫 terminal failed），原始錯誤仍然保留，不被 recovery 的錯誤覆蓋', async () => {
    const originalErr = new Error('sendPending 失敗')
    const deps = fakeDeps({
      sendPending: vi.fn(async () => {
        throw originalErr
      }),
      computeTotals: vi.fn(async () => {
        throw new Error('連重新查詢都失敗了')
      }),
    })
    await expect(runSendPhase(deps)).rejects.toBe(originalErr)
    expect(deps.markFailed).not.toHaveBeenCalled()
    expect(deps.finalize).not.toHaveBeenCalled() // computeTotals 都失敗了，不會走到 finalize
  })

  it('finalize recovery 失敗（computeTotals 成功，但 recovery 的 finalize 呼叫也失敗）→ 不會呼叫 markFailed，原始錯誤保留，不被 recovery 錯誤覆蓋', async () => {
    const originalErr = new Error('sendPending 失敗')
    const deps = fakeDeps({
      sendPending: vi.fn(async () => {
        throw originalErr
      }),
      finalize: vi.fn(async () => {
        throw new Error('recovery 的 finalize 也失敗')
      }),
    })
    await expect(runSendPhase(deps)).rejects.toBe(originalErr)
    expect(deps.markFailed).not.toHaveBeenCalled()
    expect(deps.finalize).toHaveBeenCalledTimes(1)
  })

  it('lease superseded：finalize 正常回傳 superseded（不是拋出例外）→ runSendPhase 正常回傳，不會誤觸發 recovery 或 markFailed（不能覆蓋別人的狀態）', async () => {
    const deps = fakeDeps({
      finalize: vi.fn(async () => 'superseded' as const),
    })
    const result = await runSendPhase(deps)
    expect(result).toEqual({ status: 'superseded' })
    expect(deps.markFailed).not.toHaveBeenCalled()
  })

  it('not-found：finalize 正常回傳 not-found（campaign 文件已經不存在）→ 正常回傳，不觸發 recovery', async () => {
    const deps = fakeDeps({
      finalize: vi.fn(async () => 'not-found' as const),
    })
    const result = await runSendPhase(deps)
    expect(result).toEqual({ status: 'not-found' })
    expect(deps.markFailed).not.toHaveBeenCalled()
  })

  // round 8（Finding 3）：finally 裡的 closeTransport 拋錯，過去沒有
  // try/catch 包住——finally 裡的例外會直接取代 try/catch 決定好要回傳或
  // 拋出的東西，一個成功的結果會被改判成整個 callable 失敗，一個真正的
  // SMTP／Firestore 錯誤也會被這個無關的 close 錯誤取代掉。
  it('流程成功，但 closeTransport 拋錯 → 仍回傳原本的成功結果，不被 close 錯誤覆蓋', async () => {
    const closeErr = new Error('close 失敗')
    const deps = fakeDeps({
      closeTransport: vi.fn(() => {
        throw closeErr
      }),
    })
    const result = await runSendPhase(deps)
    expect(result).toEqual({ status: 'completed' })
    expect(deps.logError).toHaveBeenCalledWith(
      expect.stringContaining('關閉 transporter 失敗'),
      expect.objectContaining({ error: closeErr.message }),
    )
  })

  it('preflight 失敗且 closeTransport 也拋錯 → 仍拋出原始的 preflight 錯誤，不被 close 錯誤取代', async () => {
    const originalErr = new Error('SMTP 連線失敗')
    const deps = fakeDeps({
      verifyTransport: vi.fn(async () => {
        throw originalErr
      }),
      closeTransport: vi.fn(() => {
        throw new Error('close 也失敗')
      }),
    })
    await expect(runSendPhase(deps)).rejects.toBe(originalErr)
  })

  it('寄送中途失敗（attemptedSend 已經是 true）且 closeTransport 也拋錯 → 仍拋出原始的 send 錯誤，recovery 仍然正常執行', async () => {
    const originalErr = new Error('sendPending 失敗')
    const deps = fakeDeps({
      sendPending: vi.fn(async () => {
        throw originalErr
      }),
      closeTransport: vi.fn(() => {
        throw new Error('close 也失敗')
      }),
    })
    await expect(runSendPhase(deps)).rejects.toBe(originalErr)
    expect(deps.finalize).toHaveBeenCalledTimes(1) // recovery 的 finalize 仍然正常跑完
  })

  it('closeTransport 只在 transporter 真的建立過時才會被呼叫；沒建立過就不會嘗試 close，也不會有 close 相關的 log', async () => {
    const deps = fakeDeps({
      readSmtpSettings: vi.fn(async () => {
        throw new Error('讀取 SMTP 設定失敗')
      }),
      closeTransport: vi.fn(() => {
        throw new Error('不該被呼叫')
      }),
    })
    await expect(runSendPhase(deps)).rejects.toThrow('讀取 SMTP 設定失敗')
    expect(deps.closeTransport).not.toHaveBeenCalled()
  })
})

describe('decideAcquireResolutionLease（round 9 新增、round 10 修正 Finding 2，round 11 新增 Finding 3：campaign eligibility）', () => {
  const T = 1000
  const LEASE_MS = 60_000

  it('campaign 文件不存在 → not-found', () => {
    expect(decideAcquireResolutionLease(missing, 'me', T, LEASE_MS)).toEqual({
      outcome: 'not-found',
    })
  })

  // round 11 新增（Finding 3 核心修正）：過去只檢查 processing／resolution
  // 兩種租約是否互斥，完全沒有驗證這個 campaign 本身「現在」是不是一個
  // 合理可以人工處理 delivery_unknown 的對象。
  it('recipientsReady !== true（還在建立收件人清單）→ not-ready，不論 status 是什麼', () => {
    expect(
      decideAcquireResolutionLease(
        snapOf({ status: 'sending', recipientsReady: false }),
        'me',
        T,
        LEASE_MS,
      ),
    ).toEqual({ outcome: 'not-ready' })
    expect(
      decideAcquireResolutionLease(snapOf({ status: 'needs_review' }), 'me', T, LEASE_MS),
    ).toEqual({ outcome: 'not-ready' }) // 完全沒有 recipientsReady 欄位，一樣 fail closed
  })

  it('status: completed（totals.deliveryUnknown 必然是 0，不可能還有待處理的收件人）→ invalid-status', () => {
    expect(
      decideAcquireResolutionLease(
        snapOf({ status: 'completed', recipientsReady: true }),
        'me',
        T,
        LEASE_MS,
      ),
    ).toEqual({ outcome: 'invalid-status' })
  })

  it('status: failed → invalid-status', () => {
    expect(
      decideAcquireResolutionLease(
        snapOf({ status: 'failed', recipientsReady: true }),
        'me',
        T,
        LEASE_MS,
      ),
    ).toEqual({ outcome: 'invalid-status' })
  })

  it('未知／缺失的 status（理論上不該發生，防禦性測試）→ invalid-status，fail closed', () => {
    expect(
      decideAcquireResolutionLease(
        snapOf({ status: 'some-corrupted-value', recipientsReady: true }),
        'me',
        T,
        LEASE_MS,
      ),
    ).toEqual({ outcome: 'invalid-status' })
    expect(
      decideAcquireResolutionLease(snapOf({ recipientsReady: true }), 'me', T, LEASE_MS),
    ).toEqual({ outcome: 'invalid-status' })
  })

  it('status: sending、partial、needs_review（都可能合法持有未處理的 delivery_unknown）且 recipientsReady:true → 可以繼續往下驗證租約，成功 acquired', () => {
    for (const status of ['sending', 'partial', 'needs_review']) {
      const decision = decideAcquireResolutionLease(
        snapOf({ status, recipientsReady: true }),
        'me',
        T,
        LEASE_MS,
      )
      expect(decision.outcome).toBe('acquired')
    }
  })

  it('eligibility 通過，但目前有效的處理租約仍被別人持有 → processing-lease-active', () => {
    const decision = decideAcquireResolutionLease(
      snapOf({
        status: 'sending',
        recipientsReady: true,
        activeAttemptId: 'someone-processing',
        activeLeaseExpiresAtMs: T + 60_000,
      }),
      'me',
      T,
      LEASE_MS,
    )
    expect(decision).toEqual({ outcome: 'processing-lease-active' })
  })

  it('eligibility 通過，但 resolution 租約已經被別的 admin 持有 → resolution-lease-held', () => {
    const decision = decideAcquireResolutionLease(
      snapOf({
        status: 'needs_review',
        recipientsReady: true,
        resolutionLeaseAttemptId: 'other-admin',
        resolutionLeaseExpiresAtMs: T + 60_000,
      }),
      'me',
      T,
      LEASE_MS,
    )
    expect(decision).toEqual({ outcome: 'resolution-lease-held' })
  })

  it('全部條件通過 → acquired，generation 往前推進、寫入 resolution 租約欄位', () => {
    const decision = decideAcquireResolutionLease(
      snapOf({ status: 'needs_review', recipientsReady: true, leaseGeneration: 4 }),
      'me',
      T,
      LEASE_MS,
    )
    expect(decision).toEqual({
      outcome: 'acquired',
      generation: 5,
      patch: {
        resolutionLeaseAttemptId: 'me',
        resolutionLeaseExpiresAtMs: T + LEASE_MS,
        leaseGeneration: 5,
      },
    })
  })

  // round 13 新增（Finding 1）：見 decideAcquireCampaignLease 對稱的說明。
  it.each([
    ['1.5（非整數）', 1.5],
    ['NaN', NaN],
    ['負數', -1],
    ['字串', '3'],
    ['超出 MAX_SAFE_INTEGER', Number.MAX_SAFE_INTEGER + 1],
  ])('leaseGeneration 格式錯誤（%s）→ invalid-generation，不核發 resolution 租約', (_label, badValue) => {
    const decision = decideAcquireResolutionLease(
      snapOf({ status: 'needs_review', recipientsReady: true, leaseGeneration: badValue }),
      'me',
      T,
      LEASE_MS,
    )
    expect(decision).toEqual({ outcome: 'invalid-generation' })
  })

  it('leaseGeneration 已經是 Number.MAX_SAFE_INTEGER → generation-exhausted，不核發 resolution 租約', () => {
    const decision = decideAcquireResolutionLease(
      snapOf({ status: 'needs_review', recipientsReady: true, leaseGeneration: Number.MAX_SAFE_INTEGER }),
      'me',
      T,
      LEASE_MS,
    )
    expect(decision).toEqual({ outcome: 'generation-exhausted' })
  })

  // round 14 新增（Finding 1）：resolutionLeaseAttemptId 存在但
  // leaseGeneration 缺失／0——套用跟 activeAttemptId 完全相同的一致性
  // 檢查，不可靜默當成全新 campaign。這裡用一個已經過期的 resolution 租約
  // （resolutionHeld 檢查會通過，因為它已經不算「被別人持有」），才能真的
  // 走到 generation 計算這一步。
  it('resolutionLeaseAttemptId 存在（即使租約已過期）但 leaseGeneration 缺失 → invalid-generation，不可靜默當成全新 campaign', () => {
    const decision = decideAcquireResolutionLease(
      snapOf({
        status: 'needs_review',
        recipientsReady: true,
        resolutionLeaseAttemptId: 'expired-admin',
        resolutionLeaseExpiresAtMs: T - 1, // 已過期，resolutionHeld 檢查會放行
        // 沒有 leaseGeneration 欄位
      }),
      'me',
      T,
      LEASE_MS,
    )
    expect(decision).toEqual({ outcome: 'invalid-generation' })
  })
})

describe('decideResolveDeliveryUnknown（round 8 新增、round 9／10 大幅修正，Finding 2／3／4：delivery_unknown 的人工 resolution）', () => {
  const LEASE_ID = 'resolution-lease-abc123'
  const GEN = 11
  const RECIPIENT_ID = 'r1'
  const noEvent = missing

  const audit = (
    action: DeliveryUnknownResolutionAction,
    overrides: Partial<ResolveDeliveryUnknownAudit> = {},
  ): ResolveDeliveryUnknownAudit => ({
    resolvedBy: 'admin@x.com',
    resolutionId: 'resolution-id-001',
    resolutionAction: action,
    resolutionReason: '已電話確認記者收到信',
    ...overrides,
  })

  /** round 9：campaign 只需要合法的 resolution 租約——campaign.totals 這個
   *  欄位不再被 decideResolveDeliveryUnknown 讀取，authoritativeTotals 才是
   *  唯一的真相來源（見 Finding 2 的說明）。round 10：也要帶正確的
   *  leaseGeneration，供這個 transaction 重新核對。 */
  const campaignWithLease = (overrides: Record<string, unknown> = {}) =>
    snapOf({
      status: 'needs_review',
      resolutionLeaseAttemptId: LEASE_ID,
      resolutionLeaseExpiresAtMs: T0 + 60_000,
      leaseGeneration: GEN,
      ...overrides,
    })

  const totals = (overrides: Partial<CampaignTotalsForFinalize> = {}): CampaignTotalsForFinalize => ({
    recipients: 3,
    sent: 2,
    failed: 0,
    exhausted: 0,
    deliveryUnknown: 1,
    ...overrides,
  })

  /** round 10 新增：resolutionEvents/{resolutionId} 這份 immutable 文件已經
   *  存在時的固定資料，供 idempotent／conflict 測試共用。 */
  const existingEvent = (overrides: Record<string, unknown> = {}) =>
    snapOf({
      recipientId: RECIPIENT_ID,
      resolutionAction: 'mark_delivered',
      resolutionReason: '已電話確認記者收到信',
      resolvedBy: 'admin@x.com',
      fencingGeneration: GEN,
      beforeStatus: 'delivery_unknown',
      afterStatus: 'sent',
      ...overrides,
    })

  it('campaign 文件不存在 → campaign-not-found', () => {
    const decision = decideResolveDeliveryUnknown(
      snapOf({ status: 'delivery_unknown' }),
      missing,
      noEvent,
      RECIPIENT_ID,
      totals(),
      0,
      audit('mark_delivered'),
      LEASE_ID,
      GEN,
      T0,
    )
    expect(decision).toEqual({ outcome: 'campaign-not-found' })
  })

  // round 9（Finding 2）：campaign-lease-held 的概念被 resolution 租約取代
  // ——mutual exclusion 現在發生在「取得 resolution 租約」這一步（見
  // decideAcquireResolutionLease），decideResolveDeliveryUnknown 本身只
  // 驗證「這個 transaction 執行的當下，resolution 租約仍然是自己的」。
  it('resolutionLeaseAttemptId 跟自己不符（租約已經被別人拿走，理論上不該發生，防禦性檢查）→ resolution-lease-lost', () => {
    const campaign = campaignWithLease({ resolutionLeaseAttemptId: 'someone-else' })
    const decision = decideResolveDeliveryUnknown(
      snapOf({ status: 'delivery_unknown' }),
      campaign,
      noEvent,
      RECIPIENT_ID,
      totals(),
      0,
      audit('mark_delivered'),
      LEASE_ID,
      GEN,
      T0,
    )
    expect(decision).toEqual({ outcome: 'resolution-lease-lost' })
  })

  it('resolutionLeaseExpiresAtMs 已經過期（即使 attemptId 字串還沒被改寫）→ resolution-lease-lost', () => {
    const campaign = campaignWithLease({ resolutionLeaseExpiresAtMs: T0 - 1 })
    const decision = decideResolveDeliveryUnknown(
      snapOf({ status: 'delivery_unknown' }),
      campaign,
      noEvent,
      RECIPIENT_ID,
      totals(),
      0,
      audit('mark_delivered'),
      LEASE_ID,
      GEN,
      T0,
    )
    expect(decision).toEqual({ outcome: 'resolution-lease-lost' })
  })

  // round 10 新增（Finding 2 item 6）：leaseGeneration 已經被推進（例如另一
  // 個 resolution 或 processing invocation 搶先取得過）→ 一樣視為失效。
  it('campaign leaseGeneration 已經跟這次 resolution 取得時不同 → resolution-lease-lost', () => {
    const campaign = campaignWithLease({ leaseGeneration: GEN + 1 })
    const decision = decideResolveDeliveryUnknown(
      snapOf({ status: 'delivery_unknown' }),
      campaign,
      noEvent,
      RECIPIENT_ID,
      totals(),
      0,
      audit('mark_delivered'),
      LEASE_ID,
      GEN,
      T0,
    )
    expect(decision).toEqual({ outcome: 'resolution-lease-lost' })
  })

  // round 13 新增（Finding 1）：campaign.leaseGeneration 格式錯誤時必須
  // fail closed（同樣折進 resolution-lease-lost）。
  it('campaign.leaseGeneration 格式錯誤 → resolution-lease-lost，不寫入', () => {
    const campaign = campaignWithLease({ leaseGeneration: 'corrupted' })
    const decision = decideResolveDeliveryUnknown(
      snapOf({ status: 'delivery_unknown' }),
      campaign,
      noEvent,
      RECIPIENT_ID,
      totals(),
      0,
      audit('mark_delivered'),
      LEASE_ID,
      GEN,
      T0,
    )
    expect(decision).toEqual({ outcome: 'resolution-lease-lost' })
  })

  it('resolutionGeneration 剛好是 0，campaign.leaseGeneration 格式錯誤也不可以被誤判成相符', () => {
    const campaign = campaignWithLease({ leaseGeneration: NaN })
    const decision = decideResolveDeliveryUnknown(
      snapOf({ status: 'delivery_unknown' }),
      campaign,
      noEvent,
      RECIPIENT_ID,
      totals(),
      0,
      audit('mark_delivered'),
      LEASE_ID,
      0,
      T0,
    )
    expect(decision).toEqual({ outcome: 'resolution-lease-lost' })
  })

  // round 14 新增（Finding 1 核心可重現情境）：campaign.leaseGeneration
  // 完全缺失（不是格式錯誤），resolutionGeneration 剛好是 0。
  it('campaign.leaseGeneration 完全缺失、resolutionGeneration 剛好是 0 → resolution-lease-lost（Finding 1 核心情境）', () => {
    const campaign = campaignWithLease({ leaseGeneration: undefined })
    const decision = decideResolveDeliveryUnknown(
      snapOf({ status: 'delivery_unknown' }),
      campaign,
      noEvent,
      RECIPIENT_ID,
      totals(),
      0,
      audit('mark_delivered'),
      LEASE_ID,
      0,
      T0,
    )
    expect(decision).toEqual({ outcome: 'resolution-lease-lost' })
  })

  it('resolution 租約有效且是自己的 → 可以繼續處理', () => {
    const decision = decideResolveDeliveryUnknown(
      snapOf({ status: 'delivery_unknown', attemptId: 'orig' }),
      campaignWithLease(),
      noEvent,
      RECIPIENT_ID,
      totals(),
      0,
      audit('mark_delivered'),
      LEASE_ID,
      GEN,
      T0,
    )
    expect(decision.outcome).toBe('resolved')
  })

  it('收件人文件不存在 → recipient-not-found', () => {
    const decision = decideResolveDeliveryUnknown(
      missing,
      campaignWithLease(),
      noEvent,
      RECIPIENT_ID,
      totals(),
      0,
      audit('mark_delivered'),
      LEASE_ID,
      GEN,
      T0,
    )
    expect(decision).toEqual({ outcome: 'recipient-not-found' })
  })

  // round 10（Finding 3）：idempotent／conflict 判斷完全改成先看
  // resolutionEvents/{resolutionId} 這份 immutable 文件是否存在，不再看
  // recipient 目前的可變狀態——這是這一輪的核心修正，見
  // ResolutionEventRecord 的說明。
  it('resolutionEvents/{resolutionId} 已經存在、payload 完全相同（同一個請求重送）→ idempotent-replay，回傳原始結果', () => {
    const decision = decideResolveDeliveryUnknown(
      snapOf({ status: 'sent' }), // recipient 現在的狀態不影響判斷
      campaignWithLease(),
      existingEvent(),
      RECIPIENT_ID,
      totals({ deliveryUnknown: 0 }),
      1,
      audit('mark_delivered'),
      LEASE_ID,
      GEN,
      T0,
    )
    expect(decision).toEqual({
      outcome: 'idempotent-replay',
      recipientStatus: 'sent',
      resolvedBy: 'admin@x.com',
      resolutionAction: 'mark_delivered',
      resolutionReason: '已電話確認記者收到信',
    })
  })

  it('resolutionEvents/{resolutionId} 已經存在、但 payload 不同（同一個 resolutionId 被重複使用在不同 payload）→ conflict，不是 idempotent', () => {
    const decision = decideResolveDeliveryUnknown(
      snapOf({ status: 'sent' }),
      campaignWithLease(),
      existingEvent(),
      RECIPIENT_ID,
      totals({ deliveryUnknown: 0 }),
      1,
      audit('force_retry'), // action 不一樣
      LEASE_ID,
      GEN,
      T0,
    )
    expect(decision.outcome).toBe('conflict')
    if (decision.outcome === 'conflict') {
      expect(decision.resolvedBy).toBe('admin@x.com')
      expect(decision.resolutionAction).toBe('mark_delivered') // 沿用 event 記錄的原始 action
    }
  })

  // round 10 核心情境（Finding 3 的原始舉例）：resolutionId 從沒被用過
  // （event 不存在），但收件人現在已經不是 delivery_unknown——這正是
  // 「recipient 已經重新進出過 delivery_unknown 好幾輪」時，不能誤判成
  // 這次的 recipient 可以重新被同一個 resolutionId 處理。
  it('resolutionEvents/{resolutionId} 不存在，但收件人現在不是 delivery_unknown（被另一個 resolutionId 處理過，或還在其他狀態）→ conflict', () => {
    const decision = decideResolveDeliveryUnknown(
      snapOf({
        status: 'failed',
        resolvedBy: 'other-admin@x.com',
        resolutionAction: 'force_retry',
        resolutionReason: '別的原因',
      }),
      campaignWithLease(),
      noEvent,
      RECIPIENT_ID,
      totals({ deliveryUnknown: 0, failed: 1 }),
      1,
      audit('mark_delivered'),
      LEASE_ID,
      GEN,
      T0,
    )
    expect(decision).toEqual({
      outcome: 'conflict',
      recipientStatus: 'failed',
      resolvedBy: 'other-admin@x.com',
      resolutionAction: 'force_retry',
      resolutionReason: '別的原因',
    })
  })

  it('mark_delivered：delivery_unknown → sent，authoritative totals 的 deliveryUnknown 減一、sent 加一，nonTerminalCount 不變，全部處理完後 campaign 變成 completed，campaignPatch 寫回全部 totals 欄位（自我修復），並建立 event', () => {
    const decision = decideResolveDeliveryUnknown(
      snapOf({ status: 'delivery_unknown', attemptId: 'orig-attempt' }),
      campaignWithLease(),
      noEvent,
      RECIPIENT_ID,
      totals({ recipients: 3, sent: 2, failed: 0, exhausted: 0, deliveryUnknown: 1 }),
      0,
      audit('mark_delivered'),
      LEASE_ID,
      GEN,
      T0,
    )
    expect(decision).toEqual({
      outcome: 'resolved',
      recipientPatch: {
        status: 'sent',
        resolvedBy: 'admin@x.com',
        resolutionId: 'resolution-id-001',
        resolutionAction: 'mark_delivered',
        resolutionReason: '已電話確認記者收到信',
        resolutionOriginalAttemptId: 'orig-attempt',
        attemptId: null,
        leaseExpiresAtMs: null,
      },
      campaignPatch: {
        status: 'completed',
        'totals.recipients': 3,
        'totals.sent': 3,
        'totals.failed': 0,
        'totals.exhausted': 0,
        'totals.deliveryUnknown': 0,
      },
      eventPatch: {
        recipientId: RECIPIENT_ID,
        resolutionAction: 'mark_delivered',
        resolutionReason: '已電話確認記者收到信',
        resolvedBy: 'admin@x.com',
        fencingGeneration: GEN,
        beforeStatus: 'delivery_unknown',
        afterStatus: 'sent',
      },
    })
  })

  it('mark_delivered：authoritative totals 顯示還有其他 delivery_unknown 沒處理 → campaign 仍然是 needs_review', () => {
    const decision = decideResolveDeliveryUnknown(
      snapOf({ status: 'delivery_unknown' }),
      campaignWithLease(),
      noEvent,
      RECIPIENT_ID,
      totals({ recipients: 3, sent: 1, failed: 0, exhausted: 0, deliveryUnknown: 2 }),
      0,
      audit('mark_delivered'),
      LEASE_ID,
      GEN,
      T0,
    )
    expect(decision.outcome).toBe('resolved')
    if (decision.outcome === 'resolved') {
      expect(decision.campaignPatch.status).toBe('needs_review')
      expect(decision.campaignPatch['totals.deliveryUnknown']).toBe(1)
    }
  })

  it('force_retry：delivery_unknown → failed，authoritative nonTerminalCount 加一，campaign 變成 partial（可以被一般 retryCampaign 接手，但只有這位收件人重新可認領），清掉 attemptId／lease', () => {
    const decision = decideResolveDeliveryUnknown(
      snapOf({ status: 'delivery_unknown', attemptId: 'orig-attempt' }),
      campaignWithLease(),
      noEvent,
      RECIPIENT_ID,
      totals({ recipients: 3, sent: 2, failed: 0, exhausted: 0, deliveryUnknown: 1 }),
      0,
      audit('force_retry'),
      LEASE_ID,
      GEN,
      T0,
    )
    expect(decision).toEqual({
      outcome: 'resolved',
      recipientPatch: {
        status: 'failed',
        resolvedBy: 'admin@x.com',
        resolutionId: 'resolution-id-001',
        resolutionAction: 'force_retry',
        resolutionReason: '已電話確認記者收到信',
        resolutionOriginalAttemptId: 'orig-attempt',
        attemptId: null,
        leaseExpiresAtMs: null,
      },
      campaignPatch: {
        status: 'partial',
        'totals.recipients': 3,
        'totals.sent': 2,
        'totals.failed': 1,
        'totals.exhausted': 0,
        'totals.deliveryUnknown': 0,
      },
      eventPatch: {
        recipientId: RECIPIENT_ID,
        resolutionAction: 'force_retry',
        resolutionReason: '已電話確認記者收到信',
        resolvedBy: 'admin@x.com',
        fencingGeneration: GEN,
        beforeStatus: 'delivery_unknown',
        afterStatus: 'failed',
      },
    })
  })

  it('force_retry 之後 failed 的收件人確實會被 isRecipientClaimable 判定成可以重新認領', () => {
    expect(isRecipientClaimable({ status: 'failed' }, T0)).toBe(true)
  })

  it('recipient 沒有 attemptId（理論上不該發生）→ resolutionOriginalAttemptId 是 null，不會拋錯', () => {
    const decision = decideResolveDeliveryUnknown(
      snapOf({ status: 'delivery_unknown' }),
      campaignWithLease(),
      noEvent,
      RECIPIENT_ID,
      totals({ recipients: 1, sent: 0, failed: 0, exhausted: 0, deliveryUnknown: 1 }),
      0,
      audit('mark_delivered'),
      LEASE_ID,
      GEN,
      T0,
    )
    expect(decision.outcome).toBe('resolved')
    if (decision.outcome === 'resolved') {
      expect(decision.recipientPatch.resolutionOriginalAttemptId).toBeNull()
    }
  })

  // round 10 核心情境（Finding 3）：R1 用於第一輪 force_retry，收件人之後
  // 又再次進入 delivery_unknown——R1 的（延遲）重放必須被拒絕，不能被當成
  // 對第二輪的新授權。
  it('第一輪已經用 resolutionId=R1 執行過 force_retry（event 已建立），收件人之後又再次變成 delivery_unknown，R1 遲到的重放請求 → conflict，不會被當成第二輪的新授權', () => {
    const r1Event = existingEvent({
      resolutionAction: 'force_retry',
      resolutionReason: '第一輪的原因',
      afterStatus: 'failed',
    })
    // 收件人「現在」已經是第二輪的 delivery_unknown（第一輪 force_retry
    // 之後正常重試、又逾時了）——如果只看 recipient 目前狀態，這裡看起來
    // 「又是 delivery_unknown」，但 R1 這個 resolutionId 早就已經被用過。
    const decision = decideResolveDeliveryUnknown(
      snapOf({ status: 'delivery_unknown', attemptId: 'second-round-attempt' }),
      campaignWithLease(),
      r1Event,
      RECIPIENT_ID,
      totals(),
      0,
      audit('force_retry', { resolutionId: 'R1', resolutionReason: '第一輪的原因' }),
      LEASE_ID,
      GEN,
      T0,
    )
    // payload 跟 event 記錄的一致 → idempotent-replay（回報第一輪的結果，
    // 不會對「現在」這一輪的 delivery_unknown 做任何新的動作）。
    expect(decision.outcome).toBe('idempotent-replay')
  })

  it('第二輪要處理，必須使用新的 resolutionId（R2）才會真的 resolve', () => {
    const decision = decideResolveDeliveryUnknown(
      snapOf({ status: 'delivery_unknown', attemptId: 'second-round-attempt' }),
      campaignWithLease(),
      noEvent, // R2 的 event 還不存在
      RECIPIENT_ID,
      totals(),
      0,
      audit('force_retry', { resolutionId: 'R2', resolutionReason: '第二輪確認' }),
      LEASE_ID,
      GEN,
      T0,
    )
    expect(decision.outcome).toBe('resolved')
  })

  // Finding 2 item 7／round 10 Finding 4：authoritative totals 本身的形狀
  // 驗證，最後一道防線。
  describe('authoritative totals 的形狀驗證（Finding 2 item 7／round 10 Finding 4：完整不變量）', () => {
    it('deliveryUnknown 是 0（跟這位收件人本身就是 delivery_unknown 矛盾）→ invalid-authoritative-totals，fail closed', () => {
      const decision = decideResolveDeliveryUnknown(
        snapOf({ status: 'delivery_unknown' }),
        campaignWithLease(),
        noEvent,
        RECIPIENT_ID,
        totals({ deliveryUnknown: 0 }),
        1, // 符合完整等式（3-2-0-0=1），單獨測 deliveryUnknown<1 這一關
        audit('mark_delivered'),
        LEASE_ID,
        GEN,
        T0,
      )
      expect(decision).toEqual({ outcome: 'invalid-authoritative-totals' })
    })

    it('totals 有負數 → invalid-authoritative-totals', () => {
      const decision = decideResolveDeliveryUnknown(
        snapOf({ status: 'delivery_unknown' }),
        campaignWithLease(),
        noEvent,
        RECIPIENT_ID,
        totals({ failed: -1 }),
        0,
        audit('mark_delivered'),
        LEASE_ID,
        GEN,
        T0,
      )
      expect(decision).toEqual({ outcome: 'invalid-authoritative-totals' })
    })

    it('totals 是 NaN → invalid-authoritative-totals', () => {
      const decision = decideResolveDeliveryUnknown(
        snapOf({ status: 'delivery_unknown' }),
        campaignWithLease(),
        noEvent,
        RECIPIENT_ID,
        totals({ sent: NaN }),
        0,
        audit('mark_delivered'),
        LEASE_ID,
        GEN,
        T0,
      )
      expect(decision).toEqual({ outcome: 'invalid-authoritative-totals' })
    })

    it('nonTerminalCount 是負數 → invalid-authoritative-totals', () => {
      const decision = decideResolveDeliveryUnknown(
        snapOf({ status: 'delivery_unknown' }),
        campaignWithLease(),
        noEvent,
        RECIPIENT_ID,
        totals(),
        -1,
        audit('mark_delivered'),
        LEASE_ID,
        GEN,
        T0,
      )
      expect(decision).toEqual({ outcome: 'invalid-authoritative-totals' })
    })

    it('已分類的人數總和超過 recipients → invalid-authoritative-totals', () => {
      const decision = decideResolveDeliveryUnknown(
        snapOf({ status: 'delivery_unknown' }),
        campaignWithLease(),
        noEvent,
        RECIPIENT_ID,
        totals({ recipients: 2, sent: 2, failed: 0, exhausted: 0, deliveryUnknown: 1 }), // 2+1=3 > 2
        0,
        audit('mark_delivered'),
        LEASE_ID,
        GEN,
        T0,
      )
      expect(decision).toEqual({ outcome: 'invalid-authoritative-totals' })
    })

    it('nonTerminalCount 超過 recipients → invalid-authoritative-totals', () => {
      const decision = decideResolveDeliveryUnknown(
        snapOf({ status: 'delivery_unknown' }),
        campaignWithLease(),
        noEvent,
        RECIPIENT_ID,
        totals({ recipients: 2, sent: 0, failed: 0, exhausted: 0, deliveryUnknown: 1 }),
        5,
        audit('mark_delivered'),
        LEASE_ID,
        GEN,
        T0,
      )
      expect(decision).toEqual({ outcome: 'invalid-authoritative-totals' })
    })

    // round 10 新增（Finding 4 核心修正）：形狀看似合法（各自的上限檢查
    // 都過關），但 nonTerminalCount 跟其他欄位的完整關係式不成立。
    it('nonTerminalCount 與分類總數矛盾（各自檢查都過關，但完整等式不成立）→ invalid-authoritative-totals', () => {
      // recipients:10, sent:5, exhausted:0, deliveryUnknown:1 →
      // 真正的 nonTerminalCount 應該是 10-5-0-1=4，這裡故意傳 0。
      const decision = decideResolveDeliveryUnknown(
        snapOf({ status: 'delivery_unknown' }),
        campaignWithLease(),
        noEvent,
        RECIPIENT_ID,
        totals({ recipients: 10, sent: 5, failed: 4, exhausted: 0, deliveryUnknown: 1 }),
        0, // 應該是 4，不是 0
        audit('mark_delivered'),
        LEASE_ID,
        GEN,
        T0,
      )
      expect(decision).toEqual({ outcome: 'invalid-authoritative-totals' })
    })

    it('failed > nonTerminalCount（failed 必須是 nonTerminalCount 的子集合）→ invalid-authoritative-totals', () => {
      const decision = decideResolveDeliveryUnknown(
        snapOf({ status: 'delivery_unknown' }),
        campaignWithLease(),
        noEvent,
        RECIPIENT_ID,
        totals({ recipients: 10, sent: 3, failed: 5, exhausted: 0, deliveryUnknown: 2 }),
        // 完整等式：10-3-0-2=5，剛好等於 failed，這裡故意傳一個比 failed 還小的值
        3,
        audit('mark_delivered'),
        LEASE_ID,
        GEN,
        T0,
      )
      expect(decision).toEqual({ outcome: 'invalid-authoritative-totals' })
    })

    // Finding 4 item 6：resolve 後算出來的新 totals 本身也要符合完整不變量
    // ——這裡透過正常的 mark_delivered／force_retry 流程間接驗證：只要
    // 上面兩個「resolved」測試（mark_delivered／force_retry）最終算出的
    // campaignPatch 數字都自洽（sent/failed/deliveryUnknown 的變化量都是
    // 1），就已經證明了寫回前的再次驗證沒有擋下正常案例；這裡額外用
    // isValidAuthoritativeTotalsShape() 直接驗證那兩個案例算出的新 totals
    // 確實符合完整不變量，把「寫回前的再次檢查」跟「isValidAuthoritativeTotalsShape
    // 本身」的正確性連在一起看。
    it('mark_delivered／force_retry 算出的新 totals 都符合完整不變量（用 isValidAuthoritativeTotalsShape 直接驗證）', () => {
      const before = totals({ recipients: 3, sent: 2, failed: 0, exhausted: 0, deliveryUnknown: 1 })
      const afterMarkDelivered = { ...before, sent: before.sent + 1, deliveryUnknown: before.deliveryUnknown - 1 }
      expect(isValidAuthoritativeTotalsShape(afterMarkDelivered, 0)).toBe(true)

      const afterForceRetry = { ...before, failed: before.failed + 1, deliveryUnknown: before.deliveryUnknown - 1 }
      expect(isValidAuthoritativeTotalsShape(afterForceRetry, 1)).toBe(true)
    })
  })

  // round 21 新增（CI Finding 4）：resolutionEvents/{resolutionId} 讀回時
  // 不再做未經驗證的 `as` cast——decideResolveDeliveryUnknown 本身也要對
  // 損毀的 ledger 文件 fail closed，不能誤判成 idempotent-replay。這是
  // decideResolveDeliveryUnknown 這一層的防線（跟下面
  // decideResolveDeliveryUnknownPreflight 共用同一個 parseResolutionEventRecord，
  // 兩處刻意保持行為一致）。
  it('resolutionEvents/{resolutionId} 存在但欄位損毀（缺 resolutionAction）→ invalid-ledger-event，不當成 idempotent-replay', () => {
    const decision = decideResolveDeliveryUnknown(
      snapOf({ status: 'sent' }),
      campaignWithLease(),
      snapOf({
        recipientId: RECIPIENT_ID,
        // resolutionAction 缺失
        resolutionReason: '已電話確認記者收到信',
        resolvedBy: 'admin@x.com',
        fencingGeneration: GEN,
        beforeStatus: 'delivery_unknown',
        afterStatus: 'sent',
      }),
      RECIPIENT_ID,
      totals({ deliveryUnknown: 0 }),
      1,
      audit('mark_delivered'),
      LEASE_ID,
      GEN,
      T0,
    )
    expect(decision).toEqual({ outcome: 'invalid-ledger-event' })
  })
})

describe('parseResolutionEventRecord（round 21 新增，CI Finding 4：resolutionEvents/{resolutionId} 讀回時的唯一驗證入口）', () => {
  const validEvent = () => ({
    recipientId: 'r1',
    resolutionAction: 'mark_delivered' as const,
    resolutionReason: '已電話確認記者收到信',
    resolvedBy: 'admin@x.com',
    fencingGeneration: 3,
    beforeStatus: 'delivery_unknown' as const,
    afterStatus: 'sent' as const,
  })

  it('欄位齊全、型別正確 → 回傳解析後的 ResolutionEventRecord', () => {
    expect(parseResolutionEventRecord(validEvent())).toEqual(validEvent())
  })

  it('data 是 undefined → null（fail closed）', () => {
    expect(parseResolutionEventRecord(undefined)).toBeNull()
  })

  const malformedCases: [string, Record<string, unknown>][] = [
    ['recipientId 缺失', { ...validEvent(), recipientId: undefined }],
    ['recipientId 是空字串', { ...validEvent(), recipientId: '' }],
    ['resolutionAction 不是合法的 union 值', { ...validEvent(), resolutionAction: 'delete_forever' }],
    ['resolutionReason 是空字串', { ...validEvent(), resolutionReason: '' }],
    ['resolvedBy 缺失', { ...validEvent(), resolvedBy: undefined }],
    ['beforeStatus 不是 delivery_unknown', { ...validEvent(), beforeStatus: 'sent' }],
    ['afterStatus 不是 sent／failed', { ...validEvent(), afterStatus: 'exhausted' }],
    ['fencingGeneration 不是整數', { ...validEvent(), fencingGeneration: 1.5 }],
    ['fencingGeneration 小於 1', { ...validEvent(), fencingGeneration: 0 }],
    ['fencingGeneration 是字串', { ...validEvent(), fencingGeneration: '3' }],
  ]
  it.each(malformedCases)('%s → null（fail closed）', (_label, malformed) => {
    expect(parseResolutionEventRecord(malformed)).toBeNull()
  })
})

describe('decideResolveDeliveryUnknownPreflight（round 21 新增，CI Finding 1：resolveDeliveryUnknown 的 replay／conflict preflight）', () => {
  const RECIPIENT_ID = 'r1'
  const audit = (overrides: Partial<ResolveDeliveryUnknownAudit> = {}): ResolveDeliveryUnknownAudit => ({
    resolvedBy: 'admin@x.com',
    resolutionId: 'resolution-id-001',
    resolutionAction: 'mark_delivered',
    resolutionReason: '已電話確認記者收到信',
    ...overrides,
  })
  const existingEvent = (overrides: Record<string, unknown> = {}) =>
    snapOf({
      recipientId: RECIPIENT_ID,
      resolutionAction: 'mark_delivered',
      resolutionReason: '已電話確認記者收到信',
      resolvedBy: 'admin@x.com',
      fencingGeneration: 3,
      beforeStatus: 'delivery_unknown',
      afterStatus: 'sent',
      ...overrides,
    })
  // terminal 或 non-terminal 都無所謂——preflight 刻意不檢查 campaign.status，
  // 這正是這次修正的重點：不論 campaign 現在是不是 terminal，preflight 都
  // 必須能讀到 idempotent-replay／conflict，見下面每個測試案例的說明。
  const terminalCampaign = snapOf({ status: 'completed' })

  it('campaign 文件不存在 → campaign-not-found', () => {
    const decision = decideResolveDeliveryUnknownPreflight(
      snapOf({ status: 'sent' }),
      missing,
      missing,
      RECIPIENT_ID,
      audit(),
    )
    expect(decision).toEqual({ outcome: 'campaign-not-found' })
  })

  it('recipient 文件不存在 → recipient-not-found', () => {
    const decision = decideResolveDeliveryUnknownPreflight(
      missing,
      terminalCampaign,
      missing,
      RECIPIENT_ID,
      audit(),
    )
    expect(decision).toEqual({ outcome: 'recipient-not-found' })
  })

  // 必要測試 1：terminal campaign、同一個 resolutionId＋相同 payload →
  // idempotent-replay——這正是 CI 失敗 1～3 的核心：即使 campaign 已經是
  // completed，只要 payload 相符，preflight 必須能讀到 idempotent-replay，
  // 完全不去看 campaign.status。
  it('terminal campaign 上，event 已存在且 payload 完全相同 → idempotent-replay', () => {
    const decision = decideResolveDeliveryUnknownPreflight(
      snapOf({ status: 'sent' }),
      terminalCampaign,
      existingEvent(),
      RECIPIENT_ID,
      audit(),
    )
    expect(decision).toEqual({
      outcome: 'idempotent-replay',
      recipientStatus: 'sent',
      resolvedBy: 'admin@x.com',
      resolutionAction: 'mark_delivered',
      resolutionReason: '已電話確認記者收到信',
    })
  })

  // 必要測試 2：terminal campaign、同一個 resolutionId＋不同 payload →
  // conflict（不是 idempotent-replay）。
  it('terminal campaign 上，event 已存在但 payload 不同 → conflict', () => {
    const decision = decideResolveDeliveryUnknownPreflight(
      snapOf({ status: 'sent' }),
      terminalCampaign,
      existingEvent(),
      RECIPIENT_ID,
      audit({ resolutionAction: 'force_retry', resolutionReason: '不一樣的理由' }),
    )
    expect(decision).toEqual({
      outcome: 'conflict',
      recipientStatus: 'sent',
      resolvedBy: 'admin@x.com',
      resolutionAction: 'mark_delivered',
      resolutionReason: '已電話確認記者收到信',
    })
  })

  // 必要測試 3：terminal campaign、不同的 resolutionId（event 不存在），
  // 但 recipient 已經不是 delivery_unknown（被另一個 resolutionId 處理過）
  // → conflict。
  it('terminal campaign 上，event 不存在但 recipient 已經不是 delivery_unknown → conflict', () => {
    const decision = decideResolveDeliveryUnknownPreflight(
      snapOf({
        status: 'failed',
        resolvedBy: 'other-admin@x.com',
        resolutionAction: 'force_retry',
        resolutionReason: '別的原因',
      }),
      terminalCampaign,
      missing,
      RECIPIENT_ID,
      audit({ resolutionId: 'a-brand-new-id' }),
    )
    expect(decision).toEqual({
      outcome: 'conflict',
      recipientStatus: 'failed',
      resolvedBy: 'other-admin@x.com',
      resolutionAction: 'force_retry',
      resolutionReason: '別的原因',
    })
  })

  // 必要測試 4：損毀的 ledger 文件 → invalid-ledger-event，fail closed，
  // 絕對不能被當成 idempotent-replay（即使 recipientId 剛好對得上）。
  it('event 存在但欄位損毀 → invalid-ledger-event，fail closed', () => {
    const decision = decideResolveDeliveryUnknownPreflight(
      snapOf({ status: 'sent' }),
      terminalCampaign,
      snapOf({ recipientId: RECIPIENT_ID }), // 缺 resolutionAction／resolvedBy 等欄位
      RECIPIENT_ID,
      audit(),
    )
    expect(decision).toEqual({ outcome: 'invalid-ledger-event' })
  })

  // event 不存在、recipient 現在確實還是 delivery_unknown → proceed，
  // 呼叫端這時才應該繼續往下 acquire resolution 租約。
  it('event 不存在，recipient 現在確實還是 delivery_unknown → proceed', () => {
    const decision = decideResolveDeliveryUnknownPreflight(
      snapOf({ status: 'delivery_unknown' }),
      terminalCampaign,
      missing,
      RECIPIENT_ID,
      audit(),
    )
    expect(decision).toEqual({ outcome: 'proceed' })
  })

  // 'proceed' 只是內部控制流程的訊號——這裡明確記錄它是
  // ResolveDeliveryUnknownPreflightDecision 的合法成員，但
  // coordinateResolveDeliveryUnknown（見 shared/campaignSend.ts）保證絕不
  //會把它原樣回傳給呼叫端：只要 preflight 回傳 'proceed'，一定會接著去
  // acquire resolution 租約、跑最終 transaction，回傳的一定是那之後的
  // outcome。
  it('proceed 是合法的 preflight outcome，僅供 coordinateResolveDeliveryUnknown 內部使用', () => {
    const decision: ResolveDeliveryUnknownPreflightDecision = { outcome: 'proceed' }
    expect(decision.outcome).toBe('proceed')
  })
})

// round 23 修正（P2）：coordinateResolveDeliveryUnknown 的 nowMs 從單一數字
// 改成 injectable clock () => number——修正前，acquire transaction 與最終
// resolveDeliveryUnknownTx transaction 共用 callable 頂層算好、只算一次的
// 同一個時間快照；acquire 與最終 transaction 之間隔著
// refs.queryAuthoritativeRecipients()（可能耗時、非交易的 Firestore
// 查詢），這代表最終 transaction 的租約到期檢查永遠是拿一個偏舊、偏早的
// 時間去比對，query 真的拖過期限也偵測不到。這裡刻意測到
// coordinateResolveDeliveryUnknown 這一層（不是只測 decideResolveDeliveryUnknown
// 這個純函式）——因為「acquire 與 final 各自新讀一次時間」是協調函式的
// wiring 責任，不是純函式的 nowMs 參數本身能證明的事：把同一個
// nowMs 值傳給 decideResolveDeliveryUnknown 兩次，看不出來呼叫端到底是
// 傳了同一個快照還是剛好兩次都讀到一樣的時間；只有在協調層用一個會計數、
// 每次回傳不同值的 fake clock，才能證明 acquire 跟 final 是各自獨立呼叫
// nowMs()，不是共用同一個閉包住的數字。
describe('coordinateResolveDeliveryUnknown（round 23 修正 P2：nowMs 從單一數字改成 injectable clock，acquire／final transaction 各自在執行當下重新讀取時間）', () => {
  const RECIPIENT_ID = 'r1'
  const LEASE_ATTEMPT_ID = 'lease-attempt-1'

  const audit = (overrides: Partial<ResolveDeliveryUnknownAudit> = {}): ResolveDeliveryUnknownAudit => ({
    resolvedBy: 'admin@x.com',
    resolutionId: 'resolution-id-001',
    resolutionAction: 'mark_delivered',
    resolutionReason: '已電話確認記者收到信',
    ...overrides,
  })

  // preflight 會回傳 proceed、acquire 會成功所需要的最低限度初始狀態：
  // recipientsReady、狀態合格（needs_review），目前沒有任何人持有租約。
  const freshCampaign = (overrides: Record<string, unknown> = {}) => ({
    status: 'needs_review',
    recipientsReady: true,
    ...overrides,
  })
  const freshRecipient = (overrides: Record<string, unknown> = {}) => ({
    status: 'delivery_unknown',
    ...overrides,
  })

  type Target = 'recipient' | 'campaign' | 'event'
  type Work = (mk: (target: Target) => DocTx) => Promise<unknown>

  /** 建立 coordinateResolveDeliveryUnknown 需要的 refs：三份 fakeDocTx
   *  （recipient／campaign／event）＋固定回傳的 authoritative recipients。
   *  預設 runTransaction 就是單純呼叫一次 work(mk)；`onRunTransaction` 讓
   *  個別測試可以換掉這個行為，模擬 Firestore 對同一個 transaction
   *  callback 的內部 retry。 */
  function makeRefs(params: {
    campaign: Record<string, unknown> | undefined
    recipient: Record<string, unknown> | undefined
    event?: Record<string, unknown> | undefined
    recipients: RecipientStatusForTotals[]
    onRunTransaction?: (work: Work, mk: (target: Target) => DocTx, transactionIndex: number) => Promise<unknown>
  }) {
    const recipientDoc = fakeDocTx(params.recipient)
    const campaignDoc = fakeDocTx(params.campaign)
    const eventDoc = fakeDocTx(params.event)
    const mk = (target: Target): DocTx =>
      target === 'recipient' ? recipientDoc : target === 'campaign' ? campaignDoc : eventDoc
    let transactionIndex = 0
    // 這裡故意用 `as unknown as CoordinateResolveDeliveryUnknownRefs`：
    // runTransaction 本身是泛型方法（每次呼叫的 T 由呼叫端決定），但這個
    // fake 需要接受同一個 `work` 型別給 onRunTransaction 這個測試專用的
    // hook 使用，兩者對 TypeScript 來說沒辦法在不放寬型別的情況下同時
    //滿足——實際執行時的行為（讀取、呼叫、回傳）跟真正的 DocTx／refs
    // 介面完全一致，只是型別層面上放寬檢查。
    const refs = {
      runTransaction: (work: Work) => {
        transactionIndex += 1
        if (params.onRunTransaction) {
          return params.onRunTransaction(work, mk, transactionIndex)
        }
        return work(mk)
      },
      queryAuthoritativeRecipients: async () => params.recipients,
    } as unknown as CoordinateResolveDeliveryUnknownRefs
    return { refs, recipientDoc, campaignDoc, eventDoc }
  }

  // 情境：query 沒有拖太久，final transaction 讀到的時間仍然落在租約到期
  // 之前 → 正常完成。這是「修正沒有讓正常案例壞掉」的控制組。
  it('控制組：query 沒有拖太久，final transaction 仍在租約到期前執行 → 正常完成，回傳 resolved', async () => {
    const nowValues = [T0, T0 + 1_000] // 依序：acquire 讀到的時間、final 讀到的時間
    let i = 0
    const clock = vi.fn(() => nowValues[i++])

    const { refs, recipientDoc, eventDoc } = makeRefs({
      campaign: freshCampaign(),
      recipient: freshRecipient(),
      recipients: [{ status: 'delivery_unknown' }],
    })

    const decision = await coordinateResolveDeliveryUnknown(
      refs,
      RECIPIENT_ID,
      audit(),
      LEASE_ATTEMPT_ID,
      clock,
      RESOLUTION_LEASE_MS,
    )

    expect(decision.outcome).toBe('resolved')
    // preflight 不需要時間，只有 acquire、final 各呼叫一次 nowMs()。
    expect(clock).toHaveBeenCalledTimes(2)
    expect(recipientDoc.current()?.status).toBe('sent')
    expect(eventDoc.current()).toBeTruthy()
  })

  // 核心情境（這次修正要解決的問題）：acquire 在 t0 取得租約，到期時間是
  // t0+RESOLUTION_LEASE_MS；模擬 refs.queryAuthoritativeRecipients()（真實
  // 的 authoritative 查詢）拖得夠久，final transaction 執行時，時間已經
  // 超過租約到期時間 → 必須偵測到租約已過期，回傳 resolution-lease-lost，
  // 不能誤判成仍然有效。
  it('acquire 在 t0 取得租約（到期＝t0+LEASE_MS），query 拖到超過到期時間才進 final transaction → resolution-lease-lost，且完全不寫入任何 mutation', async () => {
    const t0 = T0
    const nowValues = [t0, t0 + RESOLUTION_LEASE_MS + 1_000] // final 讀到的時間已經超過 t0+LEASE_MS
    let i = 0
    const clock = vi.fn(() => nowValues[i++])

    const { refs, recipientDoc, campaignDoc, eventDoc } = makeRefs({
      campaign: freshCampaign(),
      recipient: freshRecipient(),
      recipients: [{ status: 'delivery_unknown' }],
    })

    const decision = await coordinateResolveDeliveryUnknown(
      refs,
      RECIPIENT_ID,
      audit(),
      LEASE_ATTEMPT_ID,
      clock,
      RESOLUTION_LEASE_MS,
    )

    expect(decision).toEqual({ outcome: 'resolution-lease-lost' })
    expect(clock).toHaveBeenCalledTimes(2)

    // 驗證 acquire 那一步本身算出的到期時間確實是 t0+LEASE_MS（不是別的
    // 值），證明 final 之所以判定過期，是因為時間真的往前走了，不是 acquire
    // 那一步本身算錯。
    expect(campaignDoc.current()?.resolutionLeaseExpiresAtMs).toBe(t0 + RESOLUTION_LEASE_MS)

    // 零 mutation：recipient 文件維持原樣（還是 delivery_unknown，沒有
    // resolvedBy／resolutionId／status 被改掉）、resolutionEvents ledger
    // 完全沒有被寫入、campaign 的 totals／status 也沒有被 resolveDeliveryUnknownTx
    // 改動（campaign 文件上唯一的變化來自 acquire 那一步本身核發租約，不是
    // final transaction 寫入的）。
    expect(recipientDoc.current()).toEqual(freshRecipient())
    expect(eventDoc.current()).toBeUndefined()
    expect(campaignDoc.current()?.status).toBe('needs_review')
    expect(campaignDoc.current()?.['totals.recipients']).toBeUndefined()
    expect(campaignDoc.current()?.['totals.sent']).toBeUndefined()
  })

  // Firestore 樂觀並行控制的內部 retry：同一個 transaction callback 因為
  // 寫入衝突被重跑，每次重跑都必須重新呼叫 nowMs()，不能把第一次讀到的值
  // 記在閉包裡繼續用。這裡用一個「讀真實資料、但寫入被丟棄」的唯讀視圖
  // 代表被放棄的那次嘗試（真實的 Firestore transaction 在提交失敗前，
  // buffer 的寫入本來就不會真的送到伺服器），只有最後一次呼叫才會真正
  // 寫入——這樣才能正確模擬「retry 之間，時間確實往前走了」。
  it('acquire／final transaction 的 callback 各自被 Firestore 重跑一次 → 每次重跑都重新呼叫 nowMs()，不是沿用第一次讀到的值', async () => {
    const nowValues = [T0, T0 + 10, T0 + 20, T0 + 30]
    let i = 0
    const clock = vi.fn(() => nowValues[i++])

    const discard = (doc: DocTx): DocTx => ({
      get: () => doc.get(),
      set: () => {},
      update: () => {},
    })

    const { refs, recipientDoc, campaignDoc, eventDoc } = makeRefs({
      campaign: freshCampaign(),
      recipient: freshRecipient(),
      recipients: [{ status: 'delivery_unknown' }],
      onRunTransaction: async (work, mk, transactionIndex) => {
        // transactionIndex 1 = preflight（唯讀，不需要模擬 retry）；
        // 2 = acquire、3 = final——這兩個才真的會呼叫 nowMs()，各自模擬
        // 一次「先跑一次因為衝突被丟棄，再重跑一次真正 commit」。
        if (transactionIndex === 2 || transactionIndex === 3) {
          const discardMk = (target: Target) => discard(mk(target))
          await work(discardMk)
        }
        return work(mk)
      },
    })

    const decision = await coordinateResolveDeliveryUnknown(
      refs,
      RECIPIENT_ID,
      audit(),
      LEASE_ATTEMPT_ID,
      clock,
      RESOLUTION_LEASE_MS,
    )

    expect(decision.outcome).toBe('resolved')
    // acquire 兩次呼叫（丟棄＋真正 commit）+ final 兩次呼叫 = 4 次，且每次
    // 讀到的值都不同——不是記憶同一個值。
    expect(clock).toHaveBeenCalledTimes(4)
    expect(new Set(nowValues).size).toBe(4)
    // 真正寫入的租約到期時間，來自 acquire「第二次（真正 commit 的那次）」
    // 讀到的時間（T0+10），不是第一次被丟棄的那次（T0）。
    expect(campaignDoc.current()?.resolutionLeaseExpiresAtMs).toBe(T0 + 10 + RESOLUTION_LEASE_MS)
    expect(recipientDoc.current()?.status).toBe('sent')
    expect(eventDoc.current()).toBeTruthy()
  })

  // 到期時間必須以 acquisition transaction「自己執行當下」讀到的時間為準，
  // 不是呼叫端／callable 一開始（甚至比 acquire 更早）就算好的某個快照。
  // 這裡模擬 acquire transaction 本身執行得比預期晚（例如前面排了其他
  // transaction、或單純系統忙碌），驗證到期時間確實是根據這個較晚的時間
  // 算出來的。
  it('acquisition transaction 執行當下的時間比預期晚 → 到期時間以 acquire 自己讀到的較晚時間為準', async () => {
    const lateAcquireTime = T0 + 5_000
    const finalTime = lateAcquireTime + 1_000
    const nowValues = [lateAcquireTime, finalTime]
    let i = 0
    const clock = vi.fn(() => nowValues[i++])

    const { refs, campaignDoc } = makeRefs({
      campaign: freshCampaign(),
      recipient: freshRecipient(),
      recipients: [{ status: 'delivery_unknown' }],
    })

    const decision = await coordinateResolveDeliveryUnknown(
      refs,
      RECIPIENT_ID,
      audit(),
      LEASE_ATTEMPT_ID,
      clock,
      RESOLUTION_LEASE_MS,
    )

    expect(decision.outcome).toBe('resolved')
    expect(campaignDoc.current()?.resolutionLeaseExpiresAtMs).toBe(lateAcquireTime + RESOLUTION_LEASE_MS)
  })
})

describe('processOneRecipient（round 9 新增，Finding 5：單一收件人的完整處理流程，production 與測試共用同一份 orchestration）', () => {
  type MailOptions = { to: string }
  type Deps = ProcessRecipientDeps<MailOptions>

  function fakeDeps(overrides: Partial<Deps> = {}, callOrder: string[] = []): Deps {
    return {
      claim: vi.fn(async () => {
        callOrder.push('claim')
        return { claimable: true, data: { email: 'r@x.com' } }
      }),
      beginDelivery: vi.fn(async () => {
        callOrder.push('begin')
        // round 11 修正（Finding 2）：attemptCount 現在由 begin（不是
        // claim）回傳，代表「真正發生過的 SMTP delivery attempt」次數。
        return { applied: true as const, patch: { status: 'sending' }, attemptCount: 1 }
      }),
      buildMailOptions: vi.fn((data: Record<string, unknown>) => {
        callOrder.push('buildMailOptions')
        return { to: data.email as string }
      }),
      sendMail: vi.fn(async () => {
        callOrder.push('sendMail')
        return { outcome: 'sent' as const }
      }),
      commitSent: vi.fn(async () => {
        callOrder.push('commitSent')
        return { applied: true }
      }),
      commitDeliveryUnknown: vi.fn(async () => {
        callOrder.push('commitDeliveryUnknown')
        return { applied: true }
      }),
      commitFailedOrExhausted: vi.fn(async () => {
        callOrder.push('commitFailedOrExhausted')
        return { applied: true }
      }),
      maxAttempts: MAX_RECIPIENT_ATTEMPTS,
      sleep: vi.fn(async () => {
        callOrder.push('sleep')
      }),
      logWarn: vi.fn(),
      logError: vi.fn(),
      ...overrides,
    }
  }

  it('claim 失敗（not claimable）→ 完全不呼叫 beginDelivery／sendMail／任何 commit', async () => {
    const callOrder: string[] = []
    const deps = fakeDeps(
      {
        claim: vi.fn(async () => {
          callOrder.push('claim')
          return { claimable: false }
        }),
      },
      callOrder,
    )
    const outcome = await processOneRecipient(deps)
    expect(outcome).toEqual({ kind: 'not-claimed' })
    expect(deps.beginDelivery).not.toHaveBeenCalled()
    expect(deps.sendMail).not.toHaveBeenCalled()
    expect(deps.commitSent).not.toHaveBeenCalled()
    expect(deps.commitFailedOrExhausted).not.toHaveBeenCalled()
    expect(callOrder).toEqual(['claim'])
  })

  it('claim 回傳 claimable:true 但沒有 data（防禦性檢查）→ 視為 not-claimed，不呼叫後續步驟', async () => {
    const deps = fakeDeps({ claim: vi.fn(async () => ({ claimable: true })) })
    const outcome = await processOneRecipient(deps)
    expect(outcome).toEqual({ kind: 'not-claimed' })
    expect(deps.beginDelivery).not.toHaveBeenCalled()
  })

  it('begin 失敗（一般 ownership 改變）→ 完全不呼叫 sendMail／任何 commit', async () => {
    const callOrder: string[] = []
    const deps = fakeDeps(
      {
        beginDelivery: vi.fn(async () => {
          callOrder.push('begin')
          return { applied: false as const, reason: 'attempt-id-mismatch' as const }
        }),
      },
      callOrder,
    )
    const outcome = await processOneRecipient(deps)
    expect(outcome).toEqual({ kind: 'begin-failed', reason: 'attempt-id-mismatch' })
    expect(deps.sendMail).not.toHaveBeenCalled()
    expect(deps.commitSent).not.toHaveBeenCalled()
    expect(deps.commitDeliveryUnknown).not.toHaveBeenCalled()
    expect(deps.commitFailedOrExhausted).not.toHaveBeenCalled()
    expect(callOrder).toEqual(['claim', 'begin'])
    expect(deps.logWarn).toHaveBeenCalledWith(
      expect.stringContaining('不呼叫 sendMail'),
      expect.objectContaining({ reason: 'attempt-id-mismatch' }),
    )
  })

  // round 9 的核心情境（Finding 1）：claimed lease 過期，begin 必須拒絕，
  // sendMail 絕對不能被呼叫。
  it('begin 失敗（claimed lease 已過期）→ 不呼叫 sendMail，這正是 Finding 1 要修的核心問題', async () => {
    const deps = fakeDeps({
      beginDelivery: vi.fn(async () => ({
        applied: false as const,
        reason: 'claimed-lease-expired' as const,
      })),
    })
    const outcome = await processOneRecipient(deps)
    expect(outcome).toEqual({ kind: 'begin-failed', reason: 'claimed-lease-expired' })
    expect(deps.sendMail).not.toHaveBeenCalled()
  })

  it('begin 失敗（campaign 處理租約已經被別人接手）→ 不呼叫 sendMail', async () => {
    const deps = fakeDeps({
      beginDelivery: vi.fn(async () => ({
        applied: false as const,
        reason: 'campaign-ownership-lost' as const,
      })),
    })
    const outcome = await processOneRecipient(deps)
    expect(outcome).toEqual({ kind: 'begin-failed', reason: 'campaign-ownership-lost' })
    expect(deps.sendMail).not.toHaveBeenCalled()
  })

  it('send 成功 → 呼叫 commitSent（透過 commitSentResultOrMarkUnknown），sleep 400ms，不呼叫 commitDeliveryUnknown／commitFailedOrExhausted', async () => {
    const callOrder: string[] = []
    const deps = fakeDeps({}, callOrder)
    const outcome = await processOneRecipient(deps)
    expect(outcome).toEqual({ kind: 'sent' })
    expect(deps.commitSent).toHaveBeenCalledTimes(1)
    expect(deps.commitDeliveryUnknown).not.toHaveBeenCalled()
    expect(deps.commitFailedOrExhausted).not.toHaveBeenCalled()
    expect(deps.sleep).toHaveBeenCalledWith(400)
    expect(callOrder).toEqual(['claim', 'begin', 'buildMailOptions', 'sendMail', 'commitSent', 'sleep'])
  })

  // Finding 5 明確要求的情境：send 成功，但寫回 sent 這個動作本身失敗
  // （commitSent 拋錯）→ 退成 delivery_unknown，不能誤判成寄送失敗。
  it('send 成功但 commitSent 本身拋錯 → 退成 delivery_unknown（commitSentResultOrMarkUnknown 的分岔邏輯），不呼叫 commitFailedOrExhausted', async () => {
    const deps = fakeDeps({
      commitSent: vi.fn(async () => {
        throw new Error('Firestore 暫時不可用')
      }),
    })
    const outcome = await processOneRecipient(deps)
    expect(outcome).toEqual({ kind: 'sent' }) // sendMail 本身是成功的，outcome 反映的是「send 這個動作」
    expect(deps.commitDeliveryUnknown).toHaveBeenCalledTimes(1)
    expect(deps.commitDeliveryUnknown).toHaveBeenCalledWith(
      expect.stringContaining('SMTP 已接受但寫回 sent 狀態失敗'),
    )
    expect(deps.commitFailedOrExhausted).not.toHaveBeenCalled()
  })

  it('sendMail 逾時（outcome:timeout）→ 呼叫 commitDeliveryUnknown，不呼叫 commitSent／commitFailedOrExhausted，不 sleep', async () => {
    const callOrder: string[] = []
    const deps = fakeDeps(
      {
        sendMail: vi.fn(async () => {
          callOrder.push('sendMail')
          return { outcome: 'timeout' as const, message: '逾時了' }
        }),
      },
      callOrder,
    )
    const outcome = await processOneRecipient(deps)
    expect(outcome).toEqual({ kind: 'timeout' })
    expect(deps.commitDeliveryUnknown).toHaveBeenCalledTimes(1)
    expect(deps.commitDeliveryUnknown).toHaveBeenCalledWith('逾時了')
    expect(deps.commitSent).not.toHaveBeenCalled()
    expect(deps.commitFailedOrExhausted).not.toHaveBeenCalled()
    expect(deps.sleep).not.toHaveBeenCalled()
    // 呼叫端（sendPendingRecipients）看到 kind:'timeout' 才會決定停批——
    // processOneRecipient 自己只負責回報，不負責控制整批的迴圈。
  })

  it('sendMail 逾時且 close 也失敗（closeError）→ commitDeliveryUnknown 的訊息包含 close 錯誤', async () => {
    const deps = fakeDeps({
      sendMail: vi.fn(async () => ({
        outcome: 'timeout' as const,
        message: '逾時了',
        closeError: 'close 也失敗',
      })),
    })
    await processOneRecipient(deps)
    expect(deps.commitDeliveryUnknown).toHaveBeenCalledWith(
      expect.stringContaining('關閉連線時也發生錯誤：close 也失敗'),
    )
  })

  // round 11 修正（Finding 2）：exhausted 判斷改用 begin（不是 claim）
  // 回傳的權威 attemptCount——只有真正走到 sendMail 才代表這次 attempt
  // 真的發生過。
  it('sendMail 在期限內直接失敗（真正的錯誤）且未達重試上限 → commitFailedOrExhausted(\'failed\', ...)，sleep 400ms', async () => {
    const deps = fakeDeps({
      sendMail: vi.fn(async () => {
        throw new Error('伺服器拒收')
      }),
      beginDelivery: vi.fn(async () => ({
        applied: true as const,
        patch: { status: 'sending' },
        attemptCount: 2,
      })),
    })
    const outcome = await processOneRecipient(deps)
    expect(outcome).toEqual({ kind: 'failed' })
    expect(deps.commitFailedOrExhausted).toHaveBeenCalledWith('failed', '伺服器拒收')
    expect(deps.commitSent).not.toHaveBeenCalled()
    expect(deps.commitDeliveryUnknown).not.toHaveBeenCalled()
    expect(deps.sleep).toHaveBeenCalledWith(400)
  })

  it('sendMail 直接失敗且已達重試上限 → commitFailedOrExhausted(\'exhausted\', ...)', async () => {
    const deps = fakeDeps({
      sendMail: vi.fn(async () => {
        throw new Error('伺服器拒收')
      }),
      beginDelivery: vi.fn(async () => ({
        applied: true as const,
        patch: { status: 'sending' },
        attemptCount: MAX_RECIPIENT_ATTEMPTS,
      })),
    })
    const outcome = await processOneRecipient(deps)
    expect(outcome).toEqual({ kind: 'exhausted' })
    expect(deps.commitFailedOrExhausted).toHaveBeenCalledWith('exhausted', '伺服器拒收')
  })

  // round 11 新增（Finding 2）：begin-failed（例如 generation mismatch）
  // 不會消耗任何重試額度——多次 pre-SMTP 失敗也不會提早讓收件人 exhausted，
  // 因為 attemptCount 根本沒有機會被累加（claim 只標記 attemptCountPending，
  // 只有 begin 成功才會真的累加，見 shared/campaignSend.ts 的說明）。這裡
  // 直接驗證 begin 失敗時 commitFailedOrExhausted 完全不會被呼叫，不論
  // 呼叫幾次都一樣，不需要在這裡重新斷言 attemptCount 的值本身（那是
  // decideBeginDeliveryAttempt 自己的單元測試該驗證的）。
  it('多次 begin 失敗（generation mismatch）都不會呼叫 commitFailedOrExhausted，不會消耗重試額度', async () => {
    const deps = fakeDeps({
      beginDelivery: vi.fn(async () => ({
        applied: false as const,
        reason: 'campaign-generation-mismatch' as const,
      })),
    })
    for (let i = 0; i < MAX_RECIPIENT_ATTEMPTS + 2; i += 1) {
      const outcome = await processOneRecipient(deps)
      expect(outcome).toEqual({ kind: 'begin-failed', reason: 'campaign-generation-mismatch' })
    }
    expect(deps.commitFailedOrExhausted).not.toHaveBeenCalled()
    expect(deps.sendMail).not.toHaveBeenCalled()
  })

  // Finding 5：ownership lost → 不覆蓋別人狀態。commitXxx 回傳 applied:false
  // 只代表「另一個 invocation 已經接手」，不是錯誤，不會拋出、不會覆蓋。
  it('commitSent 的 ownership 已改變（applied:false）→ 只記錄警告，不拋出，不視為錯誤', async () => {
    const deps = fakeDeps({
      commitSent: vi.fn(async () => ({ applied: false })),
    })
    const outcome = await processOneRecipient(deps)
    expect(outcome).toEqual({ kind: 'sent' })
    expect(deps.logWarn).toHaveBeenCalled()
  })

  it('commitFailedOrExhausted 的 ownership 已改變（applied:false）→ 只記錄警告，不拋出', async () => {
    const deps = fakeDeps({
      sendMail: vi.fn(async () => {
        throw new Error('伺服器拒收')
      }),
      commitFailedOrExhausted: vi.fn(async () => ({ applied: false })),
    })
    const outcome = await processOneRecipient(deps)
    expect(outcome).toEqual({ kind: 'failed' })
    expect(deps.logWarn).toHaveBeenCalledWith(
      expect.stringContaining('已經不是自己持有這位收件人'),
    )
  })

  it('commitDeliveryUnknown 的 ownership 已改變（applied:false，timeout 路徑）→ 只記錄警告，不拋出', async () => {
    const deps = fakeDeps({
      sendMail: vi.fn(async () => ({ outcome: 'timeout' as const, message: '逾時了' })),
      commitDeliveryUnknown: vi.fn(async () => ({ applied: false })),
    })
    const outcome = await processOneRecipient(deps)
    expect(outcome).toEqual({ kind: 'timeout' })
    expect(deps.logWarn).toHaveBeenCalled()
  })

  // round 9：late send promise settle → 不觸發額外寫入。sendMailWithWallClockDeadline
  // 自己已經保證底層 promise 遲到 settle 不會是 unhandled rejection（round 7／8
  // 測試過），這裡驗證的是更上一層：processOneRecipient 只根據 deps.sendMail()
  // 回傳的「這一個」結果值行動一次，不會因為底層 promise 之後又做了什麼而
  // 觸發第二次寫入。
  it('sendMail 回傳 timeout 後，即使底層 Promise 之後才真正 resolve，processOneRecipient 也只呼叫一次 commitDeliveryUnknown，不會有第二次寫入', async () => {
    let deferredResolve: (() => void) | undefined
    const deferred = new Promise<void>((resolve) => {
      deferredResolve = resolve
    })
    const deps = fakeDeps({
      sendMail: vi.fn(async () => {
        // 模擬 sendMailWithWallClockDeadline：立刻回傳 timeout，底層真正的
        // send promise 稍後才會 settle（在這支測試裡完全不影響 processOneRecipient，
        // 因為它已經回傳了）。
        void deferred
        return { outcome: 'timeout' as const, message: '逾時了' }
      }),
    })
    const outcome = await processOneRecipient(deps)
    expect(outcome).toEqual({ kind: 'timeout' })
    expect(deps.commitDeliveryUnknown).toHaveBeenCalledTimes(1)
    deferredResolve?.()
    await deferred
    // 底層 promise 事後才 resolve，不會觸發任何新的呼叫。
    expect(deps.commitDeliveryUnknown).toHaveBeenCalledTimes(1)
    expect(deps.commitSent).not.toHaveBeenCalled()
  })

  it('完整呼叫順序：claim → begin → buildMailOptions → sendMail → commit（send 成功路徑）', async () => {
    const callOrder: string[] = []
    const deps = fakeDeps({}, callOrder)
    await processOneRecipient(deps)
    expect(callOrder.slice(0, 5)).toEqual([
      'claim',
      'begin',
      'buildMailOptions',
      'sendMail',
      'commitSent',
    ])
  })

  it('buildMailOptions 只在 begin applied 之後才會被呼叫，帶著 claim 到的資料', async () => {
    const deps = fakeDeps({
      claim: vi.fn(async () => ({
        claimable: true,
        data: { email: 'specific@x.com' },
      })),
    })
    await processOneRecipient(deps)
    expect(deps.buildMailOptions).toHaveBeenCalledWith({ email: 'specific@x.com' })
  })
})

describe('decideReleaseCampaignProcessingLease（round 15 新增，Finding 2：安全的「只釋放租約」原語）', () => {
  it('campaign 不存在 → not-found', () => {
    expect(decideReleaseCampaignProcessingLease(missing, 'me', 1)).toEqual({ outcome: 'not-found' })
  })

  it('activeAttemptId 不是自己 → not-owner，不可清掉別人的租約', () => {
    const decision = decideReleaseCampaignProcessingLease(
      snapOf({ activeAttemptId: 'other', leaseGeneration: 1 }),
      'me',
      1,
    )
    expect(decision).toEqual({ outcome: 'not-owner' })
  })

  it('activeAttemptId 是自己，但 held generation 不合法（呼叫端自己的 generation 是 0）→ not-owner', () => {
    const decision = decideReleaseCampaignProcessingLease(
      snapOf({ activeAttemptId: 'me', leaseGeneration: 1 }),
      'me',
      0,
    )
    expect(decision).toEqual({ outcome: 'not-owner' })
  })

  it('activeAttemptId 是自己，但 campaign.leaseGeneration 缺失（不是合法的 held generation）→ not-owner，不可靜默釋放', () => {
    const decision = decideReleaseCampaignProcessingLease(snapOf({ activeAttemptId: 'me' }), 'me', 1)
    expect(decision).toEqual({ outcome: 'not-owner' })
  })

  it('activeAttemptId 是自己，但 generation 已經被別人（另一次 acquire）推進 → not-owner，不可清掉新 owner 的租約', () => {
    const decision = decideReleaseCampaignProcessingLease(
      snapOf({ activeAttemptId: 'me', leaseGeneration: 2 }),
      'me',
      1,
    )
    expect(decision).toEqual({ outcome: 'not-owner' })
  })

  it('activeAttemptId 相符、held generation 合法且完全相符 → released', () => {
    const decision = decideReleaseCampaignProcessingLease(
      snapOf({ activeAttemptId: 'me', leaseGeneration: 3 }),
      'me',
      3,
    )
    expect(decision).toEqual({ outcome: 'released' })
  })
})

describe('releaseCampaignProcessingLeaseTx（round 16 修正，Finding 5：介面收緊，callback 不能塞入任意欄位）', () => {
  it('正常釋放：只有 activeAttemptId／activeLeaseExpiresAtMs／updatedAt 三個欄位被寫入', async () => {
    const campaignDoc = fakeDocTx({ activeAttemptId: 'me', leaseGeneration: 3, status: 'sending' })
    const decision = await releaseCampaignProcessingLeaseTx(campaignDoc, 'me', 3, () => ({
      activeAttemptId: '__deleted__',
      activeLeaseExpiresAtMs: '__deleted__',
      updatedAt: '__server_ts__',
    }))
    expect(decision).toEqual({ outcome: 'released' })
    expect(campaignDoc.updates).toEqual([
      {
        activeAttemptId: '__deleted__',
        activeLeaseExpiresAtMs: '__deleted__',
        updatedAt: '__server_ts__',
      },
    ])
  })

  // round 16 核心迴歸測試（Finding 5）：即使呼叫端的 callback「手滑」
  // （或惡意）多回傳了 status／totals／completedAt 等欄位（用 `as any`
  // 繞過 TypeScript 的型別限制，模擬執行期真的發生這種情況），這支
  // primitive 也絕對不能把它們寫進 Firestore——只能用執行期的白名單擋下
  // 來，不能只靠型別系統。
  it('callback 試圖多塞 status／totals／completedAt → 這些欄位不會出現在實際的 update() payload 裡', async () => {
    const campaignDoc = fakeDocTx({ activeAttemptId: 'me', leaseGeneration: 3, status: 'sending' })
    const maliciousFields = {
      activeAttemptId: '__deleted__',
      activeLeaseExpiresAtMs: '__deleted__',
      updatedAt: '__server_ts__',
      status: 'completed',
      'totals.sent': 999,
      completedAt: '__server_ts__',
      // eslint 或 TypeScript 可能會抱怨這裡型別不符，但這正是測試重點：
      // 執行期即使真的塞進來，也必須被擋下。
    } as unknown as ReturnType<Parameters<typeof releaseCampaignProcessingLeaseTx>[3]>

    const decision = await releaseCampaignProcessingLeaseTx(
      campaignDoc,
      'me',
      3,
      () => maliciousFields,
    )
    expect(decision).toEqual({ outcome: 'released' })
    expect(campaignDoc.updates).toEqual([
      {
        activeAttemptId: '__deleted__',
        activeLeaseExpiresAtMs: '__deleted__',
        updatedAt: '__server_ts__',
      },
    ])
    // 確認底層文件本身也沒有被寫入 status／totals／completedAt。
    expect(campaignDoc.current()?.status).toBe('sending')
    expect(campaignDoc.current()?.completedAt).toBeUndefined()
    expect(campaignDoc.current()?.['totals.sent']).toBeUndefined()
  })

  it('not-owner 時完全不會呼叫 doc.update()（不論 callback 回傳什麼）', async () => {
    const campaignDoc = fakeDocTx({ activeAttemptId: 'other', leaseGeneration: 3 })
    const callback = vi.fn(() => ({
      activeAttemptId: '__deleted__',
      activeLeaseExpiresAtMs: '__deleted__',
      updatedAt: '__server_ts__',
    }))
    const decision = await releaseCampaignProcessingLeaseTx(campaignDoc, 'me', 3, callback)
    expect(decision).toEqual({ outcome: 'not-owner' })
    expect(callback).not.toHaveBeenCalled()
    expect(campaignDoc.updates.length).toBe(0)
  })
})

describe('reconcileCampaignDelivery（round 14 新增，Finding 2；round 15 修正 Finding 1／2：只校正狀態、絕對不寄信的維運流程）', () => {
  function fakeDeps(overrides: Partial<ReconcileCampaignDeliveryDeps> = {}): ReconcileCampaignDeliveryDeps & {
    calls: string[]
  } {
    const calls: string[] = []
    const base: ReconcileCampaignDeliveryDeps = {
      acquireLease: vi.fn(async () => {
        calls.push('acquireLease')
        return { outcome: 'acquired' as const, generation: 1, patch: {} }
      }),
      listAllRecipientStatuses: vi.fn(async () => {
        calls.push('listAllRecipientStatuses')
        return []
      }),
      listSendingRecipientIds: vi.fn(async () => {
        calls.push('listSendingRecipientIds')
        return []
      }),
      reclaimExpiredDeliveryAttempt: vi.fn(async (recipientId: string) => {
        calls.push(`reclaim:${recipientId}`)
        return { outcome: 'not-expired' as const }
      }),
      computeAuthoritativeTotals: vi.fn(async () => {
        calls.push('computeAuthoritativeTotals')
        return {
          outcome: 'ok' as const,
          totals: { recipients: 0, sent: 0, failed: 0, exhausted: 0, deliveryUnknown: 0 },
          nonTerminalCount: 0,
        }
      }),
      finalize: vi.fn(async () => {
        calls.push('finalize')
        return { outcome: 'completed' as const, patch: { status: 'completed' } }
      }),
      releaseLeaseBestEffort: vi.fn(async () => {
        calls.push('releaseLeaseBestEffort')
      }),
      logWarn: vi.fn(),
      logError: vi.fn(),
    }
    return { ...base, ...overrides, calls }
  }

  it('lease 沒取得（held-by-other）→ 立刻回報，完全不呼叫其他任何 deps，不寫入', async () => {
    const deps = fakeDeps({
      acquireLease: vi.fn(async () => ({ outcome: 'held-by-other' as const })),
    })
    const result = await reconcileCampaignDelivery(deps)
    expect(result).toEqual({ outcome: 'held-by-other' })
    expect(deps.listSendingRecipientIds).not.toHaveBeenCalled()
    expect(deps.reclaimExpiredDeliveryAttempt).not.toHaveBeenCalled()
    expect(deps.computeAuthoritativeTotals).not.toHaveBeenCalled()
    expect(deps.finalize).not.toHaveBeenCalled()
  })

  // round 14 明確要求：malformed generation／已耗盡都必須 fail closed，
  // 不寫入任何東西。
  it.each(['invalid-generation', 'generation-exhausted', 'not-ready', 'terminal', 'not-found'] as const)(
    'lease 取得結果是 %s → 立刻回報，不呼叫其他任何 deps',
    async (outcome) => {
      const deps = fakeDeps({
        acquireLease: vi.fn(async () => ({ outcome })),
      })
      const result = await reconcileCampaignDelivery(deps)
      expect(result).toEqual({ outcome })
      expect(deps.listSendingRecipientIds).not.toHaveBeenCalled()
      expect(deps.finalize).not.toHaveBeenCalled()
    },
  )

  it('過期的 sending 收件人 → reclaimExpiredDeliveryAttempt 回報 marked-unknown，計入 reclaimedCount', async () => {
    const deps = fakeDeps({
      listSendingRecipientIds: vi.fn(async () => ['r1', 'r2', 'r3']),
      reclaimExpiredDeliveryAttempt: vi.fn(async (recipientId: string) => {
        if (recipientId === 'r2') return { outcome: 'not-expired' as const } // 還在合法租期內，不動它
        return { outcome: 'marked-unknown' as const, patch: {} }
      }),
    })
    const result = await reconcileCampaignDelivery(deps)
    expect(result.outcome).toBe('reconciled')
    if (result.outcome === 'reconciled') {
      expect(result.reclaimedCount).toBe(2) // r1、r3；r2 沒被回收
    }
    expect(deps.reclaimExpiredDeliveryAttempt).toHaveBeenCalledTimes(3)
    expect(deps.reclaimExpiredDeliveryAttempt).toHaveBeenCalledWith('r1')
    expect(deps.reclaimExpiredDeliveryAttempt).toHaveBeenCalledWith('r2')
    expect(deps.reclaimExpiredDeliveryAttempt).toHaveBeenCalledWith('r3')
  })

  // round 14 明確要求：queued／failed／claimed 完全不變——這支函式結構上
  // 只可能透過 listSendingRecipientIds／reclaimExpiredDeliveryAttempt 碰
  // 收件人，兩者都只處理 status==='sending' 的文件，沒有任何管道能碰到
  // queued／failed／claimed（ReconcileCampaignDeliveryDeps 介面裡根本不
  // 存在「認領」這種操作）。這裡驗證 listSendingRecipientIds 回傳的清單
  // 是唯一被處理的對象，不會另外查詢或處理其他狀態。
  it('只處理 listSendingRecipientIds 回傳的 id；queued／failed／claimed 收件人完全不會被這支函式碰到（介面上就不存在任何管道）', async () => {
    const deps = fakeDeps({
      listSendingRecipientIds: vi.fn(async () => ['only-sending-r1']),
    })
    await reconcileCampaignDelivery(deps)
    expect(deps.reclaimExpiredDeliveryAttempt).toHaveBeenCalledTimes(1)
    expect(deps.reclaimExpiredDeliveryAttempt).toHaveBeenCalledWith('only-sending-r1')
  })

  it('campaign totals／status 由重新查詢（computeAuthoritativeTotals）的結果計算，不是憑空假設', async () => {
    const totals = { recipients: 5, sent: 3, failed: 0, exhausted: 0, deliveryUnknown: 2 }
    const deps = fakeDeps({
      computeAuthoritativeTotals: vi.fn(async () => ({ outcome: 'ok' as const, totals, nonTerminalCount: 0 })),
      finalize: vi.fn(async () => ({ outcome: 'needs_review' as const, patch: {} })),
    })
    const result = await reconcileCampaignDelivery(deps)
    expect(deps.finalize).toHaveBeenCalledWith(totals, 0)
    expect(result).toEqual({
      outcome: 'reconciled',
      reclaimedCount: 0,
      totals,
      nonTerminalCount: 0,
      finalStatus: 'needs_review',
    })
    // finalize 成功寫入時，它自己的 patch 已經釋放了租約，不需要再呼叫
    // releaseLeaseBestEffort。
    expect(deps.releaseLeaseBestEffort).not.toHaveBeenCalled()
  })

  // round 15 新增（Finding 1）：round 14 版本無條件把 finalize 的結果包成
  // 'reconciled'——如果 finalize 回傳 superseded／not-found，代表根本沒有
  // 真正寫入任何東西，不能宣稱校正成功。
  it('finalize 回傳 superseded（租約在極短 race window 內被別人取代）→ 回報 superseded，不是 reconciled，不呼叫 releaseLeaseBestEffort（可能誤刪別人的租約）', async () => {
    const deps = fakeDeps({
      finalize: vi.fn(async () => ({ outcome: 'superseded' as const })),
    })
    const result = await reconcileCampaignDelivery(deps)
    expect(result).toEqual({ outcome: 'superseded' })
    expect(deps.releaseLeaseBestEffort).not.toHaveBeenCalled()
  })

  it('finalize 回傳 not-found（campaign 在校正過程中消失）→ 回報 not-found，不是 reconciled', async () => {
    const deps = fakeDeps({
      finalize: vi.fn(async () => ({ outcome: 'not-found' as const })),
    })
    const result = await reconcileCampaignDelivery(deps)
    expect(result).toEqual({ outcome: 'not-found' })
    expect(deps.releaseLeaseBestEffort).not.toHaveBeenCalled()
  })

  it.each(['completed', 'failed', 'needs_review', 'partial'] as const)(
    'finalize 回傳合法的 CampaignStatus（%s）→ reconciled，finalStatus 就是這個值',
    async (status) => {
      const deps = fakeDeps({
        finalize: vi.fn(async () => ({ outcome: status, patch: { status } })),
      })
      const result = await reconcileCampaignDelivery(deps)
      expect(result.outcome).toBe('reconciled')
      if (result.outcome === 'reconciled') {
        expect(result.finalStatus).toBe(status)
      }
    },
  )

  // round 18 新增（Finding 1）：deps.finalize 回傳 outcome:'blocked'——
  // finalizeCampaignWithPressReleaseTx 自己已經在同一個 transaction 裡
  // 安全釋放了租約（不需要 reconcileCampaignDelivery 再呼叫
  // releaseLeaseBestEffort），orchestration 必須把這個結果原封不動轉譯成
  // 自己的 outcome:'blocked'，不能誤判成 reconciled。
  it.each(['invalid-campaign-metadata', 'press-release-not-found'] as const)(
    "finalize 回傳 outcome:'blocked'（reason:%s）→ 回報 outcome:'blocked'，不是 reconciled，也不會再呼叫 releaseLeaseBestEffort（finalize 自己已經處理好）",
    async (reason) => {
      const deps = fakeDeps({
        finalize: vi.fn(async () => ({ outcome: 'blocked' as const, reason })),
      })
      const result = await reconcileCampaignDelivery(deps)
      expect(result).toEqual({ outcome: 'blocked', reason })
      expect(deps.releaseLeaseBestEffort).not.toHaveBeenCalled()
    },
  )

  it('校正過程中失去 campaign 處理租約（caller-lost-campaign-lease）→ 立刻中止，不繼續處理剩下的收件人，不呼叫 finalize，也不呼叫 releaseLeaseBestEffort（租約已經是別人的，不能再嘗試釋放）', async () => {
    const deps = fakeDeps({
      listSendingRecipientIds: vi.fn(async () => ['r1', 'r2', 'r3']),
      reclaimExpiredDeliveryAttempt: vi.fn(async (recipientId: string) => {
        if (recipientId === 'r1') return { outcome: 'marked-unknown' as const, patch: {} }
        if (recipientId === 'r2') return { outcome: 'caller-lost-campaign-lease' as const }
        throw new Error('r3 不應該被處理到')
      }),
    })
    const result = await reconcileCampaignDelivery(deps)
    expect(result).toEqual({ outcome: 'held-by-other' })
    expect(deps.reclaimExpiredDeliveryAttempt).toHaveBeenCalledTimes(2) // r1、r2，沒有處理到 r3
    expect(deps.computeAuthoritativeTotals).not.toHaveBeenCalled()
    expect(deps.finalize).not.toHaveBeenCalled()
    expect(deps.releaseLeaseBestEffort).not.toHaveBeenCalled()
  })

  // round 15 修正（Finding 2）：round 14 版本刻意不釋放租約（當時認為沒有
  // 安全的「只釋放、不改狀態」原語），取得租約後的任何例外都只能讓它自然
  // 過期（660 秒）。現在有了 releaseCampaignProcessingLeaseTx，這裡驗證
  // 取得租約「之後」的例外都會先嘗試安全釋放，再把原始例外原封不動往外
  // 拋——deps 介面裡仍然沒有任何「標記失敗」的操作，一次校正失敗不代表
  // campaign 本身失敗。
  it('reclaimExpiredDeliveryAttempt 拋出例外 → 先嘗試安全釋放租約，再原封不動往外拋，不呼叫 finalize，deps 介面裡沒有任何「標記失敗」的管道', async () => {
    const originalErr = new Error('Firestore 暫時不可用')
    const deps = fakeDeps({
      listSendingRecipientIds: vi.fn(async () => ['r1']),
      reclaimExpiredDeliveryAttempt: vi.fn(async () => {
        throw originalErr
      }),
    })
    await expect(reconcileCampaignDelivery(deps)).rejects.toBe(originalErr)
    expect(deps.computeAuthoritativeTotals).not.toHaveBeenCalled()
    expect(deps.finalize).not.toHaveBeenCalled()
    expect(deps.releaseLeaseBestEffort).toHaveBeenCalledTimes(1)
  })

  it('computeAuthoritativeTotals 拋出例外 → 先嘗試安全釋放租約，再原封不動往外拋，不呼叫 finalize', async () => {
    const originalErr = new Error('查詢失敗')
    const deps = fakeDeps({
      computeAuthoritativeTotals: vi.fn(async () => {
        throw originalErr
      }),
    })
    await expect(reconcileCampaignDelivery(deps)).rejects.toBe(originalErr)
    expect(deps.finalize).not.toHaveBeenCalled()
    expect(deps.releaseLeaseBestEffort).toHaveBeenCalledTimes(1)
  })

  it('finalize 本身拋出例外 → 先嘗試安全釋放租約，再原封不動往外拋', async () => {
    const originalErr = new Error('finalize transaction 失敗')
    const deps = fakeDeps({
      finalize: vi.fn(async () => {
        throw originalErr
      }),
    })
    await expect(reconcileCampaignDelivery(deps)).rejects.toBe(originalErr)
    expect(deps.releaseLeaseBestEffort).toHaveBeenCalledTimes(1)
  })

  it('releaseLeaseBestEffort 本身也失敗 → 不覆蓋、不吞掉原始例外，原始例外仍然原封不動往外拋', async () => {
    const originalErr = new Error('Firestore 暫時不可用')
    const releaseErr = new Error('釋放租約也失敗了')
    const deps = fakeDeps({
      listSendingRecipientIds: vi.fn(async () => {
        throw originalErr
      }),
      releaseLeaseBestEffort: vi.fn(async () => {
        throw releaseErr
      }),
    })
    await expect(reconcileCampaignDelivery(deps)).rejects.toBe(originalErr)
    expect(deps.releaseLeaseBestEffort).toHaveBeenCalledTimes(1)
    // release 失敗只會被記錄，不會讓呼叫端看到 releaseErr。
    expect(deps.logError).toHaveBeenCalledWith(
      expect.stringContaining('釋放租約失敗'),
      expect.objectContaining({ error: releaseErr.message }),
    )
  })

  it('完全沒有 sending 收件人 → 直接重新查詢並 finalize，reclaimedCount 是 0', async () => {
    const deps = fakeDeps({
      listSendingRecipientIds: vi.fn(async () => []),
    })
    const result = await reconcileCampaignDelivery(deps)
    expect(result.outcome).toBe('reconciled')
    if (result.outcome === 'reconciled') {
      expect(result.reclaimedCount).toBe(0)
    }
    expect(deps.reclaimExpiredDeliveryAttempt).not.toHaveBeenCalled()
  })

  // round 18 新增（Finding 2）：取得租約之後，如果有任何一位收件人的
  // status 無法辨識，必須立刻中止，不 reclaim、不 finalize、不修改任何
  // 收件人，只 best-effort 釋放這次取得的租約。
  describe('round 18 新增（Finding 2）：全體收件人狀態的 fail-closed 驗證', () => {
    it('有一位收件人的 status 是未知字串 → invalid-recipient-state，不呼叫 reclaim／computeAuthoritativeTotals／finalize，但會 best-effort 釋放租約', async () => {
      const deps = fakeDeps({
        listAllRecipientStatuses: vi.fn(async () => [
          { status: 'sent' },
          { status: 'not-a-real-status' },
        ]),
      })
      const result = await reconcileCampaignDelivery(deps)
      expect(result).toEqual({ outcome: 'invalid-recipient-state' })
      expect(deps.listSendingRecipientIds).not.toHaveBeenCalled()
      expect(deps.reclaimExpiredDeliveryAttempt).not.toHaveBeenCalled()
      expect(deps.computeAuthoritativeTotals).not.toHaveBeenCalled()
      expect(deps.finalize).not.toHaveBeenCalled()
      expect(deps.releaseLeaseBestEffort).toHaveBeenCalledTimes(1)
    })

    it.each([undefined, null, 123, {}, [], true, ''])(
      'status=%s（缺失／型別錯誤） → invalid-recipient-state',
      async (status) => {
        const deps = fakeDeps({
          listAllRecipientStatuses: vi.fn(async () => [{ status }]),
        })
        const result = await reconcileCampaignDelivery(deps)
        expect(result).toEqual({ outcome: 'invalid-recipient-state' })
        expect(deps.finalize).not.toHaveBeenCalled()
      },
    )

    it('全部收件人狀態都合法（含所有 7 種已知值）→ 正常繼續往下走，不會被擋下', async () => {
      const deps = fakeDeps({
        listAllRecipientStatuses: vi.fn(async () => [
          { status: 'queued' },
          { status: 'claimed' },
          { status: 'sending' },
          { status: 'sent' },
          { status: 'failed' },
          { status: 'exhausted' },
          { status: 'delivery_unknown' },
        ]),
      })
      const result = await reconcileCampaignDelivery(deps)
      expect(result.outcome).toBe('reconciled')
      expect(deps.finalize).toHaveBeenCalledTimes(1)
    })

    it('releaseLeaseBestEffort 本身失敗時，invalid-recipient-state 仍然正確回報（不會被 release 的失敗蓋掉）', async () => {
      const deps = fakeDeps({
        listAllRecipientStatuses: vi.fn(async () => [{ status: 'garbage' }]),
        releaseLeaseBestEffort: vi.fn(async () => {
          throw new Error('release 也失敗了')
        }),
      })
      const result = await reconcileCampaignDelivery(deps)
      expect(result).toEqual({ outcome: 'invalid-recipient-state' })
      expect(deps.logError).toHaveBeenCalled()
    })

    // round 18 核心迴歸案例（Finding 2 項目 8）：TOCTOU——即使呼叫端（CLI／
    // callable）在取得租約「之前」曾經檢查過一次分類、確認是 UNKNOWN，
    // reconcileCampaignDelivery() 自己在取得租約「之後」仍然會重新讀一次
    // 全部收件人狀態；如果在這兩個時間點之間資料被改成 malformed，這裡
    // 用的是最新讀到的資料，不會相信呼叫端之前檢查的結果，仍然正確擋下。
    it('round 18 核心迴歸（Finding 2 項目 8，TOCTOU）：即使 listSendingRecipientIds 只回報乾淨的 id，listAllRecipientStatuses 讀到的「當下」資料裡有 malformed 狀態時仍然擋下，不會因為只看 sending 子集合而漏掉', async () => {
      const deps = fakeDeps({
        // 模擬：取得租約前的檢查（呼叫端自己做的，不是這支函式的責任）
        // 看到的是乾淨資料；但取得租約「之後」，這支函式自己重新讀到的
        // 全體收件人狀態裡，混進了一筆在檢查之後才被寫壞的資料。
        listAllRecipientStatuses: vi.fn(async () => [
          { status: 'sending' },
          { status: 'malformed-after-check' },
        ]),
        listSendingRecipientIds: vi.fn(async () => ['r1']),
      })
      const result = await reconcileCampaignDelivery(deps)
      expect(result).toEqual({ outcome: 'invalid-recipient-state' })
      // round 19 修正（Finding 4，報告用詞精確化）：零 recipient
      // mutation、零 finalize 呼叫——reclaim／finalize 完全沒被呼叫過；但
      // 這不代表「完全沒有寫入」，acquireLease／releaseLeaseBestEffort 仍然
      // 各自寫過一次 campaign 的租約欄位（見 fakeDeps 的預設實作）。
      expect(deps.listSendingRecipientIds).not.toHaveBeenCalled()
      expect(deps.reclaimExpiredDeliveryAttempt).not.toHaveBeenCalled()
      expect(deps.finalize).not.toHaveBeenCalled()
      expect(deps.releaseLeaseBestEffort).toHaveBeenCalledTimes(1)
    })
  })

  // round 19 新增（Finding 3）：computeAuthoritativeTotals() 是 finalize()
  // 之前「最後一次」讀取 recipient 狀態，跟稍早的 listAllRecipientStatuses()
  // 是兩次獨立的查詢——這裡直接可重現地模擬「兩次查詢之間資料被改壞」的
  // 競態：listAllRecipientStatuses() 回報乾淨資料（驗證通過，reclaim 迴圈
  // 正常跑完），但緊接著的 computeAuthoritativeTotals() 讀到的「當下」資料
  // 已經混進 malformed 狀態，證明即使最早的驗證通過，這裡仍然會在寫入任何
  // campaign 終止狀態之前再次攔下來。
  describe('round 19 新增（Finding 3）：finalize 前最後一次重新驗證（computeAuthoritativeTotals 的 TOCTOU 防線）', () => {
    it('listAllRecipientStatuses 驗證通過，但 computeAuthoritativeTotals 讀到的「當下」資料已經混進 malformed 狀態 → invalid-recipient-state，不呼叫 finalize，best-effort 釋放租約', async () => {
      const deps = fakeDeps({
        listAllRecipientStatuses: vi.fn(async () => [{ status: 'sent' }, { status: 'exhausted' }]),
        computeAuthoritativeTotals: vi.fn(async () => ({ outcome: 'invalid-recipient-state' as const })),
      })
      const result = await reconcileCampaignDelivery(deps)
      expect(result).toEqual({ outcome: 'invalid-recipient-state' })
      expect(deps.finalize).not.toHaveBeenCalled()
      expect(deps.releaseLeaseBestEffort).toHaveBeenCalledTimes(1)
    })

    it('reclaim 迴圈已經處理過幾位過期的 sending 收件人（合法、已經個別完成的轉換）之後，computeAuthoritativeTotals 才發現資料不可信 → 仍然正確中止，不呼叫 finalize（reclaim 本身的個別轉換不受影響，是這支函式自己合法的寫入，不是「部分寫入的錯誤」）', async () => {
      const deps = fakeDeps({
        listAllRecipientStatuses: vi.fn(async () => [{ status: 'sending' }, { status: 'sending' }]),
        listSendingRecipientIds: vi.fn(async () => ['r1', 'r2']),
        reclaimExpiredDeliveryAttempt: vi.fn(async () => ({ outcome: 'marked-unknown' as const, patch: {} })),
        computeAuthoritativeTotals: vi.fn(async () => ({ outcome: 'invalid-recipient-state' as const })),
      })
      const result = await reconcileCampaignDelivery(deps)
      expect(result).toEqual({ outcome: 'invalid-recipient-state' })
      expect(deps.reclaimExpiredDeliveryAttempt).toHaveBeenCalledTimes(2)
      expect(deps.finalize).not.toHaveBeenCalled()
      expect(deps.releaseLeaseBestEffort).toHaveBeenCalledTimes(1)
    })

    it('computeAuthoritativeTotals 回報 ok → 正常繼續呼叫 finalize，不受這道新防線影響', async () => {
      const totals = { recipients: 2, sent: 1, failed: 0, exhausted: 1, deliveryUnknown: 0 }
      const deps = fakeDeps({
        computeAuthoritativeTotals: vi.fn(async () => ({ outcome: 'ok' as const, totals, nonTerminalCount: 0 })),
      })
      const result = await reconcileCampaignDelivery(deps)
      expect(deps.finalize).toHaveBeenCalledWith(totals, 0)
      expect(result.outcome).toBe('reconciled')
    })
  })

  // 結構性保證（不是執行期測試，是型別層級的保證）：
  // ReconcileCampaignDeliveryDeps 這個介面本身就不存在 sendMail／
  // createTransport／readSmtpSettings／claim 任何一種能力——上面所有測試
  // 用的 fakeDeps() 都只實作這個介面允許的方法，TypeScript 編譯本身就是
  // 「這支函式不可能呼叫到 SMTP 相關能力」的證明，不需要另外在執行期
  // 斷言一個根本不存在的方法沒有被呼叫。
})

describe('classifyLeaseForAudit（round 14 新增，Finding 3：部署 drain audit 的純分類邏輯）', () => {
  const NOW = 1_700_000_000_000

  it('attemptId 完全缺失 → absent', () => {
    expect(classifyLeaseForAudit(undefined, undefined, undefined, NOW)).toBe('absent')
    expect(classifyLeaseForAudit(null, NOW + 1000, undefined, NOW)).toBe('absent')
  })

  it('attemptId 存在，expiry 完全無法解析 → indeterminate（fail closed，不能猜測已過期）', () => {
    expect(classifyLeaseForAudit('someone', undefined, undefined, NOW)).toBe('indeterminate')
    expect(classifyLeaseForAudit('someone', 'not-a-number', undefined, NOW)).toBe('indeterminate')
  })

  it('attemptId 存在，expiry 尚未過期 → active', () => {
    expect(classifyLeaseForAudit('someone', NOW + 1000, undefined, NOW)).toBe('active')
  })

  it('attemptId 存在，expiry 已過期 → stale', () => {
    expect(classifyLeaseForAudit('someone', NOW - 1, undefined, NOW)).toBe('stale')
  })

  it('相容讀取：舊格式 Timestamp-like 的 expiry 也能正確分類', () => {
    expect(classifyLeaseForAudit('someone', undefined, { toMillis: () => NOW + 1000 }, NOW)).toBe(
      'active',
    )
    expect(classifyLeaseForAudit('someone', undefined, { toMillis: () => NOW - 1 }, NOW)).toBe(
      'stale',
    )
  })

  // round 18 核心迴歸案例（Finding 4）：attemptId 是 malformed 值（不是
  // undefined／null，但也不是合法字串）時，即使 expiry 已過期（stale 本身
  // severity 是 SAFE），也絕不能被洗成 SAFE——必須是 indeterminate。
  it('round 18 迴歸（Finding 4）：attemptId 是空字串／只有空白／數字／物件（malformed，非 absent）→ indeterminate，即使 expiry 已過期', () => {
    for (const malformed of ['', '   ', 123, {}, [], true]) {
      expect(classifyLeaseForAudit(malformed, NOW - 1, undefined, NOW)).toBe('indeterminate')
      // 即使 expiry 尚未過期，也不能被當成合法的 active（owner 本身不可信）。
      expect(classifyLeaseForAudit(malformed, NOW + 1000, undefined, NOW)).toBe('indeterminate')
    }
  })

  it('round 18 新增（Finding 4）：合法的 UUID 字串正常判斷為 active／stale', () => {
    const uuid = '3fa85f64-5717-4562-b3fc-2c963f66afa6'
    expect(classifyLeaseForAudit(uuid, NOW + 1000, undefined, NOW)).toBe('active')
    expect(classifyLeaseForAudit(uuid, NOW - 1, undefined, NOW)).toBe('stale')
  })
})

describe('parseLeaseOwner（round 18 新增，Finding 4：processing／resolution／generation 分類器共用的 owner parser）', () => {
  it('undefined／null → absent', () => {
    expect(parseLeaseOwner(undefined)).toBe('absent')
    expect(parseLeaseOwner(null)).toBe('absent')
  })

  it('trim 之後非空的字串 → present', () => {
    expect(parseLeaseOwner('attempt-1')).toBe('present')
    expect(parseLeaseOwner('  attempt-1  ')).toBe('present')
  })

  it.each(['', '   ', 0, 123, true, false, {}, [], ['a']])(
    '%s（型別錯誤或空白字串）→ malformed',
    (value) => {
      expect(parseLeaseOwner(value)).toBe('malformed')
    },
  )
})

describe('classifyLeaseGenerationForDrainAudit（round 16 新增，Finding 2）', () => {
  it('leaseGeneration 缺失，沒有 owner → ok（baseline，全新 campaign 從未被 acquire 過）', () => {
    expect(classifyLeaseGenerationForDrainAudit(undefined, undefined, undefined)).toBe('ok')
  })

  it('leaseGeneration 明確是 0，沒有 owner → ok（baseline）', () => {
    expect(classifyLeaseGenerationForDrainAudit(undefined, undefined, 0)).toBe('ok')
  })

  it('leaseGeneration 是格式錯誤的值 → indeterminate，不論有沒有 owner', () => {
    expect(classifyLeaseGenerationForDrainAudit(undefined, undefined, 'not-a-number')).toBe(
      'indeterminate',
    )
    expect(classifyLeaseGenerationForDrainAudit(undefined, undefined, -1)).toBe('indeterminate')
    expect(classifyLeaseGenerationForDrainAudit(undefined, undefined, 1.5)).toBe('indeterminate')
    expect(classifyLeaseGenerationForDrainAudit('owner', undefined, 'not-a-number')).toBe(
      'indeterminate',
    )
  })

  it('processingAttemptId 存在，但 leaseGeneration 缺失／0 → indeterminate（不可能的組合：任何一次成功 acquire 都會把它推到 >=1）', () => {
    expect(classifyLeaseGenerationForDrainAudit('owner', undefined, undefined)).toBe(
      'indeterminate',
    )
    expect(classifyLeaseGenerationForDrainAudit('owner', undefined, 0)).toBe('indeterminate')
  })

  it('resolutionAttemptId 存在，但 leaseGeneration 缺失／0 → indeterminate（跟 processingAttemptId 的規則相同，因為兩者共用同一個 generation）', () => {
    expect(classifyLeaseGenerationForDrainAudit(undefined, 'admin', undefined)).toBe(
      'indeterminate',
    )
    expect(classifyLeaseGenerationForDrainAudit(undefined, 'admin', 0)).toBe('indeterminate')
  })

  it('processingAttemptId 與 resolutionAttemptId 同時存在，leaseGeneration >= 1 → ok', () => {
    expect(classifyLeaseGenerationForDrainAudit('owner', 'admin', 1)).toBe('ok')
    expect(classifyLeaseGenerationForDrainAudit('owner', 'admin', 42)).toBe('ok')
  })

  it('processingAttemptId 與 resolutionAttemptId 同時存在，但 leaseGeneration 缺失／0 → indeterminate', () => {
    expect(classifyLeaseGenerationForDrainAudit('owner', 'admin', undefined)).toBe('indeterminate')
    expect(classifyLeaseGenerationForDrainAudit('owner', 'admin', 0)).toBe('indeterminate')
  })

  it('只有 processingAttemptId（沒有 resolutionAttemptId），leaseGeneration >= 1 → ok', () => {
    expect(classifyLeaseGenerationForDrainAudit('owner', undefined, 1)).toBe('ok')
  })

  it('只有 resolutionAttemptId（沒有 processingAttemptId），leaseGeneration >= 1 → ok', () => {
    expect(classifyLeaseGenerationForDrainAudit(undefined, 'admin', 1)).toBe('ok')
  })

  it('leaseGeneration === Number.MAX_SAFE_INTEGER → exhausted，不論有沒有 owner（下一次 acquire 一定會被 production 拒絕）', () => {
    expect(
      classifyLeaseGenerationForDrainAudit(undefined, undefined, Number.MAX_SAFE_INTEGER),
    ).toBe('exhausted')
    expect(classifyLeaseGenerationForDrainAudit('owner', undefined, Number.MAX_SAFE_INTEGER)).toBe(
      'exhausted',
    )
    expect(
      classifyLeaseGenerationForDrainAudit(undefined, 'admin', Number.MAX_SAFE_INTEGER),
    ).toBe('exhausted')
    expect(
      classifyLeaseGenerationForDrainAudit('owner', 'admin', Number.MAX_SAFE_INTEGER),
    ).toBe('exhausted')
  })

  it('leaseGeneration 剛好在上限之下（MAX_SAFE_INTEGER - 1）→ ok（還沒到耗盡）', () => {
    expect(
      classifyLeaseGenerationForDrainAudit('owner', undefined, Number.MAX_SAFE_INTEGER - 1),
    ).toBe('ok')
  })

  // round 18 核心迴歸案例（Finding 4）：processingAttemptId 是 malformed
  // 值（不是 undefined／null），配合 leaseGeneration>=1（看起來合法）——
  // 舊版的寬鬆判斷會把 malformed 值當成「沒有 owner」（因為只檢查
  // !== undefined && !== null 才算有 owner，但這裡誤解成「這串奇怪的值
  // 不算 owner」），可能讓資料損毀被忽略掉。round 18 起明確 fail closed。
  it('round 18 迴歸（Finding 4）：processingAttemptId 是空字串／數字／物件（malformed）→ indeterminate，即使 leaseGeneration 看起來合法', () => {
    for (const malformed of ['', '   ', 123, {}, []]) {
      expect(classifyLeaseGenerationForDrainAudit(malformed, undefined, 1)).toBe('indeterminate')
    }
  })

  it('round 18 迴歸（Finding 4）：resolutionAttemptId 是 malformed 值 → indeterminate', () => {
    for (const malformed of ['', '   ', 123, {}]) {
      expect(classifyLeaseGenerationForDrainAudit(undefined, malformed, 1)).toBe('indeterminate')
    }
  })

  it('round 18 迴歸（Finding 4）：processingAttemptId malformed，即使 leaseGeneration 是 baseline（0）也仍然是 indeterminate（不會被誤判成「沒有 owner 的合法 baseline」）', () => {
    expect(classifyLeaseGenerationForDrainAudit('', undefined, 0)).toBe('indeterminate')
  })
})

describe('classifyRecipientForDrainAudit（round 14 新增，Finding 3）', () => {
  const NOW = 1_700_000_000_000

  it('claimed，lease 無法解析 → safe（SMTP 根本還沒被呼叫過）', () => {
    expect(
      classifyRecipientForDrainAudit(
        { status: 'claimed', leaseExpiresAtMs: undefined, leaseExpiresAtLegacy: undefined },
        NOW,
      ),
    ).toBe('safe')
  })

  it('sending，lease 無法解析 → unknown（delivery 狀態不明）', () => {
    expect(
      classifyRecipientForDrainAudit(
        { status: 'sending', leaseExpiresAtMs: undefined, leaseExpiresAtLegacy: undefined },
        NOW,
      ),
    ).toBe('unknown')
  })

  it('claimed，lease 已過期 → safe（可以被合法重新認領）', () => {
    expect(
      classifyRecipientForDrainAudit(
        { status: 'claimed', leaseExpiresAtMs: NOW - 1, leaseExpiresAtLegacy: undefined },
        NOW,
      ),
    ).toBe('safe')
  })

  it('sending，lease 已過期 → unknown（需要 reconciliation，不能直接假設可以重寄）', () => {
    expect(
      classifyRecipientForDrainAudit(
        { status: 'sending', leaseExpiresAtMs: NOW - 1, leaseExpiresAtLegacy: undefined },
        NOW,
      ),
    ).toBe('unknown')
  })

  it('claimed／sending，lease 尚未過期 → active（可能還在合法處理中）', () => {
    expect(
      classifyRecipientForDrainAudit(
        { status: 'claimed', leaseExpiresAtMs: NOW + 1000, leaseExpiresAtLegacy: undefined },
        NOW,
      ),
    ).toBe('active')
    expect(
      classifyRecipientForDrainAudit(
        { status: 'sending', leaseExpiresAtMs: NOW + 1000, leaseExpiresAtLegacy: undefined },
        NOW,
      ),
    ).toBe('active')
  })

  it('round 15 新增（Finding 4）：status 缺失／非字串／不是已知的 RecipientStatus → indeterminate（fail closed，不能假設安全）', () => {
    expect(
      classifyRecipientForDrainAudit(
        { status: undefined, leaseExpiresAtMs: undefined, leaseExpiresAtLegacy: undefined },
        NOW,
      ),
    ).toBe('indeterminate')
    expect(
      classifyRecipientForDrainAudit(
        { status: null, leaseExpiresAtMs: undefined, leaseExpiresAtLegacy: undefined },
        NOW,
      ),
    ).toBe('indeterminate')
    expect(
      classifyRecipientForDrainAudit(
        { status: 123, leaseExpiresAtMs: undefined, leaseExpiresAtLegacy: undefined },
        NOW,
      ),
    ).toBe('indeterminate')
    expect(
      classifyRecipientForDrainAudit(
        { status: 'not-a-real-status', leaseExpiresAtMs: undefined, leaseExpiresAtLegacy: undefined },
        NOW,
      ),
    ).toBe('indeterminate')
  })

  it('round 15 新增（Finding 4）：已知的終止狀態（queued／sent／failed／exhausted／delivery_unknown）→ safe，不受 lease 欄位影響', () => {
    for (const status of ['queued', 'sent', 'failed', 'exhausted', 'delivery_unknown']) {
      expect(
        classifyRecipientForDrainAudit(
          { status, leaseExpiresAtMs: NOW + 1000, leaseExpiresAtLegacy: undefined },
          NOW,
        ),
      ).toBe('safe')
    }
  })
})

describe('classifySetupPhaseForDrainAudit（round 15 新增，Finding 3：部署 drain audit 的 setup 階段分類）', () => {
  const NOW = 1_700_000_000_000

  function baseInput(overrides: Partial<SetupPhaseAuditInput> = {}): SetupPhaseAuditInput {
    return {
      status: 'sending',
      recipientsReady: false,
      activeAttemptId: undefined,
      createdByAttemptId: 'attempt-1',
      startedAtMs: NOW,
      startedAtLegacy: undefined,
      ...overrides,
    }
  }

  it('recipientsReady === true → not-setup-phase（不論其他欄位為何，包含 activeAttemptId 存在）', () => {
    expect(
      classifySetupPhaseForDrainAudit(baseInput({ recipientsReady: true }), NOW),
    ).toBe('not-setup-phase')
    expect(
      classifySetupPhaseForDrainAudit(
        baseInput({ recipientsReady: true, activeAttemptId: 'someone' }),
        NOW,
      ),
    ).toBe('not-setup-phase')
  })

  // round 16 修正（Finding 1 項目 1）：這是這一輪要修的核心迴歸案例——
  // round 15 版本這裡斷言 'not-setup-phase'，理由是「這個不一致已經會被
  // processing lease 分類擋住」，但如果那個 lease 剛好已經過期（severity
  // SAFE 的 'stale'），而且沒有任何 claimed／sending 收件人，整份 campaign
  // 就會被誤判成 SAFE。recipientsReady:false 加上一個合法的 activeAttemptId
  // 同時存在，本身就是不可能的組合，必須直接 fail closed。
  it('recipientsReady:false 且 activeAttemptId 是合法的非空字串 → indeterminate（不能假設會被別的規則擋住）', () => {
    expect(
      classifySetupPhaseForDrainAudit(
        baseInput({ recipientsReady: false, activeAttemptId: 'someone' }),
        NOW,
      ),
    ).toBe('indeterminate')
  })

  it('round 16 新增（Finding 1 項目 3）：activeAttemptId 是數字／物件／空字串時不算合法存在，不觸發上面的 indeterminate 規則，繼續往下走正常的 setup-phase 判斷', () => {
    // 這幾個 malformed 值本身不算「存在一個 attemptId」，所以不會落入
    // 「recipientsReady:false + activeAttemptId 存在」這條規則——繼續往下
    // 用 baseInput 剩下欄位（status:'sending'、createdByAttemptId:
    // 'attempt-1'、startedAtMs:NOW）走到底，因為沒有超過 staleMs，
    // 應該是 'active'。
    expect(
      classifySetupPhaseForDrainAudit(baseInput({ activeAttemptId: 0 }), NOW),
    ).toBe('active')
    expect(
      classifySetupPhaseForDrainAudit(baseInput({ activeAttemptId: {} }), NOW),
    ).toBe('active')
    expect(
      classifySetupPhaseForDrainAudit(baseInput({ activeAttemptId: '' }), NOW),
    ).toBe('active')
  })

  it('round 16 修正（Finding 1 項目 2）：recipientsReady 不是明確的 true／false（缺失或非布林）→ indeterminate，不論 activeAttemptId 是否存在', () => {
    expect(
      classifySetupPhaseForDrainAudit(baseInput({ recipientsReady: undefined }), NOW),
    ).toBe('indeterminate')
    expect(
      classifySetupPhaseForDrainAudit(baseInput({ recipientsReady: 'false' }), NOW),
    ).toBe('indeterminate')
    // round 16 核心迴歸案例的另一半：recipientsReady 缺失、且
    // activeAttemptId 同時存在——round 15 版本會先被 activeAttemptId 的
    // 存在攔下、直接回傳 'not-setup-phase'，完全不會走到 recipientsReady
    // 的檢查。round 16 起必須無論如何都先確認 recipientsReady 本身合法，
    // 才能繼續判斷。
    expect(
      classifySetupPhaseForDrainAudit(
        baseInput({ recipientsReady: undefined, activeAttemptId: 'someone' }),
        NOW,
      ),
    ).toBe('indeterminate')
    expect(
      classifySetupPhaseForDrainAudit(
        baseInput({ recipientsReady: 1, activeAttemptId: 'someone' }),
        NOW,
      ),
    ).toBe('indeterminate')
  })

  it('status !== "sending" → indeterminate（recipientsReady:false 只能合法搭配 status:sending）', () => {
    expect(
      classifySetupPhaseForDrainAudit(baseInput({ status: 'partial' }), NOW),
    ).toBe('indeterminate')
    expect(
      classifySetupPhaseForDrainAudit(baseInput({ status: undefined }), NOW),
    ).toBe('indeterminate')
  })

  it('createdByAttemptId 缺失 → indeterminate（建立者身分不明）', () => {
    expect(
      classifySetupPhaseForDrainAudit(baseInput({ createdByAttemptId: undefined }), NOW),
    ).toBe('indeterminate')
    expect(
      classifySetupPhaseForDrainAudit(baseInput({ createdByAttemptId: null }), NOW),
    ).toBe('indeterminate')
  })

  it('round 16 新增（Finding 1 項目 3）：createdByAttemptId 是數字／物件／空字串時不算合法存在 → indeterminate', () => {
    expect(
      classifySetupPhaseForDrainAudit(baseInput({ createdByAttemptId: 0 }), NOW),
    ).toBe('indeterminate')
    expect(
      classifySetupPhaseForDrainAudit(baseInput({ createdByAttemptId: {} }), NOW),
    ).toBe('indeterminate')
    expect(
      classifySetupPhaseForDrainAudit(baseInput({ createdByAttemptId: '' }), NOW),
    ).toBe('indeterminate')
  })

  it('startedAtMs／startedAt 都無法解析 → indeterminate', () => {
    expect(
      classifySetupPhaseForDrainAudit(
        baseInput({ startedAtMs: undefined, startedAtLegacy: undefined }),
        NOW,
      ),
    ).toBe('indeterminate')
    expect(
      classifySetupPhaseForDrainAudit(
        baseInput({ startedAtMs: 'not-a-number', startedAtLegacy: undefined }),
        NOW,
      ),
    ).toBe('indeterminate')
  })

  it('相容讀取：只有舊格式 startedAt（Timestamp-like）也能正確解析', () => {
    expect(
      classifySetupPhaseForDrainAudit(
        baseInput({ startedAtMs: undefined, startedAtLegacy: { toMillis: () => NOW } }),
        NOW,
      ),
    ).toBe('active')
  })

  it('尚未超過 RECIPIENTS_SETUP_STALE_MS → active（setup 很可能還在進行中）', () => {
    expect(
      classifySetupPhaseForDrainAudit(baseInput({ startedAtMs: NOW - 1000 }), NOW),
    ).toBe('active')
  })

  it('已經超過 RECIPIENTS_SETUP_STALE_MS → unknown（不能視為 SAFE，需要 reclaim 或人工確認）', () => {
    expect(
      classifySetupPhaseForDrainAudit(
        baseInput({ startedAtMs: NOW - RECIPIENTS_SETUP_STALE_MS - 1 }),
        NOW,
      ),
    ).toBe('unknown')
  })
})

describe('classifyCampaignForDrainAudit（round 14 新增，Finding 3：跟部署 runbook 的【淨空判斷標準】逐字對應）', () => {
  const NOW = 1_700_000_000_000

  function baseInput(overrides: Partial<CampaignDrainAuditInput> = {}): CampaignDrainAuditInput {
    return {
      campaignId: 'c1',
      status: 'sending',
      // recipientsReady:true → 明確不在 setup 階段，讓這個 describe 區塊
      // 既有的測試（都是在描述「setup 已完成之後」的租約／收件人狀態）
      // 不會被 round 15 新增的 setup-phase 判斷影響。setup phase 本身的
      // 判斷矩陣在下面的 classifySetupPhaseForDrainAudit describe 區塊。
      recipientsReady: true,
      activeAttemptId: undefined,
      activeLeaseExpiresAtMs: undefined,
      activeLeaseExpiresAtLegacy: undefined,
      resolutionLeaseAttemptId: undefined,
      resolutionLeaseExpiresAtMs: undefined,
      // round 16 新增（Finding 2）：leaseGeneration 預設給一個合法的
      // baseline（>=1，not-exhausted）——這個 describe 區塊的既有測試都是
      // 在描述「租約本身」的分類，不是特地測 leaseGeneration，給一個穩定
      // 合法值才不會讓每個帶 activeAttemptId／resolutionLeaseAttemptId 的
      // 案例意外被 leaseGeneration 判成 indeterminate（owner 存在時
      // leaseGeneration 必須 >=1，見 classifyLeaseGenerationForDrainAudit）。
      // leaseGeneration 本身的判斷矩陣在下面獨立的 describe 區塊。
      leaseGeneration: 1,
      createdByAttemptId: undefined,
      startedAtMs: undefined,
      startedAtLegacy: undefined,
      // round 27 修正（提交前審查 Finding 1）：不提供 campaignRawData——
      // isLegacyCompletedPartialMismatchSafe() 在缺少這個欄位時一律 fail
      // closed，這個 describe 區塊既有的測試都是 status:'sending'（terminal
      // 為 false，legacy 例外本來就不適用），不需要它。SAFE_WITH_WARNING 的
      // 專屬矩陣在下面獨立的 describe 區塊，會自己建構包含 campaignRawData
      // 的輸入。
      recipients: [],
      ...overrides,
    }
  }

  it('完全沒有任何租約、沒有 claimed／sending 收件人 → SAFE', () => {
    const result = classifyCampaignForDrainAudit(baseInput(), NOW)
    expect(result.classification).toBe('SAFE')
  })

  it('processing lease 存在且未過期 → ACTIVE（不論 status 是 sending 還是 partial，見 Finding 3 的原始問題）', () => {
    for (const status of ['sending', 'partial']) {
      const result = classifyCampaignForDrainAudit(
        baseInput({ status, activeAttemptId: 'someone', activeLeaseExpiresAtMs: NOW + 1000 }),
        NOW,
      )
      expect(result.classification).toBe('ACTIVE')
    }
  })

  it('processing lease 存在但 expiry 無法解析 → INDETERMINATE（優先於 ACTIVE／UNKNOWN，最嚴重）', () => {
    const result = classifyCampaignForDrainAudit(
      baseInput({ activeAttemptId: 'someone', activeLeaseExpiresAtMs: undefined }),
      NOW,
    )
    expect(result.classification).toBe('INDETERMINATE')
  })

  it('resolution lease 存在且未過期 → ACTIVE（套用跟 processing lease 相同的規則）', () => {
    const result = classifyCampaignForDrainAudit(
      baseInput({ resolutionLeaseAttemptId: 'admin', resolutionLeaseExpiresAtMs: NOW + 1000 }),
      NOW,
    )
    expect(result.classification).toBe('ACTIVE')
  })

  it('resolution lease 存在但 expiry 無法解析 → INDETERMINATE', () => {
    const result = classifyCampaignForDrainAudit(
      baseInput({ resolutionLeaseAttemptId: 'admin', resolutionLeaseExpiresAtMs: undefined }),
      NOW,
    )
    expect(result.classification).toBe('INDETERMINATE')
  })

  it('processing／resolution lease 都已過期，claimed 收件人也已過期 → SAFE（claimed 過期不影響部署）', () => {
    const result = classifyCampaignForDrainAudit(
      baseInput({
        activeAttemptId: 'someone',
        activeLeaseExpiresAtMs: NOW - 1,
        recipients: [{ status: 'claimed', leaseExpiresAtMs: NOW - 1, leaseExpiresAtLegacy: undefined }],
      }),
      NOW,
    )
    expect(result.classification).toBe('SAFE')
  })

  it('processing lease 已過期，但有 sending 收件人的 lease 也已過期 → UNKNOWN（需要 reconciliation）', () => {
    const result = classifyCampaignForDrainAudit(
      baseInput({
        status: 'partial',
        activeAttemptId: 'someone',
        activeLeaseExpiresAtMs: NOW - 1,
        recipients: [{ status: 'sending', leaseExpiresAtMs: NOW - 1, leaseExpiresAtLegacy: undefined }],
      }),
      NOW,
    )
    expect(result.classification).toBe('UNKNOWN')
    expect(result.unknownRecipientCount).toBe(1)
  })

  it('sending 收件人的 lease 無法解析（不是過期，是根本解析不出來）→ UNKNOWN', () => {
    const result = classifyCampaignForDrainAudit(
      baseInput({
        recipients: [
          { status: 'sending', leaseExpiresAtMs: undefined, leaseExpiresAtLegacy: undefined },
        ],
      }),
      NOW,
    )
    expect(result.classification).toBe('UNKNOWN')
  })

  it('sending 收件人的 lease 仍然有效（真的還在合法處理中）→ ACTIVE，不是 UNKNOWN', () => {
    const result = classifyCampaignForDrainAudit(
      baseInput({
        recipients: [
          { status: 'sending', leaseExpiresAtMs: NOW + 1000, leaseExpiresAtLegacy: undefined },
        ],
      }),
      NOW,
    )
    expect(result.classification).toBe('ACTIVE')
    expect(result.activeRecipientCount).toBe(1)
  })

  it('多個收件人混合狀態，回傳的計數正確反映每一種分類', () => {
    const result = classifyCampaignForDrainAudit(
      baseInput({
        recipients: [
          { status: 'claimed', leaseExpiresAtMs: NOW - 1, leaseExpiresAtLegacy: undefined }, // safe
          { status: 'sending', leaseExpiresAtMs: NOW + 1000, leaseExpiresAtLegacy: undefined }, // active
          { status: 'sending', leaseExpiresAtMs: NOW - 1, leaseExpiresAtLegacy: undefined }, // unknown
          { status: 'sending', leaseExpiresAtMs: undefined, leaseExpiresAtLegacy: undefined }, // unknown
        ],
      }),
      NOW,
    )
    expect(result.recipientCount).toBe(4)
    expect(result.activeRecipientCount).toBe(1)
    expect(result.unknownRecipientCount).toBe(2)
    expect(result.indeterminateRecipientCount).toBe(0)
    // ACTIVE 比 UNKNOWN 嚴重，最終分類是 ACTIVE。
    expect(result.classification).toBe('ACTIVE')
  })

  it('status 欄位缺失或非字串時，回傳的 status 不會是 undefined／[object Object]（防禦性格式化）', () => {
    const result = classifyCampaignForDrainAudit(baseInput({ status: undefined }), NOW)
    expect(typeof result.status).toBe('string')
  })

  it('round 15 新增（Finding 3）：剛建立、setup 尚在進行中（recipientsReady:false，未逾時）→ ACTIVE，即使完全沒有租約也沒有任何收件人', () => {
    const result = classifyCampaignForDrainAudit(
      baseInput({
        recipientsReady: false,
        createdByAttemptId: 'attempt-1',
        startedAtMs: NOW - 1000,
      }),
      NOW,
    )
    expect(result.classification).toBe('ACTIVE')
    expect(result.setupPhase).toBe('active')
  })

  it('round 15 新增（Finding 3）：這是本輪要修的核心迴歸案例——setup 逾時、沒有 activeAttemptId、沒有任何 claimed／sending 收件人，round 14 的公式會誤判 SAFE，round 15 起必須是 UNKNOWN', () => {
    const result = classifyCampaignForDrainAudit(
      baseInput({
        recipientsReady: false,
        createdByAttemptId: 'attempt-1',
        startedAtMs: NOW - RECIPIENTS_SETUP_STALE_MS - 1,
      }),
      NOW,
    )
    expect(result.classification).toBe('UNKNOWN')
    expect(result.setupPhase).toBe('unknown')
  })

  it('round 15 新增（Finding 3）：setup 階段但關鍵欄位缺失（createdByAttemptId 缺失）→ INDETERMINATE，優先於其他一切', () => {
    const result = classifyCampaignForDrainAudit(
      baseInput({
        recipientsReady: false,
        createdByAttemptId: undefined,
        startedAtMs: NOW,
      }),
      NOW,
    )
    expect(result.classification).toBe('INDETERMINATE')
    expect(result.setupPhase).toBe('indeterminate')
  })

  it('round 15 新增（Finding 3）：recipientsReady:true 的正常 campaign 不受 setup 判斷影響 → not-setup-phase', () => {
    const result = classifyCampaignForDrainAudit(baseInput({ recipientsReady: true }), NOW)
    expect(result.setupPhase).toBe('not-setup-phase')
    expect(result.classification).toBe('SAFE')
  })

  // round 16 新增（Finding 1 項目 5）：使用者原始回報的核心迴歸案例——
  // recipientsReady:false、activeAttemptId 存在但租約已過期、完全沒有
  // claimed／sending 收件人。round 15 版本這裡會是 SAFE（setupPhase 被
  // activeAttemptId 的存在直接短路成 not-setup-phase，processingLease 是
  // severity SAFE 的 'stale'，沒有收件人可以貢獻更高的 severity）——這是
  // 錯的，這個組合本身就不該通過。
  it('round 16 迴歸測試（Finding 1）：recipientsReady=false + 過期的 processing lease + 無收件人 → 絕不是 SAFE', () => {
    const result = classifyCampaignForDrainAudit(
      baseInput({
        recipientsReady: false,
        status: 'sending',
        activeAttemptId: 'old-attempt',
        activeLeaseExpiresAtMs: NOW - 1000,
        recipients: [],
      }),
      NOW,
    )
    expect(result.classification).not.toBe('SAFE')
    expect(result.classification).toBe('INDETERMINATE')
    expect(result.setupPhase).toBe('indeterminate')
    expect(result.processingLease).toBe('stale')
  })

  // round 16 新增（Finding 1 項目 4）：processing lease 的 active／stale／
  // indeterminate／absent 分類，交叉 recipientsReady 的 true／false／
  // 缺失／malformed 四種狀態，共 4x4 = 16 組完整矩陣。
  describe('round 16 新增（Finding 1 項目 4）：processing lease × recipientsReady 交叉矩陣', () => {
    type LeaseShape = 'active' | 'stale' | 'indeterminate' | 'absent'
    type ReadyShape = 'true' | 'false' | 'missing' | 'malformed'

    function leaseOverrides(shape: LeaseShape): Partial<CampaignDrainAuditInput> {
      switch (shape) {
        case 'active':
          return { activeAttemptId: 'attempt-x', activeLeaseExpiresAtMs: NOW + 1000 }
        case 'stale':
          return { activeAttemptId: 'attempt-x', activeLeaseExpiresAtMs: NOW - 1000 }
        case 'indeterminate':
          return { activeAttemptId: 'attempt-x', activeLeaseExpiresAtMs: undefined }
        case 'absent':
          return { activeAttemptId: undefined, activeLeaseExpiresAtMs: undefined }
      }
    }

    function readyOverrides(shape: ReadyShape): Partial<CampaignDrainAuditInput> {
      switch (shape) {
        case 'true':
          return { recipientsReady: true }
        case 'false':
          return { recipientsReady: false, status: 'sending', createdByAttemptId: 'creator-1', startedAtMs: NOW }
        case 'missing':
          return { recipientsReady: undefined }
        case 'malformed':
          return { recipientsReady: 'yes' }
      }
    }

    // 每一格的期望結果：owner（active／stale／indeterminate 都有
    // activeAttemptId 存在，只有 absent 沒有）與 recipientsReady 是否為
    // true 共同決定 setupPhase 的貢獻，兩者取最嚴重的 severity。
    const expected: Record<LeaseShape, Record<ReadyShape, CampaignDrainClassification>> = {
      active: {
        true: 'ACTIVE', // recipientsReady:true → not-setup-phase，lease 本身 active 勝出
        false: 'INDETERMINATE', // recipientsReady:false + owner 存在 → setup 判 indeterminate，比 ACTIVE 更嚴重
        missing: 'INDETERMINATE', // recipientsReady 缺失 → setup 判 indeterminate（不論 owner），跟 lease 的 indeterminate 同層級但更嚴重的來源相同
        malformed: 'INDETERMINATE',
      },
      stale: {
        true: 'SAFE', // recipientsReady:true、lease 已過期、無收件人 → 全部 SAFE
        false: 'INDETERMINATE', // 本輪核心迴歸案例本身
        missing: 'INDETERMINATE',
        malformed: 'INDETERMINATE',
      },
      indeterminate: {
        true: 'INDETERMINATE', // lease 本身就 indeterminate
        false: 'INDETERMINATE',
        missing: 'INDETERMINATE',
        malformed: 'INDETERMINATE',
      },
      absent: {
        true: 'SAFE', // 完全沒有租約、recipientsReady:true → SAFE
        false: 'ACTIVE', // 沒有 owner，recipientsReady:false 走完整的 setup phase 判斷式：
        // status='sending'、createdByAttemptId 有效、startedAtMs=NOW（未過期）→ active
        missing: 'INDETERMINATE', // recipientsReady 缺失，不論 owner，setup 判 indeterminate
        malformed: 'INDETERMINATE',
      },
    }

    const leaseShapes: LeaseShape[] = ['active', 'stale', 'indeterminate', 'absent']
    const readyShapes: ReadyShape[] = ['true', 'false', 'missing', 'malformed']

    for (const lease of leaseShapes) {
      for (const ready of readyShapes) {
        it(`processing lease=${lease} × recipientsReady=${ready} → ${expected[lease][ready]}`, () => {
          const result = classifyCampaignForDrainAudit(
            baseInput({ ...leaseOverrides(lease), ...readyOverrides(ready) }),
            NOW,
          )
          expect(result.classification).toBe(expected[lease][ready])
        })
      }
    }
  })

  describe('round 16 新增（Finding 2）：leaseGeneration 折入整體分類', () => {
    it('activeAttemptId 存在但 leaseGeneration 缺失 → INDETERMINATE（不可能的組合）', () => {
      const result = classifyCampaignForDrainAudit(
        baseInput({
          activeAttemptId: 'someone',
          activeLeaseExpiresAtMs: NOW + 1000,
          leaseGeneration: undefined,
        }),
        NOW,
      )
      expect(result.classification).toBe('INDETERMINATE')
      expect(result.leaseGeneration).toBe('indeterminate')
    })

    it('leaseGeneration 已達 Number.MAX_SAFE_INTEGER、status 不是 completed／failed（baseInput 預設 sending）→ 仍然 EXHAUSTED，即使沒有任何 owner、也沒有任何收件人（round 18 修正 Finding 3：harmless 判斷要求 status 必須是 completed 或 failed）', () => {
      const result = classifyCampaignForDrainAudit(
        baseInput({ leaseGeneration: Number.MAX_SAFE_INTEGER }),
        NOW,
      )
      expect(result.classification).toBe('EXHAUSTED')
      expect(result.leaseGeneration).toBe('exhausted')
      expect(result.leaseGenerationExhaustionHarmless).toBe(false)
    })

    it('EXHAUSTED 的 severity 高於 INDETERMINATE——同時有 leaseGeneration 耗盡與其他 indeterminate 訊號時，回報的分類仍然是 EXHAUSTED', () => {
      const result = classifyCampaignForDrainAudit(
        baseInput({
          activeAttemptId: 'someone',
          activeLeaseExpiresAtMs: undefined, // processing lease 本身也是 indeterminate
          leaseGeneration: Number.MAX_SAFE_INTEGER,
        }),
        NOW,
      )
      expect(result.classification).toBe('EXHAUSTED')
    })

    it('正常合法的 leaseGeneration（>=1 且未耗盡）不會拉低或拉高其他判斷——維持原本 lease 分類決定的結果', () => {
      const result = classifyCampaignForDrainAudit(
        baseInput({ activeAttemptId: 'someone', activeLeaseExpiresAtMs: NOW + 1000, leaseGeneration: 7 }),
        NOW,
      )
      expect(result.classification).toBe('ACTIVE')
      expect(result.leaseGeneration).toBe('ok')
    })
  })

  // round 18 新增（Finding 3）：completed／failed／needs_review／partial ×
  // exhausted × 每一種可能讓「exhausted 無害」判斷失敗的訊號，完整矩陣。
  describe('round 18 新增（Finding 3）：EXHAUSTED 狀態感知矩陣（isGenerationExhaustionHarmless）', () => {
    const exhaustedInput = (overrides: Partial<CampaignDrainAuditInput> = {}) =>
      baseInput({ leaseGeneration: Number.MAX_SAFE_INTEGER, ...overrides })

    it('status=completed、無 owner、無收件人 → SAFE（exhausted 確定無害；0 個收件人本來就能自然推出 completed）', () => {
      const result = classifyCampaignForDrainAudit(exhaustedInput({ status: 'completed' }), NOW)
      expect(result.classification).toBe('SAFE')
      expect(result.leaseGeneration).toBe('exhausted')
      expect(result.leaseGenerationExhaustionHarmless).toBe(true)
      expect(result.recipientDistributionConsistent).toBe(true)
    })

    // round 19 修正（Finding 1）：round 18 版本把 completed／failed 兩種
    // status 一起測、共用同一個「SAFE」期望值——這正是 Finding 1 指出的
    // 缺口：decideCampaignStatus({recipients:0,...},0) 只會自然算出
    //'completed'，不會是 'failed'（公式定義：只有 recipients>0 且
    // sent===0 才是 failed，零收件人時一律落在 completed）。一份
    // status:'failed' 但零收件人的 campaign，本身就違反狀態機不變量，不能
    // 靠「沒有 owner、沒有 active／unknown 收件人」就折算成 harmless。
    it('round 19 迴歸（Finding 1）：status=failed、無 owner、無收件人 → 不是 SAFE（failed 不可能自然算出零收件人；exhausted 不能折算成 harmless）', () => {
      const result = classifyCampaignForDrainAudit(exhaustedInput({ status: 'failed' }), NOW)
      expect(result.recipientDistributionConsistent).toBe(false)
      expect(result.leaseGenerationExhaustionHarmless).toBe(false)
      expect(result.classification).toBe('EXHAUSTED')
    })

    it.each(['needs_review', 'sending', 'partial'])(
      'status=%s、無 owner、無收件人 → 仍然 EXHAUSTED（不是 completed／failed，未來可能還需要 acquire）',
      (status) => {
        const result = classifyCampaignForDrainAudit(exhaustedInput({ status }), NOW)
        expect(result.classification).toBe('EXHAUSTED')
        expect(result.leaseGenerationExhaustionHarmless).toBe(false)
      },
    )

    it.each(['completed', 'failed'])(
      'status=%s，但 processing lease 仍有合法 owner（即使已過期／stale）→ 仍然 EXHAUSTED（owner 存在就不算「確定沒有任何 owner」）',
      (status) => {
        const result = classifyCampaignForDrainAudit(
          exhaustedInput({ status, activeAttemptId: 'someone', activeLeaseExpiresAtMs: NOW - 1000 }),
          NOW,
        )
        expect(result.classification).toBe('EXHAUSTED')
        expect(result.leaseGenerationExhaustionHarmless).toBe(false)
      },
    )

    it.each(['completed', 'failed'])(
      'status=%s，但 resolution lease 仍有合法 owner → 仍然 EXHAUSTED',
      (status) => {
        const result = classifyCampaignForDrainAudit(
          exhaustedInput({
            status,
            resolutionLeaseAttemptId: 'admin',
            resolutionLeaseExpiresAtMs: NOW - 1000,
          }),
          NOW,
        )
        expect(result.classification).toBe('EXHAUSTED')
        expect(result.leaseGenerationExhaustionHarmless).toBe(false)
      },
    )

    it.each(['completed', 'failed'])(
      'status=%s，但有一位 active（lease 未過期）收件人 → 仍然 EXHAUSTED',
      (status) => {
        const result = classifyCampaignForDrainAudit(
          exhaustedInput({
            status,
            recipients: [
              { status: 'sending', leaseExpiresAtMs: NOW + 1000, leaseExpiresAtLegacy: undefined },
            ],
          }),
          NOW,
        )
        expect(result.classification).toBe('EXHAUSTED')
        expect(result.leaseGenerationExhaustionHarmless).toBe(false)
      },
    )

    it.each(['completed', 'failed'])(
      'status=%s，但有一位 unknown（sending，lease 過期）收件人 → 仍然 EXHAUSTED',
      (status) => {
        const result = classifyCampaignForDrainAudit(
          exhaustedInput({
            status,
            recipients: [
              { status: 'sending', leaseExpiresAtMs: NOW - 1, leaseExpiresAtLegacy: undefined },
            ],
          }),
          NOW,
        )
        expect(result.classification).toBe('EXHAUSTED')
        expect(result.leaseGenerationExhaustionHarmless).toBe(false)
      },
    )

    it.each(['completed', 'failed'])(
      'status=%s，但有一位 indeterminate（未知 status）收件人 → 仍然 EXHAUSTED',
      (status) => {
        const result = classifyCampaignForDrainAudit(
          exhaustedInput({
            status,
            recipients: [
              { status: 'not-a-real-status', leaseExpiresAtMs: undefined, leaseExpiresAtLegacy: undefined },
            ],
          }),
          NOW,
        )
        expect(result.classification).toBe('EXHAUSTED')
        expect(result.leaseGenerationExhaustionHarmless).toBe(false)
      },
    )

    it('completed、無 owner、只有真正終止的收件人（sent／exhausted，合法組合）→ SAFE（這些不影響 harmless 判斷）', () => {
      const result = classifyCampaignForDrainAudit(
        exhaustedInput({
          status: 'completed',
          recipients: [
            { status: 'sent', leaseExpiresAtMs: undefined, leaseExpiresAtLegacy: undefined },
            { status: 'exhausted', leaseExpiresAtMs: undefined, leaseExpiresAtLegacy: undefined },
          ],
        }),
        NOW,
      )
      expect(result.recipientDistributionConsistent).toBe(true)
      expect(result.classification).toBe('SAFE')
      expect(result.leaseGenerationExhaustionHarmless).toBe(true)
    })

    // round 19 核心迴歸案例（Finding 1）：這是使用者回報的具體反例——
    // completed + [sent, failed, exhausted] + generation exhausted 過去
    // 被判成 SAFE，但 `failed` 收件人仍然可以被一般 retry 重新認領
    //（countNonTerminalRecipients() 明確把它算成非終止），不是真正的終止
    // 結果，跟 classifyRecipientForDrainAudit() 把它歸類成 'safe'（只回答
    //「這位收件人本身有沒有卡住的 lease」）是兩個不同的問題。真實分佈算出
    // 來的 nonTerminalCount 是 1（不是 0），decideCampaignStatus() 自然
    // 算出 'partial'，跟宣稱的 'completed' 互相矛盾，不能折算成 harmless。
    it('round 19 核心迴歸（Finding 1）：completed + [sent, failed, exhausted]（含仍可重試的 failed 收件人）+ generation exhausted → 不是 SAFE，是 EXHAUSTED', () => {
      const result = classifyCampaignForDrainAudit(
        exhaustedInput({
          status: 'completed',
          recipients: [
            { status: 'sent', leaseExpiresAtMs: undefined, leaseExpiresAtLegacy: undefined },
            { status: 'failed', leaseExpiresAtMs: undefined, leaseExpiresAtLegacy: undefined },
            { status: 'exhausted', leaseExpiresAtMs: undefined, leaseExpiresAtLegacy: undefined },
          ],
        }),
        NOW,
      )
      expect(result.recipientDistributionConsistent).toBe(false)
      expect(result.recipientStatusCounts).toEqual({
        queued: 0,
        claimed: 0,
        sending: 0,
        sent: 1,
        failed: 1,
        exhausted: 1,
        delivery_unknown: 0,
        malformed: 0,
      })
      expect(result.leaseGenerationExhaustionHarmless).toBe(false)
      expect(result.classification).toBe('EXHAUSTED')
    })

    it('leaseGeneration 不是 exhausted 時，leaseGenerationExhaustionHarmless 永遠是 false（即使其餘條件都符合 harmless 的其他前提）', () => {
      const result = classifyCampaignForDrainAudit(
        baseInput({ status: 'completed', leaseGeneration: 1 }),
        NOW,
      )
      expect(result.leaseGeneration).toBe('ok')
      expect(result.leaseGenerationExhaustionHarmless).toBe(false)
    })
  })

  describe('round 17 修正（Finding 1）：terminal 只略過 setup-phase schema 驗證，不再整體短路成 SAFE', () => {
    it('status:completed，完全沒有 recipientsReady／leaseGeneration 等新欄位、沒有任何 owner、沒有任何收件人（模擬部署這套 lease 機制之前就存在的舊 schema 歷史 campaign）→ SAFE', () => {
      const result = classifyCampaignForDrainAudit(
        {
          campaignId: 'legacy-1',
          status: 'completed',
          recipientsReady: undefined,
          activeAttemptId: undefined,
          activeLeaseExpiresAtMs: undefined,
          activeLeaseExpiresAtLegacy: undefined,
          resolutionLeaseAttemptId: undefined,
          resolutionLeaseExpiresAtMs: undefined,
          leaseGeneration: undefined,
          createdByAttemptId: undefined,
          startedAtMs: undefined,
          startedAtLegacy: undefined,
          recipients: [],
        },
        NOW,
      )
      expect(result.classification).toBe('SAFE')
      expect(result.setupPhase).toBe('not-setup-phase')
    })

    it('round 17 核心迴歸案例（Finding 1 項目 3）：needs_review + 仍然有效的 resolution 租約 → ACTIVE，不是 SAFE（resolveDeliveryUnknown 可能正在進行中）', () => {
      const result = classifyCampaignForDrainAudit(
        baseInput({
          status: 'needs_review',
          resolutionLeaseAttemptId: 'admin-1',
          resolutionLeaseExpiresAtMs: NOW + 1000,
          // round 19 修正（Finding 1）：這裡刻意搭配一個跟 needs_review 一致
          // 的收件人分佈（一位 delivery_unknown），讓這個測試只獨立驗證
          // resolution 租約本身的訊號，不會被 recipient distribution 不一致
          // 的新檢查（見 auditRecipientDistribution）干擾、蓋成 INDETERMINATE。
          recipients: [
            { status: 'delivery_unknown', leaseExpiresAtMs: undefined, leaseExpiresAtLegacy: undefined },
          ],
        }),
        NOW,
      )
      expect(result.recipientDistributionConsistent).toBe(true)
      expect(result.classification).toBe('ACTIVE')
      expect(result.resolutionLease).toBe('active')
    })

    // round 19 修正（Finding 1）：needs_review 的定義本身要求
    // nonTerminalCount===0（見 decideCampaignStatus）——一位仍在合法租期內
    // 的 sending 收件人，會讓真實分佈算出來的 nonTerminalCount 變成 1，跟
    // needs_review 這個宣稱狀態本身互相矛盾（不只是「還在處理中」）。這比
    // 單一 recipient 的 lease 訊號（ACTIVE）更嚴重，round 19 起這種矛盾
    // 一律至少是 INDETERMINATE，不再只是 ACTIVE。
    it('round 19 修正（Finding 1，原 round 17 項目 4）：needs_review + sending 收件人，lease 仍然有效 → INDETERMINATE（不只是 ACTIVE：這個組合本身違反 needs_review 的 nonTerminalCount===0 不變量）', () => {
      const result = classifyCampaignForDrainAudit(
        baseInput({
          status: 'needs_review',
          recipients: [
            { status: 'sending', leaseExpiresAtMs: NOW + 1000, leaseExpiresAtLegacy: undefined },
          ],
        }),
        NOW,
      )
      expect(result.recipientDistributionConsistent).toBe(false)
      expect(result.classification).toBe('INDETERMINATE')
    })

    it('round 19 修正（Finding 1，原 round 17 項目 4）：needs_review + sending 收件人，lease 已過期 → INDETERMINATE（同樣違反 nonTerminalCount===0 不變量，不只是 UNKNOWN）', () => {
      const result = classifyCampaignForDrainAudit(
        baseInput({
          status: 'needs_review',
          recipients: [
            { status: 'sending', leaseExpiresAtMs: NOW - 1, leaseExpiresAtLegacy: undefined },
          ],
        }),
        NOW,
      )
      expect(result.recipientDistributionConsistent).toBe(false)
      expect(result.classification).toBe('INDETERMINATE')
    })

    it('round 17 迴歸（Finding 1 項目 5）：completed + 仍然有效的 processing lease → ACTIVE，不得是 SAFE', () => {
      const result = classifyCampaignForDrainAudit(
        baseInput({
          status: 'completed',
          activeAttemptId: 'attempt-x',
          activeLeaseExpiresAtMs: NOW + 1000,
        }),
        NOW,
      )
      expect(result.classification).toBe('ACTIVE')
      expect(result.classification).not.toBe('SAFE')
    })

    // round 19 修正（Finding 1，原 round 17 項目 5）：failed 加上一位還在
    // active 寄送中的收件人，不只是「lease 還在使用中」（ACTIVE）——這個
    // 組合本身跟 failed 要求 nonTerminalCount===0 互相矛盾，真實分佈算出來
    // 的狀態會是 'partial'，不是 'failed'，比單純的 lease 訊號更嚴重。
    it('round 19 修正（Finding 1，原 round 17 項目 5）：failed + active 收件人 → INDETERMINATE（不只是 ACTIVE：分佈本身跟 failed 矛盾），不得是 SAFE', () => {
      const result = classifyCampaignForDrainAudit(
        baseInput({
          status: 'failed',
          recipients: [
            { status: 'sending', leaseExpiresAtMs: NOW + 1000, leaseExpiresAtLegacy: undefined },
          ],
        }),
        NOW,
      )
      expect(result.recipientDistributionConsistent).toBe(false)
      expect(result.classification).toBe('INDETERMINATE')
      expect(result.classification).not.toBe('SAFE')
    })

    it('round 17 迴歸（Finding 1 項目 6）：terminal + malformed owner（activeAttemptId 存在但 lease 過期時間無法解析）→ INDETERMINATE，不再被快速通道掩蓋', () => {
      for (const status of ['failed', 'needs_review']) {
        const result = classifyCampaignForDrainAudit(
          baseInput({
            status,
            activeAttemptId: 123, // 存在但格式怪異，classifyLeaseForAudit 視為「有 owner」
            activeLeaseExpiresAtMs: undefined, // 過期時間無法解析
          }),
          NOW,
        )
        expect(result.classification).toBe('INDETERMINATE')
      }
    })

    it('round 17 迴歸（Finding 1 項目 6）：terminal + leaseGeneration 格式錯誤 → INDETERMINATE', () => {
      const result = classifyCampaignForDrainAudit(
        baseInput({ status: 'completed', leaseGeneration: 'garbage' }),
        NOW,
      )
      expect(result.classification).toBe('INDETERMINATE')
    })

    it('round 17 迴歸（Finding 1 項目 6）：terminal + 收件人 status 是未知值 → INDETERMINATE', () => {
      const result = classifyCampaignForDrainAudit(
        baseInput({
          status: 'completed',
          recipients: [
            { status: 'not-a-real-status', leaseExpiresAtMs: undefined, leaseExpiresAtLegacy: undefined },
          ],
        }),
        NOW,
      )
      expect(result.classification).toBe('INDETERMINATE')
    })

    // round 19 修正（Finding 1）：原本的 fixture 混用 sent／failed 兩種
    // status，但 failed 收件人本身仍然算是非終止（countNonTerminalRecipients
    // 明確把它算進去），跟宣稱的 completed 互相矛盾——這不是「其餘資料合法」
    // 的歷史 campaign，而是 Finding 1 指出的具體反例本身。改用 sent／
    // exhausted（兩者都是真正終止的合法組合）才是這個測試原本想描述的
    // 情境；sent+failed 的矛盾組合另外有專屬的迴歸測試涵蓋（見上方
    // EXHAUSTED 狀態感知矩陣、以及下方新增的 distribution 一致性矩陣）。
    it('round 17 迴歸（Finding 1 項目 7，round 19 修正 fixture）：historical terminal、沒有任何 owner、沒有 active／unknown 收件人、收件人分佈與宣稱狀態一致 → SAFE', () => {
      const result = classifyCampaignForDrainAudit(
        baseInput({
          status: 'completed',
          recipients: [
            { status: 'sent', leaseExpiresAtMs: undefined, leaseExpiresAtLegacy: undefined },
            { status: 'exhausted', leaseExpiresAtMs: undefined, leaseExpiresAtLegacy: undefined },
          ],
        }),
        NOW,
      )
      expect(result.recipientDistributionConsistent).toBe(true)
      expect(result.classification).toBe('SAFE')
    })

    it('status:sending／partial（非終止）不受影響，仍然套用完整判斷', () => {
      for (const status of ['sending', 'partial']) {
        const result = classifyCampaignForDrainAudit(
          baseInput({ status, activeAttemptId: 'someone', activeLeaseExpiresAtMs: NOW + 1000 }),
          NOW,
        )
        expect(result.classification).toBe('ACTIVE')
      }
    })
  })

  // round 17 新增（Finding 1 項目 8）：terminal × lease × generation ×
  // recipient 的完整交叉矩陣——terminal 狀態（completed／failed／
  // needs_review）分別交叉 processing lease（absent／active／stale／
  // indeterminate）、leaseGeneration（ok／indeterminate／exhausted）、
  // recipient（none／safe-only／active／unknown／indeterminate）。
  describe('round 17 新增（Finding 1 項目 8）；round 19 修正（Finding 1）：terminal × lease × generation × recipient 完整矩陣', () => {
    const terminalStatuses = ['completed', 'failed', 'needs_review'] as const

    // round 19 新增（Finding 1）：leaseCases／generationCases 這兩組矩陣
    // 本來就只想測「lease／generation 本身的訊號」，不是要測 recipient
    // distribution——但 round 19 新增的 auditRecipientDistribution() 檢查
    // 會讓一份 terminal campaign 配上「跟宣稱狀態對不上」的收件人分佈
    // （例如 baseInput() 預設的 recipients:[]，對 completed 而言剛好一致，
    // 但對 failed／needs_review 而言本身就不一致）額外拉高 severity，
    // 干擾這兩組矩陣原本想獨立驗證的訊號。這裡用一個「每種 status 各自
    // 最小、剛好一致」的收件人基準，讓 distribution 檢查本身固定回報
    // consistent，這樣才能單獨看出 lease／generation 的效果——distribution
    // 檢查本身有自己專屬的矩陣（見下方新增的 describe 區塊）。
    function distributionConsistentRecipientsFor(status: string): RecipientDrainSample[] {
      if (status === 'failed') {
        return [{ status: 'exhausted', leaseExpiresAtMs: undefined, leaseExpiresAtLegacy: undefined }]
      }
      if (status === 'needs_review') {
        return [
          { status: 'delivery_unknown', leaseExpiresAtMs: undefined, leaseExpiresAtLegacy: undefined },
        ]
      }
      // completed：0 個收件人本來就能自然推出 completed，不需要額外填。
      return []
    }

    const leaseCases: Array<{
      name: string
      overrides: Partial<CampaignDrainAuditInput>
      expected: CampaignDrainClassification
    }> = [
      { name: 'lease absent', overrides: {}, expected: 'SAFE' },
      {
        name: 'lease active',
        overrides: { activeAttemptId: 'x', activeLeaseExpiresAtMs: NOW + 1000 },
        expected: 'ACTIVE',
      },
      {
        name: 'lease stale',
        overrides: { activeAttemptId: 'x', activeLeaseExpiresAtMs: NOW - 1000 },
        expected: 'SAFE',
      },
      {
        name: 'lease indeterminate',
        overrides: { activeAttemptId: 'x', activeLeaseExpiresAtMs: undefined },
        expected: 'INDETERMINATE',
      },
    ]

    for (const status of terminalStatuses) {
      for (const { name, overrides, expected } of leaseCases) {
        it(`status=${status} × processing ${name} → ${expected}（收件人分佈與 status 一致，只獨立驗證 lease 訊號）`, () => {
          const result = classifyCampaignForDrainAudit(
            baseInput({ status, recipients: distributionConsistentRecipientsFor(status), ...overrides }),
            NOW,
          )
          expect(result.recipientDistributionConsistent).toBe(true)
          expect(result.classification).toBe(expected)
        })
      }
    }

    const generationCases: Array<{
      name: string
      overrides: Partial<CampaignDrainAuditInput>
      // round 18 修正（Finding 3）：exhausted 對 completed／failed 跟
      // needs_review 的結果不再相同——用函式而不是單一值，依 status 決定
      // 期望結果。
      expected: (status: string) => CampaignDrainClassification
    }> = [
      {
        name: 'baseline（無 owner，缺失）',
        overrides: { leaseGeneration: undefined },
        expected: () => 'SAFE',
      },
      { name: 'baseline（無 owner，0）', overrides: { leaseGeneration: 0 }, expected: () => 'SAFE' },
      {
        name: 'malformed',
        overrides: { leaseGeneration: 'garbage' },
        expected: () => 'INDETERMINATE',
      },
      {
        // round 18 核心迴歸案例（Finding 3）：owner、收件人分佈都跟宣稱
        // status 一致時，completed／failed 的 exhausted 是「確定無害」
        //（SAFE），但 needs_review 仍然阻擋（EXHAUSTED）——因為它可能還
        // 需要 resolveDeliveryUnknown 的 resolution acquire。
        name: 'exhausted（無 owner、收件人分佈與 status 一致）',
        overrides: { leaseGeneration: Number.MAX_SAFE_INTEGER },
        expected: (status) => (status === 'needs_review' ? 'EXHAUSTED' : 'SAFE'),
      },
    ]

    for (const status of terminalStatuses) {
      for (const { name, overrides, expected } of generationCases) {
        it(`status=${status} × leaseGeneration ${name} → ${expected(status)}（收件人分佈與 status 一致，只獨立驗證 generation 訊號）`, () => {
          const result = classifyCampaignForDrainAudit(
            baseInput({ status, recipients: distributionConsistentRecipientsFor(status), ...overrides }),
            NOW,
          )
          expect(result.recipientDistributionConsistent).toBe(true)
          expect(result.classification).toBe(expected(status))
        })
      }
    }

    // round 19 修正（Finding 1）：這組矩陣的用意是測「單一 recipient 的
    // lease 訊號」（active／unknown／indeterminate／已終止的 safe），但這些
    // 收件人組合本身大多數也會讓真實分佈跟宣稱的 terminal status 不一致
    // （例如任何還算非終止的收件人，配上任何一種 terminal status，都會讓
    // decideCampaignStatus() 自然算出 'partial'，跟三種 terminal status
    // 都對不上）——這正是 Finding 1 的核心：distribution 不一致比單一
    // recipient 的 lease 狀態更嚴重，round 19 起這種組合一律至少是
    // INDETERMINATE，不再只是 ACTIVE／UNKNOWN。只有 'none'／'safe-only'
    // 這兩種本身不含任何非終止收件人的案例，才可能因為 status 剛好是
    // completed（0 個或 1 個 sent 收件人都能自然推出 completed）而維持
    // SAFE；對 failed／needs_review 而言，即使是 'none'／'safe-only' 也會
    // 因為分佈對不上而變成 INDETERMINATE（這正好呼應下方新增的
    //「failed + zero recipients」「failed + sent」規定測試案例）。
    const recipientCases: Array<{
      name: string
      recipients: RecipientDrainSample[]
      expected: (status: string) => CampaignDrainClassification
    }> = [
      {
        name: 'none',
        recipients: [],
        expected: (status) => (status === 'completed' ? 'SAFE' : 'INDETERMINATE'),
      },
      {
        name: 'safe-only（已終止狀態：sent）',
        recipients: [{ status: 'sent', leaseExpiresAtMs: undefined, leaseExpiresAtLegacy: undefined }],
        expected: (status) => (status === 'completed' ? 'SAFE' : 'INDETERMINATE'),
      },
      {
        name: 'active（lease 未過期）',
        recipients: [
          { status: 'sending', leaseExpiresAtMs: NOW + 1000, leaseExpiresAtLegacy: undefined },
        ],
        expected: () => 'INDETERMINATE',
      },
      {
        name: 'unknown（sending，lease 過期）',
        recipients: [{ status: 'sending', leaseExpiresAtMs: NOW - 1, leaseExpiresAtLegacy: undefined }],
        expected: () => 'INDETERMINATE',
      },
      {
        name: 'indeterminate（未知 status 字串）',
        recipients: [
          { status: 'not-a-real-status', leaseExpiresAtMs: undefined, leaseExpiresAtLegacy: undefined },
        ],
        expected: () => 'INDETERMINATE',
      },
    ]

    for (const status of terminalStatuses) {
      for (const { name, recipients, expected } of recipientCases) {
        it(`status=${status} × recipient ${name} → ${expected(status)}`, () => {
          const result = classifyCampaignForDrainAudit(baseInput({ status, recipients }), NOW)
          expect(result.classification).toBe(expected(status))
        })
      }
    }
  })

  // round 19 新增（Finding 1）：terminal status × recipient authoritative
  // distribution 的獨立矩陣——直接對應使用者要求的完整案例清單，用
  // baseInput() 預設的 leaseGeneration:1（非 exhausted），確認這個檢查是
  // 「任何 terminal campaign」都適用的一般規則，不是只綁在 EXHAUSTED 特例
  // 上（那部分另外由 isGenerationExhaustionHarmless 的專屬矩陣涵蓋）。
  describe('round 19 新增（Finding 1）：terminal status × recipient authoritative distribution 一致性矩陣', () => {
    function recipient(status: string, overrides: Partial<RecipientDrainSample> = {}): RecipientDrainSample {
      return { status, leaseExpiresAtMs: undefined, leaseExpiresAtLegacy: undefined, ...overrides }
    }

    it('completed + failed 收件人 → INDETERMINATE，不可 SAFE（failed 仍可重試，不是終止結果）', () => {
      const result = classifyCampaignForDrainAudit(
        baseInput({ status: 'completed', recipients: [recipient('failed')] }),
        NOW,
      )
      expect(result.recipientDistributionConsistent).toBe(false)
      expect(result.classification).toBe('INDETERMINATE')
    })

    it('completed + queued 收件人 → INDETERMINATE（queued 從未被處理過，不是終止結果）', () => {
      const result = classifyCampaignForDrainAudit(
        baseInput({ status: 'completed', recipients: [recipient('queued')] }),
        NOW,
      )
      expect(result.recipientDistributionConsistent).toBe(false)
      expect(result.classification).toBe('INDETERMINATE')
    })

    it('completed + 已過期的 claimed 收件人 → INDETERMINATE（即使租約已過期，claimed 本身仍算非終止；單一 recipient 分類器會回報 safe，但整體分佈仍然不一致）', () => {
      const result = classifyCampaignForDrainAudit(
        baseInput({
          status: 'completed',
          recipients: [recipient('claimed', { leaseExpiresAtMs: NOW - 1000 })],
        }),
        NOW,
      )
      expect(result.recipientDistributionConsistent).toBe(false)
      expect(result.classification).toBe('INDETERMINATE')
    })

    it('completed + delivery_unknown 收件人 → INDETERMINATE（真實分佈會自然推出 needs_review，不是 completed）', () => {
      const result = classifyCampaignForDrainAudit(
        baseInput({ status: 'completed', recipients: [recipient('delivery_unknown')] }),
        NOW,
      )
      expect(result.recipientDistributionConsistent).toBe(false)
      expect(result.classification).toBe('INDETERMINATE')
    })

    it('failed + 只有 exhausted 收件人 → 合法，SAFE（至少一位收件人、sent=0、沒有非終止或 delivery_unknown，正是 failed 的正式定義）', () => {
      const result = classifyCampaignForDrainAudit(
        baseInput({ status: 'failed', recipients: [recipient('exhausted')] }),
        NOW,
      )
      expect(result.recipientDistributionConsistent).toBe(true)
      expect(result.classification).toBe('SAFE')
    })

    it('failed + sent 收件人 → INDETERMINATE（有人真的成功過，真實分佈會自然推出 completed，不是 failed）', () => {
      const result = classifyCampaignForDrainAudit(
        baseInput({ status: 'failed', recipients: [recipient('sent')] }),
        NOW,
      )
      expect(result.recipientDistributionConsistent).toBe(false)
      expect(result.classification).toBe('INDETERMINATE')
    })

    it('failed + failed 收件人 → INDETERMINATE（failed 仍算非終止，真實分佈會自然推出 partial，不是 failed）', () => {
      const result = classifyCampaignForDrainAudit(
        baseInput({ status: 'failed', recipients: [recipient('failed')] }),
        NOW,
      )
      expect(result.recipientDistributionConsistent).toBe(false)
      expect(result.classification).toBe('INDETERMINATE')
    })

    it('failed + 零收件人 → INDETERMINATE（decideCampaignStatus 對零收件人只會自然算出 completed，不會是 failed，不能折成 SAFE）', () => {
      const result = classifyCampaignForDrainAudit(
        baseInput({ status: 'failed', recipients: [] }),
        NOW,
      )
      expect(result.recipientDistributionConsistent).toBe(false)
      expect(result.classification).toBe('INDETERMINATE')
    })

    it('completed + sent／exhausted 合法組合 → SAFE', () => {
      const result = classifyCampaignForDrainAudit(
        baseInput({
          status: 'completed',
          recipients: [recipient('sent'), recipient('exhausted')],
        }),
        NOW,
      )
      expect(result.recipientDistributionConsistent).toBe(true)
      expect(result.classification).toBe('SAFE')
    })

    // round 19 明確要求：needs_review + delivery_unknown 維持原本「需要
    // resolution」的行為——這是 needs_review 本來就預期的正常狀態（沒有人
    // 折算成 SAFE，也不應該被新的 distribution 檢查誤判成 INDETERMINATE）。
    it('needs_review + delivery_unknown → SAFE（distribution 本身一致；是否阻擋部署交給 UNKNOWN 分類負責，見既有的 needs_review 測試）', () => {
      const result = classifyCampaignForDrainAudit(
        baseInput({ status: 'needs_review', recipients: [recipient('delivery_unknown')] }),
        NOW,
      )
      expect(result.recipientDistributionConsistent).toBe(true)
      // needs_review 沒有任何 lease／owner／recipient 訊號時，distribution
      // 一致代表分類本身可以是 SAFE——真正「需要人工 resolution」的判斷
      // 是靠 status 本身停在 needs_review（不會自動變回 sending／partial），
      // 不是靠 drain audit 的 classification 阻擋部署，這跟既有的
      // resolution-lease-active（→ ACTIVE）測試互補，不是取代。
      expect(result.classification).toBe('SAFE')
    })

    it('sending／partial（非 terminal）不受這個檢查約束，即使收件人分佈「看起來」不像任何終止狀態，也不會被判成 INDETERMINATE', () => {
      for (const status of ['sending', 'partial']) {
        const result = classifyCampaignForDrainAudit(
          baseInput({ status, recipients: [recipient('queued'), recipient('failed')] }),
          NOW,
        )
        expect(result.recipientDistributionConsistent).toBe(true)
        expect(result.classification).toBe('SAFE')
      }
    })
  })

  // round 20 新增（Finding 1，P1 核心）：campaign.status 本身是否是合法值，
  // 必須獨立影響整體 severity，不能只靠 setupPhase 或 recipient
  // distribution 間接體現——見 shared/campaignSend.ts 的
  // isKnownCampaignStatus()／statusValiditySeverity 說明。
  describe('campaign.status 合法性（round 20 新增，Finding 1：獨立於 setupPhase／recipient distribution 的 fail-closed 檢查）', () => {
    // round 19 遺留的具體缺口重現：recipientsReady:true（讓 setupPhase 直接
    // 短路成 not-setup-phase）、沒有任何 owner、leaseGeneration 合法、
    // recipients 是空陣列——這組合下，過去的版本只要 status 不合法就會被
    // 悄悄「安全地」忽略，整體被判成 SAFE。round 20 修正後必須是
    // INDETERMINATE。
    const invalidStatusValues: [string, unknown][] = [
      ['undefined', undefined],
      ['null', null],
      ['空字串', ''],
      ['亂打的字串', 'in_progress'],
      ['數字', 1],
      ['物件', { status: 'sending' }],
      ['陣列', ['sending']],
      ['布林', true],
    ]

    it.each(invalidStatusValues)(
      'status 是 %s（不是五個已知合法值之一）→ campaignStatusValid:false，整體 classification 至少是 INDETERMINATE，即使其餘一切看起來都安全',
      (_label, statusValue) => {
        const result = classifyCampaignForDrainAudit(
          baseInput({ status: statusValue as CampaignDrainAuditInput['status'], recipients: [] }),
          NOW,
        )
        expect(result.campaignStatusValid).toBe(false)
        expect(result.classification).toBe('INDETERMINATE')
      },
    )

    it.each(['sending', 'partial', 'completed', 'failed', 'needs_review'] as const)(
      '五個已知合法值之一（%s）→ campaignStatusValid:true，不會因為這個檢查本身被拉到 INDETERMINATE',
      (status) => {
        const result = classifyCampaignForDrainAudit(baseInput({ status, recipients: [] }), NOW)
        expect(result.campaignStatusValid).toBe(true)
      },
    )

    it('isKnownCampaignStatus() 本身：只接受五個已知字串，其餘一律 false', () => {
      for (const s of ['sending', 'partial', 'completed', 'failed', 'needs_review'] as KnownCampaignStatus[]) {
        expect(isKnownCampaignStatus(s)).toBe(true)
      }
      for (const [, v] of invalidStatusValues) {
        expect(isKnownCampaignStatus(v)).toBe(false)
      }
    })

    // round 20 新增（Finding 1）：generation-exhausted 搭配不合法的
    // status——舊版 isGenerationExhaustionHarmless() 已經會因為
    // status!=='completed'&&status!=='failed' 而回傳 false（不合法的
    // status 從未真正等於這兩個字串），這裡明確驗證「不合法的 status」不會
    // 透過 harmless 規則被折算成 SAFE，維持 EXHAUSTED（比 INDETERMINATE
    // 更嚴重，兩者都不是 SAFE）。
    it.each(invalidStatusValues)(
      'generation-exhausted + status 是 %s（不合法）→ 不會被 harmless 規則折算成 SAFE，leaseGenerationExhaustionHarmless:false',
      (_label, statusValue) => {
        const result = classifyCampaignForDrainAudit(
          baseInput({
            status: statusValue as CampaignDrainAuditInput['status'],
            leaseGeneration: Number.MAX_SAFE_INTEGER,
            recipients: [],
          }),
          NOW,
        )
        expect(result.leaseGenerationExhaustionHarmless).toBe(false)
        expect(result.classification).not.toBe('SAFE')
      },
    )
  })

  // round 27 新增（Finding 1）：SAFE_WITH_WARNING——這套 lease 機制部署之前
  // 建立的歷史 completed campaign，recipientsReady／createdAt／updatedAt／
  // completedAt 四個欄位完全缺失，沒有任何 owner，收件人真實分佈只有
  // sent／failed，唯一的異常訊號是宣稱的 completed 跟真實分佈重新算出來的
  // partial 不一致。這裡用完全合成、刻意跟真實資料（人數、campaignId）不同
  // 的數字，逐項驗證 isLegacyCompletedPartialMismatchSafe() 的每一個硬性
  // 條件，任何一項不成立都必須 fail closed，維持原本（通常是 INDETERMINATE）
  // 的分類，不能被誤判成 SAFE_WITH_WARNING。
  describe('SAFE_WITH_WARNING（round 27 新增，Finding 1：歷史 completed campaign，completed／partial 落差已知且範圍極窄）', () => {
    function legacyRecipient(status: string): RecipientDrainSample {
      return { status, leaseExpiresAtMs: undefined, leaseExpiresAtLegacy: undefined }
    }

    /** 完全符合 legacy 例外形狀的 campaign——4 筆 sent、2 筆 failed（刻意
     *  跟真實 production 資料的 113/3/116 不同，避免任何人誤以為這裡引用
     *  了真實資料）。`campaignRawData: {}` 是一個真正「什麼欄位都沒有」的
     *  原始物件——`Object.prototype.hasOwnProperty.call({}, field)` 對任何
     *  field 都回傳 false，代表 recipientsReady／createdAt／updatedAt／
     *  completedAt 這四個欄位在這份「文件」裡完全不存在，不是恰好讀到
     *  undefined。單一測試只覆寫想驗證的那個欄位，其餘全部維持「本來應該
     *  會通過」的樣子。 */
    function legacyInput(overrides: Partial<CampaignDrainAuditInput> = {}): CampaignDrainAuditInput {
      return {
        campaignId: 'synthetic-legacy-campaign',
        status: 'completed',
        recipientsReady: undefined,
        activeAttemptId: undefined,
        activeLeaseExpiresAtMs: undefined,
        activeLeaseExpiresAtLegacy: undefined,
        resolutionLeaseAttemptId: undefined,
        resolutionLeaseExpiresAtMs: undefined,
        leaseGeneration: undefined,
        createdByAttemptId: undefined,
        startedAtMs: undefined,
        startedAtLegacy: undefined,
        campaignRawData: {},
        recipients: [
          legacyRecipient('sent'),
          legacyRecipient('sent'),
          legacyRecipient('sent'),
          legacyRecipient('sent'),
          legacyRecipient('failed'),
          legacyRecipient('failed'),
        ],
        ...overrides,
      }
    }

    it('完全符合 legacy 形狀（四個欄位在原始物件上完全不存在）→ SAFE_WITH_WARNING，legacyCompletedPartialMismatchWaived:true，distribution 本身仍然誠實回報 inconsistent', () => {
      const result = classifyCampaignForDrainAudit(legacyInput(), NOW)
      expect(result.classification).toBe('SAFE_WITH_WARNING')
      expect(result.legacyCompletedPartialMismatchWaived).toBe(true)
      expect(result.recipientDistributionConsistent).toBe(false)
      expect(result.recipientStatusCounts).toEqual({
        queued: 0,
        claimed: 0,
        sending: 0,
        sent: 4,
        failed: 2,
        exhausted: 0,
        delivery_unknown: 0,
        malformed: 0,
      })
    })

    it('沒有提供 campaignRawData（undefined）→ 無法證明缺席，fail closed，維持 INDETERMINATE', () => {
      const result = classifyCampaignForDrainAudit(legacyInput({ campaignRawData: undefined }), NOW)
      expect(result.classification).toBe('INDETERMINATE')
      expect(result.legacyCompletedPartialMismatchWaived).toBe(false)
    })

    it('recipientsReady 在原始物件上是 false（own property）→ 不合格，維持 INDETERMINATE（terminal campaign 的 setupPhase 短路成 not-setup-phase，唯一的訊號仍然是 distribution 不一致）', () => {
      const result = classifyCampaignForDrainAudit(
        legacyInput({ campaignRawData: { recipientsReady: false } }),
        NOW,
      )
      expect(result.classification).toBe('INDETERMINATE')
      expect(result.legacyCompletedPartialMismatchWaived).toBe(false)
    })

    it('recipientsReady 在原始物件上是 true（own property）→ 不合格，維持 INDETERMINATE', () => {
      const result = classifyCampaignForDrainAudit(
        legacyInput({ campaignRawData: { recipientsReady: true } }),
        NOW,
      )
      expect(result.classification).toBe('INDETERMINATE')
      expect(result.legacyCompletedPartialMismatchWaived).toBe(false)
    })

    it('recipientsReady 在原始物件上是 null（own property，不是嚴格的「不存在」）→ 不合格，維持 INDETERMINATE', () => {
      const result = classifyCampaignForDrainAudit(
        legacyInput({ campaignRawData: { recipientsReady: null } }),
        NOW,
      )
      expect(result.classification).toBe('INDETERMINATE')
      expect(result.legacyCompletedPartialMismatchWaived).toBe(false)
    })

    it('recipientsReady 在原始物件上是非空字串 → 不合格，維持 INDETERMINATE', () => {
      const result = classifyCampaignForDrainAudit(
        legacyInput({ campaignRawData: { recipientsReady: 'true' } }),
        NOW,
      )
      expect(result.classification).toBe('INDETERMINATE')
      expect(result.legacyCompletedPartialMismatchWaived).toBe(false)
    })

    it('recipientsReady 在原始物件上是空字串 → 不合格，維持 INDETERMINATE（field 依然是 own property，即使值是空字串）', () => {
      const result = classifyCampaignForDrainAudit(
        legacyInput({ campaignRawData: { recipientsReady: '' } }),
        NOW,
      )
      expect(result.classification).toBe('INDETERMINATE')
      expect(result.legacyCompletedPartialMismatchWaived).toBe(false)
    })

    it('recipientsReady 是物件實字明確賦值的 own property，值恰好是 undefined（hasOwnProperty 仍然是 true）→ 不合格，維持 INDETERMINATE——這正是「不能只用 value === undefined 判斷」的核心案例', () => {
      const rawData: Record<string, unknown> = { recipientsReady: undefined }
      expect(Object.prototype.hasOwnProperty.call(rawData, 'recipientsReady')).toBe(true)
      const result = classifyCampaignForDrainAudit(legacyInput({ campaignRawData: rawData }), NOW)
      expect(result.classification).toBe('INDETERMINATE')
      expect(result.legacyCompletedPartialMismatchWaived).toBe(false)
    })

    it('createdAt 在原始物件上存在（own property）→ 不合格，維持 INDETERMINATE', () => {
      const result = classifyCampaignForDrainAudit(
        legacyInput({ campaignRawData: { createdAt: 1_600_000_000_000 } }),
        NOW,
      )
      expect(result.classification).toBe('INDETERMINATE')
      expect(result.legacyCompletedPartialMismatchWaived).toBe(false)
    })

    it('createdAt 在原始物件上是 null（own property）→ 不合格，維持 INDETERMINATE', () => {
      const result = classifyCampaignForDrainAudit(legacyInput({ campaignRawData: { createdAt: null } }), NOW)
      expect(result.classification).toBe('INDETERMINATE')
      expect(result.legacyCompletedPartialMismatchWaived).toBe(false)
    })

    it('updatedAt 在原始物件上存在（own property）→ 不合格，維持 INDETERMINATE', () => {
      const result = classifyCampaignForDrainAudit(
        legacyInput({ campaignRawData: { updatedAt: 1_600_000_000_000 } }),
        NOW,
      )
      expect(result.classification).toBe('INDETERMINATE')
      expect(result.legacyCompletedPartialMismatchWaived).toBe(false)
    })

    it('updatedAt 在原始物件上是 null（own property）→ 不合格，維持 INDETERMINATE', () => {
      const result = classifyCampaignForDrainAudit(legacyInput({ campaignRawData: { updatedAt: null } }), NOW)
      expect(result.classification).toBe('INDETERMINATE')
      expect(result.legacyCompletedPartialMismatchWaived).toBe(false)
    })

    it('completedAt 在原始物件上存在（own property）→ 不合格，維持 INDETERMINATE', () => {
      const result = classifyCampaignForDrainAudit(
        legacyInput({ campaignRawData: { completedAt: 1_600_000_000_000 } }),
        NOW,
      )
      expect(result.classification).toBe('INDETERMINATE')
      expect(result.legacyCompletedPartialMismatchWaived).toBe(false)
    })

    it('completedAt 在原始物件上是 null（own property）→ 不合格，維持 INDETERMINATE', () => {
      const result = classifyCampaignForDrainAudit(legacyInput({ campaignRawData: { completedAt: null } }), NOW)
      expect(result.classification).toBe('INDETERMINATE')
      expect(result.legacyCompletedPartialMismatchWaived).toBe(false)
    })

    it('processing lease owner 存在（即使租約已過期）→ 不合格，維持 INDETERMINATE', () => {
      const result = classifyCampaignForDrainAudit(
        legacyInput({
          activeAttemptId: 'someone',
          activeLeaseExpiresAtMs: NOW - 1000, // 已過期，processingLease 本身仍然是 'stale'（severity SAFE）
          leaseGeneration: 1, // owner 存在時的合法 generation，避免額外觸發 leaseGeneration 的 indeterminate
        }),
        NOW,
      )
      expect(result.classification).toBe('INDETERMINATE')
      expect(result.legacyCompletedPartialMismatchWaived).toBe(false)
      expect(result.processingLease).toBe('stale')
    })

    // 提交前審查 Finding 2（額外組合測試）：legacy completed／partial
    // mismatch 疊加「processing lease owner 存在，但租約到期時間欄位本身
    // 格式錯誤（無法解析）」——這跟上面「owner 存在但租約已過期」不同，
    // processingLease 分類本身會是 'indeterminate'（無法證明過期或有效，
    // fail closed），不是 'stale'，用來確認 legacy 例外對這兩種不同的
    // lease 異常型態都同樣不合格，不會因為分類細節不同就意外放行。
    it('processing lease owner 存在、且租約到期時間欄位格式錯誤（無法解析）→ processingLease 是 indeterminate，不合格，維持 INDETERMINATE', () => {
      const result = classifyCampaignForDrainAudit(
        legacyInput({
          activeAttemptId: 'someone',
          activeLeaseExpiresAtMs: 'not-a-timestamp',
          leaseGeneration: 1,
        }),
        NOW,
      )
      expect(result.processingLease).toBe('indeterminate')
      expect(result.classification).toBe('INDETERMINATE')
      expect(result.legacyCompletedPartialMismatchWaived).toBe(false)
    })

    it('resolution lease owner 存在（即使租約已過期）→ 不合格，維持 INDETERMINATE', () => {
      const result = classifyCampaignForDrainAudit(
        legacyInput({
          resolutionLeaseAttemptId: 'admin',
          resolutionLeaseExpiresAtMs: NOW - 1000,
          leaseGeneration: 1,
        }),
        NOW,
      )
      expect(result.classification).toBe('INDETERMINATE')
      expect(result.legacyCompletedPartialMismatchWaived).toBe(false)
      expect(result.resolutionLease).toBe('stale')
    })

    it('setup owner（createdByAttemptId）存在 → 不合格，維持 INDETERMINATE（terminal campaign 的既有邏輯完全不檢查這個欄位，這是本輪新增的獨立檢查）', () => {
      const result = classifyCampaignForDrainAudit(
        legacyInput({ createdByAttemptId: 'setup-owner-1' }),
        NOW,
      )
      expect(result.classification).toBe('INDETERMINATE')
      expect(result.legacyCompletedPartialMismatchWaived).toBe(false)
    })

    it('leaseGeneration 是畸形值 → 不合格，維持 INDETERMINATE', () => {
      const result = classifyCampaignForDrainAudit(
        legacyInput({ leaseGeneration: 'not-a-number' }),
        NOW,
      )
      expect(result.classification).toBe('INDETERMINATE')
      expect(result.legacyCompletedPartialMismatchWaived).toBe(false)
      expect(result.leaseGeneration).toBe('indeterminate')
    })

    // 提交前審查 Finding 2（額外組合測試）：legacy completed／partial
    // mismatch 疊加 leaseGeneration 已耗盡（Number.MAX_SAFE_INTEGER）——這
    // 個組合刻意驗證兩件事同時成立：(1) isGenerationExhaustionHarmless()
    // 本身要求 distributionConsistent===true 才會把 EXHAUSTED 折算成
    // harmless／SAFE（round 20 修正），這份 campaign 的 distribution 恰好
    // 是「不一致」（legacy mismatch 的定義本身），所以 harmless 條件不成立，
    // 維持真正的 EXHAUSTED，不會被折算成 SAFE；(2) EXHAUSTED 的
    // severity（4）比 INDETERMINATE（3）高，pre-downgrade 分類會是
    // EXHAUSTED 而不是 INDETERMINATE，round 27 的 legacy 例外只在
    // pre-downgrade 恰好是 INDETERMINATE 時才會嘗試套用（見
    // classifyCampaignForDrainAudit() 裡的外層 gate），所以這裡連
    // isLegacyCompletedPartialMismatchSafe() 都不會被呼叫到，
    // legacyCompletedPartialMismatchWaived 必須是 false。
    it('leaseGeneration 已耗盡（Number.MAX_SAFE_INTEGER）→ EXHAUSTED（不是 SAFE_WITH_WARNING、也不是被 harmless 折算成 SAFE，因為 distribution 本身不一致）', () => {
      const result = classifyCampaignForDrainAudit(
        legacyInput({ leaseGeneration: Number.MAX_SAFE_INTEGER }),
        NOW,
      )
      expect(result.leaseGeneration).toBe('exhausted')
      expect(result.leaseGenerationExhaustionHarmless).toBe(false)
      expect(result.classification).toBe('EXHAUSTED')
      expect(result.legacyCompletedPartialMismatchWaived).toBe(false)
    })

    it('queued > 0 → 不合格，維持 INDETERMINATE', () => {
      const result = classifyCampaignForDrainAudit(
        legacyInput({ recipients: [...legacyInput().recipients, legacyRecipient('queued')] }),
        NOW,
      )
      expect(result.classification).toBe('INDETERMINATE')
      expect(result.legacyCompletedPartialMismatchWaived).toBe(false)
    })

    it('claimed > 0（租約已過期，單一 recipient 分類器本身回報 safe）→ 不合格，維持 INDETERMINATE', () => {
      const result = classifyCampaignForDrainAudit(
        legacyInput({
          recipients: [
            ...legacyInput().recipients,
            { status: 'claimed', leaseExpiresAtMs: NOW - 1000, leaseExpiresAtLegacy: undefined },
          ],
        }),
        NOW,
      )
      expect(result.classification).toBe('INDETERMINATE')
      expect(result.legacyCompletedPartialMismatchWaived).toBe(false)
    })

    // 提交前審查 Finding 2（額外組合測試）：跟上面「claimed 但租約已過期」
    // 不同，這裡的租約「尚未過期」——單一 recipient 分類器本身會回報
    // 'active'（severity 2），跟 distribution 不一致的 severity（3，
    // INDETERMINATE）同時存在。worstSeverity 仍然是 3（INDETERMINATE 比
    // active 更嚴重），outer gate（preDowngradeClassification==='INDETERMINATE'）
    // 因此還是會嘗試呼叫 isLegacyCompletedPartialMismatchSafe()——這裡驗證
    // 的正是條件 22 的 activeRecipientCount!==0 這一支獨立防線真的有效，
    // 不是只靠 statusCounts.claimed!==0 那一支檢查單獨撐住。
    it('claimed > 0（租約尚未過期，單一 recipient 分類器回報 active）→ activeRecipientCount 非 0，不合格，維持 INDETERMINATE——驗證條件 22 的獨立防線，不只是靠 statusCounts.claimed', () => {
      const result = classifyCampaignForDrainAudit(
        legacyInput({
          recipients: [
            ...legacyInput().recipients,
            { status: 'claimed', leaseExpiresAtMs: NOW + 60_000, leaseExpiresAtLegacy: undefined },
          ],
        }),
        NOW,
      )
      expect(result.activeRecipientCount).toBe(1)
      expect(result.classification).toBe('INDETERMINATE')
      expect(result.legacyCompletedPartialMismatchWaived).toBe(false)
    })

    it('sending > 0 → 不合格，維持 INDETERMINATE（這裡不可避免地也會讓單一 recipient 分類器回報 unknown，兩個訊號同時存在，但都不足以蓋過 INDETERMINATE 的 severity，最終分類仍然是 INDETERMINATE）', () => {
      const result = classifyCampaignForDrainAudit(
        legacyInput({
          recipients: [...legacyInput().recipients, legacyRecipient('sending')],
        }),
        NOW,
      )
      expect(result.classification).toBe('INDETERMINATE')
      expect(result.legacyCompletedPartialMismatchWaived).toBe(false)
    })

    it('delivery_unknown > 0 → 不合格，維持 INDETERMINATE', () => {
      const result = classifyCampaignForDrainAudit(
        legacyInput({ recipients: [...legacyInput().recipients, legacyRecipient('delivery_unknown')] }),
        NOW,
      )
      expect(result.classification).toBe('INDETERMINATE')
      expect(result.legacyCompletedPartialMismatchWaived).toBe(false)
    })

    it('存在 malformed 的收件人 status → 不合格，維持 INDETERMINATE', () => {
      const result = classifyCampaignForDrainAudit(
        legacyInput({ recipients: [...legacyInput().recipients, legacyRecipient('not-a-real-status')] }),
        NOW,
      )
      expect(result.classification).toBe('INDETERMINATE')
      expect(result.legacyCompletedPartialMismatchWaived).toBe(false)
    })

    it('failed 剛好是 0（只有 sent）→ 這其實是完全一致、乾乾淨淨的 completed campaign，分類是 SAFE，不是 SAFE_WITH_WARNING（沒有任何落差需要警告）', () => {
      const result = classifyCampaignForDrainAudit(
        legacyInput({
          recipients: [legacyRecipient('sent'), legacyRecipient('sent'), legacyRecipient('sent')],
        }),
        NOW,
      )
      expect(result.recipientDistributionConsistent).toBe(true)
      expect(result.classification).toBe('SAFE')
      expect(result.legacyCompletedPartialMismatchWaived).toBe(false)
    })

    it('sent 剛好是 0（只有 failed）→ 不合格，維持 INDETERMINATE（真實分佈仍然會自然推出 partial，但缺少至少一筆 sent 本身就不符合這個例外要求的形狀）', () => {
      const result = classifyCampaignForDrainAudit(
        legacyInput({
          recipients: [legacyRecipient('failed'), legacyRecipient('failed')],
        }),
        NOW,
      )
      expect(result.recipientDistributionConsistent).toBe(false)
      expect(result.classification).toBe('INDETERMINATE')
      expect(result.legacyCompletedPartialMismatchWaived).toBe(false)
    })

    it('exhausted > 0 → 不合格，維持 INDETERMINATE', () => {
      const result = classifyCampaignForDrainAudit(
        legacyInput({ recipients: [...legacyInput().recipients, legacyRecipient('exhausted')] }),
        NOW,
      )
      expect(result.classification).toBe('INDETERMINATE')
      expect(result.legacyCompletedPartialMismatchWaived).toBe(false)
    })

    it('權威狀態重新算出來不是 partial（只有 sent／delivery_unknown，nonTerminalCount===0 且 deliveryUnknown>0 自然推出 needs_review）→ 不合格，維持 INDETERMINATE——⚠️ 依 decideCampaignStatus() 的公式，只要 failed>0 就一定會讓 nonTerminalCount>0、權威狀態一定是 partial，所以這個情境無法在不同時違反「failed>0」的前提下單獨重現，這裡刻意選一個 failed===0 的分佈來讓權威狀態變成 partial 以外的值', () => {
      const result = classifyCampaignForDrainAudit(
        legacyInput({
          recipients: [legacyRecipient('sent'), legacyRecipient('delivery_unknown')],
        }),
        NOW,
      )
      expect(result.recipientDistributionConsistent).toBe(false)
      expect(result.classification).toBe('INDETERMINATE')
      expect(result.legacyCompletedPartialMismatchWaived).toBe(false)
    })

    it.each(['failed', 'needs_review', 'sending', 'partial'] as const)(
      '宣稱的 status 是 %s（不是 completed）→ 不合格，維持 INDETERMINATE',
      (status) => {
        const result = classifyCampaignForDrainAudit(legacyInput({ status }), NOW)
        expect(result.classification).toBe('INDETERMINATE')
        expect(result.legacyCompletedPartialMismatchWaived).toBe(false)
      },
    )

    it('legacy 形狀之外「同時」存在另一個獨立、更嚴重的問題（leaseGeneration 已耗盡）→ 必須回報更嚴重的分類（EXHAUSTED），不是 SAFE_WITH_WARNING——isGenerationExhaustionHarmless() 本身也會因為 distributionConsistent:false 而拒絕把這個 exhausted 折算成 SAFE，兩個獨立的防線同時擋下', () => {
      const result = classifyCampaignForDrainAudit(
        legacyInput({ leaseGeneration: Number.MAX_SAFE_INTEGER }),
        NOW,
      )
      expect(result.classification).toBe('EXHAUSTED')
      expect(result.legacyCompletedPartialMismatchWaived).toBe(false)
      expect(result.leaseGenerationExhaustionHarmless).toBe(false)
    })

    it('isKnownCampaignStatus() 認可的合法值以外的 status（例如亂打的字串）→ 不合格，維持 INDETERMINATE（campaignStatusValid:false 本身就會把整體拉到 INDETERMINATE）', () => {
      const result = classifyCampaignForDrainAudit(legacyInput({ status: 'in_progress' }), NOW)
      expect(result.campaignStatusValid).toBe(false)
      expect(result.classification).toBe('INDETERMINATE')
      expect(result.legacyCompletedPartialMismatchWaived).toBe(false)
    })

    it('一批多份 campaign（部分 SAFE、部分 SAFE_WITH_WARNING）→ isDrainAuditBlocking() 對兩者都回傳 false，證明彙總／exit-code 邏輯會把兩者都當成不阻擋部署', () => {
      const safeResult = classifyCampaignForDrainAudit(
        baseInput({ status: 'completed', recipientsReady: true, recipients: [] }),
        NOW,
      )
      const warningResult = classifyCampaignForDrainAudit(legacyInput(), NOW)
      expect(safeResult.classification).toBe('SAFE')
      expect(warningResult.classification).toBe('SAFE_WITH_WARNING')

      const batch = [safeResult, warningResult]
      expect(batch.map((r) => r.classification)).toEqual(['SAFE', 'SAFE_WITH_WARNING'])
      expect(batch.every((r) => !isDrainAuditBlocking(r.classification))).toBe(true)
      // 而任何一份真正阻擋部署的分類，isDrainAuditBlocking() 必須回傳 true——
      // 確認這不是一個「永遠回傳 false」的退化實作。
      expect(
        isDrainAuditBlocking(
          classifyCampaignForDrainAudit(
            legacyInput({ activeAttemptId: 'someone', activeLeaseExpiresAtMs: NOW + 1000 }),
            NOW,
          ).classification,
        ),
      ).toBe(true)
    })
  })

  describe('isDrainAuditBlocking（round 27 新增，Finding 1：SAFE／SAFE_WITH_WARNING 都不阻擋部署，其餘三種都阻擋）', () => {
    it.each(['SAFE', 'SAFE_WITH_WARNING'] as CampaignDrainClassification[])(
      '%s → false（不阻擋部署）',
      (classification) => {
        expect(isDrainAuditBlocking(classification)).toBe(false)
      },
    )

    it.each(['ACTIVE', 'UNKNOWN', 'INDETERMINATE', 'EXHAUSTED'] as CampaignDrainClassification[])(
      '%s → true（阻擋部署）',
      (classification) => {
        expect(isDrainAuditBlocking(classification)).toBe(true)
      },
    )
  })
})

describe('decideCampaignStatusRepair（round 26 新增：--action repair-status 的純決策邏輯——只校正 campaign 頂層 status／totals 跟真實收件人分佈之間的落差，這一輪只支援 completed → partial 這一種 transition，不碰任何 recipient 文件、不重試、不寄信）', () => {
  /** 一份「乾淨」的、predisposed-eligible 的 completed campaign——單一測試
   *  只覆寫想驗證的那個欄位，其餘全部維持「本來應該會通過」的樣子，這樣
   *  才能確定每個 reject 案例真的是被那一項檢查擋下，不是被其他無關的
   *  欄位意外擋下。 */
  const eligibleCampaign = (overrides: Record<string, unknown> = {}) =>
    snapOf({
      status: 'completed',
      recipientsReady: true,
      leaseGeneration: 7,
      totals: { recipients: 116, sent: 116, failed: 0, exhausted: 0, deliveryUnknown: 0 },
      ...overrides,
    })

  /** 真實案例的形狀：113 sent + 3 failed（116 筆）。 */
  const REAL_CASE_RECIPIENTS = [
    ...Array.from({ length: 113 }, () => ({ status: 'sent' })),
    ...Array.from({ length: 3 }, () => ({ status: 'failed' })),
  ]

  it('completed + 真實分佈 sent:113／failed:3 → eligible，target 是 partial，patch 內容跟權威 totals 完全一致', () => {
    const decision = decideCampaignStatusRepair(eligibleCampaign(), REAL_CASE_RECIPIENTS)
    expect(decision.outcome).toBe('eligible')
    expect(decision.currentStatus).toBe('completed')
    expect(decision.authoritativeStatus).toBe('partial')
    expect(decision.authoritativeTotals).toEqual({
      recipients: 116,
      sent: 113,
      failed: 3,
      exhausted: 0,
      deliveryUnknown: 0,
    })
    expect(decision.nonTerminalCount).toBe(3)
    expect(decision.patch).toEqual({
      status: 'partial',
      'totals.recipients': 116,
      'totals.sent': 113,
      'totals.failed': 3,
      'totals.exhausted': 0,
      'totals.deliveryUnknown': 0,
    })
  })

  it('campaign 不存在 → campaign-not-found', () => {
    expect(decideCampaignStatusRepair(missing, REAL_CASE_RECIPIENTS).outcome).toBe('campaign-not-found')
  })

  it('recipientsReady 缺失 → not-ready', () => {
    const decision = decideCampaignStatusRepair(eligibleCampaign({ recipientsReady: undefined }), REAL_CASE_RECIPIENTS)
    expect(decision.outcome).toBe('not-ready')
  })

  it('recipientsReady 是 false → not-ready', () => {
    const decision = decideCampaignStatusRepair(eligibleCampaign({ recipientsReady: false }), REAL_CASE_RECIPIENTS)
    expect(decision.outcome).toBe('not-ready')
  })

  it('有 active processing lease（activeAttemptId 存在）→ active-processing-lease，明確的原因，不是籠統的「不合格」', () => {
    const decision = decideCampaignStatusRepair(
      eligibleCampaign({ activeAttemptId: 'attempt-in-flight' }),
      REAL_CASE_RECIPIENTS,
    )
    expect(decision.outcome).toBe('active-processing-lease')
    expect(decision.reason).toMatch(/activeAttemptId/)
  })

  it('有 active resolution lease（resolutionLeaseAttemptId 存在）→ active-resolution-lease', () => {
    const decision = decideCampaignStatusRepair(
      eligibleCampaign({ resolutionLeaseAttemptId: 'resolver-1' }),
      REAL_CASE_RECIPIENTS,
    )
    expect(decision.outcome).toBe('active-resolution-lease')
    expect(decision.reason).toMatch(/resolutionLeaseAttemptId/)
  })

  it('有 setup owner（createdByAttemptId 存在）→ has-setup-owner', () => {
    const decision = decideCampaignStatusRepair(
      eligibleCampaign({ createdByAttemptId: 'setup-owner-1' }),
      REAL_CASE_RECIPIENTS,
    )
    expect(decision.outcome).toBe('has-setup-owner')
    expect(decision.reason).toMatch(/createdByAttemptId/)
  })

  it.each(['queued', 'claimed', 'sending', 'delivery_unknown'] as const)(
    '收件人分佈中存在 %s（非完全終止狀態）→ non-terminal-recipient-present，即使其餘收件人分佈看起來完全正常',
    (forbiddenStatus) => {
      const decision = decideCampaignStatusRepair(eligibleCampaign(), [...REAL_CASE_RECIPIENTS, { status: forbiddenStatus }])
      expect(decision.outcome).toBe('non-terminal-recipient-present')
    },
  )

  it('任何一位收件人的狀態是無法辨識的畸形值 → invalid-recipient-status，fail closed，不會被忽略', () => {
    const decision = decideCampaignStatusRepair(eligibleCampaign(), [
      ...REAL_CASE_RECIPIENTS,
      { status: 'not-a-real-status' },
    ])
    expect(decision.outcome).toBe('invalid-recipient-status')
  })

  // round 26：leaseGeneration 缺失（undefined）本身是合法的 baseline
  // （readLeaseGeneration(undefined)===0，跟 decideAcquireCampaignLease 等
  // 既有函式一致的慣例），不是畸形值——這裡只列出真正不合法的值。
  it.each([[null], [''], [-1], [1.5], ['not-a-number'], [Number.MAX_SAFE_INTEGER + 10]] as const)(
    'leaseGeneration 是畸形值（%p）→ invalid-lease-generation，不論其餘欄位是否正常',
    (badGeneration) => {
      const decision = decideCampaignStatusRepair(eligibleCampaign({ leaseGeneration: badGeneration }), REAL_CASE_RECIPIENTS)
      expect(decision.outcome).toBe('invalid-lease-generation')
    },
  )

  it('已經是 partial，且 totals 已經跟真實分佈一致 → already-consistent（不是 eligible），這是修復成功後再次 dry-run 必須落在的結果，冪等性的核心', () => {
    const decision = decideCampaignStatusRepair(
      eligibleCampaign({
        status: 'partial',
        totals: { recipients: 116, sent: 113, failed: 3, exhausted: 0, deliveryUnknown: 0 },
      }),
      REAL_CASE_RECIPIENTS,
    )
    expect(decision.outcome).toBe('already-consistent')
    expect(decision.patch).toBeUndefined()
  })

  it('已經是 completed，且真實分佈也確實全部送達（totals 一致）→ already-consistent（狀態原本就正確，沒有落差可修）', () => {
    const allSent = Array.from({ length: 10 }, () => ({ status: 'sent' }))
    const decision = decideCampaignStatusRepair(
      eligibleCampaign({ totals: { recipients: 10, sent: 10, failed: 0, exhausted: 0, deliveryUnknown: 0 } }),
      allSent,
    )
    expect(decision.outcome).toBe('already-consistent')
  })

  it('target 權威狀態不是 partial（例如全部 exhausted，權威狀態變成 failed）→ 拒絕，這一輪只支援 completed → partial', () => {
    const allExhausted = Array.from({ length: 5 }, () => ({ status: 'exhausted' }))
    const decision = decideCampaignStatusRepair(eligibleCampaign(), allExhausted)
    expect(decision.authoritativeStatus).toBe('failed')
    expect(decision.outcome).toBe('unsupported-target-status')
  })

  it.each(['sending', 'failed', 'needs_review'] as const)(
    '目前的 status 是 %s（不是 completed），即使真實分佈重新計算出來會是 partial，也拒絕——這一輪的範圍明確是 completed → partial，不是任意 status 都能修',
    (currentStatus) => {
      const decision = decideCampaignStatusRepair(eligibleCampaign({ status: currentStatus }), REAL_CASE_RECIPIENTS)
      expect(decision.outcome).not.toBe('eligible')
      expect(decision.outcome).not.toBe('already-consistent')
      expect(decision.authoritativeStatus).toBe('partial')
    },
  )

  it('failed 剛好是 0（防禦性檢查：即使前面每一項都通過，target 也不會是 partial，這裡只是確認獨立防線本身邏輯正確）', () => {
    // 這個情境在目前的檢查順序下，會先被 unsupported-target-status 擋下
    // （target 不是 partial），no-failed-recipients 是同一個底層事實
    // 的第二道防線，兩者在正常情況下永遠同時成立，見程式碼裡的說明。
    const allSentNoFailed = Array.from({ length: 20 }, () => ({ status: 'sent' }))
    const decision = decideCampaignStatusRepair(
      eligibleCampaign({ status: 'completed', totals: { recipients: 20, sent: 20, failed: 0, exhausted: 0, deliveryUnknown: 0 } }),
      allSentNoFailed,
    )
    // sent===20, recipients===20，跟真實分佈一致 → already-consistent，
    // 不是 reject——這確認「completed 且真的全部送達」不會被誤判成需要修復。
    expect(decision.outcome).toBe('already-consistent')
  })
})

describe('repairCampaignStatusTx（round 26 新增：Firestore transaction 協調層——重新讀新鮮資料、重新跑一次全部 eligibility 檢查，只有仍然合格才寫入）', () => {
  const REAL_CASE_RECIPIENTS = [
    ...Array.from({ length: 113 }, () => ({ status: 'sent' })),
    ...Array.from({ length: 3 }, () => ({ status: 'failed' })),
  ]
  const extraFields = () => ({ updatedAt: 'server-timestamp', completedAt: 'deleted' })

  it('eligible → 真的呼叫 update()，patch 與 extraFields 都合併寫入，且完全沒有動過 recipients（這支協調層本來就不接觸 recipient 文件）', async () => {
    const campaignDoc = fakeDocTx({
      status: 'completed',
      recipientsReady: true,
      leaseGeneration: 7,
      totals: { recipients: 116, sent: 116, failed: 0, exhausted: 0, deliveryUnknown: 0 },
    })
    const decision = await repairCampaignStatusTx(campaignDoc, async () => REAL_CASE_RECIPIENTS, extraFields)
    expect(decision.outcome).toBe('eligible')
    expect(campaignDoc.updates.length).toBe(1)
    expect(campaignDoc.current()).toMatchObject({
      status: 'partial',
      'totals.sent': 113,
      'totals.failed': 3,
      updatedAt: 'server-timestamp',
      completedAt: 'deleted',
    })
  })

  it('already-consistent（重新讀取後發現已經修過）→ 不呼叫 update()，安全 no-op，可以放心重複呼叫 --confirm', async () => {
    const campaignDoc = fakeDocTx({
      status: 'partial',
      recipientsReady: true,
      leaseGeneration: 7,
      totals: { recipients: 116, sent: 113, failed: 3, exhausted: 0, deliveryUnknown: 0 },
    })
    const decision = await repairCampaignStatusTx(campaignDoc, async () => REAL_CASE_RECIPIENTS, extraFields)
    expect(decision.outcome).toBe('already-consistent')
    expect(campaignDoc.updates.length).toBe(0)
  })

  it('重新讀取時發現不再合格（例如租約在 dry-run 之後被取得）→ fail closed，不呼叫 update()', async () => {
    const campaignDoc = fakeDocTx({
      status: 'completed',
      recipientsReady: true,
      leaseGeneration: 7,
      activeAttemptId: 'someone-else-took-it',
      totals: { recipients: 116, sent: 116, failed: 0, exhausted: 0, deliveryUnknown: 0 },
    })
    const decision = await repairCampaignStatusTx(campaignDoc, async () => REAL_CASE_RECIPIENTS, extraFields)
    expect(decision.outcome).toBe('active-processing-lease')
    expect(campaignDoc.updates.length).toBe(0)
  })

  it('campaign 不存在 → campaign-not-found，不呼叫 update()', async () => {
    const campaignDoc = fakeDocTx(undefined)
    const decision = await repairCampaignStatusTx(campaignDoc, async () => REAL_CASE_RECIPIENTS, extraFields)
    expect(decision.outcome).toBe('campaign-not-found')
    expect(campaignDoc.updates.length).toBe(0)
  })
})
