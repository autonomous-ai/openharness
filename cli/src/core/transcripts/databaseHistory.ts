import { env } from '../../config/env.js'
import { hermesDbPath } from '../../engines/hermes/contract.js'
import { loadEngine } from '../../engines/inProcess.js'
import type { LiveEvent } from '../../engines/kit/events.js'
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

/**
 * The store a Hermes session's history is in: its own home's, found by Hermes's code and kept on its row
 * (lib/hermesHome.ts), which is loaded with Hermes's. Read only once that code is there, for a Hermes session;
 * without it, the default home's, as when no home claims the session.
 */
export const hermesDb = async (s: RegisteredSession): Promise<string> =>
  await (await loadEngine('hermes'))?.hermesDbForSession(s) ?? hermesDbPath(env.HERMES_HOME)
