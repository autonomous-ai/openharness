import { describe, expect, it } from 'vitest'
import { applyCommand, commandSchema, type CommandContext } from './commands.js'
import { createSuperTab, visibleState, type Actor } from './model.js'
import { projectsOf } from './projects.js'
import { readerView } from './read/views.js'
import { split } from './parts/index.js'

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
  return { run, create, set, project, view, as, add, get state() { return state } }
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
