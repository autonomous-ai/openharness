import { createHash } from 'node:crypto'
import { githubRepository } from '../github/repository.js'
import { cloneData } from './cloneData.js'
import { autoJoinOn } from './autoJoinDomain.js'
import { agentDisplayName, assignAgentDisplayNames } from './agentNames.js'
import { personView } from './profile.js'
import { swarmUsernames } from './usernames.js'
import { downSince, expireRemovals, startPreparing } from './machines.js'
import { publicReason, readsRawReason } from './startFailure.js'
import { processOf, projectColumns } from './process.js'
import { canReadAgent, canReadGroup, canReadProject, groupProject, ledProject, ownerlessProjects, ownsProject, projectsOf, sharedWithLeads, type ProjectVisibility, type SwarmProject } from './projects.js'

type Role = 'owner' | 'collaborator' | 'viewer'

export interface Person {
  id: string
  email: string
  role: Role
  generation: string
  /** The name they chose (usernames.ts), or one kept for them; absent, readers work out their default. Nothing sets a chosen one any
   *  more (2026-11-09): those chosen before stay. Only members read it. */
  username?: string
  /** The name they show (personNames.ts), such as "Minh Nguyen": their account's name since 2026-11-10, written when they join and
   *  whenever they rename their account (nameFromAccount); absent, the Swarm shows their username. Only members read it. */
  name?: string
  /** The name they chose in this Swarm before it followed their account (2026-11-09), kept as it was and read by nothing. Can go
   *  from 2026-12-10. */
  chosenName?: string
  /** Their [name] is their account's, so a name kept in it is no longer one they chose here. */
  nameFollowsAccount?: true
  /** `domain`: joined by themselves as someone at the owner's email domain (autoJoin.ts), so the people list says so. */
  joinedVia?: 'domain'
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
  /** A PM's own chat with its person (Swarm v4), kept here so a light read finds it by key (parts/light.ts). */
  chatId?: string
  /** The kind an older client started it as, kept for older readers. Absent reads as builder (agentRole); the Lead is derived
   *  from leadId. It decides nothing (project instructions, phase 4). */
  role?: AgentRole
  /** `awaiting`: its task's work ended (finishWorker), shown and read by no command; `keep` and `stop`: asked for
   *  (agent.release, tidy.ts). Kept when its group receives a new brief. */
  workDecision?: 'awaiting' | 'keep' | 'stop'
  /** When its Lead last decided keep: a kept worker is idle from then (tidy.ts). */
  keptAt?: number
  /** When its last idle spell began, once its coordinator was told of it (tidy.ts idleNotices): one notice per spell. */
  idleNoticedAt?: number
  /** Set while its stop is the server's idle stop (tidy.ts, Dee's rules-to-code decision, 2026-11-06),
   *  with the decision it had before: its host withdraws that stop when the session's folder has changes by the time it would
   *  close it (agent.stopRefused). */
  idleStop?: { previous: 'awaiting' | 'keep' | null }
  releaseId?: string
  /** A person's request to move this Product Manager to another engine or account (lead.switch), carried out by its host.
   *  `id` is the operation that asked; `claimedUntil` is set once the host took it (agent.switchClaim). */
  /** The switch request the last rebind settled, until its result arrives: that result is the one line the chat gets, and
   *  it still tells the machine owner who asked. */
  switchLanded?: { id: string; requestedBy: string; candidateAgentId?: string }
  switchRequest?: { id: string; engine: string; profileId: string; targetMachineId?: string; model?: string; effort?: string; requestedBy: string; at: string; claimedUntil?: string }
  /** The account it runs in on its machine once a switch moved it; absent for the machine's default account. */
  profileId?: string
  /** The liveness sweep's moves of a PM on another account back to the default one (pmAccount.ts): how many it asked for, when
   *  the last was asked or seen to end (ms), whether it is asking now, and whether its project chat heard it failed 3 times.
   *  Dropped once the PM is on the default account. */
  accountReturn?: { tries: number; at: number; asking?: true; gaveUp?: true }
  /** Captured from the original Swarm launch, never inferred from a later live session with the same id. */
  startedSession?: { creationId: string; sessionId: string; createdAt: string }
  /** The model on the Swarm's grid its start named, which its engine never reports. Kept here because a command does not
   *  load a finished start (parts/load.ts loadActive), and the leaderboard counts every assignment by it (review of #1808). */
  gridModel?: string
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
  /** A Regular agent (agent.new, task #4116): in no project but its active task's (projects.ts agentProjectId). */
  regular?: true
  /** The one project this Member belongs to (task #4540; spec 2026-11-07-members-and-leads): picked in Cmd-N or when its person
   *  joined. Readers get it in the derived row, never in this part (read/views.ts), and only when they read that project. A
   *  Lead's is the project it leads, derived (agentKind.ts ledProjects). Cleared when the project is deleted. */
  mainProjectId?: string
  /** A Member's own mark (members.ts, task #4697), and a helper's: the Member it helps. Set by the server alone, at its start;
   *  its host reads them in the agent's row to reopen a woken one in its folder (#4698). */
  member?: { projectId: string }
  helperOf?: { agentId: string; harnessId: string }
  /** The private project a Regular agent first worked in: its one conversation holds that project's content, so it takes tasks
   *  only there from then on (projects.ts regularMayWorkIn; security review 2 of #4116). Set at its assignment, never cleared. */
  privateProjectId?: string
}
export type AgentRole = 'builder' | 'reviewer'
export const agentRole = (agent: Pick<Agent, 'role'>): AgentRole => agent.role ?? 'builder'
export interface AgentStartRequest {
  conversationId: string
  role?: AgentRole
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
  /** A Regular agent's start (agent.new, task #4116): in its person's own chat, in no project's folder. Written by the server alone. */
  regular?: true
  /** The main project its person picked (agent.new; task #4540), kept on the agent when it starts. */
  mainProjectId?: string
  /** A Member's own start (members.ts, task #4697): its host sets the project up once in this folder. Written by the server
   *  alone, with `regular` and `mainProjectId`. */
  member?: { projectId: string }
  /** A helper's start (members.ts): made from its Member's ready setup on the Member's computer, for the task it starts
   *  in. Written by the server alone. */
  helperOf?: { agentId: string; harnessId: string }
  /** The offered account selected for a destination PM switch. */
  profileId?: string
  /** A bounded handoff note transferred from the source host, visible only in the destination host's start row. */
  handoffNote?: string
  handoffSourceAgentId?: string
  handoffChangeId?: string
  /** A project's Product Manager's start (leadStart.ts): written by lead.start alone, never taken from an agent.start. Its
   *  agent becomes the Lead of the project's Lead conversation once it runs. */
  leadFor?: { projectId: string; personId: string; generation: string; switchId?: string }
}
export interface AgentStart {
  poolGeneration?: string
  poolSettled?: boolean
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
  /** The CLI version its machine's daemon had connected with when it was dispatched (store.ts machineVersions): a failed start
   *  says nothing about that machine once it runs another version (cli routeCommand.ts `stalled`). */
  dispatchedVersion?: string
  /** When it was asked for (absent on starts from before 2026-10-29): a task's start never launched
   *  leaves the task orphaned (liveness.ts). */
  requestedAt?: number
  /** Why its machine holds it without launching it, from the machine's report (cli superTabs/machines.ts), with when it was first
   *  told: gone once the start launches or fails. Read whole by the readers of its raw reason, as what it means by the rest. */
  waiting?: { reason: string; at: number }
  /** On reads only, never stored: its machine's fresh report says it is preparing (machines.ts startPreparing). */
  preparing?: true
  error: string | null
}
/** `needs_human`: the agent needs a person's decision (its result is the question). `blocked`: it cannot go on (its result
 * says why). Both stay active work; the machine running the agent alerts its Harness Pro (cli/src/superTabs/attention.ts).
 * `lost`: its agent died, stalled or hit a limit (liveness.ts); no longer active, so the Lead assigns it again or cancels it. */
export type WorkStatus = 'planned' | 'working' | 'needs_human' | 'blocked' | 'review' | 'done' | 'stopped' | 'cancelled' | 'reconciling' | 'lost'
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
  /** `contributorId`: whose login its agent runs under (Agent.contributorId), kept after the agent is closed. Absent on
   *  assignments made before 2026-11-07. */
  execution: { machineId: string; harnessId: string; machineOwnerId: string; contributorId?: string }
  result: string | null
  /** Explicit progress fences delayed recording gaps; absent on older backends. */
  recordingProgress?: { at: number; revision: number }
  /** Its agent owns it until then; progress renews it (liveness.ts). Absent on assignments from before leases. */
  leaseUntil?: number
  /** Its agent's last progress the lease saw, for the Lead's wake-up when it is lost. */
  progressAt?: number
  /** While it needs a human: the person its agent asked (work.status with ask), whom its wait names (liveness.ts). */
  askedOf?: string
  /** While it is blocked or needs a human: why it waits (heldReason.ts). Absent on a hold from before reasons. */
  hold?: import('./heldReason.js').HeldReason
  /** When someone else's verdict found problems in a working hand-off of the older built-in skills, which then stops waiting
   *  for its review (liveness.ts waitingForReview). Its next status clears it. */
  reviewFoundAt?: number
  /** A two-review task's hand-overs and reviewers' verdicts, from the automatic reviews (#2382) before project instructions;
   *  never written since (phase 4: the server opens and counts no review), kept on older rows. */
  handoffs?: number
  verdicts?: ReviewVerdict[]
  /** A handed task brought back to its Engineer before Swarm v4, which no longer reopens one: when, and why (a No verdict, red CI, a conflict).
   *  Its Engineer's own status, check or post in the task picks it up and clears it; with none in REOPEN_OWNER_MS the task is
   *  lost, so anyone free takes it (liveness.ts). The next status clears it too. */
  reopened?: { at: number; why: string }
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
  /** `strong`: big, hard or risky work, which the crew's dispatch hands only to a member on a strong model (dispatch.ts, #3576); a task
   *  that wants two reviews counts as strong unless this says `standard`. */
  strength?: 'standard' | 'strong'
  /** What its reviews check first, and how many independent reviews it wants. The server opens and counts no review (project
   *  instructions, phase 4). */
  review?: ReviewPlan
}
/** A task's review plan (#2382; nightly reflection 10-30: the Lead hand-sent a focus to 20+ reviews that day). `focus` and
 *  `reviews: 2` are said in its brief, so the agent opening its review passes them on (project instructions, phase 4). */
export interface ReviewPlan { focus?: string; reviews?: 1 | 2 }

/** Where a task can be done at all (2026-10-27: a task to check a device plugged into one person's Mac was routed to another
 *  machine by policy order). `machines`: it runs only there. `devices`:
 *  full paths every start for it asks its machine to check (cli superTabs/capacity.ts). Never in the rendered brief, since
 *  a reader may not see the machine. A reader is handed only the machines they see, and how many others (`unseenMachines`). */
/** `access`: an older client's: the names of what the work needs to reach, stored and read by nothing since machine.access went.
 *  Delete it with the task records (slice S13). */
export interface TaskRequirement { machines?: string[]; devices?: string[]; access?: string[]; unseenMachines?: number }

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

export interface Conversation {
  id: string
  /** The removed Swarm-wide Leads conversation, still stored in an older Swarm (leadsRemoved), or an agent's 1:1 chat with its
   *  person: a kind of its own, so an older release parks it unread (parkLaterConversations) instead of reading it as a
   *  project's. Absent on every other conversation. */
  kind?: 'leads' | 'agent-chat'
  projectId?: string
  /** Stable, tab-local workgroup reference. Lead has no number. */
  number?: number
  title: string
  leadId: string | null
  agentIds: string[]
  archived: boolean
  brief: string
  task?: WorkTask
  /** The process when this task was opened; a Simple task stays Simple if the project returns to Full (#3896). */
  process?: import('./process.js').ProjectProcess
  /** A review group names the group whose work it reviews; only a Reviewer is assigned it, and a Reviewer nothing else. */
  reviewOf?: string
  /** A step of the task `reviewOf` names (task steps design, 2026-11-02): its name as the instructions give it, in any
   *  language. Readers show it inside its task, never as a task of its own. Absent on a linked group opened before steps. */
  step?: string
  /** An automatic review's hand-over of a two-review task (#2382); never written since project instructions, phase 4. */
  reviewStamp?: ReviewStamp
  checks: Check[]
  assignment: Assignment | null
  lastMessageSequence: number
  /** The sequence of its newest message in the main stream: a reply only in its thread leaves it (threads.ts). Absent until
   *  this conversation's first message after threads; readers fall back to lastMessageSequence. */
  lastMainSequence?: number
  /** The sequence of its newest main-stream message from a person, not a system row (parts/commit.ts): what makes a task's
   *  sidebar row bold (Huy, 11-03, #2427). Absent until a person's first message after this was added; readers read 0. */
  lastPersonSequence?: number
  /** When a person last talked with each agent here, by agent id (parts/commit.ts): `person`, their last message that reached
   *  it; `answer`, its own post to people after that one. An agent a person is chatting with is never idle (tidy.ts idleSince,
   *  task #3816). Ids and times only, the last hour; hidden from readers. Absent until a person talks with an agent here. */
  talkedAt?: Record<string, { person: number; answer?: number }>
  /** Linked GitHub pull requests, including links older than the latest message page. Absent in older snapshots. */
  pullRequestUrls?: string[]
  /** When its brief was last set, by a command before Swarm v4: a person's rule moved into this task leaves the
   *  instructions only for a pull request GitHub says merged after it (ruleGuard.ts rulePlaces, #3463). No command writes
   *  it otherwise. Absent on a task from before. */
  briefAt?: number
  /** Its messages drawn as live cards: its task and each linked pull request (cards.ts). Absent until its first card. */
  cards?: import('./cards.js').GroupCards
  /** The last sequence given to a message here. Each conversation numbers its own messages (store by parts). */
  messageSeq?: number
  /** The sequence of its last message that counted toward its project's reports before Swarm v4. */
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
  /** Counts edits and deletes here (messageEdits.ts), so readers read an older message again. Named for the reactions it
   *  first counted, which are gone. */
  reactionSeq?: number
  /** The tasks its work goes on in, as its cancel's reason names them (commands.ts goesOnIn, task #4462): a duplicate, or
   *  work folded or split into others. It leaves people's Tasks feeds and stays in its project's archived list, which can open them. */
  foldedInto?: string[]
  /** The person who asked for this work: whoever opened it, or the person its Lead named (leaderboard/record.ts). */
  requesterId?: string
  /** What the leaderboard counts here (leaderboard/record.ts); bookkeeping readers never get whole. */
  ledger?: import('./leaderboard/record.js').GroupLedger
  /** When a verified release carried its last recorded merge to people, and the release tags that did: the board's Shipped. Only
   *  on work the release watch settled before Swarm v4 removed it; nothing writes it now. */
  released?: { at: number; tags: string[] }
  /** Whether its task is moving, waiting on purpose or stuck, as the time checks last found it (liveness.ts recordTaskStates). */
  liveness?: TaskLiveness
  /** The last start or assignment on its task by an agent of its project, or its coordinator's post there (commands.ts). */
  leadAction?: { kind: 'assign' | 'start' | 'post'; at: number }
  /** The day (YYYY-MM-DD) its work should not start before, a promise the PM marks with work.queue. */
  notBefore?: string
  /** Why its not-before date holds it (heldReason.ts), set with the date by work.queue. Absent on a hold from before reasons. */
  hold?: import('./heldReason.js').HeldReason
  /** How urgent its task is, as a task stored before Swarm v4 said: P0 to P3 (task #3117). Absent on a step, a chat and a task
   *  from before priorities, which reads as P2. */
  priority?: 'P0' | 'P1' | 'P2' | 'P3'
  /** The member it waits for, without active work (dispatch.ts): its builder, after another agent's failed check, red CI or a
   *  merge conflict. The next assignment clears it. */
  pin?: { agentId: string; why: 'findings' | 'ci' | 'conflict'; at: number }
}
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

/** [url] as the project's own pull request, in the project's spelling of owner and repository (GitHub names are not case
 *  sensitive); null when it belongs to any other repository, whatever its name, since an owner is never guessed. Without a
 *  known GitHub repository nothing can be judged. */
export function projectPullRequestUrl(url: string, repositoryUrl: string | null | undefined): string | null {
  const own = githubRepository(repositoryUrl)
  if (!own) return url
  const match = url.match(/^https:\/\/github\.com\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_.-]+)\/pull\/([1-9][0-9]*)$/)
  if (!match) return null
  return match[1]!.toLowerCase() === own.owner.toLowerCase() && match[2]!.toLowerCase() === own.name.toLowerCase()
    ? `https://github.com/${own.fullName}/pull/${match[3]}` : null
}

/** The GitHub pull request links in [text], each once, in order. With the project's [repositoryUrl], each is that repository's
 *  (in the project's spelling) and a link into any other repository is left out, so one pull request is one link. */
export const pullRequestLinks = (text: string, repositoryUrl?: string | null): string[] => [...new Set([...text.matchAll(/https:\/\/github\.com\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+\/pull\/([1-9][0-9]*)\b/g)]
  .filter(match => Number(match[1]) <= Number.MAX_SAFE_INTEGER).flatMap(match => projectPullRequestUrl(match[0], repositoryUrl) ?? []))]

/** Adds the pull request links of [texts] to [group] and corrects the ones it holds, by the project's [repositoryUrl]. */
export function appendPullRequestUrls(group: Conversation, texts: Iterable<string | null | undefined>, repositoryUrl?: string | null): void {
  const urls = new Set((group.pullRequestUrls ?? []).flatMap(url => projectPullRequestUrl(url, repositoryUrl) ?? []))
  for (const text of texts) if (text) for (const url of pullRequestLinks(text, repositoryUrl)) urls.add(url)
  group.pullRequestUrls = [...urls]
}
export interface Invitation {
  id: string
  email: string
  role: 'collaborator' | 'viewer'
  conversationId: string
  expiresAt: number
}
/** An agent a machine's report removed as closed: as it was, and where it was (closedAgents.ts). */
export interface RemovedSession {
  machineId: string
  harnessId: string
  agent: Agent
  groupIds: string[]
  leadOf: string[]
  removedAt: number
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
  /** Read-only, for a project agent's reads (visibleState): the account every project's PM runs on, for the route's notes. */
  pmAccounts?: PmAccount[]
  /** Read-only, for the Swarm owner's reads (visibleState): the projects nobody owns, by name and size (projects.ts). */
  ownerlessProjects?: Array<{ id: string; name: string; conversations: number }>
  ownerId: string
  environment: string
  /** Owner-only sharing configuration; visibleState always removes it. */
  sharing?: import('./sharing.js').SwarmSharing
  /** People who left or were removed, whom auto-join never adds again (autoJoin.ts); visibleState always removes it. */
  autoJoinDeclined?: string[]
  /** Only in what a reader gets (visibleState), never stored: people at the owner's domain join by themselves, so the leave
   *  dialog says someone who leaves is not added back. */
  autoJoin?: true
  paused: boolean
  /** Its owner deleted it (deletion.ts): nobody reads or writes it, its row lists no member, and its owner may restore it until
   *  `purgeAt` (ISO times). Absent on a live Swarm. */
  deletion?: { at: string; by: string; purgeAt: string }
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
  /** What a report's removal of a closed agent must restore if its session reopens (closedAgents.ts): only its machine's host hears
   *  of it (read/hostRows.ts), and no reader gets it, as it names private chats. */
  removedSessions?: RemovedSession[]
  closingSessions?: Array<{ agentId: string; machineId: string; harnessId: string; machineOwnerId: string }>
  /** Removed machines whose host still has to clean up (machines.ts expireRemovals), listed only to that host. */
  machineCleanups?: import('./machines.js').MachineCleanup[]
  /** The machines their person took out of this Swarm, so a sync that adds machines by itself leaves them out; a reader gets only
   *  the ids of their own (visibleState). */
  removedMachines?: Array<{ machineId: string; contributorId: string }>
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
/** An account a project's PM runs on (Ken, 11-05): its machine and engine. A project the reader may not read is "another
 *  project", its PM unnamed. */
export interface PmAccount { machineId: string; engine: string; project: string; pm: string }

/** Every project's PM account (PmAccount): a PM could drain the account another project's PM ran on, and the route, reading
 *  as an agent of one project, saw no other project's PM (review of #3134). */
export function pmAccounts(state: SuperTabState, actor: Actor): PmAccount[] {
  return projectsOf(state).flatMap(project => {
    const leadId = state.conversations.find(c => c.id === project.leadConversationId)?.leadId
    const pm = leadId ? state.agents.find(a => a.id === leadId) : undefined
    const engine = pm?.configuration?.engine
    if (!pm || !engine) return []
    // A public project is named to every project agent, as otherProjectsWork names it (sharedWithLeads).
    const readable = canReadProject(state, actor, project) || sharedWithLeads(project)
    return [{ machineId: pm.machineId, engine,
      project: readable ? project.name : 'another project', pm: readable ? pm.displayName ?? pm.name : 'its PM' }]
  })
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
  /** Explicit answer in main chat, without a thread. */
  answers?: string
  recipients: string[]
  /** Structured row kind for clients; `native` rows were written by the terminal recording Swarm v4 removed, `route`/`route-override` by its routing, removed 2026-11-11. */
  source?: Record<string, unknown>
  attachments?: import('./attachments.js').Attachment[]
  /** People a Lead tagged (mentions.ts). */
  mentions?: string[]
  /** Written by message.send: a post, not a notice the server writes under an agent's name. Never stored; only an agent's post
   *  in its 1:1 chat tells its person's phone (store.ts tellPhones). */
  post?: true
  /** The root of the thread this reply is in; absent on a top-level message, which is its own thread (writeMessages). */
  thread?: string
  /** A thread reply also shown in the conversation's main stream. */
  alsoInChat?: true
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
  // Only its agent: a skill update (cli host.ts).
  'agent-only': 'agent',
  // What GitHub said to a person's agent, relayed by their own Harness (githubRelay.ts): the person reads it in their chat.
  github: 'people',
  // A worker's lost task, to its Lead (liveness.ts).
  'work-lost': 'recipients',
  // Two agents that may be talking in a loop, told to the coordinator (commands.ts pairLoop, project instructions phase 1).
  'pair-loop': 'recipients',
  // Each its own case in commands.ts, decided by the row (forRecipients): statuses, briefs, merges, starts, removals.
  system: 'people',
  'machine-removed': 'people',
  // #2177's rulings: a failed start and a terminal's alert or typed input stay the people's to see.
  // A PM switch nobody answered, in its project chat (tidy.ts staleSwitches).
  switch: 'people',
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
export interface CommandEffects {
  state: SuperTabState
  messages: MessageDraft[]
  cancelledAgents: string[]
  result: Record<string, unknown>
  /** `message.edit`'s new text, credentials removed (commands.ts WORDS): what the store writes into the row. */
  messageEdit?: { messageId: string; text: string }
  /** A terminal request or its answer, written outside the tab state by the store (terminal.ts). */
  terminal?: import('./terminal.js').TerminalEffect
  /** Deliveries of messages already stored. `lead`: a project's Lead hearing its person's messages sent while the chat had none (leadStart.ts leadArrived). */
  lateDeliveries?: Array<{ messageId: string; conversationId: string; agentId: string; author: { kind: 'person'; id: string; generation: string }; lead?: true }>
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
/** The task is open: assigned, and its attempt not ended. A handed task (below) is open too: archive, steps, deletion and the
 *  GitHub token hold all read this. Whether its agent is busy is occupiesAgent. */
export const activeWork = (group: Conversation): boolean => !!group.assignment &&
  !['done', 'stopped', 'cancelled', 'lost'].includes(group.assignment.status)
/** A task its Engineer handed over (task #3399, handed.ts): its pull request is ready for review, the status its Engineer sets
 *  when it marks it ready. The task stays open and its Engineer keeps its push access, but the work waits on others, so the
 *  Engineer is free for new work. A step's own Ready is its verdict, not a hand-over. */
export const handed = (group: Conversation): boolean => !group.reviewOf && group.assignment?.status === 'review'
/** Work in its agent's hands, which makes the agent busy: open and not handed over. Every "is this agent busy" check reads it. */
export const occupiesAgent = (group: Conversation): boolean => activeWork(group) && !handed(group)

/** What awaitingWorkers reads of the conversations, from one pass over them: the agents leading any conversation, those with
 *  active work, and each agent's assigned groups (not lost) in conversation order. Scanning every conversation per agent and
 *  project was 2.6 M calls in the 2026-11-02 prod profiles (12 profiles), on every read. Built per call or per caller's loop
 *  over projects, never kept on the state, since a command changes it. */
export interface WorkerIndex { leaders: ReadonlySet<string>; working: ReadonlySet<string>; groupsByAgent: ReadonlyMap<string, Conversation[]> }
export function workerIndex(state: SuperTabState): WorkerIndex {
  const leaders = new Set<string>(), working = new Set<string>(), groupsByAgent = new Map<string, Conversation[]>()
  for (const c of state.conversations) {
    if (c.leadId !== null) leaders.add(c.leadId)
    if (!c.assignment) continue
    // Busy with work in its hands; a task it handed over leaves it free (task #3399).
    if (occupiesAgent(c)) working.add(c.assignment.agentId)
    // A lost task's agent did not finish it, even once the task is cancelled: it may be gone.
    if (c.assignment.lost) continue
    const groups = groupsByAgent.get(c.assignment.agentId)
    if (groups) groups.push(c)
    else groupsByAgent.set(c.assignment.agentId, [c])
  }
  return { leaders, working, groupsByAgent }
}

/** Old states derive the finished-work mark from their closed assignments; new states persist it on the worker. */
export function awaitingWorkers(state: SuperTabState, projectId: string, index = workerIndex(state)): Agent[] {
  return state.agents.filter(a => {
    if (index.leaders.has(a.id) || index.working.has(a.id)) return false
    const groups = index.groupsByAgent.get(a.id) ?? []
    return (a.projectId ?? groups.map(c => groupProject(state, c).id)[0] ?? 'lead') === projectId &&
      (a.workDecision === 'awaiting' || (!a.workDecision && groups.some(c => !occupiesAgent(c))))
  })
}
/** A task's work ended: its worker is marked `awaiting`, whatever its kind. People see the mark; no command reads it, so
 *  nothing waits for a keep or stop (project instructions, phase 4, decision 17). A coordinator, and a worker already
 *  stopping, keep what they have. */
export function finishWorker(state: SuperTabState, workerId: string): void {
  const target = state.agents.find(a => a.id === workerId)
  if (!target || state.conversations.some(c => c.leadId === target.id) || target.workDecision === 'stop') return
  // A handed task that ends while its Engineer works on its next one leaves that Engineer busy (task #3399).
  if (state.conversations.some(c => occupiesAgent(c) && c.assignment!.agentId === target.id)) return
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

const KNOWN_KINDS: Record<NonNullable<Conversation['kind']>, true> = { leads: true, 'agent-chat': true }
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
  const projects = projectsOf(state), leads = new Set(projects.map(p => p.leadConversationId))
  for (const group of state.conversations) {
    // An agent's own chat is no task: it takes no number, so task numbers, which people and agents say ("#12"), stay in step.
    if (!leads.has(group.id) && !isLeads(group) && group.kind !== 'agent-chat' && group.number == null) {
      // An unnumbered dormant task predates a Simple→Full switch. Giving it a number now must not make it new work.
      if (!group.kind && !group.audience && !group.reviewOf && projects.some(p => p.id === (group.projectId ?? 'lead') && p.simpleThrough !== undefined)) group.process = 'simple'
      state.groupCounter = group.number = next++
    }
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
  state.projects = [{ ...projectsOf(state)[0]!, ...(visibility ? { visibility } : {}), skillMode: 'default' }]
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
  const { sharing: _sharing, autoJoinDeclined: _declined, harnessReservations: _reservations, releasedHarnesses: _released, overlapAlerts: _alerts, closingSessions: _closing,
    removedSessions: _removed, ...kept } = state
  const visible = cloneData({ ...kept, conversations: state.conversations.filter(c => !c.dormant) })
  // Prepared PM handoffs are private host-to-host launch data. Machine hosts receive their own start through read/hostRows.ts;
  // ordinary people and agent syncs must never receive the note or its correlation fields.
  for (const start of visible.starts ?? []) {
    delete start.request.handoffNote
    delete start.request.handoffSourceAgentId
    delete start.request.handoffChangeId
  }
  if (autoJoinOn(state)) visible.autoJoin = true
  // A machine taken out says who owned it: a reader gets the ids of their own, which is all their sync asks.
  const ownRemoved = actor.kind === 'person' ? (visible.removedMachines ?? []).filter(r => r.contributorId === actor.userId).map(r => r.machineId) : []
  if (ownRemoved.length) (visible as { removedMachines?: unknown }).removedMachines = ownRemoved
  else delete visible.removedMachines
  // Rows by day and project that only the leaderboard read uses, and it takes them from the Swarm itself.
  for (const pool of visible.machines ?? []) delete pool.lentDays
  // The removed Leads conversation reaches nobody (leadsRemoved), its id included.
  visible.conversations = visible.conversations.filter(c => !isLeads(c))
  delete visible.leadsConversationId
  assignAgentDisplayNames(visible.agents)
  const led = actor.kind === 'agent' ? ledProject(visible, actor.agentId) : undefined
  if (led) visible.otherProjectsWork = otherProjectsWork(visible, led)
  const ownerless = ownerlessProjects(state, actor)
  if (ownerless) visible.ownerlessProjects = ownerless
  for (const target of visible.agents) {
    const since = downSince(state, target, now)
    if (since) target.downSince = since
    delete target.downNamed
    if (target.limitedUntil && Date.parse(target.limitedUntil) <= now) target.limitedUntil = null
  }
  // A machine's accounts (labels, percent left) are for those who may switch a PM running there: its owner, and the owners of
  // projects whose PM runs on it. Agents and everyone else read the machine without them.
  for (const pool of visible.machines ?? []) {
    if (!pool.observation?.profiles) continue
    const there = state.agents.filter(a => a.machineId === pool.machineId)
    const owners = new Set(there.length ? there.map(a => a.machineOwnerId) : [pool.contributorId])
    const mayMove = actor.kind === 'person' && (owners.has(actor.userId) ||
      there.some(a => projectsOf(state).some(p => ownsProject(state, actor.userId, p) && state.conversations.some(c => c.id === p.leadConversationId && c.leadId === a.id))))
    if (!mayMove) delete pool.observation.profiles
  }
  expireRemovals(visible, now)
  // A read never hands out the cleanup records it just applied (read/hostRows.ts delivers them to the machine's host).
  delete visible.machineCleanups
  delete visible.parkedConversations
  for (const group of visible.conversations) delete group.talkedAt
  numberConversations(visible)
  delete visible.retiredConversationNumber
  delete visible.groupCounter
  delete visible.sequenceBase
  if (visible.projects) {
    visible.projects = visible.projects.filter(p => canReadProject(state, actor, p))
    visible.conversations = visible.conversations.filter(c => canReadGroup(state, actor, c))
    // The status card is read exactly by those who read the project chat (projects.ts SwarmProject.status); without the chat
    // loaded, by nobody.
    visible.projects = visible.projects.map(({ status, ...p }) => {
      const chat = state.conversations.find(c => c.id === p.leadConversationId)
      return chat && canReadGroup(state, actor, chat) && status ? { ...p, status } : p
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
      if (pool.observation.closedHarnessIds) pool.observation.closedHarnessIds = pool.observation.closedHarnessIds.filter(id => harnesses.has(id))
      if (pool.observation.harnessProgress) pool.observation.harnessProgress = Object.fromEntries(Object.entries(pool.observation.harnessProgress).filter(([id]) => harnesses.has(id)))
      // A reading stored before its tokens were ignored (machines.ts harnessTokens) still holds them: never a reader's. Goes once
      // every machine has reported since, on or after 2026-12-11.
      delete pool.observation.harnessTokens
      // What the server refused this machine's host is for the sweep alone (liveness.ts failRefusedStarts), never a reader.
      delete pool.observation.refusedStarts
      if (pool.observation.stoppedReservations) pool.observation.stoppedReservations = pool.observation.stoppedReservations.filter(r => harnesses.has(r.harnessId))
      if (pool.observation.preparingStartIds) pool.observation.preparingStartIds = pool.observation.preparingStartIds.filter(id => visible.starts?.some(s => s.id === id))
    }
    for (const start of visible.starts ?? []) if (startPreparing(state, start, now)) start.preparing = true
    visible.invitations = visible.invitations.filter(i => visible.conversations.some(c => c.id === i.conversationId))
  }
  // One index for every project: the loop sets only workDecision, which the index does not hold.
  const workers = workerIndex(visible)
  for (const project of projectsOf(visible)) for (const target of awaitingWorkers(visible, project.id, workers)) target.workDecision = 'awaiting'
  for (const project of visible.projects ?? []) {
    Object.assign(project, { process: processOf(project), columns: projectColumns(project) })
  }
  // Each person as the Swarm names them (usernames.ts), their default included.
  const names = swarmUsernames(state)
  visible.people = visible.people.map(p => ({ ...personView(p), username: names.get(p.id) }))
  if (actor.kind !== 'person' || actor.userId !== state.ownerId) visible.invitations = []
  for (const start of visible.starts ?? []) {
    const raw = readsRawReason(actor, start, state.conversations.find(c => c.id === start.request.conversationId))
    if (start.error && !raw) start.error = publicReason(start.error)
    if (start.waiting && !raw) start.waiting = { ...start.waiting, reason: publicReason(start.waiting.reason) }
  }
  const seen = seenMachineIds(visible)
  visible.conversations = visible.conversations.map(c => withSeenRequirement(c, seen))
  // A project agent's route notes the accounts PMs run on, on machines it may see.
  if (actor.kind === 'agent' && visible.machines?.length) {
    const machines = new Set(visible.machines.map(m => m.machineId))
    visible.pmAccounts = pmAccounts(state, actor).filter(a => machines.has(a.machineId))
  }
  return visible
}
