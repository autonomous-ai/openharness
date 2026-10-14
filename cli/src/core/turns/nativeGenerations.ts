/** Generation facts are session control, independent of transcript interpretation.
 * A submitted prompt may be queued or rejected; execution and terminal facts can
 * arrive without it. The complete retained source, not arrival order, determines
 * which generations are still running. */
import { MAX_RETAINED_GENERATION_FACTS, validNativeGenerationCancellation,
  type NativeGenerationCancellation, type NativeGenerationFrontier } from '../../engines/kit/nativeGenerationCancellation.js'
import type { NativeGenerationObservation } from './nativeGenerationContent.js'
export interface NativeGenerationOwner {
  readonly agentId: string
  readonly sessionId: string
  readonly processKey: string
}
export type NativeGenerationFact = {
  readonly id: string
  readonly generationId: string
} & (
  | { readonly kind: 'submitted' | 'activity' | 'cancelled' }
  | { readonly kind: 'stopped'; readonly status: 'completed' | 'aborted' | 'error' }
)
export interface NativeGenerationSource {
  readonly owner: NativeGenerationOwner
  /** Historical PID view captured with this exact engine, not a live signal or
   * death permit. Cancel may retain it even after this source proof expires. */
  readonly namespace?: string
  /** A complete, durably confirmed view. A truncated prefix is not a source. */
  readonly facts: readonly NativeGenerationFact[]
  readonly frontier?: NativeGenerationFrontier
  /** Exact facts already retained when this core opened the process journal,
   * including pending intakes. Presentation provenance only, never authority. */
  readonly recoveredFactIds?: readonly string[]
  /** A barrier survives even when no generation was known at Cancel. It applies
   * across conversation rebindings within the original process incarnation. */
  readonly cancellations?: readonly NativeGenerationCancellation[]
  /** Present only when the complete native intake content was captured under
   * the same proof as these facts. Its absence cannot authorize live consumers. */
  readonly observations?: readonly NativeGenerationObservation[]
  /** Rechecks this exact complete frontier, including absence of later relevant
   * activity/Stop/Cancel facts. A proof of the old leaves alone is insufficient.
   * It must reject append as well as replacement and cannot select a new view. */
  verify(): void
}
export interface NativeGeneration {
  readonly id: string
  readonly submitted: boolean
  readonly executed: boolean
  readonly running: boolean
  /** A terminal tombstone survives late submissions and output. Conflicting
   * native terminal facts remain closed with an unresolved outcome. */
  readonly terminal?: 'completed' | 'aborted' | 'error' | 'cancelled' | 'unresolved'
  readonly factIds: readonly string[]
}
export interface NativeGenerationView {
  readonly owner: NativeGenerationOwner
  readonly generations: readonly NativeGeneration[]
  readonly running: readonly NativeGeneration[]
  readonly pending: readonly NativeGeneration[]
  /** More than one executing generation has no inferred current-turn order. */
  readonly selection: 'idle' | 'one' | 'ambiguous' | 'cancelled'
  readonly cancellations: readonly NativeGenerationCancellation[]
  /** Must be called immediately before any generation-specific effect. */
  verify(): void
}

const MAX_FACTS = MAX_RETAINED_GENERATION_FACTS
const MAX_GENERATIONS = 512
const identity = (owner: NativeGenerationOwner): string => JSON.stringify([owner.agentId, owner.sessionId, owner.processKey])
const identifier = (value: unknown): value is string => typeof value === 'string'
  && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value)
const unavailable = (reason: string): never => { throw new Error(`Waiting for native turn ownership: ${reason}.`) }

/** The read port supplies only confirmed native/core facts. No transcript, worker
 * or wall clock can fabricate a generation, terminal result or successor here. */
export function createNativeGenerations({ owner, current, read }: {
  owner: NativeGenerationOwner
  current(): boolean
  read(): Promise<NativeGenerationSource>
}) {
  const original = Object.freeze({ ...owner })
  if (!identifier(original.agentId) || !identifier(original.sessionId) || typeof original.processKey !== 'string'
    || original.processKey.length === 0 || original.processKey.length > 512) {
    unavailable('the original engine incarnation is incomplete')
  }
  const scope = identity(original)
  const check = (): void => { if (!current()) unavailable('the original engine incarnation changed') }
  return {
    async inspect(): Promise<NativeGenerationView> {
      check()
      const source = await read()
      check()
      if (identity(source.owner) !== scope) unavailable('the retained source belongs to another engine incarnation')
      const verifySource = source.verify.bind(source)
      verifySource()
      // Only bounded scalar facts enter the projection. Keep independent copies
      // so a caller changing its input cannot change an already inspected turn.
      if (!Array.isArray(source.facts) || source.facts.length > MAX_FACTS) unavailable('the retained fact capacity was exceeded')
      const barriers = source.cancellations === undefined ? [] : source.cancellations
      if (!Array.isArray(barriers) || barriers.length > 4096) unavailable('the retained cancellation capacity was exceeded')
      const cancellations = Object.freeze(barriers.map(request => {
        if (!validNativeGenerationCancellation(request)) unavailable('a retained cancellation barrier is invalid')
        return Object.freeze({ ...request, frontier: Object.freeze({ ...request.frontier }) })
      }))
      const byId = new Map<string, string>()
      const generations = new Map<string, { submitted: boolean; executed: boolean; cancelled: boolean;
        stops: Set<'completed' | 'aborted' | 'error'>; ids: string[] }>()
      for (const input of source.facts) {
        if (!input || !identifier(input.id) || !identifier(input.generationId)) unavailable('a retained fact has an invalid identity')
        const { id, generationId, kind } = input
        if (kind !== 'submitted' && kind !== 'activity' && kind !== 'stopped' && kind !== 'cancelled') {
          unavailable('a retained fact has an unknown kind')
        }
        const status = kind === 'stopped' ? input.status : undefined
        if (kind === 'stopped' && status !== 'completed' && status !== 'aborted' && status !== 'error') {
          unavailable('a retained Stop has an unknown status')
        }
        const keys = Object.keys(input).sort().join(',')
        if (keys !== (kind === 'stopped' ? 'generationId,id,kind,status' : 'generationId,id,kind')) {
          unavailable('a retained fact has an unknown shape')
        }
        const fingerprint = JSON.stringify([generationId, kind, status])
        const previous = byId.get(id)
        if (previous !== undefined) {
          if (previous !== fingerprint) unavailable('a retained fact identity has conflicting content')
          continue
        }
        byId.set(id, fingerprint)
        let state = generations.get(generationId)
        if (!state) {
          if (generations.size === MAX_GENERATIONS) unavailable('the retained generation capacity was exceeded')
          state = { submitted: false, executed: false, cancelled: false, stops: new Set(), ids: [] }
          generations.set(generationId, state)
        }
        state.ids.push(id)
        if (kind === 'submitted') state.submitted = true
        else if (kind === 'cancelled') state.cancelled = true
        else {
          state.executed = true
          if (status) state.stops.add(status)
        }
      }
      const projected = Object.freeze([...generations].sort(([left], [right]) => left < right ? -1 : 1)
        .map(([id, state]): NativeGeneration => {
          const terminal = state.cancelled ? 'cancelled' : state.stops.size > 1 ? 'unresolved' : [...state.stops][0]
          return Object.freeze({ id, submitted: state.submitted, executed: state.executed,
            running: state.executed && terminal === undefined, ...(terminal ? { terminal } : {}),
            factIds: Object.freeze([...state.ids].sort()) })
        }))
      const running = Object.freeze(projected.filter(turn => turn.running))
      const pending = Object.freeze(projected.filter(turn => !turn.executed && turn.terminal === undefined))
      const verifyOwner = (): void => {
        if (identity(source.owner) !== scope) unavailable('the retained source owner changed')
      }
      const verify = (): void => {
        check()
        verifyOwner()
        verifySource()
        verifyOwner()
        check()
      }
      verify()
      return Object.freeze({ owner: original, generations: projected, running, pending, cancellations,
        selection: cancellations.length ? 'cancelled' : running.length > 1 ? 'ambiguous' : running.length === 1 ? 'one' : 'idle', verify })
    },
  }
}
