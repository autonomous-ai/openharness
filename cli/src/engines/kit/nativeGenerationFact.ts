/** Confirmed observations do not grant permission to replay an effect. Their
 * process incarnation is the enclosing journal's immutable namespace. */
import { createHash } from 'node:crypto'
import { validNativeHookWireIdentity, type NativeHookWireIdentity } from './nativeHookClientProtocol.js'

export type NativeGenerationFactRecord = {
  id: string
  agentId: string
  conversationId: string
  generationId: string
} & (
  | { kind: 'submitted' | 'activity'; source: NativeGenerationFactOrigin }
  | { kind: 'stopped'; status: 'completed' | 'aborted' | 'error'; source: NativeGenerationFactOrigin }
  | { kind: 'cancelled'; source: { type: 'core'; requestId: string } }
)
export interface NativeGenerationFactOrigin {
  type: 'native'
  deliveryId: string
  firedAt: number
  wire: NativeHookWireIdentity
  /** A matching Stop can consume its existing terminal reservation without a
   * new registration intake. Retain the original process image proof with it. */
  identityV1?: string
}
export const MAX_NATIVE_GENERATION_FACT_BYTES = 4096
export const MAX_NATIVE_GENERATIONS = 512
const identifier = (value: unknown): value is string => typeof value === 'string'
  && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value)
const deliveryId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{16,96}$/.test(value)
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const keys = (value: object, expected: string) => Object.keys(value).sort().join(',') === expected

/** Registration and Stop can share a delivery UUID. Their paths cannot share a
 * fact identity, nor can a native input impersonate a core cancellation. */
export function nativeGenerationFactId(fact: Omit<NativeGenerationFactRecord, 'id'>): string {
  const { source } = fact
  return createHash('sha256').update(JSON.stringify(source.type === 'native'
    ? ['native', source.deliveryId, source.wire.path]
    : ['core', source.requestId, fact.agentId, fact.conversationId, fact.generationId])).digest('hex')
}

export function validNativeGenerationFact(value: unknown): value is NativeGenerationFactRecord {
  if (!object(value) || !identifier(value.agentId) || !identifier(value.conversationId)
    || !identifier(value.generationId) || !object(value.source)
    || Buffer.byteLength(JSON.stringify(value)) > MAX_NATIVE_GENERATION_FACT_BYTES) return false
  const base = 'agentId,conversationId,generationId,id,kind,source'
  if (!keys(value, value.kind === 'stopped' ? base + ',status' : base)) return false
  const source = value.source
  if (value.kind === 'cancelled') {
    if (source.type !== 'core' || !keys(source, 'requestId,type') || !deliveryId(source.requestId)) return false
  } else {
    if (value.kind !== 'submitted' && value.kind !== 'activity' && value.kind !== 'stopped') return false
    if (value.kind === 'stopped' && !['completed', 'aborted', 'error'].includes(value.status as string)) return false
    if (source.type !== 'native' || !keys(source, source.identityV1 === undefined ? 'deliveryId,firedAt,type,wire' : 'deliveryId,firedAt,identityV1,type,wire')
      || source.identityV1 !== undefined && (value.kind !== 'stopped' || typeof source.identityV1 !== 'string' || !/^[a-f0-9]{64}$/.test(source.identityV1))
      || !deliveryId(source.deliveryId)
      || !Number.isSafeInteger(source.firedAt) || Number(source.firedAt) <= 0 || !validNativeHookWireIdentity(source.wire)) return false
  }
  return value.id === nativeGenerationFactId(value as unknown as NativeGenerationFactRecord)
}

/** Late activity cannot allocate a fresh obligation for a terminal generation. */
export function nativeGenerationFactState(facts: Iterable<NativeGenerationFactRecord>) {
  const generations = new Map<string, 'pending' | 'running' | 'terminal'>()
  for (const fact of facts) {
    const key = JSON.stringify([fact.agentId, fact.conversationId, fact.generationId])
    const before = generations.get(key)
    generations.set(key, before === 'terminal' || fact.kind === 'stopped' || fact.kind === 'cancelled' ? 'terminal'
      : before === 'running' || fact.kind === 'activity' ? 'running' : 'pending')
  }
  return generations
}
