/**
 * `harness device claude inbox <session id>`: the voice half of the harness-device mod on Windows, where the mod cannot
 * reach the daemon's pipe (Claude Code refuses every pipe as a `socketPath`, and its runtime has no HMAC:
 * docs/plans/2026-11-19-dial-windows-vm-notes.md, Task 2).
 * It holds the session's poll on the daemon's `/api/hook/inbox` over the pipe, proving the daemon's token in this
 * process, and prints one JSON line for each answer: `{"text":…}` (what the person said at the dial), `{}` (a hold that
 * ended with nothing), or `{"off":true}` (the plugin is off or removed, the id is refused, or the daemon is older than
 * the inbox), its last line. The lines carry the meaning, not the exit code: `harness.exe` owns 3 and 4, and Node's own
 * crash is 1. Nothing goes to stderr, and no token, pipe name or text is in an error or a log line.
 *
 * It ends itself. When the mod leaves its loop, or Claude Code ends, Windows kills nothing: Claude Code closes its end of
 * the stdout pipe, and this process's next write fails with EPIPE (the VM notes, Task 15). That write comes when the held
 * poll answers (at most 30 s) or after the 60 s wait, or never once another process holds the pipe, and meanwhile this
 * process holds the session's poll in the core. Its parent tells nothing either: `harness.exe` starts `node.exe` with no
 * job object and waits on it. So it watches its caller, the process above `harness.exe`: the caller's pid and
 * `harness.exe`'s every second, and the caller's start marker in the process table every minute, as Windows gives a
 * dead process's pid to the next one. Within 2 s of either ending, or at the minute's read once the caller's pid went to
 * another process, it ends, in a held poll or a wait, and writes nothing more. A table it cannot read never ends it: at
 * the start it then watches `harness.exe` alone, and later it keeps the caller it found. A newer poll for the session
 * ends an orphan's hold in the core (core/deviceHookCalls.ts).
 * Only the `harness` command's own process runs this; a client of the daemon's existing route, nothing in the core.
 */
import { statSync } from 'node:fs'
import { win32 } from 'node:path'
import { configuredPortOf, daemonRecordPath, readDaemonRecord } from '../lib/daemonRecord.js'
import { daemonFetch } from '../lib/localTransport.js'
import type { HostLiveness, HostProcessRow } from '../lib/processProof.js'
import { readDaemonToken } from '../lib/windows/pipeAuth.js'
import type { PipeTarget } from '../lib/windows/pipeClient.js'
import { CLAUDE_SESSION_ID, createRecordProof } from '../devices/listenerPipe.js'

/** The core's MAX_TEXT (core/deviceHookCalls.ts): a longer text is none. */
const MAX_TEXT = 20_000
/** The core holds a poll 27 s (core/devicesLink.ts INBOX_CALL_MS); one with no answer by now is not coming. */
const POLL_MS = 30_000
/** No daemon, no proof, no dial: the daemon would answer at once, so the next poll waits this long, as the Mac mod does. */
const RETRY_MS = 60_000
/** A 200 with no text sooner than this was not held, and polling again at once would spin, as the Mac mod's HELD_MS. */
const HELD_MS = 1_000
/** How often the caller's pid and the parent's are checked: the follower ends within two of these of either going. */
const TICK_MS = 1_000
/** How often the caller's start marker is read again; each read starts `harness-pty ps`. */
const REPROOF_MS = 60_000
const OFF = '{"off":true}'
const EMPTY = '{}'

/** Where the recorded daemon stands proven, and since when. */
export interface DaemonProof {
  /** The daemon's pipe and token for [dataDir] and [port], or null when there is nothing to dial. */
  pipe(dataDir: string, port: number): Promise<PipeTarget | null>
  /** Drops the proof held: the next call reads the table. */
  forget(dataDir: string, port: number): void
}

/**
 * The daemon's pipe proven as the devices' is (devices/listenerPipe.ts): the pid at every poll, the process table when
 * the record changes, after a failed or unproven answer, and at most once a minute. lib/windows/daemonPipe.ts, the
 * core's, reads the table on every call, which would start the pty host every 25 s for each session.
 */
export function createDaemonProof(options: { liveness?: HostLiveness; now?: () => number } = {}): DaemonProof {
  const proof = createRecordProof(options)
  const recordFile = (dataDir: string, port: number): string => daemonRecordPath(dataDir, configuredPortOf(dataDir, port))
  return {
    pipe(dataDir, port) {
      const configured = configuredPortOf(dataDir, port)
      const file = daemonRecordPath(dataDir, configured)
      return proof.pipe(file, () => {
        // The time before the read: a write between the two leaves a newer time, which the next call proves again.
        let mtimeMs: number
        try {
          mtimeMs = statSync(file).mtimeMs
        } catch {
          return null
        }
        const record = readDaemonRecord(dataDir, configured)
        const token = readDaemonToken(dataDir)
        return record?.pipe && record.pid && token ? { record: { pipe: record.pipe, pid: record.pid }, mtimeMs, token } : null
      })
    },
    forget(dataDir, port) {
      proof.forget(recordFile(dataDir, port))
    },
  }
}

export interface InboxDeps {
  dataDir: string
  port: number
  platform: NodeJS.Platform
  /** Whether the plugin's mod acts: on in Claude Code's settings, and not removed (command.ts `pluginActs`). */
  acts(): boolean
  proof: DaemonProof
  /** Plain fetch, for a daemon reached over its port where it has no socket (lib/localTransport.ts `daemonFetch`). */
  fetch?: typeof fetch
  /** One line on stdout; false once stdout is closed. */
  write(line: string): Promise<boolean>
  /** Resolves after [ms], or at once when [signal] aborts. */
  wait(ms: number, signal: AbortSignal): Promise<void>
  /** This process's pid, and its parent's: on Windows `harness.exe`. */
  pid: number
  ppid: number
  /** How its caller is proven to run (`watchCaller`). */
  liveness: CallerLiveness
  /** The time in ms. */
  now(): number
}

/** A process table row with its parent (lib/processTable.ts `ProcessRow`). */
export interface CallerRow extends HostProcessRow { parentPid: number }

/** Whether a pid runs, and the process table: on Windows devices/listenerPipe.ts `WINDOWS_LIVENESS`. */
export interface CallerLiveness {
  alive(pid: number): boolean
  rows(): Promise<readonly CallerRow[] | null>
}

/** Follows the session's inbox until off, its caller gone or its stdout closed; 0 in every case. */
export async function followInbox(sessionId: string, deps: InboxDeps): Promise<number> {
  if (!CLAUDE_SESSION_ID.test(sessionId)) {
    await deps.write(OFF)
    return 0
  }
  const watch = await watchCaller(deps)
  try {
    return await follow(sessionId, deps, watch.gone)
  } finally {
    watch.stop()
  }
}

async function follow(sessionId: string, deps: InboxDeps, gone: AbortSignal): Promise<number> {
  const send = daemonFetch(deps.dataDir, deps.port, deps.fetch, deps.platform, (dataDir, port) => deps.proof.pipe(dataDir, port))
  for (;;) {
    if (gone.aborted) return 0
    if (!deps.acts()) {
      await deps.write(OFF)
      return 0
    }
    const sentAt = deps.now()
    let line = await pollOnce(sessionId, send, deps, gone)
    // A poll the caller's end cut short is no failure of the daemon's.
    if (gone.aborted) return 0
    if (line === null) {
      // The next poll proves the daemon by the table: a pid another process took passes the cheap check, not that one.
      deps.proof.forget(deps.dataDir, deps.port)
      await deps.wait(RETRY_MS, gone)
      line = EMPTY
    } else if (line === EMPTY && deps.now() - sentAt < HELD_MS) await deps.wait(RETRY_MS, gone)
    if (gone.aborted) return 0
    if (!(await deps.write(line)) || line === OFF) return 0
  }
}

/**
 * A signal that aborts once the process this one serves is gone, and the stop of its timers. On Windows that is
 * Claude Code, the parent of `harness.exe` (or the parent itself when it is no `harness.exe`), found in the process
 * table once; its pid is checked every TICK_MS and its start marker every REPROOF_MS. Its parent's pid is checked
 * beside it, and alone on other platforms or when the table names no caller. A table that cannot be read ends nothing.
 */
async function watchCaller(deps: InboxDeps): Promise<{ gone: AbortSignal; stop(): void }> {
  const ended = new AbortController()
  const caller = deps.platform === 'win32' ? callerIn(await readRows(deps.liveness), deps.pid) : null
  const tick = (): void => {
    if (!deps.liveness.alive(deps.ppid) || (caller && !deps.liveness.alive(caller.pid))) ended.abort()
  }
  tick()
  const timers = [setInterval(tick, TICK_MS)]
  if (caller) {
    timers.push(setInterval(async () => {
      const rows = await readRows(deps.liveness)
      if (rows && rows.find((row) => row.pid === caller.pid)?.startMarker !== caller.startMarker) ended.abort()
    }, REPROOF_MS))
  }
  // Neither keeps the process alive: it ends when the follow does.
  for (const timer of timers) timer.unref()
  return { gone: ended.signal, stop: () => { for (const timer of timers) clearInterval(timer) } }
}

async function readRows(liveness: CallerLiveness): Promise<readonly CallerRow[] | null> {
  try {
    return await liveness.rows()
  } catch {
    return null
  }
}

/** The row of the process [pid] runs for: its parent's parent past a `harness.exe`, else its parent; null when unknown. */
function callerIn(rows: readonly CallerRow[] | null, pid: number): CallerRow | null {
  const row = (of: number | undefined): CallerRow | undefined => rows?.find((candidate) => candidate.pid === of)
  const parent = row(row(pid)?.parentPid)
  if (!parent) return null
  return (win32.basename(parent.executable).toLowerCase() === 'harness.exe' ? row(parent.parentPid) : parent) ?? null
}

/** One held poll: the line its answer prints, or null for none from a proven daemon (none there, no proof, no dial). */
async function pollOnce(sessionId: string, send: typeof fetch, deps: InboxDeps, gone: AbortSignal): Promise<string | null> {
  let answer: Response
  let body: string
  try {
    answer = await send(`http://127.0.0.1:${deps.port}/api/hook/inbox`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId }),
      signal: AbortSignal.any([AbortSignal.timeout(POLL_MS), gone]),
    })
    body = await answer.text()
  } catch {
    return null
  }
  if (answer.status === 404) return OFF
  if (answer.status !== 200) return null
  let text: unknown
  try {
    text = (JSON.parse(body) as { text?: unknown } | null)?.text
  } catch {
    return EMPTY
  }
  if (typeof text !== 'string' || text === '' || text.length > MAX_TEXT) return EMPTY
  // Asked again once the poll is back, before its text, as the Mac mod does: a session started before
  // `harness device claude disable` keeps its follower, and nothing said at the dial may reach it after.
  return deps.acts() ? JSON.stringify({ text }) : OFF
}
