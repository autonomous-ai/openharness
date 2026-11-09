import { describe, expect, it } from 'vitest'
import { applyCommand, type Command, type CommandContext } from './commands.js'
import { createSuperTab, SuperTabError, type Actor, type SuperTabState } from './model.js'

const owner: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'owner', email: 'owner@example.com' }
const mate: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'mate', email: 'mate@example.com' }
const config = { engine: 'claude', model: null, effort: null, contextWindow: null, engineVersion: null }
const own = (userId: string) => ({ contribution: { machineOwnerId: userId, contributorId: userId } })

function swarm() {
  let state: SuperTabState = createSuperTab('tab', 'Pilot', { id: 'owner', email: owner.email }, 'prod')
  let sequence = 0
  const run = (command: Command, actor: Actor = owner, context: Partial<CommandContext> = {}) => {
    const effects = applyCommand(state, actor, command, { now: 1_000 + sequence, operationId: `op-${++sequence}`, ...context })
    state = effects.state
    return effects
  }
  const invited = run({ type: 'invite.create', email: mate.email, role: 'collaborator', conversationId: 'lead' })
  run({ type: 'invite.accept', inviteId: invited.result.inviteId as string }, mate)
  /** A v4 agent: + New agent, its 1:1 chat, the session joined into it; in no project and with no task. */
  const newAgent = (person: Extract<Actor, { kind: 'person' }>, name: string) => {
    const chat = run({ type: 'agent.new', kind: 'regular', name, machineId: `${person.userId}-mac`, engine: 'claude', local: true } as Command,
      person, own(person.userId)).result.conversationId as string
    const agentId = run({ type: 'agent.add', conversationId: chat, machineId: `${person.userId}-mac`, harnessId: `h-${name}`, name, lead: false,
      configuration: config } as Command, person, own(person.userId)).result.agentId as string
    return { kind: 'agent', agentId, machineOwnerId: person.userId } as Extract<Actor, { kind: 'agent' }>
  }
  return { run, newAgent, get state() { return state } }
}
const post = (conversationId: string, text: string, recipientIds: string[] = []) =>
  ({ type: 'message.send', conversationId, text, replyTo: null, recipientIds }) as Command

// Swarm v4 (anh Dee, 2026-11-08): agents talk to agents in a project's channel. A v4 agent belongs to no project and holds
// no server task (tasks are GitHub issues), so the channel's old rule (an agent of the project, or one with work there)
// left every new agent out of every channel (found in the swarm-sandbox run, 2026-11-09).
describe('a v4 agent in a project\'s channel', () => {
  it('posts there and reaches another person\'s agent by name, when its person reads the project', () => {
    const f = swarm()
    const pip = f.newAgent(owner, 'Pip'), juno = f.newAgent(mate, 'Juno')
    const sent = f.run(post('lead', 'free: pip'), pip)
    expect(sent.messages.map(m => m.text)).toContain('free: pip')
    const asked = f.run(post('lead', 'Can you review #4?', [juno.agentId]), pip)
    expect(asked.messages.at(-1)!.recipients).toEqual([juno.agentId])
  })

  it('stays out of a private project its person does not read', () => {
    const f = swarm()
    const secret = f.run({ type: 'project.create', name: 'Secret', visibility: 'private', brief: '' }).result as { conversationId: string }
    const pip = f.newAgent(mate, 'Pip')
    expect(() => f.run(post(secret.conversationId, 'hello'), pip)).toThrow(SuperTabError)
  })
})
