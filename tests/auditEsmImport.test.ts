import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)

/**
 * 修正 Windows 上的 ERR_UNSUPPORTED_ESM_URL_SCHEME（audit-campaign-drain.mjs／
 * ops-campaign-repair.mjs 都用 `await import(compiledClassifierPath)` 動態載入
 * 編譯後的 functions/lib/campaignSend.generated.js——compiledClassifierPath 是
 * 原始檔案系統路徑，在 Windows 上是 `C:\...`，Node 的 ESM 動態 import() 會把
 * `C:` 誤認成不支援的 URL scheme 而丟出這個錯誤）。
 *
 * ⚠️ 這裡刻意用真正的子行程（`node -e ...`）驗證，不在 vitest 測試本身的
 * process 裡直接呼叫 `import()`——vitest／Vite 的 SSR 模組載入機制會攔截、
 * 重新處理動態 import()，跟真正執行 `node scripts/audit-campaign-drain.mjs`
 * 時使用的、未經任何框架介入的原生 Node ESM loader 行為不完全一樣（實測發現
 * vitest 環境下連 `pathToFileURL` 轉換過的路徑都可能因為 Vite 自己的解析邏輯
 * 而找不到模組，且「未轉換的原始路徑」在 vitest 環境下不會重現
 * ERR_UNSUPPORTED_ESM_URL_SCHEME）。子行程測試才是跟正式 CLI 執行方式一致、
 * 真正有意義的驗證。
 *
 * 這裡不依賴真正的 `functions/lib/campaignSend.generated.js`（那需要先跑過
 * `npm --prefix functions run build`，會把測試耦合到 tsc 編譯輸出的細節）——
 * 直接寫一份最小的 CommonJS 模組到臨時檔案，用跟修正後的程式碼完全相同的
 * 機制（`pathToFileURL(path).href` 再 `import()`）載入。
 *
 * ⚠️ 這裡只驗證「ESM 模組載入本身」——不初始化 firebase-admin、不呼叫
 * initializeApp()、不連線任何 Firebase 專案。「載入編譯後的分類邏輯成功」
 * 與「真正對 Firestore 執行稽核」是兩件事，後者不在這份測試的範圍內。
 */
describe('動態 import() 搭配 pathToFileURL（Windows ESM URL scheme 修正，真實子行程驗證）', () => {
  let dir: string

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  /** 目標檔案本身用 CommonJS（.cjs），避免受任何鄰近 package.json 的
   *  `"type"` 欄位影響——跟正式的 campaignSend.generated.js 一樣是 CJS 編譯輸出。 */
  function writeTargetModule(fileName: string, marker: string): string {
    dir = mkdtempSync(join(tmpdir(), 'ts-press esm import test '))
    const filePath = join(dir, fileName)
    writeFileSync(filePath, `module.exports.marker = ${JSON.stringify(marker)};\n`, 'utf8')
    return filePath
  }

  /** 對應「修正後」的載入方式：driver 自己用 pathToFileURL 轉換再 import()。 */
  function fixedDriver(targetPath: string): string {
    const driverPath = join(dir, 'driver-fixed.mjs')
    writeFileSync(
      driverPath,
      [
        "import { pathToFileURL } from 'node:url'",
        `const mod = await import(pathToFileURL(${JSON.stringify(targetPath)}).href)`,
        'console.log(JSON.stringify({ marker: mod.marker }))',
      ].join('\n'),
      'utf8',
    )
    return driverPath
  }

  /** 對應「修正前」的載入方式：driver 把原始檔案系統路徑直接丟進 import()。 */
  function rawPathDriver(targetPath: string): string {
    const driverPath = join(dir, 'driver-raw.mjs')
    writeFileSync(
      driverPath,
      [
        `const mod = await import(${JSON.stringify(targetPath)})`,
        'console.log(JSON.stringify({ marker: mod.marker }))',
      ].join('\n'),
      'utf8',
    )
    return driverPath
  }

  it('（僅 Windows）修正前：原始檔案系統路徑直接丟進 import() → 重現 ERR_UNSUPPORTED_ESM_URL_SCHEME，證明這確實是要解決的問題', async () => {
    if (process.platform !== 'win32') return
    const target = writeTargetModule('classifier.js', 'raw-path-should-fail')
    const driver = rawPathDriver(target)
    const result = await execFileAsync('node', [driver]).catch((e) => e)
    expect(result.code).not.toBe(0)
    expect(String(result.stderr ?? '')).toContain('ERR_UNSUPPORTED_ESM_URL_SCHEME')
  })

  it('修正後：一般路徑用 pathToFileURL 轉換後可以正常 import()', async () => {
    const target = writeTargetModule('classifier.js', 'plain-path-ok')
    const driver = fixedDriver(target)
    const { stdout } = await execFileAsync('node', [driver])
    expect(JSON.parse(stdout)).toEqual({ marker: 'plain-path-ok' })
  })

  it('目錄與檔名都含空白 → 用 pathToFileURL 轉換後可以正常 import()（不會拋出 ERR_UNSUPPORTED_ESM_URL_SCHEME）', async () => {
    const target = writeTargetModule('classifier module.js', 'space-in-both-dir-and-filename')
    const driver = fixedDriver(target)
    const { stdout } = await execFileAsync('node', [driver])
    expect(JSON.parse(stdout)).toEqual({ marker: 'space-in-both-dir-and-filename' })
  })

  it('檔名含 Unicode（中文） → 可以正常 import()', async () => {
    const target = writeTargetModule('分類邏輯.js', 'unicode-filename-ok')
    const driver = fixedDriver(target)
    const { stdout } = await execFileAsync('node', [driver])
    expect(JSON.parse(stdout)).toEqual({ marker: 'unicode-filename-ok' })
  })

  it('檔名含 # → pathToFileURL 正確 percent-encode 成 %23，import() 能載到正確的檔案（不會被誤判成 URL fragment）', async () => {
    const target = writeTargetModule('classifier#v2.js', 'hash-in-filename-ok')
    const driver = fixedDriver(target)
    const { stdout } = await execFileAsync('node', [driver])
    expect(JSON.parse(stdout)).toEqual({ marker: 'hash-in-filename-ok' })
  })

  it('檔名含 % → pathToFileURL 正確 percent-encode 成 %25，import() 能載到正確的檔案（不會誤判成未完成的 percent-escape）', async () => {
    const target = writeTargetModule('classifier%complete.js', 'percent-in-filename-ok')
    const driver = fixedDriver(target)
    const { stdout } = await execFileAsync('node', [driver])
    expect(JSON.parse(stdout)).toEqual({ marker: 'percent-in-filename-ok' })
  })
})
