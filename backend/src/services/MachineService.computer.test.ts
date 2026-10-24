/**
 * `resolveOrCreateForComputer` — the free path that mints a Remote machine for a self-declared computer id.
 *
 * What is pinned here is the abuse bound: a reconnect is free, only a CREATE spends the account's new-id
 * quota, and the create lock is per ACCOUNT so N parallel fresh ids cannot all pass the same ceiling count.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const findMany = vi.hoisted(() => vi.fn())
const count = vi.hoisted(() => vi.fn())
const create = vi.hoisted(() => vi.fn())
const planFindFirst = vi.hoisted(() => vi.fn())
const redisSet = vi.hoisted(() => vi.fn())
const consumeNewIdQuota = vi.hoisted(() => vi.fn())
const findUnique = vi.hoisted(() => vi.fn())
const update = vi.hoisted(() => vi.fn())
const sessionUpdateMany = vi.hoisted(() => vi.fn())
const sessionFindUnique = vi.hoisted(() => vi.fn())

vi.mock('../lib/prisma.js', () => ({
  machineAlive: {},
  prisma: {
    machine: { findMany, count, create, findUnique, update },
    subscriptionPlan: { findFirst: planFindFirst },
    harnessSession: { updateMany: sessionUpdateMany, findUnique: sessionFindUnique },
  },
}))
vi.mock('../lib/bus.js', () => ({
  getAgentPresence: vi.fn(),
  clearAgentPresence: vi.fn(),
  publishDown: vi.fn(),
  publishDeviceMachineListChanged: vi.fn(async () => {}),
  consumeNewIdQuota,
  pub: { set: redisSet, eval: vi.fn(async () => 1) },
}))
vi.mock('../config/env.js', () => ({ env: { HARNESS_DEVICE_AUTH_MACHINE_LIMIT: 20 } }))
vi.mock('../lib/managers.js', () => ({ selectManagerId: vi.fn() }))
vi.mock('../lib/provision.js', () => ({ provisionViaManager: vi.fn() }))
vi.mock('../lib/machineLifecycle.js', () => ({ ensureMachineReady: vi.fn(), publishMachineLifecycle: vi.fn() }))
vi.mock('../lib/machineCredential.js', () => ({ encryptMachineCredential: vi.fn() }))
vi.mock('./MachineBillingService.js', () => ({ machineBillingService: {} }))

const { machineService } = await import('./MachineService.js')

const COMPUTER = 'a'.repeat(32)
const resolve = () => machineService.resolveOrCreateForComputer('u1', 'prod', COMPUTER, 'laptop')

beforeEach(() => {
  vi.clearAllMocks()
  findMany.mockResolvedValue([])
  count.mockResolvedValue(0)
  planFindFirst.mockResolvedValue(null)
  redisSet.mockResolvedValue('OK')
  consumeNewIdQuota.mockResolvedValue(true)
  create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ ...data }))
  sessionFindUnique.mockResolvedValue({ hostMachineId: null })
  update.mockImplementation(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => ({ ...where, ...data }))
})

describe('resolveOrCreateForComputer', () => {
  it('reuses the computer\'s machine without a lock or a quota spend', async () => {
    findMany.mockResolvedValue([{ machineId: 'm1', billingStatus: 'not_required' }])
    const out = await resolve()
    expect(out).toMatchObject({ created: false, machine: { machineId: 'm1' } })
    expect(redisSet).not.toHaveBeenCalled()
    expect(consumeNewIdQuota).not.toHaveBeenCalled()
  })

  it('creates under a lock keyed by the ACCOUNT, spending one machine new-id', async () => {
    const out = await resolve()
    expect(out.created).toBe(true)
    expect(redisSet.mock.calls[0]?.[0]).toBe('machine:create:u1')
    expect(consumeNewIdQuota).toHaveBeenCalledWith('machine', 'u1')
  })

  it('refuses a create over the new-id rate with 429 and writes nothing', async () => {
    consumeNewIdQuota.mockResolvedValue(false)
    await expect(resolve()).rejects.toMatchObject({ statusCode: 429, code: 'NEW_MACHINE_RATE_LIMITED' })
    expect(create).not.toHaveBeenCalled()
  })

  it('hits the live-row ceiling first, without spending quota', async () => {
    count.mockResolvedValue(20)
    await expect(resolve()).rejects.toMatchObject({ statusCode: 409, code: 'TOO_MANY_MACHINES' })
    expect(consumeNewIdQuota).not.toHaveBeenCalled()
  })
})

// A Mac's team account (lib/teamSession.ts): its daemon becomes its own computer's machine, marked `team`, and never
// one of the person's machines.
describe('resolveForTeamComputer', () => {
  const TEAM = 'b'.repeat(32)
  const team = { sub: 'u1', email: 'u1@example.com', role: 'user', autonomousEnv: 'prod' as const,
    harnessSessionId: 'team-session', harnessSessionKind: 'team' as const, harnessComputerId: TEAM }

  it('creates its computer\'s machine as a team machine', async () => {
    const out = await machineService.resolveForTeamComputer(team, TEAM, 'MacBook Pro · Team')
    expect(out.created).toBe(true)
    expect(create).toHaveBeenCalledWith({ data: expect.objectContaining({ userId: 'u1', computerId: TEAM, sessionKind: 'team' }) })
  })

  it('reuses its team machine', async () => {
    findMany.mockResolvedValue([{ machineId: 'm1', billingStatus: 'not_required', sessionKind: 'team' }])
    expect(await machineService.resolveForTeamComputer(team, TEAM, 'x')).toMatchObject({ created: false, machine: { machineId: 'm1' } })
  })

  it('refuses any other computer, and any session that is not a team one, before looking anything up', async () => {
    await expect(machineService.resolveForTeamComputer(team, COMPUTER, 'x')).rejects.toMatchObject({ statusCode: 403, code: 'TEAM_SESSION_LIMITED' })
    const { harnessSessionKind: _kind, ...computer } = team
    await expect(machineService.resolveForTeamComputer(computer, TEAM, 'x')).rejects.toMatchObject({ statusCode: 403 })
    expect(findMany).not.toHaveBeenCalled()
  })

  // One machine: the team machine records the Mac its session was minted for, from the session and nothing it sends.
  it('records its session\'s Mac on a machine it creates', async () => {
    sessionFindUnique.mockResolvedValue({ hostMachineId: 'laptop' })
    await machineService.resolveForTeamComputer(team, TEAM, 'MacBook Pro · Team')
    expect(sessionFindUnique).toHaveBeenCalledWith({ where: { id: 'team-session' }, select: { hostMachineId: true } })
    expect(create).toHaveBeenCalledWith({ data: expect.objectContaining({ sessionKind: 'team', hostMachineId: 'laptop' }) })
  })

  it('records its session\'s Mac on the machine it reuses when that differs, and leaves one it already names', async () => {
    sessionFindUnique.mockResolvedValue({ hostMachineId: 'laptop' })
    findMany.mockResolvedValue([{ machineId: 'm1', billingStatus: 'not_required', sessionKind: 'team', hostMachineId: null }])
    expect(await machineService.resolveForTeamComputer(team, TEAM, 'x')).toMatchObject({ machine: { machineId: 'm1', hostMachineId: 'laptop' } })
    expect(update).toHaveBeenCalledWith({ where: { machineId: 'm1' }, data: { hostMachineId: 'laptop' } })
    update.mockClear()
    findMany.mockResolvedValue([{ machineId: 'm1', billingStatus: 'not_required', sessionKind: 'team', hostMachineId: 'laptop' }])
    await machineService.resolveForTeamComputer(team, TEAM, 'x')
    expect(update).not.toHaveBeenCalled()
  })

  it('a session that names no Mac (a dedicated machine) records none and clears nothing', async () => {
    findMany.mockResolvedValue([{ machineId: 'm1', billingStatus: 'not_required', sessionKind: 'team', hostMachineId: 'laptop' }])
    await machineService.resolveForTeamComputer(team, TEAM, 'x')
    expect(update).not.toHaveBeenCalled()
    findMany.mockResolvedValue([])
    await machineService.resolveForTeamComputer(team, TEAM, 'x')
    expect(create.mock.calls.at(-1)![0].data).not.toHaveProperty('hostMachineId')
  })

  it('refuses a computer the account runs under a normal sign-in, rows from before the kind was kept included', async () => {
    for (const sessionKind of ['computer', null, undefined]) {
      findMany.mockResolvedValue([{ machineId: 'm1', billingStatus: 'not_required', sessionKind }])
      await expect(machineService.resolveForTeamComputer(team, TEAM, 'x')).rejects.toMatchObject({ statusCode: 403, code: 'TEAM_SESSION_LIMITED' })
    }
    expect(create).not.toHaveBeenCalled()
  })
})

describe('destroying a team machine', () => {
  beforeEach(async () => {
    const bus = await import('../lib/bus.js')
    vi.mocked(bus.publishDown).mockResolvedValue(1 as never)
    vi.mocked(bus.clearAgentPresence).mockResolvedValue(undefined as never)
  })

  it('signs its team account out with it, so it cannot come back as a new machine', async () => {
    findUnique.mockResolvedValue({ machineId: 'm1', userId: 'u1', managerId: '', authMode: 'remote', billingStatus: 'not_required',
      autonomousEnv: 'prod', computerId: 'b'.repeat(32), sessionKind: 'team' })
    update.mockResolvedValue({})
    sessionUpdateMany.mockResolvedValue({ count: 1 })
    await machineService.destroy('a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4', { sub: 'u1', role: 'user', autonomousEnv: 'prod' })
    expect(sessionUpdateMany).toHaveBeenCalledWith({
      where: { userId: 'u1', kind: 'team', computerId: 'b'.repeat(32), OR: [{ revokedAt: null }, { revokedAt: { isSet: false } }] },
      data: { revokedAt: expect.any(Date) },
    })
  })

  it('signs its computer\'s team account out even when a normal sign-in served the row last', async () => {
    findUnique.mockResolvedValue({ machineId: 'm1', userId: 'u1', managerId: '', authMode: 'remote', billingStatus: 'not_required',
      autonomousEnv: 'prod', computerId: 'a'.repeat(32), sessionKind: 'computer' })
    update.mockResolvedValue({})
    sessionUpdateMany.mockResolvedValue({ count: 0 })
    await machineService.destroy('a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4', { sub: 'u1', role: 'user', autonomousEnv: 'prod' })
    // Only team sessions bound to that computer: a computer's or a phone's own sign-in is not touched.
    expect(sessionUpdateMany).toHaveBeenCalledWith({
      where: { userId: 'u1', kind: 'team', computerId: 'a'.repeat(32), OR: [{ revokedAt: null }, { revokedAt: { isSet: false } }] },
      data: { revokedAt: expect.any(Date) },
    })
  })

  it('touches no session for a machine with no computer', async () => {
    findUnique.mockResolvedValue({ machineId: 'm1', userId: 'u1', managerId: '', authMode: 'remote', billingStatus: 'not_required', autonomousEnv: 'prod' })
    update.mockResolvedValue({})
    await machineService.destroy('a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4', { sub: 'u1', role: 'user', autonomousEnv: 'prod' })
    expect(sessionUpdateMany).not.toHaveBeenCalled()
  })
})
