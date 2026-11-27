import { ENGINES, type AgentEngine } from '../engines/types.js'

/**
 * A paneless agent's hook event, checked and bounded here and then handed on. The core keeps nothing of it:
 * which agents exist outside a pane, and what they said, is the devices process's work (observed source),
 * so a flood or a forged body costs the core one small parse and a counter, never state, and its log a line an event
 * at most 20 times a second across sessions: the rest are counted with the losses, in one line a minute.
 */
export type ObservedEventName = 'session-start' | 'turn-start' | 'needs-input' | 'turn-stop' | 'turn-error' | 'session-end'
  | 'turn-aborted' | 'subagent-start' | 'subagent-stop'

export interface ObservedHookEvent {
  engine: AgentEngine
  sessionId: string
  event: ObservedEventName
  cwd?: string
  callerPid: number
  transcriptPath?: string
  hostHints: Record<string, string>
  /** On turn-start only: another session sent the prompt (hook/notify.mjs), so no person typed it. */
  relayed?: boolean
  /** On session-start and turn-start only: the session's own name for itself, handed on and kept nowhere here. */
  title?: string
}

/**
 * A permission prompt that waits, from the plugin's hook client (deviceClaude/asked.ts) rather than the session's own
 * hook: it sends no process and no environment, so where the session runs stays its own hooks' to say. The dial shows it,
 * and nothing answers it there.
 */
export interface ObservedAsked {
  engine: AgentEngine
  sessionId: string
  event: 'asked'
  cwd?: string
  /** The tool the prompt is for, and one line of what it acts on. */
  tool?: string
  summary?: string
}

export type ObservedEvent = ObservedHookEvent | ObservedAsked

const EVENTS: readonly string[] = ['session-start', 'turn-start', 'needs-input', 'asked', 'turn-stop', 'turn-error', 'session-end',
  'turn-aborted', 'subagent-start', 'subagent-stop']
const MAX_SESSION_ID = 128
const MAX_PATH = 1024
const MAX_TOOL = 64
/** UTF-16 units, as `bounded` counts them; the hook cuts a title to as many (hook/notify.mjs), so it never sends a longer one. */
export const MAX_TITLE = 64
/** Bytes, as the dial holds its line in a byte buffer. */
const MAX_SUMMARY_BYTES = 200
/** The hook caps what it sends at this number (hook/notify.mjs MAX_HINTS): its list holds more names, and it sends the first of those set. */
export const MAX_HINTS = 10
const MAX_HINT_VALUE = 64
/** Events a session may send a second; the rest are dropped, so parallel tool calls or a stuck engine repeating Stop cannot flood the devices. */
const EVENTS_PER_SECOND = 20
/** Sessions whose counter is kept at once; a counter idle for a second is full again, so it is forgotten rather than stored. */
const MAX_COUNTERS = 256
const MAX_COUNTERS_HARD = 1024
/** Events a second noted in a line each, across sessions: each session's rate bounds only its own, and 1024 sessions
 *  at once were 20,480 lines a second. The rest are counted in the minute's line. */
const NOTES_PER_SECOND = 20

/** Same rule as hookServer's optionalBoundedString: a bounded string with no control character (a path or id with one is forged). */
export const bounded = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value)

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

export function parseObservedHook(body: unknown): ObservedEvent | null {
  if (!isRecord(body)) return null
  const { engine, sessionId, event, cwd, callerPid, transcriptPath, hostHints, tool, summary, relayed, title } = body
  if (typeof engine !== 'string' || !(ENGINES as readonly string[]).includes(engine)) return null
  if (!bounded(sessionId, MAX_SESSION_ID) || sessionId === '') return null
  if (typeof event !== 'string' || !EVENTS.includes(event)) return null
  if (cwd !== undefined && !bounded(cwd, MAX_PATH)) return null
  // Only a prompt's turn can have been relayed: anything else that says so is forged.
  if (relayed !== undefined && (event !== 'turn-start' || typeof relayed !== 'boolean')) return null
  // Only the two events the hook says a title on carry one: anything else that does is forged.
  if (title !== undefined && ((event !== 'session-start' && event !== 'turn-start') || !bounded(title, MAX_TITLE) || title === '')) return null
  if (event === 'asked') {
    if (tool !== undefined && !bounded(tool, MAX_TOOL)) return null
    if (summary !== undefined && (!bounded(summary, MAX_SUMMARY_BYTES) || Buffer.byteLength(summary) > MAX_SUMMARY_BYTES)) return null
    return {
      engine: engine as AgentEngine, sessionId, event,
      ...(cwd === undefined ? {} : { cwd }), ...(tool === undefined ? {} : { tool }), ...(summary === undefined ? {} : { summary }),
    }
  }
  if (typeof callerPid !== 'number' || !Number.isSafeInteger(callerPid) || callerPid <= 0) return null
  if (transcriptPath !== undefined && !bounded(transcriptPath, MAX_PATH)) return null
  if (!isRecord(hostHints)) return null
  const entries = Object.entries(hostHints)
  if (entries.length > MAX_HINTS) return null
  const hints: Record<string, string> = {}
  for (const [key, value] of entries) {
    if (!bounded(key, MAX_HINT_VALUE) || !bounded(value, MAX_HINT_VALUE)) return null
    hints[key] = value
  }
  return {
    engine: engine as AgentEngine, sessionId, event: event as ObservedEventName,
    ...(cwd === undefined ? {} : { cwd }), callerPid,
    ...(transcriptPath === undefined ? {} : { transcriptPath }), hostHints: hints,
    ...(relayed === undefined ? {} : { relayed }), ...(title === undefined ? {} : { title }),
  }
}

export interface ObservedHookDeps {
  /** Hand the event to the devices process; false when it is not there (the event is dropped). */
  forward: (event: ObservedEvent) => boolean
  now: () => number
  /** Losses, a few lines a minute at most. */
  log?: (line: string) => void
  /** One line per handled event, NOTES_PER_SECOND a second at most: it says what happened to an event without its
   *  session or path. */
  note?: (line: string) => void
}

/** How long losses are counted after the first one, before their count is logged: a flood is a few lines a minute. */
const REPORT_MS = 60_000

/**
 * Each loss: said at once when [lines.now] gives a line and its kind was not said in this minute, else counted. A minute
 * after the first loss, one line of the counts, only when one was counted. Counts and fixed text only, never a session or
 * a path: what was lost is seen when it happens, and what it said stays out of the log.
 */
export function minuteCounts<K extends string>(kinds: readonly K[],
  lines: { now: (kind: K) => string | null; minute: (counts: Readonly<Record<K, number>>) => string },
  log: (line: string) => void): (kind: K) => void {
  const counts = Object.fromEntries(kinds.map((kind) => [kind, 0])) as Record<K, number>
  const said = new Set<K>()
  let report: ReturnType<typeof setTimeout> | null = null
  return (kind: K): void => {
    const line = said.has(kind) ? null : lines.now(kind)
    if (line === null) counts[kind] += 1
    else {
      said.add(kind)
      log(line)
    }
    if (report) return
    report = setTimeout(() => {
      if (kinds.some((each) => counts[each] > 0)) log(lines.minute(counts))
      for (const each of kinds) counts[each] = 0
      said.clear()
      report = null
    }, REPORT_MS)
    // A count waiting to be logged never keeps the daemon from exiting.
    report.unref?.()
  }
}

interface Bucket { tokens: number; at: number }

/** One of a bucket's tokens, which refill at `perSecond`; false when none is left. */
function spend(bucket: Bucket, now: number, perSecond: number): boolean {
  // A clock that stepped back refills nothing, rather than owe the bucket the time it went back.
  bucket.tokens = Math.min(perSecond, bucket.tokens + Math.max(0, now - bucket.at) * perSecond / 1000)
  bucket.at = now
  if (bucket.tokens < 1) return false
  bucket.tokens -= 1
  return true
}

export function createObservedHook(deps: ObservedHookDeps) {
  const buckets = new Map<string, Bucket>()
  const notes: Bucket = { tokens: NOTES_PER_SECOND, at: deps.now() }

  const take = (key: string, now: number): boolean => {
    let bucket = buckets.get(key)
    if (!bucket) {
      if (buckets.size >= MAX_COUNTERS) for (const [k, b] of buckets) if (now - b.at >= 1000) buckets.delete(k)
      if (buckets.size >= MAX_COUNTERS_HARD) return false
      bucket = { tokens: EVENTS_PER_SECOND, at: now }
      buckets.set(key, bucket)
    }
    return spend(bucket, now, EVENTS_PER_SECOND)
  }

  // A machine with no dial has no devices process, so no devices is said once a devices-down period, not per event; the
  // daemon's start counts as devices seen up.
  let devicesUp = true
  const tally = minuteCounts(['invalid', 'over', 'no-devices', 'unnoted'] as const, {
    // A refused body is a broken or forged hook, whose events are lost as the others' are: said at once as well, as a
    // refused dial hook call is (deviceHookCalls.ts).
    now: (kind) => kind === 'invalid' ? '[devices] a paneless hook event was refused; more are counted once a minute'
      : kind === 'over'
        ? `[devices] a paneless hook event was dropped: over ${EVENTS_PER_SECOND} a second for its session; more are counted once a minute`
        : kind === 'no-devices' && devicesUp ? '[devices] a paneless hook event was dropped: no devices process; more are counted once a minute'
          : null,
    minute: (lost) => `[devices] paneless hook events in the last minute: ${lost.invalid} refused, ${lost.over} over the rate, `
      + `${lost['no-devices']} with no devices process, ${lost.unnoted} handled without a line`,
  }, deps.log ?? console.warn)
  const note = deps.note ?? console.log

  return {
    onObserved(body: unknown): 'ok' | 'invalid' | 'dropped' {
      const event = parseObservedHook(body)
      if (!event) {
        tally('invalid')
        return 'invalid'
      }
      const now = deps.now()
      if (!take(`${event.engine}:${event.sessionId}`, now)) {
        tally('over')
        return 'dropped'
      }
      const forwarded = deps.forward(event)
      if (spend(notes, now, NOTES_PER_SECOND)) note(`[hooks] paneless ${event.engine} ${event.event} · ${forwarded ? 'forwarded' : 'no devices'}`)
      else tally('unnoted')
      if (forwarded) {
        devicesUp = true
        return 'ok'
      }
      tally('no-devices')
      devicesUp = false
      return 'dropped'
    },
  }
}
