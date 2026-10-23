import { describe, expect, it } from 'vitest'
import { MAX_FRAME } from '../ptyHost/protocol.js'
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
    // Each break costs four: `\r\n` as the create request's JSON writes it.
    expect(seedFromCapture('one\ntwo\nthree\nfour', 13)).toBe('three\r\nfour')
    expect(seedFromCapture('one\ntwo\nthree\nfour', 12)).toBe('four')
    expect(seedFromCapture('one\ntwo\nthree', 3)).toBe('')
  })

  it('caps the seed as the create request carries it: JSON, where each ESC is six bytes', () => {
    // 3 MB of colour codes: under the cap raw, but escaped as `\u001b` six times that, past the host's 8 MB frame.
    const line = '\x1b[31mx\x1b[0m'.repeat(100)
    const text = Array.from({ length: 3 * 1024 * 1024 / line.length }, () => line).join('\n')
    const seed = seedFromCapture(text)
    expect(seed.length).toBeGreaterThan(0)
    expect(Buffer.byteLength(JSON.stringify(seed))).toBeLessThanOrEqual(SEED_MAX_BYTES + 2)
    expect(SEED_MAX_BYTES).toBeLessThanOrEqual(MAX_FRAME / 2)
    // Non-ASCII text is its UTF-8 bytes in JSON too.
    expect(seedFromCapture('\u00e9\u00e9\n\u00e9', 2)).toBe('\u00e9')
  })

  it('uses CRLF', () => {
    expect(seedFromCapture('a\r\nb\nc\r\n')).toBe('a\r\nb\r\nc')
  })
})
