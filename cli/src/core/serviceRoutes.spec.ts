import { afterEach, describe, expect, it, vi } from 'vitest'
import { SERVICE_WS_FRAMES } from './api.js'
import type { Asker, HttpAnswer, ServiceHttpRoute, ServiceWsFrame } from './api.js'
import { createServiceRoutes, type ServiceRouter } from './serviceRoutes.js'
import { createServiceLinks, type ServiceFrame } from './serviceLinks.js'

const DOWN: HttpAnswer = { status: 503, body: { error: { code: 'UNAVAILABLE', message: 'not running' } } }
const routes: ServiceHttpRoute[] = [
  { path: /^\/api\/thing\/slow$/, type: 'thing_slow_http', waitMs: 9_000, unanswered: { status: 504, body: { error: { code: 'OUTCOME_UNKNOWN', message: 'maybe' } } } },
  { path: /^\/api\/thing\//, type: 'thing_http', waitMs: 3_000, unanswered: DOWN },
]

/** A router that owns `types` and answers each request with what `answer` gives, or never when it gives undefined. */
function router(types: string[], answer: (type: string, payload: Record<string, unknown>) => Record<string, unknown> | undefined = () => undefined): ServiceRouter & { route: ReturnType<typeof vi.fn> } {
  return {
    route: vi.fn((type: string, payload: Record<string, unknown>, _asker: unknown, reply: (result: Record<string, unknown>) => void) => {
      if (!types.includes(type)) return false
      const result = answer(type, payload)
      if (result) queueMicrotask(() => reply(result))
      return true
    }),
  }
}

/** A request as the door has it: [body] is what its read gives. */
const asked = (method: string, target: string, body = '') => ({ method, target, readBody: vi.fn(async (_max?: number) => body) })
const read = (target: string) => asked('GET', target)
const frame = (doors: ReturnType<typeof createServiceRoutes>, connection: string, message: Record<string, unknown>) =>
  doors.frames.get(message.type as string)?.(connection, message)

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

it('routes the two local desk declarations without granting any RPC caller desk authority', async () => {
  const linked = router(['devices_ws'], () => ({ protocol: 1, machineId: 'm', requestId: 'cannot-replace' }))
  const doors = createServiceRoutes({ routes: [], frames: SERVICE_WS_FRAMES, linked, hosted: router([]) })
  const answer = vi.fn()
  for (const type of ['harness_device_step', 'harness_device_scroll']) {
    for (const asker of [{ local: true, owner: true }, { local: false, owner: true }, { local: true, owner: false }, { local: false, owner: false, guest: 'guest' }]) {
      expect(doors.route(type, {}, asker, answer)).toBe(false)
    }
  }
  expect(linked.route).not.toHaveBeenCalled()
  expect(await frame(doors, 'local:tool', { type: 'harness_device_step', payload: { requestId: 'exact', machineId: 'm', probe: true } }))
    .toEqual({ type: 'harness_device_step_result', payload: { requestId: 'exact', protocol: 1, machineId: 'm' } })
  expect(linked.route).toHaveBeenCalledWith('devices_ws', { frame: 'harness_device_step', payload: { requestId: 'exact', machineId: 'm', probe: true } },
    { local: true, owner: true, connection: 'local:tool' }, expect.any(Function), 5000)
  expect(await frame(doors, 'local:tool', { type: 'harness_device_scroll', payload: { machineId: 'm', phase: 'up', dy: 0, velocity: 0 } })).toBeNull()
})

describe('declared service frames over owner RPC', () => {
  const frames = [{ frame: 'pick', type: 'thing_ws', result: 'picked', waitMs: 25_000, unanswered: { chosen: false }, rpc: 'owner' },
    { frame: 'notice', type: 'thing_ws', waitMs: 5_000 }] as ServiceWsFrame[]
  const owner: Asker = { local: false, owner: true, connection: 'remote', requestId: 'r-1', accountOwner: true }
  const rpc = (doors: ReturnType<typeof createServiceRoutes>, type: string, payload: Record<string, unknown>, asker = owner) => {
    let resolve!: (answer: Record<string, unknown>) => void
    const answer = new Promise<Record<string, unknown>>((finish) => { resolve = finish })
    const taken = (doors as unknown as ServiceRouter).route(type, payload, asker, resolve)
    return { taken, answer }
  }

  it('enforces declared local-only RPC provenance before waking a component', async () => {
    const linked = router(['thing_ws'], () => ({ handled: true }))
    const doors = createServiceRoutes({ routes: [], linked, frames: [{ frame: 'local_action', type: 'thing_ws', rpc: 'local', waitMs: 1000 }] })
    expect(await rpc(doors, 'local_action', { local: true }).answer).toEqual({ error: 'LOCAL_ONLY' })
    expect(linked.route).not.toHaveBeenCalled()
    expect(await rpc(doors, 'local_action', {}, { ...owner, local: true }).answer).toEqual({ handled: true })
  })

  it('keeps the authenticated asker, wrapper and service reply, including declared command errors', async () => {
    let result: Record<string, unknown> = { chosen: 'agent' }
    const linked = router(['thing_ws'], () => result)
    const doors = createServiceRoutes({ routes: [], frames, linked, hosted: router([]) })
    const payload = { requestId: 'r-1', text: 'private', owner: true, local: true }
    const request = rpc(doors, 'pick', payload)
    expect(request.taken).toBe(true)
    expect(await request.answer).toEqual(result)
    expect(linked.route).toHaveBeenCalledWith('thing_ws', { frame: 'pick', payload }, { ...owner, rpcRoute: true }, expect.any(Function), 25_000)
    for (const error of ['INVALID_REQUEST', 'BUSY', 'COMMAND_UNAVAILABLE', 'OWNER_REQUIRED']) {
      result = { error, detail: 'fixed detail' }
      expect(await rpc(doors, 'pick', {}).answer).toEqual(result)
    }
    result = { chosen: 'agent', requestId: 'forged' }
    expect(await rpc(doors, 'pick', { requestId: 'r-1' }).answer).toEqual({ chosen: 'agent' })
    expect((doors as unknown as ServiceRouter).route('notice', {}, owner, vi.fn())).toBe(false)
    expect((doors as unknown as ServiceRouter).route('unknown', {}, owner, vi.fn())).toBe(false)
  })

  it('refuses non-owners and guests before a missing service could be started', async () => {
    const linked = router(['thing_ws']), hosted = router([])
    const doors = createServiceRoutes({ routes: [], frames, linked, hosted })
    for (const asker of [{ ...owner, owner: false }, { ...owner, guest: 'guest' }, { ...owner, local: true, owner: false }]) {
      expect(await rpc(doors, 'pick', { owner: true, local: true }, asker).answer).toEqual({ error: 'OWNER_REQUIRED' })
    }
    expect(linked.route).not.toHaveBeenCalled()
    expect(hosted.route).not.toHaveBeenCalled()
  })

  it('preserves legacy unavailability and answers once when the actual operation settles after its deadline', async () => {
    vi.useFakeTimers()
    for (const error of ['SERVICE_UNAVAILABLE', 'SERVICE_FAILED']) {
      const down = createServiceRoutes({ routes: [], frames, linked: router(['thing_ws'], () => ({ error })), hosted: router([]) })
      expect(await rpc(down, 'pick', {}).answer).toEqual({ chosen: false })
    }
    let finish!: (result: Record<string, unknown>) => void
    const hosted = { route: (_type: string, _payload: Record<string, unknown>, _asker: Asker, reply: typeof finish) => { finish = reply; return true } }
    const slow = createServiceRoutes({ routes: [], frames, linked: router([]), hosted })
    const reply = vi.fn()
    expect((slow as unknown as ServiceRouter).route('pick', {}, owner, reply)).toBe(true)
    await vi.advanceTimersByTimeAsync(25_000)
    expect(reply).toHaveBeenCalledExactlyOnceWith({ chosen: false })
    finish({ chosen: 'late' })
    await Promise.resolve()
    expect(reply).toHaveBeenCalledTimes(1)
    const noFallback = createServiceRoutes({ routes: [], frames: [{ ...frames[0], unanswered: undefined }], linked: router([]), hosted: router([]) })
    expect(await rpc(noFallback, 'pick', {}).answer).toEqual({})
  })

  it('never delivers a startup request after its connection closes, including a reused connection name', async () => {
    vi.useFakeTimers()
    const want = vi.fn()
    const linked = createServiceLinks({ token: 'token', owned: { thing: ['thing_ws'] }, answer: () => ({}), onDemand: new Set(['thing']), want })
    const doors = createServiceRoutes({ routes: [], frames, linked, hosted: router([]) })
    const first = rpc(doors, 'pick', { text: 'old connection' })
    expect(want).toHaveBeenCalledWith('thing')
    linked.closeConnection('remote')
    expect(await first.answer).toEqual({ chosen: false })
    const second = rpc(doors, 'pick', { text: 'new connection' })
    const sent: ServiceFrame[] = []
    const peer = linked.accept('thing', 'token', { sendFrame: frame => { sent.push(frame); return true } }, vi.fn())!
    expect(sent).toHaveLength(1)
    expect(sent[0].payload?.payload).toEqual({ text: 'new connection' })
    peer.receive({ type: 'thing_ws_result', payload: { requestId: sent[0].payload?.requestId, chosen: 'new' } })
    expect(await second.answer).toEqual({ chosen: 'new' })
    peer.closed()
    const down = rpc(doors, 'pick', {})
    expect(await down.answer).toEqual({ chosen: false })
    expect(want).toHaveBeenCalledTimes(2)
  })
})

describe('the door\'s routes a service answers', () => {
  it('asks a service in its own process first, as this computer\'s owner, with the route\'s wait, and writes its answer as it gave it', async () => {
    const linked = router(['thing_http'], (_type, payload) => ({ status: 201, body: { heard: payload } }))
    const hosted = router(['thing_http', 'thing_slow_http'], () => ({ status: 200, body: {} }))
    const setTimer = vi.fn()
    const doors = createServiceRoutes({ routes, linked, hosted, setTimer })
    const request = { method: 'POST', target: '/api/thing/save?x=1', body: '{"a":1}' }
    expect(await doors.answer('/api/thing/save', asked('POST', '/api/thing/save?x=1', '{"a":1}'))).toEqual({ status: 201, body: { heard: request } })
    expect(linked.route).toHaveBeenCalledWith('thing_http', request, { local: true, owner: true }, expect.any(Function), 3_000)
    expect(hosted.route).not.toHaveBeenCalled()
    // Its link bounds the wait itself, a start first: no timer of the door's own.
    expect(setTimer).not.toHaveBeenCalled()
    // The first route that matches takes it; this process's service when none in its own owns it.
    expect(await doors.answer('/api/thing/slow', read('/api/thing/slow'))).toEqual({ status: 200, body: {} })
    expect(hosted.route).toHaveBeenCalledWith('thing_slow_http', { method: 'GET', target: '/api/thing/slow' }, { local: true, owner: true }, expect.any(Function))
  })

  it('answers an unowned route without an inline host or a spurious request failure', async () => {
    const log = vi.fn()
    const doors = createServiceRoutes({ routes, linked: router([]), log })
    expect(await doors.answer('/api/thing/save', read('/api/thing/save'))).toEqual(DOWN)
    expect(log).not.toHaveBeenCalled()
  })

  it('is not asked for a path no service answers', () => {
    const doors = createServiceRoutes({ routes, linked: router(['thing_http']), hosted: router([]) })
    expect(doors.answer('/api/other', read('/api/other'))).toBeNull()
  })

  it('waits for a service in its own process as long as its link does: a request that first waits for its process to start is not cut short', async () => {
    vi.useFakeTimers()
    let reply: ((result: Record<string, unknown>) => void) | undefined
    const linked: ServiceRouter = { route: (_type, _payload, _asker, given) => { reply = given; return true } }
    const doors = createServiceRoutes({ routes, linked, hosted: router([]) })
    const answer = doors.answer('/api/thing/save', read('/api/thing/save'))
    // Its process took longer to start than the route's whole wait, then answered within it.
    await vi.advanceTimersByTimeAsync(3_000 + 5_000)
    reply!({ status: 200, body: { started: true } })
    expect(await answer).toEqual({ status: 200, body: { started: true } })
  })

  it('answers the route\'s own answer, at once, while its service is down or no service owns it', async () => {
    const log = vi.fn()
    const down = createServiceRoutes({ routes, linked: router(['thing_http'], () => ({ error: 'SERVICE_UNAVAILABLE', service: 'thing', retryable: true })), hosted: router([]), log })
    expect(await down.answer('/api/thing/save', read('/api/thing/save'))).toEqual(DOWN)
    const failed = createServiceRoutes({ routes, linked: router([]), hosted: router(['thing_http'], () => ({ error: 'SERVICE_FAILED', service: 'thing' })), log })
    expect(await failed.answer('/api/thing/save', read('/api/thing/save'))).toEqual(DOWN)
    const none = createServiceRoutes({ routes, linked: router([]), hosted: router([]), log })
    expect(await none.answer('/api/thing/slow', read('/api/thing/slow'))).toEqual(routes[0].unanswered)
    // Said where it is seen: the link or the host.
    expect(log).not.toHaveBeenCalled()
  })

  it('answers the route\'s own answer for an answer that is none, and says so', async () => {
    const log = vi.fn()
    for (const wrong of [{}, { status: 200 }, { status: 99, body: {} }, { status: 600, body: {} }, { status: 200.5, body: {} }, { status: '200', body: {} },
      { status: 200, body: [] }, { status: 200, body: null }, { status: 200, body: 'text' }]) {
      const doors = createServiceRoutes({ routes, linked: router(['thing_http'], () => wrong), hosted: router([]), log })
      expect(await doors.answer('/api/thing/save', read('/api/thing/save')), JSON.stringify(wrong)).toEqual(DOWN)
    }
    expect(log).toHaveBeenCalledTimes(9)
    expect(log).toHaveBeenLastCalledWith('[services] thing_http was answered with no HTTP answer: answered 503 instead')
  })

  it('bounds the wait of a service in this process itself, which nothing else bounds', async () => {
    let fire: (() => void) | undefined
    const setTimer = vi.fn((run: () => void, ms: number) => { fire = run; return ms })
    const clearTimer = vi.fn()
    const silent = router(['thing_http'])
    const doors = createServiceRoutes({ routes, linked: router([]), hosted: silent, setTimer, clearTimer })
    const answer = doors.answer('/api/thing/save', read('/api/thing/save'))
    expect(setTimer).toHaveBeenCalledWith(expect.any(Function), 3_000)
    fire!()
    expect(await answer).toEqual(DOWN)
    // A late answer goes nowhere.
    const late = silent.route.mock.calls[0][3] as (result: Record<string, unknown>) => void
    late({ status: 200, body: {} })
    expect(clearTimer).toHaveBeenCalledOnce()
  })

  it('takes only the methods a route names, and leaves the others to the door', async () => {
    const linked = router(['account_http'], () => ({ status: 200, body: { ok: true } }))
    const doors = createServiceRoutes({ routes: [{ path: /^\/api\/desk$/, methods: ['GET'], type: 'account_http', waitMs: 1_000, unanswered: DOWN }], linked, hosted: router([]) })
    expect(await doors.answer('/api/desk', read('/api/desk'))).toEqual({ status: 200, body: { ok: true } })
    const post = asked('POST', '/api/desk', '{}')
    expect(doors.answer('/api/desk', post)).toBeNull()
    expect(post.readBody).not.toHaveBeenCalled()
  })

  it('refuses a write without the local header with the door\'s own 403, its route\'s headers on it, and never asks the service', async () => {
    const linked = router(['account_http'], () => ({ status: 200, body: { kept: true } }))
    const route: ServiceHttpRoute = { path: /^\/api\/report$/, methods: ['GET', 'POST'], writes: ['POST'], type: 'account_http', waitMs: 1_000,
      unanswered: DOWN, headers: { 'x-vocabulary': '10' } }
    const doors = createServiceRoutes({ routes: [route], linked, hosted: router([]) })
    const write = asked('POST', '/api/report', '{}')
    expect(await doors.answer('/api/report', write)).toEqual({ status: 403, body: { error: 'FORBIDDEN' }, headers: { 'x-vocabulary': '10' } })
    expect(await doors.answer('/api/report', write, false)).toEqual({ status: 403, body: { error: 'FORBIDDEN' }, headers: { 'x-vocabulary': '10' } })
    // Refused, its body is never read.
    expect(write.readBody).not.toHaveBeenCalled()
    expect(linked.route).not.toHaveBeenCalled()
    // With it, the service answers; a read needs none.
    expect(await doors.answer('/api/report', write, true)).toEqual({ status: 200, body: { kept: true }, headers: { 'x-vocabulary': '10' } })
    expect(await doors.answer('/api/report', read('/api/report'))).toEqual({ status: 200, body: { kept: true }, headers: { 'x-vocabulary': '10' } })
  })

  it('writes only the headers a route declares: its own on every answer, and those its service may set, one short line each', async () => {
    const answers: Record<string, unknown>[] = [
      { status: 429, body: { busy: true }, headers: { 'retry-after': '91', 'set-cookie': 'x=1' } },
      { status: 200, body: {}, headers: { 'retry-after': 'two\nlines' } },
      { status: 200, body: {}, headers: { 'retry-after': 'x'.repeat(129) } },
      { status: 200, body: {}, headers: { 'retry-after': 5 } },
      { status: 200, body: {}, headers: 'retry-after: 5' },
      { status: 200, body: {} },
    ]
    const linked = router(['account_http'], () => answers.shift())
    const route: ServiceHttpRoute = { path: /^\/api\/report$/, type: 'account_http', waitMs: 1_000, unanswered: DOWN,
      headers: { 'x-vocabulary': '10' }, answerHeaders: ['retry-after'] }
    const doors = createServiceRoutes({ routes: [route], linked, hosted: router([]) })
    expect(await doors.answer('/api/report', read('/api/report'))).toEqual({ status: 429, body: { busy: true }, headers: { 'retry-after': '91', 'x-vocabulary': '10' } })
    for (let i = 0; i < 5; i++) expect(await doors.answer('/api/report', read('/api/report'))).toEqual({ status: 200, body: {}, headers: { 'x-vocabulary': '10' } })
    // Its answer while its service is down carries its own headers too, and a route with none declares none.
    const down = createServiceRoutes({ routes: [route], linked: router(['account_http'], () => ({ error: 'SERVICE_UNAVAILABLE' })), hosted: router([]) })
    expect(await down.answer('/api/report', read('/api/report'))).toEqual({ ...DOWN, headers: { 'x-vocabulary': '10' } })
    const bare = createServiceRoutes({ routes: [{ ...route, headers: undefined }], linked: router(['account_http'], () => ({ status: 200, body: {}, headers: { 'retry-after': '5' } })), hosted: router([]) })
    expect(await bare.answer('/api/report', read('/api/report'))).toEqual({ status: 200, body: {}, headers: { 'retry-after': '5' } })
    const none = createServiceRoutes({ routes: [{ ...route, headers: undefined, answerHeaders: undefined }], linked: router(['account_http'], () => ({ status: 200, body: {}, headers: { 'retry-after': '5' } })), hosted: router([]) })
    expect(await none.answer('/api/report', read('/api/report'))).toEqual({ status: 200, body: {} })
  })

  it('reads a body only once its route takes it, up to that route\'s own bound', async () => {
    const linked = router(['thing_http'], (_type, payload) => ({ status: 200, body: { heard: payload } }))
    const doors = createServiceRoutes({ routes: [{ path: /^\/api\/report$/, type: 'thing_http', waitMs: 1_000, unanswered: DOWN, maxBodyBytes: 8192 }, ...routes], linked, hosted: router([]) })
    const report = asked('POST', '/api/report', '{"n":1}')
    expect(await doors.answer('/api/report', report)).toEqual({ status: 200, body: { heard: { method: 'POST', target: '/api/report', body: '{"n":1}' } } })
    expect(report.readBody).toHaveBeenCalledWith(8192)
    const other = asked('PUT', '/api/thing/save', 'x')
    await doors.answer('/api/thing/save', other)
    expect(other.readBody).toHaveBeenCalledWith(undefined)
  })

  it('asks a socket\'s route only over the daemon\'s own socket, saying so to its service, and answers the port with the door\'s 403', async () => {
    const linked = router(['account_http'], () => ({ status: 200, body: { code: 'hnh_x' } }))
    const route: ServiceHttpRoute = { path: /^\/api\/auth\/handoff$/, methods: ['POST'], writes: ['POST'], door: 'socket', type: 'account_http', waitMs: 1_000, unanswered: DOWN }
    const doors = createServiceRoutes({ routes: [route, { path: /^\/api\/desk$/, type: 'account_http', waitMs: 1_000, unanswered: DOWN }], linked, hosted: router([]) })
    const write = asked('POST', '/api/auth/handoff', '{}')
    // Over the port, with the local header or without, and over the socket without it: the door's 403, its body unread.
    for (const [localOk, socket] of [[true, false], [false, false], [false, true]]) {
      expect(await doors.answer('/api/auth/handoff', write, localOk, socket), `${localOk} ${socket}`).toEqual({ status: 403, body: { error: 'FORBIDDEN' } })
    }
    expect(write.readBody).not.toHaveBeenCalled()
    expect(linked.route).not.toHaveBeenCalled()
    expect(await doors.answer('/api/auth/handoff', write, true, true)).toEqual({ status: 200, body: { code: 'hnh_x' } })
    expect(linked.route).toHaveBeenLastCalledWith('account_http', { method: 'POST', target: '/api/auth/handoff', body: '{}' }, { local: true, owner: true, door: 'socket' }, expect.any(Function), 1_000)
    // Any route asked over the socket says so; over the port, none does.
    await doors.answer('/api/desk', read('/api/desk'), false, true)
    expect(linked.route).toHaveBeenLastCalledWith('account_http', { method: 'GET', target: '/api/desk' }, { local: true, owner: true, door: 'socket' }, expect.any(Function), 1_000)
    await doors.answer('/api/desk', read('/api/desk'))
    expect(linked.route).toHaveBeenLastCalledWith('account_http', { method: 'GET', target: '/api/desk' }, { local: true, owner: true }, expect.any(Function), 1_000)
  })

  const window = { local: true, owner: true, connection: 'local:w1' }
  const conn = window.connection
  const frames: ServiceWsFrame[] = [
    { frame: 'route_task', type: 'devices_ws', result: 'route_result', waitMs: 25_000, unanswered: { agentId: '', reason: 'down' } },
    { frame: 'voice_route_reply', type: 'devices_ws', waitMs: 5_000 },
  ]

  it('hands a window\'s frame to its service as the window sent it, and its answer back under the frame\'s request id', async () => {
    const linked = router(['devices_ws'], (_type, payload) => (payload.frame === 'route_task' ? { agentId: 'a1', reason: 'named' } : {}))
    const doors = createServiceRoutes({ routes, frames, linked, hosted: router([]) })
    expect(await frame(doors, conn, { type: 'route_task', payload: { requestId: 'q-1', text: ' fix ' } }))
      .toEqual({ type: 'route_result', payload: { requestId: 'q-1', agentId: 'a1', reason: 'named' } })
    expect(linked.route).toHaveBeenCalledWith('devices_ws', { frame: 'route_task', payload: { requestId: 'q-1', text: ' fix ' } }, window, expect.any(Function), 25_000)
    // Told, and never answered: nothing goes back.
    expect(await frame(doors, conn, { type: 'voice_route_reply', payload: { voiceId: 'v1', state: 'taken' } })).toBeNull()
    expect(linked.route).toHaveBeenLastCalledWith('devices_ws', { frame: 'voice_route_reply', payload: { voiceId: 'v1', state: 'taken' } }, window, expect.any(Function), 5_000)
    // A frame no service answers is the window's dispatch's, as ever, and so is every frame where none is declared.
    expect(frame(doors, conn, { type: 'agents_list', payload: {} })).toBeUndefined()
    expect(frame(doors, conn, { type: 7, payload: {} })).toBeUndefined()
    expect(frame(createServiceRoutes({ routes, linked, hosted: router([]) }), conn, { type: 'route_task', payload: {} })).toBeUndefined()
  })

  it('sends a frame\'s own answer while its service gives none, at once, under the frame\'s request id or none', async () => {
    const down = createServiceRoutes({ routes, frames, linked: router(['devices_ws'], () => ({ error: 'SERVICE_UNAVAILABLE', service: 'devices' })), hosted: router([]) })
    expect(await frame(down, conn, { type: 'route_task', payload: { requestId: 'q-2', text: 'x' } })).toEqual({ type: 'route_result', payload: { requestId: 'q-2', agentId: '', reason: 'down' } })
    expect(await frame(down, conn, { type: 'route_task', payload: 'not a payload' })).toEqual({ type: 'route_result', payload: { requestId: '', agentId: '', reason: 'down' } })
    expect(await frame(down, conn, { type: 'route_task', payload: { requestId: 7 } })).toEqual({ type: 'route_result', payload: { requestId: '', agentId: '', reason: 'down' } })
    // A service in this process that does not answer in the frame's time.
    let fire: (() => void) | undefined
    const slow = createServiceRoutes({ routes, frames, linked: router([]), hosted: router(['devices_ws']), setTimer: (run) => { fire = run }, clearTimer: () => {} })
    const answer = frame(slow, conn, { type: 'route_task', payload: { requestId: 'q-3' } })
    fire!()
    expect(await answer).toEqual({ type: 'route_result', payload: { requestId: 'q-3', agentId: '', reason: 'down' } })
  })

  it('keeps request correlation when a service supplies a different request id', async () => {
    const doors = createServiceRoutes({ routes, frames,
      linked: router(['devices_ws'], () => ({ requestId: 'other-request', agentId: 'a1' })), hosted: router([]) })
    expect(await frame(doors, conn, { type: 'route_task', payload: { requestId: 'original-request' } }))
      .toEqual({ type: 'route_result', payload: { requestId: 'original-request', agentId: 'a1' } })
    const reply = await frame(doors, conn, { type: 'route_task', payload: { requestId: 'original-request' } })
    expect(JSON.stringify(reply?.payload)).toBe('{"requestId":"original-request","agentId":"a1"}')
    const ordinary = createServiceRoutes({ routes, frames,
      linked: router(['devices_ws'], () => ({ agentId: 'a1' })), hosted: router([]) })
    const normal = await frame(ordinary, conn, { type: 'route_task', payload: { requestId: 'original-request' } })
    expect(JSON.stringify(normal?.payload)).toBe('{"requestId":"original-request","agentId":"a1"}')
  })

  it('answers a route\'s and a frame\'s own answer when its service cannot even be asked, and says so', async () => {
    const log = vi.fn()
    const broken: ServiceRouter = { route: () => { throw new Error('private-request-fixture') } }
    const doors = createServiceRoutes({ routes, frames, linked: broken, hosted: router([]), log })
    expect(await doors.answer('/api/thing/save', read('/api/thing/save'))).toEqual(DOWN)
    expect(await frame(doors, conn, { type: 'route_task', payload: { requestId: 'q-4' } })).toEqual({ type: 'route_result', payload: { requestId: 'q-4', agentId: '', reason: 'down' } })
    const odd = createServiceRoutes({ routes, linked: router([]), hosted: { route: () => { throw 'private-request-fixture' } }, setTimer: () => 0, clearTimer: () => {}, log })
    expect(await odd.answer('/api/thing/save', read('/api/thing/save'))).toEqual(DOWN)
    expect(log.mock.calls).toEqual([['[services] thing_http SERVICE_REQUEST_FAILED · Error'], ['[services] devices_ws SERVICE_REQUEST_FAILED · Error'],
      ['[services] thing_http SERVICE_REQUEST_FAILED · string']])
    expect(JSON.stringify(log.mock.calls)).not.toContain('private-request-fixture')
  })

  it('clears the inline deadline when a router throws before answering', async () => {
    vi.useFakeTimers()
    const broken: ServiceRouter = { route: () => { throw new Error('the host is closing') } }
    const doors = createServiceRoutes({ routes, frames, linked: router([]), hosted: broken, log: vi.fn() })
    expect(await doors.answer('/api/thing/save', read('/api/thing/save'))).toEqual(DOWN)
    expect(vi.getTimerCount()).toBe(0)
    expect(await frame(doors, conn, { type: 'route_task', payload: { requestId: 'q-5' } }))
      .toEqual({ type: 'route_result', payload: { requestId: 'q-5', agentId: '', reason: 'down' } })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('waits on real timers and says what is wrong on the console when not told otherwise', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const hosted = router(['thing_http'], (_type, payload) => (payload.target === '/api/thing/wrong' ? { nope: true } : undefined))
    const doors = createServiceRoutes({ routes, linked: router([]), hosted })
    const waited = doors.answer('/api/thing/save', read('/api/thing/save'))
    await vi.advanceTimersByTimeAsync(3_000)
    expect(await waited).toEqual(DOWN)
    const wrong = doors.answer('/api/thing/wrong', read('/api/thing/wrong'))
    await vi.advanceTimersByTimeAsync(0)
    expect(await wrong).toEqual(DOWN)
    expect(warn).toHaveBeenCalledWith('[services] thing_http was answered with no HTTP answer: answered 503 instead')
  })
})
