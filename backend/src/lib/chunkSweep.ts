import type { PrismaClient } from '@prisma/client'
import type { logger } from '../utils/logger.js'

/** One chunk of documents to remove: those matching [filter], first in [sort] order by the index [hint] names. */
export interface Chunk {
  collection: string
  filter: Record<string, unknown>
  sort: Record<string, 1 | -1>
  hint: string
  chunk: number
}

/** One chunk: up to [Chunk.chunk] ids in [Chunk.sort] order by [Chunk.hint] (a find's first batch holds only 101 unless asked
 *  for more), then exactly those, by _id, their [Chunk.filter] checked again: one that moved out of it since the find stays.
 *  On both _id and a range Mongo planned the range's index and examined every match (#2923: ~4M receipts, ~17 s a delete). */
export async function removeChunk(db: Pick<PrismaClient, '$runCommandRaw'>, { collection, filter, sort, hint, chunk }: Chunk): Promise<number> {
  const found = await db.$runCommandRaw({ find: collection, filter, projection: { _id: 1 }, sort, hint, limit: chunk, batchSize: chunk,
    singleBatch: true } as never) as { cursor: { firstBatch: Array<{ _id: string }> } }
  const ids = found.cursor.firstBatch.map(document => document._id)
  if (!ids.length) return 0
  const answer = await db.$runCommandRaw({ delete: collection, deletes: [{ q: { _id: { $in: ids }, ...filter }, limit: 0, hint: { _id: 1 } }] } as never) as
    { n?: number; writeErrors?: unknown[] }
  if (answer.writeErrors?.length) throw new Error(`The database refused some removals from ${collection}`)
  return answer.n ?? 0
}

export interface ChunkSweep {
  /** Starts every line it logs, such as `[usage-receipts]`. */
  label: string
  everyMs: number
  /** One pass; `done` once nothing is left that this sweep would ever remove. */
  pass: () => Promise<{ removed: number; done: boolean }>
  /** Logged after the label once a pass is done. */
  doneMessage?: string
  log: Pick<typeof logger, 'info' | 'warn'>
  /** True when the caller dealt with a pass's error itself, which is then not logged as a failed pass. */
  handle?: (error: unknown) => boolean
}

/** Runs [ChunkSweep.pass] now and every [ChunkSweep.everyMs] in the singleton worker until a pass is done; a pass still running
 *  when the next is due skips it, and a failed pass is logged and the next one carries on. Answers its stop. */
export function startChunkSweep({ label, everyMs, pass, doneMessage = 'done', log, handle }: ChunkSweep): () => void {
  let running = false, total = 0
  const run = async () => {
    if (running) return
    running = true
    try {
      const { removed, done } = await pass()
      total += removed
      if (removed) log.info(`${label} pass`, { removed, removedSinceStart: total })
      if (done) {
        stop()
        log.info(`${label} ${doneMessage}`, { removedSinceStart: total })
      }
    } catch (error) {
      if (handle?.(error)) return
      log.warn(`${label} pass failed; retrying next pass`, { error: error instanceof Error ? error.message : String(error) })
    } finally {
      running = false
    }
  }
  const timer = setInterval(() => void run(), everyMs)
  timer.unref()
  const stop = () => clearInterval(timer)
  void run()
  return stop
}
