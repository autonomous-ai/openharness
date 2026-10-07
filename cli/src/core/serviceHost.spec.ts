import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeCore } from '../testing/fakeCore.js'
import { emptyPorts, type CorePorts, type SearchPort, type ViewersPort, type WorkspacesPort } from './api.js'
import { createServiceHost, FAIL, later, ServiceUnavailableError, testFaults, type PortFallbacks } from './serviceHost.js'

// A port whose members cover every shape: sync and async, value and FAIL fallbacks, a stop.
class FakeSearch {
  readonly calls: string[] = []
  touch(sessionId: string): void { this.calls.push(`touch ${sessionId}`) }
  deleteHistory(sessionId: string): void { this.calls.push(`delete ${sessionId}`) }
  session(sessionId: string) { return { title: `title of ${sessionId}` } as never }
  search(query: string) { return { hits: [query] } as never }
  async tail(sessionId: string) { return { sessionId } as never }
  stop(): void { this.calls.push('stop') }
}
// The search port as these tests drive it: two more members, whose fallback is to fail, sync and async —
// the shapes of a member a request needs answered. The host guards whatever the fallbacks name.
type TestPort = SearchPort & { search(query: string, options: object): unknown; tail(sessionId: string, options: object): Promise<unknown> }
const SEARCH = {
  touch: undefined, deleteHistory: undefined, session: undefined, search: FAIL, tail: later(FAIL), stop: undefined,
} as unknown as PortFallbacks<SearchPort>
const testPort = (h: { ports: CorePorts }): TestPort => h.ports.search as unknown as TestPort
const VIEWERS: PortFallbacks<ViewersPort> = {
  attach: undefined, detach: undefined, frameContext: null, forwardingUrl: null, stop: later(undefined),
  stream: false, surface: later({}), closed: undefined,
}
/** The viewer streams' members, which these tests never call. */
const STREAMS = { stream: vi.fn(() => true), surface: vi.fn(async () => ({})), closed: vi.fn() }

function host(options: Parameters<typeof createServiceHost>[1] = {}) {
  const ports = emptyPorts()
  const lines: string[] = []
  let at = 0
  const services = createServiceHost(ports, { log: (line) => lines.push(line), now: () => at, ...options })
  return { ports, lines, services, advance: (ms: number) => { at += ms } }
}
function startSearch(h: ReturnType<typeof host>, port: Partial<TestPort> = new FakeSearch()) {
  h.services.start('search', (_core, ports) => { ports.search = port as SearchPort }, fakeCore(), SEARCH)
  return port as TestPort
}

describe('hosting services so one that fails cannot take the core down', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

  describe('starting', () => {
    it('installs the port a service fills, guarded, with every call reaching it as made', async () => {
      const h = host()
      const real = new FakeSearch()
      startSearch(h, real)
      const port = testPort(h)
      expect(port).not.toBe(real)
      port.touch('s1')
      port.deleteHistory('s2')
      expect(real.calls).toEqual(['touch s1', 'delete s2'])
      expect(port.session('s1')).toEqual({ title: 'title of s1' })
      expect(port.search('fix', {})).toEqual({ hits: ['fix'] })
      expect(await port.tail('s1', {})).toEqual({ sessionId: 's1' })
      expect(h.services.isOff('search')).toBe(false)
      expect(h.lines).toEqual([])
    })

    it('leaves off, and says so, a service whose start throws, and the rest of the ports alone', () => {
      const h = host()
      const viewers = { stop: vi.fn() } as unknown as ViewersPort
      h.ports.viewers = viewers
      h.services.start('search', () => { throw new Error('index locked') }, fakeCore(), SEARCH)
      h.services.start('workspaces', () => { throw 'no home folder' }, fakeCore(), { nameBranches: undefined, sweepUnused: undefined })
      expect(h.ports.search).toBeNull()
      expect(h.ports.workspaces).toBeNull()
      expect(h.ports.viewers).toBe(viewers)
      expect(h.services.isOff('search')).toBe(true)
      expect(h.lines).toEqual([
        '[services] search did not start · index locked · the core runs without it',
        '[services] workspaces did not start · no home folder · the core runs without it',
      ])
    })

    it('counts a service that leaves its own port empty as off, without a word of its own', () => {
      const h = host()
      h.services.start('search', () => {}, fakeCore(), SEARCH)
      expect(h.ports.search).toBeNull()
      expect(h.services.isOff('search')).toBe(true)
      expect(h.lines).toEqual([])
    })

    it('takes only the port a service owns: what it writes into another is dropped', () => {
      const h = host()
      const stray = { nameBranches: vi.fn(), sweepUnused: vi.fn() } as WorkspacesPort
      h.services.start('search', (_core, ports) => { ports.search = new FakeSearch(); ports.workspaces = stray }, fakeCore(), SEARCH)
      expect(h.ports.search).not.toBeNull()
      expect(h.ports.workspaces).toBeNull()
    })
  })

  describe('a call that fails', () => {
    it('is logged and answered with its fallback, so the caller carries on', async () => {
      const h = host()
      const port = startSearch(h, {
        ...new FakeSearch(),
        touch: () => { throw new Error('store closed') },
        session: () => { throw 'bad row' },
      })
      expect(testPort(h).touch('s1')).toBeUndefined()
      expect(testPort(h).session('s1')).toBeUndefined()
      expect(port).toBeDefined()
      expect(h.lines).toEqual(['[services] search.touch failed · store closed', '[services] search.session failed · bad row'])
    })

    it('goes back to the one request when its fallback is FAIL, sync or async', async () => {
      const h = host()
      const cause = new Error('disk I/O error')
      startSearch(h, { ...new FakeSearch(), search: () => { throw cause }, tail: async () => { throw cause } })
      let thrown: unknown
      try { testPort(h).search('x', {}) } catch (error) { thrown = error }
      expect(thrown).toBeInstanceOf(ServiceUnavailableError)
      expect(thrown).toMatchObject({ service: 'search', cause, name: 'ServiceUnavailableError', message: 'the search service is unavailable' })
      await expect(testPort(h).tail('s1', {})).rejects.toMatchObject({ service: 'search', cause })
    })

    it('resolves an async member to its fallback whether it rejects or throws before its promise', async () => {
      const h = host()
      let viewersStop: () => Promise<void> = async () => { throw new Error('viewer hung') }
      h.services.start('viewers', (_core, ports) => {
        ports.viewers = { attach: vi.fn(), detach: vi.fn(), frameContext: vi.fn(() => null), forwardingUrl: vi.fn(() => null), stop: () => viewersStop(), ...STREAMS }
      }, fakeCore(), VIEWERS)
      await expect(h.ports.viewers!.stop()).resolves.toBeUndefined()
      viewersStop = () => { throw new Error('sync throw in async member') }
      await expect(h.ports.viewers!.stop()).resolves.toBeUndefined()
      expect(h.lines).toEqual(['[services] viewers.stop failed · viewer hung', '[services] viewers.stop failed · sync throw in async member'])
    })

    it('passes a promise that resolves straight through', async () => {
      const h = host()
      h.services.start('viewers', (_core, ports) => {
        ports.viewers = { attach: vi.fn(), detach: vi.fn(), frameContext: vi.fn(() => null), forwardingUrl: vi.fn(() => 'http://v'), stop: async () => {}, ...STREAMS }
      }, fakeCore(), VIEWERS)
      expect(h.ports.viewers!.forwardingUrl('a1')).toBe('http://v')
      await expect(h.ports.viewers!.stop()).resolves.toBeUndefined()
    })
  })

  describe('switching a failing service off', () => {
    it('after five failures within the window: stopped, unbound, and its calls answered without reaching it', async () => {
      const h = host()
      const real = new FakeSearch()
      real.touch = () => { throw new Error('store closed') }
      startSearch(h, real)
      const captured = testPort(h)
      const unbind = vi.fn()
      h.services.onOff('search', unbind)
      for (let i = 0; i < 4; i++) { captured.touch('s1'); h.advance(1_000) }
      expect(h.services.isOff('search')).toBe(false)
      captured.touch('s1')
      expect(h.services.isOff('search')).toBe(true)
      expect(h.ports.search).toBeNull()
      expect(real.calls).toEqual(['stop'])
      expect(unbind).toHaveBeenCalledTimes(1)
      expect(h.lines.at(-1)).toBe('[services] search switched off after 5 failures in 60s · it stays off until the daemon restarts')
      // A reference the core took before it went off now answers without running the service.
      const spy = vi.spyOn(real, 'deleteHistory')
      expect(captured.deleteHistory('s1')).toBeUndefined()
      expect(spy).not.toHaveBeenCalled()
      expect(() => captured.search('x', {})).toThrow(ServiceUnavailableError)
      await expect(captured.tail('s1', {})).rejects.toBeInstanceOf(ServiceUnavailableError)
      expect(h.lines).toHaveLength(6)
    })

    it('forgets failures older than the window, so a slow trickle never switches a service off', () => {
      const h = host({ maxFailures: 3, windowMs: 10_000 })
      startSearch(h, { ...new FakeSearch(), touch: () => { throw new Error('flaky') } })
      for (let i = 0; i < 10; i++) { testPort(h).touch('s1'); h.advance(6_000) }
      expect(h.services.isOff('search')).toBe(false)
    })

    it('switches off once, even when a call begun before it fails after', async () => {
      const h = host({ maxFailures: 2 })
      const rejects: Array<(error: Error) => void> = []
      startSearch(h, { ...new FakeSearch(), tail: () => new Promise((_resolve, reject) => { rejects.push(reject) }) })
      const calls = [testPort(h).tail('a', {}), testPort(h).tail('b', {}), testPort(h).tail('c', {})]
      for (const reject of rejects) reject(new Error('timeout'))
      await Promise.allSettled(calls)
      expect(h.lines.filter((line) => line.includes('switched off'))).toHaveLength(1)
    })

    it('carries on when an unbinding or a stop fails, and stops nothing it cannot', async () => {
      const h = host({ maxFailures: 1 })
      const late = vi.fn()
      startSearch(h, { ...new FakeSearch(), touch: () => { throw new Error('x') }, stop: () => { throw new Error('stop failed') } })
      h.services.onOff('search', () => { throw new Error('unbind failed') })
      h.services.onOff('search', late)
      testPort(h).touch('s1')
      expect(late).toHaveBeenCalled()
      expect(h.lines).toContain('[services] switching search off: stop failed')
      expect(h.lines).toContain('[services] switching search off: unbind failed')

      const async = host({ maxFailures: 1 })
      async.services.start('viewers', (_core, ports) => {
        ports.viewers = { attach: () => { throw new Error('x') }, detach: vi.fn(), frameContext: vi.fn(() => null), forwardingUrl: vi.fn(() => null), stop: async () => { throw new Error('viewer stuck') }, ...STREAMS }
      }, fakeCore(), VIEWERS)
      async.ports.viewers!.attach({} as never)
      await new Promise((resolve) => setImmediate(resolve))
      expect(async.services.isOff('viewers')).toBe(true)

      const stopless = host({ maxFailures: 1 })
      stopless.services.start('workspaces', (_core, ports) => {
        ports.workspaces = { nameBranches: () => { throw new Error('x') }, sweepUnused: vi.fn() }
      }, fakeCore(), { nameBranches: undefined, sweepUnused: undefined })
      stopless.ports.workspaces!.nameBranches()
      expect(stopless.services.isOff('workspaces')).toBe(true)
    })

    it('by default after five failures in sixty seconds, logged as a warning', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const ports: CorePorts = emptyPorts()
      const services = createServiceHost(ports)
      services.start('workspaces', (_core, p) => { p.workspaces = { nameBranches: () => { throw new Error('x') }, sweepUnused: vi.fn() } }, fakeCore(), { nameBranches: undefined, sweepUnused: undefined })
      for (let i = 0; i < 5; i++) ports.workspaces?.nameBranches()
      expect(services.isOff('workspaces')).toBe(true)
      expect(warn).toHaveBeenLastCalledWith('[services] workspaces switched off after 5 failures in 60s · it stays off until the daemon restarts')
    })
  })

  describe('requests a service answers for the apps', () => {
    const ASKER = { local: true, owner: true }
    const collect = () => {
      const got: Array<Record<string, unknown>> = []
      return { got, reply: (result: Record<string, unknown>) => { got.push(result) } }
    }

    it('routes a declared request to its handler with who asked, and leaves the socket everything else', async () => {
      const h = host()
      const seen: unknown[] = []
      h.services.start('search', (_core, ports) => {
        ports.search = new FakeSearch() as unknown as SearchPort
        return { session_search: (payload, asker) => { seen.push([payload, asker]); return { hits: [] } } }
      }, fakeCore(), SEARCH, ['session_search'])
      const { got, reply } = collect()
      expect(h.services.route('session_search', { query: 'x' }, ASKER, reply)).toBe(true)
      await vi.waitFor(() => expect(got).toEqual([{ hits: [] }]))
      expect(seen).toEqual([[{ query: 'x' }, ASKER]])
      expect(h.services.route('agents_list', {}, ASKER, reply)).toBe(false)
    })

    it('tells a handler when the connection that asked closes, and no other connection\'s', async () => {
      const h = host()
      const asked = new Map<string, { closed: AbortSignal; answer: () => void }>()
      h.services.serve('commands', () => ({
        command: (payload, _asker, closed) => new Promise((resolve) => {
          asked.set(String(payload.id), { closed: closed!, answer: () => resolve({ id: payload.id }) })
        }),
      }), fakeCore(), ['command'])
      const { got, reply } = collect()
      h.services.route('command', { id: 'a1' }, { ...ASKER, connection: 'conn-a' }, reply)
      h.services.route('command', { id: 'a2' }, { ...ASKER, connection: 'conn-a' }, reply)
      h.services.route('command', { id: 'b1' }, { ...ASKER, connection: 'conn-b' }, reply)
      // The core's own asking, with no connection: never closed.
      h.services.route('command', { id: 'core' }, ASKER, reply)
      // A request already answered is forgotten: closing its connection reaches nothing.
      asked.get('b1')!.answer()
      await vi.waitFor(() => expect(got).toEqual([{ id: 'b1' }]))
      h.services.closeConnection('conn-b')
      h.services.closeConnection('conn-a')
      expect([...asked.values()].map((one) => one.closed.aborted)).toEqual([true, true, false, false])
      // Aborted or not, what the handler answers is replied: the socket drops what nobody can read.
      asked.get('a1')!.answer()
      await vi.waitFor(() => expect(got).toEqual([{ id: 'b1' }, { id: 'a1' }]))
    })

    it('returns at once, and replies when a promised answer comes', async () => {
      const h = host()
      let answer!: (value: Record<string, unknown>) => void
      h.services.serve('store', () => ({ dsh_list: () => new Promise((resolve) => { answer = resolve }) }), fakeCore(), ['dsh_list'])
      const { got, reply } = collect()
      expect(h.services.route('dsh_list', {}, ASKER, reply)).toBe(true)
      expect(got).toEqual([])
      answer({ dsh: [] })
      await vi.waitFor(() => expect(got).toEqual([{ dsh: [] }]))
    })

    it('answers SERVICE_UNAVAILABLE, never UNSUPPORTED, for a service that did not start, left its port empty, or was switched off', async () => {
      const h = host({ maxFailures: 1 })
      h.services.start('search', () => { throw new Error('index locked') }, fakeCore(), SEARCH, ['session_search'])
      h.services.start('viewers', () => {}, fakeCore(), VIEWERS, ['viewer_list'])
      const switchedOff = vi.fn()
      h.services.serve('store', () => ({ dsh_list: () => { throw new Error('catalog corrupt') } }), fakeCore(), ['dsh_list'])
      h.services.onOff('store', switchedOff)
      const { got, reply } = collect()
      h.services.route('session_search', {}, ASKER, reply)
      h.services.route('viewer_list', {}, ASKER, reply)
      h.services.route('dsh_list', {}, ASKER, reply)
      h.services.route('dsh_list', {}, ASKER, reply)
      expect(got).toEqual([
        { error: 'SERVICE_UNAVAILABLE', service: 'search', retryable: false },
        { error: 'SERVICE_UNAVAILABLE', service: 'viewers', retryable: false },
        { error: 'SERVICE_FAILED', service: 'store' },
        { error: 'SERVICE_UNAVAILABLE', service: 'store', retryable: false },
      ])
      expect(h.services.isOff('store')).toBe(true)
      expect(switchedOff).toHaveBeenCalledOnce()
      expect(h.lines.at(-1)).toBe('[services] store switched off after 1 failures in 60s · it stays off until the daemon restarts')
    })

    it('answers a handler that throws, rejects or replies with nothing SERVICE_FAILED, and counts each against its service', async () => {
      const h = host({ maxFailures: 3 })
      h.services.serve('store', () => ({
        a: () => { throw new Error('bad row') },
        b: async () => { throw 'closed' },
        c: () => undefined as unknown as Record<string, unknown>,
      }), fakeCore(), ['a', 'b', 'c'])
      const { got, reply } = collect()
      for (const type of ['a', 'b', 'c']) h.services.route(type, {}, ASKER, reply)
      await vi.waitFor(() => expect(got).toHaveLength(3))
      expect(got).toEqual([{ error: 'SERVICE_FAILED', service: 'store' }, { error: 'SERVICE_FAILED', service: 'store' }, { error: 'SERVICE_FAILED', service: 'store' }])
      expect(h.lines).toEqual([
        '[services] store.a failed · bad row',
        '[services] store.b failed · closed',
        '[services] store.c failed · c was answered with no reply',
        '[services] store switched off after 3 failures in 60s · it stays off until the daemon restarts',
      ])
    })

    it('leaves off a service that claims a request another answers, or that answers other than it declared', () => {
      const h = host()
      h.services.serve('store', () => ({ dsh_list: () => ({ dsh: [] }) }), fakeCore(), ['dsh_list'])
      h.services.serve('rival', () => ({ dsh_list: () => ({}) }), fakeCore(), ['dsh_list'])
      h.services.serve('loose', () => ({ a: () => ({}), b: () => ({}), c: () => ({}) }), fakeCore(), ['a'])
      h.services.serve('looser', () => ({ d: () => ({}), e: () => ({}) }), fakeCore(), ['d'])
      h.services.serve('short', () => ({}), fakeCore(), ['x', 'y'])
      h.services.serve('shorter', () => ({}), fakeCore(), ['z'])
      expect(['rival', 'loose', 'looser', 'short', 'shorter'].every((name) => h.services.isOff(name))).toBe(true)
      expect(h.services.isOff('store')).toBe(false)
      expect(h.lines).toEqual([
        '[services] rival did not start · dsh_list is answered by store · the core runs without it',
        '[services] loose did not start · it answers b, c without declaring them · the core runs without it',
        '[services] looser did not start · it answers e without declaring it · the core runs without it',
        '[services] short did not start · it declares x, y without answering them · the core runs without it',
        '[services] shorter did not start · it declares z without answering it · the core runs without it',
      ])
      // The store keeps its own requests.
      const { got, reply } = collect()
      h.services.route('dsh_list', {}, ASKER, reply)
      return vi.waitFor(() => expect(got).toEqual([{ dsh: [] }]))
    })

    it('a service with a port that answers other than it declared is off, its port empty', () => {
      const h = host()
      h.services.start('search', (_core, ports) => { ports.search = new FakeSearch() as unknown as SearchPort; return {} }, fakeCore(), SEARCH, ['session_search'])
      expect(h.ports.search).toBeNull()
      expect(h.services.isOff('search')).toBe(true)
      expect(h.lines).toEqual(['[services] search did not start · it declares session_search without answering it · the core runs without it'])
    })

    it('serves a service with no port, and will not serve one whose name is a port\'s', () => {
      const h = host()
      h.services.serve('search', () => ({}), fakeCore(), [])
      expect(h.services.isOff('search')).toBe(true)
      expect(h.ports.search).toBeNull()
      expect(h.lines).toEqual(['[services] search did not start · it has a port: start it with start() · the core runs without it'])
    })
  })

  describe('faults injected for the end-to-end suite', () => {
    beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}) })

    it('reads a comma-separated list, and none when unset', () => {
      expect([...testFaults(' search , viewers.attach,,')]).toEqual(['search', 'viewers.attach'])
      expect(testFaults(undefined).size).toBe(0)
    })

    it('fails a service\'s start, or one member on every call, as a real fault would', () => {
      const started = host({ faults: testFaults('search') })
      startSearch(started)
      expect(started.ports.search).toBeNull()
      expect(started.lines).toEqual(['[services] search did not start · injected fault: search · the core runs without it'])

      const member = host({ faults: testFaults('search.touch') })
      const real = startSearch(member, new FakeSearch()) as unknown as FakeSearch
      member.ports.search!.touch('s1')
      member.ports.search!.deleteHistory('s1')
      expect(real.calls).toEqual(['delete s1'])
      expect(member.lines).toEqual(['[services] search.touch failed · injected fault: search.touch'])
    })

    it('fails one request on every ask, and leaves the service\'s others alone', async () => {
      const h = host({ faults: testFaults('store.dsh_list') })
      h.services.serve('store', () => ({ dsh_list: () => ({ dsh: [] }), dsh_remove: () => ({ ok: true }) }), fakeCore(), ['dsh_list', 'dsh_remove'])
      const got: Array<Record<string, unknown>> = []
      h.services.route('dsh_list', {}, { local: true, owner: true }, (result) => got.push(result))
      h.services.route('dsh_remove', {}, { local: true, owner: true }, (result) => got.push(result))
      await vi.waitFor(() => expect(got).toHaveLength(2))
      expect(got).toEqual([{ error: 'SERVICE_FAILED', service: 'store' }, { ok: true }])
      expect(h.lines).toEqual(['[services] store.dsh_list failed · injected fault: store.dsh_list'])
    })
  })
})
