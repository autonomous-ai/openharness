/**
 * What this computer serves on a Swarm's grid, checked against what the grid lists, and joined again when the grid lost
 * it (docs/plans/2026-10-23-swarm-local-models.md). 2026-10-24: after a few daemon restarts in a row the grid listed none
 * of this Mac's models, while its shares and its local model were still "shared" here. Grid runs one engine process per
 * grid for every model a computer joins there, and each join restarts it: the restore's leave-and-join per share killed
 * the process before it registered, and nothing looked again. Builders then waited without end for a model the grid did
 * not have. Read every pass (`superTabs/machines.ts`), this joins once more, at most every [HEAL_MS], and tells the
 * reading what is really live, so the route never offers a model the grid cannot reach.
 */
import type { SwarmApiShare } from './swarmApiShares.js'

/** How long a join is given to register before another is tried: grid's engine process takes seconds to come up. */
export const HEAL_MS = 3 * 60_000

export interface SwarmHealDeps {
  /** The model names the grid lists as live, or null when the grid could not be read. */
  live: (grid: string) => Promise<Set<string> | null>
  shares: { list: (grid: string) => SwarmApiShare[]; rejoin: (grid: string, connectionId: string, model: string) => Promise<unknown> }
  apps: { served: (grid: string) => Promise<string[]>; rejoin: (grid: string) => Promise<boolean> }
  now?: () => number
}

export class SwarmHeal {
  private readonly tried = new Map<string, number>()
  /** Nothing is joined in the first [HEAL_MS] of the process: the shares' restore joins them then, and the grid lists them
   *  only once that has registered. */
  private readonly started: number
  constructor(private readonly deps: SwarmHealDeps) { this.started = (deps.now ?? Date.now)() }

  /** What [grid] lists as live (null: unknown), and which of this computer's models it lacks. One of those is joined
   *  again when none was in the last [HEAL_MS]: an API share if one is missing, else an app engine. */
  async check(grid: string): Promise<{ live: string[] | null; missing: string[] }> {
    const live = await this.deps.live(grid).catch(() => null)
    if (!live) return { live: null, missing: [] }
    const shares = this.deps.shares.list(grid)
    const mine = [...shares.map(s => s.model), ...await this.deps.apps.served(grid).catch(() => [])]
    const missing = mine.filter(model => !live.has(model))
    const now = (this.deps.now ?? Date.now)()
    if (missing.length && now - (this.tried.get(grid) ?? this.started) >= HEAL_MS) {
      this.tried.set(grid, now)
      const share = shares.find(s => missing.includes(s.model))
      await (share ? this.deps.shares.rejoin(grid, share.connectionId, share.model) : this.deps.apps.rejoin(grid)).catch(() => {})
    }
    return { live: [...live], missing }
  }
}

/** The models a `grid --remote models GRID --json` answer lists. */
export function liveModels(stdout: string): Set<string> | null {
  let rows: unknown
  try { rows = JSON.parse(stdout) } catch { return null }
  if (!Array.isArray(rows)) return null
  return new Set(rows.flatMap(row => row && typeof row === 'object' && typeof (row as { model?: unknown }).model === 'string'
    ? [(row as { model: string }).model] : []))
}
