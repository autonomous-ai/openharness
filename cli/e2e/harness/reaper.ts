/**
 * The worker's side of reaperProcess.mjs: it tells that process, started once per test worker, which process groups and tmux
 * servers to end should the worker go without closing them (a killed run, a test that never reached its afterEach).
 */
import { spawn, type ChildProcess } from 'node:child_process'
import type { Socket } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ownProcessGroup } from '../../src/lib/windows/noWindow.js'

let reaper: ChildProcess | null = null

function tell(message: Record<string, number | string>): void {
  if (!reaper) {
    // A session of its own, so the Ctrl-C that stops the run does not stop it before it has done its work.
    reaper = spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), 'reaperProcess.mjs')], {
      stdio: ['pipe', 'ignore', 'inherit'], ...ownProcessGroup(),
    })
    // Neither it nor its pipe keeps the worker alive: the worker exiting is what tells it to reap.
    reaper.unref()
    ;(reaper.stdin as Socket).unref()
  }
  reaper.stdin!.write(`${JSON.stringify(message)}\n`)
}

/** End process group [pgid] if the worker goes before `forgetGroup`. */
export const watchGroup = (pgid: number): void => tell({ group: pgid })
/** The group's leader exited: a process that later gets its pid is not ours. */
export const leaderGone = (pgid: number): void => tell({ leaderGone: pgid })
export const forgetGroup = (pgid: number): void => tell({ forget: pgid })
/** Stop the tmux server at [socket] if the worker goes before `forgetTmux`. */
export const watchTmux = (socket: string): void => tell({ tmux: socket })
export const forgetTmux = (socket: string): void => tell({ forgetTmux: socket })
