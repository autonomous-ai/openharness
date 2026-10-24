import { contributedEngines, expireRemovals, hostLocalGrid, LASTING_TEAM_REFUSALS, machineContribution, machineObservationSchema, machineSlots, observedPrivacy, recordAgentPresence, removalPreview, swarmGridRow, teamWorkRefusal, type MachineObservation } from './machines.js'
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
import { agentSetRole, canReadAgent, canReadProject, groupProject, ledProject, projectsOf, agentProjectId, readConversation, roleVersion, skillModeOf, skillSetOf, type ProjectVisibility } from './projects.js'
import { bindSession, makeProjectPrivate } from './sessionScope.js'
import { noteProjectReports, projectUpdateRequest } from './projectUpdates.js'
import { revokeNativeContexts, SuperTabNativeStore } from './native.js'
import {
  activeWork, actorKey, agent, agentOnly, appendPullRequestUrls, author, conversation, createSuperTab, fail, person, stableId, visibleState, finishWorker,
  SuperTabError, isLeads, parkLaterConversations, syncLeads, type Actor, type Agent, type Assignment, type Author, type MessageDraft, type SuperTabState,
} from './model.js'
import { holdNoticeText, type HoldReason } from './holdNotice.js'
import { agentDisplayName } from './agentNames.js'
import { endedHolds, HOLDING, type WorkHold } from '../github/holds.js'
import { mayDrive, TERMINAL_ANSWER_MS, TERMINAL_EXPIRY_MS, TERMINAL_PICKUP_MS, type TerminalEffect } from './terminal.js'
import { closeAssignment, closeUnassignedStart, readDecision, recentRoutes, timedDecisionOf, writeRouteEffects } from './routeDecisions.js'
import { listMentions, markDone, mentionsWaiting, readMention, resolveByReply, writeMentions } from './mentions.js'
import { DEFAULT_ROUTING_POLICY, effectivePolicy, routingPolicySchema, type RoutingPolicy } from './routingPolicy.js'
import { authenticatedEmail, authorizeSwarmJoin, configureSharing, joinSwarmSchema, requireSharingOwner,
  saveSharingSchema, sharingDetails, type JoinSwarm, type SaveSharing } from './sharing.js'

type Transaction = Prisma.TransactionClient
const json = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue
type SendCommand = Extract<Command, { type: 'message.send' }>
// Prisma on MongoDB: `usedBy: null` alone misses rows that never had the field.
const unused = { OR: [{ usedBy: null }, { usedBy: { isSet: false } }] }
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const stateOf = (row: SuperTab): SuperTabState => {
  const state = row.state as unknown as SuperTabState
  if (state.version !== 1) fail('UPDATE_REQUIRED', 'Update Harness to open this Super Tab.', 409)
  parkLaterConversations(state)
  syncLeads(state)
  return state
}

/** Old groups have no link list. Reconstruct theirs from complete stored history once; current groups accumulate
 * links on write. */
async function restorePullRequestUrls(tx: Transaction, tabId: string, state: SuperTabState): Promise<void> {
  const missing = state.conversations.filter(group => group.pullRequestUrls === undefined)
  if (!missing.length) return
  const conversationIds = missing.map(group => group.id)
  const [messages, attempts] = await Promise.all([
    tx.superTabMessage.findMany({ where: { tabId, conversationId: { in: conversationIds }, text: { contains: 'https://github.com/' } },
      select: { conversationId: true, text: true }, orderBy: { sequence: 'asc' } }),
    tx.superTabAttempt.findMany({ where: { tabId, conversationId: { in: conversationIds } },
      select: { conversationId: true, snapshot: true }, orderBy: { createdAt: 'asc' } }),
  ])
  for (const group of missing) {
    const prior = attempts.filter(attempt => attempt.conversationId === group.id)
      .map(attempt => attempt.snapshot as unknown as { checks?: Array<{ evidence?: string | null }>; assignment?: { result?: string | null } })
    appendPullRequestUrls(group, [
      ...messages.filter(message => message.conversationId === group.id).map(message => message.text),
      ...prior.flatMap(attempt => [...(attempt.checks ?? []).map(check => check.evidence), attempt.assignment?.result]),
      ...group.checks.map(check => check.evidence), group.assignment?.result,
    ])
  }
}
const indexes = (state: SuperTabState) => ({
  memberIds: state.people.map(p => p.id), invitedEmails: state.invitations.map(i => i.email),
  machineIds: [...new Set([...state.agents.map(a => a.machineId), ...(state.machines ?? []).map(m => m.machineId),
    ...state.conversations.filter(activeWork).map(c => c.assignment!.execution.machineId), ...(state.closingSessions ?? []).map(c => c.machineId),
    ...(state.machineCleanups ?? []).map(c => c.machineId)])],
  cleanupMachineIds: cleanups(state).map(c => c.machineId),
})
/** Removed machines whose host has not yet said it cleaned up: still listed (machine.removal), or past the 24 h fallback. */
const cleanups = (state: SuperTabState) => [
  ...(state.machines ?? []).flatMap(m => m.removal ? [{ machineId: m.machineId, removalId: m.removal.id, machineOwnerId: m.contributorId }] : []),
  ...(state.machineCleanups ?? [])]

/** A machine its owner removed: its host deletes the Swarm's folders for this tab, then says so (machine.cleaned).
 *  The row has no agent, so a host from before removals skips it. */
const cleanupRows = (tabId: string, state: SuperTabState, machineId: string, ownerId: string) =>
  cleanups(state).filter(c => c.machineId === machineId && c.machineOwnerId === ownerId)
    .map(({ removalId }) => ({ tabId, cleanup: { machineId, removalId } }))

/** A host reads its 100 most recently changed Swarms. Unordered, a Swarm just joined could be cut by older ones, such as
 *  Swarms only waiting for this machine to close a removed agent's session. */
const HOST_TABS = { orderBy: { updatedAt: 'desc' as const }, take: 100 }

/** Retrying a transaction never repeats a host action. All effects here are durable database writes. */
async function transaction<T>(db: PrismaClient, body: (tx: Transaction) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await db.$transaction(body) } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : null
      if (attempt >= 4 || (code !== 'P2034' && code !== 'P2002')) throw error
    }
  }
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
}

/** Persistent coordination. Host adapters own execution and must confirm their local session grants. */
export class SuperTabStore {
  readonly native: SuperTabNativeStore
  constructor(private readonly db: PrismaClient, private readonly now: () => number = Date.now,
    private readonly attachments: Attachments | null = null, private readonly hooks: SuperTabStoreHooks = {}) {
    this.native = new SuperTabNativeStore({
      transaction: body => transaction(db, body),
      row: async (tx, user, tabId) => { const row = await this.row(tx, user, tabId); return { row, state: stateOf(row) } },
      agentGrant: (tx, state, target) => this.agentGrant(tx, state, target),
      contribution: (tx, state, actor, command) => this.contribution(tx, state, actor, command),
      teamHost: (tx, user) => this.teamHost(tx, user),
    })
  }

  // ── A Mac's team account (lib/teamSession.ts) ────────────────────────────────────────────────────
  // Its daemon is signed in as the person, so `user.sub` alone would let it speak for the person and for every machine
  // of theirs. It may host only its own machine and speak only as the agents running there.

  /** The one machine a team session hosts for; null for any other sign-in. One with no machine to act for does nothing. */
  private async teamHost(tx: Transaction, user: AuthUser): Promise<string | null> {
    if (!isTeamSession(user)) return null
    return (await teamMachine(user, tx))?.machineId ?? fail(TEAM_SESSION_LIMITED, TEAM_SESSION_MESSAGE, 403)
  }

  /** A host route of a team session must name its own machine. */
  private async hostFor(tx: Transaction, user: AuthUser, machineId: string): Promise<void> {
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
  private async teamMachines(tx: Transaction, state: SuperTabState): Promise<string[]> {
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
      const row = await this.row(tx, user, tabId)
      const state = stateOf(row)
      author(state, await this.actor(tx, user, state, asAgentId))
      const account = await tx.routingPolicy.findUnique({ where: { id: stableId('routing-policy', state.ownerId, state.environment) } })
      // The owner's account policy alone, so a field reset to "use account default" can show its value.
      return { ...effectivePolicy(account?.policy ?? null, state.routingPolicy ?? null), override: state.routingPolicy ?? null,
        account: effectivePolicy(account?.policy ?? null, null).policy }
    })
  }

  private async row(tx: Transaction, user: AuthUser, tabId: string) {
    return await tx.superTab.findFirst({ where: { id: tabId, autonomousEnv: user.autonomousEnv } }) ??
      fail('NOT_FOUND', 'This Super Tab is unavailable.', 404)
  }

  private async actor(tx: Transaction, user: AuthUser, state: SuperTabState, agentId?: string): Promise<Actor> {
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

  private async agentGrant(tx: Transaction, state: SuperTabState, target: Agent): Promise<void> {
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
    if (pooled) {
      const pool = machineContribution(state, command.machineId)
      if (pool) {
        if (pool.contributorId !== machine.userId) fail('CONTRIBUTION_REVOKED', 'The machine owner changed.', 403)
        return { machineOwnerId: machine.userId, contributorId: pool.contributorId, hostGrant: null }
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
    return { machineOwnerId: machine.userId, contributorId, hostGrant }
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
      await tx.superTab.create({ data: { id, ownerId: user.sub, autonomousEnv: user.autonomousEnv, ...indexes(state), state: json(state) } })
      await tx.superTabOperation.create({ data: { id, tabId: id, actorKey: `person:${user.sub}`, requestHash, revision: 0, result: { id } } })
      return { id, revision: 0 }
    })
  }

  async list(user: AuthUser, after?: string) {
    this.personOnly(user)
    const rows = await this.db.superTab.findMany({ where: { autonomousEnv: user.autonomousEnv, memberIds: { has: user.sub },
      ...(after ? { id: { gt: after } } : {}) }, orderBy: { id: 'asc' }, take: 101 })
    return { tabs: rows.slice(0, 100).map(row => {
      const state = stateOf(row)
      return { id: row.id, name: state.name, ownerId: row.ownerId, revision: row.revision, paused: state.paused }
    }), next: rows.length > 100 ? rows[99]!.id : null }
  }

  async invitations(user: AuthUser) {
    this.personOnly(user)
    const email = user.email.trim().toLowerCase()
    const rows = await this.db.superTab.findMany({ where: { autonomousEnv: user.autonomousEnv, invitedEmails: { has: email } }, take: 100 })
    return rows.flatMap(row => {
      const state = stateOf(row)
      return state.invitations.filter(i => i.email === email && i.expiresAt > this.now())
        .map(i => ({ tabId: row.id, name: state.name, inviteId: i.id, role: i.role, expiresAt: i.expiresAt }))
    })
  }

  async sharing(user: AuthUser, tabId: string) {
    this.personOnly(user)
    return transaction(this.db, async tx => {
      const state = stateOf(await this.row(tx, user, tabId))
      requireSharingOwner(state, user.sub)
      return sharingDetails(state)
    })
  }

  async saveSharing(user: AuthUser, tabId: string, input: SaveSharing) {
    this.personOnly(user)
    const request = saveSharingSchema.parse(input)
    return transaction(this.db, async tx => {
      const row = await this.row(tx, user, tabId), state = stateOf(row)
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
      const revision = row.revision + 1
      await tx.superTab.update({ where: { id: tabId, revision: row.revision }, data: { revision, state: json(state) } })
      await tx.superTabOperation.create({ data: { id: receiptId, tabId, actorKey: `person:${user.sub}`, requestHash,
        revision, result: { generation: state.sharing.generation } } })
      return sharingDetails(state)
    })
  }

  /** A signed-in preview contains no projects, people, machines, or conversation data. It never joins. */
  async previewJoin(user: AuthUser, tabId: string, token?: string) {
    this.personOnly(user)
    return transaction(this.db, async tx => {
      const state = stateOf(await this.row(tx, user, tabId))
      const sharing = authorizeSwarmJoin(state, user.email, token)
      const member = state.people.find(p => p.id === user.sub)
      return { id: tabId, name: state.name, role: member?.role ?? sharing.access.role, alreadyMember: !!member }
    })
  }

  async join(user: AuthUser, tabId: string, input: JoinSwarm) {
    this.personOnly(user)
    const request = joinSwarmSchema.parse(input)
    return transaction(this.db, async tx => {
      const row = await this.row(tx, user, tabId), state = stateOf(row)
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
        return { id: tabId, revision: prior.revision, role: member.role, alreadyMember: result.alreadyMember === true }
      }
      const alreadyMember = !!member
      if (!member) {
        member = { id: user.sub, email: authenticatedEmail(user.email)!, role: sharing.access.role, generation: receiptId }
        state.people.push(member)
      }
      // Existing people retain their role and private-project grants. A general
      // access link does not promote a viewer or grant a private project.
      const revision = row.revision + 1
      await tx.superTab.update({ where: { id: tabId, revision: row.revision }, data: { revision, state: json(state), ...indexes(state) } })
      await tx.superTabOperation.create({ data: { id: receiptId, tabId, actorKey: `person:${user.sub}`, requestHash, revision,
        result: { sharingGeneration: sharing.generation, membershipGeneration: member.generation ?? null, alreadyMember } } })
      return { id: tabId, revision, role: member.role, alreadyMember }
    })
  }

  async read(user: AuthUser, tabId: string, asAgentId?: string) {
    return transaction(this.db, async tx => {
      const row = await this.row(tx, user, tabId)
      const state = stateOf(row)
      const actor = await this.actor(tx, user, state, asAgentId)
      if (state.conversations.some(group => group.pullRequestUrls === undefined)) {
        await restorePullRequestUrls(tx, tabId, state)
        // Keep the revision: this adds optional metadata and does not change work or messages. A concurrent
        // command with a newer revision owns the state; its write also reconstructs any missing link lists.
        await tx.superTab.updateMany({ where: { id: tabId, revision: row.revision }, data: { state: json(state) } })
      }
      const now = this.now()
      const visible = visibleState(state, actor, now)
      const mentions = actor.kind === 'person' ? { mentionsWaiting: await mentionsWaiting(tx, tabId, state, actor, now) } : {}
      const teamMachines = visible.machines?.length ? await this.teamMachines(tx, state) : []
      return { revision: row.revision, state: { ...visible, ...mentions, machines: visible.machines?.map(pool => {
        const stored = state.machines!.find(m => m.machineId === pool.machineId)!
        // Whether it takes teammates' projects now, and if not why (machines.ts teamWorkRefusal): what routing leaves it
        // out for, and what Desktop can show on the machine.
        const refusal = teamWorkRefusal(stored, now, teamMachines.includes(pool.machineId))
        return { ...pool, availableSlots: Math.max(0, pool.maxAgents - machineSlots(state, stored)),
          teamWork: refusal ? { allowed: false as const, ...refusal } : { allowed: true as const } }
      }) } }
    })
  }

  async start(user: AuthUser, tabId: string, startId: string, asAgentId?: string, hostMachineId?: string) {
    return transaction(this.db, async tx => {
      const state = stateOf(await this.row(tx, user, tabId))
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
      return start
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
        const row = await this.db.superTab.findFirst({ where: { id: tabId, autonomousEnv: user.autonomousEnv } })
        const start = row ? stateOf(row).starts?.find(s => s.id === command.startId) : undefined
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
      const row = await this.row(tx, user, tabId)
      const original = stateOf(row)
      const team = await this.teamHost(tx, user)
      // Removal retries can arrive after the actor itself left. Return only this host's exact prior receipt.
      if (command.type === 'agent.remove' && asAgentId === command.agentId && !original.agents.some(a => a.id === asAgentId)) {
        const prior = await tx.superTabOperation.findUnique({ where: { id: stableId(tabId, `agent:${asAgentId}`, operationId) } })
        const result = prior?.result as Record<string, unknown> | undefined
        // A team session's only if the removed agent ran on its machine; a receipt from before that was recorded is not.
        if (prior && prior.requestHash === hash(command) && result?.releasedBy === user.sub && (team === null || result.releasedMachineId === team)) {
          return { revision: prior.revision, result: prior.result }
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
          if ('decisionId' in command) {
            const decision = await readDecision(tx, tabId, command.decisionId) ?? fail('NOT_FOUND', 'This routing decision is unavailable.', 404)
            readConversation(original, actor, decision.conversationId)
          }
        }
        if (command.type === 'project.create' &&
            !projectsOf(original).some(p => p.id === (prior.result as Record<string, unknown>).projectId)) {
          fail('NOT_FOUND', 'This project was deleted. Create a new project.', 404)
        }
        return { revision: prior.revision, result: prior.result }
      }
      if (command.type !== 'invite.accept' && command.type !== 'agent.sessionClosed' && command.type !== 'machine.cleaned') author(original, actor)
      const context: CommandContext = { operationId, now: this.now() }
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
      if ((command.type === 'rule.set' || command.type === 'rule.remove' || command.type === 'project.skills') && command.askedIn) {
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
      if (command.type === 'message.send' && command.attachmentIds?.length) context.attachments = await this.sendable(tx, tabId, actor, command)
      if (command.type === 'route.record') context.recentRoutes = await recentRoutes(tx, tabId, context.now)
      if (TEAM_WORK_COMMANDS.has(command.type)) context.teamMachines = await this.teamMachines(tx, original)
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
      await restorePullRequestUrls(tx, tabId, original)
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
        const registrations = await tx.superTab.findMany({ where: { autonomousEnv: original.environment,
          machineIds: { has: target.machineId } } })
        if (registrations.some(row => stateOf(row).agents.some(a => a.machineId === target.machineId
          && a.harnessId === command.harnessId && a.id !== target.id))) {
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
      if (command.type === 'project.sharing' && command.visibility === 'private') {
        await makeProjectPrivate(tx, effects.state, command.projectId)
      }
      await revokeNativeContexts(tx, original, effects.state)
      const removedGroups = original.conversations.filter(c => !effects.state.conversations.some(n => n.id === c.id))
      if (removedGroups.length) {
        // Keep immutable history and operation receipts for audit/replay; all
        // reads require a live conversation. No removed group can deliver work.
        await tx.superTabDelivery.updateMany({ where: { tabId, conversationId: { in: removedGroups.map(c => c.id) },
          status: { in: ['queued', 'claimed', 'uncertain'] } }, data: { status: 'cancelled', holdReason: null, holdSince: null } })
      }
      const revision = row.revision + 1
      if (command.type === 'work.assign' || command.type === 'work.status' || command.type === 'message.send') {
        const group = conversation(effects.state, command.conversationId)
        const assignment = group.assignment
        if (assignment && (command.type !== 'message.send' || actor.kind === 'agent' && actor.agentId === assignment.agentId)) {
          // Even an unchanged working status is fresh evidence that the agent
          // continued. An older queued gap must not turn that progress into Stuck.
          assignment.recordingProgress = { at: context.now, revision }
        }
      }
      if (command.type === 'agent.add' || command.type === 'agent.started' || command.type === 'agent.configuration' || command.type === 'agent.rebind') {
        for (const target of effects.state.agents) {
          if (target.configurationVersion !== receiptId) continue
          const previous = original.agents.find(a => a.id === target.id)
          if (previous?.configurationVersion === target.configurationVersion) continue
          await tx.superTabConfiguration.create({ data: {
            id: stableId(tabId, target.id, operationId), tabId, agentId: target.id, revision,
            configuration: json(target.configuration), actorKey: actorKey(actor), observedAt: new Date(context.now),
            assignmentIds: effects.state.conversations.filter(group => activeWork(group) && group.assignment?.agentId === target.id)
              .map(group => group.assignment!.id),
          } })
        }
      }
      for (const message of shown) conversation(effects.state, message.conversationId).lastMessageSequence = revision
      noteProjectReports(effects.state, shown, revision, context.now)
      if (command.type === 'agent.release' && command.decision === 'stop') {
        const target = agent(effects.state, command.agentId)
        const assignmentId = `release-${target.releaseId}`
        const running = await tx.superTabRun.findUnique({ where: { id: target.id } })
        if (running && (running.tabId !== tabId || running.assignmentId !== assignmentId)) fail('AGENT_BUSY', 'This agent already owns active work in a Swarm or is stopping elsewhere.')
        const registrations = await tx.superTab.findMany({ where: { autonomousEnv: original.environment, machineIds: { has: target.machineId }, id: { not: tabId } } })
        if (registrations.some(row => stateOf(row).agents.some(a => a.id === target.id && a.machineOwnerId === target.machineOwnerId))) {
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
        if (running) fail('AGENT_BUSY', 'This agent already owns active work in a Super Tab.')
        await tx.superTabRun.create({ data: { id: assigned.agentId, tabId, assignmentId: assigned.id,
          machineId: assigned.execution.machineId, harnessId: assigned.execution.harnessId } })
      }
      for (const group of original.conversations.filter(activeWork)) {
        const changed = conversation(effects.state, group.id)
        if (activeWork(changed)) continue
        await tx.superTabRun.deleteMany({ where: { tabId, assignmentId: group.assignment!.id } })
        await tx.superTabDelivery.updateMany({ where: { tabId, assignmentId: group.assignment!.id,
          status: { in: ['queued', 'claimed', 'uncertain'] } }, data: { status: 'cancelled', holdReason: null, holdSince: null } })
      }
      await tx.superTab.update({ where: { id: tabId, revision: row.revision }, data: {
        revision, state: json(effects.state), ...indexes(effects.state),
      } })
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
      await this.writeMessages(tx, tabId, effects.state, effects.messages, revision)
      if (command.type === 'message.send' && actor.kind === 'person') await resolveByReply(tx, tabId, command.conversationId, actor.userId, context.now)
      await writeMentions(tx, tabId, effects.state, effects.messages, context.now)
      if (command.type === 'mention.done') await markDone(tx, tabId, command.mentionId, context.mention!.personId, context.now)
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
        const progress = projectsOf(original).find(p => p.id === command.projectId)?.progress
        if (progress?.requestMessageId && command.throughRevision >= progress.requestedRevision) {
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
        revision, result: json(effects.result) } })
      return { revision, result: effects.result }
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
      const state = stateOf(await this.row(tx, user, tabId))
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
      const state = stateOf(await this.row(tx, user, tabId))
      const actor = await this.poolHostActor(tx, user, state, machineId, startId)
      const start = state.starts?.find(s => s.id === startId) ?? fail('NOT_FOUND', 'This agent start is unavailable.', 404)
      if (start.harnessId || start.error) fail('START_SETTLED', 'This start has already started or failed; its folder is not prepared again.', 409)
      const group = readConversation(state, actor, start.request.conversationId)
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
    const state = stateOf(await this.row(tx, user, tabId))
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
      const state = stateOf(await this.row(tx, user, tabId))
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
        const state = stateOf(await this.row(tx, user, tabId))
        const actor = await this.actor(tx, user, state, asAgentId)
        author(state, actor)
        const now = this.now()
        const row = await tx.superTabTerminalRequest.findFirst({ where: { id: requestId, tabId, createdAt: { gte: new Date(now - TERMINAL_EXPIRY_MS) } } })
        if (!row || row.requesterKey !== actorKey(actor)) fail('NOT_FOUND', 'This terminal request is unavailable.', 404)
        // A sender who has since lost write access, or is no longer the agent's project Lead, gets nothing.
        mayDrive(state, actor, agent(state, row.agentId))
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
          states.set(row.tabId, tab && stateOf(tab))
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
      mayDrive(state, requester, target)
    } catch (error) {
      if (error instanceof SuperTabError) return 'This request is no longer allowed.'
      throw error
    }
    return null
  }

  /** Records committed messages and one delivery per recipient, at the tab revision that carried them. */
  private async writeMessages(tx: Transaction, tabId: string, state: SuperTabState, messages: MessageDraft[], revision: number) {
    for (const message of messages) {
      await tx.superTabMessage.create({ data: { id: message.id, tabId, conversationId: message.conversationId,
        sequence: revision, author: json(message.author), ...(message.source ? { source: json(message.source) } : {}),
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

  async messages(user: AuthUser, tabId: string, conversationId: string, cursor: { after?: number; before?: number; messageId?: string }, asAgentId?: string) {
    return transaction(this.db, async tx => {
      const row = await this.row(tx, user, tabId)
      const state = stateOf(row)
      const actor = await this.actor(tx, user, state, asAgentId)
      readConversation(state, actor, conversationId)
      const forward = cursor.after !== undefined
      const where = { tabId, conversationId,
        ...(cursor.messageId ? { id: cursor.messageId } : {}),
        ...(forward ? { sequence: { gt: cursor.after } } : cursor.before !== undefined ? { sequence: { lt: cursor.before } } : {}) }
      // An agent-only notice is listed for its own recipient alone. Hidden rows never shorten a page: Desktop reads on from the
      // last row it shows, so the page reads past them until it has 101 rows this reader may see, or reaches the end.
      const rows: SuperTabMessage[] = []
      for (let skip = 0; rows.length <= 100; skip += 101) {
        const batch = await tx.superTabMessage.findMany({ where, orderBy: { sequence: forward ? 'asc' : 'desc' }, skip, take: 101 })
        rows.push(...batch.filter(m => !agentOnly(m.source) || (actor.kind === 'agent' && m.recipientIds.includes(actor.agentId))))
        if (batch.length < 101) break
      }
      const page = rows.slice(0, 100)
      const next = rows.length > 100 ? page.at(-1)!.sequence : null
      if (!forward) page.reverse()
      const deliveries = page.length ? await tx.superTabDelivery.findMany({ where: { tabId, messageId: { in: page.map(m => m.id) } },
        select: { id: true, messageId: true, agentId: true, status: true, receipt: true,
          holdReason: true, holdSince: true, deliveredAt: true, answeredAt: true, createdAt: true, updatedAt: true } }) : []
      return { messages: page.map(m => ({ ...m, mentions: m.mentions ?? [], deliveries: deliveries.filter(d => d.messageId === m.id) })), next, revision: row.revision }
    })
  }

  /** The caller's own tags in this Swarm, newest first: still waiting, or answered and marked done. */
  async mentions(user: AuthUser, tabId: string, state: 'waiting' | 'earlier') {
    this.personOnly(user)
    return transaction(this.db, async tx => {
      const row = await this.row(tx, user, tabId)
      return { mentions: await listMentions(tx, tabId, stateOf(row), { kind: 'person', userId: user.sub, email: user.email }, this.now(), state === 'waiting') }
    })
  }

  /**
   * Every earlier attempt of one group. `work.define` takes a stopped assignment out of the state, so this is the
   * only place a reader (the Lead choosing an agent for a retry) can still see who tried and how it ended
   * (manual run 2026-10-19). The snapshot also holds the host grant and configuration; none of it leaves here.
   */
  async attempts(user: AuthUser, tabId: string, conversationId: string, asAgentId?: string) {
    return transaction(this.db, async tx => {
      const state = stateOf(await this.row(tx, user, tabId))
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
      const state = stateOf(await this.row(tx, user, tabId))
      const actor = await this.actor(tx, user, state, asAgentId)
      const groups = visibleState(state, actor).conversations.map(c => c.id)
      const rows = await tx.superTabRouteDecision.findMany({ where: { tabId, conversationId: { in: groups } }, orderBy: { createdAt: 'desc' }, take: 100 })
      return rows.map(timedDecisionOf)
    })
  }

  async routeDecision(user: AuthUser, tabId: string, decisionId: string, asAgentId?: string) {
    return transaction(this.db, async tx => {
      const state = stateOf(await this.row(tx, user, tabId))
      const actor = await this.actor(tx, user, state, asAgentId)
      author(state, actor)
      const row = await tx.superTabRouteDecision.findFirst({ where: { id: decisionId, tabId } })
      if (row) readConversation(state, actor, row.conversationId)
      return row ? timedDecisionOf(row) : fail('NOT_FOUND', 'This routing decision is unavailable.', 404)
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

  async hostPools(user: AuthUser, machineId: string) {
    return transaction(this.db, async tx => {
      await this.hostFor(tx, user, machineId)
      const owned = await tx.machine.findFirst({ where: { machineId, userId: user.sub, autonomousEnv: user.autonomousEnv, ...machineAlive } })
      if (!owned || !machineBillingAllowsDataPlane(owned)) fail('HOST_UNAVAILABLE', 'This execution host is unavailable.', 403)
      const rows = await tx.superTab.findMany({ where: { autonomousEnv: user.autonomousEnv, machineIds: { has: machineId } }, ...HOST_TABS })
      return rows.flatMap(row => {
        const state = stateOf(row)
        let pool
        try { pool = machineContribution(state, machineId) } catch (error) { if (error instanceof SuperTabError) return []; throw error }
        if (!pool || pool.contributorId !== user.sub) return []
        const starts = (state.starts ?? []).filter(s => s.request.machineId === machineId && s.poolGeneration === pool.generation && (!s.harnessId || !s.poolSettled) && !s.error)
        return [{ tabId: row.id, paused: state.paused, machine: pool, starts,
          ...(pool.scope === 'swarm' ? { projects: projectsOf(state).filter(p => starts.some(s =>
            groupProject(state, conversation(state, s.request.conversationId)).id === p.id))
            .map(p => ({ id: p.id, leadConversationId: p.leadConversationId, repository: p.repository,
              conversationIds: state.conversations.filter(c => !isLeads(c) && groupProject(state, c).id === p.id).map(c => c.id) })) } : {}),
          // The Swarm's grid while the Local models add-on is on: the host reports the models it serves there, and asks grid
          // nothing while it is off.
          ...hostLocalGrid(state),
          reservations: (state.harnessReservations ?? []).filter(r => r.machineId === machineId).map(({ harnessId, generation }) => ({ harnessId, generation })),
          harnessIds: [...new Set([...state.agents.filter(a => a.machineId === machineId).map(a => a.harnessId), ...(state.harnessReservations ?? []).filter(r => r.machineId === machineId).map(r => r.harnessId), ...(state.starts ?? []).filter(s => s.request.machineId === machineId && s.harnessId).map(s => s.harnessId!)])] }]
      })
    })
  }

  /** What removing a machine would do, for its owner's confirmation (machines.ts removalPreview). */
  async machineRemoval(user: AuthUser, tabId: string, machineId: string) {
    return transaction(this.db, async tx => {
      const state = stateOf(await this.row(tx, user, tabId))
      const actor = await this.actor(tx, user, state)
      author(state, actor)
      return removalPreview(state, actor, machineId)
    })
  }

  /** The owner's Swarms with the Local models add-on: what the owner's computer creates on grid and keeps in step. */
  async hostGrids(user: AuthUser) {
    this.personOnly(user)
    const rows = await this.db.superTab.findMany({ where: { autonomousEnv: user.autonomousEnv, ownerId: user.sub }, take: 100 })
    return rows.flatMap(row => swarmGridRow(row.id, stateOf(row)) ?? [])
  }

  async observeMachine(user: AuthUser, tabId: string, machineId: string, input: MachineObservation) {
    const observation = machineObservationSchema.parse(input)
    return transaction(this.db, async tx => {
      await this.hostFor(tx, user, machineId)
      const row = await this.row(tx, user, tabId), state = structuredClone(stateOf(row))
      const pool = machineContribution(state, machineId)
      if (!pool || pool.contributorId !== user.sub || pool.generation !== observation.generation) fail('CONTRIBUTION_REVOKED', 'Read the current machine contribution.', 403)
      const owned = await tx.machine.findFirst({ where: { machineId, userId: user.sub, autonomousEnv: user.autonomousEnv, ...machineAlive } })
      if (!owned || !machineBillingAllowsDataPlane(owned)) fail('HOST_UNAVAILABLE', 'This execution host is unavailable.', 403)
      const now = this.now()
      // A machine that went silent while cleaning takes the fallback before this fresh reading can bring it back: its records
      // go, its cleanup waits for this host, as the next sweep would have done (machines.ts expireRemovals).
      expireRemovals(state, now)
      if (!state.machines?.includes(pool)) {
        await tx.superTab.update({ where: { id: tabId, revision: row.revision }, data: {
          state: json(state), revision: row.revision + 1, ...indexes(state),
        } })
        return { revision: row.revision + 1 }
      }
      recordAgentPresence(state, machineId, observation.runningHarnessIds, now)
      const team = isTeamSession(user)
      // Its privacy check counts only from the Harness Team account's own session; an ordinary sign-in's claim is dropped.
      const { privacy: reported, ...reading } = observation
      const privacy = observedPrivacy(pool.observation?.privacy, reported, team, now)
      pool.observation = { ...reading, quotas: observation.quotas.filter(q => contributedEngines(pool, observation).includes(q.engine)), receivedAt: now,
        // How the machine is signed in, from the session that reported and never from the report (lib/teamSession.ts).
        sessionKind: team ? 'team' : 'computer', ...(privacy ? { privacy } : {}) }
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
      await tx.superTab.update({ where: { id: tabId, revision: row.revision }, data: { state: json(state), revision: row.revision + 1 } })
      return { revision: row.revision + 1 }
    })
  }

  async hostTabs(user: AuthUser, machineId: string) {
    return transaction(this.db, async tx => {
      await this.hostFor(tx, user, machineId)
      const owned = await tx.machine.findFirst({ where: { machineId, userId: user.sub, autonomousEnv: user.autonomousEnv, ...machineAlive } })
      if (!owned || !machineBillingAllowsDataPlane(owned)) fail('HOST_UNAVAILABLE', 'This execution host is unavailable.', 403)
      const rows = await tx.superTab.findMany({ where: { autonomousEnv: user.autonomousEnv, machineIds: { has: machineId } }, ...HOST_TABS })
      // A cleanup is never cut by that limit: a machine in more than 100 Swarms would otherwise keep a removed Swarm's folders.
      const cleaning = await tx.superTab.findMany({ where: { autonomousEnv: user.autonomousEnv, cleanupMachineIds: { has: machineId },
        id: { notIn: rows.map(r => r.id) } } })
      const result = []
      for (const row of rows) {
        const state = stateOf(row)
        const people = await tx.user.findMany({ where: { id: { in: state.people.map(p => p.id) }, autonomousEnv: state.environment }, select: { id: true, email: true } })
        for (const target of state.agents.filter(a => a.machineId === machineId && a.machineOwnerId === user.sub)) {
          try { agent(state, target.id); await this.agentGrant(tx, state, target) }
          catch (error) { if (error instanceof SuperTabError) continue; throw error }
          // `active` lets the host release members that are only in archived groups to automatic cleanup.
          const active = state.conversations.some(c => !c.archived && c.agentIds.includes(target.id))
          // The agent's own work waiting on a person, for this host's Harness Pro (cli/src/superTabs/attention.ts): the
          // assignment it runs here that needs a decision or is stuck, and what it said. Nothing the agent cannot read itself.
          const waiting = state.conversations.find(c => activeWork(c) && c.assignment!.agentId === target.id &&
            c.assignment!.execution.machineId === machineId && ['needs_human', 'blocked'].includes(c.assignment!.status))?.assignment
          const attention = waiting ? { assignmentId: waiting.id, status: waiting.status, result: waiting.result?.slice(0, 500) ?? null } : null
          // The owner's own machine runs the owner's own Lead of this Swarm but is not one of its machines: the host adds it
          // (cli/src/superTabs/host.ts). A collaborator's Lead on a machine shared with them must not open it to every member.
          const joinSwarm = state.ownerId === user.sub && target.contributorId === user.sub && !state.machines?.some(m => m.machineId === machineId)
            && state.conversations.some(c => !c.archived && c.leadId === target.id)
          // Which skill texts this agent runs; the host reads it here rather than fetching each tab's state per poll. A row
          // whose project is gone reads like one from before skill modes instead of failing the host's whole poll.
          const home = projectsOf(state).find(p => p.id === agentProjectId(state, target))
          const skillMode = home ? skillModeOf(home) : 'orchestration'
          // On Custom, the role it runs and its text's version, never the text (roleText); null when its kind has no role there.
          // The project lets the host fetch that text (roleText).
          const custom = home && skillSetOf(home) === 'custom' ? home : null
          const chosen = custom ? agentSetRole(state, custom, target) : null
          const role = custom ? { role: chosen && { ...chosen, projectId: custom.id } } : {}
          result.push({ tabId: row.id, tabName: state.name, revision: row.revision, paused: state.paused, active, attention, agent: target, joinSwarm, skillMode, ...role,
            lead: !!ledProject(state, target.id),
            stopRequested: target.workDecision === 'stop' && !state.conversations.some(c => activeWork(c) && c.assignment?.agentId === target.id),
            observers: people.filter(p => p.id !== user.sub &&
              canReadAgent(state, { kind: 'person', userId: p.id, email: p.email }, target))
              .map(p => ({ email: p.email, userId: p.id })) })
        }
        // Not `active`, so a host from before close requests leaves the session to its automatic cleanup.
        for (const { agentId: id, harnessId } of (state.closingSessions ?? []).filter(c => c.machineId === machineId && c.machineOwnerId === user.sub)) {
          result.push({ tabId: row.id, agent: { id, harnessId, machineId }, closeSession: true as const, active: false })
        }
        result.push(...cleanupRows(row.id, state, machineId, user.sub))
      }
      for (const row of cleaning) result.push(...cleanupRows(row.id, stateOf(row), machineId, user.sub))
      return result
    })
  }

  async mayObserve(user: AuthUser, tabId: string, machineId: string, harnessId: string, machineOwnerId: string): Promise<boolean> {
    // Watching is a person's: a team session has no person to watch as.
    if (isTeamSession(user)) return false
    try {
      return await transaction(this.db, async tx => {
        const state = stateOf(await this.row(tx, user, tabId))
        person(state, user.sub)
        const target = state.agents.find(a => a.machineId === machineId && a.harnessId === harnessId && a.machineOwnerId === machineOwnerId)
        if (!target) return false
        agent(state, target.id)
        if (!canReadAgent(state, { kind: 'person', userId: user.sub, email: user.email }, target)) return false
        await this.agentGrant(tx, state, target)
        return true
      })
    } catch (error) { if (error instanceof SuperTabError) return false; throw error }
  }

  /** Execution identity survives removing a contributor. The host sees only
   * its outstanding native sessions, without regaining conversation access. */
  async hostAssignments(user: AuthUser, machineId: string) {
    return transaction(this.db, async tx => {
      await this.hostFor(tx, user, machineId)
      const owned = await tx.machine.findFirst({ where: { machineId, userId: user.sub, autonomousEnv: user.autonomousEnv, ...machineAlive } })
      if (!owned || !machineBillingAllowsDataPlane(owned)) fail('HOST_UNAVAILABLE', 'This execution host is unavailable.', 403)
      const rows = await tx.superTab.findMany({ where: { autonomousEnv: user.autonomousEnv, machineIds: { has: machineId } }, ...HOST_TABS })
      return rows.flatMap(row => stateOf(row).conversations.filter(activeWork).flatMap(group => {
        const work = group.assignment!
        return work.execution.machineId === machineId && work.execution.machineOwnerId === user.sub
          ? [{ tabId: row.id, assignmentId: work.id, harnessId: work.execution.harnessId }] : []
      }))
    })
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
    if (isLeads(group) ? actor.kind === 'agent' && !ledProject(state, actor.agentId) : !canReadProject(state, actor, groupProject(state, group))) return false
    if (!canReadAgent(state, { kind: 'agent', agentId: target.id, machineOwnerId: target.machineOwnerId }, target) || !isLeads(group) &&
      !canReadProject(state, { kind: 'agent', agentId: target.id, machineOwnerId: target.machineOwnerId }, groupProject(state, group))) return false
    const generation = 'generation' in sender ? sender.generation : sender.membershipGeneration
    return generation === delivery.authorGeneration && (!('role' in sender) || sender.role !== 'viewer')
  }

  private async senderAllowed(tx: Transaction, state: SuperTabState, delivery: SuperTabDelivery): Promise<boolean> {
    if (delivery.nativeContextId && !await this.native.allowsDelivery(tx, state, delivery.nativeContextId)) return false
    if (delivery.authorKind !== 'agent') return true
    try { await this.agentGrant(tx, state, agent(state, delivery.authorId)); return true }
    catch (error) { if (error instanceof SuperTabError) return false; throw error }
  }

  async deliveries(user: AuthUser, tabId: string, agentId: string) {
    return transaction(this.db, async tx => {
      const row = await this.row(tx, user, tabId)
      const state = stateOf(row)
      author(state, await this.actor(tx, user, state, agentId), true)
      const target = agent(state, agentId)
      const update = projectUpdateRequest(state, target, this.now())
      if (update) {
        const project = groupProject(state, conversation(state, update.conversationId))
        // A worker down two hours asks for a wake-up even when no report has come in yet.
        const progress = project.progress ??= { dirtyRevision: 0, summarizedRevision: 0, requestedRevision: 0, since: this.now() }
        const pending = progress.requestMessageId
          ? await tx.superTabDelivery.findFirst({ where: { tabId, agentId, messageId: progress.requestMessageId,
            status: { in: ['queued', 'claimed', 'uncertain', 'delivered'] } } })
          : null
        if (!pending) {
          if (update.source!.throughRevision === progress.dirtyRevision) {
            progress.requestedRevision = progress.dirtyRevision
            progress.requestedAt = this.now()
          }
          progress.requestMessageId = update.id
          for (const { agentId, since } of (update.source!.down ?? []) as Array<{ agentId: string; since: string }>) {
            state.agents.find(a => a.id === agentId)!.downNamed = since
          }
          const revision = row.revision + 1
          await this.writeMessages(tx, tabId, state, [update], revision)
          await tx.superTab.update({ where: { id: tabId, revision: row.revision }, data: { revision, state: json(state) } })
        }
      }
      const rows = await tx.superTabDelivery.findMany({ where: { tabId, agentId, status: { in: ['queued', 'claimed', 'uncertain'] } },
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
      const state = stateOf(await this.row(tx, user, tabId))
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
      const row = await this.row(tx, user, tabId)
      const state = stateOf(row)
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
      if (action.type === 'hold') return this.holdNotice(tx, row, state, delivery, action.reason)
      const status = action.type === 'claim' ? delivery.status === 'queued' ? 'claimed' : delivery.status : action.uncertain ? 'uncertain' : 'delivered'
      if (delivery.status === 'delivered' && action.type === 'ack' && (action.uncertain || delivery.receipt !== action.receipt)) {
        fail('RECEIPT_CONFLICT', 'A delivered instruction keeps its original host receipt.')
      }
      // This write conflicts with concurrent revocation, even when only the delivery record changed.
      await tx.superTab.update({ where: { id: tabId, revision: row.revision }, data: { revision: { increment: 1 } } })
      const updated = await tx.superTabDelivery.update({ where: { id: delivery.id }, data: { status, claimId: action.claimId,
        ...(action.type === 'ack' ? { receipt: action.receipt, holdReason: null, holdSince: null,
          ...(!action.uncertain ? { deliveredAt: delivery.deliveredAt ?? new Date(this.now()) } : {}) } : {}) } })
      const message = await tx.superTabMessage.findUnique({ where: { id: delivery.messageId } })
      return { delivery: updated, message }
    })
  }

  /** The host cannot type a claimed instruction yet. Say so once in the group, as the waiting agent; nobody is asked to act on it. */
  private async holdNotice(tx: Transaction, row: SuperTab, state: SuperTabState, delivery: SuperTabDelivery, reason: HoldReason) {
    const id = stableId('hold-notice', delivery.tabId, delivery.id)
    if (delivery.status !== 'claimed') return { noticed: false }
    // Nobody can see an agent-only notice, so nobody is told it waits; the host keeps holding it.
    if (agentOnly((await tx.superTabMessage.findUnique({ where: { id: delivery.messageId }, select: { source: true } }))?.source)) return { noticed: false }
    const notice = await tx.superTabMessage.findUnique({ where: { id } })
    if (notice && delivery.holdReason === reason && delivery.holdSince) return { noticed: false }
    // The notice is only sent once for older Desktops; the inline receipt keeps the current reason.
    await tx.superTabDelivery.update({ where: { id: delivery.id }, data: {
      holdReason: reason, holdSince: delivery.holdSince ?? new Date(this.now()),
    } })
    const group = conversation(state, delivery.conversationId), waiting = agent(state, delivery.agentId)
    const sender = author(state, { kind: 'agent', agentId: waiting.id, machineOwnerId: waiting.machineOwnerId })
    const revision = row.revision + 1
    if (!notice) group.lastMessageSequence = revision
    // The Lead gets it too, like a host-stop notice; a waiting Lead has no one above it to tell.
    const lead = group.leadId && group.leadId !== waiting.id && group.agentIds.includes(group.leadId) ? group.leadId : null
    const host = !notice && reason === 'team_waiting_user' ? await this.holdHost(tx, state, waiting) : undefined
    await tx.superTab.update({ where: { id: row.id, revision: row.revision }, data: { revision, state: json(state) } })
    if (!notice) await this.writeMessages(tx, row.id, state, [{ id, conversationId: group.id, replyTo: null, recipients: lead ? [lead] : [],
      source: { kind: 'delivery-hold', messageId: delivery.messageId, deliveryId: delivery.id, agentId: delivery.agentId },
      text: holdNoticeText(sender.displayName ?? sender.name, reason, host), author: sender }], revision)
    return { noticed: !notice }
  }

  /** The machine's name and its owner's name for a hold notice; left out when unknown rather than guessed. */
  private async holdHost(tx: Transaction, state: SuperTabState, waiting: Agent) {
    const contributed = state.machines?.find(m => m.machineId === waiting.machineId)?.name
    const machine = contributed ?? (await tx.machine.findFirst({ where: { machineId: waiting.machineId, userId: waiting.machineOwnerId },
      select: { name: true, hostname: true } }).then(m => m?.name ?? m?.hostname ?? null))
    const owner = await tx.user.findUnique({ where: { id: waiting.machineOwnerId }, select: { name: true } })
    return { machine: machine?.trim() || null, owner: owner?.name?.trim() || null }
  }

  /** Only the recorded execution host may attest that the actual session/attempt has stopped. */
  async stopped(user: AuthUser, tabId: string, assignmentId: string, receipt: string) {
    let ended: WorkHold[] = []
    const done = await transaction(this.db, async tx => {
      ended = []
      const row = await this.row(tx, user, tabId)
      const state = stateOf(row)
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
      const revision = row.revision + 1
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
          group.lastMessageSequence = revision
        }
      }
      await tx.superTab.update({ where: { id: tabId, revision: row.revision }, data: {
        revision, state: json(state), ...indexes(state),
      } })
      await this.writeMessages(tx, tabId, state, notices, revision)
      if (!prior) await tx.superTabStopReceipt.create({ data: { id, tabId, assignmentId, ...execution, receipt } })
      ended = endedHolds(before, state)
      return { confirmed: true }
    })
    this.endWork(tabId, ended)
    return done
  }
}
