/**
 * The account's routes of the daemon's local door, on the real daemon, byte for byte as the Desktop reads them, and what
 * each hands the backend: the desk, Agent Messages' tabs, the account's name, the phone half of a sign-in, the product
 * usage reports and choice, a machine's rename and delete, and the Store's ratings and reviews. Each answer is the one
 * this suite recorded before the routes left the core's process (its first commit), in both modes: the gateway in its
 * own process, and in the core's (`HARNESSD_SERVICES=none`).
 *
 * The core's door checks the caller and whether a write carries the local header, and hands each route on as it came
 * (core/serviceRoutes.ts) to the gateway, which holds the account's sign-in and answers it (gateway/accountRoutes.ts).
 * The gateway failing them has each answer its own words at once, and the core never restarts.
 */
import http from 'node:http'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { IsolatedDaemon } from './harness/daemon.js'
import { FakeBackend } from './harness/fakeBackend.js'

interface Answer { status: number; type: string | undefined; body: string; vocabulary?: string; retryAfter?: string }
interface Asked { body?: string; local?: boolean; origin?: string }

/** One request to the daemon's loopback port, with the local credential: its status, content type, body as sent, and the
 *  two headers a route of these may carry. */
function ask(d: IsolatedDaemon, method: string, path: string, options: Asked = {}): Promise<Answer> {
  const headers: Record<string, string> = d.localHeaders()
  if (options.local !== false) headers['x-adapter-local'] = '1'
  if (options.origin) headers.origin = options.origin
  if (options.body !== undefined) headers['content-type'] = 'application/json'
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: d.port, method, path, headers }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, type: res.headers['content-type'], body,
        ...(res.headers['x-harness-usage-vocabulary'] ? { vocabulary: String(res.headers['x-harness-usage-vocabulary']) } : {}),
        ...(res.headers['retry-after'] ? { retryAfter: String(res.headers['retry-after']) } : {}) }))
    })
    req.on('error', reject)
    req.end(options.body)
  })
}

const json = (status: number, body: string, extra: Partial<Answer> = {}): Answer => ({ status, type: 'application/json', body, ...extra })
/** What the fake backend says it was handed. */
const echoed = (method: string, url: string, body?: string): Answer =>
  json(200, JSON.stringify({ success: true, data: { method, url, type: body === undefined ? null : 'application/json', ...(body === undefined ? {} : { body }) } }))
const FORBIDDEN = json(403, '{"error":"FORBIDDEN"}')
const BAD_JSON_OBJECT = json(400, '{"error":{"code":"BAD_REQUEST","message":"Invalid JSON body"}}')
const BAD_REQUEST = json(400, '{"error":"BAD_REQUEST"}')
const NOT_FOUND = json(404, '{"error":"not found"}')
const VOCABULARY = { vocabulary: '10' }
const FEEDBACK = '{"id":"12345678-1234-4234-8234-123456789012","answer":"useful"}'

/** Each route, and its answer on a signed-in computer whose backend says what it was handed. */
const GOLDEN: Array<[string, string, Asked, Answer]> = [
  // The desk.
  ['GET', '/api/desk', {}, echoed('GET', '/api/desk')],
  ['POST', '/api/desk/ops', { body: '{"ops":[{"op":"tab.create","id":"a"}]}' }, echoed('POST', '/api/desk/ops', '{"ops":[{"op":"tab.create","id":"a"}]}')],
  ['POST', '/api/desk/ops', { body: '{"ops":[]}', local: false }, FORBIDDEN],
  ['POST', '/api/desk/ops', { body: 'nope' }, BAD_JSON_OBJECT],
  ['POST', '/api/desk/ops', { body: 'null' }, echoed('POST', '/api/desk/ops', 'null')],
  ['GET', '/api/desk/ops', {}, NOT_FOUND],
  // Agent Messages' tabs.
  ['GET', '/api/agent-messages', {}, echoed('GET', '/api/agent-messages')],
  ['PATCH', '/api/agent-messages/tabs/app_1-x', { body: '{"enabled":true}' }, echoed('PATCH', '/api/agent-messages/tabs/app_1-x', '{"enabled":true}')],
  ['PATCH', '/api/agent-messages/tabs/app', { body: '{"enabled":true}', local: false }, FORBIDDEN],
  ['PATCH', '/api/agent-messages/tabs/app', { body: 'nope' }, BAD_JSON_OBJECT],
  ['PATCH', '/api/agent-messages/tabs/bad.tab', { body: '{}', local: false }, NOT_FOUND],
  ['GET', '/api/agent-messages/tabs/app', {}, NOT_FOUND],
  // The account's name.
  ['GET', '/api/auth/me', {}, echoed('GET', '/api/auth/me')],
  ['PATCH', '/api/auth/me', { body: '{"name":"Elvis"}' }, echoed('PATCH', '/api/auth/me', '{"name":"Elvis"}')],
  ['PATCH', '/api/auth/me', { body: '{"name":"Elvis"}', local: false }, FORBIDDEN],
  ['PATCH', '/api/auth/me', { body: '{nope' }, BAD_JSON_OBJECT],
  // The phone half of a sign-in: the code and nothing else.
  ['POST', '/api/auth/qr/approve', { body: '{"code":"1234 5678"}' }, echoed('POST', '/api/auth/qr/approve', '{"code":"1234 5678"}')],
  ['POST', '/api/auth/qr/deny', { body: '{"code":"1234 5678"}', local: false }, FORBIDDEN],
  ['POST', '/api/auth/qr/lookup', { body: '{"code":""}' }, BAD_REQUEST],
  ['POST', '/api/auth/qr/lookup', { body: '{"code":"12345678","userId":"u2"}' }, BAD_REQUEST],
  ['POST', '/api/auth/qr/lookup', { body: 'nope' }, BAD_REQUEST],
  ['POST', '/api/auth/qr/claim', { body: '{"code":"12345678"}' }, NOT_FOUND],
  // The product usage feedback, choice and reports.
  ['POST', '/api/product-usage/feedback', { body: FEEDBACK }, echoed('POST', '/api/product-usage/feedback', FEEDBACK)],
  ['POST', '/api/product-usage/feedback', { body: FEEDBACK, local: false }, FORBIDDEN],
  ['POST', '/api/product-usage/feedback', { body: '{"id":"12345678-1234-4234-8234-123456789012","answer":"PRIVATE"}' }, BAD_REQUEST],
  ['GET', '/api/product-usage/settings', {}, json(200, '{"success":true,"data":{"enabled":true,"revision":0}}')],
  ['POST', '/api/product-usage/settings', { body: '{"enabled":true,"userId":"other"}' }, BAD_REQUEST],
  ['POST', '/api/product-usage/settings', { body: '{"enabled":true}', local: false }, FORBIDDEN],
  ['POST', '/api/product-usage/report', { body: '{"schemaVersion":1}', local: false }, json(403, '{"error":"FORBIDDEN"}', VOCABULARY)],
  ['POST', '/api/product-usage/report', { body: '{"schemaVersion":1}' }, json(400, '{"error":"BAD_REQUEST"}', VOCABULARY)],
  ['POST', '/api/product-usage/report', { body: 'nope' }, json(400, '{"error":"BAD_REQUEST"}', VOCABULARY)],
  ['POST', '/api/product-usage/report', { body: `{"pad":"${'x'.repeat(8192)}"}` }, json(400, '{"error":"BAD_REQUEST"}', VOCABULARY)],
  ['GET', '/api/product-usage/report', {}, NOT_FOUND],
  // A machine's rename and delete.
  ['PATCH', '/api/machines/m%201?x=1', { body: '{"name":"Studio","extra":1}' }, echoed('PATCH', '/api/machines/m%201', '{"name":"Studio"}')],
  ['PATCH', '/api/machines/m1', { body: '{"name":"Studio"}', local: false }, FORBIDDEN],
  ['PATCH', '/api/machines/', { body: '{"name":"Studio"}' }, json(400, '{"error":"MISSING_MACHINE_ID"}')],
  ['PATCH', '/api/machines/m1', { body: '{}' }, json(400, '{"error":"MISSING_NAME"}')],
  ['PATCH', '/api/machines/m1', { body: 'nope' }, json(400, '{"error":"bad json"}')],
  ['PATCH', '/api/machines/m1', { body: 'null' }, json(500, '{"error":"INTERNAL"}')],
  ['PATCH', '/api/machines/%E0%A4%A', { body: '{"name":"Studio"}' }, json(500, '{"error":"INTERNAL"}')],
  ['DELETE', '/api/machines/m%2F1', {}, echoed('DELETE', '/api/machines/m%2F1')],
  ['DELETE', '/api/machines/m1', { local: false }, FORBIDDEN],
  ['GET', '/api/machines/m1', {}, NOT_FOUND],
  // The Store's ratings and reviews: the path as given, its query too.
  ['GET', '/api/store/harnesses/autonomous/marp/reviews?limit=5', {}, echoed('GET', '/api/store/harnesses/autonomous/marp/reviews?limit=5')],
  ['PUT', '/api/store/harnesses/autonomous/marp/review', { body: '{"rating":5,"title":"Keynote"}' }, echoed('PUT', '/api/store/harnesses/autonomous/marp/review', '{"rating":5,"title":"Keynote"}')],
  ['PUT', '/api/store/harnesses/autonomous/marp/review', { body: '{"rating":5}', local: false }, FORBIDDEN],
  ['PUT', '/api/store/harnesses/autonomous/marp/review', { body: 'nope' }, json(400, '{"error":"bad json"}')],
  ['DELETE', '/api/store/harnesses/autonomous/marp/review', {}, echoed('DELETE', '/api/store/harnesses/autonomous/marp/review')],
  ['GET', '/api/store/harnesses/a%20b/reviews', {}, json(400, '{"error":"BAD_PATH"}')],
  ['GET', '/api/store/../machines', {}, json(400, '{"error":"BAD_PATH"}')],
  ['POST', '/api/store/ratings', { local: false }, json(405, '{"error":"METHOD_NOT_ALLOWED"}')],
]

/** A daemon signed in to a backend that says what each route handed it, with product usage on. */
async function signedIn(env: Record<string, string>) {
  const backend = await FakeBackend.start()
  backend.productUsage = { enabled: true, revision: 0, reports: [] }
  backend.echo = /^\/api\/(desk(\/ops)?|agent-messages(\/.*)?|auth\/me|auth\/qr\/.*|product-usage\/feedback|machines\/.+|store\/.*)$/
  const machine = { machineId: 'c4'.repeat(16), computerId: 'e2e-account-routes', name: 'fixture', token: 'e2e-account-token' }
  backend.addMachine(machine)
  const d = await IsolatedDaemon.create({ env: { ...env, BACKEND_WS_URL: backend.wsUrl, WEB_URL: backend.httpUrl, ADAPTER_COMPUTER_ID: machine.computerId } })
  writeFileSync(join(d.root, 'auth', 'session.json'), JSON.stringify({ version: 1, accessToken: machine.token,
    autonomousEnv: 'prod', computerId: machine.computerId, machineId: machine.machineId,
    expiresAt: Date.now() + 86400000, updatedAt: Date.now(), signInEpoch: 'e2e' }), { mode: 0o600 })
  return { backend, d }
}

const MODES = [['in its own process', {}], ['in the core\'s, with every service there', { HARNESSD_SERVICES: 'none' }]] as const

describe('the account\'s routes of the door', () => {
  let daemon: IsolatedDaemon | undefined, fake: FakeBackend | undefined
  afterEach(async () => {
    await daemon?.close(); await fake?.close()
    daemon = undefined; fake = undefined
  })

  it.each(MODES)('answer as they did, byte for byte, with the gateway %s', async (_where, env) => {
    const { backend, d } = await signedIn(env)
    daemon = d; fake = backend
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`) })
    await d.start()
    for (const [method, path, options, answer] of GOLDEN) expect.soft(await ask(d, method, path, options), `${method} ${path}`).toEqual(answer)
    // A report the Desktop makes reaches the backend as it was sent, and its answer names the vocabulary.
    const report = { ...JSON.parse(readFileSync(new URL('../../tests/fixtures/desktop-product-usage-report.json', import.meta.url), 'utf8')),
      day: new Date().toISOString().slice(0, 10) }
    expect(await ask(d, 'POST', '/api/product-usage/report', { body: JSON.stringify(report) }))
      .toEqual(json(200, '{"success":true,"data":{"accepted":true}}', VOCABULARY))
    expect(backend.productUsage!.reports).toContainEqual(report)
    // A busy backend's Retry-After reaches the Desktop, which waits it out.
    backend.productUsage!.busySeconds = 7
    expect(await ask(d, 'POST', '/api/product-usage/report', { body: JSON.stringify(report) }))
      .toEqual(json(429, '{"success":false,"error":{"code":"USAGE_WRITE_CONFLICT","message":"Usage measurement busy"}}', { ...VOCABULARY, retryAfter: '7' }))
    delete backend.productUsage!.busySeconds
    // The choice, written through: the collector reads it again.
    expect(await ask(d, 'POST', '/api/product-usage/settings', { body: '{"enabled":true}' })).toEqual(json(200, '{"success":true,"data":{"enabled":true,"revision":1}}'))
    expect(d.coresStarted()).toBe(1)
  }, 120_000)

  // The gateway answers them: failing them, each answers the gateway's own words at once, and the door's checks are the
  // core's still.
  it.each(MODES)('are answered by the gateway %s: failing them, each says the gateway is unavailable, at once', async (_where, env) => {
    const { backend, d } = await signedIn({ ...env, HARNESSD_TEST_FAULTS: 'gateway.gateway_http' })
    daemon = d; fake = backend
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`) })
    await d.start()
    const down = json(503, '{"error":"GATEWAY_UNAVAILABLE"}')
    const failing: Array<[string, string, Asked, Answer]> = [
      ['GET', '/api/desk', {}, down],
      ['POST', '/api/desk/ops', { body: '{"ops":[]}' }, down],
      ['GET', '/api/agent-messages', {}, down],
      ['PATCH', '/api/agent-messages/tabs/app', { body: '{"enabled":true}' }, down],
      ['GET', '/api/auth/me', {}, down],
      ['POST', '/api/auth/qr/approve', { body: '{"code":"1234 5678"}' }, down],
      ['POST', '/api/product-usage/feedback', { body: FEEDBACK }, down],
      ['GET', '/api/product-usage/settings', {}, down],
      ['POST', '/api/product-usage/report', { body: '{"schemaVersion":1}' }, json(503, '{"error":"GATEWAY_UNAVAILABLE"}', VOCABULARY)],
      ['PATCH', '/api/machines/m1', { body: '{"name":"Studio"}' }, down],
      ['GET', '/api/store/harnesses/autonomous/marp/reviews?limit=5', {}, down],
      // The door's own checks come first, and need no gateway.
      ['POST', '/api/product-usage/report', { body: '{}', local: false }, json(403, '{"error":"FORBIDDEN"}', VOCABULARY)],
      ['POST', '/api/desk/ops', { body: '{}', local: false }, FORBIDDEN],
    ]
    // Each once, so that the gateway is up (it starts on demand beside the core); then again, each at once.
    for (const [method, path, options, answer] of failing) expect.soft(await ask(d, method, path, options), `${method} ${path}`).toEqual(answer)
    for (const [method, path, options, answer] of failing) {
      const at = Date.now()
      expect.soft(await ask(d, method, path, options), `${method} ${path}`).toEqual(answer)
      expect.soft(Date.now() - at, `${method} ${path} answered at once`).toBeLessThan(2_000)
    }
    expect(d.log()).toContain('gateway_http failed · injected fault')
    expect(d.coresStarted()).toBe(1)
  }, 120_000)
})
