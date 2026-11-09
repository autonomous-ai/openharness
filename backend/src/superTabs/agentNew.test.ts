import { describe, expect, it } from 'vitest'
import { applyCommand, type Command, type CommandContext } from './commands.js'
import { AGENT_MEMORY_BYTES, type ContributedMachine } from './machines.js'
import { createSuperTab, SuperTabError, type Actor, type SuperTabState } from './model.js'
import { agentKind } from './agentKind.js'
import { hostTab } from './read/hostRows.js'

// Task #4116 (Swarm v3, anh Dee 11-07): "+ New agent" makes a Regular or a PM agent on the person's own computer and account.
// A PM names and starts a project; a Regular agent is in no project, and the task it is given decides where it works.
const NOW = 50_000_000
const owner: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'owner', email: 'owner@example.com' }
const mate: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'mate', email: 'mate@example.com' }
const resources = { cpuPercent: 1, memoryTotalBytes: 8, memoryUsedBytes: 1, diskFreeBytes: 8, diskTotalBytes: 8, projectDiskFreeBytes: 8,
  deviceType: null, chip: null, os: null, gpuPercent: null }
const reading = { generation: 'g1', receivedAt: NOW, sessionKind: 'computer' as const, resources, tools: {}, quotas: [], runningHarnessIds: [],
  stoppedHarnessIds: [], capabilities: ['leadStart', 'regularAgent'] }
const own = (userId: string) => ({ contribution: { machineOwnerId: userId, contributorId: userId } })
const code = (body: () => unknown): string | null => {
  // A schema refusal (a missing field) has no code of its own.
  try { body(); return null } catch (error) { return error instanceof SuperTabError ? error.code : 'INVALID' }
}

function swarm() {
  let state: SuperTabState = createSuperTab('tab', 'Pilot', { id: 'owner', email: owner.email }, 'prod')
  let sequence = 0
  const run = (command: Command, actor: Actor = mate, context: Partial<CommandContext> = {}) => {
    const effects = applyCommand(state, actor, command, { now: NOW, operationId: `op-${++sequence}`, ...context })
    state = effects.state
    return effects
  }
  const invited = run({ type: 'invite.create', email: mate.email, role: 'collaborator', conversationId: 'lead' }, owner)
  run({ type: 'invite.accept', inviteId: invited.result.inviteId as string }, mate)
  const generation = (userId: string) => state.people.find(p => p.id === userId)!.generation
  const pool = (machineId: string, contributorId: string, extra: Partial<ContributedMachine> = {}): ContributedMachine => ({
    machineId, name: machineId, contributorId, membershipGeneration: generation(contributorId), generation: 'g1', cwd: '/swarm', scope: 'swarm',
    engines: ['claude', 'codex'], maxAgents: 4, paused: false, observation: reading, ...extra })
  state.machines = [pool('owner-mac', 'owner'), pool('mate-mac', 'mate'), pool('mate-buddy', 'mate', { buddyOnly: true, maxAgents: 1 })]
  const add = (extra: Record<string, unknown>, actor: Actor = mate, context: Partial<CommandContext> = own(actor.kind === 'person' ? actor.userId : 'x')) =>
    run({ type: 'agent.new', engine: 'claude', machineId: 'mate-mac', ...extra } as Command, actor, context)
  return { run, add, get state() { return state } }
}

describe('+ New agent, PM', () => {
  it('names a new project of the person and starts its PM on their own computer, with no repository needed', () => {
    const f = swarm()
    const made = f.add({ kind: 'pm', projectName: 'Docs site' })
    const project = f.state.projects!.find(p => p.id === made.result.projectId)!
    expect(project).toMatchObject({ name: 'Docs site', ownerId: 'mate' })
    expect(made.result.conversationId).toBe(project.leadConversationId)
    const start = f.state.starts!.find(s => s.id === made.result.startId)!
    expect(start.request).toMatchObject({ machineId: 'mate-mac', conversationId: project.leadConversationId, engine: 'claude' })
    expect(start).toMatchObject({ contributorId: 'mate', machineOwnerId: 'mate' })
  })

  it('needs a project name', () => {
    const f = swarm()
    expect(code(() => f.add({ kind: 'pm' }))).not.toBeNull()
    expect((f.state.projects ?? []).filter(p => p.id !== 'lead')).toHaveLength(0)
  })
})

describe('+ New agent, Regular', () => {
  it('starts on the person\'s own computer in a chat of its own, in no project', () => {
    const f = swarm()
    const made = f.add({ kind: 'regular', name: 'Ada' })
    const chat = f.state.conversations.find(c => c.id === made.result.conversationId)!
    expect(chat).toMatchObject({ title: 'Ada', audience: { people: [{ id: 'mate' }] } })
    const start = f.state.starts!.find(s => s.id === made.result.startId)!
    expect(start.request).toMatchObject({ machineId: 'mate-mac', conversationId: chat.id, engine: 'claude', name: 'Ada', regular: true })
    expect(start).toMatchObject({ contributorId: 'mate', machineOwnerId: 'mate' })
    expect((f.state.projects ?? []).filter(p => p.id !== 'lead')).toHaveLength(0)
  })

  it('asks an agent\'s memory, not a Buddy\'s smaller one: it takes tasks (#3738)', () => {
    const f = swarm()
    const made = f.add({ kind: 'regular', name: 'Ada' })
    expect(f.state.starts!.find(s => s.id === made.result.startId)!.request.requirements.memoryBytes).toBe(AGENT_MEMORY_BYTES)
  })

  it('once started, is a Regular agent in its own chat', () => {
    const f = swarm()
    const made = f.add({ kind: 'regular', name: 'Ada' })
    const startId = made.result.startId as string
    f.run({ type: 'agent.startDispatch', startId }, mate, own('mate'))
    const agentId = f.run({ type: 'agent.started', startId, harnessId: 'h-ada',
      configuration: { engine: 'claude', model: 'opus', effort: 'high', contextWindow: null, engineVersion: null } }, mate, own('mate')).result.agentId as string
    const agent = f.state.agents.find(a => a.id === agentId)!
    expect(agentKind(f.state, agent)).toBe('regular')
    expect(f.state.conversations.find(c => c.id === made.result.conversationId)!.agentIds).toContain(agentId)
  })
})

describe('+ New agent, on whose computer', () => {
  it('runs only on the person\'s own listed computer, never another person\'s, a Buddy-only one or one not listed', () => {
    const f = swarm()
    for (const kind of ['pm', 'regular']) {
      const extra = { kind, projectName: 'P', name: 'A' }
      expect(code(() => f.add({ ...extra, machineId: 'owner-mac' }, mate, { contribution: { machineOwnerId: 'owner', contributorId: 'owner' } }))).toBe('AGENT_OWN_MACHINE')
      expect(code(() => f.add({ ...extra, machineId: 'mate-buddy' }))).toBe('MACHINE_NOT_LISTED')
      expect(code(() => f.add({ ...extra, machineId: 'nowhere' }))).toBe('MACHINE_NOT_LISTED')
      expect(code(() => f.add(extra, { kind: 'agent', agentId: 'x', machineOwnerId: 'mate' }))).not.toBeNull()
    }
    expect((f.state.projects ?? []).filter(p => p.id !== 'lead')).toHaveLength(0)
    expect(f.state.starts ?? []).toHaveLength(0)
  })
})

describe('a Regular agent\'s chat', () => {
  /** Mate's Regular agent Ada, started and running in its chat. */
  function running() {
    const f = swarm()
    const made = f.add({ kind: 'regular', name: 'Ada' })
    const startId = made.result.startId as string
    f.run({ type: 'agent.startDispatch', startId }, mate, own('mate'))
    const agentId = f.run({ type: 'agent.started', startId, harnessId: 'h-ada',
      configuration: { engine: 'claude', model: 'opus', effort: 'high', contextWindow: null, engineVersion: null } }, mate, own('mate')).result.agentId as string
    return { ...f, chat: made.result.conversationId as string, agentId }
  }
  const say = (chat: string, text: string) => ({ type: 'message.send', conversationId: chat, text, replyTo: null, recipientIds: [] }) as Command

  it('takes its person\'s messages and the agent\'s replies', () => {
    const f = running()
    expect(code(() => f.run(say(f.chat, 'Hello Ada'), mate))).toBeNull()
    f.run(say(f.chat, 'Hello'), { kind: 'agent', agentId: f.agentId, machineOwnerId: 'mate' })
  })

  // Task #4252 (audit 29): it is a talk with its person, as a Buddy's is, where a short reply is the answer.
  it('takes the agent\'s short reply to its person, which a task would refuse as only an acknowledgement', () => {
    const f = running()
    expect(code(() => f.run(say(f.chat, 'Thanks!'), { kind: 'agent', agentId: f.agentId, machineOwnerId: 'mate' }))).toBeNull()
  })

  it('is read and written by nobody else: not the Swarm\'s owner, nor another agent', () => {
    const f = running()
    expect(code(() => f.run(say(f.chat, 'Peeking'), owner))).toBe('NOT_FOUND')
    const lead = f.state.agents.find(a => a.id !== f.agentId)
    if (lead) expect(code(() => f.run(say(f.chat, 'Peeking'), { kind: 'agent', agentId: lead.id, machineOwnerId: lead.machineOwnerId }))).not.toBeNull()
    // Its agent carried to another owner's machine (a stale grant) is not its person's agent there.
    expect(code(() => f.run(say(f.chat, 'Hi'), { kind: 'agent', agentId: f.agentId, machineOwnerId: 'owner' }))).not.toBeNull()
  })
})

// Swarm v3 FLOW (anh Dee 11-07): join the org, bring your agent on the computer you are on, and it becomes your Buddy. The
// computer registers as part of it: no add-machine step.
describe('joining by bringing your own agent', () => {
  it('makes a new member\'s agent their Buddy on the computer they are on, which the Swarm did not list', () => {
    const f = swarm()
    expect(f.state.machines!.some(m => m.machineId === 'mate-laptop')).toBe(false)
    const made = f.run({ type: 'buddy.create', machineId: 'mate-laptop', engine: 'codex',
      setup: { name: 'Mate laptop', cwd: '/home/mate/swarm', engines: ['codex'] } } as Command, mate, own('mate'))
    const start = f.state.starts!.find(s => s.id === made.result.startId)!
    expect(start.request).toMatchObject({ machineId: 'mate-laptop', engine: 'codex', buddyOf: { personId: 'mate' }, buddyScope: 'swarm' })
    expect(f.state.machines!.find(m => m.machineId === 'mate-laptop')).toMatchObject({ contributorId: 'mate', buddyOnly: true })
    expect(f.state.conversations.find(c => c.id === made.result.conversationId)).toMatchObject({ kind: 'swarm-buddy' })
    // Its computer is its own: nobody else's agent starts there.
    expect(code(() => f.run({ type: 'buddy.create', machineId: 'mate-laptop', engine: 'codex',
      setup: { name: 'Mate laptop', cwd: '/home/mate/swarm', engines: ['codex'] } } as Command, owner, { contribution: { machineOwnerId: 'mate', contributorId: 'mate' } }))).not.toBeNull()
  })
})

// Task #4252 (audit 12): join, Bring agent, then + New agent before the Buddy settles. Desktop lists the computer first.
describe('listing your computer while your Buddy is starting there', () => {
  const contribute = (machineId: string) => ({ type: 'machine.contribute', machineId, name: machineId, cwd: '/home/mate/swarm', scope: 'swarm',
    engines: ['claude', 'codex'], maxAgents: 2 }) as Command
  const configuration = { engine: 'codex' as const, model: 'gpt-6.1-sol', effort: 'high', contextWindow: null, engineVersion: null }

  it('lists it, and the Buddy still starts there', () => {
    const f = swarm()
    const made = f.run({ type: 'buddy.create', machineId: 'mate-laptop', engine: 'codex',
      setup: { name: 'Mate laptop', cwd: '/home/mate/swarm', engines: ['codex'] } } as Command, mate, own('mate'))
    const startId = made.result.startId as string
    f.run(contribute('mate-laptop'), mate, own('mate'))
    const listed = f.state.machines!.find(m => m.machineId === 'mate-laptop')!
    expect(listed.buddyOnly).toBeUndefined()
    expect(f.state.starts!.find(s => s.id === startId)!.poolGeneration).toBe(listed.generation)
    listed.observation = reading // its host's next report
    f.run({ type: 'agent.startDispatch', startId }, mate, own('mate'))
    expect(f.run({ type: 'agent.started', startId, harnessId: 'h-buddy', configuration }, mate, own('mate')).result.agentId).toBeTruthy()
  })

  it('is still refused while any other start is pending there', () => {
    const f = swarm()
    f.add({ kind: 'regular', name: 'Ada' })
    expect(code(() => f.run(contribute('mate-mac'), mate, own('mate')))).toBe('STARTS_PENDING')
  })
})

// Task #4252 (audit 15): leave with the host online, get invited again, then Bring agent before the host reports its cleanup.
describe('bringing an agent after leaving and rejoining', () => {
  it('says the computer is finishing its cleanup, not that its contribution was withdrawn', () => {
    const f = swarm()
    f.run({ type: 'member.remove', userId: 'mate' }, mate)
    const invited = f.run({ type: 'invite.create', email: mate.email, role: 'collaborator', conversationId: 'lead' }, owner)
    f.run({ type: 'invite.accept', inviteId: invited.result.inviteId as string }, mate)
    let refusal: unknown
    try {
      f.run({ type: 'buddy.create', machineId: 'mate-mac', engine: 'codex', setup: { name: 'mate-mac', cwd: '/swarm', engines: ['codex'] } } as Command, mate, own('mate'))
    } catch (error) { refusal = error }
    expect(refusal).toMatchObject({ code: 'MACHINE_CLEANING', message: expect.stringContaining('cleaning up') })
  })
})

// A host from before Regular agents would launch one as a project's agent, in a project folder it does not have: the start is
// listed apart, and a computer whose host cannot run one is told to update instead.
describe('a Regular agent\'s start on its computer', () => {
  const lookups = { people: [], confidential: new Set<string>(), agentGrant: async () => {}, teams: [], githubApp: false }
  const user = { sub: 'mate', email: mate.email, role: 'user', autonomousEnv: 'test' } as never

  it('is listed to its host apart from other starts, in no project\'s folder', async () => {
    const f = swarm()
    const made = f.add({ kind: 'regular', name: 'Ada' })
    const pool = (await hostTab('tab', f.state, 'mate-mac', user, null, lookups)).pool!
    expect(pool.starts).toEqual([])
    expect(pool.regularStarts!.map(s => s.id)).toEqual([made.result.startId])
    expect((pool.projects ?? []).flatMap(p => p.conversationIds)).not.toContain(made.result.conversationId)
  })

  it('is refused on a computer whose Harness cannot run one yet, saying to update it', () => {
    const f = swarm()
    f.state.machines!.find(m => m.machineId === 'mate-mac')!.observation!.capabilities = ['leadStart']
    expect(code(() => f.add({ kind: 'regular', name: 'Ada' }))).toBe('HOST_OUTDATED')
    expect(f.state.starts ?? []).toEqual([])
  })

  // Task #4252 (audit 11): Desktop lists a computer and creates its first agent at once, before the host has reported.
  it('on a computer just listed, with no reading yet, says it is connecting rather than to update it', () => {
    const f = swarm()
    delete f.state.machines!.find(m => m.machineId === 'mate-mac')!.observation
    for (const kind of [{ kind: 'regular', name: 'Ada' }, { kind: 'pm', projectName: 'Docs site' }]) {
      let refusal: unknown
      try { f.add(kind) } catch (error) { refusal = error }
      expect(refusal).toMatchObject({ code: 'HOST_CONNECTING', message: expect.stringContaining('connecting') })
    }
    expect(f.state.starts ?? []).toEqual([])
  })
})

// Task #4196 (anh Dee 11-07): + New agent opens Cmd-N, which starts the agent on the person's own computer at once. A Member's
// chat is opened first with no start, and the running session then joins it: a server start waited on its host (p50 18 s).
describe('+ New agent, Member started on its own computer', () => {
  const configuration = { engine: 'claude', model: 'opus', effort: 'high', contextWindow: null, engineVersion: null }
  const join = (chat: string, extra: Record<string, unknown> = {}) =>
    ({ type: 'agent.add', conversationId: chat, machineId: 'mate-laptop', harnessId: 'h-ada', name: 'Ada', lead: false, configuration, ...extra }) as Command

  it('opens its chat with no start, even on a computer the Swarm does not list', () => {
    const f = swarm()
    const made = f.add({ kind: 'regular', name: 'Ada', machineId: 'mate-laptop', local: true })
    expect(f.state.conversations.find(c => c.id === made.result.conversationId))
      .toMatchObject({ kind: 'agent-chat', title: 'Ada', agentIds: [], audience: { people: [{ id: 'mate' }] } })
    expect(made.result.startId).toBeUndefined()
    expect(f.state.starts ?? []).toEqual([])
  })

  it('takes the running session as a Regular agent in that chat, once', () => {
    const f = swarm()
    const chat = f.add({ kind: 'regular', name: 'Ada', machineId: 'mate-laptop', local: true }).result.conversationId as string
    const added = f.run(join(chat, { initialMessage: 'Fix the docs' }), mate, own('mate'))
    const agent = f.state.agents.find(a => a.id === added.result.agentId)!
    expect(agent).toMatchObject({ machineId: 'mate-laptop', harnessId: 'h-ada', regular: true, name: 'Ada', contributorId: 'mate', machineOwnerId: 'mate' })
    expect(agent.projectId).toBeUndefined()
    expect(agentKind(f.state, agent)).toBe('regular')
    expect(f.state.conversations.find(c => c.id === chat)!.agentIds).toEqual([agent.id])
    expect(added.messages.map(m => m.text)).toContain('Fix the docs')
    expect(code(() => f.run(join(chat, { harnessId: 'h-other' }), mate, own('mate')))).toBe('AGENT_CHAT_TAKEN')
  })

  // On 2026-11-09 anh Dee's new agent could not answer him: its post looked for its chat's project's PM, and a 1:1 chat has no
  // project, so it fell back to the project 'lead', which a Swarm whose projects all have their own ids does not have (404).
  it('answers its person in its chat in a Swarm with no project \'lead\'', () => {
    const f = swarm()
    f.run({ type: 'project.create', name: 'Web', visibility: 'public', brief: '' }, owner)
    f.state.projects = f.state.projects!.filter(p => p.id !== 'lead')
    const chat = f.add({ kind: 'regular', name: 'Ada', machineId: 'mate-laptop', local: true }).result.conversationId as string
    const added = f.run(join(chat, { initialMessage: 'hi' }), mate, own('mate'))
    const hi = added.messages.find(m => m.text === 'hi')!
    const ada: Actor = { kind: 'agent', agentId: added.result.agentId as string, machineOwnerId: 'mate' }
    const sent = f.run({ type: 'message.send', conversationId: chat, text: 'Hi, Ada here. What do you need?', replyTo: null, answers: hi.id, recipientIds: [] }, ada,
      { reply: { id: hi.id, conversationId: chat, author: { kind: 'person', id: 'mate' }, createdAt: NOW, thread: null, threadSource: null } } as Partial<CommandContext>)
    expect(sent.messages.map(m => m.text)).toContain('Hi, Ada here. What do you need?')
  })

  it('leaves an unused chat for its person to archive, as Desktop\'s Discard does', () => {
    const f = swarm()
    const chat = f.add({ kind: 'regular', name: 'Ada', machineId: 'mate-laptop', local: true }).result.conversationId as string
    expect(code(() => f.run({ type: 'conversation.archive', conversationId: chat, archived: true }, owner))).not.toBeNull()
    f.run({ type: 'conversation.archive', conversationId: chat, archived: true }, mate)
    expect(f.state.conversations.find(c => c.id === chat)!.archived).toBe(true)
  })

  it('is refused for a PM, another person\'s computer, another person\'s chat and a viewer', () => {
    const f = swarm()
    expect(code(() => f.add({ kind: 'pm', projectName: 'P', machineId: 'mate-laptop', local: true }))).not.toBeNull()
    expect(code(() => f.add({ kind: 'regular', name: 'A', machineId: 'owner-mac', local: true }, mate,
      { contribution: { machineOwnerId: 'owner', contributorId: 'owner' } }))).toBe('AGENT_OWN_MACHINE')
    const chat = f.add({ kind: 'regular', name: 'Ada', machineId: 'mate-laptop', local: true }).result.conversationId as string
    expect(code(() => f.run(join(chat, { machineId: 'owner-mac' }), mate, { contribution: { machineOwnerId: 'owner', contributorId: 'owner' } })))
      .toBe('AGENT_OWN_MACHINE')
    expect(code(() => f.run(join(chat, { machineId: 'owner-laptop' }), owner, own('owner')))).toBe('NOT_FOUND')
    expect(f.state.conversations.find(c => c.id === chat)!.agentIds).toEqual([])
    const viewer: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'viewer', email: 'viewer@example.com' }
    const invited = f.run({ type: 'invite.create', email: viewer.email, role: 'viewer', conversationId: 'lead' }, owner)
    f.run({ type: 'invite.accept', inviteId: invited.result.inviteId as string }, viewer)
    expect(code(() => f.add({ kind: 'regular', name: 'A', machineId: 'viewer-mac', local: true }, viewer))).toBe('READ_ONLY')
  })
})
