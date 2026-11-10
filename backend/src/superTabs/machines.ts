import { createHash } from 'node:crypto'
import { z } from 'zod'
import { engineUnusable, machineSuspensionReason } from './engineHealth.js'
import { MAX_HARNESSES, tokensByModelSchema } from './costs/tokens.js'
import { activeWork, occupiesAgent, fail, person, stableId, type Actor, type Agent, type AgentStart, type AgentStartRequest, type MessageDraft, type SuperTabState } from './model.js'
import { startFinished } from './parts/write.js'
import { agentProjectId, isAgentChat, canReadAgent, canReadProject, groupProject, ledProject, ownsProject, projectOf, projectsOf, startProject, teamAccountPool, type SwarmProject } from './projects.js'
import { isSwarmBuddyChat } from './buddies.js'
export { teamAccountPool } from './projects.js'
import { conversation } from './model.js'

/** An explicit grant for this tab and project. It never creates a MachineShare. */
export interface ContributedMachine {
  machineId: string
  name: string
  contributorId: string
  membershipGeneration: string
  generation: string
  cwd: string
  scope?: 'swarm'
  engines: string[]
  /** The count its owner last saved, which older clients send and read back: never a limit since capacity settings went
   *  (2026-11-10). Goes with `machine.contribute`'s field on or after 2026-12-10. */
  maxAgents: number
  /** Its Agents setting as an owner last saved it (Dee, 11-04), `memory` or `atMost`: read by nothing since capacity settings
   *  went (2026-11-10). Goes on or after 2026-12-10, with `maxAgents`. */
  agents?: 'memory' | 'atMost'
  paused: boolean
  /** `sessionKind` is how the reporting machine is signed in, stamped from its session by the store, never taken from
   *  the report: `team` for a Mac's team account (lib/teamSession.ts), `computer` for any other. Absent on older readings. */
  observation?: Omit<MachineObservation, 'privacy'> & { receivedAt: number; sessionKind?: 'team' | 'computer' }
  /** A Mac's Harness Team account: the machine of the Mac it lives on, stamped by the store from its account row
   *  (`Machine.hostMachineId`), never taken from the command. Such a pool is that Mac under the scenes ("One machine",
   *  docs/plans/2026-10-24-swarm-team-account.md): it shows the Mac's name, joins where the Mac was added, follows the
   *  Mac's pause, slots and removal, and runs teammates' projects started on the Mac (teamStartRequest). */
  hostMachineId?: string
  /** Set by machine.remove: an online machine stays listed, paused, while its host deletes the Swarm's folders there, until
   *  the host says it cleaned up (machine.cleaned) or REMOVAL_FALLBACK_MS passes. An offline one leaves the list at once and
   *  its cleanup waits for its host (expireRemovals). No chat hears how it ended (#2742). */
  removal?: { id: string; state: 'cleaning'; requestedAt: string }
  /** Added by Desktop as its person joined the Swarm. Swarm v3 has no Team accounts, so it no longer keeps teammates' projects
   *  off it: its person's own agents take any project they read (teamWorkCheck; #4248, finding 8 of #4212). Kept, and kept
   *  when the contribution is saved again, only because Desktop's launch.dart still reads it; gone with the machine. */
  teamAccountOnly?: true
  /** One of its person's own machines that is not in the Swarm, recorded only so its host starts and watches their Buddies
   *  there (Dee, 10-29: "I don't want to add my machine to the swarm"). It takes no other start, is no route or Product
   *  Manager candidate, serves no local models, and no reader sees it (model.ts visibleState). It goes with its last Buddy
   *  (commands.ts dropIdleBuddyMachines), or becomes an ordinary machine when its person adds it with Add machine. */
  buddyOnly?: true
  /** Who had this computer's entry before the account signed in on it now (commands.ts machine.moved, #3122), and until when:
   *  Machines says "Was kelvin until 5 Nov". Only the last one; gone with the entry. */
  previousOwner?: { personId: string; until: string }
  /** Agent-time Swarm agents here spent on other people's tasks, by leaderboard week, kept by its readings (leaderboard/lent.ts). */
  lent?: import('./leaderboard/lent.js').LentWeek[]
  /** The same by day, for the board's rolling periods. Only the leaderboard read gets it (model.ts visibleState). */
  lentDays?: import('./leaderboard/lent.js').LentDay[]
  /** Per engine, its failed starts here in a row, until one runs or they suspend it (engineHealth.ts). */
  engineFailures?: Record<string, number>
  /** Bounded repeat level (0–6) and cause of the current failure streak. Kept across expiry, removed by success/resume
   *  or with the machine. A launch failure anywhere in the streak prevents sign-in-only recovery. */
  engineBackoff?: Record<string, { level: number; cause: 'engine' | 'sign-in' }>
  /** `fine` keeps the old reader's contract. Records before 11-05 lack duration/cause and retain their six-hour policy. */
  engineSuspensions?: Record<string, { at: number; fine: boolean; durationMs?: number; cause?: 'engine' | 'sign-in' }>
  /** Pickup timeouts across all engines. One bounded counter/level/cooldown per machine, removed by any successful start
   *  or with its contribution. Expiry removes the cooldown only, preserving backoff (0–6) until recovery is proven. */
  machineFailures?: number
  machineBackoff?: number
  machineSuspension?: { at: number; durationMs: number }
}
/** A removed machine whose host never acknowledged in time: its records are gone, its host still cleans up on its next poll.
 *  [requestedAt]: when its removal was asked for; none on one recorded before 2026-10-28. */
export interface MachineCleanup { machineId: string; removalId: string; machineOwnerId: string; requestedAt?: string
  /** Left by a Buddy-only machine (ContributedMachine.buddyOnly): like the record, no reader but its person learns of it, nor of
   *  the part's removal once its host confirms (read/changes.ts; security review 1 of #2234). */
  buddyOnly?: true }
/** Was a day, until a host that kept reporting but never confirmed held Diego's Mac 'Cleaning up' for it (2026-10-28). */
export const REMOVAL_FALLBACK_MS = 30 * 60_000
/** A cleanup that has waited REMOVAL_FALLBACK_MS since its removal, or one too old to say when: it no longer holds its
 *  owner's add (commands.ts machine.contribute). Diego's Mac, 2026-10-28: its cleanup never finished, and adding it back
 *  said 'still cleaning up' for good. */
export const cleanupOverdue = (cleanup: MachineCleanup, now: number): boolean =>
  !cleanup.requestedAt || now - Date.parse(cleanup.requestedAt) >= REMOVAL_FALLBACK_MS
/** Older contributions may name engines that Swarm no longer starts. Their fresh
 * observation lists the supported engines that are actually installed. */
/** The default account's id for an engine on a machine: the CLI and Desktop compute the same 16 hex (sha256 of `machine:engine:default`). */
export const defaultProfileId = (machineId: string, engine: string): string =>
  createHash('sha256').update(`${machineId}:${engine}:default`).digest('hex').slice(0, 16)

/** A profile id as the agent stores it: the default account (literal or hashed) is absent. */
export const storedProfileId = (machineId: string, engine: string, profileId: string | undefined): string | undefined =>
  profileId === undefined || profileId === 'default' || profileId === defaultProfileId(machineId, engine) ? undefined : profileId

export function contributedEngines(pool: ContributedMachine, observation: MachineObservation | undefined = pool.observation): string[] {
  const supported = (engine: string) => engine === 'claude' || engine === 'codex'
  return pool.engines.some(engine => !supported(engine))
    ? (observation?.quotas ?? []).map(quota => quota.engine).filter(supported)
    : pool.engines.filter(supported)
}
const measure = z.number().finite().nonnegative().nullable()
const percent = z.number().min(0).max(100).nullable()
const resource = z.object({
  // The machine's logical cores, which the PM's Harness plans each machine's work against (cli/src/superTabs/assign/crew.ts).
  // Optional: a daemon before it reports none, and is planned as an 8-core machine.
  cpuPercent: percent, cpuCores: z.number().int().min(1).max(4096).nullable().optional(), memoryTotalBytes: measure, memoryUsedBytes: measure,
  diskFreeBytes: measure, diskTotalBytes: measure,
  projectDiskFreeBytes: measure, projectDiskTotalBytes: measure.optional(),
  deviceType: z.string().max(120).nullable(), chip: z.string().max(120).nullable(), os: z.string().max(120).nullable(),
  gpuPercent: percent,
}).strict()
const quota = z.object({ engine: z.string().regex(/^[a-z][a-z0-9_-]{0,79}$/), known: z.boolean(),
  windows: z.array(z.object({ name: z.string().max(80), usedPercent: z.number().min(0).max(100),
    resetsAt: z.union([z.string().max(80), z.number().finite(), z.null()]) }).strict()).max(10),
}).strict()
/** Milliseconds since the epoch, on the reporting Mac's clock. */
const checkedAt = z.number().finite().nonnegative()
/**
 * What a Harness Team daemon says about its privacy check with each reading (cli/src/team/privacy.ts, docs/plans/
 * 2026-10-24-swarm-team-account.md Task 2): `account`, it runs in a Mac's Harness Team account and the check passed, or
 * failed with the first failing item (`unchecked` when it could not run); `dedicated`, the whole machine is for agents
 * (`harness team on`). The owner's own daemon sends none. `item` is a short slug, so a newer CLI's item still reads. Swarm v4 keeps
 * none of it: a reading is accepted with it and stored without (storedObservation).
 */
export const machinePrivacySchema = z.union([
  z.object({ mode: z.literal('account'), passed: z.literal(true), checkedAt }).strict(),
  z.object({ mode: z.literal('account'), passed: z.literal(false), item: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/), detail: z.string().max(1000), checkedAt }).strict(),
  z.object({ mode: z.literal('dedicated') }).strict(),
])
export type MachinePrivacy = z.infer<typeof machinePrivacySchema>
/** What the machine is ready for (cli/src/superTabs/machines.ts readiness), for the route to leave out one that cannot do
 *  the work: per engine whether it is installed and signed in, and per folder in its Swarm workspace (one per project)
 *  the repository it checks out (an address without credentials), whether it is a git checkout, and whether this
 *  machine's own login can push to it. Absent from hosts before it; null and absent entries are unknown. */
const readiness = z.object({
  engines: z.array(z.object({ engine: z.string().regex(/^[a-z][a-z0-9_-]{0,79}$/), installed: z.boolean().nullable(), signedIn: z.boolean().nullable() }).strict()).max(8).optional(),
  checkouts: z.array(z.object({ folder: z.string().min(1).max(160).regex(/^[^/\\]+$/).refine(f => f !== '.' && f !== '..'),
    repository: z.string().max(300).nullable(), git: z.boolean(), push: z.boolean().nullable() }).strict()).max(64).optional(),
}).strict()
export const machineObservationSchema = z.object({ generation: z.string().max(160), resources: resource,
  tools: z.record(z.string().max(80), z.boolean()).refine(v => Object.keys(v).length <= 20),
  toolProbeErrors: z.record(z.string().max(80), z.string().max(200)).refine(v => Object.keys(v).length <= 20).optional(),
  quotas: z.array(quota).max(32),
  /** Per engine whose allowance is unknown, why, in plain words naming no account, token or plan (cli superTabs/capacity.ts
   *  quotaUnknownReason): what the route says of it. Absent from hosts before it. */
  quotaReasons: z.record(z.string().regex(/^[a-z][a-z0-9_-]{0,79}$/), z.string().min(1).max(300)).refine(v => Object.keys(v).length <= 8).optional(),
  runningHarnessIds: z.array(z.string().max(160)).max(1000),
  stoppedHarnessIds: z.array(z.string().max(160)).max(1000),
  /** Running Buddy sessions positively idle in this reading; absent is unknown, never idle (#3824). */
  idleBuddyHarnessIds: z.array(z.string().max(160)).max(1000).optional(),
  /** Of the stopped ones, those this machine's idle cleanup closed (cli superTabs/cleanupCloses.ts): only such a session is
   *  refused new work (closedAgents.ts sessionClosed), never one stopped by Change agent or a restart (review of #2953).
   *  Absent from hosts before it. */
  closedHarnessIds: z.array(z.string().max(160)).max(1000).optional(),
  stoppedReservations: z.array(z.object({ harnessId: z.string().min(1).max(160), generation: z.string().min(1).max(160) }).strict()).max(1000).optional(),
  /** When each running agent's screen or transcript last changed (epoch ms); its lease renews on recent progress
   *  (liveness.ts). Absent from hosts before it, whose agents renew by running alone. */
  harnessProgress: z.record(z.string().max(160), z.number().int().nonnegative()).refine(v => Object.keys(v).length <= 1000).optional(),
  /** Each running Swarm agent's token counts by model, as its session totals (costs/tokens.ts). An attempt's tokens are the
   *  difference between its start and its end (routeDecisions.ts). Absent from hosts before it, whose attempts record none. */
  harnessTokens: z.record(z.string().max(160), tokensByModelSchema).refine(v => Object.keys(v).length <= MAX_HARNESSES).optional(),
  /** Whether each running Swarm session's folder has uncommitted changes (git status), for those its host could read.
   *  Only a session reported clean is ever stopped for being idle (tidy.ts). Absent from hosts before it. */
  harnessUncommitted: z.record(z.string().max(160), z.boolean()).refine(v => Object.keys(v).length <= 1000).optional(),
  /** The Local models add-on (docs/plans/2026-10-23-swarm-local-models.md); absent from hosts before it. On the Swarm's
   *  grid: what this machine serves there (`local` an engine of its own, `api` a saved API it shares), usable by agents on
   *  any machine. On any other grid: a model its owner may use there (`shared`, shared with them), usable only by agents
   *  on this machine, since only its sign-in reaches that grid. */
  localModels: z.array(z.object({ grid: z.string().min(1).max(160), model: z.string().min(1).max(200),
    name: z.string().max(200).optional(), contextWindow: z.number().int().positive().nullable().optional(),
    kind: z.enum(['local', 'api', 'shared']).optional(),
    /** Started or shared on this machine, not yet listed by the grid: shown as starting, never offered to a Builder. */
    starting: z.boolean().optional() }).strict()).max(64).optional(),
  /** Models this machine serves on the Swarm's grid that Builders are not offered, too small or too slow to drive a coding
   *  agent (cli/src/lib/codingModel.ts), with why: so the route can tell a Lead asked for one why it is not offered. */
  refusedModels: z.array(z.object({ grid: z.string().min(1).max(160), model: z.string().min(1).max(200),
    name: z.string().max(200).optional(), why: z.string().min(1).max(300) }).strict()).max(16).optional(),
  /** A Harness Team daemon's privacy check; absent from the owner's own daemon and from hosts before it. Swarm v4 accepts it and
   *  keeps none (storedObservation). */
  privacy: machinePrivacySchema.optional(),
  readiness: readiness.optional(),
  /** The starts this machine launched and is still preparing (fetching the project, checking its worktree out, starting
   *  the engine), as of this report. Such a start waits past the 3 minutes while reports keep naming it (liveness.ts);
   *  the store keeps only this machine's own launched starts. Absent from hosts before it, whose starts get 3 minutes. */
  preparingStartIds: z.array(z.string().min(1).max(160)).max(100).optional(),
  /** The starts on this machine whose host reports the server refused, each with the refusal (cli superTabs/machines.ts): each
   *  fails at once (liveness.ts failRefusedStarts), where it waited out the 3 minutes with its reason in the machine's log alone
   *  (task #2441). The store keeps only this machine's own starts that neither run nor failed; no reader reads them. Absent from
   *  hosts before it. */
  refusedStarts: z.array(z.object({ startId: z.string().min(1).max(160), reason: z.string().min(1).max(300) }).strict()).max(100).optional(),
  /** What this host can launch beyond workers: `leadStart`, a project's Product Manager (leadStart.ts). Absent from hosts
   *  before it, which are never given one. */
  capabilities: z.array(z.string().regex(/^[a-zA-Z]{1,40}$/)).max(16).optional(),
  /** The accounts a Product Manager could move to, per engine (cli superTabs/machines.ts profiles), of which only each engine's
   *  default account is kept (storedObservation): `id` is a stable 16-hex handle,
   *  `label` a name its owner chose (never an email, so no '@'), `leftPercent` the allowance left. Absent from hosts before it. */
  profiles: z.array(z.object({ engine: z.enum(['claude', 'codex']), id: z.string().regex(/^[0-9a-f]{16}$/),
    label: z.string().min(1).max(40).refine(l => !l.includes('@')), leftPercent: z.number().int().min(0).max(100).nullable(),
    resetsAt: z.string().datetime().nullable() }).strict()).max(16).optional(),
}).strict()
export type MachineObservation = z.infer<typeof machineObservationSchema>

/** A machine reports every 15 seconds (cli/src/superTabs/machines.ts); three missed beats is offline. */
export const MACHINE_FRESH_MS = 45_000

/** A machine's reading as its pool keeps it. */
export type StoredReading = NonNullable<ContributedMachine['observation']>

/** A start this machine may say it is preparing: one it launched that neither runs nor failed (liveness.ts). */
export const preparableStart = (start: AgentStart, machineId: string): boolean =>
  start.request.machineId === machineId && !!start.dispatched && !start.harnessId && !start.error

/** A start this machine may say the server refused: one of its own that neither runs nor failed, launched or not. */
export const refusableStart = (start: AgentStart, machineId: string): boolean =>
  start.request.machineId === machineId && !start.harnessId && !start.error

/**
 * What a report stores of [observation] on [pool]: progress and tokens of running sessions only (leases and attempts read
 * them), the preparing starts [preparable] allows, the refused starts [refusable] allows, the contributed engines' quotas, and how the
 * machine is signed in, from the session and never from the report (lib/teamSession.ts).
 * A full report and a reading-only one (DB 2.5) store the same.
 */
export function storedObservation(pool: ContributedMachine, observation: MachineObservation,
  opts: { team: boolean; now: number; preparable: (startId: string) => boolean; refusable?: (startId: string) => boolean }): StoredReading {
  const { privacy: _reported, harnessProgress, harnessTokens, preparingStartIds, refusedStarts, profiles, idleBuddyHarnessIds, ...reading } = observation
  const running = (id: string) => observation.runningHarnessIds.includes(id)
  const progress = harnessProgress && Object.fromEntries(Object.entries(harnessProgress).filter(([id]) => running(id)))
  const tokens = harnessTokens && Object.fromEntries(Object.entries(harnessTokens).filter(([id]) => running(id)))
  const preparing = preparingStartIds?.filter(opts.preparable)
  // None unless the caller can tell which starts this machine may name (refusableStart).
  const refused = refusedStarts?.filter(r => opts.refusable?.(r.startId) ?? false)
  const engines = contributedEngines(pool, observation)
  return { ...reading, quotas: observation.quotas.filter(q => engines.includes(q.engine)), receivedAt: opts.now,
    ...(idleBuddyHarnessIds ? { idleBuddyHarnessIds: [...new Set(idleBuddyHarnessIds.filter(running))] } : {}),
    // Each engine's default account alone: a PM runs on no other (pmAccount.ts), whatever a CLI of the last 30 days reports.
    ...(profiles ? { profiles: profiles.filter(p => engines.includes(p.engine) && p.id === defaultProfileId(pool.machineId, p.engine)) } : {}),
    sessionKind: opts.team ? 'team' : 'computer', ...(progress ? { harnessProgress: progress } : {}),
    ...(tokens ? { harnessTokens: tokens } : {}), ...(preparing ? { preparingStartIds: preparing } : {}),
    ...(refused?.length ? { refusedStarts: refused } : {}) }
}

const sameSet = (a: readonly string[] = [], b: readonly string[] = []) => {
  const left = new Set(a), right = new Set(b)
  return left.size === right.size && [...left].every(id => right.has(id))
}

/**
 * Whether [next] changes nothing a report decides from, against [previous] (DB 2.5 spec, section 1 condition 2): the same
 * running and stopped sessions, no stop proof, no refused start, the same preparing starts. Progress renews leases (liveness.ts
 * reportRenewedAt), so it also keeps its shape, and no session's progress goes back: a lease then ends no sooner than the
 * last full report saw.
 */
export function readingOnly(previous: StoredReading | undefined, next: StoredReading): boolean {
  // How the machine is signed in decides who may host it (store.ts teamByRecord reads the stored one): a reading from the
  // other kind of session runs in full, so the full report's refusal is never skipped (review of #2378).
  // A refused start fails in the full report, which reads the Swarm's starts (store.ts fullReading).
  if (!previous || next.stoppedReservations?.length || next.refusedStarts?.length || previous.sessionKind !== next.sessionKind) return false
  if (!sameSet(previous.runningHarnessIds, next.runningHarnessIds) || !sameSet(previous.stoppedHarnessIds, next.stoppedHarnessIds)
    || !sameSet(previous.closedHarnessIds ?? [], next.closedHarnessIds ?? [])
    || !sameSet(previous.preparingStartIds, next.preparingStartIds)
    || !sameSet(previous.idleBuddyHarnessIds, next.idleBuddyHarnessIds)) return false
  if (!previous.harnessProgress || !next.harnessProgress) return !previous.harnessProgress && !next.harnessProgress
  const before = previous.harnessProgress, after = next.harnessProgress
  return sameSet(Object.keys(before), Object.keys(after)) && Object.entries(before).every(([id, at]) => after[id]! >= at)
}

/** Whether [start] is preparing now: launched, neither running nor failed, and named by a fresh report of its own machine.
 *  Read from that report, never written into the start, so a report a minute per start writes nothing more. */
export function startPreparing(state: SuperTabState, start: AgentStart, now: number): boolean {
  if (!start.dispatched || start.harnessId || start.error || start.dispatchedAt === undefined) return false
  const report = state.machines?.find(m => m.machineId === start.request.machineId)?.observation
  return !!report?.preparingStartIds?.includes(start.id) && now - report.receivedAt <= MACHINE_FRESH_MS
}

export type TeamWorkCode = 'TEAM_WRITTEN_WORK' | 'NOT_SWARM_MACHINE' | 'TEAM_ACCOUNTS_REMOVED' | 'NOT_YOUR_COMPUTER' | 'READ_ONLY' | 'STEP_OS'
export interface TeamWorkRefusal { code: TeamWorkCode; reason: string }

/**
 * Whether this server asks a project's repository to be approved before its tokens are handed out (`SWARM_TEAM_ACCOUNT_REQUIRED=1`;
 * the repository approvals in store.ts and routes/superTabs.ts). Read on every call, so a test can set it. It goes with the
 * GitHub App's removal.
 */
export function teamAccountRequired(): boolean {
  return process.env.SWARM_TEAM_ACCOUNT_REQUIRED === '1'
}

/** What a machine's record held before Swarm v4 retired it (machine.access, machine.projects, machine.ownAccountWork and the notice
 *  to a machine's owner of others' work): stored until the contribution is saved again, and read by no one (model.ts visibleState).
 *  Delete this list when the stored copies are cleaned from the Swarm collections (slice S19), and not before 2026-12-09. */
export const RETIRED_MACHINE_FIELDS = ['ownAccountChoice', 'othersToldWeek', 'projects', 'access'] as const

/**
 * Whether work for [project] may run on [machineId] under [contributorId]'s grant there: the pool's contributor for a start, the
 * agent's contributor for an agent already in the Swarm. Swarm v3 has no Team accounts (task #4120, the PM's ruling there): an
 * agent a person brought works on any task of a project that person can read, in their own account, so the work runs as its own
 * person and never as a machine owner it does not belong to.
 */
export function teamWorkCheck(state: SuperTabState, machineId: string, contributorId: string, project: SwarmProject): TeamWorkRefusal | null {
  const pool = state.machines?.find(m => m.machineId === machineId)
  // A Buddy-only machine is its person's alone: an agent they added there takes their own projects' work and no other's
  // (security re-check 1 of #2234). New starts there are refused in admitMachineStart.
  if (pool?.buddyOnly) return ownsProject(state, pool.contributorId, project) ? null : { code: 'NOT_SWARM_MACHINE', reason: NOT_SWARM_MACHINE }
  // A Team account's agent already in the Swarm keeps working in what it holds until it is stopped after the release; it gets no
  // new work and no new agent starts there, which their own gates refuse (admitMachineStart, work.assign, the route, the picks).
  if (pool && pool.contributorId !== contributorId) return { code: 'NOT_YOUR_COMPUTER', reason: NOT_YOUR_COMPUTER }
  const person = state.people.find(p => p.id === contributorId)
  // Reading is not working: a viewer's agent takes no work (security review 1 of #3446).
  if (person?.role === 'viewer') return { code: 'READ_ONLY', reason: 'This agent\'s person is a viewer here, so their agents take no work.' }
  if (ownsProject(state, contributorId, project) || (person && canReadProject(state, { kind: 'person', userId: person.id, email: person.email }, project))) return null
  return { code: 'NOT_YOUR_COMPUTER', reason: `${pool?.name ?? 'This machine'}'s person cannot read this project, so its agents take none of its work.` }
}

/** Why a Team account's entry takes no new agent and no new work (task #4120). */
export const TEAM_ACCOUNTS_GONE: TeamWorkRefusal = { code: 'TEAM_ACCOUNTS_REMOVED',
  reason: 'Harness Team accounts are gone: an agent runs on its own person\'s computer, in their own account.' }
/** Why a new agent does not start on another person's computer (task #4120): it would run as that computer's person. */
export const NOT_YOUR_COMPUTER = 'A new agent starts only on its own person\'s computer, in their own account, never on another person\'s.'

// ── One machine: a Mac and its Harness Team account ─────────────────────────────────────────────────────────────────
// The team account is how a Mac runs teammates' work without its owner's files, not a machine of its own to anyone: a
// Lead names the Mac, and the work for another person's project lands in the Mac's team account.

/** Every pool of a Harness Team account on the Mac [pool] is, under the same grant: one, or more once the account was
 *  removed and set up again (a new account and machine, the old one's pool still listed). They go with the Mac. */
export function teamPoolsOf(state: SuperTabState, pool: ContributedMachine): ContributedMachine[] {
  if (pool.hostMachineId) return []
  return state.machines?.filter(m => m.hostMachineId === pool.machineId && m.contributorId === pool.contributorId) ?? []
}

/** The name a machine's owner gave it in Machines (its account row, routes/machines.ts rename), which every Swarm list shows
 *  (Dee, #2308): seeded from its computer's hostname, so a machine never renamed keeps that. Null when the row has none. */
export function accountMachineName(row: { name: string | null } | null | undefined): string | null {
  return row?.name?.trim() || null
}

/** Whether [pool] shows another name than [name], its owner's (accountMachineName). A Team account's pool goes by its Mac's
 *  name, never its own account's "<Mac> · Team": it follows its Mac (followAccountName). */
export function renamedBy(pool: ContributedMachine, name: string | null): name is string {
  return !!name && !pool.hostMachineId && pool.name !== name
}

/** Renames [pool], and its Mac's Team account pools, to [name] when its owner renamed it (renamedBy); whether it did. Its
 *  host's readings call it, so a rename shows in every Swarm the machine is in by its next heartbeat. */
export function followAccountName(state: SuperTabState, pool: ContributedMachine, name: string | null): boolean {
  if (!renamedBy(pool, name)) return false
  for (const each of [pool, ...teamPoolsOf(state, pool)]) each.name = name
  return true
}

/** The one of them that runs teammates' work on the Mac: not being removed, and the last to report. Undefined when none. */
export function teamPoolOf(state: SuperTabState, pool: ContributedMachine): ContributedMachine | undefined {
  return teamPoolsOf(state, pool).filter(m => !m.removal)
    .reduce<ContributedMachine | undefined>((best, m) => !best || (m.observation?.receivedAt ?? -1) >= (best.observation?.receivedAt ?? -1) ? m : best, undefined)
}

/** The projects with work on [machineId]: its agents' and its pending starts'. */
export function projectsOnMachine(state: SuperTabState, machineId: string): Set<string> {
  // A start in an agent's own chat or a Buddy's belongs to no project.
  const pending = (state.starts ?? []).filter(s => s.request.machineId === machineId && !s.harnessId && !s.error)
    .flatMap(s => s.request.leadFor?.projectId ?? startProject(state, s.request)?.id ?? [])
  return new Set([...state.agents.filter(a => a.machineId === machineId).map(a => agentProjectId(state, a)), ...pending])
}

/** The project whose Product Manager runs, or is starting, on [machineId]; null when none does. In a Harness Team account it
 *  serves only that project: every agent there is one macOS user, which reads the others' files, the Product Manager's
 *  saved sessions with people's private chats among them (#895). */
export function productManagerOn(state: SuperTabState, machineId: string): string | null {
  const led = state.agents.find(a => a.machineId === machineId && ledProject(state, a.id))
  if (led) return ledProject(state, led.id)!.id
  // One removed whose host has not yet confirmed its data there is deleted (commands.ts removeAgent).
  const closing = state.closingSessions?.find(c => c.machineId === machineId && c.heldFor)
  if (closing) return closing.heldFor!
  return state.starts?.find(s => s.request.machineId === machineId && s.request.leadFor && !s.harnessId && !s.error)?.request.leadFor!.projectId ?? null
}

/** The folder a start for [project] uses on [pool]: what admitMachineStart accepts there. */
export function projectFolder(pool: ContributedMachine, project: SwarmProject): string {
  return pool.scope === 'swarm'
    ? project.repository?.machineId === pool.machineId ? project.repository.cwd : `${pool.cwd.replace(/\/+$/, '')}/${project.id}`
    : pool.cwd
}

/** [request] as [pool] can carry it out for [project]: a project whose folder is recorded without a repository address has
 *  nothing to clone or branch from on any machine but the one that folder is on, so elsewhere it starts in the project's own
 *  empty folder without a worktree (task #3211); its host makes that folder (cli superTabs/projectFolder.ts). A project with
 *  no folder recorded yet is left alone: its first start records one. Any other start is unchanged. */
export function noRepositoryStart(pool: ContributedMachine | undefined, project: SwarmProject | undefined, request: AgentStartRequest): AgentStartRequest {
  const repository = project?.repository
  if (!pool || pool.scope !== 'swarm' || !repository || repository.repositoryUrl || repository.machineId === pool.machineId) return request
  if (!request.worktree && !request.branchRef) return request
  const { branchRef: _branchRef, ...rest } = request
  return { ...rest, worktree: false }
}

/** What a host reports (`capabilities`) when it runs a Swarm-wide Buddy in its folder of project worktrees (Dee, 10-31). */
export const SWARM_BUDDY_CAPABILITY = 'swarmBuddy'
/** At most this many projects' worktrees in a Swarm-wide Buddy's folder (spec: Staying within one context). */
export const MAX_BUDDY_PROJECTS = 50

/** A Swarm-wide Buddy's own folder on [pool] (spec: Folder): its host makes it, with one read-only worktree per project in it. It
 *  is no project's checkout, so nothing of one project is ever another's. */
export function buddyHomeFolder(pool: ContributedMachine, owner: { id: string }): string {
  return `${pool.cwd.replace(/\/+$/, '')}/.buddy-${owner.id}`
}

/** The projects [owner] reads, as a Swarm-wide Buddy's folder on [pool] holds them: each project's own folder there, the oldest
 *  first, at most MAX_BUDDY_PROJECTS. Ids, names and folders only (starts are listed to the PM). */
export function buddyProjectsOn(state: SuperTabState, pool: ContributedMachine, owner: { id: string; email: string }): Array<{ id: string; name: string; cwd: string }> {
  const readable = projectsOf(state).filter(p => canReadProject(state, { kind: 'person', userId: owner.id, email: owner.email }, p))
    // A machine shared for one project only has that project's folder alone (projectFolder answers its folder for any project):
    // never list another project at it (security review 1 of #2435).
    .filter(p => pool.scope === 'swarm' || p.id === 'lead')
    .map(p => ({ id: p.id, name: p.name, cwd: projectFolder(pool, p) }))
  // Only projects with a folder of their own: two that answer the same folder would show one project's code as the other's.
  const counts = new Map<string, number>()
  for (const p of readable) counts.set(p.cwd, (counts.get(p.cwd) ?? 0) + 1)
  return readable.filter(p => counts.get(p.cwd) === 1).slice(0, MAX_BUDDY_PROJECTS)
}

/** Refuses with the refusal's code and sentence: 403. */
export function failTeamWork(refusal: TeamWorkRefusal, after = ''): never {
  fail(refusal.code, `${refusal.reason}${after}`, 403)
}

export function requireTeamWork(...args: Parameters<typeof teamWorkCheck>): void {
  const refusal = teamWorkCheck(...args)
  if (refusal) failTeamWork(refusal)
}

/** Since when an agent has been down: the stored time a reading first showed its session gone or the host confirmed its
 * stop, or its machine's last reading once that is stale. Nothing is written while a machine is silent, so that case is
 * read from the reading itself. Undefined while it is up. */
export function downSince(state: SuperTabState, target: Agent, now: number): string | undefined {
  const observation = state.machines?.find(m => m.machineId === target.machineId)?.observation
  const offline = observation && now - observation.receivedAt > MACHINE_FRESH_MS ? new Date(observation.receivedAt).toISOString() : undefined
  return [target.downSince, offline].filter(Boolean).sort()[0]
}

/** Before a new reading replaces the last one: a session it lists as running is back; any other agent on the machine
 * keeps the earliest time it was down, including the time its machine went silent. */
export function recordAgentPresence(state: SuperTabState, machineId: string, running: string[], now: number): void {
  for (const target of state.agents.filter(a => a.machineId === machineId)) {
    if (running.includes(target.harnessId)) {
      delete target.downSince
      delete target.downNamed
    } else {
      // A stop is counted once, when a reading first shows the session gone; the last hour's, at most five (task #3662).
      if (!target.downSince) target.stops = [...(target.stops ?? []).filter(at => now - at < 3_600_000), now].slice(-5)
      target.downSince = downSince(state, target, now) ?? new Date(now).toISOString()
    }
  }
}

/** Why a start other than its own person's Buddy is refused on a Buddy-only machine: worded as for any machine outside the
 *  Swarm, so the refusal says nothing about whose it is or what runs there. */
/** A host that can tell a Buddy's window from another agent's on Windows (CLI callerPane.ts `windowsRunningPane`). An older one
 *  cannot: a Buddy there refused every agent's Swarm command on that computer (security review of #2093). */
export const WINDOWS_BUDDY_CAPABILITY = 'windowsBuddy'
export const BUDDY_WINDOWS_REFUSAL = 'Update Harness on this Windows machine to run a Buddy on it, or pick another of your machines.'
export const refusesWindowsBuddy = (pool: ContributedMachine): boolean => pool.observation?.resources.os === 'Windows'
  && !pool.observation.capabilities?.includes(WINDOWS_BUDDY_CAPABILITY)
export const NOT_SWARM_MACHINE = 'This machine is not one of the Swarm\'s machines.'
/** The most machines one person adds to one Swarm (#2637, Ken, 2026-11-04). The Swarm-wide 32 dated from one 16 MB
 *  document; each machine is its own part now. Team accounts' entries count apart, so a Mac's Team account never uses up
 *  its owner's 20, and still have a bound. Review again when one Swarm passes 100 entries (plan 2026-11-04). */
export const MACHINES_PER_PERSON = 20
export const MACHINE_LIMIT_MESSAGE = `You have ${MACHINES_PER_PERSON} machines in this Swarm, the most one person can add. Remove one before adding another.`
/** How many more machines [contributorId] may add to [state], or with [team] Team accounts' entries. Buddy-only records count
 *  as the person's machines. The command's check and the host's join rows both read this, so they never disagree. */
export const machineRoom = (state: SuperTabState, contributorId: string, { team = false } = {}): number =>
  Math.max(0, MACHINES_PER_PERSON - (state.machines ?? []).filter(m => m.contributorId === contributorId && !!m.hostMachineId === team).length)
export const machineLimitReached = (state: SuperTabState, contributorId: string, options: { team?: boolean } = {}): boolean =>
  machineRoom(state, contributorId, options) === 0

/** A Buddy-only machine with no Buddy left on it, running or starting, leaves: its host deletes the Swarm's folders there as
 *  for a removed machine, and no chat hears of it, since none ever saw it (Lead, 10-29). Run after every command (commands.ts)
 *  and every liveness sweep (liveness.ts), so each way a Buddy goes (removed, failed or timed out, its person or project
 *  gone) ends it, as expireRemovals does for removals. Written as a machine part change, guarded by its version. */
export function dropIdleBuddyMachines(state: SuperTabState, now: number): void {
  for (const pool of state.machines?.filter(m => m.buddyOnly) ?? []) {
    if (state.agents.some(a => a.machineId === pool.machineId)
      || state.starts?.some(s => s.request.machineId === pool.machineId && !s.harnessId && !s.error)) continue
    state.machines = state.machines!.filter(m => m !== pool)
    ;(state.machineCleanups ??= []).push({ machineId: pool.machineId, removalId: stableId('buddy-machine', pool.machineId, pool.generation),
      machineOwnerId: pool.contributorId, requestedAt: new Date(now).toISOString(), buddyOnly: true })
    state.harnessReservations = state.harnessReservations?.filter(r => r.machineId !== pool.machineId)
    state.releasedHarnesses = state.releasedHarnesses?.filter(r => r.machineId !== pool.machineId)
    state.removedSessions = state.removedSessions?.filter(r => r.machineId !== pool.machineId)
  }
}

/** The Swarm's own machines: every contribution but a Buddy-only one (ContributedMachine.buddyOnly). */
const swarmMachines = (state: Pick<SuperTabState, 'machines'>): ContributedMachine[] => (state.machines ?? []).filter(m => !m.buddyOnly)

export function machineContribution(state: SuperTabState, machineId: string) {
  const pool = state.machines?.find(m => m.machineId === machineId)
  if (!pool) return null
  const contributor = person(state, pool.contributorId)
  // Its person left and came back while their host still removes what the Swarm had there (task #4252): that ends by itself.
  if (contributor.role !== 'viewer' && contributor.generation !== pool.membershipGeneration && pool.removal) {
    fail('MACHINE_CLEANING', `${pool.name ?? 'This machine'} is still cleaning up after its person left the Swarm. Try again once that finishes, in a minute or two.`)
  }
  if (contributor.role === 'viewer' || contributor.generation !== pool.membershipGeneration) {
    fail('CONTRIBUTION_REVOKED', 'This machine contribution was withdrawn.', 403)
  }
  return pool
}

/** A machine is its owner's to remove: whoever contributed it, or, for a machine with only shared agents, whoever
 *  contributed all of them. Not the Swarm owner (spec 2026-10-23-remove-machine.md, decision 1). */
export function ownedMachine(state: SuperTabState, actor: Actor, machineId: string) {
  const pool = state.machines?.find(m => m.machineId === machineId)
  // Not listed to anyone: it goes with its last Buddy (commands.ts dropIdleBuddyMachines), never by a removal that tells chats.
  if (pool?.buddyOnly) fail('NOT_FOUND', 'This machine is not in the Swarm.', 404)
  const members = state.agents.filter(a => a.machineId === machineId)
  if (!pool && !members.length) fail('NOT_FOUND', 'This machine is not in the Swarm.', 404)
  const ownerId = pool?.contributorId ?? (members.every(a => a.contributorId === members[0]!.contributorId) ? members[0]!.contributorId : null)
  if (actor.kind !== 'person' || actor.userId !== ownerId) fail('FORBIDDEN', 'Only the machine\'s owner can remove it.', 403)
  return { pool, members }
}

/** What removing the machine would do, for its owner's confirmation. */
export function removalPreview(state: SuperTabState, actor: Actor, machineId: string) {
  const owned = ownedMachine(state, actor, machineId)
  // A Mac leaves with its Harness Team account and the agents there (commands.ts machine.remove).
  const teams = owned.pool ? teamPoolsOf(state, owned.pool).filter(m => !m.removal).map(m => m.machineId) : []
  const members = [...owned.members, ...state.agents.filter(a => teams.includes(a.machineId))]
  const led = members.map(a => ledProject(state, a.id)).find(Boolean)
  const visibleAgents = members.filter(a => canReadAgent(state, actor, a))
  const soleSourceProjects = projectsOf(state).filter(p => p.repository?.machineId === machineId && !p.repository.repositoryUrl)
  const visibleSoleSourceProjects = soleSourceProjects.filter(p => canReadProject(state, actor, p))
  return {
    blockedBy: led ? canReadProject(state, actor, led)
      ? { projectId: led.id, projectName: led.name } : { reason: "A Product Manager of a project you can't see runs on this machine." } : null,
    agents: visibleAgents.map(a => {
      // The task in its hands first, then one it handed over (#3399).
      const task = state.conversations.find(c => occupiesAgent(c) && c.assignment!.agentId === a.id)
        ?? state.conversations.find(c => activeWork(c) && c.assignment!.agentId === a.id)
      return { id: a.id, name: a.displayName ?? a.name, projectName: projectsOf(state).find(p => p.id === agentProjectId(state, a))?.name ?? '',
        ...(task ? { task: task.title } : {}) }
    }),
    hiddenAgentCount: members.length - visibleAgents.length,
    // Their code is only on this machine: agents elsewhere start in an empty folder until someone shares a repository (#3211).
    soleSourceProjects: visibleSoleSourceProjects.map(p => ({ id: p.id, name: p.name })),
    hiddenSoleSourceProjectCount: soleSourceProjects.length - visibleSoleSourceProjects.length,
  }
}

/** No reading yet, or one older than three missed beats: the machine Desktop shows as offline, and the one a start
 *  is refused on. Nothing is written while a machine is silent, so this is read from the last reading itself. */
export function machineOffline(pool: ContributedMachine, now: number): boolean {
  return !pool.observation || now - pool.observation.receivedAt > MACHINE_FRESH_MS
}

/** A removal its host cannot acknowledge (offline) or has not acknowledged in REMOVAL_FALLBACK_MS: the machine's records go, and the
 *  cleanup waits for its host on its next connection. No chat is told: the Machines list shows which machines are in the Swarm
 *  (anh Dee, 11-04, #2742). */
export function expireRemoval(state: SuperTabState, pool: ContributedMachine): void {
  (state.machineCleanups ??= []).push({ machineId: pool.machineId, removalId: pool.removal!.id, machineOwnerId: pool.contributorId,
    requestedAt: pool.removal!.requestedAt })
  state.machines = state.machines!.filter(m => m !== pool)
}

/** Ends the removals that are due. A read applies them without writing. */
export function expireRemovals(state: SuperTabState, now: number): void {
  for (const pool of state.machines?.filter(m => m.removal
    && (machineOffline(m, now) || now - Date.parse(m.removal.requestedAt) >= REMOVAL_FALLBACK_MS)) ?? []) expireRemoval(state, pool)
}

/** Pending intents reserve slots too. Only an explicit host stop frees a launched slot. A Mac and its Harness Team account
 *  share the Mac's slots (One machine, teamStartRequest): each counts what runs on both. */
export function machineSlots(state: SuperTabState, pool: ContributedMachine) {
  return slotCounter(state)(pool)
}

/**
 * The slots each pool of `state` holds, for every pool a read lists: the Swarm's reservations, released harnesses, agents
 * and starts are grouped by machine once, where each pool used to filter the whole lists again (prod 10-31: 543 released
 * harnesses on 17 machines, ~27 k callbacks per change read, a quarter of its CPU). Counts the state as it is when called;
 * a command that changes the state asks again (machineSlots).
 */
export function slotCounter(state: SuperTabState): (pool: ContributedMachine) => number {
  const group = <T>(items: readonly T[] | undefined, machineOf: (item: T) => string) => {
    const by = new Map<string, T[]>()
    for (const item of items ?? []) {
      const list = by.get(machineOf(item))
      if (list) list.push(item)
      else by.set(machineOf(item), [item])
    }
    return by
  }
  const reservationsBy = group(state.harnessReservations, r => r.machineId)
  const releasedBy = group(state.releasedHarnesses, r => r.machineId)
  const agentsBy = group(state.agents, a => a.machineId)
  const startsBy = group(state.starts, s => s.request.machineId)
  const counted = new Map<ContributedMachine, number>()
  const poolSlots = (pool: ContributedMachine) => {
    const known = counted.get(pool)
    if (known !== undefined) return known
    const reservations = reservationsBy.get(pool.machineId) ?? []
    const live = new Set(reservations.map(r => r.harnessId))
    const released = (releasedBy.get(pool.machineId) ?? []).filter(r => !live.has(r.harnessId)).map(r => r.harnessId)
    const observed = pool.observation?.stoppedHarnessIds ?? []
    const stopped = new Set([...observed.filter(id => {
      const reservation = reservations.find(r => r.harnessId === id)
      // Older hosts can prove a first launch stopped, but cannot distinguish a resumed runtime from its predecessor.
      return !reservation || !reservation.renewed || pool.observation?.stoppedReservations?.some(r => r.harnessId === id && r.generation === reservation.generation)
    }), ...released])
    const running = new Set((pool.observation?.runningHarnessIds ?? []).filter(id => !stopped.has(id)))
    for (const a of agentsBy.get(pool.machineId) ?? []) if (!stopped.has(a.harnessId)) running.add(a.harnessId)
    for (const r of reservations) if (!stopped.has(r.harnessId)) running.add(r.harnessId)
    let pending = 0
    for (const start of startsBy.get(pool.machineId) ?? []) {
      if (start.error) continue
      // A finished start's harness counts through its agent or its host's report. Reads keep finished starts until they expire,
      // and counted every harness ever started there (Mac Studio, 10-29: 13 running, 121 counted, no free agents shown).
      if (start.harnessId) { if (!startFinished(start) && !stopped.has(start.harnessId)) running.add(start.harnessId) }
      else pending++
    }
    counted.set(pool, running.size + pending)
    return running.size + pending
  }
  return pool => {
    const mac = pool.hostMachineId ? state.machines?.find(m => m.machineId === pool.hostMachineId && m.contributorId === pool.contributorId) : pool
    const team = mac && teamPoolOf(state, mac)
    return [...new Set([pool, mac, team])].reduce((sum, each) => sum + (each ? poolSlots(each) : 0), 0)
  }
}

/** Machines of the Swarm serving models on its grid now, by model: only fresh readings count. */
/** What a Swarm's owner's computer keeps on grid for it (docs/plans/2026-10-23-swarm-local-models.md): the grid, and as its
 *  members the people who may act in the Swarm. A viewer is not one, and the owner is the grid's admin already. */
export function swarmGridRow(tabId: string, state: SuperTabState) {
  const local = state.localModels
  if (!local) return null
  return { tabId, grid: local.grid, enabled: local.enabled, ready: local.ready ?? null,
    members: state.people.filter(p => p.role !== 'viewer' && p.id !== state.ownerId).map(p => p.email) }
}

/** The grid a contributed machine reports served models on: only while the add-on is on, so the host asks grid nothing otherwise. */
export const hostLocalGrid = (state: SuperTabState) => state.localModels?.enabled ? { localGrid: state.localModels.grid } : {}

export function servedLocalModels(state: SuperTabState, now: number) {
  const grid = state.localModels?.enabled ? state.localModels.grid : null
  if (!grid) return []
  return swarmMachines(state).flatMap(m => !m.observation || now - m.observation.receivedAt > MACHINE_FRESH_MS ? []
    : (m.observation.localModels ?? []).filter(l => l.grid === grid && !l.starting).map(l => ({ ...l, machineId: m.machineId })))
}

/** Whether a start names a model it may run on now: one the Swarm's grid serves, from any machine; or one on another grid
 *  that the start's own machine reads it can use (shared with its owner, owner 2026-10-23). Grid models carry no
 *  subscription model or effort. */
export function localModelAllowed(state: SuperTabState, request: AgentStartRequest, now: number): boolean {
  const grid = state.localModels?.enabled ? state.localModels.grid : null
  if (!grid || !request.gridModel || !request.gridName || request.model || request.effort) return false
  if (request.gridName === grid) return servedLocalModels(state, now).some(l => l.model === request.gridModel)
  const pool = (state.machines ?? []).find(m => m.machineId === request.machineId)
  return !!pool?.observation && now - pool.observation.receivedAt <= MACHINE_FRESH_MS
    && (pool.observation.localModels ?? []).some(l => l.grid === request.gridName && l.model === request.gridModel && !l.starting)
}

/** [forProject]: the project it is for when that is not yet its conversation's, as New Project's Product Manager before the
 *  project exists (leadStart.ts). */
export function admitMachineStart(state: SuperTabState, request: AgentStartRequest, now: number, start?: AgentStart, forProject?: SwarmProject) {
  const pool = machineContribution(state, request.machineId)
  if (!pool) return null
  // No new agent in a Harness Team account, whoever asks (task #4120): its agents keep what they hold until they are stopped.
  if (teamAccountPool(pool)) failTeamWork(TEAM_ACCOUNTS_GONE)
  if (pool.buddyOnly && request.buddyOf?.personId !== pool.contributorId) fail('NOT_SWARM_MACHINE', NOT_SWARM_MACHINE, 403)
  // At its add and again at its launch: a Buddy-only machine is first read after its Buddy was asked for.
  if (request.buddyOf && refusesWindowsBuddy(pool)) fail('BUDDY_WINDOWS', BUDDY_WINDOWS_REFUSAL, 403)
  if (pool.removal) fail('MACHINE_REMOVED', 'This machine is being removed from the Swarm.')
  if (start && start.poolGeneration !== pool.generation) fail('CONTRIBUTION_REVOKED', 'This machine contribution changed. Reconcile the original start.', 403)
  if (pool.paused) fail('MACHINE_PAUSED', 'New work is paused on this machine.')
  // A person's one Buddy chat has no project (Dee, 10-31): its project session works in the one it names, and its main Buddy
  // and plain sessions in none, in their own folder (buddyHomeFolder).
  const group = forProject ? undefined : conversation(state, request.conversationId)
  // A Regular agent's own chat has none either (agent.new, task #4116): it starts in its person's home folder. A Member's start
  // names its project (members.ts, task #4697), and starts in that project's folder as any project agent does (#4698).
  const project = forProject ?? (request.member ? projectOf(state, request.member.projectId) : isAgentChat(group!) ? undefined : !isSwarmBuddyChat(group!) ? groupProject(state, group!)
    : request.buddySession?.projectId ? projectOf(state, request.buddySession.projectId) : undefined)
  if (project && !pool.scope && project.id !== 'lead') fail('PROJECT_CONTRIBUTION', 'Ask its owner to add this machine to the swarm again to support other projects.')
  const held = teamAccountPool(pool) ? productManagerOn(state, pool.machineId) : null
  if (held && held !== project?.id) {
    fail('TEAM_ACCOUNT_HELD', `The Harness Team account on ${pool.name} runs another project's Product Manager, so it takes only that project's work for now.`, 403)
  }
  // Before the request's own fields: a machine that takes none of this project's work says so first. A Buddy is its owner's
  // own agent on their own machine (commands.ts buddy.create), as a Lead is: teammates' work rules do not apply to it. Nor to
  // a Product Manager outside a Team account: any machine of the Swarm takes it (leadStart.ts, Ken 10-29).
  if (!request.buddyOf && !request.leadFor && !request.regular) requireTeamWork(state, pool.machineId, pool.contributorId, project!)
  const cwd = project ? projectFolder(pool, project) : buddyHomeFolder(pool, { id: request.buddyOf?.personId ?? pool.contributorId })
  // Every refused field is named, with what the machine does accept. Values the caller sent are not echoed: an account
  // setting can be a path or a name of the caller's own.
  const refused: string[] = []
  if (request.cwd !== cwd) refused.push(`cwd (this project uses ${cwd} on it)`)
  const engines = contributedEngines(pool)
  if (!engines.includes(request.engine)) refused.push(`engine (it contributes ${engines.join(', ') || 'no engines'})`)
  // A model served on the Swarm's own grid is the one exception to "default account settings": the owner turned the
  // add-on on, and some machine of the Swarm serves it now.
  const local = localModelAllowed(state, request, now)
  const settings = (['codexHome', 'gridModel', 'gridName'] as const).filter(key => request[key] && !(local && key !== 'codexHome'))
  if (settings.length) refused.push(`${settings.join(', ')} (it runs with its own default account settings, so leave ${settings.length > 1 ? 'them' : 'it'} out)`)
  // Swarm v3 (task #4215): an agent starts with its owner's own permission settings, so a start names no mode. Last, in the
  // words a CLI from before full mode answers by sending the start again without it (cli superTabs/start.ts before #4215).
  if (request.permissionMode !== undefined) refused.push('permissionMode (it runs with its own default account settings, so leave it out)')
  if (refused.length) {
    fail('OUTSIDE_CONTRIBUTION', `${pool.name} accepts only its contributed project folder, engines and default account settings. Refused: ${refused.join('; ')}.`, 403)
  }
  // A Buddy-only machine is recorded with its Buddy's start, before its host ever read the Swarm: the start waits for it.
  if (machineOffline(pool, now) && !(pool.buddyOnly && !pool.observation)) fail('MACHINE_OFFLINE', 'Wait for a fresh reading from the contributed machine.')
  if (!start) admitByRoom(state, pool, machineSlots(state, pool), request.requirements.memoryBytes, request.buddyOf ? 'a Buddy' : 'an agent')
  const machineReason = !start ? machineSuspensionReason(pool, now) : null
  if (machineReason) fail('MACHINE_UNAVAILABLE', machineReason)
  // A new start only: a grid model runs without the engine's subscription, and one already asked for is settled by its host.
  const unusable = !start && !local ? engineUnusable(pool, request.engine, now) : null
  if (unusable) fail('ENGINE_UNAVAILABLE', unusable)
  return pool
}

/** What one agent needs to start, as the CLI asks (capacity.ts START_REQUIREMENTS.memoryBytes). */
export const AGENT_MEMORY_BYTES = 2 * 1024 ** 3
/** The most agents any machine runs, as machine.contribute's own bound: a ceiling on growth, never a setting. */
export const MACHINE_AGENTS_CEILING = 1024

/** Its measured free memory, from its last reading; null with none. */
export function freeMemoryBytes(pool: Pick<ContributedMachine, 'observation'>): number | null {
  const r = pool.observation?.resources
  return r && typeof r.memoryTotalBytes === 'number' && typeof r.memoryUsedBytes === 'number' ? Math.max(0, r.memoryTotalBytes - r.memoryUsedBytes) : null
}

/** A Mac and its Harness Team account: one machine, one memory (slotCounter counts their slots together too). */
function memoryPair(state: SuperTabState, pool: ContributedMachine): ContributedMachine[] {
  const mac = pool.hostMachineId ? state.machines?.find(m => m.machineId === pool.hostMachineId && m.contributorId === pool.contributorId) : pool
  return [...new Set([pool, mac, mac && teamPoolOf(state, mac)])].filter((m): m is ContributedMachine => !!m)
}

/** What a new start can use on [pool] as memory allows: the least free memory its Mac and Team account last read, less what
 *  starts admitted there and not yet launched will take, which no reading shows yet (review of #3001: three 2 GiB starts
 *  were all admitted on 5 GiB free). Null with no reading. */
export function startableMemoryBytes(state: SuperTabState, pool: ContributedMachine): number | null {
  const pair = memoryPair(state, pool)
  const readings = pair.map(freeMemoryBytes).filter((free): free is number => free !== null)
  if (!readings.length) return null
  const machines = new Set(pair.map(m => m.machineId))
  let held = 0
  for (const start of state.starts ?? []) {
    if (start.error || start.harnessId || !machines.has(start.request.machineId)) continue
    held += start.request.requirements?.memoryBytes || AGENT_MEMORY_BYTES
  }
  return Math.max(0, Math.min(...readings) - held)
}

/** How many more agents it takes now, for the route and Desktop: as memory allows, one per AGENT_MEMORY_BYTES of startable
 *  memory (none with no reading), whatever count its owner saved before (capacity settings went, 2026-11-10). Its host checks
 *  free memory and disk again at each launch. */
export function availableSlots(state: SuperTabState, pool: ContributedMachine, used: number): number {
  const ceiling = Math.max(0, MACHINE_AGENTS_CEILING - used)
  const free = startableMemoryBytes(state, pool)
  return free === null ? 0 : Math.min(ceiling, Math.floor(free / AGENT_MEMORY_BYTES))
}

const gib = (bytes: number) => `${Math.round(bytes / 1024 ** 3 * 100) / 100} GB`
/** A new start's room on [pool], said in words its owner can act on: its free memory, for what the start asks or, asking none,
 *  an agent's (as startableMemoryBytes holds it). */
export function admitByRoom(state: SuperTabState, pool: ContributedMachine, used: number, asked: number, who = 'an agent') {
  const memoryBytes = asked || AGENT_MEMORY_BYTES
  if (used >= MACHINE_AGENTS_CEILING) fail('MACHINE_FULL', `${pool.name} already runs ${used} agents, the most any machine runs.`)
  const free = startableMemoryBytes(state, pool)
  if (free !== null && free < memoryBytes) {
    fail('MACHINE_FULL', `${pool.name} is out of free memory: ${gib(free)} free, and ${who} needs ${gib(memoryBytes)}. Try again when an agent there finishes, or pick another machine.`,
      409, { reason: 'memory' })
  }
}
