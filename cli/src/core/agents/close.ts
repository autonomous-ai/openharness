/**
 * Closing agents that no window shows: the close service (now, once idle, after the task) and the
 * cleanup preview that lists what a close would take, each with what it is doing right now.
 *
 * Moved verbatim out of `runForeground` (the core boundary, step 11: docs/design/2026-10-03-harnessd.md).
 */
import { CloseAgentService, inspectCloseActivity, type CloseAgentServiceDeps, type CloseMode } from '../../lib/closeAgentService.js'
import type { OpenTabProtection } from '../../lib/openTabProtection.js'
import { projectDisplayName, type registry } from '../../lib/registry.js'
import type { SessionCheckpointStore } from '../../lib/sessionCheckpoint.js'
import type { TerminalBackendCoordinator } from '../../lib/terminalBackendCoordinator.js'
import type { Watcher } from '../../watcher/watcher.js'

export interface ClosingDeps {
  registry: typeof registry
  cleanupTabs: Pick<OpenTabProtection, 'refresh' | 'isHidden' | 'assertHidden'>
  watcher: Pick<Watcher, 'pollSession'>
  captureTerminal: (target: string, historyLines?: number) => Promise<string | null>
  sessionTurnState: (sessionId: string) => boolean | undefined
  /** What is still being asked, by session. */
  openQuestions: { has(sessionId: string): boolean }
  terminals: Pick<TerminalBackendCoordinator, 'captureRetained'>
  sessionCheckpoints: Pick<SessionCheckpointStore, 'save'>
  stopAgent: CloseAgentServiceDeps['stop']
  announceSession: CloseAgentServiceDeps['changed']
}

export function createAgentClosing({
  registry, cleanupTabs, watcher, captureTerminal, sessionTurnState, openQuestions, terminals, sessionCheckpoints,
  stopAgent, announceSession,
}: ClosingDeps) {
  const closeAgentService = new CloseAgentService({
    registry,
    openTabs: cleanupTabs,
    activity: async s => {
      if (s.sessionId) await watcher.pollSession(s.sessionId)
      const screen = await captureTerminal(s.agentId, 80)
      return inspectCloseActivity(s, screen, sessionTurnState(s.sessionId), openQuestions.has(s.sessionId))
    },
    checkpoint: async (s, phase) => {
      const captured = phase === 'before' ? await terminals.captureRetained(s, { historyLines: 2000 }) : null
      await sessionCheckpoints.save(s, { screen: captured?.state === 'succeeded' ? captured.value : null })
    },
    stop: stopAgent,
    changed: announceSession,
  })
  const cleanupPreview = async (): Promise<Record<string, unknown>> => {
    await cleanupTabs.refresh()
    const sessions = registry.advertised()
    const agents = []
    for (const s of sessions) {
      if (!cleanupTabs.isHidden(s)) continue
      const target = { agentId: s.agentId, sessionId: s.sessionId, createdAt: new Date(s.registeredAt).toISOString() }
      const inspected = await closeAgentService.request({ ...target, mode: 'inspect' })
      if (inspected.error) continue // A changing session is never added to a reviewed batch.
      agents.push({ ...target, name: projectDisplayName(s), engine: s.engine, activity: inspected.activity ?? 'unknown' })
    }
    return { version: 1, agents, kept: sessions.length - agents.length }
  }
  return { closeAgentService, cleanupPreview }
}

/**
 * Answers `agents_cleanup_preview`, which agents no window shows and what each is doing, for the person
 * to review before closing them; and `agent_close`, a close now, once idle or after the task. Both are
 * detached: the preview reads every hidden agent's screen, and saving and exiting take seconds.
 *
 * Moved verbatim out of the socket's request switch (docs/design/2026-10-03-harnessd.md).
 */
export function createCloseRequests({ cleanupPreview, closeAgentService }: {
  cleanupPreview: () => Promise<Record<string, unknown>>
  /** The close service, once it exists: the socket disposes of it when it stops. */
  closeAgentService: () => Pick<CloseAgentService, 'request'> | null
}) {
  const preview = (reply: (result: Record<string, unknown>) => void): void => {
    void cleanupPreview().then(result => reply(result), error => reply({
      error: error?.code ?? 'TABS_UNAVAILABLE', detail: error instanceof Error ? error.message : 'Could not check open tabs.',
    }))
  }
  const close = (payload: Record<string, unknown>, reply: (result: Record<string, unknown>) => void): void => {
    const service = closeAgentService()
    if (!service) { reply({ error: 'UNSUPPORTED' }); return }
    const { agentId, sessionId, createdAt, mode } = payload
    if (typeof agentId !== 'string' || typeof sessionId !== 'string' || typeof createdAt !== 'string'
      || typeof mode !== 'string' || !['inspect', 'idle', 'now', 'after_task', 'cancel'].includes(mode)) {
      reply({ error: 'INVALID_CLOSE_REQUEST' }); return
    }
    // Saving/exit may take seconds; terminal input and unrelated agents keep flowing.
    void service.request({ agentId, sessionId, createdAt, mode: mode as CloseMode,
      ...(payload.onlyIfHidden === true ? { onlyIfHidden: true } : {}) })
      .then(result => reply(result), () => reply({ error: 'CLOSE_FAILED' }))
  }
  return { preview, close }
}
