import { describe, expect, it } from 'vitest'
import { applyCommand, postable, type Command, type CommandContext } from './commands.js'
import { createSuperTab, SuperTabError, type Actor, type SuperTabState } from './model.js'

const owner: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'owner', email: 'owner@example.com' }
const mate: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'mate', email: 'mate@example.com' }
const config = { engine: 'claude', model: null, effort: null, contextWindow: null, engineVersion: null }
const own = (userId: string) => ({ contribution: { machineOwnerId: userId, contributorId: userId } })
const SENTENCE = 'Only agents post in a project\'s channel. Talk to your agents.'

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
  const pm = run({ type: 'agent.add', conversationId: 'lead', machineId: 'owner-mac', harnessId: 'h-pm', name: 'Faye', lead: true, configuration: config } as Command,
    owner, own('owner')).result.agentId as string
  const asPm: Actor = { kind: 'agent', agentId: pm, machineOwnerId: 'owner' }
  const task = run({ type: 'conversation.create', title: 'Login bug', brief: 'Fix it.', checks: [] }).result.conversationId as string
  /** + New agent: its 1:1 chat with its person, and the session joined into it. */
  const newAgent = (person: Extract<Actor, { kind: 'person' }>, name: string) => {
    const chat = run({ type: 'agent.new', kind: 'regular', name, machineId: `${person.userId}-mac`, engine: 'claude', local: true } as Command,
      person, own(person.userId)).result.conversationId as string
    const agentId = run({ type: 'agent.add', conversationId: chat, machineId: `${person.userId}-mac`, harnessId: `h-${name}`, name, lead: false,
      configuration: config } as Command, person, own(person.userId)).result.agentId as string
    return { chat, agent: { kind: 'agent', agentId, machineOwnerId: person.userId } as Extract<Actor, { kind: 'agent' }> }
  }
  return { run, asPm, task, newAgent, get state() { return state } }
}
const post = (conversationId: string, text: string, extra: Record<string, unknown> = {}) =>
  ({ type: 'message.send', conversationId, text, replyTo: null, recipientIds: [], ...extra }) as Command
const refusal = (body: () => unknown): SuperTabError | null => {
  try { body(); return null } catch (error) { if (error instanceof SuperTabError) return error; throw error }
}

// Swarm v4 (anh Dee, 2026-11-08): a project's channel and its tasks' chats are agents only. People read them and talk to their own
// agents, each in a chat of its own. The apps only hid the composer, so an older app, the phone and the web still posted there
// (ken15 in # lamp, 2026-11-09): the server says no, whatever the client (draft #3605 had the channel alone).
describe('a project\'s channel and its tasks\' chats', () => {
  it('refuse a person\'s post, whoever the person is, in one plain sentence with a code of its own', () => {
    const f = swarm()
    for (const person of [owner, mate]) {
      for (const where of ['lead', f.task]) {
        const refused = refusal(() => f.run(post(where, 'Can you look at this?'), person))
        expect(refused, `${person.userId} in ${where}`).toMatchObject({ code: 'AGENTS_ONLY', status: 403, message: SENTENCE })
      }
    }
  })

  it('refuse a person\'s reply under an agent\'s line, as they refuse the line', () => {
    const f = swarm()
    const said = f.run(post('lead', 'Plan for today.'), f.asPm).messages.find(m => m.text === 'Plan for today.')!
    const reply = { reply: { id: said.id, conversationId: 'lead', author: { kind: 'agent', id: (f.asPm as { agentId: string }).agentId },
      createdAt: 1_000, thread: null, threadSource: null } } as Partial<CommandContext>
    expect(refusal(() => f.run(post('lead', 'Me too', { replyTo: said.id }), owner, reply))).toMatchObject({ code: 'AGENTS_ONLY' })
  })

  it('take their agents\' posts, the PM\'s and any other\'s', () => {
    const f = swarm()
    const ada = f.newAgent(owner, 'Ada').agent
    expect(f.run(post('lead', 'Shipped #12.'), f.asPm).messages.map(m => m.text)).toContain('Shipped #12.')
    expect(f.run(post(f.task, 'Started #12.'), f.asPm).messages.map(m => m.text)).toContain('Started #12.')
    expect(f.run(post('lead', 'free: ada'), ada).messages.map(m => m.text)).toContain('free: ada')
  })

  it('leave a person\'s own chat with their agent to them', () => {
    const f = swarm()
    const ada = f.newAgent(owner, 'Ada')
    expect(f.run(post(ada.chat, 'Fix the docs')).messages.map(m => m.text)).toContain('Fix the docs')
  })

  // An upload and a voice message are posts: they ask postable, as the post does.
  it('refuse a person\'s upload to them, and take it to the person\'s own chat with their agent', () => {
    const f = swarm()
    const ada = f.newAgent(owner, 'Ada')
    expect(refusal(() => postable(f.state, owner, 'lead'))).toMatchObject({ code: 'AGENTS_ONLY' })
    expect(refusal(() => postable(f.state, owner, f.task))).toMatchObject({ code: 'AGENTS_ONLY' })
    expect(refusal(() => postable(f.state, owner, ada.chat))).toBeNull()
    expect(refusal(() => postable(f.state, f.asPm, 'lead'))).toBeNull()
  })
})
