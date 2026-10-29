import { admitMachineStart, cleanupOverdue, downSince, expireRemoval, expireRemovals, failTeamWork, removalEnded, machineContribution, machineOffline, ownedMachine, projectFolder, requireTeamWork, teamMachineFor, teamPoolsOf, teamStartRequest, teamWorkCheck, type ContributedMachine } from './machines.js'
import { assignAgentDisplayNames } from './agentNames.js'
import { z } from 'zod'
import { tokensByModelSchema } from './costs/tokens.js'
import {
  activeWork, actorKey, agent, agentRole, appendPullRequestUrls, author, conversation, crossProjectActive, fail, isLeads, person, stableId, syncLeads, numberConversations, nextConversationNumber, renderWorkTask,
  finishWorker, requireWorkerDecisions, reviewing, seenMachineIds, swarmGridName, visibleState, AGENT_ONLY,
  type Actor, type AgentStartRequest, type WorkTask, type Agent, type Author, type CommandEffects, type Conversation, type SuperTabState,
} from './model.js'
import { routeRecordSchema, routeTitle, startedAs, type RouteCandidate, type RouteDecision, type RouteFinal, type RouteOverride } from './routeRecord.js'
import { DEFAULT_ROUTING_POLICY, routingOverrideSchema, type RoutingPolicy } from './routingPolicy.js'
import { agentTarget, askedInSchema, broken, MAX_RULES, reviewRefusal, RULE_MESSAGE_MS, sameEngineReview, ruleSchema, ruleTextSchema, startTarget, unmet, type RunTarget } from './rules.js'
import { MAX_ATTACHMENTS, type Attachment } from './attachments.js'
import { checkMentions, MAX_MENTIONS, type MentionTarget } from './mentions.js'
import { answerDecision, askDecisions, checkAsker, decisionChoices, decisionQuestion, MAX_OPEN_DECISIONS, MAX_QUESTIONS, type DecisionTarget } from './decisions.js'
import { TERMINAL_KEYS, terminalAlert, terminalRequest, terminalResult, toLead, type TerminalRequest } from './terminal.js'
import { loseTasks, recordTaskState, renewLease, renewOwnTask } from './liveness.js'
import { ABANDONED, failureNotice, MACHINE_REMOVED } from './startFailure.js'
import { digestStartsAfter, knownTimeZone } from './digest.js'
import { credentialResult, redactCredentials, type CredentialKind } from './credentials.js'
import { dirtyGroups, reportGroups, summarize } from './projectUpdates.js'
import { workspaceCan, type WorkspaceRole } from './workspaces.js'
import { LEDGER_WEEKS, PULL_REQUEST_URL, recordAsked, recordDecision, recordMerged, recordPost, recordProposal, recordReview, recordRun, recordStatus,
  recordVerdict } from './leaderboard/record.js'
import { WEEK_MS } from './leaderboard/week.js'
import { react, reactionSchema, type ReactionTarget } from './reactions.js'
import { shipNotice, shippedAt } from './ship.js'
import { openReview, openReviewOf, projectPullRequest, verdictPending } from './autoReview.js'
import { carryOver, cheapAttempt, GRID_START_FAILED, REVIEW_FAILED, stepUp, stepUpRefusal } from './stepUp.js'
import { avatarChoice, setAgentAvatar, setMemberAvatar, setStatus, statusSchema, type AvatarUpload } from './profile.js'
import { agentKind, agentProjectId, audienceOf, agentSetRole, canReadProject, deleteProject, markConfidential, requireSingleRegistration, groupProject, inviteLanding, ledProject, manageProject, MAX_ROLES, mutableProjects, placeRules, projectMembers, projectOf, projectRules, projectsOf, readAgent, readConversation, readProject, roleVersion, sameProject, sharedWithLeads, SKILL_SET_NAMES, skillSetOf, type ProjectRole, type RoleKind, type SwarmProject } from './projects.js'
import { BUDDY_REQUIREMENTS, buddyChatId, buddyReady, isBuddy, isBuddyChat, MAX_PROPOSAL_ASKS, MAX_PROPOSAL_ATTACHMENTS, openBuddyChat, PROPOSAL_ASK_MS, proposalText, requireBuddyCommand } from './buddies.js'
import { CODEX_BUDDY_REFUSAL } from './buddyContract.js'

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
// How many agents a machine offers is its owner's choice: the CLI suggests at most its total RAM / 2 GB (192 GB offers 96).
// The 16 this once was held the Mac Studio far below that (Ken, 2026-10-28); 1024 only refuses a number no machine could run.
const maxAgents = z.number().int().min(1).max(1024)
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
  /** model.ts TaskRequirement; `unseenMachines` is only ever read back, never set. */
  requires: z.object({ machines: z.array(id).min(1).max(20).optional(), devices: z.array(path).min(1).max(20).optional() }).strict()
    .refine(r => r.machines || r.devices, 'Require at least one machine or device.').optional(),
}).strict()

export const commandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('machine.contribute'), machineId: id, name: title, cwd: path, scope: z.literal('swarm').optional(), engines: z.array(swarmEngine).min(1).max(2), maxAgents,
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
  z.object({ type: z.literal('tab.tidy'), enabled: z.boolean(), askedIn: askedInSchema.optional() }).strict(),
  z.object({ type: z.literal('rule.set'), projectId: id.optional(), rule: ruleSchema, text: ruleTextSchema, askedIn: askedInSchema.optional() }).strict(),
  z.object({ type: z.literal('rule.remove'), projectId: id.optional(), ruleId: id, askedIn: askedInSchema.optional() }).strict(),
  z.object({ type: z.literal('project.create'), name: title, visibility: z.enum(['public', 'private']), brief: z.string().trim().max(8000).default('') }).strict(),
  z.object({ type: z.literal('project.rename'), projectId: id, name: title }).strict(),
  z.object({ type: z.literal('project.delete'), projectId: id }).strict(),
  z.object({ type: z.literal('project.sharing'), projectId: id, visibility: z.enum(['public', 'private']), memberIds: z.array(id).max(200) }).strict(),
  z.object({ type: z.literal('project.cadence'), projectId: id, minutes: z.union([z.literal(1), z.literal(5), z.literal(15), z.literal(30)]) }).strict(),
  // A local time of day ("08:00") in an IANA zone; null turns the digest off.
  z.object({ type: z.literal('project.digest'), projectId: id, time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).nullable(), timeZone: z.string().min(1).max(64) }).strict(),
  // `through`: each conversation's sequence the Lead read, as its wake-up names them. `throughRevision` is the tab revision a
  // wake-up from before the store by parts named; it is accepted only up to that split (projectUpdates.ts).
  z.object({ type: z.literal('project.report'), projectId: id, through: z.record(id, z.number().int().nonnegative().safe()).optional(),
    throughRevision: z.number().int().nonnegative().safe().optional(), text: text.nullable() }).strict()
    .refine(c => (c.through === undefined) !== (c.throughRevision === undefined), 'Acknowledge with through, the map your wake-up names.'),
  z.object({ type: z.literal('project.repository'), projectId: id, repositoryUrl }).strict(),
  z.object({ type: z.literal('project.skills'), projectId: id, mode: z.enum(['default', 'orchestration', 'custom']), askedIn: askedInSchema.optional() }).strict(),
  z.object({ type: z.literal('project.roles.create'), projectId: id, roles: roleSet }).strict(),
  z.object({ type: z.literal('project.role.set'), projectId: id, role }).strict(),
  z.object({ type: z.literal('project.role.remove'), projectId: id, roleId }).strict(),
  z.object({ type: z.literal('project.roles.reset'), projectId: id, roles: roleSet }).strict(),
  // `audience`: a private conversation that only these people and the project's Lead read (projects.ts canReadGroup).
  z.object({ type: z.literal('conversation.create'), projectId: id.optional(), title, brief: z.string().trim().max(8000).optional(), task: task.optional(), reviewOf: id.optional(), checks: z.array(check).max(40),
    audience: z.object({ personIds: z.array(id).max(200) }).strict().optional(), requesterId: id.optional(),
    // The Buddy's proposal message in the project chat the group comes from (Lead, 2026-10-29): the Buddy earns when it ships.
    proposalMessageId: id.optional() }).strict()
    .refine(c => c.task !== undefined || c.brief !== undefined, 'Provide a task or brief.')
    .refine(c => !c.task || renderWorkTask(c.task).length <= 8000, 'Keep the rendered task within 8,000 characters.'),
  z.object({ type: z.literal('conversation.rename'), conversationId: id, title }).strict(),
  z.object({ type: z.literal('conversation.archive'), conversationId: id, archived: z.boolean() }).strict(),
  z.object({ type: z.literal('conversation.requester'), conversationId: id, personId: id.nullable() }).strict(),
  // The Lead's record that a request's pull request merged (leaderboard/record.ts recordMerged); `mergedAt` for a backfill.
  z.object({ type: z.literal('conversation.merged'), conversationId: id, pullRequestUrl: z.string().max(400).regex(PULL_REQUEST_URL),
    mergedAt: z.iso.datetime().optional() }).strict(),
  z.object({ type: z.literal('agent.add'), conversationId: id, machineId: id, harnessId: id, name: title, configuration, lead: z.boolean(), project: project.optional(), roleId: roleId.optional(), initialMessage: text.optional() }).strict(),
  z.object({ type: z.literal('agent.start'), request: startRequestSchema, routeDecisionId: id.optional(), overrideReason: reason.optional() }).strict(),
  // A Buddy's proposal for its owner, posted in its project's chat: `conversationId` is its own chat, and `ownerMessageId` its
  // owner's message there asking for it. Its files are its own uploads in that chat, or files its owner sent there (store.ts proposable).
  z.object({ type: z.literal('buddy.propose'), conversationId: id, ownerMessageId: id, goal: z.string().trim().min(1).max(2000),
    scope: z.string().trim().min(1).max(4000), priority: z.enum(['low', 'normal', 'high']),
    attachmentIds: z.array(id).max(MAX_PROPOSAL_ATTACHMENTS, `Attach at most ${MAX_PROPOSAL_ATTACHMENTS} files to a proposal.`).optional() }).strict(),
  z.object({ type: z.literal('buddy.remove'), projectId: id }).strict(),
  // A person's own Buddy chat in a project, opened before any Buddy is (buddies.ts openBuddyChat).
  z.object({ type: z.literal('buddy.chat'), projectId: id }).strict(),
  // The PM's private line to one person, in their Buddy chat of its project: Buddies replaced Chat with PM (Ken, 10-29).
  z.object({ type: z.literal('person.tell'), personId: id, text: z.string().trim().min(1).max(32_000) }).strict(),
  // A person's own Buddy in a project, on a machine of the Swarm (buddies.ts).
  z.object({ type: z.literal('buddy.create'), projectId: id, machineId: id, engine: swarmEngine, model: z.string().trim().min(1).max(200).optional() }).strict(),
  z.object({ type: z.literal('agent.startDispatch'), startId: id }).strict(),
  z.object({ type: z.literal('agent.started'), startId: id, harnessId: id, configuration,
    startedSession: z.object({ sessionId: id, createdAt: z.iso.datetime() }).strict().optional() }).strict(),
  z.object({ type: z.literal('agent.startSettled'), startId: id, warning: z.string().max(2000).nullable() }).strict(),
  z.object({ type: z.literal('agent.startFailed'), startId: id, error: text }).strict(),
  z.object({ type: z.literal('agent.stopLease'), agentId: id, releaseId: id }).strict(),
  z.object({ type: z.literal('agent.stopRefused'), agentId: id, releaseId: id }).strict(),
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
  z.object({ type: z.literal('member.status'), status: statusSchema.nullable() }).strict(),
  z.object({ type: z.literal('member.avatar'), avatar: avatarChoice }).strict(),
  z.object({ type: z.literal('agent.avatar'), agentId: id, avatar: avatarChoice }).strict(),
  // Text may be empty when the message carries files; applyCommand checks that one of them is there.
  z.object({ type: z.literal('message.send'), conversationId: id, text: z.string().trim().max(32_000), replyTo: id.nullable(), recipientIds: z.array(id).max(16),
    attachmentIds: z.array(id).max(MAX_ATTACHMENTS).optional(), mentions: z.array(id).max(MAX_MENTIONS).optional(), agentOnly: z.literal(true).optional() }).strict(),
  z.object({ type: z.literal('mention.done'), mentionId: id }).strict(),
  z.object({ type: z.literal('message.react'), conversationId: id, messageId: id, emoji: reactionSchema, on: z.boolean() }).strict(),
  z.object({ type: z.literal('decision.ask'), conversationId: id, personId: id, questions: z.array(decisionQuestion).min(1).max(MAX_QUESTIONS) }).strict(),
  // A choice, or `delegate`: the person asked leaves it to the PM, who takes its recommended option (decisions.ts answerDecision).
  z.object({ type: z.literal('decision.answer'), decisionId: id, choice: z.number().int().min(0).optional(), note: z.string().trim().min(1).max(2000).optional(),
    delegate: z.literal(true).optional() }).strict(),
  z.object({ type: z.literal('delivery.resolve'), deliveryId: id, resolution: z.enum(['received', 'resend', 'cancel']) }).strict(),
  z.object({ type: z.literal('work.define'), conversationId: id, brief: text.optional(), task: task.optional(), checks: z.array(check).min(1).max(40) }).strict()
    .refine(c => c.task !== undefined || c.brief !== undefined, 'Provide a task or brief.')
    .refine(c => !c.task || renderWorkTask(c.task).length <= 32_000, 'Keep the rendered task within 32,000 characters.'),
  z.object({ type: z.literal('work.assign'), conversationId: id, agentId: id, roleId: roleId.optional(), routeDecisionId: id.optional(), overrideReason: reason.optional() }).strict(),
  z.object({ type: z.literal('work.status'), conversationId: id, assignmentId: id,
    status: z.enum(['working', 'needs_human', 'blocked', 'review', 'done', 'stopped']), result: text.nullable(),
    // A worker's question for one named person, opened as a decision (decisions.ts); the result is the question.
    ask: decisionChoices.extend({ personId: id }).strict().optional(),
    // Its session's token totals by model, read by its host as it finishes (Done, Stopped): the attempt's end (costs/attempts.ts).
    tokens: tokensByModelSchema.optional() }).strict(),
  z.object({ type: z.literal('work.cancel'), conversationId: id, assignmentId: id, reason }).strict(),
  // `lostAt` names the loss being resumed (Assignment.lost.at): one task can be lost to a limit, resumed and lost again.
  z.object({ type: z.literal('work.resume'), conversationId: id, assignmentId: id, lostAt: z.number().int().nonnegative().safe() }).strict(),
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

/** The words in each command that people and agents read in the Swarm: messages, briefs and tasks, results, evidence,
 *  reasons, errors and names. `[]` is each item of a list. Not `agent.input`: its host types the exact text, and only its
 *  chat row is redacted (terminal.ts). Not a role's skill text, which only its project's owner, Lead and hosts read. */
const WORDS: Partial<Record<Command['type'], readonly string[]>> = {
  'message.send': ['text'],
  'buddy.propose': ['goal', 'scope'],
  'member.status': ['status.text'],
  'agent.add': ['name', 'initialMessage'],
  'agent.start': ['request.name', 'overrideReason'],
  'agent.startFailed': ['error'],
  'agent.startSettled': ['warning'],
  'conversation.create': ['title', 'brief', 'task.goal', 'task.changes', 'task.constraints', 'task.owns[]', 'checks[].description'],
  'conversation.rename': ['title'],
  'work.define': ['brief', 'task.goal', 'task.changes', 'task.constraints', 'task.owns[]', 'checks[].description'],
  'work.assign': ['overrideReason'],
  'work.status': ['result'],
  'work.cancel': ['reason'],
  'work.check': ['evidence'],
  'project.create': ['name', 'brief'],
  'project.rename': ['name'],
  'project.report': ['text'],
  'rule.set': ['text'],
  'route.record': ['decision.assessment.why', 'decision.why', 'decision.excluded[].title', 'decision.excluded[].reason',
    'decision.candidates[].title', 'decision.candidates[].label'],
  'route.override': ['reason'],
  'tab.rename': ['name'],
  'machine.contribute': ['name'],
  'localModels.status': ['error'],
}

/** The command with every credential in its words replaced (credentials.ts), adding what went to `removed`. */
export function withoutCredentials(command: Command, removed: CredentialKind[]): Command {
  const paths = WORDS[command.type]
  if (!paths) return command
  const copy = structuredClone(command)
  const visit = (holder: Record<string, unknown>, [head, ...rest]: string[]) => {
    const many = head!.endsWith('[]'), key = many ? head!.slice(0, -2) : head!
    const redact = (value: unknown, put: (text: string) => void) => {
      if (rest.length) {
        if (value && typeof value === 'object') visit(value as Record<string, unknown>, rest)
      } else if (typeof value === 'string') {
        const clean = redactCredentials(value)
        if (clean.removed.length) { put(clean.text); removed.push(...clean.removed) }
      }
    }
    const value = holder[key]
    if (many && Array.isArray(value)) value.forEach((item, i) => redact(item, text => { value[i] = text }))
    else if (!many) redact(value, text => { holder[key] = text })
  }
  for (const path of paths) visit(copy as Record<string, unknown>, path.split('.'))
  return copy
}

export interface CommandContext {
  operationId: string
  now: number
  /** For a terminal request: its agent's session is confidential in some Swarm, read by the store (confidential.ts). */
  confidentialSession?: boolean
  /** For a command that registers a session or can make one confidential: the other Swarms' registrations (confidential.ts). */
  registrations?: import('./projects.js').OtherRegistrations
  /** The machines of this Swarm's pending cleanups whose machine account is deleted, read by the store: no host will ever
   *  confirm those cleanups (Ken's remote-deepseek and WIN-DELL, 2026-10-28), so they go. */
  deletedMachineIds?: string[]
  /** Read from host ownership/access records by the store, never copied from the request. */
  contribution?: { machineOwnerId: string; contributorId: string; hostGrant?: string | null
    /** A Harness Team account's machine: the Mac it lives on, from its account row (machines.ts ContributedMachine). */
    hostMachineId?: string }
  /** Loaded from this tab and conversation by the store. */
  reply?: { id: string; conversationId: string; author: Author; createdAt: number }
  /** For a person's `message.send`: the tags waiting on them in that conversation, read by the store (leaderboard/record.ts). */
  openTags?: Array<{ messageId: string; createdAt: number }>
  /** The message a Buddy's proposal names as its owner's request, loaded from this tab by the store. */
  /** The proposal a new group names as its origin (conversation.create proposalMessageId), loaded from this tab by the store. */
  proposal?: { id: string; conversationId: string; author: Author; source: Record<string, unknown> | null }
  proposalAsk?: { id: string; conversationId: string; author: Author; source: boolean; createdAt: number
    /** The owner's newest message in that chat, which may always be named. */
    newestOwnerMessageId?: string }
  /** The message a Lead quotes as the owner's request for a rule or skill mode change, loaded from this tab by the store. */
  askedIn?: { author: Author; source: boolean; createdAt: number }
  /** The newest messages of this conversation before the one being sent, newest first, loaded by the store for `message.send`. */
  recent?: { author: Author; recipients: string[] }[]
  /** A host's receipt, not an elapsed lease, proves that an assignment stopped. */
  confirmedStopped?: boolean
  /** An uncertain receipt and its original message, read transactionally. */
  delivery?: { id: string; conversationId: string; agentId: string; messageId: string; text: string; attachments?: Attachment[] }
  /** The files `message.send` or `buddy.propose` names, each checked by the store: uploaded by this actor to this conversation and
   *  unused, or for a proposal, sent there by its Buddy's owner (store.ts proposable). */
  attachments?: Attachment[]
  /** The avatar upload `member.avatar` or `agent.avatar` names, checked by the store the same way (profile.ts). */
  avatarUpload?: AvatarUpload
  /** The message `message.react` names, read by the store (reactions.ts). */
  reaction?: ReactionTarget
  /** Route decisions this tab recorded in the last hour, counted by the store. */
  /** The decision a command names, read from SuperTabRouteDecision by the store. */
  routeDecision?: RouteDecision
  /** The tab's effective routing policy, read by the store for commands that start, assign or route work: who may review
   *  is judged by it (rules.ts reviewRefusal). The built-in default without it. */
  routingPolicy?: RoutingPolicy
  /** Starts on the machine being contributed that the store found abandoned: never contributed, never dispatched,
   *  and older than ABANDONED_START_MS by their operation receipt. */
  abandonedStartIds?: string[]
  /** The request an `agent.screenResult` / `agent.inputResult` answers, read from SuperTabTerminalRequest by the store. */
  terminalRequest?: TerminalRequest
  /** The mention `mention.done` names, read from SuperTabMention by the store. */
  mention?: MentionTarget
  /** The decision `decision.answer` names, read from SuperTabDecision by the store. */
  decision?: DecisionTarget
  /** For a worker's needs_human that asks: the decisions it has open for that person when its question would pass the cap,
   *  read by the store (decisions.ts fullFor). */
  openDecisions?: number | null
  /** For a worker's needs_human that asks: the open decision its question exactly repeats, which it asks again rather than
   *  anew, read by the store (decisions.ts repeatOf). */
  repeatedDecision?: string | null
  /** The tab's contributed machines whose account row is signed in as a Harness Team account (`Machine.sessionKind`),
   *  read by the store for the commands that start, assign or route work (machines.ts teamWorkCheck). */
  teamMachines?: string[]
  /** The person's role in the Swarm's Workspace, read by the store for invitations (workspaces.ts); absent outside a Workspace. */
  workspaceRole?: WorkspaceRole
  /** Machines of this Swarm also contributed to a Swarm of another Workspace (store.ts otherWorkspaceMachines). */
  otherWorkspaceMachines?: string[]
  /** No Harness GitHub App on this server (routes/superTabs.ts): a Mac's Harness Team account has no git login to fetch or
   *  push with, so starts on the Mac stay with the Mac, as before team accounts (machines.ts teamMachineFor). */
  teamAccountsIdle?: boolean
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
  if (isBuddy(worker)) fail('BUDDY_NOT_ASSIGNABLE', 'A Buddy is never assigned work: it brainstorms with its owner. Assign an Engineer.')
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
  // Answering a decision asked of oneself changes only that decision, so a viewer may do it too.
  if (command.type === 'mention.done' || command.type === 'decision.answer') return void author(state, actor)
  const leaving = command.type === 'member.remove' && actor.kind === 'person' && command.userId === actor.userId
  author(state, actor, !leaving)
  const buddy = actor.kind === 'agent' ? state.agents.find(a => a.id === actor.agentId && isBuddy(a)) : undefined
  if (buddy) requireBuddyCommand(buddy, command, state.conversations)
  // An invitation's group is only where the person lands, and invite.create replaces a deleted one (inviteLanding).
  if ('conversationId' in command && command.type !== 'invite.create') {
    const group = readConversation(state, actor, command.conversationId)
    if (isLeads(group) && command.type !== 'message.send') groupProject(state, group)
  }
  if ('projectId' in command && command.projectId) readProject(state, actor, command.projectId)
  if ('agentId' in command) readAgent(state, actor, command.agentId)
  if (command.type === 'agent.start') readConversation(state, actor, command.request.conversationId)
  if ((command.type === 'rule.set' || command.type === 'rule.remove' || command.type === 'project.skills' || command.type === 'tab.tidy') && command.askedIn) {
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
/** Inviting to a Workspace's Swarm (design, Roles): its owner, or anyone in it whose Workspace role may invite to a Swarm they are
 *  in — owners, admins and members, never guests. Revoking: its owner, or the Workspace's owners and admins. A Swarm from
 *  before Workspaces keeps invitations to its owner. */
function inviter(state: SuperTabState, actor: Actor, context: Partial<CommandContext>, action: 'swarm.invite' | 'swarm.manage'): void {
  if (actor.kind === 'person' && actor.userId === state.ownerId) return
  if (state.workspaceId && actor.kind === 'person' && context.workspaceRole && workspaceCan(context.workspaceRole, action)) return
  fail('OWNER_REQUIRED', 'Your role cannot manage invitations to this Swarm.', 403)
}
/** A requester is a member who can read the project the work is in. */
function requester(state: SuperTabState, project: SwarmProject, personId: string): string {
  const member = person(state, personId)
  if (!canReadProject(state, { kind: 'person', userId: member.id, email: member.email }, project)) fail('REQUESTER_UNAVAILABLE', 'Name a person who can read this project.', 400)
  return member.id
}
/** The Buddy whose proposal a new group comes from: the message must be a Buddy's proposal posted in the project's chat. Its
 *  row is the Swarm's own (buddy.propose), so a Buddy removed since still earns for it. */
function proposalOf(state: SuperTabState, project: SwarmProject, proposal: CommandContext['proposal']): { buddyId: string; messageId: string } {
  const author = proposal?.author
  const buddy = author?.kind === 'agent' ? state.agents.find(a => a.id === author.id) : undefined
  if (!proposal || proposal.conversationId !== project.leadConversationId || proposal.source?.kind !== 'buddy-proposal'
    || author?.kind !== 'agent' || (buddy && !isBuddy(buddy))) {
    fail('PROPOSAL_UNKNOWN', 'Name a Buddy\'s proposal posted in this project\'s chat, or leave the proposal out.', 400)
  }
  return { buddyId: author.id, messageId: proposal.id }
}

function open(state: SuperTabState, conversationId: string) {
  const group = conversation(state, conversationId)
  if (group.archived) fail('ARCHIVED', 'Reopen this conversation before changing its work.')
  return group
}

/** Pure policy/state transition. The store commits its state, messages and delivery records in one transaction. */
export function applyCommand(original: SuperTabState, actor: Actor, input: Command, context: CommandContext): CommandEffects {
  // A credential someone pasted, or an agent echoed from its terminal, is gone before anything is stored or delivered
  // (Oct 2026: a Harness access token in a shared Lead chat). The sender's result says what went.
  const removed: CredentialKind[] = []
  const command = withoutCredentials(commandSchema.parse(input), removed)
  const state = structuredClone(original)
  syncLeads(state)
  numberConversations(state)
  placeRules(state)
  const ended = expireRemovals(state, context.now)
  // Their removal already said they left; nothing is said again.
  const deleted = new Set(context.deletedMachineIds ?? [])
  if (deleted.size && state.machineCleanups) {
    state.machineCleanups = state.machineCleanups.filter(c => !deleted.has(c.machineId))
    if (!state.machineCleanups.length) delete state.machineCleanups
  }
  assignAgentDisplayNames(state.agents)
  const result: Record<string, unknown> = {}
  const effects: CommandEffects = { state, messages: ended, cancelledAgents: [], previousAttempts: [], routeDecisions: [], result }
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
    // One that already left the list said why then.
    if (pool) effects.messages.push(...removalEnded(state, pool, 'confirmed'))
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
  const sender = author(state, actor, !leaving && command.type !== 'decision.answer')
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
  /** The project Lead's own route, start, assignment or post on a task, with its time (liveness.ts reads it). It rides on the
   *  write each of them makes to the group anyway. */
  const leadActed = (conversationId: string, kind: NonNullable<Conversation['leadAction']>['kind']) => {
    const group = state.conversations.find(c => c.id === conversationId)
    if (!group || group.kind || group.audience || actor.kind !== 'agent') return
    const project = groupProject(state, group)
    if (project.leadConversationId !== group.id && conversation(state, project.leadConversationId).leadId === actor.agentId) {
      group.leadAction = { kind, at: context.now }
    }
  }
  /** An agent starts or assigns only what the route chose; a person may still do either by hand. */
  /** A private conversation is chat only (design section 4.8). */
  const chatOnly = (conversationId: string) => {
    if (state.conversations.find(c => c.id === conversationId)?.audience) fail('AUDIENCE_CHAT_ONLY', 'A private conversation is chat only.', 400)
  }
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
  /** The Mac a Harness Team account's machine is, for a machines rule naming the Mac (machines.ts teamStartRequest). */
  const macOf = (id: string) => state.machines?.find(m => m.machineId === id)?.hostMachineId
  const groupRules = (conversationId: string) => projectRules(state, groupProject(state, conversation(state, conversationId)).id)
  /** A requirement names only machines its setter sees, so it never names one to a reader who could not (model.ts TaskRequirement). */
  const requirable = (task: WorkTask | undefined) => {
    const machines = task?.requires?.machines
    if (!machines) return
    const seen = seenMachineIds(visibleState(state, actor, context.now))
    if (machines.some(m => !seen.has(m))) fail('MACHINE_UNKNOWN', 'Name a machine of this Swarm that you can see.', 400)
  }
  /** The owner's rules for the group's project, then the group's own requirement, each with its own code so a caller can tell
   *  an owner's rule from where the task can be done at all. */
  const policy = context.routingPolicy ?? DEFAULT_ROUTING_POLICY
  /** [builds]: the target would do the group's work, so a step up's floor holds too (stepUp.ts). */
  const refusal = (target: RunTarget, conversationId: string, builds = true): { code: string; why: string } | null => {
    const rule = broken(groupRules(conversationId), target, machineName, macOf)
    if (rule) return { code: 'RULE_BROKEN', why: rule }
    const requirement = unmet(conversation(state, conversationId).task?.requires, target, macOf)
    if (requirement) return { code: 'REQUIREMENT_UNMET', why: requirement }
    const review = reviewRefusal(state, conversation(state, conversationId).reviewOf, target, policy)
    if (review) return { code: 'REVIEW_REFUSED', why: review }
    const stepped = builds ? stepUpRefusal(conversation(state, conversationId), target, policy) : null
    return stepped ? { code: 'STEPPED_UP', why: stepped } : null
  }
  const ruled = (target: RunTarget, conversationId: string, done: string, personChose = false, builds = true) => {
    const refused = refusal(target, conversationId, builds)
    if (!refused) return
    const { code, why } = refused
    if (actor.kind === 'agent' && !personChose) fail(code, `${why} Route again.`, 403)
    result.warnings = [why]
    effects.messages.push({ id: stableId(operationId, 'rule'), conversationId, author: sender, text: `${done} anyway. ${why}`, replyTo: null, recipients: [], source: RULE_ROW })
  }
  /** Steps [group] up a tier, tells the worker it stopped to stop and wakes the Lead (stepUp.ts). */
  const steppedUp = (group: Conversation, reason: string) => {
    const stepped = stepUp(state, group, reason, context.now)
    if (!stepped) return
    if (stepped.stopped) message(group.id, `The Swarm stepped this task up to a stronger model: ${reason.replace(/^./, c => c.toLowerCase()).replace(/\.$/, '')}. Stop working on it.`, [stepped.stopped], null, SYSTEM_ROW)
    const lead = group.leadId && group.agentIds.includes(group.leadId) ? group.leadId : null
    message(group.id, stepped.notice, lead ? [lead] : [], null, SYSTEM_ROW)
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
  /** No private channel to the PM: Buddies replaced Chat with PM (Ken, 10-29). A closed one is nobody's to read or post in
   *  (projects.ts isClosedPmChat); an app from before still sends this to open one. */
  const pmChatClosed = (): never =>
    fail('PM_CHAT_CLOSED', actor.kind === 'agent'
      ? 'Chat with PM is closed: to tell one person something privately, send person.tell; it lands in their Buddy chat.'
      : 'Chat with PM is closed: talk to the PM in the project chat, or brainstorm with your Buddy, where the PM\'s private lines reach you.', 403)
  /** A Swarm-wide switch is the Swarm owner's, or a Lead's passing on a chat message the Swarm owner wrote in the last day,
   *  as rules are. */
  const swarmOwnerAsked = (askedIn: { conversationId: string; messageId: string } | undefined, what: string) => {
    if (actor.kind === 'person' && actor.userId === state.ownerId) return
    const asked = actor.kind === 'agent' && ledProject(state, actor.agentId) && askedIn && context.askedIn
    if (!asked || asked.author.kind !== 'person' || asked.author.id !== state.ownerId || asked.source || context.now - asked.createdAt > RULE_MESSAGE_MS) {
      fail('OWNER_REQUIRED', `Only the Swarm owner, or a Lead passing on a chat message the owner wrote in the last day, ${what}.`, 403)
    }
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
  /** Why a route candidate cannot take a teammate's work in [conversationId], or null (machines.ts teamWorkCheck). A
   *  member runs under its own contributor's grant; a new agent under the contribution's, or off the Machines list under
   *  the grant of whoever will start it ([starter]). */
  const candidateRefusal = (candidate: RouteCandidate, conversationId: string, starter: string) => {
    const project = groupProject(state, conversation(state, conversationId))
    const member = candidate.kind === 'member' ? state.agents.find(a => a.id === candidate.agentId) : undefined
    if (candidate.kind === 'member' && !member) return null
    // A new agent on a Mac for a teammate's project runs in the Mac's Harness Team account (machines.ts teamStartRequest).
    const machineId = member?.machineId ?? teamMachineFor(state, candidate.machineId, project, context.teamAccountsIdle, context.teamMachines)
    const contributor = member?.contributorId ?? state.machines?.find(m => m.machineId === machineId)?.contributorId ?? starter
    return teamWorkCheck(state, machineId, contributor, project, context.now, context.teamMachines, context.otherWorkspaceMachines)
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
   *  until its host deletes the Swarm's folders there — or leaves at once when that host is offline
   *  (spec 2026-10-23-remove-machine.md). */
  const removeMachine = (machineId: string, pool: ContributedMachine | undefined, members: Agent[], how: (machine: string) => string) => {
    const pending = state.starts?.filter(s => s.request.machineId === machineId && !s.harnessId && !s.error) ?? []
    // A launch already under way would arrive with nowhere to go; it finishes in moments.
    if (pending.some(s => s.dispatched)) fail('STARTS_PENDING', 'An agent is starting on this machine. Try again in a moment.')
    for (const start of pending) {
      start.error = MACHINE_REMOVED
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
    // Its host is offline and cannot acknowledge, so the fallback applies at once: the machine leaves the list
    // now and its cleanup waits for its next connection (spec 2026-10-23-remove-machine.md).
    if (pool?.removal && machineOffline(pool, context.now)) effects.messages.push(...removalEnded(state, pool, expireRemoval(state, pool, context.now)))
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

  /** After its task was lost, its old agent's status and checks for that attempt are refused, even once it is reassigned. */
  const fenceLost = (group: Conversation, assignmentId: string) => {
    if (actor.kind === 'agent' && group.lostAttempt?.id === assignmentId && group.lostAttempt.agentId === actor.agentId) {
      fail('ASSIGNMENT_LOST', 'This task was lost and moved on, so your status and results for it are no longer accepted. Stop working on it.')
    }
  }

  /** Changing or clearing the Lead of a project's Lead conversation would let it be stopped next. */
  const keepLead = (group: Conversation, next: string | null) => {
    if (group.leadId && group.leadId !== next && group.id === groupProject(state, group).leadConversationId) protectLead(state, group.leadId)
  }

  switch (command.type) {
    case 'agent.screen':
    case 'agent.input': {
      const { effect, message, removed: typed } = terminalRequest(state, actor, sender, operationId, context.now, command, context.confidentialSession)
      effects.terminal = effect
      result.requestId = operationId
      if (message) effects.messages.push(message)
      removed.push(...typed)
      break
    }
    case 'agent.screenResult':
    case 'agent.inputResult':
      effects.terminal = terminalResult(state, actor, context.terminalRequest, command)
      break
    case 'agent.alert': {
      effects.messages.push(...terminalAlert(state, actor, sender, operationId, context.now, command))
      // A usage limit or a model that keeps failing loses its task at once (liveness.ts); a waiting prompt does not.
      if (command.alert !== 'prompt' && command.active) {
        // A reset time the limit screen gave is when the task resumes in this same session unless it is handed on first.
        const resumeAt = command.alert === 'limit' && command.resetAt && Date.parse(command.resetAt) > context.now
          ? agent(state, command.agentId).limitedUntil ?? undefined : undefined
        effects.messages.push(...loseTasks(state, context.now, worker => worker.id === command.agentId, resumeAt))
      }
      break
    }
    case 'project.report': {
      const project = readProject(state, actor, command.projectId)
      const group = conversation(state, project.leadConversationId)
      if (actor.kind !== 'agent' || group.leadId !== actor.agentId) fail('LEAD_REQUIRED', 'The project lead writes its progress updates.', 403)
      if (command.throughRevision !== undefined && command.throughRevision > (state.sequenceBase ?? 0)) {
        fail('THROUGH_REQUIRED', 'Acknowledge with through, the map of workgroups your latest wake-up names.', 400)
      }
      summarize(state, project, command.through ?? Object.fromEntries(reportGroups(state, project).map(g => [g.id, command.throughRevision!])))
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
    case 'project.digest': {
      const project = readProject(state, actor, command.projectId)
      const lead = conversation(state, project.leadConversationId).leadId
      if (actor.kind !== 'person' && !(actor.kind === 'agent' && actor.agentId === lead)) fail('FORBIDDEN', 'A person or the project’s Lead sets its morning digest.', 403)
      if (!knownTimeZone(command.timeZone)) fail('TIME_ZONE', 'Name a time zone such as Asia/Ho_Chi_Minh.', 400)
      mutableProjects(state)
      const stored = projectOf(state, project.id)
      if (command.time === null) delete stored.digest
      else {
        // Set after today's time, the first digest comes tomorrow rather than at once; moved later on a day its digest went
        // out, it stays sent for today.
        const lastOn = digestStartsAfter(command.time, command.timeZone, context.now, stored.digest?.lastOn)
        stored.digest = { time: command.time, timeZone: command.timeZone, ...lastOn ? { lastOn } : {} }
      }
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
      // A late cleanup would delete the new contribution's folders, but one that waited past the fallback no longer holds
      // its own owner's add: it goes, and the add takes its place (machines.ts cleanupOverdue).
      const cleaning = state.machines.some(m => m.machineId === command.machineId && m.removal)
        || !!state.machineCleanups?.some(c => c.machineId === command.machineId && !(c.machineOwnerId === actor.userId && cleanupOverdue(c, context.now)))
      // A Mac's Harness Team account joins by itself wherever its owner added the Mac, as that Mac (cli/src/superTabs/host.ts).
      const mac = context.contribution?.hostMachineId
        ? state.machines.find(m => m.machineId === context.contribution!.hostMachineId && m.contributorId === actor.userId && !m.removal) : undefined
      if (command.ifMissing) {
        if (actor.userId !== state.ownerId && !mac) fail('OWNER_REQUIRED', 'Only the Swarm owner adds a machine automatically.', 403)
        if (cleaning || state.machines.some(m => m.machineId === command.machineId)) break
      }
      if (cleaning) fail('MACHINE_CLEANING', 'This machine is still cleaning up after its removal. Add it again once that finishes.')
      if (!state.machines.some(m => m.machineId === command.machineId) && state.machines.length >= 32) fail('MACHINES_FULL', 'A Super Tab can have up to 32 contributed machines.')
      // Before a machine was contributed, a Lead's start on it that never dispatched was left pending for good (12 on Ken's
      // Mac that day) and refused every contribution. Those finish as failed; a dispatched or recent start still blocks.
      const abandoned = (state.starts ?? []).filter(s => context.abandonedStartIds?.includes(s.id))
      for (const start of abandoned) start.error = ABANDONED
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
      // Saving settings sends the whole contribution again; only machine.pause changes its pause (review of #2084).
      const paused = mac?.paused ?? state.machines.find(m => m.machineId === command.machineId)?.paused ?? false
      state.machines = state.machines.filter(m => m.machineId !== command.machineId)
      state.machineCleanups = state.machineCleanups?.filter(c => c.machineId !== command.machineId)
      if (!state.machineCleanups?.length) delete state.machineCleanups
      const host = context.contribution?.hostMachineId
      state.machines.push({ machineId: command.machineId, name: mac?.name ?? command.name, cwd: command.cwd, engines: [...new Set(command.engines)],
        maxAgents: mac?.maxAgents ?? command.maxAgents, ...(command.scope ? { scope: command.scope } : {}),
        contributorId: actor.userId, membershipGeneration: contributor.generation, generation: operationId, paused,
        ...(host ? { hostMachineId: host } : {}) })
      // A Mac given other slots or a new name gives its team account the same, and its pause; its own folder, engines and grant stay.
      const added = state.machines.at(-1)!
      for (const team of teamPoolsOf(state, added)) if (!team.removal) Object.assign(team, { name: added.name, maxAgents: added.maxAgents, paused: added.paused })
      break
    }
    case 'machine.pause': {
      const pool = machineContribution(state, command.machineId) ?? fail('NOT_FOUND', 'This machine has not been contributed.', 404)
      if (actor.kind !== 'person' || actor.userId !== pool.contributorId) fail('OWNER_REQUIRED', 'Only its contributor can change this machine.', 403)
      if (pool.removal) fail('MACHINE_REMOVED', 'This machine is being removed from the Swarm.')
      pool.paused = command.paused
      // Its Harness Team account is the same Mac.
      for (const team of teamPoolsOf(state, pool)) if (!team.removal) team.paused = command.paused
      break
    }
    case 'machine.remove': {
      // Its owner takes the machine out with every Swarm agent on it, each removed like one agent (its host closes the
      // session; a Product Manager refuses it, protectLead). A contributed machine then stays listed, paused, while its
      // host deletes the Swarm's folders there (spec 2026-10-23-remove-machine.md); one with only shared agents goes at once.
      if (actor.kind !== 'person') fail('HUMAN_REQUIRED', 'A person removes a machine from the Swarm.', 403)
      const { pool, members } = ownedMachine(state, actor, command.machineId)
      if (pool?.removal) fail('MACHINE_REMOVED', 'This machine is already being removed from the Swarm.')
      // The Mac leaves with its Harness Team account and the agents there, told once as the Mac; that account's host cleans
      // its own folders.
      const moving = pool ? teamPoolsOf(state, pool).filter(m => !m.removal) : []
      const removed = removeMachine(command.machineId, pool, [...members, ...state.agents.filter(a => moving.some(m => m.machineId === a.machineId))],
        machine => `${who} removed ${machine} from the Swarm`)
      for (const team of moving) removeMachine(team.machineId, team, [], machine => `${who} removed ${machine} from the Swarm`)
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
    case 'tab.tidy': {
      swarmOwnerAsked(command.askedIn, 'turns tidying on or off')
      if (command.enabled) delete state.tidy
      else state.tidy = false
      break
    }
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
      requirable(command.task)
      if (command.audience) pmChatClosed()
      if (actor.kind === 'agent' && (!brief || !command.checks.length)) {
        fail('BRIEF_REQUIRED', 'Delegated work needs a brief and acceptance checks.', 400)
      }
      const leadId = conversation(state, project.leadConversationId).leadId
      if (command.reviewOf) {
        chatOnly(command.reviewOf)
        const reviewed = open(state, command.reviewOf)
        if (reviewed.id === project.leadConversationId || reviewed.reviewOf || groupProject(state, reviewed).id !== project.id) {
          fail('REVIEW_TARGET', 'A review group reviews one build group of the same project.', 400)
        }
        requireCustomRole(project, 'reviewer')
        // One open review at a time: a Lead on the skill text from before #610 would otherwise open one beside the Swarm's.
        const pending = openReviewOf(state, reviewed)
        if (pending) fail('REVIEW_OPEN', `#${pending.number} ${pending.title} already reviews this work and has no verdict yet. Cancel it first, or wait for its verdict.`)
      }
      const requesterId = command.requesterId ? requester(state, project, command.requesterId) : actor.kind === 'person' ? actor.userId : undefined
      const number = nextConversationNumber(state)
      state.groupCounter = number
      state.conversations.push({ id: operationId, ...(state.projects ? { projectId: project.id } : {}),
        number, title: command.title, leadId, agentIds: leadId ? [leadId] : [],
        archived: false, brief, ...(command.task ? { task: command.task } : {}), ...(command.reviewOf ? { reviewOf: command.reviewOf } : {}),
        assignment: null, lastMessageSequence: 0,
        checks: command.checks.map((c, i) => ({ ...c, id: stableId(operationId, String(i)), evidence: null, passedBy: null })),
      })
      recordAsked(state.conversations.at(-1)!, requesterId, context.now)
      if (command.proposalMessageId) recordProposal(state.conversations.at(-1)!, proposalOf(state, project, context.proposal))
      result.conversationId = operationId
      result.number = number
      if (brief) message(operationId, brief, [], null, SYSTEM_ROW)
      break
    }
    case 'decision.ask': {
      const group = open(state, command.conversationId)
      effects.decisions = askDecisions(state, group, command.personId, command.questions,
        { operationId, askerAgentId: checkAsker(state, actor, group), assignmentId: null })
      result.decisionIds = effects.decisions.map(d => d.id)
      break
    }
    case 'decision.answer': {
      const { answer, noticeIn, notice, recipients, source, line } = answerDecision(state, actor, context.decision,
        { choice: command.choice, note: command.note ?? null, delegate: command.delegate === true })
      effects.decisionAnswer = answer
      recordDecision(conversation(state, context.decision!.conversationId), context.decision!, context.now, answer.delegated === true)
      if (recipients.length) message(noticeIn, notice, recipients, null, source)
      if (line) effects.messages.push({ id: stableId(operationId, 'delegated'), replyTo: null, recipients: [], ...line })
      result.decisionId = answer.id
      break
    }
    case 'conversation.rename':
      controls(state, actor, command.conversationId)
      open(state, command.conversationId).title = command.title
      break
    case 'conversation.requester': {
      chatOnly(command.conversationId)
      controls(state, actor, command.conversationId)
      const group = open(state, command.conversationId)
      if (command.personId) group.requesterId = requester(state, groupProject(state, group), command.personId)
      else delete group.requesterId
      break
    }
    case 'conversation.merged': {
      chatOnly(command.conversationId)
      controls(state, actor, command.conversationId)
      // An archived group still takes the record: a backfill names work finished days ago.
      const group = conversation(state, command.conversationId)
      // It awards points, so only the group's Lead or an owner records it; reading the group is not enough.
      const owners = [state.ownerId, groupProject(state, group).ownerId]
      if (!(actor.kind === 'agent' && group.leadId === actor.agentId) && !(actor.kind === 'person' && owners.includes(actor.userId))) {
        fail('MERGE_RECORDER', 'Only the Lead or an owner records a merge.', 403)
      }
      if (group.reviewOf) fail('REVIEW_SHIPS_NOTHING', 'A review group ships nothing. Record the merge on the group it reviews.', 400)
      const mergedAt = command.mergedAt === undefined ? context.now : Date.parse(command.mergedAt)
      if (mergedAt > context.now || mergedAt <= context.now - (LEDGER_WEEKS - 1) * WEEK_MS) {
        fail('MERGE_TIME', 'Record a merge from the last four weeks, not one still to come.', 400)
      }
      const shippedAt = group.ledger?.shippedAt, linked = group.pullRequestUrls?.includes(command.pullRequestUrl)
      appendPullRequestUrls(group, [command.pullRequestUrl])
      recordMerged(group, mergedAt)
      if (!linked || group.ledger!.shippedAt !== shippedAt) message(group.id, `Merged ${command.pullRequestUrl}`, [], null, SYSTEM_ROW)
      break
    }
    case 'conversation.archive': {
      controls(state, actor, command.conversationId)
      const group = conversation(state, command.conversationId)
      if (group.id === groupProject(state, group).leadConversationId) fail('LEAD_CONVERSATION', 'The Lead conversation stays available.')
      if (command.archived && activeWork(group)) fail('WORK_ACTIVE', 'Resolve the active assignment before archiving this conversation.')
      if (command.archived && verdictPending(state, group)) {
        fail('REVIEW_PENDING', 'This review has no verdict yet. Cancel it, or finish the work it reviews, before archiving it.')
      }
      group.archived = command.archived
      // Archived by hand, it leaves the active set until it is reopened (spec, Archive), once its reports are acknowledged:
      // until then the sweep leaves it in the active set, where the report check sees it (design section 3.6).
      if (command.archived && !dirtyGroups(state, groupProject(state, group)).includes(group)) group.dormant = true
      else delete group.dormant
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
      chatOnly(command.request.conversationId)
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
      // A teammate's project started on a Mac runs in that Mac's Harness Team account, never as its owner (machines.ts).
      const request = teamStartRequest(state, command.request, home, context.teamAccountsIdle, context.teamMachines)
      const pool = admitMachineStart(state, request, context.now, undefined, context.teamMachines, context.otherWorkspaceMachines)
      // Off the Machines list, a teammate's project never runs: nothing there shows a privacy check (machines.ts).
      if (!pool) requireTeamWork(state, request.machineId, grant.contributorId, home, context.now, context.teamMachines, context.otherWorkspaceMachines)
      state.starts.push({ ...(pool ? { poolGeneration: pool.generation } : {}), ...(command.routeDecisionId ? { routeDecisionId: command.routeDecisionId } : {}), id: operationId, creationId: `super-${operationId}`, actorKey: actorKey(actor),
        contributorId: contributor.id, membershipGeneration: contributor.generation, machineOwnerId: grant.machineOwnerId,
        hostGrant: grant.hostGrant ?? null, request, harnessId: null, dispatched: false, error: null, requestedAt: context.now })
      leadActed(command.request.conversationId, 'start')
      result.startId = operationId
      let personChose = false
      if (command.routeDecisionId) {
        // The pick names the machine the Lead named: the Mac, when the start then went to its team account.
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
      ruled(startTarget(request), request.conversationId, `${who} started ${request.name}`, personChose)
      break
    }
    case 'buddy.propose': {
      const self = actor.kind === 'agent' ? state.agents.find(a => a.id === actor.agentId && isBuddy(a)) : undefined
      if (!self) fail('BUDDY_ONLY', 'Only a Buddy sends a proposal, for its owner.', 403)
      const owner = state.people.find(p => p.id === self.buddyOf!.personId && p.generation === self.buddyOf!.generation)
        ?? fail('BUDDY_OWNER_GONE', 'Your owner left this Swarm.', 403)
      const chat = conversation(state, command.conversationId)
      if (!isBuddyChat(chat) || !chat.agentIds.includes(self.id)) fail('BUDDY_FORBIDDEN', 'Name your own chat: a proposal comes from there.', 403)
      // Its owner said to send it: their own message in its chat, never a row the system wrote, and each one asks once.
      const ask = context.proposalAsk
      if (!ask || ask.id !== command.ownerMessageId || ask.conversationId !== chat.id || ask.source || ask.author.kind !== 'person'
        || ask.author.id !== owner.id || ask.author.membershipGeneration !== owner.generation) {
        fail('PROPOSAL_UNASKED', 'Send a proposal only when your owner asks for it: name your owner\'s message in your chat that asked.', 403)
      }
      // Its newest message there, or one from the last hour: an old ask is not a standing order (privacy review of #1992).
      if (ask.newestOwnerMessageId !== ask.id && context.now - ask.createdAt > PROPOSAL_ASK_MS) {
        fail('PROPOSAL_STALE', 'Send a proposal for your owner\'s newest message in your chat, or one from the last hour. Ask them again.', 403)
      }
      if (chat.proposals?.includes(command.ownerMessageId)) fail('PROPOSAL_SENT', 'A proposal was already sent for that message. Ask your owner before sending another.')
      const attachments = [...new Set(command.attachmentIds ?? [])]
        .map(id => context.attachments?.find(a => a.id === id) ?? fail('ATTACHMENT_UNAVAILABLE', 'Upload this file again before sending it.', 400))
      chat.proposals = [...chat.proposals ?? [], command.ownerMessageId].slice(-MAX_PROPOSAL_ASKS)
      const project = projectOf(state, agentProjectId(state, self)), home = conversation(state, project.leadConversationId)
      const name = owner.email.split('@')[0]!
      message(home.id, proposalText(name, command), home.leadId && home.agentIds.includes(home.leadId) ? [home.leadId] : [], null,
        { kind: 'buddy-proposal', personId: owner.id, ownerMessageId: command.ownerMessageId }, attachments)
      break
    }
    case 'buddy.remove': {
      if (actor.kind !== 'person') fail('BUDDY_PERSON', 'A person removes their own Buddy.', 403)
      const project = readProject(state, actor, command.projectId), me = person(state, actor.userId)
      const chatId = buddyChatId(project.id, me)
      const target = state.agents.find(a => a.buddyOf?.personId === me.id && agentProjectId(state, a) === project.id)
      const starting = state.starts?.filter(s => s.request.conversationId === chatId && !s.harnessId && !s.error) ?? []
      if (!target && !starting.length) fail('NOT_FOUND', 'You have no Buddy in this project.', 404)
      for (const start of starting) start.error = 'Removed by its owner before it started.'
      // Its session closes; its chat stays, and adding a Buddy again reopens it.
      if (target) removeAgent(target)
      break
    }
    case 'buddy.chat': {
      if (actor.kind !== 'person') fail('BUDDY_PERSON', 'A person opens their own Buddy chat.', 403)
      result.conversationId = openBuddyChat(state, readProject(state, actor, command.projectId).id, person(state, actor.userId)).id
      break
    }
    case 'person.tell': {
      const project = actor.kind === 'agent' ? ledProject(state, actor.agentId) : undefined
      if (!project) fail('TELL_FORBIDDEN', 'Only a project\'s Lead sends a person a private line, in its own project.', 403)
      const to = state.people.find(p => p.id === command.personId) ?? fail('INVALID_PERSON', 'Tell a person in this Swarm.', 400)
      if (!canReadProject(state, { kind: 'person', userId: to.id, email: to.email }, project)) fail('INVALID_PERSON', `${to.email} cannot read this project.`, 400)
      // To nobody: the person reads it; their Buddy, if they have one, is not asked to answer for them.
      message(openBuddyChat(state, project.id, to).id, command.text)
      break
    }
    case 'buddy.create': {
      if (actor.kind !== 'person') fail('BUDDY_PERSON', 'A person adds their own Buddy.', 403)
      if (state.paused) fail('PAUSED', 'New work is paused in this Super Tab.')
      // Codex runs a command its rules files allow outside its sandbox without asking, and those are the person's own and
      // Harness's, shared by all their Codex sessions: a Buddy could run harness new or send, or anything they once told
      // Codex to always allow. Refused here, so every machine refuses whatever its CLI, until a Buddy has a Codex home of
      // its own (security review 1 of #2087). Desktop names this reason beside a disabled Codex.
      if (command.engine === 'codex') fail('BUDDY_ENGINE', CODEX_BUDDY_REFUSAL, 403)
      const project = readProject(state, actor, command.projectId), me = person(state, actor.userId)
      const chatId = buddyChatId(project.id, me)
      // A down Buddy is replaced (Desktop's Start again, review of #1992): its session closes in this same command, so a
      // start refused below leaves it as it was. A running or starting one is kept.
      const existing = state.agents.find(a => a.buddyOf?.personId === me.id && agentProjectId(state, a) === project.id)
      if ((existing && !downSince(state, existing, context.now)) || state.starts?.some(s => s.request.conversationId === chatId && !s.harnessId && !s.error)) {
        fail('BUDDY_EXISTS', 'You already have a Buddy in this project. Remove it to add another.')
      }
      if (existing) removeAgent(existing)
      // A Buddy runs where the Swarm's agents run, under that machine's own rules: its Machines list.
      const pool = machineContribution(state, command.machineId) ?? fail('BUDDY_MACHINE', 'Add this machine to the Swarm first: a Buddy runs on one of its machines.', 403)
      const grant = context.contribution ?? fail('HOST_REQUIRED', 'Choose a machine shared with the contributor.', 403)
      // Like a Lead, a Buddy runs only on its owner's own machine, in their own account, for Claude and Codex alike: never a
      // machine shared with them, and never a Harness Team account (Ken's ruling, 10-28).
      if (pool.contributorId !== me.id || grant.machineOwnerId !== me.id || pool.hostMachineId || pool.observation?.sessionKind === 'team') {
        fail('BUDDY_OWN_MACHINE', 'A Buddy runs only on your own machine. Pick one of yours from the Swarm\'s Machines list.', 403)
      }
      // Harness cannot yet tell a Buddy's window from another agent's on Windows (security review of #2093): its machine
      // refused every agent's Swarm command while one ran there. None is added on Windows until a real caller check exists
      // (Lead's ruling, 10-29); the machine's own refusal stays as the backstop.
      if (pool.observation?.resources.os === 'Windows') {
        fail('BUDDY_WINDOWS', 'A Buddy cannot run on a Windows machine yet. Pick one of your Macs or Linux machines from the Swarm\'s Machines list.', 403)
      }
      const contributor = person(state, grant.contributorId)
      openBuddyChat(state, project.id, me)
      // Never moved to the Mac's Team account, as a teammate's project otherwise is (machines.ts teamStartRequest).
      const request: AgentStartRequest = { conversationId: chatId, machineId: pool.machineId, engine: command.engine,
        ...(command.model ? { model: command.model } : {}), name: `${who}'s Buddy`, cwd: projectFolder(pool, project), worktree: true,
        requirements: BUDDY_REQUIREMENTS, buddyOf: { personId: me.id, generation: me.generation } }
      const admitted = admitMachineStart(state, request, context.now, undefined, context.teamMachines, context.otherWorkspaceMachines)!
      state.starts ??= []
      if (state.starts.filter(s => !s.harnessId && !s.error).length >= 32) fail('STARTS_PENDING', 'Reconcile pending agent starts before adding more.')
      state.starts.push({ poolGeneration: admitted.generation, id: operationId, creationId: `super-${operationId}`, actorKey: actorKey(actor),
        contributorId: contributor.id, membershipGeneration: contributor.generation, machineOwnerId: grant.machineOwnerId,
        hostGrant: grant.hostGrant ?? null, request, harnessId: null, dispatched: false, error: null, requestedAt: context.now })
      result.startId = operationId
      result.conversationId = chatId
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
        const why = actor.kind === 'agent' && !(start.routeDecisionId && context.routeDecision?.override?.by === 'person') && refusal(startTarget(start.request), start.request.conversationId)
        if (why) fail(why.code, `${why.why} This start was not launched. Route again.`, 403)
        requireWorkerDecisions(state, actor, open(state, start.request.conversationId))
        const grant = context.contribution ?? fail('HOST_REQUIRED', 'The original machine grant is unavailable.', 403)
        if (grant.machineOwnerId !== start.machineOwnerId || (grant.hostGrant ?? null) !== start.hostGrant) {
          fail('CONTRIBUTION_REVOKED', 'The original machine grant was revoked.', 403)
        }
        admitMachineStart(state, start.request, context.now, start, context.teamMachines, context.otherWorkspaceMachines)
        if (start.dispatched || start.error || start.harnessId) fail('START_CLAIMED', 'This native start was already requested. Read its creation status; do not start another.')
        start.dispatched = true
        start.dispatchedAt = context.now
        break
      }
      if (command.type === 'agent.startSettled') {
        if (!start.poolGeneration || !start.harnessId || start.error) fail('START_PENDING', 'This contributed start is not ready to settle.')
        if (!start.poolSettled) message(start.request.conversationId, command.warning
          ? `${start.request.name}: ${command.warning}`
          : start.request.buddyOf ? buddyReady(start.request.name) : `${start.request.name} is ready for an assignment.`, [], null, SYSTEM_ROW)
        start.poolSettled = true
        break
      }
      if (command.type === 'agent.startFailed') {
        if (start.harnessId) fail('ALREADY_STARTED', 'This agent already started.')
        start.error = command.error
        // The Lead is woken, so it starts the work elsewhere once or reports it (cli superTabs/start.ts): written in its own
        // name for nobody, this notice left the round-device group without a worker for an hour (2026-10-27).
        const group = conversation(state, start.request.conversationId)
        const lead = group.leadId && group.agentIds.includes(group.leadId) ? group.leadId : null
        message(group.id, failureNotice(start.request.name, command.error), lead ? [lead] : [], null, SYSTEM_ROW)
        if (start.request.gridModel && !activeWork(group)) steppedUp(group, GRID_START_FAILED)
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
        ...(start.request.gridModel ? { gridModel: start.request.gridModel } : {}),
        ...(start.request.buddyOf ? { buddyOf: start.request.buddyOf } : {}),
        ...(command.startedSession ? { startedSession: { ...command.startedSession, creationId: start.creationId } } : {}) })
      group.agentIds.push(agentId)
      start.harnessId = command.harnessId
      result.agentId = agentId
      // A Buddy always starts on a Swarm machine: its chat hears once it settles, as the Lead does for a worker.
      if (!start.request.buddyOf) message(group.id, start.poolGeneration
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
      // A new terminal is not the session that lost its task, nor one started on a grid model: it reports its own.
      delete target.lostTask
      delete target.gridModel
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
      // Only its own active work holds a decision back, not the active work of a group it sits in (a Reviewer's).
      if (state.conversations.some(c => activeWork(c) && c.assignment?.agentId === target.id)) fail('WORK_ACTIVE', 'Finish active work before releasing this worker.')
      // A Reviewer is never assigned work, so the Lead may keep or stop it at any time.
      if (!target.workDecision && agentRole(target) !== 'reviewer' && !state.conversations.some(c => c.assignment?.agentId === target.id)) {
        fail('WORK_REQUIRED', 'This worker has no finished assignment to release.')
      }
      if (target.workDecision === 'stop' && command.decision !== 'stop') fail('STOP_REQUESTED', 'This worker is stopping. Wait for its execution host.')
      if (command.decision === 'stop' && target.workDecision !== 'stop') target.releaseId = operationId
      // A stop its Lead or a person asks for is theirs, even over the idle check's: its host no longer withdraws it.
      if (command.decision === 'stop') delete target.idleStop
      target.workDecision = command.decision
      if (command.decision === 'keep') target.keptAt = context.now
      break
    }
    case 'agent.stopRefused': {
      // Only the idle check's stop, and only its host: the session's folder had changes by the time it would close it
      // (review of #1807). The worker is as it was, idle again from now. A stop its Lead or a person asked for stays.
      const target = agent(state, command.agentId)
      if (actor.kind !== 'agent' || actor.agentId !== target.id || target.workDecision !== 'stop' || command.releaseId !== target.releaseId || !target.idleStop) {
        fail('STALE_RELEASE', 'Only the execution host can withdraw the current idle stop.', 403)
      }
      if (target.idleStop.previous) target.workDecision = target.idleStop.previous
      else delete target.workDecision
      delete target.releaseId
      delete target.idleStop
      target.keptAt = context.now
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
        if (actor.kind === 'agent') {
          result.releasedBy = actor.machineOwnerId
          // Which machine confirmed it: a team session's retry is answered only for its own (store.ts).
          result.releasedMachineId = target.machineId
        }
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
      if (isBuddyChat(group)) fail('BUDDY_CHAT_FIXED', 'A Buddy chat stays its owner\'s and their Buddy\'s: nobody else is added to it.', 403)
      const member = agent(state, command.agentId)
      if (isBuddy(member)) fail('BUDDY_CHAT_ONLY', 'A Buddy stays in its own chat: its owner\'s alone.', 403)
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
        if (group.audience && ledProject(state, member.id)?.id !== groupProject(state, group).id) {
          fail('AUDIENCE_LEAD_ONLY', 'A private conversation holds only the Lead among agents.', 403)
        }
        // A Reviewer added to a group is handed its review, as an assignment hands a Builder its task.
        if (reviewer) requireTeamWork(state, member.machineId, member.contributorId, groupProject(state, group), context.now, context.teamMachines, context.otherWorkspaceMachines)
        ruled(agentTarget(state, member), group.id, `${who} added ${member.name}`, false, false)
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
      inviter(state, actor, context, 'swarm.invite')
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
      inviter(state, actor, context, 'swarm.manage')
      state.invitations = state.invitations.filter(i => i.id !== command.inviteId)
      break
    case 'member.status':
      setStatus(state, actor, command.status, context.now)
      break
    case 'message.react':
      result.changed = react(postable(state, actor, command.conversationId), command.messageId, command.on, context.reaction)
      break
    case 'member.avatar':
      setMemberAvatar(state, actor, command.avatar, context.avatarUpload)
      break
    case 'agent.avatar':
      setAgentAvatar(state, actor, command.agentId, command.avatar, context.avatarUpload)
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
      // Their Buddies go with them, on whosever machine they run.
      for (const target of state.agents.filter(a => a.contributorId === member.id || a.buddyOf?.personId === member.id)) removeAgent(target)
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
      // A Buddy chat has no Lead: its owner talks to its Buddy.
      const automatic = actor.kind === 'person' ? (replyAgent && group.agentIds.includes(replyAgent) ? replyAgent
        : isBuddyChat(group) ? group.agentIds[0] ?? null : group.leadId) : agentRecipient
      // In the Leads conversation everything posted reaches every other Lead; naming some only adds emphasis.
      const everyLead = isLeads(group) ? group.agentIds.filter(id => actor.kind !== 'agent' || id !== actor.agentId) : []
      const recipients = [...new Set([...command.recipientIds, ...everyLead,
        ...(command.recipientIds.length || everyLead.length || !automatic ? [] : [automatic])])]
      for (const id of recipients) {
        agent(state, id)
        if (!group.agentIds.includes(id)) fail('INVALID_RECIPIENT', 'Choose an agent in this conversation.', 400)
      }
      // A tag would tell a person about a notice they cannot see.
      if (command.agentOnly && (actor.kind !== 'agent' || recipients.length !== 1 || recipients[0] !== actor.agentId || mentions.length)) {
        fail('INVALID_RECIPIENT', 'An agent sends an agent-only notice to itself alone.', 400)
      }
      // The transcript still accepts a human message while the lead is unavailable. The UI can say why no delivery was created.
      message(group.id, command.text, recipients, command.replyTo, command.agentOnly ? AGENT_ONLY : undefined, attachments, mentions)
      recordPost(state, group, actor, { replyTo: command.replyTo, text: command.text, reply: context.reply, openTags: context.openTags }, context.now)
      if (actor.kind === 'agent') renewOwnTask(group, actor.agentId, context.now)
      leadActed(group.id, 'post')
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
      chatOnly(command.conversationId)
      controls(state, actor, command.conversationId)
      // A teammate's work runs only on Team machines: candidates elsewhere leave the decision for its exclusions, with
      // why, so the Lead and people see it. A pick there is refused; a current CLI already leaves those machines out.
      const starter = actor.kind === 'agent' ? agent(state, actor.agentId).contributorId : actor.userId
      const refusals = new Map(command.decision.candidates.flatMap(c => {
        const refusal = candidateRefusal(c, command.conversationId, starter)
        return refusal ? [[c.id, refusal] as const] : []
      }))
      const pickRefusal = refusals.get(command.decision.pick)
      if (pickRefusal) failTeamWork(pickRefusal, ' Route again.')
      const decision = !refusals.size ? command.decision : { ...command.decision,
        candidates: command.decision.candidates.filter(c => !refusals.has(c.id)),
        excluded: [...command.decision.candidates.flatMap(c => refusals.has(c.id) ? [{ title: c.title, reason: refusals.get(c.id)!.reason }] : []),
          ...command.decision.excluded].slice(0, 200) }
      const chosen = decision.candidates.find(c => c.id === decision.pick)!
      const member = chosen.kind === 'member' ? state.agents.find(a => a.id === chosen.agentId) : undefined
      if (member) assignable(conversation(state, command.conversationId), member)
      // Only the pick is checked, so an older CLI that still lists a ruled-out candidate records an allowed pick.
      ruled(member ? agentTarget(state, member) : chosen, command.conversationId, `${who} routed to ${chosen.title}`)
      requireWorkerDecisions(state, actor, open(state, command.conversationId), chosen.kind === 'member' ? chosen.agentId : undefined)
      const via = decision.via === 'jev' ? `Jev ${Math.round((decision.p ?? 0) * 100)}%`
        : decision.via === 'only' ? 'only candidate' : 'by policy order'
      // The step this attempt is comes from the group alone (stepUp.ts), and why a review stays on its Builder's engine from
      // the server's own judgement (rules.ts).
      const step = conversation(state, command.conversationId).stepUp
      const sameEngine = sameEngineReview(state, conversation(state, command.conversationId).reviewOf, member ? agentTarget(state, member) : chosen, policy)
      const { stepUp: _sent, sameEngine: _said, ...made } = decision
      effects.routeDecisions.push({ op: 'create', id: operationId, conversationId: command.conversationId,
        record: { ...made, ...step ? { stepUp: { attempt: step.attempt, reason: step.reason } } : {}, ...sameEngine ? { sameEngine } : {} } })
      result.routeDecisionId = operationId
      // The row quotes the Lead's reason for the task; the verdict's own text stays in the decision record.
      const reason = decision.assessment.why
      message(command.conversationId, `Routed to ${chosen.title} — ${via} · "${reason}"`, [], null, {
        kind: 'route', decisionId: operationId, via: decision.via, p: decision.p, belowFloor: decision.belowFloor, why: reason,
        ...(decision.via === 'order' && decision.fallback ? { fallback: decision.fallback } : {}),
        pick: { id: chosen.id, title: chosen.title },
        alternatives: decision.candidates.filter(c => c.id !== chosen.id).map(c => ({ id: c.id, title: c.title })),
      })
      leadActed(command.conversationId, 'route')
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
      // Its machine may have stopped showing its privacy since the route; the group's Lead is who would start it.
      const leadId = conversation(state, decision.conversationId).leadId
      const teamRefusal = candidateRefusal(chosen, decision.conversationId, state.agents.find(a => a.id === leadId)?.contributorId ?? actor.userId)
      if (teamRefusal) failTeamWork(teamRefusal)
      ruled(chosen.kind === 'member' ? agentTarget(state, agent(state, chosen.agentId!)) : chosen, decision.conversationId, `${who} chose ${chosen.title}`)
      effects.routeDecisions.push({ op: 'override', id: decision.id, override: { by: 'person', actorKey: actorKey(actor), candidateId: chosen.id, reason: command.reason } })
      const lead = conversation(state, decision.conversationId).leadId
      message(decision.conversationId,
        `${sender.name} chose ${chosen.title} instead of ${routeTitle(decision, current)}. Hand this task over to it. Reason: ${command.reason}`,
        lead ? [lead] : [], null, { kind: 'route-override', decisionId: decision.id, by: 'person' })
      break
    }
    case 'work.define': {
      chatOnly(command.conversationId)
      controls(state, actor, command.conversationId)
      const group = open(state, command.conversationId)
      if (activeWork(group)) fail('WORK_ACTIVE', 'Finish or stop the current assignment before changing its acceptance checks.')
      requirable(command.task)
      if (group.assignment) {
        const worker = state.agents.find(a => a.id === group.assignment!.agentId)
        if (worker && !worker.workDecision && group.assignment.status !== 'lost') finishWorker(state, worker.id)
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
      chatOnly(command.conversationId)
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
      // A teammate's agent on a personal machine keeps what it has; it takes no new task for another person's project.
      requireTeamWork(state, worker.machineId, worker.contributorId, home, context.now, context.teamMachines, context.otherWorkspaceMachines)
      requireWorkerDecisions(state, actor, group, worker.id)
      if (worker.workDecision === 'stop') fail('STOP_REQUESTED', 'This worker is stopping. Wait for its execution host.')
      if (state.conversations.some(c => activeWork(c) && c.assignment?.agentId === worker.id)) fail('AGENT_BUSY', 'This agent already owns an active assignment.')
      delete worker.workDecision
      delete worker.releaseId
      // A person's own pick takes a worker that lost its task back into routing (model.ts lostTask); a Lead's does not.
      if (actor.kind === 'person') delete worker.lostTask
      for (const reviewer of state.agents) {
        if (agentRole(reviewer) === 'reviewer' && group.agentIds.includes(reviewer.id) && reviewer.workDecision !== 'stop') delete reviewer.workDecision
      }
      if (!group.agentIds.includes(worker.id)) group.agentIds.push(worker.id)
      rememberAttempt(group)
      group.assignment = { id: operationId, agentId: worker.id, status: 'working', configuration: structuredClone(worker.configuration),
        execution: { machineId: worker.machineId, harnessId: worker.harnessId, machineOwnerId: worker.machineOwnerId }, result: null }
      renewLease(group.assignment, context.now)
      leadActed(group.id, 'assign')
      recordRun(state, group, group.assignment, worker, context.now)
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
      message(group.id, `${group.brief}${carryOver(group)}\n\nAcceptance checks:\n${group.checks.map(c => `- ${c.description}`).join('\n')}`, [worker.id], null, SYSTEM_ROW)
      if (routeNote) effects.messages.push({ id: stableId(operationId, 'route-override'), conversationId: group.id, author: sender,
        text: routeNote.text, replyTo: null, recipients: [], source: { kind: 'route-override', decisionId: routeNote.decisionId, by: 'lead' } })
      break
    }
    case 'work.status': {
      const group = open(state, command.conversationId)
      const assignment = group.assignment
      fenceLost(group, command.assignmentId)
      if (!assignment || assignment.id !== command.assignmentId) fail('STALE_ASSIGNMENT', 'This is no longer the active assignment.')
      if (!activeWork(group)) fail('ATTEMPT_CLOSED', 'Assign a new attempt to continue this work.')
      if (actor.kind === 'agent' && actor.agentId !== assignment.agentId && actor.agentId !== group.leadId) fail('FORBIDDEN', 'Only the assigned agent or coordinating lead can update this work.', 403)
      if (command.status === 'stopped' && !context.confirmedStopped) fail('STOP_UNCONFIRMED', 'Wait for the execution host to confirm the stop.')
      if (assignment.status === 'reconciling' && command.status !== 'stopped') fail('RECONCILING', 'Reconcile the previous assignment before continuing.')
      if (command.status === 'done' && (!command.result || !group.checks.every(c => c.passedBy && c.evidence))) {
        fail('CHECKS_PENDING', 'Completion needs a result and evidence for every acceptance check.')
      }
      let asked: string | undefined
      if (command.ask) {
        if (command.status !== 'needs_human' || !command.result || actor.kind !== 'agent') {
          fail('INVALID_DECISION', 'An agent asks a person for a decision only when its work needs a human, with the question as its result.', 400)
        }
        const { personId, ...choices } = command.ask
        const drafts = askDecisions(state, group, personId, [{ question: command.result, ...choices }],
          { operationId, askerAgentId: actor.agentId, assignmentId: assignment.id })
        // At the cap the status still counts, reaches the Lead and renews the lease; only the question waits (review of #1859).
        if (context.openDecisions == null) {
          effects.decisions = drafts
          asked = context.repeatedDecision ?? drafts[0]!.id
        }
        else effects.result.notAsked = `Not asked ${person(state, personId).email}: ${context.openDecisions} decisions you asked them are still open, and at most ${MAX_OPEN_DECISIONS} can be. Wait for answers before asking more.`
      }
      const changed = assignment.status !== command.status || assignment.result !== command.result || !!command.ask, previous = assignment.status
      assignment.status = command.status
      assignment.result = command.result
      if (command.ask) assignment.askedOf = command.ask.personId
      else if (command.status !== 'needs_human') delete assignment.askedOf
      recordStatus(group, assignment, previous, context.now, changed ? operationId : null, asked)
      if (['done', 'stopped'].includes(command.status)) finishWorker(state, assignment.agentId, group)
      // Finished work shows the worker recovered from a task it lost before.
      if (command.status === 'done') delete state.agents.find(a => a.id === assignment.agentId)?.lostTask
      if (changed) {
        const label = { working: 'Working', needs_human: 'Needs a human', blocked: 'Stuck', review: 'Ready for review', done: 'Done', stopped: 'Stopped' }[command.status]
        const lead = group.leadId
        // Stuck is the Lead's to hear as a human decision is: either way the work waits on someone.
        const tellLead = actor.kind === 'agent' && actor.agentId === assignment.agentId && lead && lead !== actor.agentId &&
          ['needs_human', 'blocked', 'review', 'done'].includes(command.status)
        // Ready for review also wakes the group's Reviewers, whoever marked it.
        const reviewers = command.status !== 'review' ? [] : group.agentIds.filter(id => id !== lead &&
          (actor.kind !== 'agent' || id !== actor.agentId) && state.agents.some(a => a.id === id && agentRole(a) === 'reviewer' && a.workDecision !== 'stop'))
        const asked = !command.ask ? '' : effects.result.notAsked ? `\n\n${effects.result.notAsked}` : `\n\nAsked ${person(state, command.ask.personId).email}.`
        message(group.id, `${label}${command.result ? `\n\n${command.result}` : ''}${asked}`, [...(tellLead ? [lead] : []), ...reviewers], null, SYSTEM_ROW)
        // The Engineer's own Ready for review with a pull request of the project opens its review (autoReview.ts).
        const pullRequest = command.status === 'review' && actor.kind === 'agent' && actor.agentId === assignment.agentId && !group.reviewOf
          && !group.audience && !openReviewOf(state, group) ? projectPullRequest(state, group, command.result) : null
        const opened = pullRequest && openReview(state, group, command.result!, pullRequest, { operationId, now: context.now, engineer: sender,
          // The owner's hard rules hold as for work.assign; the reviewed task's own requirement is its Engineer's, not its Reviewer's.
          mayWork: a => !teamWorkCheck(state, a.machineId, a.contributorId, groupProject(state, group), context.now, context.teamMachines, context.otherWorkspaceMachines)
            && !broken(groupRules(group.id), agentTarget(state, a), machineName, macOf) && !reviewRefusal(state, group.id, agentTarget(state, a), policy) })
        if (opened) effects.messages.push(...opened.messages)
        // Shipped before this command: the leaderboard marks this Done as shipped just above (recordStatus).
        if (command.status === 'done' && shippedAt(conversation(original, group.id)) == null) {
          appendPullRequestUrls(group, [command.result, ...group.checks.map(check => check.evidence)])
          const shipped = shipNotice(state, group, sender, operationId)
          if (shipped) effects.messages.push(shipped)
        }
      }
      if (actor.kind === 'agent') renewOwnTask(group, actor.agentId, context.now)
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
      const lost = assignment.status === 'lost'
      if (!activeWork(group) && !lost) fail('ATTEMPT_CLOSED', 'This attempt has already ended.')
      // A removed worker (reconciling) can never confirm a stop, so this is the only way to close its task; nobody is left to tell.
      // A lost task's agent was told already that its task moved, and does not wait for a decision.
      const gone = assignment.status === 'reconciling' || lost
      assignment.status = 'cancelled'
      assignment.result = command.reason
      if (!lost) finishWorker(state, assignment.agentId, group)
      message(group.id, `${isLead ? 'The Lead' : 'The tab owner'} cancelled this task: ${command.reason.replace(/[.\s]+$/, '')}.${gone ? '' : ' Stop working on it.'}`,
        gone ? [] : [assignment.agentId], null, SYSTEM_ROW)
      break
    }
    case 'work.resume': {
      // Its usage limit has reset: the session that lost this task to it takes it back, unless it was handed on first. Its
      // host asks here before typing into the session (cli superTabs/limitResume.ts), so a task handed on never resumes.
      const group = open(state, command.conversationId)
      const assignment = group.assignment
      if (assignment?.id !== command.assignmentId || assignment.status !== 'lost' || assignment.lost?.at !== command.lostAt) {
        fail('TASK_MOVED', 'This task was handed on or closed, so it does not resume.')
      }
      if (actor.kind !== 'agent' || actor.agentId !== assignment.agentId) fail('FORBIDDEN', 'Only the agent that lost this task resumes it.', 403)
      const worker = agent(state, assignment.agentId)
      const resumeAt = assignment.lost?.resumeAt
      if (!resumeAt) fail('NO_RESUME', 'This task was not lost to a usage limit with a reset time.')
      if (context.now < Date.parse(resumeAt)) fail('LIMIT_NOT_RESET', 'Its usage limit has not reset yet.')
      if (worker.harnessId !== assignment.execution.harnessId) fail('SESSION_CHANGED', 'This agent runs in another session now, so the task does not resume.')
      if (state.conversations.some(c => activeWork(c) && c.assignment?.agentId === worker.id)) fail('AGENT_BUSY', 'This agent already owns an active assignment.')
      assignment.status = 'working'
      delete assignment.lost
      delete group.lostAttempt
      delete worker.lostTask
      renewLease(assignment, context.now)
      effects.messages.push(...toLead(state, worker, { id: stableId(operationId, 'resumed'), conversationId: group.id, author: sender, replyTo: null,
        recipients: [], text: `${worker.displayName ?? worker.name} resumed its task after its usage limit reset.`,
        source: { kind: 'work-resumed', agentId: worker.id, assignmentId: assignment.id } }))
      break
    }
    case 'work.check': {
      const group = open(state, command.conversationId)
      fenceLost(group, command.assignmentId)
      if (!group.assignment || group.assignment.id !== command.assignmentId) fail('STALE_ASSIGNMENT', 'This is no longer the active assignment.')
      if (!activeWork(group)) fail('ATTEMPT_CLOSED', 'Assign a new attempt before changing its acceptance evidence.')
      if (group.assignment.status === 'reconciling') fail('RECONCILING', 'Reconcile the previous assignment before continuing.')
      const check = group.checks.find(c => c.id === command.checkId) ?? fail('NOT_FOUND', 'This acceptance check is unavailable.', 404)
      if (actor.kind === 'agent' && !group.agentIds.includes(actor.agentId)) fail('FORBIDDEN', 'This agent does not participate in the review.', 403)
      if (check.independent && actor.kind === 'agent' && actor.agentId === group.assignment.agentId) fail('INDEPENDENT_REVIEW', 'Another agent or a person must perform this check.')
      check.evidence = command.evidence
      check.passedBy = command.passed ? actorKey(actor) : null
      const run = group.ledger?.runs?.find(r => r.assignmentId === group.assignment!.id), reviewed = run?.firstReview
      recordReview(group, check, command.passed)
      // A cheap attempt whose first review just said Ready no steps up a tier (stepUp.ts).
      if (reviewed === undefined && run?.firstReview === false && cheapAttempt(group, policy)) steppedUp(group, REVIEW_FAILED)
      if (actor.kind === 'agent') recordVerdict(state, group, check, agent(state, actor.agentId), context.now)
      if (actor.kind === 'agent') renewOwnTask(group, actor.agentId, context.now)
      break
    }
  }
  // The state of the task this command touched, in its own write (liveness.ts recordTaskState).
  const touched = 'conversationId' in command ? command.conversationId : command.type === 'agent.start' ? command.request.conversationId
    : 'startId' in command ? state.starts?.find(s => s.id === command.startId)?.request.conversationId : undefined
  const task = typeof touched === 'string' ? state.conversations.find(c => c.id === touched) : undefined
  if (task) recordTaskState(state, task, context.now)
  if (command.type === 'conversation.create' || command.type === 'work.define' || command.type === 'work.assign') {
    alertOverlaps(conversation(state, command.type === 'conversation.create' ? result.conversationId as string : command.conversationId))
  }
  for (const target of original.agents.filter(a => a.workDecision === 'stop')) {
    const acknowledged = command.type === 'agent.remove' && command.agentId === target.id &&
      (actor.kind === 'agent' && actor.agentId === target.id || actor.kind === 'person' && [state.ownerId, target.contributorId].includes(actor.userId))
    if (!acknowledged && !state.agents.some(a => a.id === target.id)) fail('STOP_REQUESTED', 'Wait for the execution host to finish stopping its workers before withdrawing them.')
  }
  syncLeads(state)
  if (context.registrations) requireSingleRegistration(original, state, context.registrations)
  markConfidential(state)
  assignAgentDisplayNames(state.agents)
  // The size limit is per stored part now (parts/commit.ts PART_LIMIT_BYTES); a Swarm as a whole has none.
  // Every row this command writes, whatever its words came from: an older message resent, a rule written before this check.
  for (const draft of effects.messages) {
    const clean = redactCredentials(draft.text)
    if (clean.removed.length) { draft.text = clean.text; removed.push(...clean.removed) }
  }
  if (removed.length) Object.assign(result, credentialResult(removed))
  return effects
}

/** A contribution owns capacity independently of membership. Reuse invalidates every prior stop proof. */
export { swarmGridName } from './model.js'

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
