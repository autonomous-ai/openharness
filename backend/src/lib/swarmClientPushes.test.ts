import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** The bus' per-user channel, in memory: a publish reaches only the callbacks subscribed for that person. */
const bus = vi.hoisted(() => {
  const channels = new Map<string, Set<(msg: unknown) => void>>()
  return {
    channels,
    published: [] as Array<[string, unknown]>,
    async subscribe(userId: string, cb: (msg: unknown) => void) {
      const set = channels.get(userId) ?? new Set()
      channels.set(userId, set)
      set.add(cb)
      return () => { set.delete(cb) }
    },
    publish(userId: string, msg: unknown) { for (const cb of channels.get(userId) ?? []) cb(msg) },
    /** False: Redis has gone silent, and a publish reaches nobody. */
    carries: true,
  }
})
const warn = vi.hoisted(() => vi.fn())
vi.mock('../utils/logger.js', () => ({ logger: { warn, info: vi.fn(), error: vi.fn() } }))
vi.mock('./bus.js', () => ({
  subscribeSwarmMember: (userId: string, cb: (msg: unknown) => void) => bus.subscribe(userId, cb),
  publishSwarmMember: async (userId: string, msg: unknown) => {
    bus.published.push([userId, msg])
    if (!bus.carries) return 0
    bus.publish(userId, JSON.parse(JSON.stringify(msg)))
    return 1
  },
}))

import { announceSwarmChanges, relaySwarmChanges } from './swarmClientPushes.js'

const frames = (send: ReturnType<typeof vi.fn>) => send.mock.calls.map(([frame]) => frame)
const told = (payload: object) => ({ type: 'swarm_changed', payload })

describe('Swarm change pushes to a person\'s apps', () => {
  beforeEach(() => { bus.channels.clear(); bus.published.length = 0; bus.carries = true; warn.mockClear(); vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('says it pushes as soon as the socket is attached, and again every 4 minutes', async () => {
    const send = vi.fn()
    await relaySwarmChanges('kim', send)
    expect(frames(send)).toEqual([told({})])
    send.mockClear()
    await vi.advanceTimersByTimeAsync(4 * 60_000 - 1)
    expect(frames(send)).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(frames(send)).toEqual([told({})])
  })

  // Review of #2113, carried here: the repeat through the person's channel, so a Redis gone silent stops it. Each socket
  // names itself, so a person with several sockets hears one repeat per socket, not one per socket per socket.
  it('says it again through the person\'s own channel, once per socket, and logs a repeat nobody heard', async () => {
    const phone = vi.fn(), laptop = vi.fn()
    await relaySwarmChanges('kim', phone)
    await relaySwarmChanges('kim', laptop)
    phone.mockClear()
    laptop.mockClear()
    await vi.advanceTimersByTimeAsync(4 * 60_000)
    expect(bus.published.map(([userId]) => userId)).toEqual(['kim', 'kim'])
    expect(frames(phone)).toEqual([told({})])
    expect(frames(laptop)).toEqual([told({})])
    phone.mockClear()
    bus.carries = false
    await vi.advanceTimersByTimeAsync(4 * 60_000)
    expect(frames(phone)).toEqual([])
    expect(warn).toHaveBeenCalledWith('[swarm] change push repeat reached no one; apps fall back to their timers', { userId: 'kim' })
  })

  it('carries a commit to each person it names, and to no one else', async () => {
    const kim = vi.fn(), lee = vi.fn(), stranger = vi.fn()
    await relaySwarmChanges('kim', kim)
    await relaySwarmChanges('lee', lee)
    await relaySwarmChanges('stranger', stranger)
    for (const send of [kim, lee, stranger]) send.mockClear()
    announceSwarmChanges({ tabId: 'tab-1', userIds: ['kim', 'lee'], lastChangedAt: 1_700, parts: ['main'] })
    await vi.waitFor(() => expect(frames(lee)).toEqual([told({ tabId: 'tab-1', lastChangedAt: 1_700, parts: ['main'] })]))
    expect(frames(kim)).toEqual([told({ tabId: 'tab-1', lastChangedAt: 1_700, parts: ['main'] })])
    expect(frames(stranger)).toEqual([])
  })

  it('passes on nothing but a Swarm, a time and the parts that moved', async () => {
    const send = vi.fn()
    await relaySwarmChanges('kim', send)
    send.mockClear()
    bus.publish('kim', { tabId: 'tab-1', lastChangedAt: 1_700, parts: ['main'], text: 'secret' })
    bus.publish('kim', { tabId: 'tab-2', lastChangedAt: 1_700, parts: ['everything'] })
    bus.publish('kim', { tabId: 7, lastChangedAt: 1_700, parts: ['main'] })
    bus.publish('kim', null)
    expect(frames(send)).toEqual([told({ tabId: 'tab-1', lastChangedAt: 1_700, parts: ['main'] })])
  })

  // The Lead's rule (2026-10-29): a Swarm committing every second must not become a read per commit per window.
  it('sends at most one push per Swarm a second: the first at once, then the latest with every part it saw', async () => {
    const send = vi.fn()
    await relaySwarmChanges('kim', send)
    send.mockClear()
    bus.publish('kim', { tabId: 'tab-1', lastChangedAt: 1, parts: ['machine'] })
    bus.publish('kim', { tabId: 'tab-1', lastChangedAt: 2, parts: ['main'] })
    bus.publish('kim', { tabId: 'tab-1', lastChangedAt: 3, parts: ['machine'] })
    bus.publish('kim', { tabId: 'tab-2', lastChangedAt: 4, parts: ['main'] })
    expect(frames(send)).toEqual([told({ tabId: 'tab-1', lastChangedAt: 1, parts: ['machine'] }), told({ tabId: 'tab-2', lastChangedAt: 4, parts: ['main'] })])
    send.mockClear()
    await vi.advanceTimersByTimeAsync(999)
    expect(frames(send)).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(frames(send)).toEqual([told({ tabId: 'tab-1', lastChangedAt: 3, parts: ['main', 'machine'] })])
    send.mockClear()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(frames(send)).toEqual([])
  })

  // The process coalesces by Swarm across tests, so this one has a Swarm of its own.
  it('publishes at most once per Swarm a second, every person and part of that second included', async () => {
    announceSwarmChanges({ tabId: 'tab-busy', userIds: ['kim'], lastChangedAt: 1, parts: ['main'] })
    announceSwarmChanges({ tabId: 'tab-busy', userIds: ['kim', 'lee'], lastChangedAt: 2, parts: ['machine'] })
    announceSwarmChanges({ tabId: 'tab-busy', userIds: ['kim'], lastChangedAt: 3, parts: ['main'] })
    expect(bus.published).toEqual([['kim', { tabId: 'tab-busy', lastChangedAt: 1, parts: ['main'] }]])
    await vi.advanceTimersByTimeAsync(1_000)
    expect(bus.published.slice(1)).toEqual([['kim', { tabId: 'tab-busy', lastChangedAt: 3, parts: ['main', 'machine'] }],
      ['lee', { tabId: 'tab-busy', lastChangedAt: 3, parts: ['main', 'machine'] }]])
  })

  it('says nothing when it cannot listen, and never fails the socket for it', async () => {
    const send = vi.fn()
    const subscribe = vi.spyOn(bus, 'subscribe').mockRejectedValueOnce(new Error('Redis unreachable'))
    const stop = await relaySwarmChanges('kim', send)
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(frames(send)).toEqual([])
    stop()
    subscribe.mockRestore()
  })

  it('stops listening, repeating and any push it held once the socket closes', async () => {
    const send = vi.fn()
    const stop = await relaySwarmChanges('kim', send)
    bus.publish('kim', { tabId: 'tab-1', lastChangedAt: 1, parts: ['main'] })
    bus.publish('kim', { tabId: 'tab-1', lastChangedAt: 2, parts: ['main'] })
    send.mockClear()
    stop()
    bus.publish('kim', { tabId: 'tab-1', lastChangedAt: 3, parts: ['main'] })
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(frames(send)).toEqual([])
  })

  // Ken's rule (2026-10-29): an optimization ships on, with no switch. Old apps ignore the frame and keep their timers; a
  // server rolled back stops saying it pushes, and apps go back to their timers 5 minutes later.
  it('says it pushes and publishes with no setting at all', async () => {
    const send = vi.fn()
    await relaySwarmChanges('kim', send)
    expect(frames(send)).toEqual([told({})])
    announceSwarmChanges({ tabId: 'tab-plain', userIds: ['kim'], lastChangedAt: 1, parts: ['main'] })
    await vi.waitFor(() => expect(bus.published).toEqual([['kim', { tabId: 'tab-plain', lastChangedAt: 1, parts: ['main'] }]]))
  })
})
