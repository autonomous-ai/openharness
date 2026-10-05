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
const SEARCH: PortFallbacks<SearchPort> = {
  touch: undefined, deleteHistory: undefined, session: undefined, search: FAIL, tail: later(FAIL), stop: undefined,
}
const VIEWERS: PortFallbacks<ViewersPort> = {
  attach: undefined, detach: undefined, frameContext: null, forwardingUrl: null, stop: later(undefined),
}

function host(options: Parameters<typeof createServiceHost>[1] = {}) {
  const ports = emptyPorts()
  const lines: string[] = []
  let at = 0
  const services = createServiceHost(ports, { log: (line) => lines.push(line), now: () => at, ...options })
  return { ports, lines, services, advance: (ms: number) => { at += ms } }
}
function startSearch(h: ReturnType<typeof host>, port: Partial<SearchPort> = new FakeSearch()) {
  h.services.start('search', (_core, ports) => { ports.search = port as SearchPort }, fakeCore(), SEARCH)
  return port as SearchPort
}

describe('hosting services so one that fails cannot take the core down', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

  describe('starting', () => {
    it('installs the port a service fills, guarded, with every call reaching it as made', async () => {
      const h = host()
      const real = new FakeSearch()
      startSearch(h, real)
      const port = h.ports.search!
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
      expect(h.ports.search!.touch('s1')).toBeUndefined()
      expect(h.ports.search!.session('s1')).toBeUndefined()
      expect(port).toBeDefined()
      expect(h.lines).toEqual(['[services] search.touch failed · store closed', '[services] search.session failed · bad row'])
    })

    it('goes back to the one request when its fallback is FAIL, sync or async', async () => {
      const h = host()
      const cause = new Error('disk I/O error')
      startSearch(h, { ...new FakeSearch(), search: () => { throw cause }, tail: async () => { throw cause } })
      let thrown: unknown
      try { h.ports.search!.search('x', {}) } catch (error) { thrown = error }
      expect(thrown).toBeInstanceOf(ServiceUnavailableError)
      expect(thrown).toMatchObject({ service: 'search', cause, name: 'ServiceUnavailableError', message: 'the search service is unavailable' })
      await expect(h.ports.search!.tail('s1', {})).rejects.toMatchObject({ service: 'search', cause })
    })

    it('resolves an async member to its fallback whether it rejects or throws before its promise', async () => {
      const h = host()
      let viewersStop: () => Promise<void> = async () => { throw new Error('viewer hung') }
      h.services.start('viewers', (_core, ports) => {
        ports.viewers = { attach: vi.fn(), detach: vi.fn(), frameContext: vi.fn(() => null), forwardingUrl: vi.fn(() => null), stop: () => viewersStop() }
      }, fakeCore(), VIEWERS)
      await expect(h.ports.viewers!.stop()).resolves.toBeUndefined()
      viewersStop = () => { throw new Error('sync throw in async member') }
      await expect(h.ports.viewers!.stop()).resolves.toBeUndefined()
      expect(h.lines).toEqual(['[services] viewers.stop failed · viewer hung', '[services] viewers.stop failed · sync throw in async member'])
    })

    it('passes a promise that resolves straight through', async () => {
      const h = host()
      h.services.start('viewers', (_core, ports) => {
        ports.viewers = { attach: vi.fn(), detach: vi.fn(), frameContext: vi.fn(() => null), forwardingUrl: vi.fn(() => 'http://v'), stop: async () => {} }
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
      const captured = h.ports.search!
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
      for (let i = 0; i < 10; i++) { h.ports.search!.touch('s1'); h.advance(6_000) }
      expect(h.services.isOff('search')).toBe(false)
    })

    it('switches off once, even when a call begun before it fails after', async () => {
      const h = host({ maxFailures: 2 })
      const rejects: Array<(error: Error) => void> = []
      startSearch(h, { ...new FakeSearch(), tail: () => new Promise((_resolve, reject) => { rejects.push(reject) }) })
      const calls = [h.ports.search!.tail('a', {}), h.ports.search!.tail('b', {}), h.ports.search!.tail('c', {})]
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
      h.ports.search!.touch('s1')
      expect(late).toHaveBeenCalled()
      expect(h.lines).toContain('[services] switching search off: stop failed')
      expect(h.lines).toContain('[services] switching search off: unbind failed')

      const async = host({ maxFailures: 1 })
      async.services.start('viewers', (_core, ports) => {
        ports.viewers = { attach: () => { throw new Error('x') }, detach: vi.fn(), frameContext: vi.fn(() => null), forwardingUrl: vi.fn(() => null), stop: async () => { throw new Error('viewer stuck') } }
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
  })
})
