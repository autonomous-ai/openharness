/**
 * The worker's side of reaperProcess.mjs: it tells that process, started once per test worker, which process groups and tmux
 * servers to end should the worker go without closing them (a killed run, a test that never reached its afterEach).
 */
import { spawn, type ChildProcess } from 'node:child_process'
import type { Socket } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ownProcessGroup } from '../../src/lib/windows/noWindow.js'

type Message = { group: number } | { leaderGone: number } | { forget: number } | { tmux: string; root: string } | { forgetTmux: string }

let reaper: ChildProcess | null = null
/** What the reaper has been told and not told to forget: a reaper started again (the last one died) is told it all again. */
const watching = new Map<string, Message>()

function start(): ChildProcess {
  // A session of its own, so the Ctrl-C that stops the run does not stop it before it has done its work.
  const child = spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), 'reaperProcess.mjs')], {
    stdio: ['pipe', 'ignore', 'inherit'], ...ownProcessGroup(),
  })
  // A reaper that could not start or has died must not fail the tests it only cleans up after: the next message starts another.
  const lost = (error?: Error) => {
    if (reaper !== child) return
    reaper = null
    console.warn(`[e2e reaper] lost (${error?.message ?? `exited ${child.exitCode ?? child.signalCode}`}); starting another at the next daemon`)
  }
  child.once('error', lost)
  child.once('exit', () => lost())
  child.stdin!.on('error', lost)
  // Neither it nor its pipe keeps the worker alive: the worker exiting is what tells it to reap.
  child.unref()
  ;(child.stdin as Socket).unref()
  return child
}

function tell(key: string, message: Message | null, forget: Message): void {
  if (message) watching.set(key, message)
  else watching.delete(key)
  if (reaper) reaper.stdin!.write(`${JSON.stringify(message ?? forget)}\n`)
  else if (message) {
    reaper = start()
    for (const known of watching.values()) reaper.stdin!.write(`${JSON.stringify(known)}\n`)
  }
}

/** End process group [pgid] if the worker goes before `forgetGroup`. */
export const watchGroup = (pgid: number): void => tell(`group ${pgid}`, { group: pgid }, { forget: pgid })
/** The group's leader exited: a process that later gets its pid is not ours. */
export const leaderGone = (pgid: number): void => {
  if (watching.has(`group ${pgid}`)) tell(`group ${pgid}`, { leaderGone: pgid }, { forget: pgid })
}
export const forgetGroup = (pgid: number): void => tell(`group ${pgid}`, null, { forget: pgid })
/** Stop the tmux server at [socket] and remove [root] if the worker goes before `forgetTmux`. */
export const watchTmux = (socket: string, root: string): void => tell(`tmux ${socket}`, { tmux: socket, root }, { forgetTmux: socket })
export const forgetTmux = (socket: string): void => tell(`tmux ${socket}`, null, { forgetTmux: socket })
