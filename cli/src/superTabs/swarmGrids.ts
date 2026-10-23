/**
 * The owner's computer's half of the Local models add-on (docs/plans/2026-10-23-swarm-local-models.md): for each of the
 * owner's Swarms with it on, create the Swarm's grid and keep its members in step with the Swarm's people, then tell
 * the Swarm how that went (`localModels.status`).
 *
 * Grid is asked only when there is something to do: a Swarm turned on, its people changed, or the last attempt failed
 * (then at most once a minute, unless grid's answer was one only the person can change, such as its plan limit). With the add-on off everywhere, a pass is one backend read and nothing else.
 */
import { randomUUID } from 'node:crypto'
import type { CoreApi } from '../core/api.js'
import { openDaemon } from '../agentClient/daemon.js'
import { backend, identifier, object, SuperTabHostError } from './host.js'

/** How often the owner's Swarms are read. */
export const GRID_POLL_MS = 60_000

interface Deps { backend: typeof backend; open: typeof openDaemon; now: () => number; newId: () => string }

export class SwarmGrids {
  private next = 0
  private running: Promise<void> | null = null
  /** What each Swarm's grid was last brought to: its members, and whether that worked. */
  private readonly synced = new Map<string, { signature: string; ready: boolean; final: boolean }>()
  constructor(private readonly core: CoreApi, private readonly machineId: string,
    private readonly deps: Deps = { backend, open: openDaemon, now: Date.now, newId: randomUUID }) {}

  tick(): Promise<void> {
    if (this.deps.now() < this.next) return Promise.resolve()
    this.next = this.deps.now() + GRID_POLL_MS
    return this.running ??= this.pass().finally(() => { this.running = null })
  }

  private async pass(): Promise<void> {
    // A backend before the add-on reads `grids` as a Swarm id and answers 404: it has no grids to keep.
    const listed = await this.deps.backend(this.core, 'GET', '/api/super-tabs/grids').catch((error: unknown) => {
      if (error instanceof SuperTabHostError && error.status === 404) return []
      throw error
    })
    const rows = (Array.isArray(listed) ? listed : []).map(object)
      .filter(row => row.enabled === true && identifier(row.tabId) && typeof row.grid === 'string')
    for (const tab of [...this.synced.keys()]) if (!rows.some(row => row.tabId === tab)) this.synced.delete(tab)
    if (!rows.length) return
    let local: Awaited<ReturnType<typeof openDaemon>> | null = null
    try {
      for (const row of rows) {
        const members = (Array.isArray(row.members) ? row.members : []).filter((m): m is string => typeof m === 'string').sort()
        const signature = JSON.stringify([row.grid, members])
        const last = this.synced.get(String(row.tabId))
        // A final refusal is left alone while the Swarm still shows it; turning the add-on off and on clears what the
        // Swarm shows, even between two passes, and that asks again.
        if (last?.signature === signature && (last.ready ? row.ready === true : last.final && row.ready === false)) continue
        local ??= await this.deps.open({ dataDir: this.core.dataDir, port: this.core.daemon.port, machineId: this.machineId })
        const result = object(await local.request('grid_swarm_sync', { grid: row.grid, members }, 180_000)
          .catch((error: unknown) => ({ ready: false, error: error instanceof Error ? error.message : 'The grid could not be reached.' })))
        const ready = result.ready === true
        const error = typeof result.error === 'string' ? result.error.slice(0, 500) : undefined
        // A refusal only the person can change (grid's plan limit) is not asked again every minute: only once the
        // Swarm's people change, or the owner turns the add-on off and on.
        this.synced.set(String(row.tabId), { signature, ready, final: result.final === true })
        await this.deps.backend(this.core, 'POST', `/api/super-tabs/${row.tabId}/commands`, { operationId: `grid-${this.deps.newId()}`,
          command: { type: 'localModels.status', grid: row.grid, ready, ...(error ? { error } : {}) } })
      }
    } finally { local?.close() }
  }
}
