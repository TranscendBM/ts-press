import { describe, expect, it } from 'vitest'
import {
  classifySelfTestEmailSendError,
  decideSelfTestEmailCooldown,
  describeSelfTestEmailSendError,
  maskEmailForDisplay,
  SELF_TEST_EMAIL_COOLDOWN_MS,
  SELF_TEST_EMAIL_UNKNOWN_SEND_ERROR_MESSAGE,
  validateSelfTestEmailRecipient,
} from '../shared/selfTestEmail'

/**
 * round 29 新增：shared/selfTestEmail.ts 的純函式單元測試——不連線
 * Firestore、不建立任何 SMTP 連線，覆蓋 decideSelfTestEmailCooldown／
 * maskEmailForDisplay 的每一種分支。真正的 callable（sendSelfTestEmail，
 * 含 Firestore transaction、SMTP mock）在 tests/sendSelfTestEmailCallable.test.ts
 * 用真實 Firestore emulator 驗證，不在這裡重複。
 */
describe('SELF_TEST_EMAIL_COOLDOWN_MS', () => {
  it('是 60 秒（毫秒）', () => {
    expect(SELF_TEST_EMAIL_COOLDOWN_MS).toBe(60_000)
  })
})

describe('decideSelfTestEmailCooldown', () => {
  const NOW = 1_000_000

  it('從未寄送過（undefined）→ claim', () => {
    expect(decideSelfTestEmailCooldown(undefined, NOW, SELF_TEST_EMAIL_COOLDOWN_MS)).toEqual({
      outcome: 'claim',
    })
  })

  it.each([
    ['null', null],
    ['字串', '1000'],
    ['物件', { ms: 1000 }],
    ['陣列', [1000]],
    ['布林值', true],
    ['NaN', NaN],
    ['負數', -1],
    ['Infinity', Infinity],
    ['-Infinity', -Infinity],
    ['非整數（1000.5）', 1000.5],
    ['超過 Number.MAX_SAFE_INTEGER', Number.MAX_SAFE_INTEGER + 10],
  ])('fail-open：畸形值（%s）視為「從未寄送過」→ claim，不會把使用者永久鎖住', (_label, malformed) => {
    expect(decideSelfTestEmailCooldown(malformed, NOW, SELF_TEST_EMAIL_COOLDOWN_MS)).toEqual({
      outcome: 'claim',
    })
  })

  describe('提交前審查修正：未來時間戳記（rawLastSentAtMs 本身合法，但晚於 nowMs）', () => {
    it('未來 1 天（仍在安全整數範圍內，例如 Cloud Functions instance 時鐘飄移）→ cooldown，retryAfterMs clamp 成 cooldownMs 本身，不是天文數字', () => {
      const oneDayInFuture = NOW + 24 * 60 * 60 * 1000
      expect(decideSelfTestEmailCooldown(oneDayInFuture, NOW, SELF_TEST_EMAIL_COOLDOWN_MS)).toEqual({
        outcome: 'cooldown',
        retryAfterMs: SELF_TEST_EMAIL_COOLDOWN_MS,
      })
    })

    it('輕微時鐘飄移（未來 500 毫秒，模擬兩個 Function instance 時鐘幾乎同步但有些微誤差）→ cooldown，retryAfterMs 一樣是 cooldownMs，不是負數或荒謬的小數', () => {
      const slightlyInFuture = NOW + 500
      expect(decideSelfTestEmailCooldown(slightlyInFuture, NOW, SELF_TEST_EMAIL_COOLDOWN_MS)).toEqual({
        outcome: 'cooldown',
        retryAfterMs: SELF_TEST_EMAIL_COOLDOWN_MS,
      })
    })

    it('較大時鐘飄移（未來 10 分鐘）→ 同樣 clamp 成 cooldownMs，不會隨著飄移幅度線性增加等待時間', () => {
      const tenMinutesInFuture = NOW + 10 * 60 * 1000
      expect(decideSelfTestEmailCooldown(tenMinutesInFuture, NOW, SELF_TEST_EMAIL_COOLDOWN_MS)).toEqual({
        outcome: 'cooldown',
        retryAfterMs: SELF_TEST_EMAIL_COOLDOWN_MS,
      })
    })

    it('恰好等於 nowMs（不早於也不晚於）→ 走正常路徑，不是「未來」分支，retryAfterMs 等於整個冷卻視窗', () => {
      expect(decideSelfTestEmailCooldown(NOW, NOW, SELF_TEST_EMAIL_COOLDOWN_MS)).toEqual({
        outcome: 'cooldown',
        retryAfterMs: SELF_TEST_EMAIL_COOLDOWN_MS,
      })
    })
  })

  describe('retryAfterMs 邊界：任何回傳 cooldown 的情況，retryAfterMs 必須介於 1 與 cooldownMs 之間', () => {
    it('剛進入冷卻視窗（1 毫秒前）→ retryAfterMs 幾乎等於整個冷卻視窗（cooldownMs - 1）', () => {
      const decision = decideSelfTestEmailCooldown(NOW - 1, NOW, SELF_TEST_EMAIL_COOLDOWN_MS)
      expect(decision).toEqual({ outcome: 'cooldown', retryAfterMs: SELF_TEST_EMAIL_COOLDOWN_MS - 1 })
      if (decision.outcome === 'cooldown') {
        expect(decision.retryAfterMs).toBeGreaterThanOrEqual(1)
        expect(decision.retryAfterMs).toBeLessThanOrEqual(SELF_TEST_EMAIL_COOLDOWN_MS)
      }
    })

    it('即將脫離冷卻視窗（cooldownMs - 1 毫秒前）→ retryAfterMs 恰好是 1', () => {
      const decision = decideSelfTestEmailCooldown(
        NOW - (SELF_TEST_EMAIL_COOLDOWN_MS - 1),
        NOW,
        SELF_TEST_EMAIL_COOLDOWN_MS,
      )
      expect(decision).toEqual({ outcome: 'cooldown', retryAfterMs: 1 })
    })
  })

  describe('提交前審查新增：nowMs／cooldownMs 是呼叫端內部契約，不合法時必須丟程式錯誤', () => {
    it('nowMs 是負數 → 丟錯', () => {
      expect(() => decideSelfTestEmailCooldown(undefined, -1, SELF_TEST_EMAIL_COOLDOWN_MS)).toThrow(
        /nowMs/,
      )
    })

    it('nowMs 是 NaN → 丟錯', () => {
      expect(() => decideSelfTestEmailCooldown(undefined, NaN, SELF_TEST_EMAIL_COOLDOWN_MS)).toThrow(
        /nowMs/,
      )
    })

    it('cooldownMs 是 0 → 丟錯（必須是正數，冷卻視窗長度不能是零或負數）', () => {
      expect(() => decideSelfTestEmailCooldown(undefined, NOW, 0)).toThrow(/cooldownMs/)
    })

    it('cooldownMs 是負數 → 丟錯', () => {
      expect(() => decideSelfTestEmailCooldown(undefined, NOW, -1)).toThrow(/cooldownMs/)
    })

    it('cooldownMs 是非整數 → 丟錯', () => {
      expect(() => decideSelfTestEmailCooldown(undefined, NOW, 1000.5)).toThrow(/cooldownMs/)
    })
  })

  it('剛好在冷卻視窗內（距離上次寄送 1 秒，冷卻視窗 60 秒）→ cooldown，retryAfterMs 是正數且合理', () => {
    const lastSentAtMs = NOW - 1_000
    const decision = decideSelfTestEmailCooldown(lastSentAtMs, NOW, SELF_TEST_EMAIL_COOLDOWN_MS)
    expect(decision).toEqual({ outcome: 'cooldown', retryAfterMs: 59_000 })
  })

  it('距離上次寄送剛好等於冷卻視窗長度（邊界）→ claim（>= 就算通過，不用「超過」才行）', () => {
    const lastSentAtMs = NOW - SELF_TEST_EMAIL_COOLDOWN_MS
    expect(decideSelfTestEmailCooldown(lastSentAtMs, NOW, SELF_TEST_EMAIL_COOLDOWN_MS)).toEqual({
      outcome: 'claim',
    })
  })

  it('距離上次寄送超過冷卻視窗長度 → claim', () => {
    const lastSentAtMs = NOW - SELF_TEST_EMAIL_COOLDOWN_MS - 1
    expect(decideSelfTestEmailCooldown(lastSentAtMs, NOW, SELF_TEST_EMAIL_COOLDOWN_MS)).toEqual({
      outcome: 'claim',
    })
  })

  it('上次寄送時間剛好等於現在（0 毫秒前）→ cooldown，retryAfterMs 等於整個冷卻視窗長度', () => {
    expect(decideSelfTestEmailCooldown(NOW, NOW, SELF_TEST_EMAIL_COOLDOWN_MS)).toEqual({
      outcome: 'cooldown',
      retryAfterMs: SELF_TEST_EMAIL_COOLDOWN_MS,
    })
  })

  it('0 是合法的時間戳記（不是被 !rawLastSentAtMs 誤判成「沒有值」）→ 距離現在很久時一樣是 claim', () => {
    expect(decideSelfTestEmailCooldown(0, NOW, SELF_TEST_EMAIL_COOLDOWN_MS)).toEqual({
      outcome: 'claim',
    })
  })

  it('0 是合法的時間戳記，距離現在很近時一樣會進入 cooldown', () => {
    expect(decideSelfTestEmailCooldown(0, 5_000, SELF_TEST_EMAIL_COOLDOWN_MS)).toEqual({
      outcome: 'cooldown',
      retryAfterMs: 55_000,
    })
  })
})

describe('maskEmailForDisplay', () => {
  it('一般範例：alice@example.com（local-part 5 個字元）→ 保留第一個字元，其餘 4 個換成 *', () => {
    expect(maskEmailForDisplay('alice@example.com')).toBe('a****@example.com')
  })

  it('local-part 只有一個字元：a@example.com → a*@example.com（仍然至少遮罩一個字元）', () => {
    expect(maskEmailForDisplay('a@example.com')).toBe('a*@example.com')
  })

  it('local-part 兩個字元：ab@example.com → a*@example.com', () => {
    expect(maskEmailForDisplay('ab@example.com')).toBe('a*@example.com')
  })

  it('沒有 @ → ***', () => {
    expect(maskEmailForDisplay('no-at-sign')).toBe('***')
  })

  it('空字串 → ***', () => {
    expect(maskEmailForDisplay('')).toBe('***')
  })

  it('local-part 是空字串（@ 在最前面）→ ***', () => {
    expect(maskEmailForDisplay('@example.com')).toBe('***')
  })

  it('網域維持原樣，不做任何遮罩', () => {
    expect(maskEmailForDisplay('someone@sub.example.co')).toBe('s******@sub.example.co')
  })
})

describe('validateSelfTestEmailRecipient（提交前審查新增：寄信前最後一道收件人驗證）', () => {
  const CANONICAL = 'alice@example.com'

  it('合法且與 canonical 一致 → ok:true', () => {
    expect(validateSelfTestEmailRecipient(CANONICAL, CANONICAL)).toEqual({
      ok: true,
      email: CANONICAL,
    })
  })

  it('空字串 → ok:false, reason:empty', () => {
    expect(validateSelfTestEmailRecipient('', CANONICAL)).toEqual({ ok: false, reason: 'empty' })
  })

  it('前面有空白 → ok:false, reason:whitespace', () => {
    expect(validateSelfTestEmailRecipient(' alice@example.com', CANONICAL)).toEqual({
      ok: false,
      reason: 'whitespace',
    })
  })

  it('後面有空白 → ok:false, reason:whitespace', () => {
    expect(validateSelfTestEmailRecipient('alice@example.com ', CANONICAL)).toEqual({
      ok: false,
      reason: 'whitespace',
    })
  })

  it('中間含 \\n（不在前後，避免被 trim 檢查先攔截）→ ok:false, reason:control-characters', () => {
    expect(validateSelfTestEmailRecipient('alice\n@example.com', CANONICAL)).toEqual({
      ok: false,
      reason: 'control-characters',
    })
  })

  it('含 \\r → ok:false, reason:control-characters', () => {
    expect(validateSelfTestEmailRecipient('alice\r@example.com', CANONICAL)).toEqual({
      ok: false,
      reason: 'control-characters',
    })
  })

  it('沒有 @ → ok:false, reason:invalid-format', () => {
    expect(validateSelfTestEmailRecipient('not-an-email', CANONICAL)).toEqual({
      ok: false,
      reason: 'invalid-format',
    })
  })

  it('網域沒有點（沒有 TLD）→ ok:false, reason:invalid-format', () => {
    expect(validateSelfTestEmailRecipient('alice@localhost', CANONICAL)).toEqual({
      ok: false,
      reason: 'invalid-format',
    })
  })

  it('含空白字元（非前後空白，中間有空白）→ ok:false, reason:invalid-format', () => {
    expect(validateSelfTestEmailRecipient('ali ce@example.com', CANONICAL)).toEqual({
      ok: false,
      reason: 'invalid-format',
    })
  })

  it('格式合法，但跟 canonical email 不一致 → ok:false, reason:mismatch', () => {
    expect(validateSelfTestEmailRecipient('bob@example.com', CANONICAL)).toEqual({
      ok: false,
      reason: 'mismatch',
    })
  })
})

describe('classifySelfTestEmailSendError／describeSelfTestEmailSendError（提交前審查新增：不得洩漏原始錯誤內容）', () => {
  it('code:EAUTH → 分類成 auth，固定訊息不含 code/message', () => {
    expect(classifySelfTestEmailSendError({ code: 'EAUTH' })).toBe('auth')
  })

  it('code:ECONNECTION/ETIMEDOUT/ESOCKET/ECONNREFUSED → 分類成 connection', () => {
    expect(classifySelfTestEmailSendError({ code: 'ECONNECTION' })).toBe('connection')
    expect(classifySelfTestEmailSendError({ code: 'ETIMEDOUT' })).toBe('connection')
    expect(classifySelfTestEmailSendError({ code: 'ESOCKET' })).toBe('connection')
    expect(classifySelfTestEmailSendError({ code: 'ECONNREFUSED' })).toBe('connection')
  })

  it('code:EENVELOPE/EMESSAGE，或 responseCode >= 500 → 分類成 rejected', () => {
    expect(classifySelfTestEmailSendError({ code: 'EENVELOPE' })).toBe('rejected')
    expect(classifySelfTestEmailSendError({ code: 'EMESSAGE' })).toBe('rejected')
    expect(classifySelfTestEmailSendError({ responseCode: 550 })).toBe('rejected')
  })

  it('沒有 code、或不認得的 code → 分類成 unknown', () => {
    expect(classifySelfTestEmailSendError({})).toBe('unknown')
    expect(classifySelfTestEmailSendError(new Error('some random error'))).toBe('unknown')
    expect(classifySelfTestEmailSendError({ code: 'ETOTALLY-MADE-UP' })).toBe('unknown')
  })

  it('未知錯誤精確等於指定的固定文案', () => {
    expect(describeSelfTestEmailSendError({})).toBe(SELF_TEST_EMAIL_UNKNOWN_SEND_ERROR_MESSAGE)
    expect(SELF_TEST_EMAIL_UNKNOWN_SEND_ERROR_MESSAGE).toBe('測試信寄送失敗，請稍後再試或聯絡管理員')
  })

  // 最重要的一組測試：餵入包含 host/IP/port/username/stack/密鑰 字樣的
  // 「攻擊性」錯誤物件，逐一確認 describeSelfTestEmailSendError() 的回傳值
  // 完全不含這些字串——不管錯誤的 message／stack 裡塞了什麼，輸出永遠是
  // 固定表格裡的其中一句。
  const POISONED_ERRORS: Array<[string, unknown]> = [
    [
      'EAUTH，message 含帳號密碼',
      {
        code: 'EAUTH',
        message: 'Invalid login: 535 5.7.8 Username=admin@ts-press.example.com Password=Sup3rSecr3t!',
        stack: 'Error: Invalid login\n    at SMTPConnection._formatError (/app/node_modules/nodemailer/lib/smtp-connection/index.js:783:19)',
      },
    ],
    [
      'ECONNREFUSED，message 含真實 host:port',
      {
        code: 'ECONNREFUSED',
        message: 'connect ECONNREFUSED 203.0.113.42:587',
        stack: 'Error: connect ECONNREFUSED 203.0.113.42:587\n    at TCPConnectWrap.afterConnect',
      },
    ],
    [
      'ETIMEDOUT，message 含內部主機名稱',
      {
        code: 'ETIMEDOUT',
        message: 'Connection timeout to smtp-internal.ts-press.corp:25',
      },
    ],
    [
      '未分類錯誤，message 含 secret/token 字樣',
      {
        message: 'secretClient.accessSecretVersion failed: token=ya29.a0AfH6SMB_SECRET_VALUE',
        stack: 'at SecretManagerServiceClient.accessSecretVersion (/app/node_modules/@google-cloud/secret-manager/build/src/index.js:120:11)',
      },
    ],
  ]

  const POISON_STRINGS = [
    'ts-press.example.com',
    'Sup3rSecr3t!',
    '203.0.113.42',
    ':587',
    'smtp-internal.ts-press.corp',
    'ya29.a0AfH6SMB_SECRET_VALUE',
    'nodemailer/lib',
    '@google-cloud/secret-manager',
    'admin@ts-press.example.com',
  ]

  it.each(POISONED_ERRORS)('%s → 回傳的固定訊息完全不含任何原始錯誤字串', (_label, poisonedErr) => {
    const result = describeSelfTestEmailSendError(poisonedErr)
    for (const poison of POISON_STRINGS) {
      expect(result).not.toContain(poison)
    }
    // 而且結果必須是表格裡列出的其中一句固定文案，不是任何其他自由格式的字串。
    expect([
      '測試信寄送失敗：寄信伺服器驗證失敗，請聯絡管理員確認寄信設定。',
      '測試信寄送失敗：目前無法連線到寄信伺服器，請稍後再試或聯絡管理員。',
      '測試信寄送失敗：寄信伺服器拒絕了這封信，請聯絡管理員確認寄信設定。',
      SELF_TEST_EMAIL_UNKNOWN_SEND_ERROR_MESSAGE,
    ]).toContain(result)
  })
})
