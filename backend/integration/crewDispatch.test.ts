import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import type { Prisma, PrismaClient } from '@prisma/client'
import type { AuthUser } from '../src/lib/ssoAuth.js'
import { SuperTabStore } from '../src/superTabs/store.js'
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
})
afterAll(async () => {
  await db?.$disconnect()
  await replica?.stop()
})

/** A Swarm with a PM and the crew [lanes] (name -> lane), and the tasks [owns] (title -> one owned path), in that order. */
async function swarm(lanes: Record<string, string | null>, owns: Record<string, string>) {
  const store = new SuperTabStore(db, () => NOW)
  const tab = (await store.create(owner, randomUUID(), 'Crew', 'public')).id
  const execute = (command: Command, asAgentId?: string) => store.execute(owner, tab, { operationId: randomUUID(), command }, asAgentId)
  const add = async (name: string, lead = false) => String((await execute({ type: 'agent.add', conversationId: 'lead', machineId: 'owner-mac',
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
  return { store, tab, pm, crew, tasks, execute, holders }
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

  it('leaves a project without crew to its PM', async () => {
    const s = await swarm({}, { Api: 'backend/src/a.ts' })
    await s.execute({ type: 'agent.add', conversationId: 'lead', machineId: 'owner-mac', harnessId: randomUUID(), name: 'Plain', configuration: config, lead: false })
    expect(await s.store.dispatchCrew(s.tab)).toMatchObject({ assigned: 0 })
    expect(await s.holders()).toEqual({ Api: null })
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
