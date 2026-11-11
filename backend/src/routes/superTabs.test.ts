import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { Prisma } from '@prisma/client'

// Real Harness sessions for the sign-in tests below, minted and redeemed through lib/harnessSession.ts against in-memory
// stores, as routes/control.test.ts does, so the real authentication runs.
const fakes = vi.hoisted(() => {
  const redis = new Map<string, string>()
  const sessions: Array<Record<string, unknown> & { id: string }> = []
  const pick = (where: Record<string, unknown>) => sessions.find(s => Object.entries(where).every(([k, v]) => s[k] === v)) ?? null
  return {
    pub: {
      set: vi.fn(async (key: string, value: string) => { redis.set(key, value); return 'OK' }),
      get: vi.fn(async (key: string) => redis.get(key) ?? null),
      mget: vi.fn(async (...keys: string[]) => keys.map((key) => redis.get(key) ?? null)),
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
import { HOT_BODY_LIMIT, NOT_AVAILABLE, READINGS_MAX, superTabRoutes } from './superTabs.js'
import { machineObservationSchema } from '../superTabs/machines.js'
import { logger } from '../utils/logger.js'

describe('Super Tab route failures', () => {
  let app: FastifyInstance
  let thrown: unknown
  beforeEach(async () => {
    app = Fastify()
    app.setErrorHandler(errorHandler)
    app.addHook('onRequest', async request => { request.user = { sub: 'u1', email: 'u1@example.com', autonomousEnv: 'prod', role: 'user' } as never })
    const store = { hostGrids: async () => { throw thrown } }
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
})

// Swarm v4 is built from scratch (anh Dee, 2026-11-10): what v1-v3 had is gone, with no answer kept for their clients. An old
// command is refused as one no version had, before the store is reached, and an old read or write is no route at all.
describe('what Swarm v1-v3 had, over HTTP', () => {
  let app: FastifyInstance
  beforeEach(async () => {
    app = Fastify()
    app.setErrorHandler(errorHandler)
    app.addHook('onRequest', async request => { request.user = { sub: 'u1', email: 'u1@example.com', autonomousEnv: 'prod', role: 'user' } as never })
    // A store, reads and host reads that fail on any call: the answers must not touch them.
    await app.register(superTabRoutes, { store: {} as never, github: null, reads: {} as never, hosts: {} as never })
    await app.ready()
  })
  afterEach(async () => { await app.close() })

  it('refuses its commands as unknown, an agent\'s too', async () => {
    for (const command of [{ type: 'work.assign', conversationId: 'task-1', agentId: 'agent-2' }, { type: 'decision.answer', decisionId: 'd1', choice: 1 },
      { type: 'proposal.create', projectId: 'lead', title: 'Sync' }, { type: 'message.react', conversationId: 'c', messageId: 'm', emoji: 'eyes', on: true },
      { type: 'conversation.create', title: 'Review', brief: 'Review it.', reviewOf: 'task-1', checks: [] },
      { type: 'conversation.create', title: 'Fix', brief: 'Fix it.', checks: [], requestMessageId: 'm1' },
      { type: 'message.send', conversationId: 'c', text: 'Hi', replyTo: null, recipientIds: [], handoff: 'm1' },
      { type: 'message.send', conversationId: 'c', text: 'Hi', replyTo: null, recipientIds: [], mentionsIfNoWorker: true },
      { type: 'instructions.save', projectId: 'lead', baseRevision: 1, text: '# Mine', summary: 'Mine' },
      { type: 'note.add', projectId: 'lead', text: 'Ship on Fridays', askedBy: 'u1' }, { type: 'rule.set', rule: { kind: 'preferIdle' }, text: 'Idle first.' },
      { type: 'project.skills', projectId: 'lead', mode: 'default' }, { type: 'project.role.remove', projectId: 'lead', roleId: 'review' },
      { type: 'project.coordinatorName', projectId: 'lead', name: 'Boss' }, { type: 'tab.routingPolicy', policy: null }, { type: 'tab.tidy', enabled: true },
      { type: 'route.record', conversationId: 'task-1', decision: { assessment: { difficulty: 'low', risk: 'low', why: 'Small' },
        candidates: [{ id: 'c1', kind: 'new', machineId: 'm1', engine: 'claude', model: 'opus', effort: 'high', quality: 3, cost: 3, title: 'Opus', label: 'Opus high' }],
        excluded: [], floor: 1, notes: false, via: 'instructions', p: null, belowFloor: false, why: 'Small' } },
      { type: 'route.override', decisionId: 'd1', candidateId: 'c1', reason: 'Faster' },
      { type: 'route.modelResult', decisionId: 'd1', startId: 's1', model: 'opus', effort: 'high' },
      { type: 'rules.set', projectId: 'lead', baseRevision: 0, summary: 'Pace', rules: { releaseWindow: { start: '09:00', end: '18:00', timeZone: 'UTC' },
        releasePace: { backendEveryMinutes: 120, appsAfterVisibleBatch: true, backendPause: null }, reviews: { defaultReads: 1, rows: [], test: [], untested: [] },
        mergeTrain: { enabled: false, everyMinutes: 10 }, caps: [], paths: [], crew: [], lanes: [],
        dispatch: { everyMs: 30_000, maxHanded: 3, nudgeAfterMs: 7_200_000, returnAfterMs: 10_800_000 } } },
      ...[{ routeDecisionId: 'd1' }, { overrideReason: 'Faster' }].map(route => ({ type: 'agent.start', ...route, request: { conversationId: 'task-1',
        machineId: 'm1', engine: 'claude', name: 'Builder', cwd: '/work', worktree: false,
        requirements: { memoryBytes: 0, diskBytes: 0, maxCpuPercent: 50, tools: [], devices: [], quotaRequired: false } } })),
      // Swarm v4 keeps no custom role sets or role names, no conversations but its project channels and agents' chats, and no
      // report watermarks (slice S18).
      { type: 'conversation.create', title: 'Fix', brief: 'Fix it.', checks: [] },
      { type: 'conversation.create', projectId: 'lead', title: 'Fix', checks: [], task: { goal: 'g', changes: 'c', constraints: 'n', owns: ['src'] }, priority: 'P2' },
      ...[{ roleId: 'dev' }, { roleName: 'Tester' }].map(role => ({ type: 'agent.add', conversationId: 'c', machineId: 'm1', harnessId: 'h1', name: 'Builder',
        lead: false, configuration: { engine: 'claude', model: null, effort: null, contextWindow: null, engineVersion: null }, ...role })),
      ...[{ roleId: 'dev' }, { roleName: 'Tester' }].map(role => ({ type: 'agent.start', request: { conversationId: 'task-1', machineId: 'm1',
        engine: 'claude', name: 'Builder', cwd: '/work', worktree: false, ...role,
        requirements: { memoryBytes: 0, diskBytes: 0, maxCpuPercent: 50, tools: [], devices: [], quotaRequired: false } } })),
      { type: 'project.report', projectId: 'lead', through: { 'task-1': 3 }, text: 'Status' },
      { type: 'project.report', projectId: 'lead', throughRevision: 3, text: null }]) {
      for (const asAgentId of [undefined, 'agent-1']) {
        const res = await app.inject({ method: 'POST', url: '/api/super-tabs/tab-1/commands', payload: { operationId: 'op-1', command, ...asAgentId ? { asAgentId } : {} } })
        expect(res.statusCode, JSON.stringify(command)).toBe(400)
      }
    }
  })

  it('serves none of its reads and writes', () => {
    const gone: Array<['GET' | 'POST', string]> = [
      ['GET', '/api/super-tabs'], ['GET', '/api/super-tabs/:tabId'], ['GET', '/api/super-tabs/hosts/:machineId'],
      ['GET', '/api/super-tabs/hosts/:machineId/pools'], ['GET', '/api/super-tabs/hosts/:machineId/assignments'],
      ['POST', '/api/super-tabs/:tabId/native'], ['GET', '/api/super-tabs/:tabId/native/:contextId'], ['POST', '/api/super-tabs/:tabId/native/:contextId'],
      ['GET', '/api/super-tabs/:tabId/scorecard'], ['GET', '/api/super-tabs/:tabId/decisions'], ['GET', '/api/super-tabs/:tabId/mentions'],
      ['GET', '/api/super-tabs/:tabId/activity'], ['GET', '/api/super-tabs/:tabId/reminders'], ['GET', '/api/super-tabs/:tabId/threads'],
      ['GET', '/api/super-tabs/:tabId/inbox'], ['GET', '/api/super-tabs/:tabId/personal-tasks'], ['GET', '/api/super-tabs/:tabId/proposals'],
      ['GET', '/api/super-tabs/:tabId/conversations/:conversationId/catch-up'], ['POST', '/api/super-tabs/:tabId/activity/read'],
      ['POST', '/api/super-tabs/:tabId/conversations/:conversationId/threads/:threadId/follow'],
      ['POST', '/api/super-tabs/:tabId/conversations/:conversationId/messages/:messageId/reminder'], ['POST', '/api/super-tabs/:tabId/avatars'],
      ['GET', '/api/super-tabs/:tabId/projects/:projectId/instructions'], ['GET', '/api/super-tabs/:tabId/projects/:projectId/instructions/revisions'],
      ['GET', '/api/super-tabs/:tabId/projects/:projectId/instructions/revisions/:revision'], ['GET', '/api/super-tabs/:tabId/projects/:projectId/roles/:roleId'],
      ['GET', '/api/super-tabs/routing-policy'], ['POST', '/api/super-tabs/routing-policy'], ['GET', '/api/super-tabs/:tabId/costs'],
      ['GET', '/api/super-tabs/:tabId/route-decisions'], ['GET', '/api/super-tabs/:tabId/route-decisions/:decisionId'],
      ['GET', '/api/super-tabs/:tabId/conversations/:conversationId/attempts'], ['GET', '/api/super-tabs/:tabId/projects/:projectId/rules'],
      ['GET', '/api/super-tabs/:tabId/projects/:projectId/machine-rules']]
    for (const [method, url] of gone) expect(app.hasRoute({ method, url }), `${method} ${url}`).toBe(false)
  })
})

// Workspaces, the level above Swarms, are gone with Swarm v4: a Swarm is the org already, and no client calls their routes, so none
// is registered. A new Swarm names no Workspace to be in. integration/superTabNotAvailable.test.ts runs the real store.
describe('the Workspace routes Swarm v4 removed', () => {
  let app: FastifyInstance
  let created: unknown[][]
  beforeEach(async () => {
    created = []
    app = Fastify()
    app.setErrorHandler(errorHandler)
    app.addHook('onRequest', async request => { request.user = { sub: 'u1', email: 'u1@example.com', autonomousEnv: 'prod', role: 'user' } as never })
    const store = { create: async (...args: unknown[]) => { created.push(args.slice(1)); return { id: 'tab-1', revision: 0 } } }
    await app.register(superTabRoutes, { store: store as never, github: null, reads: {} as never, hosts: {} as never })
    await app.ready()
  })
  afterEach(async () => { await app.close() })

  it('registers none of the thirteen', () => {
    const retired: Array<['GET' | 'POST', string]> = [
      ['GET', '/api/super-tabs/workspaces'], ['POST', '/api/super-tabs/workspaces'], ['GET', '/api/super-tabs/workspace-invitations'],
      ['POST', '/api/super-tabs/workspaces/:workspaceId'], ['GET', '/api/super-tabs/workspaces/:workspaceId/members'],
      ['POST', '/api/super-tabs/workspaces/:workspaceId/invitations'], ['POST', '/api/super-tabs/workspaces/:workspaceId/invitations/revoke'],
      ['POST', '/api/super-tabs/workspaces/:workspaceId/accept'], ['POST', '/api/super-tabs/workspaces/:workspaceId/members/:userId'],
      ['POST', '/api/super-tabs/workspaces/:workspaceId/members/:userId/remove'], ['POST', '/api/super-tabs/workspaces/:workspaceId/transfer'],
      ['POST', '/api/super-tabs/:tabId/workspace-visibility'], ['POST', '/api/super-tabs/:tabId/workspace-join']]
    for (const [method, url] of retired) expect(app.hasRoute({ method, url }), `${method} ${url}`).toBe(false)
  })

  it('makes a Swarm without naming a Workspace, and refuses a body that still names one', async () => {
    const made = await app.inject({ method: 'POST', url: '/api/super-tabs', payload: { operationId: 'op-1', name: 'Acme' } })
    expect(made.statusCode).toBe(200)
    expect(created).toEqual([['op-1', 'Acme', undefined]])
    const named = await app.inject({ method: 'POST', url: '/api/super-tabs', payload: { operationId: 'op-2', name: 'Acme', workspaceId: 'w1' } })
    expect(named.statusCode).toBe(400)
    expect(created).toHaveLength(1)
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

  it('answers missing, not a member and a refused link alike, and logs which it was', async () => {
    const warn = vi.spyOn(logger, 'warn')
    const refusals = [new SuperTabError('NOT_FOUND', 'This Super Tab is unavailable.', 404),
      new SuperTabError('FORBIDDEN', 'You no longer have access to this Super Tab.', 403, true),
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
    const store = { delivery: handled('delivery'), stopped: handled('stopped') }
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
// direct.md): a viewer session reaches them as the person, through the real authentication.
describe('the browser\'s own sign-in on Swarm routes', () => {
  let app: FastifyInstance
  let viewer: string
  const seen: Array<{ route: string; user: AuthUser }> = []
  beforeAll(async () => {
    viewer = (await redeemHandoff((await startHandoff(fakes.user.id)).code, 'Safari on iPhone'))!.token
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

  it('refuses no sign-in at all', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/super-tabs/tab-1/commands', payload: command })
    expect(res.statusCode).toBe(401)
    expect(seen).toEqual([])
  })
})

describe('a machine\'s readings for all its Swarms in one call (DB 2.5)', () => {
  let app: FastifyInstance
  let calls: Array<{ machineId: string; readings: Array<{ tabId: string }> }>
  let answers: Array<{ tabId: string; error?: unknown }> | null
  beforeEach(async () => {
    calls = []
    answers = null
    app = Fastify()
    app.setErrorHandler(errorHandler)
    app.addHook('onRequest', async request => { request.user = { sub: 'u1', email: 'u1@example.com', autonomousEnv: 'prod', role: 'user' } as never })
    const store = { observeMachines: async (_user: unknown, machineId: string, readings: Array<{ tabId: string }>) => {
      calls.push({ machineId, readings })
      return answers ?? readings.map(r => ({ tabId: r.tabId }))
    } }
    await app.register(superTabRoutes, { store: store as never, github: null, reads: {} as never, hosts: {} as never })
    await app.ready()
  })
  afterEach(async () => { await app.close(); vi.restoreAllMocks() })
  const post = (body: unknown) => app.inject({ method: 'POST', url: '/api/super-tabs/hosts/m1/readings', payload: body as object })
  const readings = (n: number) => Array.from({ length: n }, (_, i) => ({ tabId: `tab-${i}`, observation: { any: 'shape' } }))

  it('answers each Swarm on its own, as the per-Swarm route would answer it', async () => {
    vi.spyOn(logger, 'error').mockImplementation(() => {})
    vi.spyOn(logger, 'warn').mockImplementation(() => {})
    answers = [{ tabId: 'tab-0' }, { tabId: 'tab-1', error: new SuperTabError('CONTRIBUTION_REVOKED', 'Read the current machine contribution.', 403) },
      { tabId: 'tab-2', error: new SuperTabError('NOT_FOUND', 'This Super Tab is unavailable.', 404) },
      { tabId: 'tab-3', error: machineObservationSchema.safeParse({ generation: 1 }).error }, { tabId: 'tab-4', error: new Error('boom') }]
    const res = await post({ readings: readings(5) })
    expect(res.statusCode).toBe(200)
    expect(res.json().data.results).toEqual([{ tabId: 'tab-0', ok: true },
      { tabId: 'tab-1', error: { code: 'CONTRIBUTION_REVOKED', message: 'Read the current machine contribution.', status: 403 } },
      { tabId: 'tab-2', error: { ...NOT_AVAILABLE } },
      { tabId: 'tab-3', error: { code: 'VALIDATION_ERROR', message: expect.any(String), status: 400 } },
      { tabId: 'tab-4', error: { code: 'INTERNAL_ERROR', message: expect.any(String), status: 500 } }])
    // Each observation reaches the store as sent: it is checked there, Swarm by Swarm.
    expect(calls).toEqual([{ machineId: 'm1', readings: readings(5) }])
  })

  it(`takes up to ${READINGS_MAX} readings, each Swarm once, and refuses any other body before reaching the store`, async () => {
    expect((await post({ readings: readings(READINGS_MAX) })).statusCode).toBe(200)
    for (const body of [{ readings: readings(READINGS_MAX + 1) }, { readings: [] }, { readings: [...readings(1), ...readings(1)] },
      { readings: [{ tabId: 'bad id!', observation: {} }] }, { readings: readings(1), extra: true }]) {
      const res = await post(body)
      expect(res.statusCode, JSON.stringify(body).slice(0, 80)).toBe(400)
      expect(res.json().error.code).toBe('VALIDATION_ERROR')
    }
    expect(calls).toHaveLength(1)
  })
})

// A client that asks takes a machine's reading as one line (read/changes.ts); no other client's reply changes.
describe('the machine lines of a change read', () => {
  let app: FastifyInstance
  const changes = vi.fn(async (..._args: unknown[]) => ({ reload: true })), machineReadings = vi.fn(async (..._args: unknown[]) => ({ machines: [] }))
  beforeEach(async () => {
    changes.mockClear(); machineReadings.mockClear()
    app = Fastify()
    app.setErrorHandler(errorHandler)
    app.addHook('onRequest', async request => { request.user = { sub: 'u1', email: 'u1@example.com', autonomousEnv: 'prod', role: 'user' } as never })
    await app.register(superTabRoutes, { store: {} as never, github: null, reads: { changes, machineReadings } as never, hosts: {} as never })
    await app.ready()
  })
  afterEach(async () => { await app.close() })
  const get = (url: string) => app.inject({ method: 'GET', url })

  it('asks for lines only when the client does', async () => {
    expect((await get('/api/super-tabs/tab1/changes?cursor=abc')).statusCode).toBe(200)
    expect(changes.mock.calls[0]!.slice(2)).toEqual(['abc', undefined, {}])
    expect((await get('/api/super-tabs/tab1/changes?cursor=abc&machines=light')).statusCode).toBe(200)
    expect(changes.mock.calls[1]!.slice(2)).toEqual(['abc', undefined, { lightMachines: true }])
  })

  it('refuses any other value', async () => {
    expect((await get('/api/super-tabs/tab1/changes?cursor=abc&machines=all')).statusCode).toBe(400)
    expect(changes).not.toHaveBeenCalled()
  })

  // Task #2906: a client that holds the summary echoes its etag; a released client sends none and is asked nothing new.
  it('passes the summary etag a client echoes, with lines or without', async () => {
    expect((await get('/api/super-tabs/tab1/changes?cursor=abc&derivedEtag=e1_-Z')).statusCode).toBe(200)
    expect(changes.mock.calls[0]!.slice(2)).toEqual(['abc', undefined, { derivedEtag: 'e1_-Z' }])
    expect((await get('/api/super-tabs/tab1/changes?cursor=abc&machines=light&derivedEtag=e2')).statusCode).toBe(200)
    expect(changes.mock.calls[1]!.slice(2)).toEqual(['abc', undefined, { lightMachines: true, derivedEtag: 'e2' }])
  })

  it('refuses a malformed summary etag', async () => {
    for (const etag of ['bad!', '', 'x'.repeat(65)]) {
      const res = await get(`/api/super-tabs/tab1/changes?cursor=abc&derivedEtag=${etag}`)
      expect(res.statusCode, etag).toBe(400)
      expect(res.json().error.code).toBe('VALIDATION_ERROR')
    }
    expect(changes).not.toHaveBeenCalled()
  })

  it('serves the whole readings on demand, for an agent too', async () => {
    expect((await get('/api/super-tabs/tab1/machine-readings?asAgentId=agent1')).statusCode).toBe(200)
    expect(machineReadings.mock.calls[0]!.slice(1)).toEqual(['tab1', 'agent1'])
  })
})


// Swarm allocator, package 12: what an agent's conversation used on a task (superTabs/taskTokens.ts). A row is counts and ids
// only, and only a well-formed one reaches the store.
describe('a task\'s tokens over HTTP', () => {
  let app: FastifyInstance
  const recordTaskTokens = vi.fn(async (..._args: unknown[]) => ({ recorded: true })), taskTokens = vi.fn(async (..._args: unknown[]) => ({ rows: [] }))
  beforeEach(async () => {
    recordTaskTokens.mockClear(); taskTokens.mockClear()
    app = Fastify()
    app.setErrorHandler(errorHandler)
    app.addHook('onRequest', async request => { request.user = { sub: 'u1', email: 'u1@example.com', autonomousEnv: 'prod', role: 'user' } as never })
    await app.register(superTabRoutes, { store: { recordTaskTokens, taskTokens } as never, github: null, reads: {} as never, hosts: {} as never })
    await app.ready()
  })
  afterEach(async () => { await app.close() })
  const model = (name: string) => ({ model: name, input: 1, output: 2, cacheRead: 3, cacheWrite: 4 })
  const row = { repository: 'Acme/App', number: 14, kind: 'build', tokens: [model('claude-sonnet-5-5'), model('gpt-5.5')], rounds: 0, startedAt: 1_800_000_000_000, endedAt: 1_800_000_060_000 }
  const post = (payload: unknown, query = '?asAgentId=agent1') => app.inject({ method: 'POST', url: `/api/super-tabs/tab1/task-tokens${query}`, payload: payload as never })

  it('hands a well-formed row to the store, as the agent that wrote it', async () => {
    const res = await post(row)
    expect(res.statusCode).toBe(200)
    expect(res.json().data).toEqual({ recorded: true })
    expect(recordTaskTokens.mock.calls[0]!.slice(1)).toEqual(['tab1', 'agent1', row])
  })

  it('refuses a row that is not counts and ids, before it reaches the store', async () => {
    const bad: Array<[string, unknown, string?]> = [
      ['no agent', row, ''],
      ['a repository that is no owner/name', { ...row, repository: 'acme' }],
      ['an issue numbered zero', { ...row, number: 0 }],
      ['a number that is no whole number', { ...row, number: 1.5 }],
      ['a kind of work it does not know', { ...row, kind: 'review' }],
      ['no model', { ...row, tokens: [] }],
      ['seventeen models', { ...row, tokens: Array.from({ length: 17 }, (_, i) => model(`m${i}`)) }],
      ['a model named twice', { ...row, tokens: [model('gpt-5.5'), model('gpt-5.5')] }],
      ['a model\'s name with words in it', { ...row, tokens: [model('the task is to add a search field')] }],
      ['a count below zero', { ...row, tokens: [{ ...model('gpt-5.5'), output: -1 }] }],
      ['a count that is no whole number', { ...row, tokens: [{ ...model('gpt-5.5'), input: 0.5 }] }],
      ['a count missing', { ...row, tokens: [{ model: 'gpt-5.5', input: 1, output: 2, cacheRead: 3 }] }],
      ['a field it does not know', { ...row, title: 'Add a search field' }],
      ['a field it does not know on a model', { ...row, tokens: [{ ...model('gpt-5.5'), prompt: 'words' }] }],
      ['rounds below zero', { ...row, rounds: -1 }],
      ['an end before its start', { ...row, endedAt: row.startedAt - 1 }],
      ['a time that is no date', { ...row, endedAt: 9e15 }],
    ]
    for (const [what, payload, query] of bad) {
      const res = await post(payload, query)
      expect(res.statusCode, what).toBe(400)
      expect(res.json().error.code, what).toBe('VALIDATION_ERROR')
    }
    expect(recordTaskTokens).not.toHaveBeenCalled()
  })

  it('reads the rows of up to twenty numbers of a repository, for a person or as an agent', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/super-tabs/tab1/task-tokens?repository=Acme/App&numbers=14,20' })).statusCode).toBe(200)
    expect(taskTokens.mock.calls[0]!.slice(1)).toEqual(['tab1', 'Acme/App', [14, 20], undefined])
    const twenty = Array.from({ length: 20 }, (_, i) => i + 1)
    expect((await app.inject({ method: 'GET', url: `/api/super-tabs/tab1/task-tokens?repository=acme/app&numbers=${twenty.join(',')}&asAgentId=agent1` })).statusCode).toBe(200)
    expect(taskTokens.mock.calls[1]!.slice(1)).toEqual(['tab1', 'acme/app', twenty, 'agent1'])
    for (const query of ['repository=acme/app', 'numbers=14', 'repository=acme&numbers=14', 'repository=acme/app&numbers=', 'repository=acme/app&numbers=0',
      'repository=acme/app&numbers=1.5', 'repository=acme/app&numbers=14,x', `repository=acme/app&numbers=${[...twenty, 21].join(',')}`, 'repository=acme/app&numbers=14&all=1']) {
      const res = await app.inject({ method: 'GET', url: `/api/super-tabs/tab1/task-tokens?${query}` })
      expect(res.statusCode, query).toBe(400)
    }
    expect(taskTokens).toHaveBeenCalledTimes(2)
  })
})
