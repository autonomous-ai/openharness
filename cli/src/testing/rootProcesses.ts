/**
 * The processes of a test's own tree that still name its throwaway root, or work in it, once its daemon's process groups
 * are ended, and ending them.
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
 * And Codex's managed app server detaches itself: a real `codex app-server --managed-daemon` from the tester of #4660 and
 * #4668 outlived `close()`, launchd's, named by no command line or working folder the sweep reads. Codex records it in
 * `<CODEX_HOME>/app-server-daemon/daemon.pid` (engines/codex/launch.ts sharedServer.pidFile). So a process such a file
 * inside the root names is ended too, only while it is this account's, a Codex app server, started after the root was
 * made, and started when the file says (its `processStartTime`): never every app server on the machine (the person's own),
 * nor the worker e2e/harness/sharedCodex.ts names in one, nor a process given a recorded pid since.
 *
 * Only the test's own processes are judged, never the person's beside them on the same computer (PM, 2026-11-23): the
 * tree of the worker and the daemon's tmux server (spawnedRuns.ts processTree), seen by start time before the daemon is
 * stopped (seenNow), since once its master and its tmux server are gone what they started is launchd's. Of the
 * machine's other processes nothing is read but each one's pid, parent and group, and the account, start and command line
 * of a pid a Codex pid file inside the root names. And what the harness itself starts that
 * can leave that tree before anything sees it (the fake iTerm2's server, launchd's from its start or once the fake
 * iTerm2 ends; herdr's server its client started; a fake app's tab) is noted as it starts, by its pid and start time
 * (IsolatedDaemon.own): it and what descends from it are the test's, whatever they name, while it runs as itself.
 *
 * A match that leads a process group is ended with its whole group: the fake engine renames its own title, so the
 * fake Codex's child (`node …/fakeEngine.mjs app-server`) never names the root and is reached only through its group.
 * Any other match is ended alone, never its group: a test's own `tmux -S <root>/…` call runs in the Vitest worker's
 * group, and signalling that group would end the test run. A Codex app server a pid file names that leads a group is
 * ended with it, what it started with it, but never when that group is the test run's own (testRunGroups), and never on
 * Windows.
 */
import { spawnSync } from 'node:child_process'
import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync, type Dirent } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { alive, foregroundGroups, identities, namedTree, processTable, processTree, startTimes, type Identity, type NamedRow,
  type ProcessRow } from './spawnedRuns.js'

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
 * The working folder of each of [pids], processes of the test's own tree, that this account runs: lsof on macOS, /proc
 * on Linux. Empty, and one line logged, when lsof cannot run: the sweep then goes by command line alone, and a teardown
 * never fails on it.
 */
export function workingFolders(pids: readonly number[], uid: number = process.getuid!()): Map<number, string> {
  if (pids.length === 0) return new Map()
  if (process.platform === 'linux') {
    const folders = new Map<number, string>()
    for (const pid of pids) {
      try {
        if (statSync(`/proc/${pid}`).uid === uid) folders.set(pid, readlinkSync(`/proc/${pid}/cwd`))
      } catch { /* gone, or not this account's to read: judged by its command line alone */ }
    }
    return folders
  }
  const lsof = spawnSync('lsof', ['-a', '-d', 'cwd', '-F', 'pnu', '-p', pids.join(',')], { encoding: 'utf8', timeout: 5_000, maxBuffer: 64 * 1024 * 1024 })
  // lsof exits 1 when one of them is gone, and what it printed still counts. What it printed before it was cut short
  // (timed out, over the buffer, killed) does not: its last folder could be cut to another root's name.
  if (lsof.error || lsof.status === null) {
    const why = lsof.error?.message ?? (lsof.signal ? `killed by ${lsof.signal}` : `exit ${lsof.status}`)
    console.error(`[e2e sweep] no working folders read (lsof: ${why}): swept by command line alone`)
    return new Map()
  }
  return ownFolders(lsofFolders(lsof.stdout), uid)
}

/**
 * What in [table], rows of the test's own tree, names [root], or works in it by [folders] (pid to working folder), or is
 * one of [owned] (what descends from what the harness noted it started), seen from the process [self]: itself, its
 * parent and pid 1 are never matched. A process with no folder in [folders] is judged by its command line.
 */
export function rootProcesses(root: string, table: readonly NamedRow[], self: number = process.pid,
  folders: ReadonlyMap<number, string> = new Map(), owned: ReadonlySet<number> = new Set()): RootProcesses {
  // Only isolatedTmux's own folder, unique to its test. A wrong one (empty, `/`, a TMPDIR) would name other runs'
  // processes or every one on the machine, and their whole groups would be SIGKILLed.
  if (!isAbsolute(root) || !basename(root).startsWith('htmux-')) throw notATestRoot(root)
  const caller = table.find((row) => row.pid === self)
  const spared = new Set([self, caller?.ppid, 1])
  const named = (row: NamedRow) => {
    const folder = folders.get(row.pid)
    return row.command.includes(`${root}/`) || (folder !== undefined && inside(folder, root))
  }
  const matches = table.filter((row) => (owned.has(row.pid) || named(row)) && !spared.has(row.pid))
  // A caller missing from the table leaves its own group unknown: then no group is signalled whole.
  const leads = (row: NamedRow) => caller !== undefined && row.pid === row.pgid && row.pgid !== caller.pgid
  const groups = matches.filter(leads).map((row) => row.pgid)
  const pids = matches.filter((row) => !leads(row)).map((row) => row.pid)
  const all = table.filter((row) => pids.includes(row.pid) || groups.includes(row.pgid)).map((row) => row.pid)
  return { groups, pids, all }
}

/** [roots]'s tree now, and what of it names [root] or works in it, or descends from [owned] (rootProcesses), seen from
 *  this process. */
function matched(root: string, roots: Iterable<number>, owned: readonly number[] = []): RootProcesses & { rows: NamedRow[] } {
  const rows = namedTree(roots)
  const theirs = new Set(processTree(rows, owned).map((row) => row.pid))
  return { rows, ...rootProcesses(root, rows, process.pid, workingFolders(rows.map((row) => row.pid)), theirs) }
}

/** The processes of [roots]'s tree under [root] now, each with its command line: what tier B counts as left running. */
export function underRoot(root: string, roots: Iterable<number>): NamedRow[] {
  const { rows, all } = matched(root, roots)
  return rows.filter((row) => all.includes(row.pid))
}

/** Each process [roots]'s tree holds now, by its start time alone: what a sweep after they are ended still knows to be the
 *  test's, whatever its parent is by then. */
export function seenNow(roots: Iterable<number>): Map<number, string> {
  return startTimes(processTree(processTable(), roots).map((row) => row.pid))
}

/** Of what was [seen], or noted as the harness started it (IsolatedDaemon.own), what still runs as the same process: a
 *  pid that started at another time is another's. */
export function stillRunning(seen: ReadonlyMap<number, string>): number[] {
  const now = startTimes([...seen.keys()])
  return [...seen].filter(([pid, started]) => now.get(pid) === started).map(([pid]) => pid)
}

/** How far below a root a Codex home's `app-server-daemon` folder is looked for, and how much of the root is read for it. */
const APP_SERVER_DEPTH = 4, FOLDERS_READ = 2_000, PID_FILES_READ = 16

/** Whether [path] is a pid file of the root's own: a file, not a link to one, nor the second name of one elsewhere (a hard
 *  link), and no larger than the product reads one (lib/harnessResources.ts). */
const ownPidFile = (path: string): boolean => {
  try {
    const stat = lstatSync(path)
    return stat.isFile() && stat.nlink === 1 && stat.size <= 16_384
  } catch { return false }
}

/** What a Codex pid file records of its app server: its pid, and its start as `ps -o lstart=` printed it. */
export interface PidFile { pid: number; started: string }

/** What the JSON in [file] records, while its `pid` is a safe integer over 1 and its `processStartTime` a string, as the
 *  product reads one (core/engines/nativeControls.ts); null for anything else. */
function recorded(file: string): PidFile | null {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8')) as { pid?: unknown; processStartTime?: unknown } | null
    const pid = value?.pid, started = value?.processStartTime
    return Number.isSafeInteger(pid) && (pid as number) > 1 && typeof started === 'string' ? { pid: pid as number, started } : null
  } catch { return null }
}

/**
 * What the Codex homes inside [root] record of their app servers: each `app-server-daemon/daemon.pid`, that folder at
 * most 4 below the root, read breadth first and through no link, soft or hard (one could lead out of the root). At most
 * 2,000 folders and 16 pid files are read; a bound reached is said once.
 */
export function codexPidFiles(root: string): PidFile[] {
  const pids: PidFile[] = []
  const folders: Array<[string, number]> = [[root, 0]]
  let files = 0
  for (let at = 0; at < folders.length; at++) {
    if (at === FOLDERS_READ) {
      console.error(`[e2e sweep] read ${FOLDERS_READ} folders of ${root} for Codex app server pid files: looked no further`)
      break
    }
    const [folder, depth] = folders[at]!
    let entries: Dirent[]
    try { entries = readdirSync(folder, { withFileTypes: true }) } catch { continue /* gone, or not this account's to read */ }
    for (const entry of entries) {
      // readdir's own type: a link is never a folder here.
      if (!entry.isDirectory()) continue
      const path = join(folder, entry.name), file = join(path, 'daemon.pid')
      if (entry.name === 'app-server-daemon' && ownPidFile(file)) {
        if (files++ === PID_FILES_READ) {
          console.error(`[e2e sweep] read ${PID_FILES_READ} Codex app server pid files under ${root}: looked no further`)
          return pids
        }
        const pid = recorded(file)
        if (pid !== null) pids.push(pid)
      }
      if (depth + 1 < APP_SERVER_DEPTH) folders.push([path, depth + 1])
    }
  }
  return pids
}

/** A Codex app server's command line: `codex`, `codex.js` or `codex.exe` run with `app-server` among its arguments. */
const CODEX_APP_SERVER = /(^|[/\\\s])codex(\.js|\.exe)?\s(.*\s)?app-server(\s|$)/

/** A process a Codex pid file names, as one `ps -p` read gives it (spawnedRuns.ts identities), and the start the file
 *  [recorded] for it. */
export interface PidRow extends Identity { recorded: string }

/** Whether two starts `ps -o lstart=` printed are one, however spaced (core/engines/nativeControls.ts reads them so). */
const sameStart = (a: string, b: string): boolean => a.trim().replace(/\s+/g, ' ') === b.trim().replace(/\s+/g, ' ')

/**
 * Of [rows], the processes Codex pid files inside a root made at [made] (ms) name, what is the test's: the account [uid]'s,
 * a Codex app server, started no sooner than the second before [made], and the very process its pid file recorded, by its
 * start: a pid given since to another is not it. `ps` gives a start to the second, and Linux's can name the second before
 * the one the clock was in (spawnedRuns.ts daemonOf).
 */
export function codexDaemons(rows: readonly PidRow[], made: number, uid: number): number[] {
  const since = Math.floor(made / 1_000) * 1_000 - 1_000
  return rows.filter((row) => row.uid === uid && CODEX_APP_SERVER.test(row.command) && Date.parse(row.started) >= since
    && sameStart(row.started, row.recorded)).map((row) => row.pid)
}

/** The Codex app servers pid files inside [root] name that are the test's (codexDaemons): never this process, its parent
 *  or pid 1. None, and one line said, when the root's birth time is unknown. */
function rootCodexDaemons(root: string): Identity[] {
  const spared = new Set([process.pid, process.ppid, 1])
  // Only a pid that runs is asked of: macOS's `ps -p` given one no machine has (100000 or over) prints nothing of any pid
  // asked with it.
  const files = codexPidFiles(root).filter((file) => !spared.has(file.pid) && alive(file.pid))
  if (files.length === 0) return []
  // Any failure to read it (gone, not this account's to read) is no birth time: the rest of the sweep still runs.
  let made = 0
  try { made = statSync(root).birthtimeMs } catch { /* no birth time */ }
  if (!(made > 0)) {
    console.error(`[e2e sweep] no birth time for ${root}: no Codex app server its pid files name is ended`)
    return []
  }
  const running = new Map(identities([...new Set(files.map((file) => file.pid))]).map((row) => [row.pid, row]))
  const rows = files.flatMap((file) => {
    const row = running.get(file.pid)
    return row === undefined ? [] : [{ ...row, recorded: file.started }]
  })
  const theirs = new Set(codexDaemons(rows, made, process.getuid!()))
  return [...running.values()].filter((row) => theirs.has(row.pid))
}

/**
 * The process groups a Codex app server's may never be, seen from this process: its own, its parent's, and the one in the
 * foreground of its terminal (the shell's job running the tests) when it has one. Null when this process or its parent
 * cannot be read: then no group is known to be another's.
 */
function testRunGroups(): Set<number> | null {
  let table: ProcessRow[]
  try { table = processTable() } catch { return null }
  const self = table.find((row) => row.pid === process.pid)
  const parent = self === undefined ? undefined : table.find((row) => row.pid === self.ppid)
  if (self === undefined || parent === undefined) return null
  const foreground = Number(foregroundGroups([self.pid]).get(self.pid))
  return new Set([self.pgid, parent.pgid, ...(foreground > 0 ? [foreground] : [])])
}

/**
 * SIGKILL every process of the test's tree that names [root] or works in it, what descends from what the harness [owned]
 * (IsolatedDaemon.own) whatever it names, and each Codex app server a pid file inside [root] names that is the test's
 * (codexDaemons), with the group it leads unless that is the test run's own, once [root] is known to be a test's, and
 * wait, at most [ms], until none of them is alive: the tree of this worker and of what was [seen] (seenNow) or [owned]
 * that still runs as itself.
 * Returns those still alive, as `pid <n> <command>`; empty when none is.
 */
export async function endRootProcesses(root: string, seen: ReadonlyMap<number, string>, owned: ReadonlyMap<number, string> = new Map(),
  ms = 5_000): Promise<string[]> {
  assertTestRoot(root)
  const mine = stillRunning(owned)
  const { rows, groups, pids, all } = matched(root, [process.pid, ...stillRunning(seen), ...mine], mine)
  const codex = rootCodexDaemons(root).filter((row) => !all.includes(row.pid))
  // Windows' processes have no groups to signal.
  const run = process.platform !== 'win32' && codex.some((row) => row.pgid === row.pid) ? testRunGroups() : null
  const whole = (row: Identity) => run !== null && row.pgid === row.pid && !run.has(row.pgid)
  for (const pgid of groups) { try { process.kill(-pgid, 'SIGKILL') } catch { /* the group is gone */ } }
  for (const pid of pids) { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } }
  for (const row of codex) { try { process.kill(whole(row) ? -row.pid : row.pid, 'SIGKILL') } catch { /* gone */ } }
  const ended = [...rows.filter((row) => all.includes(row.pid)), ...codex]
  // Waited for asynchronously: a child of this process stays a zombie, alive to a signal, until Node's event loop reaps it.
  const deadline = Date.now() + ms
  while (Date.now() < deadline && ended.some((row) => alive(row.pid))) await new Promise((resolve) => setTimeout(resolve, 50))
  return ended.filter((row) => alive(row.pid)).map((row) => `pid ${row.pid} ${row.command}`)
}
