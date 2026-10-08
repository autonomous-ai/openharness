import { afterEach, describe, expect, it, vi } from 'vitest'
import { prepareResume } from '../../engines/launchPrep.js'
import { ApiConnectionError, type ApiConnections } from '../../lib/apiConnections.js'
import { refreshApiLaunch } from '../../lib/apiModels.js'
import { dropPermissionFlagIfUnsupported } from '../../lib/engineLaunch.js'
import { buildLaunchOverrides, type LaunchOverrides, type LaunchOverridesDeps } from '../../lib/launchOverrides.js'
import type { RegisteredSession } from '../../lib/registry.js'
import { createLaunchHelpers, type LaunchHelperDeps } from './launch.js'

vi.mock('../../engines/launchPrep.js', async (real) => ({ ...await real<object>(), prepareResume: vi.fn(() => ({ repairedItems: 0 })) }))
vi.mock('../../lib/apiModels.js', async (real) => ({ ...await real<object>(), refreshApiLaunch: vi.fn((_apis: unknown, launch: object) => ({ ...launch, refreshed: true })) }))
vi.mock('../../lib/engineLaunch.js', async (real) => ({ ...await real<object>(), dropPermissionFlagIfUnsupported: vi.fn() }))
vi.mock('../../lib/launchOverrides.js', async (real) => ({ ...await real<object>(), buildLaunchOverrides: vi.fn(async () => ({ ok: true })) }))

const session = (over: Partial<RegisteredSession> = {}): RegisteredSession =>
  ({ agentId: 'a1', sessionId: 's1', engine: 'claude', cwd: '/work', dsh: 'blender', dshRuntime: null, agent: 'reviewer', ...over }) as RegisteredSession

function setup() {
  const deps: LaunchHelperDeps = {
    prepareApiTools: vi.fn(),
    savedApis: {} as ApiConnections,
    launchOverridesDeps: { marker: 'deps' } as unknown as LaunchOverridesDeps,
    setGridLaunch: vi.fn(() => true),
    setTail: vi.fn(),
  }
  return { deps, helpers: createLaunchHelpers(deps) }
}

describe('relaunch helpers', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks() })

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
    expect(refreshApiLaunch).not.toHaveBeenCalled()
  })

  it('relaunches on a saved API with its key as saved now, and refuses one that is gone', async () => {
    const { deps, helpers } = setup()
    const api = { networkId: 'api:openrouter', networkName: 'OpenRouter' }
    await helpers.relaunchOverrides(session(), { gridLaunch: api } as never)
    expect(refreshApiLaunch).toHaveBeenCalledWith(deps.savedApis, api)
    expect(vi.mocked(buildLaunchOverrides).mock.lastCall?.[2]).toMatchObject({ gridLaunch: { ...api, refreshed: true } })
    vi.mocked(refreshApiLaunch).mockImplementationOnce(() => { throw new ApiConnectionError('OpenRouter was removed.') })
    expect(await helpers.relaunchOverrides(session(), { gridLaunch: api } as never)).toEqual({ ok: false, error: 'API_UNAVAILABLE', detail: 'OpenRouter was removed.' })
    vi.mocked(refreshApiLaunch).mockImplementationOnce(() => { throw new Error('unreadable store') })
    expect(await helpers.relaunchOverrides(session(), { gridLaunch: api } as never)).toEqual({
      ok: false, error: 'API_UNAVAILABLE', detail: 'OpenRouter could not be read from saved APIs.',
    })
  })

  it('records the web-search decision a relaunch made, when it made one', () => {
    const { deps, helpers } = setup()
    helpers.refreshGridWebSearch('a1', {} as LaunchOverrides)
    expect(deps.setGridLaunch).not.toHaveBeenCalled()
    const record = { networkId: 'grid-1' }
    helpers.refreshGridWebSearch('a1', { gridLaunchRecord: record } as unknown as LaunchOverrides)
    expect(deps.setGridLaunch).toHaveBeenCalledWith('a1', record)
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
