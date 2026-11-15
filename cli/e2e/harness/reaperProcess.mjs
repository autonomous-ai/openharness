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
 * that still names that root or works in it is ended, and the root is removed, read-only folders and all.
 *
 * The worker's lines on stdin, one JSON object each: {"group":N} a process group to end, {"leaderGone":N} its leader exited,
 * {"forget":N} it was closed; {"tmux":socket,"root":folder} a tmux server to stop, then what still names its root or works
 * in it to end and the root to remove, {"forgetTmux":socket} they were.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, lstatSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync } from 'node:fs'
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

/**
 * The working folder of each of this account's processes in [table], pid to folder: lsof on macOS, /proc on Linux.
 * Another account's is left out, so only this account's processes are matched by folder. Empty, and one line logged,
 * when lsof gives none: the sweep then goes by command line alone.
 */
function workingFolders(table) {
  const uid = process.getuid()
  const folders = new Map()
  if (process.platform === 'linux') {
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
 * SIGKILL every process that still names [root] or works in it, [root] being a test's (isTestRoot), and wait, at most
 * 5 s, until none is left: the rule of src/testing/rootProcesses.ts, which plain Node cannot import. A Codex rate-limit
 * read runs in a process group of its own (lib/codexRateLimits.ts), out of reach of the worker's groups: the census of
 * 2026-11-14 found 14 such pairs outliving their runs. And a process started by name in a pane names no root, and a real
 * engine survives its pane's end: the audit of 2026-11-15 found many real `claude`, and some `opencode` and
 * `cursor-agent`, parented to pid 1 with their working folder in a test's root. So one of this account's processes whose
 * working folder is the root or in it is the test's too. This process, its parent and pid 1 are never matched. A match
 * that leads a group is ended with it, as the fake Codex's child names nothing of the root; any other alone. This process
 * leads its own group (reaper.ts), so no match's group is this one's.
 */
async function endRootProcesses(root) {
  let table
  try {
    table = execFileSync('ps', ['-A', '-ww', '-o', 'pid=,pgid=,command='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 5_000 })
      .split('\n').flatMap((line) => {
        const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
        return match ? [{ pid: Number(match[1]), pgid: Number(match[2]), command: match[3] }] : []
      })
  } catch (error) {
    console.error(`[e2e reaper] could not list the processes of ${root}: ${error.code ?? error.message}`)
    return
  }
  const folders = workingFolders(table)
  const spared = [process.pid, process.ppid, 1]
  const named = (row) => {
    const folder = folders.get(row.pid)
    return row.command.includes(`${root}/`) || (folder !== undefined && inside(folder, root))
  }
  const matches = table.filter((row) => named(row) && !spared.includes(row.pid))
  const groups = matches.filter((row) => row.pid === row.pgid).map((row) => row.pgid)
  const pids = matches.filter((row) => row.pid !== row.pgid).map((row) => row.pid)
  const all = table.filter((row) => pids.includes(row.pid) || groups.includes(row.pgid)).map((row) => row.pid)
  if (!all.length) return
  console.error(`[e2e reaper] ended ${all.length} processes that still named ${root} or ran in it`)
  for (const pgid of groups) signal(pgid, 'SIGKILL')
  for (const pid of pids) { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } }
  const deadline = Date.now() + 5_000
  while (all.some(exists) && Date.now() < deadline) await sleep(100)
  const left = all.filter(exists)
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
  for (const [socket, root] of tmuxServers) {
    // The server names the root on its own command line: stopped first, its panes with it, so the sweep meets only what
    // left the worker's groups. Swept before the removal, so nothing that names the root writes into it as it goes.
    try { execFileSync('tmux', ['-S', socket, 'kill-server'], { stdio: 'ignore', timeout: 5_000 }) } catch { /* already gone */ }
    if (!isTestRoot(root)) {
      console.error(`[e2e reaper] not a test root, left alone: ${root}`)
      continue
    }
    await endRootProcesses(root)
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
  })
  .on('close', () => { void reap() })
