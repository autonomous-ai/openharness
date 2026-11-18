import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connectSocket, type ClientSocket } from '../agentClient/daemon.js'
import { storeLaunchContext } from './storeContext.js'
vi.mock('../agentClient/daemon.js', () => ({ connectSocket: vi.fn() }))

const where = { dataDir: '/fixture', port: 1, machineId: 'machine' }
const sockets: Socket[] = []
class Socket extends EventEmitter implements ClientSocket {
  sent: Array<{ type: string; payload: Record<string, unknown> }> = []
  send = vi.fn((text: string) => { this.sent.push(JSON.parse(text)) })
  close = vi.fn()
  constructor() { super(); sockets.push(this) }
  frame(type: string, payload: unknown) { this.emit('message', Buffer.from(JSON.stringify({ type, payload })), false) }
  select() { this.emit('open'); this.frame('connected', { machineId: 'machine', transport: 'local', localProtocolVersion: 1 }) }
  reply(account: unknown, over: Record<string, unknown> = {}) {
    this.frame('grid_launch_context_result', { requestId: this.sent[1].payload.requestId, ok: true, account, ...over })
  }
}
function start(setup = false, current = () => true, controller = new AbortController()) {
  const socket = new Socket(), connect = vi.fn(() => socket)
  const answer = storeLaunchContext(where, setup, current, controller.signal, connect)
  return { socket, connect, controller, answer }
}
beforeEach(() => { vi.useFakeTimers(); vi.spyOn(console, 'warn').mockImplementation(() => {}) })
afterEach(() => {
  for (const socket of sockets.splice(0)) socket.emit('close', 1000)
  vi.useRealTimers(); vi.restoreAllMocks()
})

describe('Store reads context from Models through the owner socket', () => {
  it('uses the existing authenticated local transport by default', async () => {
    const socket = new Socket()
    vi.mocked(connectSocket).mockResolvedValueOnce(socket)
    const answer = storeLaunchContext(where, false, () => true, new AbortController().signal)
    await Promise.resolve(); socket.select(); socket.reply({ privateGrid: 'default' })
    expect(await answer).toEqual({ privateGrid: 'default' })
    expect(connectSocket).toHaveBeenCalledWith(where)
  })
  it.each([true, false])('sends only setup=%s and detaches the bounded account', async setup => {
    const run = start(setup); await Promise.resolve(); run.socket.select()
    expect(run.socket.sent).toEqual([
      { type: 'machine_select', payload: { machineId: 'machine', localProtocolVersion: 1, tool: true, questionProtocol: 1 } },
      { type: 'grid_launch_context', payload: { setup, requestId: expect.any(String) } },
    ])
    run.socket.reply({ privateGrid: 'g'.repeat(4096), ignored: 'not retained' })
    expect(await run.answer).toEqual({ privateGrid: 'g'.repeat(4096) })
    expect(run.socket.close).toHaveBeenCalledOnce()
    expect(run.connect).toHaveBeenCalledOnce()
  })
  it.each([{}, { privateGrid: null }, { privateGrid: '' }])('preserves valid account %j', async account => {
    const run = start(); await Promise.resolve(); run.socket.select(); run.socket.reply(account)
    expect(await run.answer).toEqual(account)
  })
  it.each([null, [], { privateGrid: 1 }, { privateGrid: 'x'.repeat(4097) }, { privateGrid: 'x\0y' }])(
    'uses the historical null context for malformed account %#', async account => {
      const run = start(); await Promise.resolve(); run.socket.select(); run.socket.reply(account)
      expect(await run.answer).toEqual({ privateGrid: null })
      expect(console.warn).toHaveBeenCalledWith('[store] LAUNCH_CONTEXT_UNAVAILABLE')
    },
  )
  it.each(['refused', 'wrong-id', 'oversize', 'disconnect'] as const)('names %s without replay or private error text', async reason => {
    const run = start(); await Promise.resolve(); run.socket.select()
    if (reason === 'refused') run.socket.reply({}, { ok: false, error: 'private' })
    else if (reason === 'wrong-id') run.socket.reply({}, { requestId: 'old', error: 'private' })
    else if (reason === 'oversize') run.socket.reply({}, { extra: 'x'.repeat(32 * 1024) })
    else run.socket.emit('close', 1006)
    expect(await run.answer).toEqual({ privateGrid: null })
    expect(run.connect).toHaveBeenCalledOnce()
    expect(vi.mocked(console.warn).mock.calls.flat().join(' ')).not.toContain('private')
  })
  it('uses one deadline through a late connect and releases its charge only on physical close', async () => {
    let connected!: (socket: ClientSocket) => void
    const controller = new AbortController(), socket = new Socket()
    const answer = storeLaunchContext(where, true, () => true, controller.signal, () => new Promise(resolve => { connected = resolve }))
    await vi.advanceTimersByTimeAsync(130_000)
    expect(await answer).toEqual({ privateGrid: null })
    expect(console.warn).toHaveBeenCalledWith('[store] LAUNCH_CONTEXT_TIMEOUT')
    connected(socket); await Promise.resolve()
    expect(socket.close).toHaveBeenCalledOnce(); socket.emit('open'); expect(socket.sent).toEqual([])
  })
  it.each(['abort', 'replaced'] as const)('refuses %s context instead of treating lost launch authority as an empty account', async reason => {
    let current = true
    const run = start(false, () => current)
    const rejected = expect(run.answer).rejects.toThrow('Store context connection changed')
    await Promise.resolve(); run.socket.select()
    if (reason === 'abort') run.controller.abort(); else { current = false; run.socket.reply({ privateGrid: 'stale' }) }
    await rejected; expect(run.socket.close).toHaveBeenCalledOnce()
  })
  it('holds the process request ceiling until actual closes, including duplicate close events', async () => {
    const warning = vi.spyOn(process, 'emitWarning').mockImplementation(() => {})
    const controller = new AbortController()
    const held = Array.from({ length: 100 }, () => start(false, () => true, controller))
    await Promise.resolve()
    expect(warning).not.toHaveBeenCalled()
    for (const run of held) { run.socket.select(); run.socket.reply({ privateGrid: null }) }
    await Promise.all(held.map(run => run.answer))
    const refused = start(); expect(await refused.answer).toEqual({ privateGrid: null })
    expect(refused.connect).not.toHaveBeenCalled()
    expect(console.warn).toHaveBeenCalledWith('[store] LAUNCH_CONTEXT_BACKPRESSURE')
    held[0].socket.emit('close', 1000); held[0].socket.emit('close', 1000)
    const fresh = start(); await Promise.resolve(); fresh.socket.select(); fresh.socket.reply({ privateGrid: 'fresh' })
    expect(await fresh.answer).toEqual({ privateGrid: 'fresh' })
    const stillHeld = start(); expect(await stillHeld.answer).toEqual({ privateGrid: null })
    expect(stillHeld.connect).not.toHaveBeenCalled()
  })
})
