import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing'
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  doc,
  getDoc,
  setDoc,
  deleteDoc,
  type Firestore,
} from 'firebase/firestore'

/**
 * Firestore 安全規則測試，重點在 settings/permissions。
 *
 * 需要 Firebase 模擬器：
 *   npx firebase emulators:start --only firestore
 */
const HOST = '127.0.0.1'
const PORT = 8080

async function emulatorRunning() {
  try {
    // 只要連得上就代表模擬器在跑，不看狀態碼
    await fetch(`http://${HOST}:${PORT}/`, {
      signal: AbortSignal.timeout(3000),
    })
    return true
  } catch {
    return false
  }
}

const available = await emulatorRunning()

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

describe.skipIf(!available)('firestore.rules — settings/permissions', () => {
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

describe.skipIf(!available)('firestore.rules — users 白名單', () => {
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

describe.skipIf(available)('firestore.rules（略過）', () => {
  it('需要 Firebase 模擬器，請先執行 npx firebase emulators:start --only firestore', () => {
    expect(available).toBe(false)
  })
})
