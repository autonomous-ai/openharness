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
 * How long a history read of `engine` may take, in its worker and in the core waiting for it. Amp's history is Amp's
 * own export, a network call of about 1.5 s that its command gives up on at 20 s (engines/amp/threadExport.ts); every
 * other read is a bounded file or store read, held to the readers' five seconds (engines/worker/protocol.ts).
 */
export function historyWaitMs(engine: string, readerWaitMs: number): number { return engine === 'amp' ? 25_000 : readerWaitMs }
