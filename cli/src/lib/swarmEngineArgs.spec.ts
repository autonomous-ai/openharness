import { describe, expect, it } from 'vitest'
import { swarmEngineArgs } from './swarmEngineArgs.js'

describe('what the Swarm adds to an engine\'s argv', () => {
  it('turns off Codex\'s startup update check, whose "Update available" screen holds an agent nobody is at', () => {
    expect(swarmEngineArgs('codex')).toEqual(['-c', 'check_for_update_on_startup=false'])
  })

  // The shell guard is gone (anh Dee, 2026-11-09): a Swarm agent runs with its person's own settings, and no hook of Harness's
  // runs before its tools.
  it('gives no hook to run before a tool, on any engine', () => {
    for (const engine of ['claude', 'codex']) {
      expect(swarmEngineArgs(engine).join(' ')).not.toMatch(/PreToolUse|"hooks"|__swarm-shell-guard/)
    }
  })

  // Kept from the guard's settings (task #3596): Harness's own hooks run in a Swarm Claude Code session, whatever the person's.
  it('keeps hooks on for a Swarm Claude Code session even when inherited settings turn every hook off', () => {
    const args = swarmEngineArgs('claude')
    expect(args).toEqual(['--settings', '{"disableAllHooks":false}'])
    const session = { ...{ disableAllHooks: true }, ...JSON.parse(args[1]!) as Record<string, unknown> }
    expect(session.disableAllHooks).toBe(false)
  })

  it('adds nothing for the other engines', () => {
    for (const engine of ['opencode', 'gemini', 'not-an-engine']) expect(swarmEngineArgs(engine)).toEqual([])
  })

  it('hands out a copy, so a caller\'s edit never reaches the next launch', () => {
    swarmEngineArgs('codex').push('--oops')
    expect(swarmEngineArgs('codex')).not.toContain('--oops')
  })
})
