import { describe, expect, it, vi } from 'vitest'
import { BackendSocket } from './backendSocket.js'
import { DEVICES_REQUESTS, type Asker } from './core/api.js'
import { dispatchDown, gatewayOf, relaySocket } from './testing/relaySocket.js'

// The Devices tab's requests are the devices' own (services/devices.ts): the socket only routes them, with
// who asked as it established it, and the devices answer the owner alone.
describe('Devices host ownership', () => {
  it.each(DEVICES_REQUESTS)('routes %s to the devices only sealed from afar, saying who asked, and replies to that connection', async type => {
    const socket: BackendSocket = relaySocket('fixture')
    const routed: Asker[] = []
    socket.serviceRouter = (asked, _payload, asker, reply) => {
      if (asked !== type) return false
      routed.push(asker)
      reply({ ok: true, owner: asker.owner })
      return true
    }
    vi.spyOn(gatewayOf(socket).e2ee, 'hasSession').mockReturnValue(true)
    const role = vi.spyOn(gatewayOf(socket).e2ee, 'sessionRole').mockReturnValue('web')
    const clear = { type, payload: { requestId: 'one', id: 'usb', patch: { brightness: 35 } } }
    vi.spyOn(gatewayOf(socket).e2ee, 'unwrapDown').mockReturnValue(clear)
    const reply = vi.spyOn(gatewayOf(socket).e2ee, 'wrapRpcReply').mockReturnValue({ type: `${type}_result`, payload: { __e2e: 'sealed' } })
    // In the clear from afar: never routed.
    await dispatchDown(socket, clear, 'remote')
    expect(routed).toEqual([])
    const sealed = { type, payload: { __e2e: { v: 1, k: 'p', n: 1, ct: 'fixture' } } }
    // A device's session may ask, but not as the owner; the owner's own app may.
    role.mockReturnValue('device')
    await dispatchDown(socket, sealed, 'remote')
    role.mockReturnValue('web')
    await dispatchDown(socket, sealed, 'remote')
    expect(routed).toEqual([{ local: false, owner: false, connection: 'remote', requestId: 'one' }, { local: false, owner: true, connection: 'remote', requestId: 'one' }])
    expect(reply).toHaveBeenLastCalledWith('remote', `${type}_result`, 'one', { ok: true, owner: true })
    const local: unknown[] = []
    socket.registerLocalClient('local:tool', { sendFrame: frame => { local.push(frame); return true }, sendBinary: () => true }, { tool: true })
    await dispatchDown(socket, clear, 'local:tool')
    expect(routed.at(-1)).toEqual({ local: true, owner: true, connection: 'local:tool', requestId: 'one' })
    expect(local).toContainEqual(expect.objectContaining({ type: `${type}_result`, payload: expect.objectContaining({ requestId: 'one' }) }))
    await socket.stop()
  })
})
