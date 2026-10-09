/**
 * Session search: every turn of every conversation on this machine, live and stopped, indexed from
 * its transcript and searched by `session_search` (lib/sessionSearch/). Nothing leaves the machine
 * but the hits for a query. A Node without `node:sqlite` has no index, and search is off.
 *
 * A service on the core boundary (docs/design/2026-10-03-harnessd.md, step 13): it reads the core
 * only through `CoreApi`, the core reaches it only through `ports.search`, which stays null when
 * there is no index, and the apps through the two requests it answers.
 */
import { join } from 'node:path'
import { createExternalSessions, type ExternalReaderOptions } from './externalSessions.js'
import { externalProviders } from '../lib/sessionSearch/externals/index.js'
import type { CoreApi, CorePorts, ServiceRequests } from '../core/api.js'
import { SessionSearchIndex, folderWords, type SearchSource } from '../lib/sessionSearch/indexer.js'
import { SESSION_SEARCH_FILE, SessionSearchStore, type ExternalHit } from '../lib/sessionSearch/store.js'

/** The requests search answers for the apps, declared in core/api.ts for the core to route. */
export { SEARCH_REQUESTS } from '../core/api.js'

const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : undefined
const integer = (value: unknown) => typeof value === 'number' && Number.isInteger(value) ? value : undefined

/** The two requests, on an index: the same answers in the core's process and in search's own. */
export function searchRequests(index: Pick<SessionSearchIndex, 'search' | 'tail'>): ServiceRequests {
  return {
    // Every conversation on this machine, searched by what was said in it. Synchronous and a few
    // milliseconds: the index is local SQLite FTS5. The words searched for arrive sealed and the hits
    // leave sealed — the relay reads neither. `from`/`to`: only sessions worked on in that window
    // (epoch ms) — "the dial one from last week". The client reads the time words, so every machine
    // searches the same window.
    session_search: (payload) => {
      const query = typeof payload.query === 'string' ? payload.query.slice(0, 500) : ''
      const catalogAfter = typeof payload.catalogAfter === 'string' && payload.catalogAfter.length <= 256
        ? payload.catalogAfter : undefined
      return { ...(catalogAfter !== undefined ? { catalog: true } : {}), ...index.search(query, {
        limit: number(payload.limit), from: number(payload.from), to: number(payload.to),
        ...(catalogAfter !== undefined ? { catalogAfter } : {}),
      }) }
    },
    // A session's latest rows, newest last; `beforeTurn` pages up from the first row the client has.
    // The same index as `session_search`, so it reads no transcript for a preview.
    session_tail: async (payload) => {
      const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId.slice(0, 200) : ''
      if (!sessionId) return { error: 'BAD_SESSION' }
      const tail = await index.tail(sessionId, { beforeTurn: integer(payload.beforeTurn), maxChars: integer(payload.maxChars) })
      return tail ? { ...tail } : { error: 'NOT_INDEXED', sessionId }
    },
  }
}

/** Start search: its port for the core, and its requests for the apps, both on one index. */
export function startSearch(core: CoreApi, ports: CorePorts, options?: ExternalReaderOptions): ServiceRequests {
  let index: SessionSearchIndex | null = null
  const readers = createExternalSessions({ ...(options ?? { providers: externalProviders(), excluded: [core.dataDir], log: console.warn }),
    title: id => options?.title?.(id) ?? index?.session(id)?.title })
  index = openIndex(core, readers)
  ports.search = {
    touch: id => index?.touch(id), deleteHistory: id => index?.deleteHistory(id), session: id => index?.session(id),
    inspect: readers.inspect, stop: () => index?.stop(),
  }
  return index ? searchRequests(index) : {}
}

function openIndex(core: CoreApi, readers: ReturnType<typeof createExternalSessions>): SessionSearchIndex | null {
  try {
    const store = SessionSearchStore.open(join(core.dataDir, SESSION_SEARCH_FILE))
    if (!store) {
      console.warn('[search] node:sqlite is not available on this Node — session search is off')
      return null
    }
    const index = new SessionSearchIndex({
      store,
      catalogMetadata: () => {
        const entries = new Map<string, ExternalHit>(readers.sessions.list().flatMap(s =>
          [s.sessionId, ...(s.aliases ?? [])].map(id => [id, { title: s.title, cwd: s.cwd, origin: s.origin }] as const)))
        for (const s of core.agents.all()) if (s.sessionId) entries.set(s.sessionId,
          { title: s.title || core.agents.displayName(s), cwd: s.cwd || '', origin: 'harness' })
        return entries
      },
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
        for (const e of readers.sessions.list()) {
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
      discover: () => readers.sessions.scan(),
      openSessions: readers.open,
      log: (line) => console.log(line),
    })
    index.start()
    return index
  } catch (error) {
    console.error('[search] could not open the session index:', error instanceof Error ? error.message : error)
    return null
  }
}
