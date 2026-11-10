import { describe, expect, it } from 'vitest'
import { applyCommand, commandSchema, type Command, type CommandContext } from '../commands.js'
import { createSuperTab, type Actor, type AgentConfiguration, type Conversation } from '../model.js'
import { storedAssignment, storedStatus } from '../storedWork.test-support.js'

const owner: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'owner', email: 'owner@example.com' }
const peer: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'peer', email: 'peer@example.com' }
const config: AgentConfiguration = { engine: 'claude', model: 'opus', effort: 'high', contextWindow: null, engineVersion: null }
const checks = [{ description: 'Works', independent: false }]

function fixture() {
  let state = createSuperTab('tab', 'Pilot', { id: 'owner', email: owner.email }, 'prod')
  let sequence = 0, now = 1_000
  const run = (command: Command, actor: Actor = owner, context: Partial<CommandContext> = {}) => {
    const effects = applyCommand(state, actor, command, { now, operationId: `op-${++sequence}`, ...context })
    state = effects.state
    return effects
  }
  const invitePeer = () => {
    const invited = run({ type: 'invite.create', email: peer.email, role: 'collaborator', conversationId: 'lead' })
    run({ type: 'invite.accept', inviteId: invited.result.inviteId as string }, peer)
  }
  const add = (harnessId: string, group = 'lead', lead = false) => run({ type: 'agent.add', conversationId: group, machineId: 'host', harnessId,
    name: harnessId, configuration: config, lead }, owner, { contribution: { machineOwnerId: 'host-owner', contributorId: 'owner' } }).result.agentId as string
  const asAgent = (agentId: string): Actor => ({ kind: 'agent', agentId, machineOwnerId: 'host-owner' })
  const create = (actor: Actor = owner, extra: Record<string, unknown> = {}) =>
    run(commandSchema.parse({ type: 'conversation.create', title: 'Offline editing', brief: 'Save edits.', checks, priority: 'P2', ...actor.kind === 'agent' ? { requesterId: 'owner' } : {}, ...extra }), actor).result.conversationId as string
  const group = (id: string): Conversation => state.conversations.find(c => c.id === id)!
  /** The owner's 1:1 chat with an agent of theirs: a private chat. */
  const privateChat = () => {
    state.conversations.push({ id: 'owner-chat', kind: 'agent-chat', title: 'Ada', leadId: null, agentIds: [], archived: false, brief: '',
      checks: [], assignment: null, lastMessageSequence: 0, audience: { people: [{ id: 'owner', generation: state.people[0]!.generation }] } })
    return 'owner-chat'
  }
  /** [worker] on [id] as a Swarm from before Swarm v4 stored it: its assignment, and the attempt the leaderboard recorded with
   *  what it ran on. Returns the assignment id. */
  const stored = (id: string, worker: string) => {
    const agent = state.agents.find(a => a.id === worker)!
    const assignment = storedAssignment(state, id, worker, now)
    const ledger = group(id).ledger ??= {}
    const { engine, model, effort } = agent.configuration
    ledger.runs = [...ledger.runs ?? [], { assignmentId: assignment.id, engine, model, ...effort ? { effort } : {}, at: now,
      agentId: worker, harnessId: agent.harnessId, machineId: agent.machineId }]
    return { worker, assignmentId: assignment.id }
  }
  return { run, invitePeer, add, asAgent, create, group, privateChat, stored,
    get state() { return state }, at(ms: number) { now = ms } }
}

describe('who asked for a group', () => {
  it('records the person who opens a group as its requester, with when they asked', () => {
    const f = fixture()
    f.at(5_000)
    const id = f.create()
    expect(f.group(id).requesterId).toBe('owner')
    expect(f.group(id).ledger).toEqual({ askedAt: 5_000 })
  })

  it('records the person a Lead names when it opens a group for them', () => {
    const f = fixture()
    f.invitePeer()
    const lead = f.add('lead', 'lead', true)
    const id = f.create(f.asAgent(lead), { requesterId: 'peer' })
    expect(f.group(id).requesterId).toBe('peer')
  })

  it('refuses a Lead that names nobody, rather than guessing, and asks nobody of a person (task #3389)', () => {
    const f = fixture(), lead = f.add('lead', 'lead', true)
    f.invitePeer()
    expect(() => f.create(f.asAgent(lead), { requesterId: undefined })).toThrow(expect.objectContaining({ code: 'TASK_CONTRACT_MISSING' }))
    // A person opens it for themselves: it names nobody and is not refused.
    const open = (actor: Actor, extra: Record<string, unknown> = {}) =>
      f.run(commandSchema.parse({ type: 'conversation.create', title: 'Offline editing', brief: 'Save edits.', checks, priority: 'P2', ...extra }), actor).result
    const named = open(f.asAgent(lead), { requesterId: 'peer' })
    for (const result of [named, open(owner)]) expect(result.warnings).toBeUndefined()
  })

  it('refuses a requester who is not a member of the Swarm', () => {
    const f = fixture(), lead = f.add('lead', 'lead', true)
    expect(() => f.create(f.asAgent(lead), { requesterId: 'stranger' })).toThrow('no longer have access')
  })

  it('lets the Lead set or clear the requester of a group already open', () => {
    const f = fixture()
    f.invitePeer()
    const lead = f.add('lead', 'lead', true), id = f.create(f.asAgent(lead))
    f.run(commandSchema.parse({ type: 'conversation.requester', conversationId: id, personId: 'peer' }), f.asAgent(lead))
    expect(f.group(id).requesterId).toBe('peer')
    f.run(commandSchema.parse({ type: 'conversation.requester', conversationId: id, personId: null }), f.asAgent(lead))
    expect(f.group(id).requesterId).toBeUndefined()
  })

  // Who sets a task's requester is workflow (project instructions, phase 4).
  it('lets any agent of the project change the requester', () => {
    const f = fixture(), id = f.create(), worker = f.add('worker', id)
    f.run({ type: 'conversation.requester', conversationId: id, personId: 'owner' }, f.asAgent(worker))
    expect(f.group(id).requesterId).toBe('owner')
  })

  it('never names a requester for a private chat: private chats never count', () => {
    const f = fixture()
    const id = f.privateChat()
    expect(f.group(id).requesterId).toBeUndefined()
    expect(f.group(id).ledger).toBeUndefined()
    expect(() => f.run({ type: 'conversation.requester', conversationId: id, personId: 'owner' })).toThrow('chat only')
  })
})

describe('the model an agent reports for its stored attempts (roadmap, Dec: about 30% of work on cheaper models)', () => {
  const independent = [{ description: 'Works', independent: false }, { description: 'Independent review', independent: true }]

  it('names the model an agent reports after its task began, when it had reported none: never "Codex" alone (Dee, 2026-10-30)', () => {
    const f = fixture()
    const id = f.create(owner, { checks: independent }), done = f.create(owner, { checks: independent })
    const worker = f.add('codex-worker', id), earlier = f.add('codex-earlier', done)
    for (const agentId of [worker, earlier]) f.state.agents.find(a => a.id === agentId)!.configuration = { ...config, engine: 'codex', model: null }
    const { assignmentId } = f.stored(id, worker)
    f.stored(done, earlier)
    storedStatus(f.state, done, 'done', 'Shipped')
    const report = (agentId: string, model: string) => {
      const agent = f.state.agents.find(a => a.id === agentId)!
      f.run({ type: 'agent.configuration', previousVersion: agent.configurationVersion!, configuration: { ...agent.configuration, model } }, f.asAgent(agentId))
    }
    report(worker, 'gpt-6.1-sol')
    report(earlier, 'gpt-6.1-sol')
    expect(f.group(id).ledger!.runs).toEqual([{ assignmentId, engine: 'codex', model: 'gpt-6.1-sol', effort: 'high', at: 1_000,
      agentId: worker, harnessId: f.state.agents.find(a => a.id === worker)!.harnessId, machineId: 'host' }])
    // A task finished before its agent's first report still takes it (Scholes, 2026-10-30): the agent ran that model all along.
    expect(f.group(done).ledger!.runs![0]!.model).toBe('gpt-6.1-sol')
    // A model on record is never rewritten by a later report.
    report(worker, 'gpt-6.1-luna')
    expect(f.group(id).ledger!.runs![0]!.model).toBe('gpt-6.1-sol')
  })

  /** [count] Codex workers on their own groups, launched on Codex's own model, which they have not reported yet. */
  const codexTasks = (f: ReturnType<typeof fixture>, count: number) => Array.from({ length: count }, (_, i) => {
    const id = f.create(owner, { checks: independent }), worker = f.add(`codex-${i}`, id)
    f.state.agents.find(a => a.id === worker)!.configuration = { ...config, engine: 'codex', model: null }
    return { id, ...f.stored(id, worker) }
  })
  const reportModel = (f: ReturnType<typeof fixture>, agentId: string, configuration: Partial<AgentConfiguration>) => {
    const agent = f.state.agents.find(a => a.id === agentId)!
    f.run({ type: 'agent.configuration', previousVersion: agent.configurationVersion!, configuration: { ...agent.configuration, ...configuration } },
      f.asAgent(agentId))
  }

  it('names no model on a grid attempt, another engine\'s attempt, or another agent\'s task', () => {
    const f = fixture()
    const [grid, other, mine] = codexTasks(f, 3)
    const run = (id: string) => f.group(id).ledger!.runs![0]!
    run(grid!.id).grid = true
    reportModel(f, grid!.worker, { model: 'gpt-6.1-sol' })
    // A report from another engine is not what the attempt ran on.
    reportModel(f, other!.worker, { engine: 'claude', model: 'opus' })
    reportModel(f, mine!.worker, { model: 'gpt-6.1-sol' })
    expect(run(grid!.id).model).toBeNull()
    expect(run(other!.id).model).toBeNull()
    expect(run(mine!.id).model).toBe('gpt-6.1-sol')
    expect([run(grid!.id), run(other!.id)].map(r => r.engine)).toEqual(['codex', 'codex'])
  })

  it('names the reported model on an attempt handed on before the report, and only on that agent\'s own (Scholes, 2026-10-30)', () => {
    const f = fixture()
    const [task] = codexTasks(f, 1)
    // Handed on: another agent's attempt is the task's now.
    const next = f.add('claude-next', task!.id)
    f.stored(task!.id, next)
    reportModel(f, task!.worker, { model: 'gpt-6.1-sol' })
    const runs = f.group(task!.id).ledger!.runs!
    expect(runs.map(r => [r.agentId, r.model])).toEqual([[task!.worker, 'gpt-6.1-sol'], [next, 'opus']])
    // Each attempt once: a later report adds no attempt and rewrites none.
    reportModel(f, task!.worker, { model: 'gpt-6.1-luna' })
    expect(f.group(task!.id).ledger!.runs!.map(r => r.model)).toEqual(['gpt-6.1-sol', 'opus'])
  })

  it('names no model on an attempt of the agent\'s earlier terminal: a replacement may run another', () => {
    const f = fixture()
    const [task] = codexTasks(f, 1)
    f.state.agents.find(a => a.id === task!.worker)!.harnessId = 'replacement-terminal'
    reportModel(f, task!.worker, { model: 'gpt-6.1-sol' })
    expect(f.group(task!.id).ledger!.runs![0]!.model).toBeNull()
  })

  it('matches an attempt recorded before attempts named their agent only as its group\'s current one', () => {
    const f = fixture()
    const [current, handedOn] = codexTasks(f, 2)
    for (const id of [current!.id, handedOn!.id]) {
      const run = f.group(id).ledger!.runs![0]!
      delete run.agentId
      delete run.harnessId
    }
    // The second agent's attempt was handed on, so its group's current assignment is another agent's.
    f.stored(handedOn!.id, f.add('claude-next', handedOn!.id))
    reportModel(f, current!.worker, { model: 'gpt-6.1-sol' })
    reportModel(f, handedOn!.worker, { model: 'gpt-6.1-sol' })
    expect(f.group(current!.id).ledger!.runs![0]!.model).toBe('gpt-6.1-sol')
    expect(f.group(handedOn!.id).ledger!.runs![0]!.model).toBeNull()
  })

})
