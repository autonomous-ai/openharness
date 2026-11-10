import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import { Prisma, type PrismaClient } from '@prisma/client'

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
      machine: {
        findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => where.computerId === 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
          ? [{ machineId: 'team-mac', userId: 'owner', computerId: where.computerId, billingStatus: 'not_required', sessionKind: 'team' }] : []),
        // Other accounts' Team machines on the redeeming computer (superTabs/computerMoves.ts teamCleanupPending): none here.
        aggregateRaw: vi.fn(async () => []),
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
import { REFUSED_TO_PEOPLE, RETIRED_COMMANDS, RETIRED_NOTE } from '../superTabs/retired.js'
import { counted, OLD_PAYLOADS } from '../superTabs/retired.test-support.js'
import { SuperTabStore } from '../superTabs/store.js'
import { recordingDb, type Query } from '../lib/queryRecorder.test-support.js'
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

// An older app, host or agent still sends a command v4 dropped (superTabs/retired.ts): the route accepts it, and the real
// store answers it as ignored without a read or a write.
describe('a command Swarm v4 no longer has, over HTTP', () => {
  let app: FastifyInstance
  const queries: Query[] = []
  beforeEach(async () => {
    queries.length = 0
    app = Fastify()
    app.setErrorHandler(errorHandler)
    app.addHook('onRequest', async request => { request.user = { sub: 'u1', email: 'u1@example.com', autonomousEnv: 'prod', role: 'user' } as never })
    await app.register(superTabRoutes, { store: new SuperTabStore(recordingDb(queries) as PrismaClient), github: null, reads: {} as never, hosts: {} as never })
    await app.ready()
  })
  afterEach(async () => { await app.close() })
  const send = (command: object, asAgentId?: string) => app.inject({ method: 'POST', url: '/api/super-tabs/tab-1/commands', headers: { 'x-harness-client': 'desktop/1.2.3' },
    payload: { operationId: 'op-1', command, ...asAgentId ? { asAgentId } : {} } })

  it.each(RETIRED_COMMANDS)('answers %s ok and ignored, as an agent too, counts the client it declares and touches no data', async type => {
    const before = await counted(type, 'desktop')
    for (const asAgentId of [undefined, 'agent-1']) {
      const res = await send({ type, ...OLD_PAYLOADS[type] }, asAgentId)
      // A person's that an older app would take as saved is refused in words it shows (REFUSED_TO_PEOPLE); an agent's is ignored.
      const refused = asAgentId ? undefined : REFUSED_TO_PEOPLE[type]
      expect({ status: res.statusCode, body: res.json() }).toEqual(refused
        ? { status: refused.status, body: expect.objectContaining({ success: false, error: expect.objectContaining({ code: refused.code, message: refused.message }) }) }
        : { status: 200, body: { success: true, data: { result: { ignored: true, note: RETIRED_NOTE }, parts: [] } } })
    }
    expect(await counted(type, 'desktop')).toBe(before + 2)
    expect(queries).toEqual([])
  })

  it('still refuses a type no version had, and a host\'s start route that names no start', async () => {
    expect((await send({ type: 'project.nonsense', projectId: 'lead' })).statusCode).toBe(400)
    const host = await app.inject({ method: 'POST', url: '/api/super-tabs/hosts/m1/starts/tab-1/s1',
      payload: { operationId: 'op-1', command: { type: 'project.digest', ...OLD_PAYLOADS['project.digest'] } } })
    expect(host.statusCode).toBe(403)
    expect(queries).toEqual([])
  })
})

// Terminal recording is gone with Swarm v4, but an older Desktop still opens a terminal's context and an older host still reads it and
// records into it. Each is answered ok and ignored, to everyone, and nothing is read. A host drops an observation once it is
// acknowledged by the id it makes of it (cli superTabs/native.ts eventId): so that one carries the same id, and a journal from before
// drains instead of being sent again for ever.
describe('the retired terminal recording', () => {
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
  /** The id the CLI's recorder makes of an observation (cli superTabs/native.ts eventId). */
  const recorderId = (contextId: string, turnId: string, kind: string) =>
    createHash('sha256').update(JSON.stringify(['native-event', contextId, turnId, kind])).digest('hex').slice(0, 24)
  const observation = (kind: string) => ({ turnId: 'turn-1', kind, previousEventId: null, text: 'hi', truncated: false, interrupted: false })

  it('answers the open and the read ok and ignored, whatever the Swarm, and reads nothing', async () => {
    for (const tab of ['tab-1', 'tab-2']) {
      const opened = await app.inject({ method: 'POST', url: `/api/super-tabs/${tab}/native`, payload: { operationId: 'op-1', conversationId: 'lead', agentId: 'agent-1' } })
      expect(opened.statusCode).toBe(200)
      expect(opened.json()).toEqual({ success: true, data: { ok: true, ignored: true } })
      const read = await app.inject({ method: 'GET', url: `/api/super-tabs/${tab}/native/ctx-1` })
      expect(read.statusCode).toBe(200)
      expect(read.json()).toEqual({ success: true, data: { ok: true, ignored: true } })
    }
  })

  it.each(['prompt', 'answer', 'gap'])('acknowledges a %s by the id its host makes of it', async kind => {
    const res = await app.inject({ method: 'POST', url: '/api/super-tabs/tab-1/native/ctx-1', payload: observation(kind) })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ success: true, data: { ok: true, ignored: true, eventId: recorderId('ctx-1', 'turn-1', kind) } })
  })

  it('still refuses an observation that names no turn or no kind', async () => {
    for (const payload of [{ kind: 'prompt' }, { turnId: 'turn-1' }, { turnId: 'turn-1', kind: 'typed' }]) {
      expect((await app.inject({ method: 'POST', url: '/api/super-tabs/tab-1/native/ctx-1', payload })).statusCode, JSON.stringify(payload)).toBe(400)
    }
  })
})

// The scorecard is gone with Swarm v4, and an older Desktop's Scorecard tab still reads it: it gets no days, whoever asks and
// whichever Swarm it names, and nothing is read. integration/superTabNotAvailable.test.ts tries it against the real store.
describe('the retired scorecard read', () => {
  let app: FastifyInstance
  beforeEach(async () => {
    app = Fastify()
    app.setErrorHandler(errorHandler)
    app.addHook('onRequest', async request => { request.user = { sub: 'u1', email: 'u1@example.com', autonomousEnv: 'prod', role: 'user' } as never })
    // A store, reads and host reads that fail on any call: the answer must not touch them.
    await app.register(superTabRoutes, { store: {} as never, github: null, reads: {} as never, hosts: {} as never })
    await app.ready()
  })
  afterEach(async () => { await app.close() })

  it('answers no days, with the query an older Desktop sends or none, and reads nothing', async () => {
    for (const url of ['/api/super-tabs/tab-1/scorecard?projectId=lead', '/api/super-tabs/tab-1/scorecard?projectId=lead&scope=all', '/api/super-tabs/tab-2/scorecard']) {
      const res = await app.inject({ method: 'GET', url })
      expect(res.statusCode, url).toBe(200)
      expect(res.json(), url).toEqual({ success: true, data: { days: [] } })
    }
  })
})

// Decisions, tags, Activity, reminders, followed threads, the inbox and catch-up are gone with Swarm v4 (anh Dee, 2026-11-10): an agent
// reaches its person in their 1:1 chat. An older Desktop, phone or host still reads them: each gets its empty answer, whoever asks,
// whichever Swarm and query it names, and nothing is read.
describe('the retired reads', () => {
  let app: FastifyInstance
  beforeEach(async () => {
    app = Fastify()
    app.setErrorHandler(errorHandler)
    app.addHook('onRequest', async request => { request.user = { sub: 'u1', email: 'u1@example.com', autonomousEnv: 'prod', role: 'user' } as never })
    // A store, reads and host reads that fail on any call: the answer must not touch them.
    await app.register(superTabRoutes, { store: {} as never, github: null, reads: {} as never, hosts: {} as never })
    await app.ready()
  })
  afterEach(async () => { await app.close() })

  // Tags, Activity, reminders, followed threads, the inbox and catch-up go too (S11): each answers its empty answer.
  it('answers an older client\'s tags, Activity, reminders, threads, inbox and catch-up reads with none, and reads nothing', async () => {
    const none = { total: 0, items: [] }
    for (const [url, data] of [
      ['/api/super-tabs/tab-1/mentions?state=waiting', { mentions: [] }], ['/api/super-tabs/tab-2/mentions?state=earlier', { mentions: [] }],
      ['/api/super-tabs/tab-1/activity', { items: [], more: false }], ['/api/super-tabs/tab-1/reminders', { due: [], next: null }],
      ['/api/super-tabs/tab-1/threads?read=50', { unread: [], read: [], more: false }], ['/api/super-tabs/tab-1/inbox', { threads: [], latest: [], more: false }],
      // Catch-up's span ends where it started, at the mark it was sent: never behind it.
      ['/api/super-tabs/tab-1/conversations/c1/catch-up?after=4', { after: 4, through: 4, unread: 0, more: false, decisions: 0, landed: none, blocked: none,
        needsYou: none }],
      ['/api/super-tabs/tab-1/conversations/c1/catch-up?after=x', { after: 0, through: 0, unread: 0, more: false, decisions: 0, landed: none, blocked: none,
        needsYou: none }],
    ] as const) {
      const res = await app.inject({ method: 'GET', url })
      expect({ status: res.statusCode, body: res.json() }, url).toEqual({ status: 200, body: { success: true, data } })
    }
  })

  it('answers an older client\'s Activity read mark, thread follow and cleared reminder as done, refuses a new reminder in words, and reads nothing', async () => {
    for (const [url, payload, data] of [
      ['/api/super-tabs/tab-1/activity/read', { through: '2026-11-01T00:00:00.000Z' }, { marked: 0 }],
      ['/api/super-tabs/tab-1/conversations/c1/threads/m1/follow', { follow: true }, { follow: null }],
      ['/api/super-tabs/tab-1/conversations/c1/messages/m1/reminder', { at: null }, { cleared: false }],
    ] as const) {
      const res = await app.inject({ method: 'POST', url, payload })
      expect({ status: res.statusCode, body: res.json() }, url).toEqual({ status: 200, body: { success: true, data } })
    }
    const set = await app.inject({ method: 'POST', url: '/api/super-tabs/tab-1/conversations/c1/messages/m1/reminder', payload: { at: '2026-11-11T09:00:00.000Z' } })
    expect({ status: set.statusCode, body: set.json() }).toEqual({ status: 410,
      body: { success: false, error: { code: 'REMINDERS_RETIRED', message: 'Reminders are gone. Nothing was set.' } } })
  })

  // Proposals go too (S9): an older Desktop's Tasks view reads a project's.
  it('answers an older client\'s proposals read with none, with each query it sent, and reads nothing', async () => {
    for (const url of ['/api/super-tabs/tab-1/proposals?projectId=app', '/api/super-tabs/tab-2/proposals?projectId=lead', '/api/super-tabs/tab-1/proposals']) {
      const res = await app.inject({ method: 'GET', url })
      expect({ status: res.statusCode, body: res.json() }, url).toEqual({ status: 200, body: { success: true, data: { proposals: [] } } })
    }
  })

  it('answers an older client\'s decisions read with none, with each query it sent, and reads nothing', async () => {
    for (const url of ['/api/super-tabs/tab-1/decisions?state=open', '/api/super-tabs/tab-1/decisions?state=answered&asAgentId=agent-1',
      '/api/super-tabs/tab-2/decisions?state=settled', '/api/super-tabs/tab-2/decisions']) {
      const res = await app.inject({ method: 'GET', url })
      expect({ status: res.statusCode, body: res.json() }, url).toEqual({ status: 200, body: { success: true, data: { more: false, decisions: [] } } })
    }
  })
})

// No picture is set any more (2026-11-09), but an older Desktop or phone still uploads one before it sends the retired `member.avatar`
// or `agent.avatar`. Whoever asks, for whichever Swarm, the upload is refused in words, nothing is read and nothing is kept.
// integration/superTabProfile.test.ts tries it against the real store.
describe('the retired picture upload', () => {
  let app: FastifyInstance
  beforeEach(async () => {
    app = Fastify()
    app.setErrorHandler(errorHandler)
    app.addHook('onRequest', async request => { request.user = { sub: 'u1', email: 'u1@example.com', autonomousEnv: 'prod', role: 'user' } as never })
    // A store, reads and host reads that fail on any call: the answer must not touch them.
    await app.register(superTabRoutes, { store: {} as never, github: null, reads: {} as never, hosts: {} as never })
    await app.ready()
  })
  afterEach(async () => { await app.close() })

  it('refuses the form an older app sends, whatever the Swarm, agent or picture, and reads nothing', async () => {
    const boundary = 'avatar-boundary'
    const form = (bytes: string) => `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="me.png"\r\nContent-Type: image/png\r\n\r\n${bytes}\r\n--${boundary}--\r\n`
    for (const [url, bytes] of [['/api/super-tabs/tab-1/avatars', '\x89PNG'], ['/api/super-tabs/tab-2/avatars?asAgentId=agent-1', 'x'.repeat(1536 * 1024)]]) {
      const res = await app.inject({ method: 'POST', url, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: form(bytes) })
      expect(res.statusCode, url).toBe(410)
      expect(res.json(), url).toEqual({ success: false, error: { code: 'AVATARS_RETIRED', message: 'Pictures can’t be changed any more.' } })
    }
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

