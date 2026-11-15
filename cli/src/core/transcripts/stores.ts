/**
 * Where a conversation an engine keeps in a database is: the store's path, which the core names and the engine's
 * reader reads (core/transcripts/history.ts and lastTurn.ts, in the other engines' worker). Devin, OpenCode and Kilo
 * keep one store on this machine; Hermes one per home, the session's own (`hermesDb`); OpenClaw one per TUI's state
 * folder (lib/openclawStore.ts), none for a key that is not OpenClaw's. Every other engine keeps none.
 */
import type { RegisteredSession } from '../../lib/registry.js'

export interface Stores {
  opencode: string
  kilo: string
  devin: string
  openclaw: (key: string, pane: { pid: number; stateDir?: string | null }) => Promise<string | null>
}

/** The store `s`'s conversation is in, or null for one in none. */
export function createStoreOf(dbs: Stores, hermes: (s: RegisteredSession) => Promise<string>) {
  return async (s: RegisteredSession): Promise<string | null> => {
    switch (s.engine) {
      case 'opencode': return dbs.opencode
      case 'kilo': return dbs.kilo
      case 'devin': return dbs.devin
      case 'hermes': return hermes(s)
      case 'openclaw': return dbs.openclaw(s.sessionId, { pid: s.processIdentity?.pid ?? 0, stateDir: s.openclawStateDir })
      default: return null
    }
  }
}
