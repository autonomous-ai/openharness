/**
 * Reading the engines' session files as their session stores declare them (engines/sessionStoreContracts.ts):
 * what a file's first record says, one file found by its id, and a conversation continued in another file. File
 * reads alone, applied with the kit, so the registry reads them as it loads without the process or tmux code of
 * session repair (lib/sessionRepair.ts), which reaches the registry back.
 */
import { sessionRoots } from '../lib/engineHomes.js'
import { continuedIn } from './kit/continuation.js'
import { findSessionFile, readFirstRecord, readIdentityFirstRecord, type SessionMeta } from './kit/sessionRecords.js'
import { sessionStoreOf } from './sessionStoreContracts.js'
import type { IdentityVersion } from './kit/identityScan.js'
import type { AgentEngine } from './types.js'

export type { SessionMeta }

/** The first record of `engine`'s session file at `path`; null for an engine that declares none, or a file that
 *  does not open with one. */
export function sessionMetaOf(engine: AgentEngine | string, path: string): SessionMeta | null {
  const first = sessionStoreOf(engine)?.first
  return first ? readFirstRecord(path, first) : null
}

/** Strict, asynchronous evidence for discovery and Stop; unrelated readers keep their compatibility API. */
export async function sessionIdentityMetaOf(engine: AgentEngine | string, path: string, expected?: IdentityVersion): Promise<SessionMeta | null> {
  const first = sessionStoreOf(engine)?.first
  return first ? readIdentityFirstRecord(path, first, expected) : null
}

/**
 * One session file found by its id under `root`, else in each of the engine's sessions folders, without scanning
 * unbounded history: for an engine whose file name holds the id (`byId.layout: 'walk'`). The daemon's own folder
 * alone missed the sub-agents of a Codex in a moved home, and its Task cards closed with no tools and no totals.
 * Null for another engine: Claude Code's project folders are listed by session repair, never walked here.
 */
export function findSessionFileOf(engine: AgentEngine | string, id: string, root?: string): string | null {
  const byId = sessionStoreOf(engine)?.byId
  if (byId?.layout !== 'walk') return null
  if (root !== undefined) return findSessionFile(id, root, byId)
  return sessionRoots(engine).reduce<string | null>((found, sessions) => found ?? findSessionFile(id, sessions, byId), null)
}

/** The file a conversation continued in, when its transcript's last record says it moved there and that file holds
 *  a turn; null for an engine that declares no continuation. */
export function continuationOf(engine: AgentEngine | string, transcriptPath: string): Promise<{ sessionId: string; transcriptPath: string } | null> {
  const rule = sessionStoreOf(engine)?.continuation
  return rule ? continuedIn(rule, transcriptPath) : Promise.resolve(null)
}
