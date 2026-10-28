/**
 * The socket meter (harness/socketMeter.ts) against a stand-in backend: what it records is what the
 * WebSocket phases' Done criteria are judged on (socketChurn.e2e.ts), so it is checked here on its own,
 * with no Mongo, Redis or daemon. The stand-in answers the way the real web-ws does: `connected` on
 * open, then `connected {machineId}` or `machine_select_error {error}` for a `machine_select`, and it
 * refuses a bad credential before the upgrade.
 */
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket, { WebSocketServer } from 'ws'
import { SocketMeter } from './harness/socketMeter.js'

const KNOWN = 'aa'.repeat(16), DELETED = 'dd'.repeat(16)

async function standIn(): Promise<{ server: Server; url: string; protocols: string[] }> {
  const protocols: string[] = []
  const wss = new WebSocketServer({ noServer: true, handleProtocols: (set) => [...set][0] ?? false })
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ path: req.url, method: req.method }))
  })
  server.on('upgrade', (req, socket, head) => {
    const token = String(req.headers['sec-websocket-protocol'] ?? '')
    if (token !== 'good-token') {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
      return
    }
    protocols.push(token)
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.send(JSON.stringify({ type: 'connected', payload: { userId: 'u1' } }))
      ws.on('message', (raw, binary) => {
        if (binary) { ws.send(raw, { binary: true }); return }
        const frame = JSON.parse(raw.toString())
        if (frame.type !== 'machine_select') return
        if (frame.payload.machineId === KNOWN) ws.send(JSON.stringify({ type: 'connected', payload: { machineId: KNOWN } }))
        else {
          ws.send(JSON.stringify({ type: 'machine_select_error', payload: { machineId: frame.payload.machineId, error: 'NOT_YOUR_MACHINE' } }))
          ws.close(4404, 'gone')
        }
      })
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return { server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, protocols }
}

async function dial(url: string, protocol = 'good-token'): Promise<{ ws: WebSocket; frames: any[]; closed: Promise<number> }> {
  const ws = new WebSocket(url, [protocol])
  const frames: any[] = []
  ws.on('message', (raw, binary) => { if (!binary) frames.push(JSON.parse(raw.toString())) })
  const closed = new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)))
  await once(ws, 'open')
  return { ws, frames, closed }
}

const until = async (what: string, probe: () => boolean, ms = 5_000): Promise<void> => {
  const deadline = Date.now() + ms
  while (!probe()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${what}`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe('socket meter', () => {
  const stops: Array<() => unknown> = []
  afterEach(async () => { for (const stop of stops.splice(0).reverse()) await stop() })

  it('records each socket with its client, its selects and their answers, and how it closed', async () => {
    const backend = await standIn()
    stops.push(() => { backend.server.closeAllConnections(); backend.server.close() })
    const meter = await SocketMeter.start(backend.url)
    stops.push(() => meter.close())

    const web = await dial(`${meter.wsUrl}/api/web-ws?autonomousEnv=prod&client=web`)
    await until('the backend hello', () => web.frames.length === 1)
    web.ws.send(JSON.stringify({ type: 'machine_select', payload: { machineId: KNOWN } }))
    await until('the select answer', () => web.frames.length === 2)
    expect(web.frames[1]).toEqual({ type: 'connected', payload: { machineId: KNOWN } })
    // Binary frames pass both ways untouched.
    const echoed = new Promise<Buffer>((resolve) => web.ws.once('message', (raw) => resolve(raw as Buffer)))
    web.ws.send(Buffer.from([1, 2, 3]))
    expect([...await echoed]).toEqual([1, 2, 3])

    const relay = await dial(`${meter.wsUrl}/api/web-ws?autonomousEnv=prod&client=relay&v=1.2.3`)
    relay.ws.send(JSON.stringify({ type: 'machine_select', payload: { machineId: DELETED } }))
    expect(await relay.closed).toBe(4404)

    const idle = await dial(`${meter.wsUrl}/api/web-ws?autonomousEnv=prod`)
    idle.ws.close(1000)
    expect(await idle.closed).toBe(1000)

    await until('the two closes recorded', () => meter.sockets.filter((s) => s.closedAt !== null).length === 2)
    // The credential reaches the backend as the subprotocol, as clients send it.
    expect(backend.protocols).toEqual(['good-token', 'good-token', 'good-token'])

    const [first, second, third] = meter.sockets
    expect(first).toMatchObject({ endpoint: '/api/web-ws', client: 'web', version: null, closedAt: null,
      selects: [{ machineId: KNOWN, outcome: 'accepted' }] })
    expect(second).toMatchObject({ endpoint: '/api/web-ws', client: 'relay', version: '1.2.3', closeCode: 4404,
      selects: [{ machineId: DELETED, outcome: 'NOT_YOUR_MACHINE' }] })
    expect(third).toMatchObject({ endpoint: '/api/web-ws', client: null, version: null, closeCode: 1000, selects: [] })
    web.ws.close()
    await web.closed
  })

  it('counts a refused upgrade apart from the sockets, and HTTP requests by route', async () => {
    const backend = await standIn()
    stops.push(() => { backend.server.closeAllConnections(); backend.server.close() })
    const meter = await SocketMeter.start(backend.url)
    stops.push(() => meter.close())

    const refused = new WebSocket(`${meter.wsUrl}/api/web-ws?client=web`, ['bad-token'])
    refused.on('error', () => {})
    const status = await new Promise<number>((resolve) => {
      refused.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0))
      refused.once('open', () => resolve(101))
    })
    refused.terminate()
    expect(status).toBe(401)

    const machine = 'ab12'.repeat(8)
    for (const path of ['/api/machines', '/api/machines', `/api/machines/${machine}/agents`, '/api/harness-shares?x=1']) {
      const r = await fetch(`${meter.url}${path}`)
      expect(await r.json()).toEqual({ path, method: 'GET' })
    }
    const posted = await fetch(`${meter.url}/api/machines/resolve-computer`, { method: 'POST', body: '{}' })
    expect(((await posted.json()) as { method: string }).method).toBe('POST')

    expect(meter.sockets).toEqual([])
    expect(meter.refused).toMatchObject([{ endpoint: '/api/web-ws', status: 401 }])
    expect(meter.report().http).toEqual({
      'GET /api/machines': 2, 'GET /api/machines/:id/agents': 1, 'GET /api/harness-shares': 1, 'POST /api/machines/resolve-computer': 1,
    })
  })

  it('reports per endpoint: connects a minute, median lifetime, sockets never selected, attribution, deleted-machine selects', () => {
    const at = 1_000_000
    const meter = SocketMeter.fromRecords({
      startedAt: at,
      sockets: [
        // Two relays to a deleted machine, a second each.
        { endpoint: '/api/web-ws', client: 'relay', version: '1.0.0', openedAt: at, closedAt: at + 1_000, closeCode: 1011, closeReason: '',
          selects: [{ machineId: DELETED, at, outcome: 'NOT_YOUR_MACHINE' }] },
        { endpoint: '/api/web-ws', client: 'relay', version: '1.0.0', openedAt: at + 10_000, closedAt: at + 11_000, closeCode: 1011, closeReason: '',
          selects: [{ machineId: DELETED, at: at + 10_000, outcome: 'NOT_YOUR_MACHINE' }] },
        // A web tab, selected, open to the end.
        { endpoint: '/api/web-ws', client: 'web', version: null, openedAt: at, closedAt: null, closeCode: null, closeReason: '',
          selects: [{ machineId: KNOWN, at, outcome: 'accepted' }] },
        // A second tab, selected, dropped after 30 s.
        { endpoint: '/api/web-ws', client: 'web', version: '2.0.0', openedAt: at + 20_000, closedAt: at + 50_000, closeCode: 1006, closeReason: '',
          selects: [{ machineId: KNOWN, at: at + 20_000, outcome: 'accepted' }] },
        // A daemon relay that never selected, 90 s.
        { endpoint: '/api/web-ws', client: null, version: null, openedAt: at, closedAt: at + 90_000, closeCode: 1000, closeReason: '', selects: [] },
        { endpoint: '/api/adapter-ws', client: null, version: '1.0.0', openedAt: at, closedAt: null, closeCode: null, closeReason: '', selects: [] },
      ],
      refused: [{ endpoint: '/api/web-ws', status: 401, at }],
      http: {},
    })
    const report = meter.report({ now: at + 120_000, deletedMachineIds: [DELETED] })
    expect(report.durationMs).toBe(120_000)
    const web = report.endpoints['/api/web-ws']
    expect(web.connects).toBe(5)
    expect(web.connectsPerMinute).toBe(2.5)
    expect(web.refused).toBe(1)
    // Lifetimes 1 s, 1 s, 30 s, 90 s, 120 s (still open at the report).
    expect(web.medianLifetimeMs).toBe(30_000)
    expect(web.livedUnder2s).toBe(2)
    expect(web.closedWithoutSelect).toBe(1)
    // Attributed: a client kind and a version. The two relays and the second tab.
    expect(web.attributed).toBe(0.6)
    expect(web.closeCodes).toEqual({ 1011: 2, 1000: 1, 1006: 1 })
    expect(web.selectOutcomes).toEqual({ NOT_YOUR_MACHINE: 2, accepted: 2 })
    expect(web.deletedMachineSelects).toBe(2)
    expect(web.selectsByMachine).toEqual({ [DELETED]: 2, [KNOWN]: 2 })
    // Selected fine and closed within a minute: the second tab, not the first (still open at 120 s).
    expect(web.acceptedThenDiedUnder1m).toBe(1)
    expect(report.endpoints['/api/adapter-ws'].connects).toBe(1)
  })
})
