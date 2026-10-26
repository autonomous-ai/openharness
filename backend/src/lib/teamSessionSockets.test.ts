import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The sockets a team session meets (docs/plans/2026-10-24-swarm-team-account.md, Task 1). The machine socket takes one
// only as the machine of the computer it is bound to; the web relay (machine_select, attach) and the device lane
// refuse it outright. Authentication is faked here: what lib/ssoAuth.ts itself refuses is in harnessSession.test.ts.
const m = vi.hoisted(() => ({
  auth: vi.fn(), upgrade: vi.fn(),
  machineService: { resolveOrCreateForComputer: vi.fn(), resolveForTeamComputer: vi.fn() },
  machineUpdate: vi.fn(), machineFindUnique: vi.fn(), userFindUnique: vi.fn(),
  claim: vi.fn(), release: vi.fn(), publishUp: vi.fn(), publishPair: vi.fn(), terminalDown: vi.fn(),
  pushes: vi.fn(), appendKey: vi.fn(), nodeRole: vi.fn(),
}))
vi.mock('./ssoAuth.js', async original => ({ ...await original<typeof import('./ssoAuth.js')>(), authenticateAccessToken: m.auth }))
vi.mock('./wsServer.js', async original => ({ ...await original<typeof import('./wsServer.js')>(), createWss: () => ({ handleUpgrade: m.upgrade }) }))
vi.mock('../services/MachineService.js', () => ({ machineService: m.machineService }))
vi.mock('./prisma.js', () => ({
  prisma: { machine: { update: m.machineUpdate, findUnique: m.machineFindUnique }, user: { findUnique: m.userFindUnique } },
  machineAlive: { OR: [{ deletedAt: null }, { deletedAt: { isSet: false } }] },
}))
vi.mock('./bus.js', () => ({
  publishUp: m.publishUp, claimMachineOwner: m.claim, releaseMachineOwner: m.release, publishDeviceE2eePair: m.publishPair,
  publishTerminalUp: vi.fn(), subscribeTerminalDown: m.terminalDown, setMachineAppState: vi.fn(), clearMachineAppState: vi.fn(),
}))
vi.mock('./adapterAccountPushes.js', () => ({ relayAccountPushes: m.pushes }))
vi.mock('./deviceKeyLog.js', () => ({ appendDeviceKey: m.appendKey, touchDeviceKey: vi.fn() }))
vi.mock('./nodeRole.js', () => ({ attachNodeRole: m.nodeRole, PRESENCE_TTL_SEC: 30 }))
// The real hub starts its heartbeat timers on import; these tests never attach a hub client, so it is a stub with none.
vi.mock('./hub.js', () => ({
  CLIENTS_FRAME: '__clients', CLIENTS_DIRTY: '__clients_dirty', LIVENESS_TICK_MS: 5_000, CLIENT_IDLE_DEADLINE_MS: 75_000,
  DEVICE_IDLE_DEADLINE_MS: 35_000, CLIENT_HEARTBEAT_MS: 25_000, deliverTerminalUpLocal: vi.fn(), deliverUpLocal: vi.fn(),
  pushDeviceRevoked: vi.fn(), sendClientsControl: vi.fn(), recomputeAndSendClients: vi.fn(), attachHubClient: vi.fn(),
  trackSocketLiveness: () => () => {},
}))
vi.mock('./dailyTracking.js', async original => ({ ...await original<typeof import('./dailyTracking.js')>(),
  touchMachineOnlineDay: vi.fn(async () => {}), touchUserOnlineDay: vi.fn(async () => {}), touchClientOnlineDay: vi.fn(async () => {}),
  recordTurnStarted: vi.fn(async () => {}) }))

import { handleAdapterUpgrade } from './adapterWs.js'
import { handleWebUpgrade } from './webWs.js'
import { handleDeviceUpgrade } from './deviceWs.js'
import { SsoAuthError, type AuthUser } from './ssoAuth.js'
import { AppError } from '../errors/index.js'

const TEAM_COMPUTER = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const OWNER_COMPUTER = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const owner: AuthUser = { sub: 'owner', email: 'owner@example.com', role: 'user', autonomousEnv: 'prod' }
const team: AuthUser = { ...owner, harnessSessionId: 'team-session', harnessSessionKind: 'team', harnessComputerId: TEAM_COMPUTER }
const teamMac = { machineId: 'team-mac', userId: 'owner', name: 'MacBook Pro · Team', billingStatus: 'not_required', sessionKind: 'team' }
const ownerMac = { machineId: 'owner-mac', userId: 'owner', name: 'MacBook Pro', billingStatus: 'not_required', sessionKind: null }
const flush = async () => { for (let i = 0; i < 400; i++) await Promise.resolve() }

class Socket extends EventEmitter {
  readyState = 1; bufferedAmount = 0
  send = vi.fn()
  close = vi.fn((_code?: number, _reason?: string) => { this.readyState = 3; this.emit('close') })
  terminate = vi.fn(() => this.close())
  frame(body: unknown) { this.emit('message', Buffer.from(JSON.stringify(body)), false) }
  sent() { return this.send.mock.calls.map(c => JSON.parse(c[0] as string)) }
}
const raw = () => ({ write: vi.fn(), destroy: vi.fn(), destroyed: false, on: vi.fn(), once: vi.fn() })
const adapter = (computer: string) => ({ url: `/api/adapter-ws?computer=${computer}&label=Team&autonomousEnv=prod`,
  headers: { 'sec-websocket-protocol': 'access-token' } })
const status = (socket: ReturnType<typeof raw>) => String(socket.write.mock.calls.at(-1)?.[0] ?? '').split('\r\n')[0]

beforeEach(() => {
  vi.clearAllMocks()
  m.claim.mockResolvedValue(true)
  m.machineUpdate.mockResolvedValue({})
  m.userFindUnique.mockResolvedValue({ gridName: 'grid-of-the-account' })
  m.pushes.mockResolvedValue(() => {})
  m.terminalDown.mockResolvedValue(() => {})
  m.publishUp.mockResolvedValue(undefined)
  m.appendKey.mockResolvedValue({ ok: true, head: { seq: 1, hash: 'h' } })
  m.nodeRole.mockResolvedValue({ touch: vi.fn(), detach: vi.fn(async () => {}) })
  m.machineService.resolveForTeamComputer.mockResolvedValue({ machine: teamMac, created: false })
  m.upgrade.mockReset()
  m.machineService.resolveOrCreateForComputer.mockResolvedValue({ machine: ownerMac, created: false })
})

describe('the machine socket and a team session', () => {
  it('asks for a team session explicitly, as a machine', async () => {
    m.auth.mockResolvedValue(team)
    handleAdapterUpgrade(adapter(TEAM_COMPUTER) as never, raw() as never, Buffer.alloc(0)); await flush()
    expect(m.auth).toHaveBeenCalledWith('access-token', 'prod', { allowHarnessSession: 'computer', allowTeamSession: true })
  })

  it('refuses it as any computer but its own, before looking up a machine', async () => {
    m.auth.mockResolvedValue(team)
    const socket = raw()
    handleAdapterUpgrade(adapter(OWNER_COMPUTER) as never, socket as never, Buffer.alloc(0)); await flush()
    expect(status(socket)).toBe('HTTP/1.1 403 Forbidden')
    expect(socket.destroy).toHaveBeenCalled()
    expect(m.machineService.resolveForTeamComputer).not.toHaveBeenCalled()
    expect(m.machineService.resolveOrCreateForComputer).not.toHaveBeenCalled()
    expect(m.claim).not.toHaveBeenCalled()
    expect(m.upgrade).not.toHaveBeenCalled()
  })

  it('connects it as its own computer\'s team machine', async () => {
    m.auth.mockResolvedValue(team)
    handleAdapterUpgrade(adapter(TEAM_COMPUTER.toUpperCase()) as never, raw() as never, Buffer.alloc(0)); await flush()
    expect(m.machineService.resolveForTeamComputer).toHaveBeenCalledWith(team, TEAM_COMPUTER, 'Team', undefined)
    expect(m.machineService.resolveOrCreateForComputer).not.toHaveBeenCalled()
    expect(m.claim).toHaveBeenCalledWith('team-mac', TEAM_COMPUTER, 30)
    expect(m.upgrade).toHaveBeenCalledTimes(1)
  })

  it('refuses it when its computer\'s machine is one a normal sign-in holds', async () => {
    m.auth.mockResolvedValue(team)
    m.machineService.resolveForTeamComputer.mockRejectedValue(new AppError('held', 403, 'TEAM_SESSION_LIMITED'))
    const socket = raw()
    handleAdapterUpgrade(adapter(TEAM_COMPUTER) as never, socket as never, Buffer.alloc(0)); await flush()
    expect(status(socket)).toBe('HTTP/1.1 403 Forbidden')
    expect(m.upgrade).not.toHaveBeenCalled()
  })

  it('records a computer session on the machine row before it attaches, so a former team machine is not one any more', async () => {
    m.auth.mockResolvedValue(owner)
    m.machineService.resolveOrCreateForComputer.mockResolvedValue({ machine: { ...ownerMac, sessionKind: 'team' }, created: false })
    handleAdapterUpgrade(adapter(OWNER_COMPUTER) as never, raw() as never, Buffer.alloc(0)); await flush()
    expect(m.machineService.resolveOrCreateForComputer).toHaveBeenCalledWith('owner', 'prod', OWNER_COMPUTER, 'Team', undefined, 'computer')
    expect(m.machineUpdate).toHaveBeenCalledWith({ where: { machineId: 'owner-mac' }, data: { sessionKind: 'computer' } })
    expect(m.machineUpdate.mock.invocationCallOrder[0]).toBeLessThan(m.upgrade.mock.invocationCallOrder[0]!)
    // Already marked, or from before the kind was kept: no write before attaching (the connect's own update stamps it).
    for (const sessionKind of ['computer', null]) {
      m.machineUpdate.mockClear(); m.upgrade.mockClear()
      m.machineService.resolveOrCreateForComputer.mockResolvedValue({ machine: { ...ownerMac, sessionKind }, created: false })
      handleAdapterUpgrade(adapter(OWNER_COMPUTER) as never, raw() as never, Buffer.alloc(0)); await flush()
      expect(m.machineUpdate).not.toHaveBeenCalled()
      expect(m.upgrade).toHaveBeenCalled()
    }
  })

  describe('once attached', () => {
    let ws: Socket
    afterEach(() => ws?.close())
    const attach = async (user: AuthUser, computer: string) => {
      ws = new Socket()
      m.auth.mockResolvedValue(user)
      m.upgrade.mockImplementation((_r, _s, _h, done) => done(ws))
      handleAdapterUpgrade(adapter(computer) as never, raw() as never, Buffer.alloc(0)); await flush()
    }

    it('a team machine hears only its device-key pushes, never the account\'s grid name', async () => {
      await attach(team, TEAM_COMPUTER)
      expect(m.pushes).toHaveBeenCalledWith('owner', expect.any(Function), expect.objectContaining({ team: true }))
      expect(m.machineUpdate).toHaveBeenCalledWith({ where: { machineId: 'team-mac' }, data: expect.objectContaining({ sessionKind: 'team' }) })
      const meta = ws.sent().find(f => f.frame?.type === 'machine_meta')
      expect(meta.frame.payload).toEqual({ name: 'MacBook Pro · Team', gridName: null })
    })

    it('a team machine appends to the key log as a team machine, and raises no pairing notice on the person\'s apps', async () => {
      await attach(team, TEAM_COMPUTER)
      ws.frame({ t: 'up', frame: { type: 'devlog_append', payload: { requestId: 'r1', entry: { op: 'add' } } } })
      await flush()
      expect(m.appendKey).toHaveBeenCalledWith('owner', { op: 'add' }, { kind: 'machine', machineId: 'team-mac', harnessSessionId: 'team-session', team: true })
      ws.frame({ t: 'up', userEligible: true, webEligible: false, frame: { type: 'device_e2ee_pair_pending', payload: { pairId: 'p1', label: 'Dial' } } })
      await flush()
      expect(m.publishPair).not.toHaveBeenCalled()
    })

    it('a socket under the old sign-in closes when its computer becomes a team machine; a team socket stays', async () => {
      m.machineService.resolveOrCreateForComputer.mockResolvedValue({ machine: { ...ownerMac, sessionKind: 'computer' }, created: false })
      await attach(owner, OWNER_COMPUTER)
      const deliver = m.nodeRole.mock.calls.at(-1)![0].deliver as (msg: unknown) => void
      deliver({ connId: '', frame: { type: '__team_converted' } })
      expect(ws.close).toHaveBeenCalledWith(4009, 'now a team machine')
      expect(ws.sent().some(f => f.frame?.type === '__team_converted')).toBe(false)
      await attach(team, TEAM_COMPUTER)
      const teamDeliver = m.nodeRole.mock.calls.at(-1)![0].deliver as (msg: unknown) => void
      teamDeliver({ connId: '', frame: { type: '__team_converted' } })
      expect(ws.close).not.toHaveBeenCalled()
      expect(ws.sent().some(f => f.frame?.type === '__team_converted')).toBe(false)
    })

    it('a computer keeps every account push, its grid name and its pairing notices', async () => {
      m.machineService.resolveOrCreateForComputer.mockResolvedValue({ machine: { ...ownerMac, sessionKind: 'computer' }, created: false })
      m.machineFindUnique.mockResolvedValue({ name: 'MacBook Pro' })
      await attach(owner, OWNER_COMPUTER)
      expect(m.pushes).toHaveBeenCalledWith('owner', expect.any(Function), expect.objectContaining({ team: false }))
      expect(m.machineUpdate).toHaveBeenCalledWith({ where: { machineId: 'owner-mac' }, data: expect.objectContaining({ sessionKind: 'computer' }) })
      expect(ws.sent().find(f => f.frame?.type === 'machine_meta').frame.payload.gridName).toBe('grid-of-the-account')
      ws.frame({ t: 'up', frame: { type: 'devlog_append', payload: { requestId: 'r1', entry: { op: 'add' } } } })
      ws.frame({ t: 'up', userEligible: true, webEligible: false, frame: { type: 'device_e2ee_pair_pending', payload: { pairId: 'p1', label: 'Dial' } } })
      await flush()
      expect(m.appendKey).toHaveBeenCalledWith('owner', { op: 'add' }, { kind: 'machine', machineId: 'owner-mac' })
      expect(m.publishPair).toHaveBeenCalledTimes(1)
    })
  })
})

describe('the sockets that never take a team session', () => {
  const teamRefusal = new SsoAuthError('This connection is not available to a team sign-in', 'TEAM_SESSION_LIMITED')

  it('the web relay (machine_select, attach) closes it as refused, not as an expired sign-in to retry', async () => {
    m.auth.mockRejectedValue(teamRefusal)
    const ws = new Socket()
    m.upgrade.mockImplementation((_r, _s, _h, done) => done(ws))
    handleWebUpgrade({ url: '/api/web-ws?autonomousEnv=prod', headers: { 'sec-websocket-protocol': 'hna_team' } } as never, raw() as never, Buffer.alloc(0))
    await flush()
    expect(m.auth).toHaveBeenCalledWith('hna_team', 'prod')
    expect(ws.close).toHaveBeenCalledWith(4403, 'team sign-in')
  })

  it('the device lane answers it 403', async () => {
    m.auth.mockRejectedValue(teamRefusal)
    const socket = raw()
    handleDeviceUpgrade({ url: `/api/device-ws?computer=${TEAM_COMPUTER}`, headers: { 'sec-websocket-protocol': 'hna_team' } } as never, socket as never, Buffer.alloc(0))
    await flush()
    expect(m.auth).toHaveBeenCalledWith('hna_team', 'prod', { allowHarnessSession: 'computer' })
    expect(status(socket)).toBe('HTTP/1.1 403 Forbidden')
  })
})
