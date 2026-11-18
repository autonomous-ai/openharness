// The loop behind the panel and the status bar: it asks `harness device orca link` where the devices' socket is,
// holds the `dial` stream open on it, and makes each of its lines the state. While that stream is open it tells the
// devices the terminals of the worktree on Orca's screen, by their ids alone. Nothing of `orca` is loaded here: the end
// to end test runs this file outside Orca.
import { basename, dirname } from 'node:path'
import { MISSING, type DialInputs, type Ran } from './inputs'
import type { DialState } from './protocol'

const LINK_ARGS = ['device', 'orca', 'link'] as const
const DIAL_OPEN = '{"type":"dial","standby":true}'

export interface Dial {
  state(): DialState
  /** The terminal ids of the worktree on Orca's screen, in Orca's order, or null when none is. */
  front(terminals: readonly string[] | null): void
  /** Ends the loop: nothing is told or logged once it is called. Resolves when the pass in flight has ended. */
  stop(): Promise<void>
}

const LINK_TIMEOUT_MS = 5_000
const LINK_MAX_BYTES = 4_096
// The listener's own deadline for an open.
const HEAD_MS = 2_000
// A line with its newline: no more is ever held.
const LINE_BYTES = 1_024
const NEWLINE = 0x0a
const REPLACED = '{"replaced":true}'
const FIRST_WAIT_MS = 1_000
const LAST_WAIT_MS = 30_000
// Unplugged with the watch on: the watch asks as the socket appears, so link is looked at again only in case the
// daemon stops.
const WATCHED_WAIT_MS = 300_000
// The folder watch asks link at most this often.
const WATCH_MS = 1_000
// What the devices take of the worktree on screen: Orca's terminal handles, at most 50.
const HANDLE = /^term_[0-9a-f-]{36}$/
const FRONT_MAX_TERMINALS = 50
const FRONT_RETRY_MS = 1_000

type Link = { ready: false; socket?: string } | { ready: true; socket: string }

// The `dial` stream while it is open.
interface Stream {
  socket: string
  /** The body the devices last took. */
  sent?: string
  /** Stops the send in flight. */
  sending?: () => void
  /** The body whose retry waits. */
  retry?: { body: string; cancel(): void }
  /** The body whose retry failed too. */
  failed?: string
}

const decoder = new TextDecoder()

export function startDial(inputs: DialInputs, tell: { changed(state: DialState): void; log(line: string): void }): Dial {
  let current: DialState = { state: 'checking' }
  let stopped = false
  let passing: AbortController | null = null
  let passDone = Promise.resolve()
  let lastStart = 0
  // The watch asked while a pass ran: one more pass follows it.
  let again = false
  let wait = FIRST_WAIT_MS
  let nextAt = Infinity
  let cancelNext = () => {}
  let watching: { socket: string; close(): void } | null = null
  let watchFailed = false
  // The body of the last front(), kept for the next stream while none is open.
  let latest: string | undefined
  let stream: Stream | null = null

  function log(line: string): void {
    if (!stopped) tell.log(line)
  }

  function set(next: DialState): void {
    if (stopped || same(current, next)) return
    if (next.state !== current.state) log(`dial: ${next.state}`)
    if (next.state !== 'unplugged') unwatch()
    current = next
    tell.changed(next)
  }

  function start(): void {
    cancelNext()
    nextAt = Infinity
    again = false
    lastStart = inputs.now()
    const abort = new AbortController()
    passing = abort
    passDone = pass(abort).then((quiet) => ended(abort, quiet))
  }

  function ended(abort: AbortController, quiet: boolean): void {
    // What the pass left open, as an answer it did not read, goes with it.
    abort.abort()
    passing = null
    if (stopped) return
    const now = inputs.now()
    // Unplugged with the watch on is no failure: the watch asks as the socket appears, link is looked at again only in
    // case the daemon stops, and a stream that ends soon after waits from 1 s, not from a wait grown meanwhile.
    const at = again ? Math.max(now, lastStart + WATCH_MS) : now + (quiet ? WATCHED_WAIT_MS : wait)
    wait = quiet ? FIRST_WAIT_MS : Math.min(wait * 2, LAST_WAIT_MS)
    schedule(at)
  }

  function schedule(at: number): void {
    if (at >= nextAt) return
    cancelNext()
    const ms = at - inputs.now()
    if (ms <= 0) return start()
    nextAt = at
    cancelNext = inputs.after(ms, start)
  }

  // A pass now, or a second after the last one began if that is later.
  function ask(): void {
    if (stopped) return
    if (passing) again = true
    else schedule(Math.max(inputs.now(), lastStart + WATCH_MS))
  }

  // The devices' socket appears in its folder once a dial is plugged in: its entry asks link again.
  function watch(socket: string | undefined): void {
    if (stopped || watching?.socket === socket) return
    unwatch()
    if (socket === undefined) return
    const entry = basename(socket)
    const held = { socket, close: () => {} }
    watching = held
    held.close = inputs.watch(
      dirname(socket),
      (name) => {
        if (name === null || name === entry) ask()
      },
      () => {
        // Unset, so the next pass, on the backoff, watches again.
        if (watching !== held) return
        watching = null
        if (watchFailed) return
        watchFailed = true
        log('dial: watch unavailable')
      }
    )
    // A watch can start a moment after it returns (macOS) and miss what changed then: link is asked once more.
    if (watching === held) ask()
  }

  function unwatch(): void {
    watching?.close()
    watching = null
  }

  // True when it ends unplugged with the watch on.
  async function pass(abort: AbortController): Promise<boolean> {
    const ran = await launch(abort.signal)
    const link = ran === MISSING ? null : readLink(ran)
    if (!link) set({ state: ran === MISSING ? 'noHarness' : 'notRunning' })
    else if (link.ready) await follow(link.socket, abort)
    else {
      set({ state: 'unplugged' })
      watch(link.socket)
      return watching !== null
    }
    return false
  }

  // The launcher in the home first, then one on PATH, as plugins/harness-device/hooks/device.js looks.
  async function launch(signal: AbortSignal): Promise<Ran> {
    const files = inputs.home ? [`${inputs.home}/.local/bin/harness`, 'harness'] : ['harness']
    for (const file of files) {
      const ran = await inputs.run(file, LINK_ARGS, { path: inputs.path, timeoutMs: LINK_TIMEOUT_MS, maxBytes: LINK_MAX_BYTES, signal })
      if (ran !== MISSING) return ran
    }
    return MISSING
  }

  async function follow(socket: string, abort: AbortController): Promise<void> {
    // On the loop's clock, so a test moves it.
    const cancelHead = inputs.after(HEAD_MS, () => abort.abort())
    const answer = await inputs.connect(socket, DIAL_OPEN, abort.signal)
    cancelHead()
    if (answer?.status !== 200) return set({ state: answer?.status === 409 ? 'elsewhere' : 'notRunning' })
    stream = { socket }
    // A devices process that started again holds no worktree: each open tells it the latest.
    push()
    const opened = inputs.now()
    let skipped = 0
    const tooLong = await eachLine(answer.chunks, (line) => {
      if (line === REPLACED) return false
      const state = lineState(line)
      if (state) set(state)
      else skipped += 1
      return true
    })
    close()
    if (skipped > 0) log(`dial: ${skipped} lines skipped`)
    if (tooLong) log('dial: line too long')
    if (inputs.now() - opened > LAST_WAIT_MS) wait = FIRST_WAIT_MS
  }

  // The devices drop the worktree with the stream: nothing more is sent or logged for it.
  function close(): void {
    const open = stream
    stream = null
    open?.sending?.()
    open?.retry?.cancel()
  }

  // One send at a time, so an older worktree never lands after a newer one: the latest goes once the one in flight
  // answers, unless it waits for its retry or the devices took it. Any other body's retry is dropped. What failed twice
  // waits for other ids or the next stream: a tab renamed gives the same ids again, which a daemon from before orcaFront
  // would refuse each time, so a rename costs no post and no line.
  function push(): void {
    const open = stream
    if (!open || latest === undefined || open.sending || latest === open.retry?.body || latest === open.failed) return
    open.retry?.cancel()
    open.retry = undefined
    open.failed = undefined
    if (latest !== open.sent) void send(open, latest, false)
  }

  async function send(open: Stream, body: string, retried: boolean): Promise<void> {
    const abort = new AbortController()
    // The listener's own deadline, on the loop's clock, so a devices process that hangs holds no later send for ever.
    const cancelHead = inputs.after(HEAD_MS, () => abort.abort())
    open.sending = () => {
      cancelHead()
      abort.abort()
    }
    const status = await inputs.post(open.socket, body, abort.signal)
    cancelHead()
    open.sending = undefined
    if (open !== stream) return
    if (status !== null && status >= 200 && status < 300) {
      open.sent = body
      return push()
    }
    // One with no answer may still land, read by a devices process that stalled past the deadline once it runs again:
    // what they hold is not known, so the latest goes even when it is what they took before.
    if (status === null) open.sent = undefined
    if (body !== latest) push()
    else if (retried) {
      open.failed = body
      log('dial: front not sent')
    } else {
      // A refusal by a daemon from before orcaFront costs one more send and one line, never the stream.
      const cancel = inputs.after(FRONT_RETRY_MS, () => {
        open.retry = undefined
        void send(open, body, true)
      })
      open.retry = { body, cancel }
    }
  }

  if (inputs.platform === 'win32') set({ state: 'windows' })
  else start()

  return {
    state: () => current,
    front(terminals) {
      if (stopped) return
      // Orca's list is outside text: only what the devices take goes, and no title, branch or path.
      const ids = terminals && terminals.filter((id) => typeof id === 'string' && HANDLE.test(id)).slice(0, FRONT_MAX_TERMINALS)
      latest = JSON.stringify({ type: 'orcaFront', terminals: ids })
      push()
    },
    async stop() {
      stopped = true
      cancelNext()
      unwatch()
      passing?.abort()
      // At once: the stream ends a moment after its pass is aborted, and an answer or a retry then would send again.
      close()
      await passDone
    },
  }
}

// link's answer: null for anything but a daemon that is up and a devices' socket that is absent or an absolute path.
function readLink(ran: string | null): Link | null {
  let value: unknown
  try {
    value = JSON.parse(ran ?? '')
  } catch {
    return null
  }
  if (!isRecord(value) || value.daemon !== true) return null
  const socket = value.devicesSocket
  if (socket === undefined) return value.devicesReady === false ? { ready: false } : null
  // Node 22's connect (the end to end test's Node) throws past its own error handler on a NUL in the path; Orca
  // 1.4.256's Node 24 fails it with EINVAL instead.
  if (typeof socket !== 'string' || !socket.startsWith('/') || socket.includes('\0')) return null
  if (typeof value.devicesReady !== 'boolean') return null
  return value.devicesReady ? { ready: true, socket } : { ready: false, socket }
}

// Hands `take` each line until the chunks end or it says stop. A line that would hold more than LINE_BYTES with its
// newline ends them before it is held: true then.
async function eachLine(chunks: AsyncIterable<Uint8Array>, take: (line: string) => boolean): Promise<boolean> {
  let held: Uint8Array = new Uint8Array(0)
  for await (const chunk of chunks) {
    let from = 0
    for (let end = chunk.indexOf(NEWLINE); end !== -1; end = chunk.indexOf(NEWLINE, from)) {
      if (held.length + end - from >= LINE_BYTES) return true
      // Decoded whole, so a character split across two chunks is read as one.
      const line = decoder.decode(joined(held, chunk.subarray(from, end)))
      held = new Uint8Array(0)
      from = end + 1
      if (!take(line)) return false
    }
    if (held.length + chunk.length - from >= LINE_BYTES) return true
    held = joined(held, chunk.subarray(from))
  }
  return false
}

// A copy, so what is held never keeps a whole chunk alive.
function joined(head: Uint8Array, tail: Uint8Array): Uint8Array {
  const all = new Uint8Array(head.length + tail.length)
  all.set(head)
  all.set(tail, head.length)
  return all
}

// A line of the stream as the state it says, or null for any other line.
function lineState(line: string): DialState | null {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return null
  }
  if (!isRecord(value)) return null
  if (value.attached === false) return { state: 'unplugged' }
  if (value.attached !== true) return null
  if (value.agent === null) return { state: 'attached' }
  const agent = value.agent
  if (!isRecord(agent) || typeof agent.name !== 'string' || typeof agent.app !== 'string') return null
  return { state: 'attached', agent: { name: agent.name, app: agent.app } }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function same(a: DialState, b: DialState): boolean {
  return a.state === b.state && a.agent?.name === b.agent?.name && a.agent?.app === b.agent?.app
}
