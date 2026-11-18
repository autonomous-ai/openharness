/**
 * Who can still use an old path (docs/plans/2026-11-18-linux-xdg-paths-design.md, The bridge service): the bridge stays
 * while one runs. It reads a process's owner, start time, name, executable and parent, never its environment or command
 * line: every secret a person exports is in those, and no system hands over one part of them.
 */
import { readdirSync, readFileSync, readlinkSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { BridgeRecord } from './bridge.js'

/** `startedAt`: in seconds since the boot. */
export interface ProcRow { pid: number; uid: number; startedAt: number; name: string; exe: string | null; parent: number }

type ProcFs = Pick<typeof import('node:fs'), 'readdirSync' | 'readFileSync' | 'readlinkSync'>

/** /proc/<pid>/stat counts a start time in clock ticks, USER_HZ a second: 100 on every Linux ABI. */
const TICKS_PER_SECOND = 100

/** Every process's row, from /proc/<pid>/status (Uid), /proc/<pid>/stat (comm, ppid, starttime) and the exe link. */
export function procRows(fs: ProcFs = { readdirSync, readFileSync, readlinkSync }): ProcRow[] {
  const rows: ProcRow[] = []
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue
    const folder = join('/proc', name)
    try {
      // The link first: a process that ends after it fails the reads below and is left out whole.
      const exe = linkOrNull(fs, join(folder, 'exe'))
      const uid = Number(/^Uid:\s+(\d+)/m.exec(fs.readFileSync(join(folder, 'status'), 'utf8'))?.[1])
      const stat = fs.readFileSync(join(folder, 'stat'), 'utf8')
      // `pid (comm) S ppid …`: comm may hold spaces and brackets, so it ends at the last `)` and the fields count from there.
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
      rows.push({
        pid: Number(name), uid, startedAt: Number(fields[19]) / TICKS_PER_SECOND,
        name: stat.slice(stat.indexOf('(') + 1, stat.lastIndexOf(')')), exe, parent: Number(fields[1]),
      })
    } catch {
      // It ended mid-read.
    }
  }
  return rows
}

/**
 * What the check knows of this computer. `master`: the daemon's first process, harnessd's master, or the core where it
 * runs alone. `bootId`: this boot's. `roots`: where the old tree's entries moved. `engines`: the names of the engines
 * Harness installs hooks for. `apps`: Desktop's and the Device app's executable names. `panePids`: the processes of the
 * panes the move retagged.
 */
export interface OldUserFacts { uid: number; master: number; bootId: string; roots: readonly string[]; engines: ReadonlySet<string>; apps: ReadonlySet<string>; panePids: readonly number[] }

/**
 * How many of [rows] can still use an old path: this account's processes that started before the move, on the clock of
 * the boot it ran in (in another boot every process started after it), and are an engine
 * by name, run an executable in the old tree or the roots it moved to (the kernel names a moved executable at its new
 * place), are Desktop or the Device app, or are a retagged pane's process or one of its descendants. The daemon's own
 * are not, all of them the master's: the master and its ancestors, as a master that moved re-executed in place, keeping
 * its start time, and runs from the new paths; and its descendants, the core, the services and what they started, which
 * it started from the new paths, some in the move's own second.
 */
export function oldUsers(bridge: BridgeRecord, rows: readonly ProcRow[], facts: OldUserFacts): number {
  // A bridge with no boot was written where /proc has none, as no move is.
  if (bridge.boot?.id !== facts.bootId) return 0
  const movedAt = bridge.boot.uptime
  const parents = new Map(rows.map(({ pid, parent }) => [pid, parent]))
  const own = new Set([...lineage(facts.master, parents), ...descendants(facts.master, rows)])
  const panes = new Set(facts.panePids)
  const trees = [bridge.oldHome, ...facts.roots]
  const old = ({ pid, uid, startedAt, name, exe }: ProcRow): boolean => uid === facts.uid && startedAt <= movedAt && !own.has(pid) && (
    facts.engines.has(name)
    || (exe !== null && (facts.engines.has(basename(exe)) || facts.apps.has(basename(exe)) || trees.some((root) => exe.startsWith(`${root}/`))))
    || lineage(pid, parents).some((at) => panes.has(at)))
  return rows.filter(old).length
}

/** [pid] and its ancestors, by each one's parent, to the first not in [parents]; a loop ends at its first repeat. */
function lineage(pid: number, parents: ReadonlyMap<number, number>): number[] {
  const line: number[] = []
  for (let at: number | undefined = pid; at !== undefined && !line.includes(at); at = parents.get(at)) line.push(at)
  return line
}

/** Every process under [pid], by each one's parent; a loop ends at what was found already. */
function descendants(pid: number, rows: readonly ProcRow[]): Set<number> {
  const children = new Map<number, number[]>()
  for (const row of rows) {
    const siblings = children.get(row.parent)
    if (siblings) siblings.push(row.pid)
    else children.set(row.parent, [row.pid])
  }
  const found = new Set<number>()
  const pending = [pid]
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    for (const child of children.get(at) ?? []) {
      if (child === pid || found.has(child)) continue
      found.add(child)
      pending.push(child)
    }
  }
  return found
}

/** A kernel thread has no executable, and another account's is not this one's to read. */
function linkOrNull(fs: ProcFs, path: string): string | null {
  try {
    return fs.readlinkSync(path)
  } catch {
    return null
  }
}
