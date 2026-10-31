import type { PrismaClient } from '@prisma/client'
import { logger } from '../utils/logger.js'
import { AVATAR_PURPOSE, attachmentsFromEnv, CdnAvatarStore, errorCode, trimPrefix, type Attachments, type AttachmentStore } from './attachments.js'
import { readBy } from './parts/indexed.js'
import { ms } from './parts/light.js'

// The purge of deleted Swarms whose grace is over (deletion.ts). Each goes in three steps, so a pass that stops anywhere is
// finished by the next one: its stored files with their attachment records, then every other record of it, and its row last.
// It touches only records that carry its id and files inside its own folders.

/** Past its purge time by this much before it goes: an owner's restore can no longer be in flight on a slower clock. */
export const PURGE_MARGIN_MS = 60 * 60 * 1000
export const PURGE_SWEEP = { everyMs: 60 * 60 * 1000, swarms: 20, files: 200 } as const

/** The records of one Swarm, each by its Swarm id (every one has an index led by it, schema.prisma). Attachments are
 *  removed apart, with their files. */
export const PURGED_BY_TAB_ID = ['superTabMessage', 'superTabMention', 'superTabReaction', 'superTabActivity', 'superTabChatSetting', 'superTabReadMark',
  'superTabThreadMark', 'superTabThread', 'superTabDecision', 'superTabOperation', 'superTabNativeContext', 'superTabDelivery', 'superTabReceipt',
  'superTabRun', 'superTabAttempt', 'superTabRouteDecision', 'superTabModelEvidence', 'superTabModelRecent', 'superTabStopReceipt',
  'superTabRoleText', 'superTabInstructions', 'superTabInstructionsRevision', 'superTabPmNote', 'superTabConfiguration', 'superTabTerminalRequest',
  'gitHubRepositoryApproval', 'gitHubApprovalRefusal', 'swarmHead', 'swarmMember', 'swarmGroup', 'swarmAgent', 'swarmMachine', 'swarmStart',
  'swarmProgress'] as const

/** Removes one stored object; one already gone counts as removed. */
export interface FileRemover { delete(objectKey: string): Promise<void> }
/** Where a Swarm's files are and how each goes: chat files in `prefix/<tabId>/`, avatars in `avatarPrefix/<tabId>/`. */
export interface PurgeFiles { chat: FileRemover | null; prefix: string; avatars: FileRemover | null; avatarPrefix: string }

const removerOf = (store: AttachmentStore | null | undefined): FileRemover | null => {
  if (!store) return null
  if (store instanceof CdnAvatarStore) return removerOf(store.store)
  return 'delete' in store && typeof store.delete === 'function' ? store as unknown as FileRemover : null
}
export function purgeFiles(attachments: Attachments | null): PurgeFiles | null {
  if (!attachments) return null
  return { chat: removerOf(attachments.store), prefix: trimPrefix(attachments.prefix), avatars: removerOf(attachments.avatars ?? null),
    avatarPrefix: trimPrefix(attachments.avatarPrefix ?? attachments.prefix) }
}

const folder = (prefix: string, tabId: string) => [prefix, tabId].filter(Boolean).join('/') + '/'

/** Its stored files, then their records, a page at a time. False when a file could not be removed: the pass stops there and
 *  the next one carries on, its record kept so it is found again. */
async function purgeAttachments(db: PrismaClient, tabId: string, files: PurgeFiles | null, page: number): Promise<boolean> {
  for (;;) {
    const rows = await db.superTabAttachment.findMany({ where: { tabId }, select: { id: true, objectKey: true, purpose: true }, take: page })
    for (const row of rows) {
      const avatar = row.purpose === AVATAR_PURPOSE
      const remover = files ? avatar ? files.avatars : files.chat : null
      const own = files ? row.objectKey.startsWith(folder(avatar ? files.avatarPrefix : files.prefix, tabId)) : false
      // A key outside this Swarm's folder is never another's to remove from here: its record goes, the object stays.
      if (remover && own) {
        try { await remover.delete(row.objectKey) } catch (error) {
          logger.warn('[swarm-purge] a stored file could not be removed yet', { tabId, id: row.id, code: errorCode(error) })
          return false
        }
      } else if (files && !own) logger.warn('[swarm-purge] an attachment outside its Swarm\'s folder was left in storage', { tabId, id: row.id })
      await db.superTabAttachment.delete({ where: { id: row.id } })
    }
    if (rows.length < page) return true
  }
}

/** Purges one deleted Swarm past its grace; false when it is not due or not deleted, or files remain for the next pass. */
export async function purgeSwarm(db: PrismaClient, tabId: string, files: PurgeFiles | null, now: number, page: number = PURGE_SWEEP.files): Promise<boolean> {
  const row = await db.superTab.findUnique({ where: { id: tabId }, select: { deletedAt: true, purgeAt: true } })
  // Restored, or not yet due: nothing of it goes.
  if (!row?.deletedAt || !row.purgeAt || row.purgeAt.getTime() + PURGE_MARGIN_MS > now) return false
  if (!await purgeAttachments(db, tabId, files, page)) return false
  for (const model of PURGED_BY_TAB_ID) {
    await (db[model] as unknown as { deleteMany(args: { where: { tabId: string } }): Promise<unknown> }).deleteMany({ where: { tabId } })
  }
  // Harness shares made for this Swarm (its members' read-only views of agents' terminals).
  await db.harnessShare.deleteMany({ where: { superTabId: tabId } })
  // Last, and only while it is still the deletion this pass read: a later pass finds nothing left of it.
  await db.superTab.deleteMany({ where: { id: tabId, purgeAt: row.purgeAt } })
  return true
}

/** One pass: deleted Swarms past their grace, by the purge index, oldest first. */
export async function purgeDeletedSwarms(db: PrismaClient, files: PurgeFiles | null, now: number, limit: number = PURGE_SWEEP.swarms) {
  const due = await readBy(db, 'SuperTab', 'purge', [{ $match: { purgeAt: { $lte: { $date: new Date(now - PURGE_MARGIN_MS).toISOString() } } } },
    { $sort: { purgeAt: 1 } }, { $limit: limit }, { $project: { purgeAt: 1 } }])
  let purged = 0, waiting = 0
  for (const row of due) {
    try {
      if (await purgeSwarm(db, row._id as string, files, now)) purged++
      else waiting++
    } catch (error) {
      waiting++
      logger.warn('[swarm-purge] a deleted Swarm could not be purged yet', { tabId: row._id, purgeAt: ms(row.purgeAt), code: errorCode(error) })
    }
  }
  return { purged, waiting }
}

/** Runs the purge in the worker every hour. Without a bucket, a Swarm has no stored files, and its records still go. */
export function startSwarmPurge(db: PrismaClient, env: Parameters<typeof attachmentsFromEnv>[0], now: () => number = Date.now): () => void {
  let files: PurgeFiles | null
  try { files = purgeFiles(attachmentsFromEnv(env)) } catch (error) {
    // Invalid settings could leave files behind for good: purge nothing until they are fixed.
    logger.warn('[swarm-purge] off: the attachment settings are invalid', { error: error instanceof Error ? error.message : String(error) })
    return () => {}
  }
  let running = false
  const pass = async () => {
    if (running) return
    running = true
    try {
      const result = await purgeDeletedSwarms(db, files, now())
      if (result.purged || result.waiting) logger.info('[swarm-purge] pass', result)
    } catch (error) {
      logger.warn('[swarm-purge] pass failed', { code: errorCode(error) })
    } finally { running = false }
  }
  void pass()
  const timer = setInterval(() => void pass(), PURGE_SWEEP.everyMs)
  timer.unref()
  return () => clearInterval(timer)
}
