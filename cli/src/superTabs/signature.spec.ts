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
      // Its markup closed before the colon or after it, its time with seconds, its name in another case (review of #4074).
      ['**Ray:** done.', ['Ray'], 'done.'],
      ['**Ray, 16:25:** done.', ['Ray'], 'done.'],
      ['__Ray:__ done.', ['Ray'], 'done.'],
      ['*Ray*: done.', ['Ray'], 'done.'],
      ['Ray, 16:25:30: done.', ['Ray'], 'done.'],
      ['Juno, 12:17: on it.', ['juno'], 'on it.'],
      // An indented code block on the next line keeps its indent.
      ['Ray:\n    npm test\n    ok', ['Ray'], '    npm test\n    ok'],
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
      // What follows its signature keeps its own markup; a bracket that is no role's words is no signature.
      ['**Ray: done', ['Ray']],
      ['Ray (PR #19): merged.', ['Ray']],
      // An agent's stored name can be only its engine's, which no agent signs with: the post is about the engine.
      ['Claude Code: --resume drops the cwd; Codex keeps it.', ['Ray', 'Claude Code']],
      ['Codex, 16:25: rebuilt.', ['codex']],
    ] as const) {
      expect(unsigned(text, names), text).toBe(text)
    }
    expect(unsigned('Ray, 16:25: done.', [])).toBe('Ray, 16:25: done.')
    expect(unsigned('Ray, 16:25: done.', [undefined, ''])).toBe('Ray, 16:25: done.')
  })
  it('leaves what follows its signature as it is', () => {
    expect(unsigned('Ray: **Heads up**: the train is red.', ['Ray'])).toBe('**Heads up**: the train is red.')
    expect(unsigned('**Ray**: **Heads up**: the train is red.', ['Ray'])).toBe('**Heads up**: the train is red.')
  })
  it('reads a name as a name, never as a pattern', () => {
    expect(unsigned('R.y, 16:25: done.', ['R.y'])).toBe('done.')
    expect(unsigned('Ray, 16:25: done.', ['R.y'])).toBe('Ray, 16:25: done.')
  })
})
