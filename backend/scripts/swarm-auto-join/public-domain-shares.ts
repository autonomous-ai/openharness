// Swarm auto-join (docs/specs/2026-11-03-swarm-domain-auto-join.md, "Old Swarm settings that break the new rules"): from this
// release a saved "Anyone at a domain" share at a domain anyone can have an address at (gmail.com, ...) stops answering joins.
// This lists those Swarms before the merge, so their owners can be told. Read-only: two aggregations, no write.
// The PM runs it with the read-only production login, never an Engineer:
//   cd backend && DATABASE_URL="$(read-only URL from its environment file)" npx tsx scripts/swarm-auto-join/public-domain-shares.ts
// It prints the count and the Swarm ids (with each one's domain and whether it is deleted) as JSON, nothing else.
import { PrismaClient } from '@prisma/client'
import { isPublicEmailDomain } from '../../src/lib/publicEmailDomains.js'

interface Share { tabId: string; domain: string }

const db = new PrismaClient()
try {
  // Swarms in parts keep sharing in their head part; a Swarm still in one row keeps it in the row's state.
  const heads = await db.swarmHead.aggregateRaw({ pipeline: [
    { $match: { deleted: false, 'data.sharing.access.mode': 'domain' } },
    { $project: { _id: 0, tabId: 1, domain: '$data.sharing.access.domain' } }] }) as unknown as Share[]
  const rows = await db.superTab.aggregateRaw({ pipeline: [
    { $match: { format: { $ne: 2 }, 'state.sharing.access.mode': 'domain' } },
    { $project: { _id: 0, tabId: '$_id', domain: '$state.sharing.access.domain' } }] }) as unknown as Share[]
  const broken = [...heads, ...rows].filter(share => isPublicEmailDomain(String(share.domain ?? '')))
  const deleted = new Set((await db.superTab.findMany({ where: { id: { in: broken.map(share => share.tabId) }, deletedAt: { not: null } }, select: { id: true } }))
    .map(row => row.id))
  const swarms = broken.map(share => ({ id: share.tabId, domain: share.domain, deleted: deleted.has(share.tabId) })).sort((a, b) => a.id < b.id ? -1 : 1)
  console.log(JSON.stringify({ count: swarms.length, swarms }, null, 2))
} finally {
  await db.$disconnect()
}
