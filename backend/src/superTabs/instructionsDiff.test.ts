import { describe, expect, it } from 'vitest'
import { instructionsChange, CHANGE_ITEMS, ITEM_CHARS } from './instructionsDiff.js'

/** The words every line of a change starts with: none can open a Markdown block (a heading, list, quote, code or table). */
const LINE_START = /^(?:In .+:|Added: |Removed: |Added section: |Removed section: |and \d+ more changes?\.$|$)/

describe('instructionsChange', () => {
  // Ken, 11-05 (#3021): instructions wrap at about 120 characters, so one bullet spans several lines; a one-word edit rewraps
  // it. Compared by line, it showed fragments, none of them the bullet's start. Compared by item, it shows the whole rule.
  it('shows a rewrapped bullet\'s whole old and new words, under the section it sits in', () => {
    const before = '# Project instructions\n\n## Routing\n\n### Models\n\n- No agent runs below high effort,\n  and none on Haiku.\n- Reviewers run on Opus.'
    const after = '# Project instructions\n\n## Routing\n\n### Models\n\n- No agent runs below high\n  effort, and none on Claude Haiku.\n- Reviewers run on Opus.'
    expect(instructionsChange(before, after)).toBe('In Routing › Models:\nRemoved: No agent runs below high effort, and none on Haiku.\n'
      + 'Added: No agent runs below high effort, and none on Claude Haiku.')
  })

  it('shows nothing for a rewrap or spacing alone, and says so', () => {
    const before = '## Workflow\n\nThe PM opens each task with its goal and\n"Done when".\n\n- One request is one task.'
    expect(instructionsChange(before, '## Workflow\n\n\nThe PM opens each task\nwith its goal and "Done when".\n- One request is one task.\n'))
      .toBe('Only spacing and line breaks changed.')
  })

  it('joins a paragraph\'s wrapped lines into one item', () => {
    expect(instructionsChange('Intro.\n\nEvery agent works by these\ninstructions.', 'Intro.\n\nEvery agent works by these\ninstructions, always.'))
      .toBe('Removed: Every agent works by these instructions.\nAdded: Every agent works by these instructions, always.')
  })

  it('shows 12 items of a long change, then how many more changes there are', () => {
    const rules = Array.from({ length: 20 }, (_, i) => `- Rule ${i + 1}.`)
    const change = (n: number) => instructionsChange('## Rules\n\n- Rule 0.', ['## Rules', '', '- Rule 0.', ...rules.slice(0, n)].join('\n'))
    expect(CHANGE_ITEMS).toBe(12)
    expect(change(20)).toBe(['In Rules:', ...rules.slice(0, 12).map(r => `Added: ${r.slice(2)}`), '', 'and 8 more changes.'].join('\n'))
    expect(change(13).endsWith('\n\nand 1 more change.')).toBe(true)
    expect(change(12)).not.toContain('more change')
  })

  it('drops list markers, so a numbered step inserted shows alone and the steps renumbered after it do not', () => {
    expect(instructionsChange('## Workflow\n\n1. Plan.\n2. Build.\n3. Ship.', '## Workflow\n\n1. Plan.\n2. Test first.\n3. Build.\n4. Ship.'))
      .toBe('In Workflow:\nAdded: Test first.')
  })

  it('names each change\'s own section, a section added too', () => {
    const before = '# Doc\n\n## Roles\n\n### PM\n\n- Talks with people.\n\n## Routing\n\n- Opus builds.'
    const after = '# Doc\n\n## Roles\n\n### PM\n\n- Talks with people.\n- Merges work.\n\n## Routing\n\n- Opus builds.\n\n### Testers\n\n- A Mac for Desktop.'
    expect(instructionsChange(before, after)).toBe('In Roles › PM:\nAdded: Merges work.\n\nIn Routing:\nAdded section: Testers\n\n'
      + 'In Routing › Testers:\nAdded: A Mac for Desktop.')
  })

  it('keeps a saved item\'s Markdown from opening a block in the chat', () => {
    const change = instructionsChange('A.', 'A.\n\n```\ncode\n```\n\n> quote\n\n| a | b |\n|---|---|\n\n---\n\n<details>')
    for (const line of change.split('\n')) expect(line).toMatch(LINE_START)
  })

  it('cuts a very long item, never the count', () => {
    const long = 'x'.repeat(ITEM_CHARS + 50)
    expect(instructionsChange('A.', `A.\n\n${long}`)).toBe(`Added: ${'x'.repeat(ITEM_CHARS - 1)}…`)
  })

  it('says when the earlier revision could not be read, rather than showing no change', () => {
    expect(instructionsChange(null, 'Anything.')).toBe('The earlier revision could not be read, so the change is not shown.')
  })

  it('shows a rewrite too big to compare item by item as its real removed and added items, quickly', () => {
    const before = Array.from({ length: 2000 }, (_, i) => `- Old ${i}`).join('\n')
    const after = Array.from({ length: 2000 }, (_, i) => `- New ${i}`).join('\n')
    const started = performance.now()
    const change = instructionsChange(before, after)
    expect(performance.now() - started).toBeLessThan(500)
    expect(change).toBe([...Array.from({ length: 12 }, (_, i) => `Removed: Old ${i}`), '', 'and 3988 more changes.'].join('\n'))
  })

  it('compares a large document\'s small change item by item', () => {
    const items = Array.from({ length: 2000 }, (_, i) => `- Item ${i}`)
    const after = [...items.slice(0, 500), '- Inserted', ...items.slice(500, 1500), ...items.slice(1501)]
    expect(instructionsChange(items.join('\n'), after.join('\n'))).toBe('Added: Inserted\nRemoved: Item 1500')
  })
})
