import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installedDsh } from '../../dsh/installed.js'
import { harnessLaunchOrRefusal } from '../../dsh/runtime.js'
import { createAndRegisterPane } from '../../lib/createAgentPane.js'
import { enginePathOverride } from '../../lib/engineBin.js'
import { buildEngineLaunchArgv, refusePermissionFlagIfUnsupported, supportsNamedAgent } from '../../lib/engineLaunch.js'
import { planFork } from '../../lib/forkAgent.js'
import type { RegisteredSession } from '../../lib/registry.js'
import { createAgentForker, type ForkAgentDeps } from './fork.js'

vi.mock('../../dsh/installed.js', () => ({ installedDsh: vi.fn(() => undefined) }))
vi.mock('../../dsh/runtime.js', async (real) => ({
  ...await real<object>(),
  forkRuntimeKey: vi.fn(() => 'source-key'),
  harnessLaunchOrRefusal: vi.fn((prepare: () => unknown) => { prepare(); return { ok: true, launch: { env: { HARNESS_DSH: 'blender' }, args: ['--dsh'] } } }),
  prepareHarnessLaunch: vi.fn(),
}))
vi.mock('../../engines/opencode/version.js', () => ({ opencodeMajorVersion: vi.fn(() => 2) }))
vi.mock('../../lib/createAgentPane.js', () => ({ createAndRegisterPane: vi.fn() }))
vi.mock('../../lib/engineBin.js', async (real) => ({ ...await real<object>(), enginePathOverride: vi.fn(() => null) }))
vi.mock('../../lib/engineInstall.js', async (real) => ({ ...await real<object>(), engineInstallRecipe: vi.fn(() => ({ install: 'recipe' })) }))
vi.mock('../../lib/engineLaunch.js', async (real) => ({
  ...await real<object>(),
  buildEngineCommandArgv: vi.fn(() => ['claude']),
  buildEngineLaunchArgv: vi.fn(() => ['zsh', '-lc', 'claude']),
  namedAgentArgs: vi.fn((_engine: string, agent: string) => ['--agent', agent]),
  refusePermissionFlagIfUnsupported: vi.fn(async () => null),
  supportsNamedAgent: vi.fn(() => true),
}))
vi.mock('../../lib/forkAgent.js', async (real) => ({ ...await real<object>(), planFork: vi.fn(() => ({ ok: true, level: 'native', forkSessionId: 's1' })) }))

const root = mkdtempSync(join(tmpdir(), 'core-fork-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
const work = join(root, 'work')
mkdirSync(work)
writeFileSync(join(root, 'file'), '')

const source = (over: Partial<RegisteredSession> = {}): RegisteredSession =>
  ({ agentId: 'a1', sessionId: 's1', engine: 'claude', cwd: work, name: 'Builder', transcriptPath: '/t/s1.jsonl', ...over }) as RegisteredSession
const pending = { agentId: 'f1', sessionId: '', engine: 'claude' } as RegisteredSession

function setup(row: RegisteredSession | null = source(), over: Partial<ForkAgentDeps> = {}) {
  const deps: ForkAgentDeps = {
    tmuxBackend: {} as ForkAgentDeps['tmuxBackend'],
    registry: { byAgent: vi.fn(() => row ?? undefined) } as unknown as ForkAgentDeps['registry'],
    mirror: {
      isBusy: vi.fn(() => false),
      recentAsks: vi.fn(() => ['build it']),
      recent: vi.fn(() => [{ recap: 'built', text: 'Built the app.' }, { recap: '', text: 'Ran the tests.' }]),
      lastFullText: vi.fn(() => 'All green.'),
    } as unknown as ForkAgentDeps['mirror'],
    pendingForkInherit: new Map(),
    watchNewPane: vi.fn(async () => {}),
    announceSession: vi.fn(),
    attachDsh: vi.fn(),
    prepareApiTools: vi.fn(),
    gridName: () => 'grid-me',
    ...over,
  }
  return { deps, fork: createAgentForker(deps) }
}

describe('forking an agent', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(createAndRegisterPane).mockReset().mockResolvedValue({ ok: true, spawned: { runtime: { paneId: '%3' } }, pending } as never)
  })
  afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks() })

  it('refuses without tmux, an agent, a folder, or with a grid or a turn in progress', async () => {
    expect(await setup(source(), { tmuxBackend: null }).fork({ agentId: 'a1', name: null, prompt: null })).toEqual({ ok: false, error: 'TMUX_UNAVAILABLE' })
    expect(await setup(null).fork({ agentId: 'a1', name: null, prompt: null })).toEqual({ ok: false, error: 'AGENT_NOT_FOUND' })
    expect(await setup(source({ cwd: undefined })).fork({ agentId: 'a1', name: null, prompt: null })).toMatchObject({ error: 'CWD_NOT_FOUND', detail: expect.stringContaining('no working folder') })
    expect(await setup(source({ cwd: join(root, 'file') })).fork({ agentId: 'a1', name: null, prompt: null })).toEqual({ ok: false, error: 'CWD_NOT_FOUND' })
    expect(await setup(source({ cwd: join(root, 'gone') })).fork({ agentId: 'a1', name: null, prompt: null })).toEqual({ ok: false, error: 'CWD_NOT_FOUND' })
    expect(await setup(source({ grid: { baseUrl: 'g', model: null } } as Partial<RegisteredSession>)).fork({ agentId: 'a1', name: null, prompt: null })).toMatchObject({ error: 'FORK_ON_GRID_UNSUPPORTED' })
    expect(await setup(source({ gridLaunch: { networkId: 'g' } } as Partial<RegisteredSession>)).fork({ agentId: 'a1', name: null, prompt: null })).toMatchObject({ error: 'FORK_ON_GRID_UNSUPPORTED' })
    const busy = setup()
    vi.mocked(busy.deps.mirror.isBusy).mockReturnValue(true)
    expect(await busy.fork({ agentId: 'a1', name: null, prompt: null })).toMatchObject({ error: 'AGENT_BUSY' })
    expect(createAndRegisterPane).not.toHaveBeenCalled()
  })

  it('refuses what the plan refuses, a harness no longer installed, a launch it refuses, and a pane it cannot make', async () => {
    vi.mocked(planFork).mockReturnValueOnce({ ok: false, error: 'FORK_UNSUPPORTED', detail: 'amp cannot fork' } as never)
    expect(await setup().fork({ agentId: 'a1', name: null, prompt: null })).toEqual({ ok: false, error: 'FORK_UNSUPPORTED', detail: 'amp cannot fork' })
    expect(await setup(source({ dsh: 'blender' } as Partial<RegisteredSession>)).fork({ agentId: 'a1', name: null, prompt: null })).toMatchObject({ error: 'INVALID_DSH' })
    vi.mocked(installedDsh).mockReturnValue({ manifest: { name: 'Blender' } } as never)
    vi.mocked(harnessLaunchOrRefusal).mockReturnValueOnce({ ok: false, error: 'DSH_RUNTIME', detail: 'no runtime' } as never)
    expect(await setup(source({ dsh: 'blender' } as Partial<RegisteredSession>)).fork({ agentId: 'a1', name: null, prompt: null })).toEqual({ ok: false, error: 'DSH_RUNTIME', detail: 'no runtime' })
    vi.mocked(installedDsh).mockReset().mockReturnValue(undefined)
    vi.mocked(refusePermissionFlagIfUnsupported).mockResolvedValueOnce({ error: 'PERMISSION_MODE_UNSUPPORTED', detail: 'no --auto' } as never)
    expect(await setup().fork({ agentId: 'a1', name: null, prompt: null })).toEqual({ ok: false, error: 'PERMISSION_MODE_UNSUPPORTED', detail: 'no --auto' })
    vi.mocked(createAndRegisterPane).mockResolvedValueOnce({ ok: false, error: 'SPAWN_FAILED', detail: 'tmux said no' } as never)
    expect(await setup().fork({ agentId: 'a1', name: null, prompt: null })).toEqual({ ok: false, error: 'SPAWN_FAILED', detail: 'tmux said no' })
  })

  it('forks natively: the source\'s session, folder and permission, the source\'s recap waiting for the new tile', async () => {
    const { deps, fork } = setup(source({ permissionMode: 'plan', bypassPermission: true, codexHome: '/codex' } as Partial<RegisteredSession>))
    expect(await fork({ agentId: 'a1', name: null, prompt: 'try the other approach' })).toEqual({ ok: true, session: pending, level: 'native' })
    expect(planFork).toHaveBeenCalledWith({ engine: 'claude', sessionId: 's1', name: expect.any(String), cwd: work },
      { asks: ['build it'], recaps: ['built', 'Ran the tests.'], lastAnswer: 'All green.' }, 'try the other approach')
    expect(vi.mocked(buildEngineLaunchArgv).mock.calls[0][1]).toMatchObject({ forkSessionId: 's1', firstPrompt: 'try the other approach', permissionMode: 'plan', bypassPermission: true, cwd: work })
    expect(vi.mocked(createAndRegisterPane).mock.calls[0][0]).toMatchObject({
      cwd: work, env: { CODEX_HOME: '/codex' }, codexHome: '/codex', permissionMode: 'plan', defaultName: expect.any(String),
      forkedFrom: { agentId: 'a1', sessionId: 's1', transcriptPath: '/t/s1.jsonl' },
    })
    expect(deps.pendingForkInherit.get('f1')).toBe('s1')
    expect(deps.prepareApiTools).toHaveBeenCalledWith(work, 'claude')
    expect(deps.announceSession).toHaveBeenCalledWith(pending)
    expect(deps.watchNewPane).toHaveBeenCalledWith('claude', pending, { runtime: { paneId: '%3' } }, ['claude'], { install: 'recipe' })
  })

  it('hands off what it remembers to an engine that cannot fork, and names the fork as asked', async () => {
    vi.mocked(planFork).mockReturnValueOnce({ ok: true, level: 'handoff', firstPrompt: 'You are continuing…' } as never)
    const { fork } = setup()
    expect(await fork({ agentId: 'a1', name: 'Builder 2', prompt: null })).toMatchObject({ level: 'handoff' })
    const options = vi.mocked(buildEngineLaunchArgv).mock.calls[0][1] as Record<string, unknown>
    expect(options).toMatchObject({ firstPrompt: 'You are continuing…' })
    expect(options).not.toHaveProperty('forkSessionId')
    expect(vi.mocked(createAndRegisterPane).mock.calls[0][0]).toMatchObject({ defaultName: 'Builder 2' })
  })

  it('forks an agent with no session from what little it has, and opens a native fork with no first prompt', async () => {
    const { deps, fork } = setup(source({ sessionId: '', transcriptPath: undefined } as Partial<RegisteredSession>))
    await fork({ agentId: 'a1', name: null, prompt: null })
    expect(vi.mocked(planFork).mock.calls[0][1]).toEqual({ asks: [], recaps: [], lastAnswer: undefined })
    expect(vi.mocked(buildEngineLaunchArgv).mock.calls[0][1]).not.toHaveProperty('firstPrompt')
    expect(vi.mocked(createAndRegisterPane).mock.calls[0][0]).toMatchObject({ forkedFrom: { agentId: 'a1' }, env: undefined, permissionMode: null, bypassPermission: false })
    expect(deps.pendingForkInherit.size).toBe(0)
    // A session without a transcript on record still forks from its session.
    await setup(source({ transcriptPath: undefined } as Partial<RegisteredSession>)).fork({ agentId: 'a1', name: null, prompt: null })
    expect(vi.mocked(createAndRegisterPane).mock.calls[1][0]).toMatchObject({ forkedFrom: { agentId: 'a1', sessionId: 's1' } })
  })

  it('carries the harness and the named agent over, when the engine still takes it', async () => {
    vi.mocked(installedDsh).mockReturnValue({ manifest: { name: 'Blender' } } as never)
    vi.mocked(createAndRegisterPane).mockResolvedValue({ ok: true, spawned: { runtime: { paneId: '%3' } }, pending: { ...pending, dsh: 'blender' } } as never)
    vi.mocked(enginePathOverride).mockReturnValueOnce('/opt/claude' as never)
    const { deps, fork } = setup(source({ dsh: 'blender', dshRuntime: 'harness-claude-x', agent: 'reviewer' } as Partial<RegisteredSession>))
    await fork({ agentId: 'a1', name: null, prompt: null })
    expect(vi.mocked(buildEngineLaunchArgv).mock.calls[0][1]).toMatchObject({ extraArgs: ['--dsh', '--agent', 'reviewer'], harnessNode: true, installIfMissing: undefined })
    expect(vi.mocked(createAndRegisterPane).mock.calls[0][0]).toMatchObject({ dsh: 'blender', agent: 'reviewer', label: 'Blender', env: { HARNESS_DSH: 'blender' } })
    expect(deps.attachDsh).toHaveBeenCalled()
    vi.mocked(supportsNamedAgent).mockReturnValueOnce(false)
    await setup(source({ agent: 'reviewer' } as Partial<RegisteredSession>)).fork({ agentId: 'a1', name: null, prompt: null })
    expect(vi.mocked(buildEngineLaunchArgv).mock.calls[1][1]).toMatchObject({ extraArgs: undefined })
    vi.mocked(installedDsh).mockReset().mockReturnValue(undefined)
  })
})
