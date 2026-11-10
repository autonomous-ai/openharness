import type { PrismaClient } from '@prisma/client'
import { ensureIndex } from '../lib/db/indexes.js'
import { actorKey, agent, author, conversation, fail, stableId, SuperTabError, type Actor, type Agent, type MessageDraft, type SuperTabState } from './model.js'
import { downSince } from './machines.js'
import { agentProjectId, NO_PROJECT, isConfidential, ledProject, ownSession, projectAgent, projectOf, readAgent } from './projects.js'

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
export function mayDrive(state: SuperTabState, actor: Actor, target: Agent, elsewhere: boolean, kind: TerminalKind): void {
  // For both kinds of requester: no person or agent reads a confidential session but its own (final review, Critical 1).
  const closed = () => {
    // Members may watch a Lead, but only its machine's owner drives it, whether or not its session counts as private (Ken, 2026-10-28).
    if (ledProject(state, target.id) && !ownSession(actor, target)) {
      fail('TERMINAL_PRIVATE', 'Only the person whose machine runs this agent can read or type in a Product Manager’s terminal.', 403)
    }
    if (isConfidential(state, target, elsewhere) && !ownSession(actor, target)) {
      fail('TERMINAL_PRIVATE', 'Only the person whose machine runs this agent can read or type in its terminal: it holds people’s private chats with the Product Manager.', 403)
    }
  }
  // Swarm v4 (anh Dee, 2026-11-11): only an agent's own login types into it, the person whose machine runs it or their own
  // agents. One person's work never runs under another's login; a cross-login ask goes as a message, read as data. Asked after
  // the checks above, so a refusal says nothing of an agent the actor may not see.
  const ownLogin = () => {
    if (kind !== 'input') return
    const own = actor.kind === 'person' ? actor.userId === target.machineOwnerId
      : actor.machineOwnerId === target.machineOwnerId && agent(state, actor.agentId).contributorId === target.machineOwnerId
    if (!own) fail('FORBIDDEN', 'Only the person whose machine runs this agent, or their own agents, type in its terminal.', 403)
  }
  if (actor.kind === 'person') {
    author(state, actor, true)
    readAgent(state, actor, target.id)
    closed()
    return ownLogin()
  }
  closed()
  if (!projectAgent(state, actor, agentProjectId(state, target))) {
    fail('FORBIDDEN', 'Only an agent of this agent’s project, or a person with write access, can read or type in its terminal.', 403)
  }
  ownLogin()
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

const nameOf = (target: Agent) => target.displayName ?? target.name

/** A read of or keys typed into an agent's terminal, for its host to carry out. Swarm v4 writes no chat row for either. */
export function terminalRequest(state: SuperTabState, actor: Actor, id: string, now: number,
  command: { type: 'agent.screen' | 'agent.input'; agentId: string; scrollback?: number; text?: string; keys?: string[] }, elsewhere = false): TerminalEffect {
  const target = agent(state, command.agentId)
  mayDrive(state, actor, target, elsewhere, command.type === 'agent.screen' ? 'screen' : 'input')
  if (downSince(state, target, now)) fail('HOST_OFFLINE', `${nameOf(target)}’s terminal is not running or its machine is offline.`)
  const { type: _type, agentId: _agentId, ...detail } = command
  return { op: 'request', id, kind: command.type === 'agent.screen' ? 'screen' : 'input', agentId: target.id,
    machineId: target.machineId, machineOwnerId: target.machineOwnerId, harnessId: target.harnessId, requesterKey: actorKey(actor), ...detail }
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

/** One mark per episode: a repeated observation changes nothing, and `active: false` ends the episode. Swarm v4 writes no chat
 *  row: its person's own Desktop says the agent waits on them. A usage limit marks the agent until its reset time, or an hour. */
export function terminalAlert(state: SuperTabState, actor: Actor, now: number,
  command: { agentId: string; alert: 'prompt' | 'limit' | 'model'; active: boolean; resetAt?: string }): void {
  const target = agent(state, command.agentId)
  if (actor.kind !== 'agent' || actor.agentId !== target.id) fail('HOST_REQUIRED', 'Only the host of this agent’s terminal reports its alerts.', 403)
  const alerting = target.alerting ?? []
  if (!command.active) {
    target.alerting = alerting.filter(a => a !== command.alert)
    // The notice is gone: so is the mark, whatever time it named (task #2321: River stayed "limited" after its notice went).
    if (command.alert === 'limit') target.limitedUntil = null
    return
  }
  if (alerting.includes(command.alert)) return
  target.alerting = [...alerting, command.alert]
  if (command.alert === 'limit') {
    const reset = command.resetAt && Date.parse(command.resetAt) > now ? Date.parse(command.resetAt) : now + LIMIT_FALLBACK_MS
    target.limitedUntil = new Date(reset).toISOString()
  }
}

/** The project Lead of an agent, unless the agent is that Lead. */
export function leadOf(state: SuperTabState, target: Agent): Agent | undefined {
  // An agent in no project has none: a Regular one between tasks (task #4116).
  if (agentProjectId(state, target) === NO_PROJECT) return undefined
  const lead = conversation(state, projectOf(state, agentProjectId(state, target)).leadConversationId).leadId
  return lead && lead !== target.id ? state.agents.find(a => a.id === lead) : undefined
}

/** A row about an agent, delivered to its project Lead: in the row's group when the Lead is there, else by a second row in
 *  the Lead's chat. */
export function toLead(state: SuperTabState, target: Agent, row: MessageDraft): MessageDraft[] {
  if (agentProjectId(state, target) === NO_PROJECT) return [{ ...row, recipients: [] }]
  const chat = conversation(state, projectOf(state, agentProjectId(state, target)).leadConversationId)
  const lead = leadOf(state, target)?.id
  const here = !!lead && conversation(state, row.conversationId).agentIds.includes(lead)
  const first = { ...row, recipients: here ? [lead] : [] }
  return here || !lead || !chat.agentIds.includes(lead) ? [first] : [first, { ...first, id: stableId(row.id, 'lead'), conversationId: chat.id, recipients: [lead] }]
}
