import { describe, expect, it, vi } from 'vitest'
import { SESSION_READ_HEADER_BYTES, SESSION_READ_VIEW_BYTES, type CoreApi, type ReadRecord, type SessionReadHeader, type SessionReadValue } from '../core/api.js'
import { snapshotFixture, snapshotRow, snapshotReader, snapshotRecords, type SessionSnapshot } from '../testing/sessionSnapshot.js'
import { readCoreSessions, readSessionView } from './sessionSnapshot.js'

const collect = (read: CoreApi['agents']['readSessions']) => readSessionView(read, 'registered', header => {
  const result: SessionSnapshot = { ...header, registered: [], cloud: [] }
  return { row: (member, retain) => {
    if ('gone' in member) return
    retain(member.row)
    if (member.source === 'registered') result.registered.push(member.row)
    else result.cloud.push(member.row)
  }, value: () => result }
})
const sessionSnapshot = (value: unknown) => collect(snapshotReader(() => value))
const records = (values: unknown[]): CoreApi['agents']['readSessions'] => async (_scope, receive) => {
  for (const value of values) { let ok = false; if (!receive(value as ReadRecord<SessionReadHeader, SessionReadValue>, sent => { ok = sent }) || !ok) throw new Error('READ_REFUSED') }
}
const complete = () => snapshotFixture({ registered: [snapshotRow()], cloud: [{ agentId: 'cloud', sessionId: 'remote', engine: 'fo',
  registeredAt: 1, transcriptPath: null, lastHookAt: 0, displayName: 'Remote', selectedModel: null }] })
describe('complete shared session facts at the component boundary', async () => {
  it.each(['membership', 'aggregate bytes'])('reads complete valid %s beyond the former whole-reply limit', async kind => {
    const registered = Array.from({ length: kind === 'membership' ? 4097 : 1600 }, (_, i) => snapshotRow(`a-${i}`))
    if (kind === 'aggregate bytes') {
      // Two legal 1.6 MB publications stay below the existing 4 MiB global parts budget.
      for (const i of [8, 9]) registered[i].session.dsh = registered[i].facts.parts.dsh = 'p'.repeat(1_600_000)
    }
    const value = snapshotFixture({ registered })
    expect((await sessionSnapshot(value)).registered).toHaveLength(registered.length)
  })
  it('keeps the lean facts, real transcript path, exact launch states, and cloud names', async () => {
    const value = complete()
    value.registered[0].session.transcriptPath = '/history/session'
    value.registered[0].facts.parts.dsh = 'published/package'
    expect(await sessionSnapshot(value)).toEqual(value)
    for (const launch of [undefined, { state: 'starting' }, { state: 'ready' }, { state: 'held', service: 'engine', detail: 'wait' },
      { state: 'failed', error: 'FAILED' }, { state: 'failed', error: 'FAILED', detail: 'detail' }] as const) {
      value.registered[0].session.launch = launch
      expect((await sessionSnapshot(value)).registered[0].session.launch).toEqual(launch)
    }
    delete value.registered[0].session.dsh
    expect(await sessionSnapshot(value)).toEqual(value)
  })
  it('refuses the whole reply for any malformed header or row instead of truncating occupancy', async () => {
    const changes: Array<(v: any) => unknown> = [
      () => null, () => [], v => ({ ...v, version: 2 }), v => ({ ...v, registered: null }), v => ({ ...v, cloud: {} }),
      v => ({ ...v, machine: null }), v => ({ ...v, machine: { ...v.machine, id: '' } }), v => ({ ...v, machine: { ...v.machine, id: 7 } }),
      v => ({ ...v, machine: { ...v.machine, computerId: null } }), v => ({ ...v, machine: { ...v.machine, name: false } }),
      v => ({ ...v, signedIn: 1 }), v => ({ ...v, environment: null }), v => ({ ...v, hasWindow: '' }),
      v => ({ ...v, registered: [null] }), v => ({ ...v, registered: [{ ...v.registered[0], session: null }] }),
    ]
    for (const [key, value] of Object.entries({ agentId: '', sessionId: null, engine: '', registeredAt: Infinity, transcriptPath: 7, lastHookAt: '0', active: 0, cwd: false, dsh: 1 })) {
      changes.push(v => { v.registered[0].session[key] = value; return v })
    }
    for (const launch of [null, { state: 'unknown' }, { state: 'failed', error: 7 }, { state: 'failed', error: 'E', detail: 7 },
      { state: 'held', service: 7, detail: 'why' }, { state: 'held', service: 's', detail: 7 }]) {
      changes.push(v => { v.registered[0].session.launch = launch; return v })
    }
    for (const facts of [null, { displayName: 7 }, { displayName: '', terminalAvailable: 7 }, { displayName: '', terminalAvailable: false, parts: [] },
      { displayName: '', terminalAvailable: false, parts: { dsh: 7 } }]) changes.push(v => { v.registered[0].facts = facts; return v })
    for (const [key, value] of [['selectedModel', 7], ['turnRunning', null]]) changes.push(v => { v.registered[0][key as string] = value; return v })
    for (const cloud of [null, {}, { ...complete().cloud[0], displayName: 7 }, { ...complete().cloud[0], selectedModel: false }]) changes.push(v => ({ ...v, cloud: [cloud] }))
    for (const change of changes) await expect(sessionSnapshot(change(complete()))).rejects.toThrow('SESSION_READ_UNAVAILABLE')
    const duplicate = complete(); duplicate.registered.push(duplicate.registered[0])
    await expect(sessionSnapshot(duplicate)).rejects.toThrow('SESSION_READ_UNAVAILABLE')
    duplicate.registered.pop(); duplicate.cloud[0].agentId = duplicate.registered[0].session.agentId
    await expect(sessionSnapshot(duplicate)).rejects.toThrow('SESSION_READ_UNAVAILABLE')
  })
  it('rejects oversized or executable records before reading their fields', async () => {
    const excessive = complete(); excessive.machine.name = 'x'.repeat(SESSION_READ_HEADER_BYTES + 4096)
    await expect(sessionSnapshot(excessive)).rejects.toThrow('SESSION_READ_UNAVAILABLE')
    let read = false
    const accessor = Object.defineProperty(snapshotRecords(complete())[0], 'type', { enumerable: true, get() { read = true; throw new Error('private') } })
    await expect(collect(records([accessor]))).rejects.toThrow('SESSION_READ_UNAVAILABLE')
    expect(read).toBe(false)
    await expect(collect(records([new Proxy(snapshotRecords(complete())[0], {})]))).rejects.toThrow('SESSION_READ_UNAVAILABLE')
  })

  it('requires one complete contiguous read, including explicit gone membership', async () => {
    const valid = snapshotRecords(complete()), begin = valid[0], end = valid.at(-1)!
    const invalid: unknown[][] = [[], [null], [[]], [{}], [{ type: 'other', payload: {} }], [begin], [end],
      [begin, begin], [begin, end], [...valid, end], [begin, { type: 'row', payload: { index: 1, value: {} } }],
      [begin, { type: 'row', payload: { index: 0, value: null } }],
      [begin, { type: 'row', payload: { index: 0, value: { source: 'other' } } }],
      [begin, { type: 'row', payload: { index: 0, value: { source: 'registered', gone: '' } } }],
      [begin, { type: 'row', payload: { index: 0, value: { source: 'registered', gone: 'a', row: {} } } }],
      [begin, { type: 'row', payload: { index: 0, value: { source: 'registered', row: [] } } }],
      [{ ...begin, payload: { ...begin.payload, count: -1 } }], [{ type: 'end', payload: { count: '0' } }],
      [{ type: 'begin', payload: null }],
      [{ type: 'begin', payload: { header: snapshotFixture(), count: 0 } }, valid[1]],
    ]
    for (const value of invalid) await expect(collect(records(value))).rejects.toThrow('SESSION_READ_UNAVAILABLE')
    const gone = { type: 'row', payload: { index: 0, value: { source: 'registered', gone: 'deleted' } } }
    const value = await collect(records([{ ...begin, payload: { ...begin.payload, count: 1 } }, gone, { type: 'end', payload: { count: 1 } }]))
    expect(value.registered).toEqual([]); expect(value.cloud).toEqual([])
    const duplicateGone = { ...gone, payload: { ...gone.payload, index: 1 } }
    await expect(collect(records([begin, gone, duplicateGone, end]))).rejects.toThrow('SESSION_READ_UNAVAILABLE')
  })

  it('never publishes failed provisional rows and admits projected retention before keeping it', async () => {
    const commit = vi.fn(), held: unknown[] = []
    const incomplete = snapshotRecords(complete()).slice(0, -1)
    await expect(readSessionView(records(incomplete), 'registered', () => ({ row: value => { held.push(value) }, value: commit }))).rejects.toThrow('SESSION_READ_UNAVAILABLE')
    expect(held).toHaveLength(2); expect(commit).not.toHaveBeenCalled()
    await expect(readSessionView(records(snapshotRecords(complete())), 'registered', () => ({
      row: (_value, retain) => retain('x'.repeat(SESSION_READ_VIEW_BYTES)), value: commit,
    }))).rejects.toThrow('SESSION_READ_TOO_LARGE')
    expect(commit).not.toHaveBeenCalled()
    const failure = records(snapshotRecords(complete()))
    await expect(readSessionView(failure, 'registered', () => { throw new Error('PROJECT_FAILED') })).rejects.toThrow('PROJECT_FAILED')
  })

  it('adapts only available record transport and requires synchronous acknowledged projection', async () => {
    await expect(readCoreSessions({ query: vi.fn() }, 'registered', vi.fn())).rejects.toThrow('SESSION_READ_UNAVAILABLE')
    const value = snapshotRecords(snapshotFixture())[0]
    const read = vi.fn(async (_query, _payload, receive) => receive(value))
    const core = { query: vi.fn(), read }, controller = new AbortController()
    const receive = vi.fn((_record, settled) => { settled(true); return true })
    await readCoreSessions(core, 'registered', receive, controller.signal)
    expect(read).toHaveBeenCalledWith('session_read_registered', {}, expect.any(Function), controller.signal)
    await readCoreSessions(core, 'advertised', receive, controller.signal)
    expect(read).toHaveBeenLastCalledWith('session_read_advertised', {}, expect.any(Function), controller.signal)
    expect(core.query).not.toHaveBeenCalled()
    for (const handle of [() => false, () => true, (_record: unknown, settled: (sent: boolean) => void) => { settled(false); return true },
      (_record: unknown, settled: (sent: boolean) => void) => { settled(true); settled(true); return true }]) {
      await expect(readCoreSessions(core, 'registered', handle)).rejects.toThrow('SESSION_READ_UNAVAILABLE')
    }
    read.mockImplementationOnce(async (_query, _payload, receive) => receive({ type: 'begin', payload: {} }))
    await expect(readCoreSessions(core, 'registered', receive)).rejects.toThrow('SESSION_READ_UNAVAILABLE')
  })

  it('bounds membership retained by the component even when every member is gone', async () => {
    const commit = vi.fn(), id = 'x'.repeat(7 * 1024 * 1024)
    const members = Array.from({ length: 5 }, (_, index) => ({ type: 'row', payload: { index, value: { source: 'registered', gone: `${index}${id}` } } }))
    await expect(readSessionView(records([{ type: 'begin', payload: { header: snapshotFixture(), count: 5 } }, ...members]), 'registered',
      () => ({ row: () => {}, value: commit }))).rejects.toThrow('SESSION_READ_TOO_LARGE')
    expect(commit).not.toHaveBeenCalled()
  })
})
