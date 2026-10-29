import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** The bus' per-machine channel, in memory: a publish reaches only the callbacks subscribed for that machine. */
const bus = vi.hoisted(() => {
  const channels = new Map<string, Set<(msg: unknown) => void>>()
  return {
    channels,
    published: [] as Array<[string, unknown]>,
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
  subscribeSwarmHost: (machineId: string, cb: (msg: unknown) => void) => bus.subscribe(machineId, cb),
  publishSwarmHost: async (machineId: string, msg: unknown) => {
    bus.published.push([machineId, msg])
    bus.publish(machineId, JSON.parse(JSON.stringify(msg)))
    return 1
  },
}))

import { announceSwarmHostChanges, relaySwarmHostChanges } from './swarmHostPushes.js'

const pushes = (send: ReturnType<typeof vi.fn>) => send.mock.calls.map(([frame]) => frame)
const told = (payload: object) => ({ t: 'down', connId: '', frame: { type: 'swarm_host_changed', payload } })

describe('Swarm host pushes on a daemon socket', () => {
  beforeEach(() => { bus.channels.clear(); bus.published.length = 0; vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('says it pushes as soon as the socket is attached, so the host stops reading its changes each second', async () => {
    const send = vi.fn()
    await relaySwarmHostChanges('machine-a', send)
    expect(pushes(send)).toEqual([told({})])
  })

  it('names the Swarm and its change time when a commit concerns its own machine', async () => {
    const send = vi.fn()
    await relaySwarmHostChanges('machine-a', send)
    send.mockClear()
    bus.publish('machine-a', { tabId: 'tab-1', lastChangedAt: 1_700 })
    expect(pushes(send)).toEqual([told({ tabId: 'tab-1', lastChangedAt: 1_700 })])
  })

  // The store's hostsChanged on every server (routes/superTabs.ts, worker.ts), wherever each machine's socket is held.
  it('carries a commit to the socket of each machine it names, and to no other', async () => {
    const a = vi.fn(), b = vi.fn(), c = vi.fn()
    await relaySwarmHostChanges('machine-a', a)
    await relaySwarmHostChanges('machine-b', b)
    await relaySwarmHostChanges('machine-c', c)
    for (const send of [a, b, c]) send.mockClear()
    announceSwarmHostChanges({ tabId: 'tab-1', machineIds: ['machine-a', 'machine-b'], lastChangedAt: 1_700 })
    await vi.waitFor(() => expect(pushes(b)).toEqual([told({ tabId: 'tab-1', lastChangedAt: 1_700 })]))
    expect(pushes(a)).toEqual([told({ tabId: 'tab-1', lastChangedAt: 1_700 })])
    expect(pushes(c)).toEqual([])
  })

  // The machine is the one the socket signed in as (adapterWs.ts), never one the client names.
  it('never hears a commit that concerns only another machine', async () => {
    const send = vi.fn()
    await relaySwarmHostChanges('machine-a', send)
    send.mockClear()
    bus.publish('machine-b', { tabId: 'tab-1', lastChangedAt: 1_700 })
    expect(pushes(send)).toEqual([])
  })

  it('passes on nothing but a Swarm and a time', async () => {
    const send = vi.fn()
    await relaySwarmHostChanges('machine-a', send)
    send.mockClear()
    bus.publish('machine-a', { tabId: 'tab-1', lastChangedAt: 1_700, roster: ['secret'] })
    bus.publish('machine-a', { tabId: 7, lastChangedAt: 1_700 })
    bus.publish('machine-a', { tabId: 'tab-1', lastChangedAt: 'soon' })
    bus.publish('machine-a', null)
    expect(pushes(send)).toEqual([told({ tabId: 'tab-1', lastChangedAt: 1_700 })])
  })

  // The host goes back to reading each second 5 minutes after it last heard this (cli superTabs/hostFeed.ts HOST_PUSH_LEASE_MS).
  it('says again that it pushes every 4 minutes', async () => {
    const send = vi.fn()
    await relaySwarmHostChanges('machine-a', send)
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
    const stop = await relaySwarmHostChanges('machine-a', send)
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(pushes(send)).toEqual([])
    stop()
    subscribe.mockRestore()
  })

  it('stops listening and repeating once the socket closes', async () => {
    const send = vi.fn()
    const stop = await relaySwarmHostChanges('machine-a', send)
    send.mockClear()
    stop()
    bus.publish('machine-a', { tabId: 'tab-1', lastChangedAt: 1_700 })
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(pushes(send)).toEqual([])
  })

  // Ken's rule (2026-10-29): an optimization ships on, with no switch. Old daemons ignore the frame and keep reading each
  // second; a server rolled back stops saying it pushes, and hosts go back to each second 5 minutes later.
  it('says it pushes and publishes with no setting at all', async () => {
    const send = vi.fn()
    await relaySwarmHostChanges('machine-a', send)
    expect(pushes(send)).toEqual([told({})])
    announceSwarmHostChanges({ tabId: 'tab-1', machineIds: ['machine-a'], lastChangedAt: 1_700 })
    await vi.waitFor(() => expect(bus.published).toEqual([['machine-a', { tabId: 'tab-1', lastChangedAt: 1_700 }]]))
  })
})
