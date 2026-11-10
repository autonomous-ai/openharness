import { describe, expect, it } from 'vitest'
import { applyCommand, postable, type Command, type CommandContext } from './commands.js'
import { PERSONAL_SWARM_OPERATION } from './deletion.js'
import { createSuperTab, stableId, SuperTabError, visibleState, type Actor, type SuperTabState } from './model.js'
import { projectsOf } from './projects.js'

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

  // An agent passes its person's decision on there, and a person it names there hears of it.
  it('take an agent\'s tag of a person, which reaches that person', () => {
    const f = swarm()
    expect(f.run(post('lead', '@mate please confirm the release.'), f.asPm).messages.find(m => !m.source)!.mentions).toEqual(['mate'])
    expect(f.run(post(f.task, 'Confirming.', { mentions: ['owner'] }), f.asPm).messages.find(m => !m.source)!.mentions).toEqual(['owner'])
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

// Exempt for now: a Personal Swarm. Its Desktop still starts a project's PM on the person's first message in the project's chat:
// the message waits for the PM (leadWaiting) and the first lead.claim starts it on the person's machine (leadWaiting.test.ts).
// The exemption goes when the Personal Swarm v4 (every pane an agent under Your Team) lands; then these two cases become one refusal.
describe('a project\'s chat in a Personal Swarm, until the Personal Swarm v4', () => {
  function project(personal: boolean) {
    let state: SuperTabState = createSuperTab(personal ? stableId('super-tab', 'prod', 'owner', PERSONAL_SWARM_OPERATION) : 'team',
      personal ? 'Personal' : 'Team', { id: 'owner', email: owner.email }, 'prod')
    let sequence = 0
    const run = (command: Command) => {
      const effects = applyCommand(state, owner, command, { now: 1_000, operationId: `op-${++sequence}` })
      state = effects.state
      return effects
    }
    const created = run({ type: 'project.create', name: 'Games', visibility: 'private', brief: '' }).result as { projectId: string; conversationId: string }
    // The store numbers a chat's messages as it commits them (parts/commit.ts); applyCommand alone leaves the count.
    const numbered = () => { state.conversations.find(c => c.id === created.conversationId)!.lastMessageSequence = 1 }
    return { run, numbered, ...created, get project() { return projectsOf(state).find(p => p.id === created.projectId)! } }
  }

  it('keeps the person\'s first message for the PM, and the first claim starts it', () => {
    const f = project(true)
    const sent = f.run(post(f.conversationId, 'make the landing page dark')).result.messageId as string
    expect(f.project.leadWaiting).toEqual([{ id: sent, at: 1_000 }])
    expect(f.run({ type: 'lead.claim', projectId: f.projectId, machineId: 'mac' }).result.leadStart).toBe('start')
  })

  it('is the only exemption past the opening request: the next message in any other Swarm\'s project chat is refused', () => {
    const f = project(false)
    f.run(post(f.conversationId, 'make the landing page dark'))
    f.numbered()
    expect(refusal(() => f.run(post(f.conversationId, 'and the buttons round')))).toMatchObject({ code: 'AGENTS_ONLY', status: 403, message: SENTENCE })
    expect(f.project.leadWaiting).toBeUndefined()
  })
})

// Exempt for now: New project's opening request. When the Swarm starts the PM, Desktop posts its person's request, with its files,
// in the new project's channel right before lead.start (launch.dart startInSwarm), and the PM reads it there when it joins. Kept
// only from the project's creator, only while the channel holds no message and no PM was asked for or holds it. It goes when
// New project hands its request to the PM's own 1:1 chat, which needs lead.start to create that chat and return its id.
describe('New project\'s opening request, until lead.start makes the PM\'s own chat', () => {
  function fresh() {
    const f = swarm()
    const created = f.run({ type: 'project.create', name: 'Games', visibility: 'public', brief: '' }).result as { projectId: string; conversationId: string }
    // The store numbers a chat's messages as it commits them (parts/commit.ts); applyCommand alone leaves the count.
    const numbered = () => { f.state.conversations.find(c => c.id === created.conversationId)!.lastMessageSequence = 1 }
    return { run: f.run, numbered, ...created, get state() { return f.state }, project: () => projectsOf(f.state).find(p => p.id === created.projectId)! }
  }

  it('is kept from the project\'s creator, with its files, and the PM that joins the channel reads it', () => {
    const f = fresh()
    expect(refusal(() => postable(f.state, owner, f.conversationId))).toBeNull()
    const sent = f.run(post(f.conversationId, 'Build the landing page.')).messages.find(m => m.text === 'Build the landing page.')!
    expect(sent).toMatchObject({ conversationId: f.conversationId, author: { kind: 'person', id: 'owner' } })
    const pm = f.run({ type: 'agent.add', conversationId: f.conversationId, machineId: 'owner-mac', harnessId: 'h-games-pm', name: 'Pia', lead: true,
      configuration: config } as Command, owner, own('owner')).result.agentId as string
    const asPm: Actor = { kind: 'agent', agentId: pm, machineOwnerId: 'owner' }
    expect(visibleState(f.state, asPm, 2_000).conversations.map(c => c.id)).toContain(f.conversationId)
  })

  it('is refused once the channel holds a message: one request, not a conversation', () => {
    const f = fresh()
    f.run(post(f.conversationId, 'Build the landing page.'))
    f.numbered()
    expect(refusal(() => f.run(post(f.conversationId, 'And dark mode.')))).toMatchObject({ code: 'AGENTS_ONLY' })
  })

  it('is refused once a PM was asked for or holds the channel', () => {
    const asked = fresh()
    asked.project().lead = { status: 'starting', machineId: 'owner-mac', machineName: 'Owner Mac', startId: 'start-1' }
    expect(refusal(() => asked.run(post(asked.conversationId, 'Build the landing page.')))).toMatchObject({ code: 'AGENTS_ONLY' })
    const held = fresh()
    held.run({ type: 'agent.add', conversationId: held.conversationId, machineId: 'owner-mac', harnessId: 'h-games-pm', name: 'Pia', lead: true,
      configuration: config } as Command, owner, own('owner'))
    expect(refusal(() => held.run(post(held.conversationId, 'Build the landing page.')))).toMatchObject({ code: 'AGENTS_ONLY' })
  })

  it('is refused from anyone but the project\'s creator, and in a task\'s chat', () => {
    const f = fresh()
    expect(refusal(() => f.run(post(f.conversationId, 'Build the landing page.'), mate))).toMatchObject({ code: 'AGENTS_ONLY' })
    const task = f.run({ type: 'conversation.create', projectId: f.projectId, title: 'Landing', brief: 'Build it.', checks: [] } as Command).result.conversationId as string
    expect(refusal(() => f.run(post(task, 'Build the landing page.')))).toMatchObject({ code: 'AGENTS_ONLY' })
  })
})
