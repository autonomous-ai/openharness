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
import { SHELL_REQUESTS } from '../shellProtocol.js'
import { ENCRYPTED_RPC_RESULT_TYPES, isEncryptedDownType } from './core.js'
import { SHARE_REQUEST_TYPES, SHARE_RESULT_TYPES } from '../../sharing/protocol.js'
import { VIEWER_DOWN_TYPES } from '../viewerWire.js'
import { TEAM_REQUEST_TYPES, TEAM_RESULT_TYPES } from '../../teams/wire.js'
import { OWNER_COMMAND_TYPES, PAIR_REQUESTS, PLATE_REQUEST, PLATE_RESULT, rpcResultType } from '../relayFrames.js'

// The ones the core reads too, to dispatch a request and name its reply, live with its other frame rules
// (lib/relayFrames.ts), which load no cipher; this stays the one place every extension is listed.
export { OWNER_COMMAND_TYPES, PAIR_REQUESTS, PLATE_REQUEST, PLATE_RESULT, rpcResultType }

const FLEET_REQUESTS = new Set(['grid_fleet_capabilities', 'grid_fleet_run', 'grid_fleet_cancel',
  'grid_fleet_models_list', 'grid_fleet_model_download', 'grid_fleet_model_start', 'grid_fleet_model_stop'])
const FLEET_RESULTS = new Set([...FLEET_REQUESTS].map(type => `${type}_result`))
// `group_sync`: the trust-group roster exchange (groupSyncer.ts) — keys, so always sealed.
const MACHINE_REQUESTS = new Set([...SHELL_REQUESTS, 'agent_purge', 'agent_worktree_delete', 'agents_cleanup_preview', 'agent_close', 'git_project_info', 'scm_project_info', 'git_pull_request', 'machine_resources', 'api_connections', 'group_sync', 'phone_pair', 'viewer_surface', 'orchestrator', 'agent_handoff_prepare', ...OWNER_COMMAND_TYPES])
const MACHINE_RESULTS = new Set([...MACHINE_REQUESTS].map(type => `${type}_result`))
/** The pair brain, machine to machine (daemons/BRAIN.md). A watch carries question text and recaps; the
 * writes (answer, send, stop, start, pause, resume) act on a harness through the owning machine's floor
 * (pair/owner.ts). Sealed both ways, always: the relay sees the outer type only. */
export const PAIR_RESULTS = new Set([...PAIR_REQUESTS].map(type => `${type}_result`))
/** Pushed to one watcher with the daemon's `wrapTarget` (pairwise, that connection only), never broadcast. */
export const PAIR_PUSHES = new Set(['pair_event'])
/** The loopback-only `pair` request's reply. Listed so a relayed `pair` (refused LOCAL_ONLY) is answered
 * sealed and to that connection alone, not broadcast. */
const LOCAL_PAIR_RESULT = 'pair_result'
/** An individual's art for the phone (pair/plateService.ts; a window asks `daemon_plate_get` over the Unix
 * socket instead). Sealed both ways, answered to that connection alone. Its reply is `pair_plate`, not
 * `pair_plate_get_result`: see rpcResultType. */
export const isPairFrameType = (type: string): boolean =>
  PAIR_REQUESTS.has(type) || PAIR_RESULTS.has(type) || PAIR_PUSHES.has(type) || type === PLATE_REQUEST || type === PLATE_RESULT
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
/**
 * Replies a daemon used to send in the clear, and to every web client: sealed to the requester now.
 * Only the replies. Their requests keep the rule they had (sealed only where STRICT_DOWN_TYPES says, to
 * a daemon whose welcome says it opens them), because an older daemon reads a sealed request as empty.
 * No client tells the daemon it can open these, and none has to: every client that holds a session
 * opens a sealed payload of any type with its session key, and has since it was written (relayClient.ts
 * and relay_session_crypto.dart in the desktop and phone apps, `unwrapIncoming`). A requester with no
 * session gets the bare E2EE_REQUIRED a refused request already gets, and a window on this computer the
 * plain reply it always had.
 */
const SEALED_REPLIES = new Set([
  // What a pane runs and where: its folder, pid and tty.
  'terminal_info_result',
  // The rest of what a machine tells the client that asked about it: its Store harnesses, its engines
  // and their versions, its grids and models, the login an engine uses (with the computer's name), a
  // move onto a model, and a terminal handed between machines (refused over the relay).
  'dsh_list_result', 'dsh_install_result', 'dsh_update_result', 'dsh_remove_result',
  'engines_probe_result', 'grid_models_list_result', 'claude_login_status_result', 'agent_retarget_result',
  'remote_terminal_handoff_result',
])
export const encryptRpcResult = (type: string): boolean =>
  ENCRYPTED_RPC_RESULT_TYPES.has(type) || MACHINE_RESULTS.has(type) || FLEET_RESULTS.has(type) || SHARE_RESULT_TYPES.has(type)
  || PAIR_RESULTS.has(type) || type === LOCAL_PAIR_RESULT || type === QUESTION_RESULT || type === PLATE_RESULT || TEAM_RESULT_TYPES.has(type)
  || SEALED_REPLIES.has(type)
