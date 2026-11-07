import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { openRestrictedKeys, screen } from './screen.js'

/** Real tmux captures: 0.165 on 2026-11-05 (#3009), and 0.166 on Linux on 2026-11-06 (#3904). */
const fixture = (name: string) => readFileSync(new URL(`../../superTabs/fixtures/screens/${name}.txt`, import.meta.url), 'utf8')
const TRUST = fixture('codex-0165-trust-fresh-home')

// "Open restricted" keeps the folder's config, hooks and exec policies off and saves no trust: the answer an untrusted
// Team-written branch gets. "Trust and continue" would trust the branch, so nothing is ever sent on that screen.
describe.each([
  { version: '0165', secondRow: 'Quit', escape: 'quit' },
  { version: '0166', secondRow: 'Back to Agent Command Center', escape: 'back' },
])('opening an untrusted folder restricted in Codex $version', ({ version, secondRow, escape }) => {
  const RESTRICTED = fixture(`codex-${version}-open-restricted`)
  const footer = `enter continue · esc ${escape}`
  it('answers the restricted screen with Enter on its highlighted first row', () => {
    expect(openRestrictedKeys(RESTRICTED)).toEqual(['Enter'])
  })

  it.each([
    ['the trust screen, whose first row trusts the folder', TRUST],
    ['the second row highlighted instead', RESTRICTED.replace('› 1. Open restricted', '  1. Open restricted').replace(`  2. ${secondRow}`, `› 2. ${secondRow}`)],
    ['rows in another order', RESTRICTED.replace(`› 1. Open restricted\n  2. ${secondRow}`, `› 1. ${secondRow}\n  2. Open restricted`)],
    ['an extra row', RESTRICTED.replace(`  2. ${secondRow}`, `  2. ${secondRow}\n  3. Trust and continue`)],
    ['a missing second row', RESTRICTED.replace(`  2. ${secondRow}\n`, '')],
    ['no sentence saying untrusted folders stay disabled', RESTRICTED.replace('Config, hooks, and exec policies from untrusted folders stay disabled.', 'Folder settings will apply.')],
    ['a trust question on the same screen', `${TRUST}\n${RESTRICTED}`],
    ['another footer', RESTRICTED.replace(footer, 'enter continue · esc skip')],
    ['the other version\'s footer', RESTRICTED.replace(footer, `enter continue · esc ${escape === 'quit' ? 'back' : 'quit'}`)],
    ['no footer', RESTRICTED.replace(`\n\n  ${footer}`, '')],
    ['the screen left in scrollback above the composer', `${RESTRICTED}\n\n› Write tests\n  gpt-6-astra high · ~/project\n`],
  ])('sends nothing on %s', (_name, capture) => {
    expect(openRestrictedKeys(capture)).toBeNull()
  })

  it('reads the restricted screen as a trust prompt, as it reads the trust screen', () => {
    expect(screen.inspect(RESTRICTED).messageHold).toBe('trust_open')
    expect(screen.inspect(TRUST).messageHold).toBe('trust_open')
  })
})
