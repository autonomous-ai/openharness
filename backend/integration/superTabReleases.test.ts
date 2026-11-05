import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import { PrismaClient } from '@prisma/client'
import type { AuthUser } from '../src/lib/ssoAuth.js'
import { SuperTabStore } from '../src/superTabs/store.js'
import type { Command } from '../src/superTabs/commands.js'
import type { Conversation } from '../src/superTabs/model.js'

// Task #3405: a recorded merge joins its project's release list; the worker's settle marks the tasks a verified release carries
// released, and opens one release step for the Integrator inside the window, through the store and a fresh replica set.
let replica: MongoMemoryReplSet
let db: PrismaClient
const owner: AuthUser = { sub: '340500000000000000000001', email: 'dee@example.com', autonomousEnv: 'prod', role: 'user' }
const host: AuthUser = { sub: '340500000000000000000003', email: 'host@example.com', autonomousEnv: 'prod', role: 'user' }
const config = { engine: 'codex', model: 'fixture-model', effort: 'high', contextWindow: 200000, engineVersion: 'fixture' }
/** 11:00 in Vietnam on 6 November 2026, inside the release window. */
const T = Date.UTC(2026, 10, 6, 4, 0)
const MINUTE = 60_000

beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ binary: { version: '7.0.24', downloadDir: join(tmpdir(), 'harness-super-tab-mongodb-binaries') },
    replSet: { count: 1, ip: '127.0.0.1', storageEngine: 'wiredTiger' } })
  const uri = replica.getUri(`releases_test_${randomUUID().replaceAll('-', '_')}`)
  await promisify(execFile)(join(process.cwd(), 'node_modules/.bin/prisma'), ['db', 'push', '--skip-generate'], {
    env: { ...process.env, DATABASE_URL: uri }, timeout: 60000,
  })
  db = new PrismaClient({ datasources: { db: { url: uri } } })
  for (const user of [owner, host]) await db.user.create({ data: { id: user.sub, externalId: `fixture-${user.sub}`, email: user.email, autonomousEnv: user.autonomousEnv } })
  await db.machine.create({ data: { machineId: 'test-host', userId: host.sub, apiKey: 'fixture-only', managerId: 'fixture', autonomousEnv: 'prod', authMode: 'remote' } })
  await db.machineShare.create({ data: { machineId: 'test-host', ownerId: host.sub, autonomousEnv: 'prod', emails: [owner.email] } })
})
afterAll(async () => {
  await db?.$disconnect()
  await replica?.stop()
})

async function swarm() {
  let now = T
  const store = new SuperTabStore(db, () => now)
  const tab = (await store.create(owner, randomUUID(), 'Releases')).id
  const run = (command: Command, user = owner, asAgentId?: string) => store.execute(user, tab, { operationId: randomUUID(), command }, asAgentId)
  const invitation = await run({ type: 'invite.create', email: host.email, role: 'collaborator', conversationId: 'lead' })
  await run({ type: 'invite.accept', inviteId: invitation.result.inviteId as string }, host)
  await run({ type: 'machine.contribute', machineId: 'test-host', name: 'Mac', cwd: '/repo', engines: ['codex'], maxAgents: 6 }, host)
  const add = async (name: string, conversationId: string, extra: Record<string, unknown> = {}) => String((await run({ type: 'agent.add', conversationId,
    machineId: 'test-host', harnessId: randomUUID(), name, configuration: config, lead: false, ...extra } as Command)).result.agentId)
  const lead = await add('Coordinator', 'lead', { lead: true })
  const task = async (title: string) => String((await run({ type: 'conversation.create', title, brief: 'Build it.', checks: [] }, host, lead)).result.conversationId)
  const group = async (id: string) => (await db.swarmGroup.findUnique({ where: { tabId_key: { tabId: tab, key: id } } }))!.data as unknown as Conversation
  const ledger = async () => {
    const head = (await db.swarmHead.findUnique({ where: { id: `${tab}:head` } }))!.data as { projects: Array<{ releases?: { pending: unknown[]; steps?: Record<string, { groupId: string }> } }> }
    return head.projects[0]!.releases
  }
  return { store, tab, run, add, lead, task, group, ledger, clock: { set(at: number) { now = at } } }
}

describe('releases scheduled by the Swarm', () => {
  it('a recorded merge waits on the list until a verified release carries it, then the task is released', async () => {
    const s = await swarm()
    const shipIt = await s.task('Offline drafts')
    const url = 'https://github.com/example/app/pull/41'
    await s.run({ type: 'conversation.merged', conversationId: shipIt, pullRequestUrl: url, mergedAt: new Date(T - 30 * MINUTE).toISOString() }, host, s.lead)
    expect((await s.ledger())!.pending).toEqual([{ groupId: shipIt, url, mergedAt: T - 30 * MINUTE }])
    // After 18:00: the release shipped it, and no step opens.
    s.clock.set(T + 8 * 60 * MINUTE)
    const outcome = await s.store.settleReleases(s.tab, 'lead', { components: [{ groupId: shipIt, url, components: ['desktop'] }],
      releases: { desktop: { tag: 'v1.3.78_desktop', sha: 'd1', at: T - 5 * MINUTE, committedAt: T - 10 * MINUTE } } })
    expect(outcome).toMatchObject({ shipped: [shipIt], opened: null })
    expect((await s.group(shipIt)).released).toEqual({ at: T - 5 * MINUTE, tags: ['v1.3.78_desktop'] })
    expect((await s.ledger())!.pending).toEqual([])
  })

  it('opens one release step inside the window and tells the Integrator, and a second settle opens none', async () => {
    const s = await swarm()
    const integrator = await s.add('Shipper', 'lead', { roleName: 'Integrator' })
    const shipIt = await s.task('Board strip')
    const url = 'https://github.com/example/app/pull/42'
    await s.run({ type: 'conversation.merged', conversationId: shipIt, pullRequestUrl: url, mergedAt: new Date(T - MINUTE).toISOString() }, host, s.lead)
    const facts = { components: [{ groupId: shipIt, url, components: ['cli' as const] }], releases: {} }
    const outcome = (await s.store.settleReleases(s.tab, 'lead', facts))!
    expect(outcome.opened).toEqual(expect.any(String))
    const step = await s.group(outcome.opened!)
    expect(step).toMatchObject({ title: 'Release CLI', priority: 'P1', assignment: null })
    expect(step.agentIds).toContain(integrator)
    const rows = await db.superTabMessage.findMany({ where: { tabId: s.tab, conversationId: outcome.opened! } })
    expect(rows.map(r => r.recipientIds)).toEqual([[integrator]])
    expect(await db.superTabDelivery.count({ where: { tabId: s.tab, agentId: integrator, messageId: rows[0]!.id } })).toBe(1)
    s.clock.set(T + 5 * MINUTE)
    expect((await s.store.settleReleases(s.tab, 'lead', facts))!.opened).toBeNull()
    const groups = await db.swarmGroup.findMany({ where: { tabId: s.tab }, select: { data: true } })
    expect(groups.filter(g => (g.data as unknown as Conversation).title === 'Release CLI')).toHaveLength(1)
  })
})
