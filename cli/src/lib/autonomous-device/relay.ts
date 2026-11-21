import { deviceDump } from './dump.js'
import { type AutonomousDeviceService, type AutonomousDeviceFrame } from './service.js'

type Frame = Record<string, unknown>
export interface DeviceRequestRefusal { code: string; message: string }
export interface DeviceSessionProof { readonly identity: string; readonly incarnation: string }
export interface DeviceRelayProof extends DeviceSessionProof { readonly peerEpoch: string }
export type DeviceRelayReplay = (connId: string, proof: DeviceRelayProof,
  frames: readonly Readonly<AutonomousDeviceFrame>[], allowed: (event: Readonly<AutonomousDeviceFrame>) => boolean,
  helloReply?: Frame) => (() => void) | null
interface DeviceRelayClient { route: DeviceRelayProof; tokens: number; at: number; active: number; pending?: DeviceRelayProof }
/** Application RPC over the existing relay E2EE session. No socket, identity, PAKE or trust of its own. */
export class AutonomousDeviceRelay {
  private readonly clients = new Map<string, DeviceRelayClient>()
  constructor(private readonly session: (connId: string) => DeviceRelayProof | null,
    private readonly send: (connId: string, frame: Frame, proof: DeviceRelayProof) => void,
    private readonly service: AutonomousDeviceService, private readonly machineId: string,
    private readonly replay: DeviceRelayReplay,
    private readonly onReady?: (connId: string, proof: DeviceRelayProof) => void,
    private readonly onRemoteRevoke?: (connId: string, proof: DeviceRelayProof) => void,
    /** Which identity's app said hello on a session, and when it left: the gateway tells such a device it was
     *  unpaired while its session still stands, which an unpairing in the gateway's process cannot wait for
     *  this relay to do (gateway/gateway.ts). Observation only. */
    private readonly onClient?: (connId: string, proof: DeviceRelayProof, hello: boolean) => void,
    /** One shared component snapshot; each existing authenticated client may wait once. */
    private readonly beforeReady?: () => Promise<void>,
    /** Runs only after the existing four-request admission, never before it. */
    private readonly beforeRequest?: (request: Record<string, unknown>) => Promise<void | DeviceRequestRefusal>) {}
  private sameSession(connId: string, proof: DeviceSessionProof): boolean {
    const current = this.session(connId)
    return current?.identity === proof.identity && current.incarnation === proof.incarnation
  }
  private current(connId: string, proof: DeviceRelayProof): boolean {
    const current = this.session(connId)
    return current?.identity === proof.identity && current.incarnation === proof.incarnation && current.peerEpoch === proof.peerEpoch
  }
  count(include: (connId: string) => boolean = () => true): number { return [...this.clients].filter(([id, client]) => include(id) && this.current(id, client.route)).length }
  connected(): boolean { return this.count() > 0 }
  private sendTo(connId: string, proof: DeviceRelayProof, type: string, payload: Frame): void {
    if (!this.current(connId, proof)) return
    deviceDump.record('out', 'rpc', connId, { type, payload })
    this.send(connId, { type, payload }, proof)
  }
  /** The gateway already authenticated and opened this body. Never unwrap or infer its session again. */
  async handle(connId: string, original: DeviceRelayProof, req: Frame): Promise<void> {
    // IPC decoders and callers own their objects. A delayed result owns these scalar facts instead.
    const proof: DeviceRelayProof = { identity: original.identity, incarnation: original.incarnation, peerEpoch: original.peerEpoch }
    if (!this.current(connId, proof)) return
    for (const [id, client] of this.clients) if (!this.sameSession(id, client.route)) this.drop(id, client.route.incarnation)
    const { identity, incarnation } = proof
    if (!req || typeof req !== 'object' || Array.isArray(req)) return
    deviceDump.record('in', 'rpc', connId, { type: 'autonomous_device_request', payload: req })
    const reply = (payload: Frame) => this.sendTo(connId, proof, 'autonomous_device_result', payload)
    if (req.type === 'hello') {
      if (req.proto !== 1 || typeof req.requestId !== 'string') { reply({ type: 'hello_result', requestId: req.requestId, error: { code: 'PROTO_UNSUPPORTED', message: 'Protocol 1 required' } }); return }
      const current = this.clients.get(connId)
      if (current?.route.identity === identity && current.route.incarnation === incarnation && current.pending && this.current(connId, current.pending)) {
        reply({ type: 'hello_result', requestId: req.requestId, error: { code: 'HELLO_PENDING', message: 'Hello is still connecting' } }); return
      }
      const client: DeviceRelayClient = current?.route.identity === identity && current.route.incarnation === incarnation ? current : { route: proof, tokens: 20, at: Date.now(), active: 0 }
      client.route = proof
      client.pending = proof
      this.clients.set(connId, client)
      try { if (this.beforeReady) await this.beforeReady() } catch {
        if (this.clients.get(connId) === client && client.pending === proof) {
          reply({ type: 'hello_result', requestId: req.requestId, error: { code: 'QUESTION_STATE_UNAVAILABLE', message: 'Question state is reconnecting' } })
          this.drop(connId, incarnation)
        }
        return
      }
      if (this.clients.get(connId) !== client || client.pending !== proof || !this.current(connId, proof)) {
        if (this.clients.get(connId) === client && client.pending === proof) this.drop(connId, incarnation)
        return
      }
      const resume = req.resume as { serverInstanceId?: unknown; cursor?: unknown } | undefined
      const hello = { type: 'hello_result', requestId: req.requestId, proto: 1, machineId: this.machineId,
        serverInstanceId: this.service.serverInstanceId, capabilities: this.service.capabilities, ...this.service.resume(resume) }
      const admitted = this.service.replay(resume, frames => {
        const start = this.replay(connId, proof, frames, event => this.allowedEvent(identity, event), hello)
        if (!start) return null
        return () => {
          client.pending = undefined
          // The whole greeting/replay is admitted before either application state or success changes.
          this.service.addons.hello(identity)
          this.onClient?.(connId, proof, true)
          start()
          if (this.current(connId, proof)) this.onReady?.(connId, proof)
        }
      })
      if (!admitted) reply({ type: 'hello_result', requestId: req.requestId, error: { code: 'BACKPRESSURE', message: 'Replay is unavailable' } })
      return
    }
    const client = this.clients.get(connId)
    if (!client || client.route.identity !== identity || client.route.incarnation !== incarnation || client.pending) { reply({ type: `${req.type}_result`, requestId: req.requestId, error: { code: 'HELLO_REQUIRED', message: 'Send application hello first' } }); return }
    // A device deleting its local trust must say so while the authenticated channel still exists.
    // A socket close alone is deliberately only an offline signal: treating it as revocation would
    // unpair users whenever their LAN briefly drops.
    if (req.type === 'pair.revoke') {
      if (typeof req.requestId !== 'string' || Object.keys(req).some(key => key !== 'type' && key !== 'requestId')) {
        reply({ type: 'pair.revoke_result', requestId: req.requestId, error: { code: 'INVALID_REQUEST', message: 'Invalid device revoke request' } })
        return
      }
      reply({ type: 'pair.revoke_result', requestId: req.requestId, revoked: true })
      this.onRemoteRevoke?.(connId, proof)
      return
    }
    const now = Date.now(); client.tokens = Math.min(20, client.tokens + Math.max(0, now - client.at) / 1000); client.at = now
    const error = client.tokens < 1 ? 'RATE_LIMITED' : client.active >= 4 ? 'BACKPRESSURE' : null
    if (error) { reply({ type: `${req.type}_result`, requestId: req.requestId, error: { code: error, message: error } }); return }
    client.tokens--; client.active++
    try {
      const refused = this.beforeRequest ? await this.beforeRequest(req) : undefined
      if (this.clients.get(connId) !== client || !this.current(connId, proof)) return
      reply(refused ? { type: `${req.type}_result`, requestId: req.requestId, error: refused } : await this.service.request(identity, req))
    } finally { client.active-- }
  }
  private sendEvent(connId: string, proof: DeviceRelayProof, event: AutonomousDeviceFrame): void {
    if (this.allowedEvent(proof.identity, event)) this.sendTo(connId, proof, 'autonomous_device_event', event)
  }
  private allowedEvent(identity: string, event: Readonly<AutonomousDeviceFrame>): boolean {
    const p = event.payload as Frame | undefined
    if (event.kind === 'turn.summary' && p?.resultId !== undefined) {
      return this.service.canSendResult(identity, event)
    }
    if (typeof p?.idempotencyKey === 'string') {
      const own = this.service.receipt(identity, p.idempotencyKey)
      const receipt = p.receipt as Frame | undefined
      if (!own || (receipt && receipt.deliveryId !== own.deliveryId) || (p.turnId && p.turnId !== own.turnId)) return false
    }
    return true
  }
  /** `deviceId` set: an agent stream frame, sent to that identity's links and no other. */
  emit(event: AutonomousDeviceFrame, deviceId?: string): void {
    for (const [connId, client] of this.clients) if (!client.pending && (!deviceId || client.route.identity === deviceId)) this.sendEvent(connId, client.route, event)
  }
  /** The sessions whose app said hello, by connection. */
  helloed(): string[] { return [...this.clients].filter(([connId, client]) => !client.pending && this.current(connId, client.route)).map(([connId]) => connId) }
  /** Snapshot absence revokes old hello state; a transport replacement alone does not reset live counters. */
  retain(helloed: readonly (DeviceSessionProof & { connId: string })[]): void {
    for (const [connId, client] of this.clients) if (!helloed.some(hello => hello.connId === connId
      && hello.identity === client.route.identity && hello.incarnation === client.route.incarnation)) this.drop(connId, client.route.incarnation)
  }
  /**
   * A session whose app said hello to this service's previous run: its process restarted, and the gateway
   * kept the session (services/wifi.ts). It is served on, and told to resync, as a hello naming the previous
   * instance is told (docs/autonomous-device-integration.md: the device re-reads its agents and reconciles
   * its outstanding keys by receipt). Nothing for a session this run already serves, or no longer the
   * identity's device.
   */
  restore(connId: string, original: DeviceRelayProof): void {
    const proof: DeviceRelayProof = { identity: original.identity, incarnation: original.incarnation, peerEpoch: original.peerEpoch }
    const { identity, incarnation } = proof
    if (!this.current(connId, proof)) return
    const previous = this.clients.get(connId)
    if (previous?.route.identity === identity && previous.route.incarnation === incarnation) {
      if (previous.route.peerEpoch === proof.peerEpoch) return
      previous.route = proof
      previous.pending = proof
    } else this.clients.set(connId, { route: proof, tokens: 20, at: Date.now(), active: 0, pending: proof })
    const client = this.clients.get(connId)!
    this.service.replay(undefined, frames => {
      const start = this.replay(connId, proof, frames, event => this.allowedEvent(identity, event))
      if (!start) return null
      return () => {
        client.pending = undefined
        this.onClient?.(connId, proof, true)
        start()
        // No hello follows a service restart; its empty add-on state requests publication again.
        this.service.addons.republish(identity)
      }
    })
  }
  drop(connId: string, incarnation: string): void {
    const client = this.clients.get(connId)
    if (client?.route.incarnation !== incarnation) return
    this.clients.delete(connId)
    this.onClient?.(connId, client.route, false)
    if (![...this.clients.values()].some(c => c.route.identity === client.route.identity)) this.service.deviceOffline(client.route.identity)
  }
  /** App-side revoke: tell the device while its authenticated session still exists (the E2eeManager drops
   *  the session right after), so it clears its own pin instead of showing "paired / disconnected" forever.
   *  Best-effort: a device that is offline learns it on reconnect, when its e2e_hello gets e2e_denied. */
  revoke(identity: string): void {
    for (const [connId, client] of this.clients) if (client.route.identity === identity) {
      try { this.sendTo(connId, client.route, 'autonomous_device_event', { type: 'pair.revoke', machineId: this.machineId }) } catch { /* Local removal must proceed regardless. */ }
      this.clients.delete(connId)
      this.onClient?.(connId, client.route, false)
    }
    this.service.revoke(identity)
  }
}
