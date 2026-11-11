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
    // Down no longer, no limit, and the decision the server stored.
    const builder = list(state.agents)[1]
    expect(builder).not.toHaveProperty('downSince')
    expect(builder).not.toHaveProperty('workDecision')
    expect(builder).not.toHaveProperty('limitedUntil')
    expect(state.otherProjectsWork).toEqual([])
    expect(list(state.projects)[0].progress).toEqual({ since: 1793009900000, dirtyRevision: 214041, summarizedRevision: 213800, requestedRevision: 213800 })
  })

  it('counts a group a Lead summarized in its project progress, and carries the request it last made', () => {
    const first = readFixture<FirstLoad>('parts-lead')
    first.progress[0].data = { since: 5, summarizedFloor: 213800, summarized: { [FIXTURE.workGroup]: 214020 },
      requestedFloor: 213700, requested: { [FIXTURE.workGroup]: 214030, [FIXTURE.doneGroup]: 213990 }, requestedAt: 6, requestMessageId: 'r1' }
    // An older server's request message id is no longer read.
    expect(list(reassemble(storeOf(first)).projects)[0].progress)
      .toEqual({ since: 5, dirtyRevision: 214033, summarizedRevision: 214020, requestedRevision: 214030, requestedAt: 6 })
  })

  it('shows a usage limit while it lasts', async () => {
    const first = readFixture<FirstLoad>('parts-lead')
    first.derived.agents[FIXTURE.builderId].limitedUntil = '2026-10-26T12:00:00.000Z'
    expect(list(reassemble(storeOf(first)).agents)[1].limitedUntil).toBe('2026-10-26T12:00:00.000Z')
  })

  // The custom role sets go with backend S18: an older backend's derived role is shown on no agent, whatever its project's skills.
  it('shows no role on any agent, whatever its project\'s skills', () => {
    const first = readFixture<FirstLoad>('parts-lead')
    const project = list((first.head!.data as Json).projects)[0]
    project.skillSet = 'custom'
    Object.assign(first.derived.agents![FIXTURE.leadId]!, { roleId: 'lead-role' })
    for (const agent of list(reassemble(storeOf(first)).agents)) expect(agent).not.toHaveProperty('roleId')
  })

  // Backend S11 (#3827): the count of a person's waiting tags is gone (a message still names whom it tags), and nothing
  // here read it; an older backend's is left out.
  it('gives no count of waiting tags, and a Swarm from before projects no progress', () => {
    const first = readFixture<FirstLoad>('parts-builder')
    Object.assign(first.derived, { mentionsWaiting: 2 })
    delete (first.head!.data as Json).projects
    first.progress = [] as PartEnvelope[]
    const state = reassemble(storeOf(first))
    expect(state).not.toHaveProperty('mentionsWaiting')
    expect(state).not.toHaveProperty('projects')
  })

  // Task #3384: the status read shows each project's pulse (asks the PM owes, who works), on the project, and none from an
  // older server.
  it('lays each project\'s pulse on that project, and none when the read sends none', () => {
    const first = readFixture<FirstLoad>('parts-lead')
    const projects = (state: Json) => list(state.projects)
    expect(projects(reassemble(storeOf(first)))[0]).not.toHaveProperty('pulse')
    const pulse = { pmId: 'pm', asks: { count: 1, oldestAt: 1, personId: 'p', list: [] } }
    first.derived.pulse = { '5000000000000000000000aa': pulse }
    expect(projects(reassemble(storeOf(first)))[0]!.pulse).toEqual(pulse)
  })
})
