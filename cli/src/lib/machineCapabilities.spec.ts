// Originally written by Fred Nix (@nixfred) in github.com/nixfred/openharness (MIT).

import { describe, expect, it } from 'vitest'
import {
  decidePlacement, describeCapabilities, parseNvidiaSmi, readMachineCapabilities,
  type CapabilityReaders, type MachineCapabilities,
} from './machineCapabilities.js'

function readers(over: Partial<CapabilityReaders> & { files?: Record<string, string>; dirs?: Record<string, string[]> } = {}): CapabilityReaders {
  const files = over.files ?? {}
  const dirs = over.dirs ?? {}
  return {
    nvidiaSmi: over.nvidiaSmi ?? (async () => { throw new Error('no nvidia-smi') }),
    readFile: over.readFile ?? (async (p) => { if (p in files) return files[p]!; throw new Error('ENOENT ' + p) }),
    listDir: over.listDir ?? (async (p) => { if (p in dirs) return dirs[p]!; throw new Error('ENOENT ' + p) }),
    which: over.which ?? (async (c) => c === 'git'),
    hostname: over.hostname ?? (() => 'testbox'),
    loadavg: over.loadavg ?? (() => [0.5, 0.4, 0.3]),
    cores: over.cores ?? (() => 8),
    now: over.now ?? (() => 1700000000000),
  }
}

describe('parseNvidiaSmi', () => {
  it('parses one line per card and tolerates blanks', () => {
    const out = parseNvidiaSmi('NVIDIA GeForce RTX 5070 Laptop GPU, 12227, 1834, 7\n\n')
    expect(out).toEqual([{ name: 'NVIDIA GeForce RTX 5070 Laptop GPU', vramTotalMb: 12227, vramUsedMb: 1834, utilizationPct: 7 }])
  })
  it('returns an empty list for empty output', () => {
    expect(parseNvidiaSmi('')).toEqual([])
  })
})

describe('readMachineCapabilities', () => {
  it('reads GPU, power, thermal, lid and toolchains from injected readers', async () => {
    const caps = await readMachineCapabilities(readers({
      nvidiaSmi: async () => 'RTX 4050, 6141, 512, 3',
      dirs: { '/sys/class/power_supply': ['AC', 'BAT1'], '/sys/class/thermal': ['thermal_zone0', 'cooling_device0'], '/proc/acpi/button/lid': ['LID0'] },
      files: {
        '/sys/class/power_supply/AC/type': 'Mains\n', '/sys/class/power_supply/AC/online': '0\n',
        '/sys/class/power_supply/BAT1/type': 'Battery\n', '/sys/class/power_supply/BAT1/capacity': '42\n', '/sys/class/power_supply/BAT1/status': 'Discharging\n',
        '/sys/class/thermal/thermal_zone0/temp': '67000\n',
        '/proc/acpi/button/lid/LID0/state': 'state:      closed\n',
      },
    }))
    expect(caps.gpus[0]?.vramUsedMb).toBe(512)
    expect(caps.power).toEqual({ onAc: false, batteryPct: 42 })
    expect(caps.thermal.maxC).toBe(67)
    expect(caps.lid).toBe('closed')
    expect(caps.toolchains.git).toBe(true)
    expect(caps.toolchains.flutter).toBe(false)
    expect(caps.hostname).toBe('testbox')
  })
  it('degrades to no GPU, AC, unknown lid on a headless box without sysfs entries', async () => {
    const caps = await readMachineCapabilities(readers())
    expect(caps.gpus).toEqual([])
    expect(caps.power).toEqual({ onAc: true, batteryPct: null })
    expect(caps.thermal.maxC).toBeNull()
    expect(caps.lid).toBe('unknown')
  })
})

const base: MachineCapabilities = {
  at: 0, hostname: 'gus', cpu: { cores: 24, load1: 2, load5: 2 },
  gpus: [{ name: 'RTX 5070', vramTotalMb: 12227, vramUsedMb: 2000, utilizationPct: 5 }],
  power: { onAc: true, batteryPct: 100 }, thermal: { maxC: 55 }, lid: 'open',
  toolchains: { git: true, node: true, flutter: false },
}

describe('decidePlacement', () => {
  it('accepts an empty request on a healthy machine', () => {
    expect(decidePlacement(base, {})).toEqual({ ok: true, reasons: [] })
  })
  it('refuses GPU work on a busy card and says why', () => {
    const busy = { ...base, gpus: [{ ...base.gpus[0]!, utilizationPct: 85 }] }
    const d = decidePlacement(busy, { needsGpu: true })
    expect(d.ok).toBe(false)
    expect(d.reasons).toEqual(['GPU busy at 85%'])
  })
  it('refuses when free VRAM is under the minimum', () => {
    const d = decidePlacement(base, { needsGpu: true, minFreeVramMb: 11000 })
    expect(d.reasons[0]).toMatch(/10227 MB free, needs 11000 MB/)
  })
  it('refuses GPU work where there is no GPU', () => {
    expect(decidePlacement({ ...base, gpus: [] }, { needsGpu: true }).reasons).toEqual(['no GPU on this machine'])
  })
  it('refuses batch work on battery unless allowed, and a closed lid on a laptop', () => {
    const laptop = { ...base, power: { onAc: false, batteryPct: 30 }, lid: 'closed' as const }
    expect(decidePlacement(laptop, {}).reasons).toEqual(['on battery', 'lid closed on a laptop'])
    expect(decidePlacement(laptop, { allowOnBattery: true, allowLidClosed: true }).ok).toBe(true)
  })
  it('lets interactive work through a closed lid (external monitor) but not battery', () => {
    const laptop = { ...base, power: { onAc: false, batteryPct: 30 }, lid: 'closed' as const }
    expect(decidePlacement(laptop, { interactive: true }).reasons).toEqual(['on battery'])
  })
  it('flags CPU overload, heat and missing toolchains', () => {
    const hot = { ...base, cpu: { cores: 4, load1: 9, load5: 8 }, thermal: { maxC: 95 } }
    const d = decidePlacement(hot, { toolchains: ['flutter', 'git'] })
    expect(d.reasons).toEqual(['CPU load 9.0 over 4 cores', 'thermal 95C', 'missing flutter'])
  })
})

describe('describeCapabilities', () => {
  it('renders one line', () => {
    expect(describeCapabilities(base)).toBe('gus: RTX 5070 10227/12227MB free 5%, load 2.0/24, AC 55C, lid open')
    expect(describeCapabilities({ ...base, gpus: [], power: { onAc: false, batteryPct: 12 }, thermal: { maxC: null } }))
      .toBe('gus: no GPU, load 2.0/24, battery 12%, lid open')
  })
})
