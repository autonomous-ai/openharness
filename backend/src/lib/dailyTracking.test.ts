import { beforeEach, describe, expect, it, vi } from 'vitest'
const record = vi.hoisted(() => vi.fn())
const mark = vi.hoisted(() => vi.fn())
vi.mock('./productUsage.js', () => ({ recordRelayUsage: record, markActivity: mark }))
import { CLIENT_SURFACES, TUI_SURFACES, mobileOpenMetrics, presenceTracker, presenceWriteDue, recordRemoteUsage, recordTurnStarted, touchClientOnlineDay, touchDeviceOnlineDay, touchMachineOnlineDay, touchUserOnlineDay } from './dailyTracking.js'

beforeEach(() => { record.mockReset(); record.mockResolvedValue(undefined); mark.mockReset(); mark.mockResolvedValue(undefined) })
it('forwards only the choice identity and a fixed metric, never device, agent or location', async () => {
  const now = new Date('2026-10-13T12:00:00Z')
  await touchUserOnlineDay('account', 'PRIVATE_MACHINE', now, { isNewConnection: true })
  await touchClientOnlineDay('account', 'mobile', now, { isNewConnection: true })
  await touchDeviceOnlineDay('account', 'PRIVATE_DEVICE', now, { isNewConnection: true, countryCode: 'VN' })
  await touchMachineOnlineDay('account', 'PRIVATE_MACHINE', now, { isNewConnection: true, countryCode: 'VN' })
  await recordRemoteUsage('account', 'PRIVATE_MACHINE', now)
  await recordTurnStarted('account', 'PRIVATE_MACHINE', 'PRIVATE_AGENT', now)
  expect(record.mock.calls.map(c => c[2])).toEqual(['relay_desktop_opens', 'relay_mobile_opens', 'relay_device_connections', 'relay_machine_connections', 'relay_remote_sessions', 'relay_turns_started'])
  expect(JSON.stringify(record.mock.calls)).not.toContain('PRIVATE_')
  expect(JSON.stringify(record.mock.calls)).not.toContain('VN')
})
describe('a phone open, by release and apart for a debug or simulator build', () => {
  const now = new Date('2026-10-20T12:00:00Z')
  const open = (build?: Parameters<typeof touchClientOnlineDay>[3]['build']) =>
    touchClientOnlineDay('account', 'mobile', now, { isNewConnection: true, ...(build ? { build } : {}) })

  it('counts under its release, beside the unchanged total', async () => {
    await open({ release: '1.0.8' })
    expect(record.mock.calls).toEqual([['account', now, 'relay_mobile_opens', ['breakdown:release:phone:1.0.8:relay_mobile_opens']]])
  })

  it('counts a debug or simulator build apart, and not under a release', async () => {
    await open({ release: '1.0.8', debug: true })
    expect(record.mock.calls).toEqual([['account', now, 'relay_mobile_opens', ['relay_mobile_debug_opens']]])
    expect(JSON.stringify(record.mock.calls)).not.toContain('1.0.8')
  })

  it('counts an app that sends neither as an unknown release, not a debug build', async () => {
    await open()
    await open({})
    await open({ release: null, debug: false })
    expect(record.mock.calls.map(c => [c[2], c[3]])).toEqual(
      Array(3).fill(['relay_mobile_opens', ['breakdown:release:phone:unknown:relay_mobile_opens']]))
  })

  it.each(['', '1.0', '1.0.8+72', '1.0.8-dev', 'latest', '1.0.8.1', '01.0.8', '1000.0.0', ' 1.0.8', 'PRIVATE_BUILD'])(
    'does not turn %j into a label', async release => {
      await open({ release })
      expect(record.mock.calls[0]![3]).toEqual(['breakdown:release:phone:unknown:relay_mobile_opens'])
    })

  it('adds a margin only to the phone, and only for an open', async () => {
    for (const surface of ['tui', 'web', 'harness-os'] as const) {
      await touchClientOnlineDay('account', surface, now, { isNewConnection: true, build: { release: '1.0.8', debug: true } })
    }
    expect(record.mock.calls.map(c => [c[2], c[3]])).toEqual([['relay_tui_opens', undefined], ['relay_web_opens', undefined], ['relay_harness-os_opens', undefined]])
    record.mockClear()
    await touchClientOnlineDay('account', 'mobile', now, { isNewConnection: false, build: { release: '1.0.8' } })
    expect(record).not.toHaveBeenCalled()
  })

  it('names only fixed metrics and a public release', () => {
    expect(mobileOpenMetrics({ release: '1.0.9' })).toEqual(['breakdown:release:phone:1.0.9:relay_mobile_opens'])
    expect(mobileOpenMetrics({ debug: true })).toEqual(['relay_mobile_debug_opens'])
    expect(mobileOpenMetrics()).toEqual(['breakdown:release:phone:unknown:relay_mobile_opens'])
  })
})
it('idle heartbeats add no relay totals but keep the person active', async () => {
  const now = new Date()
  await touchUserOnlineDay('a', 'm', now, { isNewConnection: false })
  await touchClientOnlineDay('a', 'tui', now, { isNewConnection: false })
  await touchDeviceOnlineDay('a', 'd', now, { isNewConnection: false })
  await touchMachineOnlineDay('a', 'm', now, { isNewConnection: false })
  expect(record).not.toHaveBeenCalled()
  expect(mark.mock.calls).toEqual([['a', now, { surface: 'desktop' }], ['a', now, { surface: 'tui' }]])
})

it('marks the person, not the machine, agent or device', async () => {
  const now = new Date('2026-10-13T12:00:00Z')
  await touchUserOnlineDay('account', 'PRIVATE_MACHINE', now, { isNewConnection: true })
  await touchClientOnlineDay('account', 'mobile', now, { isNewConnection: true })
  await touchDeviceOnlineDay('account', 'PRIVATE_DEVICE', now, { isNewConnection: true, countryCode: 'VN' })
  await recordTurnStarted('account', 'PRIVATE_MACHINE', 'PRIVATE_AGENT', now)
  expect(mark.mock.calls).toEqual([
    ['account', now, { surface: 'desktop' }], ['account', now, { surface: 'mobile' }], ['account', now, { worked: true }],
  ])
  expect(JSON.stringify(mark.mock.calls)).not.toContain('PRIVATE_')
})

it('a failing mark never reaches the socket', async () => {
  mark.mockRejectedValue(new Error('PRIVATE'))
  await expect(touchUserOnlineDay('a', 'm', new Date(), { isNewConnection: true })).resolves.toBeUndefined()
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

it('keeps Harness OS and Orange Pi connections separate without storing identity', async () => {
  expect([...TUI_SURFACES]).toEqual(['tui', 'harness-os', 'harness-os-pi'])
  for (const surface of TUI_SURFACES) expect(CLIENT_SURFACES.has(surface)).toBe(true)
  for (const other of ['desktop', 'mobile', 'web', 'orangepi', '']) expect(TUI_SURFACES.has(other)).toBe(false)
  const now = new Date('2026-10-13T08:00:00.000Z')
  await touchClientOnlineDay('account', 'harness-os', now, { isNewConnection: true })
  await touchClientOnlineDay('account', 'harness-os-pi', now, { isNewConnection: true })
  expect(record.mock.calls).toEqual([
    ['account', now, 'relay_harness-os_opens'], ['account', now, 'relay_harness-os-pi_opens'],
  ])
})
