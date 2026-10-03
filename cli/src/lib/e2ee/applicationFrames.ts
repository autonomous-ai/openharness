/** Harness-only RPC extensions. The shared, pinned crypto core remains byte-identical across clients.
 * Both the originating machine relay and receiving daemon use these classifications. Older clients
 * do not send these frames; older targets answer UNSUPPORTED before any command is attempted.
 *
 * ONE place for every extension: the grid fleet RPCs (#90), harness sharing (`SHARE_*`), CLI-to-CLI
 * viewer forwarding (`VIEWER_DOWN_TYPES`, #85), the pair brain's machine-to-machine `PAIR_*` and the phone's
 * individual art (`PLATE_*`). A type listed in none of these travels plaintext, and
 * the two callers (relayClient's wrap, backendSocket's unwrap and reply) must agree — they used to
 * spell the union inline, in three places, and merging two of these features meant merging the spelling.
 */
import { ENCRYPTED_RPC_RESULT_TYPES, isEncryptedDownType } from './core.js'
import { SHARE_REQUEST_TYPES, SHARE_RESULT_TYPES } from '../../sharing/protocol.js'
import { VIEWER_DOWN_TYPES } from '../viewerWire.js'
import { TEAM_REQUEST_TYPES, TEAM_RESULT_TYPES } from '../../teams/wire.js'
export const OWNER_COMMAND_TYPES = new Set(['command_bar', 'route_task', 'route_send'])

const FLEET_REQUESTS = new Set(['grid_fleet_capabilities', 'grid_fleet_run', 'grid_fleet_cancel',
  'grid_fleet_models_list', 'grid_fleet_model_download', 'grid_fleet_model_start', 'grid_fleet_model_stop'])
const FLEET_RESULTS = new Set([...FLEET_REQUESTS].map(type => `${type}_result`))
// `group_sync`: the trust-group roster exchange (groupSyncer.ts) — keys, so always sealed.
const MACHINE_REQUESTS = new Set(['agent_purge', 'agent_worktree_delete', 'agents_cleanup_preview', 'agent_close', 'git_project_info', 'git_pull_request', 'machine_resources', 'api_connections', 'group_sync', 'phone_pair', 'viewer_surface', 'orchestrator', ...OWNER_COMMAND_TYPES])
const MACHINE_RESULTS = new Set([...MACHINE_REQUESTS].map(type => `${type}_result`))
/** The pair brain, machine to machine (daemons/BRAIN.md). A watch carries question text and recaps; the
 * writes (answer, send, stop, start, pause, resume) act on a harness through the owning machine's floor
 * (pair/owner.ts). Sealed both ways, always: the relay sees the outer type only. */
export const PAIR_REQUESTS = new Set(['pair_watch', 'pair_journal', 'pair_read', 'pair_list',
  'pair_answer', 'pair_send', 'pair_stop', 'pair_start', 'pair_pause', 'pair_resume'])
export const PAIR_RESULTS = new Set([...PAIR_REQUESTS].map(type => `${type}_result`))
/** Pushed to one watcher with the daemon's `wrapTarget` (pairwise, that connection only), never broadcast. */
export const PAIR_PUSHES = new Set(['pair_event'])
/** The loopback-only `pair` request's reply. Listed so a relayed `pair` (refused LOCAL_ONLY) is answered
 * sealed and to that connection alone, not broadcast. */
const LOCAL_PAIR_RESULT = 'pair_result'
/** An individual's art for the phone (pair/plateService.ts; a window asks `daemon_plate_get` over the Unix
 * socket instead). Sealed both ways, answered to that connection alone. Its reply is `pair_plate`, not
 * `pair_plate_get_result`: see rpcResultType. */
export const PLATE_REQUEST = 'pair_plate_get'
export const PLATE_RESULT = 'pair_plate'
export const isPairFrameType = (type: string): boolean =>
  PAIR_REQUESTS.has(type) || PAIR_RESULTS.has(type) || PAIR_PUSHES.has(type) || type === PLATE_REQUEST || type === PLATE_RESULT
/** The reply's type for a request: `<type>_result`, except the plate's `pair_plate`. */
export const rpcResultType = (type: string): string => type === PLATE_REQUEST ? PLATE_RESULT : `${type}_result`
/**
 * Whether a `pair_*` frame that arrived through the relay may be believed. `RelaySessionCrypto` passes a
 * never-wrapped frame straight through (control frames are plaintext), so without this the relay could
 * push a made-up `pair_event` — a question nobody asked — into the brain. Sealed pairwise: yes. The one
 * plaintext exception is an OLDER daemon's bare refusal (`{requestId, error}`): it predates these types,
 * so its UNSUPPORTED goes out in the clear, and hearing it is what names that machine as too old rather
 * than unreachable. It carries nothing; a relay that forges one only hides a machine it could drop anyway.
 */
export function admitRelayedPairFrame(frame: { type?: unknown; payload?: unknown }): boolean {
  const payload = frame.payload
  if (!payload || typeof payload !== 'object') return false
  const env = (payload as { __e2e?: { k?: unknown } }).__e2e
  if (env) return env.k === 'p'
  if (typeof frame.type !== 'string' || !PAIR_RESULTS.has(frame.type)) return false
  const keys = Object.keys(payload)
  return typeof (payload as { error?: unknown }).error === 'string' && keys.every(key => key === 'requestId' || key === 'error')
}
export const encryptDownFrame = (type: string): boolean =>
  isEncryptedDownType(type) || MACHINE_REQUESTS.has(type) || FLEET_REQUESTS.has(type) || SHARE_REQUEST_TYPES.has(type) || VIEWER_DOWN_TYPES.has(type)
  || PAIR_REQUESTS.has(type) || type === PLATE_REQUEST || TEAM_REQUEST_TYPES.has(type)
/** Client→daemon requests that older daemons took in the clear and no longer do. A client seals them
 * only for a daemon whose e2e_welcome says `strictDown` — an older one would never open the envelope
 * and would read the request as empty. A daemon that says `strictDown` refuses them unsealed. */
export const STRICT_DOWN_TYPES = new Set(['dsh_install', 'dsh_update', 'dsh_remove', 'dsh_list',
  'agent_retarget', 'engines_probe', 'grid_models_list', 'cancel', 'claude_login_status', 'speaking'])
/** What a client seals for a given daemon: the always-sealed types, plus STRICT_DOWN_TYPES when it opens them. */
export const encryptDownFrameFor = (type: string, peer: { strictDown: boolean }): boolean =>
  encryptDownFrame(type) || (peer.strictDown && STRICT_DOWN_TYPES.has(type))
/** What became of one client's answer to a question (`question_response`): typed, or refused as
 * STALE_QUESTION. Listed so it goes back sealed and to the connection that answered — a dial, a phone, a
 * machine relaying for its app — rather than being broadcast to every window and web client of this
 * machine. Here and not in core.ts's pinned set: the reply is the same frame, only its route changes. */
const QUESTION_RESULT = 'question_response_result'
export const encryptRpcResult = (type: string): boolean =>
  ENCRYPTED_RPC_RESULT_TYPES.has(type) || MACHINE_RESULTS.has(type) || FLEET_RESULTS.has(type) || SHARE_RESULT_TYPES.has(type)
  || PAIR_RESULTS.has(type) || type === LOCAL_PAIR_RESULT || type === QUESTION_RESULT || type === PLATE_RESULT || TEAM_RESULT_TYPES.has(type)
