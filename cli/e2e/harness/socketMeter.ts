/**
 * A recording proxy in front of a local backend: every client in a socket scenario dials this instead
 * of the backend, so what it records is what the backend was asked, whatever the backend logs.
 *
 * Per WebSocket it keeps the endpoint, the client kind and version the client declared on the URL
 * (`client=`, `v=` or mobile's `release=`), when it opened and closed and with which code, and each
 * `machine_select` it sent with the backend's answer (`connected` → accepted, `machine_select_error` →
 * its code). An upgrade the backend refused is a refusal, never a socket. HTTP requests are counted by
 * method and route, ids folded to `:id`.
 *
 * Written for the WebSocket roadmap (Ken, 2026-10-28): Phase 0 and Phase 1 are judged on connects a
 * minute, socket lifetime, sockets that never selected, attribution and selects of deleted machines,
 * and the backend's own Phase 0 logs cannot be the measure of whether Phase 0 worked.
 */
import { createServer, request, type IncomingMessage, type Server } from 'node:http'
import { once } from 'node:events'
import type { Duplex } from 'node:stream'
import WebSocket, { WebSocketServer, type RawData } from 'ws'

export interface SelectRecord { machineId: string; at: number; outcome: string | null }

export interface SocketRecord {
  endpoint: string
  client: string | null
  version: string | null
  openedAt: number
  closedAt: number | null
  closeCode: number | null
  closeReason: string
  selects: SelectRecord[]
}

export interface RefusalRecord { endpoint: string; status: number; at: number }

export interface MeterRecords {
  startedAt: number
  sockets: SocketRecord[]
  refused: RefusalRecord[]
  http: Record<string, number>
}

export interface EndpointReport {
  connects: number
  connectsPerMinute: number
  refused: number
  /** Over every socket; one still open counts its age at the report. */
  medianLifetimeMs: number
  livedUnder2s: number
  closedWithoutSelect: number
  /** The share of connects that named both a client kind and a version. */
  attributed: number
  closeCodes: Record<string, number>
  selectOutcomes: Record<string, number>
  deletedMachineSelects: number
}

export interface MeterReport {
  durationMs: number
  endpoints: Record<string, EndpointReport>
  http: Record<string, number>
}

/** Hex ids (machine ids, share ids), UUIDs and numbers in a path, folded so a route counts as one. */
export function routeOf(method: string, url: string): string {
  const path = url.split('?')[0]
    .split('/')
    .map((part) => /^[0-9a-f]{16,}$/i.test(part) || /^[0-9a-f-]{36}$/i.test(part) || /^\d+$/.test(part) ? ':id' : part)
    .join('/')
  return `${method} ${path}`
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

const count = (into: Record<string, number>, key: string): void => { into[key] = (into[key] ?? 0) + 1 }

/** The headers a client's upgrade carries that the backend reads; the rest belong to this hop. */
function forwardedHeaders(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of ['x-api-key', 'authorization', 'origin', 'user-agent', 'x-autonomous-env', 'x-forwarded-for']) {
    const value = req.headers[name]
    if (typeof value === 'string') out[name] = value
  }
  return out
}

export class SocketMeter {
  readonly sockets: SocketRecord[]
  readonly refused: RefusalRecord[]
  private readonly http: Record<string, number>
  private readonly startedAt: number
  private server: Server | null = null
  private readonly live = new Set<WebSocket>()
  url = ''
  wsUrl = ''

  private constructor(records: MeterRecords) {
    this.startedAt = records.startedAt
    this.sockets = records.sockets
    this.refused = records.refused
    this.http = records.http
  }

  /** A meter over records already taken, for reporting alone. */
  static fromRecords(records: MeterRecords): SocketMeter {
    return new SocketMeter(records)
  }

  /** Listen on a free loopback port and forward everything to `target` (`http://127.0.0.1:PORT`). */
  static async start(target: string): Promise<SocketMeter> {
    const meter = new SocketMeter({ startedAt: Date.now(), sockets: [], refused: [], http: {} })
    const upstream = new URL(target)
    const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, handleProtocols: (set) => [...set][0] ?? false })
    const server = createServer((req, res) => {
      count(meter.http, routeOf(req.method ?? 'GET', req.url ?? '/'))
      const forward = request({ host: upstream.hostname, port: upstream.port, method: req.method, path: req.url,
        headers: { ...req.headers, host: upstream.host } }, (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.headers)
        answer.pipe(res)
      })
      forward.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end() })
      req.pipe(forward)
    })
    server.on('upgrade', (req, socket, head) => meter.upgrade(req, socket, head, upstream, wss))
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const port = (server.address() as { port: number }).port
    meter.server = server
    meter.url = `http://127.0.0.1:${port}`
    meter.wsUrl = `ws://127.0.0.1:${port}`
    return meter
  }

  private upgrade(req: IncomingMessage, socket: Duplex, head: Buffer, upstream: URL, wss: WebSocketServer): void {
    const query = new URL(req.url ?? '/', 'http://meter').searchParams
    const endpoint = (req.url ?? '/').split('?')[0]
    const protocols = String(req.headers['sec-websocket-protocol'] ?? '').split(',').map((p) => p.trim()).filter(Boolean)
    const backend = new WebSocket(`ws://${upstream.host}${req.url ?? '/'}`, protocols, {
      headers: forwardedHeaders(req), perMessageDeflate: false })
    const refuse = (status: number): void => {
      this.refused.push({ endpoint, status, at: Date.now() })
      if (status > 0) socket.end(`HTTP/1.1 ${status} Refused\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
      else socket.destroy()
    }
    let opened = false
    backend.once('unexpected-response', (_r, res) => { opened = true; refuse(res.statusCode ?? 0); backend.terminate() })
    backend.once('error', () => { if (!opened) { opened = true; refuse(0) } })
    socket.once('error', () => backend.terminate())
    backend.once('open', () => {
      opened = true
      // Frames the backend sends before the client side is up wait here, in order.
      const early: Array<[RawData, boolean]> = []
      const hold = (data: RawData, binary: boolean): void => { early.push([data, binary]) }
      backend.on('message', hold)
      wss.handleUpgrade(req, socket, head, (client) => this.attach(client, backend, endpoint, query, early, hold))
    })
  }

  private attach(client: WebSocket, backend: WebSocket, endpoint: string, query: URLSearchParams,
    early: Array<[RawData, boolean]>, hold: (data: RawData, binary: boolean) => void): void {
    const record: SocketRecord = { endpoint, client: query.get('client'), version: query.get('v') ?? query.get('release'),
      openedAt: Date.now(), closedAt: null, closeCode: null, closeReason: '', selects: [] }
    this.sockets.push(record)
    this.live.add(client)
    const pending = new Map<string, SelectRecord>()
    const fromBackend = (data: RawData, binary: boolean): void => {
      if (!binary) this.readAnswer(data, pending)
      if (client.readyState === WebSocket.OPEN) client.send(data, { binary })
    }
    backend.off('message', hold)
    for (const [data, binary] of early) fromBackend(data, binary)
    backend.on('message', fromBackend)
    client.on('message', (data, binary) => {
      if (!binary) {
        const frame = parse(data)
        const machineId = frame?.type === 'machine_select' ? frame.payload?.machineId : undefined
        if (typeof machineId === 'string') {
          const select: SelectRecord = { machineId, at: Date.now(), outcome: null }
          record.selects.push(select)
          pending.set(machineId, select)
        }
      }
      if (backend.readyState === WebSocket.OPEN) backend.send(data, { binary })
    })
    const finish = (code: number, reason: Buffer): void => {
      if (record.closedAt !== null) return
      record.closedAt = Date.now()
      record.closeCode = code
      record.closeReason = reason.toString()
      this.live.delete(client)
    }
    backend.on('close', (code, reason) => {
      finish(code, reason)
      // 1005 (no code) and 1006 (abnormal) cannot be sent on the wire; they are what the client sees anyway.
      if (code === 1005) client.close()
      else if (code === 1006) client.terminate()
      else client.close(code, reason)
    })
    client.on('close', (code, reason) => {
      finish(code, reason)
      if (code === 1005) backend.close()
      else if (code === 1006) backend.terminate()
      else backend.close(code, reason)
    })
    client.on('error', () => backend.terminate())
    backend.on('error', () => client.terminate())
  }

  private readAnswer(data: RawData, pending: Map<string, SelectRecord>): void {
    const frame = parse(data)
    const machineId = frame?.payload?.machineId
    if (typeof machineId !== 'string') return
    const select = pending.get(machineId)
    if (!select) return
    if (frame.type === 'connected') select.outcome = 'accepted'
    else if (frame.type === 'machine_select_error') select.outcome = String(frame.payload.error)
    else return
    pending.delete(machineId)
  }

  report(options: { now?: number; deletedMachineIds?: string[] } = {}): MeterReport {
    const now = options.now ?? Date.now()
    const deleted = new Set(options.deletedMachineIds ?? [])
    const durationMs = now - this.startedAt
    const endpoints: Record<string, EndpointReport> = {}
    const names = new Set([...this.sockets.map((s) => s.endpoint), ...this.refused.map((r) => r.endpoint)])
    for (const name of names) {
      const sockets = this.sockets.filter((s) => s.endpoint === name)
      const lifetimes = sockets.map((s) => (s.closedAt ?? now) - s.openedAt)
      const closeCodes: Record<string, number> = {}
      const selectOutcomes: Record<string, number> = {}
      for (const s of sockets) {
        if (s.closeCode !== null) count(closeCodes, String(s.closeCode))
        for (const select of s.selects) count(selectOutcomes, select.outcome ?? 'unanswered')
      }
      endpoints[name] = {
        connects: sockets.length,
        connectsPerMinute: durationMs > 0 ? sockets.length / (durationMs / 60_000) : 0,
        refused: this.refused.filter((r) => r.endpoint === name).length,
        medianLifetimeMs: median(lifetimes),
        livedUnder2s: lifetimes.filter((ms) => ms < 2_000).length,
        closedWithoutSelect: sockets.filter((s) => s.closedAt !== null && s.selects.length === 0).length,
        attributed: sockets.length ? sockets.filter((s) => s.client && s.version).length / sockets.length : 1,
        closeCodes,
        selectOutcomes,
        deletedMachineSelects: sockets.reduce((n, s) => n + s.selects.filter((select) => deleted.has(select.machineId)).length, 0),
      }
    }
    return { durationMs, endpoints, http: { ...this.http } }
  }

  async close(): Promise<void> {
    for (const ws of this.live) ws.terminate()
    const server = this.server
    if (!server) return
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
}

function parse(data: RawData): { type?: string; payload?: Record<string, any> } | null {
  try {
    const frame = JSON.parse(data.toString())
    return frame && typeof frame === 'object' ? frame : null
  } catch {
    return null
  }
}
