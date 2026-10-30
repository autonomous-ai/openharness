import type { Prisma, PrismaClient } from '@prisma/client'
import { PULL_READ_PERMISSIONS, type GitHubApp } from '../github/app.js'
import { githubRepository, type GitHubRepository } from '../github/repository.js'
import { activeWork, type Conversation } from './model.js'
import type { HeadData } from './parts/index.js'
import type { SuperTabStore } from './store.js'
import { ARCHIVE_QUIET_MS } from './tidy.js'
import { logger } from '../utils/logger.js'

// A finished group archives by itself (roadmap, December: nobody tidies a Swarm by hand): its task done or cancelled, quiet
// for 30 minutes, no person's decision waiting there, and every pull request it links merged or closed. Only GitHub says
// that, over the network, so this runs in the singleton worker and never inside a Swarm's write; the write itself checks
// everything the Swarm knows again (store.ts archiveFinished). A review nobody is reviewing closes the same way once every
// pull request of the work it reviews is merged or closed (tidy.ts reviewClosable).

export type PullRequestState = 'open' | 'merged' | 'closed' | null
/** What a sweep asks GitHub: a pull request's state (null: it cannot say), and `done` once the sweep is over. */
export interface PullRequests { state(url: string): Promise<PullRequestState>; done(): Promise<void> }

/** Without the Harness GitHub App nothing can say a pull request is merged: a group that links one stays open. */
export const unknownPullRequests: PullRequests = { state: async () => null, done: async () => {} }

const PULL = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/([1-9][0-9]*)$/

/** Reads with the Harness GitHub App: one read-only token per repository for the whole sweep, revoked when it is done. A
 *  repository the app is not installed on, or any GitHub failure, reads as null. */
export function appPullRequests(app: GitHubApp): PullRequests {
  const tokens = new Map<string, Promise<string | null>>()
  const token = (repository: GitHubRepository) => {
    const key = repository.fullName.toLowerCase()
    if (!tokens.has(key)) tokens.set(key, (async () => {
      const installation = await app.installation(repository)
      return installation === null ? null : (await app.createToken(installation, repository, PULL_READ_PERMISSIONS)).token
    })().catch(() => null))
    return tokens.get(key)!
  }
  return {
    async state(url) {
      const match = PULL.exec(url), repository = match ? githubRepository(`https://github.com/${match[1]}`) : null
      const granted = repository ? await token(repository) : null
      return granted ? app.pullRequestState(repository!, Number(match![2]), granted) : null
    },
    async done() {
      for (const granted of tokens.values()) {
        const value = await granted
        if (value) await app.revoke(value).catch(() => {})
      }
      tokens.clear()
    },
  }
}

const BATCH = 500

/** Marks every part written before the finished mark whose task is done or cancelled, and every open review written before
 *  reviews took the mark while nobody reviews them, so the pass finds it: run once by the worker at startup, as its other
 *  index work is. Every later write of a part sets the mark itself (parts/write.ts). */
export async function markFinishedGroups(db: PrismaClient): Promise<number> {
  const answer = await db.$runCommandRaw({ update: 'SwarmGroup', updates: [
    { q: { workFinished: { $exists: false }, deleted: false, 'data.assignment.status': { $in: ['done', 'cancelled'] } }, u: { $set: { workFinished: true } }, multi: true },
    // Open groups only (the mark's index leads with it and archived): the reviews waiting for a Reviewer on 2026-10-30.
    // Measured on prod that day: about 290 index keys and documents examined, 1 ms; it marked 35. Remove it in the
    // release after #2322's, once every part has been written or marked by it.
    { q: { workFinished: { $in: [false, null] }, archived: false, deleted: false, 'data.reviewOf': { $type: 'string' },
      $or: [{ 'data.assignment': null }, { 'data.assignment.status': { $in: ['done', 'stopped', 'cancelled', 'lost'] } }] }, u: { $set: { workFinished: true } }, multi: true },
  ] })
  return Number((answer as { nModified?: number }).nModified ?? 0)
}

/** One pass: every unarchived group quiet for ARCHIVE_QUIET_MS whose task is done or cancelled (its finished mark), in a Swarm that keeps
 *  tidying on, is archived once GitHub says each of its pull requests is merged or closed. Read oldest first by a cursor,
 *  so groups that stay open never hold later ones back. */
export async function archiveFinishedGroups(db: PrismaClient, store: Pick<SuperTabStore, 'archiveFinished'>, prs: PullRequests, now: number): Promise<number> {
  const tidy = new Map<string, boolean>()
  const tidyOn = async (tabId: string) => {
    if (!tidy.has(tabId)) tidy.set(tabId, ((await db.swarmHead.findUnique({ where: { id: `${tabId}:head` } }))?.data as unknown as HeadData | undefined)?.tidy !== false)
    return tidy.get(tabId)!
  }
  // One read per pull request a pass, however many groups link it.
  const states = new Map<string, Promise<PullRequestState>>()
  const stateOf = (url: string) => { if (!states.has(url)) states.set(url, prs.state(url)); return states.get(url)! }
  // One group's failed write (a busy group's conflicts outlasting its retries, a GitHub error) skips that group for this
  // pass, with a warning, instead of ending the pass for every group after it (review of #2322).
  const archive = async (row: { tabId: string; key: string }, checked: Record<string, 'merged' | 'closed'>, reviewOf?: string) => {
    try {
      return await store.archiveFinished(row.tabId, row.key, checked, reviewOf)
    } catch (error) {
      logger.warn('[swarm-archive] group skipped', { tabId: row.tabId, group: row.key, error: error instanceof Error ? error.message : String(error) })
      return false
    }
  }
  let archived = 0, after: { at: Date; id: string } | null = null
  try {
    for (;;) {
      const cursor: Prisma.SwarmGroupWhereInput = after ? { OR: [{ lastActivityAt: { gt: after.at } }, { lastActivityAt: after.at, id: { gt: after.id } }] } : {}
      const rows = await db.swarmGroup.findMany({ where: { workFinished: true, archived: false, deleted: false, kind: null, lastActivityAt: { lte: new Date(now - ARCHIVE_QUIET_MS) }, ...cursor },
        orderBy: [{ lastActivityAt: 'asc' }, { id: 'asc' }], take: BATCH, select: { id: true, tabId: true, key: true, lastActivityAt: true, data: true } })
      for (const row of rows) {
        const group = row.data as unknown as Conversation
        const finished = ['done', 'cancelled'].includes(group.assignment?.status ?? ''), review = !!group.reviewOf && !activeWork(group)
        if (group.audience || !(finished || review) || !await tidyOn(row.tabId)) continue
        const checked: Record<string, 'merged' | 'closed'> = {}
        // Stops at the first pull request still open, or that GitHub cannot read.
        const settled = async (urls: string[]) => {
          for (const url of urls) {
            const state = await stateOf(url)
            if (state !== 'merged' && state !== 'closed') return false
            checked[url] = state
          }
          return true
        }
        const own = group.pullRequestUrls ?? []
        if (finished && await settled(own) && await archive(row, checked)) { archived++; continue }
        if (!review) continue
        const reviewed = (await db.swarmGroup.findUnique({ where: { tabId_key: { tabId: row.tabId, key: group.reviewOf! } }, select: { data: true } }))?.data as unknown as Conversation | undefined
        const urls = [...new Set([...own, ...reviewed?.pullRequestUrls ?? []])]
        if (urls.length && await settled(urls) && await archive(row, checked, group.reviewOf)) archived++
      }
      if (rows.length < BATCH) return archived
      after = { at: rows.at(-1)!.lastActivityAt, id: rows.at(-1)!.id }
    }
  } finally { await prs.done() }
}

/** Runs the archive pass every 10 minutes in the singleton worker. */
export function startSwarmArchive(db: PrismaClient, store: Pick<SuperTabStore, 'archiveFinished'>, prs: () => PullRequests, everyMs = 10 * 60_000): () => void {
  let running = false
  const run = () => {
    if (running) return
    running = true
    void archiveFinishedGroups(db, store, prs(), Date.now()).then(count => { if (count) logger.info('[swarm-archive] archived', { count }) })
      .catch(error => logger.warn('[swarm-archive] failed', { error: error instanceof Error ? error.message : String(error) }))
      .finally(() => { running = false })
  }
  run()
  const timer = setInterval(run, everyMs)
  timer.unref()
  return () => clearInterval(timer)
}
