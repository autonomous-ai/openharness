import { describe, expect, it } from 'vitest'
import { applyCommand, MAX_DELETED_PROJECTS, type Command, type CommandContext } from './commands.js'
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
    f.state.deletedProjects = Array.from({ length: MAX_DELETED_PROJECTS }, (_, i) => ({ id: `old-${i}`, at: i }))
    const repo = f.create('personal-repo-abc')
    f.run({ type: 'project.delete', projectId: repo }, 'delete-1')
    expect(f.state.deletedProjects).toHaveLength(MAX_DELETED_PROJECTS)
    expect(f.state.deletedProjects!.at(-1)!.id).toBe(repo)
    expect(f.code(() => f.create('old-0'))).toBe('applied')
  })
})
