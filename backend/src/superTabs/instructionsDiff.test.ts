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
    // Case, punctuation, plurals, stop words and the attribution's format are no change.
    expect(droppedRules(doc(tony), doc('every phone-app task runs on Tony\'s Mac first; its Engineers and the Testers both (0xken15, 2026-11-04)'))).toEqual([])
  })

  // Review of #3112 (Heron21): words compared as a set let a rule lose one word in ten, and negations and numbers be moved.
  it('refuses any change of a rule\'s words, negations, numbers or their order', () => {
    const changed = (rule: string, to: string) => why(doc(rule), doc(to))
    expect(changed(leo, leo.replace('within the hour', 'within the week'))).toEqual([[['Leo'], 'changed']])
    const two = 'Every change gets two reviewers before merge (Ken, 2026-11-03).'
    expect(changed(two, two.replace('two', 'one'))).toEqual([[['Ken'], 'changed']])
    expect(changed(two, two.replace('before', 'after'))).toEqual([[['Ken'], 'changed']])
    expect(changed(quiet, quiet.replace('18:00 and 09:00', '09:00 and 18:00'))).toEqual([[['Ken'], 'changed']])
    const merges = 'The PM merges on review. It does not release without a test (Ken, 2026-11-03).'
    expect(changed(merges, 'The PM does not merge on review. It releases without a test (Ken, 2026-11-03).')).toEqual([[['Ken'], 'changed']])
    // A rewording that keeps the meaning is still a change of words: refused, so its person is asked.
    const read = 'It gives its verdict once it has read the code (Ken, 2026-11-04).'
    expect(changed(read, 'It gives its verdict after reading the code (Ken, 2026-11-04).')).toEqual([[['Ken'], 'changed']])
  })

  it('takes a merge only when every word in it comes from the rules it names', () => {
    const merged = `${quiet.replace(' (Ken, 2026-11-02).', '')}, unless the PM judges it urgent, and ${tony[0]!.toLowerCase()}${tony.slice(1).replace(' (0xken15, 4 Nov).', '')} (Ken, 2026-11-02; 0xken15, 4 Nov).`
    expect(why(doc(tony, quiet), doc(merged)).map(([, w]) => w)).toEqual(['changed', 'changed'])
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
