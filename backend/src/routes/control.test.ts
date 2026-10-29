import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

// Deny by default, against the route table production serves: every control-API route a team session is not
// explicitly allowed (lib/teamSession.ts TEAM_ROUTES) answers it 403, whatever the route. The session is a real one,
// minted and redeemed through lib/harnessSession.ts against in-memory stores, so the real authentication runs.
const fakes = vi.hoisted(() => {
  const redis = new Map<string, string>()
  const sessions: Array<Record<string, unknown> & { id: string }> = []
  const pick = (where: Record<string, unknown>) => sessions.find(s => Object.entries(where).every(([k, v]) => s[k] === v)) ?? null
  return {
    redis, sessions,
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
// The real hub starts its heartbeat timers on import; these tests never attach a hub client, so it is a stub with none.
vi.mock('../lib/hub.js', () => ({
  CLIENTS_FRAME: '__clients', CLIENTS_DIRTY: '__clients_dirty', LIVENESS_TICK_MS: 5_000, CLIENT_IDLE_DEADLINE_MS: 75_000,
  DEVICE_IDLE_DEADLINE_MS: 35_000, CLIENT_HEARTBEAT_MS: 25_000, deliverTerminalUpLocal: vi.fn(), deliverUpLocal: vi.fn(),
  pushDeviceRevoked: vi.fn(), sendClientsControl: vi.fn(), recomputeAndSendClients: vi.fn(), attachHubClient: vi.fn(),
  trackSocketLiveness: () => () => {},
}))
vi.mock('../services/UserService.js', () => ({
  userService: { get: vi.fn(async (id: string) => id === fakes.user.id ? fakes.user : null) },
  normalizeUserEmail: (email: string) => email.trim().toLowerCase(),
  isProvisionalUserEmail: () => false,
}))

import { registerAuthMiddleware, shouldSkipAuth } from '../middlewares/authMiddleware.js'
import { errorHandler } from '../middlewares/errorHandler.js'
import { redeemHandoff, startHandoff } from '../lib/harnessSession.js'
import { TEAM_ROUTES } from '../lib/teamSession.js'
import { registerControlRoutes } from './control.js'
import { createReadiness } from '../lib/readiness.js'

let app: FastifyInstance
let token: string
const routes: Array<{ method: string; url: string }> = []

beforeAll(async () => {
  const { code } = await startHandoff(fakes.user.id, 'team')
  token = (await redeemHandoff(code, 'MacBook Pro · Team', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'))!.token
  app = Fastify()
  app.setErrorHandler(errorHandler)
  app.addHook('onRoute', route => {
    for (const method of [route.method].flat()) if (method !== 'HEAD' && method !== 'OPTIONS') routes.push({ method, url: route.url })
  })
  registerAuthMiddleware(app)
  await registerControlRoutes(app, { daemons: { on: true, users: null }, count: async () => 0, readiness: createReadiness({}) })
  await app.ready()
})
afterAll(async () => { await app?.close() })

describe('a team session against every control route', () => {
  it('is refused everywhere the allowlist does not name, the phone\'s own routes included', async () => {
    const allowed = new Set(TEAM_ROUTES.map(r => `${r.method} ${r.url}`))
    const swept: string[] = []
    for (const { method, url } of routes) {
      if (allowed.has(`${method} ${url}`)) continue
      const path = url.replace(/:[A-Za-z]+/g, 'x0').replace(/\*/g, 'x0')
      // A public route takes no sign-in at all (health, sign-in itself, shared-secret callers): nothing to refuse.
      if (shouldSkipAuth(path) && !path.startsWith('/api/mobile/')) continue
      const res = await app.inject({ method: method as never, url: path, headers: { authorization: `Bearer ${token}` } })
      expect(res.statusCode, `${method} ${url}: ${res.body}`).toBe(403)
      expect(res.json().error?.code, `${method} ${url}`).toBe('TEAM_SESSION_LIMITED')
      swept.push(`${method} ${url}`)
    }
    // The table is the real one: the sweep covered the account's sensitive routes, not an empty list.
    for (const route of ['GET /api/machines', 'POST /api/auth/handoff', 'GET /api/auth/me', 'GET /api/connector-vault', 'GET /api/desk',
      'POST /api/auth/qr/approve', 'POST /api/device-auth/approve', 'GET /api/grid/profile', 'PUT /api/machines/:machineId/share',
      'GET /api/agent-messages', 'GET /api/harness-shares', 'GET /api/super-tabs', 'POST /api/super-tabs/:tabId/join',
      'GET /api/mobile/v1/overview', 'POST /api/device-keys']) expect(swept).toContain(route)
  })
})
