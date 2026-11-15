/**
 * The Wi-Fi device's local routes (`/api/autonomous-device/*`), on the real daemon, byte for byte as the clients of the
 * last 30 days read them: `harness autonomous-device` (lib/autonomous-device/command.ts, addonCommand.ts) and the add-on
 * service of a device that is this machine. Each answer is the one this suite recorded before the routes left the
 * core's process (its first commit), in both modes: the services in their own processes, and every one in the core's
 * (`HARNESSD_SERVICES=none`).
 *
 * The core's door checks the caller and hands each route on as it came (core/serviceRoutes.ts): the pairings and the
 * direct links to the gateway, the receipts and add-ons to the Wi-Fi device's service, the machine's own add-ons to
 * theirs. A service that fails a route, or cannot start, has the route answer its own words at once, and the core
 * never restarts.
 */
import http from 'node:http'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { IsolatedDaemon } from './harness/daemon.js'

interface Answer { status: number; type: string | undefined; body: string }

/** One request to the daemon's loopback port: its status, its content type and its body as sent, ids made plain. */
function ask(d: IsolatedDaemon, method: string, path: string, options: { body?: string; bearer?: boolean; origin?: string } = {}): Promise<Answer> {
  const headers: Record<string, string> = {}
  if (options.bearer !== false) headers.authorization = `Bearer ${d.hookCredential()}`
  if (options.origin) headers.origin = options.origin
  if (options.body !== undefined) headers['content-type'] = 'application/json'
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: d.port, method, path, headers }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, type: res.headers['content-type'], body: body.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>') }))
    })
    req.on('error', reject)
    req.end(options.body)
  })
}

const json = (status: number, body: string): Answer => ({ status, type: 'application/json', body })
const BAD_REQUEST = json(400, '{"error":{"code":"BAD_REQUEST","message":"Invalid device management request"}}')
const DEVICE = 'A'.repeat(43) + '='
const PROPOSAL = '0b6c3c3e-8f3a-4f5a-9d2b-6f1e2a3b4c5d'
/** What a discovery finds on this computer's network: nothing here, or the network refused to the daemon. */
const BLOCKED = json(503, '{"error":{"code":"LOCAL_NETWORK_BLOCKED","message":"Harness is not allowed to use the local network. Allow it in System Settings › Privacy & Security › Local Network."}}')

/** Each route, and the answer it gives on a computer with no Wi-Fi device paired. */
const GOLDEN: Array<[string, string, { body?: string; bearer?: boolean; origin?: string }, Answer]> = [
  // The door: the device's own bearer, from this computer, never a browser.
  ['GET', '/api/autonomous-device/status', { bearer: false }, json(403, '{"error":{"code":"FORBIDDEN","message":"Authenticated native loopback client required"}}')],
  ['GET', '/api/autonomous-device/status', { origin: 'https://example.com' }, json(403, '{"error":"FORBIDDEN_HOST"}')],
  // The pairings and the direct links.
  ['GET', '/api/autonomous-device/list', {}, json(200, '{"devices":[]}')],
  ['GET', '/api/autonomous-device/pair/status', {}, json(200, '{"state":"idle"}')],
  ['GET', '/api/autonomous-device/status', {}, json(200, '{"transport":"direct","connected":false,"paired":0,"sessions":0,"proto":1}')],
  ['POST', '/api/autonomous-device/revoke', { body: '{"id":"ABCD·1234·5678·90EF"}' }, json(404, '{"error":{"code":"UNKNOWN_DEVICE","message":"Device pairing not found"}}')],
  ['POST', '/api/autonomous-device/revoke', { body: '{}' }, BAD_REQUEST],
  ['POST', '/api/autonomous-device/revoke', { body: '{"all":true}' }, BAD_REQUEST],
  ['POST', '/api/autonomous-device/pair/start', { body: 'not json' }, json(400, '{"error":{"code":"BAD_REQUEST","message":"Invalid JSON body"}}')],
  ['POST', '/api/autonomous-device/pair/start', { body: '{"code":"ABC234"}' }, BAD_REQUEST],
  ['GET', '/api/autonomous-device/pair/start', {}, json(405, '{"error":{"code":"METHOD_NOT_ALLOWED","message":"Method not allowed"}}')],
  ['POST', '/api/autonomous-device/pair/cancel', { body: '{}' }, json(404, '{"error":{"code":"NOT_FOUND","message":"Unknown device management endpoint"}}')],
  ['GET', '/api/autonomous-device/status?all=true', {}, BAD_REQUEST],
  // The Wi-Fi device's receipts and add-ons.
  ['GET', `/api/autonomous-device/receipt?deviceId=${encodeURIComponent(DEVICE)}&idempotencyKey=k`, {}, json(200, '{"receipt":null}')],
  ['GET', '/api/autonomous-device/receipt?deviceId=x&idempotencyKey=k', {}, BAD_REQUEST],
  ['GET', '/api/autonomous-device/addon/state', {}, json(200, '{"devices":[]}')],
  ['GET', '/api/autonomous-device/addon/state?deviceId=lamp', {}, json(200, '{"devices":[]}')],
  ['GET', `/api/autonomous-device/addon/proposal?proposalId=${PROPOSAL}`, {}, json(404, '{"error":{"code":"PROPOSAL_UNKNOWN","message":"No such proposal: never sent, or aged out after ten minutes"}}')],
  ['GET', '/api/autonomous-device/addon/proposal?proposalId=nope', {}, BAD_REQUEST],
  ['POST', '/api/autonomous-device/addon/propose', { body: '{"addon":"x","idempotencyKey":"k","act":"light","holdsMs":5000}' }, json(409, '{"error":{"code":"MISSING_TARGET","message":"No connected device offers add-ons"}}')],
  // The add-ons of a device that is this machine.
  ['POST', '/api/autonomous-device/machine-addon/hello', { body: '{}' }, json(200, '{"topics":0,"instance":"<uuid>"}')],
  ['POST', '/api/autonomous-device/machine-addon/publish', { body: '{"values":[{"topic":"voice/state","value":{"state":"listening"}}]}' }, json(200, '{"topics":1,"instance":"<uuid>"}')],
  ['POST', '/api/autonomous-device/machine-addon/publish', { body: '{"values":[],"extra":1}' }, BAD_REQUEST],
  ['POST', '/api/autonomous-device/machine-addon/decision', { body: `{"proposalId":"${PROPOSAL}","decision":"kept"}` }, json(404, '{"error":{"code":"PROPOSAL_UNKNOWN","message":"No such proposal for this device"}}')],
  ['GET', '/api/autonomous-device/machine-addon/proposals', {}, json(200, '{"proposals":[],"next":0,"instance":"<uuid>"}')],
  ['GET', '/api/autonomous-device/machine-addon/proposals?after=-1', {}, BAD_REQUEST],
]

describe('the Wi-Fi device\'s local routes', () => {
  let daemon: IsolatedDaemon | undefined
  afterEach(async () => {
    await daemon?.close()
    daemon = undefined
  })

  it.each([['in their own processes', {}], ['in the core\'s, with every service there', { HARNESSD_SERVICES: 'none' }]] as const)(
    'answer as they did, byte for byte, with the services %s', async (_where, env) => {
    const d = await IsolatedDaemon.create({ env })
    daemon = d
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`) })
    await d.start()
    for (const [method, path, options, answer] of GOLDEN) expect.soft(await ask(d, method, path, options), `${method} ${path}`).toEqual(answer)
    // A discovery and a pairing look at this computer's network for three seconds: nothing there, or no leave to.
    const discovered = await ask(d, 'GET', '/api/autonomous-device/discover')
    if (discovered.status === 200) expect(JSON.parse(discovered.body)).toEqual({ devices: expect.any(Array) })
    else expect(discovered).toEqual(BLOCKED)
    const paired = await ask(d, 'POST', '/api/autonomous-device/pair/start', { body: '{"code":"ABC234","device":"nobody._autonomous._tcp.local"}' })
    expect([json(404, '{"error":{"code":"DEVICE_NOT_FOUND","message":"Selected device is no longer discoverable"}}'), BLOCKED]).toContainEqual(paired)
    expect(d.coresStarted()).toBe(1)
  })

  // Each route is its service's, which checks it and answers it: a failure there is that route's, said at once with the
  // route's own words, and costs the core nothing.
  it.each([['in their own processes', {}], ['in the core\'s', { HARNESSD_SERVICES: 'none' }]] as const)(
    'are answered by their services %s: one that fails them answers their own error at once', async (_where, env) => {
    const d = await IsolatedDaemon.create({ env: { ...env, HARNESSD_TEST_FAULTS: 'gateway.gateway_http,wifi.wifi_http,machineAddons.machine_addons_http' } })
    daemon = d
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`) })
    await d.start()
    const failing: Array<[string, string, string | undefined, Answer]> = [
      ['GET', '/api/autonomous-device/list', undefined, json(503, '{"error":{"code":"UNAVAILABLE","message":"The Wi-Fi device link is not reachable on this computer right now. Try again."}}')],
      ['GET', `/api/autonomous-device/receipt?deviceId=${encodeURIComponent(DEVICE)}&idempotencyKey=k`, undefined, json(503, '{"error":{"code":"UNAVAILABLE","message":"The Wi-Fi device service is not running on this computer. See the daemon\'s log."}}')],
      ['POST', '/api/autonomous-device/addon/propose', '{"addon":"x","idempotencyKey":"k","act":"light","holdsMs":5000}', json(504, '{"error":{"code":"OUTCOME_UNKNOWN","message":"No answer in time: the proposal may have been sent. Retry with the same key (--key) to send it at most once."}}')],
      ['POST', '/api/autonomous-device/machine-addon/hello', '{}', json(503, '{"error":{"code":"UNAVAILABLE","message":"The add-ons of this machine are not running. See the daemon\'s log."}}')],
    ]
    // Each once, so that its service is up; then again, each at once.
    for (const [method, path, body, answer] of failing) expect(await ask(d, method, path, { body }), `${method} ${path}`).toEqual(answer)
    for (const [method, path, body, answer] of failing) {
      const at = Date.now()
      expect(await ask(d, method, path, { body }), `${method} ${path}`).toEqual(answer)
      expect(Date.now() - at, `${method} ${path} answered at once`).toBeLessThan(2_000)
    }
    expect(d.log()).toContain('gateway_http failed · injected fault')
    expect(d.coresStarted()).toBe(1)
  })

  it('a service that cannot start: its routes say so, the others answer as before, and the core never restarts', async () => {
    const d = await IsolatedDaemon.create({ env: { HARNESSD_TEST_FAULTS: 'wifi,machineAddons' } })
    daemon = d
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`) })
    await d.start()
    expect(await ask(d, 'GET', `/api/autonomous-device/receipt?deviceId=${encodeURIComponent(DEVICE)}&idempotencyKey=k`))
      .toEqual(json(503, '{"error":{"code":"UNAVAILABLE","message":"The Wi-Fi device service is not running on this computer. See the daemon\'s log."}}'))
    expect(await ask(d, 'GET', '/api/autonomous-device/addon/state'))
      .toEqual(json(503, '{"error":{"code":"UNAVAILABLE","message":"The Wi-Fi device service is not running on this computer. See the daemon\'s log."}}'))
    // Not answered is not "not sent": a proposal may have reached the device.
    expect(await ask(d, 'POST', '/api/autonomous-device/addon/propose', { body: '{"addon":"x","idempotencyKey":"k","act":"light","holdsMs":5000}' }))
      .toEqual(json(504, '{"error":{"code":"OUTCOME_UNKNOWN","message":"No answer in time: the proposal may have been sent. Retry with the same key (--key) to send it at most once."}}'))
    expect(await ask(d, 'POST', '/api/autonomous-device/machine-addon/hello', { body: '{}' }))
      .toEqual(json(503, '{"error":{"code":"UNAVAILABLE","message":"The add-ons of this machine are not running. See the daemon\'s log."}}'))
    // The pairings are the gateway's, and answer with the devices' services down.
    expect(await ask(d, 'GET', '/api/autonomous-device/list')).toEqual(json(200, '{"devices":[]}'))
    expect(await ask(d, 'GET', '/api/autonomous-device/status')).toEqual(json(200, '{"transport":"direct","connected":false,"paired":0,"sessions":0,"proto":1}'))
    expect(d.coresStarted()).toBe(1)
  })

  it('the gateway that cannot start: the pairings say it is not reachable, at once after the first, and the core never restarts', async () => {
    const d = await IsolatedDaemon.create({ env: { HARNESSD_TEST_FAULTS: 'gateway' } })
    daemon = d
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`) })
    await d.start()
    const unreachable = json(503, '{"error":{"code":"UNAVAILABLE","message":"The Wi-Fi device link is not reachable on this computer right now. Try again."}}')
    // The first waits for the gateway's start, which does not come.
    expect(await ask(d, 'GET', '/api/autonomous-device/list')).toEqual(unreachable)
    for (const path of ['/api/autonomous-device/list', '/api/autonomous-device/pair/status', '/api/autonomous-device/status']) {
      const at = Date.now()
      expect(await ask(d, 'GET', path), path).toEqual(unreachable)
      expect(Date.now() - at, `${path} answered at once`).toBeLessThan(2_000)
    }
    expect(await ask(d, 'POST', '/api/autonomous-device/revoke', { body: '{"id":"ABCD·1234·5678·90EF"}' })).toEqual(unreachable)
    // The Wi-Fi device's own service answers without it.
    expect(await ask(d, 'GET', `/api/autonomous-device/receipt?deviceId=${encodeURIComponent(DEVICE)}&idempotencyKey=k`)).toEqual(json(200, '{"receipt":null}'))
    expect(d.coresStarted()).toBe(1)
  })
})
