/**
 * What discovery reads off an engine's process and transcripts, composed per engine, so the discovery pass,
 * the registry and the start-up repair name no engine: the profile home a process runs under, and the
 * project folder a transcript belongs to.
 */
import { claudeProjectMatches, claudeTranscriptCwd, isClaudeProjectTranscript, mangleClaudeProjectDir } from '../lib/claudeProject.js'
import { codexHomeFromEnv, probeCodexHome } from '../lib/codexHomeProbe.js'
import type { ProcessIdentity } from '../lib/registry.js'
import type { AgentEngine } from './types.js'

/**
 * The engine home a process runs under, read off its environment, when it is not this machine's default: a
 * path, `null` for the default (or an engine with no such profile), never a guess. `defaultHome` overrides
 * the daemon's own, for a caller that already holds it.
 */
export function profileHomeFromEnv(engine: AgentEngine, processEnv: Record<string, string>, defaultHome?: string): string | null {
  return defaultHome === undefined ? codexHomeFromEnv(engine, processEnv) : codexHomeFromEnv(engine, processEnv, defaultHome)
}

/** The same, read from the live process: `undefined` when it could not be read, which never overwrites what
 *  the registry knows. */
export function probeProfileHome(identity: ProcessIdentity, engine: AgentEngine): Promise<string | null | undefined> {
  return probeCodexHome(identity, engine)
}

/** Which folder a transcript belongs to, for an engine that keeps transcripts by the folder they began in. */
export interface TranscriptProject {
  /** Whether the transcript sits in a project directory at all. */
  isProjectTranscript(transcriptPath: string): boolean
  /** Whether `cwd` is the folder this transcript belongs to, as given or as its real path. */
  belongs(cwd: string, transcriptPath: string): boolean
  /** The folder the transcript names for itself, read from it; null when it names none. */
  cwdOf(transcriptPath: string, limit?: number): string | null
  /** The project directory's name for a folder. */
  directoryOf(cwd: string): string
}

/** The project-folder rule of `engine`'s transcripts; null for an engine with no such rule. */
export function transcriptProject(engine: AgentEngine | string): TranscriptProject | null {
  if (engine !== 'claude') return null
  return {
    isProjectTranscript: isClaudeProjectTranscript,
    belongs: claudeProjectMatches,
    cwdOf: (transcriptPath, limit) => limit === undefined ? claudeTranscriptCwd(transcriptPath) : claudeTranscriptCwd(transcriptPath, limit),
    directoryOf: mangleClaudeProjectDir,
  }
}
