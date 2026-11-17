import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import { BackendSocket, type LocalClientSink } from './backendSocket.js'
import { attachLocalWsServer, type LocalWsServer } from './localWsServer.js'
import { QUESTION_OBSERVATION_BYTES as LIMIT } from './core/questionObservation.js'

const clients: WebSocket[] = []
let local: LocalWsServer | undefined, server: http.Server | undefined
afterEach(async () => {
  vi.restoreAllMocks()
  for (const client of clients.splice(0)) client.terminate()
  await local?.close()
  await new Promise<void>(resolve => server?.close(() => resolve()) ?? resolve())
  local = undefined; server = undefined
})

async function setup(count: number, backend?: BackendSocket, tool = true) {
  const sinks: LocalClientSink[] = []
  server = http.createServer()
  local = attachLocalWsServer(server, { machineId: 'fixture', backend: {
    registerLocalClient: (id, sink, options) => { sinks.push(sink); return backend?.registerLocalClient(id, sink, options) ?? true },
    unregisterLocalClient: async id => { await backend?.unregisterLocalClient(id) },
    handleLocalFrame: (id, frame) => backend?.handleLocalFrame(id, frame), handleLocalBinary: async () => {},
  } })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/local-ws`
  for (let i = 0; i < count; i++) {
    const ws = new WebSocket(url); clients.push(ws)
    await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
    const ready = new Promise<void>(resolve => ws.once('message', () => resolve()))
    ws.send(JSON.stringify({ type: 'machine_select', payload: { machineId: 'fixture', localProtocolVersion: 1, tool, questionProtocol: 1 } }))
    await ready
  }
  return sinks
}
function holdWrites() {
  const callbacks: Array<(error?: Error) => void> = [], sockets: WebSocket[] = []
  vi.spyOn(WebSocket.prototype, 'send').mockImplementation(function(this: WebSocket, ...args: unknown[]) {
    sockets.push(this)
    if (typeof args.at(-1) === 'function') callbacks.push(args.at(-1) as (error?: Error) => void)
  })
  return { callbacks, sockets }
}
const quota = { kind: 'questions' } as const
const fullFrame = () => ({ data: 'x'.repeat(LIMIT - Buffer.byteLength(JSON.stringify({ data: '' }))) })

it('counts all physical observers globally, settles once and never credits logical replacement', async () => {
  const sinks = await setup(3), held = holdWrites(), first = vi.fn(), refused = vi.fn()
  expect(sinks[0].sendFrame(fullFrame(), quota, first)).toBe(true)
  expect(sinks[1].sendFrame({}, quota, refused)).toBe(false)
  expect(refused).toHaveBeenCalledExactlyOnceWith(false)
  const physical = new Promise<void>(resolve => held.sockets[0].once('close', () => resolve()))
  clients[0].close(); await physical
  expect(first).toHaveBeenCalledExactlyOnceWith(false)
  expect(sinks[2].sendFrame(fullFrame(), quota)).toBe(true)
  held.callbacks[0](); held.callbacks[0]()
  expect(first).toHaveBeenCalledOnce()
  expect(sinks[2].sendFrame({}, quota)).toBe(false)
})

it('releases actual UTF-8 bytes on callback and keeps uncounted legacy sends unchanged', async () => {
  const sinks = await setup(2), held = holdWrites(), settled = vi.fn()
  expect(sinks[0].sendFrame(fullFrame(), quota, settled)).toBe(true)
  held.callbacks[0](); held.callbacks[0]()
  expect(settled).toHaveBeenCalledExactlyOnceWith(true)
  expect(sinks[1].sendFrame(fullFrame(), quota)).toBe(true)
  expect(sinks[0].sendFrame({ type: 'ordinary', payload: {} })).toBe(true)
  expect(sinks[0].sendFrame({}, quota)).toBe(false)
})

it('refuses oversized JSON before serialization and closes only that observer', async () => {
  const sinks = await setup(2), held = holdWrites(), settled = vi.fn()
  const stringify = vi.spyOn(JSON, 'stringify')
  const accepted = sinks[0].sendFrame({ data: '\u0000'.repeat(Math.ceil(LIMIT / 6)) }, quota, settled)
  const calls = stringify.mock.calls.length
  stringify.mockRestore()
  expect(accepted).toBe(false)
  expect(calls).toBe(0)
  expect(settled).toHaveBeenCalledExactlyOnceWith(false)
  expect(held.callbacks).toHaveLength(0)
  expect(sinks[1].sendFrame({}, quota)).toBe(true)
})

it('refuses a string whose length exceeds the whole budget without scanning its content', async () => {
  const sinks = await setup(2), settled = vi.fn(), text = 'x'.repeat(LIMIT + 1)
  const charCodeAt = String.prototype.charCodeAt, byteLength = Buffer.byteLength
  let scans = 0
  const code = vi.spyOn(String.prototype, 'charCodeAt').mockImplementation(function(this: string, index) {
    if (this === text) { scans++; throw new Error('OVERSIZED_STRING_SCANNED') }
    return charCodeAt.call(this, index)
  })
  const size = vi.spyOn(Buffer, 'byteLength').mockImplementation((value, encoding) => {
    if (value === text) { scans++; throw new Error('OVERSIZED_STRING_SCANNED') }
    return byteLength(value, encoding)
  })
  const stringify = vi.spyOn(JSON, 'stringify')
  const closed = new Promise<[number, string]>(resolve => clients[0].once('close', (code, reason) => resolve([code, reason.toString()])))
  const sent = sinks[0].sendFrame({ data: text }, quota, settled)
  const serialized = stringify.mock.calls.length
  code.mockRestore(); size.mockRestore(); stringify.mockRestore()
  expect(sent).toBe(false)
  expect(scans).toBe(0)
  expect(serialized).toBe(0)
  expect(settled).toHaveBeenCalledExactlyOnceWith(false)
  await expect(closed).resolves.toEqual([1013, 'QUESTION_OBSERVATION_TOO_LARGE'])
  const received = new Promise<void>(resolve => clients[1].once('message', () => resolve()))
  expect(sinks[1].sendFrame({}, quota)).toBe(true)
  await received
})

it('accounts mixed escaped Unicode exactly at the physical frame and global byte boundary', async () => {
  const sinks = await setup(2), held = holdWrites()
  const frame = { text: 'a"中\u0000😀\\\ud800é\t\udc00'.repeat(32), padding: '' }
  frame.padding = 'x'.repeat(LIMIT - Buffer.byteLength(JSON.stringify(frame)))
  expect(Buffer.byteLength(JSON.stringify(frame))).toBe(LIMIT)
  expect(sinks[0].sendFrame(frame, quota)).toBe(true)
  expect(sinks[1].sendFrame({}, quota)).toBe(false)
  held.callbacks[0]()
  expect(sinks[0].sendFrame({}, quota)).toBe(true)
  expect(sinks[0].sendFrame({ ...frame, padding: frame.padding + 'x' }, quota)).toBe(false)
})

it('delivers escaped Unicode using bounded scan and copy calls instead of a whole-string escape loop', async () => {
  const sinks = await setup(1)
  const text = 'x'.repeat(4095) + '😀\ud800"\u0000'.repeat(1024), frame = { data: text }
  const exec = RegExp.prototype.exec, replace = String.prototype.replace, slice = String.prototype.slice
  const copies: number[] = [], scans: number[] = []
  const scan = vi.spyOn(RegExp.prototype, 'exec').mockImplementation(function(this: RegExp, value) {
    if (this.global && value.length > 4096) throw new Error('UNBOUNDED_ESCAPE_SCAN')
    return exec.call(this, value)
  })
  const copy = vi.spyOn(String.prototype, 'slice').mockImplementation(function(this: string, start, end) {
    const copied = slice.call(this, start, end)
    if (this === text) { copies.push(copied.length); if (copied.length > 4096) throw new Error('UNBOUNDED_COPY') }
    return copied
  })
  const replacement = vi.spyOn(String.prototype, 'replace').mockImplementation(function(this: string, pattern, value) {
    if (this.length > 4096 || typeof value !== 'string') throw new Error('UNBOUNDED_REPLACEMENT')
    scans.push(this.length)
    return replace.call(this, pattern, value)
  })
  const received = new Promise<Record<string, unknown>>(resolve => clients[0].once('message', raw => resolve(JSON.parse(raw.toString()))))
  const sent = sinks[0].sendFrame(frame, quota)
  scan.mockRestore(); copy.mockRestore(); replacement.mockRestore()
  expect(sent).toBe(true)
  await expect(received).resolves.toEqual(frame)
  expect(copies.length).toBeGreaterThan(0)
  expect(copies.length).toBeLessThanOrEqual(Math.ceil(text.length / 4095))
  expect(Math.max(...copies, ...scans)).toBeLessThanOrEqual(4096)
  expect(scans.length).toBeLessThanOrEqual(3 * Math.ceil(text.length / 4095))
})

it('bounds per-connection and global frame counts independently of bytes', async () => {
  const sinks = await setup(18), held = holdWrites()
  for (let connection = 0; connection < 16; connection++) {
    for (let frame = 0; frame < 256; frame++) expect(sinks[connection].sendFrame({}, quota)).toBe(true)
  }
  expect(sinks[16].sendFrame({}, quota)).toBe(false)
  held.callbacks[0](); held.callbacks[0]()
  expect(sinks[17].sendFrame({}, quota)).toBe(true)
  // Releasing one frame did not credit an extra frame or any other physical connection.
  expect(sinks[17].sendFrame({}, quota)).toBe(false)
})

it('bounds one connection before the global frame cap and releases send failures exactly once', async () => {
  const sinks = await setup(3), held = holdWrites(), settled = vi.fn()
  for (let frame = 0; frame < 256; frame++) expect(sinks[0].sendFrame({}, quota, settled)).toBe(true)
  expect(sinks[0].sendFrame({}, quota, settled)).toBe(false)
  expect(sinks[1].sendFrame({}, quota)).toBe(true)
  held.callbacks[0](new Error('fixture'))
  held.callbacks[0]()
  expect(settled.mock.calls.filter(([sent]) => sent === true)).toHaveLength(0)
  const failure = vi.spyOn(WebSocket.prototype, 'send').mockImplementationOnce(() => { throw new Error('fixture') })
  const failed = vi.fn()
  expect(sinks[2].sendFrame({}, quota, failed)).toBe(false)
  expect(failed).toHaveBeenCalledExactlyOnceWith(false)
  failure.mockRestore()
})

it('contains counting and serialization failures, settles once and leaves other physical clients usable', async () => {
  const sinks = await setup(3), settled = vi.fn()
  const invalid = new Proxy({}, { getPrototypeOf() { throw new Error('fixture') } })
  expect(sinks[0].sendFrame(invalid, quota, settled)).toBe(false)
  expect(settled).toHaveBeenCalledExactlyOnceWith(false)
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic
  expect(sinks[1].sendFrame(cyclic)).toBe(false)
  const delivered = new Promise<void>(resolve => clients[2].once('message', () => resolve()))
  expect(sinks[2].sendFrame({}, quota)).toBe(true)
  await delivered
})

it('keeps a repeated select on the same physical window from restoring implicit interest or leaking admission', async () => {
  const backend = new BackendSocket('fixture'), registered = vi.spyOn(backend, 'registerLocalClient')
  backend.questionSnapshot = function* () {}
  await setup(1, backend, false)
  const ws = clients[0]
  const observe = async (requestId: string, scope: string | string[]) => {
    const result = new Promise<Record<string, unknown>>(resolve => {
      const listener = (raw: Buffer) => {
        const frame = JSON.parse(raw.toString())
        if (frame.type !== 'questions_observe_result' || frame.payload.requestId !== requestId) return
        ws.off('message', listener); resolve(frame.payload)
      }
      ws.on('message', listener)
    })
    ws.send(JSON.stringify({ type: 'questions_observe', payload: { requestId, scope } }))
    expect(await result).toMatchObject({ ok: true })
  }
  await observe('named', ['a'])
  expect(backend.questionsObserved('a')).toBe(true)
  expect(backend.questionsObserved('b')).toBe(false)
  ws.send(JSON.stringify({ type: 'machine_select', payload: { machineId: 'fixture', localProtocolVersion: 1 } }))
  await observe('none', 'none')
  expect(registered).toHaveBeenCalledOnce()
  expect(backend.questionsObserved('a')).toBe(false)
  expect(backend.questionsObserved('b')).toBe(false)
  const closed = new Promise<void>(resolve => ws.once('close', () => resolve()))
  ws.close(); await closed
  await vi.waitFor(() => expect(backend.hasLocalClient()).toBe(false))
  expect(backend.questionsObserved('a')).toBe(false)
})
