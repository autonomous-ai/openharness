import { describe, expect, it, vi } from 'vitest'
import { SESSION_READ_HEADER_BYTES, SESSION_READ_VIEW_BYTES, type CoreApi, type ReadRecord, type SessionReadHeader, type SessionReadValue } from '../core/api.js'
import { snapshotFixture, snapshotRow, snapshotReader, snapshotRecords, snapshotMember, type SessionSnapshot } from '../testing/sessionSnapshot.js'
import { readCoreSessionRecords, readSessionView, type SessionRecordSource } from './sessionSnapshot.js'
import { boundedJsonBytes } from '../lib/boundedJsonBytes.js'

const collect = (read: SessionRecordSource) => readSessionView(read, 'registered', header => {
  const result: SessionSnapshot = { ...header, registered: [], cloud: [] }
  return { row: (value, budget) => {
    const member = snapshotMember(value)
    if ('gone' in member) return
    budget.retain(boundedJsonBytes(member.row, budget.remaining))
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
  it('rejects malformed fixed member and launch tuples before projection or commit', async () => {
    const ordinary = (): unknown[] => ['registered', 'agent', 'session', 'claude', 1, null, 0,
      true, null, 'package', null, 'Name', true, null, false, true]
    const cloud = (): unknown[] => ['cloud', 'remote', 'remote-session', 'fo', 2, null, 3, 'Cloud', null]
    const source = (members: unknown[]) => records([
      { type: 'begin', payload: { count: members.length, header: { version: 2,
        machine: { id: 'machine', computerId: 'computer', name: 'Desk' }, signedIn: true, environment: 'prod', hasWindow: true } } },
      ...members.map((value, index) => ({ type: 'row', payload: { index, value } })),
      { type: 'end', payload: { count: members.length } },
    ])
    const project = vi.fn(), commit = vi.fn(() => 'complete'), observe = vi.fn()
    const build = () => ({ row: project, value: commit })
    await expect(readSessionView(source([ordinary(), cloud(), ['gone', 'registered', 'removed']]), 'registered', build))
      .resolves.toBe('complete')
    expect(project).toHaveBeenCalledTimes(3)
    const malformed: unknown[] = [null, {}, [], ordinary().slice(0, -1), [...ordinary(), 'extra'], cloud().slice(0, -1), [...cloud(), 'extra'],
      ['gone', 'other', 'removed'], ['gone', 'registered', ''], ['gone', 'cloud', 'removed', 'extra']]
    for (const [index, value] of [[0, 'other'], [1, ''], [2, null], [3, ''], [4, Infinity], [5, 7], [6, '0'],
      [7, 0], [8, false], [9, true], [9, 7], [11, 7], [12, 7], [13, 7], [14, null], [15, null], [15, 7]] as const) {
      const member = ordinary(); member[index] = value; malformed.push(member)
    }
    for (const launch of [{ state: 'ready' }, [], ['unknown'], ['ready', 'extra'], ['starting', 'extra'],
      ['failed'], ['failed', 7, false], ['failed', 'FAILED', 7], ['failed', 'FAILED', false, 'extra'],
      ['held', 7, 'detail'], ['held', 'engine', 7], ['held', 'engine', 'detail', 'extra']]) {
      const member = ordinary(); member[10] = launch; malformed.push(member)
    }
    for (const stored of [false, null]) {
      const member = ordinary(); member[9] = stored; malformed.push(member)
    }
    for (const [index, value] of [[1, ''], [2, null], [3, ''], [4, Infinity], [5, 7], [6, '0'], [7, 7], [8, false]] as const) {
      const member = cloud(); member[index] = value; malformed.push(member)
    }
    for (const member of malformed) {
      project.mockClear(); commit.mockClear(); observe.mockClear()
      await expect(readSessionView(source([member]), 'registered', build, undefined, observe)).rejects.toThrow('SESSION_READ_UNAVAILABLE')
      expect(project).not.toHaveBeenCalled(); expect(commit).not.toHaveBeenCalled()
      expect(observe).toHaveBeenCalledTimes(1)
    }
    project.mockClear(); commit.mockClear()
    await expect(readSessionView(source([ordinary(), ['gone', 'registered', 'agent']]), 'registered', build)).rejects.toThrow('SESSION_READ_UNAVAILABLE')
    expect(project).toHaveBeenCalledOnce(); expect(commit).not.toHaveBeenCalled()
  })

  it('refuses unsafe tuple iteration before any typed row observer or projection', async () => {
    const ordinary = (): unknown[] => ['registered', 'agent', 'session', 'claude', 1, null, 0,
      true, null, 'package', ['failed', 'FAILED', false], 'Name', true, null, false, true]
    const source = (member: unknown) => records([
      { type: 'begin', payload: { count: 1, header: { version: 2,
        machine: { id: 'machine', computerId: 'computer', name: 'Desk' }, signedIn: true, environment: 'prod', hasWindow: true } } },
      { type: 'row', payload: { index: 0, value: member } },
      { type: 'end', payload: { count: 1 } },
    ])
    const project = vi.fn(), observe = vi.fn(), build = () => ({ row: project, value: () => 'complete' })
    await expect(readSessionView(source(ordinary()), 'registered', build, undefined, observe)).resolves.toBe('complete')
    expect(project).toHaveBeenCalledOnce(); expect(observe).toHaveBeenCalledTimes(3)
    const invoked = vi.fn(() => { throw new Error('PRIVATE') })
    const unsafe: unknown[][] = [Object.setPrototypeOf(ordinary(), null)]
    for (const nested of [false, true]) {
      for (const getter of [false, true]) {
        const member = ordinary(), target = nested ? member[10] as unknown[] : member
        Object.defineProperty(target, Symbol.iterator, getter ? { get: invoked } : { value: invoked })
        unsafe.push(member)
      }
    }
    const accessor = ordinary()
    Object.defineProperty(accessor, '1', { enumerable: true, get: invoked }); unsafe.push(accessor)
    const json = ordinary(); Object.defineProperty(json, 'toJSON', { get: invoked }); unsafe.push(json)
    unsafe.push(new Proxy(ordinary(), { get: invoked }))
    for (const member of unsafe) {
      project.mockClear(); observe.mockClear()
      await expect(readSessionView(source(member), 'registered', build, undefined, observe)).rejects.toThrow('SESSION_READ_UNAVAILABLE')
      expect(project).not.toHaveBeenCalled()
      expect(observe).toHaveBeenCalledTimes(1)
      expect(observe.mock.calls[0][0].type).toBe('begin')
    }
    expect(invoked).not.toHaveBeenCalled()
  })

  it('validates before typed observation and observes before provisional projection or acknowledgement', async () => {
    const order: string[] = [], snapshot = snapshotRecords(snapshotFixture({ registered: [snapshotRow()] }))
    const read: SessionRecordSource = async (_scope, receive) => {
      for (const record of snapshot) {
        expect(receive(record, ok => { expect(ok).toBe(true); order.push(`ack ${record.type}`) })).toBe(true)
      }
    }
    expect(await readSessionView(read, 'registered', () => {
      order.push('build'); return { row: () => { order.push('project') }, value: () => { order.push('commit'); return 'done' } }
    }, undefined, record => { order.push(`observe ${record.type}`) })).toBe('done')
    expect(order).toEqual(['observe begin', 'build', 'ack begin', 'observe row', 'project', 'ack row', 'observe end', 'ack end', 'commit'])
    const observe = vi.fn(), build = vi.fn()
    await expect(readSessionView(records([{ type: 'begin', payload: { header: null, count: 0 } }]), 'registered', build, undefined, observe))
      .rejects.toThrow('SESSION_READ_UNAVAILABLE')
    expect(observe).not.toHaveBeenCalled(); expect(build).not.toHaveBeenCalled()
    const acknowledge = vi.fn()
    await expect(readSessionView(async (_scope, receive) => { receive(snapshot[0], acknowledge) }, 'registered', build, undefined,
      () => { throw new Error('OWNER_CHANGED') })).rejects.toThrow('OWNER_CHANGED')
    expect(acknowledge).not.toHaveBeenCalled(); expect(build).not.toHaveBeenCalled()
  })
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
      () => null, () => [], v => ({ ...v, version: 1 }), v => ({ ...v, registered: null }), v => ({ ...v, cloud: {} }),
      v => ({ ...v, machine: null }), v => ({ ...v, machine: { ...v.machine, id: '' } }), v => ({ ...v, machine: { ...v.machine, id: 7 } }),
      v => ({ ...v, machine: { ...v.machine, computerId: null } }), v => ({ ...v, machine: { ...v.machine, name: false } }),
      v => ({ ...v, signedIn: 1 }), v => ({ ...v, environment: null }), v => ({ ...v, hasWindow: '' }),
      v => ({ ...v, registered: [null] }), v => ({ ...v, registered: [{ ...v.registered[0], session: null }] }),
    ]
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
    const gone = { type: 'row', payload: { index: 0, value: ['gone', 'registered', 'deleted'] } }
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
      row: (_value, budget) => budget.retain(SESSION_READ_VIEW_BYTES), value: commit,
    }))).rejects.toThrow('SESSION_READ_TOO_LARGE')
    expect(commit).not.toHaveBeenCalled()
    const failure = records(snapshotRecords(complete()))
    await expect(readSessionView(failure, 'registered', () => { throw new Error('PROJECT_FAILED') })).rejects.toThrow('PROJECT_FAILED')
  })

  it('adapts only available record transport and requires synchronous acknowledged projection', async () => {
    await expect(readCoreSessionRecords({ query: vi.fn() }, 'registered', vi.fn())).rejects.toThrow('SESSION_READ_UNAVAILABLE')
    const value = snapshotRecords(snapshotFixture())[0]
    const read = vi.fn(async (_query, _payload, receive) => receive(value))
    const core = { query: vi.fn(), read }, controller = new AbortController()
    const receive = vi.fn((_record, settled) => { settled(true); return true })
    await readCoreSessionRecords(core, 'registered', receive, controller.signal)
    expect(read).toHaveBeenCalledWith('session_read_registered', {}, expect.any(Function), controller.signal)
    await readCoreSessionRecords(core, 'advertised', receive, controller.signal)
    expect(read).toHaveBeenLastCalledWith('session_read_advertised', {}, expect.any(Function), controller.signal)
    expect(core.query).not.toHaveBeenCalled()
    for (const handle of [() => false, () => true, (_record: unknown, settled: (sent: boolean) => void) => { settled(false); return true },
      (_record: unknown, settled: (sent: boolean) => void) => { settled(true); settled(true); return true }]) {
      await expect(readCoreSessionRecords(core, 'registered', handle)).rejects.toThrow('SESSION_READ_UNAVAILABLE')
    }
    read.mockImplementationOnce(async (_query, _payload, receive) => receive({ type: 'begin', payload: {} }))
    await expect(collect((scope, receive, signal) => readCoreSessionRecords(core, scope, receive, signal))).rejects.toThrow('SESSION_READ_UNAVAILABLE')
  })

  it('keeps exact aggregate capacity and object overhead when admitting projection bytes', async () => {
    const snapshot = snapshotFixture({ registered: [snapshotRow('one')] }), input = snapshotRecords(snapshot)
    const headerBytes = boundedJsonBytes((input[0] as { payload: { header: unknown } }).payload.header, SESSION_READ_VIEW_BYTES)!
    const expected = SESSION_READ_VIEW_BYTES - headerBytes - 48 - 48 - 2 * 'one'.length - 48
    for (const extra of [0, 1]) {
      const commit = vi.fn(() => 'complete'), retained: number[] = []
      const result = readSessionView(records(input), 'registered', () => ({ row: (_member, budget) => {
        expect(budget.remaining).toBe(expected)
        budget.retain(expected + extra)
        retained.push(expected + extra)
        expect(budget.remaining).toBe(-48)
      }, value: commit }))
      if (extra) {
        await expect(result).rejects.toThrow('SESSION_READ_TOO_LARGE')
        expect(retained).toEqual([]); expect(commit).not.toHaveBeenCalled()
      } else {
        await expect(result).resolves.toBe('complete')
        expect(retained).toEqual([expected]); expect(commit).toHaveBeenCalledOnce()
      }
    }
    const commit = vi.fn()
    await expect(readSessionView(records(input), 'registered', () => ({ row: (_member, budget) => {
      budget.retain(budget.remaining)
      budget.retain(0)
    }, value: commit }))).rejects.toThrow('SESSION_READ_TOO_LARGE')
    expect(commit).not.toHaveBeenCalled()
  })

  it.each([null, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('refuses invalid projection byte admission %s', async bytes => {
    const commit = vi.fn()
    await expect(readSessionView(records(snapshotRecords(snapshotFixture({ registered: [snapshotRow()] }))), 'registered', () => ({
      row: (_member, budget) => budget.retain(bytes), value: commit,
    }))).rejects.toThrow('SESSION_READ_TOO_LARGE')
    expect(commit).not.toHaveBeenCalled()
  })

  it('bounds membership retained by the component even when every member is gone', async () => {
    const commit = vi.fn(), id = 'x'.repeat(7 * 1024 * 1024)
    const members = Array.from({ length: 5 }, (_, index) => ({ type: 'row', payload: { index, value: ['gone', 'registered', `${index}${id}`] } }))
    await expect(readSessionView(records([{ type: 'begin', payload: { header: snapshotFixture(), count: 5 } }, ...members]), 'registered',
      () => ({ row: () => {}, value: commit }))).rejects.toThrow('SESSION_READ_TOO_LARGE')
    expect(commit).not.toHaveBeenCalled()
  })
})
