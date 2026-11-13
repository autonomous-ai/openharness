import { ENGINES, type AgentEngine } from '../engines/types.js'

/**
 * A paneless agent's hook event, checked and bounded here and then handed on. The core keeps nothing of it:
 * which agents exist outside a pane, and what they said, is the devices process's work (observed source),
 * so a flood or a forged body costs the core one small parse and a counter, never state.
 */
export type ObservedEventName = 'session-start' | 'turn-start' | 'needs-input' | 'turn-stop' | 'turn-error' | 'session-end'

export interface ObservedHookEvent {
  engine: AgentEngine
  sessionId: string
  event: ObservedEventName
  cwd?: string
  callerPid: number
  transcriptPath?: string
  hostHints: Record<string, string>
  at: number
}

const EVENTS: readonly string[] = ['session-start', 'turn-start', 'needs-input', 'turn-stop', 'turn-error', 'session-end']
const MAX_SESSION_ID = 128
const MAX_PATH = 1024
const MAX_HINTS = 8
const MAX_HINT_VALUE = 64
/** Events a session may send a second; the rest are dropped, so parallel tool calls or a stuck engine repeating Stop cannot flood the devices. */
const EVENTS_PER_SECOND = 20
/** Sessions whose counter is kept at once; a counter idle for a second is full again, so it is forgotten rather than stored. */
const MAX_COUNTERS = 256
const MAX_COUNTERS_HARD = 1024

/** Same rule as hookServer's optionalBoundedString: a bounded string with no control character (a path or id with one is forged). */
const bounded = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

export function parseObservedHook(body: unknown, now: number): ObservedHookEvent | null {
  if (!isRecord(body)) return null
  const { engine, sessionId, event, cwd, callerPid, transcriptPath, hostHints } = body
  if (typeof engine !== 'string' || !(ENGINES as readonly string[]).includes(engine)) return null
  if (!bounded(sessionId, MAX_SESSION_ID) || sessionId === '') return null
  if (typeof event !== 'string' || !EVENTS.includes(event)) return null
  if (typeof callerPid !== 'number' || !Number.isSafeInteger(callerPid) || callerPid <= 0) return null
  if (cwd !== undefined && !bounded(cwd, MAX_PATH)) return null
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
    ...(transcriptPath === undefined ? {} : { transcriptPath }), hostHints: hints, at: now,
  }
}

export interface ObservedHookDeps {
  /** Hand the event to the devices process; false when it is not there (the event is dropped). */
  forward: (event: ObservedHookEvent) => boolean
  now: () => number
  log?: (line: string) => void
}

/** How often the counts of refused and dropped events are logged, at most: a flood is one line a minute. */
const REPORT_MS = 60_000

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

  // Counts only, never a session or a path: what was lost is seen, and what it said stays out of the log.
  const log = deps.log ?? ((line: string) => console.warn(line))
  const lost = { invalid: 0, dropped: 0 }
  let report: ReturnType<typeof setTimeout> | null = null
  const count = (result: 'invalid' | 'dropped'): typeof result => {
    lost[result] += 1
    if (!report) {
      report = setTimeout(() => {
        log(`[devices] paneless hook events in the last minute: ${lost.invalid} refused, ${lost.dropped} dropped`)
        lost.invalid = 0
        lost.dropped = 0
        report = null
      }, REPORT_MS)
      // A count waiting to be logged never keeps the daemon from exiting.
      report.unref?.()
    }
    return result
  }

  return {
    onObserved(body: unknown): 'ok' | 'invalid' | 'dropped' {
      const now = deps.now()
      const event = parseObservedHook(body, now)
      if (!event) return count('invalid')
      if (!take(`${event.engine}:${event.sessionId}`, now)) return count('dropped')
      return deps.forward(event) ? 'ok' : count('dropped')
    },
  }
}
