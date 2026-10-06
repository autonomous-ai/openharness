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
 * - `/api/web-ws`: a phone's (or a browser's) socket, as the real hub's web clients: it starts with
 *   `connected {userId}`, `machine_select` binds it to one machine (`connected {machineId}`, then that
 *   machine's `node_status`), and from then on what it sends goes down to the machine's node under its
 *   own connection id. A broadcast from the node reaches every web client of that machine unless it is
 *   `webEligible: false`; a frame targeted at a connection reaches that one only. A web client leaving
 *   is `__client_disconnected` to the node, and the node coming and going is `node_status {online}` to
 *   the machine's web clients, as the real backend's node role publishes them.
 *
 * Like the real relay it is blind: the machines seal everything between them end to end, and a frame
 * for a machine whose node is not connected is simply never answered, as the real hub's would not be.
 * - `PUT`/`DELETE /api/harness-links/:id` and `/api/harness-shares/:id`: Share publishing a link or an
 *   invitation, answered 200; what a node sends to one of Share's observers (`observer:` connections) is
 *   kept in `targeted`, so a test can open what Share sealed for it.
 *
 * Everything else is answered 404. Requests are recorded in `seen`, so a test can say what was asked.
 *
 * And it can misbehave, as a relay under stress does: every socket dropped at once, down for a while,
 * restarted on the same port, seconds of latency on what it relays, garbage or an old sealed frame
 * injected towards a machine or a phone. What each web client sent is kept, sealed, so a test can
 * replay it; so is what reached each one.
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

/** One web socket (a phone, a browser): bound to at most one machine at a time, under one connection id. */
interface WebClient {
  ws: WebSocket
  connId: string
  machineId: string | null
}

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
  private readonly webClients = new Set<WebClient>()
  /** The tokens a phone or a browser of this account signs in to the web socket with. */
  private readonly userTokens = new Set<string>()
  private readonly wss = new WebSocketServer({ noServer: true, handleProtocols: (protocols) => [...protocols][0] ?? false })
  private generation = 0
  /** Down: every new connection is refused, as a backend that is not there. */
  private down = false
  /** How long everything relayed between a machine and its web clients is held, ms. */
  latencyMs = 0
  /** What each web client sent towards its machine, as sent (sealed), by connection id. */
  readonly webSent = new Map<string, Frame[]>()
  /** What reached each web client from its machine, as relayed (sealed), by connection id. */
  readonly webReceived = new Map<string, Frame[]>()
  /** What each device socket (a daemon's lane to its other machines) sent towards a machine, as sent. */
  readonly deviceSent: Frame[] = []
  /** What a node sent to a connection that is neither a device's nor a web client's (Share's observers), by id. */
  readonly targeted = new Map<string, Frame[]>()

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
      if (backend.down) { res.statusCode = 503; res.end(json({ success: false, error: { code: 'UNAVAILABLE' } })); return }
      if (!machine) { res.statusCode = 401; res.end(json({ success: false, error: { code: 'UNAUTHORIZED' } })); return }
      if (req.method === 'GET' && req.url?.split('?')[0] === '/api/machines') {
        res.end(json({ success: true, data: { machines: backend.rows() } }))
        return
      }
      if ((req.method === 'PUT' || req.method === 'DELETE') && /^\/api\/harness-(links|shares)\/[^/?]+$/.test(req.url?.split('?')[0] ?? '')) {
        req.resume()
        res.end(json({ success: true, data: {} }))
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

  /** A phone or a browser of this account: the token it opens the web socket with. */
  addUser(token: string): void {
    this.userTokens.add(token)
  }

  /** The web clients bound to a machine now, by connection id. */
  webConnections(machineId: string): string[] {
    return [...this.webClients].filter((client) => client.machineId === machineId && client.ws.readyState === WebSocket.OPEN).map((client) => client.connId)
  }

  // ── a relay under stress ────────────────────────────────────────────────────────────────────

  /** Every socket dropped at once, with no close frame: what a relay going away looks like to both ends. */
  dropAll(): void {
    for (const client of this.wss.clients) client.terminate()
  }

  /** Down: every socket dropped and every new connection refused, until `comeUp`. */
  goDown(): void {
    this.down = true
    this.dropAll()
  }

  comeUp(): void {
    this.down = false
  }

  /** The backend process restarting: everything it knew about connections goes, nothing answers for
   *  `gapMs`, and it listens again on the same port. */
  async restart(gapMs: number): Promise<void> {
    this.dropAll()
    this.nodes.clear()
    this.devices.clear()
    this.connOwners.clear()
    this.webClients.clear()
    await new Promise<void>((done) => this.server.close(() => done()))
    await new Promise((done) => setTimeout(done, gapMs))
    await new Promise<void>((done, fail) => {
      this.server.once('error', fail)
      this.server.listen(this.port, '127.0.0.1', () => { this.server.off('error', fail); done() })
    })
  }

  /** A frame (or raw bytes) down to a machine's node as if a web client had sent it under `connId`:
   *  what a relay replaying or corrupting traffic does. False when the node is not connected. */
  injectDown(machineId: string, connId: string, frame: Frame | string): boolean {
    const ws = this.nodes.get(machineId)
    if (ws?.readyState !== WebSocket.OPEN) return false
    ws.send(typeof frame === 'string' ? frame : json({ t: 'down', connId, frame }))
    return true
  }

  /** A frame (or raw bytes) to one web client as if its machine had sent it. False when it is gone. */
  injectUp(connId: string, frame: Frame | string): boolean {
    const client = [...this.webClients].find((candidate) => candidate.connId === connId)
    if (client?.ws.readyState !== WebSocket.OPEN) return false
    client.ws.send(typeof frame === 'string' ? frame : json(frame))
    return true
  }

  /** Later by `latencyMs`, in order: equal delays fire in the order they were set. */
  private relay(run: () => void): void {
    if (this.latencyMs > 0) setTimeout(run, this.latencyMs)
    else run()
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
    if (!token) return undefined
    const machine = [...this.machines.values()].find((m) => m.token === token)
    // A phone's token is the account's, not a machine's: it may open the web socket and nothing else.
    if (!machine && this.userTokens.has(token)) return { machineId: '', computerId: '', name: 'phone', token }
    return machine
  }

  private upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(req.url ?? '/', this.httpUrl)
    this.seen.push(`WS ${url.pathname}`)
    const machine = this.byToken(req)
    const refuse = (status: number, text: string): void => {
      socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
    }
    if (this.down) { refuse(503, 'Service Unavailable'); return }
    if (!machine) { refuse(401, 'Unauthorized'); return }
    if (url.pathname === '/api/web-ws') {
      this.wss.handleUpgrade(req, socket, head, (ws) => this.attachWeb(ws))
      return
    }
    if (!machine.machineId) { refuse(403, 'Forbidden'); return }
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
    this.toWebClients(machine.machineId, { type: 'node_status', payload: { online: true } })
    ws.on('message', (raw, binary) => { if (!binary) this.fromNode(machine.machineId, raw) })
    ws.on('close', () => {
      if (this.nodes.get(machine.machineId) !== ws) return
      this.nodes.delete(machine.machineId)
      this.toWebClients(machine.machineId, { type: 'node_status', payload: { online: false, reason: 'node offline' } })
    })
  }

  private fromNode(machineId: string, raw: RawData): void {
    let envelope: { t?: string; targetConnId?: string; commanderEligible?: boolean; webEligible?: boolean; frame?: Frame }
    try { envelope = JSON.parse(raw.toString()) } catch { return }
    if (envelope.t !== 'up' || !envelope.frame) return
    const tagged = { ...envelope.frame, machineId }
    if (envelope.targetConnId) {
      const owner = this.connOwners.get(envelope.targetConnId)
      if (owner?.machineId === machineId) this.sendDevice(owner.device, tagged)
      const web = [...this.webClients].find((client) => client.connId === envelope.targetConnId && client.machineId === machineId)
      if (web) this.toWeb(web, envelope.frame)
      if (!owner && !web) this.targeted.set(envelope.targetConnId, [...(this.targeted.get(envelope.targetConnId) ?? []), envelope.frame])
      return
    }
    if (envelope.commanderEligible) for (const device of this.devices) this.sendDevice(device, tagged)
    // The real hub: web clients get every broadcast that is not device-only.
    if (envelope.webEligible !== false) this.toWebClients(machineId, envelope.frame)
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

  // ── web clients (phones, browsers) ───────────────────────────────────────────────────────────

  private attachWeb(ws: WebSocket): void {
    const client: WebClient = { ws, connId: `web:${randomUUID()}`, machineId: null }
    this.webClients.add(client)
    ws.send(json({ type: 'connected', payload: { userId: 'e2e-user' } }))
    ws.on('message', (raw, binary) => { if (!binary) this.fromWeb(client, raw) })
    ws.on('close', () => {
      this.webClients.delete(client)
      const machineId = client.machineId
      if (machineId) this.relay(() => this.sendNode(machineId, client.connId, { type: '__client_disconnected', payload: {} }))
    })
  }

  private fromWeb(client: WebClient, raw: RawData): void {
    let frame: Frame
    try { frame = JSON.parse(raw.toString()) as Frame } catch { return }
    const type = frame.type ?? ''
    // The backend's own frames are never a client's to send, as the real hub refuses them.
    if (type.startsWith('__')) return
    if (type === 'machine_select') {
      const machineId = String(frame.payload?.machineId ?? '')
      if (!this.machines.has(machineId)) {
        client.ws.send(json({ type: 'machine_select_error', payload: { machineId, error: 'NOT_YOUR_MACHINE' } }))
        return
      }
      client.machineId = machineId
      client.ws.send(json({ type: 'connected', payload: { machineId, p2p: null } }))
      client.ws.send(json({ type: 'node_status', payload: { online: this.nodeUp(machineId) } }))
      return
    }
    const machineId = client.machineId
    if (!machineId) return
    const sent = this.webSent.get(client.connId) ?? []
    sent.push(frame)
    this.webSent.set(client.connId, sent)
    // Never answered when the node is not there, as the real hub's would not be.
    this.relay(() => this.sendNode(machineId, client.connId, frame))
  }

  private toWebClients(machineId: string, frame: Frame): void {
    for (const client of this.webClients) if (client.machineId === machineId) this.toWeb(client, frame)
  }

  private toWeb(client: WebClient, frame: Frame): void {
    const received = this.webReceived.get(client.connId) ?? []
    received.push(frame)
    this.webReceived.set(client.connId, received)
    this.relay(() => { if (client.ws.readyState === WebSocket.OPEN) client.ws.send(json(frame)) })
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
    this.deviceSent.push(frame)
    if (connId) this.sendNode(machineId, connId, frame)
  }

  private sendDevice(device: Device, frame: Frame): void {
    if (device.ws.readyState === WebSocket.OPEN) device.ws.send(json(frame))
  }
}
