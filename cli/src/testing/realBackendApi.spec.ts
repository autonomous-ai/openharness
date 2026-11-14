import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { afterEach, expect, it } from 'vitest'

// The end-to-end harness is outside tsconfig's rootDir (src), so it is loaded untyped, as fullDisk.spec.ts loads
// fullDisk.ts.
const { backendApi, BACKEND_API_TIMEOUT_MS, stopAll } = await import('../../e2e/harness/realBackend.js' as string) as {
  backendApi: (url: string, a: unknown, path: string, method?: string, body?: unknown, ms?: number) => Promise<{ status: number; body: unknown }>
  BACKEND_API_TIMEOUT_MS: number
  stopAll: (daemons: Array<{ close(): Promise<void> }>, stops: Array<() => unknown>) => Promise<void>
}

const A = { name: 'a', token: 't', id: 'i', email: 'a@spike.invalid' }
const servers: Server[] = []
async function serve(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
  const server = createServer(handler).listen(0, '127.0.0.1')
  servers.push(server)
  await once(server, 'listening')
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`
}
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise(done => server.close(done))
  }
})

it('names the call a backend never answered, at its limit', async () => {
  const url = await serve(() => { /* accepts, and never answers */ })
  await expect(backendApi(url, A, '/api/machines/resolve-computer', 'POST', { computerId: 'c' }, 200))
    .rejects.toThrow('the test backend did not answer POST /api/machines/resolve-computer within 200 ms')
})
it('counts the body in the limit: headers alone are no answer', async () => {
  const url = await serve((_, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"data":') })
  await expect(backendApi(url, A, '/api/slow', undefined, undefined, 200))
    .rejects.toThrow('the test backend did not answer GET /api/slow within 200 ms')
})
it('answers as before: the status and the parsed body, or null for a body that is not JSON', async () => {
  const url = await serve((req, res) => req.url === '/json'
    ? res.end(JSON.stringify({ method: req.method, auth: req.headers.authorization, env: req.headers['x-autonomous-env'], type: req.headers['content-type'] }))
    : res.writeHead(502).end('Bad Gateway'))
  expect(await backendApi(url, A, '/json', 'POST', { a: 1 })).toEqual({ status: 200, body: { method: 'POST', auth: 'Bearer t', env: 'prod', type: 'application/json' } })
  expect(await backendApi(url, A, '/text')).toEqual({ status: 502, body: null })
})
it('gives a call 30 seconds', () => { expect(BACKEND_API_TIMEOUT_MS).toBe(30_000) })

// backend.stop(): a root left behind or a process that would not end was swallowed there and seen by no one.
it('stops every daemon and every service, last started first, then throws the closes that failed', async () => {
  const order: string[] = []
  const daemon = (name: string, error?: Error) => ({ close: async () => { order.push(name); if (error) throw error } })
  const stops = [() => { order.push('mongo') }, () => { order.push('backend'); throw new Error('already gone') }]
  await expect(stopAll([daemon('a', new Error('a left processes')), daemon('b')], stops))
    .rejects.toThrow('1 daemon(s) under test did not close: Error: a left processes')
  expect(order).toEqual(['a', 'b', 'backend', 'mongo'])
})
