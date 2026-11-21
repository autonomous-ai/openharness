import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cancelTurn } from './cancel.js'
import type { ClientSocket } from './daemon.js'
import { DeviceWorkBudget } from '../lib/autonomous-device/pendingWork.js'

const where = { dataDir: '/data', port: 1, machineId: 'machine' }
class Socket extends EventEmitter implements ClientSocket {
  sent: Array<{ type: string; payload: Record<string, unknown> }> = []
  send = vi.fn((text: string) => { this.sent.push(JSON.parse(text)) })
  close = vi.fn()
  frame(type: string, payload: unknown) { this.emit('message', Buffer.from(JSON.stringify({ type, payload })), false) }
  select() { this.emit('open'); this.frame('connected', { machineId: 'machine', transport: 'local', localProtocolVersion: 1 }) }
  reply(ok = true) { this.frame('cancel_result', { requestId: this.sent.find(frame => frame.type === 'cancel')!.payload.requestId, ok }) }
}
function start(over: { connect?: () => ClientSocket | Promise<ClientSocket>; current?: () => boolean; budget?: DeviceWorkBudget; machineId?: string; agentId?: string; controller?: AbortController } = {}) {
  const socket = new Socket(), release = vi.fn(), reserve = vi.fn(() => release), controller = over.controller ?? new AbortController()
  const connect = vi.fn(over.connect ?? (() => socket))
  const result = cancelTurn({ ...where, machineId: over.machineId ?? where.machineId }, over.agentId ?? 'agent', over.current ?? (() => true), controller.signal, over.budget ?? { reserve }, connect)
  return { socket, controller, connect, result, release, reserve }
}
beforeEach(() => { vi.useFakeTimers(); vi.spyOn(console, 'warn').mockImplementation(() => {}) })
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('one confirmed cancel on the owner socket', () => {
  it.each(['current', 'abort'])('refuses %s revoked between socket settlement and the wrapper continuation', async how => {
    let current = true
    const run = start({ current: () => current })
    await Promise.resolve(); run.socket.select(); run.socket.reply()
    if (how === 'current') current = false; else run.controller.abort()
    expect(await run.result).toBe(false)
    run.socket.emit('close', 1000)
  })
  it.each([true, false])('returns actual confirmation %s once and retains credit through physical close', async ok => {
    const f = start(); await Promise.resolve(); f.socket.select()
    expect(f.socket.sent[0]).toEqual({ type: 'machine_select', payload: { machineId: 'machine', localProtocolVersion: 1, tool: true, questionProtocol: 1 } })
    expect(f.socket.sent[1]).toEqual({ type: 'cancel', payload: { agentId: 'agent', requestId: expect.any(String) } })
    f.socket.reply(ok); expect(await f.result).toBe(ok)
    f.socket.emit('open'); f.socket.reply(!ok)
    expect(f.socket.send).toHaveBeenCalledTimes(2); expect(f.socket.close).toHaveBeenCalledOnce()
    expect(f.release).not.toHaveBeenCalled(); f.socket.emit('close', 1000); expect(f.release).toHaveBeenCalledOnce()
  })
  it.each(['caller', 'abort', 'machine', 'machine-size', 'agent', 'agent-size'] as const)('refuses %s before reserving or connecting', async reason => {
    const controller = new AbortController(); if (reason === 'abort') controller.abort()
    const f = start({ controller, current: () => reason !== 'caller', machineId: reason === 'machine' ? '' : reason === 'machine-size' ? 'm'.repeat(201) : 'machine', agentId: reason === 'agent' ? '' : reason === 'agent-size' ? 'a'.repeat(201) : 'agent' })
    expect(await f.result).toBe(false); expect(f.reserve).not.toHaveBeenCalled(); expect(f.connect).not.toHaveBeenCalled()
  })
  it('keeps closed-but-unsettled requests in the process capacity bound', async () => {
    const budget = new DeviceWorkBudget(), releases = Array.from({ length: 99 }, () => budget.reserve({})!)
    const f = start({ budget }); await Promise.resolve(); f.socket.select(); f.socket.reply()
    expect(await f.result).toBe(true)
    const refused = start({ budget }); expect(await refused.result).toBe(false); expect(refused.connect).not.toHaveBeenCalled()
    f.socket.emit('close', 1000); const release = budget.reserve({}); expect(release).not.toBeNull(); release!(); releases.forEach(done => done())
  })
  it.each(['connect', 'open', 'reply'] as const)('refuses revoked authority after %s without replay', async phase => {
    let current = true, resolve!: (socket: ClientSocket) => void
    const socket = new Socket(), f = start({ current: () => current, connect: () => new Promise(done => { resolve = done }) })
    if (phase === 'connect') current = false
    resolve(socket); await Promise.resolve()
    if (phase === 'open') { current = false; socket.emit('open') }
    if (phase === 'reply') { socket.select(); current = false; socket.reply() }
    expect(await f.result).toBe(false); expect(socket.sent.filter(frame => frame.type === 'cancel')).toHaveLength(phase === 'reply' ? 1 : 0)
    expect(f.connect).toHaveBeenCalledOnce(); expect(f.release).not.toHaveBeenCalled(); socket.emit('close', 1000)
    expect(f.release).toHaveBeenCalledOnce()
  })
  it.each(['timeout', 'abort'] as const)('closes a late connected socket after %s and retains capacity until then', async end => {
    let resolve!: (socket: ClientSocket) => void
    const f = start({ connect: () => new Promise(done => { resolve = done }) })
    if (end === 'timeout') await vi.advanceTimersByTimeAsync(15_000); else f.controller.abort()
    expect(await f.result).toBe(false); expect(f.release).not.toHaveBeenCalled()
    resolve(f.socket); await Promise.resolve(); expect(f.socket.close).toHaveBeenCalledOnce()
    f.socket.emit('open'); expect(f.socket.sent).toEqual([]); f.socket.emit('close', 1000); expect(f.release).toHaveBeenCalledOnce()
  })
  it('aborts an opened operation immediately and never sends its late handshake', async () => {
    const f = start(); await Promise.resolve(); f.socket.emit('open'); f.controller.abort()
    expect(await f.result).toBe(false); f.socket.frame('connected', { machineId: 'machine', transport: 'local', localProtocolVersion: 1 })
    expect(f.socket.sent).toHaveLength(1); expect(f.socket.close).toHaveBeenCalledOnce(); f.socket.emit('close', 1000)
  })
  it.each(['binary', 'json', 'null', 'array', 'payload', 'oversize', 'machine', 'transport', 'version', 'preopen', 'wrong-type', 'wrong-id', 'duplicate-handshake'] as const)('rejects %s without accepting/replaying the interrupt', async bad => {
    const f = start(); await Promise.resolve()
    if (['wrong-type', 'wrong-id', 'duplicate-handshake'].includes(bad)) f.socket.select()
    else if (bad !== 'preopen') f.socket.emit('open')
    if (bad === 'binary') f.socket.emit('message', Buffer.from('x'), true)
    else if (['json', 'null', 'array', 'oversize'].includes(bad)) f.socket.emit('message', Buffer.from(bad === 'json' ? 'x' : bad === 'null' ? 'null' : bad === 'array' ? '[]' : ' '.repeat(4097)), false)
    else if (bad === 'payload') f.socket.frame('connected', [])
    else if (bad === 'wrong-type') f.socket.frame('other_result', { requestId: f.socket.sent[1].payload.requestId, ok: true })
    else if (bad === 'wrong-id') f.socket.frame('cancel_result', { requestId: 'other', ok: true })
    else f.socket.frame('connected', { machineId: bad === 'machine' ? 'other' : 'machine', transport: bad === 'transport' ? 'relay' : 'local', localProtocolVersion: bad === 'version' ? 2 : 1 })
    expect(await f.result).toBe(false); expect(f.socket.close).toHaveBeenCalledOnce(); f.socket.emit('close', 1000)
  })
  it('retains a socket whose listener setup fails until actual close', async () => {
    const socket = new Socket(), on = socket.on.bind(socket)
    vi.spyOn(socket, 'on').mockImplementation((event: string | symbol, listener: (...args: any[]) => void) => {
      on(event, listener)
      if (event === 'error') throw new Error('private')
      return socket
    })
    const f = start({ connect: () => socket })
    expect(await f.result).toBe(false); expect(f.release).not.toHaveBeenCalled()
    expect(socket.close).toHaveBeenCalledOnce(); socket.emit('close', 1000); expect(f.release).toHaveBeenCalledOnce()
  })
  it.each(['connect', 'send-select', 'send-cancel', 'error', 'close', 'timeout', 'close-throws'] as const)('settles %s failures with physical capacity accounting', async failure => {
    const f = start({ ...(failure === 'connect' ? { connect: () => { throw new Error('private') } } : {}) }); await Promise.resolve()
    if (failure === 'send-select') { f.socket.send.mockImplementation(() => { throw new Error('private') }); f.socket.emit('open') }
    else if (failure === 'send-cancel') { f.socket.emit('open'); f.socket.send.mockImplementation(() => { throw new Error('private') }); f.socket.frame('connected', { machineId: 'machine', transport: 'local', localProtocolVersion: 1 }) }
    else if (failure === 'error') f.socket.emit('error', new Error('private'))
    else if (failure === 'close') f.socket.emit('close', 1006)
    else if (failure === 'timeout' || failure === 'close-throws') {
      if (failure === 'close-throws') f.socket.close.mockImplementation(() => { throw new Error('private') })
      f.socket.select(); await vi.advanceTimersByTimeAsync(15_000)
    }
    expect(await f.result).toBe(false)
    if (failure === 'connect' || failure === 'close') expect(f.release).toHaveBeenCalledOnce()
    else { expect(f.release).not.toHaveBeenCalled(); f.socket.emit('close', 1000); expect(f.release).toHaveBeenCalledOnce() }
    expect(console.warn).not.toHaveBeenCalledWith(expect.stringContaining('private'))
  })
})
