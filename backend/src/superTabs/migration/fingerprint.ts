import { createHash } from 'node:crypto'
import type { Prisma } from '@prisma/client'

/** What the migration must leave untouched (design 6.3): the ordered message list and the other rows of the Swarm. */
export interface Fingerprint {
  messages: number
  /** sha256 of the ordered (conversationId, sequence, id) list. */
  order: string
  conversationIds: Set<string>
  rows: { deliveries: number; routeDecisions: number; attempts: number; operations: number }
}

export async function fingerprint(tx: Prisma.TransactionClient, tabId: string): Promise<Fingerprint> {
  const where = { tabId }
  const [messages, deliveries, routeDecisions, attempts, operations] = await Promise.all([
    tx.superTabMessage.findMany({ where, select: { conversationId: true, sequence: true, id: true },
      orderBy: [{ conversationId: 'asc' }, { sequence: 'asc' }, { id: 'asc' }] }),
    tx.superTabDelivery.count({ where }), tx.superTabRouteDecision.count({ where }), tx.superTabAttempt.count({ where }), tx.superTabOperation.count({ where }),
  ])
  const order = createHash('sha256')
  for (const m of messages) order.update(`${m.conversationId}\t${m.sequence}\t${m.id}\n`)
  return { messages: messages.length, order: order.digest('hex'), conversationIds: new Set(messages.map(m => m.conversationId)),
    rows: { deliveries, routeDecisions, attempts, operations } }
}

/** Where a fingerprint taken after the migration differs from the one before it, or null. */
export function fingerprintDifference(before: Fingerprint, after: Fingerprint): string | null {
  if (before.messages !== after.messages || before.order !== after.order) return `messages changed: ${before.messages} before, ${after.messages} after`
  const changed = (Object.keys(before.rows) as Array<keyof Fingerprint['rows']>).filter(key => before.rows[key] !== after.rows[key])
  return changed.length ? `rows changed: ${changed.map(key => `${key} ${before.rows[key]} → ${after.rows[key]}`).join(', ')}` : null
}

/** The newest message of each conversation: when its group was last active. */
export async function lastActivity(tx: Prisma.TransactionClient, tabId: string): Promise<Map<string, number>> {
  const rows = await tx.superTabMessage.groupBy({ by: ['conversationId'], where: { tabId }, _max: { createdAt: true } })
  return new Map(rows.flatMap(row => row._max.createdAt ? [[row.conversationId, row._max.createdAt.getTime()] as const] : []))
}
