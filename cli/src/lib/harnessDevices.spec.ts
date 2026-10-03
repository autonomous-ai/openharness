import { describe, expect, it, vi } from 'vitest'
import { harnessDevicesRequest, type HarnessDevicesService } from './harnessDevices.js'
import type { DialStatus, DeviceSettings } from '../cable/cableSession.js'
import { encryptDownFrame, encryptRpcResult } from './e2ee/applicationFrames.js'
import { ENCRYPTED_UP_TYPES } from './e2ee/core.js'

const settings: DeviceSettings = { brightness: 80, muted: false, quiet: false, character: 2,
  face: 466, round: true, voiceLang: 'en', scrollReversed: false, straightTitle: true, focusFace: false }
describe('owner device management', () => {
  const fixture = () => {
    const devices: DialStatus[] = [
      { id: 'usb-a', attached: true, settings },
      { id: 'usb-b', attached: true, settings },
      { id: 'offline', attached: false, settings },
      { id: 'updating', attached: true, settings, updating: 'next' },
    ]
    const set = vi.fn(async () => ({ ok: true }))
    const service: HarnessDevicesService = { status: () => ({ attached: true, devices }), revision: () => 4, set }
    return { service, set }
  }
  it('reads the whole host and sends a sparse patch only to the named device', async () => {
    const { service, set } = fixture()
    expect(await harnessDevicesRequest(service, 'harness_devices_list', {})).toMatchObject({ protocol: 1, revision: 4, status: { devices: expect.any(Array) } })
    const reply = await harnessDevicesRequest(service, 'harness_device_settings', { id: 'usb-b', patch: { brightness: 35 } })
    expect(set).toHaveBeenCalledExactlyOnceWith('usb-b', { brightness: 35 })
    expect(reply).toMatchObject({ ok: true, status: { devices: [{ settings: { brightness: 80 } }, { settings: { brightness: 80 } }, {}, {}] } })
  })
  it('refuses missing, disconnected, updating and invalid targets without a write', async () => {
    const { service, set } = fixture()
    for (const id of ['missing', 'offline']) expect(await harnessDevicesRequest(service, 'harness_device_settings', { id, patch: { muted: true } })).toMatchObject({ error: 'DEVICE_OFFLINE' })
    expect(await harnessDevicesRequest(service, 'harness_device_settings', { id: 'updating', patch: { muted: true } })).toMatchObject({ error: 'DEVICE_UPDATING' })
    for (const patch of [{ brightness: 101 }, { id: 'usb-a' }, { face: 720 }, {}, { muted: 'true' }]) {
      expect(await harnessDevicesRequest(service, 'harness_device_settings', { id: 'usb-b', patch })).toMatchObject({ error: 'BAD_DEVICE_SETTINGS' })
    }
    expect(set).not.toHaveBeenCalled()
  })
  it('does not report a failed cable delivery as success', async () => {
    const { service, set } = fixture()
    set.mockResolvedValue({ ok: false })
    expect(await harnessDevicesRequest(service, 'harness_device_settings', { id: 'usb-a', patch: { muted: true } })).toMatchObject({ error: 'DEVICE_WRITE_FAILED' })
  })
  it('encrypts requests, replies and device snapshots over remote relays', () => {
    for (const type of ['harness_devices_list', 'harness_device_settings']) {
      expect(encryptDownFrame(type)).toBe(true)
      expect(encryptRpcResult(`${type}_result`)).toBe(true)
    }
    expect(ENCRYPTED_UP_TYPES.has('harness_devices_changed')).toBe(true)
  })
})
