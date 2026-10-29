/**
 * The socket meter (harness/socketMeter.ts) against a stand-in backend: what it records is what the
 * WebSocket phases' Done criteria are judged on (socketChurn.e2e.ts), so it is checked here on its own,
 * with no Mongo, Redis or daemon. The stand-in answers the way the real web-ws does: `connected` on
 * open, then `connected {machineId}` or `machine_select_error {error}` for a `machine_select`, and it
 * refuses a bad credential before the upgrade. `slow-token` holds the upgrade for a moment, long enough
 * for a client to give up first.
 */
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket, { WebSocketServer } from 'ws'
import { SocketMeter } from './harness/socketMeter.js'

const KNOWN = 'aa'.repeat(16), DELETED = 'dd'.repeat(16)

interface StandIn {
  server: Server
  url: string
  protocols: string[]
  /** Each upgrade's request headers, as the backend got them. */
  headers: Array<Record<string, string | string[] | undefined>>
  /** Upgraded sockets not closed yet. */
  open: Set<WebSocket>
}

async function standIn(): Promise<StandIn> {
  const protocols: string[] = []
  const headers: StandIn['headers'] = []
  const open = new Set<WebSocket>()
  const wss = new WebSocketServer({ noServer: true, handleProtocols: (set) => [...set][0] ?? false })
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ path: req.url, method: req.method }))
  })
  server.on('upgrade', (req, socket, head) => {
    const token = String(req.headers['sec-websocket-protocol'] ?? '')
    if (token !== 'good-token' && token !== 'slow-token') {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
      return
    }
    protocols.push(token)
    headers.push(req.headers)
    const upgrade = () => wss.handleUpgrade(req, socket, head, (ws) => {
      open.add(ws)
      ws.on('close', () => open.delete(ws))
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
    if (token === 'slow-token') setTimeout(upgrade, 300)
    else upgrade()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return { server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, protocols, headers, open }
}

async function dial(url: string, protocol = 'good-token', headers: Record<string, string> = {}): Promise<{ ws: WebSocket; frames: any[]; closed: Promise<number> }> {
  const ws = new WebSocket(url, [protocol], { headers })
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

    const web = await dial(`${meter.wsUrl}/api/web-ws?autonomousEnv=prod&client=web`, 'good-token', { 'x-harness-probe': 'kept', cookie: 'c=1' })
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

    // As the backend reads them (#2029 wsAttribution.ts declaredKind): a kind it does not know is `unknown`, a
    // version that is not a short plain token is none, and the adapter is the daemon.
    const odd = await dial(`${meter.wsUrl}/api/web-ws?client=bogus&v=${encodeURIComponent('1 <b>')}`)
    odd.ws.close(1000)
    await odd.closed
    const adapter = await dial(`${meter.wsUrl}/api/adapter-ws?v=2.1.0`)
    adapter.ws.close(1000)
    await adapter.closed

    await until('the four closes recorded', () => meter.sockets.filter((s) => s.closedAt !== null).length === 4)
    // The credential reaches the backend as the subprotocol, as clients send it, and the client's own headers
    // with it; the handshake's are the meter's own.
    expect(backend.protocols).toEqual(Array(5).fill('good-token'))
    expect(backend.headers[0]).toMatchObject({ 'x-harness-probe': 'kept', cookie: 'c=1' })

    const [first, second, third, fourth, fifth] = meter.sockets
    expect(first).toMatchObject({ endpoint: '/api/web-ws', client: 'web', version: null, closedAt: null,
      selects: [{ machineId: KNOWN, outcome: 'accepted' }] })
    expect(second).toMatchObject({ endpoint: '/api/web-ws', client: 'relay', version: '1.2.3', closeCode: 4404,
      selects: [{ machineId: DELETED, outcome: 'NOT_YOUR_MACHINE' }] })
    expect(third).toMatchObject({ endpoint: '/api/web-ws', client: 'unknown', version: null, closeCode: 1000, selects: [] })
    expect(fourth).toMatchObject({ client: 'unknown', version: null })
    expect(fifth).toMatchObject({ endpoint: '/api/adapter-ws', client: 'daemon', version: '2.1.0' })
    web.ws.close()
    await web.closed
  })

  // Two daemons of one account declare the same client, version and token, so only where they dial tells them apart
  // (Lead, 2026-10-29): each gets its own entry, and every socket and HTTP request through it carries that name.
  it('names the entry a socket came through, and forwards it like any other', async () => {
    const backend = await standIn()
    stops.push(() => { backend.server.closeAllConnections(); backend.server.close() })
    const meter = await SocketMeter.start(backend.url)
    stops.push(() => meter.close())
    const a = await meter.entry('a')
    const b = await meter.entry('b')

    const fromA = await dial(`${a.wsUrl}/api/web-ws?autonomousEnv=prod&client=relay&v=1.2.3`)
    fromA.ws.send(JSON.stringify({ type: 'machine_select', payload: { machineId: KNOWN } }))
    await until('the select answer', () => fromA.frames.length === 2)
    const fromB = await dial(`${b.wsUrl}/api/web-ws?autonomousEnv=prod&client=relay&v=1.2.3`)
    const direct = await dial(`${meter.wsUrl}/api/web-ws?autonomousEnv=prod&client=web`)
    expect(await (await fetch(`${b.url}/api/machines`)).json()).toEqual({ path: '/api/machines', method: 'GET' })

    expect(meter.sockets.map((s) => s.via)).toEqual(['a', 'b', null])
    expect(meter.sockets[0].selects).toMatchObject([{ machineId: KNOWN, outcome: 'accepted' }])
    for (const c of [fromA, fromB, direct]) { c.ws.close(); await c.closed }
  })

  it('closes its side to the backend when the client gives up before the upgrade completes', async () => {
    const backend = await standIn()
    stops.push(() => { backend.server.closeAllConnections(); backend.server.close() })
    const meter = await SocketMeter.start(backend.url)
    stops.push(() => meter.close())

    const quitter = new WebSocket(`${meter.wsUrl}/api/web-ws?client=web`, ['slow-token'])
    quitter.on('error', () => {})
    await until('the backend holding the upgrade', () => backend.protocols.length === 1)
    quitter.terminate()
    // The backend's upgrade completes after the client left; the meter must not keep that socket.
    await new Promise((r) => setTimeout(r, 600))
    await until('the backend side closed', () => backend.open.size === 0)
    expect(meter.sockets).toEqual([])
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
        { endpoint: '/api/web-ws', client: 'unknown', version: null, openedAt: at, closedAt: at + 90_000, closeCode: 1000, closeReason: '', selects: [], via: null },
        { endpoint: '/api/adapter-ws', client: 'daemon', version: '1.0.0', openedAt: at, closedAt: null, closeCode: null, closeReason: '', selects: [], via: null },
        // Opened before the clock started (the daemons' own start): outside the report.
        { endpoint: '/api/web-ws', client: 'relay', version: '1.0.0', openedAt: at - 5_000, closedAt: at - 4_000, closeCode: 1011, closeReason: '',
          selects: [{ machineId: DELETED, at: at - 5_000, outcome: 'NOT_YOUR_MACHINE' }] },
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
    // And by kind, so many attributed relays cannot hide a kind that never is.
    expect(web.attributedByClient).toEqual({ relay: 1, web: 0.5, unknown: 0 })
    expect(web.closeCodes).toEqual({ 1011: 2, 1000: 1, 1006: 1 })
    expect(web.selectOutcomes).toEqual({ NOT_YOUR_MACHINE: 2, accepted: 2 })
    expect(web.deletedMachineSelects).toBe(2)
    expect(web.selectsByMachine).toEqual({ [DELETED]: 2, [KNOWN]: 2 })
    // Selected fine and closed within a minute: the second tab, not the first (still open at 120 s).
    expect(web.acceptedThenDiedUnder1m).toBe(1)
    expect(report.endpoints['/api/adapter-ws'].connects).toBe(1)
  })
})
