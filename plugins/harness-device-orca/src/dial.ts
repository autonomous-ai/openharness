// The loop behind the panel and the status bar: it asks `harness device orca link` where the devices' socket is,
// holds the `dial` stream open on it, and makes each of its lines the state. Nothing of `orca` is loaded here: the end
// to end test runs this file outside Orca.
import { basename, dirname } from 'node:path'
import type { DialInputs, Ran } from './inputs'
import type { DialState } from './protocol'

export const LINK_ARGS = ['device', 'orca', 'link'] as const
export const DIAL_OPEN = '{"type":"dial","standby":true}'

export interface Dial {
  state(): DialState
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
// The folder watch asks link at most this often.
const WATCH_MS = 1_000

type Link = { ready: false; socket?: string } | { ready: true; socket: string }

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
    passDone = pass(abort).then(() => ended(abort))
  }

  function ended(abort: AbortController): void {
    // What the pass left open, as an answer it did not read, goes with it.
    abort.abort()
    passing = null
    if (stopped) return
    const now = inputs.now()
    const at = again ? Math.max(now, lastStart + WATCH_MS) : now + wait
    wait = Math.min(wait * 2, LAST_WAIT_MS)
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
    const close = inputs.watch(dirname(socket), (name) => {
      if (name === null || name === entry) ask()
    })
    watching = { socket, close }
    // A watch can start a moment after it returns (macOS) and miss what changed then: link is asked once more.
    ask()
  }

  function unwatch(): void {
    watching?.close()
    watching = null
  }

  async function pass(abort: AbortController): Promise<void> {
    const ran = await launch(abort.signal)
    if (ran === 'missing') return set({ state: 'noHarness' })
    const link = readLink(ran)
    if (!link) return set({ state: 'notRunning' })
    if (!link.ready) {
      set({ state: 'unplugged' })
      return watch(link.socket)
    }
    await follow(link.socket, abort)
  }

  // The launcher in the home first, then one on PATH, as plugins/harness-device/hooks/device.js looks.
  async function launch(signal: AbortSignal): Promise<Ran> {
    const files = inputs.home ? [`${inputs.home}/.local/bin/harness`, 'harness'] : ['harness']
    for (const file of files) {
      const ran = await inputs.run(file, LINK_ARGS, { path: inputs.path, timeoutMs: LINK_TIMEOUT_MS, maxBytes: LINK_MAX_BYTES, signal })
      if (ran !== 'missing') return ran
    }
    return 'missing'
  }

  async function follow(socket: string, abort: AbortController): Promise<void> {
    // On the loop's clock, so a test moves it.
    const cancelHead = inputs.after(HEAD_MS, () => abort.abort())
    const answer = await inputs.connect(socket, DIAL_OPEN, abort.signal)
    cancelHead()
    if (answer?.status !== 200) return set({ state: answer?.status === 409 ? 'elsewhere' : 'notRunning' })
    const opened = inputs.now()
    let skipped = 0
    await eachLine(answer.chunks, (line) => {
      if (line === REPLACED) return false
      const state = lineState(line)
      if (state) set(state)
      else skipped += 1
      return true
    })
    if (skipped > 0) log(`dial: ${skipped} lines skipped`)
    if (inputs.now() - opened > LAST_WAIT_MS) wait = FIRST_WAIT_MS
  }

  if (inputs.platform === 'win32') set({ state: 'windows' })
  else start()

  return {
    state: () => current,
    async stop() {
      stopped = true
      cancelNext()
      unwatch()
      passing?.abort()
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
  // Node's connect throws past its own error handler on a NUL in the path.
  if (typeof socket !== 'string' || !socket.startsWith('/') || socket.includes('\0')) return null
  if (typeof value.devicesReady !== 'boolean') return null
  return value.devicesReady ? { ready: true, socket } : { ready: false, socket }
}

// Hands `take` each line until the chunks end or it says stop. A line that would hold more than LINE_BYTES with its
// newline ends them before it is held.
async function eachLine(chunks: AsyncIterable<Uint8Array>, take: (line: string) => boolean): Promise<void> {
  let held: Uint8Array = new Uint8Array(0)
  for await (const chunk of chunks) {
    let from = 0
    for (let end = chunk.indexOf(NEWLINE); end !== -1; end = chunk.indexOf(NEWLINE, from)) {
      if (held.length + end - from >= LINE_BYTES) return
      // Decoded whole, so a character split across two chunks is read as one.
      const line = decoder.decode(joined(held, chunk.subarray(from, end)))
      held = new Uint8Array(0)
      from = end + 1
      if (!take(line)) return
    }
    if (held.length + chunk.length - from >= LINE_BYTES) return
    held = joined(held, chunk.subarray(from))
  }
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
