import { createHash } from 'node:crypto'
import type { Prisma, PrismaClient, SuperTab, SuperTabDelivery } from '@prisma/client'
import type { AuthUser } from '../lib/ssoAuth.js'
import { machineAlive } from '../lib/prisma.js'
import { sharedVia } from '../lib/machineSharePolicy.js'
import { machineBillingAllowsDataPlane } from '../lib/billingState.js'
import { applyCommand, operationSchema, type Command, type CommandContext } from './commands.js'
import {
  activeWork, actorKey, agent, author, conversation, createSuperTab, fail, person, stableId, visibleState,
  type Actor, type Author, type SuperTabState,
} from './model.js'

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
  machineIds: [...new Set(state.agents.map(a => a.machineId))],
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
  constructor(private readonly db: PrismaClient, private readonly now: () => number = Date.now) {}

  private async row(tx: Transaction, user: AuthUser, tabId: string) {
    return await tx.superTab.findFirst({ where: { id: tabId, autonomousEnv: user.autonomousEnv } }) ??
      fail('NOT_FOUND', 'This Super Tab is unavailable.', 404)
  }

  private async actor(tx: Transaction, user: AuthUser, state: SuperTabState, agentId?: string): Promise<Actor> {
    if (!agentId) return { kind: 'person', userId: user.sub, email: user.email }
    const target = agent(state, agentId)
    if (target.machineOwnerId !== user.sub) fail('FORBIDDEN', 'Only the execution host can speak as this agent.', 403)
    const machine = await tx.machine.findFirst({ where: { machineId: target.machineId, userId: user.sub,
      autonomousEnv: user.autonomousEnv, ...machineAlive } })
    if (!machine || !machineBillingAllowsDataPlane(machine)) fail('HOST_UNAVAILABLE', 'This execution host is unavailable.', 403)
    if (target.contributorId !== machine.userId) {
      person(state, target.contributorId)
      const contributor = await tx.user.findUnique({ where: { id: target.contributorId }, select: { email: true, autonomousEnv: true } })
      const share = await tx.machineShare.findUnique({ where: { machineId: machine.machineId } })
      if (!contributor || contributor.autonomousEnv !== state.environment || !share || share.ownerId !== machine.userId ||
          share.autonomousEnv !== state.environment || !sharedVia(share, contributor.email)) {
        fail('CONTRIBUTION_REVOKED', 'The contributor no longer has access to this machine.', 403)
      }
    }
    return { kind: 'agent', agentId, machineOwnerId: user.sub }
  }

  private async contribution(tx: Transaction, state: SuperTabState, actor: Actor, command: Extract<Command, { type: 'agent.add' }>) {
    const contributorId = actor.kind === 'person' ? actor.userId : agent(state, actor.agentId).contributorId
    person(state, contributorId)
    const machine = await tx.machine.findFirst({ where: { machineId: command.machineId, autonomousEnv: state.environment, ...machineAlive } })
    if (!machine || !machineBillingAllowsDataPlane(machine)) fail('HOST_UNAVAILABLE', 'This machine is unavailable.', 403)
    if (machine.userId !== contributorId) {
      const contributor = actor.kind === 'person' ? { email: actor.email, autonomousEnv: state.environment } :
        await tx.user.findUnique({ where: { id: contributorId }, select: { email: true, autonomousEnv: true } })
      const share = await tx.machineShare.findUnique({ where: { machineId: command.machineId } })
      if (!contributor || contributor.autonomousEnv !== state.environment || !share || share.ownerId !== machine.userId ||
          share.autonomousEnv !== state.environment || !sharedVia(share, contributor.email)) {
        fail('HOST_REQUIRED', 'This machine has not been shared with the contributor.', 403)
      }
    }
    return { machineOwnerId: machine.userId, contributorId }
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
      if (command.type === 'agent.add') context.contribution = await this.contribution(tx, original, actor, command)
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
      const effects = applyCommand(original, actor, command, context)
      const revision = row.revision + 1
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
      for (const message of effects.messages) {
        await tx.superTabMessage.create({ data: { id: message.id, tabId, conversationId: message.conversationId,
          sequence: revision, author: json(message.author), text: message.text, replyTo: message.replyTo, recipientIds: message.recipients } })
        for (const recipient of message.recipients) {
          const target = agent(effects.state, recipient)
          const group = conversation(effects.state, message.conversationId)
          await tx.superTabDelivery.create({ data: { id: stableId(message.id, recipient), tabId,
            conversationId: message.conversationId, messageId: message.id, agentId: recipient, machineId: target.machineId,
            assignmentId: activeWork(group) && group.assignment?.agentId === recipient ? group.assignment.id : null,
            membershipGeneration: target.membershipGeneration, authorKind: message.author.kind,
            authorId: message.author.id, authorGeneration: message.author.membershipGeneration } })
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
        status: { in: ['queued', 'claimed', 'uncertain'] }, OR: cancelled }, data: { status: 'cancelled' } })
      for (const attempt of effects.previousAttempts) {
        await tx.superTabAttempt.create({ data: { id: attempt.assignment.id, tabId, conversationId: attempt.conversationId, snapshot: json(attempt) } })
      }
      await tx.superTabOperation.create({ data: { id: receiptId, tabId, actorKey: actorKey(actor), requestHash,
        revision, result: json(effects.result) } })
      return { revision, result: effects.result }
    })
  }

  async messages(user: AuthUser, tabId: string, conversationId: string, cursor: { after?: number; before?: number }, asAgentId?: string) {
    return transaction(this.db, async tx => {
      const row = await this.row(tx, user, tabId)
      const state = stateOf(row)
      author(state, await this.actor(tx, user, state, asAgentId))
      conversation(state, conversationId)
      const forward = cursor.after !== undefined
      const rows = await tx.superTabMessage.findMany({ where: { tabId, conversationId,
        ...(forward ? { sequence: { gt: cursor.after } } : cursor.before !== undefined ? { sequence: { lt: cursor.before } } : {}) },
        orderBy: { sequence: forward ? 'asc' : 'desc' }, take: 101 })
      const page = rows.slice(0, 100)
      const next = rows.length > 100 ? page.at(-1)!.sequence : null
      if (!forward) page.reverse()
      const deliveries = page.length ? await tx.superTabDelivery.findMany({ where: { tabId, messageId: { in: page.map(m => m.id) } },
        select: { messageId: true, agentId: true, status: true } }) : []
      return { messages: page.map(m => ({ ...m, deliveries: deliveries.filter(d => d.messageId === m.id) })), next, revision: row.revision }
    })
  }

  /** Host polling discovers only registered sessions on its own machine, never unrelated tab transcripts. */
  async hostTabs(user: AuthUser, machineId: string) {
    const owned = await this.db.machine.findFirst({ where: { machineId, userId: user.sub, autonomousEnv: user.autonomousEnv, ...machineAlive } })
    if (!owned || !machineBillingAllowsDataPlane(owned)) fail('HOST_UNAVAILABLE', 'This execution host is unavailable.', 403)
    const rows = await this.db.superTab.findMany({ where: { autonomousEnv: user.autonomousEnv, machineIds: { has: machineId } }, take: 100 })
    return rows.flatMap(row => stateOf(row).agents.filter(a => a.machineId === machineId && a.machineOwnerId === user.sub)
      .map(a => ({ tabId: row.id, revision: row.revision, paused: stateOf(row).paused, agent: a })))
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

  async deliveries(user: AuthUser, tabId: string, agentId: string) {
    return transaction(this.db, async tx => {
      const row = await this.row(tx, user, tabId)
      const state = stateOf(row)
      author(state, await this.actor(tx, user, state, agentId), true)
      const rows = await tx.superTabDelivery.findMany({ where: { tabId, agentId, status: { in: ['queued', 'claimed', 'uncertain'] } },
        orderBy: { createdAt: 'asc' }, take: 100 })
      return rows.filter(d => this.deliveryAllowed(state, d))
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
      if (!delivery || !this.deliveryAllowed(state, delivery) || delivery.status === 'cancelled') fail('DELIVERY_REVOKED', 'This instruction is no longer authorized.', 403)
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
      const assignment = state.conversations.find(c => c.assignment?.id === assignmentId)?.assignment
      if (!assignment || assignment.execution.machineOwnerId !== user.sub) fail('FORBIDDEN', 'Only the execution host can confirm this stop.', 403)
      const execution = assignment.execution
      const machine = await tx.machine.findFirst({ where: { machineId: execution.machineId, userId: user.sub, autonomousEnv: user.autonomousEnv, ...machineAlive } })
      if (!machine) fail('HOST_UNAVAILABLE', 'This execution host is unavailable.', 403)
      const id = stableId('stop', tabId, assignmentId)
      const prior = await tx.superTabStopReceipt.findUnique({ where: { id } })
      if (prior && prior.receipt !== receipt) fail('RECEIPT_CONFLICT', 'This stop already has a host receipt.')
      await tx.superTab.update({ where: { id: tabId, revision: row.revision }, data: { revision: { increment: 1 } } })
      if (!prior) await tx.superTabStopReceipt.create({ data: { id, tabId, assignmentId, ...execution, receipt } })
      return { confirmed: true }
    })
  }
}
