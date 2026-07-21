/**
 * 從圖片位元組直接解析格式與尺寸。
 *
 * 先前用 createImageBitmap 與 img.decode() 量尺寸，兩者都會在某些瀏覽器
 * 靜默失敗或永不 resolve，導致 Word 匯出整個卡住、或圖片被無聲丟掉。
 * 直接讀檔頭沒有非同步、沒有 DOM 依賴，也能在 Node 裡單獨測試。
 */

export type ImageFormat = 'png' | 'jpg' | 'gif' | 'bmp'

export interface ImageInfo {
  format: ImageFormat
  width: number
  height: number
}

function u16be(b: Uint8Array, i: number) {
  return (b[i] << 8) | b[i + 1]
}
function u32be(b: Uint8Array, i: number) {
  return ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0
}
function u16le(b: Uint8Array, i: number) {
  return b[i] | (b[i + 1] << 8)
}
function u32le(b: Uint8Array, i: number) {
  return (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0
}

/** 無法辨識或檔頭不完整時回傳 null，呼叫端應略過該圖而非中斷流程。 */
export function readImageInfo(input: ArrayBuffer | Uint8Array): ImageInfo | null {
  const b = input instanceof Uint8Array ? input : new Uint8Array(input)
  if (b.length < 16) return null

  // PNG: 89 50 4E 47 0D 0A 1A 0A，IHDR 的寬高固定在 16 與 20
  if (
    b[0] === 0x89 &&
    b[1] === 0x50 &&
    b[2] === 0x4e &&
    b[3] === 0x47 &&
    b.length >= 24
  ) {
    const width = u32be(b, 16)
    const height = u32be(b, 20)
    return width && height ? { format: 'png', width, height } : null
  }

  // GIF: 'GIF8'，寬高是小端序
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
    const width = u16le(b, 6)
    const height = u16le(b, 8)
    return width && height ? { format: 'gif', width, height } : null
  }

  // BMP: 'BM'
  if (b[0] === 0x42 && b[1] === 0x4d && b.length >= 26) {
    const width = u32le(b, 18)
    const height = u32le(b, 22)
    return width && height ? { format: 'bmp', width, height } : null
  }

  // JPEG: FF D8，逐段掃到 SOFn 取寬高
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) {
        i += 1
        continue
      }
      const marker = b[i + 1]
      // 填充位元組
      if (marker === 0xff) {
        i += 1
        continue
      }
      // SOF0–SOF15，但 C4(DHT)、C8(JPG)、CC(DAC) 不是
      const isSof =
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc
      if (isSof) {
        const height = u16be(b, i + 5)
        const width = u16be(b, i + 7)
        return width && height ? { format: 'jpg', width, height } : null
      }
      const len = u16be(b, i + 2)
      if (len < 2) return null
      i += 2 + len
    }
    return null
  }

  return null
}

/** 依指定寬度等比例縮放，高度至少 1。 */
export function scaleToWidth(info: ImageInfo, width: number) {
  return {
    width,
    height: Math.max(1, Math.round((info.height / info.width) * width)),
  }
}
