import { describe, expect, it } from 'vitest'
import { ENGINES, type AgentEngine } from '../engines/types.js'
import { LAUNCH_RESUME_FLAG } from './engineLaunch.js'
import { confirmsResumeByHook, resumeMode, resumesConversation } from './resumeCapability.js'

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

  it('trusts a startup hook to confirm a resume only where one is sent on a resume', () => {
    expect(confirmsResumeByHook('claude')).toBe(true)
    expect(confirmsResumeByHook('codex')).toBe(true)
    // OpenCode re-attaches its session silently on `--session <id>` and posts nothing; copilot, pi
    // and amp hook on a turn; muse never hooks. Waiting for one only hangs the resume.
    for (const engine of ['opencode', 'kilo', 'copilot', 'pi', 'amp', 'muse', 'cursor', 'hermes', 'commandcode', 'devin', 'grok', 'agy', 'terminal'] as AgentEngine[]) {
      expect(confirmsResumeByHook(engine)).toBe(false)
    }
  })

  it('covers the whole roster, so a new engine cannot be forgotten', () => {
    // A new engine gets the weaker proof by default, never a ten-minute wait.
    const strict = ENGINES.filter(engine => confirmsResumeByHook(engine))
    expect(strict).toEqual(['claude', 'codex'])
    expect(ENGINES.length).toBe(15)
  })
})
