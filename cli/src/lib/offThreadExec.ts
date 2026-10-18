/**
 * The core's short-lived probes (`ps`, `lsof`, `tmux` queries, the login-shell capture), spawned from a
 * worker thread.
 *
 * Node spawns a child synchronously on the thread that asks (`uv_spawn` → `posix_spawn`), and under CPU
 * contention one spawn takes tens of milliseconds. The core's terminals share its main thread: a keystroke
 * read from the local socket, and its echo written back, wait behind every probe spawned in between.
 * Measured 2026-10-15 on a 12-core Mac with 12 busy processes: ~60 % of the core main thread's non-idle
 * samples were inside `uv_spawn`, and a keystroke's echo took p99 62–101 ms through the daemon against
 * 12–28 ms through tmux alone (docs/plans/2026-10-15-keystrokes-off-spawn-path.md). From a worker, a
 * spawn holds only the worker.
 *
 * The child's timeout runs in the worker, as a patient deadline (see the worker's source). The main thread
 * keeps no timer, since a held loop fires a timer late, before it reads the answer waiting in the port
 * (patientExec.ts). The environment travels with every call: a worker's process.env is a copy made at its
 * start, and the core changes PATH after that (tmuxOnPath.ts).
 *
 * Only the core turns this on (`enableOffThreadExec`, core/main.ts). Everything else, and every unit test,
 * calls `execFile` on its own thread as before, so a test's mock of `node:child_process` still applies.
 */
import type { ExecFileException } from 'node:child_process'
import { Worker } from 'node:worker_threads'
import { HELD_MS, MAX_WINDOWS } from './patientExec.js'

export interface ProbeOptions {
  timeout?: number
  killSignal?: NodeJS.Signals
  maxBuffer?: number
  env?: NodeJS.ProcessEnv
  cwd?: string
}
/** `timedOut`: the worker killed the child for its timeout. Only the worker path reports it. */
export type ProbeDone = (error: ExecFileException | null, stdout: string, stderr: string, outcome?: { timedOut: boolean }) => void
export interface ProbeChild {
  kill(signal?: NodeJS.Signals): boolean
  readonly killed?: boolean
  stdin?: { end(): void } | null
}

interface Reply {
  id: number
  stdout: string
  stderr: string
  error: { message: string; code?: unknown; killed?: boolean; signal?: unknown; cmd?: string } | null
  timedOut: boolean
  killed: boolean
}

// CommonJS, evaluated in the worker: the lean bundle carries it as a string, with no file of its own.
// Nothing writes to a probe's stdin, so it is ended at once: an interactive shell that reads it then sees
// end-of-file, as the in-thread capture arranged with `child.stdin.end()`.
//
// The timeout is the worker's own patient deadline (patientExec.ts `patientDeadline`, the same rules), never
// Node's: the worker is held too, by its own synchronous spawns, and under a burst of probes Node's timer ran
// before the child's exit was read and reported an answered child as success with nothing in it (found in
// review, 2026-10-15). A late timer gets its window again; one on time kills from the check phase, after
// an answer that landed in the same instant has been read.
// Built when the worker starts, not at load: patientExec.ts imports this module, so its constants are not
// initialised yet while this one loads.
const workerSource = (): string => `
const { parentPort } = require('node:worker_threads')
const { execFile } = require('node:child_process')
const HELD_MS = ${HELD_MS}, MAX_WINDOWS = ${MAX_WINDOWS}
const deadline = (ms, expire) => {
  let cancelled = false, windows = 0, timer
  const arm = () => {
    windows++
    const due = performance.now() + ms
    timer = setTimeout(() => {
      if (performance.now() - due > HELD_MS && windows < MAX_WINDOWS) { arm(); return }
      setImmediate(() => { if (!cancelled) expire() })
    }, ms)
  }
  arm()
  return () => { cancelled = true; clearTimeout(timer) }
}
const children = new Map()
parentPort.on('message', (m) => {
  if (m.kill !== undefined) { const child = children.get(m.kill); if (child) child.kill(m.signal); return }
  const { timeout = 0, killSignal = 'SIGTERM', ...options } = m.options
  let child, timedOut = false, cancel = () => {}
  const reply = (error, stdout, stderr) => {
    cancel()
    children.delete(m.id)
    parentPort.postMessage({ id: m.id, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), timedOut,
      killed: Boolean(child && child.killed), error: error
        ? { message: error.message, code: error.code, killed: error.killed, signal: error.signal, cmd: error.cmd } : null })
  }
  try {
    child = execFile(m.file, m.args, options, reply)
    if (child.stdin) child.stdin.end()
    children.set(m.id, child)
    if (timeout > 0) cancel = deadline(timeout, () => { timedOut = true; child.kill(killSignal) })
  } catch (error) { reply(error, '', '') }
})
`

/** Two deaths this close together turn the route off for the rest of the process. */
const DEATH_WINDOW_MS = 60_000

let enabled = false
let fallen = false
let worker: Worker | null = null
let nextId = 0
type Pending = (error: ExecFileException | null, stdout: string, stderr: string, outcome: { timedOut: boolean; killed: boolean }) => void
const pending = new Map<number, Pending>()
const deaths: number[] = []

export function enableOffThreadExec(): void {
  enabled = true
}

export function offThreadExecActive(): boolean {
  return enabled && !fallen
}

/** Test seam: the route off, the worker gone, no death counted. */
export function resetOffThreadExec(): void {
  enabled = false
  fallen = false
  deaths.length = 0
  const stopping = worker
  worker = null
  failAll('the probe worker was reset')
  void stopping?.terminate()
}

/** Test seam: the worker ends as a crash would end it. */
export async function stopProbeWorkerForTest(): Promise<void> {
  const stopping = worker
  if (!stopping) return
  const exited = new Promise<void>((resolve) => stopping.once('exit', () => resolve()))
  await stopping.terminate()
  await exited
}

/**
 * The worker holds the process open exactly while it owes an answer. Found by CI (2026-10-15): unref'd
 * throughout, a signed-out `harness start` awaited a probe while nothing else held its loop yet and exited 0
 * in the middle of starting.
 */
function settle(): void {
  if (pending.size === 0) worker?.unref()
  else worker?.ref()
}

function failAll(reason: string): void {
  for (const [id, done] of [...pending]) {
    pending.delete(id)
    done(Object.assign(new Error(reason), { code: 'EWORKER' }) as ExecFileException, '', '', { timedOut: false, killed: false })
  }
}

function start(): Worker {
  const started = new Worker(workerSource(), { eval: true })
  started.on('message', (reply: Reply) => {
    const done = pending.get(reply.id)
    if (!done) return
    pending.delete(reply.id)
    settle()
    const error = reply.error ? Object.assign(new Error(reply.error.message), reply.error) as ExecFileException : null
    done(error, reply.stdout, reply.stderr, { timedOut: reply.timedOut, killed: reply.killed })
  })
  // An uncaught error in the worker ends it; `exit` follows and does the accounting.
  started.on('error', () => {})
  started.once('exit', () => {
    if (worker !== started) return
    worker = null
    failAll('the probe worker exited')
    const now = Date.now()
    deaths.push(now)
    while (deaths.length && now - deaths[0] > DEATH_WINDOW_MS) deaths.shift()
    if (deaths.length >= 2 && !fallen) {
      fallen = true
      console.warn('[probes] the probe worker exited twice within a minute; probes run on the main thread from now on')
    }
  })
  // Idle, the worker never keeps the process alive; a probe in flight does (`settle`), as a child spawned on
  // this thread would. After the listeners, since adding a 'message' listener refs the worker again
  // (measured on Node 23).
  started.unref()
  return started
}

export function execFileOffThread(file: string, args: readonly string[], options: ProbeOptions, done: ProbeDone): ProbeChild {
  const id = nextId++
  let killed = false
  pending.set(id, (error, stdout, stderr, outcome) => {
    // As ChildProcess.killed: true once the child was sent a signal, whoever sent it.
    killed = outcome.killed
    done(error, stdout, stderr, { timedOut: outcome.timedOut })
  })
  const target = worker ?? (worker = start())
  settle()
  target.postMessage({ id, file, args: [...args], options: { ...options, env: { ...(options.env ?? process.env) }, encoding: 'utf8' } })
  return {
    get killed() { return killed },
    kill(signal: NodeJS.Signals = 'SIGTERM') {
      if (!pending.has(id) || !worker) return false
      worker.postMessage({ kill: id, signal })
      return true
    },
  }
}

/**
 * `execFile` for a probe: the worker's when the core has turned it on, else `inThread` (the caller's own
 * `execFile`, passed in so a test's mock of `node:child_process` applies) with the same arguments.
 */
export function probeExecFile(inThread: (...args: any[]) => unknown) {
  return (file: string, args: readonly string[], options: ProbeOptions, done: ProbeDone): ProbeChild | undefined =>
    offThreadExecActive()
      ? execFileOffThread(file, args, options, done)
      : inThread(file, args, options, done) as ProbeChild | undefined
}
