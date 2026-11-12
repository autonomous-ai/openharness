/** Eager location facts for session control. Optional engine interpretation is never consulted. */
import { realpath } from 'node:fs/promises'
import { CURSOR_TRANSCRIPT } from './cursor/contract.js'
import { GROK_TRANSCRIPT } from './grok/contract.js'
import { AGY_PROCESS_SESSION, AGY_TRANSCRIPT } from './agy/contract.js'
import { COPILOT_PROCESS_SESSION, COPILOT_TRANSCRIPT } from './copilot/contract.js'
import { locateProcessSession, locateTranscript } from './kit/sessionLocation.js'
import { inspectTranscriptPath } from '../lib/registry.js'
import { env } from '../config/env.js'
import { readProcessEnv } from '../lib/processEnv.js'
import type { ProcessIdentity } from '../lib/terminalTypes.js'
import { HERMES_HISTORY_ID_RE, HERMES_HOME_RULE, HERMES_SOURCE, HERMES_TERMINAL_RECORD, hermesDbPath } from './hermes/contract.js'
import { homeFromEnvironment } from './kit/processHome.js'
import { readTerminalRecord, terminalRecordNames, terminalRecordStamp, type Terminal, type TerminalRecordRead } from './kit/terminalRecord.js'
import { isInteractiveSource, readStoreSessionSource } from './kit/storeSource.js'
import { IdentityReadUnavailable } from './kit/identityScan.js'
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

/**
 * The home a Hermes process uses, by Hermes's rule from its own environment: a sandboxed Hermes with only a `HOME` of
 * its own keeps its store under that `HOME`, not under the daemon's. Null is the daemon's default home; undefined is
 * evidence that cannot say, and must preserve an existing home.
 */
export async function probeHermesHome(identity: ProcessIdentity, engine: AgentEngine): Promise<string | null | undefined> {
  if (engine !== 'hermes') return null
  const processEnv = await readProcessEnv(identity)
  const home = processEnv ? homeFromEnvironment(HERMES_HOME_RULE, processEnv, process.platform) : undefined
  if (home === undefined) return undefined
  return await canonical(home) === await canonical(env.HERMES_HOME.replace(/\/+$/, '')) ? null : home
}

// The same home spelled differently (a symlinked `~`) is still the daemon's.
function canonical(path: string): Promise<string> {
  return realpath(path).catch(() => path)
}

export function hermesTerminalNames(terminal: Terminal): string[] {
  return terminalRecordNames(HERMES_TERMINAL_RECORD, terminal)
}

export function hermesTerminalStamp(home: string, names: readonly string[]): Promise<string> {
  return terminalRecordStamp(HERMES_TERMINAL_RECORD, home, names)
}

export function readHermesTerminal(home: string, names: readonly string[], sinceMs: number): Promise<TerminalRecordRead> {
  return readTerminalRecord(HERMES_TERMINAL_RECORD, home, names, sinceMs)
}

// Every id a record may name is read from the store, an editor's uuid too: its source, not its shape, says whose it is.
const RECORD_SOURCE = { ...HERMES_SOURCE, id: HERMES_HISTORY_ID_RE }

/** Whether a session a record names is a pane's own, one its store does not have yet, or another surface's. */
export async function hermesSessionKind(home: string, sessionId: string): Promise<'own' | 'waiting' | 'other'> {
  const source = await readStoreSessionSource(RECORD_SOURCE, hermesDbPath(home), sessionId)
  if (source === null) return 'waiting'
  if (typeof source === 'object') throw new IdentityReadUnavailable('the Hermes session source is unavailable')
  return isInteractiveSource(HERMES_SOURCE, source) ? 'own' : 'other'
}
