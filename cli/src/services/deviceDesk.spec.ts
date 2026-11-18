import { afterEach, describe, expect, it, vi } from 'vitest'
import { deviceDeskFor, publishDeviceDesk, type DeskStep, type DeviceDesk } from './deviceDesk.js'

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })
const where = { dataDir: '/private/desk-owner', machineId: 'machine' }
const result = { machineId: 'machine', agentId: 'agent' }

describe('the desk shared by cohosted device components', () => {
  it('selects only its exact current owner and does not let an old revoke remove a replacement', async () => {
    expect(deviceDeskFor(where.dataDir, where.machineId)).toBeNull()
    let current = true, window = true
    const stepFocus = vi.fn<DeviceDesk['stepFocus']>(async () => result), scroll = vi.fn<DeviceDesk['scroll']>()
    const revoke = publishDeviceDesk({ ...where, current: () => current, hasWindow: () => window, desk: { stepFocus, scroll } })
    const peer = deviceDeskFor(where.dataDir, where.machineId)!
    try {
      expect(deviceDeskFor('/somewhere-else', where.machineId)).toBeNull()
      expect(deviceDeskFor(where.dataDir, 'other-machine')).toBeNull()
      expect(await peer.stepFocus('next', undefined, () => true)).toEqual(result)
      expect(peer.scroll('move', 2, 3, () => true)).toBe(true)
      expect(scroll.mock.calls[0][3]()).toBe(true)
      window = false
      expect(peer.scroll('move', 2, 3, () => true)).toBe(false)
      expect(scroll).toHaveBeenCalledOnce()
      expect(await peer.stepFocus('previous', 'agent', () => true)).toBe('no_app')
      expect(stepFocus.mock.calls[1][2]()).toBe(false)
      current = false
      expect(deviceDeskFor(where.dataDir, where.machineId)).toBeNull()
      expect(await peer.stepFocus('next', undefined, () => true)).toBe('no_agents')
      expect(peer.scroll('up', 0, 0, () => true)).toBe(false)
      const next = publishDeviceDesk({ ...where, current: () => true, hasWindow: () => true, desk: { stepFocus, scroll } })
      revoke()
      expect(deviceDeskFor(where.dataDir, where.machineId)).not.toBeNull()
      next()
    } finally { revoke() }
  })

  it('refuses a lost caller and discards an unconfirmed result without replay', async () => {
    let release!: (value: DeskStep) => void, current = true
    const stepFocus = vi.fn<DeviceDesk['stepFocus']>((_direction, _id, live) => new Promise<DeskStep>(resolve => {
      release = value => { expect(live()).toBe(false); resolve(value) }
    }))
    const revoke = publishDeviceDesk({ ...where, current: () => true, hasWindow: () => true, desk: { stepFocus, scroll: () => {} } })
    try {
      const peer = deviceDeskFor(where.dataDir, where.machineId)!
      expect(await peer.stepFocus('next', undefined, () => false)).toBe('no_agents')
      expect(peer.scroll('down', 0, 0, () => false)).toBe(false)
      const pending = peer.stepFocus('next', undefined, () => current)
      current = false; release(result)
      expect(await pending).toBe('no_agents')
      expect(stepFocus).toHaveBeenCalledOnce()
    } finally { revoke() }
  })

  it('keeps the existing named step and scroll faults and fixed failure logging', async () => {
    const log = vi.fn(), stepFocus = vi.fn(async () => result), scroll = vi.fn()
    const revoke = publishDeviceDesk({ ...where, current: () => true, hasWindow: () => true, desk: { stepFocus, scroll },
      faults: new Set(['devices.stepFocus', 'devices.scroll']), log })
    try {
      const peer = deviceDeskFor(where.dataDir, where.machineId)!
      expect(await peer.stepFocus('next', undefined, () => true)).toBe('no_agents')
      expect(peer.scroll('move', 2, 3, () => true)).toBe(true)
      expect(stepFocus).not.toHaveBeenCalled(); expect(scroll).not.toHaveBeenCalled()
      expect(log.mock.calls).toEqual([['[devices] DESK_FAILED'], ['[devices] DESK_FAILED']])
    } finally { revoke() }
  })

  it('reports real step and scroll failures through the default logger without exposing their messages or retrying', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const stepFocus = vi.fn(async () => { throw new Error('private step context') })
    const scroll = vi.fn(() => { throw new Error('private scroll context') })
    const revoke = publishDeviceDesk({ ...where, current: () => true, hasWindow: () => true, desk: { stepFocus, scroll } })
    try {
      const peer = deviceDeskFor(where.dataDir, where.machineId)!
      expect(await peer.stepFocus('next', undefined, () => true)).toBe('no_agents')
      // A one-way stroke retains its existing accepted result; failure is visible in the fixed log.
      expect(peer.scroll('move', 2, 3, () => true)).toBe(true)
      expect(stepFocus).toHaveBeenCalledOnce(); expect(scroll).toHaveBeenCalledOnce()
      expect(warn.mock.calls).toEqual([['[devices] DESK_FAILED'], ['[devices] DESK_FAILED']])
    } finally { revoke() }
  })

  it('bounds payload bytes before starting a retained step', async () => {
    const log = vi.fn(), stepFocus = vi.fn(async () => result)
    const revoke = publishDeviceDesk({ ...where, current: () => true, hasWindow: () => true, desk: { stepFocus, scroll: () => {} }, log })
    try {
      expect(await deviceDeskFor(where.dataDir, where.machineId)!.stepFocus('next', 'x'.repeat(16 * 1024 * 1024), () => true)).toBe('no_agents')
      expect(stepFocus).not.toHaveBeenCalled()
      expect(log).toHaveBeenCalledWith('[devices] DESK_BACKPRESSURE')
    } finally { revoke() }
  })

  it('retains timed-out step capacity across endpoint generations until the actual lists settle', async () => {
    vi.useFakeTimers()
    const held: Array<() => void> = [], current: Array<() => boolean> = [], log = vi.fn()
    let revoke = publishDeviceDesk({ ...where, current: () => true, hasWindow: () => true, log,
      desk: { stepFocus: (_direction, _id, live) => { current.push(live); return new Promise(resolve => held.push(() => resolve(result))) }, scroll: () => {} } })
    try {
      const peer = deviceDeskFor(where.dataDir, where.machineId)!
      const requests = Array.from({ length: 100 }, () => peer.stepFocus('next', 'agent', () => true))
      expect(await peer.stepFocus('next', 'agent', () => true)).toBe('no_agents')
      expect(held).toHaveLength(100)
      await vi.advanceTimersByTimeAsync(5_000)
      expect(await Promise.all(requests)).toEqual(Array(100).fill('no_agents'))
      expect(current.every(live => !live())).toBe(true)
      revoke()
      const fresh = vi.fn(async () => result)
      revoke = publishDeviceDesk({ ...where, current: () => true, hasWindow: () => true, log, desk: { stepFocus: fresh, scroll: () => {} } })
      expect(await deviceDeskFor(where.dataDir, where.machineId)!.stepFocus('next', 'agent', () => true)).toBe('no_agents')
      expect(fresh).not.toHaveBeenCalled()
      held.splice(0).forEach(release => release()); await vi.advanceTimersByTimeAsync(0)
      expect(await deviceDeskFor(where.dataDir, where.machineId)!.stepFocus('next', 'agent', () => true)).toEqual(result)
      await vi.advanceTimersByTimeAsync(0)
      expect(vi.getTimerCount()).toBe(0)
    } finally { held.forEach(release => release()); await vi.advanceTimersByTimeAsync(0); revoke() }
  })
})
