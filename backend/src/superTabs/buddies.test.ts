import { describe, expect, it } from 'vitest'
import { applyCommand, type Command, type CommandContext } from './commands.js'
import { createSuperTab, visibleState, type Actor, type Conversation } from './model.js'
import { canReadGroup, canWatchAgent, isConfidential } from './projects.js'
import { sweepLiveness } from './liveness.js'
import { hostTab } from './read/hostRows.js'
import { groupView } from './read/views.js'
import { reassemble, split } from './parts/index.js'

const owner: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'owner', email: 'owner@example.com' }
const peer: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'peer', email: 'peer@example.com' }
const configuration = { engine: 'claude', model: null, effort: null, contextWindow: null, engineVersion: null }

/** A Swarm of two public projects, each with its Lead, and peer's Buddy in the first, stored as buddy.create and its start
 *  leave them (buddies.ts): a Buddy agent and its owner-only chat. */
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
  const web = run({ type: 'project.create', name: 'Web', visibility: 'public', brief: '' }).result as { projectId: string; conversationId: string }
  const lead = (conversationId: string, harnessId: string) => run({ type: 'agent.add', conversationId, harnessId, machineId: 'machine',
    name: harnessId, configuration, lead: true }).result.agentId as string
  const pm = lead(app.conversationId, 'app-pm')
  lead(web.conversationId, 'web-pm')
  const group = run({ type: 'conversation.create', projectId: app.projectId, title: 'Offline', brief: 'Save edits.', checks: [] }).result.conversationId as string
  const pmChat = run({ type: 'conversation.create', projectId: app.projectId, title: 'peer', brief: '', checks: [],
    audience: { personIds: ['peer'] } }, peer).result.conversationId as string
  state.agents.push({ id: 'buddy', projectId: app.projectId, machineId: 'machine', harnessId: 'buddy-harness', machineOwnerId: 'host',
    contributorId: 'peer', membershipGeneration: 'first', name: 'Buddy', configuration, buddyOf: { personId: 'peer', generation: 'first' } })
  const chat: Conversation = { id: 'peer-buddy', kind: 'buddy', projectId: app.projectId, title: 'Buddy', leadId: null, agentIds: ['buddy'],
    archived: false, brief: '', checks: [], assignment: null, lastMessageSequence: 0, audience: { people: [{ id: 'peer', generation: 'first' }] } }
  state.conversations.push(chat)
  return { run, app, web, pm, group, pmChat, chat: chat.id, get state() { return state } }
}
const agentActor = (agentId: string): Actor => ({ kind: 'agent', agentId, machineOwnerId: 'host' })
const group = (f: ReturnType<typeof setup>, id: string) => f.state.conversations.find(c => c.id === id)!

describe('who reads a Buddy chat', () => {
  it('is its owner and its Buddy: never the PM, the project or Swarm owner, or another person', () => {
    const f = setup(), chat = group(f, f.chat)
    expect(canReadGroup(f.state, peer, chat)).toBe(true)
    expect(canReadGroup(f.state, agentActor('buddy'), chat)).toBe(true)
    expect(canReadGroup(f.state, agentActor(f.pm), chat)).toBe(false)
    expect(canReadGroup(f.state, owner, chat)).toBe(false)
  })

  it('stops being its owner\'s once they rejoin at a new membership', () => {
    const f = setup()
    f.state.people.find(p => p.id === 'peer')!.generation = 'second'
    expect(canReadGroup(f.state, peer, group(f, f.chat))).toBe(false)
  })

  it('is left out of everyone else\'s Swarm read, the PM\'s included', () => {
    const f = setup()
    expect(visibleState(f.state, peer).conversations.map(c => c.id)).toContain(f.chat)
    for (const reader of [owner, agentActor(f.pm)]) expect(visibleState(f.state, reader).conversations.map(c => c.id)).not.toContain(f.chat)
  })
})

describe('what a Buddy reads', () => {
  it('is its project\'s chat and its own chat: no workgroup, no Chat with PM, no other project, no Leads conversation', () => {
    const f = setup(), buddy = agentActor('buddy')
    expect(canReadGroup(f.state, buddy, group(f, f.app.conversationId))).toBe(true)
    expect(canReadGroup(f.state, buddy, group(f, f.group))).toBe(false)
    expect(canReadGroup(f.state, buddy, group(f, f.pmChat))).toBe(false)
    expect(canReadGroup(f.state, buddy, group(f, f.web.conversationId))).toBe(false)
    expect(visibleState(f.state, buddy).conversations.map(c => c.id).sort()).toEqual([f.app.conversationId, f.chat].sort())
  })

  it('shows no machines, starts or rules in its Swarm read: only names in the roster', () => {
    const f = setup()
    machine(f, 'peer-mac', 'peer')
    f.run({ type: 'rule.set', projectId: f.app.projectId, rule: { kind: 'preferIdle' }, text: 'Idle first.' })
    const seen = visibleState(f.state, agentActor('buddy'))
    expect(seen.machines ?? []).toEqual([])
    expect(seen.rules ?? []).toEqual([])
    expect(seen.agents.map(a => a.id)).toContain(f.pm)
    expect(visibleState(f.state, agentActor(f.pm)).machines).toHaveLength(1)
  })

  it('is no other person\'s Buddy chat in the same project', () => {
    const f = setup()
    f.state.conversations.push({ ...group(f, f.chat), id: 'owner-buddy', agentIds: ['other-buddy'], audience: { people: [{ id: 'owner', generation: f.state.people[0]!.generation }] } })
    expect(canReadGroup(f.state, agentActor('buddy'), group(f, 'owner-buddy'))).toBe(false)
  })

  it('is a confidential session: only the person whose machine runs it watches its terminal', () => {
    const f = setup(), buddy = f.state.agents.find(a => a.id === 'buddy')!
    f.state.people.push({ id: 'host', email: 'host@example.com', role: 'collaborator', generation: 'first' })
    expect(isConfidential(f.state, buddy)).toBe(true)
    expect(canWatchAgent(f.state, peer, buddy)).toBe(false)
    expect(canWatchAgent(f.state, { kind: 'person', userId: 'host', email: 'host@example.com' }, buddy)).toBe(true)
  })
})

describe('the Swarm\'s Buddies setting', () => {
  it('is off in a new Swarm, and only its owner turns it on', () => {
    const f = setup()
    expect(f.state.buddies).toBeUndefined()
    expect(() => f.run({ type: 'tab.buddies', enabled: true }, peer)).toThrow('Only the Swarm owner')
    expect(() => f.run({ type: 'tab.buddies', enabled: true }, agentActor(f.pm))).toThrow('Only the Swarm owner')
    f.run({ type: 'tab.buddies', enabled: true })
    expect(f.state.buddies).toBe(true)
    expect(visibleState(f.state, peer).buddies).toBe(true)
  })

  it('may be turned on by a Lead passing on the owner\'s own chat message from the last day', () => {
    const f = setup(), askedIn = { conversationId: f.app.conversationId, messageId: 'owner-message' }
    const asked = (author: { kind: 'person' | 'agent'; id: string }, createdAt = 1000) =>
      ({ askedIn: { author: { ...author, name: author.id, membershipGeneration: 'g' }, source: false, createdAt } })
    expect(() => f.run({ type: 'tab.buddies', enabled: true, askedIn }, agentActor(f.pm), asked({ kind: 'person', id: 'peer' }))).toThrow('Only the Swarm owner')
    f.run({ type: 'tab.buddies', enabled: true, askedIn }, agentActor(f.pm), asked({ kind: 'person', id: 'owner' }))
    expect(f.state.buddies).toBe(true)
  })

  it('removes every Buddy when turned off, closing its session, and keeps their chats for their owners', () => {
    const f = setup()
    f.run({ type: 'tab.buddies', enabled: true })
    const off = f.run({ type: 'tab.buddies', enabled: false })
    expect(f.state.buddies).toBeUndefined()
    expect(f.state.agents.map(a => a.id)).not.toContain('buddy')
    expect(off.cancelledAgents).toEqual(['buddy'])
    expect(f.state.closingSessions).toEqual([{ agentId: 'buddy', machineId: 'machine', harnessId: 'buddy-harness', machineOwnerId: 'host' }])
    expect(group(f, f.chat)).toMatchObject({ agentIds: [], archived: false })
    expect(canReadGroup(f.state, peer, group(f, f.chat))).toBe(true)
  })
})

/** [contributorId]'s machine in the Swarm's Machines list, reporting now, for any project (`scope: swarm`). */
function machine(f: ReturnType<typeof setup>, machineId: string, contributorId: string) {
  f.state.machines = [...(f.state.machines ?? []), { machineId, name: `${contributorId}'s Mac`, contributorId, generation: 'g1', cwd: '/swarm', scope: 'swarm',
    membershipGeneration: f.state.people.find(p => p.id === contributorId)!.generation, engines: ['claude', 'codex'], maxAgents: 3, paused: false,
    observation: { generation: 'g1', receivedAt: 1000, sessionKind: 'computer',
      resources: { cpuPercent: null, memoryTotalBytes: null, memoryUsedBytes: null, diskFreeBytes: null, diskTotalBytes: null, projectDiskFreeBytes: null,
        deviceType: null, chip: null, os: null, gpuPercent: null }, tools: {}, quotas: [], runningHarnessIds: [], stoppedHarnessIds: [] } }]
}
/** A person adding a Buddy on [machineId], with the grant the store reads for it: a Swarm machine is run by its contributor. */
const addBuddy = (f: ReturnType<typeof setup>, actor: Actor, projectId: string, machineId = 'peer-mac', engine: 'claude' | 'codex' = 'claude') =>
  f.run({ type: 'buddy.create', projectId, machineId, engine }, actor,
    { contribution: { machineOwnerId: f.state.machines?.find(m => m.machineId === machineId)?.contributorId ?? 'nobody',
      contributorId: f.state.machines?.find(m => m.machineId === machineId)?.contributorId ?? 'nobody' } })
/** The Buddy setup() stored by hand is someone else's: here peer has none yet. */
function fresh() {
  const f = setup()
  f.state.agents = f.state.agents.filter(a => a.id !== 'buddy')
  f.state.conversations = f.state.conversations.filter(c => c.id !== f.chat)
  machine(f, 'peer-mac', 'peer')
  f.run({ type: 'tab.buddies', enabled: true })
  return f
}

describe('adding a Buddy', () => {
  it('is refused while Buddies are off', () => {
    const f = fresh()
    f.run({ type: 'tab.buddies', enabled: false })
    expect(() => addBuddy(f, peer, f.app.projectId)).toThrow('Buddies are off')
  })

  it('opens the person\'s Buddy chat, read by them alone, and starts the Buddy on the machine they chose', () => {
    const f = fresh()
    const added = addBuddy(f, peer, f.app.projectId, 'peer-mac', 'codex')
    const chat = group(f, added.result.conversationId as string)
    expect(chat).toMatchObject({ kind: 'buddy', projectId: f.app.projectId, leadId: null, agentIds: [], archived: false,
      audience: { people: [{ id: 'peer', generation: 'first' }] } })
    expect(added.messages).toEqual([])
    const start = f.state.starts!.find(s => s.id === added.result.startId)!
    expect(start).toMatchObject({ contributorId: 'peer', machineOwnerId: 'peer', poolGeneration: 'g1', dispatched: false, error: null })
    expect(start.request).toMatchObject({ conversationId: chat.id, machineId: 'peer-mac', engine: 'codex', cwd: `/swarm/${f.app.projectId}`,
      worktree: true, name: 'peer\'s Buddy', buddyOf: { personId: 'peer', generation: 'first' } })
    expect(start.request.role).toBeUndefined()
  })

  it('makes the started agent a Buddy in its owner\'s chat, and says it is ready there', () => {
    const f = fresh()
    const added = addBuddy(f, peer, f.app.projectId)
    const host = { contribution: { machineOwnerId: 'peer', contributorId: 'peer' } }
    const joined = f.run({ type: 'agent.started', startId: added.result.startId as string, harnessId: 'native', configuration }, peer, host)
    const buddy = f.state.agents.find(a => a.id === joined.result.agentId)!
    expect(buddy.buddyOf).toEqual({ personId: 'peer', generation: 'first' })
    expect(group(f, added.result.conversationId as string).agentIds).toEqual([buddy.id])
    expect(joined.messages).toEqual([])
    const settled = f.run({ type: 'agent.startSettled', startId: added.result.startId as string, warning: null }, peer, host)
    expect(settled.messages.map(m => [m.conversationId, m.text, m.recipients])).toEqual([[added.result.conversationId, 'peer\'s Buddy is ready. Tell it what you have in mind.', []]])
  })

  it('is one per person and project, while it starts or runs; another project or person may have their own', () => {
    const f = fresh()
    machine(f, 'owner-mac', 'owner')
    const added = addBuddy(f, peer, f.app.projectId)
    expect(() => addBuddy(f, peer, f.app.projectId)).toThrow('already have a Buddy')
    f.run({ type: 'agent.started', startId: added.result.startId as string, harnessId: 'native', configuration }, peer,
      { contribution: { machineOwnerId: 'peer', contributorId: 'peer' } })
    expect(() => addBuddy(f, peer, f.app.projectId)).toThrow('already have a Buddy')
    expect(addBuddy(f, peer, f.web.projectId).result.startId).toBeTruthy()
    expect(addBuddy(f, owner, f.app.projectId, 'owner-mac').result.startId).toBeTruthy()
  })

  it('reopens the same chat when added again after its Buddy was removed', () => {
    const f = fresh()
    const first = addBuddy(f, peer, f.app.projectId)
    f.state.starts!.find(s => s.id === first.result.startId)!.error = 'Stopped.'
    expect(addBuddy(f, peer, f.app.projectId).result.conversationId).toBe(first.result.conversationId)
    expect(f.state.conversations.filter(c => c.kind === 'buddy')).toHaveLength(1)
  })

  it('is refused to an agent, a viewer, and on a machine that is not in the Swarm', () => {
    const f = fresh()
    expect(() => addBuddy(f, agentActor(f.pm), f.app.projectId)).toThrow('A person adds their own Buddy')
    f.state.people.find(p => p.id === 'peer')!.role = 'viewer'
    expect(() => addBuddy(f, peer, f.app.projectId)).toThrow()
    f.state.people.find(p => p.id === 'peer')!.role = 'collaborator'
    expect(() => addBuddy(f, peer, f.app.projectId, 'elsewhere')).toThrow('Add this machine to the Swarm first')
  })
})

describe('a Buddy\'s start on its machine', () => {
  const lookups = { people: [], confidential: new Set<string>(), agentGrant: async () => {}, teams: [], githubApp: false }
  const user = { sub: 'peer', email: peer.email, role: 'user', autonomousEnv: 'test' } as never

  it('is listed to its host apart from other starts, with its chat authorized for the project folder, so an older host never launches it', async () => {
    const f = fresh()
    const added = addBuddy(f, peer, f.app.projectId)
    const pool = (await hostTab('swarm', f.state, 'peer-mac', user, null, lookups)).pool!
    expect(pool.starts).toEqual([])
    expect(pool.buddyStarts!.map(s => s.id)).toEqual([added.result.startId])
    expect(pool.projects!.find(p => p.id === f.app.projectId)!.conversationIds).toContain(added.result.conversationId)
  })

  it('fails when its machine, still reporting, has not taken it in 5 minutes, and tells its owner in their chat to update Harness there', () => {
    const f = fresh()
    const added = addBuddy(f, peer, f.app.projectId)
    const fresh4 = 1000 + 4 * 60_000
    f.state.machines![0]!.observation!.receivedAt = fresh4
    expect(sweepLiveness(f.state, fresh4)).toEqual([])
    const late = 1000 + 5 * 60_000 + 1
    f.state.machines![0]!.observation!.receivedAt = late
    const notices = sweepLiveness(f.state, late)
    const start = f.state.starts!.find(s => s.id === added.result.startId)!
    expect(start.error).toBe('peer\'s Mac did not start this Buddy. Update Harness on it, then add the Buddy again.')
    expect(notices).toEqual([expect.objectContaining({ conversationId: added.result.conversationId, recipients: [], text: expect.stringContaining('Update Harness'),
      author: expect.objectContaining({ kind: 'person', id: 'peer' }), source: { kind: 'start-timeout', startId: start.id } })])
  })

  it('keeps waiting while its machine is not reporting', () => {
    const f = fresh()
    const added = addBuddy(f, peer, f.app.projectId)
    expect(sweepLiveness(f.state, 1000 + 10 * 60_000)).toEqual([])
    expect(f.state.starts!.find(s => s.id === added.result.startId)!.error).toBeNull()
  })
})

describe('what a Buddy may do', () => {
  /** setup()'s Buddy, with Buddies on. */
  const on = () => { const f = setup(); f.run({ type: 'tab.buddies', enabled: true }); return f }
  const buddy = agentActor('buddy')

  it('is post in its own chat; its owner\'s message there reaches it, and nobody else posts there', () => {
    const f = on()
    expect(f.run({ type: 'message.send', conversationId: f.chat, text: 'What outcome do you want?', replyTo: null, recipientIds: [] }, buddy).messages[0])
      .toMatchObject({ conversationId: f.chat, recipients: [] })
    expect(f.run({ type: 'message.send', conversationId: f.chat, text: 'Faster sync.', replyTo: null, recipientIds: [] }, peer).messages[0])
      .toMatchObject({ recipients: ['buddy'] })
    expect(() => f.run({ type: 'message.send', conversationId: f.chat, text: 'Hi', replyTo: null, recipientIds: [] })).toThrow('unavailable')
    expect(() => f.run({ type: 'message.send', conversationId: f.chat, text: 'Hi', replyTo: null, recipientIds: [] }, agentActor(f.pm))).toThrow('unavailable')
  })

  it('never posts in the project chat or anywhere else but its chat: proposals go through the proposal command', () => {
    const f = on()
    for (const conversationId of [f.app.conversationId, f.group, f.pmChat, f.web.conversationId, f.state.leadsConversationId!]) {
      expect(() => f.run({ type: 'message.send', conversationId, text: 'Hello PM', replyTo: null, recipientIds: [] }, buddy)).toThrow()
    }
    expect(() => f.run({ type: 'message.send', conversationId: f.app.conversationId, text: 'Hello PM', replyTo: null, recipientIds: [] }, buddy))
      .toThrow('A Buddy posts only in its own chat')
  })

  it('never assigns, starts agents, opens groups, asks decisions, sets rules or reacts outside its chat', () => {
    const f = on()
    const refused: Command[] = [
      { type: 'work.assign', conversationId: f.group, agentId: 'buddy' },
      { type: 'work.define', conversationId: f.group, brief: 'Do it', checks: [{ description: 'Done', independent: false }] },
      { type: 'conversation.create', projectId: f.app.projectId, title: 'New', brief: 'Brief', checks: [{ description: 'Done', independent: false }] },
      { type: 'agent.start', request: { conversationId: f.group, machineId: 'machine', engine: 'claude', name: 'Helper', cwd: '/repo', worktree: true,
        requirements: { memoryBytes: 0, diskBytes: 0, maxCpuPercent: 100, tools: [], devices: [], quotaRequired: false } }, routeDecisionId: 'route' },
      { type: 'decision.ask', conversationId: f.chat, personId: 'peer', questions: [{ question: 'Which?', options: ['A', 'B'], recommended: 0, unblocks: 'Work' }] },
      { type: 'rule.set', rule: { kind: 'preferIdle' }, text: 'Idle first.' },
      { type: 'conversation.agent', conversationId: f.app.conversationId, agentId: 'buddy', present: true, lead: false },
      { type: 'message.react', conversationId: f.app.conversationId, messageId: 'm', emoji: 'thumbs_up', on: true },
      { type: 'agent.remove', agentId: f.pm },
      { type: 'tab.buddies', enabled: false },
    ]
    for (const command of refused) expect(() => f.run(command, buddy), command.type).toThrow('A Buddy')
  })

  it('reports its own configuration and its own stop, as its machine does for every agent', () => {
    const f = on()
    f.run({ type: 'agent.configuration', previousVersion: null, configuration: { ...configuration, model: 'opus' } }, buddy)
    expect(f.state.agents.find(a => a.id === 'buddy')!.configuration.model).toBe('opus')
  })
})

describe('a Buddy\'s proposal to the PM', () => {
  const buddy = agentActor('buddy')
  const proposal = { goal: 'Sync edits made offline', scope: 'Desktop drafts only; no phone yet', priority: 'high' as const }
  /** setup()'s Buddy with Buddies on, and the message its owner asked with, as the store reads it. */
  function asked(author: { kind: 'person' | 'agent'; id: string; generation?: string } = { kind: 'person', id: 'peer' }, extra: Record<string, unknown> = {}) {
    const f = setup()
    f.run({ type: 'tab.buddies', enabled: true })
    const ask = { conversationId: f.chat, source: false, createdAt: 900,
      author: { kind: author.kind, id: author.id, name: author.id, membershipGeneration: author.generation ?? 'first' }, ...extra }
    const propose = (ownerMessageId = 'ask', context: Record<string, unknown> = { proposalAsk: { id: ownerMessageId, ...ask } }) =>
      f.run({ type: 'buddy.propose', conversationId: f.chat, ownerMessageId, ...proposal }, buddy, context)
    return { f, propose }
  }

  it('posts one message in the project chat, to the PM, written by the server as on its owner\'s behalf', () => {
    const { f, propose } = asked()
    const posted = propose().messages
    expect(posted).toEqual([expect.objectContaining({ conversationId: f.app.conversationId, recipients: [f.pm],
      author: expect.objectContaining({ kind: 'agent', id: 'buddy' }), source: { kind: 'buddy-proposal', personId: 'peer', ownerMessageId: 'ask' },
      text: 'Proposal from peer\'s Buddy, on peer\'s behalf.\n\nGoal: Sync edits made offline\nScope: Desktop drafts only; no phone yet\nPriority: high' })])
  })

  it('is one per ask: the same message never asks twice', () => {
    const { propose } = asked()
    propose()
    expect(() => propose()).toThrow('already sent')
  })

  it('is refused without its owner\'s own message in its chat asking for it', () => {
    expect(() => asked().propose('ask', {})).toThrow('your owner\'s message')
    expect(() => asked({ kind: 'agent', id: 'buddy' }).propose()).toThrow('your owner\'s message')
    expect(() => asked({ kind: 'person', id: 'owner' }).propose()).toThrow('your owner\'s message')
    expect(() => asked({ kind: 'person', id: 'peer', generation: 'old' }).propose()).toThrow('your owner\'s message')
    expect(() => asked(undefined, { source: true }).propose()).toThrow('your owner\'s message')
    expect(() => asked(undefined, { conversationId: 'elsewhere' }).propose()).toThrow('your owner\'s message')
    const { f } = asked()
    expect(() => f.run({ type: 'buddy.propose', conversationId: f.app.conversationId, ownerMessageId: 'ask', ...proposal }, buddy)).toThrow('A Buddy posts only in its own chat')
  })

  it('is a Buddy\'s alone, and only while Buddies are on', () => {
    const { f, propose } = asked()
    expect(() => f.run({ type: 'buddy.propose', conversationId: f.app.conversationId, ownerMessageId: 'ask', ...proposal }, agentActor(f.pm))).toThrow('Only a Buddy')
    expect(() => f.run({ type: 'buddy.propose', conversationId: f.chat, ownerMessageId: 'ask', ...proposal }, peer)).toThrow('Only a Buddy')
    f.state.buddies = undefined
    expect(() => propose()).toThrow('Buddies are off')
  })
})

describe('removing a Buddy', () => {
  /** fresh() with peer's Buddy started on peer's Mac. */
  function running() {
    const f = fresh()
    const added = addBuddy(f, peer, f.app.projectId)
    const host = { contribution: { machineOwnerId: 'peer', contributorId: 'peer' } }
    const agentId = f.run({ type: 'agent.started', startId: added.result.startId as string, harnessId: 'native', configuration }, peer, host).result.agentId as string
    f.run({ type: 'agent.startSettled', startId: added.result.startId as string, warning: null }, peer, host)
    return { f, chat: added.result.conversationId as string, agentId }
  }

  it('is its owner\'s: its session closes and its chat stays for them', () => {
    const { f, chat, agentId } = running()
    expect(() => f.run({ type: 'buddy.remove', projectId: f.app.projectId })).toThrow('no Buddy')
    const removed = f.run({ type: 'buddy.remove', projectId: f.app.projectId }, peer)
    expect(removed.cancelledAgents).toEqual([agentId])
    expect(f.state.closingSessions).toEqual([{ agentId, machineId: 'peer-mac', harnessId: 'native', machineOwnerId: 'peer' }])
    expect(group(f, chat)).toMatchObject({ agentIds: [], archived: false })
    expect(addBuddy(f, peer, f.app.projectId).result.conversationId).toBe(chat)
  })

  it('cancels one still starting', () => {
    const f = fresh()
    const added = addBuddy(f, peer, f.app.projectId)
    f.run({ type: 'buddy.remove', projectId: f.app.projectId }, peer)
    expect(f.state.starts!.find(s => s.id === added.result.startId)!.error).toBe('Removed by its owner before it started.')
  })

  it('happens when its owner leaves the Swarm, whoever\'s machine it runs on', () => {
    const { f, agentId } = running()
    f.state.machines![0]!.contributorId = 'owner'
    f.state.agents.find(a => a.id === agentId)!.contributorId = 'owner'
    f.run({ type: 'member.remove', userId: 'peer' })
    expect(f.state.agents.map(a => a.id)).not.toContain(agentId)
  })

  it('happens with its project', () => {
    const { f, agentId } = running()
    f.run({ type: 'project.delete', projectId: f.app.projectId })
    expect(f.state.agents.map(a => a.id)).not.toContain(agentId)
  })
})

describe('a Buddy is never a worker', () => {
  it('is never assigned work nor added to a group', () => {
    const f = setup()
    f.run({ type: 'tab.buddies', enabled: true })
    expect(() => f.run({ type: 'work.define', conversationId: f.group, brief: 'Do it', checks: [{ description: 'Done', independent: false }] })).not.toThrow()
    expect(() => f.run({ type: 'work.assign', conversationId: f.group, agentId: 'buddy' })).toThrow('A Buddy is never assigned work')
    expect(() => f.run({ type: 'conversation.agent', conversationId: f.group, agentId: 'buddy', present: true, lead: false })).toThrow('A Buddy stays in its own chat')
  })

  it('is left alone by the idle tidy-up: it waits for its owner', async () => {
    const { stopIdleWorkers } = await import('./tidy.js')
    const f = setup(), now = 10 * 3_600_000
    machine(f, 'machine', 'owner')
    const buddy = f.state.agents.find(a => a.id === 'buddy')!
    buddy.startedSession = { creationId: 'c', sessionId: 's', createdAt: new Date(0).toISOString() }
    // An Engineer just like it, in the same chat, idle as long and reported clean, is stopped: the Buddy is not.
    f.state.agents.push({ ...structuredClone(buddy), id: 'builder', harnessId: 'builder-harness', buddyOf: undefined })
    group(f, f.chat).agentIds.push('builder')
    Object.assign(f.state.machines![0]!.observation!, { receivedAt: now, runningHarnessIds: ['buddy-harness', 'builder-harness'],
      harnessUncommitted: { 'buddy-harness': false, 'builder-harness': false } })
    expect(stopIdleWorkers(f.state, f.app.projectId, now, new Set()).map(row => row.source)).toEqual([{ kind: 'idle-stop', agentId: 'builder' }])
    expect(buddy.workDecision).toBeUndefined()
  })
})

describe('Chat with PM while Buddies are on', () => {
  const on = () => { const f = setup(); f.run({ type: 'tab.buddies', enabled: true }); return f }
  const say = (conversationId: string) => ({ type: 'message.send' as const, conversationId, text: 'Hi', replyTo: null, recipientIds: [] })

  it('is read-only: no new one, and nobody posts in an old one, the PM included; its history stays readable', () => {
    const f = on()
    expect(() => f.run({ type: 'conversation.create', projectId: f.app.projectId, title: 'owner', brief: '', checks: [],
      audience: { personIds: ['owner'] } })).toThrow('Chat with PM is read-only')
    expect(() => f.run(say(f.pmChat), peer)).toThrow('Chat with PM is read-only')
    expect(() => f.run(say(f.pmChat), agentActor(f.pm))).toThrow('Chat with PM is read-only')
    expect(canReadGroup(f.state, peer, group(f, f.pmChat))).toBe(true)
  })

  it('takes no new decisions: the PM asks in the project chat or a workgroup', () => {
    const f = on()
    const ask = (conversationId: string) => f.run({ type: 'decision.ask', conversationId, personId: 'peer',
      questions: [{ question: 'Which?', options: ['A', 'B'], recommended: 0, unblocks: 'Work' }] }, agentActor(f.pm))
    expect(() => ask(f.pmChat)).toThrow('Chat with PM is read-only')
    expect(ask(f.app.conversationId).result.decisionIds).toHaveLength(1)
  })

  it('works as before while Buddies are off', () => {
    const f = setup()
    expect(f.run(say(f.pmChat), peer).messages).toHaveLength(1)
  })
})

describe('a Buddy chat as readers get it', () => {
  it('names its kind and owner and carries no audience, so an app from before Buddies never takes it for Chat with PM', () => {
    const f = setup()
    group(f, f.chat).proposals = ['ask']
    const view = groupView(group(f, f.chat), new Set()) as unknown as Record<string, unknown>
    expect(view).toMatchObject({ id: f.chat, kind: 'buddy', buddyOwnerId: 'peer', agentIds: ['buddy'] })
    expect(view).not.toHaveProperty('audience')
    expect(view).not.toHaveProperty('proposals')
    expect(groupView(group(f, f.pmChat), new Set())).toHaveProperty('audience')
  })
})

describe('a Buddy chat stored in parts', () => {
  it('comes back as a conversation, never set aside as a kind this release does not know', () => {
    const f = setup()
    const back = reassemble(split(f.state, { tabId: 'swarm', version: 1, now: 1000 }))
    expect(back.conversations.map(c => c.id)).toContain(f.chat)
    expect(back.parkedConversations).toBeUndefined()
  })
})

describe('a Buddy\'s terminal alert', () => {
  it('tells its owner in their chat, never the PM in the project chat', () => {
    const f = setup()
    f.run({ type: 'tab.buddies', enabled: true })
    const rows = f.run({ type: 'agent.alert', agentId: 'buddy', alert: 'prompt', active: true }, agentActor('buddy')).messages
    expect(rows.map(r => [r.conversationId, r.recipients])).toEqual([[f.chat, []]])
  })
})

describe('a decision left to the PM while Buddies are on', () => {
  it('puts the PM\'s line in the person\'s Buddy chat, to no one, not in their read-only Chat with PM', () => {
    const f = setup()
    const decision = { id: 'decision-1', personId: 'peer', conversationId: f.group, projectId: f.app.projectId, askerAgentId: f.pm,
      question: 'Ship how?', options: ['Behind a flag', 'To everyone'], recommended: 1, answeredAt: null, createdAt: 0, assignmentId: null }
    const delegate = () => f.run({ type: 'decision.answer', decisionId: 'decision-1', delegate: true }, peer, { decision }).messages
      .filter(m => (m.source as { kind?: string } | undefined)?.kind === 'decision-delegated')
    expect(delegate().map(m => m.conversationId)).toEqual([f.pmChat])
    f.run({ type: 'tab.buddies', enabled: true })
    expect(delegate()).toEqual([expect.objectContaining({ conversationId: f.chat, recipients: [], text: 'PM decided: To everyone — Ship how?' })])
  })
})

describe('starting a down Buddy again', () => {
  /** fresh() with peer's Buddy started and settled on peer's Mac. */
  function running() {
    const f = fresh()
    const added = addBuddy(f, peer, f.app.projectId)
    const host = { contribution: { machineOwnerId: 'peer', contributorId: 'peer' } }
    const agentId = f.run({ type: 'agent.started', startId: added.result.startId as string, harnessId: 'native', configuration }, peer, host).result.agentId as string
    f.run({ type: 'agent.startSettled', startId: added.result.startId as string, warning: null }, peer, host)
    return { f, chat: added.result.conversationId as string, agentId }
  }

  it('replaces the person\'s own down Buddy in one step, closing its session and keeping the same chat', () => {
    const { f, chat, agentId } = running()
    f.state.agents.find(a => a.id === agentId)!.downSince = new Date(500).toISOString()
    const again = addBuddy(f, peer, f.app.projectId)
    expect(again.result.conversationId).toBe(chat)
    expect(again.cancelledAgents).toEqual([agentId])
    expect(f.state.agents.map(a => a.id)).not.toContain(agentId)
    expect(f.state.closingSessions).toEqual([{ agentId, machineId: 'peer-mac', harnessId: 'native', machineOwnerId: 'peer' }])
    expect(f.state.starts!.find(s => s.id === again.result.startId)!.request).toMatchObject({ conversationId: chat, buddyOf: { personId: 'peer' } })
    expect(group(f, chat).agentIds).toEqual([])
  })

  it('counts a Buddy as down when its machine stopped reporting', () => {
    const { f, agentId } = running()
    const late = 1000 + 10 * 60_000
    expect(() => f.run({ type: 'buddy.create', projectId: f.app.projectId, machineId: 'peer-mac', engine: 'claude' }, peer,
      { now: late, contribution: { machineOwnerId: 'peer', contributorId: 'peer' } })).toThrow()
    expect(f.state.agents.map(a => a.id)).toContain(agentId)
    f.state.machines!.push({ ...structuredClone(f.state.machines![0]!), machineId: 'spare-mac', observation: { ...structuredClone(f.state.machines![0]!.observation!), receivedAt: late } })
    const again = f.run({ type: 'buddy.create', projectId: f.app.projectId, machineId: 'spare-mac', engine: 'claude' }, peer,
      { now: late, contribution: { machineOwnerId: 'peer', contributorId: 'peer' } })
    expect(again.cancelledAgents).toEqual([agentId])
  })

  it('still refuses while the Buddy runs', () => {
    const { f, agentId } = running()
    expect(() => addBuddy(f, peer, f.app.projectId)).toThrow('You already have a Buddy in this project')
    expect(f.state.agents.map(a => a.id)).toContain(agentId)
  })
})
