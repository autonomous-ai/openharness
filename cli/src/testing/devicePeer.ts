/** An authenticated peer socket fixture. It exercises the real decoder, writer and business relay. */
import { EventEmitter } from 'node:events'
import { WebSocket } from 'ws'
import type { devicePeerConnection } from '../lib/autonomous-device/peerConnection.js'
import type { DevicePeerSession, DevicesGatewayFrame, GatewayDeviceFrame } from '../lib/autonomous-device/peerProtocol.js'

class PeerSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN
  bufferedAmount = 0
  constructor(private readonly written: (frame: DevicesGatewayFrame) => void) { super() }
  send(wire: string, done: (error?: Error) => void): void { this.written(JSON.parse(wire)); done() }
  terminate(): void {
    if (this.readyState === WebSocket.CLOSED) return
    this.readyState = WebSocket.CLOSED; this.emit('close')
  }
  message(frame: GatewayDeviceFrame): void { this.emit('message', Buffer.from(JSON.stringify(frame)), false) }
}

export class GatewayDeviceFixture {
  readonly sent: DevicesGatewayFrame[] = []
  readonly sessions = new Map<string, DevicePeerSession>()
  readonly changed = new EventEmitter()
  private socket: PeerSocket | null = null
  private epoch = 0
  private markReady: (() => void) | undefined
  private ready: Promise<void> = new Promise(resolve => { this.markReady = resolve })
  constructor(private readonly connection: Parameters<typeof devicePeerConnection>[0], readonly machineId = 'machine-1') {}
  start(): void {
    const epoch = ++this.epoch
    if (epoch > 1) this.ready = new Promise(resolve => { this.markReady = resolve })
    const socket = new PeerSocket(frame => {
      this.sent.push(frame)
      if (frame.type === 'ready') this.markReady?.()
      if (frame.type === 'hello') {
        const held = this.sessions.get(frame.connId)
        if (held?.incarnation === frame.incarnation) this.sessions.set(frame.connId, { ...held, hello: frame.hello })
      }
      this.changed.emit('frame', frame)
    })
    this.socket = socket
    this.connection.connected(socket as unknown as WebSocket, () => this.socket === socket && this.epoch === epoch)
    socket.message({ type: 'snapshot', epoch: epoch.toString(16).padStart(32, '0'), machineId: this.machineId, sessions: [...this.sessions.values()] })
  }
  async stop(): Promise<void> { const socket = this.socket; this.socket = null; this.epoch++; socket?.terminate() }
  session(connId: string, client: { identity: string; role: string; direct?: boolean } | null): void {
    if (!client || client.role !== 'device') { this.drop(connId); return }
    const previous = this.sessions.get(connId)
    const held: DevicePeerSession = { connId, identity: client.identity, incarnation: `${connId}:${client.identity}`,
      direct: client.direct === true, hello: previous?.identity === client.identity && previous.hello === true }
    this.sessions.set(connId, held)
    this.socket?.message({ type: 'session', epoch: this.epoch.toString(16).padStart(32, '0'), session: held })
  }
  async request(connId: string, payload: Record<string, unknown>): Promise<void> {
    await this.ready
    const held = this.sessions.get(connId)
    if (!held || !this.socket) return
    this.socket.message({ type: 'request', epoch: this.epoch.toString(16).padStart(32, '0'), connId, identity: held.identity, incarnation: held.incarnation, opened: { payload } })
  }
  async card(frame: Extract<GatewayDeviceFrame, { type: 'recap' }>['frame'], fullText: string | null): Promise<void> {
    await this.ready
    this.socket?.message({ type: 'recap', epoch: this.epoch.toString(16).padStart(32, '0'), frame, fullText })
  }
  drop(connId: string): void {
    const held = this.sessions.get(connId)
    this.sessions.delete(connId)
    if (held) this.socket?.message({ type: 'drop', epoch: this.epoch.toString(16).padStart(32, '0'), connId, incarnation: held.incarnation })
  }
  revoke(identity: string): void {
    for (const [connId, held] of this.sessions) if (held.identity === identity) this.sessions.delete(connId)
    this.socket?.message({ type: 'revoked', epoch: this.epoch.toString(16).padStart(32, '0'), identity })
  }
  replies(): Array<Record<string, any>> {
    return this.sent.filter((frame): frame is Extract<DevicesGatewayFrame, { type: 'send' }> => frame.type === 'send')
      .map(frame => ({ connId: frame.connId, identity: frame.identity, frame: frame.frameType, ...frame.payload }))
  }
}
