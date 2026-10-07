import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDevicesWake, dialPortThere, DIAL_LOOK_MS, wifiDeviceSaved } from './devicesWake.js'

describe('a dial\'s port, as the core looks for one', () => {
  const look = (over: Partial<Parameters<typeof dialPortThere>[0]> = {}) =>
    dialPortThere({ platform: 'darwin', listDev: () => [], read: () => '[]', exists: () => false, ...over })

  it('is a USB modem\'s node in /dev: cu.usbmodem on macOS, ttyACM or ttyUSB on Linux, none elsewhere', () => {
    expect(look({ listDev: () => ['cu.debug-console', 'cu.Bluetooth-Incoming-Port', 'tty.usbmodem1101'] })).toBe(false)
    expect(look({ listDev: () => ['cu.debug-console', 'cu.usbmodem1101'] })).toBe(true)
    expect(look({ platform: 'linux', listDev: () => ['tty0', 'ttyS0'] })).toBe(false)
    expect(look({ platform: 'linux', listDev: () => ['ttyACM0'] })).toBe(true)
    expect(look({ platform: 'linux', listDev: () => ['ttyUSB1'] })).toBe(true)
    expect(look({ platform: 'win32', listDev: () => ['cu.usbmodem1101'] })).toBe(false)
    // /dev that cannot be read has no dial in it.
    expect(look({ listDev: () => { throw new Error('EACCES') } })).toBe(false)
  })

  it('is the end-to-end suite\'s dial when it names one: a pseudo-terminal that is there, or a list with one', () => {
    expect(look({ testDialPort: '/dev/ttys009', exists: (path) => path === '/dev/ttys009' })).toBe(true)
    expect(look({ testDialPort: '/dev/ttys009' })).toBe(false)
    expect(look({ testDialPort: '/d/dials.json', read: () => '[]' })).toBe(false)
    expect(look({ testDialPort: '/d/dials.json', read: () => '[{"serial":"A"}]' })).toBe(false)
    expect(look({ testDialPort: '/d/dials.json', read: () => '{"path":"/dev/ttys1"}' })).toBe(false)
    expect(look({ testDialPort: '/d/dials.json', read: () => '[{"serial":"A","path":"/dev/ttys1"}]' })).toBe(true)
    expect(look({ testDialPort: '/d/dials.json', read: () => 'half a file' })).toBe(false)
    // Only the suite's: a USB modem beside it is not looked at.
    expect(look({ testDialPort: '/d/dials.json', read: () => '[]', listDev: () => ['cu.usbmodem1'] })).toBe(false)
  })
})

describe('a paired Wi-Fi device', () => {
  let dataDir: string
  beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'devices-wake-')) })
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }))

  it('is one the gateway\'s pairings name as a device, or one its direct links connect out to, read no further than a bound', () => {
    const links = join(dataDir, 'autonomous-device-connections.json')
    const pairings = join(dataDir, 'e2e', 'paired.json')
    mkdirSync(join(dataDir, 'e2e'))
    expect(wifiDeviceSaved(dataDir)).toBe(false)
    writeFileSync(links, '[]')
    writeFileSync(pairings, JSON.stringify([{ identityPub: 'p', label: 'phone', pairedAt: 1, role: 'web' }, null]))
    expect(wifiDeviceSaved(dataDir)).toBe(false)
    writeFileSync(pairings, JSON.stringify([{ identityPub: 'd', label: 'Desk', pairedAt: 1, role: 'device' }]))
    expect(wifiDeviceSaved(dataDir)).toBe(true)
    writeFileSync(pairings, '{"role":"device"}')
    expect(wifiDeviceSaved(dataDir)).toBe(false)
    writeFileSync(links, JSON.stringify([{ discoveryId: 'd', fingerprint: 'f' }]))
    expect(wifiDeviceSaved(dataDir)).toBe(true)
    writeFileSync(links, 'not json')
    expect(wifiDeviceSaved(dataDir)).toBe(false)
    writeFileSync(links, 'x'.repeat(1_048_577))
    expect(wifiDeviceSaved(dataDir, () => '[1]')).toBe(false)
  })
})

describe('when the devices\' process is asked for', () => {
  let dataDir: string
  beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'devices-wake-')); vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers(); rmSync(dataDir, { recursive: true, force: true }) })
  const both = new Set(['devices', 'wifi'])

  function wake(over: Partial<Parameters<typeof createDevicesWake>[0]> = {}) {
    let dev: string[] = []
    const want = vi.fn()
    const log = vi.fn()
    const devices = createDevicesWake({ want, dataDir, platform: 'darwin', listDev: () => dev, log, ...over })
    return { devices, want, log, plug: (names: string[]) => { dev = names } }
  }

  it('looks at /dev every two seconds until a dial\'s port is there, asks once, and looks no more', () => {
    const { devices, want, log, plug } = wake()
    devices.start(both)
    expect(want).not.toHaveBeenCalled()
    vi.advanceTimersByTime(DIAL_LOOK_MS * 3)
    expect(want).not.toHaveBeenCalled()
    plug(['cu.usbmodem1101'])
    vi.advanceTimersByTime(DIAL_LOOK_MS)
    expect(want.mock.calls).toEqual([['devices']])
    expect(log).toHaveBeenCalledWith('[devices] a dial\'s port is there: asking for the devices\' process')
    vi.advanceTimersByTime(DIAL_LOOK_MS * 5)
    expect(want).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('asks at once for a dial already plugged in, or a paired Wi-Fi device', () => {
    const { devices, want, plug } = wake()
    plug(['cu.usbmodem1'])
    writeFileSync(join(dataDir, 'autonomous-device-connections.json'), JSON.stringify([{ discoveryId: 'd', fingerprint: 'f' }]))
    devices.start(both)
    expect(want.mock.calls).toEqual([['wifi'], ['devices']])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('holds what was asked before the core was bound, and asks only for what runs in its own process', () => {
    const { devices, want } = wake()
    devices.ask('wifi', 'a Wi-Fi device')
    devices.ask('wifi', 'a Wi-Fi device')
    expect(want).not.toHaveBeenCalled()
    devices.start(new Set(['devices']))
    // The Wi-Fi device runs in the core's process here: nothing to ask for, and the dials are still looked for.
    expect(want).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(1)
    devices.ask('devices', 'a request')
    expect(want.mock.calls).toEqual([['devices']])
    expect(vi.getTimerCount()).toBe(0)
    expect(devices.ask('other', 'a service in the core\'s process')).toBe(false)
    expect(devices.ask('wifi', 'a Wi-Fi device')).toBe(false)
    expect(devices.ask('devices', 'asked again')).toBe(true)
    expect(want).toHaveBeenCalledTimes(1)
    const early = wake()
    expect(early.devices.ask('wifi', 'a Wi-Fi device')).toBe(true)
    early.devices.start(both)
    expect(early.want.mock.calls).toEqual([['wifi']])
  })

  it('looks for nothing with the devices in the core\'s process or the serial ports left alone', () => {
    const inCore = wake()
    inCore.devices.start(new Set(['search']))
    const disabled = wake({ cableDisabled: true })
    disabled.devices.start(both)
    expect(vi.getTimerCount()).toBe(0)
    expect(inCore.want).not.toHaveBeenCalled()
    expect(disabled.want).not.toHaveBeenCalled()
  })

  it('stops looking once the process connected, whoever asked for it, and when the core stops', () => {
    const { devices, want, plug } = wake()
    devices.start(both)
    devices.connected('wifi')
    expect(vi.getTimerCount()).toBe(1)
    devices.connected('devices')
    expect(vi.getTimerCount()).toBe(0)
    plug(['cu.usbmodem1'])
    devices.ask('devices', 'again')
    expect(want).not.toHaveBeenCalled()
    const other = wake()
    other.devices.start(both)
    other.devices.stop()
    other.devices.stop()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('reads /dev, the files and the clock of this computer when given none', () => {
    vi.useRealTimers()
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const want = vi.fn()
    const devices = createDevicesWake({ want, dataDir, testDialPort: join(dataDir, 'none.json') })
    devices.ask('devices', 'a test')
    devices.start(both)
    expect(want).toHaveBeenCalledWith('devices')
    expect(log).toHaveBeenCalledWith('[devices] a test: asking for the devices\' process')
    const looking = createDevicesWake({ want, dataDir })
    looking.start(both)
    looking.stop()
    log.mockRestore()
  })
})
