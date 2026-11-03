import { afterEach, describe, expect, it, vi } from 'vitest'
import { configureSwarmStamps, noteChange, readStamps, stampOwed, swarmTransaction, SwarmCache } from './cache.js'
import { MemoryStamps } from './cache.test-support.js'

/** A loader that counts its calls and returns a fresh object each time, numbered. */
function counted<T extends object>(make: (n: number) => T) {
  const loader = async () => make(++loader.calls)
  loader.calls = 0
  return loader
}

describe('SwarmCache', () => {
  it('answers a read at an unchanged stamp from memory', async () => {
    const cache = new SwarmCache(new MemoryStamps())
    const load = counted(n => ({ n }))
    expect(await (await cache.at(['t1'])).get('t1', 'base', 'main', load)).toEqual({ n: 1 })
    expect(await (await cache.at(['t1'])).get('t1', 'base', 'main', load)).toEqual({ n: 1 })
    expect(load.calls).toBe(1)
  })

  it('loads again once the Swarm was bumped, and keeps other Swarms', async () => {
    const stamps = new MemoryStamps(), cache = new SwarmCache(stamps)
    const one = counted(n => ({ n })), two = counted(n => ({ n }))
    await (await cache.at(['t1'])).get('t1', 'base', 'main', one)
    await (await cache.at(['t2'])).get('t2', 'base', 'main', two)
    await stamps.bump('t1', ['main'])
    expect(await (await cache.at(['t1'])).get('t1', 'base', 'main', one)).toEqual({ n: 2 })
    expect(await (await cache.at(['t2'])).get('t2', 'base', 'main', two)).toEqual({ n: 1 })
  })

  it('keeps a load under the stamp read before it, so a bump during the load is not missed', async () => {
    const stamps = new MemoryStamps(), cache = new SwarmCache(stamps)
    let calls = 0
    const load = async () => { calls++; if (calls === 1) await stamps.bump('t1', ['main']); return { calls } }
    await (await cache.at(['t1'])).get('t1', 'base', 'main', load)
    expect(await (await cache.at(['t1'])).get('t1', 'base', 'main', load)).toEqual({ calls: 2 })
  })

  it('reads the Swarm directly, and keeps nothing, while the stamps cannot be read', async () => {
    const stamps = new MemoryStamps(), cache = new SwarmCache(stamps)
    const load = counted(n => ({ n }))
    stamps.down = true
    const view = await cache.at(['t1'])
    expect(view.available).toBe(false)
    expect(await view.get('t1', 'base', 'main', load)).toEqual({ n: 1 })
    expect(await (await cache.at(['t1'])).get('t1', 'base', 'main', load)).toEqual({ n: 2 })
    expect(cache.size).toEqual({ entries: 0, bytes: 0 })
    stamps.down = false
    expect(await (await cache.at(['t1'])).get('t1', 'base', 'main', load)).toEqual({ n: 3 })
    expect(await (await cache.at(['t1'])).get('t1', 'base', 'main', load)).toEqual({ n: 3 })
  })

  it('reads directly when the stamps answer too late', async () => {
    const stamps = new MemoryStamps(), cache = new SwarmCache(stamps, { stampTimeoutMs: 20 })
    stamps.slowMs = 200
    expect((await cache.at(['t1'])).available).toBe(false)
  })

  it('keeps a main-scoped entry over a machine report, and reloads one that covers machines', async () => {
    const stamps = new MemoryStamps(), cache = new SwarmCache(stamps)
    const main = counted(n => ({ n })), all = counted(n => ({ n }))
    const read = async () => { const view = await cache.at(['t1']); return [await view.get('t1', 'head', 'main', main), await view.get('t1', 'machines', 'all', all)] }
    await read()
    await stamps.bump('t1', ['machine'])
    expect(await read()).toEqual([{ n: 1 }, { n: 2 }])
    await stamps.bump('t1', ['main'])
    expect(await read()).toEqual([{ n: 2 }, { n: 3 }])
  })

  it('forgets an entry older than its maximum age, whatever the stamp', async () => {
    let now = 1_000
    const cache = new SwarmCache(new MemoryStamps(), { maxAgeMs: 60_000, now: () => now })
    const load = counted(n => ({ n }))
    await (await cache.at(['t1'])).get('t1', 'base', 'main', load)
    now += 59_999
    expect(await (await cache.at(['t1'])).get('t1', 'base', 'main', load)).toEqual({ n: 1 })
    now += 1
    expect(await (await cache.at(['t1'])).get('t1', 'base', 'main', load)).toEqual({ n: 2 })
  })

  it('stays within its byte budget by dropping the least recently used entry', async () => {
    // Each value is about 1 KB as JSON.
    const cache = new SwarmCache(new MemoryStamps(), { maxBytes: 2_500 })
    const value = (n: number) => ({ text: 'x'.repeat(1_000), n })
    const loads = { a: counted(value), b: counted(value), c: counted(value) }
    const get = async (tab: 'a' | 'b' | 'c') => (await cache.at([tab])).get(tab, 'base', 'main', loads[tab])
    await get('a'); await get('b'); await get('a'); await get('c')
    expect(cache.size.entries).toBe(2)
    expect(cache.size.bytes).toBeLessThanOrEqual(2_500)
    await get('a'); await get('c'); await get('b')
    expect([loads.a.calls, loads.b.calls, loads.c.calls]).toEqual([1, 2, 1])
  })

  it('keeps nothing larger than its whole budget', async () => {
    const cache = new SwarmCache(new MemoryStamps(), { maxBytes: 100 })
    await (await cache.at(['t1'])).get('t1', 'base', 'main', async () => ({ text: 'x'.repeat(1_000) }))
    expect(cache.size).toEqual({ entries: 0, bytes: 0 })
  })

  it('hands every reader the same frozen value, so no reader can change what another reads', async () => {
    const cache = new SwarmCache(new MemoryStamps())
    const load = async () => ({ people: [{ id: 'p1', role: 'member' }] })
    const first = await (await cache.at(['t1'])).get('t1', 'base', 'main', load)
    expect(() => { (first.people[0] as { role: string }).role = 'owner' }).toThrow(TypeError)
    expect(() => { first.people.push({ id: 'p2', role: 'owner' }) }).toThrow(TypeError)
    expect(await (await cache.at(['t1'])).get('t1', 'base', 'main', load)).toEqual({ people: [{ id: 'p1', role: 'member' }] })
  })

  it('loads once for readers that miss together', async () => {
    const cache = new SwarmCache(new MemoryStamps())
    let calls = 0
    const load = async () => { calls++; await new Promise(resolve => setTimeout(resolve, 10)); return { calls } }
    const views = await Promise.all([cache.at(['t1']), cache.at(['t1'])])
    expect(await Promise.all(views.map(view => view.get('t1', 'base', 'main', load)))).toEqual([{ calls: 1 }, { calls: 1 }])
  })

  it('frees what it holds of a Swarm when any pod bumps it', async () => {
    const stamps = new MemoryStamps(), cache = new SwarmCache(stamps)
    await (await cache.at(['t1'])).get('t1', 'base', 'main', async () => ({ text: 'x'.repeat(100) }))
    expect(cache.size.entries).toBe(1)
    await stamps.bump('t1', ['main'])
    expect(cache.size).toEqual({ entries: 0, bytes: 0 })
  })

  it('drops only the bumped Swarm\'s entries, keeping counts right through drops, evictions and expiry', async () => {
    let now = 1_000
    const stamps = new MemoryStamps(), cache = new SwarmCache(stamps, { maxBytes: 10_000, maxAgeMs: 60_000, now: () => now })
    const loads = new Map<string, number>()
    // Loads of each entry so far. A 1 KB value is 1,012 bytes as the cache counts it, 'big' 8,012.
    const get = async (tab: string, name: string, scope: 'main' | 'all' = 'main') => {
      await (await cache.at([tab])).get(tab, name, scope, async () => {
        loads.set(`${tab}/${name}`, (loads.get(`${tab}/${name}`) ?? 0) + 1)
        return { text: 'x'.repeat(name === 'big' ? 8_000 : 1_000) }
      })
      return loads.get(`${tab}/${name}`)
    }
    for (const tab of ['a', 'b']) { await get(tab, 'one'); await get(tab, 'two'); await get(tab, 'machines', 'all') }
    expect(cache.size).toEqual({ entries: 6, bytes: 6 * 1_012 })

    await stamps.bump('a', ['main'])
    expect(cache.size).toEqual({ entries: 3, bytes: 3 * 1_012 })
    expect([await get('b', 'one'), await get('b', 'two'), await get('b', 'machines', 'all')]).toEqual([1, 1, 1])

    // A machine's reading keeps b's main-scoped entries.
    await stamps.bump('b', ['machine'])
    expect(cache.size).toEqual({ entries: 2, bytes: 2 * 1_012 })

    // Over the budget: b's least recently used entry goes, the other stays held.
    await get('c', 'big')
    expect(cache.size).toEqual({ entries: 2, bytes: 1_012 + 8_012 })
    expect(await get('b', 'two')).toBe(1)
    // So does a machine's reading after the eviction.
    await stamps.bump('b', ['machine'])
    expect(cache.size).toEqual({ entries: 2, bytes: 1_012 + 8_012 })

    // Past the maximum age: a read forgets the entry and loads it again.
    now += 60_000
    expect(await get('b', 'two')).toBe(2)
    expect(cache.size).toEqual({ entries: 2, bytes: 1_012 + 8_012 })

    // Whatever was evicted or expired before, a bump drops exactly the Swarm's entries still held.
    await stamps.bump('b', ['main'])
    expect(cache.size).toEqual({ entries: 1, bytes: 8_012 })
    await stamps.bump('a', ['main'])
    expect(cache.size).toEqual({ entries: 1, bytes: 8_012 })
    await stamps.bump('c', ['main'])
    expect(cache.size).toEqual({ entries: 0, bytes: 0 })
    expect(await get('b', 'one')).toBe(2)
    expect(cache.size).toEqual({ entries: 1, bytes: 1_012 })
  })

  it('reads the stamps of several Swarms at once', async () => {
    const stamps = new MemoryStamps(), cache = new SwarmCache(stamps)
    const one = counted(n => ({ n })), two = counted(n => ({ n }))
    let view = await cache.at(['t1', 't2'])
    await view.get('t1', 'inputs', 'main', one); await view.get('t2', 'inputs', 'main', two)
    await stamps.bump('t2', ['main'])
    view = await cache.at(['t1', 't2'])
    expect([await view.get('t1', 'inputs', 'main', one), await view.get('t2', 'inputs', 'main', two)]).toEqual([{ n: 1 }, { n: 2 }])
  })

  it('reads directly for a Swarm the view did not read the stamp of', async () => {
    const cache = new SwarmCache(new MemoryStamps())
    const load = counted(n => ({ n }))
    const view = await cache.at(['t1'])
    await view.get('t2', 'base', 'main', load); await view.get('t2', 'base', 'main', load)
    expect(load.calls).toBe(2)
  })
})

describe('the stamps a machine report reads (DB 2.5)', () => {
  afterEach(() => configureSwarmStamps(null))
  /** A database whose transaction runs its body on a client the cache records changes against. */
  const db = { $transaction: async <T>(body: (tx: object) => Promise<T>) => body({}) }

  it('reads them, or none without stamps, while they fail, or late', async () => {
    expect(await readStamps(['t1'])).toBeNull()
    const stamps = new MemoryStamps()
    configureSwarmStamps(stamps)
    await stamps.bump('t1', ['main'])
    expect((await readStamps(['t1']))?.get('t1')).toEqual({ main: 1, machine: 0 })
    stamps.down = true
    expect(await readStamps(['t1'])).toBeNull()
    stamps.down = false
    stamps.slowMs = 300
    expect(await readStamps(['t1'])).toBeNull()
  })

  it('knows a Swarm whose change committed here before Redis took its bump, until it is paid', async () => {
    const stamps = new MemoryStamps()
    configureSwarmStamps(stamps)
    stamps.down = true
    await swarmTransaction(db as never, async tx => noteChange(tx, 't1', 'main'))
    expect([stampOwed('t1'), stampOwed('t2')]).toEqual([true, false])
    stamps.down = false
    await vi.waitFor(() => expect(stampOwed('t1')).toBe(false), { timeout: 5_000 })
    expect(stamps.bumps).toEqual([{ tabId: 't1', scopes: ['main'] }])
  })
})
