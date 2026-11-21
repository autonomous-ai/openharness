import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import type { LocalClientSink } from './backendSocket.js'
import { attachLocalWsServer, type LocalWsServer } from './localWsServer.js'
import { QUESTION_OBSERVATION_BYTES } from './core/questionObservation.js'
import { SESSION_EVENT_BYTES, SESSION_EVENT_DRAIN_MS } from './lib/sessionEvents.js'

const clients: WebSocket[] = []
let local: LocalWsServer | undefined, server: http.Server | undefined
afterEach(async () => {
  vi.useRealTimers(); vi.restoreAllMocks()
  for (const client of clients.splice(0)) client.terminate()
  await local?.close()
  await new Promise<void>(resolve => server?.close(() => resolve()) ?? resolve())
  local = undefined; server = undefined
})
async function setup(count: number) {
  const sinks: LocalClientSink[] = [], handshakes: any[] = []
  server = http.createServer()
  local = attachLocalWsServer(server, { machineId: 'fixture', backend: {
    registerLocalClient: (_id, sink) => { sinks.push(sink); return true }, unregisterLocalClient: async () => {},
    handleLocalFrame: () => {}, handleLocalBinary: async () => {},
  } })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  for (let index = 0; index < count; index++) {
    const ws = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/local-ws`); clients.push(ws)
    await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
    const ready = new Promise<void>(resolve => ws.once('message', data => { handshakes.push(JSON.parse(data.toString())); resolve() }))
    ws.send(JSON.stringify({ type: 'machine_select', payload: { machineId: 'fixture', localProtocolVersion: 1,
      tool: true, questionProtocol: 1, eventsProtocol: 1 } }))
    await ready
  }
  return { sinks, handshakes }
}
function holdWrites() {
  const callbacks: Array<(error?: Error) => void> = [], sockets: WebSocket[] = []
  vi.spyOn(WebSocket.prototype, 'send').mockImplementation(function(this: WebSocket, ...args: unknown[]) {
    sockets.push(this)
    if (typeof args.at(-1) === 'function') callbacks.push(args.at(-1) as (error?: Error) => void)
  })
  return { callbacks, sockets }
}
const quota = { kind: 'events' } as const
const frame = (bytes: number) => ({ type: 'session_event', payload: { generation: 'generation',
  frame: { type: 'text_delta', agentId: 'a', payload: { content: 'x'.repeat(bytes) } } } })

it('negotiates the shared event envelope and admits an escaped maximum question-sized inner frame', async () => {
  const { sinks, handshakes } = await setup(1), held = holdWrites()
  expect(handshakes[0].payload.eventsProtocol).toBe(1)
  // The prior audited maximum is serialized JSON bytes, including six bytes per escaped NUL.
  const question = { type: 'questions_row', payload: { generation: 'g', question: { type: 'commander_question', payload: { text: '' } } } }
  const remaining = QUESTION_OBSERVATION_BYTES - Buffer.byteLength(JSON.stringify(question))
  question.payload.question.payload.text = '\u0000'.repeat(Math.floor(remaining / 6)) + 'x'.repeat(remaining % 6)
  expect(Buffer.byteLength(JSON.stringify(question))).toBe(QUESTION_OBSERVATION_BYTES)
  const envelope = { type: 'session_event', payload: { generation: 'generation', frame: question } }
  expect(Buffer.byteLength(JSON.stringify(envelope))).toBeLessThan(SESSION_EVENT_BYTES)
  expect(sinks[0].sendFrame(envelope, quota)).toBe(true)
  expect(held.callbacks).toHaveLength(1)
  held.callbacks[0]()
})

it('keeps physical send charges across logical removal and releases callback or close exactly once', async () => {
  const { sinks } = await setup(4), held = holdWrites(), first = vi.fn()
  const large = frame(15 * 1024 * 1024)
  expect(sinks[0].sendFrame(large, quota, first)).toBe(true)
  expect(sinks[1].sendFrame(large, quota)).toBe(true)
  expect(sinks[2].sendFrame(frame(3 * 1024 * 1024), quota)).toBe(false)
  const closed = new Promise<void>(resolve => held.sockets[0].once('close', () => resolve()))
  clients[0].close(); await closed
  expect(first).toHaveBeenCalledExactlyOnceWith(false)
  held.callbacks[0](); held.callbacks[0]()
  expect(first).toHaveBeenCalledOnce()
  expect(sinks[3].sendFrame(large, quota)).toBe(true)
})

it('rejects negotiated oversize before serialization while preserving the existing legacy send path', async () => {
  const { sinks } = await setup(2), held = holdWrites(), settled = vi.fn()
  const oversized = frame(SESSION_EVENT_BYTES), stringify = vi.spyOn(JSON, 'stringify')
  expect(sinks[0].sendFrame(oversized, quota, settled)).toBe(false)
  expect(stringify).not.toHaveBeenCalled()
  stringify.mockRestore()
  expect(settled).toHaveBeenCalledExactlyOnceWith(false)
  expect(sinks[1].sendFrame(oversized)).toBe(true)
  expect(held.sockets).toHaveLength(1)
})

it('closes a negotiated consumer that never physically drains, without returning credit on the deadline', async () => {
  const { sinks } = await setup(2), held = holdWrites(), settled = vi.fn()
  expect(sinks[0].sendFrame({}, quota, settled)).toBe(true)
  const physical = held.sockets[0], close = vi.spyOn(physical, 'close').mockImplementation(() => {})
  vi.useFakeTimers()
  // A new write starts the deadline while the first physical write is still charged.
  expect(sinks[1].sendFrame({}, quota)).toBe(true)
  const second = held.sockets[1], closeSecond = vi.spyOn(second, 'close').mockImplementation(() => {})
  await vi.advanceTimersByTimeAsync(SESSION_EVENT_DRAIN_MS)
  expect(closeSecond).toHaveBeenCalledWith(1013, 'SESSION_EVENTS_DRAIN_TIMEOUT')
  expect(settled).not.toHaveBeenCalled()
  close.mockRestore(); closeSecond.mockRestore()
  held.callbacks[0]()
  expect(settled).toHaveBeenCalledExactlyOnceWith(true)
})
