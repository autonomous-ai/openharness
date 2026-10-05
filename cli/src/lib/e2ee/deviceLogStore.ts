/**
 * This machine's copy of its account's device key log (deviceLog.ts): the verified state, the last few
 * entries (to hand a peer that is behind, over `group_sync`), and whether the log is frozen.
 *
 * Persistence mirrors machinePeers.ts: ${ADAPTER_DATA_DIR}/e2e/devlog.json, 0600, never cached — the
 * daemon and a short-lived `harness devices …` process both read and write it. Beside it,
 * devlog.archive.json: the files of accounts this machine was signed in to before, by account id.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { env } from '../../config/env.js'
import { parseDevLogEntry, type DevLogEntry, type DevLogHead, type DevLogState } from './deviceLog.js'

/** How many of the newest entries are kept verbatim, for a peer that is behind. */
export const DEVLOG_RECENT = 64

export interface DevLogFreeze {
  /** 'fork' — two different entries at one position; 'rollback' — the backend served a log older than
   *  one already verified; 'invalid' — the backend served an entry that breaks a rule. */
  reason: 'fork' | 'rollback' | 'invalid'
  at: number
  /** The last head this machine verified before it froze. */
  lastGoodHead: DevLogHead
}

/** Another key holds this machine's id in the log, so this machine's own key cannot be registered. */
export interface DevLogConflict {
  pub: string
  label: string
  machineId: string
  addedAt: number
  seq: number
  fingerprint: string
  /** The holder joined after this machine did (its entry is past `joinedSeq`). */
  afterJoin: boolean
}

/** How many removals applied while the log was frozen are kept (for the history). */
export const DEVLOG_LOOSE = 64

/** A key that was new here (pending) and was removed before anyone marked it as seen: it stays
 *  flagged — "joined and left before you looked" — until it is dismissed. */
export interface DevLogDeparted {
  pub: string
  label: string
  kind: 'machine' | 'viewer'
  machineId: string
  fingerprint: string
  /** The `at` of the entry that added it (picked by that device). */
  addedAt: number
  /** The `at` of the entry that removed it (picked by its signer). */
  removedAt: number
  /** The key that signed the removal, and what it was called then ('' when not known). */
  removedBy: string
  removedByLabel: string
  /** It removed itself (signed out). */
  selfRemoved: boolean
}

/** How many departed keys are kept; the oldest goes first. */
export const DEVLOG_DEPARTED = 32

export interface DevLogFile {
  state: DevLogState | null
  recent: DevLogEntry[]
  frozen: DevLogFreeze | null
  /** Entries up to this seq have been announced ("New device: X") — never twice. */
  notifiedUpTo: number
  /** When THIS machine first applied each key's add. The entry's own `at` is picked by the adding
   *  device, so "new" cannot rest on it; absent for keys already in the log at first read. */
  firstSeen?: Record<string, number>
  /** The head seq this machine's first read of the log ended at: only an `add` past it is news. Absent
   *  in a file from before this existed (migrated on first use). */
  joinedSeq?: number
  /** Keys this machine trusted when it joined (or migrated): never news, whatever the log says. */
  preLog?: string[]
  /** New keys nobody has marked as seen yet. */
  pending?: string[]
  /** Keys already announced (OS notification / log line) — never twice. */
  announced?: string[]
  /** false until the "Already on your account" panel is dismissed; absent = true. */
  baselineSeen?: boolean
  /** Keys not trusted here after a fork split the lists, until `rebaseline`. */
  suspended?: string[]
  /** The head seq of the list a person last reviewed (`rebaseline --yes`): a key at or before it was
   *  looked at, so a later fork never suspends it. */
  reviewedSeq?: number
  /** Removals applied while frozen: never in `recent`, which is handed to peers as a chained tail. */
  looseRemoved?: DevLogEntry[]
  conflict?: DevLogConflict
  /** Which local sign-in this file belongs to (the syncer's `signIn()`): the file starts over when THAT
   *  changes — never because the backend says the account id did. Absent in a file from before this
   *  existed (taken to be the current sign-in's). */
  owner?: string
  /** true from the fresh write of a log until the first read of it reaches the head (or stops on a
   *  freeze): while set, whatever is verified is what was there at joining — none of it is news. */
  joining?: boolean
  /** New keys removed before anyone looked (oldest first, at most DEVLOG_DEPARTED). */
  departed?: DevLogDeparted[]
}

const empty = (): DevLogFile => ({ state: null, recent: [], frozen: null, notifiedUpTo: 0 })

const strings = <K extends string>(key: K, v: unknown): { [P in K]?: string[] } =>
  (Array.isArray(v) ? { [key]: v.filter((x): x is string => typeof x === 'string') } : {}) as { [P in K]?: string[] }

const isConflict = (v: unknown): v is DevLogConflict => {
  if (!v || typeof v !== 'object') return false
  const c = v as Record<string, unknown>
  return typeof c.pub === 'string' && typeof c.label === 'string' && typeof c.machineId === 'string'
    && typeof c.addedAt === 'number' && typeof c.seq === 'number' && typeof c.fingerprint === 'string' && typeof c.afterJoin === 'boolean'
}

const isDeparted = (v: unknown): v is DevLogDeparted => {
  if (!v || typeof v !== 'object') return false
  const d = v as Record<string, unknown>
  return typeof d.pub === 'string' && !!d.pub && typeof d.label === 'string' && (d.kind === 'machine' || d.kind === 'viewer')
    && typeof d.machineId === 'string' && typeof d.fingerprint === 'string' && typeof d.addedAt === 'number'
    && typeof d.removedAt === 'number' && typeof d.removedBy === 'string' && typeof d.removedByLabel === 'string'
    && typeof d.selfRemoved === 'boolean'
}

/** How many other accounts' files are kept (devlog.archive.json); the oldest goes first. */
export const DEVLOG_ARCHIVED = 4

/** A file as stored, normalized: anything unreadable is dropped field by field. */
function parseFile(value: unknown): DevLogFile {
  if (!value || typeof value !== 'object') return empty()
  const raw = value as Partial<DevLogFile>
  return {
    state: raw.state && typeof raw.state === 'object' ? raw.state : null,
    recent: Array.isArray(raw.recent) ? raw.recent : [],
    frozen: raw.frozen && typeof raw.frozen === 'object' ? raw.frozen : null,
    notifiedUpTo: typeof raw.notifiedUpTo === 'number' ? raw.notifiedUpTo : 0,
    firstSeen: raw.firstSeen && typeof raw.firstSeen === 'object' ? raw.firstSeen : undefined,
    ...(typeof raw.joinedSeq === 'number' && Number.isSafeInteger(raw.joinedSeq) && raw.joinedSeq >= 0 ? { joinedSeq: raw.joinedSeq } : {}),
    ...(typeof raw.reviewedSeq === 'number' && Number.isSafeInteger(raw.reviewedSeq) && raw.reviewedSeq >= 0 ? { reviewedSeq: raw.reviewedSeq } : {}),
    ...strings('preLog', raw.preLog),
    ...strings('pending', raw.pending),
    ...strings('announced', raw.announced),
    ...strings('suspended', raw.suspended),
    ...(typeof raw.baselineSeen === 'boolean' ? { baselineSeen: raw.baselineSeen } : {}),
    ...(Array.isArray(raw.looseRemoved)
      ? { looseRemoved: raw.looseRemoved.map((e) => parseDevLogEntry(e)).filter((e): e is DevLogEntry => e !== null) }
      : {}),
    ...(typeof raw.owner === 'string' && raw.owner ? { owner: raw.owner } : {}),
    ...(raw.joining === true ? { joining: true } : {}),
    ...(isConflict(raw.conflict) ? { conflict: raw.conflict } : {}),
    ...(Array.isArray(raw.departed) ? { departed: raw.departed.filter(isDeparted) } : {}),
  }
}

const trimmed = (next: DevLogFile): DevLogFile => ({
  ...next,
  recent: next.recent.slice(-DEVLOG_RECENT),
  ...(next.looseRemoved ? { looseRemoved: next.looseRemoved.slice(-DEVLOG_LOOSE) } : {}),
  ...(next.departed ? { departed: next.departed.slice(-DEVLOG_DEPARTED) } : {}),
})

export class DeviceLogStore {
  private readonly archiveFile: string

  constructor(private readonly file = join(env.ADAPTER_DATA_DIR, 'e2e', 'devlog.json')) {
    this.archiveFile = file.replace(/(\.json)?$/, '.archive.json')
  }

  read(): DevLogFile {
    try { return parseFile(JSON.parse(readFileSync(this.file, 'utf-8'))) } catch { return empty() }
  }

  write(next: DevLogFile): void {
    this.writeJson(this.file, trimmed(next))
  }

  update(change: (current: DevLogFile) => DevLogFile): DevLogFile {
    const next = change(this.read())
    this.write(next)
    return next
  }

  /** Keep `file` — the log of an account this machine is leaving — to restore if it comes back. */
  archive(file: DevLogFile): void {
    if (!file.state) return
    const all = this.archived()
    delete all[file.state.acct]
    all[file.state.acct] = trimmed(file)
    const accts = Object.keys(all)
    for (const acct of accts.slice(0, Math.max(0, accts.length - DEVLOG_ARCHIVED))) delete all[acct]
    this.writeJson(this.archiveFile, all)
  }

  /** The kept file of `acct`, made the live one (as `place` has it) and only then taken out of the
   *  archive — a crash in between leaves it in both, never in neither. null when there is none. */
  restore(acct: string, place: (kept: DevLogFile) => DevLogFile = (kept) => kept): DevLogFile | null {
    const kept = this.archived()[acct]
    if (!kept?.state || kept.state.acct !== acct) return null
    const live = place(kept)
    this.write(live)
    const all = this.archived()
    delete all[acct]
    this.writeJson(this.archiveFile, all)
    return live
  }

  /** The kept file of `acct`, left in the archive; null when there is none. */
  archivedFile(acct: string): DevLogFile | null {
    const kept = this.archived()[acct]
    return kept?.state && kept.state.acct === acct ? kept : null
  }

  /** A suspension lifted here holds for every kept account too: none of them keeps the key out. */
  unsuspendArchived(pubs: readonly string[]): void {
    if (!pubs.length) return
    const all = this.archived()
    let changed = false
    for (const f of Object.values(all)) {
      const kept = (f.suspended ?? []).filter((k) => !pubs.includes(k))
      if (kept.length !== (f.suspended ?? []).length) { f.suspended = kept; changed = true }
    }
    if (changed) this.writeJson(this.archiveFile, all)
  }

  /** Every key a fork suspended in an archived account's file: never trusted from another log. */
  archivedSuspended(): string[] {
    return [...new Set(Object.values(this.archived()).flatMap((f) => f.suspended ?? []))]
  }

  private archived(): Record<string, DevLogFile> {
    try {
      const raw = JSON.parse(readFileSync(this.archiveFile, 'utf-8')) as unknown
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
      return Object.fromEntries(Object.entries(raw as Record<string, unknown>).map(([acct, f]) => [acct, parseFile(f)]))
    } catch { return {} }
  }

  /** Written whole or not at all: a torn file would read as no file, and start the log over. */
  private writeJson(path: string, value: unknown): void {
    mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 })
    const temp = `${path}.${process.pid}.${Date.now()}.tmp`
    try {
      writeFileSync(temp, JSON.stringify(value), { mode: 0o600 })
      renameSync(temp, path)
    } finally {
      try { rmSync(temp, { force: true }) } catch { /* gone with the rename */ }
    }
  }
}
