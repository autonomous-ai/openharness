/** Aggregate fixtures are test data only. Production consumers retain their own projection, never this raw catalog. */
import type { CoreApi, ReadRecord, SessionCloudRow, SessionReadHeader, SessionReadReceiver, SessionReadScope, SessionReadValue, SessionSnapshotRow } from '../core/api.js'
import type { CoreConnection } from '../services/process.js'

export interface SessionSnapshot extends SessionReadHeader { registered: SessionSnapshotRow[]; cloud: SessionCloudRow[] }
export function snapshotFixture(over: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return { version: 1, registered: [], cloud: [], machine: { id: 'machine-1', computerId: 'computer-9', name: 'This machine' },
    signedIn: true, environment: 'prod', hasWindow: true, ...over }
}
export function snapshotRow(agentId = 'agent', over: Partial<SessionSnapshotRow> = {}): SessionSnapshotRow {
  return { session: { agentId, sessionId: `s-${agentId}`, engine: 'claude', registeredAt: 1, transcriptPath: null, lastHookAt: 0,
    active: true, cwd: null, dsh: null }, facts: { displayName: 'Agent', terminalAvailable: true, parts: {} },
    selectedModel: null, turnRunning: false, ...over }
}
export function snapshotRecords(value: unknown): ReadRecord<SessionReadHeader, SessionReadValue>[] {
  const snapshot = value as SessionSnapshot | null
  if (!snapshot || !Array.isArray(snapshot.registered) || !Array.isArray(snapshot.cloud)) throw new Error('SESSION_READ_UNAVAILABLE')
  const { registered, cloud, ...header } = snapshot
  const members: SessionReadValue[] = [...registered.map(row => ({ source: 'registered' as const, row })), ...cloud.map(row => ({ source: 'cloud' as const, row }))]
  return [{ type: 'begin', payload: { header, count: members.length } },
    ...members.map((value, index) => ({ type: 'row' as const, payload: { index, value } })), { type: 'end', payload: { count: members.length } }]
}
export const snapshotReader = (value: () => unknown | Promise<unknown>): CoreApi['agents']['readSessions'] => async (_scope, receive, signal) => {
  const records = snapshotRecords(await value())
  for (const record of records) {
    if (signal?.aborted) throw new Error('SESSION_READ_UNAVAILABLE')
    let accepted = false
    if (!receive(record, sent => { accepted = sent }) || !accepted) throw new Error('SESSION_READ_UNAVAILABLE')
  }
}
/** Existing adapter fixtures supply values through their query mock; production transport is exercised in process.spec. */
export const fixtureRead = (answer: CoreConnection['query']): NonNullable<CoreConnection['read']> => async (query, payload, receive, signal) => {
  await snapshotReader(() => answer(query, payload))('registered', (record, settled) => { receive(record); settled(true); return true }, signal)
}
export async function collectSessionRead(read: CoreApi['agents']['readSessions'], scope: SessionReadScope = 'registered'): Promise<SessionSnapshot> {
  let result: SessionSnapshot | undefined
  const receive: SessionReadReceiver = (record, settled) => {
    if (record.type === 'begin') result = { ...record.payload.header, registered: [], cloud: [] }
    else if (record.type === 'row' && !('gone' in record.payload.value)) {
      const member = record.payload.value
      if (member.source === 'registered') result!.registered.push(member.row)
      else result!.cloud.push(member.row)
    }
    settled(true); return true
  }
  await read(scope, receive)
  return result!
}
