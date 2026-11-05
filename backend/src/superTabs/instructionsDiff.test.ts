import { describe, expect, it } from 'vitest'
import { attributedRules, droppedRules, instructionsChange, CHANGE_ITEMS, ITEM_CHARS } from './instructionsDiff.js'

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

// Task #3151 (Ken, 11-05, from lamp): a PM's tidy from revision 70 to 71 dropped Leo's rule and the "(0xken15, 4 Nov)" of a
// rule it kept, and nothing checked the save.
describe('attributedRules', () => {
  const people = (text: string) => attributedRules(text).map(r => r.people)

  it('finds a person and a date in parentheses, however the date is written', () => {
    expect(people('- Reviews run on Opus (Ken, 2026-11-02).')).toEqual([['Ken']])
    expect(people('- Phone tasks run on Tony\'s Mac (0xken15, 4 Nov).')).toEqual([['0xken15']])
    expect(people('- Batches every 30 minutes (Scholes, 11-04).')).toEqual([['Scholes']])
    expect(people('- Ship on Fridays (Diego, Nov 4).')).toEqual([['Diego']])
    expect(people('- Ship on Fridays (Diego, 4/11/2026).')).toEqual([['Diego']])
    expect(people('- Never scan a collection (Ken, 2026-11-04: ad hoc reads doubled Atlas CPU).')).toEqual([['Ken']])
  })

  it('reads several people, an honorific and a heading', () => {
    expect(people('- Two reviews (Ken and Dee, 2026-11-03).')).toEqual([['Ken', 'Dee']])
    expect(people('- Two reviews (Ken, Dee, 2026-11-03).')).toEqual([['Ken', 'Dee']])
    expect(people('- Two reviews (Ken, 11-02; Dee, 11-03).')).toEqual([['Ken', 'Dee']])
    expect(people('## Talking in the project chat (anh Dee, 2026-11-04)')).toEqual([['anh Dee']])
  })

  it('takes a bullet with one attribution as one rule, and splits one with several at each', () => {
    expect(attributedRules('- Decides, doesn\'t ask (Ken, 2026-11-04): it decides and reports the result.').map(r => r.text))
      .toEqual(['Decides, doesn\'t ask (Ken, 2026-11-04): it decides and reports the result.'])
    expect(attributedRules('- Opus builds (Ken, 11-02). Sonnet reviews (Dee, 11-03). Tests run first.').map(r => [r.text, r.people]))
      .toEqual([['Opus builds (Ken, 11-02).', ['Ken']], ['Sonnet reviews (Dee, 11-03). Tests run first.', ['Dee']]])
  })

  it('ignores parentheses with no person and date', () => {
    expect(attributedRules([
      '- Nothing stored (design, Identity).',
      '- A task takes 1% (measured 2026-11-02 on the Mac Studio).',
      '- Optimizations ship on (Ken).',
      '- Words (Ken\'s review; River chose words).',
    ].join('\n'))).toEqual([])
  })
})

describe('droppedRules', () => {
  const doc = (...rules: string[]) => ['# Project instructions', '', '## Rules', '', ...rules.map(r => `- ${r}`)].join('\n')
  const leo = 'A bug that reaches stable: the previous build is promoted back within the hour and the fix ships the same day (Leo, 2026-11-04).'
  const tony = 'Every phone app task runs on Tony\'s Mac first, its Engineer and its Tester both (0xken15, 4 Nov).'
  const quiet = 'No releases between 18:00 and 09:00 Vietnam time (Ken, 2026-11-02).'
  const why = (before: string, after: string) => droppedRules(before, after).map(d => [d.people, d.why])

  it('lists a removed rule with its person', () => {
    expect(droppedRules(doc(leo, tony), doc(tony))).toEqual([expect.objectContaining({ text: leo, people: ['Leo'], why: 'removed' })])
  })

  it('lists a rule kept without who gave it', () => {
    expect(why(doc(leo, tony), doc(leo, 'Every phone app task runs on Tony\'s Mac first, its Engineer and its Tester both.')))
      .toEqual([[['0xken15'], 'unattributed']])
  })

  it('accepts two rules merged into one that keeps both attributions', () => {
    const merged = 'No releases between 18:00 and 09:00 Vietnam time, and every phone app task runs on Tony\'s Mac first, its Engineer and its '
      + 'Tester both (Ken, 2026-11-02; 0xken15, 4 Nov).'
    expect(droppedRules(doc(leo, tony, quiet), doc(leo, merged))).toEqual([])
    expect(droppedRules(doc(leo, tony, quiet), doc(leo, `${quiet.slice(0, -21)} (Ken, 2026-11-02), and ${tony[0]!.toLowerCase()}${tony.slice(1)}`))).toEqual([])
  })

  it('accepts rewrapping, renumbering, moving to another section and a light reword by the same person', () => {
    const moved = ['# Project instructions', '', '## Releases', '', `1. ${leo}`, '', '## Rules', '', `- ${tony}`].join('\n')
    expect(droppedRules(doc(leo, tony), moved)).toEqual([])
    expect(droppedRules(doc(leo), doc(leo.replace('the fix ships', 'the fix\n  ships')))).toEqual([])
    expect(droppedRules(doc(tony), doc('Every phone app task runs first on Tony\'s Mac, both its Engineer and its Tester (0xken15, 2026-11-04).'))).toEqual([])
  })

  it('lists a rule whose meaning may have changed: a negation, a number or a new condition', () => {
    expect(why(doc(quiet), doc('No releases between 20:00 and 09:00 Vietnam time (Ken, 2026-11-02).'))).toEqual([[['Ken'], 'changed']])
    expect(why(doc(tony), doc('Every phone app task never runs on Tony\'s Mac first, its Engineer and its Tester both (0xken15, 4 Nov).')))
      .toEqual([[['0xken15'], 'changed']])
    expect(why(doc(leo), doc('A bug that reaches stable: the previous build is promoted back within the hour and the fix ships the same day, '
      + 'unless the PM judges it impossible (Leo, 2026-11-04).'))).toEqual([[['Leo'], 'changed']])
  })

  it('compares people by who they are, when told', () => {
    const same = (a: string, b: string) => [a, b].every(n => ['ken', '0xken15'].includes(n.toLowerCase()))
    expect(droppedRules(doc(tony), doc(tony.replace('0xken15', 'Ken')), name => same(name, 'ken') ? 'ken' : name)).toEqual([])
    expect(why(doc(tony), doc(tony.replace('0xken15', 'Dee')))).toEqual([[['0xken15'], 'unattributed']])
  })
})
