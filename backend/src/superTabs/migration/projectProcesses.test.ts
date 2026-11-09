import { describe, expect, it } from 'vitest'
import type { SwarmProject } from '../projects.js'
import { processSeedPlan } from './projectProcesses.js'

const TAB = 'c51479bd73b59e58176ad9e4'
const project = (name: string, extra: Partial<SwarmProject> = {}): SwarmProject => ({ id: `id-${name}`, name, ownerId: 'owner',
  leadConversationId: `chat-${name}`, visibility: 'public', members: [], updateMinutes: 5, ...extra })
const projects = () => ['harness', 'lamp', 'scout', 'harness-gtm', 'other'].map(name => project(name))

describe('the one-time process seed for the requesting Swarm', () => {
  it('seeds the four named projects and leaves every other project as it was', () => {
    const before = projects(), plan = processSeedPlan(TAB, before)
    expect(plan.held).toEqual([])
    expect(plan.changed).toEqual([
      { projectId: 'id-harness', process: 'full' }, { projectId: 'id-lamp', process: 'full' },
      { projectId: 'id-scout', process: 'simple' }, { projectId: 'id-harness-gtm', process: 'simple' },
    ])
    expect(plan.projects.map(p => [p.name, p.process])).toEqual([
      ['harness', 'full'], ['lamp', 'full'], ['scout', 'simple'], ['harness-gtm', 'simple'], ['other', undefined],
    ])
    expect(before).toEqual(projects())
  })

  it('never seeds a similarly named project in another Swarm', () => {
    const before = projects()
    expect(processSeedPlan('another-swarm', before)).toMatchObject({ projects: before, changed: [], held: [] })
  })

  it('preserves an owner’s saved choice and becomes a no-op on a second run', () => {
    const before = projects()
    before[2]!.process = 'full'
    const first = processSeedPlan(TAB, before)
    expect(first.projects.find(p => p.name === 'scout')!.process).toBe('full')
    expect(first.changed.map(c => c.projectId)).not.toContain('id-scout')
    expect(processSeedPlan(TAB, first.projects)).toMatchObject({ changed: [], held: [], projects: first.projects })
  })

  it.each(['missing', 'ambiguous'])('refuses the entire seed when a target is %s', problem => {
    const before = projects()
    if (problem === 'missing') before.splice(1, 1)
    else before.push(project('lamp', { id: 'another-lamp' }))
    const plan = processSeedPlan(TAB, before)
    expect(plan.changed).toEqual([])
    expect(plan.projects).toEqual(before)
    expect(plan.held).toEqual([{ name: 'lamp', reason: problem }])
  })

  it('preserves open release history and settings when filling a preset', () => {
    const before = projects()
    Object.assign(before[2]!, { releases: { pending: [{ groupId: 'task', url: 'https://github.com/acme/app/pull/1', mergedAt: 1 }],
      steps: { cli: { groupId: 'release', at: 1 } } } })
    before[2]!.simpleThrough = 10
    const plan = processSeedPlan(TAB, before)
    expect(plan.projects[2]).toEqual({ ...before[2], process: 'simple' })
  })
})
