import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HttpAnswer, ServiceHttpRoute } from './api.js'
import { createServiceRoutes, type ServiceRouter } from './serviceRoutes.js'

const DOWN: HttpAnswer = { status: 503, body: { error: { code: 'UNAVAILABLE', message: 'not running' } } }
const routes: ServiceHttpRoute[] = [
  { path: /^\/api\/thing\/slow$/, type: 'thing_slow_http', waitMs: 9_000, unanswered: { status: 504, body: { error: { code: 'OUTCOME_UNKNOWN', message: 'maybe' } } } },
  { path: /^\/api\/thing\//, type: 'thing_http', waitMs: 3_000, unanswered: DOWN },
]

/** A router that owns `types` and answers each request with what `answer` gives, or never when it gives undefined. */
function router(types: string[], answer: (type: string, payload: Record<string, unknown>) => Record<string, unknown> | undefined): ServiceRouter & { route: ReturnType<typeof vi.fn> } {
  return {
    route: vi.fn((type: string, payload: Record<string, unknown>, _asker: unknown, reply: (result: Record<string, unknown>) => void) => {
      if (!types.includes(type)) return false
      const result = answer(type, payload)
      if (result) queueMicrotask(() => reply(result))
      return true
    }),
  }
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('the door\'s routes a service answers', () => {
  it('asks the first service that owns the route\'s request, as this computer\'s owner, and writes its answer as it gave it', async () => {
    const outside = router(['thing_http'], (_type, payload) => ({ status: 201, body: { heard: payload } }))
    const inside = router(['thing_http', 'thing_slow_http'], () => ({ status: 200, body: {} }))
    const doors = createServiceRoutes({ routes, routers: [outside, inside] })
    const request = { method: 'POST', target: '/api/thing/save?x=1', body: '{"a":1}' }
    expect(await doors.answer('/api/thing/save', request)).toEqual({ status: 201, body: { heard: request } })
    expect(outside.route).toHaveBeenCalledWith('thing_http', request, { local: true, owner: true }, expect.any(Function), 3_000)
    expect(inside.route).not.toHaveBeenCalled()
    // The first route that matches takes it, with its own wait; the next router when the first owns none of it.
    await doors.answer('/api/thing/slow', { method: 'GET', target: '/api/thing/slow' })
    expect(inside.route).toHaveBeenCalledWith('thing_slow_http', { method: 'GET', target: '/api/thing/slow' }, { local: true, owner: true }, expect.any(Function), 9_000)
  })

  it('is not asked for a path no service answers', () => {
    const doors = createServiceRoutes({ routes, routers: [router(['thing_http'], () => ({}))] })
    expect(doors.answer('/api/other', { method: 'GET', target: '/api/other' })).toBeNull()
  })

  it('answers the route\'s own answer, at once, while its service is down or no service here owns it', async () => {
    const log = vi.fn()
    const down = createServiceRoutes({ routes, routers: [router(['thing_http'], () => ({ error: 'SERVICE_UNAVAILABLE', service: 'thing', retryable: true }))], log })
    expect(await down.answer('/api/thing/save', { method: 'GET', target: '/api/thing/save' })).toEqual(DOWN)
    const failed = createServiceRoutes({ routes, routers: [router(['thing_http'], () => ({ error: 'SERVICE_FAILED', service: 'thing' }))], log })
    expect(await failed.answer('/api/thing/save', { method: 'GET', target: '/api/thing/save' })).toEqual(DOWN)
    const none = createServiceRoutes({ routes, routers: [router([], () => ({}))], log })
    expect(await none.answer('/api/thing/slow', { method: 'GET', target: '/api/thing/slow' })).toEqual(routes[0].unanswered)
    // Said where it is seen: the link or the host.
    expect(log).not.toHaveBeenCalled()
  })

  it('answers the route\'s own answer for an answer that is none, and says so', async () => {
    const log = vi.fn()
    for (const wrong of [{}, { status: 200 }, { status: 99, body: {} }, { status: 600, body: {} }, { status: 200.5, body: {} }, { status: '200', body: {} },
      { status: 200, body: [] }, { status: 200, body: null }, { status: 200, body: 'text' }]) {
      const doors = createServiceRoutes({ routes, routers: [router(['thing_http'], () => wrong)], log })
      expect(await doors.answer('/api/thing/save', { method: 'GET', target: '/api/thing/save' }), JSON.stringify(wrong)).toEqual(DOWN)
    }
    expect(log).toHaveBeenCalledTimes(9)
    expect(log).toHaveBeenLastCalledWith('[services] thing_http was answered with no HTTP answer: answered 503 instead')
  })

  it('bounds the wait itself: a service that never answers is answered for when the route\'s wait runs out', async () => {
    let fire: (() => void) | undefined
    const setTimer = vi.fn((run: () => void, ms: number) => { fire = run; return ms })
    const clearTimer = vi.fn()
    const silent = router(['thing_http'], () => undefined)
    const doors = createServiceRoutes({ routes, routers: [silent], setTimer, clearTimer })
    const answer = doors.answer('/api/thing/save', { method: 'GET', target: '/api/thing/save' })
    expect(setTimer).toHaveBeenCalledWith(expect.any(Function), 3_000)
    fire!()
    expect(await answer).toEqual(DOWN)
    // A late answer goes nowhere.
    const late = silent.route.mock.calls[0][3] as (result: Record<string, unknown>) => void
    late({ status: 200, body: {} })
    expect(clearTimer).toHaveBeenCalledOnce()
  })

  it('waits on real timers and says what is wrong on the console when not told otherwise', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const doors = createServiceRoutes({ routes, routers: [router(['thing_http'], (_type, payload) => (payload.target === '/api/thing/wrong' ? { nope: true } : undefined))] })
    const waited = doors.answer('/api/thing/save', { method: 'GET', target: '/api/thing/save' })
    await vi.advanceTimersByTimeAsync(3_000)
    expect(await waited).toEqual(DOWN)
    const wrong = doors.answer('/api/thing/wrong', { method: 'GET', target: '/api/thing/wrong' })
    await vi.advanceTimersByTimeAsync(0)
    expect(await wrong).toEqual(DOWN)
    expect(warn).toHaveBeenCalledWith('[services] thing_http was answered with no HTTP answer: answered 503 instead')
  })
})
