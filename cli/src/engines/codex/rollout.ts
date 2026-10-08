/**
 * Codex's rollouts, read as its session store declares them (engines/codex/sessionStore.ts): the names its own
 * code (the sub-agent reader, engines/codex/subagent.ts) has always used. Core reads them through the engine-neutral
 * finders (engines/sessionFiles.ts) and never loads this file.
 */
import { findSessionFileOf, sessionMetaOf, type SessionMeta } from '../sessionFiles.js'

export type CodexRolloutMeta = SessionMeta

/** Read only the first rollout record, which is Codex's session_meta line. */
export function readCodexRolloutMeta(file: string): CodexRolloutMeta | null {
  return sessionMetaOf('codex', file)
}

/** Find one rollout by thread id without scanning unbounded user history: under `root`, else in every Codex
 *  home the person moved too (lib/engineHomes.ts). */
export function resolveCodexRollout(threadId: string, root?: string): string | null {
  return findSessionFileOf('codex', threadId, root)
}
