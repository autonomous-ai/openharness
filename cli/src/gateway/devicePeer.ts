/** The gateway owns all device routing and its one unavailable-service queue, outside the session core. */
import { b64d, fingerprint } from '../lib/e2ee/core.js'
import type { WebSocket } from 'ws'
import { devicePeerBudgets, devicePeerChannel, type DevicePeerChannel, type DevicePeerPressure } from '../lib/autonomous-device/peerChannel.js'
import { openDevicePeerEndpoint, type DevicePeerFailure } from '../lib/autonomous-device/peerEndpoint.js'
import { devicePeerFrameBytes, encodeDevicePeerFrame } from '../lib/autonomous-device/peerJson.js'
import { DEVICE_PEER_FRAMES, DEVICE_PEER_HELD_BYTES, DEVICE_PEER_HELD_MS, DEVICE_PEER_READY_MS,
  type DevicePeerFrame, type DevicePeerRole, type GatewayDeviceFrame } from '../lib/autonomous-device/peerProtocol.js'
import type { DeviceSessionProof } from '../lib/autonomous-device/relay.js'
import type { GatewayDevicePeer, RelayGateway } from './gateway.js'

type Request = Extract<GatewayDeviceFrame, { type: 'request' }>
type Failure = DevicePeerFailure | DevicePeerPressure | 'PEER_HELD_CAPACITY' | 'PEER_HELD_EXPIRED' | 'PEER_READY_DEADLINE' | 'PEER_REPLY_UNAVAILABLE' | 'PEER_RECAP_UNAVAILABLE'
type Peer = { channel: DevicePeerChannel; epoch: string; ready: boolean; first: boolean; watching: boolean | null }

export function startGatewayDevicePeer(gateway: RelayGateway, options: {
  dataDir: string; port: number; key: Buffer | null
  /** Existing stateless core-to-service wake door, coalesced here. Its answer never establishes peer readiness. */
  wake(): Promise<boolean>
  ready(): void
  unavailable(): void
  failed(code: Failure): void
}) {
  const deviceBudgets = devicePeerBudgets(), recapBudgets = devicePeerBudgets()
  let stopped = false, devices: Peer | null = null, recaps: Peer | null = null, flushing = false, presenting = false
  const held: Array<{ frame: Request; bytes: number; at: number }> = []
  let heldBytes = 0, expiry: ReturnType<typeof setTimeout> | undefined
  let waiting: { promise: Promise<boolean>; finish(value: boolean): void } | null = null
  const current = (peer: Peer): boolean => !stopped && devices === peer
  const watching = (): boolean => devices?.ready === true && gateway.deviceSessions().some(session => session.hello)
  const say = (code: Failure): void => options.failed(code)

  const refuse = (frame: Request, code: 'BACKPRESSURE' | 'PAYLOAD_TOO_LARGE'): void => {
    if (!gateway.deviceCurrent(frame.connId, frame)) return
    const request = frame.opened.payload
    if (!request || typeof request !== 'object' || Array.isArray(request)) return
    const body = request as Record<string, unknown>
    if (typeof body.type !== 'string' || body.type.length > 128 || typeof body.requestId !== 'string') {
      say('PEER_REPLY_UNAVAILABLE'); return
    }
    const answer = { type: `${body.type}_result`, requestId: body.requestId,
      error: { code, message: code === 'BACKPRESSURE' ? 'Device service is unavailable; reconcile before retrying' : 'Device frame exceeds the transport budget' } }
    if (devicePeerFrameBytes(answer) === null) { say('PEER_REPLY_UNAVAILABLE'); return }
    gateway.device(frame.connId, 'autonomous_device_result', answer, frame)
  }
  const armExpiry = (): void => {
    if (expiry) clearTimeout(expiry)
    expiry = undefined
    if (!held.length || stopped) return
    expiry = setTimeout(() => {
      expiry = undefined
      const now = performance.now()
      while (held.length && now - held[0]!.at >= DEVICE_PEER_HELD_MS) {
        const entry = held.shift()!; heldBytes -= entry.bytes
        say('PEER_HELD_EXPIRED'); refuse(entry.frame, 'BACKPRESSURE')
      }
      armExpiry()
    }, Math.max(0, held[0]!.at + DEVICE_PEER_HELD_MS - performance.now())).unref()
  }
  const discardHeld = (): void => {
    while (held.length) { const entry = held.shift()!; heldBytes -= entry.bytes; refuse(entry.frame, 'BACKPRESSURE') }
    armExpiry()
  }
  const presence = (): void => {
    const peer = recaps
    if (!peer || presenting) return
    const source = devices
    const now = watching(), join = now && (peer.first || (!!source && gateway.deviceJoinsPending(source.epoch)))
    if (!peer.first && peer.watching === now && !join) return
    const wire = encodeDevicePeerFrame({ type: 'presence', epoch: peer.epoch, watching: now, joined: join })!
    if (!peer.channel.canSend(Buffer.byteLength(wire))) return
    // A socket callback may return credit synchronously. It must not repeat an uncommitted join.
    presenting = true
    try {
      if (peer.channel.send(wire) !== 'sent') return
      peer.first = false; peer.watching = now
      if (join && source) gateway.clearDeviceJoins(source.epoch)
    } finally { presenting = false }
  }
  const flush = (): void => {
    if (flushing) return
    const peer = devices
    if (!peer?.ready) return
    flushing = true
    try {
      while (held.length && current(peer)) {
        const entry = held[0]!
        if (!gateway.deviceCurrent(entry.frame.connId, entry.frame)) { held.shift(); heldBytes -= entry.bytes; continue }
        if (!peer.channel.canSend(entry.bytes)) break
        held.shift(); heldBytes -= entry.bytes
        entry.frame.epoch = peer.epoch
        const wire = encodeDevicePeerFrame(entry.frame)
        // Taken out before attempting a write: an ambiguous disconnect never replays an effect.
        if (!wire) { say('PEER_FRAME_OVERSIZED'); refuse(entry.frame, 'PAYLOAD_TOO_LARGE'); continue }
        peer.channel.send(wire)
      }
    } finally { flushing = false; armExpiry() }
  }
  const send = (frame: GatewayDeviceFrame): void => {
    const peer = devices
    if (!peer) return
    const wire = encodeDevicePeerFrame({ ...frame, epoch: peer.epoch })
    if (!wire) { say('PEER_FRAME_OVERSIZED'); peer.channel.close(); return }
    peer.channel.send(wire)
  }
  const serving = (): Promise<boolean> => {
    if (stopped) return Promise.resolve(false)
    if (devices?.ready) return Promise.resolve(true)
    if (waiting) return waiting.promise
    let resolve!: (value: boolean) => void
    const promise = new Promise<boolean>(done => { resolve = done })
    let answered = false, settled = false
    const release = (): void => { if (waiting === own && answered && settled) waiting = null }
    const own = { promise, finish(value: boolean) {
      if (waiting !== own || answered) return
      answered = true; clearTimeout(deadline); resolve(value)
      release()
      if (!value) { discardHeld(); options.unavailable() }
    } }
    const deadline = setTimeout(() => { say('PEER_READY_DEADLINE'); own.finish(false) }, DEVICE_PEER_READY_MS).unref()
    waiting = own
    // A readiness timeout revokes the answer, but one hung wake must not multiply on later requests.
    void Promise.resolve().then(() => options.wake()).then(available => { if (!available) own.finish(false) }, () => own.finish(false))
      .finally(() => { settled = true; release() })
    return promise
  }
  const receive = (peer: Peer, frame: DevicePeerFrame): void => {
    if (frame.type === 'recap') {
      if (stopped || recaps !== peer || frame.epoch !== peer.epoch) return
      const target = devices
      if (!target?.ready) { say('PEER_RECAP_UNAVAILABLE'); return }
      const wire = encodeDevicePeerFrame({ ...frame, epoch: target.epoch })
      if (wire === null) { say('PEER_FRAME_OVERSIZED'); return }
      if (target.channel.send(wire) !== 'sent') say('PEER_RECAP_UNAVAILABLE')
      return
    }
    if (!current(peer) || frame.epoch !== peer.epoch) return
    if (frame.type === 'ready') {
      peer.ready = true; options.ready(); waiting?.finish(true); flush(); presence(); return
    }
    if (!('connId' in frame) || !('identity' in frame) || !gateway.deviceCurrent(frame.connId, frame)) return
    if (frame.type === 'send') gateway.device(frame.connId, frame.frameType, frame.payload, frame)
    else if (frame.type === 'hello') { gateway.deviceClient(frame.connId, frame, frame.hello); presence() }
    else if (frame.type === 'joined') { gateway.deviceJoined(frame.connId, frame, peer.epoch); presence() }
    else if (frame.type === 'revoke') gateway.revoke(fingerprint(b64d(frame.identity)))
  }
  const connected = (role: DevicePeerRole, socket: WebSocket, epoch: string): void => {
    const previous = role === 'devices' ? devices : recaps
    const peer: Peer = { channel: null!, epoch, ready: false, first: true, watching: null }
    if (role === 'devices') devices = peer
    else recaps = peer
    peer.channel = devicePeerChannel(socket, { role, side: 'gateway', epoch, budgets: role === 'devices' ? deviceBudgets : recapBudgets,
      current: () => !stopped && (role === 'devices' ? devices : recaps) === peer,
      failed: say, receive: frame => receive(peer, frame), writable: role === 'devices' ? flush : presence,
      gone: () => {
        if (role === 'devices') {
          gateway.clearDeviceJoins(peer.epoch)
          if (devices !== peer) return
          devices = null; presence()
          // Existing encrypted sockets survive a transient component restart.
        } else if (recaps === peer) recaps = null
      },
    })
    previous?.channel.close()
    if (role === 'devices') {
      send({ type: 'snapshot', epoch, machineId: gateway.machineId, sessions: gateway.deviceSessions() })
      presence()
      void serving()
    } else presence()
  }
  const hook: GatewayDevicePeer = {
    session(session) { send({ type: 'session', epoch: devices?.epoch ?? '', session }); presence(); if (!devices?.ready) void serving() },
    dropped(connId, incarnation) {
      for (let n = held.length - 1; n >= 0; n--) if (held[n]!.frame.connId === connId && held[n]!.frame.incarnation === incarnation) {
        heldBytes -= held[n]!.bytes; held.splice(n, 1)
      }
      armExpiry(); send({ type: 'drop', epoch: devices?.epoch ?? '', connId, incarnation }); presence()
    },
    revoked(identity) { send({ type: 'revoked', epoch: devices?.epoch ?? '', identity }); presence() },
    request(connId, proof: DeviceSessionProof, opened) {
      const frame: Request = { type: 'request', epoch: devices?.epoch ?? '0'.repeat(32), connId,
        identity: proof.identity, incarnation: proof.incarnation, opened }
      if (stopped || !gateway.deviceCurrent(connId, frame)) return
      const bytes = devicePeerFrameBytes(frame)
      if (bytes === null) { say('PEER_FRAME_OVERSIZED'); refuse(frame, 'PAYLOAD_TOO_LARGE'); return }
      const peer = devices
      if (peer?.ready) {
        flush()
        if (held.length || !peer.channel.canSend(bytes)) { say('PEER_WRITE_BACKPRESSURE'); refuse(frame, 'BACKPRESSURE'); return }
        const wire = encodeDevicePeerFrame(frame)
        if (wire) peer.channel.send(wire)
        else { say('PEER_FRAME_OVERSIZED'); refuse(frame, 'PAYLOAD_TOO_LARGE') }
        return
      }
      if (held.length >= DEVICE_PEER_FRAMES || bytes > DEVICE_PEER_HELD_BYTES - heldBytes) {
        say('PEER_HELD_CAPACITY'); refuse(frame, 'BACKPRESSURE'); return
      }
      held.push({ frame, bytes, at: performance.now() }); heldBytes += bytes; armExpiry(); void serving()
    },
  }
  gateway.devicePeer = hook
  const opening = openDevicePeerEndpoint({ ...options, current: () => !stopped, connected })
  return { serving, async stop() {
    stopped = true
    if (gateway.devicePeer === hook) gateway.devicePeer = null
    waiting?.finish(false); discardHeld()
    devices?.channel.close(); recaps?.channel.close()
    await (await opening)?.close()
  } }
}
