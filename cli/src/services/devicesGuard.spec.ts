// The devices' own guards (services/devicesGuard.ts): one part failing costs that part, never the others.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FAIL, later, ServiceUnavailableError, type PortFallbacks } from '../core/api.js'
import { createPartGuard } from './devicesGuard.js'

afterEach(() => vi.restoreAllMocks())

describe('a notice into a part', () => {
  it('runs it, and logs a throw or a rejection once a minute with a count of the rest', async () => {
    let at = 0
    const log = vi.fn()
    const guard = createPartGuard({ log, now: () => at })
    const ran = vi.fn()
    guard.call('dial', ran)
    expect(ran).toHaveBeenCalledOnce()
    guard.call('dial', () => { throw new Error('unplugged') })
    guard.call('dial', () => { throw new Error('unplugged') })
    guard.call('dial', () => Promise.reject(new Error('later')))
    await Promise.resolve()
    expect(log.mock.calls).toEqual([['[devices] dial failed · unplugged']])
    // Each part is counted on its own, and a thrown non-error is said as it is.
    guard.call('window', () => { throw 'gone' })
    expect(log).toHaveBeenLastCalledWith('[devices] window failed · gone')
    at = 61_000
    guard.call('dial', () => { throw new Error('still') })
    expect(log).toHaveBeenLastCalledWith('[devices] dial failed · still · 2 more since')
    // A promise that settles well is nothing to say.
    guard.call('dial', () => Promise.resolve('fine'))
    await Promise.resolve()
    expect(log).toHaveBeenCalledTimes(3)
  })

  it('fails every call into a part the end-to-end suite names, and says so on the console by default', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const guard = createPartGuard({ faults: new Set(['dial']) })
    const ran = vi.fn()
    guard.call('dial', ran)
    guard.call('window', ran)
    expect(ran).toHaveBeenCalledOnce()
    expect(error).toHaveBeenCalledWith('[devices] dial failed · injected fault: dial')
  })
})

interface Router {
  knows(agentId: string): boolean
  total(): number
  list(): Promise<string[]>
  named(): Promise<string>
  stop(): void
}

const FALLBACKS: PortFallbacks<Router> = { knows: FAIL, total: 0, list: later(FAIL), named: later('nobody'), stop: undefined }

describe('a part with members', () => {
  const router = (over: Partial<Router> = {}): Router => ({
    knows: () => true, total: () => 3, list: async () => ['a'], named: async () => 'Ada', stop: vi.fn(), ...over,
  })

  it('answers through its members while they answer', async () => {
    const guard = createPartGuard({ log: vi.fn() })
    const part = guard.start('fleet', () => router(), FALLBACKS)!
    expect(part.knows('a')).toBe(true)
    expect(part.total()).toBe(3)
    expect(await part.list()).toEqual(['a'])
    expect(await part.named()).toBe('Ada')
    expect(guard.isOff('fleet')).toBe(false)
  })

  it('is left off when its start throws, or the suite says so', () => {
    const log = vi.fn()
    const guard = createPartGuard({ log, faults: new Set(['lane']) })
    expect(guard.start('fleet', () => { throw new Error('no identity') }, FALLBACKS)).toBeNull()
    expect(guard.start('lane', () => router(), FALLBACKS)).toBeNull()
    expect(log.mock.calls).toEqual([
      ['[devices] fleet did not start · no identity · the devices run without it'],
      ['[devices] lane did not start · injected fault: lane · the devices run without it'],
    ])
    expect(guard.isOff('fleet')).toBe(true)
  })

  it('answers a failing member with its fallback: FAIL as unavailable, a value as itself, a promise as either', async () => {
    const log = vi.fn()
    const guard = createPartGuard({ log, faults: new Set(['fleet.total']) })
    const part = guard.start('fleet', () => router({
      knows: () => { throw new Error('lost') },
      list: async () => { throw new Error('rpc') },
      named: () => { throw new Error('sync throw') },
    }), FALLBACKS)!
    expect(() => part.knows('a')).toThrow(ServiceUnavailableError)
    expect(part.total()).toBe(0)
    await expect(part.list()).rejects.toBeInstanceOf(ServiceUnavailableError)
    expect(await part.named()).toBe('nobody')
    expect(log.mock.calls.map(([line]) => line)).toEqual([
      '[devices] fleet.knows failed · lost',
      '[devices] fleet.total failed · injected fault: fleet.total',
      '[devices] fleet.list failed · rpc',
      '[devices] fleet.named failed · sync throw',
    ])
  })

  it('is switched off, and stopped, after five failures in a minute: then only its fallbacks answer', async () => {
    let at = 0
    const log = vi.fn()
    const stop = vi.fn()
    const knows = vi.fn(() => { throw new Error('lost') })
    const guard = createPartGuard({ log, now: () => at })
    const part = guard.start('fleet', () => router({ knows, stop }), FALLBACKS)!
    for (let i = 0; i < 4; i++) { at += 20_000; expect(() => part.knows('a')).toThrow(ServiceUnavailableError) }
    // Spread over more than a minute: the oldest has aged out, so it is not off yet.
    expect(guard.isOff('fleet')).toBe(false)
    for (let i = 0; i < 2; i++) expect(() => part.knows('a')).toThrow(ServiceUnavailableError)
    expect(guard.isOff('fleet')).toBe(true)
    expect(stop).toHaveBeenCalledOnce()
    expect(log).toHaveBeenCalledWith('[devices] fleet switched off after 5 failures in 60s · it stays off until the devices restart')
    // Off: nothing reaches it any more.
    knows.mockClear()
    expect(() => part.knows('a')).toThrow(ServiceUnavailableError)
    expect(part.total()).toBe(0)
    expect(await part.named()).toBe('nobody')
    expect(knows).not.toHaveBeenCalled()
  })

  it('switches off a part with no stop, or one whose stop throws or rejects, all the same', () => {
    for (const stop of [undefined, () => { throw new Error('stuck') }, () => Promise.reject(new Error('stuck'))]) {
      const guard = createPartGuard({ log: vi.fn(), maxFailures: 1 })
      const base = router({ knows: () => { throw new Error('lost') } })
      const target = stop === undefined ? { ...base, stop: undefined } : { ...base, stop }
      const part = guard.start('fleet', () => target as Router, FALLBACKS)!
      expect(() => part.knows('a')).toThrow(ServiceUnavailableError)
      expect(guard.isOff('fleet')).toBe(true)
      // Failing again once off says it failed, and switches nothing a second time.
      expect(() => (part as unknown as { total: () => number }).total()).not.toThrow()
    }
  })

  it('counts a failure that lands after the part was switched off without switching it again', async () => {
    const log = vi.fn()
    let reject!: (error: Error) => void
    const guard = createPartGuard({ log, maxFailures: 1 })
    const part = guard.start('fleet', () => router({
      list: () => new Promise((_, no) => { reject = no }),
      knows: () => { throw new Error('lost') },
    }), FALLBACKS)!
    const pending = part.list()
    expect(() => part.knows('a')).toThrow(ServiceUnavailableError)
    reject(new Error('late'))
    await expect(pending).rejects.toBeInstanceOf(ServiceUnavailableError)
    expect(log.mock.calls.filter(([line]) => String(line).includes('switched off'))).toHaveLength(1)
  })
})
