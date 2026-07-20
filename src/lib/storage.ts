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

export async function deletePressFile(path: string): Promise<void> {
  try {
    await deleteObject(ref(storage, path))
  } catch {
    // 檔案可能已被刪除，忽略即可
  }
}
