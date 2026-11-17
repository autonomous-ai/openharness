import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { hermesTookPrompt } from './echo.js'

// Hermes 0.21.5 on a Mac (2026-11-17), a program's reply typed into it (#4393): the words in its composer before Enter,
// and its pane a moment after, the words echoed above the composer and its turn running.
const fixture = (name: string) => readFileSync(join(__dirname, '../../lib/__fixtures__', name), 'utf8')
const typed = fixture('hermes-0.21.5-typed.txt')
const taken = fixture('hermes-0.21.5-taken.txt')
const WORDS = 'Reply with exactly the word: bravo'
const RULE = '─'.repeat(40)
const BUSY = '☤ ❯ msg=interrupt · /queue · /bg · /steer · Ctrl+C cancel'
const IDLE = '❯ Summarize what\'s in this folder'
const screen = (...lines: string[]) => [...lines, '─'.repeat(80)].join('\n')

describe('hermesTookPrompt', () => {
  it('reads Hermes taking the words: echoed under its rule, out of the composer, its turn running', () => {
    expect(hermesTookPrompt(taken, WORDS)).toBe(true)
  })

  it('is not taken while the words are still in the composer', () => {
    expect(hermesTookPrompt(typed, WORDS)).toBe(false)
  })

  it('is not taken for other words, nor for none', () => {
    expect(hermesTookPrompt(taken, 'Reply with exactly the word: charlie')).toBe(false)
    expect(hermesTookPrompt(taken, '   ')).toBe(false)
  })

  it('is not taken by an echo of the same words from an earlier turn once Hermes is idle again', () => {
    expect(hermesTookPrompt(screen(RULE, `● ${WORDS}`, RULE, '╭─ ☤ Hermes ─╮', 'bravo', '╰────╯', IDLE), WORDS)).toBe(false)
  })

  it('is not taken by a ● line that is not a submitted message (no rule above it)', () => {
    expect(hermesTookPrompt(screen(`● ${WORDS}`, BUSY), WORDS)).toBe(false)
  })

  it('reads an echo the pane wrapped, and one with Hermes\'s timestamp after it', () => {
    const long = 'Summarize the three most recent commits in this repository and say which files each one changed'
    expect(hermesTookPrompt(screen(RULE, `● ${long.slice(0, 78)}`, long.slice(78), 'Initializing agent...', BUSY), long)).toBe(true)
    expect(hermesTookPrompt(screen(RULE, `● ${WORDS} 12:21`, BUSY), WORDS)).toBe(true)
  })

  it('reads the first line of words on several lines, as Hermes previews them', () => {
    expect(hermesTookPrompt(screen(RULE, '● First line of the task', 'second line', BUSY), 'First line of the task\nsecond line\nthird')).toBe(true)
  })
})
