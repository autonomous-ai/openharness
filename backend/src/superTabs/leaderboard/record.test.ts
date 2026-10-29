import { describe, expect, it } from 'vitest'
import { applyCommand, commandSchema, type Command, type CommandContext } from '../commands.js'
import { createSuperTab, type Actor, type AgentConfiguration, type Conversation } from '../model.js'
import type { DecisionTarget } from '../decisions.js'
import { MAX_UNBLOCKS } from './record.js'
import { leaderboard } from './stats.js'
import { DAY_MS, WEEK_MS, weekStart } from './week.js'

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
    run(commandSchema.parse({ type: 'conversation.create', title: 'Offline editing', brief: 'Save edits.', checks, ...extra }), actor).result.conversationId as string
  const group = (id: string): Conversation => state.conversations.find(c => c.id === id)!
  /** A worker on [id] with its task assigned, returning the assignment id. */
  const assign = (id: string, worker = add(`worker-${id}`, id)) => {
    run({ type: 'work.assign', conversationId: id, agentId: worker })
    return { worker, assignmentId: group(id).assignment!.id }
  }
  const status = (id: string, assignmentId: string, worker: string, next: 'working' | 'needs_human' | 'review' | 'done', result: string | null = null) =>
    run({ type: 'work.status', conversationId: id, assignmentId, status: next, result }, asAgent(worker))
  const passChecks = (id: string, assignmentId: string) => {
    for (const check of group(id).checks) run({ type: 'work.check', conversationId: id, assignmentId, checkId: check.id, passed: true, evidence: 'ok' })
  }
  const say = (id: string, actor: Actor, text = 'Go with the flag.', replyTo: string | null = null, reply?: CommandContext['reply']) =>
    run({ type: 'message.send', conversationId: id, text, replyTo, recipientIds: [] }, actor, reply ? { reply } : {})
  return { run, invitePeer, add, asAgent, create, group, assign, status, passChecks, say,
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

  it('leaves the requester unknown when a Lead names nobody, rather than guessing', () => {
    const f = fixture(), lead = f.add('lead', 'lead', true)
    const id = f.create(f.asAgent(lead))
    expect(f.group(id).requesterId).toBeUndefined()
    expect(f.group(id).ledger).toEqual({ askedAt: 1_000 })
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

  it('keeps the requester to the Lead: a worker in the group cannot change it', () => {
    const f = fixture(), id = f.create(), worker = f.add('worker', id)
    expect(() => f.run({ type: 'conversation.requester', conversationId: id, personId: null }, f.asAgent(worker))).toThrow('coordinating lead')
  })

  it('opens a private conversation without a requester: private chats never count', () => {
    const f = fixture()
    const id = f.run(commandSchema.parse({ type: 'conversation.create', title: 'Chat', brief: '', checks: [], audience: { personIds: ['owner'] } })).result.conversationId as string
    expect(f.group(id).requesterId).toBeUndefined()
    expect(f.group(id).ledger).toBeUndefined()
    expect(() => f.run({ type: 'conversation.requester', conversationId: id, personId: 'owner' })).toThrow('chat only')
  })
})

describe('when a request ships', () => {
  it('records the first time its work is done', () => {
    const f = fixture(), id = f.create(), { worker, assignmentId } = f.assign(id)
    f.passChecks(id, assignmentId)
    f.at(9_000)
    f.status(id, assignmentId, worker, 'done', 'Merged https://github.com/o/r/pull/7')
    expect(f.group(id).ledger?.shippedAt).toBe(9_000)
  })

  it('keeps the first ship time when the same group finishes again', () => {
    const f = fixture(), id = f.create()
    const first = f.assign(id)
    f.passChecks(id, first.assignmentId)
    f.at(9_000)
    f.status(id, first.assignmentId, first.worker, 'done', 'Merged')
    f.run({ type: 'work.define', conversationId: id, brief: 'More', checks })
    const second = f.assign(id, first.worker)
    f.passChecks(id, second.assignmentId)
    f.at(20_000)
    f.status(id, second.assignmentId, second.worker, 'done', 'Merged again')
    expect(f.group(id).ledger?.shippedAt).toBe(9_000)
  })
})

describe('when the Lead records a merge', () => {
  // Tuesday 2026-10-27 12:00 UTC.
  const NOW = Date.UTC(2026, 9, 27, 12), PR = 'https://github.com/o/r/pull/42'
  const merged = (conversationId: string, extra: Record<string, unknown> = {}) =>
    commandSchema.parse({ type: 'conversation.merged', conversationId, pullRequestUrl: PR, ...extra })
  /** A Lead, and a group it opened for the owner, at NOW. */
  const setup = () => {
    const f = fixture(), lead = f.add('lead', 'lead', true)
    f.at(NOW - DAY_MS)
    const id = f.create(f.asAgent(lead), { requesterId: 'owner' })
    f.at(NOW)
    return { f, lead: f.asAgent(lead), id }
  }
  const shippedFor = (f: ReturnType<typeof fixture>, personId: string) =>
    leaderboard({ state: f.state, groups: f.state.conversations, machines: [], projectId: 'lead', week: weekStart(NOW), now: NOW })
      .people.find(p => p.personId === personId)!

  it('ships the request when its PR merged, links the PR and says so in the group', () => {
    const { f, lead, id } = setup()
    const effects = f.run(merged(id), lead)
    expect(f.group(id).ledger?.shippedAt).toBe(NOW)
    expect(f.group(id).pullRequestUrls).toEqual([PR])
    expect(effects.messages.map(m => [m.conversationId, m.text])).toEqual([[id, `Merged ${PR}`]])
    expect(shippedFor(f, 'owner')).toMatchObject({ points: 3, shipped: { count: 1 } })
  })

  it('records an earlier merge time for a backfill', () => {
    const { f, lead, id } = setup()
    f.run(merged(id, { mergedAt: new Date(NOW - 5 * 3_600_000).toISOString() }), lead)
    expect(f.group(id).ledger?.shippedAt).toBe(NOW - 5 * 3_600_000)
  })

  it('still counts the request when its work is cancelled after the merge', () => {
    const { f, lead, id } = setup(), { assignmentId } = f.assign(id)
    f.run(merged(id), lead)
    f.at(NOW + 3_600_000)
    f.run({ type: 'work.cancel', conversationId: id, assignmentId, reason: 'Merged by hand' })
    expect(f.group(id).ledger?.shippedAt).toBe(NOW)
    expect(shippedFor(f, 'owner').shipped.count).toBe(1)
  })

  it('still counts the request when its attempt is lost after the merge', () => {
    const { f, lead, id } = setup(), { worker } = f.assign(id)
    f.run(merged(id), lead)
    f.at(NOW + 3_600_000)
    f.run({ type: 'agent.remove', agentId: worker })
    expect(f.group(id).assignment?.status).not.toBe('done')
    expect(shippedFor(f, 'owner').shipped.count).toBe(1)
  })

  it('keeps the merge as the ship time when the work is marked done later', () => {
    const { f, lead, id } = setup(), { worker, assignmentId } = f.assign(id)
    f.run(merged(id), lead)
    f.passChecks(id, assignmentId)
    f.at(NOW + 3_600_000)
    f.status(id, assignmentId, worker, 'done', `Merged ${PR}`)
    expect(f.group(id).ledger?.shippedAt).toBe(NOW)
  })

  it('moves the ship time back to the merge when Done was marked first', () => {
    const { f, lead, id } = setup(), { worker, assignmentId } = f.assign(id)
    f.passChecks(id, assignmentId)
    f.status(id, assignmentId, worker, 'done', 'Done')
    f.run(merged(id, { mergedAt: new Date(NOW - 3_600_000).toISOString() }), lead)
    expect(f.group(id).ledger?.shippedAt).toBe(NOW - 3_600_000)
  })

  it('keeps the first merge time when the same merge is recorded again', () => {
    const { f, lead, id } = setup()
    f.run(merged(id), lead)
    f.at(NOW + DAY_MS)
    expect(f.run(merged(id), lead).messages).toEqual([])
    expect(f.group(id).ledger?.shippedAt).toBe(NOW)
    expect(f.group(id).pullRequestUrls).toEqual([PR])
  })

  it('refuses a merge time in the future or older than the four weeks the board reads', () => {
    const { f, lead, id } = setup()
    expect(() => f.run(merged(id, { mergedAt: new Date(NOW + 60_000).toISOString() }), lead)).toThrow('four weeks')
    expect(() => f.run(merged(id, { mergedAt: new Date(NOW - 4 * WEEK_MS).toISOString() }), lead)).toThrow('four weeks')
    expect(f.group(id).ledger?.shippedAt).toBeUndefined()
  })

  it('takes only a GitHub pull request link', () => {
    const parse = (pullRequestUrl: string) => () => commandSchema.parse({ type: 'conversation.merged', conversationId: 'g', pullRequestUrl })
    expect(parse(PR)).not.toThrow()
    expect(parse('https://example.com/o/r/pull/1')).toThrow()
    expect(parse('https://github.com/o/r/issues/1')).toThrow()
  })

  it('keeps the record to the Lead and owners: a collaborator who reads the group cannot ship it', () => {
    const { f, id } = setup()
    f.invitePeer()
    expect(() => f.run(merged(id), peer)).toThrow('Lead or an owner')
    expect(f.group(id).ledger?.shippedAt).toBeUndefined()
    expect(f.group(id).pullRequestUrls).toBeUndefined()
  })

  it('takes the record from the Swarm and project owner', () => {
    const { f, id } = setup()
    f.run(merged(id), owner)
    expect(f.group(id).ledger?.shippedAt).toBe(NOW)
  })

  it('ships in the week of the merge when Done was marked the Sunday before', () => {
    const { f, lead, id } = setup(), { worker, assignmentId } = f.assign(id)
    // Sunday 2026-11-01 23:00 UTC, then Monday 2026-11-02 01:00 UTC: the next leaderboard week.
    const sunday = Date.UTC(2026, 10, 1, 23), monday = Date.UTC(2026, 10, 2, 1)
    f.passChecks(id, assignmentId)
    f.at(sunday)
    f.status(id, assignmentId, worker, 'done', 'Done')
    f.at(monday)
    f.run(merged(id), lead)
    expect(f.group(id).ledger?.shippedAt).toBe(monday)
    const board = (week: number) => leaderboard({ state: f.state, groups: f.state.conversations, machines: [], projectId: 'lead', week, now: monday })
    expect(board(weekStart(monday)).goal.thisWeek.shipped).toBe(1)
    expect(board(weekStart(sunday)).goal.thisWeek.shipped).toBe(0)
  })

  it('keeps the earliest of two merge records, whatever order they come in', () => {
    const { f, lead, id } = setup()
    f.run(merged(id, { mergedAt: new Date(NOW - 3_600_000).toISOString() }), lead)
    f.run(merged(id, { mergedAt: new Date(NOW - 2 * 3_600_000).toISOString() }), lead)
    expect(f.group(id).ledger?.shippedAt).toBe(NOW - 2 * 3_600_000)
    f.run(merged(id, { mergedAt: new Date(NOW - 3_600_000).toISOString() }), lead)
    expect(f.group(id).ledger?.shippedAt).toBe(NOW - 2 * 3_600_000)
  })

  it('keeps the merge as the ship time when Done came first and the work is cancelled later', () => {
    const { f, lead, id } = setup(), { worker, assignmentId } = f.assign(id)
    f.passChecks(id, assignmentId)
    f.at(NOW - DAY_MS + 3_600_000)
    f.status(id, assignmentId, worker, 'done', 'Done')
    f.at(NOW)
    f.run(merged(id), lead)
    f.run({ type: 'work.define', conversationId: id, brief: 'More', checks })
    const again = f.assign(id, worker)
    f.at(NOW + 3_600_000)
    f.run({ type: 'work.cancel', conversationId: id, assignmentId: again.assignmentId, reason: 'Not needed' })
    expect(f.group(id).ledger?.shippedAt).toBe(NOW)
    expect(shippedFor(f, 'owner').shipped.count).toBe(1)
  })

  it('keeps the record to the Lead: a worker in the group cannot ship it', () => {
    const { f, id } = setup(), worker = f.add('worker', id)
    expect(() => f.run(merged(id), f.asAgent(worker))).toThrow('coordinating lead')
  })

  it('refuses a review group and a private conversation: neither is a request', () => {
    const { f, lead, id } = setup()
    const review = f.create(lead, { reviewOf: id, title: 'Review', brief: 'Review it.' })
    expect(() => f.run(merged(review), lead)).toThrow('review group')
    const chat = f.run(commandSchema.parse({ type: 'conversation.create', title: 'Chat', brief: '', checks: [], audience: { personIds: ['owner'] } })).result.conversationId as string
    expect(() => f.run(merged(chat))).toThrow('chat only')
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

describe('other ways a person unblocks work: decisions, approvals and tags', () => {
  const HOUR = 3_600_000
  const decision = (conversationId: string, extra: Partial<DecisionTarget> = {}): DecisionTarget => ({ id: 'decision-1', personId: 'owner', conversationId,
    projectId: 'lead', askerAgentId: 'gone', question: 'Ship how?', options: ['Behind a flag', 'To everyone'], recommended: 0, answeredAt: null,
    createdAt: 2 * HOUR, assignmentId: null, ...extra })
  /** The project's Lead asks in its own conversation at [askedAt], returning what a reply to it carries. */
  const leadAsk = (f: ReturnType<typeof fixture>, askedAt = HOUR) => {
    const lead = f.add('lead', 'lead', true)
    f.at(askedAt)
    const asked = f.say('lead', f.asAgent(lead), 'Plan: three steps. Reply GO to start.').messages[0]!
    return { lead, reply: { id: asked.id, conversationId: 'lead', author: asked.author, createdAt: askedAt } }
  }
  const tagged = (f: ReturnType<typeof fixture>, id: string, text: string, openTags: CommandContext['openTags']) =>
    f.run({ type: 'message.send', conversationId: id, text, replyTo: null, recipientIds: [] }, owner, { openTags })

  it('credits a decision answer to the person asked, with how long it waited', () => {
    const f = fixture(), id = f.create()
    f.at(5 * HOUR)
    f.run({ type: 'decision.answer', decisionId: 'decision-1', choice: 0 }, owner, { decision: decision(id) })
    expect(f.group(id).ledger?.unblocks).toEqual([{ personId: 'owner', at: 5 * HOUR, waitedMs: 3 * HOUR, kind: 'decision', item: 'decision-1' }])
  })

  it('closes the wait a worker\'s needs-human decision belongs to, so a post after the answer counts nothing more', () => {
    const f = fixture(), id = f.create(), { worker, assignmentId } = f.assign(id)
    f.at(HOUR)
    f.status(id, assignmentId, worker, 'needs_human', 'Flag?')
    f.at(2 * HOUR)
    f.run({ type: 'decision.answer', decisionId: 'decision-1', choice: 0 }, owner, { decision: decision(id, { createdAt: HOUR, assignmentId }) })
    f.say(id, owner, 'Picked the flag.')
    expect(f.group(id).ledger?.unblocks).toEqual([expect.objectContaining({ kind: 'decision', waitedMs: HOUR })])
    expect(f.group(id).ledger?.waiting?.answeredAt).toBe(2 * HOUR)
  })

  it('closes the wait of a decision left to the PM, but credits the person nothing: they did not choose', () => {
    const f = fixture(), id = f.create(), { worker, assignmentId } = f.assign(id)
    f.at(HOUR)
    f.status(id, assignmentId, worker, 'needs_human', 'Flag?')
    f.at(2 * HOUR)
    f.run({ type: 'decision.answer', decisionId: 'decision-1', delegate: true }, owner, { decision: decision(id, { createdAt: HOUR, assignmentId }) })
    expect(f.group(id).ledger?.waiting?.answeredAt).toBe(2 * HOUR)
    expect(f.group(id).ledger?.unblocks ?? []).toEqual([])
  })

  it('counts a needs-human ask once when its person posts an answer before answering its decision', () => {
    const f = fixture(), id = f.create(), { worker, assignmentId } = f.assign(id)
    f.at(HOUR)
    f.status(id, assignmentId, worker, 'needs_human', 'Flag?')
    f.at(2 * HOUR)
    f.say(id, owner, 'Flag.')
    f.run({ type: 'decision.answer', decisionId: 'decision-1', choice: 0 }, owner, { decision: decision(id, { createdAt: HOUR, assignmentId }) })
    expect(f.group(id).ledger?.unblocks).toEqual([expect.objectContaining({ kind: 'needs_human' })])
  })

  it('leaves a wait open when the decision answered belongs to another attempt', () => {
    const f = fixture(), id = f.create(), { worker, assignmentId } = f.assign(id)
    f.status(id, assignmentId, worker, 'needs_human', 'Flag?')
    f.run({ type: 'decision.answer', decisionId: 'decision-1', choice: 0 }, owner, { decision: decision(id, { createdAt: 0, assignmentId: 'earlier' }) })
    expect(f.group(id).ledger?.waiting?.answeredAt).toBeUndefined()
  })

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
    const chat = f.run({ type: 'conversation.create', title: 'Me and PM', brief: '', checks: [], audience: { personIds: ['owner'] } }).result.conversationId as string
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

describe('the model behind each assignment, and its first review (roadmap, Dec: about 30% of work on cheaper models)', () => {
  const independent = [{ description: 'Works', independent: false }, { description: 'Independent review', independent: true }]
  /** Reads a check by its kind, so the order of the checks does not matter. */
  const verdict = (f: ReturnType<typeof fixture>, id: string, assignmentId: string, passed: boolean, isIndependent = true, actor: Actor = owner) => {
    const check = f.group(id).checks.find(c => c.independent === isIndependent)!
    f.run({ type: 'work.check', conversationId: id, assignmentId, checkId: check.id, passed, evidence: 'rev abc' }, actor)
  }

  it('records the engine and model each assignment runs on', () => {
    const f = fixture()
    f.at(5_000)
    const id = f.create(owner, { checks: independent })
    const { assignmentId } = f.assign(id)
    expect(f.group(id).ledger!.runs).toEqual([{ assignmentId, engine: 'claude', model: 'opus', effort: 'high', at: 5_000 }])
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
    expect(f.group(id).ledger!.runs).toEqual([{ assignmentId, engine: 'claude', model: 'moonshotai/kimi-k3', effort: 'high', grid: true, at: 1_000 }])
  })

  it('keeps the first verdict on an independent check as the assignment\'s first review, and ignores later and other checks', () => {
    const f = fixture()
    const id = f.create(owner, { checks: independent })
    const { assignmentId } = f.assign(id)
    verdict(f, id, assignmentId, true, false)
    expect(f.group(id).ledger!.runs![0]).not.toHaveProperty('firstReview')
    verdict(f, id, assignmentId, false)
    verdict(f, id, assignmentId, true)
    expect(f.group(id).ledger!.runs![0]).toMatchObject({ assignmentId, firstReview: false })
    // A new attempt is reviewed on its own.
    f.run({ type: 'work.cancel', conversationId: id, assignmentId, reason: 'Again.' })
    const second = f.assign(id)
    verdict(f, id, second.assignmentId, true)
    expect(f.group(id).ledger!.runs!.map(r => [r.assignmentId, r.firstReview])).toEqual([[assignmentId, false], [second.assignmentId, true]])
  })

  it('passes a first review only when every independent check passed its first verdict, and later repairs never rewrite a failure', () => {
    // Review of #1808: two independent checks, the first passed and the second failed, counted as a pass.
    const two = [{ description: 'Code review', independent: true }, { description: 'Security review', independent: true }]
    const f = fixture()
    const id = f.create(owner, { checks: two })
    const { assignmentId } = f.assign(id)
    const [code, security] = f.group(id).checks
    const check = (checkId: string, passed: boolean) =>
      f.run({ type: 'work.check', conversationId: id, assignmentId, checkId, passed, evidence: 'rev abc' })
    check(code!.id, true)
    // One check still waits for its verdict: the review is not over.
    expect(f.group(id).ledger!.runs![0]).not.toHaveProperty('firstReview')
    check(security!.id, false)
    check(security!.id, true)
    check(code!.id, false)
    check(code!.id, true)
    expect(f.group(id).ledger!.runs![0]).toMatchObject({ firstReview: false, firstVerdicts: { [code!.id]: true, [security!.id]: false } })
    const g = fixture()
    const both = g.create(owner, { checks: two })
    const attempt = g.assign(both).assignmentId
    for (const c of g.group(both).checks) g.run({ type: 'work.check', conversationId: both, assignmentId: attempt, checkId: c.id, passed: true, evidence: 'rev abc' })
    expect(g.group(both).ledger!.runs![0]).toMatchObject({ firstReview: true })
  })

  it('records each finished review verdict an agent gives, with the model it ran on, for the reviewer models\' points', () => {
    const f = fixture()
    f.at(7_000)
    const id = f.create(owner, { checks: independent })
    const { assignmentId } = f.assign(id)
    const reviewer = f.add('reviewer', id)
    f.state.agents.find(a => a.id === reviewer)!.configuration = { ...config, engine: 'codex', model: 'gpt-5.5', effort: 'medium' }
    verdict(f, id, assignmentId, false, true, f.asAgent(reviewer))
    // The same check passed again on the same attempt is the same review (full review of #2097).
    verdict(f, id, assignmentId, true, true, f.asAgent(reviewer))
    // A person's verdict, and one on a check that is not a review, are no model's review.
    verdict(f, id, assignmentId, true)
    verdict(f, id, assignmentId, true, false, f.asAgent(reviewer))
    expect(f.group(id).ledger!.reviews).toEqual([
      { week: weekStart(7_000), engine: 'codex', model: 'gpt-5.5', effort: 'medium', count: 1 },
    ])
    // A new attempt is reviewed anew.
    f.run({ type: 'work.cancel', conversationId: id, assignmentId, reason: 'Again.' })
    const second = f.assign(id)
    verdict(f, id, second.assignmentId, true, true, f.asAgent(reviewer))
    expect(f.group(id).ledger!.reviews![0]!.count).toBe(2)
  })

  it('counts every verdict exactly, however many a group gets in a week (review of #2097)', () => {
    const f = fixture()
    const id = f.create(owner, { checks: independent })
    const worker = f.add('worker', id), reviewer = f.add('reviewer', id)
    // 45 attempts, each reviewed once: more than the 20 attempts a group keeps.
    for (let i = 0; i < 45; i++) {
      const { assignmentId } = f.assign(id, worker)
      verdict(f, id, assignmentId, i % 2 === 0, true, f.asAgent(reviewer))
      f.run({ type: 'work.cancel', conversationId: id, assignmentId, reason: 'Again.' })
    }
    expect(f.group(id).ledger!.reviews).toEqual([{ week: weekStart(1_000), engine: 'claude', model: 'opus', effort: 'high', count: 45 }])
  })

  it('keeps review counts for the weeks the board reads, and drops older ones', () => {
    const f = fixture()
    const id = f.create(owner, { checks: independent })
    const worker = f.add('worker', id), reviewer = f.add('reviewer', id)
    const start = weekStart(Date.UTC(2026, 9, 26))
    // A new attempt reviewed each week.
    for (let back = 6; back >= 0; back--) {
      f.at(start - back * WEEK_MS + DAY_MS)
      const { assignmentId } = f.assign(id, worker)
      verdict(f, id, assignmentId, true, true, f.asAgent(reviewer))
      f.run({ type: 'work.cancel', conversationId: id, assignmentId, reason: 'Again.' })
    }
    expect(f.group(id).ledger!.reviews!.map(r => (start - r.week) / WEEK_MS)).toEqual([4, 3, 2, 1, 0])
  })

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
    f.passChecks(id, assignmentId)
    f.status(id, assignmentId, worker, 'done', 'Shipped at rev abc.')
    const shippedBy = { assignmentId, at: 5_000, engine: 'claude', model: 'opus', effort: 'high' }
    expect(f.group(id).ledger!.shippedBy).toEqual(shippedBy)
    // Reopened and worked again on another model: the ship stays the first attempt's.
    const other = f.add('other', id)
    f.state.agents.find(a => a.id === other)!.configuration = { ...config, model: 'sonnet' }
    f.at(7_000)
    f.assign(id, other)
    expect(f.group(id).ledger!.shippedBy).toEqual(shippedBy)
  })

  it('keeps who led the group and the attempt when it shipped, through a later lead and a later merge record (review of #2097)', () => {
    const f = fixture()
    const lead = f.add('lead', 'lead', true)
    const id = f.create(owner, { checks })
    expect(f.group(id).leadId).toBe(lead)
    f.at(1_000)
    const { worker, assignmentId } = f.assign(id)
    f.passChecks(id, assignmentId)
    f.status(id, assignmentId, worker, 'done', 'Shipped at rev abc.')
    const shippedBy = f.group(id).ledger!.shippedBy
    expect(f.group(id).ledger!.shippedLeadId).toBe(lead)
    f.group(id).leadId = 'someone-else'
    f.at(2_000)
    f.run({ type: 'conversation.merged', conversationId: id, pullRequestUrl: 'https://github.com/o/r/pull/7' })
    expect(f.group(id).ledger).toMatchObject({ shippedAt: 2_000, shippedLeadId: lead, shippedBy })
  })

  it('keeps the shipping attempt through a later assignment before the merge is recorded (review of #2097)', () => {
    const f = fixture()
    const id = f.create(owner, { checks })
    f.at(1_000)
    const { worker, assignmentId } = f.assign(id)
    f.passChecks(id, assignmentId)
    f.status(id, assignmentId, worker, 'done', 'Shipped at rev abc.')
    const other = f.add('other', id)
    f.state.agents.find(a => a.id === other)!.configuration = { ...config, model: 'sonnet' }
    f.at(1_500)
    f.assign(id, other)
    f.at(2_000)
    f.run({ type: 'conversation.merged', conversationId: id, pullRequestUrl: 'https://github.com/o/r/pull/7' })
    expect(f.group(id).ledger!.shippedBy).toMatchObject({ assignmentId, model: 'opus', at: 1_000 })
  })

  it('ships on the attempt that ran when the recorded merge happened', () => {
    const f = fixture()
    const id = f.create(owner, { checks })
    f.at(5_000)
    const first = f.assign(id)
    f.run({ type: 'work.cancel', conversationId: id, assignmentId: first.assignmentId, reason: 'Again.' })
    f.at(8_000)
    f.assign(id, f.add('second', id))
    f.at(9_000)
    f.run({ type: 'conversation.merged', conversationId: id, pullRequestUrl: 'https://github.com/o/r/pull/7', mergedAt: new Date(6_000).toISOString() })
    expect(f.group(id).ledger!.shippedBy).toMatchObject({ assignmentId: first.assignmentId, at: 5_000 })
  })

  it('takes the snapshot again when a merge recorded later moves the ship earlier than Done (review of #2097)', () => {
    const f = fixture()
    const lead = f.add('lead', 'lead', true)
    const id = f.create(owner, { checks })
    f.at(5_000)
    const a = f.assign(id)
    f.run({ type: 'work.cancel', conversationId: id, assignmentId: a.assignmentId, reason: 'Again.' })
    const other = f.add('other', id)
    f.state.agents.find(x => x.id === other)!.configuration = { ...config, model: 'sonnet' }
    f.at(8_000)
    const b = f.assign(id, other)
    f.at(8_500)
    f.passChecks(id, b.assignmentId)
    f.status(id, b.assignmentId, other, 'done', 'Shipped at rev abc.')
    expect(f.group(id).ledger!.shippedBy).toMatchObject({ assignmentId: b.assignmentId, model: 'sonnet' })
    f.group(id).leadId = 'someone-else'
    f.at(9_000)
    f.run({ type: 'conversation.merged', conversationId: id, pullRequestUrl: 'https://github.com/o/r/pull/7', mergedAt: new Date(6_000).toISOString() })
    // The attempt running at the merge, with the lead kept from the ship (no lead history is recorded).
    expect(f.group(id).ledger).toMatchObject({ shippedAt: 6_000, shippedBy: { assignmentId: a.assignmentId, model: 'opus', at: 5_000 },
      shippedLeadId: lead })
  })

  it('ships on the earliest attempt when the merge came before any attempt started', () => {
    const f = fixture()
    const id = f.create(owner, { checks })
    f.at(5_000)
    const { assignmentId } = f.assign(id)
    f.at(9_000)
    f.run({ type: 'conversation.merged', conversationId: id, pullRequestUrl: 'https://github.com/o/r/pull/7', mergedAt: new Date(4_000).toISOString() })
    expect(f.group(id).ledger).toMatchObject({ shippedAt: 4_000, shippedBy: { assignmentId, at: 5_000 } })
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
