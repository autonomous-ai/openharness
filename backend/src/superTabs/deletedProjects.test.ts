import { describe, expect, it } from 'vitest'
import { applyCommand, DELETED_PROJECT_KEEP_MS, MAX_DELETED_PROJECTS, type Command, type CommandContext } from './commands.js'
import { createSuperTab, visibleState, type Actor, type SuperTabState } from './model.js'

// PS-D (2026-11-11): Desktop asks for a repo's project by one request on every computer of its person's. A project its person
// deleted came back once the server forgot that request (its receipt goes after 30 days). The Swarm remembers it now.
const owner: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'owner', email: 'owner@example.com' }

function fixture() {
  let state = createSuperTab('tab', 'Personal', { id: 'owner', email: owner.email }, 'prod')
  let now = 1000
  const run = (command: Command, operationId: string, context: Partial<CommandContext> = {}) => {
    const effects = applyCommand(state, owner, command, { now: now++, operationId, ...context })
    state = effects.state
    return effects
  }
  const create = (op: string) => run({ type: 'project.create', name: op, visibility: 'private', brief: '' }, op).result.projectId as string
  const code = (act: () => unknown) => { try { act(); return 'applied' } catch (error) { return (error as { code?: string }).code } }
  return { run, create, code, get state(): SuperTabState { return state } }
}

describe('a project\'s request asked again', () => {
  it('answers the project it made, once and to whoever reads it, after its receipt is gone', () => {
    const f = fixture()
    const repo = f.create('personal-repo-abc')
    const again = f.run({ type: 'project.create', name: 'openharness', visibility: 'private', brief: '' }, 'personal-repo-abc').result
    expect(again).toMatchObject({ projectId: repo, conversationId: `project-${repo}` })
    expect(f.state.projects!.filter(p => p.id === repo)).toHaveLength(1)
    expect(f.state.conversations.filter(c => c.id === `project-${repo}`)).toHaveLength(1)
  })
})

describe('a deleted project', () => {
  it('is not made again by the request that made it', () => {
    const f = fixture()
    const repo = f.create('personal-repo-abc')
    f.run({ type: 'project.delete', projectId: repo }, 'delete-1')
    expect(f.code(() => f.create('personal-repo-abc'))).toBe('NOT_FOUND')
    expect(f.state.projects!.some(p => p.id === repo)).toBe(false)
    // Any other request still makes one.
    expect(f.code(() => f.create('personal-repo-def'))).toBe('applied')
    expect(f.state.deletedProjects).toEqual([{ id: repo, at: 1001 }])
    expect(visibleState(f.state, owner)).not.toHaveProperty('deletedProjects')
  })

  it(`is remembered among the newest ${MAX_DELETED_PROJECTS}`, () => {
    const f = fixture()
    const first = f.create('first')
    f.run({ type: 'project.delete', projectId: first }, 'delete-first')
    f.state.deletedProjects = [...f.state.deletedProjects!, ...Array.from({ length: MAX_DELETED_PROJECTS - 1 }, (_, i) => ({ id: `old-${i}`, at: 1000 }))]
    const repo = f.create('personal-repo-abc')
    f.run({ type: 'project.delete', projectId: repo }, 'delete-1')
    expect(f.state.deletedProjects).toHaveLength(MAX_DELETED_PROJECTS)
    expect(f.state.deletedProjects!.at(-1)!.id).toBe(repo)
    expect(f.code(() => f.create('first'))).toBe('applied')
  })

  it('is remembered for a year', () => {
    const f = fixture()
    f.state.deletedProjects = [{ id: 'year-old', at: 1000 - DELETED_PROJECT_KEEP_MS }, { id: 'recent', at: 0 }]
    const repo = f.create('personal-repo-abc')
    f.run({ type: 'project.delete', projectId: repo }, 'delete-1')
    expect(f.state.deletedProjects!.map(d => d.id)).toEqual(['recent', repo])
  })
})
