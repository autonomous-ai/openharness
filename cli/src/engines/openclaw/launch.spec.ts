import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildEngineCommandArgv, buildEngineLaunchArgv, supportsLaunchResume } from '../../lib/engineLaunch.js'
import { OPENCLAW_STATES, openclawRuntimeState } from './contract.js'
import { openclawScreenState } from './launch.js'

/**
 * How Harness starts and reopens an OpenClaw TUI, and the named states a launch can end in, from the recordings of
 * OpenClaw 2026.11.2 (`__fixtures__/`).
 */
const fixture = (name: string): string => readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), 'utf8')
const AGENT = 'aaaaaaaa-1111-4222-8333-000000000001'
const CWD = '/work/my project'

describe('OpenClaw launch', () => {
  it('a new OpenClaw agent gets its own key and keeps its folder', () => {
    // A bare `openclaw tui` opens the last session any TUI used, so a new agent always names its own.
    const options = { agentId: AGENT, cwd: CWD, bypassPermission: true }
    expect(buildEngineCommandArgv('openclaw', options)).toEqual(['openclaw', 'tui', '--session', `harness-${AGENT}`])
    // The pane enters the folder New chose before the TUI starts, as for every engine.
    const argv = buildEngineLaunchArgv('openclaw', options, '/bin/zsh', '/opt/node', 'grid', null)
    expect(argv.slice(-5)).toEqual([CWD, 'openclaw', 'tui', '--session', `harness-${AGENT}`])
  })

  it('a first task goes in --message', () => {
    expect(buildEngineCommandArgv('openclaw', { agentId: AGENT, firstPrompt: 'Fix the parser' }))
      .toEqual(['openclaw', 'tui', '--session', `harness-${AGENT}`, '--message', 'Fix the parser'])
  })

  it('resume reopens the same key, also after a reset', () => {
    expect(supportsLaunchResume('openclaw')).toBe(true)
    // `/reset` keeps the key; `/new` moves the pane to `tui-<uuid>`, which the binding follows (reset.sql holds both).
    const keys = [...new Set(fixture('reset.sql').match(/agent:main:[A-Za-z0-9._-]+/g))]
    expect(keys).toEqual(['agent:main:reset', 'agent:main:tui-652cc362-2631-416e-bf1c-6ac369311a20'])
    for (const key of keys) {
      // The key is the TUI's positional target; a relaunch never opens a new key beside it.
      expect(buildEngineCommandArgv('openclaw', { agentId: AGENT, resumeSessionId: key, bypassPermission: true }))
        .toEqual(['openclaw', 'tui', key])
    }
  })

  it('no Gateway gives the named state', () => {
    expect(OPENCLAW_STATES.noGateway).toBe('OpenClaw Gateway is not running. Start it with openclaw gateway.')
    // The TUI opens anyway and reconnects by itself, fresh or already attached.
    for (const screen of ['screen-no-gateway.txt', 'screen-no-gateway-bare.txt', 'screen-no-gateway-attached.txt']) {
      expect(openclawScreenState(fixture(screen)), screen).toBe(OPENCLAW_STATES.noGateway)
    }
    expect(openclawScreenState(fixture('screen-no-gateway-reconnected.txt'))).toBeNull()
    expect(openclawScreenState(fixture('screen-plain.txt'))).toBeNull()
    expect(openclawScreenState(fixture('screen-no-token.txt'))).toBe('OpenClaw has no Gateway token. Run openclaw onboard.')
    expect(openclawScreenState(fixture('screen-remote.txt'))).toBe('This OpenClaw runs on another machine.')
  })

  it('openclaw on an old Node gives the named state', () => {
    // `openclaw --version` is the one command it runs on any Node without installing one: on Node 22 it warns, below
    // 22 it refuses.
    expect(openclawRuntimeState(fixture('version-old-node-darwin.txt'))).toBe('OpenClaw needs Node 24.')
    expect(openclawRuntimeState(fixture('version-node20-darwin.txt'))).toBe('OpenClaw needs Node 24.')
    expect(openclawRuntimeState('OpenClaw 2026.11.2 (b556fdf)\n')).toBeNull()
  })
})
