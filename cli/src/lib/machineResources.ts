import { cpus, freemem, totalmem } from 'node:os'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'

export interface MachineResources {
  cpuPercent: number | null
  memoryUsedBytes: number | null
  memoryTotalBytes: number | null
}

type CpuTimes = { idle: number; total: number }
function cpuTimes(): CpuTimes {
  return cpus().reduce((sum, cpu) => ({
    idle: sum.idle + cpu.times.idle,
    total: sum.total + Object.values(cpu.times).reduce((a, b) => a + b, 0),
  }), { idle: 0, total: 0 })
}

async function memory(): Promise<{ total: number; available: number }> {
  const total = totalmem()
  if (process.platform === 'linux') {
    try {
      // Reclaimable cache is available for work; MemFree alone counts it as used.
      const info = await readFile('/proc/meminfo', 'utf8')
      const available = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(info)?.[1]
      if (available != null) return { total, available: Number(available) * 1024 }
    } catch { /* Older/restricted hosts still have the portable OS reading. */ }
  }
  return { total, available: freemem() }
}

/** Demand-driven system readings. Concurrent panels share one sample, with no
 * background timer or shell process while nobody is asking for machine stats. */
export function createMachineResourcesReader(deps = {
  cpuTimes, memory, wait: () => delay(200), now: Date.now,
}): () => Promise<MachineResources> {
  let cached: { at: number; value: MachineResources } | undefined
  let pending: Promise<MachineResources> | undefined
  async function sample(): Promise<MachineResources> {
    const before = deps.cpuTimes()
    await deps.wait()
    const after = deps.cpuTimes()
    const elapsed = after.total - before.total
    const idle = after.idle - before.idle
    const cpuPercent = Number.isFinite(elapsed) && Number.isFinite(idle)
      && elapsed > 0 && idle >= 0 && idle <= elapsed
      ? Math.round((1 - idle / elapsed) * 1000) / 10 : null
    const mem = await deps.memory()
    const validMemory = Number.isFinite(mem.total) && mem.total > 0
      && Number.isFinite(mem.available) && mem.available >= 0 && mem.available <= mem.total
    const value = {
      cpuPercent,
      memoryUsedBytes: validMemory ? mem.total - mem.available : null,
      memoryTotalBytes: validMemory ? mem.total : null,
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
