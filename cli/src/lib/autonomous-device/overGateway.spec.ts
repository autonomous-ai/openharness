import { EventEmitter } from 'node:events'
import { WebSocket } from 'ws'
import { describe, expect, it, vi } from 'vitest'
import { devicePeerConnection } from './peerConnection.js'
import { deviceRelayOverGateway } from './overGateway.js'
import { AutonomousDeviceService } from './service.js'

vi.mock('./peerConnection.js', () => ({ devicePeerConnection: vi.fn() }))
class Socket extends EventEmitter {
  readyState: number = WebSocket.OPEN
  bufferedAmount = 0
  sent: any[] = []
  callbacks: Array<(error?: Error) => void> = []
  terminate = vi.fn()
  send(wire: string, callback: (error?: Error) => void) {
    const frame = JSON.parse(wire)
    this.sent.push(frame); this.callbacks.push(callback); this.emit('write', frame)
  }
  message(frame: unknown) { this.emit('message', Buffer.from(JSON.stringify(frame)), false) }
  close() { this.readyState = WebSocket.CLOSED; this.emit('close') }
  written(predicate: (frame: any) => boolean): Promise<void> {
    if (this.sent.some(predicate)) return Promise.resolve()
    return new Promise(resolve => {
      const listener = (frame: any) => { if (predicate(frame)) { this.off('write', listener); resolve() } }
      this.on('write', listener)
    })
  }
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
function fixture(beforeReady: () => Promise<void> = async () => {}) {
  let connector!: Parameters<typeof devicePeerConnection>[0], generation = 0, live = false, writable = true
  vi.mocked(devicePeerConnection).mockImplementation(options => {
    connector = options
    return { start: () => { live = true }, stop: async () => { live = false; generation++ } }
  })
  const failed = vi.fn(), changed = vi.fn(), card = vi.fn(async () => {})
  const service = new AutonomousDeviceService({ machineId: 'machine', agents: () => [], submit: () => {},
    cancelDelivery: () => true, stop: async () => true, answer: async () => true, recent: () => [] })
  const relay = deviceRelayOverGateway({ dataDir: '/unused', port: 23456, key: Buffer.alloc(32), service, machineId: 'machine',
    beforeReady, beforeRequest: async () => {}, maySend: () => writable, clientChanged: changed, failed, card } as Parameters<typeof deviceRelayOverGateway>[0])
  relay.start()
  const open = () => {
    const socket = new Socket(), own = ++generation
    connector.connected(socket as unknown as WebSocket, () => live && generation === own)
    return socket
  }
  const socket = open()
  const held = { connId: 'connection', identity: 'owner', incarnation: 'session', direct: true, hello: false }
  const snapshot = (target = socket, epoch = 'peer', hello = false) => target.message({ type: 'snapshot', epoch, machineId: 'machine', sessions: [{ ...held, hello }] })
  const request = (body: Record<string, unknown>, target = socket, epoch = 'peer') => target.message({ type: 'request', epoch,
    connId: held.connId, identity: held.identity, incarnation: held.incarnation, opened: { payload: body } })
  const stop = async () => { await relay.stop(); socket.close() }
  return { relay, service, socket, open, held, snapshot, request, failed, changed, card, stop,
    block: () => { writable = false }, unblock: () => { writable = true; relay.drain() } }
}

describe('devices use the authenticated gateway peer directly', () => {
  it('holds a peer summary through its asynchronous component barrier and refuses its replaced generation', async () => {
    const f = fixture(), waiting = deferred()
    f.card.mockImplementationOnce(async (_frame?: unknown, _text?: unknown, current?: () => boolean) => {
      await waiting.promise
      expect(current?.()).toBe(false)
    })
    f.snapshot(); await f.socket.written(frame => frame.type === 'ready')
    const frame = { type: 'commander_event', agentId: 'agent', dbSessionId: 'session', payload: { kind: 'summary', text: 'short' } }
    f.socket.message({ type: 'recap', epoch: 'peer', frame, fullText: 'complete' })
    expect(f.card).toHaveBeenCalledWith(frame, 'complete', expect.any(Function))
    f.open()
    waiting.resolve()
    await f.stop()
  })
  it.each(['drop', 'session', 'revoked'])('tears down a pending restored question audience when its last route leaves by %s', async kind => {
    const observation = deferred(), f = fixture(() => observation.promise)
    f.snapshot(f.socket, 'peer', true)
    expect(f.relay.connected()).toBe(true)
    f.changed.mockClear()
    f.socket.message(kind === 'drop' ? { type: kind, epoch: 'peer', connId: f.held.connId, incarnation: f.held.incarnation }
      : kind === 'session' ? { type: kind, epoch: 'peer', session: { ...f.held, incarnation: 'replacement', hello: false } }
        : { type: kind, epoch: 'peer', identity: f.held.identity })
    expect(f.relay.connected()).toBe(false)
    expect(f.changed).toHaveBeenCalled()
    observation.resolve()
    await f.socket.written(frame => frame.type === 'ready')
    expect(f.socket.sent.filter(frame => frame.type === 'hello' || frame.type === 'send')).toEqual([])
    await f.stop()
  })

  it('retains the pending question audience while another snapshot hello remains', async () => {
    const observation = deferred(), f = fixture(() => observation.promise)
    f.socket.message({ type: 'snapshot', epoch: 'peer', machineId: 'machine', sessions: [
      { ...f.held, hello: true }, { ...f.held, connId: 'other', hello: true },
    ] })
    f.socket.message({ type: 'drop', epoch: 'peer', connId: f.held.connId, incarnation: f.held.incarnation })
    expect(f.relay.connected()).toBe(true)
    expect(f.changed).toHaveBeenCalled()
    observation.resolve()
    await f.socket.written(frame => frame.type === 'ready')
    expect(f.socket.sent.filter(frame => frame.type === 'hello').map(frame => frame.connId)).toEqual(['other'])
    await f.stop()
  })

  it('serves typed opened requests and restores the same encrypted session after peer loss', async () => {
    const f = fixture()
    f.snapshot(); await f.socket.written(frame => frame.type === 'ready')
    f.request({ type: 'hello', requestId: 'first', proto: 1 })
    await f.socket.written(frame => frame.type === 'joined')
    expect(f.socket.sent.filter(frame => frame.type === 'send').map(frame => frame.payload.type)).toEqual(['hello_result', 'resync'])
    expect(f.relay.directSessions()).toBe(1)
    f.socket.close()
    expect(f.relay.connected()).toBe(false)
    const next = f.open()
    f.snapshot(next, 'replacement', true)
    await next.written(frame => frame.type === 'ready')
    f.request({ type: 'agents.list', requestId: 'after-restart' }, next, 'replacement')
    await next.written(frame => frame.payload?.requestId === 'after-restart')
    expect(next.sent.find(frame => frame.payload?.requestId === 'after-restart')?.payload.type).toBe('agents.list_result')
    expect(f.relay.directSessions()).toBe(1)
    expect(f.failed).not.toHaveBeenCalled()
    await f.stop(); next.close()
  })

  it('does not announce readiness when an old initial question snapshot settles after stop', async () => {
    const observation = deferred(), f = fixture(() => observation.promise)
    f.snapshot(f.socket, 'peer', true)
    await f.stop()
    observation.resolve(); await observation.promise; await Promise.resolve()
    expect(f.socket.sent).toEqual([])
    expect(f.relay.connected()).toBe(false)
  })

  it('holds direct replies behind the current applied-state barrier without another queue', async () => {
    const f = fixture()
    f.snapshot(); await f.socket.written(frame => frame.type === 'ready')
    f.block()
    f.request({ type: 'hello', requestId: 'gated', proto: 1 })
    await Promise.resolve(); await Promise.resolve()
    expect(f.socket.sent).toEqual([{ type: 'ready', epoch: 'peer' }])
    f.unblock()
    await f.socket.written(frame => frame.type === 'joined')
    expect(f.socket.sent.filter(frame => frame.type === 'send').map(frame => frame.payload.type)).toEqual(['hello_result', 'resync'])
    await f.stop()
  })

  it('refuses a request before snapshot readiness and never calls business handlers for a mismatched proof', async () => {
    const observation = deferred(), f = fixture(() => observation.promise)
    const handle = vi.spyOn(f.service, 'request')
    f.snapshot(f.socket, 'peer', true)
    f.request({ type: 'agents.list', requestId: 'too-early' })
    expect(f.failed).toHaveBeenCalledWith('PEER_PROTOCOL_INVALID')
    expect(handle).not.toHaveBeenCalled()
    observation.resolve(); await observation.promise
    await f.stop()
  })
})
