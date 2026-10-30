import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { env } from '../config/env.js'
import { COMMANDCODE_HOOK_SETTINGS } from './commandcode/contract.js'
import { COPILOT_HOOK_SETTINGS } from './copilot/contract.js'
import { hookContracts } from './hooks.js'
import { WINDOWS_ENGINE_HOMES } from './windowsHomes.js'

describe('engine homes on Windows', () => {
  it('has an entry for every engine Harness reaches through hooks or a plugin on Windows', () => {
    const hooked = [
      ...Object.entries(hookContracts).filter(([, contract]) => contract.settings.win32Runner).map(([engine]) => engine),
      ...[COPILOT_HOOK_SETTINGS, COMMANDCODE_HOOK_SETTINGS].filter((rule) => rule.win32Runner).map((rule) => rule.engine),
      'opencode', 'kilo', 'pi',
    ]
    expect(Object.keys(WINDOWS_ENGINE_HOMES).sort()).toEqual([...new Set(hooked)].sort())
  })

  it.each(Object.entries(WINDOWS_ENGINE_HOMES))('%s: the daemon default is that folder in the profile', (_engine, home) => {
    expect(env[home.setting]).toBe(join(homedir(), ...home.folder))
  })
})
