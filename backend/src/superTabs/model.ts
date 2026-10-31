import { createHash } from 'node:crypto'
import { cloneData } from './cloneData.js'
import { lostReasonWithoutMachine } from './lostReason.js'
import type { RouteDecisionEffect } from './routeRecord.js'
import { agentDisplayName, assignAgentDisplayNames } from './agentNames.js'
import { withAvatarView } from './profile.js'
import { swarmUsernames } from './usernames.js'
import { downSince, expireRemovals, startPreparing } from './machines.js'
import { publicReason, readsRawReason } from './startFailure.js'
import { FIRST_INSTRUCTIONS } from './instructions.js'
import { agentProjectId, agentSetRole, canReadAgent, canReadGroup, canReadProject, groupProject, ledProject, placeRules, projectsOf, sharedWithLeads, skillSetOf, type ProjectVisibility, type SwarmProject } from './projects.js'

export type Role = 'owner' | 'collaborator' | 'viewer'
export interface Person {
  id: string
  email: string
  role: Role
  generation: string
  /** Their own short status (profile.ts); only Swarm members read it. */
  status?: import('./profile.js').PersonStatus
  /** Their own avatar (profile.ts); only Swarm members read it. */
  avatar?: import('./profile.js').Avatar
  /** The name they chose (usernames.ts), or one kept for them; absent, readers work out their default. Only members read it. */
  username?: string
}
export interface AgentConfiguration {
  engine: string
  model: string | null
  effort: string | null
  contextWindow: number | null
  engineVersion: string | null
}
export interface Agent {
  id: string
  projectId?: string
  machineId: string
  harnessId: string
  machineOwnerId: string
  contributorId: string
  membershipGeneration: string
  hostGrant?: string | null
  name: string
  /** A stable member name; native session and routing names remain in `name`. */
  displayName?: string
  /** The kind an older client started or added it as, kept for older readers. Absent reads as builder (agentRole); the Lead
   *  is derived from leadId. It decides nothing (project instructions, phase 4): roleNameOf names an agent without a role
   *  name by it. */
  role?: AgentRole
  /** The custom role an older client started, added or assigned it in, kept for older readers (projects.ts agentSetRole). */
  roleId?: string | null
  /** The role it was started in, free text from the project's instructions (project instructions, phase 2). The server checks
   *  nothing against them. Absent on agents from before: reads name one by what it is (instructions.ts roleNameOf). */
  roleName?: string
  /** `awaiting`: its task's work ended (finishWorker), shown and read by no command; `keep` and `stop`: asked for
   *  (agent.release, tidy.ts). Kept when its group receives a new brief. */
  workDecision?: 'awaiting' | 'keep' | 'stop'
  /** When its Lead last decided keep: a kept worker is idle from then (tidy.ts). */
  keptAt?: number
  /** When its last idle spell began, once its coordinator was told of it (tidy.ts idleNotices): one notice per spell. */
  idleNoticedAt?: number
  /** Set while its stop was the server's idle stop, written before project instructions (phase 4: idle agents are a notice),
   *  with the decision it had before: its host withdraws that stop when the session's folder has changes by the time it would
   *  close it (agent.stopRefused). */
  idleStop?: { previous: 'awaiting' | 'keep' | null }
  releaseId?: string
  /** Captured from the original Swarm launch, never inferred from a later live session with the same id. */
  startedSession?: { creationId: string; sessionId: string; createdAt: string }
  /** The model on the Swarm's grid its start named, which its engine never reports. Kept here because a command does not
   *  load a finished start (parts/load.ts loadActive), and the leaderboard counts every assignment by it (review of #1808). */
  gridModel?: string
  /** Its start named no model, so it runs its engine's own: rated by the policy's `default` row for life (rules.ts
   *  agentTarget). Kept here for the same reason as [gridModel]: a command never sees the finished start (live bug 10-29). */
  launchedDefault?: true
  configuration: AgentConfiguration
  /** The last configuration operation fences delayed observations, including re-contribution. */
  configurationVersion?: string
  /** Fences a repeated Change agent report without rolling back later model observations. */
  replacement?: { previousHarnessId: string; harnessId: string }
  /** When a reading first showed its session gone or its host confirmed a stop; cleared when it is back (machines.ts). */
  downSince?: string
  /** Written by the two-hour down wake-up that lost work replaced (liveness.ts); older states may still carry it, never shown. */
  downNamed?: string
  /** Its last task was lost (liveness.ts): routing leaves it out, even once that task is cancelled or reassigned, until it
   *  finishes a new task, a person assigns it work by hand, or its terminal is replaced (commands.ts). */
  lostTask?: { conversationId: string; assignmentId: string; reason: string; at: number; resumeAt?: string }
  /** A usage limit seen on its terminal; routing skips the agent until then. Shown as null once passed (terminal.ts). */
  limitedUntil?: string | null
  /** Terminal alert episodes in progress, so each one posts a single row (terminal.ts). */
  alerting?: Array<'prompt' | 'limit' | 'model'>
  /** Set once its session is a Lead or in a private conversation, and kept until the session leaves: nobody but its
   *  machine's person watches it (projects.ts canWatchAgent). */
  confidential?: true
  /** Set by its contributor or its project's Lead (profile.ts); absent shows the pattern Desktop draws from its name. */
  avatar?: import('./profile.js').Avatar
  /** A Buddy (buddies.ts): the person it brainstorms with, at the membership they added it in. Its role stays a builder's
   *  for older readers; this is what makes it a Buddy, and what refuses it every command but its own chat and proposals. */
  buddyOf?: { personId: string; generation: string }
  /** A Buddy that reads every project its person reads (buddies.ts; Dee, 10-31): the main Buddy of a Swarm Buddy chat, or a
   *  plain session there. It has no project and writes nowhere but its own chat. A project session has its project instead. */
  buddyScope?: 'swarm'
  /** A Buddy that reads one project and writes into it (Dee, 10-31): a project session, or the one Buddy's session in an older
   *  project chat. Its host never widens its reads beyond its folder (cli buddyGuard wide mode), which could hold another
   *  project's clone. */
  buddyNarrow?: true
  /** A Buddy's thread session (buddySessions.ts): it hears and answers only the thread rooted at `thread`, and reads the main
   *  chat only up to `from`, the sequence before the message that started it. The main Buddy has none. */
  buddySession?: BuddySession
  /** Joined on a Harness Team account's machine: kept, so a machine row that went never brings back the rules of an
   *  ordinary machine (projects.ts teamSessionAccess, security re-review of #2089). */
  teamAccount?: true
}
/** A thread session's thread root and the main chat's last sequence it may read (buddySessions.ts). A project session also
 *  names its project (buddies.ts; Dee, 10-31): it reads that project alone, and is the only Buddy that writes into it. */
export interface BuddySession { thread: string; from: number; projectId?: string }
/** A Buddy chat's live or starting thread session, at most MAX_BUDDY_SESSIONS (buddySessions.ts). `agentId` once it runs;
 *  `waiting`, the person's messages sent while it started, delivered to it when it joins. */
export interface BuddySessionEntry { thread: string; startId: string; agentId?: string; at: number; waiting?: string[] }
export type AgentRole = 'builder' | 'reviewer'
export const agentRole = (agent: Pick<Agent, 'role'>): AgentRole => agent.role ?? 'builder'
export interface AgentStartRequest {
  conversationId: string
  role?: AgentRole
  roleId?: string
  /** The agent's role name (Agent.roleName), kept on it once it starts. */
  roleName?: string
  machineId: string
  engine: string
  model?: string
  effort?: string
  name: string
  cwd: string
  worktree: boolean
  branchRef?: string
  permissionMode?: string
  codexHome?: string
  gridModel?: string
  gridName?: string
  /** The heavy work the task declared it runs on its machine (a heavy build, end-to-end tests): later routes count such a start
   *  on its machine for a few minutes, before the machine's reading shows it (cli superTabs/machineFit.ts, Scholes's goals,
   *  piece 5). Its requirements ask only the least the work runs with, so this says what it is. */
  heavy?: Array<'build' | 'e2e'>
  requirements: { memoryBytes: number; diskBytes: number; maxCpuPercent: number; tools: string[]; devices: string[]; quotaRequired: boolean }
  /** A Buddy's start (buddies.ts): written by buddy.create alone, never taken from an agent.start. */
  buddyOf?: { personId: string; generation: string }
  /** A Swarm-wide Buddy's start (Agent.buddyScope), written by buddy.create or message.send alone. */
  buddyScope?: 'swarm'
  /** A one-project Buddy's start (Agent.buddyNarrow), written by message.send alone. */
  buddyNarrow?: true
  /** The person's messages in an older project chat its start waits on, delivered when it joins (ids only). */
  buddyWaiting?: string[]
  /** The projects a Swarm-wide Buddy's folder holds, one read-only worktree each, made from that project's own checkout on its
   *  machine (spec: Folder). Ids, names and folders only. */
  buddyProjects?: Array<{ id: string; name: string; cwd: string }>
  /** A Buddy thread session's start (buddySessions.ts): written by message.send with newSession alone. Ids only, never text:
   *  starts are listed to the Lead. */
  buddySession?: BuddySession
  /** A project's Product Manager's start (leadStart.ts): written by lead.start alone, never taken from an agent.start. Its
   *  agent becomes the Lead of the project's Lead conversation once it runs. */
  leadFor?: { projectId: string; personId: string; generation: string }
}
export interface AgentStart {
  poolGeneration?: string
  poolSettled?: boolean
  routeDecisionId?: string
  id: string
  creationId: string
  actorKey: string
  contributorId: string
  membershipGeneration: string
  machineOwnerId: string
  hostGrant: string | null
  request: AgentStartRequest
  harnessId: string | null
  dispatched: boolean
  /** When its host was asked to launch it; a start not running 3 minutes later fails, or 15 minutes later while its machine
   *  reports it preparing (liveness.ts). */
  dispatchedAt?: number
  /** The CLI version its machine's daemon had connected with when it was dispatched (store.ts machineFacts): a failed start
   *  says nothing about that machine once it runs another version (cli routeCommand.ts `stalled`). */
  dispatchedVersion?: string
  /** When it was asked for (absent on starts from before 2026-10-29): a Buddy's fails if its machine never takes it, and a
   *  task's start never launched leaves the task orphaned (liveness.ts). */
  requestedAt?: number
  /** On reads only, never stored: its machine's fresh report says it is preparing (machines.ts startPreparing). */
  preparing?: true
  error: string | null
}
/** `needs_human`: the agent needs a person's decision (its result is the question). `blocked`: it cannot go on (its result
 * says why). Both stay active work; the machine running the agent alerts its Harness Pro (cli/src/superTabs/attention.ts).
 * `lost`: its agent died, stalled or hit a limit (liveness.ts); no longer active, so the Lead assigns it again or cancels it. */
export type WorkStatus = 'planned' | 'working' | 'needs_human' | 'blocked' | 'review' | 'done' | 'stopped' | 'cancelled' | 'reconciling' | 'lost'
/** The first line of the system row `work.status` writes for each status an agent sets (commands.ts); catchUp.ts reads it back. */
export const STATUS_LABELS = { working: 'Working', needs_human: 'Needs a human', blocked: 'Stuck', review: 'Ready for review', done: 'Done',
  stopped: 'Stopped' } as const satisfies Partial<Record<WorkStatus, string>>
export interface Check {
  id: string
  description: string
  independent: boolean
  evidence: string | null
  passedBy: string | null
}
export interface Assignment {
  id: string
  agentId: string
  status: WorkStatus
  configuration: AgentConfiguration
  execution: { machineId: string; harnessId: string; machineOwnerId: string }
  result: string | null
  /** Explicit progress fences delayed recording gaps; absent on older backends. */
  recordingProgress?: { at: number; revision: number }
  /** Its agent owns it until then; progress renews it (liveness.ts). Absent on assignments from before leases. */
  leaseUntil?: number
  /** Its agent's last progress the lease saw, for the Lead's wake-up when it is lost. */
  progressAt?: number
  /** While it needs a human: the person its agent asked (work.status with ask), whom its wait names (liveness.ts). */
  askedOf?: string
  /** When someone else's verdict found problems in a working hand-off of the older built-in skills, which then stops waiting
   *  for its review (liveness.ts waitingForReview). Its next status clears it. */
  reviewFoundAt?: number
  /** A two-review task's hand-overs and reviewers' verdicts, from the automatic reviews (#2382) before project instructions;
   *  never written since (phase 4: the server opens and counts no review), kept on older rows. */
  handoffs?: number
  verdicts?: ReviewVerdict[]
  /** Why and when it was lost (status `lost`); after a usage limit whose screen gave a reset time, when its own agent may
   *  take it back (work.resume) unless it was handed on first. */
  lost?: { reason: string; at: number; resumeAt?: string }
}
/** One reviewer's (actorKey) verdict on a two-review task's independent checks, on an older row (Assignment.verdicts). */
export interface ReviewVerdict { by: string; passed: boolean; handoff: number; review?: string }
/** The hand-over an automatic review of a two-review task was opened for, on an older row (Conversation.reviewStamp). */
export interface ReviewStamp { assignmentId: string; handoff: number }
export interface WorkTask {
  goal: string
  changes: string
  constraints: string
  owns: string[]
  requires?: TaskRequirement
  /** What its reviews check first, and how many independent reviews it wants: written into its brief (renderWorkTask), which
   *  whoever opens its review reads. The server opens and counts no review (project instructions, phase 4). */
  review?: ReviewPlan
}
/** A task's review plan (#2382; nightly reflection 10-30: the Lead hand-sent a focus to 20+ reviews that day). `focus` and
 *  `reviews: 2` are said in its brief, so the agent opening its review passes them on (project instructions, phase 4). */
export interface ReviewPlan { focus?: string; reviews?: 1 | 2 }

/** How many independent reviews [task] wants: 2 only when its review plan says so. */
export const reviewsWanted = (task: WorkTask | undefined): number => task?.review?.reviews === 2 ? 2 : 1
/** Where a task can be done at all (2026-10-27: a task to check a device plugged into one person's Mac was routed to another
 *  machine by policy order). `machines`: it runs only there, or on a Mac's Harness Team account of one of them. `devices`:
 *  full paths every start for it asks its machine to check (cli superTabs/capacity.ts). Never in the rendered brief, since
 *  a reader may not see the machine. A reader is handed only the machines they see, and how many others (`unseenMachines`). */
export interface TaskRequirement { machines?: string[]; devices?: string[]; unseenMachines?: number }

/** The machines a reader sees: listed in their visible state, or running an agent they see. */
export const seenMachineIds = (visible: Pick<SuperTabState, 'machines' | 'agents'>): Set<string> =>
  new Set([...(visible.machines ?? []).map(m => m.machineId), ...visible.agents.map(a => a.machineId)])

/** [group] with its requirement as a reader who sees [seen] may read it. The same group read again gives the same result. */
export function withSeenRequirement<T extends Pick<Conversation, 'task'>>(group: T, seen: ReadonlySet<string>): T {
  const requires = group.task?.requires
  if (!requires?.machines?.some(id => !seen.has(id))) return group
  const machines = requires.machines.filter(id => seen.has(id))
  return { ...group, task: { ...group.task!, requires: { ...requires, machines,
    unseenMachines: (requires.unseenMachines ?? 0) + requires.machines.length - machines.length } } }
}

export const TWO_REVIEWS = 'Two independent reviews, each by a different Reviewer.'
export function renderWorkTask(task: WorkTask): string {
  const review = [...task.review?.focus ? [task.review.focus] : [], ...reviewsWanted(task) === 2 ? [TWO_REVIEWS] : []]
  return `Goal:\n${task.goal}\n\nChanges:\n${task.changes}\n\nConstraints:\n${task.constraints}\n\nOwns:\n${task.owns.map(area => `- ${area}`).join('\n')}`
    + (review.length ? `\n\nReview:\n${review.join('\n')}` : '')
}

export interface Conversation {
  id: string
  /** The removed Swarm-wide Leads conversation, still stored in an older Swarm (leadsRemoved), a person's Buddy chat in a
   *  project (buddies.ts), or their one Buddy chat for the whole Swarm, with no project (`swarm-buddy`, buddies.ts
   *  openSwarmBuddyChat; Dee, 10-31): a kind of its own, so an older release parks it unread (parkLaterConversations) instead
   *  of reading it as a project's. Absent on every other conversation. */
  kind?: 'leads' | 'buddy' | 'swarm-buddy'
  projectId?: string
  /** Stable, tab-local workgroup reference. Lead has no number. */
  number?: number
  title: string
  leadId: string | null
  agentIds: string[]
  archived: boolean
  brief: string
  task?: WorkTask
  /** A review group names the group whose work it reviews; only a Reviewer is assigned it, and a Reviewer nothing else. */
  reviewOf?: string
  /** An automatic review's hand-over of a two-review task (#2382); never written since project instructions, phase 4. */
  reviewStamp?: ReviewStamp
  checks: Check[]
  assignment: Assignment | null
  lastMessageSequence: number
  /** The sequence of its newest message in the main stream: a reply only in its thread leaves it (threads.ts). Absent until
   *  this conversation's first message after threads; readers fall back to lastMessageSequence. */
  lastMainSequence?: number
  /** Linked GitHub pull requests, including links older than the latest message page. Absent in older snapshots. */
  pullRequestUrls?: string[]
  /** Its messages drawn as live cards: its task and each linked pull request (cards.ts). Absent until its first card. */
  cards?: import('./cards.js').GroupCards
  /** The last sequence given to a message here. Each conversation numbers its own messages (store by parts). */
  messageSeq?: number
  /** The sequence of its last message that counts toward its project's reports (projectUpdates.ts). */
  reportSeq?: number
  /** Out of first loads and changes: work done or cancelled and quiet for a day, or archived by hand. A message wakes it. */
  dormant?: boolean
  /** When its last message was written (ISO). */
  lastActivityAt?: string
  /** A private conversation: only these people and the project's Lead read it (projects.ts canReadGroup). */
  audience?: import('./parts/types.js').Audience
  /** The last attempt here that was lost: its agent's status and checks for it are refused, even after reassignment. Where it
   *  ran (machine and engine) stays too, so routing the work again avoids that account even once its agent is gone. */
  lostAttempt?: { id: string; agentId: string; machineId?: string; engine?: string }
  /** Counts reaction changes here (reactions.ts), so readers see a new reaction on an older message. */
  reactionSeq?: number
  /** A Buddy chat's owner messages its Buddy already proposed for (buddies.ts): each asks once. */
  proposals?: string[]
  /** The name a Buddy chat's owner chose for their Buddy (buddies.ts renameBuddy): kept here, which outlives the Buddy, so
   *  one added again takes it. Absent: the default, "<person>'s Buddy". */
  buddyName?: string
  /** A Buddy chat's live and starting thread sessions (buddySessions.ts); absent while it has none. */
  buddySessions?: BuddySessionEntry[]
  /** An older project Buddy chat whose person was told their one Buddy cannot start there now (commands.ts buddyDownLine):
   *  told once per outage, so absent again once one can start. */
  buddyDownTold?: true
  /** The person who asked for this work: whoever opened it, or the person its Lead named (leaderboard/record.ts). */
  requesterId?: string
  /** What the leaderboard counts here (leaderboard/record.ts); bookkeeping readers never get whole. */
  ledger?: import('./leaderboard/record.js').GroupLedger
  /** Whether its task is moving, waiting on purpose or stuck, as the time checks last found it (liveness.ts recordTaskStates). */
  liveness?: TaskLiveness
  /** Its last step up from a cheaper model: written when a grid attempt's first review fails (commands.ts reviewFailed, goals
   *  piece 4; before project instructions also by the server's step up). Nothing is cancelled: the route reads it to leave the
   *  grid out of the next attempt, route records carry it for the costs report, and the leaderboard reads it. */
  stepUp?: StepUp
  /** The last route, start or assignment on its task by an agent of its project, or its coordinator's post there (commands.ts). */
  leadAction?: { kind: 'assign' | 'route' | 'start' | 'post'; at: number }
}
/** A step up: the attempt it opened (2 or 3), the least quality from then on, why, when, and what the failed attempt left for
 *  the next one's brief; the failed start that caused it, if one did. */
export interface StepUp { attempt: number; floor: number; reason: string; at: number; carry: string; startId?: string
  /** A route record carries it already (commands.ts route.record): later routes of the task do not, so it counts once. */
  recorded?: true }
/** Absent while its task is working (its agent reported in the last 30 minutes; its last progress is its assignment's
 *  `progressAt`) or there is none. `waiting`: on a person (`personId`), a review, its stated
 *  blocker, the new revision of the build it reviews, or its agent's start. `quiet`: its agent has reported nothing for 30 minutes
 *  (`silent`), or it has been in review for 30 minutes with no linked task open (`review`). `orphaned`: nobody holds it — its
 *  agent was removed or lost it, or its start failed or never launched. `since`: when that began, as first recorded. */
export interface TaskLiveness {
  state: 'waiting' | 'quiet' | 'orphaned'
  why: 'person' | 'review' | 'blocked' | 'revision' | 'queued' | 'starting' | 'silent' | 'removed' | 'lost' | 'start-failed' | 'unstarted'
  since: number
  personId?: string
}

/** The GitHub pull request links in [text], each once, in order. */
export const pullRequestLinks = (text: string): string[] => [...new Set([...text.matchAll(/https:\/\/github\.com\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+\/pull\/([1-9][0-9]*)\b/g)]
  .filter(match => Number(match[1]) <= Number.MAX_SAFE_INTEGER).map(match => match[0]))]

export function appendPullRequestUrls(group: Conversation, texts: Iterable<string | null | undefined>): void {
  const urls = new Set(group.pullRequestUrls ?? [])
  for (const text of texts) if (text) for (const url of pullRequestLinks(text)) urls.add(url)
  group.pullRequestUrls = [...urls]
}
export interface Invitation {
  id: string
  email: string
  role: 'collaborator' | 'viewer'
  conversationId: string
  expiresAt: number
}
export interface SuperTabState {
  version: 1
  id: string
  name: string
  project?: { machineId: string; cwd: string; repositoryUrl: string | null }
  projects?: SwarmProject[]
  /** The removed Leads conversation of an older Swarm, still stored (leadsRemoved); no read sends it. */
  leadsConversationId?: string
  /** Pairs of tasks ("a:b", sorted ids) whose Leads were told their owned code overlaps, so each pair is told once. */
  overlapAlerts?: string[]
  /** Read-only, for a Lead's own reads (visibleState): the active work of the other projects it may know about. */
  otherProjectsWork?: OtherProjectWork[]
  ownerId: string
  /** The Workspace it belongs to (workspaceStore.ts); absent on a Swarm from before Workspaces until the migration gives it one. */
  workspaceId?: string
  /** Who in the Workspace may find and join it by themselves: `workspace` lets members and up join; absent reads as invite-only. */
  workspaceVisibility?: 'invite-only' | 'workspace'
  environment: string
  /** Fields this tab overrides from its owner's account routing policy (routingPolicy.ts). */
  routingPolicy?: import('./routingPolicy.js').RoutingOverride
  /** The owner's routing rules (rules.ts); absent until the first is set. */
  rules?: import('./rules.js').SwarmRule[]
  /** Owner-only sharing configuration; visibleState always removes it. */
  sharing?: import('./sharing.js').SwarmSharing
  paused: boolean
  /** Idle workers stop and finished groups archive by themselves (tidy.ts); false once the owner turns it off. */
  tidy?: false
  /** Buddies (buddies.ts) are on in every Swarm; readers are always told so (visibleState), as apps from before 10-29 hide
   *  Buddies and show Chat with PM without it. A stored value from the old switch is ignored. */
  buddies?: true
  people: Person[]
  agents: Agent[]
  conversations: Conversation[]
  /** Deleting a project never makes its old # references name new work. */
  retiredConversationNumber?: number
  invitations: Invitation[]
  starts?: AgentStart[]
  machines?: import('./machines.js').ContributedMachine[]
  /** Slot claims survive person withdrawal; only host proof for this generation releases them. */
  harnessReservations?: Array<{ machineId: string; harnessId: string; generation: string; renewed: boolean }>
  /** Native stop receipts survive late replaceable machine observations. */
  releasedHarnesses?: Array<{ machineId: string; harnessId: string }>
  /** Sessions of removed agents their host closes, listed to that host until it says they closed (agent.sessionClosed). */
  /** `heldFor`: a confidential session in a Harness Team account, whose project the account keeps serving alone until its
   *  host confirms the close, which it does once its saved session there is deleted (machines.ts productManagerOn); `since`
   *  when it was removed, and `noticed` once the Swarm said it lasts (liveness.ts). */
  /** `buddyOnly`: a Buddy's session on a Buddy-only machine, kept from every reader as its machine is (read/changes.ts). */
  closingSessions?: Array<{ agentId: string; machineId: string; harnessId: string; machineOwnerId: string; heldFor?: string; since?: number; noticed?: true
    buddyOnly?: true }>
  /** Removed machines whose host still has to clean up (machines.ts expireRemovals), listed only to that host. */
  machineCleanups?: import('./machines.js').MachineCleanup[]
  /** Conversations of a kind a later release added, set aside unchanged by a release that does not know it (parkLaterConversations). */
  parkedConversations?: Conversation[]
  /** The Local models add-on (docs/plans/2026-10-23-swarm-local-models.md): off until the owner turns it on, and only
   * then does anything call grid. The grid is kept when it is turned off, so turning it on again is instant. */
  localModels?: SwarmLocalModels
  /** The highest workgroup number ever given (store by parts); numbers are never given twice. */
  groupCounter?: number
  /** The tab revision when this Swarm was split into parts; every later message sequence is above it. */
  sequenceBase?: number
}
export interface SwarmLocalModels {
  /** The Swarm's own grid, minted on first turn-on and never renamed. */
  grid: string
  enabled: boolean
  /** What the owner's host last reported: the grid created and its members in step, or why not. */
  ready?: boolean
  error?: string
}
export interface OtherProjectWork {
  conversationId: string
  projectName: string
  title: string
  owns: string[]
  status: WorkStatus
  agentName: string
  /** The first pull request link in the assignment's result, when its agent reported one. */
  pr: string | null
}
export type Actor =
  | { kind: 'person'; userId: string; email: string }
  | { kind: 'agent'; agentId: string; machineOwnerId: string }
export interface Author { kind: 'person' | 'agent'; id: string; name: string; displayName?: string; membershipGeneration: string }
export interface MessageDraft {
  id: string
  conversationId: string
  author: Author
  text: string
  replyTo: string | null
  recipients: string[]
  /** Buddies this row is news for (buddyNews.ts): a delivery each, never listed among its recipients. */
  buddyRecipients?: string[]
  /** Structured row kind for clients; `native` is written by native.ts, `route`/`route-override` by commands. */
  source?: Record<string, unknown>
  attachments?: import('./attachments.js').Attachment[]
  /** People a Lead tagged (mentions.ts). */
  mentions?: string[]
  /** Its tags wait until the group has had no worker and no Lead action for a while (mentions.ts NO_WORKER_GRACE_MS). */
  holdMentions?: true
  /** The root of the thread this reply is in; absent on a top-level message, which is its own thread (writeMessages). */
  thread?: string
  /** A thread reply also shown in the conversation's main stream. */
  alsoInChat?: true
  /** A reply in a Buddy thread session's thread (buddySessions.ts): the main Buddy never reads it. */
  buddySession?: true
  /** The project a row of a person's one Buddy chat belongs to (buddySessions.ts lostProjectRow), on the row itself so hiding it
   *  has no limit (security review 2 of #2435). */
  buddyProject?: string
}
/** A notice for one agent alone (a skill update): delivered to it like any message, never shown to people or other agents. */
export const AGENT_ONLY = { kind: 'agent-only' }
/** Who reads each kind of notice the Swarm writes into a chat: every kind the code writes has its line (notices.test.ts).
 *  `people`: everyone in the chat, its record of what happened or of what someone must act on. `recipients`: written for the
 *  Lead or an agent, so only the ones it reaches read it, like an agent-only notice, under its own kind so they receive it as
 *  before; a notice that reaches none is for people, the only ones left who can act (review of #2177). `agent`: only its
 *  recipients, always. Ken, 2026-10-29: shown under the Lead's name in the project chat, the Lead's wakes read as requests to
 *  act; people read a task's state on its status line. By kind, so the ones already stored are hidden as well. A kind people
 *  read can still be one row's recipients' alone (forRecipients): a cancel told to its worker, a routing line in the project
 *  chat. A kind no code here knows, stored by a newer server, reads as `people`. */
export const NOTICE_READERS = {
  // Only its agent: a skill update (cli host.ts), a decision answered (decisions.ts).
  'agent-only': 'agent',
  // The Lead's wakes and requests, and the worker's "moved" line (liveness.ts, tidy.ts, projectUpdates.ts, digest.ts); two
  // projects changing the same code, to both their Leads in the Leads chat (commands.ts).
  'work-stalled': 'recipients', 'work-lost': 'recipients', 'work-resumed': 'recipients', 'idle-stop': 'recipients',
  // An agent with no open task for 15 minutes, and a grid attempt's failed first review, told to the coordinator (tidy.ts
  // idleNotices, commands.ts work.check; project instructions, phase 4). `idle-stop` rows are from before.
  idle: 'recipients', 'review-failed': 'recipients',
  'update-request': 'recipients', 'digest-request': 'recipients', overlap: 'recipients',
  // Two agents that may be talking in a loop, told to the coordinator (commands.ts pairLoop, project instructions phase 1).
  'pair-loop': 'recipients',
  // Each its own case in commands.ts, decided by the row (forRecipients): statuses, briefs, merges, starts, removals.
  system: 'people',
  // A save of the project's instructions, with its summary: the team sees it without opening the document (instructions.ts).
  instructions: 'people',
  // A member removed one of the coordinator's notes: told to the coordinator alone (instructions.ts).
  'note-removed': 'recipients',
  'project-report': 'people', route: 'people', 'route-override': 'people', 'buddy-proposal': 'people', 'buddy-session-ended': 'people',
  'decision-delegated': 'people', 'machine-removed': 'people', 'machine-left': 'people', ship: 'people',
  // A project PM's private line in a person's one Buddy chat, marked with its project (commands.ts person.tell): its person
  // reads it, as they read the line in their older project chat.
  'pm-line': 'people',
  // Their one Buddy cannot start in a person's older project chat, told to them there once per outage (commands.ts buddyDownLine).
  'buddy-cannot-start': 'people',
  'auto-archive': 'people', native: 'people',
  // The nightly routing reflection, for the project's people; never a Buddy's (buddies.ts routingRow).
  'routing-reflection': 'people',
  // No new agent can start, or soon none will, told to the coordinator; with none in the chat, people read it, tagging who can
  // fix it (reviewCapacity.ts; final review). Older rows, written for no one, still read as people's. Older rows of kinds no
  // longer written (the automatic review's `auto-review`, a routing rule's `rule`) read as people's, as any kind not listed does.
  'review-capacity': 'recipients',
  // #2177's rulings: a failed start and a terminal's alert or typed input stay the people's to see.
  'start-timeout': 'people', 'terminal-alert': 'people', 'terminal-input': 'people',
} as const satisfies Record<string, 'people' | 'recipients' | 'agent'>
const readersOf = (kind: unknown): 'people' | 'recipients' | 'agent' =>
  typeof kind === 'string' && Object.hasOwn(NOTICE_READERS, kind) ? NOTICE_READERS[kind as keyof typeof NOTICE_READERS] : 'people'
/** Marks a notice of a kind people also read (a cancel to its worker), or a copy for no one of a notice its recipient hears
 *  elsewhere, as its recipients' alone. */
export const forRecipients = (source: Record<string, unknown>) => ({ ...source, recipientsOnly: true as const })
/** Whether only the message's recipients read it: never people, nor other agents. */
export const agentOnly = (source: unknown, recipients: readonly string[]): boolean => {
  const notice = source as { kind?: unknown; recipientsOnly?: unknown } | null | undefined
  const readers = readersOf(notice?.kind)
  return readers === 'agent' || notice?.recipientsOnly === true || (readers === 'recipients' && recipients.length > 0)
}
/** What a Buddy reads of an agent and of a task: no machine or terminal ids (review 1 of #2115: no machines means none). */
/** A lost task's reason without the machine it ran on (lostReason.ts). */
/** Whether [target]'s machine is kept from [actor]: one Buddy-only (machines.ts buddyOnly), which only the Buddy's person and
 *  the Buddy itself read where it runs (security review 1 of #2234). */
export const machineHiddenFrom = (state: SuperTabState, actor: Actor, target: Agent): boolean =>
  !!target.buddyOf && !!state.machines?.some(m => m.buddyOnly && m.machineId === target.machineId)
  && !(actor.kind === 'person' ? actor.userId === target.buddyOf?.personId : actor.agentId === target.id)

export const agentWithoutMachine = <T extends Pick<Agent, 'machineId' | 'harnessId' | 'replacement' | 'lostTask'>>(target: T): T => {
  const { replacement: _replacement, ...rest } = target
  return { ...rest, machineId: '', harnessId: '',
    ...(target.lostTask ? { lostTask: { ...target.lostTask, reason: lostReasonWithoutMachine(target.lostTask.reason) } } : {}) } as T
}
/** An agent as a Buddy [buddyId] reads it: no machine, and for any agent but itself not whose machine, membership or Team
 *  account runs it, which says whose Mac runs the PM (security reviews of #2258). Its membership's generation matches a
 *  person's, so it goes too (delta review 1 of #2258), and so does its host grant, which under an older share policy names
 *  its contributor's email (lib/machineSharePolicy.ts; final check of #2258). */
export const agentForBuddy = <T extends Pick<Agent, 'id' | 'machineId' | 'harnessId' | 'machineOwnerId' | 'contributorId' | 'membershipGeneration' | 'hostGrant' | 'teamAccount'
  | 'replacement' | 'lostTask'>>(target: T, buddyId: string): T => {
  const bare = agentWithoutMachine(target)
  if (target.id === buddyId) return bare
  const { teamAccount: _team, ...rest } = bare
  return { ...rest, machineOwnerId: '', contributorId: '', membershipGeneration: '', hostGrant: null } as T
}
/** A group as a Buddy reads it: its task names no machine, terminal or machine owner. */
/** A conversation as a Buddy reads it: no machine (below), and no list of its chat's sessions, which names other threads, other
 *  projects' among them, and starts still pending (security review 2 of #2435). */
export const groupForBuddy = <T extends Pick<Conversation, 'assignment' | 'lostAttempt' | 'buddySessions'>>(group: T): T => {
  const { buddySessions: _sessions, ...rest } = groupWithoutMachines(group)
  return rest as T
}
export const groupWithoutMachines = <T extends Pick<Conversation, 'assignment' | 'lostAttempt'>>(group: T): T => {
  const assignment = group.assignment && { ...group.assignment,
    ...(group.assignment.execution ? { execution: { ...group.assignment.execution, machineId: '', harnessId: '', machineOwnerId: '' } } : {}),
    ...(group.assignment.lost ? { lost: { ...group.assignment.lost, reason: lostReasonWithoutMachine(group.assignment.lost.reason) } } : {}) }
  return { ...group, ...(assignment ? { assignment } : {}),
    ...(group.lostAttempt ? { lostAttempt: { id: group.lostAttempt.id, agentId: group.lostAttempt.agentId } } : {}) }
}
export interface CommandEffects {
  state: SuperTabState
  messages: MessageDraft[]
  cancelledAgents: string[]
  previousAttempts: Array<{ conversationId: string; brief: string; checks: Check[]; assignment: Assignment }>
  routeDecisions: RouteDecisionEffect[]
  result: Record<string, unknown>
  /** A terminal request or its answer, written outside the tab state by the store (terminal.ts). */
  terminal?: import('./terminal.js').TerminalEffect
  /** Decisions asked, and a decision answered, written outside the tab state by the store (decisions.ts). */
  decisions?: import('./decisions.js').DecisionDraft[]
  decisionAnswer?: import('./decisions.js').DecisionAnswer
  /** Deliveries of messages already stored: a Buddy thread session's first messages, sent while it started (buddySessions.ts). */
  lateDeliveries?: Array<{ messageId: string; conversationId: string; agentId: string; author: { kind: 'person'; id: string; generation: string } }>
  /** A project's new instructions revision, written outside the tab state by the store (instructions.ts). */
  instructions?: import('./instructions.js').InstructionsWrite
  /** A coordinator's note kept or a note removed, written outside the tab state by the store (instructions.ts). */
  notes?: import('./instructions.js').NotesWrite
}
/** `details` go to the caller with the code: what it needs to act on the refusal (a stale save's current text). */
export class SuperTabError extends Error {
  /** `unreachable`: the caller cannot reach this Swarm at all (not, or no longer, a member). The person routes answer it as
   *  they answer a Swarm that does not exist (routes/superTabs.ts NOT_AVAILABLE), so the answer never says which. */
  constructor(readonly code: string, message: string, readonly status = 409, readonly unreachable = false, readonly details?: Record<string, unknown>) {
    super(message)
    this.name = 'SuperTabError'
  }
}
export function fail(code: string, message: string, status = 409, details?: Record<string, unknown>): never { throw new SuperTabError(code, message, status, false, details) }
export const stableId = (...parts: string[]): string => createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 24)
export const actorKey = (actor: Actor): string => actor.kind === 'person' ? `person:${actor.userId}` : `agent:${actor.agentId}`
export const activeWork = (group: Conversation): boolean => !!group.assignment &&
  !['done', 'stopped', 'cancelled', 'lost'].includes(group.assignment.status)

/** Old states derive the finished-work mark from their closed assignments; new states persist it on the worker. */
export function awaitingWorkers(state: SuperTabState, projectId: string): Agent[] {
  return state.agents.filter(a => {
    if (state.conversations.some(c => c.leadId === a.id)
      || state.conversations.some(c => activeWork(c) && c.assignment?.agentId === a.id)) return false
    // A lost task's agent did not finish it, even once the task is cancelled: it may be gone.
    const groups = state.conversations.filter(c => c.assignment?.agentId === a.id && !c.assignment.lost)
    return (a.projectId ?? groups.map(c => groupProject(state, c).id)[0] ?? 'lead') === projectId &&
      (a.workDecision === 'awaiting' || (!a.workDecision && groups.some(c => !activeWork(c))))
  })
}
/** A task's work ended: its worker is marked `awaiting`, whatever its kind. People see the mark; no command reads it, so
 *  nothing waits for a keep or stop (project instructions, phase 4, decision 17). A coordinator, and a worker already
 *  stopping, keep what they have. */
export function finishWorker(state: SuperTabState, workerId: string): void {
  const target = state.agents.find(a => a.id === workerId)
  if (!target || state.conversations.some(c => c.leadId === target.id) || target.workDecision === 'stop') return
  target.workDecision = 'awaiting'
}

export function person(state: SuperTabState, id: string): Person {
  const found = state.people.find(p => p.id === id)
  if (!found) throw new SuperTabError('FORBIDDEN', 'You no longer have access to this Super Tab.', 403, true)
  return found
}
export function agent(state: SuperTabState, id: string): Agent {
  const found = state.agents.find(a => a.id === id) ?? fail('AGENT_UNAVAILABLE', 'This agent is no longer in the Super Tab.')
  if (person(state, found.contributorId).generation !== found.membershipGeneration) {
    fail('AGENT_UNAVAILABLE', 'This agent must be shared again before it can participate.')
  }
  return found
}
export function conversation(state: SuperTabState, id: string): Conversation {
  return state.conversations.find(c => c.id === id) ?? fail('NOT_FOUND', 'This conversation is unavailable.', 404)
}

export const isLeads = (group: Conversation): boolean => group.kind === 'leads'

const KNOWN_KINDS: Record<NonNullable<Conversation['kind']>, true> = { leads: true, buddy: true, 'swarm-buddy': true }
/** Conversation kinds this release knows; one of another kind is kept aside unchanged (parkLaterConversations, parts/shape.ts). */
export const knownKind = (group: Pick<Conversation, 'kind'>): boolean => group.kind == null || Object.hasOwn(KNOWN_KINDS, group.kind)
/** During a rolling deploy the previous release reads what the next one wrote. A conversation kind it does not know
 *  belongs to no project it can check, so it waits here unchanged, and the release that knows it puts it back. */
export function parkLaterConversations(state: SuperTabState): void {
  const all = [...state.conversations, ...state.parkedConversations ?? []]
  const known = knownKind
  state.conversations = all.filter(known)
  const parked = all.filter(c => !known(c))
  if (parked.length) state.parkedConversations = parked
  else delete state.parkedConversations
}

/** Work a Lead of another project should know about: assigned and moving, not finished, stuck or archived. */
export const crossProjectActive = (group: Conversation): boolean => !group.archived && !isLeads(group) && !group.audience
  && ['working', 'review', 'needs_human'].includes(group.assignment?.status ?? '')

/** The active work of the other projects a project's Lead may know about (shared with the read API, design 7.2). */
export function otherProjectsWork(state: SuperTabState, own: SwarmProject): OtherProjectWork[] {
  return state.conversations.filter(crossProjectActive).flatMap(group => {
    const project = groupProject(state, group), assignment = group.assignment!
    if (project.id === own.id || !sharedWithLeads(project)) return []
    const worker = state.agents.find(a => a.id === assignment.agentId)
    return [{ conversationId: group.id, projectName: project.name, title: group.title, owns: group.task?.owns ?? [], status: assignment.status,
      agentName: worker ? worker.displayName ?? worker.name : '', pr: assignment.result?.match(/https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+/)?.[0] ?? null }]
  })
}

/** The Swarm-wide Leads conversation ("Product Managers" in the apps) is removed (Dee, 2026-10-31): only agents posted
 *  there and people did not know what it was for. A new Swarm gets none. An older Swarm keeps its stored record and
 *  history untouched (no data is deleted), but no read sends it, no command or post reaches it (LEADS_REMOVED) and no
 *  delivery from it is handed out. */
export const LEADS_REMOVED = "The Product Managers chat was removed. Post in your project's chat instead."
export function leadsRemoved(): never { fail('LEADS_CONVERSATION_REMOVED', LEADS_REMOVED, 410) }

/** Legacy groups keep their append order, including archived groups. Persisted
 * numbers are never reassigned; the store serializes concurrent additions. */
export function numberConversations(state: SuperTabState): void {
  let next = nextConversationNumber(state)
  const leads = new Set(projectsOf(state).map(p => p.leadConversationId))
  for (const group of state.conversations) {
    if (!leads.has(group.id) && !isLeads(group) && group.number == null) state.groupCounter = group.number = next++
  }
}
/** The store by parts keeps the highest number ever given (`groupCounter`): a dormant group is not loaded, and its
 *  number must not be given again. */
export function nextConversationNumber(state: SuperTabState): number {
  return Math.max(state.groupCounter ?? 0, state.retiredConversationNumber ?? 0, 0,
    ...[...state.conversations, ...state.parkedConversations ?? []].map(c => c.number ?? 0)) + 1
}
export function author(state: SuperTabState, actor: Actor, write = false): Author {
  if (actor.kind === 'person') {
    const member = person(state, actor.userId)
    if (write && member.role === 'viewer') fail('READ_ONLY', 'You have read-only access to this Super Tab.', 403)
    return { kind: 'person', id: member.id, name: member.email, membershipGeneration: member.generation }
  }
  const member = agent(state, actor.agentId)
  if (member.machineOwnerId !== actor.machineOwnerId) fail('FORBIDDEN', 'Only the execution host can speak as this agent.', 403)
  if (write && person(state, member.contributorId).role === 'viewer') fail('READ_ONLY', 'This contribution is read-only.', 403)
  return { kind: 'agent', id: member.id, name: member.name, displayName: agentDisplayName(state.agents, member.id), membershipGeneration: member.membershipGeneration }
}

/** The Swarm's grid name: `swarm-` and 12 hex of sha256(tab id). Derived so it is reproducible when supported; the
 * stored value is authoritative and never renamed. */
export function swarmGridName(tabId: string): string {
  return `swarm-${createHash('sha256').update(tabId).digest('hex').slice(0, 12)}`
}

export function createSuperTab(id: string, name: string, owner: { id: string; email: string }, environment: string, visibility?: ProjectVisibility): SuperTabState {
  const state: SuperTabState = {
    version: 1, id, name, ownerId: owner.id, environment, paused: false,
    people: [{ ...owner, email: owner.email.trim().toLowerCase(), role: 'owner', generation: id }],
    agents: [], invitations: [],
    conversations: [{ id: 'lead', title: 'Lead', leadId: null, agentIds: [], archived: false, brief: '', checks: [], assignment: null, lastMessageSequence: 0 }],
  }
  // A new Swarm's first project starts in Default; only a project from before skill modes reads as Harness orchestration.
  // It starts on a copy of the built-in instructions, which the store writes beside it (store.ts create).
  state.projects = [{ ...projectsOf(state)[0]!, ...(visibility ? { visibility } : {}), skillMode: 'default', ...FIRST_INSTRUCTIONS }]
  // Its models are on from the start (owner, 2026-10-24): the owner's computer makes the Swarm's grid in the background
  // (CLI `superTabs/swarmGrids.ts`) and reports how it went. Fire and forget: a grid that could not be made leaves the
  // Swarm as it is, and the owner's first share or run in Your models sets the models up then.
  state.localModels = { grid: swarmGridName(id), enabled: true }
  return state
}

/** Pending invitations are management data, not part of the shared conversation. */
export function visibleState(state: SuperTabState, actor: Actor, now = Date.now()): SuperTabState {
  author(state, actor)
  // The copy leaves out what no reader gets and no step below reads: the owner-only sharing, the hosts' slot claims, released
  // and closing sessions (only that machine's host roster lists them: read/hostRows.ts; a removed private agent's session is
  // not every member's), and overlap alerts. Nor a dormant conversation: it is read on demand, never in a whole-Swarm read
  // (spec, Archive); a command may still load one.
  const { sharing: _sharing, harnessReservations: _reservations, releasedHarnesses: _released, overlapAlerts: _alerts, closingSessions: _closing,
    ...kept } = state
  const visible = cloneData({ ...kept, conversations: state.conversations.filter(c => !c.dormant) })
  // A Buddy-only machine is no machine of the Swarm to anyone, its own person included (machines.ts buddyOnly): their Buddy
  // shows as a Buddy, and their machine stays theirs. Machines, status and the leaderboard's lent hours all read this.
  if (visible.machines) visible.machines = visible.machines.filter(m => !m.buddyOnly)
  // Nor its id, which a Buddy's row carries (machineHiddenFrom).
  visible.agents = visible.agents.map(a => machineHiddenFrom(state, actor, a) ? agentWithoutMachine(a) : a)
  // The removed Leads conversation reaches nobody (leadsRemoved), its id included.
  visible.conversations = visible.conversations.filter(c => !isLeads(c))
  delete visible.leadsConversationId
  assignAgentDisplayNames(visible.agents)
  const led = actor.kind === 'agent' ? ledProject(visible, actor.agentId) : undefined
  if (led) visible.otherProjectsWork = otherProjectsWork(visible, led)
  for (const target of visible.agents) {
    const since = downSince(state, target, now)
    if (since) target.downSince = since
    delete target.downNamed
    if (target.limitedUntil && Date.parse(target.limitedUntil) <= now) target.limitedUntil = null
  }
  visible.buddies = true
  // A failing privacy check's detail is its contributor's: an error from the check can name paths on their Mac. Everyone
  // else reads which item failed (machines.ts teamWorkRefusal).
  for (const pool of visible.machines ?? []) {
    const privacy = pool.observation?.privacy
    if (privacy && 'detail' in privacy && !(actor.kind === 'person' && actor.userId === pool.contributorId)) delete (privacy as { detail?: string }).detail
  }
  expireRemovals(visible, now)
  // A read never hands out the cleanup records it just applied (read/hostRows.ts delivers them to the machine's host).
  delete visible.machineCleanups
  delete visible.parkedConversations
  numberConversations(visible)
  delete visible.retiredConversationNumber
  delete visible.groupCounter
  delete visible.sequenceBase
  placeRules(visible)
  if (visible.rules) visible.rules = visible.rules.filter(r => projectsOf(state).some(p => p.id === r.projectId && canReadProject(state, actor, p)))
  if (visible.projects) {
    visible.projects = visible.projects.filter(p => canReadProject(state, actor, p))
    visible.conversations = visible.conversations.filter(c => canReadGroup(state, actor, c))
    // The status card is read exactly by those who read the project chat (projects.ts SwarmProject.status); without the chat
    // loaded, by nobody.
    visible.projects = visible.projects.map(p => {
      if (p.status === undefined) return p
      const chat = state.conversations.find(c => c.id === p.leadConversationId)
      if (chat && canReadGroup(state, actor, chat)) return p
      const { status: _status, ...rest } = p
      return rest
    })
    visible.agents = visible.agents.filter(a => canReadAgent(state, actor, a))
    visible.starts = visible.starts?.filter(s => visible.conversations.some(c => c.id === s.request.conversationId))
    if (!visible.projects.some(p => p.id === 'lead')) {
      delete visible.project
      visible.machines = visible.machines?.filter(m => m.scope === 'swarm')
    }
    const harnesses = new Set([...visible.agents.map(a => a.harnessId), ...(visible.starts ?? []).flatMap(s => s.harnessId ? [s.harnessId] : [])])
    for (const pool of visible.machines ?? []) {
      if (!pool.observation) continue
      pool.observation.runningHarnessIds = pool.observation.runningHarnessIds.filter(id => harnesses.has(id))
      pool.observation.stoppedHarnessIds = pool.observation.stoppedHarnessIds.filter(id => harnesses.has(id))
      if (pool.observation.harnessProgress) pool.observation.harnessProgress = Object.fromEntries(Object.entries(pool.observation.harnessProgress).filter(([id]) => harnesses.has(id)))
      // Each attempt's tokens are read through the cost summary (costs/read.ts), never from the machine's raw counts.
      delete pool.observation.harnessTokens
      if (pool.observation.stoppedReservations) pool.observation.stoppedReservations = pool.observation.stoppedReservations.filter(r => harnesses.has(r.harnessId))
      if (pool.observation.preparingStartIds) pool.observation.preparingStartIds = pool.observation.preparingStartIds.filter(id => visible.starts?.some(s => s.id === id))
    }
    for (const start of visible.starts ?? []) if (startPreparing(state, start, now)) start.preparing = true
    visible.invitations = visible.invitations.filter(i => visible.conversations.some(c => c.id === i.conversationId))
  }
  for (const project of projectsOf(visible)) for (const target of awaitingWorkers(visible, project.id)) target.workDecision = 'awaiting'
  for (const project of visible.projects ?? []) project.skillSet = skillSetOf(project)
  // An uploaded avatar's stored key stays on the server; readers get a link with each parts read (avatarLinks.ts).
  // Each person as the Swarm names them (usernames.ts), their default included.
  const names = swarmUsernames(state)
  visible.people = visible.people.map(p => ({ ...withAvatarView(p), username: names.get(p.id) })) as Person[]
  visible.agents = visible.agents.map(withAvatarView) as Agent[]
  // On Custom every agent shows the role it runs, null when its kind has none; elsewhere a role id means nothing yet.
  for (const target of visible.agents) {
    const home = projectsOf(state).find(p => p.id === agentProjectId(state, target))
    if (home && skillSetOf(home) === 'custom') target.roleId = agentSetRole(state, home, target)?.id ?? null
    else delete target.roleId
  }
  if (actor.kind !== 'person' || actor.userId !== state.ownerId) visible.invitations = []
  for (const start of visible.starts ?? []) {
    if (start.error && !readsRawReason(actor, start, state.conversations.find(c => c.id === start.request.conversationId))) start.error = publicReason(start.error)
  }
  // A Buddy brainstorms; where agents run and how work is routed are none of its business (buddies.ts). A start names the
  // machine and the folder on it, so it reads none, though it reads their workgroups.
  if (actor.kind === 'agent' && state.agents.some(a => a.id === actor.agentId && a.buddyOf)) {
    visible.machines = []
    visible.starts = []
    visible.agents = visible.agents.map(a => agentForBuddy(a, actor.agentId))
    visible.conversations = visible.conversations.map(groupForBuddy)
    // A project's repository names the machine and folder it was made from; the address is all a Buddy needs (security
    // review 2 of #2115).
    for (const project of visible.projects ?? []) if (project.repository) project.repository = { repositoryUrl: project.repository.repositoryUrl } as typeof project.repository
    // Where its Product Manager runs names the machine and its start: a Buddy reads how it stands, and why it failed, which
    // names no machine (leadStart.ts leadStartFailed; Diego, 10-30).
    for (const project of visible.projects ?? []) {
      const lead = project.lead
      if (lead) project.lead = { status: lead.status, ...(lead.reason !== undefined ? { reason: lead.reason } : {}) } as typeof lead
    }
    if (visible.project) visible.project = { repositoryUrl: visible.project.repositoryUrl } as typeof visible.project
    delete visible.rules
    delete visible.routingPolicy
  }
  const seen = seenMachineIds(visible)
  visible.conversations = visible.conversations.map(c => withSeenRequirement(c, seen))
  return visible
}
