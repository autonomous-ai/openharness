import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import type { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import type { PrismaClient } from '@prisma/client'
import type { AuthUser } from '../src/lib/ssoAuth.js'
import { SuperTabStore, type HostsChanged } from '../src/superTabs/store.js'
import type { Command } from '../src/superTabs/commands.js'
import type { StoredCreate } from '../src/superTabs/steps.test-support.js'
import { SwarmReads } from '../src/superTabs/read/service.js'
import { listNamedIndexes } from '../src/superTabs/parts/indexed.js'
import { errorHandler } from '../src/middlewares/errorHandler.js'
import { superTabRoutes } from '../src/routes/superTabs.js'
import { storeCreate } from './storedWork.test-support.js'
import { plan, planDatabase, profiled } from './plans.test-support.js'

// Package 16 of the allocator (docs/design/2026-11-11-swarm-allocator/offers.md): a task is offered to one agent as a record on the
// Swarm's server, the referee of who may take it, since a GitHub label cannot be set "only if unset". Through the routes and the
// real store, on a fresh loopback replica set made here: who may offer, answer and read; one live offer for a task under requests
// at once; the expiry on the server's clock; and each query's plan.
let replica: MongoMemoryReplSet
let db: PrismaClient
let app: FastifyInstance
const clock = { now: Date.now() }
const pushes: HostsChanged[] = []
const user = (n: number, name: string): AuthUser => ({ sub: `36000000000000000000000${n}`, email: `${name}@example.com`, autonomousEnv: 'prod', role: 'user' })
const owner = user(1, 'owner'), peer = user(2, 'peer'), third = user(3, 'third'), stranger = user(4, 'stranger'), lender = user(5, 'lender')
const users = new Map([owner, peer, third, stranger, lender].map(u => [u.sub, u]))
const config = { engine: 'codex', model: 'fixture-model', effort: 'high', contextWindow: 200000, engineVersion: 'fixture' }
const MAC = { owner: 'offers-owner-mac', peer: 'offers-peer-mac', third: 'offers-third-mac', lent: 'offers-lent-mac' }
const ANSWER_MS = 2 * 60_000, TAKE_MS = 10 * 60_000, SHOWN_MS = 10 * 60_000
let store: SuperTabStore

beforeAll(async () => {
  ({ replica, db } = await planDatabase('super_tab_task_offers'))
  store = new SuperTabStore(db, () => clock.now, null, { hostsChanged: change => { pushes.push(change) } })
  for (const u of users.values()) await db.user.create({ data: { id: u.sub, externalId: `fixture-${u.sub}`, email: u.email, autonomousEnv: u.autonomousEnv } })
  for (const [index, [machineId, userId]] of [[MAC.owner, owner.sub], [MAC.peer, peer.sub], [MAC.third, third.sub], [MAC.lent, lender.sub]].entries()) {
    await db.machine.create({ data: { machineId: machineId!, userId: userId!, computerId: String(index + 1).repeat(32), sessionKind: 'computer',
      apiKey: `fixture-${machineId}`, managerId: 'fixture', autonomousEnv: 'prod', authMode: 'remote' } })
  }
  // The lender's computer, lent to the peer: an agent of the peer's there runs under the lender's sign-in.
  await db.machineShare.create({ data: { machineId: MAC.lent, ownerId: lender.sub, autonomousEnv: 'prod', emails: [peer.email] } })
  app = Fastify()
  app.setErrorHandler(errorHandler)
  app.addHook('onRequest', async request => { request.user = users.get(String(request.headers['x-user'])) as never })
  await app.register(superTabRoutes, { store, reads: new SwarmReads(store), github: null, hosts: {} as never, signIn: null,
    approvals: { approved: async () => false, approvedProjects: async () => [] } as never })
  await app.ready()
  await listNamedIndexes(db)
}, 180_000)
afterAll(async () => {
  await app?.close()
  await db?.$disconnect()
  await replica?.stop()
})

/** One call of a route as [as], and what it answered: its status, its data, or the code it refused with. */
async function call(as: AuthUser, method: 'GET' | 'POST', path: string, payload?: object) {
  const res = await app.inject({ method, url: `/api/super-tabs/${path}`, headers: { 'x-user': as.sub }, payload: payload as never })
  const body = res.json() as { data?: Record<string, unknown>; error?: { code?: string } }
  return { status: res.statusCode, data: body.data, code: body.error?.code }
}

/** The owner's Swarm with the peer and a third member in it. Project Web, on github.com/Acme/App, has its PM Juno on the owner's
 *  computer; project Docs, with no repository, its PM Ivy there too. Each person has an agent of their own on their own computer:
 *  Ada (the owner's), Oak (the peer's), Ash (the third's). On a computer the lender lent the peer run two of the peer's agents:
 *  Elm, a builder of Web, and Kit, the PM of the peer's project Lent on github.com/Acme/Lent. The third member made a project of
 *  their own on Web's repository after Web, Second, whose PM Moss runs on their computer. */
async function scene() {
  const tab = (await store.create(owner, randomUUID(), 'Offers')).id
  const run = (command: Command | StoredCreate, as: AuthUser = owner) => command.type === 'conversation.create' ? storeCreate(db, tab, command, as)
    : store.execute(as, tab, { operationId: randomUUID(), command })
  for (const member of [peer, third]) {
    const invitation = await run({ type: 'invite.create', email: member.email, role: 'collaborator', conversationId: 'lead' })
    await run({ type: 'invite.accept', inviteId: invitation.result.inviteId as string }, member)
  }
  // The third member's project Early, made before Web with no repository and no PM yet: given Web's repository later, it does not
  // coordinate it (review of #4152).
  const early = (await run({ type: 'project.create', name: 'Early', visibility: 'public', brief: '' }, third)).result as { projectId: string; conversationId: string }
  const project = async (name: string, repositoryUrl: string | null, pm: string) => {
    const made = (await run({ type: 'project.create', name, visibility: 'public', brief: '' })).result as { projectId: string; conversationId: string }
    const agentId = String((await run({ type: 'agent.add', conversationId: made.conversationId, machineId: MAC.owner, harnessId: randomUUID(), name: pm,
      configuration: config, lead: true, project: { cwd: `/work/${name}`, repositoryUrl } } as Command)).result.agentId)
    return { ...made, agentId }
  }
  const web = await project('Web', 'https://github.com/Acme/App.git', 'Juno')
  const docs = await project('Docs', null, 'Ivy')
  const own = async (person: AuthUser, machineId: string, name: string) => {
    const chat = String((await run({ type: 'agent.new', kind: 'regular', machineId, engine: 'codex', name, local: true } as Command, person)).result.conversationId)
    return String((await run({ type: 'agent.add', conversationId: chat, machineId, harnessId: randomUUID(), name, configuration: config, lead: false } as Command, person)).result.agentId)
  }
  const ada = await own(owner, MAC.owner, 'Ada'), oak = await own(peer, MAC.peer, 'Oak'), ash = await own(third, MAC.third, 'Ash')
  const task = String((await run({ type: 'conversation.create', projectId: web.projectId, title: 'Work', brief: 'Do it',
    checks: [{ description: 'Verified', independent: false }] })).result.conversationId)
  const elm = String((await run({ type: 'agent.add', conversationId: task, machineId: MAC.lent, harnessId: randomUUID(), name: 'Elm',
    configuration: config, lead: false } as Command, peer)).result.agentId)
  const lent = (await run({ type: 'project.create', name: 'Lent', visibility: 'public', brief: '' }, peer)).result as { projectId: string; conversationId: string }
  const kit = String((await run({ type: 'agent.add', conversationId: lent.conversationId, machineId: MAC.lent, harnessId: randomUUID(), name: 'Kit',
    configuration: config, lead: true, project: { cwd: '/work/Lent', repositoryUrl: 'https://github.com/Acme/Lent.git' } } as Command, peer)).result.agentId)
  const second = (await run({ type: 'project.create', name: 'Second', visibility: 'public', brief: '' }, third)).result as { projectId: string; conversationId: string }
  const moss = String((await run({ type: 'agent.add', conversationId: second.conversationId, machineId: MAC.third, harnessId: randomUUID(), name: 'Moss',
    configuration: config, lead: true, project: { cwd: '/work/Second', repositoryUrl: 'https://github.com/acme/app' } } as Command, third)).result.agentId)
  const t = `${tab}/task-offers`
  return { tab, web, docs, ada, oak, ash, elm, kit, second, moss, early, run,
    offer: (number: number, agentId: string, as: AuthUser = owner, pm = web.agentId, repository = 'acme/app') =>
      call(as, 'POST', `${t}?asAgentId=${pm}`, { repository, number, agentId }),
    accept: (number: number, agentId: string, as: AuthUser, repository = 'acme/app') => call(as, 'POST', `${t}/accept?asAgentId=${agentId}`, { repository, number }),
    decline: (number: number, agentId: string, as: AuthUser, reason = 'memory') => call(as, 'POST', `${t}/decline?asAgentId=${agentId}`, { repository: 'acme/app', number, reason }),
    mine: (agentId: string, as: AuthUser) => call(as, 'GET', `${t}/mine?asAgentId=${agentId}`),
    listed: (as: AuthUser, agentId?: string, repository = 'acme/app', numbers: readonly number[] = [1, 2, 3]) =>
      call(as, 'GET', `${t}?repository=${repository}&numbers=${numbers.join(',')}${agentId ? `&asAgentId=${agentId}` : ''}`),
    row: (number: number) => db.superTabTaskOffer.findUnique({ where: { id: `${tab}|acme/app|${number}` } }) }
}
type Scene = Awaited<ReturnType<typeof scene>>
let s: Scene
beforeAll(async () => { s = await scene() }, 120_000)

describe('offering a task', () => {
  it('is the project\'s PM\'s alone, from the computer that runs it: the record names the task and its agent, and its computer is told', async () => {
    pushes.length = 0
    const made = await s.offer(101, s.oak)
    expect(made).toMatchObject({ status: 200, data: { serverTime: clock.now,
      offer: { repository: 'acme/app', number: 101, agentId: s.oak, state: 'offered', offeredAt: clock.now, expiresAt: clock.now + ANSWER_MS } } })
    expect(await s.row(101)).toMatchObject({ tabId: s.tab, projectId: s.web.projectId, repository: 'acme/app', number: 101, agentId: s.oak,
      offeredAt: new Date(clock.now), expiresAt: new Date(clock.now + ANSWER_MS), acceptedAt: null, declinedAt: null, declined: null })
    // The offered agent's computer alone hears that its Swarm changed: its daemon reads the offer at once.
    expect(pushes).toEqual([{ tabId: s.tab, machineIds: [MAC.peer], lastChangedAt: clock.now }])
  })

  it('is refused to another member speaking as the PM, to an agent that is not the PM, and to the PM of another project', async () => {
    // The peer's computer does not run Juno.
    expect(await s.offer(110, s.oak, peer)).toMatchObject({ status: 403, code: 'FORBIDDEN' })
    // Oak is the peer's own agent, and no project's PM.
    expect(await s.offer(110, s.ash, peer, s.oak)).toMatchObject({ status: 403, code: 'PM_REQUIRED' })
    // Ivy leads Docs, which has no repository; Juno leads no project on acme/other.
    expect(await s.offer(110, s.oak, owner, s.docs.agentId)).toMatchObject({ status: 403, code: 'PM_REQUIRED' })
    expect(await s.offer(110, s.oak, owner, s.web.agentId, 'acme/other')).toMatchObject({ status: 403, code: 'PM_REQUIRED' })
    // Someone outside the Swarm hears what a Swarm that does not exist says.
    expect(await s.offer(110, s.oak, stranger)).toMatchObject({ status: 404, code: 'NOT_FOUND' })
    expect(await s.row(110)).toBeNull()
  })

  it('is refused to the owner of a lent computer for another person\'s PM there, and to that person from any other computer', async () => {
    const offered = (as: AuthUser) => call(as, 'POST', `${s.tab}/task-offers?asAgentId=${s.kit}`, { repository: 'acme/lent', number: 130, agentId: s.oak })
    // The lender's computer runs Kit, but Kit is the peer's agent: the coordinator is the PM's own person's daemon.
    expect(await offered(lender)).toMatchObject({ status: 403, code: 'FORBIDDEN' })
    expect(await offered(peer)).toMatchObject({ status: 403, code: 'FORBIDDEN' })
    expect(await db.superTabTaskOffer.count({ where: { tabId: s.tab, repository: 'acme/lent' } })).toBe(0)
  })

  // Review of #4152: a project's repository is set by its owner or lead with no proof of access, so a member could make a second
  // project on a repository and hold its tasks with offers to their own agents. A repository has one coordinator in a Swarm.
  it('is the PM\'s of the project that got the repository first alone: a later project on it offers nothing', async () => {
    expect(await s.offer(140, s.ash, third, s.moss)).toMatchObject({ status: 403, code: 'PM_REQUIRED' })
    expect(await s.row(140)).toBeNull()
    expect(await s.offer(140, s.ash)).toMatchObject({ status: 200, data: { offer: { agentId: s.ash } } })
  })

  // Review of #4152: an agent on a computer lent to its person can never answer (the lender's sign-in runs it), so its offer would
  // only hold the task until it lapsed.
  it('is refused for an agent on a computer lent to its person, which cannot answer for it', async () => {
    expect(await s.offer(150, s.elm)).toMatchObject({ status: 422, code: 'AGENT_NOT_OWN_COMPUTER' })
    expect(await s.row(150)).toBeNull()
  })

  it('is refused for an agent that does not read the project, in one answer whether it exists or not, and for the PM itself', async () => {
    for (const agentId of [s.web.agentId, s.docs.agentId, 'no-such-agent']) {
      expect(await s.offer(120, agentId), agentId).toMatchObject({ status: 422, code: 'AGENT_NOT_IN_PROJECT' })
    }
    expect(await s.row(120)).toBeNull()
  })

  it('refuses what is no task: a number that is not a positive whole one, a repository that is no owner/name, a field too many', async () => {
    const post = (body: object) => call(owner, 'POST', `${s.tab}/task-offers?asAgentId=${s.web.agentId}`, body)
    for (const body of [{ repository: 'acme/app', number: 0, agentId: s.oak }, { repository: 'acme/app', number: 1.5, agentId: s.oak },
      { repository: 'acme/app', number: '7', agentId: s.oak }, { repository: 'acme', number: 7, agentId: s.oak },
      { repository: 'acme/app', number: 7, agentId: s.oak, expiresAt: clock.now + 86_400_000 }, { repository: 'acme/app', number: 7 }]) {
      expect(await post(body), JSON.stringify(body)).toMatchObject({ status: 400 })
    }
    expect(await call(owner, 'POST', `${s.tab}/task-offers`, { repository: 'acme/app', number: 7, agentId: s.oak })).toMatchObject({ status: 400 })
    expect(await s.row(7)).toBeNull()
  })
})

describe('one live offer for a task', () => {
  it('refuses a second offer of it to another agent, and answers the same offer again as it stands', async () => {
    const first = await s.offer(201, s.oak)
    clock.now += 30_000
    expect(await s.offer(201, s.ash)).toMatchObject({ status: 409, code: 'OFFER_LIVE' })
    expect(await s.offer(201, s.oak)).toMatchObject({ status: 200, data: { offer: first.data!.offer } })
    expect(await s.row(201)).toMatchObject({ agentId: s.oak })
  })

  it('holds under offers of one task at once: one agent has it, every other is refused, and one record stands', async () => {
    const agents = [s.oak, s.ash, s.ada]
    const answers = await Promise.all(Array.from({ length: 12 }, (_, i) => s.offer(202, agents[i % 3]!)))
    const won = answers.filter(a => a.status === 200), lost = answers.filter(a => a.status !== 200)
    const winner = (await s.row(202))!.agentId
    // The winner's own repeats are answered the standing offer; nobody else's offer went through.
    expect(new Set(won.map(a => (a.data!.offer as { agentId: string }).agentId))).toEqual(new Set([winner]))
    expect(won.length).toBe(4)
    expect(lost.map(a => [a.status, a.code])).toEqual(Array.from({ length: 8 }, () => [409, 'OFFER_LIVE']))
    expect(await db.superTabTaskOffer.count({ where: { tabId: s.tab, number: 202 } })).toBe(1)
  })

  it('holds under offers at once for a task whose offer lapsed: one takes its place', async () => {
    await s.offer(203, s.ada)
    clock.now += ANSWER_MS
    const answers = await Promise.all([s.oak, s.ash].flatMap(agentId => Array.from({ length: 5 }, () => s.offer(203, agentId))))
    const winner = (await s.row(203))!.agentId
    expect([s.oak, s.ash]).toContain(winner)
    expect(answers.filter(a => a.status === 200).length).toBe(5)
    expect(answers.filter(a => a.status === 200).every(a => (a.data!.offer as { agentId: string }).agentId === winner)).toBe(true)
    expect(answers.filter(a => a.status !== 200).map(a => a.code)).toEqual(Array.from({ length: 5 }, () => 'OFFER_LIVE'))
    expect(await s.row(203)).toMatchObject({ offeredAt: new Date(clock.now), expiresAt: new Date(clock.now + ANSWER_MS), acceptedAt: null })
  })

  it('says what each write rests on in the write itself, never in a read before it', async () => {
    // Prisma's own updateMany reads the ids its filter matches, then updates by id alone: of two requests at once both win, and an
    // accept that read its own live offer would mark the next agent's. Each write here carries its whole condition.
    await s.offer(210, s.oak)
    clock.now += ANSWER_MS
    const writes = async (run: () => Promise<{ status: number }>) => {
      let answered = 0
      const entries = await profiled(db, async () => { answered = (await run()).status })
      expect(answered).toBe(200)
      return entries.filter(e => e.ns.endsWith('.SuperTabTaskOffer') && (e.op === 'update' || e.command?.query !== undefined))
        .map(e => JSON.stringify(e.command?.q ?? e.command?.query))
    }
    const sent = { offer: await writes(() => s.offer(210, s.ash)), accept: await writes(() => s.accept(210, s.ash, third)), decline: await writes(() => s.decline(210, s.ash, third)) }
    for (const [name, conditions] of Object.entries(sent)) {
      expect(conditions.length, name).toBe(1)
      expect(conditions[0], name).toContain('"_id"')
      expect(conditions[0], name).toContain('"expiresAt"')
    }
    expect(sent.offer[0]).toContain('"$lte"')
    for (const answer of [sent.accept[0], sent.decline[0]]) {
      expect(answer).toContain('"$gt"')
      expect(answer).toContain(`"agentId":"${s.ash}"`)
    }
    expect(sent.accept[0]).toContain('"acceptedAt":null')
  })

  it('lets no answer to a lapsed offer through while a new offer takes its place, whichever comes first', async () => {
    for (const number of [204, 205, 206, 207]) {
      await s.offer(number, s.oak)
    }
    clock.now += ANSWER_MS
    const raced = await Promise.all([204, 205, 206, 207].flatMap(number => [s.accept(number, s.oak, peer), s.offer(number, s.ash)]))
    for (const [i, number] of [204, 205, 206, 207].entries()) {
      expect(raced[2 * i], `accept ${number}`).toMatchObject({ status: 409, code: 'OFFER_NOT_LIVE' })
      expect(raced[2 * i + 1], `offer ${number}`).toMatchObject({ status: 200 })
      expect(await s.row(number)).toMatchObject({ agentId: s.ash, acceptedAt: null })
    }
  })
})

// Review of #4152, round two: the first project MADE on a repository was its coordinator, but a project with no address can get one
// later, by its lead's first agent.add or by project.repository: a member's older project given a repository after its owner's
// became its only coordinator. The coordinator is the project that GOT the repository first, and has a PM.
describe('the coordinator of a repository', () => {
  const lead = (t: Scene, as: AuthUser, machineId: string, name: string, repositoryUrl: string | null, conversationId = t.early.conversationId) =>
    t.run({ type: 'agent.add', conversationId, machineId, harnessId: randomUUID(), name, configuration: config, lead: true,
      project: { cwd: `/work/${name}`, repositoryUrl } } as Command, as).then(made => String(made.result.agentId))

  it('is not a project made earlier and given the repository later by its lead\'s first agent.add', async () => {
    const t = await scene()
    clock.now += 1_000
    const fern = await lead(t, third, MAC.third, 'Fern', 'https://github.com/Acme/App.git')
    expect(await t.offer(1, t.ash, third, fern)).toMatchObject({ status: 403, code: 'PM_REQUIRED' })
    expect(await t.offer(1, t.oak)).toMatchObject({ status: 200, data: { offer: { agentId: t.oak } } })
    expect(await t.listed(peer, undefined, 'acme/app', [1])).toMatchObject({ status: 200, data: { offers: [expect.objectContaining({ number: 1, agentId: t.oak })] } })
  })

  it('is not a project made earlier and given the repository later by project.repository', async () => {
    const t = await scene()
    const fern = await lead(t, third, MAC.third, 'Fern', null)
    clock.now += 1_000
    await t.run({ type: 'project.repository', projectId: t.early.projectId, repositoryUrl: 'https://github.com/Acme/App.git' } as Command, third)
    expect(await t.offer(2, t.ash, third, fern)).toMatchObject({ status: 403, code: 'PM_REQUIRED' })
    expect(await t.offer(2, t.oak)).toMatchObject({ status: 200, data: { offer: { agentId: t.oak } } })
  })

  it('passes to the next project when the first is deleted, and lists the new coordinator\'s offers alone', async () => {
    const t = await scene()
    const made = async (name: string) => (await t.run({ type: 'project.create', name, visibility: 'public', brief: '' })).result as { projectId: string; conversationId: string }
    const first = await made('Solo one'), next = await made('Solo two')
    const lark = await lead(t, owner, MAC.owner, 'Lark', 'https://github.com/Acme/Solo.git', first.conversationId)
    const wren = await lead(t, owner, MAC.owner, 'Wren', 'https://github.com/Acme/Solo.git', next.conversationId)
    expect(await t.offer(1, t.oak, owner, lark, 'acme/solo')).toMatchObject({ status: 200 })
    expect(await t.offer(2, t.oak, owner, wren, 'acme/solo')).toMatchObject({ status: 403, code: 'PM_REQUIRED' })
    // The first deleted, its PM with it, the next coordinates.
    await t.run({ type: 'project.delete', projectId: first.projectId } as Command)
    expect(await t.offer(2, t.oak, owner, wren, 'acme/solo')).toMatchObject({ status: 200 })
    // The old coordinator's offer, still live, is its project's and is not listed for the new one's.
    const listed = await t.listed(owner, wren, 'acme/solo', [1, 2])
    expect(((listed.data!.offers as Array<{ number: number }>).map(o => o.number))).toEqual([2])
  })

  it('is the only project whose offers are read: a reader of a later project alone hears what a project that does not exist says', async () => {
    const t = await scene()
    await t.offer(4, t.oak)
    // Moss leads Second, made on Web's repository after it, and reads Second alone.
    expect(await t.listed(third, t.moss, 'acme/app', [4])).toMatchObject({ status: 404, code: 'NOT_FOUND' })
    expect(await t.listed(owner, t.web.agentId, 'acme/app', [4])).toMatchObject({ status: 200, data: { offers: [expect.objectContaining({ number: 4 })] } })
  })
})

describe('answering an offer', () => {
  it('is its own agent\'s alone, from its own person\'s computer: accepted, it is live ten minutes more', async () => {
    await s.offer(301, s.oak)
    clock.now += 5_000
    // Ash is the third member's own agent, on their own computer, and was not offered it.
    expect(await s.accept(301, s.ash, third)).toMatchObject({ status: 409, code: 'OFFER_NOT_LIVE' })
    expect(await s.decline(301, s.ash, third)).toMatchObject({ status: 409, code: 'OFFER_NOT_LIVE' })
    // Neither the third member nor the PM's person runs Oak.
    for (const other of [third, owner]) {
      expect(await s.accept(301, s.oak, other)).toMatchObject({ status: 403, code: 'FORBIDDEN' })
      expect(await s.decline(301, s.oak, other)).toMatchObject({ status: 403, code: 'FORBIDDEN' })
    }
    expect(await s.accept(301, s.oak, stranger)).toMatchObject({ status: 404, code: 'NOT_FOUND' })
    expect(await s.row(301)).toMatchObject({ acceptedAt: null, declinedAt: null, expiresAt: new Date(clock.now - 5_000 + ANSWER_MS) })
    const accepted = await s.accept(301, s.oak, peer)
    expect(accepted).toMatchObject({ status: 200, data: { serverTime: clock.now,
      offer: { repository: 'acme/app', number: 301, agentId: s.oak, state: 'accepted', acceptedAt: clock.now, expiresAt: clock.now + TAKE_MS } } })
    // Accepted, it is still no other agent's to accept or to be told of.
    expect(await s.accept(301, s.ash, third)).toMatchObject({ status: 409, code: 'OFFER_NOT_LIVE' })
    // Asked again, it answers the same and extends nothing.
    clock.now += 4 * 60_000
    expect(await s.accept(301, s.oak, peer)).toMatchObject({ status: 200, data: { serverTime: clock.now, offer: accepted.data!.offer } })
    // While it is live the task is offered to nobody else; ten minutes after the accept it is.
    expect(await s.offer(301, s.ash)).toMatchObject({ status: 409, code: 'OFFER_LIVE' })
    clock.now += 6 * 60_000
    expect(await s.accept(301, s.oak, peer)).toMatchObject({ status: 409, code: 'OFFER_NOT_LIVE' })
    expect(await s.offer(301, s.ash)).toMatchObject({ status: 200, data: { offer: { agentId: s.ash, state: 'offered' } } })
  })

  it('refuses the owner of a lent computer answering for another person\'s agent there, and that person from any other computer', async () => {
    // No offer is made to Elm (above); one stored all the same is answered by nobody.
    await db.superTabTaskOffer.create({ data: { id: `${s.tab}|acme/app|302`, tabId: s.tab, projectId: s.web.projectId, repository: 'acme/app', number: 302,
      agentId: s.elm, offeredAt: new Date(clock.now), expiresAt: new Date(clock.now + ANSWER_MS), acceptedAt: null, declinedAt: null, declined: null } })
    // The lender's computer runs Elm, but Elm is the peer's agent: a task is taken in its own person's name.
    expect(await s.accept(302, s.elm, lender)).toMatchObject({ status: 403, code: 'FORBIDDEN' })
    expect(await s.decline(302, s.elm, lender)).toMatchObject({ status: 403, code: 'FORBIDDEN' })
    expect(await s.mine(s.elm, lender)).toMatchObject({ status: 403, code: 'FORBIDDEN' })
    // The peer is Elm's person, and not signed in on the computer that runs it.
    expect(await s.accept(302, s.elm, peer)).toMatchObject({ status: 403, code: 'FORBIDDEN' })
    expect(await s.row(302)).toMatchObject({ acceptedAt: null, declinedAt: null })
  })

  it('is too late two minutes after an offer nobody answered', async () => {
    await s.offer(303, s.oak)
    clock.now += ANSWER_MS - 1
    expect(await s.mine(s.oak, peer)).toMatchObject({ data: { offers: expect.arrayContaining([expect.objectContaining({ number: 303, state: 'offered' })]) } })
    clock.now += 1
    expect(await s.accept(303, s.oak, peer)).toMatchObject({ status: 409, code: 'OFFER_NOT_LIVE' })
    expect(await s.decline(303, s.oak, peer)).toMatchObject({ status: 409, code: 'OFFER_NOT_LIVE' })
    expect(await s.row(303)).toMatchObject({ acceptedAt: null, declinedAt: null })
  })

  it('declined, ends at once with its reason, and the task is offered to the next agent', async () => {
    await s.offer(304, s.oak)
    clock.now += 2_000
    const declined = await s.decline(304, s.oak, peer, 'disk')
    expect(declined).toMatchObject({ status: 200, data: { offer: { number: 304, agentId: s.oak, state: 'declined', declined: 'disk', expiresAt: clock.now } } })
    expect(await s.decline(304, s.oak, peer, 'memory')).toMatchObject({ status: 200, data: { offer: declined.data!.offer } })
    expect(await s.decline(304, s.ash, third)).toMatchObject({ status: 409, code: 'OFFER_NOT_LIVE' })
    expect(await s.accept(304, s.oak, peer)).toMatchObject({ status: 409, code: 'OFFER_NOT_LIVE' })
    expect(await s.offer(304, s.ash)).toMatchObject({ status: 200, data: { offer: { agentId: s.ash, state: 'offered' } } })
    expect(await s.row(304)).toMatchObject({ agentId: s.ash, declinedAt: null, declined: null })
    // An accepted offer may still be declined while it is live: its agent could not take it after all.
    await s.accept(304, s.ash, third)
    expect(await s.decline(304, s.ash, third, 'limit')).toMatchObject({ status: 200, data: { offer: { state: 'declined', declined: 'limit' } } })
  })

  // Review of #4152: an accept whose clock read a moment before a decline's held the declined task ten minutes more.
  it('is not accepted after its decline, though the accept\'s clock reads a moment before the decline\'s', async () => {
    await s.offer(306, s.oak)
    const at = clock.now
    clock.now = at + 5
    await s.decline(306, s.oak, peer)
    clock.now = at + 4
    expect(await s.accept(306, s.oak, peer)).toMatchObject({ status: 409, code: 'OFFER_NOT_LIVE' })
    expect(await s.row(306)).toMatchObject({ acceptedAt: null, declined: 'memory', expiresAt: new Date(at + 5) })
    clock.now = at + 5
  })

  it('takes one lower-case word as a reason, and no other', async () => {
    await s.offer(305, s.oak)
    for (const reason of ['No room', 'memory: 2 GB of 16', '', 'a'.repeat(21), 7]) {
      expect(await call(peer, 'POST', `${s.tab}/task-offers/decline?asAgentId=${s.oak}`, { repository: 'acme/app', number: 305, reason }), String(reason)).toMatchObject({ status: 400 })
    }
    expect(await call(peer, 'POST', `${s.tab}/task-offers/decline?asAgentId=${s.oak}`, { repository: 'acme/app', number: 305 })).toMatchObject({ status: 400 })
    expect(await s.row(305)).toMatchObject({ declinedAt: null })
  })
})

describe('reading offers', () => {
  it('gives an agent its own live offers, to its own person\'s computer alone', async () => {
    const t = await scene()
    await t.offer(1, t.oak)
    await t.offer(2, t.oak)
    await t.offer(3, t.ash)
    await t.accept(2, t.oak, peer)
    await t.offer(4, t.oak)
    await t.decline(4, t.oak, peer)
    const mine = await t.mine(t.oak, peer)
    expect(mine).toMatchObject({ status: 200, data: { serverTime: clock.now } })
    expect((mine.data!.offers as Array<{ number: number; state: string }>).map(o => [o.number, o.state])).toEqual([[1, 'offered'], [2, 'accepted']])
    expect(await t.mine(t.oak, third)).toMatchObject({ status: 403, code: 'FORBIDDEN' })
    expect(await t.mine(t.oak, stranger)).toMatchObject({ status: 404, code: 'NOT_FOUND' })
    // Lapsed, an offer leaves its agent's list.
    clock.now += ANSWER_MS
    expect((await t.mine(t.oak, peer)).data!.offers).toEqual([expect.objectContaining({ number: 2, state: 'accepted' })])
  })

  it('gives the project\'s readers its offers, live or ended in the last ten minutes, and nobody else', async () => {
    const t = await scene()
    const at = clock.now
    await t.offer(1, t.oak)
    await t.offer(2, t.ash)
    await t.accept(2, t.ash, third)
    await t.offer(3, t.ada)
    await t.decline(3, t.ada, owner, 'quota')
    const expected = [
      { repository: 'acme/app', number: 2, agentId: t.ash, state: 'accepted', offeredAt: at, acceptedAt: at, expiresAt: at + TAKE_MS },
      { repository: 'acme/app', number: 1, agentId: t.oak, state: 'offered', offeredAt: at, expiresAt: at + ANSWER_MS },
      { repository: 'acme/app', number: 3, agentId: t.ada, state: 'declined', offeredAt: at, expiresAt: at, declined: 'quota' },
    ]
    // The PM, a member, and a member's agent that reads the project, by any case of the repository's name.
    for (const [as, agentId] of [[owner, t.web.agentId], [peer, undefined], [third, t.ash]] as const) {
      expect(await t.listed(as, agentId, 'Acme/App'), as.email).toEqual({ status: 200, code: undefined, data: { offers: expected, serverTime: at } })
    }
    expect(await t.listed(stranger)).toMatchObject({ status: 404, code: 'NOT_FOUND' })
    expect(await t.listed(peer, undefined, 'acme/other')).toMatchObject({ status: 404, code: 'NOT_FOUND' })
    // Ivy leads Docs and reads no project on this repository; the third member does not run Juno.
    expect(await t.listed(owner, t.docs.agentId)).toMatchObject({ status: 404, code: 'NOT_FOUND' })
    expect(await t.listed(third, t.web.agentId)).toMatchObject({ status: 403, code: 'FORBIDDEN' })
    // An offer that lapsed reads as lapsed, for ten minutes after it ended; then it is listed no more.
    clock.now = at + ANSWER_MS
    expect(((await t.listed(peer)).data!.offers as Array<{ number: number; state: string }>).map(o => [o.number, o.state]))
      .toEqual([[2, 'accepted'], [1, 'lapsed'], [3, 'declined']])
    clock.now = at + SHOWN_MS
    expect(((await t.listed(peer)).data!.offers as Array<{ number: number }>).map(o => o.number)).toEqual([2, 1])
    clock.now = at + ANSWER_MS + SHOWN_MS
    expect(((await t.listed(peer)).data!.offers as Array<{ number: number }>).map(o => o.number)).toEqual([2])
  })

  // Review of #4152: a project's read listed at most two hundred and said there were more, with no way to read them: about seven
  // times today, below the design's own case of ten. Its PM asks for the tasks it plans.
  it('lists the offers of the tasks its reader asks about, a hundred at most a read', async () => {
    const t = await scene()
    const row = (number: number, expiresAt: number) => ({ id: `${t.tab}|acme/app|${number}`, tabId: t.tab, projectId: t.web.projectId, repository: 'acme/app', number,
      agentId: t.oak, offeredAt: new Date(clock.now), expiresAt: new Date(expiresAt), acceptedAt: null, declinedAt: null, declined: null })
    await db.superTabTaskOffer.createMany({ data: Array.from({ length: 201 }, (_, i) => row(i + 1, clock.now + 1_000 + i)) })
    const hundred = Array.from({ length: 100 }, (_, i) => i + 101)
    const listed = await t.listed(peer, undefined, 'acme/app', hundred)
    expect(((listed.data!.offers as Array<{ number: number }>).map(o => o.number))).toEqual([...hundred].reverse())
    expect(((await t.listed(peer, undefined, 'acme/app', [201, 5, 9_999])).data!.offers as Array<{ number: number }>).map(o => o.number)).toEqual([201, 5])
    expect(await t.listed(peer, undefined, 'acme/app', [...hundred, 1])).toMatchObject({ status: 400 })
    expect(await t.listed(peer, undefined, 'acme/app', [])).toMatchObject({ status: 400 })
    // An agent's own list holds at most twenty, the ones that end first.
    const mine = (await t.mine(t.oak, peer)).data!.offers as Array<{ number: number }>
    expect(mine.map(o => o.number)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1))
  })
})

describe('each query of an offer', () => {
  it('reads by an index and examines no document it does not use', async () => {
    const t = await scene()
    const at = clock.now
    const row = (tabId: string, projectId: string, number: number, agentId: string, expiresAt: number) => ({ id: `${tabId}|acme/app|${number}`, tabId, projectId,
      repository: 'acme/app', number, agentId, offeredAt: new Date(at), expiresAt: new Date(expiresAt), acceptedAt: null, declinedAt: null, declined: null })
    // Other Swarms' and another project's offers, and this project's long ended ones: none is this read's to examine.
    await db.superTabTaskOffer.createMany({ data: [
      ...Array.from({ length: 150 }, (_, i) => row(`other-${i % 5}`, t.web.projectId, i + 1, t.oak, at + 60_000)),
      ...Array.from({ length: 60 }, (_, i) => row(t.tab, 'another-project', 1_000 + i, t.oak, at + 60_000)),
      ...Array.from({ length: 80 }, (_, i) => row(t.tab, t.web.projectId, 2_000 + i, i % 2 ? t.oak : t.ash, at - SHOWN_MS - 1 - i)),
      ...Array.from({ length: 4 }, (_, i) => row(t.tab, t.web.projectId, 3_000 + i, t.oak, at - 30_000)),
    ] })
    await t.offer(11, t.oak)
    await t.offer(12, t.ash)
    await t.offer(13, t.ash)
    const on = async (run: () => Promise<{ status: number }>) => {
      let answered = 0
      const entries = await profiled(db, async () => { answered = (await run()).status })
      expect(answered).toBe(200)
      return plan(entries.filter(e => e.ns.endsWith('.SuperTabTaskOffer') && e.op !== 'insert'))
    }
    // The project's, for the tasks its PM asks about: its three live offers and the four ended half a minute ago, each by its id.
    // A key for each task asked, and the seeks between them: at most two for each (nine for these seven, measured).
    const project = await on(() => t.listed(peer, undefined, 'acme/app', [11, 12, 13, 3_000, 3_001, 3_002, 3_003]))
    expect(project).toEqual([{ plan: 'IXSCAN { _id: 1 }', docsExamined: 7, keysExamined: expect.any(Number), returned: 7, hint: { _id: 1 } }])
    expect(project[0]!.keysExamined).toBeLessThanOrEqual(2 * 7)
    // An agent's: Ash's two live ones, of its forty-two records in this Swarm.
    const mine = await on(() => t.mine(t.ash, third))
    expect(mine).toEqual([{ plan: 'IXSCAN { tabId: 1, agentId: 1, expiresAt: 1 }', docsExamined: 2, keysExamined: 2, returned: 2, hint: { tabId: 1, agentId: 1, expiresAt: 1 } }])
    // Each write and the read before it: the task's one document, by its id.
    const byId = (plans: Array<{ plan?: string; docsExamined?: number; keysExamined?: number }>) => {
      expect(plans.length).toBeGreaterThan(0)
      for (const one of plans) {
        expect(one.plan, JSON.stringify(plans)).toMatch(/^(IDHACK|EXPRESS_IXSCAN \{ _id: 1 \}|IXSCAN \{ _id: 1 \})/)
        expect(one.docsExamined ?? 0, JSON.stringify(plans)).toBeLessThanOrEqual(1)
        expect(one.keysExamined ?? 0, JSON.stringify(plans)).toBeLessThanOrEqual(1)
      }
    }
    byId(await on(() => t.accept(12, t.ash, third)))
    byId(await on(() => t.accept(12, t.ash, third)))
    byId(await on(() => t.decline(13, t.ash, third)))
    byId(await on(() => t.offer(11, t.oak)))
    // An offer that takes the place of an ended one: the failed insert, then one update by id.
    byId(await on(() => t.offer(13, t.oak)))
    clock.now += ANSWER_MS
    byId(await on(() => t.offer(11, t.ash)))
  })
})
