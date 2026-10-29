/**
 * What a Harness Team daemon's own account's apps may ask of it and hear from it (#895). The Team account is a machine in
 * the Mac owner's own Harness account, and the owner's apps select it like any of theirs (backend lib/teamSession.ts). Once
 * the Swarm runs another person's Product Manager there, that would let the Mac's owner attach to it and read or type in
 * people's private chats with it, past every rule the Swarm keeps (backend projects.ts teamSessionAccess). So, from the
 * owner's apps (backendSocket.ts `remoteAppPolicy`, set on a Team daemon alone):
 *
 *  - A confidential session (the Swarm's marks: a Product Manager, or an agent in a private chat; and any session launched
 *    as a Product Manager here, before a roster marks it) is never reached, listed or heard of.
 *  - While one runs here, the other agents are watched only: every agent of a Team account is one macOS user, so typing in
 *    any of them, or starting one, is a shell that reads the confidential session's saved files. Only the requests that
 *    read are answered.
 *  - Marks that cannot be read count as every session confidential.
 *
 * With no confidential session here, and on any daemon that is not a Team account, nothing changes.
 */
import { readFileSync } from 'node:fs'
import type { RemoteAppPolicy } from '../../core/api.js'
import { readAuthSession } from '../../lib/authSession.js'
import { observerSnapshotFile } from '../../sharing/swarmMarks.js'

/** Answered while a confidential session runs here: each only reads, and those naming an agent only a non-confidential one.
 *  The terminal stream's own frames are scoped to a stream `terminal_open` admitted; its input frames are not here. */
const READS: ReadonlySet<string> = new Set([
  'agents_list', 'sessions_list', 'session_get', 'agent_recent', 'engines_probe', 'theme_set', 'usage_read',
  'terminal_capabilities', 'terminal_open', 'terminal_info', 'terminal_alive', 'terminal_ack', 'terminal_resize',
  'terminal_scroll', 'terminal_resync', 'terminal_close',
])

const CONFIDENTIAL = { error: 'SWARM_CONFIDENTIAL',
  message: 'This agent runs in this computer\'s Harness Team account and holds people\'s private chats in a Swarm, so it is not shown here.' }
const READ_ONLY = { error: 'TEAM_READ_ONLY',
  message: 'This computer\'s Harness Team account runs a Swarm Product Manager, so its agents can be watched here but not typed in, and no agent can be started in it.' }

export interface TeamAppDeps {
  /** Whether this daemon is signed in as a Harness Team account. */
  team: () => boolean
  /** The sessions the Swarm marked confidential here, or null when its marks cannot be read (readConfidentialMarks). */
  marks: () => readonly string[] | null
  /** The sessions registered here, and whether each was launched as a Product Manager. */
  sessions: () => ReadonlyArray<{ agentId: string; lead: boolean }>
}

export function createTeamAppPolicy(deps: TeamAppDeps): RemoteAppPolicy {
  /** Whether [agentId] is confidential, or null on a daemon this guard leaves alone. Read once per call. */
  const reader = () => {
    if (!deps.team()) return null
    const marks = deps.marks(), leads = new Set(deps.sessions().filter(s => s.lead).map(s => s.agentId))
    const confidential = (agentId: string) => marks === null || marks.includes(agentId) || leads.has(agentId)
    return { confidential, hosting: () => marks === null || deps.sessions().some(s => confidential(s.agentId)) }
  }
  const withoutConfidential = (payload: Record<string, unknown>, confidential: (agentId: string) => boolean) => {
    const kept = (item: unknown) => {
      const row = item as { id?: unknown; agentId?: unknown } | null
      const id = typeof row?.id === 'string' ? row.id : typeof row?.agentId === 'string' ? row.agentId : null
      return id === null || !confidential(id)
    }
    let copy = payload
    for (const key of ['agents', 'sessions']) {
      if (Array.isArray(payload[key])) copy = { ...copy, [key]: (payload[key] as unknown[]).filter(kept) }
    }
    return copy
  }
  return {
    refuse(type, payload) {
      const read = reader()
      if (!read) return null
      const agentId = typeof payload.agentId === 'string' ? payload.agentId : null
      if (agentId && read.confidential(agentId)) return CONFIDENTIAL
      if (!READS.has(type) && read.hosting()) return READ_ONLY
      return null
    },
    reply(_type, payload) {
      const read = reader()
      return read ? withoutConfidential(payload, read.confidential) : payload
    },
    event(frame) {
      const read = reader()
      if (!read) return frame
      const payload = (frame.payload ?? null) as { agentId?: unknown; agent?: { id?: unknown } } | null
      const about = [frame.agentId, payload?.agentId, payload?.agent?.id].find((id): id is string => typeof id === 'string' && !!id)
      if (about && read.confidential(about)) return null
      return payload && typeof payload === 'object' ? { ...frame, payload: withoutConfidential(payload as Record<string, unknown>, read.confidential) } : frame
    },
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

/** The policy as the core's process runs it (core/main.ts): this daemon's sign-in, its Swarm marks in [dataDir], and the
 *  sessions its registry holds, a Product Manager's by the Swarm role it was launched with. */
export function teamAppPolicyFor(dataDir: string, machineId: () => string,
  sessions: () => ReadonlyArray<{ agentId: string; swarmSkill?: { role?: string } }>): RemoteAppPolicy {
  return createTeamAppPolicy({
    team: () => readAuthSession()?.kind === 'team',
    marks: () => readConfidentialMarks(observerSnapshotFile(dataDir, machineId()), machineId()),
    sessions: () => sessions().map(s => ({ agentId: s.agentId, lead: s.swarmSkill?.role === 'lead' })),
  })
}
