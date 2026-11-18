/** Private storage observations. The core alone owns Close, purge and checkpoint publication. */
import type { BackgroundSession } from '../../lib/backgroundCommands.js'

export const STORAGE_VERSION = 1
export const STORAGE_CAPABILITIES = 'engine_storage_capabilities'
export const STORAGE_BACKGROUND = 'engine_storage_background'
export const STORAGE_EXPORT = 'engine_storage_export'
export const STORAGE_LIFETIME = 'engine_storage_lifetime'
export const STORAGE_IN_FLIGHT = 4
export const STORAGE_BACKGROUND_WAIT_MS = 2_000
export const STORAGE_EXPORT_WAIT_MS = 30_000
export const STORAGE_REPLY_BYTES = 16 * 1024
export const STORAGE_STAGE_BYTES = 1024 * 1024 * 1024
export const STORAGE_CHUNK_BYTES = 128 * 1024
export const STORAGE_ENGINES = ['opencode', 'kilo', 'hermes', 'devin', 'openclaw'] as const
export type StorageEngine = typeof STORAGE_ENGINES[number]
export interface ExportStage { path: string; key: string }
/** Both paths are core-selected: only path is opened; database preserves the legacy JSON metadata spelling. */
export interface ExportSource { path: string; key: string; database: string }
export interface ExportReceipt { bytes: number; sha256: string }
/** Core-only callbacks; these never cross IPC or grant worker publication authority. */
export interface ExportOwnership { readonly deadline: number; writer(pid: number): Promise<void>; settled(): Promise<void> }
export interface StorageLifetime { pid: number; nonce: string }
export function storageLifetime(value: unknown): value is StorageLifetime {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  return Object.keys(v).every(k => k === 'pid' || k === 'nonce') && Number.isSafeInteger(v.pid) && (v.pid as number) > 0
    && typeof v.nonce === 'string' && /^[a-f0-9-]{36}$/.test(v.nonce)
}
export function exportStage(value: unknown): value is ExportStage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  return Object.keys(v).every(k => k === 'path' || k === 'key') && typeof v.path === 'string' && v.path.length > 0
    && v.path.length <= 32_768 && !v.path.includes('\0') && typeof v.key === 'string' && v.key.length > 0 && v.key.length <= 200
}
export function exportSource(value: unknown): value is ExportSource {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  return Object.keys(v).every(k => ['path', 'key', 'database'].includes(k)) && exportStage({ path: v.path, key: v.key })
    && typeof v.database === 'string' && v.database.length > 0 && v.database.length <= 32_768 && !v.database.includes('\0')
}
export function exportReceipt(value: unknown): value is ExportReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  return Object.keys(v).every(k => k === 'bytes' || k === 'sha256') && Number.isSafeInteger(v.bytes)
    && (v.bytes as number) > 0 && (v.bytes as number) <= STORAGE_STAGE_BYTES && typeof v.sha256 === 'string' && /^[a-f0-9]{64}$/.test(v.sha256)
}

export type StorageSession = Pick<BackgroundSession, 'sessionId' | 'hermesHome'> & { openclawStateDir?: string | null; pid?: number }
export function storageSession(value: unknown): value is StorageSession {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  return Object.keys(v).every(key => ['sessionId', 'hermesHome', 'openclawStateDir', 'pid'].includes(key))
    && typeof v.sessionId === 'string' && v.sessionId.length > 0 && v.sessionId.length <= 1_024 && !v.sessionId.includes('\0')
    && (v.hermesHome === undefined || v.hermesHome === null || (typeof v.hermesHome === 'string' && v.hermesHome.length <= 32_768 && !v.hermesHome.includes('\0')))
    && (v.openclawStateDir === undefined || v.openclawStateDir === null || (typeof v.openclawStateDir === 'string' && v.openclawStateDir.length <= 32_768 && !v.openclawStateDir.includes('\0')))
    && (v.pid === undefined || (Number.isSafeInteger(v.pid) && (v.pid as number) >= 0))
}
export function backgroundCount(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 1_024)
}
