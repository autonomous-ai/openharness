import { beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({ revoke: vi.fn(), pushDeviceRevoked: vi.fn(), publishDeviceControl: vi.fn(), publishDeviceStatus: vi.fn() }))
vi.mock('../services/index.js', () => ({ deviceService: { revoke: m.revoke } }))
vi.mock('./hub.js', () => ({ pushDeviceRevoked: m.pushDeviceRevoked }))
vi.mock('./bus.js', () => ({ publishDeviceControl: m.publishDeviceControl, publishDeviceStatus: m.publishDeviceStatus }))
vi.mock('../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

import { revokeDeviceForUser } from './deviceRevoke.js'

beforeEach(() => {
  vi.clearAllMocks()
  m.publishDeviceControl.mockResolvedValue(1)
  m.publishDeviceStatus.mockResolvedValue(1)
})

describe('revoking a device', () => {
  // The owner's open web sockets keep their own copy of the account's devices (lib/webWs.ts): this is what drops it.
  it('tells the owner\'s web sockets the device is gone', async () => {
    m.revoke.mockResolvedValue({ deviceId: 'dial', machineIds: ['mac'] })
    await expect(revokeDeviceForUser('dial', 'owner')).resolves.toBe(true)
    expect(m.publishDeviceStatus).toHaveBeenCalledWith('owner', { deviceId: 'dial', online: false, removed: true })
  })

  it('tells nobody about a device that is not the caller\'s', async () => {
    m.revoke.mockResolvedValue(null)
    await expect(revokeDeviceForUser('dial', 'someone-else')).resolves.toBe(false)
    expect(m.publishDeviceStatus).not.toHaveBeenCalled()
    expect(m.publishDeviceControl).not.toHaveBeenCalled()
  })
})
