import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAndRegisterPane } from '../lib/createAgentPane.js'
import { buildLaunchOverrides, type LaunchOverridesDeps } from '../lib/launchOverrides.js'
import type { TerminalCreateResult, TmuxRuntimeRef } from '../lib/terminalTypes.js'
import * as scmProjects from './scmProjects.js'
import type { ScmLaunchRecord } from './types.js'

let dataDir = ''

// Mirrors lib/registry.spec.ts's loadRegistryModule(): a fresh registry module per test, backed by
// its own temp state dir. The reload is the point of half these tests — a row is rebuilt from an
// explicit field list on load, and a field missing from that list survives the write and dies there.
async function loadRegistryModule() {
  vi.resetModules()
  process.env.ADAPTER_DATA_DIR = dataDir
  process.env.CLAUDE_PROJECTS_DIR = dataDir
  process.env.CODEX_HOME = dataDir
  process.env.CURSOR_HOME = dataDir
  return import('../lib/registry.js')
}

const GIT: ScmLaunchRecord = { kind: 'git' }

function deps(): LaunchOverridesDeps {
  return {
    machine: () => ({ hermesSystemManaged: false }),
    writeGridConfigDir: async (key) => `/state/grid-engine-config/${key}`,
    tmuxSupportsSessionEnv: async () => true,
    installCodexHooks: () => {},
    readCodexConfig: () => null,
  }
}

describe('the SCM launch record on the registry row', () => {
  beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'adapter-registry-scm-')) })
  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(dataDir, { recursive: true, force: true })
    delete process.env.ADAPTER_DATA_DIR
    delete process.env.CLAUDE_PROJECTS_DIR
    delete process.env.CODEX_HOME
    delete process.env.CURSOR_HOME
  })

  it('is written at create, survives a reload and the first hook bind, and is absent — not null — when nothing prepared the folder', async () => {
    const { registry } = await loadRegistryModule()
    registry.load()
    const prepared = registry.openPendingAgent({
      engine: 'claude', runtimes: [{ backend: 'tmux', paneId: '%9' }], cwd: '/tmp/demo', scmLaunchRecord: GIT,
    })!
    expect(prepared.scmLaunch).toEqual(GIT)
    const plain = registry.openPendingAgent({
      engine: 'claude', runtimes: [{ backend: 'tmux', paneId: '%10' }], cwd: '/tmp/plain',
    })!
    expect(plain).not.toHaveProperty('scmLaunch')
    const nulled = registry.openPendingAgent({
      engine: 'claude', runtimes: [{ backend: 'tmux', paneId: '%11' }], cwd: '/tmp/nulled', scmLaunchRecord: null,
    })!
    expect(nulled).not.toHaveProperty('scmLaunch')

    const { registry: reloaded } = await loadRegistryModule()
    reloaded.load()
    expect(reloaded.byAgent(prepared.agentId)?.scmLaunch).toEqual(GIT)
    expect(reloaded.byAgent(plain.agentId)).not.toHaveProperty('scmLaunch')

    // A hook bind rebuilds the row from named fields; a field the rebuild does not name is still on
    // disk while memory has already forgotten it.
    const transcriptPath = join(dataDir, 'session-scm.jsonl')
    writeFileSync(transcriptPath, '{}\n')
    const bound = reloaded.register({ sessionId: 'session-scm', transcriptPath, tmuxPane: '%9', cwd: '/tmp/demo' })
    expect(bound?.entry.agentId).toBe(prepared.agentId)
    expect(bound?.entry.scmLaunch).toEqual(GIT)
    const saved = JSON.parse(readFileSync(join(dataDir, 'registry.json'), 'utf-8')) as Array<Record<string, unknown>>
    expect(saved.find(row => row.agentId === prepared.agentId)).toMatchObject({ scmLaunch: GIT })
    expect(saved.find(row => row.agentId === plain.agentId)).not.toHaveProperty('scmLaunch')
  })

  it('drops an unrecognised or half-formed record from disk rather than relaunching with it', async () => {
    const { registry } = await loadRegistryModule()
    registry.load()
    const row = registry.openPendingAgent({ engine: 'claude', runtimes: [{ backend: 'tmux', paneId: '%3' }], cwd: '/tmp/demo', scmLaunchRecord: GIT })!
    const saved = JSON.parse(readFileSync(join(dataDir, 'registry.json'), 'utf-8')) as Array<Record<string, unknown>>
    const damaged = saved.map(entry => entry.agentId === row.agentId ? { ...entry, scmLaunch: { kind: 'svn', url: 'x' } } : entry)
    writeFileSync(join(dataDir, 'registry.json'), JSON.stringify(damaged))
    const { registry: reloaded, strictPersistedRow } = await loadRegistryModule()
    reloaded.load()
    expect(reloaded.byAgent(row.agentId)).not.toHaveProperty('scmLaunch')
    // The same rule for a row read back from elsewhere (a stopped harness's saved row).
    expect(strictPersistedRow({ ...saved[0], scmLaunch: { kind: 'svn' } })).not.toHaveProperty('scmLaunch')
    expect(strictPersistedRow({ ...saved[0], scmLaunch: GIT })).toMatchObject({ scmLaunch: GIT })
  })

  it('goes from the pane create to the row to every relaunch, where its env layers last', async () => {
    const { registry } = await loadRegistryModule()
    registry.load()
    const create = vi.fn(async (): Promise<TerminalCreateResult<TmuxRuntimeRef>> => ({ state: 'succeeded', dispatch: 'executed', runtime: { backend: 'tmux', paneId: '%1' } }))
    const tmuxBackend = { create, kill: vi.fn(async () => ({ state: 'succeeded' as const, dispatch: 'executed' as const })) }
    const result = await createAndRegisterPane({
      tmuxBackend, registry, engine: 'claude', cwd: '/tmp/demo', sessionLabel: 'harness-claude-1', argv: ['claude'], scmLaunchRecord: GIT,
    })
    if (!result.ok) throw new Error(result.error)
    const row = registry.byAgent(result.pending.agentId)!
    expect(row.scmLaunch).toEqual(GIT)

    // The git record asks for nothing, so a git row's overrides are exactly what they were.
    const before = await buildLaunchOverrides(deps(), 'claude', { ...row, scmLaunch: undefined }, row.agentId)
    expect(await buildLaunchOverrides(deps(), 'claude', row, row.agentId)).toEqual(before)
    expect(await buildLaunchOverrides(deps(), 'claude', { ...row, scmLaunch: null }, row.agentId)).toEqual(before)

    // An SCM whose workspace binding travels in the environment: its env goes over the DSH's.
    vi.spyOn(scmProjects, 'scmLaunchEnv').mockImplementation(record => record ? { SCM_WORKSPACE: 'bound' } : undefined)
    const built = await buildLaunchOverrides({ ...deps(), dshLaunch: () => ({ env: { SCM_WORKSPACE: 'not-this-one', HARNESS_DSH: 'x' }, args: ['--dsh'] }) },
      'claude', { ...row, dsh: 'x', cwd: '/tmp/demo' }, row.agentId)
    expect(built).toMatchObject({ ok: true, overrides: {
      env: { HARNESS_DSH: 'x', SCM_WORKSPACE: 'bound' },
      extraArgs: expect.arrayContaining(['--dsh']),
    } })
  })
})
