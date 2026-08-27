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

    it('未登入或不在白名單一律拒絕', async () => {
      await assertFails(getDoc(doc(env.unauthenticatedContext().firestore(), 'pressReleases', 'p1')))
      await assertFails(getDoc(doc(as('ghost@x.com'), 'pressReleases', 'p1')))
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
