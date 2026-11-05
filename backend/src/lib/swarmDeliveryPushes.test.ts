import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** The bus' per-machine channel, in memory: a publish reaches only the callbacks subscribed for that machine. */
const bus = vi.hoisted(() => {
  const channels = new Map<string, Set<(msg: unknown) => void>>()
  return {
    channels,
    async subscribe(machineId: string, cb: (msg: unknown) => void) {
      const set = channels.get(machineId) ?? new Set()
      channels.set(machineId, set)
      set.add(cb)
      return () => { set.delete(cb) }
    },
    publish(machineId: string, msg: unknown) { for (const cb of channels.get(machineId) ?? []) cb(msg) },
    published: [] as Array<[string, unknown]>,
    /** False: Redis has gone silent, and a publish reaches nobody. */
    carries: true,
  }
})
const warn = vi.hoisted(() => vi.fn())
vi.mock('../utils/logger.js', () => ({ logger: { warn, info: vi.fn(), error: vi.fn() } }))
vi.mock('./bus.js', () => ({
  subscribeSwarmDeliveries: (machineId: string, cb: (msg: unknown) => void) => bus.subscribe(machineId, cb),
  publishSwarmDeliveries: async (machineId: string, msg: unknown) => {
    bus.published.push([machineId, msg])
    if (!bus.carries) return 0
    bus.publish(machineId, JSON.parse(JSON.stringify(msg)))
    return 1
  },
}))

import { announceSwarmDeliveries, announceSwarmTerminal, relaySwarmDeliveries } from './swarmDeliveryPushes.js'

const pushes = (send: ReturnType<typeof vi.fn>) => send.mock.calls.map(([frame]) => frame)
const told = (payload: object) => ({ t: 'down', connId: '', frame: { type: 'super_tab_deliveries', payload } })

describe('Swarm delivery pushes on a daemon socket', () => {
  beforeEach(() => { bus.channels.clear(); bus.published.length = 0; bus.carries = true; warn.mockClear(); vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('says it pushes as soon as the socket is attached, so the host reads every 30 s instead of each second', async () => {
    const send = vi.fn()
    await relaySwarmDeliveries('machine-a', send)
    expect(pushes(send)).toEqual([told({})])
  })

  it('names the Swarm and agent of a delivery waiting on its own machine', async () => {
    const send = vi.fn()
    await relaySwarmDeliveries('machine-a', send)
    send.mockClear()
    bus.publish('machine-a', { tabId: 'tab-1', agentId: 'agent-1' })
    expect(pushes(send)).toEqual([told({ tabId: 'tab-1', agentId: 'agent-1' })])
  })

  // The store's deliveriesWaiting on every server (routes/superTabs.ts, worker.ts), wherever the machine's socket is held.
  it('carries a delivery the store announces to the socket of the agent\'s machine, and to no other', async () => {
    const a = vi.fn(), b = vi.fn()
    await relaySwarmDeliveries('machine-a', a)
    await relaySwarmDeliveries('machine-b', b)
    a.mockClear()
    b.mockClear()
    announceSwarmDeliveries({ machineId: 'machine-a', tabId: 'tab-1', agentId: 'agent-1' })
    await vi.waitFor(() => expect(pushes(a)).toEqual([told({ tabId: 'tab-1', agentId: 'agent-1' })]))
    expect(pushes(b)).toEqual([])
  })

  // The machine is the one the socket signed in as (adapterWs.ts), never one the client names.
  it('never hears a delivery waiting on another machine', async () => {
    const send = vi.fn()
    await relaySwarmDeliveries('machine-a', send)
    send.mockClear()
    bus.publish('machine-b', { tabId: 'tab-1', agentId: 'agent-1' })
    expect(pushes(send)).toEqual([])
  })

  // Spec 2026-11-02 poll cost, Part 4.2: a terminal request waiting for this machine, as a `__` control frame an older
  // daemon drops (cli gateway backendControl); the newer one picks it up at once instead of every 3 s.
  it('carries a terminal request the store announces to its machine as __terminal_waiting', async () => {
    const a = vi.fn(), b = vi.fn()
    await relaySwarmDeliveries('machine-a', a)
    await relaySwarmDeliveries('machine-b', b)
    a.mockClear(); b.mockClear()
    announceSwarmTerminal({ machineId: 'machine-a', tabId: 'tab-1', agentId: 'agent-1' })
    await vi.waitFor(() => expect(pushes(a)).toEqual([{ t: 'down', connId: '', frame: { type: '__terminal_waiting', payload: { tabId: 'tab-1', agentId: 'agent-1' } } }]))
    expect(pushes(b)).toEqual([])
  })

  it('a frame an older daemon sees is a __ control frame or a delivery push it already reads', async () => {
    const send = vi.fn()
    await relaySwarmDeliveries('machine-a', send)
    send.mockClear()
    announceSwarmDeliveries({ machineId: 'machine-a', tabId: 'tab-1', agentId: 'agent-1' })
    announceSwarmTerminal({ machineId: 'machine-a', tabId: 'tab-1', agentId: 'agent-1' })
    await vi.waitFor(() => expect(pushes(send)).toHaveLength(2))
    expect(pushes(send).map(f => (f as { frame: { type: string } }).frame.type).every(type => type === 'super_tab_deliveries' || type.startsWith('__'))).toBe(true)
  })

  it('passes on nothing but a Swarm and an agent', async () => {
    const send = vi.fn()
    await relaySwarmDeliveries('machine-a', send)
    send.mockClear()
    bus.publish('machine-a', { tabId: 'tab-1', agentId: 'agent-1', text: 'secret' })
    bus.publish('machine-a', { tabId: 7, agentId: 'agent-1' })
    bus.publish('machine-a', null)
    expect(pushes(send)).toEqual([told({ tabId: 'tab-1', agentId: 'agent-1' })])
  })

  // Review of #2977 (Important 1): an idle worker's list is read only when told, so a host must learn within minutes that the
  // channel went silent. Each minute the server renews the host's push lease through Redis (cli superTabs/host.ts
  // PUSH_LEASE_MS, 2.5 min) with a `__` frame an older daemon drops; every 4 minutes it also says it pushes as before, which
  // makes a host read every list once, the net an older daemon already had.
  const lease = { t: 'down', connId: '', frame: { type: '__deliveries_lease', payload: {} } }
  it('renews the lease each minute, and says it pushes every 4 minutes', async () => {
    const send = vi.fn()
    await relaySwarmDeliveries('machine-a', send)
    send.mockClear()
    await vi.advanceTimersByTimeAsync(60_000 - 1)
    expect(pushes(send)).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(pushes(send)).toEqual([lease])
    await vi.advanceTimersByTimeAsync(3 * 60_000)
    expect(pushes(send)).toEqual([lease, lease, lease, lease, told({})])
    expect(bus.published).toHaveLength(4)
  })

  // Task #2800: an idle worker's list is read only when the server says so, so a repeat from a local timer would keep a host
  // sure that pushes come while Redis is silent, and nothing would be read for good. As the host-changes repeat (review of
  // #2113), it goes through the machine's own channel: no Redis, no repeat, and in 10 minutes the host reads each second again.
  it('says it again through the machine\'s own channel, and logs a repeat nobody heard', async () => {
    const send = vi.fn()
    await relaySwarmDeliveries('machine-a', send)
    send.mockClear()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(bus.published).toEqual([['machine-a', { pushes: true }]])
    expect(pushes(send)).toEqual([lease])
    send.mockClear()
    bus.carries = false
    await vi.advanceTimersByTimeAsync(4 * 60_000)
    expect(pushes(send)).toEqual([])
    expect(warn).toHaveBeenCalledWith('[swarm] delivery push repeat reached no one; hosts fall back to reading each second', { machineId: 'machine-a' })
  })

  // The host keeps reading each second while it has not heard that the server pushes: nothing is lost, only the saving.
  it('says nothing when it cannot listen, and never fails the socket for it', async () => {
    const send = vi.fn()
    const subscribe = vi.spyOn(bus, 'subscribe').mockRejectedValueOnce(new Error('Redis unreachable'))
    const stop = await relaySwarmDeliveries('machine-a', send)
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(pushes(send)).toEqual([])
    stop()
    subscribe.mockRestore()
  })

  it('stops listening and repeating once the socket closes', async () => {
    const send = vi.fn()
    const stop = await relaySwarmDeliveries('machine-a', send)
    send.mockClear()
    stop()
    bus.publish('machine-a', { tabId: 'tab-1', agentId: 'agent-1' })
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(pushes(send)).toEqual([])
  })
})
