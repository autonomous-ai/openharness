import type { PrismaClient } from '@prisma/client'
import { describe, expect, it } from 'vitest'
import { reflectionMessageId } from '../superTabs/costs/reflection.js'
import { MAX_CANDIDATES, PLAN_EVERY_MS, reflectionCache, reflectionDue, reflectNightly } from './routingReflection.js'

const utc = (day: number, hour: number, minute = 0) => Date.UTC(2026, 9, day, hour, minute)

describe('when the nightly routing reflection is due', () => {
  it('is due from 23:00 to 23:59 in Vietnam for a project with no digest zone, for that local date', () => {
    expect(reflectionDue({}, utc(30, 16, 0))).toBe('2026-10-30')
    expect(reflectionDue({}, utc(30, 16, 59))).toBe('2026-10-30')
    expect(reflectionDue({}, utc(30, 15, 59))).toBeNull()
    // Midnight in Vietnam is the next day: a pass that missed 23:xx does not report a day late.
    expect(reflectionDue({}, utc(30, 17, 0))).toBeNull()
  })

  it('follows the project digest time zone', () => {
    const berlin = { digest: { time: '08:00', timeZone: 'Europe/Berlin' } }
    expect(reflectionDue(berlin, utc(30, 22, 30))).toBe('2026-10-30')
    expect(reflectionDue(berlin, utc(30, 16, 30))).toBeNull()
  })

  it('falls back to Vietnam for a zone this runtime does not know', () => {
    expect(reflectionDue({ digest: { time: '08:00', timeZone: 'Mars/Olympus' } }, utc(30, 16, 30))).toBe('2026-10-30')
  })

  it('posts one report a project a local date', () => {
    expect(reflectionMessageId('tab', 'p1', '2026-10-30')).toBe(reflectionMessageId('tab', 'p1', '2026-10-30'))
    expect(reflectionMessageId('tab', 'p1', '2026-10-30')).not.toBe(reflectionMessageId('tab', 'p1', '2026-10-31'))
    expect(reflectionMessageId('tab', 'p1', '2026-10-30')).not.toBe(reflectionMessageId('tab', 'p2', '2026-10-30'))
  })
})

/** A database with [candidates] (Swarm, project) pairs and these heads, counting what a pass reads. */
function fakeDb(candidates: Array<[string, string]>, heads: Record<string, unknown>) {
  const reads = { candidates: 0, heads: 0 }
  const db = {
    superTabModelEvidence: { aggregateRaw: async () => { reads.candidates++; return candidates.map(([tabId, projectId]) => ({ _id: { tabId, projectId } })) } },
    swarmHead: { findUnique: async ({ where: { id } }: { where: { id: string } }) => { reads.heads++; return heads[id] ?? null } },
  }
  return { db: db as unknown as PrismaClient, reads }
}
const NIGHT = utc(30, 16, 10)
const store = () => {
  const asked: string[] = []
  return { asked, postReflection: async (tabId: string, projectId: string, on: string) => { asked.push(`${tabId} ${projectId} ${on}`); return 'posted' as const } }
}

describe('a pass of the nightly routing reflection (review of #2276)', () => {
  it('reports the one project of a Swarm with no projects list', async () => {
    const { db } = fakeDb([['old', 'lead']], { 'old:head': { deleted: false, data: { name: 'Old', ownerId: 'u1' } } })
    const s = store()
    expect(await reflectNightly(db, s, NIGHT)).toMatchObject({ posted: 1, failed: 0 })
    expect(s.asked).toEqual(['old lead 2026-10-30'])
  })

  it('reads the projects and their time zones once every few hours, not on every pass, and asks each settled report once', async () => {
    const { db, reads } = fakeDb([['t1', 'p1']], { 't1:head': { deleted: false, data: { projects: [{ id: 'p1', leadConversationId: 'c1' }] } } })
    const s = store(), cache = reflectionCache()
    for (let pass = 0; pass < 4; pass++) await reflectNightly(db, s, NIGHT + pass * 15 * 60_000, undefined, cache)
    expect(reads).toEqual({ candidates: 1, heads: 1 })
    expect(s.asked).toEqual(['t1 p1 2026-10-30'])
    // The next night, after the plan is old: read again, and that night's report asked.
    await reflectNightly(db, s, NIGHT + 24 * 3_600_000, undefined, cache)
    expect(PLAN_EVERY_MS).toBeLessThan(24 * 3_600_000)
    expect(reads).toEqual({ candidates: 2, heads: 2 })
    expect(s.asked).toEqual(['t1 p1 2026-10-30', 't1 p1 2026-10-31'])
  })

  it('reads the plan again on the next pass when a Swarm read failed, and asks a failed report again', async () => {
    const { db, reads } = fakeDb([['t1', 'p1']], {})
    let fail = true
    const swarmHead = (db as unknown as { swarmHead: { findUnique: (a: unknown) => Promise<unknown> } }).swarmHead
    const read = swarmHead.findUnique
    swarmHead.findUnique = async a => {
      await read(a)
      if (fail) { fail = false; throw new Error('timed out') }
      return { deleted: false, data: { projects: [{ id: 'p1' }] } }
    }
    const warned: unknown[] = [], cache = reflectionCache()
    let failures = 1
    const flaky = { postReflection: async () => { if (failures-- > 0) throw new Error('busy'); return 'posted' as const } }
    expect(await reflectNightly(db, flaky, NIGHT, { warn: (...a: unknown[]) => { warned.push(a) } }, cache)).toMatchObject({ failed: 1, posted: 0 })
    expect(await reflectNightly(db, flaky, NIGHT + 15 * 60_000, { warn: (...a: unknown[]) => { warned.push(a) } }, cache)).toMatchObject({ failed: 1, posted: 0 })
    expect(await reflectNightly(db, flaky, NIGHT + 30 * 60_000, { warn: (...a: unknown[]) => { warned.push(a) } }, cache)).toMatchObject({ failed: 0, posted: 1 })
    expect(reads.heads).toBe(2)
    expect(warned).toHaveLength(2)
  })

  it('says when it read as many projects as a pass reads', async () => {
    const pairs = Array.from({ length: MAX_CANDIDATES }, (_, i): [string, string] => [`t${i}`, 'lead'])
    const { db } = fakeDb(pairs, {})
    const warned: unknown[][] = []
    await reflectNightly(db, store(), NIGHT, { warn: (...a: unknown[]) => { warned.push(a) } })
    expect(warned).toEqual([['[routing-reflection] read the most projects a pass reads; some may get no report', { limit: MAX_CANDIDATES }]])
    const few = fakeDb([['t1', 'lead']], {})
    warned.length = 0
    await reflectNightly(few.db, store(), NIGHT, { warn: (...a: unknown[]) => { warned.push(a) } })
    expect(warned).toEqual([])
  })
})
