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
 *  - While one runs here, the others are watched only: every agent of a Team account is one macOS user, so typing in any of
 *    them, or starting one, is a shell that reads the confidential session's files. Only requests that read are answered,
 *    and the owner's terminal streams are watch-only, their binary input and resizes dropped (terminalStreamManager.ts
 *    `watchOnly`), streams opened before it started included.
 *  - A record or marks that cannot be read count as every session confidential.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import { dirname, join } from 'node:path'
import type { RemoteAppPolicy } from '../../core/api.js'
import { eventAgentId } from '../../core/guestPolicy.js'
import { readAuthSession } from '../../lib/authSession.js'
import { observerSnapshotFile } from '../../sharing/swarmMarks.js'
import { readTeamConfig } from '../../team/config.js'
import { TEAM_CONFIG_FILE } from '../../team/layout.js'

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
const READ_ONLY = { error: 'TEAM_READ_ONLY',
  message: 'This computer\'s Harness Team account runs a Swarm Product Manager, so its agents can be watched here but not typed in, and no agent can be started in it.' }

/** A session this daemon holds, running or stopped. */
export interface HeldSession { agentId: string; sessionId?: string | null; lead: boolean }

export interface TeamAppDeps {
  /** The sessions the Swarm's roster marked confidential here, or null when they cannot be read (readConfidentialMarks). */
  marks: () => readonly string[] | null
  /** The sessions this daemon holds, running and stopped, and whether each was launched as a Product Manager. */
  sessions: () => readonly HeldSession[]
  /** Which of them run now. */
  running: () => readonly string[]
  /** The sessions ever found confidential here, kept after they stop (confidentialRecord), and their keeping. */
  recorded: () => readonly string[]
  record: (agentIds: string[]) => void
}

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
export function createTeamAppPolicy(deps: TeamAppDeps): RemoteAppPolicy {
  /** One reading of who is confidential, for one request or event. */
  const read = () => {
    const marks = deps.marks(), sessions = deps.sessions(), recorded = new Set(deps.recorded())
    const known = new Set([...marks ?? [], ...sessions.filter(s => s.lead).map(s => s.agentId)])
    const fresh = [...known].filter(id => !recorded.has(id))
    if (fresh.length) deps.record(fresh)
    const agentOf = (id: string) => sessions.find(s => s.agentId === id || s.sessionId === id)?.agentId ?? id
    const confidential = (id: string) => {
      const agentId = agentOf(id)
      return marks === null || known.has(agentId) || recorded.has(agentId)
    }
    const running = new Set(deps.running())
    return { confidential, hosting: () => marks === null || sessions.some(s => running.has(s.agentId) && confidential(s.agentId)) }
  }
  const withoutConfidential = (payload: Record<string, unknown>, confidential: (id: string) => boolean) => {
    const kept = (item: unknown) => !named(item && typeof item === 'object' ? item as Record<string, unknown> : {}).some(confidential)
    let copy = payload
    for (const key of ['agents', 'sessions']) {
      if (Array.isArray(payload[key])) copy = { ...copy, [key]: (payload[key] as unknown[]).filter(kept) }
    }
    return copy
  }
  return {
    refuse(type, payload) {
      const r = read()
      if (named(payload).some(r.confidential)) return CONFIDENTIAL
      return !READS.has(type) && r.hosting() ? READ_ONLY : null
    },
    reply(_type, payload) {
      return withoutConfidential(payload, read().confidential)
    },
    event(frame) {
      const r = read()
      const about = eventAgentId(frame)
      if (about && r.confidential(about)) return null
      const payload = frame.payload
      return payload && typeof payload === 'object' && !Array.isArray(payload)
        ? { ...frame, payload: withoutConfidential(payload as Record<string, unknown>, r.confidential) } : frame
    },
    watchOnly: () => read().hosting(),
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

/**
 * Whether this daemon is a Harness Team account's, decided once at startup (security review 1 of #2089): the Team config
 * names this macOS user, or the daemon is signed in as a Team account (a machine used only for agents, `harness team on`).
 * A Team config that is there but cannot be read counts as this user's: the guard is installed, as it fails closed.
 */
export function isTeamDaemon(deps: { configExists?: () => boolean; config?: () => ReturnType<typeof readTeamConfig>; user?: () => string;
  signedInAsTeam?: () => boolean } = {}): boolean {
  const exists = (deps.configExists ?? (() => existsSync(TEAM_CONFIG_FILE)))()
  const config = exists ? (deps.config ?? (() => readTeamConfig()))() : null
  if (exists && (!config || config.user === (deps.user ?? (() => userInfo().username))())) return true
  return (deps.signedInAsTeam ?? (() => readAuthSession()?.kind === 'team'))()
}

/** The policy as the core's process runs it (core/main.ts), on a Team daemon: its Swarm marks and its record in [dataDir],
 *  and the sessions it holds, a Product Manager's by the Swarm role it was launched with. */
export function teamAppPolicyFor(dataDir: string, machineId: () => string,
  sessions: () => ReadonlyArray<{ agentId: string; sessionId?: string | null; swarmSkill?: { role?: string } }>,
  running: () => readonly string[]): RemoteAppPolicy {
  const record = confidentialRecord(confidentialRecordFile(dataDir))
  return createTeamAppPolicy({
    marks: () => record.unknown() ? null : readConfidentialMarks(observerSnapshotFile(dataDir, machineId()), machineId()),
    sessions: () => sessions().map(s => ({ agentId: s.agentId, sessionId: s.sessionId ?? null, lead: s.swarmSkill?.role === 'lead' })),
    running,
    recorded: record.ids,
    record: ids => record.add(ids),
  })
}
