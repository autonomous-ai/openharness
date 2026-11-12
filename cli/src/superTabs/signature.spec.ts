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
      // From its first word: the server trims a post's ends, so no indent kept here would reach anyone (review of #4074).
      ['Ray:\n\n    done.', ['Ray'], 'done.'],
      ['Ray, 4:05 pm: done.', ['Ray'], 'done.'],
    ] as const) {
      expect(unsigned(text, names), text).toBe(left)
    }
  })
  // anh Dee, 2026-11-12, of Lennox's "@Devon Lennox: Flutter 3.47.2 … is now on Mac 3": "why does lenox put 'Lenox:' there. it's
  // awkward. no human conversation is like that on slack". The signature came after the person it was addressed to.
  it('leaves out its signature after the mentions a post opens with, and keeps the mentions', () => {
    for (const [text, names, left] of [
      ['@Devon Lennox: Flutter 3.47.2 is now on Mac 3.', ['Lennox'], '@Devon Flutter 3.47.2 is now on Mac 3.'],
      ['@Devon @Cy Lennox, 16:25: ready for #4208.', ['Lennox'], '@Devon @Cy ready for #4208.'],
      ['@Devon **Lennox:** ready.', ['Lennox'], '@Devon ready.'],
      ['  @Devon   Lennox: ready.', ['Lennox'], '@Devon ready.'],
      ['@Devon\n\nLennox: ready.\n\nSecond.', ['Lennox'], '@Devon ready.\n\nSecond.'],
      // What follows opens a block: the mentions keep a line of their own, or it no longer renders (review of #4210), as the
      // server joins tags and a post (backend mentions.ts withTags).
      ['@Devon Lennox:\n\n- one\n- two', ['Lennox'], '@Devon\n\n- one\n- two'],
      ['@Devon Lennox:\n```\nnpm test\n```', ['Lennox'], '@Devon\n\n```\nnpm test\n```'],
      ['@Devon Lennox:\n## Plan\nship', ['Lennox'], '@Devon\n\n## Plan\nship'],
      ['@Devon Lennox:\n| a | b |\n|---|---|', ['Lennox'], '@Devon\n\n| a | b |\n|---|---|'],
      ['@Devon Lennox:\n\n    npm test\n    npm run build', ['Lennox'], '@Devon\n\n    npm test\n    npm run build'],
      ['@Devon Lennox:\n> quoted', ['Lennox'], '@Devon\n\n> quoted'],
      ['@Devon Lennox:\n1. one\n2. two', ['Lennox'], '@Devon\n\n1. one\n2. two'],
      // Spaces on the signature's own line are no indent: the text after them is a paragraph.
      ['@Devon Lennox:     ready', ['Lennox'], '@Devon ready'],
      // A block marker on the signature's own line was inline text, and stays so (the third review of #4210).
      ['@Devon Lennox: 1. merged #4208, 2. next', ['Lennox'], '@Devon 1. merged #4208, 2. next'],
      ['@Devon Lennox: > 90% pass now', ['Lennox'], '@Devon > 90% pass now'],
      ['@Devon Lennox: # of tests is 5', ['Lennox'], '@Devon # of tests is 5'],
    ] as const) {
      expect(unsigned(text, names), text).toBe(left)
    }
    // A mention then its name as a word, someone else's name, or nothing after it: no signature.
    for (const [text, names] of [
      ['@Devon Lennox, can you read #12?', ['Lennox']],
      ['@Devon Cy: done.', ['Lennox']],
      ['@Devon Lennox:', ['Lennox']],
      ['@Lennox: done.', ['Lennox']],
    ] as const) {
      expect(unsigned(text, names), text).toBe(text)
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
      // A name written as no name is, and a time's word that is no zone, say something (review of #4074): Vale is a linter.
      ['vale: 3 errors in README.md', ['Vale']],
      ['dune: build failed', ['Dune']],
      ['dev: vite\nbuild: vite build', ['dev']],
      ['Ray, 9:00 call: agenda', ['Ray']],
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
  // A name only of markup, which a rename allows, took 3 s on a post of 200,000 underscores (review of #4074).
  it('reads a long post at once, whatever the name', () => {
    const started = performance.now()
    expect(unsigned('_'.repeat(200_000), ['__'])).toBe('_'.repeat(200_000))
    expect(performance.now() - started).toBeLessThan(250)
  })
  it('reads a name as a name, never as a pattern', () => {
    expect(unsigned('R.y, 16:25: done.', ['R.y'])).toBe('done.')
    expect(unsigned('Ray, 16:25: done.', ['R.y'])).toBe('Ray, 16:25: done.')
  })
})
