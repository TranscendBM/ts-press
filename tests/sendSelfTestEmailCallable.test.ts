import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { CallableRequest } from 'firebase-functions/v2/https'
import { getFirestore } from '../functions/scripts/emulator-test-support.mjs'
import {
  MAINTENANCE_DOC_PATH,
  MAINTENANCE_PAUSED_FIELD,
  MAINTENANCE_PAUSED_MESSAGE,
} from '../shared/maintenance'

/**
 * round 29 新增：sendSelfTestEmail callable 的真實 Firestore emulator 整合
 * 測試——直接呼叫 production 使用的同一個 sendSelfTestEmailHandler（不透過
 * onCall() 的 HTTPS wrapper，理由跟 tests/maintenanceCallableGate.test.ts
 * 完全一樣，見該檔案開頭的說明）。
 *
 * ⚠️ 安全前提（不可妥協）：readSmtpPassword() 會用 @google-cloud/secret-manager
 * 的 SecretManagerServiceClient 打真正的 Google Cloud Secret Manager，
 * createTransport() 會用 nodemailer 建立真正的 SMTP 連線——這兩個模組必須
 * 在這裡完全 mock 掉，全程不能有任何真正的網路呼叫，否則可能打到正式
 * `ts-press` 專案的真正密鑰、或寄出真正的信。
 *
 * ⚠️ `vi.mock('nodemailer', ...)` / `vi.mock('@google-cloud/secret-manager', ...)`
 * 用「裸模組名稱」在這裡**不會生效**——這兩個套件只安裝在
 * functions/node_modules（這支測試檔案實體放在 root 的 tests/ 底下，root
 * node_modules 完全沒有這兩個套件，見 functions/scripts/emulator-test-support.mjs
 * 開頭對同一個限制的說明）。實測過：用裸名稱時，`vi.mock()` 呼叫本身不會
 * 報錯，但 functions/src/index.ts 自己 `import nodemailer from 'nodemailer'`／
 * `new SecretManagerServiceClient()` 拿到的仍然是「真的」套件——第一次寫這
 * 支測試檔案時就是這樣，結果 readSmtpPassword() 真的打了一次 Secret
 * Manager（收到 PERMISSION_DENIED，因為這裡的 GCLOUD_PROJECT 是假的
 * `ts-press-rules-ci`，不是正式的 `ts-press`，但這已經是一次不該發生的真實
 * 網路呼叫）。改用「相對路徑」（指向套件目錄本身，讓 Vite 依套件自己的
 * package.json 解析出實際 entry 檔案，解析結果跟 index.ts 用裸名稱解析出來
 * 的是同一個實體檔案）之後，才真正命中——已經用一個獨立的 scratch 測試
 * 具體驗證過 mock 被呼叫、`accessSecretVersion`／`createTransport` 的呼叫
 * 次數如預期，且 `firebase emulators:exec` 的輸出裡不再出現任何
 * PERMISSION_DENIED／網路相關的錯誤訊息。
 *
 * 用 vi.hoisted() 把 mock 函式本身（sendMailMock 等）拉到 vi.mock() 的
 * factory 可以存取的範圍（vi.mock 呼叫本身會被 hoist 到檔案最前面，早於
 * 一般的 top-level const）——⚠️ vi.hoisted() 的 callback 一樣不能參照任何
 * 一般的具名 import（例如 `createRequire`／`join`），那些 import 綁定在
 * vi.hoisted() 執行的當下還是 TDZ，會直接 ReferenceError；這裡完全不需要
 * 這類 import，只用得到 `vi`（vi.hoisted 本身允許，因為 `vitest` 這個
 * import 有特殊處理，見 vi.hoisted 呼叫周圍沒有任何其他 import 的用法）。
 * SecretManagerServiceClient 的假實作故意寫成 `class`（不是箭頭函式配
 * `.mockImplementation()`）——production 程式碼是 `new SecretManagerServiceClient()`，
 * 箭頭函式不能當建構函式用（`TypeError: ... is not a constructor`），也是
 * 實測後才發現、修正的。
 *
 * 這一切都必須放在 `await import('../functions/src/index')`（見 beforeAll）
 * 之前——跟 maintenanceCallableGate.test.ts 對匯入順序的要求一致：先讓
 * index.ts 自己的 `import nodemailer from 'nodemailer'`／
 * `new SecretManagerServiceClient()` 拿到的都是這裡的假實作，才動態載入
 * index.ts。
 *
 * ⚠️ 這裡故意不測試「維護旗標讀取失敗（read-error）」這個分支——跟
 * maintenanceCallableGate.test.ts 對其他六個受管制 callable 的處理方式
 * 一致：read-error 只在 tests/maintenance.test.ts 對純函式
 * isCampaignOperationsPaused() 覆蓋過，沒有辦法在不假造一個誤導性測試的
 * 前提下對著真實 emulator 逼真地模擬「Firestore 讀取本身失敗」，所以這裡
 * 不強行湊一個看起來合理但其實不代表真實情境的測試。
 */
const { sendMailMock, verifyMock, closeMock, createTransportMock, accessSecretVersionMock } =
  vi.hoisted(() => {
    const sendMailMock = vi.fn(async () => ({ messageId: 'fake-message-id' }))
    const verifyMock = vi.fn(async () => true)
    const closeMock = vi.fn()
    const createTransportMock = vi.fn(() => ({
      sendMail: sendMailMock,
      verify: verifyMock,
      close: closeMock,
    }))
    const accessSecretVersionMock = vi.fn(async () => [
      { payload: { data: Buffer.from('fake-smtp-password-never-real') } },
    ])
    return { sendMailMock, verifyMock, closeMock, createTransportMock, accessSecretVersionMock }
  })

// ⚠️ 必須用相對路徑，不能用裸模組名稱——見上方檔案開頭的說明。
vi.mock('../functions/node_modules/nodemailer', () => ({
  default: { createTransport: createTransportMock },
}))

vi.mock('../functions/node_modules/@google-cloud/secret-manager', () => ({
  SecretManagerServiceClient: class {
    accessSecretVersion = accessSecretVersionMock
  },
}))

const HOST = '127.0.0.1'
const PORT = 8080

let db: FirebaseFirestore.Firestore
let sendSelfTestEmailHandler: (request: CallableRequest<unknown>) => Promise<unknown>
let testSmtpConnectionHandler: (request: CallableRequest<unknown>) => Promise<unknown>

const SMTP_SETTINGS = {
  host: 'smtp.self-test-email.example.com',
  port: 587,
  user: 'sender@self-test-email.example.com',
  fromEmail: 'press@self-test-email.example.com',
  replyTo: 'press@self-test-email.example.com',
}

beforeAll(async () => {
  process.env.FIRESTORE_EMULATOR_HOST = `${HOST}:${PORT}`
  process.env.GCLOUD_PROJECT ??= 'ts-press-rules-ci'
  process.env.FIREBASE_CONFIG ??= JSON.stringify({
    storageBucket: 'ts-press-self-test-email-test.appspot.com',
  })

  const indexModule = await import('../functions/src/index')
  sendSelfTestEmailHandler = indexModule.sendSelfTestEmailHandler
  testSmtpConnectionHandler = indexModule.testSmtpConnectionHandler

  db = getFirestore()

  // 已設定好的 SMTP 主機設定——只影響非機密欄位；密碼一律走上面 mock 掉的
  // Secret Manager，永遠不會是真的密碼。
  await db.doc('settings/smtp').set(SMTP_SETTINGS)
})

// ⚠️ 這個 Firestore emulator 專案（ts-press-rules-ci）是跨測試檔案共用的
// ——`npm run test:rules` 一次 `firebase emulators:exec` 起一個模擬器，
// 所有 emulator 測試檔案依序（fileParallelism:false）跑在同一份 emulator
// 狀態上，不會每個檔案自動重置。這裡寫入的 settings/smtp 如果不清掉，會
// 汙染之後才執行、卻假設 settings/smtp 不存在的其他檔案（例如
// tests/maintenanceCallableGate.test.ts 的 testSmtpConnection 案例，
// 原本預期 readSmtpSettings() 因為缺 host/user 而 failed-precondition；
// 一旦被這裡殘留的 settings/smtp 蓋過去，就會繼續跑到
// readSmtpPassword()——那個檔案完全沒有 mock 掉 Secret Manager，會變成
// 真正的網路呼叫）。實測時就是先撞到這個汙染才發現的，所以這裡明確清掉，
// 不依賴檔案執行順序剛好把汙染排在後面。
afterAll(async () => {
  await db.doc('settings/smtp').delete()
})

afterEach(async () => {
  sendMailMock.mockClear()
  verifyMock.mockClear()
  closeMock.mockClear()
  createTransportMock.mockClear()
  accessSecretVersionMock.mockClear()
  await db.doc(MAINTENANCE_DOC_PATH).delete()
})

let userCounter = 0
/** 每個測試用不同的 email／uid，避免彼此的冷卻紀錄互相干擾。 */
async function makeActiveUser(role: 'specialist' | 'manager' | 'admin' = 'specialist') {
  userCounter += 1
  const email = `self-test-email-user-${userCounter}@x.com`
  const uid = `self-test-email-uid-${userCounter}`
  await db.collection('users').doc(email).set({ email, role, active: true })
  return { email, uid }
}

function buildRequest(uid: string | undefined, email: string | undefined, data: unknown = {}) {
  return {
    auth:
      email === undefined
        ? undefined
        : { uid, token: { email, email_verified: true } },
    data,
  } as unknown as CallableRequest<unknown>
}

/** 提交前審查新增：確認三個 mock 全部完全沒被呼叫過——不是只看 sendMail。 */
function expectZeroSmtpAndSecretCalls() {
  expect(accessSecretVersionMock).not.toHaveBeenCalled()
  expect(createTransportMock).not.toHaveBeenCalled()
  expect(sendMailMock).not.toHaveBeenCalled()
}

describe('sendSelfTestEmailHandler（真實 Firestore emulator，SMTP／Secret Manager 全程 mock）', () => {
  it('未登入（auth undefined）→ permission-denied，「請先登入。」，且三個 mock 都完全沒被呼叫過', async () => {
    await expect(sendSelfTestEmailHandler(buildRequest(undefined, undefined))).rejects.toMatchObject({
      code: 'permission-denied',
      message: '請先登入。',
    })
    expectZeroSmtpAndSecretCalls()
  })

  it('users/{email} 文件不存在 → permission-denied，「這個帳號未被授權使用本系統。」，三個 mock 都是 0', async () => {
    const email = 'self-test-email-no-user-doc@x.com'
    await expect(
      sendSelfTestEmailHandler(buildRequest('some-uid', email)),
    ).rejects.toMatchObject({
      code: 'permission-denied',
      message: '這個帳號未被授權使用本系統。',
    })
    expectZeroSmtpAndSecretCalls()
  })

  it('users/{email} 文件存在但 active:false → permission-denied，同一個原因，三個 mock 都是 0', async () => {
    const email = 'self-test-email-inactive@x.com'
    await db.collection('users').doc(email).set({ email, role: 'specialist', active: false })
    await expect(
      sendSelfTestEmailHandler(buildRequest('some-uid', email)),
    ).rejects.toMatchObject({
      code: 'permission-denied',
      message: '這個帳號未被授權使用本系統。',
    })
    expectZeroSmtpAndSecretCalls()
  })

  it('token 沒有 email 欄位 → permission-denied，「請先登入。」（跟完全沒登入視為同一種情況），三個 mock 都是 0', async () => {
    const request = {
      auth: { uid: 'some-uid', token: { email_verified: true } },
      data: {},
    } as unknown as CallableRequest<unknown>
    await expect(sendSelfTestEmailHandler(request)).rejects.toMatchObject({
      code: 'permission-denied',
      message: '請先登入。',
    })
    expectZeroSmtpAndSecretCalls()
  })

  // 提交前審查新增：token 的 email 本身格式不合法（authorize() 只
  // .toLowerCase()，不驗證格式，所以能通過 authorize()，但必須被
  // validateSelfTestEmailRecipient() 這道新的最後防線擋下）——種一筆
  // users 文件、key 精確等於這個帶前後空白的字串，讓 authorize() 本身
  // 成功，具體證明擋下它的是新加的驗證，不是 authorize()。
  it('token email 帶前後空白（authorize() 能通過，但新的收件人驗證會擋下）→ internal，三個 mock 都是 0', async () => {
    const weirdEmail = ' self-test-email-whitespace@x.com '
    await db.collection('users').doc(weirdEmail).set({ email: weirdEmail, role: 'specialist', active: true })
    const request = {
      auth: { uid: 'weird-uid', token: { email: weirdEmail, email_verified: true } },
      data: {},
    } as unknown as CallableRequest<unknown>
    await expect(sendSelfTestEmailHandler(request)).rejects.toMatchObject({ code: 'internal' })
    expectZeroSmtpAndSecretCalls()

    const cooldownSnap = await db.collection('selfTestEmailCooldowns').doc('weird-uid').get()
    expect(cooldownSnap.exists).toBe(false)
  })

  it('任何 active 的一般角色（非 admin）都能成功寄信給自己——這是這個 callable 存在的目的；明確驗證 accessSecretVersion／createTransport／sendMail 三個 mock 都真的被呼叫過', async () => {
    const { email, uid } = await makeActiveUser('specialist')
    const result = await sendSelfTestEmailHandler(buildRequest(uid, email))
    expect(result).toEqual({ ok: true })
    expect(accessSecretVersionMock).toHaveBeenCalledTimes(1)
    expect(createTransportMock).toHaveBeenCalledTimes(1)
    expect(sendMailMock).toHaveBeenCalledTimes(1)
    expect(sendMailMock.mock.calls[0][0]).toMatchObject({ to: email })
  })

  it('最重要的一項測試：request.data 帶惡意的 to／recipient／email 欄位，實際寄出的 to 仍然精確等於呼叫者自己的 auth email，絕不是攻擊者塞進去的值', async () => {
    const { email, uid } = await makeActiveUser('specialist')
    const attackerPayload = {
      to: 'attacker@evil.com',
      recipient: 'attacker@evil.com',
      email: 'attacker@evil.com',
    }
    const result = await sendSelfTestEmailHandler(buildRequest(uid, email, attackerPayload))
    expect(result).toEqual({ ok: true })
    expect(accessSecretVersionMock).toHaveBeenCalledTimes(1)
    expect(createTransportMock).toHaveBeenCalledTimes(1)
    expect(sendMailMock).toHaveBeenCalledTimes(1)
    const mailOptions = sendMailMock.mock.calls[0][0] as { to: string }
    expect(mailOptions.to).toBe(email)
    expect(mailOptions.to).not.toBe('attacker@evil.com')
  })

  it('維護模式開啟（campaignOperationsPaused:true）→ failed-precondition + MAINTENANCE_PAUSED_MESSAGE，冷卻從未被佔用，三個 mock 都是 0', async () => {
    const { email, uid } = await makeActiveUser('specialist')
    await db.doc(MAINTENANCE_DOC_PATH).set({ [MAINTENANCE_PAUSED_FIELD]: true })

    await expect(sendSelfTestEmailHandler(buildRequest(uid, email))).rejects.toMatchObject({
      code: 'failed-precondition',
      message: MAINTENANCE_PAUSED_MESSAGE,
    })
    expectZeroSmtpAndSecretCalls()

    const cooldownSnap = await db.collection('selfTestEmailCooldowns').doc(uid).get()
    expect(cooldownSnap.exists).toBe(false)
  })

  it('維護旗標欄位是 malformed（例如字串）→ 一律 fail closed，視為維護中一併擋下，三個 mock 都是 0', async () => {
    const { email, uid } = await makeActiveUser('specialist')
    await db.doc(MAINTENANCE_DOC_PATH).set({ [MAINTENANCE_PAUSED_FIELD]: 'yes' })

    await expect(sendSelfTestEmailHandler(buildRequest(uid, email))).rejects.toMatchObject({
      code: 'failed-precondition',
      message: MAINTENANCE_PAUSED_MESSAGE,
    })
    expectZeroSmtpAndSecretCalls()
  })

  it('維護模式關閉（欄位不存在）→ 放行，正常寄出（既有行為不受影響），三個 mock 都真的被呼叫過', async () => {
    const { email, uid } = await makeActiveUser('specialist')
    // afterEach 已經把 MAINTENANCE_DOC_PATH 刪掉，這裡明確再次確認欄位缺失
    // 這個情況本身也會放行，不只是「false」才放行。
    await expect(sendSelfTestEmailHandler(buildRequest(uid, email))).resolves.toEqual({ ok: true })
    expect(accessSecretVersionMock).toHaveBeenCalledTimes(1)
    expect(createTransportMock).toHaveBeenCalledTimes(1)
    expect(sendMailMock).toHaveBeenCalledTimes(1)
  })

  it('提交前審查新增：冷卻中的請求（已經成功寄過一次，緊接著在冷卻視窗內再打一次）→ resource-exhausted，且這次被擋下的呼叫三個 mock 都是 0（不是「整體呼叫次數」，是這次呼叫本身完全沒有碰到 Secret Manager／SMTP）', async () => {
    const { email, uid } = await makeActiveUser('specialist')
    await expect(sendSelfTestEmailHandler(buildRequest(uid, email))).resolves.toEqual({ ok: true })
    expect(sendMailMock).toHaveBeenCalledTimes(1)

    accessSecretVersionMock.mockClear()
    createTransportMock.mockClear()
    sendMailMock.mockClear()

    await expect(sendSelfTestEmailHandler(buildRequest(uid, email))).rejects.toMatchObject({
      code: 'resource-exhausted',
    })
    expectZeroSmtpAndSecretCalls()
  })

  it('同一位使用者在冷卻視窗內兩次併發呼叫：恰好一次成功（sendMail 恰好被呼叫一次），另一次被 resource-exhausted 拒絕', async () => {
    const { email, uid } = await makeActiveUser('specialist')

    const [first, second] = await Promise.allSettled([
      sendSelfTestEmailHandler(buildRequest(uid, email)),
      sendSelfTestEmailHandler(buildRequest(uid, email)),
    ])

    const results = [first, second]
    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected')

    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect((fulfilled[0] as PromiseFulfilledResult<unknown>).value).toEqual({ ok: true })
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: 'resource-exhausted' })

    expect(sendMailMock).toHaveBeenCalledTimes(1)
  })

  it('SMTP 寄送失敗（sendMail 拒絕，錯誤內容故意「下毒」含真實 host/IP/port/帳號/stack）→ failed-precondition，訊息不是維護訊息、也完全不含任何原始錯誤字串，且冷卻額度仍然已經被佔用（不退還）——同一位使用者立刻再試一次會被 resource-exhausted 擋下', async () => {
    const { email, uid } = await makeActiveUser('specialist')
    const poisonedError = Object.assign(new Error('connect ECONNREFUSED 203.0.113.99:587'), {
      code: 'ECONNREFUSED',
      stack:
        'Error: connect ECONNREFUSED 203.0.113.99:587\n' +
        '    at TCPConnectWrap.afterConnect [as oncomplete] (net.js:1161:16)\n' +
        `    at SMTPConnection (smtp.self-test-email.example.com user=${SMTP_SETTINGS.user})`,
    })
    sendMailMock.mockRejectedValueOnce(poisonedError)

    let caught: unknown
    try {
      await sendSelfTestEmailHandler(buildRequest(uid, email))
    } catch (err) {
      caught = err
    }
    expect(caught).toMatchObject({ code: 'failed-precondition' })
    const failureMessage = (caught as { message?: string }).message ?? ''
    expect(failureMessage).not.toBe(MAINTENANCE_PAUSED_MESSAGE)
    // 最重要的斷言：client 端實際收到的訊息完全不含任何原始錯誤字串——
    // 不是 message 本身安全就好，是真的走過 sendSelfTestEmailHandler 的
    // catch block、describeSelfTestEmailSendError() 之後仍然乾淨。
    for (const poison of ['203.0.113.99', ':587', SMTP_SETTINGS.user, 'smtp.self-test-email.example.com', 'TCPConnectWrap', 'net.js']) {
      expect(failureMessage).not.toContain(poison)
    }

    // 冷卻沒有退還：緊接著再打一次（sendMail 這次會成功，如果冷卻被錯誤地
    // 退還的話），應該還是被冷卻擋下，不是又寄出第二封信。
    await expect(sendSelfTestEmailHandler(buildRequest(uid, email))).rejects.toMatchObject({
      code: 'resource-exhausted',
    })

    // 全程只有第一次真正呼叫了 sendMail（那一次失敗），後面兩次都被冷卻擋在
    // SMTP 之前，sendMail 呼叫總次數應該恰好是 1。
    expect(sendMailMock).toHaveBeenCalledTimes(1)
  })

  it('regression：既有的 testSmtpConnectionHandler 完全不受影響，admin-only 的檢查依然生效（非 admin 呼叫仍然是 permission-denied）', async () => {
    const { email, uid } = await makeActiveUser('specialist')
    await expect(
      testSmtpConnectionHandler(buildRequest(uid, email)),
    ).rejects.toMatchObject({ code: 'permission-denied', message: '只有管理員可以執行這個動作。' })
  })
})
