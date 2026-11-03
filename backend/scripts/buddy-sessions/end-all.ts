/**
 * Ends every live Buddy thread session (src/superTabs/buddySessions.ts) before the backend is rolled back to a release
 * without them (spec docs/superpowers/specs/2026-10-30-buddy-thread-sessions-design.md, Design 6). The previous release
 * would read each session as one more Buddy: its main Buddy would read session threads, and its Buddy removal would take one
 * Buddy and leave the rest running. Each end goes through the session's own end path, as the chat's own person (only they
 * may end one), with reason `maintenance`: its agent is closed by its host, and its thread says why.
 *
 * A dry run by default: it lists what it would end, by Swarm and chat id only. `--apply` ends them. Production is the
 * owner's to run (a prod write).
 *
 *   DATABASE_URL=... NODE_ENV=production node --import tsx scripts/buddy-sessions/end-all.ts [--apply]
 */
import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import type { AuthUser } from '../../src/lib/ssoAuth.js'
import { SuperTabStore } from '../../src/superTabs/store.js'

export interface SessionToEnd { tabId: string; conversationId: string; thread: string; personId: string }

/** Every live or starting session in every Swarm, read from the Buddy chats' records alone. */
export async function liveBuddySessions(db: PrismaClient): Promise<SessionToEnd[]> {
  const rows = await db.swarmGroup.aggregateRaw({ pipeline: [
    { $match: { deleted: false, 'data.kind': { $in: ['buddy', 'swarm-buddy'] }, 'data.buddySessions.0': { $exists: true } } },
    { $project: { tabId: 1, key: 1, sessions: '$data.buddySessions', people: '$data.audience.people' } }] }) as unknown as
    Array<{ tabId: string; key: string; sessions: Array<{ thread: string }>; people?: Array<{ id: string }> }>
  return rows.flatMap(row => row.people?.[0] ? row.sessions.map(s => ({ tabId: row.tabId, conversationId: row.key, thread: s.thread, personId: row.people![0]!.id })) : [])
}

/** Ends [sessions] (or only lists them unless [apply]); returns how many ended and which failed, by id only. */
export async function endBuddySessions(db: PrismaClient, sessions: SessionToEnd[], apply: boolean, autonomousEnv = 'prod'):
  Promise<{ ended: number; failed: Array<SessionToEnd & { why: string }> }> {
  const store = new SuperTabStore(db)
  let ended = 0
  const failed: Array<SessionToEnd & { why: string }> = []
  for (const session of sessions) {
    if (!apply) continue
    const user = await db.user.findUnique({ where: { id: session.personId }, select: { email: true } })
    if (!user) { failed.push({ ...session, why: 'its person has no account' }); continue }
    const person: AuthUser = { sub: session.personId, email: user.email, autonomousEnv, role: 'user' }
    try {
      const done = await store.execute(person, session.tabId, { operationId: randomUUID(), command: { type: 'buddy.sessionEnd',
        conversationId: session.conversationId, thread: session.thread, reason: 'maintenance' } })
      if (done.result.ended) ended++
    } catch (error) {
      failed.push({ ...session, why: error instanceof Error ? error.message : String(error) })
    }
  }
  return { ended, failed }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const apply = process.argv.includes('--apply')
  const db = new PrismaClient()
  const sessions = await liveBuddySessions(db)
  console.log(`${sessions.length} live Buddy thread session(s)`)
  for (const s of sessions) console.log(`  Swarm ${s.tabId} chat ${s.conversationId} thread ${s.thread}`)
  if (!apply) console.log('Dry run: nothing ended. Run again with --apply to end them.')
  else {
    const { ended, failed } = await endBuddySessions(db, sessions, true, process.env.AUTONOMOUS_ENV ?? 'prod')
    console.log(`Ended ${ended}.`)
    for (const f of failed) console.log(`  Not ended: Swarm ${f.tabId} chat ${f.conversationId} thread ${f.thread}: ${f.why}`)
    if (failed.length) process.exitCode = 1
  }
  await db.$disconnect()
}
