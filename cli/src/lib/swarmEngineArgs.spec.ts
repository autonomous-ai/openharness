import { describe, expect, it } from 'vitest'
import { swarmEngineArgs } from './swarmEngineArgs.js'

describe('what the Swarm adds to an engine\'s argv', () => {
  it('turns off Codex\'s startup update check, whose "Update available" screen holds an agent nobody is at', () => {
    expect(swarmEngineArgs('codex')).toEqual(['-c', 'check_for_update_on_startup=false'])
  })

  it('adds nothing for the other engines', () => {
    for (const engine of ['claude', 'opencode', 'gemini', 'not-an-engine']) expect(swarmEngineArgs(engine)).toEqual([])
  })

  it('hands out a copy, so a caller\'s edit never reaches the next launch', () => {
    swarmEngineArgs('codex').push('--oops')
    expect(swarmEngineArgs('codex')).toEqual(['-c', 'check_for_update_on_startup=false'])
  })
})
