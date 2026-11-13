/**
 * A hook event from a session outside any Harness or tmux pane (`POST /api/hook/observed`): Claude Code in Orca,
 * Codex in Ghostty. The engines' hooks fire wherever the agent runs, and the core already receives them; before
 * this route the hook dropped a paneless one on the floor (`cli/hook/notify.mjs`), so the dial never heard of
 * an agent running outside Harness (docs/specs/2026-11-13-device-without-the-app.md).
 *
 * The core keeps none of it. It checks the event's types and bounds, holds a session to 20 events a second (a
 * flood of parallel tool calls, or an engine stuck repeating Stop, must hold neither the core nor the dial), and
 * hands it to the devices' process, which keeps the agents it lists. With no devices there, nobody is told: the
 * event is dropped. The host hints are only bounded here: what they mean is parsed in the devices' process,
 * never in the core (cli/AGENTS.md, "Protect the core").
 */
import { ENGINES, type AgentEngine } from '../engines/types.js'

export const OBSERVED_EVENTS = ['session-start', 'turn-start', 'needs-input', 'turn-stop', 'turn-error', 'session-end'] as const
export type ObservedEventName = (typeof OBSERVED_EVENTS)[number]

export interface ObservedHookEvent {
  engine: AgentEngine
  sessionId: string
  event: ObservedEventName
  cwd?: string
  /** The engine's process (the hook's parent): how the devices tell a session that has gone. */
  callerPid: number
  transcriptPath?: string
  /** A fixed allowlist of the hook's environment variables, which the devices read the host from. */
  hostHints: Record<string, string>
  /** When the core heard it. */
  at: number
}

const FIELDS = new Set(['engine', 'sessionId', 'event', 'cwd', 'callerPid', 'transcriptPath', 'hostHints'])
const MAX_SESSION_ID = 128
const MAX_PATH = 1024
const MAX_HINTS = 8
const MAX_HINT = 64
/** An environment variable's name: the hook sends the values of a few, by their exact names. */
const HINT_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
const PER_SECOND = 20
const WINDOW_MS = 1000
/** Sessions counted in one second. A flood of made-up session ids is dropped beyond it rather than growing the core. */
const MAX_BUCKETS = 1024

/** As the other hook routes read a string (hookServer.ts): absent, or within its bound with no control character,
 *  which could forge a line of the log it is written to. */
function optionalBoundedString(value: unknown, max: number): boolean {
  return value === undefined || value === null || (typeof value === 'string'
    && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value))
}

function hostHintsOf(value: unknown): Record<string, string> | null {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) return null
  const entries = Object.entries(value)
  if (entries.length > MAX_HINTS) return null
  for (const [key, hint] of entries) {
    if (!HINT_KEY.test(key) || typeof hint !== 'string' || !optionalBoundedString(hint, MAX_HINT)) return null
  }
  return Object.fromEntries(entries) as Record<string, string>
}

/** The event, typed and bounded, or null for anything else. */
export function parseObservedHook(body: unknown, now: number): ObservedHookEvent | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const raw = body as Record<string, unknown>
  if (Object.keys(raw).some((field) => !FIELDS.has(field))) return null
  const { engine, sessionId, event, cwd, callerPid, transcriptPath } = raw
  if (typeof engine !== 'string' || !ENGINES.includes(engine as AgentEngine)) return null
  if (typeof sessionId !== 'string' || !sessionId || !optionalBoundedString(sessionId, MAX_SESSION_ID)) return null
  if (typeof event !== 'string' || !OBSERVED_EVENTS.includes(event as ObservedEventName)) return null
  if (!Number.isSafeInteger(callerPid) || (callerPid as number) <= 0) return null
  if (!optionalBoundedString(cwd, MAX_PATH) || !optionalBoundedString(transcriptPath, MAX_PATH)) return null
  const hostHints = hostHintsOf(raw.hostHints)
  if (!hostHints) return null
  return {
    engine: engine as AgentEngine, sessionId, event: event as ObservedEventName,
    ...(typeof cwd === 'string' ? { cwd } : {}),
    callerPid: callerPid as number,
    ...(typeof transcriptPath === 'string' ? { transcriptPath } : {}),
    hostHints, at: now,
  }
}

export interface ObservedHookDeps {
  /** Hand the event to the devices; false when their process is not there to hear it. */
  forward(event: ObservedHookEvent): boolean
  now(): number
}

export function createObservedHook(deps: ObservedHookDeps) {
  /** How many events each session sent in its current second: all the core keeps. */
  const buckets = new Map<string, { start: number; count: number }>()

  const admit = (key: string, now: number): boolean => {
    let bucket = buckets.get(key)
    if (bucket && now - bucket.start >= WINDOW_MS) { buckets.delete(key); bucket = undefined }
    if (!bucket) {
      if (buckets.size >= MAX_BUCKETS) {
        for (const [other, counted] of buckets) if (now - counted.start >= WINDOW_MS) buckets.delete(other)
        if (buckets.size >= MAX_BUCKETS) return false
      }
      bucket = { start: now, count: 0 }
      buckets.set(key, bucket)
    }
    if (bucket.count >= PER_SECOND) return false
    bucket.count++
    return true
  }

  return {
    onObserved(body: unknown): 'ok' | 'invalid' | 'dropped' {
      const now = deps.now()
      const event = parseObservedHook(body, now)
      if (!event) return 'invalid'
      if (!admit(`${event.engine}\u0000${event.sessionId}`, now)) return 'dropped'
      return deps.forward(event) ? 'ok' : 'dropped'
    },
  }
}
