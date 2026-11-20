/**
 * herdr's socket (docs/specs/2026-11-16-device-herdr.md): its agents, their status, and the dial's words, for the herdr
 * adapter and the herdr source. Newline-delimited JSON, one request a connection, and a subscription on a connection of
 * its own that is never written to again: herdr 0.8.0 ends a subscription sent a second request. On Windows the same
 * lines go over herdr's named pipe, which a marker file at the socket's path names.
 *
 * Everything is checked here. The socket is another program's: it must be this user's before anything connects (on
 * Windows, the marker's and the herdr that wrote it), a line has a bound, and a request's answer counts only under its own id. The pane id came from a hook or from herdr and the text from
 * the dial, so each is held to its form before it goes out.
 *
 * A prompt reads the pane again first. herdr types into a working agent as readily as into an idle one: in the spike the
 * agent's Enter was lost and the text joined its next prompt. herdr has no prompt that waits for idle, so the read
 * narrows that to one round trip.
 *
 * Nothing here focuses a pane, which stays `herdr agent focus` (herdr.ts), or keeps state per pane. Nothing here logs:
 * herdr's answers name people's folders and agents, and the source says what happened in its own fixed words.
 */
import { randomUUID } from 'node:crypto'
import { open } from 'node:fs/promises'
import type { Socket } from 'node:net'
import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'
import type { ProcessRow } from '../../lib/processTable.js'
import { windowsProcessRows } from '../../lib/windows/processTable.js'
import { windowsStartTime } from '../../lib/windows/treeKill.js'
import { CONTROL, MAX_TEXT, RUN_TIMEOUT_MS } from './orca.js'
import { connectLines, markerStampOf, socketStampOf, type SocketFault } from './unixSocket.js'

/** herdr's pane id, `w2:pE`: its workspace and pane numbers in herdr's own base 32 over
 *  `123456789ABCDEFGHJKMNPQRSTVWXYZ0` (src/workspace.rs `encode_public_number`, 0.8.0 to 0.9.5), so a workspace's tenth
 *  pane is `pA`. The one definition of the form, which herdr.ts builds on too. */
export const HERDR_PANE_FORM = 'w[0-9A-HJKMNP-TV-Z]{1,9}:p[0-9A-HJKMNP-TV-Z]{1,9}'
export const HERDR_PANE = new RegExp(`^${HERDR_PANE_FORM}$`)
/** An agent's kind as herdr names it: `claude`, `codex`, … */
export const HERDR_KIND = /^[a-z][a-z0-9_-]{0,31}$/
/** The longest line read from herdr. A list of 64 agents is a few dozen KiB; a line that keeps coming is not herdr. */
export const MAX_LINE_BYTES = 1024 * 1024
/** herdr's own error codes, `agent_not_found`: any other text is no code of herdr's, and is not passed on. */
const HERDR_CODE = /^[a-z][a-z0-9_]{0,63}$/

/** The key a hooked copy and a listed copy of one agent share (registry.ts). */
export const herdrPaneKey = (paneId: string): string => `herdr:${paneId}`

/** `socketPath` is herdr's socket, or on Windows its marker file; `endpoint` is what is dialled: the socket, or the
 *  marker's pipe. `rows` is the process table, read on Windows alone. */
export interface HerdrClientDeps {
  socketPath: string; endpoint: string; home: string; uid: number; platform: NodeJS.Platform
  rows(): Promise<ProcessRow[] | null>
}

/** Where herdr's server listens, as herdr works it out from the same environment: on Windows its marker, in
 *  %APPDATA% (herdr src/config/io.rs `config_dir`, docs/plans/2026-11-19-dial-windows-vm-notes.md Task 1 §7). A relative
 *  XDG_CONFIG_HOME or APPDATA counts as unset, as the XDG rule says: it would be the daemon's folder, not herdr's. */
export function herdrSocketPath(vars: NodeJS.ProcessEnv, home: string, platform: NodeJS.Platform = process.platform): string {
  const path = platform === 'win32' ? win32 : posix
  const set = (value: string | undefined): value is string => !!value && path.isAbsolute(value)
  const fallback = platform === 'win32'
    ? set(vars.APPDATA) ? vars.APPDATA : path.join(home, 'AppData', 'Roaming')
    : path.join(home, '.config')
  return path.join(set(vars.XDG_CONFIG_HOME) ? vars.XDG_CONFIG_HOME : fallback, 'herdr', 'herdr.sock')
}

/** The pipe herdr listens on for that marker: `\\.\pipe\` and the marker's whole path, unchanged (the `interprocess`
 *  crate's `GenericNamespaced`, as herdr src/ipc.rs names it). */
export const herdrPipeOf = (marker: string): string => `\\\\.\\pipe\\${marker}`

/** This computer's process table, from the terminal host (one function, so two deps are equal). */
const processTable = (): Promise<ProcessRow[] | null> => windowsProcessRows(null)

export function herdrClientDeps(): HerdrClientDeps {
  const home = homedir()
  const socketPath = herdrSocketPath(process.env, home)
  return {
    socketPath, endpoint: process.platform === 'win32' ? herdrPipeOf(socketPath) : socketPath,
    home, uid: process.getuid?.() ?? -1, platform: process.platform, rows: processTable,
  }
}

/** herdr's marker: `<server pid>:<unix time in ns>`, 24 bytes or so (docs/plans/2026-11-19-dial-windows-vm-notes.md,
 *  Task 1 §7). */
const MARKER = /^(\d{1,10}):(\d{1,20})$/
const MARKER_MAX_BYTES = 64
/** The Unix epoch as a FILETIME: 100 ns since 1601. */
const UNIX_EPOCH_FILETIME = 116_444_736_000_000_000n

/**
 * Whether the herdr that wrote the marker at [path] runs: the process it names is a herdr.exe this account may open (the
 * table leaves out another account's), started before the marker's time (a later one took the pid of a herdr that
 * exited). Never rejects.
 */
async function markerHerdrRuns(path: string, rows: () => Promise<ProcessRow[] | null>): Promise<boolean> {
  let text: string
  try {
    const file = await open(path, 'r')
    try {
      const { bytesRead, buffer } = await file.read(Buffer.alloc(MARKER_MAX_BYTES), 0, MARKER_MAX_BYTES, 0)
      text = buffer.toString('latin1', 0, bytesRead)
    } finally {
      await file.close()
    }
  } catch {
    return false
  }
  const marker = MARKER.exec(text)
  if (!marker) return false
  const pid = Number(marker[1])
  const written = BigInt(marker[2]!) / 100n + UNIX_EPOCH_FILETIME
  const row = (await rows().catch(() => null))?.find((row) => row.pid === pid)
  const started = row ? windowsStartTime(row.startMarker) : null
  return row?.executable.toLowerCase() === 'herdr.exe' && started !== null && started < written
}

/** Why a request has no result: the client's own word, or herdr's refusal (`rejected`) with herdr's code beside it.
 *  Kept apart, no code of herdr's reads as one of the client's words: a herdr that answers `no_socket` has a socket. */
export type HerdrFailure = { fault: Exclude<SocketFault, 'rejected'> } | { fault: 'rejected'; code: string }
export type HerdrAnswer = { ok: true; result: Record<string, unknown> } | ({ ok: false } & HerdrFailure)
/** A prompt not sent says why: as a request does, or that the client would not send it (`bad_request`), or that the pane
 *  holds another kind (`not_that_agent`). */
export type HerdrPrompt = { outcome: 'sent' | 'busy' }
  | ({ outcome: 'failed' } & (HerdrFailure | { fault: 'bad_request' | 'not_that_agent' }))
export type HerdrEntry = { type: 'pane.agent_detected' | 'pane.closed' | 'pane.exited' } | { type: 'pane.agent_status_changed'; pane_id: string }
export interface HerdrSubscriber {
  started(): void
  event(name: string, data: Record<string, unknown>): void
  closed(reason: SocketFault): void
}
export interface HerdrClient {
  request(method: string, params: Record<string, unknown>): Promise<HerdrAnswer>
  subscribe(entries: readonly HerdrEntry[], to: HerdrSubscriber): { close(): void }
  prompt(paneId: string, kind: string, text: string): Promise<HerdrPrompt>
  /** The socket's inode and change time while it is a socket of this user's, on Windows the marker's (unixSocket.ts
   *  markerStampOf); else none. */
  socketStamp(): string | undefined
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** A line's object, or none for a line that is no JSON object. */
const parse = (text: string): Record<string, unknown> | undefined => {
  try {
    const value: unknown = JSON.parse(text)
    return isObject(value) ? value : undefined
  } catch {
    return undefined
  }
}

const answerOf = (body: Record<string, unknown>, id: string): HerdrAnswer => {
  if (body.id === id && isObject(body.result)) return { ok: true, result: body.result }
  // herdr answers a request it could not read under "", as the spike saw.
  if ((body.id === id || body.id === '') && isObject(body.error)) {
    const code = body.error.code
    return typeof code === 'string' && HERDR_CODE.test(code)
      ? { ok: false, fault: 'rejected', code }
      : { ok: false, fault: 'bad_answer' }
  }
  return { ok: false, fault: 'bad_answer' }
}

/** A request's failure, as the prompt's. */
const failed = (answer: HerdrFailure): HerdrPrompt => answer.fault === 'rejected'
  ? { outcome: 'failed', fault: 'rejected', code: answer.code }
  : { outcome: 'failed', fault: answer.fault }

export function createHerdrClient(deps: HerdrClientDeps): HerdrClient {
  // On Windows, the marker last looked at and whether its herdr runs. The pipe is a name any account can take once
  // herdr is gone, and the marker stays after herdr ends without `herdr server stop`: so nothing is dialled until the
  // marker's own herdr is seen running, once a marker, and again after a connection that failed.
  let look: { stamp: string; runs: Promise<boolean>; ran?: boolean } | undefined
  const herdrRuns = (stamp: string): Promise<boolean> => {
    if (look?.stamp !== stamp) {
      const started: NonNullable<typeof look> = { stamp, runs: markerHerdrRuns(deps.socketPath, deps.rows) }
      void started.runs.then((ran) => { started.ran = ran })
      look = started
    }
    return look.runs
  }
  /** Whether [stamp]'s endpoint may be dialled. */
  const mayDial = (stamp: string): Promise<boolean> => (deps.platform === 'win32' ? herdrRuns(stamp) : Promise.resolve(true))
  const lookAgain = (stamp: string) => { if (look?.stamp === stamp) look = undefined }
  // A named pipe has no file to stat on Windows: herdr's marker beside it says it listens, and whose it is. A marker
  // whose herdr was not seen running is none; one still looked for counts, and its connection waits for the look.
  const socketStamp = (): string | undefined => {
    if (deps.platform !== 'win32') return socketStampOf(deps.socketPath, deps.uid)
    const stamp = markerStampOf(deps.socketPath)
    if (stamp === undefined) return undefined
    void herdrRuns(stamp)
    return look?.ran === false ? undefined : stamp
  }

  const request = (method: string, params: Record<string, unknown>) => new Promise<HerdrAnswer>((resolve) => {
    const stamp = socketStamp()
    if (!stamp) return resolve({ ok: false, fault: 'no_socket' })
    let done = false
    let socket: Socket | undefined
    const finish = (answer: HerdrAnswer) => {
      if (done) return
      done = true
      clearTimeout(deadline)
      socket?.destroy()
      resolve(answer)
    }
    const deadline = setTimeout(() => finish({ ok: false, fault: 'timeout' }), RUN_TIMEOUT_MS)
    deadline.unref()
    void mayDial(stamp).then((runs) => {
      if (done) return
      if (!runs) return finish({ ok: false, fault: 'no_socket' })
      const id = randomUUID()
      socket = connectLines(deps.endpoint, `${JSON.stringify({ id, method, params })}\n`, MAX_LINE_BYTES, (text) => {
        const body = parse(text)
        finish(body ? answerOf(body, id) : { ok: false, fault: 'bad_json' })
      }, (fault) => {
        // The close after an answer ends nothing.
        if (done) return
        lookAgain(stamp)
        finish({ ok: false, fault })
      })
    })
  })

  const subscribe = (entries: readonly HerdrEntry[], to: HerdrSubscriber): { close(): void } => {
    let over = false
    let started = false
    let socket: Socket | undefined
    let deadline: ReturnType<typeof setTimeout> | undefined
    // `closed` is told once, and the caller's own close tells nothing.
    const end = (reason?: SocketFault) => {
      if (over) return
      over = true
      clearTimeout(deadline)
      socket?.destroy()
      if (reason) to.closed(reason)
    }
    const handle = { close: () => end() }
    const stamp = socketStamp()
    if (!stamp) {
      // Told once the caller holds its close, as every other end is.
      queueMicrotask(() => end('no_socket'))
      return handle
    }
    deadline = setTimeout(() => end('timeout'), RUN_TIMEOUT_MS)
    deadline.unref()
    void mayDial(stamp).then((runs) => {
      if (over) return
      if (!runs) return end('no_socket')
      const id = randomUUID()
      const out = `${JSON.stringify({ id, method: 'events.subscribe', params: { subscriptions: entries } })}\n`
      socket = connectLines(deps.endpoint, out, MAX_LINE_BYTES, (text) => {
        const body = parse(text)
        if (!body) return end('bad_json')
        if (started) {
          // A line of another shape is no event this client knows: herdr may add some.
          if (typeof body.event === 'string' && isObject(body.data)) to.event(body.event, body.data)
          return
        }
        // The connection carries this one request, so its first line is the answer to it. A live subscription has no
        // deadline: herdr says nothing while nothing changes.
        const answer = answerOf(body, id)
        if (!answer.ok) return end(answer.fault)
        if (answer.result.type !== 'subscription_started') return end('bad_answer')
        started = true
        clearTimeout(deadline)
        to.started()
      }, (fault) => {
        // The close after the caller's own ends nothing.
        if (over) return
        lookAgain(stamp)
        end(fault)
      })
    })
    return handle
  }

  const prompt = async (paneId: string, kind: string, text: string): Promise<HerdrPrompt> => {
    // A newline would submit part of the text and an escape would steer the agent's screen: herdr types the text as it is.
    const line = text.replace(CONTROL, ' ')
    // A text that is blank once its control characters are spaces (a transcript of newlines) has nothing to type.
    if (!HERDR_PANE.test(paneId) || !HERDR_KIND.test(kind) || text.length > MAX_TEXT || line.trim() === '') {
      return { outcome: 'failed', fault: 'bad_request' }
    }
    const read = await request('agent.get', { target: paneId })
    if (!read.ok) return failed(read)
    const agent: Record<string, unknown> = isObject(read.result.agent) ? read.result.agent : {}
    // Only this pane's agent_info says what the pane holds now.
    if (read.result.type !== 'agent_info' || agent.pane_id !== paneId) return { outcome: 'failed', fault: 'bad_answer' }
    if (agent.agent !== kind) return { outcome: 'failed', fault: 'not_that_agent' }
    if (agent.agent_status !== 'idle' && agent.agent_status !== 'done') return { outcome: 'busy' }
    const sent = await request('agent.prompt', { target: paneId, text: line })
    return sent.ok ? { outcome: 'sent' } : failed(sent)
  }

  return { request, subscribe, prompt, socketStamp }
}
