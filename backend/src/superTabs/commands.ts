import { z } from 'zod'
import {
  activeWork, actorKey, agent, author, conversation, fail, person, stableId,
  type Actor, type Agent, type Author, type CommandEffects, type SuperTabState,
} from './model.js'
import { routeRecordSchema, routeTitle, startedAs, type RouteCandidate, type RouteDecision, type RouteFinal, type RouteOverride } from './routeRecord.js'
import { routingOverrideSchema } from './routingPolicy.js'

const id = z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/)
const title = z.string().trim().min(1).max(160)
const reason = z.string().trim().min(1).max(300)
const text = z.string().trim().min(1).max(32_000)
const configuration = z.object({
  engine: z.string().min(1).max(80), model: z.string().max(200).nullable(),
  effort: z.string().max(80).nullable(), contextWindow: z.number().int().positive().safe().nullable(),
  engineVersion: z.string().max(160).nullable(),
}).strict()
const path = z.string().min(1).max(4096).regex(/^\//).refine(value => !/[\x00-\x1f\x7f]/.test(value))
export const startRequestSchema = z.object({
  conversationId: id, machineId: id, engine: z.string().min(1).max(80), name: title, cwd: path,
  worktree: z.boolean(), branchRef: z.string().max(1024).regex(/^refs\/(heads|remotes)\/[^\s\x00-\x1f\x7f]+$/).optional(),
  model: z.string().trim().min(1).max(200).optional(), effort: z.string().trim().min(1).max(80).optional(),
  permissionMode: z.string().min(1).max(80).optional(), codexHome: path.optional(),
  gridModel: z.string().min(1).max(2048).optional(), gridName: z.string().min(1).max(2048).optional(),
  requirements: z.object({ memoryBytes: z.number().int().nonnegative().safe(), diskBytes: z.number().int().nonnegative().safe(),
    maxCpuPercent: z.number().min(0).max(100), tools: z.array(z.string().regex(/^[A-Za-z0-9_.+-]{1,80}$/)).max(20),
    devices: z.array(path).max(20), quotaRequired: z.boolean() }).strict(),
}).strict()
const check = z.object({ description: z.string().trim().min(1).max(1000), independent: z.boolean() }).strict()

export const commandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('tab.rename'), name: title }).strict(),
  z.object({ type: z.literal('tab.pause'), paused: z.boolean() }).strict(),
  z.object({ type: z.literal('tab.routingPolicy'), policy: routingOverrideSchema.nullable() }).strict(),
  z.object({ type: z.literal('conversation.create'), title, brief: z.string().trim().max(8000), checks: z.array(check).max(40) }).strict(),
  z.object({ type: z.literal('conversation.rename'), conversationId: id, title }).strict(),
  z.object({ type: z.literal('conversation.archive'), conversationId: id, archived: z.boolean() }).strict(),
  z.object({ type: z.literal('agent.add'), conversationId: id, machineId: id, harnessId: id, name: title, configuration, lead: z.boolean(), initialMessage: text.optional() }).strict(),
  z.object({ type: z.literal('agent.start'), request: startRequestSchema, routeDecisionId: id.optional(), overrideReason: reason.optional() }).strict(),
  z.object({ type: z.literal('agent.startDispatch'), startId: id }).strict(),
  z.object({ type: z.literal('agent.started'), startId: id, harnessId: id, configuration }).strict(),
  z.object({ type: z.literal('agent.startFailed'), startId: id, error: text }).strict(),
  z.object({ type: z.literal('agent.remove'), agentId: id }).strict(),
  z.object({ type: z.literal('agent.configuration'), previousVersion: id.nullable(), configuration }).strict(),
  z.object({ type: z.literal('conversation.agent'), conversationId: id, agentId: id, present: z.boolean(), lead: z.boolean() }).strict(),
  z.object({ type: z.literal('invite.create'), email: z.email().max(320), role: z.enum(['collaborator', 'viewer']), conversationId: id }).strict(),
  z.object({ type: z.literal('invite.revoke'), inviteId: id }).strict(),
  z.object({ type: z.literal('invite.accept'), inviteId: id }).strict(),
  z.object({ type: z.literal('member.remove'), userId: id }).strict(),
  z.object({ type: z.literal('message.send'), conversationId: id, text, replyTo: id.nullable(), recipientIds: z.array(id).max(16) }).strict(),
  z.object({ type: z.literal('delivery.resolve'), deliveryId: id, resolution: z.enum(['received', 'resend', 'cancel']) }).strict(),
  z.object({ type: z.literal('work.define'), conversationId: id, brief: text, checks: z.array(check).min(1).max(40) }).strict(),
  z.object({ type: z.literal('work.assign'), conversationId: id, agentId: id, routeDecisionId: id.optional(), overrideReason: reason.optional() }).strict(),
  z.object({ type: z.literal('work.status'), conversationId: id, assignmentId: id,
    status: z.enum(['working', 'needs_human', 'review', 'done', 'stopped']), result: text.nullable() }).strict(),
  z.object({ type: z.literal('route.record'), conversationId: id, decision: routeRecordSchema }).strict(),
  z.object({ type: z.literal('route.override'), decisionId: id, candidateId: z.string().regex(/^c\d{1,2}$/), reason }).strict(),
  z.object({ type: z.literal('route.modelResult'), decisionId: id, startId: id, model: z.string().min(1).max(200), effort: z.string().min(1).max(80) }).strict(),
  z.object({ type: z.literal('work.check'), conversationId: id, assignmentId: id, checkId: id, passed: z.boolean(), evidence: text }).strict(),
])
export type Command = z.infer<typeof commandSchema>
export const operationSchema = z.object({ operationId: id, command: commandSchema }).strict()

export interface CommandContext {
  operationId: string
  now: number
  /** Read from host ownership/access records by the store, never copied from the request. */
  contribution?: { machineOwnerId: string; contributorId: string; hostGrant?: string | null }
  /** Loaded from this tab and conversation by the store. */
  reply?: { id: string; conversationId: string; author: Author }
  /** A host's receipt, not an elapsed lease, proves that an assignment stopped. */
  confirmedStopped?: boolean
  /** An uncertain receipt and its original message, read transactionally. */
  delivery?: { id: string; conversationId: string; agentId: string; messageId: string; text: string }
  /** Route decisions this tab recorded in the last hour, counted by the store. */
  recentRoutes?: number
  /** The decision a command names, read from SuperTabRouteDecision by the store. */
  routeDecision?: RouteDecision
}

function controls(state: SuperTabState, actor: Actor, conversationId = 'lead'): void {
  if (actor.kind === 'agent' && conversation(state, conversationId).leadId !== actor.agentId) {
    fail('LEAD_REQUIRED', 'The coordinating lead owns this action.', 403)
  }
}
function owner(state: SuperTabState, actor: Actor): void {
  if (actor.kind !== 'person' || actor.userId !== state.ownerId) fail('OWNER_REQUIRED', 'Only the Super Tab owner can manage invitations.', 403)
}
function open(state: SuperTabState, conversationId: string) {
  const group = conversation(state, conversationId)
  if (group.archived) fail('ARCHIVED', 'Reopen this conversation before changing its work.')
  return group
}

/** Pure policy/state transition. The store commits its state, messages and delivery records in one transaction. */
export function applyCommand(original: SuperTabState, actor: Actor, input: Command, context: CommandContext): CommandEffects {
  const command = commandSchema.parse(input)
  const state = structuredClone(original)
  const result: Record<string, unknown> = {}
  const effects: CommandEffects = { state, messages: [], cancelledAgents: [], previousAttempts: [], routeDecisions: [], result }
  const operationId = stableId(state.id, actorKey(actor), context.operationId)

  // Acceptance is the only operation a non-member can perform; the verified account email owns the invite.
  if (command.type === 'invite.accept') {
    if (actor.kind !== 'person') fail('FORBIDDEN', 'A person must accept this invitation.', 403)
    const invite = state.invitations.find(i => i.id === command.inviteId)
    if (!invite || invite.email !== actor.email.trim().toLowerCase()) fail('NOT_FOUND', 'This invitation is unavailable.', 404)
    if (invite.expiresAt <= context.now) fail('EXPIRED', 'This invitation expired.', 410)
    if (!state.people.some(p => p.id === actor.userId)) {
      state.people.push({ id: actor.userId, email: invite.email, role: invite.role, generation: invite.id })
    }
    state.invitations = state.invitations.filter(i => i.id !== invite.id)
    result.conversationId = invite.conversationId
    return effects
  }

  const leaving = command.type === 'member.remove' && actor.kind === 'person' && command.userId === actor.userId
  const sender = author(state, actor, !leaving)
  const rememberAttempt = (group: ReturnType<typeof conversation>) => {
    if (group.assignment) effects.previousAttempts.push(structuredClone({ conversationId: group.id,
      brief: group.brief, checks: group.checks, assignment: group.assignment }))
  }
  const message = (conversationId: string, body: string, recipients: string[] = [], replyTo: string | null = null, source?: Record<string, unknown>) => {
    effects.messages.push({ id: operationId, conversationId, author: sender, text: body, replyTo, recipients, ...(source ? { source } : {}) })
    result.messageId = operationId
  }
  const openDecision = (): RouteDecision => {
    const decision = context.routeDecision ?? fail('NOT_FOUND', 'This routing decision is unavailable.', 404)
    if (decision.outcome) fail('ROUTE_CLOSED', 'This routing decision is no longer open. Route the task again.')
    return decision
  }
  /** The candidate a start or assignment should match, and whether it does. A mismatch needs the lead's reason. */
  const linkDecision = (conversationId: string, matches: (c: RouteCandidate, d: RouteDecision) => boolean,
    finalOf: (d: RouteDecision) => RouteFinal, reasonText: string | undefined, assignmentId?: string) => {
    const decision = openDecision()
    if (decision.conversationId !== conversationId) fail('ROUTE_MISMATCH', 'This routing decision belongs to another group.')
    // A second start or assignment must not overwrite the final while the first attempt is still running.
    if (decision.assignmentId && state.conversations.some(c => c.assignment?.id === decision.assignmentId && activeWork(c))) {
      fail('ROUTE_LINKED', 'This routing decision already has running work. Stop it before handing the task over.')
    }
    const expected = decision.record.candidates.find(c => c.id === (decision.override?.candidateId ?? decision.record.pick))!
    const matched = matches(expected, decision)
    if (!matched && !reasonText) fail('OVERRIDE_REASON_REQUIRED', `Routing chose ${expected.title}. Pass an override reason to choose otherwise.`, 400)
    const override: RouteOverride | undefined = matched ? undefined : { by: 'lead', actorKey: actorKey(actor), reason: reasonText! }
    effects.routeDecisions.push({ op: 'final', id: decision.id, final: finalOf(decision), ...(override ? { override } : {}), ...(assignmentId ? { assignmentId } : {}) })
    return { decision, expected, override }
  }
  const removeAgent = (target: Agent) => {
    state.agents = state.agents.filter(a => a.id !== target.id)
    effects.cancelledAgents.push(target.id)
    for (const group of state.conversations) {
      group.agentIds = group.agentIds.filter(a => a !== target.id)
      if (group.leadId === target.id) group.leadId = null
      if (group.assignment?.agentId === target.id && activeWork(group)) group.assignment.status = 'reconciling'
    }
  }

  switch (command.type) {
    case 'tab.rename':
      controls(state, actor)
      state.name = command.name
      break
    case 'tab.pause':
      controls(state, actor)
      state.paused = command.paused
      break
    case 'tab.routingPolicy':
      if (actor.kind !== 'person' || actor.userId !== state.ownerId) fail('OWNER_REQUIRED', 'Only the Super Tab owner can change its routing policy.', 403)
      if (command.policy && Object.keys(command.policy).length) state.routingPolicy = command.policy
      else delete state.routingPolicy
      break
    case 'conversation.create': {
      controls(state, actor)
      if (state.paused) fail('PAUSED', 'New work is paused in this Super Tab.')
      if (actor.kind === 'agent' && (!command.brief || !command.checks.length)) {
        fail('BRIEF_REQUIRED', 'Delegated work needs a brief and acceptance checks.', 400)
      }
      const leadId = conversation(state, 'lead').leadId
      state.conversations.push({ id: operationId, title: command.title, leadId, agentIds: leadId ? [leadId] : [],
        archived: false, brief: command.brief, assignment: null, lastMessageSequence: 0,
        checks: command.checks.map((c, i) => ({ ...c, id: stableId(operationId, String(i)), evidence: null, passedBy: null })),
      })
      result.conversationId = operationId
      if (command.brief) message(operationId, command.brief)
      break
    }
    case 'conversation.rename':
      controls(state, actor, command.conversationId)
      open(state, command.conversationId).title = command.title
      break
    case 'conversation.archive': {
      controls(state, actor, command.conversationId)
      const group = conversation(state, command.conversationId)
      if (group.id === 'lead') fail('LEAD_CONVERSATION', 'The Lead conversation stays available.')
      if (command.archived && activeWork(group)) fail('WORK_ACTIVE', 'Resolve the active assignment before archiving this conversation.')
      group.archived = command.archived
      break
    }
    case 'agent.add': {
      controls(state, actor, command.conversationId)
      const group = open(state, command.conversationId)
      const grant = context.contribution ?? fail('HOST_REQUIRED', 'This session must be explicitly shared by an authorized contributor.', 403)
      const contributor = person(state, grant.contributorId)
      if (contributor.role === 'viewer') fail('READ_ONLY', 'A viewer cannot contribute agents.', 403)
      const agentId = stableId(command.machineId, command.harnessId)
      const existing = state.agents.find(a => a.id === agentId)
      if (!existing) state.agents.push({ id: agentId, machineId: command.machineId, harnessId: command.harnessId,
        machineOwnerId: grant.machineOwnerId, contributorId: grant.contributorId, membershipGeneration: contributor.generation,
        hostGrant: grant.hostGrant ?? null,
        name: command.name, configuration: command.configuration, configurationVersion: operationId })
      if (existing && (existing.machineOwnerId !== grant.machineOwnerId || existing.contributorId !== grant.contributorId)) {
        fail('ALREADY_SHARED', 'This session already has a contributor. Use the existing tab agent.')
      }
      if (existing && (existing.hostGrant ?? null) !== (grant.hostGrant ?? null)) {
        fail('CONTRIBUTION_REVOKED', 'Reconcile and remove this old contribution before adding it under the new machine share.', 403)
      }
      if (!group.agentIds.includes(agentId)) group.agentIds.push(agentId)
      if (command.lead) {
        if (group.leadId && group.leadId !== agentId && activeWork(group)) fail('WORK_ACTIVE', 'Reconcile active work before replacing its lead.')
        group.leadId = agentId
      }
      result.agentId = agentId
      // Creation already handed this first request to the native harness (and
      // any attachments through its existing launch path). Record it once in
      // the shared conversation without delivering the same request twice.
      if (command.initialMessage) {
        if (actor.kind !== 'person') fail('FORBIDDEN', 'Only a person can record their initial launch request.', 403)
        message(group.id, command.initialMessage)
      }
      break
    }
    case 'agent.start': {
      controls(state, actor, command.request.conversationId)
      open(state, command.request.conversationId)
      if (state.paused) fail('PAUSED', 'New work is paused in this Super Tab.')
      const grant = context.contribution ?? fail('HOST_REQUIRED', 'Choose a machine shared with the contributor.', 403)
      const contributor = person(state, grant.contributorId)
      if (contributor.role === 'viewer') fail('READ_ONLY', 'A viewer cannot start agents.', 403)
      state.starts ??= []
      if (state.starts.filter(s => !s.harnessId && !s.error).length >= 32) {
        fail('STARTS_PENDING', 'Reconcile pending agent starts before adding more.')
      }
      state.starts.push({ id: operationId, creationId: `super-${operationId}`, actorKey: actorKey(actor),
        contributorId: contributor.id, membershipGeneration: contributor.generation, machineOwnerId: grant.machineOwnerId,
        hostGrant: grant.hostGrant ?? null, request: command.request, harnessId: null, dispatched: false, error: null })
      result.startId = operationId
      if (command.routeDecisionId) {
        const r = command.request
        const model = r.model ?? 'default', effort = r.effort ?? 'default'
        const { decision, expected, override } = linkDecision(r.conversationId,
          c => c.kind === 'new' && c.machineId === r.machineId && c.engine === r.engine && c.model === model && c.effort === effort,
          () => ({ kind: 'new', startId: operationId, machineId: r.machineId, engine: r.engine, model, effort }), command.overrideReason)
        if (override) message(r.conversationId, `Lead started ${r.name} instead of ${expected.title}. Reason: ${override.reason}`, [], null,
          { kind: 'route-override', decisionId: decision.id, by: 'lead' })
      }
      break
    }
    case 'agent.startDispatch':
    case 'agent.started':
    case 'agent.startFailed': {
      const start = state.starts?.find(s => s.id === command.startId) ?? fail('NOT_FOUND', 'This agent start is unavailable.', 404)
      if (start.actorKey !== actorKey(actor)) fail('FORBIDDEN', 'Only the initiating lead can complete this start.', 403)
      if (person(state, start.contributorId).generation !== start.membershipGeneration) fail('FORBIDDEN', 'This contribution was withdrawn.', 403)
      controls(state, actor, start.request.conversationId)
      if (command.type === 'agent.startDispatch') {
        if (state.paused) fail('PAUSED', 'New work is paused in this Super Tab.')
        open(state, start.request.conversationId)
        const grant = context.contribution ?? fail('HOST_REQUIRED', 'The original machine grant is unavailable.', 403)
        if (grant.machineOwnerId !== start.machineOwnerId || (grant.hostGrant ?? null) !== start.hostGrant) {
          fail('CONTRIBUTION_REVOKED', 'The original machine grant was revoked.', 403)
        }
        if (start.dispatched || start.error || start.harnessId) fail('START_CLAIMED', 'This native start was already requested. Read its creation status; do not start another.')
        start.dispatched = true
        break
      }
      if (command.type === 'agent.startFailed') {
        if (start.harnessId) fail('ALREADY_STARTED', 'This agent already started.')
        start.error = command.error
        message(start.request.conversationId, `Could not start ${start.request.name}: ${command.error}`)
        break
      }
      if (start.error) fail('START_FAILED', 'This start failed. Use a new start request.')
      if (start.harnessId && start.harnessId !== command.harnessId) fail('ALREADY_STARTED', 'This start already has a native harness.')
      const grant = context.contribution ?? fail('HOST_REQUIRED', 'The original machine grant is unavailable.', 403)
      if (grant.machineOwnerId !== start.machineOwnerId || grant.contributorId !== start.contributorId ||
        (grant.hostGrant ?? null) !== start.hostGrant) fail('CONTRIBUTION_REVOKED', 'The original machine grant was revoked.', 403)
      const group = open(state, start.request.conversationId)
      const agentId = stableId(start.request.machineId, command.harnessId)
      if (state.agents.some(a => a.id === agentId)) fail('ALREADY_SHARED', 'This native harness is already in the tab.')
      state.agents.push({ id: agentId, machineId: start.request.machineId, harnessId: command.harnessId,
        machineOwnerId: start.machineOwnerId, contributorId: start.contributorId, membershipGeneration: start.membershipGeneration,
        hostGrant: start.hostGrant, name: start.request.name, configuration: command.configuration, configurationVersion: operationId })
      group.agentIds.push(agentId)
      start.harnessId = command.harnessId
      result.agentId = agentId
      message(group.id, `${start.request.name} joined. Ready for an assignment.`)
      break
    }
    case 'agent.configuration': {
      if (actor.kind !== 'agent') fail('HOST_REQUIRED', 'Only the execution host can record an observed configuration.', 403)
      const target = agent(state, actor.agentId)
      if ((target.configurationVersion ?? null) !== command.previousVersion) {
        fail('STALE_CONFIGURATION', 'Read the current agent configuration before reporting another observation.')
      }
      if (Object.entries(command.configuration).some(([key, value]) => target.configuration[key as keyof typeof target.configuration] !== value)) {
        target.configuration = command.configuration
        target.configurationVersion = operationId
      }
      break
    }
    case 'agent.remove': {
      const target = agent(state, command.agentId)
      if (actor.kind !== 'person' || (actor.userId !== state.ownerId && actor.userId !== target.contributorId)) {
        fail('FORBIDDEN', 'Only the contributor or tab owner can withdraw this agent.', 403)
      }
      removeAgent(target)
      break
    }
    case 'conversation.agent': {
      controls(state, actor, command.conversationId)
      const group = open(state, command.conversationId)
      agent(state, command.agentId)
      if (!command.present) {
        if (activeWork(group) && (group.assignment?.agentId === command.agentId || group.leadId === command.agentId)) {
          fail('WORK_ACTIVE', 'Reconcile this agent’s assignment before removing it from the conversation.')
        }
        group.agentIds = group.agentIds.filter(id => id !== command.agentId)
        if (group.leadId === command.agentId) group.leadId = null
      } else {
        if (!group.agentIds.includes(command.agentId)) group.agentIds.push(command.agentId)
        if (command.lead) {
          if (group.leadId && group.leadId !== command.agentId && activeWork(group)) fail('WORK_ACTIVE', 'Reconcile active work before replacing its lead.')
          group.leadId = command.agentId
        }
      }
      break
    }
    case 'invite.create': {
      owner(state, actor)
      conversation(state, command.conversationId)
      const email = command.email.trim().toLowerCase()
      if (state.people.some(p => p.email === email)) fail('ALREADY_MEMBER', 'This person is already in the Super Tab.')
      state.invitations = state.invitations.filter(i => i.email !== email)
      state.invitations.push({ id: operationId, email, role: command.role, conversationId: command.conversationId,
        expiresAt: context.now + 7 * 86_400_000 })
      result.inviteId = operationId
      break
    }
    case 'invite.revoke':
      owner(state, actor)
      state.invitations = state.invitations.filter(i => i.id !== command.inviteId)
      break
    case 'member.remove': {
      if (actor.kind !== 'person' || (actor.userId !== state.ownerId && actor.userId !== command.userId)) {
        fail('FORBIDDEN', 'Only the owner can remove another person.', 403)
      }
      if (command.userId === state.ownerId) fail('OWNER_REQUIRED', 'The owner cannot leave their Super Tab.')
      const member = person(state, command.userId)
      for (const target of state.agents.filter(a => a.contributorId === member.id)) removeAgent(target)
      state.people = state.people.filter(p => p.id !== member.id)
      state.invitations = state.invitations.filter(i => i.email !== member.email)
      result.removedUserId = member.id
      break
    }
    case 'message.send': {
      const group = open(state, command.conversationId)
      if (actor.kind === 'agent' && !group.agentIds.includes(actor.agentId)) fail('FORBIDDEN', 'This agent does not participate in the conversation.', 403)
      if (command.replyTo && (!context.reply || context.reply.id !== command.replyTo || context.reply.conversationId !== group.id)) {
        fail('INVALID_REPLY', 'Reply to a message in this conversation.', 400)
      }
      const replyAgent = context.reply?.author.kind === 'agent' ? context.reply.author.id : null
      const automatic = actor.kind === 'person' ? (replyAgent && group.agentIds.includes(replyAgent) ? replyAgent : group.leadId) : null
      const recipients = [...new Set(command.recipientIds.length ? command.recipientIds : automatic ? [automatic] : [])]
      for (const id of recipients) {
        agent(state, id)
        if (!group.agentIds.includes(id)) fail('INVALID_RECIPIENT', 'Choose an agent in this conversation.', 400)
      }
      // The transcript still accepts a human message while the lead is unavailable. The UI can say why no delivery was created.
      message(group.id, command.text, recipients, command.replyTo)
      break
    }
    case 'delivery.resolve': {
      if (actor.kind !== 'person') fail('HUMAN_REQUIRED', 'A person must inspect an uncertain delivery before resolving it.', 403)
      const delivery = context.delivery
      if (!delivery || delivery.id !== command.deliveryId) fail('DELIVERY_RESOLVED', 'This delivery no longer needs checking.')
      const group = conversation(state, delivery.conversationId)
      const target = agent(state, delivery.agentId)
      if (command.resolution === 'resend') {
        open(state, group.id)
        if (!group.agentIds.includes(target.id)) fail('INVALID_RECIPIENT', 'This agent is no longer in the conversation.', 400)
        message(group.id, delivery.text, [target.id], delivery.messageId)
      } else {
        message(group.id, command.resolution === 'received'
          ? `Checked ${target.name}’s terminal and confirmed the earlier instruction was received.`
          : `Dismissed the delivery warning for ${target.name}. This does not stop work already received.`, [], delivery.messageId)
      }
      result.deliveryId = delivery.id
      result.resolution = command.resolution
      break
    }
    case 'route.record': {
      controls(state, actor, command.conversationId)
      open(state, command.conversationId)
      if ((context.recentRoutes ?? 0) >= 30) fail('RATE_LIMITED', 'This Super Tab routed 30 tasks in the last hour. Wait before routing again.', 429)
      const decision = command.decision
      const pick = decision.candidates.find(c => c.id === decision.pick)!
      const via = decision.via === 'jev' ? `Jev ${Math.round((decision.p ?? 0) * 100)}%`
        : decision.via === 'only' ? 'only candidate' : 'by policy order'
      effects.routeDecisions.push({ op: 'create', id: operationId, conversationId: command.conversationId, record: decision })
      result.routeDecisionId = operationId
      // The row quotes the Lead's reason for the task; the verdict's own text stays in the decision record.
      const reason = decision.assessment.why
      message(command.conversationId, `Routed to ${pick.title} — ${via} · "${reason}"`, [], null, {
        kind: 'route', decisionId: operationId, via: decision.via, p: decision.p, belowFloor: decision.belowFloor, why: reason,
        ...(decision.via === 'order' && decision.fallback ? { fallback: decision.fallback } : {}),
        pick: { id: pick.id, title: pick.title },
        alternatives: decision.candidates.filter(c => c.id !== pick.id).map(c => ({ id: c.id, title: c.title })),
      })
      break
    }
    case 'route.modelResult': {
      const decision = openDecision()
      controls(state, actor, decision.conversationId)
      const final = decision.final
      if (final?.kind !== 'new' || final.startId !== command.startId) fail('ROUTE_MISMATCH', 'This routing decision did not start that agent.')
      // The final says who was actually started. When the routed switch failed, the request moves to `requested`.
      effects.routeDecisions.push({ op: 'final', id: decision.id,
        final: { ...final, model: command.model, effort: command.effort, requested: final.requested ?? { model: final.model, effort: final.effort } } })
      break
    }
    case 'route.override': {
      if (actor.kind !== 'person') fail('HUMAN_REQUIRED', 'A person changes a routing decision; the lead overrides when it starts or assigns.', 403)
      const decision = openDecision()
      controls(state, actor, decision.conversationId)
      open(state, decision.conversationId)
      const current = decision.override?.candidateId ?? decision.record.pick
      const chosen = decision.record.candidates.find(c => c.id === command.candidateId) ?? fail('NOT_FOUND', 'Choose one of this decision’s candidates.', 404)
      if (chosen.id === current) fail('ALREADY_CHOSEN', 'That candidate is already the choice.')
      if (chosen.kind === 'member' && !state.agents.some(a => a.id === chosen.agentId)) fail('CANDIDATE_UNAVAILABLE', 'That agent left this Super Tab. Choose another.')
      effects.routeDecisions.push({ op: 'override', id: decision.id, override: { by: 'person', actorKey: actorKey(actor), candidateId: chosen.id, reason: command.reason } })
      const lead = conversation(state, decision.conversationId).leadId
      message(decision.conversationId,
        `${sender.name} chose ${chosen.title} instead of ${routeTitle(decision, current)}. Hand this task over to it. Reason: ${command.reason}`,
        lead ? [lead] : [], null, { kind: 'route-override', decisionId: decision.id, by: 'person' })
      break
    }
    case 'work.define': {
      controls(state, actor, command.conversationId)
      const group = open(state, command.conversationId)
      if (activeWork(group)) fail('WORK_ACTIVE', 'Finish or stop the current assignment before changing its acceptance checks.')
      rememberAttempt(group)
      group.assignment = null
      group.brief = command.brief
      group.checks = command.checks.map((c, i) => ({ ...c, id: stableId(operationId, String(i)), evidence: null, passedBy: null }))
      message(group.id, command.brief)
      break
    }
    case 'work.assign': {
      controls(state, actor, command.conversationId)
      const group = open(state, command.conversationId)
      if (state.paused) fail('PAUSED', 'New work is paused in this Super Tab.')
      if (activeWork(group)) fail('WORK_ACTIVE', 'The current assignment must finish or be reconciled before reassignment.')
      if (!group.brief || !group.checks.length) fail('BRIEF_REQUIRED', 'Record the brief and acceptance checks before assigning work.', 400)
      const worker = agent(state, command.agentId)
      if (state.conversations.some(c => activeWork(c) && c.assignment?.agentId === worker.id)) fail('AGENT_BUSY', 'This agent already owns an active assignment.')
      if (!group.agentIds.includes(worker.id)) group.agentIds.push(worker.id)
      rememberAttempt(group)
      group.assignment = { id: operationId, agentId: worker.id, status: 'working', configuration: structuredClone(worker.configuration),
        execution: { machineId: worker.machineId, harnessId: worker.harnessId, machineOwnerId: worker.machineOwnerId }, result: null }
      group.checks.forEach(c => { c.evidence = null; c.passedBy = null })
      result.assignmentId = operationId
      let routeNote: { decisionId: string; text: string } | null = null
      if (command.routeDecisionId) {
        const started = (d: RouteDecision) => d.final?.kind === 'new' &&
          !!state.starts?.some(s => s.id === (d.final as { startId: string }).startId && s.harnessId === worker.harnessId && s.request.machineId === worker.machineId)
        // An agent started from this decision keeps the final that records its model and effort; only the assignment is added.
        const { decision, expected, override } = linkDecision(group.id,
          (c, d) => (c.kind === 'member' && c.agentId === worker.id) || (c.kind === 'new' && started(d) && d.final?.kind === 'new' &&
            startedAs(c, d.final)),
          d => started(d) ? d.final! : { kind: 'member', agentId: worker.id, machineId: worker.machineId }, command.overrideReason, operationId)
        if (override) routeNote = { decisionId: decision.id, text: `Lead assigned ${worker.name} instead of ${expected.title}. Reason: ${override.reason}` }
      }
      message(group.id, `${group.brief}\n\nAcceptance checks:\n${group.checks.map(c => `- ${c.description}`).join('\n')}`, [worker.id])
      if (routeNote) effects.messages.push({ id: stableId(operationId, 'route-override'), conversationId: group.id, author: sender,
        text: routeNote.text, replyTo: null, recipients: [], source: { kind: 'route-override', decisionId: routeNote.decisionId, by: 'lead' } })
      break
    }
    case 'work.status': {
      const group = open(state, command.conversationId)
      const assignment = group.assignment
      if (!assignment || assignment.id !== command.assignmentId) fail('STALE_ASSIGNMENT', 'This is no longer the active assignment.')
      if (!activeWork(group)) fail('ATTEMPT_CLOSED', 'Assign a new attempt to continue this work.')
      if (actor.kind === 'agent' && actor.agentId !== assignment.agentId && actor.agentId !== group.leadId) fail('FORBIDDEN', 'Only the assigned agent or coordinating lead can update this work.', 403)
      if (command.status === 'stopped' && !context.confirmedStopped) fail('STOP_UNCONFIRMED', 'Wait for the execution host to confirm the stop.')
      if (assignment.status === 'reconciling' && command.status !== 'stopped') fail('RECONCILING', 'Reconcile the previous assignment before continuing.')
      if (command.status === 'done' && (!command.result || !group.checks.every(c => c.passedBy && c.evidence))) {
        fail('CHECKS_PENDING', 'Completion needs a result and evidence for every acceptance check.')
      }
      const changed = assignment.status !== command.status || assignment.result !== command.result
      assignment.status = command.status
      assignment.result = command.result
      if (changed) {
        const label = { working: 'Working', needs_human: 'Needs a human', review: 'Ready for review', done: 'Done', stopped: 'Stopped' }[command.status]
        const lead = group.leadId
        const tellLead = actor.kind === 'agent' && actor.agentId === assignment.agentId && lead && lead !== actor.agentId &&
          ['needs_human', 'review', 'done'].includes(command.status)
        message(group.id, `${label}${command.result ? `\n\n${command.result}` : ''}`, tellLead ? [lead] : [])
      }
      break
    }
    case 'work.check': {
      const group = open(state, command.conversationId)
      if (!group.assignment || group.assignment.id !== command.assignmentId) fail('STALE_ASSIGNMENT', 'This is no longer the active assignment.')
      if (!activeWork(group)) fail('ATTEMPT_CLOSED', 'Assign a new attempt before changing its acceptance evidence.')
      if (group.assignment.status === 'reconciling') fail('RECONCILING', 'Reconcile the previous assignment before continuing.')
      const check = group.checks.find(c => c.id === command.checkId) ?? fail('NOT_FOUND', 'This acceptance check is unavailable.', 404)
      if (actor.kind === 'agent' && !group.agentIds.includes(actor.agentId)) fail('FORBIDDEN', 'This agent does not participate in the review.', 403)
      if (check.independent && actor.kind === 'agent' && actor.agentId === group.assignment.agentId) fail('INDEPENDENT_REVIEW', 'Another agent or a person must perform this check.')
      check.evidence = command.evidence
      check.passedBy = command.passed ? actorKey(actor) : null
      break
    }
  }
  // MongoDB limits a document to 16 MiB. Leave room for indexes and metadata, and refuse before losing state.
  if (Buffer.byteLength(JSON.stringify(state)) > 8 * 1024 * 1024) fail('TAB_TOO_LARGE', 'This Super Tab has reached its metadata limit.', 413)
  return effects
}
