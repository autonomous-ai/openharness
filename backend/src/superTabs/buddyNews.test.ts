import { describe, expect, it } from 'vitest'
import { applyCommand, type Command, type CommandContext } from './commands.js'
import { createSuperTab, forRecipients, type Actor, type Conversation, type MessageDraft } from './model.js'
import { buddyChatId } from './buddies.js'
import { assignedNotice, buddiesTold } from './buddyNews.js'
import { SHIP_KIND } from './ship.js'

const owner: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'owner', email: 'owner@example.com' }
const peer: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'peer', email: 'peer@example.com' }
const configuration = { engine: 'claude', model: null, effort: null, contextWindow: null, engineVersion: null }
const agentActor = (agentId: string): Actor => ({ kind: 'agent', agentId, machineOwnerId: 'host' })
const proposal = { goal: 'Sync edits made offline', scope: 'Desktop drafts only', priority: 'high' as const }

/** A public project with its PM, a worker, and peer's Buddy with its chat, as buddy.create and its start leave them. */
function setup() {
  let state = createSuperTab('swarm', 'Team', { id: 'owner', email: owner.email }, 'test')
  state.people.push({ id: 'peer', email: peer.email, role: 'collaborator', generation: 'first' })
  let next = 0
  const run = (command: Command, actor: Actor = owner, context: Partial<CommandContext> = {}) => {
    const effects = applyCommand(state, actor, command, { operationId: `op${next++}`, now: 1000,
      contribution: { machineOwnerId: 'host', contributorId: actor.kind === 'person' ? actor.userId : 'owner' }, ...context })
    state = effects.state
    return effects
  }
  const app = run({ type: 'project.create', name: 'App', visibility: 'public', brief: '' }).result as { projectId: string; conversationId: string }
  const add = (conversationId: string, harnessId: string, lead = false) => run({ type: 'agent.add', conversationId, harnessId, machineId: 'machine',
    name: harnessId, configuration, lead }).result.agentId as string
  const pm = add(app.conversationId, 'pm', true)
  state.agents.push({ id: 'buddy', projectId: app.projectId, machineId: 'machine', harnessId: 'buddy-harness', machineOwnerId: 'host',
    contributorId: 'peer', membershipGeneration: 'first', name: 'Buddy', configuration, buddyOf: { personId: 'peer', generation: 'first' } })
  const chat: Conversation = { id: buddyChatId(app.projectId, { id: 'peer', generation: 'first' }), kind: 'buddy', projectId: app.projectId, title: 'Buddy',
    leadId: null, agentIds: ['buddy'], archived: false, brief: '', checks: [], assignment: null, lastMessageSequence: 0,
    audience: { people: [{ id: 'peer', generation: 'first' }] } }
  state.conversations.push(chat)
  /** peer's Buddy sends their proposal; the store reads the ask it names. */
  const propose = () => run({ type: 'buddy.propose', conversationId: chat.id, ownerMessageId: 'ask', ...proposal }, agentActor('buddy'),
    { proposalAsk: { id: 'ask', conversationId: chat.id, source: false, createdAt: 900,
      author: { kind: 'person', id: 'peer', name: 'peer', membershipGeneration: 'first' } } }).messages[0]!
  /** The PM's post in the project chat, replying to [root] or to a reply in [root]'s thread, as the store loads that reply. */
  const pmPost = (text: string, extra: { replyTo?: MessageDraft; root?: MessageDraft; mentions?: string[] } = {}, actor: Actor = agentActor(pm)) => {
    const reply = extra.replyTo && { id: extra.replyTo.id, conversationId: extra.replyTo.conversationId, author: extra.replyTo.author, createdAt: 900,
      thread: (extra.root ?? extra.replyTo).id, threadSource: (extra.root ?? extra.replyTo).source ?? null }
    return run({ type: 'message.send', conversationId: app.conversationId, text, recipientIds: [], replyTo: extra.replyTo?.id ?? null,
      ...(extra.mentions ? { mentions: extra.mentions } : {}) }, actor, reply ? { reply } : {}).messages.at(-1)!
  }
  return { run, add, app, pm, chat: chat.id, propose, pmPost, get state() { return state } }
}

describe('which Buddy a project-chat message reaches (Diego, 10-29)', () => {
  it('is the Buddy whose person\'s proposal it replies to, in its thread too', () => {
    const f = setup(), sent = f.propose()
    const answer = f.pmPost('Taking it: #12 will build this.', { replyTo: sent })
    expect(answer.buddyRecipients).toEqual(['buddy'])
    expect(answer.recipients).not.toContain('buddy')
    expect(f.pmPost('Builder Orion has it.', { replyTo: answer, root: sent }).buddyRecipients).toEqual(['buddy'])
  })

  it('is the Buddy of a person the PM tags', () => {
    const f = setup()
    expect(f.pmPost('@peer does this cover your case?', { mentions: ['peer'] }).buddyRecipients).toEqual(['buddy'])
  })

  it('is the Buddy of the person who requested work that shipped', () => {
    const f = setup()
    const ship = (requesterId?: string): MessageDraft => ({ id: 'ship', conversationId: f.app.conversationId, author: { kind: 'agent', id: f.pm, name: 'pm',
      membershipGeneration: 'first' }, text: 'Shipped', replyTo: null, recipients: [],
      source: { kind: SHIP_KIND, conversationId: 'g', title: 'Offline', pullRequests: [], ...(requesterId ? { requesterId } : {}) } })
    expect(buddiesTold(f.state, ship('peer'), null)).toEqual(['buddy'])
    expect(buddiesTold(f.state, ship('owner'), null)).toEqual([])
    expect(buddiesTold(f.state, ship(), null)).toEqual([])
  })

  it('is nobody for anything else in the project chat: a plain post, a reply to a plain post, another person\'s tag', () => {
    const f = setup()
    const plain = f.pmPost('Batch AB is merging.')
    expect(plain.buddyRecipients).toBeUndefined()
    expect(f.pmPost('Done.', { replyTo: plain }).buddyRecipients).toBeUndefined()
    expect(f.pmPost('@owner please approve.', { mentions: ['owner'] }).buddyRecipients).toBeUndefined()
  })

  it('is nobody for a routing row, whatever it carries: a Buddy reads no routing (security review 2 of #2115)', () => {
    const f = setup()
    const row = (kind: string): MessageDraft => ({ id: kind, conversationId: f.app.conversationId, author: { kind: 'agent', id: f.pm, name: 'pm',
      membershipGeneration: 'first' }, text: 'Rule set.', replyTo: null, recipients: [], mentions: ['peer'], source: { kind } })
    for (const kind of ['route', 'route-override', 'rule']) expect(buddiesTold(f.state, row(kind), null)).toEqual([])
  })

  it('is nobody for a notice only its recipients read, by kind or marked so (review of #2177)', () => {
    const f = setup()
    const notice = (source: Record<string, unknown>): MessageDraft => ({ id: 'notice', conversationId: f.app.conversationId, author: { kind: 'agent', id: f.pm,
      name: 'pm', membershipGeneration: 'first' }, text: '@peer #12 stalled.', replyTo: null, recipients: [f.pm], mentions: ['peer'], source })
    expect(buddiesTold(f.state, notice({ kind: 'work-stalled' }), null)).toEqual([])
    expect(buddiesTold(f.state, notice(forRecipients({ kind: 'work-cancelled' })), null)).toEqual([])
  })

  it('is nobody for the person\'s own words: they know what they wrote', () => {
    const f = setup(), sent = f.propose()
    expect(f.pmPost('Thanks, go ahead.', { replyTo: sent }, peer).buddyRecipients).toBeUndefined()
  })

  it('is nobody once its person no longer reads the project, has left, or rejoined at a new membership', () => {
    const lost = setup(), sent = lost.propose()
    lost.state.projects!.find(p => p.id === lost.app.projectId)!.visibility = 'private'
    expect(lost.pmPost('Taking it.', { replyTo: sent }).buddyRecipients).toBeUndefined()
    const rejoined = setup(), asked = rejoined.propose()
    rejoined.state.people.find(p => p.id === 'peer')!.generation = 'second'
    expect(buddiesTold(rejoined.state, { ...asked, id: 'answer', replyTo: asked.id, thread: asked.id, author: { kind: 'agent', id: rejoined.pm, name: 'pm',
      membershipGeneration: 'first' } }, asked.source ?? null)).toEqual([])
  })

  it('is nobody outside the project chat: a tag in a workgroup stays there', () => {
    const f = setup()
    const group = f.run({ type: 'conversation.create', projectId: f.app.projectId, title: 'Offline', brief: 'Save edits.', checks: [] }).result.conversationId as string
    const tagged = f.run({ type: 'message.send', conversationId: group, text: '@peer which drafts?', recipientIds: [], replyTo: null, mentions: ['peer'] },
      agentActor(f.pm)).messages.at(-1)!
    expect(tagged.buddyRecipients).toBeUndefined()
  })
})

describe('the assignment notice a Buddy gets for work its person requested', () => {
  /** A group peer requested, briefed and ready, and a worker in it. */
  function requested(extra: Record<string, unknown> = {}) {
    const f = setup()
    const group = f.run({ type: 'conversation.create', projectId: f.app.projectId, title: 'Offline edits', brief: 'Save edits offline.',
      checks: [{ description: 'Tests pass', independent: false }], requesterId: 'peer', ...extra } as Command).result.conversationId as string
    const worker = f.add(group, 'worker')
    const assign = () => f.run({ type: 'work.assign', conversationId: group, agentId: worker }).messages
    const number = f.state.conversations.find(c => c.id === group)!.number
    return { f, group, assign, number }
  }
  const notices = (messages: MessageDraft[]) => messages.filter(m => m.recipients.includes('buddy'))

  it('is one line inside the task, for the Buddy alone: its number, title and status, nothing more', () => {
    const { group, assign, number } = requested()
    expect(notices(assign())).toEqual([expect.objectContaining({ conversationId: group, recipients: ['buddy'], source: { kind: 'agent-only' },
      text: `News for your owner: #${number} "Offline edits", which they requested, is assigned and working.` })])
  })

  it('is not sent for a private task in a public project, though its person requested it (security review 2 of #2178)', () => {
    const { f, group, assign } = requested()
    assign()
    const task = f.state.conversations.find(c => c.id === group)!
    task.audience = { people: [{ id: 'peer', generation: 'first' }] }
    expect(assignedNotice(f.state, task, { kind: 'agent', id: f.pm, name: 'pm', membershipGeneration: 'first' }, 'op')).toBeNull()
  })

  it('is not sent when its person cannot read the task, when nobody requested it, or when another person did', () => {
    const hidden = requested()
    hidden.f.state.projects!.find(p => p.id === hidden.f.app.projectId)!.visibility = 'private'
    expect(notices(hidden.assign())).toEqual([])
    const nobody = requested()
    delete nobody.f.state.conversations.find(c => c.id === nobody.group)!.requesterId
    expect(notices(nobody.assign())).toEqual([])
    expect(notices(requested({ requesterId: 'owner' }).assign())).toEqual([])
  })
})
