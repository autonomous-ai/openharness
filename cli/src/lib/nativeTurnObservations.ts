import { randomUUID } from 'node:crypto'
import type { LiveEvent } from '../engines/kit/events.js'

export interface NativeTurnCursor { epoch: string; sequence: number }
export interface NativeTurnObservation {
  sequence: number
  turnId: string
  kind: 'prompt' | 'answer'
  text: string
  truncated: boolean
  interrupted: boolean
  /** Opaque context supplied by the input client. It proves no identity or
   * permission; a consumer must validate it against its own authority. */
  inputContext: string | null
  /** Accepted terminal input had no unambiguous context. Contains no identity. */
  unattributedInput?: boolean
}
export interface NativeTurnPage {
  cursor: NativeTurnCursor
  observations: NativeTurnObservation[]
  /** The core restarted, the session changed, the lease expired, or bounded
   * history was evicted. A consumer must not describe that interval as complete. */
  gap: boolean
}
export type NativeTurnRead = (agentId: string, cursor?: NativeTurnCursor) => Promise<NativeTurnPage | null>
export interface NativeTurnBinding { sessionId: string; engine: string; runtime: string }
export function nativeTurnBinding(session: { sessionId: string; engine: string; primaryRuntimeKey: string | null } | undefined): NativeTurnBinding | null {
  return session?.sessionId ? { sessionId: session.sessionId, engine: session.engine, runtime: session.primaryRuntimeKey ?? '' } : null
}
interface Turn { id: string; text: string; truncated: boolean; inputContext: string | null; unattributedInput: boolean }
interface ObservedAgent {
  binding: string; epoch: string; sequence: number; floor: number; until: number
  draftContext: string | null | undefined
  pendingContexts: Array<{ context: string | null; native: boolean }>
  turn: Turn | null
  observations: Map<number, NativeTurnObservation>
}
export const NATIVE_TURN_TEXT_LIMIT = 16_000
export const NATIVE_TURN_LEASE_MS = 30_000
const MAX_AGENTS = 256, MAX_RECORDS = 512, MAX_CHARACTERS = 1024 * 1024
function clippedText(value: string, limit: number): string {
  if (value.length <= limit) return value
  const last = value.charCodeAt(limit - 1)
  const end = last >= 0xd800 && last <= 0xdbff ? limit - 1 : limit
  // V8 can retain a giant source string behind a short slice. Copy only the
  // bounded prefix, without splitting an emoji's surrogate pair.
  return Buffer.from(value.slice(0, end), 'utf16le').toString('utf16le')
}
export const inputContextIn = (value: unknown): string | null =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{16,160}$/.test(value) ? value : null
/** The app flushes a submit key separately from text. Meta/Shift+Enter and
 * multiline pastes are not submissions; ambiguous mixed frames stay unknown. */
export function nativeSubmitKey(bytes: Uint8Array): boolean {
  return (bytes.length === 1 && (bytes[0] === 13 || bytes[0] === 10))
    || (bytes.length === 2 && bytes[0] === 13 && bytes[1] === 10)
    || (bytes.length <= 7 && ['\x1b[13u', '\x1b[13;1u'].includes(Buffer.from(bytes).toString('latin1')))
}
export function nativeTurnCursorIn(value: unknown): NativeTurnCursor | null {
  if (!value || typeof value !== 'object') return null
  const cursor = value as Record<string, unknown>
  return typeof cursor.epoch === 'string' && /^[A-Za-z0-9_-]{16,160}$/.test(cursor.epoch)
    && Number.isSafeInteger(cursor.sequence) && (cursor.sequence as number) >= 0
    ? { epoch: cursor.epoch, sequence: cursor.sequence as number } : null
}

/** A bounded, on-demand view of actual live turns. It contains neither tool
 * output nor history from before observation began. Consumers own durable
 * recording; the core never waits for them or writes their feature state. */
export function createNativeTurnObservations(deps: {
  resolve(agentId: string): NativeTurnBinding | null
  now?: () => number
  id?: () => string
}) {
  const now = deps.now ?? Date.now, id = deps.id ?? randomUUID
  const agents = new Map<string, ObservedAgent>()
  const held = new Map<string, { row: ObservedAgent; event: NativeTurnObservation }>()
  let characters = 0
  const remove = (key: string, row: ObservedAgent, event: NativeTurnObservation) => {
    held.delete(key); row.observations.delete(event.sequence)
    row.floor = Math.max(row.floor, event.sequence)
    characters -= event.text.length
  }
  const forget = (agentId: string, row: ObservedAgent) => {
    for (const event of row.observations.values()) remove(`${row.epoch}:${event.sequence}`, row, event)
    agents.delete(agentId)
  }
  const current = (agentId: string): ObservedAgent | null => {
    const row = agents.get(agentId)
    if (!row) return null
    const binding = deps.resolve(agentId)
    if (row.until <= now() || !binding || JSON.stringify(binding) !== row.binding) { forget(agentId, row); return null }
    return row
  }
  const append = (row: ObservedAgent, value: Omit<NativeTurnObservation, 'sequence'>) => {
    const event = { ...value, sequence: ++row.sequence }
    row.observations.set(event.sequence, event)
    held.set(`${row.epoch}:${event.sequence}`, { row, event }); characters += event.text.length
    while (held.size > MAX_RECORDS || characters > MAX_CHARACTERS) {
      const [key, first] = held.entries().next().value!
      remove(key, first.row, first.event)
    }
  }
  const finish = (row: ObservedAgent, interrupted: boolean) => {
    const turn = row.turn
    if (!turn) return
    append(row, { turnId: turn.id, kind: 'answer', text: turn.text, truncated: turn.truncated,
      interrupted, inputContext: turn.inputContext, ...(turn.unattributedInput ? { unattributedInput: true } : {}) })
    row.turn = null
  }
  return {
    read(agentId: string, cursor?: NativeTurnCursor): NativeTurnPage | null {
      const binding = deps.resolve(agentId)
      if (!binding) return null
      let row = current(agentId)
      if (!row) {
        // No timer while nobody observes. Expired leases are swept only when
        // another reader needs a slot, and an unread agent keeps no content.
        for (const key of agents.keys()) current(key)
        if (agents.size >= MAX_AGENTS) return null
        row = { binding: JSON.stringify(binding), epoch: id(), sequence: 0, floor: 0,
          until: now() + NATIVE_TURN_LEASE_MS, draftContext: undefined, pendingContexts: [], turn: null, observations: new Map() }
        agents.set(agentId, row)
      }
      row.until = now() + NATIVE_TURN_LEASE_MS
      const gap = !!cursor && (cursor.epoch !== row.epoch || cursor.sequence < row.floor || cursor.sequence > row.sequence)
      // A new observer starts at the current boundary; it never imports old
      // prompts because some other consumer happened to observe this agent.
      const events = cursor && cursor.epoch === row.epoch && cursor.sequence <= row.sequence
        ? [...row.observations.values()].filter(event => event.sequence > cursor.sequence) : []
      return { cursor: { epoch: row.epoch, sequence: row.sequence }, observations: events.map(event => ({ ...event })), gap }
    },
    /** Called for accepted human typing, not terminal escape-code replies.
     * Multiple input contexts before a prompt are explicitly ambiguous. */
    typed(agentId: string, context: unknown, submitted = false): void {
      const row = current(agentId)
      if (!row) return
      const next = inputContextIn(context)
      row.draftContext = row.draftContext === undefined || row.draftContext === next ? next : null
      if (submitted) {
        // Engines may queue several native prompts. A context change while
        // submissions are still pending is ambiguous; do not guess which
        // person or conversation owns a later accepted prompt.
        if (row.pendingContexts.some(value => value.context !== row.draftContext) || row.pendingContexts.length >= 32) {
          for (const pending of row.pendingContexts) pending.context = null
          row.draftContext = null
        }
        if (row.pendingContexts.length < 32) row.pendingContexts.push({ context: row.draftContext, native: true })
        row.draftContext = undefined
      }
    },
    /** A programmatic paste supersedes any unsent native-input provenance. */
    submitting(agentId: string, inputContext?: string): void {
      const row = current(agentId)
      if (row) {
        const context = inputContextIn(inputContext), ambiguous = row.pendingContexts.length > 0
        row.draftContext = undefined
        for (const pending of row.pendingContexts) pending.context = null
        if (row.pendingContexts.length < 32) row.pendingContexts.push({ context: ambiguous ? null : context, native: context !== null })
      }
    },
    ingest(agentId: string, events: readonly LiveEvent[], replay = false): void {
      const row = current(agentId)
      if (!row) return
      if (replay) { forget(agentId, row); return }
      for (const event of events) {
        if (event.type === 'turn_started') {
          finish(row, true)
          const turnId = id(), pending = row.pendingContexts.shift(), inputContext = pending?.context ?? null
          const unattributedInput = pending?.native === true && inputContext === null
          row.turn = { id: turnId, text: '', truncated: false, inputContext, unattributedInput }
          append(row, { turnId, kind: 'prompt', text: clippedText(event.payload.userMessage, NATIVE_TURN_TEXT_LIMIT),
            truncated: event.payload.userMessage.length > NATIVE_TURN_TEXT_LIMIT, interrupted: false, inputContext,
            ...(unattributedInput ? { unattributedInput: true } : {}) })
        } else if (event.type === 'text_delta' && row.turn && !row.turn.truncated) {
          const room = NATIVE_TURN_TEXT_LIMIT - row.turn.text.length
          row.turn.text += clippedText(event.payload.content, room)
          row.turn.truncated ||= event.payload.content.length > room
        } else if (event.type === 'turn_ended') finish(row, event.payload.aborted === true)
      }
    },
  }
}

/** Strict process boundary: malformed/older-core replies are unavailable,
 * never an empty page that advances a consumer's durable cursor. */
export function nativeTurnPageIn(value: unknown): NativeTurnPage | null {
  if (!value || typeof value !== 'object') return null
  const row = value as Record<string, unknown>, cursor = nativeTurnCursorIn(row.cursor)
  if (!cursor || typeof row.gap !== 'boolean' || !Array.isArray(row.observations) || row.observations.length > MAX_RECORDS) return null
  let previous = 0
  const observations: NativeTurnObservation[] = []
  for (const value of row.observations) {
    if (!value || typeof value !== 'object') return null
    const event = value as Record<string, unknown>
    if (!Number.isSafeInteger(event.sequence) || (event.sequence as number) <= previous || (event.sequence as number) > cursor.sequence
      || !inputContextIn(event.turnId) || !['prompt', 'answer'].includes(String(event.kind))
      || typeof event.text !== 'string' || event.text.length > NATIVE_TURN_TEXT_LIMIT
      || typeof event.truncated !== 'boolean' || typeof event.interrupted !== 'boolean'
      || (event.unattributedInput !== undefined && typeof event.unattributedInput !== 'boolean')
      || (event.inputContext !== null && !inputContextIn(event.inputContext))) return null
    previous = event.sequence as number
    observations.push({ sequence: previous, turnId: event.turnId as string, kind: event.kind as 'prompt' | 'answer',
      text: event.text, truncated: event.truncated, interrupted: event.interrupted, inputContext: event.inputContext as string | null,
      ...(event.unattributedInput === true ? { unattributedInput: true } : {}) })
  }
  return { cursor, observations, gap: row.gap }
}
