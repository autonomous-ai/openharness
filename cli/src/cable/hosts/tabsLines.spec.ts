import { describe, expect, it } from 'vitest'
import { TYPE_ANSWER_MS, TYPE_APPS, TYPE_LINE_MAX, WRITE_ID, type TabsTyping, typingLine, typingOf, wroteOf } from './tabsLines.js'

const id = '0123456789abcdef'
const tty = '/dev/ttys003'
const write = (text: string, extra: object = {}) => ({ write: { id, app: 'iterm', tty, text, ...extra } })

describe('tabsLines', () => {
  it('only iTerm2 and Ghostty take typed words', () => {
    expect(TYPE_APPS).toEqual(['iterm', 'ghostty'])
    expect(TYPE_LINE_MAX).toBe(65_536)
    expect(TYPE_ANSWER_MS).toBe(3_000)
    expect(WRITE_ID.test(id)).toBe(true)
  })

  it('takes a write and an Enter as they are', () => {
    expect(typingOf(write('hi'))).toEqual(write('hi'))
    const enter = { enter: { id, app: 'ghostty', tty } }
    expect(typingOf(enter)).toEqual(enter)
  })

  it('refuses an app that cannot be typed into', () => {
    for (const app of ['terminal-app', 'vscode']) {
      expect(typingOf({ write: { id, app, tty, text: 'hi' } })).toBeNull()
      expect(typingOf({ enter: { id, app, tty } })).toBeNull()
    }
  })

  it('refuses a tty that is not a macOS tab', () => {
    for (const bad of ['/dev/ttys12345', '/dev/pts/1']) {
      expect(typingOf({ write: { id, app: 'iterm', tty: bad, text: 'hi' } })).toBeNull()
      expect(typingOf({ enter: { id, app: 'iterm', tty: bad } })).toBeNull()
    }
  })

  it('refuses an id that is not 16 lowercase hex', () => {
    for (const bad of ['0123456789abcde', '0123456789abcdef0', '0123456789ABCDEF']) {
      expect(typingOf({ write: { id: bad, app: 'iterm', tty, text: 'hi' } })).toBeNull()
      expect(typingOf({ enter: { id: bad, app: 'iterm', tty } })).toBeNull()
    }
  })

  it('refuses an empty text and one holding a control character', () => {
    // In a row: CONTROL is a global regex, and a check that kept its lastIndex would pass the text after a match.
    for (const bad of ['', 'a\nb', 'a\u007fb', 'a\u0085b']) expect(typingOf(write(bad))).toBeNull()
  })

  it('refuses a key the line does not have', () => {
    expect(typingOf(write('hi', { extra: 1 }))).toBeNull()
    expect(typingOf({ ...write('hi'), extra: 1 })).toBeNull()
    expect(typingOf({ enter: { id, app: 'iterm', tty, text: 'hi' } })).toBeNull()
    expect(typingOf({ ...write('hi'), enter: { id, app: 'iterm', tty } })).toBeNull()
    expect(typingOf({ write: { id, app: 'iterm', tty } })).toBeNull()
    for (const bad of [null, 'write', [write('hi')], {}]) expect(typingOf(bad)).toBeNull()
  })

  it('counts the longest text in UTF-16 units, as every hop does', () => {
    for (const text of ['é'.repeat(20_000), '😀'.repeat(10_000), '中'.repeat(20_000)]) {
      expect(typingOf(write(text))).toEqual(write(text))
    }
    expect(typingOf(write('a'.repeat(20_001)))).toBeNull()
    expect(typingOf(write(`${'😀'.repeat(10_000)}a`))).toBeNull()
  })

  it('passes a cleaned text: line separator, no-break space and replacement character', () => {
    for (const text of ['a b', 'a b', 'a�b']) expect(typingOf(write(text))).toEqual(write(text))
  })

  it('a typing line is its JSON and a newline, at most 64 KiB', () => {
    const longest = write('中'.repeat(20_000)) as TabsTyping
    const line = typingLine(longest)
    expect(line).not.toBeNull()
    expect(line?.endsWith('\n')).toBe(true)
    expect(JSON.parse(line ?? '')).toEqual(longest)
    expect(Buffer.byteLength(line ?? '')).toBeLessThan(TYPE_LINE_MAX)
    expect(typingLine(write('a'.repeat(70_000)) as TabsTyping)).toBeNull()
  })

  it('takes a wrote answer of exactly an id and ok', () => {
    expect(wroteOf({ id, ok: true })).toEqual({ id, ok: true })
    expect(wroteOf({ id, ok: false })).toEqual({ id, ok: false })
    expect(wroteOf({ id, ok: 'true' })).toBeNull()
    expect(wroteOf({ id: 'ABCDEF0123456789', ok: true })).toBeNull()
    expect(wroteOf({ id, ok: true, extra: 1 })).toBeNull()
    for (const bad of [null, id, [id, true], {}]) expect(wroteOf(bad)).toBeNull()
  })
})
