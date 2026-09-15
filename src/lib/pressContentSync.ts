import type { PressRelease } from '../types'

/**
 * 「US 版本與 WWW 版本保持相同」功能的共用純邏輯。
 *
 * round 30 新增。唯一的呼叫端是 src/pages/PressEditPage.tsx（目前只有這
 * 一個頁面會編輯新聞稿內容），抽成獨立、不依賴 React／Firestore 的純函式
 * 有兩個理由：
 * 1. 單元測試可以直接餵各種 PressRelease 形狀，不必掛載元件或連線 Firestore。
 * 2. 「每次要用這份資料之前都先 canonicalize 一次」這件事必須是無條件、
 *    不會被漏掉的規則——如果散落在各個 onChange handler 裡各自小心處理，
 *    很容易漏掉某個修改路徑（例如附件、負責人、發佈日期……這些跟 WWW/US
 *    無關的欄位變更）而忘記重新檢查一致性。這支檔案只提供「給我目前的
 *    press，我保證回傳的版本一定符合同步規則」這一個保證，呼叫端只要在
 *    每次要顯示或持久化之前呼叫一次，不需要自己記得什麼時候該同步。
 *
 * ⚠️ 實際 schema 調查結果（round 30，不得用猜的）：`PressVersion`
 * （src/types.ts）只有 `subject`（主旨／標題）與 `bodyText`（內文）兩個
 * 文字內容欄位，`heroImage` 是圖片參照，不是文字內容。所以 WWW／US
 * 「成對」的文字內容欄位精確地只有這兩個，沒有「副標題」「摘要」這些
 * 欄位存在於目前的資料結構裡——同步範圍只涵蓋這兩個欄位，其餘（含
 * heroImage、releaseDate、scheduledDate、ownerEmail、status、attachments、
 * archived……）一律不動。
 */

/** WWW／US 之間真正需要保持一致的成對文字欄位——見上方 schema 調查說明。 */
export const SYNCED_VERSION_FIELDS = ['subject', 'bodyText'] as const
export type SyncedVersionField = (typeof SYNCED_VERSION_FIELDS)[number]

/** 判斷目前的 versions.www／versions.us 是否完全一致（只比對成對文字欄位）。 */
export function isUsVersionInSyncWithWww(press: Pick<PressRelease, 'versions'>): boolean {
  const www = press.versions.www
  const us = press.versions.us
  return SYNCED_VERSION_FIELDS.every((field) => www[field] === us[field])
}

/**
 * 每次要顯示或持久化一份 PressRelease 之前都要呼叫這個函式一次
 * （src/pages/PressEditPage.tsx 的 `patch()` 是唯一的狀態變更入口，已經
 * 在那裡統一呼叫，見該處說明）——不能只依賴個別 onChange handler 各自
 * 小心處理。
 *
 * `press.usSyncedWithWww` 不是 `true` 時完全不改動任何內容，原樣傳回
 * （包含物件參照本身，不做無意義的淺拷貝）——舊資料缺少這個欄位時
 * `undefined !== true`，等同 false，維持既有的獨立編輯行為，這正是
 * 「舊新聞稿缺少此欄位時，一律視為 false」的實作方式：完全不需要另外寫
 * 一個「欄位不存在時」的特殊分支，`!== true` 的比較天然涵蓋
 * `undefined`／`false`／任何非 `true` 的畸形值。
 *
 * 為 `true` 時，強制把 `versions.us` 的 `subject`／`bodyText` 覆寫成跟
 * `versions.www` 完全相同；`heroImage` 等非文字欄位不動。如果目前已經
 * 一致（例如呼叫端只是改了不相關的欄位，例如附件），直接回傳原始物件
 * 參照，不產生新的物件——避免不必要的 re-render／誤判成「有變更」。
 */
export function canonicalizePressForSync(press: PressRelease): PressRelease {
  if (press.usSyncedWithWww !== true) return press
  if (isUsVersionInSyncWithWww(press)) return press

  const www = press.versions.www
  return {
    ...press,
    versions: {
      ...press.versions,
      us: {
        ...press.versions.us,
        subject: www.subject,
        bodyText: www.bodyText,
      },
    },
  }
}

/**
 * 提交前審查追加（round 30）：修正 PressEditPage.tsx 的 `patch()` 潛在的
 * stale-closure 風險。
 *
 * 修正前的 `patch()` 長這樣：
 * ```
 * function patch(updater) {
 *   if (!press) return
 *   const next = canonicalizePressForSync(updater(press))
 *   setPress(next)
 *   controllerRef.current?.markEdited(next)
 * }
 * ```
 * `press` 是從 `useState` 讀出來的值，在單一次 render 裡是固定的（React
 * 的 closure 語意本來就是這樣）。如果在同一個 render 還沒被下一次 commit
 * 取代之前，同步連續呼叫兩次 `patch()`，第二次呼叫讀到的 `press` 仍然是
 * 呼叫第一次之前的舊值——第二次的修改會蓋掉第一次剛做的修改，即使兩次
 * `setPress` 呼叫本身都不會出錯、UI 也不會報任何錯誤，遺失的是資料本身。
 * 這個檔案目前找不到任何一個 onChange handler 會在同一個事件裡連續呼叫
 * 兩次 `patch()`，所以一般使用者依序打字、依序勾選不會踩到；但這是一個
 * 真實存在的漏洞類別（下面 `tests/pressContentSync.test.ts` 用
 * `createPressPatcher` 以外的「naive」寫法重現過），值得用最小改動修掉，
 * 不必等到真的有 call site 兩次呼叫才處理。
 *
 * 修法：把「目前最新內容」從 React state（只在 render/commit 之後才更新）
 * 換成一個在 `.patch()` 呼叫當下就同步更新的閉包變數 `latest`——這個物件
 * 完全不依賴 React，也不在任何 React `setState` 的 updater function 裡
 * 呼叫 `onChange`（因此不會被 Strict Mode 的雙重呼叫影響到副作用），只是
 * 一個提供「同步讀寫最新值」保證的容器。呼叫端（PressEditPage.tsx）用
 * `useRef<PressPatcher>` 持有它，`onChange` callback 裡才呼叫
 * `setPress`／`controllerRef.current?.markEdited`——這兩個呼叫本身仍然是
 * 一般的同步函式呼叫，不是包在 `setState(updater)` 裡面。
 */
export interface PressPatcher {
  /** 套用一次修改：以「目前最新內容」為基礎、canonicalize 後回傳並設為最新內容。 */
  patch(updater: (press: PressRelease) => PressRelease): PressRelease
  /** 目前的最新內容（例如需要在 patch() 以外的地方讀取當前值時）。 */
  getLatest(): PressRelease
  /** 用外部資料（例如剛從 Firestore 載入／重新整理）同步最新內容，不觸發 onChange。 */
  sync(press: PressRelease): void
}

export function createPressPatcher(
  initial: PressRelease,
  onChange: (next: PressRelease) => void,
): PressPatcher {
  let latest = initial

  return {
    patch(updater) {
      const next = canonicalizePressForSync(updater(latest))
      latest = next
      onChange(next)
      return next
    },
    getLatest() {
      return latest
    },
    sync(press) {
      latest = press
    },
  }
}
