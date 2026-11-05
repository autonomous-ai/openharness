import { describe, expect, it } from 'vitest'
import { attributedRules, droppedRules, personKey } from './instructionsDiff.js'

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
    expect(['anh Dee', '@Dee', "Dee's daily check", 'DEE'].map(personKey)).toEqual(['dee', 'dee', 'dee', 'dee'])
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
    expect(droppedRules(doc(leo, tony, quiet), doc(leo, `${quiet.replace('.', ',')} and ${tony[0]!.toLowerCase()}${tony.slice(1)}`))).toEqual([])
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
