/**
 * Stop an agent's live engine process and relaunch it in the SAME tmux pane, preserving the pane/agent
 * identity and (best-effort) resuming the same engine conversation.
 *
 * Factored out of cli.ts's `onRestartAgent` the same way deleteAgentFallback.ts factors out delete's
 * kill sequence: a small, dependency-injected core so the kill → respawn → verify → fallback ordering
 * can be exercised without the daemon's registry, tmux, and reconciler wiring. cli.ts owns everything
 * registry-shaped around a call to this function — resolving the session, `agentReconciler.holdRoute` /
 * `releaseRoute`, `registry.updateProcessIdentity`, `clearPaneRemainOnExit`, and `announceSession`.
 */

import type { AgentEngine } from '../engines/types.js'
import type { RegisteredSession, ProcessIdentity } from './registry.js'
import type { TerminateOutcome } from './deleteAgentFallback.js'

export type RestartOutcome =
  | { ok: true; processIdentity: ProcessIdentity; resumed: boolean }
  | { ok: false; detail: string }

export type RestartAgentReply =
  | { ok: true; session: RegisteredSession; resumed: boolean }
  | { ok: false; error: string; detail?: string }

/** One process replacement per agent, even across clients and different receipt
 * IDs. Stop cancels the work before its next process-changing step. */
export class AgentRestartCoordinator {
  private readonly jobs = new Map<string, { operation: string; cancelled: boolean; result: Promise<RestartAgentReply> }>()

  run(agentId: string, restart: (current: () => boolean) => Promise<RestartAgentReply>, operation = 'restart'): Promise<RestartAgentReply> {
    const existing = this.jobs.get(agentId)
    if (existing) return existing.operation === operation ? existing.result
      : Promise.resolve({ ok: false, error: 'AGENT_BUSY', detail: 'Another lifecycle operation is changing this harness.' })
    const job = { operation, cancelled: false, result: null! as Promise<RestartAgentReply> }
    const current = () => !job.cancelled && this.jobs.get(agentId) === job
    job.result = Promise.resolve().then(async () => {
      if (!current()) return { ok: false, error: 'AGENT_CHANGED' } as const
      const result = await restart(current)
      return current() ? result : { ok: false, error: 'AGENT_CHANGED' } as const
    }).finally(() => {
      if (this.jobs.get(agentId) === job) this.jobs.delete(agentId)
    })
    this.jobs.set(agentId, job)
    return job.result
  }

  busy(agentId: string): boolean { return this.jobs.has(agentId) }

  cancel(agentId: string): void {
    const job = this.jobs.get(agentId)
    if (job) job.cancelled = true
  }
}

export interface RestartAgentDeps {
  /** False after Stop, replacement, or removal. Checked across every await. */
  isCurrent?: () => boolean
  /** Re-arm `remain-on-exit` before anything is killed — see `tmuxBackend.ts`'s `holdOpen`. Without
   *  this, tmux tears the pane (and, being its only pane, the whole session) down the instant the old
   *  process exits. */
  holdOpen: () => Promise<{ ok: boolean; reason?: string }>
  /** Validate + SIGTERM/SIGKILL the saved process. Same contract as `terminateDeletedAgent`. */
  terminate: (checkAfterMs?: number) => Promise<TerminateOutcome>
  /** `tmux respawn-pane` (or equivalent) with a fully-built argv. */
  respawn: (argv: string[]) => Promise<{ ok: boolean; reason?: string }>
  /** Poll the pane for a recognizable engine process, up to an internal budget. Null on timeout. */
  waitForProcess: () => Promise<ProcessIdentity | null>
  /** Prepare persisted history only once the old writer is confirmed stopped. A failure must
   * preserve the conversation, not enter the fresh-session fallback. */
  prepareResume?: () => void | Promise<void>
  buildArgv: (opts: { bypassPermission: boolean; resumeSessionId?: string }) => string[]
  log: (message: string) => void
}

/** Outcomes that mean the old process is confirmed gone — safe to respawn over the pane. `not-ours` and
 *  `failed` are NOT here on purpose: never respawn over a target the kill sequence could not confirm. */
const KILL_CONFIRMED: ReadonlySet<TerminateOutcome> = new Set(['gone', 'terminated', 'killed'])

export async function restartAgent(
  session: { engine: AgentEngine; sessionId: string },
  bypassPermission: boolean,
  deps: RestartAgentDeps,
): Promise<RestartOutcome> {
  const changed = { ok: false, detail: 'the agent changed or stopped during restart' } as const
  const current = () => deps.isCurrent?.() !== false
  if (!current()) return changed
  const armed = await deps.holdOpen()
  if (!current()) return changed
  if (!armed.ok) {
    return { ok: false, detail: armed.reason ?? 'could not re-arm the pane before restart' }
  }

  const outcome = await deps.terminate()
  if (!current()) return changed
  if (!KILL_CONFIRMED.has(outcome)) {
    return { ok: false, detail: `could not confirm the running ${session.engine} process was stopped (${outcome})` }
  }

  const resumeSessionId = session.sessionId || undefined
  if (resumeSessionId && deps.prepareResume) {
    try { await deps.prepareResume() } catch (error) {
      return { ok: false, detail: `could not prepare ${session.engine} session for resume: ${error instanceof Error ? error.message : error}` }
    }
  }
  if (!current()) return changed
  const spawnAndWait = async (withResume: boolean): Promise<ProcessIdentity | null> => {
    if (!current()) return null
    const argv = deps.buildArgv({
      bypassPermission,
      ...(withResume && resumeSessionId ? { resumeSessionId } : {}),
    })
    const spawned = await deps.respawn(argv)
    if (!current()) return null
    if (!spawned.ok) {
      deps.log(`[restart] ${session.engine} respawn-pane failed: ${spawned.reason ?? 'unknown reason'}`)
      return null
    }
    return deps.waitForProcess()
  }

  // Attempt a resume relaunch whenever we have a session id to resume, for every engine — an
  // unconfirmed/wrong flag is not fatal because of the fallback below. Engines with no known launch
  // resume flag never spawn a resume argv in the first place (buildArgv's `resumeSessionId` is a no-op
  // when LAUNCH_RESUME_FLAG has no entry for the engine), so `resumed` still degrades correctly.
  let resumed = !!resumeSessionId
  let identity = await spawnAndWait(resumed)
  if (!current()) return changed
  if (!identity && resumed) {
    // Safe degradation: a working agent with a FRESH session under the same agentId/pane beats a dead
    // pane. Retry once with no resume attempt before giving up entirely.
    deps.log(`[restart] ${session.engine} did not come back up resuming its session — retrying fresh`)
    resumed = false
    identity = await spawnAndWait(false)
  }
  if (!current()) return changed
  if (!identity) {
    return { ok: false, detail: `${session.engine} did not come back up after restart` }
  }
  return { ok: true, processIdentity: identity, resumed }
}
