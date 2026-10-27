import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import Fastify, { type FastifyInstance } from 'fastify'
import { PrismaClient } from '@prisma/client'
import { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { superTabRoutes } from '../src/routes/superTabs.js'
import { errorHandler } from '../src/middlewares/errorHandler.js'
import { SuperTabStore } from '../src/superTabs/store.js'
import type { AuthUser } from '../src/lib/ssoAuth.js'
import type { GeneralAccess } from '../src/superTabs/sharing.js'
import * as parts from '../src/superTabs/parts/index.js'
import type { SuperTabState } from '../src/superTabs/model.js'

let replica: MongoMemoryReplSet, db: PrismaClient, store: SuperTabStore, app: FastifyInstance

/** A Swarm's whole state as its parts hold it (test helper: the store keeps no single document). */
async function storedState(tab: string): Promise<SuperTabState> {
  return parts.reassemble(await db.$transaction(tx => parts.loadAll(tx, tab)))
}
/** Replaces a Swarm's parts with `state`, as an older release would have left them. Versions keep rising. */
async function saveState(tab: string, state: SuperTabState) {
  await db.$transaction(async tx => {
    const current = await parts.loadAll(tx, tab)
    const version = Math.max(current.head.version, ...[...current.members, ...current.agents, ...current.groups, ...current.machines,
      ...current.starts, ...current.progress].map(p => p.version)) + 1
    for (const model of [tx.swarmHead, tx.swarmMember, tx.swarmAgent, tx.swarmGroup, tx.swarmMachine, tx.swarmStart, tx.swarmProgress] as unknown as
      Array<{ deleteMany(args: unknown): Promise<unknown> }>) await model.deleteMany({ where: { tabId: tab } })
    await parts.insertParts(tx, { ...parts.split(state, { tabId: tab, version, now: Date.now(), visibilityEpoch: current.visibilityEpoch }),
      sequenceBase: current.sequenceBase })
  })
}
const owner: AuthUser = { sub: '200000000000000000000001', email: 'owner@example.com', autonomousEnv: 'prod', role: 'user' }
const peer: AuthUser = { sub: '200000000000000000000002', email: 'peer@example.com', autonomousEnv: 'prod', role: 'user' }
const outsider: AuthUser = { sub: '200000000000000000000003', email: 'outsider@elsewhere.test', autonomousEnv: 'prod', role: 'user' }
const subdomain: AuthUser = { sub: '200000000000000000000004', email: 'person@sub.example.com', autonomousEnv: 'prod', role: 'user' }
const accounts = [owner, peer, outsider, subdomain]
const request = (tab: string, path: string, body?: object, user: AuthUser | null = owner, method?: 'GET' | 'POST') =>
  app.inject({ method: method ?? (body ? 'POST' : 'GET'), url: `/api/super-tabs/${tab}/${path}`,
    headers: user ? { authorization: `Bearer ${user.sub}` } : {}, ...(body ? { payload: body } : {}) })
const save = async (tab: string, access: GeneralAccess, rotateLink = false) => {
  const current = await store.sharing(owner, tab)
  return store.saveSharing(owner, tab, { operationId: randomUUID(), revision: current.revision, access, rotateLink })
}
const tokenOf = (details: { joinUrl: string | null }) => new URL(details.joinUrl!).searchParams.get('token')!
const create = async () => (await store.create(owner, randomUUID(), 'Fixture Swarm')).id

beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ binary: { version: '7.0.24', downloadDir: join(tmpdir(), 'harness-super-tab-mongodb-binaries') },
    replSet: { count: 1, ip: '127.0.0.1', storageEngine: 'wiredTiger' } })
  const uri = replica.getUri(`swarm_sharing_test_${randomUUID().replaceAll('-', '_')}`)
  await promisify(execFile)(join(process.cwd(), 'node_modules/.bin/prisma'), ['db', 'push', '--skip-generate'], {
    env: { ...process.env, DATABASE_URL: uri }, timeout: 60000,
  })
  db = new PrismaClient({ datasources: { db: { url: uri } } })
  store = new SuperTabStore(db)
  for (const user of accounts) await db.user.create({ data: { id: user.sub, externalId: `sharing-fixture-${user.sub}`,
    email: user.email, autonomousEnv: user.autonomousEnv } })
  app = Fastify()
  app.setErrorHandler(errorHandler)
  // Only SSO is replaced. All routes, authorization, receipts, and Mongo transactions are real.
  app.addHook('onRequest', async (req, reply) => {
    const account = accounts.find(user => `Bearer ${user.sub}` === req.headers.authorization)
    if (!account) return reply.code(401).send({ success: false })
    req.user = account
  })
  await app.register(superTabRoutes, { store })
  await app.ready()
})
afterAll(async () => { await app?.close(); await db?.$disconnect(); await replica?.stop() })

describe('Swarm sharing on the authenticated control API', () => {
  it('stays invite-only by default, requires the owner, and never joins on a read', async () => {
    const tab = await create()
    expect((await request(tab, 'sharing')).json().data).toEqual({ revision: 0,
      access: { mode: 'invited', role: 'collaborator' }, joinUrl: null })
    expect((await request(tab, 'sharing', undefined, null)).statusCode).toBe(401)
    expect((await request(tab, 'sharing', undefined, peer)).statusCode).toBe(403)
    const body = { operationId: randomUUID(), revision: 0, access: { mode: 'link', role: 'collaborator' } }
    expect((await request(tab, 'sharing', body, peer)).statusCode).toBe(403)
    expect((await request(tab, 'sharing', { ...body, access: { mode: 'link', role: 'owner' } })).statusCode).toBe(400)
    expect((await request(tab, 'join/preview', {}, peer)).statusCode).toBe(404)
    expect((await request(tab, 'join', { operationId: randomUUID() }, peer)).statusCode).toBe(404)
    expect((await request(tab, 'join', undefined, peer)).statusCode).toBe(404)
    expect((await store.list(peer)).tabs).toEqual([])
    expect((await store.read(owner, tab)).state.people).toHaveLength(1)
  })

  it('previews and explicitly joins matching domains without exposing a private project', async () => {
    const tab = await create()
    const project = await store.execute(owner, tab, { operationId: randomUUID(),
      command: { type: 'project.create', name: 'Hidden initiative', visibility: 'private', brief: 'Private brief' } })
    const sharing = await request(tab, 'sharing', { operationId: randomUUID(), revision: 0,
      access: { mode: 'domain', domain: '  EXAMPLE.com ', role: 'viewer' } })
    expect(sharing.statusCode).toBe(200)
    expect(sharing.json().data.access.domain).toBe('example.com')
    expect(sharing.json().data.joinUrl).toBe(`harness://swarm/join/${tab}`)
    const before = await db.superTab.findUniqueOrThrow({ where: { id: tab } })
    const preview = await request(tab, 'join/preview', {}, peer)
    expect(preview.json().data).toEqual({ id: tab, name: 'Fixture Swarm', role: 'viewer', alreadyMember: false })
    expect((await db.superTab.findUniqueOrThrow({ where: { id: tab } })).revision).toBe(before.revision)
    expect((await request(tab, 'join/preview', {}, outsider)).statusCode).toBe(404)
    expect((await request(tab, 'join/preview', {}, subdomain)).statusCode).toBe(404)
    expect((await request(tab, 'join', { operationId: randomUUID(), email: peer.email }, outsider)).statusCode).toBe(400)
    const join = { operationId: randomUUID() }
    const result = await request(tab, 'join', join, peer)
    expect(result.statusCode).toBe(200)
    expect(result.json().data).toMatchObject({ id: tab, role: 'viewer', alreadyMember: false })
    expect((await request(tab, 'join', join, peer)).json().data).toEqual(result.json().data)
    const snapshot = await store.read(peer, tab)
    expect(snapshot.state.projects!.map(p => p.id)).not.toContain(project.result.projectId)
    expect(snapshot.state.sharing).toBeUndefined()
    expect((await request(tab, 'sharing', undefined, peer)).statusCode).toBe(403)
    await expect(store.messages(peer, tab, String(project.result.conversationId), {})).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect((await store.list(peer)).tabs.map(t => t.id)).toContain(tab)
    await save(tab, { mode: 'invited', role: 'collaborator' })
    expect((await request(tab, 'join', join, peer)).statusCode).toBe(404)
    expect((await store.read(peer, tab)).state.people.find(p => p.id === peer.sub)?.role).toBe('viewer')
  })

  it('rotates and revokes links, encrypts tokens at rest, and never promotes existing members', async () => {
    const tab = await create()
    const invitation = await store.execute(owner, tab, { operationId: randomUUID(),
      command: { type: 'invite.create', email: peer.email, role: 'viewer', conversationId: 'lead' } })
    await store.execute(peer, tab, { operationId: randomUUID(), command: { type: 'invite.accept', inviteId: String(invitation.result.inviteId) } })
    const createLink = { operationId: randomUUID(), revision: 0, access: { mode: 'link' as const, role: 'collaborator' as const } }
    const first = await store.saveSharing(owner, tab, createLink), token = tokenOf(first)
    expect(await store.saveSharing(owner, tab, createLink)).toEqual(first)
    expect((await request(tab, 'join/preview', { token }, null)).statusCode).toBe(401)
    expect((await request(tab, 'join/preview', { token })).json().data.role).toBe('owner')
    expect((await request(tab, 'join/preview', { token }, peer)).json().data.role).toBe('viewer')
    expect((await request(tab, 'join', { operationId: randomUUID(), token }, peer)).json().data).toMatchObject({ role: 'viewer', alreadyMember: true })
    const join = { operationId: randomUUID(), token }
    expect((await request(tab, 'join', join, outsider)).json().data.role).toBe('collaborator')
    const stored = [await db.superTab.findUniqueOrThrow({ where: { id: tab } }), await storedState(tab)]
    expect(JSON.stringify(stored)).not.toContain(token)
    expect(JSON.stringify(await db.superTabOperation.findMany({ where: { tabId: tab } }))).not.toContain(token)
    expect((await store.read(owner, tab)).state.sharing).toBeUndefined()
    await store.execute(owner, tab, { operationId: randomUUID(), command: { type: 'tab.rename', name: 'Renamed Swarm' } })
    expect(tokenOf(await store.sharing(owner, tab))).toBe(token)
    const replaced = await save(tab, { mode: 'link', role: 'viewer' }, true)
    expect(tokenOf(replaced)).not.toBe(token)
    expect((await request(tab, 'join/preview', { token }, outsider)).statusCode).toBe(404)
    expect((await request(tab, 'join', join, outsider)).statusCode).toBe(404)
    await expect(store.saveSharing(owner, tab, createLink)).rejects.toMatchObject({ code: 'SHARING_CHANGED' })
    expect((await store.read(outsider, tab)).state.people.find(p => p.id === outsider.sub)?.role).toBe('collaborator')
    await save(tab, { mode: 'invited', role: 'viewer' })
    expect((await request(tab, 'join/preview', { token: tokenOf(replaced) }, outsider)).statusCode).toBe(404)
  })

  it('fences old domain receipts after disabling/re-enabling access and after a member leaves', async () => {
    const tab = await create()
    const access = { mode: 'domain' as const, domain: 'example.com', role: 'collaborator' as const }
    await save(tab, access)
    const join = { operationId: randomUUID() }
    await store.join(peer, tab, join)
    await save(tab, { mode: 'invited', role: 'collaborator' })
    await save(tab, access)
    await expect(store.join(peer, tab, join)).rejects.toMatchObject({ code: 'JOIN_CHANGED' })
    const latest = { operationId: randomUUID() }
    await store.join(peer, tab, latest)
    await store.execute(peer, tab, { operationId: randomUUID(), command: { type: 'member.remove', userId: peer.sub } })
    await expect(store.join(peer, tab, latest)).rejects.toMatchObject({ code: 'JOIN_CHANGED' })
    expect((await store.read(owner, tab)).state.people.some(p => p.id === peer.sub)).toBe(false)
    // A newly confirmed join receives a new membership generation, not any old private grants.
    const rejoin = await store.join(peer, tab, { operationId: randomUUID() })
    expect(rejoin.alreadyMember).toBe(false)
    await expect(store.join(peer, tab, latest)).rejects.toMatchObject({ code: 'JOIN_CHANGED' })
  })

  it('keeps legacy members without a generation stable without restoring them after removal', async () => {
    const tab = await create()
    await save(tab, { mode: 'domain', domain: 'example.com', role: 'collaborator' })
    const state = await storedState(tab)
    state.people.push({ id: peer.sub, email: peer.email, role: 'viewer' } as SuperTabState['people'][number])
    await saveState(tab, state)
    await db.superTab.update({ where: { id: tab }, data: { memberIds: [owner.sub, peer.sub] } })
    const join = { operationId: randomUUID() }
    const result = await store.join(peer, tab, join)
    expect(result).toMatchObject({ role: 'viewer', alreadyMember: true })
    expect(await store.join(peer, tab, join)).toEqual(result)
    await store.execute(owner, tab, { operationId: randomUUID(), command: { type: 'member.remove', userId: peer.sub } })
    await expect(store.join(peer, tab, join)).rejects.toMatchObject({ code: 'JOIN_CHANGED' })
  })

  it('serializes concurrent joins/settings, prevents operation reuse, and isolates account environments', async () => {
    const tab = await create()
    const first = await save(tab, { mode: 'link', role: 'collaborator' }), token = tokenOf(first)
    const join = { operationId: randomUUID(), token }
    const [a, b] = await Promise.all([store.join(peer, tab, join), store.join(peer, tab, join)])
    expect(a).toEqual(b)
    expect((await store.read(owner, tab)).state.people.filter(p => p.id === peer.sub)).toHaveLength(1)
    await expect(store.join({ ...peer, autonomousEnv: 'stag' }, tab, join)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    const updates = [
      { operationId: randomUUID(), revision: first.revision, access: { mode: 'invited' as const, role: 'viewer' as const } },
      { operationId: randomUUID(), revision: first.revision, access: { mode: 'domain' as const, domain: 'example.com', role: 'viewer' as const } },
    ]
    const results = await Promise.allSettled(updates.map(input => store.saveSharing(owner, tab, input)))
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { code: 'REVISION_CHANGED' } })
    const accepted = updates[results.findIndex(result => result.status === 'fulfilled')]!
    await expect(store.saveSharing(owner, tab, { ...accepted, revision: 99 })).rejects.toMatchObject({ code: 'OPERATION_REUSED' })
  })
})
