// The loop behind the extension: it asks `harness device vscode link` where the devices listen (their socket, or on
// Windows their pipe and its token), holds this window's `vscode` stream open there, reports the window's shells on
// connections of their own, and shows or scrolls the terminal a line names, or presses its page keys, raising the
// window for a tap's show. Nothing of `vscode` is loaded here: the end to end test runs this file outside VS Code.
import { posix, win32 } from 'node:path'
import { MISSING, type LoopInputs, type Ran, type Target } from './inputs'
import { PIPE, TOKEN } from './pipeAuth'
import type { WindowFacade } from './window'

export type LoopState = 'noHarness' | 'notRunning' | 'unplugged' | 'connected'

export interface Loop {
  /** Ends the loop: nothing is told or logged once it is called. Resolves when the pass in flight has ended. */
  stop(): Promise<void>
}

const LINK_ARGS = ['device', 'vscode', 'link'] as const
const LINK_TIMEOUT_MS = 5_000
const LINK_MAX_BYTES = 4_096
// The listener's own deadline for an open.
const HEAD_MS = 2_000
// A line with its newline: no more is ever held.
const LINE_BYTES = 1_024
const NEWLINE = 0x0a
const FIRST_WAIT_MS = 1_000
const LAST_WAIT_MS = 30_000
// Unplugged with the watch on: the watch asks as the socket or the record appears, so link is looked at again only in
// case the daemon stops.
const WATCHED_WAIT_MS = 300_000
// The folder watch asks link at most this often.
const WATCH_MS = 1_000
// A window's changes come in bursts (a terminal opens, its shell's pid resolves, it becomes active): one state a slot,
// the latest, keeps under the listener's 8 a second.
const REPORT_MS = 250
// The listener refuses the state of a window whose stream it no longer holds: a stream opened again sends it again.
const REFUSED_IN_A_ROW = 3
const COUNTS_MS = 60_000
// The devices write at most this many lines in one scroll line (VSCODE_SCROLL_MAX): no more runs from one, or from what
// waits.
const SCROLL_MAX = 100
// The lines one page key stands for: Herdr's 8 since #4436 (SCROLL_PAGE_LINES, cli/src/cable/hosts/herdrApp.ts), so
// about half a screen follows about 8 lines of the finger. A constant of its own: the extension is bundled alone and
// imports nothing of the CLI.
const PAGE_LINES = 8
// The most keys one line makes: a fling stops when the finger stops, not pages later.
const LINE_KEYS_MAX = 5
// A shell's page remainder is forgotten once no page line came for this long.
const PAGE_IDLE_MS = 1_000

/** `watch` is the file whose entry says the devices may be ready: their socket, or on Windows their record. */
type Link = { ready: false; watch?: string } | { ready: true; target: Target }
type Counts = { shows: number; notFound: number; skipped: number; sent: number; notSent: number; pageKeys: number; scrollLines: number; dropped: number }
/** Whole lines for the terminal of the shell `pid`, from `from` scroll lines of the stream that have done nothing yet. */
type Scroll = { pid: number; n: number; from: number }
/** The page keys a scroll line of `n` lines for the shell `pid` makes: none unless it is a page line. */
type Pages = (pid: number, n: number, page: boolean) => number

const decoder = new TextDecoder()

/** Null in a remote window: nothing starts. */
export function startLoop(
  inputs: LoopInputs,
  window: WindowFacade,
  tell: { changed(state: LoopState): void; log(line: string): void }
): Loop | null {
  // A remote window's terminals are another computer's.
  if (window.remote) return null
  const windows = inputs.platform === 'win32'
  // The given platform's paths, not the host's: the tests run each platform's on any.
  const paths = windows ? win32 : posix
  const open = JSON.stringify({ type: 'vscode', window: inputs.windowId })
  let current: LoopState | undefined
  let stopped = false
  let passing: AbortController | null = null
  let passDone = Promise.resolve()
  let lastStart = 0
  // The watch asked while a pass ran: one more pass follows it, unless the watch has closed since.
  let again = false
  let wait = FIRST_WAIT_MS
  let nextAt = Infinity
  let cancelNext = () => {}
  let watching: { file: string; close(): void } | null = null
  let counts = noCounts()
  let cancelCounts: (() => void) | null = null
  // One scroll run at a time; what comes during it waits, as one run.
  let scrolling = false
  let waiting: Scroll | null = null

  function log(line: string): void {
    if (!stopped) tell.log(line)
  }

  function set(next: LoopState): void {
    if (stopped || next === current) return
    log(`state: ${next}`)
    if (next !== 'unplugged') unwatch()
    current = next
    tell.changed(next)
  }

  // The minute's counts are logged a minute after its first event, so a quiet window logs nothing.
  function count(what: keyof Counts, by = 1): void {
    if (stopped) return
    counts[what] += by
    if (cancelCounts) return
    cancelCounts = inputs.after(COUNTS_MS, () => {
      const { shows, notFound, skipped, sent, notSent, pageKeys, scrollLines, dropped } = counts
      counts = noCounts()
      cancelCounts = null
      log(
        `in the last minute: ${shows} shows, ${notFound} not found, ${skipped} lines skipped, ${sent} states sent, ${notSent} not sent, ${pageKeys} page keys, ${scrollLines} scroll lines, ${dropped} dropped`
      )
    })
  }

  // VS Code's scroll commands act on the active terminal, so lines run only while it is the one they name: asked before
  // each line, since a click or a show can make another one active mid-run. A key goes to its own terminal, yet only
  // while that one is active, as a line.
  function active(pid: number): boolean {
    return !stopped && window.state().active === pid
  }

  // A line's keys (below zero PageUp) go at once, never behind a run: fullscreen's move does not wait on host scrolls
  // that do nothing on its alternate screen, and no key is left to follow a later line with no page. Its lines for the
  // shell that waits are added to it, to their bound; lines for another shell replace it, and what it held ran nothing.
  function scroll(pid: number, n: number, keys: number): void {
    let pressed = 0
    try {
      for (; pressed < Math.abs(keys) && active(pid) && window.pageKey(pid, keys < 0); pressed += 1) count('pageKeys')
    } catch {
      // VS Code refused a key: the rest would be refused as well.
    }
    // A line whose keys went is no drop, whatever comes of its lines.
    const next = { pid, n, from: pressed > 0 ? 0 : 1 }
    if (!scrolling) return void run(next)
    if (waiting?.pid === pid) waiting = { pid, n: held(waiting.n + n, SCROLL_MAX), from: waiting.from + next.from }
    else {
      if (waiting) count('dropped', waiting.from)
      waiting = next
    }
  }

  async function run(first: Scroll): Promise<void> {
    scrolling = true
    for (let next: Scroll | null = first; next; next = waiting) {
      waiting = null
      const { pid, n } = next
      let ran = 0
      try {
        for (; ran < Math.abs(n) && active(pid); ran += 1) {
          await window.scrollLine(n < 0)
          count('scrollLines')
        }
      } catch {
        // VS Code refused a command: the rest of the run would be refused as well.
      }
      if (ran === 0) count('dropped', next.from)
    }
    scrolling = false
  }

  // A stream's page remainder: what a shell's page lines hold short of a key, kept for its next page line. One per
  // stream, so the stream's end forgets it.
  function pager(): Pages {
    let left: { pid: number; lines: number; at: number } | null = null
    return (pid, n, page) => {
      if (!page) {
        left = null
        return 0
      }
      const now = inputs.now()
      // A page line for another shell, or one after a pause, starts from 0.
      const lines = n + (left?.pid === pid && now - left.at < PAGE_IDLE_MS ? left.lines : 0)
      // Past the keys' bound, what is left of the line's travel is clipped: under one key carries on.
      left = { pid, lines: lines % PAGE_LINES, at: now }
      return held(Math.trunc(lines / PAGE_LINES), LINE_KEYS_MAX)
    }
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
    // Unplugged with the watch on is no failure: the watch asks as the socket or the record appears, link is looked at
    // again only in case the daemon stops, and a stream that ends soon after waits from 1 s, not from a wait grown
    // meanwhile.
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

  // The devices' socket, or on Windows their record, appears in its folder once a dial is plugged in: its entry asks
  // link again.
  function watch(file: string | undefined): void {
    if (stopped || watching?.file === file) return
    unwatch()
    if (file === undefined) return
    const entry = paths.basename(file)
    const held = { file, close: () => {} }
    watching = held
    held.close = inputs.watch(
      paths.dirname(file),
      (name) => {
        if (name === null || name === entry) ask()
      },
      () => {
        // Unset, so the next pass, on the backoff, watches again.
        if (watching === held) watching = null
      }
    )
    // A watch can start a moment after it returns (macOS) and miss what changed then: link is asked once more.
    if (watching === held) ask()
  }

  function unwatch(): void {
    watching?.close()
    watching = null
    again = false
  }

  // Ends the loop for good: by stop, or by a line that says another holder has this window's id.
  function halt(): void {
    stopped = true
    waiting = null
    cancelNext()
    cancelCounts?.()
    unwatch()
    passing?.abort()
  }

  // True when it ends unplugged with the watch on.
  async function pass(abort: AbortController): Promise<boolean> {
    const ran = await launch(abort.signal)
    const link = ran === MISSING ? null : readLink(ran, windows)
    if (!link) set(ran === MISSING ? 'noHarness' : 'notRunning')
    else if (link.ready) await follow(link.target, abort)
    else {
      set('unplugged')
      watch(link.watch)
      return watching !== null
    }
    return false
  }

  // The launcher in the home first (where Harness installs it: ~/.local/bin, on Windows %USERPROFILE%\.harness\bin),
  // then one on PATH, as plugins/harness-device/hooks/device.js looks. Only absolute folders: a relative or empty one
  // is the extension host's working folder, which can be the folder VS Code opened, in Restricted Mode an untrusted one.
  const path = inputs.path.split(paths.delimiter).filter((folder) => paths.isAbsolute(folder)).join(paths.delimiter)
  const launcher = windows ? ['.harness', 'bin', 'harness.exe'] : ['.local', 'bin', 'harness']
  async function launch(signal: AbortSignal): Promise<Ran> {
    const files = paths.isAbsolute(inputs.home) ? [paths.join(inputs.home, ...launcher), 'harness'] : ['harness']
    for (const file of files) {
      const ran = await inputs.run(file, LINK_ARGS, { path, timeoutMs: LINK_TIMEOUT_MS, maxBytes: LINK_MAX_BYTES, signal })
      if (ran !== MISSING) return ran
    }
    return MISSING
  }

  async function follow(target: Target, abort: AbortController): Promise<void> {
    // On the loop's clock, so a test moves it.
    const cancelHead = inputs.after(HEAD_MS, () => abort.abort())
    const answer = await inputs.connect(target, open, abort.signal)
    cancelHead()
    // 409 is a ninth window, 404 a daemon older than this extension: both wait as any other failure.
    if (answer?.status !== 200) return set('notRunning')
    set('connected')
    const opened = inputs.now()
    const reports = report(target, abort)
    const pages = pager()
    const tooLong = await eachLine(answer.chunks, (line) => take(line, pages))
    reports.end()
    if (tooLong) count('skipped')
    if (inputs.now() - opened > LAST_WAIT_MS) wait = FIRST_WAIT_MS
  }

  // False once the stream is to be read no more.
  function take(line: string, pages: Pages): boolean {
    const value = parsed(line)
    if (value?.replaced === true) {
      // Only a second open of this window's id is answered so: this activation is no longer the window's.
      halt()
      return false
    }
    if (value && Number.isInteger(value.show)) {
      const shown = window.show(value.show as number)
      // Only once the terminal is shown: the window raised is the one that holds it.
      if (shown && value.raise === true) window.raise()
      count(shown ? 'shows' : 'notFound')
    } else if (value && Number.isInteger(value.scroll) && value.scroll !== 0 && Number.isInteger(value.pid)) {
      const pid = value.pid as number
      const n = held(value.scroll as number, SCROLL_MAX)
      // Only true makes a page line: an older or newer devices' other value scrolls as a plain line.
      scroll(pid, n, pages(pid, n, value.page === true))
    } else count('skipped')
    return true
  }

  // The window's state, once the stream's head has come and then at each change: the latest only, one post at a time,
  // at most one a slot, never one the devices took last.
  function report(target: Target, abort: AbortController): { end(): void } {
    let taken = ''
    let lastAt = -Infinity
    let posting = false
    let refused = 0
    let cancelSlot: (() => void) | null = null
    let over = false

    function next(): void {
      if (over || stopped || posting || cancelSlot) return
      const body = stateBody()
      if (body === taken) return
      const ms = lastAt + REPORT_MS - inputs.now()
      if (ms > 0) {
        cancelSlot = inputs.after(ms, () => {
          cancelSlot = null
          next()
        })
        return
      }
      void send(body)
    }

    async function send(body: string): Promise<void> {
      posting = true
      lastAt = inputs.now()
      const status = await inputs.post(target, body, abort.signal)
      posting = false
      if (over || stopped) return
      if (status !== null && status >= 200 && status < 300) {
        taken = body
        refused = 0
        count('sent')
      } else {
        count('notSent')
        refused += 1
        if (refused === REFUSED_IN_A_ROW) return abort.abort()
      }
      next()
    }

    const unsubscribe = window.onChange(next)
    next()
    return {
      end() {
        over = true
        unsubscribe()
        cancelSlot?.()
        cancelSlot = null
      },
    }
  }

  function stateBody(): string {
    const { terminals, active, focused } = window.state()
    return JSON.stringify({ type: 'vscode-state', window: inputs.windowId, terminals, active, focused })
  }

  start()

  return {
    async stop() {
      halt()
      await passDone
    },
  }
}

function noCounts(): Counts {
  return { shows: 0, notFound: 0, skipped: 0, sent: 0, notSent: 0, pageKeys: 0, scrollLines: 0, dropped: 0 }
}

function held(n: number, max: number): number {
  return Math.max(-max, Math.min(max, n))
}

// link's answer: null for anything but a daemon that is up and, on Windows, an absolute record with, once the devices
// are ready, their pipe and token; elsewhere a devices' socket that is absent or an absolute path.
function readLink(ran: string | null, windows: boolean): Link | null {
  let value: unknown
  try {
    value = JSON.parse(ran ?? '')
  } catch {
    return null
  }
  if (!isRecord(value) || value.daemon !== true) return null
  if (windows) return readWindowsLink(value)
  const socket = value.devicesSocket
  if (socket === undefined) return value.devicesReady === false ? { ready: false } : null
  // Node's connect throws past its own error handler on a NUL in the path.
  if (typeof socket !== 'string' || !socket.startsWith('/') || socket.includes('\0')) return null
  if (typeof value.devicesReady !== 'boolean') return null
  return value.devicesReady ? { ready: true, target: { socket } } : { ready: false, watch: socket }
}

// Only a pipe on this computer is dialled: a `\\host\pipe\` name would open a connection to another one.
function readWindowsLink(value: Record<string, unknown>): Link | null {
  const { devicesPipe: pipe, devicesToken: token, devicesReady: ready, devicesRecord: record } = value
  if (typeof record !== 'string' || !win32.isAbsolute(record)) return null
  if (ready === false) return { ready: false, watch: record }
  if (ready !== true || typeof pipe !== 'string' || !PIPE.test(pipe) || typeof token !== 'string' || !TOKEN.test(token)) return null
  return { ready: true, target: { pipe, token } }
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

function parsed(line: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line)
    return isRecord(value) ? value : null
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
