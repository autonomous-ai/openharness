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
  }
})
vi.mock('./bus.js', () => ({
  subscribeSwarmDeliveries: (machineId: string, cb: (msg: unknown) => void) => bus.subscribe(machineId, cb),
  publishSwarmDeliveries: async (machineId: string, msg: unknown) => { bus.publish(machineId, JSON.parse(JSON.stringify(msg))); return 1 },
}))

import { announceSwarmDeliveries, relaySwarmDeliveries } from './swarmDeliveryPushes.js'

const pushes = (send: ReturnType<typeof vi.fn>) => send.mock.calls.map(([frame]) => frame)
const told = (payload: object) => ({ t: 'down', connId: '', frame: { type: 'super_tab_deliveries', payload } })

describe('Swarm delivery pushes on a daemon socket', () => {
  beforeEach(() => { bus.channels.clear(); vi.useFakeTimers() })
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

  it('passes on nothing but a Swarm and an agent', async () => {
    const send = vi.fn()
    await relaySwarmDeliveries('machine-a', send)
    send.mockClear()
    bus.publish('machine-a', { tabId: 'tab-1', agentId: 'agent-1', text: 'secret' })
    bus.publish('machine-a', { tabId: 7, agentId: 'agent-1' })
    bus.publish('machine-a', null)
    expect(pushes(send)).toEqual([told({ tabId: 'tab-1', agentId: 'agent-1' })])
  })

  // The host goes back to reading each second 10 minutes after it last heard this (cli superTabs/host.ts PUSH_LEASE_MS).
  it('says again that it pushes every 4 minutes', async () => {
    const send = vi.fn()
    await relaySwarmDeliveries('machine-a', send)
    send.mockClear()
    await vi.advanceTimersByTimeAsync(4 * 60_000 - 1)
    expect(pushes(send)).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(pushes(send)).toEqual([told({})])
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
