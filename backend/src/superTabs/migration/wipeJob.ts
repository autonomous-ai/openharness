/**
 * Once, after the release that starts Swarm v4 from a clean slate. Every Swarm before it was an internal run of v1-v3, and anh
 * Dee had them all go (2026-11-10: "WIPE OUT everything v1/v2/v3 they are all internal runs. don't waste time preserve or save
 * any of them", then "EVERYTHING", lampOS's Swarm included). Every Swarm created before WIPE_CUTOFF goes with all it keeps; one
 * created after it is never touched, so the first v4 Swarms are safe.
 *
 * Each is deleted as its owner deleting it is (store.ts wipeSwarm, deletion.ts), Personal Swarms too: it leaves every list at once,
 * every member's apps are told, and its hosts close every agent's session and clean up its folders. None can be restored. Then its
 * stored files, every record that carries its id and its row go (purge.ts purgeRecords) as soon as no host has anything left to
 * read of it, or once the 7 days a host has for that are over, as for any deleted Swarm. What is not a Swarm's stays: accounts and
 * sign-ins, machines and devices, terminals, Agent Messages, Models.
 *
 * Runs in the singleton worker: a pass every PASS_MS walks every Swarm a page at a time in id order, and logs counts only. A Swarm
 * that fails is tried again on the next pass, further apart while passes keep failing. It stops once a pass finds nothing left from
 * before the cut-off; a worker that starts again walks once more. Two runners do no harm: a deletion runs in its Swarm's
 * transaction and answers 'gone' when the other came first, and a purge removes by id, its row only while it is still that
 * deletion. Goes with the restore refusal in store.ts on or after 2026-12-10.
 */
import type { PrismaClient } from '@prisma/client'
import { logger } from '../../utils/logger.js'
import { attachmentsFromEnv } from '../attachments.js'
import { SuperTabError } from '../model.js'
import { readBy } from '../parts/indexed.js'
import { ms } from '../parts/light.js'
import { purgeFiles, purgeRecords, type PurgeFiles } from '../purge.js'
import type { SuperTabStore } from '../store.js'
import { sleeper, START_DELAY_MS } from './dropLegacyJob.js'
import { migrateSwarm } from './migrate.js'

/** The moment this job was written: a Swarm created before it is wiped, one created after it is kept. */
export const WIPE_CUTOFF = Date.parse('2026-11-10T14:07:00.000Z')
export const PAGE = 100
export const PAUSE_MS = 200
/** Between passes while hosts still read what their Swarms' deletions asked: they do within seconds of being online. */
export const PASS_MS = 5 * 60_000
/** The longest wait between passes that keep failing. */
export const MAX_RETRY_MS = 60 * 60_000

/** Whether a Swarm created at [createdAt] is one the wipe removes. A row from before the field was set is. */
export const beforeCutoff = (createdAt: number | null | undefined): boolean => createdAt == null || !(createdAt >= WIPE_CUTOFF)

/** Counts only, never an id or a name. `left`: Swarms from before the cut-off still there after this pass, of which `hosts` wait
 *  for a host to close or clean up and `files` for a stored file to be removed. */
export interface WipePass { deleted: number; purged: number; left: number; hosts: number; files: number; failed: number; codes: Record<string, number> }

const createdOf = (row: Record<string, unknown>) => row.createdAt == null ? null : ms(row.createdAt)

/** One pass over every Swarm. [files] is null without a bucket (a Swarm has no stored files then) and undefined when the attachment
 *  settings are invalid: Swarms are deleted, and purged once the settings are fixed. */
export async function wipeOnce(db: PrismaClient, store: Pick<SuperTabStore, 'wipeSwarm'>, files: PurgeFiles | null | undefined,
  { now = Date.now, pause = async () => {}, signal }: { now?: () => number; pause?: () => Promise<void>; signal?: AbortSignal } = {}): Promise<WipePass> {
  const pass: WipePass = { deleted: 0, purged: 0, left: 0, hosts: 0, files: 0, failed: 0, codes: {} }
  let after: string | undefined
  while (!signal?.aborted) {
    // Every Swarm in id order, by the id index: as many examined as returned.
    const rows = await readBy(db, 'SuperTab', 'id', [...after ? [{ $match: { _id: { $gt: after } } }] : [], { $sort: { _id: 1 } }, { $limit: PAGE },
      { $project: { createdAt: 1, deletedAt: 1, purgeAt: 1, machineIds: 1, format: 1 } }])
    for (const row of rows) {
      if (signal?.aborted) break
      const tabId = row._id as string
      if (!beforeCutoff(createdOf(row))) continue
      try {
        if (!row.deletedAt) {
          // One still in a single row is split first, as its first read would split it (read/service.ts).
          if (row.format !== 2 && !(await migrateSwarm(db, tabId)).ok) throw new SuperTabError('SWARM_MIGRATING', 'This Swarm is being updated.', 503)
          // Its hosts read the closes and cleanups now; a later pass purges it.
          if (await store.wipeSwarm(tabId) === 'deleted') pass.deleted++
          pass.left++
          await pause()
          continue
        }
        const purgeAt = ms(row.purgeAt)
        // A host still has a session to close or folders to clean up here, and its 7 days are not over (deletion.ts).
        if ((row.machineIds as unknown[] | undefined)?.length && purgeAt > now()) { pass.left++; pass.hosts++; continue }
        if (files === undefined) { pass.left++; pass.files++; continue }
        if (await purgeRecords(db, tabId, new Date(purgeAt), files) === 'purged') pass.purged++
        else { pass.left++; pass.files++ }
        await pause()
      } catch (error) {
        pass.left++
        pass.failed++
        const code = error instanceof SuperTabError ? error.code : error instanceof Error ? error.name : 'unknown'
        pass.codes[code] = (pass.codes[code] ?? 0) + 1
      }
    }
    if (rows.length < PAGE) break
    after = rows.at(-1)!._id as string
  }
  // Stopped part-way, it has not seen every Swarm: not done.
  if (signal?.aborted) pass.left++
  return pass
}

/** Starts the passes in the background until one finds nothing left; the returned function stops them. */
export function startSwarmWipe(db: PrismaClient, store: Pick<SuperTabStore, 'wipeSwarm'>, env: Parameters<typeof attachmentsFromEnv>[0],
  delayMs = START_DELAY_MS): () => void {
  const control = new AbortController()
  const wait = sleeper(control.signal)
  void (async () => {
    await wait(delayMs)
    let failing = 0
    while (!control.signal.aborted) {
      let files: PurgeFiles | null | undefined
      try { files = purgeFiles(attachmentsFromEnv(env)) } catch (error) {
        files = undefined
        logger.error('[swarm-wipe] the attachment settings are invalid: Swarms from before Swarm v4 are deleted but not purged until they are fixed',
          { error: error instanceof Error ? error.name : 'unknown' })
      }
      try {
        const pass = await wipeOnce(db, store, files, { pause: () => wait(PAUSE_MS), signal: control.signal })
        if (control.signal.aborted) return
        failing = pass.failed ? failing + 1 : 0
        if (pass.failed) logger.error('[swarm-wipe] pass: some Swarms from before Swarm v4 are still there; it tries again', { ...pass, retryInMs: retryIn(failing) })
        else if (pass.deleted || pass.purged || !pass.left) logger.info('[swarm-wipe] pass', { ...pass })
        if (!pass.left) return
      } catch (error) {
        failing++
        logger.error('[swarm-wipe] failed: Swarms from before Swarm v4 stay until the next try', { error: error instanceof Error ? error.name : 'unknown', retryInMs: retryIn(failing) })
      }
      await wait(retryIn(failing))
    }
  })()
  return () => control.abort()
}

/** PASS_MS, doubled for each pass in a row that failed, up to MAX_RETRY_MS. */
export const retryIn = (failing: number): number => Math.min(MAX_RETRY_MS, PASS_MS * 2 ** failing)
