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
import { processView } from '../lib/processMounts.js'
import type { ProcessIdentity } from '../lib/terminalTypes.js'
import { HERMES_HISTORY_ID_RE, HERMES_HOME_RULE, HERMES_SESSION_END, HERMES_SOURCE, HERMES_TERMINAL_RECORD, hermesDbPath } from './hermes/contract.js'
import { homeFromEnvironment, homeIsNamed } from './kit/processHome.js'
import { readTerminalRecord, terminalRecordNames, terminalRecordStamp, type Terminal, type TerminalRecordRead } from './kit/terminalRecord.js'
import { isInteractiveSource, readStoreSessionSource } from './kit/storeSource.js'
import { IdentityReadUnavailable } from './kit/identityScan.js'
import { sqliteReadAll } from '../lib/sqliteRead.js'
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
 * its own keeps its store under that `HOME`, not under the daemon's. One in another mount namespace names it in its own
 * view, and the answer is the daemon's path of it. Null is the daemon's default home; undefined is evidence that cannot
 * say (a home with no path in the daemon's view too), and must preserve an existing home.
 */
export async function probeHermesHome(identity: ProcessIdentity, engine: AgentEngine): Promise<string | null | undefined> {
  if (engine !== 'hermes') return null
  const named = await namedHome(identity)
  if (named === undefined) return undefined
  const view = await processView(identity)
  const home = view.state === 'sandbox' ? view.toHost(named) : named
  if (home === null) return undefined
  return await canonical(home) === await canonical(env.HERMES_HOME.replace(/\/+$/, '')) ? null : home
}

/**
 * Whether the home `probeHermesHome` answers is Harness's own working out, not the value of the process's own
 * `HERMES_HOME`: one from its `HOME`, or one it named that the daemon reads at another path. A relaunch must not export
 * such a home (registry.ts RegisteredSession.hermesHomeDerived): the relaunched process works its own out again.
 */
export async function probeHermesHomeDerived(identity: ProcessIdentity, engine: AgentEngine): Promise<boolean> {
  if (engine !== 'hermes') return false
  const processEnv = await readProcessEnv(identity)
  if (!processEnv) return false
  if (!homeIsNamed(HERMES_HOME_RULE, processEnv)) return true
  const home = homeFromEnvironment(HERMES_HOME_RULE, processEnv, process.platform)
  const view = await processView(identity)
  return view.state === 'sandbox' && home !== undefined && view.toHost(home) !== home
}

/**
 * A Hermes process in another mount namespace (a sandbox): its folder as it names it, the one Hermes writes, and the
 * daemon's path of it. 'unseen' when its home cannot be told, or its home or folder has no path in the daemon's view:
 * Harness cannot read what Hermes keeps there. Undefined for a process that sees the daemon's mounts, one whose
 * namespace cannot be read, and another engine.
 */
export async function probeHermesSandbox(identity: ProcessIdentity, engine: AgentEngine): Promise<{ cwd: string; hostCwd: string } | 'unseen' | undefined> {
  if (engine !== 'hermes') return undefined
  const view = await processView(identity)
  if (view.state !== 'sandbox') return undefined
  const home = await namedHome(identity)
  const hostCwd = view.cwd === null ? null : view.toHost(view.cwd)
  if (view.cwd === null || hostCwd === null || home === undefined || view.toHost(home) === null) return 'unseen'
  return { cwd: view.cwd, hostCwd }
}

// The home a Hermes process names, in its own view; undefined when its environment cannot be read or cannot say.
async function namedHome(identity: ProcessIdentity): Promise<string | undefined> {
  const processEnv = await readProcessEnv(identity)
  return processEnv ? homeFromEnvironment(HERMES_HOME_RULE, processEnv, process.platform) : undefined
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

/**
 * Whether a session was ended at or after [sinceMs]. Hermes ends the session a terminal leaves and opens again one it
 * resumes, so one ended since a process started was open in that process. Throws when the store cannot be read.
 */
export async function hermesSessionEndedSince(home: string, sessionId: string, sinceMs: number): Promise<boolean> {
  if (!HERMES_HISTORY_ID_RE.test(sessionId)) return false
  const result = await sqliteReadAll(hermesDbPath(home), HERMES_SESSION_END.query, [sessionId], { maxBuffer: HERMES_SESSION_END.maxBuffer })
  if (!result.ok) throw new IdentityReadUnavailable('the Hermes session end is unavailable')
  const ended = result.rows[0]?.[HERMES_SESSION_END.column]
  return typeof ended === 'number' && ended * 1000 >= sinceMs
}
