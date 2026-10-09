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
import { statSync } from 'node:fs'
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
  forgetRelaunch?(sessionId: string): void
  detachDsh(agentId: string): void
  syncRecapPool(): void
  warn(message: string, error: unknown): void
  /** Injected for tests; Date.now otherwise. */
  now?: () => number
  /** Whether the engine wrote any conversation; the transcript on disk otherwise. */
  hadConversation?: (entry: RegisteredSession) => boolean
}

/** Engines that write a transcript file once a conversation starts, so no file means none started. */
const KEEPS_TRANSCRIPT = new Set(['claude', 'codex'])

function wroteTranscript(entry: RegisteredSession): boolean {
  // An engine that keeps no transcript file (OpenCode, the default) cannot show it wrote nothing,
  // so its exit is an ending as before, not a failed start. Claude Code and Codex do keep one, and
  // one that failed before writing it has no path at all: Claude Code that could not reach Anthropic
  // right after Harness installed it closed its pane and tab with no message (fresh macOS VM,
  // 2026-10-08, after #1047's handover, which this case slipped past).
  if (!entry.transcriptPath) return !KEEPS_TRANSCRIPT.has(entry.engine)
  try { return statSync(entry.transcriptPath).size > 0 } catch { return false }
}

/** How soon after it appeared an engine's exit counts as a failed start rather than an ending. */
export const EARLY_EXIT_MS = 2 * 60_000

export function createRetainExitedSession(deps: RetainExitedSessionDeps) {
  /** Retain the conversation's identity; a surviving shell gets its own live identity. */
  return (entry: RegisteredSession, paneAlive: boolean): void => {
    deps.stoppedAgents.save(entry)
    const saved = deps.stoppedAgents.get(entry.agentId)!
    deps.invalidateTerminalControl(entry.agentId)
    deps.forgetInput(entry.agentId)
    deps.forgetRelaunch?.(entry.sessionId)
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
    //
    // An engine that exits soon after it was started names the shell that keeps its pane as
    // `successor`, so a window moves its tiles there instead of closing them: the engine's last
    // screen is the only place that says why it stopped. A first Claude Code harness that could not
    // reach Anthropic closed its only pane and left a new user on an empty box with no message (fresh
    // macOS VM, 2026-10-08). Any later exit (`/exit`, Ctrl-C after work) still closes its views as
    // above. The shell is released first (synchronous), so the frame still goes out before anything
    // awaited.
    const terminal = paneAlive ? deps.registry.releaseEngine(entry.agentId, true) : null
    // A failed start: soon after it appeared, and before it wrote any conversation. Time alone
    // also caught a person who ran one quick task and typed /exit (review of #1047).
    const early = (deps.now?.() ?? Date.now()) - entry.registeredAt < EARLY_EXIT_MS
      && !(deps.hadConversation ?? wroteTranscript)(entry)
    deps.send({ type: 'agent_deleted', payload: { agentId: entry.agentId, retained: true, ...(terminal && early ? { successor: terminal.agentId } : {}) } })
    if (!paneAlive) deps.registry.removeAgent(entry.agentId)
    deps.syncRecapPool()
    void deps.publishStoppedAgent(saved).catch(error => deps.warn('[resume] could not announce saved harness', error))
    if (terminal) deps.announceSession(terminal)
  }
}
