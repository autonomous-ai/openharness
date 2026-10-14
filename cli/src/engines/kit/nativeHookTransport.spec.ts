import http from 'node:http'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { sendNativeHookRequest } from './nativeHookTransport.js'
import type { NativeHookClientRequest } from './nativeHookClient.js'

let server: http.Server, request: NativeHookClientRequest, received: { headers: http.IncomingHttpHeaders; path?: string; body: Buffer }[]
let answer: (request: http.IncomingMessage, response: http.ServerResponse) => void
beforeEach(async () => {
  received = []; answer = (_req, res) => { res.end('{"fixture":"response"}') }
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => { received.push({ headers: req.headers, path: req.url, body: Buffer.concat(chunks) }); answer(req, res) })
  })
  await new Promise<void>((done, fail) => {
    server.once('error', fail)
    server.listen(0, '127.0.0.1', () => { server.off('error', fail); done() })
  })
  const port = (server.address() as { port: number }).port
  expect(port).not.toBe(18473)
  request = { port, path: '/api/native-hook/v1/session-start', id: 'fixture-delivery-0001', firedAt: 1234, body: '{ "prompt": "é📘" }' }
})
afterEach(async () => {
  server.closeAllConnections()
  if (server.listening) await new Promise<void>((done, fail) => server.close(error => error ? fail(error) : done()))
  vi.restoreAllMocks()
})

it('sends exact original bytes and receipt headers on a private versioned route', async () => {
  expect(await sendNativeHookRequest(request, 'fixture-token', () => true)).toEqual({ fixture: 'response' })
  expect(received).toHaveLength(1)
  expect(received[0]).toMatchObject({ path: request.path, headers: { 'x-harness-hook-token': 'fixture-token',
    'x-harness-hook-delivery-id': request.id, 'x-harness-hook-fired-at': '1234', 'content-length': String(Buffer.byteLength(request.body)) } })
  expect(received[0].body.equals(Buffer.from(request.body))).toBe(true)
})

it.each([202, 200])('returns a bounded complete %s body for the protocol validator, never treating status as ownership', async status => {
  answer = (_req, res) => { res.writeHead(status); res.end('{"pending":true}') }
  expect(await sendNativeHookRequest(request, 'fixture-token', () => true)).toEqual({ pending: true })
})

it.each([400, 404, 409, 500])('holds an HTTP %s reply', async status => {
  answer = (_req, res) => { res.writeHead(status); res.end('{"version":1,"outcome":"complete"}') }
  expect(await sendNativeHookRequest(request, 'fixture-token', () => true)).toBeUndefined()
})

it.each(['oversized', 'malformed', 'truncated', 'utf8', 'bom'])('holds a %s response and closes its connection', async kind => {
  answer = (_req, res) => {
    if (kind === 'truncated') { res.writeHead(200, { 'content-length': 100 }); res.write('{'); res.destroy(); return }
    if (kind === 'oversized') { res.end(JSON.stringify({ padding: 'x'.repeat(16_384) })); return }
    res.end(kind === 'utf8' ? Buffer.concat([Buffer.from('{"invalid":"'), Buffer.from([0xff]), Buffer.from('"}')])
      : kind === 'bom' ? '\ufeff{}' : '{')
  }
  expect(await sendNativeHookRequest(request, 'fixture-token', () => true)).toBeUndefined()
})

it('bounds a connected server that never finishes its response', async () => {
  answer = (_req, res) => { res.writeHead(200); res.write('{') }
  expect(await sendNativeHookRequest(request, 'fixture-token', () => true, 20)).toBeUndefined()
  expect(received).toHaveLength(1)
})

it('revokes a complete response received after the original attempt was closed', async () => {
  let current = true
  answer = (_req, res) => { current = false; res.end('{"fixture":"late"}') }
  expect(await sendNativeHookRequest(request, 'fixture-token', () => current)).toBeUndefined()
})

it('refuses a complete response after its own monotonic deadline even before the timer fires', async () => {
  let expired = false
  const now = performance.now.bind(performance)
  vi.spyOn(performance, 'now').mockImplementation(() => now() + (expired ? 1000 : 0))
  answer = (_req, res) => { expired = true; res.end('{"fixture":"late"}') }
  expect(await sendNativeHookRequest(request, 'fixture-token', () => true)).toBeUndefined()
  expect(received).toHaveLength(1)
})

it.each([[undefined, 700, false], [1500, 700, true], [1500, 1600, false], [10000, 5000, false]] as const)(
  'uses explicit recovery budget %s without replacing its monotonic cap after %s ms', async (budget, elapsed, accepted) => {
    let answered = false
    const now = performance.now.bind(performance)
    vi.spyOn(performance, 'now').mockImplementation(() => now() + (answered ? elapsed : 0))
    answer = (_req, res) => { answered = true; res.end('{"fixture":"confirmed"}') }
    const result = await sendNativeHookRequest(request, 'fixture-token', () => true, budget)
    expect(result).toEqual(accepted ? { fixture: 'confirmed' } : undefined)
    expect(received).toHaveLength(1)
  },
)

it('rechecks its deadline immediately before sending any retained bytes', async () => {
  let elapsed = 0, checks = 0
  vi.spyOn(performance, 'now').mockImplementation(() => elapsed)
  const current = () => { if (++checks === 2) elapsed = 1000; return true }
  expect(await sendNativeHookRequest(request, 'fixture-token', current)).toBeUndefined()
  expect(received).toHaveLength(0)
})

it('does not contact a listener for a legacy route, malformed envelope or revoked caller', async () => {
  for (const changed of [{ path: '/api/hook/session-start' }, { path: '/api/native-hook/v1/unknown' },
    { id: '' }, { firedAt: 0 }, { port: 0 }, { body: 'x'.repeat(256 * 1024 + 1) }]) {
    expect(await sendNativeHookRequest({ ...request, ...changed }, 'fixture-token', () => true)).toBeUndefined()
  }
  expect(await sendNativeHookRequest(request, '', () => true)).toBeUndefined()
  expect(await sendNativeHookRequest(request, 'fixture-token', () => false)).toBeUndefined()
  expect(received).toHaveLength(0)
})

it('contains connection refusal and invalid credential headers without falling back', async () => {
  expect(await sendNativeHookRequest(request, 'invalid\nheader', () => true)).toBeUndefined()
  const port = request.port
  await new Promise<void>((done, fail) => server.close(error => error ? fail(error) : done()))
  // Reopen the fixture on a new private port so teardown still owns its listener.
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  expect(await sendNativeHookRequest({ ...request, port }, 'fixture-token', () => true)).toBeUndefined()
})
