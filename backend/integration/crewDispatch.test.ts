import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import type { Prisma, PrismaClient } from '@prisma/client'
import type { AuthUser } from '../src/lib/ssoAuth.js'
import { DISPATCH_RETRY_MS, SuperTabStore } from '../src/superTabs/store.js'
import { noteChange, swarmTransaction } from '../src/superTabs/cache.js'
import type { Command } from '../src/superTabs/commands.js'
import type { Agent, Conversation } from '../src/superTabs/model.js'
import { planDatabase } from './plans.test-support.js'

// The Swarm hands the next task to a free crew member by itself (task #3400). A fresh loopback replica set; never DATABASE_URL.
let replica: MongoMemoryReplSet
let db: PrismaClient
const NOW = Date.parse('2026-11-05T15:00:00Z')
const owner: AuthUser = { sub: '410000000000000000000001', email: 'owner@example.com', autonomousEnv: 'prod', role: 'user' }
const config = { engine: 'claude', model: 'fixture-model', effort: 'high', contextWindow: 200000, engineVersion: 'fixture' }

beforeAll(async () => {
  ({ replica, db } = await planDatabase('crew_dispatch_test'))
  await db.user.create({ data: { id: owner.sub, externalId: `fixture-${owner.sub}`, email: owner.email, autonomousEnv: 'prod' } })
  await db.machine.create({ data: { machineId: 'owner-mac', userId: owner.sub, apiKey: 'fixture-owner-mac', managerId: 'fixture', autonomousEnv: 'prod', authMode: 'remote' } })
  await db.machine.create({ data: { machineId: 'team-mac', userId: owner.sub, apiKey: 'fixture-team-mac', managerId: 'fixture', autonomousEnv: 'prod', authMode: 'remote' } })
})
afterAll(async () => {
  await db?.$disconnect()
  await replica?.stop()
})

/** A Swarm with a PM and the crew [lanes] (name -> lane), and the tasks [owns] (title -> one owned path), in that order. */
async function swarm(lanes: Record<string, string | null>, owns: Record<string, string>, dispatch = false, pmMachine = 'owner-mac') {
  let clock = NOW
  const store = new SuperTabStore(db, () => clock, null, { dispatch })
  /** Moves this Swarm's server clock on. */
  const advance = (ms: number) => { clock += ms }
  const tab = (await store.create(owner, randomUUID(), 'Crew', 'public')).id
  const execute = (command: Command, asAgentId?: string) => store.execute(owner, tab, { operationId: randomUUID(), command }, asAgentId)
  const add = async (name: string, lead = false) => String((await execute({ type: 'agent.add', conversationId: 'lead', machineId: lead ? pmMachine : 'owner-mac',
    harnessId: randomUUID(), name, configuration: config, lead })).result.agentId)
  const pm = await add('PM', true)
  const crew: Record<string, string> = {}
  for (const [name, lane] of Object.entries(lanes)) {
    crew[name] = await add(name)
    // Marked as #3397's crew.add marks it, until that command lands.
    await editAgent(tab, crew[name]!, agent => ({ ...agent, crew: { role: 'Engineer', ...lane ? { lane } : {}, at: NOW, by: owner.sub } }))
  }
  const tasks: Record<string, string> = {}
  for (const [title, path] of Object.entries(owns)) {
    tasks[title] = String((await execute({ type: 'conversation.create', title, checks: [],
      task: { goal: `${title}.`, changes: 'The change.', constraints: 'None.', owns: [path] } })).result.conversationId)
  }
  /** Who holds each task now, by name, from what is stored. */
  const holders = async () => {
    const names = Object.fromEntries(Object.entries(crew).map(([name, id]) => [id, name]))
    return Object.fromEntries(await Promise.all(Object.entries(tasks).map(async ([title, id]) => {
      const group = await readGroup(tab, id)
      const holder = group.assignment && !['lost', 'stopped', 'cancelled'].includes(group.assignment.status) ? names[group.assignment.agentId] ?? group.assignment.agentId : null
      return [title, holder]
    })))
  }
  return { store, tab, pm, crew, tasks, execute, holders, advance }
}

/** Writes a part outside the store as every writer does (cacheOn.test-support.ts): a new version, and the Swarm's stamp moved. */
async function editAgent(tabId: string, agentId: string, edit: (agent: Agent) => Agent) {
  await swarmTransaction(db, async tx => {
    const row = await tx.swarmAgent.findUniqueOrThrow({ where: { tabId_key: { tabId, key: agentId } } })
    await tx.swarmAgent.update({ where: { id: row.id }, data: { version: row.version + 1, changedAt: new Date(),
      data: edit(row.data as unknown as Agent) as unknown as Prisma.InputJsonValue } })
    noteChange(tx, tabId, 'main')
  })
}
async function editGroup(tabId: string, groupId: string, edit: (group: Conversation) => Conversation) {
  await swarmTransaction(db, async tx => {
    const row = await tx.swarmGroup.findUniqueOrThrow({ where: { tabId_key: { tabId, key: groupId } } })
    await tx.swarmGroup.update({ where: { id: row.id }, data: { version: row.version + 1, changedAt: new Date(),
      data: edit(row.data as unknown as Conversation) as unknown as Prisma.InputJsonValue } })
    noteChange(tx, tabId, 'main')
  })
}
async function readGroup(tabId: string, groupId: string): Promise<Conversation> {
  return (await db.swarmGroup.findUniqueOrThrow({ where: { tabId_key: { tabId, key: groupId } } })).data as unknown as Conversation
}

describe('the crew dispatch pass', () => {
  it('hands a free member its pinned task first, then its lane\'s top task, as the PM, through work.assign', async () => {
    const s = await swarm({ Ash: 'backend', Birch: 'desktop' }, { Api: 'backend/src/a.ts', Store: 'backend/src/b.ts', Board: 'desktop/lib/c.dart' })
    await editGroup(s.tab, s.tasks.Store!, group => ({ ...group, pin: { agentId: s.crew.Ash!, why: 'ci', at: NOW } }))
    expect(await s.store.dispatchCrew(s.tab)).toMatchObject({ assigned: 2 })
    expect(await s.holders()).toEqual({ Api: null, Store: 'Ash', Board: 'Birch' })
    // The assignment is an ordinary one, made by the project's PM, and it cleared the pin.
    const store = await readGroup(s.tab, s.tasks.Store!)
    expect(store.pin).toBeUndefined()
    const notice = (await s.store.messages(owner, s.tab, s.tasks.Store!, {})).messages.find(m => m.author.id === s.pm)
    expect(notice).toBeDefined()
    // A second pass finds nobody free and changes nothing.
    expect(await s.store.dispatchCrew(s.tab)).toMatchObject({ assigned: 0 })
    expect(await s.holders()).toEqual({ Api: null, Store: 'Ash', Board: 'Birch' })
  })

  it('assigns once when two passes race, from two servers: one task to the member, never two, never one task twice', async () => {
    const s = await swarm({ Ash: 'backend' }, { Api: 'backend/src/a.ts', Store: 'backend/src/b.ts' })
    const other = new SuperTabStore(db, () => NOW)
    await Promise.all([s.store.dispatchCrew(s.tab), other.dispatchCrew(s.tab), s.store.dispatchCrew(s.tab)])
    expect(await s.holders()).toEqual({ Api: 'Ash', Store: null })

    const t = await swarm({ Cedar: 'backend', Dune: 'backend' }, { Api: 'backend/src/a.ts' })
    await Promise.all([t.store.dispatchCrew(t.tab), new SuperTabStore(db, () => NOW).dispatchCrew(t.tab)])
    const held = Object.values(await t.holders())
    expect(held).toHaveLength(1)
    expect(['Cedar', 'Dune']).toContain(held[0])
  })

  it('leaves never-assigned work to the PM route in a project without crew', async () => {
    const s = await swarm({}, { Api: 'backend/src/a.ts' })
    await s.execute({ type: 'agent.add', conversationId: 'lead', machineId: 'owner-mac', harnessId: randomUUID(), name: 'Plain', configuration: config, lead: false })
    expect(await s.store.dispatchCrew(s.tab)).toMatchObject({ assigned: 0 })
    expect(await s.holders()).toEqual({ Api: null })
  })

  it('assigns as a PM that runs in a Harness Team account, with no one\'s sign-in', async () => {
    const s = await swarm({ Ash: 'backend' }, { Api: 'backend/src/a.ts' })
    // The PM's machine becomes a Team account's: an ordinary sign-in may no longer speak as its agents (store.ts notTeamMachine).
    await db.machine.updateMany({ where: { machineId: 'owner-mac', userId: owner.sub }, data: { sessionKind: 'team' } })
    try {
      expect(await s.store.dispatchCrew(s.tab)).toMatchObject({ assigned: 1 })
      expect(await s.holders()).toEqual({ Api: 'Ash' })
    } finally {
      await db.machine.updateMany({ where: { machineId: 'owner-mac', userId: owner.sub }, data: { sessionKind: null } })
    }
  })

  it('runs by itself a second after a write that opens a task for a project worker', async () => {
    const s = await swarm({ Ash: 'backend' }, {}, true)
    const id = String((await s.execute({ type: 'conversation.create', title: 'Api', checks: [],
      task: { goal: 'Api.', changes: 'The change.', constraints: 'None.', owns: ['backend/src/a.ts'] } })).result.conversationId)
    await vi.waitFor(async () => expect((await readGroup(s.tab, id)).assignment?.agentId).toBe(s.crew.Ash), { timeout: 5_000, interval: 200 })

    // A progress note frees nobody: no pass is scheduled by it. Handing over for review schedules one.
    await vi.waitFor(() => expect(s.store.dispatchScheduled(s.tab)).toBe(false), { timeout: 5_000, interval: 100 })
    const assignmentId = (await readGroup(s.tab, id)).assignment!.id
    await s.execute({ type: 'work.status', conversationId: id, assignmentId, status: 'working', result: 'Halfway.' }, s.crew.Ash)
    expect(s.store.dispatchScheduled(s.tab)).toBe(false)
    await s.execute({ type: 'work.status', conversationId: id, assignmentId, status: 'review', result: 'Ready at abc1234.' }, s.crew.Ash)
    // Nothing waits to be handed out: the pass would find nothing, and its whole-Swarm read is not taken (#3661).
    expect(s.store.dispatchScheduled(s.tab)).toBe(false)
    // A task for the member its Ready freed: one pass.
    await s.execute({ type: 'conversation.create', title: 'Web', checks: [],
      task: { goal: 'Web.', changes: 'The change.', constraints: 'None.', owns: ['backend/src/b.ts'] } })
    expect(s.store.dispatchScheduled(s.tab)).toBe(true)

    // Every worker busy: a new task waits for the sweep, and no write schedules a pass (#3661).
    const busy = await swarm({ Ash: 'backend' }, { Api: 'backend/src/a.ts' }, true)
    await vi.waitFor(async () => expect(await busy.holders()).toEqual({ Api: 'Ash' }), { timeout: 5_000, interval: 200 })
    await vi.waitFor(() => expect(busy.store.dispatchScheduled(busy.tab)).toBe(false), { timeout: 5_000, interval: 100 })
    await busy.execute({ type: 'conversation.create', title: 'Web', checks: [],
      task: { goal: 'Web.', changes: 'The change.', constraints: 'None.', owns: ['backend/src/b.ts'] } })
    expect(busy.store.dispatchScheduled(busy.tab)).toBe(false)

    // With only a PM, no write schedules one.
    const plain = await swarm({}, {}, true)
    await plain.execute({ type: 'conversation.create', title: 'Api', checks: [],
      task: { goal: 'Api.', changes: 'The change.', constraints: 'None.', owns: ['backend/src/a.ts'] } })
    expect(plain.store.dispatchScheduled(plain.tab)).toBe(false)
  })

  it('automatically recovers lost work without any crew', async () => {
    const s = await swarm({}, { Api: 'backend/src/a.ts' }, true)
    const old = String((await s.execute({ type: 'agent.add', conversationId: 'lead', machineId: 'owner-mac', harnessId: randomUUID(), name: 'Old', configuration: config, lead: false })).result.agentId)
    const plain = String((await s.execute({ type: 'agent.add', conversationId: 'lead', machineId: 'owner-mac', harnessId: randomUUID(), name: 'Plain', configuration: config, lead: false })).result.agentId)
    const id = s.tasks.Api!
    await s.execute({ type: 'work.assign', conversationId: id, agentId: old })
    await editGroup(s.tab, id, group => ({ ...group, assignment: { ...group.assignment!, status: 'lost', lost: { reason: 'its session stopped', at: NOW } },
      lostAttempt: { id: group.assignment!.id, agentId: old } }))
    await s.execute({ type: 'work.queue', conversationId: id, after: null })
    await vi.waitFor(async () => expect((await readGroup(s.tab, id)).assignment?.agentId).toBe(plain), { timeout: 5_000, interval: 200 })
  })

  it('does not assign a worker stopped while the pass read GitHub', async () => {
    const s = await swarm({ Ash: 'backend' }, { Api: 'backend/src/a.ts' })
    const store = s.store as unknown as { pushOriginFor: (...args: unknown[]) => Promise<unknown> }
    vi.spyOn(store, 'pushOriginFor').mockImplementationOnce(async () => {
      await editAgent(s.tab, s.crew.Ash!, agent => ({ ...agent, workDecision: 'stop' }))
      return undefined
    })
    await s.store.dispatchCrew(s.tab)
    expect(await s.holders()).toEqual({ Api: null })
  })

  it('assigns nothing as a PM whose grant no longer holds, waits a little, and assigns once its access is back', async () => {
    const s = await swarm({ Ash: 'backend' }, { Api: 'backend/src/a.ts' })
    // The PM's machine row is gone (removed, or billing ended): the agent path refuses it (store.ts grantHolds).
    const row = await db.machine.findFirstOrThrow({ where: { machineId: 'owner-mac', userId: owner.sub } })
    await db.machine.delete({ where: { id: row.id } })
    try {
      const first = await s.store.dispatchCrew(s.tab)
      expect(first.assigned).toBe(0)
      expect(Object.keys(first.skipped)).toEqual(['HOST_UNAVAILABLE'])
      expect(await s.holders()).toEqual({ Api: null })
      // Its PM is not tried again at once, by this pass or the sweep's check.
      expect(await s.store.dispatchCrew(s.tab)).toEqual({ assigned: 0, skipped: {} })
    } finally {
      await db.machine.create({ data: { machineId: 'owner-mac', userId: owner.sub, apiKey: 'fixture-owner-mac', managerId: 'fixture', autonomousEnv: 'prod', authMode: 'remote' } })
    }
    // Its access is back, in the same round of the same task: the next try after the short wait assigns it.
    s.advance(DISPATCH_RETRY_MS)
    expect(await s.store.dispatchCrew(s.tab)).toMatchObject({ assigned: 1 })
    expect(await s.holders()).toEqual({ Api: 'Ash' })
  })

  it('never has a Team-account PM assign a member outside a Team account', async () => {
    const s = await swarm({ Ash: 'backend' }, { Api: 'backend/src/a.ts' }, false, 'team-mac')
    // The PM runs in a Harness Team account on its own machine (its record says so); Ash runs in the main account.
    await editAgent(s.tab, s.pm, agent => ({ ...agent, teamAccount: true }))
    expect(await s.store.dispatchCrew(s.tab)).toMatchObject({ assigned: 0 })
    expect(await s.holders()).toEqual({ Api: null })
  })

  it('assigns once the Swarm resumes, after a pause that came while the pass read GitHub', async () => {
    const s = await swarm({ Ash: 'backend' }, { Api: 'backend/src/a.ts' })
    const store = s.store as unknown as { pushOriginFor: (...args: unknown[]) => Promise<unknown> }
    vi.spyOn(store, 'pushOriginFor').mockImplementationOnce(async () => {
      await s.execute({ type: 'tab.pause', paused: true })
      return undefined
    })
    expect(await s.store.dispatchCrew(s.tab)).toMatchObject({ assigned: 0 })
    expect(await s.holders()).toEqual({ Api: null })
    // Resumed in the same round, with no time passing: the pause left nothing behind.
    await s.execute({ type: 'tab.pause', paused: false })
    expect(await s.store.dispatchCrew(s.tab)).toMatchObject({ assigned: 1 })
    expect(await s.holders()).toEqual({ Api: 'Ash' })
  })

  it('assigns within the short retry once the repository is approved, and not before it', async () => {
    const s = await swarm({ Ash: 'backend' }, { Api: 'backend/src/a.ts' })
    // Ash runs in a Team account, which reaches the repository only through the GitHub App (repositoryReach.ts).
    await editAgent(s.tab, s.crew.Ash!, agent => ({ ...agent, teamAccount: true }))
    const store = s.store as unknown as { repositoryReachFor: (...args: unknown[]) => Promise<unknown> }
    vi.spyOn(store, 'repositoryReachFor').mockResolvedValueOnce({ state: 'not-approved', repository: 'owner/repo' })
    const refused = await s.store.dispatchCrew(s.tab)
    expect(refused).toMatchObject({ assigned: 0, skipped: { REPOSITORY_UNREACHABLE: 1 } })
    // Approved now, in the same round. The pick waits its short retry, then goes.
    expect(await s.store.dispatchCrew(s.tab)).toEqual({ assigned: 0, skipped: {} })
    s.advance(DISPATCH_RETRY_MS)
    expect(await s.store.dispatchCrew(s.tab)).toMatchObject({ assigned: 1 })
    expect(await s.holders()).toEqual({ Api: 'Ash' })
  })

  it('does not assign a task postponed while the pass read GitHub', async () => {
    const s = await swarm({ Ash: 'backend' }, { Api: 'backend/src/a.ts' })
    // Between the pass's read and its write: a person moves the task to tomorrow.
    const store = s.store as unknown as { pushOriginFor: (...args: unknown[]) => Promise<unknown> }
    vi.spyOn(store, 'pushOriginFor').mockImplementationOnce(async () => {
      await s.execute({ type: 'work.queue', conversationId: s.tasks.Api!, notBefore: '2026-11-07', hold: { kind: 'requester' } })
      return undefined
    })
    await s.store.dispatchCrew(s.tab)
    expect(await s.holders()).toEqual({ Api: null })
  })

  it('assigns a task again after it was redefined, not the first round\'s receipt', async () => {
    const s = await swarm({ Ash: 'backend' }, { Api: 'backend/src/a.ts' })
    expect(await s.store.dispatchCrew(s.tab)).toMatchObject({ assigned: 1 })
    const first = (await readGroup(s.tab, s.tasks.Api!)).assignment!.id
    await s.execute({ type: 'work.status', conversationId: s.tasks.Api!, assignmentId: first, status: 'done', result: 'Shipped at abc1234.' }, s.crew.Ash)
    await s.execute({ type: 'work.define', conversationId: s.tasks.Api!, checks: [],
      task: { goal: 'Api, second round.', changes: 'More.', constraints: 'None.', owns: ['backend/src/a.ts'] } })
    expect(await s.store.dispatchCrew(s.tab)).toMatchObject({ assigned: 1 })
    const second = (await readGroup(s.tab, s.tasks.Api!)).assignment!
    expect(second.id).not.toBe(first)
    expect(second.status).toBe('working')
  })

  it('skips a task the member may not take (Team-written code, main account) and gives it its next one', async () => {
    const s = await swarm({ Ash: 'backend' }, { Api: 'backend/src/a.ts', Store: 'backend/src/b.ts' })
    // Team-written code goes only to a Team account's agent: Ash runs in the main account.
    await editGroup(s.tab, s.tasks.Api!, group => ({ ...group, teamWritten: true }))
    const done = await s.store.dispatchCrew(s.tab)
    expect(done.assigned).toBe(1)
    expect(await s.holders()).toEqual({ Api: null, Store: 'Ash' })
  })
})
