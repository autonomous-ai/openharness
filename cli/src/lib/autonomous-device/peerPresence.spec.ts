import { EventEmitter } from 'node:events'
import { WebSocket } from 'ws'
import { describe, expect, it, vi } from 'vitest'
import { devicePeerConnection } from './peerConnection.js'
import { devicePeerPresence } from './peerPresence.js'

vi.mock('./peerConnection.js', () => ({ devicePeerConnection: vi.fn() }))
class Socket extends EventEmitter {
  readyState: number = WebSocket.OPEN
  bufferedAmount = 0
  terminate = vi.fn()
  message(epoch: string, watching: boolean, joined: boolean) {
    this.emit('message', Buffer.from(JSON.stringify({ type: 'presence', epoch, watching, joined })), false)
  }
  close() { this.readyState = WebSocket.CLOSED; this.emit('close') }
}

describe('recaps direct device presence lifetime', () => {
  it('starts once, stops its observer and re-enables without allowing an old peer to clear current presence', async () => {
    const start = vi.fn(), stop = vi.fn(async () => {}), changed = vi.fn(), failed = vi.fn()
    vi.mocked(devicePeerConnection).mockReturnValue({ start, stop })
    const presence = devicePeerPresence({ dataDir: '/fixture', port: 32581, key: Buffer.alloc(32), changed, failed })
    const connect = vi.mocked(devicePeerConnection).mock.calls.at(-1)![0].connected
    const first = new Socket(), next = new Socket()
    presence.start(); presence.start()
    expect(start).toHaveBeenCalledOnce()
    connect(first as unknown as WebSocket, () => true)
    first.message('first', true, true)
    expect(changed).toHaveBeenLastCalledWith(true, true)
    await presence.stop()
    expect(first.terminate).toHaveBeenCalledOnce()
    expect(stop).toHaveBeenCalledOnce()
    expect(changed).toHaveBeenLastCalledWith(false, false)
    presence.start()
    connect(next as unknown as WebSocket, () => true)
    next.message('next', true, true)
    changed.mockClear()
    first.message('first', false, false); first.close()
    expect(changed).not.toHaveBeenCalled()
    next.message('next', true, false)
    expect(changed).toHaveBeenCalledExactlyOnceWith(true, false)
    next.close()
    expect(changed).toHaveBeenLastCalledWith(false, false)
    await presence.stop()
    expect(start).toHaveBeenCalledTimes(2)
    expect(failed).not.toHaveBeenCalled()
  })

  it('rejects a replacement epoch before exposing presence and reports the named failure', async () => {
    vi.mocked(devicePeerConnection).mockReturnValue({ start: vi.fn(), stop: vi.fn(async () => {}) })
    const changed = vi.fn(), failed = vi.fn()
    const presence = devicePeerPresence({ dataDir: '/fixture', port: 32581, key: Buffer.alloc(32), changed, failed })
    presence.start()
    const socket = new Socket()
    vi.mocked(devicePeerConnection).mock.calls.at(-1)![0].connected(socket as unknown as WebSocket, () => true)
    socket.message('original', true, true)
    changed.mockClear()
    socket.message('replacement', true, true)
    expect(changed).toHaveBeenCalledExactlyOnceWith(false, false)
    expect(failed).toHaveBeenCalledExactlyOnceWith('PEER_PROTOCOL_INVALID')
    expect(socket.terminate).toHaveBeenCalledOnce()
    socket.close()
    await presence.stop()
  })
})
