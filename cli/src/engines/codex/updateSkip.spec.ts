import { describe, expect, it } from 'vitest'
import { CODEX_MODEL_MIGRATION, CODEX_SIGN_IN, CODEX_TRUST_PROMPT, CODEX_UPDATE_PROMPT } from '../../lib/__fixtures__/takeoverScreens.js'
import { updateDismissKeys } from './screen.js'

/** The prompt as codex-cli 0.165.0 drew it in a tmux pane (2026-10-29), where Esc was measured to skip it. */
const CODEX_UPDATE_0165 = [
  '  Update available · 0.165.0 → 99.0.0',
  '  Release notes: https://github.com/openai/codex/releases/latest',
  '',
  '› 1. Update now (runs `brew upgrade --cask codex`)',
  '  2. Skip',
  '  3. Skip until next version',
  '',
  '  enter continue · esc skip',
].join('\n')

// Measured on codex-cli 0.165.0 (2026-10-29): Esc leaves the prompt for the next screen without updating, while `0` is
// ignored and the Enter after it runs `brew upgrade` on the highlighted "Update now". A number plus Enter is never sent.
describe('dismissing Codex\'s update prompt', () => {
  it.each([['the prompt as 0.160 drew it', CODEX_UPDATE_PROMPT], ['the prompt as 0.165 drew it', CODEX_UPDATE_0165]])('answers %s with Esc alone', (_name, capture) => {
    expect(updateDismissKeys(capture)).toEqual(['Escape'])
  })

  it.each([
    ['a Skip row misread as 0', CODEX_UPDATE_0165.replace('2. Skip', '0. Skip')],
    ['a Skip row misread as 1', CODEX_UPDATE_0165.replace('2. Skip', '1. Skip')],
    ['another Skip row above the prompt', `  1. Skip\n${CODEX_UPDATE_0165}`],
    ['a changed menu order', CODEX_UPDATE_0165.replace('› 1. Update now (runs `brew upgrade --cask codex`)\n  2. Skip', '› 1. Skip\n  2. Update now (runs `brew upgrade --cask codex`)')],
    ['rows in another order below the same numbers', CODEX_UPDATE_0165.replace('2. Skip\n  3. Skip until next version', '2. Skip until next version\n  3. Skip')],
    ['a missing Skip row', CODEX_UPDATE_0165.replace('  2. Skip\n', '')],
    ['an extra row', CODEX_UPDATE_0165.replace('  3. Skip until next version', '  3. Skip until next version\n  4. Never ask again')],
    ['a footer that does not say Esc skips', CODEX_UPDATE_0165.replace('esc skip', 'esc quit')],
    ['no footer', CODEX_UPDATE_0165.replace('\n\n  enter continue · esc skip', '')],
    ['two update prompts', `${CODEX_UPDATE_0165}\n${CODEX_UPDATE_0165}`],
  ])('sends nothing for %s: a misread screen is left to the Lead', (_name, capture) => {
    expect(updateDismissKeys(capture)).toBeNull()
  })

  it.each([
    ['trust', CODEX_TRUST_PROMPT],
    ['model', CODEX_MODEL_MIGRATION],
    ['sign-in', CODEX_SIGN_IN],
    ['composer', '  gpt-5.5 high · ~/project\n\n› Write tests\n'],
    ['the update prompt left in scrollback above the composer', `${CODEX_UPDATE_0165}\n\n› Write tests\n  gpt-5.5 high · ~/project\n`],
  ])('sends nothing on %s', (_name, capture) => {
    expect(updateDismissKeys(capture)).toBeNull()
  })
})
