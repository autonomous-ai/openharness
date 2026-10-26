import { describe, expect, it } from 'vitest'
import { FIXTURE, readFixture } from './fixtures/read/index.js'
import { mergeChanges, storeOf, type PartsStore } from './partsStore.js'
import type { ChangedParts, FirstLoad } from './readContract.js'

const first = () => storeOf(readFixture<FirstLoad>('parts-lead'))
const keys = (store: PartsStore, kind: Parameters<PartsStore['parts']['get']>[0]) => [...store.parts.get(kind)!.keys()]
const changes = (patch: Partial<ChangedParts>): ChangedParts => ({ format: 2, reload: false, cursor: 'next', serverTime: 2, lastChangedAt: 2, epoch: 3,
  head: null, members: [], agents: [], groups: [], machines: [], starts: [], progress: [], derived: { agents: {}, machines: {} }, ...patch })

describe('a Swarm read as parts', () => {
  it('keeps every part of a first load in its order, with the cursor, epoch, change time and derived values', () => {
    const store = first()
    expect(store).toMatchObject({ cursor: 'eyJ2IjoyLCJ0IjoxNzkzMDEwMDc0Mzc1LCJlIjozfQ', epoch: 3, lastChangedAt: 1793010101002, githubApp: true })
    expect(store.head?.version).toBe(213990)
    expect(keys(store, 'group')).toEqual([FIXTURE.leadGroup, FIXTURE.leadsGroup, FIXTURE.workGroup, FIXTURE.doneGroup])
    expect(keys(store, 'agent')).toEqual([FIXTURE.leadId, FIXTURE.builderId])
    expect(keys(store, 'start')).toEqual([FIXTURE.startId])
    expect(store.derived.machines).toEqual({ [FIXTURE.machineId]: { availableSlots: 2, teamWork: { allowed: true } } })
  })

  it('applies the recorded changes: a newer group, a dormant one leaves, a tombstoned start goes, an overlap duplicate is ignored', () => {
    const store = mergeChanges(first(), readFixture<ChangedParts>('changes-lead'))
    expect(keys(store, 'group')).toEqual([FIXTURE.leadGroup, FIXTURE.leadsGroup, FIXTURE.workGroup])
    expect(store.parts.get('group')!.get(FIXTURE.workGroup)).toMatchObject({ version: 214040, data: { assignment: { status: 'review' } } })
    expect(store.dormant.get(FIXTURE.doneGroup)).toEqual({ key: FIXTURE.doneGroup, version: 214042, changedAt: 1793010105000, dormant: true })
    expect(keys(store, 'start')).toEqual([])
    // Same version as held: the copy in the overlap window is the same part, kept as first read.
    expect(store.parts.get('agent')!.get(FIXTURE.leadId)!.data).toMatchObject({ displayName: 'River' })
    expect(store).toMatchObject({ cursor: 'eyJ2IjoyLCJ0IjoxNzkzMDEwMDc3Mzc1LCJlIjozfQ', lastChangedAt: 1793010106120, githubApp: true })
    expect(store.derived.machines).toEqual({ [FIXTURE.machineId]: { availableSlots: 3, teamWork: { allowed: true } } })
    expect(store.head?.version).toBe(213990)
  })

  // Review round 1: an update moved its part to the end, so ordinary activity reordered status.
  it('keeps every updated part where it was, and puts only new parts at the end', () => {
    const live = (key: string, version: number) => ({ key, version, changedAt: 9, data: { id: key } })
    const store = mergeChanges(first(), changes({
      groups: [live(FIXTURE.workGroup, 214100), live(FIXTURE.leadGroup, 214101), live('c0000000000000000000000a', 214102)],
      agents: [live(FIXTURE.leadId, 214103), live(FIXTURE.builderId, 214104)],
      members: [live(FIXTURE.ownerId, 214105)],
    }))
    expect(keys(store, 'group')).toEqual([FIXTURE.leadGroup, FIXTURE.leadsGroup, FIXTURE.workGroup, FIXTURE.doneGroup, 'c0000000000000000000000a'])
    expect(store.parts.get('group')!.get(FIXTURE.workGroup)!.version).toBe(214100)
    expect(keys(store, 'agent')).toEqual([FIXTURE.leadId, FIXTURE.builderId])
    expect(keys(store, 'member')).toEqual([FIXTURE.ownerId, FIXTURE.collaboratorId])
  })

  it('never lets an older version replace a newer one, nor a tombstone older than what it holds', () => {
    const held = first()
    const older = mergeChanges(held, changes({
      groups: [{ key: FIXTURE.workGroup, version: 214000, changedAt: 1, data: { id: FIXTURE.workGroup, title: 'stale' } }],
      starts: [{ key: FIXTURE.startId, version: 214014, changedAt: 1, deleted: true }],
    }))
    expect(older.parts.get('group')!.get(FIXTURE.workGroup)!.version).toBe(214033)
    expect(keys(older, 'start')).toEqual([FIXTURE.startId])
  })

  it('brings a dormant group back when it changes again, after the groups it had', () => {
    const asleep = mergeChanges(first(), changes({ groups: [{ key: FIXTURE.leadGroup, version: 214011, changedAt: 1, dormant: true }] }))
    expect(keys(asleep, 'group')).toEqual([FIXTURE.leadsGroup, FIXTURE.workGroup, FIXTURE.doneGroup])
    const back = mergeChanges(asleep, changes({ groups: [{ key: FIXTURE.leadGroup, version: 214012, changedAt: 2, data: { id: FIXTURE.leadGroup } }] }))
    expect(keys(back, 'group')).toEqual([FIXTURE.leadsGroup, FIXTURE.workGroup, FIXTURE.doneGroup, FIXTURE.leadGroup])
    expect(back.dormant.has(FIXTURE.leadGroup)).toBe(false)
  })

  it('adds parts it did not know, takes a newer head, and ignores a tombstone for a part it never had', () => {
    const store = mergeChanges(first(), changes({
      head: { key: 'head', version: 214100, changedAt: 3, data: { name: 'Renamed' } },
      agents: [{ key: 'a00000000000000000000009', version: 214101, changedAt: 3, data: { id: 'a00000000000000000000009' } }],
      machines: [{ key: 'd00000000000000000000009', version: 214102, changedAt: 3, deleted: true }],
    }))
    expect(store.head).toMatchObject({ version: 214100, data: { name: 'Renamed' } })
    expect(keys(store, 'agent')).toEqual([FIXTURE.leadId, FIXTURE.builderId, 'a00000000000000000000009'])
    expect(keys(store, 'machine')).toEqual([FIXTURE.machineId])
  })

  it('leaves the store it merged into unchanged', () => {
    const held = first()
    mergeChanges(held, readFixture<ChangedParts>('changes-lead'))
    expect(keys(held, 'group')).toHaveLength(4)
    expect(held.cursor).toBe('eyJ2IjoyLCJ0IjoxNzkzMDEwMDc0Mzc1LCJlIjozfQ')
  })
})
