import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import type { Prisma, PrismaClient } from '@prisma/client'
import type { AuthUser } from '../src/lib/ssoAuth.js'
import { SuperTabStore } from '../src/superTabs/store.js'
import type { Command } from '../src/superTabs/commands.js'
import { listNamedIndexes } from '../src/superTabs/parts/indexed.js'
import { filterOf, planDatabase, profiled } from './plans.test-support.js'
import type { ProfileEntry } from './bench/profile.js'

// Ken's prod scan, 09:20 VN 2026-11-07 (task #4368): a POST command read 28.2 queries and 1,156 KB, and the whole-Swarm reads
// (every agent, machine, member, start and progress part) ran 1.4-1.5 times per command. A Swarm of prod's size here: 60
// machines, 60 agents, 200 conversations, with the GitHub reads prod's store runs before a command.
let replica: MongoMemoryReplSet
let db: PrismaClient
const owner: AuthUser = { sub: '430000000000000000000001', email: 'owner@example.com', autonomousEnv: 'prod', role: 'user' }
const config = { engine: 'codex', model: 'fixture-model', effort: 'high', contextWindow: 200000, engineVersion: 'fixture' }
const MACHINES = 60, OWN_MACHINES = 20, AGENTS = 60, GROUPS = 200

beforeAll(async () => {
  ({ replica, db } = await planDatabase('swarm_command_reads_test'))
  await db.user.create({ data: { id: owner.sub, externalId: `fixture-${owner.sub}`, email: owner.email, autonomousEnv: 'prod' } })
  await db.machine.createMany({ data: Array.from({ length: MACHINES }, (_, i) => ({ machineId: `mac-${i}`, userId: owner.sub, apiKey: `fixture-reads-${i}`,
    managerId: 'fixture', autonomousEnv: 'prod', authMode: 'remote' })) })
  await listNamedIndexes(db)
}, 120_000)
afterAll(async () => {
  await db?.$disconnect()
  await replica?.stop()
})

/** A prod-sized Swarm on a store with prod's GitHub reads, each answering at once. */
async function swarm() {
  const store = new SuperTabStore(db, Date.now, null, { pushOrigin: async () => 'clean', repositoryReach: async () => undefined,
    pullRequestFiles: async () => null,
    pullRequestReader: () => { throw new Error('No pull request is read here') } })
  const tab = (await store.create(owner, randomUUID(), 'Reads', 'public')).id
  const execute = (command: Command, asAgentId?: string) => store.execute(owner, tab, { operationId: randomUUID(), command }, asAgentId)
  // One person adds at most 20 machines: the rest are copies of the first, as their own rows.
  for (let i = 0; i < OWN_MACHINES; i++) {
    await execute({ type: 'machine.contribute', machineId: `mac-${i}`, name: `Mac ${i}`, cwd: '/repo', engines: ['codex'], maxAgents: 8 })
  }
  const machine = await db.swarmMachine.findFirstOrThrow({ where: { tabId: tab, key: { startsWith: 'mac-0' } } })
  const { id: _machineId, ...machineShape } = machine
  await db.swarmMachine.createMany({ data: Array.from({ length: MACHINES - OWN_MACHINES }, (_, i) => {
    const key = machine.key.replace('mac-0', `copy-mac-${i}`)
    return { ...machineShape, id: `${tab}:${key}`, key, data: JSON.parse(JSON.stringify(machine.data).replaceAll('mac-0', `copy-mac-${i}`)) } as Prisma.SwarmMachineCreateManyInput
  }) })
  const lead = String((await execute({ type: 'agent.add', conversationId: 'lead', machineId: 'mac-0', harnessId: randomUUID(), name: 'Lead',
    configuration: config, lead: true })).result.agentId)
  const agents: string[] = []
  for (let i = 1; i < AGENTS; i++) {
    agents.push(String((await execute({ type: 'agent.add', conversationId: 'lead', machineId: `mac-${i % OWN_MACHINES}`, harnessId: randomUUID(), name: `Agent ${i}`,
      configuration: config, lead: false })).result.agentId))
  }
  const task = async (title: string) => String((await execute({ type: 'conversation.create', title, checks: [],
    task: { goal: `${title}.`, changes: 'The change.', constraints: 'None.', owns: ['backend/a.ts'] } })).result.conversationId)
  const group = await task('Seed')
  // The rest copied from it, as their own rows: a third of them dormant, as on prod.
  const part = await db.swarmGroup.findFirstOrThrow({ where: { tabId: tab, key: group } })
  const { id: _id, ...shape } = part
  const brief = 'Implement it. '.repeat(300)
  const rows = Array.from({ length: GROUPS - 1 }, (_, i) => {
    const key = `copy-${i}`, dormant = i % 3 === 0
    return { ...shape, id: `${tab}:group:${key}`, key, dormant, data: { ...part.data as object, id: key, title: `Copy ${i}`, brief, ...dormant ? { dormant: true } : {} } } as Prisma.SwarmGroupCreateManyInput
  })
  await db.swarmGroup.createMany({ data: rows })
  return { store, tab, execute, lead, agents, task }
}

/** A whole-Swarm read: a read of one of a Swarm's part collections that names no part and examines its documents. A listing
 *  served by an index alone examines none. */
const PART_COLLECTIONS = ['SwarmAgent', 'SwarmMachine', 'SwarmMember', 'SwarmStart', 'SwarmProgress', 'SwarmGroup']
const NAMES = ['_id', 'key', 'agentId', 'agentIds', 'projectId', 'executionMachineId', 'machineId', 'changedAt', 'readAt']
function wholeReads(entries: ProfileEntry[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const entry of entries) {
    const collection = entry.ns.slice(entry.ns.indexOf('.') + 1)
    if (!PART_COLLECTIONS.includes(collection) || !['query', 'command'].includes(entry.op) || !entry.docsExamined) continue
    const filter = JSON.stringify(filterOf(entry) ?? null)
    if (!filter.includes('tabId') || NAMES.some(name => filter.includes(`"${name}"`) || filter.includes(`"$${name}"`))) continue
    out[collection] = (out[collection] ?? 0) + 1
  }
  return out
}
/** What one command read: its queries, the KB Mongo sent back, and its whole-Swarm reads by collection. */
const measured = (entries: ProfileEntry[]) => {
  const reads = entries.filter(e => !e.ns.endsWith('.$cmd') && !e.ns.includes('system.') && ['query', 'command', 'getmore'].includes(e.op))
  return { queries: reads.length, kb: Math.round(reads.reduce((n, e) => n + (e.responseLength ?? 0), 0) / 1024), whole: wholeReads(entries) }
}

/** Each command's most queries and KB on this store, a little above what it read (the PR's numbers). What is left is each
 *  kind's listing, ~110 bytes a part, and the parts the command wrote: on prod, parts are larger and more. */
const BUDGET = {
  'conversation.create': { queries: 24, kb: 36 },
  'work.assign': { queries: 36, kb: 44 },
  'work.status': { queries: 22, kb: 36 },
  'work.status review': { queries: 36, kb: 52 },
  'post': { queries: 20, kb: 34 },
  'react': { queries: 22, kb: 34 },
  'dispatch pass': { queries: 12, kb: 32 },
} as const

describe('what a common command reads in a prod-sized Swarm (task #4368)', () => {
  let s: Awaited<ReturnType<typeof swarm>>
  let worker: string, conversationId = '', assignmentId = '', messageId = ''
  const seen: Record<string, ReturnType<typeof measured>> = {}
  const measure = async (name: keyof typeof BUDGET, run: () => Promise<unknown>) => {
    seen[name] = measured(await profiled(db, run))
    return seen[name]!
  }
  const within = (name: keyof typeof BUDGET) => {
    const read = seen[name]!
    expect({ name, whole: read.whole }).toEqual({ name, whole: {} })
    expect(read.queries, `${name} queries`).toBeLessThanOrEqual(BUDGET[name].queries)
    expect(read.kb, `${name} KB`).toBeLessThanOrEqual(BUDGET[name].kb)
  }

  beforeAll(async () => {
    s = await swarm()
    worker = s.agents[5]!
    // Once, so this server has read the Swarm as a busy one has.
    await s.task('Warm')
  }, 300_000)
  afterAll(() => { console.log(`[command reads] ${JSON.stringify(seen)}`) })

  it('conversation.create', async () => {
    await measure('conversation.create', async () => { conversationId = await s.task('Measured') })
    within('conversation.create')
  })
  it('work.assign', async () => {
    await measure('work.assign', () => s.execute({ type: 'work.assign', conversationId, agentId: worker }))
    assignmentId = ((await db.swarmGroup.findFirstOrThrow({ where: { tabId: s.tab, key: conversationId } })).data as { assignment: { id: string } }).assignment.id
    within('work.assign')
  })
  it('work.status', async () => {
    await measure('work.status', () => s.execute({ type: 'work.status', conversationId, assignmentId, status: 'working', result: 'On it.' } as Command, worker))
    within('work.status')
  })
  it('a post', async () => {
    await measure('post', async () => { messageId = String((await s.execute({ type: 'message.send', conversationId, text: 'hello', replyTo: null, recipientIds: [] } as Command, worker)).result.messageId) })
    within('post')
  })
  it('a reaction', async () => {
    await measure('react', () => s.execute({ type: 'message.react', conversationId, messageId, emoji: 'eyes', on: true } as Command))
    within('react')
  })
  it('a Ready, with its GitHub reads', async () => {
    await measure('work.status review', () => s.execute({ type: 'work.status', conversationId, assignmentId, status: 'review',
      result: 'Ready: https://github.com/example/repo/pull/1' } as Command, worker))
    within('work.status review')
  })
  it('the dispatch pass a write schedules', async () => {
    await measure('dispatch pass', () => s.store.dispatchCrew(s.tab))
    within('dispatch pass')
  })
})
