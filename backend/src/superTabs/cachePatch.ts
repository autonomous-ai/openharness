/**
 * How each read cache entry takes a Swarm's change instead of being loaded again (spec
 * docs/superpowers/specs/2026-11-02-swarm-cache-delta-design.md, Phase 1). A bump used to drop everything a process held of a
 * Swarm, and the next read loaded the whole Swarm again: ~1.4 MB for prod's busiest, 63% of the bytes read from Mongo
 * (2026-11-02). A rule applies the parts that changed since the entry was loaded (cache.ts, parts/load.ts loadDelta).
 *
 * A changed part comes as its row is now, so applying one twice, or one older than what is held, does nothing: a part is
 * applied only when its version is above the held one. A rule returns the held value itself when nothing changed, else new
 * lists that share every part that did not change (the cache freezes what is new).
 */
import { createHash } from 'node:crypto'
import { PART_KINDS, type GroupData, type MachineData, type Part, type PartKind, type SwarmParts } from './parts/index.js'
import type { SwarmDelta } from './parts/load.js'
import { startFinished } from './parts/write.js'
import { projectLightGroup } from './parts/lightSelect.js'
import { stableId, type AgentStart } from './model.js'

export interface PatchRule<T> {
  /** The part kinds whose changes this entry holds: a refresh reads only those. */
  kinds: readonly PartKind[]
  /** The held value with the delta applied, or 'reload' when the delta cannot be applied and the entry loads again. */
  apply(held: T, delta: SwarmDelta): T | 'reload'
  /** What of a patched value and a fresh load the verify sample compares (cache.ts verify), when not the whole: a fresh load
   *  can cover a different window than the held value (the feed). */
  comparable?(patched: T, fresh: T): [unknown, unknown]
}

/** A changed part as a load would have given it: a change read adds `readAt`, which no load carries. */
function asLoaded<T>(changed: Part): Part<T> {
  if (changed.readAt === undefined) return changed as Part<T>
  const { readAt: _readAt, ...loaded } = changed
  return loaded as Part<T>
}

/**
 * `list` with the parts of `kind` among `changed` applied: a newer version replaces the held part in place, or is added at
 * the end when not held, if `keep` says the entry holds it; else the held part is removed. The same list when nothing moved.
 */
function applyByKey<T>(list: readonly Part<T>[], changed: readonly Part[], kind: PartKind, keep: (part: Part) => boolean): Part<T>[] {
  let next: Part<T>[] | null = null
  for (const part of changed) {
    if (part.kind !== kind) continue
    const current = next ?? list
    const at = current.findIndex(p => p.key === part.key)
    if (at >= 0 && part.version <= current[at]!.version) continue
    if (!keep(part) && at < 0) continue
    next ??= [...list]
    if (!keep(part)) next.splice(at, 1)
    else if (at >= 0) next[at] = asLoaded<T>(part)
    else next.push(asLoaded<T>(part))
  }
  return next ?? (list as Part<T>[])
}

const live = (part: Part) => !part.deleted
const awake = (part: Part) => !part.deleted && !part.dormant
const asleep = (part: Part) => !part.deleted && !!part.dormant
const finished = (part: Part) => !!part.data && startFinished(part.data as AgentStart)

/** The `parts` entry (parts/load.ts loadReadBase): head, members, agents, awake groups, unfinished starts and progress. */
export const baseRule: PatchRule<SwarmParts> = {
  kinds: ['head', 'member', 'agent', 'group', 'start', 'progress'],
  apply(held, delta) {
    // A new visibility epoch changes what every reader may see from then on: load the base again rather than patch it.
    if (delta.head && delta.head.visibilityEpoch !== held.visibilityEpoch) return 'reload'
    const { parts } = delta
    const headPart = parts.find(p => p.kind === 'head' && p.version > held.head.version)
    const next: SwarmParts = {
      ...held,
      head: headPart ? asLoaded(headPart) : held.head,
      members: applyByKey(held.members, parts, 'member', live),
      agents: applyByKey(held.agents, parts, 'agent', live),
      groups: applyByKey(held.groups, parts, 'group', awake),
      starts: applyByKey(held.starts, parts, 'start', p => live(p) && !finished(p)),
      progress: applyByKey(held.progress, parts, 'progress', live),
      ...(headPart && delta.head ? delta.head : {}),
    }
    const same = (Object.keys(next) as Array<keyof SwarmParts>).every(key => next[key] === held[key])
    return same ? held : next
  },
}

/** The `machines` entry: every live machine part. */
export const machinesRule: PatchRule<Part<MachineData>[]> = {
  kinds: ['machine'],
  apply: (held, delta) => applyByKey(held, delta.parts, 'machine', live),
}

/** The `finished-starts` entry (parts/load.ts loadFinishedStarts): every live finished start. A start that finishes moves
 *  here from the base in the same delta; the 7-day expiry's tombstone takes it out. */
export const finishedStartsRule: PatchRule<Part<AgentStart>[]> = {
  kinds: ['start'],
  apply: (held, delta) => applyByKey(held, delta.parts, 'start', p => live(p) && finished(p)),
}

/** The `feed` entry (cachedReads.ts readChanged): every part changed after `from`, as `loadChanged` reads them, tombstones,
 *  dormant groups and machines' `readAt` included. Its full reloads were 610 MB per 20 minutes on prod (2026-11-02). */
export const feedRule: PatchRule<{ from: number; parts: Part[] }> = {
  kinds: PART_KINDS,
  apply(held, delta) {
    let next: Map<string, Part> | null = null
    const id = (part: Part) => `${part.kind}\u0000${part.key}`
    for (const part of delta.parts) {
      const current = (next ?? null)?.get(id(part)) ?? held.parts.find(p => p.kind === part.kind && p.key === part.key)
      if (current && part.version <= current.version) continue
      next ??= new Map(held.parts.map(p => [id(p), p]))
      next.set(id(part), part)
    }
    return next ? { from: held.from, parts: [...next.values()] } : held
  },
  // The check's own load starts where its reader's cursor does: only the parts both windows cover compare (final review).
  comparable(patched, fresh) {
    const from = Math.max(patched.from, fresh.from)
    const covered = (parts: Part[]) => parts.filter(p => Math.max(p.changedAt, p.readAt ?? 0) > from)
    return [covered(patched.parts), covered(fresh.parts)]
  },
}

/** A `startsOf:{agents}` entry (read/service.ts pollStarts): the live starts of these agents, an agent being its machine and
 *  harness (`stableId`). A start whose agent left the list goes, as does a tombstone. */
export function startsOfRule(agents: readonly string[]): PatchRule<Part<AgentStart>[]> {
  const listed = new Set(agents)
  const ofListed = (p: Part) => {
    const start = p.data as AgentStart | null
    return !!start?.harnessId && listed.has(stableId(start.request.machineId, start.harnessId))
  }
  return { kinds: ['start'], apply: (held, delta) => applyByKey(held, delta.parts, 'start', p => live(p) && ofListed(p)) }
}

/** The `dormant` entry: every live dormant group. */
export const dormantRule: PatchRule<Part<GroupData>[]> = {
  kinds: ['group'],
  apply: (held, delta) => applyByKey(held, delta.parts, 'group', asleep),
}

/** A `dormant:agent:{id}` entry: the live dormant groups that list this agent. A group it leaves, or that wakes, goes. */
export function dormantAgentRule(agentId: string): PatchRule<Part<GroupData>[]> {
  return { kinds: ['group'], apply: (held, delta) => applyByKey(held, delta.parts, 'group', p => asleep(p) && (p.data as GroupData).agentIds.includes(agentId)) }
}

/** A `light-dormant:agent:{id}` entry (cachedReads.ts deriveLight, B4): the same selection as `dormantAgentRule`'s, each
 *  conversation light (parts/lightSelect.ts projectLightGroup), as `loadLightGroups` loads it. */
export function lightDormantAgentRule(agentId: string): PatchRule<Part<GroupData>[]> {
  const keep = (p: Part) => asleep(p) && (p.data as GroupData).agentIds.includes(agentId)
  return { kinds: ['group'], apply: (held, delta) => applyByKey(held, delta.parts.map(p => p.kind === 'group' && keep(p) ? projectLightGroup(p as Part<GroupData>) : p),
    'group', keep) }
}

/** A `dormant:project:{id}` entry: the project's live dormant groups; a group stored with no project is the default one's
 *  (projects.ts groupProject). */
export function dormantProjectRule(projectId: string): PatchRule<Part<GroupData>[]> {
  return { kinds: ['group'], apply: (held, delta) => applyByKey(held, delta.parts, 'group', p => asleep(p) && ((p.data as GroupData).projectId ?? 'lead') === projectId) }
}

/** A `group:{id}` entry: that live group, dormant or not, or none. */
export function groupRule(key: string): PatchRule<Part<GroupData>[]> {
  return { kinds: ['group'], apply: (held, delta) => applyByKey(held, delta.parts.filter(p => p.key === key), 'group', live) }
}

const isPart = (value: unknown): value is Part =>
  !!value && typeof value === 'object' && 'kind' in value && 'key' in value && 'version' in value

/** A canonical form for comparing a patched entry with a fresh load of it: keys sorted, lists of parts sorted by kind and key,
 *  and versions left out (a touch moves a version and nothing else, and moves no stamp). */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    const items = value.map(canonical)
    return value.length && value.every(isPart)
      ? items.sort((a, b) => sortKey(a).localeCompare(sortKey(b)))
      : items
  }
  if (value instanceof Date) return value.toISOString()
  if (!value || typeof value !== 'object') return value
  const part = isPart(value)
  return Object.fromEntries(Object.keys(value).filter(key => !(part && key === 'version')).sort()
    .map(key => [key, canonical((value as Record<string, unknown>)[key])]))
}
const sortKey = (part: unknown) => `${(part as Part).kind}\u0000${(part as Part).key}`

export function cacheDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(value)) ?? 'undefined').digest('hex')
}

/** The `kind:key` of each part that is in one value and not the other, or differs between them (data, not version), at most
 *  `limit`: what a verify mismatch logs, without any data. */
export function differingKeys(a: unknown, b: unknown, limit = 20): string[] {
  const parts = (value: unknown, into = new Map<string, string>()) => {
    if (Array.isArray(value)) for (const item of value) parts(item, into)
    else if (isPart(value)) into.set(`${value.kind}:${value.key}`, cacheDigest(value))
    else if (value && typeof value === 'object') for (const item of Object.values(value)) parts(item, into)
    return into
  }
  const left = parts(a), right = parts(b)
  return [...new Set([...left.keys(), ...right.keys()])].filter(k => left.get(k) !== right.get(k)).sort().slice(0, limit)
}
