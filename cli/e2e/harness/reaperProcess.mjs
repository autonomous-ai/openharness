/**
 * Ends what a test worker started once the worker is gone, however it went (e2e/harness/reaper.ts starts one per worker).
 *
 * Why: two daemons from an end-to-end run were found 1.5 days later on a developer's Mac (2026-11-11). The run's Vitest was
 * killed, so no afterEach ever closed them; their masters, parented to launchd, kept running. One held the real daemon's
 * bridge port, 51793; the other ran `lsof` every 5.5 s, about 7% of a core around the clock. Nothing in a dying worker can
 * be trusted to clean up (a SIGKILL runs no handler), so this process, started in a session of its own, does it: its stdin is
 * a pipe from the worker, and the kernel closes it when the worker exits, by any path. Then every process group the worker
 * still has registered gets SIGTERM, and SIGKILL for whatever is left after the grace; every tmux server it registered is
 * stopped (tmux daemonizes into a session of its own), every process that still names its throwaway root is ended, and the
 * root is removed, read-only folders and all.
 *
 * The worker's lines on stdin, one JSON object each: {"group":N} a process group to end, {"leaderGone":N} its leader exited,
 * {"forget":N} it was closed; {"tmux":socket,"root":folder} a tmux server to stop, then what still names its root to end and
 * the root to remove, {"forgetTmux":socket} they were.
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, lstatSync, readdirSync, rmSync } from 'node:fs'
import { basename, isAbsolute, join } from 'node:path'
import { createInterface } from 'node:readline'

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

/**
 * SIGKILL every process that still names [root] and wait, at most 5 s, until none is left: the rule of
 * src/testing/rootProcesses.ts, which plain Node cannot import. A Codex rate-limit read runs in a process group of its own
 * (lib/codexRateLimits.ts), out of reach of the worker's groups: the census of 2026-11-14 found 14 such pairs outliving
 * their runs. A match that leads a group is ended with it, as the fake Codex's child names nothing of the root; any other
 * alone. This process leads its own group (reaper.ts), so no match's group is this one's.
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
    console.error(`[e2e reaper] could not list the processes that name ${root}: ${error.code ?? error.message}`)
    return
  }
  const spared = [process.pid, process.ppid, 1]
  const matches = table.filter((row) => row.command.includes(`${root}/`) && !spared.includes(row.pid))
  const groups = matches.filter((row) => row.pid === row.pgid).map((row) => row.pgid)
  const pids = matches.filter((row) => row.pid !== row.pgid).map((row) => row.pid)
  const all = table.filter((row) => pids.includes(row.pid) || groups.includes(row.pgid)).map((row) => row.pid)
  if (!all.length) return
  console.error(`[e2e reaper] ended ${all.length} processes that still named ${root}`)
  for (const pgid of groups) signal(pgid, 'SIGKILL')
  for (const pid of pids) { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } }
  const deadline = Date.now() + 5_000
  while (all.some(exists) && Date.now() < deadline) await sleep(100)
  const left = all.filter(exists)
  if (left.length) console.error(`[e2e reaper] pids ${left.join(', ')} that named ${root} outlived SIGKILL by 5000 ms`)
}

/**
 * [root] and everything in it, as isolatedTmux's close removes it (src/testing/isolatedTmux.ts): a recursive removal cannot
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
    // Only isolatedTmux's own folder, as src/testing/rootProcesses.ts holds: a wrong one (empty, `/`, a TMPDIR) would have
    // every process that names it SIGKILLed, group and all, and every folder under it made writable and removed.
    if (typeof root !== 'string' || !isAbsolute(root) || !basename(root).startsWith('htmux-')) {
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
