import { describe, expect, it } from 'vitest'
import { CircuitOpenError, createCircuitBreaker } from './circuitBreaker.js'

const fail = () => Promise.reject(new Error('down'))
const ok = () => Promise.resolve('ok')

function clock(start = 1_000) {
  let t = start
  return { now: () => t, advance: (ms: number) => { t += ms } }
}

describe('circuit breaker', () => {
  it('opens after the threshold of consecutive failures and then refuses without calling', async () => {
    const c = clock()
    const breaker = createCircuitBreaker({ name: 'sso', failureThreshold: 3, openMs: 10_000, now: c.now })
    for (let i = 0; i < 3; i++) await expect(breaker.run(fail)).rejects.toThrow('down')
    expect(breaker.state()).toBe('open')
    let called = false
    await expect(breaker.run(async () => { called = true; return 'x' })).rejects.toBeInstanceOf(CircuitOpenError)
    expect(called).toBe(false)
  })

  it('a success in between resets the count', async () => {
    const breaker = createCircuitBreaker({ name: 'sso', failureThreshold: 3, openMs: 10_000 })
    await expect(breaker.run(fail)).rejects.toThrow()
    await expect(breaker.run(fail)).rejects.toThrow()
    await expect(breaker.run(ok)).resolves.toBe('ok')
    await expect(breaker.run(fail)).rejects.toThrow()
    await expect(breaker.run(fail)).rejects.toThrow()
    expect(breaker.state()).toBe('closed')
  })

  it('after the open period lets one trial through: success closes it', async () => {
    const c = clock()
    const breaker = createCircuitBreaker({ name: 'sso', failureThreshold: 1, openMs: 10_000, now: c.now })
    await expect(breaker.run(fail)).rejects.toThrow()
    c.advance(9_999)
    await expect(breaker.run(ok)).rejects.toBeInstanceOf(CircuitOpenError)
    c.advance(1)
    let release!: (v: string) => void
    const trial = breaker.run(() => new Promise<string>(r => { release = r }))
    expect(breaker.state()).toBe('half_open')
    // Only one trial at a time: everyone else is still refused while it runs.
    await expect(breaker.run(ok)).rejects.toBeInstanceOf(CircuitOpenError)
    release('back')
    await expect(trial).resolves.toBe('back')
    expect(breaker.state()).toBe('closed')
    await expect(breaker.run(ok)).resolves.toBe('ok')
  })

  it('a failed trial opens it for another full period', async () => {
    const c = clock()
    const breaker = createCircuitBreaker({ name: 'sso', failureThreshold: 1, openMs: 10_000, now: c.now })
    await expect(breaker.run(fail)).rejects.toThrow()
    c.advance(10_000)
    await expect(breaker.run(fail)).rejects.toThrow('down')
    expect(breaker.state()).toBe('open')
    c.advance(9_999)
    await expect(breaker.run(ok)).rejects.toBeInstanceOf(CircuitOpenError)
  })

  it('times a call out, aborts its signal and counts it as a failure', async () => {
    const breaker = createCircuitBreaker({ name: 'redis', failureThreshold: 1, openMs: 10_000, timeoutMs: 20 })
    let aborted = false
    const started = Date.now()
    await expect(breaker.run(signal => new Promise(() => { signal.addEventListener('abort', () => { aborted = true }) })))
      .rejects.toThrow('redis timed out after 20 ms')
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(aborted).toBe(true)
    expect(breaker.state()).toBe('open')
  })

  it('an error the caller says is not the service failing passes through and counts as the service answering', async () => {
    const breaker = createCircuitBreaker({ name: 'sso', failureThreshold: 2, openMs: 10_000,
      isFailure: err => !(err instanceof Error && err.message === 'invalid token') })
    await expect(breaker.run(fail)).rejects.toThrow()
    await expect(breaker.run(() => Promise.reject(new Error('invalid token')))).rejects.toThrow('invalid token')
    await expect(breaker.run(fail)).rejects.toThrow()
    expect(breaker.state()).toBe('closed')
  })

  it('reports each change of state once', async () => {
    const c = clock()
    const changes: string[] = []
    const breaker = createCircuitBreaker({ name: 'bff', failureThreshold: 2, openMs: 1_000, now: c.now, onStateChange: s => changes.push(s) })
    await expect(breaker.run(fail)).rejects.toThrow()
    await expect(breaker.run(fail)).rejects.toThrow()
    await expect(breaker.run(ok)).rejects.toBeInstanceOf(CircuitOpenError)
    c.advance(1_000)
    await breaker.run(ok)
    expect(changes).toEqual(['open', 'half_open', 'closed'])
  })
})
