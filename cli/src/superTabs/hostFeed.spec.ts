import { describe, expect, it, vi } from 'vitest'
import type { CoreApi } from '../core/api.js'
import { fakeCore } from '../testing/fakeCore.js'
import { FIXTURE, ok, readFixture, refused, type BackendReply } from './fixtures/read/index.js'
import { HostFeed } from './hostFeed.js'

type Json = Record<string, unknown>
const M = FIXTURE.machineId, T = FIXTURE.tabId, T9 = FIXTURE.removedTabId
const FORM = `/api/super-tabs/hosts/${M}/changes`
/** Each read as the feed asked it: a GET while it holds nothing, then a POST that names the Swarms it holds (their etags). */
const FULL = `${FORM}?full=1`, FULL_HELD = 'POST full'
const SINCE = (cursor: string) => `POST since ${cursor}`
const C0 = 'eyJ2IjoyLCJ0IjoxNzkzMDEwMDc0Mzc1LCJlIjowfQ', C1 = 'eyJ2IjoyLCJ0IjoxNzkzMDEwMDc3Mzc1LCJlIjowfQ'

function feedOf(replies: BackendReply[]) {
  let now = 1_000_000
  const call = vi.fn<CoreApi['account']['backend']>(async () => replies.length > 1 ? replies.shift()! : replies[0])
  const feed = new HostFeed(fakeCore({ account: { backend: call } }), M, { now: () => now })
  const paths = () => call.mock.calls.map(([method, path, body]) => {
    if (method === 'GET') return path
    const sent = body as Json
    if (path !== FORM) return `POST ${path}`
    return sent.full === true ? FULL_HELD : `POST since ${String(sent.cursor)}`
  })
  const held = () => call.mock.calls.filter(([method]) => method === 'POST').map(([, , body]) => (body as Json).held)
  return { call, feed, paths, held, later: (ms: number) => { now += ms } }
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
    expect(paths()).toEqual([FULL, SINCE(C0), FULL_HELD])
  })

  // Review round 1: the server answers in full when the cursor is bad or too old, with no list of removed Swarms.
  it('takes a full answer to a read by change as full: Swarms it omits are dropped, and the minute starts again', async () => {
    const forced = { ...readFixture<Json>('host-full'), cursor: 'forced', tabs: readFixture<{ tabs: Json[] }>('host-full').tabs.slice(0, 1) }
    const { feed, paths, later } = feedOf([ok(readFixture('host-full')), ok(forced), ok(readFixture('host-quiet'))])
    await feed.refresh()
    later(50_000)
    expect(agents((await feed.refresh()).roster)).toEqual(['1:1', '1:2'])
    later(50_000)
    await feed.refresh()
    expect(paths()).toEqual([FULL, SINCE(C0), SINCE('forced')])
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

  it('takes no rows from a Swarm whose lists are malformed, and still those of the others', async () => {
    const form = readFixture<{ tabs: Json[] }>('host-full')
    const { feed } = feedOf([ok({ ...form, tabs: [{ tabId: 'odd', roster: {}, pool: 'none', assignments: null }, ...form.tabs] })])
    const read = await feed.refresh()
    expect(agents(read.roster)).toEqual(['1:1', '1:2', '9:cleanup'])
    expect(read.pools).toHaveLength(1)
    expect(read.assignments).toHaveLength(1)
  })

  // The Lead's ruling on #1726: an active Swarm re-sent its whole rows every tick. The host names the rows it holds, by their
  // etag, and the server answers a Swarm whose rows match with no rows at all.
  it('names the rows it holds, and keeps them for a Swarm the server answers unchanged', async () => {
    const { feed, paths, held } = feedOf([ok(readFixture('host-full')), ok(readFixture('host-unchanged'))])
    await feed.refresh()
    const read = await feed.refresh()
    expect(paths()).toEqual([FULL, SINCE(C0)])
    expect(held()).toEqual([{ [T]: 'etag-tab1-a', [T9]: 'etag-tab9-a' }])
    expect(read.roster.filter(row => row.tabId === T)).toEqual(readFixture<{ tabs: Json[] }>('host-full').tabs[0].roster)
    expect(read.pools).toEqual([readFixture<{ tabs: Json[] }>('host-full').tabs[0].pool])
    expect(read.roster.find(row => row.tabId === T9)).toMatchObject({ cleanup: { removalId: 'r0000000000000000000002' } })
    await feed.refresh()
    expect(held().at(-1)).toEqual({ [T]: 'etag-tab1-a', [T9]: 'etag-tab9-b' })
  })

  it('names what it holds in the minute\'s full read too: an unchanged Swarm keeps its rows, one left out is dropped', async () => {
    const unchanged = { format: 2, full: true, cursor: 'after-full', removedTabIds: [], tabs: [{ tabId: T, etag: 'etag-tab1-a', lastChangedAt: 1793010101002, unchanged: true }] }
    const { feed, paths, held, later } = feedOf([ok(readFixture('host-full')), ok(unchanged)])
    await feed.refresh()
    later(60_000)
    const read = await feed.refresh()
    expect(paths()).toEqual([FULL, FULL_HELD])
    expect(held()).toEqual([{ [T]: 'etag-tab1-a', [T9]: 'etag-tab9-a' }])
    expect(agents(read.roster)).toEqual(['1:1', '1:2'])
  })

  it('forgets an unchanged answer for a Swarm it does not hold, so the next read asks for it whole', async () => {
    const stray = { format: 2, full: false, cursor: 'stray', removedTabIds: [], tabs: [{ tabId: 'f1a5c0de000000000000000s', etag: 'x', lastChangedAt: 1, unchanged: true }] }
    const { feed, held } = feedOf([ok(readFixture('host-full')), ok(stray), ok(readFixture('host-quiet'))])
    await feed.refresh()
    expect(agents((await feed.refresh()).roster)).toEqual(['1:1', '1:2', '9:cleanup'])
    await feed.refresh()
    expect(held().at(-1)).toEqual({ [T]: 'etag-tab1-a', [T9]: 'etag-tab9-a' })
  })

  it('tells the person to update Harness when the server answers in a format it cannot read', async () => {
    const { feed } = feedOf([ok({ ...readFixture<Json>('host-full'), format: 3 })])
    await expect(feed.refresh()).rejects.toMatchObject({ code: 'UPDATE_REQUIRED', status: 426 })
  })
})
