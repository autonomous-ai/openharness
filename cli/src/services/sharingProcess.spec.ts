import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CoreApi, CorePorts, SharingPort } from '../core/api.js'
import type { RegisteredSession } from '../lib/registry.js'
import type { CoreConnection, ServiceProcessOptions } from './process.js'
import { AGENTS_FRESH_MS, runSharingService } from './sharingProcess.js'

// The real default reaches a real socket: never in a test.
vi.mock('./process.js', () => ({ runServiceProcess: vi.fn(() => ({ stop: vi.fn() })) }))

const OWNER = { local: true, owner: true }
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((settle) => setTimeout(settle, 0)) }
const agent = (agentId: string) => ({ agentId, sessionId: `s-${agentId}`, engine: 'claude', cwd: '/w' }) as unknown as RegisteredSession

describe('Share in its own process', () => {
  afterEach(() => vi.clearAllMocks())

  const setup = () => {
    let options: ServiceProcessOptions | null = null
    let api: CoreApi | null = null
    let clock = 10_000
    const ports: SharingPort[] = []
    const order: string[] = []
    const stop = vi.fn()
    const service = runSharingService({
      dataDir: '/data', socketPath: '/data/daemon-1.sock', machineId: 'm', token: 't',
      now: () => clock,
      run: (given) => { options = given; return { stop } },
      start: (core: CoreApi, given: CorePorts) => {
        api = core
        const port: SharingPort = {
          observer: vi.fn(async (connId: string, type: string) => {
            order.push(`${connId} ${type} start`)
            await flush()
            order.push(`${connId} ${type} end`)
            if (type === 'observer_boom') throw new Error('an unreadable frame')
            if (type === 'observer_odd') throw 'odd'
          }),
          linkDown: vi.fn(),
          stop: vi.fn(async () => {}),
        }
        ports.push(port)
        given.sharing = port
        return { harness_share_list: async (payload) => ({ listed: payload.agentId, env: core.daemon.autonomousEnv, agents: core.agents.live().map((a) => a.agentId) }) }
      },
    })
    return { options: options!, api: () => api!, ports, order, service, stop, tick: (ms: number) => { clock += ms } }
  }
  const core = (answers: Record<string, unknown> = {}) => {
    const asked: Array<[string, Record<string, unknown> | undefined]> = []
    const query = vi.fn(async (name: string, payload?: Record<string, unknown>) => {
      asked.push([name, payload])
      const answer = answers[name]
      if (answer instanceof Error) throw answer
      return (answer ?? {}) as Record<string, unknown>
    })
    return { connection: { query } satisfies CoreConnection, asked, query }
  }

  it('answers its requests on the agents and the daemon as the core shows them as each starts', async () => {
    const { options } = setup()
    expect(options).toMatchObject({ name: 'sharing', socketPath: '/data/daemon-1.sock', machineId: 'm', token: 't' })
    options.onConnected!(core({ shown: { agents: [agent('a1')] }, daemon: { command: 'x', port: 1, machineId: 'm', autonomousEnv: 'staging' } }).connection)
    expect(await options.requests.harness_share_list!({ agentId: 'a1' }, OWNER)).toEqual({ listed: 'a1', env: 'staging', agents: ['a1'] })
    // A new core that cannot say leaves what the last one said.
    options.onConnected!(core({ shown: new Error('gone'), daemon: new Error('gone') }).connection)
    expect(await options.requests.harness_share_list!({ agentId: 'a1' }, OWNER)).toEqual({ listed: 'a1', env: 'staging', agents: ['a1'] })
  })

  it('takes each observer\'s frames one at a time, in order, and another observer\'s beside them', async () => {
    const { options, order, ports } = setup()
    options.onConnected!(core({ daemon: { command: 'x', port: 1, machineId: 'm' } }).connection)
    const first = options.requests.observer!({ connId: 'observer:ken', type: 'observer_open', payload: { shareId: 's' } }, OWNER)
    const second = options.requests.observer!({ connId: 'observer:ken', type: 'observer_close' }, OWNER)
    const other = options.requests.observer!({ connId: 'observer:ann', type: 'observer_open' }, OWNER)
    expect(await Promise.all([first, second, other])).toEqual([{}, {}, {}])
    const ken = order.filter((line) => line.startsWith('observer:ken'))
    expect(ken).toEqual(['observer:ken observer_open start', 'observer:ken observer_open end', 'observer:ken observer_close start', 'observer:ken observer_close end'])
    expect(ports[0].observer).toHaveBeenCalledWith('observer:ken', 'observer_open', { shareId: 's' })
    expect(ports[0].observer).toHaveBeenCalledWith('observer:ken', 'observer_close', {})
    expect(await options.requests.observer!({ type: 'observer_open' }, OWNER)).toEqual({ error: 'INVALID_FRAME' })
  })

  it('says why an observer\'s frame failed, and goes on with the next', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { options } = setup()
      options.onConnected!(core({ daemon: { command: 'x', port: 1, machineId: 'm' } }).connection)
      expect(await options.requests.observer!({ connId: 'observer:ken', type: 'observer_boom' }, OWNER)).toEqual({})
      expect(await options.requests.observer!({ connId: 'observer:ken', type: 'observer_odd' }, OWNER)).toEqual({})
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('an unreadable frame'))
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('odd'))
    } finally {
      warn.mockRestore()
    }
  })

  it('hands the core\'s watch and the relay gone to Share; anything else is not its', async () => {
    const { options, api, ports } = setup()
    const shown = vi.fn()
    api().terminals.watch.onOutput(shown)
    options.onEvent!({ kind: 'watch', viewer: 'observer:ken', output: { binary: 'aGk=' } })
    options.onEvent!({ kind: 'linkDown' })
    options.onEvent!({ kind: 'other' })
    expect(shown).toHaveBeenCalledWith('observer:ken', { binary: 'aGk=' })
    expect(ports[0].linkDown).toHaveBeenCalledOnce()
  })

  it('reads the agents again for its timers once they are a second old, once at a time', async () => {
    const { options, api, tick } = setup()
    const link = core({ shown: { agents: [agent('a1')] } })
    options.onConnected!(link.connection)
    await flush()
    const reads = () => link.asked.filter(([name]) => name === 'shown').length
    const before = reads()
    expect(api().agents.live().map((a) => a.agentId)).toEqual(['a1'])
    expect(reads()).toBe(before)
    tick(AGENTS_FRESH_MS + 1)
    api().agents.live()
    api().agents.live()
    expect(reads()).toBe(before + 1)
  })

  it('starts Share again under the machine a new core serves as, and stops what it runs with the process', async () => {
    const { options, ports, service, stop } = setup()
    options.onConnected!(core({ daemon: { command: 'x', port: 1, machineId: 'computer' } }).connection)
    await flush()
    options.onConnected!(core({ daemon: { command: 'x', port: 1, machineId: 'account-machine' } }).connection)
    await flush()
    expect(ports).toHaveLength(2)
    expect(ports[0].stop).toHaveBeenCalledOnce()
    options.onDisconnected!()
    expect(await options.requests.harness_share_list!({ agentId: 'a1' }, OWNER)).toMatchObject({ listed: 'a1' })
    await service.stop()
    expect(ports[1].stop).toHaveBeenCalledOnce()
    expect(stop).toHaveBeenCalledOnce()
  })

  it('runs the real Share and process when given neither', async () => {
    const { runServiceProcess } = await import('./process.js')
    const process = runSharingService({ dataDir: '/data-that-is-not-there', socketPath: '/s', machineId: 'm', token: 't' })
    expect(vi.mocked(runServiceProcess).mock.calls.at(-1)![0].requests.harness_share_list).toBeTypeOf('function')
    await process.stop()
  })
})
