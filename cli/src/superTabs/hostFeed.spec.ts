import { describe, expect, it, vi } from 'vitest'
import type { CoreApi } from '../core/api.js'
import { fakeCore } from '../testing/fakeCore.js'
import { FIXTURE, ok, readFixture, refused, type BackendReply } from './fixtures/read/index.js'
import { HostFeed } from './hostFeed.js'

type Json = Record<string, unknown>
const M = FIXTURE.machineId, T = FIXTURE.tabId, T9 = FIXTURE.removedTabId
const FULL = `/api/super-tabs/hosts/${M}/changes?full=1`
const SINCE = (cursor: string) => `/api/super-tabs/hosts/${M}/changes?cursor=${cursor}`
const C0 = 'eyJ2IjoyLCJ0IjoxNzkzMDEwMDc0Mzc1LCJlIjowfQ', C1 = 'eyJ2IjoyLCJ0IjoxNzkzMDEwMDc3Mzc1LCJlIjowfQ'

function feedOf(replies: BackendReply[]) {
  let now = 1_000_000
  const call = vi.fn<CoreApi['account']['backend']>(async () => replies.length > 1 ? replies.shift()! : replies[0])
  const feed = new HostFeed(fakeCore({ account: { backend: call } }), M, { now: () => now })
  return { call, feed, paths: () => call.mock.calls.map(c => c[1]), later: (ms: number) => { now += ms } }
}
const agents = (rows: Json[]) => rows.map(row => `${String(row.tabId).slice(-1)}:${row.cleanup ? 'cleanup' : String((row.agent as Json).id).slice(-1)}`)

describe('the host form of a machine\'s Swarms', () => {
  it('reads every Swarm in full first: the roster, the pools and the assignments, Swarm by Swarm', async () => {
    const { feed, paths } = feedOf([ok(readFixture('host-full'))])
    const read = await feed.refresh()
    expect(agents(read.roster)).toEqual(['1:1', '1:2', '9:cleanup'])
    expect(read.roster[0]).toMatchObject({ tabId: T, lead: true, leadsConversationId: FIXTURE.leadsGroup, lastChangedAt: 1793010101002 })
    expect(read.pools).toEqual([readFixture<{ tabs: Json[] }>('host-full').tabs[0].pool])
    expect(read.assignments).toEqual([{ tabId: T, assignmentId: 'w0000000000000000000001', harnessId: FIXTURE.builderHarness }])
    expect(paths()).toEqual([FULL])
  })

  it('then reads what changed: a returned Swarm\'s rows are replaced, a removed Swarm leaves, the others stay', async () => {
    const { feed, paths } = feedOf([ok(readFixture('host-full')), ok(readFixture('host-changes')), ok(readFixture('host-quiet'))])
    await feed.refresh()
    const read = await feed.refresh()
    expect(agents(read.roster)).toEqual(['1:1', '1:2'])
    expect(read.roster[1]).toMatchObject({ attention: { status: 'needs_human' } })
    expect(read.pools).toMatchObject([{ tabId: T, starts: [] }])
    const quiet = await feed.refresh()
    expect(quiet.roster).toEqual(read.roster)
    expect(paths()).toEqual([FULL, SINCE(C0), SINCE(C1)])
  })

  it('reads in full again at least every minute, which drops a Swarm no longer listed', async () => {
    const shrunk = { ...readFixture<Json>('host-full'), tabs: readFixture<{ tabs: Json[] }>('host-full').tabs.slice(1) }
    const { feed, paths, later } = feedOf([ok(readFixture('host-full')), ok(readFixture('host-quiet')), ok(shrunk)])
    await feed.refresh()
    later(59_999)
    await feed.refresh()
    later(1)
    expect(agents((await feed.refresh()).roster)).toEqual(['9:cleanup'])
    expect(paths()).toEqual([FULL, SINCE(C0), FULL])
  })

  it('keeps its rows and cursor when a read fails, and starts in full again when the first one did', async () => {
    const { feed, paths } = feedOf([refused(503, 'SWARM_BUSY', 'Busy'), ok(readFixture('host-full')), refused(502, 'BAD_GATEWAY'), ok(readFixture('host-quiet'))])
    await expect(feed.refresh()).rejects.toMatchObject({ code: 'SWARM_BUSY' })
    await feed.refresh()
    await expect(feed.refresh()).rejects.toMatchObject({ status: 502 })
    expect(agents((await feed.refresh()).roster)).toEqual(['1:1', '1:2', '9:cleanup'])
    expect(paths()).toEqual([FULL, FULL, SINCE(C0), SINCE(C0)])
  })

  it('shares one read among callers that ask at once, and answers from the last read while it is fresh enough', async () => {
    const { feed, paths, later } = feedOf([ok(readFixture('host-full')), ok(readFixture('host-quiet'))])
    await Promise.all([feed.refresh(), feed.refresh(), feed.current(5_000)])
    later(4_999)
    await feed.current(5_000)
    expect(paths()).toEqual([FULL])
    later(1)
    await feed.current(5_000)
    expect(paths()).toEqual([FULL, SINCE(C0)])
  })

  it('tells the person to update Harness when the server answers in a format it cannot read', async () => {
    const { feed } = feedOf([ok({ ...readFixture<Json>('host-full'), format: 3 })])
    await expect(feed.refresh()).rejects.toMatchObject({ code: 'UPDATE_REQUIRED', status: 426 })
  })
})
