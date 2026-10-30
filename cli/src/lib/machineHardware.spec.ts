import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseDarwinDevice, parseDarwinGpus, parseDarwinMemory, parseLinuxMemory, parseNvidiaGpus,
  readMachineDisk, readMachineGpus, readMachineMemory } from './machineHardware.js'

const mocks = vi.hoisted(() => ({ command: vi.fn(), readFile: vi.fn(), statfs: vi.fn() }))
vi.mock('node:child_process', () => {
  const execFile = Object.assign(vi.fn(), { [Symbol.for('nodejs.util.promisify.custom')]: mocks.command })
  return { execFile }
})
vi.mock('node:fs/promises', () => ({ readFile: mocks.readFile, statfs: mocks.statfs }))
vi.mock('node:os', () => ({ totalmem: () => 8 * 1024 ** 3, freemem: () => 1024 ** 3, homedir: () => '/fixture' }))

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
const vm = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free: 10.
Pages active: 100.
Pages inactive: 80.
Pages speculative: 20.
Pages wired down: 50.
Pages occupied by compressor: 30.
Pages purgeable: 10.
File-backed pages: 90.
`
afterEach(() => {
  Object.defineProperty(process, 'platform', platform)
  vi.resetAllMocks()
})

describe('host memory counters', () => {
  it('counts reclaimable cache on macOS and reads pressure and swap separately', () => {
    expect(parseDarwinMemory(vm, 8 * 1024 ** 3, '2\ntotal = 2048.00M used = 512.50M free = 1535.50M')).toEqual({
      total: 8 * 1024 ** 3, available: 110 * 16384,
      pressure: 'warning', swapUsedBytes: 512.5 * 1024 ** 2,
    })
    expect(parseDarwinMemory(vm, 8 * 1024 ** 3, '4')?.pressure).toBe('critical')
    expect(parseDarwinMemory(vm, 8 * 1024 ** 3, '')?.swapUsedBytes).toBeNull()
    expect(parseDarwinMemory(vm.replace('File-backed pages', 'missing'), 8 * 1024 ** 3, '')).toBeNull()
    expect(parseDarwinMemory(vm, 10, '')).toBeNull()
  })

  it('counts free, inactive, speculative and purgeable pages as available on a real 32 GiB Mac, with pressure still read', () => {
    // Captured with vm_stat on Ken's Mac, 2026-10-22: the old reading was 4.97 GiB available.
    const captured = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                     3903.
Pages active:                                 461392.
Pages inactive:                               454033.
Pages speculative:                              4048.
Pages throttled:                                   0.
Pages wired down:                             317343.
Pages purgeable:                                   2.
"Translation faults":                    71752690153.
Pages copy-on-write:                      6554736573.
Pages zero filled:                       16855483380.
Pages reactivated:                       15019288823.
Pages purged:                              330844917.
File-backed pages:                            266250.
Anonymous pages:                              653223.
Pages stored in compressor:                  3299063.
Pages occupied by compressor:                 801186.
Decompressions:                          14988704555.
Compressions:                            15710187605.
Pageins:                                  1010109106.
Pageouts:                                    7338882.
Swapins:                                    95450347.
Swapouts:                                  100622631.
`
    const reading = parseDarwinMemory(captured, 32 * 1024 ** 3, '2\ntotal = 16384.00M  used = 15304.62M  free = 1079.38M  (encrypted)')!
    expect(reading.available).toBe((3903 + 454033 + 4048) * 16384)
    expect(reading.available / 1024 ** 3).toBeCloseTo(7.05, 2)
    expect(reading.pressure).toBe('warning')
    expect(parseDarwinMemory(captured, 32 * 1024 ** 3, '4')).toMatchObject({ available: reading.available, pressure: 'critical' })
  })

  it('takes the larger of two overlapping views, never their sum, and no more than what is not wired or compressed', () => {
    const only = (text: string) => parseDarwinMemory(text, 8 * 1024 ** 3, '')!.available
    // Speculative pages (20) are in the file-backed count too: 10 free + max(80 + 20, 300 + 10), not 10 + 80 + 20 + 300.
    expect(only(vm.replace('File-backed pages: 90', 'File-backed pages: 300'))).toBe((10 + 310) * 16384)
    expect(only(vm.replace('Pages wired down: 50', 'Pages wired down: 524200'))).toBe(8 * 1024 ** 3 - (524200 + 30) * 16384)
    expect(parseDarwinMemory(vm.replace('Pages wired down: 50', 'Pages wired down: 999999'), 8 * 1024 ** 3, '')).toBeNull()
    expect(parseDarwinMemory(vm.replace('Pages free: 10.\n', ''), 8 * 1024 ** 3, '')).toBeNull()
  })

  it('uses Linux available memory rather than counting cache as used', () => {
    expect(parseLinuxMemory('MemAvailable: 4096 kB\nSwapTotal: 1024 kB\nSwapFree: 512 kB\n', 8 * 1024 ** 2))
      .toEqual({ total: 8 * 1024 ** 2, available: 4 * 1024 ** 2, swapUsedBytes: 512 * 1024 })
    expect(parseLinuxMemory('MemFree: 4096 kB\n', 8 * 1024 ** 2)).toBeNull()
  })

  it.each(['darwin', 'linux'])('retains a portable memory reading when %s counters are inaccessible', async system => {
    Object.defineProperty(process, 'platform', { ...platform, value: system })
    mocks.command.mockRejectedValue(new Error('denied'))
    mocks.readFile.mockRejectedValue(new Error('denied'))
    expect(await readMachineMemory()).toEqual({ total: 8 * 1024 ** 3, available: 1024 ** 3 })
  })
})

describe('optional hardware readings', () => {
  it('preserves separate NVIDIA devices, zero usage and unavailable counters', () => {
    const readings = parseNvidiaGpus('GPU-aaa, NVIDIA RTX 4090, 0, 1024, 24576\nGPU-bbb, NVIDIA RTX 4090, 90, 2048, 24576\nGPU-ccc, NVIDIA, [N/A], [N/A], [N/A]\nerror')
    expect(readings.map(gpu => gpu.utilizationPercent)).toEqual([0, 90, null])
    expect(readings[0].memoryUsedBytes).toBe(1024 ** 3)
    expect(readings[2].memoryUsedBytes).toBeNull()
    expect(parseNvidiaGpus('GPU-aaa, NVIDIA, 101, 2, 1')[0]).toMatchObject({ utilizationPercent: null, memoryUsedBytes: null })
  })

  it('reads Apple and Intel/AMD driver counters without counting registry aliases twice', () => {
    const readings = parseDarwinGpus(`+-o AGX <class AGXAcceleratorG13X, id 0x123, registered>
      "PerformanceStatistics" = {"Device Utilization %"=47}
    +-o AMD <class AMDRadeonX5000, id 0x456, registered>
      "PerformanceStatistics" = {"GPU Activity(%)"=65}
    +-o AMD <class AMDRadeonX5000, id 0x456, registered>
      "PerformanceStatistics" = {"GPU Activity(%)"=66}
    +-o Intel <class IntelAccelerator, id 0x789, registered>
      "PerformanceStatistics" = {"Device Utilization %"=0}
      "poweredOffByAGC"=1`)
    expect(readings).toEqual([
      { id: '0x123', name: 'Apple GPU', utilizationPercent: 47 },
      { id: '0x456', name: 'AMD GPU', utilizationPercent: 66 },
      { id: '0x789', name: 'Intel GPU', utilizationPercent: null },
    ])
    expect(parseDarwinGpus('no driver counters')).toEqual([])
  })

  it.each(['darwin', 'linux', 'win32'])('missing GPU telemetry on %s stays unknown and commands are bounded', async system => {
    Object.defineProperty(process, 'platform', { ...platform, value: system })
    mocks.command.mockRejectedValue(new Error('not supported'))
    expect(await readMachineGpus()).toEqual([])
    expect(mocks.command.mock.calls[0][2]).toMatchObject({ timeout: 1200, maxBuffer: 2 * 1024 ** 2 })
    expect(mocks.command.mock.calls[0][2].shell).toBeUndefined()
  })

  it('reports usable root disk space, preserving zero and unavailable readings', async () => {
    mocks.statfs.mockResolvedValueOnce({ bsize: 4096, bavail: 0, blocks: 100 })
    expect(await readMachineDisk()).toEqual({ diskFreeBytes: 0, diskTotalBytes: 409600 })
    mocks.statfs.mockRejectedValueOnce(new Error('denied'))
    expect(await readMachineDisk()).toEqual({ diskFreeBytes: null, diskTotalBytes: null })
  })
})

it('extracts device type and chip without retaining serials or UUIDs', () => {
  expect(parseDarwinDevice(JSON.stringify({ SPHardwareDataType: [{ machine_name: 'MacBook Pro', chip_type: 'Apple M2 Max', serial_number: 'private', platform_UUID: 'private' }] })))
    .toEqual({ deviceType: 'MacBook Pro', chip: 'Apple M2 Max' })
  expect(parseDarwinDevice('{}')).toEqual({ deviceType: null, chip: null })
})
