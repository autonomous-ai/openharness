/**
 * cmux's front workspace and the surface focused in it, read from cmux's own event log, so the dial can follow cmux's
 * focus (docs/plans/2026-11-25-dial-cmux-focus-follow-design.md). cmux's socket would say it too, but in its default
 * mode, `cmuxOnly`, it refuses every process cmux did not start, the daemon among them; cmux appends every event to
 * `~/.cmuxterm/events.jsonl` whatever the mode, one JSON object a line.
 *
 * The log is another program's file, and its lines name people's work: workspace titles, folders, prompt previews. So it
 * is opened read-only and never written, truncated, renamed or deleted; a line is parsed only when it names one of the
 * eight events that move the focus; of those only the event's name, its boot id and its workspace, surface and window ids
 * are taken; and a log line says fixed words and a number, never what was read (PM, 2026-11-25).
 *
 * Each read takes only what cmux appended since the last, and at most the newest 1 MiB, so a working agent's hooks,
 * which append many lines a second, cost a small read each. One read runs at a time.
 */
import { close, constants, fstat, open, read } from 'node:fs'
import { promisify } from 'node:util'
import { CMUX_ID } from './hostDetect.js'

/** The log's name in cmux's folder (cmuxCli.ts cmuxStoreDir). */
export const CMUX_EVENTS = 'events.jsonl'
/** The most one read takes: the log's newest bytes when more came since the last read. */
export const MAX_EVENTS_READ = 1024 * 1024
/** cmux's own cap on a line (CmuxEventBus.swift `defaultMaxEventLineBytes`): a longer one is not one of its events. */
export const MAX_EVENT_LINE = 16 * 1024
/** The workspaces whose focused surface is kept: past them, the one least recently set goes. */
export const MAX_WORKSPACES = 256
/** The cmux windows kept: past them, the one least recently seen goes. */
export const MAX_WINDOWS = 16

/** The events that move cmux's focus, as a line of one holds its name: a line holding none of these is never parsed. */
const NAMES = ['surface.focused', 'pane.focused', 'workspace.selected', 'window.keyed', 'window.created',
  'window.closed', 'surface.closed', 'workspace.closed'].map((name) => Buffer.from(`"name":"${name}"`))
const NEWLINE = 0x0a
const NOTHING = Buffer.alloc(0)
const GAP = '[cmux] events · gap'

/** The log's file by descriptor; injected so specs read a log in memory (testing/fakeCmux.ts fakeCmuxLog). */
export interface CmuxLogFiles {
  open(path: string): Promise<number>
  fstat(fd: number): Promise<{ dev: number; ino: number; size: number }>
  /** Reads into `into`, at most its length, from `position`; the count read. */
  read(fd: number, into: Buffer, position: number): Promise<number>
  close(fd: number): Promise<void>
}

/** The log on disk, opened read-only: Harness never writes, truncates, renames or deletes cmux's file. */
export function cmuxLogFiles(): CmuxLogFiles {
  const opening = promisify(open)
  const stating = promisify(fstat)
  const reading = promisify(read)
  const closing = promisify(close)
  return {
    open: (path) => opening(path, constants.O_RDONLY),
    fstat: async (fd) => {
      const { dev, ino, size } = await stating(fd)
      return { dev, ino, size }
    },
    read: async (fd, into, position) => (await reading(fd, into, 0, into.length, position)).bytesRead,
    close: (fd) => closing(fd),
  }
}

/** cmux's front workspace and the surface focused in it, in lower case; either unknown. */
export type CmuxFront = { workspace?: string; surface?: string }

export interface CmuxFocusDeps {
  files: CmuxLogFiles
  /** `~/.cmuxterm/events.jsonl`. */
  path: string
  monotonic(): number
  log(line: string): void
}

export interface CmuxFocus {
  /** The front as the log says it now. It never throws: a log that cannot be read is a front unknown. */
  read(): Promise<CmuxFront>
  /** Forgets all it knows, and a read under way commits nothing: the next read is a first one. */
  reset(): void
}

/** What one read leaves for the next. */
interface Kept {
  /** The file read, and how far. */
  dev: number
  ino: number
  offset: number
  /** The last line's bytes so far, its newline not yet written; or, once they passed 16 KiB, that line is skipped. */
  partial: Buffer
  skipping: boolean
  /** The boot id of the last event taken: another one is cmux restarted. */
  boot?: string
  front?: string
  /** Each workspace's focused surface, the least recently set first. */
  surfaces: Map<string, string>
  /** The cmux windows known, the least recently seen first. */
  windows: Set<string>
}

/** A read's bytes, and whether they go on from what was kept; or no log, or a read that failed. */
type Loaded = { dev: number; ino: number; from: number; bytes: Buffer; resumed: boolean } | 'missing' | 'failed'

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined

/** An id in cmux's form, in lower case: cmux prints upper case, and a hook may hold either. */
const idOf = (value: unknown): string | undefined =>
  typeof value === 'string' && CMUX_ID.test(value) ? value.toLowerCase() : undefined

/** A workspace's focused surface, set as the most recent; past the bound, the least recent goes. */
function focus(state: Kept, workspace: string, surface: string): void {
  state.surfaces.delete(workspace)
  state.surfaces.set(workspace, surface)
  if (state.surfaces.size > MAX_WORKSPACES) state.surfaces.delete(state.surfaces.keys().next().value as string)
}

/** A window, seen as the most recent; past the bound, the least recent goes. */
function seen(state: Kept, window: string): void {
  state.windows.delete(window)
  state.windows.add(window)
  if (state.windows.size > MAX_WINDOWS) state.windows.delete(state.windows.values().next().value as string)
}

/** The change a focus event makes, once every id it uses is in form; else none. Nothing else of the event is taken. */
function changeOf(event: Record<string, unknown>): ((state: Kept) => void) | undefined {
  const workspace = idOf(event.workspace_id)
  const surface = idOf(event.surface_id)
  const window = idOf(event.window_id)
  const payload = record(event.payload)
  switch (event.name) {
    case 'surface.focused':
      return workspace && surface ? (state) => focus(state, workspace, surface) : undefined
    case 'pane.focused': {
      const shown = idOf(payload?.selected_surface_id)
      return workspace && shown ? (state) => focus(state, workspace, shown) : undefined
    }
    // It names no window: with two or more known, the selection may be in one behind the key window, and a front
    // unknown until the next window.keyed misses a move where following it could be wrong (PM, 2026-11-25).
    case 'workspace.selected':
      return workspace ? (state) => { state.front = state.windows.size <= 1 ? workspace : undefined } : undefined
    case 'window.keyed': {
      const front = idOf(payload?.workspace_id)
      return window && front
        ? (state) => {
          seen(state, window)
          state.front = front
        }
        : undefined
    }
    case 'window.created':
      return window ? (state) => seen(state, window) : undefined
    case 'window.closed':
      return window ? (state) => { state.windows.delete(window) } : undefined
    case 'surface.closed':
      return surface
        ? (state) => { for (const [at, focused] of state.surfaces) if (focused === surface) state.surfaces.delete(at) }
        : undefined
    case 'workspace.closed':
      return workspace
        ? (state) => {
          state.surfaces.delete(workspace)
          if (state.front === workspace) state.front = undefined
        }
        : undefined
    default:
      return undefined
  }
}

/** Applies a line when it is one of the eight events, with its boot id and every id it uses in form. */
function apply(state: Kept, line: Buffer): void {
  if (!NAMES.some((name) => line.includes(name))) return
  let event: Record<string, unknown> | undefined
  try {
    event = record(JSON.parse(line.toString('utf8')))
  } catch {
    return
  }
  const boot = idOf(event?.boot_id)
  const change = event?.type === 'event' && boot ? changeOf(event) : undefined
  if (!change) return
  // cmux restarted: what it said before is gone, and it publishes each workspace's focus again.
  if (state.boot !== undefined && state.boot !== boot) {
    state.front = undefined
    state.surfaces.clear()
    state.windows.clear()
  }
  state.boot = boot
  change(state)
}

/** Takes the whole lines of a read, and carries the last one's start to the next read. */
function take(state: Kept, bytes: Buffer): void {
  const text = state.partial.length > 0 ? Buffer.concat([state.partial, bytes]) : bytes
  let begin = 0
  for (let end = text.indexOf(NEWLINE); end !== -1; end = text.indexOf(NEWLINE, begin)) {
    if (!state.skipping && end - begin <= MAX_EVENT_LINE) apply(state, text.subarray(begin, end))
    state.skipping = false
    begin = end + 1
  }
  const rest = text.subarray(begin)
  // A line longer than cmux writes is not carried, so a read keeps at most 16 KiB: its bytes are skipped to its end.
  state.skipping ||= rest.length > MAX_EVENT_LINE
  // A copy, so the read's 1 MiB is not held for the few bytes kept.
  state.partial = state.skipping ? NOTHING : Buffer.from(rest)
}

const frontOf = (state: Kept): CmuxFront => {
  if (state.front === undefined) return {}
  const surface = state.surfaces.get(state.front)
  return surface === undefined ? { workspace: state.front } : { workspace: state.front, surface }
}

export function createCmuxFocus(deps: CmuxFocusDeps): CmuxFocus {
  let kept: Kept | undefined
  /** Bumped at each reset: a read begun before one commits nothing. */
  let epoch = 0
  /** Whether the last read failed. A log that cannot be read fails each read while cmux writes it, many a second, so
   *  its gap is said once until a read succeeds. */
  let failing = false
  /** The slowest read said since the last reset. */
  let slowest: number | undefined
  let current: Promise<CmuxFront> | undefined
  let next: Promise<CmuxFront> | undefined

  /** The new bytes: from the offset kept, when the file is the one read and at most 1 MiB came since; else its newest
   *  1 MiB. The descriptor is closed whatever happens. */
  async function load(): Promise<Loaded> {
    let fd: number
    try {
      fd = await deps.files.open(deps.path)
    } catch (error) {
      return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT' ? 'missing' : 'failed'
    }
    try {
      const { dev, ino, size } = await deps.files.fstat(fd)
      const resumed = kept !== undefined && kept.dev === dev && kept.ino === ino && size >= kept.offset
        && size - kept.offset <= MAX_EVENTS_READ
      const from = resumed && kept ? kept.offset : Math.max(0, size - MAX_EVENTS_READ)
      const into = Buffer.alloc(size - from)
      const count = into.length > 0 ? await deps.files.read(fd, into, from) : 0
      return { dev, ino, from, bytes: into.subarray(0, count), resumed }
    } catch {
      return 'failed'
    } finally {
      // The read is over either way; a close that fails leaves nothing to do.
      await deps.files.close(fd).catch(() => {})
    }
  }

  async function once(): Promise<CmuxFront> {
    const at = epoch
    const began = deps.monotonic()
    const loaded = await load()
    if (at !== epoch) return {}
    if (loaded === 'missing') {
      // cmux has written no log since its folder was made, or it was removed: nothing is known, and no gap to say.
      kept = undefined
      failing = false
      return {}
    }
    if (loaded === 'failed') {
      if (!failing) deps.log(GAP)
      failing = true
      kept = undefined
      return {}
    }
    failing = false
    let state = loaded.resumed ? kept : undefined
    if (!state) {
      // What was kept no longer leads to these bytes: the log rotated, was cut short, or more came than one read takes.
      // A first read loses nothing, so it says nothing. The line the read starts in may have begun before it.
      if (kept) deps.log(GAP)
      state = { dev: loaded.dev, ino: loaded.ino, offset: loaded.from, partial: NOTHING, skipping: loaded.from > 0,
        surfaces: new Map(), windows: new Set() }
      kept = state
    }
    take(state, loaded.bytes)
    state.offset = loaded.from + loaded.bytes.length
    timed(deps.monotonic() - began)
    return frontOf(state)
  }

  /** The first read after a reset, then only one slower than every one said: the number the read's target needs, not a
   *  line per hook of a working agent (as cmuxSource.ts says its own). */
  function timed(ms: number): void {
    if (slowest !== undefined && ms <= slowest) return
    slowest = ms
    deps.log(`[cmux] read · events · ${Math.round(ms)}`)
  }

  function start(): Promise<CmuxFront> {
    const run: Promise<CmuxFront> = once().finally(() => { if (current === run) current = undefined })
    current = run
    return run
  }

  return {
    // A change while a read runs may have come after its fstat: one more read after it takes it, shared by every ask
    // meanwhile, so a working agent's lines never pile up reads.
    read: () => {
      if (next) return next
      if (!current) return start()
      next = current.then(() => {
        next = undefined
        return start()
      })
      return next
    },
    reset: () => {
      epoch++
      kept = undefined
      failing = false
      slowest = undefined
    },
  }
}
