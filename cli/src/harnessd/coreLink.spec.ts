import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connectToMaster, processChannel, type MasterChannel } from './coreLink.js'
import { HARNESSD_PROTOCOL, type CoreMessage } from './protocol.js'

class FakeChannel implements MasterChannel {
  readonly sent: CoreMessage[] = []
  private messageListeners: Array<(message: unknown) => void> = []
  private disconnect: Array<() => void> = []
  rss = 100
  send?: (message: CoreMessage) => unknown = (message) => { this.sent.push(message) }
  once(_event: 'disconnect', listener: () => void): void { this.disconnect.push(listener) }
  on(_event: 'message', listener: (message: unknown) => void): void { this.messageListeners.push(listener) }
  memoryUsage(): { rss: number; heapUsed: number } { return { rss: this.rss, heapUsed: this.rss / 2 } }
  say(message: unknown): void { for (const listener of this.messageListeners) listener(message) }
  leave(): void { for (const listener of this.disconnect) listener() }
}

const supervised = { HARNESSD_SUPERVISED: '1' }

describe('connectToMaster', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('is inert without a master: nothing sent, nothing listened for', () => {
    const channel = new FakeChannel()
    for (const link of [connectToMaster(channel, {}), connectToMaster({ ...channel, send: undefined, once: channel.once.bind(channel), on: channel.on.bind(channel), memoryUsage: () => channel.memoryUsage() }, supervised)]) {
      expect(link.supervised).toBe(false)
      link.bound(1)
      link.startHeartbeat()
      const gone = vi.fn()
      link.onMasterGone(gone)
      channel.leave()
      vi.advanceTimersByTime(60_000)
      expect(gone).not.toHaveBeenCalled()
      expect(link.status()).toBeNull()
      link.close()
    }
    expect(channel.sent).toEqual([])
  })

  it('says it is bound, then beats with its memory until closed', () => {
    const channel = new FakeChannel()
    const link = connectToMaster(channel, supervised, 1_000)
    expect(link.supervised).toBe(true)
    link.bound(18473)
    link.startHeartbeat()
    link.startHeartbeat()
    channel.rss = 200
    vi.advanceTimersByTime(1_000)
    link.close()
    vi.advanceTimersByTime(5_000)
    link.close()
    expect(channel.sent).toEqual([
      { type: 'harnessd:bound', protocol: HARNESSD_PROTOCOL, port: 18473 },
      { type: 'harnessd:heartbeat', rssBytes: 100, heapUsedBytes: 50 },
      { type: 'harnessd:heartbeat', rssBytes: 200, heapUsedBytes: 100 },
    ])
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

  it('survives a send on a channel the master already closed', () => {
    const channel = new FakeChannel()
    channel.send = () => { throw new Error('ERR_IPC_CHANNEL_CLOSED') }
    const link = connectToMaster(channel, supervised)
    expect(() => link.bound(1)).not.toThrow()
  })

  it('uses this process by default, which no master started', () => {
    expect(connectToMaster().supervised).toBe(false)
    expect(processChannel.memoryUsage().rss).toBeGreaterThan(0)
  })
})
