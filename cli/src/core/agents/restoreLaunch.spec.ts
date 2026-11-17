import { describe, expect, it, vi } from 'vitest'
import type { RegisteredSession } from '../../lib/registry.js'
import type { LaunchOverridesResult } from '../../lib/launchOverrides.js'
import { createRestoreLaunch } from './restoreLaunch.js'
import { WindowsBatchLaunchRefused } from '../../lib/windows/launch.js'
import { createLaunchHelpers } from './launch.js'
import { createLaunchAuthority } from './launchAuthority.js'
import type { NativeLaunch } from '../../engines/nativeLaunch.js'

const entry = { agentId: 'agent', sessionId: 'conversation', cwd: '/workspace' } as RegisteredSession
const built: Extract<LaunchOverridesResult, { ok: true }> = { ok: true, overrides: { env: {}, extraArgs: [], clearEnv: [] } }
const setup = () => {
  const deps = {
    workspaceMissing: vi.fn((): { error: string; detail: string } | null => null),
    relaunchOverrides: vi.fn(async (): Promise<LaunchOverridesResult> => built),
    downgradedPermission: vi.fn(async () => ({ bypassPermission: false })),
    prepareSessionResume: vi.fn(async (_entry: RegisteredSession, _current: () => boolean) => {}), refreshGridWebSearch: vi.fn(),
    launch: vi.fn(() => ({ argv: ['engine'] })),
  }
  return { deps, build: createRestoreLaunch(deps) }
}

it.each([undefined, false] as const)('prepares optional values once for the final restore or move owner, prepare=%s', async prepare => {
  const { deps, build } = setup()
  const settings = { values: { instructions: 'optional owner', settings: null }, current: () => true }
  const prepareSettings = vi.fn(async () => settings)
  const native = { current: () => true, prepareSettings } as unknown as NativeLaunch
  deps.relaunchOverrides.mockResolvedValue({ ok: true, overrides: { ...built.overrides, native } })
  const row = { ...entry, cwd: prepare === false ? null : '/workspace' }
  const result = await build(row, { current: () => true, prepare, resumeSessionId: 'conversation' })
  expect(prepareSettings).toHaveBeenCalledExactlyOnceWith(row.cwd, expect.any(Function))
  expect(deps.launch).toHaveBeenCalledWith(row, expect.any(Object), expect.objectContaining({ native, settings }), expect.any(Object))
  if ('argv' in result && result.deferred) await result.deferred.prepare()
  expect(prepareSettings).toHaveBeenCalledOnce()
})

describe('a guest\'s harness at boot', () => {
  it('is never relaunched as the owner: refused before a workspace or service is touched', async () => {
    const { deps, build } = setup()
    expect(await build({ ...entry, guest: 'kim@acme.io' } as RegisteredSession, { current: () => true }))
      .toEqual({ error: 'GUEST_HARNESS', detail: expect.stringContaining('shared with you') })
    expect(deps.workspaceMissing).not.toHaveBeenCalled()
    expect(deps.launch).not.toHaveBeenCalled()
  })
})

describe('a restore launch Windows refuses', () => {
  it('fails that row alone, with its reason; any other error is thrown on', async () => {
    const { deps, build } = setup()
    deps.launch.mockImplementationOnce(() => { throw new WindowsBatchLaunchRefused('claude', 'C:\\tools\\claude.cmd') })
    expect(await build(entry, { current: () => true })).toEqual({ error: 'ENGINE_LAUNCH_REFUSED', detail: expect.stringContaining('claude.cmd is a batch file') })
    deps.launch.mockImplementationOnce(() => { throw new Error('fixture') })
    await expect(build(entry, { current: () => true })).rejects.toThrow('fixture')
  })
})

describe('the grid a restore launch puts its engine on', () => {
  it('is its launch record\'s, as refreshed for this launch, or none on the engine\'s own login, prepared or not', async () => {
    const override = { networkId: 'api', networkName: 'Saved', baseUrl: 'https://saved.example/now/v1', apiKey: 'k', model: 'm' }
    for (const prepare of [undefined, false] as const) {
      const { deps, build } = setup()
      deps.relaunchOverrides.mockResolvedValueOnce({ ok: true, overrides: { ...built.overrides, gridLaunchRecord: { override, webSearch: 'on' } } })
      expect(await build(entry, { current: () => true, prepare })).toMatchObject({ grid: { baseUrl: 'https://saved.example/now/v1', model: 'm' } })
      const { model: _model, ...modelless } = override
      deps.relaunchOverrides.mockResolvedValueOnce({ ok: true, overrides: { ...built.overrides, gridLaunchRecord: { override: modelless, webSearch: 'on' } } })
      expect(await build(entry, { current: () => true, prepare })).toMatchObject({ grid: { baseUrl: 'https://saved.example/now/v1', model: null } })
      expect(await build(entry, { current: () => true, prepare })).toMatchObject({ grid: null })
    }
  })
})

describe('a launch built without preparation', () => {
  it('writes neither the conversation nor the row, and builds the same launch', async () => {
    const { deps, build } = setup()
    expect(await build(entry, { resumeSessionId: 'conversation', current: () => true, prepare: false })).toMatchObject({ argv: ['engine'] })
    expect(deps.prepareSessionResume).not.toHaveBeenCalled()
    expect(deps.refreshGridWebSearch).not.toHaveBeenCalled()
    expect(deps.launch).toHaveBeenCalledWith(entry, { resumeSessionId: 'conversation', agentId: 'agent' }, built.overrides, { bypassPermission: false })
    const current = () => true
    const prepared = await build(entry, { resumeSessionId: 'conversation', current })
    expect(prepared).toEqual({ argv: ['engine'], grid: null })
    // The history is replaced only while this restore holds.
    expect(deps.prepareSessionResume).toHaveBeenCalledWith(entry, current)
    expect(deps.refreshGridWebSearch).toHaveBeenCalledTimes(1)
  })

  it('hands back what it left out, run later with the overrides it was built with, never asked for again', async () => {
    const { deps, build } = setup()
    deps.downgradedPermission.mockResolvedValue({ bypassPermission: true, permissionMode: 'plan' } as never)
    const launch = await build(entry, { resumeSessionId: 'conversation', current: () => true, prepare: false })
    if (!('argv' in launch) || !launch.deferred) throw new Error('expected a deferred launch')
    expect(launch.deferred.overrides).toBe(built.overrides)
    expect(launch.deferred.permission).toEqual({ bypassPermission: true, permissionMode: 'plan' })
    await launch.deferred.prepare()
    expect(deps.prepareSessionResume).toHaveBeenCalledWith(entry, expect.any(Function))
    expect(deps.refreshGridWebSearch).toHaveBeenCalledWith('agent', built.overrides)
    expect(deps.relaunchOverrides).toHaveBeenCalledTimes(1)
    // A preparation that fails says so to its caller, which falls back (hostMove/moveAgent.ts).
    deps.prepareSessionResume.mockRejectedValueOnce(new Error('rollout unreadable'))
    await expect(launch.deferred!.prepare()).rejects.toThrow('rollout unreadable')
    // Nothing to resume: nothing to prepare, only the grid's web search.
    const fresh = await build(entry, { current: () => true, prepare: false })
    if (!('argv' in fresh) || !fresh.deferred) throw new Error('expected a deferred launch')
    await fresh.deferred.prepare()
    expect(deps.prepareSessionResume).toHaveBeenCalledTimes(2)
    expect(deps.refreshGridWebSearch).toHaveBeenCalledTimes(2)
  })

  it('hands the move\'s own wait to the repair: once the move stops waiting, the history is left as it is', async () => {
    const { deps, build } = setup()
    const launch = await build(entry, { resumeSessionId: 'conversation', current: () => true, prepare: false })
    if (!('argv' in launch) || !launch.deferred) throw new Error('expected a deferred launch')
    let waiting = true
    await launch.deferred.prepare(() => waiting)
    const holds = vi.mocked(deps.prepareSessionResume).mock.lastCall![1]
    expect(holds()).toBe(true)
    waiting = false
    expect(holds()).toBe(false)
  })

  it('writes no grid for a move that stopped holding while its history was prepared', async () => {
    const { deps, build } = setup()
    let current = true
    const launch = await build(entry, { resumeSessionId: 'conversation', current: () => current, prepare: false })
    if (!('argv' in launch) || !launch.deferred) throw new Error('expected a deferred launch')
    deps.prepareSessionResume.mockImplementationOnce(async () => { current = false })
    await launch.deferred.prepare()
    expect(deps.refreshGridWebSearch).not.toHaveBeenCalled()
  })
})

describe('restore preparation keeps session authority in core', () => {
  it.each(['unknown flags', 'changed executable', 'ready'] as const)('preserves native preparation evidence through restore: %s', async stage => {
    const { deps, build } = setup()
    const native = { current: () => stage !== 'changed executable' } as NativeLaunch
    deps.relaunchOverrides.mockResolvedValue({ ok: true, overrides: { ...built.overrides, native } })
    if (stage === 'unknown flags') deps.downgradedPermission.mockResolvedValue({ bypassPermission: false, nativeHold: 'Waiting for executable help.' } as never)
    const result = await build(entry, { current: () => true })
    expect(deps.downgradedPermission).toHaveBeenCalledWith(entry, native)
    if (stage === 'ready') expect(result).toEqual({ argv: ['engine'], grid: null })
    else {
      expect(result).toMatchObject({ held: 'native' })
      expect(deps.launch).not.toHaveBeenCalled()
      expect(deps.refreshGridWebSearch).not.toHaveBeenCalled()
    }
  })

  it.each(['dead process', 'terminal fallback', 'fresh fallback'] as const)('composes preparation for a legitimate %s projection', async projection => {
    const live = { ...entry, engine: 'claude', active: true, launch: { state: 'ready' },
      processIdentity: { pid: 42, startMarker: 'old' }, runtimes: [{ backend: 'tmux', paneId: '%7' }],
    } as RegisteredSession
    const requested = structuredClone(live)
    if (projection === 'dead process') live.processIdentity = null
    if (projection === 'terminal fallback') { requested.engine = 'terminal'; requested.sessionId = '' }
    if (projection === 'fresh fallback') live.launch = { state: 'starting' }
    const apiNotes = vi.fn(async () => {})
    const helpers = createLaunchHelpers({
      authority: createLaunchAuthority({ byAgent: () => live, revision: () => 1, cancelled: () => false }),
      prepareInstructions: apiNotes, setGridLaunch: vi.fn(), prepareResume: async () => ({ repairedItems: 0 }),
      launchOverridesDeps: { machine: () => ({ hermesSystemManaged: false }), gridLaunch: vi.fn(),
        capabilities: async () => ({ sessionEnv: true }), writeGridConfigDir: vi.fn(), installCodexHooks: vi.fn(async () => true), readCodexConfig: () => null },
    })
    const { deps } = setup()
    const build = createRestoreLaunch({ ...deps, relaunchOverrides: helpers.relaunchOverrides })
    expect(await build(requested, { current: () => true })).toEqual({ argv: ['engine'], grid: null })
    expect(apiNotes).toHaveBeenCalledWith('/workspace', requested.engine)
    expect(deps.launch).toHaveBeenCalledWith(requested, { agentId: requested.agentId }, expect.any(Object), expect.any(Object))
  })

  it('a richer dispatch fence cancels restore without failing or publishing the replacement', async () => {
    const live = { ...entry, engine: 'claude', dsh: 'fixture/tools', active: true, processIdentity: null,
      runtimes: [{ backend: 'tmux', paneId: '%7' }],
    } as RegisteredSession
    const apiNotes = vi.fn(async () => {})
    const helpers = createLaunchHelpers({
      authority: createLaunchAuthority({ byAgent: () => live, revision: () => 1, cancelled: () => false }),
      prepareInstructions: apiNotes, setGridLaunch: vi.fn(), prepareResume: async () => ({ repairedItems: 0 }),
      launchOverridesDeps: { machine: () => ({ hermesSystemManaged: false }), gridLaunch: vi.fn(),
        capabilities: async () => ({ sessionEnv: true }), writeGridConfigDir: vi.fn(), installCodexHooks: vi.fn(async () => true), readCodexConfig: () => null,
        dshLaunch: async () => { live.permissionMode = 'ask'; return { ok: true, launch: { env: {}, args: [] } } } },
    })
    const { deps } = setup()
    const build = createRestoreLaunch({ ...deps, relaunchOverrides: helpers.relaunchOverrides })
    expect(await build(structuredClone(live), { current: () => true })).toEqual({ cancelled: true })
    expect(live.permissionMode).toBe('ask')
    expect(apiNotes).not.toHaveBeenCalled()
    expect(deps.prepareSessionResume).not.toHaveBeenCalled()
    expect(deps.refreshGridWebSearch).not.toHaveBeenCalled()
    expect(deps.launch).not.toHaveBeenCalled()
  })

  it.each([undefined, 'conversation'])('applies confirmed preparation only to the current owner: resume %s', async resumeSessionId => {
    const { deps, build } = setup()
    expect(await build(entry, { resumeSessionId, current: () => true })).toEqual({ argv: ['engine'], grid: null })
    expect(deps.prepareSessionResume).toHaveBeenCalledTimes(resumeSessionId ? 1 : 0)
    expect(deps.refreshGridWebSearch).toHaveBeenCalledWith('agent', built.overrides)
    expect(deps.launch).toHaveBeenCalledWith(entry, { resumeSessionId, agentId: 'agent' }, built.overrides, { bypassPermission: false })
  })

  it.each(['Store', 'permission'] as const)('a replacement arriving during %s leaves its transcript, tail and grid untouched', async stage => {
    const { deps, build } = setup()
    let answer!: () => void
    const pending = new Promise<void>(resolve => { answer = resolve })
    if (stage === 'Store') deps.relaunchOverrides.mockImplementation(async () => { await pending; return built })
    else deps.downgradedPermission.mockImplementation(async () => { await pending; return { bypassPermission: false } })
    let current = true
    const replacement = { transcript: 'new turn', tail: 42, grid: 'new grid' }
    deps.prepareSessionResume.mockImplementation(async () => { replacement.transcript = 'repaired old turn'; replacement.tail = 0 })
    deps.refreshGridWebSearch.mockImplementation(() => { replacement.grid = 'old grid' })
    const result = build(entry, { resumeSessionId: 'conversation', current: () => current })
    await vi.waitFor(() => expect(stage === 'Store' ? deps.relaunchOverrides : deps.downgradedPermission).toHaveBeenCalled())
    current = false
    answer()
    expect(await result).toEqual({ cancelled: true })
    expect(replacement).toEqual({ transcript: 'new turn', tail: 42, grid: 'new grid' })
    expect(deps.launch).not.toHaveBeenCalled()
  })

  it('refuses a missing workspace before asking any service', async () => {
    const { deps, build } = setup()
    deps.workspaceMissing.mockReturnValue({ error: 'WORKSPACE_MISSING', detail: 'folder gone' })
    expect(await build(entry, { current: () => true })).toEqual({ error: 'WORKSPACE_MISSING', detail: 'folder gone' })
    expect(deps.relaunchOverrides).not.toHaveBeenCalled()
  })

  it.each([false, true])('preserves refusal or the specific held reason: held %s', async held => {
    const { deps, build } = setup()
    deps.relaunchOverrides.mockResolvedValue({ ok: false, error: 'PREPARATION', detail: 'review required',
      ...(held ? { unavailable: 'store', holdScope: 'workspace' as const } : {}) })
    expect(await build(entry, { current: () => true })).toEqual(held
      ? { held: 'store', detail: 'review required', holdScope: 'workspace' }
      : { error: 'PREPARATION', detail: 'review required' })
    expect(deps.prepareSessionResume).not.toHaveBeenCalled()
    expect(deps.downgradedPermission).not.toHaveBeenCalled()
  })

  // The history is prepared a chunk at a time now (engines/kit/resumeRepair.ts): the restore may have stopped holding
  // by the time it is done, and then it launches nothing and writes no grid.
  it('a restore that stops holding while its history is prepared is cancelled, with nothing written after', async () => {
    const { deps, build } = setup()
    let current = true
    deps.prepareSessionResume.mockImplementationOnce(async () => { current = false })
    expect(await build(entry, { resumeSessionId: 'conversation', current: () => current })).toEqual({ cancelled: true })
    expect(deps.refreshGridWebSearch).not.toHaveBeenCalled()
    expect(deps.launch).not.toHaveBeenCalled()
  })

  it.each([new Error('unreadable'), 'unreadable'])('reports resume repair errors without applying grid changes', async error => {
    const { deps, build } = setup()
    deps.prepareSessionResume.mockImplementation(async () => { throw error })
    expect(await build(entry, { resumeSessionId: 'conversation', current: () => true }))
      .toEqual({ error: 'RESUME_PREPARATION_FAILED', detail: 'unreadable' })
    expect(deps.refreshGridWebSearch).not.toHaveBeenCalled()
  })
})

it('keeps unadmitted external work held before workspace checks, service preparation or transcript writes', async () => {
  for (const phase of ['waiting', 'quitting', 'cancelled'] as const) {
    for (const launch of [undefined, { state: 'held', service: 'search', detail: 'Waiting for the old terminal.' }]) {
      const { deps, build } = setup()
      const pending = { ...entry, sessionId: '', externalResume: { phase }, launch } as RegisteredSession
      expect(await build(pending, { current: () => true })).toMatchObject({ held: 'search', holdScope: 'workspace' })
      expect(deps.workspaceMissing).not.toHaveBeenCalled()
      expect(deps.relaunchOverrides).not.toHaveBeenCalled()
      expect(deps.prepareSessionResume).not.toHaveBeenCalled()
    }
  }
})
