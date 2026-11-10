/**
 * Removes every avatar still stored: uploaded avatars went in Swarm v4 (S18 took their reads; uploads answer AVATARS_RETIRED). Their
 * objects are in the avatars' folder (`avatarPrefix/`): the attachments bucket's `avatars/` in production, or a bucket of their
 * own (SUPER_TAB_AVATARS_BUCKET). Each pass lists the first PAGE objects left there through the avatar store, removes each, and goes
 * on for at most PAGES_PER_PASS pages; then their records (SuperTabAttachment, purpose `avatar`), a chunk at a time by the
 * (purpose, createdAt) index. A pass stopped anywhere leaves what it did not reach to the next one, which lists from the start again:
 * a removed object is never listed twice, so a restart repeats nothing. Counts only in its log.
 *
 * The avatar store, SUPER_TAB_AVATARS_BUCKET and the purge's and unsent-file sweep's avatar branches go in the pull request after
 * the release that carries this, on or after 2026-11-19: one pass needs minutes for the few avatars there are; the week covers a
 * worker that cannot reach the bucket for days (each failed pass says so) and reading the `[avatar-removal] done` line first.
 */
import type { PrismaClient } from '@prisma/client'
import { removeChunk, startChunkSweep } from '../../lib/chunkSweep.js'
import { logger } from '../../utils/logger.js'
import { AVATAR_PURPOSE, attachmentsFromEnv, errorCode, trimPrefix, type AvatarStore } from '../attachments.js'

/** Objects listed, and records read, at a time. */
export const PAGE = 200
/** Pages of objects, and chunks of records, one pass takes at most: 10,000 of each. */
export const PAGES_PER_PASS = 50
export const EVERY_MS = 60 * 60_000

/** Where the avatars are: the store they were written through and the folder their keys start with. */
export interface AvatarFolder { store: AvatarStore; prefix: string }
/** Counts only: no key, Swarm or name. */
export interface AvatarPass { objects: number; failed: number; records: number; done: boolean }
export interface AvatarOptions { pages?: number; pause?: () => Promise<void>; signal?: AbortSignal }

type Records = Pick<PrismaClient, '$runCommandRaw'>

/** One pass: the stored objects first, then their records. [folder] is null where no bucket is set: there are no objects then. */
export async function removeAvatars(db: Records, folder: AvatarFolder | null, { pages = PAGES_PER_PASS, pause, signal }: AvatarOptions = {}): Promise<AvatarPass> {
  const pass: AvatarPass = { objects: 0, failed: 0, records: 0, done: false }
  let objectsLeft = false
  if (folder) {
    const prefix = trimPrefix(folder.prefix) ? `${trimPrefix(folder.prefix)}/` : ''
    for (let page = 0; ; page++) {
      if (signal?.aborted || page >= pages) { objectsLeft = true; break }
      const keys = await folder.store.list(prefix, PAGE)
      if (!keys.length) break
      for (const key of keys) {
        try {
          await folder.store.delete(key)
          pass.objects++
        } catch (error) {
          pass.failed++
          logger.warn('[avatar-removal] a stored avatar could not be removed yet', { code: errorCode(error) })
        }
      }
      // What failed would be listed first again: the next pass tries it.
      if (pass.failed) { objectsLeft = true; break }
      // A short page was the last of them.
      if (keys.length < PAGE) break
      await pause?.()
    }
  }
  // The records once their objects are gone, so a pass that stops between the two finds the objects by their folder again.
  if (objectsLeft) return pass
  for (let chunk = 0; ; chunk++) {
    if (signal?.aborted || chunk >= pages) return pass
    const removed = await removeChunk(db, { collection: 'SuperTabAttachment', filter: { purpose: AVATAR_PURPOSE }, sort: { purpose: 1, createdAt: 1 },
      hint: 'SuperTabAttachment_purpose_createdAt_idx', chunk: PAGE })
    pass.records += removed
    if (removed < PAGE) break
    await pause?.()
  }
  pass.done = true
  return pass
}

/** Starts the passes in the worker, one every EVERY_MS until one finds nothing left; the returned function stops them. Settings it
 *  cannot read fail every pass, loudly: the avatars stay until they are fixed. */
export function startAvatarRemoval(db: PrismaClient, env: Parameters<typeof attachmentsFromEnv>[0]): () => void {
  return startChunkSweep({ label: '[avatar-removal]', everyMs: EVERY_MS, log: logger, pass: async () => {
    const attachments = attachmentsFromEnv(env)
    const folder = attachments?.avatars ? { store: attachments.avatars, prefix: attachments.avatarPrefix ?? attachments.prefix } : null
    const pass = await removeAvatars(db, folder)
    if (pass.objects || pass.failed || pass.records) logger.info('[avatar-removal] removed', { ...pass })
    return { removed: pass.objects + pass.records, done: pass.done }
  } })
}
