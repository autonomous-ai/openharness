import { afterEach, expect, it, vi } from 'vitest'
import { BackendSocket } from './backendSocket.js'
import { dispatchDown, gatewayOf, relaySocket } from './testing/relaySocket.js'
import { PAIR_REQUESTS, PLATE_REQUEST, rpcResultType } from './lib/e2ee/applicationFrames.js'

afterEach(() => vi.restoreAllMocks())

it.each(['memory', 'recall_memory', 'status', 'list_harnesses'])(
  'refuses retired optional %s requests without starting any feature service', async verb => {
    const socket = relaySocket('fixture')
    const frames: Array<{ type?: unknown; payload?: any }> = []
    vi.spyOn(socket, 'sendTo').mockImplementation((_to, frame) => { frames.push(frame) })
    socket.registerLocalClient('local:feature', { sendFrame: () => true, sendBinary: () => true }, { tool: true })
    try {
      socket.handleLocalFrame('local:feature', { type: 'pair', payload: {
        requestId: 'retired', verb, action: 'configure_experiment', enabled: true,
      } })
      await vi.waitFor(() => expect(frames).toContainEqual({ type: 'pair_result', payload: {
        requestId: 'retired', error: 'UNSUPPORTED',
      } }))
    } finally {
      await socket.unregisterLocalClient('local:feature')
      await socket.stop()
    }
  },
)

const retiredRequests = ['pair', ...PAIR_REQUESTS, PLATE_REQUEST]

it.each(retiredRequests)('preserves the local transport boundary for %s', async type => {
  const socket = relaySocket('fixture')
  const frames: unknown[] = []
  socket.registerLocalClient('local:window', {
    sendFrame: frame => { frames.push(frame); return true }, sendBinary: () => true,
  })
  try {
    socket.handleLocalFrame('local:window', { type, payload: { requestId: 'retired' } })
    await vi.waitFor(() => expect(frames).toContainEqual({ type: rpcResultType(type), payload: {
      requestId: 'retired', error: type === 'pair' ? 'UNSUPPORTED' : 'REMOTE_ONLY',
    } }))
  } finally {
    await socket.unregisterLocalClient('local:window')
    await socket.stop()
  }
})

it.each(retiredRequests)('keeps the encrypted, targeted refusal for relayed %s', async type => {
  const socket = relaySocket('fixture')
  const internal = socket as any
  vi.spyOn(gatewayOf(socket).e2ee, 'hasSession').mockReturnValue(true)
  vi.spyOn(gatewayOf(socket).e2ee, 'sessionRole').mockReturnValue('web')
  vi.spyOn(gatewayOf(socket).e2ee, 'unwrapDown').mockReturnValue({ type, payload: { requestId: 'retired' } })
  const wrap = vi.spyOn(gatewayOf(socket).e2ee, 'wrapRpcReply').mockReturnValue({
    type: rpcResultType(type), payload: { __e2e: 'sealed' },
  })
  const broadcast = vi.spyOn(socket, 'send')
  try {
    await dispatchDown(socket, { type, payload: { __e2e: { v: 1, k: 'p', n: 1, ct: 'fixture' } } }, 'remote:owner', 'relay')
    expect(wrap).toHaveBeenCalledWith('remote:owner', rpcResultType(type), 'retired', {
      error: type === 'pair' ? 'LOCAL_ONLY' : 'UNSUPPORTED',
    })
    expect(broadcast).not.toHaveBeenCalled()
  } finally { await socket.stop() }
})

it.each(retiredRequests)('still refuses plaintext relayed %s before optional dispatch', async type => {
  const socket = relaySocket('fixture')
  const frames: unknown[] = []
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  // The gateway's own send to that one relayed connection: its refusal never reaches the core.
  vi.spyOn(gatewayOf(socket) as any, 'sendTo').mockImplementation((_to: unknown, frame: unknown) => { frames.push(frame) })
  try {
    await dispatchDown(socket, { type, payload: { requestId: 'retired' } }, 'remote:untrusted', 'relay')
    expect(frames).toEqual([{ type: rpcResultType(type), payload: { requestId: 'retired', error: 'E2EE_REQUIRED' } }])
  } finally { await socket.stop() }
})
