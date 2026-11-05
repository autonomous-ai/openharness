import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import type { PrismaClient } from '@prisma/client'
import Fastify, { type FastifyInstance } from 'fastify'
import type { AuthUser } from '../src/lib/ssoAuth.js'
import { SuperTabStore } from '../src/superTabs/store.js'
import { superTabRoutes } from '../src/routes/superTabs.js'
import { errorHandler } from '../src/middlewares/errorHandler.js'
import type { Command } from '../src/superTabs/commands.js'
import { MAX_RULES_REVISIONS, SEED_RULES, type ProjectRules } from '../src/superTabs/policy.js'
import { currentRules } from '../src/superTabs/policyStore.js'
import { planDatabase, plan, profiled, reads } from './plans.test-support.js'

// Task #3393 (anh Dee's Swarm redesign, 11-05): a project's rules record, its revisions and who may change it, against real
// transactions. A fresh loopback replica set; never DATABASE_URL.
let replica: MongoMemoryReplSet
let db: PrismaClient
let store: SuperTabStore
let app: FastifyInstance
const owner: AuthUser = { sub: '100000000000000000000001', email: 'owner@example.com', autonomousEnv: 'prod', role: 'user' }
const peer: AuthUser = { sub: '100000000000000000000002', email: 'peer@example.com', autonomousEnv: 'prod', role: 'user' }
const host: AuthUser = { sub: '100000000000000000000003', email: 'host@example.com', autonomousEnv: 'prod', role: 'user' }
const config = { engine: 'codex', model: 'fixture-model', effort: 'high', contextWindow: 200000, engineVersion: 'fixture' }
const run = (tab: string, command: Command, user = owner, asAgentId?: string) =>
  store.execute(user, tab, { operationId: randomUUID(), command }, asAgentId)
async function swarm() {
  const tab = (await store.create(owner, randomUUID(), 'Pilot')).id
  const invitation = await run(tab, { type: 'invite.create', email: peer.email, role: 'collaborator', conversationId: 'lead' })
  await run(tab, { type: 'invite.accept', inviteId: invitation.result.inviteId as string }, peer)
  const lead = (await run(tab, { type: 'agent.add', conversationId: 'lead', machineId: 'test-host', harnessId: randomUUID(),
    name: 'Lead', configuration: config, lead: true })).result.agentId as string
  return { tab, lead }
}
const rules = (start: string): ProjectRules => ({ ...structuredClone(SEED_RULES), releaseWindow: { ...SEED_RULES.releaseWindow, start } })
const set = (baseRevision: number, value: ProjectRules, extra: Partial<Extract<Command, { type: 'rules.set' }>> = {}): Command =>
  ({ type: 'rules.set', projectId: 'lead', baseRevision, rules: value, summary: 'Releases start later', ...extra })
const get = (user: AuthUser, tab: string, asAgentId?: string) => app.inject({ method: 'GET',
  url: `/api/super-tabs/${tab}/projects/lead/rules${asAgentId ? `?asAgentId=${asAgentId}` : ''}`, headers: { authorization: `Bearer ${user.sub}` } })
const refusal = async (promise: Promise<unknown>) => { try { await promise } catch (error) { return error as { code: string; status: number; details?: unknown } } throw new Error('not refused') }

beforeAll(async () => {
  ({ replica, db } = await planDatabase('project_rules_test'))
  store = new SuperTabStore(db, () => Date.now())
  for (const user of [owner, peer, host]) await db.user.create({ data: { id: user.sub, externalId: `fixture-${user.sub}`,
    email: user.email, autonomousEnv: user.autonomousEnv } })
  await db.machine.create({ data: { machineId: 'test-host', userId: host.sub, apiKey: 'fixture-only', managerId: 'fixture',
    autonomousEnv: 'prod', authMode: 'remote' } })
  await db.machineShare.create({ data: { machineId: 'test-host', ownerId: host.sub, autonomousEnv: 'prod', emails: [owner.email, peer.email] } })
  app = Fastify()
  app.setErrorHandler(errorHandler)
  app.addHook('onRequest', async (request, reply) => {
    const user = [owner, peer, host].find(u => `Bearer ${u.sub}` === request.headers.authorization)
    if (!user) return reply.code(401).send({ success: false })
    request.user = user
  })
  await app.register(superTabRoutes, { store, github: null })
  await app.ready()
}, 120_000)
afterAll(async () => {
  await app?.close()
  await db?.$disconnect()
  await replica?.stop()
})

describe('a project\'s rules record', () => {
  it('reads the seed until the first save, then each saved revision with who, when, the diff and why', async () => {
    const { tab } = await swarm()
    const first = await get(peer, tab)
    expect(first.statusCode, first.body).toBe(200)
    expect(first.json().data).toEqual({ projectId: 'lead', revision: 0, rules: SEED_RULES, seeded: true, history: [] })
    expect((await run(tab, set(0, rules('10:00')))).result).toMatchObject({ projectId: 'lead', revision: 1 })
    const read = (await get(peer, tab)).json().data
    expect(read).toMatchObject({ revision: 1, rules: rules('10:00'), seeded: false })
    expect(read.history).toEqual([{ revision: 1, rules: rules('10:00'), summary: 'Releases start later',
      diff: [{ path: 'releaseWindow.start', before: '09:00', after: '10:00' }], writtenBy: { kind: 'person', id: owner.sub },
      askedBy: owner.sub, askedIn: null, at: expect.any(String) }])
    // A stale save is refused with the newest record, to merge.
    expect(await refusal(run(tab, set(0, rules('11:00')), peer))).toMatchObject({ code: 'RULES_STALE', status: 409, details: { revision: 1, rules: rules('10:00') } })
  })

  it('lets the PM save only with a person\'s own chat message, recording it', async () => {
    const { tab, lead } = await swarm()
    expect(await refusal(run(tab, set(0, rules('10:00')), host, lead))).toMatchObject({ code: 'RULES_ASKED_IN_REQUIRED', status: 400 })
    const own = await run(tab, { type: 'message.send', conversationId: 'lead', text: 'Status: all good.', replyTo: null, recipientIds: [] }, host, lead)
    const agentMessage = own.result.messageId as string
    expect(await refusal(run(tab, set(0, rules('10:00'), { askedIn: { conversationId: 'lead', messageId: agentMessage } }), host, lead)))
      .toMatchObject({ code: 'RULES_ASKED_IN_REQUIRED' })
    const ask = await run(tab, { type: 'message.send', conversationId: 'lead', text: 'Start releases at 10, please.', replyTo: null, recipientIds: [] }, peer)
    const messageId = ask.result.messageId as string
    await run(tab, set(0, rules('10:00'), { askedIn: { conversationId: 'lead', messageId } }), host, lead)
    expect((await get(peer, tab)).json().data.history[0]).toMatchObject({ writtenBy: { kind: 'agent', id: lead }, askedBy: peer.sub,
      askedIn: { conversationId: 'lead', messageId } })
    // The PM reads the record it saves on.
    expect((await get(host, tab, lead)).json().data).toMatchObject({ revision: 1 })
  })

  // The merge train (#3402) and the release schedule (#3405) read a project's rules from their workers.
  it('gives a worker the newest record, or the seed at revision 0', async () => {
    const { tab } = await swarm()
    expect(await currentRules(db, tab, 'lead')).toEqual({ revision: 0, rules: SEED_RULES })
    await run(tab, set(0, rules('10:00')))
    expect(await currentRules(db, tab, 'lead')).toEqual({ revision: 1, rules: rules('10:00') })
  })

  it('keeps one of two saves on the same revision, refusing the other', async () => {
    const { tab } = await swarm()
    const outcomes = await Promise.allSettled([run(tab, set(0, rules('10:00'))), run(tab, set(0, rules('11:00')), peer)])
    expect(outcomes.filter(o => o.status === 'fulfilled')).toHaveLength(1)
    expect((outcomes.find(o => o.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({ code: 'RULES_STALE' })
    expect(await db.superTabProjectRules.count({ where: { tabId: tab } })).toBe(1)
  })

  it('keeps the newest 50 revisions, read by its index, and goes with its project', async () => {
    const { tab } = await swarm()
    const created = await run(tab, { type: 'project.create', name: 'App', visibility: 'public', brief: '' })
    const app2 = created.result.projectId as string
    for (let i = 0; i < MAX_RULES_REVISIONS + 2; i++) {
      const start = `${String(10 + Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}`
      await run(tab, { ...set(i, rules(start)), projectId: app2 } as Command)
    }
    const kept = await db.superTabProjectRules.findMany({ where: { tabId: tab, projectId: app2 }, orderBy: { revision: 'asc' }, select: { revision: true } })
    expect(kept.map(k => k.revision)).toEqual(Array.from({ length: MAX_RULES_REVISIONS }, (_, i) => i + 3))
    const entries = await profiled(db, () => app.inject({ method: 'GET', url: `/api/super-tabs/${tab}/projects/${app2}/rules`,
      headers: { authorization: `Bearer ${owner.sub}` } }))
    const history = plan(reads(entries, 'SuperTabProjectRules', ['tabId', 'projectId']))
    expect(history.length).toBeGreaterThan(0)
    for (const row of history) {
      expect(row.plan).toContain('IXSCAN')
      expect(row.docsExamined).toBeLessThanOrEqual(row.returned)
    }
    await run(tab, { type: 'project.delete', projectId: app2 })
    expect(await db.superTabProjectRules.count({ where: { tabId: tab, projectId: app2 } })).toBe(0)
  }, 120_000)
})
