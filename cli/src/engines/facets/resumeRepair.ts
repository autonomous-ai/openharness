/** Resume repair's bounded result; interpretation lives in the engine worker. */
import type { ResumePreparationKind } from '../../lib/productHealthContract.js'

export interface ResumeSource { engine: string; sessionId: string; transcriptPath?: string | null; codexHome?: string | null }
export interface RepairLimits { deadlineMs: number; maxBytes: number; maxRecordBytes: number }
export const REPAIR_LIMITS: RepairLimits = { deadlineMs: 60_000, maxBytes: 1024 ** 3, maxRecordBytes: 16 * 1024 ** 2 }
export type Unrepaired = 'too_large' | 'timed_out' | 'cancelled' | 'unavailable' | 'busy' | 'cleanup_failed'
export interface HistoryRepair { repairedItems: number; repairedBytes?: number; backupPath?: string; unrepaired?: Unrepaired }
export class ResumePreparationError extends Error {
  constructor(readonly kind: ResumePreparationKind, message: string) { super(message); this.name = 'ResumePreparationError' }
}
