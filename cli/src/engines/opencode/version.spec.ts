import { describe, expect, it } from 'vitest'
import { isOpencodeV2, opencodeMajorVersion, parseOpencodeMajor } from './version.js'

describe('parseOpencodeMajor', () => {
  it('reads the major out of what each generation prints for --version', () => {
    // v2 prefixes a name and a `v`; v1 printed the bare number.
    expect(parseOpencodeMajor('opencode v2.0.18\n')).toBe(2)
    expect(parseOpencodeMajor('1.18.31\n')).toBe(1)
  })

  it('answers null for anything that is not a version', () => {
    expect(parseOpencodeMajor('')).toBeNull()
    expect(parseOpencodeMajor('command not found')).toBeNull()
  })
})

describe('isOpencodeV2', () => {
  it('is true from 2 up, and false for v1 or an unknown version', () => {
    expect(isOpencodeV2(2)).toBe(true)
    expect(isOpencodeV2(3)).toBe(true)
    expect(isOpencodeV2(1)).toBe(false)
    expect(isOpencodeV2(null)).toBe(false)
    expect(isOpencodeV2(undefined)).toBe(false)
  })
})

describe('opencodeMajorVersion', () => {
  it('runs --version once per installed binary, and again once the binary changes', () => {
    let calls = 0
    let stamp = 'a'
    const probe = { identity: () => stamp, read: () => { calls++; return stamp === 'a' ? '1.18.31' : 'opencode v2.0.18' } }
    const cache = new Map<string, number | null>()
    expect(opencodeMajorVersion(probe, cache)).toBe(1)
    expect(opencodeMajorVersion(probe, cache)).toBe(1)
    expect(calls).toBe(1)
    // OpenCode updates itself in place (1.18 → 2.0 happened under a running daemon): a new file is a
    // new answer.
    stamp = 'b'
    expect(opencodeMajorVersion(probe, cache)).toBe(2)
    expect(calls).toBe(2)
  })

  it('answers null, without throwing, when the binary is missing or will not answer', () => {
    const cache = new Map<string, number | null>()
    expect(opencodeMajorVersion({ identity: () => null, read: () => { throw new Error('ENOENT') } }, cache)).toBeNull()
    expect(opencodeMajorVersion({ identity: () => 'x', read: () => { throw new Error('timeout') } }, cache)).toBeNull()
  })
})
