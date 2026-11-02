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
import { appendRouting, instructionsHash } from '../src/superTabs/instructions.js'
import { stableId } from '../src/superTabs/model.js'
import { roleVersion } from '../src/superTabs/projects.js'
import { DEFAULT_ROUTING_POLICY } from '../src/superTabs/routingPolicy.js'
import { INSTRUCTIONS_TEMPLATE } from '../src/superTabs/instructionsTemplate.js'
import { rosterRows } from './hostRows.test-support.js'

// A fresh loopback replica set, created here. This suite never reads DATABASE_URL or an existing database.
// Project instructions, phase 2 (docs/plans/2026-10-30-project-instructions-plan.md): the document, its revisions, the
// coordinator's notes, role names and the migration job, against real transactions.
let replica: MongoMemoryReplSet
let db: PrismaClient
let store: SuperTabStore
let app: FastifyInstance
/** The store's clock: a test moves it to see a note expire. */
let now = Date.now()
const owner: AuthUser = { sub: '100000000000000000000001', email: 'owner@example.com', autonomousEnv: 'prod', role: 'user' }
const peer: AuthUser = { sub: '100000000000000000000002', email: 'peer@example.com', autonomousEnv: 'prod', role: 'user' }
const host: AuthUser = { sub: '100000000000000000000003', email: 'host@example.com', autonomousEnv: 'prod', role: 'user' }
const config = { engine: 'codex', model: 'fixture-model', effort: 'high', contextWindow: 200000, engineVersion: 'fixture' }
const run = (tab: string, command: Command, user = owner, asAgentId?: string) =>
  store.execute(user, tab, { operationId: randomUUID(), command }, asAgentId)
async function invite(tab: string) {
  const invitation = await run(tab, { type: 'invite.create', email: peer.email, role: 'collaborator', conversationId: 'lead' })
  await run(tab, { type: 'invite.accept', inviteId: invitation.result.inviteId as string }, peer)
}
async function withLead() {
  const tab = (await store.create(owner, randomUUID(), 'Pilot')).id
  const lead = (await run(tab, { type: 'agent.add', conversationId: 'lead', machineId: 'test-host', harnessId: randomUUID(),
    name: 'Lead', configuration: config, lead: true })).result.agentId as string
  return { tab, lead }
}
const save = (baseRevision: number, text: string, summary = 'Changed.', projectId = 'lead'): Command =>
  ({ type: 'instructions.save', projectId, baseRevision, text, summary })
const get = (user: AuthUser, url: string) => app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${user.sub}` } })
const post = (user: AuthUser, tab: string, command: Command) => app.inject({ method: 'POST', url: `/api/super-tabs/${tab}/commands`,
  headers: { authorization: `Bearer ${user.sub}` }, payload: { operationId: randomUUID(), command } })

beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ binary: { version: '7.0.24', downloadDir: join(tmpdir(), 'harness-super-tab-mongodb-binaries') },
    replSet: { count: 1, ip: '127.0.0.1', storageEngine: 'wiredTiger' } })
  const uri = replica.getUri(`instructions_test_${randomUUID().replaceAll('-', '_')}`)
  await promisify(execFile)(join(process.cwd(), 'node_modules/.bin/prisma'), ['db', 'push', '--skip-generate'], {
    env: { ...process.env, DATABASE_URL: uri }, timeout: 60000,
  })
  db = new PrismaClient({ datasources: { db: { url: uri } } })
  store = new SuperTabStore(db, () => now)
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
})
afterAll(async () => {
  await app?.close()
  await db?.$disconnect()
  await replica?.stop()
})

describe('project instructions storage', () => {
  it('starts a new Swarm\'s project and a new project on revision 1, a copy of the template, at the store\'s time', async () => {
    // Both stamped by the store's clock, not the machine's (review of phase 2).
    const was = now
    now = Date.parse('2026-10-01T00:00:00.000Z')
    const tab = (await store.create(owner, randomUUID(), 'Pilot')).id
    const project = (await run(tab, { type: 'project.create', name: 'App', visibility: 'public', brief: '' })).result.projectId as string
    now = was
    for (const projectId of ['lead', project]) {
      const stored = await db.superTabInstructions.findFirstOrThrow({ where: { tabId: tab, projectId } })
      expect(stored).toMatchObject({ revision: 1, text: INSTRUCTIONS_TEMPLATE, hash: instructionsHash(INSTRUCTIONS_TEMPLATE) })
      expect(await db.superTabInstructionsRevision.findMany({ where: { tabId: tab, projectId } })).toEqual([expect.objectContaining({
        revision: 1, text: INSTRUCTIONS_TEMPLATE, writtenByKind: 'person', writtenBy: owner.sub, askedBy: owner.sub,
        at: new Date('2026-10-01T00:00:00.000Z') })])
    }
    const head = (await store.read(owner, tab)).state.projects!
    expect(head.map(p => p.instructionsRevision)).toEqual([1, 1])
  })

  it('refuses the second of two saves on the same revision with the first one\'s text, and posts one line per save', async () => {
    const tab = (await store.create(owner, randomUUID(), 'Pilot')).id
    await invite(tab)
    const first = await post(owner, tab, save(1, 'Reviews run on Opus.', 'Reviews run on Opus'))
    expect(first.statusCode, first.body).toBe(200)
    const second = await post(peer, tab, save(1, 'Tests run on the Mac.', 'Tests run on the Mac'))
    expect(second.statusCode).toBe(409)
    expect(second.json().error).toMatchObject({ code: 'INSTRUCTIONS_STALE', revision: 2, text: 'Reviews run on Opus.' })
    expect((await post(peer, tab, save(2, 'Reviews run on Opus.\nTests run on the Mac.', 'Tests run on the Mac'))).statusCode).toBe(200)
    const lines = (await store.messages(owner, tab, 'lead', {})).messages.filter(m => (m.source as { kind?: string } | null)?.kind === 'instructions')
    expect(lines.map(m => m.text)).toEqual(['owner changed the instructions: Reviews run on Opus.', 'peer changed the instructions: Tests run on the Mac.'])
    expect((await db.superTabInstructions.findFirstOrThrow({ where: { tabId: tab, projectId: 'lead' } })).revision).toBe(3)
  })

  it('keeps the last 50 revisions and deletes everything with the project', async () => {
    const tab = (await store.create(owner, randomUUID(), 'Pilot')).id
    const project = (await run(tab, { type: 'project.create', name: 'App', visibility: 'public', brief: '' })).result.projectId as string
    for (let base = 1; base <= 51; base++) await run(tab, save(base, `Revision ${base + 1}.`, `Revision ${base + 1}`, project))
    const kept = await db.superTabInstructionsRevision.findMany({ where: { tabId: tab, projectId: project }, orderBy: { revision: 'asc' } })
    expect(kept).toHaveLength(50)
    expect([kept[0]!.revision, kept.at(-1)!.revision]).toEqual([3, 52])
    expect(kept.at(-1)!.text).toBe('Revision 52.')
    await run(tab, { type: 'project.delete', projectId: project })
    expect(await db.superTabInstructions.count({ where: { tabId: tab, projectId: project } })).toBe(0)
    expect(await db.superTabInstructionsRevision.count({ where: { tabId: tab, projectId: project } })).toBe(0)
    expect(await db.superTabInstructions.count({ where: { tabId: tab, projectId: 'lead' } })).toBe(1)
  })
})

describe('PM notes storage', () => {
  it('keeps the coordinator\'s notes beside the project, deletes an expired one on the next write, and tells it of a removal', async () => {
    const { tab, lead } = await withLead()
    await invite(tab)
    const add = async (text: string, expiresAt?: number) => (await run(tab, { type: 'note.add', projectId: 'lead', text, askedBy: peer.sub,
      ...(expiresAt ? { expiresAt: new Date(expiresAt).toISOString() } : {}) }, host, lead)).result.noteId as string
    const lasting = await add('Do not use Codex on machine A.')
    const tonight = await add('Hold releases until tonight.', now + 60_000)
    expect((await db.superTabPmNote.findMany({ where: { tabId: tab, projectId: 'lead' }, orderBy: { at: 'asc' } })).map(n => n.id)).toEqual([lasting, tonight])
    now += 120_000
    const third = await add('Prefer the Studio for Desktop tests.')
    expect((await db.superTabPmNote.findMany({ where: { tabId: tab, projectId: 'lead' } })).map(n => n.id).sort()).toEqual([lasting, third].sort())
    await run(tab, { type: 'note.remove', projectId: 'lead', noteId: lasting }, peer)
    expect(await db.superTabPmNote.count({ where: { tabId: tab, projectId: 'lead' } })).toBe(1)
    const told = await db.superTabDelivery.findMany({ where: { tabId: tab, agentId: lead } })
    const rows = await db.superTabMessage.findMany({ where: { tabId: tab, conversationId: 'lead' } })
    const notice = rows.find(m => m.text === 'peer removed your note: "Do not use Codex on machine A."')!
    expect(notice.recipientIds).toEqual([lead])
    expect(told.some(d => d.messageId === notice.id)).toBe(true)
    expect((await store.read(owner, tab)).state.projects![0]!.notesRevision).toBe(4)
  })
})

describe('role names and the coordinator\'s name in reads', () => {
  it('names each agent\'s role and its project\'s instructions in its host\'s rows and the members\' read', async () => {
    const { tab, lead } = await withLead()
    const tester = (await run(tab, { type: 'agent.add', conversationId: 'lead', machineId: 'test-host', harnessId: randomUUID(),
      name: 'Tester', configuration: config, lead: false, roleName: 'Tester' })).result.agentId as string
    const rows = async () => (await rosterRows(store, host, 'test-host')).filter(r => r.tabId === tab) as Array<{ agent: { id: string }; roleName: string;
      instructions: unknown }>
    const of = async (id: string) => (await rows()).find(r => r.agent.id === id)!
    expect(await of(lead)).toMatchObject({ roleName: 'PM', instructions: { projectId: 'lead', revision: 1, hash: instructionsHash(INSTRUCTIONS_TEMPLATE),
      coordinatorName: 'Product Manager' } })
    expect((await of(tester)).roleName).toBe('Tester')
    await run(tab, { type: 'project.coordinatorName', projectId: 'lead', name: 'Lead engineer' }, host, lead)
    await run(tab, save(1, 'Our own way.'))
    expect((await of(tester)).instructions).toEqual({ projectId: 'lead', revision: 2, hash: instructionsHash('Our own way.'), coordinatorName: 'Lead engineer' })
    const read = await get(owner, `/api/super-tabs/${tab}/parts`)
    expect(read.statusCode, read.body).toBe(200)
    const { head, derived } = read.json().data
    expect(head.data.projects[0]).toMatchObject({ instructionsRevision: 2, coordinatorName: 'Lead engineer' })
    expect(derived.agents[tester].roleName).toBe('Tester')
    expect(derived.agents[lead].roleName).toBe('PM')
  })
})

describe('reading the instructions', () => {
  const doc = (tab: string, projectId = 'lead', asAgentId?: string) => `/api/super-tabs/${tab}/projects/${projectId}/instructions${asAgentId ? `?asAgentId=${asAgentId}` : ''}`
  it('serves the text, the live notes and the history to who reads the project; a Buddy the text alone', async () => {
    const { tab, lead } = await withLead()
    await invite(tab)
    await run(tab, save(1, 'Reviews run on Opus.', 'Reviews run on Opus'))
    await run(tab, { type: 'instructions.save', projectId: 'lead', baseRevision: 2, text: 'Reviews run on Opus.\nTests on the Mac.', summary: 'Tests on the Mac',
      askedBy: peer.sub }, host, lead)
    const noted = (await run(tab, { type: 'note.add', projectId: 'lead', text: 'Not machine A.', askedBy: peer.sub }, host, lead)).result.noteId as string
    await run(tab, { type: 'note.add', projectId: 'lead', text: 'Until soon.', askedBy: peer.sub, expiresAt: new Date(now + 1000).toISOString() }, host, lead)
    now += 5000
    for (const [user, as] of [[owner], [peer], [host, lead]] as Array<[AuthUser, string?]>) {
      const answer = await get(user, doc(tab, 'lead', as))
      expect(answer.statusCode, answer.body).toBe(200)
      expect(answer.json().data).toMatchObject({ projectId: 'lead', revision: 3, hash: instructionsHash('Reviews run on Opus.\nTests on the Mac.'),
        text: 'Reviews run on Opus.\nTests on the Mac.', template: false, coordinatorName: 'Product Manager', notesRevision: 2,
        notes: [{ id: noted, text: 'Not machine A.', askedBy: peer.sub, expiresAt: null }] })
    }
    const history = await get(peer, `${doc(tab)}/revisions`)
    expect(history.json().data.revisions.map((r: { revision: number }) => r.revision)).toEqual([3, 2, 1])
    expect(history.json().data.revisions[0]).toEqual({ revision: 3, hash: instructionsHash('Reviews run on Opus.\nTests on the Mac.'), summary: 'Tests on the Mac',
      writtenBy: { kind: 'agent', id: lead }, askedBy: peer.sub, at: expect.any(String) })
    expect(history.json().data.revisions[0]).not.toHaveProperty('text')
    const one = await get(peer, `${doc(tab)}/revisions/2`)
    expect(one.json().data).toMatchObject({ revision: 2, text: 'Reviews run on Opus.', writtenBy: { kind: 'person', id: owner.sub }, askedBy: owner.sub })
    expect((await get(peer, `${doc(tab)}/revisions/9`)).statusCode).toBe(404)

    // A Buddy reads its member's project's document, as their helper: not the history, nor the coordinator's notes.
    const helper = (await run(tab, { type: 'agent.add', conversationId: 'lead', machineId: 'test-host', harnessId: randomUUID(),
      name: 'Helper', configuration: config, lead: false })).result.agentId as string
    const row = await db.swarmAgent.findFirstOrThrow({ where: { tabId: tab, key: helper } })
    const people = (await store.read(owner, tab)).state.people
    await db.swarmAgent.update({ where: { id: row.id }, data: { data: { ...row.data as object,
      buddyOf: { personId: owner.sub, generation: people.find(p => p.id === owner.sub)!.generation } } } })
    const asBuddy = await get(host, doc(tab, 'lead', helper))
    expect(asBuddy.statusCode, asBuddy.body).toBe(200)
    expect(asBuddy.json().data).toMatchObject({ revision: 3, text: 'Reviews run on Opus.\nTests on the Mac.' })
    expect(asBuddy.json().data).not.toHaveProperty('notes')
    expect((await get(host, `${doc(tab, 'lead', helper).replace('?', '/revisions?')}`)).statusCode).toBe(404)
  })

  it('reads nothing of a project the reader cannot read, and the template for a project without a document yet', async () => {
    const tab = (await store.create(owner, randomUUID(), 'Pilot')).id
    await invite(tab)
    const secret = (await run(tab, { type: 'project.create', name: 'Secret', visibility: 'private', brief: '' })).result.projectId as string
    for (const url of [doc(tab, secret), `${doc(tab, secret)}/revisions`, `${doc(tab, secret)}/revisions/1`]) expect((await get(peer, url)).statusCode).toBe(404)
    expect((await get(owner, doc(tab, secret))).statusCode).toBe(200)
    // A project from before instructions, until the migration writes its document: the built-in template, revision 0.
    const head = await db.swarmHead.findFirstOrThrow({ where: { tabId: tab } })
    const data = head.data as { projects: Array<Record<string, unknown>> }
    await db.swarmHead.update({ where: { id: head.id }, data: { data: { ...data, projects: data.projects.map(({ instructionsRevision: _r, instructionsHash: _h, ...p }) => p) } as never } })
    expect((await get(owner, doc(tab))).json().data).toMatchObject({ revision: 0, hash: null, text: INSTRUCTIONS_TEMPLATE, template: true, notes: [] })
  })

  it('reads nothing to a Buddy whose person lost the private project, as every other Buddy read (review of phase 2)', async () => {
    const tab = (await store.create(owner, randomUUID(), 'Pilot')).id
    await invite(tab)
    const secret = (await run(tab, { type: 'project.create', name: 'Secret', visibility: 'private', brief: '' })).result.projectId as string
    await run(tab, { type: 'project.sharing', projectId: secret, visibility: 'private', memberIds: [peer.sub] })
    const home = (await store.read(owner, tab)).state.projects!.find(p => p.id === secret)!.leadConversationId
    const helper = (await run(tab, { type: 'agent.add', conversationId: home, machineId: 'test-host', harnessId: randomUUID(),
      name: 'Helper', configuration: config, lead: false })).result.agentId as string
    const row = await db.swarmAgent.findFirstOrThrow({ where: { tabId: tab, key: helper } })
    const people = (await store.read(owner, tab)).state.people
    await db.swarmAgent.update({ where: { id: row.id }, data: { data: { ...row.data as object,
      buddyOf: { personId: peer.sub, generation: people.find(p => p.id === peer.sub)!.generation } } } })
    const asBuddy = () => get(host, doc(tab, secret, helper))
    const before = await asBuddy()
    expect(before.statusCode, before.body).toBe(200)
    // The owner takes peer off the project; the Buddy stays, and its reads go with its person's.
    await run(tab, { type: 'project.sharing', projectId: secret, visibility: 'private', memberIds: [] })
    expect((await store.read(owner, tab)).state.agents.some(a => a.id === helper)).toBe(true)
    expect((await asBuddy()).statusCode).toBe(404)
  })
})

// An older client's saves (project instructions, phase 4, decision 3): a rule lands in the Routing section as a new revision;
// a policy, a skill set or a role is answered and kept nowhere.
describe('an older client\'s saves', () => {
  it('takes an old Desktop\'s saves', async () => {
    const { tab, lead } = await withLead()
    const policy = await app.inject({ method: 'POST', url: '/api/super-tabs/routing-policy', headers: { authorization: `Bearer ${owner.sub}` },
      payload: { revision: 0, policy: { ...DEFAULT_ROUTING_POLICY, quotaReserve: 30 } } })
    expect(policy.statusCode, policy.body).toBe(200)
    expect(policy.json().data).toMatchObject({ isDefault: true, revision: 0, ignored: true })
    expect(await db.routingPolicy.count({ where: { userId: owner.sub } })).toBe(0)
    const role = await post(owner, tab, { type: 'project.role.set', projectId: 'lead', role: { id: 'dev', name: 'Builder', kind: 'builder', text: 'Build.' } })
    expect(role.statusCode, role.body).toBe(200)
    expect(JSON.stringify(role.json())).toContain('"ignored":true')
    expect(await db.superTabRoleText.count({ where: { tabId: tab } })).toBe(0)
    // An old CLI's rule, from its Lead quoting the owner: a new revision the members' read serves.
    const said = (await run(tab, { type: 'message.send', conversationId: 'lead', text: 'No Haiku, please.', replyTo: null, recipientIds: [] })).result.messageId as string
    await run(tab, { type: 'rule.set', rule: { kind: 'forbidModel', model: 'haiku' }, text: 'No Haiku.', askedIn: { conversationId: 'lead', messageId: said } }, host, lead)
    const read = (await get(owner, `/api/super-tabs/${tab}/projects/lead/instructions`)).json().data
    expect(read).toMatchObject({ revision: 2, text: appendRouting(INSTRUCTIONS_TEMPLATE, 'No Haiku.') })
    expect(await db.superTabInstructionsRevision.findFirstOrThrow({ where: { tabId: tab, projectId: 'lead', revision: 2 } }))
      .toMatchObject({ askedBy: owner.sub, writtenByKind: 'agent', writtenBy: lead, summary: 'Routing: No Haiku.' })
    expect((await store.read(owner, tab)).state).not.toHaveProperty('rules')
  })
})

describe('the migration job', () => {
  /** A Swarm as it was before instructions: no revision on its projects and no document, with rules, a policy and roles. */
  async function oldSwarm() {
    const tab = (await store.create(owner, randomUUID(), 'Old')).id
    const custom = (await run(tab, { type: 'project.create', name: 'Custom', visibility: 'public', brief: '' })).result.projectId as string
    // An open task that requires a device: not written into the document.
    await run(tab, { type: 'conversation.create', title: 'Firmware', task: { goal: 'Flash it', changes: 'Firmware', constraints: 'None', owns: ['firmware'],
      requires: { devices: ['/dev/tty.usbmodem-board'] } }, checks: [] })
    await db.superTabInstructions.deleteMany({ where: { tabId: tab } })
    await db.superTabInstructionsRevision.deleteMany({ where: { tabId: tab } })
    // What older clients saved, as they stored it (those saves keep nothing now): a custom set with its texts, a rule, a policy.
    const texts = { lead: 'Coordinate the work.', dev: 'Build one task at a time.' }
    const roles = [{ id: 'lead', name: 'Coordinator', kind: 'lead', version: roleVersion(texts.lead) }, { id: 'dev', name: 'Builder', kind: 'builder', version: roleVersion(texts.dev) }]
    for (const [roleId, text] of Object.entries(texts)) {
      await db.superTabRoleText.create({ data: { id: stableId(tab, custom, roleId), tabId: tab, projectId: custom, roleId, version: roleVersion(text), text } })
    }
    const rules = [{ id: 'old-rule', projectId: 'lead', rule: { kind: 'preferIdle' }, text: 'Prefer idle agents before starting new ones.', askedBy: owner.sub,
      askedIn: null, addedBy: `person:${owner.sub}`, createdAt: new Date(now).toISOString() }]
    const head = await db.swarmHead.findFirstOrThrow({ where: { tabId: tab } })
    const data = head.data as { projects: Array<Record<string, unknown>> }
    const projects = data.projects.map(({ instructionsRevision: _r, instructionsHash: _h, ...p }) => p.id === custom ? { ...p, skillSet: 'custom', skillMode: 'default', roles } : p)
    await db.swarmHead.update({ where: { id: head.id }, data: { data: { ...data, projects, rules, routingPolicy: { notes: 'Opus for hard work.', quotaReserve: 25 } } as never } })
    return { tab, custom }
  }
  const rows = async (tab: string) => (await db.superTabInstructions.findMany({ where: { tabId: tab }, orderBy: { projectId: 'asc' } }))
    .map(({ updatedAt: _at, ...row }) => row)

  it('prints what it would write on a dry run, writes it once with --apply, and changes nothing when run again', async () => {
    const { tab, custom } = await oldSwarm()
    const later = (await store.create(owner, randomUUID(), 'New')).id
    const { migrateInstructions } = await import('../src/superTabs/migration/instructions.js')
    const dry = await migrateInstructions(db, { apply: false })
    const mine = dry.documents.filter(d => d.tabId === tab)
    expect(mine.map(d => [d.projectId, d.from]).sort()).toEqual([[custom, 'custom'], ['lead', 'template']].sort())
    expect(dry.documents.some(d => d.tabId === later)).toBe(false)
    expect(await rows(tab)).toEqual([])
    const lead = mine.find(d => d.projectId === 'lead')!.text
    expect(lead).toContain('- Prefer idle agents before starting new ones.')
    expect(lead).toContain('- Routing notes: Opus for hard work.')
    expect(lead).toContain('- Keep 25% of each engine\'s quota in reserve.')
    expect(mine.map(d => d.text).join('')).not.toContain('usbmodem')
    expect(mine.find(d => d.projectId === custom)!.text).toContain('### Coordinator\n\nCoordinate the work.\n\n### Builder\n\nBuild one task at a time.')

    const applied = await migrateInstructions(db, { apply: true })
    expect(applied.failed).toEqual([])
    expect(applied.documents.filter(d => d.tabId === tab)).toEqual(mine)
    const first = await rows(tab)
    expect(first.map(r => [r.projectId, r.revision, r.text]).sort()).toEqual(mine.map(d => [d.projectId, 1, d.text]).sort())
    const state = (await store.read(owner, tab)).state
    for (const document of mine) expect(state.projects!.find(p => p.id === document.projectId)).toMatchObject({ instructionsRevision: 1,
      instructionsHash: instructionsHash(document.text) })
    expect(await db.superTabInstructionsRevision.findFirstOrThrow({ where: { tabId: tab, projectId: 'lead' } })).toMatchObject({ revision: 1,
      writtenByKind: 'system', writtenBy: 'migration', askedBy: owner.sub })
    // The members' read serves the migrated text.
    expect((await get(owner, `/api/super-tabs/${tab}/projects/lead/instructions`)).json().data).toMatchObject({ revision: 1, text: lead, template: false })

    const again = await migrateInstructions(db, { apply: true })
    expect(again.documents).toEqual([])
    expect(again.alreadyDone).toBeGreaterThanOrEqual(applied.alreadyDone + applied.documents.length)
    expect(await rows(tab)).toEqual(first)
    // A save since the migration is the team's: a later run leaves it.
    await run(tab, save(1, 'Our own words.'))
    expect((await migrateInstructions(db, { apply: true })).documents).toEqual([])
    expect((await db.superTabInstructions.findFirstOrThrow({ where: { tabId: tab, projectId: 'lead' } })).text).toBe('Our own words.')
  })
})
