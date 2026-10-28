import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import Fastify, { type FastifyInstance } from 'fastify'
import type { PrismaClient } from '@prisma/client'

// Telling other apps goes through Redis; nothing here depends on it being told.
vi.mock('../src/lib/bus.js', () => ({ publishAgentMessageShareChanged: vi.fn(async () => 0), publishDeskChanged: vi.fn(async () => 0),
  publishDeviceMachineListChanged: vi.fn(async () => 0), publishMachineShareChanged: vi.fn(async () => 0) }))

// A fresh loopback replica set, created here. This suite never reads an existing database: the app's own Prisma client
// is pointed at it before anything imports it.
let replica: MongoMemoryReplSet
let db: PrismaClient
let app: FastifyInstance
const owner = { sub: '6a0000000000000000000a01', email: 'owner@acme.dev', autonomousEnv: 'prod', role: 'user' }
const guest = { sub: '6a0000000000000000000a02', email: 'guest@acme.dev', autonomousEnv: 'prod', role: 'user' }
const TRIES = 40

beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ binary: { version: '7.0.24', downloadDir: join(tmpdir(), 'harness-super-tab-mongodb-binaries') },
    replSet: { count: 1, ip: '127.0.0.1', storageEngine: 'wiredTiger' } })
  const uri = replica.getUri(`share_races_${randomUUID().replaceAll('-', '_')}`)
  await promisify(execFile)(join(process.cwd(), 'node_modules/.bin/prisma'), ['db', 'push', '--skip-generate'], {
    env: { ...process.env, DATABASE_URL: uri }, timeout: 60000,
  })
  process.env.DATABASE_URL = uri
  vi.resetModules()
  db = (await import('../src/lib/prisma.js')).prisma
  const { errorHandler } = await import('../src/middlewares/errorHandler.js')
  const { agentMessagesRoutes } = await import('../src/routes/agentMessages.js')
  const { machineShareRoutes } = await import('../src/routes/machineShares.js')
  for (const each of [owner, guest]) await db.user.create({ data: { id: each.sub, externalId: `fixture-${each.sub}`, email: each.email, autonomousEnv: 'prod' } })
  app = Fastify()
  app.setErrorHandler(errorHandler)
  app.addHook('onRequest', async (request, reply) => {
    const found = [owner, guest].find(u => `Bearer ${u.sub}` === request.headers.authorization)
    if (!found) return reply.code(401).send({ success: false })
    request.user = found as never
  })
  await app.register(agentMessagesRoutes)
  await app.register(machineShareRoutes)
  await app.ready()
}, 120000)
afterAll(async () => {
  await app?.close()
  await db?.$disconnect()
  await replica?.stop()
})

const send = (as: typeof owner, method: 'POST' | 'PUT', url: string, payload?: unknown) =>
  app.inject({ method, url, payload: payload as never, headers: { authorization: `Bearer ${as.sub}` } })
/** The same request, sent TRIES times at once. */
const together = (request: () => ReturnType<typeof send>) => Promise.all(Array.from({ length: TRIES }, request))

/** A shared conversation tab of the owner's, on a machine of theirs. */
async function sharedTab() {
  const machineId = randomUUID().replaceAll('-', '')
  await db.machine.create({ data: { machineId, userId: owner.sub, apiKey: 'fixture-only', managerId: 'fixture', autonomousEnv: 'prod', authMode: 'remote' } })
  const put = await send(owner, 'PUT', `/api/agent-messages/shares/tab-${randomUUID().slice(0, 8)}/roster`, { machineId, version: 1, roster: { body: '{"name":"Race"}', signature: 's' } })
  expect(put.statusCode).toBe(200)
  return { machineId, sharedTabId: put.json().data.sharedTabId as string }
}

describe('identical requests at the same moment', () => {
  it('inviting the same address to a shared tab answers one invitation to every request', async () => {
    const { sharedTabId } = await sharedTab()
    const answers = await together(() => send(owner, 'POST', `/api/agent-messages/shares/${sharedTabId}/invites`, { email: guest.email, days: 7 }))
    expect(answers.map(a => a.statusCode)).toEqual(Array(TRIES).fill(200))
    const ids = new Set(answers.map(a => a.json().data.id))
    expect(ids.size).toBe(1)
    expect(await db.agentMessageInvite.count({ where: { shareId: sharedTabId } })).toBe(1)
  })

  it('accepting the same invitation twice makes one member and answers every request', async () => {
    const { sharedTabId } = await sharedTab()
    const id = (await send(owner, 'POST', `/api/agent-messages/shares/${sharedTabId}/invites`, { email: guest.email, days: 7 })).json().data.id
    const answers = await together(() => send(guest, 'POST', `/api/agent-messages/invites/${id}/accept`))
    // Each answers the shared tab, or that the invitation was already used; none is a 500.
    for (const answer of answers) expect([200, 404]).toContain(answer.statusCode)
    expect(answers.filter(a => a.statusCode === 200).length).toBeGreaterThanOrEqual(1)
    for (const ok of answers.filter(a => a.statusCode === 200)) expect(ok.json().data).toEqual({ sharedTabId })
    expect(await db.agentMessageMember.count({ where: { shareId: sharedTabId, removedAt: null } })).toBe(1)
  })

  it('adding yourself to a machine shared with your domain adds you once and answers every request', async () => {
    const machineId = randomUUID().replaceAll('-', '')
    await db.machine.create({ data: { machineId, userId: owner.sub, apiKey: 'fixture-only', managerId: 'fixture', autonomousEnv: 'prod', authMode: 'remote' } })
    expect((await send(owner, 'PUT', `/api/machines/${machineId}/share`, { emails: [], sameDomain: true })).statusCode).toBe(200)
    const answers = await together(() => send(guest, 'POST', `/api/machine-shares/${machineId}/add`))
    expect(answers.map(a => a.statusCode)).toEqual(Array(TRIES).fill(200))
    for (const answer of answers) expect(answer.json().data).toEqual({ added: true })
    expect(await db.machineShareAdd.count({ where: { machineId, userId: guest.sub } })).toBe(1)
  })
})
