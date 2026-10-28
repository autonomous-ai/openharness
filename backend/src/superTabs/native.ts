import { createHash } from 'node:crypto'
import type { Prisma, SuperTabNativeContext } from '@prisma/client'
import { z } from 'zod'
import type { AuthUser } from '../lib/ssoAuth.js'
import { isTeamSession, TEAM_SESSION_LIMITED, TEAM_SESSION_MESSAGE } from '../lib/teamSession.js'
import { activeWork, agent, author, conversation, fail, isLeads, stableId, SuperTabError,
  type Actor, type Agent, type Author, type Conversation, type SuperTabState } from './model.js'
import { canReadGroup, groupProject, readConversation } from './projects.js'
import { noteProjectReports } from './projectUpdates.js'
import { numberMessages, type Touch } from './parts/commit.js'
import { redactCredentials } from './credentials.js'

const id = z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/)
export const openNativeSchema = z.object({ operationId: id, conversationId: id, agentId: id }).strict()
export const nativeEventSchema = z.object({
  turnId: id, kind: z.enum(['prompt', 'answer', 'gap']), previousEventId: id.nullable(),
  text: z.string().max(16_000), truncated: z.boolean(), interrupted: z.boolean(),
  gap: z.object({ incidentId: id, reason: z.enum(['recording_restarted', 'history_lost', 'unattributed_input', 'context_expired', 'agent_stopped', 'prompt_missing']),
    detectedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }).strict().optional(),
}).strict().refine(event => !event.gap || event.kind === 'gap', 'Recovery metadata belongs to a recording gap.')
type NativeEvent = z.infer<typeof nativeEventSchema>
type Transaction = Prisma.TransactionClient
type Grant = { machineOwnerId: string; contributorId: string; hostGrant: string | null }
interface Binding {
  tabId: string; conversationId: string; agentId: string; harnessId: string; machineId: string; machineOwnerId: string
  operator: Author; contributorId: string; contributionGeneration: string; contributionGrant: string | null; inputGrant: string | null
}
interface Loaded { state: SuperTabState }
interface Deps {
  transaction<T>(body: (tx: Transaction) => Promise<T>): Promise<T>
  /** The Swarm loaded from its parts, with these groups even when dormant. */
  load(tx: Transaction, user: AuthUser, tabId: string, groupIds: string[]): Promise<Loaded>
  /** Writes what changed from the loaded state, touching the parts the write relied on (store.ts save). */
  save(tx: Transaction, loaded: Loaded, next: SuperTabState, stamp: number, touches: Touch[]): Promise<unknown>
  stamp(): number
  agentGrant(tx: Transaction, state: SuperTabState, target: Agent): Promise<void>
  contribution(tx: Transaction, state: SuperTabState, actor: Actor, command: { machineId: string }): Promise<Grant>
  /** The one machine a team session (lib/teamSession.ts) hosts for; null for any other sign-in. */
  teamHost(tx: Transaction, user: AuthUser): Promise<string | null>
  /** Refuses a person no longer in the Swarm's Workspace (workspaceStore.ts requireWorkspaceAccess). */
  workspaceAccess(tx: Transaction, state: SuperTabState, userId: string): Promise<void>
}
const json = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
interface Checkpoint { eventId: string | null; turnId: string | null; recordedAt: string | null; sequence: number }
interface Recovery {
  assignmentId: string; incidentId: string; reason: string; detectedAt: number; checkpoint: Checkpoint; required: boolean
}
const gapReasons = {
  recording_restarted: 'The work was interrupted by a restart of the terminal recording.',
  history_lost: 'Part of the recorded terminal history was lost.',
  unattributed_input: 'Terminal input could not be attributed to this conversation.',
  context_expired: 'Terminal recording expired before the activity was captured.',
  agent_stopped: 'The agent stopped during an unfinished recorded turn.',
  prompt_missing: 'A terminal answer was observed without its recorded prompt.',
}

/** A host reports what its native engine observed; it cannot create human-authored
 * messages. The human attached to the source is the authenticated opener of that
 * terminal context, not an inference from a device name or the machine owner. */
export class SuperTabNativeStore {
  constructor(private readonly deps: Deps) {}

  private async validate(tx: Transaction, state: SuperTabState, record: SuperTabNativeContext) {
    if (record.revoked) fail('NATIVE_CONTEXT_REVOKED', 'Reopen the terminal from this conversation.', 403)
    const binding = record.binding as unknown as Binding
    const operator = author(state, { kind: 'person', userId: binding.operator.id, email: binding.operator.name }, true)
    const target = agent(state, record.agentId)
    const group = readConversation(state, { kind: 'person', userId: binding.operator.id, email: binding.operator.name }, record.conversationId)
    if (operator.membershipGeneration !== binding.operator.membershipGeneration || group.archived || !group.agentIds.includes(target.id)
      || target.harnessId !== binding.harnessId || target.machineId !== binding.machineId || target.machineOwnerId !== binding.machineOwnerId
      || target.contributorId !== binding.contributorId || target.membershipGeneration !== binding.contributionGeneration
      || (target.hostGrant ?? null) !== binding.contributionGrant) {
      fail('NATIVE_CONTEXT_REVOKED', 'This terminal context no longer belongs to the current contribution.', 403)
    }
    await this.deps.agentGrant(tx, state, target)
    await this.deps.workspaceAccess(tx, state, binding.operator.id)
    // Read the person's current identity, rather than trusting a name supplied by
    // a terminal client or reusing an old email after an account change.
    const user = await tx.user.findUnique({ where: { id: operator.id }, select: { email: true, autonomousEnv: true } })
    if (!user || user.autonomousEnv !== state.environment) fail('NATIVE_CONTEXT_REVOKED', 'The terminal opener is unavailable.', 403)
    const grant = await this.deps.contribution(tx, state, { kind: 'person', userId: operator.id, email: user.email }, target)
    if (grant.machineOwnerId !== binding.machineOwnerId || grant.hostGrant !== binding.inputGrant) {
      fail('NATIVE_CONTEXT_REVOKED', 'The terminal opener no longer has the original machine access.', 403)
    }
    return { binding, target, group }
  }

  async open(user: AuthUser, tabId: string, input: z.infer<typeof openNativeSchema>) {
    // A person opens a terminal; a team session has no person to open one as.
    if (isTeamSession(user)) fail(TEAM_SESSION_LIMITED, TEAM_SESSION_MESSAGE, 403)
    const request = openNativeSchema.parse(input)
    return this.deps.transaction(async tx => {
      const { state } = await this.deps.load(tx, user, tabId, [request.conversationId])
      await this.deps.workspaceAccess(tx, state, user.sub)
      const operator = author(state, { kind: 'person', userId: user.sub, email: user.email }, true)
      const target = agent(state, request.agentId)
      const group = readConversation(state, { kind: 'person', userId: user.sub, email: user.email }, request.conversationId)
      groupProject(state, group) // A terminal opens only in a project's conversation, never in the Leads conversation.
      if (group.archived || !group.agentIds.includes(target.id)) fail('AGENT_UNAVAILABLE', 'Choose an agent in this conversation.')
      await this.deps.agentGrant(tx, state, target)
      const grant = await this.deps.contribution(tx, state, { kind: 'person', userId: user.sub, email: user.email }, target)
      const contextId = stableId('native', tabId, user.sub, request.operationId)
      const prior = await tx.superTabNativeContext.findUnique({ where: { id: contextId } })
      if (prior) {
        if (prior.conversationId !== request.conversationId || prior.agentId !== request.agentId) fail('OPERATION_REUSED', 'Use a new operation ID for a different terminal.')
        await this.validate(tx, state, prior)
        return { contextId }
      }
      const binding: Binding = { tabId, conversationId: group.id, agentId: target.id, harnessId: target.harnessId,
        machineId: target.machineId, machineOwnerId: target.machineOwnerId, operator,
        contributorId: target.contributorId, contributionGeneration: target.membershipGeneration,
        contributionGrant: target.hostGrant ?? null, inputGrant: grant.hostGrant }
      await tx.superTabNativeContext.create({ data: { id: contextId, tabId, conversationId: group.id,
        agentId: target.id, userId: user.sub, binding: json(binding) } })
      return { contextId }
    })
  }

  private async hosted(tx: Transaction, user: AuthUser, tabId: string, contextId: string) {
    const record = await tx.superTabNativeContext.findFirst({ where: { id: contextId, tabId } })
      ?? fail('NOT_FOUND', 'This terminal context is unavailable.', 404)
    const loaded = await this.deps.load(tx, user, tabId, [record.conversationId]), state = loaded.state
    const binding = record.binding as unknown as Binding
    if (binding.machineOwnerId !== user.sub) fail('FORBIDDEN', 'Only the execution host can record this terminal.', 403)
    // A team session records only the terminals of its own machine's agents.
    const team = await this.deps.teamHost(tx, user)
    if (team !== null && binding.machineId !== team) fail(TEAM_SESSION_LIMITED, TEAM_SESSION_MESSAGE, 403)
    const verified = await this.validate(tx, state, record)
    return { ...verified, loaded, record, team: team !== null }
  }

  async read(user: AuthUser, tabId: string, contextId: string) {
    return this.deps.transaction(async tx => {
      const { binding, record } = await this.hosted(tx, user, tabId, contextId)
      // Old recorders ignore this. New recorders keep the old strict request
      // shape until this backend explicitly advertises recovery support.
      return { contextId, ...binding, lastEventId: record.lastEventId, recovery: { version: 1, serverTime: Date.now() } }
    })
  }

  async allowsDelivery(tx: Transaction, state: SuperTabState, contextId: string): Promise<boolean> {
    const record = await tx.superTabNativeContext.findFirst({ where: { id: contextId, tabId: state.id } })
    if (!record) return false
    try { await this.validate(tx, state, record); return true }
    catch (error) { if (error instanceof SuperTabError) return false; throw error }
  }

  private async recovery(tx: Transaction, tabId: string, group: Conversation, target: Agent, record: SuperTabNativeContext,
    event: NativeEvent, eventId: string): Promise<{ source: Recovery; text: string } | null> {
    const assignment = group.assignment
    // A recording gap can also mean ordinary human typing or an expired view.
    // Older recorders do not distinguish those, so only known interruptions wake the Lead.
    if (event.kind !== 'gap' || !event.gap || !['recording_restarted', 'history_lost', 'agent_stopped'].includes(event.gap.reason)
      || !assignment || !activeWork(group) || assignment.agentId !== target.id
      || !group.leadId || group.leadId === target.id) return null
    const previous = await tx.superTabMessage.findFirst({ where: { id: record.lastEventId ?? assignment.id, tabId, conversationId: group.id } })
    const source = previous?.source as { turnId?: string; recovery?: Recovery } | null
    // Preserve the original checkpoint through repeated gaps. A gap is not new work progress.
    let checkpoint: Checkpoint = source?.recovery?.checkpoint ?? {
      eventId: previous?.id ?? null, turnId: source?.turnId ?? null,
      recordedAt: previous?.createdAt.toISOString() ?? null, sequence: previous?.sequence ?? 0,
    }
    const incidentId = event.gap.incidentId
    const receiptId = stableId('native-recovery', assignment.id, incidentId)
    const prior = await tx.superTabOperation.findUnique({ where: { id: receiptId } })
    const progress = assignment.recordingProgress
    const progressed = !!progress && progress.at >= event.gap.detectedAt
    if (progress && !progressed && progress.revision > checkpoint.sequence) {
      const latest = await tx.superTabMessage.findFirst({ where: { tabId, conversationId: group.id, sequence: progress.revision } })
      if (latest) checkpoint = { eventId: latest.id, turnId: null, recordedAt: latest.createdAt.toISOString(), sequence: latest.sequence }
    }
    const required = !prior && !progressed && ['working', 'review'].includes(assignment.status)
    const recovery: Recovery = { assignmentId: assignment.id, incidentId, reason: event.gap.reason,
      detectedAt: event.gap.detectedAt, checkpoint, required }
    const reason = assignment.status === 'review' && event.gap.reason === 'recording_restarted'
      ? 'Terminal recording restarted while the task was in review.' : gapReasons[event.gap.reason]
    const next = assignment.status === 'review' ? 'Keep this task in review while you check the agent’s session.'
      : 'Check the agent’s session, then ask it to continue from the checkpoint and report working.'
    const text = `Recovery needed for ${target.displayName ?? target.name} on “${group.title}”. ${reason}\n\n`
      + `Last recorded checkpoint: ${checkpoint.recordedAt ?? 'time unavailable'}.\n\n`
      + `${next} Do not replay earlier input or commands; they may already have taken effect.`
    if (required && assignment.status === 'working') { assignment.status = 'blocked'; assignment.result = text }
    if (!prior) await tx.superTabOperation.create({ data: { id: receiptId, tabId, actorKey: `agent:${target.id}`,
      requestHash: digest([assignment.id, incidentId]), revision: 0, result: json({ eventId, recovery }) } })
    return { source: recovery, text }
  }

  async append(user: AuthUser, tabId: string, contextId: string, input: NativeEvent) {
    const event = nativeEventSchema.parse(input)
    return this.deps.transaction(async tx => {
      const { loaded, record, binding, team } = await this.hosted(tx, user, tabId, contextId)
      const state = structuredClone(loaded.state)
      const target = agent(state, record.agentId), group = conversation(state, record.conversationId)
      const eventId = stableId('native-event', contextId, event.turnId, event.kind), requestHash = digest(event)
      const prior = await tx.superTabOperation.findUnique({ where: { id: eventId } })
      if (prior) {
        if (prior.requestHash !== requestHash) fail('OPERATION_REUSED', 'This native observation already has different content.')
        return prior.result
      }
      if (record.lastEventId !== event.previousEventId) fail('NATIVE_ORDER_CHANGED', 'Reconcile the recorded terminal observations before continuing.')
      const promptId = stableId('native-event', contextId, event.turnId, 'prompt')
      if (event.kind === 'answer' && !await tx.superTabOperation.findUnique({ where: { id: promptId } })) {
        fail('NATIVE_PROMPT_MISSING', 'The terminal prompt was not recorded. Record the observation gap first.')
      }
      const recovery = await this.recovery(tx, tabId, group, target, record, event, eventId)
      const observedBy = author(state, { kind: 'agent', agentId: target.id, machineOwnerId: user.sub }, true)
      // What a person typed in the terminal, or the agent answered, is recorded without any credential in it.
      const text = recovery?.source.required ? recovery.text : event.kind === 'gap'
        ? 'Some terminal activity could not be recorded. Check the native session for the full conversation.' : redactCredentials(event.text).text
      // Inform the coordinating lead without replaying this input into the agent
      // that already received it. Its resulting programmatic turn is not native input.
      const recipients = (event.kind !== 'gap' || recovery?.source.required) && group.leadId && group.leadId !== target.id ? [group.leadId] : []
      const draft = { id: eventId, conversationId: group.id, author: observedBy, text, replyTo: null, recipients }
      const now = Date.now(), sequences = numberMessages(state, [draft], now), sequence = sequences.get(eventId)!
      noteProjectReports(state, [draft], sequences, now)
      // The turn touches its agent (spec ruling 2). The person who opened the terminal is guarded by this context's row,
      // which the turn writes: removing that person, or taking away their access, revokes the context (rule b,
      // revokeNativeContexts). Touching the person instead would make one person's terminals in different groups conflict.
      await this.deps.save(tx, loaded, state, this.deps.stamp(), [{ kind: 'agent', key: target.id }])
      await tx.superTabMessage.create({ data: { id: eventId, tabId, conversationId: group.id, sequence,
        author: json(observedBy), source: json({ kind: 'native', phase: event.kind, turnId: event.turnId,
          operator: binding.operator, truncated: event.truncated, interrupted: event.interrupted, ...(recovery ? { recovery: recovery.source } : {}) }),
        text, replyTo: event.kind === 'answer' ? promptId : null, recipientIds: recipients } })
      for (const recipient of recipients) {
        const lead = agent(state, recipient)
        await tx.superTabDelivery.create({ data: { id: stableId(eventId, recipient), tabId, conversationId: group.id,
          messageId: eventId, nativeContextId: contextId, agentId: recipient, machineId: lead.machineId, machineOwnerId: lead.machineOwnerId,
          assignmentId: activeWork(group) && group.assignment?.agentId === recipient ? group.assignment.id : null,
          membershipGeneration: lead.membershipGeneration,
          // What a team host (lib/teamSession.ts) reports is the agent's word, never the person's: it reaches the Lead as
          // from the agent, so a team account cannot put words in the mouth of the person who opened the terminal.
          ...(team
            ? { authorKind: 'agent', authorId: target.id, authorGeneration: target.membershipGeneration }
            : { authorKind: 'person', authorId: binding.operator.id, authorGeneration: binding.operator.membershipGeneration }) } })
      }
      await tx.superTabNativeContext.update({ where: { id: contextId }, data: { lastEventId: eventId } })
      const result = { eventId, sequence }
      await tx.superTabOperation.create({ data: { id: eventId, tabId, actorKey: `agent:${target.id}`, requestHash, revision: 0, result } })
      return result
    })
  }
}

/** Removal followed by rejoining must not revive an old terminal binding. */
export async function revokeNativeContexts(tx: Transaction, before: SuperTabState, after: SuperTabState) {
  const conditions: Prisma.SuperTabNativeContextWhereInput[] = []
  for (const member of before.people) {
    const current = after.people.find(p => p.id === member.id)
    if (!current || current.generation !== member.generation || current.role === 'viewer') conditions.push({ userId: member.id })
  }
  // A removed agent's contexts, and those of an agent given a replacement terminal: they name the old terminal, and its
  // waiting turns are cancelled with them, so a claim racing the change conflicts on their rows (rule b).
  for (const target of before.agents) {
    const current = after.agents.find(a => a.id === target.id)
    if (!current || current.harnessId !== target.harnessId) conditions.push({ agentId: target.id })
  }
  for (const group of before.conversations) {
    const current = after.conversations.find(c => c.id === group.id)
    if (!current || current.archived) conditions.push({ conversationId: group.id })
    // No terminal opens in the Leads conversation (open), so it holds no context to revoke.
    else if (!isLeads(current)) {
      for (const member of after.people) {
        if (!canReadGroup(after, { kind: 'person', userId: member.id, email: member.email }, current)) {
          conditions.push({ conversationId: group.id, userId: member.id })
        }
      }
      const removed = group.agentIds.filter(id => !current.agentIds.includes(id))
      if (removed.length) conditions.push({ conversationId: group.id, agentId: { in: removed } })
    }
  }
  if (conditions.length) {
    const where = { tabId: before.id, revoked: false, OR: conditions }
    const revoked = await tx.superTabNativeContext.findMany({ where, select: { id: true } })
    await tx.superTabNativeContext.updateMany({ where, data: { revoked: true } })
    if (revoked.length) await tx.superTabDelivery.updateMany({ where: { tabId: before.id,
      nativeContextId: { in: revoked.map(r => r.id) }, status: { in: ['queued', 'claimed', 'uncertain'] } },
      data: { status: 'cancelled', holdReason: null, holdSince: null } })
  }
}
