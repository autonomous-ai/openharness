import { describe, expect, it } from 'vitest'
import type { InstalledDsh } from './installed.js'
import { dshLaunch, harnessEnvToClear, DSH_SESSION_ENV } from './launch.js'
import { buildLaunchOverrides, type LaunchOverridesDeps } from '../lib/launchOverrides.js'
import { dshFromEnv } from './probe.js'

const installed: InstalledDsh = {
  id: 'autonomous/circuit', dir: '/home/u/.harness/dsh/autonomous/circuit', realDir: '/src/circuit',
  source: '', ref: null, commit: null, linked: true, installedAt: 0,
  manifest: {
    spec: 1, id: 'autonomous/circuit', name: 'Circuit', engine: 'claude',
    agent: {
      env: { CIRCUIT_TOOLCHAIN: '${dsh}/toolchain', CIRCUIT_SKILLS_DIR: '${workspace}/.claude/skills', HARNESS_DSH: 'spoofed' },
      args: ['--add-dir', '${workspace}/inputs'],
    },
  },
}

describe('dshLaunch', () => {
  it('sets the three HARNESS_ variables, expands the manifest env, and refuses a manifest that renames itself', () => {
    const launch = dshLaunch(installed, '/ws')
    expect(launch.env).toEqual({
      HARNESS_DSH: 'autonomous/circuit',
      HARNESS_DSH_DIR: '/src/circuit',
      HARNESS_WORKSPACE: '/ws',
      CIRCUIT_TOOLCHAIN: '/src/circuit/toolchain',
      CIRCUIT_SKILLS_DIR: '/ws/.claude/skills',
    })
    expect(launch.args).toEqual(['--add-dir', '/ws/inputs'])
    // What discovery reads back is exactly what was set.
    expect(dshFromEnv(launch.env)).toBe('autonomous/circuit')
  })

  it('a manifest with no agent section adds only the three HARNESS_ variables and no argv', () => {
    const bare: InstalledDsh = { ...installed, manifest: { spec: 1, id: 'autonomous/circuit', name: 'Circuit', engine: 'claude' } }
    expect(dshLaunch(bare, '/ws')).toEqual({
      env: { HARNESS_DSH: 'autonomous/circuit', HARNESS_DSH_DIR: '/src/circuit', HARNESS_WORKSPACE: '/ws' },
      args: [],
    })
  })
})

describe('buildLaunchOverrides with a DSH', () => {
  const deps: LaunchOverridesDeps = {
    // The branch replaced `configDirFor` with the machine facts the grid launch builder reads itself.
    machine: () => ({ hermesSystemManaged: false }),
    writeGridConfigDir: async () => '/cfg',
    tmuxSupportsSessionEnv: async () => true,
    installCodexHooks: () => undefined,
    dshLaunch: (id, workspace, engine) => (id === installed.id ? dshLaunch(installed, workspace, {}, engine) : null),
  }

  it('layers the DSH env and argv over a plain relaunch', async () => {
    const built = await buildLaunchOverrides(deps, 'claude', { dsh: 'autonomous/circuit', cwd: '/ws' }, 'agent-1')
    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(built.overrides.env.HARNESS_DSH).toBe('autonomous/circuit')
    expect(built.overrides.env.CIRCUIT_TOOLCHAIN).toBe('/src/circuit/toolchain')
    expect(built.overrides.extraArgs).toEqual(['--add-dir', '/ws/inputs'])
  })

  it('layers it over a Codex profile too, keeping CODEX_HOME', async () => {
    const built = await buildLaunchOverrides(deps, 'codex', { dsh: 'autonomous/circuit', cwd: '/ws', codexHome: '/home/u/.codex-work' }, 'agent-1')
    expect(built.ok && built.overrides.env).toMatchObject({ CODEX_HOME: '/home/u/.codex-work', HARNESS_DSH: 'autonomous/circuit' })
    expect(built.ok && built.overrides.extraArgs).not.toContain('--add-dir')
  })

  it('refuses a restart when the DSH is no longer installed here', async () => {
    const built = await buildLaunchOverrides(deps, 'claude', { dsh: 'gone/away', cwd: '/ws' }, 'agent-1')
    expect(built).toMatchObject({ ok: false, error: 'DSH_NOT_INSTALLED' })
  })

  it('refuses to silently lose a harness when its workspace is missing', async () => {
    const built = await buildLaunchOverrides(deps, 'claude', { dsh: 'autonomous/circuit', cwd: null }, 'agent-1')
    expect(built).toMatchObject({ ok: false, error: 'DSH_WORKSPACE_MISSING' })
  })
})

describe('dshFromEnv', () => {
  it('accepts only a well-formed id', () => {
    expect(dshFromEnv({ HARNESS_DSH: 'autonomous/workshop' })).toBe('autonomous/workshop')
    expect(dshFromEnv({ HARNESS_DSH: 'not an id' })).toBeNull()
    expect(dshFromEnv({})).toBeNull()
  })
})

it('clears inherited session facts except those explicitly supplied by this launch', () => {
  expect(harnessEnvToClear()).toEqual(DSH_SESSION_ENV)
  expect(harnessEnvToClear({ HARNESS_DSH: 'acme/draw' })).toEqual(DSH_SESSION_ENV.filter(name => name !== 'HARNESS_DSH'))
  expect(harnessEnvToClear(Object.fromEntries(DSH_SESSION_ENV.map(name => [name, 'current'])))).toEqual([])
})
