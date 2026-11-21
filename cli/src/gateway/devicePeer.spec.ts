import { EventEmitter } from 'node:events'
import { WebSocket } from 'ws'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { gatewayOf, relaySocket } from '../testing/relaySocket.js'
import { openDevicePeerEndpoint } from '../lib/autonomous-device/peerEndpoint.js'
import { DEVICE_PEER_FRAMES, DEVICE_PEER_HELD_BYTES, DEVICE_PEER_MESSAGE_BYTES, DEVICE_PEER_READY_MS } from '../lib/autonomous-device/peerProtocol.js'
import type { DevicePeerSession, DevicePeerRole } from '../lib/autonomous-device/peerProtocol.js'
import { startGatewayDevicePeer } from './devicePeer.js'

vi.mock('../lib/autonomous-device/peerEndpoint.js', () => ({ openDevicePeerEndpoint: vi.fn() }))
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.useRealTimers() })

class Socket extends EventEmitter {
  readyState: number = WebSocket.OPEN
  bufferedAmount = 0
  readonly sent: Array<Record<string, any>> = []
  readonly callbacks: Array<() => void> = []
  hold = false
  send(wire: string, done: () => void) { this.sent.push(JSON.parse(wire)); if (this.hold) this.callbacks.push(done); else done() }
  terminate() { if (this.readyState !== WebSocket.CLOSED) { this.readyState = WebSocket.CLOSED; this.emit('close') } }
  message(frame: Record<string, unknown>) { this.emit('message', Buffer.from(JSON.stringify(frame)), false) }
  settle() { for (const callback of this.callbacks.splice(0)) callback() }
}

function fixture() {
  const backend = relaySocket('machine'), gateway = gatewayOf(backend)
  cleanups.push(() => backend.stop())
  const sessions = new Map<string, DevicePeerSession>()
  vi.spyOn(gateway.e2ee, 'sessionRole').mockImplementation(id => sessions.has(id) ? 'device' : null)
  vi.spyOn(gateway.e2ee, 'sessionIdentity').mockImplementation(id => sessions.get(id)?.identity ?? null)
  vi.spyOn(gateway.e2ee, 'sessionIncarnation').mockImplementation(id => sessions.get(id)?.incarnation ?? null)
  vi.spyOn(gateway.e2ee, 'deviceSessions').mockImplementation(() => [...sessions.values()])
  const device = vi.spyOn(gateway, 'device').mockReturnValue(true)
  const close = vi.fn(async () => {}), wake = vi.fn(async () => true), ready = vi.fn(), unavailable = vi.fn(), failed = vi.fn()
  vi.mocked(openDevicePeerEndpoint).mockResolvedValue({ epoch: 'endpoint', close })
  const peer = startGatewayDevicePeer(gateway, { dataDir: '/fixture', port: 32581, key: Buffer.alloc(32), wake, ready, unavailable, failed })
  cleanups.push(() => peer.stop())
  const endpoint = vi.mocked(openDevicePeerEndpoint).mock.calls.at(-1)![0]
  let epoch = 0
  const connect = (role: DevicePeerRole, hold = false) => {
    const socket = new Socket(), ownEpoch = (++epoch).toString(16).padStart(32, '0')
    socket.hold = hold
    endpoint.connected(role, socket as unknown as WebSocket, ownEpoch)
    const message = (frame: Record<string, unknown>) => socket.message({ ...frame, epoch: ownEpoch })
    return { socket, epoch: ownEpoch, message }
  }
  const session = (connId: string, incarnation = `session:${connId}`) => {
    const proof = { identity: `identity:${connId}`, incarnation }
    const held = { ...proof, connId, direct: false, hello: false }
    sessions.set(connId, held); gateway.devicePeer!.session(held)
    return proof
  }
  const drop = (connId: string) => {
    const held = sessions.get(connId)!
    gateway.deviceClient(connId, held, false); sessions.delete(connId); gateway.devicePeer!.dropped(connId, held.incarnation)
  }
  return { gateway, peer, endpoint, sessions, device, wake, ready, unavailable, failed, connect, session, drop }
}

describe('gateway direct device peer', () => {
  it('forwards a recaps card only from the current recaps role to the current ready devices epoch', () => {
    const f = fixture(), devices = f.connect('devices'), recaps = f.connect('recaps')
    const frame = { type: 'commander_event', agentId: 'a', dbSessionId: 's', payload: { kind: 'summary', text: 'short' } }
    devices.message({ type: 'ready' })
    recaps.message({ type: 'recap', frame, fullText: 'complete' })
    expect(devices.socket.sent.at(-1)).toEqual({ type: 'recap', epoch: devices.epoch, frame, fullText: 'complete' })
    const next = f.connect('recaps')
    recaps.message({ type: 'recap', frame, fullText: 'old' })
    expect(devices.socket.sent.at(-1)).toMatchObject({ fullText: 'complete' })
    next.message({ type: 'ready' })
    expect(next.socket.readyState).toBe(WebSocket.CLOSED)
    devices.message({ type: 'recap', frame, fullText: 'forged' })
    expect(devices.socket.readyState).toBe(WebSocket.CLOSED)
  })
  it('keeps one actual wake across ready deadlines, replacement and stop until its handler settles', async () => {
    vi.useFakeTimers()
    const f = fixture()
    let finish!: (value: boolean) => void
    f.wake.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const first = f.peer.serving(), concurrent = f.peer.serving()
    expect(first).toBe(concurrent)
    await Promise.resolve()
    expect(f.wake).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(DEVICE_PEER_READY_MS)
    expect(await first).toBe(false)
    for (let n = 0; n < 20; n++) expect(await f.peer.serving()).toBe(false)
    expect(f.wake).toHaveBeenCalledOnce()
    const devices = f.connect('devices'); devices.message({ type: 'ready' })
    expect(await f.peer.serving()).toBe(true)
    devices.socket.terminate()
    expect(await f.peer.serving()).toBe(false)
    expect(f.wake).toHaveBeenCalledOnce()
    await f.peer.stop()
    finish(true); await vi.advanceTimersByTimeAsync(0)
    expect(await f.peer.serving()).toBe(false)
    expect(f.wake).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('holds a full-entry byte budget and transfers it once under an equal-length actual peer epoch', () => {
    const f = fixture(), proof = f.session('a')
    const payload = { type: 'turn.send', requestId: 'held', text: '' }
    const empty = { type: 'request', epoch: '0'.repeat(32), connId: 'a', ...proof, opened: { payload } }
    payload.text = 'x'.repeat(DEVICE_PEER_HELD_BYTES - Buffer.byteLength(JSON.stringify(empty)))
    f.gateway.devicePeer!.request('a', proof, { payload })
    expect(f.device).not.toHaveBeenCalled()
    f.gateway.devicePeer!.request('a', proof, { payload: { type: 'status', requestId: 'excess' } })
    expect(f.device).toHaveBeenLastCalledWith('a', 'autonomous_device_result', expect.objectContaining({ requestId: 'excess', error: expect.objectContaining({ code: 'BACKPRESSURE' }) }), expect.anything())
    const devices = f.connect('devices')
    expect(devices.epoch).toMatch(/^[0-9a-f]{32}$/)
    devices.message({ type: 'ready' })
    const requests = devices.socket.sent.filter(frame => frame.type === 'request')
    expect(requests).toHaveLength(1)
    expect(Buffer.byteLength(JSON.stringify(requests[0]))).toBe(DEVICE_PEER_HELD_BYTES)
    expect(requests[0].epoch).toBe(devices.epoch)
    devices.message({ type: 'ready' })
    expect(devices.socket.sent.filter(frame => frame.type === 'request')).toHaveLength(1)
  })

  it('refuses a ready-valid frame that cannot fit the smaller unavailable queue, then accepts it when ready', () => {
    const f = fixture(), proof = f.session('a')
    const payload = { type: 'turn.send', requestId: 'large', text: '' }
    const envelope = { type: 'request', epoch: '0'.repeat(32), connId: 'a', ...proof, opened: { payload } }
    payload.text = 'x'.repeat(DEVICE_PEER_HELD_BYTES + 1 - Buffer.byteLength(JSON.stringify(envelope)))
    f.gateway.devicePeer!.request('a', proof, { payload })
    expect(f.failed).toHaveBeenCalledWith('PEER_HELD_CAPACITY')
    expect(f.device).toHaveBeenCalledOnce()
    const devices = f.connect('devices'); devices.message({ type: 'ready' })
    expect(devices.socket.sent.filter(frame => frame.type === 'request')).toEqual([])
    f.gateway.devicePeer!.request('a', proof, { payload })
    expect(devices.socket.sent.filter(frame => frame.type === 'request')).toHaveLength(1)
  })

  it('bounds held records, coalesces wake, refuses them at the ready deadline and never sends stale identity work', async () => {
    vi.useFakeTimers()
    const f = fixture(), proof = f.session('a')
    for (let n = 0; n <= DEVICE_PEER_FRAMES; n++) f.gateway.devicePeer!.request('a', proof, { payload: { type: 'status', requestId: String(n) } })
    expect(f.failed).toHaveBeenCalledExactlyOnceWith('PEER_HELD_CAPACITY')
    await Promise.resolve()
    expect(f.wake).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(DEVICE_PEER_READY_MS)
    expect(f.device).toHaveBeenCalledTimes(DEVICE_PEER_FRAMES + 1)
    expect(f.failed).toHaveBeenCalledWith('PEER_READY_DEADLINE')
    expect(f.unavailable).toHaveBeenCalledOnce()
    f.gateway.devicePeer!.request('a', proof, { payload: { type: 'status', requestId: 'old' } })
    f.session('a', 'replacement')
    const devices = f.connect('devices'); devices.message({ type: 'ready' })
    expect(devices.socket.sent.filter(frame => frame.type === 'request')).toEqual([])
    expect(f.device.mock.calls.some(([, , body]) => body.requestId === 'old')).toBe(false)
  })

  it.each([false, true])('keeps join A when later join B leaves before handoff; both gone=%s', bothGone => {
    const f = fixture(), a = f.session('a'), b = f.session('b')
    const devices = f.connect('devices'); devices.message({ type: 'ready' })
    const recaps = f.connect('recaps', true)
    recaps.socket.bufferedAmount = DEVICE_PEER_MESSAGE_BYTES
    for (const [connId, proof] of [['a', a], ['b', b]] as const) {
      devices.message({ type: 'hello', connId, ...proof, hello: true })
      devices.message({ type: 'joined', connId, ...proof })
    }
    f.drop('b'); if (bothGone) f.drop('a')
    expect(f.gateway.deviceJoinsPending(devices.epoch)).toBe(!bothGone)
    recaps.socket.bufferedAmount = 0; recaps.socket.hold = false; recaps.socket.settle()
    expect(recaps.socket.sent.filter(frame => frame.joined)).toHaveLength(bothGone ? 0 : 1)
    expect(f.gateway.deviceJoinsPending(devices.epoch)).toBe(false)
    recaps.socket.settle()
    expect(recaps.socket.sent.filter(frame => frame.joined)).toHaveLength(bothGone ? 0 : 1)
  })

  it('replays the current audience on recaps restart and revokes old devices authority without stopping encrypted networking', () => {
    const f = fixture(), proof = f.session('a')
    const first = f.connect('devices'); first.message({ type: 'ready' })
    first.message({ type: 'hello', connId: 'a', ...proof, hello: true })
    first.message({ type: 'joined', connId: 'a', ...proof })
    const recaps = f.connect('recaps')
    expect(recaps.socket.sent).toMatchObject([{ watching: true, joined: true }])
    const nextRecaps = f.connect('recaps')
    expect(nextRecaps.socket.sent).toMatchObject([{ watching: true, joined: true }])
    first.socket.terminate()
    expect(f.unavailable).not.toHaveBeenCalled()
    expect(nextRecaps.socket.sent.at(-1)).toMatchObject({ watching: false, joined: false })
    const next = f.connect('devices')
    expect(next.socket.sent[0]).toMatchObject({ type: 'snapshot', sessions: [{ ...proof, hello: true }] })
    first.message({ type: 'send', connId: 'a', ...proof, frameType: 'autonomous_device_result', payload: { requestId: 'old' } })
    expect(f.device).not.toHaveBeenCalled()
    next.message({ type: 'ready' })
    expect(nextRecaps.socket.sent.at(-1)).toMatchObject({ watching: true, joined: false })
    expect(f.gateway.deviceJoinsPending(first.epoch)).toBe(false)
    next.message({ type: 'send', connId: 'a', ...proof, frameType: 'autonomous_device_result', payload: { requestId: 'new' } })
    expect(f.device).toHaveBeenCalledOnce()
  })
})
