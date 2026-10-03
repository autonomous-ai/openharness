import { describe, expect, it } from 'vitest'
import { decodeTmuxControlBytes, parseTmuxControlOutput } from './tmuxStream.js'

describe('tmux output byte fidelity and ownership', () => {
  it('decodes every three-digit octal value with the existing byte truncation', () => {
    const wire = Array.from({ length: 512 }, (_, n) => `\\${n.toString(8).padStart(3, '0')}`).join('')
    const expected = Buffer.from(Array.from({ length: 512 }, (_, n) => n & 0xff))
    expect(Buffer.from(decodeTmuxControlBytes(Buffer.from(wire)))).toEqual(expected)
  })

  it.each(['', '\\', '\\0', '\\00', '\\/00', '\\800', '\\0/0', '\\080', '\\00/', '\\008', 'C:\\Users\\name'])
  ('keeps incomplete or non-octal input %j unchanged', wire => {
    expect(Buffer.from(decodeTmuxControlBytes(Buffer.from(wire)))).toEqual(Buffer.from(wire))
  })

  it('keeps bytes on both sides of escapes, including adjacent literal backslashes', () => {
    expect(Buffer.from(decodeTmuxControlBytes(Buffer.from('before\\\\033middle\\134after\\040\\012tail'))))
      .toEqual(Buffer.from('before\\\x1bmiddle\\after \ntail'))
  })

  it.each(['plain 世界', 'start\\033[31mred\\033[0m', '\\000'.repeat(5_000)])
  ('owns the decoded bytes and never changes a nonzero-offset input view', wire => {
    const storage = Buffer.concat([Buffer.from('prefix'), Buffer.from(wire), Buffer.from('suffix')])
    const before = Buffer.from(storage)
    const input = new Uint8Array(storage.buffer, storage.byteOffset + 6, Buffer.byteLength(wire))
    const decoded = decodeTmuxControlBytes(input)
    const copy = Buffer.from(decoded)
    expect(storage).toEqual(before)
    input.fill(0x78)
    expect(Buffer.from(decoded)).toEqual(copy)
    decoded.fill(0x79)
    expect(Buffer.from(input)).toEqual(Buffer.alloc(input.length, 0x78))
    expect(storage.subarray(0, 6).toString()).toBe('prefix')
    expect(storage.subarray(-6).toString()).toBe('suffix')
  })

  it('does not retain a large escape-only wire buffer for a small decoded frame', () => {
    const wire = Buffer.from('\\033'.repeat(32_000))
    const decoded = decodeTmuxControlBytes(wire)
    expect(Buffer.from(decoded)).toEqual(Buffer.alloc(32_000, 0x1b))
    expect(decoded.buffer.byteLength).toBeLessThanOrEqual(2 * decoded.byteLength)
  })

  it('preserves Unicode bytes split at every position across output notifications', () => {
    const bytes = Buffer.from('─世界🚀é')
    for (let split = 0; split <= bytes.length; split++) {
      const first = parseTmuxControlOutput(Buffer.concat([Buffer.from('%output %7 '), bytes.subarray(0, split)]))
      const second = parseTmuxControlOutput(Buffer.concat([Buffer.from('%extended-output %7 0 : '), bytes.subarray(split)]))
      expect(first?.paneId).toBe('%7')
      expect(second?.paneId).toBe('%7')
      expect(Buffer.concat([Buffer.from(first!.data), Buffer.from(second!.data)])).toEqual(bytes)
    }
  })

  it('matches the byte-oriented octal contract for deterministic arbitrary inputs', () => {
    let seed = 0x74_6d_75_78
    const random = () => {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0
      return seed >>> 8
    }
    for (let round = 0; round < 1_000; round++) {
      const input: number[] = []
      for (let i = 0, count = random() % 1_024; i < count; i++) {
        if (random() % 4 === 0) input.push(0x5c, 0x30 + random() % 8, 0x30 + random() % 8, 0x30 + random() % 8)
        else input.push(random() % 256)
      }
      const wire = Buffer.from(input)
      // latin1 maps each byte to one code unit. This independent reference does
      // no UTF-8 conversion and leaves every non-three-digit escape untouched.
      const expected = Buffer.from(wire.toString('latin1').replace(/\\([0-7]{3})/g,
        (_, digits: string) => String.fromCharCode(Number.parseInt(digits, 8) & 0xff)), 'latin1')
      expect(Buffer.from(decodeTmuxControlBytes(wire))).toEqual(expected)
    }
  })
})
