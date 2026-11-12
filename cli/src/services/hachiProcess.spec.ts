import { describe, expect, it, vi } from 'vitest'
import { runServiceProcess, type CoreConnection, type ServiceProcessOptions } from './process.js'
import type { startHachi } from './hachi.js'
import { runHachiService } from './hachiProcess.js'

// The real default reaches a real socket: never in a test.
vi.mock('./process.js', () => ({ runServiceProcess: vi.fn(() => ({ stop: vi.fn() })) }))

describe('Hachi\'s side of the daemon in its own process', () => {
  it('asks the core for the live agents and how its daemon is reached before each look, counts through it, and stops with its process', async () => {
    let options: ServiceProcessOptions | null = null
    const stopProcess = vi.fn()
    const stopHachi = vi.fn()
    let given: Parameters<typeof startHachi> | null = null
    const service = runHachiService({ dataDir: '/data', socketPath: '/data/daemon.sock', machineId: 'm', token: 't',
      run: (o) => { options = o; return { stop: stopProcess } },
      start: (...args) => { given = args; return { stop: stopHachi } } })
    expect(options!).toMatchObject({ name: 'hachi', requests: {} })
    const [core, deps] = given!
    // No core yet: no agents, nothing to count with.
    await deps!.refresh!()
    expect(core.agents.live()).toEqual([])
    const query = vi.fn(async (name: string): Promise<Record<string, unknown>> => name === 'live' ? { agents: [{ agentId: 'hachi' }] }
      : name === 'daemon' ? { command: 'harness', port: 18473, machineId: 'machine-1', autonomousEnv: 'prod' } : { ok: true })
    options!.onConnected!({ query } satisfies CoreConnection)
    await deps!.refresh!()
    expect(core.agents.live().map((s) => s.agentId)).toEqual(['hachi'])
    expect(core.daemon.port).toBe(18473)
    core.count!('hachi_wake_done')
    expect(query).toHaveBeenLastCalledWith('count', { metric: 'hachi_wake_done' })
    service.stop()
    expect(stopHachi).toHaveBeenCalledOnce()
    expect(stopProcess).toHaveBeenCalledOnce()
  })

  it('runs as a real service by default', () => {
    const service = runHachiService({ dataDir: '/nowhere-hachi', socketPath: '/nowhere-hachi/daemon.sock', machineId: 'm', token: 't' })
    expect(vi.mocked(runServiceProcess).mock.calls.at(-1)![0].name).toBe('hachi')
    service.stop()
  })
})
