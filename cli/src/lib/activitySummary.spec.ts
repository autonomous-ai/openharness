import { describe, expect, it } from 'vitest'
import { cleanSummary, promptLine, SUMMARY_MAX, summaryOf } from './activitySummary.js'

describe('the one-line summary of an agent', () => {
  it('is the running prompt while it works, whatever it last did', () => {
    expect(summaryOf('working', 'Fix the login', 'Fixed the logout')).toBe('Fix the login')
    expect(summaryOf('working', undefined, 'Fixed the logout')).toBeUndefined()
  })
  it('is the latest recap when idle, else the prompt; nothing known is no summary', () => {
    expect(summaryOf('idle', 'Fix the login', 'Fixed the logout')).toBe('Fixed the logout')
    expect(summaryOf('idle', 'Fix the login', undefined)).toBe('Fix the login')
    expect(summaryOf('unknown', 'Fix the login', undefined)).toBe('Fix the login')
    expect(summaryOf('idle', undefined, undefined)).toBeUndefined()
    expect(summaryOf('idle', '  \n ', '')).toBeUndefined()
  })
  it('is the first non-empty line', () => {
    expect(summaryOf('working', '\n  \nFix the login\nthen the logout', undefined)).toBe('Fix the login')
  })
  it('is cut to SUMMARY_MAX characters with an ellipsis, and a line of exactly that length is whole', () => {
    expect(SUMMARY_MAX).toBe(120)
    const cut = summaryOf('working', 'x'.repeat(500), undefined)!
    expect(cut).toHaveLength(120)
    expect(cut.endsWith('…')).toBe(true)
    expect(summaryOf('working', 'y'.repeat(120), undefined)).toBe('y'.repeat(120))
  })
  it('has no control or format character: a bidi override, an escape sequence, a zero-width space', () => {
    expect(summaryOf('working', 'Fix ‮txt.exe\u001b[31m the​ login\t', undefined)).toBe('Fix txt.exe[31m the login')
    expect(summaryOf('working', '‮​', undefined)).toBeUndefined()
  })
  it('has no line or paragraph separator either: U+2028 and U+2029 would break the row in two', () => {
    expect(summaryOf('working', 'Fix\u2028the\u2029login', undefined)).toBe('Fixthelogin')
  })
  it('is cut by characters, never through a surrogate pair', () => {
    const cut = summaryOf('working', '😀'.repeat(200), undefined)!
    expect([...cut]).toHaveLength(120)
    expect(cut.endsWith('😀…')).toBe(true)
    expect(cut).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/)
    expect(summaryOf('working', '😀'.repeat(120), undefined)).toBe('😀'.repeat(120))
  })
})

describe('what another account sent as a summary', () => {
  it('is cleaned the same way and cut by characters, with no ellipsis; anything but text is nothing', () => {
    expect(cleanSummary('Fix \u202Etxt\u2028x\u001b[2J')).toBe('Fix txt' + 'x[2J')
    expect(cleanSummary('😀'.repeat(200))).toBe('😀'.repeat(120))
    expect(cleanSummary(42)).toBe('')
    expect(cleanSummary('\u2028')).toBe('')
  })
})

describe('the prompt kept for an agent', () => {
  it('is its first non-empty line, capped, and nothing for a blank message', () => {
    expect(promptLine('\n  \nFix the login\nthen more')).toBe('Fix the login')
    expect(promptLine('x'.repeat(5000))).toHaveLength(400)
    expect(promptLine(' \n ')).toBeUndefined()
  })
})
