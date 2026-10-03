import { cpus } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { readMachineMemory, readMachineGpus, readMachineDisk, type GpuResource, type MemoryPressure, type MemoryReading } from './machineHardware.js'

export interface MachineResources {
  cpuPercent: number | null
  memoryUsedBytes: number | null
  memoryTotalBytes: number | null
  memoryPressure?: MemoryPressure | null
  swapUsedBytes?: number | null
  diskFreeBytes?: number | null
  diskTotalBytes?: number | null
  gpus?: GpuResource[]
}

type CpuTimes = { idle: number; total: number }
function cpuTimes(): CpuTimes {
  return cpus().reduce((sum, cpu) => ({
    idle: sum.idle + cpu.times.idle,
    total: sum.total + Object.values(cpu.times).reduce((a, b) => a + b, 0),
  }), { idle: 0, total: 0 })
}

/** Demand-driven system readings. Concurrent panels share one sample, with no
 * background timer or shell process while nobody is asking for machine stats. */
export function createMachineResourcesReader(deps: {
  cpuTimes: () => CpuTimes
  memory: () => Promise<MemoryReading>
  wait: () => Promise<void>
  now: () => number
  hardware?: () => Promise<Partial<MachineResources>>
} = {
  cpuTimes, memory: readMachineMemory, wait: () => delay(200), now: Date.now,
  hardware: async () => {
    const [gpus, disk] = await Promise.all([readMachineGpus(), readMachineDisk()])
    return { gpus, ...disk }
  },
}): () => Promise<MachineResources> {
  let cached: { at: number; value: MachineResources } | undefined
  let pending: Promise<MachineResources> | undefined
  async function sample(): Promise<MachineResources> {
    const before = deps.cpuTimes()
    const [, mem, hardware] = await Promise.all([
      deps.wait(), deps.memory(), deps.hardware?.().catch(() => ({})) ?? Promise.resolve({}),
    ])
    const after = deps.cpuTimes()
    const elapsed = after.total - before.total
    const idle = after.idle - before.idle
    const cpuPercent = Number.isFinite(elapsed) && Number.isFinite(idle)
      && elapsed > 0 && idle >= 0 && idle <= elapsed
      ? Math.round((1 - idle / elapsed) * 1000) / 10 : null
    const validMemory = Number.isFinite(mem.total) && mem.total > 0
      && Number.isFinite(mem.available) && mem.available >= 0 && mem.available <= mem.total
    const value = {
      ...hardware,
      cpuPercent,
      memoryUsedBytes: validMemory ? mem.total - mem.available : null,
      memoryTotalBytes: validMemory ? mem.total : null,
      ...(mem.pressure === undefined ? {} : { memoryPressure: mem.pressure }),
      ...(mem.swapUsedBytes === undefined ? {} : { swapUsedBytes: mem.swapUsedBytes }),
    }
    cached = { at: deps.now(), value }
    return value
  }
  return () => {
    if (pending) return pending
    if (cached && deps.now() - cached.at < 2000) return Promise.resolve(cached.value)
    pending = sample().finally(() => { pending = undefined })
    return pending
  }
}

export const readMachineResources = createMachineResourcesReader()
