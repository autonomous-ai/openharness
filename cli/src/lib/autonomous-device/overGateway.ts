/**
 * The Wi-Fi device's application protocol (./relay.ts), over sessions the gateway holds (gateway/gateway.ts).
 *
 * The relay was written against the E2EE manager it shared a process with: it read a session's identity
 * and role, opened a request, sealed an answer. The manager is the gateway's now, in a process of its own
 * by default (docs/design/2026-10-06-core-boundary-next.md, step 10, R2), and the device service the relay
 * answers for stays beside the agents. So the relay sees the sessions through what the gateway registered
 * (`RemoteClient`), gets each request already opened by the session that sealed it, and hands its answers
 * to the gateway to seal: its own code, and so what a device sees of it, is unchanged.
 */
import type { RemoteClient } from '../../core/api.js'
import { AutonomousDeviceRelay } from './relay.js'
import type { AutonomousDeviceFrame, AutonomousDeviceService } from './service.js'

export interface DeviceRelayOverGateway {
  /** A request as it arrived and as the gateway opened it (null when it would not open). */
  handle(connId: string, frame: Record<string, unknown>, opened: Record<string, unknown> | null): Promise<void>
  drop(connId: string): void
  revoke(identity: string): void
  /** The sessions whose app said hello. */
  helloed(): string[]
  /** A session whose app said hello to the service's previous run, served on and told to resync. */
  restore(connId: string, identity: string): void
  /** Sessions on a direct link that said hello. */
  directSessions(): number
  connected(): boolean
  emit(frame: AutonomousDeviceFrame, deviceId?: string): void
}

export function deviceRelayOverGateway(deps: {
  /** A session the gateway registered, by connection. */
  client(connId: string): RemoteClient | undefined
  /** Seal and send to one session (`GatewayPort.device`). */
  send(connId: string, type: string, payload: Record<string, unknown>): void
  service: AutonomousDeviceService
  machineId: string
  onReady(): void
  onRemoteRevoke(identity: string): void
  onClient(connId: string, identity: string | null): void
}): DeviceRelayOverGateway {
  let opened: Record<string, unknown> | null = null
  const sessions = {
    sessionIdentity: (connId: string) => deps.client(connId)?.identity ?? null,
    sessionRole: (connId: string) => deps.client(connId)?.role ?? null,
    // The relay opens a request once, before its first await: the gateway opened it already.
    unwrapDown: () => { const frame = opened; opened = null; return frame },
    wrapTarget: (connId: string, type: string, payload: Record<string, unknown>) => (deps.client(connId) ? { type, payload } : null),
  }
  const relay = new AutonomousDeviceRelay(sessions, (connId, frame) => deps.send(connId, String(frame.type), frame.payload as Record<string, unknown>),
    deps.service, deps.machineId, deps.onReady, deps.onRemoteRevoke, deps.onClient)
  return {
    handle: async (connId, frame, frameOpened) => {
      opened = frameOpened
      try { await relay.handle(connId, frame) } finally { opened = null }
    },
    drop: (connId) => relay.drop(connId),
    revoke: (identity) => relay.revoke(identity),
    helloed: () => relay.helloed(),
    restore: (connId, identity) => relay.restore(connId, identity),
    directSessions: () => relay.count((connId) => deps.client(connId)?.direct === true),
    connected: () => relay.connected(),
    emit: (frame, deviceId) => relay.emit(frame, deviceId),
  }
}
