import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import { PrismaClient } from '@prisma/client'
import Fastify, { type FastifyInstance } from 'fastify'
import type { AuthUser } from '../src/lib/ssoAuth.js'
import { SuperTabStore } from '../src/superTabs/store.js'
import { superTabRoutes } from '../src/routes/superTabs.js'
import { errorHandler } from '../src/middlewares/errorHandler.js'
import type { Command } from '../src/superTabs/commands.js'
import { nextMachineShareGrants } from '../src/lib/machineSharePolicy.js'

// A fresh loopback replica set, created here. This suite never reads DATABASE_URL or an existing database.
let replica: MongoMemoryReplSet
let db: PrismaClient
let store: SuperTabStore
let app: FastifyInstance
const owner: AuthUser = { sub: '100000000000000000000001', email: 'owner@example.com', autonomousEnv: 'prod', role: 'user' }
const peer: AuthUser = { sub: '100000000000000000000002', email: 'peer@example.com', autonomousEnv: 'prod', role: 'user' }
const host: AuthUser = { sub: '100000000000000000000003', email: 'host@example.com', autonomousEnv: 'prod', role: 'user' }
const config = { engine: 'codex', model: 'fixture-model', effort: 'high', contextWindow: 200000, engineVersion: 'fixture' }
const run = (tab: string, command: Command, user = owner, asAgentId?: string, operationId = randomUUID()) =>
  store.execute(user, tab, { operationId, command }, asAgentId)
async function fixture() {
  const tab = (await store.create(owner, randomUUID(), 'Pilot')).id
  const lead = (await run(tab, { type: 'agent.add', conversationId: 'lead', machineId: 'test-host', harnessId: randomUUID(),
    name: 'Lead', configuration: config, lead: true })).result.agentId as string
  return { tab, lead }
}
const message = (text: string): Command => ({ type: 'message.send', conversationId: 'lead', text, replyTo: null, recipientIds: [] })
async function invite(tab: string, role: 'collaborator' | 'viewer' = 'collaborator') {
  const invitation = await run(tab, { type: 'invite.create', email: peer.email, role, conversationId: 'lead' })
  await run(tab, { type: 'invite.accept', inviteId: invitation.result.inviteId as string }, peer)
}

beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ binary: { version: '7.0.24', downloadDir: join(tmpdir(), 'harness-super-tab-mongodb-binaries') },
    replSet: { count: 1, ip: '127.0.0.1', storageEngine: 'wiredTiger' } })
  const uri = replica.getUri(`super_tab_test_${randomUUID().replaceAll('-', '_')}`)
  await promisify(execFile)(join(process.cwd(), 'node_modules/.bin/prisma'), ['db', 'push', '--skip-generate'], {
    env: { ...process.env, DATABASE_URL: uri }, timeout: 60000,
  })
  db = new PrismaClient({ datasources: { db: { url: uri } } })
  store = new SuperTabStore(db)
  for (const user of [owner, peer, host]) await db.user.create({ data: { id: user.sub, externalId: `fixture-${user.sub}`,
    email: user.email, autonomousEnv: user.autonomousEnv } })
  await db.machine.create({ data: { machineId: 'test-host', userId: host.sub, apiKey: 'fixture-only', managerId: 'fixture',
    autonomousEnv: 'prod', authMode: 'remote' } })
  await db.machineShare.create({ data: { machineId: 'test-host', ownerId: host.sub, autonomousEnv: 'prod', emails: [owner.email, peer.email] } })
  app = Fastify()
  app.setErrorHandler(errorHandler)
  // External SSO is replaced with three fixture accounts; every permission/transaction below is real.
  app.addHook('onRequest', async (request, reply) => {
    const user = [owner, peer, host].find(u => `Bearer ${u.sub}` === request.headers.authorization)
    if (!user) return reply.code(401).send({ success: false })
    request.user = user
  })
  await app.register(superTabRoutes, { store })
  await app.ready()
})
afterAll(async () => {
  await app?.close()
  await db?.$disconnect()
  await replica?.stop()
})

describe('Super Tabs on a real Mongo replica set', () => {
  it('commits exactly one tab and message under concurrent retries and rejects reused operation IDs', async () => {
    const operationId = randomUUID()
    const created = await Promise.all(Array.from({ length: 5 }, () => store.create(owner, operationId, 'Concurrent')))
    expect(new Set(created.map(c => c.id)).size).toBe(1)
    await expect(store.create(owner, operationId, 'Different')).rejects.toMatchObject({ code: 'OPERATION_REUSED' })
    const { tab, lead } = await fixture()
    const sendId = randomUUID()
    const sends = await Promise.all(Array.from({ length: 5 }, () => run(tab, message('Exactly once.'), owner, undefined, sendId)))
    expect(new Set(sends.map(s => s.result.messageId)).size).toBe(1)
    expect(await db.superTabMessage.count({ where: { tabId: tab } })).toBe(1)
    expect(await store.deliveries(host, tab, lead)).toHaveLength(1)
    await expect(run(tab, message('Different'), owner, undefined, sendId)).rejects.toMatchObject({ code: 'OPERATION_REUSED' })
  })

  it('joins without machine access, permits viewers to leave, and denies stale access after removal', async () => {
    const { tab } = await fixture()
    await expect(store.read(peer, tab)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await invite(tab, 'viewer')
    expect((await store.read(peer, tab)).state.people).toHaveLength(2)
    await expect(run(tab, message('Run this.'), peer)).rejects.toMatchObject({ code: 'READ_ONLY' })
    const operationId = randomUUID()
    const leave: Command = { type: 'member.remove', userId: peer.sub }
    await run(tab, leave, peer, undefined, operationId)
    await run(tab, leave, peer, undefined, operationId)
    await expect(store.read(peer, tab)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(store.read({ ...owner, autonomousEnv: 'stag' }, tab)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('durably resumes a claim, never steals it on timeout, and does not resurrect revoked messages on rejoin', async () => {
    const { tab, lead } = await fixture()
    await invite(tab)
    await run(tab, message('Instruction from a collaborator.'), peer)
    const delivery = (await store.deliveries(host, tab, lead))[0]!
    const claimId = randomUUID()
    const first = await store.delivery(host, tab, lead, delivery.id, { type: 'claim', claimId })
    expect(first.delivery.status).toBe('claimed')
    // Simulate a backend restart: no in-memory object carries delivery ownership.
    const restarted = new SuperTabStore(db)
    expect((await restarted.delivery(host, tab, lead, delivery.id, { type: 'claim', claimId })).message!.text).toContain('collaborator')
    await expect(restarted.delivery(host, tab, lead, delivery.id, { type: 'claim', claimId: randomUUID() })).rejects.toMatchObject({ code: 'CLAIM_CONFLICT' })
    await run(tab, { type: 'member.remove', userId: peer.sub })
    await invite(tab)
    expect(await store.deliveries(host, tab, lead)).toHaveLength(0)
    await expect(store.delivery(host, tab, lead, delivery.id, { type: 'ack', claimId, receipt: 'receipt', uncertain: false })).rejects.toMatchObject({ code: 'DELIVERY_REVOKED' })
    expect((await store.messages(owner, tab, 'lead', {})).messages).toHaveLength(1)
  })

  it('allows one claim winner and preserves the original native receipt', async () => {
    const { tab, lead } = await fixture()
    await run(tab, message('One native turn.'))
    const delivery = (await store.deliveries(host, tab, lead))[0]!
    const claims = await Promise.allSettled([randomUUID(), randomUUID()].map(claimId => store.delivery(host, tab, lead, delivery.id, { type: 'claim', claimId })))
    expect(claims.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    const won = claims.find(r => r.status === 'fulfilled')!
    if (won.status !== 'fulfilled') throw new Error('No claim winner')
    const claimId = won.value.delivery.claimId!
    await store.delivery(host, tab, lead, delivery.id, { type: 'ack', claimId, receipt: 'native-turn-1', uncertain: false })
    await store.delivery(host, tab, lead, delivery.id, { type: 'ack', claimId, receipt: 'native-turn-1', uncertain: false })
    await expect(store.delivery(host, tab, lead, delivery.id, { type: 'ack', claimId, receipt: 'different', uncertain: false })).rejects.toMatchObject({ code: 'RECEIPT_CONFLICT' })
    expect(await store.deliveries(host, tab, lead)).toHaveLength(0)
  })

  it('serializes revocation against claims and exposes no pending instruction after removal', async () => {
    const { tab, lead } = await fixture()
    await invite(tab)
    await run(tab, message('Racing with removal.'), peer)
    const delivery = (await store.deliveries(host, tab, lead))[0]!
    const results = await Promise.allSettled([
      store.delivery(host, tab, lead, delivery.id, { type: 'claim', claimId: randomUUID() }),
      run(tab, { type: 'member.remove', userId: peer.sub }),
    ])
    expect(results[1]!.status).toBe('fulfilled')
    expect(await store.deliveries(host, tab, lead)).toHaveLength(0)
    expect((await db.superTabDelivery.findUnique({ where: { id: delivery.id } }))!.status).toBe('cancelled')
  })

  it('holds a cross-tab assignment until host-confirmed stop and retains the previous attempt', async () => {
    const one = await fixture()
    const two = await fixture()
    const session = randomUUID()
    const attach: Command = { type: 'agent.add', conversationId: 'lead', machineId: 'test-host', harnessId: session,
      name: 'Worker', configuration: config, lead: false }
    const worker = (await run(one.tab, attach)).result.agentId as string
    await run(two.tab, attach)
    const define: Command = { type: 'work.define', conversationId: 'lead', brief: 'Check the fixture.', checks: [{ description: 'Test passes.', independent: true }] }
    await run(one.tab, define); await run(two.tab, define)
    const assignmentId = (await run(one.tab, { type: 'work.assign', conversationId: 'lead', agentId: worker })).result.assignmentId as string
    await expect(run(two.tab, { type: 'work.assign', conversationId: 'lead', agentId: worker })).rejects.toMatchObject({ code: 'AGENT_BUSY' })
    await run(one.tab, { type: 'agent.remove', agentId: worker })
    await expect(store.stopped(owner, one.tab, assignmentId, 'forged')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await store.stopped(host, one.tab, assignmentId, 'native-stop-receipt')
    await run(one.tab, { type: 'work.status', conversationId: 'lead', assignmentId, status: 'stopped', result: null })
    expect(await db.superTabDelivery.count({ where: { tabId: one.tab, assignmentId, status: 'queued' } })).toBe(0)
    await run(two.tab, { type: 'work.assign', conversationId: 'lead', agentId: worker })
    await run(one.tab, define)
    expect((await db.superTabAttempt.findUnique({ where: { id: assignmentId } }))!.snapshot).toMatchObject({ assignment: { status: 'stopped', configuration: config } })
  })

  it('rejects unshared hosts and spoofed agent identities through the HTTP API', async () => {
    const { tab, lead } = await fixture()
    const headers = { authorization: `Bearer ${owner.sub}` }
    expect((await app.inject({ url: `/api/super-tabs/${tab}` })).statusCode).toBe(401)
    expect((await app.inject({ url: `/api/super-tabs/${tab}`, headers })).statusCode).toBe(200)
    expect((await app.inject({ url: `/api/super-tabs/${tab}?asAgentId=${lead}`, headers })).statusCode).toBe(403)
    const malformed = await app.inject({ method: 'POST', url: `/api/super-tabs/${tab}/commands`, headers,
      payload: { operationId: randomUUID(), command: { ...message('No spoofing.'), contributorId: owner.sub } } })
    expect(malformed.statusCode).toBe(400)
    await db.machine.create({ data: { machineId: 'private-host', userId: peer.sub, apiKey: 'private-fixture', managerId: 'fixture', autonomousEnv: 'prod' } })
    await expect(run(tab, { type: 'agent.add', conversationId: 'lead', machineId: 'private-host', harnessId: 'private', name: 'Private', configuration: config, lead: false })).rejects.toMatchObject({ code: 'HOST_REQUIRED' })
    const post = await app.inject({ method: 'POST', url: `/api/super-tabs/${tab}/commands`, headers,
      payload: { operationId: randomUUID(), command: message('A shared conversation.') } })
    expect(post.statusCode).toBe(200)
    const history = await app.inject({ url: `/api/super-tabs/${tab}/conversations/lead/messages`, headers })
    expect(history.json().data.messages[0].text).toBe('A shared conversation.')
  })

  it('rechecks the machine share at delivery even while the contributor remains in the tab', async () => {
    const { tab } = await fixture()
    await invite(tab)
    const agentId = (await run(tab, { type: 'agent.add', conversationId: 'lead', machineId: 'test-host', harnessId: randomUUID(),
      name: 'Peer worker', configuration: config, lead: false }, peer)).result.agentId as string
    await run(tab, { ...message('Only on an authorized machine.'), recipientIds: [agentId] } as Command)
    expect(await store.deliveries(host, tab, agentId)).toHaveLength(1)
    try {
      const before = await db.machineShare.findUniqueOrThrow({ where: { machineId: 'test-host' } })
      await db.machineShare.update({ where: { machineId: 'test-host' }, data: { emails: [owner.email],
        grantVersions: nextMachineShareGrants(before, [owner.email], null) } })
      expect((await store.read(peer, tab)).state.people).toHaveLength(2)
      await expect(store.deliveries(host, tab, agentId)).rejects.toMatchObject({ code: 'CONTRIBUTION_REVOKED' })
    } finally {
      const before = await db.machineShare.findUniqueOrThrow({ where: { machineId: 'test-host' } })
      await db.machineShare.update({ where: { machineId: 'test-host' }, data: { emails: [owner.email, peer.email],
        grantVersions: nextMachineShareGrants(before, [owner.email, peer.email], null) } })
    }
    // The host may have been offline throughout the revocation. A restored share
    // still cannot revive a contribution made under the earlier grant.
    await expect(store.deliveries(host, tab, agentId)).rejects.toMatchObject({ code: 'CONTRIBUTION_REVOKED' })
  })

  it('also withholds outgoing instructions from an agent whose machine grant was revoked', async () => {
    const { tab, lead } = await fixture()
    await invite(tab)
    const worker = (await run(tab, { type: 'agent.add', conversationId: 'lead', machineId: 'test-host', harnessId: randomUUID(),
      name: 'Peer worker', configuration: config, lead: false }, peer)).result.agentId as string
    await store.execute(host, tab, { operationId: randomUUID(), command: { ...message('Delegated before revocation.'), recipientIds: [worker] } as Command }, lead)
    const [delivery] = await store.deliveries(host, tab, worker)
    expect(delivery).toBeTruthy()
    const before = await db.machineShare.findUniqueOrThrow({ where: { machineId: 'test-host' } })
    try {
      await db.machineShare.update({ where: { machineId: 'test-host' }, data: { emails: [peer.email],
        grantVersions: nextMachineShareGrants(before, [peer.email], null) } })
      expect(await store.deliveries(host, tab, worker)).toEqual([])
      await expect(store.delivery(host, tab, worker, delivery!.id, { type: 'claim', claimId: randomUUID() })).rejects.toMatchObject({ code: 'DELIVERY_REVOKED' })
    } finally {
      const current = await db.machineShare.findUniqueOrThrow({ where: { machineId: 'test-host' } })
      await db.machineShare.update({ where: { machineId: 'test-host' }, data: { emails: [owner.email, peer.email],
        grantVersions: nextMachineShareGrants(current, [owner.email, peer.email], null) } })
    }
    expect(await store.deliveries(host, tab, worker)).toEqual([])
  })

  it('does not authorize a host through a contributor’s obsolete email address', async () => {
    const { tab, lead } = await fixture()
    await run(tab, message('Requires the current machine grant.'))
    try {
      await db.user.update({ where: { id: owner.sub }, data: { email: 'changed@example.net' } })
      await expect(store.deliveries(host, tab, lead)).rejects.toMatchObject({ code: 'CONTRIBUTION_REVOKED' })
    } finally {
      await db.user.update({ where: { id: owner.sub }, data: { email: owner.email } })
    }
  })
})
