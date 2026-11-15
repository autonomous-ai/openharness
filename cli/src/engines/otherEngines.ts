/**
 * The fourteen engines besides Claude Code and Codex, and the one worker their code runs in
 * (docs/design/2026-11-12-core-audit.md, section 3): plain data, which the core reads to route a session's reads
 * and which loads none of their code.
 */
import type { ProcessEngine } from './types.js'

export const OTHER_ENGINES = ['opencode', 'cursor', 'kilo', 'devin', 'hermes', 'amp', 'agy', 'grok', 'copilot', 'commandcode', 'muse', 'pi', 'omp', 'openclaw'] as const satisfies readonly ProcessEngine[]
export type OtherEngine = (typeof OTHER_ENGINES)[number]
export function isOtherEngine(engine: string): engine is OtherEngine { return (OTHER_ENGINES as readonly string[]).includes(engine) }

/** Their worker: one process for all fourteen, on demand (harnessd/services.ts `SERVICE_HOSTS`). */
export const OTHER_ENGINES_SERVICE = 'engine-others'
/** These optional-reader failures are named states, shown by every existing agent view. */
export const OTHER_ENGINE_STATES = {
  unavailable: 'Live view is waiting for its engine reader. The terminal and Stop still work.',
  lost: 'Live view fell behind. Rebuilding from history; check its history for missed events.',
  rewritten: 'Transcript changed while its reader was unavailable. Rebuilding the live view; check its history for missed events.',
} as const

/** The engines that keep a conversation in a database rather than a transcript file: their history is read from it. */
export const STORE_ENGINES = ['opencode', 'kilo', 'hermes', 'devin', 'openclaw'] as const satisfies readonly OtherEngine[]
export function keepsStore(engine: string): boolean { return (STORE_ENGINES as readonly string[]).includes(engine) }

/**
 * How long a read of one of their conversations may take, in their worker and in the core waiting for it. Amp's history
 * is Amp's own export, a network call of about 1.5 s that its command gives up on at 20 s (engines/amp/threadExport.ts).
 * Every other read is of up to 64 MB of a transcript, or a whole conversation in a store, which may first wait 5 s for
 * the store's lock (lib/sqliteRead.ts), and then replayed: the core waited as long as one took while it read them
 * itself, so theirs get three times the five seconds Claude Code's and Codex's paged reads do.
 */
export function readWaitMs(engine: string, history: boolean): number { return engine === 'amp' && history ? 25_000 : 15_000 }

/** How much of a session's pane the core reads as it attaches, for the chips only its footer names: OpenCode's,
 *  Devin's and OpenClaw's model and effort exist nowhere else, and a fresh agent showed empty chips until the five-minute
 *  reconcile came round. */
export const PANE_AT_ATTACH: Partial<Record<OtherEngine, number>> = { cursor: 100, opencode: 100, grok: 60, agy: 60, devin: 60, openclaw: 60 }

/**
 * How an engine's Stop hook closes the turn its transcript alone would leave open, as data the core applies
 * (core/turns/turnHooks.ts) with what the engine's worker does to its parser (engines/others/streams.ts). Each drains
 * what is unread first, waits a grace for what the engine commits last, and closes only what is still open; or, for an
 * error, says why. The worker's close returns what the parser emits closing; when the worker does not answer, the core
 * closes the turn itself, so a Stop never leaves one open.
 */
export interface OtherStopRule {
  /** Read what the transcript has that the stream has not delivered yet, first and again after the grace. */
  drain?: true
  /** Wait the grace while the turn is still open, and look again: its last records land late. */
  grace?: true
  /** Close whether or not a turn is open: Cursor's close also ends its sub-agents, Grok's StopFailure its turn. */
  always?: true
  /** Only a Stop that reports an error closes anything (Grok's StopFailure). */
  onlyError?: true
  /** What an error says, before its close, which then aborts the turn. */
  error?: string
  /** What an error says when its close showed nothing at all. */
  errorIfSilent?: string
  /** The close says a plain turn end, not what the parser emits closing. */
  plainEnd?: true
  /** A Stop that says the engine waits for its sub-agents closes nothing and watches the pane instead (core/turns/agyBackstop.ts). */
  backstop?: true
}

export const STOP_RULES: Partial<Record<OtherEngine, OtherStopRule>> = {
  // Cursor's Tasks are queued behind a drain (its worker waits for them first) and its sub-agents end with the turn. It
  // can fail a turn BEFORE it writes anything to the transcript: observed as a Stop hook with status=error 2.4s after
  // beforeSubmitPrompt, with no transcript file discovered and no rows to read. Its close then shows nothing, so nothing
  // reached the device and the tile sat on the previous recap forever: that is when the error is said.
  cursor: { drain: true, always: true, errorIfSilent: 'Cursor ended the turn with an error before producing any output' },
  // Command Code has no UserPromptSubmit and commits records per turn, so Stop is its authoritative close: drain the
  // transcript first (the natural close usually wins), then force-close what's left.
  commandcode: { drain: true, grace: true, plainEnd: true },
  // Devin: the same, except the un-read history is in SQLite, which its reader polls itself. Its rows only land once the
  // model round-trip commits, so the grace matters.
  devin: { grace: true, plainEnd: true },
  // Copilot's agentStop hook is the turn boundary: its own `assistant.turn_end` records mark model round-trips, several
  // per exchange.
  copilot: { drain: true, grace: true, error: 'Copilot ended the turn early' },
  // agy's Stop hook is the ONLY turn boundary it has. Nothing in the transcript says a turn ended: a backgrounded step is
  // written `status: RUNNING` and, the file being append-only, stays that way forever.
  agy: { drain: true, grace: true, error: 'agy ended the turn early', backstop: true },
  grok: { drain: true, always: true, onlyError: true, error: 'Grok ended the turn with an error' },
}
