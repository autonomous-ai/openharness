import { readdir, stat } from 'fs/promises'
import { join } from 'path'
import { locateProcessSession, locateTranscript } from '../kit/sessionLocation.js'

import { AGY_PROCESS_SESSION, AGY_TRANSCRIPT, CONVERSATION_ID } from './contract.js'
export { agyTranscriptPath } from './contract.js'

/**
 * Resolve a live agy transcript.
 *
 * The hook payload names this exact path, so this is the fallback for a session discovered without
 * one. The `_full` file is the one to tail — see the normalizer header for why.
 */
export async function findAgyTranscript(agyHome: string, conversationId: string): Promise<string | null> {
  return locateTranscript(AGY_TRANSCRIPT, agyHome, conversationId)
}

export interface AgyConversation {
  conversationId: string
  transcriptPath: string
  /** Last write to the transcript — the only ordering signal agy leaves for the CLI. */
  mtimeMs: number
  birthMs: number
}

/**
 * Every conversation with a transcript on disk, newest write first.
 *
 * agy's `conversation_summaries.db` looks like the index for this and is NOT one: measured on 1.1.14
 * it holds only IDE (`app_data_dir='antigravity'`) rows, and CLI conversations never appear in it.
 * The brain directory is the authority.
 */
export async function listAgyConversations(agyHome: string): Promise<AgyConversation[]> {
  const root = join(agyHome, 'brain')
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  const found: AgyConversation[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !CONVERSATION_ID.test(entry.name)) continue
    const transcriptPath = join(root, entry.name, '.system_generated', 'logs', 'transcript_full.jsonl')
    const info = await stat(transcriptPath).catch(() => null)
    if (!info?.isFile()) continue
    found.push({
      conversationId: entry.name,
      transcriptPath,
      mtimeMs: info.mtimeMs,
      birthMs: info.birthtimeMs || info.ctimeMs,
    })
  }
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs)
}

/**
 * The conversation a live `agy` process is holding, read from the lock it keeps open.
 *
 * agy flocks `<AGY_HOME>/presence/<conversationId>.lock` for the life of a conversation and holds the
 * descriptor open (measured: pid 91701 ↔ `ae51057a…`). That makes it the one pid→conversation map the
 * CLI leaves behind, and it doubles as a liveness test — a stale lock file has no holder.
 *
 * It is the only route available to process-repair: agy's transcript records no cwd, its directory is
 * named by the conversation id, and `ANTIGRAVITY_CONVERSATION_ID` is exported to hook children but not
 * into agy's own environment, so neither the file nor `/proc/<pid>/environ` can answer this.
 */
export async function agyConversationForPid(agyHome: string, pid: number): Promise<string | null> {
  return locateProcessSession(AGY_PROCESS_SESSION, agyHome, pid)
}
