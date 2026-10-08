import { loadEngine } from '../../engines/inProcess.js'
import type { LiveEvent } from '../../lib/normalize.js'
import type { RegisteredSession } from '../../lib/registry.js'
import { SQLITE_BACKED_ENGINES } from '../../lib/sqliteRead.js'

const STORES: ReadonlySet<string> = new Set(SQLITE_BACKED_ENGINES)

/**
 * A database engine's conversation read whole, for what the core hands on (core/api.ts `transcripts`). The
 * readers are the engines' own code (lib/databaseHistory.ts, which the services import as it is), loaded in
 * this process only when one is asked for (engines/inProcess.ts): without them there is nothing to read.
 */
export const databaseHistory = (s: RegisteredSession): (() => Promise<readonly LiveEvent[]>) | undefined =>
  STORES.has(s.engine) ? async () => await (await loadEngine('databaseHistory'))?.databaseHistory(s)?.() ?? [] : undefined
