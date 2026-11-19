/**
 * The keys' routes of the daemon's local door, the phone's sign-in code, and ⌘K's and the voice's frames, on the real
 * daemon, byte for byte as `harness pair`, `unpair`, `remote-password`, `link connect`, `group` and `devices`, the
 * Desktop's Devices list, its Add Phone and its ⌘K read them. Each answer is the one this suite recorded before they left
 * the core's process (its first commit), in both modes: the services in their own processes, and in the core's
 * (`HARNESSD_SERVICES=none`).
 *
 * The core's door checks the caller, a write's local header and, for the phone's code, that it came over the daemon's
 * own socket, and hands each route on as it came (core/serviceRoutes.ts) to the gateway, which holds the keys and the
 * account's sign-in (gateway/keyRoutes.ts, gateway/accountRoutes.ts). A window's ⌘K and its answer to a spoken task go
 * to the devices, beside the dial (services/devices.ts). Each failing has its own words at once, and the core never
 * restarts.
 */
import http from 'node:http'
import { hostname } from 'node:os'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { IsolatedDaemon } from './harness/daemon.js'
import { FakeBackend } from './harness/fakeBackend.js'
import { LocalClient } from './harness/client.js'

interface Answer { status: number; type: string | undefined; body: string }
interface Asked { body?: string; local?: boolean; socket?: boolean }

/** A body with what differs from one computer and one run to the next said by name: keys, fingerprints, times, the host. */
const steady = (body: string): string => body
  .replaceAll(JSON.stringify(hostname()).slice(1, -1), '<host>')
  .replace(/[A-Za-z0-9+/]{43}=/g, '<key>')
  .replace(/[0-9A-F]{4}·[0-9A-F]{4}·[0-9A-F]{4}·[0-9A-F]{4}/g, '<fingerprint>')
  .replace(/\b1\d{12}\b/g, '<ms>')

/** One request to the daemon: over its loopback port with the local credential, or over its own socket. */
function ask(d: IsolatedDaemon, method: string, path: string, options: Asked = {}): Promise<Answer> {
  const headers: Record<string, string> = options.socket ? {} : d.localHeaders()
  if (options.local !== false) headers['x-adapter-local'] = '1'
  if (options.body !== undefined) headers['content-type'] = 'application/json'
  const where = options.socket ? { socketPath: d.socketPath } : { host: '127.0.0.1', port: d.port }
  return new Promise((resolve, reject) => {
    const req = http.request({ ...where, method, path, headers }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, type: res.headers['content-type'], body: steady(body) }))
    })
    req.on('error', reject)
    req.end(options.body)
  })
}

const json = (status: number, body: string): Answer => ({ status, type: 'application/json', body })
const FORBIDDEN = json(403, '{"error":"FORBIDDEN"}')
const BAD_JSON = json(400, '{"error":"bad json"}')
const NOT_FOUND = json(404, '{"error":"not found"}')
const OK = json(200, '{"ok":true}')
const PEER = Buffer.alloc(32, 7).toString('base64')
const PEER_MACHINE = 'a7'.repeat(16)
/** The machine id this computer is signed in under. */
const MACHINE = 'c5'.repeat(16)

/** Each route, in this order, and its answer on a signed-in computer that nothing is paired with yet. */
const GOLDEN: Array<[string, string, Asked, Answer]> = [
  // `harness pairings`, `pair`, `unpair`.
  ['GET', '/api/pairs', {}, json(200, '{"pairs":[]}')],
  ['POST', '/api/pair', { body: '{"code":"123456"}' }, json(409, '{"error":"NO_INTENT"}')],
  ['POST', '/api/pair', { body: '{"code":"123456"}', local: false }, FORBIDDEN],
  ['POST', '/api/pair', { body: 'nope' }, BAD_JSON],
  ['POST', '/api/pair', { body: '{}' }, json(400, '{"error":"MISSING_CODE"}')],
  ['GET', '/api/pair', {}, NOT_FOUND],
  ['POST', '/api/revoke', { body: '{"id":"nobody"}' }, json(404, '{"error":"NOT_FOUND"}')],
  ['POST', '/api/revoke', { body: '{}' }, json(400, '{"error":"MISSING_ID"}')],
  ['POST', '/api/revoke', { body: 'nope' }, BAD_JSON],
  ['POST', '/api/revoke', { body: '{"id":"nobody"}', local: false }, FORBIDDEN],
  ['POST', '/api/revoke-all', {}, json(200, '{"count":0}')],
  ['POST', '/api/revoke-all', { local: false }, FORBIDDEN],
  ['GET', '/api/revoke-all', {}, NOT_FOUND],
  // `harness remote-password`.
  ['GET', '/api/remote-password/status', {}, json(200, '{"hasPassword":false,"fingerprint":null,"setAt":null}')],
  ['POST', '/api/remote-password/set', { body: '{}' }, json(400, '{"error":"MISSING_PASSWORD"}')],
  ['POST', '/api/remote-password/set', { body: 'nope' }, BAD_JSON],
  ['POST', '/api/remote-password/set', { body: '{"password":"correct horse"}', local: false }, FORBIDDEN],
  ['POST', '/api/remote-password/set', { body: '{"password":"correct horse"}' }, json(200, '{"fingerprint":"<fingerprint>"}')],
  ['GET', '/api/remote-password/status', {}, json(200, '{"hasPassword":true,"fingerprint":"<fingerprint>","setAt":<ms>}')],
  ['POST', '/api/remote-password/clear', { local: false }, FORBIDDEN],
  ['POST', '/api/remote-password/clear', {}, OK],
  // `harness link connect`'s mutual half, and the trust group.
  ['POST', '/api/link/trust-peer', { body: '{"pub":"x","machineId":"m"}' }, json(400, '{"error":"BAD_PEER"}')],
  ['POST', '/api/link/trust-peer', { body: 'nope' }, BAD_JSON],
  ['POST', '/api/link/trust-peer', { body: `{"pub":"${PEER}","machineId":"${PEER_MACHINE}"}`, local: false }, FORBIDDEN],
  ['POST', '/api/link/trust-peer', { body: `{"pub":"${PEER}","machineId":"${PEER_MACHINE}","label":"  Studio  "}` }, OK],
  ['GET', '/api/group', {}, json(200, `{"self":{"pub":"<key>","kind":"machine","label":"<host>","at":1,"machineId":"${MACHINE}"},"members":[{"pub":"<key>","kind":"machine","label":"Studio","at":<ms>,"machineId":"${PEER_MACHINE}","fingerprint":"<fingerprint>"}]}`)],
  ['POST', '/api/group/sync', {}, OK],
  ['POST', '/api/group/sync', { local: false }, FORBIDDEN],
  ['POST', '/api/group/remove', { body: '{"selector":"  "}' }, json(400, '{"error":"MISSING_SELECTOR"}')],
  ['POST', '/api/group/remove', { body: '{"selector":"nobody here"}' }, json(404, '{"error":"NOT_FOUND"}')],
  ['POST', '/api/group/remove', { body: 'nope' }, BAD_JSON],
  ['POST', '/api/group/remove', { body: '{"selector":"1"}', local: false }, FORBIDDEN],
  // `harness devices` and the window's Devices list.
  ['GET', '/api/devices', {}, json(200, '{"head":null,"frozen":null,"self":"<key>","members":[],"frozenPeers":[],"pending":[],"suspended":[],"joinedSeq":0,"baseline":[],"baselineSeen":true,"conflict":null,"departed":[],"lastSeen":{}}')],
  ['POST', '/api/devices/remove', { body: '{}' }, json(400, '{"error":"MISSING_PUB"}')],
  // The account's device key log is not read here: this backend keeps none.
  ['POST', '/api/devices/remove', { body: '{"pub":"nobody"}' }, json(503, '{"error":"UNAVAILABLE"}')],
  ['POST', '/api/devices/remove', { body: '{"pub":"nobody"}', local: false }, FORBIDDEN],
  ['POST', '/api/devices/rebaseline', { body: 'null' }, BAD_JSON],
  ['POST', '/api/devices/rebaseline', { body: '{"confirm":true,"head":{"seq":-1,"hash":"h"}}' }, json(400, '{"error":"BAD_HEAD"}')],
  ['POST', '/api/devices/rebaseline', { body: '{"confirm":false}' }, json(502, '{"error":"LOG_UNAVAILABLE"}')],
  ['POST', '/api/devices/rebaseline', { body: '{}', local: false }, FORBIDDEN],
  ['GET', '/api/devices/history', { local: false }, FORBIDDEN],
  ['GET', '/api/devices/history', {}, json(200, '{"rows":[],"complete":false,"frozen":null}')],
  ['POST', '/api/devices/dismiss', { body: '{"pubs":"a"}' }, json(400, '{"error":"BAD_PUBS"}')],
  ['POST', '/api/devices/dismiss', { body: '{"pub":5}' }, json(400, '{"error":"MISSING_PUB"}')],
  ['POST', '/api/devices/dismiss', { body: '{bad' }, BAD_JSON],
  ['POST', '/api/devices/dismiss', { body: '{}', local: false }, FORBIDDEN],
  ['POST', '/api/devices/dismiss', { body: '{}' }, OK],
  ['POST', '/api/devices/dismiss', { body: '{"pub":"k","confirm":true}' }, json(200, '{"ok":true,"shared":false}')],
  ['GET', '/api/devices/dismiss', {}, NOT_FOUND],
  // Add Phone's code, which signs a phone in to this account: the daemon's own socket only.
  ['POST', '/api/auth/handoff', { socket: true }, json(200, '{"success":true,"data":{"method":"POST","url":"/api/auth/handoff","type":"application/json","body":"{}"}}')],
  ['POST', '/api/auth/handoff', { socket: true, local: false }, FORBIDDEN],
  ['POST', '/api/auth/handoff', {}, FORBIDDEN],
  ['GET', '/api/auth/handoff', { socket: true }, NOT_FOUND],
]

/** A daemon signed in to a backend that says what each route handed it. */
async function signedIn(env: Record<string, string>) {
  const backend = await FakeBackend.start()
  backend.echo = /^\/api\/auth\/handoff$/
  const machine = { machineId: MACHINE, computerId: 'e2e-key-routes', name: 'fixture', token: 'e2e-key-token' }
  backend.addMachine(machine)
  const d = await IsolatedDaemon.create({ env: { ...env, BACKEND_WS_URL: backend.wsUrl, WEB_URL: backend.httpUrl, ADAPTER_COMPUTER_ID: machine.computerId } })
  writeFileSync(join(d.root, 'auth', 'session.json'), JSON.stringify({ version: 1, accessToken: machine.token,
    autonomousEnv: 'prod', computerId: machine.computerId, machineId: machine.machineId,
    expiresAt: Date.now() + 86400000, updatedAt: Date.now(), signInEpoch: 'e2e' }), { mode: 0o600 })
  return { backend, d }
}

/** A window's frame and the one it is answered with, under its request id, as the window reads it (key order too). */
async function framed(client: LocalClient, type: string, result: string, payload: Record<string, unknown>, ms = 40_000): Promise<string> {
  const requestId = randomUUID()
  const answered = client.next((frame) => frame.type === result && frame.payload?.requestId === requestId, ms, result)
  client.send(type, { requestId, ...payload })
  return JSON.stringify((await answered).payload).replaceAll(requestId, '<id>')
}

const MODES = [['in their own processes', {}], ['in the core\'s, with every service there', { HARNESSD_SERVICES: 'none' }]] as const
const DEVICES_DOWN = 'the devices service is unavailable'

describe('the keys\' routes of the door, and the phone\'s sign-in code', () => {
  let daemon: IsolatedDaemon | undefined, fake: FakeBackend | undefined
  afterEach(async () => {
    await daemon?.close(); await fake?.close()
    daemon = undefined; fake = undefined
  })

  it.each(MODES)('answer as they did, byte for byte, with the services %s', async (_where, env) => {
    const { backend, d } = await signedIn(env)
    daemon = d; fake = backend
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`) })
    await d.start()
    for (const [method, path, options, answer] of GOLDEN) expect.soft(await ask(d, method, path, options), `${method} ${path} ${JSON.stringify(options)}`).toEqual(answer)
    // The code is handed out once, for the one asked over the socket with the local header.
    expect(backend.seen.filter((line) => line.startsWith('POST /api/auth/handoff'))).toHaveLength(1)
    expect(d.coresStarted()).toBe(1)
  }, 180_000)

  // A client of the local WebSocket may ask the gateway's routes as a request of its own: never for the code, which only
  // the daemon's own socket's door hands out.
  it.each(MODES)('never hand the phone\'s code to a client of the local WebSocket, with the services %s', async (_where, env) => {
    const { backend, d } = await signedIn(env)
    daemon = d; fake = backend
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`) })
    await d.start()
    for (const tcp of [false, true]) {
      const client = await LocalClient.connect(d, { tcp, machineId: MACHINE })
      try {
        expect(await client.request('gateway_http', { method: 'POST', target: '/api/auth/handoff', body: '{}' }, 30_000)).toMatchObject({ status: 403, body: { error: 'FORBIDDEN' } })
      } finally { client.close() }
    }
    expect(backend.seen.filter((line) => line.startsWith('POST /api/auth/handoff'))).toEqual([])
  }, 120_000)

  it.each(MODES)('are answered by the gateway %s: failing them, each says the gateway is unavailable, at once', async (_where, env) => {
    const { backend, d } = await signedIn({ ...env, HARNESSD_TEST_FAULTS: 'gateway.gateway_http' })
    daemon = d; fake = backend
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`) })
    await d.start()
    const down = json(503, '{"error":"GATEWAY_UNAVAILABLE"}')
    const failing: Array<[string, string, Asked, Answer]> = [
      ['GET', '/api/pairs', {}, down],
      ['POST', '/api/pair', { body: '{"code":"123456"}' }, down],
      ['POST', '/api/revoke', { body: '{"id":"nobody"}' }, down],
      ['POST', '/api/revoke-all', {}, down],
      ['GET', '/api/remote-password/status', {}, down],
      ['POST', '/api/remote-password/set', { body: '{"password":"correct horse"}' }, down],
      ['POST', '/api/remote-password/clear', {}, down],
      ['POST', '/api/link/trust-peer', { body: `{"pub":"${PEER}","machineId":"${PEER_MACHINE}"}` }, down],
      ['GET', '/api/group', {}, down],
      ['POST', '/api/group/sync', {}, down],
      ['POST', '/api/group/remove', { body: '{"selector":"1"}' }, down],
      ['GET', '/api/devices', {}, down],
      ['POST', '/api/devices/remove', { body: '{"pub":"nobody"}' }, down],
      ['POST', '/api/devices/rebaseline', { body: '{"confirm":false}' }, down],
      ['GET', '/api/devices/history', {}, down],
      ['POST', '/api/devices/dismiss', { body: '{}' }, down],
      ['POST', '/api/auth/handoff', { socket: true }, down],
      // The door's own checks come first, and need no gateway.
      ['POST', '/api/pair', { body: '{"code":"123456"}', local: false }, FORBIDDEN],
      ['POST', '/api/auth/handoff', {}, FORBIDDEN],
    ]
    // Each once, so that the gateway is up (it starts on demand beside the core); then again, each at once.
    for (const [method, path, options, answer] of failing) expect.soft(await ask(d, method, path, options), `${method} ${path}`).toEqual(answer)
    for (const [method, path, options, answer] of failing) {
      const at = Date.now()
      expect.soft(await ask(d, method, path, options), `${method} ${path}`).toEqual(answer)
      expect.soft(Date.now() - at, `${method} ${path} answered at once`).toBeLessThan(2_000)
    }
    expect(d.log()).toContain('gateway_http failed · Error')
    expect(backend.seen.filter((line) => line.startsWith('POST /api/auth/handoff'))).toEqual([])
    expect(d.coresStarted()).toBe(1)
  }, 180_000)
})

describe('a window\'s ⌘K and its answer to a spoken task', () => {
  let daemon: IsolatedDaemon | undefined
  afterEach(async () => {
    await daemon?.close()
    daemon = undefined
  })

  it.each(MODES)('are answered as they were, byte for byte, with the devices %s', async (_where, env) => {
    const d = await IsolatedDaemon.create({ env: { ...env } })
    daemon = d
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`) })
    await d.start()
    const window = await LocalClient.connect(d)
    try {
      expect.soft(await framed(window, 'route_task', 'route_result', { text: 'fix the login page' }))
        .toBe('{"requestId":"<id>","agentId":"","machineId":"","name":"","confidence":0,"reason":"no agents in machine","weighed":0,"machines":0,"via":"model","candidates":[]}')
      expect.soft(await framed(window, 'route_task', 'route_result', { text: '   ' }))
        .toBe('{"requestId":"<id>","agentId":"","machineId":"","name":"","confidence":0,"reason":"empty task","candidates":[],"weighed":0,"machines":0,"via":""}')
      // Sent through the fleet's router, which takes it for a machine it does not list yet.
      expect.soft(await framed(window, 'route_send', 'route_send_result', { agentId: 'nobody', text: 'hello' }))
        .toBe('{"requestId":"<id>","ok":true}')
      expect.soft(await framed(window, 'route_send', 'route_send_result', { agentId: '', text: 'hello' }))
        .toBe('{"requestId":"<id>","ok":false,"machine":"","reason":"nothing to send"}')
      // Told, never answered: the window's next frame is answered as ever.
      window.send('voice_route_reply', { voiceId: 'v-nobody', state: 'taken' })
      window.send('voice_route_reply', { voiceId: 'v-nobody', state: 'guessed' })
      expect.soft(await framed(window, 'route_send', 'route_send_result', { agentId: '', text: '' }))
        .toBe('{"requestId":"<id>","ok":false,"machine":"","reason":"nothing to send"}')
    } finally { window.close() }
    expect(d.coresStarted()).toBe(1)
  }, 120_000)

  it.each(MODES)('are answered by the devices %s: failing them, ⌘K says the devices are unavailable, at once', async (_where, env) => {
    const d = await IsolatedDaemon.create({ env: { ...env, HARNESSD_TEST_FAULTS: 'devices.devices_ws' } })
    daemon = d
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`) })
    await d.start()
    const window = await LocalClient.connect(d)
    try {
      const unrouted = `{"requestId":"<id>","agentId":"","machineId":"","name":"","confidence":0,"reason":"${DEVICES_DOWN}","candidates":[],"weighed":0,"machines":0,"via":""}`
      const unsent = `{"requestId":"<id>","ok":false,"machine":"","reason":"${DEVICES_DOWN}"}`
      // Once, so that the devices are up (they start on demand); then again, at once.
      expect(await framed(window, 'route_task', 'route_result', { text: 'fix the login page' })).toBe(unrouted)
      const at = Date.now()
      expect(await framed(window, 'route_task', 'route_result', { text: 'fix the login page' })).toBe(unrouted)
      expect(await framed(window, 'route_send', 'route_send_result', { agentId: 'nobody', text: 'hello' })).toBe(unsent)
      expect(Date.now() - at).toBeLessThan(2_000)
    } finally { window.close() }
    expect(d.log()).toContain('devices_ws failed · Error')
    expect(d.coresStarted()).toBe(1)
  }, 120_000)
})
