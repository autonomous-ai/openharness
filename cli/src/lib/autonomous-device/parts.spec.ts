import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AutonomousDeviceDirect, type DirectDeviceHost } from './direct.js'
import { autonomousDeviceLocalRequest } from '../deviceManagementHttp.js'
import { runningDevicePart, startDevicePart } from './parts.js'
import { DeviceResultJournal } from './resultJournal.js'
import { AutonomousDeviceService } from './service.js'

const dirs: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'device-parts-'))
  dirs.push(dir)
  return dir
}
const host = {} as DirectDeviceHost

describe('the Wi-Fi device pieces the core starts', () => {
  it('leaves out a piece whose state file does not parse, and says so, instead of failing the core\'s start', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const dir = dataDir()
    writeFileSync(join(dir, 'autonomous-device-connections.json'), '{"not": "a list"}', { mode: 0o600 })
    writeFileSync(join(dir, 'device-results.json'), '{"version": 1, "machineId": "machine", "entries": "garbage"', { mode: 0o600 })
    // Built bare, each throws: before, out of the core's start, which put the daemon in safe mode.
    expect(() => new AutonomousDeviceDirect(host, dir)).toThrow('Invalid device connection metadata')
    const service = () => new AutonomousDeviceService({ machineId: 'machine', resultJournal: new DeviceResultJournal(join(dir, 'device-results.json')) } as unknown as ConstructorParameters<typeof AutonomousDeviceService>[0])
    expect(service).toThrow()
    expect(startDevicePart('Wi-Fi device link', () => new AutonomousDeviceDirect(host, dir))).toBeUndefined()
    expect(startDevicePart('Wi-Fi device service', service)).toBeUndefined()
    expect(startDevicePart('test piece', () => { throw 'not an Error' })).toBeUndefined()
    expect(warn.mock.calls.map((call) => call[0])).toEqual([
      '[device] the Wi-Fi device link could not be started, and this daemon runs without it: Invalid device connection metadata',
      expect.stringMatching(/^\[device\] the Wi-Fi device service could not be started, and this daemon runs without it: /),
      '[device] the test piece could not be started, and this daemon runs without it: not an Error',
    ])
  })

  it('starts a piece whose state reads', () => {
    const direct = startDevicePart('Wi-Fi device link', () => new AutonomousDeviceDirect(host, dataDir()))
    expect(direct).toBeInstanceOf(AutonomousDeviceDirect)
    expect(runningDevicePart(direct, 'Wi-Fi device link')).toBe(direct)
  })

  it('answers a request that needs a piece that is not running UNAVAILABLE', async () => {
    const missing = undefined as AutonomousDeviceDirect | undefined
    const management = {
      discover: async () => ({ devices: await runningDevicePart(missing, 'Wi-Fi device link').discover() }),
      pairStart: () => runningDevicePart(missing, 'Wi-Fi device link').pair('device', 'ABC234'),
      pairStatus: () => ({}), list: () => ({}), status: () => ({}), revoke: () => ({}), receipt: () => ({}),
    }
    expect(await autonomousDeviceLocalRequest(management, 'GET', '/api/autonomous-device/discover', undefined)).toEqual({
      status: 503,
      body: { error: { code: 'UNAVAILABLE', message: 'The Wi-Fi device link is not running on this computer: its state could not be read. See the daemon\'s log.' } },
    })
    expect((await autonomousDeviceLocalRequest(management, 'POST', '/api/autonomous-device/pair/start', { code: 'ABC234', device: 'device' })).status).toBe(503)
  })
})
