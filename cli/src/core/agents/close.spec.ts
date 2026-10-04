import { afterEach, describe, expect, it, vi } from 'vitest'
import { inspectCloseActivity, type CloseAgentServiceDeps } from '../../lib/closeAgentService.js'
import { projectDisplayName, type RegisteredSession } from '../../lib/registry.js'
import { createAgentClosing, type ClosingDeps } from './close.js'

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

function setup(over: Partial<ClosingDeps> = {}, advertised: RegisteredSession[] = []) {
  const deps: ClosingDeps = {
    registry: { advertised: vi.fn(() => advertised) } as unknown as ClosingDeps['registry'],
    cleanupTabs: { refresh: vi.fn(async () => {}), isHidden: vi.fn(() => true), assertHidden: vi.fn(async () => {}) },
    watcher: { pollSession: vi.fn(async () => {}) } as unknown as ClosingDeps['watcher'],
    captureTerminal: vi.fn(async () => 'screen'),
    sessionTurnState: vi.fn(() => false),
    openQuestions: { has: vi.fn(() => false) },
    terminals: { captureRetained: vi.fn(async () => ({ state: 'succeeded', value: 'scrollback' })) } as unknown as ClosingDeps['terminals'],
    sessionCheckpoints: { save: vi.fn(async () => {}) } as unknown as ClosingDeps['sessionCheckpoints'],
    stopAgent: vi.fn(async () => {}),
    announceSession: vi.fn(),
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

  describe('what an agent is doing', () => {
    it('reads its newest lines first, then its screen, its turn and whether it is asking', async () => {
      const { deps, close } = setup()
      expect(await close.activity(row())).toBe('idle')
      expect(deps.watcher.pollSession).toHaveBeenCalledWith('s1')
      expect(deps.captureTerminal).toHaveBeenCalledWith('a1', 80)
      expect(deps.sessionTurnState).toHaveBeenCalledWith('s1')
      expect(deps.openQuestions.has).toHaveBeenCalledWith('s1')
      expect(inspectCloseActivity).toHaveBeenCalledWith(row(), 'screen', false, false)
    })

    it('with no session yet, has no lines to read', async () => {
      const { deps, close } = setup()
      await close.activity(row({ sessionId: '' }))
      expect(deps.watcher.pollSession).not.toHaveBeenCalled()
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
  })
})
