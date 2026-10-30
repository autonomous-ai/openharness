/**
 * Ending a process and everything it started, on Windows, with TerminateProcess: the agent signaller's
 * (ptyHostBackend.ts `signalProcess`), whose caller (`terminateDeletedAgent`, a restart or a swap) has just
 * checked the root's identity itself.
 *
 * Not `taskkill /T /F`, which this replaced (ruling of 2026-10-16). On Windows 11, `taskkill` refused a standard
 * user in an SSH session (a network logon) with `ERROR: Access denied`, even for a process that user had just
 * started, while `Stop-Process` (TerminateProcess) ended it: taskkill asks WMI, which turns down a non-admin
 * network-logon token (task-B3.21 finding F1). A daemon a standard user starts over SSH — a remote machine, the
 * box, our own end-to-end runs — could then end no agent.
 *
 * The tree is read once from the pty host's process table (windows/processTable.ts), whose rows have parent pids
 * and start markers. Windows reuses pids, and a process keeps its parent's pid after that parent exits, so a
 * parent pid alone can name an unrelated, newer process: a child is taken only when it started no earlier than its
 * parent did. A marker there is `w:<creation time>` (pty/src/ps.rs: GetProcessTimes' FILETIME, 100 ns since 1601,
 * as a decimal), read here as a bigint, since a FILETIME is past 2^53. A child, or a parent, whose marker is not
 * one cannot be ordered, and is left out: ending too little is the safe side.
 */
import type { PtyHostClient } from '../ptyHost/client.js'
import type { ProcessRow } from '../processTable.js'
import { windowsProcessRows } from './processTable.js'

/** What became of a request: `sent` (the root was ended), `gone` (nothing to end), `failed` (it may still run). */
export type TreeKillOutcome = 'sent' | 'gone' | 'failed'

export interface TreeKillDeps {
  /** The process table, read once; null when it could not be read. */
  rows(): Promise<ProcessRow[] | null>
  /** End [pid] at once (TerminateProcess). Throws, with `code` ESRCH, for a process that is not there. */
  kill(pid: number): void
  /** This process: never ended. */
  self: number
}

/** How many generations below the root are ended: an agent's tree is a few deep, a cycle in the links is not. */
export const TREE_MAX_DEPTH = 32
/** And how many processes under it at most. */
export const TREE_MAX_PROCESSES = 1024

/** A Windows start marker's creation time (`w:<FILETIME>`), or null for a marker that is not one. */
export function windowsStartTime(marker: string): bigint | null {
  const match = /^w:(\d{1,20})$/.exec(marker)
  return match ? BigInt(match[1]!) : null
}

const usablePid = (pid: number, self: number): boolean => Number.isSafeInteger(pid) && pid > 0 && pid !== self

/** [root]'s descendants in [rows], a generation to an array, nearest first. */
function generations(root: number, rows: readonly ProcessRow[], self: number): ProcessRow[][] {
  const rootRow = rows.find((row) => row.pid === root)
  if (!rootRow) return []
  const children = new Map<number, ProcessRow[]>()
  for (const row of rows) {
    const siblings = children.get(row.parentPid)
    if (siblings) siblings.push(row)
    else children.set(row.parentPid, [row])
  }
  const seen = new Set<number>([root])
  const found: ProcessRow[][] = []
  let count = 0
  let parents = [rootRow]
  while (parents.length && found.length < TREE_MAX_DEPTH && count < TREE_MAX_PROCESSES) {
    const next: ProcessRow[] = []
    for (const parent of parents) {
      const started = windowsStartTime(parent.startMarker)
      if (started === null) continue
      for (const child of children.get(parent.pid) ?? []) {
        if (count >= TREE_MAX_PROCESSES) break
        if (seen.has(child.pid) || !usablePid(child.pid, self)) continue
        const childStarted = windowsStartTime(child.startMarker)
        // Started before its parent: the parent pid names a process that came after its real parent had exited.
        if (childStarted === null || childStarted < started) continue
        seen.add(child.pid)
        next.push(child)
        count++
      }
    }
    if (next.length) found.push(next)
    parents = next
  }
  return found
}

function isGone(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ESRCH'
}

/**
 * End [pid] and its descendants: the furthest generation first, so no parent outlives its children to start
 * another, then [pid]. A descendant that is gone, or would not end, does not stop the walk (whoever's `kill` it is
 * says so). The outcome is the root's. Without a table, the root alone: better than nothing. Never rejects.
 */
export async function endProcessTree(pid: number, deps: TreeKillDeps): Promise<TreeKillOutcome> {
  // Never this process (that would end the daemon), never a pid that cannot be one.
  if (!usablePid(pid, deps.self)) return 'failed'
  let rows: ProcessRow[] | null
  try {
    rows = await deps.rows()
  } catch {
    rows = null
  }
  const below = rows ? generations(pid, rows, deps.self) : []
  for (const generation of below.reverse()) {
    for (const row of generation) {
      try { deps.kill(row.pid) } catch { /* gone, or refused: the root still goes */ }
    }
  }
  try {
    deps.kill(pid)
    return 'sent'
  } catch (error) {
    return isGone(error) ? 'gone' : 'failed'
  }
}

/** This computer's: the host's table (`harness-pty ps` without a client), and TerminateProcess. */
export function processTreeKillDeps(client: Pick<PtyHostClient, 'call'> | null): TreeKillDeps {
  return {
    rows: () => windowsProcessRows(client),
    // Node's process.kill on Windows is TerminateProcess whatever the signal; ESRCH for a pid that is not there.
    kill: (pid) => { process.kill(pid, 'SIGKILL') },
    self: process.pid,
  }
}
