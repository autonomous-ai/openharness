/**
 * Daemon logging helpers: a wall-clock timestamp prefix on every console line, the log FILE's size
 * cap, plus small formatters used by the per-step pipeline logs. The timestamp shim is installed
 * once at daemon boot (`installTimestampedConsole`) — CLI subcommands never call it, so their
 * terminal output stays clean. It only PREPENDS to each line, so substring log-markers (e.g. the
 * `[backend] connected` token scanned by the self-update readiness check) stay intact.
 */

import { createHmac, randomBytes } from 'node:crypto'
import { closeSync, existsSync, openSync, readSync, renameSync, statSync, writeFileSync, writeSync } from 'node:fs'

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0')
}

/** Local wall-clock "YYYY-MM-DD HH:MM:SS.mmm" — unambiguous for a single-user local daemon. */
export function ts(date: Date = new Date()): string {
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
  )
}

let installed = false

/** Wrap console.* so every daemon line is timestamped. Idempotent; safe to call more than once. */
export function installTimestampedConsole(): void {
  if (installed) return
  installed = true
  const levels = ['log', 'warn', 'error', 'info'] as const
  for (const level of levels) {
    const original = console[level].bind(console)
    console[level] = (...args: unknown[]): void => original(ts(), ...args)
  }
}

// ── log FILE size cap ────────────────────────────────────────────────────────────────────────────
// The daemon does not write the log through this process's `fs` calls — it is spawned with the file
// as its stdout/stderr fd, so nothing in-process sees a line to count. The cap is therefore enforced
// by whoever is about to open the file (a `join`, an update-restart) plus a timer inside the running
// daemon.

/** Hard ceiling for the log file. Never exceeded by more than one check interval's worth of output. */
export const LOG_MAX_BYTES = 10 * 1024 * 1024
/** How often the running daemon re-checks the size. A `statSync`, so cheap enough to keep tight. */
export const LOG_CHECK_INTERVAL_MS = 60_000

const mib = (bytes: number): string => (bytes / (1024 * 1024)).toFixed(0)

/**
 * Trim the log back under `maxBytes` by dropping the OLDEST half, keeping the newest — the recent
 * lines are the ones worth having when something just broke.
 *
 * Rewrites the file in place rather than rotating to a `.1` sibling: the cap is meant to bound what
 * this daemon costs on disk, and a rotation would make that 2× the number asked for. Safe against
 * the daemon's inherited fd because that fd is O_APPEND — after the truncate its next write lands at
 * the new end of file, not at a stale offset (which would leave a multi-MB sparse hole).
 *
 * Returns true when it trimmed. Every failure is swallowed: log upkeep must never take the daemon down.
 */
export function trimLogFile(file: string, maxBytes = LOG_MAX_BYTES): boolean {
  let size: number
  try { size = statSync(file).size } catch { return false }   // not created yet
  if (size <= maxBytes) return false
  const keep = Math.floor(maxBytes / 2)
  let fd: number | null = null
  try {
    fd = openSync(file, 'r')
    const buf = Buffer.alloc(keep)
    const read = readSync(fd, buf, 0, keep, size - keep)
    let tail = buf.subarray(0, read)
    // Start at a line boundary so the first surviving line isn't a fragment.
    const nl = tail.indexOf(0x0a)
    if (nl >= 0) tail = tail.subarray(nl + 1)
    const header = `${ts()} [log] trimmed — dropped the oldest ${mib(size - tail.length)} MB (cap ${mib(maxBytes)} MB)\n`
    writeFileSync(file, Buffer.concat([Buffer.from(header), tail]))
    return true
  } catch {
    return false
  } finally {
    if (fd !== null) { try { closeSync(fd) } catch { /* ignore */ } }
  }
}

/**
 * Adopt a log written under an older name. Renaming keeps the INODE, so a daemon still running from
 * a previous build — holding an fd on the old path — keeps writing into the very same file under its
 * new name: no lost lines and no orphan left behind. No-op once the new name exists.
 */
export function adoptLegacyLog(file: string, legacy: string): void {
  try {
    if (existsSync(file) || !existsSync(legacy)) return
    renameSync(legacy, file)
  } catch { /* best-effort: a missing legacy log is not worth a failed start */ }
}

/** Called before the log file is opened for a daemon: adopt an older name, then enforce the cap. */
export function prepareLogFile(file: string, legacy: string, maxBytes = LOG_MAX_BYTES): void {
  adoptLegacyLog(file, legacy)
  trimLogFile(file, maxBytes)
}

/**
 * Short session id for log lines. An OpenClaw key (`agent:<id>:<key>`) would read `agent:ma` for every session, and a
 * channel's key can carry the peer's id: it is logged as a short hash of itself instead.
 */
export function sid(id: string): string {
  return id.startsWith('agent:') ? `oc-${hashOf(id)}` : id.slice(0, 8)
}

// A class name starts upper case: one lower-case word can be a file's or a person's name ("notes", "someone").
const TYPE_NAME = /^[A-Z][A-Za-z0-9_$]{0,63}$/
const CODE = /^[A-Z][A-Z0-9_]{1,39}$/

/**
 * A failure's kind for a log line: its type and its code (`EACCES`, `TypeError`, `RegistryOwnershipChanged
 * IDENTITY_UNAVAILABLE`), never its words. A message or a stack can quote the person's files, prompts or a peer's
 * text, and Export logs sends the log off the machine. A thrown non-Error is its `typeof`: what it holds is unknown.
 *
 * The class name stands in when `name` is the inherited `Error`, since our typed errors rarely set one. The code is
 * looked for two causes deep, where a wrapper keeps the disk's. Never throws: a hostile getter reads `Error`.
 */
export function errorKind(error: unknown): string {
  try {
    if (!(error instanceof Error)) return typeof error
    const type = [error.name, error.constructor?.name]
      .find((name) => typeof name === 'string' && name !== 'Error' && TYPE_NAME.test(name))
    let code: string | undefined
    let at: unknown = error
    for (let depth = 0; depth < 3 && at !== null && typeof at === 'object'; depth++) {
      const candidate = (at as { code?: unknown }).code
      if (typeof candidate === 'string' && CODE.test(candidate)) { code = candidate; break }
      at = (at as { cause?: unknown }).cause
    }
    return [type, code].filter(Boolean).join(' ') || 'Error'
  } catch {
    return 'Error'
  }
}

/**
 * A stored or peer string for a log line: a code (`SERVICE_UNAVAILABLE`) as itself, any other string as its length.
 * Such a string can hold the person's words or a path naming their home, and Export logs sends the log off the
 * machine. A lower-case word is never trusted: it can be a file's or a person's name. A non-string is its `typeof`.
 */
export function codeOrLength(value: unknown): string {
  if (typeof value !== 'string') return typeof value
  return CODE.test(value) ? value : `text(${value.length})`
}

/**
 * Made once per process and kept in memory alone: with a plain hash, whoever holds an exported log could confirm a
 * guessed path (`/Users/<name>/…`) or a short name by hashing the guess. Another process, or this one started again,
 * tags the same text differently. Held on the process's global object, not this module, so a second load of the module
 * in the same process (a spec that resets its modules) tags alike.
 */
const TAG_KEY: Buffer = (globalThis as { [key: symbol]: Buffer })[Symbol.for('harness.logTagKey')] ??= randomBytes(32)

/** A path, URL or label for a log line: the same text reads the same within this process, and none of it shows. */
export function hashOf(text: string): string {
  return createHmac('sha256', TAG_KEY).update(text).digest('hex').slice(0, 8)
}

/**
 * An error nothing caught ends this process with one line, [tag] and the error's kind, written to [fd] at once (the
 * process is about to end), then exit 1, as Node does, so whatever supervises the process restarts it as before. Node's
 * own report is the error's message and stack, which can quote the person's files, and Export logs sends the log off
 * the machine. Every master and service process of the daemon installs it; the core keeps its own, which stays up.
 */
export function exitOnFatal(
  tag: string, fd: number,
  on: (event: 'uncaughtException' | 'unhandledRejection', listener: (error: unknown) => void) => void = (event, listener) => { process.on(event, listener) },
  exit: (code: number) => void = (code) => process.exit(code),
): void {
  const fatal = (what: string) => (error: unknown): void => {
    try {
      // not a state file: the process's last line, appended to its log
      writeSync(fd, `${ts()} ${tag} stopped on ${what}: ${errorKind(error)}\n`)
    } catch { /* the log cannot be written: the line is lost, never the exit */ }
    exit(1)
  }
  on('uncaughtException', fatal('an uncaught error'))
  on('unhandledRejection', fatal('an unhandled rejection'))
}

/** One-line, whitespace-flattened preview of user/assistant text, capped with an ellipsis. */
export function preview(text: string, max = 60): string {
  const flat = (text || '').replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/**
 * One line per backend frame, when LOG_FRAMES is on.
 *
 * Every content-bearing frame is E2EE-encrypted before it reaches the socket, so there is no way to see
 * what the adapter actually said from the outside — not from a packet capture, not from the backend.
 * This is that view, taken on the plaintext side of the wrap.
 *
 * It prints the frame TYPE and a fixed set of opaque identifiers, never a payload body: no message text,
 * no transcript, no token, no model list. Keep it that way — the point is to see the shape of a
 * conversation between adapter and clients, not its contents.
 */
export function logFrame(direction: '→' | '←', audience: string, frame: { type?: unknown; payload?: unknown }): void {
  const type = typeof frame.type === 'string' ? frame.type : '?'
  const payload = (frame.payload ?? {}) as Record<string, unknown>
  const bits: string[] = []
  for (const key of ['agentId', 'sessionId', 'dbSessionId', 'requestId'] as const) {
    const value = payload[key]
    if (typeof value === 'string' && value) bits.push(`${key}=${sid(value)}`)
  }
  // The runtime profile is an opaque id by construction — printing it whole is what makes a model/effort
  // bug readable in one line, and it carries nothing private.
  if (typeof payload.selectedModel === 'string') bits.push(`selectedModel=${payload.selectedModel}`)
  const agent = payload.agent as Record<string, unknown> | undefined
  if (agent && typeof agent === 'object') {
    if (typeof agent.engine === 'string') bits.push(`engine=${agent.engine}`)
    if (typeof agent.selectedModel === 'string') bits.push(`agent.selectedModel=${agent.selectedModel}`)
  }
  if (Array.isArray(payload.models)) bits.push(`models=${payload.models.length}`)
  if (typeof payload.error === 'string') bits.push(`error=${payload.error}`)
  console.log(`[frame] ${direction} ${audience} ${type}${bits.length ? ` · ${bits.join(' · ')}` : ''}`)
}

/**
 * A log write that fails is dropped, never fatal.
 *
 * The master's stdout and stderr are the daemon's log file (`harness start`, launchd's StandardOutPath,
 * systemd's `append:`), on the disk everything else is on. Node writes a file stdout synchronously, and a
 * write that fails there, on a full disk (ENOSPC) or past a size limit (EFBIG), is an 'error' event the
 * stream emits after `console.log` has returned; with no listener it is thrown, and the master died of
 * it: no master and no core until the disk had room, with a re-exec marker left to roll a good update
 * back on the next start. The same for a service, which shares the file.
 */
export function ignoreLogWriteErrors(streams: Pick<NodeJS.EventEmitter, 'on'>[] = [process.stdout, process.stderr]): void {
  for (const stream of streams) stream.on('error', dropLogWriteError)
}
function dropLogWriteError(): void { /* the line is lost; the process lives */ }
