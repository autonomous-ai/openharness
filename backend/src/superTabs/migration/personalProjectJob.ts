/**
 * Deletes the repo-less project every Personal Swarm was made with, named after the Swarm ("Personal") and public (PSW-B review,
 * 2026-11-11): Desktop hid it, the phone, web and CLI showed it. A Personal Swarm's projects are its person's repos (anh Dee
 * 2026-11-11), and a new one is made without it (model.ts createSuperTab).
 *
 * Runs in the singleton worker. It walks every Swarm row by the _id index, PAGE at a time with a pause between pages, so each read
 * examines what it returns and no more, and hands each live Personal Swarm to the store (store.ts removePersonalProject), which
 * deletes the project as its owner's `project.delete` would, and only while nothing was ever said in it and no agent or start is
 * in it; one with anything in it stays, a project like any other. Where it has walked to is kept in SuperTabSweepCursor (id
 * `personal-project`), so a worker that starts again carries on, and one that finished does not walk again. A Swarm whose removal
 * failed holds the walk there: the next pass, EVERY_MS later, tries it again, and after ATTEMPTS it is logged by its id and passed.
 * The first pass waits EVERY_MS, so a release's older servers, which still make the project, are gone before it walks. Counts in
 * its log. Goes, with its call in worker.ts, on or after 2026-12-12 (30 days after the release that carries it).
 */
import type { PrismaClient } from '@prisma/client'
import { logger } from '../../utils/logger.js'
import { isPersonalSwarm } from '../deletion.js'
import { SuperTabError } from '../model.js'
import type { SuperTabStore } from '../store.js'
import { sleeper } from './dropLegacyJob.js'

/** Swarm rows read by one find: their ids, owners and environments only. */
export const PAGE = 500
/** Pages one pass walks: 50,000 Swarms. */
export const PAGES_PER_PASS = 100
export const PAUSE_MS = 500
export const EVERY_MS = 10 * 60_000
export const CURSOR_ID = 'personal-project'
/** Tries a Swarm gets before the walk passes it. */
export const ATTEMPTS = 3
/** The cursor of a walk that reached the last Swarm. */
export const WALKED = '￿'

/** Counts only: no id, Swarm or name. `codes`: failures by code; such a project stays, and the walk goes on. */
export interface ProjectPass { examined: number; removed: number; kept: number; gone: number; failed: number; codes: Record<string, number>; done: boolean }
export interface ProjectOptions { pages?: number; pause?: () => Promise<void>; signal?: AbortSignal
  /** Failed tries by Swarm, across passes in this worker: kept by the caller. */
  attempts?: Map<string, number> }

type Db = Pick<PrismaClient, '$runCommandRaw' | 'superTabSweepCursor'>
type Row = { _id: string; ownerId?: string; autonomousEnv?: string; format?: number; deletedAt?: unknown }

/** Walks on from the stored cursor for up to [pages] pages, handing each live Personal Swarm to [store]; stores the cursor after
 *  each page. Done once a page comes back short: every Swarm was read. */
export async function removePersonalProjects(db: Db, store: Pick<SuperTabStore, 'removePersonalProject'>,
  { pages = PAGES_PER_PASS, pause, signal, attempts = new Map() }: ProjectOptions = {}): Promise<ProjectPass> {
  const pass: ProjectPass = { examined: 0, removed: 0, kept: 0, gone: 0, failed: 0, codes: {}, done: false }
  let after = (await db.superTabSweepCursor.findUnique({ where: { id: CURSOR_ID }, select: { after: true } }))?.after ?? ''
  if (after === WALKED) return { ...pass, done: true }
  for (let page = 0; page < pages && !signal?.aborted; page++) {
    if (page) await pause?.()
    const found = await db.$runCommandRaw({ find: 'SuperTab', filter: { _id: { $gt: after } }, sort: { _id: 1 }, hint: '_id_',
      projection: { _id: 1, ownerId: 1, autonomousEnv: 1, format: 1, deletedAt: 1 }, limit: PAGE, batchSize: PAGE, singleBatch: true } as never) as
      { cursor: { firstBatch: Row[] } }
    const rows = found.cursor.firstBatch
    pass.examined += rows.length
    /** The last row this page settled: the walk stops before a Swarm that failed, to try it again next pass. */
    let settled = after, held = false
    for (const row of rows) {
      if (row.format === 2 && !row.deletedAt && row.ownerId && row.autonomousEnv && isPersonalSwarm({ id: row._id, environment: row.autonomousEnv, ownerId: row.ownerId })) {
        try {
          pass[await store.removePersonalProject({ id: row._id, ownerId: row.ownerId, autonomousEnv: row.autonomousEnv })]++
          attempts.delete(row._id)
        } catch (error) {
          pass.failed++
          const code = error instanceof SuperTabError ? error.code : error instanceof Error ? error.name : 'unknown'
          pass.codes[code] = (pass.codes[code] ?? 0) + 1
          const tries = (attempts.get(row._id) ?? 0) + 1
          if (tries < ATTEMPTS) {
            attempts.set(row._id, tries)
            held = true
            break
          }
          attempts.delete(row._id)
          logger.error('[personal-project] a Personal Swarm\'s first project could not be removed; it stays, and the walk passes it', { tabId: row._id, code, tries })
        }
      }
      settled = row._id
    }
    const done = !held && rows.length < PAGE
    if (settled !== after || done) {
      after = done ? WALKED : settled
      const updatedAt = new Date()
      await db.superTabSweepCursor.upsert({ where: { id: CURSOR_ID }, create: { id: CURSOR_ID, after, updatedAt }, update: { after, updatedAt } })
    }
    if (done) { pass.done = true; break }
    if (held) break
  }
  return pass
}

/** Starts the walk in the worker: a pass EVERY_MS from now and every EVERY_MS until one reaches the last Swarm. The returned
 *  function stops it, a pass in flight too, at its next page. */
export function startPersonalProjectRemoval(db: PrismaClient, store: Pick<SuperTabStore, 'removePersonalProject'>): () => void {
  const control = new AbortController()
  const wait = sleeper(control.signal)
  const attempts = new Map<string, number>()
  void (async () => {
    await wait(EVERY_MS)
    while (!control.signal.aborted) {
      try {
        const pass = await removePersonalProjects(db, store, { pause: () => wait(PAUSE_MS), signal: control.signal, attempts })
        if (pass.failed) logger.error('[personal-project] some Personal Swarms\' first projects could not be removed; they stay, and the walk goes on', { ...pass })
        else if (pass.removed || pass.kept) logger.info('[personal-project] pass', { ...pass })
        if (pass.done) { logger.info('[personal-project] done', { ...pass }); return }
      } catch (error) {
        logger.error('[personal-project] pass failed; trying again', { error: error instanceof Error ? error.name : 'unknown', retryInMs: EVERY_MS })
      }
      await wait(EVERY_MS)
    }
  })()
  return () => control.abort()
}
