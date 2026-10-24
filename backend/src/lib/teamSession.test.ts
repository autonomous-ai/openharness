import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

// The REST gate for a team session (docs/plans/2026-10-24-swarm-team-account.md, Task 1): the real middleware and the
// real route modules a team daemon calls, with the stores faked. The Super Tab store itself is a recorder here; what it
// checks for a team session is covered against a real database in integration/superTabTeam.test.ts.
const m = vi.hoisted(() => {
  const machines: Array<Record<string, unknown>> = []
  const matches = (row: Record<string, unknown>, where: Record<string, unknown>) => !row.deletedAt &&
    Object.entries(where).every(([k, v]) => k === 'OR' || (typeof v === 'object' && v !== null) || row[k] === v)
  return {
    machines,
    prisma: {
      machine: {
        findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => machines.filter(row => matches(row, where))),
        findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => machines.find(row => matches(row, where)) ?? null),
      },
      harnessShare: { findUnique: vi.fn(), findMany: vi.fn(), upsert: vi.fn(), updateMany: vi.fn() },
      user: { findMany: vi.fn(), findUnique: vi.fn() },
    },
    deviceKeys: { read: vi.fn(), seen: vi.fn(), append: vi.fn(), acks: vi.fn(), ack: vi.fn(), touch: vi.fn() },
    machineService: { resolveOrCreateForComputer: vi.fn(), resolveForTeamComputer: vi.fn(), listForUser: vi.fn(), get: vi.fn(), destroy: vi.fn(), rename: vi.fn() },
    bus: { changed: vi.fn(), listChanged: vi.fn(), presence: vi.fn() },
  }
})
vi.mock('./prisma.js', () => ({ prisma: m.prisma, machineAlive: { OR: [{ deletedAt: null }, { deletedAt: { isSet: false } }] } }))
vi.mock('./bus.js', () => ({ publishShareChanged: m.bus.changed, publishDeviceMachineListChanged: m.bus.listChanged, getAgentPresenceMany: m.bus.presence }))
vi.mock('./deviceKeyLog.js', () => ({ readDeviceKeyLog: m.deviceKeys.read, deviceKeysSeen: m.deviceKeys.seen, appendDeviceKey: m.deviceKeys.append,
  readDeviceAcks: m.deviceKeys.acks, appendDeviceAck: m.deviceKeys.ack, touchDeviceKey: m.deviceKeys.touch }))
vi.mock('./machineAccess.js', () => ({ machinesSharedWith: vi.fn(async () => []) }))
vi.mock('../superTabs/store.js', () => ({ SuperTabStore: class { mayObserve = vi.fn(async () => true) } }))
// The real hub starts its heartbeat timers on import; these tests never attach a hub client, so it is a stub with none.
vi.mock('./hub.js', () => ({
  CLIENTS_FRAME: '__clients', CLIENTS_DIRTY: '__clients_dirty', LIVENESS_TICK_MS: 5_000, CLIENT_IDLE_DEADLINE_MS: 75_000,
  DEVICE_IDLE_DEADLINE_MS: 35_000, CLIENT_HEARTBEAT_MS: 25_000, deliverTerminalUpLocal: vi.fn(), deliverUpLocal: vi.fn(),
  pushDeviceRevoked: vi.fn(), sendClientsControl: vi.fn(), recomputeAndSendClients: vi.fn(), attachHubClient: vi.fn(),
  trackSocketLiveness: () => () => {},
}))
vi.mock('../services/index.js', () => ({ machineService: m.machineService, machineBillingService: {}, userService: { get: vi.fn() } }))

import { registerAuthMiddleware } from '../middlewares/authMiddleware.js'
import { errorHandler } from '../middlewares/errorHandler.js'
import { superTabRoutes } from '../routes/superTabs.js'
import { harnessShareRoutes } from '../routes/harnessShares.js'
import { deviceKeyRoutes } from '../routes/deviceKeys.js'
import { machineRoutes } from '../routes/machines.js'
import { SsoAuthError, type AuthUser } from './ssoAuth.js'
import type { SuperTabStore } from '../superTabs/store.js'
import { TEAM_ROUTES } from './teamSession.js'

const OWNER_COMPUTER = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const TEAM_COMPUTER = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const owner: AuthUser = { sub: 'owner', email: 'owner@example.com', role: 'user', autonomousEnv: 'prod' }
const team: AuthUser = { ...owner, harnessSessionId: 'team-session', harnessSessionKind: 'team', harnessComputerId: TEAM_COMPUTER }
const ownerMac = { machineId: 'owner-mac', userId: 'owner', computerId: OWNER_COMPUTER, authMode: 'remote', autonomousEnv: 'prod',
  billingStatus: 'not_required', sessionKind: 'computer', createdAt: new Date(0) }
const teamMac = { machineId: 'team-mac', userId: 'owner', computerId: TEAM_COMPUTER, authMode: 'remote', autonomousEnv: 'prod',
  billingStatus: 'not_required', sessionKind: 'team', createdAt: new Date(1) }

/** Like the real check (lib/ssoAuth.ts): a team session only where the caller opts in. */
const authenticate = vi.fn(async (token: string, _env?: unknown, opts?: { allowTeamSession?: boolean }) => {
  if (token === 'owner-token') return owner
  if (token === 'team-token') {
    if (!opts?.allowTeamSession) throw new SsoAuthError('This connection is not available to a team sign-in', 'TEAM_SESSION_LIMITED')
    return team
  }
  throw new SsoAuthError('Invalid', 'INVALID_TOKEN')
})

/** A Super Tab store that records what reached it, for every method the routes call. */
function recorder() {
  const calls: Array<{ method: string; args: unknown[] }> = []
  const methods = (prefix = ''): Record<string, unknown> => new Proxy({}, { get: (_t, name: string) => name === 'then' ? undefined
    : name === 'native' && !prefix ? methods('native.')
      : async (...args: unknown[]) => { calls.push({ method: `${prefix}${name}`, args }); return { ok: true } } })
  return { store: methods() as unknown as SuperTabStore, calls }
}

let app: FastifyInstance
let store: ReturnType<typeof recorder>
beforeEach(async () => {
  vi.clearAllMocks()
  m.machines.length = 0
  m.machines.push({ ...ownerMac }, { ...teamMac })
  m.deviceKeys.read.mockResolvedValue({ acct: 'owner', head: { seq: 0, hash: 'h' }, entries: [] })
  m.prisma.harnessShare.updateMany.mockResolvedValue({ count: 1 })
  m.prisma.harnessShare.findUnique.mockResolvedValue(null)
  m.prisma.user.findUnique.mockResolvedValue(null)
  m.machineService.resolveForTeamComputer.mockResolvedValue({ machine: teamMac, created: false })
  m.machineService.resolveOrCreateForComputer.mockResolvedValue({ machine: ownerMac, created: false })
  store = recorder()
  app = Fastify()
  app.setErrorHandler(errorHandler)
  registerAuthMiddleware(app, authenticate as never)
  await app.register(superTabRoutes, { store: store.store })
  // Task 4's route (#1690, not merged here), as it calls the store: the gate covers it by its path from the moment it lands.
  app.post<{ Params: { tabId: string }; Querystring: { asAgentId?: string }; Body: { machineId: string } }>('/api/super-tabs/:tabId/github-token',
    async req => ({ success: true, data: await (store.store as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>)
      .githubAssignment(req.user!, req.params.tabId, req.query.asAgentId, req.body.machineId) }))
  await app.register(harnessShareRoutes)
  await app.register(deviceKeyRoutes)
  await app.register(machineRoutes)
  await app.ready()
})
afterEach(async () => { await app.close() })

const call = (method: string, url: string, payload?: unknown, token = 'team-token') =>
  app.inject({ method: method as never, url, headers: { authorization: `Bearer ${token}` }, ...(payload === undefined ? {} : { payload: payload as never }) })
const limited = (res: { statusCode: number; json: () => { error?: { code?: string } } }) => {
  expect(res.statusCode).toBe(403)
  expect(res.json().error?.code).toBe('TEAM_SESSION_LIMITED')
}

const command = { operationId: 'op-1', command: { type: 'message.send', conversationId: 'lead', text: 'Done.', replyTo: null, recipientIds: [] } }
const observation = { generation: 'g1', resources: { cpuPercent: null, memoryTotalBytes: null, memoryUsedBytes: null, diskFreeBytes: null,
  diskTotalBytes: null, projectDiskFreeBytes: null, deviceType: null, chip: null, os: null, gpuPercent: null },
  tools: {}, quotas: [], runningHarnessIds: [], stoppedHarnessIds: [] }
const startOp = { operationId: 'op-2', command: { type: 'agent.startSettled', startId: 'start-1', warning: null } }
const share = () => ({ superTabId: 'a'.repeat(24), machineId: 'team-mac', agentId: 'harness-1', name: 'Builder', engine: 'codex',
  recipientEmail: 'teammate@example.com', ownerPublicKey: Buffer.alloc(32, 1).toString('base64'),
  expiresAt: new Date(Date.now() + 86_400_000).toISOString() })

describe('a team session on its own machine', () => {
  // Every route the allowlist names, as a team daemon calls it, and the store method each one reaches.
  const own: Array<[string, string, unknown, string]> = [
    ['GET', '/api/super-tabs/hosts/team-mac', undefined, 'hostTabs'],
    ['GET', '/api/super-tabs/hosts/team-mac/pools', undefined, 'hostPools'],
    ['GET', '/api/super-tabs/hosts/team-mac/assignments', undefined, 'hostAssignments'],
    ['POST', '/api/super-tabs/hosts/team-mac/terminal', undefined, 'hostTerminal'],
    ['GET', '/api/super-tabs/hosts/team-mac/starts/tab-1/start-1', undefined, 'start'],
    ['POST', '/api/super-tabs/hosts/team-mac/starts/tab-1/start-1', startOp, 'execute'],
    ['POST', '/api/super-tabs/tab-1/machines/team-mac', observation, 'observeMachine'],
    ['GET', '/api/super-tabs/tab-1?asAgentId=agent-1', undefined, 'read'],
    ['GET', '/api/super-tabs/tab-1/starts/start-1?asAgentId=agent-1', undefined, 'start'],
    ['GET', '/api/super-tabs/tab-1/routing-policy?asAgentId=agent-1', undefined, 'tabPolicy'],
    ['GET', '/api/super-tabs/tab-1/route-decisions?asAgentId=agent-1', undefined, 'routeDecisions'],
    ['GET', '/api/super-tabs/tab-1/route-decisions/decision-1?asAgentId=agent-1', undefined, 'routeDecision'],
    ['GET', '/api/super-tabs/tab-1/conversations/lead/messages?asAgentId=agent-1', undefined, 'messages'],
    ['GET', '/api/super-tabs/tab-1/conversations/lead/attempts?asAgentId=agent-1', undefined, 'attempts'],
    ['GET', '/api/super-tabs/tab-1/terminal/request-1?asAgentId=agent-1', undefined, 'terminalResult'],
    ['POST', '/api/super-tabs/tab-1/commands', { ...command, asAgentId: 'agent-1' }, 'execute'],
    ['GET', '/api/super-tabs/tab-1/agents/agent-1/deliveries', undefined, 'deliveries'],
    ['GET', '/api/super-tabs/tab-1/agents/agent-1/deliveries/delivery-1', undefined, 'deliveryReceipt'],
    ['POST', '/api/super-tabs/tab-1/agents/agent-1/deliveries/delivery-1', { type: 'claim', claimId: 'claim-1' }, 'delivery'],
    ['POST', '/api/super-tabs/tab-1/stopped', { assignmentId: 'assignment-1', receipt: 'stopped' }, 'stopped'],
    ['GET', '/api/super-tabs/tab-1/native/context-1', undefined, 'native.read'],
    ['POST', '/api/super-tabs/tab-1/native/context-1', { turnId: 't1', kind: 'prompt', previousEventId: null, text: 'hi', truncated: false, interrupted: false }, 'native.append'],
    ['GET', '/api/super-tabs/tab-1/projects/project-1/roles/dev', undefined, 'roleText'],
  ]
  for (const [method, url, payload, reached] of own) {
    it(`${method} ${url.split('?')[0]} reaches the store as the team session`, async () => {
      const res = await call(method, url, payload)
      expect(res.statusCode, res.body).toBe(200)
      expect(store.calls.map(c => c.method)).toEqual([reached])
      expect(store.calls[0]!.args[0]).toMatchObject({ harnessSessionKind: 'team', harnessComputerId: TEAM_COMPUTER })
    })
  }

  it('asks for its own agent\'s GitHub token, naming its own machine', async () => {
    const res = await call('POST', '/api/super-tabs/tab-1/github-token?asAgentId=agent-1', { machineId: 'team-mac' })
    expect(res.statusCode, res.body).toBe(200)
    expect(store.calls).toEqual([{ method: 'githubAssignment', args: [expect.objectContaining({ harnessSessionKind: 'team' }), 'tab-1', 'agent-1', 'team-mac'] }])
  })

  it('registers its own computer, as a team machine', async () => {
    const res = await call('POST', '/api/machines/resolve-computer', { computerId: TEAM_COMPUTER.toUpperCase(), label: 'MacBook Pro · Team' })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().data).toEqual({ machine: { machineId: 'team-mac', computerId: TEAM_COMPUTER }, created: false })
    expect(m.machineService.resolveForTeamComputer).toHaveBeenCalledWith(expect.objectContaining({ harnessSessionKind: 'team' }),
      TEAM_COMPUTER, 'MacBook Pro · Team', undefined)
    expect(m.machineService.resolveOrCreateForComputer).not.toHaveBeenCalled()
  })

  it('shares one of its harnesses with a Swarm member for a read-only view, and takes it back', async () => {
    const id = randomUUID()
    expect((await call('PUT', `/api/harness-shares/${id}`, share())).statusCode).toBe(200)
    expect(m.prisma.harnessShare.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ machineId: 'team-mac', superTabId: 'a'.repeat(24), ownerId: 'owner' }) }))
    expect((await call('DELETE', `/api/harness-shares/${id}`)).statusCode).toBe(200)
    expect(m.prisma.harnessShare.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id, ownerId: 'owner', machineId: 'team-mac' }) }))
  })

  it('reads the account\'s device keys, to know whom to let in', async () => {
    const res = await call('GET', '/api/device-keys?since=0')
    expect(res.statusCode).toBe(200)
    expect(m.deviceKeys.read).toHaveBeenCalledWith('owner', 0)
  })
})

describe('a team session reaching past its own machine', () => {
  it('cannot use the host routes of another machine of the account', async () => {
    for (const [method, url, payload] of [
      ['GET', '/api/super-tabs/hosts/owner-mac', undefined],
      ['GET', '/api/super-tabs/hosts/owner-mac/pools', undefined],
      ['GET', '/api/super-tabs/hosts/owner-mac/assignments', undefined],
      ['POST', '/api/super-tabs/hosts/owner-mac/terminal', undefined],
      ['GET', '/api/super-tabs/hosts/owner-mac/starts/tab-1/start-1', undefined],
      ['POST', '/api/super-tabs/hosts/owner-mac/starts/tab-1/start-1', startOp],
      ['POST', '/api/super-tabs/tab-1/machines/owner-mac', observation],
    ] as const) limited(await call(method, url, payload))
    expect(store.calls).toEqual([])
  })

  it('cannot read or speak as the person: every agent route needs one of its agents', async () => {
    for (const url of ['/api/super-tabs/tab-1', '/api/super-tabs/tab-1/starts/start-1', '/api/super-tabs/tab-1/routing-policy',
      '/api/super-tabs/tab-1/route-decisions', '/api/super-tabs/tab-1/route-decisions/decision-1',
      '/api/super-tabs/tab-1/conversations/lead/messages', '/api/super-tabs/tab-1/conversations/lead/attempts',
      '/api/super-tabs/tab-1/terminal/request-1', '/api/super-tabs/tab-1?asAgentId=']) limited(await call('GET', url))
    limited(await call('POST', '/api/super-tabs/tab-1/attachments'))
    expect(store.calls).toEqual([])
  })

  it('never gets a GitHub token naming another machine, or as no agent at all', async () => {
    for (const machineId of ['owner-mac', undefined, 7]) {
      limited(await call('POST', '/api/super-tabs/tab-1/github-token?asAgentId=agent-1', machineId === undefined ? {} : { machineId }))
    }
    limited(await call('POST', '/api/super-tabs/tab-1/github-token', { machineId: 'team-mac' }))
    expect(store.calls).toEqual([])
    // As an agent on another machine: the store resolves `asAgentId` through `actor()`, which refuses a team session
    // speaking for an agent anywhere but its own machine (integration/superTabTeam.test.ts).
  })

  it('cannot register, list, rename or delete other machines, or share one', async () => {
    const res = await call('POST', '/api/machines/resolve-computer', { computerId: OWNER_COMPUTER, label: 'MacBook Pro' })
    limited(res)
    expect(m.machineService.resolveForTeamComputer).not.toHaveBeenCalled()
    expect(m.machineService.resolveOrCreateForComputer).not.toHaveBeenCalled()
    for (const [method, url] of [['GET', '/api/machines'], ['GET', '/api/machines/team-mac'], ['GET', '/api/machines/owner-mac'],
      ['PATCH', '/api/machines/team-mac'], ['DELETE', '/api/machines/owner-mac'], ['POST', '/api/machines/owner-mac/start'],
      ['POST', '/api/machines'], ['GET', '/api/machines/resolve?deviceId=1']] as const) limited(await call(method, url, method === 'PATCH' ? { name: 'x' } : undefined))
    expect(m.machineService.listForUser).not.toHaveBeenCalled()
  })

  it('cannot share another machine\'s harness, a harness outside a Swarm, or take back another machine\'s share', async () => {
    limited(await call('PUT', `/api/harness-shares/${randomUUID()}`, { ...share(), machineId: 'owner-mac' }))
    limited(await call('PUT', `/api/harness-shares/${randomUUID()}`, { ...share(), superTabId: null }))
    const { superTabId: _dropped, ...noSwarm } = share()
    limited(await call('PUT', `/api/harness-shares/${randomUUID()}`, noSwarm))
    expect(m.prisma.harnessShare.upsert).not.toHaveBeenCalled()
    // A share of the owner's own Mac is not this machine's to revoke: the update matches nothing.
    m.prisma.harnessShare.updateMany.mockResolvedValueOnce({ count: 0 })
    expect((await call('DELETE', `/api/harness-shares/${randomUUID()}`)).statusCode).toBe(404)
    // And never lists harnesses shared with the person.
    limited(await call('GET', '/api/harness-shares'))
  })

  it('cannot add a key to the account, vouch for one, or read when keys were used', async () => {
    limited(await call('POST', '/api/device-keys', { entry: {} }))
    limited(await call('POST', '/api/device-keys/acks', { ack: {} }))
    limited(await call('GET', '/api/device-keys/acks?since=0'))
    limited(await call('GET', '/api/device-keys/seen'))
    expect(m.deviceKeys.append).not.toHaveBeenCalled()
    expect(m.deviceKeys.ack).not.toHaveBeenCalled()
  })

  it('cannot use the person\'s Swarm routes: list, create, invite, join, sharing, rules, terminals or machine removal', async () => {
    for (const [method, url, payload] of [
      ['GET', '/api/super-tabs', undefined],
      ['POST', '/api/super-tabs', { operationId: 'op', name: 'Mine' }],
      ['GET', '/api/super-tabs/invitations', undefined],
      ['GET', '/api/super-tabs/tab-1/sharing', undefined],
      ['POST', '/api/super-tabs/tab-1/sharing', { operationId: 'op', revision: 0, access: null }],
      ['POST', '/api/super-tabs/tab-1/join/preview', { token: 'x' }],
      ['POST', '/api/super-tabs/tab-1/join', { operationId: 'op' }],
      ['GET', '/api/super-tabs/routing-policy', undefined],
      ['POST', '/api/super-tabs/routing-policy', { revision: 0, policy: {} }],
      ['POST', '/api/super-tabs/tab-1/native', { operationId: 'op', conversationId: 'lead', agentId: 'agent-1' }],
      ['GET', '/api/super-tabs/tab-1/machines/team-mac/removal', undefined],
      ['GET', '/api/super-tabs/tab-1/machines/owner-mac/removal', undefined],
    ] as const) limited(await call(method, url, payload))
    expect(store.calls).toEqual([])
  })

  it('cannot reach a route that does not exist either: a refusal, not a not-found', async () => {
    limited(await call('GET', '/api/nothing-here'))
  })

  it('without its machine registered yet, it can reach no host or agent route', async () => {
    m.machines.splice(m.machines.findIndex(row => row.machineId === 'team-mac'), 1)
    limited(await call('GET', '/api/super-tabs/hosts/team-mac'))
    limited(await call('GET', '/api/super-tabs/tab-1?asAgentId=agent-1'))
    limited(await call('POST', '/api/super-tabs/tab-1/commands', { ...command, asAgentId: 'agent-1' }))
    expect(store.calls).toEqual([])
  })

  it('a row for its computer that a normal sign-in holds is not its machine', async () => {
    m.machines.find(row => row.machineId === 'team-mac')!.sessionKind = 'computer'
    limited(await call('GET', '/api/super-tabs/hosts/team-mac'))
    m.machines.find(row => row.machineId === 'team-mac')!.sessionKind = undefined
    limited(await call('GET', '/api/super-tabs/hosts/team-mac'))
    expect(store.calls).toEqual([])
  })
})

describe('behind the gate, each surface refuses on its own too', () => {
  it('Grid never takes a team session as the person', async () => {
    const { answerGridProfile } = await import('./gridProfile.js')
    expect(await answerGridProfile(team, 'unused')).toEqual({ status: 403, code: 'TEAM_SESSION_LIMITED', message: expect.any(String) })
  })
})

describe('the owner, unchanged', () => {
  it('reaches the same routes, as the person', async () => {
    expect((await call('GET', '/api/super-tabs/tab-1', undefined, 'owner-token')).statusCode).toBe(200)
    expect((await call('GET', '/api/super-tabs/hosts/owner-mac', undefined, 'owner-token')).statusCode).toBe(200)
    expect((await call('GET', '/api/super-tabs/hosts/team-mac', undefined, 'owner-token')).statusCode).toBe(200)
    // A computer's GitHub token request is the store's to judge, whatever machine its body names.
    expect((await call('POST', '/api/super-tabs/tab-1/github-token?asAgentId=agent-1', { machineId: 'owner-mac' }, 'owner-token')).statusCode).toBe(200)
    expect(store.calls.map(c => c.args[0])).toEqual([owner, owner, owner, owner])
  })
})

describe('the allowlist', () => {
  it('names only routes that exist, each once', async () => {
    const seen = new Set<string>()
    const probe = Fastify()
    probe.addHook('onRoute', route => {
      for (const method of [route.method].flat()) seen.add(`${method} ${route.url}`)
    })
    const { registerControlRoutes } = await import('../routes/control.js')
    await registerControlRoutes(probe, { daemons: { on: true, users: null } as never, count: async () => 0 })
    await probe.ready()
    const named = TEAM_ROUTES.map(r => `${r.method} ${r.url}`)
    expect(new Set(named).size).toBe(named.length)
    // A route another pull request adds is listed ahead of it (`pending`), so the gate covers it the moment it lands.
    for (const route of TEAM_ROUTES.filter(r => !r.pending)) expect(seen, route.url).toContain(`${route.method} ${route.url}`)
    await probe.close()
  })

  it('only the REST gate and the machine socket opt in to team sessions', () => {
    // Deny by default lives in lib/ssoAuth.ts: a team session is refused unless the caller passes `allowTeamSession`.
    // Any new caller that does must confine the session to its machine as these two do, and be listed here.
    const root = join(__dirname, '..')
    const files: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name)
        if (statSync(path).isDirectory()) walk(path)
        else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) files.push(path)
      }
    }
    walk(root)
    const optIn = files.filter(f => /allowTeamSession\s*:\s*true/.test(readFileSync(f, 'utf8'))).map(f => relative(root, f)).sort()
    expect(optIn).toEqual(['lib/adapterWs.ts', 'middlewares/authMiddleware.ts'])
  })
})
