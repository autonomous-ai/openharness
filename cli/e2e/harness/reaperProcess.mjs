/**
 * Ends what a test worker started once the worker is gone, however it went (e2e/harness/reaper.ts starts one per worker).
 *
 * Why: two daemons from an end-to-end run were found 1.5 days later on a developer's Mac (2026-11-11). The run's Vitest was
 * killed, so no afterEach ever closed them; their masters, parented to launchd, kept running. One held the real daemon's
 * bridge port, 51793; the other ran `lsof` every 5.5 s, about 7% of a core around the clock. Nothing in a dying worker can
 * be trusted to clean up (a SIGKILL runs no handler), so this process, started in a session of its own, does it: its stdin is
 * a pipe from the worker, and the kernel closes it when the worker exits, by any path. Then every process group the worker
 * still has registered gets SIGTERM, and SIGKILL for whatever is left after the grace; every tmux server it registered is
 * stopped (tmux daemonizes into a session of its own); then, once its throwaway root is known to be a test's, every process
 * of the worker's tree that still names that root or works in it is ended, and each Codex app server a pid file inside the
 * root names that is the test's, and the root is removed, read-only folders and all. The worker's tree is what its
 * groups, its tmux servers and the processes the harness noted it started held when it went, seen by start time before
 * anything is ended: once they are gone, what they started is launchd's. Each process the harness noted
 * (IsolatedDaemon.own), launchd's from the moment the worker went if not before, is ended with what descends from it
 * while it runs as itself, by its start time. Of the machine's other processes nothing is read but each one's pid, parent
 * and group, and the account, start and command line of a pid a Codex pid file inside the root names: the person's own
 * run on the same computer (PM, 2026-11-23).
 *
 * The worker's lines on stdin, one JSON object each: {"group":N} a process group to end, {"leaderGone":N} its leader exited,
 * {"forget":N} it was closed; {"tmux":socket,"root":folder} a tmux server to stop, then what still names its root or works
 * in it to end and the root to remove, {"forgetTmux":socket} they were; {"own":N,"started":lstart} a process the harness
 * started at that time, {"forgetOwn":N} it was closed.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

/** How long a daemon gets to stop on SIGTERM before SIGKILL: as IsolatedDaemon.stop gives it. */
const GRACE_MS = 15_000

/** Process group → whether its leader has exited. */
const groups = new Map()
/** tmux socket → the throwaway root it is in. */
const tmuxServers = new Map()
/** pid of a process the harness started → when it started, as `ps -o lstart=` printed it under C's dates. */
const owned = new Map()
// Its stderr is the dead worker's: with nobody reading it, a write fails with EPIPE, which must not end the reaping.
process.stderr.on('error', () => {})

const exists = (pid) => {
  try { process.kill(pid, 0); return true } catch (error) { return error.code === 'EPERM' }
}
/**
 * Whether group [pgid] still holds this worker's processes. No new process gets a number that names a group with members, so
 * while the group is not empty its number is ours. Once the leader has exited, a process with its pid is a stranger leading a
 * group of its own, and ours is empty: it is left alone.
 */
const ours = (pgid) => {
  try { process.kill(-pgid, 0) } catch (error) { if (error.code !== 'EPERM') return false }
  return !(groups.get(pgid) && exists(pgid))
}
const signal = (pgid, name) => { try { process.kill(-pgid, name) } catch { /* the group emptied meanwhile */ } }
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

/** Whether [folder] is [root] or in it: `/tmp/htmux-1` never holds `/tmp/htmux-10`. */
const inside = (folder, root) => folder === root || folder.startsWith(`${root}/`)
const realPath = (path) => { try { return realpathSync(path) } catch { return null } }

/**
 * Whether [root] is one a test made, as src/testing/rootProcesses.ts's assertTestRoot holds. The sweep ends every process
 * that names it or works in it, group and all, and the root is made writable and removed, so a wrong one (empty, `/`, a
 * TMPDIR) would reach every process and folder there. Only isolatedTmux's own folder, given as its real path: directly in
 * the real temporary folder, so a folder deeper in a root, or one reached through a link, is none; not itself a link, which
 * would have the sweep end every process in the folder it points to (one already removed passes); neither the account's
 * home nor what holds it, nor what holds this checkout. A check that cannot be made refuses, as the throw does there.
 */
function isTestRoot(root) {
  try {
    if (typeof root !== 'string' || !isAbsolute(root) || !/^htmux-./.test(basename(root)) || dirname(root) !== realPath(tmpdir())) return false
    const stat = lstatSync(root, { throwIfNoEntry: false })
    if (stat && !stat.isDirectory()) return false
    // The account's home, not `$HOME`, which a test worker may have replaced (vitest.setup.ts).
    return ![userInfo().homedir, dirname(fileURLToPath(import.meta.url))].some((folder) => inside(realPath(folder) ?? folder, root))
  } catch {
    return false
  }
}

/** Each process's pid, parent and group, and nothing else of any (src/testing/spawnedRuns.ts processTable). Throws when
 *  ps cannot run. */
function processTable() {
  return execFileSync('ps', ['-A', '-o', 'pid=,ppid=,pgid='], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 5_000 })
    .split('\n').flatMap((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line)
      return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]) }] : []
    })
}

/** [roots] and what descends from them in [table]: each one's children, and the members of a group one of them leads;
 *  never pid 1 (src/testing/spawnedRuns.ts processTree). */
function processTree(table, roots) {
  const tree = new Set(roots.filter((pid) => pid > 1))
  for (let grew = true; grew;) {
    grew = false
    const leaders = new Set(table.filter((row) => tree.has(row.pid) && row.pid === row.pgid).map((row) => row.pid))
    for (const row of table) {
      if (row.pid > 1 && !tree.has(row.pid) && (tree.has(row.ppid) || leaders.has(row.pgid))) { tree.add(row.pid); grew = true }
    }
  }
  return table.filter((row) => tree.has(row.pid))
}

/** The lines `ps -p` prints of [columns] for each of [pids] still running: never of a process not asked of. It exits 1
 *  once none of them runs, and what it printed is read whatever its status; C's dates, so each read prints a start alike. */
function psLines(pids, columns) {
  if (!pids.length) return []
  const listed = spawnSync('ps', ['-ww', '-o', columns, '-p', pids.join(',')],
    { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' }, maxBuffer: 64 * 1024 * 1024, timeout: 5_000 })
  return String(listed.stdout ?? '').split('\n')
}

/** [field] of each of [pids] still running, by pid, as `ps -p` prints it. */
function psOf(pids, field) {
  return new Map(psLines(pids, `pid=,${field}=`).flatMap((line) => {
    const match = /^\s*(\d+)\s+(.*?)\s*$/.exec(line)
    return match ? [[Number(match[1]), match[2]]] : []
  }))
}

/** Each of [pids] still running, its group, account, start and command line, as one read gives it, so every field is of
 *  the same process (src/testing/spawnedRuns.ts identities). */
function identities(pids) {
  return psLines(pids, 'pid=,pgid=,uid=,lstart=,command=').flatMap((line) => {
    // C's start is five words: `Mon Nov 23 10:00:03 2026`.
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d+)\s+(.*?)\s*$/.exec(line)
    return match ? [{ pid: Number(match[1]), pgid: Number(match[2]), uid: Number(match[3]), started: match[4], command: match[5] }] : []
  })
}

/** Of [started] (pid → its start time), what still runs as the same process: a pid that started at another time is
 *  another's (src/testing/rootProcesses.ts stillRunning). */
function stillRunning(started) {
  const now = psOf([...started.keys()], 'lstart')
  return [...started].filter(([pid, at]) => now.get(pid) === at).map(([pid]) => pid)
}

/** The pid of the tmux server at [socket], asked of that server alone; none when it does not answer. */
function serverPid(socket) {
  try {
    const pid = Number(execFileSync('tmux', ['-S', socket, 'display-message', '-p', '#{pid}'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000 }).trim())
    return pid > 1 ? [pid] : []
  } catch {
    return []
  }
}

/**
 * Each process the worker's registered groups, its tmux servers and the processes the harness noted it started hold
 * now, by its start time: seen before anything is ended, since once they are gone what they started is launchd's, and
 * only this keeps it the worker's. Empty, and one line logged, when ps cannot run.
 */
function seenNow() {
  let table
  try {
    table = processTable()
  } catch (error) {
    console.error(`[e2e reaper] could not list the worker's processes: ${error.code ?? error.message}`)
    return new Map()
  }
  const left = [...groups.keys()].filter(ours)
  const roots = [...table.filter((row) => left.includes(row.pgid)).map((row) => row.pid), ...[...tmuxServers.keys()].flatMap(serverPid),
    ...stillRunning(owned)]
  return psOf(processTree(table, roots).map((row) => row.pid), 'lstart')
}

/**
 * SIGKILL every process the harness noted it started that still runs as itself, by its start time, and what descends from
 * it, whatever it names or its parent is now, and wait, at most 5 s, until none is left: launchd's once the worker went,
 * the fake iTerm2's server before (outsideAgent.ts), herdr's server its client started (herdrServer.ts).
 */
async function endOwned() {
  const still = stillRunning(owned)
  if (!still.length) return
  let tree
  try {
    tree = processTree(processTable(), still).map((row) => row.pid).filter((pid) => ![process.pid, process.ppid, 1].includes(pid))
  } catch (error) {
    console.error(`[e2e reaper] could not list what the worker's own processes started: ${error.code ?? error.message}`)
    tree = still
  }
  console.error(`[e2e reaper] the test worker ended with ${tree.length} processes it started, or theirs, still running: SIGKILL`)
  for (const pid of tree) { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } }
  const deadline = Date.now() + 5_000
  while (tree.some(exists) && Date.now() < deadline) await sleep(100)
  const left = tree.filter(exists)
  if (left.length) console.error(`[e2e reaper] pids ${left.join(', ')} the worker started outlived SIGKILL by 5000 ms`)
}

/**
 * The working folder of each of [pids], processes of the worker's tree, pid to folder: lsof on macOS, /proc on Linux.
 * Another account's is left out, so only this account's processes are matched by folder. Empty, and one line logged,
 * when lsof cannot run: the sweep then goes by command line alone.
 */
function workingFolders(pids) {
  const uid = process.getuid()
  const folders = new Map()
  if (!pids.length) return folders
  if (process.platform === 'linux') {
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
    console.error(`[e2e reaper] no working folders read (lsof: ${why}): swept by command line alone`)
    return folders
  }
  // `p<pid>` starts a process, `u<uid>` is its account, `n<folder>` its working folder.
  let pid
  let owner
  for (const line of lsof.stdout.split('\n')) {
    if (line.startsWith('p')) { pid = Number(line.slice(1)); owner = undefined }
    else if (line.startsWith('u')) owner = Number(line.slice(1))
    else if (line.startsWith('n') && pid !== undefined && owner === uid) folders.set(pid, line.slice(1))
  }
  return folders
}

/**
 * What of the worker's tree still names [root] or works in it, [root] being a test's (isTestRoot): the rule of
 * src/testing/rootProcesses.ts, which plain Node cannot import. The tree is what was [seen] (seenNow) that still runs as
 * the same process, and what descends from it. A Codex rate-limit read runs in a process group of its own
 * (lib/codexRateLimits.ts), out of reach of the worker's groups: the census of 2026-11-14 found 14 such pairs outliving
 * their runs. And a process started by name in a pane names no root, and a real engine survives its pane's end: the audit
 * of 2026-11-15 found many real `claude`, and some `opencode` and `cursor-agent`, parented to pid 1 with their working
 * folder in a test's root. So one of this account's processes whose working folder is the root or in it is the test's
 * too. This process, its parent and pid 1 are never matched. A match that leads a group is ended with it, as the fake
 * Codex's child names nothing of the root; any other alone. This process leads its own group (reaper.ts), so no match's
 * group is this one's. None when nothing seen still runs, or ps cannot run.
 */
function treeMatches(root, seen) {
  const none = { groups: [], pids: [], all: [] }
  const still = stillRunning(seen)
  if (!still.length) return none
  let tree
  try {
    tree = processTree(processTable(), still)
  } catch (error) {
    console.error(`[e2e reaper] could not list the processes of ${root}: ${error.code ?? error.message}`)
    return none
  }
  const commands = psOf(tree.map((row) => row.pid), 'command')
  const table = tree.flatMap((row) => commands.has(row.pid) ? [{ ...row, command: commands.get(row.pid) }] : [])
  const folders = workingFolders(table.map((row) => row.pid))
  const spared = [process.pid, process.ppid, 1]
  const named = (row) => {
    const folder = folders.get(row.pid)
    return row.command.includes(`${root}/`) || (folder !== undefined && inside(folder, root))
  }
  const matches = table.filter((row) => named(row) && !spared.includes(row.pid))
  const groups = matches.filter((row) => row.pid === row.pgid).map((row) => row.pgid)
  const pids = matches.filter((row) => row.pid !== row.pgid).map((row) => row.pid)
  return { groups, pids, all: table.filter((row) => pids.includes(row.pid) || groups.includes(row.pgid)).map((row) => row.pid) }
}

/** How far below a root a Codex home's `app-server-daemon` folder is looked for, and how much of the root is read for it. */
const APP_SERVER_DEPTH = 4, FOLDERS_READ = 2_000, PID_FILES_READ = 16
/** The pid files in that folder: the app server's, and its updater's. */
const PID_FILES = ['daemon.pid', 'daemon-updater.pid']

/** Whether [path] is a pid file of the root's own: a file, not a link to one, nor the second name of one elsewhere (a hard
 *  link), and no larger than the product reads one (src/lib/harnessResources.ts). */
const ownPidFile = (path) => {
  try {
    const stat = lstatSync(path)
    return stat.isFile() && stat.nlink === 1 && stat.size <= 16_384
  } catch { return false }
}

/** What the JSON in [file] records, `{ pid, started }`, while its `pid` is a safe integer over 1 and its `processStartTime`
 *  a string, as the product reads one (src/core/engines/nativeControls.ts); null for anything else. */
function recorded(file) {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'))
    const pid = value?.pid, started = value?.processStartTime
    return Number.isSafeInteger(pid) && pid > 1 && typeof started === 'string' ? { pid, started } : null
  } catch { return null }
}

/**
 * What the Codex homes inside [root] record of their app servers and updaters: each `app-server-daemon/daemon.pid` and
 * `daemon-updater.pid`, that folder at most 4 below the root, read breadth first and through no link, soft or hard (one
 * could lead out of the root). At most 2,000 folders and 16 pid files are read; a bound reached is said once
 * (src/testing/rootProcesses.ts codexPidFiles).
 */
function codexPidFiles(root) {
  const pids = []
  const folders = [[root, 0]]
  let files = 0
  for (let at = 0; at < folders.length; at++) {
    if (at === FOLDERS_READ) {
      console.error(`[e2e reaper] read ${FOLDERS_READ} folders of ${root} for Codex app server pid files: looked no further`)
      break
    }
    const [folder, depth] = folders[at]
    let entries
    try { entries = readdirSync(folder, { withFileTypes: true }) } catch { continue /* gone, or not this account's to read */ }
    for (const entry of entries) {
      // readdir's own type: a link is never a folder here.
      if (!entry.isDirectory()) continue
      const path = join(folder, entry.name)
      const own = entry.name === 'app-server-daemon' ? PID_FILES.map((name) => join(path, name)).filter(ownPidFile) : []
      for (const file of own) {
        if (files++ === PID_FILES_READ) {
          console.error(`[e2e reaper] read ${PID_FILES_READ} Codex app server pid files under ${root}: looked no further`)
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

/** A Codex app server's command line, or its updater's (`app-server daemon pid-update-loop`): `codex`, `codex.js` or
 *  `codex.exe` run with `app-server` among its arguments. */
const CODEX_APP_SERVER = /(^|[/\\\s])codex(\.js|\.exe)?\s(.*\s)?app-server(\s|$)/

/** Whether two starts `ps -o lstart=` printed are one, however spaced (src/core/engines/nativeControls.ts reads them so). */
const sameStart = (a, b) => a.trim().replace(/\s+/g, ' ') === b.trim().replace(/\s+/g, ' ')

/**
 * The Codex app servers pid files inside [root] name that are the test's: this account's, a Codex app server, started no
 * sooner than the second before [root] was made, and the very process its pid file recorded, by its start
 * (src/testing/rootProcesses.ts codexDaemons): a pid given since to another, the dead worker's among them once this
 * process's parent is pid 1, is not it. Never this process, its parent or pid 1. None, and one line said, when the root's
 * birth time is unknown.
 */
function rootCodexDaemons(root) {
  // Only a pid that runs is asked of: macOS's `ps -p` given one no machine has (100000 or over) prints nothing of any pid
  // asked with it.
  const files = codexPidFiles(root).filter((file) => ![process.pid, process.ppid, 1].includes(file.pid) && exists(file.pid))
  if (!files.length) return []
  let made = 0
  try { made = statSync(root).birthtimeMs } catch { /* gone: no birth time */ }
  if (!(made > 0)) {
    console.error(`[e2e reaper] no birth time for ${root}: no Codex app server its pid files name is ended`)
    return []
  }
  // `ps` gives a start to the second, and Linux's can name the second before the one the clock was in
  // (src/testing/spawnedRuns.ts daemonOf).
  const since = Math.floor(made / 1_000) * 1_000 - 1_000
  return identities([...new Set(files.map((file) => file.pid))]).filter((row) => row.uid === process.getuid()
    && CODEX_APP_SERVER.test(row.command) && Date.parse(row.started) >= since
    && files.some((file) => file.pid === row.pid && sameStart(file.started, row.started)))
}

/**
 * The process groups a Codex app server's may never be (src/testing/rootProcesses.ts testRunGroups), read as this process
 * starts, while the worker that started it is its parent: the worker's, the worker's parent's, and the one in the
 * foreground of the worker's terminal (the shell's job running the tests) when it has one. This process leads a group of
 * its own (reaper.ts), never a Codex app server's. Null when they cannot be read, and on Windows, whose processes have no
 * groups to signal: then no group is ended whole.
 */
const runGroups = (() => {
  if (process.platform === 'win32') return null
  let table
  try { table = processTable() } catch { return null }
  const worker = table.find((row) => row.pid === process.ppid)
  const parent = worker && table.find((row) => row.pid === worker.ppid)
  if (!parent) return null
  const foreground = Number(psOf([worker.pid], 'tpgid').get(worker.pid))
  return new Set([worker.pgid, parent.pgid, ...(foreground > 0 ? [foreground] : [])])
})()

/**
 * SIGKILL what of the worker's tree still names [root] or works in it (treeMatches), and each Codex app server a pid file
 * inside [root] names that is the test's (rootCodexDaemons), with the group it leads unless that is the test run's own
 * (runGroups), [root] being a test's (isTestRoot), and wait, at most 5 s, until none is left. Codex's managed app server
 * detaches itself, names no root and need not work in it, so no tree leads to it: a real one from the tester of #4660 and
 * #4668 outlived its test, launchd's. Codex records it in `<CODEX_HOME>/app-server-daemon/daemon.pid`, and since 0.172
 * its updater (`codex app-server daemon pid-update-loop`, launchd's too, which outlived the real-Codex dial skill case,
 * 2026-11-27) in `daemon-updater.pid` beside it, so those are read even when nothing the worker saw still runs.
 */
async function endRootProcesses(root, seen) {
  const { groups, pids, all } = treeMatches(root, seen)
  const codex = rootCodexDaemons(root).filter((row) => !all.includes(row.pid))
  if (all.length) console.error(`[e2e reaper] ended ${all.length} processes that still named ${root} or ran in it`)
  if (codex.length) console.error(`[e2e reaper] ended ${codex.length} Codex app servers that pid files in ${root} named`)
  const whole = (row) => runGroups !== null && row.pgid === row.pid && !runGroups.has(row.pgid)
  for (const pgid of groups) signal(pgid, 'SIGKILL')
  for (const pid of pids) { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } }
  for (const row of codex) { try { process.kill(whole(row) ? -row.pid : row.pid, 'SIGKILL') } catch { /* gone */ } }
  const ended = [...all, ...codex.map((row) => row.pid)]
  const deadline = Date.now() + 5_000
  while (ended.some(exists) && Date.now() < deadline) await sleep(100)
  const left = ended.filter(exists)
  if (left.length) console.error(`[e2e reaper] pids ${left.join(', ')} of ${root} outlived SIGKILL by 5000 ms`)
}

/**
 * [root] and everything in it, as isolatedTmux's close removes it (src/testing/removeRoot.ts): a recursive removal cannot
 * unlink in a read-only folder, and the managed grid's install makes its bin/ one (lib/runtimeInstall.ts), so a removal that
 * fails makes the root's folders writable by their owner and is tried once more. What that one cannot remove is logged.
 */
function removeRoot(root) {
  const remove = () => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  try { remove() } catch {
    ownerWritable(root)
    try { remove() } catch (error) { console.error(`[e2e reaper] could not remove ${root}: ${error.message}`) }
  }
}

/** [folder] and every folder in it made writable by its owner. Read without following a link (lstat, and a link's own entry
 *  is never a folder), so nothing a link in the root leads to is changed. What it cannot change, the removal after it logs. */
function ownerWritable(folder) {
  let stats
  try { stats = lstatSync(folder) } catch { return }
  if (!stats.isDirectory()) return
  try { chmodSync(folder, (stats.mode & 0o7777) | 0o700) } catch { /* logged by the removal */ }
  let entries = []
  try { entries = readdirSync(folder, { withFileTypes: true }) } catch { /* logged by the removal */ }
  for (const entry of entries) if (entry.isDirectory()) ownerWritable(join(folder, entry.name))
}

async function reap() {
  const seen = seenNow()
  const left = [...groups.keys()].filter(ours)
  for (const pgid of left) {
    console.error(`[e2e reaper] the test worker ended with process group ${pgid} still running: stopping it`)
    signal(pgid, 'SIGTERM')
  }
  const deadline = Date.now() + GRACE_MS
  while (left.some(ours) && Date.now() < deadline) await sleep(100)
  for (const pgid of left.filter(ours)) {
    console.error(`[e2e reaper] process group ${pgid} outlived SIGTERM by ${GRACE_MS} ms: SIGKILL`)
    signal(pgid, 'SIGKILL')
  }
  await endOwned()
  for (const [socket, root] of tmuxServers) {
    // Stopped first, its panes with it, so the sweep meets only what they left, which was seen before. Swept before the
    // removal, so nothing that names the root writes into it as it goes.
    try { execFileSync('tmux', ['-S', socket, 'kill-server'], { stdio: 'ignore', timeout: 5_000 }) } catch { /* already gone */ }
    if (!isTestRoot(root)) {
      console.error(`[e2e reaper] not a test root, left alone: ${root}`)
      continue
    }
    await endRootProcesses(root, seen)
    removeRoot(root)
  }
}

createInterface({ input: process.stdin })
  .on('line', (line) => {
    let message
    try { message = JSON.parse(line) } catch { console.error(`[e2e reaper] unreadable line from the worker: ${line.slice(0, 200)}`); return }
    if (message.group) groups.set(message.group, false)
    else if (message.leaderGone) groups.set(message.leaderGone, true)
    else if (message.forget) groups.delete(message.forget)
    else if (message.tmux) tmuxServers.set(message.tmux, message.root)
    else if (message.forgetTmux) tmuxServers.delete(message.forgetTmux)
    else if (message.own && typeof message.started === 'string') owned.set(message.own, message.started)
    else if (message.forgetOwn) owned.delete(message.forgetOwn)
  })
  .on('close', () => { void reap() })
