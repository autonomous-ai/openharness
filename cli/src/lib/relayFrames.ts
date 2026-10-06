/**
 * What the core and the gateway both read about a frame, without either importing the other: which
 * connections are this computer's own, which frames only the backend may send, and how a frame type the
 * relay chose is written into a log line. Pure: no state, no keys.
 */

/** A loopback desktop connection (localWsServer.ts), as opposed to a cloud/relay one. */
export function isLocalClientId(connId: string): boolean {
  return connId.startsWith('local:')
}

/**
 * Where a down-frame came from, carried with it to the dispatch.
 *
 * `relay` is the backend link and ONLY the backend link; `local` is a process on this machine
 * talking to the daemon's local socket; `p2p` is a paired device over its own channel. The
 * distinction is a trust boundary, not bookkeeping: a handful of frames are the backend's alone to
 * send, and before `local` existed they were accepted from anything that could open the local port.
 */
export type DownTransport = 'relay' | 'local' | 'p2p'

/**
 * Down-frames only the BACKEND may send, refused from every other transport.
 *
 * Each one hands the daemon an instruction no client is entitled to give:
 *   - `machine_meta` names the account's private grid — the inference endpoint every agent on this
 *     computer is then pointed at. Forged, it redirects the account's work to a grid of the
 *     sender's choosing. A leftover test script did exactly this by accident once.
 *   - `machine_revoked` clears the stored SSO session and exits the daemon. Forged, it is a
 *     one-frame forced sign-out and denial of service.
 *
 * Neither is sent by any client in this repository — only by `backend/src/lib/adapterWs.ts` and
 * `backend/src/services/MachineService.ts` — so there is nothing to stay compatible with. The
 * backend blocks its OWN `__`-prefixed control frames from web clients for the same reason; these
 * two escaped that rule because they are not `__`-prefixed.
 *
 * `device_keys_changed` and `devlog_append_result` are the backend's own too (the device key log,
 * lib/e2ee/deviceLogSyncer.ts): forged, the first only makes this daemon re-read and verify the log,
 * the second could fake an answer to its own append — neither is anything a client should be sending.
 */
export const BACKEND_ONLY_DOWN_TYPES = new Set(['machine_meta', 'machine_revoked', 'desk_changed', 'zoo_changed', 'machines_changed', 'device_keys_changed', 'devlog_append_result'])

/** A frame type as the sender spelled it, fit for one log line: the relay chooses it, so it is bounded
 *  and escaped rather than trusted not to carry a newline that forges the next line. */
export function logSafeType(type: string): string {
  return JSON.stringify(type.length > 64 ? `${type.slice(0, 64)}…` : type)
}

/**
 * The E2EE management requests: pairing a device or a phone from an already trusted browser, and listing
 * or removing the pairings. They act on the keys, so the gateway, which holds them, answers them: a remote
 * client's directly, a window's on this computer when the core hands it over (`GatewayPort.local`).
 */
export const GATEWAY_REQUEST_TYPES = new Set(['device_e2ee_pair', 'phone_pair', 'e2ee_pairings_list', 'e2ee_pairing_unpair', 'e2ee_pairings_unpair_all'])
