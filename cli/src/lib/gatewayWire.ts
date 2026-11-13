/**
 * How the core and the gateway in its own process speak (core/gatewayLink.ts, gateway/gatewayProcess.ts):
 * the service link every service has (core/serviceLinks.ts), carrying the core's frames for remote clients
 * one way and what the remote clients sent, and what the backend said, the other. All of it in the clear:
 * the link is the core's local socket, which only the master's token opens.
 *
 * JSON frames are `service_event` (core → gateway) and `service_notice` (gateway → core), each with a
 * `kind`. Terminal bytes travel as binary frames, framed here: a byte saying whose they are, the id of the
 * connection or window they belong to, and the terminal's own local framing (lib/terminalBinary.ts).
 */
import { join } from 'node:path'

/** Where the core keeps a file the gateway is to send to the backend (a Swarm chat file,
 *  lib/superTabAttachmentProxy.ts): in the daemon's own data folder, made this account's alone. The gateway sends
 *  only a file there (gateway/upload.ts). */
export const uploadsFolder = (dataDir: string): string => join(dataDir, 'uploads')
/** The longest the gateway's send of one such file may take, from the moment it is asked, its wait for a token
 *  included: 11 MB at about 100 kbit/s. Whoever waits on it waits a little longer, so it always hears the answer. */
export const UPLOAD_TOTAL_MS = 15 * 60_000
/** No bytes moving for this long ends an upload, coming in or going out: a slow uplink keeps going, a stalled one does
 *  not hold it. */
export const UPLOAD_IDLE_MS = 30_000
/** The route a Swarm chat file is posted to, on this computer and on the backend alike (hookServer.ts,
 *  gateway/upload.ts), and the agent an agent's own `post --attach` names with `?asAgentId=`. */
export const ATTACHMENT_ROUTE = /^\/api\/super-tabs\/[A-Za-z0-9_-]{1,160}\/attachments$/
export const ATTACHMENT_AGENT = /^[A-Za-z0-9_-]{1,160}$/
/** What a chat file is sent as. */
export const MULTIPART_TYPE = /^multipart\/form-data;\s*boundary=/i

/** Whose bytes a binary frame carries. */
export const enum GatewayBinary {
  /** A remote client's terminal, in the local framing (lib/terminalBinary.ts `encodeTerminalLocal`): to it
   *  (core → gateway) or from it (gateway → core). */
  remote = 1,
  /** A window here working on another machine through the gateway (`WindowRelay`): its terminal's bytes. */
  window = 2,
}

/** The longest id a binary frame carries: a backend connection id, a Wi-Fi device's, or a window's. */
const MAX_ID_BYTES = 256

export function encodeGatewayBinary(kind: GatewayBinary, id: string, bytes: Uint8Array): Uint8Array | null {
  const idBytes = new TextEncoder().encode(id)
  if (idBytes.length === 0 || idBytes.length > MAX_ID_BYTES) return null
  const out = new Uint8Array(3 + idBytes.length + bytes.length)
  out[0] = kind
  out[1] = idBytes.length >> 8
  out[2] = idBytes.length & 0xff
  out.set(idBytes, 3)
  out.set(bytes, 3 + idBytes.length)
  return out
}

export function decodeGatewayBinary(raw: Uint8Array): { kind: GatewayBinary; id: string; bytes: Uint8Array } | null {
  if (raw.length < 3 || (raw[0] !== GatewayBinary.remote && raw[0] !== GatewayBinary.window)) return null
  const length = (raw[1] << 8) | raw[2]
  if (length === 0 || length > MAX_ID_BYTES || raw.length < 3 + length) return null
  return { kind: raw[0], id: new TextDecoder().decode(raw.subarray(3, 3 + length)), bytes: raw.subarray(3 + length) }
}

/** The requests the core asks the gateway's process (`serviceLinks.call`), answered under `<type>_result`:
 *  one per `GatewayOps` member that answers. */
export const GATEWAY_CALLS = {
  accessToken: 'gateway_access_token',
  backend: 'gateway_backend',
  backendUpload: 'gateway_backend_upload',
  machines: 'gateway_machines',
  mintGridName: 'gateway_mint_grid_name',
  status: 'gateway_status',
  pair: 'gateway_pair',
  listPairs: 'gateway_list_pairs',
  revoke: 'gateway_revoke',
  revokeAll: 'gateway_revoke_all',
  setRemotePassword: 'gateway_set_remote_password',
  clearRemotePassword: 'gateway_clear_remote_password',
  remotePasswordStatus: 'gateway_remote_password_status',
  trustLinkedPeer: 'gateway_trust_linked_peer',
  groupList: 'gateway_group_list',
  groupSync: 'gateway_group_sync',
  groupRemove: 'gateway_group_remove',
  devicesList: 'gateway_devices_list',
  devicesRemove: 'gateway_devices_remove',
  devicesHistory: 'gateway_devices_history',
  devicesDismiss: 'gateway_devices_dismiss',
  devicesRebaseline: 'gateway_devices_rebaseline',
  wifi: 'gateway_wifi',
  lane: 'gateway_lane',
  observerKey: 'gateway_observer_key',
  tabKey: 'gateway_tab_key',
  tabRelay: 'gateway_tab_relay',
  connectorVault: 'gateway_connector_vault',
  sharedTrust: 'gateway_shared_trust',
} as const
