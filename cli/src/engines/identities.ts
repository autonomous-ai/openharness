/** Eager location facts for session control. Optional engine interpretation is never consulted. */
import { lstat, realpath } from 'node:fs/promises'
import { CURSOR_TRANSCRIPT } from './cursor/contract.js'
import { GROK_TRANSCRIPT } from './grok/contract.js'
import { AGY_PROCESS_SESSION, AGY_TRANSCRIPT } from './agy/contract.js'
import { COPILOT_PROCESS_SESSION, COPILOT_TRANSCRIPT } from './copilot/contract.js'
import { locateProcessSession, locateTranscript } from './kit/sessionLocation.js'
import { inspectTranscriptPath } from '../lib/registry.js'
import { env } from '../config/env.js'
import { heldHome } from '../lib/processHeldFiles.js'
import { processView } from '../lib/processMounts.js'
import type { ProcessIdentity } from '../lib/terminalTypes.js'
import { HERMES_HELD_STORE, HERMES_HISTORY_ID_RE, HERMES_SESSION_END, HERMES_SOURCE, HERMES_TERMINAL_RECORD, hermesDbPath } from './hermes/contract.js'
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
 * The home a Hermes process works in, from the store it holds open, at the daemon's path of it. Null is the daemon's
 * default home, and another engine; undefined is a process that holds no store yet, one whose files cannot be
 * listed, or a sandbox's home with no path here, and must preserve an existing home. `children` names the selected
 * process's direct children that are Hermes's own binary (lib/processTable.ts `engineChildren`): no other process is
 * listed, and two homes among them are no home (lib/processHeldFiles.ts `heldHome`).
 */
export async function probeHermesHome(selected: ProcessIdentity, engine: AgentEngine, children?: () => readonly ProcessIdentity[]): Promise<string | null | undefined> {
  if (engine !== 'hermes') return null
  const home = await heldHome(selected, HERMES_HELD_STORE, children)
  if (home === undefined) return undefined
  return await canonical(home) === await canonical(env.HERMES_HOME.replace(/\/+$/, '')) ? null : home
}

/**
 * A Hermes process in another mount namespace: its folder as it names it, and the daemon's path of it. 'unseen' when
 * that folder has no path in the daemon's view. Undefined for a process that sees the daemon's mounts, one whose
 * namespace cannot be read, and another engine. Its home is not asked here: an unknown home holds nothing.
 */
export async function probeHermesSandbox(identity: ProcessIdentity, engine: AgentEngine): Promise<{ cwd: string; hostCwd: string } | 'unseen' | undefined> {
  if (engine !== 'hermes') return undefined
  const view = await processView(identity)
  if (view.state !== 'sandbox') return undefined
  const hostCwd = view.cwd === null ? null : view.toHost(view.cwd)
  if (view.cwd === null || hostCwd === null) return 'unseen'
  return { cwd: view.cwd, hostCwd }
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
 * What a home's store is now, so a session it did not have is asked about again only once it changed: one `lstat` each
 * of its -wal, which a running Hermes writes, and of the store, which a checkpoint writes.
 */
export async function hermesStoreStamp(home: string): Promise<string> {
  const store = hermesDbPath(home)
  const stamps = await Promise.all([`${store}-wal`, store].map(file => lstat(file).then(info => `${info.mtimeMs}:${info.size}`, () => '-')))
  return stamps.join('|')
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
