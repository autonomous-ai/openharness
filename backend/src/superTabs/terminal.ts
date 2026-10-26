import type { PrismaClient } from '@prisma/client'
import { activeWork, actorKey, agent, author, conversation, fail, isLeads, stableId, type Actor, type Agent, type Author, type Conversation, type MessageDraft,
  type SuperTabState } from './model.js'
import { downSince } from './machines.js'
import { agentProjectId, projectOf, readAgent } from './projects.js'
import { redactCredentials } from './credentials.js'

/** The Lead reads and types in an agent's terminal through the host of the agent's machine (spec/2026-10-23-lead-sees-agent-terminal.md).
 * The request and its answer live in SuperTabTerminalRequest, never in the tab state or group history, because a screen can show secrets. */
export const TERMINAL_KEYS = ['Enter', 'Esc', 'Tab', 'Up', 'Down', 'Left', 'Right', 'Ctrl-C', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9'] as const
/** The host has this long to pick a request up, then this long to answer it; after either, the request fails with a plain reason. */
export const TERMINAL_PICKUP_MS = 10_000
export const TERMINAL_ANSWER_MS = 30_000
/** An unread answer, which can hold a screen's secrets, is gone after this long: refused on read, and removed by a TTL index. */
export const TERMINAL_EXPIRY_MS = 120_000
/** Run by the singleton worker at startup, like the product-usage expiry indexes. */
export async function ensureTerminalExpiry(db: PrismaClient): Promise<void> {
  await db.$runCommandRaw({ createIndexes: 'SuperTabTerminalRequest', indexes: [{ key: { createdAt: 1 }, name: 'terminal_request_expiry',
    expireAfterSeconds: TERMINAL_EXPIRY_MS / 1000 }] })
}
/** A limited agent without a shown reset time is skipped by routing for this long. */
export const LIMIT_FALLBACK_MS = 3_600_000

export type TerminalKind = 'screen' | 'input'
export type TerminalEffect =
  | { op: 'request'; id: string; kind: TerminalKind; agentId: string; machineId: string; machineOwnerId: string; harnessId: string; requesterKey: string;
    scrollback?: number; text?: string; keys?: string[] }
  | { op: 'result'; id: string; ok: boolean; text: string | null; error: string | null }
/** A stored request as the store reads it for an answer. */
export interface TerminalRequest { id: string; agentId: string; harnessId: string; kind: TerminalKind; status: 'pending' | 'claimed' | 'done' }

/** Only the Lead of the agent's project, or a person with write access who can see the agent, reads or types in its terminal. */
export function mayDrive(state: SuperTabState, actor: Actor, target: Agent): void {
  if (actor.kind === 'person') {
    author(state, actor, true)
    readAgent(state, actor, target.id)
    return
  }
  if (conversation(state, projectOf(state, agentProjectId(state, target)).leadConversationId).leadId !== actor.agentId) {
    fail('LEAD_REQUIRED', 'Only the Lead of this agent’s project, or a person with write access, can read or type in its terminal.', 403)
  }
}

/** The group a terminal row belongs in: the agent's active work, else its newest open project group as a member (never the
 *  Swarm-wide Leads conversation), else its project's Lead chat. */
export function currentGroup(state: SuperTabState, target: Agent): Conversation {
  return state.conversations.find(c => activeWork(c) && c.assignment!.agentId === target.id)
    ?? state.conversations.findLast(c => !c.archived && !isLeads(c) && !c.audience && c.agentIds.includes(target.id) && c.leadId !== target.id)
    ?? conversation(state, projectOf(state, agentProjectId(state, target)).leadConversationId)
}

const nameOf = (target: Agent) => target.displayName ?? target.name

export function terminalRequest(state: SuperTabState, actor: Actor, sender: Author, id: string, now: number,
  command: { type: 'agent.screen' | 'agent.input'; agentId: string; scrollback?: number; text?: string; keys?: string[] }) {
  const target = agent(state, command.agentId)
  mayDrive(state, actor, target)
  if (downSince(state, target, now)) fail('HOST_OFFLINE', `${nameOf(target)}’s terminal is not running or its machine is offline.`)
  const { type: _type, agentId: _agentId, ...detail } = command
  const effect: TerminalEffect = { op: 'request', id, kind: command.type === 'agent.screen' ? 'screen' : 'input', agentId: target.id,
    machineId: target.machineId, machineOwnerId: target.machineOwnerId, harnessId: target.harnessId, requesterKey: actorKey(actor), ...detail }
  if (command.type === 'agent.screen') return { effect, message: null, removed: [] }
  // The host types the exact text; the group's row never shows a credential in it, even one the cut at 200 would split.
  const typed = redactCredentials(command.text ?? '')
  const text = command.text && `\`${typed.text.length > 200 ? `${typed.text.slice(0, 199)}…` : typed.text}\``
  const shown = [text, ...command.keys ?? []].filter(Boolean).join(' + ')
  const who = sender.displayName ?? (sender.kind === 'person' ? sender.name.split('@')[0]! : sender.name)
  const message: MessageDraft = { id, conversationId: currentGroup(state, target).id, author: sender, replyTo: null, recipients: [],
    text: `${who} typed ${shown} in ${nameOf(target)}'s terminal`, source: { kind: 'terminal-input', agentId: target.id, requestId: id } }
  return { effect, message, removed: typed.removed }
}

/** Only the host of the agent's current terminal answers, once, a request it claimed. */
export function terminalResult(state: SuperTabState, actor: Actor, request: TerminalRequest | undefined,
  command: { type: 'agent.screenResult' | 'agent.inputResult'; ok: boolean; text?: string; error?: string }): TerminalEffect {
  if (!request) fail('NOT_FOUND', 'This terminal request is unavailable.', 404)
  const target = agent(state, request.agentId)
  if (actor.kind !== 'agent' || actor.agentId !== target.id || target.harnessId !== request.harnessId) {
    fail('HOST_REQUIRED', 'Only the host of this agent’s terminal answers its requests.', 403)
  }
  if (request.kind !== (command.type === 'agent.screenResult' ? 'screen' : 'input')) fail('REQUEST_MISMATCH', 'Answer this request with its own kind of result.', 400)
  if (request.status !== 'claimed') fail('REQUEST_CLOSED', 'This terminal request is no longer waiting for an answer.')
  return { op: 'result', id: request.id, ok: command.ok, text: command.ok && request.kind === 'screen' ? command.text ?? '' : null,
    error: command.ok ? null : command.error! }
}

/** One row per episode: a repeated observation adds nothing, and `active: false` ends the episode. No screen text goes in the row.
 * It is delivered to the agent's project Lead, in the agent's group when the Lead is there, else by a second row in the Lead's chat. */
export function terminalAlert(state: SuperTabState, actor: Actor, sender: Author, id: string, now: number,
  command: { agentId: string; alert: 'prompt' | 'limit' | 'model'; active: boolean; resetAt?: string }): MessageDraft[] {
  const target = agent(state, command.agentId)
  if (actor.kind !== 'agent' || actor.agentId !== target.id) fail('HOST_REQUIRED', 'Only the host of this agent’s terminal reports its alerts.', 403)
  const alerting = target.alerting ?? []
  if (!command.active) {
    target.alerting = alerting.filter(a => a !== command.alert)
    return []
  }
  if (alerting.includes(command.alert)) return []
  target.alerting = [...alerting, command.alert]
  const group = currentGroup(state, target)
  const chat = conversation(state, projectOf(state, agentProjectId(state, target)).leadConversationId)
  const lead = chat.leadId && chat.leadId !== target.id ? chat.leadId : null
  let text = `${nameOf(target)} is waiting at a prompt in its terminal.`
  const source: Record<string, unknown> = { kind: 'terminal-alert', agentId: target.id, alert: command.alert }
  if (command.alert === 'limit') {
    const reset = command.resetAt && Date.parse(command.resetAt) > now ? Date.parse(command.resetAt) : now + LIMIT_FALLBACK_MS
    target.limitedUntil = source.limitedUntil = new Date(reset).toISOString()
    text = `${nameOf(target)} hit a usage limit. Routing skips it until ${target.limitedUntil.slice(11, 16)} UTC.`
  }
  // Its engine has been retrying its model for 10 minutes (2026-10-24: a Builder on a small local model retried for an
  // hour while its Lead waited on it).
  if (command.alert === 'model') text = `${nameOf(target)} can't get answers from its model: its requests keep failing. Stop it, or give the work to another model.`
  const here = !!lead && group.agentIds.includes(lead)
  const row = { id, conversationId: group.id, author: sender, replyTo: null, recipients: here ? [lead] : [], text, source }
  return here || !lead || !chat.agentIds.includes(lead) ? [row] : [row, { ...row, id: stableId(id, 'lead'), conversationId: chat.id, recipients: [lead] }]
}
