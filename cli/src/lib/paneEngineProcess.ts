/**
 * Which process in a pane is the engine — asked of whichever terminal backend holds the pane. The backend
 * answers only for the pane's own root process; the walk below it is the process table's (processTable.ts).
 */
import type { AgentEngine } from '../engines/types.js'
import { registry, type ProcessIdentity, type RegisteredSession } from './registry.js'
import { comparableStartMarker, enrichProcessRows, processRows, processTreePids, selectEngineProcess } from './processTable.js'
import type { TerminalBackend } from './terminalBackend.js'
import { processIdentityOf, sameProcessIdentity, terminalRuntimeLabel } from './terminalRuntime.js'
import type { TerminalRuntimeRef } from './terminalTypes.js'

/** What the lookups below need of a backend: the pane's own root process. */
type PaneRootSource = Pick<TerminalBackend, 'rootProcess'>

/**
 * Resolve the stable CLI process below one tmux pane, ahead of short-lived helper descendants — and say
 * whether a negative answer means "nothing is running there" or "the probe itself failed". Those are not
 * the same fact: `tmux display-message` and `ps` are subprocesses with 2-3s timeouts, and treating a
 * timeout as proof of death evicts a live session.
 */
export type PaneProcessLookup =
  | { ok: true; identity: ProcessIdentity }
  | { ok: false; unknown: boolean; reason: string }

export async function lookupPaneEngineProcess(
  backend: PaneRootSource,
  runtime: TerminalRuntimeRef,
  engine: AgentEngine,
): Promise<PaneProcessLookup> {
  const label = terminalRuntimeLabel(runtime)
  const rootPid = await backend.rootProcess(runtime)
  // tmux saying it has no such pane is an answer: the pane is gone. The reconciler asks exactly when a
  // pane has dropped out of `tmux list-panes`, and reading that as "could not ask" kept an agent whose
  // pane was killed counted as active for good. A failed call is still no evidence either way.
  if (rootPid === 'missing') return { ok: false, unknown: false, reason: `${label} has no pane` }
  if (!rootPid) return { ok: false, unknown: true, reason: `${label} could not be resolved` }
  const rows = await processRows()
  if (!rows) return { ok: false, unknown: true, reason: 'the process table could not be read' }
  const enrichedRows = await enrichProcessRows(rows, processTreePids(rows, [rootPid]))
  const process = selectEngineProcess(enrichedRows, rootPid, engine)
  if (!process) return { ok: false, unknown: false, reason: `no ${engine} process under ${label}` }
  return {
    ok: true,
    identity: processIdentityOf(process),
  }
}

/** Boolean form for callers that only need "is it there". */
export async function resolvePaneEngineProcess(
  backend: PaneRootSource,
  runtime: TerminalRuntimeRef,
  engine: AgentEngine,
): Promise<ProcessIdentity | null> {
  const found = await lookupPaneEngineProcess(backend, runtime, engine)
  return found.ok ? found.identity : null
}

/**
 * The same check, but three-valued and with a reason — the reaper needs both.
 *
 * `unknown` exists because a failed probe is not evidence of death. The reaper already refuses to evict
 * when `tmux list-panes` fails; the per-session probes (`tmux display-message`, `ps`) deserve exactly the
 * same treatment, and did not get it: a live Command Code pane was dropped with "no commandcode process
 * under pane %3" 14s after attaching, while that process was demonstrably running — still alive minutes
 * later, and matched by this very resolver run by hand. The eviction landed 3.6s into a 5s tick, i.e.
 * `ps` had hit its 3s timeout during the load spike of a freshly started daemon warming its pools.
 *
 * The reason string matters just as much. "process for pane %3 gone" read identically whether the user
 * had quit the CLI or the adapter had simply lost sight of it, and telling those apart after the fact
 * means reconstructing a process table that no longer exists.
 */
export type RuntimeCheck =
  | { state: 'alive' }
  | { state: 'gone'; reason: string }
  | { state: 'unknown'; reason: string }

/** [runtime] is one of [session]'s, on [backend]: typed so a tmux backend is never handed another backend's pane. */
export async function checkSessionRuntime<Ref extends TerminalRuntimeRef>(
  backend: Pick<TerminalBackend<Ref>, 'rootProcess'>,
  session: RegisteredSession,
  runtime: NoInfer<Ref>,
): Promise<RuntimeCheck> {
  const found = await lookupPaneEngineProcess(backend, runtime, session.engine)
  if (!found.ok) return { state: found.unknown ? 'unknown' : 'gone', reason: found.reason }
  const live = found.identity
  const saved = session.processIdentity
  // A persisted identity whose startMarker is not a C-locale lstart stamp was written either by the
  // pre-fix parser (see parseProcessRow), with its fields shifted, or by a `ps` that still inherited the
  // user's LC_TIME (see psEnv). Either way it can NEVER match the corrected ones again. Adopt the
  // corrected identity instead of failing: the pane still has a matching engine process, and failing here
  // would drop a live session for good (Command Code, the only engine affected, does not re-register on
  // its Stop hook). One-time, per session.
  // (A Windows marker, `w:<FILETIME>`, is read from the kernel and compares as a C-locale stamp does.)
  if (saved && !comparableStartMarker(saved.startMarker)) {
    registry.updateProcessIdentity(session.sessionId, live)
    return { state: 'alive' }
  }
  // pid + start time IS the identity of a process, and neither can change under it — that is the whole
  // PID-reuse guard. `executable` is argv-derived and therefore mutable (Command Code rewrites its own
  // argv to `⌘ <session title>` and renames the session mid-life), so it is recorded but not compared:
  // comparing it evicted live panes for renaming themselves.
  if (saved && !sameProcessIdentity(saved, live)) {
    return {
      state: 'gone',
      reason: `process changed under ${terminalRuntimeLabel(runtime)}`
        + ` (was pid ${saved.pid} @ ${saved.startMarker}, now pid ${live.pid} @ ${live.startMarker})`,
    }
  }
  if (!saved) registry.updateProcessIdentity(session.sessionId, live)
  return { state: 'alive' }
}
