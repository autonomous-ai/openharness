import type { CoreApi } from '../core/api.js'
import { openDaemon } from '../agentClient/daemon.js'
import { backend, SuperTabHostError } from './host.js'
import { identifier, object } from './wire.js'
import { readCapabilities, quotaOf } from './capacity.js'
import { startAgent, type ScopedRequest } from './start.js'
import { prepareSwarmProject } from './projectFolder.js'
import { createSwarmCloneTrustRepair } from './cloneTrust.js'

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
      start: typeof startAgent; now: () => number; prepare?: typeof prepareSwarmProject } =
      { backend, open: openDaemon, capabilities: readCapabilities, start: startAgent, now: Date.now }) {}
  stop() { this.stopped = true }
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
    if (this.stopped || pools.length === 0) { this.published.clear(); return }
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
        // Only while the owner has the Local models add-on on: the models this machine serves on the Swarm's grid (its own
        // engines, the APIs it shares), then the ones shared with its owner that they offer to this Swarm (usable here alone).
        const localModels = typeof row.localGrid === 'string' ? [
          ...servedOn(await local.request('grid_fleet_models_list', {}, 20_000).catch(() => ({})), row.localGrid),
          ...apisOn(await local.request('grid_swarm_api_shares', { grid: row.localGrid }, 10_000).catch(() => ({})), row.localGrid),
          ...offered(sharedWith(await this.gridModels(local), row.localGrid),
            await local.request('grid_swarm_offers', { grid: row.localGrid }, 10_000).catch(() => ({}))),
        ].slice(0, MAX_LOCAL_MODELS) : null
        const observation = { generation: pool.generation, tools: reportedTools, ...(localModels ? { localModels } : {}),
          ...(Object.keys(toolProbeErrors).length ? { toolProbeErrors } : {}),
          resources: { cpuPercent: finite(resources.cpuPercent), memoryUsedBytes: finite(resources.memoryUsedBytes), memoryTotalBytes: finite(resources.memoryTotalBytes),
            diskFreeBytes: finite(resources.diskFreeBytes), diskTotalBytes: finite(resources.diskTotalBytes), projectDiskFreeBytes: finite(resources.projectDiskFreeBytes), projectDiskTotalBytes: finite(resources.projectDiskTotalBytes),
            deviceType: typeof resources.deviceType === 'string' ? resources.deviceType : null,
            chip: typeof resources.chip === 'string' ? resources.chip : null, os: typeof resources.os === 'string' ? resources.os : null,
            gpuPercent: gpus.length ? Math.max(...gpus) : null },
          quotas: (Array.isArray(pool.engines) ? pool.engines : []).filter((e): e is string => typeof e === 'string').map(engine => {
            const q = quotaOf(readings, engine, false)
            return { engine, known: q.known, windows: q.windows }
          }), runningHarnessIds: running, stoppedHarnessIds: stopped,
          ...(Array.isArray(row.reservations) ? { stoppedReservations: list(row.reservations).filter(r => stopped.includes(String(r.harnessId))
            && identifier(r.harnessId) && identifier(r.generation)).map(r => ({ harnessId: r.harnessId, generation: r.generation })) } : {}) }
        try {
          const path = `/api/super-tabs/${row.tabId}/machines/${this.machineId}`
          try { await this.deps.backend(this.core, 'POST', path, observation) }
          catch (error) {
            if (!(error instanceof SuperTabHostError) || error.status !== 400 || error.code !== 'VALIDATION_ERROR' || !('toolProbeErrors' in observation || 'localModels' in observation)) throw error
            // Older backends reject the additive fields. Their boolean-only view still safely refuses an unverified tool.
            const { toolProbeErrors: _probeErrors, localModels: _served, ...legacy } = observation
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
            if (result.ok === true && identifier(result.harnessId)) await scoped({ action: 'command', operationId: `settled-${start.id}`,
              command: { type: 'agent.startSettled', startId: start.id, warning: result.modelWarning ?? null } })
          }
          catch { /* Keep its durable receipt; another start must not be starved by this failure. */ }
        }
        } catch { /* Revocation or one unavailable project cannot block another contribution. */ }
      }
    } finally { local?.close() }
  }
}

/** The backend's limit on one machine's local models (`machineObservationSchema`). */
const MAX_LOCAL_MODELS = 64
/** How often the grids this machine may use are read again for its Swarms. */
const GRID_MODELS_MS = 60_000
/** Every Swarm's grid, as the backend mints its name: their models belong to their own Swarm. */
const SWARM_GRID = /^swarm-[0-9a-f]{12}$/

type LocalModelReading = { grid: string; model: string; name?: string; contextWindow?: number; kind: 'local' | 'api' | 'shared' }

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

/** The models a `grid_fleet_models_list` answer says this machine serves on [grid], by the name grid lists each under. */
export function servedOn(answer: unknown, grid: string): LocalModelReading[] {
  const out: LocalModelReading[] = []
  for (const model of list(object(answer).models)) {
    const on = list(model.servedOn).find(s => s.grid === grid)
    const served = Array.isArray(on?.servedAs) ? on.servedAs.find((n): n is string => typeof n === 'string' && n.length > 0 && n.length <= 200) : undefined
    if (!served || out.length >= 16) continue
    out.push({ grid, model: served, ...(typeof model.name === 'string' ? { name: model.name.slice(0, 200) } : {}),
      ...(typeof model.contextWindow === 'number' && Number.isInteger(model.contextWindow) && model.contextWindow > 0 ? { contextWindow: model.contextWindow } : {}), kind: 'local' })
  }
  return out
}
