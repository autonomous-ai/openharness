/**
 * An engine's descendants, so a stop ends every process the engine started. A tool the engine spawns `detached`
 * (OpenClaw on POSIX) leaves its process group and session: neither the engine's own signal nor the pane's hangup
 * reaches it, and it kept running after its harness closed (#4173).
 */

import { execFile } from 'node:child_process'
import { psEnv } from './childLocale.js'
import { patientExec } from './patientExec.js'
import { processStartTicks } from './processLiveness.js'
import { codexSharedServerProcess, hermesGatewayProcess, liveProcessRows, parseProcessRow, withStartTicks, type ProcessRow } from './processTable.js'
import { sameProcessIdentity } from './terminalRuntime.js'
import type { ProcessIdentity } from './terminalTypes.js'

/** The most processes one stop lists: a fork bomb under an engine must not hold the stop or its memory. */
export const TREE_LIMIT = 1024

export interface TreeProcess {
  pid: number
  /** Its process group: a group one of the tree leads is signalled whole. */
  pgid: number
  startMarker: string
  /** Linux: when it started, in ticks since boot, which a clock step does not move (`ProcessIdentity.startTicks`). */
  startTicks?: number
}

type TicksOf = (pid: number) => number | null

// A held event loop must not turn the timeout into an empty table (patientExec.ts).
const run = patientExec(execFile)

/** One read of the process table; null when `ps` failed. */
function readTable(): Promise<string | null> {
  return new Promise((resolve) => {
    run('ps', ['-axo', 'pid=,ppid=,pgid=,lstart=,args='], { timeout: 3000, env: psEnv() }, (err, stdout) => resolve(err ? null : stdout))
  })
}

/**
 * The running processes, parsed by the table's own parser so their starts compare with a saved engine's: on Linux by
 * their start ticks, as `processRows` reads them, since a device that steps its clock after boot moves every `lstart`.
 * `pgid` stands where it reads the command name. Null for a table with nobody in it: `ps` lists itself at the least.
 */
function runningRows(table: string | null, platform: NodeJS.Platform, ticksOf: TicksOf): ProcessRow[] | null {
  const rows = (table ?? '').split('\n').flatMap((line) => parseProcessRow(line) ?? [])
  return rows.length ? withStartTicks(liveProcessRows(rows), ticksOf, platform) : null
}

/**
 * Every process below [engine], from one read, before anything is signalled: once the engine dies its children
 * re-parent away and nothing links them to it. `[]` for an engine no longer running; null when the table cannot be read.
 */
export async function engineDescendants(
  engine: ProcessIdentity,
  platform: NodeJS.Platform = process.platform,
  read: () => Promise<string | null> = readTable,
  ticksOf: TicksOf = processStartTicks,
): Promise<TreeProcess[] | null> {
  // Windows has no detached tree to chase: the pty host's kill ends the pane's whole process group (a Job object), and
  // a hidden run is ended with its tree.
  if (platform === 'win32') return []
  const rows = runningRows(await read(), platform, ticksOf)
  if (!rows) return null
  const root = rows.find((row) => sameProcessIdentity(row, engine))
  if (!root) return []
  const children = new Map<number, ProcessRow[]>()
  for (const row of rows) {
    const siblings = children.get(row.parentPid)
    if (siblings) siblings.push(row)
    else children.set(row.parentPid, [row])
  }
  const tree: TreeProcess[] = []
  const queue = [...children.get(root.pid) ?? []]
  // Pids are reused, so a table can name the engine's own descendant as its parent: the walk then listed the engine
  // as its own tree to stop, and the same processes again up to the limit (#4268). The engine is never in its tree.
  const seen = new Set([root.pid])
  for (let next = 0; next < queue.length && tree.length < TREE_LIMIT; next++) {
    const row = queue[next]!
    if (seen.has(row.pid)) continue
    seen.add(row.pid)
    // Hermes' gateway and Codex's shared app server serve every session of their engine from under whichever pane
    // started them: neither they nor what they run are this engine's to stop.
    if (hermesGatewayProcess(row) || codexSharedServerProcess(row)) continue
    tree.push({ pid: row.pid, pgid: Number(row.executable), startMarker: row.startMarker,
      ...(row.startTicks !== undefined ? { startTicks: row.startTicks } : {}) })
    for (const child of children.get(row.pid) ?? []) queue.push(child)
  }
  return tree
}

/**
 * What to signal: each group one of the tree leads, whole, and every other member by pid. A group led from outside the
 * tree, the engine's own or the pane shell's, is never signalled whole: the shell is in it.
 */
export function treeTargets(tree: readonly TreeProcess[]): { groups: number[]; pids: number[] } {
  const groups = tree.filter((member) => member.pid === member.pgid).map((member) => member.pgid)
  const led = new Set(groups)
  return { groups, pids: tree.filter((member) => !led.has(member.pgid)).map((member) => member.pid) }
}

/** The members of [tree] still running as the same process (pid and start); a zombie is gone. Null for no table. */
export async function treeSurvivors(
  tree: readonly TreeProcess[],
  read: () => Promise<string | null> = readTable,
  platform: NodeJS.Platform = process.platform,
  ticksOf: TicksOf = processStartTicks,
): Promise<TreeProcess[] | null> {
  const rows = runningRows(await read(), platform, ticksOf)
  if (!rows) return null
  const running = new Map(rows.map((row) => [row.pid, row]))
  return tree.filter((member) => sameProcessIdentity(running.get(member.pid), member))
}
