import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { citeSessions, parseAbout, readAbout, writeAbout } from '../lib/about.mjs'

const PROFILE = `# About you

Built today from 12 of your messages.

## How you work
- Wants short answers. [claude:short-answers.md, asks:3]
- Reviews every diff before merging.

## Right now
* Shipping onboarding. [session:abc]
`

test('lines, sections and sources', () => {
  const about = parseAbout(PROFILE)
  assert.equal(about.intro, 'Built today from 12 of your messages.')
  assert.deepEqual(about.lines, [
    { section: 'How you work', text: 'Wants short answers.', refs: ['claude:short-answers.md', 'asks:3'] },
    { section: 'How you work', text: 'Reviews every diff before merging.', refs: [] },
    { section: 'Right now', text: 'Shipping onboarding.', refs: ['session:abc'] },
  ])
})

test('writing keeps the previous profile and never leaves a partial file', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'memories-about-')), 'memory')
  assert.equal(readAbout(dir), null)
  writeAbout(dir, PROFILE)
  assert.equal(readAbout(dir).lines.length, 3)
  writeAbout(dir, '## New\n- One line.\n')
  assert.equal(readFileSync(join(dir, 'about-you.prev.md'), 'utf8'), PROFILE)
  assert.deepEqual(readdirSync(dir).sort(), ['about-meta.json', 'about-you.md', 'about-you.prev.md'])
  assert.equal(statSync(join(dir, 'about-you.md')).mode & 0o777, 0o600)
})

test('an empty, shapeless or oversized profile is refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'memories-about-'))
  assert.throws(() => writeAbout(dir, '  \n'), /empty/)
  assert.throws(() => writeAbout(dir, 'just a paragraph'), /at least one/)
  assert.throws(() => writeAbout(dir, `## A\n- ${'x'.repeat(40_000)}`), /limited/)
})

test('a conversation cited by its agent is cited as a session; nothing else changes', () => {
  const known = (id) => id === 's1' || id === 'abc-2'
  const text = '# About you\nIntro [codex:s1]\n\n## How\n- One. [codex:s1, claude:s1.md, grok:abc-2, session:s1, asks:3]  \n- Two. [claude:zzz]\n- Three, no sources.\n* Four. [hermes:s1]'
  assert.equal(citeSessions(text, known),
    '# About you\nIntro [codex:s1]\n\n## How\n- One. [session:s1, claude:s1.md, session:abc-2, session:s1, asks:3]\n- Two. [claude:zzz]\n- Three, no sources.\n* Four. [session:s1]')
  assert.equal(citeSessions(null, known), '')
})
