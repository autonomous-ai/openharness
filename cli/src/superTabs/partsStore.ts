/**
 * One Swarm as the client holds it: its parts by kind and key, and the cursor that reads what changed since (design
 * 2026-10-26-swarm-state-parts sections 4.4 and 5.1). A higher version wins, an equal one is the same part seen again in
 * the 30 s overlap, a tombstone removes the part, and a dormant stub moves a group out of the active list. A store is never
 * changed in place: a merge returns a new one, so a read in flight never sees half of another.
 */
import type { ChangedParts, Derived, FirstLoad, PartEnvelope, PartKind, PartsPayload } from './readContract.js'

type ListedKind = Exclude<PartKind, 'head'>
export interface PartsStore {
  cursor: string
  epoch: number
  lastChangedAt: number | null
  githubApp: boolean
  head: PartEnvelope | null
  /** Live parts by kind, in the order the server listed them; new keys go last. */
  parts: Map<ListedKind, Map<string, PartEnvelope>>
  /** Groups that went dormant, as their stub: out of the active list until they change again. */
  dormant: Map<string, PartEnvelope>
  derived: Derived
}

const LISTS: Array<[keyof PartsPayload, ListedKind]> = [
  ['members', 'member'], ['agents', 'agent'], ['groups', 'group'], ['machines', 'machine'], ['starts', 'start'], ['progress', 'progress'],
]

export function storeOf(first: FirstLoad): PartsStore {
  const parts = new Map<ListedKind, Map<string, PartEnvelope>>(LISTS.map(([field, kind]) =>
    [kind, new Map((first[field] as PartEnvelope[]).map(part => [part.key, part]))]))
  return { cursor: first.cursor, epoch: first.epoch, lastChangedAt: first.lastChangedAt, githubApp: first.githubApp === true,
    head: first.head, parts, dormant: new Map(), derived: first.derived }
}

export function mergeChanges(store: PartsStore, changes: ChangedParts): PartsStore {
  const parts = new Map([...store.parts].map(([kind, held]) => [kind, new Map(held)]))
  const dormant = new Map(store.dormant)
  for (const [field, kind] of LISTS) {
    const held = parts.get(kind)!
    for (const part of changes[field] as PartEnvelope[]) {
      const known = held.get(part.key) ?? (kind === 'group' ? dormant.get(part.key) : undefined)
      if (known && known.version >= part.version) continue
      dormant.delete(part.key)
      // A live part replaced in place keeps its position: Map.set on a key it holds does not move it, so status keeps its
      // order while parts change (review round 1). A part new to the active list goes at the end.
      if (part.dormant || part.deleted) held.delete(part.key)
      if (part.dormant) dormant.set(part.key, part)
      else if (!part.deleted) held.set(part.key, part)
    }
  }
  const head = changes.head && (!store.head || changes.head.version > store.head.version) ? changes.head : store.head
  return { cursor: changes.cursor, epoch: changes.epoch, lastChangedAt: changes.lastChangedAt, githubApp: store.githubApp,
    head, parts, dormant, derived: changes.derived }
}
