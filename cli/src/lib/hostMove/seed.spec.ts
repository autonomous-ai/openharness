import { describe, expect, it } from 'vitest'
import { seedFromCapture, SEED_HISTORY_LINES, SEED_MAX_BYTES } from './seed.js'

describe('seedFromCapture', () => {
  it('keeps every line under the cap', () => {
    expect(seedFromCapture('a\nb\nc')).toBe('a\r\nb\r\nc')
    expect(SEED_MAX_BYTES).toBe(4 * 1024 * 1024)
    expect(SEED_HISTORY_LINES).toBe(2000)
    const text = Array.from({ length: 500 }, () => 'x'.repeat(99)).join('\n')
    expect(Buffer.byteLength(seedFromCapture(text, 1000))).toBeLessThanOrEqual(1000)
  })

  it('drops the oldest lines first', () => {
    expect(seedFromCapture('one\ntwo\nthree\nfour', 12)).toBe('three\r\nfour')
    expect(seedFromCapture('one\ntwo\nthree\nfour', 9)).toBe('four')
    expect(seedFromCapture('one\ntwo\nthree', 3)).toBe('')
  })

  it('uses CRLF', () => {
    expect(seedFromCapture('a\r\nb\nc\r\n')).toBe('a\r\nb\r\nc')
  })
})
