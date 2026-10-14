/** Native answers are already retained by the core's generation journal. The
 * recaps service derives a view of these exact bytes; it never chooses a turn. */
import { createHash } from 'node:crypto'

export const NATIVE_RECAP_VERSION = 1

export interface NativeRecapCompletion {
  readonly id: string
  readonly owner: { readonly agentId: string; readonly sessionId: string; readonly processKey: string }
  readonly generationId: string
  readonly responseText: string
}
export type NativeRecapResult = {
  readonly state: 'ready'
  readonly id: string
  readonly sourceDigest: string
  readonly version: typeof NATIVE_RECAP_VERSION
  readonly summary: string | null
} | { readonly state: 'held'; readonly reason: string }

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const identifier = (value: unknown): value is string => typeof value === 'string'
  && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value)
export const nativeRecapWaiting = (reason = 'Waiting for the recaps service.'): NativeRecapResult => Object.freeze({ state: 'held', reason })

export function nativeRecapId(owner: NativeRecapCompletion['owner'], generationId: string): string {
  return hash([owner.agentId, owner.sessionId, owner.processKey, generationId])
}

/** Copy before crossing a service wait. Missing content cannot become an empty
 * answer, and an optional prompt cannot change this answer's retry identity. */
export function copyNativeRecapCompletion(value: unknown): NativeRecapCompletion {
  const completion = object(value), owner = object(completion?.owner)
  if (!completion || !owner || Object.keys(completion).sort().join(',') !== 'generationId,id,owner,responseText'
    || Object.keys(owner).sort().join(',') !== 'agentId,processKey,sessionId'
    || !identifier(owner.agentId) || !identifier(owner.sessionId) || !identifier(completion.generationId)
    || typeof owner.processKey !== 'string' || !owner.processKey.length || owner.processKey.length > 512
    || typeof completion.responseText !== 'string' || Buffer.byteLength(completion.responseText) > 128 * 1024) {
    throw Error('Waiting for the original native answer.')
  }
  const original = Object.freeze({ agentId: owner.agentId, sessionId: owner.sessionId, processKey: owner.processKey })
  const generationId = completion.generationId
  if (completion.id !== nativeRecapId(original, generationId)) throw Error('Waiting for the original native recap identity.')
  return Object.freeze({ id: completion.id as string, owner: original, generationId, responseText: completion.responseText })
}

export function nativeRecapDigest(completion: NativeRecapCompletion): string {
  return hash([completion.id, completion.owner.agentId, completion.owner.sessionId, completion.owner.processKey,
    completion.generationId, completion.responseText])
}

/** A ready answer names both the generation and its immutable input bytes. It
 * grants no authority to emit an ordinary session frame or clear a live card. */
export function readNativeRecapResult(value: unknown, original: NativeRecapCompletion): NativeRecapResult {
  const result = object(value)
  if (result?.state === 'held' && Object.keys(result).sort().join(',') === 'reason,state'
    && typeof result.reason === 'string' && result.reason.length > 0 && result.reason.length <= 1024) {
    return nativeRecapWaiting(result.reason)
  }
  if (!result || Object.keys(result).sort().join(',') !== 'id,sourceDigest,state,summary,version'
    || result.state !== 'ready' || result.id !== original.id || result.sourceDigest !== nativeRecapDigest(original)
    || result.version !== NATIVE_RECAP_VERSION
    || result.summary !== null && (typeof result.summary !== 'string' || Buffer.byteLength(result.summary) > 8192)) {
    return nativeRecapWaiting('Waiting for the original native recap result.')
  }
  return Object.freeze({ state: 'ready', id: original.id, sourceDigest: result.sourceDigest as string, version: NATIVE_RECAP_VERSION,
    summary: result.summary as string | null })
}
