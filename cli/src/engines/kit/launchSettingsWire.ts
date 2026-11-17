/** Optional launch values are bounded data, never flags, commands to dispatch, or publication destinations. */
import { launchContract } from '../launches.js'
import { LAUNCH_LOCATION_VARIABLES } from './nativeLocations.js'
import { HOOK_FILE_LIMIT, HOOK_REPLY_LIMIT, HOOK_TOTAL_LIMIT, type NativeHookInput } from './nativeHookWire.js'

export const LAUNCH_VALUE_LIMIT = 65_536
export const LAUNCH_SOURCE_LIMIT = 256
/** Optional trust already uses this bound; setup values must not delay a session beyond it. */
export const LAUNCH_SETTINGS_TIMEOUT_MS = 5000
export interface LaunchSettingsInput {
  purpose: 'launchSettings'
  engine: 'claude' | 'codex'
  environment: Readonly<Record<string, string>>
  cwd: string | null
  dataDir: string
  runtimeNode: string
  platform: 'darwin' | 'linux' | 'win32'
  gitBash: string | null
  /** The current sign-in's non-secret identity; optional instructions never cross this owner. */
  owner: { machineId: string; accountId?: string; epoch?: string } | null
  /** Read-only captured sources have no publication indices. */
  sources: readonly { file: string; content: string | null }[]
  /** At most the core-selected statusline script; Codex needs no output file. */
  files: NativeHookInput['files']
}
export interface LaunchSettingsCandidate {
  version: 1
  values: { instructions: string | null; settings: string | null }
  files: readonly { index: 0; content: string }[]
}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const only = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).every(key => keys.includes(key))
const text = (value: unknown, limit: number): value is string => typeof value === 'string' && !value.includes('\0') && Buffer.byteLength(value) <= limit
const path = (value: unknown): value is string => text(value, 4096) && value.length > 0
const valueSlot = (value: unknown): value is string | null => value === null || text(value, LAUNCH_VALUE_LIMIT)

/** This does not relax ordinary hook input or its four-file publication rules. */
export function boundedLaunchSettingsInput(value: unknown): value is LaunchSettingsInput {
  if (!record(value) || !only(value, ['purpose', 'engine', 'environment', 'cwd', 'dataDir', 'runtimeNode', 'platform', 'gitBash', 'owner', 'sources', 'files'])
    || value.purpose !== 'launchSettings' || value.engine !== 'claude' && value.engine !== 'codex'
    || !record(value.environment) || !only(value.environment, LAUNCH_LOCATION_VARIABLES)
    || Object.values(value.environment).some(entry => !text(entry, LAUNCH_VALUE_LIMIT))
    || Buffer.byteLength(JSON.stringify(value.environment)) > LAUNCH_VALUE_LIMIT
    || value.cwd !== null && !path(value.cwd) || !path(value.dataDir) || !path(value.runtimeNode)
    || !['darwin', 'linux', 'win32'].includes(String(value.platform)) || value.gitBash !== null && !path(value.gitBash)
    || value.owner !== null && (!record(value.owner) || !only(value.owner, ['machineId', 'accountId', 'epoch']) || !path(value.owner.machineId)
      || value.owner.accountId !== undefined && !path(value.owner.accountId) || value.owner.epoch !== undefined && !path(value.owner.epoch))
    || !Array.isArray(value.sources) || value.sources.length > LAUNCH_SOURCE_LIMIT
    || !Array.isArray(value.files) || value.files.length > (value.engine === 'claude' ? 1 : 0)) return false
  let bytes = 0
  for (const source of value.sources) {
    if (!record(source) || !only(source, ['file', 'content']) || !path(source.file)
      || source.content !== null && !text(source.content, HOOK_FILE_LIMIT)) return false
    bytes += source.content === null ? 0 : Buffer.byteLength(source.content as string)
  }
  if (new Set(value.sources.map(source => source.file)).size !== value.sources.length) return false
  for (const file of value.files) {
    if (!record(file) || !only(file, ['file', 'directory', 'content', 'mode', 'alias']) || !path(file.file) || !path(file.directory)
      || file.content !== null && !text(file.content, HOOK_FILE_LIMIT)
      || file.mode !== undefined && (typeof file.mode !== 'number' || !Number.isInteger(file.mode) || file.mode < 0 || file.mode > 0o777)
      || file.alias !== undefined && typeof file.alias !== 'boolean') return false
    bytes += file.content === null ? 0 : Buffer.byteLength(file.content as string)
  }
  return bytes <= HOOK_TOTAL_LIMIT && Buffer.byteLength(JSON.stringify(value)) <= HOOK_REPLY_LIMIT - 4096
}

/** A settings value can only set the engine's declared status line, never permissions or other CLI settings. */
export function launchSettingsCandidate(value: unknown, input: LaunchSettingsInput, reply?: unknown): LaunchSettingsCandidate | null {
  if (!record(value) || !only(value, ['version', 'values', 'files']) || value.version !== 1
    || !record(value.values) || !only(value.values, ['instructions', 'settings'])
    || !valueSlot(value.values.instructions) || !valueSlot(value.values.settings)
    || !Array.isArray(value.files) || value.files.length > 1 || value.files.length > input.files.length) return null
  const settings = value.values.settings
  if (settings !== null) {
    const declared = launchContract(input.engine)?.statusLine
    if (!declared || value.files.length !== 1) return null
    try {
      const parsed: unknown = JSON.parse(settings)
      if (!record(parsed) || Object.keys(parsed).length !== 1 || !Object.hasOwn(parsed, declared.key)) return null
      const line = parsed[declared.key]
      if (!record(line) || line.type !== declared.type || !text(line.command, LAUNCH_VALUE_LIMIT) || !line.command.trim()) return null
    } catch { return null }
  }
  for (const file of value.files) {
    if (!record(file) || !only(file, ['index', 'content']) || file.index !== 0 || !text(file.content, HOOK_FILE_LIMIT)) return null
  }
  if (Buffer.byteLength(JSON.stringify(reply ?? value)) > HOOK_REPLY_LIMIT - 4096) return null
  return { version: 1, values: { instructions: value.values.instructions, settings },
    files: value.files.map(file => ({ index: 0, content: file.content as string })) }
}
