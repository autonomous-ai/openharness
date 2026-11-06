import { describe, expect, it } from 'vitest'
import { applyCommand, commandSchema, type CommandContext } from './commands.js'
import { createSuperTab, visibleState, type Actor } from './model.js'
import { projectsOf } from './projects.js'
import { readerView } from './read/views.js'
import { reassemble, split } from './parts/index.js'
import { stepsOf } from './steps.js'
import { touchesFor } from './parts/touches.js'

const owner: Actor = { kind: 'person', userId: 'owner', email: 'owner@example.com' }
const peer: Actor = { kind: 'person', userId: 'peer', email: 'peer@example.com' }
const other: Actor = { kind: 'person', userId: 'other', email: 'other@example.com' }
const configuration = { engine: 'claude', model: 'opus', effort: 'high', contextWindow: null, engineVersion: null }
const fullColumns = [
  { id: 'proposals', title: 'Proposal' }, { id: 'nextUp', title: 'Next up' }, { id: 'working', title: 'Working' },
  { id: 'done', title: 'Done' }, { id: 'merged', title: 'Merged' }, { id: 'shipped', title: 'Shipped' },
]
const simpleColumns = [{ id: 'todo', title: 'To do' }, { id: 'doing', title: 'Doing' }, { id: 'done', title: 'Done' }]

function fixture() {
  let state = createSuperTab('swarm', 'Team', { id: 'owner', email: 'owner@example.com' }, 'test'), sequence = 0
  state.people.push({ id: 'peer', email: 'peer@example.com', role: 'collaborator', generation: 'first' },
    { id: 'other', email: 'other@example.com', role: 'collaborator', generation: 'first' })
  const run = (input: unknown, actor = owner, context: Partial<CommandContext> = {}) => {
    const command = commandSchema.parse(input)
    const effects = applyCommand(state, actor, command, { now: 1000, operationId: `op-${++sequence}`,
      contribution: { machineOwnerId: 'host', contributorId: 'owner' }, ...context })
    state = effects.state
    return effects
  }
  const create = (process?: string, actor = peer, visibility = 'public') => run({ type: 'project.create', name: 'Work', visibility,
    ...(process ? { process } : {}) }, actor).result.projectId as string
  const set = (projectId: string, process: string, actor = peer) => run({ type: 'project.process', projectId, process }, actor)
  const project = (id: string) => projectsOf(state).find(p => p.id === id)!
  const view = (actor = owner) => readerView(split(state, { tabId: state.id, version: sequence, now: 1000 }), actor, 1000, { teamMachines: [] })
  const as = (agentId: string): Actor => ({ kind: 'agent', agentId, machineOwnerId: 'host' })
  const add = (projectId: string) => run({ type: 'agent.add', conversationId: project(projectId).leadConversationId,
    machineId: 'machine', harnessId: 'pm', name: 'PM', configuration, lead: true }, peer).result.agentId as string
  const group = (id: string) => state.conversations.find(c => c.id === id)!
  const task = (projectId: string) => {
    const id = run({ type: 'conversation.create', projectId, title: 'Work', brief: 'Finish the work', checks: [] }, peer).result.conversationId as string
    const worker = run({ type: 'agent.add', conversationId: id, machineId: 'machine', harnessId: `worker-${sequence}`, name: `Worker${sequence}`,
      configuration, lead: false }, peer).result.agentId as string
    run({ type: 'work.assign', conversationId: id, agentId: worker }, peer)
    const status = (status: string, files?: string[]) => run({ type: 'work.status', conversationId: id,
      assignmentId: group(id).assignment!.id, status, result: status === 'review' ? 'https://github.com/acme/app/pull/1' : 'Finished' }, as(worker),
    files ? { pullRequestFiles: { urls: ['https://github.com/acme/app/pull/1'], head: 'a'.repeat(40), files } } : {})
    return { id, worker, status }
  }
  const reload = () => { state = reassemble(split(state, { tabId: state.id, version: sequence, now: 1000 })) }
  return { run, create, set, project, view, as, add, task, group, reload, get state() { return state } }
}

describe('project process settings and board columns', () => {
  it('defaults old projects and old creation commands to Full and six board columns', () => {
    const f = fixture(), created = f.create()
    expect(f.project(created)).toMatchObject({ process: 'full' })
    expect(f.view().parts.head.data.projects).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'lead', process: 'full', columns: fullColumns }),
      expect.objectContaining({ id: created, process: 'full', columns: fullColumns }),
    ]))
  })

  it('creates Simple explicitly and returns its three columns on parts and legacy reads', () => {
    const f = fixture(), id = f.create('simple')
    expect(f.project(id)).toMatchObject({ process: 'simple' })
    expect(f.view().parts.head.data.projects).toContainEqual(expect.objectContaining({ id, process: 'simple', columns: simpleColumns }))
    expect(visibleState(f.state, peer).projects).toContainEqual(expect.objectContaining({ id, process: 'simple', columns: simpleColumns }))
  })

  it('lets the current project owner change only the named project', () => {
    const f = fixture(), id = f.create(), untouched = f.create()
    f.set(id, 'simple')
    expect(f.project(id)).toMatchObject({ process: 'simple' })
    expect(f.project(untouched)).toMatchObject({ process: 'full' })
    f.set(id, 'full')
    expect(f.view(peer).parts.head.data.projects).toContainEqual(expect.objectContaining({ id, process: 'full', columns: fullColumns }))
  })

  it('lets the Swarm owner change a public project owned by someone else', () => {
    const f = fixture(), id = f.create()
    f.set(id, 'simple', owner)
    expect(f.project(id)).toMatchObject({ process: 'simple' })
  })

  it('lets the Swarm owner change a private preset without granting access to its data', () => {
    const f = fixture(), id = f.create(undefined, peer, 'private')
    f.set(id, 'simple', owner)
    expect(f.project(id)).toMatchObject({ process: 'simple' })
    expect(f.view(owner).parts.head.data.projects?.some(p => p.id === id)).toBe(false)
    expect(visibleState(f.state, owner).projects?.some(p => p.id === id)).toBe(false)
  })

  it('refuses another member even when the project is public', () => {
    const f = fixture(), id = f.create()
    expect(() => f.set(id, 'simple', other)).toThrow(expect.objectContaining({ code: 'PROJECT_OWNER_REQUIRED' }))
    expect(f.project(id)).toMatchObject({ process: 'full' })
  })

  it('refuses the PM agent even when it runs for the Swarm owner', () => {
    const f = fixture(), id = f.create(), pm = f.add(id)
    expect(() => f.set(id, 'simple', f.as(pm))).toThrow(expect.objectContaining({ code: 'PROJECT_OWNER_REQUIRED' }))
    expect(f.project(id)).toMatchObject({ process: 'full' })
  })

  it('does not restore an old project owner’s authority when they rejoin', () => {
    const f = fixture(), id = f.create()
    f.state.people.find(p => p.id === 'peer')!.generation = 'rejoined'
    expect(() => f.set(id, 'simple')).toThrow(expect.objectContaining({ code: 'PROJECT_OWNER_REQUIRED' }))
  })

  it('keeps private process metadata out of other members’ board reads', () => {
    const f = fixture(), id = f.create('simple', peer, 'private')
    const view = f.view(other)
    expect(view.parts.head.data.projects?.some(p => p.id === id)).toBe(false)
    expect(JSON.stringify(view.derived)).not.toContain(id)
    expect(() => f.set(id, 'full', other)).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }))
  })

  it('changes a legacy project through the same settings command', () => {
    const f = fixture()
    f.set('lead', 'simple', owner)
    expect(f.project('lead')).toMatchObject({ process: 'simple' })
    expect(f.view().parts.head.data.projects).toContainEqual(expect.objectContaining({ id: 'lead', columns: simpleColumns }))
  })

  it('rejects custom columns and unknown presets instead of silently choosing one', () => {
    expect(commandSchema.safeParse({ type: 'project.create', name: 'Work', visibility: 'public', process: 'custom' }).success).toBe(false)
    expect(commandSchema.safeParse({ type: 'project.process', projectId: 'lead', process: 'simple', columns: [] }).success).toBe(false)
    expect(commandSchema.safeParse({ type: 'project.process', projectId: 'lead', process: 'custom' }).success).toBe(false)
  })
})

describe('Simple task lifecycle', () => {
  it.each([['docs/a.md'], ['backend/src/routes/auth.ts'], ['desktop/lib/a.dart']])('opens no automatic steps for %s', file => {
    const f = fixture(), project = f.create('simple'), task = f.task(project)
    task.status('review', [file])
    expect(stepsOf(f.state, task.id)).toEqual([])
  })

  it('finishes a Simple task directly and exposes Done without any merge or pull request', () => {
    const f = fixture(), project = f.create('simple'), task = f.task(project)
    expect(f.group(task.id).assignment?.status).toBe('working')
    task.status('done')
    const read = f.view(peer).parts.groups.find(p => p.key === task.id)!.data
    expect(read).toMatchObject({ process: 'simple', assignment: { status: 'done' } })
    expect(read.mergedPullRequestUrls ?? []).toEqual([])
    expect(read.pullRequestUrls ?? []).toEqual([])
    expect(stepsOf(f.state, task.id)).toEqual([])
  })

  it('keeps Full review and test automation unchanged', () => {
    const f = fixture(), project = f.create('full'), task = f.task(project)
    task.status('review', ['backend/src/routes/auth.ts', 'desktop/lib/a.dart'])
    expect(stepsOf(f.state, task.id).map(s => s.step)).toEqual(['Security review 1', 'Security review 2', 'Test'])
  })

  it.each(['Review', 'Test', 'Merge', 'Release'])('refuses a new explicit %s step for Simple work', step => {
    const f = fixture(), project = f.create('simple'), task = f.task(project)
    expect(() => f.run({ type: 'conversation.create', projectId: project, title: step, reviewOf: task.id, step, checks: [] }, peer))
      .toThrow(expect.objectContaining({ code: 'SIMPLE_PROCESS' }))
    expect(stepsOf(f.state, task.id)).toEqual([])
  })

  it('keeps earlier Simple tasks Simple when switching to Full, including dormant records', () => {
    const f = fixture(), project = f.create('simple'), old = f.task(project)
    const dormant = structuredClone(f.group(old.id))
    f.state.conversations = f.state.conversations.filter(g => g.id !== old.id)
    f.set(project, 'full')
    f.state.conversations.push(dormant)
    f.reload()
    old.status('review', ['desktop/lib/a.dart'])
    expect(stepsOf(f.state, old.id)).toEqual([])
    const fresh = f.task(project)
    fresh.status('review', ['desktop/lib/a.dart'])
    expect(stepsOf(f.state, fresh.id).map(s => s.step)).toEqual(['Review', 'Test'])
  })

  it('does not change open steps or their evidence when switching Full to Simple', () => {
    const f = fixture(), project = f.create('full'), task = f.task(project)
    task.status('review', ['desktop/lib/a.dart'])
    const before = structuredClone(stepsOf(f.state, task.id))
    f.set(project, 'simple')
    expect(stepsOf(f.state, task.id)).toEqual(before)
  })

  it('guards a Ready decision against a concurrent process change', () => {
    const f = fixture(), project = f.create('simple'), task = f.task(project)
    const before = structuredClone(f.state)
    const command = commandSchema.parse({ type: 'work.status', conversationId: task.id, assignmentId: f.group(task.id).assignment!.id,
      status: 'review', result: 'Ready' })
    const effects = f.run(command, f.as(task.worker))
    expect(touchesFor(command, f.as(task.worker), before, effects)).toContainEqual({ kind: 'head', key: 'head' })
  })
})
