import { describe, expect, it } from 'vitest'
import { REBASED_INTRO, rebasedDocument } from './instructionsRebase.js'
import { attributedRules, budgetParts, droppedRules } from './instructionsDiff.js'
import { INSTRUCTIONS_TEMPLATE } from './instructionsTemplate.js'

// Task #3600 (anh Dee, 11-06: "update them all and override all of their existing instructions. ALL OF THEM"): every
// project's instructions become only that project's facts and every person's rule word for word in its People notes ("REPLACE
// 100%", River's ruling with anh Dee): all process is the Swarm's built-in PM text (#3603), never copied into a document. The shapes below are the ones the openharness document (revision 79) writes its rules in.
export const BEFORE = `# Project instructions

These instructions say how this project works. A skill named here is fetched each time it is used (Ken, 2026-11-02).

## Roles

### PM

- Talks with people in the project chat and finds out what they want.
- Owns the product completely and works without pause to deliver it (Dee, 2026-11-03). Its one mission is the
  product's positioning:
  - Tell the PM what you want, and your crew ships it.
- Decides, doesn't ask (Ken, 2026-11-04): it decides and reports the result.
- Sets deadlines for today, in hours.

### Engineer

- Does one task, on its own branch (Dee, 2026-11-03). Writes the plan first, as a Markdown file in docs/plans/ (Ken,
  2026-11-02).

### Integrator

- Merges and releases, in place of the PM (Ken, 2026-11-05).
- Checks a pull request's number and title before merging it.

## Workflow

1. One accepted request is one task.
2. Findings go straight to the Engineer, never through the PM (Ken, 2026-11-04).
   - While a batch pull request is open, main is closed to single merges (Ken, 2026-11-02).

## Product decisions (anh Dee)

- Voice messages play only, as Telegram draws them (anh Dee, 2026-11-04; repeated 2026-11-05 "I already told you NO").

## Talking in the project chat (anh Dee, 2026-11-04)

Every agent, the PM included:
- Writes like a teammate: first person, plain words.
- Reacts instead of acknowledging.

## Rules for every agent

- Swarm code stays out of cli/src/core.
- Never run a test that signs the Mac out of the real CLI (Ken, 2026-11-04).
- Never run a test that signs the Mac out of the real CLI (Ken, 2026-11-04).

## People notes

- Every phone app task runs on Tony's Mac first (Tony, 2026-11-03).
`

const count = (text: string, part: string) => text.split(part).length - 1

describe('a project\'s document on the new base', () => {
  it('keeps every person\'s rule word for word with who gave it, and nothing else of the old text', () => {
    const { text, lost } = rebasedDocument(BEFORE)
    expect(lost).toEqual([])
    // The rule guard itself, as every save is checked: nothing a person gave is dropped, reworded or left without its person.
    expect(droppedRules(BEFORE, text)).toEqual([])
    for (const rule of attributedRules(BEFORE)) expect(text.replace(/\s+/g, ' ')).toContain(rule.text)
    // Lines no person gave are process, which the built-in PM text carries now; no template is copied in.
    for (const line of ['Talks with people in the project chat', 'Sets deadlines for today', 'One accepted request is one task.',
      'Swarm code stays out of cli/src/core.', 'Checks a pull request\'s number and title']) expect(text).not.toContain(line)
    expect(text).not.toContain('## Roles')
    expect(text).not.toContain('## Workflow')
    expect(text).not.toContain(INSTRUCTIONS_TEMPLATE.split('\n')[4]!)
    expect(text.startsWith(`${REBASED_INTRO}\n\n## People notes\n`)).toBe(true)
  })

  it('files each rule in People notes under the section it came from', () => {
    const { text } = rebasedDocument(BEFORE)
    expect(text).toContain('### Roles › PM\n\n- Owns the product completely')
    expect(text).toContain('### Roles › Integrator\n\n- Merges and releases, in place of the PM (Ken, 2026-11-05).')
    expect(text).toContain('### Workflow\n\n2. Findings go straight to the Engineer')
    expect(text).toContain('### Project instructions\n\nThese instructions say how this project works.')
    // A rule already in People notes stays at its top, under no heading of its own.
    expect(text).toContain('## People notes\n\n- Every phone app task runs on Tony\'s Mac first (Tony, 2026-11-03).')
    expect(text).not.toContain('### People notes')
  })

  it('carries an attributed item with its wrapped lines and the items under it, and a section whose heading names a person whole', () => {
    const { text } = rebasedDocument(BEFORE)
    expect(text).toContain('  product\'s positioning:\n  - Tell the PM what you want, and your crew ships it.')
    expect(text).toContain('   - While a batch pull request is open, main is closed to single merges (Ken, 2026-11-02).')
    // "(anh Dee, 2026-11-04)" on the heading makes every line under it his.
    expect(text).toContain('### Talking in the project chat (anh Dee, 2026-11-04)\n\nEvery agent, the PM included:\n- Writes like a teammate')
    expect(text).toContain('- Reacts instead of acknowledging.')
  })

  it('keeps an item of several attributions whole, each with its people', () => {
    const { text } = rebasedDocument(BEFORE)
    expect(text).toContain('- Does one task, on its own branch (Dee, 2026-11-03). Writes the plan first, as a Markdown file in docs/plans/ (Ken,\n  2026-11-02).')
  })

  it('writes a rule once: one written twice is kept once', () => {
    const { text } = rebasedDocument(BEFORE)
    expect(count(text, 'Never run a test that signs the Mac out of the real CLI (Ken, 2026-11-04).')).toBe(1)
  })

  it('puts the project\'s own facts under "This project", before People notes, and no section when none are given', () => {
    const facts = 'Repository: github.com/acme/app.\n\n- Tony\'s Mac has the phone.'
    const { text } = rebasedDocument(BEFORE, facts)
    expect(text.startsWith(`${REBASED_INTRO}\n\n## This project\n\n${facts}\n\n## People notes\n`)).toBe(true)
    expect(rebasedDocument(BEFORE).text).not.toContain('## This project')
    expect(rebasedDocument(BEFORE, '  \n').text).not.toContain('## This project')
    expect(rebasedDocument('# Ours\n\n- Ship it.\n').text).toBe(`${REBASED_INTRO}\n`)
  })

  it('is the same document a second time: a second run has nothing to write', () => {
    const once = rebasedDocument(BEFORE, 'A fact.').text
    expect(rebasedDocument(once, 'A fact.').text).toBe(once)
    expect(rebasedDocument(once, 'A fact.').lost).toEqual([])
  })

  it('carries a fenced block that holds a rule whole, and reads a heading in a fence as text', () => {
    const before = '# P\n\n## Routing\n\n```\n## Not a heading (Ken, 2026-11-02)\n- kept as written\n```\n'
    const { text, lost } = rebasedDocument(before)
    expect(lost).toEqual([])
    expect(text).toContain('### Routing\n\n```\n## Not a heading (Ken, 2026-11-02)\n- kept as written\n```')
  })

  it('stays within the core budget, People notes aside', () => {
    const core = budgetParts(rebasedDocument(BEFORE, 'Repository: github.com/acme/app.').text).find(p => p.part === 'core')!
    expect(core.bytes).toBeLessThan(1024)
  })
})
