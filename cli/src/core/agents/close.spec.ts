import { readInlineScreen } from '../../testing/inlineScreen.js'
import { screenFor } from '../../engines/screens.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { inspectCloseActivity, type CloseAgentServiceDeps } from '../../lib/closeAgentService.js'
import { projectDisplayName, type RegisteredSession } from '../../lib/registry.js'
import { CLOSE_READ_RECONNECT_MS, createAgentClosing, createCloseRequests, type ClosingDeps } from './close.js'
import * as TAKEOVER from '../../lib/__fixtures__/takeoverScreens.js'

// The real close service, recording what it was built with so its callbacks can be driven directly.
vi.mock('../../lib/closeAgentService.js', async (real) => {
  const actual = await real<typeof import('../../lib/closeAgentService.js')>()
  class RecordingCloseAgentService extends actual.CloseAgentService {
    constructor(readonly given: CloseAgentServiceDeps) { super(given) }
  }
  return { ...actual, CloseAgentService: RecordingCloseAgentService, inspectCloseActivity: vi.fn(() => 'idle') }
})

const row = (over: Partial<RegisteredSession> = {}) =>
  ({ agentId: 'a1', sessionId: 's1', engine: 'claude', cwd: '/work/app', registeredAt: 0, ...over }) as RegisteredSession

function setup(over: Partial<ClosingDeps> = {}, advertised: RegisteredSession[] = [], current = row()) {
  const deps: ClosingDeps = {
    readScreen: readInlineScreen,
    registry: { advertised: vi.fn(() => advertised), byAgent: vi.fn(() => current) } as unknown as ClosingDeps['registry'],
    cleanupTabs: { refresh: vi.fn(async () => {}), isHidden: vi.fn(() => true), assertHidden: vi.fn(async () => {}) },
    watcher: { pollSession: vi.fn(async () => {}) } as unknown as ClosingDeps['watcher'],
    captureTerminal: vi.fn(async () => 'screen'),
    sessionTurnState: vi.fn(() => false),
    nativeRecoveryReady: vi.fn(() => true),
    openQuestions: { has: vi.fn(() => false) },
    terminals: { captureRetained: vi.fn(async () => ({ state: 'succeeded', value: 'scrollback' })) } as unknown as ClosingDeps['terminals'],
    sessionCheckpoints: { save: vi.fn(async () => {}) } as unknown as ClosingDeps['sessionCheckpoints'],
    stopAgent: vi.fn(async () => {}),
    announceSession: vi.fn(),
    engineReady: vi.fn(async () => {}),
    ...over,
  }
  const closing = createAgentClosing(deps)
  const close = (closing.closeAgentService as unknown as { given: CloseAgentServiceDeps }).given
  return { deps, closing, close }
}

describe('closing agents no window shows', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks() })

  it('builds the close service on the registry and the open tabs, stopping and announcing as elsewhere', () => {
    const { deps, close } = setup()
    expect(close.registry).toBe(deps.registry)
    expect(close.openTabs).toBe(deps.cleanupTabs)
    expect(close.stop).toBe(deps.stopAgent)
    expect(close.changed).toBe(deps.announceSession)
  })

  it('reads from its pane whether it waits at a question its engine asks before any conversation', async () => {
    const at = (screen: string) => setup({ captureTerminal: vi.fn(async () => screen) }).close.atStartupQuestion!(row({ sessionId: '' }))
    expect(await at(TAKEOVER.CLAUDE_MCP_SERVER_PROMPT)).toBe(true)
    expect(await at(TAKEOVER.CLAUDE_TRUST_PROMPT)).toBe(true)
    expect(await at('screen')).toBe(false)
  })

  it('knows a close of one already closed: not live, and kept stopped with the conversation the close names', () => {
    const live = row({ agentId: 'live' })
    const kept = row({ agentId: 'kept', sessionId: 's-kept', registeredAt: 5 })
    const registry = { byAgent: vi.fn((id: string) => (id === 'live' ? live : undefined)) } as unknown as ClosingDeps['registry']
    const stoppedAgents = { get: vi.fn((id: string) => (id === 'kept' || id === 'live' ? kept : null)), resumeReservedAt: vi.fn((_id: string): number | null => null) }
    const { close } = setup({ registry, stoppedAgents })
    const asked = (agentId: string, over: Record<string, string> = {}) => ({ agentId, sessionId: 's-kept', createdAt: new Date(5).toISOString(), mode: 'now' as const, ...over })
    expect(close.closedAlready!(asked('kept'))).toBe(true)
    // Asked before its conversation was known: the creation alone.
    expect(close.closedAlready!(asked('kept', { sessionId: '' }))).toBe(true)
    expect(close.closedAlready!(asked('kept', { sessionId: 's-other' }))).toBe(false)
    expect(close.closedAlready!(asked('kept', { createdAt: new Date(6).toISOString() }))).toBe(false)
    expect(close.closedAlready!(asked('live'))).toBe(false)
    expect(close.closedAlready!(asked('gone'))).toBe(false)
    // Being resumed: about to be live again, not closed.
    stoppedAgents.resumeReservedAt.mockReturnValueOnce(1)
    expect(close.closedAlready!(asked('kept'))).toBe(false)
    // A record that cannot be read says nothing.
    stoppedAgents.get.mockImplementationOnce(() => { throw new Error('unreadable') })
    expect(close.closedAlready!(asked('kept'))).toBe(false)
    // A core that keeps no stopped agents knows none closed.
    expect(setup({ registry }).close.closedAlready!(asked('kept'))).toBe(false)
  })

  describe('what an agent is doing', () => {
    it('uses the registry and turn holds when the core has no separate native recovery gate', async () => {
      expect(await setup({ nativeRecoveryReady: undefined }).close.activity(row())).toBe('idle')
    })

    it('reads its newest lines first, then its screen, its turn and whether it is asking', async () => {
      const { deps, close } = setup()
      expect(await close.activity(row())).toBe('idle')
      expect(deps.watcher.pollSession).toHaveBeenCalledWith('s1')
      expect(deps.captureTerminal).toHaveBeenCalledWith('a1', 80)
      expect(deps.sessionTurnState).toHaveBeenCalledWith('s1')
      expect(deps.openQuestions.has).toHaveBeenCalledWith('s1')
      expect(inspectCloseActivity).toHaveBeenCalledWith(row(), screenFor('claude').inspect('screen'), false, false)
    })

    it('with no session yet, has no lines to read', async () => {
      const session = row({ sessionId: '' })
      const { deps, close } = setup({}, [], session)
      await close.activity(session)
      expect(deps.watcher.pollSession).not.toHaveBeenCalled()
    })

    it.each(['ENGINE_STALE_REPLY', 'ENGINE_UNAVAILABLE'])('reads once more after %s, once the restarted worker is linked again', async code => {
      vi.spyOn(console, 'log').mockImplementation(() => {})
      const pollSession = vi.fn().mockRejectedValueOnce(Object.assign(new Error(code), { code })).mockResolvedValue(undefined)
      const session = row({ engine: 'codex' })
      const { deps, close } = setup({ watcher: { pollSession } as unknown as ClosingDeps['watcher'] }, [], session)
      expect(await close.activity(session)).toBe('idle')
      expect(deps.engineReady).toHaveBeenCalledWith('codex', CLOSE_READ_RECONNECT_MS)
      expect(pollSession).toHaveBeenCalledTimes(2)
    })

    it('holds changed transcript evidence before reading a screen or closing', async () => {
      const pollSession = vi.fn().mockRejectedValue(Object.assign(new Error('changed'), { code: 'ENGINE_TRANSCRIPT_CHANGED' }))
      const { deps, close } = setup({ watcher: { pollSession } as never })
      await expect(close.activity(row())).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' })
      expect(pollSession).toHaveBeenCalledOnce()
      expect(deps.captureTerminal).not.toHaveBeenCalled()
      expect(deps.stopAgent).not.toHaveBeenCalled()
    })

    it.each(['ENGINE_UNAVAILABLE', 'ENGINE_TRANSCRIPT_CHANGED', 'DISK_UNREADABLE', undefined])(
      'retains a failed second activity read with its correct reason: %s', async code => {
        vi.spyOn(console, 'log').mockImplementation(() => {})
        const failure = code ? Object.assign(new Error(code), { code }) : null
        const pollSession = vi.fn().mockRejectedValueOnce(Object.assign(new Error('reconnect'), { code: 'ENGINE_UNAVAILABLE' }))
          .mockRejectedValueOnce(failure)
        const { close } = setup({ watcher: { pollSession } as never })
        const result = expect(close.activity(row()))
        if (code === 'ENGINE_UNAVAILABLE' || code === 'ENGINE_TRANSCRIPT_CHANGED') {
          await result.rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' })
        } else await result.rejects.toBe(failure)
        expect(pollSession).toHaveBeenCalledTimes(2)
      })

    it('reads only once more, and never retries a failure that is not a worker\'s restart', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {})
      const stale = Object.assign(new Error('stale'), { code: 'ENGINE_STALE_REPLY' })
      const twice = vi.fn().mockRejectedValue(stale)
      const again = setup({ watcher: { pollSession: twice } as unknown as ClosingDeps['watcher'] })
      await expect(again.close.activity(row())).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' })
      expect(twice).toHaveBeenCalledTimes(2)
      for (const error of [new Error('disk gone'), null]) {
        const other = vi.fn().mockRejectedValue(error)
        const once = setup({ watcher: { pollSession: other } as unknown as ClosingDeps['watcher'] })
        await expect(once.close.activity(row())).rejects.toBe(error)
        expect(other).toHaveBeenCalledOnce()
        expect(once.deps.engineReady).not.toHaveBeenCalled()
      }
    })
  })

  describe('the checkpoint around a close', () => {
    it('before: keeps two thousand lines of the pane with the conversation', async () => {
      const { deps, close } = setup()
      await close.checkpoint(row(), 'before')
      expect(deps.terminals.captureRetained).toHaveBeenCalledWith(row(), { historyLines: 2000 })
      expect(deps.sessionCheckpoints.save).toHaveBeenCalledWith(row(), { screen: 'scrollback' })
    })

    it('before, with a pane it cannot read, and after: keeps the conversation without a screen', async () => {
      const failing = setup({ terminals: { captureRetained: vi.fn(async () => ({ state: 'failed', reason: 'gone' })) } as never })
      await failing.close.checkpoint(row(), 'before')
      expect(failing.deps.sessionCheckpoints.save).toHaveBeenCalledWith(row(), { screen: null })
      const after = setup()
      await after.close.checkpoint(row(), 'after')
      expect(after.deps.terminals.captureRetained).not.toHaveBeenCalled()
      expect(after.deps.sessionCheckpoints.save).toHaveBeenCalledWith(row(), { screen: null })
    })
  })

  describe('the cleanup preview', () => {
    it('lists the hidden agents a close would take, as they are now, and counts the rest as kept', async () => {
      const shown = row({ agentId: 'shown' })
      const changing = row({ agentId: 'changing' })
      const quiet = row({ agentId: 'quiet', sessionId: 's2', registeredAt: 1_000 })
      const working = row({ agentId: 'working', sessionId: 's3' })
      const { deps, closing } = setup({}, [shown, changing, quiet, working])
      vi.mocked(deps.cleanupTabs.isHidden).mockImplementation((s) => s.agentId !== 'shown')
      const request = vi.spyOn(closing.closeAgentService, 'request')
        .mockResolvedValueOnce({ error: 'AGENT_CHANGED' })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ activity: 'working' })
      expect(await closing.cleanupPreview()).toEqual({
        version: 1,
        agents: [
          { agentId: 'quiet', sessionId: 's2', createdAt: new Date(1_000).toISOString(), name: projectDisplayName(quiet), engine: 'claude', activity: 'unknown' },
          { agentId: 'working', sessionId: 's3', createdAt: new Date(0).toISOString(), name: projectDisplayName(working), engine: 'claude', activity: 'working' },
        ],
        kept: 2,
      })
      expect(deps.cleanupTabs.refresh).toHaveBeenCalled()
      expect(request).toHaveBeenCalledWith({ agentId: 'changing', sessionId: 's1', createdAt: new Date(0).toISOString(), mode: 'inspect' })
      expect(request).toHaveBeenCalledTimes(3)
    })

    it('leaves out an agent closed while the preview was reading the others', async () => {
      // An inspect of an agent already closed answers { closed: true }: it has nothing left to close, and once
      // entered the reviewed batch as activity 'unknown'.
      const stopped = row({ agentId: 'stopped' })
      const quiet = row({ agentId: 'quiet', sessionId: 's2' })
      const { deps, closing } = setup({}, [stopped, quiet])
      vi.mocked(deps.cleanupTabs.isHidden).mockReturnValue(true)
      vi.spyOn(closing.closeAgentService, 'request')
        .mockResolvedValueOnce({ closed: true })
        .mockResolvedValueOnce({ activity: 'idle' })
      expect(await closing.cleanupPreview()).toEqual({
        version: 1,
        agents: [{ agentId: 'quiet', sessionId: 's2', createdAt: new Date(0).toISOString(), name: projectDisplayName(quiet), engine: 'claude', activity: 'idle' }],
        kept: 1,
      })
    })

    it('a close asked for while the preview is reading the agent is carried out, not answered with the reading', async () => {
      // The preview inspects every hidden agent; a window's close of one of them arriving meanwhile was
      // once answered with that inspect's `{ activity }`, and the agent left running (e2e/windows.e2e.ts).
      const busy = row({ agentId: 'busy', sessionId: 's9', runtimes: [] })
      const registry = { advertised: vi.fn(() => [busy]), byAgent: vi.fn((id: string) => (id === 'busy' ? busy : undefined)),
        list: vi.fn(() => [busy]), setClosePlan: vi.fn() }
      const { deps, closing } = setup({ registry: registry as unknown as ClosingDeps['registry'] })
      let read!: (screen: string) => void
      vi.mocked(deps.captureTerminal).mockImplementationOnce(() => new Promise<string | null>((resolve) => { read = resolve }))
      const preview = closing.cleanupPreview()
      await vi.waitFor(() => expect(read).toBeTypeOf('function'))
      const close = closing.closeAgentService.request({ agentId: 'busy', sessionId: 's9', createdAt: new Date(0).toISOString(), mode: 'now' })
      read('screen')
      expect((await preview).agents).toEqual([expect.objectContaining({ agentId: 'busy' })])
      expect(await close).toEqual({ closed: true })
      expect(deps.stopAgent).toHaveBeenCalledOnce()
    })
  })
})

describe('agents_cleanup_preview', () => {
  it('answers with the preview once it is read, outside the connection\'s line', async () => {
    let read!: (preview: Record<string, unknown>) => void
    const replies: Array<Record<string, unknown>> = []
    createCloseRequests({ cleanupPreview: () => new Promise((resolve) => { read = resolve }), closeAgentService: () => null }).preview((result) => { replies.push(result) })
    expect(replies).toEqual([])
    read({ version: 1, agents: [], kept: 2 })
    await vi.waitFor(() => expect(replies).toStrictEqual([{ version: 1, agents: [], kept: 2 }]))
  })

  it('says why a preview could not be read: the failure\'s own code and words, or that the tabs were unavailable', async () => {
    const replies: Array<Record<string, unknown>> = []
    const failing = (error: unknown) => createCloseRequests({ cleanupPreview: async () => { throw error }, closeAgentService: () => null }).preview((result) => { replies.push(result) })
    failing(Object.assign(new Error('The desk could not be read.'), { code: 'DESK_UNAVAILABLE' }))
    failing(new Error('offline'))
    failing(undefined)
    await vi.waitFor(() => expect(replies).toHaveLength(3))
    expect(replies).toStrictEqual([
      { error: 'DESK_UNAVAILABLE', detail: 'The desk could not be read.' },
      { error: 'TABS_UNAVAILABLE', detail: 'offline' },
      { error: 'TABS_UNAVAILABLE', detail: 'Could not check open tabs.' },
    ])
    expect(Object.keys(replies[0])).toEqual(['error', 'detail'])
  })
})

describe('agent_close', () => {
  const target = { agentId: 'a1', sessionId: 's1', createdAt: '2026-10-05T07:00:00.000Z' }
  const ask = (service: { request: (...args: never[]) => Promise<Record<string, unknown>> } | null, payload: Record<string, unknown>) => {
    const replies: Array<Record<string, unknown>> = []
    createCloseRequests({ cleanupPreview: async () => ({}), closeAgentService: () => service as never }).close(payload, (result) => { replies.push(result) })
    return replies
  }

  it('asks the close service, in the mode asked for, only when hidden if asked so, and answers once it is done', async () => {
    let done!: (result: Record<string, unknown>) => void
    const request = vi.fn(() => new Promise<Record<string, unknown>>((resolve) => { done = resolve }))
    const replies = ask({ request }, { ...target, mode: 'idle', onlyIfHidden: true, requestId: 'r' })
    expect(request).toHaveBeenCalledWith({ ...target, mode: 'idle', onlyIfHidden: true })
    expect(replies).toEqual([])
    done({ closed: true })
    await vi.waitFor(() => expect(replies).toStrictEqual([{ closed: true }]))
    ask({ request: vi.fn(async () => ({})) }, { ...target, mode: 'now', onlyIfHidden: 'yes' })
  })

  it('refuses a request it cannot read, and says when the close failed or there is no service to ask', async () => {
    const request = vi.fn(async () => { throw new Error('tmux gone') })
    for (const wrong of [{ ...target, mode: 'later' }, { ...target, mode: 3 }, { ...target, createdAt: 7, mode: 'now' }, { ...target, sessionId: null, mode: 'now' }, { mode: 'now' }]) {
      expect(ask({ request }, wrong)).toStrictEqual([{ error: 'INVALID_CLOSE_REQUEST' }])
    }
    expect(request).not.toHaveBeenCalled()
    const failed = ask({ request }, { ...target, mode: 'cancel' })
    await vi.waitFor(() => expect(failed).toStrictEqual([{ error: 'CLOSE_FAILED' }]))
    expect(ask(null, { ...target, mode: 'now' })).toStrictEqual([{ error: 'UNSUPPORTED' }])
  })
})
