import { afterEach, describe, expect, it, vi } from 'vitest'
import { SERVICE_RUNNERS, startServiceProcess, type ServiceProcessOptions } from './serviceProcess.js'
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
    expect([...SERVICE_RUNNERS.keys()].sort()).toEqual(Object.keys(KNOWN_SERVICES).sort())
    for (const [name, load] of SERVICE_RUNNERS) expect(typeof await load(), name).toBe('function')
  })

  it('runs the one it is named, against the core\'s socket, with the master\'s token', async () => {
    const seen: ServiceProcessOptions[] = []
    const handle = { stop: () => {} }
    const loaded: string[] = []
    const runners = new Map([
      ['search', async () => { loaded.push('search'); return (options: ServiceProcessOptions) => { seen.push(options); return handle } }],
      ['viewers', async () => { loaded.push('viewers'); return () => handle }],
    ])
    process.env.HARNESSD_SERVICE_TOKEN = 'token'
    try {
      expect(await startServiceProcess('search', { runners })).toBe(handle)
    } finally { delete process.env.HARNESSD_SERVICE_TOKEN }
    expect(loaded).toEqual(['search'])
    expect(process.title).toBe('harnessd-search')
    // Its lines are stamped like the core's and the master's in the log they share.
    expect(stamped.times).toBe(1)
    expect(seen).toEqual([{ dataDir: expect.any(String), socketPath: '/data/daemon-18473.sock', machineId: expect.any(String), token: 'token' }])
    expect(await startServiceProcess('viewers', { runners })).toBe(handle)
  })

  it('refuses, with exit 2 and why, a service this build does not know or a core with no socket', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exit = vi.fn((code: number): never => { throw new Error(`exit ${code}`) })
    await expect(startServiceProcess('nope', { runners: new Map(), exit })).rejects.toThrow('exit 2')
    await expect(startServiceProcess(undefined, { runners: new Map(), exit })).rejects.toThrow('exit 2')
    local.socket = null
    await expect(startServiceProcess('search', { exit })).rejects.toThrow('exit 2')
    expect(error.mock.calls.map((call) => call[0])).toEqual([
      '[service] nope: no such service in this build',
      '[service] (none): no such service in this build',
      '[service] search: the core has no local socket to reach',
    ])
    const processExit = vi.spyOn(process, 'exit').mockImplementation(((code: number) => { throw new Error(`process.exit ${code}`) }) as never)
    await expect(startServiceProcess('nope', { runners: new Map() })).rejects.toThrow('process.exit 2')
    expect(processExit).toHaveBeenCalledWith(2)
  })
})
