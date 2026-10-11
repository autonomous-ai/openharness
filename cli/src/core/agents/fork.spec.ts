import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installedDsh } from '../../dsh/installed.js'
import { createAndRegisterPane } from '../../lib/createAgentPane.js'
import { enginePathOverride } from '../../lib/engineBin.js'
import { buildEngineLaunchArgv, refusePermissionFlagIfUnsupported, supportsNamedAgent } from '../../lib/engineLaunch.js'
import { planFork } from '../../lib/forkAgent.js'
import { prepareInstructionWrites } from '../../scm/scmProjects.js'
import type { RegisteredSession } from '../../lib/registry.js'
import { createAgentForker, type ForkAgentDeps } from './fork.js'
import type { NativeLaunch } from '../../engines/nativeLaunch.js'
import { createLaunchHelpers } from './launch.js'

vi.mock('../../dsh/installed.js', () => ({ installedDsh: vi.fn(() => undefined) }))

// OpenCode's version probe is its own code, loaded for an OpenCode launch alone; a test may say it could not be.
vi.mock('../../engines/inProcess.js', async (real) => {
  const actual = await real<typeof import('../../engines/inProcess.js')>()
  return { ...actual, loadEngine: vi.fn(actual.loadEngine) }
})
vi.mock('../../engines/launchControl.js', () => ({ opencodeMajorVersion: vi.fn(() => 2) }))
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
vi.mock('../../scm/scmProjects.js', async (real) => {
  const actual = await real<typeof import('../../scm/scmProjects.js')>()
  return { ...actual, prepareInstructionWrites: vi.fn(actual.prepareInstructionWrites) }
})
vi.mock('../../lib/forkAgent.js', async (real) => ({ ...await real<object>(), planFork: vi.fn(() => ({ ok: true, level: 'native', forkSessionId: 's1' })) }))

const launchDsh = vi.fn<ForkAgentDeps['dshLaunch']['launch']>(async () => ({ ok: true, launch: { env: { HARNESS_DSH: 'blender' }, args: ['--dsh'] } }))

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
    // What a restart or a resume relaunches the row with (launch.ts): a Codex profile's CODEX_HOME here.
    relaunchOverrides: vi.fn(async (session: RegisteredSession) => ({
      ok: true as const, overrides: { env: (session.codexHome ? { CODEX_HOME: session.codexHome } : {}) as Record<string, string>, extraArgs: [] as string[], clearEnv: [] as string[] },
    })),
    gridName: () => 'grid-me',
    dshLaunch: { launch: launchDsh },
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

  it.each(['initial', 'source', 'inspect', 'harness', 'overrides', 'hooks', 'permission', 'instructions'] as const)(
    'cannot dispatch a fork whose original owner is revoked during %s', async stage => {
      let current = stage !== 'initial'
      const revoke = (at: string) => { if (stage === at) current = false }
      const launch = { current: () => true, environment: { HOME: root }, opencodeMajor: 1 } as unknown as NativeLaunch
      vi.mocked(installedDsh).mockReturnValue({ manifest: { name: 'Fixture' } } as never)
      vi.mocked(refusePermissionFlagIfUnsupported).mockImplementation(async () => { revoke('permission'); return null })
      vi.mocked(prepareInstructionWrites).mockImplementation(async () => revoke('instructions'))
      const run = setup(source({ dsh: 'fixture/tools' }), {
        authority: () => () => stage !== 'source',
        native: async (_engine, _source, authority) => { authority.hold({ service: 'native', detail: 'Checking fixture' }); revoke('inspect'); return { ok: true, launch } },
        dshLaunch: { launch: async () => { revoke('harness'); return { ok: true, launch: { env: {}, args: [] } } } },
        relaunchOverrides: async () => { revoke('overrides'); return { ok: true, overrides: { native: launch, env: {}, extraArgs: [], clearEnv: [] } } },
        prepareNative: async () => { revoke('hooks'); return true },
      })
      try {
        const result = await run.fork.prepare({ agentId: 'a1', name: null, prompt: 'original prompt' },
          { id: 'fixture', label: 'harness-claude-fixture', current: () => current, hold: vi.fn() })
        expect(result).toMatchObject({ ok: false, error: 'AGENT_CHANGED' })
        expect(createAndRegisterPane).not.toHaveBeenCalled()
      } finally {
        vi.mocked(installedDsh).mockReset().mockReturnValue(undefined)
        vi.mocked(refusePermissionFlagIfUnsupported).mockReset().mockResolvedValue(null)
        vi.mocked(prepareInstructionWrites).mockReset().mockResolvedValue(undefined)
      }
    },
  )

  it('holds an unconfirmed final fork configuration before permission checks or dispatch', async () => {
    const launch = { current: () => true, environment: { HOME: root }, opencodeMajor: 1 } as unknown as NativeLaunch
    const run = setup(source(), {
      native: async (_engine, _source, authority) => { authority.hold({ service: 'native', detail: 'Checking fixture' }); return { ok: true, launch } },
      relaunchOverrides: async () => ({ ok: true, overrides: { native: launch, env: {}, extraArgs: [], clearEnv: [] } }),
      prepareNative: async () => false,
    })
    expect(await run.fork({ agentId: 'a1', name: null, prompt: null })).toMatchObject({ unavailable: 'native' })
    expect(refusePermissionFlagIfUnsupported).not.toHaveBeenCalled()
    expect(createAndRegisterPane).not.toHaveBeenCalled()
  })

  it('holds unavailable native preparation without touching the source or opening a pane', async () => {
    const native = vi.fn(async () => ({ ok: false as const, error: 'NATIVE_LAUNCH_HELD' as const, unavailable: 'native' as const, detail: 'Installing' }))
    const run = setup(source(), { native })
    expect(await run.fork({ agentId: 'a1', name: null, prompt: null })).toMatchObject({ unavailable: 'native' })
    expect(run.deps.relaunchOverrides).not.toHaveBeenCalled()
    expect(createAndRegisterPane).not.toHaveBeenCalled()
  })

  it('prepares final fork locations with one snapshot and retains ownership until dispatch', async () => {
    vi.mocked(installedDsh).mockReturnValueOnce({ manifest: { name: 'Fixture' } } as never)
    const launch = { current: () => true, opencodeMajor: 2, environment: { HOME: '/fixture/home', CODEX_HOME: '/fixture/profile' }, token: 'fixture-native' } as unknown as NativeLaunch
    const native = vi.fn(async () => ({ ok: true as const, launch }))
    const prepareNative = vi.fn(async () => true)
    const relaunchOverrides = vi.fn(async () => ({ ok: true as const, overrides: { native: launch, env: { CODEX_HOME: '/fixture/profile' }, extraArgs: [], clearEnv: [] } }))
    const run = setup(source({ engine: 'codex', dsh: 'fixture/tools' }), { native, prepareNative, relaunchOverrides })
    let current = true
    const authority = { id: 'fixture-operation', label: 'harness-codex-fixture', current: () => current, hold: vi.fn() }
    const prepared = await run.fork.prepare({ agentId: 'a1', name: null, prompt: null }, authority)
    expect(prepared.ok).toBe(true)
    expect(native).toHaveBeenCalledOnce()
    expect(relaunchOverrides).toHaveBeenCalledWith(expect.any(Object), expect.any(Object), expect.any(Function), launch, authority.label)
    expect(prepareNative).toHaveBeenCalledWith(launch, expect.any(Function), expect.objectContaining({ CODEX_HOME: '/fixture/profile', HARNESS_DSH: 'blender' }), expect.any(Array))
    expect(createAndRegisterPane).not.toHaveBeenCalled()
    current = false
    if (!prepared.ok) throw Error('fixture held')
    expect(await prepared.dispatch()).toMatchObject({ error: 'AGENT_CHANGED' })
    expect(createAndRegisterPane).not.toHaveBeenCalled()
  })

  it.each(['claude', 'codex'] as const)('keeps real %s launch preparation authorized and records its final harness-selected home', async engine => {
    const executable = await import('../../engines/kit/launchExecutable.js')
    vi.spyOn(executable, 'captureLaunchExecutable').mockResolvedValue({ state: 'ready',
      executable: { command: '/fixture/engine', identity: 'fixture', current: () => true },
      environment: { HOME: root, PATH: '/fixture/bin' },
    })
    const { inspectNativeLaunch } = await import('../../engines/nativeLaunch.js')
    const prepareNative = (native: NativeLaunch, current: () => boolean, environment?: Readonly<Record<string, string>>, clear?: readonly string[]) => native.prepareHooks(0, current, environment, clear)
    const helpers = createLaunchHelpers({ authority: () => () => true, prepareApiTools: vi.fn(), setGridLaunch: vi.fn(), setTail: vi.fn(),
      launchOverridesDeps: { native: (engine, source) => inspectNativeLaunch(engine, source), prepareNative,
        machine: () => ({ hermesSystemManaged: false }), gridLaunch: vi.fn(), writeGridConfigDir: vi.fn(),
        tmuxSupportsSessionEnv: async () => true, installCodexHooks: async () => true,
      },
    })
    const finalHome = join(root, 'harness-codex')
    vi.mocked(installedDsh).mockReturnValueOnce({ manifest: { name: 'Fixture' } } as never)
    launchDsh.mockResolvedValueOnce({ ok: true, launch: { env: { CODEX_HOME: finalHome }, args: [] } })
    const run = setup(source({ engine, codexHome: join(root, 'selected-codex'), dsh: 'fixture/tools' }), { native: (engine, source) => inspectNativeLaunch(engine, source), prepareNative, relaunchOverrides: helpers.relaunchOverrides })
    expect(await run.fork({ agentId: 'a1', name: null, prompt: null })).toMatchObject({ ok: true })
    expect(executable.captureLaunchExecutable).toHaveBeenCalledOnce()
    const request = vi.mocked(createAndRegisterPane).mock.calls[0]![0]
    expect(request.current?.()).toBe(true)
    expect(request.env?.HOME).toBe(root)
    expect(request.env?.CODEX_HOME).toBe(finalHome)
    if (engine === 'codex') expect(request.codexHome).toBe(finalHome)
  })

  it('does not open instruction files or install API notes while its harness waits for the Store', async () => {
    vi.mocked(installedDsh).mockReturnValueOnce({ manifest: { name: 'Fixture' } } as never)
    launchDsh.mockResolvedValueOnce({ ok: false, error: 'DSH_UNAVAILABLE', detail: 'Waiting for the Store.', unavailable: 'store' })
    const { fork, deps } = setup(source({ dsh: 'fixture/tools' }))
    expect(await fork({ agentId: 'a1', name: null, prompt: null })).toMatchObject({ ok: false, error: 'DSH_UNAVAILABLE' })
    expect(prepareInstructionWrites).not.toHaveBeenCalled()
    expect(deps.prepareApiTools).not.toHaveBeenCalled()
    expect(createAndRegisterPane).not.toHaveBeenCalled()
  })

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
    launchDsh.mockResolvedValueOnce({ ok: false, error: 'DSH_RUNTIME', detail: 'no runtime', thrown: 'Error: no runtime' })
    expect(await setup(source({ dsh: 'blender' } as Partial<RegisteredSession>)).fork({ agentId: 'a1', name: null, prompt: null })).toEqual({ ok: false, error: 'DSH_RUNTIME', detail: 'no runtime' })
    launchDsh.mockResolvedValueOnce({ ok: false, error: 'DSH_UNAVAILABLE', detail: 'Store unavailable', unavailable: 'store' })
    expect(await setup(source({ dsh: 'blender' } as Partial<RegisteredSession>)).fork({ agentId: 'a1', name: null, prompt: null })).toEqual({ ok: false, error: 'DSH_UNAVAILABLE', detail: 'Store unavailable', unavailable: 'store' })
    expect(createAndRegisterPane).not.toHaveBeenCalled()
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

  // A fork launched without the overrides a restart and a resume rebuild from the row: a Codex agent
  // moved back off a grid lost `-c model_provider=…` and its model, and the fork came back on Codex's
  // default model where a restart came back on the agent's own.
  it('launches with the row\'s own-login overrides, as a restart and a resume do, the harness and named agent its own', async () => {
    vi.mocked(installedDsh).mockReturnValue({ manifest: { name: 'Blender' } } as never)
    const relaunchOverrides = vi.fn(async () => ({
      ok: true as const,
      overrides: { env: { CODEX_HOME: '/codex', MODEL_ENV: 'x' }, extraArgs: ['-c', 'model_provider="openai"', '-m', 'gpt-6'], clearEnv: ['HARNESS_DSH'] },
    }))
    const row = source({ engine: 'codex', codexHome: '/codex', subscriptionModel: 'gpt-6', dsh: 'blender', agent: 'reviewer' } as Partial<RegisteredSession>)
    await setup(row, { relaunchOverrides }).fork({ agentId: 'a1', name: null, prompt: null })
    // The harness's runtime is the fork's own and so is its named agent: neither is rebuilt from the row.
    expect(relaunchOverrides).toHaveBeenCalledWith(row, expect.objectContaining({ codexHome: '/codex', subscriptionModel: 'gpt-6', dsh: null, agent: null }), expect.any(Function), undefined, expect.stringContaining('harness-codex-'))
    expect(vi.mocked(buildEngineLaunchArgv).mock.calls[0][1]).toMatchObject({
      extraArgs: ['-c', 'model_provider="openai"', '-m', 'gpt-6', '--dsh', '--agent', 'reviewer'],
      // What the harness's launch provides is never cleared under it.
      clearEnv: expect.not.arrayContaining(['HARNESS_DSH']),
    })
    expect(vi.mocked(createAndRegisterPane).mock.calls[0][0]).toMatchObject({ env: { CODEX_HOME: '/codex', MODEL_ENV: 'x', HARNESS_DSH: 'blender' }, codexHome: '/codex' })
    vi.mocked(installedDsh).mockReset().mockReturnValue(undefined)
    // A launch the row cannot be given (a saved API since removed) is refused before any pane opens.
    vi.mocked(createAndRegisterPane).mockClear()
    const refused = vi.fn(async () => ({ ok: false as const, error: 'API_UNAVAILABLE', detail: 'gone' }))
    expect(await setup(source(), { relaunchOverrides: refused }).fork({ agentId: 'a1', name: null, prompt: null })).toEqual({ ok: false, error: 'API_UNAVAILABLE', detail: 'gone' })
    expect(createAndRegisterPane).not.toHaveBeenCalled()
  })

  it('forks OpenCode with eager version facts while optional code is unavailable', async () => {
    const { loadEngine } = await import('../../engines/inProcess.js')
    vi.mocked(loadEngine).mockResolvedValue(null)
    await setup(source({ agent: 'reviewer' })).fork({ agentId: 'a1', name: null, prompt: null })
    expect(supportsNamedAgent).toHaveBeenLastCalledWith('claude', null)
    await setup(source({ engine: 'opencode', agent: 'reviewer' })).fork({ agentId: 'a1', name: null, prompt: null })
    expect(supportsNamedAgent).toHaveBeenLastCalledWith('opencode', 2)
    expect(createAndRegisterPane).toHaveBeenCalledTimes(2)
    expect(loadEngine).not.toHaveBeenCalled()
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
