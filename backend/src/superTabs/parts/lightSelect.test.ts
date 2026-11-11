import { describe, expect, it } from 'vitest'
import type { Agent, AgentStart } from '../model.js'
import { lightSelect, projectLightGroup, type LightCandidates } from './lightSelect.js'
import type { GroupData, HeadData, Part } from './types.js'

const group = (key: string, data: Partial<GroupData>, dormant = false): Part<GroupData> => ({ kind: 'group', key, version: 1, changedAt: 1, ordinal: 1,
  ...dormant ? { dormant: true as const } : {}, data: { id: key, agentIds: [], archived: false, title: `T ${key}`, brief: 'long brief', checks: [{ x: 1 }], ...data } as unknown as GroupData })
const running = (agentId: string) => ({ id: `w-${agentId}`, agentId, status: 'working', execution: { machineId: 'm1', harnessId: 'h1', machineOwnerId: 'o' }, result: null })
const agent = (key: string, data: Partial<Agent> = {}): Part<Agent> => ({ kind: 'agent', key, version: 1, changedAt: 1, ordinal: 1, data: { id: key, projectId: 'p1', ...data } as Agent })

describe('projectLightGroup (spec 2026-11-02 poll cost, Part 1.2)', () => {
  it('keeps running work\'s title, owned paths and execution, and drops the brief and checks', () => {
    const light = projectLightGroup(group('g1', { assignment: running('a1') as never, task: { goal: 'g', changes: 'c', constraints: 'k', owns: ['src/x'] } as never }))
    expect(light.data!.title).toBe('T g1')
    expect(light.data!.task!.owns).toEqual(['src/x'])
    expect(light.data!.assignment!.execution.machineId).toBe('m1')
    expect(light.data!.brief).toBe('')
    expect(light.data!.checks).toEqual([])
  })

  it('drops finished work\'s title and execution, keeps who and how it ended, and the dormant flag', () => {
    const light = projectLightGroup(group('g2', { assignment: { ...running('a1'), status: 'done', lost: true } as never }, true))
    expect(light.data!.title).toBe('')
    expect(light.data!.assignment).toMatchObject({ id: 'w-a1', agentId: 'a1', status: 'done', lost: true, execution: { machineId: '' } })
    expect(light.dormant).toBe(true)
  })

  it('makes the empty parent documents Mongo\'s computed projection makes, running or not', () => {
    // LIGHT_GROUP computes `data.task.owns` with $cond/$$REMOVE: Mongo creates `task: {}` even when it removes the value.
    expect(projectLightGroup(group('lead', {})).data!.task).toEqual({})
    expect(projectLightGroup(group('run', { assignment: running('a1') as never })).data!.task).toEqual({})
  })

  it('a conversation with no work has none', () => {
    expect(projectLightGroup(group('g3', {})).data!.assignment).toBeNull()
  })
})

describe('lightSelect', () => {
  const head = { kind: 'head', key: 'head', version: 1, changedAt: 1, ordinal: 0,
    data: { projects: [{ id: 'p1', leadConversationId: 'lead1' }], invitations: [{ conversationId: 'invited' }] } } as unknown as Part<HeadData>
  const start = { kind: 'start', key: 's1', version: 1, changedAt: 1, ordinal: 1, data: { id: 's1', request: { conversationId: 'started', machineId: 'm1' } } } as unknown as Part<AgentStart>
  const candidates = (groups: Part<GroupData>[], agents: Part<Agent>[] = []): LightCandidates =>
    ({ tabId: 't', head, members: [], agents, starts: [start], groups: groups.map(projectLightGroup), sequenceBase: 0, visibilityEpoch: 0, groupCounter: 0 })

  it('working: the Lead conversation, running work, start- and invitation-named ones, and nothing else idle', () => {
    const picked = lightSelect(candidates([group('lead1', {}, true), group('run', { assignment: running('a9') as never }), group('started', {}),
      group('invited', {}), group('idle', { agentIds: ['a9'] })], [agent('a9', { workDecision: 'stop' } as never)]), { groups: 'working' })
    expect(picked.groups.map(g => g.key).sort()).toEqual(['invited', 'lead1', 'run', 'started'])
  })

  it('working: an undecided worker\'s awake conversations, and a legacy agent\'s', () => {
    const picked = lightSelect(candidates([group('mine', { agentIds: ['u1'] }), group('old', { agentIds: ['l1'] }), group('asleep', { agentIds: ['u1'] }, true)],
      [agent('u1'), agent('l1', { projectId: undefined, workDecision: 'stop' } as never)]), { groups: 'working' })
    expect(picked.groups.map(g => g.key).sort()).toEqual(['mine', 'old'])
  })

  it('named agents take their dormant conversations too; named projects only their awake ones', () => {
    const picked = lightSelect(candidates([group('a-dormant', { agentIds: ['x'] }, true), group('p-awake', { projectId: 'p2' }), group('p-dormant', { projectId: 'p2' }, true),
      group('no-project', {})]), { groups: 'working', agentIds: ['x'], projectIds: ['p2', 'lead'] })
    expect(picked.groups.map(g => g.key).sort()).toEqual(['a-dormant', 'no-project', 'p-awake'])
  })

  it('active: every awake conversation', () => {
    const picked = lightSelect(candidates([group('a', {}), group('b', {}, true)]), { groups: 'active' })
    expect(picked.groups.map(g => g.key)).toEqual(['a'])
  })
})
