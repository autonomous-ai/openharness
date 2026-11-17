import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { runServiceProcess, type ServiceProcess, type ServiceProcessOptions } from './process.js'

class Socket extends EventEmitter {
  readyState: number = WebSocket.CONNECTING
  sent: unknown[] = []
  terminated = false
  send(text: string): void { this.sent.push(JSON.parse(text)) }
  open(): void { this.readyState = WebSocket.OPEN; this.emit('open') }
  say(frame: unknown): void { this.emit('message', Buffer.from(JSON.stringify(frame)), false) }
  close(): void { this.readyState = WebSocket.CLOSED; this.emit('close', 1000) }
  terminate(): void { this.terminated = true; this.close() }
}
const asWs = (socket: Socket): WebSocket => socket as unknown as WebSocket
const held = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

describe('service connection ownership', () => {
  let services: ServiceProcess[]
  let lines: string[]
  const run = (connect: unknown, overrides: Partial<ServiceProcessOptions> = {}) => {
    const service = runServiceProcess({
      name: 'search', socketPath: '/private/daemon.sock', machineId: 'machine', token: 'boot-token',
      requests: {}, env: {}, log: (line) => lines.push(line),
      connect: connect as ServiceProcessOptions['connect'], initialBackoffMs: 100, maxBackoffMs: 400,
      ...overrides,
    })
    services.push(service)
    return service
  }
  beforeEach(() => { vi.useFakeTimers(); services = []; lines = [] })
  afterEach(() => { for (const service of services) service.stop(); vi.useRealTimers() })

  it('waits for endpoint discovery and sends its service token only after the discovered socket opens', async () => {
    const discovery = held<WebSocket>(), socket = new Socket(), connected = vi.fn()
    run(() => discovery.promise, { onConnected: connected })
    discovery.resolve(asWs(socket))
    await vi.advanceTimersByTimeAsync(0)
    expect(socket.sent).toEqual([])
    socket.open()
    expect(socket.sent).toEqual([{ type: 'machine_select', payload: {
      machineId: 'machine', localProtocolVersion: 1, role: 'service', service: 'search', token: 'boot-token',
    } }])
    socket.say({ type: 'connected' })
    expect(connected).toHaveBeenCalledOnce()
  })

  it('aborts a stopped discovery and destroys a late socket without registering or retrying', async () => {
    const discovery = held<WebSocket>(), socket = new Socket()
    let signal: AbortSignal | undefined
    const connect = vi.fn((_url: string, given: AbortSignal) => { signal = given; return discovery.promise })
    const service = run(connect)
    service.stop()
    expect(signal?.aborted).toBe(true)
    discovery.resolve(asWs(socket))
    await vi.advanceTimersByTimeAsync(0)
    socket.open()
    expect(socket.terminated).toBe(true)
    expect(socket.sent).toEqual([])
    await vi.advanceTimersByTimeAsync(20_000)
    expect(connect).toHaveBeenCalledOnce()
  })

  it('bounds registration even when the peer accepts the WebSocket and never welcomes the service', async () => {
    const sockets: Socket[] = []
    const service = run(() => { const socket = new Socket(); sockets.push(socket); return asWs(socket) })
    sockets[0]!.open()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(sockets[0]!.terminated).toBe(true)
    expect(lines).toContain('[service search] SERVICE_CONNECT_TIMEOUT')
    await vi.advanceTimersByTimeAsync(100)
    expect(sockets).toHaveLength(2)
    service.stop()
  })

  it('leaves no connection deadline after repeated welcomes on a registered socket', async () => {
    const socket = new Socket(), connect = vi.fn(() => asWs(socket))
    run(connect)
    socket.open()
    socket.say({ type: 'connected' })
    socket.say({ type: 'connected' })
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(socket.terminated).toBe(false)
    expect(connect).toHaveBeenCalledOnce()
  })

  it('settles a cancelled discovery whose socket had already closed without reopening it', async () => {
    const discovery = held<WebSocket>(), socket = new Socket(), connect = vi.fn(() => discovery.promise)
    const service = run(connect)
    service.stop()
    socket.close()
    discovery.resolve(asWs(socket))
    await vi.advanceTimersByTimeAsync(0)
    expect(socket.terminated).toBe(false)
    expect(socket.sent).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
    expect(connect).toHaveBeenCalledOnce()
  })

  it('does not admit another discovery until a timed-out lookup actually settles', async () => {
    const discovery = held<WebSocket>(), socket = new Socket()
    let signal: AbortSignal | undefined
    const connect = vi.fn((_url: string, given: AbortSignal) => { signal = given; return discovery.promise })
    run(connect)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(signal?.aborted).toBe(true)
    expect(connect).toHaveBeenCalledOnce()
    discovery.resolve(asWs(socket))
    await vi.advanceTimersByTimeAsync(0)
    expect(socket.terminated).toBe(true)
    expect(socket.sent).toEqual([])
    await vi.advanceTimersByTimeAsync(100)
    expect(connect).toHaveBeenCalledTimes(2)
  })

  it('contains connector failures, names them without exposing the endpoint and backs off', async () => {
    const socket = new Socket()
    const connect = vi.fn()
      .mockImplementationOnce(() => { throw new Error('secret endpoint') })
      .mockRejectedValueOnce(new Error('secret token'))
      .mockReturnValue(asWs(socket))
    run(connect)
    await vi.advanceTimersByTimeAsync(100)
    expect(connect).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(200)
    expect(connect).toHaveBeenCalledTimes(3)
    expect(lines).toEqual(['[service search] SERVICE_CONNECT_UNAVAILABLE'])
    socket.open()
    socket.say({ type: 'connected' })
    expect(socket.sent).toHaveLength(1)
  })

  it('ignores an old socket after reconnect and does not answer its completed work on the new one', async () => {
    const sockets: Socket[] = [], reply = held<Record<string, unknown>>(), request = vi.fn(() => reply.promise)
    const events = vi.fn()
    run(() => { const socket = new Socket(); sockets.push(socket); return asWs(socket) }, {
      requests: { session_search: request }, onEvent: events,
    })
    const old = sockets[0]!
    old.open()
    old.say({ type: 'connected' })
    old.say({ type: 'session_search', payload: { requestId: 'old' } })
    await vi.advanceTimersByTimeAsync(0)
    expect(request).toHaveBeenCalledOnce()
    old.close()
    await vi.advanceTimersByTimeAsync(100)
    const current = sockets[1]!
    current.open()
    current.say({ type: 'connected' })
    old.open()
    old.say({ type: 'service_event', payload: { kind: 'old' } })
    old.close()
    reply.resolve({ hits: [] })
    await vi.advanceTimersByTimeAsync(0)
    expect(events).not.toHaveBeenCalled()
    expect(current.sent).toHaveLength(1)
    expect(old.sent).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(sockets).toHaveLength(2)
  })
})
