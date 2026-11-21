/** Optional launch snapshots are bounded values, never dispatch commands or publication destinations. */
import { launchContract } from '../launches.js'
import { LAUNCH_LOCATION_VARIABLES } from './nativeLocations.js'
import { HOOK_REPLY_LIMIT } from './nativeHookWire.js'

export const LAUNCH_VALUE_LIMIT = 65_536
/** One optional deadline covers preparation, commit and artifact publication. */
export const LAUNCH_SETTINGS_TIMEOUT_MS = 5000
export interface LaunchSettingsInput {
  purpose: 'launchSettings'
  version: 2
  engine: 'claude' | 'codex'
  environment: Readonly<Record<string, string>>
  cwd: string | null
  runtimeNode: string
  platform: 'darwin' | 'linux' | 'win32'
  gitBash: string | null
  /** The current sign-in's non-secret identity; optional instructions never cross this owner. */
  owner: { machineId: string; accountId?: string; epoch?: string } | null
}
export interface LaunchSettingsCandidate {
  version: 2
  values: { instructions: string | null; settings: string | null }
}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const only = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).every(key => keys.includes(key))
const text = (value: unknown, limit: number): value is string => typeof value === 'string' && !value.includes('\0') && Buffer.byteLength(value) <= limit
const path = (value: unknown): value is string => text(value, 4096) && value.length > 0
const valueSlot = (value: unknown): value is string | null => value === null || text(value, LAUNCH_VALUE_LIMIT)

/** V1 captured-source requests are deliberately unsupported; ordinary hook rules are unchanged. */
export function boundedLaunchSettingsInput(value: unknown): value is LaunchSettingsInput {
  return record(value) && only(value, ['purpose', 'version', 'engine', 'environment', 'cwd', 'runtimeNode', 'platform', 'gitBash', 'owner'])
    && value.purpose === 'launchSettings' && value.version === 2 && (value.engine === 'claude' || value.engine === 'codex')
    && record(value.environment) && only(value.environment, LAUNCH_LOCATION_VARIABLES)
    && Object.values(value.environment).every(entry => text(entry, LAUNCH_VALUE_LIMIT))
    && Buffer.byteLength(JSON.stringify(value.environment)) <= LAUNCH_VALUE_LIMIT
    && (value.cwd === null || path(value.cwd)) && path(value.runtimeNode)
    && ['darwin', 'linux', 'win32'].includes(String(value.platform)) && (value.gitBash === null || path(value.gitBash))
    && (value.owner === null || record(value.owner) && only(value.owner, ['machineId', 'accountId', 'epoch']) && path(value.owner.machineId)
      && (value.owner.accountId === undefined || path(value.owner.accountId)) && (value.owner.epoch === undefined || path(value.owner.epoch)))
}

/** The only generated setting is the declared status line, never permissions or other engine settings. */
export function launchSettingsCandidate(value: unknown, input: Pick<LaunchSettingsInput, 'engine'>, reply?: unknown): LaunchSettingsCandidate | null {
  if (!record(value) || !only(value, ['version', 'values']) || value.version !== 2
    || !record(value.values) || !only(value.values, ['instructions', 'settings'])
    || !valueSlot(value.values.instructions) || !valueSlot(value.values.settings)) return null
  const settings = value.values.settings
  if (settings !== null) {
    const declared = launchContract(input.engine)?.statusLine
    if (!declared) return null
    try {
      const parsed: unknown = JSON.parse(settings)
      if (!record(parsed) || Object.keys(parsed).length !== 1 || !Object.hasOwn(parsed, declared.key)) return null
      const line = parsed[declared.key]
      if (!record(line) || line.type !== declared.type || !text(line.command, LAUNCH_VALUE_LIMIT) || !line.command.trim()) return null
    } catch { return null }
  }
  if (Buffer.byteLength(JSON.stringify(reply ?? value)) > HOOK_REPLY_LIMIT - 4096) return null
  return { version: 2, values: { instructions: value.values.instructions, settings } }
}
