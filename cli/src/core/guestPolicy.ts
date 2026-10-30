/**
 * What a GUEST may ask this machine (docs/plans/2026-10-19-guest-machine-sharing-plan.md).
 *
 * A guest is a session trusted only because the owner shares this machine with its account
 * (RemoteClient.guest, set by the gateway from the paired key's `sharedWith`). It gets its own space:
 * the harnesses it starts — which run as its own OS user — and nothing of the owner's. So this is a
 * DEFAULT-DENY list: a request type not named here is refused, including every one added later.
 *
 * Checked once per frame by the core (backendSocket.ts `dispatchDown`) before anything else answers it;
 * the gateway refuses its own pairing requests for a guest (gateway/gateway.ts).
 */

import { GUEST_LAUNCH_ENGINES } from '../lib/guestPaneCommand.js'

/** Answered for a guest as for anyone, scoped by the handler (`agents_list` lists only its agents). */
const ANY: ReadonlySet<string> = new Set([
  'agents_list',
  'agent_create', 'agent_create_status', 'agent_create_cancel',
  'engines_probe',
  'theme_set',
  // The owner's plan limits, which a guest's harness uses through the subscription relay.
  'usage_read',
  // Where it may start a harness: its workspace and the folders the owner shares with guests.
  'guest_folders',
  // Stream-scoped: a stream answers only the connection that opened it (lib/terminalStreamManager.ts), and
  // `terminal_open` below admits only the guest's own agents.
  'terminal_capabilities', 'terminal_alive', 'terminal_ack', 'terminal_input', 'terminal_resize',
  'terminal_paste', 'terminal_paste_image', 'terminal_paste_file',
  'terminal_chunked_upload_begin', 'terminal_chunked_upload_cancel',
  'terminal_scroll', 'terminal_resync', 'terminal_close',
])

/** Answered only for an agent the guest started (`payload.agentId`). Not resume, restart or retarget: those
 *  relaunch a pane the owner's way, as the owner (GUEST_HARNESS_REFUSAL below). */
const OWN_AGENT: ReadonlySet<string> = new Set([
  'terminal_open', 'terminal_info',
  'agent_update', 'agent_close', 'agent_delete',
  'message', 'cancel', 'question_response',
])

export type GuestVerdict = { allow: true } | { allow: false; error: 'GUEST_NOT_ALLOWED' | 'NOT_YOUR_HARNESS' }

/**
 * Whether a guest may send `type`. [guestOf]: the guest (email) an agent was started for, or null for
 * the owner's own — read from the registry, never from the payload.
 */
export function guestVerdict(type: string, payload: Record<string, unknown>, guest: string,
  guestOf: (agentId: string) => string | null | undefined): GuestVerdict {
  if (ANY.has(type)) {
    // A guest's harness is Claude Code or Codex on the owner's subscription (lib/guestPaneCommand.ts): never a
    // grid or a saved API, which are keys of the owner's, and never a cloud harness, which is the owner's account.
    if (type === 'agent_create' && (payload.grid !== undefined || payload.apiConnection !== undefined
      || typeof payload.engine !== 'string' || !GUEST_LAUNCH_ENGINES.includes(payload.engine))) {
      return { allow: false, error: 'GUEST_NOT_ALLOWED' }
    }
    return { allow: true }
  }
  if (OWN_AGENT.has(type)) {
    const agentId = typeof payload.agentId === 'string' ? payload.agentId : ''
    // Nothing of an unknown guest is its own: a store that did not record whom the machine is shared
    // with names the guest '', and '' owns nothing.
    if (!agentId || !guest || guestOf(agentId) !== guest) return { allow: false, error: 'NOT_YOUR_HARNESS' }
    return { allow: true }
  }
  return { allow: false, error: 'GUEST_NOT_ALLOWED' }
}

/** The harness an outgoing event is about (its top-level `agentId`, the payload's `agentId`, or the agent
 *  it carries), or null: whose guest, if any, is sent it sealed for its sessions (gateway/gateway.ts). */
export function eventAgentId(frame: { agentId?: unknown; payload?: unknown }): string | null {
  const payload = frame.payload as { agentId?: unknown; agent?: { id?: unknown } } | undefined
  if (typeof frame.agentId === 'string' && frame.agentId) return frame.agentId
  if (typeof payload?.agentId === 'string' && payload.agentId) return payload.agentId
  if (typeof payload?.agent?.id === 'string' && payload.agent.id) return payload.agent.id
  return null
}

/**
 * What a relaunch of a guest's harness answers, whoever asks: restart, resume, retarget, fork and the boot's
 * restore all build an owner's launch, which would run the guest's harness as the owner, with the owner's
 * keys, in a folder the owner may only read. A guest starts a new harness instead.
 */
export const GUEST_HARNESS_REFUSAL = {
  ok: false, error: 'GUEST_HARNESS', detail: 'On a computer shared with you, harnesses can\'t be restarted, resumed, moved or forked. Start a new one.',
} as const

/** What a guest is told when it is refused. */
export const GUEST_REFUSALS: Record<'GUEST_NOT_ALLOWED' | 'NOT_YOUR_HARNESS', string> = {
  GUEST_NOT_ALLOWED: 'That isn\'t available on a computer shared with you.',
  NOT_YOUR_HARNESS: 'That harness is not yours.',
}
