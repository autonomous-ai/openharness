import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)
export type MacProcessGpu = { sampledAt: number; contexts: Map<string, bigint> | null }
type RegistryGpu = { processes: Map<number, Map<string, bigint> | null>; complete: boolean }

const nanoseconds = (text: string): bigint | null => {
  if (!/^\d+$/.test(text)) return null
  const value = BigInt(text)
  return value <= 0xffffffffffffffffn ? value : null
}

/** IOAccelerator clients expose cumulative nanoseconds: AppUsage on AGX
 * (Apple Silicon), or accumulatedGPUTime directly on Intel/AMD contexts.
 * Device PerformanceStatistics are deliberately ignored: those include every
 * application. Registry entry IDs preserve context identity between samples.
 */
export function parseMacProcessGpu(text: string): RegistryGpu {
  const processes: RegistryGpu['processes'] = new Map()
  const devices = new Map<string, { readable: boolean; owners: Set<number> }>()
  const seen = new Set<string>()
  let device = '', valid = true
  let node: { id: string; owner?: string; usage?: string; time?: string; closed: boolean } | undefined
  const finish = () => {
    if (!node) return
    if (!node.closed) { valid = false; return }
    // ioreg can visit the same accelerator twice. Its counters keep advancing
    // while the dump is printed, so retain the first observation of each ID.
    if (seen.has(node.id)) return
    seen.add(node.id)
    const owner = /^"pid ([1-9]\d*), [^\n]*"$/.exec(node.owner ?? '')
    if (!owner || !Number.isSafeInteger(Number(owner[1]))) return
    const pid = Number(owner[1])
    devices.get(device)?.owners.add(pid)
    if (node.usage == null && node.time == null) return
    const counters = new Map<string, bigint>()
    let known = true
    if (node.usage != null) {
      // ioreg -w 0 prints each property on one untruncated line. AppUsage is
      // an array of flat dictionaries, one per graphics API.
      const entries = node.usage.match(/\{[^{}]*\}/g) ?? []
      if (!entries.length || !/^\([\s,]*\)$/.test(node.usage.replace(/\{[^{}]*\}/g, ''))) known = false
      for (const [i, entry] of entries.entries()) {
        const api = /"API"\s*=\s*"([^"\\]+)"/.exec(entry)?.[1] ?? String(i)
        const raw = /(?:\{|,)\s*"accumulatedGPUTime"\s*=\s*([^,}]+)/.exec(entry)?.[1].trim()
        const value = raw == null ? null : nanoseconds(raw)
        if (value == null || counters.has(api)) known = false
        else counters.set(api, value)
      }
    } else {
      const value = nanoseconds(node.time!)
      if (value == null) known = false
      else counters.set('context', value)
    }
    if (!known) { processes.set(pid, null); return }
    const accelerator = devices.get(device)
    if (accelerator) accelerator.readable = true
    if (processes.get(pid) === null) return
    const previous = processes.get(pid) ?? new Map<string, bigint>()
    for (const [api, value] of counters) {
      const key = `${node.id}/${api}`
      previous.set(key, value)
    }
    processes.set(pid, previous)
  }
  for (const line of text.split('\n')) {
    const header = /^([ |]*)\+-o .+ <class [^,]+, id (0x[\da-f]+),/i.exec(line)
    if (header) {
      finish()
      if (!header[1].length) {
        device = header[2]
        if (!devices.has(device)) devices.set(device, { readable: false, owners: new Set() })
      }
      node = { id: header[2], closed: false }
    } else if (node) {
      if (/^[ |]*}\s*$/.test(line)) node.closed = true
      const property = /^[ |]*"(IOUserClientCreator|AppUsage|accumulatedGPUTime)"\s*=\s*(.*)$/.exec(line)
      if (property?.[1] === 'IOUserClientCreator') node.owner = property[2]
      else if (property?.[1] === 'AppUsage') node.usage = property[2]
      else if (property?.[1] === 'accumulatedGPUTime') node.time = property[2]
    }
  }
  finish()
  // An unused secondary GPU has no clients and must not hide a primary GPU's
  // readings. Processes using a driver without counters remain unknown.
  for (const accelerator of devices.values()) {
    if (!accelerator.readable) for (const pid of accelerator.owners) processes.set(pid, null)
  }
  return { processes, complete: valid && [...devices.values()].some(value => value.readable) }
}

let retryAfter = 0
export async function readMacProcessGpu(pids: number[]): Promise<Map<number, MacProcessGpu>> {
  if (!pids.length || Date.now() < retryAfter) return new Map()
  try {
    const { stdout } = await exec('/usr/sbin/ioreg', ['-r', '-c', 'IOAccelerator', '-l', '-w', '0'], {
      encoding: 'utf8', timeout: 2200, maxBuffer: 8 * 1024 * 1024,
    })
    const sampledAt = performance.now(), snapshot = parseMacProcessGpu(stdout)
    return new Map(pids.map(pid => [pid, { sampledAt,
      contexts: snapshot.complete ? snapshot.processes.get(pid) ?? (snapshot.processes.has(pid) ? null : new Map()) : null,
    }]))
  } catch {
    retryAfter = Date.now() + 60_000
    return new Map()
  }
}

/** First sample, counter resets and context churn are unknown for one interval.
 * The caller must also validate the process birth identity before using this. */
export function macProcessGpuPercent(before: MacProcessGpu | undefined, next: MacProcessGpu | undefined): number | null {
  if (!before?.contexts || !next?.contexts || before.contexts.size !== next.contexts.size) return null
  const elapsed = next.sampledAt - before.sampledAt
  if (elapsed <= 0 || elapsed > 60_000) return null
  let delta = 0n
  for (const [id, value] of next.contexts) {
    const previous = before.contexts.get(id)
    if (previous == null || value < previous) return null
    delta += value - previous
  }
  return Math.round(Number(delta) / (elapsed * 10_000) * 10) / 10
}
