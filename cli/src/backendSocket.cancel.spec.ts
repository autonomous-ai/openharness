import { describe, expect, it, vi } from 'vitest'
import { BackendSocket } from './backendSocket.js'
import { dispatchDown } from './testing/relaySocket.js'
import { bindCancelRequest } from './testing/socketCore.js'
import { encryptDownFrameFor, encryptRpcResult } from './lib/e2ee/applicationFrames.js'

function gateway(socket: BackendSocket) {
  const reply = vi.fn()
  socket.useGateway({ reply, holdRequests: () => {}, serveThisComputerOnly: () => {}, localClients: () => {}, stop: async () => {} } as never)
  return reply
}

function connected() {
  const socket = new BackendSocket('machine'), frames: Array<Record<string, unknown>> = []
  socket.registerLocalClient('local:cancel', { sendFrame: frame => { frames.push(frame); return true }, sendBinary: () => true }, { tool: true })
  frames.length = 0
  return { socket, frames }
}

describe('public cancel confirmation', () => {
  it('answers the exact request on the existing local owner connection', async () => {
    const { socket, frames } = connected()
    const cancel = vi.fn(async (_id: string, confirmed = false, current = () => true) => confirmed && current())
    bindCancelRequest(socket, cancel)
    await dispatchDown(socket, { type: 'cancel', payload: { agentId: 'a1', requestId: 'stop-1' } }, 'local:cancel')
    expect(frames).toEqual([{ type: 'cancel_result', payload: { requestId: 'stop-1', ok: true } }])
    expect(cancel).toHaveBeenCalledWith('a1', true, expect.any(Function))
    await socket.stop()
  })

  it('retains the no-id request with no new reply or confirmed semantics', async () => {
    const { socket, frames } = connected(), cancel = vi.fn(async () => true)
    bindCancelRequest(socket, cancel)
    await dispatchDown(socket, { type: 'cancel', payload: { agentId: 'a1' } }, 'local:cancel')
    expect(cancel.mock.calls).toEqual([['a1']])
    expect(frames).toEqual([])
    await socket.stop()
  })

  it('keeps old request sealing and adds encrypted requester-only confirmation', () => {
    expect(encryptDownFrameFor('cancel', { strictDown: false })).toBe(false)
    expect(encryptDownFrameFor('cancel', { strictDown: true })).toBe(true)
    expect(encryptRpcResult('cancel_result')).toBe(true)
  })
})

describe('cancel confirmation physical authority', () => {
  it.each(['disconnect', 'replacement'] as const)('revokes a local pending cancel on %s, with no reply to a replacement', async event => {
    const { socket, frames } = connected(), replacement: unknown[] = []
    let current!: () => boolean, resolve!: (ok: boolean) => void
    bindCancelRequest(socket, (_id, _confirmed, predicate) => { current = predicate!; return new Promise(done => { resolve = done }) })
    const pending = dispatchDown(socket, { type: 'cancel', payload: { agentId: 'a', requestId: 'r' } }, 'local:cancel')
    expect(current()).toBe(true)
    socket.unregisterLocalClient('local:cancel')
    if (event === 'replacement') socket.registerLocalClient('local:cancel', { sendFrame: frame => { replacement.push(frame); return true }, sendBinary: () => true }, { tool: true })
    expect(current()).toBe(false); resolve(true); await pending
    expect(frames).toEqual([]); expect(replacement).toEqual([]); await socket.stop()
  })
  it('refuses an absent physical owner and reports an unavailable provider to a current one', async () => {
    const { socket, frames } = connected(), cancel = vi.fn()
    bindCancelRequest(socket, cancel)
    await dispatchDown(socket, { type: 'cancel', payload: { agentId: 'a', requestId: 'r' } }, 'local:missing', 'local')
    expect(cancel).not.toHaveBeenCalled()
    socket.cancelProvider = null
    await dispatchDown(socket, { type: 'cancel', payload: { agentId: 'a', requestId: 'r' } }, 'local:cancel')
    expect(frames).toEqual([{ type: 'cancel_result', payload: { requestId: 'r', error: 'UNSUPPORTED' } }])
    await socket.stop()
  })
  it.each(['owner', 'device', 'guest'] as const)('admits confirmed remote %s only through authenticated owner authority', async kind => {
    const socket = new BackendSocket('machine'), send = gateway(socket)
    const cancel = vi.fn(async () => true); bindCancelRequest(socket, cancel)
    socket.agentGuest = () => 'guest'
    socket.fromGateway.client('remote', { label: null, identity: 'key', direct: false, role: kind === 'device' ? 'device' : 'web', ...(kind === 'guest' ? { guest: 'guest' } : {}) })
    await socket.fromGateway.frame('remote', { type: 'cancel', payload: { agentId: 'a', requestId: 'r' } }, 'relay', kind === 'device' ? 'device' : 'web')
    if (kind === 'owner') {
      expect(cancel).toHaveBeenCalledWith('a', true, expect.any(Function))
      expect(send).toHaveBeenCalledWith('remote', 'cancel', 'r', { ok: true })
    } else {
      expect(cancel).not.toHaveBeenCalled()
      expect(send).toHaveBeenCalledWith('remote', 'cancel', 'r', { error: 'OWNER_REQUIRED' })
    }
    await socket.stop()
  })
  it('revokes the remote registration captured before awaiting terminal confirmation', async () => {
    const socket = new BackendSocket('machine'), send = gateway(socket)
    let entered!: () => void, resolve!: (ok: boolean) => void, current!: () => boolean
    const sent = new Promise<void>(done => { entered = done })
    bindCancelRequest(socket, (_id, _confirmed, predicate) => { current = predicate!; entered(); return new Promise(done => { resolve = done }) })
    socket.fromGateway.client('remote', { role: 'web', label: null, identity: 'key', direct: false })
    const pending = socket.fromGateway.frame('remote', { type: 'cancel', payload: { agentId: 'a', requestId: 'r' } }, 'relay', 'web')
    await sent; socket.fromGateway.client('remote', { role: 'web', label: null, identity: 'key', direct: false })
    expect(current()).toBe(false); resolve(true); await pending; expect(send).not.toHaveBeenCalled(); await socket.stop()
  })
})
