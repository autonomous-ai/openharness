import { describe, expect, it } from 'vitest'
import { applyCommand, commandSchema, type Command, type CommandContext } from '../commands.js'
import { createSuperTab, type Actor, type AgentConfiguration, type Conversation } from '../model.js'
import { MAX_UNBLOCKS } from './record.js'

const HOLD = { kind: 'person', personId: 'owner', defaultAt: '2026-11-06T02:00:00.000Z' } as const

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
  /** The owner's Buddy chat in the Swarm's project, as adding a Buddy opens it: the one private chat (buddies.ts). */
  const buddyChat = () => {
    state.conversations.push({ id: 'owner-buddy', kind: 'buddy', title: 'Owner\'s Buddy', leadId: null, agentIds: [], archived: false, brief: '',
      checks: [], assignment: null, lastMessageSequence: 0, audience: { people: [{ id: 'owner', generation: state.people[0]!.generation }] } })
    return 'owner-buddy'
  }
  /** A worker on [id] with its task assigned, returning the assignment id. */
  const assign = (id: string, worker = add(`worker-${id}`, id)) => {
    run({ type: 'work.assign', conversationId: id, agentId: worker })
    return { worker, assignmentId: group(id).assignment!.id }
  }
  const status = (id: string, assignmentId: string, worker: string, next: 'working' | 'needs_human' | 'review' | 'done', result: string | null = null) =>
    run({ type: 'work.status', conversationId: id, assignmentId, status: next, result, ...(next === 'needs_human' ? { hold: HOLD } : {}) }, asAgent(worker))
  const say = (id: string, actor: Actor, text = 'Go with the flag.', replyTo: string | null = null, reply?: CommandContext['reply']) =>
    run({ type: 'message.send', conversationId: id, text, replyTo, recipientIds: [] }, actor, reply ? { reply } : {})
  return { run, invitePeer, add, asAgent, create, group, buddyChat, assign, status, say,
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

  it('never names a requester for a Buddy chat: private chats never count', () => {
    const f = fixture()
    const id = f.buddyChat()
    expect(f.group(id).requesterId).toBeUndefined()
    expect(f.group(id).ledger).toBeUndefined()
    expect(() => f.run({ type: 'conversation.requester', conversationId: id, personId: 'owner' })).toThrow('chat only')
  })
})

describe('when a request ships', () => {
  it('records the first time its work is done', () => {
    const f = fixture(), id = f.create(), { worker, assignmentId } = f.assign(id)
    f.at(9_000)
    f.status(id, assignmentId, worker, 'done', 'Merged https://github.com/o/r/pull/7')
    expect(f.group(id).ledger?.shippedAt).toBe(9_000)
  })

  it('records the machine each attempt ran on, and the attempt it shipped on keeps it (contributor view, #2444)', () => {
    const f = fixture(), id = f.create(), { worker, assignmentId } = f.assign(id)
    f.status(id, assignmentId, worker, 'done', 'Merged https://github.com/o/r/pull/7')
    expect(f.group(id).ledger?.runs?.at(-1)?.machineId).toBe('host')
    expect(f.group(id).ledger?.shippedBy?.machineId).toBe('host')
  })

  it('keeps the first ship time when the same group finishes again', () => {
    const f = fixture(), id = f.create()
    const first = f.assign(id)
    f.at(9_000)
    f.status(id, first.assignmentId, first.worker, 'done', 'Merged')
    f.run({ type: 'work.define', conversationId: id, brief: 'More', checks })
    const second = f.assign(id, first.worker)
    f.at(20_000)
    f.status(id, second.assignmentId, second.worker, 'done', 'Merged again')
    expect(f.group(id).ledger?.shippedAt).toBe(9_000)
  })
})

describe('who unblocks waiting work', () => {
  it('credits the person the item waits on with their answer and how long the agent waited', () => {
    const f = fixture(), id = f.create(), { worker, assignmentId } = f.assign(id)
    f.at(10_000)
    f.status(id, assignmentId, worker, 'needs_human', 'Flag or everyone?')
    expect(f.group(id).ledger?.waiting).toEqual({ assignmentId, since: 10_000, messageId: expect.any(String) })
    f.at(10_000 + 3 * 3_600_000)
    f.say(id, owner)
    expect(f.group(id).ledger?.unblocks).toEqual([{ personId: 'owner', at: 10_000 + 3 * 3_600_000, waitedMs: 3 * 3_600_000, kind: 'needs_human',
      item: f.group(id).ledger!.waiting!.messageId }])
    expect(f.group(id).ledger?.waiting).toEqual({ assignmentId, since: 10_000, messageId: expect.any(String), answeredAt: 10_000 + 3 * 3_600_000 })
  })

  it('opens a new wait when the agent asks again after an answer', () => {
    const f = fixture(), id = f.create(), { worker, assignmentId } = f.assign(id)
    f.status(id, assignmentId, worker, 'needs_human', 'Flag?')
    f.say(id, owner)
    f.at(50_000)
    f.status(id, assignmentId, worker, 'needs_human', 'And the default?')
    expect(f.group(id).ledger?.waiting).toEqual({ assignmentId, since: 50_000, messageId: expect.any(String) })
    f.say(id, owner, 'Off.')
    expect(f.group(id).ledger?.unblocks).toHaveLength(2)
  })

  it('counts one answer per wait: a second post earns nothing more', () => {
    const f = fixture(), id = f.create(), { worker, assignmentId } = f.assign(id)
    f.status(id, assignmentId, worker, 'needs_human', 'Flag?')
    f.say(id, owner)
    f.say(id, owner, 'And one more thing.')
    expect(f.group(id).ledger?.unblocks).toHaveLength(1)
  })

  it('ignores a passer-by who neither is waited on nor replies to the question', () => {
    const f = fixture()
    f.invitePeer()
    const id = f.create(), { worker, assignmentId } = f.assign(id)
    f.status(id, assignmentId, worker, 'needs_human', 'Flag?')
    f.say(id, peer, 'Lunch at noon?')
    expect(f.group(id).ledger?.unblocks).toBeUndefined()
    expect(f.group(id).ledger?.waiting).toBeDefined()
  })

  it('credits anyone who replies to the waiting question itself', () => {
    const f = fixture()
    f.invitePeer()
    const id = f.create(), { worker, assignmentId } = f.assign(id)
    const asked = f.status(id, assignmentId, worker, 'needs_human', 'Flag?').messages[0]!
    f.say(id, peer, 'Flag.', asked.id, { id: asked.id, conversationId: id, author: asked.author, createdAt: 1_000 })
    expect(f.group(id).ledger?.unblocks).toEqual([expect.objectContaining({ personId: 'peer' })])
  })

  it('waits on the project owner when the group has no requester', () => {
    const f = fixture(), lead = f.add('lead', 'lead', true), id = f.create(f.asAgent(lead))
    const { worker, assignmentId } = f.assign(id)
    f.status(id, assignmentId, worker, 'needs_human', 'Flag?')
    f.say(id, owner)
    expect(f.group(id).ledger?.unblocks).toEqual([expect.objectContaining({ personId: 'owner' })])
  })

  it('stops waiting when the agent moves on by itself, so a later post earns nothing', () => {
    const f = fixture(), id = f.create(), { worker, assignmentId } = f.assign(id)
    f.status(id, assignmentId, worker, 'needs_human', 'Flag?')
    f.status(id, assignmentId, worker, 'working')
    f.say(id, owner)
    expect(f.group(id).ledger?.waiting).toBeUndefined()
    expect(f.group(id).ledger?.unblocks).toBeUndefined()
  })

  it('earns nothing for a post after the waiting task was cancelled', () => {
    const f = fixture(), id = f.create(), { worker, assignmentId } = f.assign(id)
    f.status(id, assignmentId, worker, 'needs_human', 'Flag?')
    f.run({ type: 'work.cancel', conversationId: id, assignmentId, reason: 'Not needed' })
    f.say(id, owner)
    expect(f.group(id).ledger?.unblocks).toBeUndefined()
  })

  it('credits nothing against a wait left from an earlier attempt', () => {
    const f = fixture(), id = f.create(), { worker, assignmentId } = f.assign(id)
    f.status(id, assignmentId, worker, 'needs_human', 'Flag?')
    // As a group from before answers were recorded reads: the wait on record is another attempt's.
    f.group(id).ledger!.waiting!.assignmentId = 'earlier-attempt'
    f.say(id, owner)
    expect(f.group(id).ledger?.unblocks).toBeUndefined()
  })

  it('does not credit an agent that posts while work waits', () => {
    const f = fixture(), id = f.create(), { worker, assignmentId } = f.assign(id)
    f.status(id, assignmentId, worker, 'needs_human', 'Flag?')
    f.say(id, f.asAgent(worker), 'Still waiting.')
    expect(f.group(id).ledger?.unblocks).toBeUndefined()
  })

  it('keeps only the last five weeks of answers, so a group part stays small', () => {
    const f = fixture(), id = f.create(), { worker, assignmentId } = f.assign(id)
    const week = 7 * 86_400_000
    for (const at of [0, 4 * week, 6 * week]) {
      f.at(at + 1_000)
      f.status(id, assignmentId, worker, 'needs_human', `Ask at ${at}`)
      f.at(at + 2_000)
      f.say(id, owner)
      f.status(id, assignmentId, worker, 'working')
    }
    expect(f.group(id).ledger?.unblocks?.map(u => u.at)).toEqual([4 * week + 2_000, 6 * week + 2_000])
  })
})

describe('other ways a person unblocks work: approvals and tags', () => {
  const HOUR = 3_600_000
  /** The project's Lead asks in its own conversation at [askedAt], returning what a reply to it carries. */
  const leadAsk = (f: ReturnType<typeof fixture>, askedAt = HOUR) => {
    const lead = f.add('lead', 'lead', true)
    f.at(askedAt)
    const asked = f.say('lead', f.asAgent(lead), 'Plan: three steps. Reply GO to start.').messages[0]!
    return { lead, reply: { id: asked.id, conversationId: 'lead', author: asked.author, createdAt: askedAt } }
  }
  const tagged = (f: ReturnType<typeof fixture>, id: string, text: string, openTags: CommandContext['openTags']) =>
    f.run({ type: 'message.send', conversationId: id, text, replyTo: null, recipientIds: [] }, owner, { openTags })

  for (const word of ['GO', 'go ahead', 'Approve', 'approved, thanks', 'Duyệt', 'duyet nhe', 'DUYỆT nhé', '  Go!']) {
    it(`counts "${word}" in reply to the Lead's ask as an approval, with how long the ask waited`, () => {
      const f = fixture(), { reply } = leadAsk(f, HOUR)
      f.at(4 * HOUR)
      f.say('lead', owner, word, reply.id, reply)
      expect(f.group('lead').ledger?.unblocks).toEqual([{ personId: 'owner', at: 4 * HOUR, waitedMs: 3 * HOUR, kind: 'approval', item: reply.id }])
    })
  }

  for (const word of ['ok', 'OK, go', 'goal: ship Friday', 'approves nothing yet', 'no, not GO']) {
    it(`does not count "${word}" as an approval`, () => {
      const f = fixture(), { reply } = leadAsk(f)
      f.say('lead', owner, word, reply.id, reply)
      expect(f.group('lead').ledger?.unblocks).toBeUndefined()
    })
  }

  it('counts an approval only in reply to the project\'s Lead, never to another agent', () => {
    const f = fixture(), id = f.create(), { worker } = f.assign(id)
    const said = f.say(id, f.asAgent(worker), 'Shall I start?').messages[0]!
    f.say(id, owner, 'GO', said.id, { id: said.id, conversationId: id, author: said.author, createdAt: 1_000 })
    expect(f.group(id).ledger?.unblocks).toBeUndefined()
  })

  it('counts one approval per ask, however many people or times reply GO', () => {
    const f = fixture()
    f.invitePeer()
    const { reply } = leadAsk(f)
    f.say('lead', owner, 'GO', reply.id, reply)
    f.say('lead', owner, 'GO again', reply.id, reply)
    f.say('lead', peer, 'Approved', reply.id, reply)
    expect(f.group('lead').ledger?.unblocks).toEqual([expect.objectContaining({ personId: 'owner', kind: 'approval' })])
  })

  it('credits a reply to the tags waiting on the person once, timed from the oldest', () => {
    const f = fixture(), id = f.create()
    f.at(5 * HOUR)
    tagged(f, id, 'Here you go.', [{ messageId: 'tag-new', createdAt: 3 * HOUR }, { messageId: 'tag-old', createdAt: HOUR }])
    expect(f.group(id).ledger?.unblocks).toEqual([{ personId: 'owner', at: 5 * HOUR, waitedMs: 4 * HOUR, kind: 'tag_reply', item: 'tag-old' }])
    tagged(f, id, 'And again.', [{ messageId: 'tag-old', createdAt: HOUR }])
    expect(f.group(id).ledger?.unblocks).toHaveLength(1)
  })

  it('gives one post one credit: an answer to waiting work that also replies to a tag counts as the answer', () => {
    const f = fixture(), id = f.create(), { worker, assignmentId } = f.assign(id)
    f.status(id, assignmentId, worker, 'needs_human', 'Flag?')
    tagged(f, id, 'Flag.', [{ messageId: 'tag', createdAt: 0 }])
    expect(f.group(id).ledger?.unblocks).toEqual([expect.objectContaining({ kind: 'needs_human' })])
  })

  it('never credits a private conversation', () => {
    const f = fixture()
    const chat = f.buddyChat()
    tagged(f, chat, 'Hi.', [{ messageId: 'tag', createdAt: 0 }])
    expect(f.group(chat).ledger?.unblocks).toBeUndefined()
  })

  it(`keeps at most ${MAX_UNBLOCKS} credits on one conversation, the newest`, () => {
    const f = fixture(), id = f.create()
    for (let i = 0; i <= MAX_UNBLOCKS; i++) {
      f.at(10_000 + i)
      tagged(f, id, `Reply ${i}`, [{ messageId: `tag-${i}`, createdAt: 0 }])
    }
    const kept = f.group(id).ledger!.unblocks!
    expect(kept).toHaveLength(MAX_UNBLOCKS)
    expect(kept[0]!.item).toBe('tag-1')
  })
})

describe('the model behind each assignment (roadmap, Dec: about 30% of work on cheaper models)', () => {
  const independent = [{ description: 'Works', independent: false }, { description: 'Independent review', independent: true }]

  it('records the engine and model each assignment runs on', () => {
    const f = fixture()
    f.at(5_000)
    const id = f.create(owner, { checks: independent })
    const { assignmentId, worker } = f.assign(id)
    const harnessId = f.state.agents.find(a => a.id === worker)!.harnessId
    expect(f.group(id).ledger!.runs).toEqual([{ assignmentId, engine: 'claude', model: 'opus', effort: 'high', at: 5_000, agentId: worker, harnessId, machineId: 'host' }])
  })

  it('records no effort that names none: what Claude Code reports as auto, or a start that left the engine its own', () => {
    for (const effort of ['auto', 'default', null]) {
      const f = fixture()
      const id = f.create(owner, { checks: independent })
      const worker = f.add(`w-${effort}`, id)
      f.state.agents.find(a => a.id === worker)!.configuration.effort = effort
      f.assign(id, worker)
      expect(f.group(id).ledger!.runs![0], String(effort)).not.toHaveProperty('effort')
    }
  })

  it('names the model an agent reports after its task began, when it had reported none: never "Codex" alone (Dee, 2026-10-30)', () => {
    const f = fixture()
    const id = f.create(owner, { checks: independent }), done = f.create(owner, { checks: independent })
    const worker = f.add('codex-worker', id), earlier = f.add('codex-earlier', done)
    for (const agentId of [worker, earlier]) f.state.agents.find(a => a.id === agentId)!.configuration = { ...config, engine: 'codex', model: null }
    const { assignmentId } = f.assign(id, worker)
    const finished = f.assign(done, earlier)
    f.status(done, finished.assignmentId, earlier, 'done', 'Shipped')
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
    return { id, ...f.assign(id, worker) }
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
    f.run({ type: 'work.cancel', conversationId: task!.id, assignmentId: task!.assignmentId, reason: 'Handing it on.' })
    const next = f.add('claude-next', task!.id)
    f.assign(task!.id, next)
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
    f.run({ type: 'work.cancel', conversationId: handedOn!.id, assignmentId: handedOn!.assignmentId, reason: 'Handing it on.' })
    f.assign(handedOn!.id, f.add('claude-next', handedOn!.id))
    reportModel(f, current!.worker, { model: 'gpt-6.1-sol' })
    reportModel(f, handedOn!.worker, { model: 'gpt-6.1-sol' })
    expect(f.group(current!.id).ledger!.runs![0]!.model).toBe('gpt-6.1-sol')
    expect(f.group(handedOn!.id).ledger!.runs![0]!.model).toBeNull()
  })

  it('names the grid model from the start of an agent from before agents kept it, while that start is loaded', () => {
    const f = fixture()
    const id = f.create(owner, { checks: independent })
    const worker = f.add('grid-worker', id)
    f.state.starts = [{ id: 's1', creationId: 'c1', actorKey: 'agent:lead', contributorId: 'owner', membershipGeneration: 'g', machineOwnerId: 'host-owner',
      hostGrant: null, harnessId: 'grid-worker', dispatched: true, error: null,
      request: { conversationId: id, machineId: 'host', engine: 'claude', model: 'default', effort: 'default', name: 'Builder', cwd: '/repo', worktree: true,
        gridModel: 'moonshotai/kimi-k3', gridName: 'swarm-0123456789ab',
        requirements: { memoryBytes: 1, diskBytes: 1, maxCpuPercent: 80, tools: [], devices: [], quotaRequired: false } } }]
    const { assignmentId } = f.assign(id, worker)
    expect(f.group(id).ledger!.runs).toEqual([{ assignmentId, engine: 'claude', model: 'moonshotai/kimi-k3', effort: 'high', grid: true, at: 1_000,
      agentId: worker, harnessId: f.state.agents.find(a => a.id === worker)!.harnessId, machineId: 'host' }])
  })

  // Checks are information (project instructions, phase 4): every check is a review's, whatever `independent` says.
  it('keeps the last 20 assignments of a group', () => {
    const f = fixture()
    const id = f.create(owner, { checks: independent })
    const worker = f.add('worker', id)
    let first = ''
    for (let i = 0; i < 21; i++) {
      const { assignmentId } = f.assign(id, worker)
      if (i === 0) first = assignmentId
      f.run({ type: 'work.cancel', conversationId: id, assignmentId, reason: 'Again.' })
    }
    expect(f.group(id).ledger!.runs).toHaveLength(20)
    expect(f.group(id).ledger!.runs!.map(r => r.assignmentId)).not.toContain(first)
  })

  it('takes the asked time for a request recorded before the first assignment was kept, once its first attempt may have rolled off', () => {
    const f = fixture()
    f.at(1_000)
    const id = f.create(owner, { checks: independent })
    const worker = f.add('worker', id)
    for (let i = 0; i < 21; i++) {
      f.at(10_000 + i)
      const { assignmentId } = f.assign(id, worker)
      f.run({ type: 'work.cancel', conversationId: id, assignmentId, reason: 'Again.' })
    }
    // As a group recorded before the time was kept: 20 attempts kept, the first rolled off.
    delete f.group(id).ledger!.firstAssignedAt
    f.at(20_000)
    f.assign(id, worker)
    expect(f.group(id).ledger!.firstAssignedAt).toBe(1_000)
  })

  it('takes the first assignment time from the kept attempts for a request recorded before it was kept (review of #2097)', () => {
    const f = fixture()
    const id = f.create(owner, { checks: independent })
    const worker = f.add('worker', id)
    f.at(10_000)
    const first = f.assign(id, worker)
    f.run({ type: 'work.cancel', conversationId: id, assignmentId: first.assignmentId, reason: 'Again.' })
    // As a group recorded before the time was kept.
    delete f.group(id).ledger!.firstAssignedAt
    f.at(10_001)
    f.assign(id, worker)
    expect(f.group(id).ledger!.firstAssignedAt).toBe(10_000)
  })

  it('records the attempt a request shipped on, and keeps it through a later attempt (review of #2097)', () => {
    const f = fixture()
    f.at(5_000)
    const id = f.create(owner, { checks })
    const { worker, assignmentId } = f.assign(id)
    f.at(6_000)
    f.status(id, assignmentId, worker, 'done', 'Shipped at rev abc.')
    const shippedBy = { assignmentId, at: 5_000, engine: 'claude', model: 'opus', effort: 'high', machineId: 'host' }
    expect(f.group(id).ledger!.shippedBy).toEqual(shippedBy)
    // Reopened and worked again on another model: the ship stays the first attempt's.
    const other = f.add('other', id)
    f.state.agents.find(a => a.id === other)!.configuration = { ...config, model: 'sonnet' }
    f.at(7_000)
    f.assign(id, other)
    expect(f.group(id).ledger!.shippedBy).toEqual(shippedBy)
  })

  it('keeps the request\'s first assignment time once its first attempt has rolled off (review of #2097)', () => {
    const f = fixture()
    const id = f.create(owner, { checks: independent })
    const worker = f.add('worker', id)
    for (let i = 0; i < 21; i++) {
      f.at(10_000 + i)
      const { assignmentId } = f.assign(id, worker)
      f.run({ type: 'work.cancel', conversationId: id, assignmentId, reason: 'Again.' })
    }
    expect(f.group(id).ledger!.runs![0]!.at).toBe(10_001)
    expect(f.group(id).ledger!.firstAssignedAt).toBe(10_000)
  })
})

describe('a group opened from a Buddy\'s proposal (Lead, 2026-10-29: the Buddy earns when it ships)', () => {
  /** A Buddy of the owner in the project, and its proposal posted in the project chat. */
  function proposed(f: ReturnType<typeof fixture>) {
    const buddy = f.add('buddy')
    f.state.agents.find(a => a.id === buddy)!.buddyOf = { personId: 'owner', generation: 'g' }
    const proposal: NonNullable<CommandContext['proposal']> = { id: 'm-proposal', conversationId: 'lead',
      author: { kind: 'agent', id: buddy, name: 'buddy', membershipGeneration: 'g' }, source: { kind: 'buddy-proposal', personId: 'owner', ownerMessageId: 'm-ask' } }
    return { buddy, proposal }
  }
  const createFrom = (f: ReturnType<typeof fixture>, proposal: CommandContext['proposal']) =>
    f.run(commandSchema.parse({ type: 'conversation.create', title: 'Dark mode', brief: 'Add it.', checks, proposalMessageId: 'm-proposal' }), owner,
      { proposal }).result.conversationId as string

  it('records the Buddy whose proposal the group comes from', () => {
    const f = fixture()
    f.at(5_000)
    const { buddy, proposal } = proposed(f)
    const id = createFrom(f, proposal)
    expect(f.group(id).ledger).toEqual({ askedAt: 5_000, proposal: { buddyId: buddy, messageId: 'm-proposal' } })
  })

  it('is requested by the person the proposal was sent for when a Lead names nobody, and by the one it names otherwise', () => {
    const f = fixture(), lead = f.asAgent(f.add('lead', 'lead', true))
    f.invitePeer()
    const { proposal } = proposed(f)
    const fromLead = (extra: Record<string, unknown> = {}) => f.run(commandSchema.parse({ type: 'conversation.create', title: 'Dark mode', brief: 'Add it.',
      checks, proposalMessageId: 'm-proposal', ...extra }), lead, { proposal }).result.conversationId as string
    expect(f.group(fromLead()).requesterId).toBe('owner')
    expect(f.group(fromLead({ requesterId: 'peer' })).requesterId).toBe('peer')
    // A person opening it from someone else's proposal opens it for that someone.
    const forPeer = { ...proposal, source: { ...proposal.source, personId: 'peer' } }
    expect(f.group(createFrom(f, forPeer)).requesterId).toBe('peer')
  })

  it('refuses a link to a message that is not a Buddy\'s proposal in this project\'s chat', () => {
    const f = fixture()
    const { proposal } = proposed(f)
    const lead = f.add('not-buddy')
    for (const wrong of [undefined, { ...proposal, source: null }, { ...proposal, conversationId: 'elsewhere' },
      { ...proposal, author: { ...proposal.author, id: lead } }, { ...proposal, author: { ...proposal.author, kind: 'person' as const, id: 'owner' } }]) {
      expect(() => createFrom(f, wrong), JSON.stringify(wrong)).toThrow(/proposal/i)
    }
  })
})
