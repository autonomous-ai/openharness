import { describe, expect, it } from 'vitest'
import {
  composeNotice, isNoticeResult, NOTICE_HOUR_MS, noticeFolder, noticeKind, NoticeLimits, noticeLine, parseNotice,
} from './dialNotice.js'

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

describe('parseNotice', () => {
  it('the words parse into the question, the suggestion, the state and --json', () => {
    expect(parseNotice(['Which', 'DB?', '--suggest', ' Postgres ', '--proceeding', '--json']))
      .toEqual({ question: 'Which DB?', suggest: ' Postgres ', state: 'proceeding', json: true })
    expect(parseNotice(['Q', '--suggest'])).toEqual({ question: 'Q', json: false })
    expect(parseNotice(['--waiting', '--proceeding', '-x', 'Q'])).toEqual({ question: '-x Q', state: 'waiting', json: false })
  })

  it('--help or -h as the whole question is no question; elsewhere it is text', () => {
    expect(parseNotice(['--help'])).toEqual({ question: '', json: false })
    expect(parseNotice(['-h', '--json'])).toEqual({ question: '', json: true })
    expect(parseNotice(['Does', '--help', 'work?'])).toEqual({ question: 'Does --help work?', json: false })
  })
})

describe('composeNotice', () => {
  const Q = 'Which cache for the user lookup?'
  const S = 'in-process LRU'
  // The devices' listener drops a line that noticeLine would change: the CLI would print `no dial` with no ring.
  const shown = (line: string): string => {
    expect(noticeLine(line), JSON.stringify(line)).toBe(line)
    return line
  }

  it.each([
    [S, 'waiting', `Waiting · ${Q} · Suggest: ${S}`],
    [undefined, 'waiting', `Waiting · ${Q}`],
    [S, 'proceeding', `Proceeding · ${Q} · Doing: ${S}`],
    [undefined, 'proceeding', `Proceeding · ${Q}`],
    [S, undefined, `${Q} · Suggest: ${S}`],
    [undefined, undefined, Q],
  ] as const)('suggest %s, state %s', (suggest, state, line) => {
    expect(shown(composeNotice(Q, suggest, state))).toBe(line)
  })

  it('keeps a suggestion of 40 letters at most', () => {
    expect(shown(composeNotice('Q', 'x'.repeat(40)))).toBe(`Q · Suggest: ${'x'.repeat(40)}`)
    expect(shown(composeNotice('Q', 'x'.repeat(41)))).toBe(`Q · Suggest: ${'x'.repeat(39)}…`)
  })

  it('drops the space before a cut suggestion\'s ellipsis', () => {
    expect(shown(composeNotice('Q', `${'a'.repeat(38)} bbbbbbb`, 'proceeding'))).toBe(`Proceeding · Q · Doing: ${'a'.repeat(38)}…`)
  })

  it('cuts the question so the line is 120 letters', () => {
    const line = shown(composeNotice('q'.repeat(200), 'LRU', 'proceeding'))
    expect(line).toBe(`Proceeding · ${'q'.repeat(93)}… · Doing: LRU`)
    expect([...line].length).toBe(120)
  })

  it('cuts the question so the line is 239 bytes', () => {
    const line = shown(composeNotice('ữ'.repeat(100), 'Dùng Redis', 'waiting'))
    expect(line).toBe(`Waiting · ${'ữ'.repeat(67)}… · Suggest: Dùng Redis`)
    expect(Buffer.byteLength(line)).toBe(239)
  })

  it('drops the spaces before a cut question\'s ellipsis', () => {
    expect(shown(composeNotice(`${'a'.repeat(92)}   ${'b'.repeat(30)}`, 'LRU', 'proceeding')))
      .toBe(`Proceeding · ${'a'.repeat(92)}… · Doing: LRU`)
  })

  it('never cuts inside a surrogate pair', () => {
    const line = shown(composeNotice('🙏'.repeat(100)))
    expect(line).toBe(`${'🙏'.repeat(59)}…`)
    expect(Buffer.byteLength(line)).toBe(239)
    expect(line).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/)
  })

  it('cleans each part', () => {
    expect(shown(composeNotice('Which\nDB?', ' a\t b ', 'waiting'))).toBe('Waiting · Which DB? · Suggest: a b')
    expect(composeNotice(' \n ', 'x', 'waiting')).toBe('')
    expect(shown(composeNotice('Q', ' \t ', 'proceeding'))).toBe('Proceeding · Q')
  })
})

describe('noticeKind', () => {
  it('reads the state from the opening', () => {
    expect(noticeKind('Waiting · x')).toBe('waiting')
    expect(noticeKind('Proceeding · Q · Doing: S')).toBe('proceeding')
    for (const line of ['Waiting for CI', 'Proceeding·x', 'x']) expect(noticeKind(line), line).toBe('plain')
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

  // A quiet card makes no beep: the hour bounds beeps, the agent's own limits bound a loop.
  it('a quiet take counts for its agent and never for the hour', () => {
    const time = clock()
    const limits = new NoticeLimits(time.now)
    for (let i = 0; i < 20; i++) expect(limits.take(`agent-${i}`, 'x')).toBe(true)
    expect(limits.take('q', 'x', false)).toBe(true)
    expect(limits.take('agent-20', 'x')).toBe(false)
    time.set(59_999)
    expect(limits.take('q', 'y', false)).toBe(false)
    expect(limits.take('q', 'y')).toBe(false)
    time.set(60_000)
    expect(limits.take('q', 'y')).toBe(false)
    expect(limits.take('q', 'y', false)).toBe(true)
  })

  it('quiet takes leave the hour\'s twenty for rings', () => {
    const limits = new NoticeLimits(clock().now)
    for (let i = 0; i < 25; i++) expect(limits.take(`quiet-${i}`, 'x', false)).toBe(true)
    for (let i = 0; i < 20; i++) expect(limits.take(`agent-${i}`, 'x')).toBe(true)
    expect(limits.take('agent-20', 'x')).toBe(false)
  })

  it('a quiet take holds its line for ten minutes', () => {
    const time = clock()
    const limits = new NoticeLimits(time.now)
    expect(limits.take('a', 'L', false)).toBe(true)
    time.set(599_999)
    expect(limits.take('a', 'L')).toBe(false)
    time.set(600_000)
    expect(limits.take('a', 'L')).toBe(true)
  })
})
