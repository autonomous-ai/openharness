/** Compose the deferred publication authority beside core-owned discovery and conversation reads. */
import { handoffProviderDeps, type HandoffWiring } from '../lib/handoffDiscovery.js'
import { createHandoffPublisher } from './handoffPublication.js'

/** `deadlineMs`: a longer request deadline, for a test on a loaded machine; as shipped, HANDOFF_DEADLINE_MS. */
export function createHandoffDependencies(wiring: HandoffWiring, directory: string, deadlineMs?: number) {
  const publish = createHandoffPublisher({ directory, deadlineMs,
    authority: async facts => {
      const selected = new Map<string, Awaited<ReturnType<typeof wiring.stopped.get>>>()
      for (const session of facts.sessions) if (!wiring.registry.resolve(session.agentId)) selected.set(session.agentId, await wiring.stopped.get(session.agentId))
      const reads = facts.reads
      const archive = await wiring.stopped.query({ kind: 'conversations', reservations: false,
        ids: reads.map(read => read.sessionId), exceptAgentIds: reads.map(read => read.ownerAgentId) })
      return {
        current: archive.current,
        resolve: id => wiring.registry.resolve(id) ?? (() => { const saved = selected.get(id); return saved && wiring.stopped.current(saved) ? saved : null })(),
        ownedByOther: (sessionId, agentId) => {
          const owner = wiring.registry.bySession(sessionId)
          const index = reads.findIndex(read => read.sessionId === sessionId && read.ownerAgentId === agentId)
          return index < 0 || archive.matches[index] || !!owner && owner.agentId !== agentId
        },
      }
    },
    isRecentlyDeleted: wiring.isRecentlyDeleted,
  })
  return handoffProviderDeps({ ...wiring, publish, observed: publish.observed,
    findResumedTranscript: async (engine, id, options) => {
      const path = await wiring.findResumedTranscript(engine, id, options)
      publish.selected(engine, id, options.codexHome, path)
      return path
    },
  })
}
