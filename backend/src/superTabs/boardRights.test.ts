import { describe, expect, it } from 'vitest'
import { applyCommand, type Command, type CommandContext } from './commands.js'
import { createSuperTab, type Actor, type SuperTabState } from './model.js'
import { projectOf } from './projects.js'

// Task #3819 (Phase 2 of docs/plans/2026-11-06-buddy-board-final-spec.md, Ken and anh Dee 11-06): a project's owner switched
// it to the Board way of working. Swarm v4 retired the switch (2026-11-10): a project switched before is held to nothing more.
const projectOwner: Actor = { kind: 'person', userId: 'p', email: 'p@example.com' }
const member: Actor = { kind: 'person', userId: 'd', email: 'd@example.com' }
const configuration = { engine: 'claude', model: null, effort: null, contextWindow: null, engineVersion: null }

export function boardFixture() {
  let state = createSuperTab('swarm', 'Team', { id: 'owner', email: 'owner@example.com' }, 'test')
  state.people.push({ id: 'p', email: 'p@example.com', role: 'collaborator', generation: 'p1' },
    { id: 'c', email: 'c@example.com', role: 'collaborator', generation: 'c1' },
    { id: 'd', email: 'd@example.com', role: 'collaborator', generation: 'd1' })
  let next = 0
  const posted: Array<{ conversationId: string; text: string; recipients: readonly string[] }> = []
  const run = (command: Command, actor: Actor = projectOwner, context: Partial<CommandContext> = {}) => {
    const effect = applyCommand(state, actor, command, { operationId: `op${next++}`, now: 1000,
      contribution: { machineOwnerId: 'p', contributorId: actor.kind === 'person' ? actor.userId : 'p' }, ...context })
    state = effect.state
    posted.push(...effect.messages)
    return effect.result as Record<string, unknown>
  }
  const app = run({ type: 'project.create', name: 'App', visibility: 'public', brief: '' }) as { projectId: string; conversationId: string }
  const add = (harnessId: string, lead: boolean) => run({ type: 'agent.add', conversationId: app.conversationId, harnessId, machineId: 'machine',
    name: harnessId, lead, configuration }).agentId as string
  const pm = add('pm', true), worker = add('worker', false)
  const project = () => projectOf(state, app.projectId)
  const asAgent = (agentId: string): Actor => ({ kind: 'agent', agentId, machineOwnerId: 'p' })
  return { run, app, pm, worker, project, asAgent, posted, get state(): SuperTabState { return state } }
}

/** [f]'s project with Board settings stored as an owner set them before Swarm v4 retired the commands (2026-11-10). */
const board = (f: ReturnType<typeof boardFixture>, settings: { boardMode?: true; canChat?: string[]; decider?: string }) =>
  Object.assign(projectOf(f.state, f.app.projectId), settings)

// Nobody can change a project's Board settings since Swarm v4 retired the commands (2026-11-10), so the ones stored before no
// longer hold anyone back: its chat is every reader's, and priorities are set as in any project.
describe('a project switched to the Board before Swarm v4', () => {
  const say = (conversationId: string, text = 'Hello') => ({ type: 'message.send', conversationId, text, replyTo: null, recipientIds: [] }) as Command
  const card = (f: ReturnType<typeof boardFixture>, actor: Actor, priority: 'P0' | 'P2') =>
    f.run({ type: 'conversation.create', projectId: f.app.projectId, title: 'Card', priority, requesterId: 'd',
      task: { goal: 'Do it', changes: 'It', constraints: 'None', owns: ['x'] }, checks: [{ description: 'Done', independent: false }] }, actor)

  it('lets every reader write in its chat, and set any priority, whoever its settings named', () => {
    const f = boardFixture()
    board(f, { boardMode: true, canChat: ['c'], decider: 'c' })
    expect(f.run(say(f.app.conversationId), member).messageId).toEqual(expect.any(String))
    expect(card(f, member, 'P0').conversationId).toEqual(expect.any(String))
  })
})


// A pause stored before Swarm v4 (work.pause answers as retired, 2026-11-10) still holds its task.
describe('a paused task', () => {
  const paused = (f: ReturnType<typeof boardFixture>) => {
    const id = f.run({ type: 'conversation.create', projectId: f.app.projectId, title: 'Card', priority: 'P2', requesterId: 'd',
      task: { goal: 'Do it', changes: 'It', constraints: 'None', owns: ['x'] }, checks: [{ description: 'Done', independent: false }] }).conversationId as string
    const group = f.state.conversations.find(c => c.id === id)!
    group.paused = { by: 'person:c', at: 1000, reason: 'Wait for the release' }
    return group
  }


  // Readycheck's review: a start into the task went past the pause.
  it('refuses starting an agent on it, whoever asks', () => {
    const f = boardFixture()
    const group = paused(f)
    expect(() => f.run({ type: 'agent.start', request: { conversationId: group.id, machineId: 'machine', engine: 'claude', name: 'Helper', cwd: '/repo', worktree: true,
      requirements: { memoryBytes: 0, diskBytes: 0, maxCpuPercent: 100, tools: [], devices: [], quotaRequired: false } }, routeDecisionId: 'route' }))
      .toThrow(expect.objectContaining({ code: 'TASK_PAUSED' }))
  })
})
