import { describe, expect, it } from 'vitest'
import { createSuperTab } from '../model.js'
import { capReleased, visibilityChanged } from './commit.js'

describe('writing a Swarm\'s parts', () => {
  it('keeps the newest 200 released harnesses of each machine and drops the oldest', () => {
    const state = createSuperTab('tab', 'Pilot', { id: 'owner', email: 'owner@example.com' }, 'prod')
    state.releasedHarnesses = [...Array.from({ length: 205 }, (_, i) => ({ machineId: 'busy', harnessId: `h${i}` })), { machineId: 'quiet', harnessId: 'only' }]
    capReleased(state)
    const busy = state.releasedHarnesses.filter(r => r.machineId === 'busy').map(r => r.harnessId)
    expect(busy).toHaveLength(200)
    expect(busy[0]).toBe('h5')
    expect(busy.at(-1)).toBe('h204')
    expect(state.releasedHarnesses.filter(r => r.machineId === 'quiet')).toEqual([{ machineId: 'quiet', harnessId: 'only' }])
  })

  it('moves the visibility epoch when who sees what changes, and not for an ordinary write', () => {
    const before = createSuperTab('tab', 'Pilot', { id: 'owner', email: 'owner@example.com' }, 'prod')
    const renamed = structuredClone(before)
    renamed.name = 'Renamed'
    expect(visibilityChanged(before, renamed)).toBe(false)
    const privateProject = structuredClone(before)
    privateProject.projects![0]!.visibility = 'private'
    expect(visibilityChanged(before, privateProject)).toBe(true)
    const withAudience = structuredClone(before)
    withAudience.conversations.push({ id: 'c', projectId: 'lead', title: 'C', leadId: null, agentIds: [], archived: false, brief: '', checks: [],
      assignment: null, lastMessageSequence: 0, audience: { people: [{ id: 'owner', generation: 'tab' }] } })
    const narrowed = structuredClone(withAudience)
    narrowed.conversations.at(-1)!.audience = { people: [] }
    expect(visibilityChanged(withAudience, narrowed)).toBe(true)
  })
})
