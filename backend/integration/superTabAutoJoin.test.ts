import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import Fastify, { type FastifyInstance } from 'fastify'
import { PrismaClient } from '@prisma/client'
import { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { superTabRoutes } from '../src/routes/superTabs.js'
import { errorHandler } from '../src/middlewares/errorHandler.js'
import { SuperTabStore } from '../src/superTabs/store.js'
import type { AuthUser } from '../src/lib/ssoAuth.js'
import type { GeneralAccess } from '../src/superTabs/sharing.js'
import * as parts from '../src/superTabs/parts/index.js'
import type { SuperTabState } from '../src/superTabs/model.js'
import { addMember, memberId } from '../src/superTabs/workspaceStore.js'

// Ken's spec docs/specs/2026-11-03-swarm-domain-auto-join.md, "Tests that fail first": people at the owner's own email domain
// join a Swarm whose owner turned "Add them automatically" on, on their own list read; nobody at a public domain ever does.

let replica: MongoMemoryReplSet, db: PrismaClient, store: SuperTabStore, app: FastifyInstance
/** The store's clock: tests move it past the 2-minute try window. */
let clock = Date.now()

const account = (n: number, email: string): AuthUser => ({ sub: `3000000000000000000000${n.toString(16).padStart(2, '0')}`, email, autonomousEnv: 'prod', role: 'user' })
const ken = account(1, 'ken@acme.com'), x = account(2, 'x@acme.com'), gmailOwner = account(3, 'owner@gmail.com'), xGmail = account(4, 'x@gmail.com')
const relay = account(5, 'y@privaterelay.appleid.com'), partner = account(6, 'p@partner.com'), y = account(7, 'y@acme.com'), z = account(8, 'z@acme.com')
const w = account(9, 'w@acme.com'), v = account(10, 'v@acme.com'), u = account(11, 'u@acme.com'), t = account(12, 't@acme.com')
const boss = account(13, 'boss@beta.io'), b1 = account(14, 'b1@beta.io'), s1 = account(15, 's1@acme.com'), r1 = account(16, 'r1@acme.com')
const q1 = account(17, 'q1@acme.com'), d1 = account(18, 'd1@acme.com')
const leaver = account(19, 'leaver@acme.com'), removed = account(20, 'removed@acme.com'), invitee = account(21, 'invitee@acme.com')
const linked = account(22, 'linked@acme.com'), banned = account(23, 'banned@acme.com'), wsGone = account(24, 'gone@acme.com'), toggler = account(25, 'toggler@acme.com')
const accounts = [ken, x, gmailOwner, xGmail, relay, partner, y, z, w, v, u, t, boss, b1, s1, r1, q1, d1, leaver, removed, invitee, linked, banned, wsGone, toggler]

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
const turnOn = (tab: string, role: 'collaborator' | 'viewer' = 'collaborator', owner: AuthUser = ken) =>
  save(tab, { mode: 'domain', domain: owner.email.split('@')[1]!, role, autoJoin: true }, owner)
const personIn = async (tab: string, user: AuthUser) => (await storedState(tab)).people.find(p => p.id === user.sub)
const workspaceRole = async (tab: string, user: AuthUser) => {
  const { workspaceId } = await storedState(tab)
  return (await db.swarmWorkspaceMember.findUnique({ where: { id: memberId(workspaceId!, user.sub) } }))?.role
}
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
    // The route answers a non-member's refusal as for a Swarm that does not exist (routes/superTabs.ts NOT_AVAILABLE).
    expect((await request(`${tab}/join`, { operationId: randomUUID() }, xGmail)).statusCode).toBe(404)
    await expect(store.join(xGmail, tab, { operationId: randomUUID() })).rejects.toMatchObject({ code: 'JOIN_UNAVAILABLE' })
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

describe('Joining by domain on the person\'s own list read', () => {
  it('joins x@acme.com to the acme Swarm with auto-join on, as a Workspace guest, with the role the owner picked', async () => {
    const on = await create(), linkOnly = await create(), invited = await create()
    await turnOn(on, 'viewer')
    await save(linkOnly, { mode: 'domain', domain: 'acme.com', role: 'collaborator' })
    const tabs = await listed(x)
    expect(tabs).toContain(on)
    expect(tabs).not.toContain(linkOnly)
    expect(tabs).not.toContain(invited)
    expect(await personIn(on, x)).toMatchObject({ role: 'viewer', joinedVia: 'domain', email: 'x@acme.com' })
    expect(await workspaceRole(on, x)).toBe('guest')
    expect(await personIn(linkOnly, x)).toBeUndefined()
  })

  it('joins nobody at a public domain', async () => {
    const own = await create(gmailOwner)
    // Even a share an older release saved at gmail.com with auto-join on lets nobody in.
    const state = await storedState(own)
    state.sharing = { revision: 1, generation: 'old', access: { mode: 'domain', domain: 'gmail.com', role: 'collaborator', autoJoin: true } }
    await saveState(own, state)
    await db.superTab.update({ where: { id: own }, data: { autoJoinDomain: 'gmail.com' } })
    expect(await listed(xGmail)).toEqual([])
    expect(await listed(relay)).toEqual([])
    expect(await personIn(own, xGmail)).toBeUndefined()
  })

  it('joins through the Workspaces list too', async () => {
    const tab = await create()
    await turnOn(tab)
    expect((await request('workspaces', undefined, y)).statusCode).toBe(200)
    expect(await personIn(tab, y)).toMatchObject({ role: 'collaborator', joinedVia: 'domain' })
  })

  it('keeps the role of someone already a member of the Workspace', async () => {
    const tab = await create()
    await turnOn(tab)
    const { workspaceId } = await storedState(tab)
    await db.$transaction(tx => addMember(tx, workspaceId!, { id: z.sub, email: z.email }, 'member', ken.sub, randomUUID()))
    expect(await listed(z)).toContain(tab)
    expect(await workspaceRole(tab, z)).toBe('member')
  })

  it('joins ten Swarms per try, and the rest after two minutes', async () => {
    const tabs: string[] = []
    for (let i = 0; i < 11; i++) { const tab = await create(boss, `Beta ${i}`); await turnOn(tab, 'collaborator', boss); tabs.push(tab) }
    expect((await listed(b1)).filter(id => tabs.includes(id))).toHaveLength(10)
    expect((await listed(b1)).filter(id => tabs.includes(id))).toHaveLength(10)
    later()
    expect((await listed(b1)).filter(id => tabs.includes(id)).sort()).toEqual([...tabs].sort())
  })

  it('never joins from a team session', async () => {
    const tab = await create()
    await turnOn(tab)
    const team = await app.inject({ method: 'GET', url: '/api/super-tabs/list', headers: { authorization: `Bearer team:${t.sub}` } })
    expect(team.statusCode).toBe(403)
    expect((await app.inject({ method: 'GET', url: '/api/super-tabs/workspaces', headers: { authorization: `Bearer team:${t.sub}` } })).statusCode).toBe(403)
    expect(await personIn(tab, t)).toBeUndefined()
  })

  it('writes no membership after turning auto-join off commits', async () => {
    for (let i = 0; i < 4; i++) {
      const tab = await create()
      await turnOn(tab)
      const revision = (await store.sharing(ken, tab)).revision
      const off = { operationId: randomUUID(), revision, access: { mode: 'domain' as const, domain: 'acme.com', role: 'collaborator' as const, autoJoin: false } }
      await Promise.all([store.saveSharing(ken, tab, off), store.autoJoinSwarm(w, tab).catch(() => 'conflict')])
      const parts = await db.$transaction(tx => import('../src/superTabs/parts/index.js').then(p => p.loadAll(tx, tab)))
      const joined = parts.members.find(m => m.key === w.sub && !m.deleted)
      // Joined only before the turn-off: the turn-off's head write is then the later one.
      if (joined) expect(joined.changedAt).toBeLessThan(parts.head.changedAt)
      expect(await store.autoJoinSwarm(v, tab)).toBe('skipped')
      expect(await personIn(tab, v)).toBeUndefined()
    }
  })

  it('stops at 200 people, and tells the owner', async () => {
    const tab = await create()
    await turnOn(tab)
    const state = await storedState(tab)
    for (let i = state.people.length; i < 200; i++) state.people.push({ id: `filler${i}`, email: `filler${i}@acme.com`, role: 'viewer', generation: `g${i}` })
    await saveState(tab, state)
    expect(await listed(u)).not.toContain(tab)
    expect(await personIn(tab, u)).toBeUndefined()
    expect((await request(`${tab}/sharing`)).json().data.autoJoinFull).toBe(true)
  })

  it('joins nobody to a deleted Swarm', async () => {
    const tab = await create(ken, 'Doomed')
    await turnOn(tab)
    await store.execute(ken, tab, { operationId: randomUUID(), command: { type: 'swarm.delete', name: 'Doomed' } })
    expect((await db.superTab.findUniqueOrThrow({ where: { id: tab } })).autoJoinDomain).toBeNull()
    expect(await store.autoJoinSwarm(d1, tab)).toBe('skipped')
    await listed(d1)
    expect(await personIn(tab, d1)).toBeUndefined()
  })

  it('makes one membership when two reads of the same person race', async () => {
    const tab = await create()
    await turnOn(tab)
    const outcomes = await Promise.all([store.autoJoinSwarm(s1, tab), store.autoJoinSwarm(s1, tab)])
    expect(outcomes.sort()).toEqual(['joined', 'skipped'])
    expect((await storedState(tab)).people.filter(p => p.id === s1.sub)).toHaveLength(1)
  })
})

describe('Leaving is final for auto-join', () => {
  const declinedOf = async (tab: string) => (await db.superTab.findUniqueOrThrow({ where: { id: tab } })).autoJoinDeclined
  const leave = (user: AuthUser, tab: string, by: AuthUser = user) =>
    store.execute(by, tab, { operationId: randomUUID(), command: { type: 'member.remove', userId: user.sub } })

  it('does not pull back someone who left', async () => {
    const tab = await create()
    await turnOn(tab)
    expect(await listed(leaver)).toContain(tab)
    await leave(leaver, tab)
    expect(await declinedOf(tab)).toContain(leaver.sub)
    later()
    expect(await listed(leaver)).not.toContain(tab)
    expect(await personIn(tab, leaver)).toBeUndefined()
  })

  it('does not pull back someone the owner removed, and keeps that across turning auto-join off and on', async () => {
    const tab = await create()
    await turnOn(tab)
    await listed(removed)
    await leave(removed, tab, ken)
    await save(tab, { mode: 'invited', role: 'collaborator' })
    await turnOn(tab)
    expect(await declinedOf(tab)).toContain(removed.sub)
    later()
    expect(await listed(removed)).not.toContain(tab)
  })

  it('lets someone come back on purpose by an accepted invitation, which clears the decline', async () => {
    const tab = await create()
    await turnOn(tab)
    await listed(invitee)
    await leave(invitee, tab)
    const invite = await store.execute(ken, tab, { operationId: randomUUID(),
      command: { type: 'invite.create', email: invitee.email, role: 'viewer', conversationId: 'lead' } })
    await store.execute(invitee, tab, { operationId: randomUUID(), command: { type: 'invite.accept', inviteId: String(invite.result.inviteId) } })
    expect(await declinedOf(tab)).not.toContain(invitee.sub)
    expect(await personIn(tab, invitee)).toMatchObject({ role: 'viewer' })
    expect((await personIn(tab, invitee))!.joinedVia).toBeUndefined()
  })

  it('lets someone come back on purpose by a link, which clears the decline', async () => {
    const tab = await create()
    await turnOn(tab)
    await listed(linked)
    await leave(linked, tab)
    expect((await request(`${tab}/join`, { operationId: randomUUID() }, linked)).statusCode).toBe(200)
    expect(await declinedOf(tab)).not.toContain(linked.sub)
    expect((await personIn(tab, linked))!.joinedVia).toBeUndefined()
  })

  it('declines someone the Workspace removed instead of joining them, and does not try that Swarm again', async () => {
    const tab = await create()
    await turnOn(tab)
    const { workspaceId } = await storedState(tab)
    await db.swarmWorkspaceMember.create({ data: { id: memberId(workspaceId!, banned.sub), workspaceId: workspaceId!, userId: banned.sub, email: banned.email,
      role: 'guest', generation: 'old', addedBy: ken.sub, addedAt: new Date(), removedAt: new Date(), removedBy: ken.sub, purgeAt: null } })
    expect(await listed(banned)).not.toContain(tab)
    expect(await personIn(tab, banned)).toBeUndefined()
    expect(await declinedOf(tab)).toContain(banned.sub)
    const tried = vi.spyOn(store, 'autoJoinSwarm')
    later()
    await listed(banned)
    expect(tried.mock.calls.filter(([, id]) => id === tab)).toEqual([])
    tried.mockRestore()
  })

  it('declines someone who joined by domain and was then removed from the Workspace', async () => {
    const tab = await create()
    await turnOn(tab)
    await listed(wsGone)
    const { workspaceId } = await storedState(tab)
    await store.workspaces.remove(ken, workspaceId!, wsGone.sub)
    expect(await personIn(tab, wsGone)).toBeUndefined()
    expect(await declinedOf(tab)).toContain(wsGone.sub)
  })
})
