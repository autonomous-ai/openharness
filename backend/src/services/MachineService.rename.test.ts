/**
 * A rename in Machines reaches the Swarms the machine is in (Dee, #2308; review of #2717): the Swarms are told at once, so an
 * offline machine is not left with its old name there until it reports again.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const findUnique = vi.hoisted(() => vi.fn())
const update = vi.hoisted(() => vi.fn())
const machineRenamed = vi.hoisted(() => vi.fn())

vi.mock('../lib/prisma.js', () => ({
  machineAlive: { OR: [{ deletedAt: null }, { deletedAt: { isSet: false } }] },
  prisma: { machine: { findUnique, update } },
}))
vi.mock('../lib/bus.js', () => ({
  getAgentPresence: vi.fn(), readAgentPresence: vi.fn(), clearAgentPresence: vi.fn(), pub: {}, consumeNewIdQuota: vi.fn(),
  publishDown: vi.fn(async () => {}), publishDeviceMachineListChanged: vi.fn(async () => {}),
}))
vi.mock('../config/env.js', () => ({ env: {} }))
vi.mock('../lib/managers.js', () => ({ selectManagerId: vi.fn() }))
vi.mock('../lib/provision.js', () => ({ provisionViaManager: vi.fn() }))
vi.mock('../lib/machineLifecycle.js', () => ({ ensureMachineReady: vi.fn(), publishMachineLifecycle: vi.fn() }))
vi.mock('../lib/machineCredential.js', () => ({ encryptMachineCredential: vi.fn() }))
vi.mock('./MachineBillingService.js', () => ({ machineBillingService: {} }))
vi.mock('../superTabs/machineRenames.js', () => ({ machineRenamed }))
const warn = vi.hoisted(() => vi.fn())
vi.mock('../utils/logger.js', () => ({ logger: { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

const { machineService } = await import('./MachineService.js')

const MAC = 'a'.repeat(32)
const owner = { sub: 'owner-1', role: 'user', autonomousEnv: 'prod' } as const

beforeEach(() => {
  vi.clearAllMocks()
  findUnique.mockResolvedValue({ machineId: MAC, userId: owner.sub, managerId: '', autonomousEnv: 'prod', authMode: 'remote', deletedAt: null })
  update.mockResolvedValue({})
  machineRenamed.mockResolvedValue(undefined)
})

describe('rename', () => {
  it('tells the Swarms the machine is in, as its owner\'s', async () => {
    await machineService.rename(MAC, owner, 'Mac 3')
    expect(machineRenamed).toHaveBeenCalledWith({ machineId: MAC, ownerId: owner.sub, autonomousEnv: 'prod' })
  })

  it('still renames when the Swarms cannot be told, and says so in the log', async () => {
    machineRenamed.mockRejectedValue(new Error('swarm down'))
    await expect(machineService.rename(MAC, owner, 'Mac 3')).resolves.toBeUndefined()
    expect(update).toHaveBeenCalledWith({ where: { machineId: MAC }, data: { name: 'Mac 3' } })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Swarm'), expect.objectContaining({ machineId: MAC }))
  })
})
