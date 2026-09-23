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

vi.mock('../lib/prisma.js', () => ({
  machineAlive: {},
  prisma: {
    machine: { findMany, count, create, findUnique: vi.fn() },
    subscriptionPlan: { findFirst: planFindFirst },
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
