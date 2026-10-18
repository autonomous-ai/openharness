import { z } from 'zod'
import {
  activeWork, actorKey, agent, author, conversation, fail, person, stableId,
  type Actor, type Agent, type Author, type CommandEffects, type SuperTabState,
} from './model.js'

const id = z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/)
const title = z.string().trim().min(1).max(160)
const text = z.string().trim().min(1).max(32_000)
const configuration = z.object({
  engine: z.string().min(1).max(80), model: z.string().max(200).nullable(),
  effort: z.string().max(80).nullable(), contextWindow: z.number().int().positive().safe().nullable(),
  engineVersion: z.string().max(160).nullable(),
}).strict()
const check = z.object({ description: z.string().trim().min(1).max(1000), independent: z.boolean() }).strict()

export const commandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('tab.rename'), name: title }).strict(),
  z.object({ type: z.literal('tab.pause'), paused: z.boolean() }).strict(),
  z.object({ type: z.literal('conversation.create'), title, brief: z.string().trim().max(8000), checks: z.array(check).max(40) }).strict(),
  z.object({ type: z.literal('conversation.rename'), conversationId: id, title }).strict(),
  z.object({ type: z.literal('conversation.archive'), conversationId: id, archived: z.boolean() }).strict(),
  z.object({ type: z.literal('agent.add'), conversationId: id, machineId: id, harnessId: id, name: title, configuration, lead: z.boolean() }).strict(),
  z.object({ type: z.literal('agent.remove'), agentId: id }).strict(),
  z.object({ type: z.literal('conversation.agent'), conversationId: id, agentId: id, present: z.boolean(), lead: z.boolean() }).strict(),
  z.object({ type: z.literal('invite.create'), email: z.email().max(320), role: z.enum(['collaborator', 'viewer']), conversationId: id }).strict(),
  z.object({ type: z.literal('invite.revoke'), inviteId: id }).strict(),
  z.object({ type: z.literal('invite.accept'), inviteId: id }).strict(),
  z.object({ type: z.literal('member.remove'), userId: id }).strict(),
  z.object({ type: z.literal('message.send'), conversationId: id, text, replyTo: id.nullable(), recipientIds: z.array(id).max(16) }).strict(),
  z.object({ type: z.literal('work.define'), conversationId: id, brief: text, checks: z.array(check).min(1).max(40) }).strict(),
  z.object({ type: z.literal('work.assign'), conversationId: id, agentId: id }).strict(),
  z.object({ type: z.literal('work.status'), conversationId: id, assignmentId: id,
    status: z.enum(['working', 'needs_human', 'review', 'done', 'stopped']), result: text.nullable() }).strict(),
  z.object({ type: z.literal('work.check'), conversationId: id, assignmentId: id, checkId: id, passed: z.boolean(), evidence: text }).strict(),
])
export type Command = z.infer<typeof commandSchema>
export const operationSchema = z.object({ operationId: id, command: commandSchema }).strict()

export interface CommandContext {
  operationId: string
  now: number
  /** Read from host ownership/access records by the store, never copied from the request. */
  contribution?: { machineOwnerId: string; contributorId: string }
  /** Loaded from this tab and conversation by the store. */
  reply?: { id: string; conversationId: string; author: Author }
  /** A host's receipt, not an elapsed lease, proves that an assignment stopped. */
  confirmedStopped?: boolean
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
  const effects: CommandEffects = { state, messages: [], cancelledAgents: [], previousAttempts: [], result }
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
  const message = (conversationId: string, body: string, recipients: string[] = [], replyTo: string | null = null) => {
    effects.messages.push({ id: operationId, conversationId, author: sender, text: body, replyTo, recipients })
    result.messageId = operationId
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
        name: command.name, configuration: command.configuration })
      if (existing && (existing.machineOwnerId !== grant.machineOwnerId || existing.contributorId !== grant.contributorId)) {
        fail('ALREADY_SHARED', 'This session already has a contributor. Use the existing tab agent.')
      }
      if (!group.agentIds.includes(agentId)) group.agentIds.push(agentId)
      if (command.lead) {
        if (group.leadId && group.leadId !== agentId && activeWork(group)) fail('WORK_ACTIVE', 'Reconcile active work before replacing its lead.')
        group.leadId = agentId
      }
      result.agentId = agentId
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
      message(group.id, `${group.brief}\n\nAcceptance checks:\n${group.checks.map(c => `- ${c.description}`).join('\n')}`, [worker.id])
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
      assignment.status = command.status
      assignment.result = command.result
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
