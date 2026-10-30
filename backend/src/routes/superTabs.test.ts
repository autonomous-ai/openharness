import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { Prisma } from '@prisma/client'

// Real Harness sessions for the sign-in tests below, minted and redeemed through lib/harnessSession.ts against in-memory
// stores, as routes/control.test.ts does, so the real authentication and team gate run.
const fakes = vi.hoisted(() => {
  const redis = new Map<string, string>()
  const sessions: Array<Record<string, unknown> & { id: string }> = []
  const pick = (where: Record<string, unknown>) => sessions.find(s => Object.entries(where).every(([k, v]) => s[k] === v)) ?? null
  return {
    pub: {
      set: vi.fn(async (key: string, value: string) => { redis.set(key, value); return 'OK' }),
      get: vi.fn(async (key: string) => redis.get(key) ?? null),
      multi: vi.fn(() => {
        const ops: Array<() => unknown> = []
        const chain = {
          get: (key: string) => { ops.push(() => redis.get(key) ?? null); return chain },
          del: (key: string) => { ops.push(() => (redis.delete(key) ? 1 : 0)); return chain },
          exec: async () => ops.map(op => [null, op()]),
        }
        return chain
      }),
    },
    prisma: {
      harnessSession: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          const row = { id: `s${sessions.length + 1}`, ...data }; sessions.push(row); return row
        }),
        findUnique: vi.fn(async ({ where }: { where: Record<string, unknown> }) => pick(where)),
      },
      machine: {
        findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => where.computerId === 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
          ? [{ machineId: 'team-mac', userId: 'owner', computerId: where.computerId, billingStatus: 'not_required', sessionKind: 'team' }] : []),
      },
    },
    user: { id: 'owner', email: 'owner@example.com', role: 'user', autonomousEnv: 'prod' },
  }
})
vi.mock('../lib/bus.js', () => ({ pub: fakes.pub }))
vi.mock('../lib/prisma.js', () => ({ prisma: fakes.prisma, machineAlive: { OR: [{ deletedAt: null }, { deletedAt: { isSet: false } }] } }))
vi.mock('../services/UserService.js', () => ({
  userService: { get: vi.fn(async (id: string) => id === fakes.user.id ? fakes.user : null) },
  normalizeUserEmail: (email: string) => email.trim().toLowerCase(),
  isProvisionalUserEmail: () => false,
}))

import { errorHandler } from '../middlewares/errorHandler.js'
import { registerAuthMiddleware } from '../middlewares/authMiddleware.js'
import { redeemHandoff, startHandoff } from '../lib/harnessSession.js'
import type { AuthUser } from '../lib/ssoAuth.js'
import { SuperTabError } from '../superTabs/model.js'
import { HOT_BODY_LIMIT, NOT_AVAILABLE, superTabRoutes } from './superTabs.js'
import { logger } from '../utils/logger.js'
import { WORKSPACE_ACCESS_REVOKED } from '../superTabs/workspaceStore.js'

describe('Super Tab route failures', () => {
  let app: FastifyInstance
  let thrown: unknown
  beforeEach(async () => {
    app = Fastify()
    app.setErrorHandler(errorHandler)
    app.addHook('onRequest', async request => { request.user = { sub: 'u1', email: 'u1@example.com', autonomousEnv: 'prod', role: 'user' } as never })
    const store = { hostGrids: async () => { throw thrown }, native: { append: async () => { throw thrown } } }
    await app.register(superTabRoutes, { store: store as never, github: null, reads: {} as never, hosts: {} as never })
    await app.ready()
  })
  afterEach(async () => { await app.close() })

  it('answers a busy Swarm with Retry-After', async () => {
    thrown = new SuperTabError('SWARM_BUSY', 'This Swarm is busy. Try again in a moment.', 503)
    const res = await app.inject({ method: 'GET', url: '/api/super-tabs/grids' })
    expect(res.statusCode).toBe(503)
    expect(res.headers['retry-after']).toBe('2')
    expect(res.json().error.code).toBe('SWARM_BUSY')
  })

  it('answers a refusal with its own status and no Retry-After', async () => {
    thrown = new SuperTabError('FORBIDDEN', 'Not yours.', 403)
    const res = await app.inject({ method: 'GET', url: '/api/super-tabs/grids' })
    expect(res.statusCode).toBe(403)
    expect(res.headers['retry-after']).toBeUndefined()
  })

  it('answers an expired transaction as a retryable 503, not 500', async () => {
    thrown = new Prisma.PrismaClientKnownRequestError('Transaction API error: Transaction already closed', { code: 'P2028', clientVersion: 'test' })
    const res = await app.inject({ method: 'GET', url: '/api/super-tabs/grids' })
    expect(res.statusCode).toBe(503)
    expect(res.headers['retry-after']).toBe('2')
  })

  it('answers a terminal recording\'s duplicate key as busy, so the host keeps recording and retries', async () => {
    // The host stops a recording for good on a 409 (cli superTabs/native.ts); a duplicate that outlived every retry is
    // not the recording's fault.
    thrown = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' })
    const res = await app.inject({ method: 'POST', url: '/api/super-tabs/tab-1/native/ctx-1', payload: { turnId: 'turn-1', kind: 'prompt', previousEventId: null, text: 'hi', truncated: false, interrupted: false } })
    expect(res.statusCode).toBe(503)
    expect(res.headers['retry-after']).toBe('2')
    expect(res.json().error.code).toBe('SWARM_BUSY')
  })
})

// One answer for anything the caller cannot reach, on the routes a person's app calls (Huy, 10-30): the route only maps the
// store's refusal, so a fake store throws each kind. integration/superTabNotAvailable.test.ts runs the real store.
describe('the person routes\' one not-available answer', () => {
  let app: FastifyInstance
  let thrown: unknown
  const throwing = async () => { throw thrown }
  beforeEach(async () => {
    app = Fastify()
    app.setErrorHandler(errorHandler)
    app.addHook('onRequest', async request => { request.user = { sub: 'u1', email: 'u1@example.com', autonomousEnv: 'prod', role: 'user' } as never })
    const store = { hostGrids: throwing, messages: throwing, execute: throwing }
    await app.register(superTabRoutes, { store: store as never, github: null, reads: { firstLoad: throwing } as never, hosts: {} as never })
    await app.ready()
  })
  afterEach(async () => { await app.close(); vi.restoreAllMocks() })
  const body = JSON.stringify({ success: false, error: { code: NOT_AVAILABLE.code, message: NOT_AVAILABLE.message } })
  const ask = (url: string, method: 'GET' | 'POST' = 'GET') => app.inject({ method, url,
    payload: method === 'POST' ? { operationId: 'op-1', command: { type: 'message.send', conversationId: 'c1', text: 'hi', replyTo: null, recipientIds: [] } } : undefined })

  it('answers missing, not a member, out of the Workspace and a refused link alike, and logs which it was', async () => {
    const warn = vi.spyOn(logger, 'warn')
    const refusals = [new SuperTabError('NOT_FOUND', 'This Super Tab is unavailable.', 404),
      new SuperTabError('FORBIDDEN', 'You no longer have access to this Super Tab.', 403, true),
      new SuperTabError(WORKSPACE_ACCESS_REVOKED, 'You are no longer in this Swarm\'s Workspace.', 403),
      new SuperTabError('JOIN_UNAVAILABLE', 'This Swarm link is unavailable for this account.', 404),
      new SuperTabError('NOT_FOUND', 'This conversation is unavailable.', 404)]
    for (const refusal of refusals) {
      thrown = refusal
      for (const [url, method] of [['/api/super-tabs/tab-1/parts'], ['/api/super-tabs/tab-1/conversations/c1/messages'], ['/api/super-tabs/tab-1/commands', 'POST']] as const) {
        const res = await ask(url, method)
        expect({ status: res.statusCode, body: res.body }, `${refusal.code} ${url}`).toEqual({ status: 404, body })
      }
      expect(warn).toHaveBeenCalledWith('Swarm not available to the caller', expect.objectContaining({ code: refusal.code, reason: refusal.message }))
    }
  })

  it('keeps a role refusal inside a Swarm the caller reads, and a FORBIDDEN that is not about reaching it', async () => {
    for (const refusal of [new SuperTabError('READ_ONLY', 'You have read-only access to this Super Tab.', 403),
      new SuperTabError('FORBIDDEN', 'Only the owner can remove another person.', 403)]) {
      thrown = refusal
      const res = await ask('/api/super-tabs/tab-1/commands', 'POST')
      expect(res.statusCode).toBe(403)
      expect(res.json().error).toEqual({ code: refusal.code, message: refusal.message })
    }
  })

  it('leaves the routes a machine\'s host calls as they were', async () => {
    thrown = new SuperTabError('FORBIDDEN', 'You no longer have access to this Super Tab.', 403, true)
    const res = await ask('/api/super-tabs/grids')
    expect(res.statusCode).toBe(403)
    expect(res.json().error.message).toBe('You no longer have access to this Super Tab.')
  })
})

describe('Super Tab body limits (roadmap 2.8)', () => {
  let app: FastifyInstance
  let reached: string[]
  beforeEach(async () => {
    reached = []
    app = Fastify()
    app.setErrorHandler(errorHandler)
    app.addHook('onRequest', async request => { request.user = { sub: 'u1', email: 'u1@example.com', autonomousEnv: 'prod', role: 'user' } as never })
    const handled = (name: string) => async () => { reached.push(name); return {} }
    const store = { native: { append: handled('native'), open: handled('open') }, delivery: handled('delivery'), stopped: handled('stopped') }
    await app.register(superTabRoutes, { store: store as never, github: null, reads: {} as never, hosts: { changes: handled('changes') } as never })
    await app.ready()
  })
  afterEach(async () => { await app.close() })

  const id = (n: number, size = 160) => `${String(n).padStart(6, '0')}${'a'.repeat(size - 6)}`
  /** Free text at its longest in characters, each the widest a person types: three UTF-8 bytes ('ệ'). */
  const text = (length: number) => 'ệ'.repeat(length)
  /** The largest body each hot route accepts, from its schema's limits. */
  const largest = {
    changes: { url: '/api/super-tabs/hosts/m1/changes', name: 'changes',
      body: { cursor: 'c'.repeat(512), full: false, held: Object.fromEntries(Array.from({ length: 500 }, (_, n) => [id(n), 'e'.repeat(64)])) } },
    native: { url: '/api/super-tabs/tab-1/native/ctx-1', name: 'native',
      body: { turnId: id(3), kind: 'answer', previousEventId: id(4), text: text(16_000), truncated: false, interrupted: false } },
    delivery: { url: '/api/super-tabs/tab-1/agents/agent-1/deliveries/delivery-1', name: 'delivery',
      body: { type: 'ack', claimId: id(4), receipt: text(2000), uncertain: false } },
    stopped: { url: '/api/super-tabs/tab-1/stopped', name: 'stopped', body: { assignmentId: id(2), receipt: text(2000) } },
  }
  const post = (url: string, payload: string) => app.inject({ method: 'POST', url, payload, headers: { 'content-type': 'application/json' } })

  for (const [route, { url, name, body }] of Object.entries(largest)) {
    it(`takes the largest valid ${route} body and refuses one past the limit`, async () => {
      const json = JSON.stringify(body)
      expect((await post(url, json)).statusCode).toBe(200)
      expect(reached).toEqual([name])
      const over = await post(url, `${json}${' '.repeat(HOT_BODY_LIMIT + 1 - Buffer.byteLength(json))}`)
      expect(over.statusCode).toBe(413)
      expect(reached).toEqual([name])
    })
  }

  it('keeps the limit within the largest valid hot body with room for growth: under twice it', () => {
    const sizes = Object.values(largest).map(r => Buffer.byteLength(JSON.stringify(r.body)))
    expect(Math.max(...sizes)).toBeLessThan(HOT_BODY_LIMIT)
    expect(HOT_BODY_LIMIT).toBeLessThan(2 * Math.max(...sizes))
  })
})

// The web calls Swarm routes straight from the browser with the person's own sign-in (docs/specs/2026-10-30-web-swarm-
// direct.md): a viewer session reaches them as the person, through the real authentication; a team sign-in is still
// refused as the person (the store refuses it on the routes the team gate admits for its agents, superTabBuddies).
describe('the browser\'s own sign-in on Swarm routes', () => {
  let app: FastifyInstance
  let viewer: string, team: string
  const seen: Array<{ route: string; user: AuthUser }> = []
  beforeAll(async () => {
    viewer = (await redeemHandoff((await startHandoff(fakes.user.id, 'viewer')).code, 'Safari on iPhone'))!.token
    team = (await redeemHandoff((await startHandoff(fakes.user.id, 'team')).code, 'MacBook Pro · Team', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'))!.token
    app = Fastify()
    app.setErrorHandler(errorHandler)
    registerAuthMiddleware(app)
    const reads = {
      firstLoad: async (user: AuthUser) => { seen.push({ route: 'parts', user }); return { format: 2 } },
      list: async (user: AuthUser) => { seen.push({ route: 'list', user }); return { tabs: [] } },
    }
    const store = { execute: async (user: AuthUser) => { seen.push({ route: 'commands', user }); return { result: { messageId: 'm1' } } } }
    await app.register(superTabRoutes, { store: store as never, github: null, reads: reads as never, hosts: {} as never })
    await app.ready()
  })
  afterAll(async () => { await app?.close() })
  beforeEach(() => { seen.length = 0 })

  const command = { operationId: 'op-web-1', command: { type: 'message.send', conversationId: 'buddy-chat', text: 'hi', replyTo: null,
    recipientIds: [] } }

  it('reads a Swarm and posts in it as the person', async () => {
    const auth = { authorization: `Bearer ${viewer}` }
    const read = await app.inject({ method: 'GET', url: '/api/super-tabs/tab-1/parts', headers: auth })
    expect(read.statusCode).toBe(200)
    const post = await app.inject({ method: 'POST', url: '/api/super-tabs/tab-1/commands', headers: auth, payload: command })
    expect(post.statusCode).toBe(200)
    expect(seen.map(s => s.route)).toEqual(['parts', 'commands'])
    for (const { user } of seen) expect(user).toMatchObject({ sub: 'owner', harnessSessionKind: 'viewer' })
  })

  it('refuses a team sign-in as the person, before any Swarm is read', async () => {
    const auth = { authorization: `Bearer ${team}` }
    for (const url of ['/api/super-tabs/tab-1/parts', '/api/super-tabs/list']) {
      const res = await app.inject({ method: 'GET', url, headers: auth })
      expect(res.statusCode, url).toBe(403)
      expect(res.json().error.code).toBe('TEAM_SESSION_LIMITED')
    }
    expect(seen).toEqual([])
  })

  it('refuses no sign-in at all', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/super-tabs/tab-1/commands', payload: command })
    expect(res.statusCode).toBe(401)
    expect(seen).toEqual([])
  })
})
