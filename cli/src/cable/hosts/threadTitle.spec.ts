import { describe, expect, it } from 'vitest'
import { THREAD_TITLE_MAX, threadTitleOf } from './threadTitle.js'

// The other half of this test is Harness Device's `a_thread_line_is_the_title_or_the_empty_title` (follow.rs): both
// sides keep the same titles, so the two never disagree. Rust alone also empties a title whose line passes 512 bytes:
// that cut is PIPE_BUF, the stdin pipe's limit, not the listener's, so here those titles pass.
describe('threadTitleOf', () => {
  it('the same titles as Harness Device', () => {
    const kept = ['a'.repeat(256), '🦀'.repeat(124), '一'.repeat(166), '"'.repeat(249), 'a"b', 'a\\b', '']
    const cutByRustBytesAlone = ['🦀'.repeat(125), '🦀'.repeat(128), '一'.repeat(167), '"'.repeat(250)]
    for (const title of [...kept, ...cutByRustBytesAlone]) expect(threadTitleOf(title)).toBe(title)
    const outOfRule = ['a'.repeat(257), '🦀'.repeat(129), 'a\nb', 'a\u007f', 'a\u0085', 'a\u009f', '\u0000']
    for (const title of outOfRule) expect(threadTitleOf(title)).toBeNull()
    for (const value of [5, null, {}, []]) expect(threadTitleOf(value)).toBeNull()
    expect(THREAD_TITLE_MAX).toBe(256)
  })
})
