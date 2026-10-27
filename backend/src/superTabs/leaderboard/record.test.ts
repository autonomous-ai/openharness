import { describe, expect, it } from 'vitest'
import { applyCommand, commandSchema, type Command, type CommandContext } from '../commands.js'
import { createSuperTab, type Actor, type AgentConfiguration, type Conversation } from '../model.js'
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
    expect(f.group(id).ledger?.unblocks).toEqual([{ personId: 'owner', at: 10_000 + 3 * 3_600_000, waitedMs: 3 * 3_600_000 }])
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
    f.say(id, peer, 'Flag.', asked.id, { id: asked.id, conversationId: id, author: asked.author })
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
