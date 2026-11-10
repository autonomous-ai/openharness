import { authorizeTaskApproval, pendingTaskApproval, personalApprovalCommand, rejectTaskApproval, REQUESTER_LEFT, requireTaskApproval, stageTaskApproval, undecidedProposal } from './taskApproval.js'
import { handoffAsk, pulseProjectOf, recordPulse, owe, settleDeleted, settleReaction, settleReply, settleRequest } from './pulse.js'
import { linesOf } from './statusCard.js'
import { applyPushOrigin, barredFromTeamWritten, failPushUnknown, failTeamWritten, mainAccountMembers, markHeldByTeam, mayName, ownersOwnAgent, ownersOwnMachine, requireTeamWrittenAccount, requireTeamWrittenMachine, TEAM_WRITTEN_REASON, TEAM_WRITTEN_STOP, teamWrittenTask } from './teamWritten.js'
import { crewMoveFailed, takeOverCrewMember } from './crewKeep.js'
import { moveTimingRow } from './crewTimes.js'
import type { PushOrigin } from '../github/pushOrigin.js'
import { admitMachineStart, AGENT_MEMORY_BYTES, noRepositoryStart, defaultProfileId, storedProfileId, homeFolder, cleanupOverdue, machineLimitReached, MACHINE_LIMIT_MESSAGE, downSince, expireRemoval, expireRemovals, failTeamWork, machineContribution, machineOffline, contributedEngines, ownedMachine, projectFolder, requireTeamWork, teamWorkCheck, NOT_YOUR_COMPUTER, type ContributedMachine } from './machines.js'
import { movableEntry } from './computerMoves.js'
import { agentDisplayName, assignAgentDisplayNames } from './agentNames.js'
import { ACCEPT_ALL_REFUSAL, mayAcceptAll, memberMachine, memberOf } from './members.js'
import { ownedPath, pathsOverlap } from './ownedPaths.js'
import { addedAgentName, newAgentName, renameAgentTo } from './agentRename.js'
import { addCrew, CREW_ROLE_MAX, removeCrew } from './crew.js'
import { githubRelaySchema, relayGitHub } from './githubRelay.js'
import { ownsBoard, readsProject, requireCanChat, requirePriorityRight } from './boardRights.js'
import { keepUsernames, swarmUsernames, usernameOf } from './usernames.js'
import { agentWrittenNameOf, nameFromAccount } from './personNames.js'
import { z } from 'zod'
import {
  activeWork, actorKey, agent, author, projectPullRequestUrl, UNLINKS_KEPT, conversation, crossProjectActive, fail, isLeads, person, stableId, numberConversations, nextConversationNumber, renderWorkTask,
  finishWorker, seenMachineIds, SuperTabError, swarmGridName, visibleState, AGENT_ONLY, forRecipients,
  type Actor, type AgentConfiguration, type AgentStart, type AgentStartRequest, type WorkTask, type Agent, type Author, type Check, type CommandEffects, type Conversation, type Person, type SuperTabState,
} from './model.js'
import { jobKindOf } from './evidence/jobKind.js'
import { endSteps, isStep, stepEndedRows } from './steps.js'
import { noteWriter } from './stuck.js'
import { routeRecordSchema, routeTitle, type KeptCandidate, type RouteDecision, type RouteFinal, type RouteOverride } from './routeRecord.js'
import { routingOverrideSaveSchema } from './routingPolicy.js'
import { askedInSchema, RULE_MESSAGE_MS, ruleSchema, ruleTextSchema } from './rules.js'
import { projectRulesSchema, rulesDiff, rulesEqual, seedRules, SEED_RULES, type ProjectRules } from './policy.js'
import { isReview, machineRuleRefusal } from './machineRules.js'
import { MAX_ATTACHMENTS, type Attachment } from './attachments.js'
import { agentsNamedIn, checkMentions, MAX_MENTIONS, namedIn, saysName, textTags, withTags } from './mentions.js'
import { CREW_NEED_KIND, crewNeedPlace, crewNeedText, routedLine, routesToPm, type CrewNeed } from './crewNeeds.js'
import { leadOf, TERMINAL_KEYS, terminalAlert, terminalRequest, terminalResult, toLead, type TerminalRequest } from './terminal.js'
import { loseTasks, recordTaskState, renewOwnTask } from './liveness.js'
import { DELETED_SWARM_COMMANDS, isPersonalSwarm, notThere, SWARM_DELETE_GRACE_MS } from './deletion.js'
import { ABANDONED, askedModel, coordinatorCopy, failureNotice, failureRecipients, MACHINE_MOVED, MACHINE_REMOVED, publicReason } from './startFailure.js'
import { noteStartFailed, noteStartSucceeded, resumeEngine } from './engineHealth.js'
import { processOf, type ProjectProcess } from './process.js'
import { credentialResult, redactCredentials, type CredentialKind } from './credentials.js'
import { reportGroups, summarize } from './projectUpdates.js'
import { cloneData } from './cloneData.js'
import { PULL_REQUEST_URL, recordAsked, recordPost, recordReportedModel } from './leaderboard/record.js'
import { reactionSchema, type ReactionTarget } from './reactions.js'
import { deleteMessage, editMessage, type MessageChangeTarget } from './messageEdits.js'
import { syncTaskLines } from './taskLine.js'
import { bindPullRequestCards, bindTaskCard, pullRequestCard } from './cards.js'
import { avatarChoice, setAgentAvatar, setMemberAvatar } from './profile.js'
import { cancelledTags, cancelReason, switchExpired, unfinishedWork } from './tidy.js'
import { namedDefault } from './catalog.js'
import { BUILT_IN_ROLE_DEFAULTS, NO_PROJECT, inChannelOf, isAgentChat, agentProjectId, groupRepositoryUrl, canReadAgent, canReadProject, deletableProject, deleteProject, markConfidential, ownsProject, admitPerson, dismissPeople, requireSingleRegistration, groupProject, inviteLanding, ledProject, manageProject, MAX_ROLES, mutableProjects, placeRules, projectAgent, projectMembers, projectOf, projectsOf, readAgent, readConversation, readProject, sameProject, sharedWithLeads, withRoleDefaults, type SwarmProject, PROJECT_STATUS_MAX } from './projects.js'
import { recordClosing, sessionClosed } from './closedAgents.js'
import { declinedWith, declinedWithout } from './sharing.js'
import { actorLabel, memberChanges, memberRowText, quotedName } from './memberRows.js'
import { launchRefusedLine, leadArrived, LEAD_CLAIM_MS, leadEffort, leadJoined, leadOvertaken, leadStartFailed, leadStarting, leadWaits, LEAD_CAPABILITY, placeLead } from './leadStart.js'
import { defaultAccountOnly, SWITCH_CAPABILITY } from './pmAccount.js'
import { ACK_ONLY_HINT, isAcknowledgement } from './acknowledgements.js'
import { isProjectChat, inMainChat, requireChatContent, requireChatPost, recordChatAsk, recordChatPost, requireChatAnswer, recordChatAnswer } from './chatLimits.js'
import { allowedDrops, approvedDropNotice, droppedLines, MAX_APPROVALS, MAX_DROPPED_LINES, refuseOverBudget, refuseRepeats, type ApprovalRow, type DroppedLine } from './ruleGuard.js'
import { appendRouting, coordinatorNameOf, routingSummary, FIRST_INSTRUCTIONS, FIRST_SUMMARY, instructionsHash, instructionsTextSchema, legacyRoleName, liveNotes, MAX_NOTES, noteTextSchema, roleNameSchema, summarySchema, type PmNote } from './instructions.js'
import { repeatedRules } from './instructionsDiff.js'
import { INSTRUCTIONS_TEMPLATE } from './instructionsTemplate.js'
import { BASE_DOCUMENT, BASE_VERSION } from './instructionsRebase.js'
import { contractRefusal, missingContract } from './taskContract.js'
import { DEFAULT_PRIORITY, PRIORITY_DEFAULTED, TASK_PRIORITIES } from './taskPriority.js'
import { inThread, leadsGroup, recordAnswered, requireUnanswered } from './answers.js'
import { stampLane } from './dispatch.js'
import { retiredCommandSchemas, retiredAnswer } from './retired.js'

const id = z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/)
/** A route override's reason when its agent gave none, on a decision whose chosen candidate was not a pick (a person's choice, or an older record). */
const NO_REASON = 'No reason given.'
/** What a pick-less route's only candidate is chosen for, when its start gives no reason (task #2901). */
const ONLY_CANDIDATE = 'Only candidate that can run this task.'
/** What an older client's policy, skill-set, role or rule-removal save answers: accepted, kept nowhere (project instructions,
 *  phase 4, decision 3). The old rules, policy rows and role texts stay in place, unread. */
/** How long a Swarm invitation stays open; its sent time is its expiry minus this (store.ts invite.accept). */
export const SWARM_INVITATION_MS = 7 * 86_400_000

export const IGNORED_NOTE = 'Routing and roles live in each project\'s instructions now. Update Harness to edit them there.'
const title = z.string().trim().min(1).max(160)
const reason = z.string().trim().min(1).max(300)
const SWITCH_LEASE_MS = 15 * 60_000
/** The engines as people read them in a switch's line. */
const ENGINE_NAMES: Record<string, string> = { claude: 'Claude', codex: 'Codex' }
const moveToProfile = (target: Agent, engine: string, profileId: string | undefined) => {
  const stored = storedProfileId(target.machineId, engine, profileId)
  if (stored === undefined) delete target.profileId; else target.profileId = stored
}
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
/** An access name a task listed as needed: an older client's, stored for older readers and read by nothing since machine.access went
 *  (a task naming one starts on any machine now). Delete it with the task records (slice S13). */
const accessName = z.string().trim().min(1).max(60).regex(/^[^\n\r\t]+$/)
// `independent` is an older client's: stored for older readers, read by nothing (checks are information, project instructions).
const check = z.object({ description: z.string().trim().min(1).max(1000), independent: z.boolean().optional() }).strict()
/** A task's checks as stored, none passed; `independent` false when a newer client leaves it out, as older readers expect it. */
const storedChecks = (checks: ReadonlyArray<z.infer<typeof check>>, operationId: string): Check[] =>
  checks.map((c, i) => ({ description: c.description, independent: c.independent ?? false, id: stableId(operationId, String(i)), evidence: null, passedBy: null }))

const task = z.object({
  goal: z.string().trim().min(1).max(8000), changes: z.string().trim().min(1).max(8000),
  constraints: z.string().trim().min(1).max(8000), owns: z.array(z.string().trim().min(1).max(4096)).min(1).max(40),
  /** model.ts TaskRequirement; `unseenMachines` is only ever read back, never set. */
  requires: z.object({ machines: z.array(id).min(1).max(20).optional(), devices: z.array(path).min(1).max(20).optional(),
    access: z.array(accessName).min(1).max(20).optional() }).strict()
    .refine(r => r.machines || r.devices || r.access, 'Require at least one machine, device or access.').optional(),
  /** model.ts WorkTask.strength: `strong` for big, hard or risky work, which the crew's dispatch hands only to a member on Opus or Astra (#3576). */
  strength: z.enum(['standard', 'strong']).optional(),
  /** model.ts ReviewPlan: what its reviews check first, and 2 for two independent reviews, said in its brief (#2382). */
  review: z.object({ focus: z.string().trim().min(1).max(2000).optional(), reviews: z.union([z.literal(1), z.literal(2)]).optional() }).strict()
    .refine(r => r.focus !== undefined || r.reviews !== undefined, 'Give the review a focus or a number of reviews.').optional(),
}).strict()

/** The machines a Swarm remembers its people took out. */
const MAX_REMOVED_MACHINES = 64

export const commandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('machine.contribute'), machineId: id, name: title, cwd: path, scope: z.literal('swarm').optional(), engines: z.array(swarmEngine).min(1).max(2), maxAgents,
    // Its Agents setting (machines.ts agentLimit): an older client leaves it out.
    agents: z.enum(['memory', 'atMost']).optional(),
    ifMissing: z.literal(true).optional(), teamAccountOnly: z.literal(true).optional(),
    // With ifMissing: not if its person took it out (Swarm removedMachines). A Personal Swarm's own sync sends it (#2181).
    unlessRemoved: z.literal(true).optional() }).strict(),
  z.object({ type: z.literal('machine.pause'), machineId: id, paused: z.boolean() }).strict(),
  // The store's alone (context.computerMove): another account signed in on the computer [machineId] is on (#3122).
  z.object({ type: z.literal('machine.moved'), machineId: id }).strict(),
  // The store's alone (context.teamMachineGone): a Harness Team account's machine leaves (migration/teamMachinesJob.ts; goes
  // with that job, on or after 2026-12-10).
  z.object({ type: z.literal('machine.teamGone'), machineId: id }).strict(),
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
  z.object({ type: z.literal('project.create'), name: title, visibility: z.enum(['public', 'private']), brief: z.string().trim().max(8000).default(''), process: z.enum(['simple', 'full']).optional() }).strict(),
  z.object({ type: z.literal('project.process'), projectId: id, process: z.enum(['simple', 'full']) }).strict(),
  z.object({ type: z.literal('project.rename'), projectId: id, name: title }).strict(),
  z.object({ type: z.literal('project.delete'), projectId: id }).strict(),
  // A closed tab's project in the person's own Personal Swarm (task #3929, desktop personal_projects.dart): deleted when none of
  // its conversations has a message, archived otherwise. `tabOperation`: the request that created it, `personal-tab-…`.
  z.object({ type: z.literal('project.closeTab'), projectId: id, tabOperation: z.string().regex(/^personal-tab-[A-Za-z0-9_-]{1,120}$/) }).strict(),
  z.object({ type: z.literal('project.sharing'), projectId: id, visibility: z.enum(['public', 'private']), memberIds: z.array(id).max(200) }).strict(),
  // A project's Board settings (boardRights.ts, task #3819), set by its owner or the Swarm's owner.
  z.object({ type: z.literal('project.boardMode'), projectId: id, on: z.boolean() }).strict(),
  z.object({ type: z.literal('project.canChat'), projectId: id, personId: id, granted: z.boolean() }).strict(),
  z.object({ type: z.literal('project.decider'), projectId: id, personId: id.nullable() }).strict(),
  z.object({ type: z.literal('project.cadence'), projectId: id, minutes: z.union([z.literal(1), z.literal(5), z.literal(15), z.literal(30)]) }).strict(),
  // `through`: each conversation's sequence the Lead read, as its wake-up names them. `throughRevision` is the tab revision a
  // wake-up from before the store by parts named; it is accepted only up to that split (projectUpdates.ts).
  z.object({ type: z.literal('project.report'), projectId: id, through: z.record(id, z.number().int().nonnegative().safe()).optional(),
    throughRevision: z.number().int().nonnegative().safe().optional(),
    text: z.string().trim().min(1).max(PROJECT_STATUS_MAX, `Keep your own status lines under ${PROJECT_STATUS_MAX.toLocaleString('en-US')} characters: the Swarm writes the line of every active task.`).nullable() }).strict()
    .refine(c => (c.through === undefined) !== (c.throughRevision === undefined), 'Acknowledge with through, the map your wake-up names.'),
  z.object({ type: z.literal('project.repository'), projectId: id, repositoryUrl }).strict(),
  // The project's instructions, saved on the revision the writer read (instructions.ts). `askedBy`: the member whose words it
  // carries, required of the coordinator; a person writes in their own.
  z.object({ type: z.literal('instructions.save'), projectId: id, baseRevision: z.number().int().nonnegative().safe(), text: instructionsTextSchema,
    summary: summarySchema, askedBy: id.optional(),
    // A person's own messages approving the drop of their rules (ruleGuard.ts), when the save drops any.
    approvals: z.array(id).max(MAX_APPROVALS).optional(),
    // Code tasks the save's rules moved into (ruleGuard.ts rulePlaces), loaded even when quiet (store.ts namedFor; #3392).
    tasks: z.array(id).max(MAX_APPROVALS).optional(),
    // How the writer sorted the lines it dropped, for the History (ruleGuard.ts droppedLines; the daily tidy).
    dropped: z.array(z.object({ text: z.string().trim().min(1).max(2000), kind: z.enum(['merged', 'expired', 'rule']) }).strict())
      .max(MAX_DROPPED_LINES).optional(),
    // A person keeping a line that repeats one the document has, and why (ruleGuard.ts refuseRepeats; the coordinator's is ignored).
    repeatReason: z.string().trim().min(1).max(100).regex(/^[^\r\n]*$/, 'Give the reason in one line.').optional() }).strict(),
  // The project's rules record, saved on the revision the writer read (policy.ts). A person writes in their own name; the
  // project's PM only with `askedIn`, the person's own chat message it passes on.
  z.object({ type: z.literal('rules.set'), projectId: id, baseRevision: z.number().int().nonnegative().safe(), rules: projectRulesSchema,
    summary: summarySchema, askedIn: askedInSchema.optional() }).strict(),
  // A small thing a member told the coordinator, kept beside the instructions until it ends, if it does (instructions.ts).
  z.object({ type: z.literal('note.add'), projectId: id, text: noteTextSchema, askedBy: id, expiresAt: z.iso.datetime().optional() }).strict(),
  z.object({ type: z.literal('note.remove'), projectId: id, noteId: id }).strict(),
  // What the project calls its coordinator, as its instructions say (instructions.ts coordinatorNameOf).
  z.object({ type: z.literal('project.coordinatorName'), projectId: id, name: roleNameSchema }).strict(),
  // What the project is, in one line, for the Cmd-N and join project list (task #4540): empty clears it.
  z.object({ type: z.literal('project.about'), projectId: id, about: z.string().trim().max(80).regex(/^[^\r\n]*$/, 'One line.') }).strict(),
  // Whether its agents answer each person's message in that message's thread (projects.ts answersInThread, task #3747).
  z.object({ type: z.literal('project.answers'), projectId: id, inThread: z.boolean() }).strict(),
  z.object({ type: z.literal('lead.start'), projectId: id, machineId: id.nullable(), engine: swarmEngine,
    model: z.string().trim().min(1).max(200).optional(), effort: z.string().trim().min(1).max(80).optional(),
    branchRef: z.string().max(1024).regex(/^refs\/(heads|remotes)\/[^\s\x00-\x1f\x7f]+$/).optional(), repositoryUrl: repositoryUrl.optional() }).strict(),
  // A Personal Swarm's one start of a project's Lead by its person's Desktop, on their message in its chat (leadStart.ts).
  z.object({ type: z.literal('lead.claim'), projectId: id, machineId: id }).strict(),
  z.object({ type: z.literal('lead.switch'), projectId: id, engine: swarmEngine, profileId: id, machineId: id.optional(),
    model: z.string().trim().min(1).max(200).optional(), effort: z.string().trim().min(1).max(80).optional() }).strict(),
  z.object({ type: z.literal('project.skills'), projectId: id, mode: z.enum(['default', 'orchestration', 'custom']), askedIn: askedInSchema.optional() }).strict(),
  z.object({ type: z.literal('project.roles.create'), projectId: id, roles: roleSet }).strict(),
  z.object({ type: z.literal('project.role.set'), projectId: id, role }).strict(),
  z.object({ type: z.literal('project.role.remove'), projectId: id, roleId }).strict(),
  z.object({ type: z.literal('project.roles.reset'), projectId: id, roles: roleSet }).strict(),
  // `audience`: a private conversation that only these people and the project's Lead read (projects.ts canReadGroup).
  z.object({ type: z.literal('work.teamWritten'), conversationId: id }).strict(),
  z.object({ type: z.literal('conversation.create'), projectId: id.optional(), title, brief: z.string().trim().max(8000).optional(), task: task.optional(), reviewOf: id.optional(),
    // How urgent the task is (taskPriority.ts); without one it is P2, and the reply says so.
    priority: z.enum(TASK_PRIORITIES).optional(),
    // Work no person asked for (a flaky test seen twice, an alarm) names nobody; this says why, in a few words (taskContract.ts).
    noRequesterReason: z.string().trim().min(1).max(200).optional(),
    // A step of the task `reviewOf` names, as an older CLI sends it: the store answers it as retired (retired.ts opensRetiredStep).
    step: z.string().min(1).max(40).optional(), checks: z.array(check).max(40),
    audience: z.object({ personIds: z.array(id).max(200) }).strict().optional(), requesterId: id.optional(),
    // A person's own message in the project chat that asked for the work: it stays the task's root (Dee, 2026-11-03).
    requestMessageId: id.optional() }).strict()
    .refine(c => c.task !== undefined || c.brief !== undefined, 'Provide a task or brief.')
    .refine(c => !c.task || renderWorkTask(c.task).length <= 8000, 'Keep the rendered task within 8,000 characters.'),
  z.object({ type: z.literal('conversation.rename'), conversationId: id, title }).strict(),
  z.object({ type: z.literal('conversation.archive'), conversationId: id, archived: z.boolean() }).strict(),
  z.object({ type: z.literal('conversation.requester'), conversationId: id, personId: id.nullable() }).strict(),
  // A wrong link taken off a task, with its reason kept in the task's history (task #3953): by the project's coordinator or the
  // task's Engineer, never a pull request whose merge the task recorded.
  z.object({ type: z.literal('conversation.unlink'), conversationId: id, pullRequestUrl: z.string().max(400).regex(PULL_REQUEST_URL),
    reason: z.string().trim().min(1).max(300) }).strict(),
  // `launchRefused`: the model and effort a Product Manager's own-machine launch asked for, which that machine refused before
  // launching anything, so it runs its engine's own model (Desktop AgentCreationAttempt; leadStart.ts launchRefusedLine).
  z.object({ type: z.literal('agent.add'), conversationId: id, machineId: id, harnessId: id, name: title, configuration, lead: z.boolean(), project: project.optional(), roleId: roleId.optional(),
    roleName: roleNameSchema.optional(), initialMessage: text.optional(),
    launchRefused: z.object({ model: z.string().regex(LAUNCH_MODEL), effort: z.string().regex(LAUNCH_EFFORT).optional() }).strict().optional() }).strict(),
  z.object({ type: z.literal('agent.start'), request: startRequestSchema, routeDecisionId: id.optional(), overrideReason: reason.optional() }).strict(),
  // An agent's line to one person: the PM's crew need in the project chat (crewNeeds.ts), else refused.
  z.object({ type: z.literal('person.tell'), personId: id, text: z.string().trim().min(1).max(32_000) }).strict(),
  // + New agent (Swarm v3, task #4116): a Regular agent in a chat of its own, or a PM that names and starts a project, on the
  // person's own listed computer and account.
  z.object({ type: z.literal('agent.new'), kind: z.enum(['regular', 'pm']), machineId: id, engine: swarmEngine,
    model: z.string().trim().min(1).max(200).optional(), name: z.string().trim().min(1).max(80).optional(), projectName: title.optional(),
    repositoryUrl: repositoryUrl.optional(),
    // The Member's main project (task #4540): only on the Swarm's start of a Member; New project makes the Lead of its own.
    mainProjectId: id.optional(),
    // A Member its person's Desktop starts itself through Cmd-N (task #4196): only its chat opens here; agent.add brings in the session.
    local: z.literal(true).optional() }).strict(),
  z.object({ type: z.literal('agent.startDispatch'), startId: id }).strict(),
  // A Member's own host reports its project set up, with the commands it ran for a helper to repeat, or why it failed (#4698).
  // ok true with its steps, ok false with its reason (checked in its handler).
  z.object({ type: z.literal('agent.setUp'), projectId: id, ok: z.boolean(), steps: z.array(z.string().trim().min(1).max(300)).max(10).optional(),
    reason: z.string().trim().min(1).max(500).optional() }).strict(),
  z.object({ type: z.literal('agent.started'), startId: id, harnessId: id, configuration,
    startedSession: z.object({ sessionId: id, createdAt: z.iso.datetime() }).strict().optional() }).strict(),
  // `configuration`: what the agent runs as its start last saw it, so work assigned after the settle records its model (CLI
  // superTabs/start.ts). Absent from a CLI before it, and when the agent reported none in time.
  z.object({ type: z.literal('agent.startSettled'), startId: id, warning: z.string().max(2000).nullable(),
    configuration: configuration.optional() }).strict(),
  z.object({ type: z.literal('agent.startFailed'), startId: id, error: text }).strict(),
  // Why its machine holds a start it has not launched, told once per reason (cli superTabs/machines.ts): shown on the start until it ends.
  z.object({ type: z.literal('agent.startWaiting'), startId: id, reason: text }).strict(),
  z.object({ type: z.literal('agent.stopLease'), agentId: id, releaseId: id }).strict(),
  z.object({ type: z.literal('agent.switchClaim'), agentId: id, switchId: id }).strict(),
  // The source PM's host sends the prepared handoff to the candidate start; it is not a general chat message or visible to readers.
  z.object({ type: z.literal('agent.switchHandoff'), agentId: id, switchId: id, handoffChangeId: id,
    note: z.string().max(32_000) }).strict(),
  // The host's own words for why it failed: free text, so capped and redacted.
  z.object({ type: z.literal('agent.switchResult'), agentId: id, switchId: id, ok: z.boolean(), error: z.string().trim().min(1).max(300).optional(), down: z.boolean().optional() }).strict(),
  z.object({ type: z.literal('agent.stopRefused'), agentId: id, releaseId: id }).strict(),
  z.object({ type: z.literal('agent.remove'), agentId: id, releaseId: id.optional() }).strict(),
  // Rename Harness on the agent's Mac renames the agent for every reader (task #2912); the contributor or machine owner only.
  z.object({ type: z.literal('agent.rename'), agentId: id, name: z.string().max(200) }).strict(),
  z.object({ type: z.literal('agent.release'), agentId: id, decision: z.enum(['keep', 'stop']) }).strict(),
  githubRelaySchema,
  z.object({ type: z.literal('crew.add'), agentId: id, role: z.string().trim().min(1).max(CREW_ROLE_MAX).regex(/^[^\x00-\x1f\x7f]+$/).optional(), lane: z.string().trim().min(1).max(80).regex(/^[^\x00-\x1f\x7f]+$/).optional() }).strict(),
  z.object({ type: z.literal('crew.remove'), agentId: id }).strict(),
  z.object({ type: z.literal('agent.sessionClosed'), agentId: id, harnessId: id }).strict(),
  z.object({ type: z.literal('agent.configuration'), previousVersion: id.nullable(), configuration }).strict(),
  z.object({ type: z.literal('agent.rebind'), agentId: id, machineId: id, projectId: id.optional(),
    previousHarnessId: id, harnessId: id, configuration, profileId: z.string().regex(/^([0-9a-f]{16}|default)$/).optional(),
    startedSession: z.object({ creationId: id, sessionId: id, createdAt: z.iso.datetime() }).strict().optional() }).strict(),
  z.object({ type: z.literal('conversation.agent'), conversationId: id, agentId: id, present: z.boolean(), lead: z.boolean() }).strict(),
  z.object({ type: z.literal('invite.create'), email: z.email().max(320), role: z.enum(['collaborator', 'viewer']), conversationId: id }).strict(),
  z.object({ type: z.literal('invite.revoke'), inviteId: id }).strict(),
  z.object({ type: z.literal('invite.accept'), inviteId: id }).strict(),
  z.object({ type: z.literal('member.remove'), userId: id }).strict(),
  z.object({ type: z.literal('member.approvalMode'), mode: z.enum(['autoApprove', 'review']) }).strict(),
  z.object({ type: z.literal('task.suggest'), conversationId: id, agentId: id }).strict(),
  // The suggested agent the person was shown, null for none (task #4217): compared, never read. Optional only for Desktops
  // from before it, until 2026-12-07.
  z.object({ type: z.literal('task.approve'), conversationId: id, suggestedAgentId: id.nullable().optional() }).strict(),
  z.object({ type: z.literal('task.reject'), conversationId: id, reason: z.string().trim().min(1).max(2000) }).strict(),
  // Clear-only since 2026-11-09 (profile.ts): an older app's new picture is refused in words.
  z.object({ type: z.literal('member.avatar'), avatar: avatarChoice }).strict(),
  z.object({ type: z.literal('agent.avatar'), agentId: id, avatar: avatarChoice }).strict(),
  // Text may be empty when the message carries files; applyCommand checks that one of them is there.
  z.object({ type: z.literal('message.send'), conversationId: id, text: z.string().trim().max(32_000), replyTo: id.nullable(), recipientIds: z.array(id).max(16),
    alsoSend: z.literal(true).optional(), attachmentIds: z.array(id).max(MAX_ATTACHMENTS).optional(), mentions: z.array(id).max(MAX_MENTIONS).optional(),
    // `mentionsIfNoWorker` held a Lead's tags while a task had no worker, in the tag lists Swarm v4 removed (2026-11-10): an older CLI
    // still sends it, and it is taken and kept nowhere. Delete it on or after 2026-12-09.
    mentionsIfNoWorker: z.literal(true).optional(), agentOnly: z.literal(true).optional(),
    // The message this post answers right below it, in the main flow (anh Dee, 2026-11-04: "every message is a thread"). It
    // settles and routes as a reply to that message does, and opens no thread. Never with replyTo.
    answers: id.optional(),
    // The PM entrusts this owed project-chat ask to the one project agent explicitly addressed by this post in its task.
    handoff: id.optional(),
    // The answer to the message in `answers` (answers.ts, task #3403): placed in that message's thread when it is a reply in
    // one, else right below it, and refused when it was answered already. Only with `answers`.
    answer: z.literal(true).optional(),
    // An agent's own skills notice (instructions changed, skills replaced): the coordinator's goes in its digest
    // (noticeDigest.ts gatheredNotice). Only with `agentOnly`, which keeps it to the agent itself.
    notice: z.literal('skills').optional() }).strict(),
  z.object({ type: z.literal('message.react'), conversationId: id, messageId: id, emoji: reactionSchema, on: z.boolean() }).strict(),
  // The author's own post only (messageEdits.ts); the store finds the row (store.ts messageChangeTarget).
  z.object({ type: z.literal('message.edit'), conversationId: id, messageId: id, text: z.string().trim().max(32_000) }).strict(),
  z.object({ type: z.literal('message.delete'), conversationId: id, messageId: id }).strict(),
  z.object({ type: z.literal('delivery.resolve'), deliveryId: id, resolution: z.enum(['received', 'resend', 'cancel']) }).strict(),
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
  // `head`: the whole commit id of the pull request head the checker read (#3394; never shortened, security review of #3218).
  // Commands v4 no longer has: an older client's is accepted and ignored (retired.ts).
  ...retiredCommandSchemas,
])
export type Command = z.infer<typeof commandSchema>
export const operationSchema = z.object({ operationId: id, command: commandSchema }).strict()

/** The words in each command that people and agents read in the Swarm: messages, briefs and tasks, results, evidence,
 *  reasons, errors and names. `[]` is each item of a list. Every other string a command takes is listed, with why, as not
 *  words in commands.test.ts, whose walk of commandSchema fails on a string in neither (task #4340). */
export const WORDS: Partial<Record<Command['type'], readonly string[]>> = {
  'message.send': ['text'],
  // An edit is a new text in a row everyone reads: cleaned as a send is (security review 2 of #2967).
  'message.edit': ['text'],
  // A GitHub comment, the file it is on and its link, written into a chat as a send is (githubRelay.ts).
  'github.relay': ['text', 'path', 'url'],
  'agent.add': ['name', 'initialMessage', 'roleName'],
  'agent.new': ['name', 'projectName'],
  'agent.setUp': ['steps[]', 'reason'],
  'agent.rename': ['name'],
  'crew.add': ['role', 'lane'],
  'agent.start': ['request.name', 'request.roleName', 'overrideReason'],
  'agent.startFailed': ['error'],
  'agent.startWaiting': ['reason'],
  'agent.switchResult': ['error'],
  'agent.screenResult': ['error'],
  'agent.inputResult': ['error'],
  'agent.switchHandoff': ['note'],
  'agent.startSettled': ['warning'],
  'conversation.create': ['title', 'brief', 'noRequesterReason', 'step', 'task.goal', 'task.changes', 'task.constraints', 'task.owns[]',
    'task.requires.access[]', 'task.review.focus', 'checks[].description'],
  'conversation.rename': ['title'],
  'person.tell': ['text'],
  'task.reject': ['reason'],
  'conversation.unlink': ['reason'],
  'project.create': ['name', 'brief'],
  'project.rename': ['name'],
  'project.report': ['text'],
  'instructions.save': ['text', 'summary', 'repeatReason', 'dropped[].text'],
  'note.add': ['text'],
  'project.coordinatorName': ['name'],
  'project.about': ['about'],
  'rule.set': ['text'],
  'rules.set': ['summary', 'rules.instructionApprovals.people[].name', 'rules.reviews.rows[].area', 'rules.reviews.rows[].paths[]',
    'rules.reviews.test[].where', 'rules.reviews.test[].paths[]', 'rules.reviews.untested[]', 'rules.caps[].name', 'rules.paths[].name',
    'rules.paths[].path', 'rules.crew[].role', 'rules.crew[].names[]', 'rules.lanes[].name', 'rules.lanes[].owns[]', 'rules.machines[].why',
    'rules.machines[].first.lanes[]'],
  'project.role.set': ['role.name'],
  'project.roles.create': ['roles[].name'],
  'project.roles.reset': ['roles[].name'],
  'tab.routingPolicy': ['policy.notes'],
  'route.record': ['decision.assessment.why', 'decision.why', 'decision.excluded[].title', 'decision.excluded[].reason',
    'decision.candidates[].title', 'decision.candidates[].label', 'decision.context.missing[]'],
  'route.override': ['reason'],
  'tab.rename': ['name'],
  'machine.contribute': ['name'],
  // Compared with the Swarm's name, which its rename cleaned the same way.
  'swarm.delete': ['name'],
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
  /** For `machine.moved`: the machine of the account signed in now on the computer the command's machine is on, read by the
   *  store from their account rows (store.ts computerSignedIn), never from a request. `name`: its account row's name, if any. */
  computerMove?: { to: { machineId: string; ownerId: string; name: string | null } }
  /** For `machine.teamGone`: set by the store's one-time job alone (store.ts takeOutTeamMachines), never from a request. */
  teamMachineGone?: true
  /** Read from host ownership/access records by the store, never copied from the request. */
  contribution?: { machineOwnerId: string; contributorId: string; hostGrant?: string | null
    /** The name the machine's owner gave it, from its account row (machines.ts accountMachineName); absent when it has none. */
    machineName?: string }
  /** Loaded from this tab and conversation by the store. */
  /** `thread` is the replied message's thread root, null for a message written before threads (it keeps inline replies), and
   *  `threadSource` that root's source. */
  /** `agentOnly`: a notice people cannot read (model.ts agentOnly), whose thread a reply does not join. */
  reply?: { id: string; conversationId: string; author: Author; createdAt: number; thread?: string | null; threadSource?: Record<string, unknown> | null
    agentOnly?: true }
  /** For a person's top-level `message.send` in a project chat: the last top-level message there before it, read by the store,
   *  so a line right below an agent's reaches that agent (#2924). */
  above?: { author: Author }
  /** The chat message a new group names as its request (conversation.create requestMessageId), loaded from this tab by the store. */
  request?: { id: string; conversationId: string; author: Author; source: unknown; replyTo: string | null }
  /** For `instructions.save`: the project's stored document, read by the store, which a stale save hands back to merge. */
  instructions?: { revision: number; text: string; at?: number } | null
  /** For an instructions.save: when GitHub says each pull request linked to a task the save may move a rule into merged
   *  (ms), null when it did not; one GitHub could not answer for is absent (store.ts pullRequestMergesFor, #3463). */
  pullRequestMerges?: Readonly<Record<string, number | null>>
  /** For `instructions.save`: the messages it names as approvals, loaded by id in this tab by the store (ruleGuard.ts). */
  approvals?: ApprovalRow[]
  /** For `rules.set`, and for a task's Ready whose pull request files were read (its review table plans the steps, #3401):
   *  the project's newest stored rules revision, read by the store; null when none is saved yet, which is the seed at
   *  revision 0 (policyStore.ts). Unread (undefined), nothing is saved. */
  projectRules?: { revision: number; rules: ProjectRules } | null
  /** For `note.add` and `note.remove`: the project's stored notes, expired ones too, read by the store (instructions.ts). */
  notes?: PmNote[]
  /** The message a Lead quotes as the owner's request for a rule or skill mode change, loaded from this tab by the store. */
  askedIn?: { author: Author; source: boolean; createdAt: number }
  /** The newest messages of this conversation before the one being sent, newest first, loaded by the store for `message.send`. */
  recent?: { author: Author; recipients: string[]; createdAt?: number; source?: unknown }[]
  /** An uncertain receipt and its original message, read transactionally. */
  delivery?: { id: string; conversationId: string; agentId: string; messageId: string; text: string; attachments?: Attachment[] }
  /** The files `message.send` names, each checked by the store: uploaded by this actor to this conversation and unused. */
  attachments?: Attachment[]
  /** The words of each voice message's file among [attachments], by its id, read by the store (store.ts readVoice). */
  voiceWords?: Record<string, string>
  /** `invite.accept`'s person's account name, which their name in the Swarm follows (personNames.ts nameFromAccount). */
  accountName?: string | null
  /** The message an agent's `message.react` names, read by the store (reactions.ts). */
  reaction?: ReactionTarget
  /** The message `message.edit` or `message.delete` names, read by the store (messageEdits.ts). */
  messageChange?: MessageChangeTarget
  /** Route decisions this tab recorded in the last hour, counted by the store. */
  /** The decision a command names, read from SuperTabRouteDecision by the store. */
  routeDecision?: RouteDecision
  /** Starts on the machine being contributed that the store found abandoned: never contributed, never dispatched,
   *  and older than ABANDONED_START_MS by their operation receipt. */
  abandonedStartIds?: string[]
  /** The request an `agent.screenResult` / `agent.inputResult` answers, read from SuperTabTerminalRequest by the store. */
  terminalRequest?: TerminalRequest
  /** Each contributed machine's CLI version as its daemon last connected (store.ts machineVersions), read for a start's dispatch. */
  machineVersions?: Record<string, string>
  /** Who pushed the pull requests of the task an agent joins (conversation.agent) or work.teamWritten marks, read before the command (store.ts pushOriginFor). */
  pushOrigin?: PushOrigin
  /** The pull requests [pushOrigin] read, as the store read them; none for a branch. A clean read clears only a mark it covered (teamWritten.ts). */
  pushOriginPulls?: string[]
  /** For a step, the read of its task's own code alone (store.ts pushOriginFor): only it marks the task (task #3554). */
  pushOriginTask?: { origin: 'clean' | 'team' | 'unknown'; pulls: string[] }
}

/** What an agent's post that reached no agent tells its sender, in the result every CLI prints (Egret6's review of #2963):
 *  since #2963 an unnamed post outside a task's assignee reaches no one, and a sender that meant someone to act would not know. */
/** Said in a post's result when it went out without agents it named that may not join Team-written work (teamWritten.ts mayName). */
export const notReachedLine = (names: string[]): string => `Your post was delivered, but not to ${names.join(', ')}: a Harness Team agent wrote this task's code, so an agent in the main account may not join it. `
  + 'Nothing is wrong with your post or with you. Ask the PM to hand the work on, or name an agent in a Team account.'
export const REACHED_NO_AGENT = 'This post reached no agent; people read it in the conversation. Name an agent with --to or @Name when it must act.'
/** Told to a post's sender when a recipient's session is down: the post waits in its queue, and it reads it when it is back. */
export const offlineLine = (names: string[]): string => names.length === 1 ? `${names[0]} is offline; it will read this when it is back.`
  : `${names.slice(0, -1).join(', ')} and ${names.at(-1)} are offline; they will read this when they are back.`

/** Messages in a row between two agents after which their project's Lead is told, once (project instructions, phase 1:
 *  agents talk to each other directly, so nothing else would notice two of them answering each other for ever). */
export const LOOP_NOTICE_AT = 20
const LOOP_WINDOW_MS = 30 * 60_000
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
  return !!group && !isLeads(group) && ledProject(state, actor.agentId)?.id === groupProject(state, group).id
}


/** A project's Lead (Product Manager) leaves only with its project: every other removal path refuses it. */
function protectLead(state: SuperTabState, agentId: string, actor: Actor): void {
  const project = ledProject(state, agentId), target = state.agents.find(a => a.id === agentId)
  if (project && target) {
    const reason = canReadProject(state, actor, project)
      ? `${target.displayName ?? target.name} is the ${coordinatorNameOf(project)} of project ${project.name}. Delete the project first.`
      : "A Product Manager of a project you can't see prevents this action."
    fail('LEAD_PROTECTED', reason)
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

function dropRemovedRecord(state: SuperTabState, machineId: string, harnessId: string): void {
  state.removedSessions = state.removedSessions?.filter(r => r.machineId !== machineId || r.harnessId !== harnessId)
  if (!state.removedSessions?.length) delete state.removedSessions
}

function dropClosing(state: SuperTabState, keep: (request: NonNullable<SuperTabState['closingSessions']>[number]) => boolean): void {
  state.closingSessions = state.closingSessions?.filter(keep)
  if (!state.closingSessions?.length) delete state.closingSessions
}

/** What a Member's or Regular agent's start asks of its machine: an agent's memory, and git to read the project. CPU use is one
 *  momentary sample, so it is not capped (Diego, 10-30). Checked when it is added (admitByRoom) and again by its host at launch. */
const AGENT_REQUIREMENTS: AgentStartRequest['requirements'] = { memoryBytes: AGENT_MEMORY_BYTES, diskBytes: 1024 ** 3, maxCpuPercent: 100,
  tools: ['git'], devices: [], quotaRequired: false }

/** Also checked before returning an idempotent receipt: a retry does not retain
 * access after the person has been removed from a private project. */

export function authorizeCommandAccess(state: SuperTabState, actor: Actor, command: Command, context: Partial<CommandContext> = {}) {
  if (command.type === 'invite.accept' || command.type === 'agent.sessionClosed' || command.type === 'machine.cleaned') return
  // The owner's alone, checked where they apply: everyone else, a viewer too, gets the answer a missing Swarm gets (deletion.ts).
  if (command.type === 'swarm.delete' || command.type === 'swarm.restore') return
  if (personalApprovalCommand(command.type)) {
    authorizeTaskApproval(state, actor, command.type, 'conversationId' in command ? command.conversationId : undefined)
    if ('agentId' in command) readAgent(state, actor, command.agentId)
    return
  }
  const leaving = command.type === 'member.remove' && actor.kind === 'person' && command.userId === actor.userId
  author(state, actor, !leaving)
  // An invitation's group is only where the person lands, and invite.create replaces a deleted one (inviteLanding).
  if ('conversationId' in command && command.conversationId && command.type !== 'invite.create') readConversation(state, actor, command.conversationId)
  // A project nobody owns is the Swarm owner's to delete though they read nothing of it: its delete checks that (deletableProject).
  // The Swarm owner may choose even a private project's process, but gains no access to its conversations or reads.
  const processOwner = command.type === 'project.process' && actor.kind === 'person' && actor.userId === state.ownerId
  if ('projectId' in command && command.projectId && command.type !== 'project.delete' && !processOwner) readProject(state, actor, command.projectId)
  if ('agentId' in command) readAgent(state, actor, command.agentId)
  if (command.type === 'agent.start') readConversation(state, actor, command.request.conversationId)
  if ((command.type === 'rule.set' || command.type === 'rule.remove' || command.type === 'project.skills' || command.type === 'tab.tidy'
    || command.type === 'machine.engineResume' || command.type === 'rules.set') && command.askedIn) {
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
/** Whether agent [agentId] may join [group] to post or be named there: an agent of the group's own project, never
 *  an agent that is stopping, and never into the Leads conversation or a private chat, whose members stay as
 *  they are (project instructions, phase 1: agents talk to each other directly, not through the PM). Nor into the project
 *  chat, which is the people's and is never archived, so a joined agent would stay active there for good. A linked task
 *  (reviewOf) takes any agent, whatever its role (phase 4): joining one hands it no work. */
export function joinsProject(state: SuperTabState, group: Conversation, agentId: string): boolean {
  const target = state.agents.find(a => a.id === agentId)
  if (!target || target.workDecision === 'stop' || isLeads(group) || group.audience) return false
  const project = groupProject(state, group)
  return agentProjectId(state, target) === project.id && group.id !== project.leadConversationId
}
/** Whether agent [agentId] may join [group] as its project's channel (Swarm v4, anh Dee 2026-11-08): any agent of the project,
 *  never one stopping, by posting there or being named there. Its agents talk to each other there by name, as
 *  lampOS's did in its issues; adding one by hand still keeps the chat to its coordinator (#2207). */
export function joinsChannel(state: SuperTabState, group: Conversation, agentId: string): boolean {
  const project = projectsOf(state).find(p => p.leadConversationId === group.id)
  const target = state.agents.find(a => a.id === agentId)
  return !!project && !!target && inChannelOf(state, target, project)
}
/** Whether agent [agentId] does work in [group], its project's chat: an agent of that project, not stopping,
 *  assigned a task or step of the project that is not archived and did not end lost, stopped or cancelled. A done task counts
 *  until it archives with its pull request, so its agent posts its result line (Dee, 2026-11-04, #2924: the agent doing the
 *  work answers people there itself; security reviews of #2924). */
export function worksInProjectChat(state: SuperTabState, group: Conversation, agentId: string): boolean {
  const project = projectsOf(state).find(p => p.leadConversationId === group.id)
  const target = state.agents.find(a => a.id === agentId)
  if (!project || !target || target.workDecision === 'stop' || agentProjectId(state, target) !== project.id) return false
  return state.conversations.some(c => c.assignment?.agentId === agentId && !c.archived && c.id !== group.id && !c.kind && !c.audience
    && !['lost', 'stopped', 'cancelled'].includes(c.assignment.status) && groupProject(state, c).id === project.id)
}
/** Who may post in a conversation may also upload a file to it. Writer access is checked by `author(state, actor, true)`. The
 *  open group [actor] may post in, and the agent that posting there adds to it (`joining`, else null): an agent of the group's
 *  project that is not in it joins it (joinsProject). An agent with work in the project posts in its project chat without joining
 *  it, so the chat keeps only its coordinator among agents and opens no second terminal (#2207). It changes nothing: an upload
 *  asks it of the Swarm as the read cache holds it, which nothing may change, and the command that posts adds the agent. A yes
 *  to an upload is not a yes to the post that sends it: that asks again, of the Swarm as it is then. */
export function postable(state: SuperTabState, actor: Actor, conversationId: string): { group: Conversation; joining: string | null } {
  const group = open(state, conversationId)
  requireCanChat(state, actor, group)
  if (actor.kind !== 'agent' || group.agentIds.includes(actor.agentId)) return { group, joining: null }
  if (projectAgent(state, actor, groupProject(state, group).id) && worksInProjectChat(state, group, actor.agentId)) return { group, joining: null }
  if (!joinsProject(state, group, actor.agentId) && !joinsChannel(state, group, actor.agentId)) {
    fail('FORBIDDEN', 'This agent does not participate in the conversation.', 403)
  }
  return { group, joining: actor.agentId }
}
function owner(state: SuperTabState, actor: Actor): void {
  if (actor.kind !== 'person' || actor.userId !== state.ownerId) fail('OWNER_REQUIRED', 'Only the Super Tab owner can manage invitations.', 403)
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
/** The person's own top-level message in [project]'s chat that asked for a new group; anything else reads as unknown. */
function requestOf(state: SuperTabState, project: SwarmProject, request: CommandContext['request']): { messageId: string; personId: string } {
  const author = request?.author
  const member = author?.kind === 'person' ? state.people.find(p => p.id === author.id && p.generation === author.membershipGeneration) : undefined
  if (!request || request.conversationId !== project.leadConversationId || request.replyTo || request.source || !member
    || !canReadProject(state, { kind: 'person', userId: member.id, email: member.email }, project)) {
    fail('REQUEST_UNKNOWN', 'Name a person\'s own message in this project\'s chat, or leave the request out.', 400)
  }
  return { messageId: request.id, personId: member.id }
}
/** Who may close a stored task's lost or stopped work, and its work in progress, by archiving it (conversation.archive). */
const WHO_CANCELS_ENDED = 'Only the person who asked for this task, its project\'s owner, the Swarm owner or an agent of this project can close it.'
const WHO_CANCELS_LIVE = 'Only an agent of this project or the Swarm owner can close work in progress.'


function open(state: SuperTabState, conversationId: string) {
  const group = conversation(state, conversationId)
  if (group.archived) fail('ARCHIVED', 'Reopen this conversation before changing its work.')
  return group
}

/** What a host says once it launches a Regular agent's start (cli superTabs/machines.ts CAPABILITIES, task #4116). */
export const REGULAR_AGENT_CAPABILITY = 'regularAgent'

/** Pure policy/state transition. The store commits its state, messages and delivery records in one transaction. */
/** One command, then each task's line brought up to date (taskLine.ts), whichever way the command returned. */
export function applyCommand(original: SuperTabState, actor: Actor, input: Command, context: CommandContext): CommandEffects {
  const effects = applyCommandOnce(original, actor, input, context)
  // Who moved the task, for a line its project's coordinator cannot sign; nobody when the actor is no longer a member (a command that removed them).
  let sender: Author | undefined
  try { sender = author(effects.state, actor) } catch { sender = undefined }
  syncTaskLines(original, effects, sender, stableId(original.id, actorKey(actor), context.operationId))
  // Every open group is loaded for a command (parts/load.ts): the board's pulse is worked out on it (pulse.ts), for the project
  // of the conversation the command names when it names one (it moves no other), else for every project.
  const only = pulseProjectOf(effects.state, input)
  recordPulse(effects.state, context.now, only, linesOf(original, context.now, only))
  return effects
}

/** An answer (answers.ts) to a reply inside a thread goes in that thread: a reply to it, never right below it in the main chat.
 *  Worked out before anything reads where the post goes, so it routes, settles and threads as that reply would. */
function placeAnswer(command: Command, context: CommandContext, state: SuperTabState): Command {
  if (command.type !== 'message.send') return command
  // In a project that answers people in threads (task #3747), any post naming a person's message in the main chat goes in its
  // thread, whatever the client sent: an older host's --answers, or an agent that skipped its reply line. A post naming
  // nothing stays in the main chat, and an agent's message is answered as before.
  const reply = context.reply
  if (command.answers && !command.replyTo && reply?.id === command.answers && reply.author.kind === 'person' && !inThread(reply)
    && answersInThread(state, command.conversationId)) return { ...command, replyTo: command.answers, answers: undefined }
  if (!command.answer) return command
  if (!command.answers || command.replyTo) fail('VALIDATION_ERROR', 'An answer names the message it answers, and nothing else to reply to.', 400)
  return reply && reply.id === command.answers && inThread(reply) ? { ...command, replyTo: command.answers, answers: undefined } : command
}

/** Whether [conversationId]'s project answers people in threads. Never throws: a conversation outside every project does not. */
function answersInThread(state: SuperTabState, conversationId: string): boolean {
  const group = state.conversations.find(c => c.id === conversationId)
  try { return !!group && groupProject(state, group).answersInThread === true } catch { return false }
}

/** The project `project.closeTab` may close (task #3929): a no-repo tab's, in the caller's own Personal Swarm, by that person.
 *  Desktop creates a tab's project with the request `personal-tab-…` (desktop personal_projects.dart personalProjectOperation),
 *  and `project.create` makes its id from that request and its sender (applyCommandOnce `operationId`), so [tabOperation]
 *  proves the project is that person's tab's: it must make exactly [projectId]. Anything else reads as a project not there. */
function closingTabProject(state: SuperTabState, actor: Actor, projectId: string, tabOperation: string): SwarmProject {
  const tabs = actor.kind === 'person' && actor.userId === state.ownerId && isPersonalSwarm(state)
    && stableId(state.id, actorKey(actor), tabOperation) === projectId
  const project = tabs ? projectsOf(state).find(p => p.id === projectId) : undefined
  if (!project || project.repository) fail('NOT_FOUND', 'This project is unavailable.', 404)
  return project
}

function applyCommandOnce(original: SuperTabState, actor: Actor, input: Command, context: CommandContext): CommandEffects {
  // A credential someone pasted, or an agent echoed from its terminal, is gone before anything is stored or delivered
  // (Oct 2026: a Harness access token in a shared Lead chat). The sender's result says what went.
  const removed: CredentialKind[] = []
  const command = placeAnswer(withoutCredentials(commandSchema.parse(input), removed), context, original)
  const state = cloneData(original)
  numberConversations(state)
  placeRules(state)
  expireRemovals(state, context.now)
  const deleted = new Set(context.deletedMachineIds ?? [])
  if (deleted.size && state.machineCleanups) {
    state.machineCleanups = state.machineCleanups.filter(c => !deleted.has(c.machineId))
    if (!state.machineCleanups.length) delete state.machineCleanups
  }
  assignAgentDisplayNames(state.agents)
  const result: Record<string, unknown> = {}
  const effects: CommandEffects = { state, messages: [], cancelledAgents: [], routeDecisions: [], result }
  /** Agents this command took out of the Swarm with a row of its own in each of their chats (agent.remove, removeMachine). */
  const announcedRemovals = new Set<string>()
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
      // A project from before ownerGeneration whose owner left is settled before they come back, never matched to them again.
      const person: Person = { id: actor.userId, email: invite.email, role: invite.role, generation: invite.id }
      nameFromAccount(person, context.accountName)
      admitPerson(state, person)
    }
    state.invitations = state.invitations.filter(i => i.id !== invite.id)
    // Back on purpose: auto-join may add them again if they leave and the owner invites them once more (spec, Leaving is final).
    if (state.autoJoinDeclined?.includes(actor.userId)) state.autoJoinDeclined = declinedWithout(state, actor.userId)
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
      && actor.kind === 'person' && c.machineOwnerId === actor.userId) ?? (state.deletion ? notThere() : fail('NOT_FOUND', 'This machine has no session waiting to close.', 404))
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
    // Of a deleted Swarm, only a host with a cleanup waiting learns it exists (deletion.ts).
    if (!pool && !cleanup) state.deletion ? notThere() : fail('NOT_FOUND', 'This machine has no cleanup waiting.', 404)
    state.machines = state.machines?.filter(m => m !== pool)
    state.machineCleanups = state.machineCleanups?.filter(c => c !== cleanup)
    if (!state.machineCleanups?.length) delete state.machineCleanups
    return effects
  }

  // Before any role check: a viewer or an agent is told what anyone without the Swarm is told (deletion.ts).
  if (command.type === 'swarm.delete' && (actor.kind !== 'person' || actor.userId !== state.ownerId)) notThere()
  const leaving = command.type === 'member.remove' && actor.kind === 'person' && command.userId === actor.userId
  const sender = author(state, actor, !leaving && !personalApprovalCommand(command.type))
  authorizeCommandAccess(state, actor, command, context)
  /** A machine's owner said so: they sent the command, or the Lead of the chat [askedIn] names passes on a message they wrote
   *  there in the last day, as routing rules are (machine.engineResume). */
  const machineOwnerWord = (pool: ContributedMachine, askedIn: { conversationId: string } | undefined) => {
    if (actor.kind === 'person') return actor.userId === pool.contributorId
    const asked = askedIn && context.askedIn
    return !!asked && asked.author.kind === 'person' && asked.author.id === pool.contributorId && !asked.source
      && context.now - asked.createdAt <= RULE_MESSAGE_MS && state.conversations.find(c => c.id === askedIn.conversationId)?.leadId === actor.agentId
  }
  const message = (conversationId: string, body: string, recipients: string[] = [], replyTo: string | null = null, source?: Record<string, unknown>,
    attachments?: Attachment[], mentions?: string[], id = operationId) => {
    effects.messages.push({ id, conversationId, author: sender, text: body, replyTo, recipients, ...(source ? { source } : {}),
      ...(attachments?.length ? { attachments } : {}), ...(mentions?.length ? { mentions } : {}) })
    result.messageId = operationId
  }
  /** A crew need for the PM (crewNeeds.ts): its own row, to the PM alone, and the agent's result says where it went. Its
   *  messageId is where the agent asked; an ask or a line with no message of its own points at this row. */
  const crewNeed = (group: Conversation, pm: string, need: Omit<CrewNeed, 'agentId' | 'messageId'> & { messageId?: string }, words: string,
    id = stableId(operationId, 'crew-need')) => {
    const full: CrewNeed = { agentId: actor.kind === 'agent' ? actor.agentId : '', ...need, messageId: need.messageId ?? id }
    effects.messages.push({ id, conversationId: crewNeedPlace(state, group, pm), author: sender, replyTo: null, recipients: [pm],
      text: crewNeedText(state, need.personIds, words, need.options, need.recommended), source: { kind: CREW_NEED_KIND, crewNeed: full } })
    effects.result.routedToPm = routedLine(state, need.personIds)
  }
  /** A route, start or assignment on a task by any agent of its project, or a post there by its coordinator, with its time:
   *  it restarts an unstarted start's clock (liveness.ts). It rides on the write each makes anyway. */
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
  const teamJoin = (project: SwarmProject, agentId: string, group?: Conversation) => {
    const member = agent(state, agentId)
    requireTeamWork(state, member.machineId, member.contributorId, project)
    // A named agent or a poster joins a task as an assignment would: Team-written code stays in a Team account (audit H2).
    // Joining a chat is not writing its code, so it marks nothing: a Team agent's push shows in GitHub's record (#3304).
    if (group) requireTeamWrittenAccount(state, group, member)
  }
  /** Runs [mark], and tells every main-account member when it just marked [group]'s task: nothing else reaches a session
   *  that already has the branch, or a member the workflow would ask again (teamWritten.ts, audit H2). */
  const marking = (group: Conversation, mark: () => void) => {
    const was = teamWrittenTask(state, group)
    mark()
    if (was || !teamWrittenTask(state, group)) return
    for (const told of mainAccountMembers(state, group, actor.kind === 'agent' ? actor.agentId : undefined)) {
      effects.messages.push({ id: stableId(operationId, 'team-written-stop', told.conversationId), conversationId: told.conversationId, author: sender,
        text: TEAM_WRITTEN_STOP, replyTo: null, recipients: told.agentIds, source: SYSTEM_ROW })
    }
  }
  /** What GitHub's read says for an agent about to take [group]'s work (store.ts pushOriginFor): a bot's push marks the task and
   *  refuses the main account, and the store keeps that mark after this command is refused. Unknown refuses it unmarked. */
  const pushedRefusal = (group: Conversation, worker: Agent) => {
    marking(group, () => applyPushOrigin(state, group, context.pushOrigin, context.pushOriginPulls, context.pushOriginTask))
    // The project owner's own agent may take it too (teamWritten.ts, task #4120, the PM's ruling).
    if (ledProject(state, worker.id)?.id === groupProject(state, group).id || ownersOwnAgent(state, group, worker)) return
    if (context.pushOrigin === 'unknown') failPushUnknown()
    if (context.pushOrigin === 'team') failTeamWritten({ pushed: true })
  }
  /** A session already in the Swarm that a person's agent.add names joins [group] as conversation.agent adds one (security
   *  review S2): it is of the group's project; a stopping one joins nowhere; a teammate's agent joins only where it may take
   *  the project's work. (A private conversation is closed to all: projects.ts isClosedPmChat.) */
  const joinable = (group: Conversation, member: Agent) => {
    sameProject(state, group, member)
    if (member.workDecision === 'stop') fail('STOP_REQUESTED', 'This agent is stopping. Wait for its execution host.')
    requireTeamWork(state, member.machineId, member.contributorId, groupProject(state, group))
    requireTeamWrittenAccount(state, group, member)
  }
  /** The project chat is the people's and is never archived: its work, name and records are its coordinator's or a person's,
   *  as its members are (conversation.agent, joinsProject; security review L2). A task's are any agent's of its project. */
  const projectChatWork = (conversationId: string) => {
    if (projectsOf(state).some(p => p.leadConversationId === conversationId)) coordinatorOrPerson(state, actor, conversationId)
  }
  /** The project chat holds only its coordinator among agents (Ken, #2207): a Reviewer added next to the PM opened a second
   *  terminal there and posted announcements in the people's chat. Refused whoever adds one and by whichever command; an
   *  agent stored there before stays until it is removed, and a new coordinator is still set (lead). [agentId] is null for an
   *  agent not started yet. */
  const projectChatJoin = (group: Conversation, agentId: string | null, name: string) => {
    if (!projectsOf(state).some(p => p.leadConversationId === group.id)) return
    if (agentId && (agentId === group.leadId || group.agentIds.includes(agentId))) return
    fail('PROJECT_CHAT_COORDINATOR_ONLY',
      `The project chat holds only its coordinator among agents, so ${name} cannot join it. Its work and announcements go in its task.`, 403)
  }
  /** An agent starts or assigns only what the route chose; a person may still do either by hand. */
  /** A private conversation is chat only (design section 4.8). */
  /** The project whose Board settings [actor] sets: its owner's or the Swarm owner's (boardRights.ts, task #3819). */
  const boardOwned = (projectId: string): SwarmProject => {
    const project = readProject(state, actor, projectId)
    author(state, actor, true)
    if (actor.kind !== 'person' || !ownsBoard(state, project, actor.userId)) {
      fail('PROJECT_OWNER_REQUIRED', 'Only the project owner or the Swarm owner changes how this project works.', 403)
    }
    mutableProjects(state)
    return projectOf(state, projectId)
  }
  /** Refuses new work on a task paused by someone who steers its project (boardRights.ts, task #3819): a hand assignment and a
   *  start into it, as dispatch already skips it (Readycheck's review). */
  const pausedTask = (group: Conversation) => {
    if (group.paused) fail('TASK_PAUSED', 'This task is paused. Its project owner or decider resumes it first.', 409)
  }
  const personUnknown = (): never => fail('PERSON_UNKNOWN', 'Name a person who reads this project.', 400)
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
  /** A task ended: its open steps from before Swarm v4 are cancelled and their agents told why, in each step (task steps design);
   *  with [archive], its finished steps archive with it. */
  const endStepsOf = (task: Conversation, reason: string, archive: boolean) => {
    // A row of its own in each step, as the command's own row may be in the task: one id per row.
    effects.messages.push(...stepEndedRows(state, endSteps(state, task, reason, archive), reason, sender, step => stableId(operationId, 'step-ended', step.id)))
  }
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
  /** Accepted, kept nowhere: an older client's save of what each project's instructions say now (IGNORED_NOTE). */
  const ignored = () => Object.assign(result, { ignored: true, note: IGNORED_NOTE })
  /** A new revision of [project]'s instructions from revision [current]: what instructions.save and an older client's rule.set
   *  write. It is kept in the revision history, who wrote it and for whom, and the lines it dropped (#3151), and posts nothing in
   *  any chat (Dee and Ken, 2026-11-05, #3132): a change is read and undone in the Instructions history. */
  const saveInstructions = (project: SwarmProject, current: number, text: string, summary: string, askedBy: string, dropped: DroppedLine[] = []) => {
    const hash = instructionsHash(text)
    mutableProjects(state)
    Object.assign(projectOf(state, project.id), { instructionsRevision: current + 1, instructionsHash: hash })
    effects.instructions = { projectId: project.id, revision: current + 1, hash, text, summary,
      writtenBy: { kind: sender.kind, id: sender.id }, askedBy, at: context.now, ...dropped.length ? { dropped } : {} }
    Object.assign(result, { projectId: project.id, revision: current + 1, hash })
  }
  /** No private channel to the PM. A closed one is nobody's to read or post in
   *  (projects.ts isClosedPmChat); an app from before still sends this to open one. */
  const pmChatClosed = (): never =>
    fail('PM_CHAT_CLOSED', actor.kind === 'agent'
      ? 'Chat with PM is closed: tell a person in the project chat, tagging them.'
      : 'Chat with PM is closed: talk to the PM in the project chat.', 403)
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
   *  instructions, phase 4: the route is advice); it is still recorded as an override. A route that picked (task #3576) asks for the
   *  reason when the start or assignment leaves its pick.
   *  A route that names no pick (task #2901, Ken 2026-11-04) leaves the choice to the coordinator, by the project's Routing
   *  instructions: until a person or an earlier start chose, the start or assignment gives the rule that chose it, and the
   *  candidate it matches, any of them, is recorded and said in the route row the released apps draw. */
  const linkDecision = (conversationId: string, matches: (c: KeptCandidate, d: RouteDecision) => boolean,
    finalOf: (d: RouteDecision) => RouteFinal, reasonText: string | undefined, assignmentId?: string) => {
    const decision = openDecision()
    if (decision.conversationId !== conversationId) fail('ROUTE_MISMATCH', 'This routing decision belongs to another group.')
    // A second start or assignment must not overwrite the final while the first attempt is still running.
    if (decision.assignmentId && state.conversations.some(c => c.assignment?.id === decision.assignmentId && activeWork(c))) {
      fail('ROUTE_LINKED', 'This routing decision already has running work. Stop it before handing the task over.')
    }
    const final = (patch: Pick<RouteFinal, 'candidateId'>, override?: RouteOverride) => effects.routeDecisions.push({ op: 'final', id: decision.id,
      final: { ...finalOf(decision), ...patch }, ...(override ? { override } : {}), ...(assignmentId ? { assignmentId } : {}) })
    const chosenId = decision.override?.candidateId ?? decision.final?.candidateId ?? decision.record.pick
    if (chosenId === undefined) {
      const chosen = decision.record.candidates.find(c => matches(c, decision))
      // The only candidate that can run needs no rule to choose it; a start of anything else still says why (review of #3010).
      const only = decision.record.via === 'only' && chosen ? ONLY_CANDIDATE : undefined
      const reason = reasonText ?? only ?? fail('ROUTE_REASON_REQUIRED',
        'This route names no pick: send, as overrideReason, the project\'s Routing rule that chose this candidate.')
      const override: RouteOverride | undefined = chosen ? undefined : { by: 'lead', actorKey: actorKey(actor), reason }
      final(chosen ? { candidateId: chosen.id } : {}, override)
      const instead = (done: string) => `${who} ${done}, which is none of the route's candidates. Reason: ${reason}`
      const routed = chosen && { text: `Routed to ${chosen.title} — ${only && !reasonText ? 'only candidate' : 'by the project\'s Routing instructions'} · "${reason}"`, source: { kind: 'route',
        decisionId: decision.id, via: only && !reasonText ? 'only' : 'instructions', p: null, belowFloor: false, why: reason, pick: { id: chosen.id, title: chosen.title },
        alternatives: decision.record.candidates.filter(c => c.id !== chosen.id).map(c => ({ id: c.id, title: c.title })) } }
      return { decision, override, instead, routed }
    }
    const expected = decision.record.candidates.find(c => c.id === chosenId)!
    const matched = matches(expected, decision)
    // The route picked by the Routing order (task #3576): another candidate is chosen for a reason (urgency, context, a machine the work needs).
    if (!matched && !reasonText && chosenId === decision.record.pick) {
      fail('ROUTE_REASON_REQUIRED', `This route picked ${expected.title}. Start or assign it, or send, as overrideReason, why another candidate is better (urgency, context, a machine the work needs; "idle" is not a reason).`)
    }
    const override: RouteOverride | undefined = matched ? undefined : { by: 'lead', actorKey: actorKey(actor), reason: reasonText ?? NO_REASON }
    // A record with a pick keeps it as the choice; one without keeps the candidate chosen in the final, for the route history.
    final(matched && decision.record.pick === undefined ? { candidateId: chosenId } : {}, override)
    // The chat line: who chose what instead of the route's pick, and why when they said.
    const instead = (done: string) => `${who} ${done} instead of ${expected.title}.${reasonText ? ` Reason: ${reasonText}` : ''}`
    return { decision, override, instead, routed: undefined }
  }
  /** Why a route candidate cannot take a teammate's work in [conversationId], or null (machines.ts teamWorkCheck). A
   *  member runs under its own contributor's grant; a new agent under the contribution's, or off the Machines list under
   *  the grant of whoever will start it ([starter]). */
  const candidateRefusal = (candidate: KeptCandidate, conversationId: string, starter: string) => {
    const project = groupProject(state, conversation(state, conversationId))
    const member = candidate.kind === 'member' ? state.agents.find(a => a.id === candidate.agentId) : undefined
    if (candidate.kind === 'member' && !member) return null
    const group = conversation(state, conversationId), written = teamWrittenTask(state, group)
    const machineId = member?.machineId ?? candidate.machineId
    const pool = state.machines?.find(m => m.machineId === machineId)
    // A new agent starts only on its starter's own computer, as them (task #4120, the PM's ruling).
    if (!member && pool && pool.contributorId !== starter) return { code: 'NOT_YOUR_COMPUTER' as const, reason: NOT_YOUR_COMPUTER }
    // Code a Team agent wrote: only the project owner's own agent, on their own computer (teamWritten.ts, the PM's ruling; audit H2).
    if (written && (member ? barredFromTeamWritten(state, group, member) : !ownersOwnMachine(state, group, machineId))) {
      return { code: 'TEAM_WRITTEN_WORK' as const, reason: TEAM_WRITTEN_REASON }
    }
    const contributor = member?.contributorId ?? pool?.contributorId ?? starter
    return teamWorkCheck(state, machineId, contributor, project)
  }
  /** [project]'s Lead [agentId] joined its chat: it hears what its person sent there while it had none (leadStart.ts). */
  const arrived = (project: SwarmProject, agentId: string) => {
    if (!project.leadWaiting && !project.leadClaim) return
    const late = leadArrived(state, project, agentId, context.now)
    if (late.length) effects.lateDeliveries = [...effects.lateDeliveries ?? [], ...late]
  }
  /** Deleting its project is the only removal that takes a Lead. `close: false` when its host already closed the session. */
  /** [project] deleted with its own agents, its Lead included (their hosts close their sessions), its starts and machines' lists. */
  const deleteWholeProject = (project: SwarmProject) => {
    // Read before its agents go: a contributed start still settling whose agent is already gone never settles (projects.ts).
    const orphaned = new Set((state.starts ?? []).filter(s => s.poolGeneration && s.harnessId && !s.poolSettled && !s.error
      && !state.agents.some(a => a.machineId === s.request.machineId && a.harnessId === s.harnessId)).map(s => s.id))
    for (const target of state.agents.filter(a => agentProjectId(state, a) === project.id)) removeAgent(target, { lead: true })
    for (const start of state.starts ?? []) if (start.request.mainProjectId === project.id) delete start.request.mainProjectId
    // Members elsewhere whose main project it was have none now (spec: they ask their person again, build task 9).
    for (const target of state.agents) if (target.mainProjectId === project.id) delete target.mainProjectId
    deleteProject(state, actor, project.id, orphaned, context.now)
  }
  const removeAgent = (target: Agent, { lead = false, close = true } = {}) => {
    // A person's removal stands: a record of this session must not bring it back when it reopens (closedAgents.ts).
    dropRemovedRecord(state, target.machineId, target.harnessId)
    if (!lead) protectLead(state, target.id, actor)
    if (close) recordClosing(state, target)
    state.agents = state.agents.filter(a => a.id !== target.id)
    effects.cancelledAgents.push(target.id)
    for (const group of state.conversations) {
      group.agentIds = group.agentIds.filter(a => a !== target.id)
      if (group.leadId === target.id) group.leadId = null
      if (group.assignment?.agentId === target.id && activeWork(group)) group.assignment.status = 'reconciling'
    }
  }

  /** A new project of [ownerId]'s named [name], with its Lead chat: project.create's, and + New agent's for a PM (task #4116). */
  const createProject = (ownerId: string, name: string, visibility: 'public' | 'private', brief: string, process: ProjectProcess): SwarmProject => {
    const projects = mutableProjects(state)
    if (projects.length >= 100) fail('PROJECTS_FULL', 'A swarm can have up to 100 projects.')
    const leadConversationId = `project-${operationId}`
    // It starts on a copy of the built-in instructions as revision 1, the team's own to change (design, The built-in template).
    // In a Swarm whose projects moved onto the base (#3600), on the base, marked: one way to start a project (review of #3300).
    const onBase = projects.some(p => (p.instructionsBase ?? 0) >= BASE_VERSION)
    const first = onBase ? { instructionsRevision: 1, instructionsHash: instructionsHash(BASE_DOCUMENT), instructionsBase: BASE_VERSION } : FIRST_INSTRUCTIONS
    const project: SwarmProject = { id: operationId, name, ownerId, ownerGeneration: person(state, ownerId).generation, leadConversationId,
      visibility, members: [], updateMinutes: 5, skillMode: 'default', process, ...first }
    projects.push(project)
    effects.instructions = { projectId: operationId, revision: 1, hash: first.instructionsHash, text: onBase ? BASE_DOCUMENT : INSTRUCTIONS_TEMPLATE,
      summary: FIRST_SUMMARY, writtenBy: { kind: 'person', id: ownerId }, askedBy: ownerId, at: context.now }
    state.conversations.push({ id: leadConversationId, projectId: operationId, title: 'Lead', leadId: null,
      agentIds: [], archived: false, brief, checks: [], assignment: null, lastMessageSequence: 0 })
    return project
  }

  /** A Regular agent's chat with its person, which nobody else reads (projects.ts readsAgentChat), for this command's agent. */
  const openAgentChat = (me: { id: string; generation: string }, title: string): string => {
    const chatId = stableId('agent-chat', me.id, me.generation, operationId)
    state.conversations.push({ id: chatId, kind: 'agent-chat', title, leadId: null, agentIds: [], archived: false, brief: '', checks: [],
      assignment: null, lastMessageSequence: 0, audience: { people: [{ id: me.id, generation: me.generation }] },
      // Its activity starts with the command that opens it, on the store's clock, as a message's would.
      lastActivityAt: new Date(context.now).toISOString() })
    return chatId
  }
  /** The first Accept of [personId] in [group]'s project starts their Member there (members.ts, task #4697): on their own
   *  computer and account, named "<name> · <project>", in a chat of its own with them. With no such computer, or too many
   *  starts at once, the task's chat says so: nothing is refused, since the Accept stands, and nothing starts it later (the
   *  crew dispatch went with Swarm v4, 2026-11-10). */
  const startMember = (group: Conversation, personId: string) => {
    const project = groupProject(state, group)
    if (memberOf(state, personId, project.id)) return
    const owner = person(state, personId)
    const pool = memberMachine(state, personId, REGULAR_AGENT_CAPABILITY)
    const who = owner.name ?? owner.email.split('@')[0]
    const none = () => message(group.id, `${who} has no computer in this Swarm to run their agent for ${project.name}.`, [], null, SYSTEM_ROW, undefined, undefined, stableId(operationId, 'member-line'))
    if (!pool) return none()
    const name = `${newAgentName(state, actor, undefined, stableId(operationId, 'member'))} · ${project.name}`
    if ((state.starts ?? []).filter(s => !s.harnessId && !s.error).length >= 32) {
      return message(group.id, `Too many agents are starting in this Swarm to start ${who}'s agent for ${project.name} now.`,
        [], null, SYSTEM_ROW, undefined, undefined, stableId(operationId, 'member-line'))
    }
    const chatId = openAgentChat(owner, name)
    const request: AgentStartRequest = { conversationId: chatId, machineId: pool.machineId, engine: pool.engines[0]!, name,
      // Its project's folder with a worktree, as any project agent's (machines.ts admitMachineStart reads `member`): its host
      // copies a helper from it, and reopens it in place after a sleep (#4698).
      cwd: projectFolder(pool, project), worktree: true, requirements: AGENT_REQUIREMENTS,
      regular: true, mainProjectId: project.id, member: { projectId: project.id } }
    let admitted: ReturnType<typeof admitMachineStart>
    try { admitted = admitMachineStart(state, request, context.now) } catch (error) {
      if (!(error instanceof SuperTabError)) throw error
      // Refused: its chat goes with it, so nothing is left behind for a start that never was.
      state.conversations = state.conversations.filter(c => c.id !== chatId)
      return message(group.id, `Could not start ${who}'s agent for ${project.name}: ${error.message}`, [], null, SYSTEM_ROW, undefined, undefined,
        stableId(operationId, 'member-line'))
    }
    state.starts ??= []
    const id = stableId(operationId, 'member')
    state.starts.push({ poolGeneration: admitted!.generation, id, creationId: `super-${id}`, actorKey: actorKey(actor), contributorId: owner.id,
      membershipGeneration: owner.generation, machineOwnerId: owner.id, hostGrant: null, request, harnessId: null, dispatched: false, error: null,
      requestedAt: context.now })
  }
  /** Takes a machine out of the Swarm with every agent on it (machine.remove, or its owner leaving): each agent is removed
   *  like one agent, its pending starts fail, routing rules lose it, and a contributed machine stays paused and cleaning
   *  until its host deletes the Swarm's folders there — or leaves at once when that host is offline
   *  (spec 2026-10-23-remove-machine.md). */
  /** [keepFolders]: the machine's folders stay with the computer (machine.moved), so it leaves the list at once with no cleanup. */
  const removeMachine = (machineId: string, pool: ContributedMachine | undefined, members: Agent[], how: (machine: string) => string, lead = false,
    keepFolders = false) => {
    // Its row in each group names them, so no member row repeats it.
    for (const member of members) announcedRemovals.add(member.id)
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
        .map(a => quotedName(a.displayName ?? a.name)), task: !!group.assignment && removed.has(group.assignment.agentId) && activeWork(group) }))
    for (const target of members) removeAgent(target, { lead })
    if (pool) {
      // Paused, so routing in clients that do not know removals stops offering it too.
      pool.removal = { id: operationId, state: 'cleaning', requestedAt: new Date(context.now).toISOString() }
      pool.paused = true
    }
    // Its capacity left with it: no slot there is held for anyone now.
    state.harnessReservations = state.harnessReservations?.filter(r => r.machineId !== machineId)
    state.releasedHarnesses = state.releasedHarnesses?.filter(r => r.machineId !== machineId)
    state.removedSessions = state.removedSessions?.filter(r => r.machineId !== machineId)
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
    if (pool && keepFolders) state.machines = state.machines!.filter(m => m !== pool)
    else if (pool?.removal && machineOffline(pool, context.now)) expireRemoval(state, pool)
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


  /** Whether [worker] may ever take [group]'s work, for a suggestion its person approves (task.suggest, task.approve), throwing
   *  its refusal; nothing changes here. Whether it is free now (launching, moving, busy) is not asked, so a person's consent is
   *  not refused for it (task #4252). */
  const assignRefusal = (group: Conversation, worker: Agent) => {
    if (state.paused) fail('PAUSED', 'New work is paused in this Super Tab.')
    pausedTask(group)
    if (activeWork(group)) fail('WORK_ACTIVE', 'The current assignment must finish or be reconciled before reassignment.')
    // Before anything changes: a task given to a closed session is lost at once, and its agent then stays listed until the
    // task is handed on (closedAgents.ts removeClosedAgents). Without a task it leaves on its machine's next report.
    // An asleep crew member's session is not closed: it reopens in place (crewKeep.ts).
    // The project's machine rules (machineRules.ts).
    refuseByMachineRules(context, { machineId: worker.machineId, engine: worker.configuration.engine, review: isReview(group) })
    if (!worker.asleep && sessionClosed(state, worker, context.now)) {
      fail('AGENT_CLOSED', `${worker.displayName ?? worker.name}'s session was closed. Start a new agent for this task.`)
    }
    projectChatJoin(group, worker.id, worker.displayName ?? worker.name)
    sameProject(state, group, worker, true)
    const home = groupProject(state, group)
    // A teammate's agent on a personal machine keeps what it has; it takes no new task for another person's project.
    requireTeamWork(state, worker.machineId, worker.contributorId, home)
    // Team-written code: only the project owner's own agent (teamWritten.ts, task #4120; audit H2).
    pushedRefusal(group, worker)
    requireTeamWrittenAccount(state, group, worker)
    if (worker.workDecision === 'stop') fail('STOP_REQUESTED', 'This worker is stopping. Wait for its execution host.')
  }
  /** Changing or clearing the Lead of a project's Lead conversation would let it be stopped next. */
  const keepLead = (group: Conversation, next: string | null) => {
    if (group.leadId && group.leadId !== next && group.id === groupProject(state, group).leadConversationId) protectLead(state, group.leadId, actor)
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
        effects.messages.push(...loseTasks(state, context.now, worker => worker.id === command.agentId))
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
        projectOf(state, project.id).status = { text: command.text, at: new Date(context.now).toISOString(), by: (actor as Extract<Actor, { kind: 'agent' }>).agentId, own: true }
      }
      break
    }
    case 'project.repository': {
      // Desktop once dropped the daemon's scheme-less remote, so some leads recorded a folder without an address and
      // other machines could not clone it. Its owner or lead fills it in; an address already shared is never replaced.
      const project = readProject(state, actor, command.projectId)
      author(state, actor, true)
      const group = conversation(state, project.leadConversationId)
      if (!(actor.kind === 'person' && ownsProject(state, actor.userId, project)) && !(actor.kind === 'agent' && group.leadId === actor.agentId)) {
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
      const project = createProject(actor.userId, command.name, command.visibility, command.brief, command.process ?? 'full')
      result.projectId = project.id
      result.conversationId = project.leadConversationId
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
      const asked = leadEffort(withRoleDefaults(request, BUILT_IN_ROLE_DEFAULTS.lead), name)
      const start = placeLead(state, project, person(state, actor.userId), machineId, asked, operationId, context)
      // A branch a Team agent pushed, or GitHub cannot place, never starts a PM (audit H2).
      if (context.pushOrigin && context.pushOrigin !== 'clean') failTeamWritten()
      Object.assign(result, { startId: start.id, machineId: start.request.machineId })
      break
    }
    case 'lead.claim': {
      // Only a Personal Swarm: its person's Desktop starts the Lead on their own machine, where their project's folder is. A
      // Team Swarm's project gets its coordinator from a person who chooses it (task #2633).
      if (actor.kind !== 'person') fail('HUMAN_REQUIRED', 'A person starts a project\'s coordinator.', 403)
      if (!isPersonalSwarm(state)) fail('PERSONAL_SWARM_ONLY', 'Only a Personal Swarm starts a project\'s coordinator on its first message.', 409)
      if (state.paused) fail('PAUSED', 'New work is paused in this Swarm.')
      const project = manageProject(state, actor, command.projectId)
      const home = conversation(state, project.leadConversationId)
      if (home.leadId && home.agentIds.includes(home.leadId)) fail('LEAD_EXISTS', `This project already has its ${coordinatorNameOf(project)}.`)
      // One start at a time: another machine's recent claim, or a start the Swarm runs, is the one. The same machine claims
      // again only once its own start ended, which its Desktop knows.
      const held = project.leadClaim
      if (leadStarting(state, project.id) || (held && held.machineId !== command.machineId && context.now - held.at < LEAD_CLAIM_MS)) {
        result.leadStart = 'waiting'
        break
      }
      project.leadClaim = { id: operationId, machineId: command.machineId, at: context.now }
      result.leadStart = 'start'
      break
    }
    case 'lead.switch': {
      if (actor.kind !== 'person') fail('HUMAN_REQUIRED', 'A person moves a project\'s coordinator.', 403)
      const project = projectOf(state, command.projectId)
      const home = conversation(state, project.leadConversationId)
      const pm = state.agents.find(a => a.id === home.leadId && home.agentIds.includes(a.id))
      const pool = state.machines?.find(m => m.machineId === pm?.machineId)
      // On its machine: the project's owner, or the owner of the machine the PM runs on (not whoever contributed it: a lent
      // machine's borrower). To another machine: only the project's owner, as a new PM start (security reviews of #2705).
      const moving = command.machineId !== undefined && command.machineId !== pm?.machineId
      if (!moving && pm?.machineOwnerId === actor.userId && !ownsProject(state, actor.userId, project)) author(state, actor, true)
      else manageProject(state, actor, project.id)
      const name = coordinatorNameOf(project)
      if (!pm || !pool) fail('NO_LEAD', `This project has no running ${name}.`)
      if (machineOffline(pool, context.now)) fail('MACHINE_OFFLINE', `Wait for a fresh reading from ${pool.name}.`)
      if (!pool.observation!.capabilities?.includes(SWITCH_CAPABILITY)) fail('HOST_OUTDATED', `Update Harness on ${pool.name} to move the ${name}.`, 409)
      if (pm.switchRequest) fail('LEAD_SWITCHING', `The ${name} is already being moved.`, 409)
      // At high effort or above (leadStart.ts leadEffort), before anything is placed. Its person named no model (Switch
      // PM's "Default"): the coordinator's built-in default on its engine, as lead.start gives, never the engine's own
      // last-used model (task #3395, anh Dee 11-05: a PM came back on Sonnet medium).
      const { type: _type, projectId: _projectId, ...asked } = leadEffort(withRoleDefaults(command, BUILT_IN_ROLE_DEFAULTS.lead), name)
      let destination = pool
      if (command.machineId && command.machineId !== pool.machineId) {
        const previousPlacement = project.lead
        const start = placeLead(state, project, person(state, actor.userId), command.machineId,
          { engine: asked.engine, ...(asked.model ? { model: asked.model } : {}), ...(asked.effort ? { effort: asked.effort } : {}) },
          stableId(operationId, 'switch-start'), context)
        if (previousPlacement) project.lead = previousPlacement
        else delete project.lead
        destination = state.machines!.find(m => m.machineId === start.request.machineId)!
        // A refused command keeps none of its writes, the start above included.
        if (!destination.observation?.capabilities?.includes(SWITCH_CAPABILITY)) fail('HOST_OUTDATED', `Update Harness on ${destination.name} to move the ${name}.`, 409)
        start.request.leadFor!.switchId = operationId
      }
      if (!contributedEngines(destination).includes(command.engine)) fail('ENGINE_NOT_OFFERED', `${ENGINE_NAMES[command.engine]} isn’t offered on ${destination.name}.`, 403)
      // A PM runs on its machine's default account alone (pmAccount.ts): nobody can see or take back an account they offered once
      // Desktop dropped its accounts page, so a CLI of the last 30 days that still reports one is not believed. The default account
      // has one id per destination machine (a literal 'default' is the same account).
      const profileId = defaultProfileId(destination.machineId, command.engine)
      if (command.profileId !== 'default' && command.profileId !== profileId) defaultAccountOnly(name, destination.name)
      if (destination.machineId !== pool.machineId) {
        const start = state.starts!.find(candidate => candidate.request.leadFor?.switchId === operationId)!
        start.request.profileId = profileId
      }
      pm.switchRequest = { id: operationId, ...asked, profileId, ...(destination.machineId !== pool.machineId ? { targetMachineId: destination.machineId } : {}),
        requestedBy: actor.userId, at: new Date(context.now).toISOString() }
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
    case 'project.process': {
      const project = projectOf(state, command.projectId)
      if (actor.kind !== 'person' || (actor.userId !== state.ownerId && !ownsProject(state, actor.userId, project))) {
        fail('PROJECT_OWNER_REQUIRED', 'Only the project owner or Swarm owner can change its process.', 403)
      }
      mutableProjects(state)
      const target = projectOf(state, command.projectId)
      if (processOf(target) === 'simple' && command.process === 'full') target.simpleThrough = nextConversationNumber(state) - 1
      target.process = command.process
      break
    }
    case 'project.rename': {
      const project = manageProject(state, actor, command.projectId)
      project.name = command.name
      break
    }
    case 'project.delete': {
      // Its owner confirmed a permanent delete, so the project takes its own agents with it, its Lead included, and their
      // hosts close their sessions. The Swarm's owner deletes one nobody owns (task #3073).
      deleteWholeProject(deletableProject(state, actor, command.projectId))
      break
    }
    case 'project.closeTab': {
      // The Personal Swarm's owner closes a tab's project (task #3929): deleted only if none of its conversations, dormant ones
      // loaded with it, has a message now. A message written meanwhile changes one of those parts, so this write conflicts and
      // runs again on it, and archives instead.
      const project = closingTabProject(state, actor, command.projectId, command.tabOperation)
      const groups = state.conversations.filter(c => c.projectId === project.id || c.id === project.leadConversationId)
      // What the person wrote without a message is theirs too (security review 2, review of #3929): instructions saved past the
      // built-in first revision, a note told to its PM, or any rules record. A save meanwhile changes the project's part, or is
      // read in this write (store.ts). Rules that could not be read (undefined) count as written: nothing is deleted unchecked.
      const written = (project.instructionsRevision ?? 0) > 1 || (project.notesRevision ?? 0) > 0 || context.projectRules !== null
      if (!written && groups.every(c => !c.lastMessageSequence)) {
        deleteWholeProject(project)
        result.outcome = 'deleted'
        break
      }
      // Kept, read-only (an archived conversation is written no more: store.ts) and out of the sidebar; its agents leave.
      for (const target of state.agents.filter(a => agentProjectId(state, a) === project.id)) removeAgent(target, { lead: true })
      mutableProjects(state)
      projectOf(state, project.id).archived = true
      for (const group of groups) group.archived = true
      result.outcome = 'archived'
      break
    }
    case 'project.sharing': {
      const project = manageProject(state, actor, command.projectId)
      project.members = projectMembers(state, command.memberIds)
      project.visibility = command.visibility
      // Made private: a Regular agent already in its conversations holds what it heard there, so it is this project's from now
      // on, as one assigned here would be (assignTo; security review 2 of #4116).
      if (project.visibility === 'private') {
        for (const target of state.agents.filter(a => a.regular && !a.privateProjectId)) {
          if (state.conversations.some(c => c.agentIds.includes(target.id) && !isAgentChat(c) && groupProject(state, c).id === project.id)) target.privateProjectId = project.id
        }
      }
      break
    }
    case 'project.boardMode': {
      const project = boardOwned(command.projectId)
      if (command.on) project.boardMode = true
      else delete project.boardMode
      break
    }
    case 'project.canChat': {
      const project = boardOwned(command.projectId)
      if (command.granted && !readsProject(state, project, command.personId)) personUnknown()
      // An id whose person left matches nothing (boardRights.ts) and drops out here.
      const kept = (project.canChat ?? []).filter(personId => personId !== command.personId && readsProject(state, project, personId))
      const next = command.granted ? [...kept, command.personId] : kept
      if (next.length) project.canChat = next
      else delete project.canChat
      break
    }
    case 'project.decider': {
      const project = boardOwned(command.projectId)
      if (command.personId === null) delete project.decider
      else if (readsProject(state, project, command.personId)) project.decider = command.personId
      else personUnknown()
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
      // The text this save replaces, which the store read for the stale check above: what the rule check compares with. A
      // project still on the template needs no read. Unread, nothing can be checked, so nothing is saved (review of #3112).
      const onTemplate = !current || project.instructionsHash === instructionsHash(INSTRUCTIONS_TEMPLATE)
      const before = context.instructions?.revision === current ? context.instructions.text : onTemplate ? INSTRUCTIONS_TEMPLATE
        : fail('INSTRUCTIONS_UNAVAILABLE', 'This project\'s instructions cannot be read now. Try again in a moment.', 503)
      // A line the save adds that the document already has is refused with the existing line quoted (#3283).
      // A person may keep both lines with a reason, which the History's summary records; the coordinator may not (#3568).
      const kept = actor.kind === 'person' && command.repeatReason && repeatedRules(before, command.text).length > 0
      refuseRepeats(before, command.text, !!kept)
      const because = kept ? ` (kept a repeated line: ${command.repeatReason})` : ''
      const summary = because && command.summary.length + because.length > 200 ? `${command.summary.slice(0, 199 - because.length)}…${because}` : command.summary + because
      // No part grows past its size budget: core, each role section, people notes, the whole (#3392).
      refuseOverBudget(before, command.text)
      // A person's rule, or who gave it, needs their approval or the configured top decider's own message (#3151, #3710).
      const { rules } = allowedDrops(state, project, before, command.text, sender, command.approvals ?? [], context.approvals ?? [],
        context.instructions?.at ?? 0, context.pullRequestMerges ?? {}, context.projectRules?.rules.instructionApprovals)
      // Every line it dropped, with its kind and who gave it, kept with the revision for the History (River, 11-05).
      saveInstructions(project, current, command.text, summary, askedBy, droppedLines(before, command.text, command.dropped ?? [], rules))
      break
    }
    case 'rules.set': {
      // People change a project's rules, or its PM passing on a person's own chat message of this project from the last day
      // (task #3393): the record keeps who wrote it, for whom and where they asked. Nothing is posted: the history shows it.
      const project = readProject(state, actor, command.projectId)
      let askedBy: string, askedIn: { conversationId: string; messageId: string } | null = null
      if (actor.kind === 'agent') {
        if (ledProject(state, actor.agentId)?.id !== project.id) {
          fail('RULES_EDITOR_REQUIRED', 'A member changes this project\'s rules, or its PM passing on their chat message. Ask the PM in the project chat.', 403)
        }
        const asked = command.askedIn && context.askedIn
        const where = command.askedIn && state.conversations.find(c => c.id === command.askedIn!.conversationId)
        if (!asked || !where || asked.author.kind !== 'person' || asked.source || context.now - asked.createdAt > RULE_MESSAGE_MS
          || groupProject(state, where).id !== project.id) {
          fail('RULES_ASKED_IN_REQUIRED', 'Quote the chat message, from the last day in this project, of the person who asked for this change (askedIn).', 400)
        }
        askedBy = askedByOf(state, project, asked.author.id)
        // The person must still be one who may change the rules themselves: not one made a viewer since (security review).
        if (person(state, askedBy).role === 'viewer') {
          fail('RULES_ASKED_IN_REQUIRED', 'Quote the chat message of a member who may change this project, not a viewer.', 400)
        }
        askedIn = { conversationId: command.askedIn!.conversationId, messageId: command.askedIn!.messageId }
      } else askedBy = (actor as Extract<Actor, { kind: 'person' }>).userId
      if (context.projectRules === undefined) fail('RULES_UNAVAILABLE', 'This project\'s rules cannot be read now. Try again in a moment.', 503)
      const current = context.projectRules ?? { revision: 0, rules: seedRules(state.id, project.id) }
      if (command.baseRevision !== current.revision) {
        // Refused with the record it missed, to merge and save again: never two writers' records kept silently.
        fail('RULES_STALE', `The project rules changed since revision ${command.baseRevision}. Merge your change into revision ${current.revision} and save again.`,
          409, { revision: current.revision, rules: current.rules })
      }
      // Old clients omit the additive authority section. Preserve it; an explicit null removes it.
      const next = command.rules.instructionApprovals === undefined && current.rules.instructionApprovals !== undefined
        ? { ...command.rules, instructionApprovals: current.rules.instructionApprovals } : command.rules
      if (JSON.stringify(current.rules.instructionApprovals ?? null) !== JSON.stringify(next.instructionApprovals ?? null)
        && (actor.kind !== 'person' || (actor.userId !== project.ownerId && actor.userId !== current.rules.instructionApprovals?.topDeciderId))) {
        fail('RULES_APPROVAL_EDITOR_REQUIRED', 'Only the project owner or its current top decider, acting directly, may change who approves instruction rules or link their accounts.', 403)
      }
      // A writer that does not know machine rules leaves them as they are; one that sends a list sets it.
      const kept = next.machines === undefined && current.rules.machines ? projectRulesSchema.safeParse({ ...next, machines: current.rules.machines }) : null
      if (kept && !kept.success) fail('RULES_INVALID', `The project's machine rules do not fit this record: ${kept.error.issues[0]?.message ?? 'invalid'}`, 400)
      const rules = kept?.data ?? next
      if (rulesEqual(current.rules, rules)) {
        Object.assign(result, { projectId: project.id, revision: current.revision, unchanged: true })
        break
      }
      const revision = current.revision + 1
      effects.projectRules = { projectId: project.id, revision, rules, diff: rulesDiff(current.rules, rules),
        summary: command.summary, writtenBy: { kind: sender.kind, id: sender.id }, askedBy, askedIn, at: context.now }
      for (const group of state.conversations) if (!group.kind && !group.audience && !group.reviewOf
        && (group.projectId ?? 'lead') === project.id) stampLane(group, rules.lanes)
      Object.assign(result, { projectId: project.id, revision })
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
    case 'project.about': {
      // As its coordinator's name: the coordinator sets it, or a person who manages the project.
      const project = readProject(state, actor, command.projectId)
      if (actor.kind === 'agent') coordinatorOf(project)
      else manageProject(state, actor, project.id)
      mutableProjects(state)
      const stored = projectOf(state, project.id)
      if (command.about) stored.about = command.about
      else delete stored.about
      break
    }
    case 'project.answers': {
      // As its coordinator's name: the coordinator sets it, or a person who manages the project.
      const project = readProject(state, actor, command.projectId)
      if (actor.kind === 'agent') coordinatorOf(project)
      else manageProject(state, actor, project.id)
      mutableProjects(state)
      const stored = projectOf(state, project.id)
      if (command.inThread) stored.answersInThread = true
      else delete stored.answersInThread
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
      if (command.ifMissing) {
        if (actor.userId !== state.ownerId) fail('OWNER_REQUIRED', 'Only the Swarm owner adds a machine automatically.', 403)
        if (cleaning || state.machines.some(m => m.machineId === command.machineId)) break
        if (command.unlessRemoved && state.removedMachines?.some(r => r.machineId === command.machineId)) break
      }
      // Added again: no longer one its person took out.
      if (state.removedMachines) {
        state.removedMachines = state.removedMachines.filter(r => r.machineId !== command.machineId)
        if (!state.removedMachines.length) delete state.removedMachines
      }
      if (cleaning) fail('MACHINE_CLEANING', 'This machine is still cleaning up after its removal. Add it again once that finishes.')
      // A machine already here is counted already: saving it again is never refused.
      if (!state.machines.some(m => m.machineId === command.machineId) && machineLimitReached(state, actor.userId)) {
        fail('MACHINE_LIMIT_PER_PERSON', MACHINE_LIMIT_MESSAGE)
      }
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
      const pendingHere = state.starts?.filter(s => s.request.machineId === command.machineId && (!s.harnessId || (s.poolGeneration && !s.poolSettled)) && !s.error) ?? []
      if (pendingHere.length) fail('STARTS_PENDING', 'Reconcile pending starts before changing this contribution.')
      // Saving settings sends the whole contribution again; only machine.pause changes its pause (review of #2084).
      const paused = state.machines.find(m => m.machineId === command.machineId)?.paused ?? false
      // Added as its person joined (Desktop's join): teammates' work only through its Harness Team account, for as long as
      // it stays contributed. Saving its settings sends the contribution without the field, and must not drop the rule.
      const teamAccountOnly = command.teamAccountOnly || state.machines.find(m => m.machineId === command.machineId)?.teamAccountOnly
      // Its Agents setting: a client that does not send one (older than #2860) keeps the stored one while the count is the same.
      const previous = state.machines.find(m => m.machineId === command.machineId)
      const agents = command.agents ?? (previous?.agents && previous.maxAgents === command.maxAgents ? previous.agents : undefined)
      state.machines = state.machines.filter(m => m.machineId !== command.machineId)
      state.machineCleanups = state.machineCleanups?.filter(c => c.machineId !== command.machineId)
      if (!state.machineCleanups?.length) delete state.machineCleanups
      state.machines.push({ machineId: command.machineId, name: context.contribution?.machineName ?? command.name, cwd: command.cwd, engines: [...new Set(command.engines)],
        maxAgents: command.maxAgents, ...(agents ? { agents } : {}),
        ...(command.scope ? { scope: command.scope } : {}),
        contributorId: actor.userId, membershipGeneration: contributor.generation, generation: operationId, paused,
        ...(teamAccountOnly ? { teamAccountOnly: true as const } : {}),
        // What its readings and starts recorded is not a setting: saving the settings keeps the Lent ledger, the engines'
        // failures and suspensions and the last reading (#3043). A machine not listed yet starts clean.
        ...(previous?.lent ? { lent: previous.lent } : {}), ...(previous?.lentDays ? { lentDays: previous.lentDays } : {}),
        ...(previous?.engineFailures ? { engineFailures: previous.engineFailures } : {}),
        ...(previous?.engineBackoff ? { engineBackoff: previous.engineBackoff } : {}),
        ...(previous?.machineFailures ? { machineFailures: previous.machineFailures } : {}),
        ...(previous?.machineBackoff ? { machineBackoff: previous.machineBackoff } : {}),
        ...(previous?.machineSuspension ? { machineSuspension: previous.machineSuspension } : {}),
        ...(previous?.engineSuspensions ? { engineSuspensions: previous.engineSuspensions } : {}),
        ...(previous?.observation ? { observation: previous.observation } : {}) })
      break
    }
    case 'machine.pause': {
      const pool = machineContribution(state, command.machineId) ?? fail('NOT_FOUND', 'This machine has not been contributed.', 404)
      if (actor.kind !== 'person' || actor.userId !== pool.contributorId) fail('OWNER_REQUIRED', 'Only its contributor can change this machine.', 403)
      if (pool.removal) fail('MACHINE_REMOVED', 'This machine is being removed from the Swarm.')
      pool.paused = command.paused
      break
    }
    case 'machine.engineResume': {
      // A suspended engine (engineHealth.ts) is offered again at its owner's word: theirs, or a Lead's passing on a chat
      // message they wrote in the last day, as routing rules are. No new button: the only visible change is the struck name.
      const pool = machineContribution(state, command.machineId) ?? fail('NOT_FOUND', 'This machine has not been contributed.', 404)
      if (!machineOwnerWord(pool, command.askedIn)) {
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
      const readableAgentIds = new Set(members.filter(a => canReadAgent(state, actor, a)).map(a => a.id))
      const removed = removeMachine(command.machineId, pool, members, machine => `${who} removed ${machine} from the Swarm`)
      if (pool) result.removalId = operationId
      result.removedAgents = [...removed].filter(id => readableAgentIds.has(id))
      // So a Personal Swarm's sync, on any computer, never adds it back by itself (#2181). What deletes it: adding it again, the
      // Swarm's deletion, and the cap (the oldest goes: that one could come back once).
      if (pool) {
        state.removedMachines = [...(state.removedMachines ?? []).filter(r => r.machineId !== command.machineId),
          { machineId: command.machineId, contributorId: pool.contributorId }].slice(-MAX_REMOVED_MACHINES)
      }
      break
    }
    case 'machine.teamGone': {
      // Harness Team accounts are gone (anh Dee, 2026-11-10: "remove all team accounts"): what a Swarm still records of one's
      // machine leaves with its agents, whose daemon can no longer connect. Its folders are that account's, which its person
      // removes from the computer, so nothing waits for a host to clean up or to confirm a close.
      if (!context.teamMachineGone || actor.kind !== 'person') fail('FORBIDDEN', 'Harness takes Team accounts\' machines out by itself.', 403)
      const pool = state.machines?.find(m => m.machineId === command.machineId)
      const members = state.agents.filter(a => a.machineId === command.machineId)
      if (!pool && !members.length) break
      // A launch its host took never arrives.
      for (const start of state.starts?.filter(s => s.request.machineId === command.machineId && !s.harnessId && !s.error && s.dispatched) ?? []) {
        start.error = MACHINE_REMOVED
      }
      // Their tasks' code stays guarded once they are gone (audit H2).
      markHeldByTeam(state, new Set(members.map(a => a.id)))
      removeMachine(command.machineId, pool, members, machine => `Harness Team accounts are gone, so the one on ${machine} left the Swarm`, true, true)
      dropClosing(state, c => c.machineId !== command.machineId)
      state.machineCleanups = state.machineCleanups?.filter(c => c.machineId !== command.machineId)
      if (!state.machineCleanups?.length) delete state.machineCleanups
      break
    }
    case 'machine.moved': {
      // A computer is signed in as one account at a time (Scholes, #3122): the store found another account's sign-in on the
      // computer of this entry and runs this as the entry's owner. Nothing here is the request's: the store read the computer's
      // accounts from their rows. An entry still reporting is left (two live accounts on one computer id are no switch).
      const move = context.computerMove
      if (!move || actor.kind !== 'person') fail('FORBIDDEN', 'Harness moves a computer to the account signed in on it.', 403)
      const pool = movableEntry(state, command.machineId, actor.userId, move.to, context.now)
      if (!pool) break
      // Its host is gone, so a start it launched never arrives: each fails now, launched or not.
      for (const start of state.starts?.filter(s => s.request.machineId === pool.machineId && !s.harnessId && !s.error) ?? []) {
        start.error = MACHINE_MOVED
        effects.messages.push({ id: stableId(operationId, 'start', start.id), conversationId: start.request.conversationId, author: sender,
          text: `${start.request.name} will not start: its machine is signed in to another account now.`, replyTo: null, recipients: [], source: SYSTEM_ROW })
      }
      const leaving = state.agents.filter(a => a.machineId === pool.machineId)
      const how = (machine: string) => `${machine} is signed in to another account now, so it left the Swarm under its old account`
      // The old account's agents stop first, Product Managers too: they ran under a login this computer no longer has.
      removeMachine(pool.machineId, pool, leaving, how, true, true)
      const newOwner = state.people.find(p => p.id === move.to.ownerId)
      const until = new Date(context.now).toISOString()
      const existing = state.machines?.find(m => m.machineId === move.to.machineId && !m.removal)
      if (existing) existing.previousOwner = { personId: pool.contributorId, until }
      else if (newOwner && !existing && !state.machines?.some(m => m.machineId === move.to.machineId)
        && !state.removedMachines?.some(r => r.machineId === move.to.machineId) && !machineLimitReached(state, newOwner.id)) {
        // The computer's own settings move with it; what was granted to or recorded for its old owner does not.
        ;(state.machines ??= []).push({ machineId: move.to.machineId, name: move.to.name ?? pool.name, cwd: pool.cwd, engines: [...pool.engines],
          maxAgents: pool.maxAgents, ...(pool.agents ? { agents: pool.agents } : {}), ...(pool.scope ? { scope: pool.scope } : {}),
          contributorId: newOwner.id, membershipGeneration: newOwner.generation, generation: operationId, paused: pool.paused,
          teamAccountOnly: true, previousOwner: { personId: pool.contributorId, until } })
      }
      result.moved = true
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
      // folders there. Product Managers go too.
      for (const pool of (state.machines ?? []).filter(m => !m.removal)) {
        removeMachine(pool.machineId, pool, state.agents.filter(a => a.machineId === pool.machineId), machine => `${machine} left the Swarm when it was deleted`, true)
      }
      // Agents on no contributed machine (shared sessions), each with its session.
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
      // The line is one more item: one the document already has is refused like a save's, quoting it (#3283, review of #3202).
      const appended = appendRouting(stored, command.text)
      refuseRepeats(stored, appended)
      saveInstructions(project, current, appended, routingSummary(command.text), askedBy)
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
      // A private chat is no task of its own, so it carries no priority (taskPriority.ts).
      const prioritized = !command.audience
      if (command.priority && !prioritized) fail('PRIORITY_TASK_ONLY', 'Only a task has a priority: leave it out of a private chat.', 400)
      // In a switched project a person's P0, or a task for someone else, needs a right (boardRights.ts, task #3819).
      if (command.priority) requirePriorityRight(state, actor, project, command.priority, command.requesterId ?? undefined)
      // A hotfix jumps every queue, so of the agents only the PM marks one (River, task #3117).
      if (command.priority === 'P0' && actor.kind === 'agent' && ledProject(state, actor.agentId)?.id !== project.id) {
        fail('PRIORITY_P0', 'Only the PM or a person sets P0. Give this task P1, P2 or P3.', 403)
      }
      if (command.requestMessageId && command.audience) fail('INVALID_REQUEST', 'A request message opens a task of its own: leave out audience.', 400)
      const request = command.requestMessageId ? requestOf(state, project, context.request) : undefined
      if (request) settleRequest(state, project, actor.kind === 'agent' ? actor.agentId : null, request.messageId)
      // Who asked: the person named, else the one whose message asked for it, else a person opening it themselves.
      const requesterId = command.requesterId ? requester(state, project, command.requesterId)
        : request?.personId ?? (actor.kind === 'person' ? actor.userId : undefined)
      // An agent's task says its goal, when it is done, its priority and who asked (taskContract.ts, task #3389). A private chat
      // is no task of its own.
      if (actor.kind === 'agent' && prioritized) {
        const missing = missingContract({ goal: brief, checks: command.checks.length, priority: Boolean(command.priority), requester: Boolean(requesterId || command.noRequesterReason) })
        if (missing.length) fail('TASK_CONTRACT_MISSING', contractRefusal(missing), 400)
      }
      const number = nextConversationNumber(state)
      state.groupCounter = number
      // The agent that opens a task is in it, so an Engineer that opens its own review can post there and pass its checks.
      const creator = actor.kind === 'agent' && actor.agentId !== leadId ? [actor.agentId] : []
      for (const id of creator) teamJoin(project, id)
      state.conversations.push({ id: operationId, ...(state.projects ? { projectId: project.id } : {}),
        ...(!command.audience && processOf(project) === 'simple' ? { process: 'simple' as const } : {}),
        number, title: command.title, leadId, agentIds: [...leadId ? [leadId] : [], ...creator],
        archived: false, brief, ...(brief ? { briefAt: context.now } : {}), ...(command.task ? { task: command.task } : {}),
        ...(prioritized ? { priority: command.priority ?? DEFAULT_PRIORITY } : {}),
        // Its own code's pull requests, read for its Team-written mark: never a link in a post (task #3554, model.ts).
        assignment: null, lastMessageSequence: 0, codePullRequestUrls: [],
        checks: storedChecks(command.checks, operationId),
      })
      stampLane(state.conversations.at(-1)!, (context.projectRules?.rules ?? SEED_RULES).lanes)
      recordAsked(state.conversations.at(-1)!, requesterId, context.now)
      const created = state.conversations.at(-1)!
      stageTaskApproval(state, created, context.now)
      // The reason stands only where nobody is named, and is shown in the task's first row beside its goal.
      const noRequester = !requesterId && actor.kind === 'agent' ? command.noRequesterReason : undefined
      if (noRequester && state.conversations.at(-1)!.ledger) state.conversations.at(-1)!.ledger!.noRequesterReason = noRequester
      // The asker's message is the task's root; its thread takes the task's replies (taskLine.ts).
      if (request) state.conversations.at(-1)!.cards = { line: { messageId: request.messageId, conversationId: project.leadConversationId } }
      result.conversationId = operationId
      result.number = number
      if (prioritized) {
        result.priority = state.conversations.at(-1)!.priority
        if (!command.priority) result.warnings = [...result.warnings as string[] ?? [], PRIORITY_DEFAULTED]
      }
      if (brief) {
        message(operationId, noRequester ? `${brief}\n\nNo requester: ${noRequester}` : brief, [], null, SYSTEM_ROW)
        bindTaskCard(state.conversations.at(-1)!, effects.messages.at(-1)!)
      }
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
      if (group.taskApproval && command.personId !== group.taskApproval.personId) fail('TASK_APPROVAL_FORBIDDEN', 'Keep the original requesting person on a task with an approval decision.', 403)
      // Its requester may close it once it is lost or stopped (by archiving it), so among people only an owner names who asked;
      // anyone else could name themselves and cancel a task they never asked for (security review 2 of #2907). Agents name
      // the person they opened it for, as before.
      if (actor.kind === 'person' && actor.userId !== state.ownerId && !ownsProject(state, actor.userId, groupProject(state, group))) {
        fail('FORBIDDEN', 'Among people, only the Swarm owner or the project\'s owner names who asked for a task.', 403)
      }
      if (command.personId) {
        const next = requester(state, groupProject(state, group), command.personId)
        if (next !== group.requesterId) {
          group.requesterId = next
          stageTaskApproval(state, group, context.now)
          if (group.assignment && group.taskApproval?.state === 'proposal')
            fail('TASK_APPROVAL_REQUIRED', 'Cannot attribute assigned work to a person who must approve it first.', 409)
        }
      }
      else delete group.requesterId
      break
    }
    case 'conversation.unlink': {
      chatOnly(command.conversationId)
      const group = open(state, command.conversationId), project = groupProject(state, group)
      if (isStep(group) || group.id === project.leadConversationId) fail('UNLINK_TASK_ONLY', 'Only a task has links to take off: name a task, not a chat or a step.', 400)
      // Only the project's coordinator and the task's Engineer; a person is neither (the PM acts for them).
      if (actor.kind !== 'agent' || (ledProject(state, actor.agentId)?.id !== project.id && group.assignment?.agentId !== actor.agentId)) {
        fail('FORBIDDEN', 'Only the project\'s coordinator or the task\'s Engineer takes a pull request off a task.', 403)
      }
      const repositoryUrl = groupRepositoryUrl(state, group)
      const pullRequestUrl = projectPullRequestUrl(command.pullRequestUrl, repositoryUrl)
        ?? fail('PULL_REQUEST_REPOSITORY', 'This pull request is not in the project\'s repository.', 400)
      if (!group.pullRequestUrls?.includes(pullRequestUrl)) fail('NOT_LINKED', 'This task does not link that pull request.', 404)
      if (pullRequestCard(group, pullRequestUrl)?.mergedAt !== undefined) fail('MERGED_LINK', 'This task recorded that pull request as merged: its merge stays on the task.', 409)
      group.pullRequestUrls = group.pullRequestUrls.filter(url => url !== pullRequestUrl)
      if (group.codePullRequestUrls) group.codePullRequestUrls = group.codePullRequestUrls.filter(url => url !== pullRequestUrl)
      if (group.cards) group.cards = { ...group.cards, pullRequests: group.cards.pullRequests?.filter(card => card.url !== pullRequestUrl),
        recorded: group.cards.recorded?.filter(url => url !== pullRequestUrl) }
      group.unlinkedPullRequests = [...(group.unlinkedPullRequests ?? []).filter(entry => entry.url !== pullRequestUrl),
        { url: pullRequestUrl, by: actorKey(actor), reason: command.reason, at: context.now }].slice(-UNLINKS_KEPT)
      const by = agentDisplayName(state.agents, actor.agentId) ?? agent(state, actor.agentId).name
      message(group.id, `${by} unlinked ${pullRequestUrl} from this task: ${command.reason}`, [], null, SYSTEM_ROW)
      break
    }
    case 'conversation.archive': {
      const group = conversation(state, command.conversationId)
      if (group.id === groupProject(state, group).leadConversationId) fail('LEAD_CONVERSATION', 'The Lead conversation stays available.')
      // A task stored before Swarm v4 whose work did not finish closes as it archives: v4 retired the cancel that closed it
      // (work.cancel, 2026-11-10). Whoever that cancel let close it, and the task says so; a working agent is told to stop.
      if (command.archived && (activeWork(group) || unfinishedWork(group))) {
        const assignment = group.assignment!, live = activeWork(group), project = groupProject(state, group)
        const closes = projectAgent(state, actor, project.id) || (actor.kind === 'person' && (actor.userId === state.ownerId
          || (!live && (actor.userId === group.requesterId || ownsProject(state, actor.userId, project)))))
        if (!closes) fail('FORBIDDEN', live ? WHO_CANCELS_LIVE : WHO_CANCELS_ENDED, 403)
        assignment.status = 'cancelled'
        assignment.result = 'Archived before it finished.'
        if (live) finishWorker(state, assignment.agentId)
        effects.closedAssignment = { assignmentId: assignment.id, outcome: 'cancelled' }
        message(group.id, `${who} archived this task before it finished.${live ? ' Stop working on it.' : ''}`, live ? [assignment.agentId] : [], null,
          live ? forRecipients({ ...SYSTEM_ROW, status: 'cancelled' }) : { ...SYSTEM_ROW, status: 'cancelled' }, undefined, undefined, stableId(operationId, 'closed'))
      }
      const tags = command.archived && !group.archived ? cancelledTags(state, group, actor) : []
      if (tags.length) message(group.id, `Archived without shipping: the task was cancelled${cancelReason(group) ? ` (${cancelReason(group)})` : ''}.`, [], null, SYSTEM_ROW, undefined, tags)
      group.archived = command.archived
      if (command.archived) endStepsOf(group, `${group.title} was archived.`, true)
      // Archived by hand, it leaves the active set until it is reopened (spec, Archive). No report is waited for: the server writes
      // the status card (task #3593).
      if (command.archived) group.dormant = true
      else delete group.dormant
      break
    }
    case 'agent.add': {
      /** The chat a new PM opens with its person (Swarm v4), when this add opens one. */
      let pmChat: string | undefined
      requireTaskApproval(conversation(state, command.conversationId), state.agents.find(a => a.machineId === command.machineId && a.harnessId === command.harnessId)?.id ?? null)
      if (!['claude', 'codex'].includes(command.configuration.engine)) fail('SWARM_ENGINE', 'A Swarm agent runs only Claude Code or Codex.', 400)
      // A person shares a session already running (Desktop sends this as its person); an agent starts a new one. From an
      // agent it re-added a person's agent to a task, added to the project chat, and registered any session of its
      // contributor's machines, the Swarm's or not, past conversation.agent's checks (security review S2).
      if (actor.kind !== 'person') fail('HUMAN_REQUIRED', 'A person adds a session already running. Start a new agent instead.', 403)
      const addedName = addedAgentName(state, actor, command.name, command.conversationId)
      const group = open(state, command.conversationId)
      // A Member's own chat (local agent.new, task #4196) takes the one session its person started for it on their own computer,
      // in their own account, as a Regular agent in no project: as agent.started records a server-started one.
      if (isAgentChat(group)) {
        readConversation(state, actor, group.id)
        const me = person(state, actor.userId)
        if (me.role === 'viewer') fail('READ_ONLY', 'A viewer cannot contribute agents.', 403)
        const grant = context.contribution ?? fail('HOST_REQUIRED', 'Choose your own computer.', 403)
        if (grant.machineOwnerId !== me.id || grant.contributorId !== me.id || grant.hostGrant) {
          fail('AGENT_OWN_MACHINE', 'A new agent runs only on your own computer, in your own account.', 403)
        }
        if (command.lead) fail('AGENT_CHAT_LEAD', 'An agent\'s own chat has no lead.', 400)
        if (group.agentIds.length) fail('AGENT_CHAT_TAKEN', 'This chat already has its agent.', 409)
        const agentId = stableId(command.machineId, command.harnessId)
        if (state.agents.some(a => a.id === agentId)) fail('ALREADY_SHARED', 'This native harness is already in the tab.')
        reserveHarnessSlot(state, command.machineId, command.harnessId, operationId)
        state.agents.push({ id: agentId, machineId: command.machineId, harnessId: command.harnessId, regular: true,
          machineOwnerId: me.id, contributorId: me.id, membershipGeneration: me.generation, hostGrant: null, name: addedName,
          configuration: command.configuration, configurationVersion: operationId })
        group.agentIds.push(agentId)
        result.agentId = agentId
        if (command.initialMessage) message(group.id, command.initialMessage)
        break
      }
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
      if (existing) joinable(group, existing)
      // A session already in the Swarm joins the project chat as conversation.agent adds one: refused but for its coordinator. A
      // new one shared there (Desktop's New agent in the project chat) joins the project alone, for its tasks (#2207).
      const sharedHere = !command.lead && projectsOf(state).some(p => p.leadConversationId === group.id)
      if (sharedHere && existing) projectChatJoin(group, existing.id, existing.displayName ?? existing.name)
      // An older Desktop adds a session in a custom role (roleId): kept, with a Reviewer role's kind, for older readers, and
      // read by no command. The role name it means is the agent's (instructions.ts legacyRoleName).
      const roleKind = command.roleId ? project.roles?.find(r => r.id === command.roleId)?.kind : undefined
      const roleName = command.roleName ?? legacyRoleName(project, { roleId: command.roleId })
      if (existing?.workDecision === 'stop' && command.lead) fail('STOP_REQUESTED', 'This worker is stopping. Wait for its execution host.')
      if (!existing) reserveHarnessSlot(state, command.machineId, command.harnessId, operationId)
      // Added back by hand: what they chose now stands over what its removal kept.
      dropRemovedRecord(state, command.machineId, command.harnessId)
      // Added back before its host closed it: the session stays open.
      if (!existing) dropClosing(state, c => c.machineId !== command.machineId || c.harnessId !== command.harnessId)
      if (!existing) state.agents.push({ id: agentId, machineId: command.machineId, harnessId: command.harnessId,
        ...(state.projects ? { projectId: project.id } : {}),
        machineOwnerId: grant.machineOwnerId, contributorId: grant.contributorId, membershipGeneration: contributor.generation,
        hostGrant: grant.hostGrant ?? null,
        name: addedName, configuration: command.configuration, configurationVersion: operationId,
        ...(roleKind === 'reviewer' ? { role: 'reviewer' as const } : {}), ...(command.roleId ? { roleId: command.roleId } : {}),
        ...(roleName ? { roleName } : {}) })
      if (existing && (existing.machineOwnerId !== grant.machineOwnerId || existing.contributorId !== grant.contributorId)) {
        fail('ALREADY_SHARED', 'This session already has a contributor. Use the existing tab agent.')
      }
      if (existing && (existing.hostGrant ?? null) !== (grant.hostGrant ?? null)) {
        fail('CONTRIBUTION_REVOKED', 'Reconcile and remove this old contribution before adding it under the new machine share.', 403)
      }
      // Named as readers' lists show it, never the name the rules refused (security review 2 of #3015).
      if (sharedHere && !existing) {
        const shown = quotedName(agentDisplayName(state.agents, agentId) ?? addedName)
        message(group.id, `${who} added ${shown} to the project. The project chat holds only its coordinator among agents, so ${shown} works in its tasks.`, [], null, SYSTEM_ROW,
          undefined, undefined, stableId(operationId, 'shared-to-project'))
      } else if (!group.agentIds.includes(agentId)) group.agentIds.push(agentId)
      if (command.lead) {
        keepLead(group, agentId)
        if (group.leadId && group.leadId !== agentId && activeWork(group)) fail('WORK_ACTIVE', 'Reconcile active work before replacing its lead.')
        group.leadId = agentId
        if (group.id === project.leadConversationId) {
          arrived(project, agentId)
          // Swarm v4 (anh Dee 2026-11-08): the project chat is its channel, where only agents post, so its person talks to the PM
          // in a chat of its own, once (agentKind.ts agentChatId).
          if (!state.conversations.some(c => isAgentChat(c) && c.agentIds.includes(agentId))) {
            pmChat = openAgentChat(contributor, addedName)
            open(state, pmChat).agentIds.push(agentId)
            state.agents.find(a => a.id === agentId)!.chatId = pmChat
          }
        }
      }
      result.agentId = agentId
      // Creation already handed this first request to the native harness (and
      // any attachments through its existing launch path). Record it once in
      // the shared conversation without delivering the same request twice.
      // A new PM's first request is its person's first line in their chat with it (Swarm v4: only agents post in the channel).
      if (command.initialMessage) {
        if (actor.kind !== 'person') fail('FORBIDDEN', 'Only a person can record their initial launch request.', 403)
        requireCanChat(state, actor, group)
        message(pmChat ?? group.id, command.initialMessage)
      }
      // A Product Manager started on its person's own Mac says, as one the Swarm starts does (leadJoined), when it does not
      // run the model its role asked for.
      if (command.lead && command.launchRefused) message(group.id, launchRefusedLine(command.launchRefused, coordinatorNameOf(project)), [], null, SYSTEM_ROW,
        undefined, undefined, stableId(operationId, 'launch-refused'))
      break
    }
    case 'agent.start': {
      requireTaskApproval(conversation(state, command.request.conversationId), null)
      if (undecidedProposal(conversation(state, command.request.conversationId))) fail('PROPOSAL_UNDECIDED', 'The PM must accept or reshape this proposal before starting work.', 409)
      chatOnly(command.request.conversationId)
      projectChatWork(command.request.conversationId)
      // A coordinator starts there through lead.start alone.
      projectChatJoin(open(state, command.request.conversationId), null, command.request.name)
      const home = groupProject(state, open(state, command.request.conversationId))
      if (state.paused) fail('PAUSED', 'New work is paused in this Super Tab.')
      pausedTask(open(state, command.request.conversationId))
      if (!['claude', 'codex'].includes(command.request.engine)) {
        fail('SWARM_ENGINE', 'A Swarm agent runs only Claude Code or Codex.', 400)
      }
      // An older client starts in a kind or a custom role, kept on the start for older readers and read by no command: the
      // role name it means rides on the start to the agent (instructions.ts legacyRoleName).
      const roleName = command.request.roleName ?? legacyRoleName(home, command.request)
      // A start that asks Codex for `default` runs the catalog's named default, never whatever the account's CLI defaults to
      // (task #2972). A named effort is kept; none, or `default`, takes the row's.
      const catalogDefault = command.request.model === 'default' && !command.request.gridModel ? namedDefault(command.request.engine) : null
      const asked = catalogDefault
        ? { ...command.request, model: catalogDefault.model, effort: !command.request.effort || command.request.effort === 'default' ? catalogDefault.effort : command.request.effort }
        : command.request
      const named = roleName ? { ...asked, roleName } : asked
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
      // A start that names no model runs its engine's own: role defaults live in the project's instructions now.
      const startGroup = conversation(state, command.request.conversationId)
      marking(startGroup, () => applyPushOrigin(state, startGroup, context.pushOrigin, context.pushOriginPulls, context.pushOriginTask))
      const written = teamWrittenTask(state, startGroup)
      // A new agent starts only on its own person's computer, as them (task #4120, the PM's ruling): never the PM on another
      // person's (machines.ts admitMachineStart).
      // The machine's own owner, as its contributor, with no machine share, as agent.new checks
      // (security review 2 of #3446: off the Machines list, or through a share, the contributor is not the machine's owner).
      const starter = actor.kind === 'person' ? actor.userId : agent(state, actor.agentId).contributorId
      if (starter !== grant.contributorId || starter !== grant.machineOwnerId || grant.hostGrant) failTeamWork({ code: 'NOT_YOUR_COMPUTER', reason: NOT_YOUR_COMPUTER })
      // Code a Team agent wrote, or a branch GitHub cannot place, runs only on the project owner's own computer, with its project
      // settings off (teamWritten.ts, the PM's ruling; audit H2, security review 2 of #3081).
      if (written) requireTeamWrittenMachine(state, startGroup, named.machineId)
      else if (context.pushOrigin === 'unknown' && !ownersOwnMachine(state, startGroup, named.machineId)) failPushUnknown()
      const request: AgentStartRequest = noRepositoryStart(state.machines?.find(m => m.machineId === named.machineId), home,
        written ? { ...named, projectSettings: 'off' } : named)
      // The project's machine rules (machineRules.ts).
      refuseByMachineRules(context, { machineId: request.machineId, engine: request.engine, review: isReview(startGroup) })
      const pool = admitMachineStart(state, request, context.now)
      // Off the Machines list, a teammate's project never runs: nothing there shows a privacy check (machines.ts).
      if (!pool) requireTeamWork(state, request.machineId, grant.contributorId, home)
      state.starts.push({ ...(pool ? { poolGeneration: pool.generation } : {}), ...(command.routeDecisionId ? { routeDecisionId: command.routeDecisionId } : {}), id: operationId, creationId: `super-${operationId}`, actorKey: actorKey(actor),
        contributorId: contributor.id, membershipGeneration: contributor.generation, machineOwnerId: grant.machineOwnerId,
        hostGrant: grant.hostGrant ?? null, request, harnessId: null, dispatched: false, error: null, requestedAt: context.now })
      leadActed(command.request.conversationId, 'start')
      result.startId = operationId
      if (command.routeDecisionId) {
        const r = command.request
        const model = r.model ?? 'default', effort = r.effort ?? 'default'
        const { decision, override, instead, routed } = linkDecision(r.conversationId,
          c => c.kind === 'new' && c.machineId === r.machineId && c.engine === r.engine && c.model === model && c.effort === effort
            && (c.gridModel ?? null) === (r.gridModel ?? null) && (c.gridName ?? null) === (r.gridName ?? null),
          () => ({ kind: 'new', startId: operationId, machineId: r.machineId, engine: r.engine, model, effort,
            ...(r.gridModel && r.gridName ? { gridModel: r.gridModel, gridName: r.gridName } : {}) }), command.overrideReason)
        if (override) message(r.conversationId, instead(`started ${r.name}`), [], null,
          bookkeeping(r.conversationId, { kind: 'route-override', decisionId: decision.id, by: 'lead' }))
        if (routed) message(r.conversationId, routed.text, [], null, bookkeeping(r.conversationId, routed.source))
      }
      break
    }
    case 'person.tell': {
      // Any agent of a project, in its own project (project instructions, phase 4).
      const projectId = actor.kind === 'agent' ? agentProjectId(state, agent(state, actor.agentId)) : undefined
      if (!projectId || !projectAgent(state, actor, projectId)) fail('FORBIDDEN', 'An agent sends a person a private line, in its own project.', 403)
      const project = projectOf(state, projectId)
      const to = state.people.find(p => p.id === command.personId) ?? fail('INVALID_PERSON', 'Tell a person in this Swarm.', 400)
      if (!canReadProject(state, { kind: 'person', userId: to.id, email: to.email }, project)) fail('INVALID_PERSON', `${usernameOf(state, to.id)} cannot read this project.`, 400)
      // People talk only to the PM (anh Dee, 11-05; crewNeeds.ts): another agent's line is the PM's crew need, in the project chat.
      const projectChat = state.conversations.find(c => c.id === project.leadConversationId)
      const pmInstead = projectChat ? routesToPm(state, actor, projectChat) : null
      if (projectChat && pmInstead) {
        crewNeed(projectChat, pmInstead, { personIds: [to.id], conversationId: projectChat.id }, command.text)
        break
      }
      // The PM's private line went in the person's private chat with their own agent, where only they and it post (anh Dee,
      // 11-07, task #4558): the PM tags them in the project chat instead.
      fail('PRIVATE_CHAT', 'Only a person and their own agent post in their private chat. Post in the project chat, tagging them, or in the task\'s chat.', 403)
    }
    case 'agent.new': {
      // + New agent (Swarm v3, task #4116; anh Dee 11-07): the person's own agent, on their own listed computer and account
      // (Ken's ruling, 10-28): never a machine shared with them.
      if (actor.kind !== 'person') fail('HUMAN_REQUIRED', 'A person makes their own agent.', 403)
      if (state.paused) fail('PAUSED', 'New work is paused in this Swarm.')
      const me = person(state, actor.userId)
      if (me.role === 'viewer') fail('READ_ONLY', 'A viewer cannot start agents.', 403)
      const grant = context.contribution ?? fail('HOST_REQUIRED', 'Choose your own computer.', 403)
      if (grant.machineOwnerId !== me.id || grant.contributorId !== me.id || grant.hostGrant) {
        fail('AGENT_OWN_MACHINE', 'A new agent runs only on your own computer, in your own account.', 403)
      }
      // Cmd-N starts a Member through the Swarm, as Join does (task #4540): a local start or a Lead, which leads its own, takes none.
      if (command.mainProjectId) {
        if (command.local || command.kind !== 'regular') fail('MAIN_PROJECT_MEMBER_ONLY', 'Only a Member the Swarm starts takes a main project; New project makes its own Lead.', 400)
        readProject(state, actor, command.mainProjectId)
      }
      // A Member started through Cmd-N (task #4196, anh Dee 11-07): a server start waited on its host (p50 18 s, p95 4 min), so
      // its person's Desktop starts it on their own computer at once. Only its chat opens here, with no start, so neither a listed
      // computer nor a host that runs Regular starts is needed; agent.add then brings the running session into the chat.
      if (command.local) {
        if (command.kind !== 'regular') fail('LOCAL_MEMBER_ONLY', 'A Lead started on your computer starts its project with project.create.', 400)
        result.conversationId = openAgentChat(me, newAgentName(state, actor, command.name, operationId))
        break
      }
      const pool = state.machines?.find(m => m.machineId === command.machineId && m.contributorId === me.id && !m.removal)
        ?? fail('MACHINE_NOT_LISTED', 'Add this computer to the Swarm first.', 403)
      // Just listed, it has not reported yet: neither outdated nor offline (task #4252).
      if (!pool.observation) fail('HOST_CONNECTING', `${pool.name ?? 'Your computer'} is still connecting to the Swarm. Try again in a moment.`, 409)
      if (command.kind === 'pm') {
        const projectName = command.projectName ?? fail('PROJECT_NAME_REQUIRED', 'Name the project its PM starts.', 400)
        const project = createProject(me.id, projectName, 'public', '', 'full')
        const asked = leadEffort(withRoleDefaults({ engine: command.engine, ...(command.model ? { model: command.model } : {}),
          ...(command.repositoryUrl ? { repositoryUrl: command.repositoryUrl } : {}) }, BUILT_IN_ROLE_DEFAULTS.lead), coordinatorNameOf(project))
        const start = placeLead(state, project, me, pool.machineId, asked, operationId, context)
        Object.assign(result, { projectId: project.id, conversationId: project.leadConversationId, startId: start.id })
        break
      }
      // A Regular agent: in no project, in a chat of its own with its person, which nobody else reads (projects.ts readsAgentChat).
      // Its own name, or a real one picked for it (task #4568).
      const name = newAgentName(state, actor, command.name, operationId)
      // Only a host that says it runs one gets its start (read/hostRows.ts regularStarts): an older one would leave it waiting.
      if (!pool.observation?.capabilities?.includes(REGULAR_AGENT_CAPABILITY)) fail('HOST_OUTDATED', `Update Harness on ${pool.name ?? 'your computer'} to start this agent there.`, 409)
      const chatId = openAgentChat(me, name)
      const request: AgentStartRequest = { conversationId: chatId, machineId: pool.machineId, engine: command.engine,
        ...(command.model ? { model: command.model } : {}), name, cwd: homeFolder(pool, me), worktree: false,
        requirements: AGENT_REQUIREMENTS, regular: true,
        ...(command.mainProjectId ? { mainProjectId: command.mainProjectId } : {}) }
      const admitted = admitMachineStart(state, request, context.now)!
      state.starts ??= []
      if (state.starts.filter(s => !s.harnessId && !s.error).length >= 32) fail('STARTS_PENDING', 'Reconcile pending agent starts before adding more.')
      state.starts.push({ poolGeneration: admitted.generation, id: operationId, creationId: `super-${operationId}`, actorKey: actorKey(actor),
        contributorId: me.id, membershipGeneration: me.generation, machineOwnerId: grant.machineOwnerId, hostGrant: null, request,
        harnessId: null, dispatched: false, error: null, requestedAt: context.now })
      Object.assign(result, { conversationId: chatId, startId: operationId })
      break
    }
    case 'agent.startDispatch':
    case 'agent.started':
    case 'agent.startSettled':
    case 'agent.startWaiting':
    case 'agent.startFailed': {
      const start = state.starts?.find(s => s.id === command.startId) ?? fail('NOT_FOUND', 'This agent start is unavailable.', 404)
      if (!mayResumeStart(state, actor, start)) fail('FORBIDDEN', 'Only whoever made this start, or its project\'s coordinator, carries it on.', 403)
      if (person(state, start.contributorId).generation !== start.membershipGeneration) fail('FORBIDDEN', 'This contribution was withdrawn.', 403)
      if (command.type === 'agent.startWaiting') {
        // A start that ended says so itself; a late report changes nothing. A reason told again keeps when it was first told.
        if (!start.harnessId && !start.error && start.waiting?.reason !== command.reason) start.waiting = { reason: command.reason, at: context.now }
        break
      }
      delete start.waiting
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
        const switchId = start.request.leadFor?.switchId
        if (switchId) {
          const switchSource = state.agents.find(a => a.switchRequest?.id === switchId)
          const destination = machineContribution(state, start.request.machineId)
          const project = projectOf(state, start.request.leadFor!.projectId)
          if (!switchSource || switchSource.switchRequest?.targetMachineId !== start.request.machineId
            || switchSource.switchRequest.engine !== start.request.engine
            || conversation(state, project.leadConversationId).leadId !== switchSource.id) {
            fail('STALE_SWITCH', 'This PM switch is no longer current.')
          }
          if (!destination?.observation?.capabilities?.includes(SWITCH_CAPABILITY)
            || !destination.observation.capabilities.includes(LEAD_CAPABILITY)) {
            fail('HOST_OUTDATED', `Update Harness on ${destination?.name ?? 'that machine'} to move the ${coordinatorNameOf(project)}.`, 409)
          }
          // A switch asked before the server took the default account alone may still name another one. A destination host never
          // started a PM on another account (cli superTabs/machines.ts takes no account from a start), so it is the default one.
          const profileId = defaultProfileId(destination.machineId, switchSource.switchRequest.engine)
          if (switchSource.switchRequest.profileId !== profileId && start.request.profileId === switchSource.switchRequest.profileId) {
            switchSource.switchRequest.profileId = profileId
            start.request.profileId = profileId
          }
          if (start.request.profileId !== profileId) fail('STALE_SWITCH', 'This PM switch no longer names this account.')
          if (start.request.machineId !== switchSource.machineId && (start.request.handoffSourceAgentId !== switchSource.harnessId
            || start.request.handoffNote === undefined || !start.request.handoffChangeId)) {
            fail('HANDOFF_PENDING', 'The source host has not prepared this PM’s handoff yet.', 409)
          }
        }
        admitMachineStart(state, start.request, context.now, start)
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
        if (!start.poolSettled && !start.request.leadFor) message(start.request.conversationId, command.warning
          ? `${start.request.name}: ${command.warning}`
          : `${start.request.name} is ready for an assignment.`, [], null,
          command.warning ? SYSTEM_ROW : bookkeeping(start.request.conversationId, SYSTEM_ROW))
        start.poolSettled = true
        break
      }
      if (command.type === 'agent.startFailed') {
        if (start.harnessId) fail('ALREADY_STARTED', 'This agent already started.')
        // Only its first failure counts against its engine: the server may have timed it out before its host said so (liveness.ts).
        const counted = !start.error
        start.error = command.error
        // A crew member's move that did not start leaves it where it was, for the keeper's next pass (crewKeep.ts).
        if (start.request.crewMoveOf) crewMoveFailed(state, start, context.now)
        const suspended = counted ? noteStartFailed(state, start, context.now) : null
        const switchId = start.request.leadFor?.switchId
        const source = switchId && state.agents.find(a => a.switchRequest?.id === switchId)
        if (switchId && source) {
          const home = conversation(state, projectOf(state, start.request.leadFor!.projectId).leadConversationId)
          delete source.switchRequest
          const reason = publicReason(command.error)
          message(home.id, `Couldn't switch the PM: ${reason[0]!.toLowerCase()}${reason.slice(1)} It is back on ${ENGINE_NAMES[source.configuration.engine] ?? 'its engine'}.`, [], null, SYSTEM_ROW)
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
        const failed = `${failureNotice(start.request.name, command.error, askedModel(start), coordinatorNameOf(groupProject(state, group)))}${suspended ? `\n\n${suspended}` : ''}`
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
      const switchId = start.request.leadFor?.switchId
      const switchSource = switchId && state.agents.find(a => a.switchRequest?.id === switchId)
      if (switchId) {
        const project = projectOf(state, start.request.leadFor!.projectId)
        if (!switchSource || switchSource.switchRequest?.targetMachineId !== start.request.machineId
          || conversation(state, project.leadConversationId).leadId !== switchSource.id) {
          fail('STALE_SWITCH', 'This PM switch is no longer current.')
        }
        if (start.request.machineId !== switchSource.machineId && (start.request.handoffSourceAgentId !== switchSource.harnessId
          || start.request.handoffNote === undefined || !start.request.handoffChangeId)) {
          fail('HANDOFF_PENDING', 'The source host has not prepared this PM’s handoff yet.', 409)
        }
      }
      // Answered, not refused: a refusal would take the row with it. Its host closes the session (cli superTabs/start.ts).
      const overtaken = start.request.leadFor && !switchId ? leadOvertaken(state, start, group) : null
      if (overtaken) {
        start.error = overtaken.reason
        result.refused = overtaken.reason
        message(group.id, overtaken.text, [], null, overtaken.source)
        break
      }
      reserveHarnessSlot(state, start.request.machineId, command.harnessId, operationId)
      state.agents.push({ id: agentId, machineId: start.request.machineId, harnessId: command.harnessId,
        ...(state.projects ? { projectId: groupProject(state, group).id } : {}),
        ...(start.request.regular ? { regular: true as const } : {}),
        ...(start.request.member ? { member: start.request.member } : {}),
        // A private main project ties it there from its start, not its first task (security review 2 of #3575): it carries the
        // project's name, so no other project's Lead sees it or gives it work once its person stops reading the project.
        ...(start.request.mainProjectId && projectsOf(state).find(p => p.id === start.request.mainProjectId)?.visibility === 'private'
          ? { privateProjectId: start.request.mainProjectId } : {}),
        ...(start.request.helperOf ? { helperOf: start.request.helperOf } : {}),
        ...(start.request.mainProjectId ? { mainProjectId: start.request.mainProjectId } : {}),
        machineOwnerId: start.machineOwnerId, contributorId: start.contributorId, membershipGeneration: start.membershipGeneration,
        hostGrant: start.hostGrant, name: start.request.name, configuration: command.configuration, configurationVersion: operationId,
        ...(start.request.role ? { role: start.request.role } : {}), ...(start.request.roleId ? { roleId: start.request.roleId } : {}),
        ...(start.request.roleName ? { roleName: start.request.roleName } : {}),
        ...(start.request.gridModel ? { gridModel: start.request.gridModel } : {}),
        ...(!start.request.gridModel && (start.request.model ?? 'default') === 'default' ? { launchedDefault: true as const } : {}),
        ...(start.request.profileId ? { profileId: storedProfileId(start.request.machineId, command.configuration.engine, start.request.profileId) } : {}),
        ...(command.startedSession ? { startedSession: { ...command.startedSession, creationId: start.creationId } } : {}) })
      group.agentIds.push(agentId)
      start.harnessId = command.harnessId
      noteStartSucceeded(state, start)
      result.agentId = agentId
      // A crew member's move: its new session becomes the same member, and the old one is retired (crewKeep.ts).
      if (start.request.crewMoveOf) {
        const move = state.agents.find(a => a.id === start.request.crewMoveOf)?.movedTo
        takeOverCrewMember(state, start, agentId, context.now, target => removeAgent(target))
        // The move is timed from the keeper's pick to this takeover (crewTimes.ts, task #3462), once it took the member over.
        const timed = move && state.agents.find(a => a.id === agentId)?.movedFrom?.agentId === start.request.crewMoveOf
          ? moveTimingRow(state, agentId, move.at, move.reason, context.now) : null
        if (timed) effects.messages.push(timed)
      }
      if (start.request.leadFor) {
        if (switchId && switchSource) {
          const project = projectOf(state, start.request.leadFor.projectId)
          const pool = state.machines?.find(m => m.machineId === start.request.machineId)
          group.leadId = agentId
          switchSource.switchLanded = { id: switchId, requestedBy: switchSource.switchRequest!.requestedBy, candidateAgentId: agentId }
          delete switchSource.switchRequest
          project.lead = { status: 'started', machineId: start.request.machineId, machineName: pool?.name ?? start.request.machineId }
        } else {
          // Taking over from a Lead that left, as agent.add does.
          if (group.leadId && !group.agentIds.includes(group.leadId)) keepLead(group, agentId)
          // The people's to read: it answers the start a person asked for, whose "Waiting for a machine" line they read.
          const joined = leadJoined(state, start, group, agentId)
          message(group.id, joined.text, [], null, joined.source)
          if (group.leadId === agentId) arrived(projectOf(state, start.request.leadFor.projectId), agentId)
        }
      }
      // Naming who started it, as any agent added to a chat is named with who added it (#2207).
      else {
        const starter = actorLabel(state, start.actorKey)
        const joined = starter ? `${starter} added ${quotedName(start.request.name)}.` : `${quotedName(start.request.name)} joined.`
        message(group.id, `${joined} ${start.poolGeneration ? 'Preparing its model.' : 'Ready for an assignment.'}`, [], null, bookkeeping(group.id, SYSTEM_ROW))
      }
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
      // The new account is not limited: only a switch that kept the engine and the account leaves the limit mark.
      // The account is what the host reports; without it, a new engine means its default and the same engine keeps the account.
      const engineChanged = command.configuration.engine !== target.configuration?.engine
      // Compared as stored: the default account is absent whether it is reported as 'default' or by its id.
      const engine = command.configuration.engine
      const landed = storedProfileId(target.machineId, engine, command.profileId ?? (engineChanged ? undefined : target.profileId))
      if (engineChanged || landed !== storedProfileId(target.machineId, target.configuration?.engine ?? engine, target.profileId)) {
        target.limitedUntil = null
        target.alerting = target.alerting?.filter(a => a !== 'limit')
      }
      moveToProfile(target, engine, landed)
      // Whatever request was pending is settled; its result, when it comes, is still the one line the chat gets.
      if (target.switchRequest) target.switchLanded = { id: target.switchRequest.id, requestedBy: target.switchRequest.requestedBy }
      delete target.switchRequest
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
      // Swarm v4 (anh Dee 2026-11-09): only its person stops an agent; no agent stops another.
      if (command.decision === 'stop' && actor.kind === 'agent' && actor.agentId !== target.id) fail('PERSON_STOPS', 'Only its person stops an agent.', 403)
      // A Regular agent between tasks is in no project: its person, or the Swarm's owner, releases it (task #4116).
      if (agentProjectId(state, target) === NO_PROJECT && !(actor.kind === 'person' && [state.ownerId, target.contributorId].includes(actor.userId))) {
        fail('FORBIDDEN', 'Only its person or the tab owner can release this agent.', 403)
      }
      const project = agentProjectId(state, target) === NO_PROJECT ? undefined : projectOf(state, agentProjectId(state, target))
      const isOwner = actor.kind === 'person' && [state.ownerId, target.contributorId].includes(actor.userId)
      if (project && !projectAgent(state, actor, project.id) && !isOwner) fail('FORBIDDEN', 'Only an agent of this project, the contributor or tab owner can release a worker.', 403)
      protectLead(state, target.id, actor)
      // Only its own active work holds a decision back, not the active work of a task it sits in.
      if (state.conversations.some(c => activeWork(c) && c.assignment?.agentId === target.id)) fail('WORK_ACTIVE', 'Finish active work before releasing this worker.')
      // A session a person shared by hand is its host's to close on a stop: of the other agents, only the coordinator releases
      // it. Any agent of the project releases one the Swarm started, which alone records its session (security review L5;
      // tidy.ts reads the same mark).
      if (actor.kind === 'agent' && actor.agentId !== target.id && !target.startedSession && ledProject(state, actor.agentId)?.id !== project?.id) {
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
    case 'agent.switchClaim': {
      const target = agent(state, command.agentId)
      if (actor.kind !== 'agent' || actor.agentId !== target.id || target.switchRequest?.id !== command.switchId || switchExpired(target.switchRequest, context.now)) {
        fail('STALE_SWITCH', 'Only the execution host can claim the current switch.', 403)
      }
      // Covers #2493's 3 minute prepare and 10 minute create limits. A second claim gets the same lease back, never a longer one.
      target.switchRequest.claimedUntil ??= new Date(context.now + SWITCH_LEASE_MS).toISOString()
      result.leaseId = operationId
      result.expiresAt = Date.parse(target.switchRequest.claimedUntil)
      break
    }
    case 'agent.switchHandoff': {
      const target = agent(state, command.agentId)
      const request = target.switchRequest
      if (actor.kind !== 'agent' || actor.agentId !== target.id || request?.id !== command.switchId
        || switchExpired(request, context.now) || !request.claimedUntil || Date.parse(request.claimedUntil) <= context.now) {
        fail('STALE_SWITCH', 'Only the source host can hand off the current PM switch.', 403)
      }
      if (!/^[0-9a-f]{32}$/.test(command.handoffChangeId) || Buffer.byteLength(command.note, 'utf8') > 32_000) {
        fail('HANDOFF_INVALID', 'This PM handoff is too large or invalid.', 400)
      }
      const start = state.starts?.find(candidate => candidate.request.leadFor?.switchId === command.switchId
        && candidate.request.machineId === request.targetMachineId)
      if (!start || start.error || start.harnessId) fail('STALE_SWITCH', 'This PM switch no longer has a pending destination.', 409)
      if (start.request.handoffNote !== undefined) {
        if (start.request.handoffNote !== command.note || start.request.handoffChangeId !== command.handoffChangeId) {
          fail('HANDOFF_EXISTS', 'This PM switch already has a different handoff.', 409)
        }
        break
      }
      start.request.handoffNote = command.note
      start.request.handoffSourceAgentId = target.harnessId
      start.request.handoffChangeId = command.handoffChangeId
      break
    }
    case 'agent.switchResult': {
      const target = agent(state, command.agentId)
      // agent.rebind clears a request whose new session started but keeps its id, so the result of either is the one to answer.
      if (actor.kind !== 'agent' || actor.agentId !== target.id || ![target.switchRequest?.id, target.switchLanded?.id].includes(command.switchId)) {
        fail('STALE_SWITCH', 'Only the execution host can report the current switch.', 403)
      }
      const landed = target.switchLanded?.id === command.switchId ? target.switchLanded : undefined
      const promoted = landed?.candidateAgentId ? state.agents.find(candidate => candidate.id === landed.candidateAgentId) : undefined
      const project = ledProject(state, target.id) ?? (promoted ? ledProject(state, promoted.id) : undefined)
      // A rebind already moved the PM: a failure the host reported as it landed is not what happened.
      const moved = command.ok || !!landed
      if (moved && !landed && target.switchRequest) moveToProfile(target, target.switchRequest.engine, target.switchRequest.profileId)
      delete target.switchRequest
      delete target.switchLanded
      if (!project) break
      const error = command.error?.replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/[.\s]+$/, '')
      const running = moved && promoted ? promoted : target
      const engine = ENGINE_NAMES[running.configuration?.engine ?? ''] ?? 'its engine'
      effects.messages.push({ id: operationId, conversationId: project.leadConversationId, author: sender, replyTo: null, recipients: [], source: SYSTEM_ROW,
        text: moved ? `PM moved to ${engine}.`
          : `Couldn't switch the PM: ${error || 'it failed'}. ${command.down ? `It has not come back on ${engine} yet; its machine keeps trying.` : `It is back on ${engine}.`}` })
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
    case 'agent.rename':
      renameAgentTo(state, actor, agent(state, command.agentId), command.name)
      break
    case 'github.relay':
      relayGitHub(state, actor, command, operationId, effects.messages)
      break
    case 'crew.add':
      addCrew(state, actor, agent(state, command.agentId), command.role, command.lane, context.now, (context.projectRules?.rules ?? SEED_RULES).lanes)
      break
    case 'crew.remove':
      removeCrew(state, actor, agent(state, command.agentId))
      break
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
      // A person's removal says so in each of its chats; its host's confirmed stop leaves the member row.
      if (affected.length) announcedRemovals.add(target.id)
      for (const group of affected) {
        const task = group.assignment?.agentId === target.id && activeWork(group)
          ? ` Its task "${group.title}" has no agent now.` : ''
        const lead = group.leadId && group.agentIds.includes(group.leadId) ? group.leadId : null
        // One person can withdraw an agent from several groups. Each notice needs its own durable message ID.
        effects.messages.push({ id: stableId(operationId, 'agent-removed', group.id), conversationId: group.id,
          author: sender, text: `${sender.name.split('@')[0]} removed ${quotedName(target.displayName ?? target.name)} from the Swarm.${task}`,
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
      const member = agent(state, command.agentId)
      sameProject(state, group, member, !command.present)
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
        if (!command.lead) projectChatJoin(group, member.id, member.displayName ?? member.name)
        if (group.audience && ledProject(state, member.id)?.id !== groupProject(state, group).id) {
          fail('AUDIENCE_LEAD_ONLY', 'A private conversation holds only the Lead among agents.', 403)
        }
        // An agent added to a task may work on it, so a teammate's agent is added only where it may take that project's work,
        // as an assignment checks (machines.ts teamWorkCheck).
        requireTeamWork(state, member.machineId, member.contributorId, groupProject(state, group))
        pushedRefusal(group, member)
        requireTeamWrittenAccount(state, group, member)
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
      owner(state, actor)
      const landing = inviteLanding(state, command.conversationId) ?? fail('NO_PROJECT', 'Create a project before inviting people.')
      const email = command.email.trim().toLowerCase()
      if (state.people.some(p => p.email === email)) fail('ALREADY_MEMBER', 'This person is already in the Super Tab.')
      state.invitations = state.invitations.filter(i => i.email !== email)
      state.invitations.push({ id: operationId, email, role: command.role, conversationId: landing, expiresAt: context.now + SWARM_INVITATION_MS })
      result.inviteId = operationId
      break
    }
    case 'invite.revoke':
      owner(state, actor)
      state.invitations = state.invitations.filter(i => i.id !== command.inviteId)
      break
    case 'message.react': {
      // Nothing of a reaction is kept or shown (reactions.ts). A person's is answered as a retired command (the store answers
      // it before this).
      if (actor.kind !== 'agent') {
        Object.assign(result, retiredAnswer().result)
        break
      }
      // An agent's joins it to nothing: only where it already is (project instructions, phase 4), or in its project's chat while it
      // works in the project (River, 2026-11-04, #2924).
      const group = open(state, command.conversationId)
      if (!group.agentIds.includes(actor.agentId)
        && !(projectAgent(state, actor, groupProject(state, group).id) && worksInProjectChat(state, group, actor.agentId))) {
        fail('FORBIDDEN', 'This agent does not participate in the conversation.', 403)
      }
      if (context.reaction?.messageId !== command.messageId) fail('NOT_FOUND', 'This message is unavailable.', 404)
      // It changes nothing anyone sees; it settles what it acknowledges.
      result.changed = command.on
      settleReaction(state, group, actor.agentId, command.messageId, command.on)
      // It is how an agent acknowledges (ACK_ONLY refuses the post), so it settles the agent's delivery of that message.
      if (command.on) effects.settles = { messageId: command.messageId, agentId: actor.agentId }
      break
    }
    case 'message.edit':
      // `command` is the cleaned one (withoutCredentials): the store writes this text, never the one it was sent.
      requireCanChat(state, actor, open(state, command.conversationId))
      result.changed = editMessage(open(state, command.conversationId), actor, command.messageId, command.text, context.messageChange)
      if (result.changed) effects.messageEdit = { messageId: command.messageId, text: command.text }
      break
    case 'message.delete':
      Object.assign(result, { changed: true }, deleteMessage(open(state, command.conversationId), actor, command.messageId, context.messageChange))
      settleDeleted(open(state, command.conversationId), command.messageId)
      break
    case 'member.avatar':
      setMemberAvatar(state, actor, command.avatar)
      break
    case 'agent.avatar':
      setAgentAvatar(state, actor, command.agentId, command.avatar)
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
      // Their approvals still pending are rejected: approval is the membership's, which nobody holds once it leaves, so the task
      // stayed open for good (task #4218). Its PM is told, as a rejection tells it.
      for (const group of state.conversations.filter(c => c.taskApproval?.state === 'proposal' && c.taskApproval.personId === member.id
        && c.taskApproval.generation === member.generation)) {
        rejectTaskApproval(group, REQUESTER_LEFT, context.now)
        effects.messages.push({ id: stableId(operationId, 'approval-left', group.id), conversationId: group.id, author: sender, replyTo: null,
          recipients: group.leadId ? [group.leadId] : [], source: { kind: 'task-approval', state: 'rejected' }, text: `Rejected: ${REQUESTER_LEFT}` })
      }
      // Their projects pass to a remaining member, or are nobody's: rejoining gives none of them back (task #3073).
      dismissPeople(state, new Set([member.id]))
      state.invitations = state.invitations.filter(i => i.email !== member.email)
      // Leaving, or being removed, is final for auto-join: only an invitation or a link brings them back (spec 2026-11-03).
      state.autoJoinDeclined = declinedWith(state, member.id)
      result.removedUserId = member.id
      break
    }
    case 'message.send': {
      const { group, joining } = postable(state, actor, command.conversationId)
      // Posting in its project chat joins it nowhere (postable), so it takes no work there either.
      if (joining) {
        group.agentIds.push(joining)
        teamJoin(groupProject(state, group), joining, group)
      }
      const ids = [...new Set(command.attachmentIds ?? [])]
      const attachments = ids.map(id => context.attachments?.find(a => a.id === id) ?? fail('ATTACHMENT_UNAVAILABLE', 'Upload this file again before sending it.', 400))
      if (!command.text && !attachments.length) fail('TEXT_REQUIRED', 'Write a message or attach a file.', 400)
      // An agent's post that says nothing beyond an acknowledgement is refused: a reaction acknowledges (task #3391). Never a
      // person's, a note to itself, a post with a file or a tag, or an agent's talk with its person.
      if (actor.kind === 'agent' && !command.agentOnly && !attachments.length && !command.mentions?.length
        && group.kind !== 'agent-chat' && isAcknowledgement(command.text)) {
        fail('ACK_ONLY', ACK_ONLY_HINT, 400)
      }
      // A voice message is its clip alone, and its words are its text: what agents, search and older apps read (voiceMessages.ts).
      const voice = attachments.find(a => a.voice)
      if (voice && (attachments.length > 1 || command.text || command.mentions?.length)) {
        fail('VOICE_ALONE', 'Send a voice message on its own, without text, tags or other files.', 400)
      }
      // The text is where tags live, as people tag in chat: each name it says tags that person, if they may read here. A tag
      // picked in an older client (or the CLI's --mention) that the text does not say is written into it, so every client
      // shows the same words. Only from the command, so a retry writes the same text.
      const picked = checkMentions(state, actor, group, command.mentions ?? [])
      // Every username is worked out at once, and only for a post that names or picks someone.
      const names = picked.length || command.text.includes('@') ? swarmUsernames(state) : new Map<string, string>()
      const named = namedIn(state, command.text, names)
      // A tag would tell a person about an agent-only notice they cannot see.
      const mentions = [...new Set([...picked, ...command.agentOnly ? [] : textTags(state, actor, group, named)])].slice(0, MAX_MENTIONS)
      // People talk only to the PM (anh Dee, 11-05; crewNeeds.ts): an agent other than the PM tags only the person it answers,
      // and its other tags go to the PM as a crew need, written after the post below.
      const pmInstead = command.agentOnly ? null : routesToPm(state, actor, group)
      const answering = pmInstead && (command.replyTo || command.answers) && context.reply?.author.kind === 'person' ? context.reply.author.id : null
      const tagged = pmInstead ? mentions.filter(id => id === answering) : mentions
      const routedTags = mentions.filter(id => !tagged.includes(id))
      const unsaid = picked.filter(id => tagged.includes(id) && !named.includes(id) && !saysName(command.text, names.get(id)!))
      const text = voice ? context.voiceWords?.[voice.id] ?? '' : withTags(unsaid.map(id => `@${names.get(id)}`), command.text)
      if (command.replyTo && (!context.reply || context.reply.id !== command.replyTo || context.reply.conversationId !== group.id)) {
        fail('INVALID_REPLY', 'Reply to a message in this conversation.', 400)
      }
      // An answer below a message is read as its reply is (store.ts): context.reply is the message it answers.
      if (command.answers && (command.replyTo || !context.reply || context.reply.id !== command.answers || context.reply.conversationId !== group.id)) {
        fail('INVALID_ANSWER', command.replyTo ? 'Answer a message right below it or reply in its thread, not both.' : 'Answer a message in this conversation.', 400)
      }
      const chatPost = actor.kind === 'agent' && !command.agentOnly && isProjectChat(state, group)
      const chatAsk = chatPost ? requireChatPost(group, command, context.reply) : null
      const chatAnswer = chatPost ? requireChatAnswer(group, command, context.reply) : null
      if (chatPost && inMainChat(command, context.reply)) {
        requireChatContent(state, group, command.text)
      }
      // The answer command also keeps its existing guard outside project chats (answers.ts).
      if (command.answer) requireUnanswered(group, (command.answers ?? command.replyTo)!)
      const replyAgent = context.reply?.author.kind === 'agent' ? context.reply.author.id : null
      // An agent's post reaches the agents it names, by --to or by @Name, the agent whose message it answers, and, when it names
      // no one in a task or step, that conversation's current assignee, who owns the room (River's ruling on #2963). Nothing
      // else: an unnamed post stays readable in its conversation. Until 11-04 an unnamed post went to the coordinator, the task's
      // owner or the assignee by five rules, and in a day 402 of 437 agent posts reached the PM as their only recipient though
      // only 1 named it (Ken, #2963). The PM hears an agent's work through its status. An agent is never delivered its own
      // message, except its note to itself: naming only itself, its post is unnamed (final review of phase 1).
      // @Name never turns a post into a refusal: an agent the sender may not name with --to is left out (mayName).
      const poster = actor.kind === 'agent' ? agent(state, actor.agentId) : null
      const textNamed = poster && !command.agentOnly
        ? agentsNamedIn(state, group, command.text, names).filter(id => mayName(state, group, poster, agent(state, id))) : []
      const asked = command.agentOnly || !poster ? command.recipientIds
        : [...new Set([...command.recipientIds, ...textNamed])].filter(id => id !== poster.id)
      // Naming an agent asks it to act, and a re-test is asked this way: a post's default addressee is only told (audit H2). An
      // agent that may not join Team-written work is left out of the post, which goes out without it, and the result names it:
      // refusing the whole post read as being about the sender (Heron21, #3245).
      const barred = poster && !command.agentOnly ? asked.filter(id => !mayName(state, group, poster, agent(state, id))) : []
      const addressed = asked.filter(id => !barred.includes(id))
      const assigned = activeWork(group) ? group.assignment!.agentId : null
      const toAssignee = actor.kind === 'agent' && !command.agentOnly && !asked.length && assigned && assigned !== actor.agentId
        && group.agentIds.includes(assigned) ? assigned : null
      // An agent with work in the project posts in its project chat without joining it (worksInProjectChat): an answer to its
      // line reaches it there too.
      const answeredAgent = actor.kind === 'agent' && !command.agentOnly && replyAgent && replyAgent !== actor.agentId
        && (group.agentIds.includes(replyAgent) || worksInProjectChat(state, group, replyAgent)) ? replyAgent : null
      // A person answering, in the project chat, the line of an agent with work in the project reaches that agent without it
      // joining (River, 2026-11-04, #2924): in its thread alone, as a member's; right below it with the coordinator, whose new
      // ask that may be. No other agent is reached this way.
      const chatWorker = (id: string | null | undefined) => actor.kind === 'person' && !command.agentOnly && id && !group.agentIds.includes(id)
        && worksInProjectChat(state, group, id) ? id : null
      const answered = chatWorker(replyAgent)
      const below = !command.replyTo && context.above?.author.kind === 'agent' ? chatWorker(context.above.author.id) : null
      // An agent's own chat has no Lead: its person talks to that agent.
      const automatic = actor.kind === 'person' ? (isAgentChat(group) ? group.agentIds[0] ?? null
        : answered ?? (replyAgent && group.agentIds.includes(replyAgent) ? replyAgent : group.leadId)) : toAssignee
      // A person's reply to the agent whose assignment here is done reaches the coordinator too, and the agent still (Ken, #3114):
      // his reply under Hawthorn3's "Done" in #3022 reached Hawthorn3 alone, whose work there was over.
      const doneWith = actor.kind === 'person' && automatic && automatic === replyAgent && automatic !== answered
        && group.assignment?.agentId === automatic && group.assignment.status === 'done' && group.leadId && group.leadId !== automatic
        && group.agentIds.includes(group.leadId) ? group.leadId : null
      // An agent the post named and may not be named is no recipient by any route: not the assignee, nor the author it answers.
      let recipients = [...new Set([...addressed, ...answeredAgent ? [answeredAgent] : [], ...(addressed.length ? [] : [below, automatic, doneWith].filter((id): id is string => !!id))])].filter(id => !barred.includes(id))
      for (const id of recipients) {
        // An agent of this project that another agent names from outside the group joins it, so it can read and answer there
        // (joinsProject). A person's message adds nobody: a person adds an agent to a task with conversation.agent.
        if (!group.agentIds.includes(id) && id !== answered && id !== below && id !== answeredAgent) {
          // Swarm v4 (anh Dee 2026-11-08): an agent of the project named in its channel joins it, to read and answer there; the
          // channel is where agents talk (#2207's coordinator-only rule still holds for adding one by hand).
          if (actor.kind !== 'agent' || !(joinsProject(state, group, id) || joinsChannel(state, group, id))) {
            fail('INVALID_RECIPIENT', 'Choose an agent in this conversation.', 400)
          }
          teamJoin(groupProject(state, group), id, group)
          group.agentIds.push(id)
        }
      }
      // A tag would tell a person about a notice they cannot see.
      if (command.agentOnly && (actor.kind !== 'agent' || recipients.length !== 1 || recipients[0] !== actor.agentId || mentions.length)) {
        fail('INVALID_RECIPIENT', 'An agent sends an agent-only notice to itself alone.', 400)
      }
      if (command.notice && !command.agentOnly) fail('VALIDATION_ERROR', 'A skills notice is an agent-only notice to the agent itself.', 400)
      if (command.handoff) {
        if (command.agentOnly || group.audience || group.kind) fail('ASK_HANDOFF_PUBLIC', 'Hand off an ask in a public post to its project agent.', 400)
        handoffAsk(state, group, poster?.id ?? null, command.handoff, addressed)
      }
      // The transcript still accepts a human message while the lead is unavailable. The UI can say why no delivery was created.
      const postText = command.handoff ? `${text}\n\nAnswer message ${command.handoff} in ${groupProject(state, group).leadConversationId} in its thread.` : text
      message(group.id, postText, recipients, command.replyTo, command.agentOnly ? { ...AGENT_ONLY, ...command.notice ? { notice: command.notice } : {} } : undefined, attachments, tagged)
      if (!command.agentOnly) effects.messages.at(-1)!.post = true
      if (command.answers) effects.messages.at(-1)!.answers = command.answers
      // Whom a stuck line in a task tags, with its requester (stuck.ts, task #3915).
      if (actor.kind === 'person' && !command.agentOnly && !group.kind && !group.audience && !isProjectChat(state, group)) noteWriter(group, actor.userId)
      // After the post is marked: the crew need is the server's row for the PM, never a post of its own.
      if (pmInstead && routedTags.length) {
        crewNeed(group, pmInstead, { personIds: routedTags, messageId: operationId, conversationId: group.id }, text)
      }
      if (poster && !command.agentOnly && !recipients.length) effects.result.reachedNoAgent = REACHED_NO_AGENT
      if (barred.length) effects.result.notReached = notReachedLine(barred.map(id => agent(state, id).displayName ?? agent(state, id).name))
      // A recipient whose session is down keeps the delivery queued and reads it when it is back, and nothing else tells its sender
      // the post is waiting. Not an agent-only notice (the sender's own), an agent asleep (it wakes on the message) or one told to stop.
      const away = command.agentOnly ? [] : recipients.filter(id => !agent(state, id).asleep && agent(state, id).workDecision !== 'stop' && downSince(state, agent(state, id), context.now))
      if (away.length) effects.result.offline = offlineLine(away.map(id => agentDisplayName(state.agents, id) ?? agent(state, id).name))
      // A Personal Swarm project chat with no Lead: the message waits for the Lead its person's Desktop starts (task #2633).
      // A Team Swarm's says Not sent, as before.
      const unled = actor.kind === 'person' && !recipients.length && isPersonalSwarm(state) ? groupProject(state, group) : undefined
      if (unled && unled.leadConversationId === group.id && state.projects?.includes(unled) && !(group.leadId && group.agentIds.includes(group.leadId))) {
        leadWaits(unled, operationId, context.now)
      }
      // The message that makes it LOOP_NOTICE_AT in a row between two agents tells their Lead, once; delivery is never held.
      const speaker = poster
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
      recordPost(state, group, actor, { replyTo: command.replyTo ?? command.answers ?? null, text, reply: context.reply }, context.now)
      // What the PM owes (pulse.ts): a person's message that reached it, settled by its answer in the message's place.
      if (!command.agentOnly) {
        const sent = effects.messages.find(m => m.id === operationId)!
        const root = command.replyTo && context.reply && !context.reply.agentOnly ? context.reply.thread ?? context.reply.id : null
        if (actor.kind === 'person') {
          owe(state, group, { id: sent.id, author: sent.author, recipients, thread: root, source: sent.source }, context.now)
          if (isProjectChat(state, group)) recordChatAsk(group, sent.id, context.now)
        }
        else {
          const owedBefore = group.owed ?? []
          settleReply(state, group, actor.agentId, { answers: command.answers ?? null, thread: root })
          const settled = owedBefore.filter(ask => !group.owed?.some(left => left.id === ask.id))
          // The PM's answer is recorded for the asks it settled, and for the message `answer` names though nobody owed it.
          const asked = command.answer && leadsGroup(state, group, actor.agentId) ? [{ id: (command.answers ?? command.replyTo)! }] : []
          recordAnswered(group, [...settled, ...asked.filter(a => !settled.some(s => s.id === a.id))], sent.id, root, context.now)
        }
      }
      if (chatPost) {
        recordChatPost(group, chatAsk, operationId)
        const root = command.replyTo && context.reply && !context.reply.agentOnly ? context.reply.thread ?? context.reply.id : null
        recordChatAnswer(group, chatAnswer, operationId, root, context.now, context.reply?.createdAt ?? context.now)
      }
      if (actor.kind === 'agent') renewOwnTask(state, group, actor.agentId, context.now)
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
        requireCanChat(state, actor, group)
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
      // Candidates that cannot take the work (another person's computer, task #4120) leave the decision for its
      // exclusions, with why, so the Lead and people see it. A pick among them is left out too and the record keeps no pick, so
      // the coordinator chooses among the rest by the Routing rules: refusing the whole route stopped every PM (task #4194).
      const starter = actor.kind === 'agent' ? agent(state, actor.agentId).contributorId : actor.userId
      const refusals = new Map(command.decision.candidates.flatMap(c => {
        const refusal = candidateRefusal(c, command.conversationId, starter)
        return refusal ? [[c.id, refusal] as const] : []
      }))
      // A route is refused only once it has no candidate left to choose.
      const [firstRefusal] = refusals.values()
      if (firstRefusal && refusals.size === command.decision.candidates.length) failTeamWork(firstRefusal, ' Route again.')
      const { pick: sentPick, ...unpicked } = command.decision
      const decision = !refusals.size ? command.decision : { ...(sentPick !== undefined && refusals.has(sentPick) ? unpicked : command.decision),
        candidates: command.decision.candidates.filter(c => !refusals.has(c.id)),
        excluded: [...command.decision.candidates.flatMap(c => refusals.has(c.id) ? [{ title: c.title, reason: refusals.get(c.id)!.reason }] : []),
          ...command.decision.excluded].slice(0, 200) }
      // With no pick the coordinator chooses at the start or assignment, which checks its agent then.
      const chosen = decision.pick === undefined ? undefined : decision.candidates.find(c => c.id === decision.pick)!
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
      // The row quotes the Lead's reason for the task; the verdict's own text stays in the decision record. A route that names no
      // pick posts none: its start or assignment posts the row naming the candidate chosen (linkDecision).
      const reason = decision.assessment.why
      if (chosen) message(command.conversationId, `Routed to ${chosen.title} — ${via} · "${reason}"`, [], null, bookkeeping(command.conversationId, {
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
      // A route that names no pick (task #2901) has no choice until a person or a start makes one.
      const current = decision.override?.candidateId ?? decision.final?.candidateId ?? decision.record.pick
      const chosen = decision.record.candidates.find(c => c.id === command.candidateId) ?? fail('NOT_FOUND', 'Choose one of this decision’s candidates.', 404)
      if (current !== undefined && chosen.id === current) fail('ALREADY_CHOSEN', 'That candidate is already the choice.')
      if (chosen.kind === 'member' && !state.agents.some(a => a.id === chosen.agentId)) fail('CANDIDATE_UNAVAILABLE', 'That agent left this Super Tab. Choose another.')
      // Its machine may have stopped showing its privacy since the route; the group's Lead is who would start it.
      const leadId = conversation(state, decision.conversationId).leadId
      const teamRefusal = candidateRefusal(chosen, decision.conversationId, state.agents.find(a => a.id === leadId)?.contributorId ?? actor.userId)
      if (teamRefusal) failTeamWork(teamRefusal)
      effects.routeDecisions.push({ op: 'override', id: decision.id, override: { by: 'person', actorKey: actorKey(actor), candidateId: chosen.id, reason: command.reason } })
      const lead = conversation(state, decision.conversationId).leadId
      message(decision.conversationId,
        // By name, never email: the PM reads this row (review of #2954).
        `${agentWrittenNameOf(state, actor.userId) ?? 'Someone'} chose ${chosen.title}${current === undefined ? '' : ` instead of ${routeTitle(decision, current)}`}. Reason: ${command.reason}`,
        lead ? [lead] : [], null, { kind: 'route-override', decisionId: decision.id, by: 'person' })
      break
    }
    case 'work.teamWritten': {
      // Only on the server's own read: a refused command rolled its mark back (store.ts execute), and no client's word marks a task.
      if (context.pushOrigin !== 'team') fail('NOT_FOUND', 'This conversation is unavailable.', 404)
      const group = open(state, command.conversationId)
      marking(group, () => applyPushOrigin(state, group, 'team', context.pushOriginPulls))
      break
    }
    case 'member.approvalMode': {
      if (actor.kind !== 'person') fail('TASK_APPROVAL_FORBIDDEN', 'Choose your mode as a person.', 403)
      if (command.mode === 'autoApprove' && !mayAcceptAll(state, actor.userId)) fail('ACCEPT_ALL_SUBSCRIPTION', ACCEPT_ALL_REFUSAL, 409)
      person(state, actor.userId).approvalMode = command.mode
      break
    }
    case 'task.suggest': case 'task.approve': case 'task.reject': {
      const group = authorizeTaskApproval(state, actor, command.type, command.conversationId)!
      const approval = command.type === 'task.suggest' && group.taskApproval?.state === 'approved' && !group.assignment
        ? group.taskApproval : pendingTaskApproval(group)
      if (group.archived) fail('ARCHIVED', 'Reopen this conversation before deciding its work.')
      if (command.type === 'task.suggest') {
        const worker = readAgent(state, actor, command.agentId)
        assignRefusal(group, worker)
        approval.suggestedAgentId = worker.id
        // A new worker choice never inherits an earlier decision, even before the first assignment.
        approval.state = 'proposal'
        delete approval.decidedAt
      } else {
        if (command.type === 'task.approve' && undecidedProposal(group))
          fail('PROPOSAL_UNDECIDED', 'Approve the task once the PM has accepted or reshaped this proposal.', 409)
        // A suggestion that moved between the person's look and their tap is not what they approved.
        if (command.type === 'task.approve' && command.suggestedAgentId !== undefined && command.suggestedAgentId !== (approval.suggestedAgentId ?? null)) {
          fail('TASK_SUGGESTION_CHANGED', 'The suggested agent changed since you looked. Read the task again and approve the agent it names now.', 409)
        }
        if (command.type === 'task.reject') rejectTaskApproval(group, command.reason, context.now)
        else {
          approval.state = 'approved'
          approval.decidedAt = context.now
          // Their first Accept in this project starts their Member there, in a chat of its own with them.
          startMember(group, approval.personId)
        }
        // This decision releases the gate and assigns nothing: no command assigns work since Swarm v4 (work.assign is retired).
        if (command.type === 'task.approve' && approval.suggestedAgentId) {
          if (!state.agents.some(a => a.id === approval.suggestedAgentId)) {
            fail('SUGGESTED_AGENT_GONE', 'The agent suggested for this task is gone. Ask the PM to suggest another.', 409)
          }
          assignRefusal(group, readAgent(state, actor, approval.suggestedAgentId))
        }
        message(group.id, command.type === 'task.approve' ? 'Approved.' : `Rejected: ${command.reason}`,
          group.leadId ? [group.leadId] : [], null, { kind: 'task-approval', state: approval.state })
      }
      result.conversationId = group.id
      break
    }
    case 'agent.setUp': {
      // Only the Member itself, of that project, from its own host.
      if (actor.kind !== 'agent') fail('FORBIDDEN', 'A Member reports its own set-up.', 403)
      const self = agent(state, actor.agentId)
      if (!self.regular || self.mainProjectId !== command.projectId) fail('NOT_MEMBER', 'Only this project\'s Member reports its set-up.', 403)
      if (command.ok ? !command.steps || command.reason !== undefined : !command.reason || command.steps !== undefined) {
        fail('INVALID_SET_UP', 'Report the steps that set it up, or why it failed.', 400)
      }
      self.setUp = { projectId: command.projectId, at: context.now, ...(command.ok ? { steps: command.steps! } : { failed: command.reason! }) }
      // A failed set-up is seen by its person, in their agent's chat (AGENTS.md: nothing fails silently).
      const chat = state.conversations.find(c => c.kind === 'agent-chat' && c.agentIds.includes(self.id))
      if (!command.ok && chat) message(chat.id, `Could not set up ${projectOf(state, command.projectId).name}: ${command.reason}`, [], null, SYSTEM_ROW)
      break
    }
  }
  // The state of the task this command touched, in its own write (liveness.ts recordTaskState).
  const touched = 'conversationId' in command ? command.conversationId : command.type === 'agent.start' ? command.request.conversationId
    : 'startId' in command ? state.starts?.find(s => s.id === command.startId)?.request.conversationId : undefined
  const task = typeof touched === 'string' ? state.conversations.find(c => c.id === touched) : undefined
  if (task) recordTaskState(state, task, context.now)
  if (command.type === 'conversation.create') {
    alertOverlaps(conversation(state, result.conversationId as string))
  }
  for (const target of original.agents.filter(a => a.workDecision === 'stop')) {
    const acknowledged = command.type === 'swarm.delete' || command.type === 'agent.remove' && command.agentId === target.id &&
      (actor.kind === 'agent' && actor.agentId === target.id || actor.kind === 'person' && [state.ownerId, target.contributorId].includes(actor.userId))
    if (!acknowledged && !state.agents.some(a => a.id === target.id)) fail('STOP_REQUESTED', 'Wait for the execution host to finish stopping its workers before withdrawing them.')
  }
  if (context.registrations) requireSingleRegistration(original, state, context.registrations)
  markConfidential(state)
  assignAgentDisplayNames(state.agents)
  keepUsernames(original, state)
  // Every agent added to or removed from a chat leaves a row there naming who did it (Ken, #2207), for the chat's readers and
  // waking nobody. A start's own line names its starter (agent.started).
  // Not for a removal this command already said in each chat, nor for a Swarm being deleted.
  const membership = command.type === 'agent.started' || command.type === 'swarm.delete' ? []
    : memberChanges(original, state).filter(c => !announcedRemovals.has(c.agent.id) || state.agents.some(a => a.id === c.agent.id))
  if (membership.length) {
    const by = { id: actor.kind === 'agent' ? actor.agentId : actor.userId, label: actorLabel(state, actorKey(actor)) ?? who }
    for (const { group, agent: member, added } of membership) {
      effects.messages.push({ id: stableId(operationId, 'member', group.id, member.id), conversationId: group.id, author: sender,
        text: memberRowText(by, { id: member.id, name: member.displayName ?? member.name }, added), replyTo: null, recipients: [], source: SYSTEM_ROW })
    }
  }
  // The size limit is per stored part now (parts/commit.ts PART_LIMIT_BYTES); a Swarm as a whole has none.
  // Every row this command writes, whatever its words came from: an older message resent, a rule written before this check.
  for (const draft of effects.messages) {
    const clean = redactCredentials(draft.text)
    if (clean.removed.length) { draft.text = clean.text; removed.push(...clean.removed) }
  }
  if (removed.length) Object.assign(result, credentialResult(removed))
  for (const draft of effects.messages) {
    const group = state.conversations.find(c => c.id === draft.conversationId)
    if (group) bindPullRequestCards(group, draft, groupRepositoryUrl(state, group))
  }
  assertUniqueMessageIds(command.type, effects.messages)
  return effects
}

/** Refuses [work] its project's machine rules refuse now, with the rule's own why. A command whose record was not read
 *  (none in its context) meets no rule. */
function refuseByMachineRules(context: CommandContext, work: { machineId: string; engine: string; review: boolean }): void {
  const why = machineRuleRefusal(context.projectRules?.rules.machines ?? [], work, context.now)
  if (why) fail('MACHINE_RULE', why, 409)
}

/** Reject an invalid command result before the store tries to write duplicate message keys. */
export function assertUniqueMessageIds(commandType: string, messages: Array<{ id: string }>): void {
  const ids = new Set<string>()
  for (const draft of messages) {
    if (ids.has(draft.id)) throw new SuperTabError('DUPLICATE_MESSAGE_ID', `Command ${commandType} produced duplicate message IDs.`, 400)
    ids.add(draft.id)
  }
}

/** A contribution owns capacity independently of membership. Reuse invalidates every prior stop proof. */
export { swarmGridName } from './model.js'

export function reserveHarnessSlot(state: SuperTabState, machineId: string, harnessId: string, generation: string) {
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
