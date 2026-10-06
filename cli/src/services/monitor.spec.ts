import { describe, expect, it, vi } from 'vitest'
import { emptyPorts, MONITOR_FALLBACKS, type MonitorPort } from '../core/api.js'
import { createServiceHost } from '../core/serviceHost.js'
import type { RegisteredSession } from '../lib/registry.js'
import { fakeCore } from '../testing/fakeCore.js'
import { MONITOR_REQUESTS, startMonitor, type MonitorDeps } from './monitor.js'

/** This machine's readers, as the daemon builds them: which agents the process sample is taken of. */
const built = vi.hoisted(() => ({ agents: null as null | (() => unknown[]) }))
vi.mock('../lib/harnessResources.js', () => ({
  createHarnessResourcesReader: vi.fn((agents: () => unknown[]) => { built.agents = agents; return async () => ({ sampledAt: 'now', agents: [] }) }),
}))

const ASKER = { local: true, owner: true }
const agent = (agentId: string) => ({ agentId }) as RegisteredSession
const reading = { sampledAt: '2026-10-05T12:00:00.000Z', agents: [{ agentId: 'a1', memoryBytes: 1, cpuPercent: 2, processCount: 1, processes: [] }] }

function setup(over: Partial<MonitorDeps> = {}) {
  const deps: MonitorDeps = {
    machine: vi.fn(async () => ({ cpuPercent: 18, memoryUsedBytes: 10, memoryTotalBytes: 32 })),
    resources: vi.fn(async () => reading),
    storage: vi.fn(async () => new Map([['a1', { workspaceBytes: 5, transcriptBytes: 6 }]])) as unknown as MonitorDeps['storage'],
    ...over,
  }
  const core = fakeCore({ agents: { advertised: vi.fn(() => [agent('a1')]) } })
  const ports = emptyPorts()
  const requests = startMonitor(core, ports, deps)
  return { deps, core, port: ports.monitor as MonitorPort, requests, ask: (payload: Record<string, unknown> = {}) => requests.machine_resources!(payload, ASKER) }
}

describe('the machine monitor', () => {
  it('answers exactly the request it declares, and fills its port', () => {
    const { requests, port } = setup()
    expect(Object.keys(requests)).toEqual([...MONITOR_REQUESTS])
    expect(port).not.toBeNull()
    // Started as the daemon starts it, with this machine's own readers behind it.
    const ports = emptyPorts()
    const core = fakeCore({ agents: { advertised: vi.fn(() => [agent('a1')]) } })
    expect(Object.keys(startMonitor(core, ports))).toEqual([...MONITOR_REQUESTS])
    expect(ports.monitor).not.toBeNull()
    // The processes sampled are those of the agents the apps are shown.
    expect(built.agents!()).toEqual([agent('a1')])
  })

  it('machine_resources: the machine\'s totals, or each agent\'s readings, with their storage when asked', async () => {
    const { ask, deps } = setup()
    expect(await ask()).toEqual({ cpuPercent: 18, memoryUsedBytes: 10, memoryTotalBytes: 32 })
    expect(deps.resources).not.toHaveBeenCalled()
    expect(await ask({ harnesses: true })).toEqual({ harnesses: reading })
    expect(deps.storage).not.toHaveBeenCalled()
    expect(await ask({ harnesses: true, storage: true })).toEqual({
      harnesses: { ...reading, agents: [{ ...reading.agents[0], workspaceBytes: 5, transcriptBytes: 6 }] },
    })
    // The agents the apps are shown: the same ones the readings are taken of.
    expect(deps.storage).toHaveBeenCalledWith([agent('a1')])
    expect(deps.machine).toHaveBeenCalledOnce()
  })

  it('machine_resources: a sample that fails is UNAVAILABLE', async () => {
    expect(await setup({ machine: vi.fn(async () => { throw new Error('ps failed') }) }).ask()).toEqual({ error: 'UNAVAILABLE' })
    expect(await setup({ resources: vi.fn(async () => { throw new Error('ps failed') }) }).ask({ harnesses: true })).toEqual({ error: 'UNAVAILABLE' })
  })

  it('the core\'s list reads the same readers through the port, and a purge forgets through it', async () => {
    const { port, deps } = setup()
    expect(await port.resources()).toBe(reading)
    await port.storage([agent('a1')], true)
    expect(deps.storage).toHaveBeenCalledWith([agent('a1')], true)
  })

  it('through the host, a failing reader answers the port\'s fallbacks: no readings, nothing to forget', async () => {
    const ports = emptyPorts()
    const guarded = createServiceHost(ports, { log: () => {} })
    guarded.start('monitor', (core, staging) => startMonitor(core, staging, {
      machine: vi.fn(async () => ({})) as unknown as MonitorDeps['machine'],
      resources: vi.fn(async () => { throw new Error('ps failed') }),
      storage: vi.fn(async () => { throw new Error('du failed') }) as unknown as MonitorDeps['storage'],
    }), fakeCore(), MONITOR_FALLBACKS, MONITOR_REQUESTS)
    await expect(ports.monitor!.resources()).rejects.toThrow('the monitor service is unavailable')
    expect(await ports.monitor!.storage([], true)).toEqual(new Map())
    expect(guarded.isOff('monitor')).toBe(false)
  })
})
