/**
 * The collections only the Swarm used, which the release that deleted the Swarm removes (anh Dee, 2026-11-14: "remove all the
 * swarm data too"): its own models, and those of what the Swarm removed before (#1165, #1490, and #3622 to #3922, which an earlier job
 * dropped and a stray write of an older backend could have made again). No model of the schema is listed: the schema push would
 * make it again (the test checks).
 *
 * Each that exists is dropped. Where the database user may not drop, it is emptied in chunks of [CHUNK] (a pause between them)
 * until a count says it is empty: the data is gone either way. Safe to repeat, and from two pods at once: a collection another pod
 * dropped first counts as dropped, and a removal of a row already removed removes nothing.
 */
import type { PrismaClient } from '@prisma/client'
import { removeChunk } from '../chunkSweep.js'
import { notAuthorized } from './indexes.js'
import { logger } from '../../utils/logger.js'

export const SWARM_COLLECTIONS = [
  // A Swarm, its parts and its people's records.
  'SuperTab', 'SwarmHead', 'SwarmMember', 'SwarmGroup', 'SwarmAgent', 'SwarmMachine', 'SwarmStart', 'SwarmShipping',
  'SuperTabSessionScope', 'SuperTabConfiguration', 'SuperTabRun', 'SuperTabStopReceipt', 'SuperTabTerminalRequest',
  // Messages, their threads, deliveries, receipts and marks.
  'SuperTabMessage', 'SuperTabThread', 'SuperTabThreadBackfill', 'SuperTabDelivery', 'SuperTabReceipt', 'SuperTabChatSetting',
  'SuperTabReadMark', 'SuperTabThreadMark', 'SuperTabSweepCursor', 'SuperTabOperation',
  // Files (their objects go by swarmFiles.ts) and the upload limits.
  'SuperTabAttachment', 'SuperTabUploadAllowance',
  // Tasks on GitHub: comments, tokens used, offers, and the repositories its projects were allowed to use.
  'SuperTabGithubComment', 'SuperTabTaskTokens', 'SuperTabTaskOffer', 'GitHubRepositoryApproval', 'GitHubApprovalRefusal',
  // What Swarm v4 removed: Workspaces, scorecards, terminal recordings, decisions, tags, Activity, reminders, reactions, the Buddy's
  // proposals, routing, role texts, project instructions and rules, PM notes and report progress.
  'SwarmWorkspace', 'SwarmWorkspaceMember', 'SwarmWorkspaceInvitation', 'SwarmWorkspaceRemoval', 'SuperTabScorecard',
  'SuperTabNativeContext', 'SuperTabDecision', 'SuperTabMention', 'SuperTabActivity', 'SuperTabReminder', 'SuperTabReaction',
  'SuperTabOpenProposal', 'RoutingPolicy', 'SuperTabAttempt', 'SuperTabRouteDecision', 'SuperTabModelEvidence', 'SuperTabModelRecent',
  'SuperTabRoleText', 'SuperTabInstructions', 'SuperTabInstructionsRevision', 'SuperTabPmNote', 'SuperTabProjectRules', 'SwarmProgress',
  // Older still: a file's parts in the database (removed on the day it shipped, #1490) and Swarm collaboration's tab channels (#1165).
  'SuperTabAttachmentPart', 'tab_channels', 'tab_channel_settings',
] as const

/** Rows removed by one write where the collection cannot be dropped: a few megabytes at most. */
const CHUNK = 500
/** Chunks a collection may take beyond what its rows need, for another pod removing some of the same rows meanwhile. Past it the
 *  collection is named failed: something keeps writing to it. */
const EXTRA_CHUNKS = 5

export interface CollectionDrop {
  collection: string
  /** Rows it held when this pass found it. */
  rows: number
  /** False when the database user may not drop: the collection is left empty. */
  dropped: boolean
}
/** Counts and collection names only: no row's content or id. */
export interface CollectionDropReport {
  /** What this pass dropped or emptied; a collection already gone is not here. */
  collections: CollectionDrop[]
  /** Collections it could not remove, by name: the job says which, and tries them again. */
  failed: string[]
  /** Nothing is left to remove: every collection is gone or empty. False when stopped or when one failed. */
  done: boolean
}
export interface DropCollectionsOptions {
  /** Awaited between two chunks, so emptying a large collection never holds the database for long. */
  pause?: () => Promise<void>
  /** Checked before each collection and chunk: an aborted pass returns what it has done, not done. */
  signal?: AbortSignal
}

type Commands = Pick<PrismaClient, '$runCommandRaw'>
const missing = (error: unknown): boolean => /NamespaceNotFound|ns not found|Code: `26`/.test(String((error as Error)?.message ?? error))

async function existing(db: Commands, names: readonly string[]): Promise<Set<string>> {
  const answer = await db.$runCommandRaw({ listCollections: 1, nameOnly: true, filter: { name: { $in: [...names] } } } as never) as
    { cursor: { firstBatch: Array<{ name: string }> } }
  return new Set(answer.cursor.firstBatch.map(entry => entry.name))
}
const rowsIn = async (db: Commands, collection: string): Promise<number> => Number((await db.$runCommandRaw({ count: collection }) as { n?: unknown }).n ?? 0)

/** Empties [collection] in chunks until it holds no row; false when aborted first. Ends on a count, not on a short chunk: another
 *  pod removing some of the same rows makes a chunk short. */
async function empty(db: Commands, collection: string, rows: number, { pause, signal }: DropCollectionsOptions): Promise<boolean> {
  for (let left = rows, chunks = 0; left > 0; chunks++) {
    if (signal?.aborted) return false
    if (chunks > Math.ceil(rows / CHUNK) + EXTRA_CHUNKS) throw new Error('rows remain after every chunk')
    await removeChunk(db, { collection, filter: {}, sort: { _id: 1 }, hint: '_id_', chunk: CHUNK })
    left = await rowsIn(db, collection)
    if (left > 0) await pause?.()
  }
  return true
}

/** Drops [collection], or empties it where the database user may not drop. Aborted: null, left as it is. */
async function remove(db: Commands, collection: string, options: DropCollectionsOptions): Promise<CollectionDrop | null> {
  if (options.signal?.aborted) return null
  const rows = await rowsIn(db, collection)
  try {
    await db.$runCommandRaw({ drop: collection } as never)
    return { collection, rows, dropped: true }
  } catch (error) {
    if (missing(error)) return { collection, rows, dropped: true }
    if (!notAuthorized(error)) throw error
  }
  logger.warn('[swarm-removal] a collection is emptied, not dropped: the database user may not drop it', { collection })
  return await empty(db, collection, await rowsIn(db, collection), options) ? { collection, rows, dropped: false } : null
}

/** One pass over [SWARM_COLLECTIONS]: each that exists is dropped, or emptied. */
export async function dropSwarmCollections(db: Commands, options: DropCollectionsOptions = {}): Promise<CollectionDropReport> {
  const report: CollectionDropReport = { collections: [], failed: [], done: true }
  for (const collection of await existing(db, SWARM_COLLECTIONS)) {
    try {
      const removed = await remove(db, collection, options)
      if (removed) report.collections.push(removed)
      else report.done = false
    } catch (error) {
      // Another pod may have dropped it under this one: a collection gone now is done, not failed.
      if ((await existing(db, [collection])).has(collection)) {
        report.failed.push(collection)
        report.done = false
        logger.warn('[swarm-removal] a collection could not be removed', { collection, error: error instanceof Error ? error.message : String(error) })
      }
    }
  }
  return report
}
