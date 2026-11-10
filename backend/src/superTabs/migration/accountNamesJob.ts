/**
 * Once, after the release that made a person's name in a Swarm follow their account's (personNames.ts nameFromAccount; anh Dee,
 * 2026-11-10): every Swarm's people take their accounts' names, so names chosen in a Swarm before show no longer. It runs in the
 * singleton worker a Swarm at a time with a pause between, logs only counts, tries again after a failure and stops once a pass
 * found nothing left to change. Two runners do no harm: each Swarm is read again in its own transaction, and a name that already
 * follows is not written. It can go with `chosenName`, from 2026-12-10.
 */
import type { PrismaClient } from '@prisma/client'
import { logger } from '../../utils/logger.js'
import type { SuperTabStore } from '../store.js'
import { sleeper, START_DELAY_MS } from './dropLegacyJob.js'

export const PAGE = 100
export const PAUSE_MS = 200
export const RETRY_MS = 3_600_000

export interface AccountNamesPass { swarms: number; changed: number; failed: number }

/** One pass over every live Swarm, in id order. */
export async function followAccountNamesOnce(db: PrismaClient, store: Pick<SuperTabStore, 'followAccountNames'>,
  { pause = async () => {}, signal }: { pause?: () => Promise<void>; signal?: AbortSignal } = {}): Promise<AccountNamesPass> {
  const pass: AccountNamesPass = { swarms: 0, changed: 0, failed: 0 }
  let after: string | undefined
  while (!signal?.aborted) {
    const rows = await db.superTab.findMany({ where: { deletedAt: null, ...after ? { id: { gt: after } } : {} }, select: { id: true },
      orderBy: { id: 'asc' }, take: PAGE })
    for (const { id } of rows) {
      if (signal?.aborted) break
      try {
        const changed = await store.followAccountNames(id)
        pass.swarms++
        if (typeof changed === 'number') pass.changed += changed
      } catch {
        pass.failed++
      }
      await pause()
    }
    if (rows.length < PAGE) break
    after = rows.at(-1)!.id
  }
  return pass
}

/** Starts the pass in the background, again each hour until one changed nothing and failed nowhere; the returned function stops it. */
export function startAccountNames(db: PrismaClient, store: Pick<SuperTabStore, 'followAccountNames'>, delayMs = START_DELAY_MS): () => void {
  const control = new AbortController()
  const wait = sleeper(control.signal)
  void (async () => {
    await wait(delayMs)
    while (!control.signal.aborted) {
      try {
        const pass = await followAccountNamesOnce(db, store, { pause: () => wait(PAUSE_MS), signal: control.signal })
        if (pass.failed) logger.warn('[account-names] pass', { ...pass })
        else logger.info('[account-names] pass', { ...pass })
        if (!pass.changed && !pass.failed) return
      } catch (error) {
        logger.warn('[account-names] failed', { error: error instanceof Error ? error.name : 'unknown' })
      }
      await wait(RETRY_MS)
    }
  })()
  return () => control.abort()
}
