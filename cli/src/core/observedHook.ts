import { ENGINES, type AgentEngine } from '../engines/types.js'

/**
 * A paneless agent's hook event, checked and bounded here and then handed on. The core keeps nothing of it:
 * which agents exist outside a pane, and what they said, is the devices process's work (observed source),
 * so a flood or a forged body costs the core one small parse and a counter, never state.
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
  log?: (line: string) => void
}

/** How often counts of refused and dropped calls are logged, at most: a flood is one line a minute. */
const REPORT_MS = 60_000

/**
 * Counts of calls refused or dropped, logged as one line a minute at most. Counts only, never a session or a path: what
 * was lost is seen, and what it said stays out of the log.
 */
export function minuteCounts<K extends string>(kinds: readonly K[], line: (counts: Readonly<Record<K, number>>) => string, log: (line: string) => void) {
  const counts = Object.fromEntries(kinds.map((kind) => [kind, 0])) as Record<K, number>
  let report: ReturnType<typeof setTimeout> | null = null
  return (kind: K): void => {
    counts[kind] += 1
    if (report) return
    report = setTimeout(() => {
      log(line(counts))
      for (const each of kinds) counts[each] = 0
      report = null
    }, REPORT_MS)
    // A count waiting to be logged never keeps the daemon from exiting.
    report.unref?.()
  }
}

export function createObservedHook(deps: ObservedHookDeps) {
  const buckets = new Map<string, { tokens: number; at: number }>()

  const take = (key: string, now: number): boolean => {
    let bucket = buckets.get(key)
    if (!bucket) {
      if (buckets.size >= MAX_COUNTERS) for (const [k, b] of buckets) if (now - b.at >= 1000) buckets.delete(k)
      if (buckets.size >= MAX_COUNTERS_HARD) return false
      bucket = { tokens: EVENTS_PER_SECOND, at: now }
      buckets.set(key, bucket)
    }
    // A clock that stepped back refills nothing, rather than owe the bucket the time it went back.
    bucket.tokens = Math.min(EVENTS_PER_SECOND, bucket.tokens + Math.max(0, now - bucket.at) * EVENTS_PER_SECOND / 1000)
    bucket.at = now
    if (bucket.tokens < 1) return false
    bucket.tokens -= 1
    return true
  }

  const tally = minuteCounts(['invalid', 'dropped'] as const,
    (lost) => `[devices] paneless hook events in the last minute: ${lost.invalid} refused, ${lost.dropped} dropped`, deps.log ?? console.warn)
  const count = (result: 'invalid' | 'dropped'): typeof result => {
    tally(result)
    return result
  }

  return {
    onObserved(body: unknown): 'ok' | 'invalid' | 'dropped' {
      const event = parseObservedHook(body)
      if (!event) return count('invalid')
      if (!take(`${event.engine}:${event.sessionId}`, deps.now())) return count('dropped')
      return deps.forward(event) ? 'ok' : count('dropped')
    },
  }
}
