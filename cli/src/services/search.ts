/**
 * Session search: every turn of every conversation on this machine, live and stopped, indexed from
 * its transcript and searched by `session_search` (lib/sessionSearch/). Nothing leaves the machine
 * but the hits for a query. A Node without `node:sqlite` has no index; the RPC then says so.
 *
 * A service on the core boundary (docs/design/2026-10-03-harnessd.md, step 13): it reads the core
 * only through `CoreApi`, and the core reaches it only through `ports.search`, which stays null when
 * there is no index.
 */
import { join } from 'node:path'
import type { CoreApi, CorePorts } from '../core/api.js'
import { SESSION_SEARCH_FILE } from '../lib/sessionSearch/command.js'
import { SessionSearchIndex, folderWords, type SearchSource } from '../lib/sessionSearch/indexer.js'
import { SessionSearchStore } from '../lib/sessionSearch/store.js'

export function startSearch(core: CoreApi, ports: CorePorts): void {
  ports.search = (() => {
    try {
      const store = SessionSearchStore.open(join(core.dataDir, SESSION_SEARCH_FILE))
      if (!store) {
        console.warn('[search] node:sqlite is not available on this Node — session search is off')
        return null
      }
      const index = new SessionSearchIndex({
        store,
        sources: () => {
          const own = core.agents.all()
          const sources = own.flatMap((s): SearchSource[] => {
            const readHistory = s.transcriptPath ? undefined : core.transcripts.databaseHistory(s)
            if (!s.sessionId || (!s.transcriptPath && !readHistory)) return []
            return [{
              agentId: s.agentId,
              sessionId: s.sessionId,
              engine: s.engine,
              transcriptPath: s.transcriptPath || null,
              header: [core.agents.displayName(s), s.title, folderWords(s.cwd)].filter(Boolean).join(' · '),
              // Conversation stamps only: the row's `touchedAt` includes discovery bookkeeping.
              changedAt: Math.max(s.lastTranscriptAt || 0, s.lastHookAt || 0) || s.boundAt || s.registeredAt || 0,
              readHistory,
            }]
          })
          // Conversations Harness did not start — any Harness agent's, earlier ones included, are not.
          const known = store.ownedSessionIds()
          for (const s of own) if (s.sessionId) known.add(s.sessionId)
          for (const e of core.external.sessions.list()) {
            // A conversation Harness holds under any of its ids is Harness's.
            if (known.has(e.sessionId) || e.aliases?.some((id) => known.has(id)) || (!e.transcriptPath && !e.readHistory)) continue
            sources.push({
              agentId: '', sessionId: e.sessionId, engine: e.engine, transcriptPath: e.transcriptPath,
              header: '', changedAt: e.mtime, external: { cwd: e.cwd, origin: e.origin, title: e.title },
              ...(e.readHistory ? { readHistory: e.readHistory } : {}),
            })
          }
          return sources
        },
        agents: () => core.agents.all().map((s) => s.agentId),
        discover: () => core.external.sessions.scan(),
        openSessions: core.external.open,
        log: (line) => console.log(line),
      })
      index.start()
      return index
    } catch (error) {
      console.error('[search] could not open the session index:', error instanceof Error ? error.message : error)
      return null
    }
  })()
}
