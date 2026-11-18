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
import type { LaunchPublication, RegisteredSession, RegistryAuthority, registry } from './registry.js'

export interface RetainExitedSessionDeps {
  stoppedAgents: {
    save(session: RegisteredSession, current?: () => boolean): Promise<void>
    get(agentId: string): Promise<RegisteredSession | null>
  }
  registry: Pick<typeof registry, 'confirmEngineExit'>
  /** Web and desktop: `agent_deleted` closes this identity's views, `agent_synced` carries frames. */
  send(frame: { type: string; payload: Record<string, unknown> }): void
  /** The archive, announced to every client that lists saved harnesses (and removed from the dial). */
  publishStoppedAgent(saved: RegisteredSession): Promise<void>
  announceSession(session: RegisteredSession): void
  invalidateTerminalControl(agentId: string): void
  forgetInput(agentId: string): void
  forgetRelaunch?(sessionId: string): void
  /** The agent no longer runs here: its DSH viewer and its browser let go (core/main.ts `agentEnded`). */
  ended(agentId: string): void
  syncRecapPool(): void
  warn(message: string, error: unknown): void
}

export function createRetainExitedSession(deps: RetainExitedSessionDeps) {
  /** Retain the conversation's identity; a surviving shell gets its own live identity. */
  return async (entry: RegisteredSession, paneAlive: boolean, authority: RegistryAuthority = {}): Promise<LaunchPublication> => {
    try {
      await deps.stoppedAgents.save(entry, authority.current)
      const saved = await deps.stoppedAgents.get(entry.agentId)
      if (!saved || authority.current?.() === false) return { state: 'not-published' }
      const publication = await deps.registry.confirmEngineExit(entry.agentId, paneAlive ? 'successor' : 'remove', authority)
      if (publication.state !== 'confirmed' || (paneAlive && !publication.entry)) return publication
      deps.invalidateTerminalControl(entry.agentId)
      deps.forgetInput(entry.agentId)
      deps.forgetRelaunch?.(entry.sessionId)
      deps.ended(entry.agentId)
      // END THE VIEWS OF THE AGENT THAT JUST ENDED: moved to the shell that keeps its pane, or closed,
      // the way a stop closes them, when there is none.
      //
      // This identity has no runtime left: a surviving shell continues under a new one, and the
      // conversation is now an archive to be opened. The `agent_synced` below says so, but a client
      // treats that as a snapshot rather than a deletion — it cannot tell a real ending from the brief
      // gap a process replacement leaves — so a tile left on this id sat on "terminal unavailable" with
      // nothing to press, the shell it had been watching alive and typeable one identity away (#262).
      // `retained` means here what it means in `forgetSession`: the row is archived, not gone, so the
      // client re-reads its inventory and finds it among the saved harnesses. Sent BEFORE the archive
      // frame, which is behind an await, so the view closes at once rather than a filesystem turn later.
      //
      // An engine whose pane outlived it names the shell that keeps that pane as `successor`, so a
      // window moves its tiles there instead of closing them. The pane says so ("This pane is a shell
      // now — run codex again, or stop the pane"), and the person decides: run the engine again, run
      // anything else, or close it. Closing the views of a later exit took the pane away 10–15 s
      // after a Ctrl-C that only meant to stop Codex, the shell still running out of sight (#600).
      // A failed start keeps its last screen, the only place that says why it stopped, the same way
      // (fresh macOS VM, 2026-10-08). A pane that died with its engine has no successor, and its
      // views close as above. The ownership group is durable before this frame goes out.
      const terminal = publication.entry
      deps.send({ type: 'agent_deleted', payload: { agentId: entry.agentId, retained: true, ...(terminal ? { successor: terminal.agentId } : {}) } })
      deps.syncRecapPool()
      void deps.publishStoppedAgent(saved).catch(() => deps.warn('[resume] could not announce saved harness', new Error('archive announcement unavailable')))
      if (terminal) deps.announceSession(terminal)
      return publication
    } catch {
      deps.warn('[resume] engine exit publication failed; the terminal remains held', new Error('registry publication unavailable'))
      return { state: 'not-published' }
    }
  }
}
