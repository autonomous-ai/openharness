import { describe, expect, it, vi } from 'vitest'
import { BackendSocket } from './backendSocket.js'

describe('Devices host ownership', () => {
  it.each(['harness_devices_list', 'harness_device_settings'])('requires sealed owner requests for %s and replies to that connection', async type => {
    const socket = new BackendSocket('fixture'), internals = socket as any
    const status = vi.fn(() => ({ attached: true, devices: [{ id: 'usb', attached: true, settings: { brightness: 80 } }] }))
    const set = vi.fn(async () => ({ ok: true }))
    socket.harnessDevices = { status: status as any, set }
    vi.spyOn(socket.e2ee, 'hasSession').mockReturnValue(true)
    const role = vi.spyOn(socket.e2ee, 'sessionRole').mockReturnValue('web')
    const clear = { type, payload: { requestId: 'one', id: 'usb', patch: { brightness: 35 } } }
    vi.spyOn(socket.e2ee, 'unwrapDown').mockReturnValue(clear)
    const reply = vi.spyOn(socket.e2ee, 'wrapRpcReply').mockReturnValue({ type: `${type}_result`, payload: { __e2e: 'sealed' } })
    await internals.dispatchDown(clear, 'remote')
    expect(status).not.toHaveBeenCalled()
    const sealed = { type, payload: { __e2e: { v: 1, k: 'p', n: 1, ct: 'fixture' } } }
    role.mockReturnValue('device')
    await internals.dispatchDown(sealed, 'remote')
    expect(status).not.toHaveBeenCalled()
    role.mockReturnValue('web')
    await internals.dispatchDown(sealed, 'remote')
    expect(status).toHaveBeenCalled()
    expect(reply).toHaveBeenLastCalledWith('remote', `${type}_result`, 'one', expect.objectContaining(type.endsWith('list') ? { protocol: 1 } : { ok: true }))
    if (type.endsWith('settings')) expect(set).toHaveBeenCalledExactlyOnceWith('usb', { brightness: 35 })
    const local: unknown[] = []
    socket.registerLocalClient('local:tool', { sendFrame: frame => { local.push(frame); return true }, sendBinary: () => true }, { tool: true })
    await internals.dispatchDown(clear, 'local:tool')
    expect(local).toContainEqual(expect.objectContaining({ type: `${type}_result`, payload: expect.objectContaining({ requestId: 'one' }) }))
    await socket.stop()
  })
})
