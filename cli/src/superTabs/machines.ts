import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { lstat, readFile, realpath, rm } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { CoreApi } from '../core/api.js'
import { openDaemon } from '../agentClient/daemon.js'
import { codingRefusal } from '../lib/codingModel.js'
import { backend, SuperTabHostError } from './host.js'
import { identifier, object } from './wire.js'
import { readCapabilities, quotaOf, meteredEngine } from './capacity.js'
import { startAgent, type ScopedRequest } from './start.js'
import { prepareSwarmProject } from './projectFolder.js'
import { createSwarmCloneTrustRepair, swarmCloneRoots } from './cloneTrust.js'
import { git } from '../lib/worktreeSweep.js'
import { projectsRoot } from '../lib/projectFolder.js'
import { worktreeFolderName } from '../lib/agentNames.js'

const finite = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v : null
const list = (v: unknown) => Array.isArray(v) ? v.map(object) : []
// The route's requirements are not known before the Lead routes. Include common tools in each snapshot, then
// include tools from pending starts. An uncommon tool first named during routing remains unverified and is refused.
const COMMON_TOOLS = ['git', 'node', 'npm', 'flutter', 'gh', 'cargo', 'python3']
const VERIFIED_TOOL_TTL_MS = 10 * 60_000
const UNVERIFIED_TOOL_TTL_MS = 60_000

/** How often the executor asks the backend what its tabs want of it (a start waiting, a pause) and compares what it
 *  would report with what it last did. Only this read is this frequent: the resource readers run when there is
 *  something to say. A start waits at most this long, plus the host's one-second tick, to be picked up. */
export const MACHINE_POLL_MS = 5_000
/** How long an observation stands before it is sent again unchanged, so the Desktop can tell a machine that is
 *  silent from one that has nothing new (its offline threshold is counted in these beats). */
export const MACHINE_HEARTBEAT_MS = 15_000

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

/** Separate from chat delivery: slow resource readers and agent launches never
 * hold up a delivery lease. Only a tab's explicit owner grant wakes this queue. */
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
  private readonly published = new Map<string, { at: number; signature: string }>()
  /** Shell tool availability belongs to this machine, not a tab. Resource readings still refresh every heartbeat. */
  private readonly toolCache = new Map<string, { value: boolean | null; detail?: string; until: number }>()
  /** Per waiting start, why it was last not started, so the log says it once per reason, not every pass. */
  private readonly waiting = new Map<string, string>()
  /** Removals cleaned and acknowledged by this host, and the one in progress per removal. */
  private readonly cleaned = new Set<string>()
  private readonly cleaning = new Map<string, Promise<void>>()
  /** Per removal whose cleanup or acknowledgement failed, how often and when it may run again. */
  private readonly cleanupRetries = new Map<string, { failures: number; at: number }>()
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
  constructor(private readonly core: CoreApi, private readonly machineId: string,
    private readonly deps: { backend: typeof backend; open: typeof openDaemon; capabilities: typeof readCapabilities;
      start: typeof startAgent; now: () => number; prepare?: typeof prepareSwarmProject; log?: (message: string) => void; env?: NodeJS.ProcessEnv } =
      { backend, open: openDaemon, capabilities: readCapabilities, start: startAgent, now: Date.now }) {}
  stop() { this.stopped = true }
  /** DESKTOP-0TFH0OJ, 2026-10-23: every Claude start there was refused (CLI 0.4.57 took an API-key Claude for one not
   *  signed in) and the refusal was dropped, so two starts stayed "Queued" for hours with nothing in the log. */
  private noteWaiting(startId: string, reason: string) {
    if (this.waiting.get(startId) === reason) return
    this.waiting.set(startId, reason)
    this.log(`Swarm start ${startId} is waiting: ${reason}`)
  }
  /** One pass at a time, one [MACHINE_POLL_MS] after the last began (or a beat after one that failed). */
  tick(): Promise<void> {
    if (this.stopped || this.deps.now() < this.next) return Promise.resolve()
    const began = this.deps.now()
    return this.running ??= this.poll(began).catch(error => { this.failed = true; throw error }).finally(() => {
      this.running = null
      const done = this.deps.now()
      this.next = this.failed ? done + MACHINE_HEARTBEAT_MS : Math.max(began + MACHINE_POLL_MS, done + 1_000)
      this.failed = false
    })
  }
  private async poll(began: number) {
    const where = { dataDir: this.core.dataDir, port: this.core.daemon.port, machineId: this.machineId }
    const pools = list(await this.deps.backend(this.core, 'GET', `/api/super-tabs/hosts/${this.machineId}/pools`)).filter(row => identifier(row.tabId) && object(row.machine).machineId === this.machineId && identifier(object(row.machine).generation))
    if (this.stopped || pools.length === 0) { this.published.clear(); this.waiting.clear(); return }
    const pendingIds = new Set(pools.flatMap(row => list(row.starts).map(start => start.id)))
    for (const id of this.waiting.keys()) if (!pendingIds.has(id)) this.waiting.delete(id)
    for (const tab of this.published.keys()) if (!pools.some(row => row.tabId === tab)) this.published.delete(tab)
    // The local daemon is reached only for a reading to send, never for a pass that has nothing to say.
    let local: Awaited<ReturnType<typeof openDaemon>> | null = null
    let usage: Record<string, unknown> | null = null
    try {
      for (const row of pools) {
        try {
        if (this.stopped || !identifier(row.tabId)) return
        const pool = object(row.machine)
        if (!identifier(pool.generation) || pool.machineId !== this.machineId || typeof pool.cwd !== 'string') continue
        const ids = Array.isArray(row.harnessIds) ? row.harnessIds.filter(identifier) : []
        const stopped: string[] = []
        for (const id of ids) if (await this.core.agents.stopped?.(id)) stopped.push(id)
        const running = ids.filter(id => !!this.core.agents.byAgent(id) && !stopped.includes(id))
        const pending = list(row.starts)
        const tools = [...new Set([...COMMON_TOOLS, ...pending.flatMap(start => {
          const wanted = object(object(start.request).requirements).tools
          return Array.isArray(wanted) ? wanted.filter((name): name is string => typeof name === 'string' && /^[A-Za-z0-9_.+-]{1,80}$/.test(name)) : []
        })])].slice(0, 20)
        const signature = JSON.stringify([row.reservations, pool.generation, [...running].sort(), [...stopped].sort(), row.paused === true || pool.paused === true,
          pending.map(start => start.id).sort()])
        const last = this.published.get(String(row.tabId))
        if (!last || last.signature !== signature || began - last.at >= MACHINE_HEARTBEAT_MS) {
        local ??= await this.deps.open(where)
        // The existing usage reader owns its provider cache. Raw responses and
        // account credentials never leave this machine.
        const readings = usage ??= await local.request('usage_read', {}, 20_000).catch(() => ({}))
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
        const listed = (m: LocalModelReading) => !live || live.has(m.model)
        const fleet = typeof row.localGrid === 'string' ? await local.request('grid_fleet_models_list', {}, 20_000).catch(() => ({})) : null
        const refusedModels = typeof row.localGrid === 'string' ? refusedOn(fleet, row.localGrid) : []
        const localModels = typeof row.localGrid === 'string' ? [
          ...servedOn(fleet, row.localGrid).filter(listed),
          ...apisOn(await local.request('grid_swarm_api_shares', { grid: row.localGrid }, 10_000).catch(() => ({})), row.localGrid).filter(listed),
          ...offered(sharedWith(await this.gridModels(local), row.localGrid),
            await local.request('grid_swarm_offers', { grid: row.localGrid }, 10_000).catch(() => ({}))),
        ].slice(0, MAX_LOCAL_MODELS) : null
        const observation = { generation: pool.generation, tools: reportedTools, ...(localModels ? { localModels } : {}),
          ...(refusedModels.length ? { refusedModels } : {}),
          ...(Object.keys(toolProbeErrors).length ? { toolProbeErrors } : {}),
          resources: { cpuPercent: finite(resources.cpuPercent), memoryUsedBytes: finite(resources.memoryUsedBytes), memoryTotalBytes: finite(resources.memoryTotalBytes),
            diskFreeBytes: finite(resources.diskFreeBytes), diskTotalBytes: finite(resources.diskTotalBytes), projectDiskFreeBytes: finite(resources.projectDiskFreeBytes), projectDiskTotalBytes: finite(resources.projectDiskTotalBytes),
            deviceType: typeof resources.deviceType === 'string' ? resources.deviceType : null,
            chip: typeof resources.chip === 'string' ? resources.chip : null, os: typeof resources.os === 'string' ? resources.os : null,
            gpuPercent: gpus.length ? Math.max(...gpus) : null },
          quotas: engines.map(engine => {
            const q = quotaOf(readings, engine, false)
            // Windows that could not be read on an API key are metered: known, with none (route.ts quotaOf2).
            return { engine, known: q.known || meteredEngine(engine, this.deps.env ?? process.env), windows: q.windows }
          }), runningHarnessIds: running, stoppedHarnessIds: stopped,
          ...(Array.isArray(row.reservations) ? { stoppedReservations: list(row.reservations).filter(r => stopped.includes(String(r.harnessId))
            && identifier(r.harnessId) && identifier(r.generation)).map(r => ({ harnessId: r.harnessId, generation: r.generation })) } : {}) }
        try {
          const path = `/api/super-tabs/${row.tabId}/machines/${this.machineId}`
          try { await this.deps.backend(this.core, 'POST', path, observation) }
          catch (error) {
            if (!(error instanceof SuperTabHostError) || error.status !== 400 || error.code !== 'VALIDATION_ERROR' || !('toolProbeErrors' in observation || 'localModels' in observation || 'refusedModels' in observation)) throw error
            // Older backends reject the additive fields. Their boolean-only view still safely refuses an unverified tool.
            const { toolProbeErrors: _probeErrors, localModels: _served, refusedModels: _refused, ...legacy } = observation
            await this.deps.backend(this.core, 'POST', path, legacy)
          }
          this.published.set(String(row.tabId), { at: began, signature })
        } catch (error) { this.failed = true; throw error }
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
          const path = `/api/super-tabs/hosts/${this.machineId}/starts/${row.tabId}/${start.id}`
          const scoped: ScopedRequest = async input => ({ ok: true, value: await this.deps.backend(this.core,
            input.action === 'startStatus' ? 'GET' : 'POST', path,
            input.action === 'startStatus' ? undefined : { operationId: input.operationId, command: input.command }) })
          try {
            if (pool.scope === 'swarm' && !start.dispatched) {
              try { await (this.deps.prepare ?? prepareSwarmProject)(this.core, row, start) }
              catch (error) {
                await scoped({ action: 'command', operationId: `prepare-failed-${start.id}`,
                  command: { type: 'agent.startFailed', startId: start.id,
                    error: error instanceof Error ? error.message : 'Could not prepare this project on the machine.' } })
                continue
              }
            }
            const result = await this.deps.start({ tabId: row.tabId, startId: start.id, hostDispatch: true }, scoped, where, this.deps.open)
            if (result.ok === true && identifier(result.harnessId)) {
              this.waiting.delete(start.id)
              // Before the start settles: a settled start is no longer listed, so a missed record would never be made.
              this.recordWorktree(String(row.tabId), start.id, result.harnessId, object(start.request))
              await scoped({ action: 'command', operationId: `settled-${start.id}`,
                command: { type: 'agent.startSettled', startId: start.id, warning: result.modelWarning ?? null } })
            } else if (result.ok !== true) {
              this.noteWaiting(start.id, String(result.detail ?? (Array.isArray(result.reasons) ? result.reasons.join(' ') : result.error)))
            }
          }
          // Keep its durable receipt; another start must not be starved by this failure.
          catch (error) { this.noteWaiting(start.id, error instanceof Error ? error.message : String(error)) }
        }
        } catch { /* Revocation or one unavailable project cannot block another contribution. */ }
      }
    } finally { local?.close() }
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
    const running = this.cleaning.get(removalId) ?? this.runCleanup(tabId, removalId)
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
  private async runCleanup(tabId: string, removalId: string) {
    const file = swarmWorktreesFile(this.core.dataDir, this.machineId)
    const recorded = readWorktrees(file).filter(w => w.tabId === tabId)
    // Starts from before the record: a worktree counts only when this machine's receipt for that start created the
    // very agent the registry lists as agent-started in it. A start receipt read is required; a tab gone or no longer
    // readable by this owner leaves only the record.
    let starts: Record<string, unknown>[] = []
    try { starts = list(object(object(await this.deps.backend(this.core, 'GET', `/api/super-tabs/${tabId}`)).state).starts) }
    catch (error) { if (!(error instanceof SuperTabHostError) || ![403, 404].includes(error.status)) throw error }
    const swarm = new Set(recorded.map(w => w.harnessId))
    const candidates = recorded.map(w => ({ source: w.source, path: w.path, startId: w.startId, proven: true }))
    for (const start of starts) {
      const request = object(start.request)
      if (request.machineId !== this.machineId || !identifier(start.id) || !identifier(start.harnessId) || !identifier(start.creationId)) continue
      const creation = await this.core.agents.creationStatus?.(start.creationId)
      const proven = creation?.state === 'created' && creation.agentId === start.harnessId
      if (proven) swarm.add(start.harnessId)
      const agent = this.core.agents.all().find(a => a.agentId === start.harnessId)
      if (request.worktree === true && typeof request.cwd === 'string' && agent?.cwd && !candidates.some(c => c.path === agent.cwd)) {
        candidates.push({ source: request.cwd, path: agent.cwd, startId: start.id, proven: proven && agent.startedBy === 'agent' })
      }
    }
    const worktrees: string[] = []
    for (const c of candidates) {
      if (c.proven && await swarmWorktree(c.path, c.source, c.startId)) worktrees.push(c.path)
      else if (existsSync(c.path)) this.log(`Kept ${c.path}: it is not provably a worktree a Swarm start made.`)
    }
    const targets = [...worktrees, ...swarmCloneRoots(this.core.dataDir, tabId)]
    const inside = (cwd: string | null) => !!cwd && targets.some(t => within(t, cwd))
    for (const agent of this.core.agents.live()) {
      if (agent.startedBy === 'agent' && (swarm.has(agent.agentId) || inside(agent.cwd))) {
        await this.core.agents.closeStarted?.(agent.agentId, 'now').catch(() => null)
      }
    }
    const open = this.core.agents.live().map(a => a.cwd).filter((cwd): cwd is string => !!cwd)
    for (const target of targets) {
      if (open.some(cwd => within(target, cwd))) { this.log(`Kept ${target}: a session still runs in it.`); continue }
      const source = candidates.find(c => c.path === target)?.source
      // git forgets the worktree in its repository too; a folder it refuses (a submodule, a lock) is deleted as a folder.
      if (source) await git(source, ['worktree', 'remove', '--force', target]).catch(() => null)
      await rm(target, { recursive: true, force: true })
    }
    writeWorktrees(file, readWorktrees(file).filter(w => w.tabId !== tabId))
    await this.deps.backend(this.core, 'POST', `/api/super-tabs/${tabId}/commands`, { operationId: `machine-cleaned-${removalId}`,
      command: { type: 'machine.cleaned', machineId: this.machineId, removalId } })
  }
}

/** The backend's limit on one machine's local models (`machineObservationSchema`). */
const MAX_LOCAL_MODELS = 64
/** How often the grids this machine may use are read again for its Swarms. */
const GRID_MODELS_MS = 60_000
/** Every Swarm's grid, as the backend mints its name: their models belong to their own Swarm. */
const SWARM_GRID = /^swarm-[0-9a-f]{12}$/

type LocalModelReading = { grid: string; model: string; name?: string; contextWindow?: number; kind: 'local' | 'api' | 'shared' }

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
