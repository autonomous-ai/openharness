import { describe, expect, it, vi } from 'vitest'
import { jsonStringBytes } from './jsonStringBytes.js'

describe('JSON string byte budget', () => {
  it('refuses budgets that cannot admit even the quotes', () => {
    for (const limit of [-1, 0, 1, NaN]) {
      expect(jsonStringBytes('', limit)).toBeNull()
      expect(jsonStringBytes('"', limit)).toBeNull()
    }
  })

  it('includes both quotes and agrees with JSON for every UTF-16 unit and mixed escape boundaries', () => {
    let units = ''
    for (let code = 0; code <= 0xffff; code++) units += String.fromCharCode(code)
    const values = ['', 'plain', units, '"\\\b\t\n\f\r\u0000\u001f中😀\ud800x\udc00'.repeat(256)]
    for (const offset of [4094, 4095, 4096]) {
      for (const suffix of ['😀\ud800x\udc00', '\ud800😀\udc00', '\ud800x', '\ud800\ue000', '\ud800']) {
        values.push('x'.repeat(offset) + suffix + '\u0000"'.repeat(16))
      }
    }
    for (const value of values) {
      const bytes = Buffer.byteLength(JSON.stringify(value))
      expect(jsonStringBytes(value, bytes - 1)).toBeNull()
      expect(jsonStringBytes(value, bytes)).toBe(bytes)
      expect(jsonStringBytes(value, bytes + 1)).toBe(bytes)
    }
  })

  it('refuses an oversized value before scanning or making a temporary encoding', () => {
    const byteLength = vi.spyOn(Buffer, 'byteLength')
    const stringify = vi.spyOn(JSON, 'stringify')
    let result: number | null
    try {
      result = jsonStringBytes('x'.repeat(100), 16)
      expect(byteLength).not.toHaveBeenCalled()
      expect(stringify).not.toHaveBeenCalled()
    } finally { byteLength.mockRestore(); stringify.mockRestore() }
    expect(result!).toBeNull()
  })

  it('refuses the UTF-8 lower bound before encoding fragments when code-unit length fits', () => {
    const stringify = vi.spyOn(JSON, 'stringify')
    let result: number | null
    try {
      result = jsonStringBytes('中'.repeat(16), 18)
      expect(stringify).not.toHaveBeenCalled()
    } finally { stringify.mockRestore() }
    expect(result!).toBeNull()
  })
})
