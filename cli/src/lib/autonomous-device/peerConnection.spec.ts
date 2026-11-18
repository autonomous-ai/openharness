import { EventEmitter } from 'node:events'
import * as fs from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebSocket } from 'ws'
import * as endpoint from './peerEndpoint.js'
import { devicePeerConnection } from './peerConnection.js'

vi.mock('node:fs', async original => ({ ...await original<typeof fs>(), watch: vi.fn() }))
vi.mock('./peerEndpoint.js', async original => ({ ...await original<typeof endpoint>(), connectDevicePeer: vi.fn(), readDevicePeerEndpoint: vi.fn() }))
class Socket extends EventEmitter { terminate = vi.fn() }
class Watcher extends EventEmitter { close = vi.fn(); unref = vi.fn() }
beforeEach(() => { vi.useFakeTimers(); vi.mocked(fs.watch).mockReset(); vi.mocked(endpoint.connectDevicePeer).mockReset(); vi.mocked(endpoint.readDevicePeerEndpoint).mockReset() })
afterEach(() => { vi.useRealTimers() })

function fixture() {
  const watchers: Array<{ watcher: Watcher; changed: (event: string, name: string) => void }> = []
  vi.mocked(fs.watch).mockImplementation(((_dir: string, changed: (event: string, name: string) => void) => {
    const watcher = new Watcher(); watchers.push({ watcher, changed }); return watcher
  }) as unknown as typeof fs.watch)
  const sockets: Socket[] = [], connected = vi.fn(), failed = vi.fn()
  let epoch = 'first'
  vi.mocked(endpoint.readDevicePeerEndpoint).mockImplementation(() => ({ version: 1, epoch, endpoint: 'fixture' }))
  vi.mocked(endpoint.connectDevicePeer).mockImplementation(() => {
    const socket = new Socket(); sockets.push(socket); return { socket: socket as unknown as WebSocket, epoch }
  })
  const connection = devicePeerConnection({ dataDir: '/fixture', port: 32581, key: Buffer.alloc(32), role: 'devices', connected, failed })
  return { connection, sockets, watchers, connected, failed, replace: () => { epoch = 'replacement'; watchers.at(-1)!.changed('rename', 'gateway-device-32581.json') } }
}

describe('component peer connection lifetime', () => {
  it('never dials a replacement while the old physical socket is still closing, even after a stop deadline', async () => {
    const f = fixture()
    f.connection.start(); f.sockets[0]!.emit('open')
    const originalCurrent = f.connected.mock.calls[0]![1] as () => boolean
    const stopping = f.connection.stop()
    expect(originalCurrent()).toBe(false)
    await vi.advanceTimersByTimeAsync(2000); await stopping
    expect(f.failed).toHaveBeenCalledWith('PEER_DRAIN_DEADLINE')
    f.connection.start()
    expect(f.sockets).toHaveLength(1)
    f.sockets[0]!.emit('close')
    expect(f.sockets).toHaveLength(2)
    f.sockets[1]!.emit('close')
    await f.connection.stop()
    expect(vi.getTimerCount()).toBe(0)
    expect(f.watchers.every(({ watcher }) => watcher.close.mock.calls.length === 1)).toBe(true)
  })

  it('bounds reconnect attempts and resets them only for a new discovered endpoint', async () => {
    const f = fixture()
    vi.mocked(endpoint.connectDevicePeer).mockReturnValue(null)
    f.connection.start()
    for (const delay of [250, 500, 1000, 2000, 5000]) await vi.advanceTimersByTimeAsync(delay)
    expect(endpoint.connectDevicePeer).toHaveBeenCalledTimes(6)
    await vi.advanceTimersByTimeAsync(1_000_000)
    expect(endpoint.connectDevicePeer).toHaveBeenCalledTimes(6)
    f.replace()
    expect(endpoint.connectDevicePeer).toHaveBeenCalledTimes(7)
    await f.connection.stop()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('invalidates an old connection immediately on an endpoint generation change', async () => {
    const f = fixture()
    f.connection.start(); f.sockets[0]!.emit('open')
    const originalCurrent = f.connected.mock.calls[0]![1] as () => boolean
    f.replace()
    expect(originalCurrent()).toBe(false)
    expect(f.sockets[0]!.terminate).toHaveBeenCalledOnce()
    expect(f.sockets).toHaveLength(1)
    f.sockets[0]!.emit('close')
    expect(f.sockets).toHaveLength(2)
    const stopping = f.connection.stop(); f.sockets[1]!.emit('close'); await stopping
  })

  it('does not let an old watcher error close its replacement after restart', async () => {
    const f = fixture()
    f.connection.start()
    const stopping = f.connection.stop(); f.sockets[0]!.emit('close'); await stopping
    f.connection.start()
    f.watchers[0]!.watcher.emit('error', new Error('old watcher'))
    expect(f.watchers[1]!.watcher.close).not.toHaveBeenCalled()
    expect(f.failed).not.toHaveBeenCalled()
    const stopped = f.connection.stop(); f.sockets[1]!.emit('close'); await stopped
  })

  it('starts no watcher, retry or connection without the required authority', async () => {
    const f = fixture()
    const connection = devicePeerConnection({ dataDir: '/fixture', port: 32581, key: null, role: 'devices', connected: f.connected, failed: f.failed })
    connection.start()
    expect(f.watchers).toHaveLength(0)
    expect(endpoint.connectDevicePeer).not.toHaveBeenCalled()
    expect(f.failed).toHaveBeenCalledWith('PEER_AUTH_UNAVAILABLE')
    await connection.stop()
    expect(vi.getTimerCount()).toBe(0)
  })
})
