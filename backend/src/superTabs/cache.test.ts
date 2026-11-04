import { afterEach, describe, expect, it, vi } from 'vitest'
import { configureSwarmStamps, freeze, noteChange, readStamps, sizeOf, stampOwed, swarmTransaction, SwarmCache } from './cache.js'
import { MemoryStamps } from './cache.test-support.js'
import { machineFeedRule, machinesRule, type PatchRule } from './cachePatch.js'
import { logger } from '../utils/logger.js'
import type { MachineData, Part, PartKind } from './parts/index.js'
import type { SwarmDelta } from './parts/load.js'

/** A loader that counts its calls and returns a fresh object each time, numbered. */
function counted<T extends object>(make: (n: number) => T) {
  const loader = async () => make(++loader.calls)
  loader.calls = 0
  return loader
}

describe('freeze', () => {
  it('freezes every nested object and tells the same size as before', () => {
    const inner = { b: 'x' }, list = [inner, new Date(0)], value = { a: list, c: 1 }
    // 60: the JSON estimate the walk gave before it remembered sizes.
    expect(freeze(value)).toBe(60)
    expect([value, list, inner].every(o => Object.isFrozen(o))).toBe(true)
  })

  it('a second freeze visits no child', () => {
    const value = { a: [{ b: 'x' }], c: { d: [1, 2] } }
    const size = freeze(value)
    const entries = vi.spyOn(Object, 'entries')
    try {
      expect(freeze(value)).toBe(size)
      expect(entries).not.toHaveBeenCalled()
    } finally { entries.mockRestore() }
  })

  it('sizeOf reads a frozen value without walking it', () => {
    const value = { a: [{ b: 'x' }] }
    const size = freeze(value)
    const entries = vi.spyOn(Object, 'entries')
    try {
      expect(sizeOf(value)).toBe(size)
      expect(entries).not.toHaveBeenCalled()
    } finally { entries.mockRestore() }
    expect(sizeOf('ab')).toBe(4)
  })
})

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

describe('a stale entry is patched, not loaded again (spec 2026-11-02, Phase 1)', () => {
  interface Held { keys: string[] }
  const part = (key: string, version = 1, kind: PartKind = 'group'): Part => ({ kind, key, version, changedAt: version, ordinal: 1, data: {} })
  /** Appends each changed key; a part keyed 'reload' asks for a reload. */
  const rule = (kinds: readonly PartKind[] = ['group']): PatchRule<Held> => ({
    kinds,
    apply: (held, delta) => delta.parts.some(p => p.key === 'reload') ? 'reload'
      : delta.parts.length ? { keys: [...held.keys, ...delta.parts.map(p => p.key)] } : held,
  })
  function setup(options: { parts?: Part[]; fail?: boolean; delta?: boolean } = {}) {
    let now = 1_000_000
    const stamps = new MemoryStamps()
    const delta = vi.fn(async (_tabId: string, _since: number, _kinds: readonly PartKind[]): Promise<SwarmDelta> => {
      if (options.fail) throw new Error('mongo down')
      return { parts: options.parts ?? [part('g2')], head: null }
    })
    const cache = new SwarmCache(stamps, { now: () => now, ...(options.delta === false ? {} : { delta }) })
    const load = vi.fn(async (): Promise<Held> => ({ keys: ['g1'] }))
    // `null`: no rule (a default parameter would replace `undefined`).
    const read = async (patch: PatchRule<Held> | null = rule(), scope: 'main' | 'all' = 'main', name = 'base') =>
      (await cache.at(['t1'])).get('t1', name, scope, load, patch ?? undefined)
    return { stamps, cache, delta, load, read, advance: (ms: number) => { now += ms } }
  }

  it('a bump patches a held entry instead of loading it', async () => {
    const { stamps, delta, load, read } = setup()
    await read()
    await stamps.bump('t1', ['main'])
    expect(await read()).toEqual({ keys: ['g1', 'g2'] })
    expect(load).toHaveBeenCalledTimes(1)
    expect(delta).toHaveBeenCalledTimes(1)
    // Patched at the new stamp, it is a hit until the next bump.
    expect(await read()).toEqual({ keys: ['g1', 'g2'] })
    expect(delta).toHaveBeenCalledTimes(1)
  })

  it('asks for the changes since the entry was read, less the overlap', async () => {
    const { stamps, delta, read, advance } = setup()
    await read()
    advance(5_000)
    await stamps.bump('t1', ['main'])
    await read()
    expect(delta.mock.calls[0]![1]).toBe(1_000_000 - 30_000)
    expect(delta.mock.calls[0]![2]).toEqual(['group'])
  })

  it('one delta per Swarm and stamp, over the kinds its stale entries need', async () => {
    const { stamps, delta, read, advance } = setup({ parts: [part('g2')] })
    await read(rule(['group']), 'main', 'base')
    await read(rule(['machine']), 'all', 'machines')
    advance(1)
    await stamps.bump('t1', ['main'])
    await read(rule(['group']), 'main', 'base')
    await read(rule(['machine']), 'all', 'machines')
    expect(delta).toHaveBeenCalledTimes(1)
    expect([...delta.mock.calls[0]![2]].sort()).toEqual(['group', 'machine'])
  })

  describe('a same-stamp refresh never reuses a delta older than what it refreshes (review of #2519)', () => {
    it('a change whose bump was lost is read at the next 60 s refresh, not left to the 120 s gap reload', async () => {
      const changes = { parts: [] as Part[] }
      const { delta, load, read, advance } = setup(changes)
      await read(rule(), 'main', 'a')
      await read(rule(), 'main', 'b')
      advance(61_000)
      await read(rule(), 'main', 'a')
      await read(rule(), 'main', 'b')
      expect(delta).toHaveBeenCalledTimes(1)
      // Committed, and no pod ever heard: the stamps stand still.
      changes.parts = [part('lost')]
      advance(61_000)
      expect(await read(rule(), 'main', 'a')).toEqual({ keys: ['g1', 'lost'] })
      expect(await read(rule(), 'main', 'b')).toEqual({ keys: ['g1', 'lost'] })
      expect(delta).toHaveBeenCalledTimes(2)
      expect(load).toHaveBeenCalledTimes(2)
    })

    it('a machine removed before an entry loaded does not come back from an older delta', async () => {
      const machine = (version: number, deleted = false): Part<MachineData> =>
        ({ kind: 'machine', key: 'm1', version, changedAt: version, ordinal: 1, data: {} as MachineData, ...(deleted ? { deleted: true } : {}) })
      let now = 1_000_000, changed: Part[] = [machine(2)], stored: Part<MachineData>[] = [machine(1)]
      const cache = new SwarmCache(new MemoryStamps(), { now: () => now, delta: async () => ({ parts: changed, head: null }) })
      const read = async (name: string) => (await cache.at(['t1'])).get('t1', name, 'all', async () => stored, machinesRule)
      await read('a')
      // A second entry of the Swarm: with one, replacing it forgets the delta and hides this.
      await read('other')
      now += 61_000
      // The delta 'a' refreshes from holds the machine, live.
      expect((await read('a')).map(p => p.key)).toEqual(['m1'])
      // Then it is removed, its bump lost, and 'b' loads correctly without it.
      changed = [machine(3, true)]
      stored = []
      now += 1
      expect(await read('b')).toEqual([])
      now += 60_000
      expect(await read('b')).toEqual([])
    })

    it('a member removed before an entry loaded does not come back from an older delta', async () => {
      const changes = { parts: [part('removed-member')] }
      const { read, advance, load } = setup(changes)
      await read(rule(), 'main', 'a')
      await read(rule(), 'main', 'other')
      advance(61_000)
      await read(rule(), 'main', 'a')
      changes.parts = []
      advance(1)
      load.mockResolvedValueOnce({ keys: ['correct'] })
      expect(await read(rule(), 'main', 'b')).toEqual({ keys: ['correct'] })
      advance(60_000)
      expect(await read(rule(), 'main', 'b')).toEqual({ keys: ['correct'] })
    })

    it('the writing pod reads its own commit while its bump is owed, on every entry', async () => {
      const changes = { parts: [] as Part[] }
      const { cache, delta, read, advance } = setup(changes)
      await read(rule(), 'main', 'a')
      await read(rule(), 'main', 'b')
      advance(61_000)
      // 'a' refreshes from a delta; 'b', not read since, is still older than that delta.
      await read(rule(), 'main', 'a')
      expect(delta).toHaveBeenCalledTimes(1)
      advance(1_000)
      // A commit here that Redis would not take: announce() drops the Swarm, and the stamps stand still.
      changes.parts = [part('mine')]
      cache.drop('t1')
      expect(await read(rule(), 'main', 'b')).toEqual({ keys: ['g1', 'mine'] })
      expect(await read(rule(), 'main', 'a')).toEqual({ keys: ['g1', 'mine'] })
    })

    it('entries refreshed together still share one delta', async () => {
      const { delta, load, read, advance } = setup({ parts: [] })
      await read(rule(), 'main', 'a')
      await read(rule(), 'main', 'b')
      advance(61_000)
      await read(rule(), 'main', 'a')
      await read(rule(), 'main', 'b')
      expect(delta).toHaveBeenCalledTimes(1)
      expect(load).toHaveBeenCalledTimes(2)
    })
  })

  it('an entry not read for two minutes loads in full, and never stretches another entry\'s delta', async () => {
    const { stamps, delta, load, read, advance } = setup()
    await read(rule(), 'main', 'old')
    advance(150_000)
    await read(rule(), 'main', 'hot')
    await stamps.bump('t1', ['main'])
    await read(rule(), 'main', 'hot')
    expect(delta.mock.calls[0]![1]).toBe(1_000_000 + 150_000 - 30_000)
    await read(rule(), 'main', 'old')
    // old: loaded, hot: loaded, old: loaded again (too old to patch).
    expect(load).toHaveBeenCalledTimes(3)
  })

  it('readers of one Swarm at one stamp share one delta', async () => {
    const { stamps, delta, read } = setup()
    await read()
    await stamps.bump('t1', ['main'])
    await Promise.all([read(), read(), read()])
    expect(delta).toHaveBeenCalledTimes(1)
  })

  it('a machine-only bump leaves main entries alone and asks the delta for machines only', async () => {
    const { stamps, delta, read } = setup({ parts: [part('m1', 2, 'machine')] })
    await read(rule(['group']), 'main', 'base')
    await read(rule(['machine']), 'all', 'machines')
    await stamps.bump('t1', ['machine'])
    await read(rule(['group']), 'main', 'base')
    expect(delta).not.toHaveBeenCalled()
    expect(await read(rule(['machine']), 'all', 'machines')).toEqual({ keys: ['g1', 'm1'] })
    expect(delta.mock.calls.map(c => c[2])).toEqual([['machine']])
  })

  it('age patch without a bump: past 60 s an entry reads the changes it may have missed', async () => {
    const { delta, load, read, advance } = setup()
    await read()
    advance(61_000)
    expect(await read()).toEqual({ keys: ['g1', 'g2'] })
    expect(load).toHaveBeenCalledTimes(1)
    expect(delta).toHaveBeenCalledTimes(1)
  })

  it('past DELTA_MAX_AGE_MS it loads in full', async () => {
    const { stamps, delta, load, read, advance } = setup()
    await read()
    advance(600_001)
    await stamps.bump('t1', ['main'])
    expect(await read()).toEqual({ keys: ['g1'] })
    expect(load).toHaveBeenCalledTimes(2)
    expect(delta).not.toHaveBeenCalled()
  })

  it('over DELTA_MAX_PARTS it loads in full', async () => {
    const { stamps, load, read } = setup({ parts: Array.from({ length: 501 }, (_, i) => part(`g${i + 10}`)) })
    await read()
    await stamps.bump('t1', ['main'])
    expect(await read()).toEqual({ keys: ['g1'] })
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('a delta error loads in full', async () => {
    const { stamps, load, read } = setup({ fail: true })
    await read()
    await stamps.bump('t1', ['main'])
    expect(await read()).toEqual({ keys: ['g1'] })
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('reload from the rule loads in full', async () => {
    const { stamps, load, read } = setup({ parts: [part('reload')] })
    await read()
    await stamps.bump('t1', ['main'])
    expect(await read()).toEqual({ keys: ['g1'] })
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('entries without a rule are dropped and loaded as before', async () => {
    const { stamps, delta, load, read } = setup()
    await read(null)
    await stamps.bump('t1', ['main'])
    await read(null)
    expect(load).toHaveBeenCalledTimes(2)
    expect(delta).not.toHaveBeenCalled()
  })

  it('without delta configured the cache loads in full as before', async () => {
    const { stamps, load, read } = setup({ delta: false })
    await read()
    await stamps.bump('t1', ['main'])
    await read()
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('a patched value is frozen', async () => {
    const { stamps, read } = setup()
    await read()
    await stamps.bump('t1', ['main'])
    const value = await read()
    expect(Object.isFrozen(value)).toBe(true)
    expect(Object.isFrozen(value.keys)).toBe(true)
  })

  it('stale entries are evicted first', async () => {
    const stamps = new MemoryStamps()
    // Each value is 19 bytes as JSON: two fit, three do not.
    const cache = new SwarmCache(stamps, { maxBytes: 40, delta: async () => ({ parts: [], head: null }) })
    const get = async (tabId: string) => (await cache.at([tabId])).get(tabId, 'base', 'main', async () => ({ keys: ['x'.repeat(4)] }), rule())
    await get('old')
    await get('fresh')
    // 'old' is now the most recently used, so plain LRU would evict 'fresh'; once stale, 'old' goes first.
    await get('old')
    await stamps.bump('old', ['main'])
    await get('third')
    expect(cache.size.entries).toBe(2)
    const loads = vi.fn(async () => ({ keys: ['y'] }))
    await (await cache.at(['fresh'])).get('fresh', 'base', 'main', loads, rule())
    expect(loads).not.toHaveBeenCalled()
  })
})

describe('the verify sample (spec 2026-11-02, "Checking it on prod")', () => {
  const machine = (key: string, version: number, data: unknown): Part => ({ kind: 'machine', key, version, changedAt: version, ordinal: 1, data })
  function setup(changed: Part[], truth: () => Part[]) {
    const stamps = new MemoryStamps()
    const cache = new SwarmCache(stamps, { verifyRate: 1, random: () => 0, delta: async () => ({ parts: changed, head: null }) })
    const load = vi.fn(async () => truth())
    const read = async () => (await cache.at(['t1'])).get('t1', 'machines', 'all', load, machinesRule)
    return { stamps, cache, load, read }
  }

  it('a sampled patch is checked against a full load', async () => {
    let truth = [machine('m1', 1, { a: 1 })]
    const { stamps, load, read } = setup([machine('m1', 2, { a: 2 })], () => truth)
    await read()
    truth = [machine('m1', 2, { a: 2 })]
    await stamps.bump('t1', ['machine'])
    const warn = vi.spyOn(logger, 'warn')
    try {
      await read()
      await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2))
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(warn).not.toHaveBeenCalled()
    } finally { warn.mockRestore() }
  })

  it('a mismatch drops the entry and logs ids only', async () => {
    let truth = [machine('m1', 1, { secret: 'stored' })]
    const { stamps, load, read } = setup([machine('m1', 2, { secret: 'patched' })], () => truth)
    await read()
    truth = [machine('m1', 2, { secret: 'stored' })]
    await stamps.bump('t1', ['machine'])
    const warn = vi.spyOn(logger, 'warn')
    try {
      await read()
      await vi.waitFor(() => expect(warn).toHaveBeenCalledWith('swarm cache verify mismatch', { entry: 'machines', tabId: 't1', kinds: ['machine'], keys: ['machine:m1'] }))
      expect(JSON.stringify(warn.mock.calls)).not.toContain('secret')
      // Dropped: the next read loads again.
      await read()
      expect(load).toHaveBeenCalledTimes(3)
    } finally { warn.mockRestore() }
  })

  it('a stamp move during the check counts nothing', async () => {
    let truth = [machine('m1', 1, { a: 1 })]
    const stamps = new MemoryStamps()
    const cache = new SwarmCache(stamps, { verifyRate: 1, random: () => 0, delta: async () => ({ parts: [machine('m1', 2, { a: 2 })], head: null }) })
    let calls = 0
    const load = async () => { calls++; if (calls === 2) await stamps.bump('t1', ['machine']); return truth }
    const read = async () => (await cache.at(['t1'])).get('t1', 'machines', 'all', load, machinesRule)
    await read()
    truth = [machine('m1', 9, { other: true })]
    await stamps.bump('t1', ['machine'])
    const warn = vi.spyOn(logger, 'warn')
    try {
      await read()
      await vi.waitFor(() => expect(calls).toBe(2))
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(warn).not.toHaveBeenCalled()
    } finally { warn.mockRestore() }
  })

  // Final review, Important 2: a feed loaded for another reader starts at another `from`; only what both cover compares.
  it('a feed loaded from another starting point is not a mismatch', async () => {
    const stamps = new MemoryStamps()
    const cache = new SwarmCache(stamps, { verifyRate: 1, random: () => 0, delta: async () => ({ parts: [machine('m1', 2, { a: 2 })], head: null }) })
    let from = 100
    const load = vi.fn(async () => ({ from: from += 50, parts: [machine('m1', from > 200 ? 2 : 1, { a: from > 200 ? 2 : 1 })] }))
    const read = async () => (await cache.at(['t1'])).get('t1', 'feed:machines', 'all', load, machineFeedRule)
    await read()
    await stamps.bump('t1', ['machine'])
    from = 200
    const warn = vi.spyOn(logger, 'warn')
    try {
      await read()
      await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2))
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(warn).not.toHaveBeenCalled()
    } finally { warn.mockRestore() }
  })

  it('one check at a time per process', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>(resolve => { release = resolve })
    const stamps = new MemoryStamps()
    const cache = new SwarmCache(stamps, { verifyRate: 1, random: () => 0, delta: async () => ({ parts: [], head: null }) })
    let loads = 0
    const load = async () => { loads++; if (loads > 2) await gate; return [] as Part[] }
    const read = async (tabId: string) => (await cache.at([tabId])).get(tabId, 'machines', 'all', load, machinesRule)
    await read('t1'); await read('t2')
    await stamps.bump('t1', ['machine']); await stamps.bump('t2', ['machine'])
    await read('t1'); await read('t2')
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(loads).toBe(3)
    release()
  })
})
