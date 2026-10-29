import { describe, expect, it } from 'vitest'
import { CODEX_MODEL_MIGRATION, CODEX_SIGN_IN, CODEX_TRUST_PROMPT, CODEX_UPDATE_PROMPT } from '../../lib/__fixtures__/takeoverScreens.js'
import { updateSkipKeys } from './screen.js'

describe('answering Codex\'s update prompt with Skip', () => {
  it('types 2 and Enter on the prompt, whose first row is Update now', () => {
    expect(updateSkipKeys(CODEX_UPDATE_PROMPT)).toEqual(['2', 'Enter'])
  })

  it('follows the Skip row when Codex numbers its rows differently, never the Update now row', () => {
    const reordered = CODEX_UPDATE_PROMPT.replace('  2. Skip\n', '  2. Skip until next version\n').replace('  3. Skip until next version', '  3. Skip')
    expect(updateSkipKeys(reordered)).toEqual(['3', 'Enter'])
  })

  it('answers nothing when no row is plain Skip', () => {
    expect(updateSkipKeys(CODEX_UPDATE_PROMPT.replace('  2. Skip\n', ''))).toBeNull()
  })

  it.each([
    ['trust', CODEX_TRUST_PROMPT],
    ['model', CODEX_MODEL_MIGRATION],
    ['sign-in', CODEX_SIGN_IN],
    ['composer', '  gpt-5.5 high · ~/project\n\n› Write tests\n'],
    ['the update prompt left in scrollback above the composer', `${CODEX_UPDATE_PROMPT}\n\n› Write tests\n  gpt-5.5 high · ~/project\n`],
  ])('answers nothing on %s', (_name, capture) => {
    expect(updateSkipKeys(capture)).toBeNull()
  })
})
