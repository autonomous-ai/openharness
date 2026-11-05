import { describe, expect, it } from 'vitest'
import { createSuperTab, type SuperTabState } from '../model.js'
import type { SwarmProject } from '../projects.js'
import { ownersPlan } from './projectOwners.js'

// Task #3073: projects from before ownerGeneration get their owner's membership, and those whose owner already left pass on.
const project = (id: string, ownerId: string, extra: Partial<SwarmProject> = {}): SwarmProject =>
  ({ id, name: id.toUpperCase(), ownerId, leadConversationId: `project-${id}`, visibility: 'private', members: [], updateMinutes: 5, ...extra })

function legacy(): SuperTabState {
  const state = createSuperTab('swarm', 'Team', { id: 'owner', email: 'owner@example.com' }, 'test')
  state.people.push({ id: 'c', email: 'c@example.com', role: 'collaborator', generation: 'c-first' })
  state.projects = [
    { ...project('lead', 'owner'), visibility: 'public' },
    project('stayed', 'c'),
    project('handed', 'gone', { members: [{ id: 'c', generation: 'c-first' }] }),
    project('orphan', 'gone'),
    { ...project('open', 'gone'), visibility: 'public' },
  ]
  return state
}

describe('the migration of project owners', () => {
  it('fills the membership of owners still in the Swarm and changes nothing else of theirs', () => {
    const plan = ownersPlan(legacy())
    expect(plan.projects.find(p => p.id === 'lead')).toEqual({ ...project('lead', 'owner'), visibility: 'public', ownerGeneration: 'swarm' })
    expect(plan.projects.find(p => p.id === 'stayed')).toEqual({ ...project('stayed', 'c'), ownerGeneration: 'c-first' })
    expect(plan.filled).toEqual([{ projectId: 'lead', ownerId: 'owner' }, { projectId: 'stayed', ownerId: 'c' }])
  })

  it('passes on each project whose owner already left: to a member, the Swarm owner for a public one, else nobody', () => {
    const plan = ownersPlan(legacy())
    expect(plan.handovers).toEqual([
      { projectId: 'handed', from: 'gone', to: 'c' },
      { projectId: 'orphan', from: 'gone', to: '' },
      { projectId: 'open', from: 'gone', to: 'owner' },
    ])
    expect(plan.projects.find(p => p.id === 'handed')).toMatchObject({ ownerId: 'c', ownerGeneration: 'c-first', members: [] })
    expect(plan.projects.find(p => p.id === 'orphan')!.ownerId).toBe('')
  })

  it('finds nothing to do on a second run', () => {
    const state = legacy()
    state.projects = ownersPlan(state).projects
    expect(ownersPlan(state)).toMatchObject({ filled: [], handovers: [], changed: false })
  })

  it('leaves a Swarm from before projects alone: its one project is the Swarm owner\'s, who never leaves', () => {
    const state = createSuperTab('swarm', 'Team', { id: 'owner', email: 'owner@example.com' }, 'test')
    delete state.projects
    expect(ownersPlan(state)).toMatchObject({ filled: [], handovers: [], changed: false })
  })

  it('never changes the state it plans from', () => {
    const state = legacy(), before = structuredClone(state)
    ownersPlan(state)
    expect(state).toEqual(before)
  })
})
