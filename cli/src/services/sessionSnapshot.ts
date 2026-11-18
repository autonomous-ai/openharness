/** Complete session facts from the owning core. An invalid row never becomes a missing workspace claim. */
import { SESSION_SNAPSHOT_MAX_BYTES, SESSION_SNAPSHOT_MAX_ROWS, type SessionSnapshot } from '../core/api.js'
import { boundedJsonBytes } from '../lib/boundedJsonBytes.js'

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const string = (value: unknown): value is string => typeof value === 'string'
const nullableString = (value: unknown): boolean => value === null || string(value)
const number = (value: unknown): boolean => typeof value === 'number' && Number.isFinite(value)
const base = (row: Record<string, unknown>): boolean => string(row.agentId) && !!row.agentId && string(row.sessionId)
  && string(row.engine) && !!row.engine && number(row.registeredAt) && nullableString(row.transcriptPath) && number(row.lastHookAt)
const launch = (value: unknown): boolean => value === undefined || record(value) && (
  value.state === 'starting' || value.state === 'ready'
  || value.state === 'failed' && string(value.error) && (value.detail === undefined || string(value.detail))
  || value.state === 'held' && string(value.service) && string(value.detail))

export function sessionSnapshot(answer: unknown): SessionSnapshot {
  const invalid = (): never => { throw new Error('SESSION_SNAPSHOT_UNAVAILABLE') }
  if (!record(answer) || boundedJsonBytes(answer, SESSION_SNAPSHOT_MAX_BYTES + 4096) === null
    || answer.version !== 1 || !Array.isArray(answer.registered) || !Array.isArray(answer.cloud)
    || answer.registered.length + answer.cloud.length > SESSION_SNAPSHOT_MAX_ROWS
    || !record(answer.machine) || !string(answer.machine.id) || !answer.machine.id || !string(answer.machine.computerId)
    || !string(answer.machine.name) || typeof answer.signedIn !== 'boolean' || !string(answer.environment)
    || typeof answer.hasWindow !== 'boolean') return invalid()
  const ids = new Set<string>()
  for (const entry of answer.registered) {
    if (!record(entry) || !record(entry.session) || !base(entry.session) || typeof entry.session.active !== 'boolean'
      || !nullableString(entry.session.cwd) || (entry.session.dsh !== undefined && !nullableString(entry.session.dsh))
      || !launch(entry.session.launch) || !record(entry.facts) || !string(entry.facts.displayName)
      || typeof entry.facts.terminalAvailable !== 'boolean' || !record(entry.facts.parts)
      || (entry.facts.parts.dsh !== undefined && !string(entry.facts.parts.dsh))
      || !nullableString(entry.selectedModel) || typeof entry.turnRunning !== 'boolean') return invalid()
    const id = entry.session.agentId as string
    if (ids.has(id)) return invalid()
    ids.add(id)
  }
  for (const row of answer.cloud) {
    if (!record(row) || !base(row) || !string(row.displayName) || !nullableString(row.selectedModel)) return invalid()
    const id = row.agentId as string
    if (ids.has(id)) return invalid()
    ids.add(id)
  }
  return answer as unknown as SessionSnapshot
}
