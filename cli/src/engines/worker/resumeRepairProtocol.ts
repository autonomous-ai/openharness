/** Private preparations, never worker authority to publish a history. */
import type { BigIntStats } from 'node:fs'
import { dirname, join } from 'node:path'
import { REPAIR_LIMITS, type HistoryRepair, type ResumeSource } from '../facets/resumeRepair.js'
import { record } from './protocol.js'

export const RESUME_REPAIR_VERSION = 1
export const RESUME_REPAIR_CAPABILITIES = 'engine_resume_repair_capabilities'
export const RESUME_REPAIR_LOCATE = 'engine_resume_repair_locate'
export const RESUME_REPAIR_PREPARE = 'engine_resume_repair_prepare'
export const RESUME_REPAIR_RELEASE = 'engine_resume_repair_release'
export const RESUME_REPAIR_WAIT_MS = 65_000
export const RESUME_REPAIR_REPLY_BYTES = 8192
export interface RepairFile { key: string; version: string; size: number }
export const repairFile = (info: BigIntStats): RepairFile => ({ key: `${info.dev}:${info.ino}`,
  version: `${info.size}:${info.mtimeNs}:${info.ctimeNs}:${info.mode}:${info.uid}:${info.nlink}`, size: Number(info.size) })
export const sameRepairFile = (a: RepairFile, b: RepairFile): boolean => a.key === b.key && a.version === b.version && a.size === b.size
export const repairDirectory = (file: string, token: string): string => join(dirname(file), `.harness-resume-${token}`)
export interface RepairPreparation { source: ResumeSource; token: string; file: string; original: RepairFile; expires: number }
export interface RepairPrepared { repairedItems: number; repairedBytes: number; directoryKey: string; backup: RepairFile; history: RepairFile }
export type RepairAnswer = RepairPrepared | HistoryRepair | { refused: 'invalid_json' | 'foreign_session' | 'not_owned_file' | 'changed_during' | 'other' }
const fields = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).every(key => keys.includes(key))
export const repairToken = (v: unknown): v is string => typeof v === 'string' && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/.test(v)
export const repairPath = (v: unknown): v is string => typeof v === 'string' && !!v && Buffer.byteLength(v) <= 4096 && !v.includes('\0')
const stamp = (v: unknown): v is string => typeof v === 'string' && !!v && v.length <= 256
const count = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= REPAIR_LIMITS.maxBytes
export const repairFileValid = (v: unknown): v is RepairFile => record(v) && Object.keys(v).length === 3 && stamp(v.key) && stamp(v.version) && count(v.size)
export function repairSource(v: unknown): v is ResumeSource {
  return record(v) && fields(v, ['engine', 'sessionId', 'transcriptPath', 'codexHome']) && v.engine === 'codex'
    && typeof v.sessionId === 'string' && !!v.sessionId && v.sessionId.length <= 200 && !v.sessionId.includes('\0')
    && (v.transcriptPath == null || repairPath(v.transcriptPath)) && (v.codexHome == null || repairPath(v.codexHome))
}
export function repairPreparation(v: unknown): v is RepairPreparation {
  return record(v) && Object.keys(v).length === 5 && repairSource(v.source) && repairToken(v.token)
    && repairPath(v.file) && repairFileValid(v.original) && typeof v.expires === 'number' && Number.isSafeInteger(v.expires)
}
export function repairAnswer(v: unknown): v is RepairAnswer {
  if (!record(v)) return false
  if (Object.keys(v).length === 1 && ['invalid_json', 'foreign_session', 'not_owned_file', 'changed_during', 'other'].includes(v.refused as string)) return true
  if (v.repairedItems === 0) return fields(v, ['repairedItems', 'unrepaired']) && (v.unrepaired === undefined
    || ['too_large', 'timed_out', 'cancelled', 'unavailable', 'busy', 'cleanup_failed'].includes(v.unrepaired as string))
  return Object.keys(v).length === 5 && count(v.repairedItems) && (v.repairedItems as number) > 0
    && count(v.repairedBytes) && stamp(v.directoryKey) && repairFileValid(v.backup) && repairFileValid(v.history)
    && v.history.size === v.repairedBytes
}
