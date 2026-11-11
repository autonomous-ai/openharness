/**
 * Ends what a test worker started once the worker is gone, however it went (e2e/harness/reaper.ts starts one per worker).
 *
 * Why: two daemons from an end-to-end run were found 1.5 days later on a developer's Mac (2026-11-11). The run's Vitest was
 * killed, so no afterEach ever closed them; their masters, parented to launchd, kept running. One held the real daemon's
 * bridge port, 51793; the other ran `lsof` every 5.5 s, about 7% of a core around the clock. Nothing in a dying worker can
 * be trusted to clean up (a SIGKILL runs no handler), so this process, started in a session of its own, does it: its stdin is
 * a pipe from the worker, and the kernel closes it when the worker exits, by any path. Then every process group the worker
 * still has registered gets SIGTERM, and SIGKILL for whatever is left after the grace, and every tmux server it registered is
 * stopped (tmux daemonizes into a session of its own).
 *
 * The worker's lines on stdin, one JSON object each: {"group":N} a process group to end, {"leaderGone":N} its leader exited,
 * {"forget":N} it was closed; {"tmux":socket} a tmux server to stop, {"forgetTmux":socket} it was.
 */
import { execFileSync } from 'node:child_process'
import { createInterface } from 'node:readline'

/** How long a daemon gets to stop on SIGTERM before SIGKILL: as IsolatedDaemon.stop gives it. */
const GRACE_MS = 15_000

/** Process group → whether its leader has exited. */
const groups = new Map()
const tmuxServers = new Set()
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

async function reap() {
  const left = [...groups.keys()].filter(ours)
  for (const pgid of left) {
    console.error(`[e2e reaper] the test worker ended with process group ${pgid} still running: stopping it`)
    signal(pgid, 'SIGTERM')
  }
  const deadline = Date.now() + GRACE_MS
  while (left.some(ours) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 100))
  for (const pgid of left.filter(ours)) {
    console.error(`[e2e reaper] process group ${pgid} outlived SIGTERM by ${GRACE_MS} ms: SIGKILL`)
    signal(pgid, 'SIGKILL')
  }
  for (const socket of tmuxServers) {
    try { execFileSync('tmux', ['-S', socket, 'kill-server'], { stdio: 'ignore', timeout: 5_000 }) } catch { /* already gone */ }
  }
}

createInterface({ input: process.stdin })
  .on('line', (line) => {
    let message
    try { message = JSON.parse(line) } catch { console.error(`[e2e reaper] unreadable line from the worker: ${line.slice(0, 200)}`); return }
    if (message.group) groups.set(message.group, false)
    else if (message.leaderGone && groups.has(message.leaderGone)) groups.set(message.leaderGone, true)
    else if (message.forget) groups.delete(message.forget)
    else if (message.tmux) tmuxServers.add(message.tmux)
    else if (message.forgetTmux) tmuxServers.delete(message.forgetTmux)
  })
  .on('close', () => { void reap() })
