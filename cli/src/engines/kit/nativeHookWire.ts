/** Bounded setup candidates contain bytes for the caller's files, never new destinations. */
import { ENGINES, type AgentEngine } from '../types.js'
import { LAUNCH_LOCATION_VARIABLES } from './nativeLocations.js'

export const HOOK_FILE_LIMIT = 1024 * 1024
export const HOOK_FILES_LIMIT = 4
export const HOOK_TOTAL_LIMIT = 2 * 1024 * 1024
export const HOOK_REPLY_LIMIT = 4 * 1024 * 1024
// Leave room for the authenticated service frame and its bounded request metadata.
const HOOK_PAYLOAD_LIMIT = HOOK_REPLY_LIMIT - 4096

export interface NativeHookInput {
  engine: AgentEngine
  environment: Readonly<Record<string, string>>
  port: number
  major?: number | null
  keepsRecord?: boolean | null
  remove?: boolean
  createMissing?: boolean
  directories?: readonly { path: string; mode?: number }[]
  files: readonly { file: string; directory: string; content: string | null; mode?: number; alias?: boolean }[]
}
export interface NativeHookCandidate {
  version: 1
  files: readonly { index: number; content: string | null }[]
}

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const only = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).every(key => keys.includes(key))
const path = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 4096 && !value.includes('\0')

/** Applied before dispatch and before a reply can acquire publication authority. */
export function boundedHookInput(value: unknown): value is NativeHookInput {
  if (!object(value) || !only(value, ['engine', 'environment', 'port', 'major', 'keepsRecord', 'remove', 'createMissing', 'directories', 'files'])
    || !(ENGINES as readonly unknown[]).includes(value.engine)
    || typeof value.port !== 'number' || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535
    || !object(value.environment) || !only(value.environment, LAUNCH_LOCATION_VARIABLES)
    || Object.values(value.environment).some(entry => typeof entry !== 'string' || entry.includes('\0') || Buffer.byteLength(entry) > 65_536)
    || Buffer.byteLength(JSON.stringify(value.environment)) > 65_536
    || value.major !== undefined && value.major !== null && (typeof value.major !== 'number' || !Number.isSafeInteger(value.major) || value.major < 0)
    || value.keepsRecord !== undefined && value.keepsRecord !== null && typeof value.keepsRecord !== 'boolean'
    || value.remove !== undefined && typeof value.remove !== 'boolean'
    || value.createMissing !== undefined && typeof value.createMissing !== 'boolean'
    || !Array.isArray(value.files) || !value.files.length || value.files.length > HOOK_FILES_LIMIT) return false
  const mode = (value: unknown) => value === undefined || typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0o777
  if (value.directories !== undefined && (!Array.isArray(value.directories) || value.directories.length > 1
    || value.directories.some(directory => !object(directory) || !only(directory, ['path', 'mode']) || !path(directory.path) || !mode(directory.mode)))) return false
  let bytes = 0
  for (const file of value.files) {
    if (!object(file) || !only(file, ['file', 'directory', 'content', 'mode', 'alias']) || !path(file.file) || !path(file.directory)
      || file.content !== null && typeof file.content !== 'string'
      || file.alias !== undefined && typeof file.alias !== 'boolean' || !mode(file.mode)) return false
    const length = file.content === null ? 0 : Buffer.byteLength(file.content)
    if (length > HOOK_FILE_LIMIT || (bytes += length) > HOOK_TOTAL_LIMIT) return false
  }
  return new Set(value.files.map(file => file.file)).size === value.files.length
    && Buffer.byteLength(JSON.stringify(value)) <= HOOK_PAYLOAD_LIMIT
}

export function hookCandidate(value: unknown, count: number, reply?: unknown): NativeHookCandidate | null {
  if (!Number.isInteger(count) || count < 1 || count > HOOK_FILES_LIMIT || !object(value) || !only(value, ['version', 'files'])
    || value.version !== 1 || !Array.isArray(value.files) || value.files.length !== count) return null
  let bytes = 0
  for (const [index, file] of value.files.entries()) {
    if (!object(file) || !only(file, ['index', 'content']) || file.index !== index
      || file.content !== null && typeof file.content !== 'string') return null
    const length = file.content === null ? 0 : Buffer.byteLength(file.content as string)
    if (length > HOOK_FILE_LIMIT || (bytes += length) > HOOK_TOTAL_LIMIT) return null
  }
  if (Buffer.byteLength(JSON.stringify(reply ?? value)) > HOOK_PAYLOAD_LIMIT) return null
  return value as unknown as NativeHookCandidate
}
