/** Compose the eager publication authority beside core-owned discovery and conversation reads. */
import { handoffProviderDeps, ownedByOther, type HandoffWiring } from '../lib/handoffDiscovery.js'
import { createHandoffPublisher } from './handoffPublication.js'

export function createHandoffDependencies(wiring: HandoffWiring, directory: string) {
  const publish = createHandoffPublisher({ directory,
    resolve: id => wiring.registry.resolve(id) ?? wiring.stopped.get(id),
    ownedByOther: (sessionId, agentId) => ownedByOther({ bySession: id => wiring.registry.bySession(id),
      stoppedIds: () => wiring.stopped.ids(), stopped: id => wiring.stopped.get(id) }, sessionId, agentId),
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
