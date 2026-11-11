import { describe, expect, it } from 'vitest'
import { unsigned } from './signature.js'

// anh Dee, 2026-11-11, of the rehearsal's channel: "not like how humans talk on slack … here Ray says 'Ray something
// something' is just weird". The channel shows who wrote a post, and when, beside it.
describe('an agent\'s post without its own signature', () => {
  it('leaves out its name, and a time, at the start', () => {
    for (const [text, names, left] of [
      ['Ray, 16:25: @Cy #20 and #21 are yours.', ['Ray'], '@Cy #20 and #21 are yours.'],
      ['Kai, 11:23: @Ray #9 is up as PR #19.', ['Kai'], '@Ray #9 is up as PR #19.'],
      ['Ray (PM), 15:50: up on M2 and ready.', ['Ray'], 'up on M2 and ready.'],
      ['**Ray**, 16:25: done.', ['Ray'], 'done.'],
      ['Ray: done.', ['Ray'], 'done.'],
      ['Ray, 4:05 UTC: done.', ['Ray'], 'done.'],
      ['  Ray, 16:25:  done.', ['Ray'], 'done.'],
      // A PM signs with its role's name as well as its own.
      ['Product Manager, 16:25: the plan holds.', ['Ray', 'Product Manager'], 'the plan holds.'],
      ['Pip Two, 09:00: on #12.', ['Pip Two'], 'on #12.'],
    ] as const) {
      expect(unsigned(text, names), text).toBe(left)
    }
  })
  it('keeps a post that only starts with its name, someone else\'s name, or nothing after the signature', () => {
    for (const [text, names] of [
      ['Ray, can you read #12?', ['Ray']],
      ['Rayleigh, 16:25: hello', ['Ray']],
      ['Cy, 16:25: done.', ['Ray']],
      ['@Ray, 16:25 is fine for me.', ['Ray']],
      ['Ray, 16:25:', ['Ray']],
      ['The plan, 16:25: holds.', ['Ray']],
    ] as const) {
      expect(unsigned(text, names), text).toBe(text)
    }
    expect(unsigned('Ray, 16:25: done.', [])).toBe('Ray, 16:25: done.')
    expect(unsigned('Ray, 16:25: done.', [undefined, ''])).toBe('Ray, 16:25: done.')
  })
  it('reads a name as a name, never as a pattern', () => {
    expect(unsigned('R.y, 16:25: done.', ['R.y'])).toBe('done.')
    expect(unsigned('Ray, 16:25: done.', ['R.y'])).toBe('Ray, 16:25: done.')
  })
})
