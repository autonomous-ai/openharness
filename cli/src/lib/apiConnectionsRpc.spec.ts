import { afterEach, describe, expect, it, vi } from 'vitest'
import { BackendSocket } from '../backendSocket.js'
import { dispatchDown, gatewayOf, relaySocket } from '../testing/relaySocket.js'
import { emptyPorts } from '../core/api.js'
import { createServiceHost } from '../core/serviceHost.js'
import { launchTargetRequests } from '../services/models.js'
import { fakeCore } from '../testing/fakeCore.js'
import { ApiConnections } from './apiConnections.js'

afterEach(() => vi.restoreAllMocks())

/** A socket whose `api_connections` goes where the daemon sends it: the models service
 *  (services/models.ts), behind the socket's gates. */
function socketWithModels(): BackendSocket {
  const socket = relaySocket('fixture')
  const host = createServiceHost(emptyPorts())
  // Served alone, under a name of its own: `models` is a port's name, which `serve` keeps for `start`.
  host.serve('launch-targets', launchTargetRequests, fakeCore(), ['api_connections', 'codex_profiles_list', 'codex_profile_link'])
  socket.serviceRouter = host.route
  return socket
}
describe('API connection RPC', () => {
  it.each(['list', 'save', 'remove'])('handles local %s and returns only public metadata', async action => {
    const socket = socketWithModels()
    const frames: any[] = []
    socket.registerLocalClient('local:apis', { sendFrame: frame => { frames.push(frame); return true }, sendBinary: () => true })
    vi.spyOn(ApiConnections.prototype, 'list').mockReturnValue([])
    const save = vi.spyOn(ApiConnections.prototype, 'save').mockReturnValue({ id: 'fixture' } as any)
    const remove = vi.spyOn(ApiConnections.prototype, 'remove').mockImplementation(() => {})
    socket.handleLocalFrame('local:apis', { type: 'api_connections', payload: { requestId: 'fixture-request', action, id: 'fixture', connection: { provider: 'fal', apiKey: 'private-fixture-key' } } })
    await vi.waitFor(() => expect(frames.some(frame => frame.type === 'api_connections_result')).toBe(true))
    const result = frames.find(frame => frame.type === 'api_connections_result')
    expect(result.payload).toMatchObject({ requestId: 'fixture-request', connections: [] })
    expect(JSON.stringify(result)).not.toContain('private-fixture-key')
    if (action === 'save') expect(save).toHaveBeenCalledWith({ provider: 'fal', apiKey: 'private-fixture-key' })
    if (action === 'remove') expect(remove).toHaveBeenCalledWith('fixture')
    await socket.stop()
  })

  it('refuses unsealed remote access before touching the credential store', async () => {
    const socket = socketWithModels()
    const list = vi.spyOn(ApiConnections.prototype, 'list')
    const save = vi.spyOn(ApiConnections.prototype, 'save')
    await dispatchDown(socket, { type: 'api_connections', payload: { action: 'list', requestId: 'remote' } }, 'remote')
    await dispatchDown(socket, { type: 'api_connections', payload: { action: 'save', requestId: 'remote', connection: { apiKey: 'must-not-persist' } } }, 'remote')
    expect(list).not.toHaveBeenCalled()
    expect(save).not.toHaveBeenCalled()
    await socket.stop()
  })

  it('refuses a sealed device session before touching the credential store', async () => {
    const socket = socketWithModels()
    const save = vi.spyOn(ApiConnections.prototype, 'save')
    const reply = vi.spyOn(socket as any, 'emitReply').mockImplementation(() => {})
    vi.spyOn(gatewayOf(socket).e2ee, 'sessionRole').mockReturnValue('device')
    vi.spyOn(gatewayOf(socket).e2ee, 'unwrapDown').mockReturnValue({
      type: 'api_connections', payload: { action: 'save', requestId: 'remote', connection: { provider: 'fal', apiKey: 'must-stay-local' } },
    })
    await dispatchDown(socket, { type: 'api_connections', payload: { __e2e: { v: 1, k: 'p', n: 1, ct: 'fixture' } } }, 'remote')
    await vi.waitFor(() => expect(reply).toHaveBeenCalledWith('remote', 'api_connections', 'remote', { error: 'OWNER_REQUIRED' }))
    expect(save).not.toHaveBeenCalled()
    await socket.stop()
  })

  it.each(['list', 'save', 'remove'])('allows sealed owner web %s with a sealed metadata-only reply', async action => {
    const socket = socketWithModels(), internals = socket as any
    vi.spyOn(ApiConnections.prototype, 'list').mockReturnValue([])
    const save = vi.spyOn(ApiConnections.prototype, 'save').mockReturnValue({ id: 'fixture' } as any)
    const remove = vi.spyOn(ApiConnections.prototype, 'remove').mockImplementation(() => {})
    vi.spyOn(gatewayOf(socket).e2ee, 'sessionRole').mockReturnValue('web')
    vi.spyOn(gatewayOf(socket).e2ee, 'hasSession').mockReturnValue(true)
    vi.spyOn(gatewayOf(socket).e2ee, 'unwrapDown').mockReturnValue({ type: 'api_connections', payload: {
      requestId: 'owner', action, id: 'fixture', connection: { provider: 'fal', apiKey: 'fixture-private-key' },
    } })
    const sealedReply = vi.spyOn(gatewayOf(socket).e2ee, 'wrapRpcReply').mockReturnValue({ type: 'api_connections_result', payload: { __e2e: 'sealed' } })
    await dispatchDown(socket, { type: 'api_connections', payload: { __e2e: { v: 1, k: 'p', n: 1, ct: 'fixture' } } }, 'remote')
    await vi.waitFor(() => expect(sealedReply).toHaveBeenCalledWith('remote', 'api_connections_result', 'owner', expect.objectContaining({ connections: [] })))
    expect(JSON.stringify(sealedReply.mock.calls)).not.toContain('fixture-private-key')
    if (action === 'save') expect(save).toHaveBeenCalledWith({ provider: 'fal', apiKey: 'fixture-private-key' })
    if (action === 'remove') expect(remove).toHaveBeenCalledWith('fixture')
    await socket.stop()
  })

  it('requires a sealed owner web session for remote orchestration', async () => {
    const socket = relaySocket('fixture')
    const list = vi.fn().mockReturnValue([])
    // The orchestrator is a service the socket routes to (services/orchestrator.ts): it answers an owner alone.
    const askers: Array<{ local: boolean; owner: boolean }> = []
    socket.serviceRouter = (type, _payload, asker, reply) => {
      if (type !== 'orchestrator') return false
      askers.push(asker)
      reply(asker.owner ? { projects: list() } : { error: 'OWNER_REQUIRED' })
      return true
    }
    vi.spyOn(gatewayOf(socket).e2ee, 'hasSession').mockReturnValue(true)
    const role = vi.spyOn(gatewayOf(socket).e2ee, 'sessionRole').mockReturnValue('web')
    const clear = { type: 'orchestrator', payload: { requestId: 'owner', action: 'list' } }
    vi.spyOn(gatewayOf(socket).e2ee, 'unwrapDown').mockReturnValue(clear)
    const sealedReply = vi.spyOn(gatewayOf(socket).e2ee, 'wrapRpcReply').mockReturnValue({ type: 'orchestrator_result', payload: { __e2e: 'sealed' } })
    await dispatchDown(socket, clear, 'remote')
    expect(askers).toEqual([])
    const sealed = { type: 'orchestrator', payload: { __e2e: { v: 1, k: 'p', n: 1, ct: 'fixture' } } }
    role.mockReturnValue('device')
    await dispatchDown(socket, sealed, 'remote')
    expect(askers).toMatchObject([{ local: false, owner: false }])
    expect(list).not.toHaveBeenCalled()
    role.mockReturnValue('web')
    await dispatchDown(socket, sealed, 'remote')
    await vi.waitFor(() => expect(list).toHaveBeenCalledOnce())
    expect(sealedReply).toHaveBeenCalledWith('remote', 'orchestrator_result', 'owner', { projects: [] })
    await socket.stop()
  })
})
