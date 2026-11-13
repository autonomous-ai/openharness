import { getEventListeners } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RETRY_MS, removeSwarmData, removeSwarmDataUntilClean, sleeper } from './swarmDataRemoval.js'
import type { FileStore } from './swarmFiles.js'

type Share = { _id: string; superTabId?: string | null }
/** The commands the removal sends, on collections of ids and on the shares. */
class Database {
  readonly collections = new Map<string, string[]>()
  shares: Share[] = []
  failShares = false
  async $runCommandRaw(command: Record<string, unknown>): Promise<unknown> {
    if ('listCollections' in command) {
      const named = (command.filter as { name: { $in: string[] } }).name.$in
      return { cursor: { firstBatch: [...this.collections.keys()].filter(name => named.includes(name)).map(name => ({ name })) } }
    }
    if ('count' in command) return { n: this.collections.get(command.count as string)?.length ?? 0 }
    if ('drop' in command) { this.collections.delete(command.drop as string); return { ok: 1 } }
    if (command.find === 'harness_shares') {
      if (this.failShares) throw Object.assign(new Error('the database is busy'), { code: 'P2010' })
      const swarm = this.shares.filter(share => typeof share.superTabId === 'string')
      return { cursor: { firstBatch: swarm.slice(0, command.limit as number).map(({ _id }) => ({ _id })) } }
    }
    if (command.delete === 'harness_shares') {
      const q = (command.deletes as Array<{ q: { _id: { $in: string[] }; superTabId: unknown } }>)[0]!.q
      const before = this.shares.length
      this.shares = this.shares.filter(share => !(q._id.$in.includes(share._id) && typeof share.superTabId === 'string'))
      return { n: before - this.shares.length, ok: 1 }
    }
    throw new Error(`unexpected command ${JSON.stringify(command)}`)
  }
}
class Bucket implements FileStore {
  readonly names = new Set<string>()
  constructor(...names: string[]) { for (const name of names) this.names.add(name) }
  async list(prefix: string, max: number) { return [...this.names].filter(name => name.startsWith(prefix)).sort().slice(0, max) }
  async delete(name: string) { this.names.delete(name) }
}
const asDb = (database: Database) => database as unknown as Parameters<typeof removeSwarmData>[0]
const settings = { SUPER_TAB_ATTACHMENTS_BUCKET: 'files', SUPER_TAB_ATTACHMENTS_CREDENTIALS: '', SUPER_TAB_ATTACHMENTS_PREFIX: 'super-tabs', SUPER_TAB_AVATARS_BUCKET: '' }

/** What production holds of the Swarm, beside what it must keep. */
function production() {
  const database = new Database()
  database.collections.set('SuperTab', ['t1']).set('SwarmGroup', ['g1', 'g2']).set('SuperTabMessage', ['m1']).set('machines', ['m'])
  database.shares = [{ _id: 'swarm-1', superTabId: 'a'.repeat(24) }, { _id: 'ordinary', superTabId: null }, { _id: 'older' }]
  const bucket = new Bucket('super-tabs/t1/x/notes.txt', 'super-tabs/t1/x/notes.txt.thumb.webp', 'avatars/t1/a.png', 'harness/cli/metadata.json')
  return { database, bucket }
}

describe('removing the Swarm\'s data', () => {
  it('removes its files, its shares and its collections, and keeps everything else', async () => {
    const { database, bucket } = production()
    const pass = await removeSwarmData(asDb(database), settings, () => bucket)
    expect(pass).toMatchObject({ files: { objects: 3, failed: 0, done: true }, shares: 1, collectionsFailed: [], failed: {}, clean: false })
    expect(pass.collections.map(c => [c.collection, c.rows]).sort()).toEqual([['SuperTab', 1], ['SuperTabMessage', 1], ['SwarmGroup', 2]])
    expect([...bucket.names]).toEqual(['harness/cli/metadata.json'])
    expect(database.shares.map(s => s._id)).toEqual(['ordinary', 'older'])
    expect([...database.collections.keys()]).toEqual(['machines'])
    // Counts and names only.
    expect(JSON.stringify(pass)).not.toMatch(/notes|swarm-1|aaaa/)
  })

  it('finds a pass clean once nothing is left anywhere', async () => {
    const { database, bucket } = production()
    await removeSwarmData(asDb(database), settings, () => bucket)
    expect(await removeSwarmData(asDb(database), settings, () => bucket)).toMatchObject({ clean: true, shares: 0, collections: [], failed: {} })
  })

  it('goes on with the rest when one part fails, names the part by its code, and is not clean', async () => {
    const { database, bucket } = production()
    database.failShares = true
    const pass = await removeSwarmData(asDb(database), settings, () => { throw Object.assign(new Error('no credentials'), { code: 'BAD_CREDENTIALS' }) })
    expect(pass).toMatchObject({ files: null, shares: null, failed: { files: 'BAD_CREDENTIALS', shares: 'P2010' }, clean: false })
    expect([...database.collections.keys()]).toEqual(['machines'])
    expect(bucket.names.size).toBe(4)
  })

  it('refuses a chat folder that would be the whole bucket, and leaves its files', async () => {
    const { database, bucket } = production()
    const pass = await removeSwarmData(asDb(database), { ...settings, SUPER_TAB_ATTACHMENTS_PREFIX: '' }, () => bucket)
    expect(pass.failed).toEqual({ files: 'EMPTY_PREFIX' })
    expect(bucket.names.size).toBe(4)
  })

  it('has no files to remove where no bucket was ever set', async () => {
    const { database } = production()
    const pass = await removeSwarmData(asDb(database), { ...settings, SUPER_TAB_ATTACHMENTS_BUCKET: '' }, () => { throw new Error('no store is made') })
    expect(pass.files).toEqual({ objects: 0, failed: 0, done: true })
    expect((await removeSwarmData(asDb(database), { ...settings, SUPER_TAB_ATTACHMENTS_BUCKET: '' }, () => { throw new Error('no store is made') })).clean).toBe(true)
  })
})

describe('the job', () => {
  it('passes again an hour after a pass that removed something or failed, says what is left, and stops once a pass is clean', async () => {
    const { database, bucket } = production()
    database.failShares = true
    const waits: number[] = [], lines: Array<[string, string, Record<string, unknown>]> = []
    const done = removeSwarmDataUntilClean(asDb(database), settings, () => bucket, {
      wait: async ms => { waits.push(ms); database.failShares = false },
      log: (level, message, line) => lines.push([level, message, line]) })
    expect((await done)?.clean).toBe(true)
    // Failed (shares), then removed the shares, then clean.
    expect(waits).toEqual([RETRY_MS, RETRY_MS])
    expect(lines.map(([level, message]) => [level, message])).toEqual([
      ['error', '[swarm-removal] some of the Swarm\'s data could not be removed yet; it stays until a pass succeeds'],
      ['info', '[swarm-removal] pass'], ['info', '[swarm-removal] done: nothing of the Swarm is left']])
    expect(lines[0]![2]).toMatchObject({ failed: { shares: 'P2010' }, retryInMs: RETRY_MS })
  })

  it('stops between passes when asked, without a word', async () => {
    const { database, bucket } = production()
    const control = new AbortController()
    const log = vi.fn()
    await removeSwarmDataUntilClean(asDb(database), settings, () => bucket, { signal: control.signal, wait: async () => control.abort(), log })
    expect(log).toHaveBeenCalledTimes(1)
    expect(log.mock.calls[0]![1]).toBe('[swarm-removal] pass')
  })
})

describe('the wait between passes', () => {
  afterEach(() => vi.useRealTimers())

  it('leaves no stop listener behind once its time is up, and ends at once when stopped', async () => {
    vi.useFakeTimers()
    const control = new AbortController()
    const wait = sleeper(control.signal)
    const first = wait(500)
    await vi.advanceTimersByTimeAsync(500)
    await first
    expect(getEventListeners(control.signal, 'abort')).toHaveLength(0)
    const second = wait(RETRY_MS)
    control.abort()
    await second
    expect(getEventListeners(control.signal, 'abort')).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})
