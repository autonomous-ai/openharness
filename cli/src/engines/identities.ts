/** Eager location facts for session control. Optional engine interpretation is never consulted. */
import { CURSOR_TRANSCRIPT } from './cursor/contract.js'
import { GROK_TRANSCRIPT } from './grok/contract.js'
import { AGY_PROCESS_SESSION, AGY_TRANSCRIPT } from './agy/contract.js'
import { COPILOT_PROCESS_SESSION, COPILOT_TRANSCRIPT } from './copilot/contract.js'
import { locateProcessSession, locateTranscript } from './kit/sessionLocation.js'
import { inspectTranscriptPath } from '../lib/registry.js'
import { env } from '../config/env.js'
import { readProcessEnv } from '../lib/processEnv.js'
import type { ProcessIdentity } from '../lib/terminalTypes.js'
import { HERMES_PROFILE } from './hermes/contract.js'
import { profileFromEnv } from './kit/processFacts.js'
import type { AgentEngine } from './types.js'

const transcripts = { cursor: CURSOR_TRANSCRIPT, grok: GROK_TRANSCRIPT, agy: AGY_TRANSCRIPT, copilot: COPILOT_TRANSCRIPT }
export type LocatedEngine = keyof typeof transcripts

export function transcriptOf(engine: LocatedEngine, home: string, id: string, cwd?: string): Promise<string | null> {
  return locateTranscript(transcripts[engine], home, id, { cwd,
    ...(engine === 'cursor' ? { valid: (path: string) => inspectTranscriptPath(engine, path) } : {}),
  })
}
export function processSessionOf(engine: 'agy' | 'copilot', home: string, pid: number): Promise<string | null> {
  return locateProcessSession(engine === 'agy' ? AGY_PROCESS_SESSION : COPILOT_PROCESS_SESSION, home, pid)
}

/** Undefined is unreadable process evidence; it must preserve an existing home. */
export async function probeHermesHome(identity: ProcessIdentity, engine: AgentEngine): Promise<string | null | undefined> {
  if (engine !== 'hermes') return null
  const processEnv = await readProcessEnv(identity)
  return processEnv ? profileFromEnv(HERMES_PROFILE, processEnv, env.HERMES_HOME) : undefined
}
