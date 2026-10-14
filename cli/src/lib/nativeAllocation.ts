/** Permanent references to original launch receipts. Cancel may replace R, but
 * cannot forget an engine or pane which still needs physical accounting. */
import { IdentityReadUnavailable } from '../engines/kit/identityScan.js'
import { creationFingerprint, validCreationId, type NativeRelaunchRequest } from './agentCreationReceipt.js'
import { parseNativeTurnProcessReference } from './nativeTurnIntent.js'
import { nativeCreateFingerprint, parseNativeCreateRequest } from './nativeCreateRequest.js'

export const NATIVE_ALLOCATION_LIMIT = 4
export interface NativeAllocation {
  /** Version 1 keeps rearm-only history unchanged. Version 2 begins with the
   * exact first creation, which has no predecessor process to account for. */
  readonly version: 1 | 2
  readonly receipts: readonly Readonly<NativeRelaunchRequest>[]
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const exact = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).sort().join(',') === [...keys].sort().join(',')
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)

/** Preserve the complete original request, including omitted fields. Its target
 * predates admission and must never be regenerated from a later Registry row. */
function receipt(value: unknown): Readonly<NativeRelaunchRequest> | null {
  if (!object(value) || !exact(value, ['fingerprint', 'request']) || !digest(value.fingerprint) || !object(value.request)) return null
  const request = value.request
  if (request.kind === 'native-create-v2') {
    const initial = parseNativeCreateRequest(request)
    return initial && nativeCreateFingerprint(initial) === value.fingerprint
      ? Object.freeze({ fingerprint: value.fingerprint, request: initial }) : null
  }
  if (!exact(request, ['kind', 'creationId', 'agentId', 'operation', 'source', 'target', 'launchToken',
    ...(Object.hasOwn(request, 'permissionMode') ? ['permissionMode'] : []),
    ...(Object.hasOwn(request, 'sourceProcess') ? ['sourceProcess'] : [])])
    || request.kind !== 'native-rearm' || !validCreationId(request.creationId) || !validCreationId(request.launchToken)
    || typeof request.agentId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(request.agentId)
    || !digest(request.target) || request.operation !== 'restart' && request.operation !== 'resume'
    || request.source !== 'live' && request.source !== 'saved'
    || request.source === 'saved' && request.operation !== 'resume'
    || Object.hasOwn(request, 'permissionMode') && (request.operation !== 'resume'
      || !['ask', 'auto', 'plan', 'full'].includes(request.permissionMode as string))
    || Object.hasOwn(request, 'sourceProcess') && !parseNativeTurnProcessReference(request.sourceProcess)) return null
  const fingerprint = creationFingerprint({ kind: 'native-rearm', agentId: request.agentId,
    operation: request.operation, source: request.source,
    ...(Object.hasOwn(request, 'permissionMode') ? { permissionMode: request.permissionMode } : {}),
  })
  if (fingerprint !== value.fingerprint) return null
  const copied = structuredClone(request)
  if (copied.sourceProcess) Object.freeze(copied.sourceProcess)
  return Object.freeze({ fingerprint, request: Object.freeze(copied) })
}

export function parseNativeAllocation(value: unknown): NativeAllocation | null {
  if (!object(value) || !exact(value, ['version', 'receipts']) || value.version !== 1 && value.version !== 2
    || !Array.isArray(value.receipts) || !value.receipts.length || value.receipts.length > NATIVE_ALLOCATION_LIMIT) return null
  const receipts = Array.from(value.receipts, receipt)
  if (receipts.some(value => !value)) return null
  const original = receipts as Readonly<NativeRelaunchRequest>[]
  const initial = original.filter(value => value.request.kind === 'native-create-v2')
  if ((value.version === 1 ? initial.length !== 0 : initial.length !== 1 || original[0] !== initial[0])
    || new Set(original.map(value => value.request.creationId)).size !== original.length
    || new Set(original.map(value => value.request.launchToken)).size !== original.length
    || new Set(original.map(value => value.request.agentId)).size !== 1
    || Buffer.byteLength(JSON.stringify(original)) > 32 * 1024) return null
  return Object.freeze({ version: value.version, receipts: Object.freeze(original) })
}

/** Only this distinct state can lack Cancel. Later schema-4 rows must retain
 * their control even when the first creation is still in their history. */
export function nativeAllocationIsInitial(value: NativeAllocation): boolean {
  return value.version === 2 && value.receipts.length === 1 && value.receipts[0].request.kind === 'native-create-v2'
}

/** Only the proven admission transaction calls this. Existing entries retain
 * their order; repeating the same original admission does not consume capacity. */
export function appendNativeAllocation(previous: NativeAllocation | undefined, input: NativeRelaunchRequest): NativeAllocation {
  const saved = previous === undefined ? undefined : parseNativeAllocation(previous), next = receipt(input)
  const held = (): never => { throw new IdentityReadUnavailable('the original native allocation references are unavailable or full') }
  if (previous !== undefined && !saved || !next) return held()
  const existing = saved?.receipts.find(value => value.request.creationId === next.request.creationId)
  if (existing) return creationFingerprint(existing) === creationFingerprint(next) ? saved! : held()
  const proposed = parseNativeAllocation({ version: saved?.version ?? (next.request.kind === 'native-create-v2' ? 2 : 1),
    receipts: [...(saved?.receipts ?? []), next] })
  return proposed ?? held()
}

/** The single durable R reserves this capacity before its first effect. A prior
 * receipt cannot be reinterpreted as a new reservation, even after later Cancel. */
export function nativeAllocationCanReserve(previous: NativeAllocation | undefined, requestId: string, launchToken?: string): boolean {
  if (previous === undefined) return true
  const saved = parseNativeAllocation(previous)
  return !!saved && saved.receipts.length < NATIVE_ALLOCATION_LIMIT
    && !saved.receipts.some(value => value.request.creationId === requestId || value.request.launchToken === launchToken)
}
