import { lstatSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { startStep, type StepHandle, type StepSpawner } from './steps.js'

export const CHECK_TIMEOUT_MS = 120_000
const FEEDBACK = 4000
export type CheckResult =
  | { kind: 'passed' } | { kind: 'failed'; how: string; tail: string }
  | { kind: 'timeout' } | { kind: 'could-not-start'; error: string } | { kind: 'error'; error: string } | { kind: 'uncertain' }
export interface CheckRun { handle: StepHandle; result: Promise<CheckResult> }

/** Neither the log folder nor its parent may be a link: it would send the logs wherever it points. */
function refuseLinks(cwd: string, logDir: string): void {
  for (const dir of [dirname(logDir), logDir]) {
    if (lstatSync(dir, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error(`${relative(cwd, dir)} is a link`)
  }
}

/** Check number `number` of a loop: a shell step in the task's execution folder with its own logs and a fixed time limit. Never throws. */
export function runCheck(command: string, opts: { cwd: string; logDir: string; number: number; env: Record<string, string>; spawn?: StepSpawner; timeoutMs?: number }): CheckRun {
  let handle: StepHandle
  try {
    refuseLinks(opts.cwd, opts.logDir)
    mkdirSync(opts.logDir, { recursive: true, mode: 0o700 })
    refuseLinks(opts.cwd, opts.logDir)
    const logs = { stdout: join(opts.logDir, `${opts.number}.stdout.log`), stderr: join(opts.logDir, `${opts.number}.stderr.log`) }
    // A log left at that name is replaced, never written through: it may be a link or a hard link to another file.
    for (const file of Object.values(logs)) if (lstatSync(file, { throwIfNoEntry: false })?.isDirectory() === false) rmSync(file)
    handle = startStep(command, { cwd: opts.cwd, env: opts.env, spawn: opts.spawn, logs })
  } catch (error) {
    const unarmed: StepHandle = { pid: undefined, stop: () => {}, armed: () => false, done: Promise.resolve({ code: null, signal: null, error: null, started: false, stdoutTail: '', stderrTail: '' }) }
    return { handle: unarmed, result: Promise.resolve({ kind: 'error', error: `the check could not be prepared: ${(error as Error).message}` }) }
  }
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; handle.stop() }, opts.timeoutMs ?? CHECK_TIMEOUT_MS)
  timer.unref()
  const result = handle.done.then((r): CheckResult => {
    clearTimeout(timer)
    if (!r.started) return { kind: 'could-not-start', error: String(r.error) }
    if (handle.armed()) return { kind: 'uncertain' } // its group could not be confirmed gone
    if (timedOut) return { kind: 'timeout' }
    if (r.error) return { kind: 'error', error: r.error }
    if (r.code === 0) return { kind: 'passed' }
    return { kind: 'failed', how: r.signal ? `stopped by ${r.signal}` : `exit ${r.code}`, tail: r.stderrTail.trim() || r.stdoutTail.trim() }
  })
  return { handle, result }
}

/** At most 4000 characters: the head, then the end of the tail. */
export function feedbackText(result: { how: string; tail: string }, number: number, max: number, logPath: string): string {
  const head = `Check failed (${result.how}), iteration ${number} of ${max}. Fix it and end your turn. Full log: ${logPath}\n\n`
  const room = FEEDBACK - head.length
  return room > 0 ? head + result.tail.slice(-room) : head.slice(0, FEEDBACK)
}
