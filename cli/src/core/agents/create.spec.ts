import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installedDsh } from '../../dsh/installed.js'
import { dshPinnedPermissionMode } from '../../dsh/manifest.js'
import { materializeWorkspace } from '../../dsh/materialize.js'
import { harnessLaunchOrRefusal, incompatibleHarnessEngine } from '../../dsh/runtime.js'
import { preTrustClaudeProject, preTrustCodexProject } from '../../lib/claudeTrust.js'
import { createAndRegisterPane } from '../../lib/createAgentPane.js'
import { enginePathOverride } from '../../lib/engineBin.js'
import { buildEngineLaunchArgv, permissionModeFlags, refusePermissionFlagIfUnsupported, supportsFirstPrompt } from '../../lib/engineLaunch.js'
import { setUpWithin } from '../../lib/setUpWithin.js'
import { writeGridConfigDir } from '../../lib/gridConfigDir.js'
import { buildGridEngineLaunch } from '../../lib/gridLaunch.js'
import { engineHooks } from '../../engines/hooks.js'
import { installOpencodePlugin } from '../../lib/hooks.js'
import type { RegisteredSession } from '../../lib/registry.js'
import { stopSessionOwner, type SessionOwner } from '../../lib/sessionSearch/external.js'
import { clearPaneRemainOnExit } from '../../lib/tmux.js'
import { tmuxSupportsSessionEnv } from '../../lib/tmuxVersion.js'
import { createAgentCreator, type CreateAgentDeps } from './create.js'

vi.mock('../../dsh/installed.js', () => ({ installedDsh: vi.fn(() => undefined) }))
vi.mock('../../dsh/manifest.js', async (real) => ({ ...await real<object>(), dshPinnedPermissionMode: vi.fn(() => null) }))
vi.mock('../../dsh/materialize.js', () => ({ materializeWorkspace: vi.fn(async () => ({ warnings: [], created: [], kept: [] })) }))
vi.mock('../../dsh/runtime.js', async (real) => ({
  ...await real<object>(),
  harnessLaunchOrRefusal: vi.fn((prepare: () => unknown) => { prepare(); return { ok: true, launch: { env: { HARNESS_DSH: 'blender' }, args: ['--dsh'] } } }),
  incompatibleHarnessEngine: vi.fn(() => null),
  prepareHarnessLaunch: vi.fn(),
}))
vi.mock('../../dsh/launch.js', async (real) => ({ ...await real<object>(), harnessEnvToClear: vi.fn(() => ['HARNESS_OLD']) }))
vi.mock('../../engines/opencode/version.js', () => ({ opencodeMajorVersion: vi.fn(() => 2) }))
vi.mock('../../lib/claudeTrust.js', () => ({ preTrustClaudeProject: vi.fn(), preTrustCodexProject: vi.fn() }))
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
vi.mock('../../lib/gridLaunch.js', async (real) => ({
  ...await real<object>(),
  buildGridEngineLaunch: vi.fn(() => ({ ok: true, launch: { env: { GRID_KEY: 'k' }, args: ['--grid'], webSearch: 'off' } })),
  describeGridLaunch: vi.fn(() => '[grid] claude on Home'),
  gridConflictingEnvToClear: vi.fn(() => ['ANTHROPIC_API_KEY']),
}))
vi.mock('../../engines/hooks.js', async (real) => {
  const actual = await real<typeof import('../../engines/hooks.js')>()
  return { ...actual, engineHooks: { ...actual.engineHooks, codex: { ...actual.engineHooks.codex, installIn: vi.fn() } } }
})
vi.mock('../../lib/hooks.js', async (real) => ({ ...await real<object>(), installOpencodePlugin: vi.fn() }))
vi.mock('../../lib/sessionSearch/external.js', async (real) => ({ ...await real<object>(), stopSessionOwner: vi.fn(async () => true) }))
vi.mock('../../lib/tmux.js', async (real) => ({ ...await real<object>(), clearPaneRemainOnExit: vi.fn(async () => {}) }))
vi.mock('../../lib/tmuxVersion.js', async (real) => ({ ...await real<object>(), tmuxSupportsSessionEnv: vi.fn(async () => true) }))

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
    adoptableSession: vi.fn(async () => ({ ok: true, cwd: folder(), title: 'Adopted', owner: null, busy: false, launchArgs: [] })) as never,
    heldBy: vi.fn(async () => 'same' as const),
    takeOverWhenIdle: vi.fn(async () => {}),
    watchNewPane: vi.fn(async () => {}),
    announceSession: vi.fn(),
    attachDsh: vi.fn(),
    prepareApiTools: vi.fn(),
    hookPort: 4242,
    hooksDisabled: false,
    gridLaunchMachine: vi.fn(() => ({}) as never),
    terminalHintMachineName: () => 'this-mac',
    blocksFolder: vi.fn(() => false),
    gridSetup: vi.fn(() => vi.fn(async () => ({}))) as never,
    privateGridName: vi.fn(async () => 'grid-me'),
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
      vi.mocked(harnessLaunchOrRefusal).mockReturnValueOnce({ ok: false, error: 'DSH_RUNTIME', detail: 'no runtime' } as never)
      expect(await create(request({ dsh: 'blender' }))).toEqual({ ok: false, error: 'DSH_RUNTIME', detail: 'no runtime' })
      vi.mocked(installedDsh).mockReset().mockReturnValue(undefined)
    })

    it('for a grid it cannot honour: refused by the launch, a tmux too old, or a config it cannot write', async () => {
      const grid = { networkId: 'g1', networkName: 'Home', baseUrl: 'http://g', model: null }
      const { create } = setup()
      vi.mocked(buildGridEngineLaunch).mockReturnValueOnce({ ok: false, error: 'GRID_ENGINE_UNSUPPORTED', detail: 'no grid for amp' } as never)
      expect(await create(request({ grid }))).toEqual({ ok: false, error: 'GRID_ENGINE_UNSUPPORTED', detail: 'no grid for amp' })
      vi.mocked(tmuxSupportsSessionEnv).mockResolvedValueOnce(false)
      expect(await create(request({ grid }))).toMatchObject({ error: 'TMUX_TOO_OLD_FOR_GRID' })
      const configured = { ok: true, launch: { env: {}, args: [], webSearch: 'off', configDir: { envVar: 'PI_CONFIG', files: {}, links: [] } } }
      vi.mocked(buildGridEngineLaunch).mockReturnValueOnce(configured as never).mockReturnValueOnce(configured as never)
      vi.mocked(writeGridConfigDir).mockRejectedValueOnce(new Error('read-only')).mockRejectedValueOnce('worse')
      expect(await create(request({ grid }))).toMatchObject({ error: 'GRID_CONFIG_FAILED', detail: "could not write claude's grid configuration · read-only" })
      expect(await create(request({ grid }))).toMatchObject({ detail: "could not write claude's grid configuration · worse" })
    })

    it('when opening a conversation that cannot be opened, or that moved or would not quit in its terminal', async () => {
      const refused = setup({ adoptableSession: vi.fn(async () => ({ ok: false, error: 'SESSION_NOT_FOUND', detail: 'gone' })) as never })
      expect(await refused.create(request({ resumeSessionId: 'c1' }))).toEqual({ ok: false, error: 'SESSION_NOT_FOUND', detail: 'gone' })
      const adopted = vi.fn(async () => ({ ok: true, cwd: folder(), title: '', owner, busy: false, launchArgs: [] }))
      const moved = setup({ adoptableSession: adopted as never, heldBy: vi.fn(async () => 'other' as const) })
      expect(await moved.create(request({ resumeSessionId: 'c1', takeOver: 'now' }))).toMatchObject({ error: 'SESSION_OPEN_ELSEWHERE' })
      vi.mocked(stopSessionOwner).mockResolvedValueOnce(false)
      expect(await setup({ adoptableSession: adopted as never }).create(request({ resumeSessionId: 'c1', takeOver: 'now' }))).toMatchObject({ error: 'SESSION_STOP_FAILED' })
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
      expect(deps.takeOverWhenIdle).not.toHaveBeenCalled()
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
        grid: { baseUrl: 'http://g', model: 'm1' }, gridLaunchRecord: { override: grid, webSearch: 'off' }, env: expect.objectContaining({ GRID_KEY: 'k' }),
      })
      const withFile = (pointAt?: string) => ({ ok: true, launch: { env: {}, args: [], webSearch: 'off', configDir: { envVar: 'OPENCODE_CONFIG', files: {}, links: [], pointAt } } })
      vi.mocked(buildGridEngineLaunch).mockReturnValueOnce(withFile('opencode.json') as never).mockReturnValueOnce(withFile() as never)
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
      expect(installOpencodePlugin).toHaveBeenCalledWith(4242)
      expect(vi.mocked(createAndRegisterPane).mock.calls[0][0]).toMatchObject({ env: { CODEX_HOME: '/codex-work' }, codexHome: '/codex-work' })
      const off = setup({ hooksDisabled: true })
      await off.create(request({ engine: 'codex', codexHome: '/codex-work' }))
      await off.create(request({ engine: 'opencode' }))
      expect(engineHooks.codex.installIn).toHaveBeenCalledTimes(1)
      expect(installOpencodePlugin).toHaveBeenCalledTimes(1)
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

    it('opens a conversation Harness did not start, in its folder and under its title, resuming it', async () => {
      const cwd = folder()
      const adopted = vi.fn(async () => ({ ok: true, cwd, title: 'Fix the build', owner: null, busy: false, launchArgs: ['--model', 'opus'] }))
      const { create } = setup({ adoptableSession: adopted as never })
      await create(request({ resumeSessionId: 'c1' }))
      expect(vi.mocked(createAndRegisterPane).mock.calls[0][0]).toMatchObject({ cwd, defaultName: 'Fix the build' })
      expect(vi.mocked(buildEngineLaunchArgv).mock.calls[0][1]).toMatchObject({ resumeSessionId: 'c1', extraArgs: ['--model', 'opus'] })
      const untitled = vi.fn(async () => ({ ok: true, cwd, title: '', owner: null, busy: false, launchArgs: [] }))
      await setup({ adoptableSession: untitled as never }).create(request({ resumeSessionId: 'c1' }))
      expect(vi.mocked(createAndRegisterPane).mock.calls[1][0]).toMatchObject({ defaultName: null })
      await setup({ adoptableSession: untitled as never }).create(request({ resumeSessionId: 'c1', name: 'Mine' }))
      expect(vi.mocked(createAndRegisterPane).mock.calls[2][0]).toMatchObject({ defaultName: 'Mine' })
    })

    it('takes a conversation over from a terminal: stopped now (mid-turn: told to continue), or once its turn ends', async () => {
      const log = vi.mocked(console.log)
      const busyOwner = vi.fn(async () => ({ ok: true, cwd: folder(), title: '', owner, busy: true, launchArgs: [] }))
      const now = setup({ adoptableSession: busyOwner as never })
      await now.create(request({ resumeSessionId: 'c1', takeOver: 'now' }))
      expect(stopSessionOwner).toHaveBeenCalledWith(owner)
      expect(vi.mocked(buildEngineLaunchArgv).mock.calls[0][1]).toMatchObject({ firstPrompt: 'continue' })
      expect(log.mock.calls.map(([line]) => String(line)).some((line) => line.includes('pid 7 stopped mid-turn'))).toBe(true)
      // An engine that cannot open with a message just resumes where it stopped.
      vi.mocked(supportsFirstPrompt).mockReturnValueOnce(false)
      await now.create(request({ resumeSessionId: 'c1', takeOver: 'now' }))
      expect(vi.mocked(buildEngineLaunchArgv).mock.calls[1][1]).not.toHaveProperty('firstPrompt')
      const idleOwner = vi.fn(async () => ({ ok: true, cwd: folder(), title: '', owner, busy: false, launchArgs: [] }))
      await setup({ adoptableSession: idleOwner as never }).create(request({ resumeSessionId: 'c1', takeOver: 'now' }))
      expect(log.mock.calls.map(([line]) => String(line)).some((line) => line.endsWith('pid 7 stopped'))).toBe(true)
      // Quit in its terminal meanwhile: nothing to stop.
      const free = setup({ adoptableSession: idleOwner as never, heldBy: vi.fn(async () => 'free' as const) })
      vi.mocked(stopSessionOwner).mockClear()
      await free.create(request({ resumeSessionId: 'c1', takeOver: 'now' }))
      expect(stopSessionOwner).not.toHaveBeenCalled()
      // To wait for its turn: the pane waits on the process, and the watcher has a day.
      const wait = setup({ adoptableSession: busyOwner as never })
      await wait.create(request({ resumeSessionId: 'c1', takeOver: 'wait' }))
      expect(stopSessionOwner).not.toHaveBeenCalled()
      expect(vi.mocked(buildEngineLaunchArgv).mock.lastCall?.[1]).toMatchObject({ waitForPid: { pid: 7, name: 'Claude' } })
      expect(wait.deps.watchNewPane).toHaveBeenCalledWith('claude', pending, expect.anything(), ['claude'], { install: 'recipe' }, 24 * 60 * 60_000)
      expect(wait.deps.takeOverWhenIdle).toHaveBeenCalledWith('a1', owner, 'c1')
    })
  })
})
