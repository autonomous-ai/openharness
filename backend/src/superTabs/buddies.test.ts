import { describe, expect, it } from 'vitest'
import { storeOldLeads } from './leads.test-support.js'
import { applyCommand, commandSchema, type Command, type CommandContext } from './commands.js'
import { createSuperTab, visibleState, type Actor, type Conversation } from './model.js'
import { canReadGroup, canWatchAgent, isConfidential, readsRecordsIn } from './projects.js'
import { buddyChatId, defaultBuddy, defaultBuddyChat, ownAgentAuthor, refuseOthersInPrivateChat, swarmBuddyChatId } from './buddies.js'
import { giveOwnBuddy } from './ownBuddy.test-support.js'
import { groupView } from './read/views.js'
import { machineOffline, sessionStopped } from './lostReason.js'
import { reassemble, split } from './parts/index.js'

const owner: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'owner', email: 'owner@example.com' }
const peer: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'peer', email: 'peer@example.com' }
const configuration = { engine: 'claude', model: null, effort: null, contextWindow: null, engineVersion: null }

/** A Swarm of two public projects, each with its Lead, and peer's Buddy in the first, stored as buddy.create and its start
 *  left them (buddies.ts): a Buddy agent and its owner-only chat. */
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
  // peer's Chat with PM from before Buddies replaced it: nobody opens one any more, so it is stored as it was left.
  const pmChat = 'peer-pm-chat'
  state.conversations.push({ id: pmChat, projectId: app.projectId, title: 'peer', leadId: pm, agentIds: [pm], archived: false, brief: '',
    checks: [], assignment: null, lastMessageSequence: 0, audience: { people: [{ id: 'peer', generation: 'first' }] } })
  state.agents.push({ id: 'buddy', projectId: app.projectId, machineId: 'machine', harnessId: 'buddy-harness', machineOwnerId: 'host',
    contributorId: 'peer', membershipGeneration: 'first', name: 'Buddy', configuration, buddyOf: { personId: 'peer', generation: 'first' } })
  const chat: Conversation = { id: buddyChatId(app.projectId, { id: 'peer', generation: 'first' }), kind: 'buddy', projectId: app.projectId, title: 'Buddy', leadId: null, agentIds: ['buddy'],
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
  it('is its project\'s chat, its own chat and its project\'s workgroups: no Chat with PM, no other project, no Leads conversation', () => {
    const f = setup(), buddy = agentActor('buddy')
    const web = f.run({ type: 'conversation.create', projectId: f.web.projectId, title: 'Landing', brief: '', checks: [] }).result.conversationId as string
    expect(canReadGroup(f.state, buddy, group(f, f.app.conversationId))).toBe(true)
    expect(canReadGroup(f.state, buddy, group(f, f.group))).toBe(true)
    expect(canReadGroup(f.state, buddy, group(f, f.pmChat))).toBe(false)
    expect(canReadGroup(f.state, buddy, group(f, f.web.conversationId))).toBe(false)
    expect(canReadGroup(f.state, buddy, group(f, web))).toBe(false)
    // Removed for everyone (model.ts leadsRemoved): an older Swarm's stored one is nobody's, its person's neither.
    const leads = storeOldLeads(f.state)
    expect(canReadGroup(f.state, peer, group(f, leads))).toBe(false)
    expect(canReadGroup(f.state, buddy, group(f, leads))).toBe(false)
    expect(visibleState(f.state, buddy).conversations.map(c => c.id).sort()).toEqual([f.app.conversationId, f.chat, f.group].sort())
  })

  it('is no other person\'s private chat, nor one its own person shares with others, nor what was asked in them', () => {
    const f = setup(), buddy = agentActor('buddy')
    // Chats with PM from before Buddies replaced them: nobody opens one now, but their rows and decisions stay.
    const legacy = (id: string, people: string[]) => f.state.conversations.push({ ...group(f, f.group), id, kind: undefined, number: undefined,
      audience: { people: people.map(p => ({ id: p, generation: f.state.people.find(x => x.id === p)!.generation })) } })
    legacy('owners', ['owner'])
    legacy('shared', ['owner', 'peer'])
    expect(readsRecordsIn(f.state, peer, group(f, 'shared'))).toBe(true)
    for (const id of ['owners', 'shared']) {
      expect(canReadGroup(f.state, buddy, group(f, id))).toBe(false)
      expect(readsRecordsIn(f.state, buddy, group(f, id))).toBe(false)
    }
  })

  it('is nothing once its person rejoins at a new membership or leaves the Swarm', () => {
    const f = setup(), buddy = agentActor('buddy')
    f.state.people.find(p => p.id === 'peer')!.generation = 'second'
    expect([f.app.conversationId, f.group, f.chat].map(id => canReadGroup(f.state, buddy, group(f, id)))).toEqual([false, false, false])
    f.state.people = f.state.people.filter(p => p.id !== 'peer')
    expect([f.app.conversationId, f.group, f.chat].map(id => canReadGroup(f.state, buddy, group(f, id)))).toEqual([false, false, false])
  })

  it('is no workgroup of a private project its person is not a member of', () => {
    const f = setup(), buddy = agentActor('buddy')
    const app = f.state.projects!.find(p => p.id === f.app.projectId)!
    app.visibility = 'private'
    expect(canReadGroup(f.state, peer, group(f, f.group))).toBe(false)
    expect(canReadGroup(f.state, buddy, group(f, f.group))).toBe(false)
    expect(canReadGroup(f.state, buddy, group(f, f.app.conversationId))).toBe(false)
    app.members.push({ id: 'peer', generation: 'first' })
    expect(canReadGroup(f.state, buddy, group(f, f.group))).toBe(true)
  })

  it('shows no machines, starts or rules in its Swarm read: only names in the roster', () => {
    const f = setup()
    machine(f, 'peer-mac', 'peer')
    // A rule an older client saved before project instructions, still in the state.
    f.state.rules = [{ id: 'r1', projectId: f.app.projectId, rule: { kind: 'preferIdle' }, text: 'Idle first.', askedBy: 'owner', askedIn: null,
      addedBy: 'person:owner', createdAt: '' }]
    // A start names the machine and the folder on it: a workgroup the Buddy reads still shows none of its starts.
    f.state.starts = [{ id: 'start', creationId: 'c', actorKey: 'k', contributorId: 'owner', membershipGeneration: 'g', machineOwnerId: 'owner',
      hostGrant: null, harnessId: null, dispatched: false, error: null,
      request: { conversationId: f.group, machineId: 'peer-mac', engine: 'claude', name: 'Builder', cwd: '/Users/owner/app', worktree: true } as never }]
    // The project's repository names the folder on its machine: a Buddy keeps the address alone (security review 2 of #2115).
    f.state.projects!.find(p => p.id === f.app.projectId)!.repository = { machineId: 'owner-mac', cwd: '/Users/owner/app', repositoryUrl: 'https://github.com/acme/app' }
    const seen = visibleState(f.state, agentActor('buddy'))
    expect(seen.conversations.map(c => c.id)).toContain(f.group)
    expect(seen.starts ?? []).toEqual([])
    expect(seen.projects!.find(p => p.id === f.app.projectId)!.repository).toEqual({ repositoryUrl: 'https://github.com/acme/app' })
    expect(visibleState(f.state, agentActor(f.pm)).projects!.find(p => p.id === f.app.projectId)!.repository).toMatchObject({ cwd: '/Users/owner/app' })
    expect(JSON.stringify(seen)).not.toContain('/Users/owner/app')
    // No machines means none: agents and a task's assignment keep no machine or terminal id (review 1 of #2115, item 3).
    f.state.conversations.find(c => c.id === f.group)!.assignment = { id: 'a1', agentId: f.pm, status: 'working', result: null,
      execution: { machineId: 'machine', harnessId: 'app-pm', machineOwnerId: 'host', contributorId: 'runner-login' } } as never
    f.state.conversations.find(c => c.id === f.group)!.lostAttempt = { id: 'a0', agentId: f.pm, machineId: 'machine', engine: 'claude' }
    const strict = visibleState(f.state, agentActor('buddy'))
    expect(strict.agents.map(a => [a.machineId, a.harnessId])).toEqual(strict.agents.map(() => ['', '']))
    const task = strict.conversations.find(c => c.id === f.group)!
    // Nor whose login its agent runs under (the Tasks feed's, #4203), as an agent's own contributor is blanked.
    expect(task.assignment!.execution).toEqual({ machineId: '', harnessId: '', machineOwnerId: '', contributorId: '' })
    expect(JSON.stringify(strict)).not.toContain('runner-login')
    expect(task.lostAttempt).toEqual({ id: 'a0', agentId: f.pm })
    expect(visibleState(f.state, agentActor(f.pm)).agents.find(a => a.id === f.pm)!.machineId).toBe('machine')
    // A lost task's reason without its machine, on the task and on the agent; a reason naming none stays (re-check 2).
    const lostTask = (reason: string) => {
      f.state.conversations.find(c => c.id === f.group)!.assignment!.lost = { reason, at: 1000 }
      f.state.agents.find(a => a.id === f.pm)!.lostTask = { conversationId: f.group, assignmentId: 'a1', reason, at: 1000 }
      const read = visibleState(f.state, agentActor('buddy'))
      return [read.conversations.find(c => c.id === f.group)!.assignment!.lost!.reason, read.agents.find(a => a.id === f.pm)!.lostTask!.reason]
    }
    expect(lostTask(machineOffline("Ken's MacBook Pro"))).toEqual(['its machine has been offline for 2 minutes', 'its machine has been offline for 2 minutes'])
    expect(lostTask(sessionStopped('studio.local'))).toEqual(['its session stopped', 'its session stopped'])
    expect(lostTask('no progress for 12 minutes')).toEqual(['no progress for 12 minutes', 'no progress for 12 minutes'])
    expect(visibleState(f.state, agentActor(f.pm)).agents.find(a => a.id === f.pm)!.lostTask!.reason).toBe('no progress for 12 minutes')
    expect(visibleState(f.state, agentActor(f.pm)).starts).toHaveLength(1)
    expect(seen.machines ?? []).toEqual([])
    expect(seen.rules ?? []).toEqual([])
    expect(seen.agents.map(a => a.id)).toContain(f.pm)
    expect(visibleState(f.state, agentActor(f.pm)).machines).toHaveLength(1)
  })

  it('shows where the project\'s Product Manager stands, never the machine it runs on or its start (Diego, 10-30)', () => {
    const f = setup()
    const project = f.state.projects!.find(p => p.id === f.app.projectId)!
    const leadOf = (reader: Actor) => visibleState(f.state, reader).projects!.find(p => p.id === f.app.projectId)!.lead
    project.lead = { status: 'starting', machineId: 'owner-studio', machineName: 'Kens-Mac-Studio.local', startId: 'pm-start' }
    expect(leadOf(agentActor('buddy'))).toEqual({ status: 'starting' })
    expect(JSON.stringify(visibleState(f.state, agentActor('buddy')))).not.toMatch(/owner-studio|Kens-Mac-Studio|pm-start/)
    // A failed start keeps the reason every project reader reads, which names no machine (leadStart.ts leadStartFailed).
    project.lead = { status: 'failed', machineId: 'owner-studio', machineName: 'Kens-Mac-Studio.local', reason: 'Its machine did not start it within 3 minutes.' }
    expect(leadOf(agentActor('buddy'))).toEqual({ status: 'failed', reason: 'Its machine did not start it within 3 minutes.' })
    // People and the PM read it as before.
    for (const reader of [owner, peer, agentActor(f.pm)]) expect(leadOf(reader)).toEqual({ status: 'failed', machineId: 'owner-studio',
      machineName: 'Kens-Mac-Studio.local', reason: 'Its machine did not start it within 3 minutes.' })
    // The Buddy's own read leaves the stored placement as it was.
    expect(project.lead).toEqual({ status: 'failed', machineId: 'owner-studio', machineName: 'Kens-Mac-Studio.local', reason: 'Its machine did not start it within 3 minutes.' })
    // A placement an older server stored (#2089's queue) names its machines in more fields: the Buddy reads its status alone.
    project.lead = { status: 'waiting', requestedAt: 1000, requestedBy: { personId: 'owner', generation: 'g' }, chosen: 'owner-studio',
      skipped: ['owner-laptop'], failures: 1, request: { engine: 'claude', repositoryUrl: 'https://github.com/acme/app' } } as never
    expect(leadOf(agentActor('buddy'))).toEqual({ status: 'waiting' })
    expect(JSON.stringify(visibleState(f.state, agentActor('buddy')))).not.toMatch(/owner-studio|owner-laptop/)
  })

  it('shows no other agent\'s machine owner or contributor, nor a task\'s, only its own (security reviews of #2258)', () => {
    const f = setup()
    const pm = f.state.agents.find(a => a.id === f.pm)!
    // A grant under an older share policy names the contributor's email (lib/machineSharePolicy.ts machineShareGrant).
    Object.assign(pm, { machineOwnerId: 'ken-user', hostGrant: 'share-1:email:ken@example.com' })
    expect(pm.contributorId).toBe('owner')
    f.state.conversations.find(c => c.id === f.group)!.assignment = { id: 'a1', agentId: f.pm, status: 'working', result: null,
      execution: { machineId: 'machine', harnessId: 'app-pm', machineOwnerId: 'ken-user' } } as never
    const seen = visibleState(f.state, agentActor('buddy'))
    const agent = (id: string) => seen.agents.find(a => a.id === id)!
    expect([agent(f.pm).machineOwnerId, agent(f.pm).contributorId]).toEqual(['', ''])
    expect(seen.conversations.find(c => c.id === f.group)!.assignment!.execution).toEqual({ machineId: '', harnessId: '', machineOwnerId: '' })
    expect(JSON.stringify(seen)).not.toMatch(/ken-user/)
    // Nor at which membership another agent was added, which matches a person's and so names them (delta review 1 of #2258).
    const generations = new Set(seen.people.map(p => p.generation))
    expect(seen.agents.filter(a => a.id !== 'buddy' && generations.has(a.membershipGeneration)).map(a => a.id)).toEqual([])
    expect([agent(f.pm).membershipGeneration, agent(f.pm).hostGrant]).toEqual(['', null])
    expect(JSON.stringify(seen)).not.toContain('ken@example.com')
    // Its own record keeps who added it, at which membership and on whose machine, as before.
    expect([agent('buddy').machineOwnerId, agent('buddy').contributorId, agent('buddy').membershipGeneration]).toEqual(['host', 'peer', 'first'])
    // People and the PM read them as before; the stored agent is unchanged.
    for (const reader of [owner, { kind: 'agent', agentId: f.pm, machineOwnerId: 'ken-user' } as Actor]) expect(visibleState(f.state, reader).agents
      .find(a => a.id === f.pm)).toMatchObject({ machineOwnerId: 'ken-user', contributorId: 'owner', membershipGeneration: pm.membershipGeneration,
        hostGrant: 'share-1:email:ken@example.com' })
    expect(pm).toMatchObject({ machineOwnerId: 'ken-user', contributorId: 'owner', hostGrant: 'share-1:email:ken@example.com' })
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

describe('Buddies in every Swarm', () => {
  it('are on in a Swarm whose owner never turned them on, and every reader is told so', () => {
    const f = setup()
    expect(f.state.buddies).toBeUndefined()
    for (const reader of [owner, peer, agentActor(f.pm)]) expect(visibleState(f.state, reader).buddies).toBe(true)
  })

  it('have no switch: turning them on or off is refused, whoever asks', () => {
    const f = setup()
    for (const enabled of [true, false]) expect(() => f.run({ type: 'tab.buddies', enabled } as unknown as Command)).toThrow()
    expect(f.state.agents.map(a => a.id)).toContain('buddy')
  })
})

/** [contributorId]'s machine in the Swarm's Machines list, reporting now, for any project (`scope: swarm`). */
function machine(f: ReturnType<typeof setup>, machineId: string, contributorId: string) {
  f.state.machines = [...(f.state.machines ?? []), { machineId, name: `${contributorId}'s Mac`, contributorId, generation: 'g1', cwd: '/swarm', scope: 'swarm',
    membershipGeneration: f.state.people.find(p => p.id === contributorId)!.generation, engines: ['claude', 'codex'], maxAgents: 3, paused: false,
    observation: { generation: 'g1', receivedAt: 1000,
      resources: { cpuPercent: null, memoryTotalBytes: null, memoryUsedBytes: null, diskFreeBytes: null, diskTotalBytes: null, projectDiskFreeBytes: null,
        deviceType: null, chip: null, os: null, gpuPercent: null }, tools: {}, quotas: [], runningHarnessIds: [], stoppedHarnessIds: [] } }]
}
/** peer's one Buddy chat in the Swarm (buddies.ts swarmBuddyChatId). */
const peerSwarmChat = swarmBuddyChatId({ id: 'peer', generation: 'first' })
/** The Buddy setup() stored by hand is someone else's: here peer has none yet. */
function fresh() {
  const f = setup()
  f.state.agents = f.state.agents.filter(a => a.id !== 'buddy')
  f.state.conversations = f.state.conversations.filter(c => c.id !== f.chat)
  machine(f, 'peer-mac', 'peer')
  return f
}

describe('what a Buddy may do', () => {
  /** setup()'s Buddy, with Buddies on. */
  const on = setup
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

  it('never posts in the project chat or anywhere else but its chat', () => {
    const f = on()
    for (const conversationId of [f.app.conversationId, f.group, f.pmChat, f.web.conversationId, f.state.leadsConversationId!]) {
      expect(() => f.run({ type: 'message.send', conversationId, text: 'Hello PM', replyTo: null, recipientIds: [] }, buddy)).toThrow()
    }
    expect(() => f.run({ type: 'message.send', conversationId: f.app.conversationId, text: 'Hello PM', replyTo: null, recipientIds: [] }, buddy))
      .toThrow('A Buddy posts only in its own chat')
  })

  it('never starts agents, opens groups, sets rules or reacts outside its chat', () => {
    const f = on()
    const refused: Command[] = [
      { type: 'conversation.create', projectId: f.app.projectId, title: 'New', brief: 'Brief', checks: [{ description: 'Done', independent: false }] },
      { type: 'agent.start', request: { conversationId: f.group, machineId: 'machine', engine: 'claude', name: 'Helper', cwd: '/repo', worktree: true,
        requirements: { memoryBytes: 0, diskBytes: 0, maxCpuPercent: 100, tools: [], devices: [], quotaRequired: false } }, routeDecisionId: 'route' },
      { type: 'rule.set', rule: { kind: 'preferIdle' }, text: 'Idle first.' },
      { type: 'conversation.agent', conversationId: f.app.conversationId, agentId: 'buddy', present: true, lead: false },
      { type: 'message.react', conversationId: f.app.conversationId, messageId: 'm', emoji: 'thumbs_up', on: true },
      { type: 'agent.remove', agentId: f.pm },
    ]
    for (const command of refused) expect(() => f.run(command, buddy), command.type).toThrow('A Buddy')
  })

  it('reports its own configuration and its own stop, as its machine does for every agent', () => {
    const f = on()
    f.run({ type: 'agent.configuration', previousVersion: null, configuration: { ...configuration, model: 'opus' } }, buddy)
    expect(f.state.agents.find(a => a.id === 'buddy')!.configuration.model).toBe('opus')
  })
})

// One Buddy per person per Swarm (Dee, 10-31; spec: The model, Guard): it reads every project its person reads, writes nowhere
// but its own chat, and nobody but its person sees it.
describe('a Swarm-wide Buddy', () => {
  /** fresh() with peer's Swarm-wide Buddy stored as it was left before Buddies became agents (buddyConversion.ts). */
  function started() {
    const f = fresh()
    const agentId = giveOwnBuddy(f.state, 'peer').id
    return { f, agentId, chat: peerSwarmChat, self: { kind: 'agent', agentId, machineOwnerId: 'peer' } as Actor }
  }

  it('is in no project, and reads every project its person reads now: never one they lose', () => {
    const { f, chat, self } = started()
    for (const id of [chat, f.app.conversationId, f.web.conversationId, f.group]) expect(canReadGroup(f.state, self, group(f, id))).toBe(true)
    expect(canReadGroup(f.state, self, group(f, f.pmChat))).toBe(false)
    f.state.projects!.find(p => p.id === f.web.projectId)!.visibility = 'private'
    expect(canReadGroup(f.state, self, group(f, f.web.conversationId))).toBe(false)
    f.state.people.find(p => p.id === 'peer')!.generation = 'second'
    expect([chat, f.app.conversationId].map(id => canReadGroup(f.state, self, group(f, id)))).toEqual([false, false])
  })

  it('is seen by its person and itself alone: not the Swarm owner, a PM or another agent', () => {
    const { f, agentId, self } = started()
    expect(visibleState(f.state, peer).agents.map(a => a.id)).toContain(agentId)
    expect(visibleState(f.state, self).agents.map(a => a.id)).toContain(agentId)
    for (const reader of [owner, agentActor(f.pm)]) expect(visibleState(f.state, reader).agents.map(a => a.id)).not.toContain(agentId)
  })
})

describe('removing a Buddy', () => {
  /** fresh() with peer's Swarm-wide Buddy stored on peer's Mac. */
  function running() {
    const f = fresh()
    return { f, chat: peerSwarmChat, agentId: giveOwnBuddy(f.state, 'peer').id }
  }

  it('happens when its owner leaves the Swarm, whoever\'s machine it runs on', () => {
    const { f, agentId } = running()
    f.state.machines![0]!.contributorId = 'owner'
    f.state.agents.find(a => a.id === agentId)!.contributorId = 'owner'
    f.run({ type: 'member.remove', userId: 'peer' })
    expect(f.state.agents.map(a => a.id)).not.toContain(agentId)
  })

  it('happens with its project for an older Buddy of a project chat', () => {
    const f = setup()
    f.run({ type: 'project.delete', projectId: f.app.projectId })
    expect(f.state.agents.map(a => a.id)).not.toContain('buddy')
  })

  it('never happens with a project for a Swarm-wide Buddy, which has none: it and its chat stay', () => {
    const { f, chat, agentId } = running()
    f.run({ type: 'project.delete', projectId: f.app.projectId })
    expect(f.state.agents.map(a => a.id)).toContain(agentId)
    expect(group(f, chat)).toMatchObject({ agentIds: [agentId], archived: false })
  })
})

describe('Chat with PM, replaced by Buddies (Ken, 10-29)', () => {
  const say = (conversationId: string) => ({ type: 'message.send' as const, conversationId, text: 'Hi', replyTo: null, recipientIds: [] })
  const open = (personIds: string[]) => ({ type: 'conversation.create' as const, projectId: 'app', title: 'Private', brief: '', checks: [],
    audience: { personIds } })

  it('is never opened again, by a person or the PM', () => {
    const f = setup()
    const refusal = (actor?: Actor) => { try { f.run({ ...open([actor ? 'peer' : 'owner']), projectId: f.app.projectId }, actor) } catch (e) { return String((e as Error).message) } return '' }
    // Task #4547: neither refusal points at the retired private line; a Lead is told the project chat, tagging (no Decisions since
    // Swarm v4, 2026-11-10).
    expect(refusal()).toContain('Chat with PM is closed')
    expect(refusal()).not.toMatch(/private lines/)
    expect(refusal(agentActor(f.pm))).toMatch(/project chat, tagging them\.$/)
    expect(refusal(agentActor(f.pm))).not.toContain('person.tell')
    expect(f.state.conversations.filter(c => c.audience && !c.kind).map(c => c.id)).toEqual([f.pmChat])
  })

  it('is refused as closed before anything checks what a private chat may carry: work, a requester or a proposal (merge review of #2090)', () => {
    const f = setup()
    const before = f.state.conversations.length
    const carrying = [{ brief: 'Work', checks: [{ description: 'Done', independent: false }] }, { requesterId: 'peer' },
      { proposalMessageId: 'proposal' }]
    for (const extra of carrying) {
      for (const actor of [peer, agentActor(f.pm)]) {
        expect(() => f.run({ ...open(['peer']), projectId: f.app.projectId, ...extra } as Command, actor)).toThrow('Chat with PM is closed')
      }
    }
    expect(f.state.conversations.length).toBe(before)
  })

  it('is hidden from everyone, its person and the PM included, and stays stored', () => {
    const f = setup(), pmChat = group(f, f.pmChat)
    for (const reader of [peer, owner, agentActor(f.pm), agentActor('buddy')]) {
      expect(canReadGroup(f.state, reader, pmChat)).toBe(false)
      expect(visibleState(f.state, reader).conversations.map(c => c.id)).not.toContain(f.pmChat)
    }
    expect(f.state.conversations.map(c => c.id)).toContain(f.pmChat)
  })

  it('takes no posts, the PM\'s included', () => {
    const f = setup()
    expect(() => f.run(say(f.pmChat), peer)).toThrow('unavailable')
    expect(() => f.run(say(f.pmChat), agentActor(f.pm))).toThrow('unavailable')
  })

})

describe('a person\'s private chat with their own agent (anh Dee, 11-07, task #4558)', () => {
  const tell = (personId = 'peer', text = 'Your fix is merged.') => ({ type: 'person.tell' as const, personId, text })
  const send = (conversationId: string, text = 'Hello') => ({ type: 'message.send' as const, conversationId, text, replyTo: null, recipientIds: [] })

  // "I don't want River or Theo to show up in this chat": a Lead's private line is refused, its own project's or another's.
  it('refuses a Lead\'s private line, from its own project or another, naming the project chat, and opens no chat for it', () => {
    const f = fresh()
    const webPm = f.state.agents.find(a => a.harnessId === 'web-pm')!.id
    for (const lead of [f.pm, webPm]) {
      expect(() => f.run(tell(), agentActor(lead))).toThrow(expect.objectContaining({ code: 'PRIVATE_CHAT',
        message: expect.stringContaining('project chat') }))
    }
    expect(f.state.conversations.filter(c => c.kind === 'buddy' || c.kind === 'swarm-buddy')).toEqual([])
  })

  it('keeps another agent\'s line the PM\'s crew need in the project chat, and refuses a person, a stranger or a Buddy', () => {
    const f = fresh()
    const worker = f.run({ type: 'agent.add', conversationId: f.group, harnessId: 'worker-harness', machineId: 'machine', name: 'Worker',
      configuration, lead: false }).result.agentId as string
    expect(() => f.run(tell(), peer)).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
    expect(() => f.run(tell('stranger'), agentActor(f.pm))).toThrow('person in this Swarm')
    expect(f.run(tell(), agentActor(worker)).messages).toEqual([expect.objectContaining({ conversationId: f.app.conversationId, recipients: [f.pm],
      source: expect.objectContaining({ kind: 'crew-need' }) })])
    expect(f.state.conversations.filter(c => c.kind === 'buddy' || c.kind === 'swarm-buddy')).toEqual([])
    expect(() => setup().run(tell('owner'), agentActor('buddy'))).toThrow('A Buddy')
  })

  it('lets the person and their own agent post there, and refuses any other agent\'s row, whatever command writes it', () => {
    const f = setup()
    expect(f.run(send(f.chat, 'What outcome do you want?'), agentActor('buddy')).messages[0]).toMatchObject({ conversationId: f.chat })
    expect(f.run(send(f.chat, 'Faster sync.'), peer).messages[0]).toMatchObject({ conversationId: f.chat })
    const pm = { kind: 'agent' as const, id: f.pm, name: 'app-pm', membershipGeneration: 'first' }
    const row = { id: 'r', conversationId: f.chat, author: pm, text: 'Hi', replyTo: null, recipients: [] }
    expect(() => refuseOthersInPrivateChat(f.state, [row], f.state)).toThrow(expect.objectContaining({ code: 'PRIVATE_CHAT' }))
    // Another person's agent, even a Buddy, is not this person's own.
    f.state.agents.push({ ...f.state.agents.find(a => a.id === 'buddy')!, id: 'owners-buddy', buddyOf: { personId: 'owner', generation: f.state.people[0]!.generation } })
    expect(() => refuseOthersInPrivateChat(f.state, [{ ...row, author: { ...pm, id: 'owners-buddy' } }], f.state)).toThrow(expect.objectContaining({ code: 'PRIVATE_CHAT' }))
    expect(() => refuseOthersInPrivateChat(f.state, [{ ...row, author: { ...pm, id: 'buddy' } }, { ...row, conversationId: f.app.conversationId }], f.state)).not.toThrow()
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
    const rows = f.run({ type: 'agent.alert', agentId: 'buddy', alert: 'prompt', active: true }, agentActor('buddy')).messages
    expect(rows.map(r => [r.conversationId, r.recipients])).toEqual([[f.chat, []]])
  })
})

describe('a Buddy chat\'s readers are fixed (privacy review of #1992)', () => {
  it('refuses adding people or agents to it, the Swarm owner and the PM included', () => {
    const f = setup()
    // No command changes who reads a private chat any more (Buddies replaced Chat with PM).
    expect(commandSchema.safeParse({ type: 'conversation.audience', conversationId: f.chat, personIds: ['peer', 'owner'] }).success).toBe(false)
    expect(() => f.run({ type: 'conversation.agent', conversationId: f.chat, agentId: f.pm, present: true, lead: false }, peer)).toThrow('A Buddy chat stays its owner\'s')
    expect(group(f, f.chat)).toMatchObject({ agentIds: ['buddy'], audience: { people: [{ id: 'peer', generation: 'first' }] } })
  })
})

// Task #3818: what is addressed to a person goes to their default Buddy, the one its chat marks, else their main chat's.
describe('a person\'s default Buddy', () => {
  /** fresh() with two of peer's Buddies stored as several Buddies left them: the first in their main chat, a second in its own. */
  function two() {
    const f = fresh()
    const me = f.state.people.find(p => p.id === 'peer')!
    const first = giveOwnBuddy(f.state, 'peer')
    const second = giveOwnBuddy(f.state, 'peer', 'peer-research')
    // giveOwnBuddy puts each in the main chat: the second moves to a chat of its own, which the main chat lists.
    const main = group(f, peerSwarmChat)
    main.agentIds = [first.id]
    const chat: Conversation = { ...main, id: 'peer-research-chat', title: 'Research', agentIds: [second.id] }
    f.state.conversations.push(chat)
    main.buddyChats = [chat.id]
    return { f, me, first, second, chat }
  }

  it('is their main chat\'s Buddy, who writes the server\'s lines there', () => {
    const { f, me, first } = two()
    expect([defaultBuddyChat(f.state, me).id, defaultBuddy(f.state, 'peer')?.id, ownAgentAuthor(f.state, me)?.id]).toEqual([peerSwarmChat, first.id, first.id])
  })

  it('is the Buddy of the chat they marked, who writes the server\'s lines there', () => {
    const { f, me, second, chat } = two()
    chat.buddyDefault = true
    expect([defaultBuddyChat(f.state, me).id, defaultBuddy(f.state, 'peer')?.id, ownAgentAuthor(f.state, me)?.id]).toEqual([chat.id, second.id, second.id])
  })

  it('is nobody\'s for a person with no Buddy, whose lines then go to their main chat, opened for them', () => {
    const f = fresh()
    const me = f.state.people.find(p => p.id === 'peer')!
    expect([defaultBuddy(f.state, 'peer'), ownAgentAuthor(f.state, me)]).toEqual([undefined, undefined])
    expect(defaultBuddyChat(f.state, me)).toMatchObject({ id: peerSwarmChat, kind: 'swarm-buddy', agentIds: [] })
  })
})
