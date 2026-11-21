import { EventEmitter } from 'node:events'
import { WebSocket } from 'ws'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { devicePeerBudgets, devicePeerChannel } from './peerChannel.js'
import { DEVICE_PEER_DRAIN_MS, DEVICE_PEER_MESSAGE_BYTES } from './peerProtocol.js'

class Socket extends EventEmitter {
  readyState: number = WebSocket.OPEN
  bufferedAmount = 0
  callbacks: Array<(error?: Error) => void> = []
  send = vi.fn((_wire: string, done: (error?: Error) => void) => { this.callbacks.push(done) })
  terminate = vi.fn()
  message(value: unknown) { this.emit('message', Buffer.from(JSON.stringify(value)), false) }
  physicallyClose() { this.readyState = WebSocket.CLOSED; this.emit('close') }
}
function fixture(budgets = devicePeerBudgets(), receive: (frame: unknown) => void | Promise<void> = () => {}) {
  const socket = new Socket(), failed = vi.fn(), gone = vi.fn()
  let current = true
  const channel = devicePeerChannel(socket as unknown as WebSocket, {
    role: 'devices', side: 'gateway', epoch: 'original', budgets, current: () => current, receive, failed, gone,
  })
  return { channel, socket, failed, gone, budgets, replace: () => { current = false; channel.close() } }
}
afterEach(() => vi.useRealTimers())

describe('device peer physical admission', () => {
  it('keeps a replaced socket’s queued write charged until its callback or actual close, exactly once', () => {
    const first = fixture()
    const second = fixture(first.budgets)
    expect(first.channel.send('x'.repeat(DEVICE_PEER_MESSAGE_BYTES))).toBe('sent')
    first.replace()
    expect(first.budgets.outgoing.snapshot()).toEqual({ bytes: DEVICE_PEER_MESSAGE_BYTES, frames: 1 })
    expect(second.channel.send('{}')).toBe('backpressure')
    expect(second.socket.send).not.toHaveBeenCalled()
    first.socket.callbacks[0]!()
    first.socket.physicallyClose()
    expect(first.budgets.outgoing.snapshot()).toEqual({ bytes: 0, frames: 0 })
    second.socket.physicallyClose()
  })

  it('keeps incoming work charged after close until the actual async handler settles', async () => {
    let finish!: () => void
    const pending = new Promise<void>(resolve => { finish = resolve })
    const receive = vi.fn(() => pending)
    const first = fixture(undefined, receive)
    const message = { type: 'ready', epoch: 'original' }
    first.socket.message(message)
    first.replace(); first.socket.physicallyClose()
    expect(first.budgets.incoming.snapshot()).toEqual({ bytes: Buffer.byteLength(JSON.stringify(message)), frames: 1 })
    finish()
    await pending
    // The observer's real handler chain must settle; no timer represents settlement.
    await Promise.resolve(); await Promise.resolve()
    expect(first.budgets.incoming.snapshot()).toEqual({ bytes: 0, frames: 0 })
    expect(receive).toHaveBeenCalledOnce()
  })

  it('rejects raw oversize before parsing or dispatching', () => {
    const receive = vi.fn(), f = fixture(undefined, receive)
    f.socket.emit('message', Buffer.alloc(DEVICE_PEER_MESSAGE_BYTES + 1, 123), false)
    expect(receive).not.toHaveBeenCalled()
    expect(f.failed).toHaveBeenCalledWith('PEER_FRAME_OVERSIZED')
    expect(f.budgets.incoming.snapshot()).toEqual({ bytes: 0, frames: 0 })
    f.socket.physicallyClose()
  })

  it('limits unsettled incoming frame count across replacements before dispatching the next one', async () => {
    let finish!: () => void
    const pending = new Promise<void>(resolve => { finish = resolve })
    const first = fixture(undefined, () => pending)
    for (let n = 0; n < 256; n++) first.socket.message({ type: 'ready', epoch: 'original' })
    first.replace(); first.socket.physicallyClose()
    const receive = vi.fn(), second = fixture(first.budgets, receive)
    second.socket.message({ type: 'ready', epoch: 'original' })
    expect(receive).not.toHaveBeenCalled()
    expect(second.failed).toHaveBeenCalledWith('PEER_READ_BACKPRESSURE')
    finish(); await pending; await Promise.resolve(); await Promise.resolve()
    expect(first.budgets.incoming.snapshot()).toEqual({ bytes: 0, frames: 0 })
    second.socket.physicallyClose()
  })

  it('refuses stale peer epochs and invalid role messages before business handling', () => {
    const receive = vi.fn(), f = fixture(undefined, receive)
    f.socket.message({ type: 'ready', epoch: 'replacement' })
    expect(receive).not.toHaveBeenCalled()
    expect(f.failed).toHaveBeenCalledWith('PEER_PROTOCOL_INVALID')
    f.socket.physicallyClose()
  })

  it('does not free write bytes merely because the drain deadline fired', () => {
    vi.useFakeTimers()
    const f = fixture()
    f.channel.send('{}')
    vi.advanceTimersByTime(DEVICE_PEER_DRAIN_MS)
    expect(f.failed).toHaveBeenCalledWith('PEER_DRAIN_DEADLINE')
    expect(f.budgets.outgoing.snapshot()).toEqual({ bytes: 2, frames: 1 })
    f.socket.physicallyClose()
    expect(f.budgets.outgoing.snapshot()).toEqual({ bytes: 0, frames: 0 })
    f.socket.callbacks[0]!()
    expect(f.budgets.outgoing.snapshot()).toEqual({ bytes: 0, frames: 0 })
  })
})
