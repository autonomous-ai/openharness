import { describe, expect, it } from 'vitest'
import { SESSION_SNAPSHOT_MAX_BYTES, SESSION_SNAPSHOT_MAX_ROWS } from '../core/api.js'
import { snapshotFixture, snapshotRow } from '../testing/sessionSnapshot.js'
import { sessionSnapshot } from './sessionSnapshot.js'

const complete = () => snapshotFixture({ registered: [snapshotRow()], cloud: [{ agentId: 'cloud', sessionId: 'remote', engine: 'fo',
  registeredAt: 1, transcriptPath: null, lastHookAt: 0, displayName: 'Remote', selectedModel: null }] })
describe('complete shared session facts at the component boundary', () => {
  it('keeps the lean facts, real transcript path, exact launch states, and cloud names', () => {
    const value = complete()
    value.registered[0].session.transcriptPath = '/history/session'
    value.registered[0].facts.parts.dsh = 'published/package'
    expect(sessionSnapshot(value)).toBe(value)
    for (const launch of [undefined, { state: 'starting' }, { state: 'ready' }, { state: 'held', service: 'engine', detail: 'wait' },
      { state: 'failed', error: 'FAILED' }, { state: 'failed', error: 'FAILED', detail: 'detail' }] as const) {
      value.registered[0].session.launch = launch
      expect(sessionSnapshot(value).registered[0].session.launch).toEqual(launch)
    }
    delete value.registered[0].session.dsh
    expect(sessionSnapshot(value)).toBe(value)
  })
  it('refuses the whole reply for any malformed header or row instead of truncating occupancy', () => {
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
    for (const change of changes) expect(() => sessionSnapshot(change(complete()))).toThrow('SESSION_SNAPSHOT_UNAVAILABLE')
    const duplicate = complete(); duplicate.registered.push(duplicate.registered[0])
    expect(() => sessionSnapshot(duplicate)).toThrow('SESSION_SNAPSHOT_UNAVAILABLE')
    duplicate.registered.pop(); duplicate.cloud[0].agentId = duplicate.registered[0].session.agentId
    expect(() => sessionSnapshot(duplicate)).toThrow('SESSION_SNAPSHOT_UNAVAILABLE')
  })
  it('rejects oversized or executable objects before reading their fields', () => {
    const excessive = complete(); excessive.machine.name = 'x'.repeat(SESSION_SNAPSHOT_MAX_BYTES + 4096)
    expect(() => sessionSnapshot(excessive)).toThrow('SESSION_SNAPSHOT_UNAVAILABLE')
    expect(() => sessionSnapshot(snapshotFixture({ registered: Array(SESSION_SNAPSHOT_MAX_ROWS + 1).fill(snapshotRow()) }))).toThrow('SESSION_SNAPSHOT_UNAVAILABLE')
    let read = false
    const accessor = Object.defineProperty(complete(), 'version', { enumerable: true, get() { read = true; throw new Error('private') } })
    expect(() => sessionSnapshot(accessor)).toThrow('SESSION_SNAPSHOT_UNAVAILABLE')
    expect(read).toBe(false)
    expect(() => sessionSnapshot(new Proxy(complete(), {}))).toThrow('SESSION_SNAPSHOT_UNAVAILABLE')
  })
})
