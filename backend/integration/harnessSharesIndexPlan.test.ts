import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import type { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import type { PrismaClient } from '@prisma/client'
import type { AuthUser } from '../src/lib/ssoAuth.js'
import { planDatabase, plan, profiled, reads } from './plans.test-support.js'

// Prod 2026-11-02 (Atlas Performance Advisor): the share list filters one recipient's shares in one environment and sorts them by
// createdAt, which the (recipientEmail, autonomousEnv, expiresAt) index cannot give, so Mongo sorted every unexpired share in memory.
// A fresh loopback replica set; the route's own Prisma client is pointed at it. Never DATABASE_URL.
const shared = vi.hoisted(() => ({ db: null as unknown as PrismaClient }))
vi.mock('../src/lib/prisma.js', async original => ({ ...await original<typeof import('../src/lib/prisma.js')>(), get prisma() { return shared.db } }))
vi.mock('../src/lib/bus.js', async original => ({ ...await original<typeof import('../src/lib/bus.js')>(),
  getAgentPresenceMany: async (ids: string[]) => new Map(ids.map(id => [id, 'running'])) }))
const { harnessShareRoutes } = await import('../src/routes/harnessShares.js')

const DAY = 86_400_000
let replica: MongoMemoryReplSet
let db: PrismaClient
let app: FastifyInstance
const recipient = { sub: 'a'.repeat(24), email: 'Recipient@Example.com', autonomousEnv: 'prod' } as unknown as AuthUser

beforeAll(async () => {
  ({ replica, db } = await planDatabase('share_index_plan'))
  shared.db = db
  const share = (recipientEmail: string, i: number, extra: Record<string, unknown> = {}) => ({ id: randomUUID(), ownerId: 'b'.repeat(24), machineId: `m-${i}`,
    agentId: `agent-${i}`, recipientEmail, autonomousEnv: 'prod', name: `agent ${i}`, ownerPublicKey: 'fixture-key', expiresAt: new Date(Date.now() + DAY),
    createdAt: new Date(Date.now() - (100 - i) * 1000), ...extra })
  await db.harnessShare.createMany({ data: [
    // Many other recipients' shares, which a read not bounded by recipient examines too.
    ...Array.from({ length: 60 }, (_, i) => share(`other-${i}@example.com`, i)),
    ...Array.from({ length: 5 }, (_, i) => share('recipient@example.com', 100 + i)),
    share('recipient@example.com', 110, { autonomousEnv: 'dev' }),
    // Revoked but not yet expired, as production holds them by the thousand: each sits inside the expiresAt range.
    ...Array.from({ length: 30 }, (_, i) => share('recipient@example.com', 200 + i, { revokedAt: new Date() })),
    share('recipient@example.com', 112, { expiresAt: new Date(Date.now() - 1000) }),
  ] })
  app = Fastify()
  app.decorateRequest('user', null)
  app.addHook('onRequest', async req => { req.user = recipient })
  await app.register(harnessShareRoutes)
  await app.ready()
}, 300_000)
afterAll(async () => {
  await app?.close()
  await db?.$disconnect()
  await replica?.stop()
})

describe('the harness shares list', () => {
  it('reads one recipient\'s shares in creation order from the index that holds that order', async () => {
    const entries = await profiled(db, async () => { expect((await app.inject({ method: 'GET', url: '/api/harness-shares' })).statusCode).toBe(200) })
    const rows = reads(entries, 'harness_shares', ['recipientEmail', 'autonomousEnv', 'revokedAt', 'expiresAt'])
    expect(rows, JSON.stringify(plan(rows))).toHaveLength(1)
    expect(rows[0]!.planSummary, JSON.stringify(plan(rows))).toMatch(/IXSCAN \{ recipientEmail: 1, autonomousEnv: 1, revokedAt: 1, createdAt: 1, expiresAt: 1 \}/)
    // Only the recipient's shares in this environment (just the 5 listed): not the 30 revoked, the expired one or the 60 others.
    expect(rows[0]!.docsExamined, JSON.stringify(plan(rows))).toBeLessThanOrEqual(5)
  })
})
