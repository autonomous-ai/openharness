import { isBuddy, isBuddyChat } from './buddies.js'
import type { PrismaClient } from '@prisma/client'
import { ensureIndex } from '../lib/db/indexes.js'
import { activeWork, actorKey, agent, author, conversation, fail, isLeads, stableId, SuperTabError, type Actor, type Agent, type Author, type Conversation, type MessageDraft,
  type SuperTabState } from './model.js'
import { downSince, productManagerOn } from './machines.js'
import { agentProjectId, isConfidential, ledProject, onTeamAccount, ownSession, projectAgent, projectOf, readAgent, teamSessionAccess } from './projects.js'
import { redactCredentials } from './credentials.js'

/** Any agent of an agent's project, or a person with write access, reads and types in its terminal through the host of its
 * machine (spec/2026-10-23-lead-sees-agent-terminal.md; project instructions, phase 4).
 * The request and its answer live in SuperTabTerminalRequest, never in the tab state or group history, because a screen can show secrets. */
export const TERMINAL_KEYS = ['Enter', 'Esc', 'Tab', 'Up', 'Down', 'Left', 'Right', 'Ctrl-C', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9'] as const
/** The host has this long to pick a request up, then this long to answer it; after either, the request fails with a plain reason. */
export const TERMINAL_PICKUP_MS = 10_000
export const TERMINAL_ANSWER_MS = 30_000
/** A sender's wait reads its request again this often even unwoken, in case the notice of its answer was lost. */
export const TERMINAL_RECHECK_MS = 5_000
/** An unread answer, which can hold a screen's secrets, is gone after this long: refused on read, and removed by a TTL index. */
export const TERMINAL_EXPIRY_MS = 120_000
/** Run by the singleton worker at startup, like the product-usage expiry indexes. */
export async function ensureTerminalExpiry(db: PrismaClient): Promise<void> {
  await ensureIndex(db, 'SuperTabTerminalRequest', { key: { createdAt: 1 }, name: 'terminal_request_expiry', expireAfterSeconds: TERMINAL_EXPIRY_MS / 1000 })
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

/** Any agent of the agent's project (project instructions, phase 4), or a person with write access who can see the agent, reads
 *  or types in its terminal; a private one stays its own machine owner's. `elsewhere`: the agent's session is confidential in
 *  another Swarm (confidential.ts). */
export function mayDrive(state: SuperTabState, actor: Actor, target: Agent, elsewhere = false, kind: TerminalKind = 'input'): void {
  // For both kinds of requester: no person or agent reads a confidential session but its own (final review, Critical 1).
  const closed = () => {
    // A Team account holding a Product Manager: every agent there is one macOS user, which reads people's chats with it,
    // so no person types in any of them (security review 2 of #2089). Nor does any agent read or type in them, but the
    // session itself and the Product Manager there, which already runs as that user (review of phase 4, task 1). They
    // talk to them in their groups' chats.
    if (onTeamAccount(state, target) && productManagerOn(state, target.machineId)) {
      if (actor.kind === 'person' && kind === 'input') {
        fail('TERMINAL_PRIVATE', `${target.displayName ?? target.name} runs in a Harness Team account that holds a Product Manager, so nobody types in it through the Swarm. Talk to it in its group's chat.`, 403)
      }
      const self = actor.kind === 'agent' ? state.agents.find(a => a.id === actor.agentId) : undefined
      const sameUser = !!self && (ownSession(actor, target) || (self.machineId === target.machineId && !!ledProject(state, self.id)))
      if (actor.kind === 'agent' && !sameUser) {
        fail('TERMINAL_PRIVATE', `${target.displayName ?? target.name} runs in a Harness Team account that holds a Product Manager, so no other agent reads or types in it through the Swarm. Talk to it in its group's chat.`, 403)
      }
    }
    // In a Harness Team account: its project's owner reads its screen, and nobody types in it (projects.ts teamSessionAccess).
    const team = teamSessionAccess(state, actor, target, elsewhere)
    if (team === 'watch' && kind === 'screen') return
    if (team) {
      fail('TERMINAL_PRIVATE', `This ${ledProject(state, target.id) ? 'Product Manager' : 'agent'} runs in a Harness Team account: nobody types in it through the Swarm, and only its project's owner reads its screen. Talk to it in its project's chat.`, 403)
    }
    // Members may watch a Lead, but only its machine's owner drives it, whether or not its session counts as private (Ken, 2026-10-28).
    if (ledProject(state, target.id) && !ownSession(actor, target)) {
      fail('TERMINAL_PRIVATE', 'Only the person whose machine runs this agent can read or type in a Product Manager’s terminal.', 403)
    }
    if (isConfidential(state, target, elsewhere) && !ownSession(actor, target)) {
      fail('TERMINAL_PRIVATE', 'Only the person whose machine runs this agent can read or type in its terminal: it holds people’s private chats with the Product Manager.', 403)
    }
  }
  if (actor.kind === 'person') {
    author(state, actor, true)
    readAgent(state, actor, target.id)
    return closed()
  }
  closed()
  if (!projectAgent(state, actor, agentProjectId(state, target))) {
    fail('FORBIDDEN', 'Only an agent of this agent’s project, or a person with write access, can read or type in its terminal.', 403)
  }
  // An agent never drives further than the person whose machine runs it, whose own sign-in speaks for it: a teammate hosting
  // an agent of a private project they cannot read would otherwise type, through it, into the project's agents on other
  // people's logins (security review S1). Agents on one login drive each other as before, and the project's coordinator keeps
  // driving its project's agents wherever it runs (it unblocks an agent stuck on a prompt). Every path checks here: the
  // request, the host's pickup (store.ts terminalRefusal) and the answer's read (store.ts terminalResult).
  if (actor.machineOwnerId === target.machineOwnerId) return
  if (ledProject(state, actor.agentId)?.id === agentProjectId(state, target)) return
  try {
    mayDrive(state, { kind: 'person', userId: actor.machineOwnerId, email: '' }, target, elsewhere, kind)
  } catch (error) {
    if (!(error instanceof SuperTabError)) throw error
    fail('FORBIDDEN', 'An agent reads or types in another agent’s terminal only where the person whose machine runs it could.', 403)
  }
}

/** The group a terminal row belongs in: the agent's active work, else its newest open project group as a member (never the
 *  Swarm-wide Leads conversation), else its project's Lead chat. */
export function currentGroup(state: SuperTabState, target: Agent): Conversation {
  // A Buddy's rows are its person's alone, in its own chat: it has no PM, and a Swarm-wide one no project (Dee, 10-31).
  const own = isBuddy(target) ? state.conversations.find(c => isBuddyChat(c) && c.agentIds.includes(target.id)) : undefined
  if (own) return own
  return state.conversations.find(c => activeWork(c) && c.assignment!.agentId === target.id)
    ?? state.conversations.findLast(c => !c.archived && !isLeads(c) && !c.audience && c.agentIds.includes(target.id) && c.leadId !== target.id)
    ?? conversation(state, projectOf(state, agentProjectId(state, target)).leadConversationId)
}

const nameOf = (target: Agent) => target.displayName ?? target.name

/** Where a thread session's rows go: its own thread, marked as its session's and with its project, so its main Buddy never
 *  reads them and they hide once its person loses that project (buddySessions.ts; security review 2 of #2435). */
const inSessionThread = (target: Agent): Partial<MessageDraft> => target.buddySession
  ? { replyTo: target.buddySession.thread, thread: target.buddySession.thread, buddySession: true,
    ...(target.buddySession.projectId ? { buddyProject: target.buddySession.projectId } : {}) }
  : {}

export function terminalRequest(state: SuperTabState, actor: Actor, sender: Author, id: string, now: number,
  command: { type: 'agent.screen' | 'agent.input'; agentId: string; scrollback?: number; text?: string; keys?: string[] }, elsewhere = false) {
  const target = agent(state, command.agentId)
  mayDrive(state, actor, target, elsewhere, command.type === 'agent.screen' ? 'screen' : 'input')
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
    text: `${who} typed ${shown} in ${nameOf(target)}'s terminal`, source: { kind: 'terminal-input', agentId: target.id, requestId: id },
    ...inSessionThread(target) }
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
  let text = `${nameOf(target)} is waiting at a prompt in its terminal.`
  const source: Record<string, unknown> = { kind: 'terminal-alert', agentId: target.id, alert: command.alert }
  if (command.alert === 'limit') {
    const reset = command.resetAt && Date.parse(command.resetAt) > now ? Date.parse(command.resetAt) : now + LIMIT_FALLBACK_MS
    target.limitedUntil = source.limitedUntil = new Date(reset).toISOString()
    text = `${nameOf(target)} hit a usage limit. Routing skips it until ${target.limitedUntil.slice(11, 16)} UTC.`
  }
  // Its engine has been retrying its model for 10 minutes (2026-10-24: a Builder on a small local model retried for an
  // hour while its Lead waited on it).
  if (command.alert === 'model') text = `${nameOf(target)} can't get answers from its model: its requests keep failing.`
  // A Buddy's alert is its owner's alone, in their chat: the PM neither reads that chat nor runs the Buddy (buddies.ts).
  const chat = isBuddy(target) ? state.conversations.find(c => isBuddyChat(c) && c.agentIds.includes(target.id)) : undefined
  if (chat) return [{ id, conversationId: chat.id, author: sender, replyTo: null, recipients: [], text, source, ...inSessionThread(target) }]
  return toLead(state, target, { id, conversationId: group.id, author: sender, replyTo: null, recipients: [], text, source })
}

/** The project Lead of an agent, unless the agent is that Lead. */
export function leadOf(state: SuperTabState, target: Agent): Agent | undefined {
  // A Buddy answers to its person alone, never to a PM; a Swarm-wide one has no project (Dee, 10-31).
  if (target.buddyOf) return undefined
  const lead = conversation(state, projectOf(state, agentProjectId(state, target)).leadConversationId).leadId
  return lead && lead !== target.id ? state.agents.find(a => a.id === lead) : undefined
}

/** A row about an agent, delivered to its project Lead: in the row's group when the Lead is there, else by a second row in
 *  the Lead's chat. */
export function toLead(state: SuperTabState, target: Agent, row: MessageDraft): MessageDraft[] {
  const chat = conversation(state, projectOf(state, agentProjectId(state, target)).leadConversationId)
  const lead = leadOf(state, target)?.id
  const here = !!lead && conversation(state, row.conversationId).agentIds.includes(lead)
  const first = { ...row, recipients: here ? [lead] : [] }
  return here || !lead || !chat.agentIds.includes(lead) ? [first] : [first, { ...first, id: stableId(row.id, 'lead'), conversationId: chat.id, recipients: [lead] }]
}
