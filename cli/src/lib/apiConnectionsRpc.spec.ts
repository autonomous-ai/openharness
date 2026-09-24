import { afterEach, describe, expect, it, vi } from 'vitest'
import { BackendSocket } from '../backendSocket.js'
import { ApiConnections } from './apiConnections.js'

afterEach(() => vi.restoreAllMocks())
describe('API connection RPC', () => {
  it.each(['list', 'save', 'remove'])('handles local %s and returns only public metadata', async action => {
    const socket = new BackendSocket('fixture')
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

  it('refuses remote access before touching the credential store', async () => {
    const socket = new BackendSocket('fixture')
    const list = vi.spyOn(ApiConnections.prototype, 'list')
    const save = vi.spyOn(ApiConnections.prototype, 'save')
    await (socket as any).dispatchDown({ type: 'api_connections', payload: { action: 'list', requestId: 'remote' } }, 'remote')
    await (socket as any).dispatchDown({ type: 'api_connections', payload: { action: 'save', requestId: 'remote', connection: { apiKey: 'must-not-persist' } } }, 'remote')
    expect(list).not.toHaveBeenCalled()
    expect(save).not.toHaveBeenCalled()
    await socket.stop()
  })

  it('refuses authenticated encrypted remote management too', async () => {
    const socket = new BackendSocket('fixture')
    const save = vi.spyOn(ApiConnections.prototype, 'save')
    const reply = vi.spyOn(socket as any, 'emitReply').mockImplementation(() => {})
    vi.spyOn((socket as any).e2ee, 'unwrapDown').mockReturnValue({
      type: 'api_connections', payload: { action: 'save', requestId: 'remote', connection: { provider: 'fal', apiKey: 'must-stay-local' } },
    })
    await (socket as any).dispatchDown({ type: 'api_connections', payload: { __e2e: { v: 1, k: 'p', n: 1, ct: 'fixture' } } }, 'remote')
    expect(save).not.toHaveBeenCalled()
    expect(reply).toHaveBeenCalledWith('remote', 'api_connections', 'remote', { error: 'LOCAL_ONLY', detail: 'Manage APIs on this computer.' })
    await socket.stop()
  })
})
