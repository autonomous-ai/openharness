/**
 * An engine that is no longer running, retained rather than lost.
 *
 * Reached from every place the daemon learns an engine process ended without anybody asking it to —
 * the reconciler finding its pane empty, a restore or a create watcher meeting a pane whose engine
 * exited, a resume that never came up — and it always does the same three things: save the
 * conversation so it can be opened again, END THE IDENTITY THAT WAS RUNNING IT, and, when the tmux
 * pane outlived the engine, keep that shell alive under an identity of its own.
 *
 * Extracted from cli.ts for the same reason as stopAgentService and restoreAgents: the ORDER of those
 * steps is the part worth testing — the archive must exist before a client is told to look for it,
 * and the ending must reach the client before the frame that is behind a filesystem await.
 */
import type { RegisteredSession } from './registry.js'

export interface RetainExitedSessionDeps {
  stoppedAgents: {
    save(session: RegisteredSession): void
    get(agentId: string): RegisteredSession | null
  }
  registry: {
    releaseEngine(agentId: string, separateShell?: boolean): RegisteredSession | null
    removeAgent(agentId: string): boolean
  }
  /** Web and desktop: `agent_deleted` closes this identity's views, `agent_synced` carries frames. */
  send(frame: { type: string; payload: Record<string, unknown> }): void
  /** The archive, announced to every client that lists saved harnesses (and removed from the dial). */
  publishStoppedAgent(saved: RegisteredSession): Promise<void>
  announceSession(session: RegisteredSession): void
  invalidateTerminalControl(agentId: string): void
  forgetInput(agentId: string): void
  detachDsh(agentId: string): void
  syncRecapPool(): void
  warn(message: string, error: unknown): void
}

export function createRetainExitedSession(deps: RetainExitedSessionDeps) {
  /** Retain the conversation's identity; a surviving shell gets its own live identity. */
  return (entry: RegisteredSession, paneAlive: boolean): void => {
    deps.stoppedAgents.save(entry)
    const saved = deps.stoppedAgents.get(entry.agentId)!
    deps.invalidateTerminalControl(entry.agentId)
    deps.forgetInput(entry.agentId)
    deps.detachDsh(entry.agentId)
    // CLOSE THE VIEWS OF THE AGENT THAT JUST ENDED, the way a stop does.
    //
    // This identity has no runtime left: a surviving shell continues under a new one, and the
    // conversation is now an archive to be opened. The `agent_synced` below says so, but a client
    // treats that as a snapshot rather than a deletion — it cannot tell a real ending from the brief
    // gap a process replacement leaves — so a tile left on this id sat on "terminal unavailable" with
    // nothing to press, the shell it had been watching alive and typeable one identity away (#262).
    // `retained` means here what it means in `forgetSession`: the row is archived, not gone, so the
    // client re-reads its inventory and finds it among the saved harnesses. Sent BEFORE the archive
    // frame, which is behind an await, so the view closes at once rather than a filesystem turn later.
    deps.send({ type: 'agent_deleted', payload: { agentId: entry.agentId, retained: true } })
    const terminal = paneAlive ? deps.registry.releaseEngine(entry.agentId, true) : null
    if (!paneAlive) deps.registry.removeAgent(entry.agentId)
    deps.syncRecapPool()
    void deps.publishStoppedAgent(saved).catch(error => deps.warn('[resume] could not announce saved harness', error))
    if (terminal) deps.announceSession(terminal)
  }
}
