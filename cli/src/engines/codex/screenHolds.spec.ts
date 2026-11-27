import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { screen } from './screen.js'

/** Real tmux captures: hooks review on 0.163 (DESKTOP-0TFH0OJ, 2026-11-04), the trust screens on 0.165 (2026-11-05, #3009)
 *  and 0.166 on Linux (2026-11-06, #3904). */
const fixture = (name: string) => readFileSync(new URL(`./__fixtures__/${name}.txt`, import.meta.url), 'utf8')

// A message typed into one of these screens answers the screen, not the agent: each holds every message until a person
// has answered it.
describe('Codex screens no message is typed into', () => {
  it.each(['0165', '0166'])('reads %s\'s restricted-folder screen as a trust prompt, as it reads the trust screen', (version) => {
    expect(screen.inspect(fixture(`codex-${version}-open-restricted`)).messageHold).toBe('trust_open')
    expect(screen.inspect(fixture('codex-0165-trust-fresh-home')).messageHold).toBe('trust_open')
  })

  it('reads the review of hooks it has not seen as a screen that waits for a person', () => {
    expect(screen.inspect(fixture('codex-0163-hooks-review')).messageHold).toBe('question_open')
  })
})
