import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CoreApi } from '../core/api.js'
import type { RegisteredSession } from '../lib/registry.js'
import type { AgentMessages, MessagesOptions } from '../messages/service.js'
import { AGENTS_FRESH_MS, runMessagesService, WATCHED, WRITABLE_EVERY_MS, WRITABLE_FOR_MS } from './messagesProcess.js'
import type { CoreConnection, ServiceProcessOptions } from './process.js'

// The real default reaches a real socket: never in a test.
vi.mock('./process.js', () => ({ runServiceProcess: vi.fn(() => ({ stop: vi.fn() })) }))

const OWNER = { local: true, owner: true }
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((settle) => setTimeout(settle, 0)) }
const agent = (agentId: string) => ({ agentId, sessionId: `s-${agentId}`, engine: 'claude', cwd: '/w', displayName: agentId, terminalAvailable: true }) as unknown as RegisteredSession

describe('Agent Messages in its own process', () => {
  afterEach(() => vi.clearAllMocks())

  const setup = () => {
    let options: ServiceProcessOptions | null = null
    let api: CoreApi | null = null
    let given: MessagesOptions | undefined
    let clock = 10_000
    const timers: Array<{ run: () => void; ms: number; cleared: boolean }> = []
    const writable = new Set<string>()
    const calls: string[] = []
    const stop = vi.fn()
    const service = runMessagesService({
      dataDir: '/data', socketPath: '/data/daemon-1.sock', machineId: 'm', token: 't',
      run: (o) => { options = o; return { stop } },
      now: () => clock,
      setTimer: (run, ms) => { const timer = { run, ms, cleared: false }; timers.push(timer); return timer },
      clearTimer: (timer) => { (timer as { cleared: boolean }).cleared = true },
      start: (core, opts) => {
        api = core
        given = opts
        return {
          requests: {
            agent_messages: async (payload) => ({ action: payload.action, agents: core.agents.live().map((a) => a.agentId), command: core.daemon.command }),
          },
          canWrite: (id) => writable.has(id),
          start: () => calls.push('start'),
          stop: () => calls.push('stop'),
        } satisfies AgentMessages
      },
    })
    return { options: options!, api: () => api!, given: () => given!, writable, timers, calls, service, stop, tick: (ms: number) => { clock += ms }, now: () => clock }
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

  it('starts once it knows the agents and the daemon, and answers on the agents as each request starts', async () => {
    const { options, calls } = setup()
    expect(options).toMatchObject({ name: 'messages', socketPath: '/data/daemon-1.sock', machineId: 'm', token: 't' })
    const link = core({ shown: { agents: [agent('a1')] }, daemon: { command: `'node' 'cli.js'`, port: 18473, machineId: 'm' } })
    options.onConnected!(link.connection)
    await flush()
    expect(calls).toEqual(['start'])
    expect(await options.requests.agent_messages!({ action: 'history' }, OWNER)).toEqual({ action: 'history', agents: ['a1'], command: `'node' 'cli.js'` })
    // Connected again (a new core, the same machine): asked how the daemon runs again, not started twice.
    const again = core({ shown: { agents: [agent('a1')] }, daemon: { command: `'node' 'cli.js'`, port: 18473, machineId: 'm' } })
    options.onConnected!(again.connection)
    await flush()
    expect(calls).toEqual(['start'])
    expect(link.asked.filter(([name]) => name === 'daemon')).toHaveLength(1)
    expect(again.asked.filter(([name]) => name === 'daemon')).toHaveLength(1)
    // A core under another machine (signed in since): the service under the old one goes, a new one starts.
    options.onConnected!(core({ shown: { agents: [] }, daemon: { command: 'x', port: 1, machineId: 'account-machine' } }).connection)
    await flush()
    expect(calls).toEqual(['start', 'stop', 'start'])
  })

  it('keeps the daemon it knew when a new core cannot say', async () => {
    const { options, calls } = setup()
    options.onConnected!(core({ daemon: { command: 'x', port: 1, machineId: 'm' } }).connection)
    await flush()
    options.onConnected!(core({ daemon: new Error('gone') }).connection)
    await flush()
    expect(await options.requests.agent_messages!({ action: 'history' }, OWNER)).toMatchObject({ command: 'x' })
    expect(calls).toEqual(['start'])
  })

  it('starts nothing while it does not know which machine it serves', async () => {
    const { options, calls } = setup()
    options.onConnected!(core({ daemon: { error: 'NOT_AN_EXPERIMENT' } }).connection)
    await flush()
    expect(calls).toEqual([])
    expect(await options.requests.agent_messages!({ action: 'history' }, OWNER)).toMatchObject({ action: 'history' })
    expect(calls).toEqual([])
  })

  it('gives the service its data folder, and hears from it when what may be written changed', async () => {
    const { options, given, writable } = setup()
    const link = core()
    options.onConnected!(link.connection)
    expect(given().dataDir).toBe('/data')
    writable.add('team:d9')
    given().changed!()
    expect(link.asked.at(-1)?.[0]).toBe('writable')
  })

  it('tells the core a delivery may be written before handing it over, and keeps telling while any may', async () => {
    const { options, api, writable, timers, tick } = setup()
    const link = core()
    options.onConnected!(link.connection)
    await flush()
    link.asked.length = 0
    writable.add('team:d1')
    api().turns.deliver('a1', 'a question', 'team:d1')
    expect(link.asked.map(([name]) => name)).toEqual(['writable', 'deliver'])
    expect(link.asked[0][1]).toEqual({ deliveries: { 'team:d1': 10_000 + WRITABLE_FOR_MS } })
    expect(timers).toHaveLength(1)
    expect(timers[0].ms).toBe(WRITABLE_EVERY_MS)
    tick(WRITABLE_EVERY_MS)
    timers[0].run()
    expect(link.asked.at(-1)).toEqual(['writable', { deliveries: { 'team:d1': 11_000 + WRITABLE_FOR_MS } }])
    // Taken back: told once that none may, and the telling stops.
    writable.delete('team:d1')
    timers[0].run()
    expect(link.asked.at(-1)).toEqual(['writable', { deliveries: {} }])
    expect(timers[0].cleared).toBe(true)
    const count = link.asked.length
    // Nothing changed and none may: nothing more to say.
    options.onEvent!({ kind: 'delivery', event: { deliveryId: 'team:d1', sessionId: 'a1', state: 'started' } })
    expect(link.asked).toHaveLength(count)
  })

  it('watches the last deliveries only, and one handed over again as the newest', async () => {
    const { options, api, writable } = setup()
    const link = core()
    options.onConnected!(link.connection)
    for (let i = 0; i <= WATCHED; i++) api().turns.deliver('a1', 'q', `team:d${i}`)
    api().turns.deliver('a1', 'q', 'team:d5')
    writable.add('team:d0')
    writable.add('team:d5')
    api().turns.deliver('a1', 'q', 'team:dX')
    expect(link.asked.filter(([name]) => name === 'writable').at(-1)![1]).toEqual({ deliveries: { 'team:d5': expect.any(Number) } })
  })

  it('takes nothing back in line: a delivery its mailbox no longer wants is one it says may not be written', async () => {
    const { options, api } = setup()
    options.onConnected!(core().connection)
    expect(api().turns.cancelDelivery('team:d1')).toBe(false)
  })

  it('hears the account\'s notices once it runs, and its deliveries\' progress; anything else is not its', async () => {
    const { options, api } = setup()
    const heard = vi.fn(), noticed = vi.fn()
    api().turns.onDelivery(heard)
    const stop = api().account.onNotice(noticed)
    // Not running yet: a notice is the next service's to read when it starts.
    options.onEvent!({ kind: 'notice', notice: { type: 'desk_changed', revision: 1 } })
    options.onConnected!(core({ daemon: { command: 'x', port: 1, machineId: 'm' } }).connection)
    await flush()
    options.onEvent!({ kind: 'delivery', event: { deliveryId: 'team:d1', sessionId: 'a1', state: 'queued' } })
    options.onEvent!({ kind: 'notice', notice: { type: 'desk_changed', revision: 2 } })
    options.onEvent!({ kind: 'notice' })
    options.onEvent!({ kind: 'other' })
    stop()
    options.onEvent!({ kind: 'notice', notice: { type: 'desk_changed', revision: 3 } })
    expect(heard).toHaveBeenCalledOnce()
    expect(noticed.mock.calls).toEqual([[{ type: 'desk_changed', revision: 2 }]])
  })

  it('reads the agents again, for its mailbox\'s next look, once they are a second old; once at a time', async () => {
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
    // A core that cannot say keeps the agents it said.
    link.query.mockRejectedValueOnce(new Error('gone'))
    tick(AGENTS_FRESH_MS + 1)
    await flush()
    api().agents.live()
    await flush()
    expect(api().agents.live().map((a) => a.agentId)).toEqual(['a1'])
  })

  it('acts on nothing before it connects, or after the core is gone, and stops what it runs with the process', async () => {
    const { options, api, service, stop, calls, writable, timers } = setup()
    api().turns.deliver('a1', 'q', 'team:d1')
    await flush()
    expect(await options.requests.agent_messages!({ action: 'history' }, OWNER)).toMatchObject({ agents: [], command: 'harness' })
    options.onConnected!(core().connection)
    writable.add('team:d2')
    api().turns.deliver('a1', 'q', 'team:d2')
    options.onDisconnected!()
    await service.stop()
    expect(timers[0].cleared).toBe(true)
    expect(calls).toContain('stop')
    expect(stop).toHaveBeenCalledOnce()
    // Stopped with nothing being told: nothing to clear.
    const quiet = setup()
    await quiet.service.stop()
  })

  it('runs the real process, on the real clock and timers, when given none', async () => {
    vi.useFakeTimers()
    try {
      const { runServiceProcess } = await import('./process.js')
      const writable = new Set(['team:d1'])
      let api: CoreApi | null = null
      const process = runMessagesService({
        dataDir: '/data', socketPath: '/s', machineId: 'm', token: 't',
        start: (given) => {
          api = given
          return { requests: { agent_messages: async () => ({}) }, canWrite: (id) => writable.has(id), start: () => {}, stop: () => {} }
        },
      })
      const options = vi.mocked(runServiceProcess).mock.calls.at(-1)![0]
      const link = core()
      options.onConnected!(link.connection)
      api!.turns.deliver('a1', 'q', 'team:d1')
      await vi.advanceTimersByTimeAsync(WRITABLE_EVERY_MS)
      expect(link.asked.filter(([name]) => name === 'writable').length).toBeGreaterThanOrEqual(2)
      process.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('starts the real service when given none', async () => {
    const { runServiceProcess } = await import('./process.js')
    runMessagesService({ dataDir: '/data-that-is-not-there', socketPath: '/s', machineId: 'm', token: 't' }).stop()
    expect(vi.mocked(runServiceProcess).mock.calls.at(-1)![0].requests.agent_messages).toBeTypeOf('function')
  })
})
