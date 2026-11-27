/**
 * A conversation kept in a database, read whole, for a service in the core's own process (services/inline.ts: the
 * change-agent handoff, under `HARNESSD_SERVICES=none` or an older master). The readers are the engines' own code
 * (lib/databaseHistory.ts, which the services' processes import as it is), loaded here only once one is asked for
 * (engines/inProcess.ts): a core that never reads such a conversation loads none of them.
 */
import { loadEngine } from './inProcess.js'
import type { LiveEvent } from './kit/events.js'
import { keepsStore } from './otherEngines.js'
import type { RegisteredSession } from '../lib/registry.js'

export const databaseHistory = (s: RegisteredSession): (() => Promise<readonly LiveEvent[]>) | undefined =>
  keepsStore(s.engine) ? async () => await (await loadEngine('databaseHistory'))?.databaseHistory(s)?.() ?? [] : undefined
