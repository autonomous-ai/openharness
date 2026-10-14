/** A cancellation names the original journal prefix, never "whatever is current"
 * when disk catches up. Its barrier belongs to the whole native incarnation. */
import { MAX_NATIVE_GENERATIONS, nativeGenerationFactId, nativeGenerationFactState,
  type NativeGenerationFactRecord } from './nativeGenerationFact.js'

export interface NativeGenerationFrontier { readonly index: number; readonly digest: string | null }
export interface NativeGenerationCancellation {
  readonly requestId: string
  readonly nonce: string
  readonly agentId: string
  readonly conversationId: string
  readonly frontier: NativeGenerationFrontier
}
// A compact cancellation can synthesize one tombstone per owner/generation,
// globally deduplicated. The journal itself still has at most 4,096 records.
export const MAX_RETAINED_GENERATION_FACTS = 4096 + MAX_NATIVE_GENERATIONS
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const identifier = (value: unknown): value is string => typeof value === 'string'
  && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value)
const requestId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{16,96}$/.test(value)

export function validNativeGenerationFrontier(value: unknown): value is NativeGenerationFrontier {
  if (!object(value) || Object.keys(value).sort().join(',') !== 'digest,index') return false
  const { index, digest } = value
  return Number.isInteger(index) && Number(index) >= -1 && Number(index) < 4096
    && (index === -1 ? digest === null : typeof digest === 'string' && /^[a-f0-9]{64}$/.test(digest))
}

export function validNativeGenerationCancellation(value: unknown): value is NativeGenerationCancellation {
  if (!object(value) || Object.keys(value).sort().join(',') !== 'agentId,conversationId,frontier,nonce,requestId'
    || !identifier(value.agentId) || !identifier(value.conversationId) || !requestId(value.requestId) || !requestId(value.nonce)
    || !validNativeGenerationFrontier(value.frontier)) return false
  return Buffer.byteLength(JSON.stringify(value)) <= 4096
}

export function nativeCancellationFact(request: NativeGenerationCancellation, generationId: string): NativeGenerationFactRecord {
  const fact = { agentId: request.agentId, conversationId: request.conversationId, generationId, kind: 'cancelled' as const,
    source: { type: 'core' as const, requestId: request.requestId } }
  return { ...fact, id: nativeGenerationFactId(fact) }
}

/** Prefix positions also cover earlier synthetic tombstones. A later request
 * can refer to an old prefix without expanding its targets from newer facts. */
export function nativeCancellationTargets(request: NativeGenerationCancellation,
  facts: ReadonlyMap<string, NativeGenerationFactRecord>, positions: ReadonlyMap<string, number>, chain: readonly string[],
): readonly string[] {
  if (!validNativeGenerationCancellation(request)
    || (request.frontier.index >= 0 && chain[request.frontier.index] !== request.frontier.digest)) {
    throw Error('the original cancellation frontier is unavailable')
  }
  const selected = [...facts.values()].filter(fact => positions.get(fact.id)! <= request.frontier.index
    && fact.agentId === request.agentId && fact.conversationId === request.conversationId)
  return Object.freeze([...nativeGenerationFactState(selected)]
    .filter(([, state]) => state !== 'terminal').map(([key]) => (JSON.parse(key) as string[])[2]).sort())
}
