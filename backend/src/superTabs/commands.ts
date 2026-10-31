import { admitMachineStart, BUDDY_WINDOWS_REFUSAL, buddyHomeFolder, buddyProjectsOn, SWARM_BUDDY_CAPABILITY, cleanupOverdue, dropIdleBuddyMachines, NOT_SWARM_MACHINE, downSince, expireRemoval, expireRemovals, failTeamWork, removalEnded, machineContribution, machineOffline, machineSlots, ownedMachine, productManagerOn, projectFolder, projectsOnMachine, requireTeamWork, teamMachineFor, teamAccountPool, teamPoolsOf, teamStartRequest, teamWorkCheck, type ContributedMachine } from './machines.js'
import { agentDisplayName, assignAgentDisplayNames } from './agentNames.js'
import { keepUsernames, setUsername, swarmUsernames } from './usernames.js'
import { z } from 'zod'
import { tokensByModelSchema } from './costs/tokens.js'
import {
  activeWork, actorKey, agent, appendPullRequestUrls, author, conversation, crossProjectActive, fail, isLeads, person, stableId, numberConversations, nextConversationNumber, renderWorkTask,
  finishWorker, seenMachineIds, SuperTabError, swarmGridName, visibleState, AGENT_ONLY, STATUS_LABELS, forRecipients,
  type Actor, type AgentConfiguration, type AgentStart, type AgentStartRequest, type BuddySessionEntry, type WorkTask, type Agent, type Author, type Check, type CommandEffects, type Conversation, type SuperTabState,
} from './model.js'
import { jobKindOf } from './evidence/jobKind.js'
import { routeRecordSchema, routeTitle, startedAs, type RouteCandidate, type RouteDecision, type RouteFinal, type RouteOverride } from './routeRecord.js'
import { routingOverrideSaveSchema } from './routingPolicy.js'
import { askedInSchema, RULE_MESSAGE_MS, ruleSchema, ruleTextSchema } from './rules.js'
import { MAX_ATTACHMENTS, type Attachment } from './attachments.js'
import { checkMentions, MAX_MENTIONS, namedIn, saysName, textTags, withTags, type MentionTarget } from './mentions.js'
import { answerDecision, askDecisions, checkAsker, decisionChoices, decisionQuestion, MAX_OPEN_DECISIONS, MAX_QUESTIONS, type DecisionTarget } from './decisions.js'
import { leadOf, TERMINAL_KEYS, terminalAlert, terminalRequest, terminalResult, toLead, type TerminalRequest } from './terminal.js'
import { leadNoticeRows, loseTasks, recordTaskState, renewLease, renewOwnTask, restartQuietTime, waitingForReview } from './liveness.js'
import { DELETED_SWARM_COMMANDS, isPersonalSwarm, notThere, SWARM_DELETE_GRACE_MS } from './deletion.js'
import { ABANDONED, askedModel, coordinatorCopy, failureNotice, failureRecipients, MACHINE_REMOVED } from './startFailure.js'
import { noteStartFailed, noteStartSucceeded, resumeEngine } from './engineHealth.js'
import { reviewCapacityNotice } from './reviewCapacity.js'
import { digestStartsAfter, knownTimeZone } from './digest.js'
import { credentialResult, redactCredentials, type CredentialKind } from './credentials.js'
import { dirtyGroups, reportGroups, summarize } from './projectUpdates.js'
import { cloneData } from './cloneData.js'
import { workspaceCan, type WorkspaceRole } from './workspaces.js'
import { fixedOriginal, LEDGER_WEEKS, PULL_REQUEST_URL, recordAsked, recordFix, recordDecision, recordMerged, recordPost, recordProposal, recordReview, recordRun, recordStatus,
  recordReportedModel, recordVerdict } from './leaderboard/record.js'
import { WEEK_MS } from './leaderboard/week.js'
import { react, reactionSchema, type ReactionTarget } from './reactions.js'
import { shipNotice, shippedAt } from './ship.js'
import { assignedNotice, tellBuddies } from './buddyNews.js'
import { bindPullRequestCards, bindTaskCard, pullRequestCard, recordCardMerged } from './cards.js'
import { avatarChoice, setAgentAvatar, setMemberAvatar, setStatus, statusSchema, type AvatarUpload } from './profile.js'
import { BUILT_IN_ROLE_DEFAULTS, agentProjectId, audienceOf, canReadProject, deleteProject, isConfidential, markConfidential, onTeamAccount, requireSingleRegistration, groupProject, inviteLanding, ledProject, manageProject, MAX_ROLES, mutableProjects, placeRules, projectAgent, projectMembers, projectOf, projectsOf, readAgent, readConversation, readProject, sameProject, sharedWithLeads, withRoleDefaults, type SwarmProject, PROJECT_STATUS_MAX } from './projects.js'
import { BUDDY_SESSION_CAPABILITY, chatOwner, endSessionEntry, entryProject, liveSessions, mainBuddyOf, MAX_BUDDY_SESSIONS, MAX_SESSION_WAITING, requireChatOwner, SESSION_ENDED_KIND, sessionAgentsOf, sessionOf, setSessions, type SessionEndReason } from './buddySessions.js'
import { BUDDY_REQUIREMENTS, buddyChatId, buddyReady, chosenBuddyName, isBuddy, isBuddyChat, isSwarmBuddy, isSwarmBuddyChat, MAX_PROPOSAL_ASKS, MAX_PROPOSAL_ATTACHMENTS, openBuddyChat, openSwarmBuddyChat, PM_LINE_KIND, PROPOSAL_ASK_MS, proposalText, renameBuddy, requireBuddyCommand, swarmBuddyChatId } from './buddies.js'
import { BUDDY_OWN_MACHINE_REFUSAL, CODEX_BUDDY_REFUSAL } from './buddyContract.js'
import { launchRefusedLine, leadJoined, leadStartFailed, leadStarting, placeLead } from './leadStart.js'
import { appendRouting, coordinatorNameOf, routingSummary, FIRST_INSTRUCTIONS, FIRST_SUMMARY, instructionsHash, instructionsTextSchema, legacyRoleName, liveNotes, MAX_NOTES, noteTextSchema, roleNameSchema, summarySchema, type PmNote } from './instructions.js'
import { INSTRUCTIONS_TEMPLATE } from './instructionsTemplate.js'

const id = z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/)
/** A route override's reason when its agent gave none: following another candidate needs none (project instructions). */
const NO_REASON = 'No reason given.'
/** What an older client's policy, skill-set, role or rule-removal save answers: accepted, kept nowhere (project instructions,
 *  phase 4, decision 3). The old rules, policy rows and role texts stay in place, unread. */
export const IGNORED_NOTE = 'Routing and roles live in each project\'s instructions now. Update Harness to edit them there.'
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
/** A role's default engine, model and effort (projects.ts RoleDefaults). */
/** What a launch may be asked to run, one short word each, as the CLI checks it (cli lib/launchModel.ts MODEL and EFFORT). */
/** How a CLI from before 2026-10-30 starts the why of a review on its Builder's own engine (cli superTabs/route.ts, removed). */
const OLD_SAME_ENGINE = /^same-engine review: no Reviewer of another engine has quota\. /
const LAUNCH_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:\-[\]]{0,63}$/
const LAUNCH_EFFORT = /^[a-z]{1,16}$/
const roleDefaultsSchema = z.object({ engine: z.enum(['claude', 'codex']), model: z.string().trim().min(1).max(200).optional(),
  effort: z.string().trim().min(1).max(80).optional() }).strict()
const role = z.object({ id: roleId, name: z.string().trim().min(1).max(40), kind: z.enum(['lead', 'builder', 'reviewer']),
  text: z.string().min(1).refine(value => Buffer.byteLength(value) <= 65_536, 'A role\'s skill text is at most 64 KB.'),
  defaults: roleDefaultsSchema.optional() }).strict()
const roleSet = z.array(role).min(1).max(MAX_ROLES)
export const startRequestSchema = z.object({
  conversationId: id, machineId: id, engine: swarmEngine, name: title, cwd: path, role: z.enum(['builder', 'reviewer']).optional(), roleId: roleId.optional(),
  // The role it starts in, free text from the instructions (Agent.roleName). An older client sends none.
  roleName: roleNameSchema.optional(),
  worktree: z.boolean(), branchRef: z.string().max(1024).regex(/^refs\/(heads|remotes)\/[^\s\x00-\x1f\x7f]+$/).optional(),
  model: z.string().trim().min(1).max(200).optional(), effort: z.string().trim().min(1).max(80).optional(),
  permissionMode: z.string().min(1).max(80).optional(), codexHome: path.optional(),
  gridModel: z.string().min(1).max(2048).optional(), gridName: z.string().min(1).max(2048).optional(),
  // The heavy work the task declared (model.ts AgentStartRequest.heavy). An older client sends none.
  heavy: z.array(z.enum(['build', 'e2e'])).min(1).max(2).refine(h => new Set(h).size === h.length, 'Name each kind of heavy work once.').optional(),
  requirements: z.object({ memoryBytes: z.number().int().nonnegative().safe(), diskBytes: z.number().int().nonnegative().safe(),
    maxCpuPercent: z.number().min(0).max(100), tools: z.array(z.string().regex(/^[A-Za-z0-9_.+-]{1,80}$/)).max(20),
    devices: z.array(path).max(20), quotaRequired: z.boolean() }).strict(),
}).strict()
// `independent` is an older client's: stored for older readers, read by nothing (checks are information, project instructions).
const check = z.object({ description: z.string().trim().min(1).max(1000), independent: z.boolean().optional() }).strict()
/** A task's checks as stored, none passed; `independent` false when a newer client leaves it out, as older readers expect it. */
const storedChecks = (checks: ReadonlyArray<z.infer<typeof check>>, operationId: string): Check[] =>
  checks.map((c, i) => ({ description: c.description, independent: c.independent ?? false, id: stableId(operationId, String(i)), evidence: null, passedBy: null }))
const task = z.object({
  goal: z.string().trim().min(1).max(8000), changes: z.string().trim().min(1).max(8000),
  constraints: z.string().trim().min(1).max(8000), owns: z.array(z.string().trim().min(1).max(4096)).min(1).max(40),
  /** model.ts TaskRequirement; `unseenMachines` is only ever read back, never set. */
  requires: z.object({ machines: z.array(id).min(1).max(20).optional(), devices: z.array(path).min(1).max(20).optional() }).strict()
    .refine(r => r.machines || r.devices, 'Require at least one machine or device.').optional(),
  /** model.ts ReviewPlan: what its reviews check first, and 2 for two independent reviews, said in its brief (#2382). */
  review: z.object({ focus: z.string().trim().min(1).max(2000).optional(), reviews: z.union([z.literal(1), z.literal(2)]).optional() }).strict()
    .refine(r => r.focus !== undefined || r.reviews !== undefined, 'Give the review a focus or a number of reviews.').optional(),
}).strict()

export const commandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('machine.contribute'), machineId: id, name: title, cwd: path, scope: z.literal('swarm').optional(), engines: z.array(swarmEngine).min(1).max(2), maxAgents,
    ifMissing: z.literal(true).optional(), teamAccountOnly: z.literal(true).optional() }).strict(),
  z.object({ type: z.literal('machine.pause'), machineId: id, paused: z.boolean() }).strict(),
  z.object({ type: z.literal('machine.engineResume'), machineId: id, engine: z.string().regex(/^[a-z][a-z0-9_-]{0,79}$/), askedIn: askedInSchema.optional() }).strict(),
  z.object({ type: z.literal('machine.remove'), machineId: id }).strict(),
  z.object({ type: z.literal('machine.cleaned'), machineId: id, removalId: id }).strict(),
  z.object({ type: z.literal('localModels.set'), enabled: z.boolean() }).strict(),
  z.object({ type: z.literal('localModels.status'), grid: z.string().min(1).max(160), ready: z.boolean(), error: z.string().trim().max(500).optional() }).strict(),
  z.object({ type: z.literal('tab.rename'), name: title }).strict(),
  z.object({ type: z.literal('tab.project'), machineId: id, project }).strict(),
  z.object({ type: z.literal('tab.pause'), paused: z.boolean() }).strict(),
  // The owner types the Swarm's name to confirm (deletion.ts); the server checks it too, so no client deletes by a slip.
  z.object({ type: z.literal('swarm.delete'), name: z.string().max(160) }).strict(),
  z.object({ type: z.literal('swarm.restore') }).strict(),
  z.object({ type: z.literal('tab.routingPolicy'), policy: routingOverrideSaveSchema.nullable() }).strict(),
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
    throughRevision: z.number().int().nonnegative().safe().optional(),
    text: z.string().trim().min(1).max(PROJECT_STATUS_MAX, `Keep the status card under ${PROJECT_STATUS_MAX.toLocaleString('en-US')} characters: one short line per active task.`).nullable() }).strict()
    .refine(c => (c.through === undefined) !== (c.throughRevision === undefined), 'Acknowledge with through, the map your wake-up names.'),
  z.object({ type: z.literal('project.repository'), projectId: id, repositoryUrl }).strict(),
  // The project's instructions, saved on the revision the writer read (instructions.ts). `askedBy`: the member whose words it
  // carries, required of the coordinator; a person writes in their own.
  z.object({ type: z.literal('instructions.save'), projectId: id, baseRevision: z.number().int().nonnegative().safe(), text: instructionsTextSchema,
    summary: summarySchema, askedBy: id.optional() }).strict(),
  // A small thing a member told the coordinator, kept beside the instructions until it ends, if it does (instructions.ts).
  z.object({ type: z.literal('note.add'), projectId: id, text: noteTextSchema, askedBy: id, expiresAt: z.iso.datetime().optional() }).strict(),
  z.object({ type: z.literal('note.remove'), projectId: id, noteId: id }).strict(),
  // What the project calls its coordinator, as its instructions say (instructions.ts coordinatorNameOf).
  z.object({ type: z.literal('project.coordinatorName'), projectId: id, name: roleNameSchema }).strict(),
  z.object({ type: z.literal('lead.start'), projectId: id, machineId: id.nullable(), engine: swarmEngine,
    model: z.string().trim().min(1).max(200).optional(), effort: z.string().trim().min(1).max(80).optional(),
    branchRef: z.string().max(1024).regex(/^refs\/(heads|remotes)\/[^\s\x00-\x1f\x7f]+$/).optional(), repositoryUrl: repositoryUrl.optional() }).strict(),
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
  // `fixes`: the merged PR this one fixes, for its model's fixes after merge (leaderboard/record.ts recordFix).
  z.object({ type: z.literal('conversation.merged'), conversationId: id, pullRequestUrl: z.string().max(400).regex(PULL_REQUEST_URL),
    mergedAt: z.iso.datetime().optional(), fixes: z.string().max(400).regex(PULL_REQUEST_URL).optional() }).strict(),
  // `launchRefused`: the model and effort a Product Manager's own-machine launch asked for, which that machine refused before
  // launching anything, so it runs its engine's own model (Desktop AgentCreationAttempt; leadStart.ts launchRefusedLine).
  z.object({ type: z.literal('agent.add'), conversationId: id, machineId: id, harnessId: id, name: title, configuration, lead: z.boolean(), project: project.optional(), roleId: roleId.optional(),
    roleName: roleNameSchema.optional(), initialMessage: text.optional(),
    launchRefused: z.object({ model: z.string().regex(LAUNCH_MODEL), effort: z.string().regex(LAUNCH_EFFORT).optional() }).strict().optional() }).strict(),
  z.object({ type: z.literal('agent.start'), request: startRequestSchema, routeDecisionId: id.optional(), overrideReason: reason.optional() }).strict(),
  // A Buddy's proposal for its owner, posted in its project's chat: `conversationId` is its own chat, and `ownerMessageId` its
  // owner's message there asking for it. Its files are its own uploads in that chat, or files its owner sent there (store.ts proposable).
  z.object({ type: z.literal('buddy.propose'), conversationId: id, ownerMessageId: id, goal: z.string().trim().min(1).max(2000),
    scope: z.string().trim().min(1).max(4000), priority: z.enum(['low', 'normal', 'high']),
    attachmentIds: z.array(id).max(MAX_PROPOSAL_ATTACHMENTS, `Attach at most ${MAX_PROPOSAL_ATTACHMENTS} files to a proposal.`).optional() }).strict(),
  // Without `projectId`, the person's one Buddy (Dee, 10-31); an older app names a project, and removes that same one Buddy.
  z.object({ type: z.literal('buddy.remove'), projectId: id.optional() }).strict(),
  // A person's one Buddy chat in the Swarm, opened before any Buddy is (buddies.ts openSwarmBuddyChat); with `projectId`, their
  // older chat in that project, which older apps still show (buddies.ts openBuddyChat).
  z.object({ type: z.literal('buddy.chat'), projectId: id.optional() }).strict(),
  // A person names their own Buddy from its chat, or clears the name with null (buddies.ts renameBuddy).
  z.object({ type: z.literal('buddy.rename'), conversationId: id, name: z.string().max(200).nullable() }).strict(),
  // A person ends a thread session of their own Buddy chat (buddySessions.ts): `ended` from their app, `idle` and `stopped` from
  // their machine's host, which acts as them. Idempotent: a thread with no session is told so and nothing changes.
  z.object({ type: z.literal('buddy.sessionEnd'), conversationId: id, thread: id, reason: z.enum(['ended', 'idle', 'stopped', 'maintenance']) }).strict(),
  // The PM's private line to one person, in their Buddy chat of its project: Buddies replaced Chat with PM (Ken, 10-29).
  z.object({ type: z.literal('person.tell'), personId: id, text: z.string().trim().min(1).max(32_000) }).strict(),
  // A person's own Buddy in a project, on a machine of the Swarm (buddies.ts).
  // `setup`: one of the person's own machines outside the Swarm, prepared by the app as Add machine prepares one (its folder and
  // engines): it is recorded Buddy-only (machines.ts ContributedMachine.buddyOnly). Ignored for a machine already listed.
  // Without `projectId`, the person's one Buddy for the Swarm (Dee, 10-31); an older app's Start names a project, and adds that
  // same one Buddy.
  z.object({ type: z.literal('buddy.create'), projectId: id.optional(), machineId: id, engine: swarmEngine, model: z.string().trim().min(1).max(200).optional(),
    setup: z.object({ name: title, cwd: path, engines: z.array(swarmEngine).min(1).max(2) }).strict().optional() }).strict(),
  z.object({ type: z.literal('agent.startDispatch'), startId: id }).strict(),
  z.object({ type: z.literal('agent.started'), startId: id, harnessId: id, configuration,
    startedSession: z.object({ sessionId: id, createdAt: z.iso.datetime() }).strict().optional() }).strict(),
  // `configuration`: what the agent runs as its start last saw it, so work assigned after the settle records its model (CLI
  // superTabs/start.ts). Absent from a CLI before it, and when the agent reported none in time.
  z.object({ type: z.literal('agent.startSettled'), startId: id, warning: z.string().max(2000).nullable(),
    configuration: configuration.optional() }).strict(),
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
  z.object({ type: z.literal('member.username'), username: z.string().max(64).nullable() }).strict(),
  z.object({ type: z.literal('agent.avatar'), agentId: id, avatar: avatarChoice }).strict(),
  // Text may be empty when the message carries files; applyCommand checks that one of them is there.
  z.object({ type: z.literal('message.send'), conversationId: id, text: z.string().trim().max(32_000), replyTo: id.nullable(), recipientIds: z.array(id).max(16),
    alsoSend: z.literal(true).optional(), attachmentIds: z.array(id).max(MAX_ATTACHMENTS).optional(), mentions: z.array(id).max(MAX_MENTIONS).optional(),
    mentionsIfNoWorker: z.literal(true).optional(), agentOnly: z.literal(true).optional(),
    // A person's thread reply in their own Buddy chat that starts the thread's own Buddy session (buddySessions.ts).
    newSession: z.literal(true).optional(),
    // A New session in one project (spec: The model): it reads that project alone, and is the only Buddy that writes into it.
    // Only with newSession, in a Swarm Buddy chat.
    sessionProjectId: id.optional(),
    // Sent by an app that knows one Buddy per Swarm (Desktop with derived.swarmBuddy): its person writes in their one chat, so the
    // server refuses its write into an older project Buddy chat, which older apps and phones still write in (spec: Older apps).
    oneBuddy: z.literal(true).optional() }).strict(),
  z.object({ type: z.literal('mention.done'), mentionId: id }).strict(),
  z.object({ type: z.literal('message.react'), conversationId: id, messageId: id, emoji: reactionSchema, on: z.boolean(),
    // As message.send's (security review 1 of #2435).
    oneBuddy: z.literal(true).optional() }).strict(),
  z.object({ type: z.literal('decision.ask'), conversationId: id, personId: id, questions: z.array(decisionQuestion).min(1).max(MAX_QUESTIONS) }).strict(),
  // A choice, or `delegate`: the person asked leaves it to the PM, who takes its recommended option (decisions.ts answerDecision).
  z.object({ type: z.literal('decision.answer'), decisionId: id, choice: z.number().int().min(0).optional(), note: z.string().trim().min(1).max(2000).optional(),
    delegate: z.literal(true).optional() }).strict(),
  z.object({ type: z.literal('delivery.resolve'), deliveryId: id, resolution: z.enum(['received', 'resend', 'cancel']) }).strict(),
  z.object({ type: z.literal('work.define'), conversationId: id, brief: text.optional(), task: task.optional(), checks: z.array(check).max(40) }).strict()
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
  'conversation.create': ['title', 'brief', 'task.goal', 'task.changes', 'task.constraints', 'task.owns[]', 'task.review.focus', 'checks[].description'],
  'conversation.rename': ['title'],
  'buddy.rename': ['name'],
  'work.define': ['brief', 'task.goal', 'task.changes', 'task.constraints', 'task.owns[]', 'task.review.focus', 'checks[].description'],
  'work.assign': ['overrideReason'],
  'work.status': ['result'],
  'work.cancel': ['reason'],
  'work.check': ['evidence'],
  'project.create': ['name', 'brief'],
  'project.rename': ['name'],
  'project.report': ['text'],
  'instructions.save': ['text', 'summary'],
  'note.add': ['text'],
  'project.coordinatorName': ['name'],
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
    hostMachineId?: string
    /** The machine's account row is signed in as a Harness Team account (lib/teamSession.ts), with or without a Mac. */
    teamSession?: true }
  /** Loaded from this tab and conversation by the store. */
  /** `thread` is the replied message's thread root, null for a message written before threads (it keeps inline replies), and
   *  `threadSource` that root's source: a Buddy's proposal is news for its Buddy (buddyNews.ts). */
  /** `agentOnly`: a notice people cannot read (model.ts agentOnly), whose thread a reply does not join. */
  reply?: { id: string; conversationId: string; author: Author; createdAt: number; thread?: string | null; threadSource?: Record<string, unknown> | null
    agentOnly?: true
    /** In a Buddy chat: its thread has had a thread session (a `buddySession` reply), read by the store (buddySessions.ts). */
    sessionThread?: true }
  /** For a person's `message.send`: the tags waiting on them in that conversation, read by the store (leaderboard/record.ts). */
  openTags?: Array<{ messageId: string; createdAt: number }>
  /** For `buddy.rename` and `buddy.create`: the names chosen in this Swarm's Buddy chats, quiet ones included, read by the
   *  store (buddies.ts chosenBuddyName): a command loads only the chats it names. */
  buddyNames?: import('./buddies.js').ChosenBuddyName[]
  /** The proposal a new group names as its origin (conversation.create proposalMessageId), loaded from this tab by the store. */
  proposal?: { id: string; conversationId: string; author: Author; source: Record<string, unknown> | null }
  /** The message a Buddy's proposal names as its owner's request, loaded from this tab by the store. */
  proposalAsk?: { id: string; conversationId: string; author: Author; source: boolean; createdAt: number
    /** The thread it is in: a thread session proposes only for its person's message in its own thread. */
    thread?: string | null
    /** The owner's newest message in that chat, which may always be named. */
    newestOwnerMessageId?: string }
  /** For `instructions.save`: the project's stored document, read by the store, which a stale save hands back to merge. */
  instructions?: { revision: number; text: string } | null
  /** For `note.add` and `note.remove`: the project's stored notes, expired ones too, read by the store (instructions.ts). */
  notes?: PmNote[]
  /** The message a Lead quotes as the owner's request for a rule or skill mode change, loaded from this tab by the store. */
  askedIn?: { author: Author; source: boolean; createdAt: number }
  /** The newest messages of this conversation before the one being sent, newest first, loaded by the store for `message.send`. */
  recent?: { author: Author; recipients: string[]; createdAt?: number; source?: unknown }[]
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
  /** Each contributed machine's CLI version as its daemon last connected (store.ts machineFacts), read with [teamMachines]. */
  machineVersions?: Record<string, string>
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

/** Messages in a row between two agents after which their project's Lead is told, once (project instructions, phase 1:
 *  agents talk to each other directly, so nothing else would notice two of them answering each other for ever). */
export const LOOP_NOTICE_AT = 20
const LOOP_WINDOW_MS = 30 * 60_000
/** How much of a failed first review's findings its notice to the coordinator carries. */
const FINDINGS_CHARS = 500
/** The source of the Lead's notice about a pair (LOOP_NOTICE_AT), which pairLoop passes over: counted as a break, it would
 *  start the count again and repeat the notice every LOOP_NOTICE_AT messages (final review of phase 1). */
export const PAIR_LOOP_SOURCE = 'pair-loop'
const isPairLoopNotice = (source: unknown) => (source as { kind?: unknown } | null)?.kind === PAIR_LOOP_SOURCE
/** How many of the newest [recent] messages in a row went between agents [a] and [b], each from one of them to the other,
 *  inside the last LOOP_WINDOW_MS; a person's message, another notice or a message to anyone else ends the run. */
export function pairLoop(recent: CommandContext['recent'] = [], a: string, b: string, now: number): number {
  recent = recent.filter(m => !isPairLoopNotice(m.source))
  const between = (m: NonNullable<CommandContext['recent']>[number]) => m.author.kind === 'agent' && (m.createdAt ?? now) >= now - LOOP_WINDOW_MS
    && (m.author.id === a ? m.recipients.includes(b) : m.author.id === b && m.recipients.includes(a))
  const run = recent.findIndex(m => !between(m))
  return run < 0 ? recent.length : run
}

/** Any agent takes any task, a linked one included, whatever its role (project instructions, phase 4): never a Buddy. */
function assignable(worker: Agent): void {
  if (isBuddy(worker)) fail('BUDDY_NOT_ASSIGNABLE', 'A Buddy is never assigned work: it brainstorms with its owner. Assign another agent.')
}

/** The project an older client's rule.set or rule.remove is for: the one it names, else the one whose chat its askedIn quotes,
 *  else the actor's own (an agent's project, a person's remaining project chat), as the actor may read it. */
export function ruleProject(state: SuperTabState, actor: Actor,
  command: { projectId?: string; askedIn?: { conversationId: string; messageId: string } }): SwarmProject {
  const quoted = command.askedIn && groupProject(state, conversation(state, command.askedIn.conversationId))
  const landing = actor.kind === 'agent' ? agentProjectId(state, agent(state, actor.agentId)) : inviteLanding(state)
  const project = command.projectId ? projectOf(state, command.projectId) : quoted ? quoted
    : actor.kind === 'agent' ? projectOf(state, landing!) : landing ? groupProject(state, conversation(state, landing)) : fail('NOT_FOUND', 'This Swarm has no project.', 404)
  return readProject(state, actor, project.id)
}

/** The Swarm's and project's own settings, and who coordinates, stay with people and the project's coordinator: what else an
 *  agent of the project does is workflow, which its instructions decide (project instructions, phase 4). */
function coordinatorOrPerson(state: SuperTabState, actor: Actor, conversationId = 'lead'): void {
  const group = readConversation(state, actor, conversationId)
  if (actor.kind === 'agent' && ledProject(state, actor.agentId)?.id !== groupProject(state, group).id) {
    fail('COORDINATOR_REQUIRED', 'Of its agents, only this project\'s coordinator changes this setting.', 403)
  }
}

/** Who carries a start on: whoever made it, or, for an agent's start, its project's coordinator (project instructions, phase 4).
 *  A person carries on only their own, as before: anyone else could fail it and close its route hold. Every caller also reads
 *  the start's conversation, and the machine grant still binds its dispatch to the machine's owner. */
export function mayResumeStart(state: SuperTabState, actor: Actor, start: AgentStart): boolean {
  if (start.actorKey === actorKey(actor)) return true
  if (actor.kind === 'person' || !start.actorKey.startsWith('agent:')) return false
  const group = state.conversations.find(c => c.id === start.request.conversationId)
  return !!group && !isLeads(group) && !isSwarmBuddyChat(group) && ledProject(state, actor.agentId)?.id === groupProject(state, group).id
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
    fail('LEAD_PROTECTED', `${target.displayName ?? target.name} is the ${coordinatorNameOf(project)} of project ${project.name}. Delete the project first.`)
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
/** What may name a person's one Buddy chat: posts, reactions, proposals, naming the Buddy and ending a session. */
const SWARM_BUDDY_CHAT_COMMANDS: ReadonlySet<string> = new Set(['message.send', 'message.react', 'buddy.propose', 'buddy.rename', 'buddy.sessionEnd'])

export function authorizeCommandAccess(state: SuperTabState, actor: Actor, command: Command, context: Partial<CommandContext> = {}) {
  if (command.type === 'invite.accept' || command.type === 'agent.sessionClosed' || command.type === 'machine.cleaned') return
  // The owner's alone, checked where they apply: everyone else, a viewer too, gets the answer a missing Swarm gets (deletion.ts).
  if (command.type === 'swarm.delete' || command.type === 'swarm.restore') return
  // Marking one's own tag done changes only one's own list, so a viewer may do it too.
  // Answering a decision asked of oneself changes only that decision, so a viewer may do it too.
  // So does choosing one's own username (usernames.ts).
  if (command.type === 'mention.done' || command.type === 'decision.answer' || command.type === 'member.username') return void author(state, actor)
  const leaving = command.type === 'member.remove' && actor.kind === 'person' && command.userId === actor.userId
  author(state, actor, !leaving)
  const buddy = actor.kind === 'agent' ? state.agents.find(a => a.id === actor.agentId && isBuddy(a)) : undefined
  if (buddy) requireBuddyCommand(buddy, command, state.conversations)
  // An invitation's group is only where the person lands, and invite.create replaces a deleted one (inviteLanding).
  if ('conversationId' in command && command.type !== 'invite.create') {
    const group = readConversation(state, actor, command.conversationId)
    // A person's one Buddy chat is for talking with their Buddy: no task, member or archive there (Dee, 10-31).
    if (isSwarmBuddyChat(group) && !SWARM_BUDDY_CHAT_COMMANDS.has(command.type)) fail('BUDDY_CHAT_ONLY', 'Your Buddy chat is for talking with your Buddy.', 403)
    // An app that knows one Buddy per Swarm writes nothing in an older project Buddy chat: it is kept to read there (security
    // review 1 of #2435). Older apps and phones, which say nothing, still write in it and reach that project's Buddy.
    if ((command.type === 'message.send' || command.type === 'message.react') && command.oneBuddy && isBuddyChat(group) && !isSwarmBuddyChat(group)) {
      fail('BUDDY_CHAT_EARLIER', 'This is an earlier chat, kept to read. Talk to your Buddy in # buddy.', 403)
    }
  }
  if ('projectId' in command && command.projectId) readProject(state, actor, command.projectId)
  if ('agentId' in command) readAgent(state, actor, command.agentId)
  if (command.type === 'agent.start') readConversation(state, actor, command.request.conversationId)
  if ((command.type === 'rule.set' || command.type === 'rule.remove' || command.type === 'project.skills' || command.type === 'tab.tidy'
    || command.type === 'machine.engineResume') && command.askedIn) {
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
/** Whether agent [agentId] may join [group] to post or be named there: an agent of the group's own project, never a Buddy nor
 *  an agent that is stopping, and never into a Buddy chat, the Leads conversation or a private chat, whose members stay as
 *  they are (project instructions, phase 1: agents talk to each other directly, not through the PM). Nor into the project
 *  chat, which is the people's and is never archived, so a joined agent would stay active there for good. A linked task
 *  (reviewOf) takes any agent, whatever its role (phase 4): joining one hands it no work. */
export function joinsProject(state: SuperTabState, group: Conversation, agentId: string): boolean {
  const target = state.agents.find(a => a.id === agentId)
  if (!target || isBuddy(target) || target.workDecision === 'stop' || isBuddyChat(group) || isLeads(group) || group.audience) return false
  const project = groupProject(state, group)
  return agentProjectId(state, target) === project.id && group.id !== project.leadConversationId
}
/** Who may post in a conversation may also upload a file to it. Writer access is checked by `author(state, actor, true)`. The
 *  open group [actor] may post in: an agent of the group's project that is not in it joins it (joinsProject). */
export function postable(state: SuperTabState, actor: Actor, conversationId: string) {
  const group = open(state, conversationId)
  if (actor.kind === 'agent' && !group.agentIds.includes(actor.agentId)) {
    if (!joinsProject(state, group, actor.agentId)) fail('FORBIDDEN', 'This agent does not participate in the conversation.', 403)
    group.agentIds.push(actor.agentId)
  }
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
/** The member whose words an instructions save or a note carries: one in this Swarm who reads the project, never the
 *  machine owner's login by default (design, Identity). */
function askedByOf(state: SuperTabState, project: SwarmProject, personId: string): string {
  const member = state.people.find(p => p.id === personId)
  if (!member || !canReadProject(state, { kind: 'person', userId: member.id, email: member.email }, project)) {
    fail('ASKED_BY_UNAVAILABLE', 'Name the member who asked: a person in this Swarm who can read this project.', 400)
  }
  return member.id
}
/** The Buddy whose proposal a new group comes from: the message must be a Buddy's proposal posted in the project's chat. Its
 *  row is the Swarm's own (buddy.propose), so a Buddy removed since still earns for it. */
function proposalOf(state: SuperTabState, project: SwarmProject, proposal: CommandContext['proposal']): { buddyId: string; messageId: string; personId?: string } {
  const author = proposal?.author
  const buddy = author?.kind === 'agent' ? state.agents.find(a => a.id === author.id) : undefined
  if (!proposal || proposal.conversationId !== project.leadConversationId || proposal.source?.kind !== 'buddy-proposal'
    || author?.kind !== 'agent' || (buddy && !isBuddy(buddy))) {
    fail('PROPOSAL_UNKNOWN', 'Name a Buddy\'s proposal posted in this project\'s chat, or leave the proposal out.', 400)
  }
  // The person it was sent for, as buddy.propose recorded them: the Swarm writes this source, never a sender.
  const personId = typeof proposal.source.personId === 'string' ? proposal.source.personId : undefined
  return { buddyId: author.id, messageId: proposal.id, ...personId ? { personId } : {} }
}
/** The person a proposal was sent for, while they are still in the Swarm and read [project]; otherwise nobody, so a person
 *  who left or lost the project is never credited and opening the group still works (the PM is told to name someone). */
function proposalRequester(state: SuperTabState, project: SwarmProject, personId: string | undefined): string | undefined {
  const member = personId ? state.people.find(p => p.id === personId) : undefined
  return member && canReadProject(state, { kind: 'person', userId: member.id, email: member.email }, project) ? member.id : undefined
}
/** What an agent opening a group for nobody is told, so the person who asked still gets the credit (groups #294, #327). */
export const REQUESTER_UNKNOWN = 'Name the person who asked: conversation.requester with their personId for this group, or requesterId when you open a group.'

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
  const state = cloneData(original)
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

  // A deleted Swarm (deletion.ts) takes only its hosts' confirmations and its owner's restore; anything else, from anyone,
  // answers as for a Swarm that does not exist. The store refuses before this; this holds for every other caller.
  if (state.deletion && !DELETED_SWARM_COMMANDS.has(command.type)) notThere()
  if (command.type === 'swarm.restore') {
    // Only its owner, only while deleted and before its purge; anyone else learns nothing, not even that it was deleted.
    if (!state.deletion || actor.kind !== 'person' || actor.userId !== state.ownerId || Date.parse(state.deletion.purgeAt) <= context.now) notThere()
    delete state.deletion
    result.restored = true
    return effects
  }

  // Acceptance is the only operation a non-member can perform; the verified account email owns the invite.
  if (command.type === 'invite.accept') {
    if (actor.kind !== 'person') fail('FORBIDDEN', 'A person must accept this invitation.', 403)
    const invite = state.invitations.find(i => i.id === command.inviteId)
    if (!invite || invite.email !== actor.email.trim().toLowerCase()) fail('NOT_FOUND', 'This invitation is unavailable.', 404)
    if (invite.expiresAt <= context.now) fail('EXPIRED', 'This invitation expired.', 410)
    const existing = state.people.find(p => p.id === actor.userId)
    if (!existing) {
      state.people.push({ id: actor.userId, email: invite.email, role: invite.role, generation: invite.id })
    }
    state.invitations = state.invitations.filter(i => i.id !== invite.id)
    result.conversationId = invite.conversationId
    // As a link join answers (store.ts joinSwarm): Desktop adds the accepting computer only when this made a member.
    result.alreadyMember = !!existing
    result.role = existing?.role ?? invite.role
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

  // Before any role check: a viewer or an agent is told what anyone without the Swarm is told (deletion.ts).
  if (command.type === 'swarm.delete' && (actor.kind !== 'person' || actor.userId !== state.ownerId)) notThere()
  const leaving = command.type === 'member.remove' && actor.kind === 'person' && command.userId === actor.userId
  const sender = author(state, actor, !leaving && command.type !== 'decision.answer' && command.type !== 'member.username')
  authorizeCommandAccess(state, actor, command, context)
  const rememberAttempt = (group: ReturnType<typeof conversation>) => {
    if (group.assignment) effects.previousAttempts.push(structuredClone({ conversationId: group.id,
      brief: group.brief, checks: group.checks, assignment: group.assignment }))
  }
  const message = (conversationId: string, body: string, recipients: string[] = [], replyTo: string | null = null, source?: Record<string, unknown>,
    attachments?: Attachment[], mentions?: string[], holdMentions?: true) => {
    effects.messages.push({ id: operationId, conversationId, author: sender, text: body, replyTo, recipients, ...(source ? { source } : {}),
      ...(attachments?.length ? { attachments } : {}), ...(mentions?.length ? { mentions } : {}), ...(holdMentions ? { holdMentions } : {}) })
    result.messageId = operationId
  }
  /** A route, start or assignment on a task by any agent of its project, or a post there by its coordinator, with its time:
   *  it ends a person's held tags there (mentions.ts dropHeldTags) and restarts an unstarted start's clock (liveness.ts). Any
   *  agent's post would end them while nobody handled the task (final review). It rides on the write each makes anyway. */
  const leadActed = (conversationId: string, kind: NonNullable<Conversation['leadAction']>['kind']) => {
    const group = state.conversations.find(c => c.id === conversationId)
    if (!group || group.kind || group.audience || actor.kind !== 'agent') return
    const project = groupProject(state, group)
    if (kind === 'post' && ledProject(state, actor.agentId)?.id !== project.id) return
    if (project.leadConversationId !== group.id && projectAgent(state, actor, project.id)) {
      group.leadAction = { kind, at: context.now }
    }
  }
  /** An agent added to a task may work on it, so one added by a post or by opening it takes that project's work only where
   *  conversation.agent would add it (machines.ts teamWorkCheck; spec, "Kept as access"). */
  const teamJoin = (project: SwarmProject, agentId: string) => {
    const member = agent(state, agentId)
    requireTeamWork(state, member.machineId, member.contributorId, project, context.now, context.teamMachines, context.otherWorkspaceMachines)
  }
  /** A session already in the Swarm that a person's agent.add names joins [group] as conversation.agent adds one (security
   *  review S2): a Buddy stays in its own chat; it is of the group's project; a stopping one joins nowhere; a teammate's agent
   *  joins only where it may take the project's work. (A private conversation but a Buddy chat is closed to all:
   *  projects.ts isClosedPmChat.) */
  const joinable = (group: Conversation, member: Agent) => {
    if (isBuddy(member)) fail('BUDDY_CHAT_ONLY', 'A Buddy stays in its own chat: its owner\'s alone.', 403)
    sameProject(state, group, member)
    if (member.workDecision === 'stop') fail('STOP_REQUESTED', 'This agent is stopping. Wait for its execution host.')
    requireTeamWork(state, member.machineId, member.contributorId, groupProject(state, group), context.now, context.teamMachines, context.otherWorkspaceMachines)
  }
  /** The project chat is the people's and is never archived: its work, name and records are its coordinator's or a person's,
   *  as its members are (conversation.agent, joinsProject; security review L2). A task's are any agent's of its project. */
  const projectChatWork = (conversationId: string) => {
    if (projectsOf(state).some(p => p.leadConversationId === conversationId)) coordinatorOrPerson(state, actor, conversationId)
  }
  /** An agent starts or assigns only what the route chose; a person may still do either by hand. */
  /** A private conversation is chat only (design section 4.8). */
  const chatOnly = (conversationId: string) => {
    if (state.conversations.find(c => c.id === conversationId)?.audience) fail('AUDIENCE_CHAT_ONLY', 'A private conversation is chat only.', 400)
  }
  /** A settling start's own reading of what its agent runs (agent.startSettled): taken as the agent's report, as
   *  agent.configuration takes its host's, so work assigned after the settle records its model. Only from the machine
   *  grant that started it, for the same engine, never for a grid model (its start names it); anything else is left to the
   *  host's own reports. */
  const settledConfiguration = (start: AgentStart, observed: AgentConfiguration) => {
    const grant = context.contribution
    if (!grant || grant.machineOwnerId !== start.machineOwnerId || grant.contributorId !== start.contributorId
      || (grant.hostGrant ?? null) !== start.hostGrant) return
    const worker = state.agents.find(a => a.harnessId === start.harnessId && a.machineId === start.request.machineId)
    if (!worker || worker.gridModel || observed.engine !== worker.configuration.engine) return
    if (Object.entries(observed).every(([key, value]) => worker.configuration[key as keyof AgentConfiguration] === value)) return
    worker.configuration = observed
    worker.configurationVersion = operationId
    recordReportedModel(state, worker)
  }
  /** Any other row the system writes in the actor's name. Without a source, a notice written as the owner read as the owner
   * asking, and a Lead could quote it to change rules (review of #1594). Only `message.send` and an initial message stay plain. */
  const SYSTEM_ROW = { kind: 'system' }
  /** Agent bookkeeping, a routing line or an agent joined or ready: no one's in the project chat, which carries only what
   *  people read or decide on (the Lead's ruling, 2026-10-29); a task's chat keeps it as its record. */
  const bookkeeping = (conversationId: string, source: Record<string, unknown>) =>
    projectsOf(state).some(p => p.leadConversationId === conversationId) ? forRecipients(source) : source
  const who = sender.kind === 'person' ? sender.name.split('@')[0]! : sender.name
  /** [project], when the actor is its coordinator: the one agent that keeps its notes and names itself (design, PM notes). */
  const coordinatorOf = (project: SwarmProject, why = 'Of its agents, only this project\'s coordinator does this.'): SwarmProject => {
    if (actor.kind !== 'agent' || ledProject(state, actor.agentId)?.id !== project.id) fail('COORDINATOR_REQUIRED', why, 403)
    return project
  }
  /** Moves the project's notes revision, so an open Instructions panel reads them again. */
  const noteChanged = (projectId: string) => {
    mutableProjects(state)
    const stored = projectOf(state, projectId)
    stored.notesRevision = (stored.notesRevision ?? 0) + 1
  }
  /** A requirement names only machines its setter sees, so it never names one to a reader who could not (model.ts TaskRequirement). */
  const requirable = (task: WorkTask | undefined) => {
    const machines = task?.requires?.machines
    if (!machines) return
    const seen = seenMachineIds(visibleState(state, actor, context.now))
    if (machines.some(m => !seen.has(m))) fail('MACHINE_UNKNOWN', 'Name a machine of this Swarm that you can see.', 400)
  }
  /** A grid attempt's first review failed (project instructions, phase 4, decision 8): its coordinator hears what happened, with
   *  the model and the findings; nothing is cancelled, and the findings reach the agent as they do any verdict. The task keeps
   *  the step up (goals piece 4): the route reads it to leave the grid out of the next attempt (cli routeCheapFirst.ts), and
   *  route records carry it for the costs report (costs/read.ts stepUps). Its reason names only the model, never the findings,
   *  since every reader of the task sees it. */
  const reviewFailed = (group: Conversation, model: string, evidence: string) => {
    const worker = state.agents.find(a => a.id === group.assignment?.agentId)
    if (!worker) return
    group.stepUp = { attempt: (group.stepUp?.attempt ?? 1) + 1, floor: 3, reason: `Its first review failed on ${model} on the Swarm's grid.`, at: context.now, carry: '' }
    const findings = evidence.length > FINDINGS_CHARS ? `${evidence.slice(0, FINDINGS_CHARS - 1)}…` : evidence
    effects.messages.push(...leadNoticeRows(toLead(state, worker, { id: stableId(operationId, 'review-failed'), conversationId: group.id, author: sender,
      replyTo: null, recipients: [], text: `#${group.number} ${group.title}: its first review failed. It ran on ${model} on the Swarm's grid. Findings: ${findings}`,
      source: { kind: 'review-failed', conversationId: group.id } })))
  }
  /** Accepted, kept nowhere: an older client's save of what each project's instructions say now (IGNORED_NOTE). */
  const ignored = () => Object.assign(result, { ignored: true, note: IGNORED_NOTE })
  /** A new revision of [project]'s instructions from revision [current], with one line in its chat in the writer's name, for
   *  the member who asked when that is someone else: what instructions.save and an older client's rule.set write. */
  const saveInstructions = (project: SwarmProject, current: number, text: string, summary: string, askedBy: string) => {
    const hash = instructionsHash(text)
    mutableProjects(state)
    Object.assign(projectOf(state, project.id), { instructionsRevision: current + 1, instructionsHash: hash })
    effects.instructions = { projectId: project.id, revision: current + 1, hash, text, summary,
      writtenBy: { kind: sender.kind, id: sender.id }, askedBy, at: context.now }
    // A save for someone else, a coordinator's or a person's, names the member it was for, so the record never names an asker
    // the chat line did not (review of phase 2).
    const asked = askedBy !== sender.id ? ` for ${person(state, askedBy).email.split('@')[0]}` : ''
    message(project.leadConversationId, `${who} changed the instructions${asked}: ${summary}${/[.!?]$/.test(summary) ? '' : '.'}`, [], null,
      { kind: 'instructions', projectId: project.id, revision: current + 1 })
    Object.assign(result, { projectId: project.id, revision: current + 1, hash })
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
  /** The candidate a start or assignment should match, and whether it does. Following another needs no reason (project
   *  instructions, phase 4: the route is advice); it is still recorded as an override, with the reason when one is given. */
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
    const override: RouteOverride | undefined = matched ? undefined : { by: 'lead', actorKey: actorKey(actor), reason: reasonText ?? NO_REASON }
    effects.routeDecisions.push({ op: 'final', id: decision.id, final: finalOf(decision), ...(override ? { override } : {}), ...(assignmentId ? { assignmentId } : {}) })
    // The chat line: who chose what instead of the route's pick, and why when they said.
    const instead = (done: string) => `${who} ${done} instead of ${expected.title}.${reasonText ? ` Reason: ${reasonText}` : ''}`
    return { decision, expected, override, instead }
  }
  /** Why a route candidate cannot take a teammate's work in [conversationId], or null (machines.ts teamWorkCheck). A
   *  member runs under its own contributor's grant; a new agent under the contribution's, or off the Machines list under
   *  the grant of whoever will start it ([starter]). */
  const candidateRefusal = (candidate: RouteCandidate, conversationId: string, starter: string) => {
    const project = groupProject(state, conversation(state, conversationId))
    const member = candidate.kind === 'member' ? state.agents.find(a => a.id === candidate.agentId) : undefined
    if (candidate.kind === 'member' && !member) return null
    // A new agent never starts on a Buddy-only machine; an agent its person added there runs as one on a machine outside the Swarm.
    if (!member && state.machines?.some(m => m.machineId === candidate.machineId && m.buddyOnly)) return { code: 'NOT_SWARM_MACHINE' as const, reason: NOT_SWARM_MACHINE }
    // A new agent on a Mac for a teammate's project runs in the Mac's Harness Team account (machines.ts teamStartRequest).
    const machineId = member?.machineId ?? teamMachineFor(state, candidate.machineId, project, context.teamAccountsIdle, context.teamMachines)
    const contributor = member?.contributorId ?? state.machines?.find(m => m.machineId === machineId)?.contributorId ?? starter
    return teamWorkCheck(state, machineId, contributor, project, context.now, context.teamMachines, context.otherWorkspaceMachines)
  }
  /**
   * Routes a `message.send` in Buddy chat [chat] (buddySessions.ts): whether it is in a session thread (`inSession`, its reply
   * tagged so the main Buddy never reads it) and which session hears it (`to`, null while that session starts: its delivery is
   * written when it joins). Starts the thread's session for a person's `newSession`. Refuses a session's post outside its own
   * thread, the main Buddy's in a session thread, and a person's plain reply in a thread whose session ended.
   */
  const routeBuddySession = (chat: Conversation): { inSession: boolean; to: string | null; project?: string } => {
    if (command.type !== 'message.send') return { inSession: false, to: null }
    // A project is named only when starting a session in the one Buddy chat.
    if (command.sessionProjectId && (!command.newSession || !isSwarmBuddyChat(chat))) {
      fail('BUDDY_SESSION_CHAT', 'Name a project only to start a New session in your Buddy chat.', 400)
    }
    // A person's own top-level New session message roots its own thread (the message is that thread's root, its id the
    // thread's): its session starts there, and the main Buddy never hears it.
    const roots = actor.kind === 'person' && !!command.newSession && !command.replyTo
    const thread = roots ? operationId : command.replyTo && !context.reply?.agentOnly ? context.reply?.thread ?? null : null
    const self = actor.kind === 'agent' ? state.agents.find(a => a.id === actor.agentId) : undefined
    const entry = sessionOf(state, chat, thread)
    if (self?.buddySession) {
      if (!thread || thread !== self.buddySession.thread || command.alsoSend || command.newSession) {
        fail('BUDDY_SESSION_THREAD', 'Answer only in your own thread: post with --reply-to a message in it.', 403)
      }
      return { inSession: true, to: null, ...(self.buddySession.projectId ? { project: self.buddySession.projectId } : {}) }
    }
    if (self) {
      if (entry || context.reply?.sessionThread) fail('BUDDY_SESSION_THREAD', 'That thread has its own session. Answer in the main chat or a thread without one.', 403)
      if (command.newSession) fail('BUDDY_SESSION_CHAT', 'Only the chat\'s person starts a session.', 403)
      return { inSession: false, to: null }
    }
    if (actor.kind !== 'person') return { inSession: false, to: null }
    if (command.newSession) {
      const owner = requireChatOwner(state, chat, actor.userId)
      if (!thread) fail('BUDDY_SESSION_CHAT', 'Start a session from a message of your own, or a reply in a thread.', 400)
      if (entry) fail('BUDDY_SESSION_EXISTS', 'This thread already has its own session.')
      if (command.alsoSend) fail('BUDDY_SESSION_THREAD', 'A session\'s thread stays in the thread.', 400)
      if (state.paused) fail('PAUSED', 'New work is paused in this Super Tab.')
      const main = mainBuddyOf(state, chat)
      if (!main || downSince(state, main, context.now)) fail('BUDDY_SESSION_NO_BUDDY', 'Start your Buddy first: a session runs beside it.')
      // Only Claude Code runs a Buddy's guard hook. A Codex Buddy added before Codex was refused (buddy.create) must not
      // start Codex sessions without it (security review 1 of #2345).
      if (main.configuration.engine !== 'claude') fail('BUDDY_SESSION_ENGINE', 'Sessions need a Buddy running Claude Code.', 403)
      const pool = machineContribution(state, main.machineId)
      if (!pool?.observation?.capabilities?.includes(BUDDY_SESSION_CAPABILITY)) {
        fail('BUDDY_SESSION_UNSUPPORTED', `Update Harness on ${pool?.name ?? 'your Buddy\'s computer'} to start sessions.`)
      }
      if (liveSessions(state, chat).length >= MAX_BUDDY_SESSIONS) fail('BUDDY_SESSIONS_FULL', `${MAX_BUDDY_SESSIONS} sessions are running. End one to start another.`)
      const contributor = person(state, main.contributorId)
      // In the one Buddy chat a session works in one project its person reads, or, with none named, as the main Buddy does
      // (spec: The model). A project's own chat has its project.
      const swarm = isSwarmBuddyChat(chat)
      const project = swarm ? command.sessionProjectId ? readProject(state, actor, command.sessionProjectId) : undefined : groupProject(state, chat)
      const me = person(state, owner.id)
      const folder = project ? { cwd: projectFolder(pool, project), worktree: true, ...(swarm ? { buddyNarrow: true as const } : {}) }
        : { cwd: buddyHomeFolder(pool, me), worktree: false, buddyScope: 'swarm' as const, buddyProjects: buddyProjectsOn(state, pool, me) }
      const request: AgentStartRequest = { conversationId: chat.id, machineId: main.machineId, engine: main.configuration.engine,
        ...(main.configuration.model ? { model: main.configuration.model } : {}), ...(main.configuration.effort ? { effort: main.configuration.effort } : {}),
        name: main.displayName ?? main.name, ...folder, requirements: BUDDY_REQUIREMENTS,
        buddyOf: { personId: owner.id, generation: owner.generation },
        // The main chat's sequence before this message: the session's excerpt reads up to it (buddySessions.ts sessionContext).
        // A project session of the one chat names its project: it reads that project alone and no excerpt.
        buddySession: { thread, from: chat.messageSeq ?? chat.lastMessageSequence, ...(swarm && project ? { projectId: project.id } : {}) } }
      // A slot for it on a Buddy-only machine, as for its main Buddy (buddy.create).
      if (pool.buddyOnly) pool.maxAgents = machineSlots(state, pool) + 1
      const admitted = admitMachineStart(state, request, context.now, undefined, context.teamMachines, context.otherWorkspaceMachines)!
      state.starts ??= []
      if (state.starts.filter(s => !s.harnessId && !s.error).length >= 32) fail('STARTS_PENDING', 'Reconcile pending agent starts before adding more.')
      state.starts.push({ poolGeneration: admitted.generation, id: operationId, creationId: `super-${operationId}`, actorKey: actorKey(actor),
        contributorId: contributor.id, membershipGeneration: contributor.generation, machineOwnerId: main.machineOwnerId,
        hostGrant: main.hostGrant ?? null, request, harnessId: null, dispatched: false, error: null, requestedAt: context.now })
      setSessions(chat, [...liveSessions(state, chat), { thread, startId: operationId, at: context.now, waiting: [operationId] }])
      result.startId = operationId
      return { inSession: true, to: null, ...(swarm && project ? { project: project.id } : {}) }
    }
    if (entry) {
      if (command.alsoSend) fail('BUDDY_SESSION_THREAD', 'A session\'s thread stays in the thread.', 400)
      if (!entry.agentId) {
        if ((entry.waiting?.length ?? 0) >= MAX_SESSION_WAITING) fail('BUDDY_SESSION_STARTING', 'This thread\'s session is still starting. Send again in a moment.')
        entry.waiting = [...entry.waiting ?? [], operationId]
      }
      const project = entryProject(state, entry)
      return { inSession: true, to: entry.agentId ?? null, ...(project ? { project } : {}) }
    }
    if (thread && context.reply?.sessionThread) fail('BUDDY_SESSION_ENDED', 'This thread\'s session ended. Send with New session to continue.')
    return { inSession: false, to: null }
  }

  /** Ends [entry]'s session in [chat]: its agent leaves as any removed agent does (its host closes it and deletes its folder),
   *  a start not yet running fails, and a quiet line in its thread says why, to nobody (buddySessions.ts). */
  const endBuddySession = (chat: Conversation, entry: BuddySessionEntry, reason: SessionEndReason, detail?: string) => {
    // Its line first, while its agent can still say it (buddySessions.ts endSessionEntry); then its agent closes.
    effects.messages.push(...endSessionEntry(state, chat, entry, reason, detail))
    const target = entry.agentId ? state.agents.find(a => a.id === entry.agentId) : undefined
    if (target) removeAgent(target)
    const start = state.starts?.find(s => s.id === entry.startId && !s.harnessId && !s.error)
    if (start) start.error = 'Its session ended before it started.'
  }

  /**
   * The person's one Buddy answers in their older project chat [chat] (spec: Older apps): a Buddy of that project alone, on the
   * one Buddy's machine, engine and name, in that project's folder and never widened (buddyNarrow). This message waits for it;
   * one already starting takes it too. Nothing while they have no one Buddy, or its host can't run one, as before.
   */
  const startOldChatBuddy = (chat: Conversation) => {
    if (command.type !== 'message.send' || actor.kind !== 'person') return
    const owner = requireChatOwner(state, chat, actor.userId)
    const pending = state.starts?.find(s => s.request.conversationId === chat.id && !s.request.buddySession && !s.harnessId && !s.error)
    if (pending) {
      if ((pending.request.buddyWaiting?.length ?? 0) < MAX_SESSION_WAITING) pending.request.buddyWaiting = [...pending.request.buddyWaiting ?? [], operationId]
      return
    }
    const main = state.agents.find(a => isSwarmBuddy(a) && !a.buddySession && a.buddyOf!.personId === owner.id && a.buddyOf!.generation === owner.generation)
    if (!main || downSince(state, main, context.now) || main.configuration.engine !== 'claude' || state.paused) return
    const pool = machineContribution(state, main.machineId)
    if (!pool?.observation?.capabilities?.includes(SWARM_BUDDY_CAPABILITY)) return
    const project = groupProject(state, chat)
    const contributor = person(state, main.contributorId)
    const request: AgentStartRequest = { conversationId: chat.id, machineId: main.machineId, engine: main.configuration.engine,
      ...(main.configuration.model ? { model: main.configuration.model } : {}), ...(main.configuration.effort ? { effort: main.configuration.effort } : {}),
      name: main.displayName ?? main.name, cwd: projectFolder(pool, project), worktree: true, requirements: BUDDY_REQUIREMENTS,
      buddyOf: { personId: owner.id, generation: owner.generation }, buddyNarrow: true, buddyWaiting: [operationId] }
    if (pool.buddyOnly) pool.maxAgents = machineSlots(state, pool) + 1
    // A machine that cannot take it now (full, offline, paused) starts nothing: the phone's message is still kept, as it was
    // before any Buddy answered there (security review 2 of #2435: its slots are counted, touches.ts).
    let admitted: ReturnType<typeof admitMachineStart>
    try { admitted = admitMachineStart(state, request, context.now, undefined, context.teamMachines, context.otherWorkspaceMachines) } catch (error) {
      if (error instanceof SuperTabError && error.status < 500) return
      throw error
    }
    if (!admitted) return
    state.starts ??= []
    if (state.starts.filter(s => !s.harnessId && !s.error).length >= 32) return
    state.starts.push({ poolGeneration: admitted.generation, id: operationId, creationId: `super-${operationId}`, actorKey: actorKey(actor),
      contributorId: contributor.id, membershipGeneration: contributor.generation, machineOwnerId: main.machineOwnerId,
      hostGrant: main.hostGrant ?? null, request, harnessId: null, dispatched: false, error: null, requestedAt: context.now })
    result.startId = operationId
  }

  /** Ends every project session of [project] in a one Buddy chat whose person no longer reads it, and fails those starting. */
  const endLostProjectSessions = (project: SwarmProject) => {
    for (const chat of state.conversations.filter(isSwarmBuddyChat)) {
      const owner = chatOwner(chat), member = owner && state.people.find(p => p.id === owner.id && p.generation === owner.generation)
      if (member && canReadProject(state, { kind: 'person', userId: member.id, email: member.email }, project)) continue
      for (const entry of liveSessions(state, chat)) {
        const agentProject = entry.agentId ? state.agents.find(a => a.id === entry.agentId)?.buddySession?.projectId : undefined
        const startProject = state.starts?.find(s => s.id === entry.startId)?.request.buddySession?.projectId
        if ((agentProject ?? startProject) === project.id) endBuddySession(chat, entry, 'access')
      }
    }
    // By the agents too: the one Buddy's session in an older project chat (startOldChatBuddy), and a session whose chat is
    // quiet and not loaded here, go in this same write (security review 1 of #2435).
    for (const target of state.agents.filter(a => a.buddyNarrow && a.projectId === project.id)) {
      const owner = state.people.find(p => p.id === target.buddyOf!.personId && p.generation === target.buddyOf!.generation)
      if (!owner || !canReadProject(state, { kind: 'person', userId: owner.id, email: owner.email }, project)) removeAgent(target)
    }
    for (const start of state.starts ?? []) {
      const owner = start.request.buddyOf && state.people.find(p => p.id === start.request.buddyOf!.personId)
      if (start.request.buddyNarrow && !start.harnessId && !start.error && startProjectOf(start) === project.id
        && !(owner && canReadProject(state, { kind: 'person', userId: owner.id, email: owner.email }, project))) start.error = 'Its person no longer reads its project.'
    }
  }
  /** The project a one-project Buddy's start works in: a project session's, or its older project chat's. */
  const startProjectOf = (start: AgentStart) => start.request.buddySession?.projectId
    ?? state.conversations.find(c => c.id === start.request.conversationId && !isSwarmBuddyChat(c))?.projectId

  /** Deleting its project is the only removal that takes a Lead. `close: false` when its host already closed the session. */
  const removeAgent = (target: Agent, { lead = false, close = true } = {}) => {
    // A Buddy chat's record of its sessions (buddySessions.ts): a session leaves it, and a main Buddy takes its sessions with it.
    for (const chat of state.conversations.filter(c => isBuddyChat(c) && c.agentIds.includes(target.id))) {
      if (target.buddySession) setSessions(chat, (chat.buddySessions ?? []).filter(e => e.agentId !== target.id))
      else if (target.buddyOf) {
        // Each session's thread says it ended, as every end does (security review 1 of #2345): an app then offers New session there.
        for (const entry of [...chat.buddySessions ?? []]) effects.messages.push(...endSessionEntry(state, chat, entry, 'removed'))
        for (const start of state.starts ?? []) {
          if (start.request.conversationId === chat.id && start.request.buddySession && !start.harnessId && !start.error) start.error = 'Its Buddy was removed before it started.'
        }
        for (const other of sessionAgentsOf(state, chat)) removeAgent(other)
        delete chat.buddySessions
      }
    }
    // The one Buddy takes its sessions in the person's older project chats with it (startOldChatBuddy).
    if (isSwarmBuddy(target) && !target.buddySession) {
      for (const other of state.agents.filter(a => a.buddyNarrow && !a.buddySession && a.buddyOf?.personId === target.buddyOf!.personId)) removeAgent(other)
      for (const start of state.starts ?? []) {
        if (start.request.buddyNarrow && !start.request.buddySession && start.request.buddyOf?.personId === target.buddyOf!.personId && !start.harnessId && !start.error) {
          start.error = 'Its Buddy was removed before it started.'
        }
      }
    }
    if (!lead) protectLead(state, target.id)
    if (close && !state.closingSessions?.some(c => c.agentId === target.id && c.harnessId === target.harnessId)) {
      // A confidential session in a Team account keeps the account for its project until its host confirms the close, which
      // it does once the session's data there is deleted (security re-check 2 of #2089).
      const held = onTeamAccount(state, target) && isConfidential(state, target) ? { heldFor: agentProjectId(state, target), since: context.now } : {}
      // Its machine part outlives the Buddy-only record while this closes: it stays as private as the record (read/changes.ts).
      const hidden = state.machines?.some(m => m.machineId === target.machineId && m.buddyOnly) ? { buddyOnly: true as const } : {}
      ;(state.closingSessions ??= []).push({ agentId: target.id, machineId: target.machineId, harnessId: target.harnessId, machineOwnerId: target.machineOwnerId,
        ...held, ...hidden })
    }
    state.agents = state.agents.filter(a => a.id !== target.id)
    effects.cancelledAgents.push(target.id)
    for (const group of state.conversations) {
      group.agentIds = group.agentIds.filter(a => a !== target.id)
      if (group.leadId === target.id) group.leadId = null
      if (group.assignment?.agentId === target.id && activeWork(group)) group.assignment.status = 'reconciling'
    }
  }

  /** Records [me]'s own machine [machineId], prepared by the app ([setup]), as Buddy-only (machines.ts buddyOnly): its host
   *  then reads the Swarm, starts the Buddy and reports it, and nothing else of the Swarm runs there or reads it. */
  const addBuddyMachine = (machineId: string, setup: NonNullable<Extract<Command, { type: 'buddy.create' }>['setup']>, me: { id: string; generation: string }) => {
    // Its last Buddy's folders are still being deleted there: a new one would lose its own (machine.contribute does the same).
    if (state.machineCleanups?.some(c => c.machineId === machineId)) {
      fail('MACHINE_CLEANING', 'This machine is still cleaning up after your last Buddy there. Try again in a minute.')
    }
    if ((state.machines?.length ?? 0) >= 32) fail('MACHINES_FULL', 'This Swarm cannot take another machine.')
    const pool: ContributedMachine = { machineId, name: setup.name, cwd: setup.cwd, scope: 'swarm', engines: [...new Set(setup.engines)],
      maxAgents: 1, contributorId: me.id, membershipGeneration: me.generation, generation: operationId, paused: false, buddyOnly: true }
    ;(state.machines ??= []).push(pool)
    return pool
  }

  /** Takes a machine out of the Swarm with every agent on it (machine.remove, or its owner leaving): each agent is removed
   *  like one agent, its pending starts fail, routing rules lose it, and a contributed machine stays paused and cleaning
   *  until its host deletes the Swarm's folders there — or leaves at once when that host is offline
   *  (spec 2026-10-23-remove-machine.md). */
  const removeMachine = (machineId: string, pool: ContributedMachine | undefined, members: Agent[], how: (machine: string) => string, lead = false) => {
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
    for (const target of members) removeAgent(target, { lead })
    if (pool) {
      // Paused, so routing in clients that do not know removals stops offering it too.
      pool.removal = { id: operationId, state: 'cleaning', requestedAt: new Date(context.now).toISOString() }
      pool.paused = true
    }
    // Its capacity left with it: no slot there is held for anyone now.
    state.harnessReservations = state.harnessReservations?.filter(r => r.machineId !== machineId)
    state.releasedHarnesses = state.releasedHarnesses?.filter(r => r.machineId !== machineId)
    const machine = pool?.name ?? 'a machine'
    // Routing lives in each project's instructions (project instructions), but reads still serve the old rules, older CLIs
    // still route by them and a rollback would enforce them: for this release a machines rule still loses the machine, and
    // one left with none goes. Nothing is said: no newer reader shows them (final review).
    for (const rule of state.rules ?? []) {
      if (rule.rule.kind === 'machines') rule.rule.machineIds = rule.rule.machineIds.filter(m => m !== machineId)
    }
    state.rules = state.rules?.filter(r => r.rule.kind !== 'machines' || r.rule.machineIds.length)
    if (!state.rules?.length) delete state.rules
    for (const { group, names, task } of affected) {
      const lead = group.leadId && group.agentIds.includes(group.leadId) ? group.leadId : null
      const join = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0]
      effects.messages.push({ id: stableId(operationId, 'machine-removed', machineId, group.id), conversationId: group.id, author: sender,
        text: `${how(machine)}, and ${join} with it.${task ? ` Its task "${group.title}" has no agent now.` : ''}`,
        replyTo: null, recipients: lead ? [lead] : [], source: pool ? { kind: 'machine-removed', machine } : SYSTEM_ROW })
    }
    // Its host is offline and cannot acknowledge, so the fallback applies at once: the machine leaves the list
    // now and its cleanup waits for its next connection (spec 2026-10-23-remove-machine.md).
    if (pool?.removal && machineOffline(pool, context.now)) effects.messages.push(...removalEnded(state, pool, expireRemoval(state, pool, context.now)))
    return removed
  }

  /** Projects in one Swarm changed the same code without knowing it (2026-10-23). When a task is created, defined or assigned,
   *  its Leads hear once per pair of tasks that it owns code another shared project's active task owns too: each Lead in its
   *  own project chat, as a notice only it reads (the Leads conversation is removed, model.ts leadsRemoved). */
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
      const text = `"${group.title}" (${project.name}, ${named(ours)}) and "${other.title}" (${theirs.name}, ${named(their)}) both change `
        + `${shared.join(', ')}.`
      // Written as that Lead, like its other notices (liveness.ts work-stalled): a sender from another project reads none of it.
      for (const [chat, lead] of [[project, ours], [theirs, their]] as const) {
        if (!lead || actor.kind === 'agent' && lead.id === actor.agentId) continue
        effects.messages.push({ id: stableId(operationId, 'overlap', pair, chat.id), conversationId: chat.leadConversationId,
          author: { kind: 'agent', id: lead.id, name: lead.name, displayName: agentDisplayName(state.agents, lead.id), membershipGeneration: lead.membershipGeneration },
          text, replyTo: null,
          recipients: [lead.id], source: { kind: 'overlap', conversationIds: [group.id, other.id] } })
      }
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
      const project = coordinatorOf(readProject(state, actor, command.projectId), 'The project\'s coordinator writes its progress updates.')
      if (command.throughRevision !== undefined && command.throughRevision > (state.sequenceBase ?? 0)) {
        fail('THROUGH_REQUIRED', 'Acknowledge with through, the map of workgroups your latest wake-up names.', 400)
      }
      summarize(state, project, command.through ?? Object.fromEntries(reportGroups(state, project).map(g => [g.id, command.throughRevision!])))
      // The text is the project's status card, replacing the one before; it posts nothing to the chat (Dee, 2026-10-31).
      // Without text the report only acknowledges, and the card stays.
      if (command.text) {
        mutableProjects(state)
        projectOf(state, project.id).status = { text: command.text, at: new Date(context.now).toISOString(), by: (actor as Extract<Actor, { kind: 'agent' }>).agentId }
      }
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
      // It starts on a copy of the built-in instructions as revision 1, the team's own to change (design, The built-in template).
      projects.push({ id: operationId, name: command.name, ownerId: actor.userId, leadConversationId,
        visibility: command.visibility, members: [], updateMinutes: 5, skillMode: 'default', ...FIRST_INSTRUCTIONS })
      effects.instructions = { projectId: operationId, revision: 1, hash: FIRST_INSTRUCTIONS.instructionsHash, text: INSTRUCTIONS_TEMPLATE,
        summary: FIRST_SUMMARY, writtenBy: { kind: 'person', id: actor.userId }, askedBy: actor.userId, at: context.now }
      state.conversations.push({ id: leadConversationId, projectId: operationId, title: 'Lead', leadId: null,
        agentIds: [], archived: false, brief: command.brief, checks: [], assignment: null, lastMessageSequence: 0 })
      result.projectId = operationId
      result.conversationId = leadConversationId
      break
    }
    case 'lead.start': {
      if (actor.kind !== 'person') fail('HUMAN_REQUIRED', 'A person starts a project\'s coordinator.', 403)
      if (state.paused) fail('PAUSED', 'New work is paused in this Swarm.')
      const project = manageProject(state, actor, command.projectId)
      const home = conversation(state, project.leadConversationId)
      const name = coordinatorNameOf(project)
      if (home.leadId && home.agentIds.includes(home.leadId)) fail('LEAD_EXISTS', `This project already has its ${name}.`)
      if (leadStarting(state, project.id)) fail('LEAD_STARTING', `This project's ${name} is already starting.`)
      if (!project.repository?.repositoryUrl && !command.repositoryUrl) fail('REPOSITORY_REQUIRED', 'Choose the repository this project works in.', 400)
      const { type: _type, projectId: _projectId, machineId, ...request } = command
      // Only its person knows which machine stays on (Ken, 10-29): a Desktop from before asked for the first free one.
      if (!machineId) fail('MACHINE_REQUIRED', `Choose the machine the ${name} runs on.`, 400)
      // Its person named no model: the coordinator's built-in default for this engine (Claude Opus 5.5 at xhigh), since the
      // project's instructions cannot choose a model before any agent reads them (project instructions, design call).
      const asked = withRoleDefaults(request, BUILT_IN_ROLE_DEFAULTS.lead)
      const start = placeLead(state, project, person(state, actor.userId), machineId, asked, operationId, context)
      Object.assign(result, { startId: start.id, machineId: start.request.machineId })
      break
    }
    case 'project.skills':
      // Skill modes are the project's instructions now: whoever reads the project is answered, and nothing is kept.
      readProject(state, actor, command.projectId)
      ignored()
      break
    case 'project.roles.create':
    case 'project.role.set':
    case 'project.role.remove':
    case 'project.roles.reset':
      // Custom role sets are the project's instructions now: the person who manages the project is answered, nothing kept.
      manageProject(state, actor, command.projectId)
      ignored()
      break
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
      // Its sessions still starting in people's one Buddy chats go with it (their chats belong to no project).
      for (const start of state.starts ?? []) {
        if (start.request.buddySession?.projectId === project.id && !start.harnessId && !start.error) start.error = 'Its project was deleted.'
      }
      deleteProject(state, actor, command.projectId)
      break
    }
    case 'project.sharing': {
      const project = manageProject(state, actor, command.projectId)
      project.members = projectMembers(state, command.memberIds)
      project.visibility = command.visibility
      // Whoever no longer reads it loses it from their Buddy in this same write (spec: Access): its sessions in their one Buddy
      // chat end, and its threads and PM lines there hide (buddies.ts hiddenProjectRow).
      endLostProjectSessions(project)
      break
    }
    case 'project.cadence': {
      const project = readProject(state, actor, command.projectId)
      if (actor.kind !== 'person') fail('HUMAN_REQUIRED', 'A person chooses the update cadence.', 403)
      mutableProjects(state)
      projectOf(state, project.id).updateMinutes = command.minutes
      break
    }
    case 'instructions.save': {
      // Any member who reads the project writes its instructions, or its coordinator for one (design, Who changes it): the
      // server checks access and the revision only, never what the text says.
      const project = readProject(state, actor, command.projectId)
      if (actor.kind === 'agent') {
        if (ledProject(state, actor.agentId)?.id !== project.id) fail('COORDINATOR_REQUIRED', 'A member, or this project\'s coordinator for one, changes its instructions.', 403)
        if (!command.askedBy) fail('ASKED_BY_REQUIRED', 'Name the member who asked for this change (askedBy).', 400)
      }
      const askedBy = command.askedBy ? askedByOf(state, project, command.askedBy) : (actor as Extract<Actor, { kind: 'person' }>).userId
      const current = project.instructionsRevision ?? 0
      if (command.baseRevision !== current) {
        // Refused with the text it missed, to merge and save again (design, Concurrency): never two writers' texts kept silently.
        // Revision 0 is a project without a document yet, which runs on the template (design, Migration).
        const stored = !current ? INSTRUCTIONS_TEMPLATE : context.instructions?.revision === current ? context.instructions.text : null
        fail('INSTRUCTIONS_STALE', `The instructions changed since revision ${command.baseRevision}. Merge your change into revision ${current} and save again.`,
          409, { revision: current, text: stored })
      }
      const hash = instructionsHash(command.text)
      if (current && hash === project.instructionsHash) {
        Object.assign(result, { projectId: project.id, revision: current, hash, unchanged: true })
        break
      }
      saveInstructions(project, current, command.text, command.summary, askedBy)
      break
    }
    case 'note.add': {
      // The coordinator keeps what it is told freely: no approval and no chat line, so a note costs nobody attention (design,
      // PM notes). A person tells it, or removes one.
      const project = coordinatorOf(readProject(state, actor, command.projectId), 'Only this project\'s coordinator keeps its notes. Tell it what to note.')
      const askedBy = askedByOf(state, project, command.askedBy)
      const expiresAt = command.expiresAt ? Date.parse(command.expiresAt) : null
      if (expiresAt !== null && expiresAt <= context.now) fail('NOTE_EXPIRED', 'This note would end before it is kept. Give it a later end, or none.', 400)
      if (liveNotes(context.notes ?? [], context.now).length >= MAX_NOTES) {
        fail('NOTES_FULL', `A project keeps at most ${MAX_NOTES} notes. Remove one, or write what lasts into the instructions.`)
      }
      effects.notes = { projectId: project.id, add: { id: operationId, text: command.text, askedBy, at: context.now, expiresAt } }
      noteChanged(project.id)
      result.noteId = operationId
      break
    }
    case 'note.remove': {
      const project = readProject(state, actor, command.projectId)
      if (actor.kind === 'agent') coordinatorOf(project)
      // An expired note is gone already, as one never kept.
      const removed = liveNotes(context.notes ?? [], context.now).find(n => n.id === command.noteId) ?? fail('NOT_FOUND', 'This note is unavailable.', 404)
      effects.notes = { projectId: project.id, removeId: removed.id }
      noteChanged(project.id)
      // A wrong or stale note a member removed: the coordinator is told it was, so it stops following it (design, PM notes).
      const home = conversation(state, project.leadConversationId)
      if (actor.kind === 'person' && home.leadId && home.agentIds.includes(home.leadId)) {
        message(home.id, `${who} removed your note: "${removed.text}"`, [home.leadId], null, { kind: 'note-removed' })
      }
      result.noteId = removed.id
      break
    }
    case 'project.coordinatorName': {
      // The coordinator sets it from the instructions; the project's owner may too. It names nothing else's role.
      const project = readProject(state, actor, command.projectId)
      if (actor.kind === 'agent') coordinatorOf(project)
      else manageProject(state, actor, project.id)
      mutableProjects(state)
      projectOf(state, project.id).coordinatorName = command.name
      break
    }
    case 'project.digest': {
      const project = readProject(state, actor, command.projectId)
      const lead = conversation(state, project.leadConversationId).leadId
      if (actor.kind !== 'person' && !(actor.kind === 'agent' && actor.agentId === lead)) fail('FORBIDDEN', 'A person or the project’s Lead sets its morning digest.', 403)
      if (!knownTimeZone(command.timeZone)) fail('TIME_ZONE', 'Name a time zone such as Asia/Ho_Chi_Minh.', 400)
      mutableProjects(state)
      const stored = projectOf(state, project.id)
      // Off stays off: the default (digest.ts defaultDigest) is not filled in again.
      if (command.time === null) {
        delete stored.digest
        stored.digestOff = true
      } else {
        delete stored.digestOff
        // Set after today's time, the first digest comes tomorrow rather than at once; moved later on a day its digest went
        // out, it stays sent for today.
        const lastOn = digestStartsAfter(command.time, command.timeZone, context.now, stored.digest?.lastOn)
        stored.digest = { time: command.time, timeZone: command.timeZone, ...lastOn ? { lastOn } : {} }
      }
      break
    }
    case 'tab.project': {
      coordinatorOrPerson(state, actor)
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
      // A Mac's Team account never joins through a Buddy-only record: that Mac is not in the Swarm (security review 2 of #2234).
      if (context.contribution?.hostMachineId && state.machines.some(m => m.machineId === context.contribution!.hostMachineId && m.buddyOnly)) {
        fail('NOT_SWARM_MACHINE', NOT_SWARM_MACHINE, 403)
      }
      if (command.ifMissing) {
        if (actor.userId !== state.ownerId && !mac) fail('OWNER_REQUIRED', 'Only the Swarm owner adds a machine automatically.', 403)
        // A Buddy-only record is not the machine in the Swarm: it becomes an ordinary one below.
        if (cleaning || state.machines.some(m => m.machineId === command.machineId && !m.buddyOnly)) break
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
          text: `${[...names].join(', ')} never started and will not start now.` })
      }
      if (state.starts?.some(s => s.request.machineId === command.machineId && (!s.harnessId || (s.poolGeneration && !s.poolSettled)) && !s.error)) fail('STARTS_PENDING', 'Reconcile pending starts before changing this contribution.')
      // Saving settings sends the whole contribution again; only machine.pause changes its pause (review of #2084).
      const paused = mac?.paused ?? state.machines.find(m => m.machineId === command.machineId)?.paused ?? false
      // Added as its person joined (Desktop's join): teammates' work only through its Harness Team account, for as long as
      // it stays contributed. Saving its settings sends the contribution without the field, and must not drop the rule.
      const teamAccountOnly = command.teamAccountOnly || state.machines.find(m => m.machineId === command.machineId)?.teamAccountOnly
      state.machines = state.machines.filter(m => m.machineId !== command.machineId)
      state.machineCleanups = state.machineCleanups?.filter(c => c.machineId !== command.machineId)
      if (!state.machineCleanups?.length) delete state.machineCleanups
      const host = context.contribution?.hostMachineId
      state.machines.push({ machineId: command.machineId, name: mac?.name ?? command.name, cwd: command.cwd, engines: [...new Set(command.engines)],
        maxAgents: mac?.maxAgents ?? command.maxAgents, ...(command.scope ? { scope: command.scope } : {}),
        contributorId: actor.userId, membershipGeneration: contributor.generation, generation: operationId, paused,
        ...(host ? { hostMachineId: host } : {}), ...(teamAccountOnly ? { teamAccountOnly: true as const } : {}) })
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
    case 'machine.engineResume': {
      // A suspended engine (engineHealth.ts) is offered again at its owner's word: theirs, or a Lead's passing on a chat
      // message they wrote in the last day, as routing rules are. No new button: the only visible change is the struck name.
      const pool = machineContribution(state, command.machineId) ?? fail('NOT_FOUND', 'This machine has not been contributed.', 404)
      const asked = actor.kind === 'agent' && command.askedIn && context.askedIn
      const ownerAsked = !!asked && asked.author.kind === 'person' && asked.author.id === pool.contributorId && !asked.source
        && context.now - asked.createdAt <= RULE_MESSAGE_MS && !!state.conversations.find(c => c.id === command.askedIn!.conversationId)?.leadId
        && state.conversations.find(c => c.id === command.askedIn!.conversationId)!.leadId === actor.agentId
      if (!(actor.kind === 'person' && actor.userId === pool.contributorId) && !ownerAsked) {
        fail('OWNER_REQUIRED', "Only the machine's owner, or the Lead passing on a chat message the owner wrote in the last day, resumes an engine there.", 403)
      }
      resumeEngine(pool, command.engine)
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
      // gone. Of agents, only the first project's coordinator does.
      if (actor.kind === 'agent') coordinatorOrPerson(state, actor)
      state.name = command.name
      break
    case 'tab.pause':
      if (actor.kind === 'agent') coordinatorOrPerson(state, actor)
      state.paused = command.paused
      break
    case 'swarm.delete': {
      // Its owner alone; a member, an agent or anyone else is answered as for a Swarm that does not exist (deletion.ts).
      if (actor.kind !== 'person' || actor.userId !== state.ownerId) notThere()
      if (isPersonalSwarm(state)) fail('PERSONAL_SWARM', 'Your Personal Swarm cannot be deleted.', 409)
      if (command.name.trim() !== state.name.trim()) fail('NAME_MISMATCH', 'Type the Swarm\'s name exactly to delete it.', 400)
      // A launch already under way would arrive with nowhere to go; it finishes in moments (removeMachine says the same).
      if (state.starts?.some(s => s.dispatched && !s.harnessId && !s.error)) fail('STARTS_PENDING', 'An agent is starting in this Swarm. Try again in a moment.')
      // Every machine leaves as its owner removing it would: its agents' sessions close and its host deletes the Swarm's
      // folders there. Product Managers go too. A Buddy-only machine goes once its Buddy has (dropIdleBuddyMachines).
      for (const pool of (state.machines ?? []).filter(m => !m.removal && !m.buddyOnly)) {
        removeMachine(pool.machineId, pool, state.agents.filter(a => a.machineId === pool.machineId), machine => `${machine} left the Swarm when it was deleted`, true)
      }
      // Agents on no contributed machine (shared sessions, Buddies), each with its session.
      for (const target of [...state.agents]) if (state.agents.some(a => a.id === target.id)) removeAgent(target, { lead: true })
      for (const start of state.starts ?? []) if (!start.harnessId && !start.error) start.error = 'Its Swarm was deleted.'
      state.deletion = { at: new Date(context.now).toISOString(), by: actor.userId, purgeAt: new Date(context.now + SWARM_DELETE_GRACE_MS).toISOString() }
      result.purgeAt = state.deletion.purgeAt
      break
    }
    case 'tab.tidy': {
      swarmOwnerAsked(command.askedIn, 'turns tidying on or off')
      if (command.enabled) delete state.tidy
      else state.tidy = false
      break
    }
    case 'tab.routingPolicy':
      if (actor.kind !== 'person' || actor.userId !== state.ownerId) fail('OWNER_REQUIRED', 'Only the Super Tab owner can change its routing policy.', 403)
      ignored()
      break
    case 'rule.set': {
      // An older CLI's rule: its words become one more line of the project's Routing, saved as any change to the instructions
      // (project instructions, phase 4, decision 3). The rule itself is kept nowhere.
      const project = ruleProject(state, actor, command)
      if (actor.kind === 'agent' && ledProject(state, actor.agentId)?.id !== project.id) {
        fail('COORDINATOR_REQUIRED', 'A member, or this project\'s coordinator for one, changes its instructions.', 403)
      }
      // A person asks for themselves; the coordinator passes on the person whose own chat message it quotes.
      const asked = command.askedIn && context.askedIn
      const askedBy = actor.kind === 'person' ? actor.userId
        : asked && asked.author.kind === 'person' && !asked.source && groupProject(state, conversation(state, command.askedIn!.conversationId)).id === project.id
          ? askedByOf(state, project, asked.author.id)
          : fail('ASKED_BY_REQUIRED', 'Quote the chat message of the person who asked for this rule (askedIn): the instructions record who asked.', 400)
      const current = project.instructionsRevision ?? 0
      // Revision 0 runs on the template (design, Migration); otherwise the stored document of this revision, read by the store.
      const stored = !current ? INSTRUCTIONS_TEMPLATE : context.instructions?.revision === current ? context.instructions.text
        : fail('INSTRUCTIONS_UNAVAILABLE', 'This project\'s instructions cannot be read now. Try again in a moment.', 503)
      saveInstructions(project, current, appendRouting(stored, command.text), routingSummary(command.text), askedBy)
      break
    }
    case 'rule.remove':
      ruleProject(state, actor, { askedIn: command.askedIn, projectId: command.projectId ?? state.rules?.find(r => r.id === command.ruleId)?.projectId })
      ignored()
      break
    case 'conversation.create': {
      const brief = command.task ? renderWorkTask(command.task) : command.brief ?? ''
      const project = readProject(state, actor, command.projectId ??
        (actor.kind === 'agent' ? agentProjectId(state, agent(state, actor.agentId)) : 'lead'))
      if (state.paused) fail('PAUSED', 'New work is paused in this Super Tab.')
      requirable(command.task)
      if (command.audience) pmChatClosed()
      const leadId = conversation(state, project.leadConversationId).leadId
      if (command.reviewOf) {
        // A task links to another task of its own project, a linked one included, and to nothing else: the project chat, a
        // Buddy chat, a private chat, the Leads conversation and other projects' tasks read as missing, archived or not, so the
        // answer never tells whether another project's task exists (project instructions, phase 4). Several may link at once.
        const reviewed = state.conversations.find(c => c.id === command.reviewOf)
        if (!reviewed || isLeads(reviewed) || reviewed.kind || reviewed.audience || reviewed.id === project.leadConversationId
          || groupProject(state, reviewed).id !== project.id) fail('NOT_FOUND', 'This conversation is unavailable.', 404)
        open(state, reviewed.id)
      }
      // Who asked: the person named, else the one a Buddy's proposal was sent for, else a person opening it themselves.
      const proposal = command.proposalMessageId ? proposalOf(state, project, context.proposal) : undefined
      const requesterId = command.requesterId ? requester(state, project, command.requesterId)
        : proposalRequester(state, project, proposal?.personId) ?? (actor.kind === 'person' ? actor.userId : undefined)
      const number = nextConversationNumber(state)
      state.groupCounter = number
      // The agent that opens a task is in it, so an Engineer that opens its own review can post there and pass its checks.
      const creator = actor.kind === 'agent' && actor.agentId !== leadId ? [actor.agentId] : []
      for (const id of creator) teamJoin(project, id)
      state.conversations.push({ id: operationId, ...(state.projects ? { projectId: project.id } : {}),
        number, title: command.title, leadId, agentIds: [...leadId ? [leadId] : [], ...creator],
        archived: false, brief, ...(command.task ? { task: command.task } : {}), ...(command.reviewOf ? { reviewOf: command.reviewOf } : {}),
        assignment: null, lastMessageSequence: 0,
        checks: storedChecks(command.checks, operationId),
      })
      recordAsked(state.conversations.at(-1)!, requesterId, context.now)
      if (proposal) recordProposal(state.conversations.at(-1)!, { buddyId: proposal.buddyId, messageId: proposal.messageId })
      result.conversationId = operationId
      result.number = number
      // A build group an agent opens for nobody credits nobody when it ships: say so, as the PM can still name them.
      if (actor.kind === 'agent' && !requesterId && !command.reviewOf) {
        result.requesterUnknown = true
        result.warnings = [REQUESTER_UNKNOWN]
      }
      if (brief) {
        message(operationId, brief, [], null, SYSTEM_ROW)
        bindTaskCard(state.conversations.at(-1)!, effects.messages.at(-1)!)
      }
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
      for (const [at, each] of (line ?? []).entries()) effects.messages.push({ id: stableId(operationId, at ? `delegated-${at}` : 'delegated'), replyTo: null, recipients: [], ...each })
      result.decisionId = answer.id
      break
    }
    case 'conversation.rename':
      projectChatWork(command.conversationId)
      open(state, command.conversationId).title = command.title
      break
    case 'conversation.requester': {
      chatOnly(command.conversationId)
      projectChatWork(command.conversationId)
      const group = open(state, command.conversationId)
      if (command.personId) group.requesterId = requester(state, groupProject(state, group), command.personId)
      else delete group.requesterId
      break
    }
    case 'conversation.merged': {
      chatOnly(command.conversationId)
      projectChatWork(command.conversationId)
      // An archived group still takes the record: a backfill names work finished days ago.
      const group = conversation(state, command.conversationId)
      // It awards points, so among people only an owner records it; reading the group is not enough. Any agent of the
      // project may (project instructions, phase 4), on any task, a linked one included.
      const owners = [state.ownerId, groupProject(state, group).ownerId]
      if (actor.kind === 'person' && !owners.includes(actor.userId)) fail('FORBIDDEN', 'Among people, only an owner records a merge.', 403)
      const mergedAt = command.mergedAt === undefined ? context.now : Date.parse(command.mergedAt)
      if (mergedAt > context.now || mergedAt <= context.now - (LEDGER_WEEKS - 1) * WEEK_MS) {
        fail('MERGE_TIME', 'Record a merge from the last four weeks, not one still to come.', 400)
      }
      // One refusal for every link it cannot take, so a link never tells what another project or a private chat holds.
      const original = command.fixes === undefined ? undefined : fixedOriginal(state, group, command.fixes, mergedAt)
        ?? fail('FIX_LINK', 'No merged pull request in this project matches that link within the last 14 days.', 400)
      const shippedAt = group.ledger?.shippedAt, linked = group.pullRequestUrls?.includes(command.pullRequestUrl)
      appendPullRequestUrls(group, [command.pullRequestUrl])
      recordMerged(group, mergedAt)
      // Like a Slack app's update: the card shows the merge, and the line goes in the card's thread, once per pull request.
      // Without a card yet, the group's first ship or a new link still says so, and the line becomes the card. A fix of an
      // earlier merge says so once more.
      const fixed = original ? recordFix(original, group, mergedAt) : false
      const card = pullRequestCard(group, command.pullRequestUrl)
      if (fixed || (card ? card.mergedAt === undefined : !linked || group.ledger!.shippedAt !== shippedAt)) {
        message(group.id, `Merged ${command.pullRequestUrl}${original ? `, a fix of ${command.fixes}` : ''}`, [], card?.messageId ?? null, SYSTEM_ROW)
        const posted = effects.messages.at(-1)!
        if (card) posted.thread = card.messageId
        else bindPullRequestCards(group, posted)
      }
      recordCardMerged(group, command.pullRequestUrl, mergedAt)
      break
    }
    case 'conversation.archive': {
      const group = conversation(state, command.conversationId)
      if (group.id === groupProject(state, group).leadConversationId) fail('LEAD_CONVERSATION', 'The Lead conversation stays available.')
      if (command.archived && activeWork(group)) fail('WORK_ACTIVE', 'Resolve the active assignment before archiving this conversation.')
      group.archived = command.archived
      // Archived by hand, it leaves the active set until it is reopened (spec, Archive), once its reports are acknowledged:
      // until then the sweep leaves it in the active set, where the report check sees it (design section 3.6).
      if (command.archived && !dirtyGroups(state, groupProject(state, group)).includes(group)) group.dormant = true
      else delete group.dormant
      break
    }
    case 'agent.add': {
      if (!['claude', 'codex'].includes(command.configuration.engine)) fail('SWARM_ENGINE', 'A Swarm agent runs only Claude Code or Codex.', 400)
      // A person shares a session already running (Desktop sends this as its person); an agent starts a new one. From an
      // agent it re-added a person's Buddy to a task, added to the project chat, and registered any session of its
      // contributor's machines, the Swarm's or not, past conversation.agent's checks (security review S2).
      if (actor.kind !== 'person') fail('HUMAN_REQUIRED', 'A person adds a session already running. Start a new agent instead.', 403)
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
      // By machine and current terminal: a rebound member (agent.rebind) keeps its old id.
      const existing = state.agents.find(a => a.machineId === command.machineId && a.harnessId === command.harnessId)
      const agentId = existing?.id ?? stableId(command.machineId, command.harnessId)
      // A session already in the Swarm joins as conversation.agent adds it. Its machine is listed already: an agent runs
      // there. A new session may be on any machine of the person's, as their start may (agent.start).
      if (isBuddyChat(group)) fail('BUDDY_CHAT_FIXED', 'A Buddy chat stays its owner\'s and their Buddy\'s: nobody else is added to it.', 403)
      if (existing) joinable(group, existing)
      // An older Desktop adds a session in a custom role (roleId): kept, with a Reviewer role's kind, for older readers, and
      // read by no command. The role name it means is the agent's (instructions.ts legacyRoleName).
      const roleKind = command.roleId ? project.roles?.find(r => r.id === command.roleId)?.kind : undefined
      const roleName = command.roleName ?? legacyRoleName(project, { roleId: command.roleId })
      if (existing?.workDecision === 'stop' && command.lead) fail('STOP_REQUESTED', 'This worker is stopping. Wait for its execution host.')
      // A Harness Team account hosting a Product Manager serves only its project, and one is never added where another
      // project's work runs (machines.ts productManagerOn, as admitMachineStart holds a start; security re-review of #2089).
      const teamPool = teamAccountPool(machineContribution(state, command.machineId))
      if (!existing && teamPool) {
        const held = productManagerOn(state, command.machineId)
        if (held && held !== project.id) fail('TEAM_ACCOUNT_HELD', 'This machine\'s Harness Team account runs another project\'s Product Manager, so it takes only that project\'s work for now.', 403)
        if (command.lead && [...projectsOnMachine(state, command.machineId)].some(id => id !== project.id)) {
          fail('TEAM_ACCOUNT_BUSY', 'This machine\'s Harness Team account runs other projects\' agents, so it cannot host this Product Manager now.', 409)
        }
      }
      // A confidential session removed from a Team account stays held until its host confirms its data deleted: added back,
      // even to the project it is held for, the hold would end with its private chats still there (review of #2142).
      if (!existing && state.closingSessions?.some(c => c.machineId === command.machineId && c.harnessId === command.harnessId && c.heldFor)) {
        fail('TEAM_ACCOUNT_HELD', 'This session held people\'s private chats and is being deleted from this machine\'s Harness Team account, so it cannot be added back.', 403)
      }
      if (!existing) reserveHarnessSlot(state, command.machineId, command.harnessId, operationId)
      // Added back before its host closed it: the session stays open.
      if (!existing) dropClosing(state, c => c.machineId !== command.machineId || c.harnessId !== command.harnessId)
      if (!existing) state.agents.push({ id: agentId, machineId: command.machineId, harnessId: command.harnessId,
        ...(state.projects ? { projectId: project.id } : {}),
        machineOwnerId: grant.machineOwnerId, contributorId: grant.contributorId, membershipGeneration: contributor.generation,
        hostGrant: grant.hostGrant ?? null,
        name: command.name, configuration: command.configuration, configurationVersion: operationId,
        ...(roleKind === 'reviewer' ? { role: 'reviewer' as const } : {}), ...(command.roleId ? { roleId: command.roleId } : {}),
        ...(roleName ? { roleName } : {}),
        ...(teamPool ? { teamAccount: true as const } : {}) })
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
      // A Product Manager started on its person's own Mac says, as one the Swarm starts does (leadJoined), when it does not
      // run the model its role asked for.
      if (command.lead && command.launchRefused) message(group.id, launchRefusedLine(command.launchRefused, coordinatorNameOf(project)), [], null, SYSTEM_ROW)
      break
    }
    case 'agent.start': {
      chatOnly(command.request.conversationId)
      projectChatWork(command.request.conversationId)
      const home = groupProject(state, open(state, command.request.conversationId))
      if (state.paused) fail('PAUSED', 'New work is paused in this Super Tab.')
      if (!['claude', 'codex'].includes(command.request.engine)) {
        fail('SWARM_ENGINE', 'A Swarm agent runs only Claude Code or Codex.', 400)
      }
      // An older client starts in a kind or a custom role, kept on the start for older readers and read by no command: the
      // role name it means rides on the start to the agent (instructions.ts legacyRoleName).
      const roleName = command.request.roleName ?? legacyRoleName(home, command.request)
      const named = roleName ? { ...command.request, roleName } : command.request
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
      // A teammate's project started on a Mac runs in that Mac's Harness Team account, never as its owner (machines.ts). A start
      // that names no model runs its engine's own: role defaults live in the project's instructions now.
      const request = teamStartRequest(state, named, home, context.teamAccountsIdle, context.teamMachines)
      const pool = admitMachineStart(state, request, context.now, undefined, context.teamMachines, context.otherWorkspaceMachines)
      // Off the Machines list, a teammate's project never runs: nothing there shows a privacy check (machines.ts).
      if (!pool) requireTeamWork(state, request.machineId, grant.contributorId, home, context.now, context.teamMachines, context.otherWorkspaceMachines)
      state.starts.push({ ...(pool ? { poolGeneration: pool.generation } : {}), ...(command.routeDecisionId ? { routeDecisionId: command.routeDecisionId } : {}), id: operationId, creationId: `super-${operationId}`, actorKey: actorKey(actor),
        contributorId: contributor.id, membershipGeneration: contributor.generation, machineOwnerId: grant.machineOwnerId,
        hostGrant: grant.hostGrant ?? null, request, harnessId: null, dispatched: false, error: null, requestedAt: context.now })
      leadActed(command.request.conversationId, 'start')
      result.startId = operationId
      if (command.routeDecisionId) {
        // The pick names the machine the Lead named: the Mac, when the start then went to its team account.
        const r = command.request
        const model = r.model ?? 'default', effort = r.effort ?? 'default'
        const { decision, override, instead } = linkDecision(r.conversationId,
          c => c.kind === 'new' && c.machineId === r.machineId && c.engine === r.engine && c.model === model && c.effort === effort
            && (c.gridModel ?? null) === (r.gridModel ?? null) && (c.gridName ?? null) === (r.gridName ?? null),
          () => ({ kind: 'new', startId: operationId, machineId: r.machineId, engine: r.engine, model, effort,
            ...(r.gridModel && r.gridName ? { gridModel: r.gridModel, gridName: r.gridName } : {}) }), command.overrideReason)
        if (override) message(r.conversationId, instead(`started ${r.name}`), [], null,
          bookkeeping(r.conversationId, { kind: 'route-override', decisionId: decision.id, by: 'lead' }))
      }
      break
    }
    case 'buddy.propose': {
      const self = actor.kind === 'agent' ? state.agents.find(a => a.id === actor.agentId && isBuddy(a)) : undefined
      if (!self) fail('BUDDY_ONLY', 'Only a Buddy sends a proposal, for its owner.', 403)
      // A Swarm-wide Buddy reads every project its person reads, so it writes into none (spec: Guard): a project session does.
      if (isSwarmBuddy(self)) fail('BUDDY_PROPOSE_SESSION', 'Start a New session in that project to send it to its PM.', 403)
      const owner = state.people.find(p => p.id === self.buddyOf!.personId && p.generation === self.buddyOf!.generation)
        ?? fail('BUDDY_OWNER_GONE', 'Your owner left this Swarm.', 403)
      const chat = conversation(state, command.conversationId)
      if (!isBuddyChat(chat) || !chat.agentIds.includes(self.id)) fail('BUDDY_FORBIDDEN', 'Name your own chat: a proposal comes from there.', 403)
      // A thread session proposes only for its person's message in its own thread, which is all it reads (buddySessions.ts).
      if (self.buddySession && context.proposalAsk && context.proposalAsk.id !== self.buddySession.thread && context.proposalAsk.thread !== self.buddySession.thread) {
        fail('PROPOSAL_UNASKED', 'Send a proposal only when your owner asks for it in your thread: name their message there.', 403)
      }
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
      const me = person(state, actor.userId)
      // Without a project, the person's one Buddy; with one (an older app), the Buddy of their older chat there, never the one
      // Buddy (spec: Older apps).
      const project = command.projectId ? readProject(state, actor, command.projectId) : undefined
      const chatId = project ? buddyChatId(project.id, me) : swarmBuddyChatId(me)
      const target = state.agents.find(a => a.buddyOf?.personId === me.id && !a.buddySession && state.conversations.some(c => c.id === chatId && c.agentIds.includes(a.id)))
      const starting = state.starts?.filter(s => s.request.conversationId === chatId && !s.harnessId && !s.error) ?? []
      if (!target && !starting.length) fail('NOT_FOUND', project ? 'You have no Buddy in this project.' : 'You have no Buddy.', 404)
      for (const start of starting) start.error = 'Removed by its owner before it started.'
      // Its session closes; its chat stays, and adding a Buddy again reopens it.
      if (target) removeAgent(target)
      break
    }
    case 'buddy.chat': {
      if (actor.kind !== 'person') fail('BUDDY_PERSON', 'A person opens their own Buddy chat.', 403)
      // With no project, the person's one Buddy chat (Dee, 10-31); with one, their older chat there, which older apps show.
      result.conversationId = command.projectId ? openBuddyChat(state, readProject(state, actor, command.projectId).id, person(state, actor.userId)).id
        : openSwarmBuddyChat(state, person(state, actor.userId)).id
      break
    }
    case 'buddy.rename':
      renameBuddy(state, actor, readConversation(state, actor, command.conversationId), command.name, context.buddyNames)
      break
    case 'buddy.sessionEnd': {
      if (actor.kind !== 'person') fail('BUDDY_PERSON', 'A person ends their own Buddy session.', 403)
      const chat = readConversation(state, actor, command.conversationId)
      requireChatOwner(state, chat, actor.userId)
      const entry = sessionOf(state, chat, command.thread)
      result.ended = !!entry
      if (!entry) break
      endBuddySession(chat, entry, command.reason)
      break
    }
    case 'person.tell': {
      // Any agent of a project, in its own project (project instructions, phase 4); a Buddy is refused before here.
      const projectId = actor.kind === 'agent' ? agentProjectId(state, agent(state, actor.agentId)) : undefined
      if (!projectId || !projectAgent(state, actor, projectId)) fail('FORBIDDEN', 'An agent sends a person a private line, in its own project.', 403)
      const project = projectOf(state, projectId)
      const to = state.people.find(p => p.id === command.personId) ?? fail('INVALID_PERSON', 'Tell a person in this Swarm.', 400)
      if (!canReadProject(state, { kind: 'person', userId: to.id, email: to.email }, project)) fail('INVALID_PERSON', `${to.email} cannot read this project.`, 400)
      // To nobody: the person reads it; their Buddy, if they have one, is not asked to answer for them. In their one Buddy chat,
      // marked with its project so it hides once they lose it (buddies.ts hiddenProjectRow), and in their older chat there,
      // which older apps and the phone still show (spec: Older apps).
      message(openSwarmBuddyChat(state, to).id, command.text, [], null, { kind: PM_LINE_KIND, projectId: project.id })
      Object.assign(effects.messages.at(-1)!, { buddyProject: project.id })
      effects.messages.push({ id: stableId(operationId, 'project-chat'), conversationId: openBuddyChat(state, project.id, to).id, author: sender,
        text: command.text, replyTo: null, recipients: [] })
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
      // One Buddy per person per Swarm (Dee, 10-31). An older app's Start names a project it reads: it adds that same one Buddy.
      if (command.projectId) readProject(state, actor, command.projectId)
      const me = person(state, actor.userId)
      const chatId = swarmBuddyChatId(me)
      // A down Buddy is replaced (Desktop's Start again, review of #1992): its session closes in this same command, so a
      // start refused below leaves it as it was. A running or starting one is kept.
      const existing = state.agents.find(a => isSwarmBuddy(a) && a.buddyOf!.personId === me.id && !a.buddySession)
      if ((existing && !downSince(state, existing, context.now))
        || state.starts?.some(s => s.request.conversationId === chatId && !s.request.buddySession && !s.harnessId && !s.error)) {
        fail('BUDDY_EXISTS', 'You already have a Buddy. Remove it to add another.')
      }
      if (existing) removeAgent(existing)
      // The person's Buddies of their older project chats go in the same write, so they have exactly one (spec: history).
      // Found by the agent, never by its chat, which may be quiet and not loaded here: every main Buddy of theirs that is not the
      // one Buddy is an older chat's.
      for (const old of state.agents.filter(a => a.buddyOf?.personId === me.id && !isSwarmBuddy(a) && !a.buddySession)) removeAgent(old)
      for (const start of state.starts ?? []) {
        if (start.request.buddyOf?.personId === me.id && start.request.conversationId !== chatId && !start.harnessId && !start.error) start.error = 'Your Buddy is now one for the whole Swarm.'
      }
      const grant = context.contribution ?? fail('HOST_REQUIRED', 'Choose a machine shared with the contributor.', 403)
      // Like a Lead, a Buddy runs only on its owner's own machine, in their own account, for Claude and Codex alike: never a
      // machine shared with them, and never a Harness Team account (Ken's ruling, 10-28). The grant is the store's reading of
      // the machine's account row (store.ts contribution), never the request's.
      const listed = machineContribution(state, command.machineId)
      const notOwn = () => fail('BUDDY_OWN_MACHINE', BUDDY_OWN_MACHINE_REFUSAL, 403)
      if (grant.machineOwnerId !== me.id || grant.contributorId !== me.id || grant.hostGrant || grant.hostMachineId || grant.teamSession) notOwn()
      // Off the Swarm's list it is recorded Buddy-only (Dee, 10-29): its host starts and watches the Buddy there, and nothing
      // else of the Swarm reaches it.
      const pool = listed ?? (command.setup ? addBuddyMachine(command.machineId, command.setup, me) : fail('BUDDY_MACHINE', 'Update Harness, then add your Buddy again.', 403))
      if (pool.contributorId !== me.id || pool.hostMachineId || pool.observation?.sessionKind === 'team') notOwn()
      // Harness cannot yet tell a Buddy's window from another agent's on Windows (security review of #2093): its machine
      // refused every agent's Swarm command while one ran there. None is added on Windows until a real caller check exists
      // (Lead's ruling, 10-29); the machine's own refusal stays as the backstop, and its launch is checked again (machines.ts).
      if (pool.observation?.resources.os === 'Windows') fail('BUDDY_WINDOWS', BUDDY_WINDOWS_REFUSAL, 403)
      // A host that runs a Swarm Buddy makes its folder of project worktrees (spec: Folder). One not yet reporting (a machine
      // just added for Buddies) is let through: an older host would start it in an empty folder that reads nothing.
      if (pool.observation && !pool.observation.capabilities?.includes(SWARM_BUDDY_CAPABILITY)) {
        fail('BUDDY_UPDATE_HOST', `Update Harness on ${pool.name ?? 'your computer'} to start your Buddy.`)
      }
      // A slot for its person's Buddy there and its sessions: it takes nothing else.
      if (pool.buddyOnly) pool.maxAgents = machineSlots(state, pool) + 1
      const contributor = person(state, grant.contributorId)
      const chat = openSwarmBuddyChat(state, me)
      const named = chosenBuddyName(state, chat, me, context.buddyNames)
      // Never moved to the Mac's Team account, as a teammate's project otherwise is (machines.ts teamStartRequest).
      const request: AgentStartRequest = { conversationId: chatId, machineId: pool.machineId, engine: command.engine,
        ...(command.model ? { model: command.model } : {}), name: named.name, cwd: buddyHomeFolder(pool, me), worktree: false,
        requirements: BUDDY_REQUIREMENTS, buddyOf: { personId: me.id, generation: me.generation }, buddyScope: 'swarm',
        buddyProjects: buddyProjectsOn(state, pool, me) }
      const admitted = admitMachineStart(state, request, context.now, undefined, context.teamMachines, context.otherWorkspaceMachines)!
      state.starts ??= []
      if (state.starts.filter(s => !s.harnessId && !s.error).length >= 32) fail('STARTS_PENDING', 'Reconcile pending agent starts before adding more.')
      state.starts.push({ poolGeneration: admitted.generation, id: operationId, creationId: `super-${operationId}`, actorKey: actorKey(actor),
        contributorId: contributor.id, membershipGeneration: contributor.generation, machineOwnerId: grant.machineOwnerId,
        hostGrant: grant.hostGrant ?? null, request, harnessId: null, dispatched: false, error: null, requestedAt: context.now })
      // Its chosen name was taken since: its owner reads so in their chat, to nobody else (buddies.ts chosenBuddyName).
      if (named.notice) message(chatId, named.notice, [], null, SYSTEM_ROW)
      result.startId = operationId
      result.conversationId = chatId
      break
    }
    case 'agent.startDispatch':
    case 'agent.started':
    case 'agent.startSettled':
    case 'agent.startFailed': {
      const start = state.starts?.find(s => s.id === command.startId) ?? fail('NOT_FOUND', 'This agent start is unavailable.', 404)
      if (!mayResumeStart(state, actor, start)) fail('FORBIDDEN', 'Only whoever made this start, or its project\'s coordinator, carries it on.', 403)
      if (person(state, start.contributorId).generation !== start.membershipGeneration) fail('FORBIDDEN', 'This contribution was withdrawn.', 403)
      if (command.type === 'agent.startDispatch') {
        if (state.paused) fail('PAUSED', 'New work is paused in this Super Tab.')
        if (!['claude', 'codex'].includes(start.request.engine)) {
          fail('SWARM_ENGINE', 'A Swarm agent runs only Claude Code or Codex.', 400)
        }
        // An archived task launches no new agent.
        open(state, start.request.conversationId)
        const grant = context.contribution ?? fail('HOST_REQUIRED', 'The original machine grant is unavailable.', 403)
        if (grant.machineOwnerId !== start.machineOwnerId || (grant.hostGrant ?? null) !== start.hostGrant) {
          fail('CONTRIBUTION_REVOKED', 'The original machine grant was revoked.', 403)
        }
        admitMachineStart(state, start.request, context.now, start, context.teamMachines, context.otherWorkspaceMachines)
        if (start.dispatched || start.error || start.harnessId) fail('START_CLAIMED', 'This native start was already requested. Read its creation status; do not start another.')
        start.dispatched = true
        start.dispatchedAt = context.now
        const version = context.machineVersions?.[start.request.machineId]
        if (version) start.dispatchedVersion = version
        break
      }
      if (command.type === 'agent.startSettled') {
        if (!start.poolGeneration || !start.harnessId || start.error) fail('START_PENDING', 'This contributed start is not ready to settle.')
        if (command.configuration && !start.poolSettled) settledConfiguration(start, command.configuration)
        // A Product Manager is never assigned work: its conversation already said where it started.
        // A warning is the people's to read (a start that went wrong); being ready is bookkeeping.
        // A thread session says nothing in the main chat (security review 2 of #2345): its thread shows it working, and a
        // warning about its start goes in its thread alone.
        if (!start.poolSettled && start.request.buddySession) {
          if (command.warning) {
            message(start.request.conversationId, `${start.request.name}: ${command.warning}`, [], start.request.buddySession.thread, SYSTEM_ROW)
            Object.assign(effects.messages.at(-1)!, { thread: start.request.buddySession.thread, buddySession: true,
              ...(start.request.buddySession.projectId ? { buddyProject: start.request.buddySession.projectId } : {}) })
          }
        } else if (!start.poolSettled && !start.request.leadFor) message(start.request.conversationId, command.warning
          ? `${start.request.name}: ${command.warning}`
          : start.request.buddyOf ? buddyReady(start.request.name) : `${start.request.name} is ready for an assignment.`, [], null,
          command.warning ? SYSTEM_ROW : bookkeeping(start.request.conversationId, SYSTEM_ROW))
        start.poolSettled = true
        break
      }
      if (command.type === 'agent.startFailed') {
        if (start.harnessId) fail('ALREADY_STARTED', 'This agent already started.')
        // Only its first failure counts against its engine: the server may have timed it out before its host said so (liveness.ts).
        const counted = !start.error
        start.error = command.error
        const suspended = counted ? noteStartFailed(state, start, context.now) : null
        // A thread session's says so in its thread (buddySessions.ts), and frees its place.
        if (start.request.buddySession) {
          const chat = conversation(state, start.request.conversationId)
          const entry = (chat.buddySessions ?? []).find(e => e.startId === start.id)
          if (entry) endBuddySession(chat, entry, 'failed', command.error)
          break
        }
        // A Product Manager's start says so in its project's conversation (leadStart.ts).
        if (start.request.leadFor) {
          const ended = leadStartFailed(state, start, command.error)
          if (ended) message(start.request.conversationId, ended, [], null, SYSTEM_ROW)
          break
        }
        // Told to the coordinator and the agent that made the start, with the model it asked for (project instructions, phase 4,
        // decision 18): nothing is started elsewhere. Written for nobody, this notice once left the round-device group without
        // a worker for an hour (2026-10-27).
        const group = conversation(state, start.request.conversationId)
        // The failure that suspends its engine there says so once, and tags the machine's owner (engineHealth.ts).
        const failed = `${failureNotice(start.request.name, command.error, askedModel(start), isSwarmBuddyChat(group) ? undefined : coordinatorNameOf(groupProject(state, group)))}${suspended ? `\n\n${suspended}` : ''}`
        const told = failureRecipients(start, group)
        message(group.id, failed, told, null, SYSTEM_ROW, undefined, suspended && start.machineOwnerId ? [start.machineOwnerId] : undefined)
        // A task with no lead, or one its lead left: its coordinator hears it in its own chat (final review).
        const copy = coordinatorCopy(state, group, told)
        if (copy) effects.messages.push({ id: stableId(operationId, 'coordinator'), conversationId: copy.conversationId, author: sender, text: failed,
          replyTo: null, recipients: [copy.coordinator], source: forRecipients(SYSTEM_ROW) })
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
        // A Swarm Buddy chat has no project: its main Buddy and plain sessions read every project their person reads, and a
        // project session its own (Dee, 10-31).
        ...(isSwarmBuddyChat(group) ? start.request.buddySession?.projectId ? { projectId: start.request.buddySession.projectId } : {}
          : state.projects ? { projectId: groupProject(state, group).id } : {}),
        ...(start.request.buddyScope ? { buddyScope: start.request.buddyScope } : {}),
        ...(start.request.buddyNarrow ? { buddyNarrow: true as const } : {}),
        machineOwnerId: start.machineOwnerId, contributorId: start.contributorId, membershipGeneration: start.membershipGeneration,
        hostGrant: start.hostGrant, name: start.request.name, configuration: command.configuration, configurationVersion: operationId,
        ...(start.request.role ? { role: start.request.role } : {}), ...(start.request.roleId ? { roleId: start.request.roleId } : {}),
        ...(start.request.roleName ? { roleName: start.request.roleName } : {}),
        ...(start.request.gridModel ? { gridModel: start.request.gridModel } : {}),
        ...(!start.request.gridModel && (start.request.model ?? 'default') === 'default' ? { launchedDefault: true as const } : {}),
        ...(start.request.buddyOf ? { buddyOf: start.request.buddyOf } : {}),
        ...(start.request.buddySession ? { buddySession: start.request.buddySession } : {}),
        ...(teamAccountPool(machineContribution(state, start.request.machineId)) ? { teamAccount: true as const } : {}),
        ...(command.startedSession ? { startedSession: { ...command.startedSession, creationId: start.creationId } } : {}) })
      // A main Buddy stays first, as older clients take a Buddy chat's first agent for its Buddy (buddySessions.ts).
      if (start.request.buddyOf && !start.request.buddySession) group.agentIds.unshift(agentId)
      else group.agentIds.push(agentId)
      start.harnessId = command.harnessId
      noteStartSucceeded(state, start)
      result.agentId = agentId
      // A thread session joins its chat's record, and hears the person's messages sent while it started, by delivery as any
      // other: its host's person check, run: judging and read grant apply to them too (spec: Security).
      if (start.request.buddySession) {
        const entry = (group.buddySessions ?? []).find(e => e.startId === start.id)
        const owner = chatOwner(group)
        if (!entry || !owner) fail('BUDDY_SESSION_ENDED', 'This session ended before it started.')
        entry.agentId = agentId
        effects.lateDeliveries = (entry.waiting ?? []).map(messageId => ({ messageId, conversationId: group.id, agentId,
          author: { kind: 'person' as const, id: owner.id, generation: owner.generation } }))
        delete entry.waiting
      }
      // The one Buddy's session in an older project chat hears the person's messages sent while it started (spec: Older apps).
      if (start.request.buddyWaiting?.length && !start.request.buddySession) {
        const owner = chatOwner(group)
        if (owner) effects.lateDeliveries = start.request.buddyWaiting.map(messageId => ({ messageId, conversationId: group.id, agentId,
          author: { kind: 'person' as const, id: owner.id, generation: owner.generation } }))
      }
      if (start.request.leadFor) {
        // Taking over from a Lead that left, as agent.add does.
        if (group.leadId && !group.agentIds.includes(group.leadId)) keepLead(group, agentId)
        // The people's to read: it answers the start a person asked for, whose "Waiting for a machine" line they read.
        const joined = leadJoined(state, start, group, agentId)
        message(group.id, joined.text, [], null, joined.source)
      }
      // A Buddy always starts on a Swarm machine: its chat hears once it settles, as the Lead does for a worker.
      else if (!start.request.buddyOf) message(group.id, start.poolGeneration
        ? `${start.request.name} joined. Preparing its model.`
        : `${start.request.name} joined. Ready for an assignment.`, [], null, bookkeeping(group.id, SYSTEM_ROW))
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
        recordReportedModel(state, target)
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
      delete target.launchedDefault
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
      // A Buddy is its owner's to stop (buddies.ts), and a Swarm-wide one has no project to look up.
      if (isBuddy(target)) fail('BUDDY_NOT_RELEASED', 'A Buddy is stopped by its owner, or by turning Buddies off, never released.')
      const project = projectOf(state, agentProjectId(state, target))
      const isOwner = actor.kind === 'person' && [state.ownerId, target.contributorId].includes(actor.userId)
      if (!projectAgent(state, actor, project.id) && !isOwner) fail('FORBIDDEN', 'Only an agent of this project, the contributor or tab owner can release a worker.', 403)
      protectLead(state, target.id)
      // Only its own active work holds a decision back, not the active work of a task it sits in.
      if (state.conversations.some(c => activeWork(c) && c.assignment?.agentId === target.id)) fail('WORK_ACTIVE', 'Finish active work before releasing this worker.')
      // A Buddy is its owner's to stop (buddies.ts); it never had work, which was all that kept it from here before.
      if (isBuddy(target)) fail('BUDDY_NOT_RELEASED', 'A Buddy is stopped by its owner, or by turning Buddies off, never released.')
      // A session a person shared by hand is its host's to close on a stop: of the other agents, only the coordinator releases
      // it. Any agent of the project releases one the Swarm started, which alone records its session (security review L5;
      // tidy.ts reads the same mark).
      if (actor.kind === 'agent' && actor.agentId !== target.id && !target.startedSession && ledProject(state, actor.agentId)?.id !== project.id) {
        fail('COORDINATOR_REQUIRED', 'A person added this session, so of its project\'s agents only the coordinator releases it.', 403)
      }
      // Any other agent is kept or stopped on request, finished work or not, whatever its role (project instructions, phase 4):
      // whether to keep one is workflow, which the instructions decide.
      if (target.workDecision === 'stop' && command.decision !== 'stop') fail('STOP_REQUESTED', 'This worker is stopping. Wait for its execution host.')
      if (command.decision === 'stop' && target.workDecision !== 'stop') target.releaseId = operationId
      // A stop its Lead or a person asks for is theirs, even over an idle stop from before: its host no longer withdraws it.
      if (command.decision === 'stop') delete target.idleStop
      target.workDecision = command.decision
      if (command.decision === 'keep') target.keptAt = context.now
      break
    }
    case 'agent.stopRefused': {
      // Only an idle stop the server made before project instructions, and only its host: the session's folder had changes by the time it would close it
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
          ? ` Its task "${group.title}" has no agent now.` : ''
        const lead = group.leadId && group.agentIds.includes(group.leadId) ? group.leadId : null
        // One person can withdraw an agent from several groups. Each notice needs its own durable message ID.
        effects.messages.push({ id: stableId(operationId, 'agent-removed', group.id), conversationId: group.id,
          author: sender, text: `${sender.name.split('@')[0]} removed ${target.displayName ?? target.name} from the Swarm.${task}`,
          replyTo: null, recipients: lead ? [lead] : [], source: SYSTEM_ROW })
      }
      break
    }
    case 'conversation.agent': {
      const group = open(state, command.conversationId)
      // Who coordinates is the project's setting, not workflow: naming a group's lead, or taking it out. The project chat is the
      // people's and is never archived, so its members are its coordinator's or a person's to change (final review).
      if (command.lead || (!command.present && group.leadId === command.agentId)
        || projectsOf(state).some(p => p.leadConversationId === group.id)) coordinatorOrPerson(state, actor, group.id)
      if (isBuddyChat(group)) fail('BUDDY_CHAT_FIXED', 'A Buddy chat stays its owner\'s and their Buddy\'s: nobody else is added to it.', 403)
      const member = agent(state, command.agentId)
      if (isBuddy(member)) fail('BUDDY_CHAT_ONLY', 'A Buddy stays in its own chat: its owner\'s alone.', 403)
      sameProject(state, group, member)
      // Any agent may lead a task or be added to one, a linked one included, whatever its role (project instructions, phase 4).
      if (member.workDecision === 'stop' && (command.lead || command.present)) fail('STOP_REQUESTED', 'This agent is stopping. Wait for its execution host.')
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
        // An agent added to a task may work on it, so a teammate's agent is added only where it may take that project's work,
        // as an assignment checks (machines.ts teamWorkCheck).
        requireTeamWork(state, member.machineId, member.contributorId, groupProject(state, group), context.now, context.teamMachines, context.otherWorkspaceMachines)
        if (!group.agentIds.includes(command.agentId)) group.agentIds.push(command.agentId)
        // Added to a task, it is reused, as an assignment reuses a worker: its finished-work mark goes.
        delete member.workDecision
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
    case 'message.react': {
      // A reaction joins nobody to a task: only where the agent already is (project instructions, phase 4).
      const group = open(state, command.conversationId)
      if (actor.kind === 'agent' && !group.agentIds.includes(actor.agentId)) fail('FORBIDDEN', 'This agent does not participate in the conversation.', 403)
      result.changed = react(group, command.messageId, command.on, context.reaction)
      break
    }
    case 'member.avatar':
      setMemberAvatar(state, actor, command.avatar, context.avatarUpload)
      break
    case 'member.username':
      setUsername(state, actor, command.username)
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
      // A Buddy-only one goes silently with their Buddies, below (dropIdleBuddyMachines): no chat ever saw it.
      for (const pool of state.machines?.filter(m => m.contributorId === member.id && !m.removal && !m.buddyOnly) ?? []) {
        removeMachine(pool.machineId, pool, state.agents.filter(a => a.machineId === pool.machineId), machine => `${machine} left the Swarm with its owner`)
      }
      // Their Buddies go with them, on whosever machine they run, and those still starting fail, as buddy.remove does: otherwise a
      // Buddy-only record kept for them would never end (security review 2 of #2234).
      for (const start of state.starts?.filter(s => s.request.buddyOf?.personId === member.id && !s.harnessId && !s.error) ?? []) {
        start.error = 'Its person left the Swarm before it started.'
      }
      // A main Buddy takes its thread sessions with it (removeAgent), so each is removed once.
      for (const target of state.agents.filter(a => a.contributorId === member.id || a.buddyOf?.personId === member.id)) {
        if (state.agents.some(a => a.id === target.id)) removeAgent(target)
      }
      state.people = state.people.filter(p => p.id !== member.id)
      state.invitations = state.invitations.filter(i => i.email !== member.email)
      result.removedUserId = member.id
      break
    }
    case 'message.send': {
      const joining = actor.kind === 'agent' && !state.conversations.find(c => c.id === command.conversationId)?.agentIds.includes(actor.agentId)
      const group = postable(state, actor, command.conversationId)
      if (joining) teamJoin(groupProject(state, group), actor.agentId)
      const ids = [...new Set(command.attachmentIds ?? [])]
      const attachments = ids.map(id => context.attachments?.find(a => a.id === id) ?? fail('ATTACHMENT_UNAVAILABLE', 'Upload this file again before sending it.', 400))
      if (!command.text && !attachments.length) fail('TEXT_REQUIRED', 'Write a message or attach a file.', 400)
      // The text is where tags live, as people tag in chat: each name it says tags that person, if they may read here. A tag
      // picked in an older client (or the CLI's --mention) that the text does not say is written into it, so every client
      // shows the same words. Only from the command, so a retry writes the same text.
      const picked = checkMentions(state, actor, group, command.mentions ?? [])
      // Every username is worked out at once, and only for a post that names or picks someone.
      const names = picked.length || command.text.includes('@') ? swarmUsernames(state) : new Map<string, string>()
      const named = namedIn(state, command.text, names)
      const unsaid = picked.filter(id => !named.includes(id) && !saysName(command.text, names.get(id)!))
      const text = withTags(unsaid.map(id => `@${names.get(id)}`), command.text)
      // A tag would tell a person about an agent-only notice they cannot see.
      const mentions = [...new Set([...picked, ...command.agentOnly ? [] : textTags(state, actor, group, named)])].slice(0, MAX_MENTIONS)
      if (command.mentionsIfNoWorker && !mentions.length) fail('INVALID_MENTION', 'Hold a tag only for a message that tags someone.', 400)
      if (command.replyTo && (!context.reply || context.reply.id !== command.replyTo || context.reply.conversationId !== group.id)) {
        fail('INVALID_REPLY', 'Reply to a message in this conversation.', 400)
      }
      const replyAgent = context.reply?.author.kind === 'agent' ? context.reply.author.id : null
      // An assigned worker's own post in its group reaches the Lead. Workers reported results as plain posts, which went to no
      // one: the Lead heard only at the next scheduled consolidation, and the owner saw no summary of finished work for up to
      // 19 minutes (2026-10-21/22). The Lead's message reaches the worker the same way (#1549), except for a reply to someone
      // else and a message that would continue an automatic round trip (leadWorkerBounced), so agents cannot loop.
      // An agent is never delivered its own message, except its note to itself: naming only
      // itself, its post is unnamed (final review of phase 1).
      const addressed = command.agentOnly || actor.kind !== 'agent' ? command.recipientIds : command.recipientIds.filter(id => id !== actor.agentId)
      const assigned = activeWork(group) ? group.assignment!.agentId : null
      const leadToWorker = actor.kind === 'agent' && actor.agentId === group.leadId && assigned && assigned !== group.leadId
        && group.agentIds.includes(assigned) && (!context.reply || replyAgent === assigned)
        && !leadWorkerBounced(context.recent, group.leadId, assigned) ? assigned : null
      const workerToLead = actor.kind === 'agent' && activeWork(group) && group.assignment?.agentId === actor.agentId
        && group.leadId && group.leadId !== actor.agentId && group.agentIds.includes(group.leadId) ? group.leadId : null
      const agentRecipient = leadToWorker ?? workerToLead
      // Any other agent's unnamed post in the group reaches its Lead: an agent whose task here was lost, moved or cancelled has
      // its status and results refused, so its posts are all the Lead hears from it. They reached no one until 10-29, when a
      // moved prod-watch agent's "the backend worker is down" alarm and its answers to the Lead's questions had no delivery,
      // and the worker stayed down 4 h 50 min. Membership, not a record of past attempts, decides (Lead's ruling on #2243).
      // A post that names its agents reaches only them: copying every one to the Lead filled its terminal (Ken, 10-30: 198 of
      // the 486 messages it got in a day were such copies). The assigned worker keeps its own rule above; a note to itself
      // stays its own.
      const memberToLead = actor.kind === 'agent' && !command.agentOnly && !addressed.length && assigned !== actor.agentId && group.leadId
        && group.leadId !== actor.agentId && group.agentIds.includes(group.leadId) ? [group.leadId] : []
      // Buddy thread sessions (buddySessions.ts): a session thread's replies reach its session alone and stay in its thread; the
      // main Buddy hears the rest. Decided here from the thread, so every client, an old one or the phone, is routed alike.
      const session = isBuddyChat(group) ? routeBuddySession(group) : undefined
      if (command.newSession && !session) fail('BUDDY_SESSION_CHAT', 'Start a session from a thread of your own Buddy chat.', 400)
      // An older project chat with no Buddy in it: the person's one Buddy answers there through a session of that project, so
      // the phone and older apps keep a working Buddy (spec: Older apps). Started on this message, which waits for it.
      if (actor.kind === 'person' && isBuddyChat(group) && !isSwarmBuddyChat(group) && !session?.inSession && !mainBuddyOf(state, group)) startOldChatBuddy(group)
      // A Buddy chat has no Lead: its owner talks to its Buddy.
      const automatic = actor.kind === 'person' ? (isBuddyChat(group) ? (session?.inSession ? session.to : mainBuddyOf(state, group)?.id ?? null)
        : replyAgent && group.agentIds.includes(replyAgent) ? replyAgent : group.leadId) : agentRecipient
      const recipients = [...new Set([...addressed, ...memberToLead, ...(addressed.length || !automatic ? [] : [automatic])])]
      for (const id of recipients) {
        const target = agent(state, id)
        // In a Buddy chat a session hears its own thread alone, and the main Buddy none of it.
        if (session && (session.inSession ? id !== session.to : !!target.buddySession)) fail('INVALID_RECIPIENT', 'Choose an agent in this conversation.', 400)
        // An agent of this project that another agent names from outside the group joins it, so it can read and answer there
        // (joinsProject). A person's message adds nobody: a person adds an agent to a task with conversation.agent.
        if (!group.agentIds.includes(id)) {
          if (actor.kind !== 'agent' || !joinsProject(state, group, id)) fail('INVALID_RECIPIENT', 'Choose an agent in this conversation.', 400)
          teamJoin(groupProject(state, group), id)
          group.agentIds.push(id)
        }
      }
      // A tag would tell a person about a notice they cannot see.
      if (command.agentOnly && (actor.kind !== 'agent' || recipients.length !== 1 || recipients[0] !== actor.agentId || mentions.length)) {
        fail('INVALID_RECIPIENT', 'An agent sends an agent-only notice to itself alone.', 400)
      }
      // The transcript still accepts a human message while the lead is unavailable. The UI can say why no delivery was created.
      message(group.id, text, recipients, command.replyTo, command.agentOnly ? AGENT_ONLY : undefined, attachments, mentions, command.mentionsIfNoWorker)
      // The message that makes it LOOP_NOTICE_AT in a row between two agents tells their Lead, once; delivery is never held.
      const speaker = actor.kind === 'agent' ? agent(state, actor.agentId) : null
      const partner = speaker && recipients.length === 1 && recipients[0] !== speaker.id ? agent(state, recipients[0]!) : null
      const pairLead = speaker && leadOf(state, speaker)
      if (speaker && partner && pairLead && pairLead.id !== partner.id && pairLoop(context.recent, speaker.id, partner.id, context.now) + 1 === LOOP_NOTICE_AT) {
        effects.messages.push(...toLead(state, speaker, { id: stableId(operationId, 'loop'), conversationId: group.id, author: sender, replyTo: null, recipients: [],
          text: `${speaker.displayName ?? speaker.name} and ${partner.displayName ?? partner.name} have exchanged ${LOOP_NOTICE_AT} messages in a row in the last 30 minutes.`,
          source: { kind: PAIR_LOOP_SOURCE, agentIds: [speaker.id, partner.id] } }))
      }
      // A reply joins its message's thread, always at the root, so threads never nest. A reply to a notice only its
      // recipients read (the Lead answering a stalled alert) stays in the chat: people open a thread from its root.
      const thread = command.replyTo && !context.reply?.agentOnly ? context.reply?.thread : null
      if (thread) Object.assign(effects.messages.at(-1)!, { thread, ...(command.alsoSend ? { alsoInChat: true } : {}) })
      // Its project on the row itself, so the row hides once its person loses that project (buddySessions.ts lostProjectRow).
      if (session?.inSession) Object.assign(effects.messages.at(-1)!, { buddySession: true, ...(session.project ? { buddyProject: session.project } : {}) })
      recordPost(state, group, actor, { replyTo: command.replyTo, text, reply: context.reply, openTags: context.openTags }, context.now)
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
      projectChatWork(command.conversationId)
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
      if (member) assignable(member)
      // An archived task is routed no more.
      const routedGroup = open(state, command.conversationId)
      const via = decision.via === 'jev' ? `Jev ${Math.round((decision.p ?? 0) * 100)}%`
        : decision.via === 'only' ? 'only candidate' : 'by policy order'
      // The server's own fields are never taken from the route: the task's step up (a grid attempt's failed first review, goals
      // piece 4), cut to what a record keeps, and the instructions revision the route relied on, stamped now (project
      // instructions, phase 4). An older CLI's same-engine note, as a field or at the start of its why, is not kept.
      const { stepUp: _sent, sameEngine: _said, jobKind: _kind, instructionsRevision: _revision, ...sent } = decision
      const made = { ...sent, why: sent.why.replace(OLD_SAME_ENGINE, '') || sent.why }
      const jobKind = jobKindOf(routedGroup, decision.assessment.kind)
      const instructionsRevision = groupProject(state, routedGroup).instructionsRevision ?? 0
      // Only the first route after a step up carries it, so the costs report counts one step up per task, not one per route
      // (review of #2422); a later failure is a new step up, carried again.
      const step = routedGroup.stepUp && !routedGroup.stepUp.recorded ? routedGroup.stepUp : null
      if (step) step.recorded = true
      const stepUp = step ? { stepUp: { attempt: Math.min(3, step.attempt), reason: step.reason.slice(0, 200) } } : {}
      effects.routeDecisions.push({ op: 'create', id: operationId, conversationId: command.conversationId, record: { ...made, ...stepUp, jobKind, instructionsRevision } })
      result.routeDecisionId = operationId
      // The row quotes the Lead's reason for the task; the verdict's own text stays in the decision record.
      const reason = decision.assessment.why
      message(command.conversationId, `Routed to ${chosen.title} — ${via} · "${reason}"`, [], null, bookkeeping(command.conversationId, {
        kind: 'route', decisionId: operationId, via: decision.via, p: decision.p, belowFloor: decision.belowFloor, why: reason,
        ...(decision.via === 'order' && decision.fallback ? { fallback: decision.fallback } : {}),
        pick: { id: chosen.id, title: chosen.title },
        alternatives: decision.candidates.filter(c => c.id !== chosen.id).map(c => ({ id: c.id, title: c.title })),
      }))
      leadActed(command.conversationId, 'route')
      break
    }
    case 'route.modelResult': {
      const decision = openDecision()
      const final = decision.final
      if (final?.kind !== 'new' || final.startId !== command.startId) fail('ROUTE_MISMATCH', 'This routing decision did not start that agent.')
      // Only whoever carries the start on reports what it runs: any reader rewrote the decision's model (security review L4).
      const start = state.starts?.find(s => s.id === command.startId)
      if (!start || !mayResumeStart(state, actor, start)) fail('FORBIDDEN', 'Only whoever made this start, or its project\'s coordinator, reports the model it runs.', 403)
      // The final says who was actually started. When the routed switch failed, the request moves to `requested`.
      effects.routeDecisions.push({ op: 'final', id: decision.id,
        final: { ...final, model: command.model, effort: command.effort, requested: final.requested ?? { model: final.model, effort: final.effort } } })
      break
    }
    case 'route.override': {
      if (actor.kind !== 'person') fail('HUMAN_REQUIRED', 'A person changes a routing decision; the lead overrides when it starts or assigns.', 403)
      const decision = openDecision()
      open(state, decision.conversationId)
      const current = decision.override?.candidateId ?? decision.record.pick
      const chosen = decision.record.candidates.find(c => c.id === command.candidateId) ?? fail('NOT_FOUND', 'Choose one of this decision’s candidates.', 404)
      if (chosen.id === current) fail('ALREADY_CHOSEN', 'That candidate is already the choice.')
      if (chosen.kind === 'member' && !state.agents.some(a => a.id === chosen.agentId)) fail('CANDIDATE_UNAVAILABLE', 'That agent left this Super Tab. Choose another.')
      // Its machine may have stopped showing its privacy since the route; the group's Lead is who would start it.
      const leadId = conversation(state, decision.conversationId).leadId
      const teamRefusal = candidateRefusal(chosen, decision.conversationId, state.agents.find(a => a.id === leadId)?.contributorId ?? actor.userId)
      if (teamRefusal) failTeamWork(teamRefusal)
      effects.routeDecisions.push({ op: 'override', id: decision.id, override: { by: 'person', actorKey: actorKey(actor), candidateId: chosen.id, reason: command.reason } })
      const lead = conversation(state, decision.conversationId).leadId
      message(decision.conversationId,
        `${sender.name} chose ${chosen.title} instead of ${routeTitle(decision, current)}. Reason: ${command.reason}`,
        lead ? [lead] : [], null, { kind: 'route-override', decisionId: decision.id, by: 'person' })
      break
    }
    case 'work.define': {
      chatOnly(command.conversationId)
      projectChatWork(command.conversationId)
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
      group.checks = storedChecks(command.checks, operationId)
      message(group.id, group.brief, [], null, SYSTEM_ROW)
      bindTaskCard(group, effects.messages.at(-1)!)
      break
    }
    case 'work.assign': {
      chatOnly(command.conversationId)
      projectChatWork(command.conversationId)
      const target = agent(state, command.agentId)
      if (state.starts?.some(s => s.poolGeneration && !s.poolSettled && s.request.machineId === target.machineId && s.harnessId === target.harnessId)) {
        fail('START_PENDING', 'Wait for the host to finish this agent’s launch and model selection.')
      }
      const group = open(state, command.conversationId)
      if (state.paused) fail('PAUSED', 'New work is paused in this Super Tab.')
      if (activeWork(group)) fail('WORK_ACTIVE', 'The current assignment must finish or be reconciled before reassignment.')
      const worker = agent(state, command.agentId)
      assignable(worker)
      sameProject(state, group, worker)
      const home = groupProject(state, group)
      // A teammate's agent on a personal machine keeps what it has; it takes no new task for another person's project.
      requireTeamWork(state, worker.machineId, worker.contributorId, home, context.now, context.teamMachines, context.otherWorkspaceMachines)
      if (worker.workDecision === 'stop') fail('STOP_REQUESTED', 'This worker is stopping. Wait for its execution host.')
      if (state.conversations.some(c => activeWork(c) && c.assignment?.agentId === worker.id)) fail('AGENT_BUSY', 'This agent already owns an active assignment.')
      // An older client assigns in a custom role: kept for older readers, and the role name it means for a worker without
      // one (instructions.ts legacyRoleName). No command reads the role.
      if (command.roleId) {
        worker.roleId = command.roleId
        const roleName = worker.roleName ? undefined : legacyRoleName(home, { roleId: command.roleId })
        if (roleName) worker.roleName = roleName
      }
      delete worker.workDecision
      delete worker.releaseId
      // Any assignment, an agent's or a person's, takes a worker that lost its task back into routing (model.ts lostTask).
      delete worker.lostTask
      if (!group.agentIds.includes(worker.id)) group.agentIds.push(worker.id)
      rememberAttempt(group)
      group.assignment = { id: operationId, agentId: worker.id, status: 'working', configuration: structuredClone(worker.configuration),
        execution: { machineId: worker.machineId, harnessId: worker.harnessId, machineOwnerId: worker.machineOwnerId }, result: null }
      renewLease(group.assignment, context.now)
      leadActed(group.id, 'assign')
      recordRun(state, group, group.assignment, worker, context.now)
      group.checks.forEach(c => { c.evidence = null; c.passedBy = null })
      result.assignmentId = operationId
      let routeNote: { decisionId: string; text: string } | null = null
      if (command.routeDecisionId) {
        const started = (d: RouteDecision) => d.final?.kind === 'new' &&
          !!state.starts?.some(s => s.id === (d.final as { startId: string }).startId && s.harnessId === worker.harnessId && s.request.machineId === worker.machineId)
        // An agent started from this decision keeps the final that records its model and effort; only the assignment is added.
        const { decision, override, instead } = linkDecision(group.id,
          (c, d) => (c.kind === 'member' && c.agentId === worker.id) || (c.kind === 'new' && started(d) && d.final?.kind === 'new' &&
            startedAs(c, d.final)),
          d => started(d) ? d.final! : { kind: 'member', agentId: worker.id, machineId: worker.machineId }, command.overrideReason, operationId)
        if (override) routeNote = { decisionId: decision.id, text: instead(`assigned ${worker.name}`) }
      }
      // The brief (a task with none: its title), and its acceptance checks when it has some: checks are information.
      message(group.id, [group.brief || group.title,
        ...group.checks.length ? [`Acceptance checks:\n${group.checks.map(c => `- ${c.description}`).join('\n')}`] : []].join('\n\n'), [worker.id], null, SYSTEM_ROW)
      const news = assignedNotice(state, group, sender, operationId)
      if (news) effects.messages.push(news)
      if (routeNote) effects.messages.push({ id: stableId(operationId, 'route-override'), conversationId: group.id, author: sender,
        text: routeNote.text, replyTo: null, recipients: [], source: bookkeeping(group.id, { kind: 'route-override', decisionId: routeNote.decisionId, by: 'lead' }) })
      break
    }
    case 'work.status': {
      const group = open(state, command.conversationId)
      const assignment = group.assignment
      fenceLost(group, command.assignmentId)
      if (!assignment || assignment.id !== command.assignmentId) fail('STALE_ASSIGNMENT', 'This is no longer the active assignment.')
      if (!activeWork(group)) fail('ATTEMPT_CLOSED', 'Assign a new attempt to continue this work.')
      if (command.status === 'stopped' && !context.confirmedStopped) fail('STOP_UNCONFIRMED', 'Wait for the execution host to confirm the stop.')
      if (assignment.status === 'reconciling' && command.status !== 'stopped') fail('RECONCILING', 'Reconcile the previous assignment before continuing.')
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
      const waited = waitingForReview(assignment)
      assignment.status = command.status
      assignment.result = command.result
      // A new status is a new hand-off, or the end of one: a review's earlier findings are answered (liveness.ts waitingForReview).
      delete assignment.reviewFoundAt
      if (command.ask) assignment.askedOf = command.ask.personId
      else if (command.status !== 'needs_human') delete assignment.askedOf
      recordStatus(group, assignment, previous, context.now, changed ? operationId : null, asked)
      if (['done', 'stopped'].includes(command.status)) finishWorker(state, assignment.agentId)
      // Finished work shows the worker recovered from a task it lost before.
      if (command.status === 'done') delete state.agents.find(a => a.id === assignment.agentId)?.lostTask
      if (changed) {
        const label = STATUS_LABELS[command.status]
        const lead = group.leadId
        const own = actor.kind === 'agent' && actor.agentId === assignment.agentId
        // Its own agent's change reaches the coordinator when the work waits on someone or is done: stuck is the coordinator's
        // to hear as a human decision is. Anyone else's changes that agent's work, so it reaches the agent (unless its host
        // confirmed it stopped) and the coordinator (final review). Nobody else is woken by role: the agent whose work is
        // ready names who reviews it (project instructions, phase 4).
        const told = own ? (lead && ['needs_human', 'blocked', 'review', 'done'].includes(command.status) ? [lead] : [])
          : [...command.status === 'stopped' ? [] : [assignment.agentId], ...lead ? [lead] : []]
        const recipients = [...new Set(told)].filter(id => actor.kind !== 'agent' || id !== actor.agentId)
        const asked = !command.ask ? '' : effects.result.notAsked ? `\n\n${effects.result.notAsked}` : `\n\nAsked ${person(state, command.ask.personId).email}.`
        message(group.id, `${label}${command.result ? `\n\n${command.result}` : ''}${asked}`, recipients, null, SYSTEM_ROW)
        // The server opens no review by itself: the agent whose work is ready opens and assigns it, as the project's instructions
        // say (project instructions, phase 4). When no machine the project may use can start either engine, or soon none
        // will, the project's coordinator hears it once, in its chat (reviewCapacity.ts).
        const short = command.status === 'review' && !group.reviewOf ? reviewCapacityNotice(state, group, context.now, (machineId, contributorId) =>
          !teamWorkCheck(state, machineId, contributorId, groupProject(state, group), context.now, context.teamMachines, context.otherWorkspaceMachines)) : null
        // A row of its own beside the command's, as the ship notice is: written as the Engineer who handed over. A server notice,
        // the coordinator's alone (model.ts NOTICE_READERS), untagged, since people cannot read it; with no coordinator in the
        // chat, its people read it and those who can fix it are tagged (spec, "Server notices to the coordinator"; final review).
        const chat = short ? state.conversations.find(c => c.id === short.conversationId) : undefined
        const coordinator = chat?.leadId && chat.agentIds.includes(chat.leadId) && chat.leadId !== (actor.kind === 'agent' ? actor.agentId : null) ? chat.leadId : null
        if (short) effects.messages.push({ id: stableId(operationId, 'review-capacity', short.source.engine), conversationId: short.conversationId, author: sender,
          text: short.text, replyTo: null, recipients: coordinator ? [coordinator] : [], source: short.source,
          ...(!coordinator && short.mentions.length ? { mentions: short.mentions } : {}) })
        // Shipped before this command: the leaderboard marks this Done as shipped just above (recordStatus).
        if (command.status === 'done' && shippedAt(conversation(original, group.id)) == null) {
          appendPullRequestUrls(group, [command.result, ...group.checks.map(check => check.evidence)])
          const shipped = shipNotice(state, group, sender, operationId)
          if (shipped) effects.messages.push(shipped)
        }
      }
      if (actor.kind === 'agent') renewOwnTask(group, actor.agentId, context.now)
      // The time it waited for its review never counts, whoever moved it on.
      if (waited && activeWork(group) && !waitingForReview(assignment)) restartQuietTime(assignment, context.now)
      break
    }
    case 'work.cancel': {
      projectChatWork(command.conversationId)
      const group = open(state, command.conversationId)
      const assignment = group.assignment
      const project = groupProject(state, group)
      const allowed = projectAgent(state, actor, project.id) || (actor.kind === 'person' && actor.userId === state.ownerId)
      // A task nobody was ever assigned, such as a review nobody was free for, has no assignment to name: whoever may cancel
      // work cancels it by "current", and it archives with the reason (Ken, 2026-10-30: 28 reviews waited for a Reviewer with
      // no way out). So does a linked task (reviewOf) whose agent stopped or finished, by "current" or that ended attempt's id
      // (the CLI fills "current" with it). A named id, a chat, or anyone else is refused as before.
      const unassigned = !assignment && command.assignmentId === 'current'
      const reviewEnded = !!group.reviewOf && !!assignment && ['stopped', 'done'].includes(assignment.status)
        && (command.assignmentId === 'current' || command.assignmentId === assignment.id)
      if ((unassigned || reviewEnded) && allowed && group.id !== project.leadConversationId && !group.kind && !group.audience) {
        message(group.id, `${who} cancelled this task: ${command.reason.replace(/[.\s]+$/, '')}.`, [], null, SYSTEM_ROW)
        // Its line is a report the coordinator acknowledges first, so the sweep puts it to sleep later (sweeps.ts), as for any archive.
        group.archived = true
        break
      }
      if (!assignment || assignment.id !== command.assignmentId) fail('STALE_ASSIGNMENT', 'This is no longer the active assignment.')
      if (!allowed) fail('FORBIDDEN', 'Only an agent of this project or the tab owner can cancel work.', 403)
      // A retry after the cancel keeps the first reason and tells the worker once.
      if (assignment.status === 'cancelled') break
      const lost = assignment.status === 'lost'
      if (!activeWork(group) && !lost) fail('ATTEMPT_CLOSED', 'This attempt has already ended.')
      // A removed worker (reconciling) can never confirm a stop, so this is the only way to close its task; nobody is left to tell.
      // A lost task's agent was told already that its task moved, and does not wait for a decision.
      const gone = assignment.status === 'reconciling' || lost
      assignment.status = 'cancelled'
      assignment.result = command.reason
      if (!lost) finishWorker(state, assignment.agentId)
      message(group.id, `${who} cancelled this task: ${command.reason.replace(/[.\s]+$/, '')}.${gone ? '' : ' Stop working on it.'}`,
        // Telling its agent to stop is the agent's alone; people read the cancel and its reason on the task itself.
        gone ? [] : [assignment.agentId], null, gone ? SYSTEM_ROW : forRecipients(SYSTEM_ROW))
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
      effects.messages.push(...leadNoticeRows(toLead(state, worker, { id: stableId(operationId, 'resumed'), conversationId: group.id, author: sender, replyTo: null,
        recipients: [], text: `${worker.displayName ?? worker.name} resumed its task after its usage limit reset.`,
        source: { kind: 'work-resumed', agentId: worker.id, assignmentId: assignment.id } })))
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
      // Checks are information (project instructions, phase 4): who passes one is the project's workflow, so anyone in the task
      // records a verdict, its assignee too, and a failed one leaves the work's status as its agent set it. A verdict counts as a
      // review only from someone other than the assignee (leaderboard/record.ts).
      check.evidence = command.evidence
      check.passedBy = command.passed ? actorKey(actor) : null
      const run = group.ledger?.runs?.find(r => r.assignmentId === group.assignment!.id), reviewed = run?.firstReview
      const byAssignee = actor.kind === 'agent' && actor.agentId === group.assignment.agentId
      // Before the review's first verdict is kept: a check's verdict counts once per attempt.
      if (actor.kind === 'agent') recordVerdict(state, group, check, agent(state, actor.agentId), context.now)
      recordReview(group, check, command.passed, byAssignee)
      // A grid attempt whose first review just failed is told to the coordinator (decision 8); a subscription attempt's is not.
      if (reviewed !== false && run?.firstReview === false && run.grid) reviewFailed(group, run.model ?? 'its grid model', command.evidence)
      // An older skill's working hand-off stops waiting once someone else's verdict finds problems in it: its quiet time counts
      // from now (liveness.ts waitingForReview). Its status stays as its agent set it.
      if (!command.passed && !byAssignee && group.assignment.status === 'working' && waitingForReview(group.assignment)) {
        group.assignment.reviewFoundAt = context.now
        restartQuietTime(group.assignment, context.now)
      }
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
    const acknowledged = command.type === 'swarm.delete' || command.type === 'agent.remove' && command.agentId === target.id &&
      (actor.kind === 'agent' && actor.agentId === target.id || actor.kind === 'person' && [state.ownerId, target.contributorId].includes(actor.userId))
    if (!acknowledged && !state.agents.some(a => a.id === target.id)) fail('STOP_REQUESTED', 'Wait for the execution host to finish stopping its workers before withdrawing them.')
  }
  dropIdleBuddyMachines(state, context.now)
  if (context.registrations) requireSingleRegistration(original, state, context.registrations)
  markConfidential(state)
  assignAgentDisplayNames(state.agents)
  keepUsernames(original, state)
  // The size limit is per stored part now (parts/commit.ts PART_LIMIT_BYTES); a Swarm as a whole has none.
  // Every row this command writes, whatever its words came from: an older message resent, a rule written before this check.
  for (const draft of effects.messages) {
    const clean = redactCredentials(draft.text)
    if (clean.removed.length) { draft.text = clean.text; removed.push(...clean.removed) }
  }
  if (removed.length) Object.assign(result, credentialResult(removed))
  for (const draft of effects.messages) {
    const group = state.conversations.find(c => c.id === draft.conversationId)
    if (group) bindPullRequestCards(group, draft)
  }
  // A Buddy hears the project-chat rows about its person's proposals and requested work (buddyNews.ts).
  for (const draft of effects.messages) tellBuddies(state, draft, draft.replyTo && draft.replyTo === context.reply?.id ? context.reply.threadSource ?? null : null)
  // Each row is stored under its id: two alike roll the whole command back on a duplicate key, in the store alone (review of
  // #2275: the review-capacity notice took the Ready for review row's id, so no Builder could hand over during a shortage).
  const ids = new Set<string>()
  for (const draft of effects.messages) {
    if (ids.has(draft.id)) throw new Error(`Command ${command.type} wrote two messages with the id ${draft.id}.`)
    ids.add(draft.id)
  }
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
