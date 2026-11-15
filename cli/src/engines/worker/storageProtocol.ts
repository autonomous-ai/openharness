/** Private storage observations. The core alone owns Close, purge and checkpoint publication. */
import type { BackgroundSession } from '../../lib/backgroundCommands.js'

export const STORAGE_VERSION = 1
export const STORAGE_CAPABILITIES = 'engine_storage_capabilities'
export const STORAGE_BACKGROUND = 'engine_storage_background'
export const STORAGE_IN_FLIGHT = 4
export const STORAGE_BACKGROUND_WAIT_MS = 2_000
export const STORAGE_REPLY_BYTES = 16 * 1024

export type StorageSession = Pick<BackgroundSession, 'sessionId' | 'hermesHome'>
export function storageSession(value: unknown): value is StorageSession {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  return Object.keys(v).every(key => key === 'sessionId' || key === 'hermesHome')
    && typeof v.sessionId === 'string' && v.sessionId.length > 0 && v.sessionId.length <= 1_024 && !v.sessionId.includes('\0')
    && (v.hermesHome === undefined || v.hermesHome === null || (typeof v.hermesHome === 'string' && v.hermesHome.length <= 32_768 && !v.hermesHome.includes('\0')))
}
export function backgroundCount(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 1_024)
}
