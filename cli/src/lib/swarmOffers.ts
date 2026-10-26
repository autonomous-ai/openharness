/**
 * The models shared with this computer's person that they offer to a Swarm (docs/plans/2026-10-23-swarm-local-models.md,
 * owner 2026-10-23): only those are in this machine's readings, so only those does the Lead start Builders on, and only
 * here, since only this computer's sign-in reaches the grid that serves them. Offering is a choice, as running a model or
 * sharing an API is: a model shared with someone is not offered to their Swarms by itself.
 */
import { readFileSync, writeFileSync } from 'node:fs'

export interface SwarmOffer { grid: string; sharedGrid: string; model: string }

const valid = (row: unknown): row is SwarmOffer => {
  const r = (row && typeof row === 'object' ? row : {}) as Record<string, unknown>
  return [r.grid, r.sharedGrid, r.model].every(v => typeof v === 'string' && v.length > 0 && v.length <= 200)
}

export class SwarmOffers {
  constructor(private readonly file: string) {}

  /** What is offered, to the Swarm whose grid is [grid] or to every Swarm. An unreadable file offers nothing. */
  list(grid?: string): SwarmOffer[] {
    let rows: unknown
    try { rows = JSON.parse(readFileSync(this.file, 'utf8')) } catch { return [] }
    return (Array.isArray(rows) ? rows : []).filter(valid).filter(o => !grid || o.grid === grid)
      .map(({ grid: g, sharedGrid, model }) => ({ grid: g, sharedGrid, model }))
  }

  /** Offers [model] of [sharedGrid] to the Swarm whose grid is [grid], or stops. Saying the same twice changes nothing. */
  set(offer: SwarmOffer, on: boolean): SwarmOffer[] {
    const same = (o: SwarmOffer) => o.grid === offer.grid && o.sharedGrid === offer.sharedGrid && o.model === offer.model
    const rest = this.list().filter(o => !same(o))
    const next = on ? [...rest, { grid: offer.grid, sharedGrid: offer.sharedGrid, model: offer.model }] : rest
    writeFileSync(this.file, JSON.stringify(next), { mode: 0o600 })
    return next.filter(o => o.grid === offer.grid)
  }
}
