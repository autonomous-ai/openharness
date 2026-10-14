/** Durable admission state belongs to the agent, even when recovery changes its
 * process. The process journal remains the only authority for physical Cancel. */
import { createHash } from 'node:crypto'
import { validNativeGenerationCancellation, type NativeGenerationCancellation } from '../engines/kit/nativeGenerationCancellation.js'
import { validNativeHookWriter, type NativeHookWriter } from '../engines/kit/nativeHookWriter.js'
import type { RegisteredSession } from './registry.js'
import { creationFingerprint } from './agentCreationReceipt.js'
import { nativeAllocationCanReserve } from './nativeAllocation.js'

export interface NativeTurnProcessReference {
  readonly processKey: string | null
  readonly namespace?: string
}

export interface NativeTurnIntent {
  readonly version: 1
  readonly cancel: {
    /** Null retains Cancel when no native owner was proven at request entry.
     * It grants no interrupt authority and can never be filled in by recovery. */
    readonly processKey: string | null
    /** Captured with the original engine. Missing historical scope can never be
     * filled from a later PID view, including on an otherwise identical retry. */
    readonly namespace?: string
    readonly target: string
    readonly request: NativeGenerationCancellation
  }
  readonly rearm?: {
    readonly requestId: string
    readonly agentId: string
    readonly operation: 'restart' | 'resume'
    readonly target: string
    readonly launchToken: string
    /** Retain the complete request before its creation receipt is published.
     * Older incomplete reservations stay readable but cannot be dispatched. */
    readonly source?: 'live' | 'saved'
    readonly permissionMode?: 'ask' | 'auto' | 'plan' | 'full'
    /** A later Cancel may replace cancel with an unknown owner while this launch
     * is pending. Keep the old engine obligation separately from the new exec.
     * Missing legacy provenance and explicit null both grant no death authority. */
    readonly sourceProcess?: NativeTurnProcessReference
    /** Cancel revokes admission without forgetting an already claimed launch.
     * Its exact receipt must be reconciled before another launch is reserved. */
    readonly revoked?: true
    readonly replacement?: { readonly processKey: string; readonly sessionId: string }
  }
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const exact = (value: Record<string, unknown>, keys: string) => Object.keys(value).sort().join(',') === keys
const identifier = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value)
const processKey = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512
const token = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{16,96}$/.test(value)
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)

/** Only a complete original Cursor association can be used for precise death
 * observations. Legacy opaque keys remain readable without that authority. */
export function nativeTurnProcess(owner: { processKey: unknown; namespace?: unknown }): Readonly<NativeHookWriter> | null {
  if (typeof owner.processKey !== 'string' || owner.processKey.length > 512 || typeof owner.namespace !== 'string') return null
  const parts = owner.processKey.split('\0')
  if (parts.length !== 4 || parts[1] !== 'cursor' || String(Number(parts[2])) !== parts[2]) return null
  const process = { boot: parts[0], namespace: owner.namespace, pid: Number(parts[2]), birth: parts[3] }
  return validNativeHookWriter(process) ? Object.freeze(process) : null
}

export function parseNativeTurnProcessReference(value: unknown): NativeTurnProcessReference | null {
  if (!object(value) || !exact(value, Object.hasOwn(value, 'namespace') ? 'namespace,processKey' : 'processKey')
    || value.processKey !== null && !processKey(value.processKey)
    || Object.hasOwn(value, 'namespace') && !nativeTurnProcess({ processKey: value.processKey, namespace: value.namespace })) return null
  return Object.freeze({ processKey: value.processKey as string | null,
    ...(Object.hasOwn(value, 'namespace') ? { namespace: value.namespace as string } : {}) })
}

/** No caller may normalize unknown control data into an uncancelled agent.
 * Archives can have a new row ID: preserve the original Cancel owner verbatim. */
export function parseNativeTurnIntent(value: unknown): NativeTurnIntent | null {
  if (!object(value) || value.version !== 1 || !exact(value, value.rearm === undefined ? 'cancel,version' : 'cancel,rearm,version')) return null
  const cancel = value.cancel
  if (!object(cancel) || !exact(cancel, Object.hasOwn(cancel, 'namespace') ? 'namespace,processKey,request,target' : 'processKey,request,target')
    || Object.hasOwn(cancel, 'namespace') && !nativeTurnProcess({ processKey: cancel.processKey, namespace: cancel.namespace })
    || cancel.processKey !== null && !processKey(cancel.processKey)
    || !digest(cancel.target)) return null
  // Cancel before the first native binding still holds this agent. Only that
  // null-owner association may omit a conversation; it is never a journal request.
  const unbound = cancel.processKey === null && object(cancel.request) && cancel.request.conversationId === ''
  if (!validNativeGenerationCancellation(unbound ? { ...cancel.request as object, conversationId: 'unbound' } : cancel.request)) return null
  const request = cancel.request as NativeGenerationCancellation
  if (cancel.processKey === null && request.frontier.index !== -1) return null
  const rearm = value.rearm
  if (rearm !== undefined) {
    if (!object(rearm) || !exact(rearm, ['agentId', 'launchToken', 'operation', 'requestId', 'target',
      ...(rearm.source === undefined ? [] : ['source']), ...(rearm.permissionMode === undefined ? [] : ['permissionMode']),
      ...(Object.hasOwn(rearm, 'sourceProcess') ? ['sourceProcess'] : []),
      ...(rearm.replacement === undefined ? [] : ['replacement']), ...(rearm.revoked === undefined ? [] : ['revoked'])].sort().join(','))
      || Object.hasOwn(rearm, 'sourceProcess') && !parseNativeTurnProcessReference(rearm.sourceProcess)
      || rearm.revoked !== undefined && rearm.revoked !== true
      || rearm.source !== undefined && rearm.source !== 'live' && rearm.source !== 'saved'
      || rearm.permissionMode !== undefined && (!rearm.source || rearm.operation !== 'resume'
        || !['ask', 'auto', 'plan', 'full'].includes(rearm.permissionMode as string))
      || !token(rearm.requestId) || !identifier(rearm.agentId) || (rearm.operation !== 'restart' && rearm.operation !== 'resume')
      || !digest(rearm.target) || !token(rearm.launchToken)) return null
    if (rearm.replacement !== undefined && (!object(rearm.replacement) || !exact(rearm.replacement, 'processKey,sessionId')
      || !processKey(rearm.replacement.processKey) || rearm.replacement.processKey === cancel.processKey
      || !identifier(rearm.replacement.sessionId))) return null
  }
  const copied = structuredClone(value) as unknown as NativeTurnIntent
  Object.freeze(copied.cancel.request.frontier); Object.freeze(copied.cancel.request); Object.freeze(copied.cancel)
  if (copied.rearm) {
    if (copied.rearm.sourceProcess) Object.freeze(copied.rearm.sourceProcess)
    if (copied.rearm.replacement) Object.freeze(copied.rearm.replacement)
    Object.freeze(copied.rearm)
  }
  return Object.freeze(copied)
}

/** Persistent fields only: transient holds and observation counters cannot
 * change the identity of the original durable launch/cancellation target. */
export function nativeTurnTarget(row: RegisteredSession): string {
  const identity: unknown[] = [row.agentId, row.registeredAt, row.engine, row.sessionId, row.boundAt,
    row.active, row.processIdentity && [row.processIdentity.pid, row.processIdentity.executable, row.processIdentity.startMarker, row.processIdentity.startTicks ?? null],
    row.runtimes.map(route => [route.backend, route.paneId]), row.primaryRuntimeKey, row.tmuxPane ?? null, row.cwd,
    row.transcriptPath, row.codexHome ?? null, row.hermesHome ?? null,
    row.permissionMode ?? null, row.bypassPermission === true]
  // Older cancellations keep their existing digest. A transferred visit also
  // pins its original archive link, which later Cancel and Restart preserve.
  if (row.nativeArchive) identity.push(['native-archive', row.nativeArchive.version, row.nativeArchive.agentId,
    row.nativeArchive.requestId, row.nativeArchive.launchToken, row.nativeArchive.target])
  if (row.nativeRetirement) identity.push(['native-retirement', row.nativeRetirement.sourceTarget,
    row.nativeRetirement.controlFingerprint, row.nativeRetirement.checkpoint, row.nativeRetirement.savedTarget])
  if (row.nativeRetirement?.pendingAbort) identity.push(['native-pending-abort', row.nativeRetirement.pendingAbort.priorRole,
    row.nativeRetirement.pendingAbort.pendingControl, row.nativeRetirement.pendingAbort.requestFingerprint])
  if (row.nativeCreation) identity.push(['native-creation', creationFingerprint(row.nativeCreation)])
  if (row.nativeAllocation) identity.push(['native-allocation', creationFingerprint(row.nativeAllocation)])
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex')
}

/** Recovery reconstructs only the immutable reserved request, including whether
 * the user omitted a permission override. It never fills options from today's
 * row or caller. Revoked requests retain the same bytes for receipt cancellation. */
export function nativeRearmRequest(intent: NativeTurnIntent): Readonly<Record<string, unknown>> | null {
  const rearm = parseNativeTurnIntent(intent)?.rearm
  if (!rearm?.source) return null
  return Object.freeze({ kind: 'native-rearm', creationId: rearm.requestId, agentId: rearm.agentId,
    operation: rearm.operation, target: rearm.target, launchToken: rearm.launchToken, source: rearm.source,
    ...(rearm.permissionMode === undefined ? {} : { permissionMode: rearm.permissionMode }),
    ...(rearm.sourceProcess === undefined ? {} : { sourceProcess: rearm.sourceProcess }),
  })
}

export function nativeTurnAdmitted(intent: NativeTurnIntent | undefined, owner: { agentId: string; sessionId: string; processKey: string }): boolean {
  if (!intent) return true
  return !intent.rearm?.revoked && intent.rearm?.agentId === owner.agentId && intent.rearm.replacement?.processKey === owner.processKey
    && intent.rearm.replacement.sessionId === owner.sessionId
}

/** A proof supplied by a caller can confirm native facts, but cannot skip the
 * durable reservation or replace its original Cancel/launch identity. */
export function nativeTurnTransition(row: RegisteredSession, next: NativeTurnIntent): boolean {
  if (row.nativeRetirement || row.nativeCreation && (next.rearm || next.cancel.processKey !== null)) return false
  const previous = row.nativeControl
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
  const source = (value: NativeTurnProcessReference | undefined) => value && [value.processKey, Object.hasOwn(value, 'namespace'), value.namespace]
  const cancel = () => next.cancel.target === nativeTurnTarget(row)
    && next.cancel.request.agentId === row.agentId && next.cancel.request.conversationId === row.sessionId
  if (!previous) return !next.rearm && cancel()
  // Compare fields independently of caller property order.
  const originalCancel = (value: NativeTurnIntent['cancel']) => [value.processKey, value.target, value.request.requestId,
    value.request.nonce, value.request.agentId, value.request.conversationId, value.request.frontier.index, value.request.frontier.digest, value.namespace]
  if (!same(originalCancel(previous.cancel), originalCancel(next.cancel))) {
    // A newly admitted replacement may itself be cancelled. An unknown owner
    // never becomes known by filling in the old request after recovery.
    if (!previous.rearm || !cancel() || next.cancel.request.requestId === previous.cancel.request.requestId) return false
    if (!previous.rearm.replacement) return next.cancel.processKey === null
      && same(next.rearm, { ...previous.rearm, revoked: true })
    return !next.rearm && (next.cancel.processKey === null || next.cancel.processKey === previous.rearm.replacement.processKey)
  }
  const reserved = previous.rearm, proposed = next.rearm
  if (!reserved) return !proposed || nativeAllocationCanReserve(row.nativeAllocation, proposed.requestId, proposed.launchToken)
    && !proposed.replacement && !proposed.revoked && proposed.agentId === row.agentId
    && proposed.target === nativeTurnTarget(row)
    && proposed.sourceProcess !== undefined && same(source(proposed.sourceProcess), source(previous.cancel))
  // The caller must account for the old sourceProcess and the new allocation.
  // A never-dispatched receipt discharges only the new launch, not the old engine.
  if (!proposed) return reserved.revoked === true
  if (!same([reserved.requestId, reserved.agentId, reserved.operation, reserved.target, reserved.launchToken, reserved.revoked,
    reserved.source, reserved.permissionMode, source(reserved.sourceProcess)],
    [proposed.requestId, proposed.agentId, proposed.operation, proposed.target, proposed.launchToken, proposed.revoked,
      proposed.source, proposed.permissionMode, source(proposed.sourceProcess)])) return false
  if (reserved.replacement) return same([reserved.replacement.processKey, reserved.replacement.sessionId],
    proposed.replacement && [proposed.replacement.processKey, proposed.replacement.sessionId])
  return !proposed.replacement || proposed.agentId === row.agentId && proposed.replacement.sessionId === row.sessionId
}
