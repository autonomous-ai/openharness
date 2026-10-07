import { beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({
  userPresenceUpsert: vi.fn(),
  machinePresenceUpsert: vi.fn(),
  agentPresenceUpsert: vi.fn(),
  devicePresenceUpsert: vi.fn(),
  clientPresenceUpsert: vi.fn(),
}))

vi.mock('./prisma.js', () => ({
  prisma: {
    userDailyPresence: { upsert: db.userPresenceUpsert },
    machineDailyPresence: { upsert: db.machinePresenceUpsert },
    agentDailyPresence: { upsert: db.agentPresenceUpsert },
    userDailyDevicePresence: { upsert: db.devicePresenceUpsert },
    userDailyClientPresence: { upsert: db.clientPresenceUpsert },
  },
}))

import { presenceTracker, presenceWriteDue, recordTurnStarted, touchClientOnlineDay, touchDeviceOnlineDay, touchMachineOnlineDay, touchUserOnlineDay } from './dailyTracking.js'
import { utcDayStart } from '../types/analytics.js'

describe('touchUserOnlineDay', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    db.userPresenceUpsert.mockResolvedValue({})
  })

  it('an app `open` upserts the (user, machine, UTC day) row and bumps connections', async () => {
    const now = new Date('2026-09-16T10:15:30.000Z')
    await touchUserOnlineDay('user-1', 'machine-a', now, { isNewConnection: true })

    expect(db.userPresenceUpsert).toHaveBeenCalledTimes(1)
    const call = db.userPresenceUpsert.mock.calls[0][0]
    expect(call.where).toEqual({
      userId_machineId_dayUtc: { userId: 'user-1', machineId: 'machine-a', dayUtc: utcDayStart(now) },
    })
    expect(call.create).toEqual({
      userId: 'user-1', machineId: 'machine-a', dayUtc: utcDayStart(now),
      connections: 1, firstSeenAt: now, lastSeenAt: now,
    })
    expect(call.update).toEqual({ lastSeenAt: now, connections: { increment: 1 } })
  })

  it('an app `ping` only touches lastSeenAt — a session spanning midnight opens no connection that day', async () => {
    const now = new Date('2026-09-16T00:00:20.000Z')
    await touchUserOnlineDay('user-1', 'machine-a', now, { isNewConnection: false })

    const call = db.userPresenceUpsert.mock.calls[0][0]
    expect(call.update).toEqual({ lastSeenAt: now })
    expect(call.create.connections).toBe(0)
  })
})

describe('touchClientOnlineDay', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    db.clientPresenceUpsert.mockResolvedValue({})
  })

  it('upserts the (user, surface, UTC day) row — no machine — and only an open counts a connection', async () => {
    const now = new Date('2026-10-07T08:00:00.000Z')
    await touchClientOnlineDay('user-1', 'mobile', now, { isNewConnection: true })
    await touchClientOnlineDay('user-1', 'mobile', now, { isNewConnection: false })

    const [open, ping] = db.clientPresenceUpsert.mock.calls.map((c) => c[0])
    expect(open.where).toEqual({ userId_surface_dayUtc: { userId: 'user-1', surface: 'mobile', dayUtc: utcDayStart(now) } })
    expect(open.create).toEqual({ userId: 'user-1', surface: 'mobile', dayUtc: utcDayStart(now), connections: 1, firstSeenAt: now, lastSeenAt: now })
    expect(open.update).toEqual({ lastSeenAt: now, connections: { increment: 1 } })
    expect(ping.update).toEqual({ lastSeenAt: now })
    expect(ping.create.connections).toBe(0)
  })
})

describe('presenceTracker', () => {
  const floors = { pingFloorMs: 5 * 60_000, openFloorMs: 10_000 }
  const flush = () => new Promise((r) => setTimeout(r, 0))

  it('writes an open at once, holds pings to the floor, and never two writes at a time', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-07T08:00:00.000Z'))
    const writes: boolean[] = []
    let release: () => void = () => {}
    const write = vi.fn((_now: Date, isNew: boolean) => {
      writes.push(isNew)
      return new Promise<void>((r) => { release = r })
    })
    const touch = presenceTracker(write, vi.fn(), floors)

    touch('open')
    touch('ping') // a write is in flight
    expect(writes).toEqual([true])
    release(); await flush()

    touch('ping') // within the floor
    expect(writes).toEqual([true])
    vi.setSystemTime(new Date('2026-10-07T08:05:00.000Z'))
    touch('ping')
    expect(writes).toEqual([true, false])
    release(); await flush()

    touch('open') // a reconnect storm is not a session per dial
    vi.setSystemTime(new Date('2026-10-07T08:05:05.000Z'))
    touch('open')
    expect(writes).toEqual([true, false, true])
    vi.useRealTimers()
  })

  it('hands a failed write to onError, and the next ping is still due', async () => {
    const onError = vi.fn()
    const write = vi.fn(async () => { throw new Error('mongo down') })
    const touch = presenceTracker(write, onError, floors)
    touch('ping')
    await flush()
    expect(onError).toHaveBeenCalledWith('ping', expect.any(Error))
    touch('ping')
    expect(write).toHaveBeenCalledTimes(2)
  })
})

describe('touchDeviceOnlineDay', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    db.devicePresenceUpsert.mockResolvedValue({})
  })

  it('a connect upserts the (user, device, UTC day) row, bumps connections and stamps the country', async () => {
    const now = new Date('2026-09-23T10:15:30.000Z')
    await touchDeviceOnlineDay('user-1', 'device-a', now, { isNewConnection: true, countryCode: 'VN' })

    const call = db.devicePresenceUpsert.mock.calls[0][0]
    expect(call.where).toEqual({
      userId_deviceId_dayUtc: { userId: 'user-1', deviceId: 'device-a', dayUtc: utcDayStart(now) },
    })
    expect(call.create).toEqual({
      userId: 'user-1', deviceId: 'device-a', dayUtc: utcDayStart(now),
      connections: 1, firstSeenAt: now, lastSeenAt: now, countryCode: 'VN',
    })
    expect(call.update).toEqual({ lastSeenAt: now, connections: { increment: 1 }, countryCode: 'VN' })
  })

  it('a refresh on an open socket only moves lastSeenAt — and a row it creates after midnight counts no connection', async () => {
    const now = new Date('2026-09-23T00:05:00.000Z')
    await touchDeviceOnlineDay('user-1', 'device-a', now, { isNewConnection: false })

    const call = db.devicePresenceUpsert.mock.calls[0][0]
    expect(call.update).toEqual({ lastSeenAt: now })
    expect(call.create.connections).toBe(0)
    expect(call.create.countryCode).toBeUndefined()
  })
})

describe('touchMachineOnlineDay', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    db.machinePresenceUpsert.mockResolvedValue({})
  })

  it('upserts the (machine, UTC day) row and bumps connections on a new connection', async () => {
    const now = new Date('2026-09-16T10:15:30.000Z')
    await touchMachineOnlineDay('user-1', 'machine-a', now, { isNewConnection: true })

    expect(db.machinePresenceUpsert).toHaveBeenCalledTimes(1)
    const call = db.machinePresenceUpsert.mock.calls[0][0]
    expect(call.where).toEqual({ machineId_dayUtc: { machineId: 'machine-a', dayUtc: utcDayStart(now) } })
    expect(call.create).toEqual({
      machineId: 'machine-a', userId: 'user-1', dayUtc: utcDayStart(now),
      connections: 1, firstSeenAt: now, lastSeenAt: now,
    })
    expect(call.update).toEqual({ lastSeenAt: now, connections: { increment: 1 } })
  })

  it('only touches lastSeenAt on a heartbeat/close (no connections increment)', async () => {
    const now = new Date('2026-09-16T23:59:59.000Z')
    await touchMachineOnlineDay('user-1', 'machine-a', now, { isNewConnection: false })

    const call = db.machinePresenceUpsert.mock.calls[0][0]
    expect(call.update).toEqual({ lastSeenAt: now })
    // First write of a new UTC day from a session that spans midnight: the row exists, but no
    // connection was opened on that day.
    expect(call.create.connections).toBe(0)
  })

  it('carries the Cloudflare country into both create and update (last write of the day wins)', async () => {
    const now = new Date('2026-09-16T10:15:30.000Z')
    await touchMachineOnlineDay('user-1', 'machine-a', now, { isNewConnection: false, countryCode: 'VN' })

    const call = db.machinePresenceUpsert.mock.calls[0][0]
    expect(call.create.countryCode).toBe('VN')
    expect(call.update).toEqual({ lastSeenAt: now, countryCode: 'VN' })
  })

  it('never clears a country: a touch without one leaves the column out of the write', async () => {
    const now = new Date('2026-09-16T10:15:30.000Z')
    await touchMachineOnlineDay('user-1', 'machine-a', now, { isNewConnection: true })

    const call = db.machinePresenceUpsert.mock.calls[0][0]
    expect(call.create).not.toHaveProperty('countryCode')
    expect(call.update).not.toHaveProperty('countryCode')
  })

  it('propagates a DB failure so the caller can log it and keep its guard unchanged', async () => {
    db.machinePresenceUpsert.mockRejectedValueOnce(new Error('mongo down'))
    await expect(
      touchMachineOnlineDay('user-1', 'machine-a', new Date(), { isNewConnection: true }),
    ).rejects.toThrow('mongo down')
  })
})

describe('recordTurnStarted', () => {
  const now = new Date('2026-09-16T10:15:30.000Z')

  beforeEach(() => {
    vi.clearAllMocks()
    db.machinePresenceUpsert.mockResolvedValue({})
    db.agentPresenceUpsert.mockResolvedValue({})
  })

  it('bumps turnsStarted on the machine row without counting a connection', async () => {
    await recordTurnStarted('user-1', 'machine-a', 'agent-x', now)

    expect(db.machinePresenceUpsert).toHaveBeenCalledTimes(1)
    const call = db.machinePresenceUpsert.mock.calls[0][0]
    expect(call.where).toEqual({ machineId_dayUtc: { machineId: 'machine-a', dayUtc: utcDayStart(now) } })
    expect(call.create).toEqual({
      machineId: 'machine-a', userId: 'user-1', dayUtc: utcDayStart(now),
      connections: 0, turnsStarted: 1, firstSeenAt: now, lastSeenAt: now,
    })
    expect(call.update).toEqual({ lastSeenAt: now, turnsStarted: { increment: 1 } })
  })

  it('bumps the (machine, agent, day) row', async () => {
    await recordTurnStarted('user-1', 'machine-a', 'agent-x', now)

    expect(db.agentPresenceUpsert).toHaveBeenCalledTimes(1)
    const call = db.agentPresenceUpsert.mock.calls[0][0]
    expect(call.where).toEqual({
      machineId_agentId_dayUtc: { machineId: 'machine-a', agentId: 'agent-x', dayUtc: utcDayStart(now) },
    })
    expect(call.create).toEqual({
      machineId: 'machine-a', agentId: 'agent-x', userId: 'user-1', dayUtc: utcDayStart(now),
      turnsStarted: 1, firstSeenAt: now, lastSeenAt: now,
    })
    expect(call.update).toEqual({ lastSeenAt: now, turnsStarted: { increment: 1 } })
  })

  it('propagates a failure from either upsert', async () => {
    db.agentPresenceUpsert.mockRejectedValueOnce(new Error('agent row failed'))
    await expect(recordTurnStarted('user-1', 'machine-a', 'agent-x', now)).rejects.toThrow('agent row failed')
    // The machine write was still attempted — the two are independent.
    expect(db.machinePresenceUpsert).toHaveBeenCalledTimes(1)
  })
})

describe('presenceWriteDue', () => {
  const FIVE_MIN = 5 * 60_000
  const t0 = new Date('2026-09-16T10:00:00.000Z')

  it('is due before anything has been written', () => {
    expect(presenceWriteDue({ dayKey: null, wroteAt: 0 }, t0, FIVE_MIN)).toBe(true)
  })

  it('is not due within the interval on the same UTC day', () => {
    const last = { dayKey: '2026-09-16', wroteAt: t0.getTime() }
    expect(presenceWriteDue(last, new Date(t0.getTime() + 15_000), FIVE_MIN)).toBe(false)
    expect(presenceWriteDue(last, new Date(t0.getTime() + FIVE_MIN - 1), FIVE_MIN)).toBe(false)
  })

  it('is due once the interval has elapsed', () => {
    const last = { dayKey: '2026-09-16', wroteAt: t0.getTime() }
    expect(presenceWriteDue(last, new Date(t0.getTime() + FIVE_MIN), FIVE_MIN)).toBe(true)
  })

  it('is due when the UTC day rolled over, even inside the interval', () => {
    const lateNight = new Date('2026-09-16T23:59:50.000Z')
    const last = { dayKey: '2026-09-16', wroteAt: lateNight.getTime() }
    expect(presenceWriteDue(last, new Date('2026-09-17T00:00:05.000Z'), FIVE_MIN)).toBe(true)
  })
})
