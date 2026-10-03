/**
 * The zoo's individuals, as harnessd reads them (daemons/README.md "Individuals", "In the zoo").
 *
 * A species (tim, the octopus) is a type; every hatch is its own individual:
 *
 *   daemons: [{ uid, id (species), seed, serial?, name?, shiny, xp, bond, version, hatched, egg }]
 *   paired:  uid | null
 *
 * harnessd needs little of it: which individual is paired (the brain speaks in its SPECIES' voice, and the
 * pair harness may call it by its name, `pip the tim`), and each individual's species, seed and version
 * (its art, pair/plateService.ts). Everything else is the windows'.
 *
 * A zoo from before individuals (one record per species, `pair: <species id>`, a `nickname`) still reads:
 * each record is an individual with no uid and seed 0, the species' own look. `pair` naming a uid is read
 * too, whichever of the two names the server settles on.
 */
import { isPairDaemonId, statusText } from './protocol.js'

export interface ZooIndividual {
  /** The server's id for this hatch; null for a record from before individuals. */
  uid: string | null
  /** The species: a roster id. */
  id: string
  /** 1..4294967295 from the hatch; 0 is the species' own look. */
  seed: number
  serial: number | null
  /** The name the person gave it at the hatch, printable ASCII; null when unnamed. */
  name: string | null
  version: string | null
  /** When it hatched (ms), when the zoo says. */
  hatched: number | null
}

/** The most a name is, as the server takes it. */
export const NAME_MAX = 24
export const SEED_MAX = 0xffffffff

export function isUid(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value)
}

export function isSeed(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= SEED_MAX
}

function nameOf(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const flat = statusText(value, NAME_MAX)
  return flat || null
}

function timeOf(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
  if (typeof value !== 'string' || value.length > 64) return null
  const at = Date.parse(value)
  return Number.isFinite(at) ? at : null
}

/** Every individual in a zoo (`GET /api/zoo`'s `data.zoo`), malformed records left out. */
export function zooIndividuals(zoo: unknown): ZooIndividual[] {
  const list = zoo && typeof zoo === 'object' ? (zoo as { daemons?: unknown }).daemons : null
  if (!Array.isArray(list)) return []
  const out: ZooIndividual[] = []
  for (const raw of list.slice(0, 1024)) {
    if (!raw || typeof raw !== 'object') continue
    const d = raw as Record<string, unknown>
    if (!isPairDaemonId(d.id)) continue
    const uid = isUid(d.uid) ? d.uid : null
    out.push({
      uid,
      id: d.id,
      seed: uid && isSeed(d.seed) ? d.seed : 0,
      serial: typeof d.serial === 'number' && Number.isInteger(d.serial) && d.serial > 0 ? d.serial : null,
      name: nameOf(d.name) ?? nameOf(d.nickname),
      version: typeof d.version === 'string' && d.version.length <= 8 ? d.version : null,
      hatched: timeOf(d.hatched) ?? timeOf(d.hatchedAt),
    })
  }
  return out
}

/**
 * The paired individual: `paired` (or `pair`) names its uid. From before individuals `pair` names a
 * species, and the record of that species is the one. Null when nothing is paired, or the pair names
 * nothing in the zoo.
 */
export function pairedIndividual(zoo: unknown): ZooIndividual | null {
  if (!zoo || typeof zoo !== 'object') return null
  const z = zoo as { paired?: unknown; pair?: unknown }
  const key = Object.hasOwn(z, 'paired')
    ? typeof z.paired === 'string' ? z.paired : null
    : typeof z.pair === 'string' ? z.pair : null
  if (!key) return null
  const all = zooIndividuals(zoo)
  const byUid = all.find((d) => d.uid === key)
  if (byUid) return byUid
  if (!isPairDaemonId(key)) return null
  // The old shape: `pair` is a species id, one record per species.
  return all.find((d) => d.id === key && d.uid === null) ?? null
}

/** How an individual is called: `pip the tim`, or `tim #0042` unnamed, or plain `tim` without a serial. */
export function individualName(d: Pick<ZooIndividual, 'id' | 'name' | 'serial'>): string {
  if (d.name) return `${d.name} the ${d.id}`
  return d.serial ? `${d.id} #${String(d.serial).padStart(4, '0')}` : d.id
}
