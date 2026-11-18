import { EventEmitter } from 'node:events'
import { WebSocket } from 'ws'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { devicePeerBudgets, devicePeerChannel, type DevicePeerChannel } from './peerChannel.js'
import { devicePeerWriter } from './peerWriter.js'
import { DEVICE_PEER_DRAIN_MS, DEVICE_PEER_MESSAGE_BYTES } from './peerProtocol.js'
import type { AutonomousDeviceFrame } from './service.js'

class Socket extends EventEmitter {
  readyState: number = WebSocket.OPEN
  bufferedAmount = 0
  callbacks: Array<(error?: Error) => void> = []
  sent: string[] = []
  send(wire: string, done: (error?: Error) => void) { this.sent.push(wire); this.callbacks.push(done) }
  terminate = vi.fn()
  physicallyClose() { this.readyState = WebSocket.CLOSED; this.emit('close') }
}
function fixture() {
  const budgets = devicePeerBudgets(), failed = vi.fn()
  let current: DevicePeerChannel | null = null, epoch = 'first'
  const writer = devicePeerWriter({ budgets, channel: () => current, failed })
  const open = () => {
    const socket = new Socket(), captured = epoch
    const channel = devicePeerChannel(socket as unknown as WebSocket, { side: 'component', role: 'devices',
      epoch, budgets, current: () => epoch === captured, failed, receive: () => {},
      gone: () => { if (current === channel) current = null; writer.drain() }, writable: () => writer.drain(),
    })
    current = channel
    return { socket, channel }
  }
  const first = open()
  const route = (connId: string) => ({ connId, identity: 'owner', incarnation: 'session', epoch })
  return { budgets, failed, writer, first, route,
    replace: () => { epoch = 'second'; first.channel.close(); const next = open(); writer.drain(); return next },
  }
}
const resync = (start: number): AutonomousDeviceFrame[] => [{ type: 'resync', cursor: start },
  ...Array.from({ length: 512 }, (_, n) => ({ type: 'event', kind: 'turn.summary', eventId: start + n + 1,
    payload: { fullText: `Result ${n}` } }))]
afterEach(() => vi.useRealTimers())

describe('one bounded FIFO for replay and live device frames', () => {
  it('drains overlapping 512-result resyncs before a concurrent nonretained event without raising physical slots', () => {
    const f = fixture()
    for (const [connId, start] of [['A', 0], ['B', 512]] as const) {
      const admitted = f.writer.replay(f.route(connId), resync(start), () => true, () => true)
      expect(admitted).not.toBeNull(); admitted!()
    }
    expect(f.writer.send({ type: 'send', ...f.route('A'), frameType: 'autonomous_device_event',
      payload: { type: 'event', kind: 'agent.stream', payload: { text: 'live' } } }, () => true)).toBe(true)
    expect(f.first.socket.sent).toHaveLength(256)
    expect(f.budgets.outgoing.snapshot().frames).toBe(256)
    const peakBytes = f.budgets.outgoing.snapshot().bytes
    for (let i = 0; i < f.first.socket.callbacks.length; i++) f.first.socket.callbacks[i]!()
    const sent = f.first.socket.sent.map(wire => JSON.parse(wire))
    expect(sent).toHaveLength(1029)
    expect(sent.slice(0, 514).every(frame => frame.connId === 'A')).toBe(true)
    expect(sent.slice(514, 1028).every(frame => frame.connId === 'B')).toBe(true)
    expect(sent.at(-1).payload.kind).toBe('agent.stream')
    expect(peakBytes).toBeGreaterThan(0)
    expect(f.budgets.outgoing.snapshot()).toEqual({ bytes: 0, frames: 0 })
    expect(f.failed).not.toHaveBeenCalled()
    f.first.socket.physicallyClose()
  })

  it('discards revoked or replaced unsent leases while physical writes stay charged until callback/close', () => {
    const f = fixture()
    let authorized = true
    f.writer.replay(f.route('A'), resync(0), () => authorized, () => authorized)!()
    const physicalBytes = f.first.socket.sent.reduce((sum, wire) => sum + Buffer.byteLength(wire), 0)
    authorized = false
    const next = f.replace()
    expect(f.budgets.outgoing.snapshot()).toEqual({ bytes: physicalBytes, frames: 256 })
    expect(next.socket.sent).toHaveLength(0)
    f.first.socket.callbacks[0]!()
    f.first.socket.physicallyClose()
    for (const done of f.first.socket.callbacks) done()
    expect(f.budgets.outgoing.snapshot()).toEqual({ bytes: 0, frames: 0 })
    expect(f.writer.send({ type: 'ready', epoch: 'second' }, () => true)).toBe(true)
    next.socket.callbacks[0]!(); next.socket.physicallyClose()
    expect(f.budgets.outgoing.snapshot()).toEqual({ bytes: 0, frames: 0 })
  })

  it('refuses a whole replay before admission and charges each repeated source reference', () => {
    const f = fixture()
    const shared = { type: 'event', payload: { text: 'x'.repeat(64 * 1024) } }
    const frames = Array.from({ length: 513 }, () => shared)
    expect(f.writer.replay(f.route('A'), frames, () => true, () => true)).toBeNull()
    expect(f.first.socket.sent).toHaveLength(0)
    expect(f.budgets.outgoing.snapshot()).toEqual({ bytes: 0, frames: 0 })
    expect(f.failed).toHaveBeenCalledWith('PEER_WRITE_BACKPRESSURE')
  })

  it('holds the shared byte ceiling across a blocked replacement and releases each callback once', () => {
    const f = fixture()
    f.first.channel.send('x'.repeat(DEVICE_PEER_MESSAGE_BYTES - 100))
    const next = f.replace()
    expect(f.writer.send({ type: 'send', ...f.route('A'), frameType: 'autonomous_device_event', payload: { text: 'blocked' } }, () => true)).toBe(false)
    f.first.socket.physicallyClose()
    f.first.socket.callbacks[0]!()
    expect(f.budgets.outgoing.snapshot()).toEqual({ bytes: 0, frames: 0 })
    next.socket.physicallyClose()
  })

  it('terminates a peer that never drains, without returning its physical credit early', () => {
    vi.useFakeTimers()
    const f = fixture()
    f.writer.replay(f.route('A'), resync(0), () => true, () => true)!()
    vi.advanceTimersByTime(DEVICE_PEER_DRAIN_MS)
    expect(f.failed).toHaveBeenCalledWith('PEER_DRAIN_DEADLINE')
    expect(f.first.socket.terminate).toHaveBeenCalled()
    expect(f.budgets.outgoing.snapshot().frames).toBe(256)
    f.first.socket.physicallyClose()
    expect(f.budgets.outgoing.snapshot()).toEqual({ bytes: 0, frames: 0 })
  })

  it('does not let an expired writer callback close or discard a synchronously published replacement', () => {
    vi.useFakeTimers()
    const f = fixture()
    f.writer.replay(f.route('A'), resync(0), () => true, () => true)!()
    let next: ReturnType<typeof f.replace> | undefined
    f.failed.mockImplementationOnce(() => {
      next = f.replace()
      expect(f.writer.send({ type: 'ready', epoch: 'second' }, () => true)).toBe(true)
    })
    vi.advanceTimersByTime(DEVICE_PEER_DRAIN_MS)
    expect(next).toBeDefined()
    expect(next!.socket.terminate).not.toHaveBeenCalled()
    f.first.socket.physicallyClose()
    expect(next!.socket.sent.map(wire => JSON.parse(wire))).toEqual([{ type: 'ready', epoch: 'second' }])
    next!.socket.callbacks[0]!(); next!.socket.physicallyClose()
    expect(f.budgets.outgoing.snapshot()).toEqual({ bytes: 0, frames: 0 })
  })
})
