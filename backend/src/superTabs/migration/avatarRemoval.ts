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
import { removeChunk } from '../../lib/chunkSweep.js'
import { logger } from '../../utils/logger.js'
import { AVATAR_PURPOSE, attachmentsFromEnv, errorCode, trimPrefix, type AvatarStore } from '../attachments.js'
import { sleeper } from './dropLegacyJob.js'

/** Objects listed, and records read, at a time. */
export const PAGE = 200
/** Pages of objects, and chunks of records, one pass takes at most: 10,000 of each. */
export const PAGES_PER_PASS = 50
export const EVERY_MS = 60 * 60_000
export const PAUSE_MS = 200
/** The longest a bucket call may take: one past it fails the pass, which the next one tries again. */
export const CALL_MS = 30_000

/** Where the avatars are: the store they were written through and the folder their keys start with. */
export interface AvatarFolder { store: AvatarStore; prefix: string }
/** Counts only: no key, Swarm or name. */
export interface AvatarPass { objects: number; failed: number; records: number; done: boolean }
export interface AvatarOptions { pages?: number; pause?: () => Promise<void>; signal?: AbortSignal; callMs?: number }

type Records = Pick<PrismaClient, '$runCommandRaw'>

/** [work], or a failure named BUCKET_TIMEOUT once [ms] pass. */
async function within<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('The bucket did not answer in time'), { code: 'BUCKET_TIMEOUT' })), ms) })
  try { return await Promise.race([work, late]) } finally { clearTimeout(timer) }
}

/** One pass: the stored objects first, then their records. [folder] is null where no bucket is set: there are no objects then. */
export async function removeAvatars(db: Records, folder: AvatarFolder | null, { pages = PAGES_PER_PASS, pause, signal, callMs = CALL_MS }: AvatarOptions = {}): Promise<AvatarPass> {
  const pass: AvatarPass = { objects: 0, failed: 0, records: 0, done: false }
  let objectsLeft = false
  if (folder) {
    const prefix = trimPrefix(folder.prefix) ? `${trimPrefix(folder.prefix)}/` : ''
    for (let page = 0; ; page++) {
      if (signal?.aborted || page >= pages) { objectsLeft = true; break }
      const keys = await within(folder.store.list(prefix, PAGE), callMs)
      if (!keys.length) break
      for (const key of keys) {
        try {
          await within(folder.store.delete(key), callMs)
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

/** Starts the passes in the worker, one now and one every EVERY_MS until one finds nothing left; the returned function stops them,
 *  a pass in flight too, at its next page. Settings it cannot read, or an avatar bucket that is the chat files' bucket (its folder
 *  would then be theirs), fail every pass loudly: the avatars stay until they are fixed. */
export function startAvatarRemoval(db: PrismaClient, env: Parameters<typeof attachmentsFromEnv>[0]): () => void {
  const control = new AbortController()
  const wait = sleeper(control.signal)
  void (async () => {
    while (!control.signal.aborted) {
      try {
        if (env.SUPER_TAB_AVATARS_BUCKET && env.SUPER_TAB_AVATARS_BUCKET === env.SUPER_TAB_ATTACHMENTS_BUCKET) {
          throw Object.assign(new Error('SUPER_TAB_AVATARS_BUCKET is the chat files\' bucket'), { code: 'SHARED_BUCKET' })
        }
        const attachments = attachmentsFromEnv(env)
        const folder = attachments?.avatars ? { store: attachments.avatars, prefix: attachments.avatarPrefix ?? attachments.prefix } : null
        const pass = await removeAvatars(db, folder, { pause: () => wait(PAUSE_MS), signal: control.signal })
        if (pass.failed) logger.error('[avatar-removal] some stored avatars could not be removed; the next pass tries again', { ...pass, retryInMs: EVERY_MS })
        else if (pass.objects || pass.records) logger.info('[avatar-removal] pass', { ...pass })
        if (pass.done) { logger.info('[avatar-removal] done', { ...pass }); return }
      } catch (error) {
        logger.error('[avatar-removal] pass failed: stored avatars stay until it succeeds', { code: errorCode(error) ?? (error instanceof Error ? error.name : 'unknown'),
          retryInMs: EVERY_MS })
      }
      await wait(EVERY_MS)
    }
  })()
  return () => control.abort()
}
