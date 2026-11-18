/** The devices process speaks directly to the authenticated gateway peer; core owns no relay state. */
import { AutonomousDeviceRelay, type DeviceRelayProof } from './relay.js'
import { devicePeerConnection } from './peerConnection.js'
import { devicePeerBudgets, devicePeerChannel, type DevicePeerChannel } from './peerChannel.js'
import { devicePeerWriter } from './peerWriter.js'
import type { DevicePeerFrame, DevicePeerSession } from './peerProtocol.js'
import type { AutonomousDeviceFrame, AutonomousDeviceService } from './service.js'

export interface DeviceRelayOverGateway {
  start(): void
  stop(): Promise<void>
  drain(): void
  directSessions(): number
  connected(): boolean
  emit(frame: AutonomousDeviceFrame, deviceId?: string): void
}

export function deviceRelayOverGateway(deps: {
  dataDir: string; port: number; key: Buffer | null
  service: AutonomousDeviceService
  machineId: string
  beforeReady(): Promise<void>
  beforeRequest(): Promise<void>
  maySend(): boolean
  clientChanged(): void
  card(frame: Record<string, unknown>, fullText: string | undefined, current: () => boolean): Promise<void>
  failed(code: string): void
}): DeviceRelayOverGateway {
  const sessions = new Map<string, DevicePeerSession>(), budgets = devicePeerBudgets()
  let running = false
  let peer: { channel: DevicePeerChannel; current(): boolean; snapshot: boolean; ready: boolean } | null = null
  const session = (connId: string): DeviceRelayProof | null => {
    const held = sessions.get(connId), epoch = peer?.channel.epoch()
    return held && epoch && peer?.current() ? { identity: held.identity, incarnation: held.incarnation, peerEpoch: epoch } : null
  }
  const current = (connId: string, proof: DeviceRelayProof): boolean => {
    const latest = session(connId)
    return latest?.identity === proof.identity && latest.incarnation === proof.incarnation && latest.peerEpoch === proof.peerEpoch
  }
  const writer = devicePeerWriter({ budgets, channel: () => peer?.channel ?? null, failed: deps.failed, maySend: deps.maySend })
  const route = (connId: string, proof: DeviceRelayProof) => ({ connId, identity: proof.identity, incarnation: proof.incarnation, epoch: proof.peerEpoch })
  const relay = new AutonomousDeviceRelay(session, (connId, frame, proof) => {
    const original = peer
    if (!writer.send({ type: 'send', ...route(connId, proof), frameType: frame.type as 'autonomous_device_result' | 'autonomous_device_event',
      payload: frame.payload as Record<string, unknown> }, () => current(connId, proof))) original?.channel.close()
  }, deps.service, deps.machineId, (connId, proof, frames, allowed, hello) => {
    const original = peer
    const start = writer.replay(route(connId, proof), frames, () => current(connId, proof), allowed, hello)
    if (!start) original?.channel.close()
    return start
  }, undefined, (connId, proof) => {
    const original = peer
    if (!writer.send({ type: 'revoke', ...route(connId, proof) }, () => current(connId, proof))) original?.channel.close()
  }, (connId, proof, hello) => {
    // Successful hello metadata is already in the atomically admitted replay's prefix.
    if (!hello && current(connId, proof)) {
      const original = peer
      if (!writer.send({ type: 'hello', ...route(connId, proof), hello: false }, () => current(connId, proof))) original?.channel.close()
    }
    deps.clientChanged()
  }, deps.beforeReady, deps.beforeRequest)
  const connection = devicePeerConnection({ ...deps, role: 'devices', connected(socket, connected) {
    const own = { channel: null as unknown as DevicePeerChannel, current: () => running && peer === own && connected(), snapshot: false, ready: false }
    peer = own
    own.channel = devicePeerChannel(socket, { role: 'devices', side: 'component', epoch: null, budgets, current: own.current,
      failed: deps.failed, writable: writer.drain,
      gone: () => {
        if (peer === own) { peer = null; sessions.clear(); deps.clientChanged() }
        writer.drain()
      },
      receive: async (frame: DevicePeerFrame) => {
        if (!own.current()) return
        if (frame.type === 'snapshot') {
          if (own.snapshot || frame.machineId !== deps.machineId) { deps.failed('PEER_PROTOCOL_INVALID'); own.channel.close(); return }
          own.snapshot = true
          sessions.clear()
          for (const held of frame.sessions) sessions.set(held.connId, held)
          relay.retain(frame.sessions.filter(held => held.hello))
          if (frame.sessions.some(held => held.hello)) await deps.beforeReady()
          if (!own.current()) return
          for (const held of frame.sessions) if (held.hello) {
            const proof = { identity: held.identity, incarnation: held.incarnation, peerEpoch: frame.epoch }
            if (current(held.connId, proof)) relay.restore(held.connId, proof)
          }
          if (!own.current()) return
          own.ready = true
          if (!writer.send({ type: 'ready', epoch: frame.epoch }, own.current)) own.channel.close()
          return
        }
        if (!own.snapshot) { deps.failed('PEER_PROTOCOL_INVALID'); own.channel.close(); return }
        if (frame.type === 'session') {
          const previous = sessions.get(frame.session.connId)
          if (previous && previous.incarnation !== frame.session.incarnation) relay.drop(previous.connId, previous.incarnation)
          sessions.set(frame.session.connId, frame.session)
          deps.clientChanged()
        } else if (frame.type === 'drop') {
          if (sessions.get(frame.connId)?.incarnation !== frame.incarnation) return
          sessions.delete(frame.connId)
          relay.drop(frame.connId, frame.incarnation)
          deps.clientChanged()
        } else if (frame.type === 'revoked') {
          for (const [connId, held] of sessions) if (held.identity === frame.identity) sessions.delete(connId)
          relay.revoke(frame.identity)
          deps.clientChanged()
        } else if (frame.type === 'recap') {
          if (!own.ready) { deps.failed('PEER_PROTOCOL_INVALID'); own.channel.close(); return }
          await deps.card(frame.frame, frame.fullText ?? undefined, own.current)
        } else if (frame.type === 'request') {
          if (!own.ready) { deps.failed('PEER_PROTOCOL_INVALID'); own.channel.close(); return }
          const proof = { identity: frame.identity, incarnation: frame.incarnation, peerEpoch: frame.epoch }
          if (!current(frame.connId, proof)) return
          const body = frame.opened.payload
          if (!body || typeof body !== 'object' || Array.isArray(body)) { deps.failed('PEER_PROTOCOL_INVALID'); own.channel.close(); return }
          await relay.handle(frame.connId, proof, body as Record<string, unknown>)
        } else { deps.failed('PEER_PROTOCOL_INVALID'); own.channel.close() }
      },
    })
  } })
  return {
    start() { if (running) return; running = true; connection.start() },
    async stop() {
      running = false
      const previous = peer
      peer = null; sessions.clear(); writer.discard()
      previous?.channel.close()
      deps.clientChanged()
      await connection.stop()
    },
    drain: writer.drain,
    directSessions: () => relay.count(connId => sessions.get(connId)?.direct === true),
    connected: () => {
      if (relay.connected()) return true
      // Initial restored hellos own observation interest before their question snapshot is ready.
      if (peer?.current() && !peer.ready) for (const held of sessions.values()) if (held.hello) return true
      return false
    },
    emit: (frame, deviceId) => relay.emit(frame, deviceId),
  }
}
