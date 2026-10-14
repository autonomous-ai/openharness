/** Persisted client bytes cross only a versioned mutation route. An older core
 * must reject the request before effects, not merely omit an acknowledgement. */
import { createHash } from 'node:crypto'
import type { NativeHookClientDelivery } from './nativeHookOutbox.js'
import type { NativeHookPhase } from './nativeHookJournal.js'

export const NATIVE_HOOK_CLIENT_PROTOCOL = 1
export const NATIVE_HOOK_ROUTE_PREFIX = '/api/native-hook/v1/'
export type NativeHookClientPhase = NativeHookClientDelivery['phases'][number]
/** Derived by the server from the received bytes, never accepted from JSON. */
export interface NativeHookWireIdentity { version: 1; path: string; bodySha256: string }
export interface NativeHookAcknowledgement {
  version: 1
  id: string
  firedAt: number
  phase: NativeHookPhase
  path: string
  bodySha256: string
  outcome: 'owned' | 'complete'
}
const paths = new Set(['session-start', 'turn-stop', 'session-end', 'turn-start', 'tool-start'])
const hash = (text: string) => createHash('sha256').update(text).digest('hex')

export function nativeHookWireIdentity(path: string, body: string): NativeHookWireIdentity {
  return { version: 1, path: nativeHookMutationRoute(path), bodySha256: hash(body) }
}
export function validNativeHookWireIdentity(value: unknown): value is NativeHookWireIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const wire = value as Record<string, unknown>
  return Object.keys(wire).length === 3 && wire.version === 1 && typeof wire.path === 'string'
    && wire.path.startsWith(NATIVE_HOOK_ROUTE_PREFIX) && paths.has(wire.path.slice(NATIVE_HOOK_ROUTE_PREFIX.length))
    && typeof wire.bodySha256 === 'string' && /^[a-f0-9]{64}$/.test(wire.bodySha256)
}

export function nativeHookMutationRoute(path: string): string {
  const name = path.slice('/api/hook/'.length)
  if (!path.startsWith('/api/hook/') || !paths.has(name)) throw Error('Unsupported native hook phase route')
  return NATIVE_HOOK_ROUTE_PREFIX + name
}

/** Only the core's confirmed phase boundary may create this receipt. A live
 * callback, early ignored reply, or scheduled Stop is not durable ownership. */
export function nativeHookAcknowledgement(
  delivery: Pick<NativeHookClientDelivery, 'id' | 'firedAt'>,
  phase: Pick<NativeHookClientPhase, 'name' | 'path' | 'body'>,
  outcome: NativeHookAcknowledgement['outcome'],
): NativeHookAcknowledgement {
  return { version: NATIVE_HOOK_CLIENT_PROTOCOL, id: delivery.id, firedAt: delivery.firedAt,
    phase: phase.name, path: nativeHookMutationRoute(phase.path), bodySha256: hash(phase.body), outcome }
}

/** Validate a complete response, not HTTP success. Phase transfer says nothing
 * about deleting Cursor tasks; that needs its own current turn authority. */
export function readNativeHookAcknowledgement(
  value: unknown, delivery: Pick<NativeHookClientDelivery, 'id' | 'firedAt'>,
  phase: Pick<NativeHookClientPhase, 'name' | 'path' | 'body'>,
): NativeHookAcknowledgement | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  const ack = value as Record<string, unknown>
  if (Object.keys(ack).length !== 7 || ack.outcome !== 'owned' && ack.outcome !== 'complete') return
  const expected = nativeHookAcknowledgement(delivery, phase, ack.outcome)
  if (!Object.entries(expected).every(([key, entry]) => ack[key] === entry)) return
  return expected
}
