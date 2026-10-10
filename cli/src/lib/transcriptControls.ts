/** Explicit core decisions replay at their original byte boundary, before any later record. */
import { recoveryBoundary, type RecoveryBoundary } from './transcriptBoundary.js'

export interface TranscriptClose {
  readonly offset: number
  readonly reason: 'cancel' | 'abandoned' | 'hook'
  readonly boundary?: RecoveryBoundary
}

export function transcriptCloses(value: unknown): value is readonly TranscriptClose[] {
  return Array.isArray(value) && value.length <= 128 && value.every((item, index) =>
    item !== null && typeof item === 'object' && Number.isSafeInteger(item.offset) && item.offset >= 0
    && ['cancel', 'abandoned', 'hook'].includes(item.reason)
    && (item.boundary === undefined || (item.boundary !== null && typeof item.boundary === 'object'
      && item.boundary.offset === item.offset && Number.isSafeInteger(item.boundary.device)
      && Number.isSafeInteger(item.boundary.inode) && typeof item.boundary.digest === 'string'
      && /^[a-f0-9]{64}$/.test(item.boundary.digest)))
    && (!index || value[index - 1].offset <= item.offset))
}

export function verifyCloses(file: string, closes: readonly TranscriptClose[]): void {
  try { for (const close of closes) if (close.boundary) recoveryBoundary(file, close.boundary) }
  catch { throw new Error('ENGINE_CONTROL_BOUNDARY_CHANGED') }
}

export const closeFileIdentity = (closes: readonly TranscriptClose[] | undefined): RecoveryBoundary | undefined =>
  closes?.find(close => close.boundary)?.boundary

export function replayCloses(closes: readonly TranscriptClose[], close: (reason: TranscriptClose['reason']) => void) {
  let next = 0
  return (offset: number): void => {
    while (next < closes.length && closes[next].offset <= offset) close(closes[next++].reason)
  }
}
