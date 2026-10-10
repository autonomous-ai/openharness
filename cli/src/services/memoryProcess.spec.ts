import { afterEach, describe, expect, it, vi } from 'vitest'
import { runServiceProcess, type ServiceProcessOptions } from './process.js'
import { runMemoryService } from './memoryProcess.js'

// The real default reaches a real socket: never in a test.
vi.mock('./process.js', () => ({ runServiceProcess: vi.fn(() => ({ stop: vi.fn() })) }))

describe('memory in its own process', () => {
  afterEach(() => vi.clearAllMocks())

  it('answers with the same handlers as in the core\'s process', async () => {
    let options: ServiceProcessOptions | null = null
    const service = { stop: vi.fn() }
    const handle = runMemoryService({
      dataDir: '/data', socketPath: '/data/daemon-1.sock', machineId: 'm', token: 't',
      run: (given) => { options = given; return service },
      start: () => ({ memory_snapshot: async () => ({ snapshot: { memories: [] } }), memory_about_put: async () => ({ ok: true }), memory_deliver: async () => ({ ok: true }) }),
    })
    expect(handle).toBe(service)
    expect(options).toMatchObject({ name: 'memory', socketPath: '/data/daemon-1.sock', machineId: 'm', token: 't' })
    expect(await options!.requests.memory_snapshot!({}, { local: true, owner: true })).toEqual({ snapshot: { memories: [] } })
  })

  it('runs as a real service by default', () => {
    runMemoryService({ dataDir: '/data', socketPath: '/data/daemon-1.sock', machineId: 'm', token: 't' })
    expect(runServiceProcess).toHaveBeenCalledWith(expect.objectContaining({
      name: 'memory', requests: { memory_snapshot: expect.any(Function), memory_about_put: expect.any(Function), memory_deliver: expect.any(Function) },
    }))
  })
})
