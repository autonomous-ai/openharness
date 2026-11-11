import { describe, expect, it } from 'vitest'
import { applyCommand, commandSchema, type Command, type CommandContext } from '../commands.js'
import { PERSONAL_SWARM_OPERATION } from '../deletion.js'
import { createSuperTab, stableId, type Actor, type AgentConfiguration, type Conversation } from '../model.js'
import { MAX_UNBLOCKS } from './record.js'
import { storedAssignment, storedStatus, storedTask } from '../storedWork.test-support.js'

const owner: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'owner', email: 'owner@example.com' }
const peer: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'peer', email: 'peer@example.com' }
const config: AgentConfiguration = { engine: 'claude', model: 'opus', effort: 'high', contextWindow: null, engineVersion: null }
const checks = [{ description: 'Works', independent: false }]

/** [personal]: the owner's Personal Swarm, the one place a person still posts in a project's chat (agentsOnly.test.ts). */
function fixture(personal = false) {
  let state = createSuperTab(personal ? stableId('super-tab', 'prod', 'owner', PERSONAL_SWARM_OPERATION) : 'tab', 'Pilot', { id: 'owner', email: owner.email }, 'prod')
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
  /** A task the owner asked for, as one stored before Swarm v4 (storedTask). */
  const create = (extra: { checks?: typeof checks } = {}) => storedTask(state, { brief: 'Save edits.', checks, requesterId: 'owner', ...extra })
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
  const say = (id: string, actor: Actor, text = 'Go with the flag.', replyTo: string | null = null, reply?: CommandContext['reply']) =>
    run({ type: 'message.send', conversationId: id, text, replyTo, recipientIds: [] }, actor, reply ? { reply } : {})
  return { run, invitePeer, add, asAgent, create, group, privateChat, stored, say,
    get state() { return state }, at(ms: number) { now = ms } }
}

describe('who asked for a group', () => {
  it('lets the Lead set or clear the requester of a group already open', () => {
    const f = fixture()
    f.invitePeer()
    const lead = f.add('lead', 'lead', true), id = f.create()
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

// A person's GO in a project's chat: only in a Personal Swarm while agents only exempts it (agentsOnly.test.ts); the credit is
// kept for the leaderboard ledger until the v4 leaderboard is built, and these go with that exemption.
describe('how a person unblocks work: approvals', () => {
  const HOUR = 3_600_000
  /** The project's Lead asks in its own conversation at [askedAt], returning what a reply to it carries. */
  const leadAsk = (f: ReturnType<typeof fixture>, askedAt = HOUR) => {
    const lead = f.add('lead', 'lead', true)
    f.at(askedAt)
    const asked = f.say('lead', f.asAgent(lead), 'Plan: three steps. Reply GO to start.').messages[0]!
    return { lead, reply: { id: asked.id, conversationId: 'lead', author: asked.author, createdAt: askedAt } }
  }
  const posted = (f: ReturnType<typeof fixture>, id: string, text: string) =>
    f.run({ type: 'message.send', conversationId: id, text, replyTo: null, recipientIds: [] }, owner)

  for (const word of ['GO', 'go ahead', 'Approve', 'approved, thanks', 'Duyệt', 'duyet nhe', 'DUYỆT nhé', '  Go!']) {
    it(`counts "${word}" in reply to the Lead's ask as an approval, with how long the ask waited`, () => {
      const f = fixture(true), { reply } = leadAsk(f, HOUR)
      f.at(4 * HOUR)
      f.say('lead', owner, word, reply.id, reply)
      expect(f.group('lead').ledger?.unblocks).toEqual([{ personId: 'owner', at: 4 * HOUR, waitedMs: 3 * HOUR, kind: 'approval', item: reply.id }])
    })
  }

  for (const word of ['ok', 'OK, go', 'goal: ship Friday', 'approves nothing yet', 'no, not GO']) {
    it(`does not count "${word}" as an approval`, () => {
      const f = fixture(true), { reply } = leadAsk(f)
      f.say('lead', owner, word, reply.id, reply)
      expect(f.group('lead').ledger?.unblocks).toBeUndefined()
    })
  }

  it('counts an approval only in reply to the project\'s Lead, never to another agent', () => {
    const f = fixture(true), id = f.create(), worker = f.add('worker', id)
    const said = f.say(id, f.asAgent(worker), 'Shall I start?').messages[0]!
    f.say(id, owner, 'GO', said.id, { id: said.id, conversationId: id, author: said.author, createdAt: 1_000 })
    expect(f.group(id).ledger?.unblocks).toBeUndefined()
  })

  it('counts one approval per ask, however many times its person replies GO', () => {
    const f = fixture(true)
    const { reply } = leadAsk(f)
    f.say('lead', owner, 'GO', reply.id, reply)
    f.say('lead', owner, 'GO again', reply.id, reply)
    expect(f.group('lead').ledger?.unblocks).toEqual([expect.objectContaining({ personId: 'owner', kind: 'approval' })])
  })

  it('never credits a private conversation', () => {
    const f = fixture(true)
    const chat = f.privateChat()
    posted(f, chat, 'GO')
    expect(f.group(chat).ledger?.unblocks).toBeUndefined()
  })

  it(`keeps at most ${MAX_UNBLOCKS} credits on one conversation, the newest`, () => {
    const f = fixture(true), { lead } = leadAsk(f)
    for (let i = 0; i <= MAX_UNBLOCKS; i++) {
      f.at(10_000 + 2 * i)
      const ask = f.say('lead', f.asAgent(lead), `Plan ${i}. Reply GO.`).messages[0]!
      f.say('lead', owner, 'GO', ask.id, { id: ask.id, conversationId: 'lead', author: ask.author, createdAt: 10_000 + 2 * i })
    }
    const kept = f.group('lead').ledger!.unblocks!
    expect(kept).toHaveLength(MAX_UNBLOCKS)
    expect(kept.every(u => u.kind === 'approval')).toBe(true)
  })
})

describe('the model an agent reports for its stored attempts (roadmap, Dec: about 30% of work on cheaper models)', () => {
  const independent = [{ description: 'Works', independent: false }, { description: 'Independent review', independent: true }]

  it('names the model an agent reports after its task began, when it had reported none: never "Codex" alone (Dee, 2026-10-30)', () => {
    const f = fixture()
    const id = f.create({ checks: independent }), done = f.create({ checks: independent })
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
    const id = f.create({ checks: independent }), worker = f.add(`codex-${i}`, id)
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
