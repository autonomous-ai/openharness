import { afterEach, describe, expect, it, vi } from 'vitest'
import { readSessions, SESSION_READ_MEMBERS_BYTES, type CoreApiDeps, type ReadRecord, type SessionReadHeader, type SessionReadValue } from './api.js'
import type { RegisteredSession } from '../lib/registry.js'
import { snapshotRow, snapshotMember } from '../testing/sessionSnapshot.js'

type Event = ReadRecord<SessionReadHeader, SessionReadValue>
const legacy = (events: Event[]) => events.map(event => event.type === 'row'
  ? { ...event, payload: { ...event.payload, value: snapshotMember(event.payload.value) } } : event)
const row = (id: string) => ({ ...snapshotRow(id).session, defaultName: `Name ${id}` }) as RegisteredSession
function fixture() {
  const members = new Map(['a', 'b', 'c'].map(id => [id, row(id)])), cloud = new Map<string, RegisteredSession>()
  const identity = { machine: 'machine', computer: 'computer', signedIn: true, environment: 'prod' }
  const facts = vi.fn((value: RegisteredSession) => ({ displayName: value.defaultName!, terminalAvailable: true, parts: {} }))
  const deps = {
    registry: { list: () => { throw new Error('must not materialize registry') }, rows: () => members.values(), byAgent: (id: string) => members.get(id) } as unknown as CoreApiDeps['registry'],
    cloudRead: { ids: () => cloud.keys(), row: (id: string) => cloud.get(id) }, facts, runtimeProfile: () => null,
    turns: { running: () => false } as unknown as CoreApiDeps['turns'],
    machine: { id: () => identity.machine, computerId: () => identity.computer, name: () => 'Desk' },
    signedIn: () => identity.signedIn, environment: () => identity.environment, hasWindow: () => true, log: vi.fn(),
  } satisfies Parameters<typeof readSessions>[0]
  const events: Event[] = [], callbacks: Array<(ok: boolean) => void> = []
  const start = (signal?: AbortSignal) => readSessions(deps, (event, settled) => { events.push(event); callbacks.push(settled); return true }, signal)
  const advance = async () => { callbacks.shift()!(true); await vi.advanceTimersByTimeAsync(1) }
  return { deps, members, cloud, identity, events, callbacks, start, advance, facts }
}
afterEach(() => vi.useRealTimers())

describe('complete membership and current per-row facts', () => {
  it.each([
    [undefined, undefined, false, false], [null, undefined, null, false], ['stored', undefined, 'stored', false],
    [undefined, 'published', false, 'published'], [null, 'published', null, 'published'],
    ['same', 'same', 'same', true], ['', '', '', true], ['stored', 'published', 'stored', 'published'],
  ] as const)('emits compact session facts with lossless DSH values %j / %j', async (stored, published, storedWire, publishedWire) => {
    vi.useFakeTimers()
    const t = fixture(); t.members.clear()
    const current = row('compact')
    if (stored === undefined) delete current.dsh
    else current.dsh = stored
    t.members.set(current.agentId, current)
    t.facts.mockImplementation(value => ({ displayName: value.defaultName!, terminalAvailable: true,
      parts: published === undefined ? {} : { dsh: published } }))
    const pending = t.start()
    await t.advance(); await t.advance(); await t.advance(); await pending
    expect(t.events[1]).toEqual({ type: 'row', payload: { index: 0, value: [
      'registered', 'compact', 's-compact', 'claude', 1, null, 0, true, null, storedWire, null,
      'Name compact', true, null, false, publishedWire,
    ] } })
    expect(t.events[0]).toMatchObject({ type: 'begin', payload: { count: 1, header: { version: 2 } } })
    expect(t.facts).toHaveBeenCalledOnce()
  })

  it('sends a compact session large package once while preserving its complete value', async () => {
    vi.useFakeTimers()
    const t = fixture(); t.members.clear()
    const dsh = `package/${'x'.repeat(1_600_000)}`
    t.members.set('large', { ...row('large'), dsh })
    t.facts.mockImplementation(value => ({ displayName: value.defaultName!, terminalAvailable: true, parts: { dsh } }))
    const pending = t.start()
    await t.advance(); await t.advance(); await t.advance(); await pending
    const wire = JSON.stringify(t.events[1])
    expect(wire.split(dsh)).toHaveLength(2)
    expect(Buffer.byteLength(wire)).toBeLessThan(Buffer.byteLength(dsh) + 512)
    expect(t.events[1]).toMatchObject({ payload: { value: [
      'registered', 'large', 's-large', 'claude', 1, null, 0, true, null, dsh, null,
      'Name large', true, null, false, true,
    ] } })
  })

  it('captures no new members, emits gone, reads replacements, and keeps facts already emitted', async () => {
    vi.useFakeTimers()
    const t = fixture()
    t.members.get('a')!.launch = { state: 'held', service: 'engine', detail: 'Waiting' }
    const pending = t.start()
    expect(legacy(t.events)[0]).toMatchObject({ type: 'begin', payload: { count: 3 } })
    t.members.set('late', row('late')); t.members.delete('b')
    t.members.set('c', { ...row('c'), sessionId: 'replacement' })
    await t.advance()
    expect(legacy(t.events)[1]).toMatchObject({ type: 'row', payload: { index: 0, value: { source: 'registered', row: { facts: { displayName: 'Name a' } } } } })
    t.members.get('a')!.defaultName = 'After emission'
    t.members.get('c')!.defaultName = 'Before emission'
    await t.advance()
    expect(legacy(t.events)[2]).toEqual({ type: 'row', payload: { index: 1, value: { source: 'registered', gone: 'b' } } })
    await t.advance()
    expect(legacy(t.events)[3]).toMatchObject({ payload: { value: { row: { session: { sessionId: 'replacement' }, facts: { displayName: 'Before emission' } } } } })
    await t.advance(); expect(legacy(t.events).at(-1)).toEqual({ type: 'end', payload: { count: 3 } })
    await t.advance(); await pending
    expect(legacy(t.events)[1]).toMatchObject({ payload: { value: { row: { facts: { displayName: 'Name a' } } } } })
    expect(t.facts).toHaveBeenCalledTimes(2)
    expect(legacy(t.events)[1]).toMatchObject({ payload: { value: { row: { session: { launch: { state: 'held', service: 'engine', detail: 'Waiting' } } } } } })
  })

  it('reads a same-id re-add and current Cloud metadata without retaining old row objects', async () => {
    vi.useFakeTimers()
    const t = fixture(); t.members.clear(); t.members.set('a', row('a'))
    t.cloud.set('cloud-a', row('cloud-a')); t.cloud.set('cloud-b', row('cloud-b'))
    const pending = t.start()
    t.members.delete('a'); t.members.set('a', { ...row('a'), sessionId: 'readded' })
    t.cloud.set('late', row('late')); t.cloud.delete('cloud-a')
    t.cloud.set('cloud-b', { ...row('cloud-b'), sessionId: 'new-cloud', displayName: 'New Cloud', runtimeProfile: 'selected' } as RegisteredSession)
    await t.advance(); await t.advance(); await t.advance(); await t.advance(); await t.advance(); await pending
    expect(legacy(t.events)[1]).toMatchObject({ payload: { value: { row: { session: { sessionId: 'readded' } } } } })
    expect(legacy(t.events)[2]).toMatchObject({ payload: { value: { source: 'cloud', gone: 'cloud-a' } } })
    expect(legacy(t.events)[3]).toMatchObject({ payload: { value: { source: 'cloud', row: { sessionId: 'new-cloud', displayName: 'New Cloud', selectedModel: 'selected' } } } })
  })

  it.each(['machine', 'computer', 'signedIn', 'environment'] as const)('refuses identity replacement in %s before another row', async key => {
    vi.useFakeTimers()
    const t = fixture(), pending = t.start(), failed = expect(pending).rejects.toThrow('SESSION_READ_UNAVAILABLE')
    if (key === 'signedIn') t.identity.signedIn = false
    else t.identity[key] = 'replacement'
    await t.advance(); await failed
    expect(legacy(t.events)).toHaveLength(1); expect(t.facts).not.toHaveBeenCalled()
  })

  it('retains no logical read after abort, including a reentrant abort while begin is sent', async () => {
    vi.useFakeTimers()
    const t = fixture(), controller = new AbortController(), pending = t.start(controller.signal)
    const failed = expect(pending).rejects.toThrow('SESSION_READ_UNAVAILABLE')
    controller.abort(); await failed
    t.callbacks[0](true); await vi.runOnlyPendingTimersAsync()
    expect(t.facts).not.toHaveBeenCalled()
    const reentrant = new AbortController()
    await expect(readSessions(t.deps, (_event, _settled) => { reentrant.abort(); return true }, reentrant.signal)).rejects.toThrow('SESSION_READ_UNAVAILABLE')
    expect(vi.getTimerCount()).toBe(0)
    await expect(readSessions(t.deps, vi.fn(), controller.signal)).rejects.toThrow('SESSION_READ_UNAVAILABLE')
  })

  it('uses one deadline through physical end settlement and never advances a held send', async () => {
    vi.useFakeTimers()
    const t = fixture(); t.members.clear()
    const pending = t.start(), failed = expect(pending).rejects.toThrow('SESSION_READ_TIMEOUT')
    await vi.advanceTimersByTimeAsync(19_000)
    expect(legacy(t.events)).toHaveLength(1)
    await t.advance(); expect(legacy(t.events).at(-1)?.type).toBe('end')
    await vi.advanceTimersByTimeAsync(1_000); await failed
    t.callbacks.shift()!(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('bounds membership before copying it or visiting row facts, including an elapsed capture deadline', async () => {
    const t = fixture()
    t.members.clear(); t.members.set('oversize', { ...row('oversize'), agentId: 'x'.repeat(SESSION_READ_MEMBERS_BYTES / 2) })
    await expect(t.start()).rejects.toThrow('SESSION_READ_TOO_LARGE')
    expect(legacy(t.events)).toHaveLength(0); expect(t.facts).not.toHaveBeenCalled()
    t.members.clear(); t.members.set('a', row('a'))
    const now = vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValue(20_000)
    try { await expect(t.start()).rejects.toThrow('SESSION_READ_TIMEOUT') } finally { now.mockRestore() }
    expect(legacy(t.events)).toHaveLength(0)
    t.deps.registry.rows = () => { throw 'private failure' }
    await expect(t.start()).rejects.toThrow('SESSION_READ_UNAVAILABLE')
    expect(JSON.stringify(t.deps.log.mock.calls)).not.toContain('private')
    t.identity.machine = ''
    await expect(t.start()).rejects.toThrow('SESSION_READ_UNAVAILABLE')
  })

  it('refuses an unavailable sink and source instead of completing partial membership', async () => {
    vi.useFakeTimers()
    const t = fixture()
    await expect(readSessions(t.deps, () => { throw new Error('PRIVATE') })).rejects.toThrow('SESSION_READ_UNAVAILABLE')
    const pending = t.start(), failed = expect(pending).rejects.toThrow('SESSION_READ_UNAVAILABLE')
    t.facts.mockImplementationOnce(() => { throw 'PRIVATE' })
    await t.advance(); await failed
    expect(legacy(t.events)).toHaveLength(1)
    expect(JSON.stringify(t.deps.log.mock.calls)).not.toContain('PRIVATE')
  })

  it('settles a refusal even when its diagnostic sink throws', async () => {
    const t = fixture(); t.identity.machine = ''
    t.deps.log.mockImplementation(() => { throw new Error('LOG_UNAVAILABLE') })
    await expect(t.start()).rejects.toThrow('SESSION_READ_UNAVAILABLE')
    expect(t.deps.log).toHaveBeenCalledOnce()
  }, 500)
})
