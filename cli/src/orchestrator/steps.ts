// cli/src/orchestrator/steps.ts
import type { ChildProcess } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { basename, join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { Readable } from 'node:stream'
import { signalPidGroup, spawnDshCommand } from '../dsh/shell.js'

export type StepSpawner = (script: string, opts: { cwd: string; env: Record<string, string> }) => ChildProcess
/** `started` is false when the shell itself could not start: a launch error, never retried automatically. */
export interface StepResult { code: number | null; signal: NodeJS.Signals | null; error: string | null; started: boolean; stdoutTail: string; stderrTail: string }
/** `done` resolves once the step's whole process group is gone; `stop({ now: true })` skips the grace period (daemon exit). `armed()` is false once the group is confirmed gone (or the shell never started): stop is then a no-op. */
export interface StepHandle { pid: number | undefined; done: Promise<StepResult>; stop(options?: { now?: boolean }): void; armed(): boolean }
export const STEP_LOG_LIMIT = 8 * 1024 * 1024
const TAIL = 4000
const FAILURE = 2000
// How long after the SIGKILL a group may take to disappear before the step reports it could not confirm that.
const KILL_SETTLE_MS = 2000

function describe(error: unknown): string {
  const code = (error as NodeJS.ErrnoException).code
  if (code === 'ENOENT') return 'the shell could not be found (ENOENT)'
  if (code === 'EACCES') return 'the shell is not executable (EACCES)'
  return `the shell could not start (${code ?? 'unknown error'})`
}
/** Why a step failed: how it ended plus the end of its output, never the script. */
export function stepFailure(result: StepResult): string {
  const how = result.error ?? (result.signal ? `stopped by ${result.signal}` : `exit ${result.code}`)
  const detail = (result.stderrTail.trim() || result.stdoutTail.trim())
  return (detail ? `${how}: ${detail.slice(-(FAILURE - how.length - 2))}` : how).slice(0, FAILURE)
}

function capture(stream: Readable | null, file: string, onFail: (message: string) => void): { tail(): string; close(): Promise<void> } {
  const out = createWriteStream(file, { mode: 0o600 })
  out.on('error', failure => onFail(`could not write ${basename(file)}: ${failure.message}`))
  const decoder = new StringDecoder('utf8')
  let bytes = 0, tail = ''
  stream?.on('error', failure => onFail(`could not read the step output: ${failure.message}`))
  stream?.on('data', (chunk: Buffer) => {
    tail = (tail + decoder.write(chunk)).slice(-TAIL)
    if (bytes >= STEP_LOG_LIMIT) return
    const room = STEP_LOG_LIMIT - bytes
    out.write(chunk.length > room ? chunk.subarray(0, room) : chunk)
    bytes += Math.min(chunk.length, room)
    if (bytes >= STEP_LOG_LIMIT) out.write('\n[output truncated]\n')
  })
  return {
    tail: () => tail + decoder.end(),
    close: () => new Promise(resolve => { if (out.closed) resolve(); else { out.once('close', () => resolve()); out.end() } }),
  }
}

/** True once no process of the group is left (`gone` probes it); false if one still is (or cannot be checked) at the deadline. */
async function groupGone(gone: () => boolean, until: number): Promise<boolean> {
  for (;;) {
    if (gone()) return true
    if (Date.now() >= until) return false
    await new Promise(r => setTimeout(r, 50).unref())
  }
}

/**
 * A recorded process (one this daemon holds no handle for) counts as stopped only when its leader and its whole group
 * are gone: both probes answer ESRCH. Any other answer, EPERM included, means it may still run.
 */
export function processGone(pid: number): boolean {
  for (const target of [pid, -pid]) {
    try { process.kill(target, 0); return false } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return false }
  }
  return true
}

/** Run a flow's shell step in its task folder and its own process group, output streamed to files. */
export function startStep(script: string, opts: { cwd: string; env: Record<string, string>; spawn?: StepSpawner; graceMs?: number; logs?: { stdout: string; stderr: string } }): StepHandle {
  const spawner = opts.spawn ?? ((s, o) => spawnDshCommand(s, o))
  const graceMs = opts.graceMs ?? 3000
  let child: ChildProcess
  try { child = spawner(script, { cwd: opts.cwd, env: opts.env }) }
  catch (error) {
    return { pid: undefined, stop: () => {}, armed: () => false, done: Promise.resolve({ code: 127, signal: null, error: describe(error), started: false, stdoutTail: '', stderrTail: '' }) }
  }
  let error: string | null = null, giveUpAt: number | undefined, escalation: NodeJS.Timeout | undefined, gone = false
  /** Probes the group; once it is gone the handle is disarmed for good. True when it is (or already was) gone. */
  const confirmGone = (pid: number): boolean => {
    try { process.kill(-pid, 0) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') { gone = true; clearTimeout(escalation) } }
    return gone
  }
  // The SIGKILL is not tied to the leader: descendants that ignore SIGTERM still go. It is sent only while the handle
  // is armed and the group still exists: a group that is gone (its pid possibly reused) is never signalled.
  const stop = ({ now = false } = {}): void => {
    if (child.pid === undefined || gone) return
    if (now) signalPidGroup(child.pid, 'SIGKILL')
    else if (giveUpAt === undefined) {
      const pid = child.pid
      signalPidGroup(pid, 'SIGTERM')
      escalation = setTimeout(() => { if (!confirmGone(pid)) signalPidGroup(pid, 'SIGKILL') }, graceMs)
      escalation.unref()
    }
    giveUpAt ??= Date.now() + graceMs + KILL_SETTLE_MS
  }
  const failed = (message: string): void => { error ??= message; stop() }
  const stdout = capture(child.stdout, opts.logs?.stdout ?? join(opts.cwd, 'stdout.log'), failed)
  const stderr = capture(child.stderr, opts.logs?.stderr ?? join(opts.cwd, 'stderr.log'), failed)
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()))
  const done = new Promise<StepResult>(resolve => {
    let settled = false
    const finish = async (code: number | null, signal: NodeJS.Signals | null): Promise<void> => {
      if (settled) return
      settled = true
      stop() // the step is over: whatever it left behind in its group goes too
      await Promise.race([closed, new Promise(r => setTimeout(r, graceMs).unref())])
      child.stdout?.destroy(); child.stderr?.destroy()
      // Ended only when nothing of it is left: its owner may start a retry or exit next.
      // Confirmed before the logs are flushed, so a slow flush cannot leave a SIGKILL pending for a gone group.
      const pid = child.pid
      if (pid === undefined) gone = true
      else if (!await groupGone(() => confirmGone(pid), giveUpAt!)) error ??= 'processes it started could not be confirmed stopped'
      await Promise.all([stdout.close(), stderr.close()])
      resolve({ code: error && code === null ? 127 : code, signal, error, started: child.pid !== undefined, stdoutTail: stdout.tail(), stderrTail: stderr.tail() })
    }
    child.on('error', e => {
      error ??= child.pid === undefined ? describe(e) : `the step's process reported an error (${(e as NodeJS.ErrnoException).code ?? 'unknown error'})`
      if (child.pid === undefined) void finish(null, null)
    })
    child.on('exit', (code, signal) => { void finish(code, signal) })
  })
  return { pid: child.pid, done, stop, armed: () => !gone }
}
