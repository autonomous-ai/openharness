/**
 * The Harness backend, faked on 127.0.0.1, for a fleet of isolated daemons signed in to one account:
 * enough of its control plane and relay for two machines to find and reach each other, and nothing
 * that leaves this machine.
 *
 * - `GET /api/machines`: the account's machines, each `running` or `offline` as the test says.
 * - `/api/adapter-ws`: each daemon's own socket, as the node of its machine. Frames for it arrive as
 *   `{t:'down', connId, frame}`; what it sends comes back as `{t:'up', targetConnId?, commanderEligible?, frame}`.
 * - `/api/device-ws`: a daemon's lane to its owner's other machines, as a device holding a commander
 *   on every machine of the account (`multi_machine`). A frame tagged with a machine id goes down to
 *   that machine's node, an untagged one to the machine selected; a reply to that commander comes back
 *   up tagged with the machine it is from, which is how the device knows which session opens it.
 *
 * Like the real relay it is blind: the machines seal everything between them end to end, and a frame
 * for a machine whose node is not connected is simply never answered, as the real hub's would not be.
 * Everything else is answered 404. Requests are recorded in `seen`, so a test can say what was asked.
 */
import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer, type RawData } from 'ws'

export interface FakeMachine {
  machineId: string
  computerId: string
  name: string
  /** The access token this machine's daemon signs in with. */
  token: string
}

type Frame = { type?: string; machineId?: string; agentId?: string; payload?: Record<string, unknown>; [key: string]: unknown }

/** One device socket: a commander on every machine of the account, one connection id per machine. */
interface Device {
  ws: WebSocket
  selected: string
  conns: Map<string, string>
}

const json = (value: unknown): string => JSON.stringify(value)

export class FakeBackend {
  readonly seen: string[] = []
  private readonly machines = new Map<string, FakeMachine>()
  private readonly online = new Map<string, boolean>()
  private readonly nodes = new Map<string, WebSocket>()
  private readonly devices = new Set<Device>()
  private readonly connOwners = new Map<string, { device: Device; machineId: string }>()
  private readonly wss = new WebSocketServer({ noServer: true, handleProtocols: (protocols) => [...protocols][0] ?? false })
  private generation = 0

  private constructor(private readonly server: Server, readonly port: number) {}

  static async start(): Promise<FakeBackend> {
    const server = createServer()
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('the fake backend has no port')
    const backend = new FakeBackend(server, address.port)
    server.on('request', (req, res) => {
      backend.seen.push(`${req.method} ${req.url}`)
      const machine = backend.byToken(req)
      res.setHeader('content-type', 'application/json')
      if (!machine) { res.statusCode = 401; res.end(json({ success: false, error: { code: 'UNAUTHORIZED' } })); return }
      if (req.method === 'GET' && req.url?.split('?')[0] === '/api/machines') {
        res.end(json({ success: true, data: { machines: backend.rows() } }))
        return
      }
      res.statusCode = 404
      res.end(json({ success: false, error: { code: 'NOT_FOUND', message: 'not on the fake backend' } }))
    })
    server.on('upgrade', (req, socket, head) => backend.upgrade(req, socket, head))
    return backend
  }

  get httpUrl(): string { return `http://127.0.0.1:${this.port}` }
  get wsUrl(): string { return `ws://127.0.0.1:${this.port}` }

  addMachine(machine: FakeMachine): void {
    this.machines.set(machine.machineId, machine)
    this.online.set(machine.machineId, true)
  }

  /** What the account's machine list and the live status say about a machine — the backend's view,
   *  which lags the machine itself: a node that just went away is still `running` here until this says. */
  setOnline(machineId: string, online: boolean): void {
    this.online.set(machineId, online)
    for (const device of this.devices) this.sendDevice(device, { type: 'machines_status', payload: { statuses: this.statuses() } })
  }

  /** Whether this machine's daemon is connected as its node right now. */
  nodeUp(machineId: string): boolean {
    return this.nodes.get(machineId)?.readyState === WebSocket.OPEN
  }

  /** How many device sockets are open: a daemon's lane to the other machines. */
  devicesOpen(): number {
    return [...this.devices].filter((device) => device.ws.readyState === WebSocket.OPEN).length
  }

  async close(): Promise<void> {
    for (const client of this.wss.clients) client.terminate()
    await new Promise<void>((done) => this.wss.close(() => done()))
    await new Promise<void>((done) => this.server.close(() => done()))
  }

  private rows(): Array<Record<string, unknown>> {
    return [...this.machines.values()].map((m) => ({
      machineId: m.machineId, computerId: m.computerId, name: m.name, hostname: m.name,
      status: this.online.get(m.machineId) ? 'running' : 'offline', authMode: 'remote',
    }))
  }

  private statuses(): Array<{ machineId: string; online: boolean }> {
    return [...this.machines.keys()].map((machineId) => ({ machineId, online: this.online.get(machineId) === true }))
  }

  private byToken(req: IncomingMessage): FakeMachine | undefined {
    const bearer = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ''))?.[1]
    const offered = String(req.headers['sec-websocket-protocol'] ?? '').split(',')[0]?.trim()
    const token = bearer ?? offered
    return token ? [...this.machines.values()].find((m) => m.token === token) : undefined
  }

  private upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(req.url ?? '/', this.httpUrl)
    this.seen.push(`WS ${url.pathname}`)
    const machine = this.byToken(req)
    const refuse = (status: number, text: string): void => {
      socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
    }
    if (!machine) { refuse(401, 'Unauthorized'); return }
    if (url.pathname === '/api/adapter-ws') {
      // The node is the machine that signed in, on the computer it says it is.
      if (url.searchParams.get('computer') !== machine.computerId) { refuse(403, 'Forbidden'); return }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.attachNode(machine, ws))
      return
    }
    if (url.pathname === '/api/device-ws') {
      this.wss.handleUpgrade(req, socket, head, (ws) => this.attachDevice(ws))
      return
    }
    refuse(404, 'Not Found')
  }

  // ── nodes ────────────────────────────────────────────────────────────────────────────────────

  private attachNode(machine: FakeMachine, ws: WebSocket): void {
    this.nodes.get(machine.machineId)?.terminate()
    this.nodes.set(machine.machineId, ws)
    // What the real backend says first: the machine's name, and how many commanders are watching it.
    this.sendNode(machine.machineId, '', { type: 'machine_meta', payload: { name: machine.name } })
    this.sendClients(machine.machineId)
    ws.on('message', (raw, binary) => { if (!binary) this.fromNode(machine.machineId, raw) })
    ws.on('close', () => { if (this.nodes.get(machine.machineId) === ws) this.nodes.delete(machine.machineId) })
  }

  private fromNode(machineId: string, raw: RawData): void {
    let envelope: { t?: string; targetConnId?: string; commanderEligible?: boolean; frame?: Frame }
    try { envelope = JSON.parse(raw.toString()) } catch { return }
    if (envelope.t !== 'up' || !envelope.frame) return
    const tagged = { ...envelope.frame, machineId }
    if (envelope.targetConnId) {
      const owner = this.connOwners.get(envelope.targetConnId)
      if (owner?.machineId === machineId) this.sendDevice(owner.device, tagged)
      return
    }
    if (envelope.commanderEligible) for (const device of this.devices) this.sendDevice(device, tagged)
  }

  private sendNode(machineId: string, connId: string, frame: Frame): boolean {
    const ws = this.nodes.get(machineId)
    if (ws?.readyState !== WebSocket.OPEN) return false
    ws.send(json({ t: 'down', connId, frame }))
    return true
  }

  private sendClients(machineId: string): void {
    const commanders = [...this.devices].filter((device) => device.ws.readyState === WebSocket.OPEN).length
    this.sendNode(machineId, '', {
      type: '__clients',
      payload: { commander: commanders, commanderActive: commanders, commanderJoinGeneration: this.generation },
    })
  }

  // ── devices ──────────────────────────────────────────────────────────────────────────────────

  private attachDevice(ws: WebSocket): void {
    const device: Device = { ws, selected: '', conns: new Map() }
    for (const machineId of this.machines.keys()) {
      const connId = `device:${randomUUID()}`
      device.conns.set(machineId, connId)
      this.connOwners.set(connId, { device, machineId })
    }
    this.devices.add(device)
    this.generation++
    for (const machineId of this.machines.keys()) this.sendClients(machineId)
    ws.on('message', (raw, binary) => { if (!binary) this.fromDevice(device, raw) })
    ws.on('close', () => {
      this.devices.delete(device)
      this.generation++
      for (const [machineId, connId] of device.conns) {
        this.connOwners.delete(connId)
        this.sendNode(machineId, connId, { type: '__client_disconnected', payload: {} })
        this.sendClients(machineId)
      }
    })
  }

  private fromDevice(device: Device, raw: RawData): void {
    let frame: Frame
    try { frame = JSON.parse(raw.toString()) as Frame } catch { return }
    const type = frame.type ?? ''
    if (type === 'device_hello' || type === 'ping') return
    if (type === 'machines_watch') {
      this.sendDevice(device, { type: 'machines_status', payload: { statuses: this.statuses() } })
      return
    }
    if (type === 'machine_select') {
      const machineId = String(frame.payload?.machineId ?? '')
      if (!this.machines.has(machineId)) {
        this.sendDevice(device, { type: 'machine_select_error', payload: { error: 'NOT_YOUR_MACHINE' } })
        return
      }
      device.selected = machineId
      this.sendDevice(device, { type: 'machine_selected', payload: { machineId } })
      return
    }
    if (type === 'machine_deselect') { device.selected = ''; return }
    // Everything else is for a machine: the one it is tagged for, or the one selected. Never answered
    // here: a node that is not connected leaves it unanswered, as the real hub does.
    const machineId = frame.machineId && device.conns.has(frame.machineId) ? frame.machineId : device.selected
    const connId = device.conns.get(machineId)
    if (connId) this.sendNode(machineId, connId, frame)
  }

  private sendDevice(device: Device, frame: Frame): void {
    if (device.ws.readyState === WebSocket.OPEN) device.ws.send(json(frame))
  }
}
