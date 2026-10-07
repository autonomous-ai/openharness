import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connectToMaster, HEARTBEAT_INTERVAL_MS, heartbeatInterval, processChannel, processLoopDelay, type LoopDelay, type MasterChannel } from './coreLink.js'
import { HARNESSD_PROTOCOL, type CoreMessage } from './protocol.js'

class FakeChannel implements MasterChannel {
  readonly sent: CoreMessage[] = []
  private messageListeners: Array<(message: unknown) => void> = []
  private disconnect: Array<() => void> = []
  rss = 100
  parentPid = 4242
  connected = true
  send?: (message: CoreMessage) => unknown = (message) => { this.sent.push(message) }
  once(_event: 'disconnect', listener: () => void): void { this.disconnect.push(listener) }
  on(_event: 'message', listener: (message: unknown) => void): void { this.messageListeners.push(listener) }
  memoryUsage(): { rss: number; heapUsed: number } { return { rss: this.rss, heapUsed: this.rss / 2 } }
  say(message: unknown): void { for (const listener of this.messageListeners) listener(message) }
  leave(): void { for (const listener of this.disconnect) listener() }
}

const supervised = { HARNESSD_SUPERVISED: '1' }

/** Loop delays that read back as given, one per beat, and remember being stopped. */
const delays = (...values: number[]) => {
  const made: Array<LoopDelay & { stopped: boolean }> = []
  return {
    made,
    factory: () => {
      const queue = [...values]
      const delay = { stopped: false, take: () => queue.shift() ?? 0, stop: () => { delay.stopped = true } }
      made.push(delay)
      return delay
    },
  }
}

describe('connectToMaster', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('is inert without a master: nothing sent, nothing listened for', () => {
    const channel = new FakeChannel()
    for (const link of [connectToMaster(channel, {}), connectToMaster({ ...channel, send: undefined, once: channel.once.bind(channel), on: channel.on.bind(channel), memoryUsage: () => channel.memoryUsage(), parentPid: 1 }, supervised)]) {
      expect(link.supervised).toBe(false)
      expect(link.masterPid).toBeNull()
      link.bound(1)
      link.ready()
      link.startHeartbeat()
      const gone = vi.fn()
      link.onMasterGone(gone)
      const update = vi.fn()
      link.onUpdate(update)
      channel.say({ type: 'harnessd:update', version: '9.9.9' })
      channel.leave()
      vi.advanceTimersByTime(60_000)
      expect(gone).not.toHaveBeenCalled()
      expect(update).not.toHaveBeenCalled()
      expect(link.status()).toBeNull()
      link.close()
    }
    expect(channel.sent).toEqual([])
  })

  it('says it is bound, then ready, then beats with its memory and loop delay until closed', () => {
    const channel = new FakeChannel()
    const loop = delays(4, 250)
    const link = connectToMaster(channel, supervised, 1_000, loop.factory)
    expect(link.supervised).toBe(true)
    expect(link.masterPid).toBe(4242)
    // Reparented once the master is gone: the master it had is still the one it names.
    channel.parentPid = 1
    expect(link.masterPid).toBe(4242)
    link.bound(18473)
    link.ready()
    link.startHeartbeat()
    link.startHeartbeat()
    channel.rss = 200
    vi.advanceTimersByTime(1_000)
    link.close()
    vi.advanceTimersByTime(5_000)
    link.close()
    expect(channel.sent).toEqual([
      { type: 'harnessd:bound', protocol: HARNESSD_PROTOCOL, port: 18473 },
      { type: 'harnessd:ready' },
      { type: 'harnessd:heartbeat', rssBytes: 100, heapUsedBytes: 50, loopDelayMs: 4 },
      { type: 'harnessd:heartbeat', rssBytes: 200, heapUsedBytes: 100, loopDelayMs: 250 },
    ])
    expect(loop.made).toHaveLength(1)
    expect(loop.made[0].stopped).toBe(true)
  })

  it('beats well inside the silence its master allows', () => {
    const channel = new FakeChannel()
    const link = connectToMaster(channel, { ...supervised, HARNESSD_WATCHDOG_MS: '3000' }, undefined, delays().factory)
    link.startHeartbeat()
    vi.advanceTimersByTime(2_999)
    link.close()
    // One at once, then one a second: three inside the master's three seconds.
    expect(channel.sent.filter((message) => message.type === 'harnessd:heartbeat')).toHaveLength(3)
  })

  it('asks its master for an experiment\'s process, and asks nothing without one', () => {
    const channel = new FakeChannel()
    connectToMaster(channel, supervised).want('orchestrator')
    connectToMaster(channel, {}).want('orchestrator')
    expect(channel.sent).toEqual([{ type: 'harnessd:want', service: 'orchestrator' }])
  })

  it('says why when start-up gave way to safe mode', () => {
    const channel = new FakeChannel()
    connectToMaster(channel, supervised).ready('no tmux')
    expect(channel.sent).toEqual([{ type: 'harnessd:ready', safeMode: 'no tmux' }])
  })

  it('hears an update the master asks for, kept until something listens', async () => {
    const channel = new FakeChannel()
    const link = connectToMaster(channel, supervised)
    // Asked before start-up got as far as listening: not lost.
    channel.say({ type: 'harnessd:update', version: '9.9.8' })
    channel.say({ type: 'harnessd:update', version: '9.9.9' })
    const update = vi.fn()
    link.onUpdate(update)
    expect(update).not.toHaveBeenCalled()
    await Promise.resolve()
    expect(update.mock.calls).toEqual([['9.9.9']])
    channel.say({ type: 'harnessd:update', version: '9.9.10' })
    expect(update.mock.calls).toEqual([['9.9.9'], ['9.9.10']])
    expect(link.status()).toBeNull()
    // Nothing kept, nothing said to a listener that comes later.
    const later = vi.fn()
    link.onUpdate(later)
    await Promise.resolve()
    expect(later).not.toHaveBeenCalled()
  })

  it('keeps what the master says about itself, and hears when the master goes', () => {
    const channel = new FakeChannel()
    const link = connectToMaster(channel, supervised)
    channel.say({ type: 'other' })
    expect(link.status()).toBeNull()
    const status = { state: 'running', corePid: 7, restarts: 2, lastExit: 'code 1', protocol: 1 } as const
    channel.say({ type: 'harnessd:status', status })
    expect(link.status()).toEqual(status)
    const gone = vi.fn()
    link.onMasterGone(gone)
    channel.leave()
    expect(gone).toHaveBeenCalledOnce()
  })

  // runForeground subscribes long after the core has bound: a master killed in between went unnoticed,
  // and its core ran on for good, holding the port.
  it('hears a master that went before anyone asked, and only once', async () => {
    const channel = new FakeChannel()
    const link = connectToMaster(channel, supervised)
    link.bound(1)
    channel.leave()
    const gone = vi.fn()
    link.onMasterGone(gone)
    expect(gone).not.toHaveBeenCalled()
    await Promise.resolve()
    expect(gone).toHaveBeenCalledOnce()
    const later = vi.fn()
    link.onMasterGone(later)
    await Promise.resolve()
    expect(later).toHaveBeenCalledOnce()
    expect(gone).toHaveBeenCalledOnce()
  })

  it('hears a master whose channel had already closed when the core started', async () => {
    const channel = new FakeChannel()
    channel.connected = false
    const gone = vi.fn()
    connectToMaster(channel, supervised).onMasterGone(gone)
    await Promise.resolve()
    expect(gone).toHaveBeenCalledOnce()
  })

  it('survives a send on a channel the master already closed', () => {
    const channel = new FakeChannel()
    channel.send = () => { throw new Error('ERR_IPC_CHANNEL_CLOSED') }
    const link = connectToMaster(channel, supervised)
    expect(() => link.bound(1)).not.toThrow()
  })

  it('uses this process by default, which no master started', () => {
    expect(connectToMaster().supervised).toBe(false)
    expect(processChannel.memoryUsage().rss).toBeGreaterThan(0)
    expect(processChannel.connected).toBe(process.connected)
    expect(processChannel.parentPid).toBe(process.ppid)
  })

  it('measures this process\'s loop delay, in whole milliseconds, from nothing after each reading', () => {
    vi.useRealTimers()
    const delay = processLoopDelay()
    const first = delay.take()
    expect(Number.isInteger(first) && first >= 0).toBe(true)
    expect(delay.take()).toBeGreaterThanOrEqual(0)
    delay.stop()
  })
})

describe('heartbeatInterval', () => {
  it('is a third of the master\'s watchdog, every 5 s at most and every 250 ms at the fastest', () => {
    expect(heartbeatInterval({ HARNESSD_WATCHDOG_MS: '30000' })).toBe(HEARTBEAT_INTERVAL_MS)
    expect(heartbeatInterval({ HARNESSD_WATCHDOG_MS: '3000' })).toBe(1000)
    expect(heartbeatInterval({ HARNESSD_WATCHDOG_MS: '600' })).toBe(250)
  })

  it('is every 5 s without a watchdog, or with one that is not a positive number', () => {
    for (const watchdog of [undefined, '', 'soon', '0', '-3000']) {
      expect(heartbeatInterval(watchdog === undefined ? {} : { HARNESSD_WATCHDOG_MS: watchdog }), String(watchdog)).toBe(HEARTBEAT_INTERVAL_MS)
    }
  })
})
