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
const base = (row: Record<string, unknown>): boolean => string(row.agentId) && !!row.agentId && string(row.sessionId)
  && string(row.engine) && !!row.engine && number(row.registeredAt) && nullableString(row.transcriptPath) && number(row.lastHookAt)
const launch = (value: unknown): boolean => value === undefined || record(value) && (
  value.state === 'starting' || value.state === 'ready'
  || value.state === 'failed' && string(value.error) && (value.detail === undefined || string(value.detail))
  || value.state === 'held' && string(value.service) && string(value.detail))

function checked(value: unknown): ReadRecord<SessionReadHeader, SessionReadValue> {
  if (!record(value) || boundedJsonBytes(value, RECORD_READ_BYTES) === null || !record(value.payload)) return invalid()
  const payload = value.payload
  if (value.type === 'begin') {
    const header = payload.header
    if (!count(payload.count) || !record(header) || boundedJsonBytes(header, SESSION_READ_HEADER_BYTES) === null
      || header.version !== 1 || !record(header.machine) || !string(header.machine.id) || !header.machine.id
      || !string(header.machine.computerId) || !string(header.machine.name) || typeof header.signedIn !== 'boolean'
      || !string(header.environment) || typeof header.hasWindow !== 'boolean') return invalid()
  } else if (value.type === 'end') {
    if (!count(payload.count)) return invalid()
  } else if (value.type === 'row') {
    const member = payload.value
    if (!count(payload.index) || !record(member) || (member.source !== 'registered' && member.source !== 'cloud')) return invalid()
    if ('gone' in member) {
      if (!string(member.gone) || !member.gone || 'row' in member) return invalid()
    } else {
      const entry = member.row
      if (!record(entry)) return invalid()
      if (member.source === 'registered') {
        if (!record(entry.session) || !base(entry.session) || typeof entry.session.active !== 'boolean'
          || !nullableString(entry.session.cwd) || (entry.session.dsh !== undefined && !nullableString(entry.session.dsh))
          || !launch(entry.session.launch) || !record(entry.facts) || !string(entry.facts.displayName)
          || typeof entry.facts.terminalAvailable !== 'boolean' || !record(entry.facts.parts)
          || (entry.facts.parts.dsh !== undefined && !string(entry.facts.parts.dsh))
          || !nullableString(entry.selectedModel) || typeof entry.turnRunning !== 'boolean') return invalid()
      } else if (!base(entry) || !string(entry.displayName) || !nullableString(entry.selectedModel)) return invalid()
    }
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
  row(value: SessionReadValue, retain: (value: unknown) => void): void
  value(): T
}

/** Commit only after exact end and successful read settlement. No aggregate raw row array is retained. */
export async function readSessionView<T>(read: SessionRecordSource, scope: SessionReadScope, build: (header: SessionReadHeader) => SessionProjection<T>, signal?: AbortSignal, observe?: SessionRecordObserver): Promise<T> {
  const ids = new Set<string>()
  let projection: SessionProjection<T> | undefined, expected: number | undefined, index = 0, ended = false, bytes = 0
  const retain = (value: unknown): void => {
    const length = boundedJsonBytes(value, SESSION_READ_VIEW_BYTES - bytes - 48)
    if (length === null) throw new Error('SESSION_READ_TOO_LARGE')
    bytes += length + 48
  }
  try {
    await read(scope, (raw, settled) => {
      const value = checked(raw)
      if (ended) return invalid()
      observe?.(value)
      if (value.type === 'begin') {
        if (projection) return invalid()
        retain(value.payload.header)
        projection = build(value.payload.header); expected = value.payload.count
      } else if (value.type === 'row') {
        if (!projection || value.payload.index !== index || index >= expected!) return invalid()
        const member = value.payload.value
        const id = 'gone' in member ? member.gone : member.source === 'registered' ? member.row.session.agentId : member.row.agentId
        if (ids.has(id)) return invalid()
        if (bytes + 48 + 2 * id.length > SESSION_READ_VIEW_BYTES) throw new Error('SESSION_READ_TOO_LARGE')
        bytes += 48 + 2 * id.length
        ids.add(id); index++
        projection.row(member, retain)
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
