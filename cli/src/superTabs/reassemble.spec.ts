import { describe, expect, it } from 'vitest'
import { FIXTURE, readFixture } from './fixtures/read/index.js'
import { mergeChanges, storeOf } from './partsStore.js'
import { reassemble } from './reassemble.js'
import type { ChangedParts, FirstLoad, PartEnvelope } from './readContract.js'

type Json = Record<string, unknown>
const legacy = (name: 'legacy-tab-lead' | 'legacy-tab-builder') => readFixture<{ state: Json }>(name).state
const list = (v: unknown) => v as Json[]

describe('the old Swarm state, rebuilt from parts', () => {
  it('equals what the full read gave a Lead, field by field', () => {
    expect(reassemble(storeOf(readFixture<FirstLoad>('parts-lead')))).toEqual(legacy('legacy-tab-lead'))
  })

  it('equals what the full read gave a Builder, field by field', () => {
    expect(reassemble(storeOf(readFixture<FirstLoad>('parts-builder')))).toEqual(legacy('legacy-tab-builder'))
  })

  it('follows the recorded changes: the dormant group leaves, the start goes, slots and the stored agent values come back', () => {
    const state = reassemble(mergeChanges(storeOf(readFixture<FirstLoad>('parts-lead')), readFixture<ChangedParts>('changes-lead')))
    expect(list(state.conversations).map(c => c.id)).toEqual([FIXTURE.leadGroup, FIXTURE.leadsGroup, FIXTURE.workGroup])
    expect(list(state.conversations)[2]).toMatchObject({ lastMessageSequence: 214041, assignment: { status: 'review' } })
    expect(state.starts).toEqual([])
    expect(list(state.machines)[0]).toMatchObject({ availableSlots: 3, observation: { receivedAt: 1793010105000 } })
    // Down no longer, the expired limit still shown as none, and the decision the server stored.
    const builder = list(state.agents)[1]
    expect(builder).not.toHaveProperty('downSince')
    expect(builder).not.toHaveProperty('workDecision')
    expect(builder.limitedUntil).toBeNull()
    expect(state.otherProjectsWork).toEqual([])
    expect(list(state.projects)[0].progress).toEqual({ since: 1793009900000, dirtyRevision: 214041, summarizedRevision: 213800, requestedRevision: 213800 })
  })

  it('counts a group a Lead summarized in its project progress, and carries the request it last made', () => {
    const first = readFixture<FirstLoad>('parts-lead')
    first.progress[0].data = { since: 5, summarizedFloor: 213800, summarized: { [FIXTURE.workGroup]: 214020 },
      requestedFloor: 213700, requested: { [FIXTURE.workGroup]: 214030, [FIXTURE.doneGroup]: 213990 }, requestedAt: 6, requestMessageId: 'r1' }
    expect(list(reassemble(storeOf(first)).projects)[0].progress)
      .toEqual({ since: 5, dirtyRevision: 214033, summarizedRevision: 214020, requestedRevision: 214030, requestedAt: 6, requestMessageId: 'r1' })
  })

  it('shows the role on Custom skills, none when its kind has no role there, and no role elsewhere', () => {
    const first = readFixture<FirstLoad>('parts-lead')
    const project = list((first.head!.data as Json).projects)[0]
    project.skillMode = 'custom'
    project.skillSet = 'custom'
    first.derived.agents![FIXTURE.leadId].roleId = 'lead-role'
    expect(list(reassemble(storeOf(first)).agents).map(a => a.roleId)).toEqual(['lead-role', null])
    const plain = readFixture<FirstLoad>('parts-lead')
    ;(plain.agents[0].data as Json).roleId = 'left-from-custom'
    expect(list(reassemble(storeOf(plain)).agents)[0]).not.toHaveProperty('roleId')
  })

  it('gives a person their waiting mentions, and a Swarm from before projects no progress', () => {
    const first = readFixture<FirstLoad>('parts-builder')
    first.derived.mentionsWaiting = 2
    delete (first.head!.data as Json).projects
    first.progress = [] as PartEnvelope[]
    const state = reassemble(storeOf(first))
    expect(state.mentionsWaiting).toBe(2)
    expect(state).not.toHaveProperty('projects')
  })
})
