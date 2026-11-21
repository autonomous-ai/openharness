/** Complete per-row reads: validate each record, retain only the component's provisional projection. */
import { SESSION_READ_HEADER_BYTES, SESSION_READ_VIEW_BYTES, type ReadRecord, type SessionReadHeader, type SessionReadScope, type SessionReadValue } from '../core/api.js'
import { boundedJsonBytes } from '../lib/boundedJsonBytes.js'
import { RECORD_READ_BYTES } from '../lib/recordReadWire.js'
import type { CoreConnection } from './process.js'

const invalid = (): never => { throw new Error('SESSION_READ_UNAVAILABLE') }
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const string = (value: unknown): value is string => typeof value === 'string'
const nullableString = (value: unknown): boolean => value === null || string(value)
const number = (value: unknown): boolean => typeof value === 'number' && Number.isFinite(value)
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
// JSON arrays have their native iterator. An inline source must not inject code through destructuring.
const tuple = (value: unknown): value is unknown[] => Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype
  && !Object.hasOwn(value, Symbol.iterator)
const base = (row: unknown[]): boolean => {
  const [, agentId, sessionId, engine, registeredAt, transcriptPath, lastHookAt] = row
  return string(agentId) && !!agentId && string(sessionId) && string(engine) && !!engine
    && number(registeredAt) && nullableString(transcriptPath) && number(lastHookAt)
}
const launch = (value: unknown): boolean => value === null || tuple(value) && (
  value.length === 1 && (value[0] === 'starting' || value[0] === 'ready')
  || value.length === 3 && string(value[1]) && (
    value[0] === 'failed' && (value[2] === false || string(value[2])) || value[0] === 'held' && string(value[2])))

function checked(value: unknown): ReadRecord<SessionReadHeader, SessionReadValue> {
  if (!record(value) || boundedJsonBytes(value, RECORD_READ_BYTES) === null || !record(value.payload)) return invalid()
  const payload = value.payload
  if (value.type === 'begin') {
    const header = payload.header
    if (!count(payload.count) || !record(header) || boundedJsonBytes(header, SESSION_READ_HEADER_BYTES) === null
      || header.version !== 2 || !record(header.machine) || !string(header.machine.id) || !header.machine.id
      || !string(header.machine.computerId) || !string(header.machine.name) || typeof header.signedIn !== 'boolean'
      || !string(header.environment) || typeof header.hasWindow !== 'boolean') return invalid()
  } else if (value.type === 'end') {
    if (!count(payload.count)) return invalid()
  } else if (value.type === 'row') {
    const member = payload.value
    if (!count(payload.index) || !tuple(member)) return invalid()
    if (member[0] === 'gone') {
      if (member.length !== 3 || (member[1] !== 'registered' && member[1] !== 'service') || !string(member[2]) || !member[2]) return invalid()
    } else if (member[0] === 'registered') {
      const [, , , , , , , active, cwd, storedDsh, launching, displayName, terminalAvailable, selectedModel, turnRunning, publishedDsh] = member
      if (member.length !== 16 || !base(member) || typeof active !== 'boolean' || !nullableString(cwd)
        || !(storedDsh === false || nullableString(storedDsh)) || !launch(launching) || !string(displayName)
        || typeof terminalAvailable !== 'boolean' || !nullableString(selectedModel) || typeof turnRunning !== 'boolean'
        || !(publishedDsh === false || string(publishedDsh) || publishedDsh === true && string(storedDsh))) return invalid()
    } else if (member[0] === 'service') {
      if (member.length !== 9 || !base(member) || !string(member[7]) || !nullableString(member[8])) return invalid()
    } else return invalid()
  } else return invalid()
  return value as ReadRecord<SessionReadHeader, SessionReadValue>
}

export type SessionRecordReceiver = (value: unknown, settled: (accepted: boolean) => void) => boolean
export type SessionRecordSource = (scope: SessionReadScope, receive: SessionRecordReceiver, signal?: AbortSignal) => Promise<void>
export type SessionRecordObserver = (value: ReadRecord<SessionReadHeader, SessionReadValue>) => void

/** Raw authenticated transport. Validation belongs to the projection boundary before any typed observer. */
export async function readCoreSessionRecords(core: CoreConnection, scope: SessionReadScope, receive: SessionRecordReceiver, signal?: AbortSignal): Promise<void> {
  if (!core.read) return invalid()
  await core.read(`session_read_${scope}`, {}, value => {
    let accepted: boolean | undefined
    const sent = receive(value, ok => { if (accepted !== undefined) return invalid(); accepted = ok })
    // A component's projection is synchronous. Never keep incoming frames behind an unbounded consumer queue.
    if (!sent || accepted !== true) return invalid()
  }, signal)
}

export interface SessionProjection<T> {
  row(value: SessionReadValue, budget: SessionProjectionBudget): void
  value(): T
}
export interface SessionProjectionBudget {
  readonly remaining: number
  retain(bytes: number | null): void
}

/** Commit only after exact end and successful read settlement. No aggregate raw row array is retained. */
export async function readSessionView<T>(read: SessionRecordSource, scope: SessionReadScope, build: (header: SessionReadHeader) => SessionProjection<T>, signal?: AbortSignal, observe?: SessionRecordObserver): Promise<T> {
  const ids = new Set<string>()
  let projection: SessionProjection<T> | undefined, expected: number | undefined, index = 0, ended = false, bytes = 0
  const budget: SessionProjectionBudget = {
    get remaining() { return SESSION_READ_VIEW_BYTES - bytes - 48 },
    retain(length) {
      if (length === null || !Number.isSafeInteger(length) || length < 0 || length > budget.remaining) throw new Error('SESSION_READ_TOO_LARGE')
      bytes += length + 48
    },
  }
  try {
    await read(scope, (raw, settled) => {
      const value = checked(raw)
      if (ended) return invalid()
      observe?.(value)
      if (value.type === 'begin') {
        if (projection) return invalid()
        budget.retain(boundedJsonBytes(value.payload.header, budget.remaining))
        projection = build(value.payload.header); expected = value.payload.count
      } else if (value.type === 'row') {
        if (!projection || value.payload.index !== index || index >= expected!) return invalid()
        const member = value.payload.value
        const id = member[0] === 'gone' ? member[2] : member[1]
        if (ids.has(id)) return invalid()
        if (bytes + 48 + 2 * id.length > SESSION_READ_VIEW_BYTES) throw new Error('SESSION_READ_TOO_LARGE')
        bytes += 48 + 2 * id.length
        ids.add(id); index++
        projection.row(member, budget)
      } else {
        if (!projection || value.payload.count !== expected || index !== expected) return invalid()
        ended = true
      }
      settled(true)
      return true
    }, signal)
    if (!ended || !projection) return invalid()
    return projection.value()
  } finally { ids.clear() }
}
