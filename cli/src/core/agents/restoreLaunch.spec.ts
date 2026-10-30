import { describe, expect, it, vi } from 'vitest'
import type { RegisteredSession } from '../../lib/registry.js'
import type { LaunchOverridesResult } from '../../lib/launchOverrides.js'
import { createRestoreLaunch } from './restoreLaunch.js'
import { WindowsBatchLaunchRefused } from '../../lib/windows/launch.js'
import { createLaunchHelpers } from './launch.js'
import { createLaunchAuthority } from './launchAuthority.js'
import type { NativeLaunch } from '../../engines/nativeLaunch.js'
import type { SwarmSkillGrant } from '../../lib/swarmSkills.js'
import { createSwarmSkillAdoption } from '../../superTabs/inCore/adoption.js'

const entry = { agentId: 'agent', sessionId: 'conversation', cwd: '/workspace' } as RegisteredSession
const built: Extract<LaunchOverridesResult, { ok: true }> = { ok: true, overrides: { env: {}, extraArgs: [], clearEnv: [] } }
const setup = (adoptSwarmSkill?: ReturnType<typeof createSwarmSkillAdoption>) => {
  const deps = {
    ...(adoptSwarmSkill ? { adoptSwarmSkill } : {}),
    workspaceMissing: vi.fn((): { error: string; detail: string } | null => null),
    relaunchOverrides: vi.fn(async (): Promise<LaunchOverridesResult> => built),
    downgradedPermission: vi.fn(async () => ({ bypassPermission: false })),
    prepareSessionResume: vi.fn(), refreshGridWebSearch: vi.fn(),
    launch: vi.fn(() => ({ argv: ['engine'] })),
  }
  return { deps, build: createRestoreLaunch(deps) }
}

// Security review 1 of #2255: boot restore and a host move relaunched an old Buddy with no saved role without asking the
// Swarm, so it came back without its guard.
describe('an old Swarm session with no saved role', () => {
  const legacyBuddy = { ...entry, engine: 'claude', startedBy: 'agent' } as RegisteredSession
  const swarm = (grant: SwarmSkillGrant | null | undefined) => {
    const save = vi.fn()
    const role = vi.fn(async () => grant)
    return { save, role, adopt: createSwarmSkillAdoption({ role, save, authority: () => () => true, candidate: () => false }) }
  }
  it('is restored with its Buddy role, saved on its row before the launch is built', async () => {
    const s = swarm({ role: 'buddy' }), { deps, build } = setup(s.adopt)
    expect(await build(legacyBuddy, { current: () => true })).toEqual({ argv: ['engine'] })
    const tagged = expect.objectContaining({ swarmSkill: { role: 'buddy', key: 'agent' } })
    expect(deps.relaunchOverrides).toHaveBeenCalledWith(tagged, tagged, expect.any(Function))
    expect(deps.launch).toHaveBeenCalledWith(tagged, {}, built.overrides, { bypassPermission: false })
    expect(s.save).toHaveBeenCalledWith('agent', { role: 'buddy', key: 'agent' })
  })
  it('is held, never launched, while its role cannot be read', async () => {
    const { deps, build } = setup(swarm(undefined).adopt)
    // What its pane shows the person while it waits: plain words, no ids.
    expect(await build(legacyBuddy, { current: () => true })).toEqual({ held: 'superTabs',
      detail: 'Waiting for the Swarm to confirm this agent\'s role. It starts by itself once the Swarm answers.' })
    expect(deps.relaunchOverrides).not.toHaveBeenCalled()
    expect(deps.launch).not.toHaveBeenCalled()
  })
  it('is left alone when the restore is cancelled while its role is read', async () => {
    let current = true
    const role = vi.fn(async () => { current = false; return { role: 'buddy' as const } })
    const { deps, build } = setup(createSwarmSkillAdoption({ role, save: vi.fn(), authority: () => () => true, candidate: () => false }))
    expect(await build(legacyBuddy, { current: () => current })).toEqual({ cancelled: true })
    expect(deps.relaunchOverrides).not.toHaveBeenCalled()
  })
  it('moves to another host with its Buddy role, writing nothing while its old engine runs', async () => {
    const s = swarm({ role: 'buddy' }), { deps, build } = setup(s.adopt)
    expect(await build(legacyBuddy, { resumeSessionId: 'conversation', current: () => true, prepare: false })).toMatchObject({ argv: ['engine'] })
    expect(deps.launch).toHaveBeenCalledWith(expect.objectContaining({ swarmSkill: { role: 'buddy', key: 'agent' } }),
      { resumeSessionId: 'conversation' }, built.overrides, { bypassPermission: false })
    expect(s.save).not.toHaveBeenCalled()
  })
  it('does not move while its role cannot be read', async () => {
    const { deps, build } = setup(swarm(undefined).adopt)
    expect(await build(legacyBuddy, { resumeSessionId: 'conversation', current: () => true, prepare: false })).toMatchObject({ held: 'superTabs' })
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

describe('a launch built without preparation', () => {
  it('writes neither the conversation nor the row, and builds the same launch', async () => {
    const { deps, build } = setup()
    expect(await build(entry, { resumeSessionId: 'conversation', current: () => true, prepare: false })).toMatchObject({ argv: ['engine'] })
    expect(deps.prepareSessionResume).not.toHaveBeenCalled()
    expect(deps.refreshGridWebSearch).not.toHaveBeenCalled()
    expect(deps.launch).toHaveBeenCalledWith(entry, { resumeSessionId: 'conversation' }, built.overrides, { bypassPermission: false })
    const prepared = await build(entry, { resumeSessionId: 'conversation', current: () => true })
    expect(prepared).toEqual({ argv: ['engine'] })
    expect(deps.prepareSessionResume).toHaveBeenCalledWith(entry)
    expect(deps.refreshGridWebSearch).toHaveBeenCalledTimes(1)
  })

  it('hands back what it left out, run later with the overrides it was built with, never asked for again', async () => {
    const { deps, build } = setup()
    deps.downgradedPermission.mockResolvedValue({ bypassPermission: true, permissionMode: 'plan' } as never)
    const launch = await build(entry, { resumeSessionId: 'conversation', current: () => true, prepare: false })
    if (!('argv' in launch) || !launch.deferred) throw new Error('expected a deferred launch')
    expect(launch.deferred.overrides).toBe(built.overrides)
    expect(launch.deferred.permission).toEqual({ bypassPermission: true, permissionMode: 'plan' })
    launch.deferred.prepare()
    expect(deps.prepareSessionResume).toHaveBeenCalledWith(entry)
    expect(deps.refreshGridWebSearch).toHaveBeenCalledWith('agent', built.overrides)
    expect(deps.relaunchOverrides).toHaveBeenCalledTimes(1)
    // A preparation that fails says so to its caller, which falls back (hostMove/moveAgent.ts).
    deps.prepareSessionResume.mockImplementationOnce(() => { throw new Error('rollout unreadable') })
    expect(() => launch.deferred!.prepare()).toThrow('rollout unreadable')
    // Nothing to resume: nothing to prepare, only the grid's web search.
    const fresh = await build(entry, { current: () => true, prepare: false })
    if (!('argv' in fresh) || !fresh.deferred) throw new Error('expected a deferred launch')
    fresh.deferred.prepare()
    expect(deps.prepareSessionResume).toHaveBeenCalledTimes(2)
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
    if (stage === 'ready') expect(result).toEqual({ argv: ['engine'] })
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
    const apiNotes = vi.fn()
    const helpers = createLaunchHelpers({
      authority: createLaunchAuthority({ byAgent: () => live, revision: () => 1, cancelled: () => false }),
      prepareApiTools: apiNotes, setGridLaunch: vi.fn(), setTail: vi.fn(),
      launchOverridesDeps: { machine: () => ({ hermesSystemManaged: false }), gridLaunch: vi.fn(),
        capabilities: async () => ({ sessionEnv: true }), writeGridConfigDir: vi.fn(), installCodexHooks: vi.fn(async () => true), readCodexConfig: () => null },
    })
    const { deps } = setup()
    const build = createRestoreLaunch({ ...deps, relaunchOverrides: helpers.relaunchOverrides })
    expect(await build(requested, { current: () => true })).toEqual({ argv: ['engine'] })
    expect(apiNotes).toHaveBeenCalledWith('/workspace', requested.engine)
    expect(deps.launch).toHaveBeenCalledWith(requested, {}, expect.any(Object), expect.any(Object))
  })

  it('a richer dispatch fence cancels restore without failing or publishing the replacement', async () => {
    const live = { ...entry, engine: 'claude', dsh: 'fixture/tools', active: true, processIdentity: null,
      runtimes: [{ backend: 'tmux', paneId: '%7' }],
    } as RegisteredSession
    const apiNotes = vi.fn()
    const helpers = createLaunchHelpers({
      authority: createLaunchAuthority({ byAgent: () => live, revision: () => 1, cancelled: () => false }),
      prepareApiTools: apiNotes, setGridLaunch: vi.fn(), setTail: vi.fn(),
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
    expect(await build(entry, { resumeSessionId, current: () => true })).toEqual({ argv: ['engine'] })
    expect(deps.prepareSessionResume).toHaveBeenCalledTimes(resumeSessionId ? 1 : 0)
    expect(deps.refreshGridWebSearch).toHaveBeenCalledWith('agent', built.overrides)
    expect(deps.launch).toHaveBeenCalledWith(entry, { resumeSessionId }, built.overrides, { bypassPermission: false })
  })

  it.each(['Store', 'permission'] as const)('a replacement arriving during %s leaves its transcript, tail and grid untouched', async stage => {
    const { deps, build } = setup()
    let answer!: () => void
    const pending = new Promise<void>(resolve => { answer = resolve })
    if (stage === 'Store') deps.relaunchOverrides.mockImplementation(async () => { await pending; return built })
    else deps.downgradedPermission.mockImplementation(async () => { await pending; return { bypassPermission: false } })
    let current = true
    const replacement = { transcript: 'new turn', tail: 42, grid: 'new grid' }
    deps.prepareSessionResume.mockImplementation(() => { replacement.transcript = 'repaired old turn'; replacement.tail = 0 })
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

  it.each([new Error('unreadable'), 'unreadable'])('reports resume repair errors without applying grid changes', async error => {
    const { deps, build } = setup()
    deps.prepareSessionResume.mockImplementation(() => { throw error })
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
