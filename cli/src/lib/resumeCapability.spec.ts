import { describe, expect, it } from 'vitest'
import { ENGINES } from '../engines/types.js'
import { LAUNCH_RESUME_FLAG } from './engineLaunch.js'
import { resumeMode, resumesConversation } from './resumeCapability.js'

describe('what a paused harness can promise, per engine', () => {
  it('gives every engine exactly one mode, from the launch table itself', () => {
    for (const engine of ENGINES) {
      const mode = resumeMode(engine)
      expect(['shell', 'conversation', 'fresh']).toContain(mode)
      if (engine === 'terminal') expect(mode).toBe('shell')
      else expect(mode).toBe(LAUNCH_RESUME_FLAG[engine] ? 'conversation' : 'fresh')
    }
  })

  it('names the shell and the one engine with no resume argv', () => {
    expect(resumeMode('terminal')).toBe('shell')
    // devin is deliberately absent from LAUNCH_RESUME_FLAG — no confirmed flag exists.
    expect(resumeMode('devin')).toBe('fresh')
    expect(resumeMode('claude')).toBe('conversation')
    expect(resumeMode('opencode')).toBe('conversation')
  })

  it('asks for a conversation only when there is one to ask for', () => {
    expect(resumesConversation('claude', 'abc')).toBe(true)
    expect(resumesConversation('claude', '')).toBe(false)
    expect(resumesConversation('claude', null)).toBe(false)
    // A recorded id cannot help an engine that has no way to reopen it.
    expect(resumesConversation('devin', 'abc')).toBe(false)
    expect(resumesConversation('terminal', 'abc')).toBe(false)
  })

  // A canary on the roster itself: adding an engine without deciding its resume mode should make
  // the loop above fail, and this makes "the loop above ran over everything" explicit.
  it('covers the whole roster, so a new engine cannot be forgotten', () => {
    expect(ENGINES.filter(engine => resumeMode(engine)).length).toBe(ENGINES.length)
    expect(ENGINES.length).toBe(15)
  })
})
