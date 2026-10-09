import { describe, expect, it, vi } from 'vitest'
import type { RegisteredSession } from '../../lib/registry.js'
import type { LaunchOverridesResult } from '../../lib/launchOverrides.js'
import { createRestoreLaunch } from './restoreLaunch.js'
import { createLaunchHelpers } from './launch.js'
import { createLaunchAuthority } from './launchAuthority.js'

const entry = { agentId: 'agent', sessionId: 'conversation', cwd: '/workspace' } as RegisteredSession
const built: Extract<LaunchOverridesResult, { ok: true }> = { ok: true, overrides: { env: {}, extraArgs: [], clearEnv: [] } }
const setup = () => {
  const deps = {
    workspaceMissing: vi.fn((): { error: string; detail: string } | null => null),
    relaunchOverrides: vi.fn(async (): Promise<LaunchOverridesResult> => built),
    downgradedPermission: vi.fn(async () => ({ bypassPermission: false })),
    prepareSessionResume: vi.fn(), refreshGridWebSearch: vi.fn(),
    launch: vi.fn(() => ({ argv: ['engine'] })),
  }
  return { deps, build: createRestoreLaunch(deps) }
}

describe('restore preparation keeps session authority in core', () => {
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
        tmuxSupportsSessionEnv: async () => true, writeGridConfigDir: vi.fn(), installCodexHooks: vi.fn(), readCodexConfig: () => null },
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
        tmuxSupportsSessionEnv: async () => true, writeGridConfigDir: vi.fn(), installCodexHooks: vi.fn(), readCodexConfig: () => null,
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
