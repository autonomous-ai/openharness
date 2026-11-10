import { describe, expect, it } from 'vitest'
import { promptHash } from './promptIdentity.js'

describe('a prompt by what it says', () => {
  it('is 32 hex characters, and never the words', () => {
    expect(promptHash('Ship it.')).toMatch(/^[0-9a-f]{32}$/)
    expect(promptHash('Ship it.')).not.toContain('Ship')
  })

  it('is the same for the prompt an engine recorded, with or without the markers Claude Code puts around a paste and however it spaces lines', () => {
    const typed = promptHash('Ship it.')
    for (const recorded of ['Ship it.', '  Ship it.\r\n', '<pasted_content id="1c18">\nShip it.\n</pasted_content id="1c18">', 'Ship\tit.']) {
      expect(promptHash(recorded), recorded).toBe(typed)
    }
    expect(promptHash('<pasted_content id="ab">\nShip it.\n\n\nAnd then the logout.\n</pasted_content id="ab">')).toBe(promptHash('Ship it.\n\nAnd then the logout.'))
  })

  it('differs for other words', () => {
    expect(promptHash('Ship it.')).not.toBe(promptHash('Ship it!'))
    expect(promptHash('')).not.toBe(promptHash('Ship it.'))
  })
})
