/**
 * The WebSocket roadmap's scenario (Ken, 2026-10-28): what one account's clients do to the backend's
 * sockets for a few minutes, measured by a recording proxy (socketMeter.ts) that every client dials
 * instead of the backend. Nothing here reaches beyond this machine: a real backend on local Mongo and
 * Redis with a fake sign-in (realBackend.ts), and every daemon in its own home on its own port.
 *
 * The account has four machines:
 * - A and B, two signed-in daemons. A pinned B when it linked to it; B trusts A back.
 * - X, deleted, still pinned on A: what a machine removed in the app leaves on a computer that linked it.
 * - Y, never online, pinned on A: a computer that is off.
 *
 * Two clients, each a model of today's app, not of the fix:
 * - A Desktop on A (`DesktopWindow`): a window per machine on A's local socket, redialling as
 *   desktop/lib/ws/ws_conn.dart does on a relayed machine, so every select of B, X and Y has A dial the
 *   backend's web-ws.
 * - A browser tab (`WebTab`): its own web-ws with `client=web`, bound to B end to end, as the web build
 *   dials it.
 *
 * ⚠️ A Phase 0 or Phase 1 change to what the Desktop or the web build puts on the wire (a version on
 * the URL, when it stops redialling) changes the model here in the same pull request: the model is what
 * makes this scenario say anything about those clients.
 */
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import WebSocket from 'ws'
import { b64e, newIdentity, type Identity } from '../../src/lib/e2ee/core.js'
import { RelaySessionCrypto } from '../../src/lib/e2ee/relayClient.js'
import { IsolatedDaemon, until } from './daemon.js'
import { writeE2ee } from './fleet.js'
import { account, startRealBackend, type Account, type RealBackend } from './realBackend.js'
import { SocketMeter, type MeterReport, type SocketRecord } from './socketMeter.js'

/** desktop/lib/ws/ws_conn.dart `reconnectDelay`: a window doubling from 1 s to 30 s, the wait in its second half. */
export function reconnectDelay(attempt: number, random = Math.random): number {
  const exponent = Math.min(Math.max(attempt - 1, 0), 5)
  const window = Math.min(30_000, 1000 * (1 << exponent))
  return Math.floor(window / 2) + Math.round(random() * (window / 2))
}

/** ws_conn.dart `connectionStableAfter`: a socket up this long starts its next backoff over. */
const STABLE_AFTER_MS = 60_000

/**
 * One Desktop window on a relayed machine, as ws_conn.dart runs it over the local daemon: select on
 * open, ready on the daemon's `connected`, and on any close but 4404 (the machine needs a link) redial
 * after `reconnectDelay`.
 */
export class DesktopWindow {
  dials = 0
  private attempt = 0
  private ws: WebSocket | null = null
  private retry: NodeJS.Timeout | null = null
  private stable: NodeJS.Timeout | null = null
  private closing = false
  stoppedBy: number | null = null

  constructor(private readonly daemon: IsolatedDaemon, readonly machineId: string) {}

  open(): void {
    if (this.closing) return
    this.dials++
    const ws = new WebSocket(`ws+unix://${this.daemon.socketPath}:/api/local-ws`)
    this.ws = ws
    ws.on('error', () => { /* 'close' follows */ })
    ws.on('open', () => ws.send(JSON.stringify({ type: 'machine_select', payload: { machineId: this.machineId, localProtocolVersion: 1 } })))
    ws.on('message', (raw, binary) => {
      if (binary) return
      let frame: { type?: string }
      try { frame = JSON.parse(raw.toString()) } catch { return }
      if (frame.type === 'connected') {
        if (this.stable) clearTimeout(this.stable)
        this.stable = setTimeout(() => { this.attempt = 0 }, STABLE_AFTER_MS)
      }
    })
    ws.on('close', (code) => {
      if (this.stable) clearTimeout(this.stable)
      this.stable = null
      if (this.closing) return
      if (code === 4404) { this.stoppedBy = code; return }
      this.attempt++
      this.retry = setTimeout(() => this.open(), reconnectDelay(this.attempt))
    })
  }

  close(): void {
    this.closing = true
    if (this.retry) clearTimeout(this.retry)
    if (this.stable) clearTimeout(this.stable)
    this.ws?.terminate()
  }
}

/**
 * A browser tab on machine `machineId`: web-ws with `client=web` (ws_conn.dart's query), select, then the
 * end-to-end hello a paired browser sends. Redials like a window; 4403 stops it, as a sign-in for
 * another environment does.
 */
export class WebTab {
  dials = 0
  sessions = 0
  private attempt = 0
  private ws: WebSocket | null = null
  private retry: NodeJS.Timeout | null = null
  private stable: NodeJS.Timeout | null = null
  private closing = false

  constructor(private readonly options: { wsUrl: string; token: string; machineId: string; identity: Identity; machinePub: Uint8Array }) {}

  open(): void {
    if (this.closing) return
    this.dials++
    const { wsUrl, token, machineId, identity, machinePub } = this.options
    const ws = new WebSocket(`${wsUrl}/api/web-ws?autonomousEnv=prod&client=web`, [token])
    this.ws = ws
    const crypto = new RelaySessionCrypto({ machineId, selfIdentity: identity, peerPub: machinePub, groupSeen: new Map() })
    ws.on('error', () => { /* 'close' follows */ })
    ws.on('open', () => ws.send(JSON.stringify({ type: 'machine_select', payload: { machineId } })))
    ws.on('message', (raw, binary) => {
      if (binary || crypto.ready) return
      let frame: { type?: string; payload?: Record<string, any> }
      try { frame = JSON.parse(raw.toString()) } catch { return }
      if (frame.type === 'connected' && frame.payload?.machineId === machineId) ws.send(JSON.stringify(crypto.helloFrame()))
      else if (frame.type === 'e2e_welcome' && crypto.handleWelcome(frame.payload ?? {})) {
        this.sessions++
        if (this.stable) clearTimeout(this.stable)
        this.stable = setTimeout(() => { this.attempt = 0 }, STABLE_AFTER_MS)
      }
    })
    ws.on('close', (code) => {
      if (this.stable) clearTimeout(this.stable)
      this.stable = null
      if (this.closing || code === 4403) return
      this.attempt++
      this.retry = setTimeout(() => this.open(), reconnectDelay(this.attempt))
    })
  }

  close(): void {
    this.closing = true
    if (this.retry) clearTimeout(this.retry)
    if (this.stable) clearTimeout(this.stable)
    this.ws?.terminate()
  }
}

export interface ScenarioResult {
  report: MeterReport
  /** Every socket the meter saw, for checks the report does not sum up. */
  sockets: SocketRecord[]
  machines: { a: string; b: string; deleted: string; offline: string }
  /** The backend's own log, for a failing test to point at. */
  backendLog: string
}

async function resolveMachine(backend: RealBackend, who: Account, label: string): Promise<{ machineId: string; computerId: string }> {
  const computerId = randomUUID()
  const r = await backend.api(who, '/api/machines/resolve-computer', 'POST', { computerId, label })
  if (r.status !== 200) throw new Error(`resolve-computer ${label}: ${r.status}`)
  return { machineId: r.body.data.machine.machineId as string, computerId }
}

/** A daemon signed in as `who` on machine `machine`, dialling the backend through the meter. */
async function machineDaemon(meter: SocketMeter, who: Account, machine: { machineId: string; computerId: string },
  e2ee: Record<string, unknown>): Promise<IsolatedDaemon> {
  const daemon = await IsolatedDaemon.create({ env: {
    ADAPTER_COMPUTER_ID: machine.computerId, BACKEND_WS_URL: meter.wsUrl, WEB_URL: meter.url,
    HARNESSD_SERVICE_INITIAL_BACKOFF_MS: '200' } })
  writeFileSync(join(daemon.root, 'auth/session.json'), JSON.stringify({ version: 1, accessToken: who.token,
    refreshToken: 'x', autonomousEnv: 'prod', computerId: machine.computerId, machineId: machine.machineId,
    expiresAt: Date.now() + 3_600_000, updatedAt: Date.now() }), { mode: 0o600 })
  await writeE2ee(daemon, e2ee)
  return daemon
}

/** Run the scenario for `durationMs` once every client is up, and report what the meter saw over the whole run. */
export async function runSocketScenario(options: { durationMs: number; log?: (line: string) => void }): Promise<ScenarioResult> {
  const log = options.log ?? (() => {})
  const alice = account('alice')
  const stops: Array<() => unknown> = []
  try {
    const backend = await startRealBackend([alice], log)
    stops.push(() => backend.stop())
    const meter = await SocketMeter.start(backend.url)
    stops.push(() => meter.close())

    const [a, b, deleted, offline] = [await resolveMachine(backend, alice, 'machine-a'), await resolveMachine(backend, alice, 'machine-b'),
      await resolveMachine(backend, alice, 'machine-x'), await resolveMachine(backend, alice, 'machine-y')]
    const removed = await backend.api(alice, `/api/machines/${deleted.machineId}`, 'DELETE')
    if (removed.status !== 200) throw new Error(`deleting machine-x: ${removed.status}`)

    const idA = newIdentity(), idB = newIdentity(), tab = newIdentity()
    const linkedAt = Date.now()
    const daemonA = await machineDaemon(meter, alice, a, {
      'identity.json': { priv: b64e(idA.priv), pub: b64e(idA.pub) },
      // Pins as `harness link connect` left them; X's and Y's keys are never used, their selects fail first.
      'machinePeers.json': [
        { machineId: b.machineId, pub: b64e(idB.pub), label: 'machine-b', linkedAt },
        { machineId: deleted.machineId, pub: b64e(newIdentity().pub), label: 'machine-x', linkedAt },
        { machineId: offline.machineId, pub: b64e(newIdentity().pub), label: 'machine-y', linkedAt },
      ],
    })
    stops.push(() => daemonA.close())
    const daemonB = await machineDaemon(meter, alice, b, {
      'identity.json': { priv: b64e(idB.priv), pub: b64e(idB.pub) },
      'paired.json': [
        { identityPub: b64e(idA.pub), label: 'machine-a', pairedAt: linkedAt, role: 'web', machineId: a.machineId, kind: 'machine' },
        { identityPub: b64e(tab.pub), label: 'browser', pairedAt: linkedAt, role: 'web' },
      ],
    })
    stops.push(() => daemonB.close())
    await Promise.all([daemonA.start(), daemonB.start()])
    for (const daemon of [daemonA, daemonB]) {
      await until('daemon connected', async () => (await (await fetch(`http://127.0.0.1:${daemon.port}/api/status`,
        { headers: daemon.localHeaders() })).json() as { connected?: boolean }).connected === true, 60_000, 200)
    }
    log('daemons connected')

    const windows = [b, deleted, offline].map((m) => new DesktopWindow(daemonA, m.machineId))
    const web = new WebTab({ wsUrl: meter.wsUrl, token: alice.token, machineId: b.machineId, identity: tab, machinePub: idB.pub })
    for (const client of [...windows, web]) {
      client.open()
      stops.push(() => client.close())
    }
    await new Promise((resolve) => setTimeout(resolve, options.durationMs))
    log(`windows dialled ${windows.map((w) => `${w.machineId.slice(0, 6)}:${w.dials}${w.stoppedBy ? `(stopped ${w.stoppedBy})` : ''}`).join(' ')}; web ${web.dials} dials, ${web.sessions} sessions`)
    return {
      report: meter.report({ deletedMachineIds: [deleted.machineId] }),
      sockets: meter.sockets,
      machines: { a: a.machineId, b: b.machineId, deleted: deleted.machineId, offline: offline.machineId },
      backendLog: backend.logPath,
    }
  } finally {
    for (const stop of stops.reverse()) await Promise.resolve(stop()).catch(() => {})
  }
}
