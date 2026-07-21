import type { MediaContact } from '../types'

/**
 * 媒體名單的預設排序：重要窗口（星號）最前，其次依重要性 rank，
 * 最後以媒體名稱的中文筆劃排序。
 *
 * 名單頁與媒體關係的各個畫面共用這個順序，避免同一份名單在不同頁面
 * 出現不同排列而讓人找不到人。
 */
export function compareContacts(a: MediaContact, b: MediaContact): number {
  if (!!a.starred !== !!b.starred) return a.starred ? -1 : 1

  const ar = a.rank ?? Number.MAX_SAFE_INTEGER
  const br = b.rank ?? Number.MAX_SAFE_INTEGER
  if (ar !== br) return ar - br

  return (a.outlet ?? '').localeCompare(b.outlet ?? '', 'zh-Hant')
}
