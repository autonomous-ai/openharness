/**
 * What a launch prepares in the person's files before the engine starts: the folder trust an engine asks
 * about, and a conversation's history made resumable. Composed per engine, so the launch paths
 * (core/agents/create.ts, launches.ts, launch.ts) name no engine.
 */
import { claudeTrusts, codexTrusts, preTrustClaudeProject, preTrustCodexProject } from '../lib/claudeTrust.js'
import { prepareCodexResume } from './codex/portableHistory.js'
import type { AgentEngine } from './types.js'

/** An engine's answer to "do you trust this folder?", read and recorded where the engine keeps it. */
export interface FolderTrust {
  /** Whether the engine already trusts `path`. */
  trusts(path: string): boolean
  /** Record trust in `path`: never removes anything, and leaves a file it cannot safely extend alone. */
  record(path: string): 'trusted' | 'already' | 'skipped'
}

/** The folder trust of `engine` launched now, in `profile` (an agent's own engine home) where it has one;
 *  null for an engine that asks no such question. */
export function folderTrust(engine: AgentEngine, profile?: string | null): FolderTrust | null {
  if (engine === 'claude') return { trusts: (path) => claudeTrusts(path), record: (path) => preTrustClaudeProject(path) }
  if (engine === 'codex') return { trusts: (path) => codexTrusts(path, profile), record: (path) => preTrustCodexProject(path, profile) }
  return null
}

/** The session a resume relaunches. */
export interface ResumeSource {
  engine: string
  sessionId: string
  transcriptPath?: string | null
  codexHome?: string | null
}

/**
 * Make a stopped conversation's history resumable, before the engine is launched on it. `repairedBytes`,
 * set only when something was repaired, is the history's new length: a tail of that file moves there.
 */
export function prepareResume(source: ResumeSource): { repairedItems: number; repairedBytes?: number; backupPath?: string } {
  return prepareCodexResume(source)
}
