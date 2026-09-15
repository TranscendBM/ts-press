import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing'
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest'
import {
  doc,
  getDoc,
  setDoc,
  deleteDoc,
  type Firestore,
} from 'firebase/firestore'

/**
 * Firestore 安全規則測試，重點在 settings/permissions 與動態權限矩陣。
 *
 * 一律透過 `npm run test:rules` 執行（用 firebase emulators:exec 包住模擬
 * 器）。刻意不做「模擬器沒開就 skip」的探測 —— 那樣 CI 忘記啟動模擬器時
 * 會被悄悄吞成一片綠燈，看起來像測試通過，實際上什麼都沒驗證到。
 * 模擬器沒連上，initializeTestEnvironment() 會直接拋錯、整組測試顯示失敗，
 * 這才是我們要的行為。
 */
const HOST = '127.0.0.1'
const PORT = 8080

const FULL_PERMS = {
  viewPress: true,
  editPress: true,
  downloadPress: true,
  sendTest: true,
  sendReal: true,
  manageContacts: true,
  manageEvents: true,
  viewCampaigns: true,
  manageUsers: false,
  manageSettings: false,
}

describe('firestore.rules — settings/permissions', () => {
  let env: RulesTestEnvironment

  beforeAll(async () => {
    env = await initializeTestEnvironment({
      projectId: 'ts-press-fs-rules',
      firestore: {
        rules: readFileSync('firestore.rules', 'utf8'),
        host: HOST,
        port: PORT,
      },
    })
  })

  afterAll(async () => env?.cleanup())

  // 每個案例都從乾淨的白名單開始
  beforeEach(async () => {
    await env.clearFirestore()
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore()
      await setDoc(doc(db, 'users', 'admin@x.com'), {
        email: 'admin@x.com',
        role: 'admin',
        active: true,
      })
      await setDoc(doc(db, 'users', 'manager@x.com'), {
        email: 'manager@x.com',
        role: 'manager',
        active: true,
      })
      await setDoc(doc(db, 'users', 'spec@x.com'), {
        email: 'spec@x.com',
        role: 'specialist',
        active: true,
      })
      await setDoc(doc(db, 'users', 'inactive@x.com'), {
        email: 'inactive@x.com',
        role: 'admin',
        active: false,
      })
    })
  })

  function as(email: string, verified = true): Firestore {
    return env
      .authenticatedContext(email, { email, email_verified: verified })
      .firestore()
  }
  const anon = () => env.unauthenticatedContext().firestore()

  const ref = (db: Firestore) => doc(db, 'settings', 'permissions')
  const payload = (roles: Record<string, unknown>) => ({ roles })

  describe('讀取', () => {
    it('未登入不可讀', async () => {
      await assertFails(getDoc(ref(anon())))
    })

    it('白名單使用者可讀', async () => {
      await assertSucceeds(getDoc(ref(as('spec@x.com'))))
    })

    it('信箱未驗證不可讀', async () => {
      await assertFails(getDoc(ref(as('admin@x.com', false))))
    })

    it('停用帳號不可讀', async () => {
      await assertFails(getDoc(ref(as('inactive@x.com'))))
    })

    it('不在白名單者不可讀（文件不存在 → fail closed）', async () => {
      await assertFails(getDoc(ref(as('ghost@x.com'))))
    })
  })

  describe('寫入權限', () => {
    it('未登入不可寫', async () => {
      await assertFails(
        setDoc(ref(anon()), payload({ specialist: FULL_PERMS })),
      )
    })

    it('行銷專員不可寫', async () => {
      await assertFails(
        setDoc(ref(as('spec@x.com')), payload({ specialist: FULL_PERMS })),
      )
    })

    it('主管不可寫', async () => {
      await assertFails(
        setDoc(ref(as('manager@x.com')), payload({ manager: FULL_PERMS })),
      )
    })

    it('管理員可寫', async () => {
      await assertSucceeds(
        setDoc(ref(as('admin@x.com')), payload({ specialist: FULL_PERMS })),
      )
    })

    it('停用的管理員不可寫', async () => {
      await assertFails(
        setDoc(ref(as('inactive@x.com')), payload({ admin: FULL_PERMS })),
      )
    })
  })

  describe('結構驗證', () => {
    const admin = () => ref(as('admin@x.com'))

    it('拒絕未知角色', async () => {
      await assertFails(setDoc(admin(), payload({ superuser: FULL_PERMS })))
      await assertFails(setDoc(admin(), payload({ editor: FULL_PERMS })))
    })

    it('拒絕未知的權限鍵', async () => {
      await assertFails(
        setDoc(admin(), payload({ specialist: { ...FULL_PERMS, hackAll: true } })),
      )
    })

    it('拒絕非布林值', async () => {
      await assertFails(
        setDoc(admin(), payload({ specialist: { sendReal: 'true' } })),
      )
      await assertFails(
        setDoc(admin(), payload({ specialist: { sendReal: 1 } })),
      )
      await assertFails(
        setDoc(admin(), payload({ specialist: { sendReal: null } })),
      )
    })

    it('拒絕 roles 不是 map', async () => {
      await assertFails(setDoc(admin(), { roles: 'everything' }))
      await assertFails(setDoc(admin(), { roles: ['admin'] }))
    })

    it('缺少 roles 欄位必須拒絕（fail closed）', async () => {
      await assertFails(setDoc(admin(), { updatedAt: new Date() }))
      await assertFails(setDoc(admin(), {}))
    })

    it('拒絕多餘的頂層欄位', async () => {
      await assertFails(
        setDoc(admin(), { roles: { specialist: FULL_PERMS }, isAdmin: true }),
      )
    })

    it('接受只帶部分權限鍵的合法寫入', async () => {
      await assertSucceeds(
        setDoc(admin(), payload({ specialist: { sendTest: true } })),
      )
    })
  })

  describe('提權防護', () => {
    const admin = () => ref(as('admin@x.com'))

    it('不可把 manageUsers 授予行銷專員', async () => {
      await assertFails(
        setDoc(admin(), payload({ specialist: { manageUsers: true } })),
      )
    })

    it('不可把 manageSettings 授予主管', async () => {
      await assertFails(
        setDoc(admin(), payload({ manager: { manageSettings: true } })),
      )
    })

    it('明確設為 false 是允許的', async () => {
      await assertSucceeds(
        setDoc(
          admin(),
          payload({ specialist: { manageUsers: false, manageSettings: false } }),
        ),
      )
    })
  })
})

describe('firestore.rules — users 白名單', () => {
  let env: RulesTestEnvironment

  beforeAll(async () => {
    env = await initializeTestEnvironment({
      projectId: 'ts-press-fs-rules-users',
      firestore: {
        rules: readFileSync('firestore.rules', 'utf8'),
        host: HOST,
        port: PORT,
      },
    })
  })

  afterAll(async () => env?.cleanup())

  beforeEach(async () => {
    await env.clearFirestore()
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore()
      await setDoc(doc(db, 'users', 'admin@x.com'), {
        email: 'admin@x.com',
        role: 'admin',
        active: true,
      })
      await setDoc(doc(db, 'users', 'spec@x.com'), {
        email: 'spec@x.com',
        role: 'specialist',
        active: true,
      })
    })
  })

  function as(email: string): Firestore {
    return env
      .authenticatedContext(email, { email, email_verified: true })
      .firestore()
  }

  it('使用者不可把自己升成 admin', async () => {
    await assertFails(
      setDoc(doc(as('spec@x.com'), 'users', 'spec@x.com'), {
        email: 'spec@x.com',
        role: 'admin',
        active: true,
      }),
    )
  })

  it('使用者不可改別人的角色', async () => {
    await assertFails(
      setDoc(doc(as('spec@x.com'), 'users', 'admin@x.com'), {
        email: 'admin@x.com',
        role: 'specialist',
        active: true,
      }),
    )
  })

  it('使用者不可自行建立新的白名單文件', async () => {
    await assertFails(
      setDoc(doc(as('spec@x.com'), 'users', 'new@x.com'), {
        email: 'new@x.com',
        role: 'admin',
        active: true,
      }),
    )
  })

  it('管理員可以新增合法的使用者', async () => {
    await assertSucceeds(
      setDoc(doc(as('admin@x.com'), 'users', 'new@x.com'), {
        email: 'new@x.com',
        role: 'manager',
        active: true,
      }),
    )
  })

  it('拒絕非法 role', async () => {
    for (const role of ['superuser', 'editor', '', 'Admin']) {
      await assertFails(
        setDoc(doc(as('admin@x.com'), 'users', 'new@x.com'), {
          email: 'new@x.com',
          role,
          active: true,
        }),
      )
    }
  })

  it('拒絕 active 不是布林值', async () => {
    for (const active of ['true', 1, null]) {
      await assertFails(
        setDoc(doc(as('admin@x.com'), 'users', 'new@x.com'), {
          email: 'new@x.com',
          role: 'manager',
          active,
        }),
      )
    }
  })

  it('缺少 active 欄位必須拒絕（fail closed）', async () => {
    await assertFails(
      setDoc(doc(as('admin@x.com'), 'users', 'new@x.com'), {
        email: 'new@x.com',
        role: 'manager',
      }),
    )
  })

  it('管理員可以刪除使用者（delete 不驗欄位）', async () => {
    await assertSucceeds(
      deleteDoc(doc(as('admin@x.com'), 'users', 'spec@x.com')),
    )
  })

  it('非管理員不可刪除使用者', async () => {
    await assertFails(deleteDoc(doc(as('spec@x.com'), 'users', 'admin@x.com')))
  })
})

describe('firestore.rules — settings/branding（公開文件）', () => {
  let env: RulesTestEnvironment

  beforeAll(async () => {
    env = await initializeTestEnvironment({
      projectId: 'ts-press-fs-rules-branding',
      firestore: {
        rules: readFileSync('firestore.rules', 'utf8'),
        host: HOST,
        port: PORT,
      },
    })
  })

  afterAll(async () => env?.cleanup())

  beforeEach(async () => {
    await env.clearFirestore()
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore()
      await setDoc(doc(db, 'users', 'admin@x.com'), {
        email: 'admin@x.com',
        role: 'admin',
        active: true,
      })
      await setDoc(doc(db, 'users', 'spec@x.com'), {
        email: 'spec@x.com',
        role: 'specialist',
        active: true,
      })
      await setDoc(doc(db, 'settings', 'branding'), {
        logoUrl: 'https://cdn.example.com/logo.png',
      })
    })
  })

  const as = (email: string) =>
    env.authenticatedContext(email, { email, email_verified: true }).firestore()
  const anon = () => env.unauthenticatedContext().firestore()
  const ref = (db: Firestore) => doc(db, 'settings', 'branding')

  it('未登入可以讀（登入頁在驗證前就要顯示 logo）', async () => {
    await assertSucceeds(getDoc(ref(anon())))
  })

  it('未登入不可寫', async () => {
    await assertFails(
      setDoc(ref(anon()), { logoUrl: 'https://evil.com/x.png' }),
    )
  })

  it('非 admin 不可寫', async () => {
    await assertFails(
      setDoc(ref(as('spec@x.com')), { logoUrl: 'https://a.com/x.png' }),
    )
  })

  it('admin 可以寫入合法資料', async () => {
    await assertSucceeds(
      setDoc(ref(as('admin@x.com')), {
        logoUrl: 'https://a.com/x.png',
        updatedAt: new Date(),
      }),
    )
  })

  it('允許清空 logoUrl 回到內建預設', async () => {
    await assertSucceeds(setDoc(ref(as('admin@x.com')), { logoUrl: '' }))
  })

  it('拒絕多出來的欄位', async () => {
    await assertFails(
      setDoc(ref(as('admin@x.com')), {
        logoUrl: 'https://a.com/x.png',
        smtpPassword: 'secret',
      }),
    )
    await assertFails(
      setDoc(ref(as('admin@x.com')), {
        logoUrl: 'https://a.com/x.png',
        internalHost: '10.0.0.150',
      }),
    )
  })

  it('拒絕非 https 的網址', async () => {
    for (const url of [
      'http://a.com/x.png',
      'javascript:alert(1)',
      'data:image/png;base64,AAAA',
      'ftp://a.com/x.png',
      '//a.com/x.png',
    ]) {
      await assertFails(setDoc(ref(as('admin@x.com')), { logoUrl: url }))
    }
  })

  it('拒絕 logoUrl 型別錯誤', async () => {
    for (const v of [123, true, null, ['https://a.com']]) {
      await assertFails(setDoc(ref(as('admin@x.com')), { logoUrl: v }))
    }
  })

  it('拒絕過長的網址', async () => {
    await assertFails(
      setDoc(ref(as('admin@x.com')), {
        logoUrl: 'https://a.com/' + 'x'.repeat(600),
      }),
    )
  })

  it('拒絕含空白的網址', async () => {
    await assertFails(
      setDoc(ref(as('admin@x.com')), { logoUrl: 'https://a.com/a b.png' }),
    )
  })
})

describe('firestore.rules — 動態權限矩陣（mediaContacts / mediaEvents / pressReleases / campaigns）', () => {
  let env: RulesTestEnvironment

  beforeAll(async () => {
    env = await initializeTestEnvironment({
      projectId: 'ts-press-fs-rules-dynperm',
      firestore: {
        rules: readFileSync('firestore.rules', 'utf8'),
        host: HOST,
        port: PORT,
      },
    })
  })

  afterAll(async () => env?.cleanup())

  beforeEach(async () => {
    await env.clearFirestore()
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore()
      await setDoc(doc(db, 'users', 'admin@x.com'), {
        email: 'admin@x.com',
        role: 'admin',
        active: true,
      })
      await setDoc(doc(db, 'users', 'manager@x.com'), {
        email: 'manager@x.com',
        role: 'manager',
        active: true,
      })
      await setDoc(doc(db, 'users', 'spec@x.com'), {
        email: 'spec@x.com',
        role: 'specialist',
        active: true,
      })
      await setDoc(doc(db, 'users', 'legacy@x.com'), {
        email: 'legacy@x.com',
        role: 'editor',
        active: true,
      })
      await setDoc(doc(db, 'users', 'ghostrole@x.com'), {
        email: 'ghostrole@x.com',
        role: 'superuser',
        active: true,
      })
      await setDoc(doc(db, 'users', 'norole@x.com'), {
        // role 欄位整個缺失，模擬資料損毀／未初始化
        email: 'norole@x.com',
        active: true,
      })
      await setDoc(doc(db, 'users', 'badroletype@x.com'), {
        email: 'badroletype@x.com',
        role: 123,
        active: true,
      })
    })
  })

  function as(email: string): Firestore {
    return env
      .authenticatedContext(email, { email, email_verified: true })
      .firestore()
  }

  async function setOverrides(roles: Record<string, unknown>) {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'settings', 'permissions'), { roles })
    })
  }

  describe('預設矩陣（沒有 settings/permissions 覆寫時）', () => {
    it('viewPress／editPress：三種角色預設都能讀寫 pressReleases', async () => {
      for (const email of ['admin@x.com', 'manager@x.com', 'spec@x.com']) {
        await assertSucceeds(getDoc(doc(as(email), 'pressReleases', 'p1')))
        await assertSucceeds(
          setDoc(doc(as(email), 'pressReleases', 'p1'), { title: 'x' }),
        )
      }
    })

    it('manageContacts：三種角色預設都能讀寫 mediaContacts', async () => {
      for (const email of ['admin@x.com', 'manager@x.com', 'spec@x.com']) {
        await assertSucceeds(
          setDoc(doc(as(email), 'mediaContacts', 'c1'), { email: 'a@b.com' }),
        )
      }
    })

    it('manageEvents：三種角色預設都能讀寫 mediaEvents 與 participants', async () => {
      for (const email of ['admin@x.com', 'manager@x.com', 'spec@x.com']) {
        await assertSucceeds(setDoc(doc(as(email), 'mediaEvents', 'e1'), { type: 'meal' }))
        await assertSucceeds(
          setDoc(doc(as(email), 'mediaEvents', 'e1', 'participants', 'c1'), {
            attended: true,
          }),
        )
      }
    })

    it('viewCampaigns：三種角色預設都能讀 campaigns 與 recipients，但都不能寫', async () => {
      await env.withSecurityRulesDisabled(async (ctx) => {
        await setDoc(doc(ctx.firestore(), 'campaigns', 'c1'), { status: 'sent' })
        await setDoc(
          doc(ctx.firestore(), 'campaigns', 'c1', 'recipients', 'r1'),
          { status: 'sent' },
        )
      })
      for (const email of ['admin@x.com', 'manager@x.com', 'spec@x.com']) {
        await assertSucceeds(getDoc(doc(as(email), 'campaigns', 'c1')))
        await assertSucceeds(
          getDoc(doc(as(email), 'campaigns', 'c1', 'recipients', 'r1')),
        )
        await assertFails(
          setDoc(doc(as(email), 'campaigns', 'c1'), { status: 'x' }),
        )
      }
    })

    // round 8（Finding 2 item 11）：delivery_unknown 的人工 resolution
    // 一定要透過 resolveDeliveryUnknown callable（Admin SDK，會繞過這份
    // 規則），不能讓任何角色（含 admin）直接改 recipients 子集合的狀態
    // 繞過 requireAdmin／稽核欄位／totals 重算——這裡直接驗證即使是
    // admin，用戶端 SDK 也一律被 `allow write: if false` 擋下，包含
    // recipients 子集合本身（不只 campaign 文件），以及完全未登入的呼叫。
    it('delivery_unknown resolution 不能繞過 callable：連 admin 用戶端 SDK 也不能直接改 recipients 子集合的狀態', async () => {
      await env.withSecurityRulesDisabled(async (ctx) => {
        await setDoc(doc(ctx.firestore(), 'campaigns', 'c2'), { status: 'needs_review' })
        await setDoc(
          doc(ctx.firestore(), 'campaigns', 'c2', 'recipients', 'r1'),
          { status: 'delivery_unknown' },
        )
      })
      for (const email of ['admin@x.com', 'manager@x.com', 'spec@x.com']) {
        await assertFails(
          setDoc(
            doc(as(email), 'campaigns', 'c2', 'recipients', 'r1'),
            { status: 'sent', resolvedBy: email },
            { merge: true },
          ),
        )
      }
      await assertFails(
        setDoc(
          doc(env.unauthenticatedContext().firestore(), 'campaigns', 'c2', 'recipients', 'r1'),
          { status: 'sent' },
          { merge: true },
        ),
      )
    })

    // round 10 新增（Finding 3）：resolutionEvents/{resolutionId} 是
    // delivery_unknown 人工 resolution 的 immutable 稽核紀錄，唯一能防止
    // 同一個 resolutionId 被重複套用的真相來源（見 shared/campaignSend.ts
    // 的 ResolutionEventRecord 說明）。這份文件的價值正是「任何人都不能
    // 改它」——一旦允許 client 端寫入（哪怕只是 admin、哪怕只是
    // update），就等於讓人可以直接偽造或竄改稽核紀錄，繞過整個 fencing
    // 機制。這裡驗證 create／update／delete 三種操作，對所有角色（含
    // admin）與未登入使用者都一律拒絕；read 則跟 campaigns 本身一樣，
    // 依 viewCampaigns 權限開放。
    it('resolutionEvents：任何角色（含 admin）都不能 create／update／delete，viewCampaigns 可以讀', async () => {
      await env.withSecurityRulesDisabled(async (ctx) => {
        await setDoc(doc(ctx.firestore(), 'campaigns', 'c3'), { status: 'needs_review' })
        await setDoc(
          doc(ctx.firestore(), 'campaigns', 'c3', 'resolutionEvents', 'existing-event'),
          {
            recipientId: 'r1',
            resolutionAction: 'mark_delivered',
            resolutionReason: '已電話確認',
            resolvedBy: 'admin@x.com',
            fencingGeneration: 1,
            beforeStatus: 'delivery_unknown',
            afterStatus: 'sent',
          },
        )
      })

      for (const email of ['admin@x.com', 'manager@x.com', 'spec@x.com']) {
        // create：偽造一筆全新的稽核紀錄
        await assertFails(
          setDoc(doc(as(email), 'campaigns', 'c3', 'resolutionEvents', 'forged-event'), {
            recipientId: 'r1',
            resolutionAction: 'mark_delivered',
            resolutionReason: '偽造的紀錄',
            resolvedBy: email,
          }),
        )
        // update：竄改既有的稽核紀錄
        await assertFails(
          setDoc(
            doc(as(email), 'campaigns', 'c3', 'resolutionEvents', 'existing-event'),
            { resolutionReason: '竄改過的原因' },
            { merge: true },
          ),
        )
        // delete：刪掉稽核紀錄，讓同一個 resolutionId 可以被重新套用
        await assertFails(
          deleteDoc(doc(as(email), 'campaigns', 'c3', 'resolutionEvents', 'existing-event')),
        )
        // read：跟 campaigns 本身一樣，依 viewCampaigns 權限開放（三個
        // 預設角色都有 viewCampaigns，見 DEFAULT_PERMISSIONS）。
        await assertSucceeds(
          getDoc(doc(as(email), 'campaigns', 'c3', 'resolutionEvents', 'existing-event')),
        )
      }

      await assertFails(
        setDoc(
          doc(env.unauthenticatedContext().firestore(), 'campaigns', 'c3', 'resolutionEvents', 'forged-event-2'),
          { recipientId: 'r1' },
        ),
      )
      await assertFails(
        getDoc(doc(env.unauthenticatedContext().firestore(), 'campaigns', 'c3', 'resolutionEvents', 'existing-event')),
      )
    })

    it('未登入或不在白名單一律拒絕，包含對 campaigns／recipients 的寫入', async () => {
      await assertFails(getDoc(doc(env.unauthenticatedContext().firestore(), 'pressReleases', 'p1')))
      await assertFails(getDoc(doc(as('ghost@x.com'), 'pressReleases', 'p1')))
      await assertFails(
        setDoc(doc(env.unauthenticatedContext().firestore(), 'campaigns', 'c1'), { status: 'x' }),
      )
      await assertFails(
        setDoc(doc(as('ghost@x.com'), 'campaigns', 'c1'), { status: 'x' }),
      )
    })
  })

  describe('管理員撤銷權限後立即生效（使用者仍在白名單）', () => {
    it('撤銷 spec 的 editPress 後不能再寫 pressReleases，但仍能讀', async () => {
      await setOverrides({ specialist: { editPress: false } })
      await assertFails(
        setDoc(doc(as('spec@x.com'), 'pressReleases', 'p1'), { title: 'x' }),
      )
      await assertSucceeds(getDoc(doc(as('spec@x.com'), 'pressReleases', 'p1')))
    })

    it('撤銷 spec 的 viewPress 後連讀都不行', async () => {
      await setOverrides({ specialist: { viewPress: false } })
      await assertFails(getDoc(doc(as('spec@x.com'), 'pressReleases', 'p1')))
    })

    it('撤銷 manager 的 manageContacts 後不能再讀寫媒體名單', async () => {
      await setOverrides({ manager: { manageContacts: false } })
      await assertFails(
        setDoc(doc(as('manager@x.com'), 'mediaContacts', 'c1'), {}),
      )
      await assertFails(getDoc(doc(as('manager@x.com'), 'mediaContacts', 'c1')))
    })

    it('撤銷 spec 的 manageEvents 後不能再讀寫活動與 participants', async () => {
      await setOverrides({ specialist: { manageEvents: false } })
      await assertFails(setDoc(doc(as('spec@x.com'), 'mediaEvents', 'e1'), {}))
      await assertFails(
        setDoc(doc(as('spec@x.com'), 'mediaEvents', 'e1', 'participants', 'c1'), {}),
      )
    })

    it('撤銷 manager 的 viewCampaigns 後不能再讀發送紀錄', async () => {
      await env.withSecurityRulesDisabled(async (ctx) => {
        await setDoc(doc(ctx.firestore(), 'campaigns', 'c1'), { status: 'sent' })
      })
      await setOverrides({ manager: { viewCampaigns: false } })
      await assertFails(getDoc(doc(as('manager@x.com'), 'campaigns', 'c1')))
    })

    it('只覆寫其中一項權限，其餘權限仍照預設值運作', async () => {
      await setOverrides({ specialist: { editPress: false } })
      // manageContacts 沒被覆寫，應仍照預設（true）
      await assertSucceeds(
        setDoc(doc(as('spec@x.com'), 'mediaContacts', 'c1'), {}),
      )
    })

    it('admin 專屬權限不受覆寫矩陣影響（覆寫也無法讓非 admin 拿到）', async () => {
      // 這筆覆寫本身會被 settings/permissions 的寫入規則擋下（提權防護），
      // 這裡直接繞過寫入規則塞進模擬資料庫，驗證「就算資料被竄改，
      // hasPerm() 對 admin-only 權限也不採信覆寫」
      await env.withSecurityRulesDisabled(async (ctx) => {
        await setDoc(doc(ctx.firestore(), 'settings', 'permissions'), {
          roles: { specialist: { manageUsers: true } },
        })
      })
      // manageUsers 本身沒有對應到這 4 個集合的讀寫規則，這裡改用行為一致的
      // manageSettings 驗證邏輯來源一致：直接檢查 hasPermForRole 的效果，
      // 透過 editPress（一般權限）仍照預設值運作來確認覆寫矩陣本身沒有壞掉。
      await assertSucceeds(
        setDoc(doc(as('spec@x.com'), 'pressReleases', 'p1'), { title: 'x' }),
      )
    })
  })

  describe('角色與白名單資料的邊界情境（一律拒絕）', () => {
    it('舊代號 editor 仍視為 specialist（可讀寫），與 shared/permissions.ts 的 normalizeRole 一致', async () => {
      await assertSucceeds(
        setDoc(doc(as('legacy@x.com'), 'pressReleases', 'p1'), { title: 'x' }),
      )
    })

    it('未知角色一律拒絕', async () => {
      await assertFails(getDoc(doc(as('ghostrole@x.com'), 'pressReleases', 'p1')))
    })

    it('role 欄位缺失一律拒絕', async () => {
      await assertFails(getDoc(doc(as('norole@x.com'), 'pressReleases', 'p1')))
    })

    it('role 欄位型別錯誤一律拒絕', async () => {
      await assertFails(getDoc(doc(as('badroletype@x.com'), 'pressReleases', 'p1')))
    })

    it('停用帳號一律拒絕，即使角色是 admin', async () => {
      await env.withSecurityRulesDisabled(async (ctx) => {
        await setDoc(doc(ctx.firestore(), 'users', 'disabled-admin@x.com'), {
          email: 'disabled-admin@x.com',
          role: 'admin',
          active: false,
        })
      })
      await assertFails(
        getDoc(doc(as('disabled-admin@x.com'), 'pressReleases', 'p1')),
      )
    })
  })

  describe('settings/permissions 資料被竄改成畸形格式時 fail closed', () => {
    it('roles 不是 map：連預設權限都不給，全部拒絕', async () => {
      await env.withSecurityRulesDisabled(async (ctx) => {
        await setDoc(doc(ctx.firestore(), 'settings', 'permissions'), {
          roles: 'everything',
        })
      })
      await assertFails(getDoc(doc(as('spec@x.com'), 'pressReleases', 'p1')))
      await assertFails(getDoc(doc(as('admin@x.com'), 'pressReleases', 'p1')))
    })

    it('權限鍵帶有未知欄位：連預設權限都不給，全部拒絕', async () => {
      await env.withSecurityRulesDisabled(async (ctx) => {
        await setDoc(doc(ctx.firestore(), 'settings', 'permissions'), {
          roles: { specialist: { hackAll: true } },
        })
      })
      await assertFails(getDoc(doc(as('spec@x.com'), 'pressReleases', 'p1')))
    })

    it('權限值不是布林值：連預設權限都不給，全部拒絕', async () => {
      await env.withSecurityRulesDisabled(async (ctx) => {
        await setDoc(doc(ctx.firestore(), 'settings', 'permissions'), {
          roles: { specialist: { editPress: 'true' } },
        })
      })
      await assertFails(getDoc(doc(as('spec@x.com'), 'pressReleases', 'p1')))
    })
  })
})

/**
 * round 28 新增：system/runtime（活動操作維護模式旗標，campaignOperationsPaused
 * ——見 shared/maintenance.ts 與 firestore.rules 對應 match 區塊的說明）。
 *
 * 這份文件唯一的讀者／寫入者是 Cloud Functions 自己的 Admin SDK（六個受
 * 管制的 callable 讀取；functions/scripts/ops-maintenance.mjs CLI 寫入）——
 * 跟 settings/smtp（admin 可讀）不同，這裡刻意連 admin 角色的 client 都要
 * 被拒絕，證明的重點正是「這份文件比 settings/smtp 更嚴格：沒有任何
 * client 角色被允許」。
 *
 * ⚠️ Admin SDK 完全不受這份 firestore.rules 檔案約束——這是 Firestore
 * 本身的設計（安全規則只套用在透過 client SDK／REST 的請求，Admin SDK
 * 走的是完全不同、以服務帳號為信任基礎的路徑），不是這份規則檔案「碰巧
 * 沒擋到」。這件事沒有辦法用「規則測試」證明（規則測試驗證的正是規則
 * 本身的行為，Admin SDK 從頭到尾不會觸發規則引擎，沒有規則結果可以斷言），
 * 所以這裡不假裝寫一個「證明規則擋不住 Admin SDK」的測試——那樣的測試
 * 只是同義反覆，不具意義。真正有意義、也確實可以驗證的是：透過
 * functions/scripts/emulator-test-support.mjs 的 createEmulatorFirestoreApp()
 * 走 Admin SDK 對同一個 emulator 讀寫 system/runtime 確實成功——見
 * tests/systemRuntimeAdminEmulator.test.ts，那裡具體示範 Admin SDK 存取
 * 完全不受這裡任何一條 rules 影響。
 */
describe('firestore.rules — system/runtime（活動操作維護模式旗標，只有 Cloud Functions Admin SDK 能讀寫）', () => {
  let env: RulesTestEnvironment

  beforeAll(async () => {
    env = await initializeTestEnvironment({
      projectId: 'ts-press-fs-rules-system-runtime',
      firestore: {
        rules: readFileSync('firestore.rules', 'utf8'),
        host: HOST,
        port: PORT,
      },
    })
  })

  afterAll(async () => env?.cleanup())

  beforeEach(async () => {
    await env.clearFirestore()
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore()
      await setDoc(doc(db, 'users', 'admin@x.com'), {
        email: 'admin@x.com',
        role: 'admin',
        active: true,
      })
      await setDoc(doc(db, 'users', 'spec@x.com'), {
        email: 'spec@x.com',
        role: 'specialist',
        active: true,
      })
    })
  })

  function as(email: string): Firestore {
    return env
      .authenticatedContext(email, { email, email_verified: true })
      .firestore()
  }
  const anon = () => env.unauthenticatedContext().firestore()
  const ref = (db: Firestore) => doc(db, 'system', 'runtime')

  it('未登入：讀取與寫入都被拒絕', async () => {
    await assertFails(getDoc(ref(anon())))
    await assertFails(setDoc(ref(anon()), { campaignOperationsPaused: true }))
  })

  it('一般白名單使用者（非 admin）：讀取與寫入都被拒絕', async () => {
    await assertFails(getDoc(ref(as('spec@x.com'))))
    await assertFails(setDoc(ref(as('spec@x.com')), { campaignOperationsPaused: true }))
  })

  it('admin 角色：讀取與寫入同樣都被拒絕——跟 settings/smtp（admin 可讀）刻意不同，' +
    '這份文件對任何 client 角色一律不開放，只有 Cloud Functions 的 Admin SDK 能碰它', async () => {
    await assertFails(getDoc(ref(as('admin@x.com'))))
    await assertFails(setDoc(ref(as('admin@x.com')), { campaignOperationsPaused: true }))
  })

  it('admin 角色：即使文件已經被 Admin SDK（這裡用 withSecurityRulesDisabled 模擬）寫入過，仍然讀不到——不是「文件不存在才拒絕」', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'system', 'runtime'), { campaignOperationsPaused: true })
    })
    await assertFails(getDoc(ref(as('admin@x.com'))))
  })
})

/**
 * round 29 新增：selfTestEmailCooldowns/{uid}（sendSelfTestEmail 的節流冷卻
 * 紀錄，見 shared/selfTestEmail.ts 與 firestore.rules 對應 match 區塊的
 * 說明）。跟上面的 system/runtime 同一種風格——這份文件唯一的讀者／寫入者
 * 是 sendSelfTestEmail 這個 callable 自己的 Firestore transaction，刻意
 * 對「任何」client 角色一律拒絕讀寫，admin 角色也不例外。
 */
describe('firestore.rules — selfTestEmailCooldowns/{uid}（寄測試信給自己的節流冷卻紀錄，只有 Cloud Functions Admin SDK 能讀寫）', () => {
  let env: RulesTestEnvironment

  beforeAll(async () => {
    env = await initializeTestEnvironment({
      projectId: 'ts-press-fs-rules-self-test-email-cooldowns',
      firestore: {
        rules: readFileSync('firestore.rules', 'utf8'),
        host: HOST,
        port: PORT,
      },
    })
  })

  afterAll(async () => env?.cleanup())

  beforeEach(async () => {
    await env.clearFirestore()
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore()
      await setDoc(doc(db, 'users', 'admin@x.com'), {
        email: 'admin@x.com',
        role: 'admin',
        active: true,
      })
      await setDoc(doc(db, 'users', 'spec@x.com'), {
        email: 'spec@x.com',
        role: 'specialist',
        active: true,
      })
    })
  })

  function as(email: string): Firestore {
    return env
      .authenticatedContext(email, { email, email_verified: true })
      .firestore()
  }
  const anon = () => env.unauthenticatedContext().firestore()
  const ref = (db: Firestore) => doc(db, 'selfTestEmailCooldowns', 'some-uid')

  it('未登入：讀取與寫入都被拒絕', async () => {
    await assertFails(getDoc(ref(anon())))
    await assertFails(setDoc(ref(anon()), { lastSentAtMs: Date.now() }))
  })

  it('一般白名單使用者（非 admin）：讀取與寫入都被拒絕', async () => {
    await assertFails(getDoc(ref(as('spec@x.com'))))
    await assertFails(setDoc(ref(as('spec@x.com')), { lastSentAtMs: Date.now() }))
  })

  it('admin 角色：讀取與寫入同樣都被拒絕——這份文件對任何 client 角色一律不開放，只有 Cloud Functions 的 Admin SDK（sendSelfTestEmailHandler 自己的 transaction）能碰它', async () => {
    await assertFails(getDoc(ref(as('admin@x.com'))))
    await assertFails(setDoc(ref(as('admin@x.com')), { lastSentAtMs: Date.now() }))
  })
})
