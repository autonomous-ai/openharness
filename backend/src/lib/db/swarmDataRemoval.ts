/**
 * Removes everything the Swarm stored, once, after the release that deleted the Swarm from Harness (anh Dee, 2026-11-14: "remove
 * all the swarm data too"). Irreversible: what it removes has no copy but the database's backups. Each pass removes, in order:
 *
 * 1. the Swarm's stored files: every object in its folders (swarmFiles.ts);
 * 2. the shares a daemon made for a Swarm: `harness_shares` rows with a `superTabId`, a chunk at a time;
 * 3. every collection only the Swarm used (dropCollections.ts SWARM_COLLECTIONS): dropped, or emptied.
 *
 * Each part goes on when another fails, and says what is left. The singleton worker runs a pass a minute after it starts, and
 * again an hour after any pass that removed something or failed, so what an older backend still wrote during the rollout goes
 * too; it stops once a pass finds nothing left anywhere. A worker that starts again checks once (a listing per part, no write).
 * Two runners do no harm: each write matches only what is still there. Logs counts and collection names only.
 *
 * Goes, with SUPER_TAB_ATTACHMENTS_* and SUPER_TAB_AVATARS_BUCKET (config/env.ts), HarnessShare.superTabId and the share filters
 * (routes/harnessShares.ts), once its `[swarm-removal] done` line is seen in production, and not before 2026-12-14.
 */
import type { PrismaClient } from '@prisma/client'
import { removeChunk } from '../chunkSweep.js'
import { logger } from '../../utils/logger.js'
import { dropSwarmCollections, type CollectionDrop } from './dropCollections.js'
import { gcsStores, removeSwarmFiles, swarmFolders, type FileSettings, type StoreFor } from './swarmFiles.js'

/** A pass starts this long after the worker, so its own startup and the rollout of the API processes come first. */
export const START_DELAY_MS = 60_000
/** Between two passes, while one removed something or failed. */
export const RETRY_MS = 3_600_000
/** Between two chunks or pages, so the removal never holds the database or the bucket for long. */
export const PAUSE_MS = 200
/** Shares removed by one write. */
const SHARE_CHUNK = 500

/** Counts and collection names only. Each part is null when it failed, and its error is in `failed`. */
export interface RemovalPass {
  files: { objects: number; failed: number; done: boolean } | null
  shares: number | null
  collections: CollectionDrop[]
  /** Collections it could not remove, by name. */
  collectionsFailed: string[]
  /** What failed, by part: an error's code or name, never its text. */
  failed: Record<string, string>
  /** Nothing is left anywhere: every part finished and found nothing. */
  clean: boolean
}

export interface RemovalOptions { pause?: () => Promise<void>; signal?: AbortSignal }

type Db = Pick<PrismaClient, '$runCommandRaw'>
const codeOf = (error: unknown): string =>
  error && typeof error === 'object' && 'code' in error && (typeof error.code === 'string' || typeof error.code === 'number') ? String(error.code)
    : error instanceof Error ? error.name : 'unknown'

/** A share made for a Swarm names it: a 24-character id (the share route took no other). `$gt` matches strings alone, never a
 *  null or a share without the field; a `$type` would read back as one of Prisma's own tagged values. */
const SWARM_SHARE = { superTabId: { $gt: '' } }

/** The shares made for a Swarm, a chunk at a time by `_id`; how many. */
async function removeSwarmShares(db: Db, { pause, signal }: RemovalOptions): Promise<number> {
  let removed = 0
  while (!signal?.aborted) {
    const chunk = await removeChunk(db, { collection: 'harness_shares', filter: SWARM_SHARE, sort: { _id: 1 }, hint: '_id_', chunk: SHARE_CHUNK })
    removed += chunk
    if (chunk < SHARE_CHUNK) break
    await pause?.()
  }
  return removed
}

/** One pass. [storeFor] makes a bucket's store (Cloud Storage's in production). */
export async function removeSwarmData(db: Db, settings: FileSettings, storeFor: StoreFor, options: RemovalOptions = {}): Promise<RemovalPass> {
  const pass: RemovalPass = { files: null, shares: null, collections: [], collectionsFailed: [], failed: {}, clean: false }
  try {
    pass.files = await removeSwarmFiles(swarmFolders(settings, storeFor), options)
  } catch (error) {
    pass.failed.files = codeOf(error)
  }
  try {
    pass.shares = await removeSwarmShares(db, options)
  } catch (error) {
    pass.failed.shares = codeOf(error)
  }
  try {
    const report = await dropSwarmCollections(db, options)
    pass.collections = report.collections
    pass.collectionsFailed = report.failed
  } catch (error) {
    pass.failed.collections = codeOf(error)
  }
  // An empty collection the database user may not drop holds nothing: it is no reason for another pass.
  const removed = !!pass.files?.objects || !!pass.shares || pass.collections.some(c => c.rows > 0 || c.dropped)
  pass.clean = !removed && !Object.keys(pass.failed).length && !pass.collectionsFailed.length && !!pass.files?.done && !options.signal?.aborted
  return pass
}

/** Waits `ms`, or until `signal` aborts; either way its timer and its stop listener are gone. */
export const sleeper = (signal?: AbortSignal) => (ms: number) => new Promise<void>(resolve => {
  const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', finish); resolve() }
  const timer = setTimeout(finish, ms)
  timer.unref()
  signal?.addEventListener('abort', finish, { once: true })
})

/** Passes until one is clean, or `signal` aborts; the last pass. A pass that changed nothing and failed nowhere logs only `done`. */
export async function removeSwarmDataUntilClean(db: Db, settings: FileSettings, storeFor: StoreFor,
  { wait = sleeper(), pause, signal, log = () => {} }: RemovalOptions & {
    wait?: (ms: number) => Promise<void>
    log?: (level: 'info' | 'error', message: string, line: Record<string, unknown>) => void
  } = {}): Promise<RemovalPass | null> {
  let pass: RemovalPass | null = null
  while (!signal?.aborted) {
    pass = await removeSwarmData(db, settings, storeFor, { pause, signal })
    if (signal?.aborted) return pass
    const line = { files: pass.files, shares: pass.shares, collections: pass.collections, collectionsFailed: pass.collectionsFailed, failed: pass.failed }
    if (pass.clean) { log('info', '[swarm-removal] done: nothing of the Swarm is left', {}); return pass }
    if (Object.keys(pass.failed).length || pass.collectionsFailed.length || pass.files?.failed) {
      log('error', '[swarm-removal] some of the Swarm\'s data could not be removed yet; it stays until a pass succeeds', { ...line, retryInMs: RETRY_MS })
    } else log('info', '[swarm-removal] pass', { ...line, nextCheckInMs: RETRY_MS })
    await wait(RETRY_MS)
  }
  return pass
}

/** Starts the removal in the background; the returned function stops it, a pass in flight too, at its next chunk or page. */
export function startSwarmDataRemoval(db: PrismaClient, settings: FileSettings, delayMs = START_DELAY_MS): () => void {
  const control = new AbortController()
  const wait = sleeper(control.signal)
  void (async () => {
    await wait(delayMs)
    let stores: StoreFor
    try {
      stores = gcsStores(settings.SUPER_TAB_ATTACHMENTS_CREDENTIALS)
    } catch (error) {
      // No store can be made: every pass names the files part failed, and the rest still goes.
      const code = codeOf(error)
      stores = () => { throw Object.assign(new Error('the bucket credentials cannot be read'), { code }) }
    }
    await removeSwarmDataUntilClean(db, settings, stores, { wait, signal: control.signal, pause: () => wait(PAUSE_MS),
      log: (level, message, line) => level === 'error' ? logger.error(message, line) : logger.info(message, line) })
  })().catch(error => logger.error('[swarm-removal] stopped: the Swarm\'s data stays until the worker starts again', { error: codeOf(error) }))
  return () => control.abort()
}
