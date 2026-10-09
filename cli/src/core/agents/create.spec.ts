import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installedDsh } from '../../dsh/installed.js'
import { dshPinnedPermissionMode } from '../../dsh/manifest.js'
import { incompatibleHarnessEngine } from '../../dsh/compatibility.js'
import { createAndRegisterPane } from '../../lib/createAgentPane.js'
import { enginePathOverride } from '../../lib/engineBin.js'
import { buildEngineLaunchArgv, namedAgentArgs, permissionModeFlags, refusePermissionFlagIfUnsupported, supportsFirstPrompt } from '../../lib/engineLaunch.js'
import { setUpWithin } from '../../lib/setUpWithin.js'
import { writeGridConfigDir } from '../../lib/gridConfigDir.js'
import type { GridLaunchAnswer, GridLaunchRequest } from '../../lib/gridLaunchWire.js'
import { engineHooks } from '../../engines/hooks.js'
import { loadEngine } from '../../engines/inProcess.js'
import type { RegisteredSession } from '../../lib/registry.js'
import { stopSessionOwner, type SessionOwner } from '../../lib/sessionSearch/external.js'
import { clearPaneRemainOnExit } from '../../lib/tmux.js'
import { tmuxSupportsSessionEnv } from '../../lib/tmuxVersion.js'
import { createAgentCreator, type CreateAgentDeps } from './create.js'
import { prepareInstructionWrites } from '../../scm/scmProjects.js'

vi.mock('../../scm/scmProjects.js', async real => ({ ...await real<object>(), prepareInstructionWrites: vi.fn(async () => {}) }))

vi.mock('../../dsh/installed.js', () => ({ installedDsh: vi.fn(() => undefined) }))
vi.mock('../../dsh/manifest.js', async (real) => ({ ...await real<object>(), dshPinnedPermissionMode: vi.fn(() => null) }))
vi.mock('../../dsh/compatibility.js', () => ({ incompatibleHarnessEngine: vi.fn(() => null) }))
const materializeWorkspace = vi.fn(async () => ({ warnings: [], created: [], kept: [] }))

vi.mock('../../dsh/launch.js', async (real) => ({ ...await real<object>(), harnessEnvToClear: vi.fn(() => ['HARNESS_OLD']) }))
// OpenCode's version probe is its own code, loaded for an OpenCode launch alone; a test may say it could not be.
vi.mock('../../engines/inProcess.js', async (real) => {
  const actual = await real<typeof import('../../engines/inProcess.js')>()
  return { ...actual, loadEngine: vi.fn(actual.loadEngine) }
})
vi.mock('../../engines/launchControl.js', () => ({ opencodeMajorVersion: vi.fn(() => 2) }))
// The engines' folder trust (engines/launchPrep.ts), one spy per engine: never the person's own config.
const trust = vi.hoisted(() => ({
  claudeTrusts: vi.fn((_path: string) => false), codexTrusts: vi.fn((_path: string, _profile?: string | null) => false),
  preTrustClaudeProject: vi.fn((_path: string): unknown => undefined), preTrustCodexProject: vi.fn((_path: string, _profile?: string | null): unknown => undefined),
}))
const { preTrustClaudeProject, preTrustCodexProject } = trust
vi.mock('../../engines/launchPrep.js', () => ({ folderTrust: (engine: string, profile?: string | null) => engine === 'claude'
    ? { trusts: (path: string) => trust.claudeTrusts(path), record: (path: string) => trust.preTrustClaudeProject(path) }
    : engine === 'codex' ? { trusts: (path: string) => trust.codexTrusts(path, profile), record: (path: string) => trust.preTrustCodexProject(path, profile) } : null }))
vi.mock('../../lib/createAgentPane.js', () => ({ createAndRegisterPane: vi.fn() }))
vi.mock('../../lib/engineBin.js', async (real) => ({ ...await real<object>(), enginePathOverride: vi.fn(() => null) }))
vi.mock('../../lib/engineInstall.js', async (real) => ({ ...await real<object>(), engineInstallRecipe: vi.fn(() => ({ install: 'recipe' })) }))
vi.mock('../../lib/engineLaunch.js', async (real) => ({
  ...await real<object>(),
  buildEngineCommandArgv: vi.fn(() => ['claude']),
  buildEngineLaunchArgv: vi.fn(() => ['zsh', '-lc', 'claude']),
  namedAgentArgs: vi.fn((_engine: string, agent: string) => ['--agent', agent]),
  permissionModeApproves: vi.fn(() => true),
  permissionModeFlags: vi.fn(() => ['--permission-mode']),
  refusePermissionFlagIfUnsupported: vi.fn(async () => null),
  supportsFirstPrompt: vi.fn(() => true),
}))
vi.mock('../../lib/setUpWithin.js', async (real) => ({ ...await real<object>(), setUpWithin: vi.fn(async (run: () => Promise<unknown>) => { await run(); return 'done' }) }))
vi.mock('../../lib/gridConfigDir.js', () => ({ writeGridConfigDir: vi.fn(async () => '/config/harness-claude') }))
vi.mock('../../lib/gridLaunchWire.js', async (real) => ({
  ...await real<object>(),
  describeGridLaunch: vi.fn(() => '[grid] claude on Home'),
  gridConflictingEnvToClear: vi.fn(() => ['ANTHROPIC_API_KEY']),
}))
// The models service's grid launch (`CreateAgentDeps.buildGridLaunch`), as it answers a launch it can build.
const buildGridLaunch = vi.fn(async (request: GridLaunchRequest): Promise<GridLaunchAnswer> => ({
  ok: true, launch: { env: { GRID_KEY: 'k' }, args: ['--grid'], webSearch: 'unsupported' }, override: request.override,
}))
vi.mock('../../engines/hooks.js', async (real) => {
  const actual = await real<typeof import('../../engines/hooks.js')>()
  return { ...actual, engineHooks: { ...actual.engineHooks, codex: { ...actual.engineHooks.codex, installIn: vi.fn() } } }
})
vi.mock('../../lib/sessionSearch/external.js', async (real) => ({ ...await real<object>(), stopSessionOwner: vi.fn(async () => true) }))
vi.mock('../../lib/tmux.js', async (real) => ({ ...await real<object>(), clearPaneRemainOnExit: vi.fn(async () => {}) }))
vi.mock('../../lib/tmuxVersion.js', async (real) => ({ ...await real<object>(), tmuxSupportsSessionEnv: vi.fn(async () => true) }))

const launchDsh = vi.fn<CreateAgentDeps['dshLaunch']['launch']>(async () => ({ ok: true, launch: { env: { HARNESS_DSH: 'blender' }, args: ['--dsh'] } }))

const root = mkdtempSync(join(tmpdir(), 'core-create-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
let folders = 0
const folder = (files: string[] = []) => {
  const dir = join(root, `f${folders++}`)
  mkdirSync(dir)
  for (const file of files) writeFileSync(join(dir, file), '')
  return dir
}

const request = (over: Record<string, unknown> = {}) => ({
  engine: 'claude', cwd: folder(), bypassPermission: false, permissionMode: null, grid: null, codexHome: null, dsh: null,
  prompt: null, name: null, agent: null, resumeSessionId: null, takeOver: null, ...over,
}) as unknown as Parameters<ReturnType<typeof createAgentCreator>>[0]

const pending = { agentId: 'a1', sessionId: '', engine: 'claude' } as RegisteredSession
const owner = { pid: 7, engine: 'claude' } as SessionOwner

function setup(over: Partial<CreateAgentDeps> = {}) {
  const deps: CreateAgentDeps = {
    tmuxBackend: {} as CreateAgentDeps['tmuxBackend'],
    registry: { setLaunch: vi.fn(() => ({ ...pending, launch: { state: 'ready' } })) } as unknown as CreateAgentDeps['registry'],
    externalResume: vi.fn<CreateAgentDeps['externalResume']>(async () => ({ ok: true, session: pending })),
    watchNewPane: vi.fn(async () => {}),
    announceSession: vi.fn(),
    attachDsh: vi.fn(),
    prepareApiTools: vi.fn(),
    hookPort: 4242,
    hooksDisabled: false,
    installOpencodePlugin: vi.fn(async () => true),
    gridLaunchMachine: vi.fn(() => ({}) as never),
    buildGridLaunch,
    terminalHintMachineName: () => 'this-mac',
    blocksFolder: vi.fn(() => false),
    gridSetup: vi.fn(() => vi.fn(async () => ({}))) as never,
    privateGridName: vi.fn(async () => 'grid-me'),
    dshLaunch: { launch: launchDsh, materialize: async () => ({ ok: true, ...await materializeWorkspace() }) },
    ...over,
  }
  return { deps, create: createAgentCreator(deps) }
}

const installed = (over: Record<string, unknown> = {}) => ({ id: 'autonomous/blender', manifest: { name: 'Blender', kind: 'agent' }, ...over })

describe('creating an agent', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(createAndRegisterPane).mockReset().mockResolvedValue({ ok: true, spawned: { runtime: { paneId: '%1' } }, pending } as never)
  })
  afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks() })

  it('hands external resume to its durable controller before folder, instructions or engine preparation', async () => {
    const externalResume = vi.fn<CreateAgentDeps['externalResume']>(async () => ({ ok: true, session: pending }))
    const test = setup({ externalResume })
    const input = request({ resumeSessionId: 'conversation' })
    expect(await test.create(input)).toEqual({ ok: true, session: pending })
    expect(externalResume).toHaveBeenCalledWith(input)
    expect(createAndRegisterPane).not.toHaveBeenCalled()
    expect(test.deps.prepareApiTools).not.toHaveBeenCalled()
  })

  describe('refusals before any pane opens', () => {
    it('without tmux, in a folder being purged, or in a folder that is not one', async () => {
      expect(await setup({ tmuxBackend: null }).create(request())).toEqual({ ok: false, error: 'TMUX_UNAVAILABLE' })
      expect(await setup({ blocksFolder: () => true }).create(request())).toEqual({ ok: false, error: 'WORKTREE_BUSY' })
      const { create } = setup()
      const file = join(folder(['x']), 'x')
      expect(await create(request({ cwd: file }))).toEqual({ ok: false, error: 'CWD_NOT_FOUND' })
      expect(await create(request({ cwd: join(root, 'missing') }))).toEqual({ ok: false, error: 'CWD_NOT_FOUND' })
      expect(createAndRegisterPane).not.toHaveBeenCalled()
    })

    it('for a permission flag the engine does not take', async () => {
      vi.mocked(refusePermissionFlagIfUnsupported).mockResolvedValueOnce({ error: 'PERMISSION_MODE_UNSUPPORTED', detail: 'opencode has no --auto' } as never)
      expect(await setup().create(request({ engine: 'opencode', permissionMode: 'auto' }))).toEqual({ ok: false, error: 'PERMISSION_MODE_UNSUPPORTED', detail: 'opencode has no --auto' })
    })

    it('for a DSH that is missing, a viewer, the wrong engine, or on a tmux too old to pass it on', async () => {
      const { create } = setup()
      expect(await create(request({ dsh: 'blender' }))).toMatchObject({ error: 'INVALID_DSH', detail: 'blender is not installed on this machine' })
      vi.mocked(installedDsh).mockReturnValue(installed({ manifest: { name: 'Viewer', kind: 'viewer' } }) as never)
      expect(await create(request({ dsh: 'viewer' }))).toMatchObject({ error: 'INVALID_DSH', detail: 'viewer is a viewer package, not an agent' })
      vi.mocked(installedDsh).mockReturnValue(installed() as never)
      vi.mocked(incompatibleHarnessEngine).mockReturnValueOnce('Blender runs on codex')
      expect(await create(request({ dsh: 'blender' }))).toMatchObject({ error: 'INVALID_DSH', detail: 'Blender runs on codex' })
      vi.mocked(tmuxSupportsSessionEnv).mockResolvedValueOnce(false)
      expect(await create(request({ dsh: 'blender' }))).toMatchObject({ error: 'TMUX_TOO_OLD_FOR_DSH' })
      vi.mocked(installedDsh).mockReset().mockReturnValue(undefined)
    })

    it('for a DSH whose workspace cannot be prepared, or whose launch refuses', async () => {
      vi.mocked(installedDsh).mockReturnValue(installed() as never)
      const { create } = setup()
      vi.mocked(materializeWorkspace).mockRejectedValueOnce(new Error('disk full')).mockRejectedValueOnce('worse')
      expect(await create(request({ dsh: 'blender' }))).toMatchObject({ error: 'DSH_MATERIALIZE_FAILED', detail: 'could not prepare the workspace for blender · disk full' })
      expect(await create(request({ dsh: 'blender' }))).toMatchObject({ detail: 'could not prepare the workspace for blender · worse' })
      launchDsh.mockResolvedValueOnce({ ok: false, error: 'DSH_RUNTIME', detail: 'no runtime' } as never)
      expect(await create(request({ dsh: 'blender' }))).toEqual({ ok: false, error: 'DSH_RUNTIME', detail: 'no runtime' })
      vi.mocked(installedDsh).mockReset().mockReturnValue(undefined)
    })

    it('for a harness on a grid models cannot build: asked first, so the folder is left as it was', async () => {
      vi.mocked(installedDsh).mockReturnValue(installed() as never)
      const grid = { networkId: 'g1', networkName: 'Home', baseUrl: 'http://g', model: 'm' }
      const { create } = setup()
      buildGridLaunch.mockResolvedValueOnce({ ok: false, error: 'GRID_UNAVAILABLE', detail: 'models is down', unavailable: 'models' })
      expect(await create(request({ dsh: 'blender', grid }))).toEqual({ ok: false, error: 'GRID_UNAVAILABLE', detail: 'models is down' })
      expect(materializeWorkspace).not.toHaveBeenCalled()
      expect(preTrustClaudeProject).not.toHaveBeenCalled()
      expect(prepareInstructionWrites).not.toHaveBeenCalled()
      vi.mocked(installedDsh).mockReset().mockReturnValue(undefined)
    })

    it('for a grid it cannot honour: refused by the launch, a tmux too old, or a config it cannot write', async () => {
      const grid = { networkId: 'g1', networkName: 'Home', baseUrl: 'http://g', model: null }
      const { create } = setup()
      buildGridLaunch.mockResolvedValueOnce({ ok: false, error: 'GRID_ENGINE_UNSUPPORTED', detail: 'no grid for amp' })
      expect(await create(request({ grid }))).toEqual({ ok: false, error: 'GRID_ENGINE_UNSUPPORTED', detail: 'no grid for amp' })
      vi.mocked(tmuxSupportsSessionEnv).mockResolvedValueOnce(false)
      expect(await create(request({ grid }))).toMatchObject({ error: 'TMUX_TOO_OLD_FOR_GRID' })
      const configured = { ok: true, launch: { env: {}, args: [], webSearch: 'off', configDir: { envVar: 'PI_CONFIG', files: {}, links: [] } } }
      buildGridLaunch.mockResolvedValueOnce(configured as never).mockResolvedValueOnce(configured as never)
      vi.mocked(writeGridConfigDir).mockRejectedValueOnce(new Error('read-only')).mockRejectedValueOnce('worse')
      expect(await create(request({ grid }))).toMatchObject({ error: 'GRID_CONFIG_FAILED', detail: "could not write claude's grid configuration · read-only" })
      expect(await create(request({ grid }))).toMatchObject({ detail: "could not write claude's grid configuration · worse" })
    })



    it('when the pane itself cannot be made', async () => {
      vi.mocked(createAndRegisterPane).mockResolvedValueOnce({ ok: false, error: 'SPAWN_FAILED', detail: 'tmux said no' } as never)
      expect(await setup().create(request())).toEqual({ ok: false, error: 'SPAWN_FAILED', detail: 'tmux said no' })
    })
  })

  describe('a pane that opens', () => {
    it('opens a plain session, announces it and watches it until its engine is up', async () => {
      const { deps, create } = setup()
      const result = await create(request())
      expect(result).toEqual({ ok: true, session: pending })
      expect(deps.prepareApiTools).toHaveBeenCalled()
      expect(deps.announceSession).toHaveBeenCalledWith(pending)
      expect(deps.attachDsh).not.toHaveBeenCalled()
      expect(deps.watchNewPane).toHaveBeenCalledWith('claude', pending, { runtime: { paneId: '%1' } }, ['claude'], { install: 'recipe' }, undefined)
      const pane = vi.mocked(createAndRegisterPane).mock.calls[0][0]
      expect(pane).toMatchObject({ engine: 'claude', sessionLabel: expect.any(String), grid: null, gridLaunchRecord: null, dsh: null, dshRuntime: null, defaultName: null })
    })

    it('starts an approving session in the default harness permission when no mode was named', async () => {
      expect(await setup().create(request({ bypassPermission: true }))).toMatchObject({ ok: true })
      expect(vi.mocked(createAndRegisterPane).mock.calls[0][0]).toMatchObject({ bypassPermission: true, permissionMode: null })
    })

    it('opens a terminal ready at once, with nothing to watch', async () => {
      vi.mocked(createAndRegisterPane).mockResolvedValueOnce({ ok: true, spawned: { runtime: { paneId: '%2' } }, pending: { ...pending, engine: 'terminal' } } as never)
      const { deps, create } = setup()
      expect(await create(request({ engine: 'terminal' }))).toMatchObject({ ok: true, session: { launch: { state: 'ready' } } })
      expect(clearPaneRemainOnExit).toHaveBeenCalledWith('%2')
      expect(deps.watchNewPane).not.toHaveBeenCalled()
      vi.mocked(createAndRegisterPane).mockResolvedValueOnce({ ok: true, spawned: { runtime: { paneId: '%3' } }, pending: { ...pending, engine: 'terminal' } } as never)
      vi.mocked(deps.registry.setLaunch).mockReturnValueOnce(null)
      expect(await create(request({ engine: 'terminal' }))).toMatchObject({ ok: true, session: { engine: 'terminal' } })
    })

    it('does not trust, configure or launch a workspace when the Store cannot prepare it', async () => {
      vi.mocked(installedDsh).mockReturnValue(installed() as never)
      const refused = { ok: false as const, error: 'DSH_UNAVAILABLE', detail: 'Store unavailable', unavailable: 'store' as const }
      const materialize = vi.fn(async () => refused)
      const { create } = setup({ dshLaunch: { materialize, launch: launchDsh } })
      expect(await create(request({ dsh: 'blender' }))).toEqual({ ok: false, error: refused.error, detail: refused.detail })
      expect(launchDsh).not.toHaveBeenCalled()
      expect(createAndRegisterPane).not.toHaveBeenCalled()
      expect(preTrustClaudeProject).not.toHaveBeenCalled()
      materialize.mockResolvedValueOnce({ ok: false, error: 'DSH_MATERIALIZE_FAILED', detail: 'disk full' } as never)
      expect(await create(request({ dsh: 'blender' }))).toMatchObject({ error: 'DSH_MATERIALIZE_FAILED', detail: 'could not prepare the workspace for blender · disk full' })
      vi.mocked(installedDsh).mockReset().mockReturnValue(undefined)
    })

    it('as a DSH: its workspace prepared, trusted when it went into an empty folder, and its launch layered on', async () => {
      vi.mocked(installedDsh).mockReturnValue(installed() as never)
      vi.mocked(materializeWorkspace).mockResolvedValue({ warnings: ['kept AGENTS.md'], created: ['template/scene.blend'], kept: [] } as never)
      vi.mocked(createAndRegisterPane).mockResolvedValue({ ok: true, spawned: { runtime: { paneId: '%1' } }, pending: { ...pending, dsh: 'blender' } } as never)
      const { deps, create } = setup()
      await create(request({ dsh: 'blender' }))
      expect(preTrustClaudeProject).toHaveBeenCalled()
      expect(deps.attachDsh).toHaveBeenCalled()
      const pane = vi.mocked(createAndRegisterPane).mock.calls[0][0]
      expect(pane).toMatchObject({ dsh: 'blender', dshRuntime: expect.any(String), label: 'Blender', env: expect.objectContaining({ HARNESS_DSH: 'blender' }) })
      await create(request({ dsh: 'blender', engine: 'codex' }))
      expect(preTrustCodexProject).toHaveBeenLastCalledWith(expect.any(String), null)
      // A Codex agent on its own profile is trusted in that profile's config.toml, which it reads.
      await create(request({ dsh: 'blender', engine: 'codex', codexHome: '/profiles/work' }))
      expect(preTrustCodexProject).toHaveBeenLastCalledWith(expect.any(String), '/profiles/work')
      // A folder that already held something, or could not be read: trust stays the person's call.
      await create(request({ dsh: 'blender', cwd: folder(['README.md']) }))
      await create(request({ dsh: 'blender', engine: 'pi' }))
      expect(preTrustClaudeProject).toHaveBeenCalledTimes(1)
      vi.mocked(preTrustClaudeProject).mockImplementationOnce(() => { throw new Error('settings locked') }).mockImplementationOnce(() => { throw 'worse' })
      expect(await create(request({ dsh: 'blender' }))).toMatchObject({ ok: true })
      expect(await create(request({ dsh: 'blender' }))).toMatchObject({ ok: true })
      vi.mocked(materializeWorkspace).mockResolvedValueOnce({ warnings: [], created: ['AGENTS.md'], kept: [] } as never)
      await create(request({ dsh: 'blender' }))
      expect(preTrustClaudeProject).toHaveBeenCalledTimes(3)
      // A folder it cannot read is not an empty one.
      const unreadable = folder()
      chmodSync(unreadable, 0o000)
      try {
        await create(request({ dsh: 'blender', cwd: unreadable }))
      } finally { chmodSync(unreadable, 0o755) }
      expect(preTrustClaudeProject).toHaveBeenCalledTimes(3)
      vi.mocked(installedDsh).mockReset().mockReturnValue(undefined)
      vi.mocked(materializeWorkspace).mockReset().mockResolvedValue({ warnings: [], created: [], kept: [] } as never)
    })

    it('as the Model Manager: grid is set up first, waiting a while for it', async () => {
      const log = vi.mocked(console.log)
      vi.mocked(installedDsh).mockReturnValue(installed({ id: 'autonomous/autonomous-grid' }) as never)
      const ensure = vi.fn(async () => ({}))
      const { create } = setup({ gridSetup: () => ensure as never })
      await create(request({ dsh: 'autonomous-grid' }))
      expect(setUpWithin).toHaveBeenCalled()
      expect(ensure).toHaveBeenCalledWith({ ownGrid: true })
      vi.mocked(setUpWithin).mockResolvedValueOnce('pending' as never)
      await create(request({ dsh: 'autonomous-grid' }))
      expect(log.mock.calls.map(([line]) => String(line)).some((line) => line.includes('grid is still being set up'))).toBe(true)
      // No grid set-up on this daemon: the harness starts anyway.
      expect(await setup({ gridSetup: () => undefined as never }).create(request({ dsh: 'autonomous-grid' }))).toMatchObject({ ok: true })
      vi.mocked(installedDsh).mockReset().mockReturnValue(undefined)
    })

    it('pins a DSH\'s permission mode when the engine takes it, and tells the harness about the account it can', async () => {
      vi.mocked(installedDsh).mockReturnValue(installed() as never)
      vi.mocked(dshPinnedPermissionMode).mockReturnValue('auto' as never)
      const { create } = setup({ privateGridName: vi.fn(async () => { throw new Error('signed out') }) })
      await create(request({ dsh: 'blender' }))
      expect(vi.mocked(createAndRegisterPane).mock.calls[0][0]).toMatchObject({ permissionMode: 'auto', bypassPermission: true })
      vi.mocked(permissionModeFlags).mockReturnValueOnce(null as never)
      await create(request({ dsh: 'blender' }))
      expect(vi.mocked(createAndRegisterPane).mock.calls[1][0]).toMatchObject({ permissionMode: null, bypassPermission: false })
      vi.mocked(dshPinnedPermissionMode).mockReset().mockReturnValue(null)
      vi.mocked(installedDsh).mockReset().mockReturnValue(undefined)
    })

    it('on a grid: its environment, its argv and its config folder, and the vendor keys it must not see cleared', async () => {
      const grid = { networkId: 'g1', networkName: 'Home', baseUrl: 'http://g', model: 'm1' }
      const { create } = setup()
      await create(request({ grid }))
      expect(vi.mocked(createAndRegisterPane).mock.calls[0][0]).toMatchObject({
        grid: { baseUrl: 'http://g', model: 'm1' }, gridLaunchRecord: { override: grid, webSearch: 'unsupported' }, env: expect.objectContaining({ GRID_KEY: 'k' }),
      })
      const withFile = (pointAt?: string) => ({ ok: true, launch: { env: {}, args: [], webSearch: 'off', configDir: { envVar: 'OPENCODE_CONFIG', files: {}, links: [], pointAt } } })
      buildGridLaunch.mockResolvedValueOnce(withFile('opencode.json') as never).mockResolvedValueOnce(withFile() as never)
      await create(request({ grid: { ...grid, model: undefined } }))
      await create(request({ grid }))
      expect(vi.mocked(createAndRegisterPane).mock.calls[1][0]).toMatchObject({ grid: { model: null }, env: { OPENCODE_CONFIG: '/config/harness-claude/opencode.json' } })
      expect(vi.mocked(createAndRegisterPane).mock.calls[2][0]).toMatchObject({ env: { OPENCODE_CONFIG: '/config/harness-claude' } })
      expect(vi.mocked(buildEngineLaunchArgv).mock.calls[0][1]).toMatchObject({ clearEnv: ['ANTHROPIC_API_KEY', 'HARNESS_OLD'], extraArgs: ['--grid'] })
    })

    it('installs the hooks a Codex profile and a new OpenCode need, unless hooks are off', async () => {
      const on = setup()
      await on.create(request({ engine: 'codex', codexHome: '/codex-work' }))
      await on.create(request({ engine: 'opencode' }))
      expect(engineHooks.codex.installIn).toHaveBeenCalledWith(4242, '/codex-work')
      expect(on.deps.installOpencodePlugin).toHaveBeenCalledWith(4242)
      expect(vi.mocked(createAndRegisterPane).mock.calls[0][0]).toMatchObject({ env: { CODEX_HOME: '/codex-work' }, codexHome: '/codex-work' })
      const off = setup({ hooksDisabled: true })
      await off.create(request({ engine: 'codex', codexHome: '/codex-work' }))
      await off.create(request({ engine: 'opencode' }))
      expect(engineHooks.codex.installIn).toHaveBeenCalledTimes(1)
      expect(off.deps.installOpencodePlugin).not.toHaveBeenCalled()
    })

    it('refuses an OpenCode create whose plugin installer could not be loaded, before any pane opens', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const t = setup({ installOpencodePlugin: vi.fn(async () => false) })
      expect(await t.create(request({ engine: 'opencode' }))).toEqual({ ok: false, error: 'ENGINE_UNAVAILABLE', detail: 'OpenCode\'s plugin installer could not be loaded' })
      expect(warn).toHaveBeenCalledWith('[agent] create opencode refused · OpenCode\'s plugin installer could not be loaded')
      expect(createAndRegisterPane).not.toHaveBeenCalled()
      warn.mockRestore()
    })

    it('creates OpenCode from eager facts when optional code cannot load', async () => {
      vi.mocked(loadEngine).mockImplementation(() => new Promise(() => {}))
      const t = setup()
      await t.create(request({ engine: 'opencode', agent: 'reviewer' }))
      expect(namedAgentArgs).toHaveBeenLastCalledWith('opencode', 'reviewer', 2)
      expect(createAndRegisterPane).toHaveBeenCalledOnce()
      expect(t.deps.installOpencodePlugin).toHaveBeenCalledWith(4242)
      expect(loadEngine).not.toHaveBeenCalled()
      buildGridLaunch.mockResolvedValueOnce({ ok: false, error: 'GRID_UNSUPPORTED', detail: 'no' })
      await t.create(request({ engine: 'claude', agent: 'reviewer', grid: { networkName: 'g' } }))
      expect(t.deps.gridLaunchMachine).toHaveBeenCalledWith('claude')
    })

    it('opens as a named agent, with a first prompt, and does not install an engine with a path override', async () => {
      vi.mocked(enginePathOverride).mockReturnValueOnce('/opt/claude' as never)
      const { deps, create } = setup()
      await create(request({ agent: 'reviewer', prompt: 'review the diff', name: 'Reviewer' }))
      const options = vi.mocked(buildEngineLaunchArgv).mock.calls[0][1] as Record<string, unknown>
      expect(options).toMatchObject({ extraArgs: ['--agent', 'reviewer'], firstPrompt: 'review the diff', installIfMissing: undefined, cwd: expect.any(String) })
      expect(options.terminalHint).toEqual({ machineName: 'this-mac' })
      expect(vi.mocked(createAndRegisterPane).mock.calls[0][0]).toMatchObject({ agent: 'reviewer', defaultName: 'Reviewer' })
      expect(deps.watchNewPane).toHaveBeenCalledWith('claude', pending, expect.anything(), ['claude'], undefined, undefined)
    })




  })
})
