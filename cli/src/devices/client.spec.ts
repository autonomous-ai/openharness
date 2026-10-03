import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { devicesCommand, deviceRequest, type DevicesClientDeps } from './client.js'

const snapshot = (brightness = 80) => ({ status: { devices: [{ id: 'usb', attached: true, settings: { brightness } }] } })
function fixture() {
  const request = vi.fn(async (_id: string, _type: string, _payload?: Record<string, unknown>) => snapshot() as Record<string, unknown>)
  const deps: DevicesClientDeps = {
    port: 18473, machineId: async () => 'local', connect: () => { throw new Error('No real sockets') }, request,
    fetch: vi.fn(async () => new Response(JSON.stringify({ data: { machines: [
      { machineId: 'local', name: 'Studio', status: 'running' },
      { machineId: 'remote', name: 'Office', status: 'running' },
      { machineId: 'offline', name: 'Workshop', status: 'offline' },
      { machineId: 'shared', isShared: true, status: 'running' },
    ] } }))) as typeof fetch,
    delay: async () => {},
  }
  return { deps, request }
}

describe('Devices DSH commands', () => {
  it('lists owned hosts, keeps offline presence, and reports unreachable hosts without inventing devices', async () => {
    const { deps, request } = fixture()
    request.mockRejectedValueOnce(new Error('unavailable'))
    const result = await devicesCommand(['list', '--json'], deps)
    expect(result.hosts).toMatchObject([
      { machineId: 'local', available: false, error: 'unavailable' },
      { machineId: 'remote', available: true, status: { devices: [{ id: 'usb' }] } },
      { machineId: 'offline', online: false, available: false },
    ])
    expect(request.mock.calls.map(call => call[0])).toEqual(['local', 'remote'])
  })
  it('targets only the selected host and waits for firmware confirmation', async () => {
    const { deps, request } = fixture()
    request.mockResolvedValueOnce({ ok: true, ...snapshot() }).mockResolvedValueOnce(snapshot(35))
    expect(await devicesCommand(['set', '--machine', 'remote', '--device', 'usb', '--patch', '{"brightness":35}'], deps))
      .toMatchObject({ confirmed: true, machineId: 'remote', id: 'usb', settings: { brightness: 35 } })
    expect(request.mock.calls).toEqual([
      ['remote', 'harness_device_settings', { id: 'usb', patch: { brightness: 35 } }],
      ['remote', 'harness_devices_list'],
    ])
  })
  it('does not turn acceptance into confirmation and never writes offline or shared hosts', async () => {
    const { deps, request } = fixture()
    request.mockResolvedValueOnce({ ok: true, ...snapshot() })
    const args = ['set', '--machine', 'remote', '--device', 'usb', '--patch', '{"brightness":35}']
    expect(await devicesCommand(args, deps)).toMatchObject({ accepted: true, confirmed: false })
    request.mockClear()
    for (const id of ['offline', 'shared', 'unknown']) {
      await expect(devicesCommand([...args.slice(0, 2), id, ...args.slice(3)], deps)).rejects.toThrow()
    }
    await expect(devicesCommand(['set', '--machine', 'remote', '--device', 'usb', '--patch', '{"face":466}'], deps)).rejects.toThrow()
    expect(request).not.toHaveBeenCalled()
  })
  it('waits for host selection, correlates the reply, and closes the tool socket', async () => {
    const socket = Object.assign(new EventEmitter(), { send: vi.fn(), close: vi.fn() })
    const { deps } = fixture()
    deps.connect = () => socket
    const reply = deviceRequest(deps, 'remote', 'harness_devices_list')
    socket.emit('open')
    expect(JSON.parse(socket.send.mock.calls[0]![0])).toMatchObject({ type: 'machine_select', payload: { machineId: 'remote', tool: true, localProtocolVersion: 1 } })
    socket.emit('message', JSON.stringify({ type: 'connected' }))
    const call = JSON.parse(socket.send.mock.calls[1]![0])
    socket.emit('message', JSON.stringify({ type: 'harness_devices_list_result', payload: { requestId: 'wrong', status: 'bad' } }))
    expect(socket.close).not.toHaveBeenCalled()
    socket.emit('message', JSON.stringify({ type: 'harness_devices_list_result', payload: { requestId: call.payload.requestId, ...snapshot() } }))
    expect(await reply).toEqual(snapshot())
    expect(socket.close).toHaveBeenCalledOnce()
  })
})
