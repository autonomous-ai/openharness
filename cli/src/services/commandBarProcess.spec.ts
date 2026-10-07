import { afterEach, describe, expect, it, vi } from 'vitest'
import { runServiceProcess, type ServiceProcessOptions } from './process.js'
import { runCommandBarService } from './commandBarProcess.js'

// The real default reaches a real socket: never in a test.
vi.mock('./process.js', () => ({ runServiceProcess: vi.fn(() => ({ stop: vi.fn() })) }))

describe('the command bar in its own process', () => {
  afterEach(() => vi.clearAllMocks())

  it('answers with the same handlers as in the core\'s process', async () => {
    let options: ServiceProcessOptions | null = null
    const service = { stop: vi.fn() }
    const handle = runCommandBarService({
      dataDir: '/data', socketPath: '/data/daemon-1.sock', machineId: 'm', token: 't',
      run: (given) => { options = given; return service },
      start: () => ({ command_bar: async () => ({ selectedId: null }), command_bar_http: async () => ({ status: 200, body: {} }) }),
    })
    expect(handle).toBe(service)
    expect(options).toMatchObject({ name: 'commandBar', socketPath: '/data/daemon-1.sock', machineId: 'm', token: 't' })
    expect(await options!.requests.command_bar!({}, { local: true, owner: true })).toEqual({ selectedId: null })
  })

  it('runs as a real service by default', () => {
    runCommandBarService({ dataDir: '/data', socketPath: '/data/daemon-1.sock', machineId: 'm', token: 't' })
    expect(runServiceProcess).toHaveBeenCalledWith(expect.objectContaining({
      name: 'commandBar', requests: { command_bar: expect.any(Function), command_bar_http: expect.any(Function) },
    }))
  })
})
