// The Windows half of the dial's serial port (docs/superpowers/specs/2026-10-19-windows-dial-design.md §2).
//
// Node cannot do it alone: a read on a COM handle through `fs` blocks a libuv pool thread and cannot be cancelled,
// and portStream cannot wrap a COM handle. So harness-serial.exe (serial/, a small Rust program) does the port and
// this file runs it: one `watch` per daemon for the dials and whether this user is at the screen, one `open` per dial
// whose stdin and stdout are the link, and `probe` for "is another program holding it". No native module, as
// serial.ts's header says, and no shell: every spawn passes an argument array.
//
// Each child ends at end of its stdin. That is how it ends with the daemon, however the daemon ends: a crash or a
// TerminateProcess closes the pipe as surely as a clean exit does.
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { Duplex } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { env } from '../config/env.js'
import { currentPtyVersion } from '../lib/ptyHost/launch.js'
// serial.ts imports this file too. The two ids are read inside functions only, never while the modules load.
import { DIAL_PRODUCT_ID, DIAL_VENDOR_ID, type DialPort } from './serial.js'

export const SERIAL_EXE = 'harness-serial.exe'
/** How long a new watch has to print its first line before `ports()` answers with none. */
export const FIRST_LINE_MS = 2_000
/** A watch that ended is started again no sooner than this, so a broken one is not spawned every scan. */
export const WATCH_RESTART_MS = 5_000
/** How long `open` has to say `open`. */
export const OPEN_WAIT_MS = 5_000
/** How long a closed link's child has to end once its stdin is closed, before it is killed. */
export const CLOSE_WAIT_MS = 2_000
/** As `lsof`'s 5 s in portInUse, a little shorter: a probe opens and closes a port and nothing else. */
export const PROBE_TIMEOUT_MS = 3_000

const COM_NAME = /^COM[1-9]\d{0,2}$/

export interface SerialCommand { file: string; args: string[] }
export type CommandFor = (args: string[]) => SerialCommand | null

export interface SerialBinaryOptions {
  env?: NodeJS.ProcessEnv
  runtimeDir?: string
  /** The bundle's own directory (`dist/` in a release); the binary is looked for in its `pty/`. */
  besideDir?: string
  exists?: (file: string) => boolean
}

/**
 * The harness-serial.exe to run, or null when there is none, in ptyHostBinary's order (ptyHost/launch.ts):
 * 1. `HARNESS_SERIAL_BIN`, as it is (a wrong override should fail loudly, not fall back);
 * 2. `<runtime>/pty/<version>/harness-serial.exe` for the version `current-pty` names: it ships in the host's
 *    payload and installs beside it, per version, because Windows cannot overwrite a running .exe;
 * 3. in `pty/` beside the bundle, where ptyPayload.mjs puts it for local Windows testing.
 */
export function harnessSerialBinary(options: SerialBinaryOptions = {}): string | null {
  const override = (options.env ?? process.env).HARNESS_SERIAL_BIN?.trim()
  if (override) return override
  const exists = options.exists ?? ((file: string) => existsSync(file))
  const runtimeDir = options.runtimeDir ?? env.ADAPTER_RUNTIME_DIR
  const version = currentPtyVersion(runtimeDir)
  if (version) {
    const file = path.join(runtimeDir, 'pty', version, SERIAL_EXE)
    if (exists(file)) return file
  }
  const beside = path.join(options.besideDir ?? path.dirname(fileURLToPath(import.meta.url)), 'pty', SERIAL_EXE)
  return exists(beside) ? beside : null
}

export const windowsSerialCommand: CommandFor = (args) => {
  const file = harnessSerialBinary()
  return file ? { file, args } : null
}

export interface WindowsSerialState { console: boolean; ports: DialPort[] }

/** One `watch` line, or null when it is not one. Ports that are not `COMn` are dropped. */
export function parseSerialState(line: string): WindowsSerialState | null {
  let value: unknown
  try { value = JSON.parse(line) } catch { return null }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const { console: atConsole, ports } = value as { console?: unknown; ports?: unknown }
  if (typeof atConsole !== 'boolean' || !Array.isArray(ports)) return null
  const dials: DialPort[] = []
  for (const port of ports) {
    if (!port || typeof port !== 'object') continue
    const { path: name, serialNumber, session } = port as Record<string, unknown>
    if (typeof name !== 'string' || !COM_NAME.test(name)) continue
    dials.push({
      path: name, vendorId: DIAL_VENDOR_ID, productId: DIAL_PRODUCT_ID,
      ...(typeof serialNumber === 'string' && serialNumber ? { serialNumber } : {}),
      ...(typeof session === 'string' && session ? { session } : {}),
    })
  }
  return { console: atConsole, ports: dials }
}

function lastLine(text: string): string | null {
  return text.split(/\r?\n/).map((part) => part.trim()).filter(Boolean).at(-1) ?? null
}

export interface WindowsDialWatch {
  /** The dials the watch last reported; starts the watch on the first call and waits for its first line. */
  ports(): Promise<DialPort[]>
  /** Whether this user is at the screen. Starts discovery; unknown (no valid line yet) reads as false. */
  console(): boolean
  stop(): void
}

export interface WatchDeps {
  command: CommandFor
  spawn?: typeof spawn
  now?: () => number
  log?: (line: string) => void
  firstLineMs?: number
}

export function createWindowsDialWatch(deps: WatchDeps): WindowsDialWatch {
  const run = deps.spawn ?? spawn
  const now = deps.now ?? Date.now
  const log = deps.log ?? ((line: string) => console.log(line))
  const firstLineMs = deps.firstLineMs ?? FIRST_LINE_MS
  let child: ChildProcessWithoutNullStreams | null = null
  let state: WindowsSerialState | null = null
  let startedAt = -Infinity
  let said: string | null = null
  let firstRead: Promise<void> | null = null
  let finishFirstRead: (() => void) | null = null
  let stopped = false
  // The same trouble every scan is said once; a state in between lets it be said again.
  const say = (line: string): void => { if (line !== said) { said = line; log(line) } }
  const wake = (): void => { finishFirstRead?.(); finishFirstRead = null }

  const start = (): void => {
    if (stopped || child || now() - startedAt < WATCH_RESTART_MS) return
    startedAt = now()
    const command = deps.command(['watch'])
    if (!command) { say('cable: harness-serial is not installed — no USB dial can be found'); return }
    let proc: ChildProcessWithoutNullStreams
    try { proc = run(command.file, command.args, { stdio: 'pipe', windowsHide: true }) }
    catch (error) { say(`cable: harness-serial watch could not start: ${String(error)}`); return }
    child = proc
    firstRead = new Promise<void>((resolve) => {
      const timer = setTimeout(wake, firstLineMs)
      timer.unref()
      finishFirstRead = () => { clearTimeout(timer); resolve() }
    })
    let pending = '', stderr = ''
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk: string) => {
      if (child !== proc) return
      pending += chunk
      for (let end = pending.indexOf('\n'); end >= 0; end = pending.indexOf('\n')) {
        const next = parseSerialState(pending.slice(0, end).trim())
        pending = pending.slice(end + 1)
        if (next) { state = next; said = null; wake() }
      }
    })
    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-500) })
    proc.stdin.on('error', () => { /* the child is gone; 'close' says so */ })
    proc.on('error', (error) => {
      if (child !== proc) return
      say(`cable: harness-serial watch could not start: ${error.message}`)
      if (child === proc && proc.pid === undefined) { child = null; wake() }
    })
    proc.on('close', (code) => {
      if (child !== proc) return
      child = null
      state = null
      say(`cable: harness-serial watch ended (${lastLine(stderr) ?? `exit ${code}`}) — it is started again on a later scan`)
      wake()
    })
    // The daemon's exit is what ends the watch, never the other way round: nothing here may keep it alive.
    proc.unref()
    for (const stream of [proc.stdin, proc.stdout, proc.stderr]) (stream as unknown as { unref?: () => void }).unref?.()
  }

  return {
    async ports() {
      start()
      if (!state && child) await firstRead
      return (state?.ports ?? []).map((port) => ({ ...port }))
    },
    // The fleet asks this before ports(): start discovery here too, but never claim the console before its state arrives.
    console() {
      start()
      return state?.console ?? false
    },
    stop() {
      stopped = true
      const proc = child
      child = null
      state = null
      if (proc) endChild(proc, CLOSE_WAIT_MS)
      wake()
    },
  }
}

let shared: WindowsDialWatch | null = null

/** The daemon's one watch, started by the fleet's first look. */
export function windowsDialWatch(): WindowsDialWatch {
  shared ??= createWindowsDialWatch({ command: windowsSerialCommand })
  return shared
}

export interface PortStreamDeps { spawn?: typeof spawn; openWaitMs?: number; closeWaitMs?: number }

function openError(code: number | null, stderr: string): NodeJS.ErrnoException {
  const why = lastLine(stderr)
  if (code === 3) return Object.assign(new Error(`${why ?? 'busy'}: another program has the port`), { code: 'EBUSY' })
  if (code === 4) return Object.assign(new Error(`${why ?? 'gone'}: the port is not there`), { code: 'ENOENT' })
  return Object.assign(new Error(why ?? `harness-serial exited ${code}`), { code: 'EIO' })
}

/**
 * `harness-serial open <COMn>` as a duplex stream: what is written goes to its stdin, what it prints is the dial's.
 * Resolves once it says `open` on stderr (stdout carries only the dial's bytes, so the signal cannot ride there).
 * Destroying the stream ends the child's stdin and waits for it to exit, killing it after CLOSE_WAIT_MS; a child that
 * ends by itself (an unplug) destroys the stream with its last stderr line as the error's code, which SerialLink
 * hands to the session as the reason.
 */
export function openWindowsPort(command: SerialCommand, deps: PortStreamDeps = {}): Promise<Duplex> {
  const run = deps.spawn ?? spawn
  const closeWaitMs = deps.closeWaitMs ?? CLOSE_WAIT_MS
  let proc: ChildProcessWithoutNullStreams
  try { proc = run(command.file, command.args, { stdio: 'pipe', windowsHide: true }) }
  catch (error) { return Promise.reject(Object.assign(new Error(String(error)), { code: 'EIO' })) }
  let stderr = '', pending = ''
  proc.stderr.setEncoding('utf8')
  proc.stdin.on('error', () => { /* a write after the child ended fails in its own callback */ })
  return new Promise<Duplex>((resolve, reject) => {
    let settled = false
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      endChild(proc, closeWaitMs)
      reject(error)
    }
    const timer = setTimeout(() => {
      fail(Object.assign(new Error('harness-serial did not open the port in time'), { code: 'ETIMEDOUT' }))
    }, deps.openWaitMs ?? OPEN_WAIT_MS)
    proc.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-2_000)
      pending += chunk
      for (let end = pending.indexOf('\n'); end >= 0; end = pending.indexOf('\n')) {
        const line = pending.slice(0, end).replace(/\r$/, '')
        pending = pending.slice(end + 1)
        if (settled || line !== 'open') continue
        settled = true
        clearTimeout(timer)
        resolve(childStream(proc, () => stderr, closeWaitMs))
      }
      pending = pending.slice(-2_000)
    })
    proc.on('error', (error) => fail(Object.assign(new Error(error.message), { code: 'EIO' })))
    proc.on('close', (code) => fail(openError(code, stderr)))
  })
}

function endChild(proc: ChildProcessWithoutNullStreams, closeWaitMs: number): void {
  if (proc.exitCode !== null || proc.signalCode !== null) return
  const timer = setTimeout(() => proc.kill('SIGKILL'), closeWaitMs)
  timer.unref()
  proc.once('close', () => clearTimeout(timer))
  proc.stdin.end()
}

function childStream(proc: ChildProcessWithoutNullStreams, stderr: () => string, closeWaitMs: number): Duplex {
  let ended = false
  let eof = false
  const stream = new Duplex({
    read() { proc.stdout.resume() },
    write(chunk: Buffer, _encoding, done) { proc.stdin.write(chunk, done) },
    final(done) {
      eof = true
      endChild(proc, closeWaitMs)
      done()
    },
    destroy(error, done) {
      if (ended) { done(error); return }
      proc.once('close', () => done(error))
      // An unread burst can leave stdout paused after push() fills the readable buffer. Drain it
      // during teardown so the child's stdio can close; the data handler must not pause it again.
      proc.stdout.resume()
      endChild(proc, closeWaitMs)
    },
  })
  proc.stdout.on('data', (chunk: Buffer) => {
    if (stream.destroyed) return
    if (!stream.push(chunk)) proc.stdout.pause()
  })
  proc.stdout.on('error', (error) => stream.destroy(error))
  proc.once('close', (code) => {
    ended = true
    if (stream.destroyed) return
    // A pipe's EOF can precede the child's failure status. SerialLink treats EOF as a reason itself,
    // so classify the exit first or an unplug's useful stderr reason is replaced by "end of stream".
    if (eof && code === 0) { stream.push(null); return }
    const why = lastLine(stderr()) ?? `harness-serial exited ${code}`
    stream.destroy(Object.assign(new Error(why), { code: why }))
  })
  proc.on('error', (error) => stream.destroy(Object.assign(new Error(error.message), { code: 'EIO' })))
  return stream
}

/** Is another program holding [port]? Only harness-serial's `busy` says yes; as with lsof, cannot tell reads as free. */
export function windowsPortInUse(port: string, command: CommandFor = windowsSerialCommand, run: typeof execFile = execFile): Promise<boolean> {
  const probe = command(['probe', port])
  if (!probe) return Promise.resolve(false)
  return new Promise((resolve) => {
    try {
      run(probe.file, probe.args, { timeout: PROBE_TIMEOUT_MS, windowsHide: true }, (error) => {
        resolve((error as { code?: unknown } | null)?.code === 3)
      })
    } catch { resolve(false) }
  })
}
