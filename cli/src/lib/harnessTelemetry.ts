import { execFile } from 'node:child_process'
import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { promisify } from 'node:util'
import { readMacProcessGpu, type MacProcessGpu } from './macosProcessGpu.js'

import type { RegisteredSession } from './registry.js'
import { sessionCheckpoints } from './sessionCheckpoint.js'
import { sessionDataBytes } from './purgeAgentService.js'

const exec = promisify(execFile)
export type ProcessTelemetry = { readBytes: number | null; writeBytes: number | null; gpuMemoryBytes: number | null; gpuPercent?: number | null; macGpu?: MacProcessGpu }
const count = (value: string | undefined) => value != null && /^\d+$/.test(value.trim()) && Number.isSafeInteger(Number(value)) ? Number(value) : null

export function parseProcessIo(text: string): Pick<ProcessTelemetry, 'readBytes' | 'writeBytes'> {
  return { readBytes: count(/^read_bytes:\s*(\d+)\s*$/m.exec(text)?.[1]),
    writeBytes: count(/^write_bytes:\s*(\d+)\s*$/m.exec(text)?.[1]) }
}

/** NVIDIA reports compute allocations, not the remote GPU used by a cloud model.
 * Keep unavailable counters unknown, including processes absent from the report:
 * a graphics-only process or an unsupported GPU must not become a measured zero. */
export function parseProcessGpuMemory(text: string): Map<number, number | null> {
  const devices = new Map<string, { pid: number; bytes: number | null }>()
  for (const line of text.split('\n')) {
    const [pidText, uuid, memory, ...extra] = line.split(',').map(v => v.trim())
    const pid = count(pidText), mib = count(memory)
    if (!pid || !/^GPU-[\w-]+$/.test(uuid ?? '') || extra.length) continue
    devices.set(`${pid}/${uuid}`, { pid, bytes: mib == null ? null : mib * 1024 ** 2 })
  }
  const result = new Map<number, number | null>()
  for (const { pid, bytes } of devices.values()) {
    const before = result.get(pid)
    result.set(pid, bytes == null || before === null ? null : (before ?? 0) + bytes)
  }
  return result
}

export function parseProcessGpuUsage(text: string): Map<number, number | null> {
  const result = new Map<number, number | null>()
  let header: string[] = []
  for (const line of text.split('\n')) {
    const cells = line.trim().split(/\s+/)
    if (cells[0] === '#' && cells.includes('pid') && cells.includes('sm')) { header = cells.slice(1); continue }
    if (!header.length || cells[0] === '#') continue
    const pid = count(cells[header.indexOf('pid')]), sm = count(cells[header.indexOf('sm')])
    if (!pid) continue
    const before = result.get(pid)
    result.set(pid, sm == null || sm > 100 || before === null ? null : (before ?? 0) + sm)
  }
  return result
}

let gpuRetryAfter = 0
async function processGpus(): Promise<{ memory: Map<number, number | null>; usage: Map<number, number | null> }> {
  const empty = () => ({ memory: new Map<number, number | null>(), usage: new Map<number, number | null>() })
  if (process.platform !== 'linux' || Date.now() < gpuRetryAfter) return empty()
  try {
    const options = { timeout: 2200, maxBuffer: 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } }
    const [memory, usage] = await Promise.all([
      exec('nvidia-smi', ['--query-compute-apps=pid,gpu_uuid,used_gpu_memory', '--format=csv,noheader,nounits'], options),
      exec('nvidia-smi', ['pmon', '-s', 'u', '-c', '1'], options).catch(() => ({ stdout: '' })),
    ])
    return { memory: parseProcessGpuMemory(memory.stdout), usage: parseProcessGpuUsage(usage.stdout) }
  } catch { gpuRetryAfter = Date.now() + 60_000; return empty() }
}

/** Only owned processes are returned. No privilege escalation or whole-machine fallback. */
export async function readProcessTelemetry(pids: number[]): Promise<Map<number, ProcessTelemetry>> {
  if (!pids.length) return new Map()
  if (process.platform === 'darwin') {
    const gpu = await readMacProcessGpu(pids)
    return new Map(pids.map(pid => [pid, { readBytes: null, writeBytes: null, gpuMemoryBytes: null,
      macGpu: gpu.get(pid) ?? { sampledAt: performance.now(), contexts: null } }]))
  }
  const gpu = await processGpus(), result = new Map<number, ProcessTelemetry>()
  let index = 0
  await Promise.all(Array.from({ length: Math.min(8, pids.length) }, async () => {
    while (index < pids.length) {
      const pid = pids[index++]
      const io = process.platform === 'linux'
        ? await readFile(`/proc/${pid}/io`, 'utf8').then(parseProcessIo).catch(() => null) : null
      result.set(pid, { readBytes: io?.readBytes ?? null, writeBytes: io?.writeBytes ?? null,
        gpuMemoryBytes: gpu.memory.get(pid) ?? null, gpuPercent: gpu.usage.get(pid) ?? null })
    }
  }))
  return result
}

export type StorageReading = { workspaceBytes: number | null; workspacePath: string | null; workspaceSampledAt: string | null; transcriptBytes: number | null; sessionBytes: number | null }
type Target = Partial<RegisteredSession> & { agentId: string }
type StorageDeps = { now(): number; size(path: string): Promise<number | null>; transcript(path: string): Promise<number | null>; canonical(path: string): Promise<string>; session?(agent: Target): Promise<number | null> }

/** Directory sizes are shared by path and read in a bounded queue, at most once
 * a minute. A process sample never waits for du, and failure is not a zero. */
export function createHarnessStorageReader(deps: StorageDeps = {
  now: Date.now,
  session: async agent => agent.engine ? sessionDataBytes(agent as RegisteredSession, sessionCheckpoints) : null,
  size: async (path: string): Promise<number | null> => {
    if (!isAbsolute(path) || path === '/') return null
    const { stdout } = await exec('du', ['-sk', '-P', path], { timeout: 2500, maxBuffer: 4096 })
    const kb = count(/^(\d+)\s/.exec(stdout)?.[1])
    return kb == null ? null : kb * 1024
  },
  transcript: async (path: string) => { const info = await stat(path); return info.isFile() ? info.size : null },
  canonical: async (path: string): Promise<string> => realpath(path),
}) {
  const cache = new Map<string, { at: number; bytes: number | null; pending: boolean }>()
  const sessionCache = new Map<string, { at: number; bytes: number | null; pending: boolean }>()
  let active = 0
  const queue: Array<() => Promise<void>> = []
  function drain() {
    while (active < 2 && queue.length) {
      active++
      void queue.shift()!().finally(() => { active--; drain() })
    }
  }
  return async (agents: readonly Target[], invalidate = false): Promise<Map<string, StorageReading>> => {
    // A confirmed deletion changes ancestor totals too. Drop queued work and cached values;
    // the two already-running probes finish into detached entries, never into fresh readings.
    if (invalidate) { cache.clear(); sessionCache.clear(); queue.length = 0 }
    const canonical = new Map(await Promise.all([...new Set(agents.map(a => a.cwd).filter((p): p is string => !!p && isAbsolute(p) && p !== '/'))]
      .map(async path => [path, await deps.canonical(path).catch(() => path)] as const)))
    const paths = new Set(canonical.values())
    for (const [path, entry] of cache) if (!paths.has(path) && !entry.pending) cache.delete(path)
    for (const path of paths) {
      let entry = cache.get(path)
      if (entry?.pending || entry && deps.now() - entry.at < 60_000) continue
      if (!entry) { entry = { at: 0, bytes: null, pending: false }; cache.set(path, entry) }
      entry.pending = true
      const target = entry
      queue.push(async () => {
        try { target.bytes = await deps.size(path) } catch { target.bytes = null }
        finally { target.at = deps.now(); target.pending = false }
      })
    }
    const sessionKey = (agent: Target) => JSON.stringify([agent.agentId, agent.engine, agent.sessionId, agent.transcriptPath, agent.codexHome, agent.hermesHome])
    const sessionKeys = new Set(agents.map(sessionKey))
    for (const [key, entry] of sessionCache) if (!sessionKeys.has(key) && !entry.pending) sessionCache.delete(key)
    if (deps.session) for (const agent of agents) {
      const key = sessionKey(agent)
      let entry = sessionCache.get(key)
      if (entry?.pending || entry && deps.now() - entry.at < 60_000) continue
      if (!entry) { entry = { at: 0, bytes: null, pending: false }; sessionCache.set(key, entry) }
      entry.pending = true
      const target = entry
      queue.push(async () => {
        try { target.bytes = await deps.session!(agent) } catch { target.bytes = null }
        finally { target.at = deps.now(); target.pending = false }
      })
    }
    drain()
    const result = new Map<string, StorageReading>()
    await Promise.all(agents.map(async agent => {
      const workspacePath = agent.cwd ? canonical.get(agent.cwd) ?? null : null
      const workspace = workspacePath ? cache.get(workspacePath) : null
      const transcriptBytes = agent.transcriptPath ? await deps.transcript(agent.transcriptPath).catch(() => null) : null
      result.set(agent.agentId, { workspaceBytes: workspace?.bytes ?? null, workspacePath,
        workspaceSampledAt: workspace?.at ? new Date(workspace.at).toISOString() : null, transcriptBytes, sessionBytes: sessionCache.get(sessionKey(agent))?.bytes ?? null })
    }))
    return result
  }
}
