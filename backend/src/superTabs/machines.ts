import { z } from 'zod'
import { activeWork, fail, person, type Actor, type Agent, type AgentStart, type AgentStartRequest, type SuperTabState } from './model.js'
import { agentProjectId, groupProject, ledProject, projectsOf, type SwarmProject } from './projects.js'
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
  maxAgents: number
  paused: boolean
  /** `sessionKind` is how the reporting machine is signed in, stamped from its session by the store, never taken from
   *  the report: `team` for a Mac's team account (lib/teamSession.ts), `computer` for any other. Absent on older readings.
   *  `privacy` is kept only from a team session's reading (observedPrivacy). */
  observation?: Omit<MachineObservation, 'privacy'> & { receivedAt: number; sessionKind?: 'team' | 'computer'; privacy?: StoredPrivacy }
  /** A Mac's Harness Team account: the machine of the Mac it lives on, stamped by the store from its account row
   *  (`Machine.hostMachineId`), never taken from the command. Such a pool is that Mac under the scenes ("One machine",
   *  docs/plans/2026-10-24-swarm-team-account.md): it shows the Mac's name, joins where the Mac was added, follows the
   *  Mac's pause, slots and removal, and runs teammates' projects started on the Mac (teamStartRequest). */
  hostMachineId?: string
  /** Set by machine.remove: an online machine stays listed, paused, while its host deletes the Swarm's folders there, until
   *  the host says it cleaned up (machine.cleaned) or REMOVAL_FALLBACK_MS passes. An offline one leaves the list at once and
   *  its cleanup waits for its host (expireRemovals). */
  removal?: { id: string; state: 'cleaning'; requestedAt: string }
  /** Agent-time Swarm agents ran here, by leaderboard week, kept by its readings (leaderboard/lent.ts). */
  lent?: import('./leaderboard/lent.js').LentWeek[]
}
/** A removed machine whose host never acknowledged in time: its records are gone, its host still cleans up on its next poll. */
export interface MachineCleanup { machineId: string; removalId: string; machineOwnerId: string }
export const REMOVAL_FALLBACK_MS = 24 * 3_600_000
/** Older contributions may name engines that Swarm no longer starts. Their fresh
 * observation lists the supported engines that are actually installed. */
export function contributedEngines(pool: ContributedMachine, observation: MachineObservation | undefined = pool.observation): string[] {
  const supported = (engine: string) => engine === 'claude' || engine === 'codex'
  return pool.engines.some(engine => !supported(engine))
    ? (observation?.quotas ?? []).map(quota => quota.engine).filter(supported)
    : pool.engines.filter(supported)
}
const measure = z.number().finite().nonnegative().nullable()
const percent = z.number().min(0).max(100).nullable()
const resource = z.object({
  cpuPercent: percent, memoryTotalBytes: measure, memoryUsedBytes: measure,
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
 * (`harness team on`). The owner's own daemon sends none. `item` is a short slug, so a newer CLI's item still reads.
 */
export const machinePrivacySchema = z.union([
  z.object({ mode: z.literal('account'), passed: z.literal(true), checkedAt }).strict(),
  z.object({ mode: z.literal('account'), passed: z.literal(false), item: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/), detail: z.string().max(1000), checkedAt }).strict(),
  z.object({ mode: z.literal('dedicated') }).strict(),
])
export type MachinePrivacy = z.infer<typeof machinePrivacySchema>
/** As a pool keeps it: `seenAt` is when this server first received that check's result, on the server's clock. */
export type StoredPrivacy = MachinePrivacy & { seenAt: number }
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
  quotas: z.array(quota).max(32), runningHarnessIds: z.array(z.string().max(160)).max(1000),
  stoppedHarnessIds: z.array(z.string().max(160)).max(1000),
  stoppedReservations: z.array(z.object({ harnessId: z.string().min(1).max(160), generation: z.string().min(1).max(160) }).strict()).max(1000).optional(),
  /** When each running agent's screen or transcript last changed (epoch ms); its lease renews on recent progress
   *  (liveness.ts). Absent from hosts before it, whose agents renew by running alone. */
  harnessProgress: z.record(z.string().max(160), z.number().int().nonnegative()).refine(v => Object.keys(v).length <= 1000).optional(),
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
  /** A Harness Team daemon's privacy check; absent from the owner's own daemon and from hosts before it. The store keeps
   *  it only when a team session reported it (observedPrivacy). */
  privacy: machinePrivacySchema.optional(),
  readiness: readiness.optional(),
  /** The starts this machine launched and is still preparing (fetching the project, checking its worktree out, starting
   *  the engine), as of this report. Such a start waits past the 3 minutes while reports keep naming it (liveness.ts);
   *  the store keeps only this machine's own launched starts. Absent from hosts before it, whose starts get 3 minutes. */
  preparingStartIds: z.array(z.string().min(1).max(160)).max(100).optional(),
}).strict()
export type MachineObservation = z.infer<typeof machineObservationSchema>

/** A machine reports every 15 seconds (cli/src/superTabs/machines.ts); three missed beats is offline. */
export const MACHINE_FRESH_MS = 45_000

/** Whether [start] is preparing now: launched, neither running nor failed, and named by a fresh report of its own machine.
 *  Read from that report, never written into the start, so a report a minute per start writes nothing more. */
export function startPreparing(state: SuperTabState, start: AgentStart, now: number): boolean {
  if (!start.dispatched || start.harnessId || start.error || start.dispatchedAt === undefined) return false
  const report = state.machines?.find(m => m.machineId === start.request.machineId)?.observation
  return !!report?.preparingStartIds?.includes(start.id) && now - report.receivedAt <= MACHINE_FRESH_MS
}

// ── Teammates' work runs only on Team machines (docs/plans/2026-10-24-swarm-team-account.md, Task 3) ──────────────
// A start or an assignment for a project whose owner is not the person whose grant runs the machine is a teammate's
// work. It would run as that machine's owner, with their files, logins and subscriptions, so it is admitted only on a
// Team machine — the Mac's Harness Team account, or a machine used only for agents — that shows its privacy now.
// Everything else refuses it and says why; a person's own projects on their own machines are unchanged.
// Until that is required everywhere (teamAccountRequired), it holds only on machines that have a team account.

/** How long a passed privacy check counts, from when this server first received it. The team account checks again
 *  every 5 minutes (cli/src/team/privacy.ts PRIVACY_RECHECK_MS) and reports within a 15-second beat, so a healthy
 *  machine's check is never older than about 5 minutes here. 15 minutes allows two missed rechecks (a slow check, a
 *  daemon restart) before routing stops, and bounds to 15 minutes how long a home folder opened again but no longer
 *  checked can still be trusted. A failing check counts at once, whatever its age. */
export const PRIVACY_FRESH_MS = 15 * 60_000

/**
 * The privacy a reading leaves on the pool: only a team session's, since an ordinary computer's says nothing about a
 * team account. The same check sent again keeps the date it first arrived, so a check that stops running goes stale on
 * the server's clock, whatever the reporting Mac's clock says.
 */
export function observedPrivacy(previous: StoredPrivacy | undefined, reported: MachinePrivacy | undefined, team: boolean, now: number): StoredPrivacy | undefined {
  if (!team || !reported) return undefined
  const same = previous && previous.mode === reported.mode && (reported.mode === 'dedicated'
    || (previous.mode === 'account' && previous.passed === reported.passed && previous.checkedAt === reported.checkedAt))
  return { ...reported, seenAt: same ? previous.seenAt : now }
}

export type TeamWorkCode = 'MACHINE_OFFLINE' | 'TEAM_ACCOUNT_REQUIRED' | 'PRIVACY_UNCHECKED' | 'PRIVACY_CHECK_FAILED' | 'PRIVACY_CHECK_STALE'
export interface TeamWorkRefusal { code: TeamWorkCode; reason: string }
/** Refusals that hold until a person acts on the machine; a stale check or an offline machine may pass again by itself. */
export const LASTING_TEAM_REFUSALS: readonly string[] = ['TEAM_ACCOUNT_REQUIRED', 'PRIVACY_UNCHECKED', 'PRIVACY_CHECK_FAILED']

/** What each item of the privacy check (cli/src/team/privacy.ts) could reach when it failed. */
const PRIVACY_ITEMS: Record<string, string> = {
  sentinel: 'it could read the privacy sentinel in its owner\'s home folder', 'home-listing': 'it could list its owner\'s home folder',
  gitconfig: 'it could read its owner\'s ~/.gitconfig', ssh: 'it could list its owner\'s ~/.ssh', projects: 'it could list its owner\'s project folders',
  keychain: 'it could list its owner\'s login Keychain folder', chrome: 'it could list its owner\'s Chrome profile', safari: 'it could list its owner\'s Safari folder',
  'standard-user': 'the team account is an administrator', unchecked: 'the check did not run',
}
const ONLY_OWN = 'so it runs only its owner\'s projects'

/**
 * Whether a teammate's work needs a Harness Team account on every machine of [state]'s Swarm
 * (`SWARM_TEAM_ACCOUNT_REQUIRED=1`). Until the CLI that makes team accounts is released, it does not: a machine without
 * one takes a teammate's work as it did before team accounts, while a machine with one already follows the rule.
 *
 * `SWARM_TEAM_ACCOUNT_OWNERS`, comma-separated emails, holds the switch to the Swarms those people own, so it can be tried
 * on production with one's own Swarm first and no other Swarm changes (2026-10-27). Empty, it is every Swarm's. Both are
 * read on every call, so a test can set them.
 */
export function teamAccountRequired(state?: Pick<SuperTabState, 'ownerId' | 'people'>): boolean {
  if (process.env.SWARM_TEAM_ACCOUNT_REQUIRED !== '1') return false
  const owners = (process.env.SWARM_TEAM_ACCOUNT_OWNERS ?? '').split(',').map(email => email.trim().toLowerCase()).filter(Boolean)
  if (!owners.length) return true
  const owner = state?.people.find(person => person.id === state.ownerId)?.email.toLowerCase()
  return !!owner && owners.includes(owner)
}

/** Why this contributed machine may not run a teammate's project now, or null when it may. `teamRow`: its account row
 *  says it is signed in as a team account (`Machine.sessionKind`), read by the store. `required`: whether the Swarm it is
 *  in needs a team account on every machine ([teamAccountRequired] of that Swarm). */
export function teamWorkRefusal(pool: ContributedMachine, now: number, teamRow = false, required = teamAccountRequired()): TeamWorkRefusal | null {
  const reading = pool.observation, name = pool.name
  if (!teamRow && reading?.sessionKind !== 'team' && !required) return null
  if (!reading || now - reading.receivedAt > MACHINE_FRESH_MS) {
    // A Mac's team account goes by its Mac's name ("One machine"), and the Mac itself may well be online.
    return { code: 'MACHINE_OFFLINE', reason: pool.hostMachineId
      ? `The Harness Team account on ${name} is offline, so it cannot show that it is private.`
      : `${name} is offline, so it cannot show that its Harness Team account is private.` }
  }
  if (!teamRow && reading.sessionKind !== 'team') return { code: 'TEAM_ACCOUNT_REQUIRED', reason: `${name} has no Harness Team account yet, ${ONLY_OWN}.` }
  const privacy = reading.privacy
  if (!privacy) return { code: 'PRIVACY_UNCHECKED', reason: `${name} has not reported a privacy check from its Harness Team account, ${ONLY_OWN}.` }
  if (privacy.mode === 'dedicated') return null
  if (!privacy.passed) {
    const what = PRIVACY_ITEMS[privacy.item]
    return { code: 'PRIVACY_CHECK_FAILED', reason: `The Harness Team account on ${name} is not private (${privacy.item}${what ? `: ${what}` : ''}), ${ONLY_OWN}.` }
  }
  if (now - privacy.seenAt > PRIVACY_FRESH_MS) {
    const minutes = Math.floor((now - privacy.seenAt) / 60_000)
    return { code: 'PRIVACY_CHECK_STALE', reason: `The privacy check on ${name} last passed ${minutes} minutes ago, ${ONLY_OWN} until it passes again.` }
  }
  return null
}

/**
 * Whether work for [project] may run on [machineId] under [contributorId]'s grant there: the pool's contributor for a
 * start on a contributed machine, the agent's contributor for an agent already in the Swarm. The project owner's own
 * grant always may. A teammate's needs a contributed Team machine that shows its privacy (teamWorkRefusal); a machine
 * outside the Swarm's Machines list reports nothing, so it never does. `teamMachines`: the tab's machines whose account
 * row is signed in as a team account, read by the store.
 */
export function teamWorkCheck(state: SuperTabState, machineId: string, contributorId: string, project: SwarmProject, now: number,
  teamMachines: readonly string[] = []): TeamWorkRefusal | null {
  if (project.ownerId === contributorId) return null
  const pool = state.machines?.find(m => m.machineId === machineId)
  if (!pool) {
    // Off the Machines list nothing reports a team account (store.ts teamMachines), so this is the switch alone.
    if (!teamAccountRequired(state)) return null
    return { code: 'TEAM_ACCOUNT_REQUIRED', reason: `This machine is not a Team machine of this Swarm, ${ONLY_OWN}.` }
  }
  return teamWorkRefusal(pool, now, teamMachines.includes(machineId), teamAccountRequired(state))
}

// ── One machine: a Mac and its Harness Team account ─────────────────────────────────────────────────────────────────
// The team account is how a Mac runs teammates' work without its owner's files, not a machine of its own to anyone: a
// Lead names the Mac, and the work for another person's project lands in the Mac's team account.

/** Every pool of a Harness Team account on the Mac [pool] is, under the same grant: one, or more once the account was
 *  removed and set up again (a new account and machine, the old one's pool still listed). They go with the Mac. */
export function teamPoolsOf(state: SuperTabState, pool: ContributedMachine): ContributedMachine[] {
  if (pool.hostMachineId) return []
  return state.machines?.filter(m => m.hostMachineId === pool.machineId && m.contributorId === pool.contributorId) ?? []
}

/** The one of them that runs teammates' work on the Mac: not being removed, and the last to report. Undefined when none. */
export function teamPoolOf(state: SuperTabState, pool: ContributedMachine, live?: readonly string[]): ContributedMachine | undefined {
  // [live]: the account rows still signed in as team accounts (store.ts teamMachines). One removed since (`harness team
  // remove` deletes its machine) leaves its pool behind, and the Mac goes back to what a Mac without one does.
  return teamPoolsOf(state, pool).filter(m => !m.removal && (!live || live.includes(m.machineId)))
    .reduce<ContributedMachine | undefined>((best, m) => !best || (m.observation?.receivedAt ?? -1) >= (best.observation?.receivedAt ?? -1) ? m : best, undefined)
}

/** Where a new agent for [project] runs when a start names [machineId]: the Mac's team account when the project is not
 *  its contributor's own and the Mac has one in this Swarm, else the machine named. */
export function teamMachineFor(state: SuperTabState, machineId: string, project: SwarmProject, idle = false, live?: readonly string[]): string {
  // With no GitHub App on this server a team account cannot fetch or push, so the work stays on the Mac, as before.
  if (idle) return machineId
  const pool = state.machines?.find(m => m.machineId === machineId)
  if (!pool || project.ownerId === pool.contributorId) return machineId
  return teamPoolOf(state, pool, live)?.machineId ?? machineId
}

/** The folder a start for [project] uses on [pool]: what admitMachineStart accepts there. */
export function projectFolder(pool: ContributedMachine, project: SwarmProject): string {
  return pool.scope === 'swarm'
    ? project.repository?.machineId === pool.machineId ? project.repository.cwd : `${pool.cwd.replace(/\/+$/, '')}/${project.id}`
    : pool.cwd
}

/**
 * A start on a Mac for another person's project, moved to the Mac's Harness Team account: its machine, and its folder in
 * place of the Mac's own for that project. Every other start is returned as it is, so the Mac's owner's own projects
 * stay with the owner's daemon, and a Mac without a team account here refuses it as before (teamWorkCheck).
 */
export function teamStartRequest(state: SuperTabState, request: AgentStartRequest, project: SwarmProject, idle = false,
  live?: readonly string[]): AgentStartRequest {
  const machineId = teamMachineFor(state, request.machineId, project, idle, live)
  if (machineId === request.machineId) return request
  const pool = state.machines!.find(m => m.machineId === request.machineId)!, team = state.machines!.find(m => m.machineId === machineId)!
  return { ...request, machineId, cwd: request.cwd === projectFolder(pool, project) ? projectFolder(team, project) : request.cwd }
}

/** Refuses with the refusal's code and sentence: 403, or 409 like any start on an offline machine. */
export function failTeamWork(refusal: TeamWorkRefusal, after = ''): never {
  fail(refusal.code, `${refusal.reason}${after}`, refusal.code === 'MACHINE_OFFLINE' ? 409 : 403)
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
    } else target.downSince = downSince(state, target, now) ?? new Date(now).toISOString()
  }
}

export function machineContribution(state: SuperTabState, machineId: string) {
  const pool = state.machines?.find(m => m.machineId === machineId)
  if (!pool) return null
  const contributor = person(state, pool.contributorId)
  if (contributor.role === 'viewer' || contributor.generation !== pool.membershipGeneration) {
    fail('CONTRIBUTION_REVOKED', 'This machine contribution was withdrawn.', 403)
  }
  return pool
}

/** A machine is its owner's to remove: whoever contributed it, or, for a machine with only shared agents, whoever
 *  contributed all of them. Not the Swarm owner (spec 2026-10-23-remove-machine.md, decision 1). */
export function ownedMachine(state: SuperTabState, actor: Actor, machineId: string) {
  const pool = state.machines?.find(m => m.machineId === machineId)
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
  return {
    blockedBy: led ? { projectId: led.id, projectName: led.name } : null,
    agents: members.map(a => {
      const task = state.conversations.find(c => activeWork(c) && c.assignment!.agentId === a.id)
      return { id: a.id, name: a.displayName ?? a.name, projectName: projectsOf(state).find(p => p.id === agentProjectId(state, a))?.name ?? '',
        ...(task ? { task: task.title } : {}) }
    }),
    // Their code is only on this machine: no other machine can start agents for them until someone shares a repository.
    soleSourceProjects: projectsOf(state).filter(p => p.repository?.machineId === machineId && !p.repository.repositoryUrl).map(p => ({ id: p.id, name: p.name })),
  }
}

/** No reading yet, or one older than three missed beats: the machine Desktop shows as offline, and the one a start
 *  is refused on. Nothing is written while a machine is silent, so this is read from the last reading itself. */
export function machineOffline(pool: ContributedMachine, now: number): boolean {
  return !pool.observation || now - pool.observation.receivedAt > MACHINE_FRESH_MS
}

/** A removal its host cannot acknowledge (offline) or has not acknowledged in a day: the machine's records go, and the
 *  cleanup waits for its host on its next connection. */
export function expireRemoval(state: SuperTabState, pool: ContributedMachine): void {
  (state.machineCleanups ??= []).push({ machineId: pool.machineId, removalId: pool.removal!.id, machineOwnerId: pool.contributorId })
  state.machines = state.machines!.filter(m => m !== pool)
}

export function expireRemovals(state: SuperTabState, now: number): void {
  for (const pool of state.machines?.filter(m => m.removal
    && (machineOffline(m, now) || now - Date.parse(m.removal.requestedAt) >= REMOVAL_FALLBACK_MS)) ?? []) {
    expireRemoval(state, pool)
  }
}

/** Pending intents reserve slots too. Only an explicit host stop frees a launched slot. A Mac and its Harness Team account
 *  share the Mac's slots (One machine, teamStartRequest): each counts what runs on both. */
export function machineSlots(state: SuperTabState, pool: ContributedMachine) {
  const mac = pool.hostMachineId ? state.machines?.find(m => m.machineId === pool.hostMachineId && m.contributorId === pool.contributorId) : pool
  const team = mac && teamPoolOf(state, mac)
  return [...new Set([pool, mac, team])].reduce((sum, each) => sum + (each ? poolSlots(state, each) : 0), 0)
}

function poolSlots(state: SuperTabState, pool: ContributedMachine) {
  const reservations = (state.harnessReservations ?? []).filter(r => r.machineId === pool.machineId)
  const live = new Set(reservations.map(r => r.harnessId))
  const released = (state.releasedHarnesses ?? []).filter(r => r.machineId === pool.machineId && !live.has(r.harnessId)).map(r => r.harnessId)
  const observed = pool.observation?.stoppedHarnessIds ?? []
  const stopped = new Set([...observed.filter(id => {
    const reservation = reservations.find(r => r.harnessId === id)
    // Older hosts can prove a first launch stopped, but cannot distinguish a resumed runtime from its predecessor.
    return !reservation || !reservation.renewed || pool.observation?.stoppedReservations?.some(r => r.harnessId === id && r.generation === reservation.generation)
  }), ...released])
  const running = new Set((pool.observation?.runningHarnessIds ?? []).filter(id => !stopped.has(id)))
  for (const a of state.agents) if (a.machineId === pool.machineId && !stopped.has(a.harnessId)) running.add(a.harnessId)
  for (const r of reservations) if (!stopped.has(r.harnessId)) running.add(r.harnessId)
  let pending = 0
  for (const start of state.starts ?? []) {
    if (start.request.machineId !== pool.machineId || start.error) continue
    if (start.harnessId) { if (!stopped.has(start.harnessId)) running.add(start.harnessId) }
    else pending++
  }
  return running.size + pending
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
  return (state.machines ?? []).flatMap(m => !m.observation || now - m.observation.receivedAt > MACHINE_FRESH_MS ? []
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

/** `teamMachines`: the tab's machines whose account row is signed in as a team account, read by the store. A start is
 *  admitted again when its host launches it, so a Team machine whose check failed or went stale since never launches it. */
export function admitMachineStart(state: SuperTabState, request: AgentStartRequest, now: number, start?: AgentStart, teamMachines: readonly string[] = []) {
  const pool = machineContribution(state, request.machineId)
  if (!pool) return null
  if (pool.removal) fail('MACHINE_REMOVED', 'This machine is being removed from the Swarm.')
  if (start && start.poolGeneration !== pool.generation) fail('CONTRIBUTION_REVOKED', 'This machine contribution changed. Reconcile the original start.', 403)
  if (pool.paused) fail('MACHINE_PAUSED', 'New work is paused on this machine.')
  const project = groupProject(state, conversation(state, request.conversationId))
  if (!pool.scope && project.id !== 'lead') fail('PROJECT_CONTRIBUTION', 'Ask its owner to add this machine to the swarm again to support other projects.')
  // Before the request's own fields: a machine that takes none of this project's work says so first.
  requireTeamWork(state, pool.machineId, pool.contributorId, project, now, teamMachines)
  const cwd = projectFolder(pool, project)
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
  if (request.permissionMode !== undefined && request.permissionMode !== 'full') {
    refused.push('permissionMode (only full is accepted; leave it out to use the machine’s default)')
  }
  if (refused.length) {
    fail('OUTSIDE_CONTRIBUTION', `${pool.name} accepts only its contributed project folder, engines and default account settings, with full permissions for Swarm agents. Refused: ${refused.join('; ')}.`, 403)
  }
  if (machineOffline(pool, now)) fail('MACHINE_OFFLINE', 'Wait for a fresh reading from the contributed machine.')
  if (!start && machineSlots(state, pool) >= pool.maxAgents) fail('MACHINE_FULL', 'This machine has reached its contributed agent limit.')
  return pool
}
