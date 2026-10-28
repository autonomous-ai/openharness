import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** The bus's per-machine channel (lib/bus.ts): what is published for one machine reaches only its subscribers. */
const bus = vi.hoisted(() => {
  const channels = new Map<string, Set<(msg: unknown) => void>>()
  return {
    channels,
    subscribe: vi.fn(async (machineId: string, cb: (msg: unknown) => void) => {
      const set = channels.get(machineId) ?? new Set()
      channels.set(machineId, set.add(cb))
      return () => { set.delete(cb) }
    }),
    publish: (machineId: string, msg: unknown) => { for (const cb of channels.get(machineId) ?? []) cb(msg) },
  }
})
vi.mock('./bus.js', () => ({ subscribeSuperTabDeliveries: bus.subscribe,
  publishSuperTabDeliveries: async (machineId: string, msg: unknown) => { bus.publish(machineId, JSON.parse(JSON.stringify(msg))); return 1 }, pub: {} }))

import { ANNOUNCE_EVERY_MS, deliveryStoreHooks, relayDeliveryPushes } from './adapterDeliveryPushes.js'

const pushed = (send: ReturnType<typeof vi.fn>) => send.mock.calls.map(([frame]) => frame)
const frame = (payload: Record<string, unknown>) => ({ t: 'down', connId: '', frame: { type: 'super_tab_deliveries', payload } })

describe('delivery pushes on a machine\'s daemon socket', () => {
  beforeEach(() => { vi.useFakeTimers(); bus.channels.clear() })
  afterEach(() => { vi.useRealTimers() })

  it('says at once that the server pushes, then names each agent of this machine that work waits for', async () => {
    const send = vi.fn()
    await relayDeliveryPushes('mac-1', send)
    expect(pushed(send)).toEqual([frame({})])
    bus.publish('mac-1', { tabId: 'tab', agentId: 'agent' })
    expect(pushed(send)).toEqual([frame({}), frame({ tabId: 'tab', agentId: 'agent' })])
  })

  // The Lead's rule for this change: a socket hears only its own machine.
  it('never hands on another machine\'s push', async () => {
    const mine = vi.fn(), theirs = vi.fn()
    await relayDeliveryPushes('mac-1', mine)
    await relayDeliveryPushes('mac-2', theirs)
    bus.publish('mac-2', { tabId: 'tab', agentId: 'their-agent' })
    expect(pushed(mine)).toEqual([frame({})])
    expect(pushed(theirs)).toEqual([frame({}), frame({ tabId: 'tab', agentId: 'their-agent' })])
  })

  it('hands on only the names, and nothing for a message without them', async () => {
    const send = vi.fn()
    await relayDeliveryPushes('mac-1', send)
    bus.publish('mac-1', { tabId: 'tab', agentId: 'agent', text: 'a secret' })
    bus.publish('mac-1', { tabId: 'tab' })
    bus.publish('mac-1', 'garbage')
    expect(pushed(send)).toEqual([frame({}), frame({ tabId: 'tab', agentId: 'agent' })])
  })

  // A host stops trusting the push 10 minutes after it last heard this (cli superTabs/host.ts PUSH_LEASE_MS).
  it('says again every 4 minutes that it pushes, until stopped', async () => {
    const send = vi.fn()
    const stop = await relayDeliveryPushes('mac-1', send)
    expect(ANNOUNCE_EVERY_MS).toBe(4 * 60_000)
    vi.advanceTimersByTime(ANNOUNCE_EVERY_MS * 2)
    expect(pushed(send)).toEqual([frame({}), frame({}), frame({})])
    stop()
    vi.advanceTimersByTime(ANNOUNCE_EVERY_MS)
    bus.publish('mac-1', { tabId: 'tab', agentId: 'agent' })
    expect(send).toHaveBeenCalledTimes(3)
  })
})

describe('the Swarm store\'s word that a delivery waits, on the server', () => {
  beforeEach(() => { bus.channels.clear() })

  it('reaches the daemon socket of that agent\'s machine and no other', async () => {
    const mine = vi.fn(), theirs = vi.fn()
    await relayDeliveryPushes('mac-1', mine)
    await relayDeliveryPushes('mac-2', theirs)
    deliveryStoreHooks().deliveryWaiting('mac-1', 'tab', 'agent')
    await vi.waitFor(() => expect(pushed(mine)).toEqual([frame({}), frame({ tabId: 'tab', agentId: 'agent' })]))
    expect(pushed(theirs)).toEqual([frame({})])
  })

  it('keeps the quiet poll\'s memory where every server shares it', () => {
    expect(deliveryStoreHooks().pollMarks).toEqual({ recent: expect.any(Function), mark: expect.any(Function) })
  })
})
