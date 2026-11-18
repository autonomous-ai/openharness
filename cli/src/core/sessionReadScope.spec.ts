import { describe, expect, it, vi } from 'vitest'
import { readSessions, type CoreApiDeps, type ReadRecord, type SessionReadHeader, type SessionReadScope, type SessionReadValue } from './api.js'
import type { RegisteredSession } from '../lib/registry.js'
import { snapshotRow } from '../testing/sessionSnapshot.js'

type Event = ReadRecord<SessionReadHeader, SessionReadValue>
const row = (id: string) => ({ ...snapshotRow(id).session, defaultName: id }) as RegisteredSession
function fixture(count: number, shown: number) {
  const members = new Map(Array.from({ length: count }, (_, i) => [`a${i}`, row(`a${i}`)]))
  const cloud = new Map<string, RegisteredSession>()
  const available = new Set([...members.keys()].slice(0, shown))
  const deps = {
    registry: {
      rows: () => members.values(), byAgent: (id: string) => members.get(id),
      advertisedRows: function* () { for (const value of members.values()) if (available.has(value.agentId)) yield value },
      list: () => { throw new Error('WHOLE_REGISTRY_ARRAY') },
      advertised: () => { throw new Error('WHOLE_ADVERTISED_ARRAY') },
    } as unknown as CoreApiDeps['registry'],
    cloudRead: { ids: () => cloud.keys(), row: (id: string) => cloud.get(id) },
    facts: vi.fn((value: RegisteredSession) => ({ displayName: value.defaultName!, terminalAvailable: available.has(value.agentId), parts: {} })),
    runtimeProfile: () => null, turns: { running: () => false } as unknown as CoreApiDeps['turns'],
    machine: { id: () => 'machine', computerId: () => 'computer', name: () => 'Desk' },
    signedIn: () => true, environment: () => 'prod', hasWindow: () => true, log: vi.fn(),
  } satisfies Parameters<typeof readSessions>[0]
  const capture = async (scope: SessionReadScope, begin?: () => void) => {
    const events: Event[] = []
    await readSessions(deps, (event, settled) => {
      events.push(event)
      if (event.type === 'begin') begin?.()
      settled(true); return true
    }, undefined, scope)
    return events
  }
  return { members, cloud, available, deps, capture }
}

describe('existing registered and advertised membership scopes', () => {
  it('sends only the eight advertised rows while the registered control retains all 1600 occupancy rows', async () => {
    const t = fixture(1600, 8)
    const all = await t.capture('registered')
    expect(all.filter(event => event.type === 'row')).toHaveLength(1600)
    expect(t.deps.facts).toHaveBeenCalledTimes(1600)
    t.deps.facts.mockClear()
    const shown = await t.capture('advertised')
    expect(shown.filter(event => event.type === 'row')).toHaveLength(8)
    expect(shown[0]).toMatchObject({ type: 'begin', payload: { count: 8 } })
    expect(shown.at(-1)).toEqual({ type: 'end', payload: { count: 8 } })
    expect(t.deps.facts).toHaveBeenCalledTimes(8)
  })

  it('keeps captured membership while dropping unavailable unread members and reading current replacements', async () => {
    const t = fixture(5, 4)
    const shown = await t.capture('advertised', () => {
      t.members.delete('a0')
      t.members.set('a1', { ...row('a1'), sessionId: 'replacement' })
      t.available.delete('a2')
      t.members.set('a3', { ...row('a3'), sessionId: 'unavailable-replacement' }); t.available.delete('a3')
      t.available.add('a4')
      t.members.set('late', row('late')); t.available.add('late')
    })
    expect(shown[0]).toMatchObject({ payload: { count: 4 } })
    const values = shown.filter(event => event.type === 'row').map(event => event.payload.value)
    expect(values).toEqual([
      { source: 'registered', gone: 'a0' },
      expect.objectContaining({ source: 'registered', row: expect.objectContaining({ session: expect.objectContaining({ agentId: 'a1', sessionId: 'replacement' }) }) }),
      { source: 'registered', gone: 'a2' }, { source: 'registered', gone: 'a3' },
    ])
    const all = await t.capture('registered')
    const occupancy = all.filter(event => event.type === 'row').map(event => event.payload.value)
    expect(occupancy).toHaveLength(5)
    expect(occupancy.filter(member => 'row' in member && member.source === 'registered' && !member.row.facts.terminalAvailable)).toHaveLength(2)
  })

  it.each(['registered', 'advertised'] as const)('keeps current Cloud row semantics and captured append order for %s', async scope => {
    const t = fixture(2, 1)
    t.cloud.set('remote-a', row('remote-a')); t.cloud.set('remote-b', row('remote-b'))
    const events = await t.capture(scope, () => {
      t.cloud.delete('remote-a')
      t.cloud.set('remote-b', { ...row('remote-b'), sessionId: 'rebound', displayName: 'Current', runtimeProfile: 'model' } as RegisteredSession)
      t.cloud.set('remote-late', row('remote-late'))
    })
    const values = events.filter(event => event.type === 'row').map(event => event.payload.value)
    expect(values).toHaveLength(scope === 'registered' ? 4 : 3)
    expect(values.slice(-2)).toEqual([{ source: 'cloud', gone: 'remote-a' },
      { source: 'cloud', row: { agentId: 'remote-b', sessionId: 'rebound', engine: 'claude', registeredAt: 1,
        transcriptPath: null, lastHookAt: 0, displayName: 'Current', selectedModel: 'model' } }])
  })
})
