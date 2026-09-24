/**
 * What this daemon remembers about each grid: what it serves, in exact letter case, and when it was
 * last seen awake — so every picker is answered at once, and a sleeping grid shows its last known models
 * instead of vanishing.
 *
 * Pure: no I/O and no clock of its own (`now` is passed in), so the rules below are the whole of it.
 *
 * **The rule every function here keeps: a row is REMOVED only on positive evidence** — the grid's own
 * answer or record, or this computer's own run records. Everything that is not evidence leaves the list
 * stale, never shorter, and never wakes anything.
 */
import type { LastKnown, ReadNode } from './gridReader.js'

/**
 * How long a model must be missing from awake answers before it leaves the list — one node TTL (120s on
 * the master) plus one 30s heartbeat from a pre-0.3.48 provider. A just-woken master has not heard from
 * its providers, so without this the read that follows a wake blanks every list. ⚠️ Cross-repo timing
 * (the lockstep register); the public repo's pin finds it by this exact name.
 */
export const GRID_MODEL_RETENTION_MS = 150_000

/**
 * …and across at least this many awake answers. Implied today — the window is measured from the FIRST
 * answer that missed a model, so it can only have elapsed by a later one (a mutation that drops this
 * floor survives every test for exactly that reason) — and kept as the spec's own statement of the rule,
 * so that measuring the window from anything earlier cannot let one read after a long silence count as
 * the whole of it.
 */
const MIN_ABSENT_READS = 2

/**
 * A sleep record older than this is ignored: the master forgets node rows after 30 days asleep, so an
 * older record lists models nobody serves any more. ⚠️ Cross-repo timing, found by this exact name.
 */
export const GRID_LAST_KNOWN_MAX_AGE_MS = 29 * 24 * 60 * 60 * 1000

/** Engines that are a router rather than a model (`grid-router` serves `auto`) are never offered. */
const ROUTER_ENGINE = 'grid-router'

/**
 * `awake` — the last read answered. `asleep` — the platform says it is resting. `unknown` — the last
 * read failed any other way, or nothing has been read yet (the list shown, if any, is the last known).
 * `waking` — a person asked for it to start (issue 03's explicit wake; never set by a read).
 */
export type PictureState = 'awake' | 'asleep' | 'waking' | 'unknown'

export interface PictureModel {
  /** The id without case — the join key across sources. Its spelling lives in `caseMap`. */
  key: string
  /** When a read last listed it (for a record, when the record was taken). */
  seenAt: number
  /** The first awake read it was missing from, while it has been missing since; null when listed. */
  absentSince: number | null
  /** How many awake reads in a row it has been missing from. */
  absentReads: number
}

export interface PictureNode {
  /** The node's published name — the machine's, or the anonymous label the grid gives it. */
  name: string
  engine: string
  /** The account's own node, as the last live read said (its published provider). Never guessed. */
  isMine: boolean
  models: PictureModel[]
}

export interface GridPicture {
  spec: 1
  state: PictureState
  /** The last AWAKE read, epoch ms. */
  seenAt: number | null
  /** When the node list below was true — the last awake read, or the record it came from. */
  listAt: number | null
  nodes: PictureNode[]
  /** lower-case id → exact id. */
  caseMap: Record<string, string>
}

export function emptyPicture(): GridPicture {
  return { spec: 1, state: 'unknown', seenAt: null, listAt: null, nodes: [], caseMap: {} }
}

/** The join key for a model id across every source: trimmed, without case. (Not `localModels.ts`'s own
 *  private key, which also strips `.gguf` for a different comparison.) */
export const idKey = (id: string): string => id.trim().toLowerCase()
const hasUpperCase = (id: string): boolean => id !== id.toLowerCase()

/**
 * `caseMap` with `ids` folded in. The first spelling of a name wins, except that one carrying an
 * upper-case letter always replaces an all-lower-case one: the lower-case form is what the overview
 * already showed, so it is never the better answer — and it never overwrites a better one.
 */
export function withSpellings(caseMap: Record<string, string>, ids: readonly string[]): Record<string, string> {
  let next = caseMap
  for (const raw of ids) {
    const exact = raw.trim()
    const key = idKey(exact)
    if (!key) continue
    const known = next[key]
    if (known === undefined || (!hasUpperCase(known) && hasUpperCase(exact))) {
      if (next === caseMap) next = { ...caseMap }
      next[key] = exact
    }
  }
  return next
}

/** Whether some model an awake answer names has no spelling yet — the only reason discovery is read. */
export function unspelled(picture: GridPicture, nodes: readonly ReadNode[]): string[] {
  const missing = new Set<string>()
  for (const node of nodes) {
    for (const model of node.models) {
      const key = idKey(model)
      if (key && picture.caseMap[key] === undefined && !hasUpperCase(model)) missing.add(key)
    }
  }
  return [...missing]
}

const listed = (key: string, at: number): PictureModel => ({ key, seenAt: at, absentSince: null, absentReads: 0 })

function nodeFrom(read: { name: string; engine: string; models: string[] }, at: number, isMine: boolean): PictureNode {
  const keys = [...new Set(read.models.map(idKey).filter(Boolean))]
  return { name: read.name, engine: read.engine, isMine, models: keys.map((key) => listed(key, at)) }
}

/**
 * An awake answer merged in, per model. A model the answer does not list stays until it has been missing
 * for [GRID_MODEL_RETENTION_MS] across at least two awake answers — so a cold wake that answers empty
 * blanks nothing — unless `provenStopped` says this computer itself stopped serving it, which is positive
 * evidence and takes effect at once.
 *
 * Previous entries are paired with live ones by name and engine, first fit, so two same-named machines
 * stay two entries.
 */
export function mergeAwake(
  previous: GridPicture,
  nodes: readonly ReadNode[],
  now: number,
  isMine: (node: ReadNode) => boolean,
  provenStopped: (name: string, key: string) => boolean,
): GridPicture {
  const live = nodes.map((node) => nodeFrom(node, now, isMine(node)))
  const paired = new Set<PictureNode>()
  const kept: PictureNode[] = []
  const carry = (entry: PictureNode, model: PictureModel): PictureModel | null => {
    if (provenStopped(entry.name, model.key)) return null
    const absentSince = model.absentSince ?? now
    const absentReads = model.absentReads + 1
    const gone = now - absentSince >= GRID_MODEL_RETENTION_MS && absentReads >= MIN_ABSENT_READS
    return gone ? null : { ...model, absentSince, absentReads }
  }
  for (const entry of previous.nodes) {
    const match = live.find((node) => !paired.has(node) && node.name === entry.name && node.engine === entry.engine)
    const carried = entry.models.flatMap((model) => {
      if (match?.models.some((current) => current.key === model.key)) return []
      const next = carry(entry, model)
      return next ? [next] : []
    })
    if (match) {
      paired.add(match)
      match.models.push(...carried)
    } else if (carried.length) {
      kept.push({ ...entry, models: carried })
    }
  }
  return { ...previous, state: 'awake', seenAt: now, listAt: now, nodes: [...live, ...kept] }
}

/**
 * The asleep answer taken in. Its record, when there is one, is a read made `ageSeconds` ago: it replaces
 * the node entries only when it is not older than the last awake read, and a record past
 * [GRID_LAST_KNOWN_MAX_AGE_MS] is ignored. `isMine` carries over only when exactly one previous entry had
 * that name — a record never says whose a machine is.
 */
export function withAsleep(previous: GridPicture, lastKnown: LastKnown | null, now: number): GridPicture {
  const asleep: GridPicture = { ...previous, state: 'asleep' }
  if (!lastKnown) return asleep
  const ageMs = lastKnown.ageSeconds * 1000
  if (ageMs > GRID_LAST_KNOWN_MAX_AGE_MS) return asleep
  const takenAt = now - ageMs
  const spelled = { ...asleep, caseMap: withSpellings(previous.caseMap, lastKnown.ids) }
  if (previous.seenAt !== null && takenAt < previous.seenAt) return spelled
  const mine = (name: string): boolean => {
    const same = previous.nodes.filter((node) => node.name === name)
    return same.length === 1 && same[0]!.isMine
  }
  return {
    ...spelled,
    listAt: takenAt,
    nodes: lastKnown.nodes.map((node) => nodeFrom(node, takenAt, mine(node.name))),
  }
}

/** A read that failed: the state says so, and every row stays exactly as it was. */
export function withUnknown(previous: GridPicture): GridPicture {
  return { ...previous, state: 'unknown' }
}

/** One of this computer's own run records for a grid, as `servedHere` reads it. */
export interface LocalRecord {
  /** The node name it registers under (`meta_name`). */
  name: string
  /** What it advertises, in the case it advertised it. */
  ids: string[]
  /** An integer > 0 while a process holds it; null while a join is mid-spawn (it writes `pid: 0`). */
  pid: number | null
  /** Whether that pid is a live process. False for a null pid. */
  alive: boolean
}

/**
 * What this computer's own records prove about a grid's rows — never decided by hostname, the machine
 * list, or the heartbeat sidecar (the sidecar goes stale while a healthy provider is parked).
 *
 * `seen` is what this daemon has watched a LIVE record serve since the grid's last awake read, keyed
 * `name\0key`; the caller rebuilds it at every awake read and adds to it at every look.
 */
export interface ServedHere {
  records: readonly LocalRecord[]
  seen: ReadonlySet<string>
  /** The account's own grid, where every node is the account's. */
  own: boolean
}

export const servedKey = (name: string, key: string): string => `${name}\u0000${key}`

/**
 * Whether this computer has positive evidence that `entry` no longer serves `key`. All must hold: a live
 * record here was seen serving it since the last awake read; no record serves it now, or every one that
 * does names a pid that no longer exists (a pid-0 record is a join mid-spawn — not evidence); exactly one
 * entry in the picture carries that name (so a same-named machine elsewhere is never touched); and the
 * grid is the account's own, or the entry is marked as the account's.
 */
export function provenStopped(picture: GridPicture, here: ServedHere, name: string, key: string): boolean {
  if (!here.seen.has(servedKey(name, key))) return false
  const serving = here.records.filter((record) => record.name === name && record.ids.some((id) => idKey(id) === key))
  if (serving.some((record) => record.pid === null || record.alive)) return false
  const same = picture.nodes.filter((node) => node.name === name)
  if (same.length !== 1) return false
  return here.own || same[0]!.isMine
}

/** One row of the picker's section: the id an engine is pointed at, and which machine answers it. */
export interface GridModelRow {
  id: string
  node: string
}

export interface SectionView {
  models: GridModelRow[]
  state: PictureState
  /** ISO-8601 of the last awake read. */
  seenAt: string | null
  /** How old the list shown is, in whole seconds. */
  lastKnownAge: number | null
}

/**
 * What the picker is told about one grid. While the grid is not awake, this computer's own live records
 * are shown under its name (a model this computer serves is never "set up your first model"), and a row
 * this computer has proof it stopped is taken out at once.
 */
export function sectionView(picture: GridPicture, here: ServedHere, now: number): SectionView {
  const awake = picture.state === 'awake'
  const caseMap = withSpellings(picture.caseMap, here.records.flatMap((record) => record.ids))
  const rows: GridModelRow[] = []
  const offered = new Set<string>()
  const offer = (key: string, node: string): void => {
    if (!key || offered.has(key)) return
    offered.add(key)
    rows.push({ id: caseMap[key] ?? key, node })
  }
  for (const node of picture.nodes) {
    if (node.engine === ROUTER_ENGINE) continue
    for (const model of node.models) {
      if (!awake && provenStopped(picture, here, node.name, model.key)) continue
      offer(model.key, node.name)
    }
  }
  if (!awake) {
    for (const record of here.records) {
      if (record.pid === null || !record.alive) continue
      for (const id of record.ids) offer(idKey(id), record.name)
    }
  }
  return {
    models: rows,
    state: picture.state,
    seenAt: picture.seenAt === null ? null : new Date(picture.seenAt).toISOString(),
    lastKnownAge: picture.listAt === null ? null : Math.max(0, Math.round((now - picture.listAt) / 1000)),
  }
}

/** Bounds on a picture read back from disk — the same as on an answer read off the wire (`gridReader.ts`),
 *  except the spellings, which accumulate across answers, records and discovery rather than arriving in
 *  one. A file past them is cut, never trusted to be small. */
const MAX_SAVED_NODES = 256
const MAX_SAVED_MODELS_PER_NODE = 256
const MAX_SAVED_TEXT = 256
const MAX_SAVED_SPELLINGS = 4096

/** A picture read back from disk, or null when it is not one this module wrote. Never trusts the file. */
export function parsePicture(value: unknown): GridPicture | null {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
  if (!record || record.spec !== 1) return null
  const states: PictureState[] = ['awake', 'asleep', 'waking', 'unknown']
  const time = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null
  const str = (v: unknown): string => typeof v === 'string' ? v.slice(0, MAX_SAVED_TEXT) : ''
  if (!states.includes(record.state as PictureState) || !Array.isArray(record.nodes)) return null
  const nodes: PictureNode[] = []
  for (const raw of record.nodes.slice(0, MAX_SAVED_NODES)) {
    if (!raw || typeof raw !== 'object' || !Array.isArray((raw as PictureNode).models)) continue
    const node = raw as Record<string, unknown>
    const models = (node.models as unknown[]).slice(0, MAX_SAVED_MODELS_PER_NODE).flatMap((m): PictureModel[] => {
      const model = m as Record<string, unknown> | null
      const seenAt = time(model?.seenAt)
      const key = str(model?.key)
      if (!model || !key || seenAt === null) return []
      const absentReads = typeof model.absentReads === 'number' && Number.isInteger(model.absentReads) && model.absentReads >= 0 ? model.absentReads : 0
      return [{ key, seenAt, absentSince: time(model.absentSince), absentReads }]
    })
    nodes.push({ name: str(node.name), engine: str(node.engine), isMine: node.isMine === true, models })
  }
  const caseMap: Record<string, string> = {}
  if (record.caseMap && typeof record.caseMap === 'object' && !Array.isArray(record.caseMap)) {
    for (const [key, exact] of Object.entries(record.caseMap as Record<string, unknown>).slice(0, MAX_SAVED_SPELLINGS)) {
      if (typeof exact === 'string' && exact && idKey(exact) === key) caseMap[key] = exact.slice(0, MAX_SAVED_TEXT)
    }
  }
  return {
    spec: 1,
    // Waking is a person's request in flight, and that request died with the process that made it.
    state: record.state === 'waking' ? 'unknown' : record.state as PictureState,
    seenAt: time(record.seenAt),
    listAt: time(record.listAt),
    nodes,
    caseMap,
  }
}
