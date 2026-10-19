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
import { DEFAULT_ROUTING_POLICY } from '../src/superTabs/routingPolicy.js'

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
  it('resolves a reply beyond recent history without crossing conversation or membership boundaries', async () => {
    const { tab, lead } = await fixture()
    const question = (await run(tab, message('Should pending edits survive restart?'), host, lead)).result.messageId as string
    for (let i = 0; i < 101; i++) await run(tab, message(`Later update ${i}`), host, lead)
    expect((await store.messages(host, tab, 'lead', {}, lead)).messages.some(row => row.id === question)).toBe(false)
    const url = `/api/super-tabs/${tab}/conversations/lead/messages?asAgentId=${lead}&messageId=${question}`
    const headers = { authorization: `Bearer ${host.sub}` }
    const original = await app.inject({ url, headers })
    expect(original.statusCode).toBe(200)
    expect(original.json().data.messages).toMatchObject([{ id: question, text: 'Should pending edits survive restart?' }])
    expect(original.json().data.messages).toHaveLength(1)
    expect((await app.inject({ url: `${url}&before=100`, headers })).statusCode).toBe(400)
    const group = (await run(tab, { type: 'conversation.create', title: 'Other work', brief: '', checks: [] })).result.conversationId as string
    expect((await store.messages(host, tab, group, { messageId: question }, lead)).messages).toEqual([])
    expect((await app.inject({ url: `/api/super-tabs/${tab}/conversations/lead/messages?messageId=${question}`,
      headers: { authorization: `Bearer ${peer.sub}` } })).statusCode).toBe(403)
    await run(tab, { type: 'agent.remove', agentId: lead })
    const removed = await app.inject({ url, headers })
    expect(removed.statusCode).toBe(409)
    expect(removed.json().error.code).toBe('AGENT_UNAVAILABLE')
  })

  it('records native turns once, in order, with verified source metadata and no input echo', async () => {
    const { tab, lead } = await fixture()
    await invite(tab)
    const request = { operationId: randomUUID(), conversationId: 'lead', agentId: lead }
    const { contextId } = await store.native.open(peer, tab, request)
    expect(await store.native.open(peer, tab, request)).toEqual({ contextId })
    await expect(store.native.read(peer, tab, contextId)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(await store.native.read(host, tab, contextId)).toMatchObject({ agentId: lead, machineId: 'test-host',
      operator: { id: peer.sub, kind: 'person' }, lastEventId: null })
    const prompt = { turnId: randomUUID(), kind: 'prompt' as const, previousEventId: null,
      text: 'A native intervention', truncated: false, interrupted: false }
    await expect(store.native.append(owner, tab, contextId, prompt)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    const posted = await Promise.all(Array.from({ length: 3 }, () => store.native.append(host, tab, contextId, prompt)))
    expect(posted[1]).toEqual(posted[0])
    await expect(store.native.append(host, tab, contextId, { ...prompt, text: 'Changed content' })).rejects.toMatchObject({ code: 'OPERATION_REUSED' })
    const first = posted[0] as { eventId: string }
    const answer = { ...prompt, kind: 'answer' as const, text: 'A native answer', interrupted: true }
    await expect(store.native.append(host, tab, contextId, answer)).rejects.toMatchObject({ code: 'NATIVE_ORDER_CHANGED' })
    await expect(store.native.append(host, tab, contextId, { ...answer, turnId: randomUUID(), previousEventId: first.eventId }))
      .rejects.toMatchObject({ code: 'NATIVE_PROMPT_MISSING' })
    const second = await store.native.append(host, tab, contextId, { ...answer, previousEventId: first.eventId })
    expect(await store.native.append(host, tab, contextId, prompt)).toEqual(first)
    const rows = (await store.messages(owner, tab, 'lead', {})).messages
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ text: prompt.text, author: { kind: 'agent', id: lead },
      source: { kind: 'native', phase: 'prompt', operator: { id: peer.sub, kind: 'person' } } })
    expect(rows[1]).toMatchObject({ replyTo: first.eventId, text: answer.text, source: { interrupted: true, phase: 'answer' } })
    expect(rows[0]!.source).not.toHaveProperty('contextId')
    expect(rows[1]!.sequence).toBeGreaterThan(rows[0]!.sequence)
    expect((await store.native.read(host, tab, contextId)).lastEventId).toBe((second as { eventId: string }).eventId)
    expect(await store.deliveries(host, tab, lead)).toEqual([])
    const forged = await app.inject({ method: 'POST', url: `/api/super-tabs/${tab}/native/${contextId}`,
      headers: { authorization: `Bearer ${host.sub}` }, payload: { ...prompt, operator: { id: owner.sub } } })
    expect(forged.statusCode).toBe(400)
  })

  it('keeps native observations in the chosen group and informs its lead without reviving a withdrawn context', async () => {
    const { tab, lead } = await fixture()
    const group = (await run(tab, { type: 'conversation.create', title: 'Implementation', brief: '', checks: [] })).result.conversationId as string
    const worker = (await run(tab, { type: 'agent.add', conversationId: group, machineId: 'test-host', harnessId: randomUUID(),
      name: 'Builder', configuration: config, lead: false })).result.agentId as string
    const request = { operationId: randomUUID(), conversationId: group, agentId: worker }
    const { contextId } = await store.native.open(owner, tab, request)
    await expect(store.native.open(owner, tab, { ...request, conversationId: 'lead' })).rejects.toMatchObject({ code: 'AGENT_UNAVAILABLE' })
    const event = { turnId: randomUUID(), kind: 'prompt' as const, previousEventId: null,
      text: 'Change this implementation', truncated: false, interrupted: false }
    const receipt = await store.native.append(host, tab, contextId, event) as { eventId: string }
    expect((await store.messages(owner, tab, 'lead', {})).messages).toHaveLength(0)
    expect((await store.messages(owner, tab, group, {})).messages).toHaveLength(1)
    expect(await store.deliveries(host, tab, worker)).toEqual([])
    const notifications = await store.deliveries(host, tab, lead)
    expect(notifications).toHaveLength(1)
    expect(notifications[0]).toMatchObject({ conversationId: group, nativeContextId: contextId, messageId: receipt.eventId })
    await run(tab, { type: 'conversation.agent', conversationId: group, agentId: worker, present: false, lead: false })
    await run(tab, { type: 'conversation.agent', conversationId: group, agentId: worker, present: true, lead: false })
    await expect(store.native.read(host, tab, contextId)).rejects.toMatchObject({ code: 'NATIVE_CONTEXT_REVOKED' })
    await expect(store.native.open(owner, tab, request)).rejects.toMatchObject({ code: 'NATIVE_CONTEXT_REVOKED' })
    expect(await store.deliveries(host, tab, lead)).toEqual([])
    expect((await db.superTabDelivery.findUnique({ where: { id: notifications[0]!.id } }))!.status).toBe('cancelled')
    expect(await store.native.open(owner, tab, { ...request, operationId: randomUUID() })).not.toEqual({ contextId })
  })

  it('requires machine control as well as collaboration and fences removal, re-invitation and changed machine grants', async () => {
    const { tab, lead } = await fixture()
    await invite(tab, 'viewer')
    const request = { operationId: randomUUID(), conversationId: 'lead', agentId: lead }
    await expect(store.native.open(peer, tab, request)).rejects.toMatchObject({ code: 'READ_ONLY' })
    await run(tab, { type: 'member.remove', userId: peer.sub })
    await invite(tab)
    const { contextId } = await store.native.open(peer, tab, request)
    const event = { turnId: randomUUID(), kind: 'gap' as const, previousEventId: null,
      text: 'Caller text must not impersonate a gap explanation', truncated: false, interrupted: false }
    await store.native.append(host, tab, contextId, event)
    expect((await store.messages(owner, tab, 'lead', {})).messages[0]!.text).toContain('Some terminal activity could not be recorded')
    const original = (await db.machineShare.findUnique({ where: { machineId: 'test-host' } }))!
    await db.machineShare.update({ where: { machineId: 'test-host' }, data: { emails: [owner.email],
      grantVersions: nextMachineShareGrants(original, [owner.email], null) } })
    try {
      await expect(store.native.open(peer, tab, { ...request, operationId: randomUUID() })).rejects.toMatchObject({ code: 'HOST_REQUIRED' })
      await expect(store.native.read(host, tab, contextId)).rejects.toMatchObject({ code: 'HOST_REQUIRED' })
      await db.machineShare.update({ where: { machineId: 'test-host' }, data: {
        emails: original.emails, grantVersions: nextMachineShareGrants({ ...original, emails: [owner.email] }, original.emails, null),
      } })
      await expect(store.native.read(host, tab, contextId)).rejects.toMatchObject({ code: 'NATIVE_CONTEXT_REVOKED' })
    } finally {
      const current = await db.machineShare.findUniqueOrThrow({ where: { machineId: 'test-host' } })
      await db.machineShare.update({ where: { machineId: 'test-host' }, data: { emails: original.emails,
        grantVersions: nextMachineShareGrants(current, original.emails, null) } })
    }
    await run(tab, { type: 'member.remove', userId: peer.sub })
    await invite(tab)
    await expect(store.native.read(host, tab, contextId)).rejects.toMatchObject({ code: 'NATIVE_CONTEXT_REVOKED' })
  })

  it('keeps an ordered configuration history, rejects stale observations and authorizes the execution host alone', async () => {
    const { tab, lead } = await fixture()
    await run(tab, { type: 'work.define', conversationId: 'lead', brief: 'A measured result', checks: [{ description: 'Verified evidence', independent: false }] })
    const assigned = await run(tab, { type: 'work.assign', conversationId: 'lead', agentId: lead })
    const before = (await store.read(owner, tab)).state.agents[0]!.configurationVersion!
    const command: Command = { type: 'agent.configuration', previousVersion: before,
      configuration: { ...config, model: 'observed-model', effort: 'max', contextWindow: null } }
    await expect(run(tab, command)).rejects.toMatchObject({ code: 'HOST_REQUIRED' })
    await expect(run(tab, command, peer, lead)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    const id = randomUUID()
    const first = await run(tab, command, host, lead, id)
    expect(await run(tab, command, host, lead, id)).toEqual(first)
    await expect(run(tab, command, host, lead)).rejects.toMatchObject({ code: 'STALE_CONFIGURATION' })
    const current = (await store.read(owner, tab)).state.agents[0]!
    await run(tab, { ...command, previousVersion: current.configurationVersion! }, host, lead)
    const records = await db.superTabConfiguration.findMany({ where: { tabId: tab, agentId: lead }, orderBy: { revision: 'asc' } })
    expect(records).toHaveLength(2)
    expect(records[0]!.configuration).toEqual(config)
    expect(records[1]).toMatchObject({ configuration: command.configuration, actorKey: `agent:${lead}`, assignmentIds: [assigned.result.assignmentId] })
    expect((await store.read(owner, tab)).state.conversations[0]!.assignment!.configuration).toEqual(config)
    const next = { ...command, previousVersion: current.configurationVersion!, configuration: config }
    const race = await Promise.allSettled([run(tab, next, host, lead), run(tab, { ...next, configuration: { ...config, effort: 'low' } }, host, lead)])
    expect(race.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect(await db.superTabConfiguration.count({ where: { tabId: tab } })).toBe(3)
    await run(tab, { type: 'agent.remove', agentId: lead })
    await expect(run(tab, next, host, lead)).rejects.toMatchObject({ code: 'AGENT_UNAVAILABLE' })
    expect(await db.superTabConfiguration.count({ where: { tabId: tab } })).toBe(3)
  })

  it('a withdrawn host can retire its receipt without regaining conversation access', async () => {
    const { tab, lead } = await fixture()
    await run(tab, message('Keep the execution receipt after removal.'))
    const first = (await store.deliveries(host, tab, lead))[0]!
    await store.delivery(host, tab, lead, first.id, { type: 'claim', claimId: 'claim' })
    await store.delivery(host, tab, lead, first.id, { type: 'ack', claimId: 'claim', receipt: 'unclear', uncertain: true })
    await run(tab, { type: 'agent.remove', agentId: lead })
    expect(await store.deliveryReceipt(host, tab, lead, first.id)).toEqual({ id: first.id, status: 'cancelled' })
    await expect(store.deliveries(host, tab, lead)).rejects.toMatchObject({ code: 'AGENT_UNAVAILABLE' })
    await expect(store.deliveryReceipt(peer, tab, lead, first.id)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    // Reassigning the machine does not transfer the former owner's receipts.
    await db.machine.update({ where: { machineId: 'test-host' }, data: { userId: peer.sub } })
    try {
      await expect(store.deliveryReceipt(peer, tab, lead, first.id)).rejects.toMatchObject({ code: 'FORBIDDEN' })
      await expect(store.deliveryReceipt(host, tab, lead, first.id)).rejects.toMatchObject({ code: 'HOST_UNAVAILABLE' })
    } finally {
      await db.machine.update({ where: { machineId: 'test-host' }, data: { userId: host.sub } })
    }
  })

  it('resolves uncertain input once, preserves native evidence, and fences late host acknowledgements', async () => {
    const { tab, lead } = await fixture()
    await invite(tab)
    await run(tab, message('Check the exact revision.'))
    const first = (await store.deliveries(host, tab, lead))[0]!
    const claimId = randomUUID()
    await store.delivery(host, tab, lead, first.id, { type: 'claim', claimId })
    await store.delivery(host, tab, lead, first.id, { type: 'ack', claimId, receipt: 'lost-native-ack', uncertain: true })
    const resend: Command = { type: 'delivery.resolve', deliveryId: first.id, resolution: 'resend' }
    await expect(run(tab, resend, host, lead)).rejects.toMatchObject({ code: 'HUMAN_REQUIRED' })
    const operationId = randomUUID()
    const repeated = await Promise.all(Array.from({ length: 3 }, () => run(tab, resend, peer, undefined, operationId)))
    expect(new Set(repeated.map(r => r.result.messageId)).size).toBe(1)
    const pending = await store.deliveries(host, tab, lead)
    expect(pending).toHaveLength(1)
    expect(pending[0]!.id).not.toBe(first.id)
    expect(await store.deliveryReceipt(host, tab, lead, first.id)).toEqual({ id: first.id, status: 'superseded' })
    expect((await db.superTabDelivery.findUnique({ where: { id: first.id } }))!.receipt).toBe('lost-native-ack')
    await expect(run(tab, resend, peer)).rejects.toMatchObject({ code: 'DELIVERY_RESOLVED' })
    await expect(store.delivery(host, tab, lead, first.id, { type: 'ack', claimId, receipt: 'late', uncertain: false }))
      .rejects.toMatchObject({ code: 'DELIVERY_RESOLVED' })
    const rows = (await store.messages(owner, tab, 'lead', {})).messages
    expect(rows).toHaveLength(2)
    expect(rows[1]!.text).toBe(rows[0]!.text)
    expect(rows[1]!.replyTo).toBe(rows[0]!.id)
    expect(rows[1]!.author).toMatchObject({ id: peer.sub, kind: 'person' })
    const second = pending[0]!
    await store.delivery(host, tab, lead, second.id, { type: 'claim', claimId: 'second-claim' })
    await store.delivery(host, tab, lead, second.id, { type: 'ack', claimId: 'second-claim', receipt: 'unclear', uncertain: true })
    await run(tab, { type: 'delivery.resolve', deliveryId: second.id, resolution: 'received' })
    expect(await store.deliveries(host, tab, lead)).toEqual([])
    expect(await store.deliveryReceipt(host, tab, lead, second.id)).toEqual({ id: second.id, status: 'confirmed' })
    await expect(store.deliveryReceipt(peer, tab, lead, second.id)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect((await store.messages(owner, tab, 'lead', {})).messages.at(-1)!.text).toContain('confirmed')
  })

  it('a viewer cannot resolve input and a changed machine grant cannot be used to resend it', async () => {
    const { tab, lead } = await fixture()
    await invite(tab, 'viewer')
    await run(tab, message('Do not replay after revocation.'))
    const delivery = (await store.deliveries(host, tab, lead))[0]!
    await store.delivery(host, tab, lead, delivery.id, { type: 'claim', claimId: 'claim' })
    await store.delivery(host, tab, lead, delivery.id, { type: 'ack', claimId: 'claim', receipt: 'unclear', uncertain: true })
    const command: Command = { type: 'delivery.resolve', deliveryId: delivery.id, resolution: 'resend' }
    await expect(run(tab, command, peer)).rejects.toMatchObject({ code: 'READ_ONLY' })
    const share = await db.machineShare.findUniqueOrThrow({ where: { machineId: 'test-host' } })
    await db.machineShare.update({ where: { machineId: 'test-host' }, data: { emails: [] } })
    try {
      await expect(run(tab, command)).rejects.toMatchObject({ code: 'CONTRIBUTION_REVOKED' })
      await run(tab, { ...command, resolution: 'cancel' })
      expect((await db.superTabDelivery.findUnique({ where: { id: delivery.id } }))!.status).toBe('cancelled')
    } finally {
      await db.machineShare.update({ where: { machineId: 'test-host' }, data: { emails: share.emails } })
    }
  })

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
    expect(await store.hostAssignments(host, 'test-host')).toContainEqual({ tabId: one.tab, assignmentId, harnessId: session })
    await expect(store.hostAssignments(owner, 'test-host')).rejects.toMatchObject({ code: 'HOST_UNAVAILABLE' })
    await expect(store.stopped(owner, one.tab, assignmentId, 'forged')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await store.stopped(host, one.tab, assignmentId, 'native-stop-receipt')
    expect((await store.read(owner, one.tab)).state.conversations[0]!.assignment?.status).toBe('stopped')
    await store.stopped(host, one.tab, assignmentId, 'native-stop-receipt')
    expect(await store.hostAssignments(host, 'test-host')).not.toContainEqual({ tabId: one.tab, assignmentId, harnessId: session })
    expect(await db.superTabDelivery.count({ where: { tabId: one.tab, assignmentId, status: 'queued' } })).toBe(0)
    await run(two.tab, { type: 'work.assign', conversationId: 'lead', agentId: worker })
    await run(one.tab, define)
    expect((await db.superTabAttempt.findUnique({ where: { id: assignmentId } }))!.snapshot).toMatchObject({ assignment: { status: 'stopped', configuration: config } })
  })

  it('tells the lead once when the host confirms its worker stopped', async () => {
    const { tab, lead } = await fixture()
    const worker = (await run(tab, { type: 'agent.add', conversationId: 'lead', machineId: 'test-host', harnessId: randomUUID(),
      name: 'Builder', configuration: config, lead: false })).result.agentId as string
    await run(tab, { type: 'work.define', conversationId: 'lead', brief: 'Build it.', checks: [{ description: 'Test passes.', independent: false }] })
    const assignmentId = (await run(tab, { type: 'work.assign', conversationId: 'lead', agentId: worker })).result.assignmentId as string
    const before = (await store.deliveries(host, tab, lead)).length
    await store.stopped(host, tab, assignmentId, 'native-stop-receipt')
    await store.stopped(host, tab, assignmentId, 'native-stop-receipt')
    const notices = (await store.messages(owner, tab, 'lead', {})).messages.filter(m => m.text.startsWith('Stopped'))
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({ author: { kind: 'agent', id: worker, name: 'Builder' },
      text: 'Stopped\n\nThe execution host confirmed that this harness stopped. If this work should continue, assign a new attempt.' })
    expect(await store.deliveries(host, tab, lead)).toHaveLength(before + 1)
    expect((await store.read(owner, tab)).state.conversations[0]!.lastMessageSequence).toBe(notices[0]!.sequence)
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

  it('derives session-only observer access from accepted membership and removes it with that membership', async () => {
    const { tab, lead } = await fixture()
    const state = (await store.read(owner, tab)).state
    const native = state.agents.find(a => a.id === lead)!.harnessId
    expect(await store.mayObserve(peer, tab, 'test-host', native, host.sub)).toBe(false)
    await invite(tab, 'viewer')
    expect(await store.mayObserve(peer, tab, 'test-host', native, host.sub)).toBe(true)
    expect(await store.mayObserve(peer, tab, 'test-host', 'another-session', host.sub)).toBe(false)
    const grants = (await store.hostTabs(host, 'test-host')).find(t => t.tabId === tab)
    expect(grants?.observers).toContainEqual({ email: peer.email, userId: peer.sub })
    await run(tab, { type: 'member.remove', userId: peer.sub })
    expect(await store.mayObserve(peer, tab, 'test-host', native, host.sub)).toBe(false)
    expect((await store.hostTabs(host, 'test-host')).find(t => t.tabId === tab)?.observers).not.toContainEqual({ email: peer.email, userId: peer.sub })
  })

  it('marks members of only archived groups inactive for host retention', async () => {
    const { tab, lead } = await fixture()
    const group = (await run(tab, { type: 'conversation.create', title: 'Done work', brief: '', checks: [] })).result.conversationId as string
    const worker = (await run(tab, { type: 'agent.add', conversationId: group, machineId: 'test-host', harnessId: randomUUID(),
      name: 'Builder', configuration: config, lead: false })).result.agentId as string
    const active = async () => Object.fromEntries((await store.hostTabs(host, 'test-host'))
      .filter(t => t.tabId === tab).map(t => [t.agent.id, t.active]))
    expect(await active()).toEqual({ [lead]: true, [worker]: true })
    await run(tab, { type: 'conversation.archive', conversationId: group, archived: true })
    expect(await active()).toEqual({ [lead]: true, [worker]: false })
  })

  it('serializes native start claims and fences a restored target-machine grant', async () => {
    const { tab } = await fixture()
    const request = { conversationId: 'lead', machineId: 'test-host', engine: 'claude', name: 'Builder', cwd: '/fixture/repo', worktree: true,
      requirements: { memoryBytes: 100, diskBytes: 200, maxCpuPercent: 80, tools: ['git'], devices: [], quotaRequired: false } }
    const intent = randomUUID()
    const starts = await Promise.all(Array.from({ length: 3 }, () => run(tab, { type: 'agent.start', request }, owner, undefined, intent)))
    const startId = starts[0]!.result.startId as string
    expect(new Set(starts.map(s => s.result.startId)).size).toBe(1)
    expect((await store.read(owner, tab)).state.starts).toHaveLength(1)
    const claims = await Promise.allSettled(Array.from({ length: 2 }, () => run(tab, { type: 'agent.startDispatch', startId })))
    expect(claims.filter(c => c.status === 'fulfilled')).toHaveLength(1)
    expect((await store.start(owner, tab, startId)).dispatched).toBe(true)
    const original = await db.machineShare.findUniqueOrThrow({ where: { machineId: 'test-host' } })
    try {
      await db.machineShare.update({ where: { machineId: 'test-host' }, data: { emails: [peer.email],
        grantVersions: nextMachineShareGrants(original, [peer.email], null) } })
      await expect(store.start(owner, tab, startId)).rejects.toMatchObject({ code: 'HOST_REQUIRED' })
    } finally {
      const current = await db.machineShare.findUniqueOrThrow({ where: { machineId: 'test-host' } })
      await db.machineShare.update({ where: { machineId: 'test-host' }, data: { emails: [owner.email, peer.email],
        grantVersions: nextMachineShareGrants(current, [owner.email, peer.email], null) } })
    }
    await expect(store.start(owner, tab, startId)).rejects.toMatchObject({ code: 'CONTRIBUTION_REVOKED' })
    await expect(run(tab, { type: 'agent.started', startId, harnessId: 'must-not-join', configuration: config })).rejects.toMatchObject({ code: 'CONTRIBUTION_REVOKED' })
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

  it('stores the account routing policy with revisions and merges the owner policy into each tab', async () => {
    const initial = await store.accountPolicy(owner)
    expect(initial).toEqual({ policy: DEFAULT_ROUTING_POLICY, revision: 0, isDefault: true })
    const saved = await store.saveAccountPolicy(owner, 0, { ...DEFAULT_ROUTING_POLICY, quotaReserve: 30 })
    expect(saved.revision).toBe(1)
    await expect(store.saveAccountPolicy(owner, 0, DEFAULT_ROUTING_POLICY)).rejects.toMatchObject({ code: 'REVISION_CHANGED' })
    const { tab, lead } = await fixture()
    await run(tab, { type: 'tab.routingPolicy', policy: { notes: 'Prefer remote-1.' } })
    await invite(tab, 'viewer')
    // A member reads the owner's policy, never their own account's.
    await store.saveAccountPolicy(peer, 0, { ...DEFAULT_ROUTING_POLICY, quotaReserve: 5 })
    for (const [user, asAgent] of [[owner, undefined], [peer, undefined], [host, lead]] as const) {
      const effective = await store.tabPolicy(user, tab, asAgent)
      expect(effective.policy.quotaReserve).toBe(30)
      expect(effective.policy.notes).toBe('Prefer remote-1.')
      expect(effective.overridden).toEqual(['notes'])
      // The owner's account value, so a field reset to the account default can show it.
      expect(effective.account).toEqual({ ...DEFAULT_ROUTING_POLICY, quotaReserve: 30 })
    }
    const response = await app.inject({ url: `/api/super-tabs/${tab}/routing-policy`, headers: { authorization: `Bearer ${peer.sub}` } })
    expect(response.statusCode).toBe(200)
    expect((await app.inject({ url: '/api/super-tabs/routing-policy', headers: { authorization: `Bearer ${owner.sub}` } })).statusCode).toBe(200)
  })

  it('lets exactly one of two concurrent saves win the same revision', async () => {
    const results = await Promise.allSettled([host, host].map((user, i) =>
      store.saveAccountPolicy(user, 0, { ...DEFAULT_ROUTING_POLICY, quotaReserve: 10 + i })))
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect((await store.accountPolicy(host)).revision).toBe(1)
  })

  it('records, supersedes and lets a person change a route decision; a closed one refuses', async () => {
    const { tab, lead } = await fixture()
    const decision = { assessment: { difficulty: 'medium', risk: 'low', why: 'A small API change.' },
      candidates: [
        { id: 'c0', kind: 'member', agentId: lead, machineId: 'test-host', engine: 'claude', model: 'sonnet', effort: 'medium', quality: 2, cost: 2, title: 'Lead · Claude sonnet medium · test-host', label: 'Member Lead' },
        { id: 'c1', kind: 'new', machineId: 'test-host', engine: 'claude', model: 'opus', effort: 'high', quality: 3, cost: 3, title: 'New agent · Claude opus high · test-host', label: 'New agent' },
      ], excluded: [{ title: 'New agent · Codex · test-host', reason: 'The selected agent engine is not installed on this machine.' }],
      floor: 2, notes: false, pick: 'c0', via: 'order', fallback: 'unsure', p: null, belowFloor: false, why: 'Jev unsure; first in the policy order.' }
    const first = (await run(tab, { type: 'route.record', conversationId: 'lead', decision } as Command, host, lead)).result.routeDecisionId as string
    const second = (await run(tab, { type: 'route.record', conversationId: 'lead', decision } as Command, host, lead)).result.routeDecisionId as string
    expect((await store.routeDecision(owner, tab, first)).outcome).toBe('superseded')
    const rows = (await store.messages(owner, tab, 'lead', {})).messages
    expect(rows.at(-1)).toMatchObject({ text: expect.stringContaining('"A small API change."'),
      source: { kind: 'route', decisionId: second, via: 'order', fallback: 'unsure', why: 'A small API change.' } })
    await expect(run(tab, { type: 'route.override', decisionId: first, candidateId: 'c1', reason: 'Needs Opus.' } as Command))
      .rejects.toMatchObject({ code: 'ROUTE_CLOSED' })
    await run(tab, { type: 'route.override', decisionId: second, candidateId: 'c1', reason: 'Needs Opus.' } as Command)
    expect((await store.routeDecision(owner, tab, second)).override).toMatchObject({ by: 'person', candidateId: 'c1' })
    expect((await store.deliveries(host, tab, lead)).length).toBeGreaterThan(0)
    await invite(tab, 'viewer')
    await expect(run(tab, { type: 'route.override', decisionId: second, candidateId: 'c0', reason: 'No.' } as Command, peer))
      .rejects.toMatchObject({ status: 403 })
    expect((await store.routeDecisions(owner, tab)).map(d => d.id)).toEqual([second, first])
    const response = await app.inject({ url: `/api/super-tabs/${tab}/route-decisions/${second}`, headers: { authorization: `Bearer ${peer.sub}` } })
    expect(response.statusCode).toBe(200)
  })

  it('corrects the log to the model that ran when the routed switch failed, and reads the times of one decision', async () => {
    const { tab, lead } = await fixture()
    const decision = { assessment: { difficulty: 'low', risk: 'low', why: 'Docs.' },
      candidates: [{ id: 'c0', kind: 'new', machineId: 'test-host', engine: 'claude', model: 'haiku', effort: 'auto', quality: 1, cost: 1, title: 'New agent', label: 'New agent' }],
      excluded: [], floor: 1, notes: false, pick: 'c0', via: 'only', p: null, belowFloor: false, why: 'Only candidate.' }
    const routeDecisionId = (await run(tab, { type: 'route.record', conversationId: 'lead', decision } as Command, host, lead)).result.routeDecisionId as string
    const request = { conversationId: 'lead', machineId: 'test-host', engine: 'claude', model: 'haiku', effort: 'auto', name: 'Builder', cwd: '/fixture/repo', worktree: false,
      requirements: { memoryBytes: 0, diskBytes: 0, maxCpuPercent: 100, tools: [], devices: [], quotaRequired: false } }
    const startId = (await run(tab, { type: 'agent.start', request, routeDecisionId } as Command, host, lead)).result.startId as string
    await expect(run(tab, { type: 'route.modelResult', decisionId: routeDecisionId, startId: 'other', model: 'sonnet', effort: 'auto' } as Command, host, lead))
      .rejects.toMatchObject({ code: 'ROUTE_MISMATCH' })
    const before = (await store.messages(owner, tab, 'lead', {})).messages.length
    await run(tab, { type: 'route.modelResult', decisionId: routeDecisionId, startId, model: 'sonnet', effort: 'auto' } as Command, host, lead)
    expect((await store.messages(owner, tab, 'lead', {})).messages).toHaveLength(before)
    const read = async () => (await app.inject({ url: `/api/super-tabs/${tab}/route-decisions/${routeDecisionId}`, headers: { authorization: `Bearer ${owner.sub}` } })).json().data
    expect(await read()).toMatchObject({ outcome: null, outcomeAt: null, createdAt: expect.any(String),
      final: { kind: 'new', startId, model: 'sonnet', effort: 'auto', requested: { model: 'haiku', effort: 'auto' } } })
  })

  it('names the failing field when a command is invalid', async () => {
    const { tab } = await fixture()
    const command = { type: 'agent.start', request: { conversationId: 'lead', machineId: 'test-host', engine: 'claude', name: 'Builder', cwd: '/fixture/repo', worktree: false } }
    const response = await app.inject({ method: 'POST', url: `/api/super-tabs/${tab}/commands`, headers: { authorization: `Bearer ${owner.sub}` },
      payload: { operationId: randomUUID(), command } })
    expect(response.statusCode).toBe(400)
    expect(response.json().error.message).toContain('command.request.requirements')
  })

  it('closes a linked decision with the assignment outcome', async () => {
    const { tab, lead } = await fixture()
    const group = (await run(tab, { type: 'conversation.create', title: 'Build', brief: 'Build it.', checks: [{ description: 'Tests pass', independent: false }] })).result.conversationId as string
    const worker = (await run(tab, { type: 'agent.add', conversationId: group, machineId: 'test-host', harnessId: randomUUID(),
      name: 'Builder', configuration: config, lead: false })).result.agentId as string
    const decision = { assessment: { difficulty: 'low', risk: 'low', why: 'Small.' },
      candidates: [{ id: 'c0', kind: 'member', agentId: worker, machineId: 'test-host', engine: 'claude', model: 'sonnet', effort: 'medium', quality: 2, cost: 2, title: 'Builder', label: 'Member Builder' }],
      excluded: [], floor: 1, notes: false, pick: 'c0', via: 'only', p: null, belowFloor: false, why: 'Only candidate.' }
    const routeDecisionId = (await run(tab, { type: 'route.record', conversationId: group, decision } as Command, host, lead)).result.routeDecisionId as string
    const assignmentId = (await run(tab, { type: 'work.assign', conversationId: group, agentId: worker, routeDecisionId } as Command, host, lead)).result.assignmentId as string
    expect(await store.routeDecision(owner, tab, routeDecisionId)).toMatchObject({ assignmentId, final: { kind: 'member', agentId: worker } })
    await store.stopped(host, tab, assignmentId, 'native-stop-receipt')
    expect((await store.routeDecision(owner, tab, routeDecisionId)).outcome).toBe('stopped')
  })

  it('keeps a decision open when the Lead stops its work to hand over to the candidate a person chose', async () => {
    const { tab, lead } = await fixture()
    const group = (await run(tab, { type: 'conversation.create', title: 'Build', brief: 'Build it.', checks: [{ description: 'Tests pass', independent: false }] })).result.conversationId as string
    const add = async (name: string) => (await run(tab, { type: 'agent.add', conversationId: group, machineId: 'test-host', harnessId: randomUUID(),
      name, configuration: config, lead: false })).result.agentId as string
    const picked = await add('Picked'), chosen = await add('Chosen')
    const candidate = (id: string, agentId: string, title: string) => ({ id, kind: 'member', agentId, machineId: 'test-host', engine: 'codex',
      model: 'fixture-model', effort: 'high', quality: 2, cost: 2, title, label: `Member ${title}` })
    const decision = { assessment: { difficulty: 'low', risk: 'low', why: 'Small.' },
      candidates: [candidate('c0', picked, 'Picked'), candidate('c1', chosen, 'Chosen')],
      excluded: [], floor: 1, notes: false, pick: 'c0', via: 'jev', p: 0.9, belowFloor: false, why: 'Jev chose Picked.' }
    const id = (await run(tab, { type: 'route.record', conversationId: group, decision } as Command, host, lead)).result.routeDecisionId as string
    const first = (await run(tab, { type: 'work.assign', conversationId: group, agentId: picked, routeDecisionId: id } as Command, host, lead)).result.assignmentId as string
    await run(tab, { type: 'route.override', decisionId: id, candidateId: 'c1', reason: 'Chosen knows this code.' } as Command)
    // The person's Change reaches the Lead as a message to act on.
    const rows = (await store.messages(owner, tab, group, {})).messages
    const change = rows.at(-1)!
    expect(change).toMatchObject({ source: { kind: 'route-override', by: 'person' }, text: expect.stringContaining('chose Chosen instead of Picked') })
    expect((await store.deliveries(host, tab, lead)).map(d => d.messageId)).toContain(change.id)
    // The first attempt is still running: no second link may overwrite its final.
    await expect(run(tab, { type: 'work.assign', conversationId: group, agentId: chosen, routeDecisionId: id } as Command, host, lead))
      .rejects.toMatchObject({ code: 'WORK_ACTIVE' })
    await store.stopped(host, tab, first, 'handover-stop-receipt')
    expect(await store.routeDecision(owner, tab, id)).toMatchObject({ outcome: null, assignmentId: null, final: null })
    const second = (await run(tab, { type: 'work.assign', conversationId: group, agentId: chosen, routeDecisionId: id } as Command, host, lead)).result.assignmentId as string
    expect(await store.routeDecision(owner, tab, id)).toMatchObject({ outcome: null, assignmentId: second, final: { kind: 'member', agentId: chosen } })
    const check = (await store.read(owner, tab)).state.conversations.find(c => c.id === group)!.checks[0]!.id
    await run(tab, { type: 'work.check', conversationId: group, assignmentId: second, checkId: check, passed: true, evidence: 'ok' } as Command, host, chosen)
    await run(tab, { type: 'work.status', conversationId: group, assignmentId: second, status: 'done', result: 'Built.' } as Command, host, chosen)
    expect(await store.routeDecision(owner, tab, id)).toMatchObject({ outcome: 'done', assignmentId: second })
  })

  it('limits route records to 30 per tab per hour', async () => {
    const { tab, lead } = await fixture()
    const decision = { assessment: { difficulty: 'low', risk: 'low', why: 'Docs.' },
      candidates: [{ id: 'c0', kind: 'new', machineId: 'test-host', engine: 'claude', model: 'haiku', effort: 'auto', quality: 1, cost: 1, title: 'New agent', label: 'New agent' }],
      excluded: [], floor: 1, notes: false, pick: 'c0', via: 'only', p: null, belowFloor: false, why: 'Only candidate.' }
    for (let i = 0; i < 30; i++) await run(tab, { type: 'route.record', conversationId: 'lead', decision } as Command, host, lead)
    await expect(run(tab, { type: 'route.record', conversationId: 'lead', decision } as Command, host, lead)).rejects.toMatchObject({ code: 'RATE_LIMITED', status: 429 })
  })
})
