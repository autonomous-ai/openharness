/**
 * Removes the old state each migrated Swarm keeps (`SuperTab.legacyState`, design 6.1: about 1 MB for a busy Swarm) once
 * every Swarm is in parts. Without it, `rollbackLegacy` refuses that Swarm; `rollbackFromParts`, which every Swarm written
 * since its migration needs anyway, rebuilds the old state from the parts. Run by scripts/swarm-parts/drop-legacy-state.ts.
 */
import type { PrismaClient } from '@prisma/client'

export interface DropOptions {
  /** Removes the old states; otherwise only counts them. */
  apply?: boolean
  /** Swarms per write. */
  batch?: number
  /** Awaited after each write, so a large backlog never holds the database for long. */
  pause?: () => Promise<void>
  /** Checked before each write: an aborted run returns what it has done, not done. */
  signal?: AbortSignal
}
/** Counts and sizes only: nothing that names a Swarm or shows its content. */
export interface DropReport {
  ok: boolean; swarms: number; unmigrated: number; kept: number; keptBytes: number; removed: number; batches: number
  /** Removals the database refused. The run stops at the first batch with one, or that removes nothing. */
  writeErrors: number
  /** No Swarm keeps an old state any more: set when the run found none, or removed the last ones. */
  done: boolean
}

export const DEFAULT_BATCH = 100
/** Not in parts: format 1, or a row from before the field, which reads as 1. */
const UNMIGRATED = { format: { $ne: 2 } }
const KEPT = { format: 2, legacyState: { $type: 'object' } }

interface Batch<T> { cursor: { firstBatch: T[] } }
async function count(db: PrismaClient, query: object): Promise<number> {
  return Number((await db.$runCommandRaw({ count: 'SuperTab', query }) as { n: unknown }).n)
}

export async function dropLegacyStates(db: PrismaClient, { apply = false, batch = DEFAULT_BATCH, pause, signal }: DropOptions = {}): Promise<DropReport> {
  const [swarms, unmigrated] = [await count(db, {}), await count(db, UNMIGRATED)]
  const [size] = (await db.$runCommandRaw({ aggregate: 'SuperTab', cursor: {}, pipeline: [{ $match: KEPT },
    { $group: { _id: null, kept: { $sum: 1 }, keptBytes: { $sum: { $bsonSize: '$legacyState' } } } }] }) as unknown as Batch<{ kept: number; keptBytes: number }>).cursor.firstBatch
  const report = { ok: unmigrated === 0, swarms, unmigrated, kept: size?.kept ?? 0, keptBytes: size?.keptBytes ?? 0, removed: 0, batches: 0, writeErrors: 0, done: unmigrated === 0 && !size?.kept }
  if (!report.ok || !apply) return report
  while (!signal?.aborted) {
    const ids = (await db.$runCommandRaw({ find: 'SuperTab', filter: KEPT, projection: { _id: 1 }, limit: batch }) as unknown as Batch<{ _id: string }>)
      .cursor.firstBatch.map(row => row._id)
    if (!ids.length) return { ...report, done: true }
    // Only rows still in parts: one rolled back meanwhile keeps whatever it holds.
    const updated = await db.$runCommandRaw({ update: 'SuperTab', updates: [{ q: { _id: { $in: ids }, ...KEPT }, u: { $unset: { legacyState: '' } }, multi: true }] }) as
      { nModified: unknown; writeErrors?: unknown[] }
    const removed = Number(updated.nModified)
    report.removed += removed
    report.writeErrors += updated.writeErrors?.length ?? 0
    report.batches++
    // The same rows would come back from the next find: a refused or empty batch would repeat for ever.
    if (!removed || updated.writeErrors?.length) return report
    await pause?.()
  }
  return report
}

/** `--apply` removes, and only with `--backup-confirmed`: removing cannot be undone without a backup. `--batch N`. */
export function dropOptions(argv: readonly string[]): Required<Pick<DropOptions, 'apply' | 'batch'>> {
  const options = { apply: false, batch: DEFAULT_BATCH }
  let backupConfirmed = false
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (flag === '--apply') options.apply = true
    else if (flag === '--backup-confirmed') backupConfirmed = true
    else if (flag === '--batch') {
      const value = Number(argv[++i])
      if (!Number.isInteger(value) || value < 1) throw new Error('--batch needs a positive whole number')
      options.batch = value
    } else throw new Error(`Unknown option ${flag}`)
  }
  if (options.apply && !backupConfirmed) throw new Error('Removing the old states cannot be undone. Back up the database first, then add --backup-confirmed.')
  return options
}
