/** Aggregate fixtures are test data only. Production consumers retain their own projection, never this raw catalog. */
import type { AgentView, CoreApi, ReadRecord, SessionReadHeader, SessionReadReceiver, SessionReadScope, SessionReadValue } from '../core/api.js'
import type { CoreConnection } from '../services/process.js'
import type { ServiceSessionRow } from '../lib/sessionOwnerWire.js'

export const serviceSession = (agentId: string, over: Partial<ServiceSessionRow> = {}): ServiceSessionRow => ({
  agentId, sessionId: `s-${agentId}`, engine: 'fo', displayName: '', defaultName: '', runtimeProfile: null,
  registeredAt: 1, lastHookAt: 0, active: true, tmuxPane: '', cwd: '', projectDir: '', transcriptPath: null,
  runtimes: [], primaryRuntimeKey: '', ...over,
})

export type SessionRow = Pick<AgentView, 'agentId' | 'sessionId' | 'registeredAt' | 'transcriptPath' | 'lastHookAt' | 'active' | 'cwd' | 'dsh'> & {
  engine: string
  launch?: { state: 'starting' | 'ready' | 'held' | 'failed'; error?: string; detail?: string; service?: string }
}
export interface SessionSnapshotRow {
  session: SessionRow
  facts: { displayName: string; terminalAvailable: boolean; parts: { dsh?: string } }
  selectedModel: string | null
  turnRunning: boolean
}
export interface SessionCloudRow {
  agentId: string; sessionId: string; engine: string; registeredAt: number; transcriptPath: string | null; lastHookAt: number
  displayName: string; selectedModel: string | null
}
export interface SessionSnapshot extends SessionReadHeader { registered: SessionSnapshotRow[]; cloud: SessionCloudRow[] }
export function snapshotFixture(over: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return { version: 2, registered: [], cloud: [], machine: { id: 'machine-1', computerId: 'computer-9', name: 'This machine' },
    signedIn: true, environment: 'prod', hasWindow: true, ...over }
}
export function snapshotRow(agentId = 'agent', over: Partial<SessionSnapshotRow> = {}): SessionSnapshotRow {
  return { session: { agentId, sessionId: `s-${agentId}`, engine: 'claude', registeredAt: 1, transcriptPath: null, lastHookAt: 0,
    active: true, cwd: null, dsh: null }, facts: { displayName: 'Agent', terminalAvailable: true, parts: {} },
    selectedModel: null, turnRunning: false, ...over }
}
export function snapshotValue(value: SessionSnapshotRow): SessionReadValue {
  const { session: s, facts, selectedModel, turnRunning } = value
  const l = s.launch
  return ['registered', s.agentId, s.sessionId, s.engine, s.registeredAt, s.transcriptPath, s.lastHookAt, s.active, s.cwd,
    s.dsh === undefined ? false : s.dsh,
    !l ? null : l.state === 'failed' ? ['failed', l.error!, l.detail === undefined ? false : l.detail]
      : l.state === 'held' ? ['held', l.service!, l.detail!] : [l.state],
    facts.displayName, facts.terminalAvailable, selectedModel, turnRunning,
    facts.parts.dsh === undefined ? false : facts.parts.dsh === s.dsh ? true : facts.parts.dsh]
}
/** Independent test decoding keeps the historical field assertions; production projects tuples directly. */
export function snapshotMember(value: SessionReadValue): { source: 'registered'; row: SessionSnapshotRow } | { source: 'cloud'; row: SessionCloudRow }
  | { source: 'registered' | 'cloud'; gone: string } {
  if (value[0] === 'gone') return { source: value[1] === 'service' ? 'cloud' : value[1], gone: value[2] }
  const [, agentId, sessionId, engine, registeredAt, transcriptPath, lastHookAt] = value
  if (value[0] === 'service') {
    const [, , , , , , , displayName, selectedModel] = value
    return { source: 'cloud', row: { agentId, sessionId, engine, registeredAt, transcriptPath, lastHookAt, displayName, selectedModel } }
  }
  const [, , , , , , , active, cwd, storedDsh, launching, displayName, terminalAvailable, selectedModel, turnRunning, publishedDsh] = value
  const [state, first, detail] = launching ?? []
  const launch: SessionRow['launch'] = state === undefined ? undefined : state === 'failed'
    ? { state, error: first, ...(detail === false ? {} : { detail }) } : state === 'held' ? { state, service: first, detail } : { state }
  return { source: 'registered', row: {
    session: { agentId, sessionId, engine, registeredAt, transcriptPath, lastHookAt, active, cwd,
      ...(storedDsh === false ? {} : { dsh: storedDsh }), ...(launch ? { launch } : {}) },
    facts: { displayName, terminalAvailable, parts: publishedDsh === false ? {} : { dsh: publishedDsh === true ? storedDsh as string : publishedDsh } },
    selectedModel, turnRunning,
  } }
}
export function snapshotRecords(value: unknown): ReadRecord<SessionReadHeader, SessionReadValue>[] {
  const snapshot = value as SessionSnapshot | null
  if (!snapshot || !Array.isArray(snapshot.registered) || !Array.isArray(snapshot.cloud)) throw new Error('SESSION_READ_UNAVAILABLE')
  const { registered, cloud, ...header } = snapshot
  let members: SessionReadValue[]
  try {
    members = [...registered.map(snapshotValue), ...cloud.map((row): SessionReadValue => ['service', row.agentId, row.sessionId,
      row.engine, row.registeredAt, row.transcriptPath, row.lastHookAt, row.displayName, row.selectedModel])]
  } catch { throw new Error('SESSION_READ_UNAVAILABLE') }
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
    else if (record.type === 'row' && record.payload.value[0] !== 'gone') {
      const member = snapshotMember(record.payload.value)
      if ('gone' in member) throw new Error('unexpected gone fixture')
      if (member.source === 'registered') result!.registered.push(member.row)
      else result!.cloud.push(member.row)
    }
    settled(true); return true
  }
  await read(scope, receive)
  return result!
}
