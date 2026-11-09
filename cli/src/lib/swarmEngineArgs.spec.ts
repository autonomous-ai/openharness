import { describe, expect, it } from 'vitest'
import { swarmEngineArgs } from './swarmEngineArgs.js'

describe('what the Swarm adds to an engine\'s argv', () => {
  it('turns off Codex\'s startup update check, whose "Update available" screen holds an agent nobody is at', () => {
    expect(swarmEngineArgs('codex')).toEqual(['-c', 'check_for_update_on_startup=false'])
  })

  // The shell guard is gone (anh Dee, 2026-11-09): a Swarm agent runs with its person's own settings, and no hook of Harness's
  // runs before its tools.
  it('gives no hook to run before a tool, on any engine', () => {
    expect(swarmEngineArgs('claude')).toEqual([])
    for (const engine of ['claude', 'codex']) {
      expect(swarmEngineArgs(engine).join(' ')).not.toMatch(/--settings|hooks|__swarm-shell-guard/)
    }
  })

  it('adds nothing for the other engines', () => {
    for (const engine of ['opencode', 'gemini', 'not-an-engine']) expect(swarmEngineArgs(engine)).toEqual([])
  })

  it('hands out a copy, so a caller\'s edit never reaches the next launch', () => {
    swarmEngineArgs('codex').push('--oops')
    expect(swarmEngineArgs('codex')).not.toContain('--oops')
  })
})
