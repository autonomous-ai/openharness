import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { openRestrictedKeys, screen } from './screen.js'

/** As codex-cli 0.165.0 drew them in a tmux pane (2026-11-05, task #3009): a Team-written start's empty engine home with no
 *  entry for its checkout, and the same home naming the checkout `untrusted`. */
const fixture = (name: string) => readFileSync(new URL(`../../superTabs/fixtures/screens/${name}.txt`, import.meta.url), 'utf8')
const RESTRICTED = fixture('codex-0165-open-restricted')
const TRUST = fixture('codex-0165-trust-fresh-home')

// "Open restricted" keeps the folder's config, hooks and exec policies off and saves no trust: the answer an untrusted
// Team-written branch gets. "Trust and continue" would trust the branch, so nothing is ever sent on that screen.
describe('opening an untrusted folder restricted in Codex', () => {
  it('answers the restricted screen with Enter on its highlighted first row', () => {
    expect(openRestrictedKeys(RESTRICTED)).toEqual(['Enter'])
  })

  it.each([
    ['the trust screen, whose first row trusts the folder', TRUST],
    ['Quit highlighted instead', RESTRICTED.replace('› 1. Open restricted', '  1. Open restricted').replace('  2. Quit', '› 2. Quit')],
    ['rows in another order', RESTRICTED.replace('› 1. Open restricted\n  2. Quit', '› 1. Quit\n  2. Open restricted')],
    ['an extra row', RESTRICTED.replace('  2. Quit', '  2. Quit\n  3. Trust and continue')],
    ['a missing Quit row', RESTRICTED.replace('  2. Quit\n', '')],
    ['no sentence saying untrusted folders stay disabled', RESTRICTED.replace('Config, hooks, and exec policies from untrusted folders stay disabled.', 'Folder settings will apply.')],
    ['a trust question on the same screen', `${TRUST}\n${RESTRICTED}`],
    ['another footer', RESTRICTED.replace('enter continue · esc quit', 'enter continue · esc skip')],
    ['no footer', RESTRICTED.replace('\n\n  enter continue · esc quit', '')],
    ['the screen left in scrollback above the composer', `${RESTRICTED}\n\n› Write tests\n  gpt-6-astra high · ~/project\n`],
  ])('sends nothing on %s', (_name, capture) => {
    expect(openRestrictedKeys(capture)).toBeNull()
  })

  it('reads the restricted screen as a trust prompt, as it reads the trust screen', () => {
    expect(screen.inspect(RESTRICTED).messageHold).toBe('trust_open')
    expect(screen.inspect(TRUST).messageHold).toBe('trust_open')
  })
})
