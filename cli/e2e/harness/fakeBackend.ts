/**
 * The Harness backend, faked on 127.0.0.1, for a fleet of isolated daemons signed in to one account:
 * enough of its control plane and relay for two machines to find and reach each other, and nothing
 * that leaves this machine.
 *
 * - `GET /api/machines`: the account's machines, each `running` or `offline` as the test says.
 * - `GET /api/agent-messages`: the account's tabs and who is in each, as the test sets them.
 * - `PATCH /api/agent-messages/tabs/:id`: one tab's old Agent Messages flag turned, as an older window turns it
 *   through its daemon; no daemon reads it now (the account's experiment decides).
 * - `GET`/`PATCH /api/experimental-settings`: the account's experiments, every one off until turned on, as the test
 *   or a daemon turns them; a change is `desk_changed` to every node, as the real backend publishes it.
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
 * - Machines of more than one account (`FakeMachine.account`, `email`), and a whole machine shared across
 *   them as the real backend does it (backend routes/machineShares.ts, lib/machineAccess.ts):
 *   `GET`/`PUT /api/machines/:id/share`, `GET /api/machine-shares`, `POST`/`DELETE /api/machine-shares/:id/add`,
 *   `sharedMachines` beside each account's own in `GET /api/machines`, and `machine_select` on the web socket
 *   allowed for a machine shared with the account. A change is `machines_changed` to the nodes it concerns,
 *   and a web socket on a machine no longer shared with its account is closed (4403).
 *
 * - The account's device key log, once a test turns it on (`enableDeviceLog`), as the real backend keeps
 *   it (backend lib/deviceKeyLog.ts): `GET /api/device-keys?since=`, a machine's `devlog_append` over its
 *   own socket (its own key only), and `device_keys_changed` to every node after each change. Beside it,
 *   the acknowledgements ("It's mine", lib/e2ee/deviceAck.ts): `GET`/`POST /api/device-keys/acks`,
 *   checked as the real one checks them — or, with `deviceAcks` off, a backend from before them (404).
 *   Off, every one of these is a 404, as before.
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
import { decodeTerminalHop, encodeTerminalHop, parseTerminalBinaryEnvelope, TerminalHopDirection } from '../../src/lib/terminalBinary.js'
import { checkDevAck } from '../../src/lib/e2ee/deviceAck.js'
import { applyDevLogEntries, DevLogError, emptyDevLogState, type DevLogEntry, type DevLogHead, type DevLogState } from '../../src/lib/e2ee/deviceLog.js'

/** The account every machine and phone of a fake backend belongs to, as its device key log names it. */
export const FAKE_ACCOUNT = 'e2e-user'

export interface FakeMachine {
  machineId: string
  computerId: string
  name: string
  /** The access token this machine's daemon signs in with. */
  token: string
  /** The account it is on, FAKE_ACCOUNT unless a test says, and that account's address. */
  account?: string
  email?: string
  /** Its E2EE identity, as its account's device key log would name it: what sharing hands the other side. */
  pub?: string
}

/** A whole machine its owner shares (backend `MachineShare`): addresses, and the owner's domain when on. */
interface FakeShare { emails: string[]; domain: string | null }

const accountOf = (machine: FakeMachine): string => machine.account ?? FAKE_ACCOUNT
const emailOf = (machine: FakeMachine): string => machine.email ?? `${accountOf(machine)}@example.com`
const domainOf = (email: string): string => email.slice(email.lastIndexOf('@') + 1)

type Frame = { type?: string; machineId?: string; agentId?: string; payload?: Record<string, unknown>; [key: string]: unknown }

/** One web socket (a phone, a browser): bound to at most one machine at a time, under one connection id. */
interface WebClient {
  ws: WebSocket
  connId: string
  machineId: string | null
  /** Who opened it: a machine's daemon (its account's), or a phone of FAKE_ACCOUNT. */
  by: FakeMachine
}

/** One device socket: a commander on every machine of the account, one connection id per machine. */
interface Device {
  ws: WebSocket
  selected: string
  conns: Map<string, string>
}

const json = (value: unknown): string => JSON.stringify(value)
const bytes = (raw: RawData): Uint8Array => new Uint8Array(Array.isArray(raw) ? Buffer.concat(raw) : raw instanceof ArrayBuffer ? raw : Buffer.from(raw))

export class FakeBackend {
  /** Optional Super Tab control-plane fixture. Native creation, input and relay
   * still go through the real daemon; database policy has its own integration suite. */
  superTabs: ((method: string, path: string, body: Record<string, any>, machine: FakeMachine) => Promise<{
    status?: number; data?: unknown; error?: { code: string; message: string }
  }>) | null = null
  /** Opt-in fixture: older scenarios keep the endpoint absent, as on an older backend. */
  productUsage: { enabled: boolean; revision: number; reports: Record<string, unknown>[]; stallReports?: boolean } | null = null
  /** `POST /api/route/jev`, Harness's hosted Jev. Unset answers 503 JEV_BUSY, which callers treat as unavailable. */
  jev: ((body: Record<string, any>) => Record<string, unknown>) | null = null
  readonly seen: string[] = []
  /** What `GET /api/agent-messages` answers: the account's tabs and who is in each; null, a 404. */
  agentMessages: Record<string, unknown> | null = null
  /** The account's experiments (backend lib/experimentalSettings.ts): off until turned on. `setExperiment` turns one as
   *  another computer would, telling every node. */
  readonly experiments: Record<string, boolean> = {}
  private experimentsRevision = 0
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
  /** The account's device key log and the acknowledgements beside it; null until `enableDeviceLog`. */
  deviceLog: { entries: DevLogEntry[]; state: DevLogState; acks: unknown[] } | null = null
  /** Off: a backend from before acknowledgements — their routes answer 404. */
  deviceAcks = true
  /** Machines shared across accounts, by machine id, and who added one shared with their domain. */
  readonly shares = new Map<string, FakeShare>()
  readonly shareAdds = new Set<string>()

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
      if (backend.superTabs && req.url?.startsWith('/api/super-tabs')) {
        const handler = backend.superTabs
        let raw = ''
        req.on('data', chunk => { raw += chunk })
        req.on('end', () => {
          void Promise.resolve().then(() => handler(req.method!, req.url!, JSON.parse(raw || '{}'), machine)).then(result => {
            res.statusCode = result.status ?? 200
            res.end(json({ success: !result.error, data: result.data, error: result.error }))
          }, error => { res.statusCode = 500; res.end(json({ success: false, error: { code: 'FIXTURE', message: String(error) } })) })
        })
        return
      }
      const usage = backend.productUsage
      if (usage && req.url === '/api/product-usage/settings' && req.method === 'GET') {
        res.end(json({ success: true, data: { enabled: usage.enabled, revision: usage.revision } })); return
      }
      if (usage && req.method === 'POST' && ['/api/product-usage/settings', '/api/product-usage/report'].includes(req.url ?? '')) {
        if (usage.stallReports && req.url === '/api/product-usage/report') { req.resume(); return }
        let body = ''
        req.on('data', chunk => { body += String(chunk) })
        req.on('end', () => {
          const parsed = JSON.parse(body) as Record<string, unknown>
          if (req.url === '/api/product-usage/settings') {
            usage.enabled = parsed.enabled === true; usage.revision++
            res.end(json({ success: true, data: { enabled: usage.enabled, revision: usage.revision } }))
          } else if (!usage.enabled || parsed.revision !== usage.revision) {
            res.end(json({ success: true, data: { accepted: false, reason: 'CHOICE_CHANGED' } }))
          } else {
            usage.reports.push(parsed)
            res.end(json({ success: true, data: { accepted: true } }))
          }
        })
        return
      }
      if (req.method === 'GET' && req.url?.split('?')[0] === '/api/machines') {
        res.end(json({ success: true, data: { machines: backend.rows(accountOf(machine)), sharedMachines: backend.sharedRows(machine) } }))
        return
      }
      if (backend.sharesRoute(req, res, machine)) return
      if (req.method === 'GET' && req.url?.split('?')[0] === '/api/agent-messages' && backend.agentMessages) {
        res.end(json({ success: true, data: backend.agentMessages }))
        return
      }
      // A tab's switch, as the window turns it through its daemon: that tab's flag in what the test set.
      const tabSwitch = req.method === 'PATCH' ? /^\/api\/agent-messages\/tabs\/([^/?]+)$/.exec(req.url?.split('?')[0] ?? '') : null
      if (tabSwitch && backend.agentMessages) {
        let raw = ''
        req.on('data', (chunk) => { raw += chunk })
        req.on('end', () => {
          const tab = (backend.agentMessages!.tabs as Array<Record<string, unknown>>).find((t) => t.id === tabSwitch[1])
          const enabled = (JSON.parse(raw || '{}') as { enabled?: unknown }).enabled
          if (!tab || typeof enabled !== 'boolean') { res.statusCode = 404; res.end(json({ success: false, error: { code: 'NOT_FOUND' } })); return }
          tab.enabled = enabled
          res.end(json({ success: true, data: { tabId: tab.id, enabled } }))
        })
        return
      }
      if (req.url?.split('?')[0] === '/api/route/jev' && req.method === 'POST') {
        let raw = ''
        req.on('data', (chunk) => { raw += chunk })
        req.on('end', () => {
          if (!backend.jev) { res.statusCode = 503; res.end(json({ success: false, error: { code: 'JEV_BUSY', message: 'Fixture Jev is off.' } })); return }
          const body = JSON.parse(raw || '{}') as Record<string, any>
          // As the real route validates it (backend routes/jevRoute.ts): `state` is a record of strings, four keys
          // at most. A fixture that took anything let a state of numbers and objects through for two days, while
          // the real route answered every one of them with a 400 (2026-10-21).
          const state = body.state
          const valid = !!state && typeof state === 'object' && !Array.isArray(state) && Object.keys(state).length <= 4
            && Object.values(state).every((value) => typeof value === 'string')
          if (!valid) { res.statusCode = 400; res.end(json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid input: state is a record of at most four strings' } })); return }
          res.end(json({ success: true, data: { answers: backend.jev(body) } }))
        })
        return
      }
      if (req.url?.split('?')[0] === '/api/experimental-settings' && (req.method === 'GET' || req.method === 'PATCH')) {
        if (req.method === 'GET') { res.end(json({ success: true, data: backend.experimentalSettings() })); return }
        let raw = ''
        req.on('data', (chunk) => { raw += chunk })
        req.on('end', () => {
          const body = JSON.parse(raw || '{}') as { accountId?: unknown; feature?: unknown; enabled?: unknown }
          if (body.accountId !== FAKE_ACCOUNT) { res.statusCode = 409; res.end(json({ success: false, error: { code: 'ACCOUNT_CHANGED', message: 'Your account changed.' } })); return }
          if (typeof body.feature !== 'string' || typeof body.enabled !== 'boolean') { res.statusCode = 400; res.end(json({ success: false, error: { code: 'BAD_REQUEST', message: 'bad body' } })); return }
          backend.setExperiment(body.feature, body.enabled)
          res.end(json({ success: true, data: backend.experimentalSettings() }))
        })
        return
      }
      if ((req.method === 'PUT' || req.method === 'DELETE') && /^\/api\/harness-(links|shares)\/[^/?]+$/.test(req.url?.split('?')[0] ?? '')) {
        req.resume()
        res.end(json({ success: true, data: {} }))
        return
      }
      if (backend.deviceLog && backend.deviceKeysRoute(req, res)) return
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

  // ── the device key log ──────────────────────────────────────────────────────────────────────

  /** Serve the account's device key log (and its acknowledgements) from now on, starting empty. */
  enableDeviceLog(): void {
    this.deviceLog = { entries: [], state: emptyDevLogState(FAKE_ACCOUNT), acks: [] }
  }

  /** Append one signed entry as the real backend does — refused when it does not continue the log or
   *  breaks a rule — and tell every node. What a phone's `POST /api/device-keys` does, for a test. */
  appendDeviceEntry(entry: DevLogEntry): { head: DevLogHead } | { error: string; head?: DevLogHead } {
    const log = this.deviceLog
    if (!log) return { error: 'NOT_FOUND' }
    if (entry.seq !== log.state.head.seq + 1 || entry.prev !== log.state.head.hash) return { error: 'STALE_HEAD', head: log.state.head }
    try {
      log.state = applyDevLogEntries(log.state, [entry]).state
    } catch (err) {
      return { error: err instanceof DevLogError ? err.code : 'BAD_ENTRY' }
    }
    log.entries.push(entry)
    this.deviceKeysChanged()
    return { head: log.state.head }
  }

  /** `device_keys_changed` to every node: read the log (and its acknowledgements) again. */
  private deviceKeysChanged(): void {
    const head = this.deviceLog?.state.head
    for (const machineId of this.nodes.keys()) this.sendNode(machineId, '', { type: 'device_keys_changed', payload: { ...head } })
  }

  /** The device key log's routes; false when the request is not one of them. */
  private deviceKeysRoute(req: IncomingMessage, res: import('node:http').ServerResponse): boolean {
    const log = this.deviceLog!
    const url = new URL(req.url ?? '/', this.httpUrl)
    const since = Number(url.searchParams.get('since') ?? 0) || 0
    if (req.method === 'GET' && url.pathname === '/api/device-keys') {
      res.end(json({ success: true, data: { acct: FAKE_ACCOUNT, head: log.state.head, entries: log.entries.filter((e) => e.seq > since) } }))
      return true
    }
    if (url.pathname !== '/api/device-keys/acks' || !this.deviceAcks) return false
    if (req.method === 'GET') {
      const acks = log.acks.filter((a) => (a as { addSeq: number }).addSeq > since)
      res.end(json({ success: true, data: { acks } }))
      return true
    }
    if (req.method !== 'POST') return false
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      let ack: unknown
      try { ack = (JSON.parse(Buffer.concat(chunks).toString()) as { ack?: unknown }).ack } catch { ack = null }
      // Checked as the real backend checks it (backend lib/deviceKeyLog.ts appendDeviceAck).
      const checked = checkDevAck(log.state, ack)
      if (!checked.ok) {
        res.statusCode = 400
        res.end(json({ success: false, error: { code: checked.code } }))
        return
      }
      const fresh = !log.acks.some((a) => (a as { pub: string }).pub === checked.ack.pub && (a as { signer: string }).signer === checked.ack.signer)
      if (fresh) log.acks.push(checked.ack)
      res.end(json({ success: true, data: { created: fresh } }))
      if (fresh) this.deviceKeysChanged()
    })
    return true
  }

  /** A machine's own append to the log, over its socket: only about itself, as the real backend allows. */
  private devlogAppend(machineId: string, payload: Record<string, unknown> | undefined): void {
    const requestId = typeof payload?.requestId === 'string' ? payload.requestId : ''
    const entry = payload?.entry as DevLogEntry | undefined
    const signer = entry && this.deviceLog?.state.active[entry.signer]
    const own = !!entry && (entry.op === 'add' ? entry.kind === 'machine' && entry.machineId === machineId : signer?.kind === 'machine' && signer.machineId === machineId)
    const answer = !entry ? { error: 'BAD_ENTRY' } : !own ? { error: 'WRONG_CHANNEL' } : this.appendDeviceEntry(entry)
    this.sendNode(machineId, '', { type: 'devlog_append_result', payload: { requestId, ...answer } })
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

  private rows(account = FAKE_ACCOUNT): Array<Record<string, unknown>> {
    return [...this.machines.values()].filter((m) => accountOf(m) === account).map((m) => ({
      machineId: m.machineId, computerId: m.computerId, name: m.name, hostname: m.name,
      status: this.online.get(m.machineId) ? 'running' : 'offline', authMode: 'remote',
    }))
  }

  // ── machines shared across accounts ─────────────────────────────────────────────────────────

  /** How `machineId`'s share reaches `who`: named, at the owner's domain, or not at all. */
  private sharedVia(machineId: string, who: FakeMachine): 'email' | 'domain' | null {
    const share = this.shares.get(machineId)
    const owner = this.machines.get(machineId)
    if (!share || !owner || accountOf(owner) === accountOf(who)) return null
    const email = emailOf(who)
    if (share.emails.includes(email)) return 'email'
    return share.domain && domainOf(email) === share.domain ? 'domain' : null
  }

  /** Whether `who` may select `machineId`: its account's own, or shared with it (a domain share once added). */
  mayUse(machineId: string, who: FakeMachine): boolean {
    const target = this.machines.get(machineId)
    if (!target) return false
    if (accountOf(target) === accountOf(who)) return true
    const via = this.sharedVia(machineId, who)
    return via === 'email' || (via === 'domain' && this.shareAdds.has(`${machineId}:${accountOf(who)}`))
  }

  private sharedRows(who: FakeMachine): Array<Record<string, unknown>> {
    return [...this.machines.values()].flatMap((m) => {
      const via = this.sharedVia(m.machineId, who)
      if (!via) return []
      return [{ machineId: m.machineId, name: m.name, hostname: m.name, authMode: 'remote', pub: m.pub ?? null,
        status: this.online.get(m.machineId) ? 'running' : 'offline',
        share: { ownerName: accountOf(m), ownerEmail: emailOf(m), via, added: this.mayUse(m.machineId, who) } }]
    })
  }

  /** The accounts that may use `machineId` now, with their machines' keys: what its daemon trusts. */
  private shareMembers(machineId: string): Array<Record<string, unknown>> {
    const accounts = new Map<string, FakeMachine[]>()
    for (const m of this.machines.values()) {
      if (!this.mayUse(machineId, m) || accountOf(m) === accountOf(this.machines.get(machineId)!)) continue
      accounts.set(accountOf(m), [...accounts.get(accountOf(m)) ?? [], m])
    }
    return [...accounts.values()].map((ms) => ({
      email: emailOf(ms[0]), name: accountOf(ms[0]), via: this.sharedVia(machineId, ms[0]),
      machines: ms.filter((m) => m.pub).map((m) => ({ machineId: m.machineId, name: m.name, pub: m.pub })),
    }))
  }

  /** `machines_changed` to every node of every account, and a web socket that may no longer use its machine closed. */
  private sharesChanged(): void {
    for (const machineId of this.nodes.keys()) this.sendNode(machineId, '', { type: 'machines_changed', payload: { reason: 'updated' } })
    for (const client of this.webClients) if (client.machineId && !this.mayUse(client.machineId, client.by)) client.ws.close(4403, 'Sharing ended')
  }

  /** The share routes; false when the request is not one of them. */
  private sharesRoute(req: IncomingMessage, res: import('node:http').ServerResponse, who: FakeMachine): boolean {
    const path = req.url?.split('?')[0] ?? ''
    const policy = /^\/api\/machines\/([^/]+)\/share$/.exec(path)
    const add = /^\/api\/machine-shares\/([^/]+)\/add$/.exec(path)
    if (req.method === 'GET' && path === '/api/machine-shares') {
      res.end(json({ success: true, data: { machines: this.sharedRows(who) } }))
      return true
    }
    if (policy && (req.method === 'GET' || req.method === 'PUT')) {
      const machineId = policy[1]
      const owned = this.machines.get(machineId)
      if (!owned || accountOf(owned) !== accountOf(who)) { res.statusCode = 404; res.end(json({ success: false, error: { code: 'NOT_FOUND' } })); return true }
      const view = (): Record<string, unknown> => {
        const share = this.shares.get(machineId)
        return { emails: share?.emails ?? [], sameDomain: !!share?.domain, domain: domainOf(emailOf(who)), members: share ? this.shareMembers(machineId) : [] }
      }
      if (req.method === 'GET') { res.end(json({ success: true, data: view() })); return true }
      let raw = ''
      req.on('data', (chunk) => { raw += chunk })
      req.on('end', () => {
        const body = JSON.parse(raw || '{}') as { emails?: string[]; sameDomain?: boolean }
        const emails = (body.emails ?? []).map((e) => e.trim().toLowerCase()).filter((e) => e !== emailOf(who))
        if (!emails.length && !body.sameDomain) {
          this.shares.delete(machineId)
          for (const key of [...this.shareAdds]) if (key.startsWith(`${machineId}:`)) this.shareAdds.delete(key)
        } else this.shares.set(machineId, { emails, domain: body.sameDomain ? domainOf(emailOf(who)) : null })
        res.end(json({ success: true, data: view() }))
        this.sharesChanged()
      })
      return true
    }
    if (add && (req.method === 'POST' || req.method === 'DELETE')) {
      const machineId = add[1]
      const key = `${machineId}:${accountOf(who)}`
      if (req.method === 'POST') {
        if (!this.sharedVia(machineId, who)) { res.statusCode = 404; res.end(json({ success: false, error: { code: 'NOT_SHARED', message: 'This machine is not shared with you.' } })); return true }
        this.shareAdds.add(key)
        res.end(json({ success: true, data: { added: true } }))
      } else {
        const removed = this.shareAdds.delete(key)
        res.end(json({ success: true, data: { removed } }))
      }
      this.sharesChanged()
      return true
    }
    return false
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
      this.wss.handleUpgrade(req, socket, head, (ws) => this.attachWeb(ws, machine))
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
    ws.on('message', (raw, binary) => {
      if (binary) this.fromNodeBinary(machine.machineId, raw)
      else this.fromNode(machine.machineId, raw)
    })
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
    // The backend's own business, answered to this machine alone: never relayed.
    if (envelope.frame.type === 'devlog_append' && this.deviceLog) { this.devlogAppend(machineId, envelope.frame.payload); return }
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

  /** The real hub strips only the hop header; the terminal body stays sealed.
   * UUID connection ids matter: the binary hop cannot encode a prefixed test id. */
  private fromNodeBinary(machineId: string, raw: RawData): void {
    const hop = decodeTerminalHop(bytes(raw))
    if (!hop || hop.direction !== TerminalHopDirection.up) return
    const client = [...this.webClients].find(c => c.connId === hop.connId && c.machineId === machineId)
    if (client) this.relay(() => {
      if (client.ws.readyState === WebSocket.OPEN) client.ws.send(hop.clientFrame)
    })
  }

  /** The account's experiments as `GET /api/experimental-settings` answers them. */
  experimentalSettings(): Record<string, unknown> {
    const features = { focus_bar_creature: false, share_button: false, devices_tab: false, agents_start_agents: false, agent_pull_request_line: false, agent_messages: false, ...this.experiments }
    return { accountId: FAKE_ACCOUNT, revision: this.experimentsRevision, features, available: Object.fromEntries(Object.keys(features).map((name) => [name, true])) }
  }

  /** Turns an experiment of the account, as Settings ▸ Experimental on any computer does: every node hears `desk_changed`. */
  setExperiment(feature: string, enabled: boolean): void {
    this.experiments[feature] = enabled
    this.experimentsRevision++
    for (const machineId of this.nodes.keys()) this.sendNode(machineId, '', { type: 'desk_changed', payload: { revision: 0 } })
  }

  /** Renames one of the account's machines, as the Machines list on any computer does: every node hears `machines_changed`. */
  renameMachine(machineId: string, name: string): void {
    const machine = this.machines.get(machineId)
    if (machine) machine.name = name
    for (const node of this.nodes.keys()) this.sendNode(node, '', { type: 'machines_changed', payload: { reason: 'renamed' } })
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

  private attachWeb(ws: WebSocket, by: FakeMachine): void {
    const client: WebClient = { ws, connId: randomUUID(), machineId: null, by }
    this.webClients.add(client)
    ws.send(json({ type: 'connected', payload: { userId: accountOf(by) } }))
    ws.on('message', (raw, binary) => {
      if (binary) this.fromWebBinary(client, raw)
      else this.fromWeb(client, raw)
    })
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
      if (!this.mayUse(machineId, client.by)) {
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

  private fromWebBinary(client: WebClient, raw: RawData): void {
    const frame = bytes(raw)
    if (!client.machineId || !parseTerminalBinaryEnvelope(frame)) return
    const packet = encodeTerminalHop(TerminalHopDirection.down, client.connId, frame)
    const node = this.nodes.get(client.machineId)
    if (packet) this.relay(() => { if (node?.readyState === WebSocket.OPEN) node.send(packet) })
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
