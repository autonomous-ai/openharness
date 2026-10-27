import { contributedEngines, expireRemovals, LASTING_TEAM_REFUSALS, machineContribution, machineObservationSchema, machineSlots, observedPrivacy, recordAgentPresence, removalPreview, startPreparing, swarmGridRow, teamAccountRequired, teamWorkRefusal, type MachineObservation } from './machines.js'
import { createHash } from 'node:crypto'
import type { Prisma, PrismaClient, SuperTab, SuperTabDelivery, SuperTabMessage } from '@prisma/client'
import type { AuthUser } from '../lib/ssoAuth.js'
import { machineAlive } from '../lib/prisma.js'
import { isTeamSession, teamMachine, TEAM_SESSION_LIMITED, TEAM_SESSION_MESSAGE } from '../lib/teamSession.js'
import { machineShareGrant, sharedVia } from '../lib/machineSharePolicy.js'
import { machineBillingAllowsDataPlane } from '../lib/billingState.js'
import { applyCommand, authorizeCommandAccess, operationSchema, PAIR_CHAIN_LIMIT, postable, type Command, type CommandContext } from './commands.js'
import { redactCredentials } from './credentials.js'
import { attachmentMime, attachmentName, AttachmentTooLarge, checkedType, MAX_ATTACHMENT_BYTES, objectKeyFor, publicUrl, type Attachment, type Attachments } from './attachments.js'
import { randomBytes } from 'node:crypto'
import type { Readable } from 'node:stream'
import { logger } from '../utils/logger.js'
import { canReadAgent, canReadGroup, canWatchAgent, groupProject, ledProject, projectOf, projectsOf, agentProjectId, readConversation, roleVersion, type ProjectVisibility } from './projects.js'
import { bindSession, makeProjectPrivate } from './sessionScope.js'
import { confidentialSessions, otherRegistrations, recordConfidential } from './confidential.js'
import { answersRequest, dirtyGroups, noteProjectReports, projectUpdateRequest } from './projectUpdates.js'
import { digestDue, digestRequest, digestSince } from './digest.js'
import { judgedMachines, loseTasks, sweepLiveness, SWEEP_EVERY_MS } from './liveness.js'
import { archivable, archiveLine, stopIdleWorkers, stoppedMachines } from './tidy.js'
import { clock, insertParts, lastChangedAt, loadActive, reassemble, split, type HeadData, type SwarmParts } from './parts/index.js'
import { commitParts, indexesOf, numberMessages, type Touch, type Written } from './parts/commit.js'
import { touchesFor } from './parts/touches.js'
import { revokeNativeContexts, SuperTabNativeStore } from './native.js'
import {
  activeWork, actorKey, agent, agentOnly, agentRole, appendPullRequestUrls, author, conversation, createSuperTab, fail, person, stableId, visibleState, finishWorker,
  SuperTabError, isLeads, parkLaterConversations, syncLeads, type Actor, type Agent, type Assignment, type Author, type Conversation, type MessageDraft, type SuperTabState,
} from './model.js'
import type { HoldReason } from './holdReason.js'
import { agentDisplayName } from './agentNames.js'
import { endedHolds, HOLDING, type WorkHold } from '../github/holds.js'
import { accrueLent } from './leaderboard/lent.js'
import { mayDrive, TERMINAL_ANSWER_MS, TERMINAL_EXPIRY_MS, TERMINAL_PICKUP_MS, type TerminalEffect } from './terminal.js'
import { closeAssignment, closeUnassignedStart, readDecision, timedDecisionOf, writeRouteEffects } from './routeDecisions.js'
import { listMentions, markDone, mentionsWaiting, readMention, resolveByReply, writeMentions } from './mentions.js'
import { answerable, listDecisions, readAskedDecision, recordAnswer, waitingIn, waitingInProject, writeDecisions } from './decisions.js'
import { DEFAULT_ROUTING_POLICY, effectivePolicy, routingPolicySchema, type RoutingPolicy } from './routingPolicy.js'
import { authenticatedEmail, authorizeSwarmJoin, configureSharing, joinSwarmSchema, requireSharingOwner,
  saveSharingSchema, sharingDetails, type JoinSwarm, type SaveSharing } from './sharing.js'

type Transaction = Prisma.TransactionClient
const json = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue
type SendCommand = Extract<Command, { type: 'message.send' }>
// Prisma on MongoDB: `usedBy: null` alone misses rows that never had the field.
const unused = { OR: [{ usedBy: null }, { usedBy: { isSet: false } }] }
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
/** A Swarm whose state still waits for its split into parts (design section 6.1) is not served until it is split. */
function requireParts(row: SuperTab): SuperTab {
  if (row.format !== 2) fail('SWARM_MIGRATING', 'This Swarm is being updated. Try again in a moment.', 503)
  return row
}

/** What a command or read works on: the index row, the parts it loaded, and the state reassembled from them. */
export interface Loaded { row: SuperTab; parts: SwarmParts; state: SuperTabState }
/** Groups, agents, projects and starts a command names, loaded even when dormant or finished (design section 3.1). */
export interface Named { groupIds?: string[]; agentIds?: string[]; projectIds?: string[]; startIds?: string[]; startAgentIds?: string[]; allGroups?: boolean; includeRecentStarts?: boolean }

/** The groups, agents, projects and starts a command names in its own fields (design section 3.1). */
/** Commands that register a session or can make one a Lead or a private member: checked against the other Swarms'
 *  registrations (projects.ts requireSingleRegistration). A rebind is refused onto any terminal registered elsewhere already. */
const REGISTERS = new Set(['agent.add', 'agent.started', 'conversation.agent', 'conversation.create', 'conversation.audience', 'project.create'])
/** The session a command registers, when it names one. */
function registeredBy(state: SuperTabState, command: Command): Array<{ machineId: string; harnessId: string }> {
  if (command.type === 'agent.add') return [{ machineId: command.machineId, harnessId: command.harnessId }]
  if (command.type !== 'agent.started') return []
  const start = state.starts?.find(s => s.id === command.startId)
  return start ? [{ machineId: start.request.machineId, harnessId: command.harnessId }] : []
}

function namedFor(command: Command): Named {
  const has = (key: string) => key in command
  const field = (key: string) => (command as Record<string, unknown>)[key] as string | undefined
  const groupIds = [field('conversationId'), command.type === 'agent.start' ? command.request.conversationId : undefined,
    command.type === 'conversation.create' ? command.reviewOf : undefined,
    'askedIn' in command ? command.askedIn?.conversationId : undefined].filter((id): id is string => !!id)
  // Deleting a project or changing who reads it reaches every one of its groups, dormant ones too: their terminal
  // contexts are revoked from the groups the command loaded (native.ts revokeNativeContexts).
  return { groupIds, startIds: has('startId') ? [field('startId')!] : [],
    projectIds: command.type === 'project.delete' || command.type === 'project.sharing' ? [command.projectId] : [] }
}

/** What a receipt keeps of a command's reply besides its result: the parts it wrote and when (design section 4.7). */
interface ReceiptParts { written: Written[]; lastChangedAt: number }
const receiptParts = (written: Written[], lastChangedAt: number): ReceiptParts => ({ written, lastChangedAt })

/** A stored receipt's reply, the same as the first one; a receipt from before parts gives its tab revision instead. */
function replyOf(prior: { revision: number; result: unknown; parts: unknown }) {
  const kept = prior.parts as ReceiptParts | null
  return { result: prior.result as Record<string, unknown>, parts: kept?.written ?? [],
    ...(kept ? { lastChangedAt: kept.lastChangedAt } : prior.revision ? { legacyRevision: prior.revision } : {}) }
}

/**
 * What a delivery claim, ack or hold touches (spec ruling 9, narrowed). Removing the receiver or an agent sender, or
 * either changing generation, cancels this delivery row, which the claim writes: they conflict on the row. A person
 * sender can also lose the conversation without leaving (project sharing, a new audience), and only their part says so.
 * Touching the receiving agent made every claim of a Lead's deliveries conflict with the others and with the Lead's own
 * posts (benchmark, mixed lane: the Lead's calls ran out of retries).
 */
function deliveryTouches(delivery: SuperTabDelivery): Touch[] {
  return delivery.authorKind === 'person' ? [{ kind: 'member', key: delivery.authorId }] : []
}

/** Loads one Swarm's parts and the state commands run on. Reads never write (design ruling R8); the migration rebuilt
 *  every group's link list from its history. */
export async function loadRow(tx: Transaction, row: SuperTab, named: Named = {}): Promise<Loaded> {
  const parts = await loadActive(tx, row.id, named)
  const state = reassemble(parts)
  parkLaterConversations(state)
  syncLeads(state)
  return { row, parts, state }
}

/**
 * Retrying a transaction never repeats a host action. All effects here are durable database writes.
 *
 * Every command rewrites the whole Swarm row, and a busy Swarm is written every few seconds: on 2026-10-26 a
 * 1.16 MB row (revision 213,9xx) lost all five back-to-back retries of a person's `agent.add` to its agents' and
 * hosts' writes, and the form showed a 500 on every Check status. Retries now wait, growing and jittered, and a
 * command that still cannot get in says the Swarm is busy, as a 503: every client retries a 5xx, while a 4xx is final
 * (a 409 would stop a host's terminal recording for good, cli superTabs/native.ts). The 5 s default
 * transaction timeout also expired on that row's reads; Mongo's own transient errors (a lock wait) retry too.
 */
export async function transaction<T>(db: Pick<PrismaClient, '$transaction'>, body: (tx: Transaction) => Promise<T>,
  sleep: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms))): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try { return await db.$transaction(body, TRANSACTION_OPTIONS) } catch (error) {
      if (!retryable(error)) throw error
      if (attempt >= TRANSACTION_ATTEMPTS) {
        // A unique key still taken after every retry is a real duplicate, not contention.
        if ((error as { code?: unknown }).code === 'P2002') throw error
        fail('SWARM_BUSY', 'This Swarm is busy. Try again in a moment.', 503)
      }
      await sleep(Math.random() * Math.min(TRANSACTION_BACKOFF_CAP_MS, TRANSACTION_BACKOFF_MS * 2 ** (attempt - 1)))
    }
  }
}
const TRANSACTION_OPTIONS = { maxWait: 5_000, timeout: 15_000 }
/** The deliveries a host is still told about (the rest are answered, cancelled or confirmed). */
const OPEN_DELIVERY = ['queued', 'claimed', 'uncertain'] as const
/** Callers kept for the quiet delivery poll before the stale ones are dropped. */
const POLLED_CAP = 5_000
const TRANSACTION_ATTEMPTS = 8
const TRANSACTION_BACKOFF_MS = 50
const TRANSACTION_BACKOFF_CAP_MS = 1_500
function retryable(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const code = 'code' in error ? error.code : null
  return code === 'P2034' || code === 'P2002' || (error instanceof Error && error.message.includes('TransientTransactionError'))
}

/** A Lead's start dispatches within seconds of being recorded; one still undispatched after this long was given up. */
export const ABANDONED_START_MS = 15 * 60_000

/** The commands that start, assign or route work, which read which of the tab's machines are Team machines. */
const TEAM_WORK_COMMANDS = new Set<Command['type']>(['agent.start', 'agent.startDispatch', 'work.assign', 'conversation.agent', 'route.record', 'route.override'])

/** Starts on a not-yet-contributed machine that never dispatched, dated by their own operation receipt (starts carry no
 *  time of their own). A dispatched start may have a native session coming, so it is never counted. */
async function abandonedStarts(tx: Transaction, tabId: string, state: SuperTabState, machineId: string, now: number) {
  const candidates = (state.starts ?? []).filter(s => s.request.machineId === machineId && !s.poolGeneration && !s.dispatched && !s.harnessId && !s.error)
  if (!candidates.length) return []
  const receipts = await tx.superTabOperation.findMany({ where: { id: { in: candidates.map(s => stableId(tabId, s.actorKey, s.id)) } },
    select: { id: true, createdAt: true } })
  const recorded = new Map(receipts.map(r => [r.id, r.createdAt.getTime()]))
  return candidates.filter(s => (recorded.get(stableId(tabId, s.actorKey, s.id)) ?? 0) <= now - ABANDONED_START_MS).map(s => s.id)
}

export interface SuperTabStoreHooks {
  /** Tasks that stopped being in an agent's hands with this write (github/holds.ts): done, cancelled, stopped, given to
   *  another attempt, or their agent removed. Called after the write commits; it must not throw. */
  workEnded?: (tabId: string, ended: WorkHold[]) => void
  /** No Harness GitHub App on this server: a Mac's Harness Team account joins no Swarm and takes no teammates' work, since
   *  it has no git login to fetch or push with (commands.ts `teamAccountsIdle`). */
  teamAccountsIdle?: boolean
}

/** Persistent coordination. Host adapters own execution and must confirm their local session grants. */
/** The routing decision a command names. `decision.answer` names a person's decision instead (decisions.ts). */
const routeDecisionOf = (command: Command): string | undefined => command.type === 'decision.answer' ? undefined
  : 'decisionId' in command ? command.decisionId : 'routeDecisionId' in command ? command.routeDecisionId : undefined

export class SuperTabStore {
  readonly native: SuperTabNativeStore
  constructor(readonly db: PrismaClient, readonly now: () => number = Date.now,
    private readonly attachments: Attachments | null = null, private readonly hooks: SuperTabStoreHooks = {}) {
    this.native = new SuperTabNativeStore({
      transaction: body => transaction(db, body),
      load: (tx, user, tabId, groupIds) => this.load(tx, user, tabId, { groupIds }),
      save: (tx, loaded, next, stamp, touches) => this.save(tx, loaded as Loaded, next, stamp, touches),
      stamp: () => clock.next(),
      agentGrant: (tx, state, target) => this.agentGrant(tx, state, target),
      contribution: (tx, state, actor, command) => this.contribution(tx, state, actor, command),
      teamHost: (tx, user) => this.teamHost(tx, user),
    })
  }

  // ── A Mac's team account (lib/teamSession.ts) ────────────────────────────────────────────────────
  // Its daemon is signed in as the person, so `user.sub` alone would let it speak for the person and for every machine
  // of theirs. It may host only its own machine and speak only as the agents running there.

  /** The one machine a team session hosts for; null for any other sign-in. One with no machine to act for does nothing. */
  /** Shared with the read API (superTabs/read, design section 7.2). */
  async teamHost(tx: Transaction, user: AuthUser): Promise<string | null> {
    if (!isTeamSession(user)) return null
    return (await teamMachine(user, tx))?.machineId ?? fail(TEAM_SESSION_LIMITED, TEAM_SESSION_MESSAGE, 403)
  }

  /** A host route of a team session must name its own machine. */
  /** Shared with the read API (superTabs/read, design section 7.2). */
  async hostFor(tx: Transaction, user: AuthUser, machineId: string): Promise<void> {
    const team = await this.teamHost(tx, user)
    if (team !== null && team !== machineId) fail(TEAM_SESSION_LIMITED, TEAM_SESSION_MESSAGE, 403)
  }

  /** What only the person does: a team session has no person to be. */
  private personOnly(user: AuthUser): void {
    if (isTeamSession(user)) fail(TEAM_SESSION_LIMITED, TEAM_SESSION_MESSAGE, 403)
  }

  /**
   * What a team session's agent may command beyond the Swarm's own rules for that agent: a machine is the person's to
   * contribute, pause or remove, and nothing may start, add, move or drive an agent on another machine. Messages and
   * work reports go to the Swarm as from any agent. An agent that is gone is left to the command's own answer.
   */
  private teamCommand(state: SuperTabState, team: string, user: AuthUser, command: Command): void {
    const refuse = () => fail(TEAM_SESSION_LIMITED, TEAM_SESSION_MESSAGE, 403)
    const onTeam = (agentId: string) => {
      const target = state.agents.find(a => a.id === agentId)
      if (target && target.machineId !== team) refuse()
    }
    switch (command.type) {
      case 'machine.contribute': case 'machine.pause': case 'machine.remove': return refuse()
      case 'machine.cleaned': case 'tab.project': case 'agent.add':
        if (command.machineId !== team) refuse()
        return
      case 'agent.rebind':
        if (command.machineId !== team) refuse()
        return onTeam(command.agentId)
      case 'agent.start':
        if (command.request.machineId !== team) refuse()
        return
      case 'agent.screen': case 'agent.input': case 'work.assign': case 'conversation.agent':
      case 'agent.release': case 'agent.stopLease': case 'agent.remove':
        return onTeam(command.agentId)
      case 'agent.sessionClosed': {
        const closing = state.closingSessions?.find(c => c.agentId === command.agentId && c.harnessId === command.harnessId && c.machineOwnerId === user.sub)
        if (closing && closing.machineId !== team) refuse()
        return
      }
    }
  }

  /** The tab's contributed machines whose account row is signed in as a Harness Team account (`Machine.sessionKind`,
   *  lib/teamSession.ts): one of the two signs routing reads that a machine is a Team machine (machines.ts teamWorkCheck). */
  /** Shared with the read API (superTabs/read, design section 7.2). */
  async teamMachines(tx: Transaction, state: SuperTabState): Promise<string[]> {
    const ids = (state.machines ?? []).map(m => m.machineId)
    if (!ids.length) return []
    const rows = await tx.machine.findMany({ where: { machineId: { in: ids }, autonomousEnv: state.environment, sessionKind: 'team', ...machineAlive },
      select: { machineId: true } })
    return rows.map(r => r.machineId)
  }

  private policyId(user: AuthUser) { return stableId('routing-policy', user.sub, user.autonomousEnv) }

  async accountPolicy(user: AuthUser) {
    this.personOnly(user)
    const row = await this.db.routingPolicy.findUnique({ where: { id: this.policyId(user) } })
    if (!row) return { policy: DEFAULT_ROUTING_POLICY, revision: 0, isDefault: true }
    const { policy } = effectivePolicy(row.policy, null)
    return { policy, revision: row.revision, isDefault: false }
  }

  async saveAccountPolicy(user: AuthUser, revision: number, input: RoutingPolicy) {
    this.personOnly(user)
    const policy = routingPolicySchema.parse(input)
    return transaction(this.db, async tx => {
      const id = this.policyId(user)
      const row = await tx.routingPolicy.findUnique({ where: { id } })
      if ((row?.revision ?? 0) !== revision) fail('REVISION_CHANGED', 'The routing policy changed elsewhere. Reload it and try again.')
      const next = revision + 1
      if (row) await tx.routingPolicy.update({ where: { id, revision }, data: { revision: next, policy: json(policy) } })
      else await tx.routingPolicy.create({ data: { id, userId: user.sub, autonomousEnv: user.autonomousEnv, revision: next, policy: json(policy) } })
      return { policy, revision: next, isDefault: false as const }
    })
  }

  /** Viewers and agents read the same effective policy; it always comes from the tab owner's account. */
  async tabPolicy(user: AuthUser, tabId: string, asAgentId?: string) {
    return transaction(this.db, async tx => {
      const { state } = await this.load(tx, user, tabId)
      author(state, await this.actor(tx, user, state, asAgentId))
      const account = await tx.routingPolicy.findUnique({ where: { id: stableId('routing-policy', state.ownerId, state.environment) } })
      // The owner's account policy alone, so a field reset to "use account default" can show its value.
      return { ...effectivePolicy(account?.policy ?? null, state.routingPolicy ?? null), override: state.routingPolicy ?? null,
        account: effectivePolicy(account?.policy ?? null, null).policy }
    })
  }

  /** Shared with the read API (superTabs/read, design section 7.2). */
  async row(tx: Transaction, user: AuthUser, tabId: string) {
    return requireParts(await tx.superTab.findFirst({ where: { id: tabId, autonomousEnv: user.autonomousEnv } }) ??
      fail('NOT_FOUND', 'This Super Tab is unavailable.', 404))
  }

  /** The Swarm a caller may address, loaded from its parts. */
  async load(tx: Transaction, user: AuthUser, tabId: string, named: Named = {}): Promise<Loaded> {
    return loadRow(tx, await this.row(tx, user, tabId), named)
  }

  /** Loads again with more named groups, agents or starts when the first load lacks one a command needs. */
  private async ensure(tx: Transaction, loaded: Loaded, named: Named): Promise<Loaded> {
    if (named.allGroups) return loadRow(tx, loaded.row, named)
    const has = (ids: string[] | undefined, present: (id: string) => boolean) => (ids ?? []).every(present)
    const { state } = loaded
    if (has(named.groupIds, id => state.conversations.some(c => c.id === id)) && has(named.startIds, id => !!state.starts?.some(s => s.id === id))
      && !named.agentIds?.length && !named.projectIds?.length && !named.startAgentIds?.length) return loaded
    return loadRow(tx, loaded.row, named)
  }

  /** A Swarm with one start loaded even when finished, and the start's group even when dormant. */
  private async loadStart(tx: Transaction, user: AuthUser, tabId: string, startId: string): Promise<Loaded> {
    const loaded = await this.load(tx, user, tabId, { startIds: [startId] })
    const start = loaded.state.starts?.find(s => s.id === startId)
    return start ? this.ensure(tx, loaded, { startIds: [startId], groupIds: [start.request.conversationId] }) : loaded
  }

  /** What a command touches beyond its own fields: a named start's group, a decision's group and start, a delivery's
   *  group, and every group of the agents it removes or writes into (dormant ones too, design section 1.1 D8). */
  private async moreNamed(tx: Transaction, tabId: string, state: SuperTabState, command: Command): Promise<Named> {
    const named = namedFor(command)
    const groupIds = [...named.groupIds ?? []], startIds = [...named.startIds ?? []], agentIds: string[] = [], startAgentIds: string[] = []
    const start = 'startId' in command ? state.starts?.find(s => s.id === command.startId) : undefined
    if (start) groupIds.push(start.request.conversationId)
    const decisionId = routeDecisionOf(command)
    if (decisionId) {
      const decision = await readDecision(tx, tabId, decisionId)
      if (decision) groupIds.push(decision.conversationId)
      if (decision?.final?.kind === 'new') startIds.push(decision.final.startId)
    }
    // A person's decision may sit in a quiet or archived conversation: it is loaded to answer it (review of #1753).
    if (command.type === 'decision.answer') {
      const asked = await readAskedDecision(tx, tabId, command.decisionId)
      if (asked) groupIds.push(asked.conversationId)
    }
    if (command.type === 'delivery.resolve') {
      const delivery = await tx.superTabDelivery.findFirst({ where: { id: command.deliveryId, tabId }, select: { conversationId: true } })
      if (delivery) groupIds.push(delivery.conversationId)
    }
    if (command.type === 'agent.remove' || command.type === 'agent.input' || command.type === 'agent.alert' || command.type === 'agent.rebind') agentIds.push(command.agentId)
    if (command.type === 'agent.remove') startAgentIds.push(command.agentId)
    if (command.type === 'machine.remove') {
      const pool = state.machines?.find(m => m.machineId === command.machineId)
      const machines = new Set([command.machineId, ...(pool ? state.machines!.filter(m => m.hostMachineId === pool.machineId).map(m => m.machineId) : [])])
      agentIds.push(...state.agents.filter(a => machines.has(a.machineId)).map(a => a.id))
    }
    if (command.type === 'member.remove') {
      const machines = new Set((state.machines ?? []).filter(m => m.contributorId === command.userId).map(m => m.machineId))
      agentIds.push(...state.agents.filter(a => a.contributorId === command.userId || machines.has(a.machineId)).map(a => a.id))
    }
    return { groupIds, startIds, agentIds, startAgentIds, projectIds: named.projectIds }
  }

  /** Writes what changed between the loaded state and `next`, and touches the parts the change relied on. */
  private save(tx: Transaction, loaded: Loaded, next: SuperTabState, stamp: number, touches: Touch[] = []) {
    return commitParts(tx, loaded, next, { stamp, touches })
  }

  /** Shared with the read API (superTabs/read, design section 7.2). */
  async actor(tx: Transaction, user: AuthUser, state: SuperTabState, agentId?: string): Promise<Actor> {
    const team = await this.teamHost(tx, user)
    if (!agentId) {
      // A team session never speaks or reads as the person.
      if (team !== null) fail(TEAM_SESSION_LIMITED, TEAM_SESSION_MESSAGE, 403)
      return { kind: 'person', userId: user.sub, email: user.email }
    }
    const target = agent(state, agentId)
    if (target.machineOwnerId !== user.sub) fail('FORBIDDEN', 'Only the execution host can speak as this agent.', 403)
    // ...and as an agent only one running on its own machine, never the person's agents elsewhere.
    if (team !== null && target.machineId !== team) fail(TEAM_SESSION_LIMITED, TEAM_SESSION_MESSAGE, 403)
    await this.agentGrant(tx, state, target)
    return { kind: 'agent', agentId, machineOwnerId: user.sub }
  }

  /** Shared with the read API (superTabs/read, design section 7.2). */
  async agentGrant(tx: Transaction, state: SuperTabState, target: Agent): Promise<void> {
    const machine = await tx.machine.findFirst({ where: { machineId: target.machineId, userId: target.machineOwnerId,
      autonomousEnv: state.environment, ...machineAlive } })
    if (!machine || !machineBillingAllowsDataPlane(machine)) fail('HOST_UNAVAILABLE', 'This execution host is unavailable.', 403)
    if (target.contributorId !== machine.userId) {
      person(state, target.contributorId)
      const contributor = await tx.user.findUnique({ where: { id: target.contributorId }, select: { email: true, autonomousEnv: true } })
      const share = await tx.machineShare.findUnique({ where: { machineId: machine.machineId } })
      if (!contributor || contributor.autonomousEnv !== state.environment || !share || share.ownerId !== machine.userId ||
          share.autonomousEnv !== state.environment || !sharedVia(share, contributor.email) ||
          machineShareGrant(share, contributor.email) !== target.hostGrant) {
        fail('CONTRIBUTION_REVOKED', 'The contributor no longer has access to this machine.', 403)
      }
    }
  }

  private async contribution(tx: Transaction, state: SuperTabState, actor: Actor, command: { machineId: string }, pooled = false) {
    const contributorId = actor.kind === 'person' ? actor.userId : agent(state, actor.agentId).contributorId
    person(state, contributorId)
    const machine = await tx.machine.findFirst({ where: { machineId: command.machineId, autonomousEnv: state.environment, ...machineAlive } })
    if (!machine || !machineBillingAllowsDataPlane(machine)) fail('HOST_UNAVAILABLE', 'This machine is unavailable.', 403)
    // A Mac's Harness Team account names its Mac from its own account row, which only its owner's sign-in set (machines.ts).
    const host = machine.sessionKind === 'team' && machine.hostMachineId ? { hostMachineId: machine.hostMachineId } : {}
    if (pooled) {
      const pool = machineContribution(state, command.machineId)
      if (pool) {
        if (pool.contributorId !== machine.userId) fail('CONTRIBUTION_REVOKED', 'The machine owner changed.', 403)
        return { machineOwnerId: machine.userId, contributorId: pool.contributorId, hostGrant: null, ...host }
      }
    }
    let hostGrant: string | null = null
    if (machine.userId !== contributorId) {
      const contributor = actor.kind === 'person' ? { email: actor.email, autonomousEnv: state.environment } :
        await tx.user.findUnique({ where: { id: contributorId }, select: { email: true, autonomousEnv: true } })
      const share = await tx.machineShare.findUnique({ where: { machineId: command.machineId } })
      if (!contributor || contributor.autonomousEnv !== state.environment || !share || share.ownerId !== machine.userId ||
          share.autonomousEnv !== state.environment || !sharedVia(share, contributor.email)) {
        fail('HOST_REQUIRED', 'This machine has not been shared with the contributor.', 403)
      }
      hostGrant = machineShareGrant(share, contributor.email)
    }
    return { machineOwnerId: machine.userId, contributorId, hostGrant, ...host }
  }

  async create(user: AuthUser, operationId: string, name: string, projectVisibility?: ProjectVisibility) {
    this.personOnly(user)
    const id = stableId('super-tab', user.autonomousEnv, user.sub, operationId)
    const requestHash = hash({ name, ...(projectVisibility ? { projectVisibility } : {}) })
    return transaction(this.db, async tx => {
      const prior = await tx.superTabOperation.findUnique({ where: { id } })
      if (prior) {
        if (prior.requestHash !== requestHash) fail('OPERATION_REUSED', 'Use a new operation ID for a different request.')
        return { id, revision: prior.revision }
      }
      const state = createSuperTab(id, name, { id: user.sub, email: user.email }, user.autonomousEnv, projectVisibility)
      // Born in parts: its state lives in the Swarm* parts, and `state` only fences older backends (schema.prisma).
      await tx.superTab.create({ data: { id, ownerId: user.sub, autonomousEnv: user.autonomousEnv, ...indexesOf(state), format: 2, state: { version: 2 } } })
      await insertParts(tx, split({ ...state, sequenceBase: 0 }, { tabId: id, version: 1, now: clock.next() }))
      await tx.superTabOperation.create({ data: { id, tabId: id, actorKey: `person:${user.sub}`, requestHash, revision: 0, result: { id } } })
      return { id, revision: 0 }
    })
  }

  async list(user: AuthUser, after?: string) {
    this.personOnly(user)
    const rows = await this.db.superTab.findMany({ where: { autonomousEnv: user.autonomousEnv, memberIds: { has: user.sub },
      ...(after ? { id: { gt: after } } : {}) }, orderBy: { id: 'asc' }, take: 101 })
    const heads = await this.heads(rows.slice(0, 100))
    return { tabs: rows.slice(0, 100).flatMap(row => {
      const head = heads.get(row.id)
      return head ? [{ id: row.id, name: head.name, ownerId: row.ownerId, revision: row.revision, paused: head.paused }] : []
    }), next: rows.length > 100 ? rows[99]!.id : null }
  }

  async invitations(user: AuthUser) {
    this.personOnly(user)
    const email = user.email.trim().toLowerCase()
    const rows = await this.db.superTab.findMany({ where: { autonomousEnv: user.autonomousEnv, invitedEmails: { has: email } }, take: 100 })
    const heads = await this.heads(rows)
    return rows.flatMap(row => {
      const state = heads.get(row.id)
      if (!state) return []
      return state.invitations.filter(i => i.email === email && i.expiresAt > this.now())
        .map(i => ({ tabId: row.id, name: state.name, inviteId: i.id, role: i.role, expiresAt: i.expiresAt }))
    })
  }

  /** The heads of Swarms already split into parts, by id. */
  private async heads(rows: SuperTab[]): Promise<Map<string, HeadData>> {
    const heads = await this.db.swarmHead.findMany({ where: { id: { in: rows.filter(r => r.format === 2).map(r => `${r.id}:head`) } } })
    return new Map(heads.map(head => [head.tabId, head.data as unknown as HeadData]))
  }

  async sharing(user: AuthUser, tabId: string) {
    this.personOnly(user)
    return transaction(this.db, async tx => {
      const { state } = await this.load(tx, user, tabId)
      requireSharingOwner(state, user.sub)
      return sharingDetails(state)
    })
  }

  async saveSharing(user: AuthUser, tabId: string, input: SaveSharing) {
    this.personOnly(user)
    const request = saveSharingSchema.parse(input)
    return transaction(this.db, async tx => {
      const loaded = await this.load(tx, user, tabId), state = structuredClone(loaded.state)
      requireSharingOwner(state, user.sub)
      const receiptId = stableId('swarm-sharing', tabId, user.sub, request.operationId), requestHash = hash(request)
      const prior = await tx.superTabOperation.findUnique({ where: { id: receiptId } })
      if (prior) {
        if (prior.requestHash !== requestHash) fail('OPERATION_REUSED', 'Use a new operation ID for a different request.')
        const result = prior.result as Record<string, unknown>
        if (state.sharing?.generation !== result.generation) fail('SHARING_CHANGED', 'Sharing changed after this request. Reload it and try again.')
        return sharingDetails(state)
      }
      if ((state.sharing?.revision ?? 0) !== request.revision) fail('REVISION_CHANGED', 'Sharing changed elsewhere. Reload it and try again.')
      state.sharing = configureSharing(state.sharing, request.access, request.rotateLink)
      const stamp = clock.next(), { written } = await this.save(tx, loaded, state, stamp, [{ kind: 'member', key: user.sub }])
      await tx.superTabOperation.create({ data: { id: receiptId, tabId, actorKey: `person:${user.sub}`, requestHash,
        revision: 0, parts: json(receiptParts(written, stamp)), result: { generation: state.sharing.generation } } })
      return sharingDetails(state)
    })
  }

  /** A signed-in preview contains no projects, people, machines, or conversation data. It never joins. */
  async previewJoin(user: AuthUser, tabId: string, token?: string) {
    this.personOnly(user)
    return transaction(this.db, async tx => {
      const { state } = await this.load(tx, user, tabId)
      const sharing = authorizeSwarmJoin(state, user.email, token)
      const member = state.people.find(p => p.id === user.sub)
      return { id: tabId, name: state.name, role: member?.role ?? sharing.access.role, alreadyMember: !!member }
    })
  }

  async join(user: AuthUser, tabId: string, input: JoinSwarm) {
    this.personOnly(user)
    const request = joinSwarmSchema.parse(input)
    return transaction(this.db, async tx => {
      const loaded = await this.load(tx, user, tabId), state = structuredClone(loaded.state)
      // Recheck the current grant before an old receipt. Disabling, replacing, or
      // changing access can never revive a removed membership through a retry.
      const sharing = authorizeSwarmJoin(state, user.email, request.token)
      const receiptId = stableId('swarm-join', tabId, user.sub, request.operationId), requestHash = hash(request)
      const prior = await tx.superTabOperation.findUnique({ where: { id: receiptId } })
      let member = state.people.find(p => p.id === user.sub)
      if (prior) {
        if (prior.requestHash !== requestHash) fail('OPERATION_REUSED', 'Use a new operation ID for a different request.')
        const result = prior.result as Record<string, unknown>
        if (result.sharingGeneration !== sharing.generation || !member || (member.generation ?? null) !== result.membershipGeneration) {
          fail('JOIN_CHANGED', 'This join request is no longer current. Open the latest Swarm link again.')
        }
        return { id: tabId, role: member.role, alreadyMember: result.alreadyMember === true }
      }
      const alreadyMember = !!member
      if (!member) {
        member = { id: user.sub, email: authenticatedEmail(user.email)!, role: sharing.access.role, generation: receiptId }
        state.people.push(member)
      }
      // Existing people retain their role and private-project grants. A general
      // access link does not promote a viewer or grant a private project.
      // The join relied on the sharing generation the head holds: a concurrent sharing change conflicts with it.
      const stamp = clock.next(), { written } = await this.save(tx, loaded, state, stamp, [{ kind: 'head', key: 'head' }])
      await tx.superTabOperation.create({ data: { id: receiptId, tabId, actorKey: `person:${user.sub}`, requestHash, revision: 0,
        parts: json(receiptParts(written, stamp)),
        result: { sharingGeneration: sharing.generation, membershipGeneration: member.generation ?? null, alreadyMember } } })
      return { id: tabId, role: member.role, alreadyMember }
    })
  }

  async read(user: AuthUser, tabId: string, asAgentId?: string) {
    return transaction(this.db, async tx => {
      // A first load shows finished starts until they expire (design section 4.3).
      const { state } = await this.load(tx, user, tabId, { includeRecentStarts: true })
      const actor = await this.actor(tx, user, state, asAgentId)
      const now = this.now()
      const visible = visibleState(state, actor, now)
      const mentions = actor.kind === 'person' ? { mentionsWaiting: await mentionsWaiting(tx, tabId, state, actor, now) } : {}
      const teamMachines = visible.machines?.length ? await this.teamMachines(tx, state) : []
      return { lastChangedAt: (await lastChangedAt(tx, [tabId])).get(tabId) ?? 0, state: { ...visible, ...mentions, machines: visible.machines?.map(pool => {
        const stored = state.machines!.find(m => m.machineId === pool.machineId)!
        // Whether it takes teammates' projects now, and if not why (machines.ts teamWorkRefusal): what routing leaves it
        // out for, and what Desktop can show on the machine.
        const refusal = teamWorkRefusal(stored, now, teamMachines.includes(pool.machineId), teamAccountRequired(state))
        return { ...pool, availableSlots: Math.max(0, pool.maxAgents - machineSlots(state, stored)),
          teamWork: refusal ? { allowed: false as const, ...refusal } : { allowed: true as const } }
      }) } }
    })
  }

  async start(user: AuthUser, tabId: string, startId: string, asAgentId?: string, hostMachineId?: string) {
    return transaction(this.db, async tx => {
      const state = (await this.loadStart(tx, user, tabId, startId)).state
      const actor = hostMachineId ? await this.poolHostActor(tx, user, state, hostMachineId, startId) : await this.actor(tx, user, state, asAgentId)
      author(state, actor, true)
      const start = state.starts?.find(s => s.id === startId) ?? fail('NOT_FOUND', 'This agent start is unavailable.', 404)
      if (start.actorKey !== actorKey(actor) || person(state, start.contributorId).generation !== start.membershipGeneration) {
        fail('FORBIDDEN', 'Only the original initiating lead can resume this start.', 403)
      }
      const group = readConversation(state, actor, start.request.conversationId)
      if (actor.kind === 'agent' && group.leadId !== actor.agentId) fail('LEAD_REQUIRED', 'The coordinating lead changed.', 403)
      if (group.archived) fail('ARCHIVED', 'This conversation is archived.')
      if (state.paused && !start.harnessId && !start.dispatched) fail('PAUSED', 'New work is paused in this Super Tab.')
      const grant = await this.contribution(tx, state, actor, start.request, true)
      if (grant.machineOwnerId !== start.machineOwnerId || (grant.hostGrant ?? null) !== start.hostGrant) {
        fail('CONTRIBUTION_REVOKED', 'This start belongs to a machine grant that was revoked.', 403)
      }
      // The Lead reads that its machine is still preparing it, and waits instead of starting another (liveness.ts).
      return startPreparing(state, start, this.now()) ? { ...start, preparing: true as const } : start
    })
  }

  async execute(user: AuthUser, tabId: string, input: { operationId: string; command: Command }, asAgentId?: string, hostMachineId?: string) {
    try { return await this.executeOnce(user, tabId, input, asAgentId, hostMachineId) } catch (error) {
      // A queued start its machine will not take for good — no Harness Team account, or one that is not private — fails
      // with that reason instead of waiting there: its host would otherwise try to launch it on every pass, and it would
      // hold a slot. A stale check or an offline machine may pass again by itself, so that start keeps waiting.
      const command = input.command
      if (command?.type === 'agent.startDispatch' && hostMachineId && error instanceof SuperTabError && LASTING_TEAM_REFUSALS.includes(error.code)) {
        // Only one never launched: a repeated dispatch of a launched start is admitted again too, and its agent may be starting.
        const start = await transaction(this.db, async tx => {
          const row = await tx.superTab.findFirst({ where: { id: tabId, autonomousEnv: user.autonomousEnv } })
          return row?.format === 2 ? (await loadRow(tx, row, { startIds: [command.startId] })).state.starts?.find(s => s.id === command.startId) : undefined
        })
        if (start && !start.dispatched && !start.harnessId && !start.error) {
          await this.executeOnce(user, tabId, { operationId: `team-refused-${command.startId}`,
            command: { type: 'agent.startFailed', startId: command.startId, error: error.message } }, asAgentId, hostMachineId)
            .catch(() => { /* Settled by a concurrent pass: the dispatch is refused either way. */ })
        }
      }
      throw error
    }
  }

  private async executeOnce(user: AuthUser, tabId: string, input: { operationId: string; command: Command }, asAgentId?: string, hostMachineId?: string) {
    const { operationId, command } = operationSchema.parse(input)
    let ended: WorkHold[] = []
    const done = await transaction(this.db, async tx => {
      // A retried attempt starts again: only the attempt that commits says which tasks ended.
      ended = []
      const stamp = clock.next()
      const first = await this.load(tx, user, tabId, namedFor(command))
      const loaded = await this.ensure(tx, first, await this.moreNamed(tx, tabId, first.state, command))
      const original = loaded.state
      const team = await this.teamHost(tx, user)
      // Removal retries can arrive after the actor itself left. Return only this host's exact prior receipt.
      if (command.type === 'agent.remove' && asAgentId === command.agentId && !original.agents.some(a => a.id === asAgentId)) {
        const prior = await tx.superTabOperation.findUnique({ where: { id: stableId(tabId, `agent:${asAgentId}`, operationId) } })
        const result = prior?.result as Record<string, unknown> | undefined
        // A team session's only if the removed agent ran on its machine; a receipt from before that was recorded is not.
        if (prior && prior.requestHash === hash(command) && result?.releasedBy === user.sub && (team === null || result.releasedMachineId === team)) {
          return replyOf(prior)
        }
        fail('FORBIDDEN', 'Only the execution host can confirm this removal.', 403)
      }
      if (hostMachineId && !['agent.startDispatch', 'agent.started', 'agent.startFailed', 'agent.startSettled', 'route.modelResult'].includes(command.type)) fail('FORBIDDEN', 'A host can only settle its queued starts.', 403)
      if (team !== null && !hostMachineId) this.teamCommand(original, team, user, command)
      // A removed agent's or machine's host confirms its close or cleanup as the machine owner, who may have left the Swarm with it.
      const actor: Actor = command.type === 'agent.sessionClosed' || command.type === 'machine.cleaned' ? { kind: 'person', userId: user.sub, email: user.email }
        : hostMachineId && 'startId' in command
          ? await this.poolHostActor(tx, user, original, hostMachineId, command.startId)
          : await this.actor(tx, user, original, asAgentId)
      const receiptId = stableId(tabId, actorKey(actor), operationId)
      const requestHash = hash(command)
      const prior = await tx.superTabOperation.findUnique({ where: { id: receiptId } })
      if (prior) {
        if (prior.requestHash !== requestHash) fail('OPERATION_REUSED', 'Use a new operation ID for a different request.')
        // A leave may be retried by its original author. Nothing except that operation's receipt is returned.
        const selfLeave = actor.kind === 'person' && command.type === 'member.remove' && command.userId === actor.userId
        if (!selfLeave) {
          if (command.type === 'agent.remove' && !original.agents.some(a => a.id === command.agentId) ||
              command.type === 'project.delete' && !projectsOf(original).some(p => p.id === command.projectId)) {
            // Retrying one's own completed removal returns only its empty
            // receipt. The removed object no longer exists to authorize against.
            author(original, actor, true)
          } else {
            authorizeCommandAccess(original, actor, command)
          }
          if (command.type === 'delivery.resolve') {
            const delivery = await tx.superTabDelivery.findFirst({ where: { id: command.deliveryId, tabId } })
            if (!delivery) fail('NOT_FOUND', 'This delivery is unavailable.', 404)
            readConversation(original, actor, delivery.conversationId)
          }
          // A retried answer is checked again: the person must still read the decision's conversation (review of #1753).
          if (command.type === 'decision.answer') answerable(original, actor, await readAskedDecision(tx, tabId, command.decisionId))
          else if ('decisionId' in command) {
            const decision = await readDecision(tx, tabId, command.decisionId) ?? fail('NOT_FOUND', 'This routing decision is unavailable.', 404)
            readConversation(original, actor, decision.conversationId)
          }
        }
        if (command.type === 'project.create' &&
            !projectsOf(original).some(p => p.id === (prior.result as Record<string, unknown>).projectId)) {
          fail('NOT_FOUND', 'This project was deleted. Create a new project.', 404)
        }
        return replyOf(prior)
      }
      if (command.type !== 'invite.accept' && command.type !== 'agent.sessionClosed' && command.type !== 'machine.cleaned') author(original, actor)
      const context: CommandContext = { operationId, now: this.now() }
      if (command.type === 'agent.screen' || command.type === 'agent.input') context.confidentialSession = await this.confidential(tx, command.agentId)
      if (REGISTERS.has(command.type)) context.registrations = await otherRegistrations(tx, original, registeredBy(original, command))
      if ('startId' in command && ['agent.startDispatch', 'agent.started', 'agent.startFailed', 'agent.startSettled', 'route.modelResult'].includes(command.type)) {
        const start = original.starts?.find(s => s.id === command.startId)
        if (start?.poolGeneration && !hostMachineId) fail('HOST_REQUIRED', 'Only the contributed machine can confirm this start.', 403)
      }
      if (command.type === 'delivery.resolve') {
        author(original, actor, true)
        if (actor.kind !== 'person') fail('HUMAN_REQUIRED', 'A person must inspect an uncertain delivery before resolving it.', 403)
        const delivery = await tx.superTabDelivery.findFirst({ where: { id: command.deliveryId, tabId } })
        if (!delivery || delivery.status !== 'uncertain') fail('DELIVERY_RESOLVED', 'This delivery no longer needs checking.')
        const message = await tx.superTabMessage.findUnique({ where: { id: delivery.messageId } })
        if (!message) fail('NOT_FOUND', 'The original instruction is unavailable.', 404)
        if (command.resolution === 'resend') {
          if (!this.deliveryAllowed(original, delivery) || !await this.senderAllowed(tx, original, delivery)) {
            fail('DELIVERY_REVOKED', 'This instruction is no longer authorized.', 403)
          }
          await this.agentGrant(tx, original, agent(original, delivery.agentId))
        }
        context.delivery = { ...delivery, text: message.text, ...(message.attachments ? { attachments: message.attachments as unknown as Attachment[] } : {}) }
        await tx.superTabDelivery.update({ where: { id: delivery.id }, data: {
          status: command.resolution === 'received' ? 'confirmed' : command.resolution === 'resend' ? 'superseded' : 'cancelled',
          holdReason: null, holdSince: null,
          ...(command.resolution === 'received' ? { deliveredAt: delivery.deliveredAt ?? new Date(context.now) } : {}),
          // The native receipt remains intact; the operation records the person's resolution.
        } })
      }
      if (command.type === 'machine.contribute' || command.type === 'agent.add' || command.type === 'tab.project') {
        context.contribution = await this.contribution(tx, original, actor, command)
      }
      if (command.type === 'machine.contribute') context.abandonedStartIds = await abandonedStarts(tx, tabId, original, command.machineId, context.now)
      if (command.type === 'agent.start') context.contribution = await this.contribution(tx, original, actor, command.request, true)
      if (command.type === 'agent.started' || command.type === 'agent.startDispatch') {
        const start = original.starts?.find(s => s.id === command.startId) ?? fail('NOT_FOUND', 'This agent start is unavailable.', 404)
        context.contribution = await this.contribution(tx, original, actor, start.request, true)
      }
      if (command.type === 'message.send' && command.replyTo) {
        const reply = await tx.superTabMessage.findFirst({ where: { id: command.replyTo, tabId, conversationId: command.conversationId } })
        if (reply) context.reply = { id: reply.id, conversationId: reply.conversationId, author: reply.author as unknown as Author }
      }
      if ((command.type === 'rule.set' || command.type === 'rule.remove' || command.type === 'project.skills' || command.type === 'tab.tidy') && command.askedIn) {
        const asked = await tx.superTabMessage.findFirst({ where: { id: command.askedIn.messageId, tabId, conversationId: command.askedIn.conversationId } })
        if (asked) context.askedIn = { author: asked.author as unknown as Author, source: !!asked.source, createdAt: asked.createdAt.getTime() }
      }
      if (command.type === 'message.send' && actor.kind === 'agent') {
        const recent = await tx.superTabMessage.findMany({ where: { tabId, conversationId: command.conversationId },
          orderBy: { sequence: 'desc' }, take: PAIR_CHAIN_LIMIT, select: { author: true, recipientIds: true } })
        context.recent = recent.map(m => ({ author: m.author as unknown as Author, recipients: m.recipientIds }))
      }
      if (command.type === 'work.status' && command.status === 'stopped') {
        const proof = await tx.superTabStopReceipt.findUnique({ where: { tabId_assignmentId: { tabId, assignmentId: command.assignmentId } } })
        const execution = conversation(original, command.conversationId).assignment?.execution
        context.confirmedStopped = !!proof && !!execution && proof.machineId === execution.machineId &&
          proof.harnessId === execution.harnessId && proof.machineOwnerId === execution.machineOwnerId
      }
      if (command.type === 'mention.done') context.mention = await readMention(tx, tabId, command.mentionId)
      if (command.type === 'decision.answer') context.decision = await readAskedDecision(tx, tabId, command.decisionId)
      if (command.type === 'message.send' && command.attachmentIds?.length) context.attachments = await this.sendable(tx, tabId, actor, command)
      if (TEAM_WORK_COMMANDS.has(command.type)) {
        context.teamMachines = await this.teamMachines(tx, original)
        if (this.hooks.teamAccountsIdle) context.teamAccountsIdle = true
      }
      if (command.type === 'agent.screen' || command.type === 'agent.input') {
        // A machine that is gone or no longer shared refuses at once instead of leaving the request to time out.
        await this.agentGrant(tx, original, agent(original, command.agentId))
        const waiting = await tx.superTabTerminalRequest.count({ where: { tabId, agentId: command.agentId, status: { in: ['pending', 'claimed'] },
          createdAt: { gte: new Date(context.now - TERMINAL_PICKUP_MS - TERMINAL_ANSWER_MS) } } })
        if (waiting >= 10) fail('RATE_LIMITED', 'Ten requests to this terminal are still waiting. Wait for them to finish.', 429)
      }
      if (command.type === 'agent.screenResult' || command.type === 'agent.inputResult') {
        const request = await tx.superTabTerminalRequest.findFirst({ where: { id: command.requestId, tabId } })
        if (request) context.terminalRequest = { id: request.id, agentId: request.agentId, harnessId: request.harnessId,
          kind: request.kind as 'screen' | 'input', status: request.status as 'pending' | 'claimed' | 'done' }
      }
      const decisionId = command.type === 'route.override' || command.type === 'route.modelResult' ? command.decisionId
        : command.type === 'work.assign' || command.type === 'agent.start' ? command.routeDecisionId : undefined
      if (decisionId) context.routeDecision = await readDecision(tx, tabId, decisionId) ?? fail('NOT_FOUND', 'This routing decision is unavailable.', 404)
      // A dispatch reads its start's decision only to see whether a person chose this start by hand (rules.ts).
      const dispatched = command.type === 'agent.startDispatch' ? original.starts?.find(s => s.id === command.startId)?.routeDecisionId : undefined
      if (dispatched) context.routeDecision = await readDecision(tx, tabId, dispatched) ?? undefined
      const effects = applyCommand(original, actor, command, context)
      // An agent-only notice changes nothing people see: no link, no unread mark, no project report.
      const shown = effects.messages.filter(message => !agentOnly(message.source))
      for (const group of effects.state.conversations) {
        appendPullRequestUrls(group, [
          ...shown.filter(message => message.conversationId === group.id).map(message => message.text),
          ...group.checks.map(check => check.evidence), group.assignment?.result,
        ])
      }
      if (command.type === 'agent.rebind') {
        const target = agent(effects.state, command.agentId)
        // A terminal can already belong to a different project or Swarm on this host. The pure
        // transition checks this tab; inspect the other registrations inside the same transaction.
        const registrations = await tx.swarmAgent.findMany({ where: { machineId: target.machineId, deleted: false } })
        if (registrations.some(row => (row.data as unknown as Agent).harnessId === command.harnessId && row.key !== target.id)) {
          fail('SESSION_CONTRIBUTED', 'The replacement terminal already belongs to another member.')
        }
        if (target.harnessId !== agent(original, target.id).harnessId) {
          // Preserve the stable member's scope and also reserve the new native identity's scope.
          await bindSession(tx, effects.state, { ...target, id: stableId(target.machineId, target.harnessId) }, context.now)
          await tx.superTabRun.updateMany({ where: { id: target.id, tabId, machineId: target.machineId,
            harnessId: command.previousHarnessId }, data: { harnessId: target.harnessId } })
        }
      }
      if (command.type === 'agent.add' || command.type === 'agent.started') {
        const target = agent(effects.state, effects.result.agentId as string)
        await bindSession(tx, effects.state, target, context.now)
      }
      // A session that just became confidential writes the record its registrations write (confidential.ts).
      for (const target of effects.state.agents) {
        if (target.confidential && !original.agents.find(a => a.id === target.id)?.confidential) await recordConfidential(tx, effects.state, target, context.now)
      }
      if (command.type === 'project.sharing' && command.visibility === 'private') {
        await makeProjectPrivate(tx, effects.state, command.projectId)
      }
      await revokeNativeContexts(tx, original, effects.state)
      // Rule (b) for claims (design D10): a change to who a conversation's deliveries may reach writes those delivery rows,
      // so a claim of one conflicts with it. Archiving keeps them for when it reopens, as before.
      const regrouped = command.type === 'conversation.archive' && command.archived || command.type === 'conversation.audience'
        || command.type === 'conversation.agent' && !command.present
      if (regrouped) {
        await tx.superTabDelivery.updateMany({ where: { tabId, conversationId: command.conversationId, status: { in: ['queued', 'claimed', 'uncertain'] },
          ...(command.type === 'conversation.agent' ? { agentId: command.agentId } : {}) }, data: { updatedAt: new Date(context.now) } })
      }
      if (command.type === 'conversation.audience') {
        const kept = new Set(conversation(effects.state, command.conversationId).audience?.people.map(p => p.id))
        const removed = (conversation(original, command.conversationId).audience?.people ?? []).filter(p => !kept.has(p.id)).map(p => p.id)
        if (removed.length) await tx.superTabDelivery.updateMany({ where: { tabId, conversationId: command.conversationId, authorKind: 'person',
          authorId: { in: removed }, status: { in: ['queued', 'claimed', 'uncertain'] } }, data: { status: 'cancelled', holdReason: null, holdSince: null } })
      }
      const removedGroups = original.conversations.filter(c => !effects.state.conversations.some(n => n.id === c.id))
      if (removedGroups.length) {
        // Keep immutable history and operation receipts for audit/replay; all
        // reads require a live conversation. No removed group can deliver work.
        await tx.superTabDelivery.updateMany({ where: { tabId, conversationId: { in: removedGroups.map(c => c.id) },
          status: { in: ['queued', 'claimed', 'uncertain'] } }, data: { status: 'cancelled', holdReason: null, holdSince: null } })
      }
      // Each conversation numbers its own messages; a shown one is its latest and counts toward its project's reports.
      const sequences = numberMessages(effects.state, effects.messages, context.now)
      noteProjectReports(effects.state, shown, sequences, context.now)
      if (command.type === 'work.assign' || command.type === 'work.status' || command.type === 'message.send') {
        const group = conversation(effects.state, command.conversationId)
        const assignment = group.assignment
        if (assignment && (command.type !== 'message.send' || actor.kind === 'agent' && actor.agentId === assignment.agentId)) {
          // Even an unchanged working status is fresh evidence that the agent
          // continued. An older queued gap must not turn that progress into Stuck.
          assignment.recordingProgress = { at: context.now, revision: group.messageSeq ?? 0 }
        }
      }
      if (command.type === 'agent.release' && command.decision === 'stop') {
        const target = agent(effects.state, command.agentId)
        const assignmentId = `release-${target.releaseId}`
        const running = await tx.superTabRun.findUnique({ where: { id: target.id } })
        if (running && (running.tabId !== tabId || running.assignmentId !== assignmentId)) fail('AGENT_BUSY', 'This agent already owns active work in a Swarm or is stopping elsewhere.')
        const registrations = await tx.swarmAgent.findMany({ where: { key: target.id, deleted: false, tabId: { not: tabId } } })
        if (registrations.some(row => row.machineOwnerId === target.machineOwnerId)) {
          fail('SESSION_SHARED', 'This session is still shared with another Swarm. Withdraw it there before stopping it here.')
        }
        // Serialize new contributions with stop intent; bindSession writes this same native-session record.
        const scopeId = stableId('swarm-session', original.environment, target.machineOwnerId, target.id)
        const scope = await tx.superTabSessionScope.findUnique({ where: { id: scopeId } })
        await tx.superTabSessionScope.upsert({ where: { id: scopeId },
          create: { id: scopeId, scopeIds: [stableId(tabId, agentProjectId(original, target))], stopReleaseId: target.releaseId },
          update: { scopeIds: scope?.scopeIds ?? [], stopReleaseId: target.releaseId } })
        // The same global uniqueness fence as work.assign: another public Swarm cannot assign this native session during close.
        if (!running) await tx.superTabRun.create({ data: { id: target.id, tabId, assignmentId, machineId: target.machineId, harnessId: target.harnessId } })
      }
      if (command.type === 'agent.stopLease') {
        const target = agent(effects.state, command.agentId)
        const id = stableId('swarm-session', original.environment, target.machineOwnerId, target.id)
        const reservation = effects.state.harnessReservations?.find(r => r.machineId === target.machineId && r.harnessId === target.harnessId)
        await tx.superTabSessionScope.update({ where: { id }, data: {
          closeLeaseId: effects.result.leaseId as string, closeLeaseUntil: new Date(effects.result.expiresAt as number),
          closeLeaseGeneration: reservation?.generation ?? null,
        } })
      }
      if (command.type === 'agent.remove' && (actor.kind === 'agent' || effects.result.forceReleased)) {
        const target = agent(original, command.agentId)
        await tx.superTabRun.deleteMany({ where: { id: target.id, tabId, assignmentId: `release-${target.releaseId}` } })
        const id = stableId('swarm-session', original.environment, target.machineOwnerId, target.id)
        await tx.superTabSessionScope.upsert({ where: { id },
          create: { id, scopeIds: [], ...(effects.result.forceReleased ? { releasedTabIds: [tabId] } : {}) },
          update: { stopReleaseId: null, ...(effects.result.forceReleased ? { releasedTabIds: { push: tabId } } : { closeLeaseId: null, closeLeaseUntil: null, closeLeaseGeneration: null }) } })
      }
      if (command.type === 'work.assign') {
        const assigned = conversation(effects.state, command.conversationId).assignment!
        const running = await tx.superTabRun.findUnique({ where: { id: assigned.agentId } })
        // A record of this Swarm's for work that has ended here is stale (endRuns): it goes, by its own assignment, and the agent
        // is free. A record of another Swarm's, or a stopping agent's, still means busy.
        if (running && (running.tabId !== tabId || !(await this.staleRuns(tx, tabId, original)).includes(running.assignmentId))) {
          fail('AGENT_BUSY', 'This agent already owns active work in a Super Tab.')
        }
        if (running) await this.releaseRuns(tx, tabId, [running.assignmentId])
        await tx.superTabRun.create({ data: { id: assigned.agentId, tabId, assignmentId: assigned.id,
          machineId: assigned.execution.machineId, harnessId: assigned.execution.harnessId } })
      }
      await this.endRuns(tx, tabId, original, effects.state)
      const committed = await this.save(tx, loaded, effects.state, stamp, touchesFor(command, actor, original, effects, context))
      if (command.type === 'agent.add' || command.type === 'agent.started' || command.type === 'agent.configuration' || command.type === 'agent.rebind') {
        for (const target of effects.state.agents) {
          if (target.configurationVersion !== receiptId) continue
          const previous = original.agents.find(a => a.id === target.id)
          if (previous?.configurationVersion === target.configurationVersion) continue
          // Ordered by the agent part's version, which never resets and starts above every older tab revision.
          await tx.superTabConfiguration.create({ data: {
            id: stableId(tabId, target.id, operationId), tabId, agentId: target.id, revision: committed.versions.get(`agent:${target.id}`) ?? 0,
            configuration: json(target.configuration), actorKey: actorKey(actor), observedAt: new Date(context.now),
            assignmentIds: effects.state.conversations.filter(group => activeWork(group) && group.assignment?.agentId === target.id)
              .map(group => group.assignment!.id),
          } })
        }
      }
      ended = endedHolds(original, effects.state)
      await writeRouteEffects(tx, tabId, effects.routeDecisions, context.now)
      if (command.type === 'agent.startFailed') {
        const start = original.starts?.find(s => s.id === command.startId)
        if (start?.routeDecisionId) await closeUnassignedStart(tx, tabId, start.routeDecisionId, start.id, 'failed', context.now)
      }
      // Starts a removed machine failed, whether its owner removed it or left the Swarm with it, release their route holds.
      if (command.type === 'machine.remove' || command.type === 'member.remove') {
        for (const start of original.starts ?? []) {
          if (!start.routeDecisionId || start.harnessId || start.error) continue
          if (effects.state.starts?.find(s => s.id === start.id)?.error) {
            await closeUnassignedStart(tx, tabId, start.routeDecisionId, start.id, 'failed', context.now)
          }
        }
      }
      if (command.type === 'agent.remove' && actor.kind === 'agent' && actor.agentId === command.agentId) {
        const start = original.starts?.find(s => s.routeDecisionId && s.harnessId &&
          stableId(s.request.machineId, s.harnessId) === command.agentId)
        if (start?.routeDecisionId) await closeUnassignedStart(tx, tabId, start.routeDecisionId, start.id, 'stopped', context.now)
      }
      if (command.type === 'project.delete' || command.type.startsWith('project.role')) await this.writeRoleTexts(tx, tabId, effects.state, command)
      if (effects.terminal) await this.writeTerminal(tx, tabId, effects.terminal, context.now)
      if (command.type === 'work.cancel') {
        await closeAssignment(tx, tabId, command.assignmentId, 'cancelled', context.now)
      }
      if (command.type === 'work.status' && (command.status === 'done' || command.status === 'stopped')) {
        await closeAssignment(tx, tabId, command.assignmentId, command.status, context.now)
      }
      await this.writeMessages(tx, tabId, effects.state, effects.messages, sequences)
      if (command.type === 'message.send' && actor.kind === 'person') await resolveByReply(tx, tabId, command.conversationId, actor.userId, context.now)
      await writeMentions(tx, tabId, effects.state, effects.messages, context.now)
      if (command.type === 'mention.done') await markDone(tx, tabId, command.mentionId, context.mention!.personId, context.now)
      if (effects.decisions) {
        const ids = await writeDecisions(tx, tabId, effects.decisions, context.now)
        if (command.type === 'decision.ask') effects.result.decisionIds = ids
      }
      if (effects.decisionAnswer) await recordAnswer(tx, tabId, effects.decisionAnswer, context.now)
      if (context.attachments?.length) {
        // Conflicts with a concurrent send of the same file: only one message can take it.
        const taken = await tx.superTabAttachment.updateMany({ where: { tabId, id: { in: context.attachments.map(a => a.id) }, ...unused },
          data: { usedBy: effects.result.messageId as string } })
        if (taken.count !== context.attachments.length) fail('ATTACHMENT_USED', 'This file was already sent. Attach it again to send it in another message.')
      }
      // On 2026-10-20 a Lead answered a message it had already read, then answered it again when the held
      // delivery was finally typed. An agent's reply settles that agent's own deliveries of the message.
      if (command.type === 'message.send' && command.replyTo && actor.kind === 'agent') {
        await tx.superTabDelivery.updateMany({ where: { tabId, messageId: command.replyTo, agentId: actor.agentId,
          status: { in: ['queued', 'claimed', 'uncertain', 'delivered', 'confirmed'] } },
          data: { status: 'answered', answeredAt: new Date(context.now), holdReason: null, holdSince: null } })
      }
      if (command.type === 'project.report' && actor.kind === 'agent') {
        // Judged on the progress after this report summarized what it names.
        const progress = projectsOf(effects.state).find(p => p.id === command.projectId)?.progress
        if (progress?.requestMessageId && answersRequest(progress, command.throughRevision)) {
          await tx.superTabDelivery.updateMany({ where: { tabId, agentId: actor.agentId, messageId: progress.requestMessageId,
            status: { in: ['queued', 'claimed', 'uncertain', 'delivered', 'confirmed'] } },
            data: { status: 'answered', answeredAt: new Date(context.now), holdReason: null, holdSince: null } })
        }
      }
      const revoked = [
        ...original.people.filter(p => !effects.state.people.some(n => n.id === p.id && n.generation === p.generation))
          .map(p => ({ authorKind: 'person', authorId: p.id, authorGeneration: p.generation })),
        ...original.agents.filter(a => !effects.state.agents.some(n => n.id === a.id && n.membershipGeneration === a.membershipGeneration))
          .map(a => ({ authorKind: 'agent', authorId: a.id, authorGeneration: a.membershipGeneration })),
      ]
      const cancelled: Prisma.SuperTabDeliveryWhereInput[] = [
        ...revoked, ...(effects.cancelledAgents.length ? [{ agentId: { in: effects.cancelledAgents } }] : []),
      ]
      if (cancelled.length) await tx.superTabDelivery.updateMany({ where: { tabId,
        status: { in: ['queued', 'claimed', 'uncertain'] }, OR: cancelled }, data: { status: 'cancelled', holdReason: null, holdSince: null } })
      for (const attempt of effects.previousAttempts) {
        await tx.superTabAttempt.create({ data: { id: attempt.assignment.id, tabId, conversationId: attempt.conversationId, snapshot: json(attempt) } })
      }
      await tx.superTabOperation.create({ data: { id: receiptId, tabId, actorKey: actorKey(actor), requestHash,
        revision: 0, parts: json(receiptParts(committed.written, stamp)), result: json(effects.result) } })
      return { result: effects.result, parts: committed.written, lastChangedAt: stamp }
    })
    this.endWork(tabId, ended)
    return done
  }

  private endWork(tabId: string, ended: WorkHold[]): void {
    if (!ended.length || !this.hooks.workEnded) return
    try { this.hooks.workEnded(tabId, ended) } catch (error) {
      logger.warn('[super-tab] work-ended hook failed', { tabId, error: error instanceof Error ? error.message : String(error) })
    }
  }

  /** What the Harness GitHub App may mint a token for (routes/superTabs.ts `github-token`): the calling host's own agent, on
   *  the machine its host names, with a task in its hands. Who the work is for, and the agent's and machine's names, go
   *  into its commits (github/attribution.ts). The caller checks that the repository is on GitHub. */
  async githubAssignment(user: AuthUser, tabId: string, asAgentId: string | undefined, machineId: string) {
    if (!asAgentId) fail('AGENT_REQUIRED', 'Ask for a GitHub token as the agent doing the work (asAgentId).', 400)
    return transaction(this.db, async tx => {
      const { state } = await this.load(tx, user, tabId)
      const actor = await this.actor(tx, user, state, asAgentId)
      // A read-only contribution reads; it does not push.
      author(state, actor, true)
      const target = agent(state, asAgentId)
      if (target.machineId !== machineId) fail('FORBIDDEN', 'Only the machine running this agent can ask for its GitHub token.', 403)
      const group = state.conversations.find(c => !isLeads(c) && c.assignment?.agentId === target.id && HOLDING.has(c.assignment.status)
        && c.assignment.execution.machineId === target.machineId && c.assignment.execution.machineOwnerId === target.machineOwnerId)
        ?? fail('NO_ASSIGNMENT', 'This agent has no task in progress. A GitHub token is only for an agent working on a task.')
      const project = groupProject(state, group)
      const owner = await tx.user.findUnique({ where: { id: project.ownerId }, select: { name: true, email: true } })
      const requester = owner ?? { name: null, email: state.people.find(p => p.id === project.ownerId)?.email ?? '' }
      if (!requester.email) fail('NOT_FOUND', 'This project\'s owner is unavailable.', 404)
      const contributed = state.machines?.find(m => m.machineId === target.machineId)?.name
      const machineName = contributed ?? await tx.machine.findFirst({ where: { machineId: target.machineId, userId: target.machineOwnerId },
        select: { name: true, hostname: true } }).then(m => m?.name ?? m?.hostname ?? null)
      return { tabId, agentId: target.id, assignmentId: group.assignment!.id, repositoryUrl: project.repository?.repositoryUrl ?? null,
        requester: { name: requester.name?.trim() || null, email: requester.email },
        agentName: agentDisplayName(state.agents, target.id) ?? target.displayName ?? target.name, machineName: machineName?.trim() || null }
    })
  }

  /**
   * What a contributed machine's host needs to prepare a queued start's folder before the agent exists (routes/superTabs.ts,
   * a start's `github-token`): the start's project repository, whom the work is for, and whether it is the machine owner's
   * own project. Only the host of that start, while nothing has started or failed yet, as `start()` reads it.
   */
  async githubStart(user: AuthUser, tabId: string, startId: string, machineId: string) {
    return transaction(this.db, async tx => {
      const { state } = await this.loadStart(tx, user, tabId, startId)
      const actor = await this.poolHostActor(tx, user, state, machineId, startId)
      const start = state.starts?.find(s => s.id === startId) ?? fail('NOT_FOUND', 'This agent start is unavailable.', 404)
      if (start.harnessId || start.error) fail('START_SETTLED', 'This start has already started or failed; its folder is not prepared again.', 409)
      if (person(state, start.contributorId).generation !== start.membershipGeneration) fail('FORBIDDEN', 'Only the original initiating lead can resume this start.', 403)
      const group = readConversation(state, actor, start.request.conversationId)
      if (actor.kind === 'agent' && group.leadId !== actor.agentId) fail('LEAD_REQUIRED', 'The coordinating lead changed.', 403)
      if (group.archived) fail('ARCHIVED', 'This conversation is archived.')
      const grant = await this.contribution(tx, state, actor, start.request, true)
      if (grant.machineOwnerId !== start.machineOwnerId || (grant.hostGrant ?? null) !== start.hostGrant) {
        fail('CONTRIBUTION_REVOKED', 'This start belongs to a machine grant that was revoked.', 403)
      }
      const project = groupProject(state, group)
      const owner = await tx.user.findUnique({ where: { id: project.ownerId }, select: { name: true, email: true } })
      const email = owner?.email ?? state.people.find(p => p.id === project.ownerId)?.email ?? ''
      return { tabId, startId, repositoryUrl: project.repository?.repositoryUrl ?? null, own: project.ownerId === start.machineOwnerId,
        requester: { name: owner?.name?.trim() || null, email } }
    })
  }

  /** Streams one file into the bucket for a later `message.send` by the same actor in the same conversation. Access is
   * checked before a byte is stored; the row that makes it sendable is written only once the whole file is. */
  async upload(user: AuthUser, tabId: string, conversationId: string, file: { name: string; mime: string; body: Readable }, asAgentId?: string) {
    const attachments = this.attachments ?? fail('ATTACHMENTS_UNAVAILABLE', 'File attachments are not available on this server.', 503)
    // A file's name is shown in the chat like its message, so it never keeps a credential either.
    const name = attachmentName.transform(value => redactCredentials(value).text).safeParse(file.name), mime = attachmentMime.safeParse(file.mime)
    if (!name.success || !mime.success) fail('INVALID_ATTACHMENT', 'Attach a file with a printable name and a content type.', 400)
    const key = await transaction(this.db, async tx => {
      const { actor } = await this.poster(tx, user, tabId, conversationId, asAgentId)
      const key = actorKey(actor)
      // Unsent files cost bucket space, so one actor gets a bounded number an hour.
      const recent = await tx.superTabAttachment.count({ where: { tabId, actorKey: key, createdAt: { gte: new Date(this.now() - 3_600_000) } } })
      if (recent >= 200) fail('RATE_LIMITED', 'You attached 200 files in the last hour. Wait before attaching more.', 429)
      return key
    })
    const objectKey = objectKeyFor(attachments.prefix, tabId, name.data)
    let size: number, stored = mime.data
    try {
      const checked = await checkedType(mime.data, file.body)
      stored = checked.mime
      size = await attachments.store.put(objectKey, { name: name.data, mime: stored }, checked.body, MAX_ATTACHMENT_BYTES)
    } catch (error) {
      if (error instanceof AttachmentTooLarge) fail('ATTACHMENT_TOO_LARGE', error.message, 413)
      // The client's own stream breaking is the request's; anything else is the bucket's, and the person can try again.
      if (file.body.errored || (error && typeof error === 'object' && 'code' in error && String(error.code).startsWith('FST_'))) throw error
      logger.error('super-tab attachment storage failed', { tabId, error: error instanceof Error ? error.message : String(error) })
      fail('ATTACHMENTS_UNAVAILABLE', 'Could not store the file just now. Try again.', 503)
    }
    const row = await this.db.superTabAttachment.create({ data: { id: randomBytes(12).toString('hex'), tabId, conversationId,
      actorKey: key, name: name.data, mime: stored, size, objectKey } })
    return { attachment: { id: row.id, name: row.name, mime: row.mime, size: row.size, url: publicUrl(attachments.publicBase, objectKey) } satisfies Attachment }
  }

  /** The actor, once it may post in this conversation. */
  private async poster(tx: Transaction, user: AuthUser, tabId: string, conversationId: string, asAgentId?: string) {
    const { state } = await this.load(tx, user, tabId, { groupIds: [conversationId] })
    const actor = await this.actor(tx, user, state, asAgentId)
    author(state, actor, true)
    readConversation(state, actor, conversationId)
    postable(state, actor, conversationId)
    return { state, actor }
  }

  private async sendable(tx: Transaction, tabId: string, actor: Actor, command: SendCommand): Promise<Attachment[]> {
    const attachments = this.attachments ?? fail('ATTACHMENTS_UNAVAILABLE', 'File attachments are not available on this server.', 503)
    const ids = [...new Set(command.attachmentIds)]
    const rows = await tx.superTabAttachment.findMany({ where: { tabId, id: { in: ids } } })
    return ids.map(id => {
      const row = rows.find(r => r.id === id)
      if (!row || row.actorKey !== actorKey(actor) || row.conversationId !== command.conversationId) {
        fail('ATTACHMENT_UNAVAILABLE', 'Attach this file again before sending it.', 400)
      }
      if (row.usedBy) fail('ATTACHMENT_USED', 'This file was already sent. Attach it again to send it in another message.')
      return { id: row.id, name: row.name, mime: row.mime, size: row.size, url: publicUrl(attachments.publicBase, row.objectKey) }
    })
  }

  /** Keeps the project's stored texts equal to its custom set: the roles the command wrote, nothing for roles it dropped. */
  private async writeRoleTexts(tx: Transaction, tabId: string, state: SuperTabState, command: Command) {
    if (!('projectId' in command) || !command.projectId) return
    const { projectId } = command
    const kept = projectsOf(state).find(p => p.id === projectId)?.roles?.map(r => r.id) ?? []
    await tx.superTabRoleText.deleteMany({ where: { tabId, projectId, roleId: { notIn: kept } } })
    const written = command.type === 'project.role.set' ? [command.role]
      : command.type === 'project.roles.create' || command.type === 'project.roles.reset' ? command.roles : []
    for (const role of written) {
      const id = stableId(tabId, projectId, role.id), data = { version: roleVersion(role.text), text: role.text }
      await tx.superTabRoleText.upsert({ where: { id }, create: { id, tabId, projectId, roleId: role.id, ...data }, update: data })
    }
  }

  /** A custom role's text, for the project's owner, its Lead, and the hosts of its agents (which fetch it when the version
   *  in their roster changes). Anyone else, like a missing role, reads it as unavailable. */
  async roleText(user: AuthUser, tabId: string, projectId: string, roleId: string, asAgentId?: string) {
    return transaction(this.db, async tx => {
      const { state } = await this.load(tx, user, tabId)
      const unavailable = () => fail('NOT_FOUND', 'This role is unavailable.', 404)
      const project = projectsOf(state).find(p => p.id === projectId) ?? unavailable()
      const role = project.roles?.find(r => r.id === roleId) ?? unavailable()
      const team = await this.teamHost(tx, user)
      if (asAgentId) {
        await this.actor(tx, user, state, asAgentId)
        if (ledProject(state, asAgentId)?.id !== project.id) unavailable()
      } else if (team !== null) {
        // A team session is never the project's owner: it reads a text only for an agent its own machine hosts.
        if (!await this.hostsProject(tx, state, user, project.id, team)) unavailable()
      } else if (!(user.sub === project.ownerId && state.people.some(p => p.id === user.sub)) && !await this.hostsProject(tx, state, user, project.id)) {
        unavailable()
      }
      const stored = await tx.superTabRoleText.findUnique({ where: { id: stableId(tabId, projectId, roleId) } })
      if (stored?.version !== role.version) unavailable()
      return { version: stored!.version, text: stored!.text }
    })
  }

  /** Whether this account could host one of the project's agents now, by the same live grant as its host reads; on
   *  [machineId] alone when given. */
  private async hostsProject(tx: Transaction, state: SuperTabState, user: AuthUser, projectId: string, machineId?: string): Promise<boolean> {
    for (const target of state.agents.filter(a => a.machineOwnerId === user.sub && (!machineId || a.machineId === machineId)
      && agentProjectId(state, a) === projectId)) {
      try { agent(state, target.id); await this.agentGrant(tx, state, target); return true }
      catch (error) { if (!(error instanceof SuperTabError)) throw error }
    }
    return false
  }

  private async writeTerminal(tx: Transaction, tabId: string, effect: TerminalEffect, now: number) {
    if (effect.op === 'request') {
      const { op: _op, id, ...request } = effect
      await tx.superTabTerminalRequest.create({ data: { id, tabId, ...request, createdAt: new Date(now) } })
      return
    }
    // The deadline holds whether or not the sender has asked for the answer yet.
    const answered = await tx.superTabTerminalRequest.updateMany({ where: { id: effect.id, tabId, status: 'claimed', claimedAt: { gte: new Date(now - TERMINAL_ANSWER_MS) } },
      data: { status: 'done', ok: effect.ok, result: effect.text, error: effect.error } })
    if (!answered.count) fail('REQUEST_CLOSED', 'This terminal request is no longer waiting for an answer.')
  }

  /** The requester alone reads the answer, once: the screen text is deleted as it is returned. Waits up to `waitMs` for it. */
  async terminalResult(user: AuthUser, tabId: string, requestId: string, asAgentId?: string, waitMs = 0) {
    const deadline = Date.now() + waitMs
    for (;;) {
      const answer = await transaction(this.db, async tx => {
        const { state } = await this.load(tx, user, tabId)
        const actor = await this.actor(tx, user, state, asAgentId)
        author(state, actor)
        const now = this.now()
        const row = await tx.superTabTerminalRequest.findFirst({ where: { id: requestId, tabId, createdAt: { gte: new Date(now - TERMINAL_EXPIRY_MS) } } })
        if (!row || row.requesterKey !== actorKey(actor)) fail('NOT_FOUND', 'This terminal request is unavailable.', 404)
        // A sender who has since lost write access, or is no longer the agent's project Lead, gets nothing.
        mayDrive(state, actor, agent(state, row.agentId), await this.confidential(tx, row.agentId))
        const late = row.status === 'pending' && now - row.createdAt.getTime() > TERMINAL_PICKUP_MS
          ? 'The agent’s machine did not pick up the request within 10 seconds. It may be offline or asleep.'
          : row.status === 'claimed' && now - row.claimedAt!.getTime() > TERMINAL_ANSWER_MS
            ? 'The agent’s machine picked up the request but did not answer within 30 seconds.' : null
        if (row.status !== 'done' && !late) return null
        await tx.superTabTerminalRequest.delete({ where: { id: row.id } })
        if (late || !row.ok) return { requestId, ok: false, error: late ?? row.error }
        return { requestId, ok: true, ...(row.result !== null ? { text: row.result } : {}) }
      })
      if (answer) return answer
      if (Date.now() >= deadline) return { requestId, pending: true }
      await new Promise(resolve => setTimeout(resolve, 250))
    }
  }

  /** Each waiting request for this host's agents is handed over once. One that waited too long, or whose terminal, agent or
   * requester changed, is answered with the reason instead, so input is never typed late or into another pane. */
  async hostTerminal(user: AuthUser, machineId: string) {
    return transaction(this.db, async tx => {
      await this.hostFor(tx, user, machineId)
      const owned = await tx.machine.findFirst({ where: { machineId, userId: user.sub, autonomousEnv: user.autonomousEnv, ...machineAlive } })
      if (!owned || !machineBillingAllowsDataPlane(owned)) fail('HOST_UNAVAILABLE', 'This execution host is unavailable.', 403)
      const now = this.now()
      const rows = await tx.superTabTerminalRequest.findMany({ where: { machineId, machineOwnerId: user.sub, status: 'pending' },
        orderBy: { createdAt: 'asc' }, take: 100 })
      const states = new Map<string, SuperTabState | null>()
      const result = []
      for (const row of rows) {
        if (!states.has(row.tabId)) {
          const tab = await tx.superTab.findFirst({ where: { id: row.tabId, autonomousEnv: user.autonomousEnv } })
          states.set(row.tabId, tab?.format === 2 ? (await loadRow(tx, tab)).state : null)
        }
        const refusal = now - row.createdAt.getTime() > TERMINAL_PICKUP_MS
          ? 'The agent’s machine did not pick up the request within 10 seconds. It may be offline or asleep.'
          : await this.terminalRefusal(tx, states.get(row.tabId)!, row)
        if (refusal) {
          await tx.superTabTerminalRequest.updateMany({ where: { id: row.id, status: 'pending' }, data: { status: 'done', ok: false, error: refusal } })
          continue
        }
        const claimed = await tx.superTabTerminalRequest.updateMany({ where: { id: row.id, status: 'pending' }, data: { status: 'claimed', claimedAt: new Date(now) } })
        if (!claimed.count) continue
        result.push({ tabId: row.tabId, agentId: row.agentId, harnessId: row.harnessId, request: { id: row.id, kind: row.kind,
          ...(row.scrollback !== null ? { scrollback: row.scrollback } : {}), ...(row.text !== null ? { text: row.text } : {}),
          ...(row.keys.length ? { keys: row.keys } : {}) } })
      }
      return result
    })
  }

  private async terminalRefusal(tx: Transaction, state: SuperTabState | null,
    row: { agentId: string; machineId: string; machineOwnerId: string; harnessId: string; requesterKey: string }): Promise<string | null> {
    const target = state?.agents.find(a => a.id === row.agentId && a.machineId === row.machineId && a.machineOwnerId === row.machineOwnerId)
    if (!state || !target) return 'The agent is no longer in the Swarm.'
    if (target.harnessId !== row.harnessId) return 'The agent’s terminal changed since the request. Read it again.'
    const [kind, id] = [row.requesterKey.slice(0, row.requesterKey.indexOf(':')), row.requesterKey.slice(row.requesterKey.indexOf(':') + 1)]
    const requester: Actor = kind === 'person' ? { kind: 'person', userId: id, email: '' }
      : { kind: 'agent', agentId: id, machineOwnerId: state.agents.find(a => a.id === id)?.machineOwnerId ?? '' }
    try {
      agent(state, target.id)
      await this.agentGrant(tx, state, target)
      mayDrive(state, requester, target, await this.confidential(tx, target.id))
    } catch (error) {
      if (error instanceof SuperTabError) return 'This request is no longer allowed.'
      throw error
    }
    return null
  }

  /** Frees the agents of work that ended in this write, wherever it ended: a command, the liveness checks on a machine's report
   *  or on the Lead's poll (a lost task), or a cancel of work already lost. Their run record goes, so the agent can take work
   *  again, and whatever was still queued for that work is dropped. Until 2026-10-27 only a command that ended active work did
   *  this, so the 16 tasks a release's update outage lost kept their agents busy for good. */
  private async endRuns(tx: Transaction, tabId: string, before: SuperTabState, after: SuperTabState) {
    const ended = new Set<string>()
    for (const group of after.conversations) {
      const now = group.assignment, was = before.conversations.find(c => c.id === group.id)?.assignment
      if (now && !activeWork(group) && (now.id !== was?.id || now.status !== was.status)) ended.add(now.id)
    }
    for (const group of before.conversations.filter(activeWork)) {
      const changed = after.conversations.find(c => c.id === group.id)
      if (!changed || !activeWork(changed) || changed.assignment!.id !== group.assignment!.id) ended.add(group.assignment!.id)
    }
    await this.releaseRuns(tx, tabId, [...ended])
  }

  /** For these ended assignments of this Swarm, by their exact ids: their run records go, and their deliveries still queued,
   *  claimed or uncertain are cancelled, so a returning worker never receives a lost task's old instructions after new work
   *  (review of #1781). Exact ids never match the record or deliveries of an assignment made since. */
  private async releaseRuns(tx: Transaction, tabId: string, assignmentIds: string[]) {
    if (!assignmentIds.length) return
    const assignmentId = { in: assignmentIds }
    await tx.superTabRun.deleteMany({ where: { tabId, assignmentId } })
    await tx.superTabDelivery.updateMany({ where: { tabId, assignmentId, status: { in: ['queued', 'claimed', 'uncertain'] } },
      data: { status: 'cancelled', holdReason: null, holdSince: null } })
  }

  /** Run records an older server left in this Swarm for work that is no longer active here (see endRuns). Only this Swarm's,
   *  whose work it can see has ended; never one of another Swarm's, nor a stopping agent's (its record is the stop's fence). */
  private async staleRuns(tx: Transaction, tabId: string, state: SuperTabState): Promise<string[]> {
    const active = new Set(state.conversations.filter(activeWork).map(c => c.assignment!.id))
    const rows = await tx.superTabRun.findMany({ where: { tabId }, select: { assignmentId: true } })
    return rows.map(r => r.assignmentId).filter(id => !id.startsWith('release-') && !active.has(id))
  }

  /** Records committed messages, each at the sequence its conversation gave it, and one delivery per recipient. */
  private async writeMessages(tx: Transaction, tabId: string, state: SuperTabState, messages: MessageDraft[], sequences: ReadonlyMap<string, number>) {
    for (const message of messages) {
      await tx.superTabMessage.create({ data: { id: message.id, tabId, conversationId: message.conversationId,
        sequence: sequences.get(message.id)!, author: json(message.author), ...(message.source ? { source: json(message.source) } : {}),
        ...(message.attachments ? { attachments: json(message.attachments) } : {}),
        text: message.text, replyTo: message.replyTo, recipientIds: message.recipients, mentions: message.mentions ?? [] } })
      for (const recipient of message.recipients) {
        const target = agent(state, recipient)
        const group = conversation(state, message.conversationId)
        await tx.superTabDelivery.create({ data: { id: stableId(message.id, recipient), tabId,
          conversationId: message.conversationId, messageId: message.id, agentId: recipient, machineId: target.machineId,
          machineOwnerId: target.machineOwnerId,
          assignmentId: activeWork(group) && group.assignment?.agentId === recipient ? group.assignment.id : null,
          membershipGeneration: target.membershipGeneration, authorKind: message.author.kind,
          authorId: message.author.id, authorGeneration: message.author.membershipGeneration } })
      }
    }
  }

  /** One page of a conversation, read by (sequence, id): rows written by one command before the store by parts share a
   *  sequence, so a page edge inside such a run must not skip any (design section 4.6). `after` alone reads strictly after
   *  a sequence, which is enough to poll for new messages. */
  async messages(user: AuthUser, tabId: string, conversationId: string,
    cursor: { after?: number; afterId?: string; before?: number; beforeId?: string; messageId?: string }, asAgentId?: string) {
    return transaction(this.db, async tx => {
      const { state } = await this.load(tx, user, tabId, { groupIds: [conversationId] })
      const actor = await this.actor(tx, user, state, asAgentId)
      readConversation(state, actor, conversationId)
      const forward = cursor.after !== undefined
      const past = (sequence: number, id: string | undefined, direction: 'gt' | 'lt') => id === undefined ? { sequence: { [direction]: sequence } }
        : { OR: [{ sequence: { [direction]: sequence } }, { sequence, id: { [direction]: id } }] }
      const where = { tabId, conversationId,
        ...(cursor.messageId ? { id: cursor.messageId } : {}),
        ...(forward ? past(cursor.after!, cursor.afterId, 'gt') : cursor.before !== undefined ? past(cursor.before, cursor.beforeId, 'lt') : {}) }
      // An agent-only notice is listed for its own recipient alone. Hidden rows never shorten a page: Desktop reads on from the
      // last row it shows, so the page reads past them until it has 101 rows this reader may see, or reaches the end.
      const rows: SuperTabMessage[] = []
      for (let skip = 0; rows.length <= 100; skip += 101) {
        const order = forward ? 'asc' as const : 'desc' as const
        const batch = await tx.superTabMessage.findMany({ where, orderBy: [{ sequence: order }, { id: order }], skip, take: 101 })
        rows.push(...batch.filter(m => !agentOnly(m.source) || (actor.kind === 'agent' && m.recipientIds.includes(actor.agentId))))
        if (batch.length < 101) break
      }
      const page = rows.slice(0, 100)
      const next = rows.length > 100 ? { sequence: page.at(-1)!.sequence, id: page.at(-1)!.id } : null
      if (!forward) page.reverse()
      const deliveries = page.length ? await tx.superTabDelivery.findMany({ where: { tabId, messageId: { in: page.map(m => m.id) } },
        select: { id: true, messageId: true, agentId: true, status: true, receipt: true,
          holdReason: true, holdSince: true, deliveredAt: true, answeredAt: true, createdAt: true, updatedAt: true } }) : []
      return { messages: page.map(m => ({ ...m, mentions: m.mentions ?? [], deliveries: deliveries.filter(d => d.messageId === m.id) })), next }
    })
  }

  /** The caller's own tags in this Swarm, newest first: still waiting, or answered and marked done. */
  async mentions(user: AuthUser, tabId: string, state: 'waiting' | 'earlier') {
    this.personOnly(user)
    return transaction(this.db, async tx => {
      const { state: tab } = await this.load(tx, user, tabId, { allGroups: true })
      return { mentions: await listMentions(tx, tabId, tab, { kind: 'person', userId: user.sub, email: user.email }, this.now(), state === 'waiting') }
    })
  }

  /** The caller's decisions in this Swarm, newest first: a person's asked of them, an agent's asked by it (a Lead's also
   *  those asked in its project), still open or answered. A light load: the quiet conversations its decisions are in are
   *  read with them (decisions.ts conversationsOf), never the Swarm's whole history, read again on every change. */
  async decisions(user: AuthUser, tabId: string, state: 'open' | 'answered', asAgentId?: string) {
    return transaction(this.db, async tx => {
      const { state: tab } = await this.load(tx, user, tabId)
      const actor = await this.actor(tx, user, tab, asAgentId)
      author(tab, actor)
      return { decisions: await listDecisions(tx, tabId, tab, actor, state === 'open') }
    })
  }

  /**
   * Every earlier attempt of one group. `work.define` takes a stopped assignment out of the state, so this is the
   * only place a reader (the Lead choosing an agent for a retry) can still see who tried and how it ended
   * (manual run 2026-10-19). The snapshot also holds the host grant and configuration; none of it leaves here.
   */
  async attempts(user: AuthUser, tabId: string, conversationId: string, asAgentId?: string) {
    return transaction(this.db, async tx => {
      const { state } = await this.load(tx, user, tabId, { groupIds: [conversationId] })
      readConversation(state, await this.actor(tx, user, state, asAgentId), conversationId)
      const rows = await tx.superTabAttempt.findMany({ where: { tabId, conversationId }, orderBy: { createdAt: 'desc' }, take: 50 })
      return rows.map(row => {
        const assignment = (row.snapshot as unknown as { assignment: Assignment }).assignment
        return { id: row.id, agentId: assignment.agentId, status: assignment.status, result: assignment.result?.slice(0, 500) ?? null, createdAt: row.createdAt }
      })
    })
  }

  async routeDecisions(user: AuthUser, tabId: string, asAgentId?: string) {
    return transaction(this.db, async tx => {
      const { state } = await this.load(tx, user, tabId, { allGroups: true })
      const actor = await this.actor(tx, user, state, asAgentId)
      author(state, actor)
      // Dormant conversations count too: their decisions stay readable (the list loads every group for this).
      const groups = state.conversations.filter(c => canReadGroup(state, actor, c)).map(c => c.id)
      const rows = await tx.superTabRouteDecision.findMany({ where: { tabId, conversationId: { in: groups } }, orderBy: { createdAt: 'desc' }, take: 100 })
      return rows.map(timedDecisionOf)
    })
  }

  async routeDecision(user: AuthUser, tabId: string, decisionId: string, asAgentId?: string) {
    return transaction(this.db, async tx => {
      const row = await tx.superTabRouteDecision.findFirst({ where: { id: decisionId, tabId }, select: { conversationId: true } })
      const { state } = await this.load(tx, user, tabId, { groupIds: row ? [row.conversationId] : [] })
      const actor = await this.actor(tx, user, state, asAgentId)
      author(state, actor)
      const decision = await tx.superTabRouteDecision.findFirst({ where: { id: decisionId, tabId } })
      if (decision) readConversation(state, actor, decision.conversationId)
      return decision ? timedDecisionOf(decision) : fail('NOT_FOUND', 'This routing decision is unavailable.', 404)
    })
  }

  /** Host polling discovers only registered sessions on its own machine, never unrelated tab transcripts. */
  /** Narrow authority: the machine owner can finish a specific queued start,
   * never submit arbitrary commands as its initiating person or lead. */
  private async poolHostActor(tx: Transaction, user: AuthUser, state: SuperTabState, machineId: string, startId: string): Promise<Actor> {
    await this.hostFor(tx, user, machineId)
    const start = state.starts?.find(s => s.id === startId) ?? fail('NOT_FOUND', 'This start is unavailable.', 404)
    const pool = machineContribution(state, machineId)
    if (!pool || pool.contributorId !== user.sub || pool.generation !== start.poolGeneration || start.request.machineId !== machineId || start.machineOwnerId !== user.sub) {
      fail('FORBIDDEN', 'This start does not belong to this machine contribution.', 403)
    }
    const owned = await tx.machine.findFirst({ where: { machineId, userId: user.sub, autonomousEnv: user.autonomousEnv, ...machineAlive } })
    if (!owned || !machineBillingAllowsDataPlane(owned)) fail('HOST_UNAVAILABLE', 'This execution host is unavailable.', 403)
    let actor: Actor
    if (start.actorKey.startsWith('agent:')) {
      const lead = agent(state, start.actorKey.slice(6))
      await this.agentGrant(tx, state, lead)
      actor = { kind: 'agent', agentId: lead.id, machineOwnerId: lead.machineOwnerId }
    } else {
      const member = person(state, start.actorKey.slice(7))
      actor = { kind: 'person', userId: member.id, email: member.email }
    }
    author(state, actor, true)
    return actor
  }

  /** What removing a machine would do, for its owner's confirmation (machines.ts removalPreview). */
  async machineRemoval(user: AuthUser, tabId: string, machineId: string) {
    return transaction(this.db, async tx => {
      const { state } = await this.load(tx, user, tabId)
      const actor = await this.actor(tx, user, state)
      author(state, actor)
      return removalPreview(state, actor, machineId)
    })
  }

  /** The owner's Swarms with the Local models add-on: what the owner's computer creates on grid and keeps in step. */
  async hostGrids(user: AuthUser) {
    this.personOnly(user)
    const rows = await this.db.superTab.findMany({ where: { autonomousEnv: user.autonomousEnv, ownerId: user.sub, format: 2 }, take: 100 })
    return transaction(this.db, async tx => {
      const grids = []
      for (const row of rows) { const grid = swarmGridRow(row.id, (await loadRow(tx, row)).state); if (grid) grids.push(grid) }
      return grids
    })
  }

  /** When each Swarm's time checks last ran on a machine's report, on this server (liveness.ts SWEEP_EVERY_MS). */
  private readonly swept = new Map<string, number>()

  /** Whether a machine's report runs its Swarm's time checks now; decided once per report, not per transaction attempt. */
  private sweepDue(tabId: string, now: number): boolean {
    const last = this.swept.get(tabId)
    if (last !== undefined && now - last < SWEEP_EVERY_MS) return false
    this.swept.set(tabId, now)
    return true
  }

  async observeMachine(user: AuthUser, tabId: string, machineId: string, input: MachineObservation) {
    const observation = machineObservationSchema.parse(input)
    const sweep = this.sweepDue(tabId, this.now())
    return transaction(this.db, async tx => {
      await this.hostFor(tx, user, machineId)
      const loaded = await this.load(tx, user, tabId), state = structuredClone(loaded.state)
      const pool = machineContribution(state, machineId)
      if (!pool || pool.contributorId !== user.sub || pool.generation !== observation.generation) fail('CONTRIBUTION_REVOKED', 'Read the current machine contribution.', 403)
      const owned = await tx.machine.findFirst({ where: { machineId, userId: user.sub, autonomousEnv: user.autonomousEnv, ...machineAlive } })
      if (!owned || !machineBillingAllowsDataPlane(owned)) fail('HOST_UNAVAILABLE', 'This execution host is unavailable.', 403)
      const now = this.now()
      // A machine that went silent while cleaning takes the fallback before this fresh reading can bring it back: its records
      // go, its cleanup waits for this host, as the next sweep would have done (machines.ts expireRemovals).
      expireRemovals(state, now)
      const stamp = clock.next()
      // A reading writes only its machine's part, and an agent's part only when its presence changes (spec); a group's only
      // when a task there is lost.
      const saved = async (lost: MessageDraft[] = []) => {
        const sequences = numberMessages(state, lost, now)
        const touches = judgedMachines(state, lost).filter(t => t.key !== machineId)
        await this.endRuns(tx, tabId, loaded.state, state)
        const version = (await this.save(tx, loaded, state, stamp, touches)).versions.get(`machine:${machineId}`) ?? 0
        await this.writeMessages(tx, tabId, state, lost, sequences)
        return { version }
      }
      if (!state.machines?.includes(pool)) return saved()
      recordAgentPresence(state, machineId, observation.runningHarnessIds, now)
      const team = isTeamSession(user)
      // Its privacy check counts only from the Harness Team account's own session; an ordinary sign-in's claim is dropped.
      // Progress is kept for running sessions only: their leases are read from it (liveness.ts).
      const { privacy: reported, harnessProgress, preparingStartIds, ...reading } = observation
      const progress = harnessProgress && Object.fromEntries(Object.entries(harnessProgress).filter(([id]) => observation.runningHarnessIds.includes(id)))
      // A machine says preparing only of the starts it launched that are neither running nor failed (liveness.ts).
      const preparing = preparingStartIds?.filter(id => state.starts?.some(s => s.id === id && s.request.machineId === machineId
        && s.dispatched && !s.harnessId && !s.error))
      const privacy = observedPrivacy(pool.observation?.privacy, reported, team, now)
      accrueLent(state, pool, now)
      pool.observation = { ...reading, quotas: observation.quotas.filter(q => contributedEngines(pool, observation).includes(q.engine)), receivedAt: now,
        // How the machine is signed in, from the session that reported and never from the report (lib/teamSession.ts).
        sessionKind: team ? 'team' : 'computer', ...(privacy ? { privacy } : {}), ...(progress ? { harnessProgress: progress } : {}),
        ...(preparing ? { preparingStartIds: preparing } : {}) }
      // Current-generation physical stop proof also finishes a close whose membership was already withdrawn.
      for (const proof of observation.stoppedReservations ?? []) {
        if (!observation.stoppedHarnessIds.includes(proof.harnessId)) continue
        const reservation = state.harnessReservations?.find(r => r.machineId === machineId && r.harnessId === proof.harnessId && r.generation === proof.generation)
        if (!reservation) continue
        state.harnessReservations = state.harnessReservations?.filter(r => r !== reservation)
        state.releasedHarnesses ??= []
        if (!state.releasedHarnesses.some(r => r.machineId === machineId && r.harnessId === proof.harnessId)) state.releasedHarnesses.push({ machineId, harnessId: proof.harnessId })
        const id = stableId('swarm-session', state.environment, user.sub, stableId(machineId, proof.harnessId))
        await tx.superTabSessionScope.updateMany({ where: { id, closeLeaseGeneration: proof.generation },
          data: { closeLeaseId: null, closeLeaseUntil: null, closeLeaseGeneration: null } })
      }
      // Its own agents lose their tasks at once (a stopped session); every 30 seconds it runs the Swarm's time checks too, so
      // they keep running when the Lead's own machine is the one that died.
      return saved([...loseTasks(state, now, worker => worker.machineId === machineId), ...sweep ? sweepLiveness(state, now) : []])
    })
  }

  async mayObserve(user: AuthUser, tabId: string, machineId: string, harnessId: string, machineOwnerId: string): Promise<boolean> {
    // Watching is a person's: a team session has no person to watch as.
    if (isTeamSession(user)) return false
    try {
      return await transaction(this.db, async tx => {
        const { state } = await this.load(tx, user, tabId)
        person(state, user.sub)
        const target = state.agents.find(a => a.machineId === machineId && a.harnessId === harnessId && a.machineOwnerId === machineOwnerId)
        if (!target) return false
        agent(state, target.id)
        if (!canWatchAgent(state, { kind: 'person', userId: user.sub, email: user.email }, target, await this.confidential(tx, target.id))) return false
        await this.agentGrant(tx, state, target)
        return true
      })
    } catch (error) { if (error instanceof SuperTabError) return false; throw error }
  }

  /** Whether an agent's session is confidential in any Swarm (confidential.ts). */
  private async confidential(tx: Transaction, agentId: string): Promise<boolean> {
    return (await confidentialSessions(tx, [agentId])).has(agentId)
  }

  /** Whether a terminal share may open, wherever it came from (routes/harnessShares.ts): a confidential session's only for
   *  its machine's person, even an ordinary share made outside any Swarm; a Swarm's share only while that Swarm allows it. */
  async mayOpenShare(user: AuthUser, share: { superTabId: string | null; machineId: string; agentId: string; ownerId: string }): Promise<boolean> {
    if (user.sub !== share.ownerId && await transaction(this.db, tx => this.confidential(tx, stableId(share.machineId, share.agentId)))) return false
    return !share.superTabId || this.mayObserve(user, share.superTabId, share.machineId, share.agentId, share.ownerId)
  }

  private deliveryAllowed(state: SuperTabState, delivery: SuperTabDelivery): boolean {
    const target = state.agents.find(a => a.id === delivery.agentId)
    const group = state.conversations.find(c => c.id === delivery.conversationId)
    if (!target || target.membershipGeneration !== delivery.membershipGeneration || !group || group.archived || !group.agentIds.includes(target.id)) return false
    const sender = delivery.authorKind === 'person' ? state.people.find(p => p.id === delivery.authorId) : state.agents.find(a => a.id === delivery.authorId)
    if (!sender) return false
    const actor: Actor = delivery.authorKind === 'person'
      ? { kind: 'person', userId: delivery.authorId, email: '' }
      : { kind: 'agent', agentId: delivery.authorId, machineOwnerId: (sender as Agent).machineOwnerId }
    // The Leads conversation belongs to no project: its members are the Leads, and an agent posts there only as a Lead.
    // A private conversation's sender and receiver must still be in its audience or be its Lead (projects.ts canReadGroup).
    if (isLeads(group) ? actor.kind === 'agent' && !ledProject(state, actor.agentId) : !canReadGroup(state, actor, group)) return false
    if (!canReadAgent(state, { kind: 'agent', agentId: target.id, machineOwnerId: target.machineOwnerId }, target) || !isLeads(group) &&
      !canReadGroup(state, { kind: 'agent', agentId: target.id, machineOwnerId: target.machineOwnerId }, group)) return false
    const generation = 'generation' in sender ? sender.generation : sender.membershipGeneration
    return generation === delivery.authorGeneration && (!('role' in sender) || sender.role !== 'viewer')
  }

  private async senderAllowed(tx: Transaction, state: SuperTabState, delivery: SuperTabDelivery): Promise<boolean> {
    if (delivery.nativeContextId && !await this.native.allowsDelivery(tx, state, delivery.nativeContextId)) return false
    if (delivery.authorKind !== 'agent') return true
    try { await this.agentGrant(tx, state, agent(state, delivery.authorId)); return true }
    catch (error) { if (error instanceof SuperTabError) return false; throw error }
  }

  /** When each caller's full delivery poll last succeeded for an agent, on this server: key is tab, agent and caller. */
  private readonly polled = new Map<string, number>()

  /**
   * Every running agent's host polls this each second. With nothing waiting and the full poll (which loads the Swarm and
   * runs the Lead's time checks) done within SWEEP_EVERY_MS, the answer is one indexed read: 15 agents were ~180 queries
   * a second and a whole-Swarm rewrite check each, on 2026-10-27 the backend at 5 pods. Only a caller whose full poll
   * succeeded is ever answered this way, so a stranger or a revoked host meets the authority checks every time.
   */
  async deliveries(user: AuthUser, tabId: string, agentId: string) {
    const key = `${tabId}:${agentId}:${user.sub}`, last = this.polled.get(key)
    if (last !== undefined && this.now() - last < SWEEP_EVERY_MS
      && !await this.db.superTabDelivery.findFirst({ where: { tabId, agentId, status: { in: [...OPEN_DELIVERY] } }, select: { id: true } })) return []
    const rows = await this.fullDeliveries(user, tabId, agentId)
    this.polled.set(key, this.now())
    if (this.polled.size > POLLED_CAP) for (const [k, at] of this.polled) if (this.now() - at >= SWEEP_EVERY_MS) this.polled.delete(k)
    return rows
  }

  private async fullDeliveries(user: AuthUser, tabId: string, agentId: string) {
    return transaction(this.db, async tx => {
      let loaded = await this.load(tx, user, tabId)
      // Work finished since the last digest and archived or asleep since still shipped, but ordinary loads leave it out
      // (#1757 review, 4): a due digest loads it.
      const led = ledProject(loaded.state, agentId)
      let asked: Array<{ conversationId: string; personId: string; count: number }> = []
      if (led && digestDue(led, this.now())) {
        const finished = await tx.swarmGroup.findMany({ where: { tabId, deleted: false, dormant: true, lastActivityAt: { gte: new Date(digestSince(led, this.now())) },
          OR: [{ projectId: led.id }, ...led.id === 'lead' ? [{ projectId: null }] : []] }, select: { key: true } })
        // A decision waits in its conversation even once that conversation went quiet.
        asked = await waitingInProject(tx, tabId, led.id)
        const groupIds = [...new Set([...finished.map(g => g.key), ...asked.map(d => d.conversationId)])]
        if (groupIds.length) loaded = await this.ensure(tx, loaded, { groupIds })
      }
      const state = structuredClone(loaded.state)
      author(state, await this.actor(tx, user, state, agentId), true)
      const target = agent(state, agentId)
      // A Lead's poll runs the time checks (liveness.ts): lost work wakes it in this same poll.
      const written = ledProject(state, agentId) ? sweepLiveness(state, this.now()) : []
      // The Lead's poll stops its project's idle workers too (tidy.ts): it is where what waits for each agent is known.
      const reviewers = led ? state.agents.filter(a => agentRole(a) === 'reviewer' && a.workDecision !== 'stop' && agentProjectId(state, a) === led.id).map(a => a.id) : []
      const asleep = reviewers.length ? (await tx.swarmGroup.findMany({ where: { tabId, deleted: false, dormant: true, agentIds: { hasSome: reviewers } },
        select: { data: true } })).map(row => row.data as unknown as Conversation) : []
      const idle = led ? stopIdleWorkers(state, led.id, this.now(), new Set((await tx.superTabDelivery.findMany({
        where: { tabId, status: { in: [...OPEN_DELIVERY] } }, select: { agentId: true }, distinct: ['agentId'] })).map(d => d.agentId)), asleep) : []
      written.push(...idle)
      const update = projectUpdateRequest(state, target, this.now())
      let woken = false
      if (update) {
        const progress = groupProject(state, conversation(state, update.conversationId)).progress!
        const pending = progress.requestMessageId
          ? await tx.superTabDelivery.findFirst({ where: { tabId, agentId, messageId: progress.requestMessageId,
            status: { in: ['queued', 'claimed', 'uncertain', 'delivered'] } } })
          : null
        if (!pending) {
          progress.requested = { ...progress.requested, ...update.source!.through as Record<string, number> }
          progress.requestedAt = this.now()
          progress.requestMessageId = update.id
          written.push(update)
          woken = true
        }
      }
      // The morning digest is due once a day; recording it as sent is part of this same write, so it is sent once.
      const digest = digestRequest(state, target, this.now(), asked)
      if (digest) {
        const project = projectOf(state, digest.source!.projectId as string)
        project.digest = { ...project.digest!, lastOn: digest.source!.on as string, lastAt: this.now() }
        written.push(digest)
      }
      // The poll also frees agents whose task the checks just lost, and any an older server left marked running (each poll; a
      // second finds none).
      await this.endRuns(tx, tabId, loaded.state, state)
      if (ledProject(state, agentId)) {
        await this.releaseRuns(tx, tabId, await this.staleRuns(tx, tabId, state))
      }
      // One write for all: the time checks' changes, the digest and the wake-ups'.
      const sequences = numberMessages(state, written, this.now())
      // A stop was judged from its machine's report that the session is clean: a newer report makes this write retry.
      await this.save(tx, loaded, state, clock.next(), [...judgedMachines(state, written), ...stoppedMachines(state, idle),
        ...woken ? [{ kind: 'agent' as const, key: agentId }] : []])
      await this.writeMessages(tx, tabId, state, written, sequences)
      const rows = await tx.superTabDelivery.findMany({ where: { tabId, agentId, status: { in: [...OPEN_DELIVERY] } },
        orderBy: { createdAt: 'asc' }, take: 100 })
      const allowed: SuperTabDelivery[] = []
      for (const delivery of rows) {
        if (this.deliveryAllowed(state, delivery) && await this.senderAllowed(tx, state, delivery)) allowed.push(delivery)
      }
      return allowed
    })
  }

  /** A withdrawn host can retire its own journal without regaining shared
   * conversation access. Machine ownership is captured when input is created. */
  async deliveryReceipt(user: AuthUser, tabId: string, agentId: string, deliveryId: string) {
    return transaction(this.db, async tx => {
      const { state } = await this.load(tx, user, tabId)
      const row = await tx.superTabDelivery.findFirst({ where: { id: deliveryId, tabId, agentId } })
      if (!row) fail('NOT_FOUND', 'This delivery is unavailable.', 404)
      const previous = state.agents.find(a => a.id === agentId && a.membershipGeneration === row.membershipGeneration)
      const owner = row.machineOwnerId ?? previous?.machineOwnerId
      if (owner !== user.sub) fail('FORBIDDEN', 'Only the recorded execution host can read this receipt.', 403)
      await this.hostFor(tx, user, row.machineId)
      const machine = await tx.machine.findFirst({ where: { machineId: row.machineId, userId: owner,
        autonomousEnv: user.autonomousEnv, ...machineAlive } })
      if (!machine || !machineBillingAllowsDataPlane(machine)) fail('HOST_UNAVAILABLE', 'This execution host is unavailable.', 403)
      return { id: row.id, status: row.status }
    })
  }

  /** No timeout reclaims an instruction: the same durable claim resumes, or the host reconciles it. */
  async delivery(user: AuthUser, tabId: string, agentId: string, deliveryId: string,
    action: { type: 'claim'; claimId: string } | { type: 'ack'; claimId: string; receipt: string; uncertain: boolean }
      | { type: 'hold'; claimId: string; reason: HoldReason }) {
    return transaction(this.db, async tx => {
      const named = await tx.superTabDelivery.findFirst({ where: { id: deliveryId, tabId, agentId }, select: { conversationId: true } })
      const loaded = await this.load(tx, user, tabId, { groupIds: named ? [named.conversationId] : [] }), state = loaded.state
      author(state, await this.actor(tx, user, state, agentId), true)
      const delivery = await tx.superTabDelivery.findFirst({ where: { id: deliveryId, tabId, agentId } })
      if (!delivery || !this.deliveryAllowed(state, delivery) || delivery.status === 'cancelled' ||
          !await this.senderAllowed(tx, state, delivery)) fail('DELIVERY_REVOKED', 'This instruction is no longer authorized.', 403)
      if (delivery.status === 'answered') fail('DELIVERY_RESOLVED', 'This message was already answered.')
      if (delivery.status === 'confirmed' || delivery.status === 'superseded') {
        fail('DELIVERY_RESOLVED', 'A person has already resolved this delivery.')
      }
      if (delivery.claimId && delivery.claimId !== action.claimId) fail('CLAIM_CONFLICT', 'Reconcile the existing delivery before claiming it again.')
      if (action.type !== 'claim' && !delivery.claimId) fail('NOT_CLAIMED', 'Claim this instruction before acknowledging it.')
      if (action.type === 'hold') return this.hold(tx, delivery, action.reason)
      const status = action.type === 'claim' ? delivery.status === 'queued' ? 'claimed' : delivery.status : action.uncertain ? 'uncertain' : 'delivered'
      if (delivery.status === 'delivered' && action.type === 'ack' && (action.uncertain || delivery.receipt !== action.receipt)) {
        fail('RECEIPT_CONFLICT', 'A delivered instruction keeps its original host receipt.')
      }
      // No Swarm-wide write: revocation and group changes write this delivery row, and the claim relies on its receiver and
      // its sender, whose parts it touches (spec ruling 9, design section 3.5).
      await this.save(tx, loaded, state, clock.next(), deliveryTouches(delivery))
      const updated = await tx.superTabDelivery.update({ where: { id: delivery.id }, data: { status, claimId: action.claimId,
        ...(action.type === 'ack' ? { receipt: action.receipt, holdReason: null, holdSince: null,
          ...(!action.uncertain ? { deliveredAt: delivery.deliveredAt ?? new Date(this.now()) } : {}) } : {}) } })
      const message = await tx.superTabMessage.findUnique({ where: { id: delivery.messageId } })
      return { delivery: updated, message }
    })
  }

  /** The host cannot type a claimed instruction yet. Recorded on the delivery for logs; nothing is posted, nobody is told it waits. */
  private async hold(tx: Transaction, delivery: SuperTabDelivery, reason: HoldReason) {
    if (delivery.status !== 'claimed') return { held: false }
    if (agentOnly((await tx.superTabMessage.findUnique({ where: { id: delivery.messageId }, select: { source: true } }))?.source)) return { held: false }
    if (delivery.holdReason !== reason || !delivery.holdSince) {
      await tx.superTabDelivery.update({ where: { id: delivery.id }, data: { holdReason: reason, holdSince: delivery.holdSince ?? new Date(this.now()) } })
    }
    return { held: true }
  }

  /** Archives a finished group whose pull requests `checked` were all read merged or closed (archive.ts), only if it still
   *  qualifies inside this write: no message since, no decision waiting and no pull request linked since the read. Its
   *  queued deliveries are kept for when it reopens, as a person's archive keeps them. True when it archived. */
  async archiveFinished(tabId: string, groupId: string, checked: readonly string[]): Promise<boolean> {
    return transaction(this.db, async tx => {
      const row = await tx.superTab.findUnique({ where: { id: tabId } })
      if (!row) return false
      const loaded = await loadRow(tx, requireParts(row), { groupIds: [groupId] }), state = structuredClone(loaded.state)
      const group = state.conversations.find(c => c.id === groupId)
      const now = this.now()
      if (!group || !archivable(state, group, now) || (group.pullRequestUrls ?? []).some(url => !checked.includes(url))) return false
      if (await waitingIn(tx, tabId, groupId)) return false
      group.archived = true
      const line = archiveLine(state, group, now), rows = line ? [line] : []
      const sequences = numberMessages(state, rows, now)
      if (!dirtyGroups(state, groupProject(state, group)).includes(group)) group.dormant = true
      // As a person's archive does (execute): a claim of a delivery here conflicts with this write.
      await tx.superTabDelivery.updateMany({ where: { tabId, conversationId: groupId, status: { in: [...OPEN_DELIVERY] } }, data: { updatedAt: new Date(now) } })
      await this.save(tx, loaded, state, clock.next())
      await this.writeMessages(tx, tabId, state, rows, sequences)
      return true
    })
  }

  /** Only the recorded execution host may attest that the actual session/attempt has stopped. */
  async stopped(user: AuthUser, tabId: string, assignmentId: string, receipt: string) {
    let ended: WorkHold[] = []
    const done = await transaction(this.db, async tx => {
      ended = []
      const loaded = await this.load(tx, user, tabId), state = structuredClone(loaded.state)
      const before = { agents: state.agents, conversations: structuredClone(state.conversations) }
      const group = state.conversations.find(c => c.assignment?.id === assignmentId)
      const assignment = group?.assignment
      if (!assignment || assignment.execution.machineOwnerId !== user.sub) fail('FORBIDDEN', 'Only the execution host can confirm this stop.', 403)
      const execution = assignment.execution
      await this.hostFor(tx, user, execution.machineId)
      const machine = await tx.machine.findFirst({ where: { machineId: execution.machineId, userId: user.sub, autonomousEnv: user.autonomousEnv, ...machineAlive } })
      if (!machine) fail('HOST_UNAVAILABLE', 'This execution host is unavailable.', 403)
      const id = stableId('stop', tabId, assignmentId)
      const prior = await tx.superTabStopReceipt.findUnique({ where: { id } })
      if (prior && prior.receipt !== receipt) fail('RECEIPT_CONFLICT', 'This stop already has a host receipt.')
      const notices: MessageDraft[] = []
      if (group && activeWork(group)) {
        assignment.status = 'stopped'
        finishWorker(state, assignment.agentId, group)
        assignment.result = 'The execution host confirmed that this harness stopped.'
        await tx.superTabRun.deleteMany({ where: { tabId, assignmentId } })
        await tx.superTabDelivery.updateMany({ where: { tabId, assignmentId,
          status: { in: ['queued', 'claimed', 'uncertain'] } }, data: { status: 'cancelled', holdReason: null, holdSince: null } })
        await closeAssignment(tx, tabId, assignmentId, 'stopped', this.now())
        // No agent command closes this attempt, so nobody was told: in the two-account E2E of 2026-10-19
        // the Lead learned of a stopped worker only by re-reading status. Say it in the group, as the
        // worker's own Stopped update would, and deliver it to the Lead. A removed worker was removed
        // on purpose by someone who already knows.
        const worker = state.agents.find(a => a.id === assignment.agentId)
        if (worker) {
          worker.downSince ??= new Date(this.now()).toISOString()
          const lead = group.leadId && group.leadId !== worker.id && group.agentIds.includes(group.leadId) ? group.leadId : null
          notices.push({ id: stableId('stop-notice', tabId, assignmentId), conversationId: group.id,
            author: author(state, { kind: 'agent', agentId: worker.id, machineOwnerId: worker.machineOwnerId }),
            text: `Stopped\n\n${assignment.result} If this work should continue, assign a new attempt.`, replyTo: null, recipients: lead ? [lead] : [] })
        }
      }
      const sequences = numberMessages(state, notices, this.now())
      // A confirmed stop finishes its worker, as work.status stopped does (design ruling R5).
      const project = group ? groupProject(state, group).id : undefined
      await this.save(tx, loaded, state, clock.next(), project && state.projects ? [{ kind: 'progress', key: project }] : [])
      await this.writeMessages(tx, tabId, state, notices, sequences)
      if (!prior) await tx.superTabStopReceipt.create({ data: { id, tabId, assignmentId, ...execution, receipt } })
      ended = endedHolds(before, state)
      return { confirmed: true }
    })
    this.endWork(tabId, ended)
    return done
  }
}
