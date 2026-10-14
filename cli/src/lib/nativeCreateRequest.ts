/** A first native allocation has no predecessor engine or cancellation. Keep
 * its generated identities in the durable request before any pane can start. */
import { isAbsolute } from 'node:path'
import { creationFingerprint, validCreationId } from './agentCreationReceipt.js'

export const NATIVE_CREATE_REQUEST_BYTES = 24 * 1024
export interface NativeCreateRequest extends Record<string, unknown> {
  readonly kind: 'native-create-v2'
  readonly creationId: string
  readonly agentId: string
  readonly launchToken: string
  readonly input: Readonly<Record<string, unknown>>
  readonly selection: Readonly<{ grid: string; model: string }> | null
  readonly label: string
  readonly local: boolean
  readonly projectFolder?: Readonly<Record<string, unknown>>
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const exact = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).sort().join(',') === [...keys].sort().join(',')

/** The same user choice keeps its fingerprint when competing callers propose
 * different generated metadata. Only the first persisted request owns those IDs. */
export function nativeCreateFingerprint(request: NativeCreateRequest): string {
  const choice = request.selection ? { ...request.input, modelSelection: request.selection } : request.input
  return creationFingerprint(request.projectFolder ? { ...choice, projectFolder: request.projectFolder } : choice)
}

export function parseNativeCreateRequest(value: unknown): NativeCreateRequest | null {
  // Reserve space before preparation/dispatch. Keep room for later small rearm
  // references within the allocation list's existing 32 KiB bound. No truncation.
  let bytes = 0, nodes = 0
  const seen = new Set<object>()
  const json = (part: unknown, depth: number): boolean => {
    if (++nodes > 2048 || depth > 16) return false
    if (part === null || typeof part === 'boolean') { bytes += 5; return bytes <= NATIVE_CREATE_REQUEST_BYTES }
    if (typeof part === 'number') return Number.isFinite(part) && (bytes += 24) <= NATIVE_CREATE_REQUEST_BYTES
    if (typeof part === 'string') return part.length <= NATIVE_CREATE_REQUEST_BYTES
      && (bytes += Buffer.byteLength(JSON.stringify(part))) <= NATIVE_CREATE_REQUEST_BYTES
    if (!part || typeof part !== 'object' || seen.has(part)
      || Object.getOwnPropertyDescriptor(part, 'toJSON')
      || (Array.isArray(part) ? Object.getPrototypeOf(part) !== Array.prototype
        : Object.getPrototypeOf(part) !== Object.prototype && Object.getPrototypeOf(part) !== null)) return false
    seen.add(part)
    const array = Array.isArray(part)
    // Sparse length also costs JSON bytes: entries alone could approve a huge
    // empty array before stringify expands it into millions of null values.
    if (array && part.length > 128) return false
    bytes += 2
    let entries = 0
    for (const key in part) if (Object.hasOwn(part, key)) {
      const descriptor = Object.getOwnPropertyDescriptor(part, key)!
      if (++entries > 128 || (bytes += 2) > NATIVE_CREATE_REQUEST_BYTES
        || array && (!/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= part.length)
        || !Object.hasOwn(descriptor, 'value')
        || !array && !json(key, depth + 1) || !json(descriptor.value, depth + 1)) return false
    }
    return !array || entries === part.length
  }
  if (!json(value, 0) || Buffer.byteLength(JSON.stringify(value)) > NATIVE_CREATE_REQUEST_BYTES) return null
  // JSON excludes hidden properties. Validate the same plain data that will be
  // persisted, never invoke a hidden getter while checking required fields.
  value = structuredClone(value)
  if (!object(value) || !exact(value, ['kind', 'creationId', 'agentId', 'launchToken', 'input', 'selection', 'label', 'local',
    ...(Object.hasOwn(value, 'projectFolder') ? ['projectFolder'] : [])])
    || value.kind !== 'native-create-v2' || !validCreationId(value.creationId) || !validCreationId(value.launchToken)
    || typeof value.agentId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value.agentId)
    || typeof value.label !== 'string' || value.label.length > 200 || !/^harness-cursor-[a-z0-9-]+$/.test(value.label)
    || typeof value.local !== 'boolean' || !object(value.input) || value.input.engine !== 'cursor'
    || typeof value.input.cwd !== 'string' || value.input.cwd.length > 4096 || /[\0\r\n]/.test(value.input.cwd)
    || value.input.resumeSessionId != null && value.input.resumeSessionId !== '' || value.input.takeOver === true
    || (value.projectFolder === undefined ? !isAbsolute(value.input.cwd)
      : !object(value.projectFolder) || !['new', 'remote', 'worktree', 'branch'].includes(value.projectFolder.source as string))) return null
  if (value.selection !== null && (!object(value.selection) || !exact(value.selection, ['grid', 'model'])
    || Object.values(value.selection).some(part => typeof part !== 'string' || !part || part.length > 2048
      || part.trim() !== part || /[\x00-\x1f\x7f]/.test(part)))) return null
  const freeze = (part: unknown): void => {
    if (part && typeof part === 'object') { Object.values(part).forEach(freeze); Object.freeze(part) }
  }
  freeze(value)
  return value as NativeCreateRequest
}
