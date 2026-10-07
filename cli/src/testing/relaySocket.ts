/**
 * The socket and its gateway in one process, as the daemon builds them (core/main.ts), for the specs that
 * drive the relay through the socket. It takes the arguments the socket took when it held the backend link
 * itself, so a spec written against that reads as it did; `gatewayOf` is the gateway it was built with.
 * The teams ride on it as they did when they were the socket's (testing/teamFixture.ts).
 */
import { BackendSocket } from '../backendSocket.js'
import { RelayGateway } from '../gateway/gateway.js'
import type { AuthSessionManager } from '../lib/authSession.js'
import { attachTeams, type TeamFixture } from './teamFixture.js'

export function relaySocket(
  machineId: string,
  auth?: AuthSessionManager,
  onStatus?: (connected: boolean) => void,
  computerId = '',
  autonomousEnv = 'prod',
): BackendSocket & TeamFixture {
  const socket = new BackendSocket(machineId, onStatus)
  socket.useGateway(new RelayGateway({ machineId, auth, computerId, autonomousEnv, core: socket.fromGateway }))
  return attachTeams(socket)
}

/** The gateway a socket from `relaySocket` was built with. */
export function gatewayOf(socket: BackendSocket): RelayGateway {
  return socket.gateway as RelayGateway
}

/**
 * One frame into the socket as it arrives: a window's on this computer (`local`) straight to the socket's
 * dispatch, anything else (the relay's, a P2P channel's) through the gateway first, which applies the
 * relay's rules and hands on what it admits. Resolves once the frame is handled.
 */
export function dispatchDown(socket: BackendSocket, frame: Record<string, unknown>, connId: string, transport?: 'relay' | 'local' | 'p2p'): Promise<void> {
  const internals = socket as unknown as { dispatchDown: (f: unknown, c: string, t: string) => Promise<void>; localClients: Map<string, unknown> }
  // Unsaid, a frame on a window's live connection is that window's, as the socket reads one.
  const from = transport ?? (internals.localClients.has(connId) ? 'local' : 'relay')
  if (from === 'local') return internals.dispatchDown(frame, connId, 'local')
  return gatewayOf(socket).dispatchDown(frame, connId, from)
}

/** The upstream link of a socket's gateway, for a spec that reads what it queued or dialed. */
export function upstreamOf(socket: BackendSocket): { queue: Array<{ msg: unknown }>; url: string } {
  return (gatewayOf(socket) as unknown as { link: { queue: Array<{ msg: unknown }>; url: string } }).link
}
