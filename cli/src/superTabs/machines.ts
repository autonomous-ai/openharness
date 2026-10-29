import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { lstat, readdir, readFile, realpath, rm, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { CoreApi } from '../core/api.js'
import { openDaemon } from '../agentClient/daemon.js'
import { codingRefusal } from '../lib/codingModel.js'
import { backend, identifier, object, SuperTabHostError } from './wire.js'
import type { SwarmSources } from './host.js'
import { HostFeed } from './hostFeed.js'
import { SwarmReads } from './swarmReads.js'
import { readCapabilities, quotaOf, meteredEngine, quotaUnknownReason } from './capacity.js'
import { startAgent, type ScopedRequest } from './start.js'
import { prepareSwarmStart } from './projectFolder.js'
import { readAuthSession } from '../lib/authSession.js'
import { createSwarmCloneTrustRepair, swarmCloneRoots } from './cloneTrust.js'
import { git, sweepOne } from '../lib/worktreeSweep.js'
import { projectsRoot } from '../lib/projectFolder.js'
import { worktreeFolderName } from '../lib/agentNames.js'
import { teamPrivacyObserver } from '../team/observer.js'
import { teamRelayed } from '../team/relay.js'
import type { PrivacyObservation } from '../team/privacy.js'
import { repositoryKey } from './route.js'
import { usageTarget, validModelTokens, validUsageTarget, type ModelTokens } from '../lib/agentUsageWire.js'

const finite = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v : null
const list = (v: unknown) => Array.isArray(v) ? v.map(object) : []
// The route's requirements are not known before the Lead routes. Include common tools in each snapshot, then
// include tools from pending starts. An uncommon tool first named during routing remains unverified and is refused.
const COMMON_TOOLS = ['git', 'node', 'npm', 'flutter', 'gh', 'cargo', 'python3']
const VERIFIED_TOOL_TTL_MS = 10 * 60_000
/** After a backend refuses a new field (privacy, from before the Harness Team account; harnessProgress, from before
 *  task leases), how long the reading goes without it before the field is offered again: a backend deployed meanwhile
 *  is heard from within this long. */
const FIELD_REFUSED_MS = 10 * 60_000
const UNVERIFIED_TOOL_TTL_MS = 60_000
/** How long a session's folder stands as clean or not before git is asked again: a minute bounds the work to one
 *  `git status` per running session a minute, and the backend stops an idle worker only on a report under 2 minutes old. */
const UNCOMMITTED_TTL_MS = 60_000
/** How long a folder whose session's screen has not changed stands before git reads it again: an agent changes its files
 *  while it works, and its screen changes with them. git status one folder after another took 20 s a pass for the Mac
 *  Studio's 29 worktrees (2026-10-28), most of them idle. Ten minutes still re-reads well inside the 15 idle minutes after
 *  which the backend stops a clean worker (backend superTabs/tidy.ts), for a folder changed by someone else. */
const UNCOMMITTED_IDLE_TTL_MS = 10 * 60_000
/** How many session folders git reads at once. */
const UNCOMMITTED_PARALLEL = 4
/** How long into one pass the last reading is still sent again on the beat. Past it the daemon is taken as stuck, and the
 *  machine is left to show as offline rather than kept healthy by a loop that no longer reads anything. */
const BEAT_LIMIT_MS = 3 * 60_000
/** How long this machine refuses a start before failing it with its reason, so the Lead starts it elsewhere: a minute of
 *  busy CPU or memory may pass, and routing saw this machine able a moment ago. A refusal no one reported left starts
 *  "Queued" for hours (DESKTOP-0TFH0OJ, 2026-10-23). */
const START_REFUSED_MS = 60_000
/** What a start answers while its launch may already have happened or is under way: never failed from here, or an agent
 *  could run with no start to show for it. The failures already reported say so themselves. */
const NOT_REFUSED = new Set(['START_UNCERTAIN', 'START_PENDING', 'START_REFUSED', 'START_FAILED', 'SWARM_ENGINE'])

/** How often the executor asks the backend what its tabs want of it (a start waiting, a pause) and compares what it
 *  would report with what it last did. Only this read is this frequent: the resource readers run when there is
 *  something to say. A start waits at most this long, plus the host's one-second tick, to be picked up. */
export const MACHINE_POLL_MS = 5_000
/** How long an observation stands before it is sent again unchanged, so the Desktop can tell a machine that is
 *  silent from one that has nothing new (its offline threshold is counted in these beats). */
export const MACHINE_HEARTBEAT_MS = 15_000
/** How old a host form this pass may take: the host reads one every second, so a pass beside it reads nothing itself. */
const POOLS_FRESH_MS = 2_000

/** The worktrees this machine's Swarm starts made, by tab: what a removal may delete besides the tab's Swarm folders. */
export const swarmWorktreesFile = (dataDir: string, machineId: string) => join(dataDir, 'super-tabs', `swarm-worktrees-${machineId}.json`)
type SwarmWorktree = { tabId: string; startId: string; harnessId: string; source: string; path: string }
function readWorktrees(file: string): SwarmWorktree[] {
  let saved: unknown
  try { saved = JSON.parse(readFileSync(file, 'utf8')) } catch { return [] }
  const rows = object(saved).worktrees
  return (Array.isArray(rows) ? rows.map(object) : []).filter(w => [w.tabId, w.startId, w.harnessId].every(identifier)
    && typeof w.source === 'string' && isAbsolute(w.source) && typeof w.path === 'string' && isAbsolute(w.path)) as unknown as SwarmWorktree[]
}
function writeWorktrees(file: string, worktrees: SwarmWorktree[]) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  writeFileSync(`${file}.next`, JSON.stringify({ version: 1, worktrees }), { mode: 0o600, flush: true })
  renameSync(`${file}.next`, file)
}
const within = (parent: string, path: string) => {
  const rel = relative(resolve(parent), resolve(path))
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}
/** Whether `path` is the worktree a Swarm start made from `source`: in Harness's worktrees folder, named for that start
 *  (start.ts names its branch super-tab/<start>; a taken name gets -2, -3), and still a linked worktree of `source`'s
 *  repository. A person's own worktree, of the same repository or in the same folder, or one at the path now, is not.
 *  The agent's registry folder alone is not proof: it can change after the launch. */
async function swarmWorktree(path: string, source: string, startId: string): Promise<boolean> {
  try {
    const real = await realpath(path), home = await realpath(join(projectsRoot(), 'worktrees'))
    const leaf = worktreeFolderName(`super-tab/${startId}`), name = basename(real)
    if (!within(home, real) || real === home || (name !== leaf && !/^\d+$/.test(name.startsWith(`${leaf}-`) ? name.slice(leaf.length + 1) : ''))) return false
    if (within(path, source) || !(await lstat(join(path, '.git'))).isFile()) return false
    const gitdir = /^gitdir: (.+)$/m.exec(await readFile(join(path, '.git'), 'utf8'))?.[1]?.trim()
    if (!gitdir) return false
    const common = (await git(source, ['rev-parse', '--git-common-dir'])).trim()
    return dirname(await realpath(resolve(path, gitdir))) === join(await realpath(resolve(source, common)), 'worktrees')
  } catch { return false }
}

export interface MachineDeps {
  backend: typeof backend; open: typeof openDaemon; capabilities: typeof readCapabilities; start: typeof startAgent; now: () => number
  log?: (message: string) => void; env?: NodeJS.ProcessEnv
  /** Readies a queued start before its agent is created (superTabs/projectFolder.ts `prepareSwarmStart`): whom the
   *  work is for when it uses the Harness GitHub App, else null. */
  prepare?: (core: CoreApi, row: Record<string, unknown>, start: Record<string, unknown>) => Promise<{ requester: string } | null | void>
  /** Whether this daemon runs team work only (a Harness Team account, `harness team on`): it has no git login of its own. */
  team?: () => boolean
  /** The Harness Team account's privacy check (team/privacy.ts): null for the owner's own daemon. */
  privacy?: () => PrivacyObservation | null
  /** What says this machine's Swarm models changed, read every pass without asking the daemon ([localModelsStamp]). */
  modelsStamp?: () => Promise<string>
  /** The machine's host form and Swarm reads, shared with its host (superTabs/host.ts). */
  sources?: SwarmSources
  /** git for the readiness of the Swarm folder's checkouts ([quietGit]). */
  git?: GitRun
  /** How long a cleanup waits for the agent starts already running in its Swarm ([CLEANUP_WAIT_MS]). */
  cleanupWaitMs?: number
  /** When each of these harnesses' screens last changed, epoch ms (superTabs/terminal.ts `progressOf`): the backend
   *  renews a task's lease from it, so work never sits with a dead owner (docs: swarm-never-stops). */
  progress?: (harnessIds: readonly string[]) => Record<string, number>
  /** In the Harness Team account: whether its engines can spend the owner's subscription through the owner's relay
   *  (team/relay.ts), so one it has not signed in itself is ready all the same. */
  relayed?: () => boolean
}
const MACHINE_DEPS = { backend, open: openDaemon, capabilities: readCapabilities, start: startAgent, now: Date.now }
/** A start's folder preparation can clone a whole repository; past this, its cleanup gives up and tries again later. */
const CLEANUP_WAIT_MS = 10 * 60_000
const CLEANING_WAIT = 'Waiting for this machine to finish cleaning up this Swarm.'

/** Separate from chat delivery: slow resource readers and agent launches never
 * hold up a delivery lease. Only a tab's explicit owner grant wakes this queue. */
/** A pool's starts this host launches: its agents', and its Buddies', which the backend lists apart so that a host from before
 *  Buddies never launches one as a Builder (backend read/hostRows.ts). */
/** A host's starts: its workers', and its Buddies' and Product Managers', which the backend lists apart so that a host from
 *  before them never launches one as a worker. */
const startsOf = (row: Record<string, unknown>) => [...list(row.starts), ...list(row.buddyStarts), ...list(row.leadStarts)]
/** What this host launches beyond workers, said in its reading (backend leadStart.ts): a project's Product Manager. */
const CAPABILITIES = ['leadStart']
/** The backend's answer that this machine may no longer act in the Swarm: signed out, its contribution revoked or its host
 *  unavailable (backend store.ts observeMachine), or the Swarm gone. */
const lostAccess = (error: unknown) => error instanceof SuperTabHostError && [401, 403, 404].includes(error.status)

export class ContributedMachines {
  private stopped = false
  private running: Promise<void> | null = null
  private next = 0
  /** A pass or one of its publishes failed: the next one waits a whole beat, as every pass once did. */
  private failed = false
  private readonly cursors = new Map<string, number>()
  private repairTrust?: ReturnType<typeof createSwarmCloneTrustRepair>
  /** Per tab, when its observation was last sent and what it said that matters to a reader: the harnesses
   *  running and stopped, whether new work is paused, and which starts are waiting. A change in any of them is
   *  sent at once; otherwise the heartbeat keeps the reading fresh. */
  private readonly published = new Map<string, { at: number; signature: string; starting?: boolean }>()
  /** Per tab, the reading the backend last took and when it or a re-send of it last went: what [beat] sends again. */
  private readonly lastSent = new Map<string, { path: string; body: Record<string, unknown>; at: number }>()
  /** When the pass in flight began, or null between passes. */
  private passBegan: number | null = null
  /** The re-sends in flight, which a pass waits for before it sends a newer reading: a re-send that landed after it would
   *  put the older one back. */
  private beating: Promise<void> | null = null
  /** The tabs whose new reading the pass is sending: no re-send of the older one starts meanwhile. */
  private readonly sending = new Set<string>()
  /** Shell tool availability belongs to this machine, not a tab. Resource readings still refresh every heartbeat. */
  private readonly toolCache = new Map<string, { value: boolean | null; detail?: string; until: number }>()
  /** Per waiting start, why it was last not started, so the log says it once per reason, not every pass. */
  private readonly waiting = new Map<string, string>()
  /** Per tab, why its last reading did not reach the backend, so the log says it once per error and once when it clears. */
  private readonly readingFailures = new Map<string, string>()
  /** Per waiting start, since when this machine has refused it without a break. */
  private readonly refusedSince = new Map<string, number>()
  /** The starts this machine launched whose creation the daemon is still carrying out (fetch, worktree, engine), as its
   *  last pass found them. Reported so the backend waits past its 3 minutes (backend liveness.ts): Diego's Mac fetched and
   *  checked out a 470 MB project, and the start failed while it did (2026-10-27). */
  private readonly preparing = new Set<string>()
  /** Starts this host launched whose engine has not yet recorded its session: the agent each created, by start id. */
  private readonly unconfirmed = new Map<string, Unconfirmed>()
  /** Removals cleaned and acknowledged by this host, and the one in progress per removal. */
  private readonly cleaned = new Set<string>()
  private readonly cleaning = new Map<string, Promise<void>>()
  /** One lock per Swarm between its cleanups and its starts (second review of #1991: a start wrote into a clone the
   *  cleanup then deleted; review of #2004: a start that passed the check launched after a cleanup began). A cleanup
   *  marks its Swarm for its whole run, then waits for the starts already in flight there; a start checks the mark and
   *  joins the starts in flight in one step, with no wait between, and stays until its launch is done. A start that finds
   *  the mark waits for a later pass, so a pass is never held up and this machine keeps reporting. */
  private readonly cleaningTabs = new Map<string, number>()
  private readonly startsInFlight = new Map<string, Set<Promise<void>>>()
  /** Per removal whose cleanup or acknowledgement failed, how often and when it may run again. */
  private readonly cleanupRetries = new Map<string, { failures: number; at: number }>()
  /** Until when the reading leaves out its privacy field, which the backend refused. */
  private privacyRefusedUntil = 0
  /** Until when the reading leaves out its progress, which the backend refused. */
  private progressRefusedUntil = 0
  private tokensRefusedUntil = 0
  private uncommittedRefusedUntil = 0
  /** Per running session, whether its folder had uncommitted changes when last read, and until when that stands. */
  private readonly uncommittedCache = new Map<string, { cwd: string; dirty: boolean; until: number; readAt: number; shown?: number }>()
  /** Whether git is reading session folders beside the pass now. */
  private uncommittedReading = false
  /** Until when the reading leaves out its readiness field, which the backend refused. */
  private readinessRefusedUntil = 0
  /** Until when the reading leaves out the starts it is preparing, which the backend refused. */
  private preparingRefusedUntil = 0
  /** Whether each engine is installed and signed in, and until when that stands: one probe starts login shells and reads
   *  the engines' accounts, so it runs every [READINESS_MS] (a failed one again after [READINESS_RETRY_MS]). */
  private engineRead: { value: ReadyEngine[] | null; until: number } | null = null
  /** The account reader's last answer, when it was read and until when it stands ([USAGE_FRESH_MS] and the rest). */
  private usageRead: { value: Record<string, unknown>; at: number; until: number } | null = null
  /** Per engine, its last readable allowance windows and when they were read, kept [USAGE_KEEP_MS] through failed reads. */
  private readonly goodQuota = new Map<string, { windows: ReturnType<typeof quotaOf>['windows']; at: number }>()
  /** Until when the reading leaves out why an allowance is unknown, which the backend refused. */
  private quotaReasonsRefusedUntil = 0
  /** Per Swarm folder, its checkouts' readiness and until when it stands, and the folders being read now. A push check
   *  asks the remote, so it is read beside the pass, never holding up a start. */
  private readonly checkoutReads = new Map<string, { value: ReadyCheckout[] | null; until: number }>()
  private readonly checkoutReading = new Set<string>()
  private async engineReadiness(local: { request: (type: string, payload: Record<string, unknown>, timeoutMs: number) => Promise<unknown> }): Promise<ReadyEngine[] | null> {
    const now = this.deps.now()
    if (this.engineRead && now < this.engineRead.until) return this.engineRead.value
    const answer = await local.request('engines_probe', { engines: ['claude', 'codex'], accounts: true }, 20_000).catch(() => null)
    const engines = object(answer).engines
    // An engine that says nothing of its sign-in (an older daemon, an engine not installed) is unknown, never signed out.
    // Not installed is unknown too: the probe answers the same for a login shell that timed out (lib/engineProbe.ts), and
    // such a machine fails its first start loudly instead (review of #1743).
    // A Harness Team account that has not signed an engine in spends its owner's subscription through the owner's relay
    // (team/relay.ts): the Lead routed nothing to it while it read as signed out (routeCommand.ts `unreadyPool`).
    const relayed = (this.deps.relayed ?? teamRelayed)()
    const value = Array.isArray(engines) ? list(engines).filter(e => e.engine === 'claude' || e.engine === 'codex')
      .map((e): ReadyEngine => ({ engine: String(e.engine), installed: e.installed === true ? true : null,
        signedIn: e.installed === true && typeof e.signedIn === 'boolean' ? e.signedIn || relayed : null })) : null
    this.engineRead = { value, until: now + (value ? READINESS_MS : READINESS_RETRY_MS) }
    return value
  }
  /** The account reader's answer, read again only once the last one is [USAGE_FRESH_MS] old: sooner, and Anthropic refuses
   *  the reads for 5 minutes. A refused or failed read is not repeated sooner than its own wait. */
  private async allowance(local: { request: (type: string, payload: Record<string, unknown>, timeoutMs: number) => Promise<unknown> }) {
    const now = this.deps.now()
    if (this.usageRead && now < this.usageRead.until) return this.usageRead
    const value = object(await local.request('usage_read', {}, 20_000).catch(() => null))
    const providers = list(value.providers)
    const wait = !Array.isArray(value.providers) ? USAGE_RETRY_MS
      : providers.some(p => p.outcome === 'answered' && p.httpStatus === 429) ? USAGE_LIMITED_MS : USAGE_FRESH_MS
    return this.usageRead = { value, at: now, until: now + wait }
  }
  /** What the reading says of [engine]'s allowance. Windows that could not be read again stand for [USAGE_KEEP_MS] after
   *  they were read, unless the engine signed out; past that, unknown says why. */
  private quotaFor(read: { value: Record<string, unknown>; at: number }, engine: string) {
    const q = quotaOf(read.value, engine, false)
    if (q.known) { this.goodQuota.set(engine, { windows: q.windows, at: read.at }); return { engine, known: true, windows: q.windows } }
    // Windows that could not be read on an API key are metered: known, with none (route.ts quotaOf2).
    if (meteredEngine(engine, this.deps.env ?? process.env)) return { engine, known: true, windows: [] }
    if (list(read.value.providers).find(p => p.provider === engine)?.outcome === 'signedOut') this.goodQuota.delete(engine)
    const kept = this.goodQuota.get(engine)
    if (kept && this.deps.now() - kept.at <= USAGE_KEEP_MS) return { engine, known: true, windows: kept.windows }
    return { engine, known: false, windows: [], reason: quotaUnknownReason(read.value, engine, (this.deps.relayed ?? teamRelayed)()) ?? undefined }
  }
  /** The last readiness of [root]'s checkouts, reading them again beside the pass once it is [READINESS_MS] old. Null
   *  until the first read is in. */
  private checkoutReadiness(root: string): ReadyCheckout[] | null {
    const read = this.checkoutReads.get(root)
    if ((!read || this.deps.now() >= read.until) && !this.checkoutReading.has(root)) {
      this.checkoutReading.add(root)
      void readCheckouts(root, this.deps.git ?? quietGit)
        // A folder whose probe failed is left out and read again a minute later, not taken for ten.
        .then(({ checkouts, unsure }) => { this.checkoutReads.set(root, { value: checkouts, until: this.deps.now() + (unsure ? READINESS_RETRY_MS : READINESS_MS) }) }, error => {
          // An unreadable folder says nothing, and is read again a minute later, not on every pass.
          this.checkoutReads.set(root, { value: null, until: this.deps.now() + READINESS_RETRY_MS })
          this.log(`Could not read the Swarm folder's checkouts: ${error instanceof Error ? error.message : String(error)}`)
        })
        .finally(() => this.checkoutReading.delete(root))
    }
    return read?.value ?? null
  }
  /** This pass's privacy reading, read once a pass (the check itself runs at most every five minutes). */
  private privacy(): PrivacyObservation | null {
    try { return (this.deps.privacy ?? teamPrivacyObserver)() } catch (error) {
      // A check that could not run is not a pass: a team account reports it unchecked, never private.
      return { mode: 'account', passed: false, item: 'unchecked', detail: `The privacy check did not run: ${error instanceof Error ? error.message : String(error)}`, checkedAt: this.deps.now() }
    }
  }
  /** The grids this machine reads, at most once a minute: every Swarm's reading shares it. */
  private gridModelsRead: { at: number; answer: unknown } | null = null
  private async gridModels(local: { request: (type: string, payload: Record<string, unknown>, timeoutMs: number) => Promise<unknown> }): Promise<unknown> {
    const now = this.deps.now()
    if (this.gridModelsRead && now - this.gridModelsRead.at < GRID_MODELS_MS) return this.gridModelsRead.answer
    const answer = await local.request('grid_models_list', { rowState: true }, 20_000).catch(() => ({}))
    // A failed read is asked again next time, not held for a minute as "nothing shared".
    if (Array.isArray(object(answer).grids)) this.gridModelsRead = { at: now, answer }
    return answer
  }
  private readonly deps: MachineDeps
  private readonly sources: SwarmSources
  constructor(private readonly core: CoreApi, private readonly machineId: string, deps: Partial<MachineDeps> = {}) {
    this.deps = { ...MACHINE_DEPS, ...deps }
    this.sources = deps.sources ?? { feed: new HostFeed(core, machineId, { now: this.deps.now, backend: this.deps.backend }),
      reads: new SwarmReads(core, { backend: this.deps.backend }) }
  }
  stop() { this.stopped = true }
  /** DESKTOP-0TFH0OJ, 2026-10-23: every Claude start there was refused (CLI 0.4.57 took an API-key Claude for one not
   *  signed in) and the refusal was dropped, so two starts stayed "Queued" for hours with nothing in the log. */
  private noteWaiting(startId: string, reason: string) {
    if (this.waiting.get(startId) === reason) return
    this.waiting.set(startId, reason)
    this.log(`Swarm start ${startId} is waiting: ${reason}`)
  }
  /** Diego's Mac, 2026-10-28: 410 reading timeouts in two days, none of them in the log. */
  private noteReading(tabId: string, error: unknown) {
    const was = this.readingFailures.get(tabId)
    if (error === null) {
      if (was !== undefined) { this.readingFailures.delete(tabId); this.log(`This machine's reading reached Swarm ${tabId} again.`) }
      return
    }
    const reason = error instanceof Error ? error.message : String(error)
    if (was === reason) return
    this.readingFailures.set(tabId, reason)
    this.log(`Could not send this machine's reading to Swarm ${tabId}: ${reason}`)
  }
  /** One pass at a time, one [MACHINE_POLL_MS] after the last began (or a beat after one that failed). */
  tick(): Promise<void> {
    if (this.stopped || this.deps.now() < this.next) return Promise.resolve()
    const began = this.deps.now()
    if (!this.running) this.passBegan = began
    return this.running ??= this.poll(began).catch(error => { this.failed = true; throw error }).finally(() => {
      this.running = null
      this.passBegan = null
      const done = this.deps.now()
      this.next = this.failed ? done + MACHINE_HEARTBEAT_MS : Math.max(began + MACHINE_POLL_MS, done + 1_000)
      this.failed = false
    })
  }
  /**
   * Called every second beside [tick]: while a pass is slow (git, a launch, a slow backend), each tab's last reading is
   * sent again once nothing has gone for a heartbeat, so the machine never reads as offline, and its agents as Down, only
   * because its pass is busy (the Mac Studio, 2026-10-28). It reads nothing itself, and sends what the backend already
   * holds: no extra report, only a late one filled in. Never past [BEAT_LIMIT_MS] into a pass, so a stuck daemon still
   * shows as offline. Whether a folder has uncommitted changes is left out: only a fresh read vouches for stopping a
   * worker (backend superTabs/tidy.ts).
   */
  beat(): void {
    const began = this.passBegan
    if (this.stopped || this.beating || began === null) return
    const now = this.deps.now()
    if (now - began >= BEAT_LIMIT_MS) return
    const due = [...this.lastSent].filter(([tab, sent]) => !this.sending.has(tab) && now - sent.at >= MACHINE_HEARTBEAT_MS)
    if (!due.length) return
    this.beating = (async () => {
      for (const [, sent] of due) {
        // A failed one waits a whole beat too, rather than being asked again every second.
        sent.at = now
        try { await this.deps.backend(this.core, 'POST', sent.path, sent.body) }
        catch (error) { this.log(`Could not send this machine's reading again: ${error instanceof Error ? error.message : String(error)}`) }
      }
    })().finally(() => { this.beating = null })
  }
  private async poll(began: number) {
    const where = { dataDir: this.core.dataDir, port: this.core.daemon.port, machineId: this.machineId }
    const pools = list((await this.sources.feed.current(POOLS_FRESH_MS)).pools).filter(row => identifier(row.tabId) && object(row.machine).machineId === this.machineId && identifier(object(row.machine).generation))
    if (this.stopped || pools.length === 0) { this.published.clear(); this.lastSent.clear(); this.waiting.clear(); this.readingFailures.clear(); return }
    const pendingIds = new Set(pools.flatMap(row => startsOf(row).map(start => start.id)))
    for (const id of this.waiting.keys()) if (!pendingIds.has(id)) this.waiting.delete(id)
    for (const id of this.refusedSince.keys()) if (!pendingIds.has(id)) this.refusedSince.delete(id)
    for (const id of this.preparing) if (!pendingIds.has(id)) this.preparing.delete(id)
    for (const [id, launch] of this.unconfirmed) if (!pendingIds.has(id) && !launch.checking) void this.abandoned(id, launch)
    for (const tab of this.published.keys()) if (!pools.some(row => row.tabId === tab)) this.published.delete(tab)
    for (const tab of this.lastSent.keys()) if (!pools.some(row => row.tabId === tab)) this.lastSent.delete(tab)
    for (const tab of this.readingFailures.keys()) if (!pools.some(row => row.tabId === tab)) this.readingFailures.delete(tab)
    const privacy = this.privacy()
    // A model run or stopped for a Swarm, or an API shared with it, is sent on this pass, not on the next beat: the
    // machine's panel waited up to 15 s more for it (2026-10-26). Files only, so a pass with nothing new asks nobody.
    const modelsStamp = pools.some(row => typeof row.localGrid === 'string')
      ? await (this.deps.modelsStamp ?? (() => localModelsStamp(this.core.dataDir, this.deps.env ?? process.env)))().catch(() => '') : ''
    // The local daemon is reached only for a reading to send, never for a pass that has nothing to say.
    let local: Awaited<ReturnType<typeof openDaemon>> | null = null
    let usage: { value: Record<string, unknown>; at: number } | null = null
    try {
      for (const row of pools) {
        try {
        if (this.stopped || !identifier(row.tabId)) return
        const pool = object(row.machine)
        if (!identifier(pool.generation) || pool.machineId !== this.machineId || typeof pool.cwd !== 'string') continue
        const ids = Array.isArray(row.harnessIds) ? row.harnessIds.filter(identifier) : []
        const stopped: string[] = []
        // A stopped agent keeps a saved record; one closed by hand or whose session crashed away is kept nowhere (`gone`).
        // Both are reported, so the backend hands its task on at once rather than when its lease runs out. Only one the
        // registry no longer lists is asked about, so a pass costs no more for the agents that run.
        for (const id of ids) {
          if (await this.core.agents.stopped?.(id) || (!this.core.agents.byAgent(id) && await this.core.agents.gone?.(id))) stopped.push(id)
        }
        const running = ids.filter(id => !!this.core.agents.byAgent(id) && !stopped.includes(id))
        const pending = startsOf(row)
        const preparing = began >= this.preparingRefusedUntil ? pending.flatMap(start => this.preparing.has(String(start.id)) ? [String(start.id)] : []) : []
        const tools = [...new Set([...COMMON_TOOLS, ...pending.flatMap(start => {
          const wanted = object(object(start.request).requirements).tools
          return Array.isArray(wanted) ? wanted.filter((name): name is string => typeof name === 'string' && /^[A-Za-z0-9_.+-]{1,80}$/.test(name)) : []
        })])].slice(0, 20)
        const signature = JSON.stringify([row.reservations, pool.generation, [...running].sort(), [...stopped].sort(), row.paused === true || pool.paused === true,
          pending.map(start => start.id).sort(), [...preparing].sort(),
          // A privacy result that changes (a home folder opened again) is sent at once, not on the next beat.
          privacy ? [privacy.mode, 'passed' in privacy ? privacy.passed : null, 'item' in privacy ? privacy.item : null] : null,
          typeof row.localGrid === 'string' ? modelsStamp : null])
        const last = this.published.get(String(row.tabId))
        // A model still starting is read again every pass until the grid lists it, so the panel shows it live at once.
        if (!last || last.signature !== signature || last.starting || began - last.at >= MACHINE_HEARTBEAT_MS) {
        try {
        local ??= await this.deps.open(where)
        // Raw responses and account credentials never leave this machine.
        const readings = usage ??= await this.allowance(local)
        const sampledAt = this.deps.now()
        const probeTools = tools.filter(name => (this.toolCache.get(name)?.until ?? 0) <= sampledAt)
        const observed = await this.deps.capabilities({ cwd: pool.cwd, tools: probeTools, devices: [] })
        if (this.stopped) return
        const resources = object('resources' in observed ? observed.resources : null)
        const gpus = list(resources.gpus).map(g => finite(g.utilizationPercent)).filter((n): n is number => n !== null)
        const measuredTools = object('tools' in observed ? observed.tools : null)
        const measuredErrors = object('toolProbeErrors' in observed ? observed.toolProbeErrors : null)
        for (const name of probeTools) {
          const value = typeof measuredTools[name] === 'boolean' ? measuredTools[name] as boolean : null
          const detail = value === null ? String(measuredErrors[name] ?? 'The tool probe did not complete.') : undefined
          this.toolCache.set(name, { value, detail, until: sampledAt + (value === null ? UNVERIFIED_TOOL_TTL_MS : VERIFIED_TOOL_TTL_MS) })
        }
        const reportedTools: Record<string, boolean> = {}, toolProbeErrors: Record<string, string> = {}
        for (const name of tools) {
          const result = this.toolCache.get(name)
          if (result?.value !== null && result?.value !== undefined) reportedTools[name] = result.value
          else toolProbeErrors[name] = result?.detail ?? 'The tool probe did not complete.'
        }
        const listedEngines = Array.isArray(pool.engines) ? pool.engines.filter((engine): engine is string => typeof engine === 'string') : []
        const supported = (engine: string) => engine === 'claude' || engine === 'codex'
        // Older contributions may name only OpenCode or another retired Swarm engine. Probe this host so their
        // replacement choices reflect the engines actually installed here, without changing the owner's slot limit.
        const engines = listedEngines.some(engine => !supported(engine))
          ? list(object(await local.request('engines_probe', { engines: ['claude', 'codex'] }, 20_000).catch(() => ({}))).engines)
            .filter(engine => supported(String(engine.engine)) && engine.installed === true).map(engine => String(engine.engine))
          : listedEngines.filter(supported)
        // Only while the owner has the Local models add-on on: the models this machine serves on the Swarm's grid (its own
        // engines, the APIs it shares), then the ones shared with its owner that they offer to this Swarm (usable here alone).
        // What this machine serves there counts only while the Swarm's grid lists it: the grid can lose a model this
        // machine still thinks it shares, and a Builder sent to one waits without end (lib/swarmHeal.ts, which also joins
        // it again). Unknown — the grid could not be read — keeps the reading as it is.
        const live = typeof row.localGrid === 'string'
          ? liveOn(await local.request('grid_swarm_heal', { grid: row.localGrid }, 30_000).catch(() => ({}))) : null
        // Not yet listed by the grid (a start or a share still registering): sent as starting, which the panel shows and
        // the route never offers, rather than left out until the grid lists it.
        const marked = (m: LocalModelReading): LocalModelReading => !live || live.has(m.model) ? m : { ...m, starting: true }
        const fleet = typeof row.localGrid === 'string' ? await local.request('grid_fleet_models_list', {}, 20_000).catch(() => ({})) : null
        const refusedModels = typeof row.localGrid === 'string' ? refusedOn(fleet, row.localGrid) : []
        const localModels = typeof row.localGrid === 'string' ? [
          ...servedOn(fleet, row.localGrid).map(marked),
          ...apisOn(await local.request('grid_swarm_api_shares', { grid: row.localGrid }, 10_000).catch(() => ({})), row.localGrid).map(marked),
          ...offered(sharedWith(await this.gridModels(local), row.localGrid),
            await local.request('grid_swarm_offers', { grid: row.localGrid }, 10_000).catch(() => ({}))),
        ].slice(0, MAX_LOCAL_MODELS) : null
        const readyEngines = await this.engineReadiness(local)
        const checkouts = pool.scope === 'swarm' ? this.checkoutReadiness(pool.cwd) : null
        const readiness = { ...(readyEngines ? { engines: readyEngines } : {}), ...(checkouts ? { checkouts } : {}) }
        const shown = began >= this.progressRefusedUntil ? this.deps.progress?.(running) ?? {} : {}
        const progress = Object.fromEntries(running.flatMap(id => typeof shown[id] === 'number' ? [[id, shown[id]]] : []))
        const uncommitted = began >= this.uncommittedRefusedUntil ? this.uncommitted(running, began, shown) : {}
        const tokens = began >= this.tokensRefusedUntil ? await this.tokensOf(running) : {}
        const allowances = engines.map(engine => this.quotaFor(readings, engine))
        const quotaReasons = began >= this.quotaReasonsRefusedUntil
          ? Object.fromEntries(allowances.flatMap(q => 'reason' in q && q.reason ? [[q.engine, q.reason]] : [])) : {}
        // Only to a backend that asks for them (backend read/hostRows.ts): an older one refuses the field, and would refuse
        // every reading with it.
        const observation = { generation: pool.generation, tools: reportedTools, ...(Object.keys(tokens).length ? { harnessTokens: tokens } : {}),
          ...(Object.keys(quotaReasons).length ? { quotaReasons } : {}),
          ...(row.capabilitiesWanted === true ? { capabilities: CAPABILITIES } : {}),
          ...(preparing.length ? { preparingStartIds: preparing } : {}),
          ...(Object.keys(uncommitted).length ? { harnessUncommitted: uncommitted } : {}),
          ...(Object.keys(progress).length ? { harnessProgress: progress } : {}), ...(localModels ? { localModels } : {}),
          ...((readyEngines || checkouts) && began >= this.readinessRefusedUntil ? { readiness } : {}),
          ...(privacy && began >= this.privacyRefusedUntil ? { privacy } : {}),
          ...(refusedModels.length ? { refusedModels } : {}),
          ...(Object.keys(toolProbeErrors).length ? { toolProbeErrors } : {}),
          resources: { cpuPercent: finite(resources.cpuPercent), memoryUsedBytes: finite(resources.memoryUsedBytes), memoryTotalBytes: finite(resources.memoryTotalBytes),
            diskFreeBytes: finite(resources.diskFreeBytes), diskTotalBytes: finite(resources.diskTotalBytes), projectDiskFreeBytes: finite(resources.projectDiskFreeBytes), projectDiskTotalBytes: finite(resources.projectDiskTotalBytes),
            deviceType: typeof resources.deviceType === 'string' ? resources.deviceType : null,
            chip: typeof resources.chip === 'string' ? resources.chip : null, os: typeof resources.os === 'string' ? resources.os : null,
            gpuPercent: gpus.length ? Math.max(...gpus) : null },
          quotas: allowances.map(q => ({ engine: q.engine, known: q.known, windows: q.windows })), runningHarnessIds: running, stoppedHarnessIds: stopped,
          ...(Array.isArray(row.reservations) ? { stoppedReservations: list(row.reservations).filter(r => stopped.includes(String(r.harnessId))
            && identifier(r.harnessId) && identifier(r.generation)).map(r => ({ harnessId: r.harnessId, generation: r.generation })) } : {}) }
        this.sending.add(String(row.tabId))
        try {
          await this.beating
          const path = `/api/super-tabs/${row.tabId}/machines/${this.machineId}`
          const refused = (error: unknown) => error instanceof SuperTabHostError && error.status === 400 && error.code === 'VALIDATION_ERROR'
          // Older backends reject the additive fields. The newest go alone first (the starts it is preparing, uncommitted work,
          // readiness, progress, then privacy): a backend that takes everything else keeps the local models it reads. Their
          // boolean-only view still safely refuses an unverified tool, and a reading without privacy is never one a Team
          // machine passes on.
          const { quotaReasons: _reasons, ...unreasoned } = observation
          const { harnessTokens: _tokens, ...untokened } = unreasoned
          const { preparingStartIds: _preparing, ...unprepared } = untokened
          const { harnessUncommitted: _uncommitted, ...known } = unprepared
          const { readiness: _readiness, ...ready } = known
          const { harnessProgress: _progress, ...withoutProgress } = ready
          const { privacy: _privacy, ...withoutPrivacy } = withoutProgress
          const { toolProbeErrors: _probeErrors, localModels: _served, refusedModels: _refused, ...legacy } = withoutPrivacy
          // A backend before `starting` refuses it: it gets the models the grid lists, as before, not none at all.
          const listedOnly = localModels?.some(m => m.starting)
            ? [{ ...withoutPrivacy, localModels: localModels.filter(m => !m.starting) }] : []
          const attempts = [...('quotaReasons' in observation ? [observation] : []), ...('harnessTokens' in unreasoned ? [unreasoned] : []), ...('preparingStartIds' in untokened ? [untokened] : []),
            ...('harnessUncommitted' in unprepared ? [unprepared] : []),
            ...('readiness' in known ? [known] : []), ready, ...('harnessProgress' in ready ? [withoutProgress] : []),
            ...('privacy' in withoutProgress ? [withoutPrivacy] : []), ...listedOnly,
            ...('toolProbeErrors' in observation || 'localModels' in observation || 'refusedModels' in observation ? [legacy] : [])]
          for (const [index, attempt] of attempts.entries()) {
            try {
              await this.deps.backend(this.core, 'POST', path, attempt)
              const { harnessUncommitted: _fresh, ...taken } = attempt as Record<string, unknown>
              this.lastSent.set(String(row.tabId), { path, body: taken, at: this.deps.now() })
              break
            } catch (error) {
              if (!refused(error) || index === attempts.length - 1) throw error
              if ('quotaReasons' in attempt) this.quotaReasonsRefusedUntil = began + FIELD_REFUSED_MS
              else if ('harnessTokens' in attempt) this.tokensRefusedUntil = began + FIELD_REFUSED_MS
              else if ('preparingStartIds' in attempt) this.preparingRefusedUntil = began + FIELD_REFUSED_MS
              else if ('harnessUncommitted' in attempt) this.uncommittedRefusedUntil = began + FIELD_REFUSED_MS
              else if ('readiness' in attempt) this.readinessRefusedUntil = began + FIELD_REFUSED_MS
              else if ('harnessProgress' in attempt) this.progressRefusedUntil = began + FIELD_REFUSED_MS
              else if ('privacy' in attempt) this.privacyRefusedUntil = began + FIELD_REFUSED_MS
            }
          }
          this.published.set(String(row.tabId), { at: began, signature, starting: !!localModels?.some(m => m.starting) })
        } finally { this.sending.delete(String(row.tabId)) }
        this.noteReading(String(row.tabId), null)
        } catch (error) {
          this.failed = true
          this.noteReading(String(row.tabId), error)
          // Only a refusal that this machine lost access to the Swarm stops its starts; a timeout, a 5xx or a reading the
          // backend would not validate says nothing about the starts, which keep their own receipts (Diego's Mac, 2026-10-28).
          if (lostAccess(error)) throw error
        }
        }
        this.repairTrust ??= createSwarmCloneTrustRepair(this.core, this.deps.now)
        try { await this.repairTrust(row) }
        catch { /* Trust migration cannot prevent this pass from picking up pending starts. */ }
        // Two launches per pass bounds expensive native work. Pending starts
        // keep their original receipt across network failures and host restarts.
        const cursor = this.cursors.get(String(row.tabId)) ?? 0
        this.cursors.set(String(row.tabId), cursor + 2)
        const round = pending.length ? [...pending.slice(cursor % pending.length), ...pending.slice(0, cursor % pending.length)].slice(0, 2) : []
        for (const start of round) {
          if (this.stopped) return
          if (!identifier(start.id) || ((row.paused || pool.paused) && !start.dispatched)) continue
          if (this.cleaningTabs.has(String(row.tabId))) { this.noteWaiting(start.id, CLEANING_WAIT); continue }
          const launched = this.startInFlight(String(row.tabId))
          try {
            const path = `/api/super-tabs/hosts/${this.machineId}/starts/${row.tabId}/${start.id}`
            // The start endpoint reads this start and takes its commands, nothing else. Any other read went out as an empty
            // command, which the backend refused with a 400 at every start (prod logs 2026-10-28).
            const scoped: ScopedRequest = async input => input.action !== 'startStatus' && input.action !== 'command'
              ? { error: 'HOST_UNSUPPORTED', detail: 'A contributed machine reads only its own starts.' }
              : { ok: true, value: await this.deps.backend(this.core, input.action === 'startStatus' ? 'GET' : 'POST', path,
                input.action === 'startStatus' ? undefined : { operationId: input.operationId, command: input.command }) }
            try {
              // The Harness Team account is not private (its owner's home folder opened again, say): a new start is refused
              // here as well as by routing, and never moved to the owner's account instead.
              if (privacy?.mode === 'account' && !privacy.passed && !start.dispatched) {
                await scoped({ action: 'command', operationId: `privacy-failed-${start.id}`,
                  command: { type: 'agent.startFailed', startId: start.id,
                    error: `This computer's Harness Team account is not private (${privacy.item}): ${privacy.detail} Its owner can run \`harness team setup\` to repair it.` } })
                continue
              }
              // Another person's project is cloned and fetched with the Harness GitHub App's token, never this machine's own
              // git login; a token that cannot be had fails the start (superTabs/projectFolder.ts).
              let github: { requester: string } | null = null
              if (!start.dispatched) {
                try {
                  github = (await (this.deps.prepare ?? ((core, pooled, queued) => prepareSwarmStart(core, pooled, queued,
                    { backend: this.deps.backend, team: (this.deps.team ?? (() => readAuthSession()?.kind === 'team'))() })))(this.core, row, start)) ?? null
                } catch (error) {
                  await scoped({ action: 'command', operationId: `prepare-failed-${start.id}`,
                    command: { type: 'agent.startFailed', startId: start.id,
                      error: error instanceof Error ? error.message : 'Could not prepare this project on the machine.' } })
                  continue
                }
              }
              const result = await this.deps.start({ tabId: row.tabId, startId: start.id, hostDispatch: true, ...(github ? { github } : {}) }, scoped, where, this.deps.open)
              const refused = result.ok !== true && !start.dispatched && !NOT_REFUSED.has(String(result.error))
              // Launched, and its creation still under way on the daemon: anything else is not preparing.
              if (result.error === 'START_PENDING' && result.state === 'pending') this.preparing.add(String(start.id))
              else this.preparing.delete(String(start.id))
              // Launched, its engine yet to record its session: if the Swarm fails this start meanwhile, [abandoned] stops it.
              if (result.error === 'START_PENDING' && identifier(result.harnessId) && identifier(result.creationId)) {
                this.unconfirmed.set(String(start.id), { path, harnessId: result.harnessId, creationId: result.creationId, tries: 0, checking: false })
              } else this.unconfirmed.delete(String(start.id))
              if (!refused) this.refusedSince.delete(start.id)
              if (result.ok === true && identifier(result.harnessId)) {
                this.waiting.delete(start.id)
                // Before the start settles: a settled start is no longer listed, so a missed record would never be made.
                this.recordWorktree(String(row.tabId), start.id, result.harnessId, object(start.request))
                await scoped({ action: 'command', operationId: `settled-${start.id}`,
                  command: { type: 'agent.startSettled', startId: start.id, warning: result.modelWarning ?? null } })
              } else if (result.ok !== true) {
                const reason = String(result.detail ?? (Array.isArray(result.reasons) ? result.reasons.join(' ') : result.error))
                this.noteWaiting(start.id, reason)
                const since = this.refusedSince.get(start.id) ?? began
                if (refused) this.refusedSince.set(start.id, since)
                if (refused && began - since >= START_REFUSED_MS) {
                  await scoped({ action: 'command', operationId: `refused-${start.id}`, command: { type: 'agent.startFailed', startId: start.id, error: reason } })
                }
              }
            }
            // Keep its durable receipt; another start must not be starved by this failure.
            catch (error) { this.refusedSince.delete(start.id); this.noteWaiting(start.id, error instanceof Error ? error.message : String(error)) }
          } finally { launched() }
        }
        } catch { /* Revocation or one unavailable project cannot block another contribution. */ }
      }
    } finally { local?.close() }
  }
  /**
   * A start this host launched, its engine never recording its session, that the backend no longer lists as pending: when
   * the backend says it failed (its machine did not start it within 3 minutes, say) and joined no agent, the agent this
   * host created for it is stopped. Nothing else would: the host no longer sees the start, and the agent is no member of
   * the Swarm. Mac Auto's Harness Team account kept ten such Codex panes idle on 2026-10-29. Only the agent this start's
   * own creation receipt names is closed (core closeMember), never one that joined; a status the backend cannot give now
   * is asked again on later passes, a few times.
   */
  private async abandoned(startId: string, launch: Unconfirmed): Promise<void> {
    launch.checking = true
    try {
      const status = object(await this.deps.backend(this.core, 'GET', launch.path))
      if (identifier(status.harnessId) || !status.error) { this.unconfirmed.delete(startId); return }
      const close = this.core.agents.closeMember
      if (!close) { this.unconfirmed.delete(startId); return }
      const closed = await close(launch.harnessId, launch.creationId)
      if ('closed' in closed && closed.closed) {
        this.unconfirmed.delete(startId)
        this.log(`Stopped the agent a failed start launched (start ${startId}, session ${launch.harnessId.slice(0, 8)}): ${String(status.error)}`)
        return
      }
      // Not this start's own agent, as its receipt says: nothing here to stop.
      if ('error' in closed && closed.error === 'NOT_A_MEMBER') { this.unconfirmed.delete(startId); return }
      throw new Error(`${'error' in closed ? closed.error : 'unknown'}${'detail' in closed && closed.detail ? `: ${closed.detail}` : ''}`)
    } catch (error) {
      if (++launch.tries >= ABANDONED_TRIES) this.unconfirmed.delete(startId)
      this.log(`Could not stop the agent a failed start launched (start ${startId}): ${error instanceof Error ? error.message : String(error)}`)
    } finally { launch.checking = false }
  }

  /** Each running session's token counts by model, from the daemon's last usage reading (never a transcript read): the
   *  Swarm prices each attempt by them (backend superTabs/costs). Counts only; the reading's folders and pull requests stay
   *  here. A session with none read yet is left out. */
  private async tokensOf(running: readonly string[]): Promise<Record<string, Record<string, ModelTokens>>> {
    const counted: Record<string, Record<string, ModelTokens>> = {}
    for (const id of running) {
      const session = this.core.agents.byAgent(id)
      const target = session && usageTarget(session)
      if (!target || !validUsageTarget(target)) continue
      const models = (await this.core.usage?.(target).catch(() => null))?.models
      if (models && Object.keys(models).length && validModelTokens(models)) counted[id] = models
    }
    return counted
  }
  /** Whether each running session's folder has uncommitted changes (git status), as last read, for the sessions git could
   *  read: the backend stops a worker idle for 15 minutes only when its host says it is clean (backend superTabs/tidy.ts).
   *  The folders due are read beside the pass, never holding the reading up; what they say goes with a later one. A folder
   *  is due a minute after its last read once its session's screen ([shown]) has changed since, and after
   *  [UNCOMMITTED_IDLE_TTL_MS] whatever it shows. */
  private uncommitted(running: readonly string[], now: number, shown: Record<string, number>): Record<string, boolean> {
    const read: Record<string, boolean> = {}, due: Array<{ id: string; cwd: string; shown?: number }> = []
    for (const id of running) {
      const cwd = this.core.agents.byAgent(id)?.cwd
      if (!cwd) continue
      const known = this.uncommittedCache.get(id)
      const same = known?.cwd === cwd
      if (same) read[id] = known.dirty
      const idle = same && shown[id] !== undefined && known.shown === shown[id]
      if (!same || (now >= known.until && (!idle || now >= known.readAt + UNCOMMITTED_IDLE_TTL_MS))) due.push({ id, cwd, shown: shown[id] })
    }
    // Sessions of every tab share it, so only what no session has kept current goes: a session that left is never read again.
    for (const [id, entry] of this.uncommittedCache) if (now >= entry.readAt + 2 * UNCOMMITTED_IDLE_TTL_MS) this.uncommittedCache.delete(id)
    if (due.length && !this.uncommittedReading) this.readFolders(due)
    return read
  }
  /** Reads [due] folders with git, [UNCOMMITTED_PARALLEL] at a time, into the cache. */
  private readFolders(due: Array<{ id: string; cwd: string; shown?: number }>): void {
    this.uncommittedReading = true
    const next = async (): Promise<void> => {
      for (let folder = due.shift(); folder; folder = due.shift()) {
        const dirty = await uncommittedIn(folder.cwd, this.deps.git).catch(() => null)
        const at = this.deps.now()
        if (dirty === null) this.uncommittedCache.delete(folder.id)
        else this.uncommittedCache.set(folder.id, { cwd: folder.cwd, dirty, until: at + UNCOMMITTED_TTL_MS, readAt: at, shown: folder.shown })
      }
    }
    void Promise.all(Array.from({ length: Math.min(UNCOMMITTED_PARALLEL, due.length) }, next)).finally(() => { this.uncommittedReading = false })
  }

  /** Once its host confirmed a worker stopped (host.ts releaseWorker), the worktree its start made goes at once instead of
   *  after the weekly sweep's idle week, by that sweep's own rule (lib/worktreeSweep.ts): only a worktree this machine's
   *  record proves the Swarm made, with no session in it and nothing uncommitted. Its branch keeps every commit and goes
   *  only when they are all on other branches or the remote, as once its pull request merged. Anything else stays. */
  async removeStoppedWorktree(tabId: string, harnessId: string): Promise<void> {
    const file = swarmWorktreesFile(this.core.dataDir, this.machineId)
    const record = readWorktrees(file).find(w => w.tabId === tabId && w.harnessId === harnessId)
    if (!record || !await swarmWorktree(record.path, record.source, record.startId)) return
    if (this.core.agents.live().some(a => !!a.cwd && within(record.path, a.cwd))) return
    // File times are wall-clock, so the sweep's idle check reads the real clock; no idle wait is asked.
    if (!await sweepOne(record.path, Date.now(), 0).catch(() => false)) return
    writeWorktrees(file, readWorktrees(file).filter(w => !(w.tabId === tabId && w.harnessId === harnessId)))
  }

  /** A removal deletes only what is provably the Swarm's: the record says which worktree each start made. */
  private recordWorktree(tabId: string, startId: string, harnessId: string, request: Record<string, unknown>) {
    const path = this.core.agents.byAgent(harnessId)?.cwd
    if (request.worktree !== true || typeof request.cwd !== 'string' || !path) return
    try {
      const file = swarmWorktreesFile(this.core.dataDir, this.machineId), worktrees = readWorktrees(file)
      if (!worktrees.some(w => w.tabId === tabId && w.startId === startId)) writeWorktrees(file, [...worktrees, { tabId, startId, harnessId, source: request.cwd, path }])
    } catch (error) { this.log(`Could not record the worktree of Swarm start ${startId}: ${error instanceof Error ? error.message : String(error)}`) }
  }
  private log(message: string) { (this.deps.log ?? (line => console.warn(`[super-tabs] ${line}`)))(message) }

  /** Its owner removed this machine from the tab's Swarm (docs: 2026-10-23-remove-machine): close the Swarm's sessions
   *  here, delete the tab's Swarm folders and the worktrees its starts made, and acknowledge. Each step is safe to repeat,
   *  so a host that stopped part-way does it again from the roster's cleanup row, which stays until acknowledged. */
  clean(tabId: string, removalId: string): Promise<void> {
    // Both name folders and an operation: nothing else may reach a path.
    if (!identifier(tabId) || !identifier(removalId)) return Promise.reject(new Error('Invalid machine removal.'))
    if (this.cleaned.has(removalId) || this.deps.now() < (this.cleanupRetries.get(removalId)?.at ?? 0)) return Promise.resolve()
    const running = this.cleaning.get(removalId) ?? this.cleanTab(tabId, removalId)
      .then(() => { this.cleaned.add(removalId); this.cleanupRetries.delete(removalId) }, error => {
        // The row asks again every poll; a backend that keeps failing is asked a minute later, doubling up to half an hour.
        const retry = this.cleanupRetries.get(removalId) ?? { failures: 0, at: 0 }
        retry.at = this.deps.now() + Math.min(30 * 60_000, 60_000 * 2 ** retry.failures++)
        this.cleanupRetries.set(removalId, retry)
        throw error
      }).finally(() => this.cleaning.delete(removalId))
    this.cleaning.set(removalId, running)
    return running
  }
  /** A start in flight in this Swarm until the returned call. */
  private startInFlight(tabId: string): () => void {
    let done!: () => void
    const flight = new Promise<void>(resolve => { done = resolve })
    const flights = this.startsInFlight.get(tabId) ?? new Set()
    this.startsInFlight.set(tabId, flights.add(flight))
    return () => {
      done()
      flights.delete(flight)
      if (!flights.size && this.startsInFlight.get(tabId) === flights) this.startsInFlight.delete(tabId)
    }
  }
  /** Runs one cleanup with its Swarm marked as cleaning for its whole run, once the starts already in flight there are done. */
  private async cleanTab(tabId: string, removalId: string) {
    this.cleaningTabs.set(tabId, (this.cleaningTabs.get(tabId) ?? 0) + 1)
    try {
      const flights = [...this.startsInFlight.get(tabId) ?? []]
      if (flights.length) {
        const waitMs = this.deps.cleanupWaitMs ?? CLEANUP_WAIT_MS
        let timer: NodeJS.Timeout | undefined
        const done = await Promise.race([Promise.all(flights).then(() => true),
          new Promise<false>(resolve => { timer = setTimeout(resolve, waitMs, false) })]).finally(() => clearTimeout(timer))
        if (!done) throw new Error(`Did not clean up Swarm ${tabId} yet: an agent start there is still running after ${Math.round(waitMs / 1000)} s. It tries again later.`)
      }
      await this.runCleanup(tabId, removalId)
    } finally {
      const left = this.cleaningTabs.get(tabId)! - 1
      if (left) this.cleaningTabs.set(tabId, left); else this.cleaningTabs.delete(tabId)
    }
  }
  private async runCleanup(tabId: string, removalId: string) {
    const file = swarmWorktreesFile(this.core.dataDir, this.machineId)
    const recorded = readWorktrees(file).filter(w => w.tabId === tabId)
    // Starts from before the record: a worktree counts only when this machine's receipt for that start created the
    // very agent the registry lists as agent-started in it. A start receipt read is required; a tab gone or no longer
    // readable by this owner leaves only the record.
    // A cleanup that waited past the backend's fallback gives way to its owner adding this machine again (backend machines.ts
    // cleanupOverdue, 2026-10-28). The Swarm listing this machine other than under this very removal means a newer add owns
    // the folders now: delete nothing, and confirm nothing, since the backend dropped this cleanup with that add. Read at
    // the start, again before anything is closed, again before each deletion (closing a session waits, and an add can land
    // meanwhile: second review of #1991), and again before the worktree records change, so an add that lands while this
    // runs keeps what it made.
    const read = async () => {
      try { return (await this.sources.reads.read(tabId)).state }
      catch (error) { if (!(error instanceof SuperTabHostError) || ![403, 404].includes(error.status)) throw error; return {} }
    }
    const addedAgain = (state: Record<string, unknown>) => {
      const listed = list(state.machines).find(m => m.machineId === this.machineId)
      if (!listed || object(listed.removal).id === removalId) return false
      this.log(`Kept the Swarm folders of ${tabId}: this machine was added to that Swarm again.`)
      return true
    }
    const state = await read()
    if (addedAgain(state)) return
    const starts = list(state.starts)
    const swarm = new Set(recorded.map(w => w.harnessId))
    /** Each Swarm start's receipt on this machine, by the agent it names: what lets the core close one its host no longer retains. */
    const receipts = new Map<string, string>()
    const candidates = recorded.map(w => ({ source: w.source, path: w.path, startId: w.startId, proven: true }))
    for (const start of starts) {
      const request = object(start.request)
      if (request.machineId !== this.machineId || !identifier(start.id) || !identifier(start.harnessId) || !identifier(start.creationId)) continue
      const creation = await this.core.agents.creationStatus?.(start.creationId)
      const proven = creation?.state === 'created' && creation.agentId === start.harnessId
      if (proven) { swarm.add(start.harnessId); receipts.set(start.harnessId, start.creationId) }
      const agent = this.core.agents.all().find(a => a.agentId === start.harnessId)
      if (request.worktree === true && typeof request.cwd === 'string' && agent?.cwd && !candidates.some(c => c.path === agent.cwd)) {
        candidates.push({ source: request.cwd, path: agent.cwd, startId: start.id, proven: proven && agent.startedBy === 'agent' })
      }
    }
    const worktrees: string[] = []
    for (const c of candidates) {
      if (c.proven && await swarmWorktree(c.path, c.source, c.startId)) worktrees.push(c.path)
      else if (existsSync(c.path)) this.log(`Kept ${basename(c.path)}: it is not provably a worktree a Swarm start made.`)
    }
    if (addedAgain(await read())) return
    const targets = [...worktrees, ...swarmCloneRoots(this.core.dataDir, tabId)]
    const inside = (cwd: string | null) => !!cwd && targets.some(t => within(t, cwd))
    // The Swarm's own close (core/api.ts closeMember), which the core answers in its process and in the Swarm's own
    // (services/processCoreApi.ts). Diego 10-29: closeStarted is the agent cleanup's alone, so under harnessd the Swarm's
    // process had none, closed nothing and kept every folder. The core closes only a member its host retains or one this
    // start's receipt names; any other agent-started session here stays open, and its folder with it.
    // Why each close failed, by the folder it ran in: review of #2070, a removal that never confirmed said nothing of why.
    const refused = new Map<string, string>()
    for (const agent of this.core.agents.live()) {
      if (agent.startedBy === 'agent' && (swarm.has(agent.agentId) || inside(agent.cwd))) {
        const answer = await (this.core.agents.closeMember?.(agent.agentId, receipts.get(agent.agentId)) ?? Promise.resolve({ error: 'UNSUPPORTED' }))
          // A fixed code, not the error's own text, which can carry a full path (re-check of #2070).
          .catch(() => ({ error: 'CLOSE_FAILED' }))
        if (typeof answer.error === 'string' && agent.cwd) refused.set(agent.cwd, answer.error)
      }
    }
    const open = this.core.agents.live().map(a => a.cwd).filter((cwd): cwd is string => !!cwd)
    const kept = new Set<string>()
    for (const target of targets) {
      if (open.some(cwd => within(target, cwd))) {
        const reasons = [...new Set([...refused].filter(([cwd]) => within(target, cwd)).map(([, error]) => error))]
        this.log(`Kept ${basename(target)}: a session still runs in it${reasons.length ? `; its close was refused: ${reasons.join(', ')}` : ''}.`)
        kept.add(basename(target)); continue
      }
      if (addedAgain(await read())) return
      const source = candidates.find(c => c.path === target)?.source
      // git forgets the worktree in its repository too; a folder it refuses (a submodule, a lock) is deleted as a folder.
      if (source) await git(source, ['worktree', 'remove', '--force', target]).catch(() => null)
      await rm(target, { recursive: true, force: true })
    }
    // Diego 10-29: a folder kept for a live session was confirmed cleaned anyway and its records dropped, so nothing ever
    // tried it again. Unconfirmed, the cleanup row stays and the next try comes on clean()'s backoff.
    if (kept.size) throw new Error(`Did not finish cleaning up Swarm ${tabId} yet: a session still runs in ${[...kept].join(', ')}. It tries again later.`)
    if (addedAgain(await read())) return
    writeWorktrees(file, readWorktrees(file).filter(w => w.tabId !== tabId))
    await this.deps.backend(this.core, 'POST', `/api/super-tabs/${tabId}/commands`, { operationId: `machine-cleaned-${removalId}`,
      command: { type: 'machine.cleaned', machineId: this.machineId, removalId } })
  }
}

// ── Readiness (#229 v1 routing) ─────────────────────────────────────────────────────────────────────────────────────
// The route picked a Windows machine that never started agents, machines without the project and machines that could not
// push, because nothing told it so. The reading says what this machine is ready for; the route leaves out only what it
// says cannot work (routeCommand.ts), and anything unknown stays a candidate.

/** How long an engine's sign-in and a checkout's push access stand before they are read again, and how soon an engine
 *  probe that failed is tried again. */
const READINESS_MS = 10 * 60_000
const READINESS_RETRY_MS = 60_000
/** How long an allowance reading stands. 2026-10-29: Anthropic answered 5 reads in a row, then refused them for 5 minutes
 *  (HTTP 429, retry-after 300); read on every 15-second report, Claude's allowance showed as unknown. */
const USAGE_FRESH_MS = 3 * 60_000
/** After a refused read: Anthropic's own retry-after. */
const USAGE_LIMITED_MS = 5 * 60_000
/** After the reader on this machine did not answer at all. */
const USAGE_RETRY_MS = 60_000
/** How long the last readable windows stand while later reads fail; past it the allowance is unknown, with why. */
const USAGE_KEEP_MS = 20 * 60_000
/** The backend's limit on one reading's checkouts (`machineObservationSchema`). */
const MAX_CHECKOUTS = 64
type ReadyEngine = { engine: string; installed: true | null; signedIn: boolean | null }
type ReadyCheckout = { folder: string; repository: string | null; git: boolean; push: boolean | null }
type GitRun = (cwd: string, args: string[]) => Promise<{ ok: boolean; stdout: string; stderr: string; timedOut?: boolean }>

/** git that never waits on a person (Lead, #229: a machine missing credentials must never hang on a password prompt): no
 *  terminal or askpass prompt, no credential manager window, and a session of its own, so ssh has no terminal to ask on.
 *  At [timeoutMs] its whole process group is killed, the helpers it started with it, and the answer settles then, even
 *  while a helper that got away still holds its output (review of #1743: one could keep a refresh pending for good). */
export function createQuietGit(timeoutMs = 15_000): GitRun {
  return (cwd, args) => new Promise(resolve => {
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '', SSH_ASKPASS_REQUIRE: 'never',
      GCM_INTERACTIVE: 'never', GIT_OPTIONAL_LOCKS: '0' }
    for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE']) delete env[key]
    const child = spawn('git', ['-C', cwd, ...args], { env, detached: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = '', settled = false
    const settle = (answer: { ok: boolean; timedOut?: boolean }) => { if (!settled) { settled = true; clearTimeout(timer); resolve({ ...answer, stdout, stderr }) } }
    child.stdout.setEncoding('utf8').on('data', (text: string) => { stdout = (stdout + text).slice(0, 65_536) })
    child.stderr.setEncoding('utf8').on('data', (text: string) => { stderr = (stderr + text).slice(0, 65_536) })
    // Its own group (detached), so the group id is its pid; Windows has no groups, and kills git alone. A helper it left
    // behind holding its pipes is ended too, whether git hung or had already gone (re-check of #1743: one left per check).
    const end = () => {
      try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL') } catch { /* already gone */ }
      child.stdout.destroy(); child.stderr.destroy()
    }
    const timer = setTimeout(() => { end(); settle({ ok: false, timedOut: true }) }, timeoutMs)
    child.on('error', () => settle({ ok: false }))
    // Its output is all read once its pipes close; a helper it left running may hold them, so its exit is enough a second on.
    child.on('close', code => settle({ ok: code === 0 }))
    child.on('exit', code => { setTimeout(() => { if (!settled) { end(); settle({ ok: code === 0 }) } }, 1_000).unref() })
  })
}
const quietGit = createQuietGit()

/** Whether a session's folder has uncommitted changes (git status), or null when git could not say. */
export async function uncommittedIn(cwd: string, run: GitRun = quietGit): Promise<boolean | null> {
  const status = await run(cwd, ['status', '--porcelain'])
  return status.ok ? status.stdout.trim() !== '' : null
}

/** What git or the remote says when this login may not push: refused, signed out, or a credential it could not ask for.
 *  Anything else (a host it could not reach, a timeout) says nothing about access. */
const NO_PUSH = /permission|denied|returned error: 40[13]|could not read (username|password)|terminal prompts disabled|authentication failed|invalid username or password|repository not found/i

/** What git says of a folder that is no repository at all: the one failure that tells it is not a checkout. */
const NOT_A_REPOSITORY = /not a git repository/i

/** Each project folder in a Swarm folder: the repository its origin names (without credentials), whether it is a
 *  checkout of its own, and whether this machine's login can push there, by a dry run that runs no hooks. git's own
 *  words never leave the machine. A folder whose probe failed (a timeout, git that would not start, an unreadable
 *  repository) is left out, which the route reads as unknown, and [unsure] says to read it again soon. */
export async function readCheckouts(root: string, run: GitRun): Promise<{ checkouts: ReadyCheckout[]; unsure: boolean }> {
  const folders = (await readdir(root, { withFileTypes: true })).filter(e => e.isDirectory() && !e.name.startsWith('.'))
    .map(e => e.name).sort().slice(0, MAX_CHECKOUTS)
  const out: ReadyCheckout[] = []
  let unsure = false
  for (const folder of folders) {
    const dir = join(root, folder)
    const top = await run(dir, ['rev-parse', '--show-toplevel'])
    if (!top.ok && !top.timedOut && NOT_A_REPOSITORY.test(top.stderr)) { out.push({ folder, repository: null, git: false, push: null }); continue }
    const [own, here] = top.ok ? await Promise.all([realpath(top.stdout.trim()).catch(() => null), realpath(dir).catch(() => null)]) : [null, null]
    if (!own || !here) { unsure = true; continue }
    // A folder inside some other checkout is not a checkout of its own.
    if (own !== here) { out.push({ folder, repository: null, git: false, push: null }); continue }
    const origin = await run(dir, ['remote', 'get-url', 'origin'])
    if (!origin.ok) { out.push({ folder, repository: null, git: true, push: null }); continue }
    const pushed = await run(dir, ['push', '--dry-run', '--no-verify', '--porcelain', 'origin', 'HEAD:refs/heads/harness-push-check'])
    out.push({ folder, repository: repositoryKey(origin.stdout.trim()), git: true, push: pushed.ok ? true : !pushed.timedOut && NO_PUSH.test(pushed.stderr) ? false : null })
  }
  return { checkouts: out, unsure }
}

/** The backend's limit on one machine's local models (`machineObservationSchema`). */
const MAX_LOCAL_MODELS = 64
/** How often the grids this machine may use are read again for its Swarms. */
const GRID_MODELS_MS = 60_000
/** Every Swarm's grid, as the backend mints its name: their models belong to their own Swarm. */
const SWARM_GRID = /^swarm-[0-9a-f]{12}$/

/** A start this host launched whose engine has not recorded its session yet (ContributedMachines `abandoned`). */
interface Unconfirmed { path: string; harnessId: string; creationId: string; tries: number; checking: boolean }
/** How many passes ask about an abandoned start before it is let go. */
const ABANDONED_TRIES = 5

type LocalModelReading = { grid: string; model: string; name?: string; contextWindow?: number; kind: 'local' | 'api' | 'shared'; starting?: true }

/** When this machine's Swarm models last changed, from the files that change with them: the APIs it shares
 *  (`swarm-api-shares.json`) and grid's engine records (`run/engines/<grid>/remote.json`, rewritten on every join and
 *  leave). Their modification times, never their contents. */
export async function localModelsStamp(dataDir: string, env: NodeJS.ProcessEnv): Promise<string> {
  const engines = join(env.GRID_HOME || join(env.HOME ?? '', '.grid'), 'run', 'engines')
  const files = [join(dataDir, 'swarm-api-shares.json'),
    ...(await readdir(engines).catch(() => [] as string[])).sort().map(grid => join(engines, grid, 'remote.json'))]
  const times = await Promise.all(files.map(file => stat(file).then(s => s.mtimeMs, () => 0)))
  return times.join(',')
}

/** The models a `grid_swarm_heal` answer says the Swarm's grid lists, or null when it could not say (an older daemon, or
 *  the grid unread). */
export function liveOn(answer: unknown): Set<string> | null {
  const live = object(answer).live
  return Array.isArray(live) ? new Set(live.filter((m): m is string => typeof m === 'string')) : null
}

/** The APIs a `grid_swarm_api_shares` answer says this machine shares on [grid] (`lib/swarmApiShares.ts`). */
export function apisOn(answer: unknown, grid: string): LocalModelReading[] {
  return list(object(answer).shares).filter(s => s.grid === grid && typeof s.model === 'string' && s.model.length > 0 && s.model.length <= 200)
    .map(s => ({ grid, model: String(s.model), ...(typeof s.name === 'string' ? { name: `${String(s.model)} · ${s.name}`.slice(0, 200) } : {}), kind: 'api' as const }))
}

/** The live models a `grid_models_list` answer says this machine may use on grids other than Swarms' (owner, 2026-10-23:
 *  Builders may use local models shared with their machine's owner). Each Swarm's grid is left to its own Swarm. */
export function sharedWith(answer: unknown, swarmGrid: string): LocalModelReading[] {
  const out: LocalModelReading[] = []
  for (const section of list(object(answer).grids)) {
    const grid = typeof section.name === 'string' ? section.name : ''
    if (!grid || grid.length > 160 || grid === swarmGrid || SWARM_GRID.test(grid)) continue
    for (const model of list(section.models)) {
      if (typeof model.id !== 'string' || !model.id || model.id.length > 200 || model.unavailable) continue
      if (!out.some(m => m.grid === grid && m.model === model.id)) out.push({ grid, model: model.id, kind: 'shared' })
    }
  }
  return out
}

/** Of the models shared with this machine's owner, those a `grid_swarm_offers` answer says they offer to the Swarm
 *  (`lib/swarmOffers.ts`, owner 2026-10-23: offering is a choice, not every model shared with someone). */
export function offered(shared: LocalModelReading[], answer: unknown): LocalModelReading[] {
  const offers = new Set(list(object(answer).offers).map(o => `${String(o.sharedGrid)}\0${String(o.model)}`))
  return shared.filter(m => offers.has(`${m.grid}\0${m.model}`))
}

/** The models a `grid_fleet_models_list` answer says this machine serves on [grid], by the name grid lists each under,
 *  each with why Builders are not offered it when it is too small or too slow to drive a coding agent (lib/codingModel.ts). */
function fleetOn(answer: unknown, grid: string): Array<LocalModelReading & { why: string | null }> {
  const out: Array<LocalModelReading & { why: string | null }> = []
  const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined
  for (const model of list(object(answer).models)) {
    const on = list(model.servedOn).find(s => s.grid === grid)
    const served = Array.isArray(on?.servedAs) ? on.servedAs.find((n): n is string => typeof n === 'string' && n.length > 0 && n.length <= 200) : undefined
    if (!served || out.length >= 16) continue
    const why = codingRefusal({ name: typeof model.name === 'string' ? model.name : served, paramsB: num(model.paramsB), sizeBytes: num(model.sizeBytes),
      quantization: typeof model.quant === 'string' ? model.quant : undefined, tokensPerSecond: num(model.tokensPerSecond), estTokS: num(model.estTokS) })
    out.push({ grid, model: served, ...(typeof model.name === 'string' ? { name: model.name.slice(0, 200) } : {}),
      ...(typeof model.contextWindow === 'number' && Number.isInteger(model.contextWindow) && model.contextWindow > 0 ? { contextWindow: model.contextWindow } : {}), kind: 'local', why })
  }
  return out
}

/** The models this machine serves on [grid] that Builders may run on. One too small or too slow to drive a coding agent is
 *  left out: the route never offers it ([refusedOn] says why). */
export function servedOn(answer: unknown, grid: string): LocalModelReading[] {
  return fleetOn(answer, grid).filter(m => m.why === null).map(({ why: _why, ...reading }) => reading)
}

/** The models this machine serves on [grid] that Builders are not offered, with why: a Lead asked for one is told that,
 *  not to share a model the Swarm already has (2026-10-24). */
export function refusedOn(answer: unknown, grid: string): Array<{ grid: string; model: string; name?: string; why: string }> {
  return fleetOn(answer, grid).flatMap(({ grid: g, model, name, why }) => why === null ? [] : [{ grid: g, model, ...(name ? { name } : {}), why: why.slice(0, 300) }])
}
