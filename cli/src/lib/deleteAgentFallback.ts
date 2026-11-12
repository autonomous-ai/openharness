/** Stop the exact discovered engine process, and every process it started, while leaving the user's tmux pane and shell alive. */

import type { RegisteredSession } from './registry.js'
import { type RuntimeCheck } from './paneEngineProcess.js'
import { processRows } from './processTable.js'
import { type AgentSignal } from './processSignals.js'
import { treeTargets, type TreeProcess } from './processTree.js'
import { sameProcessIdentity } from './terminalRuntime.js'

/** Delete has already removed the UI entry; signal the saved process immediately. */
export const TERMINATE_CHECK_MS = 0
/** After SIGTERM. Matches the daemon's own stop sequence rather than inventing a tighter one. */
export const FALLBACK_KILL_GRACE_MS = 3_000
const POLL_MS = 250

/**
 * Exact PID + start-marker + executable validation — the PID-reuse guard shared by delete and restart.
 * Deliberately PID-only, not pane-based (unlike paneEngineProcess.ts's `checkSessionRuntime`): by the time either
 * caller runs, the pane's UI entry may already be gone (delete) or is about to host a brand-new process
 * on purpose (restart), so nothing here should care whether a `tmux` pane still shows the expected
 * engine — only whether the exact saved process is still the one running.
 */
export async function checkPidRuntime(
  session: Pick<RegisteredSession, 'engine' | 'processIdentity'>,
): Promise<RuntimeCheck> {
  const expected = session.processIdentity
  if (!expected) return { state: 'gone', reason: 'agent has no saved process identity' }
  const rows = await processRows()
  if (!rows) return { state: 'unknown', reason: 'process table is unavailable' }
  const live = rows.find((row) => row.pid === expected.pid)
  return live && sameProcessIdentity(live, expected) && live.executable === expected.executable
    ? { state: 'alive' }
    : { state: 'gone', reason: 'saved process identity is no longer running' }
}

export type TerminateOutcome =
  /** It left before or during signalling. */
  | 'gone'
  /** SIGTERM was enough. */
  | 'terminated'
  /** It ignored SIGTERM and had to be killed. */
  | 'killed'
  /** The pane holds a DIFFERENT process now; signalling it would hit an innocent bystander. */
  | 'not-ours'
  /** We could not signal it (permissions, gone mid-flight). The engine may still be running. */
  | 'failed'

export interface TerminateDeps {
  /** Stop or a newer binding can revoke this operation while native identity is being read. */
  current?: () => boolean
  /** Three-valued exact identity check. Probe failure is not evidence that the process is gone. */
  checkRuntime: (session: RegisteredSession) => Promise<RuntimeCheck>
  /** `process.kill`. Throws on EPERM/ESRCH like the real one. */
  kill: (pid: number, signal: AgentSignal) => void
  sleep: (ms: number) => Promise<void>
  log: (message: string) => void
  /** The engine's descendants, listed once before any signal (processTree.ts); null when they cannot be listed. */
  descendants?: () => Promise<TreeProcess[] | null>
  /** Which of [tree] still run as the same process; null when that cannot be read. */
  survivors?: (tree: readonly TreeProcess[]) => Promise<TreeProcess[] | null>
}

/**
 * Validate the saved PID/start marker, then stop the engine if it is still there, and its tree with it. Never throws.
 *
 * Failures are logged loudly on purpose: by the time this runs the UI already says the agent is gone, so
 * a silently-swallowed EPERM would leave a running engine that nothing on screen accounts for.
 */
export async function terminateDeletedAgent(
  session: RegisteredSession,
  deps: TerminateDeps,
  checkAfterMs = TERMINATE_CHECK_MS,
  killGraceMs = FALLBACK_KILL_GRACE_MS,
): Promise<TerminateOutcome> {
  await deps.sleep(checkAfterMs)
  if (deps.current?.() === false) return 'not-ours'

  const check = async (): Promise<RuntimeCheck> => {
    try { return await deps.checkRuntime(session) }
    catch (err) { return { state: 'unknown', reason: err instanceof Error ? err.message : String(err) } }
  }
  // PID + start marker validation is what prevents a recycled PID from receiving our signal. Unknown
  // means we cannot prove the target and must leave the runtime suppressed rather than call it gone.
  const initial = await check()
  if (deps.current?.() === false) return 'not-ours'
  if (initial.state === 'gone') return 'gone'
  if (initial.state === 'unknown') {
    deps.log(`[delete] could not validate ${session.engine} runtime: ${initial.reason}`)
    return 'failed'
  }

  const pid = session.processIdentity?.pid
  if (!pid) return 'not-ours'

  // A table that cannot be read is said, and its processes left alone: it proves neither that one left nor which
  // process holds a number now.
  const listed = async (read: () => Promise<TreeProcess[] | null>): Promise<TreeProcess[]> => {
    const found = await read().catch(() => null)
    if (!found) deps.log(`[delete] could not list ${session.engine}'s processes`)
    return found ?? []
  }
  const { descendants, survivors: survivorsOf } = deps
  const left = async (members: readonly TreeProcess[]): Promise<TreeProcess[]> =>
    members.length && survivorsOf ? listed(() => survivorsOf(members)) : []
  // Listed before the first signal: once the engine dies its children re-parent away, out of reach.
  const tree = descendants ? await listed(descendants) : []
  if (deps.current?.() === false) return 'not-ours'

  const signal = (target: number, sig: AgentSignal): boolean => {
    if (deps.current?.() === false) return false
    try { deps.kill(target, sig); return true } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code
      // ESRCH = it exited between the check and the signal. Anything else (EPERM…) is a real failure to
      // enforce the delete, and the person who pressed delete has already been told it worked.
      if (code !== 'ESRCH') {
        deps.log(`[delete] could not ${sig} ${session.engine} pid ${target}: ${err instanceof Error ? err.message : String(err)}`)
      }
      return false
    }
  }

  /** The engine outlived its grace. */
  const escalate = async (): Promise<TerminateOutcome> => {
    // Revalidate at the escalation boundary. A process-table timeout or PID replacement after SIGTERM is
    // not permission to send SIGKILL to the saved number.
    const beforeKill = await check()
    if (deps.current?.() === false) return 'not-ours'
    if (beforeKill.state === 'gone') return 'terminated'
    if (beforeKill.state === 'unknown') {
      deps.log(`[delete] could not revalidate ${session.engine} before SIGKILL: ${beforeKill.reason}`)
      return 'failed'
    }
    deps.log(`[delete] ${session.engine} ignored SIGTERM — SIGKILL pid ${pid}`)
    if (!signal(pid, 'SIGKILL')) return (await check()).state === 'gone' ? 'gone' : 'failed'
    await deps.sleep(POLL_MS)
    if ((await check()).state !== 'gone') {
      deps.log(`[delete] ${session.engine} pid ${pid} is STILL running after SIGKILL`)
      return 'failed'
    }
    return 'killed'
  }

  deps.log(`[delete] ${session.engine} did not exit on request — SIGTERM pid ${pid}`)
  const engineSignalled = signal(pid, 'SIGTERM')
  // The engine's own group is never signalled whole (the pane's shell may lead it): its members in the tree go by pid.
  const { groups, pids } = treeTargets(tree)
  for (const group of groups) signal(-group, 'SIGTERM')
  for (const member of pids) signal(member, 'SIGTERM')
  if (!engineSignalled) return (await check()).state === 'gone' ? 'gone' : 'failed'

  let waited = 0
  let engineGone = false
  while (!engineGone && waited < killGraceMs) {
    await deps.sleep(POLL_MS)
    waited += POLL_MS
    const current = await check()
    if (deps.current?.() === false) return 'not-ours'
    engineGone = current.state === 'gone'
  }
  const survivors = await left(tree)
  if (engineGone && !survivors.length) return 'terminated'
  // What outlived the engine has the rest of the grace, counted from the SIGTERM, as the engine had.
  if (engineGone) await deps.sleep(Math.max(0, killGraceMs - waited))
  // By pid, each checked by its start: a group's leader may have left and its number gone to another process.
  for (const member of survivors) signal(member.pid, 'SIGKILL')

  const outcome = engineGone ? 'terminated' : await escalate()
  if (!survivors.length || outcome === 'not-ours' || outcome === 'failed') return outcome
  await deps.sleep(POLL_MS)
  const still = await left(survivors)
  for (const member of still) deps.log(`[delete] ${session.engine} pid ${member.pid} is STILL running after SIGKILL`)
  return still.length ? 'failed' : outcome
}
