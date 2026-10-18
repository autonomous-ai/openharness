/**
 * `execFile` whose timeout is not fooled by a held event loop.
 *
 * When the daemon's event loop is held for a few seconds (a synchronous read of a huge file, a heap
 * paged out, a laptop deep in swap), every child it started keeps running, answers and exits. When the
 * loop wakes it runs the timers that came due before it reads the answers that arrived, so Node's own
 * `timeout` fires on a child that answered long ago. Node then throws the unread output away and reports
 * the exit, 0, as a success with an empty stdout (measured on Node 22: a hold in an I/O or setImmediate
 * callback, `err` null, stdout ""). Every probe read that as an answer: no such pane, no panes at all,
 * no processes. A held core took live agents for gone and acted on it (e2e/stall.e2e.ts).
 *
 * The deadline here counts only time the loop was running. A timer that fires well past its due time
 * was held up with everything else, so the child gets its window again from now. One that fires on
 * time still waits for the check phase before it kills, so an answer that landed in the same instant is
 * read first. A child that really does not answer is killed after `timeout`, and the error says it
 * timed out, as Node's does (`killed`, `signal`).
 */
import type { ExecFileException } from 'node:child_process'
import { execFileOffThread, offThreadExecActive } from './offThreadExec.js'

/** A timer this much later than its due time was held up: the loop did not run meanwhile. */
export const HELD_MS = 250
/** At most this many windows for one call, so a loop held again and again still ends the wait. */
export const MAX_WINDOWS = 4

export type ExecDone = (error: ExecFileException | null, stdout: string, stderr: string) => void

export interface PatientExecOptions {
  timeout?: number
  killSignal?: NodeJS.Signals
  maxBuffer?: number
  env?: NodeJS.ProcessEnv
  cwd?: string
  /** Windows: no console window for the child. */
  windowsHide?: boolean
}

/**
 * Call `expire` once `ms` of running time has passed, unless cancelled first; returns the cancel.
 * `clock` is a monotonic millisecond clock.
 */
export function patientDeadline(ms: number, expire: () => void, clock: () => number = () => performance.now()): () => void {
  let cancelled = false
  let windows = 0
  let timer: NodeJS.Timeout | undefined
  const arm = (): void => {
    windows++
    const due = clock() + ms
    timer = setTimeout(() => {
      if (clock() - due > HELD_MS && windows < MAX_WINDOWS) { arm(); return }
      setImmediate(() => { if (!cancelled) expire() })
    }, ms)
  }
  arm()
  return () => {
    cancelled = true
    clearTimeout(timer)
  }
}

/** The error a timed-out child is reported with, on either path: `tmuxBackend.ts` reads its shape. */
function timedOut(file: string, args: readonly string[], timeout: number, killSignal: NodeJS.Signals): ExecFileException {
  return Object.assign(new Error(`${file} did not answer within ${timeout} ms`), {
    killed: true, signal: killSignal, code: 'ETIMEDOUT', cmd: [file, ...args].join(' '),
  }) as ExecFileException
}

/**
 * Wrap a module's own `execFile` (passed in, so a test's mock of `child_process` still applies) as one
 * that takes the same arguments and calls back the same way, with the timeout above.
 */
export function patientExec(execFile: (...args: any[]) => unknown) {
  return (file: string, args: readonly string[], options: PatientExecOptions, done: ExecDone): void => {
    const { timeout = 0, killSignal = 'SIGTERM', ...rest } = options
    if (offThreadExecActive()) {
      // The worker's loop is not held when this one is: its own timeout is a real one, and an answer
      // waits in the port until this loop reads it (offThreadExec.ts). No deadline is armed here.
      execFileOffThread(file, args, { ...rest, timeout, killSignal }, (error, stdout, stderr, outcome) => {
        // As below: exit 0 is an answer even when the kill raced it.
        if (error && outcome?.timedOut) { done(timedOut(file, args, timeout, killSignal), stdout, stderr); return }
        done(error, stdout, stderr)
      })
      return
    }
    let finished = false
    let timedOutHere = false
    let cancel = (): void => {}
    const child = execFile(file, [...args], { ...rest, encoding: 'utf8' }, (error: ExecFileException | null, stdout: string, stderr: string) => {
      finished = true
      cancel()
      // Exit 0 is an answer even when the kill raced it: unlike Node's own timeout, this one never
      // throws the output away.
      if (error && timedOutHere) {
        done(timedOut(file, args, timeout, killSignal), stdout ?? '', stderr ?? '')
        return
      }
      done(error, stdout ?? '', stderr ?? '')
    }) as { kill?: (signal: NodeJS.Signals) => boolean } | undefined
    if (timeout > 0 && !finished) {
      cancel = patientDeadline(timeout, () => {
        timedOutHere = true
        child?.kill?.(killSignal)
      })
    }
  }
}
