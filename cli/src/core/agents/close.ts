import type { ScreenReader } from '../../lib/screenReader.js'
import { IdentityReadUnavailable } from '../../engines/kit/identityScan.js'
/**
 * Closing agents that no window shows: the close service (now, once idle, after the task) and the
 * cleanup preview that lists what a close would take, each with what it is doing right now.
 *
 * Moved verbatim out of `runForeground` (the core boundary, step 11: docs/design/2026-10-03-harnessd.md).
 */
import { CloseAgentService, inspectCloseActivity, type CloseAgentServiceDeps, type CloseMode } from '../../lib/closeAgentService.js'
import type { OpenTabProtection } from '../../lib/openTabProtection.js'
import { sid } from '../../lib/log.js'
import { projectDisplayName, type registry } from '../../lib/registry.js'
import type { SessionCheckpointStore } from '../../lib/sessionCheckpoint.js'
import type { TerminalBackendCoordinator } from '../../lib/terminalBackendCoordinator.js'
import type { Watcher } from '../../watcher/watcher.js'

export interface ClosingDeps {
  readScreen: ScreenReader
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
  /** Once the engine's worker is linked again, or the wait is over (core/engines/engineLinks.ts). */
  engineReady: (engine: string, ms: number) => Promise<void>
}

/** How long a close waits for an engine worker that restarted under its read, before reading once more. */
export const CLOSE_READ_RECONNECT_MS = 10_000

export function createAgentClosing({
  readScreen, registry, cleanupTabs, watcher, captureTerminal, sessionTurnState, openQuestions, terminals, sessionCheckpoints,
  stopAgent, announceSession, engineReady,
}: ClosingDeps) {
  /**
   * Read what the transcript has that the tail has not delivered yet. A close sent just as the engine's worker
   * restarted found its live read refused as stale (seen end to end: ENGINE_STALE_REPLY, the close failed).
   * A read is idempotent: wait for the worker's new link, within the close's own bound, and read once more.
   */
  const drain = async (s: { sessionId: string; engine: string }): Promise<void> => {
    try { await watcher.pollSession(s.sessionId) }
    catch (error) {
      const code = (error as { code?: unknown } | null)?.code
      if (code === 'ENGINE_TRANSCRIPT_CHANGED') throw new IdentityReadUnavailable('the transcript changed while checking activity')
      if (code !== 'ENGINE_STALE_REPLY' && code !== 'ENGINE_UNAVAILABLE') throw error
      console.log(`[close] ${sid(s.sessionId)} its ${s.engine} worker was replaced under the read (${code}); reading again once it is back`)
      await engineReady(s.engine, CLOSE_READ_RECONNECT_MS)
      try { await watcher.pollSession(s.sessionId) } catch (error) {
        const code = (error as { code?: unknown } | null)?.code
        if (code === 'ENGINE_STALE_REPLY' || code === 'ENGINE_UNAVAILABLE' || code === 'ENGINE_TRANSCRIPT_CHANGED') {
          throw new IdentityReadUnavailable('the current conversation could not be read completely')
        }
        throw error
      }
    }
  }
  const closeAgentService = new CloseAgentService({
    registry,
    openTabs: cleanupTabs,
    activity: async s => {
      if (s.sessionId) await drain(s)
      const screen = await captureTerminal(s.agentId, 80)
      return inspectCloseActivity(s, await readScreen(s, screen), sessionTurnState(s.sessionId), openQuestions.has(s.sessionId))
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
