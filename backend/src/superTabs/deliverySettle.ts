import type { PrismaClient, SuperTabDelivery } from '@prisma/client'
import { ms } from './parts/light.js'
import type { SuperTabStore } from './store.js'
import { logger } from '../utils/logger.js'

// No delivery waits for good (Ken, 2026-10-28). Prod watch kept finding the same 9: uncertain since Oct 20, claimed for 71
// hours, queued in archived groups. None belonged to a task, so nothing that ends a task's deliveries ended them. This pass
// ends, as cancelled, every open delivery that can no longer move; its sender sees it as Not sent. A host's later read of a
// cancelled delivery types nothing: it leaves the host's list, and its claim path never sees it again (cli superTabs/host.ts).

/** A host that still holds a claim says so within a minute: it re-claims, types and acknowledges, or reports a hold after 30 s
 *  (cli superTabs/withheld.ts). A claim nobody wrote for this long has no live claimer. */
export const CLAIM_QUIET_MS = 10 * 60_000
/** How long the host may hold a claim while the agent's terminal is busy. */
export const HOLD_LIMIT_MS = 60 * 60_000
/** How long while the terminal waits on a person's answer: that person still owes it one (Lead, 2026-10-28). */
export const WAITING_ON_PERSON_LIMIT_MS = 24 * 60 * 60_000
/** How long a person has to check a delivery its host could not confirm before it ends, as their Open terminal ends it. */
export const UNCERTAIN_LIMIT_MS = 60 * 60_000
const SETTLE_EVERY_MS = 5 * 60_000
const OPEN = ['queued', 'claimed', 'uncertain']
const BATCH = 500

/** Whether an open delivery can no longer move. [reachable]: its recipient may still read it there (store.ts deliveryAllowed). */
export function stuck(delivery: Pick<SuperTabDelivery, 'status' | 'holdReason' | 'holdSince' | 'updatedAt'>, reachable: boolean, now: number): boolean {
  if (!reachable) return true
  const since = (at: Date) => now - at.getTime()
  if (delivery.status === 'uncertain') return since(delivery.updatedAt) > UNCERTAIN_LIMIT_MS
  if (delivery.status !== 'claimed') return false
  if (!delivery.holdSince) return since(delivery.updatedAt) > CLAIM_QUIET_MS
  return since(delivery.holdSince) > (delivery.holdReason === 'team_waiting_user' ? WAITING_ON_PERSON_LIMIT_MS : HOLD_LIMIT_MS)
}

/** A page of open deliveries, by id. Read by their own index (status, id) with a plain match: Prisma sends `status in` as an
 *  $expr $or that no index can bound (pageReads.ts), and a pass must not read every delivery ever sent. */
async function openDeliveries(db: PrismaClient, after: string | null): Promise<SuperTabDelivery[]> {
  const rows = await db.superTabDelivery.aggregateRaw({ pipeline: [{ $match: { status: { $in: OPEN }, ...after ? { _id: { $gt: after } } : {} } },
    { $sort: { _id: 1 } }, { $limit: BATCH }] }) as unknown as Array<Record<string, unknown>>
  const date = (value: unknown) => value == null ? null : new Date(ms(value))
  return rows.map(({ _id, ...row }) => ({ ...row, id: _id as string, holdSince: date(row.holdSince), deliveredAt: date(row.deliveredAt),
    answeredAt: date(row.answeredAt), createdAt: date(row.createdAt)!, updatedAt: date(row.updatedAt)! }) as unknown as SuperTabDelivery)
}

/** One pass: each Swarm's open deliveries are judged against that Swarm as it is now, and the stuck ones end. */
export async function settleStuckDeliveries(db: PrismaClient, store: Pick<SuperTabStore, 'settleDeliveries'>, now: number): Promise<number> {
  let settled = 0, after: string | null = null
  for (;;) {
    const rows = await openDeliveries(db, after)
    const byTab = new Map<string, SuperTabDelivery[]>()
    for (const row of rows) byTab.set(row.tabId, [...byTab.get(row.tabId) ?? [], row])
    for (const [tabId, tabRows] of byTab) {
      // One Swarm that cannot be read now (it is being migrated) never holds the others back.
      try { settled += await store.settleDeliveries(tabId, tabRows, now) } catch (error) {
        logger.warn('[swarm-deliveries] could not settle', { tabId, error: error instanceof Error ? error.message : String(error) })
      }
    }
    if (rows.length < BATCH) return settled
    after = rows.at(-1)!.id
  }
}

/** Runs the pass every 5 minutes in the singleton worker. */
export function startDeliverySettle(db: PrismaClient, store: Pick<SuperTabStore, 'settleDeliveries'>, everyMs = SETTLE_EVERY_MS): () => void {
  let running = false
  const run = () => {
    if (running) return
    running = true
    void settleStuckDeliveries(db, store, Date.now()).then(count => { if (count) logger.info('[swarm-deliveries] settled', { count }) })
      .catch(error => logger.warn('[swarm-deliveries] failed', { error: error instanceof Error ? error.message : String(error) }))
      .finally(() => { running = false })
  }
  run()
  const timer = setInterval(run, everyMs)
  timer.unref()
  return () => clearInterval(timer)
}
