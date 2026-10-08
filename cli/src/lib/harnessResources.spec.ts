import { describe, expect, it, vi } from 'vitest'
import { createHarnessResourcesReader, parseResourceProcesses, type ResourceProcess } from './harnessResources.js'
import type { ProcessTelemetry } from './harnessTelemetry.js'

const start = 'Wed Sep 30 10:00:00 2026'
const row = (pid: number, parent = 1, memoryBytes = 100, cpuMs = 10): ResourceProcess => ({ pid, parent, memoryBytes, cpuMs, start })
const agent = (agentId: string, pid: number) => ({ agentId, processIdentity: { pid, startMarker: start, executable: 'engine' } })

describe('Harness Monitor readings', () => {
  it('parses macOS and Linux counters, retaining start identities and valid zero', () => {
    expect(parseResourceProcesses(`1 0 12 0:01.20 Wed Sep 30 10:00:00 2026
2 1 0 02:03:04 Wed Sep 30 10:00:00 2026
3 1 200 1-02:03:04 Wed Sep 30 10:00:00 2026
not a process`)).toEqual([
      { ...row(1, 0, 12288, 1200) },
      { ...row(2, 1, 0, 7384000) },
      { ...row(3, 1, 204800, 93784000) },
    ])
  })

  it('counts each process once across helpers, nested agents and unrelated applications', async () => {
    const sample = vi.fn(async () => [row(10), row(11, 10), row(12, 11), row(13, 12), row(90)])
    const read = createHarnessResourcesReader(() => [agent('parent', 10), agent('child', 12)], { sample, now: () => 10_000 })
    expect(sample).not.toHaveBeenCalled()
    expect((await read()).agents).toEqual([
      { agentId: 'parent', memoryBytes: 200, processCount: 2, cpuPercent: null },
      { agentId: 'child', memoryBytes: 200, processCount: 2, cpuPercent: null },
    ])
  })

  it('reports interval CPU, including more than one core, with no second sample on demand', async () => {
    let now = 10_000, cpuMs = 100
    const read = createHarnessResourcesReader(() => [agent('a', 10)], {
      sample: async () => [row(10, 1, 0, cpuMs)], now: () => now,
    })
    expect((await read()).agents[0].cpuPercent).toBeNull()
    now += 5000; cpuMs += 12_500
    expect((await read()).agents[0]).toMatchObject({ cpuPercent: 250, memoryBytes: 0 })
    now += 5000
    expect((await read()).agents[0].cpuPercent).toBe(0)
    now += 61_000
    expect((await read()).agents[0].cpuPercent).toBeNull()
  })

  it('never attributes reused PIDs, duplicate roots or missing identities to an agent', async () => {
    const read = createHarnessResourcesReader(() => [
      agent('old', 10), agent('duplicate1', 20), agent('duplicate2', 20), { agentId: 'missing' },
    ], { sample: async () => [{ ...row(10), start: 'new process' }, row(20)], now: () => 10_000 })
    for (const result of (await read()).agents) {
      expect(result).toMatchObject({ memoryBytes: null, cpuPercent: null, processCount: null })
    }
  })

  it('still attributes a process whose ps start time moved with the clock, by its start ticks', async () => {
    const ticked = (agentId: string, pid: number, startTicks: number) =>
      ({ agentId, processIdentity: { ...agent(agentId, pid).processIdentity, startTicks } })
    const read = createHarnessResourcesReader(() => [ticked('stepped', 10, 500), ticked('reused', 20, 600)], {
      sample: async () => [{ ...row(10), start: 'Thu Oct 1 01:00:00 2026' }, { ...row(20), start: 'Thu Oct 1 01:00:00 2026' }],
      now: () => 10_000, startTicks: (pid) => pid === 10 ? 500 : 601,
    })
    expect((await read()).agents).toEqual([
      { agentId: 'stepped', memoryBytes: 100, processCount: 1, cpuPercent: null },
      { agentId: 'reused', memoryBytes: null, processCount: null, cpuPercent: null },
    ])
  })

  it('coalesces concurrent clients, expires cached data and retries failed reads', async () => {
    let now = 10_000
    let finish!: (rows: ResourceProcess[]) => void
    const sample = vi.fn(() => new Promise<ResourceProcess[]>(resolve => { finish = resolve }))
    const read = createHarnessResourcesReader(() => [agent('a', 10)], { sample, now: () => now })
    const first = read()
    expect(read()).toBe(first)
    finish([row(10)])
    const value = await first
    now += 2499
    expect(await read()).toBe(value)
    expect(sample).toHaveBeenCalledTimes(1)
    now++
    sample.mockRejectedValueOnce(new Error('denied'))
    await expect(read()).rejects.toThrow('denied')
    sample.mockResolvedValueOnce([row(10)])
    expect((await read()).agents[0].memoryBytes).toBe(100)
  })

  it('does not follow corrupt parent cycles indefinitely or reuse prior samples after exits', async () => {
    let now = 10_000
    const sample = vi.fn(async () => [row(10, 11), row(11, 10)])
    const read = createHarnessResourcesReader(() => [agent('a', 10)], { sample, now: () => now })
    expect((await read()).agents[0].memoryBytes).toBe(200)
    now += 3000; sample.mockResolvedValueOnce([])
    expect((await read()).agents[0].memoryBytes).toBeNull()
  })
})

it('counts a detached shared server once, without assigning its whole RAM to every session', async () => {
  const agents = [agent('a', 10), agent('b', 20)]
  let time = 10_000
  const shared = vi.fn(async () => [
    { pid: 50, start, agentIds: ['a', 'b'] },
    { pid: 50, start, agentIds: ['a', 'b'] },
    { pid: 60, start: 'recycled', agentIds: ['a'] },
    { pid: 11, start, agentIds: ['a'] },
  ])
  const read = createHarnessResourcesReader(() => agents, {
    sample: async () => [row(10), row(11, 10), row(20), row(50), row(51, 50), row(60)],
    now: () => time,
  }, shared)
  const first = await read()
  expect(first.agents.map(row => row.memoryBytes)).toEqual([200, 100])
  expect(first.shared).toEqual([{ kind: 'codex', agentIds: ['a', 'b'], memoryBytes: 200, processCount: 2, cpuPercent: null }])
  time += 3000
  expect((await read()).shared![0].cpuPercent).toBe(0)
})

it('attributes GPU and disk rates only to owned trees and validates counter identity', async () => {
  let now = 10_000, readBytes = 1000
  const telemetry = vi.fn(async () => new Map([
    [10, { readBytes, writeBytes: readBytes * 2, gpuMemoryBytes: null, gpuPercent: null }],
    [11, { readBytes: 0, writeBytes: 0, gpuMemoryBytes: 200, gpuPercent: 15 }],
    [90, { readBytes: 9000, writeBytes: 9000, gpuMemoryBytes: 9000, gpuPercent: 80 }],
  ]))
  let snapshot = [row(10), row(11, 10), row(90)]
  const read = createHarnessResourcesReader(() => [agent('a', 10)], { now: () => now, sample: async () => snapshot, telemetry })
  expect((await read()).agents[0]).toMatchObject({ gpuMemoryBytes: 200, gpuPercent: 15, diskReadBytesPerSecond: null })
  expect(telemetry).toHaveBeenCalledWith([10, 11])
  now += 5000; readBytes += 1000
  expect((await read()).agents[0]).toMatchObject({ diskReadBytesPerSecond: 200, diskWriteBytesPerSecond: 400, processCount: 2 })
  now += 5000; snapshot = [row(10), { ...row(11, 10), start: 'replacement' }]
  expect((await read()).agents[0].diskReadBytesPerSecond).toBeNull()
})

it('attributes macOS GPU intervals to harness children and shared servers once, never other apps or reused PIDs', async () => {
  let now = 10_000, sampleAt = 1000, gpuNs = 0n
  let snapshot = [row(10), row(11, 10), row(12, 11), row(20), row(50), row(90)]
  const telemetry = vi.fn(async (pids: number[]) => new Map(pids.map(pid => [pid, {
    readBytes: null, writeBytes: null, gpuMemoryBytes: null,
    macGpu: { sampledAt: sampleAt, contexts: new Map(pid === 10 || pid === 20 ? [] : [[String(pid), gpuNs]]) },
  } satisfies ProcessTelemetry])))
  const read = createHarnessResourcesReader(() => [agent('a', 10), agent('nested', 12), agent('idle', 20)], {
    now: () => now, sample: async () => snapshot, telemetry,
  }, async () => [{ pid: 50, start, agentIds: ['a', 'idle'] }, { pid: 50, start, agentIds: ['a', 'idle'] }])
  expect((await read()).agents.every(value => value.gpuPercent === null)).toBe(true)
  now += 5000; sampleAt += 4000; gpuNs += 1000000000n
  const measured = await read()
  expect(measured.agents.map(value => value.gpuPercent)).toEqual([25, 25, 0])
  expect(measured.shared).toHaveLength(1)
  expect(measured.shared![0].gpuPercent).toBe(25)
  expect(telemetry).toHaveBeenLastCalledWith([10, 11, 12, 20, 50])
  expect(() => JSON.stringify(measured)).not.toThrow() // raw BigInt counters stay local
  now += 5000; sampleAt += 5000; gpuNs += 1000000000n
  snapshot = snapshot.map(value => value.pid === 11 ? { ...value, start: 'reused PID' } : value)
  expect((await read()).agents[0].gpuPercent).toBeNull()
  now += 5000
  telemetry.mockRejectedValueOnce(new Error('unavailable'))
  expect((await read()).agents[0].gpuPercent).toBeNull()
  now += 5000; sampleAt += 10000
  expect((await read()).agents[0].gpuPercent).toBeNull()
})
