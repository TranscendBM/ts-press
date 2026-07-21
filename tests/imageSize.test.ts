import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { readImageInfo, scaleToWidth } from '../shared/imageSize'

describe('readImageInfo', () => {
  it('讀得出專案內建 logo 的實際尺寸', () => {
    const dark = readImageInfo(readFileSync('public/logo-dark.png'))
    expect(dark).toEqual({ format: 'png', width: 340, height: 64 })

    const white = readImageInfo(readFileSync('public/logo-white.png'))
    expect(white).toEqual({ format: 'png', width: 582, height: 64 })
  })

  it('辨識 GIF 的小端序寬高', () => {
    const gif = new Uint8Array(16)
    gif.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 0)
    gif[6] = 0x20 // width = 32
    gif[7] = 0x00
    gif[8] = 0x10 // height = 16
    gif[9] = 0x00
    expect(readImageInfo(gif)).toEqual({ format: 'gif', width: 32, height: 16 })
  })

  it('掃描 JPEG 的 SOF 區段取得寬高', () => {
    // FFD8 + 一個 APP0 區段 + SOF0(0xC0)
    const jpg = new Uint8Array([
      0xff, 0xd8,
      0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, // APP0，長度 4
      0xff, 0xc0, 0x00, 0x11, 0x08,
      0x00, 0x64, // height = 100
      0x00, 0xc8, // width = 200
      0x03, 0x01, 0x22, 0x00,
    ])
    expect(readImageInfo(jpg)).toEqual({ format: 'jpg', width: 200, height: 100 })
  })

  it('DHT(0xC4) 不可被誤認為 SOF', () => {
    const jpg = new Uint8Array([
      0xff, 0xd8,
      0xff, 0xc4, 0x00, 0x06, 0x00, 0x00, 0x00, 0x00, // DHT
      0xff, 0xc0, 0x00, 0x11, 0x08,
      0x00, 0x0a, // height = 10
      0x00, 0x14, // width = 20
      0x03, 0x01, 0x22, 0x00,
    ])
    expect(readImageInfo(jpg)).toEqual({ format: 'jpg', width: 20, height: 10 })
  })

  it('無法辨識的內容回傳 null 而非丟出例外', () => {
    expect(readImageInfo(new Uint8Array([1, 2, 3]))).toBeNull()
    expect(readImageInfo(new Uint8Array(32))).toBeNull()
    expect(readImageInfo(new TextEncoder().encode('<svg></svg>'))).toBeNull()
  })
})

describe('scaleToWidth', () => {
  it('等比例縮放', () => {
    expect(
      scaleToWidth({ format: 'png', width: 340, height: 64 }, 120),
    ).toEqual({ width: 120, height: 23 })
  })

  it('極扁的圖高度至少為 1', () => {
    expect(
      scaleToWidth({ format: 'png', width: 1000, height: 1 }, 10).height,
    ).toBe(1)
  })
})
