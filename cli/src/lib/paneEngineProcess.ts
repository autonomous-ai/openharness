/**
 * Which process in a pane is the engine — asked of whichever terminal backend holds the pane. The backend
 * answers only for the pane's own root process; the walk below it is the process table's (processTable.ts).
 */
import { execFile } from 'node:child_process'
import { psEnv } from './childLocale.js'
import { patientExec } from './patientExec.js'
import { processExists } from './processLiveness.js'
import { agentCommandOwnershipSnapshotAsync, type AgentCommandOwnershipSnapshot } from './engineBin.js'
import { IdentityReadUnavailable } from '../engines/kit/identityScan.js'
import type { AgentEngine } from '../engines/types.js'
import { errorKind } from './log.js'
import { registry, type LaunchPublication, type ProcessIdentity, type RegisteredSession } from './registry.js'
import { REGISTRY_WRITE_DEADLINE_MS } from './registryPersistence.js'
import { comparableStartMarker, enrichProcessRows, processRows, processTreePids, programName, selectEngineProcess, LSTART_MARKER_RE, parseProcessRow, withStartTicks, type ProcessRow } from './processTable.js'
import type { TerminalBackend } from './terminalBackend.js'
import { processIdentityOf, sameProcessIdentity, terminalRuntimeLabel } from './terminalRuntime.js'
import type { TerminalRuntimeRef } from './terminalTypes.js'

/** What the lookups below need of a backend: the pane's own root process, and the table its panes are in when that is
 *  not the machine's own (a guest's host). */
type PaneRootSource = Pick<TerminalBackend, 'rootProcess'> & Pick<Partial<TerminalBackend>, 'processTable'>

/**
 * Resolve the stable CLI process below one tmux pane, ahead of short-lived helper descendants — and say
 * whether a negative answer means "nothing is running there" or "the probe itself failed". Those are not
 * the same fact: `tmux display-message` and `ps` are subprocesses with 2-3s timeouts, and treating a
 * timeout as proof of death evicts a live session.
 */
export type PaneProcessLookup =
  | { ok: true; identity: ProcessIdentity }
  /** [paneProcesses]: every process in the pane, on "no engine under it" only, so a caller can tell whether the
   *  process an agent was bound to still runs there under another name (#4259). */
  | { ok: false; unknown: boolean; reason: string; paneProcesses?: readonly ProcessIdentity[] }

export async function lookupPaneEngineProcess(
  backend: PaneRootSource,
  runtime: TerminalRuntimeRef,
  engine: AgentEngine,
  /** The table to read; the backend's own when it has one (a guest's host), else the machine's. */
  readRows: () => Promise<ProcessRow[] | null> = backend.processTable?.() ?? processRows,
): Promise<PaneProcessLookup> {
  const label = terminalRuntimeLabel(runtime)
  const rootPid = await backend.rootProcess(runtime)
  // tmux saying it has no such pane is an answer: the pane is gone. The reconciler asks exactly when a
  // pane has dropped out of `tmux list-panes`, and reading that as "could not ask" kept an agent whose
  // pane was killed counted as active for good. A failed call is still no evidence either way.
  if (rootPid === 'missing') return { ok: false, unknown: false, reason: `${label} has no pane` }
  if (!rootPid) return { ok: false, unknown: true, reason: `${label} could not be resolved` }
  const rows = await readRows()
  if (!rows) return { ok: false, unknown: true, reason: 'the process table could not be read' }
  const panePids = processTreePids(rows, [rootPid])
  const enrichedRows = await enrichProcessRows(rows, panePids)
  let ownership: AgentCommandOwnershipSnapshot
  try { ownership = await agentCommandOwnershipSnapshotAsync() }
  // The kind only: the snapshot's error can quote a PATH folder, and the reason reaches logs.
  catch (error) { return { ok: false, unknown: true, reason: `ENGINE_LOOKUP_UNAVAILABLE: executable ownership could not be read (${errorKind(error)})` } }
  const process = selectEngineProcess(enrichedRows, rootPid, engine, ownership)
  if (!process) {
    const paneProcesses = enrichedRows.filter((row) => panePids.has(row.pid)).map(processIdentityOf)
    return { ok: false, unknown: false, reason: `no ${engine} process under ${label}`, paneProcesses }
  }
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

const run = patientExec(execFile)

/** Liveness of already identified Unix engines, without reading other processes' rows or any arguments. */
export type EngineLiveness = RuntimeCheck['state']

export function readEngineLiveness(identities: readonly ProcessIdentity[]): Promise<Map<ProcessIdentity, EngineLiveness>> {
  const pids = [...new Set(identities.map(({ pid }) => pid))]
  if (!pids.length) return Promise.resolve(new Map())
  return new Promise((resolve) => {
    run('ps', ['-p', pids.join(','), '-o', 'pid=,ppid=,state=,lstart='], { timeout: 2_000, env: psEnv() }, (err, stdout, stderr) => {
      const result = new Map<ProcessIdentity, EngineLiveness>()
      // Both BSD and procps exit 1, with no output, when no selected PID exists.
      if (stderr.trim() || (err && (err.code !== 1 || stdout.trim()))) { resolve(result); return }
      const rows = stdout.trim() ? stdout.trim().split('\n').map(parseProcessRow) : []
      if (rows.some(row => !row || !LSTART_MARKER_RE.test(row.startMarker))) { resolve(result); return }
      const live = new Map(withStartTicks(rows.filter(row => row !== null)).map(row => [row.pid, row]))
      for (const identity of identities) {
        const row = live.get(identity.pid)
        const state = row?.executable[0]
        result.set(identity, !row ? processExists(identity.pid) ? 'unknown' : 'gone'
          : state === 'Z' || (process.platform === 'linux' && (state === 'X' || state === 'x')) ? 'gone'
          : state === '?' || !LSTART_MARKER_RE.test(identity.startMarker) ? 'unknown'
          : sameProcessIdentity(row, identity) ? 'alive' : 'gone')
      }
      resolve(result)
    })
  })
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

/** What a Node engine runs as until it names itself (`programName` reads `node.exe` as `node`). */
const NODE_RUNTIMES = new Set(['node', 'nodejs'])

/** [observed] is the [recorded] process under the name it gave itself: a Node runtime that is one no longer. */
export function renamedEngine(recorded: ProcessIdentity, observed: ProcessIdentity): boolean {
  return sameProcessIdentity(recorded, observed)
    && NODE_RUNTIMES.has(programName(recorded.executable)) && !NODE_RUNTIMES.has(programName(observed.executable))
}

/** A refresh saw the recorded engine renamed, as [observed]. Should one escape, it reads as the site's changed hold. */
export class EngineRenamed extends IdentityReadUnavailable {
  constructor(readonly observed: ProcessIdentity, reason: string) { super(reason) }
}

/**
 * Publish a relaunched engine through [publish] (the site's own `registry.confirmLaunch`), whose [refresh] [look]s at
 * the pane again; when that look sees the engine renamed, publish it once more under its new name, within the same
 * [expires]. Claude Code installed with npm starts as `node` and sets `process.title`, which on Linux changes `comm`
 * (measured 2026-11-24). A refresh that refused that rename left the row on a dead pid, the restart answered INTERNAL,
 * and discovery made a second agent about 1.5 s later; #4584 covered only a rename between the wait's two looks. The
 * re-write's refresh checks against the new name, which is no Node runtime's, so a second rename is refused.
 */
export async function publishEngine(
  identity: ProcessIdentity,
  look: () => Promise<ProcessIdentity | null>,
  reasons: { gone: string; changed: string },
  publish: (identity: ProcessIdentity, refresh: () => Promise<void>, expires: number) => Promise<LaunchPublication>,
  expires: number = performance.now() + REGISTRY_WRITE_DEADLINE_MS,
): Promise<LaunchPublication> {
  const refresh = (recorded: ProcessIdentity) => async () => {
    const observed = await look()
    if (!observed) throw new IdentityReadUnavailable(reasons.gone)
    if (sameProcessIdentity(recorded, observed) && observed.executable === recorded.executable) return
    if (renamedEngine(recorded, observed)) throw new EngineRenamed(observed, reasons.changed)
    throw new IdentityReadUnavailable(reasons.changed)
  }
  try {
    return await publish(identity, refresh(identity), expires)
  } catch (error) {
    if (!(error instanceof EngineRenamed)) throw error
    return publish(error.observed, refresh(error.observed), expires)
  }
}

/**
 * How long an engine must stay the pane's engine before a launch counts it as come up: a launch the engine
 * refuses (`codex resume` after an update dropped it) runs for an instant. One rule for a restart
 * (`core/agents/swap.ts` `waitForProcess`) and a resume (`resumeStoppedAgent.ts` `waitForResumedAgent`).
 */
export const ENGINE_SETTLE_MS = 500
