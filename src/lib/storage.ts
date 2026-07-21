import {
  deleteObject,
  getDownloadURL,
  ref,
  uploadBytes,
} from 'firebase/storage'
import { storage } from './firebase'
import type { StoredFile } from '../types'

/** 去掉會讓 Storage 路徑出問題的字元，但保留中文檔名。 */
function safeName(name: string): string {
  return name.replace(/[/\\#?%]/g, '_')
}

export async function uploadPressFile(
  pressId: string,
  folder: 'hero' | 'attachments',
  file: File,
): Promise<StoredFile> {
  const path = `press/${pressId}/${folder}/${Date.now()}_${safeName(file.name)}`
  const objectRef = ref(storage, path)
  await uploadBytes(objectRef, file, { contentType: file.type })
  const url = await getDownloadURL(objectRef)
  return {
    name: file.name,
    path,
    url,
    size: file.size,
    contentType: file.type,
  }
}

/** 上傳信件頁首 logo 等品牌素材。 */
export async function uploadBrandingFile(file: File): Promise<StoredFile> {
  const path = `branding/${Date.now()}_${safeName(file.name)}`
  const objectRef = ref(storage, path)
  await uploadBytes(objectRef, file, { contentType: file.type })
  const url = await getDownloadURL(objectRef)
  return {
    name: file.name,
    path,
    url,
    size: file.size,
    contentType: file.type,
  }
}

/**
 * 刪除 Storage 檔案。
 *
 * 只有「檔案本來就不存在」可以忽略——那代表目標狀態已經達成。
 * 權限不足、網路中斷等都必須往外拋，否則畫面會顯示刪除成功、
 * 檔案卻還留在 bucket 裡，使用者無從察覺。
 */
export async function deletePressFile(path: string): Promise<void> {
  try {
    await deleteObject(ref(storage, path))
  } catch (err) {
    const code = (err as { code?: string }).code
    if (code === 'storage/object-not-found') return
    throw err
  }
}

/** 把 Storage 錯誤翻成使用者看得懂的訊息。 */
export function describeStorageError(err: unknown): string {
  const code = (err as { code?: string }).code
  if (code === 'storage/unauthorized') {
    return '沒有權限操作這個檔案，請確認帳號權限。'
  }
  if (code === 'storage/retry-limit-exceeded' || code === 'storage/canceled') {
    return '網路連線不穩定，請稍後再試。'
  }
  if (code === 'storage/quota-exceeded') return '儲存空間已滿，請聯絡管理員。'
  return (err as Error)?.message ?? '檔案操作失敗。'
}
