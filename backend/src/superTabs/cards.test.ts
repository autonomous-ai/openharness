import { describe, expect, it } from 'vitest'
import { applyCommand, type Command, type CommandContext } from './commands.js'
import { bindPullRequestCards } from './cards.js'
import { agentOnly, appendPullRequestUrls, createSuperTab, visibleState, type Actor, type AgentConfiguration, type Conversation, type MessageDraft } from './model.js'
import { storedTask } from './storedWork.test-support.js'

const owner: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'owner', email: 'dee@example.com' }
const config: AgentConfiguration = { engine: 'claude', model: 'opus', effort: 'high', contextWindow: null, engineVersion: null }
const PR = 'https://github.com/example/app/pull/7'
const OTHER = 'https://github.com/example/app/pull/8'

function fixture() {
  let state = createSuperTab('tab', 'Office', { id: 'owner', email: owner.email }, 'prod')
  let sequence = 0
  const run = (command: Command, actor: Actor = owner, context: Partial<CommandContext> = {}) => {
    const effects = applyCommand(state, actor, command, { now: 1000, operationId: `op-${++sequence}`, ...context })
    state = effects.state
    // As the store does after every command: a shown message's links are the group's linked pull requests.
    for (const group of state.conversations) {
      appendPullRequestUrls(group, effects.messages.filter(m => m.conversationId === group.id && !agentOnly(m.source, m.recipients)).map(m => m.text))
    }
    return effects
  }
  const add = (name: string, group: string, lead = false) => run({ type: 'agent.add', conversationId: group, machineId: 'host', harnessId: name,
    name, configuration: config, lead }, owner, { contribution: { machineOwnerId: 'host-owner', contributorId: 'owner' } }).result.agentId as string
  const lead = add('River', 'lead', true)
  const as = (agentId: string): Actor => ({ kind: 'agent', agentId, machineOwnerId: 'host-owner' })
  const create = () => storedTask(state, { title: 'Avatars', brief: 'Add avatars.', checks: [{ description: 'Tests pass' }], requesterId: 'owner' })
  const post = (conversationId: string, text: string, actor: Actor = owner, extra: Record<string, unknown> = {}, context: Partial<CommandContext> = {}) =>
    run({ type: 'message.send', conversationId, text, replyTo: null, recipientIds: [], ...extra } as Command, actor, context).messages.at(-1)!
  const group = (id: string) => state.conversations.find(c => c.id === id)!
  return { run, add, as, create, post, group, lead, get state() { return state } }
}

describe('live cards', () => {
  it('makes the first message linking a pull request its card, and later links of it plain messages', () => {
    const f = fixture()
    const id = f.create()
    const builder = f.add('Kai', id)
    const first = f.post(id, `Opened ${PR}`, f.as(builder))
    f.post(id, `CI is running on ${PR}`, f.as(builder))
    const both = f.post(id, `Split into ${PR} and ${OTHER}`, f.as(builder))
    expect(f.group(id).cards?.pullRequests).toEqual([{ url: PR, messageId: first.id }, { url: OTHER, messageId: both.id }])
  })

  it('never makes a thread reply or an agent-only notice a card', () => {
    const f = fixture()
    const id = f.create()
    const builder = f.add('Kai', id)
    const root = f.post(id, 'Starting.', f.as(builder))
    f.post(id, `Opened ${PR}`, f.as(builder), { replyTo: root.id },
      { reply: { id: root.id, conversationId: id, author: root.author, createdAt: 1000, thread: root.id } })
    f.post(id, `Notice ${OTHER}`, f.as(builder), { agentOnly: true, recipientIds: [builder] })
    expect(f.group(id).cards?.pullRequests).toBeUndefined()
  })

  it('never makes a Lead-only notice a card, such as a resumed task notice, and reads its recipients', () => {
    // Batch #2220: #2177 made agentOnly read the notice's recipients; a resumed task's notice to the Lead reaches card binding.
    const group = { id: 'g' } as Conversation
    const notice = { id: 'n', conversationId: 'g', text: `Resumed ${PR}`, recipients: ['lead'],
      source: { kind: 'work-resumed', agentId: 'kai', assignmentId: 'a1' } } as unknown as MessageDraft
    expect(() => bindPullRequestCards(group, notice)).not.toThrow()
    expect(group.cards?.pullRequests).toBeUndefined()
  })

  it('shows a card only to readers of its own conversation', () => {
    const f = fixture()
    const id = f.create()
    const peer: Actor = { kind: 'person', userId: 'peer', email: 'ivy@example.com' }
    f.state.people.push({ id: 'peer', email: peer.email, role: 'collaborator', generation: 'first' })
    f.post(id, `Opened ${PR}`)
    expect(f.group(id).cards?.pullRequests).toHaveLength(1)
    f.group(id).audience = { people: [{ id: 'owner', generation: f.state.people[0]!.generation }] }
    const seen = visibleState(f.state, peer, 1000)
    expect(seen.conversations.some(c => c.id === id)).toBe(false)
    expect(JSON.stringify(seen.conversations.map(c => c.cards ?? null))).not.toContain(PR)
  })
})
