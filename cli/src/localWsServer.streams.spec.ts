import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import type { LocalClientSink } from './backendSocket.js'
import { attachLocalWsServer, type LocalWsServer } from './localWsServer.js'
import { CLIENT_STREAM_QUEUE_BYTES as LIMIT } from './lib/clientStreamContract.js'
import { CLIENT_STREAMS } from './lib/clientStreamContract.js'
import { createClientStreams } from './core/clientStreams.js'
import { createServiceClientStreams } from './services/clientStreams.js'
import { encodeTerminalLocal } from './lib/terminalBinary.js'

const clients: WebSocket[] = []
let local: LocalWsServer | undefined, server: http.Server | undefined
afterEach(async () => {
  vi.restoreAllMocks()
  for (const client of clients.splice(0)) client.terminate()
  await local?.close()
  await new Promise<void>(resolve => server?.close(() => resolve()) ?? resolve())
  local = undefined; server = undefined
})

async function setup(onServiceClosed?: (service: string) => void) {
  const sinks: LocalClientSink[] = [], services = new Map<string, LocalClientSink>(), closed = new Map<string, ReturnType<typeof vi.fn>>()
  server = http.createServer()
  local = attachLocalWsServer(server, { machineId: 'fixture', backend: {
    registerLocalClient: (_id, sink) => { sinks.push(sink); return true }, unregisterLocalClient: async () => {},
    handleLocalFrame: () => {}, handleLocalBinary: async () => {},
  }, services: { accept: (service, token, sink, _close, welcome) => {
    if (token !== 'fixture-token') return null
    services.set(service, sink)
    const ended = vi.fn(() => onServiceClosed?.(service)); closed.set(service, ended)
    welcome()
    return { receive: () => {}, receiveBinary: () => {}, closed: ended }
  } } })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/local-ws`
  const connect = async (service?: string): Promise<WebSocket> => {
    const ws = new WebSocket(url); clients.push(ws)
    await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
    const ready = new Promise<void>((resolve, reject) => { ws.once('message', () => resolve()); ws.once('error', reject) })
    ws.send(JSON.stringify({ type: 'machine_select', payload: { machineId: 'fixture', localProtocolVersion: 1,
      ...(service ? { role: 'service', service, token: 'fixture-token' } : {}) } }))
    await ready
    return ws
  }
  return { sinks, services, closed, connect }
}

function holdWrites() {
  const callbacks: Array<(error?: Error) => void> = [], sent: unknown[] = [], sockets: WebSocket[] = []
  const spy = vi.spyOn(WebSocket.prototype, 'send').mockImplementation(function(this: WebSocket, ...args: unknown[]) {
    sockets.push(this); sent.push(args[0])
    const callback = args.at(-1)
    if (typeof callback === 'function') callbacks.push(callback as (error?: Error) => void)
  })
  return { callbacks, sent, sockets, spy }
}
const quota = { service: 'agentBrowser', direction: 'client' } as const
const chunk = new Uint8Array(LIMIT / 8)

describe('stream quotas at actual WebSocket acceptance', () => {
  it('bounds actual tiny-frame callbacks before byte exhaustion and recovers on physical completion', async () => {
    const x = await setup(); await x.connect(); await x.connect()
    const writes = holdWrites(), first = x.sinks[0]!, second = x.sinks[1]!
    const frame = encodeTerminalLocal({ kind: 8, streamId: '00000000-0000-4000-8000-000000000001', seq: 0, compressed: false, bytes: new Uint8Array() })!
    expect(frame.length).toBe(36)
    for (let index = 0; index < 4096; index++) expect(first.sendBinary(frame, quota)).toBe(true)
    expect(second.sendBinary(frame, quota)).toBe(false)
    expect(writes.callbacks).toHaveLength(4096)
    expect(second.sendBinary(frame, { service: 'viewers', direction: 'client' })).toBe(true)
    writes.callbacks[0]!(); writes.callbacks[0]!()
    expect(second.sendBinary(frame, quota)).toBe(true)
    expect(second.sendBinary(frame, quota)).toBe(false)
  })

  it('counts serialized UTF-8 bytes, releases a callback once, and keeps service shares independent', async () => {
    const x = await setup(); await x.connect(); await x.connect()
    const writes = holdWrites(), first = x.sinks[0]!, other = x.sinks[1]!
    const frame = { type: 'viewer_data', payload: { data: 'é'.repeat(1000) } }
    const encoded = JSON.stringify(frame), size = Buffer.byteLength(encoded)
    expect(first.sendFrame(frame, quota)).toBe(true)
    expect(writes.sent[0]).toBe(encoded)
    expect(other.sendBinary(new Uint8Array(LIMIT - size), quota)).toBe(true)
    expect(first.sendBinary(Uint8Array.of(1), quota)).toBe(false)
    expect(other.sendBinary(chunk, { service: 'viewers', direction: 'client' })).toBe(true)
    expect(other.sendBinary(chunk, { service: 'agentBrowser', direction: 'service' })).toBe(true)
    writes.callbacks[0]!(); writes.callbacks[0]!()
    expect(first.sendBinary(new Uint8Array(size), quota)).toBe(true)
    expect(first.sendBinary(Uint8Array.of(1), quota)).toBe(false)
  })

  it('does not credit a replacement before old physical close, or from an old late callback', async () => {
    const x = await setup(); const old = await x.connect(); await x.connect()
    const writes = holdWrites(), first = x.sinks[0]!, replacement = x.sinks[1]!
    for (let index = 0; index < 8; index++) expect(first.sendBinary(chunk, quota)).toBe(true)
    expect(replacement.sendBinary(Uint8Array.of(1), quota)).toBe(false)
    const ended = new Promise<void>(resolve => old.once('close', () => resolve()))
    const physical = new Promise<void>(resolve => writes.sockets[0]!.once('close', () => resolve()))
    old.close(); await Promise.all([ended, physical])
    for (let index = 0; index < 8; index++) expect(replacement.sendBinary(chunk, quota)).toBe(true)
    for (const callback of writes.callbacks.slice(0, 8)) { callback(); callback() }
    expect(replacement.sendBinary(Uint8Array.of(1), quota)).toBe(false)
  })

  it('closes only the client whose final close cannot be queued', async () => {
    const x = await setup(), first = await x.connect(), other = await x.connect()
    holdWrites()
    for (let index = 0; index < 8; index++) expect(x.sinks[0]!.sendBinary(chunk, quota)).toBe(true)
    expect(x.sinks[0]!.sendBinary(Uint8Array.of(1), quota)).toBe(false)
    expect(first.readyState).toBe(WebSocket.OPEN)
    const ended = new Promise<number>(resolve => first.once('close', code => resolve(code)))
    expect(x.sinks[0]!.sendFrame({ type: 'agent_browser_close', payload: {} }, { ...quota, final: true })).toBe(false)
    await expect(ended).resolves.toBe(1013)
    expect(other.readyState).toBe(WebSocket.OPEN)
    expect(x.sinks[1]!.sendBinary(chunk, { service: 'viewers', direction: 'client' })).toBe(true)
  })

  it.each(['open', 'data', 'close'])('revokes only the saturated service connection on a refused %s', async kind => {
    const x = await setup(), browser = await x.connect('agentBrowser'), viewers = await x.connect('viewers')
    const writes = holdWrites(), sink = x.services.get('agentBrowser')!
    const tag = { service: 'agentBrowser', direction: 'service' } as const
    for (let index = 0; index < 8; index++) expect(sink.sendBinary(chunk, tag)).toBe(true)
    const ended = new Promise<number>(resolve => browser.once('close', code => resolve(code)))
    expect(sink.sendFrame({ type: 'service_event', payload: { kind: 'client_stream', type: kind } }, tag)).toBe(false)
    expect(x.closed.get('agentBrowser')).toHaveBeenCalledOnce()
    expect(x.closed.get('viewers')).not.toHaveBeenCalled()
    expect(x.services.get('viewers')!.sendBinary(chunk, { service: 'viewers', direction: 'service' })).toBe(true)
    await expect(ended).resolves.toBe(1013)
    for (const callback of writes.callbacks.slice(0, 8)) callback()
    expect(x.closed.get('agentBrowser')).toHaveBeenCalledOnce()
    expect(viewers.readyState).toBe(WebSocket.OPEN)
  })

  it('releases a synchronous send failure, and a callback error closes that physical socket', async () => {
    const x = await setup(), client = await x.connect()
    const send = vi.spyOn(WebSocket.prototype, 'send').mockImplementationOnce(() => { throw new Error('fixture failure') })
    expect(x.sinks[0]!.sendBinary(new Uint8Array(LIMIT), quota)).toBe(false)
    send.mockRestore()
    const writes = holdWrites()
    expect(x.sinks[0]!.sendBinary(new Uint8Array(LIMIT), quota)).toBe(true)
    const ended = new Promise<void>(resolve => client.once('close', () => resolve()))
    writes.callbacks[0]!(new Error('fixture callback failure'))
    await ended
    writes.callbacks[0]!()
  })

  it('revokes live and pending grants, and leaves no component stream after a saturated service socket closes', async () => {
    let relay: ReturnType<typeof createClientStreams>
    const x = await setup(service => relay.disconnected(service))
    const browser = await x.connect('agentBrowser'), viewer = await x.connect('viewers')
    const outputs: Array<{ connection: string; type: string; payload: Record<string, unknown> }> = []
    relay = createClientStreams({ disabled: () => false, wake: () => {}, sendBinary: () => true,
      send: (_service, connection, type, payload) => { outputs.push({ connection, type, payload }); return true },
      endpoint: service => {
        const sink = x.services.get(service)
        return sink ? {
          frame: event => sink.sendFrame({ type: 'service_event', payload: { kind: 'client_stream', ...event } }, { service, direction: 'service' }),
          binary: raw => sink.sendBinary(raw, { service, direction: 'service' }), closed: () => {}, control: () => {},
          refused: (grant, streamId) => { sink.sendFrame({ type: 'service_event', payload: { kind: 'client_stream_refused', grant, streamId } }, { service, direction: 'service' }) },
        } : null
      },
    })
    const sink = relay.connected('agentBrowser')!
    relay.serving('agentBrowser'); relay.connected('viewers'); relay.serving('viewers')
    const active = new Set<string>()
    let bridge: ReturnType<typeof createServiceClientStreams>
    bridge = createServiceClientStreams(CLIENT_STREAMS.find(spec => spec.service === 'agentBrowser')!, () => ({
      frame: event => {
        active.add(event.grant)
        const streamId = `00000000-0000-4000-8000-${String(active.size).padStart(12, '0')}`
        bridge.frame(event.connection, 'agent_browser_open_result', { requestId: event.grant, streamId })
        return true
      }, binary: () => true, closed: () => active.clear(), control: () => {}, refused: grant => { active.delete(grant) },
    }))
    bridge.connected({ query: async () => ({ ok: true }), notice: (_kind, payload) => {
      sink.frame(payload!.grant as string, payload!.type as string, payload!.payload as Record<string, unknown>)
    } })
    browser.on('message', raw => { const frame = JSON.parse(raw.toString()); bridge.event(frame.payload) })
    browser.once('close', () => bridge.disconnected())
    for (const requestId of ['first', 'second']) relay.frame('owner', 'agent_browser_open', { requestId }, { local: true, owner: true })
    await vi.waitFor(() => expect(active.size).toBe(2))
    holdWrites()
    const transport = x.services.get('agentBrowser')!
    for (let index = 0; index < 8; index++) transport.sendBinary(chunk, { service: 'agentBrowser', direction: 'service' })
    const ended = new Promise<void>(resolve => browser.once('close', () => resolve()))
    relay.frame('owner', 'agent_browser_open', { requestId: 'pending' }, { local: true, owner: true })
    await ended
    expect(active.size).toBe(0)
    expect(outputs.filter(frame => frame.type === 'agent_browser_close')).toHaveLength(2)
    expect(outputs.at(-1)).toEqual({ connection: 'owner', type: 'agent_browser_open_result', payload: { requestId: 'pending', error: 'NOT_READY' } })
    expect(viewer.readyState).toBe(WebSocket.OPEN)
    expect(relay.frame('owner', 'viewer_request', { streamId: 'unrelated' }, { local: true, owner: true })).toBe(true)
    relay.closed()
  })
})
