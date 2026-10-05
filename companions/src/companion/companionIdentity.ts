import { pairedIndividual, zooIndividuals, type ZooIndividual } from './individuals.js'
import { rollTraits } from './plates/render.g.js'
import { PLATE_ROSTER } from './plates/models.g.js'

export { COMPANION_SPECIES, readCompanionIdentity, type CompanionIdentity } from '../../../cli/src/cable/companionProtocol.js'
import { COMPANION_SPECIES, type CompanionIdentity } from '../../../cli/src/cable/companionProtocol.js'

export interface CompanionMilestone {
  token: string
  kind: 'hatch' | 'grow'
  at: number
  companion: CompanionIdentity
}

export const sameCompanion = (a: CompanionIdentity | null | undefined, b: CompanionIdentity | null | undefined): boolean =>
  (!a || !b) ? !a && !b : a.id===b.id && a.uid===b.uid && a.seed===b.seed && a.name===b.name && a.version===b.version && a.colour===b.colour && a.mark===b.mark

/** The same seed roll used by the Zoo and individual cards; no account writes. */
export function companionIdentity(d: ZooIndividual | null): CompanionIdentity | null {
  if (!d || !COMPANION_SPECIES.includes(d.id as typeof COMPANION_SPECIES[number])) return null
  const def = PLATE_ROSTER.daemons.find(row => row.id === d.id)!
  const traits = rollTraits(PLATE_ROSTER, d.id, d.seed)
  if (!traits) return null
  const catalogue = def.traits!
  return {
    id: d.id, uid: d.uid ?? d.id, seed: d.seed,
    name: d.name ?? (d.serial ? `${d.id} #${String(d.serial).padStart(4, '0')}` : d.id),
    version: d.version === '1.0' || d.version === '2.0' ? d.version : '0.1',
    colour: d.seed ? catalogue.colours.findIndex(row => row[0] === traits.colour) : -1,
    mark: d.seed ? Math.max(0, catalogue.marks.findIndex(row => row[0] === traits.marks)) : 0,
  }
}

/** Baselines are quiet. A stale read, duplicate push or new connection cannot replay a milestone. */
export class CompanionZoo {
  identity: CompanionIdentity | null = null
  milestone: CompanionMilestone | null = null
  private previous: Map<string, ZooIndividual> | null = null
  private revision = -1
  private seen = new Set<string>()

  get uids(): string[] { return [...(this.previous?.keys() ?? [])] }

  reset(): void { this.identity = null; this.milestone = null; this.previous = null; this.revision = -1; this.seen.clear() }

  observe(zoo: unknown, now = Date.now(), revision?: number): void {
    if (revision !== undefined && Number.isInteger(revision)) {
      if (revision < this.revision) return
      this.revision = revision
    }
    const individuals = zooIndividuals(zoo)
    const next = new Map(individuals.map(d => [d.uid ?? d.id, d]))
    this.identity = companionIdentity(pairedIndividual(zoo))
    if (this.previous) {
      for (const [uid, d] of next) {
        const identity = companionIdentity(d)
        if (!identity) continue
        const before = this.previous.get(uid)
        const rank = (version: string | null): number => version === '2.0' ? 2 : version === '1.0' ? 1 : 0
        const kind = !before && d.hatched !== null && now - d.hatched >= 0 && now - d.hatched <= 15_000
          ? 'hatch' : before && rank(d.version) > rank(before.version) ? 'grow' : null
        if (kind) {
          const token = `${uid}:${kind}:${identity.version}`
          if (!this.seen.has(token)) {
            this.seen.add(token)
            if (this.seen.size > 2048) this.seen.delete(this.seen.values().next().value!)
            this.milestone = { token, kind, at: now, companion: identity }
          }
        }
      }
    }
    this.previous = next
    if (this.milestone && now - this.milestone.at > 8_000) this.milestone = null
  }
}
