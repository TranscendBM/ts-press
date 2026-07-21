/**
 * 把 shared/ 底下的共用程式碼複製進 functions/src。
 *
 * Cloud Functions 部署時只會打包 functions/ 目錄，無法直接引用上層檔案，
 * 但又不能維護兩份會分歧的範本。折衷做法是「單一來源 + 建置時複製」：
 * shared/ 是唯一可編輯的來源，產生出來的 *.generated.ts 已列入 .gitignore，
 * 每次 build 前重新產生，確保前端預覽與實際寄出的信永遠一致。
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const sharedDir = join(here, '..', '..', 'shared')
const outDir = join(here, '..', 'src')

const FILES = [
  ['emailTemplate.ts', 'emailTemplate.generated.ts'],
  ['policy.ts', 'policy.generated.ts'],
]

mkdirSync(outDir, { recursive: true })
for (const [src, dest] of FILES) {
  const banner =
    '// 自動產生，請勿直接修改。\n' +
    `// 來源：shared/${src}（執行 npm run build 會重新產生）\n\n`
  const body = readFileSync(join(sharedDir, src), 'utf8')
  writeFileSync(join(outDir, dest), banner + body)
  console.log(`synced shared/${src} -> functions/src/${dest}`)
}
void copyFileSync
