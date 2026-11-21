import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WebSocket } from 'ws'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { connectDevicePeer, devicePeerKey, devicePeerRecord, openDevicePeerEndpoint, readDevicePeerEndpoint } from './peerEndpoint.js'
import { devicePeerBudgets, devicePeerChannel } from './peerChannel.js'
import { pipeWebSocket } from '../windows/pipeClient.js'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); cleanups.length = 0 })
function directory() {
  const dataDir = mkdtempSync(join(tmpdir(), 'peer-'))
  cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }))
  return { dataDir, port: 32581 }
}
async function listener(location = directory(), key: Buffer = randomBytes(32)) {
  const connected = vi.fn(), failed = vi.fn()
  const endpoint = await openDevicePeerEndpoint({ ...location, key, connected, failed, current: () => true })
  expect(endpoint).not.toBeNull()
  cleanups.push(() => endpoint!.close())
  return { ...location, endpoint: endpoint!, key, connected, failed }
}
async function connect(f: Awaited<ReturnType<typeof listener>>, key: Buffer = f.key) {
  const peer = connectDevicePeer({ ...f, key, role: 'devices' })!
  expect(peer).not.toBeNull()
  cleanups.push(() => { peer.socket.terminate() })
  await once(peer.socket, 'open')
  return peer.socket
}

describe('fixed authenticated device endpoint', () => {
  it('uses the same explicit inline authority at both component constructions', async () => {
    const gatewayKey = devicePeerKey('inline', { HARNESS_NO_MASTER: '1' })!
    const deviceKey = devicePeerKey('inline', { HARNESS_NO_MASTER: '1' })!
    expect(gatewayKey).toEqual(deviceKey)
    expect(gatewayKey).not.toBe(deviceKey)
    const f = await listener(directory(), gatewayKey)
    const socket = await connect(f, deviceKey)
    expect(socket.readyState).toBe(socket.OPEN)
    expect(f.connected).toHaveBeenCalledWith('devices', expect.anything(), expect.stringMatching(/^[0-9a-f]{32}$/))
    expect(f.connected.mock.calls[0]![2]).not.toBe(f.endpoint.epoch)
    expect(f.failed).not.toHaveBeenCalled()
  })

  it('does not publish or dial a fallback when a mixed or supervised composition lacks its key', async () => {
    const location = directory(), failed = vi.fn(), connected = vi.fn()
    for (const env of [
      { HARNESSD_SUPERVISED: '1', HARNESSD_SERVICES: 'none' },
      { HARNESSD_SERVICES: 'devices' },
      { HARNESSD_SERVICE_PROCESSES: 'gateway' },
    ]) {
      const key = devicePeerKey('inline', env)
      expect(key).toBeNull()
      expect(await openDevicePeerEndpoint({ ...location, key, failed, connected, current: () => true })).toBeNull()
      expect(connectDevicePeer({ ...location, key, role: 'devices', failed })).toBeNull()
    }
    expect(devicePeerKey('services', {})).toBeNull()
    expect(existsSync(devicePeerRecord(location.dataDir, location.port))).toBe(false)
    expect(connected).not.toHaveBeenCalled()
    expect(failed.mock.calls.every(([code]) => code === 'PEER_AUTH_UNAVAILABLE')).toBe(true)
  })

  it('admits no wrong-key socket to the component and exposes an auth failure', async () => {
    const f = await listener()
    const peer = connectDevicePeer({ ...f, key: randomBytes(32), role: 'devices' })!
    const result = await new Promise<string>(resolve => {
      peer.socket.once('open', () => resolve('opened'))
      peer.socket.once('error', () => resolve('refused'))
    })
    expect(result).toBe('refused')
    expect(f.connected).not.toHaveBeenCalled()
    expect(f.failed).toHaveBeenCalledWith('PEER_AUTH_REFUSED')
  })

  it('replaces the logical role and physically closes the old socket', async () => {
    const f = await listener()
    const first = await connect(f)
    const closed = once(first, 'close')
    const second = await connect(f)
    await closed
    expect(first.readyState).toBe(first.CLOSED)
    expect(second.readyState).toBe(second.OPEN)
    expect(f.connected).toHaveBeenCalledTimes(2)
    expect(f.connected.mock.calls[0]![2]).not.toBe(f.connected.mock.calls[1]![2])
  })

  it('closes physical sockets before removing its endpoint files', async () => {
    const f = await listener()
    const socket = await connect(f)
    const serverSocket = f.connected.mock.calls[0]![1] as WebSocket
    const record = readDevicePeerEndpoint(f.dataDir, f.port)!
    const closed = once(socket, 'close')
    await f.endpoint.close()
    await closed
    expect(serverSocket.readyState).toBe(serverSocket.CLOSED)
    expect(existsSync(devicePeerRecord(f.dataDir, f.port))).toBe(false)
    if (process.platform !== 'win32') expect(existsSync(record.endpoint)).toBe(false)
  })

  it('leaves a replacement record owned by another endpoint in place', async () => {
    const first = await listener()
    const second = await listener({ dataDir: first.dataDir, port: first.port }, first.key)
    await first.endpoint.close()
    expect(readDevicePeerEndpoint(first.dataDir, first.port)?.epoch).toBe(second.endpoint.epoch)
    await connect(second)
  })

  it('refuses an oversized or redirected discovery record before dialing', async () => {
    const f = await listener()
    const record = devicePeerRecord(f.dataDir, f.port)
    writeFileSync(record, ' '.repeat(4097), { mode: 0o600 })
    expect(readDevicePeerEndpoint(f.dataDir, f.port)).toBeNull()
    writeFileSync(record, JSON.stringify({ version: 1, epoch: f.endpoint.epoch, endpoint: '/tmp/another-socket' }), { mode: 0o600 })
    expect(connectDevicePeer({ ...f, role: 'devices' })).toBeNull()
    expect(f.failed).toHaveBeenCalledWith('PEER_ENDPOINT_INVALID')
    expect(f.connected).not.toHaveBeenCalled()
  })

  it('uses physical-close ownership when publication fails after an authenticated upgrade', async () => {
    const location = directory(), key = randomBytes(32), failed = vi.fn(), budgets = devicePeerBudgets()
    let connected: WebSocket | undefined, client: WebSocket | undefined, path: string | undefined
    const endpoint = await openDevicePeerEndpoint({ ...location, key, failed, current: () => true,
      connected: (_role, socket, epoch) => {
        connected = socket
        cleanups.push(() => { socket.terminate() })
        // Hold write completion past the publication failure: only physical close can return this credit.
        vi.spyOn(socket, 'send').mockImplementation(() => {})
        const channel = devicePeerChannel(socket, { role: 'devices', side: 'gateway', epoch, budgets,
          current: () => true, receive: () => {}, failed: () => {}, gone: () => {} })
        channel.send('{}')
      },
      publish: async record => {
        path = record.endpoint
        client = pipeWebSocket({ pipe: path, token: key }, '/device-peer/v1/devices')
        cleanups.push(() => { client?.terminate() })
        await once(client, 'open')
        expect(budgets.outgoing.snapshot()).toEqual({ bytes: 2, frames: 1 })
        throw new Error('injected publication failure')
      },
    })
    expect(endpoint).toBeNull()
    expect(connected?.readyState).toBe(3)
    expect(budgets.outgoing.snapshot()).toEqual({ bytes: 0, frames: 0 })
    expect(existsSync(devicePeerRecord(location.dataDir, location.port))).toBe(false)
    if (process.platform !== 'win32') expect(existsSync(path!)).toBe(false)
    client?.terminate()
    expect(failed).toHaveBeenCalledWith('PEER_ENDPOINT_INVALID')
  })

  it('removes a construction whose gateway instance was replaced while publication awaited', async () => {
    const location = directory(), key = randomBytes(32), failed = vi.fn()
    let current = true
    const endpoint = await openDevicePeerEndpoint({ ...location, key, failed, current: () => current,
      connected: () => {}, publish: async (_record, write) => { write(); current = false },
    })
    expect(endpoint).toBeNull()
    expect(existsSync(devicePeerRecord(location.dataDir, location.port))).toBe(false)
    expect(failed).toHaveBeenCalledWith('PEER_UNAVAILABLE')
  })
})
