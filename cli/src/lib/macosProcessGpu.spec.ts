import { describe, expect, it } from 'vitest'
import { macProcessGpuPercent, parseMacProcessGpu, type MacProcessGpu } from './macosProcessGpu.js'

const device = (id = '0x1') => `+-o AGXAccelerator  <class AGXAccelerator, id ${id}, registered, active>
  | {
  |   "PerformanceStatistics" = {"Device Utilization %"=99,"GPU Activity(%)"=99}
  | }
`
const client = (id: string, pid: number, properties: string) => `  +-o GPUClient  <class GPUClient, id ${id}, !registered, active>
    {
      "IOUserClientCreator" = "pid ${pid}, process"
      ${properties}
    }
`

describe('macOS process GPU counters', () => {
  it('reads Apple Silicon AppUsage by PID and API, without device usage or duplicate contexts', () => {
    const metal = client('0x2', 123, '"AppUsage" = ({"API"="Metal","accumulatedGPUTime"=9007199254740993},{"API"="OpenGL","accumulatedGPUTime"=0})')
    const parsed = parseMacProcessGpu(device() + metal + metal
      + client('0x3', 1234, '"AppUsage" = ({"API"="Metal","accumulatedGPUTime"=7000})'))
    expect(parsed.complete).toBe(true)
    expect(parsed.processes.get(123)).toEqual(new Map([['0x2/Metal', 9007199254740993n], ['0x2/OpenGL', 0n]]))
    expect(parsed.processes.get(1234)).toEqual(new Map([['0x3/Metal', 7000n]]))
    expect(parsed.processes.size).toBe(2)
  })

  it('reads Intel/AMD scalar counters across devices; prefers AppUsage when both exist', () => {
    const parsed = parseMacProcessGpu(device() + client('0x2', 20, '"accumulatedGPUTime" = 0')
      + device('0x10') + client('0x11', 20, '"accumulatedGPUTime" = 500')
      + client('0x12', 20, '"accumulatedGPUTime" = 900\n      "AppUsage" = ({"API"="Metal","accumulatedGPUTime"=100})'))
    expect(parsed.complete).toBe(true)
    expect(parsed.processes.get(20)).toEqual(new Map([['0x2/context', 0n], ['0x11/context', 500n], ['0x12/Metal', 100n]]))
  })

  it.each(['-1', '1.5', 'unknown', '18446744073709551616', '"123"'])('keeps malformed counters unknown: %s', counter => {
    const parsed = parseMacProcessGpu(device() + client('0x2', 20, '"accumulatedGPUTime" = 10')
      + client('0x3', 21, `"AppUsage" = ({"API"="Metal","accumulatedGPUTime"=${counter}})`))
    expect(parsed.processes.get(21)).toBeNull()
    expect(parsed.processes.get(20)).toEqual(new Map([['0x2/context', 10n]]))
  })

  it('does not invent idle readings on unsupported devices, ownerless data or incomplete dumps', () => {
    const supported = device() + client('0x2', 20, '"accumulatedGPUTime" = 10')
    expect(parseMacProcessGpu('').complete).toBe(false)
    expect(parseMacProcessGpu(device()).complete).toBe(false)
    expect(parseMacProcessGpu(supported + device('0x10')).complete).toBe(true) // unused secondary GPU
    const mixed = parseMacProcessGpu(supported + device('0x10') + client('0x11', 21, '"unsupported" = 1'))
    expect(mixed.processes.get(21)).toBeNull()
    expect(mixed.processes.get(20)).toEqual(new Map([['0x2/context', 10n]]))
    expect(parseMacProcessGpu(supported.slice(0, -5)).complete).toBe(false)
    expect(parseMacProcessGpu(supported.replace('"pid 20, process"', '"process 20"')).processes.size).toBe(0)
    expect(parseMacProcessGpu(supported + client('0x2', 20, '"accumulatedGPUTime" = 11')).processes.get(20))
      .toEqual(new Map([['0x2/context', 10n]]))
    expect(parseMacProcessGpu(device() + client('0x2', 20, '"AppUsage" = ({"API"="Metal"})')).processes.get(20)).toBeNull()
  })

  const sample = (sampledAt: number, counters: Array<[string, bigint]> | null): MacProcessGpu => ({ sampledAt, contexts: counters == null ? null : new Map(counters) })
  it('calculates GPU time per interval, including zero and simultaneous contexts above 100%', () => {
    const before = sample(1000, [['a', 9007199254740993n], ['b', 0n]])
    expect(macProcessGpuPercent(before, sample(4000, [['a', 9007202254740993n], ['b', 1500000000n]]))).toBe(150)
    expect(macProcessGpuPercent(before, { ...before, sampledAt: 4000 })).toBe(0)
    expect(macProcessGpuPercent(sample(1000, []), sample(4000, []))).toBe(0)
  })

  it('rejects the first interval, resets, retired/replaced contexts, failures and long gaps', () => {
    const before = sample(1000, [['a', 500n]])
    for (const next of [sample(2000, [['a', 499n]]), sample(2000, []), sample(2000, [['b', 999n]]),
      sample(2000, [['a', 999n], ['b', 0n]]), sample(1000, [['a', 999n]]), sample(62000, [['a', 999n]]), sample(2000, null)]) {
      expect(macProcessGpuPercent(before, next)).toBeNull()
    }
    expect(macProcessGpuPercent(undefined, before)).toBeNull()
    expect(macProcessGpuPercent(before, undefined)).toBeNull()
  })
})
