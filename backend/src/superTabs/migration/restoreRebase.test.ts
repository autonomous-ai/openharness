import { describe, expect, it } from 'vitest'
import { removedLines } from '../instructionsDiff.js'
import { rebasedDocument } from '../instructionsRebase.js'
import { restoredDocument } from './restoreRebase.js'

// Task #3679 (anh Dee, P0): the first move onto the new base lost the lines no person's name guarded. A project moved by it is given
// those lines back, word for word, appended to the document it has now.
const BEFORE = `# Project instructions

## Rules for every agent

- Never run a test that signs the Mac out of the real CLI; Desktop tests use a memory store and a fake sign-in.
- Stop only processes you started, by id, never by name or pattern.
- Owns the product (Dee, 2026-11-03).

## PM schedule

- Every 30 minutes, the open-task sweep: every open task ends with an owner working on it,
  a question to a person, or a close with its reason.

## Routing

### Order and quota

- Every assignment picks in this order:
  1. What the work needs.
  2. Every account is used while it has weekly quota left.
`

/** What the first run wrote: only what a person's name guarded. */
const MOVED = rebasedDocument(BEFORE, '', 'rules').text

describe('the lines a project is given back after the first move (#3679)', () => {
  it('appends every line the move lost, word for word, under the section it came from', () => {
    expect(removedLines(BEFORE, MOVED).length).toBeGreaterThan(4)
    const { text, lines } = restoredDocument(BEFORE, MOVED, 80)
    expect(lines).toEqual(removedLines(BEFORE, MOVED))
    expect(text.startsWith(MOVED.trimEnd())).toBe(true)
    expect(text).toContain('## Restored lines')
    expect(text).toContain('### Rules for every agent\n\n- Never run a test that signs the Mac out of the real CLI; Desktop tests use a memory store and a fake sign-in.\n- Stop only processes you started, by id, never by name or pattern.')
    expect(text).toContain('### PM schedule\n\n- Every 30 minutes, the open-task sweep: every open task ends with an owner working on it, a question to a person, or a close with its reason.')
    expect(text).toContain('### Routing › Order and quota\n\n- Every assignment picks in this order:')
    // Nothing of the old document is lost now, and nothing the project has is removed.
    expect(removedLines(BEFORE, text)).toEqual([])
    expect(removedLines(MOVED, text)).toEqual([])
  })

  it('has nothing to give back to a document that lost nothing, and gives back nothing twice', () => {
    const whole = rebasedDocument(BEFORE).text
    expect(restoredDocument(BEFORE, whole, 80)).toEqual({ text: whole, lines: [] })
    const once = restoredDocument(BEFORE, MOVED, 80)
    expect(restoredDocument(BEFORE, once.text, 80)).toEqual({ text: once.text, lines: [] })
  })
})
