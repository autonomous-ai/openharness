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
