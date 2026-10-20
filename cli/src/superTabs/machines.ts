import type { CoreApi } from '../core/api.js'
import { openDaemon } from '../agentClient/daemon.js'
import { backend } from './host.js'
import { identifier, object } from './wire.js'
import { readCapabilities, quotaOf } from './capacity.js'
import { startAgent, type ScopedRequest } from './start.js'

const finite = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v : null
const list = (v: unknown) => Array.isArray(v) ? v.map(object) : []

/** Separate from chat delivery: slow resource readers and agent launches never
 * hold up a delivery lease. Only a tab's explicit owner grant wakes this queue. */
export class ContributedMachines {
  private stopped = false
  private running: Promise<void> | null = null
  private next = 0
  private readonly cursors = new Map<string, number>()
  constructor(private readonly core: CoreApi, private readonly machineId: string,
    private readonly deps = { backend, open: openDaemon, capabilities: readCapabilities, start: startAgent, now: Date.now }) {}
  stop() { this.stopped = true }
  tick(): Promise<void> {
    if (this.stopped || this.deps.now() < this.next) return Promise.resolve()
    return this.running ??= this.poll().finally(() => { this.running = null; this.next = this.deps.now() + 15_000 })
  }
  private async poll() {
    const where = { dataDir: this.core.dataDir, port: this.core.daemon.port, machineId: this.machineId }
    const pools = list(await this.deps.backend(this.core, 'GET', `/api/super-tabs/hosts/${this.machineId}/pools`)).filter(row => identifier(row.tabId) && object(row.machine).machineId === this.machineId && identifier(object(row.machine).generation))
    if (this.stopped || pools.length === 0) return
    const local = await this.deps.open(where)
    try {
      // The existing usage reader owns its provider cache. Raw responses and
      // account credentials never leave this machine.
      const usage = await local.request('usage_read', {}, 20_000).catch(() => ({}))
      for (const row of pools) {
        try {
        if (this.stopped || !identifier(row.tabId)) return
        const pool = object(row.machine)
        if (!identifier(pool.generation) || pool.machineId !== this.machineId || typeof pool.cwd !== 'string') continue
        const observed = await this.deps.capabilities({ cwd: pool.cwd, tools: ['git'], devices: [] })
        if (this.stopped) return
        const resources = object('resources' in observed ? observed.resources : null)
        const gpus = list(resources.gpus).map(g => finite(g.utilizationPercent)).filter((n): n is number => n !== null)
        const ids = Array.isArray(row.harnessIds) ? row.harnessIds.filter(identifier) : []
        const stopped: string[] = []
        for (const id of ids) if (await this.core.agents.stopped?.(id)) stopped.push(id)
        const observation = { generation: pool.generation, tools: 'tools' in observed ? observed.tools : {},
          resources: { cpuPercent: finite(resources.cpuPercent), memoryUsedBytes: finite(resources.memoryUsedBytes), memoryTotalBytes: finite(resources.memoryTotalBytes),
            diskFreeBytes: finite(resources.diskFreeBytes), diskTotalBytes: finite(resources.diskTotalBytes), projectDiskFreeBytes: finite(resources.projectDiskFreeBytes), projectDiskTotalBytes: finite(resources.projectDiskTotalBytes),
            deviceType: typeof resources.deviceType === 'string' ? resources.deviceType : null,
            chip: typeof resources.chip === 'string' ? resources.chip : null, os: typeof resources.os === 'string' ? resources.os : null,
            gpuPercent: gpus.length ? Math.max(...gpus) : null },
          quotas: (Array.isArray(pool.engines) ? pool.engines : []).filter((e): e is string => typeof e === 'string').map(engine => {
            const q = quotaOf(usage, engine, false)
            return { engine, known: q.known, windows: q.windows }
          }), runningHarnessIds: ids.filter(id => !!this.core.agents.byAgent(id) && !stopped.includes(id)), stoppedHarnessIds: stopped }
        await this.deps.backend(this.core, 'POST', `/api/super-tabs/${row.tabId}/machines/${this.machineId}`, observation)
        // Two launches per pass bounds expensive native work. Pending starts
        // keep their original receipt across network failures and host restarts.
        const pending = list(row.starts), cursor = this.cursors.get(String(row.tabId)) ?? 0
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
            const result = await this.deps.start({ tabId: row.tabId, startId: start.id, hostDispatch: true }, scoped, where, this.deps.open)
            if (result.ok === true && identifier(result.harnessId)) await scoped({ action: 'command', operationId: `settled-${start.id}`,
              command: { type: 'agent.startSettled', startId: start.id, warning: result.modelWarning ?? null } })
          }
          catch { /* Keep its durable receipt; another start must not be starved by this failure. */ }
        }
        } catch { /* Revocation or one unavailable project cannot block another contribution. */ }
      }
    } finally { local.close() }
  }
}
