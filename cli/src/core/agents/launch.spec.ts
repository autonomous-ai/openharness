import { afterEach, describe, expect, it, vi } from 'vitest'
import { prepareResume } from '../../engines/launchPrep.js'
import type { GridLaunchAnswer, GridLaunchOverride, GridLaunchRequest } from '../../lib/gridLaunchWire.js'
import { dropPermissionFlagIfUnsupported } from '../../lib/engineLaunch.js'
import { buildLaunchOverrides, type LaunchOverrides, type LaunchOverridesDeps } from '../../lib/launchOverrides.js'
import { loadEngine } from '../../engines/inProcess.js'
import { prepareInstructionWrites } from '../../scm/scmProjects.js'
import type { RegisteredSession } from '../../lib/registry.js'
import { createLaunchHelpers, gridLaunchThrough, type LaunchHelperDeps } from './launch.js'

vi.mock('../../engines/launchPrep.js', async (real) => ({ ...await real<object>(), prepareResume: vi.fn(() => ({ repairedItems: 0 })) }))
vi.mock('../../lib/engineLaunch.js', async (real) => ({ ...await real<object>(), dropPermissionFlagIfUnsupported: vi.fn() }))
// OpenCode's version is its own code, loaded for an OpenCode relaunch alone; a test may say it could not be.
vi.mock('../../engines/inProcess.js', async (real) => {
  const actual = await real<typeof import('../../engines/inProcess.js')>()
  return { ...actual, loadEngine: vi.fn(actual.loadEngine) }
})
vi.mock('../../scm/scmProjects.js', async (real) => {
  const actual = await real<typeof import('../../scm/scmProjects.js')>()
  return { ...actual, prepareInstructionWrites: vi.fn(async () => {}) }
})
vi.mock('../../lib/launchOverrides.js', async (real) => ({ ...await real<object>(), buildLaunchOverrides: vi.fn(async () => ({ ok: true })) }))

const session = (over: Partial<RegisteredSession> = {}): RegisteredSession =>
  ({ agentId: 'a1', sessionId: 's1', engine: 'claude', cwd: '/work', dsh: 'blender', dshRuntime: null, agent: 'reviewer', ...over }) as RegisteredSession

function setup() {
  const deps: LaunchHelperDeps = {
    prepareApiTools: vi.fn(),
    launchOverridesDeps: { marker: 'deps' } as unknown as LaunchOverridesDeps,
    setGridLaunch: vi.fn(() => true),
    setTail: vi.fn(),
  }
  return { deps, helpers: createLaunchHelpers(deps) }
}

describe('relaunch helpers', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks() })

  it('refuses an OpenCode relaunch whose code could not be loaded, having written nothing, and loads nothing for another engine', async () => {
    const { deps, helpers } = setup()
    vi.mocked(loadEngine).mockResolvedValueOnce(null)
    expect(await helpers.relaunchOverrides(session({ engine: 'opencode' }))).toEqual({ ok: false, error: 'ENGINE_UNAVAILABLE', detail: 'OpenCode\'s code could not be loaded' })
    // No instruction files prepared, no API notes, no overrides built.
    expect(prepareInstructionWrites).not.toHaveBeenCalled()
    expect(deps.prepareApiTools).not.toHaveBeenCalled()
    expect(buildLaunchOverrides).not.toHaveBeenCalled()
    vi.mocked(loadEngine).mockClear()
    expect(await helpers.relaunchOverrides(session())).toEqual({ ok: true })
    expect(loadEngine).not.toHaveBeenCalled()
    expect(prepareInstructionWrites).toHaveBeenCalledWith('/work')
    // With OpenCode's code, an OpenCode relaunch is built.
    expect(await helpers.relaunchOverrides(session({ engine: 'opencode' }))).toEqual({ ok: true })
    expect(loadEngine).toHaveBeenCalledWith('opencode')
  })

  it('rebuilds a launch from the row: its DSH, folder and named agent, whatever the source adds', async () => {
    const { deps, helpers } = setup()
    expect(await helpers.relaunchOverrides(session())).toEqual({ ok: true })
    expect(deps.prepareApiTools).toHaveBeenCalledWith('/work', 'claude')
    expect(buildLaunchOverrides).toHaveBeenLastCalledWith(deps.launchOverridesDeps, 'claude', expect.objectContaining({
      dsh: 'blender', dshRuntime: null, cwd: '/work', agent: 'reviewer', gridLaunch: null,
    }), 'a1')
    const grid = { networkId: 'grid-1', networkName: 'Home grid' }
    await helpers.relaunchOverrides(session({ dsh: undefined, dshRuntime: undefined, agent: undefined } as Partial<RegisteredSession>), { gridLaunch: grid } as never)
    expect(buildLaunchOverrides).toHaveBeenLastCalledWith(deps.launchOverridesDeps, 'claude', expect.objectContaining({ dsh: null, agent: null, gridLaunch: grid }), 'a1')
  })

  it('records the web-search decision a relaunch made, when it made one', () => {
    const { deps, helpers } = setup()
    helpers.refreshGridWebSearch('a1', {} as LaunchOverrides)
    expect(deps.setGridLaunch).not.toHaveBeenCalled()
    const record = { networkId: 'grid-1' }
    helpers.refreshGridWebSearch('a1', { gridLaunchRecord: record } as unknown as LaunchOverrides)
    expect(deps.setGridLaunch).toHaveBeenCalledWith('a1', record)
  })

  it('retains an imported Hermes profile for every relaunch, without applying it after an engine change', async () => {
    const { helpers } = setup()
    const externalResume = { request: { engine: 'hermes' }, session: { launchArgs: ['-p', 'work'] }, phase: 'admitted' } as unknown as RegisteredSession['externalResume']
    vi.mocked(buildLaunchOverrides).mockResolvedValueOnce({ ok: true, overrides: { extraArgs: ['--fixture'] } as LaunchOverrides })
    expect(await helpers.relaunchOverrides(session({ engine: 'hermes', externalResume }))).toMatchObject({ ok: true, overrides: { extraArgs: ['--fixture', '-p', 'work'] } })
    expect(await helpers.relaunchOverrides(session({ engine: 'claude', externalResume }))).toEqual({ ok: true })
    vi.mocked(buildLaunchOverrides).mockResolvedValueOnce({ ok: true, overrides: { extraArgs: [] } as unknown as LaunchOverrides })
    expect(await helpers.relaunchOverrides(session({ engine: 'hermes', externalResume: { ...externalResume!, session: undefined } }))).toMatchObject({ ok: true, overrides: { extraArgs: [] } })
    vi.mocked(buildLaunchOverrides).mockResolvedValueOnce({ ok: false, error: 'SERVICE_UNAVAILABLE', detail: 'unavailable' })
    expect(await helpers.relaunchOverrides(session({ engine: 'hermes', externalResume }))).toMatchObject({ ok: false })
  })

  it('drops a permission flag the engine no longer takes, says so, and keeps the pane', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { helpers } = setup()
    vi.mocked(dropPermissionFlagIfUnsupported).mockResolvedValueOnce({ choice: { bypassPermission: false }, droppedFlag: '--permission-mode' } as never)
    expect(await helpers.downgradedPermission(session({ permissionMode: 'plan' } as Partial<RegisteredSession>), true, 'restart')).toEqual({ bypassPermission: false })
    expect(dropPermissionFlagIfUnsupported).toHaveBeenCalledWith('claude', { permissionMode: 'plan', bypassPermission: true })
    expect(String(warn.mock.calls[0][0])).toContain('does not take --permission-mode · starting in Ask · update claude to get plan back')
    vi.mocked(dropPermissionFlagIfUnsupported).mockResolvedValueOnce({ choice: { bypassPermission: true }, droppedFlag: '--dangerously-skip-permissions' } as never)
    await helpers.downgradedPermission(session(), true, 'retarget')
    expect(String(warn.mock.calls[1][0])).toContain('to get Auto back')
    vi.mocked(dropPermissionFlagIfUnsupported).mockResolvedValueOnce({ choice: { permissionMode: 'plan' }, droppedFlag: null } as never)
    expect(await helpers.downgradedPermission(session(), false, 'restore')).toEqual({ permissionMode: 'plan' })
    expect(warn).toHaveBeenCalledTimes(2)
  })

  it('repairs a Codex rollout for resume and moves the tail to its new length', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { deps, helpers } = setup()
    // Only Codex declares a repair, and the log line names what it repaired in its words.
    const codex = session({ engine: 'codex' })
    helpers.prepareSessionResume(codex)
    expect(deps.setTail).not.toHaveBeenCalled()
    vi.mocked(prepareResume).mockReturnValueOnce({ repairedItems: 3, repairedBytes: 1_234, backupPath: '/b/rollout.bak' } as never)
    helpers.prepareSessionResume(codex)
    expect(deps.setTail).toHaveBeenCalledWith('s1', 1_234)
    vi.mocked(prepareResume).mockReturnValueOnce({ repairedItems: 1, backupPath: '/b/rollout.bak' } as never)
    helpers.prepareSessionResume(codex)
    expect(deps.setTail).toHaveBeenCalledTimes(1)
    expect(log.mock.calls.map(([line]) => String(line))).toEqual([
      '[resume] repaired 3 Codex reasoning items · backup: /b/rollout.bak',
      '[resume] repaired 1 Codex reasoning items · backup: /b/rollout.bak',
    ])
  })
})

describe('a grid launch, as the core asks the models service for it', () => {
  afterEach(() => { vi.clearAllMocks() })
  const grid: GridLaunchOverride = { networkId: 'grid-1', networkName: 'Home grid', baseUrl: 'https://grid.example/v1', apiKey: 'k', model: 'm' }
  const api: GridLaunchOverride = { networkId: 'api:openrouter', networkName: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'k', model: 'q' }
  const request = (override = grid): GridLaunchRequest => ({ engine: 'claude', override, machine: { hermesSystemManaged: false } })

  it("hands back models' answer as it is, including saved API details owned by models", async () => {
    const built: GridLaunchAnswer = { ok: true, launch: { env: {}, args: [], webSearch: 'on' }, override: grid }
    expect(await gridLaunchThrough(() => ({ gridLaunch: async () => built }))(request())).toBe(built)
    const refused: GridLaunchAnswer = { ok: false, error: 'API_UNAVAILABLE', detail: 'OpenRouter was removed.', apiBase: 'https://openrouter.ai/api/v1' }
    expect(await gridLaunchThrough(() => ({ gridLaunch: async () => refused }))(request(api))).toBe(refused)
  })

  it('refuses at once, naming the grid or the API, when models is down or answers nothing usable', async () => {
    const down = gridLaunchThrough(() => ({ gridLaunch: async () => { throw new Error('SERVICE_UNAVAILABLE') } }))
    // `unavailable` names the service, so a restore holds the agent for it rather than failing it.
    expect(await down(request())).toEqual({
      ok: false, error: 'GRID_UNAVAILABLE', unavailable: 'models',
      detail: 'The models service is not running, so claude cannot be put on Home grid. Try again in a moment.',
    })
    expect(await down(request(api))).toMatchObject({ ok: false, error: 'API_UNAVAILABLE', detail: expect.stringContaining('on OpenRouter') })
    // A port that is not there at all (models off) is the same refusal, not a throw out of the launch.
    expect(await gridLaunchThrough(() => { throw new Error('no port') })(request())).toMatchObject({ error: 'GRID_UNAVAILABLE' })
  })
})
