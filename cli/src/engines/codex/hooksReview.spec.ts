import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { WAITING } from '../../superTabs/terminal.js'
import { hooksReviewSkipKeys, screen } from './screen.js'
import type { MessageHold } from '../facets/screen.js'

/** As codex-cli 0.163.0 drew it on DESKTOP-0TFH0OJ (2026-11-04): another program's two hooks in `hooks.json`, Harness's trusted. */
const REVIEW = readFileSync(new URL('../../superTabs/fixtures/screens/codex-0163-hooks-review.txt', import.meta.url), 'utf8')

// Nobody sits at a Swarm agent's pane, so another program's new hook stopped its start for good. Esc goes on with those hooks
// off and records nothing: only a person may trust a hook, so "Trust all" is never pressed.
describe("skipping Codex's review of another program's hooks", () => {
  it('is Esc, as the footer says, and never a row', () => {
    expect(hooksReviewSkipKeys(REVIEW)).toEqual(['Escape'])
  })

  it.each([
    ['Trust all highlighted', REVIEW.replace('› 1. Review hooks', '  1. Review hooks').replace('  2. Trust all and continue', '› 2. Trust all and continue')],
    ['rows in another order', REVIEW.replace('  2. Trust all and continue\n  3. Continue without trusting (hooks won\'t run)', '  2. Continue without trusting (hooks won\'t run)\n  3. Trust all and continue')],
    ['an extra row', REVIEW.replace('  3. Continue', '  4. Allow everything\n  3. Continue')],
    ['no row that continues without trusting', REVIEW.replace("  3. Continue without trusting (hooks won't run)\n", '')],
    ['another footer', REVIEW.replace('enter confirm · esc skip', 'enter confirm · esc quit')],
    ['no footer', REVIEW.replace('\n\n  enter confirm · esc skip', '')],
    ['another heading', REVIEW.replace('Hooks need review', 'Plugins need review')],
    ['the screen left in scrollback above the composer', `${REVIEW}\n\n› Write tests\n  gpt-6-astra high · ~/project\n`],
  ])('sends nothing on %s', (_name, capture) => {
    expect(hooksReviewSkipKeys(capture)).toBeNull()
  })

  it('reads the screen as one that waits for a person', () => {
    expect(WAITING.has(screen.inspect(REVIEW).messageHold as MessageHold)).toBe(true)
  })
})
