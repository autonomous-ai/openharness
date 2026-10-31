import { expireRemovals, LASTING_TEAM_REFUSALS, machineContribution, machineObservationSchema, slotCounter, machineTeamWork, preparableStart, readingOnly, recordAgentPresence, removalPreview, startPreparing, storedObservation, swarmGridRow, teamAccountRequired, teamWorkRefusal, type MachineObservation } from './machines.js'
import { readingClearsSuspensions, suspendedEngines } from './engineHealth.js'
import { BUDDY_OWN_MACHINE_REFUSAL } from './buddyContract.js'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { Machine, Prisma, PrismaClient, SuperTabDelivery, SuperTabMessage } from '@prisma/client'
import type { AuthUser } from '../lib/ssoAuth.js'
import { machineAlive } from '../lib/prisma.js'
import { isTeamSession, teamMachine, TEAM_SESSION_LIMITED, TEAM_SESSION_MESSAGE } from '../lib/teamSession.js'
import { machineShareGrant, sharedVia } from '../lib/machineSharePolicy.js'
import { machineBillingAllowsDataPlane } from '../lib/billingState.js'
import { applyCommand, authorizeCommandAccess, IGNORED_NOTE, LOOP_NOTICE_AT, mayResumeStart, operationSchema, PAIR_CHAIN_LIMIT, postable, ruleProject, type Command, type CommandContext } from './commands.js'
import { redactCredentials } from './credentials.js'
import type { AvatarUpload } from './profile.js'
import { reactionCounts, type ReactionTarget } from './reactions.js'
import { agentOpenDeliveries, compactedDelivery, deliveredCopies, messagesById, messagesPast, OPEN_DELIVERY, type MessageEdge, pageDeliveries, pageReactions, pageThreads, refreshReplies, type PageDelivery } from './pageReads.js'
import { restoreDelivery } from './deliveryCompaction.js'
import { threadSummaries } from './threads.js'
import { attachmentMime, attachmentName, AttachmentTooLarge, AVATAR_PURPOSE, AVATAR_TYPES, checkedType, directUploads, errorCode, HOURLY_UPLOAD_BYTES, HOURLY_UPLOADS, MAX_ATTACHMENT_BYTES, MAX_AVATAR_BYTES, MAX_FORM_ATTACHMENT_BYTES, objectKeyFor, peekType, PENDING_UPLOAD_PURPOSE, publicUrl, TOO_LARGE_MESSAGE, trimPrefix, typeFromHead, UPLOAD_LINK_MS,
  type Attachment, type Attachments, type AttachmentStore, type AvatarStore } from './attachments.js'
import { randomBytes } from 'node:crypto'
import type { Readable } from 'node:stream'
import { logger } from '../utils/logger.js'
import { retryTransient } from './retry.js'
import { recordReload } from './retryStats.js'
import { buddyChatId, swarmBuddyChatId, type ChosenBuddyName } from './buddies.js'
import { buddyPerson, canReadAgent, canReadGroup, canWatchAgent, groupProject, ledProject, onTeamAccount, projectOf, projectsOf, agentProjectId, readConversation, readProject, skillModeOf, startProject, type ProjectVisibility } from './projects.js'
import { bindSession, makeProjectPrivate } from './sessionScope.js'
import { SESSION_ENDED_KIND, sessionContext, sessionReadsRow, type ContextRow } from './buddySessions.js'
import { isBuddy, isBuddyChat, isBuddyReader, refuseBuddyRouting, routingRow } from './buddies.js'
import { lostReasonWithoutMachine } from './lostReason.js'
import { LEAD_NAME } from './leadStart.js'
import { deleteInstructions, instructionsId, readNotes, revisionId, writeInstructions, writeNotes } from './instructionsStore.js'
import { coordinatorNameOf, FIRST_INSTRUCTIONS, FIRST_SUMMARY, liveNotes, MAX_REVISIONS } from './instructions.js'
import { INSTRUCTIONS_TEMPLATE } from './instructionsTemplate.js'
import { confidentialSessions, otherRegistrations, recordConfidential } from './confidential.js'
import { answersRequest, dirtyGroups, noteWorkChanges, projectUpdateRequest, UNANSWERED_REQUEST_MS } from './projectUpdates.js'
import { cloneData } from './cloneData.js'
import { digestDue, digestMessageId, digestOf, digestRequest, digestSince } from './digest.js'
import { judgedMachines, loseTasks, nextLossAt, sweepForLead, sweepLiveness, SWEEP_EVERY_MS, unpurgedNotice } from './liveness.js'
import { archivable, archiveLine, idleNotices, reviewClosable, reviewCloseLine, reviewPullRequests } from './tidy.js'
import { clock, insertParts, loadActive, loadLightGroups, loadMachineParts, loadObserved, reassemble, split, type GroupData, type HeadData, type MachineData, type Part, type SwarmParts } from './parts/index.js'
import { groupsBy, listingDrops, quietSince, readBy, withoutHints } from './parts/indexed.js'
import { memberSwarms } from './swarmRows.js'
import { commitParts, indexesOf, numberMessages, type Touch, type Written } from './parts/commit.js'
import { loadDeliveryParts } from './parts/light.js'
import { guardedWrite, partId } from './parts/write.js'
import { retryable } from './retry.js'
import { touchesFor } from './parts/touches.js'
import { freeze, readStamps, stampOwed, swarmReadCache, swarmTransaction, type CacheView, type SwarmCache } from './cache.js'
import { countReport, DEADLINE_CAP_MS, localReportMemory, RECORD_TTL_MS, type ReportMemory, type ReportRecord } from './machineReports.js'
import { DIRECT, readLastChangedAt, readParts, type ReadNamed } from './cachedReads.js'
import { revokeNativeContexts, SuperTabNativeStore } from './native.js'
import { activeMember, addMember, hasWorkspaceAccess, listWorkspaces, memberId, WORKSPACE_ACCESS_REVOKED, workspaceForNewSwarm, requireWorkspaceAccess, requireWorkspaceRole, SwarmWorkspaces } from './workspaceStore.js'
import { WORKSPACE_LABEL, type WorkspaceRole } from './workspaces.js'
import {
  activeWork, actorKey, agent, agentOnly, appendPullRequestUrls, author, conversation, createSuperTab, fail, person, stableId, visibleState, finishWorker,
  SuperTabError, isLeads, knownKind, parkLaterConversations, type Actor, type Agent, type Assignment, type Author, type CommandEffects, type Conversation, type MessageDraft, type Person, type SuperTabState,
} from './model.js'
import { QUIET_CLAIM, type HoldReason } from './holdReason.js'
import { stuck } from './deliverySettle.js'
import { agentDisplayName } from './agentNames.js'
import { endedHolds, HOLDING, startedHolds, type WorkHold } from '../github/holds.js'
import { accrueLent, addLent, lentAgents } from './leaderboard/lent.js'
import { mayDrive, TERMINAL_ANSWER_MS, TERMINAL_EXPIRY_MS, TERMINAL_PICKUP_MS, TERMINAL_RECHECK_MS, type TerminalEffect } from './terminal.js'
import { costRows, failedStarts, summarizeCosts } from './costs/read.js'
import { APPROVE, approvedLine, localDate, MAX_PROPOSALS, proposalQuestion, proposalTitle, REASK_DAYS, reflectionMessageId, routingReflection, type Proposal, type ReflectionInput } from './costs/reflection.js'
import { readEvidence, recordEvidence } from './evidence/store.js'
import { closeAssignment, closeUnassignedStart, LIST_SIZE, newestConversations, newestDecisions, readDecision, recentDecisions, recordAttempts, timedDecisionOf, writeRouteEffects } from './routeDecisions.js'
import { dropHeldTags, listMentions, markDone, mentionsWaiting, openTags, readMention, resolveByReply, resolveWhenWorked, writeMentions } from './mentions.js'
import { answerable, askDecisions, MAX_OPEN_DECISIONS, REFLECTION_DECISION, reflectionDecisions, expireReflections, fullFor, listDecisions, type DecisionList, readAskedDecision, recordAnswer, repeatOf, waitingFor, waitingIn, waitingInProject, writeDecisions } from './decisions.js'
import { CATCH_UP_SCAN, catchUpSummary, type CatchUp } from './catchUp.js'
import { recordMessageRead, type MessageReadKey } from './messageReadStats.js'
import { DEFAULT_ROUTING_POLICY, type RoutingPolicy } from './routingPolicy.js'
import { catalogRead } from './catalog.js'
import { invitedSwarms } from './invitedSwarms.js'
import { authenticatedEmail, authorizeSwarmJoin, configureSharing, joinSwarmSchema, requireSharingOwner,
  saveSharingSchema, sharingDetails, type JoinSwarm, type SaveSharing } from './sharing.js'

type Transaction = Prisma.TransactionClient
type ReactCommand = Extract<Command, { type: 'message.react' }>
const reactionId = (tabId: string, actor: Actor, command: ReactCommand) => stableId(tabId, command.messageId, actorKey(actor), command.emoji)
const json = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue
type SendCommand = Extract<Command, { type: 'message.send' }>
type ProposeCommand = Extract<Command, { type: 'buddy.propose' }>
// Prisma on MongoDB: `usedBy: null` alone misses rows that never had the field.
const unused = { OR: [{ usedBy: null }, { usedBy: { isSet: false } }] }
const unproposed = { OR: [{ proposedBy: null }, { proposedBy: { isSet: false } }] }
const PROPOSED = 'This file already went with a proposal. Ask your owner to send it in your chat again.'
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
/** The fields of a Swarm's row the store reads. A migrated row still keeps its whole old state (`legacyState`, about 1 MB
 *  for a busy Swarm) until the maintenance script removes it, and every command and read loads this row. */
const SWARM_ROW = { id: true, ownerId: true, revision: true, format: true } satisfies Prisma.SuperTabSelect
export type SwarmRow = Prisma.SuperTabGetPayload<{ select: typeof SWARM_ROW }>
/** A Swarm whose state still waits for its split into parts (design section 6.1) is not served until it is split. */
function requireParts(row: SwarmRow): SwarmRow {
  if (row.format !== 2) fail('SWARM_MIGRATING', 'This Swarm is being updated. Try again in a moment.', 503)
  return row
}

/** What a command or read works on: the index row, the parts it loaded, and the state reassembled from them. */
export interface Loaded { row: SwarmRow; parts: SwarmParts; state: SuperTabState }
/** Groups, agents, projects and starts a command names, loaded even when dormant or finished (design section 3.1). */
export interface Named { groupIds?: string[]; agentIds?: string[]; projectIds?: string[]; startIds?: string[]; startAgentIds?: string[]; allGroups?: boolean; includeRecentStarts?: boolean }

/** The groups, agents, projects and starts a command names in its own fields (design section 3.1). */
/** Commands that register a session or can make one a Lead or a private member: checked against the other Swarms'
 *  registrations (projects.ts requireSingleRegistration). A rebind is refused onto any terminal registered elsewhere already. */
const REGISTERS = new Set(['agent.add', 'agent.started', 'conversation.agent', 'conversation.create', 'project.create'])
/** The session a command registers, when it names one. */
function registeredBy(state: SuperTabState, command: Command): Array<{ machineId: string; harnessId: string }> {
  if (command.type === 'agent.add') return [{ machineId: command.machineId, harnessId: command.harnessId }]
  if (command.type !== 'agent.started') return []
  const start = state.starts?.find(s => s.id === command.startId)
  return start ? [{ machineId: start.request.machineId, harnessId: command.harnessId }] : []
}

function namedFor(command: Command): Named {
  const has = (key: string) => key in command
  const field = (key: string) => (command as Record<string, unknown>)[key] as string | undefined
  const groupIds = [field('conversationId'), command.type === 'agent.start' ? command.request.conversationId : undefined,
    command.type === 'conversation.create' ? command.reviewOf : undefined,
    'askedIn' in command ? command.askedIn?.conversationId : undefined].filter((id): id is string => !!id)
  // Deleting a project or changing who reads it reaches every one of its groups, dormant ones too: their terminal
  // contexts are revoked from the groups the command loaded (native.ts revokeNativeContexts).
  return { groupIds, startIds: has('startId') ? [field('startId')!] : [],
    projectIds: command.type === 'project.delete' || command.type === 'project.sharing' ? [command.projectId] : [] }
}

/** What a receipt keeps of a command's reply besides its result: the parts it wrote and when (design section 4.7). */
interface ReceiptParts { written: Written[]; lastChangedAt: number }
const receiptParts = (written: Written[], lastChangedAt: number): ReceiptParts => ({ written, lastChangedAt })

/** A stored receipt's reply, the same as the first one; a receipt from before parts gives its tab revision instead. */
function replyOf(prior: { revision: number; result: unknown; parts: unknown }) {
  const kept = prior.parts as ReceiptParts | null
  return { result: prior.result as Record<string, unknown>, parts: kept?.written ?? [],
    ...(kept ? { lastChangedAt: kept.lastChangedAt } : prior.revision ? { legacyRevision: prior.revision } : {}) }
}

/**
 * What a delivery claim, ack or hold touches (spec ruling 9, narrowed). Removing the receiver or an agent sender, or
 * either changing generation, cancels this delivery row, which the claim writes: they conflict on the row. A person
 * sender can also lose the conversation without leaving (project sharing, a new audience), and only their part says so.
 * Touching the receiving agent made every claim of a Lead's deliveries conflict with the others and with the Lead's own
 * posts (benchmark, mixed lane: the Lead's calls ran out of retries).
 */
function deliveryTouches(delivery: SuperTabDelivery, state: SuperTabState): Touch[] {
  const touches: Touch[] = delivery.authorKind === 'person' ? [{ kind: 'member', key: delivery.authorId }] : []
  // A Buddy receives only while its person reads there (buddyNews.ts): their part guards the delivery, so taking the
  // project from them while a claim is in flight makes it check again (security review 1 of #2178).
  const person = state.agents.find(a => a.id === delivery.agentId)?.buddyOf?.personId
  // In the Buddy's own chat its person is also the sender: one part is touched once, or the claim's second guarded write of
  // the same part version conflicts every retry and no message of theirs ever reaches the Buddy (prod 10-30, v1.3.71).
  if (person && !touches.some(t => t.kind === 'member' && t.key === person)) touches.push({ kind: 'member', key: person })
  return touches
}

/** Loads one Swarm's parts and the state commands run on. Reads never write (design ruling R8); the migration rebuilt
 *  every group's link list from its history. The state shares the loaded records, frozen: a command changes its own copy
 *  (commands.ts applyCommand), and the parts stay what the write is compared with (parts/commit.ts). */
export async function loadRow(tx: Transaction, row: SwarmRow, named: Named = {}): Promise<Loaded> {
  return loadedFrom(row, await loadActive(tx, row.id, named))
}

const DAY_MS = 24 * 60 * 60_000
/** Where a project's routing reflection goes: its project chat, under its Lead. None in a paused Swarm or without a Lead. */
function reflectionPlace(state: SuperTabState, projectId: string) {
  const project = projectsOf(state).find(p => p.id === projectId)
  const chat = project && state.conversations.find(c => c.id === project.leadConversationId)
  const lead = chat?.leadId ? state.agents.find(a => a.id === chat.leadId) : undefined
  return state.paused || !project || !chat || !lead ? null : { project, chat, lead }
}

function loadedFrom(row: SwarmRow, parts: SwarmParts): Loaded {
  freeze(parts)
  const state = reassemble(parts, { share: true })
  parkLaterConversations(state)
  return { row, parts, state }
}

/**
 * Retrying a transaction never repeats a host action. All effects here are durable database writes.
 *
 * Every command rewrites the whole Swarm row, and a busy Swarm is written every few seconds: on 2026-10-26 a
 * 1.16 MB row (revision 213,9xx) lost all five back-to-back retries of a person's `agent.add` to its agents' and
 * hosts' writes, and the form showed a 500 on every Check status. Retries now wait, growing and jittered, and a
 * command that still cannot get in says the Swarm is busy, as a 503: every client retries a 5xx, while a 4xx is final
 * (a 409 would stop a host's terminal recording for good, cli superTabs/native.ts). The 5 s default
 * transaction timeout also expired on that row's reads; Mongo's own transient errors (a lock wait) retry too.
 */
export async function transaction<T>(db: Pick<PrismaClient, '$transaction'>, body: (tx: Transaction) => Promise<T>,
  sleep: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms))): Promise<T> {
  let hintless = false, staleIndex: unknown = null
  return retryTransient(async () => {
    let committed: Array<() => void> = []
    const drops = listingDrops()
    try {
      // The cache's stamps are bumped, and awaited, once the attempt commits (cache.ts); after-commit work runs after them.
      const run = () => swarmTransaction(db, tx => { committed = []; pendingCommits.set(tx, committed); return body(tx) }, TRANSACTION_OPTIONS)
      const result = await (hintless ? withoutHints(run) : run())
      for (const callback of committed) {
        try { callback() } catch (error) { logger.warn('[super-tab] after-commit callback failed', { error: error instanceof Error ? error.message : String(error) }) }
      }
      return result
    } catch (error) {
      // A read in this attempt named an index removed since the last listing (parts/indexed.ts): the next attempts name none.
      if (listingDrops() !== drops) { hintless = true; staleIndex = error }
      throw error
    }
  }, sleep, error => error === staleIndex)
}
/** The longest a failed claim's record may hold up the busy answer. */
const RECORD_FAILED_CLAIM_MS = 2_000
const TRANSACTION_OPTIONS = { maxWait: 5_000, timeout: 15_000 }
/** Each attempt's after-commit work, by that attempt's client: a retried attempt's list is dropped with its client. */
const pendingCommits = new WeakMap<Transaction, Array<() => void>>()

/**
 * Runs `callback` once the transaction `tx` belongs to has committed, never for an attempt that failed or was retried. What
 * others hear of a write must follow its commit: told earlier, a reader could look before the write is visible, or hear of
 * one rolled back. The Swarm cache's stamp (Stability 2.2) and the delivery push (Stability 2.4) both go through here. It
 * runs synchronously after the commit; async work is fired and forgotten, and a throw is logged, never failing the write.
 */
export function afterCommit(tx: Transaction, callback: () => void): void {
  const pending = pendingCommits.get(tx)
  if (!pending) throw new Error('afterCommit needs a client from a Swarm transaction (store.ts transaction).')
  pending.push(callback)
}
const openDeliveries = agentOpenDeliveries

/** The grants a held answer checks again: the agent's own and those of the agents that sent what it allowed. */
function grantsOf(state: SuperTabState, agentId: string, allowed: SuperTabDelivery[]) {
  const grants: Record<string, AgentGrant> = {}
  for (const id of [agentId, ...allowed.filter(d => d.authorKind === 'agent').map(d => d.authorId)]) {
    const found = state.agents.find(a => a.id === id)
    if (found) grants[id] = { contributorId: found.contributorId, machineId: found.machineId, machineOwnerId: found.machineOwnerId, hostGrant: found.hostGrant ?? null,
      ...(onTeamAccount(state, found) ? { team: true as const } : {}) }
  }
  return { swarm: { workspaceId: state.workspaceId, environment: state.environment }, grants }
}

const sameIds = (rows: SuperTabDelivery[], ids: string[]) => rows.length === ids.length && rows.every(r => ids.includes(r.id))

/** Whose full poll `deliveries` remembers: the caller, and a team session apart, as it may act only for its own machine's
 *  agents (teamHost) while its person may act for any of theirs. */
const pollKey = (user: AuthUser, tabId: string, agentId: string) =>
  `${tabId}:${agentId}:${user.sub}${user.harnessSessionKind === 'team' ? `:team:${user.harnessComputerId ?? ''}` : ''}`

/** Logged, never thrown: without the memory the delivery poll just runs in full. */
const pollMemoryFailed = (error: unknown): void => {
  logger.warn('[super-tab] delivery poll memory unavailable', { error: error instanceof Error ? error.message : String(error) })
}
/** Callers kept for the quiet delivery poll before the stale ones are dropped. */
const POLLED_CAP = 5_000
/** How many of a Swarm's newest decisions the route list reads, as conversation ids, to find a reader's hundred after the first hundred fell short. */
const WIDE_WINDOW = 5 * LIST_SIZE

/** A Lead's start dispatches within seconds of being recorded; one still undispatched after this long was given up. */
export const ABANDONED_START_MS = 15 * 60_000

/** The commands that start, assign or route work, which read which of the tab's machines are Team machines. */
const TEAM_WORK_COMMANDS = new Set<Command['type']>(['agent.start', 'lead.start', 'agent.startDispatch', 'work.assign', 'conversation.agent', 'route.record', 'route.override'])
/** Whether an agent's command adds an agent to a task by opening it, by posting into it or by naming one there: those joins
 *  check team access as conversation.agent does (commands.ts teamJoin). An ordinary post reads no machine rows. */
const addsAgent = (state: SuperTabState, actor: Actor, command: Command): boolean => {
  // A person's agent.add naming a session already in the Swarm checks it as conversation.agent does (security review S2).
  if (command.type === 'agent.add') return state.agents.some(a => a.id === stableId(command.machineId, command.harnessId))
  if (actor.kind !== 'agent') return false
  if (command.type === 'conversation.create') return true
  if (command.type !== 'message.send') return false
  const group = state.conversations.find(c => c.id === command.conversationId)
  return !group || [actor.agentId, ...command.recipientIds].some(id => !group.agentIds.includes(id))
}

/** Starts on a not-yet-contributed machine that never dispatched, dated by their own operation receipt (starts carry no
 *  time of their own). A dispatched start may have a native session coming, so it is never counted. */
async function abandonedStarts(tx: Transaction, tabId: string, state: SuperTabState, machineId: string, now: number) {
  const candidates = (state.starts ?? []).filter(s => s.request.machineId === machineId && !s.poolGeneration && !s.dispatched && !s.harnessId && !s.error)
  if (!candidates.length) return []
  const receipts = await tx.superTabOperation.findMany({ where: { id: { in: candidates.map(s => stableId(tabId, s.actorKey, s.id)) } },
    select: { id: true, createdAt: true } })
  const recorded = new Map(receipts.map(r => [r.id, r.createdAt.getTime()]))
  return candidates.filter(s => (recorded.get(stableId(tabId, s.actorKey, s.id)) ?? 0) <= now - ABANDONED_START_MS).map(s => s.id)
}

export interface SuperTabStoreHooks {
  /** Tasks that stopped being in an agent's hands with this write (github/holds.ts): done, cancelled, stopped, given to
   *  another attempt, or their agent removed. Called after the write commits; it must not throw. */
  workEnded?: (tabId: string, ended: WorkHold[]) => void
  /** Tasks newly in progress, or in progress again under the same id (resumed after a usage limit): GitHub tokens forget
   *  that such a task ended (github/tokens.ts resume). */
  workStarted?: (tabId: string, started: WorkHold[]) => void
  /** No Harness GitHub App on this server: a Mac's Harness Team account joins no Swarm and takes no teammates' work, since
   *  it has no git login to fetch or push with (commands.ts `teamAccountsIdle`). */
  teamAccountsIdle?: boolean
  /** A terminal request was answered or refused, after the commit (lib/bus.ts tells every instance). It must not throw. */
  terminalAnswered?: (requestId: string) => void
  /** Calls `onChange` when that request is answered or refused on any instance; resolves to the call that stops listening. */
  watchTerminal?: (requestId: string, onChange: () => void) => Promise<() => void>
  /** Who may watch an agent's terminal in this Swarm may have narrowed, after the commit: its observer sockets check again
   *  at once (lib/observerWs.ts). It must not throw. */
  accessChanged?: (tabId: string) => void
  /** These native sessions just turned confidential, after the commit: their shares and links, which follow no Swarm of
   *  theirs, check again at once (routes/harnessLinks.ts tellSessionViewers). It must not throw. */
  sessionsConfidential?: (sessions: Array<{ machineId: string; harnessId: string; machineOwnerId: string }>) => void
  /** The read cache this store reads through (cache.ts): the process's by default, none when null. */
  readCache?: SwarmCache | null
  /** When each caller's full delivery poll last succeeded, shared by every server (Redis in production, pollMemory.ts). Left
   *  out, this server remembers alone. */
  polls?: PollMemory
  /** What each machine's full report saw, for its next reports, and each Swarm's sweep clock, shared by every server (Redis
   *  in production, machineReports.ts). Left out, this server remembers alone. */
  reports?: ReportMemory
  /** A delivery now waits for this agent, committed: its machine's daemon socket tells its host to read it at once
   *  (lib/swarmDeliveryPushes.ts). Called after the write commits; it must not throw. */
  deliveriesWaiting?: (waiting: DeliveriesWaiting) => void
  /** A commit changed what these machines' hosts read (parts/commit.ts hostsToTell): each machine's daemon socket tells its
   *  host to read its Swarm changes now (lib/swarmHostPushes.ts). Called after the write commits; it must not throw. */
  hostsChanged?: (change: HostsChanged) => void
  /** A commit changed a Swarm these people are in, or were in before it: each one's apps read it again
   *  (lib/swarmClientPushes.ts). Called after the write commits; it must not throw. */
  swarmChanged?: (change: SwarmChanged) => void
}

/** A report call's host checks that need no Swarm (SuperTabStore.machineHost): the caller's account row for the machine. */
export interface MachineHost { owned: Machine | null }
/** A machine part as a reading-only report reads it (parts/load.ts loadMachineParts). */
export interface MachinePart { version: number; deleted: boolean; data: MachineData }

/** Which people's apps should read a Swarm again, the commit's time, and which of its stamps moved. */
export interface SwarmChanged { tabId: string; userIds: string[]; lastChangedAt: number; parts: Array<'main' | 'machine'> }

/** Which machines' hosts should read a Swarm's changes, and the commit's time. */
export interface HostsChanged { tabId: string; machineIds: string[]; lastChangedAt: number }

/** Which agent, of which Swarm, on which machine, has a delivery to read. */
export interface DeliveriesWaiting { machineId: string; tabId: string; agentId: string }

/** What of a Swarm an agent's grant is checked against (SuperTabStore.grantHolds). */
export type SwarmGrant = Pick<SuperTabState, 'workspaceId' | 'environment'>
/** What of an agent its grant is checked against: who lent which machine to whom, under which share grant. */
/** `team`: the agent runs in a Harness Team account, by the Swarm's own record (projects.ts onTeamAccount). */
export type AgentGrant = Pick<Agent, 'contributorId' | 'machineId' | 'machineOwnerId' | 'hostGrant'> & { team?: true }

/** A caller's last full delivery poll: when it succeeded and, when it found deliveries open, what it found. */
export interface Polled {
  at: number
  /** The open deliveries it read, those of them it let reach the agent, and the Swarm's main stamp (cache.ts) read before
   *  it loaded: while all three are unchanged, a held delivery is answered without loading the Swarm (deliveries). The
   *  grants of the agent and of the agents that sent what it allowed, by agent id, are checked again on every such answer:
   *  they rest on Workspaces, machines and shares, which no Swarm write records. */
  open?: { stamp: number; seen: string[]; allowed: string[]; swarm: SwarmGrant; grants: Record<string, AgentGrant> }
}

/** Where `deliveries` remembers each caller's last full poll. Either call may throw: the poll then runs in full. */
export interface PollMemory {
  get(key: string): Promise<Polled | undefined>
  /** Remembered for SWEEP_EVERY_MS at least; an older entry is never read. */
  set(key: string, polled: Polled): Promise<void>
}

/** One server's own memory: with several servers behind a load balancer, each runs its own full polls. */
export function localPollMemory(now: () => number): PollMemory {
  const polled = new Map<string, Polled>()
  return {
    get: async key => polled.get(key),
    set: async (key, value) => {
      polled.set(key, value)
      if (polled.size > POLLED_CAP) for (const [k, last] of polled) if (now() - last.at >= SWEEP_EVERY_MS) polled.delete(k)
    },
  }
}

/** Persistent coordination. Host adapters own execution and must confirm their local session grants. */
/** The routing decision a command names. `decision.answer` names a person's decision instead (decisions.ts). */
const routeDecisionOf = (command: Command): string | undefined => command.type === 'decision.answer' ? undefined
  : 'decisionId' in command ? command.decisionId : 'routeDecisionId' in command ? command.routeDecisionId : undefined

const machineKey = (environment: string, machineId: string, ownerId: string) => `machine:${environment}:${machineId}:${ownerId}`
/** Whether a Swarm's own record says [machineId] is a Harness Team account's: its pool names a Mac, or an agent there
 *  joined as one (projects.ts onTeamAccount). An ordinary sign-in connecting as that computer resets its account row's mark,
 *  never this (security re-check 2 of #2089). */
export const teamByRecord = (state: SuperTabState, machineId: string): boolean =>
  !!state.machines?.find(m => m.machineId === machineId)?.hostMachineId || state.agents.some(a => a.machineId === machineId && onTeamAccount(state, a))
/** A Team account's machine refused to its owner's own sign-in (notTeamMachine). */
export const TEAM_HOST_ONLY = 'TEAM_HOST_ONLY'
export const TEAM_HOST_ONLY_MESSAGE = 'Only this computer\'s Harness Team account runs its Swarm agents. Its owner\'s own sign-in cannot act for them.'

/**
 * What agent grant checks read, kept for one request only. A host read checks every agent on its machine, mostly for the
 * same few contributors: without this each agent cost its machine, share, contributor and Workspace membership again
 * (4 point queries per agent on a shared machine, Diego's review 2026-10-28). Never kept past the request, so a revoked
 * share or a Workspace removal drops the rows on the next read, as before.
 */
export class GrantReads {
  private readonly answers = new Map<string, Promise<unknown>>()
  /** `machine`: a live machine the request already read with the grant's own filter (machineAlive), its host's. */
  constructor(machine?: Machine) {
    if (machine) this.answers.set(machineKey(machine.autonomousEnv, machine.machineId, machine.userId), Promise.resolve(machine))
  }

  once<T>(key: string, read: () => Promise<T>): Promise<T> {
    const known = this.answers.get(key) as Promise<T> | undefined
    if (known) return known
    const answer = read()
    this.answers.set(key, answer)
    return answer
  }
}

/** Another Swarm too busy to say whether a shared session is confidential there: the list hides those shares and lists the rest,
 *  as a busy load of a share's own Swarm hides its shares (Lead, review of #1973), rather than failing every share. */
const busyListing = (tabId: string) => logger.warn('[super-tab] shares list: a busy Swarm hid the shares it could not answer for', { tabId })

/** Buddy news (buddyNews.ts) is the one delivery to an agent its row does not list among its recipients: a mark that holds
 *  after the Buddy is removed or replaced (security review 1 of #2178). */
const buddyNews = (message: Pick<SuperTabMessage, 'recipientIds'>, delivery: Pick<SuperTabDelivery, 'agentId'>): boolean =>
  !message.recipientIds.includes(delivery.agentId)
/** Whether `actor` reads a row of a conversation they read: an agent-only notice is listed for its own recipient alone, and a
 *  Buddy reads its project's workgroups but never how work is routed: a route row names the machines that could run it and why
 *  others could not (security review 2 of #2115). */
const readsRow = (actor: Actor, buddy: boolean) => (m: Pick<SuperTabMessage, 'source' | 'recipientIds'>): boolean =>
  (!agentOnly(m.source, m.recipientIds) || (actor.kind === 'agent' && m.recipientIds.includes(actor.agentId))) && !(buddy && routingRow(m.source))

/** A page shows 100 rows and reads a 101st to know there are more. After the first batch, each reads the rows still missing at
 *  the rate this reader has seen them so far, plus a tenth; twice what was read while none was readable; at least MIN_BATCH,
 *  at most MAX_BATCH (spec 5 A2). One hidden row costs 10 more rows, not a second batch of 101; a chat mostly of notes to
 *  others fills in about two batches, reading about what the old 101-row batches read. */
const PAGE_BATCH = 101, MIN_BATCH = 10, MAX_BATCH = 400
const nextBatch = (decoded: number, shown: number): number => Math.min(MAX_BATCH, Math.max(MIN_BATCH,
  shown ? Math.ceil((PAGE_BATCH - shown) * decoded / shown * 1.1) : 2 * decoded))
/** How a messages read counts in the read log (messageReadStats.ts). */
const readerKind = (actor: Actor, buddy: boolean): MessageReadKey['reader'] => buddy ? 'buddy' : actor.kind
const sessionKind = (user: AuthUser): MessageReadKey['session'] => user.harnessSessionKind ?? 'sso'
/** A message's receipts in the order they were written, live or compacted alike: by creation, one write's in the order of
 *  its recipients (store.ts writeMessages), then by id. */
const receiptOrder = (m: Pick<SuperTabMessage, 'recipientIds'>) => (a: PageDelivery, b: PageDelivery): number => {
  const place = (d: PageDelivery) => { const at = m.recipientIds.indexOf(d.agentId); return at < 0 ? Infinity : at }
  return a.createdAt.getTime() - b.createdAt.getTime() || place(a) - place(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

/** A row as a Buddy reads it, without the machine it names (security reviews of #2115): a lost task's reason, in its text and
 *  its source (liveness.ts loseTask), a machine leaving the Swarm (machines.ts removalEnded, commands.ts removeMachine), and
 *  the machine a Product Manager started on (leadStart.ts leadJoined; Diego, 10-30) or a removed session is still held on
 *  (liveness.ts unpurged; review 2 of #2258). */
function withoutMachineNames(m: SuperTabMessage): SuperTabMessage {
  const source = m.source as { kind?: unknown; reason?: unknown; machine?: unknown } | null
  if (source?.kind === 'work-lost' && typeof source.reason === 'string') {
    const reason = lostReasonWithoutMachine(source.reason)
    return reason === source.reason ? m : { ...m, text: m.text.split(source.reason).join(reason), source: { ...source, reason } as SuperTabMessage['source'] }
  }
  if ((source?.kind === 'machine-left' || source?.kind === 'machine-removed' || source?.kind === 'system') && typeof source.machine === 'string' && source.machine) {
    const { machine, ...rest } = source
    const text = m.text.startsWith(machine) ? `A machine${m.text.slice(machine.length)}` : m.text
    return { ...m, text: text.split(machine).join('a machine'), source: rest as SuperTabMessage['source'] }
  }
  // A row stored before its source named the machine: only the server writes system rows, so the machine sits where its line
  // puts it. A joined row (leadJoined) may end with the model it runs (#2274), which stays; so does a removed session's notice
  // (liveness.ts unpurged) around its machine.
  if (source?.kind === 'system' && source.machine === undefined && !m.text.includes('\n')) {
    if (m.text.startsWith(LEAD_STARTED) && m.text.endsWith('.')) {
      const rest = m.text.slice(LEAD_STARTED.length), asked = rest.indexOf(LEAD_ASKED)
      return { ...m, text: `${LEAD_STARTED}a machine.${asked < 0 ? '' : rest.slice(asked + 1)}` }
    }
    if (m.text.startsWith(UNPURGED_HEAD) && m.text.endsWith(UNPURGED_TAIL)) return { ...m, text: unpurgedNotice('a machine') }
  }
  return m
}
const LEAD_STARTED = `${LEAD_NAME} started on `, LEAD_ASKED = '. It asked for '

/** A row as a Buddy reads it: without the machine it names, and an agent author without its membership's generation, which
 *  matches its person's and so says whose agent wrote it (delta review 1 of #2258). A person author's stays: the Buddy's host
 *  compares it to tell its own person's message (cli host.ts). */
function rowForBuddy(m: SuperTabMessage): SuperTabMessage {
  const shown = withoutMachineNames(m)
  const author = authorForBuddy(shown.author as Author | null)
  return author === shown.author ? shown : { ...shown, author: author as SuperTabMessage['author'] }
}
/** An author as a Buddy reads it, in a row or among a thread's reply authors: an agent's without its membership. */
const authorForBuddy = <T extends Pick<Author, 'kind' | 'membershipGeneration'> | null>(author: T): T =>
  author?.kind === 'agent' && author.membershipGeneration ? { ...author, membershipGeneration: '' } : author
const [UNPURGED_HEAD, UNPURGED_TAIL] = unpurgedNotice('\0').split('\0') as [string, string]

/** Someone with no part in this Swarm: not in it, hosting none of its agents, contributing none of its machines and running
 *  none of its work. A refusal to them is answered as for a Swarm that does not exist (routes/superTabs.ts NOT_AVAILABLE):
 *  its words would say the Swarm is there. Anyone with a part keeps them. */
function stranger(state: SuperTabState, userId: string): boolean {
  return !state.people.some(p => p.id === userId) && !state.agents.some(a => a.machineOwnerId === userId)
    && !(state.machines ?? []).some(m => m.contributorId === userId)
    && !state.conversations.some(c => c.assignment?.execution.machineOwnerId === userId)
}
async function strangerRefusal<T>(state: SuperTabState, userId: string, check: () => T | Promise<T>): Promise<T> {
  try { return await check() } catch (error) {
    if (error instanceof SuperTabError && stranger(state, userId)) throw new SuperTabError(error.code, error.message, error.status, true)
    throw error
  }
}

/** A Workspace refusal to someone not in the Swarm (a Workspace admin need not be): the routes answer it as for a Swarm that
 *  does not exist (routes/superTabs.ts NOT_AVAILABLE), since its words would say the Swarm is there. Its members keep them. */
async function outsiderRefusal(state: SuperTabState, userId: string, check: () => Promise<void>): Promise<void> {
  try { await check() } catch (error) {
    if (error instanceof SuperTabError && !state.people.some(p => p.id === userId)) throw new SuperTabError(error.code, error.message, error.status, true)
    throw error
  }
}

export class SuperTabStore {
  readonly native: SuperTabNativeStore
  readonly workspaces: SwarmWorkspaces
  /** Where avatars are kept, whose links member reads carry (read/service.ts); null when avatar uploads are off. */
  get avatars(): AvatarStore | null { return this.attachments?.avatars ?? null }
  /** The folder avatar keys start with (attachments.ts `avatarPrefix`). */
  get avatarPrefix(): string { return trimPrefix(this.attachments?.avatarPrefix ?? this.attachments?.prefix ?? '') }
  /** No Harness GitHub App on this server: Team accounts take no teammates' work (SuperTabStoreHooks.teamAccountsIdle). Reads
   *  decide New Project's Product Manager host as its start does (read/views.ts). */
  get teamAccountsIdle(): boolean { return this.hooks.teamAccountsIdle === true }

  constructor(readonly db: PrismaClient, readonly now: () => number = Date.now,
    private readonly attachments: Attachments | null = null, private readonly hooks: SuperTabStoreHooks = {}) {
    this.polls = hooks.polls ?? localPollMemory(now)
    this.reports = hooks.reports ?? localReportMemory(now)
    this.native = new SuperTabNativeStore({
      transaction: body => transaction(db, body),
      load: (tx, user, tabId, groupIds) => this.load(tx, user, tabId, { groupIds }),
      save: (tx, loaded, next, stamp, touches) => this.save(tx, loaded as Loaded, next, stamp, touches),
      stamp: () => clock.next(),
      agentGrant: (tx, state, target) => this.agentGrant(tx, state, target),
      contribution: (tx, state, actor, command) => this.contribution(tx, state, actor, command),
      teamHost: (tx, user) => this.teamHost(tx, user),
      workspaceAccess: (tx, state, userId) => requireWorkspaceAccess(tx, state, userId),
      announce: (tx, waiting) => this.announce(tx, waiting),
    })
    this.workspaces = new SwarmWorkspaces(db, {
      transaction: body => transaction(db, body),
      leave: (person, tabId, operationId) => this.executeOnce(person, tabId, { operationId, command: { type: 'member.remove', userId: person.sub } },
        undefined, undefined, true),
      now,
    })
  }

  // ── A Mac's team account (lib/teamSession.ts) ────────────────────────────────────────────────────
  // Its daemon is signed in as the person, so `user.sub` alone would let it speak for the person and for every machine
  // of theirs. It may host only its own machine and speak only as the agents running there.

  /** The one machine a team session hosts for; null for any other sign-in. One with no machine to act for does nothing. */
  /** Shared with the read API (superTabs/read, design section 7.2). */
  async teamHost(tx: Transaction, user: AuthUser): Promise<string | null> {
    if (!isTeamSession(user)) return null
    return (await teamMachine(user, tx))?.machineId ?? fail(TEAM_SESSION_LIMITED, TEAM_SESSION_MESSAGE, 403)
  }

  /** A host route of a team session must name its own machine. */
  /** Shared with the read API (superTabs/read, design section 7.2). */
  /** [owned]: the machine's account row for this sign-in, when the caller already read it (machineAlive), so it is read once.
   *  [state]: a Swarm the request reads, whose own record of the machine counts too (teamByRecord). */
  async hostFor(tx: Transaction, user: AuthUser, machineId: string, owned?: Machine | null, state?: SuperTabState): Promise<void> {
    const team = await this.teamHost(tx, user)
    if (team !== null && team !== machineId) fail(TEAM_SESSION_LIMITED, TEAM_SESSION_MESSAGE, 403)
    if (team === null) await this.notTeamMachine(user, async () => owned !== undefined ? owned
      : tx.machine.findFirst({ where: { machineId, userId: user.sub, autonomousEnv: user.autonomousEnv, ...machineAlive } }), !!state && teamByRecord(state, machineId))
  }

  /**
   * A Harness Team account's machine is hosted, and its agents spoken for, by its team session alone (security review 2 of
   * #2089). It is a machine of its Mac owner's account, so the owner's ordinary sign-in passed every host check, and could
   * read every chat its Product Manager can, claim its deliveries and post as it, past every rule the Swarm keeps for it.
   * [row]: the machine's account row, read once with the request's others; [flagged]: an agent that joined on one.
   */
  private async notTeamMachine(user: AuthUser, row: () => Promise<Pick<Machine, 'sessionKind' | 'hostMachineId'> | null>, flagged = false): Promise<void> {
    if (isTeamSession(user)) return
    // The row's own mark, which an ordinary sign-in connecting as that computer resets (lib/adapterWs.ts), and the Mac it
    // names, which it keeps; and what the Swarm itself recorded ([flagged], security re-check 2 of #2089).
    const machine = flagged ? null : await row()
    if (flagged || machine?.sessionKind === 'team' || !!machine?.hostMachineId) {
      fail(TEAM_HOST_ONLY, TEAM_HOST_ONLY_MESSAGE, 403)
    }
  }

  /** What only the person does: a team session has no person to be. */
  private personOnly(user: AuthUser): void {
    if (isTeamSession(user)) fail(TEAM_SESSION_LIMITED, TEAM_SESSION_MESSAGE, 403)
  }

  /**
   * What a team session's agent may command beyond the Swarm's own rules for that agent: a machine is the person's to
   * contribute, pause or remove, and nothing may start, add, move or drive an agent on another machine. Messages and
   * work reports go to the Swarm as from any agent. An agent that is gone is left to the command's own answer.
   */
  private teamCommand(state: SuperTabState, team: string, user: AuthUser, command: Command): void {
    const refuse = () => fail(TEAM_SESSION_LIMITED, TEAM_SESSION_MESSAGE, 403)
    const onTeam = (agentId: string) => {
      const target = state.agents.find(a => a.id === agentId)
      if (target && target.machineId !== team) refuse()
    }
    switch (command.type) {
      case 'machine.contribute': case 'machine.pause': case 'machine.remove': case 'machine.engineResume': return refuse()
      case 'machine.cleaned': case 'tab.project': case 'agent.add':
        if (command.machineId !== team) refuse()
        return
      case 'agent.rebind':
        if (command.machineId !== team) refuse()
        return onTeam(command.agentId)
      case 'agent.start':
        if (command.request.machineId !== team) refuse()
        return
      // A coordinator carries on its agents' starts (commands.ts mayResumeStart): from here, by the Mac owner's grant, it
      // would launch, register or settle one on another of the owner's machines (security review L3). Elsewhere it only
      // fails one.
      case 'agent.startDispatch': case 'agent.started': case 'agent.startSettled': case 'route.modelResult': {
        const start = state.starts?.find(s => s.id === command.startId)
        if (start && start.request.machineId !== team) refuse()
        return
      }
      case 'agent.screen': case 'agent.input': case 'work.assign': case 'conversation.agent':
      case 'agent.release': case 'agent.stopLease': case 'agent.remove':
        return onTeam(command.agentId)
      case 'agent.sessionClosed': {
        const closing = state.closingSessions?.find(c => c.agentId === command.agentId && c.harnessId === command.harnessId && c.machineOwnerId === user.sub)
        if (closing && closing.machineId !== team) refuse()
        return
      }
    }
  }

  /** The machines of the Swarm's pending cleanups whose account is deleted or missing: no host of theirs can read the
   *  Swarm again to confirm (read/host.ts asks for a live account), so applyCommand drops their cleanups. */
  private async deletedMachines(tx: Transaction, state: SuperTabState): Promise<string[]> {
    const ids = [...new Set((state.machineCleanups ?? []).map(c => c.machineId))]
    if (!ids.length) return []
    const live = new Set((await tx.machine.findMany({ where: { machineId: { in: ids }, autonomousEnv: state.environment, ...machineAlive },
      select: { machineId: true } })).map(m => m.machineId))
    return ids.filter(id => !live.has(id))
  }

  /** The tab's contributed machines whose account row is signed in as a Harness Team account (`Machine.sessionKind`,
   *  lib/teamSession.ts): one of the two signs routing reads that a machine is a Team machine (machines.ts teamWorkCheck). */
  /** Shared with the read API (superTabs/read, design section 7.2). */
  async teamMachines(tx: Transaction, state: SuperTabState): Promise<string[]> {
    return (await this.machineFacts(tx, state)).team
  }

  /** The tab's contributed machines' account rows as they are now, in one indexed read: which are signed in as a Harness Team
   *  account, and the CLI version each one's daemon last connected with (`Machine.clientVersion`). A start records the
   *  version it was dispatched to, so routing can tell a machine updated since its failed starts (cli routeCommand.ts
   *  `stalled`): Mac Auto stayed out of every route after Harness bugs later fixed and released (2026-10-29). */
  async machineFacts(tx: Transaction, state: SuperTabState): Promise<{ team: string[]; versions: Record<string, string> }> {
    const ids = (state.machines ?? []).map(m => m.machineId)
    if (!ids.length) return { team: [], versions: {} }
    const rows = await tx.machine.findMany({ where: { machineId: { in: ids }, autonomousEnv: state.environment, ...machineAlive },
      select: { machineId: true, sessionKind: true, clientVersion: true } })
    return { team: rows.filter(r => r.sessionKind === 'team').map(r => r.machineId),
      versions: Object.fromEntries(rows.flatMap(r => r.clientVersion ? [[r.machineId, r.clientVersion] as const] : [])) }
  }

  /** This Swarm's contributed machines that are also contributed to a Swarm of another Workspace: their Harness Team account
   *  takes no teammate's work here (machines.ts teamWorkRefusal). One indexed read of the machines' parts, one of rows. */
  async otherWorkspaceMachines(tx: Transaction, state: SuperTabState): Promise<string[]> {
    const ids = (state.machines ?? []).map(m => m.machineId)
    if (!state.workspaceId || !ids.length) return []
    const elsewhere = await tx.swarmMachine.findMany({ where: { machineId: { in: ids }, deleted: false, contributed: true, tabId: { not: state.id } },
      select: { tabId: true, machineId: true } })
    if (!elsewhere.length) return []
    const rows = await tx.superTab.findMany({ where: { id: { in: [...new Set(elsewhere.map(e => e.tabId))] } }, select: { id: true, workspaceId: true } })
    const other = new Set(rows.filter(r => r.workspaceId && r.workspaceId !== state.workspaceId).map(r => r.id))
    return [...new Set(elsewhere.filter(e => other.has(e.tabId)).map(e => e.machineId))]
  }

  /** An older Desktop's account policy read: the built-in policy, whatever the person saved before (project instructions,
   *  phase 4: routing lives in each project's instructions). */
  async accountPolicy(user: AuthUser) {
    this.personOnly(user)
    return { policy: DEFAULT_ROUTING_POLICY, revision: 0, isDefault: true }
  }

  /** An older Desktop's account policy save: accepted and kept nowhere, answered with the default (project instructions,
   *  phase 4: routing lives in each project's instructions). A policy saved before stays, unread. */
  async saveAccountPolicy(user: AuthUser, _revision: number, _input: RoutingPolicy) {
    this.personOnly(user)
    return { policy: DEFAULT_ROUTING_POLICY, revision: 0, isDefault: true as const, ignored: true as const, note: IGNORED_NOTE }
  }

  /** The route's one read (project instructions, phase 4, decision 14): the model catalog with the benchmark priors and the
   *  prices under `catalog`, beside the built-in policy made from it, which an older CLI reads as before. An owner's saved
   *  policy and the tab's override stay in place, unread. Members and the Swarm's agents read it; a Buddy reads no routing.
   *  A person's read carries IGNORED_NOTE in `warnings`: an older Desktop shows them atop its routing dialog and reads no save's
   *  `note`. An agent's has none: the CLI's route copies them into every route it prints. */
  async tabPolicy(user: AuthUser, tabId: string, asAgentId?: string) {
    return transaction(this.db, async tx => {
      const { state } = await this.load(tx, user, tabId)
      const actor = await this.actor(tx, user, state, asAgentId)
      author(state, actor)
      refuseBuddyRouting(state, actor)
      return { policy: DEFAULT_ROUTING_POLICY, warnings: actor.kind === 'person' ? [IGNORED_NOTE] : [], overridden: [], override: null,
        account: DEFAULT_ROUTING_POLICY, catalog: catalogRead() }
    })
  }

  /** Shared with the read API (superTabs/read, design section 7.2). */
  async row(tx: Transaction, user: AuthUser, tabId: string) {
    return requireParts(await tx.superTab.findFirst({ where: { id: tabId, autonomousEnv: user.autonomousEnv }, select: SWARM_ROW }) ??
      fail('NOT_FOUND', 'This Super Tab is unavailable.', 404))
  }

  /** The Swarm a caller may address, loaded from its parts. */
  async load(tx: Transaction, user: AuthUser, tabId: string, named: Named = {}): Promise<Loaded> {
    return loadRow(tx, await this.row(tx, user, tabId), named)
  }

  /** One read's view of these Swarms' stamps (cache.ts), or none: reads then go to Mongo. */
  async view(tabIds: string[]): Promise<CacheView> {
    const cache = this.hooks.readCache !== undefined ? this.hooks.readCache : swarmReadCache()
    return cache ? cache.at(tabIds) : DIRECT
  }

  /**
   * A Swarm as a read works on it, outside any transaction: its parts through the read cache, in `loadRow`'s shape, sharing
   * the stored records (frozen when held). Only for reads: a command changes what it loads, and loads in its transaction.
   */
  async readLoad(user: AuthUser, tabId: string, named: ReadNamed = {}, view?: CacheView): Promise<Loaded> {
    const row = await this.row(this.db, user, tabId)
    const parts = await readParts(this.db, view ?? await this.view([tabId]), tabId, named)
    const state = reassemble(parts, { share: true })
    parkLaterConversations(state)
    return { row, parts, state }
  }

  /** Loads again with more named groups, agents or starts when the first load lacks one a command needs. */
  private async ensure(tx: Transaction, loaded: Loaded, named: Named): Promise<Loaded> {
    const has = (ids: string[] | undefined, present: (id: string) => boolean) => (ids ?? []).every(present)
    const { state } = loaded
    if (!named.allGroups && has(named.groupIds, id => state.conversations.some(c => c.id === id)) && has(named.startIds, id => !!state.starts?.some(s => s.id === id))
      && !named.agentIds?.length && !named.projectIds?.length && !named.startAgentIds?.length) return loaded
    recordReload()
    return loadRow(tx, loaded.row, named)
  }

  /** A Swarm with one start loaded even when finished, and the start's group even when dormant. */
  private async loadStart(tx: Transaction, user: AuthUser, tabId: string, startId: string): Promise<Loaded> {
    const loaded = await this.load(tx, user, tabId, { startIds: [startId] })
    const start = loaded.state.starts?.find(s => s.id === startId)
    return start ? this.ensure(tx, loaded, { startIds: [startId], groupIds: [start.request.conversationId] }) : loaded
  }

  /** What a command touches beyond its own fields: a named start's group, a decision's group and start, a delivery's
   *  group, and every group of the agents it removes or writes into (dormant ones too, design section 1.1 D8). */
  private async moreNamed(tx: Transaction, tabId: string, state: SuperTabState, command: Command, personId: string | null, asAgentId?: string): Promise<Named> {
    const named = namedFor(command)
    const groupIds = [...named.groupIds ?? []], startIds = [...named.startIds ?? []], agentIds: string[] = [], startAgentIds: string[] = []
    const start = 'startId' in command ? state.starts?.find(s => s.id === command.startId) : undefined
    if (start) groupIds.push(start.request.conversationId)
    const projectIds = [...named.projectIds ?? []]
    const decisionId = routeDecisionOf(command)
    if (decisionId) {
      const decision = await readDecision(tx, tabId, decisionId)
      if (decision) groupIds.push(decision.conversationId)
      if (decision?.final?.kind === 'new') startIds.push(decision.final.startId)
    }
    // A person's Buddy chat may have gone quiet: it is loaded by its id before it is opened again, never made twice.
    const buddyChat = (projectId: string | undefined, id: string | null | undefined) => {
      const owner = state.people.find(p => p.id === id)
      if (projectId && owner) groupIds.push(buddyChatId(projectId, owner))
    }
    // Their one Buddy chat in the Swarm likewise (buddies.ts openSwarmBuddyChat).
    const swarmChat = (id: string | null | undefined) => {
      const owner = state.people.find(p => p.id === id)
      if (owner) groupIds.push(swarmBuddyChatId(owner))
    }
    // A person's decision may sit in a quiet or archived conversation: it is loaded to answer it (review of #1753).
    if (command.type === 'decision.answer') {
      const asked = await readAskedDecision(tx, tabId, command.decisionId)
      if (asked) groupIds.push(asked.conversationId)
      // Left to the PM: the person's Chat with PM in that project, quiet or not, takes the PM's line.
      if (asked && command.delegate) projectIds.push(asked.projectId)
      // And their one Buddy chat, which takes it too (spec: Guard).
      if (asked && command.delegate) swarmChat(asked.personId)
    }
    // A project's sharing ends its sessions in the one Buddy chats of whoever loses it (commands.ts endLostProjectSessions).
    if (command.type === 'project.sharing') {
      for (const owner of new Set([...state.agents.filter(a => a.buddySession?.projectId === command.projectId).map(a => a.buddyOf!.personId),
        ...(state.starts ?? []).filter(s => s.request.buddySession?.projectId === command.projectId && !s.harnessId && !s.error).map(s => s.request.buddyOf!.personId)])) swarmChat(owner)
    }
    if (command.type === 'buddy.chat' || command.type === 'buddy.create' || command.type === 'buddy.remove') {
      buddyChat(command.projectId, personId)
      swarmChat(personId)
    }
    // An instructions save posts in its project's chat, and a member's note removal tells its coordinator there, even quiet. So
    // does an older client's rule.set, a save too: in the project it names, or its agent's own (one it quotes is loaded).
    if (command.type === 'instructions.save' || command.type === 'note.remove' || command.type === 'rule.set') {
      const self = asAgentId ? state.agents.find(a => a.id === asAgentId) : undefined
      const projectId = command.projectId ?? (self ? agentProjectId(state, self) : undefined)
      const chat = projectsOf(state).find(p => p.id === projectId)?.leadConversationId
      if (chat) groupIds.push(chat)
    }
    // Any agent of a project tells a person in that project's Buddy chat (commands.ts person.tell), loaded even when quiet.
    if (command.type === 'person.tell' && asAgentId) {
      const self = state.agents.find(a => a.id === asAgentId)
      if (self) buddyChat(agentProjectId(state, self), command.personId)
      swarmChat(command.personId)
    }
    if (command.type === 'delivery.resolve') {
      const delivery = await tx.superTabDelivery.findFirst({ where: { id: command.deliveryId, tabId }, select: { conversationId: true } })
      if (delivery) groupIds.push(delivery.conversationId)
    }
    if (command.type === 'agent.remove' || command.type === 'agent.input' || command.type === 'agent.alert' || command.type === 'agent.rebind') agentIds.push(command.agentId)
    if (command.type === 'agent.remove') startAgentIds.push(command.agentId)
    if (command.type === 'machine.remove') {
      const pool = state.machines?.find(m => m.machineId === command.machineId)
      const machines = new Set([command.machineId, ...(pool ? state.machines!.filter(m => m.hostMachineId === pool.machineId).map(m => m.machineId) : [])])
      agentIds.push(...state.agents.filter(a => machines.has(a.machineId)).map(a => a.id))
    }
    if (command.type === 'member.remove') {
      const machines = new Set((state.machines ?? []).filter(m => m.contributorId === command.userId).map(m => m.machineId))
      agentIds.push(...state.agents.filter(a => a.contributorId === command.userId || machines.has(a.machineId)).map(a => a.id))
    }
    return { groupIds, startIds, agentIds, startAgentIds, projectIds }
  }

  /** Writes what changed between the loaded state and `next`, and touches the parts the change relied on. */
  private async save(tx: Transaction, loaded: Loaded, next: SuperTabState, stamp: number, touches: Touch[] = []) {
    const committed = await commitParts(tx, loaded, next, { stamp, touches })
    const told = this.hooks.hostsChanged
    if (told && committed.hosts.length) afterCommit(tx, () => told({ tabId: loaded.parts.tabId, machineIds: committed.hosts, lastChangedAt: stamp }))
    const { userIds, parts } = committed.members, changed = this.hooks.swarmChanged
    if (changed && userIds.length) afterCommit(tx, () => changed({ tabId: loaded.parts.tabId, userIds, lastChangedAt: stamp, parts }))
    return committed
  }

  /** Shared with the read API (superTabs/read, design section 7.2). */
  /** `workspaceLeave` is a Workspace removal leaving this Swarm for the person (workspaceStore.ts SwarmWorkspaces.remove): past the Workspace check. */
  async actor(tx: Transaction, user: AuthUser, state: SuperTabState, agentId?: string, workspaceLeave = false): Promise<Actor> {
    const team = await this.teamHost(tx, user)
    if (!agentId) {
      // A team session never speaks or reads as the person.
      if (team !== null) fail(TEAM_SESSION_LIMITED, TEAM_SESSION_MESSAGE, 403)
      if (!workspaceLeave) await requireWorkspaceAccess(tx, state, user.sub)
      return { kind: 'person', userId: user.sub, email: user.email }
    }
    // A stranger learns nothing of the Swarm from an agent id, real, made up or another Swarm's.
    const target = await strangerRefusal(state, user.sub, () => {
      const found = agent(state, agentId)
      if (found.machineOwnerId !== user.sub) fail('FORBIDDEN', 'Only the execution host can speak as this agent.', 403)
      return found
    })
    // ...and as an agent only one running on its own machine, never the person's agents elsewhere.
    if (team !== null && target.machineId !== team) fail(TEAM_SESSION_LIMITED, TEAM_SESSION_MESSAGE, 403)
    const reads = new GrantReads()
    await this.agentGrant(tx, state, target, reads)
    // An agent of a Team account's machine is spoken for by that account alone, never its owner's own sign-in.
    await this.notTeamMachine(user, () => reads.once(machineKey(state.environment, target.machineId, target.machineOwnerId), () => tx.machine.findFirst({
      where: { machineId: target.machineId, userId: target.machineOwnerId, autonomousEnv: state.environment, ...machineAlive } })), onTeamAccount(state, target))
    return { kind: 'agent', agentId, machineOwnerId: user.sub }
  }

  /** Shared with the read API (superTabs/read, design section 7.2). */
  /** Every path that serves an agent's host checks this, so it also holds the Workspace check: the agent acts for its
   *  contributor, who must still be in the Swarm's Workspace. Its host need not be, as it need not be in the Swarm. */
  /** `reads`: one request's reads, shared by every agent it checks (GrantReads). */
  async agentGrant(tx: Transaction, state: SuperTabState, target: Agent, reads?: GrantReads): Promise<void> {
    await this.grantHolds(tx, state, target, () => person(state, target.contributorId), reads)
  }

  /** What an agent's grant rests on outside the Swarm: its contributor's Workspace membership, its machine and, lent, the
   *  machine's share. `inSwarm` checks the contributor is still in it, at the point the full check always did. */
  private async grantHolds(tx: Transaction, state: SwarmGrant, target: AgentGrant, inSwarm: () => void, reads?: GrantReads): Promise<void> {
    const once = <T>(key: string, read: () => Promise<T>) => reads ? reads.once(key, read) : read()
    await once(`workspace:${state.workspaceId}:${target.contributorId}`, () => requireWorkspaceAccess(tx, state, target.contributorId))
    const machine = await once(machineKey(state.environment, target.machineId, target.machineOwnerId), () => tx.machine.findFirst({
      where: { machineId: target.machineId, userId: target.machineOwnerId, autonomousEnv: state.environment, ...machineAlive } }))
    if (!machine || !machineBillingAllowsDataPlane(machine)) fail('HOST_UNAVAILABLE', 'This execution host is unavailable.', 403)
    if (target.contributorId !== machine.userId) {
      inSwarm()
      const contributor = await once(`user:${target.contributorId}`, () => tx.user.findUnique({ where: { id: target.contributorId }, select: { email: true, autonomousEnv: true } }))
      const share = await once(`share:${machine.machineId}`, () => tx.machineShare.findUnique({ where: { machineId: machine.machineId } }))
      if (!contributor || contributor.autonomousEnv !== state.environment || !share || share.ownerId !== machine.userId ||
          share.autonomousEnv !== state.environment || !sharedVia(share, contributor.email) ||
          machineShareGrant(share, contributor.email) !== target.hostGrant) {
        fail('CONTRIBUTION_REVOKED', 'The contributor no longer has access to this machine.', 403)
      }
    }
  }

  private async contribution(tx: Transaction, state: SuperTabState, actor: Actor, command: { machineId: string }, pooled = false) {
    const contributorId = actor.kind === 'person' ? actor.userId : agent(state, actor.agentId).contributorId
    person(state, contributorId)
    const machine = await tx.machine.findFirst({ where: { machineId: command.machineId, autonomousEnv: state.environment, ...machineAlive } })
    if (!machine || !machineBillingAllowsDataPlane(machine)) fail('HOST_UNAVAILABLE', 'This machine is unavailable.', 403)
    // A Mac's Harness Team account names its Mac from its own account row, which only its owner's sign-in set (machines.ts).
    const host = { ...(machine.sessionKind === 'team' && machine.hostMachineId ? { hostMachineId: machine.hostMachineId } : {}),
      // A Team sign-in with no Mac (`harness team on`) is no person's own machine either (commands.ts buddy.create).
      ...(machine.sessionKind === 'team' ? { teamSession: true as const } : {}) }
    if (pooled) {
      const pool = machineContribution(state, command.machineId)
      if (pool) {
        if (pool.contributorId !== machine.userId) fail('CONTRIBUTION_REVOKED', 'The machine owner changed.', 403)
        return { machineOwnerId: machine.userId, contributorId: pool.contributorId, hostGrant: null, ...host }
      }
    }
    let hostGrant: string | null = null
    if (machine.userId !== contributorId) {
      const contributor = actor.kind === 'person' ? { email: actor.email, autonomousEnv: state.environment } :
        await tx.user.findUnique({ where: { id: contributorId }, select: { email: true, autonomousEnv: true } })
      const share = await tx.machineShare.findUnique({ where: { machineId: command.machineId } })
      if (!contributor || contributor.autonomousEnv !== state.environment || !share || share.ownerId !== machine.userId ||
          share.autonomousEnv !== state.environment || !sharedVia(share, contributor.email)) {
        fail('HOST_REQUIRED', 'This machine has not been shared with the contributor.', 403)
      }
      hostGrant = machineShareGrant(share, contributor.email)
    }
    return { machineOwnerId: machine.userId, contributorId, hostGrant, ...host }
  }

  async create(user: AuthUser, operationId: string, name: string, projectVisibility?: ProjectVisibility, workspaceId?: string) {
    this.personOnly(user)
    const id = stableId('super-tab', user.autonomousEnv, user.sub, operationId)
    const requestHash = hash({ name, ...(projectVisibility ? { projectVisibility } : {}), ...(workspaceId ? { workspaceId } : {}) })
    return transaction(this.db, async tx => {
      const prior = await tx.superTabOperation.findUnique({ where: { id } })
      if (prior) {
        if (prior.requestHash !== requestHash) fail('OPERATION_REUSED', 'Use a new operation ID for a different request.')
        return { id, revision: prior.revision }
      }
      const state = createSuperTab(id, name, { id: user.sub, email: user.email }, user.autonomousEnv, projectVisibility)
      // Every new Swarm is in a Workspace, invite-only there until its owner or the Workspace's admins open it (workspaceStore.ts).
      state.workspaceId = await workspaceForNewSwarm(tx, user, name, id, workspaceId)
      // Born in parts: its state lives in the Swarm* parts, and `state` only fences older backends (schema.prisma).
      await tx.superTab.create({ data: { id, ownerId: user.sub, autonomousEnv: user.autonomousEnv, workspaceId: state.workspaceId, ...indexesOf(state), format: 2, state: { version: 2 } } })
      await insertParts(tx, split({ ...state, sequenceBase: 0 }, { tabId: id, version: 1, now: clock.next() }))
      // Its first project's copy of the built-in instructions, which its state names as revision 1 (model.ts createSuperTab).
      await writeInstructions(tx, id, { projectId: state.projects![0]!.id, revision: 1, hash: FIRST_INSTRUCTIONS.instructionsHash, text: INSTRUCTIONS_TEMPLATE,
        summary: FIRST_SUMMARY, writtenBy: { kind: 'person', id: user.sub }, askedBy: user.sub, at: this.now() })
      await tx.superTabOperation.create({ data: { id, tabId: id, actorKey: `person:${user.sub}`, requestHash, revision: 0, result: { id } } })
      return { id, revision: 0 }
    })
  }

  async list(user: AuthUser, after?: string) {
    this.personOnly(user)
    const rows = await memberSwarms(this.db, user.autonomousEnv, user.sub, { after, limit: 101 })
    const heads = await this.heads(rows.slice(0, 100))
    return { tabs: rows.slice(0, 100).flatMap(row => {
      const head = heads.get(row.id)
      return head ? [{ id: row.id, name: head.name, ownerId: row.ownerId, revision: row.revision, paused: head.paused }] : []
    }), next: rows.length > 100 ? rows[99]!.id : null }
  }

  async workspaceList(user: AuthUser) {
    this.personOnly(user)
    return { workspaces: await listWorkspaces(this.db, user) }
  }

  /** Opens a Swarm to its Workspace's members, or closes it again: its owner (not a guest) or the Workspace's owners and admins,
   *  who need not be in the Swarm. Closing it leaves everyone who joined. */
  async setWorkspaceVisibility(user: AuthUser, tabId: string, visibility: 'invite-only' | 'workspace') {
    this.personOnly(user)
    return transaction(this.db, async tx => {
      const loaded = await this.load(tx, user, tabId), state = cloneData(loaded.state)
      await outsiderRefusal(state, user.sub, async () => {
        if (!state.workspaceId) fail('WORKSPACE_REQUIRED', `This Swarm has no ${WORKSPACE_LABEL} yet.`, 409)
        const own = await tx.swarmWorkspaceMember.findUnique({ where: { id: memberId(state.workspaceId, user.sub) } })
        if (!(state.ownerId === user.sub && own && !own.removedAt && own.role !== 'guest')) await requireWorkspaceRole(tx, state.workspaceId, user.sub, 'swarm.manage')
      })
      state.workspaceVisibility = visibility
      await this.save(tx, loaded, state, clock.next(), [{ kind: 'head', key: 'head' }])
      return { id: tabId, workspaceVisibility: visibility }
    })
  }

  /** A member or above joins a Swarm open to their Workspace, as a collaborator. A guest never does (design, Roles). */
  async workspaceJoin(user: AuthUser, tabId: string, operationId: string) {
    this.personOnly(user)
    return transaction(this.db, async tx => {
      const loaded = await this.load(tx, user, tabId), state = cloneData(loaded.state)
      await outsiderRefusal(state, user.sub, async () => {
        if (!state.workspaceId || state.workspaceVisibility !== 'workspace') fail('FORBIDDEN', 'This Swarm is not open to its Workspace.', 403)
        await requireWorkspaceRole(tx, state.workspaceId, user.sub, 'swarm.joinOpen')
      })
      const existing = state.people.find(p => p.id === user.sub)
      if (existing) return { id: tabId, role: existing.role, alreadyMember: true }
      const member = { id: user.sub, email: authenticatedEmail(user.email)!, role: 'collaborator' as const, generation: stableId('workspace-join', tabId, user.sub, operationId) }
      state.people.push(member)
      // As a link join does: the open visibility it relied on lives on the head, so closing it at once conflicts.
      await this.save(tx, loaded, state, clock.next(), [{ kind: 'head', key: 'head' }])
      return { id: tabId, role: member.role, alreadyMember: false }
    })
  }

  async invitations(user: AuthUser) {
    this.personOnly(user)
    const email = user.email.trim().toLowerCase()
    const rows = await invitedSwarms(this.db, user.autonomousEnv, email, 100)
    const heads = await this.heads(rows)
    return rows.flatMap(row => {
      const state = heads.get(row.id)
      if (!state) return []
      return state.invitations.filter(i => i.email === email && i.expiresAt > this.now())
        .map(i => ({ tabId: row.id, name: state.name, inviteId: i.id, role: i.role, expiresAt: i.expiresAt }))
    })
  }

  /** The heads of Swarms already split into parts, by id. */
  private async heads(rows: Array<Pick<SwarmRow, 'id' | 'format'>>): Promise<Map<string, HeadData>> {
    const heads = await this.db.swarmHead.findMany({ where: { id: { in: rows.filter(r => r.format === 2).map(r => `${r.id}:head`) } } })
    return new Map(heads.map(head => [head.tabId, head.data as unknown as HeadData]))
  }

  async sharing(user: AuthUser, tabId: string) {
    this.personOnly(user)
    return transaction(this.db, async tx => {
      const { state } = await this.load(tx, user, tabId)
      requireSharingOwner(state, user.sub)
      return sharingDetails(state)
    })
  }

  async saveSharing(user: AuthUser, tabId: string, input: SaveSharing) {
    this.personOnly(user)
    const request = saveSharingSchema.parse(input)
    return transaction(this.db, async tx => {
      const loaded = await this.load(tx, user, tabId), state = cloneData(loaded.state)
      requireSharingOwner(state, user.sub)
      const receiptId = stableId('swarm-sharing', tabId, user.sub, request.operationId), requestHash = hash(request)
      const prior = await tx.superTabOperation.findUnique({ where: { id: receiptId } })
      if (prior) {
        if (prior.requestHash !== requestHash) fail('OPERATION_REUSED', 'Use a new operation ID for a different request.')
        const result = prior.result as Record<string, unknown>
        if (state.sharing?.generation !== result.generation) fail('SHARING_CHANGED', 'Sharing changed after this request. Reload it and try again.')
        return sharingDetails(state)
      }
      if ((state.sharing?.revision ?? 0) !== request.revision) fail('REVISION_CHANGED', 'Sharing changed elsewhere. Reload it and try again.')
      state.sharing = configureSharing(state.sharing, request.access, request.rotateLink)
      const stamp = clock.next(), { written } = await this.save(tx, loaded, state, stamp, [{ kind: 'member', key: user.sub }])
      await tx.superTabOperation.create({ data: { id: receiptId, tabId, actorKey: `person:${user.sub}`, requestHash,
        revision: 0, parts: json(receiptParts(written, stamp)), result: { generation: state.sharing.generation } } })
      return sharingDetails(state)
    })
  }

  /** A signed-in preview contains no projects, people, machines, or conversation data. It never joins. */
  async previewJoin(user: AuthUser, tabId: string, token?: string) {
    this.personOnly(user)
    return transaction(this.db, async tx => {
      const { state } = await this.load(tx, user, tabId)
      const sharing = authorizeSwarmJoin(state, user.email, token)
      const member = state.people.find(p => p.id === user.sub)
      return { id: tabId, name: state.name, role: member?.role ?? sharing.access.role, alreadyMember: !!member }
    })
  }

  async join(user: AuthUser, tabId: string, input: JoinSwarm) {
    this.personOnly(user)
    const request = joinSwarmSchema.parse(input)
    return transaction(this.db, async tx => {
      const loaded = await this.load(tx, user, tabId), state = cloneData(loaded.state)
      // Recheck the current grant before an old receipt. Disabling, replacing, or
      // changing access can never revive a removed membership through a retry.
      const sharing = authorizeSwarmJoin(state, user.email, request.token)
      const receiptId = stableId('swarm-join', tabId, user.sub, request.operationId), requestHash = hash(request)
      const prior = await tx.superTabOperation.findUnique({ where: { id: receiptId } })
      let member = state.people.find(p => p.id === user.sub)
      if (prior) {
        if (prior.requestHash !== requestHash) fail('OPERATION_REUSED', 'Use a new operation ID for a different request.')
        const result = prior.result as Record<string, unknown>
        if (result.sharingGeneration !== sharing.generation || !member || (member.generation ?? null) !== result.membershipGeneration) {
          fail('JOIN_CHANGED', 'This join request is no longer current. Open the latest Swarm link again.')
        }
        return { id: tabId, role: member.role, alreadyMember: result.alreadyMember === true }
      }
      const alreadyMember = !!member
      if (!member && state.workspaceId) {
        // A link or an email domain makes a guest of the Workspace, never higher. Someone the Workspace removed comes back only by
        // an invitation, never by a general link (design, Roles).
        const prior = await tx.swarmWorkspaceMember.findUnique({ where: { id: memberId(state.workspaceId, user.sub) } })
        if (prior?.removedAt) fail(WORKSPACE_ACCESS_REVOKED, `You were removed from this Swarm's ${WORKSPACE_LABEL}. Ask its owner to invite you.`, 403)
        await addMember(tx, state.workspaceId, { id: user.sub, email: user.email }, 'guest', state.ownerId, receiptId)
      }
      if (!member) {
        member = { id: user.sub, email: authenticatedEmail(user.email)!, role: sharing.access.role, generation: receiptId }
        state.people.push(member)
      }
      // Existing people retain their role and private-project grants. A general
      // access link does not promote a viewer or grant a private project.
      // The join relied on the sharing generation the head holds: a concurrent sharing change conflicts with it.
      const stamp = clock.next(), { written } = await this.save(tx, loaded, state, stamp, [{ kind: 'head', key: 'head' }])
      await tx.superTabOperation.create({ data: { id: receiptId, tabId, actorKey: `person:${user.sub}`, requestHash, revision: 0,
        parts: json(receiptParts(written, stamp)),
        result: { sharingGeneration: sharing.generation, membershipGeneration: member.generation ?? null, alreadyMember } } })
      return { id: tabId, role: member.role, alreadyMember }
    })
  }

  async read(user: AuthUser, tabId: string, asAgentId?: string) {
    const tx = this.db, view = await this.view([tabId])
    // A first load shows finished starts until they expire (design section 4.3).
    const { state } = await this.readLoad(user, tabId, { includeRecentStarts: true }, view)
    const actor = await this.actor(tx, user, state, asAgentId)
    const now = this.now()
    const visible = visibleState(state, actor, now)
    const mentions = actor.kind === 'person' ? { mentionsWaiting: await mentionsWaiting(tx, tabId, state, actor, now) } : {}
    const facts = visible.machines?.length ? await this.machineFacts(tx, state) : { team: [], versions: {} as Record<string, string> }
    const teamMachines = facts.team
    const otherWorkspace = visible.machines?.length ? await this.otherWorkspaceMachines(tx, state) : []
    const slots = slotCounter(state)
    return { lastChangedAt: await readLastChangedAt(tx, view, tabId) ?? 0, state: { ...visible, ...mentions, machines: visible.machines?.map(pool => {
      const stored = state.machines!.find(m => m.machineId === pool.machineId)!
      // Whether it takes teammates' projects now, and if not why (machines.ts teamWorkRefusal): what routing leaves it
      // out for, and what Desktop can show on the machine.
      const refusal = machineTeamWork(state, stored, now, teamMachines, otherWorkspace)
      const suspended = suspendedEngines(stored, now)
      return { ...pool, availableSlots: Math.max(0, pool.maxAgents - slots(stored)),
        teamWork: refusal ? { allowed: false as const, ...refusal } : { allowed: true as const },
        ...(facts.versions[pool.machineId] ? { clientVersion: facts.versions[pool.machineId] } : {}),
        // What the route leaves out (cli superTabs/routeCommand.ts unreadyPool).
        ...(Object.keys(suspended).length ? { suspendedEngines: suspended } : {}) }
    }) } }
  }

  async start(user: AuthUser, tabId: string, startId: string, asAgentId?: string, hostMachineId?: string) {
    return transaction(this.db, async tx => {
      const state = (await this.loadStart(tx, user, tabId, startId)).state
      const actor = hostMachineId ? await this.poolHostActor(tx, user, state, hostMachineId, startId) : await this.actor(tx, user, state, asAgentId)
      author(state, actor, true)
      const start = state.starts?.find(s => s.id === startId) ?? fail('NOT_FOUND', 'This agent start is unavailable.', 404)
      if (!mayResumeStart(state, actor, start) || person(state, start.contributorId).generation !== start.membershipGeneration) {
        fail('FORBIDDEN', 'Only whoever made this start, or its project\'s coordinator, resumes it.', 403)
      }
      const group = readConversation(state, actor, start.request.conversationId)
      if (group.archived) fail('ARCHIVED', 'This conversation is archived.')
      if (state.paused && !start.harnessId && !start.dispatched) fail('PAUSED', 'New work is paused in this Super Tab.')
      const grant = await this.contribution(tx, state, actor, start.request, true)
      if (grant.machineOwnerId !== start.machineOwnerId || (grant.hostGrant ?? null) !== start.hostGrant) {
        fail('CONTRIBUTION_REVOKED', 'This start belongs to a machine grant that was revoked.', 403)
      }
      // The skills its agent launches with. A contributed machine's host cannot read the Swarm to learn them (cli
      // superTabs/start.ts): until 2026-10-28 it launched every agent on Harness orchestration, whatever its project ran.
      // A Swarm-wide Buddy has no project: it runs its own Buddy skill (Dee, 10-31).
      const project = startProject(state, start.request)
      const read = { ...start, skillMode: project ? skillModeOf(project) : 'default' as const }
      // The Lead reads that its machine is still preparing it, and waits instead of starting another (liveness.ts).
      return startPreparing(state, start, this.now()) ? { ...read, preparing: true as const } : read
    })
  }

  async execute(user: AuthUser, tabId: string, input: { operationId: string; command: Command }, asAgentId?: string, hostMachineId?: string) {
    try {
      const done = await this.executeOnce(user, tabId, input, asAgentId, hostMachineId)
      // Buddy thread sessions' first warning (spec Design 4): starts, refusals by code and ends by reason, ids only, in the
      // server log that prod watch reads.
      if (input.command?.type === 'message.send' && input.command.newSession && done.result.startId) logger.info('Buddy session started', { tabId, startId: done.result.startId })
      return done
    } catch (error) {
      if (input.command?.type === 'message.send' && input.command.newSession && error instanceof SuperTabError) logger.info('Buddy session refused', { tabId, code: error.code })
      // A queued start its machine will not take for good — no Harness Team account, or one that is not private — fails
      // with that reason instead of waiting there: its host would otherwise try to launch it on every pass, and it would
      // hold a slot. A stale check or an offline machine may pass again by itself, so that start keeps waiting.
      const command = input.command
      if (command?.type === 'agent.startDispatch' && hostMachineId && error instanceof SuperTabError && LASTING_TEAM_REFUSALS.includes(error.code)) {
        // Only one never launched: a repeated dispatch of a launched start is admitted again too, and its agent may be starting.
        const start = await transaction(this.db, async tx => {
          const row = await tx.superTab.findFirst({ where: { id: tabId, autonomousEnv: user.autonomousEnv }, select: SWARM_ROW })
          return row?.format === 2 ? (await loadRow(tx, row, { startIds: [command.startId] })).state.starts?.find(s => s.id === command.startId) : undefined
        })
        if (start && !start.dispatched && !start.harnessId && !start.error) {
          await this.executeOnce(user, tabId, { operationId: `team-refused-${command.startId}`,
            command: { type: 'agent.startFailed', startId: command.startId, error: error.message } }, asAgentId, hostMachineId)
            .catch(() => { /* Settled by a concurrent pass: the dispatch is refused either way. */ })
        }
      }
      throw error
    }
  }

  private async executeOnce(user: AuthUser, tabId: string, input: { operationId: string; command: Command }, asAgentId?: string, hostMachineId?: string,
    workspaceLeave = false) {
    const { operationId, command } = operationSchema.parse(input)
    let ended: WorkHold[] = [], started: WorkHold[] = []
    const done = await transaction(this.db, async tx => {
      // A retried attempt starts again: only the attempt that commits says which tasks ended or started.
      ended = []
      started = []
      const stamp = clock.next()
      const first = await this.load(tx, user, tabId, namedFor(command))
      const loaded = await this.ensure(tx, first, await this.moreNamed(tx, tabId, first.state, command, asAgentId ? null : user.sub, asAgentId))
      const original = loaded.state
      const team = await this.teamHost(tx, user)
      // Removal retries can arrive after the actor itself left. Return only this host's exact prior receipt.
      if (command.type === 'agent.remove' && asAgentId === command.agentId && !original.agents.some(a => a.id === asAgentId)) {
        const prior = await tx.superTabOperation.findUnique({ where: { id: stableId(tabId, `agent:${asAgentId}`, operationId) } })
        const result = prior?.result as Record<string, unknown> | undefined
        // A team session's only if the removed agent ran on its machine; a receipt from before that was recorded is not.
        if (prior && prior.requestHash === hash(command) && result?.releasedBy === user.sub && (team === null || result.releasedMachineId === team)) {
          return replyOf(prior)
        }
        fail('FORBIDDEN', 'Only the execution host can confirm this removal.', 403)
      }
      if (hostMachineId && !['agent.startDispatch', 'agent.started', 'agent.startFailed', 'agent.startSettled', 'route.modelResult'].includes(command.type)) fail('FORBIDDEN', 'A host can only settle its queued starts.', 403)
      if (team !== null && !hostMachineId) this.teamCommand(original, team, user, command)
      // A Team account's session is closed by its own team session: the Mac's owner is its machine owner too, and from an
      // ordinary sign-in confirmed it, ending its hold with its data still there. A held one is on a Team account by
      // definition, whatever the account row says now (review of #2142).
      if (command.type === 'agent.sessionClosed' && team === null) {
        const closing = original.closingSessions?.find(c => c.agentId === command.agentId && c.harnessId === command.harnessId && c.machineOwnerId === user.sub)
        if (closing) await this.notTeamMachine(user, () => tx.machine.findFirst({ where: { machineId: closing.machineId, userId: user.sub,
          autonomousEnv: user.autonomousEnv, ...machineAlive } }), !!closing.heldFor || teamByRecord(original, closing.machineId))
      }
      // Accepting a Swarm's invitation from outside its Workspace makes the person a guest of the Workspace first (design, Roles).
      if (command.type === 'invite.accept' && !hostMachineId && original.workspaceId) {
        const email = user.email.trim().toLowerCase()
        const invite = original.invitations.find(i => i.id === command.inviteId && i.email === email && i.expiresAt > this.now())
        // Only the Swarm's owner invites (invite.create), so the guest is added on the owner's authority.
        if (invite) await addMember(tx, original.workspaceId, { id: user.sub, email }, 'guest', original.ownerId, stableId('workspace-guest', tabId, user.sub, operationId))
      }
      // A removed agent's or machine's host confirms its close or cleanup as the machine owner, who may have left the Swarm with it.
      const actor: Actor = command.type === 'agent.sessionClosed' || command.type === 'machine.cleaned' ? { kind: 'person', userId: user.sub, email: user.email }
        : hostMachineId && 'startId' in command
          ? await this.poolHostActor(tx, user, original, hostMachineId, command.startId)
          : await this.actor(tx, user, original, asAgentId, workspaceLeave && command.type === 'member.remove' && command.userId === user.sub && !asAgentId)
      // A Mac and its Harness Team account leave under one removal, and each host confirms its cleanup as the same person
      // with the same operation (cli/src/superTabs/machines.ts runCleanup): each machine's confirmation is its own receipt.
      const receiptId = command.type === 'machine.cleaned' ? stableId(tabId, actorKey(actor), operationId, command.machineId)
        : stableId(tabId, actorKey(actor), operationId)
      const requestHash = hash(command)
      const prior = await tx.superTabOperation.findUnique({ where: { id: receiptId } })
      if (prior) {
        if (prior.requestHash !== requestHash) fail('OPERATION_REUSED', 'Use a new operation ID for a different request.')
        // A leave may be retried by its original author. Nothing except that operation's receipt is returned.
        const selfLeave = actor.kind === 'person' && command.type === 'member.remove' && command.userId === actor.userId
        if (!selfLeave) {
          if (command.type === 'agent.remove' && !original.agents.some(a => a.id === command.agentId) ||
              command.type === 'project.delete' && !projectsOf(original).some(p => p.id === command.projectId)) {
            // Retrying one's own completed removal returns only its empty
            // receipt. The removed object no longer exists to authorize against.
            author(original, actor, true)
          } else {
            authorizeCommandAccess(original, actor, command)
          }
          if (command.type === 'delivery.resolve') {
            const delivery = await tx.superTabDelivery.findFirst({ where: { id: command.deliveryId, tabId } })
            if (!delivery) fail('NOT_FOUND', 'This delivery is unavailable.', 404)
            readConversation(original, actor, delivery.conversationId)
          }
          // A retried answer is checked again: the person must still read the decision's conversation (review of #1753).
          if (command.type === 'decision.answer') answerable(original, actor, await readAskedDecision(tx, tabId, command.decisionId))
          else if ('decisionId' in command) {
            const decision = await readDecision(tx, tabId, command.decisionId) ?? fail('NOT_FOUND', 'This routing decision is unavailable.', 404)
            readConversation(original, actor, decision.conversationId)
          }
        }
        if (command.type === 'project.create' &&
            !projectsOf(original).some(p => p.id === (prior.result as Record<string, unknown>).projectId)) {
          fail('NOT_FOUND', 'This project was deleted. Create a new project.', 404)
        }
        return replyOf(prior)
      }
      if (command.type !== 'invite.accept' && command.type !== 'agent.sessionClosed' && command.type !== 'machine.cleaned') author(original, actor)
      const context: CommandContext = { operationId, now: this.now() }
      if (command.type === 'agent.screen' || command.type === 'agent.input') context.confidentialSession = await this.confidential(tx, command.agentId)
      if (REGISTERS.has(command.type)) context.registrations = await otherRegistrations(tx, original, registeredBy(original, command))
      if ('startId' in command && ['agent.startDispatch', 'agent.started', 'agent.startFailed', 'agent.startSettled', 'route.modelResult'].includes(command.type)) {
        const start = original.starts?.find(s => s.id === command.startId)
        if (start?.poolGeneration && !hostMachineId) fail('HOST_REQUIRED', 'Only the contributed machine can confirm this start.', 403)
      }
      if (command.type === 'delivery.resolve') {
        author(original, actor, true)
        if (actor.kind !== 'person') fail('HUMAN_REQUIRED', 'A person must inspect an uncertain delivery before resolving it.', 403)
        const delivery = await tx.superTabDelivery.findFirst({ where: { id: command.deliveryId, tabId } })
        if (!delivery || delivery.status !== 'uncertain') fail('DELIVERY_RESOLVED', 'This delivery no longer needs checking.')
        const message = await tx.superTabMessage.findUnique({ where: { id: delivery.messageId } })
        if (!message) fail('NOT_FOUND', 'The original instruction is unavailable.', 404)
        // Anyone can work out a news delivery's id: it answers as one that needs no checking, so nobody learns whose Buddy
        // heard (security review 2 of #2178). Its host settles it like any other.
        if (buddyNews(message, delivery)) fail('DELIVERY_RESOLVED', 'This delivery no longer needs checking.')
        if (command.resolution === 'resend') {
          if (!this.deliveryAllowed(original, delivery) || !await this.senderAllowed(tx, original, delivery)) {
            fail('DELIVERY_REVOKED', 'This instruction is no longer authorized.', 403)
          }
          await this.agentGrant(tx, original, agent(original, delivery.agentId))
        }
        context.delivery = { ...delivery, text: message.text, ...(message.attachments ? { attachments: message.attachments as unknown as Attachment[] } : {}) }
        await tx.superTabDelivery.update({ where: { id: delivery.id }, data: {
          status: command.resolution === 'received' ? 'confirmed' : command.resolution === 'resend' ? 'superseded' : 'cancelled',
          holdReason: null, holdSince: null,
          ...(command.resolution === 'received' ? { deliveredAt: delivery.deliveredAt ?? new Date(context.now) } : {}),
          // The native receipt remains intact; the operation records the person's resolution.
        } })
      }
      // Read only while the Swarm has a cleanup pending, which is rare: one indexed read of those machines' accounts.
      if (original.machineCleanups?.length) context.deletedMachineIds = await this.deletedMachines(tx, original)
      if (command.type === 'machine.contribute' || command.type === 'agent.add' || command.type === 'tab.project') {
        context.contribution = await this.contribution(tx, original, actor, command)
      }
      if (command.type === 'machine.contribute') context.abandonedStartIds = await abandonedStarts(tx, tabId, original, command.machineId, context.now)
      if (command.type === 'agent.start') context.contribution = await this.contribution(tx, original, actor, command.request, true)
      // A machine that is not there, or not the person's, reads as one that is not theirs: the words never say which.
      if (command.type === 'buddy.create') context.contribution = await this.contribution(tx, original, actor, command, true).catch(error => {
        if (error instanceof SuperTabError && ['HOST_UNAVAILABLE', 'HOST_REQUIRED'].includes(error.code)) fail('BUDDY_OWN_MACHINE', BUDDY_OWN_MACHINE_REFUSAL, 403)
        throw error
      })
      if (command.type === 'buddy.rename' || command.type === 'buddy.create') context.buddyNames = await buddyNames(tx, tabId, original)
      if (command.type === 'agent.started' || command.type === 'agent.startDispatch') {
        const start = original.starts?.find(s => s.id === command.startId) ?? fail('NOT_FOUND', 'This agent start is unavailable.', 404)
        context.contribution = await this.contribution(tx, original, actor, start.request, true)
      }
      // A settle that carries its agent's model is that machine's reading, taken only from the grant that started it
      // (commands.ts settledConfiguration). A grant that cannot be read leaves the reading out; the settle itself never fails on it.
      if (command.type === 'agent.startSettled' && command.configuration) {
        const start = original.starts?.find(s => s.id === command.startId)
        if (start) context.contribution = await this.contribution(tx, original, actor, start.request, true).catch(() => undefined)
      }
      if (command.type === 'message.send' && command.replyTo) {
        const reply = await tx.superTabMessage.findFirst({ where: { id: command.replyTo, tabId, conversationId: command.conversationId } })
        // The thread's root says whose proposal the reply answers (buddyNews.ts): the reply itself, or one more read by id.
        const root = reply?.thread && reply.thread !== reply.id
          ? await tx.superTabMessage.findFirst({ where: { id: reply.thread, tabId, conversationId: command.conversationId }, select: { source: true } }) : reply
        // In a Buddy chat: whether the thread ever had a session (buddySessions.ts), by the thread index, one row at most.
        const buddyChat = original.conversations.find(c => c.id === command.conversationId)
        const sessionThread = reply?.thread && buddyChat && isBuddyChat(buddyChat)
          ? !!await tx.superTabMessage.findFirst({ where: { tabId, conversationId: command.conversationId, thread: reply.thread, buddySession: true }, select: { id: true } })
          : false
        if (reply) context.reply = { id: reply.id, conversationId: reply.conversationId, author: reply.author as unknown as Author, createdAt: reply.createdAt.getTime(),
          thread: reply.thread, threadSource: (root?.source ?? null) as Record<string, unknown> | null,
          ...(agentOnly(reply.source, reply.recipientIds) ? { agentOnly: true } : {}), ...(sessionThread ? { sessionThread: true as const } : {}) }
      }
      if (command.type === 'message.send' && actor.kind === 'person') context.openTags = await openTags(tx, tabId, command.conversationId, actor.userId, context.now)
      // A stale save is refused with the stored text, to merge (instructions.ts); an older client's rule.set appends to it
      // (commands.ts ruleProject: the project it names, quotes or acts in).
      if (command.type === 'instructions.save' || command.type === 'rule.set') {
        const projectId = command.type === 'rule.set' ? ruleProject(original, actor, command).id : command.projectId
        context.instructions = await tx.superTabInstructions.findUnique({ where: { id: stableId(tabId, projectId) }, select: { revision: true, text: true } })
      }
      if (command.type === 'note.add' || command.type === 'note.remove') context.notes = await readNotes(tx, tabId, command.projectId)
      if ((command.type === 'rule.set' || command.type === 'rule.remove' || command.type === 'project.skills' || command.type === 'tab.tidy'
        || command.type === 'machine.engineResume') && command.askedIn) {
        const asked = await tx.superTabMessage.findFirst({ where: { id: command.askedIn.messageId, tabId, conversationId: command.askedIn.conversationId } })
        if (asked) context.askedIn = { author: asked.author as unknown as Author, source: !!asked.source, createdAt: asked.createdAt.getTime() }
      }
      if (command.type === 'conversation.create' && command.proposalMessageId) {
        // By id within this tab: the proposal a new group comes from (leaderboard/record.ts recordProposal).
        const proposal = await tx.superTabMessage.findFirst({ where: { id: command.proposalMessageId, tabId },
          select: { id: true, conversationId: true, author: true, source: true } })
        if (proposal) context.proposal = { id: proposal.id, conversationId: proposal.conversationId, author: proposal.author as unknown as Author,
          source: proposal.source as Record<string, unknown> | null }
      }
      if (command.type === 'buddy.propose') {
        const asked = await tx.superTabMessage.findFirst({ where: { id: command.ownerMessageId, tabId, conversationId: command.conversationId } })
        // The newest message its owner wrote there: the chat's newest rows, the Buddy's and the owner's in turn.
        const recent = asked ? await tx.superTabMessage.findMany({ where: { tabId, conversationId: command.conversationId },
          orderBy: { sequence: 'desc' }, take: 50, select: { id: true, author: true, source: true } }) : []
        const ownerId = (asked?.author as unknown as Author | undefined)?.id
        const newest = recent.find(m => !m.source && (m.author as unknown as Author).kind === 'person' && (m.author as unknown as Author).id === ownerId)
        if (asked) context.proposalAsk = { id: asked.id, conversationId: asked.conversationId, author: asked.author as unknown as Author,
          source: !!asked.source, createdAt: asked.createdAt.getTime(), thread: asked.thread, ...(newest ? { newestOwnerMessageId: newest.id } : {}) }
      }
      if (command.type === 'message.send' && actor.kind === 'agent') {
        const recent = await tx.superTabMessage.findMany({ where: { tabId, conversationId: command.conversationId },
          orderBy: { sequence: 'desc' }, take: Math.max(PAIR_CHAIN_LIMIT, LOOP_NOTICE_AT), select: { author: true, recipientIds: true, createdAt: true, source: true } })
        context.recent = recent.map(m => ({ author: m.author as unknown as Author, recipients: m.recipientIds, createdAt: m.createdAt.getTime(), source: m.source }))
      }
      if (command.type === 'work.status' && command.status === 'stopped') {
        const proof = await tx.superTabStopReceipt.findUnique({ where: { tabId_assignmentId: { tabId, assignmentId: command.assignmentId } } })
        const execution = conversation(original, command.conversationId).assignment?.execution
        context.confirmedStopped = !!proof && !!execution && proof.machineId === execution.machineId &&
          proof.harnessId === execution.harnessId && proof.machineOwnerId === execution.machineOwnerId
      }
      if (command.type === 'mention.done') context.mention = await readMention(tx, tabId, command.mentionId)
      if (command.type === 'decision.answer') context.decision = await readAskedDecision(tx, tabId, command.decisionId)
      if (command.type === 'work.status' && command.ask && command.result && actor.kind === 'agent') {
        const ask = { ...command.ask, askerAgentId: actor.agentId, assignmentId: command.assignmentId, conversationId: command.conversationId,
          question: command.result }
        context.repeatedDecision = await repeatOf(tx, tabId, ask) ?? null
        context.openDecisions = context.repeatedDecision ? null : await fullFor(tx, tabId, ask)
      }
      // The files this command sends, and those it takes from the uploads waiting for a message: a chat file it sent before
      // stays with that message, and a proposal may carry one its Buddy's owner sent in their chat.
      let claimed: string[] = [], proposed: string[] = []
      if (command.type === 'message.send' && command.attachmentIds?.length) {
        context.attachments = await this.sendable(tx, tabId, actor, command)
        claimed = context.attachments.map(a => a.id)
      }
      if (command.type === 'buddy.propose' && command.attachmentIds?.length) ({ attachments: context.attachments, claimed, proposed } = await this.proposable(tx, original, actor, command))
      if (command.type === 'message.react') context.reaction = await this.reactionTarget(tx, tabId, actor, command, original)
      if ((command.type === 'member.avatar' || command.type === 'agent.avatar') && command.avatar?.kind === 'upload') {
        context.avatarUpload = await this.avatarUpload(tx, tabId, actor, command.avatar.id)
      }
      if ((command.type === 'invite.create' || command.type === 'invite.revoke') && actor.kind === 'person' && original.workspaceId) {
        const member = await activeMember(tx, original.workspaceId, actor.userId)
        if (member) context.workspaceRole = member.role as WorkspaceRole
      }
      // A Ready for review counts the machines the project may use (reviewCapacity.ts), by the same team access as work.assign.
      if (TEAM_WORK_COMMANDS.has(command.type) || (command.type === 'work.status' && command.status === 'review') || addsAgent(original, actor, command)) {
        const facts = await this.machineFacts(tx, original)
        context.teamMachines = facts.team
        context.machineVersions = facts.versions
        context.otherWorkspaceMachines = await this.otherWorkspaceMachines(tx, original)
        if (this.hooks.teamAccountsIdle) context.teamAccountsIdle = true
      }
      if (command.type === 'agent.screen' || command.type === 'agent.input') {
        // A machine that is gone or no longer shared refuses at once instead of leaving the request to time out.
        await this.agentGrant(tx, original, agent(original, command.agentId))
        const waiting = await tx.superTabTerminalRequest.count({ where: { tabId, agentId: command.agentId, status: { in: ['pending', 'claimed'] },
          createdAt: { gte: new Date(context.now - TERMINAL_PICKUP_MS - TERMINAL_ANSWER_MS) } } })
        if (waiting >= 10) fail('RATE_LIMITED', 'Ten requests to this terminal are still waiting. Wait for them to finish.', 429)
      }
      if (command.type === 'agent.screenResult' || command.type === 'agent.inputResult') {
        const request = await tx.superTabTerminalRequest.findFirst({ where: { id: command.requestId, tabId } })
        if (request) context.terminalRequest = { id: request.id, agentId: request.agentId, harnessId: request.harnessId,
          kind: request.kind as 'screen' | 'input', status: request.status as 'pending' | 'claimed' | 'done' }
      }
      const decisionId = command.type === 'route.override' || command.type === 'route.modelResult' ? command.decisionId
        : command.type === 'work.assign' || command.type === 'agent.start' ? command.routeDecisionId : undefined
      if (decisionId) context.routeDecision = await readDecision(tx, tabId, decisionId) ?? fail('NOT_FOUND', 'This routing decision is unavailable.', 404)
      const effects = applyCommand(original, actor, command, context)
      // An agent-only notice changes nothing people see: no link, no unread mark, no project report.
      const shown = effects.messages.filter(message => !agentOnly(message.source, message.recipients))
      for (const group of effects.state.conversations) {
        appendPullRequestUrls(group, [
          ...shown.filter(message => message.conversationId === group.id).map(message => message.text),
          ...group.checks.map(check => check.evidence), group.assignment?.result,
        ])
      }
      if (command.type === 'agent.rebind') {
        const target = agent(effects.state, command.agentId)
        // A terminal can already belong to a different project or Swarm on this host. The pure
        // transition checks this tab; inspect the other registrations inside the same transaction.
        const registrations = await tx.swarmAgent.findMany({ where: { machineId: target.machineId, deleted: false } })
        if (registrations.some(row => (row.data as unknown as Agent).harnessId === command.harnessId && row.key !== target.id)) {
          fail('SESSION_CONTRIBUTED', 'The replacement terminal already belongs to another member.')
        }
        if (target.harnessId !== agent(original, target.id).harnessId) {
          // Preserve the stable member's scope and also reserve the new native identity's scope.
          await bindSession(tx, effects.state, { ...target, id: stableId(target.machineId, target.harnessId) }, context.now)
          await tx.superTabRun.updateMany({ where: { id: target.id, tabId, machineId: target.machineId,
            harnessId: command.previousHarnessId }, data: { harnessId: target.harnessId } })
        }
      }
      if (command.type === 'agent.add' || command.type === 'agent.started') {
        const target = agent(effects.state, effects.result.agentId as string)
        await bindSession(tx, effects.state, target, context.now)
      }
      // A session that just became confidential writes the record its registrations write (confidential.ts).
      const turned = effects.state.agents.filter(target => target.confidential && !original.agents.find(a => a.id === target.id)?.confidential)
      for (const target of turned) await recordConfidential(tx, effects.state, target, context.now)
      const tell = this.hooks.sessionsConfidential
      if (tell && turned.length) {
        const sessions = turned.map(({ machineId, harnessId, machineOwnerId }) => ({ machineId, harnessId, machineOwnerId }))
        afterCommit(tx, () => tell(sessions))
      }
      if (command.type === 'project.sharing' && command.visibility === 'private') {
        await makeProjectPrivate(tx, effects.state, command.projectId)
      }
      const watchersLost = await revokeNativeContexts(tx, original, effects.state)
      // Rule (b) for claims (design D10): a change to who a conversation's deliveries may reach writes those delivery rows,
      // so a claim of one conflicts with it. An archived conversation, or one its receiver left, ends them: kept for a
      // reopening, 6 of the 9 deliveries prod watch found stuck for days on 2026-10-28 waited in archived groups, unread.
      const unreadable = command.type === 'conversation.archive' && command.archived || command.type === 'conversation.agent' && !command.present
        // A task cancelled with no assignment archives (commands.ts work.cancel).
        || command.type === 'work.cancel' && !original.conversations.find(c => c.id === command.conversationId)?.archived
          && !!effects.state.conversations.find(c => c.id === command.conversationId)?.archived
      if (unreadable) {
        await tx.superTabDelivery.updateMany({ where: { tabId, conversationId: command.conversationId, status: { in: ['queued', 'claimed', 'uncertain'] },
          ...(command.type === 'conversation.agent' ? { agentId: command.agentId } : {}) },
          data: { status: 'cancelled', holdReason: null, holdSince: null } })
      }
      const removedGroups = original.conversations.filter(c => !effects.state.conversations.some(n => n.id === c.id))
      if (removedGroups.length) {
        // Keep immutable history and operation receipts for audit/replay; all
        // reads require a live conversation. No removed group can deliver work.
        await tx.superTabDelivery.updateMany({ where: { tabId, conversationId: { in: removedGroups.map(c => c.id) },
          status: { in: ['queued', 'claimed', 'uncertain'] } }, data: { status: 'cancelled', holdReason: null, holdSince: null } })
      }
      // Each conversation numbers its own messages. Only a change of a work group's state wakes its coordinator, read through
      // its latest message; an ordinary message never does (Dee, 2026-10-31).
      const sequences = numberMessages(effects.state, effects.messages, context.now)
      noteWorkChanges(original, effects.state, context.now)
      if (command.type === 'work.assign' || command.type === 'work.status' || command.type === 'message.send') {
        const group = conversation(effects.state, command.conversationId)
        const assignment = group.assignment
        if (assignment && (command.type !== 'message.send' || actor.kind === 'agent' && actor.agentId === assignment.agentId)) {
          // Even an unchanged working status is fresh evidence that the agent
          // continued. An older queued gap must not turn that progress into Stuck.
          assignment.recordingProgress = { at: context.now, revision: group.messageSeq ?? 0 }
        }
      }
      if (command.type === 'agent.release' && command.decision === 'stop') {
        const target = agent(effects.state, command.agentId)
        const assignmentId = `release-${target.releaseId}`
        const running = await tx.superTabRun.findUnique({ where: { id: target.id } })
        if (running && (running.tabId !== tabId || running.assignmentId !== assignmentId)) fail('AGENT_BUSY', 'This agent already owns active work in a Swarm or is stopping elsewhere.')
        const registrations = await tx.swarmAgent.findMany({ where: { key: target.id, deleted: false, tabId: { not: tabId } } })
        if (registrations.some(row => row.machineOwnerId === target.machineOwnerId)) {
          fail('SESSION_SHARED', 'This session is still shared with another Swarm. Withdraw it there before stopping it here.')
        }
        // Serialize new contributions with stop intent; bindSession writes this same native-session record.
        const scopeId = stableId('swarm-session', original.environment, target.machineOwnerId, target.id)
        const scope = await tx.superTabSessionScope.findUnique({ where: { id: scopeId } })
        await tx.superTabSessionScope.upsert({ where: { id: scopeId },
          create: { id: scopeId, scopeIds: [stableId(tabId, agentProjectId(original, target))], stopReleaseId: target.releaseId },
          update: { scopeIds: scope?.scopeIds ?? [], stopReleaseId: target.releaseId } })
        // The same global uniqueness fence as work.assign: another public Swarm cannot assign this native session during close.
        if (!running) await tx.superTabRun.create({ data: { id: target.id, tabId, assignmentId, machineId: target.machineId, harnessId: target.harnessId } })
      }
      if (command.type === 'agent.stopLease') {
        const target = agent(effects.state, command.agentId)
        const id = stableId('swarm-session', original.environment, target.machineOwnerId, target.id)
        const reservation = effects.state.harnessReservations?.find(r => r.machineId === target.machineId && r.harnessId === target.harnessId)
        await tx.superTabSessionScope.update({ where: { id }, data: {
          closeLeaseId: effects.result.leaseId as string, closeLeaseUntil: new Date(effects.result.expiresAt as number),
          closeLeaseGeneration: reservation?.generation ?? null,
        } })
      }
      if (command.type === 'agent.remove' && (actor.kind === 'agent' || effects.result.forceReleased)) {
        const target = agent(original, command.agentId)
        await tx.superTabRun.deleteMany({ where: { id: target.id, tabId, assignmentId: `release-${target.releaseId}` } })
        const id = stableId('swarm-session', original.environment, target.machineOwnerId, target.id)
        await tx.superTabSessionScope.upsert({ where: { id },
          create: { id, scopeIds: [], ...(effects.result.forceReleased ? { releasedTabIds: [tabId] } : {}) },
          update: { stopReleaseId: null, ...(effects.result.forceReleased ? { releasedTabIds: { push: tabId } } : { closeLeaseId: null, closeLeaseUntil: null, closeLeaseGeneration: null }) } })
      }
      if (command.type === 'work.assign') {
        const assigned = conversation(effects.state, command.conversationId).assignment!
        const running = await tx.superTabRun.findUnique({ where: { id: assigned.agentId } })
        // A record of this Swarm's for work that has ended here is stale (endRuns): it goes, by its own assignment, and the agent
        // is free. A record of another Swarm's, or a stopping agent's, still means busy.
        if (running && (running.tabId !== tabId || !(await this.staleRuns(tx, tabId, original)).includes(running.assignmentId))) {
          fail('AGENT_BUSY', 'This agent already owns active work in a Super Tab.')
        }
        if (running) await this.releaseRuns(tx, tabId, [running.assignmentId])
        await tx.superTabRun.create({ data: { id: assigned.agentId, tabId, assignmentId: assigned.id,
          machineId: assigned.execution.machineId, harnessId: assigned.execution.harnessId } })
      }
      await this.endRuns(tx, tabId, original, effects.state)
      const committed = await this.save(tx, loaded, effects.state, stamp, touchesFor(command, actor, original, effects, context))
      if (command.type === 'agent.add' || command.type === 'agent.started' || command.type === 'agent.configuration' || command.type === 'agent.rebind'
        || command.type === 'agent.startSettled') {
        for (const target of effects.state.agents) {
          if (target.configurationVersion !== receiptId) continue
          const previous = original.agents.find(a => a.id === target.id)
          if (previous?.configurationVersion === target.configurationVersion) continue
          // Ordered by the agent part's version, which never resets and starts above every older tab revision.
          await tx.superTabConfiguration.create({ data: {
            id: stableId(tabId, target.id, operationId), tabId, agentId: target.id, revision: committed.versions.get(`agent:${target.id}`) ?? 0,
            configuration: json(target.configuration), actorKey: actorKey(actor), observedAt: new Date(context.now),
            assignmentIds: effects.state.conversations.filter(group => activeWork(group) && group.assignment?.agentId === target.id)
              .map(group => group.assignment!.id),
          } })
        }
      }
      ended = endedHolds(original, effects.state)
      started = startedHolds(original, effects.state)
      await writeRouteEffects(tx, tabId, effects.routeDecisions, context.now)
      // An attempt finished by its own agent ends with the totals its host read as it finished; finished by anyone else, or
      // without them, its end is unknown (costs/attempts.ts endRun).
      const finished = command.type === 'work.status' && (command.status === 'done' || command.status === 'stopped') ? {
        assignmentId: command.assignmentId, tokens: actor.kind === 'agent'
          && original.conversations.find(c => c.id === command.conversationId)?.assignment?.agentId === actor.agentId ? command.tokens ?? null : null } : undefined
      await recordAttempts(tx, tabId, original, effects.state, context.now, finished)
      if (command.type === 'agent.startFailed') {
        const start = original.starts?.find(s => s.id === command.startId)
        if (start?.routeDecisionId) await closeUnassignedStart(tx, tabId, start.routeDecisionId, start.id, 'failed', context.now)
      }
      // Starts a removed machine failed, whether its owner removed it or left the Swarm with it, release their route holds.
      if (command.type === 'machine.remove' || command.type === 'member.remove') {
        for (const start of original.starts ?? []) {
          if (!start.routeDecisionId || start.harnessId || start.error) continue
          if (effects.state.starts?.find(s => s.id === start.id)?.error) {
            await closeUnassignedStart(tx, tabId, start.routeDecisionId, start.id, 'failed', context.now)
          }
        }
      }
      if (command.type === 'agent.remove' && actor.kind === 'agent' && actor.agentId === command.agentId) {
        const start = original.starts?.find(s => s.routeDecisionId && s.harnessId &&
          stableId(s.request.machineId, s.harnessId) === command.agentId)
        if (start?.routeDecisionId) await closeUnassignedStart(tx, tabId, start.routeDecisionId, start.id, 'stopped', context.now)
      }
      // Role texts are written no more (project instructions): a deleted project takes the ones it had.
      if (command.type === 'project.delete') await tx.superTabRoleText.deleteMany({ where: { tabId, projectId: command.projectId } })
      if (effects.instructions) await writeInstructions(tx, tabId, effects.instructions)
      if (effects.notes) await writeNotes(tx, tabId, effects.notes, context.now)
      if (command.type === 'project.delete') await deleteInstructions(tx, tabId, command.projectId)
      if (effects.terminal) await this.writeTerminal(tx, tabId, effects.terminal, context.now)
      if (this.hooks.accessChanged && watchersLost.length) {
        const told = this.hooks.accessChanged
        afterCommit(tx, () => told(tabId))
      }
      if (command.type === 'work.cancel') {
        await closeAssignment(tx, tabId, command.assignmentId, 'cancelled', context.now)
      }
      if (command.type === 'work.status' && (command.status === 'done' || command.status === 'stopped')) {
        await closeAssignment(tx, tabId, command.assignmentId, command.status, context.now)
      }
      await recordEvidence(tx, tabId, original, effects.state, context.now)
      await this.writeMessages(tx, tabId, effects.state, effects.messages, sequences)
      if (effects.lateDeliveries?.length) await this.writeLateDeliveries(tx, tabId, effects.state, effects.lateDeliveries)
      if (command.type === 'message.send' && actor.kind === 'person') await resolveByReply(tx, tabId, command.conversationId, actor.userId, context.now)
      if (command.type === 'work.assign') await resolveWhenWorked(tx, tabId, command.conversationId, context.now)
      // The Lead acting on a group ends the tags it held back about it (mentions.ts), before this command's own are written.
      const ledId = 'conversationId' in command ? command.conversationId : command.type === 'agent.start' ? command.request.conversationId : undefined
      const leadAt = (state: SuperTabState) => state.conversations.find(c => c.id === ledId)?.leadAction?.at
      if (ledId && leadAt(effects.state) !== undefined && leadAt(effects.state) !== leadAt(original)) await dropHeldTags(tx, tabId, ledId, context.now)
      await writeMentions(tx, tabId, effects.state, effects.messages, context.now)
      if (command.type === 'mention.done') await markDone(tx, tabId, command.mentionId, context.mention!.personId, context.now)
      if (command.type === 'message.react') await this.writeReaction(tx, tabId, actor, command)
      if (context.avatarUpload) {
        // Conflicts with a concurrent use of the same picture: only one command can take it.
        const taken = await tx.superTabAttachment.updateMany({ where: { tabId, id: context.avatarUpload.id, purpose: AVATAR_PURPOSE, ...unused },
          data: { usedBy: receiptId } })
        if (taken.count !== 1) fail('AVATAR_UNAVAILABLE', 'Upload this picture again before using it.', 400)
      }
      if (effects.decisions) {
        const ids = await writeDecisions(tx, tabId, effects.decisions, context.now)
        if (command.type === 'decision.ask') effects.result.decisionIds = ids
      }
      if (effects.decisionAnswer) await recordAnswer(tx, tabId, effects.decisionAnswer, context.now)
      if (claimed.length) {
        // Conflicts with a concurrent send of the same file: only one message can take it.
        const taken = await tx.superTabAttachment.updateMany({ where: { tabId, id: { in: claimed }, ...unused },
          data: { usedBy: effects.result.messageId as string } })
        if (taken.count !== claimed.length) fail('ATTACHMENT_USED', 'This file was already sent. Attach it again to send it in another message.')
      }
      if (proposed.length) {
        // Conflicts with a concurrent proposal carrying the same file of its owner's: only one can take it.
        const taken = await tx.superTabAttachment.updateMany({ where: { tabId, id: { in: proposed }, ...unproposed },
          data: { proposedBy: effects.result.messageId as string } })
        if (taken.count !== proposed.length) fail('ATTACHMENT_USED', PROPOSED)
      }
      // On 2026-10-20 a Lead answered a message it had already read, then answered it again when the held
      // delivery was finally typed. An agent's reply settles that agent's own deliveries of the message.
      if (command.type === 'message.send' && command.replyTo && actor.kind === 'agent') {
        await tx.superTabDelivery.updateMany({ where: { tabId, messageId: command.replyTo, agentId: actor.agentId,
          status: { in: ['queued', 'claimed', 'uncertain', 'delivered', 'confirmed'] } },
          data: { status: 'answered', answeredAt: new Date(context.now), holdReason: null, holdSince: null } })
      }
      if (command.type === 'project.report' && actor.kind === 'agent') {
        // Judged on the progress after this report summarized what it names.
        const progress = projectsOf(effects.state).find(p => p.id === command.projectId)?.progress
        if (progress?.requestMessageId && answersRequest(progress, command.throughRevision)) {
          await tx.superTabDelivery.updateMany({ where: { tabId, agentId: actor.agentId, messageId: progress.requestMessageId,
            status: { in: ['queued', 'claimed', 'uncertain', 'delivered', 'confirmed'] } },
            data: { status: 'answered', answeredAt: new Date(context.now), holdReason: null, holdSince: null } })
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
        status: { in: ['queued', 'claimed', 'uncertain'] }, OR: cancelled }, data: { status: 'cancelled', holdReason: null, holdSince: null } })
      for (const attempt of effects.previousAttempts) {
        await tx.superTabAttempt.create({ data: { id: attempt.assignment.id, tabId, conversationId: attempt.conversationId, snapshot: json(attempt) } })
      }
      await tx.superTabOperation.create({ data: { id: receiptId, tabId, actorKey: actorKey(actor), requestHash,
        revision: 0, parts: json(receiptParts(committed.written, stamp)), result: json(effects.result) } })
      return { result: effects.result, parts: committed.written, lastChangedAt: stamp }
    })
    this.endWork(tabId, ended)
    this.startWork(tabId, started)
    return done
  }

  private startWork(tabId: string, started: WorkHold[]): void {
    if (!started.length || !this.hooks.workStarted) return
    try { this.hooks.workStarted(tabId, started) } catch (error) {
      logger.warn('[super-tab] work-started hook failed', { tabId, error: error instanceof Error ? error.message : String(error) })
    }
  }

  private endWork(tabId: string, ended: WorkHold[]): void {
    if (!ended.length || !this.hooks.workEnded) return
    try { this.hooks.workEnded(tabId, ended) } catch (error) {
      logger.warn('[super-tab] work-ended hook failed', { tabId, error: error instanceof Error ? error.message : String(error) })
    }
  }

  /** What the Harness GitHub App may mint a token for (routes/superTabs.ts `github-token`): the calling host's own agent, on
   *  the machine its host names, with a task in its hands. Who the work is for, and the agent's and machine's names, go
   *  into its commits (github/attribution.ts). The caller checks that the repository is on GitHub. */
  async githubAssignment(user: AuthUser, tabId: string, asAgentId: string | undefined, machineId: string) {
    if (!asAgentId) fail('AGENT_REQUIRED', 'Ask for a GitHub token as the agent doing the work (asAgentId).', 400)
    return transaction(this.db, async tx => {
      const { state } = await this.load(tx, user, tabId)
      const actor = await this.actor(tx, user, state, asAgentId)
      // A read-only contribution reads; it does not push.
      author(state, actor, true)
      const target = agent(state, asAgentId)
      if (target.machineId !== machineId) fail('FORBIDDEN', 'Only the machine running this agent can ask for its GitHub token.', 403)
      const group = state.conversations.find(c => !isLeads(c) && c.assignment?.agentId === target.id && HOLDING.has(c.assignment.status)
        && c.assignment.execution.machineId === target.machineId && c.assignment.execution.machineOwnerId === target.machineOwnerId)
        ?? fail('NO_ASSIGNMENT', 'This agent has no task in progress. A GitHub token is only for an agent working on a task.')
      const project = groupProject(state, group)
      const owner = await tx.user.findUnique({ where: { id: project.ownerId }, select: { name: true, email: true } })
      const requester = owner ?? { name: null, email: state.people.find(p => p.id === project.ownerId)?.email ?? '' }
      if (!requester.email) fail('NOT_FOUND', 'This project\'s owner is unavailable.', 404)
      const contributed = state.machines?.find(m => m.machineId === target.machineId)?.name
      const machineName = contributed ?? await tx.machine.findFirst({ where: { machineId: target.machineId, userId: target.machineOwnerId },
        select: { name: true, hostname: true } }).then(m => m?.name ?? m?.hostname ?? null)
      return { tabId, projectId: project.id, approvalRequired: teamAccountRequired(state), agentId: target.id, assignmentId: group.assignment!.id,
        repositoryUrl: project.repository?.repositoryUrl ?? null,
        requester: { name: requester.name?.trim() || null, email: requester.email },
        agentName: agentDisplayName(state.agents, target.id) ?? target.displayName ?? target.name, machineName: machineName?.trim() || null }
    })
  }

  /**
   * What a contributed machine's host needs to prepare a queued start's folder before the agent exists (routes/superTabs.ts,
   * a start's `github-token`): the start's project repository, whom the work is for, and whether it is the machine owner's
   * own project. Only the host of that start, while nothing has started or failed yet, as `start()` reads it.
   */
  async githubStart(user: AuthUser, tabId: string, startId: string, machineId: string) {
    return transaction(this.db, async tx => {
      const { state } = await this.loadStart(tx, user, tabId, startId)
      const actor = await this.poolHostActor(tx, user, state, machineId, startId)
      const start = state.starts?.find(s => s.id === startId) ?? fail('NOT_FOUND', 'This agent start is unavailable.', 404)
      if (start.harnessId || start.error) fail('START_SETTLED', 'This start has already started or failed; its folder is not prepared again.', 409)
      if (person(state, start.contributorId).generation !== start.membershipGeneration) fail('FORBIDDEN', 'This contribution was withdrawn.', 403)
      // Its host acts as the agent that made the start (poolHostActor), which may carry it on whatever its role.
      const group = readConversation(state, actor, start.request.conversationId)
      if (group.archived) fail('ARCHIVED', 'This conversation is archived.')
      const grant = await this.contribution(tx, state, actor, start.request, true)
      if (grant.machineOwnerId !== start.machineOwnerId || (grant.hostGrant ?? null) !== start.hostGrant) {
        fail('CONTRIBUTION_REVOKED', 'This start belongs to a machine grant that was revoked.', 403)
      }
      // A Swarm-wide Buddy's folder is made of checkouts already on its machine: there is no repository to fetch for it.
      const project = startProject(state, start.request) ?? fail('NOT_FOUND', 'This start has no project folder to prepare.', 404)
      const owner = await tx.user.findUnique({ where: { id: project.ownerId }, select: { name: true, email: true } })
      const email = owner?.email ?? state.people.find(p => p.id === project.ownerId)?.email ?? ''
      return { tabId, projectId: project.id, repositoryUrl: project.repository?.repositoryUrl ?? null, approvalRequired: teamAccountRequired(state),
        startId, own: project.ownerId === start.machineOwnerId,
        requester: { name: owner?.name?.trim() || null, email } }
    })
  }

  /** Streams one file into the bucket for a later `message.send` by the same actor in the same conversation. Access is
   * checked before a byte is stored; the row that makes it sendable is written only once the whole file is. */
  async upload(user: AuthUser, tabId: string, conversationId: string, file: { name: string; mime: string; body: Readable }, asAgentId?: string) {
    const attachments = this.attachments ?? fail('ATTACHMENTS_UNAVAILABLE', 'File attachments are not available on this server.', 503)
    // A file's name is shown in the chat like its message, so it never keeps a credential either.
    const name = attachmentName.transform(value => redactCredentials(value).text).safeParse(file.name), mime = attachmentMime.safeParse(file.mime)
    if (!name.success || !mime.success) fail('INVALID_ATTACHMENT', 'Attach a file with a printable name and a content type.', 400)
    const key = await this.uploader(tabId, tx => this.poster(tx, user, tabId, conversationId, asAgentId).then(p => p.actor))
    const row = await this.keep(attachments.store, attachments.prefix, tabId, key, { name: name.data, conversationId },
      async () => checkedType(mime.data, file.body), file.body, MAX_FORM_ATTACHMENT_BYTES)
    return { attachment: { id: row.id, name: row.name, mime: row.mime, size: row.size, url: publicUrl(attachments.publicBase, row.objectKey) } satisfies Attachment }
  }

  /** A link to put one file of `size` bytes straight into the bucket, for a file too big for this server's form route. The
   *  checks are upload()'s: the actor may post in this conversation and is under its hourly allowance, before any link is
   *  signed. The row is written pending: no message can name it until completeUpload() has seen the stored bytes. An upload
   *  never completed, like an unsent file, is an unused row the unsent-file sweep removes with its object (#2268). */
  async uploadLink(user: AuthUser, tabId: string, conversationId: string, file: { name: string; mime: string; size: number }, asAgentId?: string) {
    const attachments = this.attachments ?? fail('ATTACHMENTS_UNAVAILABLE', 'File attachments are not available on this server.', 503)
    const direct = directUploads(attachments.store) ?? fail('ATTACHMENTS_UNAVAILABLE', 'Files this big cannot be sent to this server.', 503)
    const name = attachmentName.transform(value => redactCredentials(value).text).safeParse(file.name), mime = attachmentMime.safeParse(file.mime)
    if (!name.success || !mime.success) fail('INVALID_ATTACHMENT', 'Attach a file with a printable name and a content type.', 400)
    if (!Number.isSafeInteger(file.size) || file.size < 1) fail('INVALID_ATTACHMENT', 'Name the file\'s size in bytes.', 400)
    if (file.size > MAX_ATTACHMENT_BYTES) fail('ATTACHMENT_TOO_LARGE', TOO_LARGE_MESSAGE, 413)
    const objectKey = objectKeyFor(attachments.prefix, tabId, name.data)
    // The pending row is written before any link is signed, in the transaction that counts the sender's last hour. Each request
    // first writes the sender's allowance row there, so two at once conflict and one retries after the other commits: parallel
    // requests stop at the limits. The row is made outside it once, since a duplicate key is not retried and a conflict is.
    const { key, allowance } = await transaction(this.db, async tx => {
      const { actor } = await this.poster(tx, user, tabId, conversationId, asAgentId)
      const key = actorKey(actor)
      return { key, allowance: `${tabId}:${key}` }
    })
    const counted = () => transaction(this.db, async tx => {
      await this.poster(tx, user, tabId, conversationId, asAgentId)
      await tx.superTabUploadAllowance.update({ where: { id: allowance }, data: { at: new Date(this.now()) } })
      const recent = await tx.superTabAttachment.findMany({ where: { tabId, actorKey: key, createdAt: { gte: new Date(this.now() - 3_600_000) } }, select: { size: true } })
      if (recent.length >= HOURLY_UPLOADS) fail('RATE_LIMITED', `You attached ${HOURLY_UPLOADS} files in the last hour. Wait before attaching more.`, 429)
      if (recent.reduce((sum, r) => sum + r.size, 0) + file.size > HOURLY_UPLOAD_BYTES) {
        fail('RATE_LIMITED', 'You attached 4 GB of files in the last hour. Wait before attaching more.', 429)
      }
      return tx.superTabAttachment.create({ data: { id: randomBytes(12).toString('hex'), tabId, conversationId, actorKey: key,
        name: name.data, mime: mime.data, size: file.size, objectKey, purpose: PENDING_UPLOAD_PURPOSE } })
    })
    // The sweep may remove the allowance row (an hour unused) between its create and the update: made again, a few times.
    let row: Awaited<ReturnType<typeof counted>> | undefined
    for (let attempt = 1; !row; attempt++) {
      await this.db.superTabUploadAllowance.create({ data: { id: allowance, at: new Date(this.now()) } }).catch(error => { if (errorCode(error) !== 'P2002') throw error })
      try { row = await counted() } catch (error) { if (errorCode(error) !== 'P2025' || attempt === 3) throw error }
    }
    const expiresAt = this.now() + UPLOAD_LINK_MS
    let link: { url: string; headers: Record<string, string> }
    try { link = await direct.uploadLink(objectKey, { name: name.data }, file.size, expiresAt) } catch (error) {
      // The signing error's text is never logged: it may carry the object's key, which is the file's link.
      logger.error('super-tab upload link failed', { tabId, code: errorCode(error) })
      // No link was handed out, so nothing can write the object: the row goes now, not with the sweep.
      await this.db.superTabAttachment.deleteMany({ where: { id: row.id, tabId, purpose: PENDING_UPLOAD_PURPOSE } }).catch(() => {})
      fail('ATTACHMENTS_UNAVAILABLE', 'Could not prepare the upload just now. Try again.', 503)
    }
    return { upload: { id: row.id, url: link.url, method: 'PUT' as const, headers: link.headers, expiresAt } }
  }

  /** Makes a link's upload sendable once its bytes are in the bucket: only by the actor that asked for the link, while it may
   *  still post in that conversation, and only when storage holds exactly the size it asked for. An image keeps its type only
   *  when its first bytes agree. Answered again, the same way, after a lost answer. */
  async completeUpload(user: AuthUser, tabId: string, uploadId: string, asAgentId?: string) {
    const attachments = this.attachments ?? fail('ATTACHMENTS_UNAVAILABLE', 'File attachments are not available on this server.', 503)
    const direct = directUploads(attachments.store) ?? fail('ATTACHMENTS_UNAVAILABLE', 'Files this big cannot be sent to this server.', 503)
    // Someone else's upload, another Swarm's and one that never was answer alike, so nobody learns that it exists.
    const unavailable = () => fail('ATTACHMENT_UNAVAILABLE', 'Attach this file again before sending it.', 400)
    const row = await transaction(this.db, async tx => {
      const { state } = await this.load(tx, user, tabId, {})
      const actor = await this.actor(tx, user, state, asAgentId)
      const found = await tx.superTabAttachment.findFirst({ where: { tabId, id: uploadId } })
      if (!found || found.actorKey !== actorKey(actor) || found.usedBy || (found.purpose && found.purpose !== PENDING_UPLOAD_PURPOSE)) unavailable()
      // Access may have gone while the bytes moved: the actor must still be able to post there.
      await this.poster(tx, user, tabId, found!.conversationId, asAgentId)
      return found!
    })
    const sendable = (mime: string) => ({ attachment: { id: row.id, name: row.name, mime, size: row.size, url: publicUrl(attachments.publicBase, row.objectKey) } satisfies Attachment })
    if (!row.purpose) return sendable(row.mime)
    let stored: { size: number } | null, head: Buffer
    try {
      stored = await direct.stored(row.objectKey)
      head = stored && stored.size === row.size ? await direct.head(row.objectKey, 16) : Buffer.alloc(0)
    } catch (error) {
      logger.error('super-tab upload check failed', { tabId, code: errorCode(error) })
      fail('ATTACHMENTS_UNAVAILABLE', 'Could not check the file just now. Try again.', 503)
    }
    if (!stored) fail('UPLOAD_INCOMPLETE', 'The file did not finish uploading. Try again.', 409)
    if (stored!.size !== row.size) {
      // Storage enforces the size the link signed, so this is never expected; the object goes and the row stays for the sweep.
      await direct.delete(row.objectKey).catch(() => {})
      unavailable()
    }
    const mime = typeFromHead(row.mime, head!)
    const finished = await this.db.superTabAttachment.updateMany({ where: { id: row.id, tabId, purpose: PENDING_UPLOAD_PURPOSE }, data: { purpose: { unset: true }, mime } })
    if (finished.count === 1) return sendable(mime)
    // Another finish of the same upload won: the same answer. The sweep claimed it first: its file is going, so it is refused.
    const now = await this.db.superTabAttachment.findFirst({ where: { id: row.id, tabId } })
    return now && !now.purpose && !now.usedBy ? sendable(now.mime) : unavailable()
  }

  /** A picture for a person's or an agent's avatar (profile.ts): png, jpg or webp by its real bytes, at most 1 MB. Any
   *  member who may write uploads one; the command that sets it decides whose it becomes. */
  async uploadAvatar(user: AuthUser, tabId: string, file: { body: Readable }, asAgentId?: string) {
    // Off until a bucket for avatars is configured (attachmentsFromEnv); presets still work.
    const avatars = this.attachments?.avatars ?? fail('AVATARS_UNAVAILABLE', 'Uploading pictures is not set up on this server yet. Pick one of the pictures instead.', 503)
    const key = await this.uploader(tabId, async tx => {
      const { state } = await this.load(tx, user, tabId, {})
      const actor = await this.actor(tx, user, state, asAgentId)
      author(state, actor, true)
      return actor
    })
    const row = await this.keep(avatars, this.avatarPrefix, tabId, key, { name: 'avatar', conversationId: '', purpose: AVATAR_PURPOSE }, async () => {
      const peeked = await peekType(file.body)
      if (!peeked.type || !AVATAR_TYPES.has(peeked.type)) fail('AVATAR_TYPE', 'Use a PNG, JPEG or WebP picture.', 415)
      return { mime: peeked.type, body: peeked.body }
    }, file.body, MAX_AVATAR_BYTES)
    // No link: a picture is only reached through the links member reads carry (avatarLinks.ts).
    return { avatar: { id: row.id } }
  }

  /** The uploading actor's key, once it may upload and is under its hourly allowance: unsent files cost bucket space. */
  private async uploader(tabId: string, allowed: (tx: Transaction) => Promise<Actor>): Promise<string> {
    return transaction(this.db, async tx => {
      const key = actorKey(await allowed(tx))
      const recent = await tx.superTabAttachment.count({ where: { tabId, actorKey: key, createdAt: { gte: new Date(this.now() - 3_600_000) } } })
      if (recent >= 200) fail('RATE_LIMITED', 'You attached 200 files in the last hour. Wait before attaching more.', 429)
      return key
    })
  }

  /** Streams one file into the bucket under a random key, as the type `typed` decides from its first bytes, and records it. */
  private async keep(bucket: AttachmentStore, prefix: string, tabId: string, actorKey: string, file: { name: string; conversationId: string; purpose?: string },
    typed: () => Promise<{ mime: string; body: Readable }>, original: Readable, cap: number) {
    const objectKey = objectKeyFor(prefix, tabId, file.name)
    let size: number, mime: string
    try {
      const checked = await typed()
      mime = checked.mime
      size = await bucket.put(objectKey, { name: file.name, mime }, checked.body, cap)
    } catch (error) {
      if (error instanceof SuperTabError) throw error
      if (error instanceof AttachmentTooLarge) {
        if (file.purpose === AVATAR_PURPOSE) fail('AVATAR_TOO_LARGE', 'An avatar can be at most 1 MB.', 413)
        fail('ATTACHMENT_TOO_LARGE', error.message, 413)
      }
      // The client's own stream breaking is the request's; anything else is the bucket's, and the person can try again.
      if (original.errored || (error && typeof error === 'object' && 'code' in error && String(error.code).startsWith('FST_'))) throw error
      logger.error('super-tab attachment storage failed', { tabId, error: error instanceof Error ? error.message : String(error) })
      fail('ATTACHMENTS_UNAVAILABLE', 'Could not store the file just now. Try again.', 503)
    }
    return this.db.superTabAttachment.create({ data: { id: randomBytes(12).toString('hex'), tabId, conversationId: file.conversationId,
      actorKey, name: file.name, mime, size, objectKey, ...(file.purpose ? { purpose: file.purpose } : {}) } })
  }

  /** The actor, once it may post in this conversation. */
  private async poster(tx: Transaction, user: AuthUser, tabId: string, conversationId: string, asAgentId?: string) {
    const { state } = await this.load(tx, user, tabId, { groupIds: [conversationId] })
    const actor = await this.actor(tx, user, state, asAgentId)
    author(state, actor, true)
    readConversation(state, actor, conversationId)
    postable(state, actor, conversationId)
    return { state, actor }
  }

  private async sendable(tx: Transaction, tabId: string, actor: Actor, command: SendCommand): Promise<Attachment[]> {
    const attachments = this.attachments ?? fail('ATTACHMENTS_UNAVAILABLE', 'File attachments are not available on this server.', 503)
    const ids = [...new Set(command.attachmentIds)]
    const rows = await tx.superTabAttachment.findMany({ where: { tabId, id: { in: ids } } })
    return ids.map(id => {
      const row = rows.find(r => r.id === id)
      if (!row || row.actorKey !== actorKey(actor) || row.conversationId !== command.conversationId || row.purpose) {
        fail('ATTACHMENT_UNAVAILABLE', 'Attach this file again before sending it.', 400)
      }
      if (row.usedBy) fail('ATTACHMENT_USED', 'This file was already sent. Attach it again to send it in another message.')
      return { id: row.id, name: row.name, mime: row.mime, size: row.size, url: publicUrl(attachments.publicBase, row.objectKey) }
    })
  }

  /**
   * The files a Buddy's proposal names (buddies.ts), and which of them it takes. Only what its owner handed it: its own upload
   * to its chat, still unsent, which the proposal then takes like a chat message; or a file its owner sent in that chat,
   * which stays with their message too and goes with one proposal at most. Nothing else is found, so the command refuses
   * it, its own order of refusals first. The server cannot tell where an upload's bytes came from on the Buddy's machine:
   * that is its CLI's folder check and its guard (lib/buddyGuard.ts), and here only what it uploaded to its own chat.
   */
  private async proposable(tx: Transaction, state: SuperTabState, actor: Actor, command: ProposeCommand): Promise<{ attachments: Attachment[]; claimed: string[]; proposed: string[] }> {
    const attachments = this.attachments ?? fail('ATTACHMENTS_UNAVAILABLE', 'File attachments are not available on this server.', 503)
    const self = actor.kind === 'agent' ? state.agents.find(a => a.id === actor.agentId) : undefined
    const ownerId = self?.buddyOf?.personId
    if (!ownerId) return { attachments: [], claimed: [], proposed: [] }
    const ids = [...new Set(command.attachmentIds)]
    const rows = await tx.superTabAttachment.findMany({ where: { tabId: state.id, id: { in: ids }, conversationId: command.conversationId } })
    const own = rows.filter(r => !r.purpose && r.actorKey === actorKey(actor) && !r.usedBy)
    let handed = rows.filter(r => !r.purpose && r.actorKey === `person:${ownerId}` && !!r.usedBy)
    // A thread session reads its own thread alone, so it proposes only files its person sent there (spec: Guard): a file from
    // the main chat or another thread could be another project's.
    const thread = self.buddySession?.thread
    if (thread && handed.length) {
      // By the messages' ids through their named index (pageReads.ts messagesById), never an `in` filter on a hot collection.
      const inThread = new Set((await messagesById(tx, state.id, command.conversationId, handed.map(r => r.usedBy!)))
        .filter(m => m.id === thread || m.thread === thread).map(m => m.id))
      handed = handed.filter(r => inThread.has(r.usedBy!))
    }
    return { attachments: [...own, ...handed].map(row => ({ id: row.id, name: row.name, mime: row.mime, size: row.size, url: publicUrl(attachments.publicBase, row.objectKey) })),
      claimed: own.map(r => r.id), proposed: handed.map(r => r.id) }
  }

  /** The message a reaction names, when it is in that conversation and this actor may see it, and whether the actor already
   *  reacted to it with that emoji. An agent-only notice is its recipient's alone. */
  private async reactionTarget(tx: Transaction, tabId: string, actor: Actor, command: ReactCommand, state: SuperTabState): Promise<ReactionTarget | undefined> {
    const message = await tx.superTabMessage.findFirst({ where: { id: command.messageId, tabId, conversationId: command.conversationId },
      select: { id: true, source: true, recipientIds: true, thread: true, buddySession: true, author: true, buddyProject: true } })
    if (!message || (agentOnly(message.source, message.recipientIds) && !(actor.kind === 'agent' && message.recipientIds.includes(actor.agentId)))) return undefined
    // A Buddy reacts only to what it may read (buddySessions.ts): a session to its own thread, the main Buddy to no session's
    // replies (security review 2 of #2345). Refused as a message it cannot see.
    const group = state.conversations.find(c => c.id === command.conversationId)
    const reader = actor.kind === 'agent' ? state.agents.find(a => a.id === actor.agentId) : undefined
    if (group && !sessionReadsRow(reader, group, state)(message)) return undefined
    if ((await deliveredCopies(tx, tabId, [message])).size) return undefined
    return { messageId: message.id, reacted: !!await tx.superTabReaction.findUnique({ where: { id: reactionId(tabId, actor, command) } }) }
  }

  /** Writes or removes the actor's reaction row. The same reaction twice keeps one row: its id is derived. */
  private async writeReaction(tx: Transaction, tabId: string, actor: Actor, command: ReactCommand) {
    const id = reactionId(tabId, actor, command)
    if (!command.on) return void await tx.superTabReaction.deleteMany({ where: { id } })
    const actorId = actor.kind === 'person' ? actor.userId : actor.agentId
    await tx.superTabReaction.upsert({ where: { id }, update: {}, create: { id, tabId, conversationId: command.conversationId,
      messageId: command.messageId, actorKind: actor.kind, actorId, emoji: command.emoji } })
  }

  /** The avatar upload a command names, when it is this actor's, an avatar and unused; otherwise the command refuses it. */
  private async avatarUpload(tx: Transaction, tabId: string, actor: Actor, id: string): Promise<AvatarUpload | undefined> {
    const row = await tx.superTabAttachment.findFirst({ where: { tabId, id, actorKey: actorKey(actor), purpose: AVATAR_PURPOSE, ...unused } })
    return row ? { id: row.id, key: row.objectKey } : undefined
  }

  /** Keeps the project's stored texts equal to its custom set: the roles the command wrote, nothing for roles it dropped. */
  /** A custom role's text, for the project's owner, its Lead, and the hosts of its agents (which fetch it when the version
   *  in their roster changes). Anyone else, like a missing role, reads it as unavailable. */
  async roleText(user: AuthUser, tabId: string, projectId: string, roleId: string, asAgentId?: string) {
    return transaction(this.db, async tx => {
      const { state } = await this.load(tx, user, tabId)
      const unavailable = () => fail('NOT_FOUND', 'This role is unavailable.', 404)
      const project = projectsOf(state).find(p => p.id === projectId) ?? unavailable()
      const role = project.roles?.find(r => r.id === roleId) ?? unavailable()
      const team = await this.teamHost(tx, user)
      if (asAgentId) {
        await this.actor(tx, user, state, asAgentId)
        if (ledProject(state, asAgentId)?.id !== project.id) unavailable()
      } else if (team !== null) {
        // A team session is never the project's owner: it reads a text only for an agent its own machine hosts.
        if (!await this.hostsProject(tx, state, user, project.id, team)) unavailable()
      } else if (!(user.sub === project.ownerId && state.people.some(p => p.id === user.sub) && await hasWorkspaceAccess(tx, state, user.sub))
        && !await this.hostsProject(tx, state, user, project.id)) {
        unavailable()
      }
      const stored = await tx.superTabRoleText.findUnique({ where: { id: stableId(tabId, projectId, roleId) } })
      if (stored?.version !== role.version) unavailable()
      return { version: stored!.version, text: stored!.text }
    })
  }

  /** A project's instructions as they are now: the text, its revision and hash, the coordinator's name and its live notes.
   *  Anyone who reads the project reads them (design, Audience); a Buddy reads the text as its member's helper, never the
   *  notes. Revision 0 is a project without a document yet, which runs on the built-in template until the migration. */
  async instructions(user: AuthUser, tabId: string, projectId: string, asAgentId?: string) {
    return transaction(this.db, async tx => {
      const { state } = await this.load(tx, user, tabId)
      const actor = await this.actor(tx, user, state, asAgentId)
      const project = readProject(state, actor, projectId)
      // A Buddy reads as its person at the membership they added it in, as its other reads do: one whose person lost a private
      // project reads nothing of it (review of phase 2).
      const buddy = actor.kind === 'agent' ? state.agents.find(a => a.id === actor.agentId && isBuddy(a)) : undefined
      if (buddy && !buddyPerson(state, buddy, project)) fail('NOT_FOUND', 'This project is unavailable.', 404)
      const revision = project.instructionsRevision ?? 0
      const stored = revision ? await tx.superTabInstructions.findUnique({ where: { id: instructionsId(tabId, projectId) } }) : null
      // Written in the same transaction as the revision, so a gap is a fault: said, never filled with another text.
      if (revision && stored?.revision !== revision) fail('INSTRUCTIONS_UNAVAILABLE', 'This project\'s instructions cannot be read now. Try again in a moment.', 503)
      const notes = buddy ? undefined : liveNotes(await readNotes(tx, tabId, projectId), this.now())
        .map(n => ({ id: n.id, text: n.text, askedBy: n.askedBy, at: new Date(n.at), expiresAt: n.expiresAt === null ? null : new Date(n.expiresAt) }))
      return { projectId, revision, hash: stored?.hash ?? null, text: stored?.text ?? INSTRUCTIONS_TEMPLATE, template: !stored,
        coordinatorName: coordinatorNameOf(project), notesRevision: project.notesRevision ?? 0, ...(notes ? { notes } : {}) }
    })
  }

  /** The project's kept revisions, newest first, without their text; or one of them with it. A Buddy reads neither: the
   *  history names who asked for what. */
  async instructionRevisions(user: AuthUser, tabId: string, projectId: string, asAgentId?: string) {
    return this.instructionHistory(user, tabId, projectId, asAgentId, async tx => {
      const rows = await tx.superTabInstructionsRevision.findMany({ where: { tabId, projectId }, orderBy: { revision: 'desc' }, take: MAX_REVISIONS,
        select: { revision: true, hash: true, summary: true, writtenByKind: true, writtenBy: true, askedBy: true, at: true } })
      return { projectId, revisions: rows.map(({ writtenByKind, writtenBy, ...row }) => ({ ...row, writtenBy: { kind: writtenByKind, id: writtenBy } })) }
    })
  }

  async instructionRevision(user: AuthUser, tabId: string, projectId: string, revision: number, asAgentId?: string) {
    return this.instructionHistory(user, tabId, projectId, asAgentId, async tx => {
      const row = await tx.superTabInstructionsRevision.findUnique({ where: { id: revisionId(tabId, projectId, revision) } })
      if (!row || row.tabId !== tabId || row.projectId !== projectId) fail('NOT_FOUND', 'This revision is unavailable.', 404)
      return { projectId, revision: row.revision, hash: row.hash, text: row.text, summary: row.summary, writtenBy: { kind: row.writtenByKind, id: row.writtenBy },
        askedBy: row.askedBy, at: row.at }
    })
  }

  private async instructionHistory<T>(user: AuthUser, tabId: string, projectId: string, asAgentId: string | undefined, read: (tx: Transaction) => Promise<T>) {
    return transaction(this.db, async tx => {
      const { state } = await this.load(tx, user, tabId)
      const actor = await this.actor(tx, user, state, asAgentId)
      readProject(state, actor, projectId)
      if (isBuddyReader(state, actor)) fail('NOT_FOUND', 'This project is unavailable.', 404)
      return read(tx)
    })
  }

  /** Whether this account could host one of the project's agents now, by the same live grant as its host reads; on
   *  [machineId] alone when given. */
  private async hostsProject(tx: Transaction, state: SuperTabState, user: AuthUser, projectId: string, machineId?: string): Promise<boolean> {
    for (const target of state.agents.filter(a => a.machineOwnerId === user.sub && (!machineId || a.machineId === machineId)
      && agentProjectId(state, a) === projectId)) {
      try { agent(state, target.id); await this.agentGrant(tx, state, target); return true }
      catch (error) { if (!(error instanceof SuperTabError)) throw error }
    }
    return false
  }

  private async writeTerminal(tx: Transaction, tabId: string, effect: TerminalEffect, now: number) {
    if (effect.op === 'request') {
      const { op: _op, id, ...request } = effect
      await tx.superTabTerminalRequest.create({ data: { id, tabId, ...request, createdAt: new Date(now) } })
      return
    }
    // The deadline holds whether or not the sender has asked for the answer yet.
    const answered = await tx.superTabTerminalRequest.updateMany({ where: { id: effect.id, tabId, status: 'claimed', claimedAt: { gte: new Date(now - TERMINAL_ANSWER_MS) } },
      data: { status: 'done', ok: effect.ok, result: effect.text, error: effect.error } })
    if (!answered.count) fail('REQUEST_CLOSED', 'This terminal request is no longer waiting for an answer.')
    this.terminalAnswered(tx, effect.id)
  }

  private terminalAnswered(tx: Transaction, requestId: string) {
    const told = this.hooks.terminalAnswered
    if (told) afterCommit(tx, () => told(requestId))
  }

  /** The requester alone reads the answer, once: the screen text is deleted as it is returned. Waits up to `waitMs` for it,
   *  reading again when the host's answer or refusal is told, when the request turns late, or every few seconds unwoken. */
  async terminalResult(user: AuthUser, tabId: string, requestId: string, asAgentId?: string, waitMs = 0) {
    const deadline = Date.now() + waitMs
    let told = false, done = false, wake = () => {}, stop = () => {}
    // Never awaited: while Redis is down a subscribe waits for it, and the wait reads on its own clock meanwhile.
    if (waitMs > 0) this.hooks.watchTerminal?.(requestId, () => { told = true; wake() })
      .then(dispose => { if (done) dispose(); else stop = dispose }, () => {})
    try {
      for (;;) {
        told = false
        const { answer, lateIn } = await transaction(this.db, async tx => {
          const { state } = await this.load(tx, user, tabId)
          const actor = await this.actor(tx, user, state, asAgentId)
          author(state, actor)
          const now = this.now()
          const row = await tx.superTabTerminalRequest.findFirst({ where: { id: requestId, tabId, createdAt: { gte: new Date(now - TERMINAL_EXPIRY_MS) } } })
          if (!row || row.requesterKey !== actorKey(actor)) fail('NOT_FOUND', 'This terminal request is unavailable.', 404)
          // A sender who has since lost write access, or is no longer an agent of the agent's project, gets nothing.
          mayDrive(state, actor, agent(state, row.agentId), await this.confidential(tx, row.agentId))
          // How long until a request still waiting turns late by itself.
          const lateIn = row.status === 'pending' ? row.createdAt.getTime() + TERMINAL_PICKUP_MS - now
            : row.status === 'claimed' ? row.claimedAt!.getTime() + TERMINAL_ANSWER_MS - now : 0
          const late = row.status === 'pending' && lateIn < 0
            ? 'The agent’s machine did not pick up the request within 10 seconds. It may be offline or asleep.'
            : row.status === 'claimed' && lateIn < 0
              ? 'The agent’s machine picked up the request but did not answer within 30 seconds.' : null
          if (row.status !== 'done' && !late) return { answer: null, lateIn }
          await tx.superTabTerminalRequest.delete({ where: { id: row.id } })
          if (late || !row.ok) return { answer: { requestId, ok: false, error: late ?? row.error }, lateIn }
          return { answer: { requestId, ok: true, ...(row.result !== null ? { text: row.result } : {}) }, lateIn }
        })
        if (answer) return answer
        const left = deadline - Date.now()
        if (left <= 0) return { requestId, pending: true }
        if (told) continue
        await new Promise<void>(resolve => {
          const timer = setTimeout(resolve, Math.min(left, lateIn + 1, TERMINAL_RECHECK_MS))
          wake = () => { clearTimeout(timer); resolve() }
        })
        wake = () => {}
      }
    } finally { done = true; stop() }
  }

  /** Each waiting request for this host's agents is handed over once. One that waited too long, or whose terminal, agent or
   * requester changed, is answered with the reason instead, so input is never typed late or into another pane. */
  async hostTerminal(user: AuthUser, machineId: string) {
    return transaction(this.db, async tx => {
      await this.hostFor(tx, user, machineId)
      const owned = await tx.machine.findFirst({ where: { machineId, userId: user.sub, autonomousEnv: user.autonomousEnv, ...machineAlive } })
      if (!owned || !machineBillingAllowsDataPlane(owned)) fail('HOST_UNAVAILABLE', 'This execution host is unavailable.', 403)
      const now = this.now()
      const rows = await tx.superTabTerminalRequest.findMany({ where: { machineId, machineOwnerId: user.sub, status: 'pending' },
        orderBy: { createdAt: 'asc' }, take: 100 })
      const states = new Map<string, SuperTabState | null>()
      const result = []
      for (const row of rows) {
        if (!states.has(row.tabId)) {
          const tab = await tx.superTab.findFirst({ where: { id: row.tabId, autonomousEnv: user.autonomousEnv }, select: SWARM_ROW })
          states.set(row.tabId, tab?.format === 2 ? (await loadRow(tx, tab)).state : null)
        }
        const refusal = now - row.createdAt.getTime() > TERMINAL_PICKUP_MS
          ? 'The agent’s machine did not pick up the request within 10 seconds. It may be offline or asleep.'
          : await this.terminalRefusal(tx, states.get(row.tabId)!, row, isTeamSession(user))
        if (refusal) {
          const refused = await tx.superTabTerminalRequest.updateMany({ where: { id: row.id, status: 'pending' }, data: { status: 'done', ok: false, error: refusal } })
          if (refused.count) this.terminalAnswered(tx, row.id)
          continue
        }
        const claimed = await tx.superTabTerminalRequest.updateMany({ where: { id: row.id, status: 'pending' }, data: { status: 'claimed', claimedAt: new Date(now) } })
        if (!claimed.count) continue
        result.push({ tabId: row.tabId, agentId: row.agentId, harnessId: row.harnessId, request: { id: row.id, kind: row.kind,
          ...(row.scrollback !== null ? { scrollback: row.scrollback } : {}), ...(row.text !== null ? { text: row.text } : {}),
          ...(row.keys.length ? { keys: row.keys } : {}) } })
      }
      return result
    })
  }

  private async terminalRefusal(tx: Transaction, state: SuperTabState | null,
    row: { agentId: string; machineId: string; machineOwnerId: string; harnessId: string; requesterKey: string }, team = true): Promise<string | null> {
    const target = state?.agents.find(a => a.id === row.agentId && a.machineId === row.machineId && a.machineOwnerId === row.machineOwnerId)
    if (!state || !target) return 'The agent is no longer in the Swarm.'
    // Only its Team account answers for an agent there, never its owner's own sign-in (security re-check 2 of #2089).
    if (!team && onTeamAccount(state, target)) return 'Only this computer\'s Harness Team account answers for its agents.'
    if (target.harnessId !== row.harnessId) return 'The agent’s terminal changed since the request. Read it again.'
    const [kind, id] = [row.requesterKey.slice(0, row.requesterKey.indexOf(':')), row.requesterKey.slice(row.requesterKey.indexOf(':') + 1)]
    const requester: Actor = kind === 'person' ? { kind: 'person', userId: id, email: '' }
      : { kind: 'agent', agentId: id, machineOwnerId: state.agents.find(a => a.id === id)?.machineOwnerId ?? '' }
    try {
      agent(state, target.id)
      await this.agentGrant(tx, state, target)
      mayDrive(state, requester, target, await this.confidential(tx, target.id))
    } catch (error) {
      if (error instanceof SuperTabError) return 'This request is no longer allowed.'
      throw error
    }
    return null
  }

  /** Frees the agents of work that ended in this write, wherever it ended: a command, the liveness checks on a machine's report
   *  or on the Lead's poll (a lost task), or a cancel of work already lost. Their run record goes, so the agent can take work
   *  again, and whatever was still queued for that work is dropped. Until 2026-10-27 only a command that ended active work did
   *  this, so the 16 tasks a release's update outage lost kept their agents busy for good. */
  private async endRuns(tx: Transaction, tabId: string, before: SuperTabState, after: SuperTabState) {
    const ended = new Set<string>()
    const earlier = new Map(before.conversations.map(c => [c.id, c])), later = new Map(after.conversations.map(c => [c.id, c]))
    for (const group of after.conversations) {
      const now = group.assignment, was = earlier.get(group.id)?.assignment
      if (now && !activeWork(group) && (now.id !== was?.id || now.status !== was.status)) ended.add(now.id)
    }
    for (const group of before.conversations.filter(activeWork)) {
      const changed = later.get(group.id)
      if (!changed || !activeWork(changed) || changed.assignment!.id !== group.assignment!.id) ended.add(group.assignment!.id)
    }
    await this.releaseRuns(tx, tabId, [...ended])
  }

  /** For these ended assignments of this Swarm, by their exact ids: their run records go, and their deliveries still queued,
   *  claimed or uncertain are cancelled, so a returning worker never receives a lost task's old instructions after new work
   *  (review of #1781). Exact ids never match the record or deliveries of an assignment made since. */
  private async releaseRuns(tx: Transaction, tabId: string, assignmentIds: string[]) {
    if (!assignmentIds.length) return
    const assignmentId = { in: assignmentIds }
    await tx.superTabRun.deleteMany({ where: { tabId, assignmentId } })
    await tx.superTabDelivery.updateMany({ where: { tabId, assignmentId, status: { in: ['queued', 'claimed', 'uncertain'] } },
      data: { status: 'cancelled', holdReason: null, holdSince: null } })
  }

  /** Run records an older server left in this Swarm for work that is no longer active here (see endRuns). Only this Swarm's,
   *  whose work it can see has ended; never one of another Swarm's, nor a stopping agent's (its record is the stop's fence). */
  private async staleRuns(tx: Transaction, tabId: string, state: SuperTabState): Promise<string[]> {
    const active = new Set(state.conversations.filter(activeWork).map(c => c.assignment!.id))
    const rows = await tx.superTabRun.findMany({ where: { tabId }, select: { assignmentId: true } })
    return rows.map(r => r.assignmentId).filter(id => !id.startsWith('release-') && !active.has(id))
  }

  /** Records committed messages, each at the sequence its conversation gave it, and one delivery per recipient. The time
   *  checks of a machine's report and of a Lead's poll pass `keepStored`: a notice of theirs already stored as that same
   *  notice (its Swarm, its conversation and its whole source: the kind, and for a loss its worker, task and reason) is
   *  kept, and only its missing deliveries are written. One duplicate had stopped every later report and poll
   *  (2026-10-28); any other message under the id still fails, so another task's notice is never delivered as this one. */
  private async writeMessages(tx: Transaction, tabId: string, state: SuperTabState, messages: MessageDraft[], sequences: ReadonlyMap<string, number>,
    keepStored = false) {
    const stored = keepStored && messages.length ? await tx.superTabMessage.findMany({ where: { id: { in: messages.map(m => m.id) } },
      select: { id: true, tabId: true, conversationId: true, source: true } }) : []
    const kept = new Set(stored.filter(row => messages.some(m => m.id === row.id && row.tabId === tabId && row.conversationId === m.conversationId
      && isDeepStrictEqual(row.source ?? undefined, m.source))).map(row => row.id))
    if (kept.size) logger.warn('Kept Swarm notices already stored', { tabId, ids: [...kept] })
    const rows: Prisma.SuperTabMessageCreateManyInput[] = []
    let deliveries: Prisma.SuperTabDeliveryCreateManyInput[] = []
    for (const message of messages) {
      if (!kept.has(message.id)) rows.push({ id: message.id, tabId, conversationId: message.conversationId,
        sequence: sequences.get(message.id)!, author: json(message.author), ...(message.source ? { source: json(message.source) } : {}),
        ...(message.attachments ? { attachments: json(message.attachments) } : {}),
        text: message.text, replyTo: message.replyTo, recipientIds: message.recipients, mentions: message.mentions ?? [],
        // A top-level message is its own thread's root; only a row written before threads has none (its replies stay inline).
        thread: message.thread ?? message.id, ...(message.alsoInChat ? { alsoInChat: true } : {}),
        ...(message.buddySession ? { buddySession: true } : {}), ...(message.buddyProject ? { buddyProject: message.buddyProject } : {}) })
      for (const recipient of [...message.recipients, ...message.buddyRecipients ?? []]) {
        const target = agent(state, recipient)
        const group = conversation(state, message.conversationId)
        deliveries.push({ id: stableId(message.id, recipient), tabId,
          conversationId: message.conversationId, messageId: message.id, agentId: recipient, machineId: target.machineId,
          machineOwnerId: target.machineOwnerId,
          assignmentId: activeWork(group) && group.assignment?.agentId === recipient ? group.assignment.id : null,
          membershipGeneration: target.membershipGeneration, authorKind: message.author.kind,
          authorId: message.author.id, authorGeneration: message.author.membershipGeneration })
      }
    }
    if (rows.length) await tx.superTabMessage.createMany({ data: rows })
    // A reply's thread summary, in this transaction (pageReads.ts refreshThreads).
    await refreshReplies(tx, tabId, rows)
    for (const message of messages) {
      // Once committed, so a retried write logs once.
      if (message.source?.kind === SESSION_ENDED_KIND && !kept.has(message.id)) {
        const reason = message.source.reason
        afterCommit(tx, () => logger.info('Buddy session ended', { tabId, reason }))
      }
    }
    if (kept.size) {
      const have = new Set((await tx.superTabDelivery.findMany({ where: { messageId: { in: [...kept] } }, select: { id: true } })).map(d => d.id))
      // A delivery compacted into its message's receipts (deliveryCompaction.ts) was written too: never sent again.
      const compacted = await readBy(tx, 'SuperTabReceipt', 'id', [{ $match: { _id: { $in: [...kept] }, tabId } }, { $project: { deliveryIds: 1 } }])
      for (const receipt of compacted) for (const id of receipt.deliveryIds as string[] ?? []) have.add(id)
      deliveries = deliveries.filter(d => !have.has(d.id))
    }
    if (deliveries.length) await tx.superTabDelivery.createMany({ data: deliveries })
    for (const delivery of deliveries) this.announce(tx, { machineId: delivery.machineId, tabId, agentId: delivery.agentId })
  }

  /** A Buddy thread session's first deliveries (buddySessions.ts): its person's messages sent in its thread while it started,
   *  each written once (its id is the message's and the agent's, as writeMessages makes it), only for a stored message of
   *  that conversation by that person in a session thread. */
  private async writeLateDeliveries(tx: Transaction, tabId: string, state: SuperTabState, late: NonNullable<CommandEffects['lateDeliveries']>) {
    const deliveries: Prisma.SuperTabDeliveryCreateManyInput[] = []
    // At most MAX_SESSION_WAITING, each by its primary key (hotFilters.test.ts: no `in` filter on a hot collection).
    for (const l of late) {
      const row = await tx.superTabMessage.findUnique({ where: { id: l.messageId }, select: { tabId: true, conversationId: true, author: true, buddySession: true } })
      const author = row?.author as unknown as Author | undefined
      const target = agent(state, l.agentId)
      // A session hears its thread's rows; the one Buddy's session in an older project chat (commands.ts startOldChatBuddy)
      // hears that chat's main rows, never a thread session's.
      const heard = target.buddySession ? !!row?.buddySession : !!target.buddyNarrow && !row?.buddySession
      if (!row || row.tabId !== tabId || row.conversationId !== l.conversationId || !heard || author?.kind !== 'person' || author.id !== l.author.id
        || author.membershipGeneration !== l.author.generation) continue
      if (await tx.superTabDelivery.findUnique({ where: { id: stableId(l.messageId, l.agentId) }, select: { id: true } })) continue
      deliveries.push({ id: stableId(l.messageId, l.agentId), tabId, conversationId: l.conversationId, messageId: l.messageId, agentId: l.agentId,
        machineId: target.machineId, machineOwnerId: target.machineOwnerId, assignmentId: null, membershipGeneration: target.membershipGeneration,
        authorKind: 'person', authorId: l.author.id, authorGeneration: l.author.generation })
    }
    if (deliveries.length) await tx.superTabDelivery.createMany({ data: deliveries })
    for (const delivery of deliveries) this.announce(tx, { machineId: delivery.machineId, tabId, agentId: delivery.agentId })
  }

  /** Once `tx` commits, never for an attempt that failed or was retried: told earlier, a host could read before the delivery
   *  is visible, and wait 30 s for its next read. */
  private announce(tx: Transaction, waiting: DeliveriesWaiting): void {
    const told = this.hooks.deliveriesWaiting
    if (told) afterCommit(tx, () => told(waiting))
  }

  /** One page of a conversation, read by (sequence, id): rows written by one command before the store by parts share a
   *  sequence, so a page edge inside such a run must not skip any (design section 4.6). `after` alone reads strictly after
   *  a sequence, which is enough to poll for new messages. */
  async messages(user: AuthUser, tabId: string, conversationId: string,
    cursor: { after?: number; afterId?: string; before?: number; beforeId?: string; messageId?: string; thread?: string }, asAgentId?: string) {
    const tx = this.db
    const read: MessageReadKey['cursor'] = cursor.messageId ? 'messageId' : cursor.thread ? 'thread' : cursor.after !== undefined ? 'after'
      : cursor.before === undefined ? 'latest' : cursor.beforeId === undefined ? 'before' : 'beforeId'
    const { state } = await this.readLoad(user, tabId, { groupIds: [conversationId] })
    const actor = await this.actor(tx, user, state, asAgentId)
    const group = readConversation(state, actor, conversationId)
    // A Buddy reads its project's workgroups but never how work is routed: a route row names the machines that could run it
    // and why others could not (security review 2 of #2115). Left out like an agent-only notice (readsRow), so no page is shorter.
    const buddy = isBuddyReader(state, actor), rowRead = readsRow(actor, buddy)
    // A Buddy thread session reads its own thread alone, and the main Buddy none of a session's (buddySessions.ts): the one
    // check every agent read of a Buddy chat applies, here and through every row it points at below.
    const reader = actor.kind === 'agent' ? state.agents.find(a => a.id === actor.agentId) : undefined
    const sessionRead = sessionReadsRow(reader, group, state), own = isBuddyChat(group) ? reader?.buddySession : undefined
    const readable = (m: Pick<SuperTabMessage, 'id' | 'source' | 'recipientIds' | 'thread' | 'buddySession' | 'author' | 'buddyProject'>) => rowRead(m) && sessionRead(m)
    // A session reads its chat through its own thread, so it never walks the main chat to fill a page; another thread reads empty.
    if (own) {
      if (cursor.thread && cursor.thread !== own.thread) return { messages: [], next: null, threads: [], reactionSeq: group.reactionSeq ?? 0 }
      cursor = { ...cursor, thread: own.thread }
    }
    // One thread is read only through a root this reader may read. A hidden root (an agent-only note to someone else; for a
    // Buddy, a route row) reads as one that is not in this conversation, and as an exact message it may not see: an empty
    // page, never its replies alone (review 2 of #2168). By its id, through the primary key.
    if (cursor.thread) {
      const root = await tx.superTabMessage.findFirst({ where: { tabId, conversationId, id: cursor.thread },
        select: { id: true, source: true, recipientIds: true, thread: true, buddySession: true, author: true, buddyProject: true } })
      // A task chat's copy of a Lead's notice stored before it was marked is read by no one either (pageReads.ts).
      // A project session's own thread reads on under a root it may not read (a main-Buddy row it was started from): its
      // person's replies there are its to read, the root is not (buddySessions.ts sessionReadsRow).
      const ownRoot = !!own?.projectId && root?.id === own.thread
      if (!root || (!readable(root) && !ownRoot) || (await deliveredCopies(tx, tabId, [root])).size) {
        return { messages: [], next: null, threads: [], reactionSeq: group.reactionSeq ?? 0 }
      }
    }
    const forward = cursor.after !== undefined
    // One thread: its root (its own thread) and its replies.
    const at = { tabId, conversationId, messageId: cursor.messageId, thread: cursor.thread }
    const start: MessageEdge | undefined = forward ? { sequence: cursor.after!, id: cursor.afterId }
      : cursor.before !== undefined ? { sequence: cursor.before, id: cursor.beforeId } : undefined
    // Hidden rows never shorten a page: Desktop reads on from the
    // last row it shows, so the page reads past them until it has 101 rows this reader may see, or reaches the end.
    // Each batch reads on from the last row of the one before, never by an offset that walks every row before it again, and
    // only about what is still missing (nextBatch): one hidden row once cost a whole second batch of 101.
    const rows: SuperTabMessage[] = []
    let batches = 0, decoded = 0
    for (let edge = start, size = PAGE_BATCH; rows.length < PAGE_BATCH;) {
      const batch = await messagesPast(tx, at, edge, forward, size)
      batches++
      decoded += batch.length
      // A task chat's copy of a Lead's notice stored before it was marked is that notice: read by no one (pageReads.ts).
      const copies = await deliveredCopies(tx, tabId, batch)
      rows.push(...batch.filter(m => !copies.has(m.id) && readable(m)))
      if (batch.length < size) break
      edge = { sequence: batch.at(-1)!.sequence, id: batch.at(-1)!.id }
      size = nextBatch(decoded, rows.length)
    }
    const page = rows.slice(0, 100)
    recordMessageRead({ reader: readerKind(actor, buddy), cursor: read, session: sessionKind(user) }, batches, decoded, page.length)
    const next = rows.length > 100 ? { sequence: page.at(-1)!.sequence, id: page.at(-1)!.id } : null
    if (!forward) page.reverse()
    const reactions = page.length ? reactionCounts(state, await pageReactions(tx, tabId, page.map(m => m.id))) : new Map()
    const deliveries = page.length ? await pageDeliveries(tx, tabId, page.map(m => m.id)) : []
    // What the page's rows point at that this reader may not see (an agent-only note to someone else; for a Buddy, a routing
    // row): such a reply reads as a message of its own, with no thread or reply-to naming it and no reply line for it
    // (review 1 of #2168). Rows on the page are readable already; the rest are read by id, at most two per row.
    const onPage = new Set(page.map(m => m.id))
    const pointed = [...new Set(page.flatMap(m => [m.thread, m.replyTo]).filter((id): id is string => !!id && !onPage.has(id)))]
    // A task chat's copy of a Lead's notice stored before it was marked is read by no one (pageReads.ts deliveredCopies).
    const pointedRows = await messagesById(tx, tabId, conversationId, pointed)
    const pointedCopies = pointedRows.length ? await deliveredCopies(tx, tabId, pointedRows) : new Set<string>()
    const hidden = new Set(pointedRows.filter(m => !readable(m) || pointedCopies.has(m.id)).map(m => m.id))
    // The threads the page's rows are in, so a poll that brings only a reply still moves its root's reply line.
    const roots = [...new Set(page.flatMap(m => m.thread && !hidden.has(m.thread) ? [m.thread] : []))]
    const threadRows = roots.length ? await pageThreads(tx, tabId, conversationId, roots) : []
    // The main Buddy counts none of a session thread's replies, as it reads none (buddySessions.ts).
    const counted = buddy ? threadRows.filter(r => !r.routing && (own || !(isBuddyChat(group) && r.session))) : threadRows
    const summaries = counted.length ? threadSummaries(state, group, counted) : []
    const threads = buddy ? summaries.map(t => ({ ...t, authors: t.authors.map(authorForBuddy) })) : summaries
    // A lost task's rows and a machine leaving name the machine; a Buddy reads them without it (security reviews of #2115), and
    // an agent's rows without its membership (delta review 1 of #2258).
    const shown = (buddy ? page.map(rowForBuddy) : page).map(m => (m.thread && hidden.has(m.thread)) || (m.replyTo && hidden.has(m.replyTo))
      ? { ...m, ...(m.thread && hidden.has(m.thread) ? { thread: null } : {}), ...(m.replyTo && hidden.has(m.replyTo) ? { replyTo: null } : {}) } : m)
    // Whose Buddy hears a row is its person's own: its news shows to that Buddy alone.
    const shownTo = (m: SuperTabMessage, d: PageDelivery) => !buddyNews(m, d) || (actor.kind === 'agent' && actor.agentId === d.agentId)
    // A session's own thread read carries the main-chat excerpt it started from (buddySessions.ts sessionContext).
    // A project session of a person's one Buddy chat reads no excerpt: the main chat may hold any project's material (spec: Guard).
    const context = own && !own.projectId && !forward && cursor.before === undefined && !cursor.messageId ? await this.sessionExcerpt(tx, tabId, conversationId, own.from, m => rowRead(m) && sessionReadsRow(undefined, group, state)(m)) : undefined
    return { messages: shown.map(m => ({ ...m, mentions: m.mentions ?? [], reactions: reactions.get(m.id) ?? [],
      deliveries: deliveries.filter(d => d.messageId === m.id && shownTo(m, d)).sort(receiptOrder(m)) })), next, threads, ...(context ? { context } : {}),
      // A poll for new messages learns here that a reaction changed on a message it already shows (reactions.ts).
      reactionSeq: group.reactionSeq ?? 0 }
  }

  /** The main-chat excerpt a Buddy thread session starts from: main-stream rows at or before `from` it may read (never a session
   *  thread's, never a reply only in its thread), by the conversation's sequence index, at most 50 rows read for 10 kept. */
  private async sessionExcerpt(tx: Transaction, tabId: string, conversationId: string, from: number,
    rowRead: (m: Pick<SuperTabMessage, 'id' | 'source' | 'recipientIds' | 'thread' | 'buddySession' | 'buddyProject'>) => boolean) {
    const rows = await tx.superTabMessage.findMany({ where: { tabId, conversationId, sequence: { lte: from } }, orderBy: [{ sequence: 'desc' }, { id: 'desc' }],
      take: 50, select: { id: true, sequence: true, text: true, author: true, createdAt: true, thread: true, alsoInChat: true, buddySession: true, source: true, recipientIds: true, buddyProject: true } })
    const main = rows.filter(r => !r.buddySession && (!r.thread || r.thread === r.id || r.alsoInChat) && rowRead(r))
    return sessionContext(main.map(r => ({ ...r, author: r.author as unknown as ContextRow["author"] })))
  }

  /** What the person missed in one conversation since `after` (catchUp.ts), from the rows past it they may read, as a page
   *  shows them: the same read check and row filter as messages(). People only, reading as themselves: agents read every
   *  message as it comes. At most CATCH_UP_SCAN rows are read; `more` says there were more. */
  async catchUp(user: AuthUser, tabId: string, conversationId: string, after: number): Promise<CatchUp> {
    this.personOnly(user)
    const { state } = await this.readLoad(user, tabId, { groupIds: [conversationId] })
    const actor = await this.actor(this.db, user, state)
    const group = readConversation(state, actor, conversationId)
    const buddy = isBuddyReader(state, actor)
    // In the one Buddy chat, a project its person lost counts nothing toward what they missed (security review 2 of #2435).
    const lost = sessionReadsRow(undefined, group, state)
    const [rows, decisions] = await Promise.all([
      this.db.superTabMessage.findMany({ where: { tabId, conversationId, sequence: { gt: after } }, orderBy: [{ sequence: 'asc' }, { id: 'asc' }],
        take: CATCH_UP_SCAN + 1 }),
      waitingFor(this.db, tabId, conversationId, user.sub),
    ])
    const scanned = rows.slice(0, CATCH_UP_SCAN), reads = readsRow(actor, buddy)
    // A task chat's copy of a Lead's notice stored before it was marked is read by no one, as on the page (pageReads.ts).
    const copies = await deliveredCopies(this.db, tabId, scanned)
    const shown = scanned.filter(m => !copies.has(m.id) && reads(m) && lost(m))
    recordMessageRead({ reader: readerKind(actor, buddy), cursor: 'catchUp', session: sessionKind(user) }, 1, rows.length, shown.length)
    return catchUpSummary(buddy ? shown.map(rowForBuddy) : shown, user.sub, { after, more: rows.length > CATCH_UP_SCAN, decisions })
  }

  /** The caller's own tags in this Swarm, newest first: still waiting, or answered and marked done. */
  async mentions(user: AuthUser, tabId: string, state: 'waiting' | 'earlier') {
    this.personOnly(user)
    // Not every quiet conversation: listMentions reads the quiet ones its tags are in by id (mentions.ts readable).
    const { state: tab } = await this.readLoad(user, tabId)
    await this.actor(this.db, user, tab)
    return { mentions: await listMentions(this.db, tabId, tab, { kind: 'person', userId: user.sub, email: user.email }, this.now(), state === 'waiting') }
  }

  /** The caller's decisions in this Swarm, newest first: a person's asked of them, an agent's asked by it (a Lead's also
   *  those asked in its project), still open or answered. A light load: the quiet conversations its decisions are in are
   *  read with them (decisions.ts conversationsOf), never the Swarm's whole history, read again on every change. */
  async decisions(user: AuthUser, tabId: string, state: DecisionList, asAgentId?: string) {
    return transaction(this.db, async tx => {
      const { state: tab } = await this.load(tx, user, tabId)
      const actor = await this.actor(tx, user, tab, asAgentId)
      author(tab, actor)
      return await listDecisions(tx, tabId, tab, actor, state)
    })
  }

  /**
   * Every earlier attempt of one group. `work.define` takes a stopped assignment out of the state, so this is the
   * only place a reader (the Lead choosing an agent for a retry) can still see who tried and how it ended
   * (manual run 2026-10-19). The snapshot also holds the host grant and configuration; none of it leaves here.
   */
  async attempts(user: AuthUser, tabId: string, conversationId: string, asAgentId?: string) {
    return transaction(this.db, async tx => {
      const { state } = await this.load(tx, user, tabId, { groupIds: [conversationId] })
      readConversation(state, await this.actor(tx, user, state, asAgentId), conversationId)
      const rows = await tx.superTabAttempt.findMany({ where: { tabId, conversationId }, orderBy: { createdAt: 'desc' }, take: 50 })
      return rows.map(row => {
        const assignment = (row.snapshot as unknown as { assignment: Assignment }).assignment
        return { id: row.id, agentId: assignment.agentId, status: assignment.status, result: assignment.result?.slice(0, 500) ?? null, createdAt: row.createdAt }
      })
    })
  }

  async routeDecisions(user: AuthUser, tabId: string, asAgentId?: string) {
    return transaction(this.db, async tx => {
      const { state } = await this.load(tx, user, tabId)
      const actor = await this.actor(tx, user, state, asAgentId)
      author(state, actor)
      refuseBuddyRouting(state, actor)
      return (await this.readableDecisions(tx, user, tabId, state, actor)).map(timedDecisionOf)
    })
  }

  /**
   * The newest 100 decisions in the conversations `actor` may read, dormant ones too (their decisions stay readable). The
   * newest decisions of the Swarm are read first, by index, and only the conversations they name are loaded to check the
   * reader's access: a Lead reads all, so one window of 100 answers. A reader of few finds fewer than 100 in it; the next 400
   * are read as conversation ids only, and if they hold 100 of the reader's, the answer is the newest 100 in those
   * conversations. If they hold fewer while older decisions exist, the conversations the reader may read are loaded to decide
   * (an agent's project's, a person's every one), as the list always did.
   */
  private async readableDecisions(tx: Transaction, user: AuthUser, tabId: string, state: SuperTabState, actor: Actor) {
    const groups = new Map(state.conversations.map(c => [c.id, c]))
    const reads = new Map<string, boolean>()
    // A conversation that is gone, or of a kind this release does not know, is read by no one (as in a full load).
    const adopt = (parts: Part<GroupData>[]) => { for (const part of parts) if (part.data && knownKind(part.data)) groups.set(part.key, part.data) }
    const check = async (ids: string[]) => {
      const unchecked = [...new Set(ids)].filter(id => !reads.has(id))
      const missing = unchecked.filter(id => !groups.has(id))
      if (missing.length) adopt(await loadLightGroups(tx, tabId, 'key', { key: { $in: missing } }))
      for (const id of unchecked) reads.set(id, groups.has(id) && canReadGroup(state, actor, groups.get(id)!))
    }
    // An agent stored with no project (a Swarm from before projects) takes its project from its first conversation, quiet ones
    // too (projects.ts agentProjectId): only a load of every group answers what it reads, so it goes straight to that.
    const target = actor.kind === 'agent' ? state.agents.find(a => a.id === actor.agentId) : undefined
    if (!target || target.projectId) {
      const first = await newestDecisions(tx, tabId, LIST_SIZE + 1)
      await check(first.slice(0, LIST_SIZE).map(d => d.conversationId))
      const mine = first.slice(0, LIST_SIZE).filter(d => reads.get(d.conversationId))
      if (mine.length === LIST_SIZE || first.length <= LIST_SIZE) return mine
      const wide = await newestConversations(tx, tabId, WIDE_WINDOW + 1)
      await check(wide.slice(0, WIDE_WINDOW))
      const readable = wide.slice(0, WIDE_WINDOW).filter(id => reads.get(id))
      if (readable.length >= LIST_SIZE || wide.length <= WIDE_WINDOW) return readable.length ? recentDecisions(tx, tabId, [...new Set(readable)]) : []
      // Fewer than 100 of the reader's among the newest 500: an agent reads only its project's conversations (and the Lead
      // conversations, by key); a person's can be any.
      if (target) {
        const project = target.projectId!
        adopt(await loadLightGroups(tx, tabId, 'project', { projectId: { $in: project === 'lead' ? ['lead', null] : [project] }, dormant: true }))
        const leads = projectsOf(state).map(p => p.leadConversationId).filter((id): id is string => !!id && !groups.has(id))
        if (leads.length) adopt(await loadLightGroups(tx, tabId, 'key', { key: { $in: leads } }))
      } else {
        adopt(await loadLightGroups(tx, tabId, 'dormancy', { dormant: true }))
      }
      return recentDecisions(tx, tabId, [...groups.values()].filter(c => canReadGroup(state, actor, c)).map(c => c.id))
    }
    const { state: whole } = await this.load(tx, user, tabId, { allGroups: true })
    return recentDecisions(tx, tabId, whole.conversations.filter(c => canReadGroup(whole, actor, c)).map(c => c.id))
  }

  /** What the attempts routed in the last `days` cost and how they went (costs/read.ts), over the groups the reader may read.
   *  The decisions are read first, by index, so only the groups they name are loaded. */
  async costSummary(user: AuthUser, tabId: string, days: number, asAgentId?: string) {
    return transaction(this.db, async tx => {
      const until = this.now(), since = until - days * 24 * 60 * 60_000
      const { rows, truncated } = await costRows(tx, tabId, since)
      const { state } = await this.load(tx, user, tabId, { groupIds: [...new Set(rows.map(r => r.conversationId))] })
      const actor = await this.actor(tx, user, state, asAgentId)
      author(state, actor)
      // What routed attempts cost, by engine, model and spend, is how work is routed: never a Buddy's (review of #2115).
      refuseBuddyRouting(state, actor)
      const readable = state.conversations.filter(c => canReadGroup(state, actor, c)), ids = new Set(readable.map(c => c.id))
      return { since, until, days, truncated, ...summarizeCosts(rows.filter(r => ids.has(r.conversationId)), readable) }
    })
  }

  async routeDecision(user: AuthUser, tabId: string, decisionId: string, asAgentId?: string) {
    return transaction(this.db, async tx => {
      const row = await tx.superTabRouteDecision.findFirst({ where: { id: decisionId, tabId }, select: { conversationId: true } })
      const { state } = await this.load(tx, user, tabId, { groupIds: row ? [row.conversationId] : [] })
      const actor = await this.actor(tx, user, state, asAgentId)
      author(state, actor)
      refuseBuddyRouting(state, actor)
      const decision = await tx.superTabRouteDecision.findFirst({ where: { id: decisionId, tabId } })
      if (decision) readConversation(state, actor, decision.conversationId)
      return decision ? timedDecisionOf(decision) : fail('NOT_FOUND', 'This routing decision is unavailable.', 404)
    })
  }

  /** Host polling discovers only registered sessions on its own machine, never unrelated tab transcripts. */
  /** Narrow authority: the machine owner can finish a specific queued start,
   * never submit arbitrary commands as its initiating person or lead. */
  private async poolHostActor(tx: Transaction, user: AuthUser, state: SuperTabState, machineId: string, startId: string): Promise<Actor> {
    const owned = await tx.machine.findFirst({ where: { machineId, userId: user.sub, autonomousEnv: user.autonomousEnv, ...machineAlive } })
    await this.hostFor(tx, user, machineId, owned, state)
    const start = state.starts?.find(s => s.id === startId) ?? fail('NOT_FOUND', 'This start is unavailable.', 404)
    const pool = machineContribution(state, machineId)
    if (!pool || pool.contributorId !== user.sub || pool.generation !== start.poolGeneration || start.request.machineId !== machineId || start.machineOwnerId !== user.sub) {
      fail('FORBIDDEN', 'This start does not belong to this machine contribution.', 403)
    }
    if (!owned || !machineBillingAllowsDataPlane(owned)) fail('HOST_UNAVAILABLE', 'This execution host is unavailable.', 403)
    let actor: Actor
    if (start.actorKey.startsWith('agent:')) {
      const lead = agent(state, start.actorKey.slice(6))
      await this.agentGrant(tx, state, lead)
      actor = { kind: 'agent', agentId: lead.id, machineOwnerId: lead.machineOwnerId }
    } else {
      const member = person(state, start.actorKey.slice(7))
      actor = { kind: 'person', userId: member.id, email: member.email }
    }
    author(state, actor, true)
    return actor
  }

  /** What removing a machine would do, for its owner's confirmation (machines.ts removalPreview). */
  /** A project's repository address, for a person who may open the project (routes/superTabs.ts, its GitHub access):
   *  a private project's members only. Null when it has none yet. [approvalRequired]: whether this Swarm's projects need a
   *  repository approved before the app gives them tokens, rolled out with the team account (machines.ts
   *  `teamAccountRequired`). */
  /** `name`: the project's own, for the page after approving its repository (routes/superTabs.ts). `others`: the reader's
   *  other projects in the Swarm, those they may open, to name the ones its repository is approved for. */
  async projectRepository(user: AuthUser, tabId: string, projectId: string):
    Promise<{ repositoryUrl: string | null; approvalRequired: boolean; name: string; others: Array<{ id: string; name: string }> }> {
    return transaction(this.db, async tx => {
      const { state } = await this.load(tx, user, tabId)
      const actor = await this.actor(tx, user, state)
      const projects = visibleState(state, actor, this.now()).projects ?? []
      const project = projects.find(p => p.id === projectId) ?? fail('NOT_FOUND', 'This project is unavailable.', 404)
      return { repositoryUrl: project.repository?.repositoryUrl ?? null, approvalRequired: teamAccountRequired(state), name: project.name,
        others: projects.filter(p => p.id !== projectId).map(p => ({ id: p.id, name: p.name })) }
    })
  }

  /** A project's repository for the route's read of its running CI jobs (github/ciLoad.ts), by a person or an agent of the
   *  project, as any read of the project: another project's, or one this reader cannot see, is unavailable alike. A Buddy
   *  routes nothing, so it reads none. */
  async ciRepository(user: AuthUser, tabId: string, projectId: string, asAgentId?: string): Promise<{ repositoryUrl: string | null }> {
    return transaction(this.db, async tx => {
      const { state } = await this.load(tx, user, tabId)
      const actor = await this.actor(tx, user, state, asAgentId)
      const project = readProject(state, actor, projectId)
      if (actor.kind === 'agent' && state.agents.some(a => a.id === actor.agentId && isBuddy(a))) fail('NOT_FOUND', 'This project is unavailable.', 404)
      return { repositoryUrl: project.repository?.repositoryUrl ?? null }
    })
  }

  /** A project's name as [userId] may see it now, for the page GitHub sends them back to after approving its repository
   *  (routes/superTabs.ts). Read here, not carried in the sign-in's state, which GitHub's addresses expose (privacy review of
   *  #1980). Null when they may not see it any more, or it is gone. */
  async projectNameFor(userId: string, autonomousEnv: AuthUser['autonomousEnv'], tabId: string, projectId: string): Promise<string | null> {
    const person = await this.db.user.findUnique({ where: { id: userId }, select: { email: true } })
    if (!person) return null
    try { return (await this.projectRepository({ sub: userId, email: person.email, role: 'user', autonomousEnv }, tabId, projectId)).name } catch { return null }
  }

  async machineRemoval(user: AuthUser, tabId: string, machineId: string) {
    return transaction(this.db, async tx => {
      const { state } = await this.load(tx, user, tabId)
      const actor = await this.actor(tx, user, state)
      author(state, actor)
      return removalPreview(state, actor, machineId)
    })
  }

  /** The owner's Swarms with the Local models add-on: what the owner's computer creates on grid and keeps in step. Every
   *  daemon of the owner's asks every minute, add-on on or off, so it reads only the Swarms' heads and the people of those
   *  with the add-on: a full load of each Swarm sent about 1 MB per Swarm per poll (Diego, 2026-10-28). */
  async hostGrids(user: AuthUser) {
    this.personOnly(user)
    // By the owner index (parts/indexed.ts): Prisma's $expr filter is bounded by the environment alone, every Swarm of it.
    const rows = (await readBy(this.db, 'SuperTab', 'owner', [{ $match: { autonomousEnv: user.autonomousEnv, ownerId: user.sub, format: 2 } },
      { $sort: { _id: 1 } }, { $limit: 100 }, { $project: { _id: 1 } }])).map(row => ({ id: row._id as string }))
    return transaction(this.db, async tx => {
      const heads = await tx.swarmHead.findMany({ where: { tabId: { in: rows.map(row => row.id) }, key: 'head' }, select: { tabId: true, data: true } })
      const withGrid = new Map(heads.map(head => [head.tabId, head.data as unknown as HeadData] as const).filter(([, head]) => head.localModels))
      const people = new Map<string, Person[]>([...withGrid.keys()].map(tabId => [tabId, []]))
      for (const member of await tx.swarmMember.findMany({ where: { tabId: { in: [...withGrid.keys()] }, deleted: false },
        orderBy: { ordinal: 'asc' }, select: { tabId: true, data: true } })) people.get(member.tabId)!.push(member.data as unknown as Person)
      return rows.flatMap(row => withGrid.has(row.id)
        ? [swarmGridRow(row.id, { ...withGrid.get(row.id)!, people: people.get(row.id)! } as SuperTabState)!] : [])
    })
  }

  private readonly reports: ReportMemory

  /** The caller's own account row for the machine and the host checks that need no Swarm: once per report call, which a
   *  batch of readings shares (DB 2.5). */
  async machineHost(user: AuthUser, machineId: string): Promise<MachineHost> {
    const owned = await this.db.machine.findFirst({ where: { machineId, userId: user.sub, autonomousEnv: user.autonomousEnv, ...machineAlive } })
    await this.hostFor(this.db, user, machineId, owned)
    return { owned }
  }

  /**
   * A machine's reading for one Swarm. A reading whose decisions cannot differ from its last full report's is stored on its
   * machine part alone (fastReading); any other runs in full. Whether it runs the Swarm's time checks is decided once, on a
   * clock every server shares (machineReports.ts), and only for a reading that passed the checks: a refused one would
   * hold up every server's sweep of that Swarm (review of #2378).
   */
  async observeMachine(user: AuthUser, tabId: string, machineId: string, input: MachineObservation, host?: MachineHost,
    part?: MachinePart | null): Promise<{ version: number }> {
    const observation = machineObservationSchema.parse(input)
    const checked = host ?? await this.machineHost(user, machineId)
    const fast = await this.fastReading(user, tabId, machineId, observation, checked, part)
    countReport(fast && 'version' in fast ? 'fast' : 'full')
    return fast && 'version' in fast ? fast : this.fullReading(user, tabId, machineId, observation, fast ? true : null, checked)
  }

  /**
   * A machine's readings for several Swarms in one call (DB 2.5, POST /api/super-tabs/hosts/:machineId/readings): its host
   * checks once, the machine parts of all of them in one read, then each reading as the per-Swarm route takes it, one after
   * another. Each Swarm is answered on its own: a reading the schema refuses, or a Swarm the caller cannot reach, fails that
   * Swarm alone, with the error the per-Swarm route would throw.
   */
  async observeMachines(user: AuthUser, machineId: string, readings: ReadonlyArray<{ tabId: string; observation: unknown }>):
    Promise<Array<{ tabId: string; error?: unknown }>> {
    const host = await this.machineHost(user, machineId)
    const parts = await loadMachineParts(this.db, readings.map(r => partId(r.tabId, machineId)))
    const results: Array<{ tabId: string; error?: unknown }> = []
    for (const { tabId, observation } of readings) {
      try {
        await this.observeMachine(user, tabId, machineId, observation as MachineObservation, host, parts.get(partId(tabId, machineId)) ?? null)
        results.push({ tabId })
      } catch (error) {
        results.push({ tabId, error })
      }
    }
    return results
  }

  /**
   * A heartbeat stored without loading its Swarm (DB 2.5 spec, sections 1–2), or null to run it in full. It needs the
   * Swarm unchanged since this machine's last full report (its `main` stamp then, no bump owed here), no removal, none of
   * its workers' leases due, and a reading that feeds no decision differently (machines.ts readingOnly). It stores what
   * the full report would: the same reading, Lent for the count that report recorded, the same push to the same people.
   */
  private async fastReading(user: AuthUser, tabId: string, machineId: string, observation: MachineObservation, host: MachineHost,
    loaded?: MachinePart | null): Promise<{ version: number } | { sweep: true } | null> {
    if (stampOwed(tabId)) return null
    const [stamps, record] = await Promise.all([readStamps([tabId]), this.reports.get(tabId, machineId)])
    const now = this.now()
    // A record holds for RECORD_TTL_MS after its own full report, whatever other machines of the Swarm write since.
    if (!record || stamps?.get(tabId)?.main !== record.stamp || now >= record.deadline || now - record.at >= RECORD_TTL_MS || record.removals) return null
    // The checks a full report makes with the Swarm, from what the last one saw of it; a refusal is the full report's to say.
    if ((record.team && !isTeamSession(user)) || !host.owned || !machineBillingAllowsDataPlane(host.owned)) return null
    const row = await this.db.superTab.findFirst({ where: { id: tabId, autonomousEnv: user.autonomousEnv }, select: { format: true } })
    if (row?.format !== 2) return null
    const part = loaded !== undefined ? loaded : (await loadMachineParts(this.db, [partId(tabId, machineId)])).get(partId(tabId, machineId))
    const pool = part && !part.deleted ? part.data.contribution : null
    if (!part || !pool || pool.contributorId !== user.sub || pool.generation !== observation.generation || pool.removal) return null
    const data = structuredClone(part.data), mine = data.contribution!
    const reading = storedObservation(mine, observation, { team: isTeamSession(user), now, preparable: id => record.preparable.includes(id) })
    if (!readingOnly(mine.observation, reading)) return null
    addLent(mine, now, record.lentCount)
    mine.observation = reading
    const suspended = JSON.stringify(mine.engineSuspensions)
    readingClearsSuspensions(mine, now)
    if (JSON.stringify(mine.engineSuspensions) !== suspended) return null
    // Its sweep due: the full report runs it, with the slot this reading, which passed the checks, just took.
    if (await this.reports.sweepDue(tabId, now)) return { sweep: true }
    const stamp = clock.next()
    let version: number
    try {
      version = await swarmTransaction(this.db, tx => guardedWrite(tx, tabId, { op: 'update', kind: 'machine', key: machineId, seen: part.version, data }, stamp))
    } catch (error) {
      // A conflict, or Mongo's transient refusal, is the full report's to retry.
      if (retryable(error)) return null
      throw error
    }
    try {
      this.hooks.swarmChanged?.({ tabId, userIds: record.members, lastChangedAt: stamp, parts: ['machine'] })
    } catch (error) {
      logger.warn('[super-tab] reading push failed', { tabId, error: error instanceof Error ? error.message : String(error) })
    }
    return { version }
  }

  /** [sweep]: whether the Swarm's sweep slot was taken already, or null for this report to ask once its checks pass. */
  private async fullReading(user: AuthUser, tabId: string, machineId: string, observation: MachineObservation, sweep: boolean | null,
    { owned }: MachineHost): Promise<{ version: number }> {
    // The Swarm's stamp before anything is loaded: the next reports may skip the load only while it holds (machineReports.ts).
    const before = (await readStamps([tabId]))?.get(tabId)?.main
    const { version, record } = await transaction(this.db, async (tx): Promise<{ version: number; record?: Omit<ReportRecord, 'stamp'> }> => {
      // Only the conversations its checks read (parts/load.ts loadObserved): the whole Swarm was ~1.1 MB a report (#876).
      const loaded = loadedFrom(await this.row(tx, user, tabId), await loadObserved(tx, tabId, machineId)), state = cloneData(loaded.state)
      await this.hostFor(tx, user, machineId, owned, state)
      const pool = await strangerRefusal(state, user.sub, () => {
        const found = machineContribution(state, machineId)
        if (!found || found.contributorId !== user.sub || found.generation !== observation.generation) fail('CONTRIBUTION_REVOKED', 'Read the current machine contribution.', 403)
        return found
      })
      if (!owned || !machineBillingAllowsDataPlane(owned)) fail('HOST_UNAVAILABLE', 'This execution host is unavailable.', 403)
      // Asked once per report, never again on a retried attempt, which would find the slot taken by itself.
      sweep ??= await this.reports.sweepDue(tabId, this.now())
      const now = this.now()
      // A machine that went silent while cleaning takes the fallback before this fresh reading can bring it back: its records
      // go, its cleanup waits for this host, as the next sweep would have done (machines.ts expireRemovals).
      const ended = expireRemovals(state, now)
      const stamp = clock.next()
      // A reading writes only its machine's part, and an agent's part only when its presence changes (spec); a group's only
      // when a task there is lost or a removal ends.
      const saved = async (lost: MessageDraft[] = []) => {
        const rows = [...ended, ...lost]
        const sequences = numberMessages(state, rows, now)
        const touches = judgedMachines(loaded.state, state, rows).filter(t => t.key !== machineId)
        await this.endRuns(tx, tabId, loaded.state, state)
        await recordAttempts(tx, tabId, loaded.state, state, now)
        await recordEvidence(tx, tabId, loaded.state, state, now)
        const version = (await this.save(tx, loaded, state, stamp, touches)).versions.get(`machine:${machineId}`) ?? 0
        await this.writeMessages(tx, tabId, state, rows, sequences, true)
        return { version }
      }
      if (!state.machines?.includes(pool)) return saved()
      recordAgentPresence(state, machineId, observation.runningHarnessIds, now)
      const reading = storedObservation(pool, observation, { team: isTeamSession(user), now,
        preparable: id => !!state.starts?.some(s => s.id === id && preparableStart(s, machineId)) })
      accrueLent(state, pool, now)
      pool.observation = reading
      // A reading that shows a suspended engine signed in with quota offered again (engineHealth.ts); posts nothing.
      readingClearsSuspensions(pool, now)
      // Current-generation physical stop proof also finishes a close whose membership was already withdrawn.
      for (const proof of observation.stoppedReservations ?? []) {
        if (!observation.stoppedHarnessIds.includes(proof.harnessId)) continue
        const reservation = state.harnessReservations?.find(r => r.machineId === machineId && r.harnessId === proof.harnessId && r.generation === proof.generation)
        if (!reservation) continue
        state.harnessReservations = state.harnessReservations?.filter(r => r !== reservation)
        state.releasedHarnesses ??= []
        if (!state.releasedHarnesses.some(r => r.machineId === machineId && r.harnessId === proof.harnessId)) state.releasedHarnesses.push({ machineId, harnessId: proof.harnessId })
        const id = stableId('swarm-session', state.environment, user.sub, stableId(machineId, proof.harnessId))
        await tx.superTabSessionScope.updateMany({ where: { id, closeLeaseGeneration: proof.generation },
          data: { closeLeaseId: null, closeLeaseUntil: null, closeLeaseGeneration: null } })
      }
      // Its own agents lose their tasks at once (a stopped session); every 30 seconds it runs the Swarm's time checks too, so
      // they keep running when the Lead's own machine is the one that died.
      const checked = [...loseTasks(state, now, worker => worker.machineId === machineId), ...sweep ? sweepLiveness(state, now) : []]
      const written = await saved(checked)
      // What the next reports of this machine need to skip the load, as this commit leaves the Swarm.
      const mine = state.machines?.find(m => m.machineId === machineId)
      return { ...written, ...mine ? { record: { lentCount: lentAgents(state, mine, mine.observation?.runningHarnessIds ?? []),
        removals: !!state.machines?.some(m => m.removal), deadline: Math.min(nextLossAt(state, machineId) ?? Infinity, now + DEADLINE_CAP_MS),
        team: teamByRecord(state, machineId), members: state.people.map(p => p.id),
        preparable: (state.starts ?? []).filter(s => preparableStart(s, machineId)).map(s => s.id), at: now } } : {} }
    })
    if (record && before !== undefined && !stampOwed(tabId)) await this.reports.set(tabId, machineId, { ...record, stamp: before })
    return { version }
  }

  async mayObserve(user: AuthUser, tabId: string, machineId: string, harnessId: string, machineOwnerId: string): Promise<boolean> {
    // Watching is a person's: a team session has no person to watch as.
    if (isTeamSession(user)) return false
    try {
      const tx = this.db
      const { state } = await this.readLoad(user, tabId)
      person(state, user.sub)
      await requireWorkspaceAccess(tx, state, user.sub)
      const target = state.agents.find(a => a.machineId === machineId && a.harnessId === harnessId && a.machineOwnerId === machineOwnerId)
      if (!target) return false
      agent(state, target.id)
      if (!canWatchAgent(state, { kind: 'person', userId: user.sub, email: user.email }, target, await this.confidential(tx, target.id, tabId))) return false
      await this.agentGrant(tx, state, target)
      return true
    } catch (error) { if (error instanceof SuperTabError) return false; throw error }
  }

  /** Whether an agent's session is confidential in any Swarm, or any but `exceptTabId` (confidential.ts). */
  private async confidential(tx: Transaction, agentId: string, exceptTabId?: string): Promise<boolean> {
    return (await confidentialSessions(tx, [agentId], exceptTabId)).has(agentId)
  }

  /** Whether a terminal share may open, wherever it came from (routes/harnessShares.ts): a Swarm's share only while that
   *  Swarm lets its recipient watch (its current Lead included, projects.ts watchClosed); an ordinary share made outside any
   *  Swarm never of a confidential session, but for its machine's person. */
  async mayOpenShare(user: AuthUser, share: { superTabId: string | null; machineId: string; agentId: string; ownerId: string }): Promise<boolean> {
    if (share.superTabId) return this.mayObserve(user, share.superTabId, share.machineId, share.agentId, share.ownerId)
    return user.sub === share.ownerId || !await this.confidential(this.db, stableId(share.machineId, share.agentId))
  }

  /** The shares among `shares` that mayOpenShare opens, for a person's whole list (routes/harnessShares.ts): each Swarm loaded
   *  once and the confidential sessions read once per Swarm, where share by share each loaded its whole Swarm (prod 2026-10-28:
   *  half the backend's busy time in spike minutes). The same answer as mayOpenShare for each share, in the same order. */
  async openableShares<T extends { superTabId: string | null; machineId: string; agentId: string; ownerId: string }>(user: AuthUser, shares: T[]): Promise<T[]> {
    const key = (share: T) => stableId(share.machineId, share.agentId)
    // An ordinary share: never of a session confidential in any Swarm, but for its machine's person.
    const anywhere = await confidentialSessions(this.db, shares.filter(s => !s.superTabId && user.sub !== s.ownerId).map(key), undefined, this.cachedState,
      busyListing)
    const byTab = new Map<string, T[]>()
    for (const share of shares) if (share.superTabId) byTab.set(share.superTabId, [...byTab.get(share.superTabId) ?? [], share])
    const observable = new Set<T>()
    for (const [tabId, tabShares] of byTab) for (const share of await this.observable(user, tabId, tabShares)) observable.add(share)
    return shares.filter(s => s.superTabId ? observable.has(s) : user.sub === s.ownerId || !anywhere.has(key(s)))
  }

  /** A Swarm's parts as loadActive gives them, through the read cache and uncopied: for confidentialSessions outside a transaction. */
  private readonly cachedState = async (tabId: string, agentIds: string[]) =>
    reassemble(await readParts(this.db, await this.view([tabId]), tabId, { agentIds }), { share: true })

  /** mayObserve for each of `shares`, all in Swarm `tabId`, from one load of it. */
  private async observable<T extends { machineId: string; agentId: string; ownerId: string }>(user: AuthUser, tabId: string, shares: T[]): Promise<T[]> {
    if (isTeamSession(user)) return []
    let state: SuperTabState
    try {
      state = (await this.readLoad(user, tabId)).state
      person(state, user.sub)
      await requireWorkspaceAccess(this.db, state, user.sub)
    } catch (error) { if (error instanceof SuperTabError) return []; throw error }
    // agentGrant reads only the agent's contributor, machine and grant: agents sharing those share its answer.
    const grants = new Map<string, Promise<boolean>>()
    const granted = (target: Agent) => {
      const key = JSON.stringify([target.contributorId, target.machineId, target.machineOwnerId, target.hostGrant])
      if (!grants.has(key)) grants.set(key, this.agentGrant(this.db, state, target).then(() => true,
        error => { if (error instanceof SuperTabError) return false; throw error }))
      return grants.get(key)!
    }
    const targets = shares.map(share => state.agents.find(a => a.machineId === share.machineId && a.harnessId === share.agentId && a.machineOwnerId === share.ownerId))
    // Confidential in another Swarm closes it here too; in this one, its current Lead stays open to readers (projects.ts watchClosed).
    const elsewhere = await confidentialSessions(this.db, targets.flatMap(t => t ? [t.id] : []), tabId, this.cachedState, busyListing)
    const allowed: T[] = []
    for (const [i, share] of shares.entries()) {
      const target = targets[i]
      if (!target) continue
      try { agent(state, target.id) } catch (error) { if (error instanceof SuperTabError) continue; throw error }
      if (canWatchAgent(state, { kind: 'person', userId: user.sub, email: user.email }, target, elsewhere.has(target.id))
        && await granted(target)) allowed.push(share)
    }
    return allowed
  }

  private deliveryAllowed(state: SuperTabState, delivery: SuperTabDelivery): boolean {
    const target = state.agents.find(a => a.id === delivery.agentId)
    const group = state.conversations.find(c => c.id === delivery.conversationId)
    if (!target || target.membershipGeneration !== delivery.membershipGeneration || !group || group.archived) return false
    // The removed Leads conversation hands out nothing, a delivery stored before its removal included (model.ts leadsRemoved).
    if (isLeads(group)) return false
    // A Buddy also hears its person's news outside its chat (buddyNews.ts), only where it reads as its person would (below).
    if (!group.agentIds.includes(target.id) && !isBuddy(target)) return false
    const sender = delivery.authorKind === 'person' ? state.people.find(p => p.id === delivery.authorId) : state.agents.find(a => a.id === delivery.authorId)
    if (!sender) return false
    const actor: Actor = delivery.authorKind === 'person'
      ? { kind: 'person', userId: delivery.authorId, email: '' }
      : { kind: 'agent', agentId: delivery.authorId, machineOwnerId: (sender as Agent).machineOwnerId }
    // A private conversation's sender and receiver must still be in its audience or be its Lead (projects.ts canReadGroup).
    if (!canReadGroup(state, actor, group)) return false
    if (!canReadAgent(state, { kind: 'agent', agentId: target.id, machineOwnerId: target.machineOwnerId }, target) ||
      !canReadGroup(state, { kind: 'agent', agentId: target.id, machineOwnerId: target.machineOwnerId }, group)) return false
    const generation = 'generation' in sender ? sender.generation : sender.membershipGeneration
    return generation === delivery.authorGeneration && (!('role' in sender) || sender.role !== 'viewer')
  }

  private async senderAllowed(tx: Transaction, state: SuperTabState, delivery: SuperTabDelivery): Promise<boolean> {
    if (delivery.nativeContextId && !await this.native.allowsDelivery(tx, state, delivery.nativeContextId)) return false
    if (delivery.authorKind !== 'agent') return true
    try { await this.agentGrant(tx, state, agent(state, delivery.authorId)); return true }
    catch (error) { if (error instanceof SuperTabError) return false; throw error }
  }

  /** When each caller's full delivery poll last succeeded for an agent: key is tab, agent and caller. */
  private readonly polls: PollMemory

  /**
   * Every running agent's host polls this each second. With nothing waiting and the full poll (which loads the Swarm and
   * runs the Lead's time checks) done within SWEEP_EVERY_MS, the answer is one indexed read: 15 agents were ~180 queries
   * a second and a whole-Swarm rewrite check each, on 2026-10-27 the backend at 5 pods. Only a caller whose full poll
   * succeeded is ever answered this way, so a stranger or a revoked host meets the authority checks every time.
   */
  async deliveries(user: AuthUser, tabId: string, agentId: string) {
    const key = pollKey(user, tabId, agentId)
    const last = await this.polls.get(key).catch(error => { pollMemoryFailed(error); return undefined })
    if (last !== undefined && this.now() - last.at < SWEEP_EVERY_MS) {
      const open = await openDeliveries(this.db, tabId, agentId)
      if (!open.length) return []
      // A held delivery stays open for as long as its host cannot type it, possibly hours, polled each second (Diego, 10-28):
      // the same open deliveries at the same main stamp are allowed as the full poll found them. Anything a Swarm write
      // revokes moves the stamp; what no Swarm write records (a Workspace, a machine, a share) is checked again each time.
      // A turn typed into a terminal rests on its typist's access too (native.ts allowsDelivery): it takes the full poll.
      const seen = last.open, stamp = seen && (await this.view([tabId])).mainStamp(tabId)
      if (seen?.grants[agentId] && stamp === seen.stamp && sameIds(open, seen.seen) && !open.some(d => d.nativeContextId)) {
        return this.heldDeliveries(user, agentId, open, seen)
      }
    }
    const view = await this.view([tabId]), stamp = view.mainStamp(tabId)
    const { open, allowed, state } = await this.fullDeliveries(user, tabId, agentId, view)
    await this.polls.set(key, { at: this.now(), ...open.length && stamp !== undefined
      ? { open: { stamp, seen: open.map(d => d.id), allowed: allowed.map(d => d.id), ...grantsOf(state, agentId, allowed) } } : {} })
      .catch(pollMemoryFailed)
    return allowed
  }

  /** The open deliveries the last full poll allowed, while the Swarm is as it read it: the grants it checked are checked
   *  again, as the full poll does: the agent's refuses the poll, a sender's withholds what it sent (senderAllowed). */
  private async heldDeliveries(user: AuthUser, agentId: string, open: SuperTabDelivery[], seen: NonNullable<Polled['open']>) {
    // One request's reads, shared by the agent's check and its senders' (GrantReads), never kept past it.
    const target = seen.grants[agentId]!, inSwarm = () => {}, reads = new GrantReads()
    const team = await this.teamHost(this.db, user)
    if (team !== null && target.machineId !== team) fail(TEAM_SESSION_LIMITED, TEAM_SESSION_MESSAGE, 403)
    await this.grantHolds(this.db, seen.swarm, target, inSwarm, reads)
    if (team === null) await this.notTeamMachine(user, () => reads.once(machineKey(seen.swarm.environment, target.machineId, target.machineOwnerId),
      () => this.db.machine.findFirst({ where: { machineId: target.machineId, userId: target.machineOwnerId, autonomousEnv: seen.swarm.environment, ...machineAlive } })), !!target.team)
    const senders = new Map<string, Promise<boolean>>()
    const sent = (id: string) => senders.get(id) ?? senders.set(id, this.grantHolds(this.db, seen.swarm, seen.grants[id]!, inSwarm, reads)
      .then(() => true, error => { if (error instanceof SuperTabError) return false; throw error })).get(id)!
    const allowed: SuperTabDelivery[] = []
    for (const delivery of open) {
      if (!seen.allowed.includes(delivery.id)) continue
      if (delivery.authorKind !== 'agent' || seen.grants[delivery.authorId] && await sent(delivery.authorId)) allowed.push(delivery)
    }
    return allowed
  }

  private async fullDeliveries(user: AuthUser, tabId: string, agentId: string, view: CacheView) {
    // Every write below is the Lead's: its time checks, idle stops, update request, digest and stale runs. Any other agent's
    // poll only reads, through the read cache with no transaction (Diego's review of 10-28, item 1: 20 workers were 40
    // whole-Swarm loads, clones and empty commits a minute). The authority checks are the same; a claim checks them again.
    const read = await this.readLoad(user, tabId, {}, view)
    if (!ledProject(read.state, agentId)) {
      author(read.state, await this.actor(this.db, user, read.state, agentId), true)
      return this.allowedDeliveries(this.db, read.state, tabId, agentId)
    }
    return transaction(this.db, async tx => {
      let loaded = await this.load(tx, user, tabId)
      // Work finished since the last digest and archived or asleep since still shipped, but ordinary loads leave it out
      // (#1757 review, 4): a due digest loads it. A paused Swarm sends none (digest.ts digestRequest), so its digest stays
      // due: it loads nothing for it, or every poll repeats the loads over a growing window (Diego's issue file, 2026-10-27).
      const led = ledProject(loaded.state, agentId)
      let asked: Array<{ conversationId: string; personId: string; count: number }> = []
      const due = led && !loaded.state.paused ? digestDue(led, this.now()) : null
      // A day's digest stored while its project was not marked sent (its time moved later that day, on an older server) went
      // out: it only gets marked, or every poll would read for it again and fail on the duplicate (prod slow log, 2026-10-28).
      const sentAlready = !!due && !!await tx.superTabMessage.findUnique({ where: { id: digestMessageId(tabId, led!.id, due) }, select: { id: true } })
      if (led && due && !sentAlready) {
        const finished = await groupsBy(tx, 'project', [{ $match: quietSince(tabId, led.id, digestSince(led, this.now())) },
          { $project: { _id: 0, key: 1 } }]) as unknown as Array<{ key: string }>
        // A decision waits in its conversation even once that conversation went quiet.
        asked = await waitingInProject(tx, tabId, led.id)
        const groupIds = [...new Set([...finished.map(g => g.key), ...asked.map(d => d.conversationId)])]
        if (groupIds.length) loaded = await this.ensure(tx, loaded, { groupIds })
      }
      const state = cloneData(loaded.state)
      if (sentAlready) {
        const project = projectOf(state, led!.id)
        project.digest = { ...digestOf(project)!, lastOn: due! }
      }
      author(state, await this.actor(tx, user, state, agentId), true)
      const target = agent(state, agentId)
      // A Lead's poll runs the time checks (liveness.ts): lost work wakes it in this same poll.
      const written = ledProject(state, agentId) ? sweepForLead(state, this.now()) : []
      // The coordinator's poll tells it of its project's idle agents (tidy.ts): it is where what waits for each agent is known.
      // It reads no asleep group: only loaded groups' active work keeps an agent from being idle (project instructions, phase 4).
      if (led) written.push(...idleNotices(state, led.id, this.now(), new Set((await tx.superTabDelivery.findMany({
        where: { tabId, status: { in: [...OPEN_DELIVERY] } }, select: { agentId: true }, distinct: ['agentId'] })).map(d => d.agentId))))
      const update = projectUpdateRequest(state, target, this.now())
      let woken = false
      if (update) {
        const progress = groupProject(state, conversation(state, update.conversationId)).progress!
        const received = this.now() - (progress.requestedAt ?? 0) < UNANSWERED_REQUEST_MS ? ['delivered'] : []
        const pending = progress.requestMessageId
          ? await tx.superTabDelivery.findFirst({ where: { tabId, agentId, messageId: progress.requestMessageId,
            status: { in: ['queued', 'claimed', 'uncertain', ...received] } } })
          : null
        if (!pending) {
          progress.requested = { ...progress.requested, ...update.source!.through as Record<string, number> }
          progress.requestedAt = this.now()
          progress.requestMessageId = update.id
          written.push(update)
          woken = true
        }
      }
      // The morning digest is due once a day; recording it as sent is part of this same write, so it is sent once.
      const digest = digestRequest(state, target, this.now(), asked)
      if (digest) {
        const project = projectOf(state, digest.source!.projectId as string)
        // A default digest is stored with its first send (digest.ts digestOf).
        project.digest = { ...digestOf(project)!, lastOn: digest.source!.on as string, lastAt: this.now() }
        written.push(digest)
      }
      // The poll also frees agents whose task the checks just lost, and any an older server left marked running (each poll; a
      // second finds none).
      await this.endRuns(tx, tabId, loaded.state, state)
      await recordAttempts(tx, tabId, loaded.state, state, this.now())
      await recordEvidence(tx, tabId, loaded.state, state, this.now())
      if (ledProject(state, agentId)) {
        await this.releaseRuns(tx, tabId, await this.staleRuns(tx, tabId, state))
      }
      // One write for all: the time checks' changes, the digest and the wake-ups'.
      const sequences = numberMessages(state, written, this.now())
      // A loss or a start's failure was judged from a machine's report: a newer report makes this write retry.
      await this.save(tx, loaded, state, clock.next(), [...judgedMachines(loaded.state, state, written),
        ...woken ? [{ kind: 'agent' as const, key: agentId }] : []])
      await this.writeMessages(tx, tabId, state, written, sequences, true)
      return this.allowedDeliveries(tx, state, tabId, agentId)
    })
  }

  /** The agent's open deliveries, and those of them its Swarm still lets reach it. */
  private async allowedDeliveries(tx: Transaction, state: SuperTabState, tabId: string, agentId: string) {
    const open = await openDeliveries(tx, tabId, agentId)
    const allowed: SuperTabDelivery[] = []
    for (const delivery of open) {
      if (this.deliveryAllowed(state, delivery) && await this.senderAllowed(tx, state, delivery)) allowed.push(delivery)
    }
    return { open, allowed, state }
  }

  /** A withdrawn host can retire its own journal without regaining shared
   * conversation access. Machine ownership is captured when input is created. */
  async deliveryReceipt(user: AuthUser, tabId: string, agentId: string, deliveryId: string) {
    return transaction(this.db, async tx => {
      const { state } = await this.load(tx, user, tabId)
      // A host back after weeks offline asks about a delivery compacted since (deliveryCompaction.ts): answered from its receipt.
      const row = await tx.superTabDelivery.findFirst({ where: { id: deliveryId, tabId, agentId } }) ?? await compactedDelivery(tx, tabId, agentId, deliveryId)
      if (!row) fail('NOT_FOUND', 'This delivery is unavailable.', 404)
      const previous = state.agents.find(a => a.id === agentId && a.membershipGeneration === row.membershipGeneration)
      const owner = row.machineOwnerId ?? previous?.machineOwnerId
      if (owner !== user.sub) fail('FORBIDDEN', 'Only the recorded execution host can read this receipt.', 403)
      await this.hostFor(tx, user, row.machineId)
      const machine = await tx.machine.findFirst({ where: { machineId: row.machineId, userId: owner,
        autonomousEnv: user.autonomousEnv, ...machineAlive } })
      if (!machine || !machineBillingAllowsDataPlane(machine)) fail('HOST_UNAVAILABLE', 'This execution host is unavailable.', 403)
      return { id: row.id, status: row.status }
    })
  }

  /** No timeout reclaims an instruction: the same durable claim resumes, or the host reconciles it. */
  async delivery(user: AuthUser, tabId: string, agentId: string, deliveryId: string,
    action: { type: 'claim'; claimId: string } | { type: 'ack'; claimId: string; receipt: string; uncertain: boolean }
      | { type: 'hold'; claimId: string; reason: HoldReason }) {
    const reached = { authorized: false }
    try {
      return await this.deliver(user, tabId, agentId, deliveryId, action, reached)
    } catch (error) {
      // Prod 10-30, v1.3.71: 2 hours of SWARM_BUSY claims left no trace on the delivery. Retries end that way (retry.ts), so it is
      // the only code to record; the client still gets the original error. Only once an attempt got past the authorization
      // checks: a busy answer from before them says nothing about whether this caller may touch the delivery. The write is capped
      // so a struggling database cannot delay the 503 further.
      if (action.type === 'claim' && reached.authorized && error instanceof SuperTabError && error.code === 'SWARM_BUSY') {
        let timer: NodeJS.Timeout | undefined
        const cap = new Promise<void>(resolve => { timer = setTimeout(resolve, RECORD_FAILED_CLAIM_MS); timer.unref() })
        try { await Promise.race([this.recordFailedClaim(tabId, agentId, deliveryId, error.code), cap]) } finally { clearTimeout(timer) }
      }
      throw error
    }
  }

  /** A failed claim, written on its delivery by two single-document writes outside the failed transaction: they touch no Swarm
   *  part, so they cannot meet the conflict that failed it. Only a delivery still queued; the first failure's time never moves
   *  later. Best effort: a failed write is logged and never replaces the busy answer. */
  private async recordFailedClaim(tabId: string, agentId: string, deliveryId: string, code: string): Promise<void> {
    try {
      const at = new Date(this.now()), mine = { id: deliveryId, tabId, agentId, status: 'queued' }
      // A row an older backend wrote lacks the field, which Prisma on Mongo matches as isSet false, not null. The count starts at 0
      // here: Prisma's increment of a missing count leaves it null.
      await this.db.superTabDelivery.updateMany({ where: { ...mine, OR: [{ claimFailingSince: null }, { claimFailingSince: { isSet: false } }] },
        data: { claimFailingSince: at, claimFailures: 0 } })
      await this.db.superTabDelivery.updateMany({ where: mine, data: { claimFailedAt: at, claimFailure: code, claimFailures: { increment: 1 } } })
    } catch (error) {
      logger.warn('[swarm-deliveries] could not record a failed claim', { tabId, deliveryId, error: error instanceof Error ? error.message : String(error) })
    }
  }

  private async deliver(user: AuthUser, tabId: string, agentId: string, deliveryId: string,
    action: { type: 'claim'; claimId: string } | { type: 'ack'; claimId: string; receipt: string; uncertain: boolean }
      | { type: 'hold'; claimId: string; reason: HoldReason }, reached: { authorized: boolean }) {
    return transaction(this.db, async tx => {
      const live = await tx.superTabDelivery.findFirst({ where: { id: deliveryId, tabId, agentId } })
      // A compacted delivery (deliveryCompaction.ts) is checked as its row was: finished, it is refused or resolved as before.
      const delivery = live ?? await compactedDelivery(tx, tabId, agentId, deliveryId)
      await this.row(tx, user, tabId)
      // A native message may be delivered to its Lead in a different conversation from the terminal it came from.
      const context = delivery?.nativeContextId ? await tx.superTabNativeContext.findFirst({
        where: { id: delivery.nativeContextId, tabId }, select: { agentId: true } }) : null
      const parts = await loadDeliveryParts(tx, tabId, delivery ? [delivery.conversationId] : [],
        [agentId, ...delivery?.authorKind === 'agent' ? [delivery.authorId] : [], ...context ? [context.agentId] : []], context?.agentId)
      const state = reassemble(parts, { share: true })
      parkLaterConversations(state)
      author(state, await this.actor(tx, user, state, agentId), true)
      // The delivery pass ended a hold (it keeps the hold's reason) as its host, its terminal free again, typed it, or a claim
      // whose acknowledgement could not get through for 10 minutes (QUIET_CLAIM): the host's own confirmation counts, or the
      // agent has it while its sender sees Not sent and sends it again (review of #1941, prod 10-30). Nothing else brings an
      // ended delivery back: every other cancel clears the reason.
      const typedAsEnded = delivery?.status === 'cancelled' && !!delivery.holdReason && action.type === 'ack' && delivery.claimId === action.claimId
      if (!delivery || !this.deliveryAllowed(state, delivery) || delivery.status === 'cancelled' && !typedAsEnded ||
          !await this.senderAllowed(tx, state, delivery)) fail('DELIVERY_REVOKED', 'This instruction is no longer authorized.', 403)
      if (delivery.status === 'answered') fail('DELIVERY_RESOLVED', 'This message was already answered.')
      if (delivery.status === 'confirmed' || delivery.status === 'superseded') {
        fail('DELIVERY_RESOLVED', 'A person has already resolved this delivery.')
      }
      if (delivery.claimId && delivery.claimId !== action.claimId) fail('CLAIM_CONFLICT', 'Reconcile the existing delivery before claiming it again.')
      if (action.type !== 'claim' && !delivery.claimId) fail('NOT_CLAIMED', 'Claim this instruction before acknowledging it.')
      if (action.type === 'hold') return this.hold(tx, delivery, action.reason)
      reached.authorized = true
      const status = action.type === 'claim' ? delivery.status === 'queued' ? 'claimed' : delivery.status : action.uncertain ? 'uncertain' : 'delivered'
      if (delivery.status === 'delivered' && action.type === 'ack' && (action.uncertain || delivery.receipt !== action.receipt)) {
        fail('RECEIPT_CONFLICT', 'A delivered instruction keeps its original host receipt.')
      }
      // No Swarm-wide write: revocation and group changes write this delivery row, and the claim relies on its receiver and
      // its sender, whose parts it touches (spec ruling 9, design section 3.5).
      const stamp = clock.next()
      for (const touch of deliveryTouches(delivery, state)) {
        const part = parts.members.find(p => p.key === touch.key)
        if (part) await guardedWrite(tx, tabId, { op: 'touch', ...touch, seen: part.version }, stamp)
      }
      // Only a held delivery the pass ended can get here compacted: its host typed it after all, so it is a row again.
      if (!live) await restoreDelivery(tx, delivery)
      // A claim that gets in ends the failing record. Unset, never null: a missing field is a real absence, which the first failure's
      // isSet: false branch matches and which leaves no keys in the document.
      const updated = await tx.superTabDelivery.update({ where: { id: delivery.id }, data: { status, claimId: action.claimId,
        ...(action.type === 'claim' ? { claimFailingSince: { unset: true }, claimFailedAt: { unset: true }, claimFailures: { unset: true },
          claimFailure: { unset: true } } : {}),
        ...(action.type === 'ack' ? { receipt: action.receipt, holdReason: null, holdSince: null,
          ...(!action.uncertain ? { deliveredAt: delivery.deliveredAt ?? new Date(this.now()) } : {}) } : {}) } })
      const row = await tx.superTabMessage.findUnique({ where: { id: delivery.messageId } })
      // A Buddy reads no machine names, in what it is handed too (security review 2 of #2178). News from outside its chat
      // (buddyNews.ts) is marked, so its host words it as news to note, never a message to answer there.
      const target = agent(state, agentId), group = conversation(state, delivery.conversationId)
      const message = row && isBuddy(target) ? rowForBuddy(row) : row
      return { delivery: updated, message, ...isBuddy(target) && !group.agentIds.includes(target.id) ? { buddyNews: true as const } : {} }
    })
  }

  /** The host cannot type a claimed instruction yet. Recorded on the delivery, an agent-only one's too: it is how the delivery
   *  pass tells a claim its host still holds from one nobody will type (deliverySettle.ts). Nothing is posted. */
  private async hold(tx: Transaction, delivery: SuperTabDelivery, reason: HoldReason) {
    if (delivery.status !== 'claimed') return { held: false }
    if (delivery.holdReason !== reason || !delivery.holdSince) {
      await tx.superTabDelivery.update({ where: { id: delivery.id }, data: { holdReason: reason, holdSince: delivery.holdSince ?? new Date(this.now()) } })
    }
    return { held: true }
  }

  /**
   * Posts a project's nightly routing reflection for local date `on` (lib/routingReflection.ts) in its project chat under its
   * Lead's name, and asks each new proposal of the project owner as a decision from the Lead; nothing changes routing by
   * itself. Counts only the attempts and failed starts of the project's own task groups, never a private or Buddy chat, the
   * Leads conversation or another project. Reads first, outside any transaction (the week's attempts, failed starts, their
   * groups and evidence); then one short transaction re-checks, reads the project's reflection decisions and writes. The
   * report's id is the project's and date's, so a second pass or worker writes nothing ('already'). 'empty': no attempt and
   * no failed start in the last day. 'skipped': no such Swarm or project, a paused Swarm, or a project with no Lead.
   * Decisions (reviews of #2276): at most MAX_PROPOSALS open, each expiring after 7 days unanswered (every due night, a
   * report or not); one answered in the last REASK_DAYS days is not asked again. A Yes has the coordinator write the
   * proposal's line into the instructions (project instructions, phase 4, decision 21): the report reads the project's
   * document, the template at revision 0, and says how the last 7 days ran for a line it holds, and lists a line approved in
   * those days that it does not hold yet (final review). No approved list, no reminder.
   */
  async postReflection(tabId: string, projectId: string, on: string): Promise<'posted' | 'already' | 'empty' | 'skipped'> {
    const id = reflectionMessageId(tabId, projectId, on)
    if (await this.db.superTabMessage.findUnique({ where: { id }, select: { id: true } })) return 'already'
    const read = await this.db.superTab.findUnique({ where: { id: tabId }, select: SWARM_ROW })
    if (!read) return 'skipped'
    const now = this.now(), since = now - 7 * DAY_MS
    const { rows, truncated } = await costRows(this.db, tabId, since)
    const failed = await failedStarts(this.db, tabId, since)
    const seen = (await loadRow(this.db, requireParts(read), { groupIds: [...new Set([...rows, ...failed].map(r => r.conversationId))] })).state
    const at = reflectionPlace(seen, projectId)
    if (!at) return 'skipped'
    const ids = new Set(seen.conversations.filter(g => !g.audience && !isLeads(g) && g.id !== at.chat.id && groupProject(seen, g).id === projectId).map(g => g.id))
    // The project's document as it reads now: the template at revision 0 (a project the migration has not reached yet).
    const revision = at.project.instructionsRevision ?? 0
    const stored = revision ? await this.db.superTabInstructions.findUnique({ where: { id: instructionsId(tabId, projectId) }, select: { text: true } }) : null
    const input: ReflectionInput = { now, rows: rows.filter(r => ids.has(r.conversationId)), groups: seen.conversations.filter(g => ids.has(g.id)),
      failedStarts: failed.filter(f => ids.has(f.conversationId)), evidence: (await readEvidence(this.db, tabId, since, [projectId])).models, truncated,
      document: stored?.text ?? INSTRUCTIONS_TEMPLATE }
    // A quiet night still expires the proposals left unanswered (delta review of #2276).
    if (!routingReflection(input)) { await expireReflections(this.db, tabId, projectId, now); return 'empty' }
    return transaction(this.db, async tx => {
      if (await tx.superTabMessage.findUnique({ where: { id }, select: { id: true } })) return 'already'
      const row = await tx.superTab.findUnique({ where: { id: tabId }, select: SWARM_ROW })
      if (!row) return 'skipped'
      const loaded = await loadRow(tx, requireParts(row), { groupIds: [at.chat.id] })
      const state = cloneData(loaded.state)
      const place = reflectionPlace(state, projectId)
      if (!place) return 'skipped'
      const { project, chat, lead } = place
      // Expired first, so neither the open proposals nor the owner's open decisions count them.
      await expireReflections(tx, tabId, projectId, now)
      const asked = await reflectionDecisions(tx, tabId, projectId)
      const open = asked.filter(d => !d.answeredAt)
      const zone = project.digest?.timeZone
      const recent = asked.filter(d => d.answeredAt && d.answeredAt.getTime() >= now - REASK_DAYS * DAY_MS)
      const decided = recent.map(d => proposalTitle(d.question))
      // A Yes writes nothing here: the report lists its line until the coordinator has written it into the instructions.
      const approved = recent.flatMap(d => {
        const line = d.choice === APPROVE ? approvedLine(d.unblocks) : null
        return line ? [{ line, on: localDate(d.answeredAt!.getTime(), zone), ...d.delegated ? { leftTo: coordinatorNameOf(project) } : {} }] : []
      })
      const report = routingReflection({ ...input, decided, approved })!
      const owner = state.people.find(p => p.id === project.ownerId)
      const reads = !!owner && canReadGroup(state, { kind: 'person', userId: owner.id, email: owner.email }, chat)
      const waitingSince = new Map(open.map(d => [proposalTitle(d.question), localDate(d.createdAt.getTime(), zone)]))
      const held = reads ? await tx.superTabDecision.count({ where: { tabId, personId: project.ownerId, askerAgentId: lead.id,
        OR: [{ answeredAt: null }, { answeredAt: { isSet: false } }] } }) : 0
      const room = Math.max(0, Math.min(MAX_PROPOSALS - open.length, MAX_OPEN_DECISIONS - held))
      const fresh = reads ? report.proposals.filter(p => !waitingSince.has(p.title)).slice(0, room) : []
      // Says of each proposal only what happened to it: asked, waiting, or why not (review of #2276).
      const note = (p: Proposal) => waitingSince.has(p.title) ? `Waiting for the owner's answer since ${waitingSince.get(p.title)}.`
        : fresh.includes(p) ? 'Asked of the project owner.' : !reads ? 'Not asked: the project owner does not read this chat.'
        : held + fresh.length >= MAX_OPEN_DECISIONS ? 'Not asked: the owner has too many open decisions.'
        : `Not asked: at most ${MAX_PROPOSALS} proposals wait for the owner's answer at once.`
      const author: Author = { kind: 'agent', id: lead.id, name: lead.name, displayName: agentDisplayName(state.agents, lead.id), membershipGeneration: lead.membershipGeneration }
      const rows: MessageDraft[] = [{ id, conversationId: chat.id, replyTo: null, recipients: [], author, text: report.render(note),
        source: { kind: 'routing-reflection', projectId, on } }]
      const sequences = numberMessages(state, rows, now)
      await this.save(tx, loaded, state, clock.next())
      await this.writeMessages(tx, tabId, state, rows, sequences)
      if (fresh.length) await writeDecisions(tx, tabId, askDecisions(state, chat, project.ownerId, fresh.map(proposalQuestion),
        { operationId: id, askerAgentId: lead.id, assignmentId: null, kind: REFLECTION_DECISION }), now)
      return 'posted'
    })
  }

  /** Archives a finished group whose pull requests `checked` were all read merged or closed (archive.ts), only if it still
   *  qualifies inside this write: no message since, no decision waiting and no pull request linked since the read. Its
   *  waiting deliveries end, as a person's archive ends them. With `reviewOf`, the group the pass read as the one it
   *  reviews, a review nobody is reviewing closes the same way once those of the work it reviews are too (tidy.ts
   *  reviewClosable). True when it archived. */
  async archiveFinished(tabId: string, groupId: string, checked: Readonly<Record<string, 'merged' | 'closed'>>, reviewOf?: string): Promise<boolean> {
    return transaction(this.db, async tx => {
      const row = await tx.superTab.findUnique({ where: { id: tabId }, select: SWARM_ROW })
      if (!row) return false
      const loaded = await loadRow(tx, requireParts(row), { groupIds: reviewOf ? [groupId, reviewOf] : [groupId] }), state = cloneData(loaded.state)
      const group = state.conversations.find(c => c.id === groupId)
      const now = this.now()
      if (!group) return false
      const read = (urls: readonly string[]) => urls.every(url => checked[url] === 'merged' || checked[url] === 'closed')
      const finished = archivable(state, group, now) && read(group.pullRequestUrls ?? [])
      // Only the group it reviews as the pass read it: one this write did not load would hide its open pull requests.
      const review = !finished && !!reviewOf && group.reviewOf === reviewOf && reviewClosable(state, group, now) && read(reviewPullRequests(state, group))
      if (!finished && !review) return false
      if (await waitingIn(tx, tabId, groupId)) return false
      group.archived = true
      const line = finished ? archiveLine(state, group, now) : reviewCloseLine(state, group, checked, now), rows = line ? [line] : []
      const sequences = numberMessages(state, rows, now)
      if (!dirtyGroups(state, groupProject(state, group)).includes(group)) group.dormant = true
      // As a person's archive does (execute): a claim of a delivery here conflicts with this write.
      await tx.superTabDelivery.updateMany({ where: { tabId, conversationId: groupId, status: { in: [...OPEN_DELIVERY] } },
        data: { status: 'cancelled', holdReason: null, holdSince: null } })
      // A review's close also writes the work it reviews (review of #2322): a Ready for review committed since the load linked
      // a new pull request and saw this review still open, so it opened none. The touch makes one of the two writes retry,
      // and the retry sees the other: this one declines (a pull request not read), or that one opens a new review.
      await this.save(tx, loaded, state, clock.next(), review ? [{ kind: 'group', key: group.reviewOf! }] : [])
      await this.writeMessages(tx, tabId, state, rows, sequences)
      return true
    })
  }

  /** Ends, as cancelled, those of this Swarm's open deliveries `rows` (as the delivery pass read them) that can no longer move
   *  (deliverySettle.ts). Each only as it was read: one its host acknowledged since, or a claim with no hold its host claimed
   *  again since, is kept. A held claim its host claims again still ends once its hold is over; it keeps its hold's reason,
   *  so its sender learns why, and its host's confirmation that it typed it still counts (delivery). So does a quiet claim's,
   *  which the pass marks claim_quiet: prod 10-30, two hours of SWARM_BUSY kept typed messages' acknowledgements out past
   *  CLAIM_QUIET_MS, and their senders saw Not sent and sent them again. One its recipient could no longer read is not
   *  marked: a group archived and reopened later must not take it back. The number ended. */
  async settleDeliveries(tabId: string, rows: SuperTabDelivery[], now: number): Promise<number> {
    return transaction(this.db, async tx => {
      const row = await tx.superTab.findUnique({ where: { id: tabId }, select: SWARM_ROW })
      // A Swarm deleted since: nobody can read its deliveries.
      const state = row ? (await loadRow(tx, requireParts(row), { groupIds: [...new Set(rows.map(r => r.conversationId))] })).state : null
      let settled = 0
      for (const delivery of rows) {
        const reachable = !!state && this.deliveryAllowed(state, delivery)
        if (!stuck(delivery, reachable, now)) continue
        // A held claim is the same while its claim and hold are: its live host claims it again on every poll (cli
        // superTabs/host.ts), so its write time would let it outrun the pass for good. Any other is as last written.
        const unchanged = delivery.holdSince ? { claimId: delivery.claimId, holdReason: delivery.holdReason, holdSince: delivery.holdSince }
          : { updatedAt: delivery.updatedAt }
        const quiet = reachable && delivery.status === 'claimed' && !delivery.holdSince
        settled += (await tx.superTabDelivery.updateMany({ where: { id: delivery.id, tabId, status: delivery.status, ...unchanged },
          data: { status: 'cancelled', ...quiet ? { holdReason: QUIET_CLAIM } : {} } })).count
      }
      return settled
    })
  }

  /** Only the recorded execution host may attest that the actual session/attempt has stopped. */
  async stopped(user: AuthUser, tabId: string, assignmentId: string, receipt: string) {
    let ended: WorkHold[] = []
    const done = await transaction(this.db, async tx => {
      ended = []
      const loaded = await this.load(tx, user, tabId), state = cloneData(loaded.state)
      const before = { agents: state.agents, conversations: cloneData(state.conversations) }
      const group = state.conversations.find(c => c.assignment?.id === assignmentId)
      const assignment = await strangerRefusal(state, user.sub, () => {
        const found = group?.assignment
        if (!found || found.execution.machineOwnerId !== user.sub) fail('FORBIDDEN', 'Only the execution host can confirm this stop.', 403)
        return found
      })
      const execution = assignment.execution
      await this.hostFor(tx, user, execution.machineId)
      const machine = await tx.machine.findFirst({ where: { machineId: execution.machineId, userId: user.sub, autonomousEnv: user.autonomousEnv, ...machineAlive } })
      if (!machine) fail('HOST_UNAVAILABLE', 'This execution host is unavailable.', 403)
      const id = stableId('stop', tabId, assignmentId)
      const prior = await tx.superTabStopReceipt.findUnique({ where: { id } })
      if (prior && prior.receipt !== receipt) fail('RECEIPT_CONFLICT', 'This stop already has a host receipt.')
      const notices: MessageDraft[] = []
      if (group && activeWork(group)) {
        assignment.status = 'stopped'
        finishWorker(state, assignment.agentId)
        assignment.result = 'The execution host confirmed that this harness stopped.'
        await tx.superTabRun.deleteMany({ where: { tabId, assignmentId } })
        await tx.superTabDelivery.updateMany({ where: { tabId, assignmentId,
          status: { in: ['queued', 'claimed', 'uncertain'] } }, data: { status: 'cancelled', holdReason: null, holdSince: null } })
        await closeAssignment(tx, tabId, assignmentId, 'stopped', this.now())
        // No agent command closes this attempt, so nobody was told: in the two-account E2E of 2026-10-19
        // the Lead learned of a stopped worker only by re-reading status. Say it in the group, as the
        // worker's own Stopped update would, and deliver it to the Lead. A removed worker was removed
        // on purpose by someone who already knows.
        const worker = state.agents.find(a => a.id === assignment.agentId)
        if (worker) {
          worker.downSince ??= new Date(this.now()).toISOString()
          const lead = group.leadId && group.leadId !== worker.id && group.agentIds.includes(group.leadId) ? group.leadId : null
          notices.push({ id: stableId('stop-notice', tabId, assignmentId), conversationId: group.id,
            author: author(state, { kind: 'agent', agentId: worker.id, machineOwnerId: worker.machineOwnerId }),
            text: `Stopped\n\n${assignment.result}`, replyTo: null, recipients: lead ? [lead] : [] })
        }
      }
      const sequences = numberMessages(state, notices, this.now())
      // A confirmed stop finishes its worker, as work.status stopped does; no command reads that decision now, so it touches
      // nothing more (project instructions, phase 4).
      await this.save(tx, loaded, state, clock.next())
      await recordAttempts(tx, tabId, { ...state, conversations: before.conversations }, state, this.now())
      await recordEvidence(tx, tabId, { ...state, conversations: before.conversations }, state, this.now())
      await this.writeMessages(tx, tabId, state, notices, sequences)
      if (!prior) await tx.superTabStopReceipt.create({ data: { id, tabId, assignmentId, ...execution, receipt } })
      ended = endedHolds(before, state)
      return { confirmed: true }
    })
    this.endWork(tabId, ended)
    return done
  }
}

/** The names chosen in [state]'s Buddy chats, quiet ones included (buddies.ts chosenBuddyName). A chat's id is fixed per
 *  project and person (buddyChatId), so they are read by key, naming the unique index (parts/indexed.ts groupsBy), the name
 *  alone: a few short strings per person and project, and only for a rename or an add. `$gt: ''` keeps the non-empty strings
 *  (a `$type` match reads as a tagged value to Prisma's raw replies). */
export async function buddyNames(tx: Transaction, tabId: string, state: SuperTabState): Promise<ChosenBuddyName[]> {
  const keys = [...projectsOf(state).flatMap(project => state.people.map(person => buddyChatId(project.id, person))),
    ...state.people.map(person => swarmBuddyChatId(person))]
  if (!keys.length) return []
  const rows = await groupsBy(tx, 'key', [
    { $match: { tabId, key: { $in: keys }, deleted: false, 'data.buddyName': { $gt: '' } } },
    { $project: { _id: 0, key: 1, name: '$data.buddyName' } },
  ]) as Array<{ key: string; name: string }>
  return rows.map(row => ({ conversationId: row.key, name: row.name }))
}
