/** A paired test phone with a real encrypted WebRTC channel to the isolated gateway.
 * Kept apart from RelayPhone: a relay-only test must not silently become a P2P test.
 * Host candidates only; no public STUN, TURN or account is used. */
import { WebSocket } from 'ws'
import { RelaySessionCrypto } from '../../src/lib/e2ee/relayClient.js'
import { TerminalP2pInitiator, TERMINAL_P2P_SIGNAL_TYPES } from '../../src/lib/terminalP2p.js'
import type { TerminalBinaryClear } from '../../src/lib/terminalBinary.js'
import type { Frame } from './client.js'
import { until } from './daemon.js'
import type { PhoneMachine } from './fleet.js'

type Transport = 'relay' | 'p2p'

export class P2pPhone {
  readonly frames: Array<{ frame: Frame; transport: Transport }> = []
  readonly binaries: Array<{ frame: TerminalBinaryClear; transport: Transport }> = []
  readonly errors: string[] = []
  readonly peer: TerminalP2pInitiator
  private readonly crypto: RelaySessionCrypto
  private readonly ws: WebSocket

  private constructor(world: PhoneMachine) {
    const { backend, machine, phone } = world
    this.crypto = new RelaySessionCrypto({ machineId: machine.machineId,
      selfIdentity: phone.identity, peerPub: machine.identity.pub })
    this.ws = new WebSocket(`${backend.wsUrl}/api/web-ws?autonomousEnv=prod`, [phone.token])
    this.peer = new TerminalP2pInitiator({
      policy: { enabled: true, protocolVersion: 1, stunUrls: [], openWaitMs: 1_500 },
      sendSignal: (type, payload) => this.send(type, { ...payload }, 'relay'),
      onData: data => this.receive(data, typeof data !== 'string', 'p2p'),
    })
    this.ws.on('error', error => this.errors.push(error.message))
    this.ws.on('open', () => this.ws.send(JSON.stringify({ type: 'machine_select', payload: { machineId: machine.machineId } })))
    this.ws.on('message', (data, binary) => this.receive(binary ? Buffer.concat(Array.isArray(data) ? data : [Buffer.from(data as ArrayBuffer)]) : data.toString(), binary, 'relay'))
  }

  static async open(world: PhoneMachine): Promise<P2pPhone> {
    // QA #906: local readiness precedes gateway registration; an early hello is otherwise lost.
    await until('the gateway on the fake backend', () => world.backend.nodeUp(world.machine.machineId), 30_000)
    const phone = new P2pPhone(world)
    try {
      await until('the paired P2P phone session', () => phone.crypto.ready, 20_000)
      if (phone.crypto.terminalP2pVersion !== 1) throw new Error('gateway did not advertise terminal P2P')
      return phone
    } catch (error) {
      await phone.close()
      throw error
    }
  }

  private receive(data: string | Buffer, binary: boolean, transport: Transport): void {
    if (binary) {
      const frame = this.crypto.decryptTerminal(Buffer.from(data))
      if (frame) this.binaries.push({ frame, transport })
      else this.errors.push('terminal frame did not authenticate')
      return
    }
    let frame: Frame
    try { frame = JSON.parse(data.toString()) as Frame } catch { this.errors.push('invalid JSON'); return }
    if (!this.crypto.ready) {
      if (frame.type === 'connected' && frame.payload?.machineId) this.ws.send(JSON.stringify(this.crypto.helloFrame()))
      else if (frame.type === 'e2e_welcome' && !this.crypto.handleWelcome(frame.payload ?? {})) this.errors.push('invalid welcome')
      else if (frame.type === 'e2e_denied') this.errors.push('phone denied')
      return
    }
    if (frame.type === 'e2e_rekey') { this.crypto.handleRekey(frame.payload ?? {}); return }
    const opened = this.crypto.unwrapIncoming(frame) as Frame | null
    if (!opened || opened.payload?.__e2e) { this.errors.push('frame did not authenticate'); return }
    this.frames.push({ frame: opened, transport })
    if (TERMINAL_P2P_SIGNAL_TYPES.has(opened.type)) {
      void this.peer.handleSignal(opened.type, opened.payload).catch(error => this.errors.push(String(error)))
    }
  }

  async negotiate(): Promise<void> {
    this.peer.start()
    if (!await this.peer.waitUntilReady(15_000)) throw new Error(`P2P did not connect: ${this.peer.negotiationDetail}`)
  }

  send(type: string, payload: Record<string, unknown>, transport: Transport): void {
    if (!this.crypto.ready) throw new Error('phone has no sealed session')
    const wire = JSON.stringify(this.crypto.wrapOutgoing({ type, payload }))
    if (transport === 'p2p') {
      // Never hide a failed P2P send by substituting relay: this test proves the actual channel.
      if (!this.peer.send(wire)) throw new Error('P2P send failed')
    } else this.ws.send(wire)
  }

  sendBinary(frame: TerminalBinaryClear): void {
    const sealed = this.crypto.encryptTerminal(frame)
    if (!sealed || !this.peer.send(Buffer.from(sealed))) throw new Error('P2P binary send failed')
  }

  async close(): Promise<void> {
    await this.peer.stop('test_complete', false)
    this.ws.terminate()
  }
}
