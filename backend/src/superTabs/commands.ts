import { createHash } from 'node:crypto'
import { admitMachineStart, expireRemovals, machineContribution, ownedMachine, type ContributedMachine } from './machines.js'
import { assignAgentDisplayNames } from './agentNames.js'
import { z } from 'zod'
import {
  activeWork, actorKey, agent, agentRole, author, conversation, crossProjectActive, fail, isLeads, person, stableId, syncLeads, numberConversations, nextConversationNumber, renderWorkTask,
  finishWorker, requireWorkerDecisions, reviewing,
  type Actor, type Agent, type Author, type CommandEffects, type Conversation, type SuperTabState,
} from './model.js'
import { routeRecordSchema, routeTitle, startedAs, type RouteCandidate, type RouteDecision, type RouteFinal, type RouteOverride } from './routeRecord.js'
import { routingOverrideSchema } from './routingPolicy.js'
import { agentTarget, askedInSchema, broken, MAX_RULES, RULE_MESSAGE_MS, ruleSchema, ruleTextSchema, startTarget, type RunTarget } from './rules.js'
import { MAX_ATTACHMENTS, type Attachment } from './attachments.js'
import { checkMentions, MAX_MENTIONS, type MentionTarget } from './mentions.js'
import { TERMINAL_KEYS, terminalAlert, terminalRequest, terminalResult, type TerminalRequest } from './terminal.js'
import { agentKind, agentProjectId, agentSetRole, deleteProject, groupProject, inviteLanding, ledProject, manageProject, MAX_ROLES, mutableProjects, placeRules, projectMembers, projectOf, projectRules, projectsOf, readAgent, readConversation, readProject, roleVersion, sameProject, sharedWithLeads, SKILL_SET_NAMES, skillSetOf, type ProjectRole, type RoleKind, type SwarmProject } from './projects.js'

const id = z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/)
const title = z.string().trim().min(1).max(160)
const reason = z.string().trim().min(1).max(300)
const text = z.string().trim().min(1).max(32_000)
const swarmEngine = z.string().min(1).max(80).refine((engine): boolean => engine === 'claude' || engine === 'codex', 'A Swarm agent runs only Claude Code or Codex.')
const configuration = z.object({
  engine: z.string().min(1).max(80), model: z.string().max(200).nullable(),
  effort: z.string().max(80).nullable(), contextWindow: z.number().int().positive().safe().nullable(),
  engineVersion: z.string().max(160).nullable(),
}).strict()
// A full path on the machine that will use it: POSIX (/x), a Windows drive (C:\x or C:/x) or UNC (\\server\share). Never relative or drive-relative (C:x).
const path = z.string().min(1).max(4096)
  .regex(/^(\/|[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/])/, 'Use a full folder path, such as /home/me/work or C:\\Users\\me\\work.')
  .refine(value => !/[\x00-\x1f\x7f]/.test(value), 'A folder path cannot contain control characters.')
const repositoryUrl = z.string().max(4096).refine(value => {
  if (/[\x00-\x20\x7f]/.test(value)) return false
  if (/^git@[^/@:]+:[^@]+$/.test(value)) return true
  try {
    const uri = new URL(value)
    return ['https:', 'http:', 'ssh:', 'git:'].includes(uri.protocol) && !!uri.hostname && !uri.password &&
      (!uri.username || (uri.protocol === 'ssh:' && uri.username === 'git'))
  } catch { return false }
}, 'Share a repository URL without credentials.')
const project = z.object({ cwd: path, repositoryUrl: repositoryUrl.nullable() }).strict()
// Copied Default roles keep the ids lead, dev and review; a role the owner adds gets 12 random hex characters from the client.
const roleId = z.string().regex(/^([0-9a-f]{12}|lead|dev|review)$/)
const role = z.object({ id: roleId, name: z.string().trim().min(1).max(40), kind: z.enum(['lead', 'builder', 'reviewer']),
  text: z.string().min(1).refine(value => Buffer.byteLength(value) <= 65_536, 'A role\'s skill text is at most 64 KB.') }).strict()
const roleSet = z.array(role).min(1).max(MAX_ROLES)
export const startRequestSchema = z.object({
  conversationId: id, machineId: id, engine: swarmEngine, name: title, cwd: path, role: z.enum(['builder', 'reviewer']).optional(), roleId: roleId.optional(),
  worktree: z.boolean(), branchRef: z.string().max(1024).regex(/^refs\/(heads|remotes)\/[^\s\x00-\x1f\x7f]+$/).optional(),
  model: z.string().trim().min(1).max(200).optional(), effort: z.string().trim().min(1).max(80).optional(),
  permissionMode: z.string().min(1).max(80).optional(), codexHome: path.optional(),
  gridModel: z.string().min(1).max(2048).optional(), gridName: z.string().min(1).max(2048).optional(),
  requirements: z.object({ memoryBytes: z.number().int().nonnegative().safe(), diskBytes: z.number().int().nonnegative().safe(),
    maxCpuPercent: z.number().min(0).max(100), tools: z.array(z.string().regex(/^[A-Za-z0-9_.+-]{1,80}$/)).max(20),
    devices: z.array(path).max(20), quotaRequired: z.boolean() }).strict(),
}).strict()
const check = z.object({ description: z.string().trim().min(1).max(1000), independent: z.boolean() }).strict()
const task = z.object({
  goal: z.string().trim().min(1).max(8000), changes: z.string().trim().min(1).max(8000),
  constraints: z.string().trim().min(1).max(8000), owns: z.array(z.string().trim().min(1).max(4096)).min(1).max(40),
}).strict()

export const commandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('machine.contribute'), machineId: id, name: title, cwd: path, scope: z.literal('swarm').optional(), engines: z.array(swarmEngine).min(1).max(2), maxAgents: z.number().int().min(1).max(16),
    ifMissing: z.literal(true).optional() }).strict(),
  z.object({ type: z.literal('machine.pause'), machineId: id, paused: z.boolean() }).strict(),
  z.object({ type: z.literal('machine.remove'), machineId: id }).strict(),
  z.object({ type: z.literal('machine.cleaned'), machineId: id, removalId: id }).strict(),
  z.object({ type: z.literal('localModels.set'), enabled: z.boolean() }).strict(),
  z.object({ type: z.literal('localModels.status'), grid: z.string().min(1).max(160), ready: z.boolean(), error: z.string().trim().max(500).optional() }).strict(),
  z.object({ type: z.literal('tab.rename'), name: title }).strict(),
  z.object({ type: z.literal('tab.project'), machineId: id, project }).strict(),
  z.object({ type: z.literal('tab.pause'), paused: z.boolean() }).strict(),
  z.object({ type: z.literal('tab.routingPolicy'), policy: routingOverrideSchema.nullable() }).strict(),
  z.object({ type: z.literal('rule.set'), projectId: id.optional(), rule: ruleSchema, text: ruleTextSchema, askedIn: askedInSchema.optional() }).strict(),
  z.object({ type: z.literal('rule.remove'), projectId: id.optional(), ruleId: id, askedIn: askedInSchema.optional() }).strict(),
  z.object({ type: z.literal('project.create'), name: title, visibility: z.enum(['public', 'private']), brief: z.string().trim().max(8000).default('') }).strict(),
  z.object({ type: z.literal('project.rename'), projectId: id, name: title }).strict(),
  z.object({ type: z.literal('project.delete'), projectId: id }).strict(),
  z.object({ type: z.literal('project.sharing'), projectId: id, visibility: z.enum(['public', 'private']), memberIds: z.array(id).max(200) }).strict(),
  z.object({ type: z.literal('project.cadence'), projectId: id, minutes: z.union([z.literal(1), z.literal(5), z.literal(15), z.literal(30)]) }).strict(),
  z.object({ type: z.literal('project.report'), projectId: id, throughRevision: z.number().int().nonnegative().safe(), text: text.nullable() }).strict(),
  z.object({ type: z.literal('project.repository'), projectId: id, repositoryUrl }).strict(),
  z.object({ type: z.literal('project.skills'), projectId: id, mode: z.enum(['default', 'orchestration', 'custom']), askedIn: askedInSchema.optional() }).strict(),
  z.object({ type: z.literal('project.roles.create'), projectId: id, roles: roleSet }).strict(),
  z.object({ type: z.literal('project.role.set'), projectId: id, role }).strict(),
  z.object({ type: z.literal('project.role.remove'), projectId: id, roleId }).strict(),
  z.object({ type: z.literal('project.roles.reset'), projectId: id, roles: roleSet }).strict(),
  z.object({ type: z.literal('conversation.create'), projectId: id.optional(), title, brief: z.string().trim().max(8000).optional(), task: task.optional(), reviewOf: id.optional(), checks: z.array(check).max(40) }).strict()
    .refine(c => c.task !== undefined || c.brief !== undefined, 'Provide a task or brief.')
    .refine(c => !c.task || renderWorkTask(c.task).length <= 8000, 'Keep the rendered task within 8,000 characters.'),
  z.object({ type: z.literal('conversation.rename'), conversationId: id, title }).strict(),
  z.object({ type: z.literal('conversation.archive'), conversationId: id, archived: z.boolean() }).strict(),
  z.object({ type: z.literal('agent.add'), conversationId: id, machineId: id, harnessId: id, name: title, configuration, lead: z.boolean(), project: project.optional(), roleId: roleId.optional(), initialMessage: text.optional() }).strict(),
  z.object({ type: z.literal('agent.start'), request: startRequestSchema, routeDecisionId: id.optional(), overrideReason: reason.optional() }).strict(),
  z.object({ type: z.literal('agent.startDispatch'), startId: id }).strict(),
  z.object({ type: z.literal('agent.started'), startId: id, harnessId: id, configuration,
    startedSession: z.object({ sessionId: id, createdAt: z.iso.datetime() }).strict().optional() }).strict(),
  z.object({ type: z.literal('agent.startSettled'), startId: id, warning: z.string().max(2000).nullable() }).strict(),
  z.object({ type: z.literal('agent.startFailed'), startId: id, error: text }).strict(),
  z.object({ type: z.literal('agent.stopLease'), agentId: id, releaseId: id }).strict(),
  z.object({ type: z.literal('agent.remove'), agentId: id, releaseId: id.optional() }).strict(),
  z.object({ type: z.literal('agent.release'), agentId: id, decision: z.enum(['keep', 'stop']) }).strict(),
  z.object({ type: z.literal('agent.sessionClosed'), agentId: id, harnessId: id }).strict(),
  z.object({ type: z.literal('agent.configuration'), previousVersion: id.nullable(), configuration }).strict(),
  z.object({ type: z.literal('agent.rebind'), agentId: id, machineId: id, projectId: id,
    previousHarnessId: id, harnessId: id, configuration,
    startedSession: z.object({ creationId: id, sessionId: id, createdAt: z.iso.datetime() }).strict().optional() }).strict(),
  z.object({ type: z.literal('conversation.agent'), conversationId: id, agentId: id, present: z.boolean(), lead: z.boolean() }).strict(),
  z.object({ type: z.literal('invite.create'), email: z.email().max(320), role: z.enum(['collaborator', 'viewer']), conversationId: id }).strict(),
  z.object({ type: z.literal('invite.revoke'), inviteId: id }).strict(),
  z.object({ type: z.literal('invite.accept'), inviteId: id }).strict(),
  z.object({ type: z.literal('member.remove'), userId: id }).strict(),
  // Text may be empty when the message carries files; applyCommand checks that one of them is there.
  z.object({ type: z.literal('message.send'), conversationId: id, text: z.string().trim().max(32_000), replyTo: id.nullable(), recipientIds: z.array(id).max(16),
    attachmentIds: z.array(id).max(MAX_ATTACHMENTS).optional(), mentions: z.array(id).max(MAX_MENTIONS).optional() }).strict(),
  z.object({ type: z.literal('mention.done'), mentionId: id }).strict(),
  z.object({ type: z.literal('delivery.resolve'), deliveryId: id, resolution: z.enum(['received', 'resend', 'cancel']) }).strict(),
  z.object({ type: z.literal('work.define'), conversationId: id, brief: text.optional(), task: task.optional(), checks: z.array(check).min(1).max(40) }).strict()
    .refine(c => c.task !== undefined || c.brief !== undefined, 'Provide a task or brief.')
    .refine(c => !c.task || renderWorkTask(c.task).length <= 32_000, 'Keep the rendered task within 32,000 characters.'),
  z.object({ type: z.literal('work.assign'), conversationId: id, agentId: id, roleId: roleId.optional(), routeDecisionId: id.optional(), overrideReason: reason.optional() }).strict(),
  z.object({ type: z.literal('work.status'), conversationId: id, assignmentId: id,
    status: z.enum(['working', 'needs_human', 'blocked', 'review', 'done', 'stopped']), result: text.nullable() }).strict(),
  z.object({ type: z.literal('work.cancel'), conversationId: id, assignmentId: id, reason }).strict(),
  z.object({ type: z.literal('route.record'), conversationId: id, decision: routeRecordSchema }).strict(),
  z.object({ type: z.literal('route.override'), decisionId: id, candidateId: z.string().regex(/^c\d{1,2}$/), reason }).strict(),
  z.object({ type: z.literal('route.modelResult'), decisionId: id, startId: id, model: z.string().min(1).max(200), effort: z.string().min(1).max(80) }).strict(),
  z.object({ type: z.literal('agent.screen'), agentId: id, scrollback: z.number().int().min(1).max(200).optional() }).strict(),
  // Text is typed as is, so it carries no control characters; Enter, Esc and the rest are named keys.
  z.object({ type: z.literal('agent.input'), agentId: id, text: z.string().min(1).max(4000).regex(/^[^\x00-\x1f\x7f]*$/, 'Send Enter and other keys as named keys.').optional(),
    keys: z.array(z.enum(TERMINAL_KEYS)).min(1).max(32).optional() }).strict().refine(c => c.text !== undefined || c.keys !== undefined, 'Type text or keys.'),
  ...(['agent.screenResult', 'agent.inputResult'] as const).map(type => z.object({ type: z.literal(type), requestId: id, ok: z.boolean(),
    text: z.string().refine(value => Buffer.byteLength(value) <= 65_536, 'A screen is at most 64 KB.').optional(),
    error: z.string().trim().min(1).max(500).optional() }).strict().refine(c => c.ok || c.error !== undefined, 'Say why the request failed.')),
  z.object({ type: z.literal('agent.alert'), agentId: id, alert: z.enum(['prompt', 'limit', 'model']), active: z.boolean(), resetAt: z.iso.datetime().optional() }).strict(),
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
  /** The message a Lead quotes as the owner's request for a rule or skill mode change, loaded from this tab by the store. */
  askedIn?: { author: Author; source: boolean; createdAt: number }
  /** The newest messages of this conversation before the one being sent, newest first, loaded by the store for `message.send`. */
  recent?: { author: Author; recipients: string[] }[]
  /** A host's receipt, not an elapsed lease, proves that an assignment stopped. */
  confirmedStopped?: boolean
  /** An uncertain receipt and its original message, read transactionally. */
  delivery?: { id: string; conversationId: string; agentId: string; messageId: string; text: string; attachments?: Attachment[] }
  /** The files `message.send` names, each checked by the store: uploaded by this actor to this conversation, and unused. */
  attachments?: Attachment[]
  /** Route decisions this tab recorded in the last hour, counted by the store. */
  recentRoutes?: number
  /** The decision a command names, read from SuperTabRouteDecision by the store. */
  routeDecision?: RouteDecision
  /** Starts on the machine being contributed that the store found abandoned: never contributed, never dispatched,
   *  and older than ABANDONED_START_MS by their operation receipt. */
  abandonedStartIds?: string[]
  /** The request an `agent.screenResult` / `agent.inputResult` answers, read from SuperTabTerminalRequest by the store. */
  terminalRequest?: TerminalRequest
  /** The mention `mention.done` names, read from SuperTabMention by the store. */
  mention?: MentionTarget
}

/** Messages in a row between the Lead and its worker after which the Lead's message is no longer delivered automatically. */
export const PAIR_CHAIN_LIMIT = 6

/** A Lead's automatic delivery to the assigned worker answers the worker's post. Worker posts reach the Lead automatically, so
 * without a bound the two agents would keep answering each other. Count the messages in a row between the pair, newest first,
 * until one is anyone else's or is not addressed to the other (a person's message, a notice, a message to someone else). A normal
 * exchange (brief, plan, approval, report) stays well under the limit; an unattended loop stops at it. Explicit recipients still
 * deliver, so the Lead can always continue on purpose. */
function leadWorkerBounced(recent: CommandContext['recent'] = [], leadId: string, workerId: string): boolean {
  const sentToPartner = (m: NonNullable<CommandContext['recent']>[number]) => m.author.kind === 'agent'
    && (m.author.id === leadId ? m.recipients.includes(workerId) : m.author.id === workerId && m.recipients.includes(leadId))
  const run = recent.findIndex(m => !sentToPartner(m))
  return (run < 0 ? recent.length : run) >= PAIR_CHAIN_LIMIT
}

/** A Reviewer is assigned only review groups, and a review group only a Reviewer. */
function assignable(group: Conversation, worker: Agent): void {
  const reviewer = agentRole(worker) === 'reviewer'
  if (reviewer && !group.reviewOf) fail('REVIEWER_NOT_ASSIGNABLE', 'A Reviewer is assigned only review groups. Assign a Builder.')
  if (!reviewer && group.reviewOf) fail('REVIEW_GROUP', 'A review group is assigned only to a Reviewer.')
}

/** A whole custom set: one lead role (always id lead, so its Lead never loses it), ids and names unique, names ignoring case. */
function roleSetOf(roles: ProjectRole[]): ProjectRole[] {
  const leads = roles.filter(r => r.kind === 'lead')
  if (leads.length !== 1) fail('ROLE_LEAD', 'A role set has exactly one lead role.', 400)
  if (leads[0]!.id !== 'lead') fail('ROLE_LEAD', 'The lead role keeps the id lead.', 400)
  if (new Set(roles.map(r => r.id)).size !== roles.length || new Set(roles.map(r => r.name.toLowerCase())).size !== roles.length) {
    fail('ROLE_NAME', 'Role names and ids are unique in the set.', 400)
  }
  return roles
}
const projectRole = (r: z.infer<typeof role>): ProjectRole => ({ id: r.id, name: r.name, kind: r.kind, version: roleVersion(r.text) })

/** The custom set's role an agent of this kind is started or assigned with. */
function chosenRole(project: SwarmProject, id: string, kind: RoleKind): ProjectRole {
  const chosen = project.roles?.find(r => r.id === id) ?? fail('ROLE_UNAVAILABLE', 'This role is not in this project\'s custom roles.', 400)
  if (chosen.kind !== kind) fail('ROLE_KIND', `${chosen.name} is a role of another kind: ${chosen.kind}, not ${kind}.`, 400)
  return chosen
}

/** Removing roles, or changing one's kind, never leaves a project's agent without the role it runs. */
function keepUsedRoles(state: SuperTabState, project: SwarmProject, next: ProjectRole[]): void {
  const dropped = new Set<string>()
  const users = state.agents.filter(a => {
    if (agentProjectId(state, a) !== project.id) return false
    const used = agentSetRole(state, project, a)
    if (!used || next.some(r => r.id === used.id && r.kind === used.kind)) return false
    dropped.add(used.id)
    return true
  })
  if (users.length) fail('ROLE_IN_USE', `Stop or reassign the ${users.length} agent${users.length === 1 ? '' : 's'} with ${dropped.size === 1 ? 'this role' : 'these roles'} first.`)
}

/** On Custom, an agent whose kind has no role there takes no new work, and the project has no review groups without a reviewer role. */
function requireCustomRole(project: SwarmProject, kind: RoleKind): void {
  if (skillSetOf(project) === 'custom' && !project.roles!.some(r => r.kind === kind)) {
    fail('ROLE_GONE', `This project's Custom skills have no ${kind} role.`)
  }
}

function controls(state: SuperTabState, actor: Actor, conversationId = 'lead'): void {
  const group = readConversation(state, actor, conversationId)
  if (actor.kind === 'agent' && group.leadId !== actor.agentId) {
    fail('LEAD_REQUIRED', 'The coordinating lead owns this action.', 403)
  }
}

/** The repo path an owns entry names, or null for anything else (a phrase, a glob), which is never compared. */
function ownedPath(entry: string): string | null {
  const path = entry.trim().replace(/^\.\//, '').replace(/\/+$/, '')
  return /^[\w.@-]+(\/[\w.@-]+)*$/.test(path) ? path : null
}
const pathsOverlap = (a: string, b: string) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)

/** A project's Lead (Product Manager) leaves only with its project: every other removal path refuses it. */
function protectLead(state: SuperTabState, agentId: string): void {
  const project = ledProject(state, agentId), target = state.agents.find(a => a.id === agentId)
  if (project && target) {
    fail('LEAD_PROTECTED', `${target.displayName ?? target.name} is the Product Manager of project ${project.name}. Delete the project first.`)
  }
}

/** The host proved this session stopped: its slot is free, and a late observation cannot list it as running. */
function releaseHarness(state: SuperTabState, machineId: string, harnessId: string): void {
  state.releasedHarnesses ??= []
  if (!state.releasedHarnesses.some(r => r.machineId === machineId && r.harnessId === harnessId)) state.releasedHarnesses.push({ machineId, harnessId })
  state.harnessReservations = state.harnessReservations?.filter(r => r.machineId !== machineId || r.harnessId !== harnessId)
  const observation = state.machines?.find(m => m.machineId === machineId)?.observation
  if (observation) {
    observation.runningHarnessIds = observation.runningHarnessIds.filter(id => id !== harnessId)
    if (!observation.stoppedHarnessIds.includes(harnessId)) observation.stoppedHarnessIds.push(harnessId)
  }
}

function dropClosing(state: SuperTabState, keep: (request: NonNullable<SuperTabState['closingSessions']>[number]) => boolean): void {
  state.closingSessions = state.closingSessions?.filter(keep)
  if (!state.closingSessions?.length) delete state.closingSessions
}

/** Also checked before returning an idempotent receipt: a retry does not retain
 * access after the person has been removed from a private project. */
export function authorizeCommandAccess(state: SuperTabState, actor: Actor, command: Command, context: Partial<CommandContext> = {}) {
  if (command.type === 'invite.accept' || command.type === 'agent.sessionClosed' || command.type === 'machine.cleaned') return
  // Marking one's own tag done changes only one's own list, so a viewer may do it too.
  if (command.type === 'mention.done') return void author(state, actor)
  const leaving = command.type === 'member.remove' && actor.kind === 'person' && command.userId === actor.userId
  author(state, actor, !leaving)
  // An invitation's group is only where the person lands, and invite.create replaces a deleted one (inviteLanding).
  if ('conversationId' in command && command.type !== 'invite.create') {
    const group = readConversation(state, actor, command.conversationId)
    if (isLeads(group) && command.type !== 'message.send') groupProject(state, group)
  }
  if ('projectId' in command && command.projectId) readProject(state, actor, command.projectId)
  if ('agentId' in command) readAgent(state, actor, command.agentId)
  if (command.type === 'agent.start') readConversation(state, actor, command.request.conversationId)
  if ((command.type === 'rule.set' || command.type === 'rule.remove' || command.type === 'project.skills') && command.askedIn) {
    readConversation(state, actor, command.askedIn.conversationId)
  }
  if ('startId' in command && command.type !== 'route.modelResult') {
    const start = state.starts?.find(s => s.id === command.startId) ?? fail('NOT_FOUND', 'This agent start is unavailable.', 404)
    readConversation(state, actor, start.request.conversationId)
  }
  if (context.delivery) readConversation(state, actor, context.delivery.conversationId)
  if (context.routeDecision) {
    const groupId = command.type === 'agent.start' ? command.request.conversationId
      : 'conversationId' in command ? command.conversationId : null
    if (groupId && groupId !== context.routeDecision.conversationId) fail('ROUTE_MISMATCH', 'This routing decision belongs to another group.')
    readConversation(state, actor, context.routeDecision.conversationId)
  }
}
/** Who may post in a conversation may also upload a file to it. Writer access is checked by `author(state, actor, true)`. */
export function postable(state: SuperTabState, actor: Actor, conversationId: string) {
  const group = open(state, conversationId)
  if (actor.kind === 'agent' && !group.agentIds.includes(actor.agentId)) fail('FORBIDDEN', 'This agent does not participate in the conversation.', 403)
  return group
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
  syncLeads(state)
  numberConversations(state)
  placeRules(state)
  expireRemovals(state, context.now)
  assignAgentDisplayNames(state.agents)
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
  // The host of a removed agent may have left the Swarm with it: the machine owner the request names confirms the close.
  // Anyone else, or a second confirmation, is told the same thing and writes nothing; the store answers an exact retry.
  if (command.type === 'agent.sessionClosed') {
    const request = state.closingSessions?.find(c => c.agentId === command.agentId && c.harnessId === command.harnessId
      && actor.kind === 'person' && c.machineOwnerId === actor.userId) ?? fail('NOT_FOUND', 'This machine has no session waiting to close.', 404)
    dropClosing(state, c => c !== request)
    releaseHarness(state, request.machineId, request.harnessId)
    return effects
  }
  // A removed machine's host deleted the Swarm's folders there. Like a session close, its owner confirms it even after leaving.
  if (command.type === 'machine.cleaned') {
    const owns = (machineId: string, removalId: string, ownerId: string) => machineId === command.machineId && removalId === command.removalId
      && actor.kind === 'person' && ownerId === actor.userId
    const pool = state.machines?.find(m => m.removal && owns(m.machineId, m.removal.id, m.contributorId))
    const cleanup = state.machineCleanups?.find(c => owns(c.machineId, c.removalId, c.machineOwnerId))
    if (!pool && !cleanup) fail('NOT_FOUND', 'This machine has no cleanup waiting.', 404)
    state.machines = state.machines?.filter(m => m !== pool)
    state.machineCleanups = state.machineCleanups?.filter(c => c !== cleanup)
    if (!state.machineCleanups?.length) delete state.machineCleanups
    return effects
  }

  if (command.type === 'mention.done') {
    author(state, actor)
    if (actor.kind !== 'person' || context.mention?.id !== command.mentionId || context.mention.personId !== actor.userId) {
      fail('NOT_FOUND', 'This mention is unavailable.', 404)
    }
    result.mentionId = command.mentionId
    return effects
  }

  const leaving = command.type === 'member.remove' && actor.kind === 'person' && command.userId === actor.userId
  const sender = author(state, actor, !leaving)
  authorizeCommandAccess(state, actor, command, context)
  const rememberAttempt = (group: ReturnType<typeof conversation>) => {
    if (group.assignment) effects.previousAttempts.push(structuredClone({ conversationId: group.id,
      brief: group.brief, checks: group.checks, assignment: group.assignment }))
  }
  const message = (conversationId: string, body: string, recipients: string[] = [], replyTo: string | null = null, source?: Record<string, unknown>,
    attachments?: Attachment[], mentions?: string[]) => {
    effects.messages.push({ id: operationId, conversationId, author: sender, text: body, replyTo, recipients, ...(source ? { source } : {}),
      ...(attachments?.length ? { attachments } : {}), ...(mentions?.length ? { mentions } : {}) })
    result.messageId = operationId
  }
  /** An agent starts or assigns only what the route chose; a person may still do either by hand. */
  const routed = (routeDecisionId?: string) => {
    if (actor.kind === 'agent' && !routeDecisionId) fail('ROUTE_REQUIRED', 'Route this task first, then start or assign the pick with its routeDecisionId.', 400)
  }
  /** Rows the system writes for rules; a Lead cannot quote one as the owner asking. Names, not emails, in the text. */
  const RULE_ROW = { kind: 'rule' }
  /** Any other row the system writes in the actor's name. Without a source, a notice written as the owner read as the owner
   * asking, and a Lead could quote it to change rules (review of #1594). Only `message.send` and an initial message stay plain. */
  const SYSTEM_ROW = { kind: 'system' }
  const who = sender.kind === 'person' ? sender.name.split('@')[0]! : sender.name
  /** A hard rule refuses an agent, unless it carries out what a person chose by hand. A person is not blocked: the
   * command goes through and the group is told. */
  const machineName = (id: string) => state.machines?.find(m => m.machineId === id)?.name ?? id
  const groupRules = (conversationId: string) => projectRules(state, groupProject(state, conversation(state, conversationId)).id)
  const ruled = (target: RunTarget, conversationId: string, done: string, personChose = false) => {
    const why = broken(groupRules(conversationId), target, machineName)
    if (!why) return
    if (actor.kind === 'agent' && !personChose) fail('RULE_BROKEN', `${why} Route again.`, 403)
    result.warnings = [why]
    effects.messages.push({ id: stableId(operationId, 'rule'), conversationId, author: sender, text: `${done} anyway. ${why}`, replyTo: null, recipients: [], source: RULE_ROW })
  }
  /** Rules are per project. Only its owner changes them, or its Lead quoting a message the project owner wrote in its chat in
   * the last day (review of #1586: any owner row, a rule row included, could otherwise be quoted at any time). One message
   * may ask for several rules. The project is the one named, else the quoted chat's, else the actor's: the person's remaining
   * Lead chat (a Swarm of projects has no 'lead' chat; on backend v1.3.14 looking for it refused every Lead's rule) or the
   * agent's own project. */
  const ruleChange = (askedIn: { conversationId: string; messageId: string } | undefined, projectId?: string): SwarmProject => {
    const quoted = askedIn && groupProject(state, conversation(state, askedIn.conversationId))
    const landing = actor.kind === 'agent' ? agentProjectId(state, agent(state, actor.agentId)) : inviteLanding(state)
    const project = projectId ? projectOf(state, projectId) : quoted ? quoted
      : actor.kind === 'agent' ? projectOf(state, landing!) : landing ? groupProject(state, conversation(state, landing)) : fail('NOT_FOUND', 'This Swarm has no project.', 404)
    readProject(state, actor, project.id)
    if (actor.kind === 'person' && actor.userId === project.ownerId) return project
    if (actor.kind !== 'agent' || conversation(state, project.leadConversationId).leadId !== actor.agentId) {
      fail('OWNER_REQUIRED', 'Only the project owner, or its Lead passing on the owner\'s request, changes its rules.', 403)
    }
    const asked = askedIn && context.askedIn
    if (!asked || quoted!.id !== project.id || asked.author.kind !== 'person' || asked.author.id !== project.ownerId || asked.source
      || context.now - asked.createdAt > RULE_MESSAGE_MS) {
      fail('OWNER_MESSAGE_REQUIRED', 'Only the project owner sets its rules; quote a chat message the project owner wrote in its chat in the last day asking for this change.', 403)
    }
    return project
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
  /** Deleting its project is the only removal that takes a Lead. `close: false` when its host already closed the session. */
  const removeAgent = (target: Agent, { lead = false, close = true } = {}) => {
    if (!lead) protectLead(state, target.id)
    if (close && !state.closingSessions?.some(c => c.agentId === target.id && c.harnessId === target.harnessId)) {
      (state.closingSessions ??= []).push({ agentId: target.id, machineId: target.machineId, harnessId: target.harnessId, machineOwnerId: target.machineOwnerId })
    }
    state.agents = state.agents.filter(a => a.id !== target.id)
    effects.cancelledAgents.push(target.id)
    for (const group of state.conversations) {
      group.agentIds = group.agentIds.filter(a => a !== target.id)
      if (group.leadId === target.id) group.leadId = null
      if (group.assignment?.agentId === target.id && activeWork(group)) group.assignment.status = 'reconciling'
    }
  }

  /** Takes a machine out of the Swarm with every agent on it (machine.remove, or its owner leaving): each agent is removed
   *  like one agent, its pending starts fail, routing rules lose it, and a contributed machine stays paused and cleaning
   *  until its host deletes the Swarm's folders there (spec 2026-10-23-remove-machine.md). */
  const removeMachine = (machineId: string, pool: ContributedMachine | undefined, members: Agent[], how: (machine: string) => string) => {
    const pending = state.starts?.filter(s => s.request.machineId === machineId && !s.harnessId && !s.error) ?? []
    // A launch already under way would arrive with nowhere to go; it finishes in moments.
    if (pending.some(s => s.dispatched)) fail('STARTS_PENDING', 'An agent is starting on this machine. Try again in a moment.')
    for (const start of pending) {
      start.error = 'Its machine was removed from the Swarm.'
      effects.messages.push({ id: stableId(operationId, 'start', start.id), conversationId: start.request.conversationId, author: sender,
        text: `${start.request.name} will not start: its machine was removed from the Swarm.`, replyTo: null, recipients: [], source: SYSTEM_ROW })
    }
    const removed = new Set(members.map(a => a.id))
    const affected = state.conversations.filter(group => group.agentIds.some(a => removed.has(a))
      || (group.leadId && removed.has(group.leadId)) || (group.assignment && removed.has(group.assignment.agentId)))
      .map(group => ({ group, names: members.filter(a => group.agentIds.includes(a.id) || group.leadId === a.id || group.assignment?.agentId === a.id)
        .map(a => a.displayName ?? a.name), task: !!group.assignment && removed.has(group.assignment.agentId) && activeWork(group) }))
    for (const target of members) removeAgent(target)
    if (pool) {
      // Paused, so routing in clients that do not know removals stops offering it too.
      pool.removal = { id: operationId, state: 'cleaning', requestedAt: new Date(context.now).toISOString() }
      pool.paused = true
    }
    // Its capacity left with it: no slot there is held for anyone now.
    state.harnessReservations = state.harnessReservations?.filter(r => r.machineId !== machineId)
    state.releasedHarnesses = state.releasedHarnesses?.filter(r => r.machineId !== machineId)
    const machine = pool?.name ?? 'a machine'
    // Routing rules naming it lose it; a machines rule left with none is removed, and its project's chat is told.
    for (const rule of state.rules ?? []) {
      if (rule.rule.kind !== 'machines' || !rule.rule.machineIds.includes(machineId)) continue
      rule.rule.machineIds = rule.rule.machineIds.filter(m => m !== machineId)
      // The owner's words stay as they are; the row says what the rule allows now.
      const project = projectsOf(state).find(p => p.id === rule.projectId)
      if (project) effects.messages.push({ id: stableId(operationId, 'rule', machineId, rule.id), conversationId: project.leadConversationId, author: sender,
        text: rule.rule.machineIds.length ? `Rule changed: ${machine} left the Swarm, so "${rule.text}" now allows only ${rule.rule.machineIds.map(machineName).join(', ')}.`
          : `Rule removed: ${rule.text} Its only machine, ${machine}, left the Swarm.`, replyTo: null, recipients: [], source: RULE_ROW })
    }
    state.rules = state.rules?.filter(r => r.rule.kind !== 'machines' || r.rule.machineIds.length)
    if (!state.rules?.length) delete state.rules
    for (const { group, names, task } of affected) {
      const lead = group.leadId && group.agentIds.includes(group.leadId) ? group.leadId : null
      const join = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0]
      effects.messages.push({ id: stableId(operationId, 'machine-removed', machineId, group.id), conversationId: group.id, author: sender,
        text: `${how(machine)}, and ${join} with it.${task ? ` Its task "${group.title}" needs to be assigned again or closed.` : ''}`,
        replyTo: null, recipients: lead ? [lead] : [], source: SYSTEM_ROW })
    }
    return removed
  }

  /** Projects in one Swarm changed the same code without knowing it (2026-10-23). When a task is created, defined or assigned,
   *  its Leads hear once per pair of tasks that it owns code another shared project's active task owns too. */
  const alertOverlaps = (group: Conversation) => {
    const project = groupProject(state, group)
    const mine = (group.task?.owns ?? []).flatMap(entry => ownedPath(entry) ?? [])
    if (!mine.length || !sharedWithLeads(project)) return
    state.overlapAlerts = state.overlapAlerts?.filter(pair => pair.split(':').every(id => state.conversations.some(c => c.id === id)))
    const leadOf = (p: SwarmProject) => state.agents.find(a => a.id === conversation(state, p.leadConversationId).leadId)
    const named = (a: Agent | undefined) => a ? a.displayName ?? a.name : 'no Lead'
    for (const other of state.conversations.filter(crossProjectActive)) {
      const theirs = groupProject(state, other)
      if (theirs.id === project.id || !sharedWithLeads(theirs)) continue
      const owned = (other.task?.owns ?? []).flatMap(entry => ownedPath(entry) ?? [])
      const shared = mine.filter(a => owned.some(b => pathsOverlap(a, b)))
      const pair = [group.id, other.id].sort().join(':')
      if (!shared.length || state.overlapAlerts?.includes(pair)) continue
      (state.overlapAlerts ??= []).push(pair)
      const ours = leadOf(project), their = leadOf(theirs)
      effects.messages.push({ id: stableId(operationId, 'overlap', pair), conversationId: state.leadsConversationId!, author: sender,
        text: `"${group.title}" (${project.name}, ${named(ours)}) and "${other.title}" (${theirs.name}, ${named(their)}) both change `
          + `${shared.join(', ')}. Agree an order or a split here, then each tell your own project.`,
        replyTo: null, recipients: [ours, their].flatMap(a => a && !(actor.kind === 'agent' && a.id === actor.agentId) ? [a.id] : []),
        source: { kind: 'overlap', conversationIds: [group.id, other.id] } })
    }
  }

  /** Changing or clearing the Lead of a project's Lead conversation would let it be stopped next. */
  const keepLead = (group: Conversation, next: string | null) => {
    if (group.leadId && group.leadId !== next && group.id === groupProject(state, group).leadConversationId) protectLead(state, group.leadId)
  }

  switch (command.type) {
    case 'agent.screen':
    case 'agent.input': {
      const { effect, message } = terminalRequest(state, actor, sender, operationId, context.now, command)
      effects.terminal = effect
      result.requestId = operationId
      if (message) effects.messages.push(message)
      break
    }
    case 'agent.screenResult':
    case 'agent.inputResult':
      effects.terminal = terminalResult(state, actor, context.terminalRequest, command)
      break
    case 'agent.alert': {
      effects.messages.push(...terminalAlert(state, actor, sender, operationId, context.now, command))
      break
    }
    case 'project.report': {
      const project = readProject(state, actor, command.projectId)
      const group = conversation(state, project.leadConversationId)
      if (actor.kind !== 'agent' || group.leadId !== actor.agentId) fail('LEAD_REQUIRED', 'The project lead writes its progress updates.', 403)
      if (project.progress) project.progress.summarizedRevision = Math.max(project.progress.summarizedRevision,
        Math.min(command.throughRevision, project.progress.dirtyRevision))
      if (command.text) message(group.id, command.text, [], null, { kind: 'project-report' })
      break
    }
    case 'project.repository': {
      // Desktop once dropped the daemon's scheme-less remote, so some leads recorded a folder without an address and
      // other machines could not clone it. Its owner or lead fills it in; an address already shared is never replaced.
      const project = readProject(state, actor, command.projectId)
      author(state, actor, true)
      const group = conversation(state, project.leadConversationId)
      if (!(actor.kind === 'person' && actor.userId === project.ownerId) && !(actor.kind === 'agent' && group.leadId === actor.agentId)) {
        fail('PROJECT_OWNER_REQUIRED', 'Only the project owner or its lead can share its repository.', 403)
      }
      // On a tab from before projects this is `state.project` itself (projectsOf).
      const repository = project.repository ?? fail('PROJECT_FOLDER_REQUIRED', 'Start this project’s lead in its repository first.')
      if (repository.repositoryUrl && repository.repositoryUrl !== command.repositoryUrl) {
        fail('PROJECT_REPOSITORY_SET', 'This project already shares another repository.')
      }
      repository.repositoryUrl = command.repositoryUrl
      break
    }
    case 'project.create': {
      if (actor.kind !== 'person') fail('HUMAN_REQUIRED', 'A person creates a project and chooses its lead.', 403)
      if (state.paused) fail('PAUSED', 'New work is paused in this swarm.')
      const projects = mutableProjects(state)
      if (projects.length >= 100) fail('PROJECTS_FULL', 'A swarm can have up to 100 projects.')
      const leadConversationId = `project-${operationId}`
      projects.push({ id: operationId, name: command.name, ownerId: actor.userId, leadConversationId,
        visibility: command.visibility, members: [], updateMinutes: 5, skillMode: 'default' })
      state.conversations.push({ id: leadConversationId, projectId: operationId, title: 'Lead', leadId: null,
        agentIds: [], archived: false, brief: command.brief, checks: [], assignment: null, lastMessageSequence: 0 })
      result.projectId = operationId
      result.conversationId = leadConversationId
      break
    }
    case 'project.skills': {
      // Only the project owner, or that project's Lead quoting a chat message the project owner wrote in the last day. The
      // same check as ruleChange, but against the project owner: the Swarm owner does not choose another person's skills.
      const project = readProject(state, actor, command.projectId)
      author(state, actor, true)
      if (!(actor.kind === 'person' && actor.userId === project.ownerId)) {
        if (actor.kind !== 'agent' || conversation(state, project.leadConversationId).leadId !== actor.agentId) {
          fail('PROJECT_OWNER_REQUIRED', 'Only the project owner, or its Lead passing on the owner\'s request, changes its skills.', 403)
        }
        const asked = command.askedIn && context.askedIn
        if (!asked || groupProject(state, conversation(state, command.askedIn!.conversationId)).id !== project.id
          || asked.author.kind !== 'person' || asked.author.id !== project.ownerId || asked.source
          || context.now - asked.createdAt > RULE_MESSAGE_MS) {
          fail('OWNER_MESSAGE_REQUIRED', 'Only the project owner changes its skills; quote a chat message the project owner wrote in the last day asking for this change.', 403)
        }
      }
      if (command.mode === 'custom' && !project.roles) fail('ROLES_MISSING', 'Create the project\'s custom roles first.')
      if (skillSetOf(project) === command.mode) break
      mutableProjects(state)
      const changed = projectOf(state, project.id)
      changed.skillSet = command.mode
      // Older clients know only skillMode: on Custom they run the Default text, the closest to the copied set.
      changed.skillMode = command.mode === 'custom' ? 'default' : command.mode
      message(project.leadConversationId, `Skills: ${SKILL_SET_NAMES[command.mode]}`, [], null, SYSTEM_ROW)
      if (command.mode !== 'custom') break
      for (const target of state.agents.filter(a => agentProjectId(state, a) === project.id && !agentSetRole(state, changed, a))) {
        const group = state.conversations.find(c => !c.archived && !isLeads(c) && c.agentIds.includes(target.id)) ?? conversation(state, project.leadConversationId)
        effects.messages.push({ id: stableId(operationId, 'role-gone', target.id), conversationId: group.id, author: sender, recipients: [target.id], replyTo: null,
          text: `Custom has no ${agentKind(state, target) === 'reviewer' ? 'Reviewer' : 'Engineer'} role for ${target.displayName ?? target.name}. `
            + 'Finish your current work; you take no new work.', source: SYSTEM_ROW })
      }
      break
    }
    case 'project.roles.create': {
      const project = manageProject(state, actor, command.projectId)
      if (project.roles) fail('ROLES_EXIST', 'This project already has custom roles.')
      project.roles = roleSetOf(command.roles.map(projectRole))
      break
    }
    case 'project.role.set': {
      const project = manageProject(state, actor, command.projectId)
      const roles = project.roles ?? fail('ROLES_MISSING', 'Create the project\'s custom roles first.')
      const existing = roles.find(r => r.id === command.role.id)
      if (existing?.kind === 'lead' && command.role.kind !== 'lead') fail('ROLE_LEAD', 'The lead role stays a lead role.', 400)
      if (!existing && roles.length >= MAX_ROLES) fail('ROLES_FULL', `A project has at most ${MAX_ROLES} roles.`)
      const next = roleSetOf(existing ? roles.map(r => r === existing ? projectRole(command.role) : r) : [...roles, projectRole(command.role)])
      keepUsedRoles(state, project, next)
      project.roles = next
      break
    }
    case 'project.role.remove': {
      const project = manageProject(state, actor, command.projectId)
      const roles = project.roles ?? fail('ROLES_MISSING', 'Create the project\'s custom roles first.')
      const removed = roles.find(r => r.id === command.roleId) ?? fail('NOT_FOUND', 'This role is unavailable.', 404)
      if (removed.kind === 'lead') fail('ROLE_LEAD', 'The lead role cannot be removed.', 400)
      const next = roles.filter(r => r !== removed)
      keepUsedRoles(state, project, next)
      project.roles = next
      break
    }
    case 'project.roles.reset': {
      const project = manageProject(state, actor, command.projectId)
      if (!project.roles) fail('ROLES_MISSING', 'Create the project\'s custom roles first.')
      const next = roleSetOf(command.roles.map(projectRole))
      keepUsedRoles(state, project, next)
      project.roles = next
      break
    }
    case 'project.rename': {
      const project = manageProject(state, actor, command.projectId)
      project.name = command.name
      break
    }
    case 'project.delete': {
      // Its owner confirmed a permanent delete, so the project takes its own agents with it, its Lead included, and their
      // hosts close their sessions.
      const project = manageProject(state, actor, command.projectId)
      for (const target of state.agents.filter(a => agentProjectId(state, a) === project.id)) removeAgent(target, { lead: true })
      deleteProject(state, actor, command.projectId)
      break
    }
    case 'project.sharing': {
      const project = manageProject(state, actor, command.projectId)
      project.members = projectMembers(state, command.memberIds)
      project.visibility = command.visibility
      break
    }
    case 'project.cadence': {
      const project = readProject(state, actor, command.projectId)
      if (actor.kind !== 'person') fail('HUMAN_REQUIRED', 'A person chooses the update cadence.', 403)
      mutableProjects(state)
      projectOf(state, project.id).updateMinutes = command.minutes
      break
    }
    case 'tab.project': {
      controls(state, actor)
      if (actor.kind === 'person') owner(state, actor)
      if (state.project) fail('PROJECT_SET', 'This Super Tab already has a project.')
      state.project = { machineId: command.machineId, ...command.project }
      // A new Swarm stores its first project, and stored projects are read instead of `state.project` (projectsOf).
      const first = state.projects?.find(p => p.id === 'lead')
      if (first) first.repository ??= { ...state.project }
      break
    }
    case 'machine.contribute': {
      if (command.engines.some(engine => engine !== 'claude' && engine !== 'codex')) fail('SWARM_ENGINE', 'A Swarm machine runs only Claude Code or Codex.', 400)
      if (actor.kind !== 'person' || context.contribution?.machineOwnerId !== actor.userId) fail('OWNER_REQUIRED', 'Only the machine owner can contribute it.', 403)
      const contributor = person(state, actor.userId)
      state.machines ??= []
      // The owner's host adds the machine its Lead runs on by itself (cli/src/superTabs/host.ts). It only fills a gap:
      // on 2026-10-22 Ken's Mac ran the Lead of a Swarm it was never added to, so its starts bypassed the machine's slots.
      // A late cleanup would delete the new contribution's folders.
      const cleaning = state.machines.some(m => m.machineId === command.machineId && m.removal)
        || !!state.machineCleanups?.some(c => c.machineId === command.machineId)
      if (command.ifMissing) {
        if (actor.userId !== state.ownerId) fail('OWNER_REQUIRED', 'Only the Swarm owner adds a machine automatically.', 403)
        if (cleaning || state.machines.some(m => m.machineId === command.machineId)) break
      }
      if (cleaning) fail('MACHINE_CLEANING', 'This machine is still cleaning up after its removal. Add it again once that finishes.')
      if (!state.machines.some(m => m.machineId === command.machineId) && state.machines.length >= 32) fail('MACHINES_FULL', 'A Super Tab can have up to 32 contributed machines.')
      // Before a machine was contributed, a Lead's start on it that never dispatched was left pending for good (12 on Ken's
      // Mac that day) and refused every contribution. Those finish as failed; a dispatched or recent start still blocks.
      const abandoned = (state.starts ?? []).filter(s => context.abandonedStartIds?.includes(s.id))
      for (const start of abandoned) start.error = 'Abandoned before it started.'
      // Each project's Lead chat hears once about its own starts, whichever of its groups asked.
      const byLeadChat = new Map<string, Set<string>>()
      for (const start of abandoned) {
        const group = state.conversations.find(c => c.id === start.request.conversationId)
        const leadChat = group && groupProject(state, group).leadConversationId
        if (leadChat && state.conversations.some(c => c.id === leadChat)) byLeadChat.set(leadChat, (byLeadChat.get(leadChat) ?? new Set()).add(start.request.name))
      }
      for (const [leadChat, names] of byLeadChat) {
        effects.messages.push({ id: stableId(operationId, leadChat), conversationId: leadChat, author: sender, replyTo: null, recipients: [], source: SYSTEM_ROW,
          text: `${[...names].join(', ')} never started and will not start now. Start ${names.size > 1 ? 'them' : 'it'} again if still needed.` })
      }
      if (state.starts?.some(s => s.request.machineId === command.machineId && (!s.harnessId || (s.poolGeneration && !s.poolSettled)) && !s.error)) fail('STARTS_PENDING', 'Reconcile pending starts before changing this contribution.')
      state.machines = state.machines.filter(m => m.machineId !== command.machineId)
      state.machines.push({ machineId: command.machineId, name: command.name, cwd: command.cwd, engines: [...new Set(command.engines)], maxAgents: command.maxAgents,
        ...(command.scope ? { scope: command.scope } : {}),
        contributorId: actor.userId, membershipGeneration: contributor.generation, generation: operationId, paused: false })
      break
    }
    case 'machine.pause': {
      const pool = machineContribution(state, command.machineId) ?? fail('NOT_FOUND', 'This machine has not been contributed.', 404)
      if (actor.kind !== 'person' || actor.userId !== pool.contributorId) fail('OWNER_REQUIRED', 'Only its contributor can change this machine.', 403)
      if (pool.removal) fail('MACHINE_REMOVED', 'This machine is being removed from the Swarm.')
      pool.paused = command.paused
      break
    }
    case 'machine.remove': {
      // Its owner takes the machine out with every Swarm agent on it, each removed like one agent (its host closes the
      // session; a Product Manager refuses it, protectLead). A contributed machine then stays listed, paused, while its
      // host deletes the Swarm's folders there (spec 2026-10-23-remove-machine.md); one with only shared agents goes at once.
      if (actor.kind !== 'person') fail('HUMAN_REQUIRED', 'A person removes a machine from the Swarm.', 403)
      const { pool, members } = ownedMachine(state, actor, command.machineId)
      if (pool?.removal) fail('MACHINE_REMOVED', 'This machine is already being removed from the Swarm.')
      const removed = removeMachine(command.machineId, pool, members, machine => `${who} removed ${machine} from the Swarm`)
      if (pool) result.removalId = operationId
      result.removedAgents = [...removed]
      break
    }
    case 'localModels.set': {
      // An add-on the owner turns on: its grid is theirs, and nothing calls grid until they do.
      if (actor.kind !== 'person' || actor.userId !== state.ownerId) fail('OWNER_REQUIRED', 'Only the Swarm owner turns Local models on or off.', 403)
      const current = state.localModels
      state.localModels = current
        ? { ...current, enabled: command.enabled }
        : { grid: swarmGridName(state.id), enabled: command.enabled }
      if (command.enabled && !current?.ready) { delete state.localModels.ready; delete state.localModels.error }
      result.grid = state.localModels.grid
      break
    }
    case 'localModels.status': {
      // The owner's host reports the grid it created and keeps in step with the Swarm's people.
      if (actor.kind !== 'person' || actor.userId !== state.ownerId) fail('OWNER_REQUIRED', 'Only the Swarm owner\'s computer reports its grid.', 403)
      const current = state.localModels
      if (!current || current.grid !== command.grid) fail('NOT_FOUND', 'This Swarm has no such grid.', 404)
      current.ready = command.ready
      if (command.error) current.error = command.error
      else delete current.error
      break
    }
    case 'tab.rename':
      // Writable people manage the swarm even when its original project is
      // gone. Agents retain the existing Lead-conversation authority.
      if (actor.kind === 'agent') controls(state, actor)
      state.name = command.name
      break
    case 'tab.pause':
      if (actor.kind === 'agent') controls(state, actor)
      state.paused = command.paused
      break
    case 'tab.routingPolicy':
      if (actor.kind !== 'person' || actor.userId !== state.ownerId) fail('OWNER_REQUIRED', 'Only the Super Tab owner can change its routing policy.', 403)
      if (command.policy && Object.keys(command.policy).length) state.routingPolicy = command.policy
      else delete state.routingPolicy
      break
    case 'rule.set': {
      const project = ruleChange(command.askedIn, command.projectId)
      // A project has one machines list; a new one replaces it.
      const rules = (state.rules ?? []).filter(r => r.projectId !== project.id || command.rule.kind !== 'machines' || r.rule.kind !== 'machines')
      if (rules.filter(r => r.projectId === project.id).length >= MAX_RULES) fail('RULES_FULL', `This project has ${MAX_RULES} rules. Remove one first.`)
      state.rules = [...rules, { id: operationId, projectId: project.id, rule: command.rule, text: command.text, askedBy: project.ownerId,
        askedIn: command.askedIn ?? null, addedBy: actorKey(actor), createdAt: new Date(context.now).toISOString() }]
      result.ruleId = operationId
      message(project.leadConversationId, `Rule added: ${command.text}`, [], null, RULE_ROW)
      break
    }
    case 'rule.remove': {
      const found = state.rules?.find(r => r.id === command.ruleId)
      const project = ruleChange(command.askedIn, command.projectId ?? found?.projectId)
      const rule = found?.projectId === project.id ? found : fail('NOT_FOUND', 'This project has no such rule.', 404)
      state.rules = state.rules!.filter(r => r.id !== rule.id)
      if (!state.rules.length) delete state.rules
      message(project.leadConversationId, `Rule removed: ${rule.text}`, [], null, RULE_ROW)
      break
    }
    case 'conversation.create': {
      const brief = command.task ? renderWorkTask(command.task) : command.brief ?? ''
      const project = readProject(state, actor, command.projectId ??
        (actor.kind === 'agent' ? agentProjectId(state, agent(state, actor.agentId)) : 'lead'))
      controls(state, actor, project.leadConversationId)
      if (state.paused) fail('PAUSED', 'New work is paused in this Super Tab.')
      if (actor.kind === 'agent' && (!brief || !command.checks.length)) {
        fail('BRIEF_REQUIRED', 'Delegated work needs a brief and acceptance checks.', 400)
      }
      const leadId = conversation(state, project.leadConversationId).leadId
      if (command.reviewOf) {
        const reviewed = open(state, command.reviewOf)
        if (reviewed.id === project.leadConversationId || reviewed.reviewOf || groupProject(state, reviewed).id !== project.id) {
          fail('REVIEW_TARGET', 'A review group reviews one build group of the same project.', 400)
        }
        requireCustomRole(project, 'reviewer')
      }
      const number = nextConversationNumber(state)
      state.conversations.push({ id: operationId, ...(state.projects ? { projectId: project.id } : {}),
        number, title: command.title, leadId, agentIds: leadId ? [leadId] : [],
        archived: false, brief, ...(command.task ? { task: command.task } : {}), ...(command.reviewOf ? { reviewOf: command.reviewOf } : {}),
        assignment: null, lastMessageSequence: 0,
        checks: command.checks.map((c, i) => ({ ...c, id: stableId(operationId, String(i)), evidence: null, passedBy: null })),
      })
      result.conversationId = operationId
      result.number = number
      if (brief) message(operationId, brief, [], null, SYSTEM_ROW)
      break
    }
    case 'conversation.rename':
      controls(state, actor, command.conversationId)
      open(state, command.conversationId).title = command.title
      break
    case 'conversation.archive': {
      controls(state, actor, command.conversationId)
      const group = conversation(state, command.conversationId)
      if (group.id === groupProject(state, group).leadConversationId) fail('LEAD_CONVERSATION', 'The Lead conversation stays available.')
      if (command.archived && activeWork(group)) fail('WORK_ACTIVE', 'Resolve the active assignment before archiving this conversation.')
      group.archived = command.archived
      break
    }
    case 'agent.add': {
      if (!['claude', 'codex'].includes(command.configuration.engine)) fail('SWARM_ENGINE', 'A Swarm agent runs only Claude Code or Codex.', 400)
      controls(state, actor, command.conversationId)
      const group = open(state, command.conversationId)
      const project = groupProject(state, group)
      if (state.projects && group.id === project.leadConversationId && command.lead && command.project) {
        project.repository ??= { machineId: command.machineId, ...command.project }
      }
      if (group.id === 'lead' && command.lead && command.project && !state.project) {
        state.project = { machineId: command.machineId, ...command.project }
      }
      const grant = context.contribution ?? fail('HOST_REQUIRED', 'This session must be explicitly shared by an authorized contributor.', 403)
      const contributor = person(state, grant.contributorId)
      if (contributor.role === 'viewer') fail('READ_ONLY', 'A viewer cannot contribute agents.', 403)
      const agentId = stableId(command.machineId, command.harnessId)
      const existing = state.agents.find(a => a.id === agentId)
      if (existing) sameProject(state, group, existing)
      // A New Harness chooses its role here: a reviewer role joins it as a Reviewer, a builder role as an Engineer,
      // and a lead role only as the Lead. Later changes go through work.assign. An agent already in the Swarm keeps
      // the kind it runs, so a retry is checked against that.
      const roleKind = command.roleId ? project.roles?.find(r => r.id === command.roleId)?.kind : undefined
      const kind = existing ? agentKind(state, existing) : command.lead ? 'lead' : roleKind === 'reviewer' ? 'reviewer' : 'builder'
      const chosen = command.roleId ? chosenRole(project, command.roleId, kind) : null
      if (existing?.workDecision === 'stop' && command.lead) fail('STOP_REQUESTED', 'This worker is stopping. Wait for its execution host.')
      if (existing && agentRole(existing) === 'reviewer' && command.lead) fail('REVIEWER_NOT_LEAD', 'A Reviewer reviews work and cannot lead a group.')
      if (!existing) reserveHarnessSlot(state, command.machineId, command.harnessId, operationId)
      // Added back before its host closed it: the session stays open.
      if (!existing) dropClosing(state, c => c.machineId !== command.machineId || c.harnessId !== command.harnessId)
      if (!existing) state.agents.push({ id: agentId, machineId: command.machineId, harnessId: command.harnessId,
        ...(state.projects ? { projectId: project.id } : {}),
        machineOwnerId: grant.machineOwnerId, contributorId: grant.contributorId, membershipGeneration: contributor.generation,
        hostGrant: grant.hostGrant ?? null,
        name: command.name, configuration: command.configuration, configurationVersion: operationId,
        ...(chosen?.kind === 'reviewer' ? { role: 'reviewer' as const } : {}), ...(chosen ? { roleId: chosen.id } : {}) })
      if (existing && (existing.machineOwnerId !== grant.machineOwnerId || existing.contributorId !== grant.contributorId)) {
        fail('ALREADY_SHARED', 'This session already has a contributor. Use the existing tab agent.')
      }
      if (existing && (existing.hostGrant ?? null) !== (grant.hostGrant ?? null)) {
        fail('CONTRIBUTION_REVOKED', 'Reconcile and remove this old contribution before adding it under the new machine share.', 403)
      }
      if (!group.agentIds.includes(agentId)) group.agentIds.push(agentId)
      if (command.lead) {
        keepLead(group, agentId)
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
      routed(command.routeDecisionId)
      requireWorkerDecisions(state, actor, open(state, command.request.conversationId))
      if (state.paused) fail('PAUSED', 'New work is paused in this Super Tab.')
      if (!['claude', 'codex'].includes(command.request.engine)) {
        fail('SWARM_ENGINE', 'A Swarm agent runs only Claude Code or Codex.', 400)
      }
      const home = groupProject(state, conversation(state, command.request.conversationId))
      if (command.request.roleId) chosenRole(home, command.request.roleId, command.request.role ?? 'builder')
      else requireCustomRole(home, command.request.role ?? 'builder')
      // The Lead's account has machines the Swarm never prepared (no clone of the project), so a Lead may start only where the
      // Swarm already lists a machine: a contributed one, or one an agent of the Swarm runs on. A person's start may name any
      // machine of theirs, because the first Lead is created before anything is listed.
      if (actor.kind === 'agent' && !state.machines?.some(m => m.machineId === command.request.machineId)
        && !state.agents.some(a => a.machineId === command.request.machineId)) fail('MACHINE_NOT_LISTED', 'Add this machine to the Swarm first.', 403)
      const grant = context.contribution ?? fail('HOST_REQUIRED', 'Choose a machine shared with the contributor.', 403)
      const contributor = person(state, grant.contributorId)
      if (contributor.role === 'viewer') fail('READ_ONLY', 'A viewer cannot start agents.', 403)
      state.starts ??= []
      if (state.starts.filter(s => !s.harnessId && !s.error).length >= 32) {
        fail('STARTS_PENDING', 'Reconcile pending agent starts before adding more.')
      }
      const pool = admitMachineStart(state, command.request, context.now)
      state.starts.push({ ...(pool ? { poolGeneration: pool.generation } : {}), ...(command.routeDecisionId ? { routeDecisionId: command.routeDecisionId } : {}), id: operationId, creationId: `super-${operationId}`, actorKey: actorKey(actor),
        contributorId: contributor.id, membershipGeneration: contributor.generation, machineOwnerId: grant.machineOwnerId,
        hostGrant: grant.hostGrant ?? null, request: command.request, harnessId: null, dispatched: false, error: null })
      result.startId = operationId
      let personChose = false
      if (command.routeDecisionId) {
        const r = command.request
        const model = r.model ?? 'default', effort = r.effort ?? 'default'
        const { decision, expected, override } = linkDecision(r.conversationId,
          c => c.kind === 'new' && c.machineId === r.machineId && c.engine === r.engine && c.model === model && c.effort === effort
            && (c.gridModel ?? null) === (r.gridModel ?? null) && (c.gridName ?? null) === (r.gridName ?? null),
          () => ({ kind: 'new', startId: operationId, machineId: r.machineId, engine: r.engine, model, effort,
            ...(r.gridModel && r.gridName ? { gridModel: r.gridModel, gridName: r.gridName } : {}) }), command.overrideReason)
        if (override) message(r.conversationId, `Lead started ${r.name} instead of ${expected.title}. Reason: ${override.reason}`, [], null,
          { kind: 'route-override', decisionId: decision.id, by: 'lead' })
        personChose = !override && decision.override?.by === 'person'
      }
      ruled(startTarget(command.request), command.request.conversationId, `${who} started ${command.request.name}`, personChose)
      break
    }
    case 'agent.startDispatch':
    case 'agent.started':
    case 'agent.startSettled':
    case 'agent.startFailed': {
      const start = state.starts?.find(s => s.id === command.startId) ?? fail('NOT_FOUND', 'This agent start is unavailable.', 404)
      if (start.actorKey !== actorKey(actor)) fail('FORBIDDEN', 'Only the initiating lead can complete this start.', 403)
      if (person(state, start.contributorId).generation !== start.membershipGeneration) fail('FORBIDDEN', 'This contribution was withdrawn.', 403)
      controls(state, actor, start.request.conversationId)
      if (command.type === 'agent.startDispatch') {
        if (state.paused) fail('PAUSED', 'New work is paused in this Super Tab.')
        if (!['claude', 'codex'].includes(start.request.engine)) {
          fail('SWARM_ENGINE', 'A Swarm agent runs only Claude Code or Codex.', 400)
        }
        // A start recorded before a rule was added is not launched past it, unless a person asked for it by hand.
        const why = actor.kind === 'agent' && !(start.routeDecisionId && context.routeDecision?.override?.by === 'person') && broken(groupRules(start.request.conversationId), startTarget(start.request), machineName)
        if (why) fail('RULE_BROKEN', `${why} This start was not launched. Route again.`, 403)
        requireWorkerDecisions(state, actor, open(state, start.request.conversationId))
        const grant = context.contribution ?? fail('HOST_REQUIRED', 'The original machine grant is unavailable.', 403)
        if (grant.machineOwnerId !== start.machineOwnerId || (grant.hostGrant ?? null) !== start.hostGrant) {
          fail('CONTRIBUTION_REVOKED', 'The original machine grant was revoked.', 403)
        }
        admitMachineStart(state, start.request, context.now, start)
        if (start.dispatched || start.error || start.harnessId) fail('START_CLAIMED', 'This native start was already requested. Read its creation status; do not start another.')
        start.dispatched = true
        break
      }
      if (command.type === 'agent.startSettled') {
        if (!start.poolGeneration || !start.harnessId || start.error) fail('START_PENDING', 'This contributed start is not ready to settle.')
        if (!start.poolSettled) message(start.request.conversationId, command.warning
          ? `${start.request.name}: ${command.warning}`
          : `${start.request.name} is ready for an assignment.`, [], null, SYSTEM_ROW)
        start.poolSettled = true
        break
      }
      if (command.type === 'agent.startFailed') {
        if (start.harnessId) fail('ALREADY_STARTED', 'This agent already started.')
        start.error = command.error
        message(start.request.conversationId, `Could not start ${start.request.name}: ${command.error}`, [], null, SYSTEM_ROW)
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
      reserveHarnessSlot(state, start.request.machineId, command.harnessId, operationId)
      state.agents.push({ id: agentId, machineId: start.request.machineId, harnessId: command.harnessId,
        ...(state.projects ? { projectId: groupProject(state, group).id } : {}),
        machineOwnerId: start.machineOwnerId, contributorId: start.contributorId, membershipGeneration: start.membershipGeneration,
        hostGrant: start.hostGrant, name: start.request.name, configuration: command.configuration, configurationVersion: operationId,
        ...(start.request.role ? { role: start.request.role } : {}), ...(start.request.roleId ? { roleId: start.request.roleId } : {}),
        ...(command.startedSession ? { startedSession: { ...command.startedSession, creationId: start.creationId } } : {}) })
      group.agentIds.push(agentId)
      start.harnessId = command.harnessId
      result.agentId = agentId
      message(group.id, start.poolGeneration
        ? `${start.request.name} joined. Preparing its model.`
        : `${start.request.name} joined. Ready for an assignment.`, [], null, SYSTEM_ROW)
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
    case 'agent.rebind': {
      const target = agent(state, command.agentId)
      if (actor.kind !== 'agent' || actor.agentId !== target.id || actor.machineOwnerId !== target.machineOwnerId
        || command.machineId !== target.machineId || command.projectId !== agentProjectId(state, target)) {
        fail('HOST_REQUIRED', 'Only this project’s execution host can report a replacement.', 403)
      }
      if (target.workDecision === 'stop') fail('STOP_REQUESTED', 'This member is stopping; reconcile its stop first.')
      if (state.agents.some(a => a.id !== target.id && a.machineId === target.machineId && a.harnessId === command.harnessId)) {
        fail('SESSION_CONTRIBUTED', 'The replacement terminal already belongs to another member.')
      }
      if (target.harnessId === command.harnessId && target.replacement?.previousHarnessId === command.previousHarnessId) break
      if (target.harnessId !== command.previousHarnessId || command.harnessId === command.previousHarnessId) {
        fail('AGENT_CHANGED', 'The member’s terminal changed. Read its current binding before replacing it.')
      }
      target.harnessId = command.harnessId
      target.replacement = { previousHarnessId: command.previousHarnessId, harnessId: command.harnessId }
      target.configuration = command.configuration
      target.configurationVersion = operationId
      if (command.startedSession) target.startedSession = command.startedSession
      else delete target.startedSession
      for (const group of state.conversations) {
        if (!activeWork(group) || group.assignment?.agentId !== target.id) continue
        group.assignment.execution.harnessId = target.harnessId
        group.assignment.configuration = command.configuration
      }
      result.agentId = target.id
      break
    }
    case 'agent.release': {
      const target = agent(state, command.agentId)
      const project = projectOf(state, agentProjectId(state, target))
      const isLead = actor.kind === 'agent' && conversation(state, project.leadConversationId).leadId === actor.agentId
      const isOwner = actor.kind === 'person' && [state.ownerId, target.contributorId].includes(actor.userId)
      if (!isLead && !isOwner) fail('FORBIDDEN', 'Only this project’s Lead, the contributor or tab owner can release a worker.', 403)
      protectLead(state, target.id)
      if (state.conversations.some(c => c.leadId === target.id)) fail('LEAD_REQUIRED', 'Release workers only; keep the Lead running.')
      if (state.conversations.some(c => activeWork(c) && c.assignment?.agentId === target.id)) fail('WORK_ACTIVE', 'Finish active work before releasing this worker.')
      if (reviewing(state, target.id)) fail('WORK_ACTIVE', 'This Reviewer is reviewing active work. Remove it from that group or wait for the work to end.')
      // A Reviewer is never assigned work, so the Lead may keep or stop it at any time.
      if (!target.workDecision && agentRole(target) !== 'reviewer' && !state.conversations.some(c => c.assignment?.agentId === target.id)) {
        fail('WORK_REQUIRED', 'This worker has no finished assignment to release.')
      }
      if (target.workDecision === 'stop' && command.decision !== 'stop') fail('STOP_REQUESTED', 'This worker is stopping. Wait for its execution host.')
      if (command.decision === 'stop' && target.workDecision !== 'stop') target.releaseId = operationId
      target.workDecision = command.decision
      break
    }
    case 'agent.stopLease': {
      const target = agent(state, command.agentId)
      if (actor.kind !== 'agent' || actor.agentId !== target.id || target.workDecision !== 'stop' || command.releaseId !== target.releaseId) {
        fail('STALE_RELEASE', 'Only the execution host can claim the current worker stop.', 403)
      }
      result.leaseId = operationId
      result.durationMs = 120_000
      result.expiresAt = context.now + 120_000
      break
    }
    case 'agent.remove': {
      const target = agent(state, command.agentId)
      const hostStop = actor.kind === 'agent' && actor.agentId === target.id && target.workDecision === 'stop'
      const forceStop = actor.kind === 'person' && target.workDecision === 'stop' &&
        [state.ownerId, target.contributorId].includes(actor.userId)
      if (hostStop || forceStop) {
        if (hostStop && (command.releaseId !== target.releaseId || !target.releaseId)) fail('STALE_RELEASE', 'Read the current stop request before confirming removal.')
        if (state.conversations.some(c => activeWork(c) && c.assignment?.agentId === target.id)) fail('WORK_ACTIVE', 'Finish active work before stopping this worker.')
        // Administrative withdrawal never attests physical stopping or releases native capacity.
        if (hostStop) releaseHarness(state, target.machineId, target.harnessId)
        if (actor.kind === 'agent') result.releasedBy = actor.machineOwnerId
        if (forceStop) result.forceReleased = target.id
      } else if (target.workDecision === 'stop') {
        fail('FORBIDDEN', 'Only its contributor or tab owner can force-withdraw a stopping worker.', 403)
      } else if (actor.kind !== 'person' || (actor.userId !== state.ownerId && actor.userId !== target.contributorId)) {
        fail('FORBIDDEN', 'Only the contributor or tab owner can withdraw this agent.', 403)
      }
      if (actor.kind === 'person' && !state.harnessReservations?.some(r => r.machineId === target.machineId && r.harnessId === target.harnessId)
        && !state.releasedHarnesses?.some(r => r.machineId === target.machineId && r.harnessId === target.harnessId)) {
        reserveHarnessSlot(state, target.machineId, target.harnessId, operationId)
      }
      const affected = actor.kind === 'person' ? state.conversations.filter(group => group.agentIds.includes(target.id)
        || group.leadId === target.id || group.assignment?.agentId === target.id) : []
      removeAgent(target, { close: !hostStop })
      for (const group of affected) {
        const task = group.assignment?.agentId === target.id && activeWork(group)
          ? ` Its task "${group.title}" needs to be assigned again or closed.` : ''
        const lead = group.leadId && group.agentIds.includes(group.leadId) ? group.leadId : null
        // One person can withdraw an agent from several groups. Each notice needs its own durable message ID.
        effects.messages.push({ id: stableId(operationId, 'agent-removed', group.id), conversationId: group.id,
          author: sender, text: `${sender.name.split('@')[0]} removed ${target.displayName ?? target.name} from the Swarm.${task}`,
          replyTo: null, recipients: lead ? [lead] : [], source: SYSTEM_ROW })
      }
      break
    }
    case 'conversation.agent': {
      controls(state, actor, command.conversationId)
      const group = open(state, command.conversationId)
      const member = agent(state, command.agentId)
      sameProject(state, group, member)
      if (member.workDecision === 'stop' && command.lead) fail('STOP_REQUESTED', 'This worker is stopping. Wait for its execution host.')
      const reviewer = agentRole(member) === 'reviewer'
      if (reviewer && command.lead) fail('REVIEWER_NOT_LEAD', 'A Reviewer reviews work and cannot lead a group.')
      if (reviewer && command.present && member.workDecision === 'stop') fail('STOP_REQUESTED', 'This Reviewer is stopping. Wait for its execution host.')
      if (!command.present) {
        if (activeWork(group) && (group.assignment?.agentId === command.agentId || group.leadId === command.agentId)) {
          fail('WORK_ACTIVE', 'Reconcile this agent’s assignment before removing it from the conversation.')
        }
        if (group.leadId === command.agentId) keepLead(group, null)
        group.agentIds = group.agentIds.filter(id => id !== command.agentId)
        if (group.leadId === command.agentId) group.leadId = null
      } else {
        ruled(agentTarget(state, member), group.id, `${who} added ${member.name}`)
        if (!group.agentIds.includes(command.agentId)) group.agentIds.push(command.agentId)
        // Adding a Reviewer to a group reuses it, as assigning work reuses a Builder.
        if (reviewer) delete member.workDecision
        if (command.lead) {
          keepLead(group, command.agentId)
          if (group.leadId && group.leadId !== command.agentId && activeWork(group)) fail('WORK_ACTIVE', 'Reconcile active work before replacing its lead.')
          group.leadId = command.agentId
        }
      }
      break
    }
    case 'invite.create': {
      owner(state, actor)
      const landing = inviteLanding(state, command.conversationId) ?? fail('NO_PROJECT', 'Create a project before inviting people.')
      const email = command.email.trim().toLowerCase()
      if (state.people.some(p => p.email === email)) fail('ALREADY_MEMBER', 'This person is already in the Super Tab.')
      state.invitations = state.invitations.filter(i => i.email !== email)
      state.invitations.push({ id: operationId, email, role: command.role, conversationId: landing,
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
      // Their machines leave the way their owner removes one, so the Swarm's folders there are deleted too.
      for (const pool of state.machines?.filter(m => m.contributorId === member.id && !m.removal) ?? []) {
        removeMachine(pool.machineId, pool, state.agents.filter(a => a.machineId === pool.machineId), machine => `${machine} left the Swarm with its owner`)
      }
      for (const target of state.agents.filter(a => a.contributorId === member.id)) removeAgent(target)
      state.people = state.people.filter(p => p.id !== member.id)
      state.invitations = state.invitations.filter(i => i.email !== member.email)
      result.removedUserId = member.id
      break
    }
    case 'message.send': {
      const group = postable(state, actor, command.conversationId)
      const ids = [...new Set(command.attachmentIds ?? [])]
      const attachments = ids.map(id => context.attachments?.find(a => a.id === id) ?? fail('ATTACHMENT_UNAVAILABLE', 'Upload this file again before sending it.', 400))
      if (!command.text && !attachments.length) fail('TEXT_REQUIRED', 'Write a message or attach a file.', 400)
      const mentions = checkMentions(state, actor, group, command.mentions ?? [])
      if (command.replyTo && (!context.reply || context.reply.id !== command.replyTo || context.reply.conversationId !== group.id)) {
        fail('INVALID_REPLY', 'Reply to a message in this conversation.', 400)
      }
      const replyAgent = context.reply?.author.kind === 'agent' ? context.reply.author.id : null
      // An assigned worker's own post in its group reaches the Lead. Workers reported results as plain posts, which went to no
      // one: the Lead heard only at the next scheduled consolidation, and the owner saw no summary of finished work for up to
      // 19 minutes (2026-10-21/22). The Lead's message reaches the worker the same way (#1549), except for a reply to someone
      // else and a message that would continue an automatic round trip (leadWorkerBounced), so agents cannot loop.
      const assigned = activeWork(group) ? group.assignment!.agentId : null
      const leadToWorker = actor.kind === 'agent' && actor.agentId === group.leadId && assigned && assigned !== group.leadId
        && group.agentIds.includes(assigned) && (!context.reply || replyAgent === assigned)
        && !leadWorkerBounced(context.recent, group.leadId, assigned) ? assigned : null
      const workerToLead = actor.kind === 'agent' && activeWork(group) && group.assignment?.agentId === actor.agentId
        && group.leadId && group.leadId !== actor.agentId && group.agentIds.includes(group.leadId) ? group.leadId : null
      const agentRecipient = leadToWorker ?? workerToLead
      const automatic = actor.kind === 'person' ? (replyAgent && group.agentIds.includes(replyAgent) ? replyAgent : group.leadId) : agentRecipient
      // In the Leads conversation everything posted reaches every other Lead; naming some only adds emphasis.
      const everyLead = isLeads(group) ? group.agentIds.filter(id => actor.kind !== 'agent' || id !== actor.agentId) : []
      const recipients = [...new Set([...command.recipientIds, ...everyLead,
        ...(command.recipientIds.length || everyLead.length || !automatic ? [] : [automatic])])]
      for (const id of recipients) {
        agent(state, id)
        if (!group.agentIds.includes(id)) fail('INVALID_RECIPIENT', 'Choose an agent in this conversation.', 400)
      }
      // The transcript still accepts a human message while the lead is unavailable. The UI can say why no delivery was created.
      message(group.id, command.text, recipients, command.replyTo, undefined, attachments, mentions)
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
        message(group.id, delivery.text, [target.id], delivery.messageId, SYSTEM_ROW, delivery.attachments)
      } else {
        message(group.id, command.resolution === 'received'
          ? `Checked ${target.name}’s terminal and confirmed the earlier instruction was received.`
          : `Dismissed the delivery warning for ${target.name}. This does not stop work already received.`, [], delivery.messageId, SYSTEM_ROW)
      }
      result.deliveryId = delivery.id
      result.resolution = command.resolution
      break
    }
    case 'route.record': {
      controls(state, actor, command.conversationId)
      const chosen = command.decision.candidates.find(c => c.id === command.decision.pick)!
      const member = chosen.kind === 'member' ? state.agents.find(a => a.id === chosen.agentId) : undefined
      if (member) assignable(conversation(state, command.conversationId), member)
      // Only the pick is checked, so an older CLI that still lists a ruled-out candidate records an allowed pick.
      ruled(member ? agentTarget(state, member) : chosen, command.conversationId, `${who} routed to ${chosen.title}`)
      requireWorkerDecisions(state, actor, open(state, command.conversationId), chosen.kind === 'member' ? chosen.agentId : undefined)
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
      ruled(chosen.kind === 'member' ? agentTarget(state, agent(state, chosen.agentId!)) : chosen, decision.conversationId, `${who} chose ${chosen.title}`)
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
      if (group.assignment) {
        const worker = state.agents.find(a => a.id === group.assignment!.agentId)
        if (worker && !worker.workDecision) finishWorker(state, worker.id)
      }
      rememberAttempt(group)
      group.assignment = null
      group.brief = command.task ? renderWorkTask(command.task) : command.brief!
      if (command.task) group.task = command.task
      else delete group.task
      group.checks = command.checks.map((c, i) => ({ ...c, id: stableId(operationId, String(i)), evidence: null, passedBy: null }))
      message(group.id, group.brief, [], null, SYSTEM_ROW)
      break
    }
    case 'work.assign': {
      const target = agent(state, command.agentId)
      if (state.starts?.some(s => s.poolGeneration && !s.poolSettled && s.request.machineId === target.machineId && s.harnessId === target.harnessId)) {
        fail('START_PENDING', 'Wait for the host to finish this agent’s launch and model selection.')
      }
      controls(state, actor, command.conversationId)
      routed(command.routeDecisionId)
      const group = open(state, command.conversationId)
      if (state.paused) fail('PAUSED', 'New work is paused in this Super Tab.')
      if (activeWork(group)) fail('WORK_ACTIVE', 'The current assignment must finish or be reconciled before reassignment.')
      if (!group.brief || !group.checks.length) fail('BRIEF_REQUIRED', 'Record the brief and acceptance checks before assigning work.', 400)
      const worker = agent(state, command.agentId)
      assignable(group, worker)
      sameProject(state, group, worker)
      const home = groupProject(state, group)
      if (command.roleId) worker.roleId = chosenRole(home, command.roleId, agentKind(state, worker)).id
      else requireCustomRole(home, agentKind(state, worker))
      requireWorkerDecisions(state, actor, group, worker.id)
      if (worker.workDecision === 'stop') fail('STOP_REQUESTED', 'This worker is stopping. Wait for its execution host.')
      if (state.conversations.some(c => activeWork(c) && c.assignment?.agentId === worker.id)) fail('AGENT_BUSY', 'This agent already owns an active assignment.')
      delete worker.workDecision
      delete worker.releaseId
      for (const reviewer of state.agents) {
        if (agentRole(reviewer) === 'reviewer' && group.agentIds.includes(reviewer.id) && reviewer.workDecision !== 'stop') delete reviewer.workDecision
      }
      if (!group.agentIds.includes(worker.id)) group.agentIds.push(worker.id)
      rememberAttempt(group)
      group.assignment = { id: operationId, agentId: worker.id, status: 'working', configuration: structuredClone(worker.configuration),
        execution: { machineId: worker.machineId, harnessId: worker.harnessId, machineOwnerId: worker.machineOwnerId }, result: null }
      group.checks.forEach(c => { c.evidence = null; c.passedBy = null })
      result.assignmentId = operationId
      let routeNote: { decisionId: string; text: string } | null = null, personChose = false
      if (command.routeDecisionId) {
        const started = (d: RouteDecision) => d.final?.kind === 'new' &&
          !!state.starts?.some(s => s.id === (d.final as { startId: string }).startId && s.harnessId === worker.harnessId && s.request.machineId === worker.machineId)
        // An agent started from this decision keeps the final that records its model and effort; only the assignment is added.
        const { decision, expected, override } = linkDecision(group.id,
          (c, d) => (c.kind === 'member' && c.agentId === worker.id) || (c.kind === 'new' && started(d) && d.final?.kind === 'new' &&
            startedAs(c, d.final)),
          d => started(d) ? d.final! : { kind: 'member', agentId: worker.id, machineId: worker.machineId }, command.overrideReason, operationId)
        if (override) routeNote = { decisionId: decision.id, text: `Lead assigned ${worker.name} instead of ${expected.title}. Reason: ${override.reason}` }
        personChose = !override && decision.override?.by === 'person'
      }
      ruled(agentTarget(state, worker), group.id, `${who} assigned ${worker.name}`, personChose)
      message(group.id, `${group.brief}\n\nAcceptance checks:\n${group.checks.map(c => `- ${c.description}`).join('\n')}`, [worker.id], null, SYSTEM_ROW)
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
      if (['done', 'stopped'].includes(command.status)) finishWorker(state, assignment.agentId, group)
      if (changed) {
        const label = { working: 'Working', needs_human: 'Needs a human', blocked: 'Stuck', review: 'Ready for review', done: 'Done', stopped: 'Stopped' }[command.status]
        const lead = group.leadId
        // Stuck is the Lead's to hear as a human decision is: either way the work waits on someone.
        const tellLead = actor.kind === 'agent' && actor.agentId === assignment.agentId && lead && lead !== actor.agentId &&
          ['needs_human', 'blocked', 'review', 'done'].includes(command.status)
        // Ready for review also wakes the group's Reviewers, whoever marked it.
        const reviewers = command.status !== 'review' ? [] : group.agentIds.filter(id => id !== lead &&
          (actor.kind !== 'agent' || id !== actor.agentId) && state.agents.some(a => a.id === id && agentRole(a) === 'reviewer' && a.workDecision !== 'stop'))
        message(group.id, `${label}${command.result ? `\n\n${command.result}` : ''}`, [...(tellLead ? [lead] : []), ...reviewers], null, SYSTEM_ROW)
      }
      break
    }
    case 'work.cancel': {
      const group = open(state, command.conversationId)
      const assignment = group.assignment
      if (!assignment || assignment.id !== command.assignmentId) fail('STALE_ASSIGNMENT', 'This is no longer the active assignment.')
      const project = groupProject(state, group)
      const isLead = actor.kind === 'agent' && conversation(state, project.leadConversationId).leadId === actor.agentId
      if (!isLead && !(actor.kind === 'person' && actor.userId === state.ownerId)) {
        fail('FORBIDDEN', 'Only this project’s Lead or the tab owner can cancel work.', 403)
      }
      // A retry after the cancel keeps the first reason and tells the worker once.
      if (assignment.status === 'cancelled') break
      if (!activeWork(group)) fail('ATTEMPT_CLOSED', 'This attempt has already ended.')
      // A removed worker (reconciling) can never confirm a stop, so this is the only way to close its task; nobody is left to tell.
      const gone = assignment.status === 'reconciling'
      assignment.status = 'cancelled'
      assignment.result = command.reason
      finishWorker(state, assignment.agentId, group)
      message(group.id, `${isLead ? 'The Lead' : 'The tab owner'} cancelled this task: ${command.reason.replace(/[.\s]+$/, '')}.${gone ? '' : ' Stop working on it.'}`,
        gone ? [] : [assignment.agentId], null, SYSTEM_ROW)
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
  if (command.type === 'conversation.create' || command.type === 'work.define' || command.type === 'work.assign') {
    alertOverlaps(conversation(state, command.type === 'conversation.create' ? result.conversationId as string : command.conversationId))
  }
  for (const target of original.agents.filter(a => a.workDecision === 'stop')) {
    const acknowledged = command.type === 'agent.remove' && command.agentId === target.id &&
      (actor.kind === 'agent' && actor.agentId === target.id || actor.kind === 'person' && [state.ownerId, target.contributorId].includes(actor.userId))
    if (!acknowledged && !state.agents.some(a => a.id === target.id)) fail('STOP_REQUESTED', 'Wait for the execution host to finish stopping its workers before withdrawing them.')
  }
  syncLeads(state)
  // MongoDB limits a document to 16 MiB. Leave room for indexes and metadata, and refuse before losing state.
  assignAgentDisplayNames(state.agents)
  if (Buffer.byteLength(JSON.stringify(state)) > 8 * 1024 * 1024) fail('TAB_TOO_LARGE', 'This Super Tab has reached its metadata limit.', 413)
  return effects
}

/** A contribution owns capacity independently of membership. Reuse invalidates every prior stop proof. */
/** The Swarm's grid name: `swarm-` and 12 hex of sha256(tab id). Derived so it is reproducible when supported; the
 * stored value is authoritative and never renamed. */
export function swarmGridName(tabId: string): string {
  return `swarm-${createHash('sha256').update(tabId).digest('hex').slice(0, 12)}`
}

function reserveHarnessSlot(state: SuperTabState, machineId: string, harnessId: string, generation: string) {
  const observation = state.machines?.find(m => m.machineId === machineId)?.observation
  const renewed = !!(state.harnessReservations?.some(r => r.machineId === machineId && r.harnessId === harnessId)
    || state.releasedHarnesses?.some(r => r.machineId === machineId && r.harnessId === harnessId)
    || observation?.stoppedHarnessIds.includes(harnessId))
  if (observation) observation.stoppedHarnessIds = observation.stoppedHarnessIds.filter(id => id !== harnessId)
  state.releasedHarnesses = state.releasedHarnesses?.filter(r => r.machineId !== machineId || r.harnessId !== harnessId)
  state.harnessReservations ??= []
  state.harnessReservations = state.harnessReservations.filter(r => r.machineId !== machineId || r.harnessId !== harnessId)
  state.harnessReservations.push({ machineId, harnessId, generation, renewed })
}
