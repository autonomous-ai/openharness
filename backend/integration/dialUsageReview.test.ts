import { afterAll, beforeAll, expect, it } from 'vitest'
import type { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import type { PrismaClient } from '@prisma/client'
import { planDatabase, plan, profiled } from './plans.test-support.js'
import { voiceIncrements } from '../src/lib/voiceUsage.js'

// The dial's counts from ingest to the `dial` section of usage:daily (docs/plans/2026-11-23-dial-usage-counts-plan.md,
// Task 4). A fresh loopback replica set with made-up accounts; the app's Prisma client is pointed at it before anything
// imports it. Never DATABASE_URL.
let replica: MongoMemoryReplSet
let db: PrismaClient
let usage: typeof import('../src/lib/productUsage.js')
let review: typeof import('../src/analytics/dailyDialReview.js')
const DAY = 86_400_000
const now = new Date()
const yesterday = new Date(Math.floor(now.getTime() / DAY) * DAY - DAY)
const day = yesterday.toISOString().slice(0, 10)

beforeAll(async () => {
  let uri: string
  ({ replica, db, uri } = await planDatabase('dial_usage_review_test'))
  process.env.DATABASE_URL = uri
  usage = await import('../src/lib/productUsage.js')
  review = await import('../src/analytics/dailyDialReview.js')
})
afterAll(async () => {
  await (await import('../src/lib/prisma.js')).prisma.$disconnect()
  await db?.$disconnect()
  await replica?.stop()
})

it('counts the dial outside the team and the team apart, a dial clip and a rest clip in their own rows, by the day index', async () => {
  const outside = (await db.user.create({ data: { email: 'dial-outside@example.invalid', externalId: 'dial-review-outside' } })).id
  const staff = (await db.user.create({ data: { email: 'dial-staff@autonomous.ai', externalId: 'dial-review-staff' } })).id
  const context = (channel: 'production' | 'development') => ({ surface: 'cli', release: '0.6.84', platform: 'macos', channel }) as const
  const report = (id: string, channel: 'production' | 'development' = 'production') => ({ schemaVersion: 1 as const, revision: 0, id, day,
    context: context(channel), counters: { dial_connected_installation_days: 1, dial_voice_installation_days: 1, dial_voice_delivered: 3 } })
  // Five computers outside the team, one of the team's, and a development build's report that is kept nowhere.
  for (const n of [1, 2, 3, 4, 5]) expect(await usage.ingestProductUsage(outside, report(`dial-outside-${n}`), now)).toMatchObject({ accepted: true })
  expect(await usage.ingestProductUsage(staff, report('dial-staff-1'), now)).toMatchObject({ accepted: true })
  expect(await usage.ingestProductUsage(outside, report('dial-development-1', 'development'), now)).toMatchObject({ accepted: true })
  await usage.recordVoiceUsage(outside, yesterday, voiceIncrements('dial', 0, 30_000, 1_000))
  await usage.recordVoiceUsage(outside, yesterday, voiceIncrements('rest', 30_000, 45_000, 2_000))
  await usage.flushRelayUsage()

  const entries = await profiled(db, () => review.readDialRows(db, now))
  // The read is the run's only one of the totals. Its list of names passes the profiler's 50 KB, which keeps no filter of it.
  const read = entries.filter(e => e.ns.endsWith('.product_usage_totals'))
  expect(read, JSON.stringify(plan(read))).toHaveLength(1)
  expect(read[0]!.planSummary, JSON.stringify(plan(read))).toMatch(/IXSCAN \{ dayUtc: 1, metric: 1/)
  expect(read[0]!.docsExamined, JSON.stringify(plan(read))).toBe(read[0]!.nreturned)

  const rows = await review.readDialRows(db, now)
  const value = (metric: string) => rows.find(r => r.metric === metric)?.value
  expect([value('voice_dial_clips'), value('voice_dial_audio_ms'), value('voice_rest_clips'), value('voice_rest_audio_ms')])
    .toEqual([1, 30_000, 1, 45_000])
  const section = review.dailyDialReview(rows, [], now)
  const connected = (sections: typeof section.outsideTeam) => sections.find(s => s.name === 'Who uses a dial')!.rows
    .find(r => r.name === 'Connected (computer-days)')!.computers.day
  expect(connected(section.outsideTeam)).toBe(5)
  expect(connected(section.team)).toBe('<5')
  expect(section.voice.outsideTeam.dial.clips.day).toBe(1)
  expect(section.voice.outsideTeam.rest.clips.day).toBe('<5')
}, 60_000)
