/** Confirm native turn facts before exposing them to eager control. The proof
 * includes the complete journal frontier, not only a surviving delivery leaf. */
import type { createNativeHookJournal } from '../../engines/kit/nativeHookJournal.js'
import { validNativeGenerationFact } from '../../engines/kit/nativeGenerationFact.js'
import { MAX_RETAINED_GENERATION_FACTS, validNativeGenerationCancellation, validNativeGenerationFrontier } from '../../engines/kit/nativeGenerationCancellation.js'
import type { NativeGenerationFact, NativeGenerationOwner, NativeGenerationSource } from './nativeGenerations.js'

type Snapshot = Pick<Awaited<ReturnType<ReturnType<typeof createNativeHookJournal>['snapshot']>>,
  'processKey' | 'generations' | 'cancellations' | 'frontier' | 'verify' | 'confirm'>

export function createNativeGenerationSource({ owner, read }: {
  owner: NativeGenerationOwner
  read(): Promise<Snapshot>
}) {
  const original = Object.freeze({ ...owner })
  const held = (reason: string): never => { throw Error(`Waiting for native generation facts: ${reason}.`) }
  return {
    async read(): Promise<NativeGenerationSource> {
      const snapshot = await read()
      const verifySnapshot = snapshot.verify.bind(snapshot)
      const confirmSnapshot = snapshot.confirm.bind(snapshot)
      const verify = () => {
        if (snapshot.processKey !== original.processKey) held('the process incarnation changed')
        verifySnapshot()
        if (snapshot.processKey !== original.processKey) held('the process incarnation changed')
      }
      verify()
      if (!(snapshot.generations instanceof Map) || snapshot.generations.size > MAX_RETAINED_GENERATION_FACTS) held('the retained fact capacity was exceeded')
      if (!(snapshot.cancellations instanceof Map) || snapshot.cancellations.size > 4096) held('the retained cancellation capacity was exceeded')
      const cancellations = Object.freeze([...snapshot.cancellations].map(([id, request]) => {
        if (id !== request.requestId || !validNativeGenerationCancellation(request)) held('a retained cancellation is invalid')
        return Object.freeze({ ...request, frontier: Object.freeze({ ...request.frontier }) })
      }))
      if (!validNativeGenerationFrontier(snapshot.frontier)) held('the retained frontier is invalid')
      const frontier = Object.freeze({ ...snapshot.frontier })
      // Disk proofs do not freeze the caller's Map. Capture the bounded scalar
      // facts before confirmation yields, retaining only this original view.
      const facts: NativeGenerationFact[] = []
      for (const [id, fact] of snapshot.generations) {
        if (id !== fact.id || !validNativeGenerationFact(fact)) held('a retained generation fact is invalid')
        if (fact.agentId !== original.agentId || fact.conversationId !== original.sessionId) continue
        facts.push(Object.freeze({ id, generationId: fact.generationId, kind: fact.kind,
          ...(fact.kind === 'stopped' ? { status: fact.status } : {}) }) as NativeGenerationFact)
      }
      // A visible Stop written by a crashed core has no control authority until
      // the complete mirrored tail and namespace have been confirmed.
      await confirmSnapshot()
      verify()
      return Object.freeze({ owner: original, facts: Object.freeze(facts), frontier, cancellations, verify })
    },
  }
}
