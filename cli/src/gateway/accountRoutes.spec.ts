import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import type { HttpAnswer } from '../core/api.js'
import { accountRoutes, gatewayHttp, STORE_PATH_RE, type AccountBackend } from './accountRoutes.js'

/** A backend that says what it was handed. */
const echo = (): AccountBackend & ReturnType<typeof vi.fn> => vi.fn(async (method: string, path: string, body?: unknown): Promise<HttpAnswer> =>
  ({ status: 200, body: { method, path, ...(body === undefined ? {} : { body }) } }))
const BAD_REQUEST = { status: 400, body: { error: 'BAD_REQUEST' } }
const INVALID_JSON = { status: 400, body: { error: { code: 'BAD_REQUEST', message: 'Invalid JSON body' } } }
const NOT_FOUND = { status: 404, body: { error: 'not found' } }
const REPORT = { schemaVersion: 1, revision: 0, id: '12345678-1234-4234-8234-123456789012', day: '2026-10-14', counters: { ui_desktop_sign_in_ok: 1 } }

describe('the account\'s routes, answered by the gateway', () => {
  it('forwards the reads as they are', async () => {
    const backend = echo()
    const routes = accountRoutes(backend)
    for (const path of ['/api/desk', '/api/agent-messages', '/api/auth/me', '/api/product-usage/settings']) {
      expect(await routes('GET', `${path}?ignored=1`)).toEqual({ status: 200, body: { method: 'GET', path } })
    }
  })

  it('mints Add Phone\'s code with an empty body, whatever the window sent, and not its query, only for the door over the daemon\'s own socket', async () => {
    const backend = echo()
    const routes = accountRoutes(backend)
    expect(await routes('POST', '/api/auth/handoff?x=1', 'ignored', true)).toEqual({ status: 200, body: { method: 'POST', path: '/api/auth/handoff', body: {} } })
    // A client of the local WebSocket, or the door over its port: never the code, and the backend never asked.
    for (const socket of [false, undefined]) expect(await routes('POST', '/api/auth/handoff', '{}', socket)).toEqual({ status: 403, body: { error: 'FORBIDDEN' } })
    expect(backend).toHaveBeenCalledTimes(1)
    expect(await routes('GET', '/api/auth/handoff', undefined, true)).toEqual({ status: 404, body: { error: 'not found' } })
  })

  it('forwards the desk\'s ops, a tab\'s switch and the account\'s name with their bodies, and says a body that is no JSON in their words', async () => {
    const routes = accountRoutes(echo())
    expect(await routes('POST', '/api/desk/ops', '{"ops":[]}')).toEqual({ status: 200, body: { method: 'POST', path: '/api/desk/ops', body: { ops: [] } } })
    expect(await routes('POST', '/api/desk/ops', 'null')).toEqual({ status: 200, body: { method: 'POST', path: '/api/desk/ops', body: null } })
    expect(await routes('PATCH', '/api/auth/me', '{"name":"Elvis"}')).toEqual({ status: 200, body: { method: 'PATCH', path: '/api/auth/me', body: { name: 'Elvis' } } })
    expect(await routes('PATCH', '/api/agent-messages/tabs/app_1-x', '{"enabled":true}'))
      .toEqual({ status: 200, body: { method: 'PATCH', path: '/api/agent-messages/tabs/app_1-x', body: { enabled: true } } })
    for (const [method, path] of [['POST', '/api/desk/ops'], ['PATCH', '/api/auth/me'], ['PATCH', '/api/agent-messages/tabs/app']]) {
      expect(await routes(method, path, '{nope'), path).toEqual(INVALID_JSON)
    }
    for (const [method, path] of [['PATCH', '/api/agent-messages/tabs/bad.tab'], ['GET', '/api/desk/ops'], ['POST', '/api/auth/qr/claim'], ['GET', '/api/product-usage/report'], ['GET', '/api/machines/m1'], ['GET', '/api/nowhere']]) {
      expect(await routes(method, path, '{}'), `${method} ${path}`).toEqual(NOT_FOUND)
    }
  })

  it('passes the phone half of a sign-in on with the code and nothing else', async () => {
    const backend = echo()
    const routes = accountRoutes(backend)
    for (const invalid of ['{}', '{"code":""}', '{"code":5}', `{"code":"${'x'.repeat(129)}"}`, '{"code":"12345678","userId":"u2"}', 'null', 'nope']) {
      expect(await routes('POST', '/api/auth/qr/approve', invalid), invalid).toEqual(BAD_REQUEST)
    }
    expect(backend).not.toHaveBeenCalled()
    for (const action of ['lookup', 'approve', 'deny']) {
      expect(await routes('POST', `/api/auth/qr/${action}`, '{"code":"1234 5678"}'))
        .toEqual({ status: 200, body: { method: 'POST', path: `/api/auth/qr/${action}`, body: { code: '1234 5678' } } })
    }
  })

  it('takes fixed-choice feedback and the sharing choice in their own shapes only', async () => {
    const backend = echo()
    const routes = accountRoutes(backend)
    const feedback = { id: '12345678-1234-4234-8234-123456789012', answer: 'useful' }
    for (const invalid of [{ ...feedback, text: 'PRIVATE' }, { ...feedback, answer: 'PRIVATE' }, { ...feedback, id: 'PRIVATE' }, { answer: 'useful', id: 5 }, null]) {
      expect(await routes('POST', '/api/product-usage/feedback', JSON.stringify(invalid))).toEqual(BAD_REQUEST)
    }
    expect(await routes('POST', '/api/product-usage/feedback', 'nope')).toEqual(BAD_REQUEST)
    for (const invalid of ['{"enabled":false,"userId":"other"}', '{"enabled":"no"}', 'null', 'nope']) {
      expect(await routes('POST', '/api/product-usage/settings', invalid), invalid).toEqual(BAD_REQUEST)
    }
    expect(backend).not.toHaveBeenCalled()
    expect(await routes('POST', '/api/product-usage/feedback', JSON.stringify(feedback))).toEqual({ status: 200, body: { method: 'POST', path: '/api/product-usage/feedback', body: feedback } })
    expect(await routes('POST', '/api/product-usage/settings', '{"enabled":false}')).toEqual({ status: 200, body: { method: 'POST', path: '/api/product-usage/settings', body: { enabled: false } } })
  })

  it('forwards an app\'s usage report without the names it does not know, bounded, with a busy answer\'s Retry-After', async () => {
    const backend = vi.fn<AccountBackend>(async () => ({ status: 200, body: { success: true } }))
    const routes = accountRoutes(backend)
    for (const bad of [{ ...REPORT, prompt: 'PRIVATE' }, { ...REPORT, counters: { turns_started: 1 } }, { ...REPORT, counters: { ui_desktop_sign_in_ok: -1 } }]) {
      expect(await routes('POST', '/api/product-usage/report', JSON.stringify(bad))).toEqual(BAD_REQUEST)
    }
    expect(await routes('POST', '/api/product-usage/report', 'nope')).toEqual(BAD_REQUEST)
    expect(await routes('POST', '/api/product-usage/report', JSON.stringify({ ...REPORT, pad: 'x'.repeat(8192) }))).toEqual(BAD_REQUEST)
    expect(backend).not.toHaveBeenCalled()
    expect(await routes('POST', '/api/product-usage/report', JSON.stringify(REPORT))).toEqual({ status: 200, body: { success: true } })
    expect(backend).toHaveBeenLastCalledWith('POST', '/api/product-usage/report', REPORT)
    const desktop = JSON.parse(readFileSync(new URL('../../../tests/fixtures/desktop-product-usage-report.json', import.meta.url), 'utf8'))
    await routes('POST', '/api/product-usage/report', JSON.stringify({ ...desktop, counters: { ...desktop.counters, health_desktop_PRIVATE: 1 } }))
    expect(backend).toHaveBeenLastCalledWith('POST', '/api/product-usage/report', { ...desktop, counters: { ...desktop.counters, health_desktop_report_unknown_metric: 1 } })
    const busy = { success: false, error: { code: 'USAGE_WRITE_CONFLICT', message: 'Usage measurement busy' } }
    backend.mockResolvedValueOnce({ status: 429, body: busy, retryAfterMs: 90_500 })
    expect(await routes('POST', '/api/product-usage/report', JSON.stringify(REPORT))).toEqual({ status: 429, body: busy, headers: { 'retry-after': '91' } })
    backend.mockRejectedValueOnce(new Error('PRIVATE'))
    expect(await routes('POST', '/api/product-usage/report', JSON.stringify(REPORT)))
      .toEqual({ status: 502, body: { success: false, error: { code: 'USAGE_UNAVAILABLE', message: 'Product usage unavailable' } } })
  })

  it('renames and deletes a machine by its id, decoded and encoded again, the name and nothing else forwarded', async () => {
    const log = vi.fn()
    const routes = accountRoutes(echo(), log)
    expect(await routes('PATCH', '/api/machines/m%201?x=1', '{"name":"Studio","extra":1}'))
      .toEqual({ status: 200, body: { method: 'PATCH', path: '/api/machines/m%201', body: { name: 'Studio' } } })
    expect(await routes('DELETE', '/api/machines/m%2F1')).toEqual({ status: 200, body: { method: 'DELETE', path: '/api/machines/m%2F1' } })
    expect(await routes('PATCH', '/api/machines/', '{"name":"Studio"}')).toEqual({ status: 400, body: { error: 'MISSING_MACHINE_ID' } })
    expect(await routes('DELETE', '/api/machines/')).toEqual({ status: 400, body: { error: 'MISSING_MACHINE_ID' } })
    expect(await routes('PATCH', '/api/machines/m1', '{}')).toEqual({ status: 400, body: { error: 'MISSING_NAME' } })
    expect(await routes('PATCH', '/api/machines/m1', 'nope')).toEqual({ status: 400, body: { error: 'bad json' } })
    // What threw in the door's own code is the 500 its catch-all answered, said in the log.
    expect(await routes('PATCH', '/api/machines/m1', 'null')).toEqual({ status: 500, body: { error: 'INTERNAL' } })
    expect(await routes('PATCH', '/api/machines/%E0%A4%A', '{"name":"Studio"}')).toEqual({ status: 500, body: { error: 'INTERNAL' } })
    expect(log).toHaveBeenLastCalledWith('[gateway] PATCH failed: URIError')
  })

  it('forwards the Store\'s ratings and reviews by their path and query, and refuses any other path or method', async () => {
    const routes = accountRoutes(echo())
    const review = '/api/store/harnesses/autonomous/marp/review'
    expect(await routes('GET', '/api/store/harnesses/autonomous/marp/reviews?limit=5'))
      .toEqual({ status: 200, body: { method: 'GET', path: '/api/store/harnesses/autonomous/marp/reviews?limit=5' } })
    expect(await routes('PUT', review, '{"rating":5}')).toEqual({ status: 200, body: { method: 'PUT', path: review, body: { rating: 5 } } })
    expect(await routes('DELETE', review, '{"ignored":true}')).toEqual({ status: 200, body: { method: 'DELETE', path: review } })
    expect(await routes('PUT', review, '{not json')).toEqual({ status: 400, body: { error: 'bad json' } })
    expect(await routes('PUT', review, '')).toEqual({ status: 400, body: { error: 'bad json' } })
    expect(await routes('GET', '/api/store/ratings?ids=a,b')).toEqual({ status: 400, body: { error: 'BAD_PATH' } })
    for (const method of ['POST', 'PATCH', 'HEAD', '']) expect(await routes(method, '/api/store/ratings'), method).toEqual({ status: 405, body: { error: 'METHOD_NOT_ALLOWED' } })
  })

  it('answers a backend body that is no record as `{}`, as the door wrote it from the gateway\'s process', async () => {
    for (const body of [null, ['PRIVATE'], 'PRIVATE']) {
      const routes = accountRoutes(async () => ({ status: 200, body: body as never }))
      expect(await routes('GET', '/api/desk')).toEqual({ status: 200, body: {} })
      expect(await routes('POST', '/api/product-usage/report', JSON.stringify(REPORT))).toEqual({ status: 200, body: {} })
    }
  })

  it('answers a backend call that throws as the door\'s proxy did, said in the log', async () => {
    const log = vi.fn()
    const routes = accountRoutes(async () => { throw new TypeError('fetch failed') }, log)
    expect(await routes('GET', '/api/desk')).toEqual({ status: 502, body: { success: false, error: { code: 'PROXY_FAILED', message: 'fetch failed' } } })
    expect(log).toHaveBeenCalledWith('[gateway] GET failed: TypeError')
    const odd = accountRoutes(async () => { throw 'odd' as unknown as Error }, log)
    expect(await odd('GET', '/api/desk')).toEqual({ status: 502, body: { success: false, error: { code: 'PROXY_FAILED', message: 'INTERNAL' } } })
    expect(log).toHaveBeenLastCalledWith('[gateway] GET failed: string')
    const silent = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await accountRoutes(echo())('PATCH', '/api/machines/%E0', '{}')).toEqual({ status: 500, body: { error: 'INTERNAL' } })
    expect(silent).toHaveBeenCalledWith('[gateway] PATCH failed: URIError')
    silent.mockRestore()
  })
})

describe('STORE_PATH_RE', () => {
  it('takes the Store\'s own paths, with a query', () => {
    for (const path of ['/api/store/ratings', '/api/store/harnesses/autonomous/marp/reviews?limit=5&cursor=abc%3D',
      '/api/store/harnesses/autonomous/text-to-cad/review', '/api/store/harnesses/a..b/reviews', '/api/store/harnesses/.well-known/x', '/api/store/x?',
    ]) expect(STORE_PATH_RE.test(path), path).toBe(true)
  })

  it('refuses anything else: other characters, an empty rest, and a dot segment fetch would resolve out of the Store', () => {
    for (const path of ['/api/store/', '/api/store/harnesses/a%20b/reviews', '/api/store/harnesses/a b/reviews', '/api/store/ratings#frag',
      '/api/store/ratings?q=a/b', '/api/machines', '/api/store/../machines', '/api/store/..', '/api/store/..?x=1', '/api/store/./ratings',
      '/api/store/harnesses/../../auth/me', '/api/store/harnesses/autonomous/..', `/api/store/${'a'.repeat(201)}`,
    ]) expect(STORE_PATH_RE.test(path), path).toBe(false)
  })
})

describe('the gateway\'s one request for its routes of the door', () => {
  const device = vi.fn(async () => ({ status: 200, body: { device: true } }))
  const account = vi.fn(async (method: string, target: string, text?: string, socket?: boolean): Promise<HttpAnswer> => ({ status: 200, body: { method, target, ...(text === undefined ? {} : { text }), ...(socket ? { socket } : {}) } }))
  const keys = vi.fn((method: string, path: string, text?: string): Promise<HttpAnswer> | null => (path === '/api/pairs' ? Promise.resolve({ status: 200, body: { keys: true, method, path, ...(text === undefined ? {} : { text }) } }) : null))
  const http = gatewayHttp(device, keys, account)
  const owner = { local: true, owner: true }

  it('hands the Wi-Fi device\'s routes to their own handler, whoever asks: it checks them itself', async () => {
    const closed = new AbortController().signal
    const payload = { method: 'GET', target: '/api/autonomous-device/list' }
    expect(await http(payload, { local: false, owner: true }, closed)).toEqual({ status: 200, body: { device: true } })
    expect(device).toHaveBeenCalledWith(payload, { local: false, owner: true }, closed)
  })

  it('answers the account\'s only for this computer\'s owner on this computer, with the method, target and body as sent', async () => {
    expect(await http({ method: 'POST', target: '/api/desk/ops', body: '{}' }, owner)).toEqual({ status: 200, body: { method: 'POST', target: '/api/desk/ops', text: '{}' } })
    expect(await http({ method: 5, target: 7, body: {} }, owner)).toEqual({ status: 200, body: { method: '', target: '' } })
    for (const asker of [{ local: false, owner: true }, { local: true, owner: false }, { local: true, owner: true, guest: 'kim@acme.io' }]) {
      expect(await http({ method: 'GET', target: '/api/desk' }, asker), JSON.stringify(asker)).toEqual({ status: 403, body: { error: 'FORBIDDEN' } })
    }
    expect(account).toHaveBeenCalledTimes(2)
  })

  it('hands the keys\' routes to their own handler, with the path its query left out, and the rest to the account\'s', async () => {
    keys.mockClear()
    expect(await http({ method: 'GET', target: '/api/pairs?all=1' }, owner)).toEqual({ status: 200, body: { keys: true, method: 'GET', path: '/api/pairs' } })
    expect(await http({ method: 'GET', target: '/api/pairs', body: 'x' }, { local: true, owner: false })).toEqual({ status: 403, body: { error: 'FORBIDDEN' } })
    expect(keys).toHaveBeenCalledTimes(1)
  })

  it('tells the account\'s routes whether the door over the daemon\'s own socket asked, and never a remote one', async () => {
    expect(await http({ method: 'POST', target: '/api/auth/handoff?x=1', body: '' }, { ...owner, door: 'socket' })).toEqual({ status: 200, body: { method: 'POST', target: '/api/auth/handoff?x=1', text: '', socket: true } })
    expect(await http({ method: 'POST', target: '/api/auth/handoff', body: '' }, { ...owner, connection: 'local:w1' })).toEqual({ status: 200, body: { method: 'POST', target: '/api/auth/handoff', text: '' } })
    expect(await http({ method: 'POST', target: '/api/auth/handoff', body: '' }, { local: false, owner: true, door: 'socket' })).toEqual({ status: 403, body: { error: 'FORBIDDEN' } })
  })
})
