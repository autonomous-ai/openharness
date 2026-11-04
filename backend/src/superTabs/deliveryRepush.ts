import type { Prisma, PrismaClient } from '@prisma/client'
import { readBy } from './parts/indexed.js'
import { ms } from './parts/light.js'
import type { DeliveriesWaiting } from './store.js'
import { logger } from '../utils/logger.js'

// Task #2800 (Watch Production, 2026-11-04): GET deliveries was 84% empty. While this server pushes, a host read each idle
// agent's list every 30 s anyway, only in case a push was lost on the way (Redis pub/sub keeps nothing for a socket that
// missed it). That net moves here: one read of the queued deliveries of every Swarm every 15 s, and the machine of each agent
// with one waiting is told again. The host then reads an idle worker's list only when told (cli superTabs/host.ts).

/** A delivery's own push went out when it was written (store.ts announce) and is almost always heard; one still queued after
 *  this long is told again. With the pass's 15 s, a lost push is read within 25 s, sooner than the host's old 30 s. */
export const REPUSH_AFTER_MS = 10_000
const REPUSH_EVERY_MS = 15_000
const BATCH = 500

/** Tells each machine once per agent that has a delivery queued REPUSH_AFTER_MS or more. Reads queued rows only, by the
 *  delivery status index `(status, _id)` with a plain match, page by page: ids are hashes, so no page order puts new rows
 *  first. Resolves to the number of agents told. */
export async function repushQueuedDeliveries(db: PrismaClient, tell: (waiting: DeliveriesWaiting) => void, now: number): Promise<number> {
  const told = new Set<string>()
  let after: string | null = null
  for (;;) {
    const rows = await readBy(db as unknown as Prisma.TransactionClient, 'SuperTabDelivery', 'settle', [
      { $match: { status: 'queued', ...after ? { _id: { $gt: after } } : {} } }, { $sort: { _id: 1 } }, { $limit: BATCH },
      { $project: { tabId: 1, agentId: 1, machineId: 1, updatedAt: 1 } }])
    for (const row of rows) {
      const { tabId, agentId, machineId } = row as { tabId: string; agentId: string; machineId: string }
      if (now - ms(row.updatedAt) < REPUSH_AFTER_MS) continue
      const key = `${machineId}\u0000${tabId}\u0000${agentId}`
      if (told.has(key)) continue
      told.add(key)
      tell({ machineId, tabId, agentId })
    }
    if (rows.length < BATCH) return told.size
    after = rows.at(-1)!._id as string
  }
}

/** Runs the pass every 15 s in the singleton worker. A pass that fails is logged as an error each time: until it runs again,
 *  a delivery whose push was lost waits for the host's next read (its 4-minute repeat, a reconnect). */
export function startDeliveryRepush(db: PrismaClient, tell: (waiting: DeliveriesWaiting) => void, everyMs = REPUSH_EVERY_MS): () => void {
  let running = false
  const run = () => {
    if (running) return
    running = true
    void repushQueuedDeliveries(db, tell, Date.now())
      .then(count => { if (count) logger.info('[swarm-deliveries] re-announced', { count }) })
      .catch(error => logger.error('[swarm-deliveries] re-announce failed; a delivery whose push was lost waits for its host\'s 4-minute read',
        { error: error instanceof Error ? error.message : String(error) }))
      .finally(() => { running = false })
  }
  const timer = setInterval(run, everyMs)
  timer.unref()
  return () => clearInterval(timer)
}
