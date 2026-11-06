import { describe, expect, it } from 'vitest'
import { removedLines } from '../instructionsDiff.js'
import { rebasedDocument } from '../instructionsRebase.js'
import { INSTRUCTIONS_TEMPLATE } from '../instructionsTemplate.js'
import { moveLoss, restoredDocument, stillMissing, templateLines } from './restoreRebase.js'

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

  // Review of #3327: a project saved since the move (the daily tidy is a save) is given back what the move lost, and never what its own
  // later save chose to drop.
  it('gives back only what the move lost, never a line a later save dropped', () => {
    const lostByMove = removedLines(BEFORE, MOVED)
    const loss = moveLoss(BEFORE, MOVED)
    // A later save of the PM: it kept the moved document and dropped nothing the move had kept; here it added a line.
    const later = `${MOVED.trimEnd()}\n\n- The PM's own note.\n`
    const { text, lines } = restoredDocument(BEFORE, later, 80, loss)
    expect(lines).toEqual(lostByMove)
    expect(text).toContain('- The PM\'s own note.')
    // A line the later save dropped from the moved document is not the move's loss: it stays dropped.
    const withoutOwn = MOVED.replace(/^.*Owns the product.*$/m, '')
    expect(removedLines(BEFORE, withoutOwn)).toContain('Owns the product (Dee, 2026-11-03).')
    expect(restoredDocument(BEFORE, withoutOwn, 80, loss).lines).not.toContain('Owns the product (Dee, 2026-11-03).')
  })

  // Review round 2 of #3327 (Rowan): the move's loss is counted per line, since a line may sit in two sections.
  it('puts back a line only as often as the move lost it, never a copy a later save dropped', () => {
    const before = '# P\n\n## A\n\n- Never X.\n\n## B\n\n- Never X.\n- Keep Y (Ken, 2026-11-02).\n'
    // The move kept A's copy of X and lost B's.
    const moved = '# P\n\n## A\n\n- Never X.\n\n## B\n\n- Keep Y (Ken, 2026-11-02).\n'
    const loss = moveLoss(before, moved)
    expect([...loss]).toEqual([['Never X.', 1]])
    // The PM's later save dropped A's copy too: only the move's one copy comes back, once.
    const later = '# P\n\n## B\n\n- Keep Y (Ken, 2026-11-02).\n'
    expect(restoredDocument(before, later, 80, loss).lines).toEqual(['Never X.'])
    expect(stillMissing(before, later, loss).map((l: { text: string }) => l.text)).toEqual(['Never X.'])
  })

  it('knows a PM that put one lost line back by hand, though another was lost twice', () => {
    const before = '# P\n\n## A\n\n- Never X.\n- Keep Y.\n\n## B\n\n- Never X.\n'
    const moved = '# P\n'
    const loss = moveLoss(before, moved)
    expect([...loss]).toEqual([['Never X.', 2], ['Keep Y.', 1]])
    // The PM restored Y alone: two of the three lost lines are still missing, so it is not the move's whole loss.
    const byHand = '# P\n\n- Keep Y.\n'
    expect(stillMissing(before, byHand, loss)).toHaveLength(2)
    expect([...loss.values()].reduce((a, b) => a + b, 0)).toBe(3)
  })

  // Second review of #3327 (Linuxtest2): a project that began from the old template lost the template's own process lines too (54 lines,
  // 9 KB), which the Swarm builds in now. The restore treats the template as process, as the move does, and gives back the project's own.
  it('does not give back a line of the Swarm\'s own template, and still gives back the project\'s own safety line', () => {
    const own = templateLines()
    expect(own.size).toBeGreaterThan(20)
    const template = [...own][0]!
    const before = `# P\n\n## Process\n\n- ${template}\n\n## Rules for every agent\n\n- Never run a test that signs the Mac out of the real CLI.\n`
    const moved = '# P\n'
    const loss = moveLoss(before, moved)
    expect([...loss.keys()]).toEqual(['Never run a test that signs the Mac out of the real CLI.'])
    expect(restoredDocument(before, moved, 80, loss).lines).toEqual(['Never run a test that signs the Mac out of the real CLI.'])
    // The template's lines are really the template's.
    expect(INSTRUCTIONS_TEMPLATE).toContain(template.slice(0, 30))
  })
})

