import type { CoreApi } from '../core/api.js'
import { openDaemon } from '../agentClient/daemon.js'
import { backend } from './host.js'
import { identifier, object } from './wire.js'
import { readCapabilities, quotaOf } from './capacity.js'
import { startAgent, type ScopedRequest } from './start.js'
import { prepareSwarmProject } from './projectFolder.js'

const finite = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v : null
const list = (v: unknown) => Array.isArray(v) ? v.map(object) : []

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
  /** Per tab, when its observation was last sent and what it said that matters to a reader: the harnesses
   *  running and stopped, whether new work is paused, and which starts are waiting. A change in any of them is
   *  sent at once; otherwise the heartbeat keeps the reading fresh. */
  private readonly published = new Map<string, { at: number; signature: string }>()
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
        const signature = JSON.stringify([row.reservations, pool.generation, [...running].sort(), [...stopped].sort(), row.paused === true || pool.paused === true,
          pending.map(start => start.id).sort()])
        const last = this.published.get(String(row.tabId))
        if (!last || last.signature !== signature || began - last.at >= MACHINE_HEARTBEAT_MS) {
        local ??= await this.deps.open(where)
        // The existing usage reader owns its provider cache. Raw responses and
        // account credentials never leave this machine.
        const readings = usage ??= await local.request('usage_read', {}, 20_000).catch(() => ({}))
        const observed = await this.deps.capabilities({ cwd: pool.cwd, tools: ['git'], devices: [] })
        if (this.stopped) return
        const resources = object('resources' in observed ? observed.resources : null)
        const gpus = list(resources.gpus).map(g => finite(g.utilizationPercent)).filter((n): n is number => n !== null)
        const observation = { generation: pool.generation, tools: 'tools' in observed ? observed.tools : {},
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
          await this.deps.backend(this.core, 'POST', `/api/super-tabs/${row.tabId}/machines/${this.machineId}`, observation)
          this.published.set(String(row.tabId), { at: began, signature })
        } catch (error) { this.failed = true; throw error }
        }
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
