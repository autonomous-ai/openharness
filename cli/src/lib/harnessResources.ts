import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { sessionCodexHome } from './engineHomes.js'
import { promisify } from 'node:util'
import type { ProcessIdentity } from './terminalTypes.js'
import { readProcessTelemetry, type ProcessTelemetry } from './harnessTelemetry.js'
import { macProcessGpuPercent } from './macosProcessGpu.js'
import { processStartTicks } from './processLiveness.js'

const exec = promisify(execFile)
type Agent = { agentId: string; processIdentity?: ProcessIdentity | null; engine?: string; codexHome?: string | null; transcriptPath?: string | null }
export type SharedResourceRoot = { pid: number; start: string; agentIds: string[] }
export interface ResourceProcess {
  pid: number
  parent: number
  memoryBytes: number
  cpuMs: number
  start: string
}
export interface HarnessResource {
  agentId: string
  memoryBytes: number | null
  cpuPercent: number | null
  processCount: number | null
  gpuMemoryBytes?: number | null
  gpuPercent?: number | null
  diskReadBytesPerSecond?: number | null
  diskWriteBytesPerSecond?: number | null
  processes?: Array<{ pid: number; parent: number; memoryBytes: number; cpuPercent: number | null }>
}
export interface HarnessResources {
  sampledAt: string
  agents: HarnessResource[]
  shared?: Array<Omit<HarnessResource, 'agentId'> & { kind: 'codex'; agentIds: string[] }>
}

// Reuses Harness Monitor's single process-table / subtree approach. The daemon
// already knows the owning PID, so no tmux probe, executable-name guessing or
// transcript scan is needed. Cumulative CPU counters give interval use on both
// macOS and Linux; ps %cpu would be a lifetime average on Linux.
export function parseResourceProcesses(text: string): ResourceProcess[] {
  const rows: ResourceProcess[] = []
  for (const line of text.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)\s+(\S+\s+\S+\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s*$/.exec(line)
    if (!match) continue
    const cpuMs = (((Number(match[4] ?? 0) * 24 + Number(match[5] ?? 0)) * 60
      + Number(match[6])) * 60 + Number(match[7])) * 1000
    const memoryBytes = Number(match[3]) * 1024
    if (!Number.isFinite(cpuMs) || !Number.isSafeInteger(memoryBytes)) continue
    rows.push({ pid: Number(match[1]), parent: Number(match[2]), memoryBytes, cpuMs,
      start: match[8].replace(/\s+/g, ' ') })
  }
  return rows
}

async function sampleProcesses(): Promise<ResourceProcess[]> {
  const { stdout } = await exec('ps', ['-axo', 'pid=,ppid=,rss=,time=,lstart='], {
    encoding: 'utf8', timeout: 2000, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, LC_ALL: 'C' },
  })
  const rows = parseResourceProcesses(stdout)
  if (!rows.length) throw new Error('Process readings unavailable')
  return rows
}

/** Read one small identity file per active Codex profile. No transcript scan
 * or server RPC. Its PID must still pass the same birth check as every agent. */
async function sharedCodexRoots(agents: readonly Agent[]): Promise<SharedResourceRoot[]> {
  const profiles = new Map<string, string[]>()
  for (const agent of agents) {
    if (agent.engine !== 'codex' || !agent.processIdentity) continue
    const home = sessionCodexHome(agent)
    profiles.set(home, [...profiles.get(home) ?? [], agent.agentId])
  }
  const roots: SharedResourceRoot[] = []
  for (const [home, agentIds] of profiles) {
    try {
      const text = await readFile(join(home, 'app-server-daemon', 'daemon.pid'), 'utf8')
      if (text.length > 16384) continue
      const value = JSON.parse(text)
      if (Number.isSafeInteger(value.pid) && value.pid > 0 && typeof value.processStartTime === 'string') {
        roots.push({ pid: value.pid, start: value.processStartTime.replace(/\s+/g, ' '), agentIds })
      }
    } catch { /* No running shared server, or its identity cannot be read. */ }
  }
  return roots
}

/** No timer, no retained history and no work until an owning client asks. */
export function createHarnessResourcesReader(agents: () => readonly Agent[], deps: {
  sample: () => Promise<ResourceProcess[]>; now: () => number
  telemetry?: (pids: number[]) => Promise<Map<number, ProcessTelemetry>>
  startTicks?: (pid: number) => number | null
} = {
  sample: sampleProcesses, now: Date.now, telemetry: readProcessTelemetry,
}, sharedRoots: (agents: readonly Agent[]) => Promise<SharedResourceRoot[]> = sharedCodexRoots) {
  let previous: { at: number; rows: Map<number, ResourceProcess> } | undefined
  let previousTelemetry = new Map<number, ProcessTelemetry>()
  let cached: { at: number; value: HarnessResources } | undefined
  let pending: Promise<HarnessResources> | undefined
  async function read(): Promise<HarnessResources> {
    const snapshot = await deps.sample()
    const at = deps.now()
    const byPid = new Map(snapshot.map(row => [row.pid, row]))
    const children = new Map<number, number[]>()
    for (const row of snapshot) {
      const list = children.get(row.parent) ?? []
      list.push(row.pid)
      children.set(row.parent, list)
    }
    const current = agents()
    const owners = new Map<number, string[]>()
    for (const agent of current) {
      const identity = agent.processIdentity
      if (!identity || !byPid.has(identity.pid)) continue
      // A clock step moves `ps lstart` but not the start ticks (ProcessIdentity.startTicks).
      if (byPid.get(identity.pid)!.start !== identity.startMarker.replace(/\s+/g, ' ')
        && (identity.startTicks === undefined || (deps.startTicks ?? processStartTicks)(identity.pid) !== identity.startTicks)) continue
      owners.set(identity.pid, [...owners.get(identity.pid) ?? [], agent.agentId])
    }
    const elapsed = previous ? at - previous.at : 0
    const counted = new Set<number>()
    const trees = new Map<number, number[]>()
    const measure = (root: number) => {
      let memoryBytes = 0, cpuMs = 0, processCount = 0
      let cpuKnown = elapsed > 0 && elapsed <= 60_000
      const queue = [root], seen = new Set<number>()
      while (queue.length) {
        const pid = queue.pop()!
        if (seen.has(pid) || counted.has(pid) || (pid !== root && owners.has(pid))) continue
        seen.add(pid); counted.add(pid)
        const row = byPid.get(pid)
        if (!row) continue
        memoryBytes += row.memoryBytes
        processCount++
        const before = previous?.rows.get(pid)
        if (before?.start === row.start && row.cpuMs >= before.cpuMs) cpuMs += row.cpuMs - before.cpuMs
        else cpuKnown = false
        queue.push(...children.get(pid) ?? [])
      }
      trees.set(root, [...seen])
      return { memoryBytes, processCount, cpuPercent: cpuKnown ? Math.round(cpuMs / elapsed * 1000) / 10 : null }
    }
    const readings = current.map(agent => {
      const unknown: HarnessResource = { agentId: agent.agentId, memoryBytes: null, cpuPercent: null, processCount: null }
      const root = agent.processIdentity?.pid
      // Refuse stale PIDs and duplicate ownership rather than double-counting.
      if (!root || owners.get(root)?.length !== 1 || owners.get(root)?.[0] !== agent.agentId) return unknown
      return { agentId: agent.agentId, ...measure(root) }
    })
    const shared: NonNullable<HarnessResources['shared']> = []
    for (const root of await sharedRoots(current)) {
      if (counted.has(root.pid) || byPid.get(root.pid)?.start !== root.start) continue
      shared.push({ kind: 'codex', agentIds: root.agentIds, ...measure(root.pid) })
    }
    if (deps.telemetry) {
      const telemetry = await deps.telemetry([...counted]).catch(() => new Map<number, ProcessTelemetry>())
      const enrich = (value: HarnessResource | NonNullable<HarnessResources['shared']>[number], pids: number[]) => {
        const gpu = pids.map(pid => telemetry.get(pid)?.gpuMemoryBytes).filter((n): n is number => n != null)
        const macGpu = pids.some(pid => telemetry.get(pid)?.macGpu != null)
        const gpuUsage = pids.map(pid => {
          const next = telemetry.get(pid)
          if (!macGpu) return next?.gpuPercent ?? null
          if (previous?.rows.get(pid)?.start !== byPid.get(pid)?.start) return null
          return macProcessGpuPercent(previousTelemetry.get(pid)?.macGpu, next?.macGpu)
        })
        const knownGpu = gpuUsage.filter((n): n is number => n != null)
        const rate = (key: 'readBytes' | 'writeBytes') => {
          if (!pids.length || elapsed <= 0 || elapsed > 60_000) return null
          let delta = 0
          for (const pid of pids) {
            const before = previousTelemetry.get(pid)?.[key], next = telemetry.get(pid)?.[key]
            if (before == null || next == null || next < before || previous?.rows.get(pid)?.start !== byPid.get(pid)?.start) return null
            delta += next - before
          }
          return delta * 1000 / elapsed
        }
        value.gpuMemoryBytes = gpu.length ? gpu.reduce((sum, n) => sum + n, 0) : null
        value.gpuPercent = knownGpu.length && (!macGpu || knownGpu.length === pids.length)
          ? knownGpu.reduce((sum, n) => sum + n, 0) : null
        value.diskReadBytesPerSecond = rate('readBytes')
        value.diskWriteBytesPerSecond = rate('writeBytes')
        value.processes = pids.flatMap(pid => {
          const row = byPid.get(pid), before = previous?.rows.get(pid)
          if (!row) return []
          return [{ pid, parent: row.parent, memoryBytes: row.memoryBytes,
            cpuPercent: before?.start === row.start && elapsed > 0 && elapsed <= 60_000 && row.cpuMs >= before.cpuMs
              ? Math.round((row.cpuMs - before.cpuMs) / elapsed * 1000) / 10 : null }]
        }).slice(0, 256)
      }
      for (const value of readings) {
        const root = current.find(a => a.agentId === value.agentId)?.processIdentity?.pid
        enrich(value, root && value.processCount != null ? trees.get(root) ?? [] : [])
      }
      // Shared roots were measured after agent trees, in the same insertion order.
      const sharedTrees = [...trees].filter(([pid]) => !owners.has(pid)).map(([, pids]) => pids)
      shared.forEach((value, i) => enrich(value, sharedTrees[i] ?? []))
      previousTelemetry = telemetry
    }
    previous = { at, rows: byPid }
    const value = { sampledAt: new Date(at).toISOString(), agents: readings, ...(shared.length ? { shared } : {}) }
    cached = { at, value }
    return value
  }
  return (): Promise<HarnessResources> => {
    if (pending) return pending
    if (cached && deps.now() - cached.at >= 0 && deps.now() - cached.at < 2500) return Promise.resolve(cached.value)
    pending = read().finally(() => { pending = undefined })
    return pending
  }
}
