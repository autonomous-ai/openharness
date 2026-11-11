import { describe, expect, it } from 'vitest'
import { isCoordinator, isStep, openWorkOf, projectOpenWork, stepName } from './agentContext.js'

type Group = Record<string, unknown>
function swarm(groups: Group[]) {
  return {
    projects: [{ id: 'app', name: 'App', leadConversationId: 'lead-app' }, { id: 'web', name: 'Web', leadConversationId: 'lead-web' }],
    agents: [{ id: 'pm', name: 'PM' }, { id: 'dev1', name: 'Dev1' }, { id: 'rev1', name: 'Rev1' }, { id: 'pm-web', name: 'Web PM' }],
    conversations: [
      { id: 'lead-app', projectId: 'app', title: 'App', leadId: 'pm', agentIds: ['pm'], archived: false, checks: [], assignment: null },
      { id: 'lead-web', projectId: 'web', title: 'Web', leadId: 'pm-web', agentIds: ['pm-web'], archived: false, checks: [], assignment: null },
      ...groups,
    ],
  }
}
const task = (id: string, number: number, title: string, agentId: string | null, status: string | null, more: Group = {}): Group => ({
  id, projectId: 'app', number, title, leadId: 'pm', agentIds: ['pm'], archived: false, checks: [],
  assignment: agentId ? { id: `as-${id}`, agentId, status, result: null } : null, ...more,
})

describe('an agent\'s open work', () => {
  it('is the tasks assigned to it that are open and not archived: a reused agent\'s finished task is left out', () => {
    const state = swarm([task('g11', 11, 'Old work', 'dev1', 'done'), task('g12', 12, 'Fix login', 'dev1', 'working'),
      task('g13', 13, 'Archived', 'dev1', 'working', { archived: true }), task('g14', 14, 'Not its own', 'rev1', 'working')])
    expect(openWorkOf(state, 'dev1').map(line => line.number)).toEqual([12])
    expect(openWorkOf(swarm([]), 'dev1')).toEqual([])
  })

  it('shows a step by the task it belongs to, with that task\'s priority', () => {
    const state = swarm([task('g12', 12, 'Fix login', 'dev1', 'working', { priority: 'P0' }),
      task('g13', 13, 'Review: Fix login', 'rev1', 'working', { reviewOf: 'g12' })])
    expect(openWorkOf(state, 'rev1')).toEqual([expect.objectContaining({ id: 'g13', step: 'Review: Fix login', taskId: 'g12', taskNumber: 12, taskTitle: 'Fix login', priority: 'P0' })])
  })
})

describe('a coordinator\'s project work', () => {
  it('is every open task of its own project, assigned or not, and no step as a task of its own', () => {
    const state = swarm([task('g12', 12, 'Fix login', 'dev1', 'working'), task('g14', 14, 'Docs', null, null), task('g15', 15, 'Shipped', 'dev1', 'done'),
      task('g16', 16, 'Review', 'rev1', 'review', { reviewOf: 'g12' }), { ...task('g20', 20, 'Web work', 'pm-web', 'working'), projectId: 'web' }])
    expect(isCoordinator(state, 'pm')).toBe(true)
    expect(isCoordinator(state, 'dev1')).toBe(false)
    expect(projectOpenWork(state, 'pm').map(line => line.number)).toEqual([12, 14])
    expect(projectOpenWork(state, 'dev1')).toEqual([])
  })

  // E2E 2026-11-02: a new Swarm's default project is 'lead', whose Lead conversation has no projectId while its tasks say
  // 'lead' (backend groupProject reads a missing one as 'lead').
  it('counts the tasks of a Lead conversation with no projectId', () => {
    const state = {
      projects: [{ id: 'lead', name: 'Main', leadConversationId: 'lead' }],
      agents: [{ id: 'pm', name: 'PM' }, { id: 'dev1', name: 'Dev1' }],
      conversations: [
        { id: 'lead', title: 'Main', leadId: 'pm', agentIds: ['pm'], archived: false, checks: [], assignment: null },
        { ...task('g1', 1, 'Fix login', 'dev1', 'review'), projectId: 'lead' },
      ],
    }
    expect(projectOpenWork(state, 'pm').map(line => line.number)).toEqual([1])
  })
})

// Ken, 2026-11-02: every linked task is a step, named or not (backend steps.ts isStep).
describe('a step', () => {
  it('is a linked task, named by its step or else by its title', () => {
    expect(isStep({ id: 'g13', reviewOf: 'g12' })).toBe(true)
    expect(isStep({ id: 'g12' })).toBe(false)
    expect(stepName({ step: 'Review', title: 'Review: Fix login' })).toBe('Review')
    expect(stepName({ title: 'Test: PR #7' })).toBe('Test: PR #7')
  })
})
