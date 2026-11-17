/**
 * The processes that still name a test's throwaway root, or work in it, once its daemon's process groups are ended, and
 * ending them.
 *
 * Why: the census of 2026-11-14 found 14 fake `codex app-server` pairs and a fake `podman events` outliving the
 * end-to-end tests that started them. The product starts those children in a process group of their own
 * (lib/codexRateLimits.ts, services/agentBrowser/podman.ts), so ending the daemon's groups never reached them, and
 * their parent died before ending them. Every engine, `podman` and `gh` a daemon under test can start lives under its
 * root, a unique `mkdtemp` folder, so a command line that names `<root>/` is that test's and no one else's.
 *
 * And a process started by name in a pane names no root, and a real engine survives its pane's end: the audit of
 * 2026-11-15 found many real `claude`, and some `opencode` and `cursor-agent`, parented to pid 1 with their working
 * folder in a test's root. So a process of this account whose working folder is the root or in it is that test's too.
 * Since that reaches past command lines, the root is first checked to be one a test made, before anything is signalled.
 *
 * A match that leads a process group is ended with its whole group: the fake engine renames its own title, so the
 * fake Codex's child (`node …/fakeEngine.mjs app-server`) never names the root and is reached only through its group.
 * Any other match is ended alone, never its group: a test's own `tmux -S <root>/…` call runs in the Vitest worker's
 * group, and signalling that group would end the test run.
 */
import { spawnSync } from 'node:child_process'
import { lstatSync, readlinkSync, realpathSync, statSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { basename, dirname, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { alive, processTable, type ProcessRow } from './spawnedRuns.js'

export interface RootProcesses {
  /** Process groups to signal whole, each led by a match. */
  groups: number[]
  /** Matches to signal alone. */
  pids: number[]
  /** Every pid those signals reach, once each, in the table's order. */
  all: number[]
}

const notATestRoot = (root: string) => new Error(`not a test root (isolatedTmux's <tmp>/htmux-XXXXXX): ${root}`)

/** Whether [folder] is [root] or in it: `/tmp/htmux-1` never holds `/tmp/htmux-10`. */
const inside = (folder: string, root: string) => folder === root || folder.startsWith(`${root}/`)

const realPath = (path: string): string | null => { try { return realpathSync(path) } catch { return null } }

export interface Places { tmp: string; home: string; checkout: string }

/** Throws unless [root] is a root a test made. [at] is for the spec: os.tmpdir(), the account's home, this file's folder. */
export function assertTestRoot(root: string, at: Places = { tmp: tmpdir(), home: userInfo().homedir, checkout: dirname(fileURLToPath(import.meta.url)) }): void {
  // isolatedTmux's own folder, given as its real path: directly in the real temporary folder, so a folder deeper in a
  // root, or one reached through a link, is none. A temporary folder that cannot be resolved names no root.
  if (!isAbsolute(root) || !/^htmux-./.test(basename(root)) || dirname(root) !== realPath(at.tmp)) throw notATestRoot(root)
  // A link named like a root would have the sweep end every process in the folder it points to. One already removed is
  // still its test's: a second close of the same daemon.
  const stat = lstatSync(root, { throwIfNoEntry: false })
  if (stat && !stat.isDirectory()) throw notATestRoot(root)
  // A root that is or holds the account's home, or this checkout, would end every process working there. `$HOME` is not
  // the account's: Vitest replaces it (vitest.setup.ts).
  for (const folder of [at.home, at.checkout]) if (inside(realPath(folder) ?? folder, root)) throw notATestRoot(root)
}

export interface FolderRow { pid: number; uid: number; folder: string }

/** The rows of `lsof -a -d cwd -F pnu`: `p<pid>` starts a process, `u<uid>` is its account, `n<folder>` its working folder. */
export function lsofFolders(output: string): FolderRow[] {
  const rows: FolderRow[] = []
  let pid: number | undefined
  let uid: number | undefined
  for (const line of output.split('\n')) {
    if (line.startsWith('p')) { pid = Number(line.slice(1)); uid = undefined }
    else if (line.startsWith('u')) uid = Number(line.slice(1))
    else if (line.startsWith('n') && pid !== undefined && uid !== undefined) rows.push({ pid, uid, folder: line.slice(1) })
  }
  return rows
}

/** pid to folder, of the account [uid] alone. */
export function ownFolders(rows: FolderRow[], uid: number): Map<number, string> {
  return new Map(rows.filter((row) => row.uid === uid).map((row) => [row.pid, row.folder]))
}

/**
 * The working folder of each of this account's processes: lsof on macOS, /proc on Linux. Empty, and one line logged,
 * when lsof gives none: the sweep then goes by command line alone, and a teardown never fails on it.
 */
export function workingFolders(table: ProcessRow[], uid: number = process.getuid!()): Map<number, string> {
  if (process.platform === 'linux') {
    const folders = new Map<number, string>()
    for (const { pid } of table) {
      try {
        if (statSync(`/proc/${pid}`).uid === uid) folders.set(pid, readlinkSync(`/proc/${pid}/cwd`))
      } catch { /* gone, or not this account's to read: judged by its command line alone */ }
    }
    return folders
  }
  const lsof = spawnSync('lsof', ['-a', '-d', 'cwd', '-F', 'pnu'], { encoding: 'utf8', timeout: 5_000, maxBuffer: 64 * 1024 * 1024 })
  // lsof exits 1 when some process cannot be read, and what it printed still counts. What it printed before it was cut
  // short (timed out, over the buffer, killed) does not: its last folder could be cut to another root's name.
  if (lsof.error || lsof.status === null || !lsof.stdout) {
    const why = lsof.error?.message ?? (lsof.signal ? `killed by ${lsof.signal}` : `exit ${lsof.status}`)
    console.error(`[e2e sweep] no working folders read (lsof: ${why}): swept by command line alone`)
    return new Map()
  }
  return ownFolders(lsofFolders(lsof.stdout), uid)
}

/**
 * What in [table] names [root], or works in it by [folders] (pid to working folder), seen from the process [self]:
 * itself, its parent and pid 1 are never matched. A process with no folder in [folders] is judged by its command line.
 */
export function rootProcesses(root: string, table: ProcessRow[], self: number = process.pid, folders: ReadonlyMap<number, string> = new Map()): RootProcesses {
  // Only isolatedTmux's own folder, unique to its test. A wrong one (empty, `/`, a TMPDIR) would name other runs'
  // processes or every one on the machine, and their whole groups would be SIGKILLed.
  if (!isAbsolute(root) || !basename(root).startsWith('htmux-')) throw notATestRoot(root)
  const caller = table.find((row) => row.pid === self)
  const spared = new Set([self, caller?.ppid, 1])
  const named = (row: ProcessRow) => {
    const folder = folders.get(row.pid)
    return row.command.includes(`${root}/`) || (folder !== undefined && inside(folder, root))
  }
  const matches = table.filter((row) => named(row) && !spared.has(row.pid))
  // A caller missing from the table leaves its own group unknown: then no group is signalled whole.
  const leads = (row: ProcessRow) => caller !== undefined && row.pid === row.pgid && row.pgid !== caller.pgid
  const groups = matches.filter(leads).map((row) => row.pgid)
  const pids = matches.filter((row) => !leads(row)).map((row) => row.pid)
  const all = table.filter((row) => pids.includes(row.pid) || groups.includes(row.pgid)).map((row) => row.pid)
  return { groups, pids, all }
}

/**
 * SIGKILL every process that names [root] or works in it, once [root] is known to be a test's, and wait, at most [ms],
 * until none of them is alive. Returns those still alive, as `pid <n> <command>`; empty when none is.
 */
export async function endRootProcesses(root: string, ms = 5_000): Promise<string[]> {
  assertTestRoot(root)
  const table = processTable()
  const { groups, pids, all } = rootProcesses(root, table, process.pid, workingFolders(table))
  for (const pgid of groups) { try { process.kill(-pgid, 'SIGKILL') } catch { /* the group is gone */ } }
  for (const pid of pids) { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } }
  // Waited for asynchronously: a child of this process stays a zombie, alive to a signal, until Node's event loop reaps it.
  const deadline = Date.now() + ms
  while (Date.now() < deadline && all.some((pid) => alive(pid))) await new Promise((resolve) => setTimeout(resolve, 50))
  return table.filter((row) => all.includes(row.pid) && alive(row.pid)).map((row) => `pid ${row.pid} ${row.command}`)
}
