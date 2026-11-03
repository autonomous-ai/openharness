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

// Ken's spec docs/specs/2026-11-03-swarm-domain-auto-join.md, "Tests that fail first": people at the owner's own email domain
// join a Swarm whose owner turned "Add them automatically" on, on their own list read; nobody at a public domain ever does.

let replica: MongoMemoryReplSet, db: PrismaClient, store: SuperTabStore, app: FastifyInstance
/** The store's clock: tests move it past the 2-minute try window. */
let clock = Date.now()

const account = (n: number, email: string): AuthUser => ({ sub: `30000000000000000000000${n.toString(16)}`, email, autonomousEnv: 'prod', role: 'user' })
const ken = account(1, 'ken@acme.com'), x = account(2, 'x@acme.com'), gmailOwner = account(3, 'owner@gmail.com'), xGmail = account(4, 'x@gmail.com')
const relay = account(5, 'y@privaterelay.appleid.com'), partner = account(6, 'p@partner.com'), y = account(7, 'y@acme.com'), z = account(8, 'z@acme.com')
const w = account(9, 'w@acme.com'), v = account(10, 'v@acme.com'), u = account(11, 'u@acme.com'), t = account(12, 't@acme.com')
const accounts = [ken, x, gmailOwner, xGmail, relay, partner, y, z, w, v, u, t]

/** A Swarm's whole state as its parts hold it. */
async function storedState(tab: string): Promise<SuperTabState> {
  return parts.reassemble(await db.$transaction(tx => parts.loadAll(tx, tab)))
}
/** Replaces a Swarm's parts with `state`, as an older release would have left them. */
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
const request = (path: string, body?: object, user: AuthUser = ken, method?: 'GET' | 'POST') =>
  app.inject({ method: method ?? (body ? 'POST' : 'GET'), url: `/api/super-tabs/${path}`,
    headers: { authorization: `Bearer ${user.sub}` }, ...(body ? { payload: body } : {}) })
/** Saves sharing as `owner` through the API, at the current revision. */
const save = async (tab: string, access: GeneralAccess | Record<string, unknown>, owner: AuthUser = ken) => {
  const current = await store.sharing(owner, tab)
  return request(`${tab}/sharing`, { operationId: randomUUID(), revision: current.revision, access }, owner)
}
const create = async (owner: AuthUser = ken, name = 'Acme Swarm') => (await store.create(owner, randomUUID(), name)).id
const later = () => { clock += 121_000 }
const listed = async (user: AuthUser) => (await request('list', undefined, user)).json().data.tabs.map((tab: { id: string }) => tab.id) as string[]

beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ binary: { version: '7.0.24', downloadDir: join(tmpdir(), 'harness-super-tab-mongodb-binaries') },
    replSet: { count: 1, ip: '127.0.0.1', storageEngine: 'wiredTiger' } })
  const uri = replica.getUri(`swarm_auto_join_test_${randomUUID().replaceAll('-', '_')}`)
  await promisify(execFile)(join(process.cwd(), 'node_modules/.bin/prisma'), ['db', 'push', '--skip-generate'], {
    env: { ...process.env, DATABASE_URL: uri }, timeout: 60000,
  })
  db = new PrismaClient({ datasources: { db: { url: uri } } })
  store = new SuperTabStore(db, () => clock)
  for (const user of accounts) await db.user.create({ data: { id: user.sub, externalId: `auto-join-fixture-${user.sub}`,
    email: user.email, autonomousEnv: user.autonomousEnv } })
  app = Fastify()
  app.setErrorHandler(errorHandler)
  // Only SSO is replaced. All routes, authorization, receipts, and Mongo transactions are real.
  app.addHook('onRequest', async (req, reply) => {
    const header = req.headers.authorization ?? ''
    const user = accounts.find(a => header === `Bearer ${a.sub}`)
    const team = accounts.find(a => header === `Bearer team:${a.sub}`)
    if (!user && !team) return reply.code(401).send({ success: false })
    req.user = user ?? { ...team!, harnessSessionKind: 'team', harnessComputerId: 'computer-1' }
  })
  await app.register(superTabRoutes, { store })
  await app.ready()
})
afterAll(async () => { await app?.close(); await db?.$disconnect(); await replica?.stop() })

describe('Domain checks on save and join', () => {
  it('refuses a public domain on save', async () => {
    const own = await create(gmailOwner)
    const refused = await save(own, { mode: 'domain', domain: 'gmail.com', role: 'collaborator' }, gmailOwner)
    expect(refused.statusCode).toBe(400)
    expect(refused.json().error.code).toBe('PUBLIC_DOMAIN')
    const tab = await create()
    const outlook = await save(tab, { mode: 'domain', domain: 'outlook.com', role: 'collaborator' })
    expect(outlook.json().error.code).toBe('PUBLIC_DOMAIN')
  })

  it('refuses auto-join at a domain that is not the owner\'s, and keeps a partner share without it', async () => {
    const tab = await create()
    const refused = await save(tab, { mode: 'domain', domain: 'partner.com', role: 'collaborator', autoJoin: true })
    expect(refused.statusCode).toBe(400)
    expect(refused.json().error.code).toBe('DOMAIN_NOT_YOURS')
    const accepted = await save(tab, { mode: 'domain', domain: 'partner.com', role: 'collaborator' })
    expect(accepted.statusCode).toBe(200)
    expect(accepted.json().data.access).toEqual({ mode: 'domain', domain: 'partner.com', role: 'collaborator', autoJoin: false })
    const joined = await request(`${tab}/join`, { operationId: randomUUID() }, partner)
    expect(joined.statusCode).toBe(200)
    expect(joined.json().data).toMatchObject({ id: tab, role: 'collaborator', alreadyMember: false })
  })

  it('keeps autoJoin when a save leaves it out, turns it off with false, and clears it with another mode', async () => {
    const tab = await create()
    const on = await save(tab, { mode: 'domain', domain: 'acme.com', role: 'collaborator', autoJoin: true })
    expect(on.json().data.access.autoJoin).toBe(true)
    expect((await db.superTab.findUniqueOrThrow({ where: { id: tab } })).autoJoinDomain).toBe('acme.com')
    // An older Desktop saves without the field: it never turns auto-join off by accident.
    const kept = await save(tab, { mode: 'domain', domain: 'acme.com', role: 'viewer' })
    expect(kept.json().data.access).toEqual({ mode: 'domain', domain: 'acme.com', role: 'viewer', autoJoin: true })
    const off = await save(tab, { mode: 'domain', domain: 'acme.com', role: 'viewer', autoJoin: false })
    expect(off.json().data.access.autoJoin).toBe(false)
    expect((await db.superTab.findUniqueOrThrow({ where: { id: tab } })).autoJoinDomain).toBeNull()
    await save(tab, { mode: 'domain', domain: 'acme.com', role: 'viewer', autoJoin: true })
    const link = await save(tab, { mode: 'link', role: 'viewer' })
    expect(link.json().data.access).toEqual({ mode: 'link', role: 'viewer' })
    expect((await db.superTab.findUniqueOrThrow({ where: { id: tab } })).autoJoinDomain).toBeNull()
    const back = await save(tab, { mode: 'domain', domain: 'acme.com', role: 'viewer' })
    expect(back.json().data.access.autoJoin).toBe(false)
  })

  it('drops a kept autoJoin when an older app saves another domain, instead of refusing it', async () => {
    const tab = await create()
    await save(tab, { mode: 'domain', domain: 'acme.com', role: 'collaborator', autoJoin: true })
    const moved = await save(tab, { mode: 'domain', domain: 'partner.com', role: 'collaborator' })
    expect(moved.statusCode).toBe(200)
    expect(moved.json().data.access.autoJoin).toBe(false)
    expect((await db.superTab.findUniqueOrThrow({ where: { id: tab } })).autoJoinDomain).toBeNull()
  })

  it('answers JOIN_UNAVAILABLE for an old share at a public domain, and shows it turned off', async () => {
    const tab = await create()
    await save(tab, { mode: 'domain', domain: 'acme.com', role: 'collaborator' })
    const state = await storedState(tab)
    state.sharing!.access = { mode: 'domain', domain: 'gmail.com', role: 'collaborator' }
    await saveState(tab, state)
    const refused = await request(`${tab}/join`, { operationId: randomUUID() }, xGmail)
    expect(refused.statusCode).toBe(404)
    expect(refused.json().error.code).toBe('JOIN_UNAVAILABLE')
    expect((await request(`${tab}/join/preview`, {}, xGmail)).statusCode).toBe(404)
    const details = (await request(`${tab}/sharing`)).json().data
    expect(details.access).toEqual({ mode: 'invited', role: 'collaborator' })
    expect(details.turnedOffDomain).toBe('gmail.com')
    expect(details.joinUrl).toBeNull()
  })

  it('tells the Share dialog the owner\'s own domain and whether anyone can have an address there', async () => {
    const tab = await create()
    expect((await request(`${tab}/sharing`)).json().data).toMatchObject({ ownDomain: 'acme.com', ownDomainPublic: false, autoJoinFull: false })
    const own = await create(gmailOwner)
    expect((await request(`${own}/sharing`, undefined, gmailOwner)).json().data).toMatchObject({ ownDomain: 'gmail.com', ownDomainPublic: true })
  })
})
