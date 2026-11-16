import { describe, expect, it } from 'vitest'
import { isNoticeResult, NOTICE_HOUR_MS, noticeFolder, NoticeLimits, noticeLine } from './dialNotice.js'

const clock = () => {
  let at = 0
  return { now: () => at, set: (ms: number) => { at = ms } }
}

describe('noticeLine', () => {
  it('is one trimmed line', () => {
    expect(noticeLine('  Connect the VPN  ')).toBe('Connect the VPN')
    expect(noticeLine('a\nb\r\n\tc')).toBe('a b c')
    expect(noticeLine('a\u0000b')).toBe('a b')
    expect(noticeLine('a\u2028b\u2029c')).toBe('a b c')
    expect(noticeLine('x y z')).toBe('x y z')
    expect(noticeLine(' \n\t ')).toBe('')
  })

  it('cuts past 120 characters, between characters', () => {
    expect(noticeLine('a'.repeat(120))).toBe('a'.repeat(120))
    expect(noticeLine('a'.repeat(121))).toBe(`${'a'.repeat(119)}…`)
    const out = noticeLine('🙏'.repeat(200))
    expect(out).toBe(`${'🙏'.repeat(119)}…`)
    expect([...out].length).toBe(120)
  })
})

describe('noticeFolder', () => {
  it('is a cleaned name of 64 characters at most, with no ellipsis', () => {
    expect(noticeFolder('api')).toBe('api')
    expect(noticeFolder('a\nb')).toBe('a b')
    expect(noticeFolder('x'.repeat(100))).toBe('x'.repeat(64))
    expect(noticeFolder('\u0007')).toBe('')
  })

  // The devices' listener refuses a folder that changes when cleaned again: a cut that leaves a space at the end did.
  it('is what it gives when cleaned again, a cut before a space or a tab too', () => {
    for (const name of [`${'a'.repeat(63)} b`, `${'a'.repeat(63)}\tb`]) {
      expect(noticeFolder(name), JSON.stringify(name)).toBe('a'.repeat(63))
      expect(noticeFolder(noticeFolder(name))).toBe(noticeFolder(name))
    }
    const line = `${'a'.repeat(118)} b${'c'.repeat(10)}`
    expect(noticeLine(noticeLine(line))).toBe(noticeLine(line))
  })
})

describe('isNoticeResult', () => {
  it('takes the three words and nothing else', () => {
    for (const word of ['shown', 'no dial', 'limited']) expect(isNoticeResult(word)).toBe(true)
    for (const other of ['Shown', '', 1, null, undefined]) expect(isNoticeResult(other)).toBe(false)
  })
})

describe('NoticeLimits', () => {
  it('allows one notice a minute for an agent', () => {
    const time = clock()
    const limits = new NoticeLimits(time.now)
    expect(limits.take('a', 'x')).toBe(true)
    time.set(59_999)
    expect(limits.take('a', 'y')).toBe(false)
    time.set(60_000)
    expect(limits.take('a', 'y')).toBe(true)
  })

  it('refuses the same text again within ten minutes', () => {
    const time = clock()
    const limits = new NoticeLimits(time.now)
    expect(limits.take('a', 'x')).toBe(true)
    expect(limits.take('b', 'x')).toBe(true)
    time.set(61_000)
    expect(limits.take('a', 'x')).toBe(false)
    expect(limits.take('a', 'y')).toBe(true)
    time.set(600_000)
    expect(limits.take('a', 'x')).toBe(true)
  })

  it('allows twenty an hour for the computer', () => {
    const time = clock()
    const limits = new NoticeLimits(time.now)
    for (let i = 0; i < 20; i++) {
      time.set(i * 1_000)
      expect(limits.take(`agent-${i}`, 'x')).toBe(true)
    }
    time.set(20_000)
    expect(limits.take('agent-20', 'x')).toBe(false)
    time.set(NOTICE_HOUR_MS)
    expect(limits.take('agent-20', 'x')).toBe(true)
  })

  it('counts nothing for a refusal', () => {
    const time = clock()
    const limits = new NoticeLimits(time.now)
    expect(limits.take('a', 'x')).toBe(true)
    time.set(30_000)
    expect(limits.take('a', 'y')).toBe(false)
    time.set(60_000)
    expect(limits.take('a', 'y')).toBe(true)
  })
})
