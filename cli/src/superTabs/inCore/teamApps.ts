/**
 * What a Harness Team daemon's own account's apps may ask of it and hear from it (#895). The Team account is a machine in
 * the Mac owner's own Harness account, and the owner's apps select it like any of theirs (backend lib/teamSession.ts). Once
 * the Swarm runs another person's Product Manager there, that would let the Mac's owner attach to it and read or type in
 * people's private chats with it, past every rule the Swarm keeps (backend projects.ts teamSessionAccess). So, from the
 * owner's apps (backendSocket.ts `remoteAppPolicy`), on a Team daemon only, decided once at startup (`isTeamDaemon`):
 *
 *  - A confidential session is never reached, listed or heard of: one the Swarm's roster marked (a Product Manager, or an
 *    agent in a private chat), one launched here as a Product Manager before any roster marks it, and either of those after
 *    it stopped (the record kept in `confidentialRecordFile`). Every field of a request that can name a session, an agent's
 *    id or its engine's session id, is resolved to the agent first (security review 1 of #2089: `session_get` names a
 *    session by `sessionId`, which also finds an agent by its id).
 *  - While one is here, running or stopped (it may resume), the others are watched only: every agent of a Team account is one macOS user, so typing in any of
 *    them, or starting one, is a shell that reads the confidential session's files. Only requests that read are answered,
 *    and the owner's terminal streams are watch-only, their binary input and resizes dropped (terminalStreamManager.ts
 *    `watchOnly`), streams opened before it started included.
 *  - A record or marks that cannot be read count as every session confidential.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { RemoteAppPolicy } from '../../core/api.js'
import { eventAgentId } from '../../core/guestPolicy.js'
import { observerSnapshotFile } from '../../sharing/swarmMarks.js'
import type { PurgeRecord } from './teamPurge.js'
export { isTeamDaemon, pmEngineHome, PM_HOMES } from '../teamDaemon.js'
export { createConfidentialPurge, purgeRecord } from './teamPurge.js'

/** Answered while a confidential session runs here: each only reads, and those naming a session only a non-confidential one.
 *  A terminal stream's frames are its own (terminalStreamManager.ts): it is watch-only, and only these reach it. */
const READS: ReadonlySet<string> = new Set([
  'agents_list', 'sessions_list', 'session_get', 'agent_recent', 'engines_probe', 'theme_set', 'usage_read',
  'terminal_capabilities', 'terminal_open', 'terminal_info', 'terminal_alive', 'terminal_ack', 'terminal_resync', 'terminal_close',
])
/** The fields of a request that can name a session: an agent's id, or its engine's session id. */
const SESSION_FIELDS = ['agentId', 'sessionId', 'id', 'harnessId', 'parentAgentId', 'resumeSessionId', 'expectedSessionId'] as const
const SESSION_LISTS = ['agentIds', 'sessionIds', 'agents', 'sessions'] as const

const CONFIDENTIAL = { error: 'SWARM_CONFIDENTIAL',
  message: 'This agent runs in this computer\'s Harness Team account and holds people\'s private chats in a Swarm, so it is not shown here.' }
/** Its marks, or its record, are there but could not be read, or a reading failed (security re-check 3 of #2089). */
const COULD_NOT_READ = { error: 'SWARM_CONFIDENTIAL',
  message: 'This computer\'s Harness Team account could not read its Swarm\'s settings, so its agents are not shown here.' }
const COULD_NOT_READ_ONLY = { error: 'TEAM_READ_ONLY',
  message: 'This computer\'s Harness Team account could not read its Swarm\'s settings, so its agents can be watched here but not typed in, and no agent can be started in it.' }
/** A Team daemon whose Swarm has not yet sent it any marks. */
const UNKNOWN = { error: 'SWARM_CONFIDENTIAL',
  message: 'This computer\'s Harness Team account has not heard from its Swarm yet, so its agents are not shown here until it does.' }
const UNKNOWN_READ_ONLY = { error: 'TEAM_READ_ONLY',
  message: 'This computer\'s Harness Team account has not heard from its Swarm yet, so its agents can be watched here but not typed in, and no agent can be started in it until it does.' }
const READ_ONLY = { error: 'TEAM_READ_ONLY',
  message: 'This computer\'s Harness Team account runs a Swarm Product Manager, so its agents can be watched here but not typed in, and no agent can be started in it.' }

/** A session this daemon holds, running or stopped. */
export interface HeldSession { agentId: string; sessionId?: string | null; lead: boolean }

export interface TeamAppDeps {
  /** The sessions the Swarm's roster marked confidential here, or null when they cannot be read (readConfidentialMarks).
   *  Read every time: teamAppPolicyFor reads the file again only when it changed. */
  marks: () => readonly string[] | null
  /** Whether the Swarm has sent any marks here: null marks then could not be read, rather than not come yet. */
  heard?: () => boolean
  /** The sessions this daemon runs, from memory, read every time, and whether each was launched as a Product Manager. */
  live: () => readonly HeldSession[]
  /** The sessions it keeps stopped, listed from disk: the one read kept for READING_MS. */
  stopped: () => readonly HeldSession[]
  /** The sessions ever found confidential here, by agent id and engine session id, kept after they stop
   *  (confidentialRecord), and their keeping. */
  recorded: () => readonly string[]
  record: (ids: string[]) => void
  /** The purges still to finish (inCore/teamPurge.ts), and whether their record could not be read: each keeps the account
   *  held, its session closed, until it finishes (security re-check 3 of #2089). */
  purging?: () => { ids: readonly string[]; unknown: boolean }
  now?: () => number
}

/** How long one listing of the stopped sessions on disk serves: every frame of a burst (a turn's deltas) asks (security
 *  re-review of #2089). Only that listing: what runs, the record and the marks are read every time, so a Product Manager
 *  registered, or a session marked, is closed at once (its re-check 1). A stopped session ran first, and was read then. */
export const READING_MS = 500
/** How deep the rows of an answer are looked for: an answer's lists, and the lists inside its objects and rows. */
const ROW_DEPTH = 4

/** The sessions a request or a row names, by every field and list that can name one. */
function named(payload: Record<string, unknown>): string[] {
  const ids: string[] = []
  const add = (value: unknown) => { if (typeof value === 'string' && value) ids.push(value) }
  for (const field of SESSION_FIELDS) add(payload[field])
  for (const field of SESSION_LISTS) {
    const items = payload[field]
    if (!Array.isArray(items)) continue
    for (const item of items) {
      if (typeof item === 'string') add(item)
      else if (item && typeof item === 'object') for (const key of SESSION_FIELDS) add((item as Record<string, unknown>)[key])
    }
  }
  return ids
}

/** The policy of a Team daemon. Installed only there (core/main.ts, `isTeamDaemon`). */
export function createTeamAppPolicy(deps: TeamAppDeps): RemoteAppPolicy & { isConfidential(id: string): boolean } {
  const now = deps.now ?? Date.now
  /** Every session confidential, and the account held: what anything that fails reads as. */
  const closed = { failed: true, unknown: true, heard: true, confidential: (_id: string) => true, hosting: true }
  let stoppedAt = -Infinity, stoppedHeld: readonly HeldSession[] = []
  const stopped = () => {
    const at = now()
    if (at - stoppedAt >= READING_MS || at < stoppedAt) { stoppedHeld = deps.stopped(); stoppedAt = at }
    return stoppedHeld
  }
  /** One reading of who is confidential. It runs inside the daemon's broadcast, so it never throws: a reading that fails,
   *  its record's write included, is the closed one (security re-review of #2089). */
  const read = (): typeof closed => {
    try {
      const marks = deps.marks(), sessions = [...deps.live(), ...stopped()], recorded = new Set(deps.recorded())
      const purging = deps.purging?.() ?? { ids: [], unknown: false }
      const known = new Set([...marks ?? [], ...sessions.filter(s => s.lead).map(s => s.agentId), ...purging.ids])
      // Its engine's session id too: the same conversation registered again under a new agent id stays closed.
      const keep = [...known, ...sessions.flatMap(s => known.has(s.agentId) && s.sessionId ? [s.sessionId] : [])]
      const fresh = [...new Set(keep)].filter(id => !recorded.has(id))
      if (fresh.length) deps.record(fresh)
      const confidential = (id: string) => {
        if (marks === null || recorded.has(id) || known.has(id)) return true
        const held = sessions.find(s => s.agentId === id || s.sessionId === id)
        return !!held && (known.has(held.agentId) || recorded.has(held.agentId) || (!!held.sessionId && recorded.has(held.sessionId)))
      }
      // Held while any confidential session is here, running or stopped: a stopped one may resume (a crash, a restart, a
      // limit). Its data deleted once the Swarm ends it for good (createConfidentialPurge), the account is released.
      return { failed: false, unknown: marks === null, heard: marks !== null || !!deps.heard?.(), confidential,
        hosting: marks === null || purging.unknown || purging.ids.length > 0 || sessions.some(s => confidential(s.agentId)) }
    } catch {
      stoppedAt = -Infinity
      return closed
    }
  }
  const withoutConfidential = (payload: Record<string, unknown>, confidential: (id: string) => boolean) => {
    const names = (row: Record<string, unknown>) => named(row).some(confidential)
      || Object.values(row).some(v => !!v && typeof v === 'object' && !Array.isArray(v) && named(v as Record<string, unknown>).some(confidential))
    const walk = (value: unknown, depth: number): unknown => {
      if (depth > ROW_DEPTH || !value || typeof value !== 'object') return value
      // Only plain objects and lists: a Date, a Buffer or a class instance is left as it is (security re-check 2 of #2089).
      const plain = Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null
      if (!Array.isArray(value) && !plain) return value
      if (Array.isArray(value)) {
        return value.filter(item => !(item && typeof item === 'object' && !Array.isArray(item) && names(item as Record<string, unknown>)))
          .map(item => walk(item, depth + 1))
      }
      return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, walk(v, depth + 1)]))
    }
    return walk(payload, 0) as Record<string, unknown>
  }
  return {
    refuse(type, payload) {
      const r = read()
      if (r.failed || named(payload).some(r.confidential)) return !r.unknown ? CONFIDENTIAL : r.heard ? COULD_NOT_READ : UNKNOWN
      return !READS.has(type) && r.hosting ? (!r.unknown ? READ_ONLY : r.heard ? COULD_NOT_READ_ONLY : UNKNOWN_READ_ONLY) : null
    },
    reply(_type, payload) {
      return withoutConfidential(payload, read().confidential)
    },
    event(frame) {
      const r = read()
      const about = eventAgentId(frame)
      if (r.failed || (about && r.confidential(about))) return null
      const payload = frame.payload
      return payload && typeof payload === 'object' && !Array.isArray(payload)
        ? { ...frame, payload: withoutConfidential(payload as Record<string, unknown>, r.confidential) } : frame
    },
    watchOnly: () => read().hosting,
    isConfidential: (id) => read().confidential(id),
  }
}

/** The sessions the Swarm's last roster marked confidential on [machineId] (superTabs/observers.ts writes them), or null
 *  when the snapshot is missing, unreadable or another machine's: the guard then counts every session confidential. */
export function readConfidentialMarks(file: string, machineId: string): string[] | null {
  try {
    const saved = JSON.parse(readFileSync(file, 'utf8')) as { machineId?: unknown; confidential?: unknown } | null
    if (!saved || saved.machineId !== machineId || !Array.isArray(saved.confidential)) return null
    return saved.confidential.filter((id): id is string => typeof id === 'string')
  } catch { return null }
}

/** Where a Team daemon keeps every session it found confidential, so a stopped one stays closed to the owner's apps. */
export const confidentialRecordFile = (dataDir: string): string => join(dataDir, 'super-tabs', 'team-confidential.json')
/** The most it keeps: far more Product Managers than one Team account runs in its life; the oldest go first. */
export const CONFIDENTIAL_RECORD_MAX = 2_000

/** The record at [file], and its keeping: written whole through a temporary file, newest last. A record there but unreadable
 *  stays unknown (`unknown`), and the policy then counts every session confidential. */
export function confidentialRecord(file: string) {
  const load = (): { ids: string[]; unknown: boolean } => {
    if (!existsSync(file)) return { ids: [], unknown: false }
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8')) as unknown
      if (!Array.isArray(saved)) return { ids: [], unknown: true }
      return { ids: saved.filter((id): id is string => typeof id === 'string'), unknown: false }
    } catch { return { ids: [], unknown: true } }
  }
  let held = load()
  return {
    ids: (): readonly string[] => held.ids,
    unknown: (): boolean => held.unknown,
    add(ids: string[]): void {
      const next = [...held.ids.filter(id => !ids.includes(id)), ...ids].slice(-CONFIDENTIAL_RECORD_MAX)
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
      writeFileSync(`${file}.next`, JSON.stringify(next), { mode: 0o600 })
      renameSync(`${file}.next`, file)
      held = { ids: next, unknown: held.unknown }
    },
  }
}

/** The policy as the core's process runs it (core/main.ts), on a Team daemon: its Swarm marks and its record in [dataDir],
 *  the sessions it runs and those it keeps stopped, a Product Manager's by the Swarm role it was launched with. The marks
 *  file is read again only when its size or time changed: one stat a reading. */
export function teamAppPolicyFor(dataDir: string, machineId: () => string,
  live: () => ReadonlyArray<{ agentId: string; sessionId?: string | null; swarmSkill?: { role?: string } }>,
  stopped: () => ReadonlyArray<{ agentId: string; sessionId?: string | null; swarmSkill?: { role?: string } }>, purges?: PurgeRecord) {
  const record = confidentialRecord(confidentialRecordFile(dataDir))
  const held = (rows: ReadonlyArray<{ agentId: string; sessionId?: string | null; swarmSkill?: { role?: string } }>) =>
    rows.map(s => ({ agentId: s.agentId, sessionId: s.sessionId ?? null, lead: s.swarmSkill?.role === 'lead' }))
  let seen: { key: string; marks: string[] | null } | null = null
  const marks = () => {
    if (record.unknown()) return null
    const file = observerSnapshotFile(dataDir, machineId())
    let key: string
    try { const info = statSync(file); key = `${file}\n${info.size}\n${info.mtimeMs}\n${machineId()}` } catch { return null }
    if (seen?.key !== key) seen = { key, marks: readConfidentialMarks(file, machineId()) }
    return seen.marks
  }
  return createTeamAppPolicy({ marks, heard: () => existsSync(observerSnapshotFile(dataDir, machineId())), live: () => held(live()), stopped: () => held(stopped()),
    recorded: record.ids, record: ids => record.add(ids),
    ...(purges ? { purging: () => ({ ids: purges.pending().map(t => t.agentId), unknown: purges.unknown() }) } : {}) })
}
