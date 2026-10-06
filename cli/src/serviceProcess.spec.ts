import { afterEach, describe, expect, it, vi } from 'vitest'
import { SERVICE_RUNNERS, startServiceProcess, type ServiceProcessOptions } from './serviceProcess.js'
import type { ServiceHost, ServiceHostOptions, ServiceProcess } from './services/process.js'
import { KNOWN_SERVICES } from './harnessd/services.js'

const local = vi.hoisted(() => ({ socket: '/data/daemon-18473.sock' as string | null }))
vi.mock('./lib/localSocket.js', async (real) => ({ ...await real<object>(), localSocketPath: () => local.socket }))
// The test's own console stays as it is: it is shared with every other test in this worker.
const stamped = vi.hoisted(() => ({ times: 0 }))
vi.mock('./lib/log.js', async (real) => ({ ...await real<object>(), installTimestampedConsole: () => { stamped.times++ } }))

describe('a service in its own process', () => {
  const title = process.title
  afterEach(() => { process.title = title; local.socket = '/data/daemon-18473.sock'; vi.restoreAllMocks() })

  it('can run every service the master knows, and loads each one\'s runner on its own', async () => {
    expect([...SERVICE_RUNNERS.keys()].sort()).toEqual([...KNOWN_SERVICES].sort())
    for (const [name, load] of SERVICE_RUNNERS) expect(typeof await load(), name).toBe('function')
    // Every service's own code, imported: seconds on a loaded machine, not the default five.
  }, 60_000)

  /** A process that touches no channel, signal or exit: what it was asked to run, and what it was given. */
  const fakeHost = () => {
    const hosted: Array<{ options: ServiceHostOptions; services: ServiceProcess[] }> = []
    const host = (options: ServiceHostOptions): ServiceHost => {
      const entry = { options, services: [] as ServiceProcess[] }
      hosted.push(entry)
      return { add: (service) => { entry.services.push(service) }, leave: () => {} }
    }
    return { host, hosted }
  }

  it('runs the one it is named, against the core\'s socket, with the master\'s token', async () => {
    const seen: ServiceProcessOptions[] = []
    const handle = { stop: vi.fn() }
    const loaded: string[] = []
    const runners = new Map([
      ['search', async () => { loaded.push('search'); return (options: ServiceProcessOptions) => { seen.push(options); return handle } }],
      ['viewers', async () => { loaded.push('viewers'); return () => handle }],
    ])
    const { host, hosted } = fakeHost()
    process.env.HARNESSD_SERVICE_TOKEN = 'token'
    try {
      await startServiceProcess('search', { runners, host })
    } finally { delete process.env.HARNESSD_SERVICE_TOKEN }
    expect(loaded).toEqual(['search'])
    expect(process.title).toBe('harnessd-search')
    // Its lines are stamped like the core's and the master's in the log they share.
    expect(stamped.times).toBe(1)
    expect(seen).toEqual([{ dataDir: expect.any(String), socketPath: '/data/daemon-18473.sock', machineId: expect.any(String), token: 'token' }])
    expect(hosted).toEqual([{ options: { name: 'search', services: ['search'] }, services: [handle] }])
  })

  it('runs several in one process, as its master names it, each started on its own; stopping it stops each', async () => {
    const started: string[] = []
    const stops = { workspaces: vi.fn(), usage: vi.fn(async () => {}) }
    const runners = new Map(Object.entries(stops).map(([name, stop]) => [name, async () => () => { started.push(name); return { stop } }]))
    const { host, hosted } = fakeHost()
    process.env.HARNESSD_SERVICE = 'edge'
    try {
      const running = await startServiceProcess(' workspaces,usage ,workspaces', { runners, host })
      await running.stop()
    } finally { delete process.env.HARNESSD_SERVICE }
    expect(started).toEqual(['workspaces', 'usage'])
    expect(process.title).toBe('harnessd-edge')
    expect(hosted[0].options).toEqual({ name: 'edge', services: ['workspaces', 'usage'] })
    expect(hosted[0].services).toHaveLength(2)
    expect(stops.workspaces).toHaveBeenCalledOnce()
    expect(stops.usage).toHaveBeenCalledOnce()
  })

  it('leaves off a service that cannot start and runs the others; with none started it fails as a lone one did', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fails = async () => () => { throw new Error('injected fault: usage') }
    const runners = new Map([['usage', fails], ['monitor', async () => () => ({ stop: () => {} })]])
    const { host, hosted } = fakeHost()
    await startServiceProcess('usage,monitor', { runners, host })
    expect(hosted[0].services).toHaveLength(1)
    expect(error).toHaveBeenCalledWith('[service usage] did not start · injected fault: usage')
    await expect(startServiceProcess('usage', { runners, host })).rejects.toThrow('injected fault: usage')
    // Nothing started, no process beats for it: the master sees it end before its first heartbeat.
    expect(hosted).toHaveLength(1)
    const thrown = new Map([['usage', async () => () => { throw 'not an error' }]])
    await expect(startServiceProcess('usage', { runners: thrown, host })).rejects.toBe('not an error')
    expect(error).toHaveBeenCalledWith('[service usage] did not start · not an error')
  })

  it('refuses, with exit 2 and why, a service this build does not know or a core with no socket', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exit = vi.fn((code: number): never => { throw new Error(`exit ${code}`) })
    await expect(startServiceProcess('nope', { runners: new Map(), exit })).rejects.toThrow('exit 2')
    await expect(startServiceProcess(undefined, { runners: new Map(), exit })).rejects.toThrow('exit 2')
    await expect(startServiceProcess(' , ', { runners: new Map(), exit })).rejects.toThrow('exit 2')
    // One name it does not know refuses the process: its master is from another build.
    await expect(startServiceProcess('search,nope', { exit })).rejects.toThrow('exit 2')
    local.socket = null
    await expect(startServiceProcess('search', { exit })).rejects.toThrow('exit 2')
    expect(error.mock.calls.map((call) => call[0])).toEqual([
      '[service] nope: no such service in this build',
      '[service] (none): no such service in this build',
      '[service] (none): no such service in this build',
      '[service] nope: no such service in this build',
      '[service] search: the core has no local socket to reach',
    ])
    const processExit = vi.spyOn(process, 'exit').mockImplementation(((code: number) => { throw new Error(`process.exit ${code}`) }) as never)
    await expect(startServiceProcess('nope', { runners: new Map() })).rejects.toThrow('process.exit 2')
    expect(processExit).toHaveBeenCalledWith(2)
  })
})
