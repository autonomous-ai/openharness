import type { Prisma, PrismaClient } from '@prisma/client'
import { PULL_READ_PERMISSIONS, type GitHubApp } from '../github/app.js'
import { githubRepository, type GitHubRepository } from '../github/repository.js'
import { activeWork, type Conversation, type SuperTabState } from './model.js'
import type { HeadData } from './parts/index.js'
import type { SuperTabStore } from './store.js'
import { projectsOf } from './projects.js'
import { ARCHIVE_QUIET_MS, archiveWaitsFor } from './tidy.js'
import { logger } from '../utils/logger.js'

// A finished group archives by itself (roadmap, December: nobody tidies a Swarm by hand): its task done or cancelled, quiet
// for 30 minutes, no person's decision waiting there, and every pull request it links merged or closed. Only GitHub says
// that, over the network, so this runs in the singleton worker and never inside a Swarm's write; the write itself checks
// everything the Swarm knows again (store.ts archiveFinished). A step (a linked group: a review, a test) archives with its
// task, in the task's write (steps.ts endSteps), and never on its own clock while that task is open (task steps design): it
// is taken here only once its task is done or cancelled and every pull request of both is merged or closed.

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
const ended = (group: Conversation): boolean => ['done', 'cancelled'].includes(group.assignment?.status ?? '')

/**
 * Run once by the worker at startup, as its other index work is, so the pass finds what it should. Marks every part written
 * before the finished mark whose task is done or cancelled, a step not among them. A step's mark goes by its task, which an
 * update of one document cannot read: any mark on an open step is taken back (an earlier release marked every step nobody
 * held, so the pass archived it under an open task), and it is set again on those with nobody working whose task has ended.
 * Every later write of a part sets the mark itself, and of a step clears it (parts/write.ts). Returns how many it marked.
 */
export async function markFinishedGroups(db: PrismaClient): Promise<number> {
  const step = { $type: 'string' }
  const modified = (answer: unknown) => Number((answer as { nModified?: number }).nModified ?? 0)
  const written = modified(await db.$runCommandRaw({ update: 'SwarmGroup', updates: [
    { q: { workFinished: { $exists: false }, deleted: false, 'data.reviewOf': { $not: step }, 'data.assignment.status': { $in: ['done', 'cancelled'] } }, u: { $set: { workFinished: true } }, multi: true },
  ] }))
  await db.$runCommandRaw({ update: 'SwarmGroup', updates: [
    { q: { workFinished: true, archived: false, deleted: false, 'data.reviewOf': step }, u: { $set: { workFinished: false } }, multi: true },
  ] })
  // Open groups only (the mark's index leads with it and archived), one indexed read of its task for each open step.
  const rows = await db.swarmGroup.aggregateRaw({ pipeline: [
    { $match: { workFinished: { $in: [false, null] }, archived: false, deleted: false, 'data.reviewOf': step,
      $or: [{ 'data.assignment': null }, { 'data.assignment.status': { $in: ['done', 'stopped', 'cancelled', 'lost'] } }] } },
    { $lookup: { from: 'SwarmGroup', let: { tabId: '$tabId', task: '$data.reviewOf' }, as: 'task', pipeline: [
      { $match: { $expr: { $and: [{ $eq: ['$tabId', '$$tabId'] }, { $eq: ['$key', '$$task'] }] } } }, { $project: { status: '$data.assignment.status' } }] } },
    { $match: { 'task.status': { $in: ['done', 'cancelled'] } } },
    { $project: { _id: 1 } },
  ] }) as unknown as Array<{ _id: string }>
  if (!rows.length) return written
  return written + modified(await db.$runCommandRaw({ update: 'SwarmGroup', updates: [
    { q: { _id: { $in: rows.map(row => row._id) } }, u: { $set: { workFinished: true } }, multi: true },
  ] }))
}

/** One pass: every unarchived group quiet for ARCHIVE_QUIET_MS whose task is done or cancelled (its finished mark), in a Swarm that keeps
 *  tidying on, is archived once GitHub says each of its pull requests is merged or closed. Read oldest first by a cursor,
 *  so groups that stay open never hold later ones back. */
export async function archiveFinishedGroups(db: PrismaClient, store: Pick<SuperTabStore, 'archiveFinished'>, prs: PullRequests, now: number): Promise<number> {
  // One head read per Swarm a pass: whether it keeps tidying on, and its projects' repositories (tidy.ts archiveWaitsFor).
  const heads = new Map<string, Promise<HeadData | undefined>>()
  const headOf = (tabId: string) => {
    if (!heads.has(tabId)) heads.set(tabId, db.swarmHead.findUnique({ where: { id: `${tabId}:head` } }).then(row => row?.data as unknown as HeadData | undefined))
    return heads.get(tabId)!
  }
  // A deleted Swarm (deletion.ts) is left alone: none of its pull requests is read.
  const tidyOn = async (tabId: string) => {
    const head = await headOf(tabId)
    return head?.tidy !== false && !head?.deletion
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
        const finished = ended(group), step = !!group.reviewOf
        if (group.audience || !(finished || (step && !activeWork(group))) || !await tidyOn(row.tabId)) continue
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
        // Its links, and a "PR #N" its result or check evidence names; none to read it in keeps it open.
        const head = await headOf(row.tabId)
        const project = head && projectsOf(head as unknown as SuperTabState).find(p => p.id === (group.projectId ?? 'lead'))
        const own = archiveWaitsFor(group, project?.repository?.repositoryUrl)
        if (!own) continue
        if (!step) {
          if (await settled(own) && await archive(row, checked)) archived++
          continue
        }
        // A mark left by an earlier release, or a task handed on again since the mark: the task says, not the mark.
        const task = (await db.swarmGroup.findUnique({ where: { tabId_key: { tabId: row.tabId, key: group.reviewOf! } }, select: { data: true } }))?.data as unknown as Conversation | undefined
        if (!task || !ended(task)) continue
        const urls = [...new Set([...own, ...task.pullRequestUrls ?? []])]
        // A step nobody finished needs a pull request to say its work is settled (tidy.ts reviewClosable).
        if ((finished || urls.length) && await settled(urls) && await archive(row, checked, group.reviewOf)) archived++
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
