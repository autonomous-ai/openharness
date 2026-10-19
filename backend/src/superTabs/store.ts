import { createHash } from 'node:crypto'
import type { Prisma, PrismaClient, SuperTab, SuperTabDelivery } from '@prisma/client'
import type { AuthUser } from '../lib/ssoAuth.js'
import { machineAlive } from '../lib/prisma.js'
import { machineShareGrant, sharedVia } from '../lib/machineSharePolicy.js'
import { machineBillingAllowsDataPlane } from '../lib/billingState.js'
import { applyCommand, operationSchema, type Command, type CommandContext } from './commands.js'
import { revokeNativeContexts, SuperTabNativeStore } from './native.js'
import {
  activeWork, actorKey, agent, author, conversation, createSuperTab, fail, person, stableId, visibleState,
  SuperTabError, type Actor, type Agent, type Author, type MessageDraft, type SuperTabState,
} from './model.js'
import { closeAssignment, readDecision, recentRoutes, timedDecisionOf, writeRouteEffects } from './routeDecisions.js'
import { DEFAULT_ROUTING_POLICY, effectivePolicy, routingPolicySchema, type RoutingPolicy } from './routingPolicy.js'

type Transaction = Prisma.TransactionClient
const json = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const stateOf = (row: SuperTab): SuperTabState => {
  const state = row.state as unknown as SuperTabState
  if (state.version !== 1) fail('UPDATE_REQUIRED', 'Update Harness to open this Super Tab.', 409)
  return state
}
const indexes = (state: SuperTabState) => ({
  memberIds: state.people.map(p => p.id), invitedEmails: state.invitations.map(i => i.email),
  machineIds: [...new Set([...state.agents.map(a => a.machineId),
    ...state.conversations.filter(activeWork).map(c => c.assignment!.execution.machineId)])],
})

/** Retrying a transaction never repeats a host action. All effects here are durable database writes. */
async function transaction<T>(db: PrismaClient, body: (tx: Transaction) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await db.$transaction(body) } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : null
      if (attempt >= 4 || (code !== 'P2034' && code !== 'P2002')) throw error
    }
  }
}

/** Persistent coordination. Host adapters own execution and must confirm their local session grants. */
export class SuperTabStore {
  readonly native: SuperTabNativeStore
  constructor(private readonly db: PrismaClient, private readonly now: () => number = Date.now) {
    this.native = new SuperTabNativeStore({
      transaction: body => transaction(db, body),
      row: async (tx, user, tabId) => { const row = await this.row(tx, user, tabId); return { row, state: stateOf(row) } },
      agentGrant: (tx, state, target) => this.agentGrant(tx, state, target),
      contribution: (tx, state, actor, command) => this.contribution(tx, state, actor, command),
    })
  }

  private policyId(user: AuthUser) { return stableId('routing-policy', user.sub, user.autonomousEnv) }

  async accountPolicy(user: AuthUser) {
    const row = await this.db.routingPolicy.findUnique({ where: { id: this.policyId(user) } })
    if (!row) return { policy: DEFAULT_ROUTING_POLICY, revision: 0, isDefault: true }
    const { policy } = effectivePolicy(row.policy, null)
    return { policy, revision: row.revision, isDefault: false }
  }

  async saveAccountPolicy(user: AuthUser, revision: number, input: RoutingPolicy) {
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
    if (!agentId) return { kind: 'person', userId: user.sub, email: user.email }
    const target = agent(state, agentId)
    if (target.machineOwnerId !== user.sub) fail('FORBIDDEN', 'Only the execution host can speak as this agent.', 403)
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

  private async contribution(tx: Transaction, state: SuperTabState, actor: Actor, command: { machineId: string }) {
    const contributorId = actor.kind === 'person' ? actor.userId : agent(state, actor.agentId).contributorId
    person(state, contributorId)
    const machine = await tx.machine.findFirst({ where: { machineId: command.machineId, autonomousEnv: state.environment, ...machineAlive } })
    if (!machine || !machineBillingAllowsDataPlane(machine)) fail('HOST_UNAVAILABLE', 'This machine is unavailable.', 403)
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

  async create(user: AuthUser, operationId: string, name: string) {
    const id = stableId('super-tab', user.autonomousEnv, user.sub, operationId)
    const requestHash = hash({ name })
    return transaction(this.db, async tx => {
      const prior = await tx.superTabOperation.findUnique({ where: { id } })
      if (prior) {
        if (prior.requestHash !== requestHash) fail('OPERATION_REUSED', 'Use a new operation ID for a different request.')
        return { id, revision: prior.revision }
      }
      const state = createSuperTab(id, name, { id: user.sub, email: user.email }, user.autonomousEnv)
      await tx.superTab.create({ data: { id, ownerId: user.sub, autonomousEnv: user.autonomousEnv, ...indexes(state), state: json(state) } })
      await tx.superTabOperation.create({ data: { id, tabId: id, actorKey: `person:${user.sub}`, requestHash, revision: 0, result: { id } } })
      return { id, revision: 0 }
    })
  }

  async list(user: AuthUser, after?: string) {
    const rows = await this.db.superTab.findMany({ where: { autonomousEnv: user.autonomousEnv, memberIds: { has: user.sub },
      ...(after ? { id: { gt: after } } : {}) }, orderBy: { id: 'asc' }, take: 101 })
    return { tabs: rows.slice(0, 100).map(row => {
      const state = stateOf(row)
      return { id: row.id, name: state.name, ownerId: row.ownerId, revision: row.revision, paused: state.paused }
    }), next: rows.length > 100 ? rows[99]!.id : null }
  }

  async invitations(user: AuthUser) {
    const email = user.email.trim().toLowerCase()
    const rows = await this.db.superTab.findMany({ where: { autonomousEnv: user.autonomousEnv, invitedEmails: { has: email } }, take: 100 })
    return rows.flatMap(row => {
      const state = stateOf(row)
      return state.invitations.filter(i => i.email === email && i.expiresAt > this.now())
        .map(i => ({ tabId: row.id, name: state.name, inviteId: i.id, role: i.role, expiresAt: i.expiresAt }))
    })
  }

  async read(user: AuthUser, tabId: string, asAgentId?: string) {
    return transaction(this.db, async tx => {
      const row = await this.row(tx, user, tabId)
      const state = stateOf(row)
      const actor = await this.actor(tx, user, state, asAgentId)
      return { revision: row.revision, state: visibleState(state, actor) }
    })
  }

  async start(user: AuthUser, tabId: string, startId: string, asAgentId?: string) {
    return transaction(this.db, async tx => {
      const state = stateOf(await this.row(tx, user, tabId))
      const actor = await this.actor(tx, user, state, asAgentId)
      author(state, actor, true)
      const start = state.starts?.find(s => s.id === startId) ?? fail('NOT_FOUND', 'This agent start is unavailable.', 404)
      if (start.actorKey !== actorKey(actor) || person(state, start.contributorId).generation !== start.membershipGeneration) {
        fail('FORBIDDEN', 'Only the original initiating lead can resume this start.', 403)
      }
      const group = conversation(state, start.request.conversationId)
      if (actor.kind === 'agent' && group.leadId !== actor.agentId) fail('LEAD_REQUIRED', 'The coordinating lead changed.', 403)
      if (group.archived) fail('ARCHIVED', 'This conversation is archived.')
      if (state.paused && !start.harnessId) fail('PAUSED', 'New work is paused in this Super Tab.')
      const grant = await this.contribution(tx, state, actor, start.request)
      if (grant.machineOwnerId !== start.machineOwnerId || (grant.hostGrant ?? null) !== start.hostGrant) {
        fail('CONTRIBUTION_REVOKED', 'This start belongs to a machine grant that was revoked.', 403)
      }
      return start
    })
  }

  async execute(user: AuthUser, tabId: string, input: { operationId: string; command: Command }, asAgentId?: string) {
    const { operationId, command } = operationSchema.parse(input)
    return transaction(this.db, async tx => {
      const row = await this.row(tx, user, tabId)
      const original = stateOf(row)
      const actor = await this.actor(tx, user, original, asAgentId)
      const receiptId = stableId(tabId, actorKey(actor), operationId)
      const requestHash = hash(command)
      const prior = await tx.superTabOperation.findUnique({ where: { id: receiptId } })
      if (prior) {
        if (prior.requestHash !== requestHash) fail('OPERATION_REUSED', 'Use a new operation ID for a different request.')
        // A leave may be retried by its original author. Nothing except that operation's receipt is returned.
        const selfLeave = actor.kind === 'person' && command.type === 'member.remove' && command.userId === actor.userId
        if (!selfLeave) author(original, actor)
        return { revision: prior.revision, result: prior.result }
      }
      if (command.type !== 'invite.accept') author(original, actor)
      const context: CommandContext = { operationId, now: this.now() }
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
        context.delivery = { ...delivery, text: message.text }
        await tx.superTabDelivery.update({ where: { id: delivery.id }, data: {
          status: command.resolution === 'received' ? 'confirmed' : command.resolution === 'resend' ? 'superseded' : 'cancelled',
          // The native receipt remains intact; the operation records the person's resolution.
        } })
      }
      if (command.type === 'agent.add') context.contribution = await this.contribution(tx, original, actor, command)
      if (command.type === 'agent.start') context.contribution = await this.contribution(tx, original, actor, command.request)
      if (command.type === 'agent.started' || command.type === 'agent.startDispatch') {
        const start = original.starts?.find(s => s.id === command.startId) ?? fail('NOT_FOUND', 'This agent start is unavailable.', 404)
        context.contribution = await this.contribution(tx, original, actor, start.request)
      }
      if (command.type === 'message.send' && command.replyTo) {
        const reply = await tx.superTabMessage.findFirst({ where: { id: command.replyTo, tabId, conversationId: command.conversationId } })
        if (reply) context.reply = { id: reply.id, conversationId: reply.conversationId, author: reply.author as unknown as Author }
      }
      if (command.type === 'work.status' && command.status === 'stopped') {
        const proof = await tx.superTabStopReceipt.findUnique({ where: { tabId_assignmentId: { tabId, assignmentId: command.assignmentId } } })
        const execution = conversation(original, command.conversationId).assignment?.execution
        context.confirmedStopped = !!proof && !!execution && proof.machineId === execution.machineId &&
          proof.harnessId === execution.harnessId && proof.machineOwnerId === execution.machineOwnerId
      }
      if (command.type === 'route.record') context.recentRoutes = await recentRoutes(tx, tabId, context.now)
      const decisionId = command.type === 'route.override' || command.type === 'route.modelResult' ? command.decisionId
        : command.type === 'work.assign' || command.type === 'agent.start' ? command.routeDecisionId : undefined
      if (decisionId) context.routeDecision = await readDecision(tx, tabId, decisionId) ?? fail('NOT_FOUND', 'This routing decision is unavailable.', 404)
      const effects = applyCommand(original, actor, command, context)
      await revokeNativeContexts(tx, original, effects.state)
      const revision = row.revision + 1
      if (command.type === 'agent.add' || command.type === 'agent.started' || command.type === 'agent.configuration') {
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
      for (const message of effects.messages) conversation(effects.state, message.conversationId).lastMessageSequence = revision
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
          status: { in: ['queued', 'claimed', 'uncertain'] } }, data: { status: 'cancelled' } })
      }
      await tx.superTab.update({ where: { id: tabId, revision: row.revision }, data: {
        revision, state: json(effects.state), ...indexes(effects.state),
      } })
      await writeRouteEffects(tx, tabId, effects.routeDecisions, context.now)
      if (command.type === 'work.status' && (command.status === 'done' || command.status === 'stopped')) {
        await closeAssignment(tx, tabId, command.assignmentId, command.status, context.now)
      }
      await this.writeMessages(tx, tabId, effects.state, effects.messages, revision)
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
        status: { in: ['queued', 'claimed', 'uncertain'] }, OR: cancelled }, data: { status: 'cancelled' } })
      for (const attempt of effects.previousAttempts) {
        await tx.superTabAttempt.create({ data: { id: attempt.assignment.id, tabId, conversationId: attempt.conversationId, snapshot: json(attempt) } })
      }
      await tx.superTabOperation.create({ data: { id: receiptId, tabId, actorKey: actorKey(actor), requestHash,
        revision, result: json(effects.result) } })
      return { revision, result: effects.result }
    })
  }

  /** Records committed messages and one delivery per recipient, at the tab revision that carried them. */
  private async writeMessages(tx: Transaction, tabId: string, state: SuperTabState, messages: MessageDraft[], revision: number) {
    for (const message of messages) {
      await tx.superTabMessage.create({ data: { id: message.id, tabId, conversationId: message.conversationId,
        sequence: revision, author: json(message.author), ...(message.source ? { source: json(message.source) } : {}),
        text: message.text, replyTo: message.replyTo, recipientIds: message.recipients } })
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
      author(state, await this.actor(tx, user, state, asAgentId))
      conversation(state, conversationId)
      const forward = cursor.after !== undefined
      const rows = await tx.superTabMessage.findMany({ where: { tabId, conversationId,
        ...(cursor.messageId ? { id: cursor.messageId } : {}),
        ...(forward ? { sequence: { gt: cursor.after } } : cursor.before !== undefined ? { sequence: { lt: cursor.before } } : {}) },
        orderBy: { sequence: forward ? 'asc' : 'desc' }, take: 101 })
      const page = rows.slice(0, 100)
      const next = rows.length > 100 ? page.at(-1)!.sequence : null
      if (!forward) page.reverse()
      const deliveries = page.length ? await tx.superTabDelivery.findMany({ where: { tabId, messageId: { in: page.map(m => m.id) } },
        select: { id: true, messageId: true, agentId: true, status: true, receipt: true } }) : []
      return { messages: page.map(m => ({ ...m, deliveries: deliveries.filter(d => d.messageId === m.id) })), next, revision: row.revision }
    })
  }

  async routeDecisions(user: AuthUser, tabId: string, asAgentId?: string) {
    return transaction(this.db, async tx => {
      const state = stateOf(await this.row(tx, user, tabId))
      author(state, await this.actor(tx, user, state, asAgentId))
      const rows = await tx.superTabRouteDecision.findMany({ where: { tabId }, orderBy: { createdAt: 'desc' }, take: 100 })
      return rows.map(timedDecisionOf)
    })
  }

  async routeDecision(user: AuthUser, tabId: string, decisionId: string, asAgentId?: string) {
    return transaction(this.db, async tx => {
      const state = stateOf(await this.row(tx, user, tabId))
      author(state, await this.actor(tx, user, state, asAgentId))
      const row = await tx.superTabRouteDecision.findFirst({ where: { id: decisionId, tabId } })
      return row ? timedDecisionOf(row) : fail('NOT_FOUND', 'This routing decision is unavailable.', 404)
    })
  }

  /** Host polling discovers only registered sessions on its own machine, never unrelated tab transcripts. */
  async hostTabs(user: AuthUser, machineId: string) {
    return transaction(this.db, async tx => {
      const owned = await tx.machine.findFirst({ where: { machineId, userId: user.sub, autonomousEnv: user.autonomousEnv, ...machineAlive } })
      if (!owned || !machineBillingAllowsDataPlane(owned)) fail('HOST_UNAVAILABLE', 'This execution host is unavailable.', 403)
      const rows = await tx.superTab.findMany({ where: { autonomousEnv: user.autonomousEnv, machineIds: { has: machineId } }, take: 100 })
      const result = []
      for (const row of rows) {
        const state = stateOf(row)
        const people = await tx.user.findMany({ where: { id: { in: state.people.map(p => p.id) }, autonomousEnv: state.environment }, select: { id: true, email: true } })
        for (const target of state.agents.filter(a => a.machineId === machineId && a.machineOwnerId === user.sub)) {
          try { agent(state, target.id); await this.agentGrant(tx, state, target) }
          catch (error) { if (error instanceof SuperTabError) continue; throw error }
          // `active` lets the host release members that are only in archived groups to automatic cleanup.
          const active = state.conversations.some(c => !c.archived && c.agentIds.includes(target.id))
          result.push({ tabId: row.id, revision: row.revision, paused: state.paused, active, agent: target,
            observers: people.filter(p => p.id !== user.sub).map(p => ({ email: p.email, userId: p.id })) })
        }
      }
      return result
    })
  }

  async mayObserve(user: AuthUser, tabId: string, machineId: string, harnessId: string, machineOwnerId: string): Promise<boolean> {
    try {
      return await transaction(this.db, async tx => {
        const state = stateOf(await this.row(tx, user, tabId))
        person(state, user.sub)
        const target = state.agents.find(a => a.machineId === machineId && a.harnessId === harnessId && a.machineOwnerId === machineOwnerId)
        if (!target) return false
        agent(state, target.id)
        await this.agentGrant(tx, state, target)
        return true
      })
    } catch (error) { if (error instanceof SuperTabError) return false; throw error }
  }

  /** Execution identity survives removing a contributor. The host sees only
   * its outstanding native sessions, without regaining conversation access. */
  async hostAssignments(user: AuthUser, machineId: string) {
    return transaction(this.db, async tx => {
      const owned = await tx.machine.findFirst({ where: { machineId, userId: user.sub, autonomousEnv: user.autonomousEnv, ...machineAlive } })
      if (!owned || !machineBillingAllowsDataPlane(owned)) fail('HOST_UNAVAILABLE', 'This execution host is unavailable.', 403)
      const rows = await tx.superTab.findMany({ where: { autonomousEnv: user.autonomousEnv, machineIds: { has: machineId } }, take: 100 })
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
      const machine = await tx.machine.findFirst({ where: { machineId: row.machineId, userId: owner,
        autonomousEnv: user.autonomousEnv, ...machineAlive } })
      if (!machine || !machineBillingAllowsDataPlane(machine)) fail('HOST_UNAVAILABLE', 'This execution host is unavailable.', 403)
      return { id: row.id, status: row.status }
    })
  }

  /** No timeout reclaims an instruction: the same durable claim resumes, or the host reconciles it. */
  async delivery(user: AuthUser, tabId: string, agentId: string, deliveryId: string,
    action: { type: 'claim'; claimId: string } | { type: 'ack'; claimId: string; receipt: string; uncertain: boolean }) {
    return transaction(this.db, async tx => {
      const row = await this.row(tx, user, tabId)
      const state = stateOf(row)
      author(state, await this.actor(tx, user, state, agentId), true)
      const delivery = await tx.superTabDelivery.findFirst({ where: { id: deliveryId, tabId, agentId } })
      if (!delivery || !this.deliveryAllowed(state, delivery) || delivery.status === 'cancelled' ||
          !await this.senderAllowed(tx, state, delivery)) fail('DELIVERY_REVOKED', 'This instruction is no longer authorized.', 403)
      if (delivery.status === 'confirmed' || delivery.status === 'superseded') {
        fail('DELIVERY_RESOLVED', 'A person has already resolved this delivery.')
      }
      if (delivery.claimId && delivery.claimId !== action.claimId) fail('CLAIM_CONFLICT', 'Reconcile the existing delivery before claiming it again.')
      if (action.type === 'ack' && !delivery.claimId) fail('NOT_CLAIMED', 'Claim this instruction before acknowledging it.')
      const status = action.type === 'claim' ? delivery.status === 'queued' ? 'claimed' : delivery.status : action.uncertain ? 'uncertain' : 'delivered'
      if (delivery.status === 'delivered' && action.type === 'ack' && (action.uncertain || delivery.receipt !== action.receipt)) {
        fail('RECEIPT_CONFLICT', 'A delivered instruction keeps its original host receipt.')
      }
      // This write conflicts with concurrent revocation, even when only the delivery record changed.
      await tx.superTab.update({ where: { id: tabId, revision: row.revision }, data: { revision: { increment: 1 } } })
      const updated = await tx.superTabDelivery.update({ where: { id: delivery.id }, data: { status, claimId: action.claimId,
        ...(action.type === 'ack' ? { receipt: action.receipt } : {}) } })
      const message = await tx.superTabMessage.findUnique({ where: { id: delivery.messageId } })
      return { delivery: updated, message }
    })
  }

  /** Only the recorded execution host may attest that the actual session/attempt has stopped. */
  async stopped(user: AuthUser, tabId: string, assignmentId: string, receipt: string) {
    return transaction(this.db, async tx => {
      const row = await this.row(tx, user, tabId)
      const state = stateOf(row)
      const group = state.conversations.find(c => c.assignment?.id === assignmentId)
      const assignment = group?.assignment
      if (!assignment || assignment.execution.machineOwnerId !== user.sub) fail('FORBIDDEN', 'Only the execution host can confirm this stop.', 403)
      const execution = assignment.execution
      const machine = await tx.machine.findFirst({ where: { machineId: execution.machineId, userId: user.sub, autonomousEnv: user.autonomousEnv, ...machineAlive } })
      if (!machine) fail('HOST_UNAVAILABLE', 'This execution host is unavailable.', 403)
      const id = stableId('stop', tabId, assignmentId)
      const prior = await tx.superTabStopReceipt.findUnique({ where: { id } })
      if (prior && prior.receipt !== receipt) fail('RECEIPT_CONFLICT', 'This stop already has a host receipt.')
      const revision = row.revision + 1
      const notices: MessageDraft[] = []
      if (group && activeWork(group)) {
        assignment.status = 'stopped'
        assignment.result = 'The execution host confirmed that this harness stopped.'
        await tx.superTabRun.deleteMany({ where: { tabId, assignmentId } })
        await tx.superTabDelivery.updateMany({ where: { tabId, assignmentId,
          status: { in: ['queued', 'claimed', 'uncertain'] } }, data: { status: 'cancelled' } })
        await closeAssignment(tx, tabId, assignmentId, 'stopped', this.now())
        // No agent command closes this attempt, so nobody was told: in the two-account E2E of 2026-10-19
        // the Lead learned of a stopped worker only by re-reading status. Say it in the group, as the
        // worker's own Stopped update would, and deliver it to the Lead. A removed worker was removed
        // on purpose by someone who already knows.
        const worker = state.agents.find(a => a.id === assignment.agentId)
        if (worker) {
          const lead = group.leadId && group.leadId !== worker.id && group.agentIds.includes(group.leadId) ? group.leadId : null
          notices.push({ id: stableId('stop-notice', tabId, assignmentId), conversationId: group.id,
            author: { kind: 'agent', id: worker.id, name: worker.name, membershipGeneration: worker.membershipGeneration },
            text: `Stopped\n\n${assignment.result} If this work should continue, assign a new attempt.`, replyTo: null, recipients: lead ? [lead] : [] })
          group.lastMessageSequence = revision
        }
      }
      await tx.superTab.update({ where: { id: tabId, revision: row.revision }, data: {
        revision, state: json(state), ...indexes(state),
      } })
      await this.writeMessages(tx, tabId, state, notices, revision)
      if (!prior) await tx.superTabStopReceipt.create({ data: { id, tabId, assignmentId, ...execution, receipt } })
      return { confirmed: true }
    })
  }
}
